import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import * as btc from '@scure/btc-signer';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { BrowseView } from './screens/BrowseView.js';
import { LangProvider } from '../i18n/index.js';
import { setLocalStorageUserScope, setScopedStorageItem } from '../storage/user-scope.js';
const f=safetyFixture({buyer:btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),seller:btc.utils.pubSchnorr(new Uint8Array(32).fill(12)),arbiter:btc.utils.pubSchnorr(new Uint8Array(32).fill(13))},2_000_000);
const store={...f.state,id:'store',category:'marketplace',description:'Store offer',fiatAmount:1,fiatCurrency:'USD',createdAt:100};
const exchange={...f.state,id:'exchange',category:'p2p-trade',description:'Exchange offer',fiatAmount:3,fiatCurrency:'USD',createdAt:300};
const bill={...f.state,id:'bill',category:'bill-pay',description:'Bill offer',fiatAmount:2,fiatCurrency:'USD',createdAt:200};
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),data=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});
try {
 setLocalStorageUserScope('viewer');
 const render=()=>renderToStaticMarkup(<LangProvider><BrowseView browseCategory="all" setBrowseCategory={()=>{}} browseCommunity="us-usd" amountDisplayMode="sats"
 matchingListings={[exchange,store]} nonMatchingListings={[bill]} pubkey={'f'.repeat(64)} fedimintJoined={true} listingsLoading={false} isFirstTime={false}
 onPasteCustomInvite={()=>{}} onOpenEscrow={()=>{}} onLoadById={()=>{}} onCreate={()=>{}} onApplyAsArbiter={async()=>{}} /></LangProvider>);
 setScopedStorageItem('chama_browse_scope_v2','all');
 assert.doesNotMatch(render(),/data-browse-order=/,'unsaved default keeps groups');
 for(const [order,expected] of [['cheapest',['store','bill','exchange']],['newest',['exchange','bill','store']]] as const){
  setScopedStorageItem('chama_browse_sort_v2',order);
  const html=render();
  assert.deepEqual([...html.matchAll(/data-listing-id="([^"]+)"/g)].map(m=>m[1]),expected,'one card per vertical still reorders across routes');
  for(const badge of ['Store','Exchange','Bill']) assert.match(html,new RegExp(badge),'card keeps its vertical identity');
 }
 setScopedStorageItem('chama_browse_scope_v2','local');
 assert.deepEqual([...render().matchAll(/data-listing-id="([^"]+)"/g)].map(m=>m[1]),['exchange','store'],'sort respects local filter');
 setScopedStorageItem('chama_browse_sort_v2','default');assert.doesNotMatch(render(),/data-browse-order=/,'default restores grouping');
 setLocalStorageUserScope('other-user');assert.doesNotMatch(render(),/data-browse-order=/,'sort does not bleed across identities');
} finally {setLocalStorageUserScope(null);if(original)Object.defineProperty(globalThis,'localStorage',original);else delete (globalThis as any).localStorage;}
console.log('PASS classic Browse: cross-category/cross-route cheapest and newest, badges, local filter, grouped default, per-user preference');
