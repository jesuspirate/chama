// Mounted regression: npm preview/dev server + CHAMA_PREVIEW and CHAMA_BROWSER.
// Public fixture data only; never calls the escrow engine or funds a wallet.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({
  executablePath: process.env.CHAMA_BROWSER ?? (process.platform === 'darwin'
    ? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' : '/usr/bin/google-chrome'),
  headless: true,
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 393, height: 852 });
  await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3211'}/tests/brief11/index.html?panel=vote-retry`);
  await page.waitForSelector('button[data-hold-state]');
  const vote = async expectedAttempts => {
    await page.$eval('button[data-hold-state]', button => button.click());
    await page.waitForFunction(() => document.querySelector('button[data-hold-state]')?.dataset.holdState === 'armed');
    await page.$eval('button[data-hold-state]', button => button.click());
    await page.waitForFunction(expected => window.voteAttempts === expected, {}, expectedAttempts);
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    await vote(attempt);
    await page.waitForFunction(() => document.querySelector('button[data-hold-state]')?.dataset.holdState === 'idle');
    assert.equal(await page.$eval('button[data-hold-state]', button => !button.disabled && button.getBoundingClientRect().height > 0), true);
    assert.doesNotMatch(await page.$eval('body', body => body.innerText), /Recording your vote/);
  }
  await page.evaluate(() => { window.voteResult = true; });
  await vote(3);
  await page.waitForFunction(() => document.body.innerText.includes('Recording your vote'));
  console.log('PASS mounted vote retry: failure keeps buttons usable, immediate retry works, only success shows recording');
} finally {
  await browser.close();
}
