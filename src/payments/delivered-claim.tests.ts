import assert from 'node:assert/strict';
import { EscrowFedimintBridge } from '../fedimint/escrow-bridge.js';
import { EscrowStatus, Outcome, type EscrowState } from '../escrow-engine/types.js';
import { publishDeliveredClaim } from './delivered-claim.js';
import { runClaimAndPayout } from './claim-and-payout.js';
import { selectPayoutReattachTargets } from '../ui/decisions.js';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
} });
let state = { id: 'claim-preview', status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE,
  category: 'p2p-trade', amountMsats: 100_000, participants: { buyer: 'me', seller: 'peer', arbiter: 'arb' },
  eventChain: [], lock: { notesHash: 'verified', shares: new Map([1, 2].map(index => [String(index), { encryptedFor: { me: JSON.stringify({index, data: 'share'}) } }])) },
} as unknown as EscrowState;
let claims = 0;
const client = { getState: () => state, claim: async () => { claims++; state = { ...state, status: EscrowStatus.CLAIMED }; return state; } };
let redeems = 0;
const bridge = new EscrowFedimintBridge(client as any, {
  reconstructAndVerify: async () => ({ notesHash: 'verified', oobNotes: 'original-locked-note' }),
  probeReachable: async () => ({ fed: null }), redeemWithRetry: async () => { redeems++; },
} as any, { getPublicKey: async () => 'me' } as any);
let saved = '';
const preview = await bridge.claimAndExportEcash(state.id, input => { saved = input.notes; }, { deferClaim: true });
assert.equal(saved, 'original-locked-note');
assert.equal(preview.state.status, EscrowStatus.APPROVED);
assert.equal(claims, 0); assert.equal(redeems, 0, 'preview never consumes or mints a note');
await publishDeliveredClaim(client, state.id);
assert.equal(claims, 1, 'import confirmation publishes CLAIM');
await publishDeliveredClaim(client, state.id);
assert.equal(claims, 1, 'confirmation retry does not republish');
state = { ...state, status: EscrowStatus.APPROVED };
await assert.rejects(bridge.claimAndExportEcash(state.id, () => { throw Error('storage full'); }, { deferClaim: true }), /storage full/);
assert.equal(claims, 1); assert.equal(redeems, 0);
await bridge.claimAndRedeem(state.id, { deferClaim: true, clearPendingOnRedeem: false });
assert.equal(state.status, EscrowStatus.APPROVED, 'intermediate wallet credit is not delivery');
assert.equal(redeems, 1);
assert.deepEqual(selectPayoutReattachTargets({ escrows: [state], userPubkey: 'me', getPayoutRecord: () => ({status: 'submitted'}) }), [state.id]);
assert.deepEqual(selectPayoutReattachTargets({ escrows: [state], userPubkey: 'peer', getPayoutRecord: () => ({status: 'submitted'}) }), []);
for (const outcome of ['failed', 'inflight', 'paid'] as const) {
  let balance = 0;
  const before: number = claims;
  const result = await runClaimAndPayout({ escrowId: state.id, bolt11: 'lnbc1u1pinvoice', expectedDeltaMsats: 100_000, saveAfter: false,
    getBalance: async () => balance, claimAndRedeem: async () => { balance = 100_000; },
    payInvoice: async () => {
      assert.equal(claims, before, 'CLAIM not published before payment');
      if (outcome === 'failed') throw Error('payment failed');
      if (outcome === 'inflight') throw Object.assign(Error('waiting'), {code: 'LN_PAY_INFLIGHT', operationId: 'op'});
      return 'op';
    }, completeClaim: async id => { await publishDeliveredClaim(client, id); },
    addOrTouchLightningHandle: () => {}, onPhase: () => {},
  });
  assert.equal(result.kind, outcome === 'paid' ? 'done' : outcome === 'inflight' ? 'payout-confirming' : 'payout-failed');
  assert.equal(claims, before + (outcome === 'paid' ? 1 : 0));
}
console.log('PASS ecash preview/confirmation, safe persistence, deferred Lightning claim and boot reattachment');

// A pasted or provider invoice names its own amount and Fedimint pays it from
// the whole wallet. Oversized and amountless invoices are refused before any
// claim or send happens.
{
  const { payoutInvoiceError } = await import('./bolt11.js');
  assert.equal(payoutInvoiceError('lnbc1u1pexact', 100_000), null, 'exact amount is allowed');
  assert.equal(payoutInvoiceError('lightning:lnbc500n1psmaller', 100_000), null, 'smaller amount is allowed');
  assert.match(payoutInvoiceError('lnbc2u1pbigger', 100_000) ?? '', /more than this payout/);
  assert.match(payoutInvoiceError('lnbc1pnoamount', 100_000) ?? '', /no amount/);
  for (const bolt11 of ['lnbc2u1poversized', 'lnbc1pamountless']) {
    let claimed = 0; let paid = 0;
    const result = await runClaimAndPayout({ escrowId: 'oversized-invoice', bolt11, expectedDeltaMsats: 100_000, saveAfter: false,
      getBalance: async () => 100_000, claimAndRedeem: async () => { claimed++; },
      payInvoice: async () => { paid++; return 'op'; },
      addOrTouchLightningHandle: () => {}, onPhase: () => {},
    });
    assert.equal(result.kind, 'payout-failed');
    assert.equal(claimed, 0, `${bolt11}: nothing is claimed`);
    assert.equal(paid, 0, `${bolt11}: nothing is sent`);
  }
}
console.log('PASS oversized and amountless payout invoices are refused before claim');
