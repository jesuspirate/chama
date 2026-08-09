// ══════════════════════════════════════════════════════════════════════════
// Chama — on-chain 2-of-3 Taproot escrow (Tier 2.1, S1: the pure core)
// ══════════════════════════════════════════════════════════════════════════
//
// Brief: design/mockups/chama-onchain-2of3-taproot-escrow-brief.md
//
// One address, three ways to spend it, arranged in a Taproot tree. Only the
// branch actually used is ever revealed on-chain.
//
//   COOP    2-of-2 {buyer, seller}                — the trade went fine
//   DISPUTE 2-of-3 {buyer, seller, arbiter}       — someone needed judging
//   REFUND  <height> CLTV DROP <funder> CHECKSIG  — everyone vanished
//
// ⭐ WHY THIS EXISTS. Fedimint ecash notes are BEARER instruments: the funder
// minted them, knows the note string, and can reissue it. Shamir-splitting that
// string distributes knowledge without removing it from the dealer — and
// `reabsorb()` ships the reissue call as supported crash recovery. That is rule
// zero, and no amount of arbiter reform touches it.
//
// A UTXO is different in kind. The coins sit at an address whose ONLY spending
// conditions are the three scripts above. There is no second copy and no
// private path home before the timeout. The funder's unilateral exit does not
// get bounded or detected — it stops existing.
//
// ⭐ AND WHY THE ARBITER LEAF IS ENFORCEABLE WHERE SSS WAS NOT. The difference
// is not "2-of-3 on-chain instead of 2-of-3 off-chain". It is what enforces it:
//
//   SSS enforces by WHO KNOWS WHAT. A share is a capability you keep. You cannot
//   un-know it, you cannot put a clock on it, and any two shares work — so
//   arbiter + winner is as valid as buyer + seller, instantly, invisibly.
//
//   A leaf enforces by CONSENSUS CHECKING SIGNATURES AGAINST A COMMITTED SCRIPT.
//   A signature is permission granted ONCE, for ONE exact transaction — not a
//   standing capability. And because the condition is a script, TIME is
//   expressible: `CHECKSEQUENCEVERIFY` makes the chain refuse an
//   arbiter-assisted spend until N blocks after funding, whether or not any
//   client cooperates. That is the difference between a policy and a rule, and
//   it is what makes an appeal window real.
//
// ⚠ THE ARBITER PREMIUM DOES NOT RIDE ON-CHAIN. Settled by arithmetic, not
// preference: P2TR dust is 330 sats, and 0.25% of a 100,000-sat trade is 250.
// A premium output at the threshold size is literally unrelayable. So the
// premium stays exactly as it is — OOB ecash on kind 38113 — for on-chain
// escrows too. It is decoupled from where the escrow lives, which is also why
// it needs no change. (Above ~200k sats an on-chain premium output becomes
// payable; it is still not worth ~43 vbytes and a privacy leak to save an ecash
// note that already works.)
//
// PURE: no relays, no wallet, no network. Builds and verifies scripts only.

import * as btc from "@scure/btc-signer";
import { TAP_LEAF_VERSION, tapLeafHash } from "@scure/btc-signer/payment.js";
import { NUMS_INTERNAL_KEY, SIGNET, type BtcNetwork } from "./multisig.js";

/** ⭐⭐ WHICH NETWORK THE ESCROW LIVES ON — and why this is NOT `BOND_NETWORK`.
 *
 *  The obvious move when someone asks to "test on signet" is to flip the single
 *  `BOND_NETWORK` alias in useEscrow. Do not. That alias also derives every
 *  COMMITMENT BOND address, and there are real bonds posted on mainnet with real
 *  sats in them. Flipping it would make the app recompute those addresses on
 *  signet, find nothing there, and report a live bond as missing — while the
 *  actual coins sit untouched at an address the app has stopped looking at.
 *  Frightening, and entirely self-inflicted.
 *
 *  So the escrow gets its own switch. Bonds stay on mainnet; escrows can be
 *  tested on signet without touching them.
 *
 *  ⚠ THIS IS THE ONE LINE TO CHANGE when the on-chain escrow goes live:
 *  SIGNET → MAINNET. Everything cascades — address HRP (tb1p → bc1p), Esplora
 *  base, BIP86 coin index, and the `network` field written into every LOCK. */
export const ESCROW_NETWORK: BtcNetwork = SIGNET;

/** The label the LOCK payload carries, derived from the switch above so the two
 *  can never disagree. A cross-network address must never validate. */
export const ESCROW_NETWORK_LABEL: "mainnet" | "signet" =
  ESCROW_NETWORK === SIGNET ? "signet" : "mainnet";

/** ⭐ Which escrow a qualifying new listing defaults to.
 *
 *  ON A SIGNET BUILD THIS DEFAULTS TO ON-CHAIN, and that is deliberate rather
 *  than a shortcut. A signet escrow network means this build exists to exercise
 *  the on-chain path; if the picker still defaults to ecash, every listing a
 *  tester creates silently uses the OTHER substrate, looks identical, and the
 *  time is spent discovering that rather than testing. Defaulting to the thing
 *  under test is what makes a test build a test build.
 *
 *  On MAINNET this stays "ecash" — Jetty's call that on-chain is opt-in, and a
 *  user must never be moved onto a fee-paying, confirmation-waiting substrate
 *  without choosing it. So the one-line flip to MAINNET also restores the
 *  opt-in default automatically; there is no second switch to remember. */
export const DEFAULT_ESCROW_MODE: "ecash" | "onchain" =
  ESCROW_NETWORK === SIGNET ? "onchain" : "ecash";

/** Default threshold above which a trade should use the chain rather than
 *  ecash, in sats. From Chama's own measured round-trip cost (~1,700 sats
 *  fixed): 1.7% at 100k, 0.35% at 500k, absurd below 50k. User-raisable.
 *
 *  ⚠ NOT the same as `HIGH_VALUE_CONSENT_MSATS` (2,000 sats), which is a
 *  consent prompt, not an escrow-substrate decision. */
export const ONCHAIN_ESCROW_THRESHOLD_SATS = 100_000n;

/** CLTV term for the REFUND leaf, in blocks (~30 days at 10-minute blocks).
 *
 *  ⚠ THIS IS A SECURITY PARAMETER, NOT A CONVENIENCE ONE, and the intuition
 *  runs backwards from what it looks like. The refund leaf hands the FUNDER a
 *  unilateral exit — the very thing this escrow exists to remove — on a timer.
 *  So the term is "how long before rule zero comes back".
 *
 *  Shorter is NOT friendlier. A short term lets a malicious funder simply stall
 *  until maturity and then claw back sats the counterparty already earned. A
 *  long term means that for 30 days the ONLY ways out are cooperation or the
 *  arbiter — which is exactly the state we want. The cost of the long term is
 *  paid solely in the genuine-deadlock case (counterparty gone AND arbiter
 *  gone), where the funder waits to recover their own money.
 *
 *  Must comfortably exceed the longest trade life (Marketplace 3d). */
export const REFUND_CLTV_BLOCKS = 30 * 144;

/** ⭐ Blocks the DISPUTE leaf is held back after funding — the enforceable
 *  appeal window (S6). ~144 blocks ≈ 24 hours.
 *
 *  THIS IS THE THING THE WHOLE TIER EXISTS FOR. Everywhere else in Chama an
 *  appeal window is a request honest clients honour, and a colluding arbiter
 *  simply ignores it: they publish the vote-share envelope and the ecash moves
 *  the same second. Here the delay is compiled into the address itself, so a
 *  spend attempted early is not "impolite", it is INVALID — rejected by every
 *  node on the network, including the attacker's own.
 *
 *  ⚠ THE COST IS REAL AND SYMMETRIC: a genuine dispute also cannot settle until
 *  the window matures, so this delays honest arbitration exactly as much as
 *  corrupt arbitration. One day is chosen to be long enough for a losing party
 *  to notice and react, and short enough that an honest dispute is not a
 *  hardship. The cooperative path is untouched — a normal trade never waits.
 *
 *  ⚠ Changing this changes the ADDRESS. It is a term of the escrow, not a
 *  client setting: two clients on different values compute different addresses
 *  and one of them will refuse to fund. Ship a change deliberately. */
export const DISPUTE_CSV_BLOCKS = 144;

export interface OnchainEscrowParams {
  /** 32-byte x-only BIP340 keys. All three must be distinct. */
  buyerXonly: Uint8Array;
  sellerXonly: Uint8Array;
  arbiterXonly: Uint8Array;
  /** Who gets the refund leaf — the party who funded. Must be buyer or seller. */
  funder: "buyer" | "seller";
  /** Absolute block height the refund leaf matures at (BIP65 height domain). */
  refundLockUntil: number;
  /** Relative blocks the dispute leaf is held back. 0 = no window. */
  disputeCsvBlocks?: number;
  network?: BtcNetwork;
}

export interface OnchainEscrow {
  address: string;
  /** The output scriptPubKey, for UTXO matching. */
  script: Uint8Array;
  /** Each leaf's script, so a verifier can recompute the whole tree. */
  leaves: {
    coop: Uint8Array;
    dispute: Uint8Array;
    refund: Uint8Array;
  };
  params: Required<Omit<OnchainEscrowParams, "network">> & { network: BtcNetwork };
}

function assertXonly(key: Uint8Array, name: string): void {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error(`${name} must be a 32-byte x-only pubkey`);
  }
}

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** 2-of-2 {buyer, seller} — the cooperative path.
 *
 *  ⚠ A SCRIPT LEAF, DELIBERATELY, NOT A MuSig2 KEYPATH. MuSig2 would be one
 *  signature, cheaper, and indistinguishable from an ordinary payment — but it
 *  needs a two-round interactive nonce-and-partial-signature exchange between
 *  buyer and seller over Nostr, where either party dropping mid-round must not
 *  strand real money. A leaf is non-interactive and reuses the already-tested
 *  `coSignPsbt` / `combineAndFinalize` path verbatim. Trading a few vbytes and a
 *  little privacy to delete the hardest dependency is the right call for the
 *  first shipment of a money path. MuSig2 stays available as a later
 *  optimisation that changes no security property. */
export function buildCoopLeaf(buyerXonly: Uint8Array, sellerXonly: Uint8Array): Uint8Array {
  assertXonly(buyerXonly, "buyerXonly");
  assertXonly(sellerXonly, "sellerXonly");
  // p2tr_ms emits the OP_CHECKSIGADD form — same construction the shipped
  // bond multisig uses, so the signing path is already exercised.
  return (btc.p2tr_ms(2, [buyerXonly, sellerXonly]) as unknown as { script: Uint8Array }).script;
}

/** 2-of-3 {buyer, seller, arbiter}, optionally held back by CSV.
 *
 *  The arbiter is never sufficient alone — the script demands two signatures, so
 *  a corrupt arbiter still needs a principal to sign with them. What the leaf
 *  adds over SSS is that this is checked by consensus rather than by who happens
 *  to hold which secret, and that a delay can be attached to it. */
export function buildDisputeLeaf(
  buyerXonly: Uint8Array,
  sellerXonly: Uint8Array,
  arbiterXonly: Uint8Array,
  csvBlocks = 0,
): Uint8Array {
  for (const [k, n] of [[buyerXonly, "buyerXonly"], [sellerXonly, "sellerXonly"], [arbiterXonly, "arbiterXonly"]] as const) {
    assertXonly(k as Uint8Array, n as string);
  }
  const keys = [buyerXonly, sellerXonly, arbiterXonly];
  if (new Set(keys.map(hex)).size !== 3) {
    throw new Error("buyer, seller and arbiter must be three distinct keys");
  }
  const ms = (btc.p2tr_ms(2, keys) as unknown as { script: Uint8Array }).script;
  if (!csvBlocks) return ms;
  if (!Number.isInteger(csvBlocks) || csvBlocks <= 0 || csvBlocks > 65535) {
    throw new Error("disputeCsvBlocks must be a positive integer under 65536");
  }
  // Prefix the appeal window: the chain rejects this branch until the input has
  // `csvBlocks` confirmations. BIP112 relative-time, block domain.
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(csvBlocks)),
    "CHECKSEQUENCEVERIFY",
    "DROP",
    ...(btc.Script.decode(ms) as (string | Uint8Array | number | bigint)[]),
  ] as Parameters<typeof btc.Script.encode>[0]);
}

/** `<height> CLTV DROP <funder> CHECKSIG` — the everyone-vanished backstop.
 *  Same construction as the shipped commitment bond's timelock leaf. */
export function buildRefundLeaf(funderXonly: Uint8Array, lockUntil: number): Uint8Array {
  assertXonly(funderXonly, "funderXonly");
  if (!Number.isInteger(lockUntil) || lockUntil <= 0 || lockUntil >= 500_000_000) {
    // Below 500,000,000 keeps CLTV in the BLOCK-HEIGHT domain (BIP65); the
    // spending tx's nLockTime must match that domain or the spend is invalid.
    throw new Error("lockUntil must be a positive block height below 500000000");
  }
  return btc.Script.encode([
    btc.ScriptNum().encode(BigInt(lockUntil)),
    "CHECKLOCKTIMEVERIFY",
    "DROP",
    funderXonly,
    "CHECKSIG",
  ]);
}

/** ⭐ Build the escrow address.
 *
 *  NUMS internal key: there is no keypath spend, so nobody — including whoever
 *  assembled the tree — holds a private path around the scripts. Every exit is
 *  one of the three leaves, and every leaf is publicly committed to by the
 *  address itself. */
export function buildOnchainEscrow(params: OnchainEscrowParams): OnchainEscrow {
  const network = params.network ?? SIGNET;
  const csv = params.disputeCsvBlocks ?? 0;
  if (params.funder !== "buyer" && params.funder !== "seller") {
    throw new Error('funder must be "buyer" or "seller"');
  }
  const coop = buildCoopLeaf(params.buyerXonly, params.sellerXonly);
  const dispute = buildDisputeLeaf(params.buyerXonly, params.sellerXonly, params.arbiterXonly, csv);
  const refund = buildRefundLeaf(
    params.funder === "buyer" ? params.buyerXonly : params.sellerXonly,
    params.refundLockUntil,
  );
  // allowUnknownOutputs: @scure has no built-in coder for the CLTV/CSV leaves.
  // The address and control blocks are still computed correctly — BIP341 is
  // script-agnostic — and the witness is finalized by hand at spend time.
  const p = btc.p2tr(
    NUMS_INTERNAL_KEY,
    [{ script: coop }, { script: dispute }, { script: refund }] as never,
    network,
    true,
  );
  return {
    address: p.address!,
    script: p.script,
    leaves: { coop, dispute, refund },
    params: {
      buyerXonly: params.buyerXonly,
      sellerXonly: params.sellerXonly,
      arbiterXonly: params.arbiterXonly,
      funder: params.funder,
      refundLockUntil: params.refundLockUntil,
      disputeCsvBlocks: csv,
      network,
    },
  };
}

/** ⭐ RECOMPUTE-DON'T-TRUST. No party may ever fund an address that arrived over
 *  a wire: a tampered one sends real money to an attacker and the payment is
 *  irreversible. Every client rebuilds locally from (keys, heights, network) and
 *  refuses on mismatch — the same rule `recomputeAddress` enforces for bonds. */
export function recomputeOnchainEscrowAddress(params: OnchainEscrowParams): string {
  return buildOnchainEscrow(params).address;
}

/** True when a wire-supplied address reproduces from the wire-supplied terms.
 *  A false here is a hard stop, never a warning. */
export function onchainEscrowAddressMatches(
  claimedAddress: string,
  params: OnchainEscrowParams,
): boolean {
  try {
    return recomputeOnchainEscrowAddress(params) === claimedAddress.trim();
  } catch {
    return false;
  }
}

/** Should this trade use the chain rather than ecash? Advisory: the brief's
 *  decision 3 is that on-chain is OPT-IN above the threshold, so this answers
 *  "is it offered", never "is it forced".
 *
 *  ⚠ Copy rule, per Jetty: the offer must NOT editorialise ("fast here, slow
 *  there"). State what each does and let the user choose. */
export function onchainEscrowAvailable(
  amountSats: bigint,
  thresholdSats: bigint = ONCHAIN_ESCROW_THRESHOLD_SATS,
): boolean {
  return amountSats >= thresholdSats;
}

/** ⚠ The REFUND leaf cannot be auto-finalized, and this is expected.
 *
 *  `@scure/btc-signer` has no built-in coder for a CLTV leaf, so `tx.finalize()`
 *  throws "Unknown tapLeafScript" on it — exactly as it does for the shipped
 *  commitment bond, whose `buildReclaimTx` hand-assembles the witness instead.
 *  The pattern is proven; this is the same three-element witness.
 *
 *  Two consensus details that are easy to get wrong and silently produce an
 *  invalid transaction:
 *   • `lockTime` must be in the BLOCK-HEIGHT domain and ≥ the leaf's height;
 *   • `sequence` must be < 0xffffffff or nLockTime (and therefore CLTV) is not
 *     enforced at all — the classic footgun.
 *
 *  Returns the finalized witness stack for input `index`; the caller assembles
 *  the transaction (S4/S5 own that, with `verifyReturnPsbt` in front of it). */
export function refundWitnessFor(
  escrow: OnchainEscrow,
  tx: btc.Transaction,
  index: number,
): Uint8Array[] {
  return leafWitnessFor(escrow, tx, index, "refund");
}

/** ⭐ Hand-assemble the witness for ANY leaf.
 *
 *  ⚠ NEEDED FOR THE DISPUTE LEAF ONCE THE APPEAL WINDOW IS ON. Without CSV the
 *  dispute leaf is a plain `p2tr_ms` script that @scure finalizes itself. Add
 *  the CSV prefix and it becomes a script @scure has no coder for, so
 *  `tx.finalize()` throws "Unknown tapLeafScript" — the same wall the CLTV
 *  refund leaf hits. Turning the window on therefore turns the dispute path into
 *  a hand-finalized one, which is easy to miss and would surface as a settlement
 *  that cannot be broadcast.
 *
 *  ⚠ WITNESS ORDER IS REVERSED for a `CHECKSIGADD` multisig. The script checks
 *  the FIRST pubkey against the TOP of the stack, and the witness array is
 *  pushed in order — so signatures go in REVERSE key order, with an empty item
 *  standing in for each key that did not sign. Get this backwards and every
 *  signature is checked against the wrong key. */
export function leafWitnessFor(
  escrow: OnchainEscrow,
  tx: btc.Transaction,
  index: number,
  leaf: "coop" | "dispute" | "refund",
): Uint8Array[] {
  const p = btc.p2tr(
    NUMS_INTERNAL_KEY,
    [
      { script: escrow.leaves.coop },
      { script: escrow.leaves.dispute },
      { script: escrow.leaves.refund },
    ] as never,
    escrow.params.network,
    true,
  );
  const leaves = (p as unknown as { leaves: { script: Uint8Array; controlBlock: Uint8Array }[] }).leaves;
  const script = escrow.leaves[leaf];
  const found = leaves.find((l) => hex(l.script) === hex(script));
  if (!found) throw new Error(`${leaf} leaf missing from the recomputed tree`);

  // A signer can appear in more than one leaf, and @scure records one
  // tapScriptSig per (pubkey, leafHash).  Only signatures made for the leaf
  // whose script/control block we are revealing are valid in this witness.
  // Selecting by pubkey alone can silently pair a dispute signature with the
  // coop script (or vice versa), producing a transaction nodes reject.
  const targetLeafHash = hex(tapLeafHash(script, TAP_LEAF_VERSION));
  const sigs = (tx.getInput(index).tapScriptSig ?? []).filter(
    ([meta]) => hex(meta.leafHash) === targetLeafHash,
  );
  if (sigs.length === 0) throw new Error(`${leaf} input is not signed yet`);

  if (leaf === "refund") {
    // Single-signer leaf: one signature, then script + control block.
    return [sigs[0][1], script, found.controlBlock];
  }

  // CHECKSIGADD leaves: one slot per key, in reverse key order.
  const keys = leaf === "coop"
    ? [escrow.params.buyerXonly, escrow.params.sellerXonly]
    : [escrow.params.buyerXonly, escrow.params.sellerXonly, escrow.params.arbiterXonly];
  const byKey = new Map(sigs.map(([meta, sig]) => [hex(meta.pubKey), sig]));
  const stack = keys.map((k) => byKey.get(hex(k)) ?? new Uint8Array(0));
  stack.reverse();
  return [...stack, script, found.controlBlock];
}

/** Spend size per leaf, for fee quoting before the user commits.
 *  ⭐ MEASURED from real finalized spends in the S1 probe, not derived — a
 *  derived estimate that is 10% low turns into a stuck transaction. */
export const LEAF_SPEND_VSIZE = {
  /** 2 signatures + control block. Measured. */
  coop: 162,
  /** 2 signatures + 1 empty slot + control block. Measured. */
  dispute: 179,
  /** 1 signature + CLTV leaf + control block. Hand-finalized; measured. */
  refund: 146,
} as const;

export function estimateSettleFeeSats(
  leaf: keyof typeof LEAF_SPEND_VSIZE,
  feeRateSatsPerVb: bigint,
): bigint {
  return BigInt(LEAF_SPEND_VSIZE[leaf]) * feeRateSatsPerVb;
}
