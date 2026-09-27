import assert from 'node:assert/strict';
import { rangeFiatText } from './components/RangeFiat.js';
const quote = { currency: 'USD', usdPerBtc: 84250, usdFiatRates: {} };
assert.equal(rangeFiatText({ min: 21, ...quote }), '≈ 0.02 USD');
assert.equal(rangeFiatText({ min: 21, max: 60000, ...quote }), "≈ 0.02–50.55 USD at today's rate");
assert.equal(rangeFiatText({ min: 21, ...quote, usdPerBtc: null }), null);
assert.equal(rangeFiatText({ min: null, ...quote }), null);
assert.equal(rangeFiatText({ min: 60000, ...quote, usdPerBtc: 100000 }), '≈ 60.00 USD');
console.log('PASS live range fiat estimates');
