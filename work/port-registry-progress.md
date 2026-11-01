# Port registry integration

## Scope and decisions

- Owner scope: Puente startup/CLI/Vite port selection, focused tests, and docs; no web app or nodes module edits.
- Registry contract: `PUENTE_PORT` > `PORT` > role-specific port in `ports.json` > legacy fallback. Explicit CLI `--port` bypasses registry lookup. `PUENTE_PORT_REGISTRY` selects an explicit registry file; otherwise discover `port-registry/ports.json` beside the `MyGitProject` directory containing the checkout. Missing registry keeps legacy defaults; malformed or internally conflicting existing registry errors clearly.
- Registry rows use `repo: puente` and exact notes `Puente dashboard` / `Puente web dev` to distinguish roles. Reserve dashboard 5006 and web dev 5173 on Windows and Mac. Existing Puente listeners on both ports remain untouched.
- No commits, push, restart, or deploy.

## Progress

1. Inspected CLI/main/Vite defaults, tests, Windows and Mac registries/listeners, and verified current Windows Vite and Mac dashboard listeners belong to Puente.
2. Added resolver tests first; implemented shared strict registry lookup and wired CLI/main/Vite. Added role rows to both host registries and documented overrides/discovery.
3. Focused checks complete: 7 resolver tests pass; server build-source TypeScript check passes; web TypeScript check passes; Vite production build succeeds; Prettier and `git diff --check` pass.
4. Independent review found restart stopped the daemon before validating an explicit port. Moved restart preflight into `cli-restart.ts`, so port/host resolve before the stop callback; regression test confirms an invalid port never invokes stop. Focused Vitest now passes 8/8.

## Evidence

- Windows registry initially had only `coinglass-api:18432`; Mac registry was empty.
- Windows Puente Vite process on 5173; Mac Puente foreground server on 5006. Root independently confirmed Windows 5173 serves Puente.
- Final registry rows on both hosts: `puente:5006` (`Puente dashboard`) and `puente:5173` (`Puente web dev`). Windows keeps `coinglass-api:18432` unchanged.
- No live process was restarted. Mac 5006 remained PID 49898 during final inspection.
