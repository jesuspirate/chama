import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../i18n/index.js';
import { ClaimPayoutModal, type ClaimPayoutModalProps } from './panels/ClaimPayoutModal.js';
const props: ClaimPayoutModalProps={escrowId:'test',payoutMsats:100_000_000,savedDestinations:[],
  claimAndPayout:async()=>{throw Error('No payments in rendering tests');},confirmClaimEcashExport:async()=>{},probeFederation:async()=>({ok:true}),onClose:()=>{}};
const render=(extra:Partial<ClaimPayoutModalProps>)=>renderToStaticMarkup(<LangProvider><ClaimPayoutModal {...props} {...extra}/></LangProvider>);
for(const [community,currency,provider] of [['us-usd','USD','Strike'],['ke-kes','KES','Tando'],['tz-tzs','TZS','ChapSmart']]){
 const html=render({tradeCommunity:community,fiatCurrency:currency});
 assert.match(html,new RegExp(`Cash out in ${currency}`));
 assert.match(html,new RegExp(provider,'i'));
 assert.doesNotMatch(html,/<details|>Details</,'cash-out is not a disclosure');
}
const us=render({tradeCommunity:'us-usd',homeCommunity:'ke-kes'});
assert.match(us,/Cash out in USD/); assert.doesNotMatch(us,/Cash out in KES|M-Pesa/,'trade country wins over home');
const none=render({fiatCurrency:'JPY'}); assert.doesNotMatch(none,/Cash out in/,'no empty cash-out section');
const saved=render({fiatCurrency:'USD',savedDestinations:[{id:'wallet',address:'me@example.com',createdAt:0},{id:'strike',address:'me@strike.me',createdAt:0}],
 savedNwcConnections:[{id:'nwc',label:'My wallet',walletPubkey:'a'.repeat(64),relayCount:1,connectionString:'nostr+walletconnect://test',createdAt:0}]});
const wallets=saved.match(/<section aria-label="Your wallets"[\s\S]*?<\/section>/)?.[0]??'';
assert.match(wallets,/me@example.com/);assert.match(wallets,/My wallet/);assert.doesNotMatch(wallets,/strike.me/);
assert.match(saved,/<section aria-label="Cash out in USD"[\s\S]*?@me/);
const checking=render({fiatCurrency:'USD',getLightningGatewayCount:async()=>0});
assert.match(checking,/Cash out in USD/);assert.match(checking,/<button[^>]*disabled=""[^>]*>[\s\S]*?Strike/);
console.log('PASS claim cash-out sections: USD/KES/TZS, trade context, visible cards, saved wallets and unavailable gateway gate');
