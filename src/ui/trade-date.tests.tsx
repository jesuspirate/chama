import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TradeCard } from './components/TradeCard.js';
import { LangProvider } from '../i18n/index.js';
import { signedTradeCreatedAt, recordTradeToIndex, listTradeIndex } from '../escrow-engine/trade-index.js';
import { EscrowStatus, EscrowEventKind, Role, type EscrowState } from '../escrow-engine/types.js';
const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k,v), removeItem: (k: string) => values.delete(k),
} });
const original = Date.parse('2026-09-21T12:00:00Z') / 1000;
const refreshed = Date.parse('2026-09-28T12:00:00Z') / 1000;
const state = { id: 'sm_old', category: 'p2p-trade', status: EscrowStatus.COMPLETED, amountMsats: 1000000,
  description: 'Old trade', createdAt: refreshed, participants: { buyer: 'b'.repeat(64), seller: 'a'.repeat(64), arbiter: null },
  initiator: { pubkey: 'a'.repeat(64), role: Role.SELLER }, lock: { notesHash: 'locked', shares: new Map() },
  votes: {}, eventChain: [], chatMessages: [], communityArbiters: [],
} as unknown as EscrowState;
recordTradeToIndex(state, state.participants.seller, refreshed * 1000);
const replayed = { ...state, eventChain: [{ kind: EscrowEventKind.CREATE, timestamp: refreshed, raw: { created_at: original } }] } as EscrowState;
assert.equal(signedTradeCreatedAt(replayed), original);
recordTradeToIndex(replayed, state.participants.seller, refreshed * 1000);
assert.equal(listTradeIndex()[0].createdAt, original, 'signed CREATE repairs an already-poisoned history date');
const html = renderToStaticMarkup(<LangProvider><TradeCard state={replayed} pubkey={state.participants.seller!} onSelect={() => {}} /></LangProvider>);
assert.match(html, /dateTime="2026-09-21T12:00:00.000Z"/i);
assert.doesNotMatch(html, /dateTime="2026-09-28/i);
assert.equal(signedTradeCreatedAt({ ...state, createdAt: 0 }), 0, 'unknown dates never become today');
console.log('PASS historical trade date and cached-date repair from signed CREATE');

const { chosenTradeAmountMsats } = await import('./components/TradeCard.js');
const ranged = { ...state, status: EscrowStatus.CREATED, category: 'p2p-trade', amountMsats: 21000,
  items: [{ id: 'range', label: 'Range', kind: 'exchange-bracket', amountMsats: 21000, minAmountMsats: 21000, maxAmountMsats: 60000000 }],
} as EscrowState;
const chosen = { ...ranged, joinHolds: { buyer: { role: Role.BUYER, pubkey: 'buyer', joinedAt: 1,
  expiresAt: 9999999999, eventId: 'join', orderFinalizedAt: 2, amountMsats: 3183000 } } };
const locked = { ...chosen, status: EscrowStatus.LOCKED, amountMsats: 4000000,
  eventChain: [{ kind: EscrowEventKind.LOCK }] } as EscrowState;
assert.equal(chosenTradeAmountMsats(ranged), null);
assert.equal(chosenTradeAmountMsats(chosen), 3183000);
assert.equal(chosenTradeAmountMsats(locked), 4000000, 'LOCK overrides the earlier selection');
assert.equal(chosenTradeAmountMsats({ ...chosen, status: EscrowStatus.CANCELLED }), 3183000, 'closed chosen order retains its amount');
assert.equal(chosenTradeAmountMsats({ ...ranged, status: EscrowStatus.CANCELLED }), null, 'no chosen order retains its range');
const chosenHtml = renderToStaticMarkup(<LangProvider><TradeCard state={chosen} pubkey="buyer" onSelect={() => {}} /></LangProvider>);
assert.match(chosenHtml, /3,183/);
assert.doesNotMatch(chosenHtml, /60,000/);
const openHtml = renderToStaticMarkup(<LangProvider><TradeCard state={ranged} pubkey="buyer" onSelect={() => {}} /></LangProvider>);
assert.match(openHtml, /21-60,000/);
console.log('PASS cards show the chosen JOIN or LOCK amount and retain unchosen listing ranges');
