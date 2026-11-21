# XBT federation — design specification (draft)

Status: **draft for discussion. Nothing here is live, and no money path uses it.**
The only code that exists is the pure primitives module `src/xbt/` and its test
suite. This document is a proposal written from Chama's side; it does not speak
for the Fedimint project, and no Fedimint-on-XBT implementation was found to
build on.

## 1. What XBT is

XBT ("Bitcoin BLAKE2b") is the Bitcoin Knots hard fork that changed proof of
work from SHA256d to BLAKE2b at mainnet height **961,640** (30 August 2026).
It shares Bitcoin's history up to that block, and therefore its genesis hash,
its address formats and every pre-fork coin.

What each claim below rests on:

| Fact | Basis |
|---|---|
| Post-fork headers are 164 bytes ("header v2"); layout and hash pipeline | **Tested**: 5 Knots vectors and 8 real post-fork mainnet headers, `src/xbt/tests.ts` |
| Fork block hash `0000000000000050c1e5…f18eeb`; first BLAKE2b target is the last SHA256d target shifted left 22 bits | **Tested** against real mainnet headers |
| `SIGHASH_UNIFIED` is flag `0x20`; digest is `TaggedHash("UnifiedSighash", msg)` over a BIP341-shaped message, for legacy, segwit v0, taproot and tapscript | **Tested**: all 166 Knots vectors |
| Coinbase maturity window (start 973,440, release 979,920, depth 6,480) | **Tested** against the reference wallet's cases |
| Transaction serialization, txids and merkle proofs are unchanged | **Inferred**: the reference wallet changes none of them. Not confirmed against the Knots source |
| Lightning: reference wallet keeps Bitcoin's genesis as chain hash and `bc` as invoice prefix, and calls Lightning "untested" | Read from `bitcoin-blake/electrum-xbt` constants and README |
| Network hashrate is in the tens of PH/s and can be rented | **Reported** by third-party sites; not measured here |

Reference used: `bitcoin-blake/electrum-xbt` at commit `cd0436e`, which mirrors
Knots `primitives/block.cpp`, `pow.cpp`, `doc/unified-sighash.md` and carries
Knots' own test vectors. The Knots source itself was not read for this draft.

## 2. One federation or two

**An XBT federation is a separate federation from any Bitcoin federation.**

`SIGHASH_UNIFIED` does not force this: it is a flag the federation's signer
sets. The reason is that an XBT sat and a BTC sat are different assets with
different prices, and ecash notes are fungible claims on a single reserve. A
mint that mixed them would be insolvent in one asset the moment prices moved.

Separation also contains risk. XBT's reorg exposure (section 4.5) must never be
able to halt or endanger a Bitcoin mint, and a client must never be able to
confuse the two balances.

A later option, out of scope here: one guardian set running two wallet+mint
module pairs with separate note keysets, which would allow an in-consensus
BTC↔XBT swap. It adds shared-fate risk and should wait for evidence that the
single-asset design is sound.

## 3. What does not change

- **Mint.** Threshold blind-signature ecash does not depend on the chain.
- **Guardian consensus.** Unchanged.
- **Keys and script.** Only proof of work moved to BLAKE2b. secp256k1, script
  and (by inference, see section 1) txids are as on Bitcoin.

## 4. Wallet module changes

### 4.1 Chain identity

Genesis is identical on both chains, so it cannot identify XBT. The federation
config, and any invite a client accepts, pins:

1. the genesis hash,
2. the fork height and the **fork block hash**, and
3. header version 2 at and after the fork.

`checkXbtHeader` in `src/xbt/chain-params.ts` implements the per-header part
and refuses an 80-byte header at a post-fork height. Chama already does the
mirror image for Bitcoin in `src/bond-multisig/esplora-config.ts`, which
rejects an explorer that answers about XBT.

### 4.2 Headers and peg-in proofs

A peg-in proof carries a block header and a merkle path. On XBT the header is
164 bytes and its hash is the BLAKE2b pipeline in `src/xbt/header-v2.ts`. The
verifier must also compare the height the header claims with the height the
guardians' own nodes report; the claim alone proves nothing.

### 4.3 Signing

Every guardian signature uses hash type **`0x21`** (`ALL | UNIFIED`), never
plain `ALL`. It commits to every input amount and cannot be replayed on
Bitcoin. Guardians verify each other's signature shares against the unified
digest (`unifiedSighash`).

### 4.4 Twin deposits

Because pre-fork coins exist on both chains, a deposit signed the old way can
be replayed on Bitcoin. The result is a "twin": real BTC sitting on the same
federation script at the same outpoint.

Rules:

- **Peg-in is credited only for a transaction that cannot exist on Bitcoin.**
  Sufficient proof: at least one input carries a signature that opts in to
  `SIGHASH_UNIFIED` (`signatureOptsInToUnified`), since one input that is
  invalid on Bitcoin makes the whole transaction invalid there. Client wallets
  sign every input with `0x21`.
- A deposit that fails the rule is **not credited and not lost**: it stays
  claimable by the depositor's key through a guardian refund on XBT.
- **BTC sent to the federation by mistake** (same address format) is held by
  the same guardian keys on the Bitcoin chain. The federation publishes a
  refund procedure before launch.
- **Order matters when refunding a twin.** A plain-`ALL` refund on Bitcoin can
  be replayed onto XBT if the XBT twin is still unspent. Spend the XBT side
  first, with `0x21`, then refund on Bitcoin.

### 4.5 Finality

This is the weakest part of the design. With little, rentable hashrate, the
cost of reorganizing a deposit out of the chain is low, and an attacker who
has already spent the ecash keeps both.

Proposed defaults, to be set from measured hashrate and rental prices, not
from this document:

- **Value-scaled confirmations.** Small deposits wait on the order of a day
  (144 blocks); large ones wait until the estimated cost of rewriting those
  blocks is a multiple of the deposit.
- **Peg-in caps** per deposit and per consensus epoch, so that one successful
  reorg has a bounded loss.
- **Guardian checkpoints.** Guardians sign the chain they have seen. On a
  reorg deeper than the finality depth the federation **halts peg-ins and
  peg-outs** and alerts; it does not follow the new chain automatically.
- **Coinbase deposits** obey the long maturity window
  (`coinbaseMaturityHeights`).
- Each guardian runs their own XBT full node. No shared explorer.

Halting is the fail-closed choice: funds stay under guardian keys for recovery
instead of being paid out against a chain that may be rewritten.

## 5. Payments without Lightning

No Lightning implementation is known to run on XBT. One that did would need
its own chain hash and invoice prefix, because BOLT identifies a chain by
genesis hash, which XBT shares with Bitcoin.

Until then, the federation uses Fedimint's hash-locked ecash contracts
directly, on a SHA-256 preimage:

- **XBT ↔ XBT across federations**: a gateway that is a member of both swaps
  one contract for the other.
- **XBT ↔ BTC**: a gateway that is a member of an XBT federation and a Bitcoin
  federation does the same. This is a non-KYC exchange path. The trust is in
  the two federations and the atomicity of the contract, not in an exchange.

The gateway takes price risk for the life of the contract, so timeouts must be
short and quoted amounts explicit.

## 6. What this means inside Chama

These follow the repository's working rules and bind any later implementation:

- An XBT federation wallet is a **separate wallet**. No automatic routing,
  rebalancing or "top up" between XBT and BTC.
- Amounts are always labelled with their asset. An XBT balance is never shown
  as, or summed with, sats on Bitcoin.
- The existing mainnet explorer probe keeps rejecting XBT endpoints. An XBT
  path gets its own probe built on `checkXbtHeader`.
- Hardware signers cannot yet produce `0x21` signatures (reported by the
  reference wallet). Any flow that needs one must say so before funding.
- The XBT market stays described as not active until an implementation and
  device evidence exist (`docs/technical-overview.md`, section 07).

## 7. Risks

- **Custody.** A guardian quorum can take the reserve. On a chain chosen for
  decentralization, a federation is a concentration of trust; it should be
  small-balance by design.
- **Reorgs.** Section 4.5. This is a property of the chain, and the mitigations
  bound the loss; they do not remove it.
- **Liquidity.** Exchange support is reported as thin and split across several
  ticker names, which makes pricing an XBT↔BTC swap hard.
- **Specification drift.** The chain's rules live in one implementation. Any
  change there must be re-checked against `src/xbt/tests.ts`.

## 8. Open questions

1. Confirm against the Knots source that txids and merkle trees are unchanged.
2. What does the `mm_rhs` merge-mining field do once it is no longer reserved,
   and how would merge-mining change the finality numbers?
3. Measured hashrate and rental cost, to set section 4.5's parameters.
4. Does `0x21` change transaction relay policy or fee estimation anywhere?
5. Which Fedimint release and wallet module version to fork from.

## 9. Phases

1. **Primitives** (done): `src/xbt/` — header v2, proof-of-work arithmetic,
   chain parameters, `SIGHASH_UNIFIED`, with reference vectors.
2. **Testnet4 federation**: wallet module with v2 proofs, `0x21` signing and
   the twin-deposit rule. No mainnet value.
3. **Reorg drills** on testnet4: deposit, reorg, confirm the federation halts
   and that funds are recoverable.
4. **Gateway swap** between a testnet XBT federation and a signet/mutinynet
   Bitcoin federation.
5. **Mainnet**, capped, only after 2–4 produce evidence and question 1 is
   closed.

## Appendix: the primitives module

| File | Contents |
|---|---|
| `src/xbt/header-v2.ts` | Parse, serialize and hash 164-byte headers |
| `src/xbt/chain-params.ts` | Fork parameters, compact-target arithmetic, `checkXbtHeader`, coinbase maturity |
| `src/xbt/unified-sighash.ts` | `SIGHASH_UNIFIED` digest for all four script types, opt-in flag reader, minimal transaction decoder |
| `src/xbt/tests.ts` | Run by `npm test` |
| `src/xbt/fixtures/` | Knots vectors (unmodified) and real mainnet headers, from `bitcoin-blake/electrum-xbt` (MIT) |

`checkXbtHeader` checks one header's shape, height claim, parent link and that
its hash meets its own `bits`. It does **not** establish that `bits` was the
difficulty the chain required, nor anything about finality.
