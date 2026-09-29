import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SeatFundingClosed } from "../ui/panels/AtomicFundingModal.js";
import { runFediFundAndLock } from "./fedi-fund-and-lock.js";
import assert from 'node:assert/strict';
import { bech32 } from '@scure/base';
import { schnorr } from '@noble/curves/secp256k1.js';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { EscrowFedimintBridge } from '../fedimint/escrow-bridge.js';
import { applyEvent } from '../escrow-engine/state-machine.js';
import { Role, EscrowStatus, EscrowEventKind } from '../escrow-engine/types.js';
import { fundingInvoiceSeconds, assertFundingInvoiceWithinSeat, assertOnchainFundingWindow, paidLockRefusedCopy } from './seat-funding.js';
import { runFundAndLock, type LnReceiveWatchKind } from './fund-and-lock.js';
import { listPaidLockRecoveries, recordPaidLockRecovery, acknowledgePaidLockRecoveries } from './paid-lock-recovery.js';
import { decideChamaBarLabel } from '../ui/decisions.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
const data = new Map<string, string>();
Object.assign(globalThis, { localStorage: {getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k)} });
setLocalStorageUserScope('brief02-seller');
const now = Date.now();
assert.equal(fundingInvoiceSeconds(now / 1000 + 360, now), 300, 'six minutes left cannot produce a fifteen-minute invoice');
assert.equal(fundingInvoiceSeconds(undefined, now), 900);
assert.equal(fundingInvoiceSeconds(now / 1000 + 360, now, 120), 120, 'gateway default can be shorter');
assert.throws(() => fundingInvoiceSeconds(now / 1000 + 60, now), /rejoin/);
const bits = (n: number, length: number) => Array.from({length}, (_, index) => Math.floor(n / 32 ** (length - index - 1)) % 32);
const invoice = (expiry: number) => bech32.encode('lnbc1700n', [...bits(1000, 7), 6, 0, 2, ...bits(expiry, 2), ...new Array(104).fill(0)], 5000);
assertFundingInvoiceWithinSeat(invoice(255), 1360, 1000000);
assert.throws(() => assertFundingInvoiceWithinSeat(invoice(900), 1360, 1000000), /did not show/);
assert.throws(() => assertFundingInvoiceWithinSeat(invoice(300), 1360, 1301000), /did not show/);
assert.throws(() => assertFundingInvoiceWithinSeat('unreadable', 1360, 1000000), /did not show/);

const f = safetyFixture({buyer: schnorr.getPublicKey(new Uint8Array(32).fill(1)), seller: schnorr.getPublicKey(new Uint8Array(32).fill(2)), arbiter: schnorr.getPublicKey(new Uint8Array(32).fill(3))}, 2_000_000);
let state: typeof f.state = {...f.state, escrowMode: 'ecash' as const, joinHolds: {buyer: {role: Role.BUYER, eventId: "hold-test", pubkey: f.pks.buyer, joinedAt: now / 1000 - 60,
  expiresAt: now / 1000 + 240, orderFinalizedAt: now / 1000 - 30}}};
const client = {getState: () => state, getPubkey: async () => f.pks.seller};
const bridge = new EscrowFedimintBridge(client as any, {} as any, {} as any);
await bridge.preflightLock(state.id);
assert.throws(() => assertOnchainFundingWindow(state, now), /under 10 minutes/);
const selectedItems = [{itemId: 'one', label: 'One', quantity: 1, amountMsats: state.amountMsats}];
state.joinHolds!.buyer!.selectedItems = selectedItems;
state = {...state, items: [{id: 'one', label: 'One', amountMsats: state.amountMsats}]};
await assert.rejects(bridge.preflightLock(state.id), /Select/);
await bridge.preflightLock(state.id, {selectedItems});
state.joinHolds!.buyer!.orderFinalizedAt = 0;
await assert.rejects(bridge.preflightLock(state.id, {selectedItems}), /finalize/);
state.joinHolds!.buyer!.expiresAt = now / 1000 - 121;
await assert.rejects(bridge.preflightLock(state.id, {selectedItems}), /lapsed/);
state = {...state, status: EscrowStatus.CANCELLED};
await assert.rejects(bridge.preflightLock(state.id, {selectedItems}), /no longer lockable/);
const claim = f.event(EscrowEventKind.CLAIM, 'buyer', {type: 'escrow:claim', claimerRole: Role.BUYER, notesHashVerification: 'missing', claimedAt: Math.floor(now / 1000)});
const cancelledClaim = applyEvent(state, claim);
assert(!cancelledClaim.ok && cancelledClaim.error.code === 'TERMINAL_STATE', 'a cancelled trade cannot accept CLAIM');
const cancel = f.event(EscrowEventKind.CANCEL, 'seller', {type: 'escrow:cancel', cancellerRole: Role.SELLER, reason: 'test', cancelledAt: Math.floor(now / 1000)});
const fundedCancel = applyEvent({...state, status: EscrowStatus.APPROVED}, cancel);
assert(!fundedCancel.ok && fundedCancel.error.code === 'INVALID_STATE', 'an approved trade cannot be cancelled out from under its claimant');


let clock = 0, balance = 0, expiry: number | undefined, receive: ((k: LnReceiveWatchKind) => void) | undefined;
const phases: any[] = [];
const recovery = (amount: number) => recordPaidLockRecovery('sm_late', 'fed-test', amount, "The buyer's seat lapsed.");
const result = await runFundAndLock({escrowId: 'sm_late', amountMsats: 170000, description: 'test', seatDeadline: 360,
  getBalance: async () => balance,
  createFundingInvoice: async (_a, _d, cb, _g, seconds) => {expiry = seconds; receive = cb; cb?.('created'); return 'test-bolt11';},
  lockAndPublish: async () => {throw new Error('Local apply failed: ORDER_NOT_FINALIZED');},
  onPhase: p => phases.push(p), onPaidLockRefused: recovery,
  now: () => clock, sleep: async ms => {clock += ms;}, pollIntervalMs: 1000});
assert.equal(expiry, 300, 'expiry survives the journal wrapper');
assert.equal(result.kind, 'expired');
assert(clock <= 300000, 'payable card expires before the seat');
// The receive watch remains attached: payment racing expiry must still be explained.
balance = 170000;
receive?.('claimed');
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(listPaidLockRecoveries()[0].kind, 'lock-recovery');
assert.equal(phases.at(-1).error, paidLockRefusedCopy(170000, "The buyer's seat lapsed."));
assert(!JSON.stringify(phases).includes('Local apply failed'));
acknowledgePaidLockRecoveries('other-fed', 170000);
assert(!listPaidLockRecoveries()[0].seen);
acknowledgePaidLockRecoveries('fed-test', 160000);
assert(!listPaidLockRecoveries()[0].seen);
acknowledgePaidLockRecoveries('fed-test', 170000);
assert(listPaidLockRecoveries()[0].seen);
const opts = {balanceMsats: 0, hasActiveBuyerSellerCommitment: false, paidLockRecoveryMsats: 170000};
assert.deepEqual(decideChamaBarLabel(opts), {kind: 'stranded', sats: 170});
assert.equal(decideChamaBarLabel({...opts, needsYouCount: 1}).kind, 'needs-you');
assert.equal(decideChamaBarLabel({...opts, bootProbeState: 'failed'}).kind, 'unreachable');
// Payment can race expiry and be detected in the same tick that LOCK becomes invalid.
clock = 0; balance = 0;
const paid = await runFundAndLock({escrowId: 'sm_paid', amountMsats: 170000, description: 'test', seatDeadline: 360,
  getBalance: async () => balance,
  createFundingInvoice: async (_a, _d, cb) => {cb?.('created'); balance = 170000; clock = 361000; return 'late-bolt11';},
  lockAndPublish: async () => {throw new Error('Local apply failed: ORDER_NOT_FINALIZED');},
  onPhase: p => phases.push(p), onPaidLockRefused: amount => recordPaidLockRecovery('sm_paid', 'fed-test', amount, "The buyer's seat lapsed."),
  now: () => clock, sleep: async ms => {clock += ms;}, pollIntervalMs: 1000});
assert.equal(paid.kind, 'lock-failed');
if (paid.kind === 'lock-failed') assert.equal(paid.error, paidLockRefusedCopy(170000, "The buyer's seat lapsed."));
assert(listPaidLockRecoveries().some(row => row.escrowId === 'sm_paid' && !row.seen));
console.log('PASS seat funding, reducer preflight, expiry, late-credit recovery, and bar priority');

const closed = renderToStaticMarkup(createElement(SeatFundingClosed, {deadline: 360, now: 360000, onWait: () => {}, onPostAgain: () => {}}));
assert.match(closed, /The buyer&#x27;s seat lapsed before you paid. Nothing was taken./);
assert.match(closed, /Wait for them to rejoin/);
assert.match(closed, /Post it again/);
assert.doesNotMatch(closed, /test-bolt11|lightning:|qr-code/);
const early = renderToStaticMarkup(createElement(SeatFundingClosed, {deadline: 360, now: 300000, onWait: () => {}}));
assert.match(early, /payment window closed before the seat lapsed/);
let returned = false;
const fedi = await runFediFundAndLock({escrowId: 'sm_fedi', amountMsats: 170000, description: 'test',
  preflight: async () => {}, generateEcash: async () => ({notes: 'bearer'}),
  stashFunding: () => {}, clearFunding: () => {}, hashNotes: async () => 'hash',
  receiveEcash: async () => { returned = true; },
  lockAndPublish: async () => {throw Error('Local apply failed: ORDER_NOT_FINALIZED');}, onPhase: () => {}});
assert(returned);
assert.equal(fedi.kind, 'lock-failed');
if (fedi.kind === 'lock-failed') { assert.doesNotMatch(fedi.error, /Local apply failed|ORDER_NOT_FINALIZED/); assert.match(fedi.error, /returned to your Fedi wallet/); }
console.log('PASS closed card rendering and Fedi refused-LOCK custody copy');
