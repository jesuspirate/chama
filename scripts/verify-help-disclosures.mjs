import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const base = process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3214';
const output = process.env.CHAMA_HELP_OUTPUT ?? 'outputs/help-disclosures';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true });
try {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(origin => {
    if (location.origin !== origin) return;
    localStorage.setItem('chama_lang', new URLSearchParams(location.search).get('lang') ?? 'en');
    localStorage.setItem('chama_btc_price_usd_v1', JSON.stringify({ usd: 100000, updatedAt: Date.now() }));
    localStorage.setItem('chama_usd_fiat_rates_v1', JSON.stringify({ rates: { USD: 1 }, updatedAt: Date.now() }));
  }, new URL(base).origin);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const trigger = '[data-help-tip] button';
  const go = async query => { await page.goto(`${base}/tests/help-disclosures/?${query}`); await page.waitForSelector(trigger); };
  const isOpen = button => button.evaluate(el => el.getAttribute('aria-expanded') === 'true');
  const placement = async () => {
    await page.waitForSelector('[data-help-popover]', { visible: true });
    await page.waitForFunction(() => {
      const el = document.querySelector('[data-help-popover]');
      const r = el.getBoundingClientRect();
      return getComputedStyle(el).opacity === '1' && r.left >= 7 && r.top >= 7 && r.right <= innerWidth - 7 && r.bottom <= innerHeight - 7;
    }, { timeout: 3000 });
    assert.equal(await page.$eval('[data-help-popover]', el => el.parentElement === document.body), true, 'help escapes clipped task cards');
  };
  const snapshot = async path => {
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-help-popover]')).opacity === '1');
    await page.screenshot({ path: `${output}/${path}`, fullPage: true });
  };
  const checkDisclosure = async index => {
    const buttons = await page.$$(trigger); const button = buttons[index];
    assert.equal(await isOpen(button), false);
    assert.equal(await page.$('[data-help-popover]'), null, 'collapsed help is unmounted');
    const rect = await button.boundingBox(); assert.ok(rect.width >= 44 && rect.height >= 44);
    assert.ok(await button.evaluate(el => el.getAttribute('aria-label').length > 5));
    assert.equal(await button.evaluate(el => el.getAttribute('aria-haspopup')), 'dialog');
    for (let n = 0; n < 3; n++) {
      await button.click(); assert.equal(await isOpen(button), true); await placement();
      assert.equal(await page.$eval('[data-help-popover]', el => document.activeElement === el), true, 'help receives keyboard focus');
      const controls = await button.evaluate(el => el.getAttribute('aria-controls'));
      assert.equal(await page.$eval('[data-help-popover]', el => el.id), controls);
      assert.ok(await page.$eval('[data-help-popover]', el => el.getAttribute('aria-label')));
      assert.ok(await page.$eval('[data-help-popover]', el => document.getElementById(el.getAttribute('aria-describedby')).textContent.length > 0));
      // The backdrop covers the trigger; tapping its location dismisses help.
      await button.click(); assert.equal(await isOpen(button), false);
      assert.equal(await button.evaluate(el => document.activeElement === el), true);
    }
    await button.focus(); await page.keyboard.press('Enter'); assert.equal(await isOpen(button), true);
    await page.keyboard.press('Escape'); assert.equal(await isOpen(button), false);
    assert.equal(await button.evaluate(el => document.activeElement === el), true);
    assert.notEqual(await button.evaluate(el => getComputedStyle(el).outlineStyle), 'none');
    await page.keyboard.press('Space'); assert.equal(await isOpen(button), true);
    await page.keyboard.press('Escape'); assert.equal(await isOpen(button), false);
  };
  for (const width of [390, 320, 1100]) {
    await page.setViewport({ width, height: 844, isMobile: width < 500, hasTouch: width < 500 });
    for (const theme of ['light', 'dark']) for (const lang of ['en', 'es', 'fr', 'sw']) {
      await go(`mode=me&theme=${theme}&lang=${lang}`);
      await checkDisclosure(0);
      if (width === 390 || width === 1100 && theme === 'light' && lang === 'en') {
        await page.click(trigger); await snapshot(`wallet-${width}-${theme}-${lang}.png`); await page.keyboard.press('Escape');
      }
      const walletStyle = await page.$eval(trigger, el => ({ icon: el.firstElementChild.getAttribute('style'), button: el.getAttribute('style') }));
      const walletName = await page.$eval(trigger, el => el.getAttribute('aria-label'));
      await page.$$eval('button', buttons => buttons.find(el => ['Community', 'Comunidad', 'Communauté', 'Jumuiya'].includes(el.textContent.trim())).click());
      await page.waitForFunction(name => { const button = document.querySelector('[data-help-tip] button'); return button && button.getAttribute('aria-label') !== name; }, {}, walletName);
      await checkDisclosure(0);
      assert.deepEqual(await page.$eval(trigger, el => ({ icon: el.firstElementChild.getAttribute('style'), button: el.getAttribute('style') })), walletStyle, 'Wallet and Community share identical help controls');
      await page.click(trigger); await placement();
      assert.equal(await page.evaluate(() => window.actions), 0, 'reading never selects community or invokes money actions');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${theme}/${lang} overflow`);
      if (width === 390 || width === 1100 && theme === 'light' && lang === 'en') await snapshot(`community-${width}-${theme}-${lang}.png`);
      console.log(`PASS Me Wallet/Community overlays ${width}px ${theme} ${lang}`);
    }
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  for (const theme of ['light', 'dark']) for (const lang of ['en', 'es', 'fr', 'sw']) {
    await go(`theme=${theme}&lang=${lang}`);
    await page.type('textarea', 'Keep this draft'); await page.type('input', 'fed1draft');
    for (const i of [0, 1, 2]) await checkDisclosure(i);
    assert.equal(await page.$eval('textarea', el => el.value), 'Keep this draft');
    assert.equal(await page.$eval('input', el => el.value), 'fed1draft');
    assert.equal(await page.evaluate(() => window.actions), 0, 'help never submits or bubbles to parent');
    assert.equal(await page.$('[data-help-link]'), null, 'collapsed content is unmounted');
    const parentButton = await page.$('[data-parent] button'); await parentButton.focus(); await page.keyboard.press('Enter');
    await page.keyboard.press('Tab'); assert.equal(await page.$eval('[data-help-link]', el => document.activeElement === el), true);
    await page.keyboard.press('Escape'); assert.equal(await parentButton.evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    assert.equal(await page.$('[data-help-popover]'), null, 'Tab continues into the task without trapping focus in help');
    assert.equal(await page.$eval('[data-show-modal]', el => document.activeElement === el), true);
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    await parentButton.click(); assert.equal(await page.$eval('[data-help-popover]', el => getComputedStyle(el).animationName), 'none');
    await parentButton.click(); await page.emulateMediaFeatures([]);
    for (const [opener, task] of [['[data-show-modal]', '[data-funding-task]'], ['[data-show-sheet]', '[data-overlay-backdrop]']]) {
      await page.click(opener); await page.waitForSelector(task);
      await page.click(`${task} [data-help-tip] button`); await placement(); await page.keyboard.press('Escape');
      assert.ok(await page.$(task), 'first Escape dismisses help and preserves task');
      assert.equal(await page.$eval(`${task} input`, el => el.value), '123');
      await page.keyboard.press('Escape'); assert.equal(await page.$(task), null, 'second Escape dismisses task');
      await page.click(opener); await page.click(`${task} [data-help-tip] button`);
      await page.mouse.click(2, 2); assert.equal(await page.$('[data-help-popover]'), null); assert.ok(await page.$(task), 'help backdrop keeps task open');
      await page.mouse.click(2, 2); assert.equal(await page.$(task), null, 'task backdrop still dismisses');
      await page.click(opener); assert.equal(await page.$eval(`${task} [data-help-tip] button`, el => el.getAttribute('aria-expanded')), 'false');
      await page.keyboard.press('Escape');
    }
    await page.click(trigger); await snapshot(`arbiter-${theme}-${lang}.png`); await page.keyboard.press('Escape');
    await page.click('[data-parent] button');
    await page.evaluate(() => history.pushState({}, '', '#help-preview'));
    await page.goBack(); await page.waitForFunction(() => !document.querySelector('[data-help-popover]'));
    assert.equal(await page.$eval('textarea', el => el.value), 'Keep this draft', 'back dismissal keeps draft');
    await page.click('[data-parent] button'); await page.goto(`${base}/tests/help-disclosures/?mode=me`); await page.goBack();
    await page.waitForSelector('[data-parent] button'); assert.equal(await page.$('[data-help-popover]'), null, 'navigation leaves no orphan help overlay');
    console.log(`PASS forms/overlay dismissal/drafts/reduced motion/back ${theme} ${lang}`);
  }
  for (const size of [{ width: 320, height: 280 }, { width: 390, height: 440 }]) {
    await page.setViewport(size); await go('mode=edge'); await page.click(trigger); await placement();
    await page.setViewport({ width: size.width + 10, height: size.height + 10 }); await placement();
    await page.$eval('[data-help-popover]', el => el.scrollTop = el.scrollHeight); await placement();
    await page.keyboard.press('Escape');
    console.log(`PASS clipped card/viewport edge/resize/long explanation ${size.width}x${size.height}`);
  }
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  for (const mode of ['custody-fund', 'custody-atomic', 'custody-lock']) {
    await page.goto(`${base}/tests/first-circle-phones/?mode=${mode}&theme=light&lang=en`);
    await page.waitForSelector('[data-money-custody] [data-help-tip] button'); await checkDisclosure(0);
    assert.equal(await page.evaluate(() => window.moneyCalls ?? 0), 0, 'custody help invokes no payment or wallet action');
    console.log(`PASS shared overlay on ${mode}`);
  }
  assert.deepEqual(errors, []);
  console.log('PASS all floating help checks; no browser errors');
} finally { await browser.close(); }
