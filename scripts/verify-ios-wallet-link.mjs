import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({
  executablePath: process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless:true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1');
  await page.evaluateOnNewDocument(() => {
    window.shareCalls = 0;
    window.copyCalls = [];
    Object.defineProperty(navigator, 'share', {value:async()=>{window.shareCalls++;}});
    Object.defineProperty(navigator, 'canShare', {value:()=>true});
    Object.defineProperty(navigator, 'clipboard', {value:{writeText:async text=>{window.copyCalls.push(text);}}});
    document.addEventListener('click', event => {
      const anchor = event.target.closest?.('a[href^="lightning:"]');
      if (anchor) {window.handoff = anchor.getAttribute('href');event.preventDefault();} // never launch a real wallet in this test
    });
  });
  await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3000'}/tests/payment-card/`);
  await page.waitForSelector('a[href^="lightning:"]');
  const invoice = await page.evaluate(() => window.payload.slice('lightning:'.length));
  assert.equal(await page.$eval('a[href^="lightning:"]', a=>a.textContent), 'Open in wallet');
  await page.click('a[href^="lightning:"]');
  assert.equal(await page.evaluate(()=>window.handoff), `lightning:${invoice}`);
  assert.equal(await page.evaluate(()=>window.shareCalls),0);
  assert.deepEqual(await page.evaluate(()=>window.copyCalls),[], 'Handoff does not overwrite the clipboard');
  assert.match(await page.$eval('.payment-copy', e=>e.textContent), /Copy/);
  await page.click('.payment-copy');
  await page.waitForFunction(()=>window.copyCalls.length===1);
  assert.deepEqual(await page.evaluate(()=>window.copyCalls),[invoice]);
  assert.equal(await page.evaluate(()=>window.shareCalls),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  console.log('PASS iOS UI branch: native lightning anchor activation, no share sheet, explicit raw invoice copy, 390px layout. Chromium emulation, not an iPhone wallet-app test.');
} finally {await browser.close();}
