import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../i18n/index.js';
import { MAINNET } from '../bond-multisig/multisig.js';
import { shortOnchainId, payoutStatusText } from '../escrow-engine/onchain-payout-text.js';
import { PayoutTransactionDetails } from './components/PayoutTransactionDetails.js';
import { CopyButton, copyTextRobust } from './components/CopyButton.js';
const txid='6d1f3a'+'b'.repeat(54)+'9c2e',deposit='90b36c'+'a'.repeat(54)+'5a8b';
assert.equal(shortOnchainId(txid),'6d1f3a…9c2e');
const element=PayoutTransactionDetails({txid,depositTxid:deposit,network:MAINNET});
const fragment=element.props.children[0];
const copy=fragment.props.children.find((child: any)=>child.type===CopyButton);
assert.equal(copy.props.value,txid,'Copy receives the full transaction id');
const html=renderToStaticMarkup(<LangProvider>{element}</LangProvider>);
assert.match(html,/Transaction 6d1f3a…9c2e/);assert.match(html,/Deposit 90b36c…5a8b/);
assert.ok(html.includes(`title="${txid}"`));assert.ok(html.includes(`/tx/${txid}`));assert.ok(html.includes(`/tx/${deposit}`));
let copied='';
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(value:string)=>{copied=value;}}}});
copyTextRobust(copy.props.value);assert.equal(copied,txid);
for(const confirmed of [false,true]) {
 const text=payoutStatusText({confirmed,txid,sats:'29838',destination:'bc1ql3'+'x'.repeat(20)+'xshj'});
 assert.ok(text.includes('Transaction 6d1f3a…9c2e'));
 assert.match(text,confirmed?/Payout confirmed · 29,838 sats to bc1ql3…xshj/:/Payout sent · waiting for confirmation/);
}
console.log('PASS payout transaction identity: first six/last four, full title and copy value, independent deposit link, confirmed and pending notification copy');
