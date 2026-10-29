// Jet's 6.4.32 final pass: the seller (who receives the cash) was told "You
// agreed to pay with". The agreed-methods card now speaks to each role.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveTradeSurface } from './screens/LiveTradeSurface.js';
import { EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
import { LangProvider, translate, LANGS } from '../i18n/index.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
} });
setLocalStorageUserScope('final-pass-copy-test');

const buyer = 'b'.repeat(64), seller = 'a'.repeat(64), arbiter = 'c'.repeat(64);
const now = Date.now() / 1000;
const locked = {
  provenance: 'chain', id: 'final-pass', category: 'p2p-trade', amountMsats: 1_000_000, description: 'Test',
  createdAt: now, expiresAt: now + 86400, participants: { buyer, seller, arbiter },
  initiator: { pubkey: seller }, votes: {}, eventChain: [], chatMessages: [], communityArbiters: [arbiter],
  status: EscrowStatus.LOCKED, lock: { notesHash: 'locked', lockedAt: now }, paymentMethods: ['m-pesa'],
} as unknown as EscrowState;
const room = (pubkey: string) => renderToStaticMarkup(
  <LangProvider><LiveTradeSurface state={locked} pubkey={pubkey} onBack={() => {}} onOpenFullView={() => {}}
    onVote={async () => {}} onSendChat={async () => {}} /></LangProvider>);
const card = (html: string) => html.match(/<div data-agreed-methods[\s\S]*?<\/div><\/div>/)?.[0] ?? '';

const sellerCard = card(room(seller));
assert.match(sellerCard, /You agreed to be paid with/, 'the seller receives the cash');
assert.match(sellerCard, /Share your exact payment details in the chat\./);
assert.doesNotMatch(sellerCard, /agreed to pay with/, 'the seller is never told they pay');

const arbiterCard = card(room(arbiter));
assert.match(arbiterCard, /They agreed to pay with/, 'the arbiter only watches');
assert.doesNotMatch(arbiterCard, /You agreed/);

for (const lang of LANGS) for (const key of ['lts.agreedMethodsReceive', 'lts.agreedMethodsWatch', 'lts.detailsInChatYou',
  'onchain.funderDeposits', 'onchain.notYourDeposit', 'onchain.locksAfterOneConfirmation', 'onchain.locksWhenFunderOpens']) {
  const text = translate(lang, key, { name: 'N', amount: '1' });
  assert.ok(text && !text.startsWith('lts.') && !text.startsWith('onchain.'), `${lang}: ${key}`);
}
console.log('PASS agreed-methods card: seller is paid, arbiter watches; new copy in en/es/fr/sw');

// Jet's 6.4.32 rc.1 pass: the arbiter of a settled trade was asked "How was
// trading with them?" under "Your turn". Only buyer and seller rate.
const completed = { ...locked, status: EscrowStatus.COMPLETED } as unknown as EscrowState;
const finished = (pubkey: string) => renderToStaticMarkup(
  <LangProvider><LiveTradeSurface state={completed} pubkey={pubkey} onBack={() => {}} onOpenFullView={() => {}}
    onVote={async () => {}} onSendChat={async () => {}} onRateCounterparty={async () => {}} /></LangProvider>);
const arbiterDone = finished(arbiter);
assert.doesNotMatch(arbiterDone, /How was trading with them\?/, 'the arbiter is not asked to rate');
assert.doesNotMatch(arbiterDone, />Your turn</, 'nothing is the arbiter\'s turn on a finished trade');
assert.match(arbiterDone, /Trade complete\./);
for (const party of [buyer, seller]) {
  const html = finished(party);
  assert.match(html, /How was trading with them\?/, 'buyer and seller still rate each other');
  assert.match(html, /👍/);
}

// The dashboard showed the viewer's own arbiter card twice: once on top and
// again inside "Arbiter record". The roster now skips the viewer.
import { readFileSync } from 'node:fs';
const dashboard = readFileSync(new URL('./screens/DashboardScreen.tsx', import.meta.url), 'utf8');
assert.match(dashboard, /\.filter\(key => key !== pubkey\.toLowerCase\(\)\)/, 'roster excludes the viewer');
assert.match(dashboard, /otherArbiters\.length > 0 && <details>/, 'no empty "Arbiter record" when you are the only arbiter');
console.log('PASS finished trade: arbiter gets no rating ask; dashboard lists your own arbiter card once');
