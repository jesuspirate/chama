#!/usr/bin/env npx tsx
// REGTEST ONLY. Small miner templates, real fee-ranked transaction selection.
// Setup blocks may explicitly include large setup transactions; contested blocks
// always use generatetoaddress and assert actual inclusion and template occupancy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startNode, mine, fundKey, keypair, btc, REGTEST, hex, hexToBytes, fundingTree, appealTree, newSpend, addToTree, addToKey, addP2A, finalize, txidOf, anchorChild, type Outpoint } from './lib.js';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ESCROW = 100000n, W = 4, BUDGET = 2000n;
async function main() {
 const node = await startNode(19999, ['-blockmaxweight=40000', '-blockreservedweight=2000']);
 const {rpc} = node;
 const rows: any[] = [], blocks: any[] = [];
 let completed = false;
 const network = await rpc<any>("getnetworkinfo", [], "");
 const check = (id: string, description: string, ok: boolean, evidence: unknown = {}) => {
   rows.push({id, description, ok, evidence}); console.log(`${ok ? 'PASS' : 'FAIL'} ${id}: ${description}`);
   if (!ok) throw new Error(`failed ${id}: ${JSON.stringify(evidence)}`);
 };
 const accept = async (raw: string) => (await rpc<any[]>('testmempoolaccept', [[raw]]))[0];
 const utxo = (id: string, n = 0) => rpc<any>('gettxout', [id, n, false]);
 const height = () => rpc<number>('getblockcount');
 const mineOne = async (label: string) => {
   const template = await rpc<any>('getblocktemplate', [{rules:['segwit']}]);
   const [hash] = await rpc<string[]>('generatetoaddress', [1, await rpc<string>('getnewaddress')]);
   const block = await rpc<any>('getblock', [hash]);
   blocks.push({label, height:block.height, hash, weight:block.weight, transactions:block.tx.length, templateTxids:template.transactions.map((t:any)=>t.txid), minedTxids:block.tx});
   return block;
 };
 try {
  await mine(rpc,110);
  const A=keypair(), B=keypair(), R=keypair(), P=keypair(), H=keypair(), X=keypair(), NOISE=keypair();
  const roles={A:A.xonly,B:B.xonly,R:R.xonly,P:P.xonly};
  const f=await fundKey(rpc,A.xonly,1000000n);
  const hs=await fundKey(rpc,H.xonly,500000n), xs=await fundKey(rpc,X.xonly,500000n);
  const treasury=await fundKey(rpc,NOISE.xonly,100000000n);
  const np=btc.p2tr(NOISE.xonly,undefined,REGTEST);
  const split=new btc.Transaction({version:2});
  split.addInput({txid:hexToBytes(treasury.txid),index:treasury.vout,witnessUtxo:{script:np.script,amount:treasury.amount},tapInternalKey:NOISE.xonly});
  for(let i=0;i<900;i++) split.addOutput({script:np.script,amount:100000n});
  split.addOutput({script:np.script,amount:treasury.amount-90000000n-1000n}); split.signIdx(NOISE.priv,0); split.finalize();
  await rpc('generateblock',[await rpc('getnewaddress'),[hex(split.extract())]]);
  let noiseIndex=0;
  const congest = async (count:number) => {
    for(let i=0;i<count;i++) {
      const tx=new btc.Transaction({version:2});
      tx.addInput({txid:hexToBytes(split.id),index:noiseIndex++,witnessUtxo:{script:np.script,amount:100000n},tapInternalKey:NOISE.xonly});
      tx.addOutput({script:np.script,amount:80000n}); tx.signIdx(NOISE.priv,0); tx.finalize();
      await rpc('sendrawtransaction',[hex(tx.extract())]);
    }
  };
  const refundHeight=(await height())+5;
  const F=fundingTree(roles,refundHeight), QA=appealTree(roles,'A',W), QB=appealTree(roles,'B',W);
  const fp=btc.p2tr(A.xonly,undefined,REGTEST);
  const fund=new btc.Transaction({version:2});
  fund.addInput({txid:hexToBytes(f.txid),index:f.vout,witnessUtxo:{script:fp.script,amount:f.amount},tapInternalKey:A.xonly});
  for(let i=0;i<4;i++) addToTree(fund,F,ESCROW);
  addToKey(fund,A.xonly,f.amount-4n*ESCROW-2000n);
  // All ruling and appeal templates are signed before funding is signed/broadcast.
  const graph = Array.from({length:4},(_,i)=>{
    const w=i===3?'A':'B'; const q=w==='A'?QA:QB;
    const t=newSpend(F,'ruling',{txid:fund.id,vout:i,amount:ESCROW}); addToTree(t,q,ESCROW-240n); addP2A(t);
    t.signIdx(A.priv,0);t.signIdx(B.priv,0);t.signIdx(R.priv,0); const ruling=finalize(t,F,'ruling');
    const ap=newSpend(q,'appeal',{txid:t.id,vout:0,amount:ESCROW-240n}); addToKey(ap,w==='A'?B.xonly:A.xonly,ESCROW-480n);addP2A(ap);
    ap.signIdx(A.priv,0);ap.signIdx(B.priv,0);ap.signIdx(P.priv,0);
    return {ruling,id:t.id,appeal:finalize(ap,q,'appeal'),q};
  });
  const refund=(i:number,fee:bigint)=>{
    const t=newSpend(F,'refund',{txid:fund.id,vout:i,amount:ESCROW},{lockTime:refundHeight,sequence:0xfffffffd});
    addToKey(t,A.xonly,ESCROW-fee);t.signIdx(A.priv,0);return finalize(t,F,'refund');
  };
  fund.signIdx(A.priv,0);fund.finalize();await rpc('sendrawtransaction',[hex(fund.extract())]);await mineOne('funding');
  check('F0','funding confirmed four blocks before refund becomes mempool-final',(await height())===refundHeight-4,{tip:await height(),refundHeight});
  await congest(450);
  const g=graph[0]; let pin='';
  for(const bid of [1300n,6000n,12000n]) {
    pin=anchorChild(g.id,1,xs,X,bid,{padBytes:825});
    if(bid===1300n) {const p=await rpc<any>('submitpackage',[[g.ruling,pin]]);check('B1','initial attacker package accepted',p.package_msg==='success',p);}
    else await rpc('sendrawtransaction',[pin]);
    const affordable=await accept(anchorChild(g.id,1,hs,H,BUDGET));
    check(`B${bid}`,'fixed 2000-sat budget tested against current bid',affordable.allowed===(bid===1300n),{offeredBid:Number(bid),budget:Number(BUDGET),result:affordable});
    const block=await mineOne(`congested-bid-${bid}`);
    check(`C${bid}`,'occupied fee-ranked block excludes ruling',block.weight>36000&&!block.tx.includes(g.id),{weight:block.weight,height:block.height,txCount:block.tx.length});
  }
  const early=await accept(refund(0,50000n));
  check('H-1','refund rejected at tip H-1',await height()===refundHeight-1&&!early.allowed,{tip:await height(),result:early});
  // A larger reserve can confirm a different contract's ruling before refund maturity.
  const rescue=graph[1];const rescueChild=anchorChild(rescue.id,1,hs,H,90000n);
  const rescued=await rpc<any>('submitpackage',[[rescue.ruling,rescueChild]]);
  check('S1','90000-sat rescue package accepted',rescued.package_msg==='success',rescued);
  const boundary=await mineOne('at-refund-height');
  check('S2','larger budget confirms its ruling while small-budget ruling remains pending',boundary.height===refundHeight&&boundary.tx.includes(rescue.id)&&!boundary.tx.includes(g.id),{height:boundary.height,weight:boundary.weight});
  const mature=refund(0,50000n);const matureResult=await accept(mature);
  check('H','refund is now final and can replace pending ruling package',matureResult.allowed,{tip:await height(),result:matureResult});
  await rpc('sendrawtransaction',[mature]);const outcome=await mineOne('refund-wins');
  const sponsorLeft=await utxo(xs.txid,xs.vout);
  check('L1','refund to A confirms; intended ruling to B loses',outcome.tx.includes(txidOf(mature))&&!(await utxo(g.id))&&sponsorLeft?.value===0.005,{winner:'A refund',attackerSponsorSats:sponsorLeft?.value*1e8,attackerAnchorFeePaid:0,refundFeePaid:50000,honestSmallBudgetFeePaid:0});
  check('S3','confirmed rescued ruling makes its refund unspendable',!(await accept(refund(1,50000n))).allowed);
  // Clear finite congestion. Waiting can also succeed without paying to evict.
  while((await rpc<string[]>('getrawmempool')).length) await mineOne('drain-background');
  const wait=graph[2], waitChild=anchorChild(wait.id,1,xs,X,12000n,{padBytes:825});
  await rpc('submitpackage',[[wait.ruling,waitChild]]);const waited=await mineOne('attacker-sponsors-success');
  check('W1','without congestion, attacker child pays to confirm the intended ruling',waited.tx.includes(wait.id)&&waited.tx.includes(txidOf(waitChild)),{attackerFeePaid:12000,honestFeePaid:0});
  // Appeal deadline: independent confirmed fee change sponsors the next stage.
  const hchange:Outpoint={txid:txidOf(rescueChild),vout:0,amount:500000n+240n-90000n};
  const q=graph[3], qchild=anchorChild(q.id,1,hchange,H,2000n);
  await rpc('submitpackage',[[q.ruling,qchild]]); await mineOne('appeal-stage-parent');const qheight=await height();
  const apid=txidOf(q.appeal), sponsor:Outpoint={txid:txidOf(qchild),vout:0,amount:hchange.amount+240n-2000n};
  const apchild=anchorChild(apid,1,sponsor,H,BUDGET);
  await congest(400);await rpc('submitpackage',[[q.appeal,apchild]]);
  const collect=(fee:bigint)=>{const t=newSpend(QA,'default',{txid:q.id,vout:0,amount:ESCROW-240n},{sequence:W});addToKey(t,A.xonly,ESCROW-240n-fee);t.signIdx(A.priv,0);return finalize(t,QA,'default');};
  for(let i=0;i<W-2;i++) await mineOne('appeal-congestion');
  const before=await accept(collect(50000n));
  check('A1','default is nonfinal one candidate block before CSV maturity',(await height())===qheight+W-2&&!before.allowed,{rulingHeight:qheight,tip:await height(),result:before});
  await mineOne('appeal-last-exclusive-block');
  const def=collect(50000n), defResult=await accept(def);
  check('A2','default becomes eligible for block rulingHeight+W while appeal remains pending',(await height())===qheight+W-1&&defResult.allowed&&(await rpc<string[]>('getrawmempool')).includes(apid),{tip:await height(),firstEligibleHeight:qheight+W,result:defResult});
  await rpc('sendrawtransaction',[def]);const final=await mineOne('default-wins');
  check('A3','higher-fee default wins over pending appeal at first CSV-eligible height',final.height===qheight+W&&final.tx.includes(txidOf(def))&&!(await utxo(apid)),{winner:'A default',intendedAppealWinner:'B',defaultFeePaid:50000,appealFeePaid:0});
  // Consensus branch counterfactual, explicit miner selection: reversal has no expiry.
  await rpc('invalidateblock',[final.hash]);
  const alternative=await rpc<any>('generateblock',[await rpc('getnewaddress'),[q.appeal,apchild]]);
  const alt=await rpc<any>('getblock',[alternative.hash]);
  check('A4','at the same maturity height a miner can instead confirm the reversal',alt.height===qheight+W&&alt.tx.includes(apid)&&!(await utxo(txidOf(def))),{height:alt.height,winner:'B appeal',selection:'explicit generateblock; consensus evidence, not relay policy'});
  // Deliberately reconfirm an earlier ruling TWO HEIGHTS LATER, then exercise CSV.
  // Explicit empty blocks model a chain perturbation, not fee-ranked mining.
  const oldHeight=waited.height;
  await rpc('invalidateblock',[waited.hash]);
  for(let i=0;i<2;i++) await rpc('generateblock',[await rpc('getnewaddress'),[]]);
  const reconfirmed=await rpc<any>('generateblock',[await rpc('getnewaddress'),[wait.ruling,waitChild]]);
  const newBlock=await rpc<any>('getblock',[reconfirmed.hash]);
  check('R1','ruling reconfirms two heights later after controlled reorg',newBlock.height===oldHeight+2,{oldHeight,newHeight:newBlock.height});
  const payout=newSpend(QB,'default',{txid:wait.id,vout:0,amount:ESCROW-240n},{sequence:W});
  addToKey(payout,B.xonly,ESCROW-740n);payout.signIdx(B.priv,0);const payoutRaw=finalize(payout,QB,'default');
  while(await height()<oldHeight+W-1) await rpc('generateblock',[await rpc('getnewaddress'),[]]);
  const stale=await accept(payoutRaw);
  check('R2','old confirmation-derived deadline is now too early',!stale.allowed,{tip:await height(),oldFirstEligibleHeight:oldHeight+W,newFirstEligibleHeight:newBlock.height+W,result:stale});
  while(await height()<newBlock.height+W-1) await rpc('generateblock',[await rpc('getnewaddress'),[]]);
  const fresh=await accept(payoutRaw);
  check('R3','same default transaction becomes eligible at recomputed CSV deadline',fresh.allowed,{tip:await height(),result:fresh});
  completed = true;

 } finally {
  fs.writeFileSync(path.join(HERE,'deadline-budget-results.json'),JSON.stringify({date:new Date().toISOString(),model:{core:network.subversion,relayFeeBtcPerKvB:network.relayfee,incrementalFeeBtcPerKvB:network.incrementalfee,blockMaxWeight:40000,blockReservedWeight:2000,honestBudgetSats:Number(BUDGET),backgroundFeeSats:20000,backgroundInputSats:100000,scope:'controlled miner capacity; not mainnet fee forecast'},rows,blocks,completed,allOk:completed&&rows.length>0&&rows.every(r=>r.ok)},null,2));
  await node.stop();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
