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
