// v7 redesign: every money move in the guided trade room is a hold-to-confirm
// (lock, release, agree-to-refund, collect). Pins that no "tap again" path
// remains and that the hold wraps the same handler the old button fired.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveTradeSurface, recordAcceptedVote } from './screens/LiveTradeSurface.js';
import { EscrowStatus, Outcome, Role, type EscrowState } from '../escrow-engine/types.js';
import { payoutRecipientFor } from '../escrow-engine/recipients.js';
import { LangProvider } from '../i18n/index.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { CLAIM_HOLD_IN_SHEET, collectIsHold } from './claim-hold.js';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
} });
setLocalStorageUserScope('money-hold-test');

const buyer = 'b'.repeat(64), seller = 'a'.repeat(64), arbiter = 'c'.repeat(64);
const now = Date.now() / 1000;
const base = {
  provenance: 'chain', id: 'hold-test', category: 'p2p-trade', amountMsats: 1_000_000, description: 'Test',
  createdAt: now, expiresAt: now + 86400, participants: { buyer, seller, arbiter },
  initiator: { pubkey: seller }, votes: {}, eventChain: [], chatMessages: [], communityArbiters: [arbiter],
};
const HOLD = /Press and hold to confirm/;
const room = (state: EscrowState, pubkey: string, extra: Record<string, unknown> = {}) => renderToStaticMarkup(
  <LangProvider><LiveTradeSurface state={state} pubkey={pubkey} onBack={() => {}} onOpenFullView={() => {}}
    onVote={async () => true} onSendChat={async () => {}} {...extra} /></LangProvider>);

// Release — both the first vote and the confirming vote.
const locked = { ...base, status: EscrowStatus.LOCKED, lock: { notesHash: 'locked', lockedAt: now } } as unknown as EscrowState;
const recipient = payoutRecipientFor(locked, Outcome.RELEASE)!;
for (const viewer of [buyer, seller]) {
  const first = viewer === recipient.pubkey;
  const state = first ? locked : { ...locked, votes: { [recipient.role]: Outcome.RELEASE } } as EscrowState;
  const html = room(state, viewer);
  assert.match(html, HOLD, `${first ? 'first' : 'confirming'} release is a hold`);
  assert.doesNotMatch(html, /Tap again/i, 'no tap-again release remains');
}

// Agree to the counterparty's refund.
const asked = { ...locked, votes: { [recipient.role]: Outcome.REFUND } } as EscrowState;
const askedViewer = recipient.pubkey === buyer ? seller : buyer;
const askedHtml = room(asked, askedViewer);
assert.match(askedHtml, /Agree — take my sats back/, 'the agree-to-refund decision is the one rendered');
assert.match(askedHtml, HOLD, 'agreeing to a refund is a hold');

// Dispute (display only): buyer and seller disagree → the arbiter decides.
const disputed = { ...locked, votes: { buyer: Outcome.RELEASE, seller: Outcome.REFUND } } as unknown as EscrowState;
const disputeHtml = room(disputed, buyer);
assert.match(disputeHtml, /You two disagree, so the arbiter decides/);
assert.match(disputeHtml, /You voted release/);
assert.match(disputeHtml, /voted refund/);
assert.match(disputeHtml, /is reviewing/);
assert.doesNotMatch(room(disputed, arbiter), /You two disagree/, 'the arbiter is not told "you two disagree"');

// Collect.
// canOfferClaim is fail-closed: only a REPLAYED chain offers collect.
const approved = { ...locked, provenance: 'replayed', status: EscrowStatus.APPROVED, resolvedOutcome: Outcome.RELEASE } as unknown as EscrowState;
const winner = payoutRecipientFor(approved, Outcome.RELEASE)!.pubkey;
// Option b (Jet, 2026-10-05): outside Fedi, Collect only opens the claim sheet,
// so it is a plain tap there — the hold is on the sheet's final send.
const collectHtml = room(approved, winner, { onClaim: async () => {} });
assert.doesNotMatch(collectHtml, HOLD, 'outside Fedi, Collect is a plain tap (the sheet holds)');
assert.match(collectHtml, /<button[^>]*>Claim</, 'the Claim button is still offered');
assert.doesNotMatch(room({ ...approved, provenance: 'summary' } as EscrowState, winner, { onClaim: async () => {} }), HOLD,
  'a saved summary still offers no collect at all (unchanged guard)');

// Lock — the funder's fund-and-lock.
const created = { ...base, status: EscrowStatus.CREATED, lock: { notesHash: null, lockedAt: null } } as unknown as EscrowState;
const lockHtml = room(created, seller, { onLock: async () => {} });
assert.match(lockHtml, /Fund &amp; lock|Fund & lock/, 'the funder is offered the lock');
assert.match(lockHtml, HOLD, 'locking is a hold');

// Option b is on.
assert.equal(CLAIM_HOLD_IN_SHEET, true, 'Jet chose option b: the hold is on the claim sheet');
assert.equal(collectIsHold(), false, 'outside Fedi, Collect is not a hold');

// Inside Fedi, the sheet auto-claims the moment Collect is tapped, so Collect
// itself must stay a hold.
const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Mozilla/5.0 Fedi/2.4', maxTouchPoints: 5 } });
assert.equal(collectIsHold(), true, 'inside Fedi, Collect stays a hold');
assert.match(room(approved, winner, { onClaim: async () => {} }), HOLD, 'inside Fedi, Collect renders as a hold');
if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator); else delete (globalThis as { navigator?: unknown }).navigator;
assert.equal(collectIsHold(), false);

// The sheet's destinations: typed sends and saved-wallet sends are holds, and
// a saved row only SELECTS (no render-time or tap-time dispatch).
const { DestinationPicker } = await import('./components/DestinationPicker.js');
const { readFileSync, readdirSync } = await import('node:fs');
const unexpected = () => { throw new Error('must not dispatch'); };
const typedHtml = renderToStaticMarkup(<LangProvider><DestinationPicker holdToSend amountSats={196}
  initialAddress="bitcrazy@getalby.com" savedDestinations={[]} savedNwcConnections={[]}
  title="Claim" onResolve={unexpected} onCancel={unexpected} /></LangProvider>);
assert.match(typedHtml, HOLD, 'a typed Lightning address sends with a hold');
assert.match(typedHtml, /Hold to send 196 sats/);
assert.match(typedHtml, /to bitcrazy@getalby.com/);
// Recovery (Jet, 2026-10-05: "hold too") uses the same picker with holds.
const recovery = readFileSync(new URL('./panels/RecoveryPayoutModal.tsx', import.meta.url), 'utf8');
assert.match(recovery, /<DestinationPicker\s+holdToSend\s/, 'the recovery picker holds');
// No single-tap send anywhere: every DestinationPicker in the app holds.
function uiSourceFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.includes('.tests')) return [];
    const file = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
    return entry.isDirectory() ? uiSourceFiles(file) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [file] : [];
  });
}
const pickers = uiSourceFiles(new URL('./', import.meta.url)).filter(file => readFileSync(file, 'utf8').includes('<DestinationPicker'));
assert.ok(pickers.length > 0, 'the source walk must find payout pickers');
for (const file of pickers) {
  // Real JSX uses only — comment lines that merely mention the component are skipped.
  const src = readFileSync(file, 'utf8').split('\n').filter(line => !/^\s*(\/\/|\*)/.test(line)).join('\n');
  const uses = src.match(/<DestinationPicker\b[^>]*/g) ?? [];
  assert.ok(uses.length > 0, `${file}: renders a picker`);
  for (const use of uses) assert.match(use, /holdToSend/, `${file}: every payout picker holds`);
}

// Every final "send" route in the claim sheet goes through ClaimSendButton.
const sheet = readFileSync(new URL('./panels/ClaimPayoutModal.tsx', import.meta.url), 'utf8');
assert.equal((sheet.match(/<ClaimSendButton/g) ?? []).length, 5, 'invoice, M-Pesa (2), Strike and on-chain sends hold');
assert.doesNotMatch(sheet, /onClick=\{\(\) => void submit\(\)\}/, 'no single-tap submit remains');
assert.match(sheet, /<DestinationPicker\s+holdToSend=\{CLAIM_HOLD_IN_SHEET\}/, 'the claim picker holds');

console.log('PASS money moves: lock, release (first + confirming) and agree-to-refund are hold-to-confirm; no tap-again path; option b: claim- and recovery-sheet sends hold, Collect plain outside Fedi and a hold inside; dispute card reads committed votes');

// App catches failed and suppressed votes and returns false. Neither is an
// accepted vote; retries must be immediately available, without a timer.
for (const reason of ['failed', 'suppressed']) {
  let recorded = false;
  let attempts = 0;
  const vote = async () => { attempts++; return false; };
  const accepted = () => { recorded = true; };
  await recordAcceptedVote(vote, Outcome.RELEASE, accepted);
  await recordAcceptedVote(vote, Outcome.RELEASE, accepted);
  assert.equal(attempts, 2, `${reason}: immediate retry reaches the same vote handler`);
  assert.equal(recorded, false, `${reason}: never enters recording state`);
  const html = room(locked, recipient.pubkey, { onVote: vote });
  assert.match(html, HOLD, `${reason}: the vote button remains visible`);
  assert.doesNotMatch(html, /Recording your vote/);
}
let acceptedCount = 0;
await assert.rejects(recordAcceptedVote(async () => { throw Error('transport failed'); }, Outcome.RELEASE, () => { acceptedCount++; }), /transport failed/);
assert.equal(acceptedCount, 0, 'thrown failures never enter recording state');
await recordAcceptedVote(async () => true, Outcome.RELEASE, () => { acceptedCount++; });
assert.equal(acceptedCount, 1, 'only a successful vote starts the short recording placeholder');
console.log('PASS vote feedback: failed, suppressed and thrown attempts never record; failed attempts retry immediately; only success records');

// Phone chat is a seated participant's sheet; no message/money handlers change.
{
  const { unreadTradeMessages, phoneTradeChatCss, readChatSeen, writeChatSeen } = await import('./phone-trade-chat.js');
  const message = (author: string, at: number, id: string) => ({ raw: { pubkey: author, created_at: at, id }, payload: { message: 'Hello', senderRole: Role.BUYER, sentAt: at } }) as EscrowState['chatMessages'][number];
  const messages = [message(buyer, 11, 'buyer-new'), message(seller, 12, 'my-cancel-reason'), message(arbiter, 13, 'arbiter-new'), message(buyer, 9, 'buyer-seen'), message('f'.repeat(64), 14, 'outsider')];
  assert.deepEqual(unreadTradeMessages(messages, seller, [buyer, seller, arbiter], 10).map(m => m.raw.id), ['buyer-new', 'arbiter-new']);
  assert.equal(unreadTradeMessages(messages, seller, [buyer, seller], 10).length, 1, 'unseated arbiter does not count');
  assert.equal(unreadTradeMessages(messages, seller, [buyer, seller, arbiter], 13).length, 0);
  writeChatSeen('chat-test', seller, 13);
  assert.equal(readChatSeen('chat-test', seller), 13);
  assert.equal(readChatSeen('chat-test', buyer), 0, 'seen receipts are scoped to the viewer');
  const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')!;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => { throw new Error('private mode'); }, setItem: () => { throw new Error('private mode'); } } });
  try { assert.equal(readChatSeen('chat-test', seller), 0); assert.doesNotThrow(() => writeChatSeen('chat-test', seller, 13)); }
  finally { Object.defineProperty(globalThis, 'localStorage', storageDescriptor); }
  writeChatSeen(locked.id, seller, 10);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { matchMedia: () => ({ matches: true }) } });
  try {
    const phone = room({ ...locked, chatMessages: messages }, seller);
    assert.match(phone, /width:60px;height:60px/, "the main room includes the floating bubble stylesheet");
    assert.match(phone, /lts-chat-bubble/);
    assert.match(phone, /aria-label="Chat, 2 unread"/);
    assert.doesNotMatch(phone, /class="lts-pane lts-chat"/);
    const prejoin = room({ ...base, status: EscrowStatus.CREATED, participants: { seller, arbiter }, lock: {}, chatMessages: [] } as unknown as EscrowState, buyer);
    assert.doesNotMatch(prejoin, /class="lts-chat-bubble"/);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor); else delete (globalThis as { window?: unknown }).window;
  }
  assert.match(room(locked, seller), /class="lts-pane lts-chat"/, 'desktop chat remains side by side');
  const css = phoneTradeChatCss();
  assert.match(css, /@media\(max-width:720px\)/);
  assert.match(css, /lts-grid \.lts-chat\{display:none\}/);
  assert.match(css, /grid-template-rows:1fr/);
  assert.match(css, /env\(safe-area-inset-bottom,0px\)/);
}
