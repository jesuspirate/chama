#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[ -f "$ROOT_DIR/.env.release" ] && . "$ROOT_DIR/.env.release"

if [ "${1:-}" = "--dry-run" ]; then
  echo "NEXT only: predeploy; VITE_CHAMA_NEXT=1 build → dist-next; upload → ~/chama-next-dist"
  echo "No live/PoC upload, version bump, commit, tag, Android sync or bridge restart."
  exit 0
fi
[ $# -eq 0 ] || { echo "Usage: release.sh --deploy-next [--dry-run]"; exit 1; }
: "${CHAMA_DEPLOY_HOST:?CHAMA_DEPLOY_HOST is required}"
: "${CHAMA_DEPLOY_KEY:?CHAMA_DEPLOY_KEY is required}"
[ -f "$CHAMA_DEPLOY_KEY" ] || { echo "Deploy key does not exist"; exit 1; }

# Fixed destination: never take a caller-supplied remote directory or use the
# production deploy_dist function. The web server must serve this directory
# at the separate NEXT origin (see docs/RELEASING.md).
VITE_CHAMA_NEXT=0 npm run predeploy
VITE_CHAMA_NEXT=1 CHAMA_RELEASE=1 npm run build
[ -f dist-next/index.html ] || { echo "Missing NEXT output"; exit 1; }
ssh -i "$CHAMA_DEPLOY_KEY" "$CHAMA_DEPLOY_HOST" 'mkdir -p ~/chama-next-dist'
scp -r -i "$CHAMA_DEPLOY_KEY" dist-next/. "$CHAMA_DEPLOY_HOST:~/chama-next-dist/"
echo "NEXT simulation uploaded to ~/chama-next-dist. Live output untouched."
