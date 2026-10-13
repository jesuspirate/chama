import { ConductFactLines } from "./components/ConductFacts.js";
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

const conductHtml=renderToStaticMarkup(<ConductFactLines record={{marks:2,complete:true,trades:[],standing:{sellerSpeed:{medianSeconds:120,samples:3},arbiterSpeed:null,settledTrades:3,bonded:{sats:'100000',days:12},newHere:false}}} />);
assert.ok(conductHtml.indexOf('Made a buyer wait')<conductHtml.indexOf('Signs within'));
assert.match(conductHtml,/median of 3/);assert.match(conductHtml,/Bonded 100,000 sats for 12 days/);assert.match(conductHtml,/3 trades settled on chain/);
assert.equal(renderToStaticMarkup(<ConductFactLines record={{marks:0,complete:false,trades:[]}} />), '');
assert.equal(renderToStaticMarkup(<ConductFactLines record={{marks:0,complete:true,trades:[]}} />), '');
assert.match(renderToStaticMarkup(<ConductFactLines record={{marks:0,complete:false,trades:[]}} showEmpty />), /No public history yet/);

// Rendering a quote must never request an invoice or dispatch a claim.
const { ClaimMethodChooser } = await import('./panels/ClaimPayoutModal.js');
const { DestinationPicker } = await import('./components/DestinationPicker.js');
const unexpected = () => { throw new Error('Rendering dispatched a payment'); };
const chooserHtml = renderToStaticMarkup(<LangProvider><ClaimMethodChooser
  payoutSats={196} ecashPayoutSats={200} externalSwaps={[]} tandoEligible={false}
  chapsmartEligible={false} strikeEligible={false} savedStrikeDestinations={[]}
  savedWalletDestinations={[]} savedNwcConnections={[]} cashOutCurrency="USD"
  onSelect={unexpected} onSelectEcash={unexpected} onSelectSavedStrike={unexpected}
  onSelectSavedWallet={unexpected} onSelectSavedNwc={unexpected} onCancel={unexpected}
/></LangProvider>);
assert.match(chooserHtml, /See all Lightning options/);
assert.doesNotMatch(chooserHtml, /LN · fast|onchain · slow/i);
const destinationHtml = renderToStaticMarkup(<LangProvider><DestinationPicker amountSats={196}
  initialAddress="bitcrazy@getalby.com" savedDestinations={[]} savedNwcConnections={[]}
  title="Claim" onResolve={unexpected} onCancel={unexpected} /></LangProvider>);
assert.match(destinationHtml, /Send 196 sats to bitcrazy@getalby.com/);
assert.match(destinationHtml, /Save this address for next time/);
assert.doesNotMatch(destinationHtml, /Send once/, 'one send action plus a save box, not two competing holds');
console.log('PASS claim action labels: net payout and destination, explicit saving, no render-time dispatch');

const lnurlHtml = renderToStaticMarkup(<LangProvider><DestinationPicker amountSats={196}
  initialAddress="lnurl1dp68gurn8ghj7urgdajku6tc9eshqup0d3h82unvwqhkzmrfvdjsr5eqhc"
  savedDestinations={[]} savedNwcConnections={[]} title="Claim" onResolve={unexpected} onCancel={unexpected} /></LangProvider>);
assert.match(lnurlHtml, /Send 196 sats to lnurl1dp6…qhc/);

const holdDestinationHtml = renderToStaticMarkup(<LangProvider><DestinationPicker holdToSend amountSats={196}
  initialAddress="bitcrazy@getalby.com" savedDestinations={[]} savedNwcConnections={[]}
  title="Claim" onResolve={unexpected} onCancel={unexpected} /></LangProvider>);
assert.match(holdDestinationHtml, /to bitcrazy@getalby.com/);
assert.match(holdDestinationHtml, /Hold to send 196 sats/);
assert.doesNotMatch(holdDestinationHtml, /Send 196 sats to/);

const { ClaimHoldDestination } = await import('./panels/ClaimPayoutModal.js');
const walletLineHtml = renderToStaticMarkup(<LangProvider><ClaimHoldDestination destination="My Alby wallet" /></LangProvider>);
assert.match(walletLineHtml, /to My Alby wallet/);
assert.match(walletLineHtml, /font-size:var\(--chama-fs-body\)/);
const subtitleForDestination = (known: boolean) => known ? 'Fee reserve' : 'to your Lightning wallet. Fee reserve';
const pickerSubtitle = (initialAddress: string) => renderToStaticMarkup(<LangProvider><DestinationPicker holdToSend amountSats={196}
  initialAddress={initialAddress} savedDestinations={[]} savedNwcConnections={[]}
  title="Claim" subtitle={subtitleForDestination} onResolve={unexpected} onCancel={unexpected} /></LangProvider>);
assert.doesNotMatch(pickerSubtitle('bitcrazy@getalby.com'), /to your Lightning wallet/);
assert.match(pickerSubtitle(''), /to your Lightning wallet/);

const { missingWebCrypto, cameraUnavailableReason } = await import('./browser-capability-copy.js');
assert.equal(cameraUnavailableReason(false, undefined), 'https');
assert.equal(cameraUnavailableReason(true, undefined), 'unavailable');
assert.equal(cameraUnavailableReason(true, { getUserMedia: async () => ({}) as MediaStream }), null);
assert.equal(missingWebCrypto('Web Crypto API (crypto.subtle) is required for hashNotes but is unavailable in this environment.'), true);
assert.equal(missingWebCrypto('Could not rebuild notes from release keys'), false);
const { Toast } = await import('./components/Toast.js');
const capabilityToast = renderToStaticMarkup(<LangProvider><Toast type="error" onDone={() => {}} message="Web Crypto API (crypto.subtle) is required for hashNotes but is unavailable in this environment." /></LangProvider>);
assert.match(capabilityToast, /needs HTTPS to claim/);
assert.doesNotMatch(capabilityToast, /vote again|border-radius:999px/);
assert.match(capabilityToast, /max-width:min\(520px/);
