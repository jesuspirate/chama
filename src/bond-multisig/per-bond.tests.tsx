import { PER_BOND_ANNOUNCEMENT_WRITER_ENABLED } from '../escrow-engine/experimental-escrow-features.js';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildCommitmentBond, deriveBondSigningKey } from './commitment-bond.js';
import { MAINNET } from './multisig.js';
import { buildBondAnnouncementEvent, selectLatestAnnouncements, groupLatestAnnouncementsByCommunity, verifyBondAnnouncement, readCommunityBondEvents } from './bond-announcement.js';
import { recoverOwnedBonds, findOwnedBond, mergeManageBonds } from './bond-recovery.js';
import { mergeDashboardBonds } from './dashboard-bonds.js';
import { computeChamaLiveness, bondedArbitersForCommunity } from '../arbiters/live-chama.js';
import { getExistingSeed } from '../fedimint/seed-manager.js';
import { BondList, BondRecoveryNotice } from '../ui/panels/BondCeremonyModal.js';
import { LangProvider } from '../i18n/index.js';
import type { CommitmentRecord } from './commitment-store.js';
const data = new Map<string,string>();
Object.defineProperty(globalThis, 'localStorage', { configurable:true, value:{ getItem:(k:string)=>data.get(k)??null, setItem:(k:string,v:string)=>data.set(k,v), removeItem:(k:string)=>data.delete(k) } });
const words = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const sk = new Uint8Array(32).fill(81), npub = getPublicKey(sk), community = 'global-usd', tip = 800_000;
const bonds = [0,1].map(index => buildCommitmentBond(deriveBondSigningKey(words,{network:MAINNET,index}).xonly,tip+1000,MAINNET));
const events = bonds.map((bond,index) => finalizeEvent(buildBondAnnouncementEvent({ pubkey:npub,community,
  ownerXonly:bond.ownerXonly,lockUntil:bond.lockUntil,amountSats:BigInt(10_000*(index+1)),network:MAINNET,
  address:bond.address,createdAt:1000+index }, { perBondWriterEnabled: true }),sk));
assert.equal(PER_BOND_ANNOUNCEMENT_WRITER_ENABLED, false, '.22 must remain a legacy writer until the fleet probe passes');
const legacyWrites = bonds.map(bond => buildBondAnnouncementEvent({ pubkey: npub, community,
  ownerXonly: bond.ownerXonly, lockUntil: bond.lockUntil, amountSats: 10_000n,
  network: MAINNET, address: bond.address }));
assert(legacyWrites.every(event => event.tags.some(tag => tag[0] === 'd' && tag[1] === community)), 'all default writers keep d=community');
assert(legacyWrites.every(event => event.tags.some(tag => tag[0] === 'c' && tag[1] === community)), 'community discovery tag survives either writer mode');
assert.equal(selectLatestAnnouncements(events).length, 2, 'default-off writer does not gate per-bond readers');
assert.notEqual(events[0].tags.find(t=>t[0]==='d')?.[1],events[1].tags.find(t=>t[0]==='d')?.[1]);
assert.equal(events[0].tags.find(t=>t[0]==='d')?.[1],bonds[0].address);
const legacy = finalizeEvent({ ...buildBondAnnouncementEvent({pubkey:npub,community,ownerXonly:bonds[0].ownerXonly,
  lockUntil:bonds[0].lockUntil,amountSats:10_000n,network:MAINNET,address:bonds[0].address,createdAt:900}),
  tags:[['d',community]] },sk); // oldest clients need no c tag
const queries: string[]=[];
const fetched=await readCommunityBondEvents(community,async filter=>{
  if ('#c' in filter) {queries.push('c');return events;}
  queries.push('d');return [legacy];
});
assert.deepEqual(queries.sort(),['c','d']);
assert.equal(selectLatestAnnouncements(fetched).length,2);
assert.equal(selectLatestAnnouncements([legacy]).length,1,'legacy community-addressed event stays valid');
assert.equal(groupLatestAnnouncementsByCommunity(fetched).get(community)?.length,2);
assert.deepEqual(selectLatestAnnouncements(fetched).map(a=>a.eventId),selectLatestAnnouncements([...fetched].reverse()).map(a=>a.eventId));
const funding=new Map(bonds.map((b,i)=>[b.address,{txid:String(i+1).repeat(64),index:0,amountSats:BigInt(10_000*(i+1))}]));
const fetchJson=async(path:string):Promise<any>=>{
  if(path==='/blocks/tip/height')return tip;
  for (const [i,b] of bonds.entries()) {
    const u=funding.get(b.address)!;
    if(path===`/address/${b.address}/utxo`)return [{txid:u.txid,vout:0,value:Number(u.amountSats),status:{confirmed:true,block_height:tip-10}}];
    if(path===`/tx/${u.txid}`)return {vout:[{scriptpubkey:bytesToHex(b.script)}]};
  }
  if(path.endsWith('/utxo'))return [];
  throw Error('Unexpected chain read '+path);
};
const verified=(await Promise.all(selectLatestAnnouncements(fetched).map(a=>verifyBondAnnouncement(a,{network:MAINNET,fetchJson,tipHeight:tip})))).map(v=>{assert(v);return v;});
assert(verified.every(b=>b.funded&&b.active));
assert.equal(mergeDashboardBonds([],verified,npub).length,2);
const live=computeChamaLiveness(community,[...verified,...verified],new Map([[npub,{count:2,positive:2,negative:0}]]),tip);
assert.equal(live.totalBondSats,30_000n);assert.equal(live.arbiterCount,1);assert.equal(live.ratings.count,2);
assert.equal(bondedArbitersForCommunity(verified).length,1,'second bond does not invent a second arbiter');
const records:CommitmentRecord[]=[];
const deps={network:MAINNET,seed:async()=>words.split(' '),readUtxos:async(address:string)=>funding.has(address)?[funding.get(address)!]:[],save:(rec:CommitmentRecord)=>records.push(rec)};
const recovered=await recoverOwnedBonds(selectLatestAnnouncements(fetched),[],deps);
assert.equal(recovered.recovered,2);assert.deepEqual(recovered.issues,[]);
assert.equal(mergeManageBonds(records,verified).length,2,'local/recovered/public sources produce one row each');
assert.equal((await recoverOwnedBonds(selectLatestAnnouncements(fetched),records,deps)).recovered,0);
const locked=await recoverOwnedBonds(selectLatestAnnouncements(fetched),[],{...deps,seed:async()=>{throw Error('Your wallet seed is locked. Unlock it, then Retry.');}});
assert.equal(locked.recovered,0);assert.match(locked.issues[0].reason,/seed is locked/);
const html=renderToStaticMarkup(<LangProvider><BondRecoveryNotice issues={locked.issues.map(i=>i.reason)} onRetry={()=>{}}/><BondList bonds={[]} verified={verified} tip={tip} onOpen={()=>{}} onPostNew={()=>{}}/></LangProvider>);
assert.match(html,/seed is locked/);assert.match(html,/Retry/);assert.doesNotMatch(html,/No live bond|Post a new bond|Create a bond/);
assert.equal((html.match(/data-announced-bond=/g)??[]).length,2);
const missingKey=await recoverOwnedBonds(selectLatestAnnouncements(fetched).slice(0,1),[],{...deps,seed:async()=> 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(' ')});
assert.match(missingKey.issues[0].reason,/key was not found/);
const chainFailure=await recoverOwnedBonds(selectLatestAnnouncements(fetched),[],{...deps,readUtxos:async()=>{throw Error('Explorer unavailable');}});
assert.equal(chainFailure.issues.length,2);assert.match(chainFailure.issues[0].reason,/Explorer unavailable/);
const found=await findOwnedBond(bonds[0].address,bonds[0].lockUntil,[],deps,2);
assert.equal(found.keyIndex,0);assert.equal(found.bond.address,bonds[0].address);
await assert.rejects(findOwnedBond(bonds[0].address,bonds[0].lockUntil+1,[],deps,2),/not found/);
await assert.rejects(findOwnedBond(bonds[0].address,bonds[0].lockUntil,[],{...deps,readUtxos:async()=>[]},2),/no confirmed funds/);
let seedQueries=0, decrypts=0, publishes=0;
await assert.rejects(getExistingSeed({queryOnce:async()=>{seedQueries++;return [];},publishRaw:async()=>{publishes++;}} as any,
  {getPublicKey:async()=>npub,requiresUserAction:true,nip44Decrypt:async()=>{decrypts++;return words;}} as any),/Unlock your wallet seed/);
assert.equal(seedQueries,0);assert.equal(decrypts,0);assert.equal(publishes,0,'background bond recovery cannot prompt or create a replacement seed');
console.log('PASS per-bond announcements: dual readers, two bonds in one community, summed deposits/distinct people, union rows, locked seed and Retry, key-index/read failures, explicit historical lookup and recovery-only seed gate');
