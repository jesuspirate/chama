import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LiveTradeSurface } from './screens/LiveTradeSurface.js';
import { EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
import { LangProvider } from '../i18n/index.js';

// A buyer opening a multi-unit listing in the trade room is sent to the full
// view's quantity picker. "Agree & join" there took the listing's own buyer
// seat, so one order turned the whole store into one trade and it left Browse
// for everyone (Jet, 6.4.30-rc.1 on poc). A one-unit listing still joins here.
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); },
  removeItem: (k: string) => { values.delete(k); },
} });
const seller = 'a'.repeat(64), arbiter = 'c'.repeat(64), shopper = 'd'.repeat(64);
const now = Date.now() / 1000;
const listing = (stock: number | undefined) => ({
  provenance: 'chain', id: 'sm_store', category: 'marketplace', status: EscrowStatus.CREATED,
  amountMsats: 2_462_000, description: 'Veste Rouge', createdAt: now, expiresAt: now + 86_400,
  participants: { seller, arbiter }, initiator: { pubkey: seller, role: 'seller' },
  lock: { notesHash: null, lockedAt: null }, votes: {}, eventChain: [], chatMessages: [],
  communityArbiters: [arbiter], ...(stock !== undefined ? { stock } : {}),
}) as unknown as EscrowState;
const room = (state: EscrowState) => renderToStaticMarkup(<LangProvider>
  <LiveTradeSurface state={state} pubkey={shopper} onBack={() => {}} onOpenFullView={() => {}}
    onJoin={async () => { throw new Error('rendering never joins'); }} onVote={async () => {}} onSendChat={async () => {}} />
</LangProvider>);

const store = room(listing(10));
assert.match(store, /Review &amp; join in the full view/, 'a 10-unit listing sends the buyer to the quantity picker');
assert.doesNotMatch(store, /Agree &amp; join|Agree & join/, 'and offers no direct join');
for (const stock of [undefined, 1]) {
  assert.match(room(listing(stock)), /Agree &amp; join|Agree & join/, `a listing with stock ${stock} still joins in the room`);
}
console.log('PASS a multi-unit listing is bought by quantity, never joined whole from the trade room');
