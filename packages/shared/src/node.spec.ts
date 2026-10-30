import { describe, expect, it } from 'vitest';
import { ConnectorInputSchema, NodeSchema, QuickOriginSchema } from './node';

describe('QuickOriginSchema', () => {
  it.each(['http://127.0.0.1:8080/health?ready=1', 'https://app.internal', 'http://[::1]:3000/a'])(
    'accepts %s',
    (origin) => {
      expect(QuickOriginSchema.safeParse(origin).success).toBe(true);
    },
  );

  it.each([
    'ftp://127.0.0.1',
    'http://user:secret@127.0.0.1',
    'http://127.0.0.1/path#frag',
    'http://127.0.0.1:0/',
    'javascript:alert(1)',
    'http://bad host/',
    'http://127.0.0.1/\n',
    '/relative',
  ])('rejects %s', (origin) => {
    expect(QuickOriginSchema.safeParse(origin).success).toBe(false);
  });
});

describe('ConnectorInputSchema', () => {
  it('requires an explicit type', () => {
    expect(ConnectorInputSchema.safeParse({}).success).toBe(false);
    expect(ConnectorInputSchema.safeParse({ type: 'named' }).success).toBe(true);
    expect(ConnectorInputSchema.safeParse({ type: 'quick' }).success).toBe(true);
    expect(
      ConnectorInputSchema.safeParse({ type: 'quick', origin: 'http://localhost:8080' }).success,
    ).toBe(true);
  });
});

describe('NodeSchema', () => {
  it('carries quick tunnel state and not process identity', () => {
    const parsed = NodeSchema.parse({
      id: 'node_1',
      name: 'box',
      kind: 'local',
      ssh: null,
      tunnelId: null,
      tunnelName: null,
      provisionState: 'unprovisioned',
      connectorRunState: 'unknown',
      tunnelStatus: null,
      serviceInstalled: false,
      os: null,
      arch: null,
      cloudflaredVersion: null,
      connectionCount: null,
      lastError: null,
      lastSeenAt: null,
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z',
      quickTunnel: {
        origin: 'http://127.0.0.1:8080',
        url: null,
        state: 'stopped',
        startedAt: null,
        lastError: null,
      },
    });
    expect(parsed.quickTunnel.origin).toBe('http://127.0.0.1:8080');
    expect(JSON.stringify(parsed)).not.toContain('pid');
    expect(JSON.stringify(parsed)).not.toContain('marker');
  });
});
