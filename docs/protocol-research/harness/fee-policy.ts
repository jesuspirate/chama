// Research-only fee controller. SQLite is the shared source of truth; the JSON
// files are compatibility/debug projections, never read to authorize spending.
import * as fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {anchorChild,txidOf,btc,REGTEST,hex,type Keypair,type Outpoint,type Rpc} from './lib.js';
import {activeChain} from './active-chain.js';
type Offer={txid:string;fee:number;raw:string;sponsor:Outpoint};
export interface StageState {stage:'ruling'|'appeal';parentTxid:string;ourChild?:Offer;offers?:Offer[];paid:number;exposure?:number;absent?:boolean;history:{height:number;action:string;fee?:number;reason:string}[]}
export interface ContractBudget {contract:string;capSats:number;paidSats:number;offeredSats:number;signedCeilingSats?:number;stages:Record<string,StageState>;revision?:number}
export interface Decision {action:'wait'|'bump'|'give-up'|'cannot-afford'|'done'|'submit';fee?:number;reason:string}
const encode=(x:unknown)=>JSON.stringify(x,(_,v)=>typeof v==='bigint'?v.toString():v);
export class FeeController {
 private db:DatabaseSync;
 constructor(private file:string,private reservationsFile:string,public sponsorKey:Keypair,public minRelaySatPerVb:number){
  const dbFile=reservationsFile+'.sqlite';
  // Historical prototype files require an explicit migration; never silently reset money state.
  if(!fs.existsSync(dbFile)&&(fs.existsSync(file)||fs.existsSync(reservationsFile)))throw new Error('legacy fee state requires explicit migration');
  this.db=new DatabaseSync(dbFile);this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS reservations (coin TEXT PRIMARY KEY, owner TEXT NOT NULL);');
 }
 private transaction<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 private get(id:string):ContractBudget|undefined{const r=this.db.prepare('SELECT body FROM budgets WHERE id=?').get(id) as any;return r?JSON.parse(r.body):undefined;}
 private put(b:ContractBudget){this.db.prepare('INSERT INTO budgets VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(b.contract,encode(b));}
 private ceiling(s:StageState){return Math.max(0,s.paid,s.ourChild?.fee??0,...(s.offers??[]).map(o=>o.fee));}
 private totals(b:ContractBudget){b.signedCeilingSats=Object.values(b.stages).reduce((n,s)=>n+this.ceiling(s),0);b.paidSats=Object.values(b.stages).reduce((n,s)=>n+s.paid,0);b.offeredSats=Object.values(b.stages).reduce((n,s)=>n+(s.exposure??(s.paid?0:s.ourChild?.fee??0)),0);}
 private project(){
  const all=Object.fromEntries((this.db.prepare('SELECT id,body FROM budgets').all() as any[]).map(r=>[r.id,JSON.parse(r.body)]));
  const res=Object.fromEntries((this.db.prepare('SELECT coin,owner FROM reservations').all() as any[]).map(r=>[r.coin,r.owner]));
  for(const [file,value] of [[this.file,all],[this.reservationsFile,res]] as const){const tmp=file+`.${process.pid}.tmp`;fs.writeFileSync(tmp,encode(value));fs.renameSync(tmp,file);}
 }
 load(contract:string,cap:number):ContractBudget{
  if(!Number.isSafeInteger(cap)||cap<0)throw new Error('invalid cap');
  const b=this.transaction(()=>{const old=this.get(contract);if(old){if(old.capSats!==cap)throw new Error('cap mismatch');return old;}const b={contract,capSats:cap,paidSats:0,offeredSats:0,stages:{},revision:0};this.put(b);return b;});this.project();return b;
 }
 save(b:ContractBudget,requiredSponsor?:Outpoint){
  this.transaction(()=>{
   const old=this.get(b.contract);if(!old||old.revision!==b.revision)throw new Error('stale budget: reload before updating');
   if(old.capSats!==b.capSats)throw new Error('cap cannot be changed implicitly');
   if(requiredSponsor){const r=this.db.prepare('SELECT owner FROM reservations WHERE coin=?').get(`${requiredSponsor.txid}:${requiredSponsor.vout}`) as any;if(r?.owner!==b.contract)throw new Error('sponsor reservation missing');}
   this.totals(b);if(b.paidSats<0||b.offeredSats<0||b.paidSats+b.offeredSats>b.capSats||(b.signedCeilingSats??0)>b.capSats)throw new Error('hard fee cap exceeded');
   b.revision=(b.revision??0)+1;this.put(b);
  });this.project();
 }
 async reserveSponsor(rpc:Rpc,contract:string,candidates:Outpoint[]):Promise<Outpoint|null>{
  for(const c of candidates){
   // RPC errors are errors, not evidence that a coin is available.
   const o=await rpc<any>('gettxout',[c.txid,c.vout,true]);
   const script=hex(btc.p2tr(this.sponsorKey.xonly,undefined,REGTEST).script);
   if(!o||o.confirmations<1||o.scriptPubKey.hex!==script||Math.round(o.value*1e8)!==Number(c.amount))continue;
   const won=this.transaction(()=>{const coin=`${c.txid}:${c.vout}`;const r=this.db.prepare('SELECT owner FROM reservations WHERE coin=?').get(coin) as any;if(r&&r.owner!==contract)return false;this.db.prepare('INSERT OR IGNORE INTO reservations VALUES (?,?)').run(coin,contract);return true;});
   this.project();if(won)return c;
  }return null;
 }
 release(contract:string){this.transaction(()=>{const b=this.get(contract);if(b&&Object.values(b.stages).some(s=>(s.offers?.length??0)>0||s.ourChild))throw new Error('signed offers retain reservations; automatic release requires confirmed invalidation');this.db.prepare('DELETE FROM reservations WHERE owner=?').run(contract);});this.project();}
 decide(b:ContractBudget,st:StageState,i:{blocksLeft:number;competitorFee:number;competitorFeerate:number;targetFeerate:number;parentVsize:number;childVsize:number;parentInMempool:boolean}):Decision{
  this.totals(b);
  if(st.paid)return {action:'done',reason:'our fee transaction confirmed'};
  const remaining=b.capSats-(b.signedCeilingSats??0)+this.ceiling(st);
  const rate=Math.ceil(i.targetFeerate*(i.parentVsize+i.childVsize))+1;
  const eviction=i.competitorFee>0?i.competitorFee+Math.ceil(this.minRelaySatPerVb*i.childVsize)+1:0;
  const need=Math.max(rate,eviction,Math.ceil(this.minRelaySatPerVb*(i.parentVsize+i.childVsize))+1);
  if(i.blocksLeft<=0)return {action:'give-up',reason:'competing spend eligible: configured policy stops new spending; signed offers remain tracked'};
  // Waiting is a heuristic, never proof of inclusion. Stop relying on it in the final two safe blocks.
  if(i.blocksLeft>2&&i.competitorFee>0&&i.competitorFeerate>=i.targetFeerate)return {action:'wait',reason:'competitor package clears estimated cutoff; time remains to monitor'};
  if(st.ourChild&&st.ourChild.fee>=need)return {action:st.absent?'submit':'wait',fee:st.absent?st.ourChild.fee:undefined,reason:st.absent?'retry durable signed offer':'our pending offer meets estimated need'};
  if(need>remaining)return {action:'cannot-afford',reason:`need ${need} sat > remaining budget ${remaining}`};
  return {action:st.ourChild?'bump':'submit',fee:need,reason:`need ${need} sat; remaining ${remaining}`};
 }
 async act(rpc:Rpc,b:ContractBudget,st:StageState,d:Decision,parentRaw:string,sponsor:Outpoint,height:number):Promise<{ok:boolean;err?:string}>{
  if(d.action!=='submit'&&d.action!=='bump'){st.history.push({height,action:d.action,reason:d.reason});this.save(b);return {ok:true};}
  if(txidOf(parentRaw)!==st.parentTxid)throw new Error('parent txid does not match stage');
  if(!Number.isSafeInteger(d.fee)||d.fee!<0)throw new Error('invalid fee');
  sponsor={...sponsor,amount:BigInt(sponsor.amount)};
  // Signed children all conflict at the same anchor. Retain every variant because
  // an older variant can confirm after replacement or a reorg.
  const raw=st.ourChild?.fee===d.fee?st.ourChild.raw:anchorChild(st.parentTxid,1,sponsor,this.sponsorKey,BigInt(d.fee!));
  const txid=(await rpc<any>('decoderawtransaction',[raw],'')).txid as string;
  for(const other of Object.values(b.stages))if(other!==st&&!other.paid&&other.ourChild?.sponsor.txid===sponsor.txid&&other.ourChild.sponsor.vout===sponsor.vout)throw new Error('sponsor already offered to another stage');
  st.offers??=st.ourChild?[st.ourChild]:[];
  const offer={txid,fee:d.fee!,raw,sponsor};if(!st.offers.some(o=>o.txid===txid))st.offers.push(offer);
  st.ourChild=offer;st.exposure=Math.max(...st.offers.map(o=>o.fee));st.absent=false;
  st.history.push({height,action:d.action,fee:d.fee,reason:d.reason});this.save(b,sponsor);
  // A process may die here. The exact signed raw and fee exposure are durable.
  if(process.env.FEE_CRASH_AFTER_PERSIST==='1')process.exit(99);
  try{if(d.action==='submit'){const r=await rpc<any>('submitpackage',[[parentRaw,raw]],'');if(r.package_msg!=='success')return {ok:false,err:JSON.stringify(r).slice(0,200)};}else await rpc('sendrawtransaction',[raw],'');return {ok:true};}catch(e){return {ok:false,err:(e as Error).message};}
 }
 async reconcile(rpc:Rpc,b:ContractBudget,st:StageState):Promise<'confirmed'|'pending'|'evicted'>{
  if(!st.ourChild)return 'pending';
  const chain=await activeChain(rpc);st.offers??=[st.ourChild];
  const confirmed=st.offers.find(o=>chain.txs.has(o.txid));
  if(confirmed){st.paid=confirmed.fee;st.exposure=0;st.absent=false;this.save(b);return 'confirmed';}
  st.paid=0;
  // Absence from a local mempool does not revoke a signature. Only a confirmed
  // conflicting spend proves this variant cannot confirm on the current chain.
  const live=st.offers.filter(o=>!chain.spends.has(`${st.parentTxid}:1`)&&!chain.spends.has(`${o.sponsor.txid}:${o.sponsor.vout}`));
  st.exposure=live.length?Math.max(...live.map(o=>o.fee)):0;
  st.absent=!chain.mempool.has(st.ourChild.txid);this.save(b);
  return st.absent?'evicted':'pending';
 }
}
