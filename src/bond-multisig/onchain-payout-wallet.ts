// Chama — recoverable wallet view for per-trade on-chain settlement outputs.
//
// Settlement pays a fresh BIP86 address derived from (seed, escrow id). That is
// excellent isolation, but it also means a conventional single-address balance
// misses the money. This module turns known trade states into a deterministic
// watch list and provides the only safe spend path: re-derive the key, prove it
// matches the key committed in LOCK, re-scan the chain, then sweep every UTXO.

import * as btc from "@scure/btc-signer";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { EscrowState } from "../escrow-engine/types.js";
import { Role } from "../escrow-engine/types.js";
import { getWinner } from "../escrow-engine/state-machine.js";
import { deriveEscrowSigningKey } from "./onchain-escrow-funding.js";
import { buildKeyPathSweepTx } from "./commitment-bond.js";
import { SIGNET, type BondUtxo, type BtcNetwork } from "./multisig.js";
import type { EsploraFetch } from "./fund-watcher.js";

export interface OnchainPayoutCandidate {
  escrowId: string;
  role: Role.BUYER | Role.SELLER;
  address: string;
  xonly: string;
  network: BtcNetwork;
}

export interface OnchainPayout extends OnchainPayoutCandidate {
  utxos: BondUtxo[];
  balanceSats: bigint;
}

/** Pure recovery index. It intentionally includes APPROVED/CLAIMED trades: a
 * broadcast can win the race against COMPLETE publication or app shutdown. */
export function payoutCandidateFor(
  state: EscrowState,
  viewerPubkey: string,
): OnchainPayoutCandidate | null {
  const terms = state.lock.onchain;
  const winner = getWinner(state);
  if (!terms || !winner || (winner.role !== Role.BUYER && winner.role !== Role.SELLER)) return null;
  if (state.participants[winner.role] !== viewerPubkey) return null;
  const xonly = winner.role === Role.BUYER ? terms.buyerXonly : terms.sellerXonly;
  const network = terms.network === "mainnet" ? (btc.NETWORK as BtcNetwork) : SIGNET;
  try {
    const address = btc.p2tr(hexToBytes(xonly), undefined, network).address;
    return address ? { escrowId: state.id, role: winner.role, address, xonly, network } : null;
  } catch {
    return null;
  }
}

export function payoutCandidatesFor(
  states: readonly EscrowState[],
  viewerPubkey: string,
): OnchainPayoutCandidate[] {
  const byId = new Map<string, OnchainPayoutCandidate>();
  for (const state of states) {
    const candidate = payoutCandidateFor(state, viewerPubkey);
    if (candidate) byId.set(candidate.escrowId, candidate);
  }
  return [...byId.values()];
}

/** Read confirmed UTXOs and verify every returned script against the locally
 * recomputed winner address. An explorer response is evidence, not authority. */
export async function scanOnchainPayout(
  candidate: OnchainPayoutCandidate,
  fetchJson: EsploraFetch,
): Promise<OnchainPayout> {
  const raw = await fetchJson(`/address/${candidate.address}/utxo`);
  const spend = btc.p2tr(hexToBytes(candidate.xonly), undefined, candidate.network);
  const expectedScript = bytesToHex(spend.script).toLowerCase();
  const utxos: BondUtxo[] = [];
  if (Array.isArray(raw)) {
    for (const row of raw) {
      if (row?.status?.confirmed !== true || typeof row?.value !== "number" || row.value <= 0) continue;
      if (typeof row.txid !== "string" || !/^[0-9a-f]{64}$/i.test(row.txid)) continue;
      if (!Number.isInteger(row.vout) || row.vout < 0) continue;
      const tx = await fetchJson(`/tx/${row.txid}`);
      const actual = tx?.vout?.[row.vout]?.scriptpubkey;
      if (typeof actual !== "string" || actual.toLowerCase() !== expectedScript) continue;
      utxos.push({ txid: row.txid.toLowerCase(), index: row.vout, amountSats: BigInt(row.value) });
    }
  }
  return {
    ...candidate,
    utxos,
    balanceSats: utxos.reduce((sum, utxo) => sum + utxo.amountSats, 0n),
  };
}

export function aggregateOnchainPayoutBalance(payouts: readonly OnchainPayout[]): bigint {
  return payouts.reduce((sum, payout) => sum + payout.balanceSats, 0n);
}

/** Conservative BIP86 one-output sweep estimate. The floor is supplied by the
 * caller's live fee source; every extra key-path input adds about 58 vbytes. */
export function payoutSweepFeeSats(feeRateSatsPerVb: bigint, inputs: number): bigint {
  if (inputs < 1) throw new Error("A payout sweep needs at least one input");
  const rate = feeRateSatsPerVb < 1n ? 1n : feeRateSatsPerVb;
  return (111n + BigInt(inputs - 1) * 58n) * rate;
}

export async function buildOnchainPayoutSweep(params: {
  state: EscrowState;
  viewerPubkey: string;
  mnemonic: string;
  destination: string;
  fetchJson: EsploraFetch;
  feeRateSatsPerVb: bigint;
}): Promise<{ rawTx: string; payout: OnchainPayout; feeSats: bigint; sendSats: bigint }> {
  const candidate = payoutCandidateFor(params.state, params.viewerPubkey);
  if (!candidate) throw new Error("This trade has no recoverable on-chain payout for this identity.");
  const key = deriveEscrowSigningKey(params.mnemonic, candidate.escrowId, { network: candidate.network });
  if (bytesToHex(key.xonly).toLowerCase() !== candidate.xonly.toLowerCase()) {
    throw new Error("This Chama seed does not control the winner key committed in this trade.");
  }
  const payout = await scanOnchainPayout(candidate, params.fetchJson);
  if (payout.utxos.length === 0) throw new Error("No confirmed, unspent winner output is available.");
  const feeSats = payoutSweepFeeSats(params.feeRateSatsPerVb, payout.utxos.length);
  const sendSats = payout.balanceSats - feeSats;
  const rawTx = buildKeyPathSweepTx({
    ownerXonly: key.xonly,
    ownerPriv: key.priv,
    utxos: payout.utxos,
    destination: params.destination.trim(),
    feeSats,
    network: candidate.network,
  });
  return { rawTx, payout, feeSats, sendSats };
}
