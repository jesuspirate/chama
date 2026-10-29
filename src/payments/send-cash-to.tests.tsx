// Jet (6.4.31-rc.1): "It just needs to be uniform everywhere not to let trades
// sit without making sure both parties agreed on where to send the cash to.
// Should be mandatory." These tests pin the rule on every lock path:
//   - before sats move, a cash trade needs a real saved address for one of
//     the agreed methods ("send in chat" no longer counts);
//   - after sats move, a missing or changed detail never refuses the lock;
//   - on-chain trades choose before the deposit address exists and reveal the
//     choice in the LOCK, even if the saved entry is deleted meanwhile;
//   - the cash card stays on screen from the lock until the trade ends.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { bytesToHex } from '@noble/hashes/utils.js';
import { LangProvider } from '../i18n/index.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { EscrowEventKind as Kind, EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
import { applyEvent } from '../escrow-engine/state-machine.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { deriveEscrowSigningKey } from '../bond-multisig/onchain-escrow-funding.js';
import { deriveBondSigningKey } from '../bond-multisig/commitment-bond.js';
import { SIGNET } from '../bond-multisig/multisig.js';

const values = new Map<string, string>();
let failWrites = false;
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => { if (failWrites) throw new Error('QuotaExceededError'); values.set(k, v); },
  removeItem: (k: string) => void values.delete(k),
} });
setLocalStorageUserScope('send-cash-to-test');
const { addSavedHandle, deleteSavedHandle } = await import('./saved-handles.js');
const { assertCreatePaymentMethods, assertJoinPaymentMethods, assertTradePaymentDetails, matchingTradeHandles, tradeCashDetailsVisible } = await import('./trade-payment-details.js');
const { getOnchainPaymentChoice, saveOnchainPaymentChoice, onchainLockHandleParams, ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY } = await import('./onchain-payment-choice.js');
const { TradePaymentDetailsChoice, BuyerPaymentDetails } = await import('../ui/components/TradePaymentDetails.js');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const render = (node: React.ReactElement) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);

const offer = { id: 'cash-offer', category: 'p2p-trade', status: EscrowStatus.CREATED, paymentMethods: ['m-pesa'],
  lock: { handle: null }, participants: {} } as unknown as EscrowState;

{
  // 1. Before sats move: a real address for an agreed method, every category with a cash leg.
  const mpesa = addSavedHandle('m-pesa', '+255 700 111 222');
  const strike = addSavedHandle('strike', 'jet@strike.me');
  for (const category of ['p2p-trade', 'bill-pay', 'lending']) {
    const trade = { ...offer, category } as EscrowState;
    for (const opts of [{}, { paymentDetailsInChat: true }, { savedHandleId: '' }]) {
      assert.throws(() => assertTradePaymentDetails(trade, opts), (e: any) => e.code === 'PAYMENT_DETAILS_REQUIRED' && /No sats moved/.test(e.message),
        `${category}: nothing chosen is refused, chat included`);
    }
    assert.throws(() => assertTradePaymentDetails(trade, { savedHandleId: strike.id }), /agreed methods/, `${category}: a method nobody agreed is refused`);
    assert.throws(() => assertTradePaymentDetails(trade, { savedHandleId: 'gone' }), /agreed methods/, `${category}: a deleted entry is refused`);
    assertTradePaymentDetails(trade, { savedHandleId: mpesa.id });
  }
  for (const category of ['marketplace', 'chama-share']) assertTradePaymentDetails({ ...offer, category } as EscrowState, {});
  assert.deepEqual(matchingTradeHandles(offer).map(h => h.id), [mpesa.id]);
  assert.deepEqual(matchingTradeHandles({ ...offer, paymentMethods: [] } as EscrowState).map(h => h.id).sort(), [mpesa.id, strike.id].sort(),
    'a listing with no agreed methods still takes a real address');

  // The chooser offers saved addresses and a way to add one, never "in chat".
  for (const value of ['', mpesa.id]) {
    const html = render(<TradePaymentDetailsChoice state={offer} value={value} onChange={() => {}} />);
    assert.doesNotMatch(html, /in chat|data-payment-details-chat/);
  }
  assert.match(render(<TradePaymentDetailsChoice state={offer} value={mpesa.id} onChange={() => {}} />), /M-Pesa · \+255/);
}
console.log('PASS before sats move: a cash trade needs a real address for an agreed method; chat is not a choice');

{
  // 2. The bridge: only the two post-payment re-checks skip the payment
  //    details, and every pre-payment entry point still asserts them.
  const bridge = read('../fedimint/escrow-bridge.ts');
  assert.match(bridge, /if \(!opts\.afterSatsMoved\) assertTradePaymentDetails\(state, opts\);/);
  const hook = read('../hooks/useEscrow.ts');
  const calls = [...hook.matchAll(/preflightLock\(([^;]*?)\)\)?;/g)].map(m => m[0]);
  assert.equal(calls.length, 8, 'every preflightLock call in useEscrow is accounted for');
  const after = calls.filter(call => /afterSatsMoved: true/.test(call));
  assert.equal(after.length, 2, 'exactly the claimed-deposit and paid-invoice re-checks run after sats move');
  // Each marked call follows the payment, never precedes it.
  const deposit = hook.indexOf('// The deposit is already in the wallet: re-check the trade, not the payment details.');
  assert(deposit > hook.indexOf('opts.onPhase({ kind: "locking" });', deposit - 400), 'deposit re-check sits after the claim');
  assert(hook.indexOf('// The invoice is paid: re-check the trade, not the payment details.') > 0);
  // The lock itself never asserts payment details: a vanished entry locks without one.
  assert.doesNotMatch(bridge.slice(bridge.indexOf('async lockAndPublishInner'), bridge.indexOf('async preflightLock')), /assertTradePaymentDetails/);
}
console.log('PASS after sats move: only the post-payment re-checks skip the payment details');

{
  // 3. On-chain: the choice is a snapshot that survives deleting the entry,
  //    and a store that fails never fakes success.
  const cash = addSavedHandle('m-pesa', '+255 700 333 444');
  assert.equal(getOnchainPaymentChoice('oc-1'), null);
  const saved = saveOnchainPaymentChoice('oc-1', cash, 1000);
  assert.deepEqual(saved, { handleId: cash.id, handle: cash.handle, rail: 'm-pesa', chosenAt: 1000 });
  deleteSavedHandle(cash.id);
  assert.equal(getOnchainPaymentChoice('oc-1')?.handle, cash.handle, 'deleting the saved entry keeps what was agreed');
  assert.deepEqual(onchainLockHandleParams(getOnchainPaymentChoice('oc-1')),
    { handleId: cash.id, handle: cash.handle, rail: 'm-pesa' });
  assert.deepEqual(onchainLockHandleParams(null), {}, 'no choice: the lock goes out with the agreed methods plus chat');
  const tagged = saveOnchainPaymentChoice('oc-2', { ...cash, id: 'phone', networks: ['m-pesa', 'airtel-money'] });
  assert.deepEqual(onchainLockHandleParams(tagged).handleNetworks, ['m-pesa', 'airtel-money']);
  assert.equal(getOnchainPaymentChoice('oc-1')?.handleId, cash.id, 'other trades keep their choice');

  assert.throws(() => saveOnchainPaymentChoice('oc-3', { ...cash, handle: '   ' }), /empty/);
  failWrites = true;
  assert.throws(() => saveOnchainPaymentChoice('oc-3', cash), /QuotaExceeded|couldn’t save/);
  failWrites = false;
  assert.equal(getOnchainPaymentChoice('oc-3'), null);

  const key = `${ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY}:send-cash-to-test`;
  const good = values.get(key)!;
  values.set(key, '[not json');
  assert.equal(getOnchainPaymentChoice('oc-1'), null, 'an unreadable store reads as "ask again", never as a choice');
  // A store that no longer parses is kept aside, so funding isn't blocked forever.
  saveOnchainPaymentChoice('oc-4', cash);
  assert.equal(values.get(`${ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY}_unreadable:send-cash-to-test`), '[not json');
  assert.equal(getOnchainPaymentChoice('oc-4')?.handleId, cash.id);
  values.set(key, good);

  setLocalStorageUserScope(null);
  assert.equal(getOnchainPaymentChoice('oc-1'), null);
  assert.throws(() => saveOnchainPaymentChoice('oc-5', cash), /Sign in/);
  setLocalStorageUserScope('send-cash-to-test');
}
console.log('PASS on-chain choice: kept as agreed, per trade, and never faked when storage fails');

{
  // 4. On-chain wiring: checked and stored before the funding-terms JOIN (the
  //    deposit address cannot exist yet), revealed at LOCK, never required there.
  const hook = read('../hooks/useEscrow.ts');
  const prep = hook.slice(hook.indexOf('const prepareOnchainFunding = useCallback'), hook.indexOf('/** Ask the chain whether the escrow is funded'));
  const assertAt = prep.indexOf('assertTradePaymentDetails(trade, opts);');
  const saveAt = prep.indexOf('saveOnchainPaymentChoice(escrowId, getSavedHandle(opts.savedHandleId!)!);');
  const joinAt = prep.indexOf('await client.joinEscrow(escrowId, role, { fundingTerms');
  assert(assertAt > 0 && saveAt > assertAt && joinAt > saveAt, 'assert, then store, then publish the address');
  assert(prep.indexOf('if (trade.participants[role] !== await client.getPubkey())') < assertAt, 'only the funder records a choice');
  const lock = hook.slice(hook.indexOf('const publishOnchainLock = useCallback'), hook.indexOf('// Seed on launch, discovery and enable'));
  assert.doesNotMatch(lock, /assertTradePaymentDetails/, 'a confirmed deposit never waits on a payment detail');
  assert.match(lock, /\.\.\.onchainLockHandleParams\(chosen\),/);

  const controls = read('../ui/panels/OnchainTradeControls.tsx');
  assert.match(controls, /\|\| !view\.viewerFunds \|\| awaitingCashChoice\n/, 'no automatic address while the choice is missing');
  assert.match(controls, /onClick=\{\(\) => void run\(\(\) => prepareFunding\(cashPick\)\)\}/);
  assert.match(controls, /disabled=\{busy \|\| !cashPick\}/, 'repeated taps wait for the first');

  // The reducer takes the revealed handle on an on-chain LOCK, so the buyer and
  // arbiter see where to send the cash exactly as on an ecash trade.
  const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const b = deriveEscrowSigningKey(WORDS, 'buyer', { network: SIGNET });
  const s = deriveEscrowSigningKey(WORDS, 'seller', { network: SIGNET });
  const a = deriveBondSigningKey(WORDS, { network: SIGNET, index: 7 });
  const fixture = safetyFixture({ buyer: b.xonly, seller: s.xonly, arbiter: a.xonly }, 2000000, 'send-cash-to');
  fixture.apply(fixture.event(Kind.JOIN, 'seller', { type: 'escrow:join', role: Role.SELLER, joinedAt: Date.now() / 1000, fundingTerms: fixture.terms }));
  const lockTerms = { ...fixture.terms, amountSats: '100000', fundingTxid: '11'.repeat(32), fundingVout: 0 };
  const base = { type: 'escrow:lock' as const, notesHash: '', shares: [], onchain: lockTerms,
    buyerPubkey: fixture.pks.buyer, arbiterPubkey: fixture.pks.arbiter, sellerReceivesMsats: 100000000, arbiterFeeMsats: 0, lockedAt: Date.now() / 1000 };
  const withHandle = applyEvent(fixture.state, fixture.event(Kind.LOCK, 'seller', { ...base, handleId: 'h1', handle: '+255 700 333 444', rail: 'm-pesa' }));
  assert(withHandle.ok, 'an on-chain LOCK accepts the handle');
  assert.equal(withHandle.state.lock.handle?.value, '+255 700 333 444');
  const enveloped = applyEvent(fixture.state, fixture.event(Kind.LOCK, 'seller', { ...base,
    handleEnvelope: { encryptedFor: { [fixture.pks.buyer]: 'c1', [fixture.pks.seller]: 'c2', [fixture.pks.arbiter]: 'c3' } } } as any));
  assert(enveloped.ok, 'an on-chain LOCK accepts the encrypted envelope the client sends');
  const bare = applyEvent(fixture.state, fixture.event(Kind.LOCK, 'seller', base));
  assert(bare.ok && bare.state.lock.handle === null, 'without a choice the funded LOCK still commits');
  assert.equal(bytesToHex(s.xonly), fixture.terms.sellerXonly);
}
console.log('PASS on-chain wiring: choose before the address, reveal at LOCK, never block a funded lock');

{
  // 5. The cash card stays from the lock until the trade ends, on both views.
  const parties = { participants: { [Role.BUYER]: 'buyer-pk', [Role.SELLER]: 'seller-pk' } };
  assert.equal(tradeCashDetailsVisible({ ...offer, status: EscrowStatus.LOCKED } as EscrowState), true);
  for (const status of [EscrowStatus.APPROVED, EscrowStatus.CLAIMED]) {
    // Released to the buyer: the cash is still owed, keep the card.
    assert.equal(tradeCashDetailsVisible({ ...offer, ...parties, status, resolvedOutcome: 'release' } as unknown as EscrowState), true, status);
    // Refunded to the seller: nobody should send cash now.
    assert.equal(tradeCashDetailsVisible({ ...offer, ...parties, status, resolvedOutcome: 'refund' } as unknown as EscrowState), false, status);
  }
  for (const status of [EscrowStatus.CREATED, EscrowStatus.COMPLETED, EscrowStatus.EXPIRED, EscrowStatus.CANCELLED]) {
    assert.equal(tradeCashDetailsVisible({ ...offer, status } as EscrowState), false, status);
  }
  for (const screen of ['../ui/screens/LiveTradeSurface.tsx', '../ui/screens/TradeDetail.tsx']) {
    const src = read(screen);
    assert.match(src, /\{tradeCashDetailsVisible\(state\) && myRole === Role\.BUYER && needsTradePaymentDetails\(state\) && <BuyerPaymentDetails state=\{state\} \/>\}/, screen);
    assert.doesNotMatch(src, /state\.status === EscrowStatus\.LOCKED && (myRole && )?(!?state\.lock\.handle|myRole === Role\.BUYER && needsTradePaymentDetails)/, `${screen}: no LOCKED-only cash card left`);
    assert.doesNotMatch(src, /CHAT_PAYMENT_CHOICE|paymentDetailsInChat: /, `${screen}: no chat choice reaches the lock`);
  }
  // An older offer with no agreed methods still offers methods to add an address with.
  const legacy = render(<TradePaymentDetailsChoice state={{ ...offer, paymentMethods: [], community: 'tanzania' } as unknown as EscrowState} value="" onChange={() => {}} />);
  assert.match(legacy, /role="radio"/, 'the add form has methods to pick');
  const approved = { ...offer, status: EscrowStatus.APPROVED, lock: { handle: { id: 'h', value: '+255 700 333 444', rail: 'm-pesa', networks: [] } } } as unknown as EscrowState;
  assert.match(render(<BuyerPaymentDetails state={approved} />), /\+255 700 333 444/);
  for (const lang of ['en', 'es', 'fr', 'sw']) {
    const strings = read(`../i18n/${lang}/onchain.ts`);
    assert.match(strings, /"onchain\.cashChoiceIntro": "/, lang); assert.match(strings, /"onchain\.useCashDetails": "/, lang);
    assert.doesNotMatch(read(`../i18n/${lang}/trade.ts`), /trade\.sendDetailsInChat/, lang);
  }
}
console.log('PASS display: where the cash goes stays visible until the trade ends');

{
  // 6. Before anyone can match: a new cash offer names how the cash is paid.
  for (const category of ['p2p-trade', 'bill-pay', 'lending']) {
    for (const paymentMethods of [undefined, [], ['  ']]) {
      assert.throws(() => assertCreatePaymentMethods({ category, paymentMethods }), (e: any) => e.code === 'PAYMENT_METHODS_REQUIRED', `${category}: no methods, no offer`);
    }
    assertCreatePaymentMethods({ category, paymentMethods: ['m-pesa'] });
    assert.throws(() => assertCreatePaymentMethods({ category, tranche: { index: 0 } }), /way the cash can be paid/, `${category}: a new plan's first slice is a new offer`);
    // Continuations keep the terms both people already signed.
    assertCreatePaymentMethods({ category, tranche: { index: 1 } });
    assertCreatePaymentMethods({ category, trancheChild: {} });
    assertCreatePaymentMethods({ category, parent: 'circle' });
  }
  for (const category of ['marketplace', 'chama', 'chama-share']) assertCreatePaymentMethods({ category });
  const hook = read('../hooks/useEscrow.ts');
  const create = hook.indexOf('assertCreatePaymentMethods(params as');
  assert(create > 0 && create < hook.indexOf('const result = await client.createEscrow({'), 'checked before the CREATE is signed');
}
console.log('PASS posting: a new cash offer needs at least one payment method; Market and Circles do not');

{
  // 7. Matching: an older cash offer with no methods can't be taken.
  const bare = { ...offer, paymentMethods: [] } as EscrowState;
  assert.throws(() => assertJoinPaymentMethods(bare, Role.BUYER), (e: any) => e.code === 'PAYMENT_METHODS_REQUIRED');
  assertJoinPaymentMethods(offer, Role.BUYER);
  assertJoinPaymentMethods(bare, Role.ARBITER);
  assertJoinPaymentMethods({ ...bare, category: 'marketplace' } as EscrowState, Role.BUYER);
  const hook = read('../hooks/useEscrow.ts');
  const join = hook.slice(hook.indexOf('const joinEscrow = useCallback'));
  assert(join.indexOf('assertJoinPaymentMethods(seatState, role)') > 0
    && join.indexOf('assertJoinPaymentMethods(seatState, role)') < join.indexOf('await requireRestorableEscrowKey(client)'), 'refused before anything is signed');
}
console.log('PASS matching: a cash offer without payment methods cannot be taken');

{
  // 8. Automatic renewals skip an older cash offer with no methods instead of
  //    spending a cycle on a post that would be refused.
  const { cashOfferMissingMethods } = await import('./trade-payment-details.js');
  assert.equal(cashOfferMissingMethods({ category: 'p2p-trade', paymentMethods: [] }), true);
  assert.equal(cashOfferMissingMethods({ category: 'p2p-trade', paymentMethods: ['m-pesa'] }), false);
  assert.equal(cashOfferMissingMethods({ category: 'marketplace' }), false);
  const app = read('../ui/App.tsx');
  const renew = app.indexOf('if (cashOfferMissingMethods(l)) continue;');
  assert(renew > 0 && renew < app.indexOf('bumpAutoRenewCount(listingIdentityKey(l));', renew), 'skipped before the renewal count is spent');
  const repost = app.indexOf('if (source && cashOfferMissingMethods(source)) continue;');
  assert(repost > 0 && repost < app.indexOf('cbpRepostedRef.current.add(cycleKey);', repost), 'skipped before the monthly cycle is spent');
}
console.log('PASS renewals: an older cash offer without methods is skipped, not silently spent');

{
  // 9. Another device signed in as the funder finds the choice on relays,
  //    encrypted to the funder's own key, and nobody else's copy counts.
  const { publishCashChoiceCopy, fetchCashChoiceCopy, cashChoiceDTag, CASH_CHOICE_KIND } = await import('./onchain-payment-choice-relay.js');
  const relay: any[] = [];
  const signerFor = (pubkey: string) => ({
    getPublicKey: async () => pubkey,
    nip44Encrypt: async (plain: string, to: string) => `enc:${to}:${plain}`,
    nip44Decrypt: async (cipher: string, from: string) => {
      if (!cipher.startsWith(`enc:${from}:`)) throw new Error('bad ciphertext');
      return cipher.slice(`enc:${from}:`.length);
    },
    signEvent: async (event: any) => ({ ...event, pubkey, id: `id${relay.length}`, sig: 'sig' }),
  });
  const funder = signerFor('funder-pk');
  const query = async (filter: any) => relay.filter(e => filter.authors.includes(e.pubkey)
    && filter.kinds.includes(e.kind) && e.tags.some((t: string[]) => t[0] === 'd' && filter['#d'].includes(t[1])));
  const choice = { handleId: 'h9', handle: '+255 700 999 000', rail: 'm-pesa', chosenAt: 1 };
  await publishCashChoiceCopy({ escrowId: 'oc-relay', choice, signer: funder, publish: async e => { relay.push(e); }, now: 100 });
  assert.equal(relay[0].kind, CASH_CHOICE_KIND);
  assert.doesNotMatch(JSON.stringify(relay[0].tags), /oc-relay/, 'the d-tag does not name the trade');
  assert.match(relay[0].content, /^enc:funder-pk:/, 'encrypted to the funder');
  // Same app-data kind as the seed backup, never mistaken for one.
  const { CHAMA_SEED_D_TAG } = await import('../fedimint/seed-manager.js');
  const { SEED_V2_D_PREFIX } = await import('../fedimint/seed-backup-v2.js');
  const d = relay[0].tags.find((t: string[]) => t[0] === 'd')[1];
  assert(d !== CHAMA_SEED_D_TAG && !d.startsWith(SEED_V2_D_PREFIX));
  assert.deepEqual(await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: funder, query }), choice, 'the second device finds it');
  // A newer copy wins; an unreadable newest falls back to the older one.
  await publishCashChoiceCopy({ escrowId: 'oc-relay', choice: { ...choice, handle: '+255 700 999 111', chosenAt: 2 }, signer: funder, publish: async e => { relay.push(e); }, now: 200 });
  assert.equal((await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: funder, query }))?.handle, '+255 700 999 111');
  relay.push({ ...relay[1], id: 'garbled', created_at: 300, content: 'garbled' });
  assert.equal((await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: funder, query }))?.handle, '+255 700 999 111');
  // Someone else's event under the same tag, or a copy for another trade, never counts.
  relay.push({ kind: CASH_CHOICE_KIND, pubkey: 'funder-pk', created_at: 400, id: 'moved', sig: 's',
    tags: [['d', cashChoiceDTag('oc-relay')]], content: `enc:funder-pk:${JSON.stringify({ escrowId: 'other-trade', choice })}` });
  assert.equal((await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: funder, query }))?.handle, '+255 700 999 111', 'a copy for another trade is ignored');
  assert.equal(await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: signerFor('stranger-pk'), query }), null);
  assert.equal(await fetchCashChoiceCopy({ escrowId: 'oc-relay', signer: funder, query: async () => { throw new Error('offline'); } }), null,
    'relays down after the deposit: no copy, the LOCK still goes out');
  // Publishing fails closed, before the address can exist.
  await assert.rejects(publishCashChoiceCopy({ escrowId: 'oc-x', choice, signer: funder, publish: async () => { throw new Error('all relays rejected'); } }), /rejected/);
  await assert.rejects(publishCashChoiceCopy({ escrowId: 'oc-x', choice, signer: { ...funder, signEvent: async (e: any) => ({ ...e, pubkey: 'someone-else', id: 'x', sig: 'x' }) }, publish: async () => {} }), /signer changed/);

  const hook = read('../hooks/useEscrow.ts');
  const prep = hook.slice(hook.indexOf('const prepareOnchainFunding = useCallback'), hook.indexOf('/** Ask the chain whether the escrow is funded'));
  const pub = prep.indexOf('await publishCashChoiceCopy(');
  assert(pub > prep.indexOf('saveOnchainPaymentChoice(') && pub < prep.indexOf('await client.joinEscrow(escrowId, role, { fundingTerms'), 'copied to relays before the address exists');
  const lock = hook.slice(hook.indexOf('const publishOnchainLock = useCallback'), hook.indexOf('// Seed on launch, discovery and enable'));
  assert.match(lock, /await restoreCashChoice\(escrowId\)/, 'the LOCK uses the relay copy when this device has none');
}
console.log('PASS other devices: the funder\'s cash choice is kept on relays, encrypted to them, and only their copy for this trade counts');
