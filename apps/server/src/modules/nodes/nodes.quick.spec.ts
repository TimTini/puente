import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DbService } from '../../db/db.service';
import { CryptoService } from '../../common/crypto.service';
import { nodes } from '../../db/schema';
import { NodesService } from './nodes.service';
import type { CloudflaredService } from '../cloudflared/cloudflared.service';
import type { CloudflareService } from '../cloudflare/cloudflare.service';
import type { SettingsService } from '../settings/settings.service';
import type { EventsService } from '../events/events.service';
import type { EventBus } from '../../common/event-bus.service';
import type { WorkspacesService } from '../workspaces/workspaces.service';
import type { RoutesService } from '../routes/routes.service';
import type { SshService } from '../ssh/ssh.service';
import { blankQuick, type QuickStopResult } from '../cloudflared/quick-tunnel';

const dbs = new DbService();
const MARKER = 'd'.repeat(32);
const DIR = '/home/alice/.puente/puente-quick/node_q/' + MARKER;
const ORIGIN = 'http://127.0.0.1:8080';
const URL = 'https://demo.trycloudflare.com';

const running = blankQuick({
  state: 'running',
  publicUrl: URL,
  marker: MARKER,
  runtimeDir: DIR,
  pid: 5,
  startedAt: '2026-10-30T00:00:00.000Z',
});

const createTunnel = vi.fn();
const getTunnelToken = vi.fn();
const deleteTunnel = vi.fn();
const getTunnelInfo = vi.fn(async () => null);
const startQuick = vi.fn();
const stopQuick = vi.fn(async (): Promise<QuickStopResult> => 'stopped');
const inspectQuick = vi.fn(async () => blankQuick({ state: 'stopped' }));
const controlService = vi.fn();
const ensureInstalled = vi.fn(async () => ({ version: '2026.1.2', installedNow: false }));
let sshDown = false;

const cloudflare = {
  createTunnel,
  getTunnelToken,
  deleteTunnel,
  getTunnelInfo,
} as unknown as CloudflareService;
const cloudflared = {
  ensureInstalled,
  startQuick,
  stopQuick,
  inspectQuick,
  controlService,
  runState: vi.fn(async () => 'stopped'),
  installConnector: vi.fn(),
  uninstallConnector: vi.fn(),
} as unknown as CloudflaredService;
const settings = {
  isCloudflareConnected: () => false,
  get: () => ({ healthPollSeconds: 30 }),
} as unknown as SettingsService;
const events = {
  info: vi.fn(),
  success: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as EventsService;
const bus = { emit: vi.fn(), fact: vi.fn(), progress: vi.fn() } as unknown as EventBus;
const workspaces = { currentId: () => 'ws_default' } as unknown as WorkspacesService;
const routes = {
  removeForNode: vi.fn(async () => undefined),
  rebuildIngress: vi.fn(),
} as unknown as RoutesService;
const ssh = {
  getExecutor: async () => {
    if (sshDown) throw new Error('ssh closed');
    return {
      kind: 'local' as const,
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
      writeFile: async () => undefined,
      dispose: async () => undefined,
    };
  },
  detect: async () => ({
    os: 'linux',
    arch: 'amd64',
    hostname: 'box',
    passwordlessSudo: false,
    cloudflaredVersion: '2026.1.2',
  }),
} as unknown as SshService;

const svc = new NodesService(
  dbs,
  new CryptoService(),
  bus,
  events,
  ssh,
  cloudflared,
  cloudflare,
  settings,
  workspaces,
  routes,
);

const t = Date.now();

beforeEach(() => {
  sshDown = false;
  vi.clearAllMocks();
  stopQuick.mockResolvedValue('stopped');
  inspectQuick.mockResolvedValue(blankQuick({ state: 'stopped' }));
  startQuick.mockImplementation(async (_target, _id, _origin, opts) => {
    opts?.onPrepared?.(blankQuick({ state: 'starting', marker: MARKER, runtimeDir: DIR }));
    return running;
  });
  dbs.db.delete(nodes).where(eq(nodes.id, 'node_q')).run();
  dbs.db
    .insert(nodes)
    .values({
      id: 'node_q',
      workspaceId: 'ws_default',
      name: 'box',
      kind: 'local',
      provisionState: 'unprovisioned',
      connectorRunState: 'unknown',
      serviceInstalled: false,
      lastError: 'named-error',
      createdAt: t,
      updatedAt: t,
    })
    .run();
});

afterAll(() => {
  dbs.db.delete(nodes).where(eq(nodes.id, 'node_q')).run();
  dbs.onModuleDestroy();
});

describe('Quick Tunnel on a node', () => {
  it('removes a Quick Tunnel origin only after stopping its process, preserving named state', async () => {
    await svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    inspectQuick.mockResolvedValue(running);
    const node = await svc.removeQuick('node_q');
    expect(stopQuick).toHaveBeenCalledTimes(1);
    expect(node.quickTunnel).toMatchObject({ state: 'stopped', origin: null, url: null });
    expect(node.lastError).toBe('named-error');
    expect(controlService).not.toHaveBeenCalled();
    expect(deleteTunnel).not.toHaveBeenCalled();
  });

  it('retains the Quick origin and ownership when removal cannot confirm the process stopped', async () => {
    await svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    sshDown = true;
    await expect(svc.removeQuick('node_q')).rejects.toBeInstanceOf(ConflictException);
    expect(svc.get('node_q').quickTunnel.origin).toBe(ORIGIN);
    expect(
      dbs.db.select().from(nodes).where(eq(nodes.id, 'node_q')).get()?.quickRuntime?.marker,
    ).toBe(MARKER);
  });

  it('does not forget an unresolved Quick Tunnel without process identity', async () => {
    dbs.db
      .update(nodes)
      .set({ quickOrigin: ORIGIN, quickRuntime: blankQuick({ state: 'unknown' }) })
      .where(eq(nodes.id, 'node_q'))
      .run();
    await expect(svc.removeQuick('node_q')).rejects.toBeInstanceOf(ConflictException);
    expect(svc.get('node_q').quickTunnel.origin).toBe(ORIGIN);
  });

  it('starts without calling Cloudflare, and a second start does not spawn again', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    startQuick.mockImplementation(async (_target, _id, _origin, opts) => {
      opts?.onPrepared?.(blankQuick({ state: 'starting', marker: MARKER, runtimeDir: DIR }));
      await gate;
      return running;
    });
    inspectQuick.mockResolvedValue(running);

    const first = svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    const second = svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    release();
    const [a, b] = await Promise.all([first, second]);

    expect(startQuick).toHaveBeenCalledTimes(1);
    expect(createTunnel).not.toHaveBeenCalled();
    expect(getTunnelToken).not.toHaveBeenCalled();
    expect(a.quickTunnel.url).toBe(URL);
    expect(b.quickTunnel.url).toBe(URL);
    expect(JSON.stringify(a)).not.toContain(MARKER);
    expect(a.lastError).toBe('named-error');
  });

  it('refuses a different origin while one is running and blocks a named upgrade', async () => {
    await svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    inspectQuick.mockResolvedValue(running);
    await expect(
      svc.setConnector('node_q', 'start', { type: 'quick', origin: 'http://127.0.0.1:9090' }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.upgradeConnector('node_q')).rejects.toBeInstanceOf(ConflictException);
  });

  it('clears the URL before restart launches again', async () => {
    await svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    inspectQuick.mockResolvedValue(running);
    startQuick.mockImplementation(async (_target, _id, _origin, opts) => {
      const row = dbs.db.select().from(nodes).where(eq(nodes.id, 'node_q')).get();
      expect(row?.quickRuntime?.publicUrl ?? null).toBeNull();
      opts?.onPrepared?.(blankQuick({ state: 'starting', marker: MARKER, runtimeDir: DIR }));
      return { ...running, publicUrl: 'https://next.trycloudflare.com' };
    });
    const node = await svc.setConnector('node_q', 'restart', { type: 'quick' });
    expect(node.quickTunnel.url).toBe('https://next.trycloudflare.com');
  });

  it('keeps the node when delete cannot reach the machine', async () => {
    await svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN });
    sshDown = true;
    await expect(svc.remove('node_q')).rejects.toBeInstanceOf(ConflictException);
    expect(dbs.db.select().from(nodes).where(eq(nodes.id, 'node_q')).get()).toBeTruthy();
  });

  it('does not let a named connector action or a quick failure touch the other mode', async () => {
    await svc.setConnector('node_q', 'start', { type: 'named' });
    expect(controlService).toHaveBeenCalled();
    expect(startQuick).not.toHaveBeenCalled();

    dbs.db
      .update(nodes)
      .set({
        quickOrigin: ORIGIN,
        quickRuntime: running,
        tunnelId: 'tun_1',
        lastError: 'named-error',
      })
      .where(eq(nodes.id, 'node_q'))
      .run();
    inspectQuick.mockResolvedValue(
      blankQuick({ state: 'error', lastError: 'quick failed', marker: null, runtimeDir: null }),
    );
    const node = await svc.refreshStatus('node_q');
    expect(node.quickTunnel.state).toBe('error');
    expect(node.quickTunnel.url).toBeNull();
    expect(node.lastError).toBe('named-error');
    expect(getTunnelInfo).not.toHaveBeenCalled();
  });

  it('still requires Cloudflare for a named provision', async () => {
    await expect(svc.provision('node_q', { installService: true })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(createTunnel).not.toHaveBeenCalled();
  });

  it('hides a stored URL until the process is seen again', () => {
    dbs.db
      .update(nodes)
      .set({ quickOrigin: ORIGIN, quickRuntime: running })
      .where(eq(nodes.id, 'node_q'))
      .run();
    svc.quarantineUnreconciledQuick();
    const node = svc.get('node_q');
    expect(node.quickTunnel.state).toBe('unknown');
    expect(node.quickTunnel.url).toBeNull();
  });

  it('refuses another start while contact is lost', async () => {
    dbs.db
      .update(nodes)
      .set({
        quickOrigin: ORIGIN,
        quickRuntime: blankQuick({ state: 'unknown', marker: MARKER, runtimeDir: DIR }),
      })
      .where(eq(nodes.id, 'node_q'))
      .run();
    sshDown = true;
    await expect(
      svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(startQuick).not.toHaveBeenCalled();
  });

  it('does not spawn a second process while one is still starting', async () => {
    dbs.db
      .update(nodes)
      .set({
        quickOrigin: ORIGIN,
        quickRuntime: blankQuick({ state: 'starting', marker: MARKER, runtimeDir: DIR, pid: 5 }),
      })
      .where(eq(nodes.id, 'node_q'))
      .run();
    inspectQuick.mockResolvedValue(
      blankQuick({ state: 'starting', marker: MARKER, runtimeDir: DIR, pid: 5 }),
    );
    await expect(
      svc.setConnector('node_q', 'start', { type: 'quick', origin: ORIGIN }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(startQuick).not.toHaveBeenCalled();
  });

  it('does not let a slow refresh replace a newer Quick runtime', async () => {
    const newerMarker = 'e'.repeat(32);
    dbs.db
      .update(nodes)
      .set({ quickOrigin: ORIGIN, quickRuntime: running })
      .where(eq(nodes.id, 'node_q'))
      .run();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    inspectQuick.mockImplementation(async () => {
      entered();
      await gate;
      return blankQuick({ state: 'stopped' });
    });
    const refresh = svc.refreshStatus('node_q');
    await started;
    const newer = blankQuick({
      state: 'running',
      publicUrl: 'https://new.trycloudflare.com',
      marker: newerMarker,
      runtimeDir: DIR,
      pid: 9,
    });
    dbs.db.update(nodes).set({ quickRuntime: newer }).where(eq(nodes.id, 'node_q')).run();
    release();
    await refresh;
    const node = svc.get('node_q');
    expect(node.quickTunnel.url).toBe('https://new.trycloudflare.com');
    expect(JSON.stringify(node)).not.toContain(MARKER);
    expect(JSON.stringify(node)).not.toContain(newerMarker);
  });

  it('keeps the marker when stop cannot see the process', async () => {
    dbs.db
      .update(nodes)
      .set({
        quickOrigin: ORIGIN,
        quickRuntime: blankQuick({ state: 'unknown', marker: MARKER, runtimeDir: DIR, pid: 5 }),
      })
      .where(eq(nodes.id, 'node_q'))
      .run();
    stopQuick.mockResolvedValue('absent');
    inspectQuick.mockResolvedValue(
      blankQuick({ state: 'unknown', marker: MARKER, runtimeDir: DIR, pid: 5 }),
    );
    const node = await svc.setConnector('node_q', 'stop', { type: 'quick' });
    expect(node.quickTunnel.state).toBe('unknown');
    const row = dbs.db.select().from(nodes).where(eq(nodes.id, 'node_q')).get();
    const stored = row?.quickRuntime as { marker?: string; state?: string } | null;
    expect(stored?.marker).toBe(MARKER);
    expect(stored?.state).toBe('unknown');
  });
});
