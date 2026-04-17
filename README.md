# Chama

Nostr-native P2P escrow client. Non-custodial. No server.

Built on Nostr events (kinds 38100-38108), Fedimint ecash (WASM), and 2-of-3 Shamir Secret Sharing.

## Quick Start

```bash
npm install
npm run dev          # http://localhost:3000
```

Requires a NIP-07 signer extension (nos2x, Alby, Amber) or Fedi Mini-App runtime.

## Architecture

| Layer | What | Files |
|-------|------|-------|
| #1 State machine | Pure (state, event) -> state | `src/escrow-engine/` |
| #2 Relay layer | Multi-relay WebSocket, NIP-44, signers | `src/escrow-engine/` |
| #3 Fedimint WASM | Client-side ecash, SSS split/combine | `src/fedimint/` |
| #4 React UI | Trade list, detail, vote, create | `src/ui/` |

## Commands

```bash
npm run dev          # Development server
npm run build        # Production build -> dist/
npm run preview      # Preview production build
npm run typecheck    # Type-check the codebase (no emit). Must be zero errors.
npm test             # Run escrow engine tests (79 assertions)
npm run predeploy    # Typecheck + test, run before every deploy
```

## Deploy

The canonical deploy chain. Run from the repo root after a clean checkout:

```bash
npm run typecheck && \
npm test && \
npm run build && \
npx cap sync android && \
scp -r -i ~/.ssh/.id_satoshi_market dist/* satoshi@satoshimarket.app:~/chama-dist/ && \
git add -A && git commit -m "vX.Y.Z — message" && \
git push
```

The typecheck step is non-negotiable. If `tsc --noEmit` reports any error,
stop and fix it before proceeding. Shipping code that fails typecheck has
historically caused silent runtime bugs (missing methods, schema drift,
identifier-not-defined) that cost hours to diagnose downstream.

The Android APK is synced automatically by `npx cap sync android`. To
rebuild the APK itself, open `android/` in Android Studio and Build → Rebuild.

## License

Open source. est. block 934,669
