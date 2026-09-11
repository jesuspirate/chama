// Adversarial controller invariants. REGTEST ONLY. Run before and after fixes.
import {spawn} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {startNode,mine,fundKey,keypair,btc,REGTEST,hex,hexToBytes,fundingTree,appealTree,newSpend,addToTree,addToKey,addP2A,finalize,txidOf,type Rpc,makeRpc} from './lib.js';
import {FeeController} from './fee-policy.js';
import {observe,templateCutoff,type Graph} from './observer.js';
const HERE=path.dirname(new URL(import.meta.url).pathname);
async function worker(){const j=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));const rpc=makeRpc(20299);const ctl=new FeeController(j.file,j.reservations,keypair(hexToBytes(j.priv)),0.1);
 if(j.mode==='reserve'){const r=await ctl.reserveSponsor(rpc,j.contract,[{...j.sponsor,amount:BigInt(j.sponsor.amount)}]);console.log(JSON.stringify({reserved:!!r}));return;}
 const b=ctl.load(j.contract,3000);const st=b.stages.ruling??(b.stages.ruling={stage:'ruling',parentTxid:j.parent,paid:0,history:[]});await ctl.reserveSponsor(rpc,j.contract,[{...j.sponsor,amount:BigInt(j.sponsor.amount)}]);await ctl.act(rpc,b,st,{action:'submit',fee:2000,reason:'process crash'},j.raw,{...j.sponsor,amount:BigInt(j.sponsor.amount)},0);
}
function child(job:string,crash=false):Promise<{code:number,out:string,err:string}>{return new Promise(resolve=>{const p=spawn(path.join(HERE,'../../../node_modules/.bin/tsx'),[new URL(import.meta.url).pathname,'worker',job],{env:{...process.env,FEE_CRASH_AFTER_PERSIST:crash?'1':'0'}});let out='',err='';p.stdout.on('data',x=>out+=x);p.stderr.on('data',x=>err+=x);p.on('close',code=>resolve({code:code??-1,out,err}));});}
const rows:any[]=[];let completed=false;
function check(id:string,ok:boolean,evidence:unknown){rows.push({id,ok,evidence});console.log(ok?'PASS':'FAIL',id,JSON.stringify(evidence));}
async function main(){
 const n=await startNode(20299);const rpc=n.rpc;const dir=fs.mkdtempSync(path.join(os.tmpdir(),'fee-invariants-'));
 try{
 const templateRpc:Rpc=async(method)=>{if(method!=='getblocktemplate')throw new Error('unexpected RPC');return {transactions:[{fee:0,weight:400,depends:[]},{fee:1000,weight:400,depends:[1]}]} as any;};
 const cutoff=await templateCutoff(templateRpc,800);check('zero-fee-parent-does-not-zero-template-cutoff',cutoff===5,{cutoff});
 await mine(rpc,110);
 const H=keypair(), A=keypair(),B=keypair(),R=keypair(),P=keypair();
 const roles={A:A.xonly,B:B.xonly,R:R.xonly,P:P.xonly};
 const sponsor=await fundKey(rpc,H.xonly,150000n),funding=await fundKey(rpc,A.xonly,300000n);
 const ctl=new FeeController(path.join(dir,'budgets.json'),path.join(dir,'reservations.json'),H,0.1);
 // Promise.all starts both reads before either asynchronous gettxout returns.
 const reserved=await Promise.all([ctl.reserveSponsor(rpc,'race-A',[sponsor]),ctl.reserveSponsor(rpc,'race-B',[sponsor])]);
 check('exclusive-concurrent-reservation',reserved.filter(Boolean).length===1,reserved.map(x=>!!x));
 ctl.release('race-A');ctl.release('race-B');
 const job=(name:string,data:any)=>{const f=path.join(dir,name+'.json');fs.writeFileSync(f,JSON.stringify({file:path.join(dir,'budgets.json'),reservations:path.join(dir,'reservations.json'),priv:hex(H.priv),...data},(_,v)=>typeof v==='bigint'?v.toString():v));return f;};
 const jobs=['proc-A','proc-B'].map(contract=>job(contract,{mode:'reserve',contract,sponsor}));
 const procs=await Promise.all(jobs.map(j=>child(j)));
 check('exclusive-cross-process-reservation',procs.every(p=>p.code===0)&&procs.filter(p=>JSON.parse(p.out).reserved).length===1,procs);
 ctl.release('proc-A');ctl.release('proc-B');
 const height=await rpc<number>('getblockcount');const F=fundingTree(roles,height+100),Q=appealTree(roles,'A',4),QB=appealTree(roles,'B',4);
 const fp=btc.p2tr(A.xonly,undefined,REGTEST);const f=new btc.Transaction({version:2});
 f.addInput({txid:hexToBytes(funding.txid),index:funding.vout,witnessUtxo:{script:fp.script,amount:funding.amount},tapInternalKey:A.xonly});addToTree(f,F,100000n);addToKey(f,A.xonly,199000n);f.signIdx(A.priv,0);f.finalize();await rpc('sendrawtransaction',[hex(f.extract())]);await mine(rpc,1);
 const ruling=newSpend(F,'ruling',{txid:f.id,vout:0,amount:100000n});addToTree(ruling,Q,99760n);addP2A(ruling);ruling.signIdx(A.priv,0);ruling.signIdx(B.priv,0);ruling.signIdx(R.priv,0);const raw=finalize(ruling,F,'ruling');
 const ap=newSpend(Q,'appeal',{txid:ruling.id,vout:0,amount:99760n});addToKey(ap,B.xonly,99520n);addP2A(ap);ap.signIdx(A.priv,0);ap.signIdx(B.priv,0);ap.signIdx(P.priv,0);const apr=finalize(ap,Q,'appeal');
 const g:Graph={fundingTxid:f.id,rulings:{A:ruling.id,B:'11'.repeat(32)},appeals:{A:ap.id,B:'22'.repeat(32)},W:4,refundHeight:height+100};
 let b=ctl.load('test',10000);let st=b.stages.ruling={stage:'ruling' as const,parentTxid:ruling.id,paid:0,history:[]};
 await ctl.reserveSponsor(rpc,'test',[sponsor]);
 const result=await ctl.act(rpc,b,st,{action:'submit',fee:2000,reason:'test'},raw,sponsor,await rpc('getblockcount'));if(!result.ok)throw new Error(result.err);
 await mine(rpc,1);await ctl.reconcile(rpc,b,st);const originalHeight=await rpc<number>('getblockcount');const old=await observe(rpc,g);
 check('initial-paid',b.paidSats===2000&&b.offeredSats===0,{paid:b.paidSats,offered:b.offeredSats});
 await rpc('invalidateblock',[await rpc('getbestblockhash')]);await ctl.reconcile(rpc,b,st);
 check('reorg-paid-to-mempool-offer',b.paidSats===0&&b.offeredSats===2000,{paid:b.paidSats,offered:b.offeredSats,mempool:await rpc('getrawmempool')});
 await mine(rpc,1);await ctl.reconcile(rpc,b,st);
 const change=st.ourChild!;const hp=btc.p2tr(H.xonly,undefined,REGTEST);const spend=new btc.Transaction({version:2});
 spend.addInput({txid:hexToBytes(change.txid),index:0,witnessUtxo:{script:hp.script,amount:148240n},tapInternalKey:H.xonly});spend.addOutput({script:hp.script,amount:147240n});spend.signIdx(H.priv,0);spend.finalize();await rpc('sendrawtransaction',[hex(spend.extract())]);await mine(rpc,1);
 await ctl.reconcile(rpc,b,st);await ctl.reconcile(rpc,b,st);
 check('spent-change-does-not-erase-paid-fee',b.paidSats===2000&&b.offeredSats===0,{paid:b.paidSats,offered:b.offeredSats});
 // Once both the ruling anchor and Q are spent, parent history still has its own height.
 await rpc('generateblock',[await rpc('getnewaddress'),[apr]]);const obs=await observe(rpc,g,old);
 check('parent-height-not-appeal-height',obs.ruling.tx.height===originalHeight,{expected:originalHeight,actual:obs.ruling.tx.height,appealHeight:obs.appeal.tx.height});
 // Remove the appeal's recipient output too. Confirmed history must remain observable.
 const bp=btc.p2tr(B.xonly,undefined,REGTEST);const sweep=new btc.Transaction({version:2});sweep.addInput({txid:hexToBytes(ap.id),index:0,witnessUtxo:{script:bp.script,amount:99520n},tapInternalKey:B.xonly});sweep.addOutput({script:bp.script,amount:98520n});sweep.signIdx(B.priv,0);sweep.finalize();await rpc('sendrawtransaction',[hex(sweep.extract())]);await mine(rpc,1);const after=await observe(rpc,g,obs);
 check('spent-payout-remains-confirmed',after.payout==='appeal-confirmed',{payout:after.payout,ruling:after.ruling});
 // Construct a fresh, consensus-valid parent for the crash-before-broadcast test.
 const sponsor2=await fundKey(rpc,H.xonly,150000n),source=await fundKey(rpc,A.xonly,300000n);
 const f2=new btc.Transaction({version:2});f2.addInput({txid:hexToBytes(source.txid),index:source.vout,witnessUtxo:{script:fp.script,amount:source.amount},tapInternalKey:A.xonly});addToTree(f2,F,100000n);addToKey(f2,A.xonly,199000n);f2.signIdx(A.priv,0);f2.finalize();await rpc('sendrawtransaction',[hex(f2.extract())]);await mine(rpc,1);
 const r2=newSpend(F,'ruling',{txid:f2.id,vout:0,amount:100000n});addToTree(r2,Q,99760n);addP2A(r2);r2.signIdx(A.priv,0);r2.signIdx(B.priv,0);r2.signIdx(R.priv,0);const raw2=finalize(r2,F,'ruling');
 const killed=await child(job('crash-worker',{mode:'act',contract:'crash',sponsor:sponsor2,parent:r2.id,raw:raw2}),true);
 check('actual-process-exit-after-persist',killed.code===99,{code:killed.code,err:killed.err});
 const reopened=new FeeController(path.join(dir,'budgets.json'),path.join(dir,'reservations.json'),H,0.1);const crash=reopened.load('crash',3000),cs=crash.stages.ruling;
 await reopened.reconcile(rpc,crash,cs);
 check('absent-signed-offer-retains-exposure',crash.offeredSats===2000&&!!cs.ourChild,{paid:crash.paidSats,offered:crash.offeredSats,hasRaw:!!cs.ourChild});
 const retry=reopened.decide(crash,cs,{blocksLeft:10,competitorFee:0,competitorFeerate:0,targetFeerate:1,parentVsize:208,childVsize:153,parentInMempool:false});
 const sent=await reopened.act(rpc,crash,cs,retry,raw2,sponsor2,await rpc('getblockcount'));await mine(rpc,1);await reopened.reconcile(rpc,crash,cs);
 check('crash-retry-confirms-and-counts-once',retry.action==='submit'&&sent.ok&&crash.paidSats===2000&&crash.offeredSats===0,{decision:retry,paid:crash.paidSats,offered:crash.offeredSats});
 const fresh=reopened.load('crash',3000);const ap2=newSpend(Q,'appeal',{txid:r2.id,vout:0,amount:99760n});addToKey(ap2,B.xonly,99520n);addP2A(ap2);ap2.signIdx(A.priv,0);ap2.signIdx(B.priv,0);ap2.signIdx(P.priv,0);const a2raw=finalize(ap2,Q,'appeal');
 const change2={txid:cs.ourChild!.txid,vout:0,amount:148240n};await reopened.reserveSponsor(rpc,'crash',[change2]);const ast=fresh.stages.appeal={stage:'appeal' as const,parentTxid:ap2.id,paid:0,history:[]};let rejected=false;try{await reopened.act(rpc,fresh,ast,{action:'submit',fee:2000,reason:'would exceed cross-stage cap'},a2raw,change2,0);}catch{rejected=true;}
 const durable=reopened.load('crash',3000);check('cross-stage-cap-enforced-at-persistence',rejected&&durable.paidSats===2000&&durable.offeredSats===0,{rejected,paid:durable.paidSats,offered:durable.offeredSats});
 const last=reopened.decide(durable,{stage:'appeal',parentTxid:ap2.id,paid:0,history:[]},{blocksLeft:1,competitorFee:500,competitorFeerate:5,targetFeerate:1,parentVsize:208,childVsize:153,parentInMempool:true});
 check('last-safe-block-does-not-blindly-wait',last.action==='submit'||last.action==='cannot-afford',last);
 // A lower-fee variant may confirm even after a higher signed variant exists.
 // The higher commitment must constrain the next stage across future reorgs.
 const oldChild=cs.ourChild!.raw;await rpc('invalidateblock',[await rpc('getbestblockhash')]);
 const variants=reopened.load('crash',3000),vs=variants.stages.ruling;await reopened.reconcile(rpc,variants,vs);
 const bumped=await reopened.act(rpc,variants,vs,{action:'bump',fee:2500,reason:'higher signed variant'},raw2,sponsor2,0);if(!bumped.ok)throw new Error(bumped.err);
 await rpc('generateblock',[await rpc('getnewaddress'),[raw2,oldChild]]);await reopened.reconcile(rpc,variants,vs);
 const next=reopened.load('crash',3000),ns=next.stages.appeal={stage:'appeal' as const,parentTxid:ap2.id,paid:0,history:[]};let ceilingBlocked=false;try{await reopened.act(rpc,next,ns,{action:'submit',fee:700,reason:'looks affordable against only the cheaper paid variant'},a2raw,change2,0);}catch{ceilingBlocked=true;}
 const retained=reopened.load('crash',3000);check('higher-signed-variant-reserves-cross-stage-budget',ceilingBlocked&&retained.paidSats===2000&&retained.signedCeilingSats===2500,{ceilingBlocked,paid:retained.paidSats,signedCeiling:retained.signedCeilingSats});
 // A stale budget snapshot must not replace a newer update.
 const left=ctl.load('stale',10000),right=ctl.load('stale',10000);left.stages.a={stage:'ruling',parentTxid:'44'.repeat(32),paid:0,history:[]};ctl.save(left);let staleRejected=false;try{ctl.save(right);}catch{staleRejected=true;}check('stale-budget-write-rejected',staleRejected,{staleRejected});
 completed=true;
 }finally{fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname),process.env.AUDIT_BASELINE?'controller-invariants-baseline.json':'controller-invariants-results.json'),JSON.stringify({completed,rows,allOk:completed&&rows.every(r=>r.ok)},null,2));await n.stop();fs.rmSync(dir,{recursive:true,force:true});}
}
(process.argv[2]==='worker'?worker():main().then(()=>{if(rows.some(r=>!r.ok))process.exitCode=1;})).catch(e=>{console.error(e);process.exitCode=1;});
