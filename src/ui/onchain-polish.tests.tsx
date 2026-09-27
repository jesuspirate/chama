import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { OnchainEscrowPanel } from './panels/OnchainEscrowPanel.js';
import { prepareFundingOnce } from './panels/OnchainTradeControls.js';
import { FundingModalShell } from './components/FundingModalShell.js';
import { LangProvider } from '../i18n/index.js';
import type { OnchainEscrowView } from '../escrow-engine/onchain-escrow-view.js';
const view = { stage:'awaiting-funding', address:'bc1p'+'a'.repeat(58), expectedSats:28000n, viewerFunds:true, blockers:[] } as unknown as OnchainEscrowView;
const render = (viewerFunds:boolean, note?:string) => renderToStaticMarkup(<LangProvider><FundingModalShell onClose={()=>{}}><OnchainEscrowPanel view={{...view,viewerFunds}} network="mainnet" checking onCheckFunding={()=>{}} fundingNote={note} /></FundingModalShell></LangProvider>);
const html = render(true, 'Couldn’t check the deposit yet — retrying');
assert.match(html,/Send 28,000 sats to this address/);
assert.match(html,/funding-check-spinner/);
assert.match(html,/Why this address is safe/);
assert.ok(html.includes(view.address!),'copy retains the full locally verified address during failure');
assert.match(html,/Couldn’t check the deposit yet/);
assert.doesNotMatch(html,/Prepare deposit address/);
assert.doesNotMatch(render(false),/class="funding-check-spinner"/,'read-only viewer has no check button');
let calls=0; let finish!:()=>void;
const prepare=()=>{calls++;return new Promise<void>(resolve=>{finish=resolve;});};
const first=prepareFundingOnce('trade',prepare), second=prepareFundingOnce('trade',prepare);
await Promise.resolve(); assert.equal(calls,1); finish(); await Promise.all([first,second]);
await assert.rejects(prepareFundingOnce('trade',async()=>{throw Error('offline');}));
await prepareFundingOnce('trade',async()=>{calls++;}); assert.equal(calls,2,'manual retry works after failure');
console.log('PASS on-chain funding card: shared shell, address survives timeout, read-only mode, deduplicated preparation and retry');

import { tradeRoomPresence } from './decisions.js';
import { displayedTradeArbiter } from '../arbiters/trade-arbiter.js';
import { EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
const arbiter='c'.repeat(64), buyer='b'.repeat(64), seller='a'.repeat(64);
const state={id:'assignment', status:EscrowStatus.CREATED, category:'p2p-trade', participants:{buyer,seller,arbiter:null}, communityArbiters:[arbiter], bondedArbiters:[arbiter], eventChain:[],chatMessages:[]} as unknown as EscrowState;
const presence=()=>tradeRoomPresence(state,seller,123,[Role.ARBITER])[0];
assert.equal(presence().pubkey,displayedTradeArbiter(state));
assert.equal(presence().signal,'assigned'); assert.equal(presence().ready,false);
state.participants.arbiter=arbiter;
assert.equal(presence().signal,'seated');
state.participants.arbiter=null;state.communityArbiters=[];state.bondedArbiters=[];
assert.equal(presence().signal,'empty');
console.log('PASS assigned arbiter matches record, is not ready, becomes seated, and empty pool stays open');

import { translate, LANGS } from '../i18n/index.js';
for (const lang of LANGS) {
  const one=translate(lang,'trade.bondedForDaysOne',{count:1});
  const many=translate(lang,'trade.bondedForDaysMany',{count:2});
  assert.ok(one.includes('1') && many.includes('2'));
  assert.ok(!one.includes('trade.') && !many.includes('trade.'));
  if (lang==='en') {assert.equal(one,'bonded 1 day');assert.equal(many,'bonded 2 days');}
  if (lang==='fr') {assert.match(one,/1 jour$/);assert.match(many,/2 jours$/);}
  if (lang==='es') {assert.match(one,/1 día$/);assert.match(many,/2 días$/);}
  assert.ok(translate(lang,'trade.bondedAmountDaysOne',{amount:'100,000',count:1}).includes('100,000'));
}
console.log('PASS bond day plurals in English, French, Spanish and Swahili');
