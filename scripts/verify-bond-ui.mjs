import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
const browser = await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true});
try {
 const page=await browser.newPage(), errors=[];
 page.on('pageerror', e=>{errors.push(e.message);console.error(e.message);});
 await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
 await page.evaluateOnNewDocument(()=>localStorage.setItem('chama_lang',new URLSearchParams(location.search).get('lang')??'en'));
 const go=async query=>{await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3211'}/tests/bond-retirement/?${query}`);await page.waitForSelector('[data-bond-ceremony]');};
 const clickText=async text=>{for(const b of await page.$$('button'))if((await b.evaluate(e=>e.textContent)).includes(text)){await b.click();return;}throw Error(`Button missing: ${text}`);};
 const viewport=async()=>assert.equal(await page.evaluate(()=>{
  const sheet=document.querySelector('[data-overlay-backdrop] > [role=dialog]');return sheet.scrollWidth<=sheet.clientWidth && document.documentElement.scrollWidth<=innerWidth;
 }),true,'no horizontal scrolling in the sheet');
 await mkdir('outputs/first-circle-phones',{recursive:true});
 await page.goto(`${process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3211'}/tests/bond-retirement/?lang=en`);
 await page.waitForFunction(()=>document.body.textContent.includes('Storefront-only bonds'));
 await clickText('Manage');await page.waitForSelector('[data-bond-ceremony]');
 await clickText('Post a new bond');await page.waitForSelector('input[inputmode=numeric]');
 await page.$eval('input[inputmode=numeric]',e=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'34000');e.dispatchEvent(new Event('input',{bubbles:true}));});
 await clickText('~1 week');
 const help='[data-bond-ceremony] [data-help-tip] button';
 await page.click(help);await page.waitForSelector('[data-help-popover]');
 assert.match(await page.$eval('[data-help-popover]',e=>e.textContent),/Chama cannot take/);
 assert.deepEqual(await page.evaluate(()=>[window.moneyCalls,window.buildCalls.length,window.publications.length]),[0,0,0]);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-help-popover]'));
 assert.ok(await page.$('[data-bond-ceremony]'),'Escape dismisses help before the bond sheet');
 assert.equal(await page.$eval('input[inputmode=numeric]',e=>e.value),'34000');
 assert.equal(await page.$eval('.bond-term[aria-pressed=true]',e=>e.textContent),'~1 week');
 // Pointer selection ending on the backdrop must preserve the task.
 const input=await page.$('input[inputmode=numeric]'), box=await input.boundingBox();
 await page.mouse.move(box.x+12,box.y+12);await page.mouse.down();await page.mouse.move(2,2);await page.mouse.up();
 assert.ok(await page.$('[data-bond-ceremony]'));
 await page.click(help);await page.waitForSelector('[data-help-popover]');
 await page.keyboard.press('Tab');await page.waitForFunction(()=>!document.querySelector('[data-help-popover]'));
 assert.equal(await page.evaluate(()=>document.querySelector('[data-overlay-backdrop] > [role=dialog]').contains(document.activeElement)),true);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('[data-bond-ceremony]'));
 assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Manage','focus returns to opener');
 for(const lang of ['en','es','fr','sw']) for(const theme of ['light','dark']) {
   for(const phase of ['locked','empty','created','expired','reclaimed']) {
     await go(`open=1&lang=${lang}&theme=${theme}&phase=${phase}`);
     if(phase==='locked'){await clickText('21000');await page.waitForSelector('[data-inline-explanation]');}
     if(phase==='created'){await clickText('21000');await page.waitForSelector('[data-inline-explanation]');}
     if(phase==='expired'){
       await page.waitForSelector('[data-bond-ceremony] .payment-button');
       await page.click('[data-bond-ceremony] .payment-button');await page.waitForSelector('.bond-term');
     }
     if(phase==='reclaimed'){
       await page.click('[data-bond-ceremony] button[aria-expanded]');await page.waitForFunction(()=>[...document.querySelectorAll('[data-bond-ceremony] button')].some(e=>e.textContent.includes('21000')));
       await clickText('21000');
     }
     await viewport();
     assert.doesNotMatch(await page.$eval('[data-bond-ceremony]',e=>e.innerText),/bond\.[a-zA-Z]/,'all visible strings resolve');
     await page.screenshot({path:`outputs/first-circle-phones/bond-ui-${phase}-${lang}-${theme}.png`});
     const trigger=await page.$(help);
     if(trigger){await trigger.click();await page.waitForSelector('[data-help-popover]');
       assert.equal(await page.$eval('[data-help-popover]',e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}),true);
       await page.keyboard.press('Escape');}
     assert.equal(await page.evaluate(()=>window.moneyCalls),0);
   }
 }
 await go('open=1&lang=en&phase=expired');
 await page.waitForFunction(()=>document.body.textContent.includes('Renew expired'));
 await page.click('[data-bond-ceremony] button');await page.waitForSelector('.bond-term');
 await clickText('Reclaim my bond');await page.waitForSelector('button[aria-pressed]');
 await page.waitForFunction(()=>document.body.textContent.includes('estimated net 20800'));
 assert.match(await page.$eval('[data-bond-ceremony]',e=>e.textContent),/ends this bond/,'consequence stays visible');
 await clickText('My own Bitcoin address');await page.waitForSelector('input[placeholder="bc1…"]');
 assert.equal(await page.$eval('button.payment-button',e=>e.disabled),true,'empty destination cannot reclaim');
 await page.$eval('input[placeholder="bc1…"]',e=>{const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(e,'not a bitcoin address');e.dispatchEvent(new Event('input',{bubbles:true}));});
 assert.equal(await page.$eval('button.payment-button',e=>e.disabled),true);
 await viewport();await page.screenshot({path:'outputs/first-circle-phones/bond-ui-reclaim-en-light.png'});
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 await clickText('Cancel');await page.click(help);await page.waitForSelector('[data-help-popover]');
 await page.evaluate(()=>window.dispatchEvent(new PopStateEvent('popstate')));await page.waitForFunction(()=>!document.querySelector('[data-help-popover]'));
 assert.ok(await page.$('[data-bond-ceremony]'));
 assert.deepEqual(errors,[]);
 console.log('Bond UI: all states, four languages, both themes, help/focus/draft/drag/Back and reclaim boundaries passed');
}finally{await browser.close();}
