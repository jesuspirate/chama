// ══════════════════════════════════════════════════════════════════════════
// On-chain cover: the largest on-chain trade this chama's arbiters can take
// ══════════════════════════════════════════════════════════════════════════
//
// An on-chain escrow needs a bonded arbiter whose free bond covers the trade.
// CREATE refuses a listing nobody can cover, but only on Publish, after the
// seller has filled everything in (Jet, 2026-10-26). This module gives the
// amount field the SAME number in advance: the same bonds, the same open-trade
// exposure read and the same capacity rule as the refusal. Read-only; Publish
// keeps its own check as the last gate.

import { useEffect, useRef, useState } from "react";
import type { VerifiedBond } from "../bond-multisig/bond-announcement.js";
import { defaultEsploraBase, esploraFetcher } from "../bond-multisig/fund-watcher.js";
import { MAINNET, SIGNET } from "../bond-multisig/multisig.js";
import { defaultEscrowModeForAmount } from "../bond-multisig/onchain-escrow.js";
import type { EscrowState } from "../escrow-engine/types.js";
import { isOpenExposure, largestOnchainCoverSats, tradesWithUnspentExposure } from "../arbiters/exposure.js";
import { Role } from "../escrow-engine/types.js";
import { declaresArbiterRole } from "../arbiters/live-chama.js";

export type OnchainCover =
  | { status: "loading" }
  | { status: "unchecked" }
  | { status: "ready"; sats: number };

/** Bonds that can be SEATED on an on-chain escrow: funded, active, licensed
 *  to arbitrate, and carrying the escrow key the address is built from. */
export function seatableOnchainBonds(bonds: readonly VerifiedBond[]): VerifiedBond[] {
  return bonds.filter(b => b.funded && b.active && declaresArbiterRole(b) && !!b.ownerXonly);
}

/** Open bonded trades still holding a deposit. A failed chain read keeps the
 *  trade counted: unknown is never free capacity. */
export function readUnspentExposure(allTrades: readonly EscrowState[]): Promise<EscrowState[]> {
  return tradesWithUnspentExposure(allTrades, async deposit => {
    const network = deposit.network === "signet" ? SIGNET : MAINNET;
    return esploraFetcher(defaultEsploraBase(network), { network })(`/tx/${deposit.fundingTxid}/outspend/${deposit.fundingVout}`);
  });
}

/** The default rail for an amount, steered away from on-chain when the chama
 *  cannot cover it. Only the SUGGESTION moves; the person can still pick
 *  on-chain, and Publish still refuses a trade nobody can cover. */
export function suggestedEscrowMode(
  amountSats: number,
  coverageSats: number,
  cover: OnchainCover,
): "ecash" | "onchain" {
  const mode = defaultEscrowModeForAmount(BigInt(Math.max(0, Math.floor(amountSats))));
  if (mode === "onchain" && cover.status === "ready" && coverageSats > cover.sats) return "ecash";
  return mode;
}

/** True when an on-chain trade of `coverageSats` is above what this chama's
 *  arbiters can cover today. Unknown cover is never "too big". */
export function onchainCoverShort(coverageSats: number, cover: OnchainCover): boolean {
  return cover.status === "ready" && coverageSats > cover.sats;
}

/** Live cover for a chama. `bonds` undefined = still loading; null = the read
 *  failed. Never shows a number it has not read. */
export function useOnchainCover(params: {
  bonds: readonly VerifiedBond[] | null | undefined;
  allTrades: readonly EscrowState[];
  viewerPubkey?: string | null;
}): OnchainCover {
  const { bonds, allTrades, viewerPubkey } = params;
  const [cover, setCover] = useState<OnchainCover>({ status: "loading" });
  // Callers rebuild the trade list every render; re-read the chain only when
  // the set of open bonded trades actually changes.
  const tradesRef = useRef(allTrades);
  tradesRef.current = allTrades;
  const exposureKey = allTrades
    .filter(isOpenExposure)
    .map(t => `${t.id}:${t.status}:${t.amountMsats}:${t.participants?.[Role.ARBITER] ?? ""}`)
    .sort()
    .join("|");
  useEffect(() => {
    if (bonds === undefined) { setCover({ status: "loading" }); return; }
    if (bonds === null) { setCover({ status: "unchecked" }); return; }
    let cancelled = false;
    setCover({ status: "loading" });
    void readUnspentExposure(tradesRef.current)
      .then(exposure => {
        if (cancelled) return;
        setCover({
          status: "ready",
          sats: largestOnchainCoverSats({ bonds: seatableOnchainBonds(bonds), allTrades: exposure, excludePubkey: viewerPubkey }),
        });
      })
      .catch(() => { if (!cancelled) setCover({ status: "unchecked" }); });
    return () => { cancelled = true; };
  }, [bonds, exposureKey, viewerPubkey]);
  return cover;
}

/** The chama's bonds for a screen that has no bond snapshot of its own (the
 *  canvas). undefined while loading or not yet asked (community null), null
 *  when the read failed. */
export function useCommunityBonds(
  community: string | null | undefined,
  fetchCommunityBonds?: (community: string, opts?: { allowCachedFallback?: boolean }) => Promise<VerifiedBond[]>,
): VerifiedBond[] | null | undefined {
  const [bonds, setBonds] = useState<VerifiedBond[] | null | undefined>(undefined);
  // The actions object is rebuilt every render; fetch once per chama.
  const fetchRef = useRef(fetchCommunityBonds);
  fetchRef.current = fetchCommunityBonds;
  const canFetch = !!fetchCommunityBonds;
  useEffect(() => {
    const fetch = fetchRef.current;
    if (!fetch) { setBonds(null); return; }
    if (!community) { setBonds(undefined); return; } // not asked yet: show nothing
    let cancelled = false;
    setBonds(undefined);
    fetch(community, { allowCachedFallback: false })
      .then(result => { if (!cancelled) setBonds(result); })
      .catch(() => { if (!cancelled) setBonds(null); });
    return () => { cancelled = true; };
  }, [community, canFetch]);
  return bonds;
}
