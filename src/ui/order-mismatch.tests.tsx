// Audit M3: the seller is told when a storefront order isn't on the listing's terms.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { OrderMismatchBanner } from './components/OrderMismatchBanner.js';
import { LangProvider } from '../i18n/index.js';
const html = renderToStaticMarkup(<LangProvider><OrderMismatchBanner /></LangProvider>);
assert.match(html, /data-order-mismatch/);
assert.match(html, /doesn(&#x27;|')t match your listing/);
assert.match(html, /Don(&#x27;|')t send anything for it/);
assert.doesNotMatch(html, /trade\.orderMismatch/, 'no raw key reaches the screen');
console.log('PASS M3 banner: a mismatched storefront order tells the seller not to send anything');
