import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { QuickState } from '@puente/shared';
import type { CommandExecutor } from '../../common/executor';
import { shq } from '../../common/shell';
import { DATA_DIR } from '../../config/paths';
import type { QuickRuntimeRecord } from '../../db/schema';

/**
 * Path segment that named-connector cleanup refuses to touch.
 * Named matching stays `tunnel run`; this prefix keeps a Quick process out of that case
 * even when the origin text itself contains "tunnel run".
 */
export const QUICK_DIR_SEGMENT = 'puente-quick';

/**
 * cloudflared usually prints the trycloudflare URL and registers a connection within 15s.
 * 25s is the point we stop the process we started and return an error, instead of leaving it up
 * without a URL we can show. See Cloudflare Quick Tunnels and the `--pidfile` run parameter:
 * the pidfile is written only after the first successful connection.
 */
export const QUICK_READY_MS = 25_000;
export const QUICK_POLL_MS = 500;
/** SIGTERM, then SIGKILL only if the same owned pid is still alive. */
export const QUICK_STOP_GRACE_MS = 5_000;

export type QuickRuntime = QuickRuntimeRecord;

export interface QuickTarget {
  exec: CommandExecutor;
}

export interface QuickRunOptions {
  deadlineMs?: number;
  graceMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Called after the runtime dir exists and before the process is spawned. */
  onPrepared?: (runtime: QuickRuntime) => void;
}

const TRYCLOUDFLARE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function blankQuick(over: Partial<QuickRuntime> = {}): QuickRuntime {
  return {
    state: 'stopped',
    publicUrl: null,
    startedAt: null,
    pid: null,
    marker: null,
    runtimeDir: null,
    lastError: null,
    ...over,
  };
}

export function coerceQuick(value: unknown): QuickRuntime {
  if (!value || typeof value !== 'object') return blankQuick();
  const row = value as Partial<QuickRuntime>;
  const states: QuickState[] = ['stopped', 'starting', 'running', 'unknown', 'error'];
  return blankQuick({
    state: states.includes(row.state as QuickState) ? (row.state as QuickState) : 'error',
    publicUrl: typeof row.publicUrl === 'string' ? row.publicUrl : null,
    startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    pid: typeof row.pid === 'number' && Number.isInteger(row.pid) ? row.pid : null,
    marker: typeof row.marker === 'string' ? row.marker : null,
    runtimeDir: typeof row.runtimeDir === 'string' ? row.runtimeDir : null,
    lastError: typeof row.lastError === 'string' ? row.lastError : null,
  });
}

export function redactOrigin(origin: string): string {
  try {
    const url = new URL(origin);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return 'http://invalid-origin';
  }
}

export function scrubOrigin(message: string, origin: string): string {
  if (!origin) return message;
  return message.split(origin).join(redactOrigin(origin));
}

const QUICK_EXIT_ERROR = 'cloudflared exited before the Quick Tunnel was ready.';
/** Crash lines are usually at the end. Keep that tail, not the whole logfile. */
const QUICK_EXIT_TAIL = 240;

function earlyExitError(log: string, origin: string): string {
  const tail = scrubOrigin(log, origin)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/ +/g, ' ')
    .trim();
  if (!tail) return QUICK_EXIT_ERROR;
  const short = tail.length > QUICK_EXIT_TAIL ? tail.slice(-QUICK_EXIT_TAIL).trim() : tail;
  return short ? `${QUICK_EXIT_ERROR} ${short}` : QUICK_EXIT_ERROR;
}

/** https://<single-label>.trycloudflare.com — nothing else, including a lookalike suffix. */
export function matchTryCloudflareUrl(text: string): string | null {
  const found = text.match(/https:\/\/[^\s"'<>]+/gi) ?? [];
  for (const raw of found) {
    let url: URL;
    try {
      url = new URL(raw.replace(/[),.;]+$/, ''));
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    const labels = url.hostname.toLowerCase().split('.');
    if (labels.length !== 3 || labels[1] !== 'trycloudflare' || labels[2] !== 'com') continue;
    if (!TRYCLOUDFLARE.test(labels[0]!)) continue;
    return `https://${labels.join('.')}`;
  }
  return null;
}

/** Line-oriented parse. The unfinished tail is returned so a URL split across reads still joins. */
export function consumeQuickLog(
  pending: string,
  chunk: string,
): { pending: string; url: string | null; registered: boolean } {
  const text = pending + chunk;
  const lines = text.split('\n');
  const rest = lines.pop() ?? '';
  let url: string | null = null;
  let registered = false;
  for (const line of lines) {
    url = matchTryCloudflareUrl(line) ?? url;
    if (/registered tunnel connection/i.test(line)) registered = true;
  }
  return { pending: rest, url, registered };
}

export function readQuickLog(text: string): { url: string | null; registered: boolean } {
  const flushed = text.endsWith('\n') ? text : `${text}\n`;
  const parsed = consumeQuickLog('', flushed);
  return { url: parsed.url, registered: parsed.registered };
}

export function quickRuntimeDir(
  kind: 'local' | 'ssh',
  home: string | null,
  nodeId: string,
  marker: string,
): string {
  if (!/^[\w-]+$/.test(nodeId) || !/^[a-f0-9]{32}$/.test(marker)) {
    throw new Error('Invalid Quick Tunnel identity.');
  }
  if (kind === 'local') return join(DATA_DIR, QUICK_DIR_SEGMENT, nodeId, marker);
  if (!home || !home.startsWith('/'))
    throw new Error('Remote home directory is not an absolute path.');
  return `${home}/.puente/${QUICK_DIR_SEGMENT}/${nodeId}/${marker}`;
}

/**
 * Flag order follows Cloudflare's quick-tunnel form `cloudflared tunnel --url <origin>`
 * and the tunnel-level flags `--no-autoupdate`, `--config`, `--logfile`, `--pidfile`
 * (run parameters; `--config` is set so a named config already on the machine is not read).
 * The repo does not pin a cloudflared release; the installer downloads the current one.
 */
export function buildQuickLaunch(cmd: string, origin: string, dir: string): string {
  const config = `${dir}/config.yml`;
  const log = `${dir}/cloudflared.log`;
  const stdoutLog = `${dir}/stdout.log`;
  const pidfile = `${dir}/cloudflared.pid`;
  const launcher = `${dir}/launcher.pid`;
  return (
    `nohup ${shq(cmd)} tunnel --no-autoupdate --config ${shq(config)} --logfile ${shq(log)} ` +
    `--pidfile ${shq(pidfile)} --url ${shq(origin)} >> ${shq(stdoutLog)} 2>&1 & ` +
    `echo $! > ${shq(launcher)}; disown 2>/dev/null || true; echo started`
  );
}

/**
 * Read a cloudflared command line. BSD ps treats `-o` before `-p` as a bad format and
 * prints nothing; GNU accepts either order. `command=` covers a blank `args=`.
 * `$p` is the loop variable from `pgrep -x cloudflared`.
 */
function cloudflaredArgs(): string {
  // BSD ps clips argv to the terminal width. -ww is unlimited, and -p must come before -o.
  return 'args=$(ps -ww -p "$p" -o args= 2>/dev/null); [ -n "$args" ] || args=$(ps -ww -p "$p" -o command= 2>/dev/null)';
}

export function buildQuickInspect(dir: string, marker: string): string {
  const markerQ = shq(marker);
  const pidfile = shq(`${dir}/cloudflared.pid`);
  const launcher = shq(`${dir}/launcher.pid`);
  return [
    `owned() { for p in $(pgrep -x cloudflared 2>/dev/null); do ${cloudflaredArgs()}; case "$args" in *${markerQ}*) echo "$p";; esac; done; }`,
    `echo OWNED $(owned | tr '\\n' ' ')`,
    `if [ -f ${pidfile} ]; then echo PIDFILE $(tr -cd '0-9' < ${pidfile}); fi`,
    `lp=$(tr -cd '0-9' < ${launcher} 2>/dev/null || true)`,
    `if [ -n "$lp" ] && kill -0 "$lp" 2>/dev/null; then echo LAUNCHER_ALIVE "$lp"; fi`,
  ].join('; ');
}

/** Startup lines are not an exit. A trycloudflare URL means the process is still coming up. */
function quickLogStillStarting(log: string): boolean {
  return (
    /Requesting new quick Tunnel/i.test(log) ||
    /Registered tunnel connection/i.test(log) ||
    matchTryCloudflareUrl(log) !== null
  );
}

export function buildQuickLogRead(dir: string): string {
  return `cat ${shq(`${dir}/cloudflared.log`)} ${shq(`${dir}/stdout.log`)} 2>/dev/null || true`;
}

export interface QuickInspectInfo {
  owned: number[];
  pidfile: number | null;
  launcherAlive: number | null;
}

export function parseInspect(stdout: string): QuickInspectInfo {
  const owned: number[] = [];
  let pidfile: number | null = null;
  let launcherAlive: number | null = null;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('OWNED ')) {
      for (const part of trimmed.slice('OWNED '.length).trim().split(/\s+/)) {
        if (/^\d+$/.test(part)) owned.push(Number(part));
      }
    } else if (trimmed.startsWith('PIDFILE ')) {
      const value = trimmed.slice('PIDFILE '.length).trim();
      if (/^\d+$/.test(value)) pidfile = Number(value);
    } else if (trimmed.startsWith('LAUNCHER_ALIVE ')) {
      const value = trimmed.slice('LAUNCHER_ALIVE '.length).trim();
      if (/^\d+$/.test(value)) launcherAlive = Number(value);
    }
  }
  return { owned, pidfile, launcherAlive };
}

const EMPTY_CONFIG =
  '# puente-quick\n# Empty on purpose: a named tunnel config on this machine must not be used.\n';

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function assertOrigin(origin: string): void {
  if (hasControlChar(origin)) throw new Error('Origin contains control characters.');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Origin must be an absolute http(s) URL.');
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    throw new Error('Origin must be an http(s) URL without credentials.');
  }
}

async function remoteHome(exec: CommandExecutor): Promise<string> {
  const res = await exec.exec('printf %s "$HOME"');
  const home = res.stdout.trim();
  if (!home.startsWith('/')) throw new Error('Could not resolve the remote home directory.');
  return home;
}

function lost(runtime: QuickRuntime, message: string): QuickRuntime {
  return { ...runtime, state: 'unknown', publicUrl: null, lastError: message };
}

async function readInspect(
  target: QuickTarget,
  runtime: QuickRuntime,
): Promise<QuickInspectInfo | 'unknown'> {
  if (!runtime.runtimeDir || !runtime.marker) return parseInspect('');
  try {
    const res = await target.exec.exec(buildQuickInspect(runtime.runtimeDir, runtime.marker), {
      timeoutMs: 15000,
    });
    if (res.code === 124) return 'unknown';
    return parseInspect(res.stdout);
  } catch {
    return 'unknown';
  }
}

function readyFrom(
  info: QuickInspectInfo,
  log: { url: string | null; registered: boolean },
): boolean {
  if (!log.url || info.owned.length !== 1) return false;
  const pid = info.owned[0]!;
  return log.registered || info.pidfile === pid;
}

export async function startQuickTunnel(
  target: QuickTarget,
  nodeId: string,
  origin: string,
  cmd: string,
  opts: QuickRunOptions = {},
): Promise<QuickRuntime> {
  assertOrigin(origin);
  const marker = randomBytes(16).toString('hex');
  const home = target.exec.kind === 'ssh' ? await remoteHome(target.exec) : null;
  const dir = quickRuntimeDir(target.exec.kind, home, nodeId, marker);
  const prepared = blankQuick({ state: 'starting', marker, runtimeDir: dir });
  await target.exec.exec(`mkdir -p ${shq(dir)} && chmod 700 ${shq(dir)}`);
  await target.exec.writeFile(`${dir}/config.yml`, EMPTY_CONFIG, 0o600);
  await target.exec.writeFile(
    `${dir}/manifest.json`,
    JSON.stringify({ marker, nodeId, origin: redactOrigin(origin) }),
    0o600,
  );
  opts.onPrepared?.(prepared);

  let launched;
  try {
    launched = await target.exec.exec(buildQuickLaunch(cmd, origin, dir), { timeoutMs: 20000 });
  } catch {
    return lost(prepared, 'Lost contact while starting the Quick Tunnel.');
  }
  if (launched.code === 124) return lost(prepared, 'Lost contact while starting the Quick Tunnel.');
  if (!launched.stdout.includes('started')) {
    return blankQuick({
      state: 'error',
      marker,
      runtimeDir: dir,
      lastError: scrubOrigin(
        launched.stderr || launched.stdout || 'cloudflared did not start.',
        origin,
      ),
    });
  }

  const deadline = opts.deadlineMs ?? QUICK_READY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollMs ?? QUICK_POLL_MS;
  const began = now();
  // macOS can report a dead nohup pid before cloudflared shows up. One empty inspect is not an exit.
  let emptySince: number | null = null;
  let last: QuickInspectInfo | null = null;

  while (now() - began < deadline) {
    let log: { code: number; stdout: string };
    try {
      log = await target.exec.exec(buildQuickLogRead(dir), { timeoutMs: 15000 });
    } catch {
      return lost(prepared, 'Lost contact after the Quick Tunnel process was started.');
    }
    if (log.code === 124)
      return lost(prepared, 'Lost contact after the Quick Tunnel process was started.');
    // Full file each poll. consumeQuickLog keeps a split tail; readQuickLog flushes a finished last line.
    const parsed = consumeQuickLog('', log.stdout);
    const flushed = readQuickLog(parsed.pending);
    const url = parsed.url ?? flushed.url;
    const registered = parsed.registered || flushed.registered;

    const info = await readInspect(target, prepared);
    if (info === 'unknown')
      return lost(prepared, 'Lost contact after the Quick Tunnel process was started.');
    last = info;
    if (readyFrom(info, { url, registered })) {
      return blankQuick({
        state: 'running',
        publicUrl: url,
        startedAt: new Date().toISOString(),
        pid: info.owned[0] ?? null,
        marker,
        runtimeDir: dir,
      });
    }
    const empty = info.owned.length === 0 && !info.launcherAlive;
    // A startup line, or a cloudflared whose args contain this runtime dir, is still starting.
    if (empty && !quickLogStillStarting(log.stdout)) {
      const finished = log.stdout.trim().length > 0;
      const repeated = emptySince !== null && (finished || now() - emptySince >= pollMs);
      if (repeated) {
        return blankQuick({
          state: 'error',
          publicUrl: null,
          lastError: earlyExitError(log.stdout, origin),
          marker,
          runtimeDir: dir,
        });
      }
      if (emptySince === null) emptySince = now();
    } else {
      emptySince = null;
    }
    await sleep(pollMs);
  }

  if (last && last.owned.length > 0) {
    const stopped = await stopQuickTunnel(target, prepared, opts);
    if (stopped === 'stopped') {
      return blankQuick({
        state: 'error',
        publicUrl: null,
        lastError: 'Quick Tunnel did not become ready before the deadline.',
      });
    }
    return blankQuick({
      state: 'error',
      publicUrl: null,
      lastError: 'Quick Tunnel did not become ready before the deadline.',
      marker,
      runtimeDir: dir,
    });
  }
  return blankQuick({
    state: 'unknown',
    publicUrl: null,
    marker,
    runtimeDir: dir,
  });
}

function signalOwned(
  target: QuickTarget,
  runtime: QuickRuntime,
  signal: 'TERM' | 'KILL',
  pids: number[],
): Promise<unknown> {
  const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (list.length === 0 || !runtime.marker) return Promise.resolve();
  const markerQ = shq(runtime.marker);
  return target.exec.exec(
    `for p in ${list.join(' ')}; do ${cloudflaredArgs()}; case "$args" in *${markerQ}*) kill -${signal} "$p";; esac; done`,
  );
}

export type QuickStopResult = 'stopped' | 'mismatch' | 'absent';

export async function stopQuickTunnel(
  target: QuickTarget,
  runtime: QuickRuntime,
  opts: QuickRunOptions = {},
): Promise<QuickStopResult> {
  if (!runtime.marker || !runtime.runtimeDir) return 'absent';
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const grace = opts.graceMs ?? QUICK_STOP_GRACE_MS;
  let seen = await readInspect(target, runtime);
  if (seen === 'unknown') throw new Error('Lost contact while stopping the Quick Tunnel.');
  // One empty look can be a truncated argv. Confirm with a second wide inspect before dropping it.
  if (seen.owned.length === 0 && !seen.launcherAlive) {
    const again = await readInspect(target, runtime);
    if (again === 'unknown') throw new Error('Lost contact while stopping the Quick Tunnel.');
    if (again.owned.length === 0 && !again.launcherAlive) return 'stopped';
    seen = again;
  }
  // Alive pid whose args do not contain our marker: reused pid, or not our process. Do not kill it.
  if (seen.owned.length === 0) return seen.launcherAlive ? 'mismatch' : 'absent';
  await signalOwned(target, runtime, 'TERM', seen.owned);
  const slices = 5;
  for (let i = 0; i < slices; i++) {
    if (grace > 0) await sleep(Math.max(1, Math.floor(grace / slices)));
    const again = await readInspect(target, runtime);
    if (again === 'unknown') throw new Error('Lost contact while stopping the Quick Tunnel.');
    if (again.owned.length === 0) return 'stopped';
  }
  const still = await readInspect(target, runtime);
  if (still === 'unknown') throw new Error('Lost contact while stopping the Quick Tunnel.');
  if (still.owned.length === 0) return 'stopped';
  await signalOwned(target, runtime, 'KILL', still.owned);
  const done = await readInspect(target, runtime);
  if (done === 'unknown') throw new Error('Lost contact while stopping the Quick Tunnel.');
  if (done.owned.length > 0) throw new Error('Quick Tunnel process did not exit.');
  return 'stopped';
}

export async function inspectQuickTunnel(
  target: QuickTarget,
  runtime: QuickRuntime,
): Promise<QuickRuntime> {
  const current = coerceQuick(runtime);
  if (!current.marker || !current.runtimeDir) {
    return blankQuick({ state: 'stopped', lastError: current.lastError });
  }
  const info = await readInspect(target, current);
  if (info === 'unknown') {
    return { ...current, state: 'unknown', publicUrl: null };
  }
  if (info.owned.length > 1) {
    return {
      ...current,
      state: 'error',
      publicUrl: null,
      pid: null,
      lastError: 'More than one Quick Tunnel process matched this node.',
    };
  }
  if (info.owned.length === 1) {
    let logText: string;
    try {
      const log = await target.exec.exec(buildQuickLogRead(current.runtimeDir), {
        timeoutMs: 15000,
      });
      if (log.code === 124) return { ...current, state: 'unknown', publicUrl: null };
      logText = log.stdout;
    } catch {
      return { ...current, state: 'unknown', publicUrl: null };
    }
    const parsed = readQuickLog(logText);
    if (readyFrom(info, parsed)) {
      return blankQuick({
        state: 'running',
        publicUrl: parsed.url,
        startedAt: current.startedAt ?? new Date().toISOString(),
        pid: info.owned[0] ?? null,
        marker: current.marker,
        runtimeDir: current.runtimeDir,
      });
    }
    return blankQuick({
      state: 'starting',
      pid: info.owned[0] ?? null,
      marker: current.marker,
      runtimeDir: current.runtimeDir,
      startedAt: current.startedAt,
    });
  }
  if (info.launcherAlive) {
    return { ...current, state: 'unknown', publicUrl: null };
  }
  const again = await readInspect(target, current);
  if (again === 'unknown') return { ...current, state: 'unknown', publicUrl: null };
  if (again.owned.length > 0 || again.launcherAlive) {
    return { ...current, state: 'unknown', publicUrl: null };
  }
  return blankQuick({ state: 'stopped' });
}

export function isNamedConnectorArgs(args: string): boolean {
  if (args.includes(`/${QUICK_DIR_SEGMENT}/`)) return false;
  return args.includes('tunnel run');
}
