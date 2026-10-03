import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
import { guidedListingAmount } from './guided-listing-amount.js';

// Seed the same quote the actual creation screens read, without network requests.
const values = new Map<string, string>([
  ['chama_btc_price_usd_v1', JSON.stringify({usd:100000, updatedAt:Date.now()})],
  ['chama_usd_fiat_rates_v1', JSON.stringify({rates:{USD:1}, updatedAt:Date.now()})],
]);
const storage = { getItem:(key:string)=>values.get(key) ?? null, setItem:(key:string,value:string)=>values.set(key,value), removeItem:(key:string)=>values.delete(key) };
Object.defineProperty(globalThis, 'localStorage', {configurable:true, value:storage});
// Cache loading is the only browser API used by server-rendered quote hooks.
Object.defineProperty(globalThis, 'window', {configurable:true, value:{localStorage:storage, dispatchEvent:()=>true}});
await import('../markets/bitcoin-price.js');
await import('../markets/fiat-rates.js');
delete (globalThis as any).window;
const { LangProvider } = await import('../i18n/index.js');
const { LiveTradeSurface } = await import('./screens/LiveTradeSurface.js');
const { AssistedCanvas } = await import('./screens/AssistedCanvas.js');
const { CircleCanvas } = await import('./screens/CircleCanvas.js');
const { circleCanvasRound } = await import('../chama/canvas.js');
const { PayoutDestinationsPanel } = await import('./panels/PayoutDestinationsPanel.js');
const { SavedWalletRow } = await import('./components/SavedWalletRow.js');
const { setLocalStorageUserScope } = await import('../storage/user-scope.js');
const { addOrTouchPayoutDestination, renamePayoutDestination, listPayoutDestinations, deletePayoutDestination } = await import('../payments/payout-destinations.js');
const { addOrTouchSavedNwcConnection } = await import('../payments/nwc-connections.js');
const { addSavedHandle } = await import('../payments/saved-handles.js');
const render = (element: React.ReactNode) => renderToStaticMarkup(<LangProvider>{element}</LangProvider>);
const seller='a'.repeat(64), viewer='b'.repeat(64), now=Math.floor(Date.now()/1000);
const state = {provenance:'chain',id:'range', category:'p2p-trade', status:EscrowStatus.CREATED, description:'Sats for sale',
 community:'us-usd', amountMsats:10_000_000, createdAt:now, expiresAt:now+86400,
 participants:{seller}, initiator:{pubkey:seller,role:Role.SELLER}, lock:{notesHash:null,lockedAt:null},
 votes:{}, chatMessages:[], eventChain:[], communityArbiters:[],
 items:[{id:'range',label:'Sats',kind:'exchange-bracket',amountMsats:10_000_000,minAmountMsats:500_000,maxAmountMsats:10_000_000}],
} as unknown as EscrowState;
assert.deepEqual(guidedListingAmount(state), {minMsats:500_000,maxMsats:10_000_000});
assert.deepEqual(guidedListingAmount(state,'2000'), {minMsats:2_000_000});
for (const invalid of ['0','499','10001','NaN','500.5']) assert.deepEqual(guidedListingAmount(state,invalid), guidedListingAmount(state));
const finalized = {...state,joinHolds:{buyer:{pubkey:viewer,amountMsats:3_000_000,orderFinalizedAt:now}}} as EscrowState;
assert.deepEqual(guidedListingAmount(finalized,'8000'), {minMsats:3_000_000}, 'committed order outranks a stale draft');
assert.deepEqual(guidedListingAmount({...state,status:EscrowStatus.LOCKED,amountMsats:4_000_000},'8000'), {minMsats:4_000_000});
const room = render(<LiveTradeSurface state={state} pubkey={viewer} onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} onJoin={async()=>{}} />);
assert.match(room, /500–10,000 sats/);
assert.match(room, /≈ 0.50–10.00 USD/);
const committedRoom = render(<LiveTradeSurface state={finalized} pubkey={viewer} onBack={()=>{}} onOpenFullView={()=>{}} onVote={async()=>{}} onSendChat={async()=>{}} />);
assert.match(committedRoom,/3,000 sats/); assert.doesNotMatch(committedRoom,/500–10,000 sats/);

for (const [bring,want,detail,terms] of [['sats','cash','3000',''],['goods','sats','A service','3000'],['bill','sats','3','electricity']] as const) {
 const summary=render(<AssistedCanvas listings={[]} browseCommunity="us-usd" viewerPubkey={seller} listingsLoading={false}
  onBrowse={()=>{}} onCreate={()=>{}} onMoreOptions={()=>{}} onOpenTrade={()=>{}} resumeRef={{current:{at:Date.now(),surface:'publish',bring,want,detail,terms,detailMax:bring === 'sats' ? '10000' : '',delivery:'service',paymentRails:['strike'],matches:[],goodsMatches:[],matchWhy:null,premiumBps:0,premiumMode:'preset',premiumInput:''}}} />);
 assert.match(summary,/≈.*3.00.*USD/, `${bring} publish summary uses the shared quote`);
}
const initial=circleCanvasRound({shareSats:3000,threshold:3,cap:3,durationSec:86400,createdAt:now,unlisted:true,creatorPubkey:seller,community:'us-usd',mintUrl:'https://mint.example',name:'Friends'});
assert.match(render(<CircleCanvas viewerPubkey={seller} community="us-usd" mintUrl="https://mint.example" initial={initial} onBack={()=>{}} onPublish={async()=>{}} />),/≈.*3.00.*USD/);

setLocalStorageUserScope(seller);
const address=addOrTouchPayoutDestination('test@example.com');
renamePayoutDestination(address.id,'Home wallet');
setLocalStorageUserScope(null);setLocalStorageUserScope(seller);
assert.equal(listPayoutDestinations()[0].label,'Home wallet','relaunch with the same identity preserves the name');
const connection=addOrTouchSavedNwcConnection(`nostr+walletconnect://${'c'.repeat(64)}?relay=wss%3A%2F%2Frelay.example&secret=${'d'.repeat(64)}`);
const manager=render(<PayoutDestinationsPanel onClose={()=>{}} />);
assert.match(manager,/Home wallet/);assert.match(manager,/nostr\+walletconnect/);assert.doesNotMatch(manager,/secret=|dddddddd/);
const picker=render(<SavedWalletRow label="Home wallet" detail="test@example.com" onSelect={()=>{}} onRename={()=>{}} onRemove={()=>{}} />);
assert.doesNotMatch(picker,/Rename|Remove/);assert.equal((picker.match(/<button/g)??[]).length,1);
deletePayoutDestination(address.id);
addSavedHandle('strike','test');
assert.deepEqual(listPayoutDestinations(),[],'a trade-time fiat handle save cannot resurrect a deleted payout destination');

console.log('PASS brief 6.4.19: range/committed summaries, creation quotes and isolated wallet management');
