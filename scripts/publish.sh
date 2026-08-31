#!/usr/bin/env bash
set -euo pipefail

# Publish one already-committed Chama version to exactly one destination, or
# run the complete distribution lane. For a brand-new version, ship.sh still
# owns the bump/commit step and delegates channel-only requests here.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

[ -f "$ROOT_DIR/.env.release" ] && . "$ROOT_DIR/.env.release"

TARGET=""
DRY_RUN=0
PUBLISH_RELEASE=0
CLOBBER=0
OVERWRITE_ZAPSTORE=0
REUSE_APK=0
SKIP_GATES=0
TAG=""
REPO=""
RELEASE_DIR=""
NOTES_FILE=""
ZAPSTORE_NOTES_FILE=""
RELEASE_TITLE=""
GPG_KEY="${CHAMA_GPG_KEY:-0CCF412F47859431BDB2C1F1489728C34DF7C33D}"

usage() {
  cat <<'EOF'
Usage: ./scripts/publish.sh --only <target> [options]
       npm run publish -- --only <target> [options]
       npm run ship -- --only <target> [options]

Targets (exactly one):
  github            Push the current branch to origin. No tag or deployment.
  tag               Verify/push current main and its signed vX.Y.Z tag. No deploy.
  web               Deploy getchama.app only.
  landing           Deploy chama.community only.
  android           Build, sign, and verify Android release assets locally only.
  github-assets     Build Android assets and upload them to the GitHub Release only.
  release-page      Create/update the GitHub Release page only; add --publish to publish it.
  zapstore          Build/verify the APK and publish only to Zapstore.
  zapstore-listing  Refresh Zapstore images/description/notes from zapstore.yaml.
                    Zapstore has no metadata-only event, so the current release is
                    safely re-published with --overwrite-release; no other channel changes.
  full              Current tag + web + Android + GitHub assets + Zapstore.

Common options:
  --dry-run, -n                  Print the exact command without changing anything.
  --tag vX.Y.Z                  Override the package.json-derived tag.
  --repo owner/repo             Override the origin-derived GitHub repository.
  --notes-file PATH             GitHub Release notes.
  --zapstore-notes-file PATH    Short Zapstore card notes.
  --release-dir PATH            Reuse/write Android release assets here.
  --gpg-key KEY                 Checksum-signing key.
  --clobber                     Replace same-named GitHub assets.
  --overwrite-zapstore          Re-publish the current Zapstore release.
  --reuse-apk, --no-build       Reuse the existing signed APK instead of rebuilding it.
  --skip-gates                  Skip web predeploy/build when already verified in this shell.
  --title TEXT                  GitHub Release title (release-page only).
  --publish                     Publish the GitHub Release instead of leaving it draft.

Examples:
  npm run ship -- --only landing
  npm run ship -- --only web
  npm run ship -- --only github
  npm run ship -- --only github-assets --clobber
  npm run ship -- --only release-page --notes-file /tmp/notes --publish
  npm run ship -- --only zapstore --zapstore-notes-file /tmp/zap-notes
  npm run ship -- --only zapstore-listing --overwrite-zapstore
EOF
}

need_value() {
  local flag="$1"
  local value="${2:-}"
  [ -n "$value" ] || { echo "❌ $flag requires a value."; exit 1; }
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --only)
      need_value "$1" "${2:-}"
      TARGET="$2"
      shift 2
      ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --publish) PUBLISH_RELEASE=1; shift ;;
    --clobber) CLOBBER=1; shift ;;
    --overwrite-zapstore|--zapstore-overwrite) OVERWRITE_ZAPSTORE=1; shift ;;
    --reuse-apk|--no-build) REUSE_APK=1; shift ;;
    --skip-gates|--skip-web-gate) SKIP_GATES=1; shift ;;
    --tag) need_value "$1" "${2:-}"; TAG="$2"; shift 2 ;;
    --repo) need_value "$1" "${2:-}"; REPO="$2"; shift 2 ;;
    --release-dir) need_value "$1" "${2:-}"; RELEASE_DIR="$2"; shift 2 ;;
    --notes-file) need_value "$1" "${2:-}"; NOTES_FILE="$2"; shift 2 ;;
    --zapstore-notes-file) need_value "$1" "${2:-}"; ZAPSTORE_NOTES_FILE="$2"; shift 2 ;;
    --gpg-key) need_value "$1" "${2:-}"; GPG_KEY="$2"; shift 2 ;;
    --title) need_value "$1" "${2:-}"; RELEASE_TITLE="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown option: $1"; usage; exit 1 ;;
  esac
done

[ -n "$TARGET" ] || { echo "❌ Choose one target with --only <target>."; usage; exit 1; }

case "$TARGET" in
  github|tag|web|landing|android|github-assets|release-page|zapstore|zapstore-listing|full) ;;
  *) echo "❌ Unknown publish target: $TARGET"; usage; exit 1 ;;
esac

VERSION=$(node -p "require('./package.json').version")
TAG="${TAG:-v$VERSION}"

default_repo() {
  local url
  url=$(git config --get remote.origin.url 2>/dev/null || true)
  url="${url%.git}"
  case "$url" in
    git@github.com:*) printf '%s\n' "${url#git@github.com:}" ;;
    https://github.com/*) printf '%s\n' "${url#https://github.com/}" ;;
  esac
}

REPO="${REPO:-$(default_repo)}"

print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

run() {
  if [ "$DRY_RUN" = "1" ]; then
    print_command "$@"
  else
    "$@"
  fi
}

require_file_if_set() {
  local label="$1"
  local path="$2"
  if [ -n "$path" ] && [ ! -f "$path" ]; then
    echo "❌ $label does not exist: $path"
    exit 1
  fi
}

require_file_if_set "Release notes file" "$NOTES_FILE"
require_file_if_set "Zapstore notes file" "$ZAPSTORE_NOTES_FILE"

# Channel retries commonly happen after docs or tooling have advanced main past
# the release tag. Never rebuild a tagged APK from that newer checkout: reuse
# the already verified release artifact instead. A missing artifact then fails
# closed inside android-release.sh with a precise path to restore.
if [[ "$TARGET" =~ ^(github-assets|zapstore|zapstore-listing|full)$ ]] \
  && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  tag_target=$(git rev-list -n 1 "$TAG")
  head_target=$(git rev-parse HEAD)
  if [ "$tag_target" != "$head_target" ]; then
    REUSE_APK=1
    echo "↷ $TAG is behind HEAD; reusing its verified APK instead of rebuilding newer code."
  fi
fi

android_args=(--tag "$TAG" --gpg-key "$GPG_KEY")
[ -n "$REPO" ] && android_args+=(--repo "$REPO")
[ -n "$RELEASE_DIR" ] && android_args+=(--release-dir "$RELEASE_DIR")
[ -n "$NOTES_FILE" ] && android_args+=(--notes-file "$NOTES_FILE")
[ -n "$ZAPSTORE_NOTES_FILE" ] && android_args+=(--zapstore-notes-file "$ZAPSTORE_NOTES_FILE")
[ "$CLOBBER" = "1" ] && android_args+=(--clobber)
[ "$OVERWRITE_ZAPSTORE" = "1" ] && android_args+=(--zapstore-overwrite)
[ "$REUSE_APK" = "1" ] && android_args+=(--no-build)
[ "$SKIP_GATES" = "1" ] && android_args+=(--skip-web-gate)

echo "── Chama targeted publish ──────────────────────────────────────"
echo "  version : $TAG"
echo "  target  : $TARGET"
echo "  repo    : ${REPO:-not required}"
[ "$DRY_RUN" = "1" ] && echo "  mode    : dry-run"
echo "────────────────────────────────────────────────────────────────"

case "$TARGET" in
  github)
    BRANCH=$(git branch --show-current)
    [ -n "$BRANCH" ] || { echo "❌ Cannot push a detached HEAD."; exit 1; }
    run git push origin "$BRANCH"
    ;;
  tag)
    run "$ROOT_DIR/scripts/release.sh" --current --no-deploy
    ;;
  web)
    run "$ROOT_DIR/scripts/release.sh" --deploy-live
    ;;
  landing)
    run "$ROOT_DIR/scripts/deploy-landing.sh"
    ;;
  android)
    run "$ROOT_DIR/scripts/android-release.sh" "${android_args[@]}"
    ;;
  github-assets)
    run "$ROOT_DIR/scripts/android-release.sh" "${android_args[@]}" --github-release
    ;;
  release-page)
    [ -n "$REPO" ] || { echo "❌ Could not infer GitHub repo; pass --repo owner/repo."; exit 1; }
    if [ "$DRY_RUN" = "1" ]; then
      page_args=(gh release edit "$TAG" --repo "$REPO")
      [ -n "$NOTES_FILE" ] && page_args+=(--notes-file "$NOTES_FILE")
      [ -n "$RELEASE_TITLE" ] && page_args+=(--title "$RELEASE_TITLE")
      [ "$PUBLISH_RELEASE" = "1" ] && page_args+=(--draft=false)
      print_command "${page_args[@]}"
      if [ "$PUBLISH_RELEASE" = "1" ]; then
        echo "  (If absent, the script creates and publishes the release.)"
      else
        echo "  (If absent, the script creates a draft release.)"
      fi
    elif gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
      page_args=(release edit "$TAG" --repo "$REPO")
      [ -n "$NOTES_FILE" ] && page_args+=(--notes-file "$NOTES_FILE")
      [ -n "$RELEASE_TITLE" ] && page_args+=(--title "$RELEASE_TITLE")
      [ "$PUBLISH_RELEASE" = "1" ] && page_args+=(--draft=false)
      if [ "${#page_args[@]}" -eq 5 ]; then
        echo "↷ Release exists; pass --notes-file, --title, or --publish to change it."
      else
        gh "${page_args[@]}"
      fi
    else
      create_args=(release create "$TAG" --repo "$REPO" --verify-tag --title "${RELEASE_TITLE:-Chama $TAG}")
      if [ -n "$NOTES_FILE" ]; then
        create_args+=(--notes-file "$NOTES_FILE")
      else
        create_args+=(--notes "Release assets for $TAG.")
      fi
      [ "$PUBLISH_RELEASE" = "0" ] && create_args+=(--draft)
      gh "${create_args[@]}"
    fi
    ;;
  zapstore)
    run "$ROOT_DIR/scripts/android-release.sh" "${android_args[@]}" --zapstore
    ;;
  zapstore-listing)
    echo "ℹ️  Zapstore refreshes listing metadata by re-publishing the current release event."
    run "$ROOT_DIR/scripts/android-release.sh" "${android_args[@]}" --no-build --zapstore --zapstore-overwrite --preserve-zapstore-notes
    ;;
  full)
    full_args=(--github-release --clobber --zapstore --gpg-key "$GPG_KEY")
    [ -n "$REPO" ] && full_args+=(--repo "$REPO")
    [ -n "$RELEASE_DIR" ] && full_args+=(--release-dir "$RELEASE_DIR")
    [ -n "$NOTES_FILE" ] && full_args+=(--notes-file "$NOTES_FILE")
    [ -n "$ZAPSTORE_NOTES_FILE" ] && full_args+=(--zapstore-notes-file "$ZAPSTORE_NOTES_FILE")
    [ "$OVERWRITE_ZAPSTORE" = "1" ] && full_args+=(--zapstore-overwrite)
    [ "$REUSE_APK" = "1" ] && full_args+=(--no-build-apk)
    run "$ROOT_DIR/scripts/release-all.sh" "${full_args[@]}"
    ;;
esac

echo "✅ Target complete: $TARGET ($TAG)"
