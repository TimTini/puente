import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  ConnectorInput,
  CreateNodeInput,
  Node,
  ProvisionNodeInput,
  SshBootstrapInput,
  SshTestResult,
  UpdateNodeInput,
} from '@puente/shared';
import { DbService } from '../../db/db.service';
import { CryptoService } from '../../common/crypto.service';
import { EventBus } from '../../common/event-bus.service';
import { EventsService } from '../events/events.service';
import { SshService } from '../ssh/ssh.service';
import { CloudflaredService, type Target } from '../cloudflared/cloudflared.service';
import { CloudflareService } from '../cloudflare/cloudflare.service';
import { SettingsService } from '../settings/settings.service';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { RoutesService } from '../routes/routes.service';
import { nodes, type NodeRow } from '../../db/schema';
import { newId } from '../../common/ids';
import { nowMs } from '../../common/time';
import { toNodeDto } from './node.mapper';
import type { CommandExecutor } from '../../common/executor';
import {
  blankQuick,
  coerceQuick,
  scrubOrigin,
  type QuickRuntime,
} from '../cloudflared/quick-tunnel';

@Injectable()
export class NodesService {
  private readonly logger = new Logger(NodesService.name);
  /** Serializes Quick start/stop/restart per node so two clicks cannot spawn two processes. */
  private readonly quickTail = new Map<string, Promise<unknown>>();
  private readonly quickDeleting = new Set<string>();

  constructor(
    private readonly dbs: DbService,
    private readonly crypto: CryptoService,
    private readonly bus: EventBus,
    private readonly events: EventsService,
    private readonly ssh: SshService,
    private readonly cloudflared: CloudflaredService,
    private readonly cloudflare: CloudflareService,
    private readonly settings: SettingsService,
    private readonly workspaces: WorkspacesService,
    private readonly routes: RoutesService,
  ) {}

  private get db() {
    return this.dbs.db;
  }

  list(): Node[] {
    return this.db
      .select()
      .from(nodes)
      .where(eq(nodes.workspaceId, this.workspaces.currentId()))
      .all()
      .map(toNodeDto);
  }

  getRow(id: string): NodeRow {
    const row = this.db.select().from(nodes).where(eq(nodes.id, id)).get();
    if (!row) throw new NotFoundException(`Node ${id} not found`);
    return row;
  }

  get(id: string): Node {
    return toNodeDto(this.getRow(id));
  }

  async create(dto: CreateNodeInput): Promise<Node> {
    const now = nowMs();
    const base = {
      id: newId('node'),
      workspaceId: this.workspaces.currentId(),
      name: dto.name,
      provisionState: 'unprovisioned' as const,
      connectorRunState: 'unknown' as const,
      serviceInstalled: false,
      createdAt: now,
      updatedAt: now,
    };

    if (dto.kind === 'local') {
      // Only one local node makes sense (the control-plane host).
      // One local node per workspace: it is the control-plane host, and each workspace
      // publishes it through its own Cloudflare account.
      const existingLocal = this.db
        .select()
        .from(nodes)
        .where(and(eq(nodes.kind, 'local'), eq(nodes.workspaceId, this.workspaces.currentId())))
        .get();
      if (existingLocal) {
        throw new BadRequestException({
          statusCode: 400,
          error: 'LocalExists',
          message: 'A local node already exists.',
          code: 'LOCAL_EXISTS',
        });
      }
      this.db
        .insert(nodes)
        .values({ ...base, kind: 'local' })
        .run();
    } else {
      let host = dto.host;
      let port = dto.port;
      let username = dto.username;
      let privateKeyPath = dto.privateKeyPath ?? null;

      if (dto.sshConfigAlias) {
        const hosts = await this.ssh.parseUserSshConfig();
        const alias = hosts.find((h) => h.alias === dto.sshConfigAlias);
        if (alias) {
          host = alias.hostName ?? host;
          username = alias.user ?? username;
          port = alias.port ?? port;
          privateKeyPath = privateKeyPath ?? alias.identityFile;
        }
      }

      this.db
        .insert(nodes)
        .values({
          ...base,
          kind: 'ssh',
          sshHost: host,
          sshPort: port,
          sshUsername: username,
          sshAuthMethod: 'key',
          sshPrivateKeyPath: privateKeyPath,
          sshManagedKey: false,
        })
        .run();
    }

    this.events.info('node.create', `Added node "${dto.name}"`, { nodeId: base.id });
    return this.emitUpdated(base.id);
  }

  update(id: string, dto: UpdateNodeInput): Node {
    const row = this.getRow(id);
    const patch: Partial<NodeRow> = { updatedAt: nowMs() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (row.kind === 'ssh') {
      if (dto.host !== undefined) patch.sshHost = dto.host;
      if (dto.port !== undefined) patch.sshPort = dto.port;
      if (dto.username !== undefined) patch.sshUsername = dto.username;
      if (dto.privateKeyPath !== undefined) patch.sshPrivateKeyPath = dto.privateKeyPath;
    }
    this.db.update(nodes).set(patch).where(eq(nodes.id, id)).run();
    return this.emitUpdated(id);
  }

  async remove(id: string): Promise<void> {
    const row = this.getRow(id);
    this.quickDeleting.add(id);
    try {
      await this.ensureQuickStoppedForDelete(row);
    } catch (err) {
      this.quickDeleting.delete(id);
      throw err;
    }
    // Best-effort teardown, but only of a connector puente actually put there. Without a tunnel
    // this node was never provisioned, and tearing down anyway ran `cloudflared service uninstall`
    // on the machine — removing a connector someone else installed, for a node that had never
    // touched it. On a local node that is the user's own tunnel, and it went down for good.
    if (row.tunnelId) {
      try {
        await this.withTarget(row, async (target) => {
          await this.cloudflared.uninstallConnector(target);
        });
      } catch (err) {
        this.logger.warn(`Connector teardown failed for ${row.name}: ${String(err)}`);
      }
    }
    await this.routes.removeForNode(id).catch((e) => this.logger.warn(String(e)));
    if (row.tunnelId) {
      await this.cloudflare
        .deleteTunnel(row.tunnelId)
        .catch((e) => this.logger.warn(`Tunnel delete failed: ${String(e)}`));
    }
    this.db.delete(nodes).where(eq(nodes.id, id)).run();
    this.quickDeleting.delete(id);
    this.events.info('node.delete', `Removed node "${row.name}"`, { nodeId: id });
    this.bus.emit({ type: 'node.deleted', nodeId: id });
  }

  // --- SSH lifecycle --------------------------------------------------------

  async test(id: string): Promise<SshTestResult> {
    const row = this.getRow(id);
    if (row.kind === 'local') {
      const exec = await this.ssh.getExecutor(row);
      try {
        const d = await this.ssh.detect(exec);
        this.applyFacts(id, d);
        return {
          ok: true,
          reachable: true,
          authenticated: true,
          os: d.os,
          arch: d.arch,
          hostname: d.hostname,
          passwordlessSudo: d.passwordlessSudo,
          cloudflaredVersion: d.cloudflaredVersion,
          hostKeyFingerprint: null,
          message: 'Local machine reachable.',
        };
      } finally {
        await exec.dispose();
      }
    }
    const result = await this.ssh.test({
      host: row.sshHost!,
      port: row.sshPort ?? 22,
      username: row.sshUsername!,
      privateKeyPath: row.sshPrivateKeyPath,
      expectedFingerprint: row.sshHostKeyFingerprint,
    });
    if (result.ok) {
      this.applyFacts(id, result);
      if (result.hostKeyFingerprint && !row.sshHostKeyFingerprint) {
        this.db
          .update(nodes)
          .set({ sshHostKeyFingerprint: result.hostKeyFingerprint, updatedAt: nowMs() })
          .where(eq(nodes.id, id))
          .run();
      }
    }
    this.emitUpdated(id);
    return result;
  }

  async bootstrap(id: string, dto: SshBootstrapInput): Promise<SshTestResult> {
    const row = this.getRow(id);
    if (row.kind !== 'ssh') {
      throw new BadRequestException('Only SSH nodes can be bootstrapped.');
    }
    const { privateKeyPath, fingerprint } = await this.ssh.bootstrapPasswordless({
      host: row.sshHost!,
      port: row.sshPort ?? 22,
      username: row.sshUsername!,
      password: dto.password,
      keyName: `${row.name.replace(/[^a-zA-Z0-9_-]/g, '-')}-${row.id.slice(-6)}`,
    });
    this.db
      .update(nodes)
      .set({
        sshPrivateKeyPath: privateKeyPath,
        sshManagedKey: true,
        sshHostKeyFingerprint: fingerprint,
        sshAuthMethod: 'key',
        updatedAt: nowMs(),
      })
      .where(eq(nodes.id, id))
      .run();
    this.events.success('node.bootstrap', `Passwordless SSH configured for "${row.name}"`, {
      nodeId: id,
    });
    this.emitUpdated(id);
    return this.test(id);
  }

  // --- Provisioning ---------------------------------------------------------

  async provision(id: string, dto: ProvisionNodeInput): Promise<Node> {
    const row = this.getRow(id);
    if (!this.settings.isCloudflareConnected()) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'CloudflareNotConnected',
        message: 'Connect Cloudflare before provisioning nodes.',
        code: 'CF_NOT_CONNECTED',
      });
    }
    const scope = `node:${id}`;
    this.setState(id, { provisionState: 'provisioning', lastError: null });
    this.emitUpdated(id);
    this.bus.progress(scope, 'connect', `Connecting to ${row.name}…`);

    const exec = await this.ssh.getExecutor(row);
    try {
      const detect = await this.ssh.detect(exec);
      this.applyFacts(id, detect);
      const target: Target = {
        exec,
        os: detect.os,
        arch: detect.arch,
        passwordlessSudo: detect.passwordlessSudo,
      };

      this.bus.progress(scope, 'cloudflared', 'Ensuring cloudflared is installed…');
      const inst = await this.cloudflared.ensureInstalled(target, detect.cloudflaredVersion);
      if (inst.version) this.setState(id, { cloudflaredVersion: inst.version });

      let tunnelId = dto.existingTunnelId ?? row.tunnelId;
      let tunnelName = row.tunnelName;
      if (!tunnelId) {
        this.bus.progress(scope, 'tunnel', 'Creating Cloudflare tunnel…');
        const t = await this.cloudflare.createTunnel(this.tunnelNameFor(row));
        tunnelId = t.id;
        tunnelName = t.name;
      }

      this.bus.progress(scope, 'token', 'Fetching connector token…');
      const token = await this.cloudflare.getTunnelToken(tunnelId);
      this.setState(id, {
        tunnelId,
        tunnelName,
        tunnelTokenEnc: this.crypto.encrypt(token),
      });

      this.bus.progress(scope, 'ingress', 'Applying ingress configuration…');
      await this.routes.rebuildIngress(id);

      this.bus.progress(
        scope,
        'service',
        dto.installService ? 'Installing connector service…' : 'Starting connector…',
      );
      const conn = await this.cloudflared.installConnector(target, token);
      if (conn.note) this.events.warn('node.provision', conn.note, { nodeId: id });

      // Ask the machine rather than assuming: taking the install at its word is
      // what let a node report "Running" while nothing was connected at all.
      const runState = await this.cloudflared.runState(target);
      this.setState(id, {
        serviceInstalled: conn.serviceInstalled,
        provisionState: 'provisioned',
        connectorRunState: runState,
        lastSeenAt: nowMs(),
        lastError: null,
      });
      if (runState === 'running') {
        this.events.success('node.provision', `Node "${row.name}" is live`, { nodeId: id });
      } else {
        this.events.warn(
          'node.provision',
          `Node "${row.name}" is set up, but its connector is not running.`,
          { nodeId: id },
        );
      }
      this.bus.progress(scope, 'done', 'Node ready', { done: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setState(id, { provisionState: 'error', lastError: msg });
      this.events.error('node.provision', `Provisioning "${row.name}" failed: ${msg}`, {
        nodeId: id,
      });
      this.bus.progress(scope, 'error', msg, { done: true, error: true });
      this.emitUpdated(id);
      throw err instanceof BadRequestException ? err : new BadRequestException(msg);
    } finally {
      await exec.dispose();
    }
    // Refresh live tunnel status post-provision.
    await this.refreshStatus(id).catch(() => undefined);
    return this.emitUpdated(id);
  }

  async setConnector(
    id: string,
    action: 'start' | 'stop' | 'restart',
    input: ConnectorInput,
  ): Promise<Node> {
    if (input.type === 'quick') return this.setQuickConnector(id, action, input.origin);
    return this.setNamedConnector(id, action);
  }

  private async setNamedConnector(id: string, action: 'start' | 'stop' | 'restart'): Promise<Node> {
    const row = this.getRow(id);
    await this.withTarget(row, async (target) => {
      if (action === 'start' && !row.serviceInstalled && row.tunnelId) {
        // No persistent service: (re)launch detached using the stored token.
        const token = this.crypto.tryDecrypt(row.tunnelTokenEnc);
        if (token) {
          await this.cloudflared.installConnector(target, token);
          return;
        }
      }
      await this.cloudflared.controlService(target, action);
    });
    this.events.info('node.connector', `Connector ${action} on "${row.name}"`, { nodeId: id });
    return this.refreshStatus(id);
  }

  /**
   * Reinstall the connector binary at the latest version and restart it.
   *
   * `ensureInstalled` skips the download when it already knows a version, so upgrading means
   * asking it as though nothing were installed. Free — keeping software current is not something
   * to sell; doing it to a whole fleet in one action is (see ee/fleet).
   */
  async upgradeConnector(id: string): Promise<Node> {
    const row = this.getRow(id);
    const quick = coerceQuick(row.quickRuntime);
    if (quick.state === 'running' || quick.state === 'starting' || quick.state === 'unknown') {
      throw new ConflictException({
        statusCode: 409,
        message: 'Stop the Quick Tunnel before updating cloudflared.',
        code: 'QUICK_RUNNING',
      });
    }
    if (!row.tunnelId) {
      throw new BadRequestException(`"${row.name}" has no connector to upgrade yet.`);
    }
    const version = await this.withTarget(row, async (target) => {
      const { version } = await this.cloudflared.ensureInstalled(target, null);
      await this.cloudflared.controlService(target, 'restart').catch(() => undefined);
      return version;
    });
    if (version) this.setState(id, { cloudflaredVersion: version });
    this.events.success(
      'node.upgrade',
      `Connector on "${row.name}" is now ${version ?? 'updated'}`,
      {
        nodeId: id,
      },
    );
    return this.refreshStatus(id);
  }

  async refreshStatus(id: string): Promise<Node> {
    const row = this.getRow(id);
    // Live tunnel status from Cloudflare (no SSH needed).
    if (row.tunnelId && this.settings.isCloudflareConnected()) {
      try {
        const info = await this.cloudflare.getTunnelInfo(row.tunnelId);
        if (info) {
          this.setState(id, {
            tunnelStatus: info.status,
            connectionCount: info.connectionCount,
          });
        }
      } catch (err) {
        this.logger.warn(`tunnel status refresh failed: ${String(err)}`);
      }
    }
    // Connector run state (best-effort; remote may be offline). Quick is checked on the same
    // connection and never writes the named lastError.
    const quick = coerceQuick(row.quickRuntime);
    try {
      await this.withTarget(row, async (target) => {
        const state = await this.cloudflared.runState(target);
        this.setState(id, { connectorRunState: state, lastSeenAt: nowMs() });
        if (this.quickNeedsWatch(quick) && !this.quickTail.has(id)) {
          const next = await this.cloudflared.inspectQuick(target, quick);
          this.writeQuickIfSame(id, quick.marker, next);
        }
      });
    } catch (err) {
      this.setState(id, { connectorRunState: 'unknown' });
      if (this.quickNeedsWatch(quick) && !this.quickTail.has(id)) {
        this.writeQuickIfSame(id, quick.marker, { ...quick, state: 'unknown', publicUrl: null });
      }
      this.logger.debug(`run state check failed for ${row.name}: ${String(err)}`);
    }
    return this.emitUpdated(id);
  }

  /** Named status is the Cloudflare API. Quick status is a separate check of this node's process. */
  async pollTunnelStatuses(): Promise<void> {
    if (this.settings.isCloudflareConnected()) {
      await this.pollNamedTunnels();
    }
    await this.pollQuickTunnels();
  }

  /** A restart must not keep showing a Quick URL until this process has seen the machine. */
  quarantineUnreconciledQuick(): void {
    for (const row of this.db.select().from(nodes).all()) {
      const runtime = coerceQuick(row.quickRuntime);
      if (runtime.state === 'running' || runtime.state === 'starting') {
        this.setState(row.id, { quickRuntime: { ...runtime, state: 'unknown', publicUrl: null } });
      }
    }
  }

  private async pollNamedTunnels(): Promise<void> {
    const provisioned = this.db
      .select()
      .from(nodes)
      .all()
      .filter((n) => n.tunnelId);
    for (const n of provisioned) {
      try {
        const info = await this.cloudflare.getTunnelInfo(n.tunnelId!);
        if (!info) continue;
        if (n.tunnelStatus !== info.status || n.connectionCount !== info.connectionCount) {
          this.setState(n.id, {
            tunnelStatus: info.status,
            connectionCount: info.connectionCount,
          });
          if (n.tunnelStatus !== info.status) {
            this.bus.fact({
              type: 'health.changed',
              subject: 'node',
              id: n.id,
              name: n.name,
              from: n.tunnelStatus,
              to: info.status,
              at: nowMs(),
            });
          }
          this.emitUpdated(n.id);
        }
      } catch {
        /* transient; try again next tick */
      }
    }
  }

  private async pollQuickTunnels(): Promise<void> {
    for (const row of this.db.select().from(nodes).all()) {
      const before = coerceQuick(row.quickRuntime);
      if (!this.quickNeedsWatch(before)) continue;
      if (this.quickTail.has(row.id)) continue;
      try {
        await this.reconcileQuick(row.id);
        const after = coerceQuick(this.getRow(row.id).quickRuntime);
        if (
          after.state !== before.state ||
          after.publicUrl !== before.publicUrl ||
          after.lastError !== before.lastError
        ) {
          this.emitUpdated(row.id);
        }
      } catch (err) {
        this.logger.debug(`quick poll failed for ${row.name}: ${String(err)}`);
      }
    }
  }

  private async setQuickConnector(
    id: string,
    action: 'start' | 'stop' | 'restart',
    origin: string | undefined,
  ): Promise<Node> {
    return this.enqueueQuick(id, async () => {
      if (this.quickDeleting.has(id)) {
        throw new ConflictException({
          statusCode: 409,
          message: 'This node is being deleted.',
          code: 'QUICK_DELETE_BLOCKED',
        });
      }
      let row = this.getRow(id);
      if (this.quickNeedsWatch(coerceQuick(row.quickRuntime))) {
        await this.reconcileQuick(id);
        row = this.getRow(id);
      }
      const runtime = coerceQuick(row.quickRuntime);
      if ((action === 'start' || action === 'restart') && runtime.state === 'unknown') {
        throw new ConflictException({
          statusCode: 409,
          message: 'Puente cannot see this node, so it will not start another Quick Tunnel.',
          code: 'QUICK_UNRESOLVED',
        });
      }
      if (action === 'stop') return this.stopQuick(row);
      const nextOrigin = origin ?? row.quickOrigin ?? undefined;
      if (!nextOrigin) {
        throw new BadRequestException('Enter an http(s) origin before starting a Quick Tunnel.');
      }
      if (action === 'start' && runtime.marker && runtime.state !== 'stopped') {
        if (runtime.state === 'running' && (row.quickOrigin ?? undefined) === nextOrigin) {
          return this.get(id);
        }
        throw new ConflictException({
          statusCode: 409,
          message:
            runtime.state === 'running'
              ? 'Stop the Quick Tunnel before changing its origin.'
              : 'Stop the Quick Tunnel before starting another one.',
          code: 'QUICK_ORIGIN_BUSY',
        });
      }
      if (action === 'restart' && (runtime.state === 'running' || runtime.marker)) {
        this.setState(id, {
          quickRuntime: { ...runtime, state: 'starting', publicUrl: null, pid: null },
        });
        await this.stopOwnedQuick(this.getRow(id));
        row = this.getRow(id);
      }
      return this.launchQuick(row, nextOrigin);
    });
  }

  private async launchQuick(row: NodeRow, origin: string): Promise<Node> {
    try {
      await this.withTarget(row, async (target) => {
        const installed = await this.cloudflared.ensureInstalled(target, row.cloudflaredVersion);
        if (installed.version) this.setState(row.id, { cloudflaredVersion: installed.version });
        const runtime = await this.cloudflared.startQuick(target, row.id, origin, {
          onPrepared: (prepared) => {
            this.setState(row.id, { quickOrigin: origin, quickRuntime: prepared });
          },
        });
        this.setState(row.id, { quickOrigin: origin, quickRuntime: runtime });
        if (runtime.state === 'error') {
          throw new Error(runtime.lastError ?? 'Quick Tunnel failed.');
        }
      });
    } catch (err) {
      const message = scrubOrigin(err instanceof Error ? err.message : String(err), origin);
      const current = coerceQuick(this.getRow(row.id).quickRuntime);
      if (current.state !== 'unknown') {
        this.setState(row.id, {
          quickRuntime: { ...current, state: 'error', publicUrl: null, lastError: message },
        });
      }
      this.events.error('node.quick', `Quick Tunnel on "${row.name}" failed`, { nodeId: row.id });
      this.emitUpdated(row.id);
      throw new BadRequestException(message);
    }
    const saved = coerceQuick(this.getRow(row.id).quickRuntime);
    if (saved.state === 'unknown') {
      this.events.warn('node.quick', `Quick Tunnel on "${row.name}" could not be confirmed`, {
        nodeId: row.id,
      });
    } else {
      this.events.success('node.quick', `Quick Tunnel updated on "${row.name}"`, {
        nodeId: row.id,
      });
    }
    return this.emitUpdated(row.id);
  }

  private async stopQuick(row: NodeRow): Promise<Node> {
    const runtime = coerceQuick(row.quickRuntime);
    if (!runtime.marker) {
      this.setState(row.id, { quickRuntime: blankQuick({ state: 'stopped' }) });
      return this.emitUpdated(row.id);
    }
    await this.stopOwnedQuick(row);
    this.events.info('node.quick', `Quick Tunnel stopped on "${row.name}"`, { nodeId: row.id });
    return this.emitUpdated(row.id);
  }

  private async stopOwnedQuick(row: NodeRow): Promise<void> {
    const runtime = coerceQuick(row.quickRuntime);
    try {
      await this.withTarget(row, async (target) => {
        const result = await this.cloudflared.stopQuick(target, runtime);
        if (result === 'mismatch') {
          this.setState(row.id, {
            quickRuntime: blankQuick({
              state: 'error',
              lastError: 'The recorded pid belongs to a different process. It was left running.',
            }),
          });
          throw new ConflictException({
            statusCode: 409,
            message: 'The recorded process is not this Quick Tunnel. It was left running.',
            code: 'QUICK_OWNERSHIP',
          });
        }
        this.setState(row.id, { quickRuntime: blankQuick({ state: 'stopped' }) });
      });
    } catch (err) {
      if (err instanceof ConflictException) throw err;
      const current = coerceQuick(this.getRow(row.id).quickRuntime);
      this.setState(row.id, { quickRuntime: { ...current, state: 'unknown', publicUrl: null } });
      throw new ConflictException({
        statusCode: 409,
        message: `Puente lost contact with "${row.name}" while stopping its Quick Tunnel.`,
        code: 'QUICK_UNRESOLVED',
      });
    }
  }

  private async ensureQuickStoppedForDelete(row: NodeRow): Promise<void> {
    try {
      await this.enqueueQuick(row.id, async () => {
        const current = this.getRow(row.id);
        const runtime = coerceQuick(current.quickRuntime);
        if (
          !runtime.marker &&
          runtime.state !== 'unknown' &&
          runtime.state !== 'running' &&
          runtime.state !== 'starting'
        ) {
          return;
        }
        await this.stopOwnedQuick(current);
      });
    } catch (err) {
      if (err instanceof ConflictException && this.ownershipCleared(row.id)) return;
      const message =
        err instanceof ConflictException
          ? (err.getResponse() as { message?: string }).message
          : `Cannot reach "${row.name}" to stop its Quick Tunnel.`;
      throw new ConflictException({
        statusCode: 409,
        message: `${message ?? 'Quick Tunnel cleanup failed.'} The node was kept.`,
        code: 'QUICK_DELETE_BLOCKED',
      });
    }
  }

  private ownershipCleared(id: string): boolean {
    const runtime = coerceQuick(this.getRow(id).quickRuntime);
    return runtime.state === 'error' && !runtime.marker;
  }

  private async reconcileQuick(id: string): Promise<void> {
    const row = this.getRow(id);
    const runtime = coerceQuick(row.quickRuntime);
    if (!runtime.marker || !runtime.runtimeDir) {
      if (runtime.publicUrl || runtime.state === 'running' || runtime.state === 'starting') {
        this.setState(id, { quickRuntime: blankQuick({ state: 'stopped' }) });
      }
      return;
    }
    const marker = runtime.marker;
    try {
      await this.withTarget(row, async (target) => {
        const next = await this.cloudflared.inspectQuick(target, runtime);
        this.writeQuickIfSame(id, marker, next);
      });
    } catch {
      this.writeQuickIfSame(id, marker, { ...runtime, state: 'unknown', publicUrl: null });
    }
  }

  /** A slow inspect must not replace a runtime a start or stop wrote in the meantime. */
  private writeQuickIfSame(id: string, marker: string | null, next: QuickRuntime): void {
    const current = coerceQuick(this.getRow(id).quickRuntime);
    if ((current.marker ?? null) !== (marker ?? null)) return;
    this.setState(id, { quickRuntime: next });
  }

  private quickNeedsWatch(runtime: QuickRuntime): boolean {
    return (
      runtime.state === 'running' ||
      runtime.state === 'starting' ||
      runtime.state === 'unknown' ||
      Boolean(runtime.marker)
    );
  }

  private enqueueQuick<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.quickTail.get(id) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(op);
    this.quickTail.set(id, run);
    // finally() rejects again; swallow that copy so a handled conflict is not an unhandled rejection.
    void run
      .finally(() => {
        if (this.quickTail.get(id) === run) this.quickTail.delete(id);
      })
      .catch(() => undefined);
    return run;
  }

  // --- helpers --------------------------------------------------------------

  private async withTarget<T>(
    row: NodeRow,
    fn: (target: Target, exec: CommandExecutor) => Promise<T>,
  ): Promise<T> {
    const exec = await this.ssh.getExecutor(row);
    try {
      const detect = await this.ssh.detect(exec);
      const target: Target = {
        exec,
        os: detect.os,
        arch: detect.arch,
        passwordlessSudo: detect.passwordlessSudo,
      };
      return await fn(target, exec);
    } finally {
      await exec.dispose();
    }
  }

  private applyFacts(
    id: string,
    facts: { os: string | null; arch: string | null; cloudflaredVersion: string | null },
  ): void {
    this.setState(id, {
      os: facts.os,
      arch: facts.arch,
      cloudflaredVersion: facts.cloudflaredVersion,
      lastSeenAt: nowMs(),
    });
  }

  private setState(id: string, patch: Partial<NodeRow>): void {
    this.db
      .update(nodes)
      .set({ ...patch, updatedAt: nowMs() })
      .where(eq(nodes.id, id))
      .run();
  }

  private emitUpdated(id: string): Node {
    const dto = this.get(id);
    this.bus.emit({ type: 'node.updated', node: dto });
    return dto;
  }

  private tunnelNameFor(row: NodeRow): string {
    const slug = row.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    return `puente-${slug || 'node'}-${row.id.slice(-6)}`;
  }
}
