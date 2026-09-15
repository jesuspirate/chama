import { pickPreferredArbiter } from "../arbiters/pool.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { validateCircleRound } from "./circle.js";
import type { CircleRound } from "./types.js";
import { EscrowEventKind, EscrowStatus, Role, type CreatePayload, type EscrowState } from "../escrow-engine/types.js";

export function shareEscrowId(circleId: string, memberPubkey: string, roundIndex: number): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(["chama-share-v1", circleId, memberPubkey.toLowerCase(), roundIndex]))));
}

export function circleFromEscrow(state: EscrowState): CircleRound | null {
  if (state.category !== "chama" || !state.chamaCircle) return null;
  return { ...state.chamaCircle, version: 1, circleId: state.id,
    creatorPubkey: state.initiator.pubkey, community: state.community ?? "",
    mintUrl: state.mintUrl, name: state.description, createdAt: state.createdAt };
}

/** Shared parser/reducer gate. Cross-chain context must come from a replayed parent. */
export function chamaCreateError(p: CreatePayload, id: string, pubkey: string, at: number, parent?: EscrowState, witness?: EscrowState): string | null {
  if (p.category !== "chama" && p.category !== "chama-share" && p.chamaPolicy === undefined && p.chamaCircle === undefined) return null;
  for (const pool of [p.communityArbiters, p.bondedArbiters]) {
    if (pool !== undefined && (!Array.isArray(pool) || !pool.every(pk => typeof pk === "string" && /^[0-9a-f]{64}$/.test(pk)))) return "Invalid circle arbiter pool";
  }
  if (p.bondedArbiters?.some(pk => !p.communityArbiters?.includes(pk))) return "Bonded arbiters must belong to the circle pool";
  if (p.createdAt !== at || !Number.isSafeInteger(at)) return "CREATE timestamp mismatch";
  if (p.escrowMode !== undefined && p.escrowMode !== "ecash") return "Circles and shares require ecash";
  for (const key of ["tranche", "trancheChild", "sliceCount", "settlementPolicy", "items", "stock", "claimedQuantity", "subscription", "amountRange", "minAmountMsats", "maxAmountMsats"] as const) {
    if ((p as unknown as Record<string, unknown>)[key] !== undefined) return `Chama forbids ${key}`;
  }
  if (p.category === "chama") {
    if (!p.chamaCircle || p.chamaPolicy !== undefined || p.parent !== undefined) return "Invalid circle parent shape";
    const c: CircleRound = { ...p.chamaCircle, version: 1, circleId: id, creatorPubkey: pubkey,
      community: p.community ?? "", mintUrl: p.mintUrl, name: p.description, createdAt: at };
    const errors = validateCircleRound(c);
    if (errors.length) return errors.join("; ");
    if (at + p.expirySeconds !== c.roundEndSec) return "Circle expiry must equal round end";
    return null;
  }
  if (p.category !== "chama-share" || p.chamaPolicy !== "share-v1" || p.chamaCircle !== undefined) return "Invalid share policy/category";
  const circle = parent && circleFromEscrow(parent);
  if (!parent || !circle || validateCircleRound(circle).length || p.parent !== parent.id) return "A validated circle parent is required";
  if (p.amountMsats !== circle.shareMsats) return "Share amount must equal circle share amount";
  if (at < circle.createdAt || at >= circle.fillDeadlineSec || at + p.expirySeconds !== circle.roundEndSec) return "Share must use the circle's fixed deadlines";
  if (id !== shareEscrowId(parent.id, pubkey, circle.roundIndex)) return "Share id must be deterministic";
  if (!/^[0-9a-f]{64}$/.test(pubkey) || typeof p.sellerPubkey !== "string" || !/^[0-9a-f]{64}$/.test(p.sellerPubkey) || pubkey === p.sellerPubkey) return "Share must seat distinct member and witness";
  if (p.sellerPubkey !== circle.creatorPubkey) {
    // v1.1 ring share (host-seat spec, task 1: readers first, writers later).
    // A non-creator witness is legal only when they are a MEMBER whose own
    // share in this circle locked before this share was created — proven by
    // the witness escrow at its deterministic id. This keeps the invariant
    // the old member≠creator law protected: nobody holds two SSS keys to any
    // escrow, and every witness is themselves locked into the same round.
    if (!witness) return "Ring witness share is required";
    if (witness.id !== shareEscrowId(parent.id, p.sellerPubkey, circle.roundIndex)) return "Ring witness share id mismatch";
    if (witness.chamaPolicy !== "share-v1" || witness.parent !== parent.id) return "Ring witness must hold a share in this circle";
    if (witness.participants[Role.BUYER] !== p.sellerPubkey) return "Ring witness must own their share";
    const witnessLock = witness.eventChain.find(e => e.kind === EscrowEventKind.LOCK);
    if (!witnessLock || witnessLock.timestamp > at) return "Ring witness must lock before witnessing";
  }
  if (p.mintUrl !== parent.mintUrl || (p.community ?? null) !== parent.community || p.fed !== (parent.eventChain[0].payload as CreatePayload).fed || p.fedPrefix !== (parent.eventChain[0].payload as CreatePayload).fedPrefix) return "Share federation/community must match parent";
  if (JSON.stringify(p.communityArbiters ?? []) !== JSON.stringify(parent.communityArbiters) || JSON.stringify(p.bondedArbiters ?? []) !== JSON.stringify(parent.bondedArbiters ?? [])) return "Share arbiter pool must match parent";
  if (!pickPreferredArbiter(p.communityArbiters ?? [], p.bondedArbiters ?? [], id, [pubkey, p.sellerPubkey!])) return "Share requires a distinct pool arbiter";
  if (p.platformFeeBps !== 0 || (p.arbiterFeeMsats ?? 0) !== 0) return "Shares return the full amount without fees";
  return null;
}

/** Pre-spend gate shared by the native/browser bridge and regression tests. */
export function chamaFundingError(state: EscrowState, pubkey: string, nowSec: number): string | null {
  if (state.category === "chama") return "Circle parents cannot hold funds";
  if (!state.chamaPolicy) return null;
  if (state.status !== EscrowStatus.CREATED || !state.chamaCircle || nowSec >= state.chamaCircle.fillDeadlineSec) return "Share funding window is closed";
  if (pubkey !== state.participants[Role.BUYER]) return "Only the member can fund their share";
  return null;
}

export function shareCreatePayload(parent: EscrowState, nowSec: number): CreatePayload {
  const circle = circleFromEscrow(parent);
  if (!circle || validateCircleRound(circle).length) throw new Error("A validated circle parent is required");
  const original = parent.eventChain[0].payload as CreatePayload;
  return { type: "escrow:create", description: circle.name, category: "chama-share", chamaPolicy: "share-v1",
    parent: parent.id, sellerPubkey: circle.creatorPubkey, amountMsats: circle.shareMsats,
    mintUrl: parent.mintUrl, community: parent.community ?? undefined, fed: original.fed, fedPrefix: original.fedPrefix,
    platformFeeBps: 0, platformFeePubkey: original.platformFeePubkey, arbiterFeeMsats: 0,
    communityArbiters: [...parent.communityArbiters], bondedArbiters: [...(parent.bondedArbiters ?? [])],
    expirySeconds: circle.roundEndSec - nowSec, createdAt: nowSec };
}
