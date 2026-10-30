// 6.4.33 arbiter conduct facts on screen: small rows stay as they were plus
// any red line; a person's record (detail) shows every fact in order.
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConductFactLines } from './components/ConductFacts.js';
import { LangProvider } from '../i18n/index.js';
import type { PublicConductRecord } from '../escrow-engine/public-conduct.js';

const base = { marks: 0, complete: true, trades: [] } as PublicConductRecord;
const standing = { sellerSpeed: null, arbiterSpeed: { medianSeconds: 600, samples: 4 }, settledTrades: 4, bonded: null, newHere: false,
  arbiterDecided: { count: 4, people: 7, lastYear: 3 }, arbiterBackedUp: { count: 1, total: 5 },
  arbiterTwoRulings: null, arbiterSamePerson: { count: 3, total: 4 } };
const render = (record: PublicConductRecord, detail: boolean) => renderToStaticMarkup(<LangProvider><ConductFactLines record={record} detail={detail} /></LangProvider>);

const compact = render({ ...base, standing }, false);
assert.doesNotMatch(compact, /Decided|backup|same person|Ecash trades are private/, 'small rows do not grow');
assert.match(compact, /4 trades settled on chain/);

const detail = render({ ...base, standing }, true);
const order = ['Decided 4 disputes on chain, with 7 different people', '3 in the last year', 'Rules within', 'A backup arbiter had to decide 1 of the 5', 'Ruled for the same person in 3 of 4', '4 trades settled on chain', 'Ecash trades are private'];
let at = -1;
for (const text of order) { const i = detail.indexOf(text); assert.ok(i > at, `"${text}" in order`); at = i; }

const red = { ...standing, arbiterTwoRulings: { count: 2, partial: true } };
for (const d of [false, true]) assert.match(render({ ...base, standing: red }, d), /Signed two opposite rulings on the same trade, at least 2 times/, 'the red line shows everywhere');
assert.match(render({ ...base, standing: { ...red, arbiterTwoRulings: { count: 1, partial: false } } }, false), /same trade, once/);

const seller = render({ ...base, standing: { sellerSpeed: { medianSeconds: 60, samples: 3 }, arbiterSpeed: null, settledTrades: 3, bonded: null, newHere: false } }, true);
assert.doesNotMatch(seller, /Ecash trades are private/, 'the ecash note is only for arbiter facts');
console.log('PASS conduct facts on screen: compact rows unchanged plus red, detail in order with the ecash note');
