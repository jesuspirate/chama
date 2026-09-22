import assert from 'node:assert/strict';
import { ABANDONED_INVOICES_KEY, createFundingInvoiceJournal, FundingStorageError, fundingStorageFailure } from './abandoned-invoices.js';
import { runFundAndLock } from './fund-and-lock.js';
import { scopedStorageKey, setLocalStorageUserScope } from '../storage/user-scope.js';
const values=new Map<string,string>();
const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);},removeItem:(k:string)=>{values.delete(k);}};
Object.defineProperty(globalThis,'localStorage',{configurable:true,value:storage});
setLocalStorageUserScope('alice');
const key=scopedStorageKey(ABANDONED_INVOICES_KEY);
const input={escrowId:'trade',amountMsats:2000000,federationId:'fed-a'};
assert.throws(()=>createFundingInvoiceJournal({...input,federationId:''}),'a missing federation identity blocks invoice creation');
const journal=createFundingInvoiceJournal(input);
const abort=new AbortController();
const phases:string[]=[];
const result=await runFundAndLock({ ...input, description:'test only',invoiceJournal:journal,
 getBalance:async()=>0,createFundingInvoice:async(_a,_d,onState,onGateway)=>{onGateway?.({id:'gw',operationId:'op-1',provenPayable:false});onState?.('created');return 'TEST-INVOICE';},
 lockAndPublish:async()=>{throw Error('must not lock');}, signal:abort.signal,
 onPhase:p=>{phases.push(p.kind);if(p.kind==='invoice-created')abort.abort();},
});
assert.equal(result.kind,'aborted');
let entries=JSON.parse(values.get(key)!);
assert.equal(entries[0].invoice,'TEST-INVOICE','abort records the exact invoice identifier');
assert.equal(entries[0].operationId,'op-1','the wallet operation identifier is retained when available');
assert.equal(entries[0].state,'abandoned','aborted receive is durably marked abandoned');
// A new journal is a reload of the store, not a module-global queue.
createFundingInvoiceJournal(input);
assert.deepEqual(JSON.parse(values.get(key)!),entries,'abandoned invoices survive reload without aging out');
setLocalStorageUserScope('bob');
journal.record('LATE-INVOICE');
assert.equal(values.has(scopedStorageKey(ABANDONED_INVOICES_KEY)),false,'late receive stays with its original identity');
assert.equal(JSON.parse(values.get(key)!).at(-1).state,'abandoned','late resolution after teardown is recorded as abandoned');
setLocalStorageUserScope('alice');
let resolveLate!: (invoice:string)=>void;
const lateInvoice=new Promise<string>(resolve=>{resolveLate=resolve;});
const lateJournal=createFundingInvoiceJournal(input);
const timedOut=await runFundAndLock({...input,description:'timeout test',invoiceJournal:lateJournal,
 getBalance:async()=>0,createFundingInvoice:()=>lateInvoice,
 lockAndPublish:async()=>{throw Error('must not lock');},onPhase:()=>{},invoiceTimeoutMs:1,
});
assert.equal(timedOut.kind,'lock-failed');
resolveLate('AFTER-TIMEOUT');
await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(JSON.parse(values.get(key)!).find((e:{invoice:string})=>e.invoice==='AFTER-TIMEOUT').state,'abandoned','an invoice returned after the orchestrator timeout is still durably recorded');
const crash=createFundingInvoiceJournal(input);crash.record('CRASH-INVOICE');
assert.equal(JSON.parse(values.get(key)!).at(-1).state,'watching','a killed page leaves a durable interrupted-watcher record without an unload event');
crash.stop(true);
assert.equal(JSON.parse(values.get(key)!).at(-1).state,'lock-observed','even an observed lock does not discard a receive record without wallet outcome proof');
values.set(key,'malformed');
assert.throws(()=>createFundingInvoiceJournal(input),'corrupt history blocks creating a competing invoice');
assert.equal(values.get(key),'malformed','corrupt history is never overwritten');
values.delete(key);
Object.defineProperty(globalThis,'localStorage',{value:{...storage,setItem(){throw Error('quota');}}});
assert.throws(()=>createFundingInvoiceJournal(input),'storage refusal blocks invoice creation before the wallet is called');
console.log('Abandoned invoices: abort, operation identity, reload, account isolation, late resolution, crash record, and fail-closed storage passed.');

// Production uses this classifier at both the hook and modal boundaries.
const expectPreflight = (key: string, work: () => unknown) => assert.throws(work, error => {
 assert.ok(error instanceof FundingStorageError);
 assert.deepEqual(fundingStorageFailure(error), {kind:'funding-not-started',reason:key});
 return true;
});
expectPreflight('fund.historyUnwritable',()=>createFundingInvoiceJournal(input));
Object.defineProperty(globalThis,'localStorage',{get(){throw new DOMException('blocked','SecurityError');}});
expectPreflight('fund.storageUnavailable',()=>createFundingInvoiceJournal(input));
Object.defineProperty(globalThis,'localStorage',{value:storage});
values.set(key,'{broken');
expectPreflight('fund.historyUnreadable',()=>createFundingInvoiceJournal(input));
assert.equal(values.get(key),'{broken','unreadable data stays intact while its localized remedy is shown');
values.delete(key);
expectPreflight('fund.contextUnavailable',()=>createFundingInvoiceJournal({...input,federationId:''}));
const afterCreation=createFundingInvoiceJournal(input);
Object.defineProperty(storage,'setItem',{value(){throw new DOMException('quota','QuotaExceededError');},configurable:true});
assert.throws(()=>afterCreation.record('ALREADY-ISSUED'),error=>{
 assert.ok(error instanceof FundingStorageError);
 assert.equal(error.beforeInvoice,false);
 assert.equal(fundingStorageFailure(error)?.kind,'lock-failed','storage failure after invoice creation must never claim funding has not started');
 return true;
});
assert.equal(fundingStorageFailure(new Error('ordinary lock failure')),null);
console.log('Funding storage copy: blocked access, quota, corrupt history, missing context, and pre/post-invoice phase boundary passed.');
