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

// A Storefront (menu) is one order, and "Max / order" is not stock Chama
// counts. Sellers and buyers read it as stock (Jet, 6.4.31-rc.1), so both the
// seller's form and the buyer's picker say so, only on a Store.
{
  const { readFileSync } = await import('node:fs');
  const { translate } = await import('../i18n/index.js');
  const create = readFileSync(new URL('./screens/CreateForm.tsx', import.meta.url), 'utf8');
  const trade = readFileSync(new URL('./screens/TradeDetail.tsx', import.meta.url), 'utf8');
  assert.match(create, /vertical === "marketplace" && \(\s*<div data-store-stock-note/, 'seller note only on a market menu');
  assert.match(create, /listingMode === "menu" && vertical === "marketplace" && \(\s*<div data-store-stock-tip/, 'Units in stock tip only in Storefront mode');
  assert.match(trade, /state\.category === "marketplace" && \(\s*<div data-store-order-note/, 'buyer note only on a market menu');
  for (const lang of ['en', 'es', 'fr', 'sw'] as const) for (const key of ['create.menuStockNoteMarket', 'create.menuStockTipMarket', 'trade.storeOneOrderNote']) {
    const text = translate(lang, key as any);
    assert.ok(text && text !== key, `${key} is written in ${lang}`);
    assert.doesNotMatch(text, /trustless|insured|bank-grade/i);
  }
  assert.match(translate('en', 'create.menuStockNoteMarket' as any), /doesn’t count stock/);
  console.log('PASS a Storefront says Chama does not count its stock, in every language');
}

// The optional long description stays folded until wanted, and its label is a
// plain grey label, never raw formatting syntax (Jet, 6.4.31-rc.1 pass).
{
  const { ListingDetailsField } = await import('./screens/CreateForm.js');
  const field = (body: string) => renderToStaticMarkup(<LangProvider>
    <ListingDetailsField body={body} onChange={() => {}} inputStyle={{}} /></LangProvider>);
  const empty = field('');
  assert.match(empty, /data-listing-details-add/, 'no body: only "+ Add details"');
  assert.doesNotMatch(empty, /<textarea/, 'no body: no open box');
  const filled = field('Handmade, **red**');
  assert.match(filled, /<textarea[^>]*rows="3"/, 'a draft with a body opens at 3 rows');
  assert.match(filled, /Details · optional/);
  for (const html of [empty, filled]) assert.doesNotMatch(html, /\*\*bold\*\*|\[label\]\(https/, 'no raw syntax in the label');
  console.log('PASS the long description is optional, folded and labelled in plain words');
}
