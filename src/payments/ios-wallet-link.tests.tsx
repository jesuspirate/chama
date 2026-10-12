import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OpenWith, PaymentCard } from '../ui/components/PaymentCard.js';
import { LangProvider } from '../i18n/index.js';
const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
try {
  for (const userAgent of ['iPhone Safari', 'iPhone CriOS', 'iPad Safari', 'Macintosh Safari']) {
    Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{
      userAgent, maxTouchPoints:5,
      canShare() { throw new Error('iOS invoice handoff must not inspect sharing'); },
      share() { throw new Error('iOS invoice handoff must not use the share sheet'); },
    }});
    const html = renderToStaticMarkup(<LangProvider><PaymentCard amountMsats={50_000} rail="lightning"
      data="LIGHTNING:LNBC500NTEST" status="Waiting" /></LangProvider>);
    assert.match(html, /<a href="lightning:LNBC500NTEST"/);
    assert.match(html, /Open in wallet/);
    assert.match(html, /Copy · /, 'A visible Copy fallback remains when no scheme handler exists');
    assert.match(html, /aria-label="Copy LNBC500NTEST"/, 'Copy receives the raw invoice even without copyValue');
  }
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{userAgent:'iPhone Safari',maxTouchPoints:5}});
  assert.match(renderToStaticMarkup(<OpenWith value="LNBC123" lightningUri="lightning:LNBC123" />), /href="lightning:LNBC123"/,
    'Open is available when Web Share is absent');
  Object.defineProperty(globalThis, 'navigator', {configurable:true, value:{userAgent:'Macintosh Safari',maxTouchPoints:0,share(){},canShare:()=>true}});
  const desktop = renderToStaticMarkup(<OpenWith value="LNBC123" lightningUri="lightning:LNBC123" />);
  assert.match(desktop, /<button/);
  assert.doesNotMatch(desktop, /<a /, 'Desktop behavior stays unchanged');
} finally {
  if (priorNavigator) Object.defineProperty(globalThis, 'navigator', priorNavigator);
  else delete (globalThis as any).navigator;
}
console.log('PASS iOS invoice anchor: Safari, Chrome, iPad desktop mode, no Web Share, explicit raw-invoice Copy fallback; desktop unchanged.');
