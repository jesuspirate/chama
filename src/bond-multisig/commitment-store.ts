// ══════════════════════════════════════════════════════════════════════════
// Chama — commitment bond store (localStorage)
// ══════════════════════════════════════════════════════════════════════════
//
// Persists the arbiter's single-key timelock commitment bonds (commitment-bond.ts)
// so "post your bond → fund → reclaim after T" survives a reload. Like the multisig
// store, this is a convenience cache, NOT the source of truth (the chain is), so it
// is adversarial-on-read:
//
//   ⭐ RECOMPUTE-DON'T-TRUST ON LOAD. deserialize REBUILDS the address from the
//   stored (ownerXonly, lockUntil, network) and REJECTS a record whose stored
//   address doesn't reproduce — catching an address-only edit. (For the commitment
//   bond the key is the arbiter's OWN BIP86 bond key, so there is no cabinet/attestation
//   trust to re-check — recompute is the whole gate.)
//
// Modeled on custody-store.ts (scoped + versioned key + backup, bigint↔string,
// bytes↔hex, never overwrite good data with nothing, phase-monotonic upsert).

import { hexToBytes, bytesToHex } from "@noble/hashes/utils.js";
import {
  buildCommitmentBond,
  deriveBondSigningKey,
  validateBitcoinAddressForNetwork,
  type CommitmentBond,
  type CommitmentReclaimDestination,
  type ReclaimDestinationKind,
} from "./commitment-bond.js";
import { SIGNET, type BtcNetwork, type BondUtxo } from "./multisig.js";
import * as btc from "@scure/btc-signer";
import {
  getScopedStorageItem,
  setScopedStorageItem,
  getLocalStorageUserScope,
} from "../storage/user-scope.js";
import { randomId } from "../storage/random-id.js";

/** Opaque local bond id (moved here from the retired 2-of-3 transport module). */
export function newBondId(): string {
  return `bond_${randomId(16)}`;
}

export const COMMITMENT_STORAGE_KEY = "chama_commitment_bonds_v1";
export const COMMITMENT_BACKUP_STORAGE_KEY = "chama_commitment_bonds_backup_v1";
export const COMMITMENT_MAX_ENTRIES = 200;

export type CommitmentPhase = "created" | "locked" | "reclaimed";
const PHASE_RANK: Record<CommitmentPhase, number> = { created: 0, locked: 1, reclaimed: 2 };

/** The full local record for one commitment bond. `bond` is the recomputable
 *  descriptor; the rest is lifecycle. The owner PRIVATE key is never stored — it's
 *  re-derived from the seed at reclaim time. */
export interface CommitmentRecord {
  bondId: string;
  bond: CommitmentBond;
  amountSats: bigint;
  phase: CommitmentPhase;
  /** BIP86 address index this bond's key was derived at (m/86'/coin'/0'/0/index) —
   *  persisted so reclaim re-derives the RIGHT private key. Each bond gets its own,
   *  so no two bonds ever share an address. Absent ⇒ 0 (legacy single-key bonds). */
  keyIndex?: number;
  /** All UTXOs at the address once funded (phase >= locked) — the reclaim sweeps them. */
  utxos?: BondUtxo[];
  /** Set once reclaimed. */
  reclaimTxid?: string;
  /** The user's selected reclaim destination and the actual transaction output. */
  reclaimDestination?: CommitmentReclaimDestination;
  /** Set when the reclaimed return output is sent into Chama/Fedimint. */
  creditTxid?: string;
  creditOperationId?: string;
  /** Set once the Fedimint on-chain deposit (peg-in) has confirmed and the ecash
   *  landed in the spendable Chama balance — the "credit landed" signal the UI shows. */
  creditConfirmedAt?: number;
  /** v5.4 direct rollover journal. The replacement record remains `created`
   * until its output reaches the normal bond confirmation policy. */
  renewedFromBondId?: string;
  renewalToBondId?: string;
  renewalTxid?: string;
  renewalRawTx?: string;
  renewalFeeSats?: bigint;
  renewalBroadcastAt?: number;
  createdAt: number;
}

interface SerializedCommitment {
  bondId: string;
  ownerXonly: string;   // hex
  lockUntil: number;
  network: "signet" | "mainnet";
  address: string;      // recomputed + checked on load
  amountSats: string;   // decimal
  phase: CommitmentPhase;
  keyIndex?: number;    // BIP86 address index (default 0 for legacy records)
  utxos?: { txid: string; index: number; amountSats: string }[];
  reclaimTxid?: string;
  reclaimDestination?: {
    requested: ReclaimDestinationKind;
    actual: ReclaimDestinationKind;
    address: string;
    fallbackReason?: string;
  };
  creditTxid?: string;
  creditOperationId?: string;
  creditConfirmedAt?: number;
  renewedFromBondId?: string;
  renewalToBondId?: string;
  renewalTxid?: string;
  renewalRawTx?: string;
  renewalFeeSats?: string;
  renewalBroadcastAt?: number;
  createdAt: number;
  updatedAt: number;
}

type StoreMap = Record<string, SerializedCommitment>;

const netLabel = (n: BtcNetwork): "signet" | "mainnet" => (n === SIGNET ? "signet" : "mainnet");
const netFromLabel = (l: string): BtcNetwork => (l === "signet" ? SIGNET : (btc.NETWORK as BtcNetwork));

export function serializeCommitment(rec: CommitmentRecord): SerializedCommitment {
  return {
    bondId: rec.bondId,
    ownerXonly: bytesToHex(rec.bond.ownerXonly),
    lockUntil: rec.bond.lockUntil,
    network: netLabel(rec.bond.network),
    address: rec.bond.address,
    amountSats: rec.amountSats.toString(),
    phase: rec.phase,
    ...(typeof rec.keyIndex === "number" ? { keyIndex: rec.keyIndex } : {}),
    ...(rec.utxos && rec.utxos.length ? { utxos: rec.utxos.map((u) => ({ txid: u.txid, index: u.index, amountSats: u.amountSats.toString() })) } : {}),
    ...(rec.reclaimTxid ? { reclaimTxid: rec.reclaimTxid } : {}),
    ...(rec.reclaimDestination ? { reclaimDestination: rec.reclaimDestination } : {}),
    ...(rec.creditTxid ? { creditTxid: rec.creditTxid } : {}),
    ...(rec.creditConfirmedAt ? { creditConfirmedAt: rec.creditConfirmedAt } : {}),
    ...(rec.creditOperationId ? { creditOperationId: rec.creditOperationId } : {}),
    ...(rec.renewedFromBondId ? { renewedFromBondId: rec.renewedFromBondId } : {}),
    ...(rec.renewalToBondId ? { renewalToBondId: rec.renewalToBondId } : {}),
    ...(rec.renewalTxid ? { renewalTxid: rec.renewalTxid } : {}),
    ...(rec.renewalRawTx ? { renewalRawTx: rec.renewalRawTx } : {}),
    ...(rec.renewalFeeSats !== undefined ? { renewalFeeSats: rec.renewalFeeSats.toString() } : {}),
    ...(rec.renewalBroadcastAt ? { renewalBroadcastAt: rec.renewalBroadcastAt } : {}),
    createdAt: rec.createdAt,
    updatedAt: Date.now(),
  };
}

/** Rebuild + tamper-gate: the stored address MUST reproduce from (ownerXonly,
 *  lockUntil, network), else the record is rejected (null). */
export function deserializeCommitment(s: SerializedCommitment): CommitmentRecord | null {
  try {
    if (!/^\d+$/.test(s.amountSats)) return null;
    if (s.renewalFeeSats !== undefined && !/^\d+$/.test(s.renewalFeeSats)) return null;
    const ownerXonly = hexToBytes(s.ownerXonly);
    if (ownerXonly.length !== 32) return null;
    const network = netFromLabel(s.network);
    // ⭐ Recompute-don't-trust: rebuild address + script from the parts; the stored
    // address MUST reproduce, else reject (catches an address-only tamper).
    const bond = buildCommitmentBond(ownerXonly, s.lockUntil, network);
    if (bond.address !== s.address) return null;
    let reclaimDestination: CommitmentReclaimDestination | undefined;
    if (s.reclaimDestination) {
      const { requested, actual, address, fallbackReason } = s.reclaimDestination;
      const validKinds: ReclaimDestinationKind[] = ["chama", "external", "bond-key"];
      if (!validKinds.includes(requested) || !validKinds.includes(actual)) return null;
      const validAddress = validateBitcoinAddressForNetwork(address, network);
      if (!validAddress.ok) return null;
      reclaimDestination = {
        requested,
        actual,
        address: validAddress.address,
        ...(typeof fallbackReason === "string" && fallbackReason ? { fallbackReason } : {}),
      };
    }
    let utxos: BondUtxo[] | undefined;
    if (s.utxos && s.utxos.length) {
      for (const u of s.utxos) if (!/^\d+$/.test(u.amountSats)) return null;
      utxos = s.utxos.map((u) => ({ txid: u.txid, index: u.index, amountSats: BigInt(u.amountSats) }));
    }
    return {
      bondId: s.bondId,
      bond,
      amountSats: BigInt(s.amountSats),
      phase: s.phase,
      keyIndex: typeof s.keyIndex === "number" ? s.keyIndex : 0, // legacy ⇒ 0
      ...(utxos ? { utxos } : {}),
      ...(s.reclaimTxid ? { reclaimTxid: s.reclaimTxid } : {}),
      ...(reclaimDestination ? { reclaimDestination } : {}),
      ...(s.creditTxid ? { creditTxid: s.creditTxid } : {}),
      ...(s.creditOperationId ? { creditOperationId: s.creditOperationId } : {}),
      ...(s.creditConfirmedAt ? { creditConfirmedAt: s.creditConfirmedAt } : {}),
      ...(s.renewedFromBondId ? { renewedFromBondId: s.renewedFromBondId } : {}),
      ...(s.renewalToBondId ? { renewalToBondId: s.renewalToBondId } : {}),
      ...(s.renewalTxid ? { renewalTxid: s.renewalTxid } : {}),
      ...(s.renewalRawTx ? { renewalRawTx: s.renewalRawTx } : {}),
      ...(s.renewalFeeSats !== undefined ? { renewalFeeSats: BigInt(s.renewalFeeSats) } : {}),
      ...(s.renewalBroadcastAt ? { renewalBroadcastAt: s.renewalBroadcastAt } : {}),
      createdAt: s.createdAt,
    };
  } catch {
    return null;
  }
}

// ── storage plumbing (mirrors custody-store) ─────────────────────────────────
function readStored(key: string): StoreMap {
  try {
    const raw = getScopedStorageItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as StoreMap) : {};
  } catch {
    return {};
  }
}
function readRaw(): StoreMap {
  const primary = readStored(COMMITMENT_STORAGE_KEY);
  if (Object.keys(primary).length > 0) return primary;
  const backup = readStored(COMMITMENT_BACKUP_STORAGE_KEY);
  if (Object.keys(backup).length > 0) { writeRaw(backup, { allowEmptyOverwrite: true }); return backup; }
  return {};
}
function evictOldest(map: StoreMap, max: number): StoreMap {
  const ids = Object.keys(map);
  if (ids.length <= max) return map;
  const sorted = ids.sort((a, b) => (map[b].updatedAt ?? 0) - (map[a].updatedAt ?? 0));
  const out: StoreMap = {};
  for (const id of sorted.slice(0, max)) out[id] = map[id];
  return out;
}
function writeRaw(map: StoreMap, opts: { allowEmptyOverwrite?: boolean } = {}): void {
  if (getLocalStorageUserScope() === null) {
    console.warn("[chama] Refusing to persist commitment bonds without a user scope");
    return;
  }
  try {
    if (Object.keys(map).length === 0 && !opts.allowEmptyOverwrite) {
      if (Object.keys(readStored(COMMITMENT_STORAGE_KEY)).length > 0 || Object.keys(readStored(COMMITMENT_BACKUP_STORAGE_KEY)).length > 0) {
        console.warn("[chama] Refusing to overwrite commitment bonds with an empty map");
        return;
      }
    }
    const serialized = JSON.stringify(evictOldest(map, COMMITMENT_MAX_ENTRIES));
    setScopedStorageItem(COMMITMENT_STORAGE_KEY, serialized);
    setScopedStorageItem(COMMITMENT_BACKUP_STORAGE_KEY, serialized);
  } catch { /* quota / unavailable */ }
}

// ── public API ───────────────────────────────────────────────────────────────
export function listCommitmentBonds(): CommitmentRecord[] {
  // Mainnet-only display: drop any stale cross-network record — e.g. a pre-v5.0
  // signet/Mutinynet test bond persisted on a dev device. A mainnet Taproot bond
  // address is bc1p…, a signet/testnet one is tb1p…, so this hides foreign-chain
  // leftovers (without deleting them) so the Dashboard + ceremony only ever show
  // live mainnet bonds. deserialize is left network-agnostic (tests round-trip signet).
  return Object.values(readRaw())
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .map(deserializeCommitment)
    .filter((r): r is CommitmentRecord => r !== null && r.bond.address.startsWith("bc1"));
}
export function getCommitmentBond(bondId: string): CommitmentRecord | null {
  const rec = readRaw()[bondId];
  return rec ? deserializeCommitment(rec) : null;
}

/** Cross-device recovery: rebuild a local bond RECORD from the user's own on-chain
 *  announcement (kind 38135) + seed — so a bond posted on ONE device shows + reclaims
 *  on ANOTHER with the same npub. Pure + adversarial: the announced address MUST
 *  reproduce from (ownerXonly, lockUntil) on the ACTIVE network (a signet leftover
 *  rebuilt under mainnet mismatches → rejected), and the seed MUST own that key within
 *  `maxIndex` (else it isn't ours → not reclaimable → skip). The caller supplies the
 *  on-chain UTXOs, which decide the phase. Returns null if it can't be safely rebuilt. */
export function reconstructBondRecord(params: {
  ownerXonlyHex: string;
  lockUntil: number;
  claimedSats: bigint;
  announcedAddress: string;
  seedWords: string;
  network: BtcNetwork;
  /** Confirmed UTXOs at the CLTV bond address (present ⇒ a live/locked bond). */
  bondUtxos?: BondUtxo[];
  /** Confirmed UTXOs at the bond-KEY address (present ⇒ reclaimed-not-yet-swept). */
  bondKeyUtxos?: BondUtxo[];
  createdAt?: number;
  maxIndex?: number;
}): CommitmentRecord | null {
  const wantHex = params.ownerXonlyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(wantHex)) return null;
  if (!Number.isInteger(params.lockUntil) || params.lockUntil <= 0) return null;
  const bond = buildCommitmentBond(hexToBytes(wantHex), params.lockUntil, params.network);
  // recompute-don't-trust: the announced address must reproduce (this also rejects a
  // cross-network leftover — a signet key rebuilt under mainnet yields a different addr).
  if (bond.address !== params.announcedAddress) return null;
  // Find the derivation index whose bond key equals the announced key (needed to reclaim).
  let keyIndex = -1;
  const max = Number.isInteger(params.maxIndex) ? Math.max(0, params.maxIndex as number) : 50;
  for (let i = 0; i <= max; i++) {
    if (bytesToHex(deriveBondSigningKey(params.seedWords, { network: params.network, index: i }).xonly) === wantHex) {
      keyIndex = i;
      break;
    }
  }
  if (keyIndex < 0) return null;
  const createdAt = params.createdAt ?? Math.floor(Date.now() / 1000);
  // Funds at the CLTV bond address ⇒ a LIVE (locked) bond.
  const bondU = (params.bondUtxos ?? []).filter((u) => u.amountSats > 0n);
  if (bondU.length > 0) {
    return {
      bondId: newBondId(), bond, keyIndex, phase: "locked",
      amountSats: bondU.reduce((s, u) => s + u.amountSats, 0n),
      utxos: bondU, createdAt,
    };
  }
  // Else funds at the bond-KEY address ⇒ a RECLAIMED-but-not-yet-swept bond. The tx
  // that funded that address IS the reclaim, so its txid seeds `reclaimTxid`, and the
  // record carries the bond-key reclaim destination so the "credit to Chama" sweep
  // button surfaces + works (creditReclaimedCommitmentBond re-derives the key).
  const keyU = (params.bondKeyUtxos ?? []).filter((u) => u.amountSats > 0n);
  if (keyU.length > 0) {
    const bondKeyAddress = btc.p2tr(hexToBytes(wantHex), undefined, params.network).address as string;
    return {
      bondId: newBondId(), bond, keyIndex, phase: "reclaimed",
      amountSats: keyU.reduce((s, u) => s + u.amountSats, 0n),
      reclaimTxid: keyU[0].txid,
      reclaimDestination: { requested: "chama", actual: "bond-key", address: bondKeyAddress, fallbackReason: "Recovered from your on-chain announcement — reclaimed to the bond key; sweep to credit it into Chama." },
      createdAt,
    };
  }
  return null; // no funds at either address → nothing live to recover
}
/** Phase-monotonic upsert: never downgrade (created→locked→reclaimed only), and
 *  carry a funded UTXO forward if an equal-rank re-save omits it. */
export function upsertCommitmentBond(rec: CommitmentRecord): CommitmentRecord {
  const map = readRaw();
  const existing = map[rec.bondId] ? deserializeCommitment(map[rec.bondId]) : null;
  if (existing && PHASE_RANK[rec.phase] < PHASE_RANK[existing.phase]) return existing;
  const merged: CommitmentRecord = existing
    ? {
        ...rec,
        keyIndex: rec.keyIndex ?? existing.keyIndex,
        utxos: rec.utxos ?? existing.utxos,
        reclaimTxid: rec.reclaimTxid ?? existing.reclaimTxid,
        reclaimDestination: rec.reclaimDestination ?? existing.reclaimDestination,
        creditTxid: rec.creditTxid ?? existing.creditTxid,
        creditOperationId: rec.creditOperationId ?? existing.creditOperationId,
        creditConfirmedAt: rec.creditConfirmedAt ?? existing.creditConfirmedAt,
        renewedFromBondId: rec.renewedFromBondId ?? existing.renewedFromBondId,
        renewalToBondId: rec.renewalToBondId ?? existing.renewalToBondId,
        renewalTxid: rec.renewalTxid ?? existing.renewalTxid,
        renewalRawTx: rec.renewalRawTx ?? existing.renewalRawTx,
        renewalFeeSats: rec.renewalFeeSats ?? existing.renewalFeeSats,
        renewalBroadcastAt: rec.renewalBroadcastAt ?? existing.renewalBroadcastAt,
      }
    : rec;
  map[rec.bondId] = serializeCommitment(merged);
  writeRaw(map);
  return merged;
}
export function removeCommitmentBond(bondId: string): void {
  const map = readRaw();
  if (!(bondId in map)) return;
  delete map[bondId];
  writeRaw(map, { allowEmptyOverwrite: true });
}
