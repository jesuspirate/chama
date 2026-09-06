#!/bin/bash
set -euo pipefail

# Load local, gitignored deploy config (deploy host/key/signing) so a fresh
# terminal tab always has it — independent of ~/.zshrc / which tab you opened.
__CHAMA_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$__CHAMA_ROOT/.env.release" ] && . "$__CHAMA_ROOT/.env.release"

# Usage:
#   ./scripts/release.sh [--patch|--minor|--major] "subject line"
#   ./scripts/release.sh [--patch|--minor|--major] -F /tmp/chama-commit.txt
#   ./scripts/release.sh --patch --no-deploy -F /tmp/chama-commit.txt
#   ./scripts/release.sh --current
#   ./scripts/release.sh --deploy-live
#
# Modes:
#   default   Clean-tree release: run gates, bump package version, commit,
#             tag, push main+tag, deploy web bundle.
#   --current Promote the already-committed package.json version at HEAD:
#             run gates, build with that version, tag/push the current
#             commit if needed, deploy. Use this after a manually versioned
#             checkpoint commit has already landed on main.
#   --deploy-live
#             Deploy already-pushed origin/main to getchama.app without
#             creating commits or pushing tags. This is the safe post-push
#             lane for manual checkpoint releases.

# ── Parse release options FIRST and shift them off ─────────────────────
BUMP_TYPE="patch"
DEPLOY=1
RELEASE_MODE="bump"

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --current|--deploy-current)
      RELEASE_MODE="current"
      shift
      ;;
    --deploy-live|--deploy-only)
      RELEASE_MODE="deploy-live"
      shift
      ;;
    --patch)
      BUMP_TYPE="patch"
      shift
      ;;
    --minor)
      BUMP_TYPE="minor"
      shift
      ;;
    --major)
      BUMP_TYPE="major"
      shift
      ;;
    --no-deploy)
      DEPLOY=0
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      if [ "${1:-}" = "-F" ]; then
        break
      fi
      echo "❌ Unknown option: $1"
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

# ── NOW parse remaining args ─────────────────────────────────────────
COMMIT_MSG=""
COMMIT_FILE=""

if [ "$RELEASE_MODE" = "current" ]; then
  if [ -n "${1:-}" ]; then
    echo "❌ --current does not take a commit message."
    echo "   It deploys the already-committed package.json version at HEAD."
    exit 1
  fi
elif [ "$RELEASE_MODE" = "deploy-live" ]; then
  if [ -n "${1:-}" ]; then
    echo "❌ --deploy-live does not take a commit message."
    echo "   It deploys the already-pushed origin/main without git push/tag."
    exit 1
  fi
elif [ "${1:-}" = "-F" ]; then
  if [ -z "${2:-}" ]; then
    echo "❌ -F requires a file path"
    exit 1
  fi
  COMMIT_FILE="$2"
  if [ ! -f "$COMMIT_FILE" ]; then
    echo "❌ File not found: $COMMIT_FILE"
    exit 1
  fi
elif [ -n "${1:-}" ]; then
  COMMIT_MSG="$1"
  if [[ "$COMMIT_MSG" == --* ]]; then
    echo "❌ Commit message looks like an option: $COMMIT_MSG"
    echo "   Did you mean to pass it before -F, or use -- to end options?"
    exit 1
  fi
else
  echo "❌ Commit message required."
  echo "   Usage: ./scripts/release.sh [--patch|--minor|--major] \"subject line\""
  echo "          ./scripts/release.sh [--patch|--minor|--major] -F /tmp/commit.txt"
  echo "          ./scripts/release.sh --current"
  echo "          ./scripts/release.sh --deploy-live"
  exit 1
fi

# ── Deploy SSH key resolution ──────────────────────────────────────────
# Deploy target + key come from the ENVIRONMENT so nothing about the box
# (key filename, host) lives in committed bytes. Set these in your shell
# (~/.zshrc) or a gitignored migration/deploy.env — never here:
#   export CHAMA_DEPLOY_KEY=/path/to/deploy-key
#   export CHAMA_DEPLOY_HOST=user@example.org
CHAMA_DEPLOY_KEY="${CHAMA_DEPLOY_KEY:-}"
CHAMA_DEPLOY_HOST="${CHAMA_DEPLOY_HOST:-}"

# Push the freshly-built dist/ to the live web root, and — when CHAMA_POC_DIST=1 —
# ALSO mirror it to the friend/PoC dist (~/chama-poc-dist) so browser/iPhone-PWA
# friends don't sit on a stale bundle after a release. FRONTEND ONLY: never rebuilds
# the Rust bridge binary (that stays a manual on-VPS step, needed only when
# native/fedimint-bridge/** changes). Reuses the same CHAMA_DEPLOY_HOST + _KEY.
# ⚠ ~/chama-dist (live getchama.app) and ~/chama-poc-dist (poc.getchama.app) are
# SEPARATE origins — never target both in one command; keep the live dist intact.
deploy_dist() {
  scp -r -i "$CHAMA_DEPLOY_KEY" dist/* "$CHAMA_DEPLOY_HOST:~/chama-dist/"
  if [ "${CHAMA_POC_DIST:-0}" = "1" ]; then
    echo "↗ Updating friend/PoC dist (~/chama-poc-dist) so friends get v${NEW_VERSION:-current}…"
    rsync -az -e "ssh -i $CHAMA_DEPLOY_KEY" dist/ "$CHAMA_DEPLOY_HOST:~/chama-poc-dist/"
    echo "✅ friend/PoC dist updated (bundle only; bridge binary unchanged)"
  fi
}
if [ "${DEPLOY:-1}" = "1" ]; then
  if [ -z "$CHAMA_DEPLOY_HOST" ]; then
    echo "❌ CHAMA_DEPLOY_HOST is required for deployment."
    echo "   Set it outside the repository or pass --no-deploy."
    exit 1
  fi
  if [ -z "$CHAMA_DEPLOY_KEY" ] || [ ! -f "$CHAMA_DEPLOY_KEY" ]; then
    echo "❌ CHAMA_DEPLOY_KEY is required and must name an existing file."
    echo "   Set it outside the repository or pass --no-deploy."
    exit 1
  fi
fi

# ── Git safety checks ──────────────────────────────────────────────────
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ release.sh must run from main. Current branch: $CURRENT_BRANCH"
  exit 1
fi

create_release_tag() {
  local tag="$1"
  git tag -s "$tag" -m "$tag"
}

assert_release_tag_signed() {
  local tag="$1"
  local ref="refs/tags/$tag"
  local type
  type=$(git cat-file -t "$ref")
  if [ "$type" != "tag" ]; then
    echo "❌ Local tag $tag is lightweight, not a signed annotated tag."
    echo "   Recreate it with: git tag -s $tag <commit-sha> -m \"$tag\""
    exit 1
  fi
  if ! git cat-file tag "$ref" | grep -q -- "-----BEGIN PGP SIGNATURE-----"; then
    echo "❌ Local tag $tag is annotated but not signed."
    echo "   Recreate it with: git tag -s $tag <commit-sha> -m \"$tag\""
    exit 1
  fi
}

remote_tag_target_sha() {
  local tag="$1"
  local sha
  sha=$(git ls-remote origin "refs/tags/$tag^{}" | awk '{print $1}')
  if [ -z "$sha" ]; then
    sha=$(git ls-remote origin "refs/tags/$tag" | awk '{print $1}')
  fi
  printf '%s\n' "$sha"
}

remote_tag_ref_sha() {
  local tag="$1"
  git ls-remote origin "refs/tags/$tag" | awk '{print $1}'
}

echo "🔎 Fetching origin/main and tags..."
git fetch --prune origin main --tags

LOCAL_HEAD=$(git rev-parse HEAD)
REMOTE_HEAD=$(git rev-parse origin/main)
if [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ]; then
  echo "❌ Local main is not exactly origin/main."
  echo "   local : $LOCAL_HEAD"
  echo "   remote: $REMOTE_HEAD"
  echo "   Pull/rebase or push existing commits before releasing."
  exit 1
fi

# ── Clean-tree guard (v0.6.5 audit fix) ────────────────────────────────
# Refuse to run if there are uncommitted or untracked changes. Without
# this, the later `git add` step could accidentally sweep unrelated
# WIP (stray logs, screenshots, scratch files, half-finished edits)
# into the release commit. The downstream surgical-add covers the
# happy path, but a clean-tree precondition is the load-bearing
# guarantee — verified once, up front, so every later step can trust
# it.
# Refresh first: a file rewritten with identical content but a new mtime
# (editor save, stash apply, sync tool) otherwise reads as dirty here.
git update-index -q --refresh || true
if ! git diff-index --quiet HEAD --; then
  echo "❌ Working tree has uncommitted changes. Commit or stash first."
  git status --short
  exit 1
fi
UNTRACKED=$(git ls-files --others --exclude-standard)
if [ -n "$UNTRACKED" ]; then
  echo "❌ Working tree has untracked files. Add to .gitignore, commit, or remove:"
  echo "$UNTRACKED" | sed 's/^/   /'
  exit 1
fi

# ── Sanity: package.json in sync with last tag ─────────────────────────
CURRENT_PKG_VERSION=$(node -p "require('./package.json').version")
LAST_TAG_VERSION=$(git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//' || echo "")

if [ "$RELEASE_MODE" = "bump" ] && [ -n "$LAST_TAG_VERSION" ] && [ "$CURRENT_PKG_VERSION" != "$LAST_TAG_VERSION" ]; then
  echo "⚠️  package.json ($CURRENT_PKG_VERSION) doesn't match last tag (v$LAST_TAG_VERSION)."
  echo "   This usually means a previous release.sh run errored mid-way."
  echo "   Either reset package.json to $LAST_TAG_VERSION, or confirm to continue:"
  read -p "   Continue and bump from $CURRENT_PKG_VERSION? [y/N] " confirm
  if [ "$confirm" != "y" ]; then
    echo "Aborted."
    exit 1
  fi
fi

# ── node_modules drift check ──────────────────────────────────────────
# Verifies installed deps match package-lock.json. v0.4.4 shipped a bundle
# built against the wrong Fedimint version because node_modules drifted
# from package.json after a branch experiment. npm ls --depth=0 catches
# missing/mismatched top-level deps without doing a destructive reinstall.
echo "🔎 Checking node_modules sync with package-lock.json..."
if ! npm ls --depth=0 > /dev/null 2>&1; then
  echo "❌ node_modules is out of sync with package.json / package-lock.json."
  echo "   Run: rm -rf node_modules package-lock.json && npm install"
  echo "   Then re-run release.sh."
  exit 1
fi

# ── Pre-deploy gate (typecheck + tests) — PRE-BUMP ─────────────────────
# v0.6.5 audit fix: gates run BEFORE the version bump. Pre-this-patch
# order was bump → gates → commit, which on gate failure left
# package.json bumped without a commit (recoverable via the sanity
# check above, but a manual revert was required and double-bumps were
# easy on re-run). Running gates against the current pre-bump tree is
# equivalent — `npm version` only changes the version string, not any
# code or deps — and a failure now leaves the working tree exactly as
# the user started. No revert needed.
echo "🔎 Running predeploy gate (typecheck + tests)..."
npm run predeploy

# ── Build gate — also PRE-BUMP ─────────────────────────────────────────
# Same reasoning: keep the working tree untouched until every gate has
# proven the code is shippable. This is only the shippability gate; after
# the version bump below, release.sh rebuilds dist so the deployed web bundle
# embeds the new __APP_VERSION__ value.
echo "🔎 Running production build gate..."
npm run build

if [ "$RELEASE_MODE" = "deploy-live" ]; then
  NEW_VERSION="$CURRENT_PKG_VERSION"
  COMMIT_SHA=$(git rev-parse HEAD)

  if ! grep -R "$NEW_VERSION" dist/*.html dist/assets/*.js >/dev/null 2>&1; then
    echo "❌ Built dist does not appear to contain app version $NEW_VERSION."
    echo "   Refusing to deploy a bundle with a stale version badge."
    exit 1
  fi

  echo "🚀 Deploying origin/main@$COMMIT_SHA as v$NEW_VERSION..."
  npx cap sync android
  deploy_dist

  echo "✅ Deployed v$NEW_VERSION from origin/main@$COMMIT_SHA"
  exit 0
fi

if [ "$RELEASE_MODE" = "current" ]; then
  NEW_VERSION="$CURRENT_PKG_VERSION"
  COMMIT_SHA=$(git rev-parse HEAD)

  if ! grep -R "$NEW_VERSION" dist/*.html dist/assets/*.js >/dev/null 2>&1; then
    echo "❌ Built dist does not appear to contain app version $NEW_VERSION."
    echo "   Refusing to deploy a bundle with a stale version badge."
    exit 1
  fi

  if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
    assert_release_tag_signed "v$NEW_VERSION"
    LOCAL_TAG_SHA=$(git rev-list -n 1 "refs/tags/v$NEW_VERSION")
    if [ "$LOCAL_TAG_SHA" != "$COMMIT_SHA" ]; then
      echo "❌ Local tag v$NEW_VERSION points at $LOCAL_TAG_SHA, not HEAD $COMMIT_SHA."
      exit 1
    fi
  else
    create_release_tag "v$NEW_VERSION"
  fi

  if git ls-remote --exit-code --tags origin "refs/tags/v$NEW_VERSION" >/dev/null 2>&1; then
    REMOTE_TAG_SHA=$(remote_tag_target_sha "v$NEW_VERSION")
    REMOTE_TAG_REF_SHA=$(remote_tag_ref_sha "v$NEW_VERSION")
    LOCAL_TAG_REF_SHA=$(git rev-parse "refs/tags/v$NEW_VERSION")
    if [ "$REMOTE_TAG_SHA" != "$COMMIT_SHA" ]; then
      echo "❌ Remote tag v$NEW_VERSION points at $REMOTE_TAG_SHA, not HEAD $COMMIT_SHA."
      exit 1
    fi
    if [ "$REMOTE_TAG_REF_SHA" != "$LOCAL_TAG_REF_SHA" ]; then
      echo "❌ Remote tag v$NEW_VERSION is not the local signed tag object."
      echo "   Refusing to proceed with a stale lightweight or unsigned remote tag."
      echo "   If this is intentional, replace the remote tag explicitly:"
      echo "     git push --force origin v$NEW_VERSION"
      exit 1
    fi
  else
    git push origin "v$NEW_VERSION"
  fi

  echo "✅ GitHub has main@$COMMIT_SHA and tag v$NEW_VERSION"

  if [ "$DEPLOY" = "0" ]; then
    echo "↷ Skipping deploy because --no-deploy was passed."
    echo "✅ Released v$NEW_VERSION"
    exit 0
  fi

  npx cap sync android
  deploy_dist

  echo "✅ Deployed v$NEW_VERSION"
  exit 0
fi

# ── Bump version (no git tag yet — we'll do it after commit) ──────────
# Gates passed. Now mutate package.json + package-lock.json. From this
# point until the commit lands, an error should roll back the bump so
# the next run doesn't see drifted version state.
npm version "$BUMP_TYPE" --no-git-tag-version
NEW_VERSION=$(node -p "require('./package.json').version")
BUMP_APPLIED=1
COMMIT_DONE=0

# Rollback trap: if anything between here and the commit fails, undo
# the bump so the user's next attempt starts from a clean slate. Once
# the commit lands, the trap becomes a no-op — the commit IS the
# success state and we don't want to retroactively rewrite history if
# the push or remote-verify fails.
restore_pkg_on_error() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "${BUMP_APPLIED:-0}" = "1" ] && [ "${COMMIT_DONE:-0}" = "0" ]; then
    echo "⚠️  Rolling back package.json / package-lock.json (bump applied but commit not made)..."
    git checkout -- package.json package-lock.json 2>/dev/null || true
  fi
  exit "$code"
}
trap restore_pkg_on_error EXIT

if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
  echo "❌ Local tag v$NEW_VERSION already exists."
  exit 1
fi
if git ls-remote --exit-code --tags origin "refs/tags/v$NEW_VERSION" >/dev/null 2>&1; then
  echo "❌ Remote tag v$NEW_VERSION already exists on origin."
  exit 1
fi

# ── Post-bump build for deploy artifacts ───────────────────────────────
# Vite reads package.json in vite.config.ts to define __APP_VERSION__.
# Building only before npm version produces correct code with a stale
# version badge in dist. Rebuild after the bump so the exact release version
# is what ships to the web host and Capacitor asset sync.
echo "🔎 Rebuilding production bundle with v$NEW_VERSION..."
npm run build

if ! grep -R "$NEW_VERSION" dist/*.html dist/assets/*.js >/dev/null 2>&1; then
  echo "❌ Built dist does not appear to contain app version $NEW_VERSION."
  echo "   Refusing to tag/deploy a bundle with a stale version badge."
  exit 1
fi

# ── Commit ─────────────────────────────────────────────────────────────
# Surgical add: only stage the files release.sh actually touched. The
# pre-bump clean-tree guard guarantees nothing else is sitting around,
# but using explicit paths instead of `git add -A` is defense in depth
# (and reads clearly to anyone debugging a failed release).
git add package.json package-lock.json
if [ -n "$COMMIT_FILE" ]; then
  git commit -F "$COMMIT_FILE"
else
  git commit -m "$COMMIT_MSG"
fi
COMMIT_DONE=1

COMMIT_SHA=$(git rev-parse HEAD)
create_release_tag "v$NEW_VERSION"
git push origin HEAD:main
git push origin "v$NEW_VERSION"

# ── Remote verification ────────────────────────────────────────────────
REMOTE_MAIN_SHA=$(git ls-remote origin refs/heads/main | awk '{print $1}')
REMOTE_TAG_SHA=$(remote_tag_target_sha "v$NEW_VERSION")
REMOTE_TAG_REF_SHA=$(remote_tag_ref_sha "v$NEW_VERSION")
LOCAL_TAG_REF_SHA=$(git rev-parse "refs/tags/v$NEW_VERSION")

if [ "$REMOTE_MAIN_SHA" != "$COMMIT_SHA" ]; then
  echo "❌ origin/main did not land on the release commit."
  echo "   expected: $COMMIT_SHA"
  echo "   got     : $REMOTE_MAIN_SHA"
  exit 1
fi

if [ "$REMOTE_TAG_SHA" != "$COMMIT_SHA" ]; then
  echo "❌ origin tag v$NEW_VERSION did not land on the release commit."
  echo "   expected: $COMMIT_SHA"
  echo "   got     : $REMOTE_TAG_SHA"
  exit 1
fi

if [ "$REMOTE_TAG_REF_SHA" != "$LOCAL_TAG_REF_SHA" ]; then
  echo "❌ origin tag v$NEW_VERSION is not the local signed tag object."
  echo "   expected tag object: $LOCAL_TAG_REF_SHA"
  echo "   got remote ref     : $REMOTE_TAG_REF_SHA"
  exit 1
fi

echo "✅ GitHub has main@$COMMIT_SHA and tag v$NEW_VERSION"

# ── Deploy ─────────────────────────────────────────────────────────────
if [ "$DEPLOY" = "0" ]; then
  echo "↷ Skipping deploy because --no-deploy was passed."
  echo "✅ Released v$NEW_VERSION"
  exit 0
fi

npx cap sync android
deploy_dist

echo "✅ Deployed v$NEW_VERSION"
