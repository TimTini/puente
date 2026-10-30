import { z } from 'zod';
import { SshConfigSchema, SshTestResultSchema } from './ssh.js';
import { TunnelStatusSchema } from './cloudflare.js';

/** A node is a machine (this PC, or a remote host) that runs a cloudflared connector. */
export const NodeKindSchema = z.enum(['local', 'ssh']);
export type NodeKind = z.infer<typeof NodeKindSchema>;

/** Lifecycle of the connector provisioning on a node. */
export const ProvisionStateSchema = z.enum([
  'unprovisioned', // no tunnel/connector yet
  'provisioning', // install/create in progress
  'provisioned', // tunnel created + connector service installed
  'error',
]);
export type ProvisionState = z.infer<typeof ProvisionStateSchema>;

/** Whether the cloudflared service is installed & running on the node. */
export const ConnectorRunStateSchema = z.enum(['unknown', 'stopped', 'running', 'error']);
export type ConnectorRunState = z.infer<typeof ConnectorRunStateSchema>;

/** Which connector a start/stop/restart applies to. A node can run both at once. */
export const TunnelTypeSchema = z.enum(['named', 'quick']);
export type TunnelType = z.infer<typeof TunnelTypeSchema>;

export const QuickStateSchema = z.enum(['stopped', 'starting', 'running', 'unknown', 'error']);
export type QuickState = z.infer<typeof QuickStateSchema>;

export const QuickTunnelSchema = z.object({
  origin: z.string().nullable(),
  url: z.string().nullable(),
  state: QuickStateSchema,
  startedAt: z.string().nullable(),
  lastError: z.string().nullable(),
});
export type QuickTunnel = z.infer<typeof QuickTunnelSchema>;

const QUICK_ORIGIN_MAX = 2048;

function isDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  return host
    .split('.')
    .every((label) => /^(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]{0,61}[a-zA-Z0-9])$/.test(label));
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Absolute http(s) origin. Credentials, fragments and other protocols are rejected. */
export const QuickOriginSchema = z
  .string()
  .max(QUICK_ORIGIN_MAX)
  .superRefine((value, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    if (hasControlChar(value) || value.includes('\\') || value.includes('#')) {
      fail('Origin must be an absolute http(s) URL.');
      return;
    }
    const match = /^(https?):\/\/([^/?#]+)([^?#]*)(\?[^#]*)?$/.exec(value.trim());
    if (!match || value.trim() !== value) {
      fail('Origin must be an absolute http(s) URL.');
      return;
    }
    const authority = match[2] ?? '';
    if (authority.includes('@')) {
      fail('Origin must not include credentials.');
      return;
    }
    let host = authority;
    let port: string | null = null;
    if (authority.startsWith('[')) {
      const end = authority.indexOf(']');
      const rest = end === -1 ? '' : authority.slice(end + 1);
      host = end === -1 ? '' : authority.slice(1, end);
      if (!host || (rest !== '' && !rest.startsWith(':'))) {
        fail('Origin hostname is invalid.');
        return;
      }
      port = rest.startsWith(':') ? rest.slice(1) : null;
      if (!/^[0-9a-f:.]+$/i.test(host)) {
        fail('Origin hostname is invalid.');
        return;
      }
    } else {
      const colon = authority.lastIndexOf(':');
      if (colon !== -1 && /^\d+$/.test(authority.slice(colon + 1))) {
        host = authority.slice(0, colon);
        port = authority.slice(colon + 1);
      }
      if (!isIpv4(host) && !isDnsName(host)) {
        fail('Origin hostname is invalid.');
        return;
      }
    }
    if (port !== null) {
      const number = Number(port);
      if (!Number.isInteger(number) || number < 1 || number > 65535) {
        fail('Origin port must be between 1 and 65535.');
      }
    }
  });

export const NodeSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: NodeKindSchema,
  ssh: SshConfigSchema.nullable(),
  // Cloudflare tunnel bound to this node (remotely-managed).
  tunnelId: z.string().nullable(),
  tunnelName: z.string().nullable(),
  // State
  provisionState: ProvisionStateSchema,
  connectorRunState: ConnectorRunStateSchema,
  tunnelStatus: TunnelStatusSchema.nullable(),
  serviceInstalled: z.boolean(),
  // Discovered facts
  os: z.string().nullable(),
  arch: z.string().nullable(),
  cloudflaredVersion: z.string().nullable(),
  connectionCount: z.number().int().nullable(),
  lastError: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  quickTunnel: QuickTunnelSchema,
});
export type Node = z.infer<typeof NodeSchema>;

/** Payload to create a node. Local needs no SSH; ssh requires connection details. */
export const CreateNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('local'),
    name: z.string().min(1).max(60),
  }),
  z.object({
    kind: z.literal('ssh'),
    name: z.string().min(1).max(60),
    host: z.string().min(1),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z.string().min(1),
    /** Existing private key path on the control-plane machine (optional). */
    privateKeyPath: z.string().optional(),
    /** Reuse a ~/.ssh/config alias to prefill host/user/port/identity. */
    sshConfigAlias: z.string().optional(),
  }),
]);
export type CreateNodeInput = z.infer<typeof CreateNodeSchema>;

export const UpdateNodeSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).optional(),
  privateKeyPath: z.string().nullable().optional(),
});
export type UpdateNodeInput = z.infer<typeof UpdateNodeSchema>;

export const NodeTestResultSchema = SshTestResultSchema;
export type NodeTestResult = z.infer<typeof NodeTestResultSchema>;

/** Options controlling how a node is provisioned. */
/** Body of POST /nodes/:id/connector/:action. Named and Quick do not share a default. */
export const ConnectorInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('named') }),
  z.object({
    type: z.literal('quick'),
    origin: QuickOriginSchema.optional(),
  }),
]);
export type ConnectorInput = z.infer<typeof ConnectorInputSchema>;

export const ProvisionNodeSchema = z.object({
  /** Install cloudflared as a persistent OS service (recommended). Requires sudo on remote. */
  installService: z.boolean().default(true),
  /** Reuse an existing tunnel by id instead of creating a new one. */
  existingTunnelId: z.string().optional(),
});
export type ProvisionNodeInput = z.infer<typeof ProvisionNodeSchema>;
