// Runs the public conformance vectors (docs/conformance/) the way another
// implementation would: only the published files, the core entry point and
// the clock port. No Date mocking, no internal module paths.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { replayEventChain, setProtocolClock } from './core/index.js';
import { deterministic } from './replay-capture.test-helper.js';

const vectorsText = readFileSync(new URL('../../docs/conformance/escrow-replay.jsonl', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../../docs/conformance/manifest.json', import.meta.url), 'utf8'));
assert.equal(manifest.format, 'chama-escrow-replay-vectors');
assert.equal(manifest.formatVersion, 1);
assert.equal(createHash('sha256').update(vectorsText).digest('hex'), manifest.sha256, 'manifest hash matches the vectors file');

const vectors = vectorsText.trim().split('\n').map(line => JSON.parse(line));
assert.equal(vectors.length, manifest.vectors, 'manifest count matches the vectors file');

let accepted = 0, refused = 0;
for (const vector of vectors) {
  const realNow = Date.now;
  Date.now = () => { throw new Error(`${vector.name}: replay read the device clock`); };
  setProtocolClock(() => vector.nowSec);
  let result;
  try { result = deterministic(replayEventChain(vector.events, vector.options)); }
  finally { setProtocolClock(); Date.now = realNow; }
  assert.equal(result.ok, vector.expect.ok, `${vector.name}: accepted or refused`);
  if (vector.expect.ok) {
    assert.deepEqual(result.state, vector.expect.state, `${vector.name}: final state`);
    accepted++;
  } else {
    assert.equal(result.error.code, vector.expect.error.code, `${vector.name}: refusal code`);
    assert.equal(result.error.eventId, vector.expect.error.eventId, `${vector.name}: refused event`);
    refused++;
  }
}
assert.equal(accepted, manifest.accepted);
assert.equal(refused, manifest.refused);
console.log(`PASS conformance vectors: ${vectors.length} through the core entry and clock port (${accepted} accepted states, ${refused} refusals), device clock never read`);
