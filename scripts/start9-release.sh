#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════
# Chama — start9-release.sh: the Start9 distribution lane
# ══════════════════════════════════════════════════════════════════════════
#
# For an ALREADY-TAGGED application release vX.Y.Z, this script updates the
# StartOS packaging repo and opens the community PR — the whole Start9 story
# in one command:
#
#   1. clone/refresh the packaging checkout (fork of Start9-Community/
#      chama-startos) into $CHAMA_STARTOS_DIR
#   2. branch chama-vX.Y.Z from upstream/main
#   3. pin the chama/ submodule to the signed vX.Y.Z tag
#   4. install the prepared startos/versions/current.ts
#      ($CHAMA_COMMIT_DIR/chama-vX.Y.Z_startos_current.ts — five-locale
#      release notes, written per UPDATING.md in the packaging repo)
#   5. commit, push to the fork, `gh pr create` against upstream main
#
# Merging that PR triggers the packaging repo's tagAndRelease workflow, which
# builds/signs the .s9pk and publishes to the community registry — nothing to
# build locally.
#
# Usage:
#   ./scripts/start9-release.sh --tag v6.3.0
#   ./scripts/start9-release.sh                # tag = v<package.json version>
#   ./scripts/start9-release.sh --dry-run --tag v6.3.0
#   npm run ship -- --only start9 --tag v6.3.0
#
# Env (defaults match the maintainer):
#   CHAMA_COMMIT_DIR       notes dir (default: <repo>/release-notes, else /tmp)
#   CHAMA_STARTOS_DIR      packaging checkout (default: ~/start9-workspace/chama-startos)
#   CHAMA_STARTOS_UPSTREAM upstream repo        (default: Start9-Community/chama-startos)
#   CHAMA_STARTOS_FORK     fork to push to      (default: jesuspirate/chama-startos)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

UPSTREAM="${CHAMA_STARTOS_UPSTREAM:-Start9-Community/chama-startos}"
FORK="${CHAMA_STARTOS_FORK:-jesuspirate/chama-startos}"
S9_DIR="${CHAMA_STARTOS_DIR:-$HOME/start9-workspace/chama-startos}"
if [ -z "${CHAMA_COMMIT_DIR:-}" ] && [ -d "$ROOT_DIR/release-notes" ]; then
  CHAMA_COMMIT_DIR="$ROOT_DIR/release-notes"
fi
CHAMA_COMMIT_DIR="${CHAMA_COMMIT_DIR:-/tmp}"

TAG=""
DRY=0
while [ $# -gt 0 ]; do
  case "${1:-}" in
    --tag) TAG="${2:?--tag needs vX.Y.Z}"; shift 2 ;;
    --dry-run|-n) DRY=1; shift ;;
    -h|--help) sed -n '4,38p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "❌ Unknown option: $1"; exit 1 ;;
  esac
done
[ -n "$TAG" ] || TAG="v$(node -p "require('./package.json').version")"
case "$TAG" in v[0-9]*.[0-9]*.[0-9]*) : ;; *) echo "❌ --tag must look like vX.Y.Z (got: $TAG)"; exit 1 ;; esac
VER="${TAG#v}"

S9_NOTES="$CHAMA_COMMIT_DIR/chama-${TAG}_startos_current.ts"
BRANCH="chama-$TAG"

# ── Local pre-flight (also runs under --dry-run) ──────────────────────────
[ -f "$S9_NOTES" ] || {
  echo "❌ Prepared StartOS current.ts not found: $S9_NOTES"
  echo "   (five-locale release notes per the packaging repo's UPDATING.md)"
  exit 1
}
grep -q "version: '$VER:" "$S9_NOTES" || {
  echo "❌ $S9_NOTES does not declare version '$VER:<revision>'"; exit 1;
}

echo "── Start9 lane plan ────────────────────────────────────────────"
echo "  app tag   : $TAG"
echo "  notes     : $S9_NOTES"
echo "  checkout  : $S9_DIR"
echo "  branch    : $BRANCH  (fork: $FORK → PR: $UPSTREAM)"
echo "────────────────────────────────────────────────────────────────"
if [ "$DRY" = "1" ]; then echo "↷ --dry-run: nothing executed."; exit 0; fi

# ── Remote pre-flight (needs the network and gh; skipped in dry-run) ──────
command -v gh >/dev/null 2>&1 || { echo "❌ gh CLI is required (brew install gh)"; exit 1; }
if ! git ls-remote --tags "https://github.com/jesuspirate/chama" "$TAG" | grep -q "$TAG"; then
  echo "❌ Tag $TAG is not on github.com/jesuspirate/chama yet — release the app first."
  exit 1
fi

# ── Checkout: clone once, then reuse forever ──────────────────────────────
if [ ! -d "$S9_DIR/.git" ]; then
  mkdir -p "$(dirname "$S9_DIR")"
  echo "📥 Cloning $FORK → $S9_DIR"
  if ! git clone "git@github.com:$FORK.git" "$S9_DIR" 2>/dev/null; then
    echo "   fork clone failed — forking $UPSTREAM with gh…"
    gh repo fork "$UPSTREAM" --clone -- "$S9_DIR"
  fi
fi
cd "$S9_DIR"
git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/$UPSTREAM.git"
git fetch upstream --quiet
git fetch origin --quiet || true

# The packaging repo's default branch is whatever upstream says it is
# (Start9-Community/chama-startos uses master, not main) — never assume.
BASE_BRANCH="$(git ls-remote --symref "https://github.com/$UPSTREAM.git" HEAD 2>/dev/null | sed -n 's|^ref: refs/heads/\(.*\)[[:space:]]HEAD$|\1|p')"
if [ -z "$BASE_BRANCH" ]; then
  if git rev-parse -q --verify upstream/master >/dev/null; then BASE_BRANCH=master
  elif git rev-parse -q --verify upstream/main >/dev/null; then BASE_BRANCH=main
  else echo "❌ Cannot determine $UPSTREAM's default branch."; exit 1; fi
fi

# Refuse to clobber unrelated local work; the branch itself may be re-run.
if [ -n "$(git status --porcelain)" ]; then
  echo "❌ $S9_DIR has uncommitted changes — resolve them first."; exit 1
fi
git checkout -B "$BRANCH" "upstream/$BASE_BRANCH" --quiet

# ── Pin the submodule at the release tag ──────────────────────────────────
echo "📌 Pinning chama/ submodule to $TAG"
git submodule update --init chama --quiet
git -C chama fetch --tags origin --quiet
git -C chama checkout "$TAG" --quiet
git add chama

# ── Install the prepared version file ─────────────────────────────────────
cp "$S9_NOTES" startos/versions/current.ts
git add startos/versions/current.ts

if git diff --cached --quiet; then
  echo "↷ Nothing to commit — $UPSTREAM already packages $TAG."; exit 0
fi
git commit -m "chore: update Chama to $VER" --quiet
echo "⬆️  git push origin $BRANCH"
git push -u origin "$BRANCH" --force-with-lease --quiet

# ── Open (or find) the PR ─────────────────────────────────────────────────
FORK_OWNER="${FORK%%/*}"
EXISTING="$(gh pr list --repo "$UPSTREAM" --head "$FORK_OWNER:$BRANCH" --json url -q '.[0].url' 2>/dev/null || true)"
if [ -n "$EXISTING" ]; then
  echo "✅ PR already open: $EXISTING"
  exit 0
fi
BODY_FILE="$(mktemp)"
{
  echo "Pins the \`chama/\` submodule to the signed [\`$TAG\`](https://github.com/jesuspirate/chama/releases/tag/$TAG) application release and updates \`startos/versions/current.ts\` to \`$VER:0\` with release notes in all five locales."
  echo
  echo "No \`/data\` layout change — \`migrations.up\` stays empty per UPDATING.md."
  echo
  echo "🤖 Generated with [Claude Code](https://claude.com/claude-code)"
} > "$BODY_FILE"
PR_URL="$(gh pr create --repo "$UPSTREAM" --base "$BASE_BRANCH" --head "$FORK_OWNER:$BRANCH" \
  --title "Update Chama to $VER" --body-file "$BODY_FILE")"
rm -f "$BODY_FILE"
echo "✅ Start9 PR: $PR_URL"
