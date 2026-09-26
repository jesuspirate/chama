import { verifyEvent } from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { buildOnchainEscrow } from '../bond-multisig/onchain-escrow.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import type { EsploraFetch } from '../bond-multisig/fund-watcher.js';
import { parseEscrowEvent, sortEventChain } from './event-parser.js';
import { replayEventChain, getWinner } from './state-machine.js';
import { finalArbiterSettlementProof, finalCoopSettlementProof, settlementUnsignedId } from './onchain-settlement-transport.js';
import { EscrowEventKind as Kind, Outcome, Role, type EscrowPayload, type EscrowState, type NostrEvent, type VotePayload } from './types.js';

/** Only newly advertised public-conduct trades disclose these minimal facts.
 * Never disclose historical encrypted events, chat, fiat handles or shares. */
export function publicConductTags(state: EscrowState, payload: EscrowPayload): string[][] {
  if (!state.onchainPublicConduct || !state.lock.onchain) return [];
  if (payload.type === 'escrow:vote') {
    const {type,outcome,role,votedAt,onchainRelease} = payload;
    return [['conduct',JSON.stringify({type,outcome,role,votedAt,onchainRelease})]];
  }
  if (payload.type === 'escrow:resolve' || payload.type === 'escrow:settlement' || payload.type === 'escrow:settlement_stalled')
    return [['conduct',JSON.stringify(payload)]];
  return [];
}

/** Public replay never uses the viewer's decrypted/private trade cache. */
export function replayPublicConduct(events: readonly NostrEvent[]): EscrowState | null {
  const verified = events.filter(e=>{
    try { return verifyEvent({id:e.id,sig:e.sig,pubkey:e.pubkey,kind:e.kind,created_at:e.created_at,tags:e.tags,content:e.content}); } catch { return false; }
  });
  const signed = [...new Map(verified.map(e=>[e.id,e])).values()].sort((a,b)=>a.created_at-b.created_at || a.id.localeCompare(b.id));
  const create = signed.find(e=>e.kind===Kind.CREATE);
  if (!create) return null;
  const root = parseEscrowEvent(create,create.content);
  if (!root.ok || root.event.payload.type!=='escrow:create' || !root.event.payload.onchainPublicConduct) return null;
  const parsed = signed.flatMap(e=>{
    const tags = e.tags.filter(t=>t[0]==='conduct');
    if (tags.length>1) return [];
    const result = parseEscrowEvent(e,tags[0]?.[1] ?? e.content,true);
    return result.ok ? [result.event] : [];
  });
  const result = replayEventChain(sortEventChain(parsed));
  return result.ok ? result.state : null;
}

export interface ConductSpend {
  txid: string;
  confirmed: boolean;
  /** Actual witness leaf reported for every escrow input, not a PSBT claim. */
  leaf: 'coop' | 'dispute' | 'other' | 'unspent';
}
export interface ConductTrade { state: EscrowState; spend: ConductSpend | null; }
export interface PublicConductRecord { marks: number; complete: boolean; trades: ConductTrade[]; }

export async function readConductSpend(state: EscrowState, fetchJson: EsploraFetch): Promise<ConductSpend | null> {
  const terms=state.lock.onchain, winner=getWinner(state);
  if (!terms) return null;
  const out=await fetchJson(`/tx/${terms.fundingTxid}/outspend/${terms.fundingVout}`);
  if (out?.spent === false) return {txid:'',confirmed:false,leaf:'unspent'};
  if (!out?.spent || typeof out.txid!=='string' || !winner || winner.role===Role.ARBITER) return null;
  const tx=await fetchJson(`/tx/${out.txid}`);
  if (tx?.txid!==out.txid || !Array.isArray(tx.vin) || typeof tx.status?.confirmed!=='boolean') return null;
  const escrow=buildOnchainEscrow({...terms,buyerXonly:hexToBytes(terms.buyerXonly),sellerXonly:hexToBytes(terms.sellerXonly),arbiterXonly:hexToBytes(terms.arbiterXonly),network:terms.network==='mainnet'?MAINNET:SIGNET});
  for (const message of state.settlements??[]) {
    const proof=finalArbiterSettlementProof(message,terms,winner.role,state.settlements,winner.pubkey)
      ?? finalCoopSettlementProof(message,terms,winner.role,state.settlements,winner.pubkey);
    if (!proof || proof.txid!==out.txid) continue;
    const inputs=proof.inputs.map(i=>tx.vin.find((v:any)=>v.txid===i.txid && v.vout===i.index));
    if (inputs.some(v=>!v || !Array.isArray(v.witness) || v.witness.length<2)) continue;
    const scripts=inputs.map(v=>v.witness.at(-2));
    const leaf=scripts.every(s=>s===bytesToHex(escrow.leaves.dispute))?'dispute'
      : scripts.every(s=>s===bytesToHex(escrow.leaves.coop))?'coop':'other';
    return {txid:out.txid,confirmed:tx.status.confirmed,leaf};
  }
  return null;
}

/** Positive marks survive incomplete unrelated history; absence is unknown.
 * No wall clock, ratings, expiration, author-claimed counts or local summaries. */
export function publicConductRecord(pubkey: string, trades: readonly ConductTrade[], complete: boolean): PublicConductRecord {
  const unique=[...new Map([...trades].sort((a,b)=>a.state.id.localeCompare(b.state.id)).map(t=>[t.state.id,t])).values()];
  const marked=new Set<string>();
  for (const {state,spend} of unique) {
    if (!spend?.confirmed || spend.leaf!=='dispute') continue;
    const winner=getWinner(state);
    const other=winner?.role===Role.BUYER?Role.SELLER:Role.BUYER;
    if (!winner || state.participants[other]!==pubkey || state.resolvedOutcome!==Outcome.RELEASE) continue;
    const approval=state.eventChain.some(e=>e.kind===Kind.VOTE && e.pubkey===pubkey
      && (e.payload as VotePayload).role===other && (e.payload as VotePayload).outcome===Outcome.RELEASE);
    // The final proof checked above binds this transaction to a winner-authored
    // proposal; require that public choice explicitly rather than a default.
    const chosen=(state.settlements??[]).some(e=>{ try { return e.pubkey===winner.pubkey && !!e.payload.payoutAddress && settlementUnsignedId(e.payload.psbt)===spend.txid; } catch { return false; } });
    if (approval && chosen) marked.add(state.id);
  }
  return {marks:marked.size,complete:complete && unique.every(t=>t.spend!==null),trades:unique};
}
