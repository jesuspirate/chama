// ══════════════════════════════════════════════════════════════════════════
// Chama — commitment-bond ANNOUNCEMENT (Nostr kind 38135, chain-verifiable)
// ══════════════════════════════════════════════════════════════════════════
//
// An arbiter posts a single-key timelock COMMITMENT bond (commitment-bond.ts) —
// their own sats, CLTV-locked to their own key. This event makes that bond
// PUBLIC + VERIFIABLE, so a community's "liveness" (# bonded arbiters × ratings ×
// how much × how long) can be computed by any client and PROVEN against the chain
// — never trusted. It's the data source for the live-chama signal
// (chama-live-chama-signal-brief.md) and pairs with the private-community-fed work.
//
// ⭐ RECOMPUTE-DON'T-TRUST. The event is ADVISORY. `verifyBondAnnouncement` REBUILDS
// the bond address locally from (ownerXonly, lockUntil, network) — never the wire's
// `address` — and checks the recomputed address on-chain for a real, funded UTXO.
// The arbiter's Nostr signature vouches for the bond (the signer IS the arbiter);
// Bitcoin consensus proves it's actually posted. A lie in `address`/`amountSats`
// can't survive the recompute + the on-chain read.
//
// KIND ALLOCATION — 38135 sits above the retired 2-of-3 band (38132–34, see
// arbiters/bonds.ts) and clear of 38130 (the legacy UNBACKED exposure-ledger
// declaration) / 38131 (victim attestation). This is the CHAIN-BACKED companion:
// where 38130 was a claim, 38135 is provable. Parameterized-replaceable, keyed
// d=community: one CURRENT announcement per (arbiter, community), and a filter on
// `#d:[community]` returns every arbiter's bond for that community (the liveness
// query). The signer IS the announcing arbiter — no announcing on another's behalf.

import { hexToBytes } from "@noble/hashes/utils.js";
import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";
import { buildCommitmentBond } from "./commitment-bond.js";
import { findBondFundingUtxos, defaultMinConfs, type EsploraFetch } from "./fund-watcher.js";
import { SIGNET, type BtcNetwork } from "./multisig.js";
import type { NostrEvent } from "../escrow-engine/types.js";

export const ARBITER_BOND_ANNOUNCEMENT_KIND = 38135;
export const ARBITER_BOND_ANNOUNCEMENT_TYPE = "chama:commitment-bond";

const HEX64 = /^[0-9a-f]{64}$/;
type NetworkLabel = "signet" | "mainnet";
const networkLabel = (n: BtcNetwork): NetworkLabel => (n === SIGNET ? "signet" : "mainnet");

function normHex(value: string | null | undefined): string | null {
  const t = value?.trim().toLowerCase();
  return t && HEX64.test(t) ? t : null;
}

// ── A0 schema pass (2026-07-28) — roles + lineage ──────────────────────────
// Both fields are OPTIONAL and ADVISORY, under the same recompute-don't-trust
// doctrine as `address`. An announcement made before this pass must parse,
// verify, seat, and cache byte-identically. See
// design/mockups/chama-38135-schema-pass-brief.md.

/** What the bond licenses. `arbiter` = assignable in the dispute pool (the
 *  historical, and still default, meaning). `merchant` = a storefront license
 *  only: it renews listings but never seats its holder as a judge. A bond may
 *  declare both. */
export type BondRole = "arbiter" | "merchant";

export const BOND_ROLES: readonly BondRole[] = ["arbiter", "merchant"];

/** Absent `roles` ⇒ this. Every bond already announced in the wild is an arbiter
 *  bond, so the default must reproduce that exactly. There is deliberately NO
 *  path from an absent/malformed field to `merchant`: opting OUT of the arbiter
 *  pool has to be an explicit, signed statement, never a parsing accident. */
export const DEFAULT_BOND_ROLES: readonly BondRole[] = ["arbiter"];

/** One hop back along a renewal chain. A renewal spends the previous bond's
 *  output into a fresh CLTV bond under a NEWLY DERIVED key, so walking back
 *  needs the previous bond's own key + term to recompute its address, plus the
 *  txid of the funding output this hop's successor consumed. Nothing here is
 *  trusted: `verifyBondLineage` recomputes every address and reads every spend
 *  on-chain. */
export interface BondLineageHop {
  /** 64-hex x-only key of the bond at THIS hop (distinct from every other). */
  fromXonly: string;
  /** THIS hop's CLTV unlock height. */
  fromLockUntil: number;
  /** 64-hex txid of THIS hop's funding transaction. */
  fromTxid: string;
}

/** ⚠ The full renewal ancestry, carried by the CURRENT announcement.
 *
 *  It has to be the full chain, not a single pointer. Kind 38135 is
 *  parameterized-replaceable per (npub, community), so announcing a renewal
 *  REPLACES the predecessor's announcement — after two renewals the middle
 *  bond's event is simply gone from relays, and a one-hop pointer would dead-end
 *  there. Since the announcer's own commitment store knows their whole history,
 *  they publish every hop, and each one is INDEPENDENTLY verifiable on-chain by
 *  anyone: recompute the hop's address, confirm its funding output was spent by
 *  the very transaction that funded the next bond along. A fabricated hop fails
 *  the recompute or fails the spend check. */
export interface BondLineage {
  /** Newest-first. `hops[0]` is the bond this one directly renewed. */
  hops: BondLineageHop[];
  /** Oldest claimed funding txid. Display-only; the walk is authoritative. */
  rootTxid?: string;
}

/** Payload bound on the announced ancestry. ~2 years of monthly renewals, and it
 *  caps a verifier's on-chain reads at 2 per hop. A chain longer than this
 *  announces its most recent MAX hops; tenure then under-reports rather than
 *  costing every reader an unbounded walk. */
export const MAX_LINEAGE_HOPS = 24;

/** Normalize a claimed role list. Unknown entries are dropped; an empty or
 *  unusable result falls back to the default rather than unseating an arbiter. */
function normRoles(value: unknown): BondRole[] {
  if (!Array.isArray(value)) return [...DEFAULT_BOND_ROLES];
  const seen = new Set<BondRole>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const role = entry.trim().toLowerCase() as BondRole;
    if (BOND_ROLES.includes(role)) seen.add(role);
  }
  return seen.size > 0 ? [...seen] : [...DEFAULT_BOND_ROLES];
}

function normLineageHop(value: unknown): BondLineageHop | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const fromXonly = normHex(typeof raw.fromXonly === "string" ? raw.fromXonly : null);
  const fromTxid = normHex(typeof raw.fromTxid === "string" ? raw.fromTxid : null);
  if (!fromXonly || !fromTxid) return null;
  if (!Number.isInteger(raw.fromLockUntil) || (raw.fromLockUntil as number) <= 0) return null;
  return { fromXonly, fromLockUntil: raw.fromLockUntil as number, fromTxid };
}

/** Structurally validate a claimed lineage. A bad claim yields `undefined` — the
 *  FIELD is dropped, never the announcement: a malformed tenure claim must not
 *  invalidate a real, funded, chain-verifiable bond.
 *
 *  TRUNCATE, never partially accept: hops are ordered, and the walk stops at the
 *  first one it cannot prove anyway. So a malformed hop ends the usable chain
 *  there rather than letting later hops silently skip a gap — a gap is exactly
 *  what an inflated tenure claim would look like. */
function normLineage(value: unknown): BondLineage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.hops)) return undefined;
  const hops: BondLineageHop[] = [];
  const seenTxids = new Set<string>();
  for (const entry of raw.hops.slice(0, MAX_LINEAGE_HOPS)) {
    const hop = normLineageHop(entry);
    if (!hop) break;
    if (seenTxids.has(hop.fromTxid)) break; // a repeated txid is a loop, not history
    seenTxids.add(hop.fromTxid);
    hops.push(hop);
  }
  if (hops.length === 0) return undefined;
  const rootTxid = normHex(typeof raw.rootTxid === "string" ? raw.rootTxid : null);
  return { hops, ...(rootTxid ? { rootTxid } : {}) };
}

/** The advisory announcement payload (JSON in the event content). NEVER trusted for
 *  the funding truth — every field is re-derived/re-checked in verifyBondAnnouncement. */
export interface BondAnnouncementPayload {
  type: typeof ARBITER_BOND_ANNOUNCEMENT_TYPE;
  /** The announcing arbiter's hex pubkey (== the signing event's pubkey). */
  npub: string;
  /** Community/chama this bond backs the arbiter's service for. */
  community: string;
  /** 64-hex x-only BOND key (BIP86-derived, distinct from the Nostr key) — the
   *  input to the local address recompute. */
  ownerXonly: string;
  /** Absolute block height the bond unlocks at (CLTV term-end). */
  lockUntil: number;
  /** Claimed committed sats (decimal string; the CHAIN is authoritative). */
  amountSats: string;
  network: NetworkLabel;
  /** Advisory recomputable address (cross-checked, never trusted). */
  address: string;
  /** What this bond licenses. Absent ⇒ ["arbiter"] (every pre-A0 bond). */
  roles?: BondRole[];
  /** One hop back along the renewal chain, for the tenure walk. Absent on a
   *  first bond, and on every bond announced before A0. */
  lineage?: BondLineage;
}

/** A parsed, signature-verified announcement (NOT yet chain-verified). */
export interface ParsedBondAnnouncement {
  npub: string;
  community: string;
  ownerXonly: string;
  lockUntil: number;
  claimedSats: bigint;
  network: NetworkLabel;
  address: string;
  createdAt: number;
  eventId: string;
  /** Always populated (defaulted, never empty) so callers need no null-check. */
  roles: BondRole[];
  /** Present only when the announcement carried a well-formed lineage claim. */
  lineage?: BondLineage;
}

/** Build the UNSIGNED announcement event (the arbiter's own client signs + publishes).
 *  `pubkey` must be the signer's hex key. */
export function buildBondAnnouncementEvent(params: {
  pubkey: string;
  community: string;
  ownerXonly: Uint8Array | string;
  lockUntil: number;
  amountSats: bigint;
  network: BtcNetwork;
  address: string;
  createdAt?: number;
  /** Omit for an arbiter bond (the default). Pass ["merchant"] for a
   *  storefront-only license, or both to do each. */
  roles?: readonly BondRole[];
  /** Pass when this bond was created by renewing a previous one. */
  lineage?: BondLineage;
}): { kind: number; created_at: number; tags: string[][]; content: string } {
  const pubkey = normHex(params.pubkey);
  if (!pubkey) throw new Error(`Announcement pubkey is not a 64-char hex key: ${params.pubkey}`);
  const community = params.community.trim();
  if (!community) throw new Error("Announcement needs a community");
  const ownerXonlyHex = typeof params.ownerXonly === "string"
    ? params.ownerXonly.trim().toLowerCase()
    : [...params.ownerXonly].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (!HEX64.test(ownerXonlyHex)) throw new Error("ownerXonly must be a 32-byte x-only key");
  if (!Number.isInteger(params.lockUntil) || params.lockUntil <= 0) throw new Error("lockUntil must be a positive block height");
  if (params.amountSats <= 0n) throw new Error("amountSats must be positive");
  // Emit `roles` only when it says something other than the default, so an
  // ordinary arbiter bond stays byte-identical to a pre-A0 announcement.
  const roles = params.roles ? normRoles([...params.roles]) : [...DEFAULT_BOND_ROLES];
  const isDefaultRoles = roles.length === 1 && roles[0] === DEFAULT_BOND_ROLES[0];
  const lineage = params.lineage ? normLineage(params.lineage) : undefined;
  if (params.lineage && !lineage) throw new Error("lineage is malformed — refusing to announce an unverifiable renewal claim");
  const payload: BondAnnouncementPayload = {
    type: ARBITER_BOND_ANNOUNCEMENT_TYPE,
    npub: pubkey,
    community,
    ownerXonly: ownerXonlyHex,
    lockUntil: params.lockUntil,
    amountSats: params.amountSats.toString(),
    network: networkLabel(params.network),
    address: params.address,
    ...(isDefaultRoles ? {} : { roles }),
    ...(lineage ? { lineage } : {}),
  };
  return {
    kind: ARBITER_BOND_ANNOUNCEMENT_KIND,
    created_at: params.createdAt ?? Math.floor(Date.now() / 1000),
    tags: [
      ["d", community], // one current announcement per (arbiter, community); #d = liveness query
      ["t", ARBITER_BOND_ANNOUNCEMENT_TYPE],
      ["c", community],
    ],
    content: JSON.stringify(payload),
  };
}

/** Parse + structurally validate + signature-verify one announcement. The signer is
 *  authoritative: a payload `npub` that disagrees is rejected (no spoofing another
 *  arbiter's bond). Does NOT chain-verify — hand the result to verifyBondAnnouncement. */
export function parseBondAnnouncementEvent(
  event: NostrEvent,
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ParsedBondAnnouncement | null {
  if (event.kind !== ARBITER_BOND_ANNOUNCEMENT_KIND) return null;
  let p: BondAnnouncementPayload;
  try { p = JSON.parse(event.content); } catch { return null; }
  if (p?.type !== ARBITER_BOND_ANNOUNCEMENT_TYPE) return null;
  const signer = normHex(event.pubkey);
  if (!signer) return null;
  if (p.npub && normHex(p.npub) !== signer) return null; // signer-authoritative
  const ownerXonly = normHex(p.ownerXonly);
  if (!ownerXonly) return null;
  if (typeof p.community !== "string" || !p.community.trim()) return null;
  if (!Number.isInteger(p.lockUntil) || p.lockUntil <= 0) return null;
  if (typeof p.amountSats !== "string" || !/^\d+$/.test(p.amountSats)) return null;
  if (p.network !== "signet" && p.network !== "mainnet") return null;
  if (typeof p.address !== "string" || !p.address) return null;
  const verify = options?.verifyEvent ?? (verifyNostrEventSignature as unknown as (e: NostrEvent) => boolean);
  if (!verify(event)) return null;
  return {
    npub: signer,
    community: p.community.trim(),
    ownerXonly,
    lockUntil: p.lockUntil,
    claimedSats: BigInt(p.amountSats),
    network: p.network,
    address: p.address,
    createdAt: event.created_at,
    eventId: event.id,
    roles: normRoles(p.roles),
    ...(normLineage(p.lineage) ? { lineage: normLineage(p.lineage) } : {}),
  };
}

export interface VerifiedBond {
  npub: string;
  community: string;
  /** The LOCALLY-recomputed address (never the wire's). */
  address: string;
  lockUntil: number;
  /** ACTUAL confirmed sats at the address (chain truth, not the claim). */
  actualSats: bigint;
  claimedSats: bigint;
  /** True ⇒ the recomputed address holds a real confirmed deposit. */
  funded: boolean;
  /** True ⇒ still locked (tip < lockUntil) — an active commitment. */
  active: boolean;
  /** Block the EARLIEST deposit confirmed in — the start of this bond's tenure.
   *  Undefined when Esplora didn't report a height (never inferred). */
  fundedAtHeight?: number;
  /** Funding outpoint txid, so a human can check the claim in a block explorer
   *  instead of taking the app's word for it. */
  fundingTxid?: string;
  /** What the announcer declared this bond licenses. Populated by
   *  `verifyBondAnnouncement`; OPTIONAL because a bond can also arrive from a
   *  cache entry written before A0. Read it through `declaresArbiterRole`,
   *  which treats absent as the arbiter default — never as a merchant opt-out. */
  roles?: BondRole[];
  /** The announcer's renewal claim, structurally valid but NOT yet walked.
   *  A1 turns this into proven tenure; until then it is a claim. */
  lineage?: BondLineage;
  /** A1: the block tenure actually starts at, after walking the lineage on-chain
   *  — the oldest PROVEN ancestor's funding height, else this bond's own. Absent
   *  when the walk has not been run. Read it through `bondTenureBlocks`, which
   *  falls back to `fundedAtHeight` so an unwalked bond still reports honestly
   *  (just shorter). */
  tenureFromHeight?: number;
  /** A1: how much of the announced ancestry the chain actually backed, so the
   *  UI can say "3 of 5 renewals verified" instead of silently showing 3. */
  lineageProven?: { provenHops: number; claimedHops: number };
  /** ⭐ Tier 2.1: the arbiter's BOND key, x-only hex.
   *
   *  Carried onto the verified bond so an on-chain escrow can name an arbiter
   *  who never JOINed. An auto-seated arbiter publishes no JOIN, so without this
   *  their escrow key would never exist and the address could never be computed
   *  — the trade would sit at "waiting for the arbiter" forever.
   *
   *  ⚠ Key reuse across contexts, stated rather than hidden: this key also
   *  signs the bond's own CLTV reclaim. The scripts and sighashes differ, so
   *  there is no nonce-reuse hazard, but it does link an arbiter's escrow
   *  participation to their public bond. Acceptable because a bond IS public and
   *  a seated arbiter is already named on the trade. The clean fix is a
   *  dedicated escrow key in a future 38135 field; this is the version that
   *  works with bonds already announced. */
  ownerXonly?: string;
  /** A1: when the announcement was signed (event `created_at`). NOT tenure —
   *  tenure is chain-proven and this is merely when they said so. It exists for
   *  cohort context: which bonds were announced in the same week. */
  announcedAt?: number;
}

/** ⭐ Chain-verify a parsed announcement: REBUILD the address from (ownerXonly,
 *  lockUntil, network) and read the recomputed address on-chain. Returns the funded
 *  status + the ACTUAL sats + whether it's still active (tip < lockUntil). Rejects
 *  (null) on a network-domain mismatch or an un-decodable key — an announcement whose
 *  claimed `address` doesn't reproduce is simply reported with the recomputed one. */
export async function verifyBondAnnouncement(
  parsed: ParsedBondAnnouncement,
  ctx: { network: BtcNetwork; fetchJson: EsploraFetch; tipHeight?: number },
): Promise<VerifiedBond | null> {
  if (parsed.network !== networkLabel(ctx.network)) return null; // don't cross networks
  let ownerXonly: Uint8Array;
  try { ownerXonly = hexToBytes(parsed.ownerXonly); } catch { return null; }
  const recomputed = buildCommitmentBond(ownerXonly, parsed.lockUntil, ctx.network).address;
  const utxos = await findBondFundingUtxos({
    address: recomputed,
    fetchJson: ctx.fetchJson,
    minConfs: defaultMinConfs(ctx.network),
  });
  const actualSats = utxos.reduce((s, u) => s + u.utxo.amountSats, 0n);
  const tip = ctx.tipHeight;
  // Tenure starts at the EARLIEST confirmed deposit: topping a bond up later
  // must never look like starting over, and must never look older either.
  const heights = utxos
    .map((u) => u.blockHeight)
    .filter((h): h is number => typeof h === "number");
  const fundedAtHeight = heights.length > 0 ? Math.min(...heights) : undefined;
  const earliest = utxos.find((u) => u.blockHeight === fundedAtHeight) ?? utxos[0];
  return {
    npub: parsed.npub,
    community: parsed.community,
    address: recomputed,
    lockUntil: parsed.lockUntil,
    actualSats,
    claimedSats: parsed.claimedSats,
    funded: actualSats > 0n,
    active: typeof tip === "number" ? tip < parsed.lockUntil : true,
    fundedAtHeight,
    fundingTxid: earliest?.utxo.txid,
    roles: parsed.roles,
    ownerXonly: parsed.ownerXonly,
    ...(parsed.lineage ? { lineage: parsed.lineage } : {}),
    announcedAt: parsed.createdAt,
  };
}

/** Newest current announcement per arbiter (parameterized-replaceable: newest
 *  created_at wins, ties → lexicographically smallest event id). Dedups a set of raw
 *  events (e.g. from a community `#d` query) to one per npub. */
export function selectLatestAnnouncements(
  events: readonly NostrEvent[],
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): ParsedBondAnnouncement[] {
  const best = new Map<string, ParsedBondAnnouncement>();
  for (const event of events) {
    const a = parseBondAnnouncementEvent(event, options);
    if (!a) continue;
    const cur = best.get(a.npub);
    if (!cur || a.createdAt > cur.createdAt || (a.createdAt === cur.createdAt && a.eventId < cur.eventId)) {
      best.set(a.npub, a);
    }
  }
  return [...best.values()];
}

/** Newest current announcement per (arbiter, community) from a BATCHED no-`#d`
 *  query — the country-LIST read. selectLatestAnnouncements keys per npub, which
 *  is right for a single community's `#d` result but would collapse an arbiter
 *  bonded in TWO chamas down to one; this variant keys (npub, community) and
 *  groups the winners by community, ready for per-community chain verification. */
export function groupLatestAnnouncementsByCommunity(
  events: readonly NostrEvent[],
  options?: { verifyEvent?: (event: NostrEvent) => boolean },
): Map<string, ParsedBondAnnouncement[]> {
  const best = new Map<string, ParsedBondAnnouncement>(); // key: `${npub}|${community}`
  for (const event of events) {
    const a = parseBondAnnouncementEvent(event, options);
    if (!a) continue;
    const key = `${a.npub}|${a.community}`;
    const cur = best.get(key);
    if (!cur || a.createdAt > cur.createdAt || (a.createdAt === cur.createdAt && a.eventId < cur.eventId)) {
      best.set(key, a);
    }
  }
  const byCommunity = new Map<string, ParsedBondAnnouncement[]>();
  for (const a of best.values()) {
    const list = byCommunity.get(a.community);
    if (list) list.push(a);
    else byCommunity.set(a.community, [a]);
  }
  return byCommunity;
}
