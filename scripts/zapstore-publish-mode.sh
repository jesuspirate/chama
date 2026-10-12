# Sourced by android-release.sh. Decides how zsp publishes.
#
# Quiet is the default whenever the signer is a NIP-46 bunker (Jet's Amber):
# zsp runs with --quiet (no prompts, auto-confirm) and every signature is
# still approved by hand on the phone. The browser signer needs a person at
# the Mac anyway, so it stays interactive. CHAMA_ZAPSTORE_INTERACTIVE=1 (or
# android-release.sh --zapstore-interactive) forces the old interactive run.
# Never echo SIGN_WITH: it carries the pairing secret.
chama_zapstore_mode() {
  if [ "${CHAMA_ZAPSTORE_INTERACTIVE:-0}" = "1" ]; then
    echo interactive
  elif [ "${SIGN_WITH:-}" != "${SIGN_WITH#bunker://}" ]; then
    echo quiet
  else
    echo interactive
  fi
}
