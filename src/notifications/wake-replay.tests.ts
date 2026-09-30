import assert from 'node:assert/strict';
import { fetchWakeEvents, replayWake } from './wake-replay.js';
const snapshot = { pubkey: 'a'.repeat(64), events: [], relays: [] };
assert.deepEqual([...replayWake([], snapshot.pubkey, '')], [], 'empty cache has no actionable trade');
await assert.rejects(fetchWakeEvents(snapshot), /No relay replied/, 'offline is a failure, never a successful empty read');
class EmptyRelay {
  onopen?: () => void; onmessage?: (event: {data: string}) => void;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send() { this.onmessage?.({data: JSON.stringify(['EOSE', 'wake'])}); }
  close() {}
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: EmptyRelay });
assert.deepEqual(await fetchWakeEvents({...snapshot, relays: ['wss://test.invalid']}), [], 'EOSE with nothing new is successful and silent');
console.log('PASS wake replay empty read and network-down distinction');

// A native wake must cover both transitions and opted-in chat, with replay dedup.
const { selectWakeNotifications, wakeNotification } = await import('./wake-replay.js');
const { safetyFixture } = await import('../../scripts/lib/escrow-safety-fixture.js');
const btc = await import('@scure/btc-signer');
const { EscrowStatus, EscrowEventKind: Kind, Role, Outcome } = await import('../escrow-engine/types.js');
const fixture = safetyFixture({
  buyer: btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),
  seller: btc.utils.pubSchnorr(new Uint8Array(32).fill(12)),
  arbiter: btc.utils.pubSchnorr(new Uint8Array(32).fill(13)),
}, 2_000_000, 'sm_wake_test');
const created = { ...fixture.state, escrowMode: 'ecash' as const };
const locked = { ...created, status: EscrowStatus.LOCKED };
assert.equal(wakeNotification(locked, created, fixture.pks.buyer)?.tag, `${created.id}:locked`);
const approved = { ...locked, status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE };
assert.equal(wakeNotification(approved, locked, fixture.pks.buyer)?.tag, `${created.id}:approved`);
assert.equal(wakeNotification(approved, locked, fixture.pks.buyer, {}, new Set([created.id])), null, 'already-claimed funds stay quiet');
const completed = { ...approved, status: EscrowStatus.COMPLETED };
assert.equal(wakeNotification(completed, approved, fixture.pks.seller)?.tag, `${created.id}:completed`, 'completion does not require a remaining action');
assert.equal(wakeNotification(completed, approved, 'stranger'), null);

const chat = fixture.event(Kind.CHAT, 'seller', { type: 'escrow:chat', message: 'Private payment details', sentAt: Math.floor(Date.now() / 1000), senderRole: Role.SELLER });
const chatState = { ...completed, chatMessages: [chat as import('../escrow-engine/types.js').ParsedEscrowEvent<import('../escrow-engine/types.js').ChatPayload>] };
const chatSnapshot = { pubkey: fixture.pks.buyer, events: created.eventChain.map(e => e.raw), relays: [], dmNotifyPref: 'on' as const, cachedAt: chat.timestamp * 1000 };
const old = new Map([[created.id, completed]]);
const notes = selectWakeNotifications([chatState], old, chatSnapshot, chat.timestamp * 1000, []);
assert.deepEqual(notes.map(n => n.tag), [`${created.id}:chat:${chat.raw.id}`], 'fresh chat delivers even on a completed trade');
assert.match(notes[0].body, /Private payment details/, 'native wake shows locally decrypted message text');
assert.deepEqual(selectWakeNotifications([chatState], old, chatSnapshot, chat.timestamp * 1000, [notes[0].tag]), [], 'repeated wake stays quiet');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, dmNotifyPref: 'off' }, 0, []), [], 'chat mute is honored');
assert.equal(selectWakeNotifications([chatState], old, { ...chatSnapshot, dmNotifyPref: 'auto' }, 0, []).length, 1, 'native trade chat wakes by default; explicit mute still wins');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, pubkey: fixture.pks.seller }, 0, []), [], 'own messages stay quiet');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, events: [...chatSnapshot.events, chat.raw] }, 0, []), [], 'cached chat is not new');
assert.deepEqual(selectWakeNotifications([chatState], old, { ...chatSnapshot, cachedAt: (chat.timestamp + 1) * 1000 }, 0, []), [], 'old chat is not new');
console.log('PASS native wake transitions, local chat text, explicit mute and replay dedup');

// Real signed CREATE/JOIN/CHAT with a sixty-trade cold snapshot, one invalid
// unrelated chain, and a capturing relay. No production key or wallet is used.
const { NsecSigner } = await import('../escrow-engine/nsec-signer.js');
const { EscrowClient } = await import('../escrow-engine/escrow-client.js');
const { nip19, finalizeEvent } = await import('nostr-tools');
const { runWakeJob, wakeFilters, wakePeerTags } = await import('./wake-replay.js');
const { buildWakeIndex, communityWakeTag } = await import('./wake-index.js');
const { deriveWatchTag, deriveCommunityWakeTag } = await import('./web-push-client.js');
const sellerSecret = new Uint8Array(32).fill(17);
const sellerSigner = new NsecSigner('11'.repeat(32));
// Use keys whose byte material also matches the nsec delivered to the worker.
const buyerSigner = new NsecSigner('12'.repeat(32));
const sellerKey = await sellerSigner.getPublicKey(), buyerKey = await buyerSigner.getPublicKey();
const signed: import('../escrow-engine/types.js').NostrEvent[] = [];
const makeClient = (signer: InstanceType<typeof NsecSigner>) => {
  const client = new EscrowClient(signer, {relays:[]});
  (client as any).relayManager.publish = async (e: import('../escrow-engine/types.js').NostrEvent) => {
    signed.push(e); return {accepted:1,rejected:0,errors:[]};
  };
  return client;
};
const sellerClient = makeClient(sellerSigner), buyerClient = makeClient(buyerSigner);
const seenQueries: any[][] = [];
let returned: import('../escrow-engine/types.js').NostrEvent[] = [];
class TaggedRelay {
  onopen?: () => void; onmessage?: (event:{data:string}) => void;
  constructor() {queueMicrotask(() => this.onopen?.());}
  send(value:string) {
    const query=JSON.parse(value); seenQueries.push(query);
    for (const e of returned) this.onmessage?.({data:JSON.stringify(['EVENT','wake',e])});
    this.onmessage?.({data:JSON.stringify(['EOSE','wake'])});
  }
  close() {}
}
Object.defineProperty(globalThis,'WebSocket',{configurable:true,value:TaggedRelay});
try {
  const listing = (await sellerClient.createEscrow({category:'p2p-trade', description:'170 sats', amountMsats:170000,
    mintUrl:'test-only', community:'us-blf', communityArbiters:[]})).state;
  const create = signed[0];
  const snapshotEvents = [create];
  for (let i=1;i<60;i++) {
    const {id:_id,sig:_sig,...unsigned}=create;
    snapshotEvents.push(finalizeEvent({...unsigned,tags:unsigned.tags.map(t=>t[0]==='d'?['d',`sm_unrelated_${i}`]:t)},sellerSecret) as any);
  }
  const pair = await deriveWatchTag(await sellerSigner.conversationKey(buyerKey),listing.id);
  const wakeSnapshot={pubkey:sellerKey,events:snapshotEvents,relays:['wss://test.invalid'],cachedAt:create.created_at*1000,
    names:{[buyerKey]:'Bestie'},...buildWakeIndex(snapshotEvents,'us-blf')};
  // A malformed unrelated root would have poisoned the old whole-identity replay.
  snapshotEvents[59] = finalizeEvent({kind:38100,created_at:create.created_at,tags:[['d','sm_broken']],content:'{}'},sellerSecret) as any;
  (buyerClient as any).states.set(listing.id,listing);
  const joined = await buyerClient.joinEscrow(listing.id,Role.BUYER,{amountMsats:170000,orderFinalized:true});
  const join = signed.at(-1)!;
  returned=[join];
  const beforeJob=Date.now();
  const job=await runWakeJob({snapshot:{...wakeSnapshot,watchTrades:{[pair]:[listing.id]}},nsec:nip19.nsecEncode(sellerSecret),
    tags:[pair],lastWake:Date.now()+30000,fired:[]});
  assert.equal(job.affectedTrades,1); assert.equal(job.failedTrades,0);
  assert.match(job.notifications[0].body,/Bestie joined your 170-sat offer — lock it/);
  assert(Date.now()-beforeJob<15000,'sixty-trade JOIN finishes within the wake budget');
  const filters=seenQueries[0].slice(2);
  assert.deepEqual(filters.map(f=>f['#d']),[[listing.id]]);
  assert(filters.every(f=>typeof f.since==='number'&&!f['#p']));
  assert(job.watchTags.includes(pair),'first JOIN seeds its exact future CHAT watch');
  const communityJob=await runWakeJob({snapshot:wakeSnapshot,nsec:nip19.nsecEncode(sellerSecret),tags:[communityWakeTag('us-blf')],lastWake:0,fired:[]});
  assert(communityJob.watchTags.includes(pair),'community JOIN seeds peer watch without a foreground resume');
  assert.match(communityJob.notifications[0].body,/Bestie joined/);
  assert.equal(communityWakeTag('us-blf'),await deriveCommunityWakeTag('us-blf'));
  assert.deepEqual(wakeFilters(wakeSnapshot,[communityWakeTag('us-blf')]).map(f=>f['#community']),[['us-blf']]);
  assert.equal(wakePeerTags([joined],sellerKey,nip19.nsecEncode(sellerSecret))[0],pair);
  const brokenJoin = finalizeEvent({kind:join.kind,created_at:join.created_at,tags:join.tags.map(t=>t[0]==='d'?['d','sm_missing_root']:t),content:join.content},new Uint8Array(32).fill(18));
  returned=[join,brokenJoin as any];
  const partialJob=await runWakeJob({snapshot:wakeSnapshot,nsec:nip19.nsecEncode(sellerSecret),tags:[communityWakeTag('us-blf')],lastWake:0,fired:[]});
  assert.equal(partialJob.failedTrades,1); assert.equal(partialJob.result,'partial replay');
  assert(partialJob.notifications.some(n=>n.body.includes('Bestie joined')),'one broken affected trade does not veto the valid JOIN');
  (buyerClient as any).states.set(listing.id,joined);
  await buyerClient.sendChat(listing.id,'are you up?');
  returned=[signed.at(-1)!]; seenQueries.length=0;
  const chatJob=await runWakeJob({snapshot:{...wakeSnapshot,events:[...snapshotEvents,join]},nsec:nip19.nsecEncode(sellerSecret),
    tags:[pair],lastWake:Date.now()+30000,fired:job.notifications.map(n=>n.tag)});
  assert.equal(chatJob.notifications.length,1,'CHAT alone does not re-post the already-seen JOIN action');
  assert(chatJob.notifications.some(n=>n.body==='Bestie: are you up?'),'queued chat predating the previous job finish still notifies');
  const otherListing = (await buyerClient.createEscrow({category:'p2p-trade',description:'Coffee beans',amountMsats:120000000,mintUrl:'test-only',community:'us-blf',communityArbiters:[]})).state;
  const otherCreate = signed.at(-1)!;
  returned=[otherCreate];
  const enabledSnapshot={...wakeSnapshot,homeCommunity:'us-blf',newListings:{enabled:true,verticals:'all' as const}};
  const newJob=await runWakeJob({snapshot:enabledSnapshot,nsec:nip19.nsecEncode(sellerSecret),tags:[communityWakeTag('us-blf')],lastWake:0,fired:[]});
  assert(newJob.notifications.some(n=>n.body==='Bestie: Coffee beans, 120,000 sats'&&n.group==='chama-listings:us-blf'));
  returned=[finalizeEvent({kind:otherCreate.kind,created_at:otherCreate.created_at,tags:[...otherCreate.tags,['renewal',otherListing.id]],content:otherCreate.content},new Uint8Array(32).fill(18)) as any];
  const renewJob=await runWakeJob({snapshot:enabledSnapshot,nsec:nip19.nsecEncode(sellerSecret),tags:[communityWakeTag('us-blf')],lastWake:0,fired:[]});
  assert.equal(renewJob.notifications.length,0,'signed renewal CREATE is silent');
  returned=[otherCreate];
  const mutedJob=await runWakeJob({snapshot:{...enabledSnapshot,newListings:{enabled:false,verticals:'all'}},nsec:nip19.nsecEncode(sellerSecret),tags:[communityWakeTag('us-blf')],lastWake:0,fired:[]});
  assert.equal(mutedJob.notifications.length,0,'new listing preference stays authoritative');
  const badInput={...wakeSnapshot,events:[{...create,content:'{}'}]};
  await assert.rejects(runWakeJob({snapshot:badInput,nsec:nip19.nsecEncode(new Uint8Array(32).fill(99)),tags:[pair],lastWake:0,fired:[]}),/Identity changed/);
} finally {sellerClient.disconnect();buyerClient.disconnect();}
console.log('PASS sixty-trade targeted wake: exact delta, named JOIN, learned peer watch, decrypted queued CHAT, unrelated broken history and identity guard');
