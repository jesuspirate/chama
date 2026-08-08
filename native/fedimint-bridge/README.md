# Chama Fedimint Bridge

Native Fedimint harness for proving Chama can use public federations without the
browser/WASM transport constraints.

This binary uses the Fedimint 0.11.1 Rust client crates directly and attaches the
same modules as `fedimint-cli`: mint v1/v2, wallet v1/v2, lightning v1/v2, and
meta. Iroh DHT and the next Iroh stack default to enabled because the GBF test
needed native iroh behavior.

## Build

```sh
cd native/fedimint-bridge
CARGO_TARGET_DIR=/private/tmp/chama-fedimint-cli-test/cargo-target cargo build
```

## GBF Smoke

```sh
GBF='fed11qgqyj3mfwfhksw309uergwf3vvuxyefcvgcrwcmyxaskvvnzxs6nzdrxv3jnxwrz8pjrgdesv5crwve5xv6xyvtyv56nqcfevsmrwv3kx5erwv3n8qcrvde5qyqjqx7tvnngau9nmcadjm9e3dp69lvh920l5rak7r3x4thxn5w5vwuhsc2yh9'
CARGO_TARGET_DIR=/private/tmp/chama-fedimint-cli-test/cargo-target cargo run -- \
  --data-dir /private/tmp/chama-fedimint-bridge-gbf \
  smoke "$GBF"
```

The smoke command opens or joins the federation, prints balance/info, probes all
cached gateways for native reachability, and creates a 1 sat invoice.

## Useful Commands

```sh
cargo run -- --data-dir /path/to/client join "$INVITE"
cargo run -- --data-dir /path/to/client info
cargo run -- --data-dir /path/to/client list-gateways
cargo run -- --data-dir /path/to/client probe-gateways
cargo run -- --data-dir /path/to/client invoice --amount-msats 1000
cargo run -- --data-dir /path/to/client await-invoice "$OPERATION_ID"
cargo run -- --data-dir /path/to/client spend-notes --amount-msats 1000
cargo run -- --data-dir /path/to/client reissue-notes "$ECASH_NOTES"
cargo run -- --data-dir /path/to/client parse-notes "$ECASH_NOTES"
cargo run -- --data-dir /path/to/client onchain-info
cargo run -- --data-dir /path/to/client onchain-deposit-address
cargo run -- --data-dir /path/to/client await-onchain-deposit "$OPERATION_ID"
cargo run -- --data-dir /path/to/client onchain-withdraw-fees --address "$BTC_ADDRESS" --amount-sats 1000
cargo run -- --data-dir /path/to/client onchain-withdraw --address "$BTC_ADDRESS" --amount-sats 1000
```

## Localhost API

```sh
BRIDGE_TOKEN="$(openssl rand -hex 32)"
cargo run -- --data-dir /path/to/client serve --bind 127.0.0.1:8787 --auth-token "$BRIDGE_TOKEN"
```

Example calls:

```sh
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:8787/health
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:8787/info
curl -H "Authorization: Bearer $BRIDGE_TOKEN" http://127.0.0.1:8787/probe-gateways
curl -X POST http://127.0.0.1:8787/invoice \
  -H 'content-type: application/json' \
  --data '{"amountMsats":1000,"description":"Chama native test"}'
curl http://127.0.0.1:8787/onchain/info
curl -X POST http://127.0.0.1:8787/onchain/deposit-address
curl -X POST http://127.0.0.1:8787/onchain/withdraw-fees \
  -H 'content-type: application/json' \
  --data '{"address":"bc1...","amountSats":1000}'
```

The service exposes JSON endpoints for `join`, `info`, `gateways`,
`probe-gateways`, `invoice`, `await-invoice`, `pay`, `spend-notes`,
`reissue-notes`, `parse-notes`, `onchain/info`,
`onchain/deposit-address`, `onchain/await-deposit`,
`onchain/withdraw-fees`, and `onchain/withdraw`.

`/onchain/info` includes the federation wallet-module policy:

```json
{
  "network": "bitcoin",
  "finality_delay": 10,
  "peg_in_fee_sats": 1000,
  "peg_out_fee_sats": 0,
  "minimum_deposit_sats": 1001
}
```

The Bitcoin miner fee for a deposit is chosen and paid by the sender's external
wallet. The federation peg-in fee is charged when the confirmed deposit is
claimed into ecash, so Chama asks the sender to deposit trade amount plus
`peg_in_fee_sats` and disables the onchain path below `minimum_deposit_sats`.

## Browser App Opt-In

Start the native sidecar against a joined data directory. GBF can use the
default native URL and native community:

```sh
GBF='fed11qgqyj3mfwfhksw309uergwf3vvuxyefcvgcrwcmyxaskvvnzxs6nzdrxv3jnxwrz8pjrgdesv5crwve5xv6xyvtyv56nqcfevsmrwv3kx5erwv3n8qcrvde5qyqjqx7tvnngau9nmcadjm9e3dp69lvh920l5rak7r3x4thxn5w5vwuhsc2yh9'
BRIDGE_TOKEN="$(openssl rand -hex 32)"
CARGO_TARGET_DIR=/private/tmp/chama-fedimint-cli-test/cargo-target cargo run -- \
  --data-dir /private/tmp/chama-fedimint-bridge-gbf \
  serve --bind 127.0.0.1:8787 --auth-token "$BRIDGE_TOKEN" \
  --allowed-origin http://localhost:3000 --invite-code "$GBF"
```

Then run Chama normally and opt into the native adapter:

```sh
npm run dev
```

Open the app with:

```text
http://localhost:3000/?nativeFedimint=1
```

BLF can run in parallel on a second bridge port:

```sh
BLF='fed11qgqyj3mfwfhksw309ajrwvmxvenxgvpkvyursenxxvur2c3sv4jkxdfcxf3kgdmyvs6nzcehvc6xzctzxumrxdmr89jnwdtpv5enqwtpxqmrsvfh89skxv34qqqjpzytwrkr28r8mjas4ej467utd7excr7fapj7ukgc4ugacm6nu2u73k7ram'
CARGO_TARGET_DIR=/private/tmp/chama-fedimint-cli-test/cargo-target cargo run -- \
  --data-dir /private/tmp/chama-fedimint-bridge-blf \
  serve --bind 127.0.0.1:8788 --auth-token "$BRIDGE_TOKEN" \
  --allowed-origin http://localhost:3000 --invite-code "$BLF"
```

Open the app with:

```text
http://localhost:3000/?nativeFedimint=1&nativeFedimintUrl=http%3A%2F%2F127.0.0.1%3A8788&nativeFedimintCommunity=us-blf
```

Alternative persistent browser-console setup:

```js
localStorage.setItem("chama_native_fedimint", "1")
localStorage.setItem("chama_native_fedimint_url", "http://127.0.0.1:8787")
localStorage.setItem("chama_native_fedimint_token", "<paste BRIDGE_TOKEN here>")
```

The adapter preserves the existing wallet interface: invoice creation, invoice
payment, balance polling, ecash spend, ecash reissue, and ecash parsing all go
through the local Rust sidecar. Native mode also exposes Fedimint wallet-module
on-chain peg-in and peg-out for the slow-path funding and payout toggles.
Without `nativeFedimint=1`, Chama still uses the current browser WASM SDK
adapter.
