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
npm test             # Run escrow engine tests (78 assertions)
```

## Deploy

```bash
npm run build
# Serve dist/ from any static host
```

## License

Open source. est. block 934,669
