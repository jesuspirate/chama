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
cargo run -- --data-dir /path/to/client serve --bind 127.0.0.1:8787
```

Example calls:

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/info
curl http://127.0.0.1:8787/probe-gateways
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
CARGO_TARGET_DIR=/private/tmp/chama-fedimint-cli-test/cargo-target cargo run -- \
  --data-dir /private/tmp/chama-fedimint-bridge-gbf \
  serve --bind 127.0.0.1:8787 --invite-code "$GBF"
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
  serve --bind 127.0.0.1:8788 --invite-code "$BLF"
```

Open the app with:

```text
http://localhost:3000/?nativeFedimint=1&nativeFedimintUrl=http%3A%2F%2F127.0.0.1%3A8788&nativeFedimintCommunity=us-blf
```

Alternative persistent browser-console setup:

```js
localStorage.setItem("chama_native_fedimint", "1")
localStorage.setItem("chama_native_fedimint_url", "http://127.0.0.1:8787")
```

The adapter preserves the existing wallet interface: invoice creation, invoice
payment, balance polling, ecash spend, ecash reissue, and ecash parsing all go
through the local Rust sidecar. Native mode also exposes Fedimint wallet-module
on-chain peg-in and peg-out for the slow-path funding and payout toggles.
Without `nativeFedimint=1`, Chama still uses the current browser WASM SDK
adapter.

## Dev-only seed recovery proof

`recover-check` adds no app or HTTP route. It opens the source `client.db`
read-only and reads the stored entropy through
`Client::load_decodable_client_secret`, the same encoding used by the bridge.
It never generates or replaces the source secret. It checks the invite's
federation against the source config before creating a scratch wallet.

On pinned Fedimint 0.11.1, forced recovery is
`ClientBuilder::preview(...).recover(db, root_secret, None)`, followed by
`wait_for_all_recoveries`. This uses the seed alone, without a backup snapshot.
Both recovery and the subsequent balance-reading client use a stopped
transaction executor. No invoice, spend, receive or reissue command runs.
Recovery reads federation history and writes only the disposable scratch DB.

The source balance uses the same primary Bitcoin mint module and its
`get_balance` implementation against a source read-only transaction. The
pinned mint v1/v2 implementations count the notes in that supplied transaction;
no source client, source migrations or source state machines are started.
An unsupported primary balance module is an error, not a zero balance.

### Manual run (Jet)

Use a **dedicated test wallet**, not your normal wallet. Choose an invite for
the federation under test. `INVITE` below is the public invite, not a seed.

```sh
cd native/fedimint-bridge
cargo build
BRIDGE="$PWD/target/debug/chama-fedimint-bridge"
SOURCE="$HOME/chama-recovery-proof-source"
SCRATCH=/private/tmp/chama-recovery-proof-scratch

# Use a new SOURCE directory. Smoke creates an invoice for 1,000 sats.
"$BRIDGE" --data-dir "$SOURCE" smoke "$INVITE" --amount-msats 1000000
```

Until you pay the balance back out, the federation holds the sats and this
SOURCE directory is the only retained wallet that can spend them. Keep it on
persistent storage under `$HOME`; do not delete it while it has a balance.
SCRATCH is disposable and is never a wallet to use for spending.

Pay the printed invoice. Then run `await-invoice` using its printed operation
id so the source client finishes receiving the payment and persists its notes:

```sh
"$BRIDGE" --data-dir "$SOURCE" await-invoice "$OPERATION_ID"
"$BRIDGE" --data-dir "$SOURCE" info
```

Wait for a settled receive and verify about 1,000 sats in `info`. Stop every
bridge/client process using SOURCE, and do not fund or spend from it during
the proof. A live source can change while history is scanned and invalidate
the comparison.

```sh
"$BRIDGE" recover-check \
  --source-data-dir "$SOURCE" \
  --invite "$INVITE" \
  --scratch-data-dir "$SCRATCH" \
  --timeout-seconds 900
```

On completion, stdout is JSON:

```json
{"federationId":"<federation-id>","recoveredBalanceMsat":1000000,"sourceBalanceMsat":1000000,"recoveryCompleted":true,"elapsedSeconds":42}
```

**Passing** means recovery completed and the two balances are equal. A completed
scan with unequal balances is a failed proof, not successful wallet restoration.
A timeout is **inconclusive**, not evidence that seed recovery failed: recovery
progress with a stopped executor has not yet been demonstrated on a funded
federation. Preserve SOURCE and report the timeout.
Paste the JSON into the review thread. This proves native recovery only;
WASM browser recovery needs its own separate evidence.

SCRATCH must be new or empty, must not overlap SOURCE (in either direction),
and must not be a symlink or file. Its parent must already exist. The source
must contain an existing `client.db`; missing data is refused without creating
a replacement wallet. The default timeout is 15 minutes. Invalid input,
timeout, module recovery failure or cleanup failure returns nonzero, without a
success JSON. Normal error paths also remove the owned scratch directory.

The scratch client shares the source's seed. **Never use it as another wallet**:
it could reuse note nonces and lose money. The tool shuts it down and deletes
SCRATCH before printing success. A process kill, power loss or crash can leave
SCRATCH behind; remove that dedicated scratch directory before retrying, and
never start a normal bridge on it. SOURCE is retained. No mnemonic or entropy
is printed by the command.

### Finish: pay the test sats back to your own wallet

After the proof (including a timeout), use only SOURCE to get the sats back.
Create a Lightning invoice in your own external wallet for an amount the test
balance can cover, leaving room for Lightning fees. Do not make an invoice
for the entire balance if the payment also needs fees.

```sh
"$BRIDGE" --data-dir "$SOURCE" info
"$BRIDGE" --data-dir "$SOURCE" pay "$YOUR_WALLET_INVOICE"
"$BRIDGE" --data-dir "$SOURCE" info
```

Wait for a settled payment and verify the sats arrived in your external wallet.
The final `info` should show `total_amount_msat: 0` before you remove SOURCE.
If the payment is pending, inspect `pay-outcome` with its operation id rather
than issuing the payment again. If fees leave a remainder, keep SOURCE and pay
out what you can in another affordable payment; do not delete a wallet holding
leftover sats, even if the remainder is too small to send over Lightning.
Until the payout settles, the federation still holds those sats and SOURCE
remains the wallet you must keep to spend or recover them.

PR 2 (backup writers) remains on hold pending Jet's wallet-backup decision;
this manual proof is evidence for that decision, not automatic authorization.
