import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import { LangProvider } from '../i18n/index.js';
import { arbiterRecord } from '../arbiters/record.js';
import { ArbiterRecordCard } from './components/ArbiterRecordCard.js';
const record = arbiterRecord('a'.repeat(64), [], [], new Map(), 1000);
const render = (data = record) => renderToStaticMarkup(<LangProvider><ArbiterRecordCard record={data} expanded /></LangProvider>);
const bonded = {...record, bondSats: 100_000n};
assert.match(render(bonded), /100,000 sats at stake/);
assert.equal(render(bonded), render({...bonded,disputes:99,healings:7,medianResponseSec:12,lastSeen:999,observedTrades:200}),
  'Different device-local histories must not produce different arbiter claims');
assert.doesNotMatch(render(bonded), /disputes|Healings|Last signed|this device|replies|<details/);
assert.match(render(), /has no bond/);
assert.doesNotMatch(render(), /nothing at stake/);
console.log('PASS arbiter display: verified bond only; local history cannot change the card');
