#!/usr/bin/env bash
# scripts/deploy-landing.sh — push the chama.community landing page to the server.
#
# The marketing landing (landing/ — index.html + icons + img) is a SEPARATE site
# from the app. The app build (dist/) deploys to ~/chama-dist/ and serves
# getchama.app; THIS serves chama.community from ~/chama-landing/. The landing is
# intentionally NOT in the GitHub release — ship.sh's `git add -A` holds it out
# via `git stash push -u -- landing/` — so this manifest sync is how it goes live.
#
# Only the reviewed files in landing/deploy-files.txt are staged and synced.
# The design-working directory may retain old hero/banner experiments without
# sending them. rsync transfers only changed bytes and removes files that are no
# longer in the live manifest, so the VPS directory stays an exact deploy copy.
#
# Usage:
#   ./scripts/deploy-landing.sh            # sync manifest → ~/chama-landing/
#   ./scripts/deploy-landing.sh --dry-run  # show the exact sync, change nothing
#
# Env:
#   CHAMA_DEPLOY_KEY   path to the SSH key used for deployment (required)
#   CHAMA_DEPLOY_HOST  SSH destination in user@host form (required)

set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DRY=0
case "${1:-}" in
  --dry-run|-n) DRY=1 ;;
  "") : ;;
  *) echo "❌ unknown arg: $1 (use --dry-run or nothing)"; exit 1 ;;
esac

DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-}"
DEPLOY_HOST="${CHAMA_DEPLOY_HOST:-}"
DEST="$DEPLOY_HOST:~/chama-landing/"

[ -n "$DEPLOY_HOST" ] || { echo "❌ CHAMA_DEPLOY_HOST is required."; exit 1; }
[ -f "$DEPLOY_KEY" ] || { echo "❌ CHAMA_DEPLOY_KEY must name an existing SSH key."; exit 1; }
[ -f landing/index.html ] || { echo "❌ landing/index.html missing — are you at the repo root, and did you 'git stash pop' the landing back?"; exit 1; }
[ -f landing/deploy-files.txt ] || { echo "❌ landing/deploy-files.txt missing."; exit 1; }
node scripts/check-landing-deploy.mjs

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/chama-landing-deploy.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

COUNT=0
while IFS= read -r REL || [ -n "$REL" ]; do
  case "$REL" in
    ""|\#*) continue ;;
    /*|..|../*|*/..|*/../*) echo "❌ unsafe manifest path: $REL"; exit 1 ;;
  esac
  SRC="landing/$REL"
  [ -f "$SRC" ] || { echo "❌ manifest file missing: $SRC"; exit 1; }
  mkdir -p "$STAGE/$(dirname "$REL")"
  cp -p "$SRC" "$STAGE/$REL"
  COUNT=$((COUNT + 1))
done < landing/deploy-files.txt

BUNDLE_SIZE="$(du -sh "$STAGE" | awk '{print $1}')"
echo "▶ staged $COUNT live files ($BUNDLE_SIZE) from landing/deploy-files.txt"
# Content checksums avoid re-uploading unchanged assets when VPS mtimes differ
# from the local design workspace.
RSYNC_ARGS=(-rzc --delete --itemize-changes -e "ssh -i $DEPLOY_KEY")
if [ "$DRY" = "1" ]; then
  RSYNC_ARGS+=(--dry-run)
  echo "▶ dry-run incremental sync; the VPS will not be changed"
fi
rsync "${RSYNC_ARGS[@]}" "$STAGE/" "$DEST"
if [ "$DRY" = "1" ]; then echo "↷ --dry-run: nothing sent or removed."; exit 0; fi
echo "✅ Landing live → https://chama.community"
