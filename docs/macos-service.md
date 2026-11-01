# Run Puente as a macOS LaunchDaemon

Use the system LaunchDaemon when the dashboard must start at boot without a user logging in. The job runs as the normal account `v`; only the installer and launchd job management require administrator access.

## Before installation

1. Build and stage the release under a non-hidden directory such as `runtime/releases/<revision>`. Copy `apps/server/package.json` beside `dist/` so the release retains its CommonJS metadata and version. Confirm `dist/cli.js` exists and that the checkout has `apps/server/node_modules` and `node_modules`. A hidden release path (for example `.puente/releases`) causes Express SPA deep links to fail even when `/` succeeds; the installer rejects it.
2. Confirm the absolute Node executable is Node.js 24 and readable/executable by `v`.
3. Confirm `/Users/v/MyGitProject/puente/.puente/dashboard` is the existing Puente data directory. The installer only creates `/Users/v/MyGitProject/puente/.puente/dashboard/service/logs` and gives that log directory to `v`.
4. Confirm the local `port-registry/ports.json` has the `puente` row with note `Puente dashboard` and port `5006`. The daemon intentionally omits `--port`; Puente resolves the dashboard port from that registry.
5. Inspect the current listener on 5006. If the current Puente panel is still running, record its PID and pass it as `--previous-panel-pid` during the authorized installation. The installer validates that exact PID, owner, command line, and sole 5006 listener before sending it `SIGTERM`; it never selects a process by port alone.

The install script validates all paths and the Node 24 installation path, writes a temporary plist, runs `plutil -lint`, backs up an existing plist with a UTC timestamp, and stages the new root-owned plist. After linting, `--previous-panel-pid` permits a graceful `SIGTERM` to that verified Puente process. If its `io.puente.dashboard` LaunchDaemon is loaded, the installer first boots out only that label so `KeepAlive` cannot respawn the panel; it then sends `SIGTERM` only if the verified PID remains. If 5006 is occupied and no PID is supplied, installation stops with an error. It atomically installs the new plist, then bootstraps and kickstarts the job. It does not change sudoers, request or store a password, or stop an unrelated process.

## Install

Run from the repository root with administrator authorization. Pass the verified staged release and absolute Node 24 path:

```bash
bash scripts/install-macos-daemon.sh \
  --user v \
  --repo-root /Users/v/MyGitProject/puente \
  --release-dir /Users/v/MyGitProject/puente/runtime/releases/20261101-e0d9bb9 \
  --node /Users/v/.nvm/versions/node/v24.15.0/bin/node \
  --data-dir /Users/v/MyGitProject/puente/.puente/dashboard \
  --previous-panel-pid "$PREVIOUS_PANEL_PID"
```

The release directory above is the staged version and must contain `dist/cli.js`. The example Node version/path must match the installed runtime. `--repo-root` defaults to the checkout containing this script, `--user` defaults to `v`, and `--data-dir` defaults to `<repo-root>/.puente/dashboard`. `--release-dir` and `--node` are required. Omit `--previous-panel-pid` only when port 5006 is free. The script itself requires root and does not invoke `sudo`; use the system administrator prompt for authorization. A non-interactive `sudo -n true` failure means authorization is unavailable and must be handled by the administrator, without adding sudoers rules.

The resulting plist is `/Library/LaunchDaemons/io.puente.dashboard.plist`, owned by `root:wheel` with mode `0644`. It runs:

```text
<absolute Node 24> <release>/dist/cli.js start --foreground --no-open --host 0.0.0.0
```

The job uses the checkout as its working directory, the checkout's server/root `node_modules` through `NODE_PATH`, and `PUENTE_DATA_DIR=/Users/v/MyGitProject/puente/.puente/dashboard`. Standard output and error go to `/Users/v/MyGitProject/puente/.puente/dashboard/service/logs/`.

## Verify

```bash
sudo launchctl print system/io.puente.dashboard
sudo plutil -lint /Library/LaunchDaemons/io.puente.dashboard.plist
sudo stat -f '%Su:%Sg %Lp %N' /Library/LaunchDaemons/io.puente.dashboard.plist
lsof -nP -iTCP:5006 -sTCP:LISTEN
curl -fsS -o /dev/null -w 'HTTP %{http_code}\n' http://127.0.0.1:5006/
tail -n 80 /Users/v/.puente/service/logs/stderr.log
```

Check that launchd reports the job running, the plist is `root:wheel 644`, the listener belongs to the launchd-managed Node command, and the dashboard responds with HTTP 200. A successful TCP listener alone does not verify application readiness.

## Roll back

The installer prints the path of any prior plist backup, such as `/Library/LaunchDaemons/io.puente.dashboard.plist.bak.20261101T120000Z`.

To unload the installed job and restore that backup:

```bash
sudo launchctl bootout system/io.puente.dashboard
sudo plutil -lint /Library/LaunchDaemons/io.puente.dashboard.plist.bak.TIMESTAMP
sudo install -o root -g wheel -m 0644 \
  /Library/LaunchDaemons/io.puente.dashboard.plist.bak.TIMESTAMP \
  /Library/LaunchDaemons/io.puente.dashboard.restore
sudo mv -f /Library/LaunchDaemons/io.puente.dashboard.restore \
  /Library/LaunchDaemons/io.puente.dashboard.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/io.puente.dashboard.plist
sudo launchctl kickstart system/io.puente.dashboard
```

If there was no previous plist, unload the job and remove the installed plist. Restoring a plist does not restore release files or application data; keep the previous staged release and the existing `/Users/v/.puente` data intact until the rollback is verified.
