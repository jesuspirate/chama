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
const foreign={...exchange,id:'foreign-eur',description:'EUR foreign offer',fiatCurrency:'EUR'};
const bill={...f.state,id:'bill',category:'bill-pay',description:'Bill offer',fiatAmount:2,fiatCurrency:'USD',createdAt:200};
const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage'),data=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,v),removeItem:(k:string)=>data.delete(k)}});
try {
 setLocalStorageUserScope('viewer');
 const render=(local=[exchange,store], category="all")=>renderToStaticMarkup(<LangProvider><BrowseView browseCategory={category} setBrowseCategory={()=>{}} browseCommunity="us-usd" amountDisplayMode="sats"
 matchingListings={local} nonMatchingListings={[bill,foreign]} pubkey={'f'.repeat(64)} fedimintJoined={true} listingsLoading={false} isFirstTime={false}
 onPasteCustomInvite={()=>{}} onOpenEscrow={()=>{}} onLoadById={()=>{}} onCreate={()=>{}} onApplyAsArbiter={async()=>{}} /></LangProvider>);
 setScopedStorageItem('chama_browse_scope_v2','all');
 assert.doesNotMatch(render(),/data-browse-order=/,'unsaved default keeps groups');
 assert.doesNotMatch(render(), /data-listing-id="foreign-eur"/, 'All scope retains the viewer currency');
 assert.match(render(), /Other currencies · 1/);
 for(const [order,expected] of [['cheapest',['store','bill','exchange']],['newest',['exchange','bill','store']]] as const){
  setScopedStorageItem('chama_browse_sort_v2',order);
  const html=render();
  assert.deepEqual([...html.matchAll(/data-listing-id="([^"]+)"/g)].map(m=>m[1]),expected,'one card per vertical still reorders across routes');
  for(const badge of ['Store','Exchange','Bill']) assert.match(html,new RegExp(badge),'card keeps its vertical identity');
 }
 const allChips = render();
 assert.match(allChips, /data-browse-category="bill-pay" data-count="1"/);
 setScopedStorageItem('chama_browse_scope_v2','local');
 assert.deepEqual([...render().matchAll(/data-listing-id="([^"]+)"/g)].map(m=>m[1]),['exchange','store'],'sort respects local filter');
 const localChips = render();
 assert.match(localChips, /data-browse-category="bill-pay" data-count="0"/);
 assert.match(localChips, /data-browse-category="mine" data-count="0"/);
 assert.match(localChips, /data-browse-category="marketplace" data-count="1"/);
 assert.match(localChips, /data-browse-category="p2p-trade" data-count="1"/);
 const mine = {...store,id:'mine',participants:{...store.participants,seller:'f'.repeat(64)}};
 const withMine = render([exchange,store,mine]);
 const chipSum = [...withMine.matchAll(/data-browse-category="[^"]+" data-count="(\d+)"/g)].reduce((sum,m)=>sum+Number(m[1]),0);
 assert.equal(chipSum,3,'Mine and public verticals partition My Chama listings');
 assert.match(withMine,/data-browse-category="mine" data-count="1"/);
 const selectedShelf = render([exchange,store], 'marketplace');
 assert.match(selectedShelf,/data-browse-category="p2p-trade" data-count="1"/,'selected category never changes the sibling shelf count');
 assert.deepEqual([...selectedShelf.matchAll(/data-listing-id="([^"]+)"/g)].map(m=>m[1]),['store']);
 setScopedStorageItem('chama_browse_sort_v2','default');assert.doesNotMatch(render(),/data-browse-order=/,'default restores grouping');
 setLocalStorageUserScope('other-user');assert.doesNotMatch(render(),/data-browse-order=/,'sort does not bleed across identities');
} finally {setLocalStorageUserScope(null);if(original)Object.defineProperty(globalThis,'localStorage',original);else delete (globalThis as any).localStorage;}
console.log('PASS classic Browse: cross-category/cross-route cheapest and newest, badges, local filter, grouped default, per-user preference');

const { filterListingsByCurrency } = await import('./listing-currency.js');
assert.deepEqual(filterListingsByCurrency([exchange, foreign] as any, 'USD').map(l => l.id), ['exchange']);
assert.deepEqual(filterListingsByCurrency([exchange, foreign] as any, 'USD', true).map(l => l.id), ['foreign-eur']);
assert.equal(filterListingsByCurrency([{...foreign,fiatCurrency:undefined,community:'ke-kes'}] as any,'USD').length, 0, 'premium quotes cannot be relabeled with viewer currency');

