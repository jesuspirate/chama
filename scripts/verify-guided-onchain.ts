/** Isolated UI regression; no wallets, relays, or Bitcoin requests.
 * Run CHAMA_TEST_BROWSER=/path/to/chromium npx tsx scripts/verify-guided-onchain.ts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import * as btc from '@scure/btc-signer';
import { safetyFixture } from './lib/escrow-safety-fixture.js';
const fixture = safetyFixture({ buyer: btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),
  seller: btc.utils.pubSchnorr(new Uint8Array(32).fill(12)), arbiter: btc.utils.pubSchnorr(new Uint8Array(32).fill(13)) }, 2_000_000, 'ui-test');
const bundle = await build({ bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { LiveTradeSurface } from './src/ui/screens/LiveTradeSurface';
import { LangProvider } from './src/i18n';
import { EscrowStatus, Outcome } from './src/escrow-engine/types';
const base = ${JSON.stringify(fixture.state)};
const terms = ${JSON.stringify(fixture.terms)};
const keys = ${JSON.stringify(fixture.pks)};
let state = base, viewer = keys.seller, funded = false, valid = true;
const calls = window.calls = { full:0, prepare:0, lock:0, sign:0, vote:0, claim:0, payout:0 };
const root = createRoot(document.getElementById('root'));
const check = async () => ({depositStatus: funded ? 'confirmed' : 'waiting', verdict: {funded}});
const actions = {
 onchainFundingPlan: () => state.onchainFundingTerms ? {ready:true,address:terms.address} : {ready:false,blockers:['funding-terms']},
 onPrepareOnchainFunding: async () => {calls.prepare++; state={...state,onchainFundingTerms:terms}; render();},
 onCheckOnchainFunding: check,
 onPublishOnchainLock: async () => {calls.lock++; window.scenario('locked',viewer===keys.seller?'seller':'buyer');},
 onPrepareOnchainSettlement: async (_id,address) => ({psbt:'mock',check:{ok:valid,failures:valid?[]:['tampered output']},signedByMe:false}),
 onSignOnchainSettlement: async () => {calls.sign++; return {psbt:'mock',check:{ok:true,failures:[]}};},
 onFinalizeOnchainSettlement: async () => ({status:'waiting'}),
 onScanMyOnchainPayouts: async () => {calls.payout++; return {payouts:[],balanceSats:0n};},
 onSweepOnchainPayout: async () => {throw Error('not used');}
};
function render(){root.render(<LangProvider><LiveTradeSurface state={state} pubkey={viewer} onBack={()=>{}}
 onOpenFullView={()=>calls.full++} onVote={async()=>{calls.vote++;}} onClaim={async()=>{calls.claim++;}}
 onSendChat={()=>{}} onchainActions={actions} onCheckOnchainFunding={check}/></LangProvider>);}
window.scenario=(stage,role='seller',pass=true)=>{viewer=keys[role]; valid=pass; funded=stage!=='created'&&stage!=='funding'; state={...base,id:base.id+stage+role+pass,
 onchainFundingTerms:stage==='created'?undefined:terms,
 status:stage==='created'||stage==='funding'?EscrowStatus.CREATED:stage==='locked'?EscrowStatus.LOCKED:stage==='done'?EscrowStatus.COMPLETED:EscrowStatus.APPROVED,
 lock:stage==='created'||stage==='funding'?base.lock:{...base.lock,lockedAt:Math.floor(Date.now()/1000),onchain:{...terms,amountSats:'100000',fundingTxid:'11'.repeat(32),fundingVout:0}},
 resolvedOutcome:stage==='approved'||stage==='done'?Outcome.RELEASE:undefined,
 resolvedMajority:stage==='approved'||stage==='done'?['buyer','seller']:undefined}; render();};
window.fund=()=>{funded=true;}; window.scenario('created');
` } });
const server = createServer((_req,res) => res.end('<!doctype html><div id="root"></div>'));
await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHAMA_TEST_BROWSER, headless:true });
  const page = await browser.newPage();
  const errors: string[] = []; page.on('pageerror', e => { errors.push(String(e)); console.error(e); });
  await page.setRequestInterception(true);
  page.on('request', req => req.url().startsWith('http://127.0.0.1:') ? void req.continue() : void req.abort());
  await page.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
  await page.addScriptTag({content:bundle.outputFiles[0].text});
  const click = async (label: string) => {
    console.log('Checking:',label);
    await page.waitForFunction(label => [...document.querySelectorAll('button')].some(b => b.textContent===label && !b.disabled),{},label);
    await page.evaluate(label => ([...document.querySelectorAll('button')].find(b => b.textContent===label) as HTMLButtonElement).click(),label);
  };
  await click('Open on-chain funding'); await page.waitForSelector('[role=dialog]');
  await click('Prepare deposit address'); await page.waitForFunction(() => document.body.innerText.includes('Waiting for the deposit'));
  assert.equal(await page.evaluate(() => (window as any).calls.full),0);
  await page.evaluate(() => (window as any).fund());
  await click('I have sent it — lock the trade');
  await page.waitForFunction(() => (window as any).calls.lock===1);
  await page.waitForFunction(() => !document.querySelector('[role=dialog]'));
  await page.evaluate(() => (window as any).scenario('funding','buyer'));
  await click('Open on-chain deposit details');
  await page.waitForSelector('[role=dialog] a[href*="/address/"]');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role=dialog] button')].some(b=>/Prepare deposit|sent it|Sign/.test(b.textContent??''))),false);
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).scenario('locked','buyer'));
  await click('Yes — confirm');
  assert.equal(await page.evaluate(() => (window as any).calls.vote),1);
  await page.evaluate(() => (window as any).scenario('approved','buyer',false));
  await page.waitForFunction(() => document.body.innerText.includes('tampered output'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(b=>/Sign/.test(b.textContent??'')&&!b.disabled)),false);
  await page.evaluate(() => (window as any).scenario('approved','buyer',true));
  await page.waitForFunction(() => !!document.querySelector('input[placeholder]'));
  await click('Sign the payout');
  assert.equal(await page.evaluate(() => (window as any).calls.sign),1);
  assert.equal(await page.evaluate(() => (window as any).calls.claim),0);
  await page.evaluate(() => (window as any).scenario('done','buyer'));
  await page.waitForFunction(() => (window as any).calls.payout>0);
  assert.deepEqual(errors,[]);
  console.log('PASS guided on-chain overlay, read-only buyer, fiat vote, failed-check signing gate, signing and payout recovery');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
