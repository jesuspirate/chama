import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({ executablePath: process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
try {
 const page = await browser.newPage();
 await page.setViewport({width:320,height:900,deviceScaleFactor:1});
 page.on('pageerror', e => console.error('PAGE:', e.message));
 const base = process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3000';
 for (const lang of ['fr','sw']) for (const theme of ['dark','light']) {
   await page.evaluateOnNewDocument(lang => localStorage.setItem('chama_lang',lang),lang);
   await page.goto(`${base}/tests/payment-card/index.html?theme=${theme}`);
   await page.waitForSelector('#bond img[src^="data:"]');
   const dimensions = () => page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.querySelector('.payment-card').getBoundingClientRect().height,
     chipY: document.querySelector('.payment-copy').getBoundingClientRect().y }));
   const before = await dimensions(); assert.equal(before.width,320,`${lang}/${theme} overflow`);
   await page.evaluate(() => window.setPhase('confirming'));
   await page.waitForFunction(() => document.querySelector('.chama-loader-motion'));
   assert.deepEqual(await dimensions(),before,'state changes must not move copy or resize the card');
   await page.screenshot({path:`/tmp/chama-payment-${lang}-${theme}.png`, fullPage:true});
   // Read the rendered 180px QR including the rounded plate and logo, rather
   // than testing only the encoder output.
   const qr = await page.$('#bond');
   const png = await qr.screenshot({encoding:'base64'});
   const decoded = await page.evaluate(async png => {
     const img = new Image(); img.src = `data:image/png;base64,${png}`; await img.decode();
     const canvas = document.createElement('canvas'); canvas.width=img.width; canvas.height=img.height;
     const ctx=canvas.getContext('2d'); ctx.drawImage(img,0,0); const pixels=ctx.getImageData(0,0,img.width,img.height);
     return window.jsQR(pixels.data,pixels.width,pixels.height)?.data;
   }, png);
   assert.equal(decoded,await page.evaluate(()=>window.payload),'180px QR with default margin must decode');
   const colors=await page.$$eval('#bond svg path',paths=>paths.map(p=>p.getAttribute('stroke')));
   assert.deepEqual(colors,['#F7931A','#2EE6D6','#BF5AF2','#F7931A']);
   await page.click('.payment-copy');
   assert.ok(await page.$('.payment-copy.is-copied'));
   await page.waitForFunction(()=>!document.querySelector('.payment-copy.is-copied'));
   console.log(`PASS 320px ${lang}/${theme}: stable geometry, copy feedback, brand palette, 180px QR decode`);
 }
 await page.goto(`${base}/tests/payment-card/index.html?atomic=1`);
 await page.waitForSelector('[role=tab]');
 await page.evaluate(()=>document.querySelector('button.payment-button:not([disabled])').click());
 await page.waitForSelector('.payment-card img[src^="data:"]');
 await page.click('[role=tab]:nth-of-type(2)');
 assert.equal(await page.$eval('[role=dialog] button.payment-button:last-child', e=>e.disabled),true,'live invoice switch must not abandon a payable invoice');
 await page.click('[role=dialog] button.payment-button');
 const before=await page.$eval('.payment-card',e=>({height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}));
 for (const kind of ['mint-confirming','mint-confirming-slow','payment-confirmed','locking']) {
   await page.evaluate(kind=>window.phase(kind),kind);
   await page.waitForFunction(()=>document.querySelector('.chama-loader-motion'));
   assert.deepEqual(await page.$eval('.payment-card',e=>({height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top})),before);
 }
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);
 console.log('PASS actual atomic funding modal: waiting/detected/confirming/locking share fixed geometry');
 await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
 assert.equal(await page.$eval('.chama-loader-motion',e=>getComputedStyle(e).display),'none');
 assert.equal(await page.$eval('.chama-loader-static',e=>getComputedStyle(e).display),'block');
 await page.goto(`${base}/tests/payment-card/index.html?atomic=1`);
 await page.waitForSelector('[role=tab]');
 await page.click('[role=tab]:nth-of-type(2)');
 await page.waitForSelector('button.payment-button:not([disabled])');
 await page.click('button.payment-button:not([disabled])');
 await page.waitForSelector('.payment-card img[src^="data:"]');
 assert.ok((await page.$eval('.payment-card',e=>e.textContent)).includes('2,100'),'onchain headline includes fee');
 await page.click('.payment-card details summary');
 assert.ok((await page.$eval('.payment-card details',e=>e.textContent)).includes('2,000'),'details retain trade amount');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320);
 console.log('PASS onchain: send total includes fee, details retain principal, no 320px overflow');
 for (const surface of ['wallet','ecash']) {
   await page.goto(`${base}/tests/payment-card/index.html?${surface}=1`);
   if (surface==='wallet') {
     await page.waitForSelector('input[type=number]');
     await page.evaluate(()=>[...document.querySelectorAll('button')].find(b=>b.textContent.includes('ankara') || b.textContent.includes('Ankara')).click());
   }
   await page.waitForSelector('.payment-card img[src^="data:"]');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),320,`${surface} overflow`);
   await page.screenshot({path:`/tmp/chama-payment-${surface}-320.png`,fullPage:true});
   if (surface==='wallet') {
     const height=await page.$eval('.payment-card',e=>e.getBoundingClientRect().height);
     await page.evaluate(()=>window.credit());
     await page.waitForFunction(()=>document.querySelector('.chama-loader-motion'));
     assert.equal(await page.$eval('.payment-card',e=>e.getBoundingClientRect().height),height);
   }
   console.log(`PASS ${surface}: real modal at 320px`);
 }

 for (const mode of ['slow','stuck']) {
   await page.goto(`${base}/tests/payment-card/index.html?sim=1&simchain=1&onchain=${mode}`);
   await page.waitForSelector('[role=tab]');
   await page.click('[role=tab]:nth-of-type(2)');
   await page.waitForSelector('button.payment-button:not([disabled])');
   await page.click('button.payment-button:not([disabled])');
   await page.waitForSelector('.payment-card img[src^="data:"]');
   assert.ok((await page.$eval('.payment-card',e=>e.textContent)).includes('3,000'),'sim deposit asks for principal plus real fixture fee');
   await page.click('.payment-card details summary');
   assert.ok((await page.$eval('.payment-card details',e=>e.textContent)).includes('1,000'),'nonzero deposit fee is visible');
   await page.click('.payment-card details summary');
   const size=()=>page.$eval('.payment-card',e=>({height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top}));
   const initial=await size();
   if(mode==='slow') {
     await page.waitForFunction(()=>window.depositStates.some(p=>p.status==='confirming'));
     assert.deepEqual(await size(),initial,'on-chain stages preserve card geometry');
     await page.screenshot({path:'/tmp/chama-sim-onchain-confirming.png',fullPage:true});
   } else {
     await new Promise(r=>setTimeout(r,3000));
     assert.deepEqual(await page.evaluate(()=>window.depositStates.map(p=>p.status)),['pending']);
     assert.deepEqual(await size(),initial);
   }
   assert.equal((await page.$$('[role=tab]')).length,1,'An issued address exposes only its current rail');
   assert.equal(await page.$('[role=dialog]'),null,'No new rail is offered after address creation');
   if(mode==='slow') await page.waitForFunction(()=>!!window.simLockedNotes,{timeout:60000});
   console.log(`PASS sim onchain ${mode}: nonzero total/fee, stable card, no rail switch${mode==='slow'?', net deposit funds simulated lock':''}`);
 }
 for(const theme of ['light','dark']) {
   await page.goto(`${base}/tests/payment-card/index.html?market=1&theme=${theme}`);
   await page.waitForSelector('[data-store-watermark]');
   assert.equal(await page.$eval('[data-store-watermark]',e=>getComputedStyle(e).mixBlendMode),theme==='light'?'normal':'screen');
   if(theme==='light') assert.equal(await page.$eval('[data-store-watermark]',e=>getComputedStyle(e).maskPosition),'calc(100% - 20px) 50%','The emblem remains on the right, clear of the title');
   await page.screenshot({path:`/tmp/chama-market-${theme}.png`,fullPage:true});
 }
 await page.goto(`${base}/tests/payment-card/index.html?market=1&persistent=1`);
 await page.waitForSelector('[data-store-watermark]');
 assert.equal(await page.evaluate(()=>/\d{10,}h/.test(document.body.textContent)),false,'Persistent storefronts cannot print a sentinel hour count');
 await page.goto(`${base}/tests/payment-card/index.html?summary=1`);
 await page.waitForFunction(()=>document.body.textContent.includes(window.expected.summary));
 assert.equal(await page.evaluate(()=>document.body.textContent.includes(window.expected.outcome)),false,'summary must not assert refund outcome');
 assert.equal(await page.evaluate(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===window.expected.claim)),false,'summary must not render Claim CTA');
 console.log('PASS actual trade detail: summary copy replaces outcome and Claim CTA is absent');
 await page.setViewport({width:390,height:1000,deviceScaleFactor:1});
 await page.goto(`${base}/tests/payment-card/index.html?attention=1`);
 await page.waitForSelector('[data-money-safety-focus]');
 assert.equal((await page.$$('[data-money-safety-focus]')).length,1);
 assert.equal((await page.$$('[data-money-safety-row]')).length,3);
 assert.equal(await page.$eval('[data-money-safety-quiet]',e=>e.dataset.tone),'muted');
 const visibleGlows=await page.$$eval('[data-money-safety-focus] *, [data-money-safety-quiet] *',els=>els.filter(e=>getComputedStyle(e).boxShadow!=='none').length);
 assert.equal(visibleGlows,1,'exactly one money-safety glow at 390px');
 for(const key of ['claim:two','leftover','lock:stuck']) await page.click(`[data-money-safety-row="${key}"] > button`);
 assert.deepEqual(await page.evaluate(()=>window.tapped),['claim:two','recover','trade:stuck'],'quiet rows call their existing handlers directly');
 await page.screenshot({path:'/tmp/chama-attention-live-390.png',fullPage:true});
 console.log('PASS Me: one glow, three quiet rows, each action reachable in one tap');
 await page.goto(`${base}/tests/payment-card/index.html?chat=1`);
 await page.waitForSelector('[data-chat-retention-note]');
 await page.evaluate(()=>window.setRelay(true));
 await page.waitForFunction(()=>!document.querySelector('[data-chat-retention-note]'));
 console.log('PASS chat: retention note follows preferred relay connection');
 for (const [lang,cause,mapped] of [['fr','blocked',false],['sw','blocked',true],['fr','corrupt',true],['sw','corrupt',false]]) {
   const storagePage=await browser.newPage();
   await storagePage.setViewport({width:320,height:900});
   await storagePage.evaluateOnNewDocument(lang=>localStorage.setItem('chama_lang',lang),lang);
   await storagePage.goto(`${base}/tests/payment-card/index.html?storage=${cause}${mapped?'&mapped=1':''}`);
   await storagePage.waitForSelector('button.payment-button:not([disabled])');
   await storagePage.click('button.payment-button:not([disabled])');
   await storagePage.waitForSelector('[data-funding-preflight]');
   const result=await storagePage.evaluate(()=>({copy:window.storageCopy,text:document.querySelector('[data-funding-preflight]').textContent,calls:window.invoiceCalls,overflow:document.documentElement.scrollWidth>innerWidth}));
   assert.ok(result.text.includes(result.copy.title));assert.ok(result.text.includes(result.copy.body));
   assert.ok(result.text.includes(result.copy[cause]));assert.equal(result.calls,0);
   assert.equal(result.overflow,false);
   assert.equal(await storagePage.$('.payment-card img[src^="data:"]'),null,'no invoice is shown after preflight refusal');
   await storagePage.screenshot({path:`/tmp/chama-funding-storage-${lang}-${cause}.png`,fullPage:true});
   await storagePage.click('[data-funding-preflight] button:first-of-type');
   await storagePage.waitForSelector('[role=tab]');
   await storagePage.click('button.payment-button:not([disabled])');
   await storagePage.waitForSelector('[data-funding-preflight]');
   await storagePage.click('[data-funding-preflight] button:last-of-type');
   assert.equal(await storagePage.evaluate(()=>window.fundingClosed),true,'cancel remains reachable');
   await storagePage.close();
   console.log(`PASS ${lang} storage ${cause}: preflight remedy, no invoice, retry and cancel (${mapped?'hook phase':'rejected action'})`);
 }
} finally { await browser.close(); }
