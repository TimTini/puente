#!/usr/bin/env node
'use strict';

// One-shot CLI. Dry-run unless --apply. The server does not run this on startup.
// apps/server is CommonJS, so this loads the built module instead of the .ts source.
let runQuickTunnelMigrationCli;
try {
  ({ runQuickTunnelMigrationCli } = require('../dist/db/quick-tunnel-migration.js'));
} catch {
  process.stderr.write('Build the server first: pnpm --filter puente build\n');
  process.exit(1);
}

runQuickTunnelMigrationCli(process.argv.slice(2)).then(
  (code) => {
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
