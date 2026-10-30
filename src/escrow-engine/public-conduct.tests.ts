import assert from 'node:assert/strict';
import { finalizeEvent } from 'nostr-tools/pure';
import * as btc from '@scure/btc-signer';
import { bytesToHex } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { publicConductTags, replayPublicConduct, readConductSpend, publicConductRecord } from './public-conduct.js';
import { applyEvent } from './state-machine.js';
import { parseEscrowEvent } from './event-parser.js';
import { EscrowEventKind as Kind, Outcome, Role, type EscrowPayload, type EscrowState, type NostrEvent } from './types.js';
const keys={buyer:new Uint8Array(32).fill(11),seller:new Uint8Array(32).fill(12),arbiter:new Uint8Array(32).fill(13)};
const identities={buyer:new Uint8Array(32).fill(31),seller:new Uint8Array(32).fill(32),arbiter:new Uint8Array(32).fill(33)};
const f=safetyFixture({buyer:btc.utils.pubSchnorr(keys.buyer),seller:btc.utils.pubSchnorr(keys.seller),arbiter:btc.utils.pubSchnorr(keys.arbiter)},2_000_000,'public-conduct-test');
let state:EscrowState|null=null, clock=Math.floor(Date.now()/1000);
const events:NostrEvent[]=[];
function emit(kind:Kind,role:Role,payload:EscrowPayload) {
 const tags=[['d',f.state.id],['t',payload.type],...(state?.eventChain.at(-1)?[['e',state.eventChain.at(-1)!.raw.id,'','reply']]:[])];
 const disclosure=state?publicConductTags(state,payload):[];
 const raw=finalizeEvent({kind,created_at:clock++,tags:[...tags,...disclosure],content:disclosure.length?JSON.stringify({encryptedFor:{private:'ciphertext'}}):JSON.stringify(payload)},identities[role]);
 const parsed=parseEscrowEvent(raw,JSON.stringify(payload));assert.ok(parsed.ok);
 const next=applyEvent(state,parsed.event);assert.ok(next.ok,next.ok?'':next.error.message);state=next.state;events.push(raw);return raw;
}
emit(Kind.CREATE,Role.SELLER,{...f.state.eventChain[0].payload,onchainPublicConduct:true} as EscrowPayload);
emit(Kind.JOIN,Role.BUYER,{type:'escrow:join',role:Role.BUYER,joinedAt:clock,escrowXonly:bytesToHex(btc.utils.pubSchnorr(keys.buyer))});
emit(Kind.JOIN,Role.SELLER,{type:'escrow:join',role:Role.SELLER,joinedAt:clock,fundingTerms:f.terms});
const fundingTxid='11'.repeat(32);
emit(Kind.LOCK,Role.SELLER,{type:'escrow:lock',notesHash:'',shares:[],onchain:{...f.terms,amountSats:'100000',fundingTxid,fundingVout:0},buyerPubkey:f.pks.buyer,arbiterPubkey:f.pks.arbiter,sellerReceivesMsats:100000000,arbiterFeeMsats:0,lockedAt:clock});
emit(Kind.VOTE,Role.BUYER,{type:'escrow:vote',outcome:Outcome.RELEASE,role:Role.BUYER,votedAt:clock});
emit(Kind.VOTE,Role.SELLER,{type:'escrow:vote',outcome:Outcome.RELEASE,role:Role.SELLER,votedAt:clock});
emit(Kind.RESOLVE,Role.BUYER,{type:'escrow:resolve',outcome:Outcome.RELEASE,majority:[Role.BUYER,Role.SELLER],arbiterInvolved:false,resolvedAt:clock});
const destination=btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(25)),undefined,SIGNET).address!;
const utxos=[{txid:fundingTxid,index:0,amountSats:100000n}];
const coop=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n});
const proposal=emit(Kind.SETTLEMENT,Role.BUYER,{type:'escrow:settlement',psbt:coop,role:Role.BUYER,leaf:'coop',payoutAddress:destination});
clock+=86400;
const dispute=buildSettlementPsbt({escrow:f.escrow,utxos,destination,feeSats:500n,leaf:'dispute',fundingHeight:1,tipHeight:1000});
const payout={type:'escrow:settlement' as const,psbt:dispute,role:Role.BUYER,leaf:'arbiter' as const,payoutAddress:destination};
emit(Kind.SETTLEMENT_STALLED,Role.BUYER,{type:'escrow:settlement_stalled',proposalId:proposal.id,payout});
const signed=base64.encode(btc.PSBTCombine([base64.decode(coSignSettlement(dispute,keys.buyer)),base64.decode(coSignSettlement(dispute,keys.arbiter))]));
emit(Kind.SETTLEMENT,Role.BUYER,{...payout,psbt:signed,final:true});
const txid=btc.Transaction.fromPSBT(base64.decode(dispute),{allowUnknown:true,allowUnknownOutputs:true}).id;
for(const ordering of [events,[...events].reverse()]) {
 const replay=replayPublicConduct(ordering);assert.ok(replay,'outsider replays public evidence without decrypting');
 const spend=await readConductSpend(replay,async path=>path.includes('outspend')?{spent:true,txid}:{txid,status:{confirmed:true},vin:[{txid:fundingTxid,vout:0,witness:['sig',bytesToHex(f.escrow.leaves.dispute),'control']}]});
 assert.equal(spend?.leaf,'dispute');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend}],true).marks,1);
 assert.equal(publicConductRecord(f.pks.buyer,[{state:replay,spend}],true).marks,0);
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:null}],true).complete,false,'missing chain read is unknown');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:{...spend!,leaf:'coop'}}],true).marks,0,'signed dispute PSBT alone is not a chain mark');
 assert.equal(publicConductRecord(f.pks.seller,[{state:replay,spend:{...spend!,confirmed:false}}],true).marks,0,'mempool is not permanent conduct');
}
assert.equal(replayPublicConduct(events.map(e=>({...e,sig:'00'.repeat(64)}))),null,'forged evidence rejected');
assert.deepEqual(publicConductTags({...state!,onchainPublicConduct:undefined},{type:'escrow:vote',role:Role.SELLER,outcome:Outcome.RELEASE,votedAt:clock}),[],'legacy private history is never disclosed');
assert.deepEqual(publicConductTags(state!,{type:'escrow:chat',message:'secret',sentAt:clock} as EscrowPayload),[]);
console.log('PASS public conduct: signed outsider replay, both orderings, actual confirmed leaf, no forged/self-reported facts, unknown reads, legacy privacy');

// Standing: every sample is bounded by a signed counterparty reference.
const { conductStanding } = await import('./conduct-standing.js');
const completedState=state! as EscrowState;
const paid=completedState.eventChain.find(e=>e.kind===Kind.VOTE && e.pubkey===f.pks.buyer)!;
const records=[60,120,360].map((delay,index)=>{
 const response=f.event(Kind.SETTLEMENT,'seller',{type:'escrow:settlement',psbt:coSignSettlement(coop,keys.seller),leaf:'coop',role:Role.SELLER});
 response.timestamp=paid.timestamp+delay;response.prevEventId=paid.raw.id;
 return {state:{...completedState,id:`sample-${index}`,settlementStalled:undefined,settlements:[response as any]},spend:{txid,confirmed:true,leaf:'coop' as const}};
});
for(const ordering of [records,[...records].reverse()]) {
 const record=publicConductRecord(f.pks.seller,ordering,true);
 const standing=conductStanding(f.pks.seller,record,[],true);
 assert.deepEqual(standing.sellerSpeed,{medianSeconds:120,samples:3});
 assert.equal(standing.settledTrades,3);
 assert.equal(conductStanding(f.pks.seller,publicConductRecord(f.pks.seller,ordering.slice(0,2),true),[],true).sellerSpeed,null,'requires three samples');
 assert.equal(conductStanding(f.pks.seller,{...record,complete:false},[],true).settledTrades,null,'partial history is unknown, not zero');
 const unbound=ordering.map(row=>({...row,state:{...row.state,settlements:row.state.settlements!.map(e=>({...e,prevEventId:null}))}}));
 assert.equal(conductStanding(f.pks.seller,publicConductRecord(f.pks.seller,unbound,true),[],true).sellerSpeed,null,'no timing without a signed reference');
}
const empty=publicConductRecord(f.pks.seller,[],true);
assert.equal(conductStanding(f.pks.seller,empty,[],true).newHere,true);
assert.equal(conductStanding(f.pks.seller,{...empty,complete:false},[],true).newHere,false);
const bond={npub:f.pks.seller,address:'verified-address',funded:true,active:true,actualSats:100000n} as import('../bond-multisig/bond-announcement.js').VerifiedBond;
const bondProof={bond,fundedAtTime:100,tipTime:100+12*86400};
assert.deepEqual(conductStanding(f.pks.seller,empty,[bondProof,bondProof],true).bonded,{sats:'100000',days:12},'same bond advertised twice counts once');
assert.equal(conductStanding(f.pks.seller,empty,[{...bondProof,fundedAtTime:null}],true).bonded,null,'unknown funding time is not zero days');
console.log('PASS public standing: bounded signed speed, median minimum, ordering, unknown history, dated and deduplicated bonds, new-key distinction');
const arbitration=[30,180,300].map((delay,index)=>{
 const bv=f.event(Kind.VOTE,'buyer',{type:'escrow:vote',role:Role.BUYER,outcome:Outcome.RELEASE,votedAt:1});
 const sv=f.event(Kind.VOTE,'seller',{type:'escrow:vote',role:Role.SELLER,outcome:Outcome.REFUND,votedAt:1});
 const av=f.event(Kind.VOTE,'arbiter',{type:'escrow:vote',role:Role.ARBITER,outcome:Outcome.RELEASE,votedAt:1});
 av.timestamp=sv.timestamp+delay;av.prevEventId=sv.raw.id;
 return {state:{...completedState,id:`arb-${index}`,eventChain:[av,bv,sv]},spend:{txid,confirmed:true,leaf:'dispute' as const}};
});
assert.deepEqual(conductStanding(f.pks.arbiter,publicConductRecord(f.pks.arbiter,arbitration,true),[],true).arbiterSpeed,{medianSeconds:180,samples:3});
assert.deepEqual(conductStanding(f.pks.arbiter,publicConductRecord(f.pks.arbiter,[...arbitration].reverse(),true),[],true).arbiterSpeed,{medianSeconds:180,samples:3});

// "Public record not loaded yet" on Jet's Pixel: a busy arbiter's record was
// read one relay query per trade. Trades are now read in chunks, and a chunk
// the relay cut off falls back to one trade at a time.
{
 const { readPublicConductTrades } = await import('./public-conduct-read.js');
 const tradeId = f.state.id, seller = state!.participants[Role.SELLER]!;
 const decoys = Array.from({length:24},(_,i)=>finalizeEvent({kind:Kind.CHAT,created_at:1,tags:[['d',`other-${String(i).padStart(2,'0')}`],['p',seller]],content:''},identities.seller));
 const kinds=[...new Set([...events,...decoys].map(e=>e.kind))];
 const run = async (cutChunks:boolean) => {
  const filters:any[]=[];
  const query = async (filter:any) => {
   filters.push(filter);
   const pool=[...events,...decoys];
   const hits = filter.authors ? pool.filter(e=>filter.authors.includes(e.pubkey))
     : filter['#p'] ? pool.filter(e=>e.tags.some(t=>t[0]==='p'&&filter['#p'].includes(t[1])))
     : pool.filter(e=>e.tags.some(t=>t[0]==='d'&&filter['#d'].includes(t[1])));
   return {events:hits,complete:!(cutChunks && filter['#d']?.length>1)};
  };
  const read = await readPublicConductTrades(seller,kinds,query,async()=>({txid,confirmed:true,leaf:'coop' as const}) as any);
  return {read,filters};
 };
 const batched = await run(false);
 const dReads = batched.filters.filter(q=>q['#d']);
 assert.equal(dReads.length,3,'25 trades are three relay reads, not 25');
 assert.ok(dReads.every(q=>q['#d'].length<=10));
 assert.deepEqual(batched.read.trades.map(t=>t.state.id),[tradeId],'the on-chain trade is found among unrelated ids');
 assert.equal(batched.read.complete,false,'ids that do not replay keep the record incomplete, as before');
 const cut = await run(true);
 assert.equal(cut.filters.filter(q=>q['#d']?.length===1).length,25,'a cut-off chunk is re-read one trade at a time');
 assert.deepEqual(cut.read.trades.map(t=>t.state.id),[tradeId]);
 assert.deepEqual(cut.read.trades[0].state.eventChain.map(e=>e.raw.id),batched.read.trades[0].state.eventChain.map(e=>e.raw.id),'batched and per-trade reads replay the same chain');
 const failing = await readPublicConductTrades(seller,kinds,async(filter:any)=>{ if(filter['#d']) throw new Error('relay down'); return {events:[...events],complete:true}; },async()=>null);
 assert.deepEqual(failing.trades,[]); assert.equal(failing.complete,false,'a failed read is never a complete record');
 console.log('PASS public record: trades read in chunks, cut-off chunks re-read per trade, failures stay incomplete');
}

// 6.4.33 arbiter conduct facts (spec step 1): readers of the public record
// only, no rule change. Every fact is the same in either order of events.
{
 const arb=f.pks.arbiter;
 // The replay records who ruled; these fixtures are built by hand, so set it.
 const acted=arbitration.map(t=>({...t,state:{...t.state,actingArbiter:arb}}));
 const rec=(trades:any[],complete=true)=>publicConductRecord(arb,trades,complete);
 const s=(trades:any[],complete=true,tip:number|null=null,key=arb)=>conductStanding(key,publicConductRecord(key,trades,complete),[],true,tip);
 // F1 disputes decided, with how many people.
 assert.deepEqual(s(acted).arbiterDecided,{count:3,people:2,lastYear:null});
 assert.deepEqual(s([...acted].reverse()).arbiterDecided,s(acted).arbiterDecided,'order does not change the fact');
 assert.equal(s(acted,false).arbiterDecided,null,'incomplete history is unknown, never a count');
 const agreed={...acted[0],state:{...acted[0].state,id:'agreed',eventChain:acted[0].state.eventChain.map((e:any)=>e.pubkey===f.pks.seller?{...e,payload:{...e.payload,outcome:Outcome.RELEASE}}:e)}};
 assert.equal(s([agreed]).arbiterDecided,null,'an agreed trade is not a dispute');
 const early={...acted[0],state:{...acted[0].state,id:'early',eventChain:acted[0].state.eventChain.map((e:any)=>e.pubkey===arb?{...e,prevEventId:'not-the-dispute'}:e)}};
 assert.equal(s([early]).arbiterDecided,null,'a ruling that does not follow the dispute is not counted');
 // F5 last year, from the tip block time.
 const times=acted.map(t=>t.state.eventChain.find((e:any)=>e.pubkey===arb)!.timestamp).sort((a,b)=>a-b);
 const tip=times[0]+365*86400+1;
 assert.equal(s(acted,true,tip).arbiterDecided!.lastYear,times.filter(t=>t>=tip-365*86400).length);
 assert.equal(s(acted,true,times[2]).arbiterDecided!.lastYear,null,'no suffix when every ruling is within the year');
 // F4 ruled for the same person.
 assert.deepEqual(s(acted).arbiterSamePerson,{count:3,total:3});
 assert.equal(s(acted.slice(0,2)).arbiterSamePerson,null,'needs three rulings');
 // F2 a backup decided instead.
 const seatedKey='d'.repeat(64);
 const seatedElsewhere=acted.map(t=>({...t,state:{...t.state,participants:{...t.state.participants,arbiter:seatedKey}}}));
 assert.deepEqual(s(seatedElsewhere,true,null,seatedKey).arbiterBackedUp,{count:3,total:3});
 assert.equal(s(acted).arbiterBackedUp,null,'the seated arbiter who decided is not backed up');
 // A backup voted first but the seated arbiter's vote won on priority.
 const seatedWon=acted.map(t=>({...t,state:{...t.state,participants:{...t.state.participants,arbiter:seatedKey},actingArbiter:seatedKey}}));
 assert.equal(s(seatedWon,true,null,seatedKey).arbiterBackedUp,null,'the vote that counted decides, not the first one');
 assert.equal(s(acted.map(t=>({...t,state:{...t.state,actingArbiter:seatedKey}}))).arbiterDecided,null,'a vote that did not count is not a dispute decided');
 // F3 two opposite rulings, read from every signed vote.
 const ruling=acted[0].state.eventChain.find((e:any)=>e.pubkey===arb)!;
 const flip={...ruling,payload:{...ruling.payload,outcome:Outcome.REFUND},raw:{...ruling.raw,id:'flip'},prevEventId:ruling.raw.id,timestamp:ruling.timestamp+1};
 const withVotes=(votes:any[])=>[{...acted[0],votes}];
 assert.equal(s(withVotes([ruling])).arbiterTwoRulings,null);
 assert.equal(s(withVotes([ruling,{...ruling,raw:{...ruling.raw,id:'same'}}])).arbiterTwoRulings,null,'two votes with the same outcome are not opposite');
 assert.deepEqual(s(withVotes([ruling,flip])).arbiterTwoRulings,{count:1,partial:false});
 assert.deepEqual(s(withVotes([flip,ruling])).arbiterTwoRulings,{count:1,partial:false},'either order');
 assert.equal(s(withVotes([ruling,{...flip,pubkey:'e'.repeat(64)}])).arbiterTwoRulings,null,'two different keys are not one key ruling twice');
 assert.equal(s(withVotes([ruling,{...flip,prevEventId:'elsewhere'}])).arbiterTwoRulings,null,'a vote that is not part of this dispute does not count');
 assert.equal(s(withVotes([ruling,{...flip,prevEventId:ruling.prevEventId}])).arbiterTwoRulings,null,'a second device that never saw the first ruling is not marked');
 assert.equal(s([{...acted[0],state:{...acted[0].state,eventChain:acted[0].state.eventChain.filter((e:any)=>e.pubkey!==arb)},votes:[ruling,flip]}]).arbiterTwoRulings,null,'no accepted ruling, no mark');
 assert.deepEqual(s(withVotes([ruling,flip]),false).arbiterTwoRulings,{count:1,partial:true},'still shown on incomplete history, as "at least"');
 assert.equal(rec(withVotes([ruling,flip])).trades[0].state.votes[Role.ARBITER],acted[0].state.votes[Role.ARBITER],'the replayed state is untouched');
 // Signed path: forged votes never reach the facts; a refused second vote does, and the state is unchanged.
 const { replayPublicConductWithVotes } = await import('./public-conduct.js');
 const sellerVoteRaw=events.find(e=>e.kind===Kind.VOTE && e.pubkey===f.pks.seller)!;
 const second=finalizeEvent({kind:Kind.VOTE,created_at:sellerVoteRaw.created_at+5,tags:[['d',f.state.id],['t','escrow:vote'],['e',sellerVoteRaw.id,'','reply'],['conduct',JSON.stringify({type:'escrow:vote',outcome:Outcome.REFUND,role:Role.SELLER,votedAt:1})]],content:'{}'},identities.seller);
 const forged={...second,id:'f'.repeat(64)};
 const both=replayPublicConductWithVotes([...events,second,forged])!;
 assert.ok(both.votes.some(v=>v.raw.id===second.id),'a signed second vote is kept for the facts');
 assert.ok(!both.votes.some(v=>v.raw.id===forged.id),'a forged vote is dropped');
 assert.equal(both.state.votes[Role.SELLER],replayPublicConduct(events)!.votes[Role.SELLER],'the replay keeps the first vote');
 console.log('PASS arbiter conduct facts: decided, last year, same person, backed up, two opposite rulings; order-free, unknown when incomplete');
}
