import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyEvent } from 'nostr-tools/pure';
import { replayEventChain as replay } from '../escrow-engine/state-machine.js';
import { parseEscrowEvent } from '../escrow-engine/event-parser.js';

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
    const replayOverrides: Record<number, unknown> = {};
    const parsedEvents = events.map((event, index) => {
      const parsed = parseEscrowEvent(JSON.parse(JSON.stringify(event.raw)), event.raw.content);
      if (!parsed.ok) return event;
      // Fixture-only cycle evidence / intentional overrides are replay input,
      // not facts the raw parser can reconstruct. Preserve both boundaries.
      if (JSON.stringify(deterministic(parsed.event)) !== JSON.stringify(deterministic(event))) replayOverrides[index] = event;
      return parsed.event;
    });
    const record = { name:`${process.argv[1]?.split('/').pop()}:${source}#${++ordinal}`, nowSec,
      events:events.map(event => event.raw), parsedEvents, ...(Object.keys(replayOverrides).length ? { replayOverrides } : {}), options,
      authentication:events.map(event => {
        try { return verifyEvent(JSON.parse(JSON.stringify(event.raw))) ? 'valid-signature' : 'synthetic-or-modeled'; }
        catch { return 'synthetic-or-modeled'; }
      }), state:result.ok ? result.state : null, result };
    appendFileSync(resolve('tests/golden/replay.jsonl'), JSON.stringify(deterministic(record))+'\n');
    return result;
  };
}
