import { applyEvent } from '../../src/escrow-engine/state-machine';
import { EscrowEventKind as K, EscrowStatus as S, Role, Outcome, type EscrowState } from '../../src/escrow-engine/types';
import { getPublicKey } from 'nostr-tools/pure';
import { nip19 } from 'nostr-tools';
// Public, synthetic test key. Never used on a relay or with a real wallet.
export const testNsec = nip19.nsecEncode(new Uint8Array(32).fill(71));
export const viewer = getPublicKey(new Uint8Array(32).fill(71));
const seller = 'a'.repeat(64);
const now = Math.floor(Date.now()/1000);
export function listing(id: string, category = 'p2p-trade', owner = seller): EscrowState {
 const raw = {id:`create-${id}`,pubkey:owner,kind:K.CREATE,created_at:now,tags:[],content:'',sig:''};
 const result = applyEvent(null,{kind:K.CREATE,escrowId:id,pubkey:owner,timestamp:now,prevEventId:null,raw,
 payload:{type:'escrow:create',description:`Test ${id}`,category,amountMsats:1000000,mintUrl:'test',platformFeeBps:0,platformFeePubkey:seller,expirySeconds:86400,createdAt:now,community:'us-usd'}} as any);
 if(!result.ok) throw new Error(result.error.message);
 return result.state;
}
export function circleFixture(seat: 'held'|'locked'|'collect'|'claimed') {
 const parent = {...listing(`circle-${seat}`),category:'chama',description:'Friends circle',chamaCircle:{shareMsats:1000000,seatThreshold:3,seatCap:5,fillDeadlineSec:now+86400,roundEndSec:now+604800,roundIndex:1,prevCircleId:null}} as EscrowState;
 const base = listing(`share-${seat}`);
 const share = {...base,parent:parent.id,chamaPolicy:'share-v1',chamaCircle:parent.chamaCircle,participants:{...base.participants,buyer:viewer},status:seat==='held'?S.CREATED:seat==='collect'?S.APPROVED:seat==='claimed'?S.CLAIMED:S.LOCKED,
 resolvedOutcome:seat==='collect'||seat==='claimed'?Outcome.REFUND:null,
 resolvedAt:now+604801,eventChain:seat==='held'?base.eventChain:[...base.eventChain,{kind:K.LOCK,timestamp:now+1,raw:{id:`lock-${seat}`}}]} as EscrowState;
 return {parent,share};
}
