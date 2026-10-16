#!/usr/bin/env bash
set -euo pipefail

# Build and deploy the SANDBOX: the current worktree built with
# VITE_CHAMA_SANDBOX=1 (sim mode forced on, cannot be switched off), uploaded
# to ~/chama-poc-dist, which Caddy serves at https://poc.getchama.app.
#
# Isolation guarantees:
#   - never bumps, commits, tags, or touches Android / Zapstore / Start9;
#   - never writes ~/chama-dist (getchama.app) — the destination is fixed here
#     and release.sh's deploy_dist is never called;
#   - refuses to upload a bundle that does not carry the sandbox marker, so a
#     real-money build can never land on the sandbox origin;
#   - keeps a dated copy of the previous sandbox on the VPS before replacing it.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[ -f "$ROOT_DIR/.env.release" ] && . "$ROOT_DIR/.env.release"

SANDBOX_REMOTE_DIR="chama-poc-dist"
SANDBOX_URL="https://poc.getchama.app"
MARKER="chama-sandbox-build"

if [ "${1:-}" = "--dry-run" ]; then
  echo "SANDBOX only: predeploy; VITE_CHAMA_SANDBOX=1 build → dist-sandbox; upload → ~/$SANDBOX_REMOTE_DIR ($SANDBOX_URL)"
  echo "No live upload, version bump, commit, tag, Android sync or bridge restart."
  exit 0
fi
[ $# -eq 0 ] || { echo "Usage: release.sh --deploy-sandbox [--dry-run]"; exit 1; }
: "${CHAMA_DEPLOY_HOST:?CHAMA_DEPLOY_HOST is required}"
: "${CHAMA_DEPLOY_KEY:?CHAMA_DEPLOY_KEY is required}"
[ -f "$CHAMA_DEPLOY_KEY" ] || { echo "❌ Deploy key does not exist"; exit 1; }

# A prerelease that already ran the predeploy gates on this same worktree
# (scripts/prerelease-apk.sh) skips the repeat.
if [ "${CHAMA_SANDBOX_GATES_PASSED:-0}" = "1" ]; then
  echo "↷ Predeploy gates already passed for this worktree (prerelease)."
else
  VITE_CHAMA_SANDBOX=0 npm run predeploy
fi
rm -rf dist-sandbox
VITE_CHAMA_SANDBOX=1 CHAMA_RELEASE=1 npm run build
[ -f dist-sandbox/index.html ] || { echo "❌ Missing sandbox output"; exit 1; }
if ! grep -rqs "$MARKER" dist-sandbox/assets; then
  echo "❌ dist-sandbox does not carry the sandbox marker; refusing to upload a non-sandbox bundle."
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
# Replace atomically-enough: upload beside, then swap, keeping the old copy.
ssh -i "$CHAMA_DEPLOY_KEY" "$CHAMA_DEPLOY_HOST" "set -e
  rm -rf ~/$SANDBOX_REMOTE_DIR.incoming
  mkdir -p ~/$SANDBOX_REMOTE_DIR.incoming"
scp -r -q -i "$CHAMA_DEPLOY_KEY" dist-sandbox/. "$CHAMA_DEPLOY_HOST:~/$SANDBOX_REMOTE_DIR.incoming/"
ssh -i "$CHAMA_DEPLOY_KEY" "$CHAMA_DEPLOY_HOST" "set -e
  if [ -d ~/$SANDBOX_REMOTE_DIR ]; then mv ~/$SANDBOX_REMOTE_DIR ~/$SANDBOX_REMOTE_DIR.backup-$STAMP; fi
  mv ~/$SANDBOX_REMOTE_DIR.incoming ~/$SANDBOX_REMOTE_DIR
  # A hosted prerelease APK (scripts/prerelease-apk.sh) rides inside this dir; keep it across sandbox deploys.
  if [ -d ~/$SANDBOX_REMOTE_DIR.backup-$STAMP/prerelease ]; then cp -a ~/$SANDBOX_REMOTE_DIR.backup-$STAMP/prerelease ~/$SANDBOX_REMOTE_DIR/; fi
  ls -d ~/$SANDBOX_REMOTE_DIR.backup-* 2>/dev/null | sort | head -n -3 | xargs -r rm -rf"

# Prove the served origin is the sandbox before calling it done.
# No pipes into grep -q here: under pipefail, grep quitting on the first match
# sends SIGPIPE to the writer and the hit reads as a failure.
index_html="$(curl -fsSL "$SANDBOX_URL/index.html" || true)"
served="$(grep -o 'assets/main-[A-Za-z0-9_.-]*\.js' <<<"$index_html" | head -n 1 || true)"
served_js="$([ -n "$served" ] && curl -fsSL "$SANDBOX_URL/$served" || true)"
served_ok=0
case "$served_js" in *"$MARKER"*) served_ok=1 ;; esac
if [ -z "$served" ] || [ "$served_ok" != "1" ]; then
  echo "❌ $SANDBOX_URL is not serving the sandbox marker after upload. Investigate before using it."
  exit 1
fi
echo "✅ Sandbox v$(node -p "require('./package.json').version") is live at $SANDBOX_URL (previous copy kept as ~/$SANDBOX_REMOTE_DIR.backup-$STAMP). Live output untouched."
