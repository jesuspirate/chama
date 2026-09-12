// Research regressions: malformed policy data, durable watch coverage and ownership.
import * as fs from 'node:fs';import * as os from 'node:os';import * as path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {startNode,mine,fundKey,keypair,btc,REGTEST,hex,type Rpc} from './lib.js';
import {admit} from './admission.js';import {ChainIndex,ChainChanged,ConcurrentIndexUpdate} from './chain-index.js';import {DeviceSponsorPool} from './sponsor-ownership.js';
const rows:any[]=[];let complete=false;const check=(id:string,ok:boolean,evidence:any={})=>{rows.push({id,ok,evidence});console.log(ok?'PASS':'FAIL',id,JSON.stringify(evidence,(_,v)=>typeof v==='bigint'?v.toString():v));};
async function main(){const node=await startNode(20699),rpc=node.rpc,dir=fs.mkdtempSync(path.join(os.tmpdir(),'aio-audit-'));try{
 const base={escrowSats:1000000,capSats:20000,assumedFeeRange:{lowSatPerVb:1,highSatPerVb:20},stageVsize:{ruling:361,appeal:361},minRelaySatPerVb:0.1,confirmedUnreservedLiquiditySats:60000,outstandingSignedCeilingSats:10000,timing:{tipHeight:100,refundHeight:400,W:144,expectedRulingBlocks:36,expectedAppealBlocks:36,safetyMarginBlocks:24},maxFeeFractionOfEscrow:0.05};
 for(const [name,patch] of [['NaN cap',{capSats:NaN}],['infinite liquidity',{confirmedUnreservedLiquiditySats:Infinity}],['negative stage',{stageVsize:{ruling:-1,appeal:361}}],['fractional W',{timing:{...base.timing,W:144.5}}]] as const){const r=admit({...base,...patch});check('reject '+name,!r.admitted,r);}
 const edge=admit({...base,timing:{...base.timing,W:60}});check('appeal exclusive window counts W-1',!edge.admitted,edge);
 const hostile=admit({...base,competingFeeCeilingSats:{ruling:12000,appeal:12000}});check('explicit competing bids constrain both-stage admission',!hostile.admitted&&hostile.numbers.worstBoth>20000,hostile);
 await mine(rpc,110);const a=keypair(),b=keypair(),coin=await fundKey(rpc,a.xonly,50000n);const h=await rpc<number>('getblockcount'),parent=await rpc<string>('getblockhash',[h-1]);
 // Abort cursor write inside SQLite; transaction rows must roll back with it.
 const atomicFile=path.join(dir,'atomic.sqlite');const idx=new ChainIndex(atomicFile,10,'A');idx.init(h,parent);idx.watchTx(coin.txid,h);
 const sql=new DatabaseSync(atomicFile);sql.exec(`CREATE TRIGGER fail_block BEFORE INSERT ON blocks WHEN NEW.height=${h} BEGIN SELECT RAISE(ABORT,'injected block commit failure'); END;`);
 let failed=false;try{await idx.sync(rpc);}catch{failed=true;}check('failed block commit leaves no transaction rows',failed&&idx.status(coin.txid)===null&&idx.cursor?.height===h-1,{failed,status:idx.status(coin.txid),cursor:idx.cursor});sql.exec('DROP TRIGGER fail_block');sql.close();await idx.sync(rpc);idx.close();
 const lateFile=path.join(dir,'late.sqlite');let late=new ChainIndex(lateFile,10,'A');late.init(h,parent);await late.sync(rpc);late.watchTx(coin.txid,h);late.close();late=new ChainIndex(lateFile,10,'A');await late.sync(rpc);check('late-watch rescan survives restart',late.status(coin.txid)?.height===h,{status:late.status(coin.txid)});late.close();
 // Earlier birth registration must broaden existing coverage, not be ignored.
 const earlier=new ChainIndex(path.join(dir,'earlier.sqlite'),10,'A');earlier.init(h,parent);await earlier.sync(rpc);earlier.watchTx(coin.txid,h+1);await earlier.sync(rpc);earlier.watchTx(coin.txid,h);await earlier.sync(rpc);check('earlier birth updates existing watch',earlier.status(coin.txid)?.height===h,{status:earlier.status(coin.txid)});earlier.close();
 // Disappear during a rescan, restart, retry: no durable coverage request may be lost.
 const missFile=path.join(dir,'missing.sqlite');let missing=new ChainIndex(missFile,10,'A');missing.init(h,parent);await missing.sync(rpc);missing.watchTx(coin.txid,h);
 const broken:Rpc=async(m,p,w)=>{if(m==='getblock')throw new Error('temporarily missing');return rpc(m,p,w);};try{await missing.sync(broken);}catch{}missing.close();missing=new ChainIndex(missFile,10,'A');await missing.sync(rpc);check('failed rescan survives restart and retries',missing.status(coin.txid)?.height===h,{status:missing.status(coin.txid)});missing.close();
 // Pin the script at construction in the corrected implementation. Old code ignores the extra argument.
 const script=hex(btc.p2tr(a.xonly,undefined,REGTEST).script),otherScript=hex(btc.p2tr(b.xonly,undefined,REGTEST).script);
 const pool=new (DeviceSponsorPool as any)(path.join(dir,'pool.sqlite'),'A',script) as DeviceSponsorPool;
 const foreign=await fundKey(rpc,b.xonly,60000n);pool.register(foreign);
 let foreignResult:any=null;try{foreignResult=await pool.reserve(rpc,'foreign',otherScript);}catch{}
 check('foreign coin remains refused after local registration',foreignResult===null,{reserved:foreignResult});
 pool.register({...coin,amount:999999n});const wrong=await pool.reserve(rpc,'wrong-amount',script);check('registered amount must match confirmed output',wrong===null,{reserved:wrong});
 // Raw registry sum is not live, confirmed fee liquidity.
 pool.register({txid:'aa'.repeat(32),vout:0,amount:1000000n});const inventory=pool.unreservedSats();const live=await (pool as any).available(rpc);check('inventory must not masquerade as validated liquidity',live.totalSats===0&&inventory>0,{registeredOnly:inventory,live:live.totalSats});pool.close();
 // Two independent index connections cannot commit from one stale cursor.
 const concurrentFile=path.join(dir,'concurrent.sqlite');const one=new ChainIndex(concurrentFile,10,'A'),two=new ChainIndex(concurrentFile,10,'A');one.init(h,parent);one.watchTx(coin.txid,h);
 const contenders=await Promise.allSettled([one.sync(rpc),two.sync(rpc)]);
 const rejected=contenders.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
 check('concurrent index writers reject stale cursors',contenders.some(r=>r.status==='fulfilled')&&rejected.length===1&&rejected[0].reason instanceof ConcurrentIndexUpdate&&one.cursor?.hash===await rpc<string>('getbestblockhash'),{outcomes:contenders.map(r=>r.status),errors:rejected.map(r=>String(r.reason))});one.close();two.close();
 // Change the active block after getblock returns, before it can be committed.
 const probe=await fundKey(rpc,b.xonly,10000n),ph=await rpc<number>('getblockcount');const moving=new ChainIndex(path.join(dir,'moving.sqlite'),10,'A');moving.init(ph,await rpc<string>('getblockhash',[ph-1]));moving.watchTx(probe.txid,ph);
 let moved=false;
 const shifting:Rpc=async(m,p,w)=>{const result=await rpc<any>(m,p,w);if(m==='getblock'&&!moved){moved=true;await rpc('invalidateblock',[(result as any).hash]);await rpc('generateblock',[await rpc('getnewaddress'),[]]);}return result;};
 let movingError:unknown;try{await moving.sync(shifting);}catch(e){movingError=e;}
 check('mid-read reorg cannot commit orphan transaction',movingError instanceof ChainChanged&&moving.status(probe.txid)===null&&moving.cursor?.height===ph-1,{error:String(movingError),status:moving.status(probe.txid),cursor:moving.cursor});
 await moving.sync(rpc);check('retry after chain movement indexes replacement branch',moving.status(probe.txid)===null&&moving.cursor?.hash===await rpc<string>('getbestblockhash'),{cursor:moving.cursor});moving.close();
 complete=true;
 }finally{fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname),process.env.AIO_BASELINE?'aio-invariants-baseline.json':'aio-invariants-results.json'),JSON.stringify({complete,rows,allOk:complete&&rows.every(r=>r.ok)},(_,v)=>typeof v==='bigint'?v.toString():v,2));await node.stop();fs.rmSync(dir,{recursive:true,force:true});}}
main().then(()=>{if(rows.some(r=>!r.ok))process.exitCode=1;}).catch(e=>{console.error(e);process.exitCode=1;});
