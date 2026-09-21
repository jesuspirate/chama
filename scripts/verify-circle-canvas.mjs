// Start npm run dev first. All payment/publishing actions in the fixture are disabled.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser = await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 const base=process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3000';
 for (const lang of ['en', 'fr', 'sw']) {
 await page.evaluateOnNewDocument(lang=>localStorage.setItem('chama_lang',lang),lang);
 for(const [width,height,chrome] of [[1440,900,190],[768,850,190],[390,844,190],[320,667,150]]) {
  await page.setViewport({width,height,deviceScaleFactor:1});
  await page.goto(`${base}/tests/circle-canvas/index.html?chrome=${chrome}`);
  await page.waitForSelector('.circle-canvas');
  for(let step=0;step<4;step++) {
   const dims=await page.evaluate(()=>{
    const main=document.querySelector('.assisted-canvas-main');
    const button=document.querySelector('.circle-canvas-action button').getBoundingClientRect();
    const footer=document.querySelector('.assisted-canvas-footer').getBoundingClientRect();
    return {width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,buttonBottom:button.bottom,footerBottom:footer.bottom,overflow:main.scrollHeight-main.clientHeight};
   });
   assert.equal(dims.width,width,'no horizontal page overflow');
   assert.ok(dims.height<=height+1,`page overflow ${width} step ${step}: ${JSON.stringify(dims)}`);
   assert.ok(dims.buttonBottom<=height-60,'action stays above navigation');
   assert.ok(dims.footerBottom<=height-60+1,'progress stays above navigation');
   if(lang==='en' && (width>=390 && step<3 || width>=900)) assert.ok(dims.overflow<=1,`unnecessary question scrolling: ${JSON.stringify(dims)}`);
   console.log(`PASS ${lang} ${width}x${height} step ${step+1}: viewport fits; content overflow ${dims.overflow}px`);
   if(step<3) await page.click('.circle-canvas-action button');
  }
  await page.screenshot({path:`/tmp/chama-circle-${width}.png`,fullPage:true});
  // Back from a scrolled review must reveal the beginning of the previous question.
  await page.$eval('.assisted-canvas-main',el=>el.scrollTop=el.scrollHeight);
  await page.$eval('[data-chama-shortcut="back"]',el=>el.click());
  await page.waitForFunction(()=>document.querySelector('.assisted-canvas-main').scrollTop===0);
  // A dynamic banner must reduce available space without pushing the footer down.
  await page.$eval('header',el=>el.style.height=`${el.offsetHeight+50}px`);
  await page.waitForFunction(()=>document.documentElement.scrollHeight<=innerHeight+1);
 }
 }
 await page.goto(`${base}/tests/circle-canvas/index.html?brand=1`);
 await page.waitForSelector('[aria-label="Chama — community, trust, reputation"]');
 await page.screenshot({path:'/tmp/chama-brand-unified.png',fullPage:true});
} finally {await browser.close();}
