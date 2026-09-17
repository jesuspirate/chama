# Approved listing screenshots

Captured from the actual running Chama web client on 2026-09-17, not generated mockups. Source checkout: `/Users/Jetty/chama`, commit `76ce3d69`; visible app version 6.4.2. Mobile viewport: 412 × 1000 for canvas and payment methods; 412 × 915 for welcome. Images are real browser viewport captures. The upper-right development version badge was removed by matching the surrounding header background; pixels outside that small region are unchanged. The browser originally returned JPEG bytes; on release-readiness review they were re-encoded as genuine PNG files to match their filenames, without cropping or altering the depicted UI.

- `canvas-v6.png`: initial guided canvas with the app’s banknote icon.
- `payment-methods-v6.png`: USD-to-Bitcoin payment selection, with Zelle selected.
- `welcome-v6.png`: signed-out welcome screen.

A fresh local identity was used. No trade was posted, no payment was made, and no private recovery key appears in these images. The account name/public-key fragment is from that new identity.

The user approved this web-client screenshot set on 2026-09-17. These are not native Android captures. No listing publication was performed.

## Expanded multilingual set

Additional captures use a 430 × 1000 viewport and a second fresh local identity, still app version 6.4.2. Languages and currencies were changed through app controls. Live prices differ slightly between shots because the app refreshes its quote. Converter currency is independent of the community currency shown in the header.

- [English guided canvas](canvas-v6.png)
- [English payment methods](payment-methods-v6.png)
- [English USD converter, Kenyan community](en-converter-usd-v6.png)
- [French canvas with BTC/EUR price](fr-canvas-eur-v6.png)
- [French EUR converter](fr-converter-eur-v6.png)
- [Spanish MXN converter in light mode](es-converter-mxn-light-v6.png)
- [Kiswahili KES converter and BTC/KES price](sw-converter-kes-v6.png)
- [English planning scenario (app defaults, not a forecast)](en-planner-usd-v6.png)
- [Kiswahili Kenyan marketplace, honest empty state](sw-market-kes-v6.png)
- [French country selection](fr-country-v6.png)
- [English welcome](welcome-v6.png)

The YAML lists all 11 approved images in display order. PNG signatures and viewport dimensions were verified. Keep these assets outside `public` so they do not bloat the APK.

The release pipeline reads `zapstore.yaml`. Once merged, the next normal application release consumes this description and image set. Deploying the landing page alone (`npm run ship -- --only landing`) does not publish Zapstore.
