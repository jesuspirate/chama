import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools';
import { EscrowEventKind as K, Role as R, type CreatePayload, type EscrowPayload, type EscrowState, type NostrEvent, type ParsedEscrowEvent } from './types.js';
import { parseEscrowEvent, sortEventChain } from './event-parser.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { selectTradeRoot } from './trade-identity.js';
import { shareCreatePayload, shareEscrowId } from '../chama/policy.js';
import { roundCircleId } from '../chama/rotation.js';
import { EscrowClient } from './escrow-client.js';
import { clearEventCache } from './escrow-event-cache.js';
const secret=[11,12,13,14,15,16].map(n=>new Uint8Array(32).fill(n));
const [host,a,b,c,arbiter,stranger]=secret.map(getPublicKey);
const end=Math.floor(Date.now()/1000)-2000, duration=604800, start=end-duration, fill=start+86400;
const p1='ab'.repeat(32), p2=roundCircleId(p1,2);
function raw(kind:K,payload:EscrowPayload,key:Uint8Array,id:string,at:number,prev?:string):NostrEvent {
 return finalizeEvent({kind,created_at:at,tags:[['d',id],['t',payload.type],...(prev?[['e',prev,'','reply']]:[]),...((payload as CreatePayload).parent?[['parent',(payload as CreatePayload).parent!]]:[])],content:JSON.stringify(payload)},key);
}
function parsed(event:NostrEvent,parent?:EscrowState,cycle?:{circles:EscrowState[];shares:EscrowState[]}) {
 assert(verifyEvent(event));const result=parseEscrowEvent(event,event.content,false,{parent,cycle});assert(result.ok,result.ok?'':result.error.message);return result.event;
}
function apply(state:EscrowState|null,event:ParsedEscrowEvent) {const result=applyEvent(state,event);assert(result.ok,result.ok?'':result.error.message);return result.state;}
const parentPayload:CreatePayload={type:'escrow:create',category:'chama',description:'Sealed cycle',amountMsats:100000,mintUrl:'fed1test',platformFeeBps:0,platformFeePubkey:host,communityArbiters:[arbiter],createdAt:start,expirySeconds:duration,
 chamaCircle:{pot:'rotation-v2',shareMsats:100000,seatThreshold:3,seatCap:3,fillDeadlineSec:fill,roundEndSec:end,roundIndex:1,prevCircleId:null}};
const parentRaw=raw(K.CREATE,parentPayload,secret[0],p1,start), parent=apply(null,parsed(parentRaw));
const childCreates:NostrEvent[]=[], chains=new Map<string,NostrEvent[]>();
const shares:EscrowState[]=[];
for(const [index,member] of [a,b,c].entries()) {
 const at=start+20+index,id=shareEscrowId(p1,member,1),create=raw(K.CREATE,shareCreatePayload(parent,at),secret[index+1],id,at);
 let state=apply(null,parsed(create,parent));
 const lock=raw(K.LOCK,{type:'escrow:lock',notesHash:'test-notes',buyerPubkey:member,arbiterPubkey:arbiter,lockedAt:at+10,sellerReceivesMsats:100000,arbiterFeeMsats:0,sharePolicy:'holder-only-v1',arbiterPoolShare:true,
 shares:[{shareIndex:0,encryptedFor:{[member]:'member'}},{shareIndex:1,encryptedFor:{[host]:'host'}},{shareIndex:2,encryptedFor:{[arbiter]:'arbiter'}}]},secret[index+1],id,at+10,create.id);
 state=apply(state,parsed(lock));shares.push(state);childCreates.push(create);chains.set(id,[create,lock]);
}
const cycle={circles:[parent],shares};
const payload:CreatePayload={...parentPayload,createdAt:end,expirySeconds:duration,
 chamaCircle:{pot:'rotation-v2',shareMsats:100000,seatThreshold:2,seatCap:2,fillDeadlineSec:end+86400,roundEndSec:end+duration,roundIndex:2,prevCircleId:p1,unlisted:true}};
const firstRaw=raw(K.CREATE,payload,secret[1],p2,end),secondRaw=raw(K.CREATE,payload,secret[2],p2,end);
const first=parsed(firstRaw,undefined,cycle),second=parsed(secondRaw,undefined,cycle);
const earlierRaw=raw(K.CREATE,{...payload,createdAt:end-1,expirySeconds:duration+1},secret[5],p2,end-1);
const badTermsRaw=raw(K.CREATE,{...payload,mintUrl:'other'},secret[1],p2,end);
assert(!parseEscrowEvent(earlierRaw,earlierRaw.content,false,{cycle}).ok);
assert(!parseEscrowEvent(badTermsRaw,badTermsRaw.content,false,{cycle}).ok);
const unchecked=(r:NostrEvent):ParsedEscrowEvent=>({...first,raw:r,payload:JSON.parse(r.content),pubkey:r.pubkey,timestamp:r.created_at});
const expected=[first,second].sort((x,y)=>x.raw.id.localeCompare(y.raw.id))[0];
for(const events of [[unchecked(earlierRaw),first,second],[second,first,unchecked(earlierRaw)],[unchecked(badTermsRaw),second,first]]) {
 const selection=selectTradeRoot(events,stranger);assert(selection.ok);assert.equal(selection.events[0].raw.id,expected.raw.id);
 assert.equal(selection.ignored.length,1);
 const result=replayEventChain(sortEventChain(events));assert(result.ok,result.ok?'':result.error.message);
 assert.equal(result.state.initiator.pubkey,expected.pubkey);
 assert.equal(result.state.mintUrl,parent.mintUrl);
}
assert(!selectTradeRoot([{...first,chamaCycle:undefined}]).ok,'missing cycle evidence fails closed');
assert(!selectTradeRoot([unchecked(earlierRaw)]).ok,'no valid sealed-member root fails closed');
// Earlier valid timestamp wins; a child's link to another lawful CREATE is
// retained as an available predecessor rather than falsely becoming a hole.
const laterRaw=raw(K.CREATE,{...payload,createdAt:end+1,expirySeconds:duration-1},secret[2],p2,end+1);
assert.equal(selectTradeRoot([parsed(laterRaw,undefined,cycle),first]).ok,true);
const laterSelection=selectTradeRoot([parsed(laterRaw,undefined,cycle),first]);assert(laterSelection.ok);assert.equal(laterSelection.events[0].raw.id,firstRaw.id);
// Fresh client: resolve round 1 + signed commitment locks from the relay
// stubs, never inject a trusted cycle or parent into its in-memory state.
for(const events of [[earlierRaw,firstRaw,secondRaw],[secondRaw,firstRaw,earlierRaw]]) {
 const client=new EscrowClient({getPublicKey:async()=>stranger,signEvent:async e=>finalizeEvent(e,secret[5]),nip44Encrypt:async s=>s,nip44Decrypt:async s=>s},{relays:[]});
 const seam=client as any;
 seam.relayManager.fetchOnce=async(filter:any)=>filter['#d']?.[0]===p1?[parentRaw]:events;
 seam.relayManager.fetchChildCreates=async(id:string)=>id===p1?childCreates:[];
 seam.relayManager.fetchEscrowEvents=async(id:string)=>id===p2?events:chains.get(id)??[];
 try {
  const loaded=await client.loadEscrow(p2);assert(loaded,'fresh cold reader loads the lawful member round despite a stranger root');
  assert.equal(loaded.initiator.pubkey,expected.pubkey);
  // Parent lookup uses the same contextual parser and deterministic selector.
  seam.states.delete(p2);const resolved=await seam.resolveChamaParent(p2);assert.equal(resolved?.initiator.pubkey,expected.pubkey);
 } finally {client.disconnect();await clearEventCache();}
}
console.log('PASS rotation roots: sealed membership and full CREATE law; earliest/id tie-break; arrival order; absent context; real signed fresh-client and parent cold reads');
