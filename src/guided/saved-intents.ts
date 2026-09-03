// ══════════════════════════════════════════════════════════════════════════
// Saved canvas intents — "notify me when a compatible offer appears" (S4.1/S4.2)
// ══════════════════════════════════════════════════════════════════════════
//
// When the guided canvas finds no match, the user can save what they were
// looking for. S4.1 persists it locally (per npub). S4.2 registers a community
// wake-tag with the VPS watcher so the device can be woken to check these while
// closed — the watcher never learns WHAT is wanted, only "someone watches
// community X" (which the relay already sees). Matching stays client-side.

import type { AssistedCanvasAsset } from "./canvas-routing.js";
import { validateGuidedTradeIntent } from "./intent-validation.js";
import { matchGuidedListings } from "./match-listings.js";
import { matchMarketListings } from "./market-match.js";
import { EscrowStatus, Role, type EscrowState } from "../escrow-engine/types.js";

export interface SavedIntent {
  id: string;
  bring: AssistedCanvasAsset;
  want: AssistedCanvasAsset;
  community: string;
  fiatCurrency?: string;
  /** cash→sats budget in fiat. */
  fiatAmount?: number;
  /** sats→goods sats budget. */
  amountSats?: number;
  /** sats→goods description to match against new listings. */
  query?: string;
  paymentRails?: string[];
  /** Unix seconds. */
  createdAt: number;
}

function keyFor(pubkey: string): string { return `chama_saved_intents:${pubkey}`; }

export function listSavedIntents(pubkey: string): SavedIntent[] {
  try {
    const raw = localStorage.getItem(keyFor(pubkey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedIntent[]) : [];
  } catch { return []; }
}

/** Persist an intent (replacing an identical earlier one). Best-effort; a
 *  storage failure never breaks the canvas. Returns the stored record. */
export function saveIntent(intent: Omit<SavedIntent, "id" | "createdAt">, pubkey: string): SavedIntent {
  const record: SavedIntent = {
    ...intent,
    id: `si_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Math.floor(Date.now() / 1000),
  };
  try {
    const all = listSavedIntents(pubkey);
    const dupe = all.findIndex(i =>
      i.bring === record.bring && i.want === record.want &&
      i.fiatAmount === record.fiatAmount && i.query === record.query &&
      i.community === record.community);
    if (dupe >= 0) all[dupe] = record; else all.push(record);
    localStorage.setItem(keyFor(pubkey), JSON.stringify(all.slice(-50)));
  } catch { /* best-effort */ }
  return record;
}

export function removeSavedIntent(id: string, pubkey: string): void {
  try {
    localStorage.setItem(keyFor(pubkey), JSON.stringify(listSavedIntents(pubkey).filter(i => i.id !== id)));
  } catch { /* ignore */ }
}

function listingAuthor(listing: EscrowState): string | null {
  return listing.initiator?.pubkey ?? listing.participants?.[Role.SELLER] ?? null;
}

/** Pure S4.2 compatibility decision. The broad Market canvas remains
 * recall-first while somebody is actively browsing, but an interruptive alert
 * has a higher bar: both the description and price must be plausibly close. */
export function savedIntentMatchesListing(
  intent: SavedIntent,
  listing: EscrowState,
  viewerPubkey: string,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  if (listing.status !== EscrowStatus.CREATED) return false;
  if (listing.parent !== undefined) return false;
  if ((listing.listingExpiresAt ?? listing.expiresAt) <= nowSec) return false;

  if (intent.bring === "sats" && intent.want === "goods") {
    if (listing.category !== "marketplace") return false;
    if (!intent.query?.trim()) return false;
    if (listingAuthor(listing) === viewerPubkey) return false;
    const match = matchMarketListings([listing], {
      query: intent.query,
      budgetSats: intent.amountSats && intent.amountSats > 0
        ? intent.amountSats
        : Number.MAX_SAFE_INTEGER,
      limit: 1,
    })[0];
    if (!match) return false;
    const textFits = match.reasons.includes("close-name") || match.reasons.includes("related-words");
    const priceFits = match.reasons.includes("within-budget") || match.reasons.includes("near-budget");
    return textFits && priceFits;
  }

  if (intent.bring === "cash" && intent.want === "sats") {
    if (listing.category !== "p2p-trade" && listing.category !== "bill-pay") return false;
    const amountSats = Math.floor((listing.amountMsats ?? 0) / 1000);
    if (amountSats <= 0) return false;
    const validated = validateGuidedTradeIntent({
      version: 1,
      direction: "buy_sats",
      amountSats,
      paymentRails: intent.paymentRails ?? [],
      strategy: "available_now",
      ...(intent.community ? { community: intent.community } : {}),
      ...(intent.fiatAmount ? { maxFiatAmount: intent.fiatAmount } : {}),
      ...(intent.fiatCurrency ? { fiatCurrency: intent.fiatCurrency } : {}),
    });
    if (!validated.ok) return false;
    return matchGuidedListings(validated.value, [{ listing }], {
      viewerPubkey,
      limit: 1,
      nowSec,
    }).candidates.length > 0;
  }

  return false;
}
