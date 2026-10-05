import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try {
  const page = await browser.newPage(); await page.setViewport({width:390,height:844});
  await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://localhost:3000'}/tests/payment-methods/`);
  await page.waitForSelector('input[name="chama-private-payment-phone"]');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Banks & apps')).click());
  await page.type('input[name="chama-payment-method-search"]','Strike');
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent.includes('Strike')));
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.includes('Strike')).click());
  await page.waitForSelector('input[name="chama-private-payment-id"]');
  const fields = await page.$$eval('input', inputs => inputs.map(input => ({
    name:input.name, autocomplete:input.getAttribute('autocomplete'), bw:input.getAttribute('data-bwignore'),
    onePassword:input.getAttribute('data-1p-ignore'), lastPass:input.getAttribute('data-lpignore'), type:input.getAttribute('data-form-type'),
  })));
  assert.ok(fields.length >= 3);
  for (const field of fields) {
    assert.equal(field.autocomplete,'off',field.name); assert.equal(field.bw,'true',field.name);
    assert.equal(field.onePassword,'true',field.name); assert.equal(field.lastPass,'true',field.name); assert.equal(field.type,'other',field.name);
  }
  await page.type('input[name="chama-private-payment-id"]','strike-fixture');
  await page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim()==='Save method').click());
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('chama_saved_handles:payment-autofill-fixture') ?? '[]').some(h=>h.rail==='strike' && h.handle==='strike-fixture'));
  await page.reload(); await page.waitForSelector('input[name="chama-private-payment-phone"]');
  assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('chama_saved_handles:payment-autofill-fixture')).some(h=>h.rail==='strike' && h.handle==='strike-fixture')));
  console.log('PASS payment-method fields: phone/search/Strike autocomplete off and manager ignore hints; Strike save survives reload. Actual extension popup requires its own user environment.');
} finally { await browser.close(); }
