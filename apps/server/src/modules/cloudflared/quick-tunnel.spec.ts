import { describe, expect, it } from 'vitest';
import type { CommandExecutor, ExecResult } from '../../common/executor';
import { shq } from '../../common/shell';
import {
  blankQuick,
  buildQuickInspect,
  buildQuickLaunch,
  consumeQuickLog,
  inspectQuickTunnel,
  isNamedConnectorArgs,
  matchTryCloudflareUrl,
  readQuickLog,
  startQuickTunnel,
  stopQuickTunnel,
  type QuickTarget,
} from './quick-tunnel';

class FakeExecutor implements CommandExecutor {
  readonly commands: string[] = [];
  constructor(
    readonly kind: 'local' | 'ssh',
    private readonly reply: (command: string) => Partial<ExecResult>,
  ) {}
  exec(command: string): Promise<ExecResult> {
    this.commands.push(command);
    return Promise.resolve({ code: 0, stdout: '', stderr: '', ...this.reply(command) });
  }
  writeFile(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function target(
  reply: (command: string) => Partial<ExecResult>,
  kind: 'local' | 'ssh' = 'ssh',
): {
  target: QuickTarget;
  exec: FakeExecutor;
} {
  const exec = new FakeExecutor(kind, reply);
  return { target: { exec }, exec };
}

const ORIGIN = 'http://127.0.0.1:8080/health?token=secret';
const READY_LOG = 'https://demo.trycloudflare.com\nINF Registered tunnel connection\n';

function scripted(over: { log?: string; inspect?: string; launch?: string } = {}) {
  return target((command) => {
    if (command.startsWith('printf')) return { stdout: '/home/alice' };
    if (command.includes('nohup')) return { stdout: over.launch ?? 'started\n' };
    if (command.startsWith('cat ')) return { stdout: over.log ?? READY_LOG };
    if (command.includes('echo OWNED'))
      return { stdout: over.inspect ?? 'OWNED 4242\nPIDFILE 4242\n' };
    return { stdout: '' };
  });
}

describe('quick tunnel log parsing', () => {
  it('joins a URL split across chunks and ignores lookalikes', () => {
    const first = consumeQuickLog('', 'requesting https://de');
    expect(first.url).toBeNull();
    const second = consumeQuickLog(first.pending, 'mo.trycloudflare.com\n');
    expect(second.url).toBe('https://demo.trycloudflare.com');
    expect(matchTryCloudflareUrl('http://demo.trycloudflare.com')).toBeNull();
    expect(matchTryCloudflareUrl('https://demo.trycloudflare.com.evil.com')).toBeNull();
    expect(matchTryCloudflareUrl('https://trycloudflare.com')).toBeNull();
    expect(readQuickLog('INF Registered tunnel connection').registered).toBe(true);
  });
});

describe('startQuickTunnel', () => {
  const fast = {
    deadlineMs: 1000,
    graceMs: 0,
    pollMs: 1,
    sleep: async () => undefined,
    now: () => Date.now(),
  };

  it('launches with a quoted origin and an empty config, then returns one URL', async () => {
    const { target: t, exec } = scripted();
    const runtime = await startQuickTunnel(t, 'node_1', ORIGIN, 'cloudflared', fast);
    const launch = exec.commands.find((command) => command.includes('nohup'));
    expect(launch).toContain('tunnel --no-autoupdate --config');
    expect(launch).toContain('--logfile');
    expect(launch).toContain('--pidfile');
    expect(launch).toContain('--url');
    expect(launch).toContain(shq(ORIGIN));
    expect(launch).toContain('/puente-quick/');
    expect(launch).not.toContain(' tunnel run ');
    expect(runtime).toMatchObject({
      state: 'running',
      publicUrl: 'https://demo.trycloudflare.com',
      pid: 4242,
    });
  });

  it('does not treat a URL alone as ready, and stops the process it started', async () => {
    let clock = 0;
    let killed = false;
    const exec = new FakeExecutor('ssh', (command) => {
      if (command.startsWith('printf')) return { stdout: '/home/alice' };
      if (command.includes('nohup')) return { stdout: 'started\n' };
      if (command.startsWith('cat ')) return { stdout: 'https://demo.trycloudflare.com\n' };
      if (command.includes('kill -KILL')) {
        killed = true;
        return { stdout: '' };
      }
      if (command.includes('echo OWNED')) return { stdout: killed ? 'OWNED \n' : 'OWNED 9\n' };
      return { stdout: '' };
    });
    const t = { exec };
    const runtime = await startQuickTunnel(t, 'node_1', 'http://127.0.0.1:8080', 'cloudflared', {
      deadlineMs: 1000,
      graceMs: 0,
      pollMs: 1,
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
    });
    expect(runtime.state).toBe('error');
    expect(runtime.publicUrl).toBeNull();
    expect(
      exec.commands.some((command) => /kill -TERM/.test(command) && command.includes('for p in 9')),
    ).toBe(true);
    expect(
      exec.commands.some((command) => /kill -KILL/.test(command) && command.includes('for p in 9')),
    ).toBe(true);
  });

  it('reports an early exit without killing anything else', async () => {
    const noise = 'noise-'.repeat(80);
    const { target: t, exec } = scripted({
      log: `${noise}cannot execute binary file: Exec format error ${ORIGIN}\n`,
      inspect: 'OWNED \n',
    });
    const runtime = await startQuickTunnel(t, 'node_1', ORIGIN, 'cloudflared', fast);
    expect(runtime.state).toBe('error');
    expect(runtime.publicUrl).toBeNull();
    expect(runtime.lastError).toContain('cloudflared exited before the Quick Tunnel was ready.');
    expect(runtime.lastError).toContain('Exec format error');
    expect(runtime.lastError).toContain('http://127.0.0.1:8080/health');
    expect(runtime.lastError).not.toContain('token=secret');
    expect(runtime.lastError).not.toContain(noise);
    expect(runtime.marker).toHaveLength(32);
    expect(runtime.runtimeDir).toContain('/puente-quick/');
    expect(exec.commands.some((command) => /kill -TERM|kill -KILL/.test(command))).toBe(false);
  });

  it('keeps the early-exit sentence when cloudflared left no log', async () => {
    const { target: t } = scripted({ log: '\n', inspect: 'OWNED \n' });
    const runtime = await startQuickTunnel(
      t,
      'node_1',
      'http://127.0.0.1:8080',
      'cloudflared',
      fast,
    );
    expect(runtime.lastError).toBe('cloudflared exited before the Quick Tunnel was ready.');
    expect(runtime.marker).toHaveLength(32);
    expect(runtime.runtimeDir).toContain('/puente-quick/');
  });

  it('keeps polling when the log is still requesting a quick tunnel', async () => {
    let inspects = 0;
    const { target: t } = target((command) => {
      if (command.startsWith('printf')) return { stdout: '/home/alice' };
      if (command.includes('nohup')) return { stdout: 'started\n' };
      if (command.startsWith('cat ')) {
        return {
          stdout:
            inspects === 0
              ? 'INF Requesting new quick Tunnel on trycloudflare.com\n'
              : READY_LOG,
        };
      }
      if (command.includes('echo OWNED')) {
        inspects += 1;
        return { stdout: inspects === 1 ? 'OWNED \n' : 'OWNED 4242\nPIDFILE 4242\n' };
      }
      return { stdout: '' };
    });
    const runtime = await startQuickTunnel(t, 'node_1', 'http://127.0.0.1:8080', 'cloudflared', fast);
    expect(runtime.state).toBe('running');
    expect(runtime.publicUrl).toBe('https://demo.trycloudflare.com');
    expect(runtime.lastError).toBeNull();
    expect(runtime.marker).toHaveLength(32);
  });

  it('reaches running when the owned process appears after one empty inspect', async () => {
    let inspects = 0;
    const { target: t } = target((command) => {
      if (command.startsWith('printf')) return { stdout: '/home/alice' };
      if (command.includes('nohup')) return { stdout: 'started\n' };
      if (command.startsWith('cat ')) return { stdout: READY_LOG };
      if (command.includes('echo OWNED')) {
        inspects += 1;
        return { stdout: inspects === 1 ? 'OWNED \n' : 'OWNED 4242\nPIDFILE 4242\n' };
      }
      return { stdout: '' };
    });
    const runtime = await startQuickTunnel(t, 'node_1', 'http://127.0.0.1:8080', 'cloudflared', fast);
    expect(runtime.state).toBe('running');
    expect(runtime.publicUrl).toBe('https://demo.trycloudflare.com');
    expect(runtime.pid).toBe(4242);
    expect(runtime.marker).toHaveLength(32);
  });

  it('keeps the marker when the deadline arrives before ownership is known', async () => {
    let clock = 0;
    const { target: t, exec } = scripted({ log: '\n', inspect: 'OWNED \n' });
    const runtime = await startQuickTunnel(t, 'node_1', 'http://127.0.0.1:8080', 'cloudflared', {
      deadlineMs: 1000,
      graceMs: 0,
      pollMs: 500,
      now: () => clock,
      sleep: async () => {
        clock += 1000;
      },
    });
    expect(runtime.state).toBe('unknown');
    expect(runtime.publicUrl).toBeNull();
    expect(runtime.marker).toHaveLength(32);
    expect(runtime.runtimeDir).toContain('/puente-quick/');
    expect(exec.commands.some((command) => /kill -TERM|kill -KILL/.test(command))).toBe(false);
  });

  it('keeps the marker and hides the URL when SSH drops after launch', async () => {
    const { target: t } = target((command) => {
      if (command.startsWith('printf')) return { stdout: '/home/alice' };
      if (command.includes('nohup')) return { stdout: 'started\n' };
      if (command.startsWith('cat ')) throw new Error('ssh closed');
      return { stdout: '' };
    });
    const runtime = await startQuickTunnel(
      t,
      'node_1',
      'http://127.0.0.1:8080',
      'cloudflared',
      fast,
    );
    expect(runtime.state).toBe('unknown');
    expect(runtime.publicUrl).toBeNull();
    expect(runtime.marker).toHaveLength(32);
    expect(runtime.runtimeDir).toContain('/puente-quick/');
  });
});

describe('stopQuickTunnel', () => {
  it('does not kill a live pid whose command is not ours', async () => {
    const { target: t, exec } = target(() => ({ stdout: 'OWNED \nLAUNCHER_ALIVE 99\n' }));
    const result = await stopQuickTunnel(
      t,
      blankQuick({
        marker: 'a'.repeat(32),
        runtimeDir: '/home/alice/.puente/puente-quick/node_1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        pid: 99,
      }),
      { graceMs: 0, sleep: async () => undefined },
    );
    expect(result).toBe('mismatch');
    expect(exec.commands.some((command) => /kill -TERM|kill -KILL/.test(command))).toBe(false);
    expect(isNamedConnectorArgs('cloudflared tunnel run --token x')).toBe(true);
  });

  it('stops only the owned pid', async () => {
    let armed = true;
    const { target: t, exec } = target(() => ({
      stdout: armed ? 'OWNED 4242\n' : 'OWNED \n',
    }));
    const real = t.exec.exec.bind(t.exec);
    t.exec.exec = (command: string) => {
      if (command.includes('kill -TERM')) armed = false;
      return real(command);
    };
    const result = await stopQuickTunnel(
      t,
      blankQuick({
        marker: 'b'.repeat(32),
        runtimeDir: '/home/alice/.puente/puente-quick/node_1/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        pid: 4242,
      }),
      { graceMs: 0, sleep: async () => undefined },
    );
    expect(result).toBe('stopped');
    expect(
      exec.commands.some(
        (command) =>
          command.includes('for p in 4242') &&
          command.includes('kill -TERM') &&
          command.includes('b'.repeat(32)),
      ),
    ).toBe(true);
    expect(exec.commands.some((command) => command.includes('kill -KILL'))).toBe(false);
  });
});

describe('inspectQuickTunnel', () => {
  it('adopts a live owned process and clears a dead one', async () => {
    const runtime = blankQuick({
      state: 'unknown',
      marker: 'c'.repeat(32),
      runtimeDir: '/home/alice/.puente/puente-quick/node_1/cccccccccccccccccccccccccccccccc',
      publicUrl: 'https://stale.trycloudflare.com',
    });
    const live = target((command) =>
      command.includes('cloudflared.log')
        ? { stdout: READY_LOG }
        : { stdout: 'OWNED 7\nPIDFILE 7\n' },
    );
    const adopted = await inspectQuickTunnel(live.target, runtime);
    expect(adopted.state).toBe('running');
    expect(adopted.publicUrl).toBe('https://demo.trycloudflare.com');

    const dead = target(() => ({ stdout: 'OWNED \n' }));
    const gone = await inspectQuickTunnel(dead.target, runtime);
    expect(gone).toMatchObject({ state: 'stopped', publicUrl: null, marker: null });
  });
});

describe('buildQuickInspect', () => {
  it('reads args with BSD ps flag order and falls back to command', () => {
    const script = buildQuickInspect('/tmp/puente-quick/node/abc', 'a'.repeat(32));
    expect(script).toContain('pgrep -x cloudflared');
    expect(script).toContain('ps -p "$p" -o args=');
    expect(script).toContain('ps -p "$p" -o command=');
    expect(script).not.toContain('ps -o args= -p');
    expect(script).toContain('a'.repeat(32));
  });
});

describe('buildQuickLaunch', () => {
  it('quotes a metacharacter in the origin', () => {
    const origin = 'http://127.0.0.1:9/$(touch /tmp/pwned)';
    const command = buildQuickLaunch('cloudflared', origin, '/home/alice/.puente/puente-quick/n/m');
    expect(command).toContain(shq(origin));
    expect(command).toContain('echo started');
  });
});
