import assert from 'node:assert/strict';
import { EscrowFedimintBridge } from './escrow-bridge.js';
import type { FedimintClient, EscrowLockBundle } from './fedimint-client.js';
import type { EscrowClient, Signer } from '../escrow-engine/escrow-client.js';
import { applyEvent } from '../escrow-engine/state-machine.js';
import { EscrowEventKind, EscrowStatus, type EscrowState, type LockPayload, type ParsedEscrowEvent } from '../escrow-engine/types.js';
import { addSavedHandle, deleteSavedHandle } from '../payments/saved-handles.js';
import { confirmLockPaymentChoice } from '../payments/lock-payment-details.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { setSimMode } from '../sim/simMode.js';
import { requestLockPaymentDetails, type LockPaymentPrompt } from '../ui/lock-payment-prompt.js';

const storage = new Map<string,string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k:string) => storage.get(k) ?? null,
  setItem: (k:string,v:string) => storage.set(k,v),
  removeItem: (k:string) => storage.delete(k),
} });
setLocalStorageUserScope('lock-payment-regression');
setSimMode(true); // Mock money only; bridge rechecks and reducer remain real.
const seller = 'a'.repeat(64), buyer = 'b'.repeat(64), arbiter = 'c'.repeat(64);
const now = Math.floor(Date.now()/1000);
const base = { id:'lock-payment-regression', category:'p2p-trade', status:EscrowStatus.CREATED,
  amountMsats:1000000, createdAt:now, expiresAt:now+86400, description:'Payment test',
  community:'us-usd', participants:{seller,buyer,arbiter}, initiator:{pubkey:seller},
  joinHolds:{}, paymentMethods:['strike'], communityArbiters:[arbiter],
  fees:{platformMsats:0,arbiterMsats:0}, lock:{notesHash:null,lockedAt:null},
  votes:{}, eventChain:[], chatMessages:[],
} as unknown as EscrowState;
const bundle: EscrowLockBundle = { notesHash:'notes', totalMsats:base.amountMsats,
  sellerReceivesMsats:base.amountMsats, arbiterFeeMsats:0,
  shares:[0,1,2].map(index => ({index,data:'share'})) };

async function run(mode:'local-spend'|'invoice-notes', change:'delete'|'mismatch'|'before-funding') {
  let state = {...base, id:`${mode}-${change}`};
  let spends=0, publishes=0;
  const saved = addSavedHandle('strike', 'confirmed-payee');
  confirmLockPaymentChoice(state, {savedHandleId:saved.id});
  const changeHandle = () => {
    if(change === 'mismatch') state = {...state,paymentMethods:['revtag']};
    else deleteSavedHandle(saved.id);
  };
  if(change === 'before-funding') state = {...state,paymentMethods:['revtag']};
  const escrow = { getState:()=>state, getPubkey:async()=>seller,
    lockEscrow:async (_id:string, fields:Parameters<EscrowClient['lockEscrow']>[1]) => {
      publishes++;
      assert.equal(fields.handle,undefined,'lost or mismatched handle is omitted');
      const event = { kind:EscrowEventKind.LOCK, timestamp:now, pubkey:seller, escrowId:state.id,
        payload:{...fields,type:'escrow:lock',lockedAt:now}, prevEventId:null,
        raw:{id:'payment-lock',kind:EscrowEventKind.LOCK,pubkey:seller,created_at:now,tags:[],content:'',sig:''},
      } as ParsedEscrowEvent<LockPayload>;
      const result = applyEvent(state,event);
      assert.ok(result.ok, result.ok ? '' : result.error.message);
      state = result.state;
      return state;
    },
  } as unknown as EscrowClient;
  const fedimint = {
    spendNotesForLock:async()=>{spends++;changeHandle();return {oobNotes:'paid-notes'};},
    buildEscrowLockBundle:async()=>bundle,
    createEscrowLockFromNotes:async()=>bundle,
  } as unknown as FedimintClient;
  const bridge = new EscrowFedimintBridge(escrow,fedimint,{nip44Encrypt:async()=> 'ciphertext'} as unknown as Signer);
  if(change === 'before-funding') {
    await assert.rejects(bridge.preflightLock(state.id,{savedHandleId:saved.id}),/Payment details changed/);
    await assert.rejects(bridge.lockAndPublish(state.id,{savedHandleId:saved.id}),/Payment details changed/);
    assert.equal(spends,0);assert.equal(publishes,0);
  } else {
    if(mode === 'invoice-notes') changeHandle(); // Invoice paid before this method receives notes.
    const result = mode === 'local-spend'
      ? await bridge.lockAndPublish(state.id,{savedHandleId:saved.id})
      : await bridge.lockAndPublishWithEcash(state.id,'paid-notes',{savedHandleId:saved.id});
    assert.equal(result.status,EscrowStatus.LOCKED);
    assert.equal(result.lock.handle,null);
    assert.equal(publishes,1);
    assert.equal(spends,mode === 'local-spend' ? 1 : 0);
  }
  deleteSavedHandle(saved.id);
}
await run('local-spend','before-funding');
for(const mode of ['local-spend','invoice-notes'] as const) {
  await run(mode,'delete');await run(mode,'mismatch');
}
setSimMode(false);

const ref:{current:LockPaymentPrompt|null} = {current:null};
let visible:LockPaymentPrompt|null = null;
const show = (prompt:LockPaymentPrompt|null) => {visible=prompt;};
const first = requestLockPaymentDetails(ref,show,base);
const firstPrompt = ref.current!;
const second = requestLockPaymentDetails(ref,show,{...base,id:'replacement'});
assert.equal(await first,null,'a second confirmation cancels the first before any render');
assert.equal(ref.current!.state.id,'replacement');
assert.equal(visible,ref.current);
firstPrompt.resolve({inChat:true});
assert.equal(ref.current!.state.id,'replacement','stale resolution cannot clear the new prompt');
assert.equal(visible,ref.current,'a stale close cannot hide the new prompt');
ref.current!.resolve({inChat:true});
assert.deepEqual(await second,{inChat:true});
assert.equal(ref.current,null);
console.log('PASS lock payment timing: pre-funding mismatch refuses without spending; removed/mismatched handles after local spend or paid invoice still LOCK; replacement prompt cancels prior request');
