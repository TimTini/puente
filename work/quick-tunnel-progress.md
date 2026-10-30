# Quick Tunnel progress

Branch: `feat/quick-tunnel`. Base: `cf66c46e78780a2b933d39daf663ed2158b3a351` (matches the plan baseline; no source drift before implementation).

## Decisions

- One node keeps the named connector and at most one Quick Tunnel. `type` is on the connector command, not on the node.
- Runtime identity (pid, marker, dir) stays in `nodes.quick_runtime`. The API exposes origin, url, state, startedAt, lastError. URL is returned only while state is `running`.
- Ownership is `pgrep -x cloudflared` plus the marker in that pid's args. Named cleanup skips args containing `/puente-quick/` before `tunnel run`.
- Quick flags, from Cloudflare's current tunnel run parameters (the installer is not version-pinned): `tunnel --no-autoupdate --config --logfile --pidfile --url`. Empty config so a named config is not read. No `--metrics`.
- Server start quarantines `running`/`starting` to `unknown` and clears the URL. It does not spawn. Adopt happens on poll, refresh, or start.
- Per-node promise chain serializes start/stop/restart/delete. A slow inspect writes back only if the marker is still the one it read. Start refuses while a marker is still tracked and the state is not `stopped`.
- Migration is `apps/server/scripts/migrate-quick-tunnel.cjs`, which loads `dist/db/quick-tunnel-migration.js`. `node --experimental-strip-types` cannot import that module: `apps/server` is CommonJS. Dry-run by default. `--apply` backups, then `ALTER` in one transaction. Startup only asserts the columns.
- Fleet passes `{ type: 'named' }`. No other `ee/` change.
- `ready` is unchanged. The dashboard is gated on an admin, not on a Cloudflare token.

## Evidence

- `corepack pnpm lint`, `corepack pnpm -r typecheck`, shared/web/server builds: exit 0.
- `corepack pnpm exec vitest run`: 26 files passed, 1 skipped; 230 passed, 10 skipped. Re-run after review fixes: quick, migration, node, and cloudflared specs passed (3 Linux `pgrep -f` tests skipped on this Windows host).
- Migration CLI on a temp DB: dry-run wrote nothing; `--apply` added `quick_origin` and `quick_runtime`, kept `tunnel_token_enc`; second run was a no-op.

## Review

Independent read-only review. Fixed: stale inspect no longer overwrites a newer runtime; Start does not spawn while a marker is still tracked; delete joins the per-node queue and ignores a start that arrives during deletion; stop re-checks the marker in the kill command; more than one match keeps the marker.

Left as a limit: named stop still signals every `cloudflared tunnel run` that is not under `/puente-quick/`. That argv is how the existing named connector is identified, including one the user started themselves. Quick stop does not use that path.

## Not run

- Linux, macOS, SSH, Docker origin, and a public trycloudflare URL: `not_run`. This host is Windows. WSL cannot mount its disk. No live `cloudflared`, no Cloudflare resource calls.
- Playwright `e2e/01-setup.spec.ts`, `e2e/14-connector-state.spec.ts`, and a Quick browser fixture: `not_run`. The webServer command uses `rm` and the connector fixture needs Linux `pgrep`.
- GNU `pgrep -f` self-match proof: `not_run` here (`it.skipIf(process.platform !== 'linux')`). It still runs on Linux CI.

## Next

Push and a live check only after an explicit request. On a Linux or macOS host, run the skipped shell specs and one fake-`cloudflared` lifecycle through local and SSH.
