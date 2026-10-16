import {deviceTimezoneCountry,timezoneMismatchCountry,timezoneNudgeSeen,markTimezoneNudgeSeen} from "../communities/timezone-nudge.js";
import {COUNTRY_ISO3} from "../communities/geography-data.js";
import {resolveJoiningCommunitySlug} from "../communities/joining-default.js";
import {setLastHomeHint,setUserCommunitySlug} from "../communities/storage.js";
import {setLocalStorageUserScope} from "../storage/user-scope.js";
import {getCommunityBySlug,DEFAULT_COMMUNITY_SLUG} from "../communities/registry.js";
import {resolveFederationForCommunity} from "../fedimint/federation-config.js";
import {WalletBalance} from "./screens/MeScreen.js";
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {LangProvider} from '../i18n/index.js';
import {TradeCard} from './components/TradeCard.js';
import {applyThemeMode} from './theme.js';
import {circleFixture,listing,viewer} from '../../tests/first-circle-phones/fixtures.js';
import {reconcileBrowseArrivals,scrollBrowseResults} from './browse-live.js';
import {markRecoveryKeyBackedUp,recoveryKeyBackedUp} from '../storage/recovery-key-backup.js';
import {SignOutConfirmModal} from './panels/SignOutConfirmModal.js';
import {RelayManager} from '../escrow-engine/relay-manager.js';
const data=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});
for(const theme of ['light','dark'] as const){
 applyThemeMode(theme);
 for(const [seat,label] of [['held','Seat held'],['locked','Locked ✓'],['collect','Collect now'],['claimed','Claimed ✓']] as const){
  const {parent,share}=circleFixture(seat);
  const html=renderToStaticMarkup(<LangProvider><TradeCard state={parent} allEscrows={[parent,share]} pubkey={viewer} onSelect={()=>{}} /></LangProvider>);
  assert.match(html,new RegExp(`data-circle-seat="${seat}"`));assert.match(html,new RegExp(label));
  assert.equal((html.match(/data-circle-seat=/g)??[]).length,1);
 }
}
const a=listing('a'),b=listing('b');
let result=reconcileBrowseArrivals(null,'all',[a],false);
result=reconcileBrowseArrivals(result.state,'all',[b,a],false);
assert.deepEqual(result.visible.map(l=>l.id),['a']);assert.deepEqual(result.pending.map(l=>l.id),['b']);
result=reconcileBrowseArrivals(result.state,'all',[b,b,a],false);assert.equal(result.pending.length,1,'relay redelivery deduplicates CREATE id');
result=reconcileBrowseArrivals(result.state,'all',[b,a],true);assert.deepEqual(result.visible.map(l=>l.id),['b','a']);
assert.equal(reconcileBrowseArrivals(result.state,'circle',[a],false).pending.length,0,'filter tap opens existing results immediately');
assert.equal(reconcileBrowseArrivals(result.state,'all',[a],false).visible.length,1,'withdrawn listing disappears');
const scrolls:unknown[]=[];
const target=(top:number)=>({getBoundingClientRect:()=>({top}),closest:()=>null,scrollIntoView:(opts:unknown)=>scrolls.push(opts)}) as any;
Object.defineProperty(globalThis,'window',{configurable:true,value:{innerHeight:844,matchMedia:()=>({matches:false}),dispatchEvent:()=>true}});
scrollBrowseResults(target(100));assert.equal(scrolls.length,0);
scrollBrowseResults(target(900));assert.deepEqual(scrolls.pop(),{block:'start',behavior:'smooth'});
(window as any).matchMedia=()=>({matches:true});scrollBrowseResults(target(900));assert.deepEqual(scrolls.pop(),{block:'start',behavior:'auto'});
assert.equal(recoveryKeyBackedUp(viewer),false);markRecoveryKeyBackedUp(viewer);assert.equal(recoveryKeyBackedUp(viewer.toUpperCase()),true);assert.equal(recoveryKeyBackedUp('b'.repeat(64)),false);
assert.deepEqual([...data.values()],['1'],'receipt contains no secret');
delete (globalThis as any).window;
const html=renderToStaticMarkup(<LangProvider><SignOutConfirmModal pubkey={viewer} onCancel={()=>{}} onConfirm={()=>{}} /></LangProvider>);
assert.match(html,/Your key is safe. See you soon./);assert.doesNotMatch(html,/Saved ✓|before you go/i);assert.doesNotMatch(html,/data-recovery-key|Reading your key/);
const relay = new RelayManager([],{});
const filters:unknown[]=[];(relay as any).subscribe=(f:unknown)=>{filters.push(f);return 'scope';};
relay.subscribeToBrowseListings({community:'us-usd',category:'chama'});
assert.deepEqual((filters[0] as any).kinds,[38100]);assert.deepEqual((filters[0] as any)['#community'],['us-usd']);assert.deepEqual((filters[0] as any)['#cat'],['chama']);


const unknownBalance=renderToStaticMarkup(<LangProvider><WalletBalance balanceMsats={0} known={false}/></LangProvider>);
assert.match(unknownBalance,/In your Chama wallet: —/);

console.log('PASS 6.4.22: four seat chips/light+dark, arrival buffering/deduplication, scrolling/reduced motion, per-identity backup receipts, scoped discovery');

// The card and setup share a single default; neither steals another identity's home.
data.clear();setLocalStorageUserScope(null);
assert.equal(resolveJoiningCommunitySlug(['en-US']),'us-blf');
assert.equal(resolveJoiningCommunitySlug(['en','invalid-ZZ']),DEFAULT_COMMUNITY_SLUG);
assert.equal(resolveJoiningCommunitySlug(['fr-u-ca-gregory']),DEFAULT_COMMUNITY_SLUG,'locale extensions are not country regions');
assert.equal(getCommunityBySlug(resolveJoiningCommunitySlug(['zh-Hant-TW']))?.country,'TW');
const kenya=resolveJoiningCommunitySlug(['sw-KE']);
assert.equal(getCommunityBySlug(kenya)?.country,'KE');
assert.equal(resolveFederationForCommunity(kenya),getCommunityBySlug(kenya)?.federationInvite);
setLastHomeHint('us-blf');
assert.equal(resolveJoiningCommunitySlug(['sw-KE']),'us-blf','displayed last community beats locale');
setLocalStorageUserScope('returning');setUserCommunitySlug(kenya);
setLastHomeHint('us-blf');
assert.equal(resolveJoiningCommunitySlug(['en-US']),kenya,'existing scoped home beats browser hint');
setLocalStorageUserScope('fresh');
assert.equal(resolveJoiningCommunitySlug(['sw-KE']),'us-blf','fresh identity sees card default');
assert.equal(data.has('chama_community:fresh'),false,'default resolution does not commit an identity');
assert.equal(data.get('chama_community:returning'),kenya,'another identity retains its home');
setLocalStorageUserScope(null);data.clear();
console.log('PASS joining defaults: locale/fallback, last community, scoped home, pinned federation, no implicit identity write');

assert.equal(deviceTimezoneCountry('Africa/Nairobi'),'KE');
assert.equal(deviceTimezoneCountry('Asia/Calcutta'),'IN','browser alias resolves');
assert.equal(deviceTimezoneCountry('UTC'),null,'generic timezones imply no location');
assert.equal(timezoneMismatchCountry('us-blf','Africa/Nairobi'),'KE');
assert.equal(timezoneMismatchCountry('ke-kes','Africa/Nairobi'),null);
assert.equal(timezoneMismatchCountry('us-blf','America/New_York'),null);
assert.equal(timezoneMismatchCountry('missing-chama','Africa/Nairobi'),null);
assert.equal(timezoneNudgeSeen('us-blf'),false);markTimezoneNudgeSeen('us-blf');
assert.equal(timezoneNudgeSeen('us-blf'),true);assert.equal(timezoneNudgeSeen('ke-kes'),false);
assert.equal(data.get('chama_timezone_nudge_v1:us-blf'),'1','browser-wide, no identity or location stored');
assert.equal(COUNTRY_ISO3.KE,'KEN');assert.equal(COUNTRY_ISO3.US,'USA');
console.log('PASS M timezone nudge: Nairobi mismatch, matching/unknown silence, aliases, browser-per-chama memory, ISO-3');
