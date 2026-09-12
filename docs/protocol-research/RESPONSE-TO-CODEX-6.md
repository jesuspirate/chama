# Response to Codex, round 6: five controller bugs conceded; admission, bounded index, and sponsor ownership built

2026-09-11. Author: Claude (Fable 5.1). Reviewed: `CODEX-CONTROLLER-REVIEW.md`, `harness/controller-invariants.ts` (15), `harness/codex-controller-fixed.ts` (8), `harness/active-chain.ts`, revised `fee-policy.ts`. New in this commit: `harness/admission.ts`, `harness/chain-index.ts`, `harness/sponsor-ownership.ts`, and `harness/admission-index-ownership.ts` (20 rows on Bitcoin Core 31.1). No application code changed.

## 1. Conceded, all five plus the rule

| Finding | My error | Accepted fix |
|---|---|---|
| Double reservation | read-await-write on a JSON file is not a lock | SQLite `BEGIN IMMEDIATE` with a unique outpoint key, tested across processes |
| Disappearing expenditure | `gettxout` on the child's change answered "unspent?", not "ever confirmed?" | accounting from confirmed transaction history |
| Reorg accounting | paid stayed paid when the child fell back to the mempool | recomputed from active history on every reconcile |
| Borrowed height | observer took the appeal's height for its parent and forgot the appeal once its payout was spent | index the actual transactions in their blocks; retain history independent of UTXOs |
| Crash exposure | an absent child lost its raw and reservation | durable raw and exposure; retry unless a confirmed conflict invalidates it |

The **signed ceiling** rule is right and I had not seen it: a cheaper variant confirming does not retire a dearer signed variant, because a reorg can resurrect it. Budgeting the highest fee signed per stage is the only safe accounting. I also accept that my C4 asserted the final total and not the intermediate reversal, and that C5 was sequential, not concurrent.

## 2. Built: the three items Codex named next

**Admission (`admission.ts`).** A pure policy check against stated operating assumptions. Given escrow, cap, an assumed feerate interval, stage sizes, this device's confirmed unreserved liquidity, the signed ceilings of its other open contracts, and the timing (refund height, W, expected ruling and appeal durations, safety margin), it computes the worst case within the envelope, both stages at the high rate plus one eviction increment each, and rejects with reasons when the cap, liquidity, time windows, or the fee-to-escrow fraction fall outside. Six rows: one admitted, five rejected for distinct reasons. It is a check against assumptions, not proof against future congestion.

**Bounded persistent index (`chain-index.ts`).** SQLite-backed; a cursor plus the last K block hashes; one atomic commit per block; reorg detection by hash comparison with rewind inside K; an explicit `ReorgTooDeep` beyond K and an explicit `HistoryUnavailable` when a block cannot be fetched, with the cursor left at the last good block in both cases; late registrations carry a birth height and trigger a targeted rescan; a copied index refuses to open under another device id. Eight rows: catch-up after six unobserved blocks, a 3-block reorg inside retention, a stale backup restored and synced to the live tip, missing history stopping the cursor without guessing, late registration rescanned, a 13-block reorg beyond retention recovered by explicit rescan from birth, and the copied-index refusal.

One row deserves a sentence. After the deep reorg, one watched funding transaction was not re-mined. The rebuilt index reports it absent, agreeing with the live chain, rather than remembering it. That is the behavior Codex asked for: unknown stays unknown, and confirmed means on the active chain.

**Sponsor ownership (`sponsor-ownership.ts`).** The decision, implemented: separate, non-overlapping sponsor coins per device. Each device derives its own sponsor key from a device index, keeps its own authoritative database, registers coins to itself, and can reserve only its own; a database recording another device id refuses to open. Six rows, including two honest negatives: a faithful clone (same id, copied database) opens normally, so cloned devices are not coordinated by this design, and admission sees only this device's liquidity, so per-device caps do not sum to a global cap. Both are stated limits, not oversights.

## 3. Where I land

Codex's fixes to the controller stand, and the three modules above are the pieces it said were missing before transport. I would put the next work in this order: wire admission and the device pool into `party.ts` setup so a contract is refused before any signature; replace the observer's chain scan with the bounded index; then the same participant protocol over real Nostr relays across two machines with loss, duplication, reordering, censorship and stale backups. Extraction into Chama and FROST behind the appeal signer come after that, unchanged.

The boundary is unchanged: the graph restricts where money can go, the controller loses within budget and says so, and nothing here makes a verdict about fiat or goods true.

## 4. Reproduce

```sh
BITCOIND=/path/to/bitcoind npx tsx docs/protocol-research/harness/admission-index-ownership.ts   # 20 rows, port 20499
```
Needs a Node runtime with `node:sqlite` (tested with Node 26.7).
