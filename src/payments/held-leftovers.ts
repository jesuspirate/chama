// ══════════════════════════════════════════════════════════════════════════
// Chama — leftover sats that are still on their way out (data for Home)
// ══════════════════════════════════════════════════════════════════════════
//
// Home lists every place Chama holds sats. Stranded claims, the pending ecash
// export, failed-lock refunds and kept federation wallets already have cards.
// This module gathers the remaining places, as data only, so the screens can
// say who holds the sats, until when, and the one way out:
//
//   claim-retrying          a claim Chama is still redeeming automatically
//   fedi-funding-returning  Fedi ecash spent for a lock that never published,
//                           being put back into the Fedi wallet
//   bond-key-waiting        a reclaimed bond sitting at its bond key
//   bond-credit-confirming  a reclaimed bond on its way into the Chama wallet
//   onchain-payout          an on-chain trade payout not yet sent out
//
// "Couldn't read" is never "nothing there": a store or explorer that fails to
// answer is reported in `unchecked`, never as an empty list.

import type { PendingRedemption } from "../fedimint/pending-redemptions.js";
import { isRetryingAutomatically } from "../fedimint/pending-redemptions.js";
import type { PendingFunding } from "../fedimint/pending-fundings.js";
import type { CommitmentRecord } from "../bond-multisig/commitment-store.js";
import type { OnchainPayout, OnchainPayoutCandidate } from "../bond-multisig/onchain-payout-wallet.js";

/** Who holds the sats right now. */
export type LeftoverHolder =
  /** The trade's federation, as ecash Chama is still redeeming. */
  | "federation"
  /** The Fedi app's own wallet, once Fedi takes the notes back. */
  | "fedi"
  /** A Bitcoin key derived from this account's wallet seed. */
  | "your-key";

/** Until when, or what ends the wait. */
export type LeftoverUntil =
  /** Chama keeps retrying by itself; nothing to tap yet. */
  | "automatic-retry"
  /** Only a Fedi session can take the notes back. */
  | "next-fedi-session"
  /** Waiting for Bitcoin confirmations. */
  | "confirmations"
  /** Stays until the person sends it out. */
  | "you-send-it-out";

interface LeftoverBase {
  /** Stable key for a card. */
  id: string;
  holder: LeftoverHolder;
  until: LeftoverUntil;
  /** Unix ms the sats arrived here, when known. */
  since?: number;
}

export type HeldLeftover =
  | LeftoverBase & { kind: "claim-retrying"; escrowId: string; amountMsats: number; attempts: number }
  | LeftoverBase & { kind: "fedi-funding-returning"; escrowId: string; amountMsats: number; attempts: number; lastError?: string }
  | LeftoverBase & { kind: "bond-key-waiting"; bondId: string; amountSats: bigint; address: string }
  | LeftoverBase & { kind: "bond-credit-confirming"; bondId: string; amountSats: bigint; txid: string }
  | LeftoverBase & { kind: "onchain-payout"; escrowId: string; amountSats: bigint; address: string; unconfirmed: boolean };

export type LeftoverSource = "claims" | "fedi-fundings" | "bonds" | "onchain-payouts";

export interface UncheckedLeftover {
  source: LeftoverSource;
  /** The trade a failed explorer read was for, when there is one. */
  escrowId?: string;
  reason: string;
}

export interface HeldLeftovers {
  entries: HeldLeftover[];
  /** Places Chama could not read. Never treat these as empty. */
  unchecked: UncheckedLeftover[];
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Claims still being redeemed automatically. Stranded entries, archived
 *  entries, credited ones (the payout card) and the legacy manual-export slot
 *  (the export card) already have their own cards. */
export function retryingClaims(entries: readonly PendingRedemption[]): HeldLeftover[] {
  return entries
    .filter(isRetryingAutomatically)
    .map(entry => ({
      kind: "claim-retrying" as const, id: `claim:${entry.escrowId}`, escrowId: entry.escrowId,
      amountMsats: entry.amountMsats, attempts: entry.attempts, since: entry.createdAt,
      holder: "federation" as const, until: "automatic-retry" as const,
    }));
}

/** Fedi fundings that never locked. Every entry is listed: the notes are
 *  bearer money until Fedi confirms it took them back, which clears it. */
export function returningFediFundings(entries: readonly PendingFunding[], inFedi: boolean): HeldLeftover[] {
  return entries.filter(entry => entry.amountMsats > 0).map(entry => ({
    kind: "fedi-funding-returning" as const, id: `fedi-funding:${entry.escrowId}`, escrowId: entry.escrowId,
    amountMsats: entry.amountMsats, attempts: entry.attempts, since: entry.createdAt,
    ...(entry.lastError ? { lastError: entry.lastError } : {}),
    holder: "fedi" as const, until: inFedi ? "automatic-retry" as const : "next-fedi-session" as const,
  }));
}

/** Reclaimed bonds whose sats have not reached the person yet. */
export function reclaimedBondLeftovers(records: readonly CommitmentRecord[]): HeldLeftover[] {
  const out: HeldLeftover[] = [];
  for (const rec of records) {
    if (rec.phase !== "reclaimed" || !rec.reclaimTxid) continue;
    const swept = rec.utxos?.reduce((sum, utxo) => sum + utxo.amountSats, 0n) ?? 0n;
    const amountSats = swept > 0n ? swept : rec.amountSats;
    if (rec.creditTxid) {
      if (rec.creditConfirmedAt) continue;
      out.push({ kind: "bond-credit-confirming", id: `bond-credit:${rec.bondId}`, bondId: rec.bondId,
        amountSats, txid: rec.creditTxid, holder: "federation", until: "confirmations" });
    } else if (rec.reclaimDestination?.actual === "bond-key") {
      out.push({ kind: "bond-key-waiting", id: `bond-key:${rec.bondId}`, bondId: rec.bondId,
        amountSats, address: rec.reclaimDestination.address, holder: "your-key", until: "you-send-it-out" });
    }
  }
  return out;
}

/** Scan every on-chain payout key separately. One explorer failure marks
 *  that trade unchecked; it never hides the others or reads as zero. */
export async function readOnchainPayoutLeftovers(
  candidates: readonly OnchainPayoutCandidate[],
  scan: (candidate: OnchainPayoutCandidate) => Promise<OnchainPayout>,
): Promise<HeldLeftovers> {
  const results = await Promise.allSettled(candidates.map(candidate => scan(candidate)));
  const entries: HeldLeftover[] = [];
  const unchecked: UncheckedLeftover[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      unchecked.push({ source: "onchain-payouts", escrowId: candidates[i].escrowId, reason: reasonOf(result.reason) });
      return;
    }
    const payout = result.value;
    if (payout.balanceSats <= 0n) return;
    entries.push({ kind: "onchain-payout", id: `onchain-payout:${payout.escrowId}`, escrowId: payout.escrowId,
      amountSats: payout.balanceSats, address: payout.address, unconfirmed: payout.hasUnconfirmed,
      holder: "your-key", until: "you-send-it-out" });
  });
  return { entries, unchecked };
}

export interface LeftoverReaders {
  claims: () => readonly PendingRedemption[];
  fediFundings: () => readonly PendingFunding[];
  inFedi: boolean;
  bonds: () => { records: readonly CommitmentRecord[]; unreadable: number };
  payoutCandidates: () => readonly OnchainPayoutCandidate[];
  scanPayout: (candidate: OnchainPayoutCandidate) => Promise<OnchainPayout>;
}

/** Every remaining leftover, in one read. Each store is read on its own so
 *  one failing store is named in `unchecked` and the rest still show. */
export async function readHeldLeftovers(readers: LeftoverReaders): Promise<HeldLeftovers> {
  const entries: HeldLeftover[] = [];
  const unchecked: UncheckedLeftover[] = [];
  const local = (source: LeftoverSource, read: () => HeldLeftover[]) => {
    try { entries.push(...read()); }
    catch (error) { unchecked.push({ source, reason: reasonOf(error) }); }
  };
  local("claims", () => retryingClaims(readers.claims()));
  local("fedi-fundings", () => returningFediFundings(readers.fediFundings(), readers.inFedi));
  local("bonds", () => {
    const { records, unreadable } = readers.bonds();
    // Bonds that no longer parse are named, without hiding the good ones.
    if (unreadable > 0) unchecked.push({ source: "bonds", reason: `${unreadable} saved bond${unreadable === 1 ? "" : "s"} couldn't be read.` });
    return reclaimedBondLeftovers(records);
  });
  let candidates: readonly OnchainPayoutCandidate[] = [];
  try { candidates = readers.payoutCandidates(); }
  catch (error) { unchecked.push({ source: "onchain-payouts", reason: reasonOf(error) }); }
  const onchain = await readOnchainPayoutLeftovers(candidates, readers.scanPayout);
  entries.push(...onchain.entries);
  unchecked.push(...onchain.unchecked);
  return { entries, unchecked };
}
