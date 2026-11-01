# Routes fixes, browser performance, and port registry

Base: `85091bb` on `main`. Scope authorized 2026-11-01: fix two reviewed route bugs, investigate browser slowdown, register/use ports on Windows and macOS.

## Plan

1. Add regression checks; separate Quick removal from stop and validate named-route node selection.
2. Profile frontend with isolated fixtures; fix confirmed causes and compare measurements.
3. Inspect per-host port registries, reserve Puente ports without touching other entries, integrate startup lookup and test conflicts.
4. Independent read-only review, targeted tests/typecheck/lint/build/browser checks, scoped commits and push.

## Evidence

- Initial working tree clean at `85091bb`.
- Previous review reproduced Remove calling Stop and retaining origin; domain form submitted an unprovisioned node.
- No production restart, live SQLite changes, or Cloudflare resource changes authorized as part of smoke testing.
- Workers: frontend performance investigation and scoped live-update fix; port registry integration (startup/config only). Root owns route fixes and integration.

## Status

Route fixes, live-update render regression, registry integration, measured scroll fix, Mac deployment and system LaunchDaemon installation verified. No whole-machine reboot was performed.

## Frontend performance checkpoint — 2026-11-01

- `apps/web/src/lib/live.tsx`: replaced the shared progress object in `LiveContext` with a stable per-scope external store and `useSyncExternalStore`. `Shell` now consumes only connection state; node cards subscribe only to `node:<id>` progress.
- Regression: `node e2e/perf-live-progress.mjs` uses local Playwright and `.puente/browsers` Chromium, mocks `/api/**` plus EventSource, and instruments 20 rendered NodeCards. Against the original `live.tsx`, one `node-0` event rerendered all other 19 cards (RED). After the scoped subscription, target delta was 2 renders under React StrictMode, unrelated delta 0 (GREEN). No backend, credentials, Cloudflare, or persistent app data used.
- Validation: `node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json` passed; Prettier check passed for `live.tsx` and `e2e/perf-live-progress.mjs`.
- Initial CSS trace used the wrong scroll container and was discarded; see the corrected measurement below. Authenticated real-backend and GPU profiling remain unverified.
- Reproduction: start Vite in `apps/web` with `node.exe node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5199 --strictPort`, then from repo root run `node.exe e2e/perf-live-progress.mjs`. Set `PUENTE_WEB_URL` or `PUENTE_CHROMIUM_EXECUTABLE` only when using an alternate local fixture/browser path.

### CSS profile correction — 2026-11-01

- The initial scroll trace used `window.scrollTo`, but the page scrolls in Shell's `<main>` container. Those initial Paint/RasterTask values were invalid and should be disregarded.
- `e2e/perf-live-progress.mjs` now scrolls `main.scrollTop`, asserts that the fixture overflows, warms both variants, and records three equivalent CDP traces per variant. On this 20-card Windows headless Chromium fixture: card blur enabled yielded 140 RasterTask / 16.26–16.40 ms each; card blur disabled yielded 360 RasterTask / 115.93–147.18 ms each. Paint events were 0 in both variants. The synthetic headless comparison does not generalize to hardware/GPU conditions; it gives no basis for a CSS removal, so styles remain unchanged.
- The browser path now comes from repo-local `PLAYWRIGHT_BROWSERS_PATH=.puente/browsers`; `PUENTE_CHROMIUM_EXECUTABLE` is optional for an alternate installed browser.

### Scroll profile and CSS change — 2026-11-01

- User clarified the slowdown occurs while scrolling Nodes or Settings. The benchmark injected variants after navigation and alternated the real main `scrollTop` for 60 RAFs, two passes per variant, with CDP CPU sampling. Headless Chromium 151 at 1920x1280 CSS, DPR1; API and SSE are local fixtures.
- Before source changes, Nodes (20 fixture cards, 22 filtered regions, 4.21M summed filtered px) measured baseline p50 83.3ms / p95 83.5–100ms; cards-only blur off 66.6ms; all blur off 16.7ms. Settings (11 cards, 13 filtered regions, 4.84M summed filtered px) measured baseline p50 83.4ms / p95 100.1ms; cards-only blur off 50–66.6ms; all blur off 16.7ms. Two passes were consistent.
- Removed backdrop blur from the shared Card, outer Shell frame, and sticky header; translucent fills, borders, and shadows remain. Post-change baseline on both pages reported 0 filtered regions, p50/p95 16.7ms and 0 of 59 intervals over 20ms for each of two passes.
- CDP samples attributed 0–46 samples to app/dependency JS and one sample to AdGuard across roughly 650–3,500 native/unknown samples per run; this does not support attributing the scroll slowdown to AdGuard or React work. Headless fixture measurements do not establish the exact improvement on physical GPU or live data set; DPR2 was not run.
- `e2e/perf-scroll.mjs` is diagnostic only. The committed progress regression remains `e2e/perf-live-progress.mjs`.

## Integration checkpoint

- Commits pushed to `personal/main`: `e2e44fb` route fixes, `61ec6c4` scoped progress updates, `3d29622` registry integration.
- Root verification: 28 Vitest files / 249 tests passed, 3 POSIX-specific tests skipped on Windows; Cloudflare live spec explicitly excluded. Server/web typechecks, changed-file lint, shared/server/web builds passed. Two mocked browser regressions passed. Real isolated Windows server DELETE smoke returned HTTP 200 with stopped/origin-null; no Cloudflare calls or user data involved.
- Compiled registry resolver executed on Windows and over SSH on macOS: dashboard 5006, web dev 5173 on both.
- Registry commit `102163a` pushed to `TimTini/port-registry`; only the two Puente rows staged. Windows pre-existing CoinGlass row and modified scanner remain outside that commit.
- Mac registry rows applied and verified; Git fast-forward was aborted because its local `ports.json` is modified. Other existing Mac registry changes were preserved; do not reset/stash them.
- Mac production HTTP 200, PID 49898 unchanged. No production restart or deployment performed.

## Mac deployment checkpoint

- User explicitly authorized deployment and boot startup without login; no whole-machine reboot requested.
- Release `e0d9bb9` staged at `/Users/v/MyGitProject/puente/.puente/releases/20261101-e0d9bb9`; isolated Mac candidate boot/HTTP/CSS smoke passed on 5129 using Node v24.15.0, then stopped.
- Consistent SQLite backup, keys, daemon state and previous dist at `/Users/v/MyGitProject/puente/.puente/deploy-backups/20261101-e0d9bb9`. Counts before cutover: 1 user, 1 workspace, 1 node, 1 static route.
- Existing panel PID 49898 verified as v's absolute Puente CLI, sole 5006 listener. No existing Puente LaunchDaemon/LaunchAgent found. Existing connector processes are outside the panel cutover.
- `sudo -n true` requires a password. Prepared root-only installer and runbook; native macOS admin authentication is required to install `/Library/LaunchDaemons/io.puente.dashboard.plist`. No password is requested through chat or stored.
- Installer shell syntax checked on Mac and independently reviewed. PID owner/command/port ownership checks run before any signal; job runs as v in the system launchd domain, with the existing data directory and port registry.
- Native administrator request failed with macOS -60007. The staged installer has not been run as root; LaunchDaemon installation remains pending user authentication.
- Live cutover used the documented Puente CLI stop/start. An initial hidden release directory caused SPA deep links to return 404; root traced this to absolute `sendFile` under a dot directory, relocated the release to `/Users/v/MyGitProject/puente/runtime/releases/20261101-e0d9bb9`, and re-tested `/`, `/nodes`, `/settings` on a Mac candidate before switching. No application/vendor workaround was added. Runtime directory ignored by Git; installer rejects hidden release paths.
- Live release now runs detached under v, PID 63401, port 5006, version 0.3.0. Root HTTP checks for `/`, `/nodes`, `/settings`, and `/api/setup/status` all returned 200. Real Brave Settings retained the login session and showed the new CSS asset with zero backdrop filters.
- Ready admin handoff: `ssh -t vmac "/bin/bash /Users/v/MyGitProject/puente/runtime/releases/20261101-e0d9bb9/enable-autostart.command"`. Helper reads the live listener PID and invokes only the reviewed installer through interactive sudo. No password in files or chat.

## Shutdown fix and final admin handoff

- First user-run sudo install passed authentication/plist lint, then stopped before installing because the old panel PID stayed alive after SIGTERM. Port and daemon state had already closed. Root confirmed it was not a zombie; closing the agent's live browser tab made the old PID exit, identifying a persistent SSE connection as the blocker.
- Added `StreamController.onModuleDestroy` with `takeUntil` to complete active streams and cancel heartbeat subscriptions. Regression was RED before and GREEN after; independent review found no blocker. Full offline suite now 29 files / 250 tests passed, 3 POSIX-specific skips; Cloudflare live spec excluded.
- A first synthetic unread-response probe exceeded its 3-second deadline; the normal continuously-reading SSE probe confirmed response EOF immediately and Mac child exit in 6 ms after SIGTERM. No force kill added to the installer.
- Live release moved to `/Users/v/MyGitProject/puente/runtime/releases/20261101-35f3afa`, manual background PID 64236 at the checkpoint. All user/workspace/node/static-route counts remain 1. The old helper path above now targets this fixed release, so the user can repeat the same command.
- Installer has NOT yet completed: no `/Library/LaunchDaemons/io.puente.dashboard.plist` and no system job at the latest check. Awaiting the user to rerun interactive sudo. Do not claim boot/login independence until `launchctl print system/io.puente.dashboard`, plist ownership and HTTP readiness are verified.
- Source pushed to personal/main through `e81dab4`; concurrent upstream fixes and upgrade-test changes were merged without overwrite. No whole-machine reboot performed.

## Completed Mac activation

- User reran the prepared sudo helper successfully after the SSE fix.
- Root independently verified `system/io.puente.dashboard` is running: launchd PID 64551 exactly matches the TCP 5006 listener. Process user v, PPID 1; plist `/Library/LaunchDaemons/io.puente.dashboard.plist` is root:wheel 0644, RunAtLoad=true, KeepAlive=true.
- Program points at Node v24.15.0 and `runtime/releases/20261101-35f3afa/dist/cli.js`, with the existing `.puente/dashboard` data directory and role-based port registry.
- HTTP `/`, `/nodes`, `/settings`, `/api/setup/status` all 200. Real Brave login session retained; Settings displays v0.3.0 and computes zero backdrop filter regions. Dashboard tab left open for the user.
- Service runs in the system LaunchDaemon domain, not a login LaunchAgent. FileVault is off. Actual full reboot/logout test not performed; no claim of an observed post-reboot result.
- Latest offline verification: 29 files / 250 passing tests, 3 POSIX skips on Windows. Production app data counts preserved at one user/workspace/node/static route. Backups and previous release retained.
