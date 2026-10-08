import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { parseEscrowEvent } from './event-parser.js';
import { EscrowClient } from './escrow-client.js';
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
 }
 {
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

// A signed pre-gate CREATE is still legacy consensus, but funding consent is
// ungated. The bridge cases above include cutoff-1 with an empty pool.
const old=create(cutoff-86400,[arbiter]);
const oldLock=lock(old.state,-3600);
const funded=applyEvent(old.state,oldLock); assert(funded.ok);
const signedDeadline=oldLock.timestamp+86400;
const realNow=Date.now;
for(const status of [S.LOCKED,S.EXPIRED]) {
 const client=new EscrowClient({getPublicKey:async()=>seller,signEvent:async e=>finalizeEvent(e,keys[0]),nip44Encrypt:async text=>text,nip44Decrypt:async text=>text},{relays:[]});
 const seam=client as any; seam.states.set(old.state.id,{...funded.state,status});
 const votes:string[]=[]; seam.vote=async(_id:string,outcome:string)=>{votes.push(outcome);};
 try {
  for(const at of [funded.state.expiresAt+1,signedDeadline-1,signedDeadline]) {
   Date.now=()=>at*1000; await seam.maybeAutoRefundExpired(old.state.id);
   assert.equal(votes.length,0,'Pre-gate backdated lockedAt cannot cause an early automatic REFUND');
  }
  Date.now=()=> (signedDeadline+1)*1000; await seam.maybeAutoRefundExpired(old.state.id);
  assert.deepEqual(votes,['refund'],'Automatic healing resumes after the signed-time deadline');
 } finally {Date.now=realNow;client.disconnect();}
}
console.log('PASS ungated client consent: old empty-pool funding refuses; old backdated LOCK cannot cause early auto-REFUND');

// Old empty-pool retry: recover actual saved notes before refusing new funding.
{
 const storage=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value),removeItem:(key:string)=>storage.delete(key)}});
 const {setLocalStorageUserScope}=await import('../storage/user-scope.js');
 const {stashNativeLockIntent,upgradeNativeLockToSpent,getPendingNativeLock}=await import('../fedimint/pending-native-locks.js');
 setLocalStorageUserScope('empty-pool-stash-regression');
 const {state}=create(cutoff-86400,[]);
 const notes='synthetic-saved-ecash';
 const input={escrowId:state.id,amountMsats:state.amountMsats,federationId:'test-federation'};
 stashNativeLockIntent(input);upgradeNativeLockToSpent({...input,oobNotes:notes});
 let reabsorbed=0,locks=0,spends=0;
 const bridge=new EscrowFedimintBridge({getState:()=>state,loadEscrow:async()=>state,getConnectedRelayCount:()=>2,resolveDurableMoneyPublish:()=>{},lockEscrow:async()=>{locks++;}} as any,
  {getFederationId:()=>input.federationId,redeemWithRetry:async(value:string)=>{assert.equal(value,notes);reabsorbed++;},spendNotesForLock:async()=>{spends++;}} as any,{} as any);
 const originalNow=Date.now;
 try {
  Date.now=()=> (state.createdAt+20)*1000;
  await assert.rejects(bridge.lockAndPublish(state.id),(error:any)=>{
   assert.equal(error.code,'ARBITER_POOL_EMPTY');assert.doesNotMatch(error.message,/No sats were spent/);assert.equal(reabsorbed,1,'Recover before refusing');return true;
  });
 } finally {Date.now=originalNow;}
 assert.equal(reabsorbed,1);assert.equal(locks,0);assert.equal(spends,0);
 assert.equal(getPendingNativeLock(state.id),null,'Recovered stash and unusable Finish-lock intent cleared');
 setLocalStorageUserScope(null);
}
console.log('PASS old empty-pool retry reabsorbs saved ecash, publishes no LOCK, clears stash and refuses honestly');
