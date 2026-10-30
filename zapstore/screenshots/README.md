# Listing screenshots

## October 2026 set (current, app version 6.4.32)

These eight images are what `zapstore.yaml` lists, in display order. Each one is a real capture of the Chama web client at tag `v6.4.32` (commit `0ac4c089`), built with `CHAMA_RELEASE=1` so the version chip reads `v6.4.32` with no dev stamp. Viewport 412 × 915 at 2.625× (a Pixel-sized phone), light theme (Settings > light mode), chosen for visibility on the store card. The capture is placed under a short caption drawn from the landing page's reasons, on a 1080 × 2340 canvas in DM Sans.

| File | Screen | Caption |
| --- | --- | --- |
| `01-people-not-platforms.png` | Browse: "What do you have?" | Trade with people, not platforms. |
| `02-two-of-three.png` | Trade room before joining, three seats | Three people. It takes any two. |
| `03-match-that-fits.png` | Buyer's matches | A match that fits both people. |
| `04-pay-your-way.png` | Buyer picks payment methods | Pay the way you already pay. |
| `05-post-an-offer.png` | Seller's offer is live | Post once. Nothing locks yet. |
| `06-save-together.png` | Circles, with the Create button | Save together. |
| `07-your-language.png` | Kiswahili, Kenya, Bitsacco | Kiswahili, English, Français, Español. |
| `08-your-key.png` | Welcome screen | Your key is your account. |

How they were made, so the next refresh can repeat it:

- The app ran from `vite preview` on the release build. Fresh throwaway identities were created on each run. No real relay, federation or payment was touched: Nostr traffic went to a private in-memory relay inside the test browser, and price requests got a fixed BTC/USD quote of 72,480 (so the price card reads "median of 3 sources"). The seller's offer in images 3 and the trade room in image 2 come from a second throwaway identity posting a real offer to that private relay.
- Nobody joined, locked or funded anything. The arbiter name in image 2 is the app's own automatic pick.
- One edit, disclosed: the test browser cannot reach a Fedimint federation, so the federation pill stayed on "Connecting...". Before each capture, that pill's text and dot were set to the state the app shows once the federation answers ("Ready", "Tayari" in Kiswahili). Nothing else on screen was changed.
- No recovery key appears in any image.
- Size: Zapstore's CDN refused the first 462-567 KB PNGs ("upload exceeds the size limit"). The images are now 256-colour PNGs from libimagequant (dithering 0.5, max quality 90), 133-146 KB each, still 1080 × 2340. `scripts/check-zapstore-images.mjs` refuses any listing image over 190,000 bytes, in `npm test` and before every Zapstore publish, dry runs included.

The older September 2026 captures (`*-v6.png`, 6.4.2 UI) are kept in this folder but are no longer listed.

The release pipeline reads `zapstore.yaml`. To refresh the listing for the current release without shipping a new version, run `npm run ship -- --only zapstore-listing` on the Mac; it re-publishes the current release event with these images and keeps the existing release notes.

---

## September 2026 set (6.4.2, no longer listed)

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
