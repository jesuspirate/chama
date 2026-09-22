// Deterministic export of the existing share-card layout with the approved mark.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const template=path.join(root,'assets/brand/templates/exchange.svg');
const svg=fs.readFileSync(template,'utf8').replace(/href="([^"]+)"/g,(_,name)=>`href="data:image/png;base64,${fs.readFileSync(path.resolve(path.dirname(template),name)).toString('base64')}"`);
const browser=await puppeteer.launch({executablePath:process.env.CHAMA_BROWSER ?? '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',headless:true,args:['--no-sandbox']});
try {
 const page=await browser.newPage();await page.setViewport({width:1200,height:630,deviceScaleFactor:1});
 await page.setContent(`<style>html,body{margin:0;width:1200px;height:630px}img{display:block}</style><img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}">`);
 await page.evaluate(()=>document.querySelector('img').decode());
 await page.screenshot({path:path.join(root,'public/icons/chama-social-exchange.png')});
 fs.copyFileSync(path.join(root,'public/icons/chama-social-exchange.png'),path.join(root,'public/icons/getchama-social-exchange-v1.png'));
 console.log('Exported share-card header from the approved master.');
} finally {await browser.close();}
