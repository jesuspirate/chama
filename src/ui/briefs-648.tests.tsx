import { fundingPremiumMsats } from "../payments/funding-premium.js";
import { WalletBalance } from "./screens/MeScreen.js";
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { EscrowStatus, Role, JOIN_HOLD_LOCK_GRACE_SECONDS, type EscrowState } from '../escrow-engine/types.js';
import { effectiveViewerRole, spendableBalanceMsats, canLockFromBalance } from './decisions.js';
import { errorText } from '../payments/error-text.js';
import { lockFromBalance } from '../payments/lock-from-balance.js';
import { canRenewListing, canManuallyRenewListing, sessionAllowsAutoRenew } from '../escrow-engine/listing-renewal.js';
import { hasMissedBuyerLock, markMissedLock, isRenewalPaused, markManuallyKept } from '../escrow-engine/listing-renewal-age.js';
import { listingIdentityKey } from '../escrow-engine/listing-renewal-ledger.js';
import { AtomicFundingModal, DepositProgressLine, FundingCheckout } from './panels/AtomicFundingModal.js';
import { nativeLockEarmarks, PENDING_NATIVE_LOCKS_KEY } from '../fedimint/pending-native-locks.js';
import { setLocalStorageUserScope, scopedStorageKey } from '../storage/user-scope.js';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
 getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => values.set(k,v), removeItem: (k: string) => values.delete(k),
}});
setLocalStorageUserScope('brief-tests');
const now = 2_000_000;
const trade = { id:'one', category:'p2p-trade', status:EscrowStatus.CREATED, createdAt:now-86400, expiresAt:now-1,
 description:'Sats for sale', amountMsats:100_000, participants:{buyer:'buyer',seller:'seller',arbiter:'arbiter'},
 initiator:{pubkey:'seller',role:Role.SELLER}, lock:{lockedAt:null,notesHash:null}, eventChain:[], communityArbiters:[],
 joinHolds:{buyer:{pubkey:'buyer',joinedAt:now-1000,expiresAt:now-100}} } as unknown as EscrowState;
assert.equal(effectiveViewerRole(trade,'buyer',now),null);
assert.equal(effectiveViewerRole(trade,'seller',now),Role.SELLER,'Creator remains seller');
assert.equal(effectiveViewerRole({...trade,joinHolds:{buyer:{...trade.joinHolds!.buyer!,expiresAt:now+1}}},'buyer',now),Role.BUYER);
assert.equal(effectiveViewerRole({...trade,joinHolds:{seller:{role:Role.SELLER,eventId:'held',pubkey:'seller',joinedAt:now-1000,expiresAt:now-1}}},'seller',now),null,'A held funder seat can lapse');
assert.equal(effectiveViewerRole({...trade,status:EscrowStatus.LOCKED},'buyer',now),Role.BUYER);
assert.equal(spendableBalanceMsats(500_000,[100_000,50_000],[200_000]),150_000);
for (const bad of [undefined,null,NaN,-1,Infinity]) assert.equal(spendableBalanceMsats(500_000,[bad],[]),0);
assert.equal(spendableBalanceMsats(100,[200],[]),0);
assert.equal(canLockFromBalance(trade,99_999,100_000),false);
assert.equal(canLockFromBalance(trade,100_000,100_000),true);
assert.equal(canLockFromBalance({...trade,status:EscrowStatus.LOCKED},500_000,100_000),false);
values.set(scopedStorageKey(PENDING_NATIVE_LOCKS_KEY),'{corrupt');
assert.equal(spendableBalanceMsats(500_000,nativeLockEarmarks('fed'),[]),0,'Corrupt ownership records cannot free funds');
values.delete(scopedStorageKey(PENDING_NATIVE_LOCKS_KEY));
let locks=0;
const options = { amountMsats:100_000, readSpendable:async()=>500_000, getTrade:()=>trade, actualAmount:()=>100_000,
 lock:async()=>{locks++;return {...trade,status:EscrowStatus.LOCKED,lock:{...trade.lock,notesHash:'confirmed'}};}, onPhase:()=>{} };
const before=[...values];
assert.equal((await lockFromBalance(options)).kind,'locked');assert.equal(locks,1);
assert.deepEqual([...values],before,'Balance funding creates no invoice journal entry');
assert.equal((await lockFromBalance({...options,readSpendable:async()=>0})).kind,'lock-failed');assert.equal(locks,1);
assert.equal((await lockFromBalance({...options,getTrade:()=>({...trade,status:EscrowStatus.CANCELLED})})).kind,'lock-failed');assert.equal(locks,1);
assert.equal((await lockFromBalance({...options,lock:async()=>trade})).kind,'lock-failed','No notesHash cannot claim success');
assert.equal((await lockFromBalance({...options,actualAmount:()=>200_000})).kind,'lock-failed','A changed order cannot spend more than approved');
const abort=new AbortController();abort.abort();assert.equal((await lockFromBalance({...options,signal:abort.signal})).kind,'aborted');
// Insurance must remain in the wallet after the trade-only lock spend.
assert.equal(canLockFromBalance(trade,100_000,100_000,10_000),false);
assert.equal(canLockFromBalance(trade,110_000,100_000,10_000),true);
assert.equal(canLockFromBalance(trade,500_000,100_000,NaN),false);
assert.equal(canLockFromBalance(trade,500_000,100_000,-1),false);
let premiumBalance=100_000;
const insuredOptions={...options,premiumMsats:10_000,readSpendable:async()=>premiumBalance,
 lock:async()=>{premiumBalance-=100_000;return {...trade,status:EscrowStatus.LOCKED,lock:{...trade.lock,notesHash:'insured'}};}};
assert.equal((await lockFromBalance(insuredOptions)).kind,'lock-failed');
assert.equal(premiumBalance,100_000,'Refusal must not spend anything');
premiumBalance=110_000;
assert.equal((await lockFromBalance(insuredOptions)).kind,'locked');
assert.equal(premiumBalance,10_000,'Only the trade is spent; insurance stays in the wallet');
for(const [sim,testnet] of [[true,false],[false,true]]){
 const premium=fundingPremiumMsats(10_000,sim,testnet);
 assert.equal(premium,0);
 assert.equal(canLockFromBalance(trade,100_000,100_000,premium),true);
 assert.equal((await lockFromBalance({...options,premiumMsats:premium,readSpendable:async()=>100_000})).kind,'locked');
}
assert.equal(fundingPremiumMsats(10_000,false,false),10_000);
function balanceModal(spendableMsats:number,premiumMsats:number){
 return renderToStaticMarkup(<AtomicFundingModal escrowId="insured" amountMsats={100_000}
  spendableMsats={spendableMsats} premiumMsats={premiumMsats} disableNwc ctaLabel="Lock"
  getOnchainInfo={async()=>{throw Error("On-chain is unsupported in this fixture");}}
  fundAndLock={async()=>({kind:'locked'})} lockAndPublish={async()=>{}} onClose={()=>{}}/>);
}
assert.ok(!balanceModal(100_000,10_000).includes('Use ₿'));
const insuredHtml=balanceModal(110_000,10_000);
assert.ok(insuredHtml.includes('Use ₿ 110 of your ₿ 110 — 100 for the trade, 10 insurance.'));
assert.ok(balanceModal(100_000,0).includes('Use ₿ 100 of your ₿ 100'));
for (const [error,expected] of [[new Error('gateway minimum'),'gateway minimum'],['worker failed','worker failed'],[{error:'refused'},'refused'],[{reason:'busy'},'busy'],[{code:5},'{"code":5}']] as const) assert.equal(errorText(error),expected);
const circular:any={};circular.self=circular;assert.equal(errorText(circular,'fallback'),'fallback');
assert.equal(canRenewListing(trade,'seller',now),true,'Unbonded Exchange can renew');
const session={connected:true,pubkey:'seller',bonded:false,storeEnabled:false,paused:false};
assert.equal(sessionAllowsAutoRenew(trade,session),true);
assert.equal(sessionAllowsAutoRenew(trade,{...session,connected:false}),false);
assert.equal(sessionAllowsAutoRenew({...trade,category:'marketplace'},session),false);
assert.equal(hasMissedBuyerLock(trade,now+JOIN_HOLD_LOCK_GRACE_SECONDS),true);
assert.equal(hasMissedBuyerLock({...trade,lock:{...trade.lock,notesHash:'funded'}},now),false);
const key=listingIdentityKey(trade);markMissedLock(key, "seller");assert.equal(isRenewalPaused(key, "seller"),true);
assert.equal(sessionAllowsAutoRenew(trade,{...session,paused:isRenewalPaused(key, "seller")}),false);
assert.equal(canManuallyRenewListing({...trade,expiresAt:now+86400},'seller',now+JOIN_HOLD_LOCK_GRACE_SECONDS),true,'Missed buyer permits immediate manual renewal');
markManuallyKept(key, "seller");assert.equal(isRenewalPaused(key, "seller"),false);
markMissedLock(key, 'seller');assert.equal(isRenewalPaused(key, 'other'),false,'Renewal pause belongs to this seller');
for(const status of ['waiting','seen','confirmed','claimed','failed'] as const){
 const html=renderToStaticMarkup(<DepositProgressLine progress={{status,btcDeposited:2000,error:'Test failure'}} finality={10}/>);
 assert.ok(html.includes('min-height:54px'));assert.ok(!html.includes('of 10'));
}
const checkout=renderToStaticMarkup(<FundingCheckout tradeSats={100} feeSats={1000} minimumSats={1001}/>);
assert.ok(checkout.includes('−901'));assert.ok(checkout.includes('1,001'));
console.log('PASS 6.4.8: seats, spendable balance, direct lock, error preservation, renewal and deposit states');

for (const sats of [0, 100, 5000]) {
  const html = renderToStaticMarkup(<WalletBalance balanceMsats={sats * 1000} />);
  assert.ok(html.includes(sats.toLocaleString()));
  assert.ok(!html.includes('role="alert"'));
}

// The actual orchestrator preserves non-Error failures, not just the formatter.
const { runFundAndLock } = await import('../payments/fund-and-lock.js');
const rejected = await runFundAndLock({escrowId:'failure',amountMsats:100000,description:'test',getBalance:async()=>0,
 createFundingInvoice:async()=>{throw 'gateway refused this amount';}, lockAndPublish:async()=>{throw Error('must not lock');},onPhase:()=>{}});
assert.equal(rejected.kind,'lock-failed');
if(rejected.kind==='lock-failed') {assert.equal(rejected.error,'gateway refused this amount');assert.equal(rejected.invoiceFailed,true);}
