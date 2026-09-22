import assert from 'node:assert/strict';
import { createSimWallet, SIM_ONCHAIN_INFO, SimDepositUnderpaidError } from './sim-wallet.js';
import { simOnchainMode, type SimOnchainMode } from './simMode.js';
const stored=new Map<string,string>();
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>stored.get(k)??null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)}});
const timers = new Map<number,()=>void>();let id=0;
const originalSet=globalThis.setTimeout, originalClear=globalThis.clearTimeout;
globalThis.setTimeout=((fn:()=>void)=>{timers.set(++id,fn);return id;}) as any;
globalThis.clearTimeout=((id:number)=>timers.delete(id)) as any;
async function tick(){for(let n=0;n<10;n++) await Promise.resolve();const next=timers.entries().next().value;if(next){timers.delete(next[0]);next[1]();}for(let n=0;n<10;n++) await Promise.resolve();}
try {
 for(const mode of ['slow','instant','underpaid','stuck'] as SimOnchainMode[]){
  assert.equal(simOnchainMode(`?sim=1&onchain=${mode}`),mode);
  const wallet=createSimWallet({npub:`test-${mode}`,onchainMode:mode});
  await wallet.open();await wallet.joinFederation('sim');
  const info=await wallet.onchain.getInfo();
  if(mode!=='instant') assert.deepEqual(info,SIM_ONCHAIN_INFO);
  const deposit=await wallet.onchain.createDepositAddress({chama_amount_msats:2_000_000});
  const seen:string[]=[];const unsubscribe=wallet.onchain.subscribeDeposit(deposit.operationId,p=>seen.push(`${p.status}:${p.confirmations}`));
  let result:any, error:any;
  const done=wallet.onchain.awaitDeposit(deposit.operationId).then(r=>result=r,e=>error=e);
  if(mode==='stuck'){
   await tick();assert.equal(timers.size,0,'A stuck deposit has no polling timers');assert.equal(result,undefined);
   await wallet.cleanup();await done;assert.ok(error);assert.equal(await wallet.balance.getBalance(),0);
  } else {
   for(let n=0;n<20 && !result && !error;n++) await tick();
   await done;
   if(mode==='underpaid'){assert.ok(error instanceof SimDepositUnderpaidError);assert.ok(error.amountSats < error.minimumSats);assert.equal(await wallet.balance.getBalance(),0);}
   else {
    assert.equal(result.status,'confirmed');assert.equal(await wallet.balance.getBalance(),2_000_000,'Deposit credits net amount exactly once');
    await wallet.onchain.awaitDeposit(deposit.operationId);assert.equal(await wallet.balance.getBalance(),2_000_000);
    if(mode==='slow'){assert.ok(seen.includes('mempool:0'));assert.ok(seen.includes('confirming:1'));assert.ok(seen.includes('confirming:10'));}
    const quote=await wallet.onchain.getWithdrawFees('sim',1000);assert.equal(quote.totalSats,1000+info.pegOutFeeSats);
    const payout=wallet.onchain.withdraw('sim',1000,{wait:false});await tick();assert.equal((await payout).status,mode==='instant'?'confirmed':'pending');
    assert.equal(await wallet.balance.getBalance(),(1000-info.pegOutFeeSats)*1000,'Withdrawal debits principal plus fee');
   }
   unsubscribe();await wallet.cleanup();assert.equal(timers.size,0);
  }
 }
 const wallet=createSimWallet({npub:'cancel',onchainMode:'slow'});
 const deposit=await wallet.onchain.createDepositAddress();
 const pending=wallet.onchain.awaitDeposit(deposit.operationId).catch(e=>e);
 await wallet.cleanup();assert.ok(await pending instanceof Error);assert.equal(timers.size,0,'Cleanup cancels an active walker');
 assert.equal(await wallet.balance.getBalance(),0,'Cleanup cannot credit a late deposit');
 assert.ok([...stored.keys()].every(k=>k.startsWith('chama_sim_wallet_')),'On-chain simulation writes only the existing sim wallet namespace');
 assert.equal(await createSimWallet({npub:'unrelated'}).balance.getBalance(),0,'A new identity cannot inherit simulated deposit credit');
 console.log('PASS sim on-chain: all URL modes, deposit stages, fees, exact-once credit, cleanup');
} finally {globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
