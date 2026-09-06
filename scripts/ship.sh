#!/bin/bash
set -euo pipefail
# ══════════════════════════════════════════════════════════════════════════
# Chama — ship.sh: one-command release kickoff
# ══════════════════════════════════════════════════════════════════════════
#
# Wraps the maintainer's exact, already-proven flow so a release is a single
# command instead of two hand-typed blocks. It does NOT change release.sh,
# release-all.sh, or android-release.sh — it just orchestrates them:
#
#   1. npm version <bump> --no-git-tag-version        # bump package.json only
#   2. git add -A
#      git commit -F  $CHAMA_COMMIT_DIR/chama-v<VER>_release_notes
#      git push origin main
#   3. npm run release:all -- --github-release --clobber --zapstore \
#        --gpg-key <key> \
#        --notes-file          $CHAMA_COMMIT_DIR/chama-v<VER>_release_notes \
#        --zapstore-notes-file $CHAMA_COMMIT_DIR/chama-v<VER>_zapstore_notes
#
# ── Filename convention (the files Claude hands over) ─────────────────────
#   Drop these in $CHAMA_COMMIT_DIR (default /tmp), named for the *target*
#   version (the version you're about to release, i.e. after the bump):
#       chama-v<VERSION>_release_notes    (required) — commit message AND the
#                                          long GitHub release body (--notes-file)
#       chama-v<VERSION>_zapstore_notes   (optional) — short Zapstore card notes
#   ship.sh computes the target version up front, resolves both files by name,
#   and refuses to start if the required one is missing — so you never get a
#   half-bumped tree because of a typo'd path.
#
# ── Usage ─────────────────────────────────────────────────────────────────
#   ./scripts/ship.sh                 # patch bump  (1.2.4 → 1.2.5)
#   ./scripts/ship.sh --minor         # 1.2.4 → 1.3.0
#   ./scripts/ship.sh --major
#   ./scripts/ship.sh --set-version 1.3.0
#   ./scripts/ship.sh --dry-run --minor      # print the plan, run nothing
#   ./scripts/ship.sh --no-release           # bump + commit + push only
#   ./scripts/ship.sh --no-push --no-release # bump + commit only
#   npm run ship -- --minor                  # same, via package.json
#   npm run ship -- --only landing           # current version, landing only
#   npm run ship -- --only zapstore-listing  # current version, listing refresh only
#
# ── Env (defaults match the maintainer; override to re-home) ──────────────
#   CHAMA_COMMIT_DIR   where the notes files live           (default /tmp)
#   CHAMA_GPG_KEY      signing key id for --gpg-key          (default below)
#   CHAMA_RELEASE_FLAGS  full override of the release:all flag list
#   SIGN_WITH, CHAMA_ZSP_BIN, CHAMA_DEPLOY_KEY  consumed unchanged by
#                      release-all.sh / android-release.sh / release.sh
#
# Tip: export the usual env once, e.g.
#   export SIGN_WITH=browser CHAMA_ZSP_BIN="$HOME/go/bin/zsp"
#   npm run ship -- --minor

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Channel-only work must never bump, commit, tag, or publish unrelated
# destinations. Keep ship.sh as the one remembered entry point, but delegate
# any --only request before the new-version machinery resolves notes or mutates
# package.json.
# `--only start9` routes to the Start9 lane, forwarding every other flag
# (e.g. --tag, --dry-run) untouched wherever it sits on the command line.
__chama_prev=""
__chama_is_start9=0
for __chama_arg in "$@"; do
  if [ "$__chama_prev" = "--only" ] && [ "$__chama_arg" = "start9" ]; then
    __chama_is_start9=1
  fi
  __chama_prev="$__chama_arg"
done
if [ "$__chama_is_start9" = "1" ]; then
  __chama_fwd=()
  __chama_skip=0
  for __chama_arg in "$@"; do
    if [ "$__chama_skip" = "1" ]; then __chama_skip=0; continue; fi
    if [ "$__chama_arg" = "--only" ]; then __chama_skip=1; continue; fi
    __chama_fwd+=("$__chama_arg")
  done
  exec "$ROOT_DIR/scripts/start9-release.sh" ${__chama_fwd[@]+"${__chama_fwd[@]}"}
fi
for __chama_arg in "$@"; do
  if [ "$__chama_arg" = "--only" ]; then
    exec "$ROOT_DIR/scripts/publish.sh" "$@"
  fi
done

# Load local, gitignored deploy config (deploy host/key/signing/poc-dist) so a fresh
# terminal tab always has it — independent of ~/.zshrc / which tab you opened. This is
# the durable fix for the recurring "CHAMA_DEPLOY_HOST is required" snag.
[ -f "$ROOT_DIR/.env.release" ] && . "$ROOT_DIR/.env.release"

BUMP="patch"
SET_VERSION=""
DRY=0
DO_PUSH=1
DO_RELEASE=1
DO_START9=1
ASSUME_YES=0
# Notes live in the repo-local release-notes/ dir when it exists (gitignored;
# where Claude drops them straight onto this machine), falling back to the
# historical /tmp convention. CHAMA_COMMIT_DIR still overrides everything.
if [ -z "${CHAMA_COMMIT_DIR:-}" ] && [ -d "$ROOT_DIR/release-notes" ]; then
  CHAMA_COMMIT_DIR="$ROOT_DIR/release-notes"
fi
CHAMA_COMMIT_DIR="${CHAMA_COMMIT_DIR:-/tmp}"
# Maintainer's signing key. A GPG *fingerprint* is public (it's on every
# signed tag), so defaulting it is safe; any other releaser overrides it.
CHAMA_GPG_KEY="${CHAMA_GPG_KEY:-0CCF412F47859431BDB2C1F1489728C34DF7C33D}"

# Zapstore publishing needs SIGN_WITH (the Nostr signer for the release event)
# and a zsp binary. Default + export them so `npm run ship` just works without
# remembering to set them each run; export anything yourself to override.
# These propagate to the `npm run release:all` child process below.
export SIGN_WITH="${SIGN_WITH:-browser}"
# Release builds carry NO dev build-stamp: vite reads this and bakes a clean
# "vX.Y.Z" chip. Local `npm run build` / android:sync (without this) bake an
# amber "v2.0.3 · dev MM-DD HH:mm" stamp so testers can SEE a refresh landed.
export CHAMA_RELEASE=1
# ⚠ Order matters. The durable `go install` location is preferred over
# /private/tmp, which macOS WIPES on reboot/cleanup — a stale-but-present
# binary there used to win over the good one, and a missing one killed the
# whole lane with "❌ zsp CLI is required" mid-release. /private/tmp survives
# only as a last resort for an older machine that still has it there.
if [ -z "${CHAMA_ZSP_BIN:-}" ]; then
  if [ -x "$HOME/go/bin/zsp" ]; then
    CHAMA_ZSP_BIN="$HOME/go/bin/zsp"
  elif command -v zsp >/dev/null 2>&1; then
    CHAMA_ZSP_BIN="$(command -v zsp)"
  elif [ -x /private/tmp/zsp ]; then
    CHAMA_ZSP_BIN=/private/tmp/zsp
  fi
fi
export CHAMA_ZSP_BIN

BUMP_EXPLICIT=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --patch|--minor|--major) BUMP="${1#--}"; BUMP_EXPLICIT=1; shift ;;
    --set-version)
      SET_VERSION="${2:-}"
      if ! printf '%s' "$SET_VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
        echo "❌ --set-version needs X.Y.Z (got: '${SET_VERSION:-}')"; exit 1
      fi
      shift 2 ;;
    --commit-dir) CHAMA_COMMIT_DIR="${2:?--commit-dir needs a path}"; shift 2 ;;
    --dry-run|-n) DRY=1; shift ;;
    --no-push) DO_PUSH=0; shift ;;
    --no-release) DO_RELEASE=0; shift ;;
    --no-start9) DO_START9=0; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    -h|--help) sed -n '4,52p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done

# ── Git index lock pre-flight ─────────────────────────────────────────────
# A crashed git process leaves .git/index.lock behind, and step 2's commit
# would then fail AFTER the version bump — a half-bumped tree. Detect it now:
# with no live git process the lock is stale debris and is removed; with one
# running, abort before anything mutates.
LOCK_FILE="$(git rev-parse --git-dir)/index.lock"
if [ -e "$LOCK_FILE" ]; then
  if pgrep -x git >/dev/null 2>&1; then
    echo "❌ $LOCK_FILE exists and a git process is running — finish/kill it, then re-run."
    exit 1
  fi
  echo "🧹 Removing stale $LOCK_FILE (no git process is running)."
  rm -f "$LOCK_FILE"
fi

# ── Must run from main (mirrors release.sh) ───────────────────────────────
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "❌ ship.sh must run from main. Current branch: $CURRENT_BRANCH"
  exit 1
fi

# ── Compute the TARGET version up front (before mutating anything) ────────
CURRENT_VERSION="$(node -p "require('./package.json').version")"
if [ -n "$SET_VERSION" ]; then
  NEW_VERSION="$SET_VERSION"
else
  NEW_VERSION="$(node -e '
    const c = require("./package.json").version.split(".").map(Number);
    const b = process.argv[1];
    if (b === "major") { c[0]++; c[1] = 0; c[2] = 0; }
    else if (b === "minor") { c[1]++; c[2] = 0; }
    else { c[2]++; }
    console.log(c.join("."));
  ' "$BUMP")"
fi

# ── Infer the target from the notes files themselves ───────────────────────
# The convention-named notes file IS the declaration of intent: when no
# explicit --set-version / --patch / --minor / --major was given, scan
# $CHAMA_COMMIT_DIR for chama-vX.Y.Z_release_notes versions GREATER than the
# current package.json version and target the highest one. Stale notes from
# already-shipped releases (<= current) are ignored automatically; an
# accidental future-versioned file is surfaced loudly here and again at the
# Proceed prompt before anything mutates.
if [ -z "$SET_VERSION" ] && [ "$BUMP_EXPLICIT" != "1" ]; then
  INFERRED="$(node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const cur = process.argv[2].split(".").map(Number);
    const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
    let best = null, files = [];
    try { files = fs.readdirSync(dir); } catch { process.exit(0); }
    for (const f of files) {
      const m = /^chama-v(\d+)\.(\d+)\.(\d+)_release_notes$/.exec(f);
      if (!m) continue;
      const v = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (cmp(v, cur) <= 0) continue;
      if (!best || cmp(v, best) > 0) best = v;
    }
    if (best) console.log(best.join("."));
  ' "$CHAMA_COMMIT_DIR" "$CURRENT_VERSION")"
  if [ -n "$INFERRED" ] && [ "$INFERRED" != "$NEW_VERSION" ]; then
    NEW_VERSION="$INFERRED"
    # Route the bump through the exact-version branch — otherwise step 1
    # would still run `npm version patch` and trip the post-bump guard.
    SET_VERSION="$NEW_VERSION"
    echo "📝 Targeting v$NEW_VERSION — inferred from $CHAMA_COMMIT_DIR/chama-v${NEW_VERSION}_release_notes"
    echo "   (newest future-versioned notes file; pass --set-version or --patch/--minor/--major to override)"
  elif [ -z "$INFERRED" ] \
    && [ -f "$CHAMA_COMMIT_DIR/chama-v${CURRENT_VERSION}_release_notes" ] \
    && ! git rev-parse -q --verify "refs/tags/v$CURRENT_VERSION" >/dev/null; then
    # Resume: package.json already declares an UNTAGGED version whose notes
    # exist — a previous run bumped and then died (lock file, ctrl-C, power).
    # Plain `npm run ship` picks that release back up instead of aiming a
    # phantom --patch one version past it.
    NEW_VERSION="$CURRENT_VERSION"
    SET_VERSION="$NEW_VERSION"
    echo "📝 Resuming v$NEW_VERSION — package.json already declares it, the tag doesn't exist yet,"
    echo "   and $CHAMA_COMMIT_DIR/chama-v${NEW_VERSION}_release_notes is present."
  fi
fi

# ── Resolve the convention-named notes files ──────────────────────────────
REL_NOTES="$CHAMA_COMMIT_DIR/chama-v${NEW_VERSION}_release_notes"
ZAP_NOTES="$CHAMA_COMMIT_DIR/chama-v${NEW_VERSION}_zapstore_notes"

if [ ! -f "$REL_NOTES" ]; then
  echo "❌ Required release-notes file not found:"
  echo "   $REL_NOTES"
  echo "   Save the file Claude produced for v$NEW_VERSION there and re-run."
  echo "   (Targeting v$NEW_VERSION from v$CURRENT_VERSION via --$BUMP${SET_VERSION:+ / --set-version}.)"
  exit 1
fi

HAVE_ZAP=0
[ -f "$ZAP_NOTES" ] && HAVE_ZAP=1

# Start9 lane runs automatically when its prepared current.ts is present —
# the file's existence is the opt-in, exactly like the notes-file inference.
S9_NOTES="$CHAMA_COMMIT_DIR/chama-v${NEW_VERSION}_startos_current.ts"
HAVE_S9=0
[ "$DO_START9" = "1" ] && [ -f "$S9_NOTES" ] && HAVE_S9=1

if [ "$HAVE_ZAP" = "1" ]; then
  node "$ROOT_DIR/scripts/validate-zapstore-notes.mjs" "$ZAP_NOTES"
fi

# Soft guard: the commit subject should name the version we're shipping.
FIRST_LINE="$(head -1 "$REL_NOTES")"
case "$FIRST_LINE" in
  "v${NEW_VERSION} "*|"v${NEW_VERSION}") : ;;
  *) echo "⚠️  $REL_NOTES line 1 doesn't start with \"v$NEW_VERSION\":"
     echo "     $FIRST_LINE"
     echo "    (Continuing — git commits the file verbatim; just flagging a possible version mismatch.)" ;;
esac

# ── Assemble the release:all flag list (overridable) ──────────────────────
if [ -n "${CHAMA_RELEASE_FLAGS:-}" ]; then
  # shellcheck disable=SC2206
  RELEASE_FLAGS=($CHAMA_RELEASE_FLAGS)
else
  RELEASE_FLAGS=(--github-release --clobber --zapstore --gpg-key "$CHAMA_GPG_KEY" --notes-file "$REL_NOTES")
  [ "$HAVE_ZAP" = "1" ] && RELEASE_FLAGS+=(--zapstore-notes-file "$ZAP_NOTES")
fi

# ── Pre-flight: catch a missing zsp / SIGN_WITH BEFORE we bump & commit ────
# release:all only reaches the Zapstore publish at the very end — after the
# commit, push, web deploy and GitHub release have already run. A missing zsp
# there leaves a half-published release (everything but Zapstore). Detect it
# now so it shows in the plan, before anything is mutated.
PREFLIGHT_WARN=""
if [ "$DO_RELEASE" = "1" ] && [ "${#RELEASE_FLAGS[@]}" -gt 0 ] && \
   printf '%s\n' "${RELEASE_FLAGS[@]}" | grep -qx -- "--zapstore"; then
  if { [ -n "${CHAMA_ZSP_BIN:-}" ] && [ -x "${CHAMA_ZSP_BIN:-}" ]; } || command -v zsp >/dev/null 2>&1; then
    :
  else
    PREFLIGHT_WARN="${PREFLIGHT_WARN}    - no zsp binary found — set CHAMA_ZSP_BIN=/path/to/zsp (or install zsp)\n"
  fi
  if [ -z "${SIGN_WITH:-}" ]; then
    PREFLIGHT_WARN="${PREFLIGHT_WARN}    - SIGN_WITH is unset — Zapstore publish needs it (e.g. SIGN_WITH=browser)\n"
  fi
fi

# ── Show the plan ─────────────────────────────────────────────────────────
if [ -n "$SET_VERSION" ]; then BUMP_LABEL="--set-version $SET_VERSION"; else BUMP_LABEL="--$BUMP"; fi
echo "── Chama ship plan ─────────────────────────────────────────────"
echo "  from version : v$CURRENT_VERSION"
echo "  target       : v$NEW_VERSION   ($BUMP_LABEL)"
echo "  release notes: $REL_NOTES"
echo "  zapstore note: $([ "$HAVE_ZAP" = 1 ] && echo "$ZAP_NOTES" || echo "(none — release:all writes its placeholder)")"
echo "  push to main : $([ "$DO_PUSH" = 1 ] && echo yes || echo "no (--no-push)")"
echo "  full release : $([ "$DO_RELEASE" = 1 ] && echo yes || echo "no (--no-release)")"
echo "  start9 PR    : $([ "$HAVE_S9" = 1 ] && echo "yes ($S9_NOTES)" || echo "no (no chama-v${NEW_VERSION}_startos_current.ts$([ "$DO_START9" = 0 ] && echo ", --no-start9"))")"
echo "  steps:"
if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  echo "    1) keep existing untagged package version $NEW_VERSION"
else
  echo "    1) npm version $([ -n "$SET_VERSION" ] && echo "$SET_VERSION" || echo "$BUMP") --no-git-tag-version"
fi
echo "    2) git add -A && git commit -F \"$REL_NOTES\"$([ "$DO_PUSH" = 1 ] && echo " && git push origin main")"
[ "$DO_RELEASE" = 1 ] && echo "    3) npm run release:all -- ${RELEASE_FLAGS[*]}"
[ "$HAVE_S9" = 1 ] && echo "    4) scripts/start9-release.sh --tag v$NEW_VERSION   (submodule pin + PR to Start9-Community/chama-startos)"
if [ -n "$PREFLIGHT_WARN" ]; then
  echo "  ⚠️  zapstore pre-flight (commit/push/web/GitHub still succeed — only the Zapstore step would fail at the end):"
  printf '%b' "$PREFLIGHT_WARN"
fi
echo "────────────────────────────────────────────────────────────────"

if [ "$DRY" = "1" ]; then
  echo "↷ --dry-run: nothing executed."
  exit 0
fi

if [ "$ASSUME_YES" != "1" ]; then
  read -p "Proceed? [y/N] " confirm
  [ "$confirm" = "y" ] || { echo "Aborted."; exit 1; }
fi

# ── 1. Bump package.json (no tag — release.sh --current tags later) ───────
echo "🔧 npm version → v$NEW_VERSION"
if [ "$NEW_VERSION" = "$CURRENT_VERSION" ]; then
  if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
    echo "❌ v$NEW_VERSION is already tagged; refusing to re-ship it."
    exit 1
  fi
  echo "↷ package files already declare v$NEW_VERSION; keeping the untagged release version."
elif [ -n "$SET_VERSION" ]; then
  npm version "$SET_VERSION" --no-git-tag-version >/dev/null
else
  npm version "$BUMP" --no-git-tag-version >/dev/null
fi
APPLIED="$(node -p "require('./package.json').version")"
if [ "$APPLIED" != "$NEW_VERSION" ]; then
  echo "❌ Post-bump version mismatch: package.json is $APPLIED, expected $NEW_VERSION."
  echo "   Reverting package.json/package-lock.json."
  git checkout -- package.json package-lock.json 2>/dev/null || true
  exit 1
fi

# Keep Tauri metadata in lockstep. Since v2.8.0, src-tauri/tauri.conf.json
# points its version at ../package.json (Tauri reads the field from that
# file), so it is STRUCTURALLY in sync and must be left alone — the v2.8.0
# desktop CI gates failed precisely because this step regex-stomped the
# pointer with a literal version and the workflow's version guard caught the
# disagreement. Only legacy literal versions still get the targeted rewrite.
node -e '
  const fs = require("fs");
  const v = require("./package.json").version;
  const p = "src-tauri/tauri.conf.json";
  let s = fs.readFileSync(p, "utf8");
  if (/"version"\s*:\s*"\.\.\/package\.json"/.test(s)) {
    console.log("   tauri.conf.json points at package.json — self-syncing, untouched.");
    process.exit(0);
  }
  const next = s.replace(/("version"\s*:\s*")[^"]+(")/, "$1" + v + "$2");
  if (next !== s) { fs.writeFileSync(p, next); console.log("   synced tauri.conf.json -> v" + v); }
  else if (!s.includes("\"version\": \"" + v + "\"")) { process.exit(1); }
' || echo "   ⚠ tauri.conf.json version sync failed — sync it manually before desktop builds."

# ── 2. Commit everything with the release-notes file, then push ───────────
echo "📦 git add -A && git commit -F $REL_NOTES"
git add -A
git commit -F "$REL_NOTES"
if [ "$DO_PUSH" = "1" ]; then
  echo "⬆️  git push origin main"
  git push origin main
fi

# ── 3. Full release lane (web deploy + APK + GitHub + Zapstore) ───────────
if [ "$DO_RELEASE" = "1" ]; then
  echo "🚀 npm run release:all -- ${RELEASE_FLAGS[*]}"
  npm run release:all -- "${RELEASE_FLAGS[@]}"
fi

# ── 4. Start9 lane: pin the packaging submodule and open the PR ───────────
if [ "$HAVE_S9" = "1" ] && [ "$DO_RELEASE" = "1" ]; then
  echo "📦 scripts/start9-release.sh --tag v$NEW_VERSION"
  CHAMA_COMMIT_DIR="$CHAMA_COMMIT_DIR" "$ROOT_DIR/scripts/start9-release.sh" --tag "v$NEW_VERSION" \
    || echo "⚠️  Start9 lane failed — everything else shipped. Re-run alone with: npm run ship -- --only start9 --tag v$NEW_VERSION"
fi

echo "✅ Shipped v$NEW_VERSION"
