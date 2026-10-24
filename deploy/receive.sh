#!/usr/bin/env bash
# Forced command for the GitHub Actions deploy key, installed at ~/oracle-panel/receive.sh and referenced as
#   restrict,command="/home/ubuntu/oracle-panel/receive.sh" ssh-ed25519 AAAA... oracle-panel-deploy
# Reads a gzip tarball of the backend on stdin, swaps it in, restarts the service, and rolls back if the
# health check fails. The key can do nothing else: no shell, no forwarding, no pty.
set -euo pipefail

readonly ROOT=/home/ubuntu/oracle-panel
readonly MAX_ARCHIVE_BYTES=$((5 * 1024 * 1024))
readonly HEALTH_URL=http://127.0.0.1:47620/api/health
readonly HEALTH_ATTEMPTS=15
readonly REQUIRED_FILES=(panel.py auth.py metrics.py remote_ops.py remote_probe.py runner.py deploy/config.server.json)

staging=$(mktemp -d "$ROOT/.staging.XXXXXX")
trap 'rm -rf "$staging"' EXIT

head -c "$MAX_ARCHIVE_BYTES" | tar -xz -C "$staging" --no-same-owner --no-same-permissions
for required in "${REQUIRED_FILES[@]}"; do
  [[ -f "$staging/$required" ]] || { echo "deploy rejected: missing $required" >&2; exit 2; }
done
python3 -m py_compile "$staging"/*.py

rm -rf "$ROOT/app.prev"
if [[ -d "$ROOT/app" ]]; then mv "$ROOT/app" "$ROOT/app.prev"; fi
mv "$staging" "$ROOT/app"
trap - EXIT
sudo -n systemctl restart oracle-panel

for _ in $(seq 1 "$HEALTH_ATTEMPTS"); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "deployed $(date -Is)"
    exit 0
  fi
  sleep 1
done

echo "health check failed, rolling back to previous build" >&2
if [[ -d "$ROOT/app.prev" ]]; then
  rm -rf "$ROOT/app"
  mv "$ROOT/app.prev" "$ROOT/app"
  sudo -n systemctl restart oracle-panel
fi
exit 1
