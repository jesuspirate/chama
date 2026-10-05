import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';

const browser = await puppeteer.launch({
  executablePath: process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const base = process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3000';
  for (const mode of ['join-error', 'join-terminal']) {
    await page.goto(`${base}/tests/payment-card/?rails=${mode}`);
    await page.waitForFunction(() => document.body.textContent.includes('Client already exists in database'));
    assert.ok(!(await page.evaluate(() => document.body.textContent)).includes('GENERATING INVOICE'));
    assert.deepEqual(await page.evaluate(() => window.railCalls), ['lightning']);
    assert.equal(await page.$('.payment-card img'), null, 'No invoice offered after join failure');
  }
  console.log('PASS: thrown join error and terminal without callback both stop the invoice spinner and preserve SDK detail.');
} finally {
  await browser.close();
}
