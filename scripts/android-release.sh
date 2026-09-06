#!/bin/bash
set -euo pipefail

# Builds a signed Android release APK when android/keystore.properties or the
# CHAMA_ANDROID_* environment variables are configured.
#
# Usage:
#   ./scripts/android-release.sh
#   ./scripts/android-release.sh --github-release
#   ./scripts/android-release.sh --github-release --clobber
#   ./scripts/android-release.sh --no-build --release-dir /tmp/chama-v1.0.1-assets
#   ./scripts/android-release.sh --skip-web-gate --github-release
#   ./scripts/android-release.sh --sign-checksum
#   ./scripts/android-release.sh --no-sign-checksum
#   ./scripts/android-release.sh --gpg-key <key-id-or-fingerprint>
#   ./scripts/android-release.sh --pgp-public-key-url https://example.com/key.asc
#   SIGN_WITH=browser ./scripts/android-release.sh --zapstore
#   SIGN_WITH=bunker://... ./scripts/android-release.sh --github-release --zapstore
#   SIGN_WITH=browser ./scripts/android-release.sh --no-build --zapstore --preserve-zapstore-notes
#
# Default mode builds the APK and prepares release assets in /private/tmp.
# --github-release uploads those assets to the matching GitHub tag/release.
# --zapstore publishes the APK through zsp after the APK and optional GitHub
# release steps pass. Set CHAMA_ZSP_BIN to use a non-PATH zsp binary.
# --skip-web-gate assumes npm predeploy/build already passed in this shell,
# and only syncs Capacitor + builds/verifies the APK.
# Checksum signing is automatic when gpg has a secret key available.
# Use --gpg-key or CHAMA_RELEASE_GPG_KEY to pin a specific signing key.
# Use --pgp-public-key-url or CHAMA_RELEASE_PGP_PUBLIC_KEY_URL to set the
# optional verification key linked in generated release notes. The release
# signing public key is also exported into the release assets.
# Set CHAMA_RELEASE_REQUIRE_ASC=1 to fail if app-release.apk.sha256.asc
# is missing.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
KEYSTORE_PROPS="$ANDROID_DIR/keystore.properties"
APK_PATH="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
UPLOAD_GITHUB=0
PUBLISH_ZAPSTORE=0
ZAPSTORE_OVERWRITE=0
PRESERVE_ZAPSTORE_NOTES=0
BUILD_APK=1
RUN_WEB_GATE=1
CLOBBER=0
TAG=""
REPO="${GITHUB_REPOSITORY:-}"
RELEASE_DIR=""
NOTES_FILE=""
SIGN_CHECKSUM="auto"
RELEASE_PGP_KEY_ID="${CHAMA_RELEASE_GPG_KEY:-}"
RELEASE_PGP_PUBLIC_KEY_URL="${CHAMA_RELEASE_PGP_PUBLIC_KEY_URL:-}"
ZAPSTORE_CONFIG="${CHAMA_ZAPSTORE_CONFIG:-zapstore.yaml}"
# Optional: short user-facing notes shown in the Zapstore app card.
# Different audience from the long engineering NOTES_FILE that feeds
# the GitHub Release body. When unset, publish_zapstore_release
# writes a placeholder pointing readers at the GitHub release.
ZAPSTORE_NOTES_FILE=""
# Path the populated short-notes file must live at — this matches the
# `release_notes:` value in zapstore.yaml so zsp picks it up.
ZAPSTORE_NOTES_TARGET="$ROOT_DIR/zapstore/release-notes.md"

cd "$ROOT_DIR"

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
}

default_repo() {
  local url
  url=$(git config --get remote.origin.url 2>/dev/null || true)
  url="${url%.git}"
  if [[ "$url" == git@github.com:* ]]; then
    echo "${url#git@github.com:}"
  elif [[ "$url" == https://github.com/* ]]; then
    echo "${url#https://github.com/}"
  fi
}

assert_release_tag_signed() {
  local tag="$1"
  local ref="refs/tags/$tag"
  local type
  type=$(git cat-file -t "$ref")
  if [ "$type" != "tag" ]; then
    echo "❌ Local tag $tag is lightweight, not a signed annotated tag."
    echo "   Run ./scripts/release.sh --current first, or recreate it with:"
    echo "     git tag -s $tag <commit-sha> -m \"$tag\""
    exit 1
  fi
  if ! git cat-file tag "$ref" | grep -q -- "-----BEGIN PGP SIGNATURE-----"; then
    echo "❌ Local tag $tag is annotated but not signed."
    echo "   Run ./scripts/release.sh --current first, or recreate it with:"
    echo "     git tag -s $tag <commit-sha> -m \"$tag\""
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

android_sdk_dir() {
  if [ -n "${ANDROID_HOME:-}" ]; then
    echo "$ANDROID_HOME"
  elif [ -n "${ANDROID_SDK_ROOT:-}" ]; then
    echo "$ANDROID_SDK_ROOT"
  elif [ -d "$HOME/Library/Android/sdk" ]; then
    echo "$HOME/Library/Android/sdk"
  fi
}

android_build_tool() {
  local tool="$1"
  local sdk
  sdk=$(android_sdk_dir)
  if [ -z "$sdk" ] || [ ! -d "$sdk/build-tools" ]; then
    return 0
  fi

  find "$sdk/build-tools" -type f -name "$tool" 2>/dev/null | sort | tail -n 1
}

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file"
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file"
  else
    echo "❌ shasum or sha256sum is required to write checksums."
    exit 1
  fi
}

has_gpg_secret_key() {
  command -v gpg >/dev/null 2>&1 || return 1

  if [ -n "$RELEASE_PGP_KEY_ID" ]; then
    gpg --list-secret-keys --with-colons "$RELEASE_PGP_KEY_ID" 2>/dev/null | grep -q '^sec'
  else
    gpg --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec'
  fi
}

effective_gpg_key() {
  if [ -n "$RELEASE_PGP_KEY_ID" ]; then
    echo "$RELEASE_PGP_KEY_ID"
    return 0
  fi

  command -v gpg >/dev/null 2>&1 || return 1
  gpg --list-secret-keys --with-colons 2>/dev/null | awk -F: '$1 == "fpr" { print $10; exit }'
}

verify_checksum_signature() {
  if [ ! -f "$ASC_FILE" ]; then
    return 1
  fi

  if grep -q '^-----BEGIN PGP SIGNED MESSAGE-----' "$ASC_FILE"; then
    local signed_payload
    signed_payload=$(
      awk '
        BEGIN { body = 0 }
        /^$/ && body == 0 { body = 1; next }
        /^-----BEGIN PGP SIGNATURE-----/ { exit }
        body == 1 { print }
      ' "$ASC_FILE"
    )
    [ "$signed_payload" = "$(cat "$SHA_FILE")" ]
    return $?
  fi

  if command -v gpg >/dev/null 2>&1; then
    gpg --verify "$ASC_FILE" "$SHA_FILE" >/dev/null 2>&1
  else
    return 1
  fi
}

write_default_release_notes() {
  local notes_path="$1"
  cat > "$notes_path" <<EOF
Chama $TAG release assets.

Included:
- Signed Android APK with the native Rust Fedimint bridge.
- SHA-256 checksum, optional OpenPGP checksum signature, and signing-certificate report.

Verification:
- Download \`app-release.apk\`, \`app-release.apk.sha256\`,
  \`app-release.apk.sha256.asc\`, and \`chama-release-pgp-key.asc\`.
- Verify the checksum signature:
  \`\`\`sh
  gpg --import chama-release-pgp-key.asc
  gpg --verify app-release.apk.sha256.asc app-release.apk.sha256
  shasum -a 256 -c app-release.apk.sha256
  \`\`\`
$(
  if [ -n "$RELEASE_PGP_PUBLIC_KEY_URL" ]; then
    cat <<URLNOTE

Public PGP key URL:
- $RELEASE_PGP_PUBLIC_KEY_URL
URLNOTE
  fi
)

The APK is also verified by Android APK signing before upload; see \`app-release.apk.apksigner.txt\`.
EOF
}

maybe_sign_checksum() {
  if verify_checksum_signature; then
    echo "✅ Checksum signature matches: $ASC_FILE"
    return 0
  fi

  if [ -f "$ASC_FILE" ]; then
    STALE_ASC="$ASC_FILE.stale.$(date +%s)"
    mv "$ASC_FILE" "$STALE_ASC"
    echo "⚠️  Existing checksum signature did not match; moved it to $STALE_ASC"
  fi

  if [ "$SIGN_CHECKSUM" = "no" ]; then
    echo "↷ Skipping checksum signature because --no-sign-checksum was passed."
    return 0
  fi

  if ! has_gpg_secret_key; then
    if [ "$SIGN_CHECKSUM" = "yes" ] || [ "${CHAMA_RELEASE_REQUIRE_ASC:-}" = "1" ]; then
      echo "❌ No local gpg secret key found, and checksum signature is required."
      exit 1
    fi
    echo "⚠️  No local gpg secret key found; checksum signature not created."
    echo "   Import the release signing key and rerun, or pass --gpg-key <key-id>."
    return 0
  fi

  local gpg_args=(--armor --detach-sign --output "$ASC_FILE")
  if [ -n "$RELEASE_PGP_KEY_ID" ]; then
    gpg_args+=(--local-user "$RELEASE_PGP_KEY_ID")
  fi
  gpg "${gpg_args[@]}" "$SHA_FILE"
  echo "✅ Checksum signature created: $ASC_FILE"
}

export_release_public_key() {
  command -v gpg >/dev/null 2>&1 || return 0

  local key
  key=$(effective_gpg_key || true)
  if [ -z "$key" ]; then
    echo "⚠️  No gpg key available to export as $PUBLIC_KEY_FILE."
    return 0
  fi

  if gpg --armor --export "$key" > "$PUBLIC_KEY_FILE"; then
    echo "✅ Release public key exported: $PUBLIC_KEY_FILE"
  else
    rm -f "$PUBLIC_KEY_FILE"
    echo "⚠️  Could not export release public key for $key."
  fi
}

zsp_bin() {
  if [ -n "${CHAMA_ZSP_BIN:-}" ]; then
    echo "$CHAMA_ZSP_BIN"
    return 0
  fi

  command -v zsp 2>/dev/null || true
}

publish_zapstore_release() {
  local zsp
  zsp=$(zsp_bin)
  if [ -z "$zsp" ] || [ ! -x "$zsp" ]; then
    cat <<'EOF'
❌ zsp CLI is required for --zapstore.

Install once:
  go install github.com/zapstore/zsp@latest

Or download a release binary and run with:
  CHAMA_ZSP_BIN=/path/to/zsp ./scripts/android-release.sh --zapstore
EOF
    exit 1
  fi

  if [ ! -f "$ZAPSTORE_CONFIG" ]; then
    echo "❌ Zapstore config not found: $ZAPSTORE_CONFIG"
    exit 1
  fi

  if [ -z "${SIGN_WITH:-}" ]; then
    cat <<EOF
❌ SIGN_WITH is required for Zapstore publishing.

For local release signing:
  SIGN_WITH=browser ./scripts/android-release.sh --no-build --zapstore

For CI/CD, prefer a NIP-46 bunker URL stored as a secret:
  SIGN_WITH='bunker://...' ./scripts/android-release.sh --github-release --zapstore
EOF
    exit 1
  fi

  # Populate the release-notes file referenced by `release_notes:` in
  # zapstore.yaml. zsp reads metadata from GitHub via metadata_sources,
  # but its GitHub fetch pulls repo-level metadata only — not the
  # release-specific body — so without this step the Zapstore app
  # card shows "No release notes." for every release. The user-facing
  # short notes are intentionally separate from the long engineering
  # notes that feed the GitHub Release body.
  mkdir -p "$(dirname "$ZAPSTORE_NOTES_TARGET")"
  if [ -n "$ZAPSTORE_NOTES_FILE" ]; then
    node "$ROOT_DIR/scripts/validate-zapstore-notes.mjs" "$ZAPSTORE_NOTES_FILE"
    cp "$ZAPSTORE_NOTES_FILE" "$ZAPSTORE_NOTES_TARGET"
    echo "📝 Zapstore notes: $ZAPSTORE_NOTES_FILE → $ZAPSTORE_NOTES_TARGET"
  elif [ "$PRESERVE_ZAPSTORE_NOTES" = "1" ] && [ -f "$ZAPSTORE_NOTES_TARGET" ]; then
    echo "↷ Preserving existing Zapstore notes: $ZAPSTORE_NOTES_TARGET"
  else
    # No short notes provided — write a placeholder pointing at the
    # GitHub Release where the full engineering notes live, so the
    # Zapstore card never falls through to "No release notes." Pick
    # the best repo URL we know (CLI arg, env var, or origin remote).
    local notes_repo="${REPO:-}"
    if [ -z "$notes_repo" ]; then
      notes_repo=$(default_repo)
    fi
    local notes_url="https://github.com/${notes_repo:-jesuspirate/chama}/releases/tag/$TAG"
    cat > "$ZAPSTORE_NOTES_TARGET" <<EOF
$TAG

For full release notes, see:
$notes_url
EOF
    echo "📝 Zapstore notes: placeholder written (pass --zapstore-notes-file for custom notes)"
  fi

  local zapstore_args=(publish "$ZAPSTORE_CONFIG")
  if [ "$ZAPSTORE_OVERWRITE" = "1" ]; then
    zapstore_args+=(--overwrite-release)
  fi

  echo "🚀 Publishing Android release to Zapstore..."
  "$zsp" "${zapstore_args[@]}"
}

while [ $# -gt 0 ]; do
  case "${1:-}" in
    --github-release|--upload-github)
      UPLOAD_GITHUB=1
      shift
      ;;
    --zapstore|--publish-zapstore)
      PUBLISH_ZAPSTORE=1
      shift
      ;;
    --zapstore-overwrite|--overwrite-zapstore)
      ZAPSTORE_OVERWRITE=1
      shift
      ;;
    --preserve-zapstore-notes)
      PRESERVE_ZAPSTORE_NOTES=1
      shift
      ;;
    --no-build)
      BUILD_APK=0
      shift
      ;;
    --skip-web-gate|--skip-predeploy)
      RUN_WEB_GATE=0
      shift
      ;;
    --clobber)
      CLOBBER=1
      shift
      ;;
    --tag)
      TAG="${2:-}"
      if [ -z "$TAG" ]; then
        echo "❌ --tag requires a tag value, for example v1.0.1"
        exit 1
      fi
      shift 2
      ;;
    --repo)
      REPO="${2:-}"
      if [ -z "$REPO" ]; then
        echo "❌ --repo requires owner/repo"
        exit 1
      fi
      shift 2
      ;;
    --release-dir)
      RELEASE_DIR="${2:-}"
      if [ -z "$RELEASE_DIR" ]; then
        echo "❌ --release-dir requires a directory path"
        exit 1
      fi
      shift 2
      ;;
    --notes-file)
      NOTES_FILE="${2:-}"
      if [ -z "$NOTES_FILE" ] || [ ! -f "$NOTES_FILE" ]; then
        echo "❌ --notes-file requires an existing file"
        exit 1
      fi
      shift 2
      ;;
    --zapstore-config)
      ZAPSTORE_CONFIG="${2:-}"
      if [ -z "$ZAPSTORE_CONFIG" ] || [ ! -f "$ZAPSTORE_CONFIG" ]; then
        echo "❌ --zapstore-config requires an existing file"
        exit 1
      fi
      shift 2
      ;;
    --zapstore-notes-file)
      ZAPSTORE_NOTES_FILE="${2:-}"
      if [ -z "$ZAPSTORE_NOTES_FILE" ] || [ ! -f "$ZAPSTORE_NOTES_FILE" ]; then
        echo "❌ --zapstore-notes-file requires an existing file"
        exit 1
      fi
      shift 2
      ;;
    --sign-checksum)
      SIGN_CHECKSUM="yes"
      shift
      ;;
    --no-sign-checksum)
      SIGN_CHECKSUM="no"
      shift
      ;;
    --gpg-key)
      RELEASE_PGP_KEY_ID="${2:-}"
      if [ -z "$RELEASE_PGP_KEY_ID" ]; then
        echo "❌ --gpg-key requires a key id, fingerprint, or email"
        exit 1
      fi
      shift 2
      ;;
    --pgp-public-key-url)
      RELEASE_PGP_PUBLIC_KEY_URL="${2:-}"
      if [ -z "$RELEASE_PGP_PUBLIC_KEY_URL" ]; then
        echo "❌ --pgp-public-key-url requires a URL"
        exit 1
      fi
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "❌ Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

if [ ! -f "$KEYSTORE_PROPS" ] && {
  [ -z "${CHAMA_ANDROID_STORE_FILE:-}" ] ||
  [ -z "${CHAMA_ANDROID_STORE_PASSWORD:-}" ] ||
  [ -z "${CHAMA_ANDROID_KEY_ALIAS:-}" ] ||
  [ -z "${CHAMA_ANDROID_KEY_PASSWORD:-}" ]
}; then
  cat <<'EOF'
❌ Android release signing is not configured.

Create android/keystore.properties from android/keystore.properties.example,
or provide these environment variables:
  CHAMA_ANDROID_STORE_FILE
  CHAMA_ANDROID_STORE_PASSWORD
  CHAMA_ANDROID_KEY_ALIAS
  CHAMA_ANDROID_KEY_PASSWORD
EOF
  exit 1
fi

VERSION=$(node -p "require('./package.json').version")
TAG="${TAG:-v$VERSION}"
REPO="${REPO:-$(default_repo)}"
EXPECTED_ANDROID_ABI="${CHAMA_ANDROID_ABI:-arm64-v8a}"
ABI_RELEASE_SUFFIX=""
if [ "$EXPECTED_ANDROID_ABI" != "arm64-v8a" ]; then
  ABI_RELEASE_SUFFIX="-$EXPECTED_ANDROID_ABI"
fi
RELEASE_DIR="${RELEASE_DIR:-/private/tmp/chama-$TAG$ABI_RELEASE_SUFFIX-release-assets}"
RELEASE_APK="$RELEASE_DIR/app-release.apk"
SHA_FILE="$RELEASE_DIR/app-release.apk.sha256"
ASC_FILE="$SHA_FILE.asc"
SIGNER_FILE="$RELEASE_DIR/app-release.apk.apksigner.txt"
PUBLIC_KEY_FILE="$RELEASE_DIR/chama-release-pgp-key.asc"

# ── Locate a usable JDK (gradle needs one; macOS's /usr/bin/java is only a
# stub that prints "Unable to locate a Java Runtime"). A stale JAVA_HOME from
# a shell profile is re-validated rather than trusted, then the usual homes
# are probed: the system resolver, Android Studio's bundled JBR, Homebrew
# OpenJDK/Temurin, and /Library JVMs. Failing all of those aborts BEFORE the
# gradle build with install instructions instead of the cryptic stub.
java_home_ok() { [ -n "${1:-}" ] && [ -x "$1/bin/java" ] && "$1/bin/java" -version >/dev/null 2>&1; }
if ! java_home_ok "${JAVA_HOME:-}"; then
  JAVA_HOME=""
  for jdk_candidate in \
    "$(/usr/libexec/java_home 2>/dev/null || true)" \
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
    /opt/homebrew/opt/openjdk*/libexec/openjdk.jdk/Contents/Home \
    /usr/local/opt/openjdk*/libexec/openjdk.jdk/Contents/Home \
    /Library/Java/JavaVirtualMachines/*/Contents/Home; do
    if java_home_ok "$jdk_candidate"; then JAVA_HOME="$jdk_candidate"; break; fi
  done
fi
if java_home_ok "${JAVA_HOME:-}"; then
  export JAVA_HOME
  export PATH="$JAVA_HOME/bin:$PATH"
  echo "☕ Using JDK at $JAVA_HOME"
elif [ "$BUILD_APK" = "1" ]; then
  echo "❌ No usable Java runtime found — the Android build needs a JDK."
  echo "   Install one (either works), then re-run:"
  echo "     brew install --cask temurin       # standalone JDK"
  echo "     …or install Android Studio (bundles a JDK at Contents/jbr)"
  exit 1
fi

if [ "$BUILD_APK" = "1" ]; then
  if [ "$RUN_WEB_GATE" = "1" ]; then
    echo "🔎 Running web predeploy gate..."
    npm run predeploy

    echo "🔎 Building web bundle..."
    npm run build
  else
    echo "↷ Skipping web predeploy/build because --skip-web-gate was passed."
  fi

  echo "🔁 Syncing Capacitor Android assets..."
  npx cap sync android

  echo "📦 Building signed release APK..."
  (
    cd "$ANDROID_DIR"
    ./gradlew :app:assembleRelease --no-daemon
  )
else
  echo "↷ Skipping APK build because --no-build was passed."
fi

if [ ! -f "$APK_PATH" ]; then
  echo "❌ Expected APK not found: $APK_PATH"
  exit 1
fi

# A normal Chama APK is currently about 53 MiB. Refuse a surprising payload
# increase before anything can be signed or uploaded (v5.0.0 reached 139 MiB
# after draft images were accidentally placed under public/).
APK_BYTES=$(stat -f '%z' "$APK_PATH")
APK_LIMIT_BYTES=$((75 * 1024 * 1024))
if [ "$APK_BYTES" -gt "$APK_LIMIT_BYTES" ]; then
  APK_MIB=$((APK_BYTES / 1024 / 1024))
  echo "❌ Release APK is ${APK_MIB} MiB; safety limit is 75 MiB."
  echo "   Check public/ and the APK asset listing before publishing."
  exit 1
fi

mkdir -p "$RELEASE_DIR"
cp "$APK_PATH" "$RELEASE_APK"
if command -v unzip >/dev/null 2>&1; then
  APK_LISTING=$(unzip -l "$RELEASE_APK")
  if ! grep -q "lib/$EXPECTED_ANDROID_ABI/libchama_fedimint_bridge.so" <<<"$APK_LISTING"; then
    echo "❌ Release APK is missing the native Fedimint bridge binary."
    echo "   Refusing to prepare Zapstore assets that would fall back to the browser SDK path."
    exit 1
  fi
  if ! grep -q "lib/$EXPECTED_ANDROID_ABI/libc++_shared.so" <<<"$APK_LISTING"; then
    echo "❌ Release APK is missing libc++_shared.so."
    echo "   The native Fedimint bridge links against the Android C++ runtime and will not start without it."
    exit 1
  fi
  echo "✅ Native Fedimint bridge packaged in APK."
  echo "✅ Android C++ runtime packaged in APK."
else
  echo "⚠️  unzip not found; skipping native bridge package verification."
fi
PREVIOUS_SHA=""
if [ -f "$SHA_FILE" ]; then
  PREVIOUS_SHA=$(cat "$SHA_FILE")
fi
(
  cd "$RELEASE_DIR"
  sha256_file "app-release.apk" > "app-release.apk.sha256"
)
CURRENT_SHA=$(cat "$SHA_FILE")
if [ -f "$ASC_FILE" ] && [ -n "$PREVIOUS_SHA" ] && [ "$PREVIOUS_SHA" != "$CURRENT_SHA" ]; then
  STALE_ASC="$ASC_FILE.stale.$(date +%s)"
  mv "$ASC_FILE" "$STALE_ASC"
  echo "⚠️  Checksum changed; moved stale signature to $STALE_ASC"
fi

AAPT=$(android_build_tool aapt2)
if [ -n "$AAPT" ]; then
  BADGING=$("$AAPT" dump badging "$RELEASE_APK" 2>/dev/null || true)
  if [ -n "$BADGING" ]; then
    if ! grep -q "versionName='$VERSION'" <<<"$BADGING"; then
      echo "❌ APK versionName does not match package.json version $VERSION."
      echo "$BADGING" | head -n 1
      exit 1
    fi
    echo "✅ APK metadata: $(echo "$BADGING" | head -n 1)"
  fi
else
  echo "⚠️  aapt2 not found; skipping APK metadata verification."
fi

APKSIGNER=$(android_build_tool apksigner)
if [ -n "$APKSIGNER" ]; then
  "$APKSIGNER" verify --print-certs "$RELEASE_APK" > "$SIGNER_FILE"
  CERT_LINE=$(grep "Signer #1 certificate SHA-256 digest:" "$SIGNER_FILE" || true)
  if [ -n "$CERT_LINE" ]; then
    echo "✅ APK signing: $CERT_LINE"
  else
    echo "✅ APK signing verified."
  fi
else
  echo "⚠️  apksigner not found; skipping APK signing verification."
fi

maybe_sign_checksum
export_release_public_key

echo "✅ Release assets prepared:"
echo "   $RELEASE_APK"
echo "   $SHA_FILE"
if [ -f "$ASC_FILE" ]; then
  echo "   $ASC_FILE"
else
  echo "   $ASC_FILE (missing; add it manually or import a gpg secret key)"
fi
if [ -f "$PUBLIC_KEY_FILE" ]; then
  echo "   $PUBLIC_KEY_FILE"
fi
if [ -n "$RELEASE_PGP_PUBLIC_KEY_URL" ]; then
  echo "   public key URL: $RELEASE_PGP_PUBLIC_KEY_URL"
fi
if [ -f "$SIGNER_FILE" ]; then
  echo "   $SIGNER_FILE"
fi

if [ "$UPLOAD_GITHUB" = "0" ]; then
  echo "↷ Skipping GitHub upload. Pass --github-release to upload assets."
  if [ "$PUBLISH_ZAPSTORE" = "1" ]; then
    publish_zapstore_release
  fi
  exit 0
fi

if [ -z "$REPO" ]; then
  echo "❌ Could not infer GitHub repo. Pass --repo owner/repo."
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  cat <<EOF
❌ GitHub CLI is required for --github-release.

Install/auth once:
  brew install gh
  gh auth login

Then run:
  ./scripts/android-release.sh --no-build --github-release --repo $REPO --tag $TAG
EOF
  exit 1
fi

COMMIT_SHA=$(git rev-parse HEAD)
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "❌ Local tag $TAG does not exist."
  if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
    echo "   The working tree is dirty, so commit and push this version before tagging:"
    git status --short
    echo "   Then run:"
    echo "     ./scripts/release.sh --current --no-deploy"
    echo "     ./scripts/android-release.sh --no-build --github-release --clobber"
  else
    echo "   Run ./scripts/release.sh --current first."
  fi
  exit 1
fi

assert_release_tag_signed "$TAG"

TAG_SHA=$(git rev-list -n 1 "$TAG")
if [ "$TAG_SHA" != "$COMMIT_SHA" ]; then
  if [ "$BUILD_APK" = "1" ]; then
    echo "❌ Local tag $TAG points at $TAG_SHA, not HEAD $COMMIT_SHA."
    echo "   Refusing to build release assets from code newer than the requested tag."
    exit 1
  fi
  echo "↷ Reusing verified assets for $TAG while HEAD is $COMMIT_SHA."
fi

if ! git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "❌ Remote tag $TAG is missing. Run ./scripts/release.sh --current first."
  exit 1
fi

REMOTE_TAG_SHA=$(remote_tag_target_sha "$TAG")
if [ "$REMOTE_TAG_SHA" != "$TAG_SHA" ]; then
  echo "❌ Remote tag $TAG points at $REMOTE_TAG_SHA, not local tag target $TAG_SHA."
  exit 1
fi

LOCAL_TAG_REF_SHA=$(git rev-parse "refs/tags/$TAG")
REMOTE_TAG_REF_SHA=$(remote_tag_ref_sha "$TAG")
if [ "$REMOTE_TAG_REF_SHA" != "$LOCAL_TAG_REF_SHA" ]; then
  echo "❌ Remote tag $TAG is not the local signed tag object."
  echo "   Refusing to publish GitHub release assets against a stale lightweight or unsigned tag."
  echo "   Run ./scripts/release.sh --current first, or replace the remote tag explicitly:"
  echo "     git push --force origin $TAG"
  exit 1
fi

ASSETS=("$RELEASE_APK" "$SHA_FILE")
if [ -f "$SIGNER_FILE" ]; then
  ASSETS+=("$SIGNER_FILE")
fi
if [ -f "$PUBLIC_KEY_FILE" ]; then
  ASSETS+=("$PUBLIC_KEY_FILE")
fi
if [ -f "$ASC_FILE" ]; then
  ASSETS+=("$ASC_FILE")
else
  echo "⚠️  No checksum signature found at $ASC_FILE; uploading APK + SHA only."
fi

if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  echo "🔁 Uploading assets to existing GitHub Release $TAG..."
else
  echo "🚀 Creating GitHub Release $TAG..."
  if [ -n "$NOTES_FILE" ]; then
    gh release create "$TAG" --repo "$REPO" --target "$COMMIT_SHA" --title "$TAG" --notes-file "$NOTES_FILE"
  else
    DEFAULT_NOTES_FILE="$RELEASE_DIR/github-release-notes.md"
    write_default_release_notes "$DEFAULT_NOTES_FILE"
    gh release create "$TAG" --repo "$REPO" --target "$COMMIT_SHA" --title "$TAG" --notes-file "$DEFAULT_NOTES_FILE"
  fi
fi

UPLOAD_ARGS=(release upload "$TAG" "${ASSETS[@]}" --repo "$REPO")
if [ "$CLOBBER" = "1" ]; then
  UPLOAD_ARGS+=(--clobber)
fi
gh "${UPLOAD_ARGS[@]}"

echo "✅ GitHub Release $TAG has Android assets."

if [ "$PUBLISH_ZAPSTORE" = "1" ]; then
  publish_zapstore_release
fi
