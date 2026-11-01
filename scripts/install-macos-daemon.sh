#!/bin/bash
set -euo pipefail

label='io.puente.dashboard'
plist="/Library/LaunchDaemons/$label.plist"
runtime_user='v'
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
release_dir=''
node_bin=''
data_dir=''
previous_panel_pid=''

usage() {
  cat <<'EOF'
Usage: install-macos-daemon.sh --release-dir DIR --node ABSOLUTE_NODE [options]

Options:
  --user USER          Runtime account (default: v)
  --repo-root DIR      Checkout root (default: parent of this script)
  --release-dir DIR    Directory containing dist/cli.js (required)
  --node PATH          Absolute Node.js 24 executable (required)
  --data-dir DIR       Existing Puente data directory (default: REPO/.puente/dashboard)
  --previous-panel-pid PID  Stop only this verified Puente listener on TCP 5006
EOF
}

while (($#)); do
  case "$1" in
    --user) runtime_user="${2:?missing value for --user}"; shift 2 ;;
    --repo-root) repo_root="${2:?missing value for --repo-root}"; shift 2 ;;
    --release-dir) release_dir="${2:?missing value for --release-dir}"; shift 2 ;;
    --node) node_bin="${2:?missing value for --node}"; shift 2 ;;
    --data-dir) data_dir="${2:?missing value for --data-dir}"; shift 2 ;;
    --previous-panel-pid) previous_panel_pid="${2:?missing value for --previous-panel-pid}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == 'Darwin' ]] || { echo 'This installer only supports macOS.' >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run this installer as root; it does not invoke sudo or alter sudoers.' >&2; exit 1; }
[[ -n "$release_dir" && -n "$node_bin" ]] || { usage >&2; exit 2; }
[[ "$node_bin" == /* && -x "$node_bin" ]] || { echo '--node must be an executable absolute path.' >&2; exit 1; }
node_version_dir="$(basename "$(dirname "$(dirname "$node_bin")")")"
[[ "$node_version_dir" =~ ^v24\.[0-9]+\.[0-9]+$ ]] || {
  echo '--node must be inside a Node.js v24.x.y installation directory.' >&2
  exit 1
}
id "$runtime_user" >/dev/null 2>&1 || { printf 'Runtime user does not exist: %s\n' "$runtime_user" >&2; exit 1; }
[[ -d "$repo_root" ]] || { printf 'Repository root not found: %s\n' "$repo_root" >&2; exit 1; }
[[ -d "$release_dir" ]] || { printf 'Release directory not found: %s\n' "$release_dir" >&2; exit 1; }
[[ -f "$release_dir/dist/cli.js" ]] || { printf 'Puente CLI not found: %s/dist/cli.js\n' "$release_dir" >&2; exit 1; }
[[ -d "$repo_root/apps/server/node_modules" && -d "$repo_root/node_modules" ]] || {
  echo 'Expected repo/apps/server/node_modules and repo/node_modules for NODE_PATH.' >&2
  exit 1
}

repo_root="$(cd "$repo_root" && pwd)"
release_dir="$(cd "$release_dir" && pwd)"
[[ "$release_dir" != */.* ]] || {
  echo 'Stage the release outside hidden directories so SPA deep links can be served.' >&2
  exit 1
}
data_dir="${data_dir:-$repo_root/.puente/dashboard}"
[[ "$data_dir" == /* && -d "$data_dir" ]] || {
  printf 'Data directory must be an existing absolute path: %s\n' "$data_dir" >&2
  exit 1
}
user_group="$(id -gn "$runtime_user")"
node_dir="$(dirname "$node_bin")"
node_path="$node_dir:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
node_path_module="$repo_root/apps/server/node_modules:$repo_root/node_modules"
logs_dir="$data_dir/service/logs"

tmp_plist="$(/usr/bin/mktemp "$plist.tmp.XXXXXX")"
tmp_staged=''
cleanup() {
  [[ -z "$tmp_plist" || ! -e "$tmp_plist" ]] || /bin/rm -f "$tmp_plist"
  [[ -z "$tmp_staged" || ! -e "$tmp_staged" ]] || /bin/rm -f "$tmp_staged"
}
trap cleanup EXIT

xml_escape() {
  local value="$1"
  value="${value//&/\&amp;}"
  value="${value//</\&lt;}"
  value="${value//>/\&gt;}"
  value="${value//\"/\&quot;}"
  value="${value//\'/\&apos;}"
  printf '%s' "$value"
}

node_path_xml="$(xml_escape "$node_bin")"
cli_path_xml="$(xml_escape "$release_dir/dist/cli.js")"
repo_root_xml="$(xml_escape "$repo_root")"
runtime_user_xml="$(xml_escape "$runtime_user")"
logs_dir_xml="$(xml_escape "$logs_dir")"
node_path_env_xml="$(xml_escape "$node_path")"
node_path_module_xml="$(xml_escape "$node_path_module")"
data_dir_xml="$(xml_escape "$data_dir")"
cat >"$tmp_plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>$label</string>
<key>ProgramArguments</key><array>
<string>$node_path_xml</string><string>$cli_path_xml</string><string>start</string>
<string>--foreground</string><string>--no-open</string><string>--host</string><string>0.0.0.0</string>
</array>
<key>WorkingDirectory</key><string>$repo_root_xml</string>
<key>UserName</key><string>$runtime_user_xml</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>$logs_dir_xml/stdout.log</string>
<key>StandardErrorPath</key><string>$logs_dir_xml/stderr.log</string>
<key>EnvironmentVariables</key><dict>
<key>PATH</key><string>$node_path_env_xml</string>
<key>NODE_PATH</key><string>$node_path_module_xml</string>
<key>PUENTE_DATA_DIR</key><string>$data_dir_xml</string>
</dict>
</dict></plist>
EOF

/usr/bin/plutil -lint "$tmp_plist"
/bin/mkdir -p "$logs_dir"
/usr/sbin/chown "$runtime_user:$user_group" "$logs_dir"
/bin/chmod 0750 "$logs_dir"

tmp_staged="$(/usr/bin/mktemp "$plist.install.XXXXXX")"
/usr/bin/install -o root -g wheel -m 0644 "$tmp_plist" "$tmp_staged"
if [[ -f "$plist" ]]; then
  backup="$plist.bak.$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
  [[ ! -e "$backup" ]] || backup="$backup.$$.bak"
  /bin/cp -p "$plist" "$backup"
  printf 'Previous plist backed up to %s\n' "$backup"
fi

listeners="$(/usr/sbin/lsof -nP -iTCP:5006 -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u || true)"
if [[ -n "$previous_panel_pid" ]]; then
  [[ "$previous_panel_pid" =~ ^[1-9][0-9]*$ ]] || { echo '--previous-panel-pid must be a positive PID.' >&2; exit 1; }
  [[ "$listeners" == "$previous_panel_pid" ]] || {
    printf 'TCP 5006 listeners do not match the requested previous PID (%s): %s\n' "$previous_panel_pid" "${listeners:-none}" >&2
    exit 1
  }
  previous_user="$(/bin/ps -p "$previous_panel_pid" -o user= | /usr/bin/xargs)"
  previous_command="$(/bin/ps -ww -p "$previous_panel_pid" -o command=)"
  [[ "$previous_user" == "$runtime_user" ]] || { printf 'PID %s is owned by %s, expected %s.\n' "$previous_panel_pid" "$previous_user" "$runtime_user" >&2; exit 1; }
  case "$previous_command" in
    *"$repo_root/apps/server/dist/cli.js"*|*"$release_dir/dist/cli.js"*|*"$repo_root/runtime/releases/"*/dist/cli.js*|*"$repo_root/.puente/releases/"*/dist/cli.js*) ;;
    *) printf 'PID %s is not running the expected Puente CLI: %s\n' "$previous_panel_pid" "$previous_command" >&2; exit 1 ;;
  esac
  case "$previous_command" in
    *' start --foreground '*) ;;
    *) printf 'PID %s is not a foreground Puente server process.\n' "$previous_panel_pid" >&2; exit 1 ;;
  esac
  if /bin/launchctl print "system/$label" >/dev/null 2>&1; then
    /bin/launchctl bootout "system/$label"
  fi
  if /bin/kill -0 "$previous_panel_pid" 2>/dev/null; then
    /bin/kill -TERM "$previous_panel_pid"
  fi
  deadline=$((SECONDS + 15))
  while /bin/kill -0 "$previous_panel_pid" 2>/dev/null; do
    (( SECONDS < deadline )) || { printf 'PID %s did not exit after SIGTERM; leaving the service unloaded.\n' "$previous_panel_pid" >&2; exit 1; }
    /bin/sleep 0.2
  done
  listeners="$(/usr/sbin/lsof -nP -iTCP:5006 -sTCP:LISTEN -t 2>/dev/null | /usr/bin/sort -u || true)"
  [[ -z "$listeners" ]] || { printf 'TCP 5006 is still listening under PID(s): %s\n' "$listeners" >&2; exit 1; }
elif [[ -n "$listeners" ]]; then
  printf 'TCP 5006 is occupied by PID(s) %s. Verify and stop Puente explicitly, then pass --previous-panel-pid.\n' "$listeners" >&2
  exit 1
fi

if [[ -z "$previous_panel_pid" ]] && /bin/launchctl print "system/$label" >/dev/null 2>&1; then
  /bin/launchctl bootout "system/$label"
fi
/bin/mv -f "$tmp_staged" "$plist"
tmp_staged=''
/usr/bin/plutil -lint "$plist"
/bin/launchctl bootstrap system "$plist"
/bin/launchctl kickstart "system/$label"

printf 'Installed and started %s.\n' "$label"
printf 'Logs: %s/stdout.log and %s/stderr.log\n' "$logs_dir" "$logs_dir"
