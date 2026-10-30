import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  applyQuickTunnelMigration,
  assertQuickTunnelSchema,
  missingQuickColumns,
  runQuickTunnelMigrationCli,
} from './quick-tunnel-migration';

const TOKEN = 'enc:named-token-must-stay';

const LEGACY = `
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  tunnel_id TEXT,
  tunnel_token_enc TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE routes (
  id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  hostname TEXT NOT NULL,
  dns_record_id TEXT
);
`;

function legacyFile(): { dir: string; file: string; db: Database.Database } {
  const dir = mkdtempSync(join(tmpdir(), 'puente-quick-migrate-'));
  const file = join(dir, 'data.db');
  const db = new Database(file);
  db.exec(LEGACY);
  db.prepare(
    `INSERT INTO nodes (id, name, kind, tunnel_id, tunnel_token_enc, created_at, updated_at)
     VALUES ('node_1', 'box', 'ssh', 'tun_1', ?, 1, 1)`,
  ).run(TOKEN);
  db.prepare(
    `INSERT INTO routes (id, node_id, hostname, dns_record_id) VALUES ('r1', 'node_1', 'app.example.com', 'dns_1')`,
  ).run();
  return { dir, file, db };
}

const opened: Database.Database[] = [];
afterEach(() => {
  for (const db of opened) {
    try {
      db.close();
    } catch {
      /* closed */
    }
  }
  opened.length = 0;
});

describe('quick tunnel migration', () => {
  it('keeps named rows on apply, and a second apply does nothing', async () => {
    const { file, db } = legacyFile();
    opened.push(db);
    const backup = `${file}.bak`;
    const added = await applyQuickTunnelMigration(db, backup);
    expect(added).toEqual(['quick_origin', 'quick_runtime']);
    const token = db.prepare(`SELECT tunnel_token_enc AS token FROM nodes`).get() as {
      token: string;
    };
    expect(token.token).toBe(TOKEN);
    const route = db.prepare(`SELECT hostname, dns_record_id AS dns FROM routes`).get() as {
      hostname: string;
      dns: string;
    };
    expect(route).toEqual({ hostname: 'app.example.com', dns: 'dns_1' });
    expect(await applyQuickTunnelMigration(db, `${file}.bak2`)).toEqual([]);
    const copy = new Database(backup, { readonly: true });
    opened.push(copy);
    expect(
      (copy.prepare(`SELECT tunnel_token_enc AS token FROM nodes`).get() as { token: string })
        .token,
    ).toBe(TOKEN);
    expect(missingQuickColumns(copy)).toEqual(['quick_origin', 'quick_runtime']);
  });

  it('rolls back when the write fails and keeps the backup', async () => {
    const { file, db } = legacyFile();
    opened.push(db);
    const backup = `${file}.bak`;
    await expect(
      applyQuickTunnelMigration(db, backup, {
        onBeforeCommit: () => {
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow(/rolled back/);
    expect(missingQuickColumns(db)).toEqual(['quick_origin', 'quick_runtime']);
    const copy = new Database(backup, { readonly: true });
    opened.push(copy);
    expect(
      (copy.prepare(`SELECT tunnel_token_enc AS token FROM nodes`).get() as { token: string })
        .token,
    ).toBe(TOKEN);
  });

  it('refuses a database another process is writing', async () => {
    const { file, db } = legacyFile();
    opened.push(db);
    db.exec('BEGIN EXCLUSIVE');
    const other = new Database(file);
    opened.push(other);
    await expect(applyQuickTunnelMigration(other, `${file}.bak`)).rejects.toThrow(/in use/);
    db.exec('ROLLBACK');
  });

  it('dry-run writes nothing and does not print the stored token', async () => {
    const { file, db } = legacyFile();
    opened.push(db);
    db.close();
    const lines: string[] = [];
    const code = await runQuickTunnelMigrationCli(['--db', file], {
      log: (line) => lines.push(line),
      error: (line) => lines.push(line),
    });
    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('dry-run');
    expect(lines.join('\n')).not.toContain(TOKEN);
    const check = new Database(file, { readonly: true });
    opened.push(check);
    expect(missingQuickColumns(check)).toEqual(['quick_origin', 'quick_runtime']);
  });

  it('refuses an SMB path and tells a running server which command to use', async () => {
    const lines: string[] = [];
    const code = await runQuickTunnelMigrationCli(
      ['--db', '\\\\server\\share\\data.db', '--apply'],
      {
        log: (line) => lines.push(line),
        error: (line) => lines.push(line),
      },
    );
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('SMB');

    const memory = new Database(':memory:');
    opened.push(memory);
    memory.exec(LEGACY);
    expect(() => assertQuickTunnelSchema(memory)).toThrow(/migrate-quick-tunnel/);
    expect(missingQuickColumns(memory)).toEqual(['quick_origin', 'quick_runtime']);
  });
});
