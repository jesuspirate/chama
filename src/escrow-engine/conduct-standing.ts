import { hexToBytes } from '@noble/hashes/utils.js';
import { buildOnchainEscrow } from '../bond-multisig/onchain-escrow.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import type { VerifiedBond } from '../bond-multisig/bond-announcement.js';
import { hasValidSettlementSignatureForRole } from './onchain-settlement-transport.js';
import { EscrowEventKind as Kind, Role, Outcome, type ParsedEscrowEvent, type VotePayload } from './types.js';
import type { PublicConductRecord } from './public-conduct.js';

export interface BondConductProof { bond: VerifiedBond; fundedAtTime: number | null; tipTime: number | null; }
export interface ConductStanding {
  sellerSpeed: {medianSeconds:number;samples:number} | null;
  arbiterSpeed: {medianSeconds:number;samples:number} | null;
  settledTrades: number | null;
  bonded: {sats:string;days:number} | null;
  newHere: boolean;
}
const median = (values:number[]) => {
  if (values.length<3) return null;
  const sorted=[...values].sort((a,b)=>a-b), middle=Math.floor(sorted.length/2);
  return {medianSeconds:sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2,samples:sorted.length};
};
/** A response must cryptographically reference the earlier counterparty event,
 * directly or through the signed trade chain. Self-claimed times are ignored. */
function references(response: ParsedEscrowEvent, earlier: ParsedEscrowEvent, chain: readonly ParsedEscrowEvent[]): boolean {
  const byId=new Map(chain.map(e=>[e.raw.id,e]));
  let id: string | null | undefined=response.prevEventId ?? response.raw.tags.find(t=>t[0]==='conduct-after')?.[1];
  const seen=new Set<string>();
  while(id && !seen.has(id)) {
    if(id===earlier.raw.id) return response.timestamp>=earlier.timestamp;
    seen.add(id); const parent=byId.get(id);
    if(!parent || parent.timestamp>response.timestamp) return false;
    id=parent.prevEventId;
  }
  return false;
}
export function conductStanding(pubkey:string, record:PublicConductRecord, bondProofs:readonly BondConductProof[], bondsKnown:boolean):ConductStanding {
  const seller:number[]=[],arbiter:number[]=[];
  const trades=[...new Map(record.trades.map(t=>[t.state.id,t])).values()].sort((a,b)=>a.state.id.localeCompare(b.state.id));
  for(const {state} of trades) {
    const chain=[...state.eventChain].sort((a,b)=>a.timestamp-b.timestamp || a.raw.id.localeCompare(b.raw.id));
    const votes=chain.filter(e=>e.kind===Kind.VOTE);
    const paid=votes.find(e=>e.pubkey===state.participants.buyer && (e.payload as VotePayload).outcome===Outcome.RELEASE);
    const terms=state.lock.onchain;
    if(paid && terms && state.participants.seller===pubkey) {
      const escrow=buildOnchainEscrow({...terms,buyerXonly:hexToBytes(terms.buyerXonly),sellerXonly:hexToBytes(terms.sellerXonly),arbiterXonly:hexToBytes(terms.arbiterXonly),network:terms.network==='mainnet'?MAINNET:SIGNET});
      const response=[...(state.settlements??[])].sort((a,b)=>a.timestamp-b.timestamp || a.raw.id.localeCompare(b.raw.id))
        .find(e=>e.pubkey===pubkey && e.payload.role===Role.SELLER && e.payload.leaf!=='refund' && references(e,paid,chain)
          && hasValidSettlementSignatureForRole(e.payload.psbt,escrow,Role.SELLER,e.payload.leaf==='coop'?'coop':'dispute'));
      if(response) seller.push(response.timestamp-paid.timestamp);
    }
    const buyerVote=votes.find(e=>(e.payload as VotePayload).role===Role.BUYER);
    const sellerVote=votes.find(e=>(e.payload as VotePayload).role===Role.SELLER);
    if(buyerVote && sellerVote && (buyerVote.payload as VotePayload).outcome!==(sellerVote.payload as VotePayload).outcome) {
      const opened=buyerVote.timestamp>sellerVote.timestamp?buyerVote:sellerVote;
      const ruling=votes.find(e=>e.pubkey===pubkey && (e.payload as VotePayload).role===Role.ARBITER && references(e,opened,chain));
      if(ruling) arbiter.push(ruling.timestamp-opened.timestamp);
    }
  }
  const bonds=[...new Map(bondProofs.filter(p=>p.bond.npub===pubkey && p.bond.funded && p.bond.active).map(p=>[p.bond.address,p])).values()];
  const dated=bonds.length>0 && bonds.every(p=>p.fundedAtTime!==null && p.tipTime!==null && p.tipTime>=p.fundedAtTime);
  const bonded=dated?{sats:bonds.reduce((sum,p)=>sum+p.bond.actualSats,0n).toString(),days:Math.min(...bonds.map(p=>Math.floor((p.tipTime!-p.fundedAtTime!)/86400)))}:null;
  return {sellerSpeed:record.complete?median(seller):null,arbiterSpeed:record.complete?median(arbiter):null,
    settledTrades:record.complete?trades.filter(t=>t.spend?.confirmed && ['coop','dispute'].includes(t.spend.leaf)).length:null,
    bonded,newHere:record.complete && bondsKnown && trades.length===0 && bondProofs.length===0};
}
