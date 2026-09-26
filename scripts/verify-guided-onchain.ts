/** Isolated UI regression; no wallets, relays, or Bitcoin requests.
 * Run CHAMA_TEST_BROWSER=/path/to/chromium npx tsx scripts/verify-guided-onchain.ts. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import puppeteer from 'puppeteer-core';
import * as btc from '@scure/btc-signer';
import { buildSettlementPsbt } from '../src/bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../src/bond-multisig/multisig.js';
import { safetyFixture } from './lib/escrow-safety-fixture.js';
const fixture = safetyFixture({ buyer: btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),
  seller: btc.utils.pubSchnorr(new Uint8Array(32).fill(12)), arbiter: btc.utils.pubSchnorr(new Uint8Array(32).fill(13)) }, 2_000_000, 'ui-test');
const payoutAddress=btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(11)),undefined,SIGNET).address!;
const payoutPsbt=buildSettlementPsbt({escrow:fixture.escrow,utxos:[{txid:'11'.repeat(32),index:0,amountSats:100_000n}],destination:payoutAddress,feeSats:500n});
const bundle = await build({ bundle: true, write: false, format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"test"', 'import.meta.env': '{}' },
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { ClaimPayoutModal } from './src/ui/panels/ClaimPayoutModal';
import { TradeDetail } from './src/ui/screens/TradeDetail';
import { LiveTradeSurface } from './src/ui/screens/LiveTradeSurface';
import { LangProvider } from './src/i18n';
import { avatarFromFile, parseAvatar, saveAvatar } from './src/ui/avatars';
import { EscrowStatus, Outcome } from './src/escrow-engine/types';
const base = ${JSON.stringify(fixture.state)};
const terms = ${JSON.stringify(fixture.terms)};
const keys = ${JSON.stringify(fixture.pks)};
let fullView=false;
const proposal={pubkey:keys.buyer,payload:{type:"escrow:settlement",role:"buyer",leaf:"coop",psbt:${JSON.stringify(payoutPsbt)},payoutAddress:${JSON.stringify(payoutAddress)}},raw:{id:"proposal"}};
let state = base, viewer = keys.seller, funded = false, valid = true;
const calls = window.calls = { full:0, prepare:0, lock:0, sign:0, vote:0, claim:0, payout:0, draft:0, ecashFund:0 };
const root = createRoot(document.getElementById('root'));
const check = async () => ({depositStatus: funded ? 'confirmed' : 'waiting', verdict: {funded}});
const actions = {
 onchainFundingPlan: () => state.onchainFundingTerms ? {ready:true,address:terms.address} : {ready:false,blockers:['funding-terms']},
 onPrepareOnchainFunding: async () => {calls.prepare++; state={...state,onchainFundingTerms:terms}; render();},
 onCheckOnchainFunding: check,
 onPublishOnchainLock: async () => {calls.lock++; window.scenario('locked',viewer===keys.seller?'seller':'buyer');},
 onCheckOnchainSettlement: async () => ({psbt:proposal.payload.psbt,check:{ok:valid,failures:valid?[]:['tampered output']},signedByMe:false}),
 onPrepareOnchainSettlement: async () => {calls.draft++;state={...state,settlements:[proposal]};render();return actions.onCheckOnchainSettlement();},
 onSignOnchainSettlement: async () => {calls.sign++; return {psbt:proposal.payload.psbt,check:{ok:true,failures:[]}};},
 onFinalizeOnchainSettlement: async () => ({status:'waiting'}),
 onScanMyOnchainPayouts: async () => {calls.payout++; return {payouts:[],balanceSats:0n};},
 onSweepOnchainPayout: async () => {throw Error('not used');}
};
function render(){const props={state,pubkey:viewer,onBack:()=>{},onVote:async()=>{calls.vote++;},onClaim:async()=>{calls.claim++;},onLock:async()=>{calls.ecashFund++;},onSendChat:()=>{},onCheckOnchainFunding:check};
root.render(<LangProvider>{fullView?<TradeDetail {...props} {...actions} homeCommunity={null} bootProbeFailed={false} receiveUnavailable={false} fundingInProgress={false} onJoin={()=>{}} />
:<LiveTradeSurface {...props} onOpenFullView={()=>calls.full++} onchainActions={actions}/>}</LangProvider>);}
window.receiveProposal=()=>{state={...state,settlements:[proposal]};render();};
window.fullView=(value)=>{fullView=value;render();};
window.scenario=(stage,role='seller',pass=true)=>{viewer=keys[role]; valid=pass; funded=stage!=='created'&&stage!=='funding'; state={...base,id:base.id+stage+role+pass,
 onchainFundingTerms:stage==='created'?undefined:terms,
 status:stage==='created'||stage==='funding'?EscrowStatus.CREATED:stage==='locked'?EscrowStatus.LOCKED:stage==='done'?EscrowStatus.COMPLETED:EscrowStatus.APPROVED,
 lock:stage==='created'||stage==='funding'?base.lock:{...base.lock,lockedAt:Math.floor(Date.now()/1000),onchain:{...terms,amountSats:'100000',fundingTxid:'11'.repeat(32),fundingVout:0}},
 resolvedOutcome:stage==='approved'||stage==='done'?Outcome.RELEASE:undefined,
 resolvedMajority:stage==='approved'||stage==='done'?['buyer','seller']:undefined}; render();};
window.claimScenario=(currency='USD',gateway=1)=>root.render(<LangProvider><ClaimPayoutModal key={currency+gateway}
 escrowId="cash-out-test" payoutMsats={100_000_000} fiatCurrency={currency}
 savedDestinations={[{id:'saved',address:'me@example.com',createdAt:0}]}
 savedNwcConnections={[{id:'nwc',label:'My wallet',connectionString:'nostr+walletconnect://test',createdAt:0}]}
 getLightningGatewayCount={async()=>gateway} claimAndPayout={async()=>{throw Error('Unexpected payment');}}
 confirmClaimEcashExport={async()=>{}} probeFederation={async()=>({ok:true})} onClose={()=>{}} /></LangProvider>);
window.testAvatars=async()=>{
 const canvas=document.createElement('canvas'); canvas.width=2400; canvas.height=1600;
 const ctx=canvas.getContext('2d'); const pixels=ctx.createImageData(2400,1600);
 let seed=17;
 for(let y=0;y<1600;y++) for(let x=0;x<2400;x++) {
   seed=(Math.imul(seed,1664525)+1013904223)>>>0;
   const i=(y*2400+x)*4, center=x>=400&&x<2000;
   pixels.data[i]=center?seed%80:255; pixels.data[i+1]=center?150+seed%106:0;
   pixels.data[i+2]=center?(seed>>>8)%80:0; pixels.data[i+3]=255;
 }
 ctx.putImageData(pixels,0,0);
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
 const file=new File([blob],'large.png',{type:'image/png'});
 const webp=await avatarFromFile(file);
 const original=HTMLCanvasElement.prototype.toDataURL;
 let jpeg;
 try {HTMLCanvasElement.prototype.toDataURL=function(type,q){return original.call(this,type==='image/webp'?'image/png':type,q);}; jpeg=await avatarFromFile(file);}
 finally {HTMLCanvasElement.prototype.toDataURL=original;}
 const inspect=async avatar=>{
   if(!parseAvatar(avatar)) throw Error('Compressed avatar rejected');
   const img=new Image(); img.src=avatar.still; await img.decode();
   const out=document.createElement('canvas');out.width=256;out.height=256;
   const c=out.getContext('2d');c.drawImage(img,0,0);
   const corner=Array.from(c.getImageData(0,0,1,1).data);
   return {size:atob(avatar.still.split(',')[1]).length,width:img.naturalWidth,height:img.naturalHeight,corner};
 };
 saveAvatar(keys.buyer,webp);saveAvatar(keys.seller,jpeg);
 return {input:file.size,webp:await inspect(webp),jpeg:await inspect(jpeg),fallback:jpeg.still.startsWith('data:image/jpeg;')};
};
window.fund=()=>{funded=true;}; window.scenario('created');
` } });
const server = createServer((_req,res) => res.end('<!doctype html><style>*{box-sizing:border-box}body{margin:0}</style><div id="root"></div>'));
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
  await click('Send to my Chama key instead');
  await page.waitForFunction(() => document.body.innerText.includes('tampered output'));
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('button')].some(b=>/Sign/.test(b.textContent??'')&&!b.disabled)),false);
  await page.evaluate(() => (window as any).scenario('approved','buyer',true));
  await page.waitForFunction(() => !!document.querySelector('input[placeholder]'));
  await click('Send to my Chama key instead');
  await click('Sign the payout');
  assert.equal(await page.evaluate(() => (window as any).calls.sign),1);
  assert.equal(await page.evaluate(() => (window as any).calls.claim),0);
  for (const full of [false,true]) {
    await page.evaluate(full => { (window as any).fullView(full); (window as any).scenario('approved','seller'); },full);
    await page.waitForFunction(() => document.body.innerText.includes('choose where the sats go'));
    const drafts=await page.evaluate(()=>(window as any).calls.draft);
    await page.evaluate(()=>(window as any).receiveProposal());
    await click('Sign the payout');
    assert.equal(await page.evaluate(()=>(window as any).calls.draft),drafts,'other signer only reads the winner proposal');
    await page.evaluate(()=>(window as any).scenario('approved','buyer'));
    await page.waitForFunction(() => document.body.innerText.includes('Send to my Chama key instead'));
    assert.equal(await page.evaluate(()=>(window as any).calls.draft),drafts,'mount never prepares');
    await click('Send to my Chama key instead');
    await click('Sign the payout');
    assert.equal(await page.evaluate(()=>(window as any).calls.draft),drafts+1,'only explicit destination choice prepares');
    assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>/Claim them|Claim sats|Claim into/.test(b.textContent??''))),false);
    assert.equal(await page.evaluate(()=>(window as any).calls.claim),0,'on-chain never uses the ecash claim handler in either view');
    await page.evaluate(()=>(window as any).scenario('created','seller'));
    await page.waitForFunction(() => document.body.innerText.includes('deposit address') || document.body.innerText.includes('funding'));
    assert.equal(await page.evaluate(()=>(window as any).calls.ecashFund),0,'on-chain never uses the ecash funding handler in either view');
  }
  await page.evaluate(()=>(window as any).fullView(false));
  await page.evaluate(() => (window as any).scenario('done','buyer'));
  await page.waitForFunction(() => (window as any).calls.payout>0);
  const avatars = await page.evaluate(() => (window as any).testAvatars());
  assert.ok(avatars.input>48*1024);
  assert.equal(avatars.fallback,true);
  for(const output of [avatars.webp,avatars.jpeg]) {
    assert.ok(output.size<=40*1024); assert.equal(output.width,256); assert.equal(output.height,256);
    assert.ok(output.corner[1]>output.corner[0], 'cover crop removes the red side bars');
  }
  await page.setViewport({width:390,height:844});
  await page.waitForFunction(() => document.querySelectorAll('.lts-room img').length>=2);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('.lts-room button')].some(el=>el.getBoundingClientRect().right>window.innerWidth)),false,'seat chips and avatars fit mobile width');
  if (process.env.CHAMA_TEST_SCREENSHOT) await page.screenshot({path:process.env.CHAMA_TEST_SCREENSHOT as `${string}.png`});
  console.log('PASS large profile image compression, 256px cover crop, JPEG fallback and mobile seat avatars', avatars);
  for(const currency of ['USD','KES','TZS']) {
    await page.evaluate(currency=>(window as any).claimScenario(currency),currency);
    await page.waitForSelector('section[aria-label="Cash out in '+currency+'"]');
    assert.equal(await page.$('details'),null,'cash-out never hides in Details');
  }
  await page.evaluate(()=>(window as any).claimScenario('USD',0));
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].filter(b=>b.textContent?.includes('Strike')).every(b=>b.disabled));
  assert.ok(await page.$('section[aria-label="Cash out in USD"]'));
  await page.evaluate(()=>(window as any).claimScenario('USD',1));
  await click('me@example.com');
  await page.waitForFunction(()=>[...document.querySelectorAll('input')].some(input=>input.value==='me@example.com'));
  console.log('PASS claim cash-out cards visible by currency, gateway gating, Your wallets and saved address confirmation');
  assert.deepEqual(errors,[]);
  console.log('PASS guided on-chain overlay, read-only buyer, fiat vote, failed-check signing gate, signing and payout recovery');
} finally { await browser?.close(); server.closeAllConnections(); server.close(); }
