// Run npm run dev first. Checks the real component and the actual landing pages.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();
 const base=process.env.CHAMA_PREVIEW ?? 'http://127.0.0.1:3000';
 async function check(selector,diameters,color) {
  const values=await page.$$eval(selector,dots=>dots.map(dot=>{
   const marker=document.createElement('span');
   marker.style.cssText='display:inline-block;width:0;height:0;vertical-align:baseline';
   dot.after(marker);
   const box=dot.getBoundingClientRect(),baseline=marker.getBoundingClientRect().bottom;
   marker.remove();
   const style=getComputedStyle(dot);
   return {width:box.width,height:box.height,baselineError:Math.abs(box.bottom-baseline),color:style.backgroundColor,text:dot.textContent};
  }));
  assert.equal(values.length,diameters.length);
  values.forEach((v,i)=>{assert.equal(v.width,diameters[i]);assert.equal(v.height,diameters[i]);assert.ok(v.baselineError<0.6,JSON.stringify(v));assert.equal(v.color,color);assert.equal(v.text,'');});
 }
 for(const theme of ['light','dark']) {
  await page.setViewport({width:460,height:620,deviceScaleFactor:2});
  await page.goto(`${base}/tests/wordmark-dot/index.html?theme=${theme}`);
  await page.waitForSelector('.sample');await page.evaluate(()=>document.fonts.ready);
  await check('.sample span[aria-hidden][style*="inline-block"]',[8,7,5],theme==='light'?'rgb(196, 115, 8)':'rgb(247, 147, 26)');
  await page.screenshot({path:`/tmp/chama-wordmark-${theme}.png`,fullPage:true});
  console.log(`PASS app ${theme}: 27/24/17px type, drawn dots on baseline`);
 }
 for(const [width,diameter] of [[1280,9],[700,7],[360,6]]) for(const theme of ['light','dark']) {
  await page.setViewport({width,height:900,deviceScaleFactor:1});
  await page.goto(`${base}/landing/index.html`,{waitUntil:'domcontentloaded'});
  await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
  await check('.nav .brand-dot',[diameter],theme==='light'?'rgb(196, 115, 8)':'rgb(247, 147, 26)');
  assert.equal(await page.$$('.footer-brand .brand-dot').then(x=>x.length),0,'index footer unchanged');
  await (await page.$('.nav .brand')).screenshot({path:`/tmp/chama-landing-dot-${width}-${theme}.png`});
  console.log(`PASS landing ${width}px ${theme}: ${diameter}px dot on baseline`);
 }
 for(const file of ['faq.html','faq.es.html','faq.fr.html']) for(const width of [1280,600]) {
  await page.setViewport({width,height:900,deviceScaleFactor:1});
  await page.goto(`${base}/landing/${file}`,{waitUntil:'domcontentloaded'});
  await check('.brand-dot',width===600?[8,8]:[9,9],'rgb(196, 115, 8)');
  console.log(`PASS ${file} ${width}px: nav/footer dots visible on baseline`);
 }
} finally {await browser.close();}
