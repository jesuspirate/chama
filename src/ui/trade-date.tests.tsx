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
