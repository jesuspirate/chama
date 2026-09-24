import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER??'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage();await page.setViewport({width:390,height:844});
 await page.evaluateOnNewDocument(()=>localStorage.setItem('chama_lang','fr'));
 page.on('pageerror',e=>console.error(e));
 const base=process.env.CHAMA_PREVIEW??'http://127.0.0.1:3000';
 await page.goto(`${base}/tests/briefs-648/`);await page.waitForSelector('.assisted-match');
 assert.equal((await page.$$('.assisted-match')).length,2,'Two listings, not three endpoint candidates');
 assert.ok((await page.$eval('.assisted-match',e=>e.textContent)).includes('21–500 sats'));
 for(let index=0;index<2;index++){
  await page.click(`.assisted-match:nth-of-type(${index+1})`);
  await page.click('.assisted-primary');
  await page.waitForFunction(()=>!!window.opened);
  assert.equal(await page.evaluate(()=>window.opened),index===0?'one':'two');
  await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('‹ Offres')).click());
  await page.waitForSelector('.assisted-match');assert.equal((await page.$$('.assisted-match')).length,2);
  assert.equal(await page.evaluate(()=>window.search().detail),'1','Back preserves the search');
 }
 await page.screenshot({path:'/tmp/chama-guided-fr-390.png',fullPage:true});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 for(const viewer of ['seller','buyer']){
  await page.goto(`${base}/tests/briefs-648/?lapsed=1&viewer=${viewer}`);
  await page.waitForSelector('.lts-cat-word');
  const text=await page.evaluate(()=>document.body.textContent);
  assert.ok(!text.includes('Financer et verrouiller'));
  const label=viewer==='seller'?'Publier à nouveau':'Rejoindre à nouveau';
  assert.ok(text.includes(label), `${viewer}: ${text}`);
  await page.evaluate(label=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label).click(),label);
  assert.equal(await page.evaluate(viewer=>viewer==='seller'?window.reposted:window.joined,viewer),viewer==='seller'?true:'buyer');
 }
 await page.goto(`${base}/tests/briefs-648/?sim=1&balance=1`);
 await page.waitForSelector('button.payment-button');
 assert.equal(await page.$('.payment-card img'),null,'Balance choice creates no invoice');
 await page.click('button.payment-button');
 await page.waitForFunction(()=>window.remainingBalance!==undefined);
 assert.equal(await page.evaluate(()=>window.remainingBalance),400000);
 assert.equal(await page.$('.payment-card img'),null,'Balance lock never displays an invoice');
 console.log('PASS French 390px guided Exchange: range cards, distinct listing IDs, preserved search, lapsed seller and buyer actions');
}finally{await browser.close();}
