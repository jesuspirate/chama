# Landing asset boundary

`landing/deploy-files.txt` is the authoritative production allowlist. Its 30
`img/` entries remain tracked and available in a clean checkout. The complete
landing deployment still contains 53 files. Compatibility images are retained.

`.gitignore` denies other `landing/img/**` files and has exact exceptions for
the deployed images (including traversable `faq/`). When promoting a new image,
add it to the manifest and add its exact exception. Keep design working files
under ignored `outputs/`, rather than force-adding them into the shipping tree.

`node scripts/check-landing-deploy.mjs` now rejects tracked `img/` files absent
from the manifest and deployed images still covered by ignore rules. Repository
hygiene invokes that check, so a force-added design draft cannot silently grow
the production tree again.

## Preserved leftovers — 2026-09-21

`archive-inventory.json` lists 116 files preserved in the local folder
`outputs/design-review-archive/2026-09-21/`, with source paths, previous tracked
status, byte counts and SHA-256 checksums. They comprise:

- 63 previously tracked landing experiments/provenance notes outside the manifest,
  plus 37 ignored working files. All manifest-named files were retained.
- The unreferenced `public/chama-unbreakable-link.png` and root
  `chama-market-source.jpg`.
- Unused landing PNG favicons and 128/256/512/1024px mark exports. The landing
  consumes its multi-size ICO and 64px mark; app/desktop PNG sizes and the
  manifest-referenced installation icons remain available.

The archive totals 124.3 MiB locally; 48.25 MiB was removed from the current
tracked tree. Removing the orphan from `public/` also removes it from new Vite
web/Android payloads. No history, published tag, or release was rewritten, so
this does **not** shrink existing Git history or promise a smaller full clone.
The archive stays outside Git and build inputs; back it up before discarding
this checkout. Nothing in it has been approved for permanent deletion.

Verified archive checksums, the gate rejecting the old tracked leftovers, exact
ignore exceptions, and export regeneration without recreating removed sizes.
The app build, landing deployment check, repository hygiene and diff checks pass.
