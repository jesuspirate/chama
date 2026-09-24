import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER??'/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try{
 const page=await browser.newPage(),base=process.env.CHAMA_PREVIEW??'http://127.0.0.1:3000';
 for(const theme of ['dark','light']){
  await page.setViewport({width:1170,height:800});await page.goto(`${base}/tests/brief11/?compare=1&theme=${theme}`);
  await page.waitForSelector('iframe');
  await page.waitForFunction(()=>document.querySelectorAll('iframe').length===3 && [...document.querySelectorAll('iframe')].every(f=>f.contentDocument?.querySelector('[role=tab]')));
  for(const frame of page.frames().slice(1)){await frame.waitForSelector('[role=tab]');assert.equal(await frame.evaluate(()=>document.documentElement.scrollWidth),390);}
  const layouts=[];
  for(const frame of page.frames().slice(1)) layouts.push(await frame.$eval('[role=tab]',e=>({height:e.getBoundingClientRect().height,radius:getComputedStyle(e).borderRadius,icon:getComputedStyle(e.querySelector('span')).display})));
  for(const layout of layouts){assert.equal(layout.height,44);assert.equal(layout.radius,'999px');assert.equal(layout.icon,'inline');}
  await page.evaluate(()=>window.scrollTo(0,0));
  await page.screenshot({path:`docs/verification/brief11-pagers-${theme}.png`,fullPage:true});
  await page.setViewport({width:390,height:844});await page.goto(`${base}/tests/brief11/?panel=claim&zero=1&theme=${theme}`);
  await page.waitForFunction(()=>document.body.textContent.includes("Lightning isn’t available"));
  assert.equal(await page.$eval('[data-funding-rail=lightning]',e=>e.disabled),true);
  assert.equal(await page.$eval('[data-funding-rail=ecash]',e=>e.getAttribute('aria-selected')),'true');
  assert.ok(!(await page.evaluate(()=>document.body.textContent)).includes('saved@strike.me'));
  await page.click('button.payment-button');await page.waitForFunction(()=>window.claimKind==='ecash');
 }
 console.log('PASS brief 11: shared inline pagers at 390px in dark/light; zero-gateway claim opens ecash and hides saved Lightning destinations');
}finally{await browser.close();}
