import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { replayEventChain as replay } from '../escrow-engine/state-machine.js';

export function deterministic(value: unknown): any {
  if (value instanceof Set) return [...value].map(deterministic).sort(compare);
  if (value instanceof Map) return [...value.entries()].map(deterministic).sort(compare);
  if (Array.isArray(value)) return value.map(v => deterministic(v) ?? null);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).filter(([,v]) => v !== undefined)
    .map(([k,v]) => [k,deterministic(v)]));
  return value;
}
function compare(a: unknown,b: unknown): number { const x=JSON.stringify(a), y=JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; }
export function atReplayTime<T>(nowSec: number, operation: () => T): T {
  const previous = Date.now;
  Date.now = () => nowSec * 1000;
  try { return operation(); } finally { Date.now = previous; }
}
export function captureReplay(source: string): typeof replay {
  let ordinal = 0;
  return (events, options = {}) => {
    if (process.env.CHAMA_CAPTURE_GOLDEN !== '1') return replay(events, options);
    const nowSec = Date.now()/1000;
    const result = atReplayTime(nowSec, () => replay(events, options));
    const record = { name:`${process.argv[1]?.split('/').pop()}:${source}#${++ordinal}`, nowSec,
      events:events.map(event => event.raw), parsedEvents:events, options,
      authentication:events.map(event => {
        try { return verifyEvent(JSON.parse(JSON.stringify(event.raw))) ? 'valid-signature' : 'synthetic-or-modeled'; }
        catch { return 'synthetic-or-modeled'; }
      }), state:result.ok ? result.state : null, result };
    appendFileSync(resolve('tests/golden/replay.jsonl'), JSON.stringify(deterministic(record))+'\n');
    return result;
  };
}
