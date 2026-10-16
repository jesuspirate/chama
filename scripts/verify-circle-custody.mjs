import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER??'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
try {
 const page=await browser.newPage();
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.evaluateOnNewDocument(()=>localStorage.setItem('chama_lang',new URLSearchParams(location.search).get('lang')??'en'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const go=async params=>{await page.goto(`${process.env.CHAMA_PREVIEW??'http://127.0.0.1:3211'}/tests/first-circle-phones/?${params}`);await page.waitForSelector('main');};
 for(const lang of ['en','es','fr','sw']) for(const theme of ['light','dark']) {
  for(const [suffix,unlisted,operator] of [['curated',0,0],['',1,0],['curated&one',0,1],['one',1,1]]) {
   await go(`mode=federation&lang=${lang}&theme=${theme}&${suffix}`);
   await page.waitForFunction(()=>document.querySelector('[data-federation-disclosure]').textContent.includes('4')||document.querySelector('[data-federation-disclosure]').textContent.includes('3'));
   assert.equal(await page.$$eval('[data-federation-warning=unlisted]',els=>els.length),unlisted);
   assert.equal(await page.$$eval('[data-federation-warning=operator]',els=>els.length),operator);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
   if(suffix==='one') await page.screenshot({path:`outputs/first-circle-phones/custody-${lang}-${theme}.png`,fullPage:true});
  }
 }
 await go('mode=federation&lang=en&unknown');
 await page.waitForFunction(()=>document.body.textContent.includes('guardian count unavailable'));
 assert.equal(await page.$('[data-federation-warning=operator]'),null);
 await go('mode=canvas&lang=en');
 assert.equal(await page.$eval('#circle-amount',e=>e.value),'1000');
 await page.waitForFunction(()=>document.querySelector('[data-circle-limit]').textContent.includes('50,000'));
 await page.$eval('#circle-amount',e=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'100000');e.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.equal(await page.$eval('.circle-canvas-action button',e=>e.disabled),false,'private ceiling is advice');
 await page.click('.circle-canvas-action button');
 await page.$$eval('.circle-chips button',els=>els.find(e=>e.textContent==='Anyone can join').click());
 assert.equal(await page.$eval('.circle-canvas-action button',e=>e.disabled),true,'public share must fit a verifiable payout limit');
 await go('mode=canvas&lang=en');
 await page.waitForFunction(()=>document.querySelector('[data-circle-limit]').textContent.includes('50,000'));
 await page.click('.circle-canvas-action button');
 await page.$$eval('.circle-chips button',els=>els.find(e=>e.textContent==='Anyone can join').click());
 await page.click('.circle-canvas-action button');await page.click('.circle-canvas-action button');await page.click('.circle-canvas-action button');
 await page.waitForFunction(()=>window.submissions.length===1);
 const round=await page.evaluate(()=>window.submissions[0]);
 assert.equal(round.shareMsats,1000000);assert.equal(round.seatThreshold,5);assert.equal(round.seatCap,5);assert.equal(!!round.unlisted,false);
 await go('mode=canvas&lang=en&unknown');await page.click('.circle-canvas-action button');
 await page.$$eval('.circle-chips button',els=>els.find(e=>e.textContent==='Anyone can join').click());
 assert.equal(await page.$eval('.circle-canvas-action button',e=>e.disabled),true,'unknown limits cannot authorize a new public circle');
 await page.$$eval('.circle-chips button',els=>els.find(e=>e.textContent==='Just us').click());
 assert.equal(await page.$eval('.circle-canvas-action button',e=>e.disabled),false,'private circles remain available with honest unknown-limit advice');
 assert.deepEqual(errors,[]);
 console.log('PASS custody combinations in four languages/light+dark at 390px; unknown config; 1,000-sat default; private advice and public refusal');
} finally {await browser.close();}
