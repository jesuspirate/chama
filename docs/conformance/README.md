# Escrow replay conformance vectors

These files let anyone check that their own implementation of the escrow
protocol in [`../nip-draft-escrow.md`](../nip-draft-escrow.md) computes the same
trade state as Chama does from the same events. If two implementations pass
every vector, they agree on who holds a trade's money and what may happen next
in every case the vectors cover.

| File | What it is |
|---|---|
| `escrow-replay.jsonl` | One vector per line: a list of trade events and the outcome they must replay to. |
| `manifest.json` | Format version, vector count, accepted/refused split, refusal codes and event kinds covered, and the SHA-256 of `escrow-replay.jsonl`. |

Both files are generated. Do not edit them by hand. They are a projection of
Chama's golden replay corpus (`tests/golden/replay.jsonl`, see
[`../protocol-boundary.md`](../protocol-boundary.md)):

```sh
node scripts/export-conformance-vectors.mjs          # regenerate
node scripts/export-conformance-vectors.mjs --check  # fail if stale (runs in npm test)
```

## A vector

Each line is one JSON object with sorted keys:

| Field | Meaning |
|---|---|
| `name` | Stable identifier, tracing back to the Chama test that produced it. |
| `nowSec` | The replay clock, in Unix seconds. Rules that depend on "now" read this value and nothing else. |
| `options.creator` | When present, the trade's creator public key: only the CREATE signed by this key may root the trade (replay rule 1). |
| `events` | The events to replay, **already in replay order** (rule 3). Each has `escrowId`, `kind`, `pubkey`, `timestamp`, `prevEventId`, the decrypted `payload`, and `raw`, the Nostr event as published. |
| `signatures` | For each event, `valid-signature` or `synthetic-or-modeled`. See *Limits*. |
| `expect` | Either `{ "ok": true, "state": … }` or `{ "ok": false, "error": { "code", "eventId", "message" } }`. |

## Passing

An implementation passes a vector when, given `events`, `options` and `nowSec`:

- it accepts the chain exactly when `expect.ok` is `true`;
- for an accepted chain, its final state equals `expect.state` field for field
  (compare as JSON with sorted keys; sets are written as sorted arrays);
- for a refused chain, it reports the same `error.code` against the same
  `error.eventId`. The `message` text is informative only.

`src/protocol/conformance.tests.ts` is the reference runner. It uses only these
files, the core entry point `src/protocol/core/index.ts` and the clock port
(`setProtocolClock`), and it fails if replay reads the device clock.

## What the vectors cover

The manifest lists the exact counts. Format version 1 has 99 vectors: 68 chains
that replay to a state and 31 that are refused, across CREATE, JOIN, LOCK, VOTE,
RESOLVE, CLAIM, COMPLETE, CANCEL and CHAT and two extension kinds. They include
the replay-hardening cases: a stranger's CREATE under a trade id, stray votes and
cancels from non-participants that must be ignored (rule 5), and the refusals the
reference still makes. Some of those are stricter than rule 5 asks (an arbiter's
early VOTE still fails the replay; see the Migration note under *Replay* in the
NIP). Implementations should match them until the reference changes.

## Limits

- **Ordering, signatures and decryption are not tested here.** Inputs are already
  ordered and decrypted. Rule 3 ordering is Chama's `sortEventChain`; it is not
  yet covered by a vector.
- **Most signatures are not real.** Most events come from test fixtures with
  modeled signatures (`synthetic-or-modeled`). Replay assumes rule 2 already
  dropped invalid signatures; the `signatures` field records which inputs carry
  a real one.
- **Kind numbers are Chama's** (38100–38117), not the NIP's proposed 8100–8117.
- **The state shape is Chama's.** `expect.state` is the reference implementation's
  full state object, including its event chain and replay notes. A different
  implementation may keep its own shape and map it for comparison.
- **Coverage follows Chama's tests.** Contest, healing and backup-arbiter chains
  are covered only as far as the existing tests exercise them. New cases enter
  through the golden corpus, then this export.

## Versioning

`formatVersion` changes when the file layout changes. A vector's expected
outcome changes only when Chama's replay rules change, and such a change needs a
consensus gate (an old client must never compute a different money state from a
new one). Regenerating after a rule change is therefore a reviewed, deliberate
step: `npm test` fails until the corpus, the vectors and the manifest agree.
