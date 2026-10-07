import assert from 'node:assert/strict';
import { verifyEvent } from 'nostr-tools/pure';
import { makeReplayConflictFixture } from './lib/replay-conflict-fixture.js';
import { escrowIdCreatorTag, selectTradeRoot } from '../src/escrow-engine/trade-identity.js';
import { parseEscrowEvent } from '../src/escrow-engine/event-parser.js';
import { applyEvent } from '../src/escrow-engine/state-machine.js';
import { EscrowEventKind } from '../src/escrow-engine/types.js';

const fixture = makeReplayConflictFixture('http://localhost:3000/?trade=old&by=bad#hash');
assert.equal(escrowIdCreatorTag(fixture.tradeId), null);
assert.notEqual(fixture.control.tags[0][1], fixture.tradeId);
assert.notEqual(fixture.genuine.pubkey, fixture.forged.pubkey);
assert.ok(fixture.forged.created_at < fixture.genuine.created_at);
assert.equal(new URL(fixture.plainLink).searchParams.get('by'), null);
assert.equal(new URL(fixture.creatorLink).searchParams.get('by'), fixture.creator);
assert.equal(new URL(fixture.plainLink).hash, '');
const parsed = [fixture.forged, fixture.genuine].map(event => {
  assert.ok(verifyEvent(event)); assert.equal(event.kind, EscrowEventKind.CREATE);
  const payload = JSON.parse(event.content);
  assert.equal(payload.mintUrl, 'replay-fixture:no-wallet');
  assert.equal(payload.platformFeeBps, 0); assert.match(payload.description, /DO NOT FUND/);
  const result = parseEscrowEvent(event, event.content);
  if (!result.ok) throw new Error(result.error.message);
  assert.ok(applyEvent(null, result.event).ok); return result.event;
});
const conflict = selectTradeRoot(parsed);
assert.equal(conflict.ok, false);
if (!conflict.ok) assert.equal(conflict.code, 'CONFLICTING_CREATES');
const named = selectTradeRoot(parsed, fixture.creator);
assert.ok(named.ok);
if (named.ok) {
  assert.deepEqual(named.events.map(e => e.raw.id), [fixture.genuine.id]);
  const replay = applyEvent(null, named.events[0]);
  assert.ok(replay.ok);
  if (replay.ok) assert.equal(replay.state.amountMsats, 1000);
}
assert.notEqual(makeReplayConflictFixture('https://getchama.app/').tradeId, fixture.tradeId);
assert.throws(() => makeReplayConflictFixture('file:///tmp/a'));
assert.throws(() => makeReplayConflictFixture('https://user:secret@example.com'));
console.log('PASS fixture: fresh legacy ids, real signatures, backdated foreign CREATE, conflict without by, genuine root with by, control listing, no wallet/funding/key input.');
