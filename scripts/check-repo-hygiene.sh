#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

fail() {
  echo "❌ Repository hygiene check failed: $1" >&2
  exit 1
}

# These are workspace/transfer artifacts, not application source. Checking the
# Git index catches them before a release even if a local ignore rule is absent.
forbidden_tracked=$(git ls-files -- \
  '.b64tmp/**' \
  '.codex-vps-deploy/**' \
  '.codex-target.patch' \
  '**/.b64tmp/**' \
  'node_modules' \
  'node_modules/**' \
  '**/node_modules' \
  '**/node_modules/**' \
  'design/**' \
  'migration/**' \
  'social/**')
if [ -n "$forbidden_tracked" ]; then
  printf '%s\n' "$forbidden_tracked" >&2
  fail "agent workspace or transfer artifacts are tracked"
fi

# Vite copies all of public/ into the Android app. A large design archive here
# silently becomes APK payload, so keep a conservative ceiling above the normal
# Chama production asset footprint (currently about 8 MiB).
public_bytes=$(git ls-files -z public | xargs -0 stat -f '%z' 2>/dev/null | awk '{sum += $1} END {print sum + 0}')
public_limit=$((20 * 1024 * 1024))
if [ "$public_bytes" -gt "$public_limit" ]; then
  public_mib=$((public_bytes / 1024 / 1024))
  fail "tracked public/ assets total ${public_mib} MiB (limit: 20 MiB)"
fi

echo "✅ Repository hygiene check passed."
