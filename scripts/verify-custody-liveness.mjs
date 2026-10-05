import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER??'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
try{
 const page=await browser.newPage();
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.evaluateOnNewDocument(()=>localStorage.setItem('chama_lang',new URLSearchParams(location.search).get('lang')??'en'));
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const go=async query=>{console.log(query);await page.goto(`${process.env.CHAMA_PREVIEW??"http://127.0.0.1:3211"}/tests/first-circle-phones/?${query}${query.includes("lang=") ? "" : "&lang=en"}`);await page.waitForSelector('main');};
 for(const lang of ['en','es','fr','sw']) for(const theme of ['light','dark']){
  await go(`mode=custody-wallet&lang=${lang}&theme=${theme}`);
  await page.waitForFunction(()=>document.querySelector('[data-money-custody]')?.textContent.includes('4'));
  const button='[data-inline-explanation] button';
  assert.equal(await page.$eval(button,e=>e.getAttribute('aria-expanded')),'false');
  assert.equal(await page.$('[data-help-popover]'),null);
  const box=await page.$eval(button,e=>{const r=e.getBoundingClientRect();return {w:r.width,h:r.height};});assert.ok(box.w>=44&&box.h>=44);
  await page.screenshot({path:`outputs/first-circle-phones/custody-wallet-${lang}-${theme}.png`,fullPage:true});
  await page.click(button);assert.equal(await page.$eval(button,e=>e.getAttribute('aria-expanded')),'true');
  assert.ok(await page.$eval('[data-help-popover] [id]',e=>e.textContent.length>40));
  await new Promise(r=>setTimeout(r,180));
  await page.screenshot({path:`outputs/first-circle-phones/custody-explanation-${lang}-${theme}.png`,fullPage:true});
  await page.focus(button);await page.keyboard.press('Escape');assert.equal(await page.$eval(button,e=>e.getAttribute('aria-expanded')),'false');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await go(`mode=custody-faq&lang=${lang}&theme=${theme}`);await page.click('main button[aria-expanded]');await page.waitForSelector('table');assert.equal(await page.$$eval('tbody tr',els=>els.length),5);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
  await page.screenshot({path:`outputs/first-circle-phones/custody-faq-${lang}-${theme}.png`,fullPage:true});
 }
 for(const mode of ['custody-fund','custody-atomic','custody-lock']){
  await go(`mode=${mode}&theme=light`);await page.waitForFunction(()=>document.querySelector('[data-money-custody]')?.textContent.includes('4 guardians'));
  await page.click('[data-inline-explanation] button');assert.equal(await page.evaluate(()=>window.moneyCalls??0),0,'reading custody does not start a money action');
  await new Promise(r=>setTimeout(r,180));
  await page.screenshot({path:`outputs/first-circle-phones/${mode}.png`,fullPage:true});
 }
 await go('mode=custody-atomic&theme=light&circle=1');await page.waitForFunction(()=>document.querySelector('[data-money-custody]')?.textContent.includes('4 guardians'));assert.equal(await page.$$eval('[data-inline-explanation]',els=>els.length),1);assert.doesNotMatch(await page.$eval('[data-federation-disclosure]',e=>e.textContent),/4 guardians/,'circle funding keeps one holder line and its earned warnings');
 await go('mode=custody-lock&theme=light&long=1&one=1');await page.waitForSelector('[data-custody-warning=operator]');assert.match(await page.$eval('[data-money-custody]',e=>e.textContent),/30 days/);
 assert.equal(await page.$eval('[data-custody-warning=operator]',e=>e.getBoundingClientRect().height>0),true,'earned warning stays visible without opening explanation');
 await go('mode=custody-lock&theme=light&bitcoin=1');assert.match(await page.$eval('[data-money-custody]',e=>e.textContent),/970000/);assert.equal(await page.$('[data-money-custody=ecash]'),null);
 await go('mode=custody-wallet&theme=light&unknown=1');await page.waitForFunction(()=>document.querySelector('[data-money-custody]')?.textContent.includes('count unknown'));assert.doesNotMatch(await page.$eval('[data-money-custody]',e=>e.textContent),/0 guardians/);
 await go('mode=liveness-test&theme=light');await page.waitForFunction(()=>document.querySelector('main')?.textContent.includes('couldn’t check yet'));
 assert.equal(await page.$('[role=img]'),null);assert.equal(await page.evaluate(()=>window.livenessCalls),1);
 await page.screenshot({path:'outputs/first-circle-phones/liveness-unknown-after.png',fullPage:true});
 await page.evaluate(()=>window.livenessNext='verified');const retry=await page.$('main button:not([aria-expanded])');await retry.click();await page.waitForSelector('[role=img]');assert.equal(await page.evaluate(()=>window.livenessCalls),2,'retry triggers one fresh generation');
 assert.match(await page.$eval('main',e=>e.textContent),/no bonded arbiters/i);
 assert.deepEqual(errors,[]);console.log('Custody disclosure, warnings, four languages, both themes and liveness retry passed');
}finally{await browser.close();}
