import assert from 'node:assert/strict';
import {EscrowClient} from '../escrow-engine/escrow-client.js';
import {NsecSigner} from '../escrow-engine/nsec-signer.js';
import {Role, EscrowStatus, type NostrEvent} from '../escrow-engine/types.js';
import {makeChainEventTagger, seedOpenTradeWatches, openTradeWatchTags} from './watch-tags.js';
import {deriveCommunityWakeTag, deriveWatchTag} from './web-push-client.js';
import {setLocalStorageUserScope} from '../storage/user-scope.js';
const data = new Map<string,string>([['chama_bg_push_enabled','1']]);
Object.assign(globalThis,{localStorage:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});
setLocalStorageUserScope('publish-wake-test');
const seller = new NsecSigner('11'.repeat(32)), buyer = new NsecSigner('22'.repeat(32)), arbiter = new NsecSigner('33'.repeat(32));
const sp = await seller.getPublicKey(), bp = await buyer.getPublicKey(), ap = await arbiter.getPublicKey();
const registered: string[] = [], published: NostrEvent[] = [];
const register = async(tags:readonly string[])=>{registered.push(...tags);return true;};
const client = (signer:NsecSigner) => {
  const c = new EscrowClient(signer,{relays:[],chainEventTagger:makeChainEventTagger(signer,register)});
  (c as any).relayManager.publish = async(e:NostrEvent)=>{published.push(e);return{accepted:1,rejected:0,errors:[]};};
  return c;
};
const sc = client(seller), bc = client(buyer);
try {
  const {state:listing} = await sc.createEscrow({description:'Test listing',amountMsats:170000,category:'p2p-trade',mintUrl:'test-only',community:'us-blf',communityArbiters:[ap]});
  const community = await deriveCommunityWakeTag('us-blf');
  assert(registered.includes(community),'actual CREATE registers creator community before first buyer exists');
  registered.length = 0;
  await seedOpenTradeWatches(seller,[listing],register);
  assert(registered.includes(community),'launch seeds own open listing community');
  assert(!(await openTradeWatchTags(buyer,[listing])).includes(community),'other identity does not register creator listing');
  assert(!(await openTradeWatchTags(seller,[{...listing,expiresAt:1}])).includes(community),'expired listing does not seed community');
  (bc as any).states.set(listing.id,listing);
  const joined = await bc.joinEscrow(listing.id,Role.BUYER);
  const join = published.at(-1)!;
  const pair = await deriveWatchTag(await seller.conversationKey(bp),listing.id,0);
  assert(join.tags.some(t=>t[0]==='w'&&t[1]===pair),'actual JOIN wakes the seller');
  assert.equal(join.tags.filter(t=>t[0]==='w').length,1);
  assert(join.tags.some(t=>t[0]==='community'&&t[1]==='us-blf'),'actual JOIN carries listing community');
  const seated = {...joined, participants:{...joined.participants,[Role.ARBITER]:ap}};
  (bc as any).states.set(listing.id,seated);
  await bc.sendChat(listing.id,'Hello');
  const chat = published.at(-1)!;
  const arbiterPair = await deriveWatchTag(await buyer.conversationKey(ap),listing.id,0);
  assert.equal(chat.tags.filter(t=>t[0]==='w').length,2,'actual CHAT wakes every other seated participant');
  assert(chat.tags.some(t=>t[0]==='w'&&t[1]===pair));
  assert(chat.tags.some(t=>t[0]==='w'&&t[1]===arbiterPair));
  assert(!chat.tags.some(t=>t[0]==='community'),'chat uses pair wake only');
  // JOIN renewal when an arbiter is already seated uses both peer watches.
  await bc.joinEscrow(listing.id,Role.BUYER,{orderFinalized:true});
  assert.equal(published.at(-1)!.tags.filter(t=>t[0]==='w').length,2);
  data.delete('chama_bg_push_enabled'); registered.length=0;
  await bc.sendChat(listing.id,'Alerts off');
  assert.equal(published.at(-1)!.tags.filter(t=>t[0]==='w').length,2,'alerts off never disables outgoing wake tags');
  assert.equal(registered.length,0,'alerts off prevents own registration');
} finally { sc.disconnect();bc.disconnect(); }
console.log('PASS actual CREATE/JOIN/CHAT publishers: creator launch registration, peer ECDH tags, alerts-off send and community JOIN routing.');

// 6.4.18 G: every real settlement builder carries both peer wake tags.
const {Outcome,EscrowEventKind} = await import('../escrow-engine/types.js');
const {verifyEvent} = await import('nostr-tools/pure');
const principals = [sp,bp,ap];
const settlementStart = published.length;
const s2 = client(seller), b2 = client(buyer);
try {
 const created = (await s2.createEscrow({description:'Settlement wake test',amountMsats:3_000_000,
  category:'p2p-trade',mintUrl:'test-only',community:'us-blf',communityArbiters:[ap]})).state;
 (b2 as any).states.set(created.id,created);
 const joined = await b2.joinEscrow(created.id,Role.BUYER,{amountMsats:3_000_000,orderFinalized:true});
 (s2 as any).states.set(created.id,joined);
 const hash = 'a'.repeat(64);
 const locked = await s2.lockEscrow(created.id,{notesHash:hash,
  shares:[1,2,3].map(shareIndex=>({shareIndex,encryptedFor:{[sp]:'test-only',[bp]:'test-only',[ap]:'test-only'}})),
  sellerReceivesMsats:3_000_000,arbiterFeeMsats:0,buyerPubkey:bp,arbiterPubkey:ap});
 assert.equal(locked.status,EscrowStatus.LOCKED);
 (b2 as any).states.set(created.id,locked);
 const voted = await b2.vote(created.id,Outcome.RELEASE);
 (s2 as any).states.set(created.id,voted);
 await s2.vote(created.id,Outcome.RELEASE);
 const approved = s2.getState(created.id)!;
 assert.equal(approved.status,EscrowStatus.APPROVED);
 (b2 as any).states.set(created.id,approved);
 await b2.claim(created.id,hash);
 await b2.complete(created.id);
 const cancelBase = (await s2.createEscrow({description:'Cancellation wake',amountMsats:1_000_000,
  category:'p2p-trade',mintUrl:'test-only',communityArbiters:[ap]})).state;
 (s2 as any).states.set(cancelBase.id,{...cancelBase,participants:{buyer:bp,seller:sp,arbiter:ap}});
 await s2.cancel(cancelBase.id);
 const rows = published.slice(settlementStart);
 for (const kind of [EscrowEventKind.VOTE,EscrowEventKind.CLAIM,EscrowEventKind.COMPLETE,EscrowEventKind.CANCEL,EscrowEventKind.RESOLVE]) {
  const event = rows.find(e=>e.kind===kind)!;
  assert(event, `actual builder published kind ${kind}`);
  assert(verifyEvent(event), `kind ${kind} has a valid signature`);
  assert.equal(event.tags.filter(t=>t[0]==='w').length,2,`kind ${kind} wakes both peers`);
  const author = event.pubkey === sp ? seller : buyer;
  for (const peer of principals.filter(pk=>pk!==event.pubkey)) {
   assert(event.tags.some(t=>t[0]==='p' && t[1]===peer));
   const expected = await deriveWatchTag(await author.conversationKey(peer),event.tags.find(t=>t[0]==='d')![1],0);
   assert(event.tags.some(t=>t[0]==='w' && t[1]===expected));
  }
 }
} finally {s2.disconnect();b2.disconnect();}
console.log('PASS signed VOTE/CLAIM/COMPLETE/CANCEL/RESOLVE builders wake both seated peers');
