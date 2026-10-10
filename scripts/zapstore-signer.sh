# Sourced by release entry points. Never echo SIGN_WITH or enable shell tracing.
chama_zapstore_signer() {
  if [ -n "${SIGN_WITH:-}" ]; then
    export SIGN_WITH
    return 0
  fi
  local connection_file
  connection_file="${CHAMA_ZAPSTORE_SIGNER_FILE:-$HOME/Library/Application Support/chama-release/zapstore-bunker.txt}"
  SIGN_WITH=$(node "$ROOT_DIR/scripts/read-zapstore-signer.mjs" "$connection_file") || return 1
  export SIGN_WITH
}
