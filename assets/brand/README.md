# Chama's approved logo

**`chama-mark-master.png` is the sole static logo master.** Jet approved this
exact candidate on 2026-09-21. Its SHA-256 and native 1254 × 1254 dimensions
are recorded in `master.json`. Preserve its cyan shading, four-point orange
star, transparency and ring geometry. Do not regenerate or recolour it.

## Exports

With Python/Pillow available, run:

```sh
python3 scripts/brand/sync-marks.py
node scripts/brand/render-share-cards.mjs
```

The second command uses Chromium via `puppeteer-core`; set `CHAMA_BROWSER` if
Brave is not installed at the script's default macOS path. No image-generation
service is involved. The export script refuses a master whose checksum differs
from the approved metadata.

- App wordmark, onboarding, static loader, QR centre, favicons and notification
  icons all derive from this master, as do landing and FAQ marks.
- Installed PWA/Apple icons stay black. PWA maskable icons have their own inset;
  Android adaptive foregrounds retain transparency over the existing black XML
  background. Desktop and native Android splash/launcher images use the master.
- Profile images and both active share previews use the same master. The share
  templates preserve the existing photographs and copy; do not use archived
  compositions as current sources.
- The active 12-frame `chama-color-cycle-boot-hd-v7.png` is an intentionally
  colour-cycling animated variant. Its star is clean throughout. Keep this
  animation, but **never extract static logos from it**: its reduced-palette
  shading was the source of the rejected cyan change.

## Compatibility URLs

The former app 64px mark and last published share/banner URLs remain as
exports of the approved artwork, so cached app bundles and shared links do not
break. Their old pixels are archived; their filenames are compatibility aliases,
not separate masters. New code uses the canonical export names.

## Superseded designs

The single local review folder is:
`outputs/logo-review-archive/2026-09-21/`.

`archive-inventory.json` records original locations, archive paths, sizes and
SHA-256 checksums. It includes pre-change committed assets, the rejected v7
static exports, unused GIFs, unused native splash images, and earlier logo and
share-design collections. Files were preserved, not deleted. The archive is
about 120 MiB and intentionally excluded from Git/app bundles; the inventory
is committed and the original published assets also remain in Git history.
Back up this local folder before deleting or moving this checkout.

Independent worktrees, packaged builds, migration backups and the Codex image
service's own output store were left intact. They are historical copies, not
active app sources. No future deletion is authorized by this consolidation.
