#!/usr/bin/env bash
set -euo pipefail

# Build a signed PRERELEASE APK of the current worktree and host it at
# https://poc.getchama.app/prerelease/ for sideloading onto a test phone.
#
#   npm run ship -- --only prerelease                # next patch, rc.1
#   npm run ship -- --only prerelease --rc 2         # next patch, rc.2
#   npm run ship -- --only prerelease --next minor   # next minor, rc.1
#   npm run ship -- --only prerelease --dry-run
#   npm run ship -- --only prerelease --rc 3 --no-sandbox   # APK only
#
# What it is: the same build android-release.sh produces for a release — same
# signing key as Zapstore, native bridge included — numbered X.Y.Z-rc.N so it
# installs OVER the production app on the phone and the real X.Y.Z installs
# over it afterwards. The lane is forward-only: Android refuses a lower
# versionCode, and uninstalling deletes the on-device wallet, so there is no
# rollback — only another rc, or shipping the version.
#
# What it is not: a release. No tag, no commit, no GitHub, no Zapstore, no
# Start9, no live web. The version bump is transient and restored on exit,
# whatever happens. The hosted file lives inside the sandbox dist and is kept
# across sandbox deploys until the next prerelease replaces it.
#
# The sandbox follows the rc (Jet, Oct 15): once the APK is served, the same
# worktree is deployed to https://poc.getchama.app under the same transient
# version, so the sandbox's version line reads X.Y.Z-rc.N and a tester can see
# which candidate it runs. --no-sandbox skips that step.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
[ -f "$ROOT_DIR/.env.release" ] && . "$ROOT_DIR/.env.release"

RC=1
NEXT="patch"
DRY_RUN=0
SKIP_GATES=0
SANDBOX=1
while [ $# -gt 0 ]; do
  case "$1" in
    --rc) RC="${2:-}"; shift 2 ;;
    --next) NEXT="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-gates|--skip-web-gate) SKIP_GATES=1; shift ;;
    --no-sandbox) SANDBOX=0; shift ;;
    *) echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done
[[ "$RC" =~ ^[1-9][0-9]*$ ]] || { echo "❌ --rc must be a positive integer"; exit 1; }
# rc.99 would take the release's versionCode slot (scripts/android-version-code.mjs).
[ "$RC" -gt 98 ] && { echo "❌ --rc must be 98 or lower: rc.99 and up would not sort below the release"; exit 1; }
case "$NEXT" in patch|minor|major) ;; *) echo "❌ --next must be patch, minor or major"; exit 1 ;; esac

BASE_VERSION="$(node -p "require('./package.json').version")"
NEXT_VERSION="$(node -e "
const [a,b,c] = '$BASE_VERSION'.split('-')[0].split('.').map(Number);
console.log({patch:[a,b,c+1], minor:[a,b+1,0], major:[a+1,0,0]}['$NEXT'].join('.'));")"
RC_VERSION="$NEXT_VERSION-rc.$RC"
REMOTE_DIR="chama-poc-dist/prerelease"
BASENAME="chama-$RC_VERSION-PRERELEASE.apk"
URL="https://poc.getchama.app/prerelease/$BASENAME"

if [ "$DRY_RUN" = "1" ]; then
  echo "PRERELEASE only: $BASE_VERSION → transient $RC_VERSION; gates; signed APK; upload → ~/$REMOTE_DIR/$BASENAME"
  echo "Would be served at $URL. No tag, commit, GitHub, Zapstore, Start9 or live web change; version restored on exit."
  if [ "$SANDBOX" = "1" ]; then echo "Then: sandbox deploy of the same worktree as v$RC_VERSION → https://poc.getchama.app (--no-sandbox skips it)."
  else echo "Sandbox left as it is (--no-sandbox)."; fi
  exit 0
fi

: "${CHAMA_DEPLOY_HOST:?CHAMA_DEPLOY_HOST is required}"
: "${CHAMA_DEPLOY_KEY:?CHAMA_DEPLOY_KEY is required}"
[ -f "$CHAMA_DEPLOY_KEY" ] || { echo "❌ Deploy key does not exist"; exit 1; }
if [ -z "${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}" ] && [ ! -f android/local.properties ]; then
  if [ -d "$HOME/Library/Android/sdk" ]; then export ANDROID_HOME="$HOME/Library/Android/sdk" ANDROID_SDK_ROOT="$HOME/Library/Android/sdk";
  else echo "❌ Android SDK not found: set ANDROID_HOME or android/local.properties"; exit 1; fi
fi
if [ ! -f android/keystore.properties ] && [ -z "${CHAMA_ANDROID_STORE_FILE:-}" ]; then
  echo "❌ No signing config: android/keystore.properties (and its keystore) are gitignored — copy them into this checkout first."
  exit 1
fi
if [ -n "$(git status --porcelain -- package.json package-lock.json)" ]; then
  echo "❌ package.json / package-lock.json are already modified; refusing to layer a transient version on top."
  exit 1
fi

restore_version() { git checkout -q -- package.json package-lock.json 2>/dev/null || true; }
trap restore_version EXIT
npm version "$RC_VERSION" --no-git-tag-version >/dev/null
echo "🔖 Transient version $RC_VERSION (restored on exit; never committed)"

if [ "$SKIP_GATES" = "1" ]; then
  CHAMA_RELEASE=1 ./scripts/android-release.sh --skip-web-gate
else
  CHAMA_RELEASE=1 ./scripts/android-release.sh
fi

ASSETS="/private/tmp/chama-v$RC_VERSION-release-assets"
[ -f "$ASSETS/app-release.apk" ] || { echo "❌ Expected $ASSETS/app-release.apk"; exit 1; }
LOCAL_SHA="$(cut -c1-64 "$ASSETS/app-release.apk.sha256")"

ssh -i "$CHAMA_DEPLOY_KEY" "$CHAMA_DEPLOY_HOST" "mkdir -p ~/$REMOTE_DIR && rm -f ~/$REMOTE_DIR/*"
for f in app-release.apk app-release.apk.sha256 app-release.apk.sha256.asc; do
  scp -q -i "$CHAMA_DEPLOY_KEY" "$ASSETS/$f" "$CHAMA_DEPLOY_HOST:~/$REMOTE_DIR/${BASENAME}${f#app-release.apk}"
done

REMOTE_SHA="$(curl -fsSL "$URL" | shasum -a 256 | cut -c1-64)"
if [ "$REMOTE_SHA" != "$LOCAL_SHA" ]; then
  echo "❌ Served APK sha256 ($REMOTE_SHA) differs from the built one ($LOCAL_SHA)."
  exit 1
fi
echo "✅ PRERELEASE $RC_VERSION is at $URL"
echo "   sha256 $LOCAL_SHA (+ .sha256 and .sha256.asc beside it)"
echo "   Same signing key as Zapstore: installs over the production app; forward-only (no rollback)."

# The sandbox follows the rc, still under the transient version, so its version
# line names the candidate. The APK above is already served and checked; a
# sandbox failure is reported and fails the command, but leaves the APK alone.
if [ "$SANDBOX" = "1" ]; then
  echo "🧪 Deploying the sandbox as v$RC_VERSION…"
  if [ "$SKIP_GATES" = "1" ]; then sandbox_env=(); else sandbox_env=(CHAMA_SANDBOX_GATES_PASSED=1); fi
  if ! env ${sandbox_env[@]+"${sandbox_env[@]}"} "$ROOT_DIR/scripts/deploy-sandbox.sh"; then
    echo "❌ Sandbox deploy failed. The APK at $URL is fine; retry the sandbox alone with: npm run ship -- --only sandbox (it will show the base version, not rc.$RC)."
    exit 1
  fi
fi
