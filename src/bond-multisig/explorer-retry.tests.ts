import assert from 'node:assert/strict';
import { esploraFetcher, EsploraUnavailableError, SETTLEMENT_EXPLORER_TIMEOUT_MS } from './fund-watcher.js';
import { MAINNET, SIGNET } from './multisig.js';
import { explorerRetryDelay, retryExplorerRead } from './explorer-retry.js';
assert.equal(SETTLEMENT_EXPLORER_TIMEOUT_MS,20_000);
assert.deepEqual([0,1,2,3,4].map(explorerRetryDelay),[5000,10000,20000,30000,30000]);
const originalFetch=globalThis.fetch,originalWarn=console.warn;
const hosts:string[]=[],warnings:unknown[][]=[];
console.warn=(...args)=>warnings.push(args);
try {
 globalThis.fetch=(async(url)=>{hosts.push(new URL(String(url)).host);if(String(url).includes('mempool.emzy.de'))return {ok:true,json:async()=>42} as Response;throw new TypeError('Failed to fetch');}) as typeof fetch;
 assert.equal(await esploraFetcher('https://mempool.space/api',{network:MAINNET})('/blocks/tip/height'),42);
 assert.deepEqual(hosts.sort(),['blockstream.info','mempool.emzy.de','mempool.space']);
 assert.ok(warnings.some(w=>String(w[0]).includes('mempool.space')));
 hosts.length=0;
 await assert.rejects(esploraFetcher('https://private.example/api',{network:MAINNET})('/blocks/tip/height'),EsploraUnavailableError);
 assert.deepEqual(hosts,['private.example'],'custom explorers never leak requests to public hedges');
 hosts.length=0;
 await assert.rejects(esploraFetcher('https://mutinynet.com/api',{network:SIGNET})('/blocks/tip/height'),EsploraUnavailableError);
 assert.deepEqual(hosts,['mutinynet.com']);
 globalThis.fetch=((url,opts)=>new Promise((_resolve,reject)=>{hosts.push(new URL(String(url)).host);opts?.signal?.addEventListener('abort',()=>reject(opts.signal!.reason));})) as typeof fetch;
 await assert.rejects(esploraFetcher('https://mempool.space/api',{network:MAINNET,timeoutMs:5})('/blocks/tip/height'),error=>error instanceof EsploraUnavailableError&&error.hosts.length===3);
} finally {globalThis.fetch=originalFetch;console.warn=originalWarn;}
const queue:Array<()=>void>=[],delays:number[]=[];
let attempts=0,success=0,failures=0;
const cancel=retryExplorerRead({read:async()=>{attempts++;if(attempts<4)throw new EsploraUnavailableError([],[]);return 7;},success:value=>{success=value;},failure:()=>failures++,schedule:(run,delay)=>{queue.push(run);delays.push(delay);return 1 as any;},clear:()=>{queue.length=0;}});
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
await flush();while(queue.length){queue.shift()!();await flush();}
assert.equal(success,7);assert.equal(failures,3);assert.deepEqual(delays,[5000,10000,20000]);cancel();
retryExplorerRead({read:async()=>{throw Error('Wrong destination');},success:()=>assert.fail(),failure:()=>{},schedule:()=>{assert.fail('Real failures must not retry');}});await flush();
let resolveLate!:(value:number)=>void;
const stop=retryExplorerRead({read:()=>new Promise<number>(r=>resolveLate=r),success:()=>assert.fail('Unmounted result applied'),failure:()=>assert.fail()});stop();resolveLate(1);await flush();
console.log('PASS explorer failures: third hedge, per-host logs, custom/signet isolation, all-host timeout, capped retry, real mismatch and unmount cancellation');
