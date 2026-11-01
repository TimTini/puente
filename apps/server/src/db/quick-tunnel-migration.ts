import { mkdirSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import Database from 'better-sqlite3';

/** Columns a database from before Quick Tunnel does not have. Nullable; named data stays put. */
export const QUICK_TUNNEL_COLUMNS = ['quick_origin', 'quick_runtime'] as const;

export interface MigrationIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const consoleIo: MigrationIo = {
  log: (line) => process.stdout.write(`${line}\n`),
  error: (line) => process.stderr.write(`${line}\n`),
};

export function missingQuickColumns(sqlite: Database.Database): string[] {
  const rows = sqlite.prepare(`PRAGMA table_info(nodes)`).all() as { name: string }[];
  if (rows.length === 0) return [...QUICK_TUNNEL_COLUMNS];
  const present = new Set(rows.map((row) => row.name));
  return QUICK_TUNNEL_COLUMNS.filter((column) => !present.has(column));
}

/**
 * Startup only reports this. It does not add the columns: that is the one-shot script.
 */
export function assertQuickTunnelSchema(sqlite: Database.Database): void {
  const missing = missingQuickColumns(sqlite);
  if (missing.length === 0) return;
  throw new Error(
    `This database is missing Quick Tunnel columns (${missing.join(', ')}). ` +
      `Stop puente and run: node apps/server/scripts/migrate-quick-tunnel.cjs --db "<path>" ` +
      `then the same command with --apply. Startup does not change this schema.`,
  );
}

export function assertDatabaseAvailable(sqlite: Database.Database): void {
  sqlite.pragma('busy_timeout = 200');
  try {
    sqlite.exec('BEGIN EXCLUSIVE');
    sqlite.exec('ROLLBACK');
  } catch {
    throw new Error('Database is in use. Stop puente, then re-run with --apply.');
  }
}

export function isUncPath(file: string): boolean {
  return file.startsWith('\\\\') || file.startsWith('//');
}

/**
 * Adds the Quick Tunnel columns inside one transaction.
 * `onBeforeCommit` is how tests force a rollback; the CLI never sets it.
 */
function inUse(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /locked|busy|in use/i.test(message);
}

export async function applyQuickTunnelMigration(
  sqlite: Database.Database,
  backupPath: string,
  opts: { onBeforeCommit?: () => void } = {},
): Promise<string[]> {
  sqlite.pragma('busy_timeout = 200');
  let missing: string[];
  try {
    missing = missingQuickColumns(sqlite);
  } catch (err) {
    if (inUse(err)) {
      throw new Error('Database is in use. Stop puente, then re-run with --apply.', { cause: err });
    }
    throw err;
  }
  if (missing.length === 0) return [];
  try {
    assertDatabaseAvailable(sqlite);
    mkdirSync(dirname(backupPath), { recursive: true });
    await sqlite.backup(backupPath);
  } catch (err) {
    if (inUse(err)) {
      throw new Error('Database is in use. Stop puente, then re-run with --apply.', { cause: err });
    }
    throw err;
  }
  const run = sqlite.transaction(() => {
    for (const column of missing) {
      sqlite.exec(`ALTER TABLE nodes ADD COLUMN ${column} TEXT`);
    }
    opts.onBeforeCommit?.();
  });
  try {
    run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Migration rolled back. Backup kept at ${backupPath}. ${message}`, {
      cause: err,
    });
  }
  return missing;
}

function defaultDbPath(): string {
  const root = process.env.PUENTE_DATA_DIR || join(homedir(), '.puente');
  return join(root, 'data.db');
}

function readArgs(argv: string[]): { db: string; apply: boolean; help: boolean } {
  let db = defaultDbPath();
  let apply = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { db, apply: false, help: true };
    if (arg === '--apply') {
      apply = true;
      continue;
    }
    if (arg === '--db') {
      const value = argv[++i];
      if (!value) throw new Error('--db needs a path.');
      db = value;
      continue;
    }
    throw new Error(`Unknown argument ${arg}.`);
  }
  return { db, apply, help: false };
}

/** Dry-run unless `--apply`. Returns a process exit code. */
export async function runQuickTunnelMigrationCli(
  argv: string[],
  io: MigrationIo = consoleIo,
): Promise<number> {
  let args: { db: string; apply: boolean; help: boolean };
  try {
    args = readArgs(argv);
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
  if (args.help) {
    io.log(
      'Usage: migrate-quick-tunnel.cjs [--db <path>] [--apply]\n' +
        'Default is a dry-run. --apply writes a SQLite backup, then adds the columns.',
    );
    return 0;
  }
  if (isUncPath(args.db)) {
    io.error(
      'Refusing to open a database over SMB. Copy it to a local disk, stop puente, and retry.',
    );
    return 1;
  }
  const file = isAbsolute(args.db) ? args.db : resolve(args.db);
  if (!existsSync(file)) {
    io.error(`Database not found: ${file}`);
    return 1;
  }
  const sqlite = new Database(file, { readonly: !args.apply, fileMustExist: true });
  try {
    const missing = missingQuickColumns(sqlite);
    if (missing.length === 0) {
      io.log(`schema: Quick Tunnel columns already present (${file})`);
      io.log('action: none');
      return 0;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${file}.quick-tunnel-${stamp}.bak`;
    if (!args.apply) {
      io.log(`database: ${file}`);
      io.log(`missing: ${missing.join(', ')}`);
      io.log(`would backup to: ${backupPath}`);
      io.log('would add nullable columns; named tunnels, routes and credentials are not modified');
      io.log('dry-run: no changes written');
      return 0;
    }
    const added = await applyQuickTunnelMigration(sqlite, backupPath);
    io.log(`backup: ${backupPath}`);
    io.log(`added: ${added.join(', ')}`);
    return 0;
  } catch (err) {
    io.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    sqlite.close();
  }
}
