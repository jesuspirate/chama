import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { decideChamaBarLabel } from './decisions.js';
import { ChamaBar } from './panels/ChamaBar.js';
import { LangProvider } from '../i18n/index.js';
import { MAIN_SURFACE_RECOVERY_MIN_SATS } from './decisions.js';
const base={balanceMsats:0,hasActiveBuyerSellerCommitment:false,myTradesLoading:true};
assert.equal(decideChamaBarLabel(base).kind,'syncing');
assert.equal(decideChamaBarLabel({...base,myTradesLoading:false}).kind,'ready');
const trade={...base,activeCommittedMsats:50_000_000};
const stranded={...trade,balanceMsats:MAIN_SURFACE_RECOVERY_MIN_SATS*1000};
const attention={...stranded,needsYouCount:1};
assert.equal(decideChamaBarLabel(trade).kind,'in-trade');
assert.equal(decideChamaBarLabel(stranded).kind,'stranded');
assert.equal(decideChamaBarLabel(attention).kind,'needs-you');
assert.equal(decideChamaBarLabel({...attention,bootProbeState:'failed'}).kind,'unreachable');
for(const joined of [true,false]) {
 const html=renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{joined} as any} chamaLabel={decideChamaBarLabel(base)} onTapStranded={()=>{}} onInit={()=>{}} showReconnect={false}/></LangProvider>);
 assert.match(html,/Syncing…/);assert.match(html,/chama-loader-vector/);assert.doesNotMatch(html,/color-cycle|Chama: ready/);
 const needs=renderToStaticMarkup(<LangProvider><ChamaBar fedimint={{joined} as any} chamaLabel={{kind:'needs-you',count:1}} onTapStranded={()=>{}} onInit={()=>{}} showReconnect={false}/></LangProvider>);
 assert.match(needs,/<button/);assert.doesNotMatch(needs,/chama-loader-vector/);
}
console.log('PASS bar priority: unreachable > needs-you > stranded > in-trade > syncing > ready; vector loader and attention without federation membership');
