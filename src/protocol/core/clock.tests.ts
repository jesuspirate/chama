import assert from 'node:assert/strict';
import { nowSeconds, setProtocolClock } from './index.js';

const realNow = Date.now;
try {
  Date.now = () => 1_700_000_000_999;
  assert.equal(nowSeconds(), 1_700_000_000, 'default clock: whole seconds from the system clock, as the old defaults computed');
  setProtocolClock(() => 42);
  assert.equal(nowSeconds(), 42, 'a host can install its own clock');
  setProtocolClock();
  assert.equal(nowSeconds(), 1_700_000_000, 'calling with nothing restores the system clock');
} finally {
  Date.now = realNow;
  setProtocolClock();
}
console.log('PASS protocol clock port: system default, host override, restore');
