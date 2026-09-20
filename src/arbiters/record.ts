import { EscrowEventKind, Role, type EscrowState, type VotePayload } from '../escrow-engine/types.js';
import type { VerifiedBond } from '../bond-multisig/bond-announcement.js';
import { arbiterRulingConcentration } from './arbiter-pattern.js';
import { computeChamaLiveness, verifiedBondTenureBlocks, tenureTier, type RatingSummary } from './live-chama.js';
/** Observed conduct only. Empty history is unknown, never an endorsement. */
export function arbiterRecord(pubkey: string, escrows: readonly EscrowState[], bonds: readonly VerifiedBond[],
  ratings: ReadonlyMap<string, RatingSummary>, nowSec: number, tipHeight?: number | null, blocksPerDay = 144) {
  const key = pubkey.toLowerCase();
  const trades = [...new Map(escrows.filter(e => e.createdAt <= nowSec).map(e => [e.id, e])).values()].map(state => {
    const eventChain = state.eventChain.filter(e => e.timestamp <= nowSec);
    const votes: EscrowState['votes'] = {};
    for (const event of eventChain) {
      if (event.kind === EscrowEventKind.VOTE) {
        const payload = event.payload as VotePayload;
        votes[payload.role] ??= payload.outcome;
      }
    }
    return { ...state, eventChain, votes };
  });
  const ownBonds = bonds.filter(b => b.npub.toLowerCase() === key && b.funded && b.active);
  let healings = 0, disputes = 0, lastSeen: number | null = null;
  const latencies: number[] = [];
  for (const state of trades) {
    const chain = state.eventChain.filter(e => e.timestamp <= nowSec);
    const own = chain.filter(e => e.pubkey.toLowerCase() === key);
    for (const e of own) lastSeen = Math.max(lastSeen ?? 0, e.timestamp);
    const vote = own.find(e => e.kind === EscrowEventKind.VOTE && (e.payload as VotePayload).role === Role.ARBITER);
    if (!vote) continue;
    const principals = chain.filter(e => e.kind === EscrowEventKind.VOTE && e.timestamp <= vote.timestamp
      && [Role.BUYER, Role.SELLER].includes((e.payload as VotePayload).role));
    const buyer = principals.find(e => (e.payload as VotePayload).role === Role.BUYER);
    const seller = principals.find(e => (e.payload as VotePayload).role === Role.SELLER);
    if (buyer && seller && (buyer.payload as VotePayload).outcome !== (seller.payload as VotePayload).outcome) {
      disputes++;
      latencies.push(vote.timestamp - Math.max(buyer.timestamp, seller.timestamp));
    } else if (vote.timestamp >= state.expiresAt && chain.some(e => e.kind === EscrowEventKind.LOCK)) {
      healings++;
      latencies.push(vote.timestamp - state.expiresAt);
    }
  }
  latencies.sort((a, b) => a - b);
  const middle = Math.floor(latencies.length / 2);
  const medianResponseSec = latencies.length ? (latencies.length % 2 ? latencies[middle] : (latencies[middle - 1] + latencies[middle]) / 2) : null;
  const tenures = ownBonds.map(b => verifiedBondTenureBlocks(b, tipHeight)).filter((n): n is number => n !== null);
  const tenureBlocks = tenures.length ? Math.max(...tenures) : null;
  return { pubkey, healings, disputes, medianResponseSec, lastSeen, observedTrades: trades.length,
    concentration: arbiterRulingConcentration(trades, pubkey),
    bondSats: ownBonds.reduce((sum, b) => sum + b.actualSats, 0n), tenureBlocks,
    tenure: tenureTier(tenureBlocks, blocksPerDay),
    liveness: tipHeight == null ? null : computeChamaLiveness(ownBonds[0]?.community ?? '', ownBonds, ratings, tipHeight),
  };
}
export type ArbiterRecord = ReturnType<typeof arbiterRecord>;
