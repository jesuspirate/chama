import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyEvent } from 'nostr-tools/pure';
import { replayEventChain } from '../escrow-engine/state-machine.js';
import type { ParsedEscrowEvent } from '../escrow-engine/types.js';
import { atReplayTime, deterministic } from './replay-capture.test-helper.js';

assert.deepEqual(deterministic({z:new Map([['b',2],['a',1]]),a:new Set(['b','a'])}),{a:['a','b'],z:[['a',1],['b',2]]},'canonical Set/Map representation');
const originalClock=Date.now;
assert.throws(()=>atReplayTime(0,()=>{throw new Error('clock restoration');}));
assert.equal(Date.now,originalClock,'restore clock even after an exception');
const contents=readFileSync(new URL('../../tests/golden/replay.jsonl', import.meta.url),'utf8');
assert(!/nsec1[a-z0-9]{20,}/i.test(contents) && !/"(?:privateKey|secretKey|mnemonic|seedPhrase)"\s*:/i.test(contents),'no signing-secret or seed fields in corpus');
const records = contents.trim().split('\n').map(line=>JSON.parse(line));
assert(records.length > 0,'golden corpus must not be empty');
const names = new Set<string>();
let signed=0, synthetic=0;
for(const record of records) {
  assert(!names.has(record.name),`duplicate golden name ${record.name}`);names.add(record.name);
  assert(Number.isFinite(record.nowSec),`${record.name}: explicit replay clock`);
  assert.deepEqual(record.events,record.parsedEvents.map((event:ParsedEscrowEvent)=>event.raw),`${record.name}: exact input-order raw events`);
  assert.deepEqual(record.authentication,record.events.map((raw:any)=>{
    try {return verifyEvent(JSON.parse(JSON.stringify(raw))) ? 'valid-signature' : 'synthetic-or-modeled';}
    catch {return 'synthetic-or-modeled';}
  }),`${record.name}: signature provenance`);
  for(const status of record.authentication) status === 'valid-signature' ? signed++ : synthetic++;
  const result = atReplayTime(record.nowSec,()=>replayEventChain(record.parsedEvents,record.options));
  assert.deepEqual(deterministic(result),record.result,record.name);
  assert.deepEqual(deterministic(result.ok ? result.state : null),record.state,`${record.name}: final state`);
}
console.log(`PASS golden replay: ${records.length} records; ${signed} authenticated and ${synthetic} synthetic/modeled raw event occurrences; exact success/error results and final states`);
