# Approved logo promotion — 2026-09-21

The sole approved static master is `assets/brand/chama-mark-master.png`,
1254 × 1254, with checksum and user approval in `assets/brand/master.json`.
This is the approved original-colour candidate, not an animation frame.

## What changed

App and landing wordmarks, FAQ marks, onboarding, QR centres, reduced-motion
loaders, browser favicons, notifications, PWA and Apple touch icons, profile
images, desktop icons, and Android launcher/active splash exports now derive
from the master. Static asset URLs use `approved-star-20260921` for cache
refreshes. Both active social-share cards use the master too; their photographs
and copy are preserved. The approved amber treatment is unchanged.

PWA icons retain an opaque black background. Ordinary and maskable purposes
use separate exports, with the maskable mark inside the central 80% safe circle.
The transparent master is ready for future light surfaces. Android adaptive
foregrounds likewise retain transparency over the existing black background.

## Animation inspection

The active loader is an APNG, not a GIF: 12 frames at 25 ms each. Its star has
no old dark fringe through the loop. Colour cycling is intentional, so the v7
animation remains unchanged. Its reduced-palette cyan is not reused for static
exports. The two unreferenced landing GIFs and older loader versions are archived;
the older colour-cycle GIF visibly retained the halo on paper.

## Archive and reproducibility

`assets/brand/README.md` documents the export commands and archive boundary.
`outputs/logo-review-archive/2026-09-21/` consolidates superseded originals,
rejected draft exports and earlier design collections, outside all shipping
folders. No designs were deleted. The committed inventory records original
paths and checksums; old binaries stay local instead of bloating Git or APKs.
Independent checkout/migration backups are intentionally untouched.

## Live versus prepared state

Before editing, public HTML and byte comparisons confirmed that the VPS at
chama.community/getchama.app still served the older static mark, favicon and
PWA icons. This commit prepares corrected assets; it does not deploy either
site or rebuild installed native packages. Installed PWA icons can stay cached
until the platform refreshes them. Never clear wallet/browser data merely to
refresh an icon.

## Verification

Master checksum, archive checksums, transparent/opaque export properties and
mask-safe padding checked. Typecheck, build, hygiene, landing deployment asset
coverage, payment-card/QR browser checks and wordmark light/dark/browser checks
passed. Native assets were exported and their resource references checked;
no Android/desktop installer was built in this pass.
