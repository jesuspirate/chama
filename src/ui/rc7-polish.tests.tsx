// Jet's rc.7 asks on the Pixel 8 (Oct 14): the trade's payment picker looked
// like an old Android picker, the trade screen's decision needed scrolling
// with no edge between its halves, the hold fill jittered, and the trade
// screen still selected text. Display-only: the lock still receives the same
// saved-handle id or the chat choice, checked before any sats move.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../i18n/index.js';
import { setLocalStorageUserScope } from '../storage/user-scope.js';
import { EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
import { holdDueAt, holdReducer, HOLD_TO_CONFIRM_MS, ASSISTIVE_CONFIRM_WINDOW_MS } from './components/Button.js';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null,
  setItem: (k: string, v: string) => void values.set(k, v),
  removeItem: (k: string) => void values.delete(k),
} });
setLocalStorageUserScope('rc7-polish-test');
const { addSavedHandle } = await import('../payments/saved-handles.js');
const { TradePaymentDetailsChoice, CHAT_PAYMENT_CHOICE } = await import('./components/TradePaymentDetails.js');
const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const src0 = () => read('./components/TradePaymentDetails.tsx');

{
  // 1. The payment details choice opens the app's overlay; no native <select>.
  const cash = addSavedHandle('cashtag', '$rc7');
  const strike = addSavedHandle('strike', 'rc7@strike.me');
  const offer = { id: 'rc7', category: 'p2p-trade', status: EscrowStatus.CREATED, paymentMethods: ['$cashtag (Cash App)', 'Strike'] } as unknown as EscrowState;
  const render = (value: string) => renderToStaticMarkup(<LangProvider><TradePaymentDetailsChoice state={offer} value={value} onChange={() => {}} /></LangProvider>);
  for (const html of [render(''), render(cash.id), render(CHAT_PAYMENT_CHOICE)]) {
    assert.doesNotMatch(html, /<select|<option/, 'no native picker');
    assert.match(html, /data-payment-details-picker[^>]*aria-haspopup="dialog"/, 'the choice is a button that opens the overlay');
  }
  assert.match(render(cash.id), /\$cashtag \(Cash App\) · \$rc7/, 'the chosen saved details show on the button');
  assert.match(render(strike.id), /Strike · rc7@strike\.me/);
  assert.match(render(CHAT_PAYMENT_CHOICE), /send payment details in chat/);
  const empty = render('');
  assert.match(empty, /role="radio" aria-checked="true"[^>]*>\$cashtag \(Cash App\)<\/button>/, 'adding details: the method is a chip, first one picked');
  assert.match(empty, /role="radio" aria-checked="false"[^>]*>Strike<\/button>/);
  assert.match(empty, /name="trade-payment-detail"/, 'the handle field is still there');
  assert.match(empty, /data-payment-details-chat[^>]*>I’ll send payment details in chat<\/button>/, 'sending details in chat stays one tap away');
  assert.match(src0(), /data-payment-details-chat onClick=\{\(\) => onChange\(CHAT_PAYMENT_CHOICE\)\}/);
  assert.doesNotMatch(render(cash.id), /name="trade-payment-detail"/, 'chosen details hide the add form, as before');
  // The ids handed to the lock are unchanged: a saved handle's id, 'chat', or
  // '' to add new details; a freshly saved handle passes its new id.
  const src = read('./components/TradePaymentDetails.tsx');
  assert.match(src, /handles\.map\(h => \(\{ id: h\.id,/);
  assert.match(src, /\{ id: CHAT_PAYMENT_CHOICE, label: t\('trade\.sendDetailsInChat'\) \}/);
  assert.match(src, /const choose = \(id: string\) => \{ onChange\(id\); setPicking\(false\); \};/);
  assert.match(src, /const saved = addSavedHandle\(rail, handle\.trim\(\)\); onChange\(saved\.id\);/);
  assert.match(src, /<OverlaySheet title=\{t\('trade\.choosePaymentDetails'\)\}/);
  for (const lang of ['en', 'es', 'fr', 'sw']) assert.match(read(`../i18n/${lang}/trade.ts`), /"trade\.addPaymentDetails": "/, `${lang}: add new details`);
}
console.log('PASS trade payment details: the choice opens the app overlay, methods are chips, and the lock gets the same ids');

{
  // 2. Phones: the decision comes first in its pane, the clock shows once, and
  // the bottom half is a sheet with its own edge.
  const src = read('./screens/LiveTradeSurface.tsx');
  assert.match(src, /\.lts-root:has\(\[data-decision-clock\]\) \.lts-clock\{display:none\}/, 'the header clock yields to the decision card');
  assert.match(src, /\{clock && <div data-decision-clock/);
  assert.match(src, /@media \(max-width:720px\)\{[^}]*\.lts-room\{padding:8px 12px\}/);
  assert.match(src, /\.lts-votes\{padding:14px 14px 12px;border-top:1px solid \$\{T\.borderHi\};border-radius:\$\{T\.rSheet\}px \$\{T\.rSheet\}px 0 0;/, 'the bottom half has a sheet edge');
  assert.match(src, /\.lts-decision-well\{display:flex;flex-direction:column\}\s*\.lts-prelock-facts\{order:2;margin-top:16px\}/, 'arbiter record and listing follow the decision on phones');
  assert.match(src, /\{state\.status === EscrowStatus\.CREATED && <div className="lts-prelock-facts">\s*<TradeArbiterRecord/);
  assert.match(src, /<div className="lts-root"/);
}
console.log('PASS trade screen on phones: decision first, clock once, a clear edge between the halves');

{
  // 3. The hold fill is a CSS transition; React wakes only when the hold is due.
  const src = read('./components/Button.tsx');
  const hold = src.slice(src.indexOf('export function HoldToConfirm('));
  assert.doesNotMatch(hold, /requestAnimationFrame|setProgress/, 'no per-frame React state');
  assert.match(hold, /transform: `scaleX\(\$\{state\.kind === "holding" \|\| done \? 1 : 0\}\)`/);
  assert.match(hold, /transition: state\.kind === "holding" \? `transform \$\{holdMs\}ms linear`/, 'the fill runs linearly over exactly the hold');
  assert.match(hold, /if \(now < due\) \{ timer = setTimeout\(fire, due - now \+ 1\); return; \}/, 'an early timer re-arms instead of stalling');
  assert.equal(holdDueAt({ kind: 'idle' }), null);
  assert.equal(holdDueAt({ kind: 'confirmed' }), null);
  assert.equal(holdDueAt({ kind: 'holding', since: 1000 }), 1000 + HOLD_TO_CONFIRM_MS);
  assert.equal(holdDueAt({ kind: 'armed', at: 50 }), 50 + ASSISTIVE_CONFIRM_WINDOW_MS + 1);
  // The tick at the due time confirms a hold and expires an assistive arm.
  const holding = { kind: 'holding', since: 1000 } as const;
  assert.equal(holdReducer(holding, { type: 'tick', at: holdDueAt(holding)! }).kind, 'confirmed');
  assert.equal(holdReducer(holding, { type: 'tick', at: holdDueAt(holding)! - 1 }).kind, 'holding', 'early tick: still holding');
  const armed = { kind: 'armed', at: 50 } as const;
  assert.equal(holdReducer(armed, { type: 'tick', at: holdDueAt(armed)! }).kind, 'idle');
}
console.log('PASS hold to confirm: the fill animates on the compositor and confirms on time');

{
  // 4. Copyable values on the trade screen opt back into selection.
  assert.match(read('./screens/LiveTradeSurface.tsx'), /<div data-selectable style=\{\{ fontSize: T\.fs\.headline, fontWeight: 600, color: T\.ink \}\}>\{handleDisplayForViewer\(/);
  assert.match(read('./components/TradePaymentDetails.tsx'), /<div data-selectable style=\{\{ overflowWrap: 'anywhere', fontSize: T\.fs\.headline, fontWeight: 600 \}\}>\{state\.lock\.handle\.value\}/);
  assert.match(read('./components/OverlaySheet.tsx'), /\{subtitle && \(\s*<div data-selectable/, 'a person sheet\'s key stays copyable');
  assert.match(read('./components/ListingBody.tsx'), /<div data-selectable/);
  assert.match(read('./components/SavedWalletRow.tsx'), /<span data-selectable/);
  assert.match(read('./panels/OnchainTradeControls.tsx'), /<p data-selectable style=\{\{ color: T\.muted, overflowWrap: "anywhere" \}\}>/);
}
console.log('PASS selection: payment details, keys, listings, wallet codes and payout addresses stay copyable');
