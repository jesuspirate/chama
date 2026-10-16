import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { finalizeEvent, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools';
import { EscrowEventKind as K, EscrowStatus as S, Outcome as O, Role as R, type EscrowState, type EscrowPayload, type CreatePayload, type NostrEvent } from '../escrow-engine/types.js';
import { parseEscrowEvent } from '../escrow-engine/event-parser.js';
import { applyEvent, canVote, replayEventChain } from '../escrow-engine/state-machine.js';
import { EscrowClient } from '../escrow-engine/escrow-client.js';
import { suppressedVoteError } from '../escrow-engine/vote-suppression.js';
import { shareEscrowId } from './policy.js';
import { CircleSurface } from '../ui/screens/CircleSurface.js';
import { LangProvider } from '../i18n/index.js';
import { circleReturnSignatureNotification } from '../notifications/trade-notifications.js';
import { runWakeJob } from '../notifications/wake-replay.js';
import { clearEventCache } from '../escrow-engine/escrow-event-cache.js';
import { oneSidedEscalationAt } from '../escrow-engine/arbiter-substitution.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
const storage = new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)}});
const keys=[11,12,13].map(n=>new Uint8Array(32).fill(n)), [member,host,arbiter]=keys.map(getPublicKey);
const realNow=Date.now, now=Math.floor(Date.now()/1000), start=now-30000, fill=now-15000, end=now+36000, parentId='aa'.repeat(32), shareId=shareEscrowId(parentId,member,1);
function signed(kind:K,payload:EscrowPayload,key:Uint8Array,id:string,at:number,previous?:EscrowState) {
 return finalizeEvent({kind,created_at:at,tags:[['d',id],['t',payload.type],...(previous?[['e',previous.eventChain.at(-1)!.raw.id,'','reply']]:[])],content:JSON.stringify(payload)},key);
}
function apply(state:EscrowState|null, raw:NostrEvent, parent?:EscrowState) {
 const parsed=parseEscrowEvent(raw,raw.content,false,{parent,state:state??undefined});assert(parsed.ok, parsed.ok?'':parsed.error.message);
 const next=applyEvent(state,parsed.event);assert(next.ok,next.ok?'':next.error.message);return next.state;
}
const parentRaw=signed(K.CREATE,{type:'escrow:create',category:'chama',description:'Return fixture',amountMsats:100000,mintUrl:'fed1test',platformFeeBps:0,platformFeePubkey:host,expirySeconds:end-start,communityArbiters:[arbiter],createdAt:start,
 chamaCircle:{shareMsats:100000,seatThreshold:2,seatCap:3,fillDeadlineSec:fill,roundEndSec:end,roundIndex:1,prevCircleId:null}},keys[1],parentId,start);
const parent=apply(null,parentRaw);
const createRaw=signed(K.CREATE,{...(parent.eventChain[0].payload as CreatePayload),type:'escrow:create',category:'chama-share',chamaCircle:undefined,chamaPolicy:'share-v1',parent:parentId,sellerPubkey:host,createdAt:start+10,expirySeconds:end-start-10},keys[0],shareId,start+10);
const share=apply(null,createRaw,parent);
const lockRaw=signed(K.LOCK,{type:'escrow:lock',notesHash:'hash',shares:[{shareIndex:0,encryptedFor:{[member]:'member'}},{shareIndex:1,encryptedFor:{[host]:'host'}},{shareIndex:2,encryptedFor:{[arbiter]:'arbiter'}}],sharePolicy:'holder-only-v1',arbiterPoolShare:true,buyerPubkey:member,arbiterPubkey:arbiter,sellerReceivesMsats:100000,arbiterFeeMsats:0,lockedAt:start+20},keys[0],shareId,start+20,share);
const locked=apply(share,lockRaw);
const votePayload={type:'escrow:vote' as const,role:R.BUYER,outcome:O.REFUND,votedAt:fill+1};
const voteRaw=signed(K.VOTE,votePayload,keys[0],shareId,fill+1,locked);
const consented=apply(locked,voteRaw);
const escalation=oneSidedEscalationAt(consented)!;
assert(escalation > fill && escalation < now);
const automatedChains:EscrowState[]=[];
const otherKey=new Uint8Array(32).fill(21), other=getPublicKey(otherKey), otherId=shareEscrowId(parentId,other,1);
const otherCreate=signed(K.CREATE,JSON.parse(createRaw.content),otherKey,otherId,start+10);
const otherShare=apply(null,otherCreate,parent);
const otherLockPayload=JSON.parse(lockRaw.content);otherLockPayload.buyerPubkey=other;otherLockPayload.shares[0].encryptedFor={[other]:'member'};
const otherLocked=apply(otherShare,signed(K.LOCK,otherLockPayload,otherKey,otherId,start+20,otherShare));
// Actual EscrowClient signing/publish/ACK, not just a watcher callback.
for(const filled of [false,true]) for(const [index,initial] of [[0,locked],[1,locked],[1,consented],[2,consented]] as const) {
 const client=new EscrowClient({getPublicKey:async()=>getPublicKey(keys[index]),signEvent:async event=>finalizeEvent(event,keys[index]),nip44Encrypt:async value=>value,nip44Decrypt:async value=>value},{relays:[]});
 const seam=client as any;seam.states.set(parentId,parent);seam.states.set(shareId,initial);if(filled)seam.states.set(otherId,otherLocked);
 seam.loadChildren=async()=>{seam.chamaViewComplete.add(parentId);return [seam.states.get(shareId),...(filled?[otherLocked]:[])];};
 const sent:NostrEvent[]=[];
 seam.relayManager.publish=async(raw:NostrEvent)=>{assert(verifyEvent(raw));sent.push(raw);return {accepted:1,rejected:0,errors:[]};};
 try {
  if(index===2) {
   Date.now=()=> (escalation-1)*1000;
   await client.maybeAutoRefundChama(escalation-1);
   assert.equal(sent.length,0,'assigned arbiter sends nothing before the existing escalation window');
  }
  Date.now=()=>now*1000;
  await client.maybeAutoRefundChama(now);await client.maybeAutoRefundChama(now);
  assert.equal(sent.filter(e=>e.kind===K.VOTE).length,filled?0:1,`online role ${index}: running circle stays locked; failed circle signs once`);
  if(!filled) {
   const result=client.getState(shareId)!;
   assert.equal(result.votes[[R.BUYER,R.SELLER,R.ARBITER][index]],O.REFUND);
   automatedChains.push(result);
  }
 } finally {Date.now=realNow;client.disconnect();await clearEventCache();}
}
// Complete chains made entirely by automation: member first, then either
// immediate host or assigned arbiter at the existing window (including RESOLVE).
const automaticMember=automatedChains.find(chain=>chain.votes[R.BUYER]===O.REFUND && chain.votes[R.SELLER]===undefined && chain.votes[R.ARBITER]===undefined)!;
assert(automaticMember);
for(const index of [1,2]) {
 const client=new EscrowClient({getPublicKey:async()=>getPublicKey(keys[index]),signEvent:async event=>finalizeEvent(event,keys[index]),nip44Encrypt:async value=>value,nip44Decrypt:async value=>value},{relays:[]});
 const seam=client as any;seam.states.set(parentId,parent);seam.states.set(shareId,automaticMember);
 seam.loadChildren=async()=>{seam.chamaViewComplete.add(parentId);return [seam.states.get(shareId)];};
 const sent:NostrEvent[]=[];
 seam.relayManager.publish=async(raw:NostrEvent)=>{assert(verifyEvent(raw));sent.push(raw);return {accepted:1,rejected:0,errors:[]};};
 const at=index===1?now:oneSidedEscalationAt(automaticMember)!;
 try {
  if(index===2) {Date.now=()=>(at-1)*1000;await client.maybeAutoRefundChama(at-1);assert.equal(sent.length,0);}
  Date.now=()=>at*1000;
  await client.maybeAutoRefundChama(at);await client.maybeAutoRefundChama(at);
  assert.equal(sent.filter(e=>e.kind===K.VOTE).length,1);
  assert.equal(sent.filter(e=>e.kind===K.RESOLVE).length,1);
  assert.equal(client.getState(shareId)?.status,S.APPROVED);
  automatedChains.push(client.getState(shareId)!);
 } finally {Date.now=realNow;client.disconnect();await clearEventCache();}
}
// A timeout or failed child replay cannot be promoted to fill evidence.
const reader=new EscrowClient({getPublicKey:async()=>member,signEvent:async e=>finalizeEvent(e,keys[0]),nip44Encrypt:async value=>value,nip44Decrypt:async value=>value},{relays:[]});
const readSeam=reader as any;
try {
 readSeam.loadEscrow=async()=>locked;
 readSeam.relayManager.fetchChildCreates=async(_id:string,_ms:number,probe:any)=>{probe.noteResolved('timeout');return [createRaw];};
 await reader.loadChildren(parentId);assert.equal(readSeam.chamaViewComplete.has(parentId),false);
 readSeam.relayManager.fetchChildCreates=async(_id:string,_ms:number,probe:any)=>{probe.noteResolved('eose');return [createRaw];};
 await reader.loadChildren(parentId);assert.equal(readSeam.chamaViewComplete.has(parentId),true);
 readSeam.loadEscrow=async()=>null;
 await reader.loadChildren(parentId);assert.equal(readSeam.chamaViewComplete.has(parentId),false,'failed replay invalidates a previously complete read');
} finally {reader.disconnect();}
let permissionPrompts=0;
const permissionBound=new EscrowClient({getPublicKey:async()=>member,requiresUserAction:true,signEvent:async event=>{permissionPrompts++;return finalizeEvent(event,keys[0]);},nip44Encrypt:async value=>value,nip44Decrypt:async value=>value},{relays:[]});
try {(permissionBound as any).states.set(parentId,parent);await permissionBound.maybeAutoRefundChama(now);assert.equal(permissionPrompts,0,'background returns cannot initiate extension permission prompts');}
finally {permissionBound.disconnect();}
assert.equal(canVote(consented,arbiter,fill-1,O.REFUND).canVote,false);
assert.equal(canVote(locked,arbiter,now,O.REFUND).canVote,false,'no member consent, no early arbiter unwind');
const error=suppressedVoteError('Cannot vote: Already voted',consented)!;
assert.equal(error.message,error.originalMessage);assert.doesNotMatch(error.message,/can no longer be cast/);
assert.equal(suppressedVoteError('gateway unavailable',consented),null);
const ui=(state:EscrowState)=>renderToStaticMarkup(<LangProvider><CircleSurface parent={parent} escrows={new Map([[parentId,parent],[shareId,state]])} viewerPubkey={member} backLabel="Back" childrenLoaded profileNames={{[host]:'Named host',[arbiter]:'Named arbiter'}} kind0Enabled onBack={()=>{}} onLock={async()=>{}} onClaim={async()=>{}} onNextRound={()=>{}} onRefresh={async()=>{}}/></LangProvider>);
Date.now=()=> (escalation-1)*1000;
try {
 const waiting=ui(consented);
 assert.match(waiting,/Waiting on Named host to sign your return/);
 assert.match(waiting,/Named arbiter can sign from/);
 const time=new Date(escalation*1000).toLocaleString('en',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 assert(waiting.includes(time),'the named arbiter window shows the committed escalation timestamp in local time');
 assert.equal(circleReturnSignatureNotification(consented,arbiter,escalation-1),null,'no premature arbiter action');
 assert.equal(canVote(consented,arbiter,escalation-1,O.REFUND).canVote,false);
} finally {Date.now=realNow;}
assert.match(ui(consented),/Waiting on Named host or Named arbiter to sign your return/);
assert.doesNotMatch(ui(consented),/Return my share now|Your sats are coming back|can no longer be cast/);
assert.doesNotMatch(ui(locked),/Waiting on Named host/,'without a member vote, no invented responder obligation');
const hostVote=signed(K.VOTE,{...votePayload,role:R.SELLER,votedAt:fill+2},keys[1],shareId,fill+2,consented);
const quorum=apply(consented,hostVote);
const resolve=signed(K.RESOLVE,{type:'escrow:resolve',outcome:O.REFUND,majority:[R.BUYER,R.SELLER],arbiterInvolved:false,resolvedAt:fill+3},keys[0],shareId,fill+3,quorum);
const approved=apply(quorum,resolve);
assert.equal(approved.status,S.APPROVED);assert.match(ui(approved),/>Collect your sats</);
assert.doesNotMatch(ui({...approved,pendingVote:{eventId:'pending',role:R.SELLER,outcome:O.REFUND}}),/>Collect your sats</);
for(const viewer of [host,arbiter]) assert.equal(circleReturnSignatureNotification(consented,viewer,now)?.body,'A circle share needs your return signature.');
assert.equal(circleReturnSignatureNotification(consented,member,now),null);
assert.equal(circleReturnSignatureNotification(approved,host,now),null);
// Encrypted native replay includes its validated public parent and signs nothing.
const envelope={encryptedFor:Object.fromEntries([host,arbiter].map(pk=>[pk,nip44.v2.encrypt(JSON.stringify(votePayload),nip44.v2.utils.getConversationKey(keys[0],pk))]))};
const privateVote=finalizeEvent({...voteRaw,content:JSON.stringify(envelope),tags:[...voteRaw.tags,['w','opaque-return']]},keys[0]);
class WakeRelay {
 onopen?:()=>void; onmessage?:(event:{data:string})=>void;
 constructor() {queueMicrotask(()=>this.onopen?.());}
 send(wire:string) {const frame=JSON.parse(wire);if(frame[0]==='REQ')queueMicrotask(()=>{
  const ids=frame[2]?.['#d'];
  for(const raw of ids?.includes(parentId)?[parentRaw]:ids?.includes(shareId)?[createRaw,lockRaw,privateVote]:[privateVote])
    this.onmessage?.({data:JSON.stringify(['EVENT','wake',raw])});
  this.onmessage?.({data:JSON.stringify(['EOSE','wake'])});
 });}
 close() {}
}
Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:WakeRelay});
for(const index of [1,2]) {
 const pubkey=getPublicKey(keys[index]);
 const input={snapshot:{pubkey,events:[parentRaw,createRaw,lockRaw],relays:['wss://fixture.invalid'],cachedAt:(fill-10)*1000},events:[privateVote],tags:['opaque-return'],nsec:nip19.nsecEncode(keys[index]),lastWake:(fill-10)*1000,fired:[]};
 const wake=await runWakeJob(input);assert.equal(wake.notifications.length,1);assert.equal(wake.notifications[0].body,'A circle share needs your return signature.');
 const coldWake=await runWakeJob({...input,snapshot:{...input.snapshot,events:[]}});assert.equal(coldWake.notifications[0]?.body,'A circle share needs your return signature.','cold share fetches its validated parent before replay');
 assert.equal((await runWakeJob({...input,fired:[wake.notifications[0].tag]})).notifications.length,0,'return wake deduplicates');
}
// Load the actual shipped 6.4.20 reducer, parser and their source dependencies.
// Pin the release commit, not a mutable branch; no copy of today's gate can
// masquerade as a legacy reader. Installed third-party packages stay shared.
const repository=fileURLToPath(new URL('../../',import.meta.url));
const legacyDir=mkdtempSync(join(tmpdir(),'chama-6420-reader-'));
try {
 const archive=execFileSync('git',['archive','f0ff4c57bc5b7a7abc5d2a808c2785f467f04faa','src'],{cwd:repository,maxBuffer:64*1024*1024});
 execFileSync('tar',['-x','-C',legacyDir],{input:archive});
 writeFileSync(join(legacyDir,'package.json'),'{"type":"module"}');
 symlinkSync(join(repository,'node_modules'),join(legacyDir,'node_modules'),'dir');
 const legacyReducer=await import(pathToFileURL(join(legacyDir,'src/escrow-engine/state-machine.ts')).href) as typeof import('../escrow-engine/state-machine.js');
 const legacyParser=await import(pathToFileURL(join(legacyDir,'src/escrow-engine/event-parser.ts')).href) as typeof import('../escrow-engine/event-parser.js');
 const oldParentEvent=legacyParser.parseEscrowEvent(parentRaw,parentRaw.content);
 assert(oldParentEvent.ok);
 const oldParent=legacyReducer.applyEvent(null,oldParentEvent.event);assert(oldParent.ok);
 for(const chain of automatedChains) {
  const legacyEvents=chain.eventChain.map(event=>{
   assert(verifyEvent(event.raw));
   const parsed=legacyParser.parseEscrowEvent(event.raw,JSON.stringify(event.payload),false,{parent:oldParent.state});
   assert(parsed.ok,parsed.ok?'':parsed.error.message);return parsed.event;
  });
  const oldResult=legacyReducer.replayEventChain(legacyParser.sortEventChain(legacyEvents));
  const newResult=replayEventChain(legacyParser.sortEventChain(legacyEvents));
  assert(newResult.ok, newResult.ok ? "" : newResult.error.message);
  assert.equal(newResult.state.status,chain.status);
  assert.deepEqual(newResult.state.votes,chain.votes);
  assert.equal(newResult.state.resolvedOutcome,chain.resolvedOutcome);
  assert.deepEqual(oldResult,newResult,'actual automated VOTE/RESOLVE chain replays identically under the shipped 6.4.20 reader');
 }
 assert(automatedChains.some(chain=>chain.status===S.APPROVED && chain.votes[R.ARBITER]===O.REFUND),'compatibility covers the automated arbiter VOTE and RESOLVE');
 assert(automatedChains.some(chain=>chain.status===S.APPROVED && chain.votes[R.SELLER]===O.REFUND),'compatibility also covers the immediate host VOTE and RESOLVE');
} finally {rmSync(legacyDir,{recursive:true,force:true});}
console.log('PASS share returns: real signatures once; existing escalation clock; named timed waiting/approved Collect; original errors; encrypted wake; actual 6.4.20 reader parity');
