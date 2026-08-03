// ══════════════════════════════════════════════════════════════════════════
// Chama — on-chain escrow: keys, funding, and the LOCK terms (Tier 2.1, S3)
// ══════════════════════════════════════════════════════════════════════════
//
// S1 built the address. S2 taught the protocol to carry it. S3 answers the two
// questions that decide whether real money is safe:
//
//   1. WHOSE KEYS control this escrow, and can those people actually sign?
//   2. Has the money genuinely arrived, at the address WE recomputed?
//
// PURE: no relays, no wallet, no network. Callers supply seed words and UTXOs.

import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { SIGNET, type BtcNetwork, type BondUtxo } from "./multisig.js";
import { buildOnchainEscrow, type OnchainEscrowParams } from "./onchain-escrow.js";

// ── 1. Keys ────────────────────────────────────────────────────────────────
//
// ⚠⚠ A NOSTR PUBKEY CANNOT BE USED AS THE ESCROW KEY, and this is the single
// most important finding in S3. It is tempting: a Nostr pubkey already IS a
// 32-byte BIP340 x-only key, so the address could be built from the three
// identities with no key exchange at all. It does not work, for two independent
// reasons, either one fatal:
//
//   • MOST USERS COULD NEVER SIGN. NIP-07 extensions and Amber sign Nostr
//     EVENTS, not arbitrary sighashes. A user whose nsec lives in Alby or Amber
//     — which Chama actively steers browser users toward — would be locked out
//     of their own escrow forever. Money that cannot be signed for is money lost.
//   • IT WELDS IDENTITY TO COINS. Every on-chain spend would publish a signature
//     under the user's public trading identity, linking their whole Nostr history
//     to specific UTXOs on a public chain. That is the opposite of what a
//     no-KYC product owes its users.
//
// So escrow keys are DERIVED from the BIP-39 seed Chama already manages, the
// same source the commitment bond uses — signing is local, needs no extension,
// and produces keys unlinked to the Nostr identity.

/** Derivation path for a trade's escrow key. Distinct ACCOUNT from the bond
 *  (`m/86'/coin'/0'/...`) so an escrow key and a bond key can never collide, and
 *  a compromised escrow key tells an attacker nothing about a bond. */
export function bip86EscrowPath(network: BtcNetwork = SIGNET, index = 0): string {
  const coin = network === SIGNET ? 1 : 0;
  return `m/86'/${coin}'/1'/0/${Math.floor(index)}`;
}

/** A stable per-trade derivation index from the escrow id.
 *
 *  ⚠ Deterministic on purpose: the key must be re-derivable from (seed, escrow
 *  id) alone, on a fresh install, months later, with no local record. A random
 *  index stored in localStorage would mean a storage wipe permanently strands
 *  on-chain money — a class of loss this codebase has already been bitten by.
 *
 *  Not secret and not required to be unpredictable: the resulting PUBLIC key is
 *  published anyway. It only needs to be stable and collision-resistant enough
 *  that two of a user's own trades get different keys. */
export function escrowKeyIndexFor(escrowId: string): number {
  let h = 0x811c9dc5; // FNV-1a, 32-bit
  for (let i = 0; i < escrowId.length; i++) {
    h ^= escrowId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  // Keep inside the non-hardened BIP32 range.
  return h % 0x7fffffff;
}

/** Derive this user's escrow key for one trade. The private key is never stored
 *  — it is re-derived from (seed, escrow id) whenever a signature is needed. */
export function deriveEscrowSigningKey(
  mnemonic: string,
  escrowId: string,
  opts?: { network?: BtcNetwork; passphrase?: string },
): { priv: Uint8Array; xonly: Uint8Array; path: string } {
  if (!escrowId) throw new Error("escrowId is required to derive an escrow key");
  const network = opts?.network ?? SIGNET;
  const path = bip86EscrowPath(network, escrowKeyIndexFor(escrowId));
  const seed = mnemonicToSeedSync(mnemonic.trim(), opts?.passphrase ?? "");
  const node = HDKey.fromMasterSeed(seed).derive(path);
  if (!node.privateKey) throw new Error("BIP86 derivation produced no private key");
  return { priv: node.privateKey, xonly: btc.utils.pubSchnorr(node.privateKey), path };
}

// ── 2. Funding readiness ───────────────────────────────────────────────────

/** Why an escrow address cannot be computed yet. Each is a precise, actionable
 *  missing input rather than a generic failure — a funder staring at "not ready"
 *  with no reason will either wait forever or fund something they shouldn't. */
export type FundingBlocker =
  | "missing-buyer-key"
  | "missing-seller-key"
  | "missing-arbiter-key"
  | "keys-not-distinct"
  | "bad-refund-height"
  /** 64 hex characters that are not a valid curve point.
   *
   *  ⚠ A separate blocker because it is a DIFFERENT failure with a different
   *  cause. "Missing" means someone hasn't published yet — wait. "Invalid" means
   *  what they published cannot be a Bitcoin key, which is either a broken
   *  client or a hostile one. Hex-shaped is not curve-shaped, and only
   *  `p2tr_ms` finds out; without this, a peer publishing 64 bytes of garbage
   *  would throw out of the funding screen instead of being reported. */
  | "invalid-key";

export type FundingPlan =
  | { ready: true; address: string; params: OnchainEscrowParams }
  | { ready: false; blockers: FundingBlocker[] };

/** Can this trade be funded on-chain yet, and to what address?
 *
 *  ⚠ ALL THREE KEYS MUST EXIST BEFORE FUNDING, which is a real sequencing change
 *  from ecash. An ecash lock needs only the locker; a Taproot address is a
 *  commitment to all three spending identities, so it cannot even be COMPUTED
 *  until the arbiter's key is known. In today's flow the arbiter is seated at
 *  LOCK — too late. So an on-chain trade requires the arbiter to publish their
 *  escrow key BEFORE funding (JOIN carries it; no new event kind needed).
 *
 *  This function is the honest gate on that: it never guesses a missing key, and
 *  it never invents an address. */
export function resolveFundingPlan(params: {
  buyerXonly?: string | null;
  sellerXonly?: string | null;
  arbiterXonly?: string | null;
  funder: "buyer" | "seller";
  refundLockUntil: number;
  disputeCsvBlocks?: number;
  network: BtcNetwork;
}): FundingPlan {
  const blockers: FundingBlocker[] = [];
  const hex64 = (v: unknown): string | null =>
    typeof v === "string" && /^[0-9a-f]{64}$/.test(v.trim().toLowerCase())
      ? v.trim().toLowerCase()
      : null;
  const b = hex64(params.buyerXonly);
  const s = hex64(params.sellerXonly);
  const a = hex64(params.arbiterXonly);
  if (!b) blockers.push("missing-buyer-key");
  if (!s) blockers.push("missing-seller-key");
  if (!a) blockers.push("missing-arbiter-key");
  if (b && s && a && new Set([b, s, a]).size !== 3) blockers.push("keys-not-distinct");
  if (!Number.isInteger(params.refundLockUntil) || params.refundLockUntil <= 0
    || params.refundLockUntil >= 500_000_000) blockers.push("bad-refund-height");
  if (blockers.length > 0) return { ready: false, blockers };

  const escrowParams: OnchainEscrowParams = {
    buyerXonly: hexToBytes(b!),
    sellerXonly: hexToBytes(s!),
    arbiterXonly: hexToBytes(a!),
    funder: params.funder,
    refundLockUntil: params.refundLockUntil,
    disputeCsvBlocks: params.disputeCsvBlocks ?? 0,
    network: params.network,
  };
  // Built, not asserted: if the tree cannot be constructed there is no address,
  // and saying "ready" would point a funder at nothing.
  //
  // ⚠ The build is the ONLY place a hex-shaped non-curve-point key is caught —
  // `p2tr_ms` throws "wrong pubkey". Returning a blocker rather than propagating
  // keeps a hostile or broken peer from crashing the funding screen, and tells
  // the user something true instead of nothing.
  try {
    return { ready: true, address: buildOnchainEscrow(escrowParams).address, params: escrowParams };
  } catch {
    return { ready: false, blockers: ["invalid-key"] };
  }
}

// ── 3. Has the money actually arrived? ─────────────────────────────────────

export type FundingVerdict =
  /** Confirmed, deep enough, and at least the expected amount. LOCK may publish. */
  | { funded: true; amountSats: bigint; txid: string; vout: number }
  /** Nothing confirmed yet at the recomputed address. */
  | { funded: false; reason: "no-deposit" }
  /** Something arrived but is short of the trade amount. */
  | { funded: false; reason: "underfunded"; amountSats: bigint; expectedSats: bigint }
  /** Deposits exist but none is deep enough yet. */
  | { funded: false; reason: "unconfirmed"; amountSats: bigint };

/**
 * ⭐ Decide whether an on-chain escrow is funded.
 *
 * ⚠ THE CALLER MUST PASS UTXOs READ FROM THE ADDRESS THIS MODULE RECOMPUTED,
 * never from an address that arrived over the wire. `resolveFundingPlan` returns
 * that address for exactly this reason. Verifying a deposit at an attacker's
 * address proves the attacker was paid.
 *
 * ⚠ UNDERFUNDING IS NOT ROUNDED AWAY. A short deposit is reported as short, with
 * both numbers, and never treated as good enough. An escrow holding less than the
 * trade is an escrow that cannot pay the winner, and "close enough" is how a
 * counterparty ends up shipping goods against a partial deposit.
 */
export function verifyFunding(params: {
  utxos: readonly BondUtxo[];
  expectedSats: bigint;
  /** Confirmations required. 1 on mainnet, matching the bond ceremony. */
  minConfs?: number;
  /** Per-utxo confirmation depth, same order as `utxos`. Absent ⇒ treated as
   *  confirmed, because the caller's UTXO reader already filters unconfirmed
   *  deposits (`findBondFundingUtxos`) and inventing a zero here would report a
   *  real deposit as missing. */
  confirmations?: readonly number[];
}): FundingVerdict {
  const minConfs = Math.max(1, Math.floor(params.minConfs ?? 1));
  if (params.utxos.length === 0) return { funded: false, reason: "no-deposit" };

  const deep: { utxo: BondUtxo; index: number }[] = [];
  let total = 0n;
  for (let i = 0; i < params.utxos.length; i++) {
    const u = params.utxos[i];
    total += u.amountSats;
    const confs = params.confirmations?.[i];
    if (confs === undefined || confs >= minConfs) deep.push({ utxo: u, index: i });
  }
  const deepTotal = deep.reduce((sum, d) => sum + d.utxo.amountSats, 0n);

  if (deepTotal < params.expectedSats) {
    // Distinguish "not deep enough yet" (resolves on its own) from "not enough
    // money" (needs the funder to act). Telling a user to wait when they
    // actually need to send more is a trade that quietly dies.
    if (total >= params.expectedSats) return { funded: false, reason: "unconfirmed", amountSats: deepTotal };
    return { funded: false, reason: "underfunded", amountSats: total, expectedSats: params.expectedSats };
  }
  // The largest confirmed deposit is the escrow outpoint the LOCK will name.
  const primary = deep.reduce((best, d) => (d.utxo.amountSats > best.utxo.amountSats ? d : best), deep[0]);
  return {
    funded: true,
    amountSats: deepTotal,
    txid: primary.utxo.txid,
    vout: primary.utxo.index,
  };
}

// ── 4. The LOCK terms ──────────────────────────────────────────────────────

/** Build the on-chain terms for a LOCK payload from a verified funding.
 *
 *  Takes the FundingPlan (whose address was recomputed locally) and the
 *  FundingVerdict (which proved the deposit), so the terms can only ever
 *  describe an escrow this client derived itself and confirmed itself. */
export function buildOnchainLockTerms(
  plan: Extract<FundingPlan, { ready: true }>,
  funded: Extract<FundingVerdict, { funded: true }>,
  network: "mainnet" | "signet",
) {
  const p = plan.params;
  return {
    address: plan.address,
    fundingTxid: funded.txid,
    fundingVout: funded.vout,
    amountSats: funded.amountSats.toString(),
    buyerXonly: bytesToHex(p.buyerXonly),
    sellerXonly: bytesToHex(p.sellerXonly),
    arbiterXonly: bytesToHex(p.arbiterXonly),
    funder: p.funder,
    refundLockUntil: p.refundLockUntil,
    disputeCsvBlocks: p.disputeCsvBlocks ?? 0,
    network,
  };
}
