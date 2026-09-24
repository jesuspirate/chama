import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER??'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();await page.setViewport({width:390,height:844});
 await page.evaluateOnNewDocument(()=>localStorage.setItem('chama_lang','fr'));
 const base=process.env.CHAMA_PREVIEW??'http://127.0.0.1:3000';
 const open=async(query)=>{await page.goto(`${base}/tests/payment-card/?rails=${query}`);await page.waitForSelector('[data-funding-rails]');};
 const tab=async(name)=>page.click(`[data-funding-rail=${name}]`);
 await open('zero');await page.waitForSelector('textarea');
 assert.deepEqual(await page.evaluate(()=>window.railCalls),[]);
 assert.equal(await page.$eval('[role=tab]',e=>e.disabled),true);
 assert.ok((await page.evaluate(()=>document.body.textContent)).includes('Lightning n’est pas disponible'));
 await page.type('textarea','TEST-ECASH');await page.click('details[open] button.payment-button');
 await page.waitForFunction(()=>window.railCalls.includes('ecash'));
 await open('zero&balance=1');await page.waitForFunction(()=>document.body.textContent.includes('Utilisez ₿'));
 assert.deepEqual(await page.evaluate(()=>window.railCalls),[]);
 for(const native of [false,true]) {
  await open(`fail${native?'&native=1':''}`);await page.waitForSelector('textarea');
  assert.deepEqual(await page.evaluate(()=>window.railCalls),['lightning']);
  assert.equal(await page.$eval('[role=tab]',e=>e.disabled),true);
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Réessayer').click());
  await page.waitForFunction(()=>window.railCalls.length===2);
  if(native){await tab('onchain');await page.waitForFunction(()=>!document.querySelector('details[open] textarea'));await page.evaluate(()=>[...document.querySelectorAll('button.payment-button')].find(b=>b.textContent.includes('ONCHAIN')).click());await page.waitForFunction(()=>window.railCalls.includes('onchain'));assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Réessayer')),false,'Retry cannot start a competing receive');}
  else {await page.type('textarea','TEST-ECASH');await page.click('details[open] button.payment-button');await page.waitForFunction(()=>window.railCalls.includes('ecash'));}
 }
 await open('live&native=1');await page.waitForFunction(()=>!!window.issueInvoice);
 assert.equal(await page.evaluate(()=>document.querySelector('[data-funding-rails]').getBoundingClientRect().top < [...document.querySelectorAll("div")].find(e=>e.style.animationName==="spin").getBoundingClientRect().top),true);
 await page.evaluate(()=>window.issueInvoice());await page.waitForSelector('.payment-card img');
 assert.equal(await page.evaluate(()=>document.querySelector('[data-funding-rails]').getBoundingClientRect().top < document.querySelector('.payment-card img').getBoundingClientRect().top),true);
 await tab('ecash');await page.waitForSelector('[role=dialog]');
 assert.equal(await page.$eval('[role=dialog] button:last-child',e=>e.disabled),true);
 assert.deepEqual(await page.evaluate(()=>window.railCalls),['lightning']);
 await page.screenshot({path:'/tmp/chama-rails-fr-390.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 console.log('PASS rails: zero gateways, balance priority, invoice failure to ecash/on-chain, explicit retry, top placement, live-invoice guard, French 390px');
} finally { await browser.close(); }
