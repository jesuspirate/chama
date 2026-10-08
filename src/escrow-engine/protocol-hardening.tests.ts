import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { parseEscrowEvent } from './event-parser.js';
import { applyEvent, replayEventChain } from './state-machine.js';
import { EscrowFedimintBridge } from '../fedimint/escrow-bridge.js';
import { MONEY_PATH_HARDENING_CREATE_AT as cutoff, LOCK_TIMESTAMP_SKEW_SECONDS as skew } from './protocol-hardening.js';
import { EscrowEventKind as K, Role, EscrowStatus as S, type EscrowState, type EscrowPayload, type ParsedEscrowEvent } from './types.js';
const keys=[31,32,33].map(n=>new Uint8Array(32).fill(n));
const [seller,buyer,arbiter]=keys.map(getPublicKey);
let sequence=0;
function event(kind:K,payload:EscrowPayload,key:Uint8Array,at:number,id:string,prev?:string) {
 const raw=finalizeEvent({kind,created_at:at,tags:[['d',id],...(prev?[['e',prev,'','reply']]:[])],content:JSON.stringify(payload)},key);
 assert(verifyEvent(raw));
 const parsed=parseEscrowEvent(raw,raw.content); assert(parsed.ok,parsed.ok?'':parsed.error.message);
 return parsed.event;
}
function create(at:number,pool:string[],community?:string,payloadAt=at) {
 const e=event(K.CREATE,{type:'escrow:create',category:'p2p-trade',description:'Synthetic H5/H6',amountMsats:100000,mintUrl:'fed1test',platformFeeBps:0,platformFeePubkey:seller,expirySeconds:86400,communityArbiters:pool,community,createdAt:payloadAt},keys[0],at,`hardening-${++sequence}`);
 const result=applyEvent(null,e); assert(result.ok,result.ok?'':result.error.message); return {e,state:result.state};
}
function lock(state:EscrowState,offset=0) {
 const at=state.createdAt+10;
 return event(K.LOCK,{type:'escrow:lock',notesHash:'test',shares:[0,1,2].map(shareIndex=>({shareIndex,encryptedFor:Object.fromEntries([seller,buyer,arbiter].map(pk=>[pk,'encrypted']))})),buyerPubkey:buyer,arbiterPubkey:arbiter,sellerReceivesMsats:100000,arbiterFeeMsats:0,lockedAt:at+offset},keys[0],at,state.id,state.eventChain.at(-1)!.raw.id);
}
const rejected=(result:ReturnType<typeof applyEvent>,code:string)=>{assert(!result.ok);assert.equal(result.error.code,code);};
for(const at of [cutoff-1,cutoff,cutoff+1]) {
 const {e,state}=create(at,[]);
 const join=event(K.JOIN,{type:'escrow:join',role:Role.ARBITER,joinedAt:at+1},keys[2],at+1,state.id,e.raw.id);
 const joined=applyEvent(state,join), locked=applyEvent(state,lock(state));
 if(at<cutoff) {
  assert(joined.ok,'Old empty-pool volunteer JOIN remains lawful');
  assert(locked.ok,'Old direct empty-pool LOCK remains replayable');
  assert(applyEvent(state,lock(state,-3600)).ok,'Old backdated clock remains replayable');
 } else {
  rejected(joined,'ARBITER_POOL_EMPTY'); rejected(locked,'ARBITER_POOL_EMPTY');
  let walletTouches=0;
  const wallet=new Proxy({}, {get(){walletTouches++;throw Error('Wallet must not be touched');}});
  const bridge=new EscrowFedimintBridge({getState:()=>state} as any,wallet as any,{} as any);
  await assert.rejects(bridge.preflightLock(state.id), (error:any)=>error.code==='ARBITER_POOL_EMPTY');
  await assert.rejects(bridge.lockAndPublish(state.id), /no committed arbiter pool/);
  assert.equal(walletTouches,0,'H5 refuses before probing or spending');
 }
}
for(const at of [cutoff-1,cutoff,cutoff+1]) {
 const {e,state}=create(at,[arbiter]);
 for(const offset of [-skew,0,skew]) {
  const l=lock(state,offset),result=replayEventChain([e,l]);
  assert(result.ok,result.ok?'':result.error.message);assert.equal(result.state.status,S.LOCKED);
  assert.equal(result.state.expiresAt,l.timestamp+offset+86400);
 }
 for(const offset of [-skew-1,skew+1,-86400,86400]) {
  const l=lock(state,offset),result=applyEvent(state,l);
  if(at<cutoff) assert(result.ok,'Older funded clocks retain the old law');
  else { rejected(result,'LOCK_TIMESTAMP_SKEW'); const replay=replayEventChain([e,l]); assert(!replay.ok,'Participant forged deadline fails closed during replay'); }
 }
 if(at>=cutoff) for(const lockedAt of [NaN,Infinity,at+0.5]) {
  const l=lock(state); rejected(applyEvent(state,{...l,payload:{...l.payload,lockedAt}} as ParsedEscrowEvent),'LOCK_TIMESTAMP_SKEW');
 }
}
const forged=create(cutoff,[],undefined,cutoff-86400);
assert.equal(forged.state.createdAt,cutoff,'Activation uses signed CREATE, not payload createdAt');
rejected(applyEvent(forged.state,lock(forged.state)),'ARBITER_POOL_EMPTY');
const legacyCommunity=create(cutoff-1,[],'ke-kes');
rejected(applyEvent(legacyCommunity.state,event(K.JOIN,{type:'escrow:join',role:Role.ARBITER,joinedAt:cutoff},keys[2],cutoff,legacyCommunity.state.id,legacyCommunity.e.raw.id)),'ARBITER_POOL_EMPTY');
console.log('PASS H5/H6: signed CREATE boundaries, pre-spend pool refusal, inclusive skew, strict forged-deadline replay, legacy chains');
