// Deterministic browser regression: real signed CREATEs, fake relay sockets,
// testnet wallet only, fresh disposable browser context for each sign-in.
// node scripts/verify-replay-startup.mjs (dev server at CHAMA_PREVIEW / :3000)
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';

const tradeId = 'sm_startup_regression';
const now = Math.floor(Date.now() / 1000);
const create = (community, at) => finalizeEvent({ kind: 38100, created_at: at,
  tags: [['d', tradeId]], content: JSON.stringify({ type: 'escrow:create',
    category: 'p2p-trade', description: 'Read-only startup regression', amountMsats: 1000,
    mintUrl: 'test-only', platformFeeBps: 0, platformFeePubkey: 'a'.repeat(64),
    arbiterFeeMsats: 0, expirySeconds: 86400, createdAt: at, community }) }, generateSecretKey());
const real = create('ke-kes', now - 5), forged = create('us-blf', now - 125);
const browser = await puppeteer.launch({
  executablePath: process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  headless: true, args: ['--no-sandbox'],
});
try {
  for (const [name, events, home] of [['refused', [forged, real], 'us-blf'], ['valid', [real], 'ke-kes']]) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    await page.evaluateOnNewDocument(events => {
      localStorage.setItem('chama_intro_seen', '1');
      window.__startupDeliveredCreates = new Set();
      window.WebSocket = class {
        static OPEN = 1; static CONNECTING = 0; static CLOSED = 3;
        constructor(url) { this.url=url; this.readyState=0; queueMicrotask(() => {this.readyState=1;this.onopen?.({});}); }
        send(raw) {
          const message = JSON.parse(raw);
          if (message[0] === 'EVENT') return queueMicrotask(() => this.onmessage?.({data:JSON.stringify(['OK',message[1].id,true,'saved'])}));
          if (message[0] !== 'REQ') return;
          queueMicrotask(() => {
            for (const event of events) {
              const match = message.slice(2).some(filter => filter['#d']?.includes('sm_startup_regression')
                && (!filter.authors || filter.authors.includes(event.pubkey))
                && (!filter.kinds || filter.kinds.includes(event.kind)));
              if (match) {
                window.__startupDeliveredCreates.add(event.id);
                this.onmessage?.({data:JSON.stringify(['EVENT',message[1],event])});
              }
            }
            this.onmessage?.({data:JSON.stringify(['EOSE',message[1]])});
          });
        }
        close() { this.readyState=3; }
      };
    }, events);
    await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://localhost:3000'}/?testnet=1&trade=${tradeId}`);
    const click = async text => {
      await page.waitForFunction(text => [...document.querySelectorAll('button')].some(b => b.textContent.trim()===text), {}, text);
      await page.evaluate(text => [...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text).click(), text);
    };
    await click('Create my account'); await click('Continue with this key');
    await page.waitForFunction(home => Object.keys(localStorage).some(k => k.startsWith('chama_community:') && localStorage.getItem(k)===home), {}, home);
    await page.waitForFunction(() => !document.body.innerText.includes('Setting you up…') && !document.body.innerText.includes('Opening your invite'));
    if (name === 'refused') {
      assert.equal(await page.evaluate(() => window.__startupDeliveredCreates.size), 2, 'both signed rival CREATEs reached the real client');
      assert.equal(await page.evaluate(() => document.body.innerText.includes('Join this trade?')), false, 'refused listing never becomes a trade room');
      assert.ok(await page.$('[data-coach="nav-browse"]'), 'Browse navigation renders instead of onboarding');
      assert.ok(await page.$('[data-coach="browse-preferences"]'), 'Browse content renders, not an empty detail selection');
    } else {
      await page.waitForFunction(() => document.body.innerText.includes('Join this trade?'));
      assert.ok(await page.$('.lts-room'), 'valid invite still opens the trade room');
    }
    console.log(`PASS ${name} deep link: fresh sign-in completes with ${home}; ${name==='refused'?'conflict refused and Browse available':'valid invite home retained'}`);
    await context.close();
  }
} finally { await browser.close(); }
