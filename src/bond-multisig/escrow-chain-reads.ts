// ══════════════════════════════════════════════════════════════════════════
// Chama — corroborated on-chain escrow funding reads (review M7)
// ══════════════════════════════════════════════════════════════════════════
//
// "The deposit is confirmed" is what tells a seller to hand over the goods or
// send the fiat. The hedged explorer fetch answers with whichever host replies
// first, so one lying or broken explorer could make an empty escrow look
// funded. On the shipped mainnet setup this read asks every built-in explorer
// separately and counts a deposit only when at least two of them report the
// same output, amount and block. A user who chose their own explorer keeps it
// as the single authority, exactly as everywhere else in the app.

import { SIGNET, type BtcNetwork } from "./multisig.js";
import { BUILTIN_ESPLORA_BASE } from "./esplora-config.js";
import {
  EsploraUnavailableError,
  MAINNET_HEDGE_EXPLORERS,
  defaultEsploraBase,
  esploraFetcher,
  type BondFunding,
  type EsploraFetch,
} from "./fund-watcher.js";
import { findEscrowFundingUtxos } from "./onchain-escrow-funding.js";

/** Explorers that must agree before a deposit counts. */
export const ESCROW_FUNDING_QUORUM = 2;

/** Confirmations an escrow deposit needs before the counterparty is told to
 *  send. Bonds stay at one (they lock the poster's own capital); an escrow
 *  deposit is a payment someone else acts on. */
export const ESCROW_FUNDING_MIN_CONFS = { mainnet: 2, signet: 1 } as const;

export function escrowFundingMinConfs(network: BtcNetwork): number {
  return network === SIGNET ? ESCROW_FUNDING_MIN_CONFS.signet : ESCROW_FUNDING_MIN_CONFS.mainnet;
}

/** The hosts a funding read asks: every built-in mainnet explorer, or the one
 *  explorer the user (or signet) points at. */
export function escrowFundingExplorers(network: BtcNetwork, base = defaultEsploraBase(network)): string[] {
  const normalized = base.replace(/\/+$/, "");
  if (network !== SIGNET && normalized === BUILTIN_ESPLORA_BASE.mainnet.replace(/\/+$/, "")) {
    return [...MAINNET_HEDGE_EXPLORERS];
  }
  return [normalized];
}

const fundingKey = (f: BondFunding) =>
  `${f.utxo.txid}:${f.utxo.index}:${f.utxo.amountSats}:${f.blockHeight ?? "?"}`;

/**
 * Strict escrow funding read, corroborated across explorers.
 *
 * Fails closed: if fewer than ESCROW_FUNDING_QUORUM explorers answer, it
 * throws rather than trusting the one that did. A deposit two explorers
 * disagree about (different amount, different block) is not counted.
 */
export async function findCorroboratedEscrowFunding(params: {
  address: string;
  network: BtcNetwork;
  minConfs: number;
  timeoutMs?: number;
  /** Test seam: one fetcher per explorer base. */
  fetcherFor?: (base: string) => EsploraFetch;
  bases?: readonly string[];
}): Promise<BondFunding[]> {
  const bases = params.bases ?? escrowFundingExplorers(params.network);
  const fetcherFor = params.fetcherFor
    ?? ((base: string) => esploraFetcher(base, { network: params.network, timeoutMs: params.timeoutMs, hedge: false }));
  const read = (base: string) => findEscrowFundingUtxos({
    address: params.address, network: params.network, minConfs: params.minConfs, fetchJson: fetcherFor(base),
  });
  if (bases.length < ESCROW_FUNDING_QUORUM) return read(bases[0]!);

  const settled = await Promise.allSettled(bases.map(read));
  const answers = settled.flatMap(r => r.status === "fulfilled" ? [r.value] : []);
  if (answers.length < ESCROW_FUNDING_QUORUM) {
    throw new EsploraUnavailableError(bases, settled.flatMap(r => r.status === "rejected" ? [r.reason] : []));
  }
  const counts = new Map<string, { funding: BondFunding; votes: number }>();
  for (const answer of answers) {
    const seen = new Set<string>();
    for (const funding of answer) {
      const key = fundingKey(funding);
      if (seen.has(key)) continue;
      seen.add(key);
      const entry = counts.get(key);
      if (entry) entry.votes += 1;
      else counts.set(key, { funding, votes: 1 });
    }
  }
  return [...counts.values()].filter(e => e.votes >= ESCROW_FUNDING_QUORUM).map(e => e.funding);
}
