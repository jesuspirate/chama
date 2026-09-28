import assert from 'node:assert/strict';
import { fetchWakeEvents, replayWake } from './wake-replay.js';
const snapshot = { pubkey: 'a'.repeat(64), events: [], relays: [] };
assert.deepEqual([...replayWake([], snapshot.pubkey, '')], [], 'empty cache has no actionable trade');
await assert.rejects(fetchWakeEvents(snapshot), /No relay replied/, 'offline is a failure, never a successful empty read');
class EmptyRelay {
  onopen?: () => void; onmessage?: (event: {data: string}) => void;
  constructor() { setTimeout(() => this.onopen?.(), 0); }
  send() { this.onmessage?.({data: JSON.stringify(['EOSE', 'wake'])}); }
  close() {}
}
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: EmptyRelay });
assert.deepEqual(await fetchWakeEvents({...snapshot, relays: ['wss://test.invalid']}), [], 'EOSE with nothing new is successful and silent');
console.log('PASS wake replay empty read and network-down distinction');
