#!/usr/bin/env bash
# Install this checkout as the local, single-user Email Event Manager service.
# Run as root: sudo ./scripts/install-linux.sh
set -euo pipefail

APP_NAME=email-event-manager
APP_USER=email-event-manager
APP_DIR=/opt/email-event-manager
STATE_DIR=/var/lib/email-event-manager
ENV_DIR=/etc/email-event-manager
UNIT=/etc/systemd/system/${APP_NAME}.service
START=1
SOURCE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)

usage() {
  cat <<'EOF'
Usage: sudo ./scripts/install-linux.sh [--source DIRECTORY] [--no-start]

Builds a production copy from DIRECTORY (default: this checkout), installs it in
/opt/email-event-manager, and installs/enables the systemd service. Application
state in /var/lib/email-event-manager and /etc/email-event-manager/environment
is preserved across installs.
EOF
}

while (($#)); do
  case "$1" in
    --source) SOURCE_DIR=$(cd "$2" && pwd -P); shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo 'Run this installer with sudo/root.' >&2; exit 1; }
[[ -f "$SOURCE_DIR/package.json" && -f "$SOURCE_DIR/package-lock.json" ]] || {
  echo "--source must contain package.json and package-lock.json." >&2; exit 1;
}
[[ -f "$SOURCE_DIR/systemd/${APP_NAME}.service" ]] || {
  echo "Service template is missing from source." >&2; exit 1;
}
command -v systemctl >/dev/null || { echo 'systemd/systemctl is required.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Node.js 22 is required.' >&2; exit 1; }
command -v npm >/dev/null || { echo 'npm is required.' >&2; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 22 )) || { echo "Node.js 22+ is required (found $(node --version))." >&2; exit 1; }

# Build outside the live directory. A failed dependency install/build leaves the
# running release, state, and credentials untouched.
STAGE=$(mktemp -d /opt/.${APP_NAME}.XXXXXX)
NEW_DIR=${APP_DIR}.new
OLD_DIR=${APP_DIR}.previous
cleanup() { rm -rf "$STAGE" "$NEW_DIR"; }
trap cleanup EXIT

tar -C "$SOURCE_DIR" \
  --exclude=.git --exclude=node_modules --exclude=dist --exclude=data --exclude=.env \
  -cf - . | tar -C "$STAGE" -xf -
(
  cd "$STAGE"
  npm ci
  npm run build
  npm prune --omit=dev
)

# Create a system account with no login shell. Do not alter an existing account.
if ! getent group "$APP_USER" >/dev/null; then groupadd --system "$APP_USER"; fi
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  useradd --system --gid "$APP_USER" --home-dir "$STATE_DIR" \
    --shell /usr/sbin/nologin --comment 'Email Event Manager' "$APP_USER"
fi
install -d -o "$APP_USER" -g "$APP_USER" -m 0700 "$STATE_DIR"
install -d -o root -g "$APP_USER" -m 0750 "$ENV_DIR"
if [[ ! -e "$ENV_DIR/environment" ]]; then
  install -o root -g "$APP_USER" -m 0640 /dev/null "$ENV_DIR/environment"
fi

rm -rf "$NEW_DIR"
mv "$STAGE" "$NEW_DIR"
# The release contains no mutable state; state stays in STATE_DIR.
chown -R root:root "$NEW_DIR"
rm -rf "$OLD_DIR"
if [[ -d "$APP_DIR" ]]; then mv "$APP_DIR" "$OLD_DIR"; fi
mv "$NEW_DIR" "$APP_DIR"
rm -rf "$OLD_DIR"

install -o root -g root -m 0644 "$SOURCE_DIR/systemd/${APP_NAME}.service" "$UNIT"
systemctl daemon-reload
systemctl enable "$APP_NAME.service"
if (( START )); then
  systemctl restart "$APP_NAME.service"
  systemctl --no-pager --full status "$APP_NAME.service" || true
else
  echo "Installed but not started. Run: sudo systemctl start ${APP_NAME}"
fi

echo "Installed ${APP_NAME}. State: ${STATE_DIR}; environment file: ${ENV_DIR}/environment"
