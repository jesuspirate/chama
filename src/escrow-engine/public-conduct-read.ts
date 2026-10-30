import { replayPublicConduct, type ConductSpend, type ConductTrade } from './public-conduct.js';
import type { EscrowState, NostrEvent } from './types.js';

export type ConductQuery = (filter: { kinds: number[]; authors?: string[]; '#p'?: string[]; '#d'?: string[]; limit: number })
  => Promise<{ events: NostrEvent[]; complete: boolean }>;

const LIMIT = 500;
const MAX_TRADES = 100;

/**
 * Read a person's public trades from relays. One query per trade made a busy
 * arbiter's record take minutes on a phone ("Public record not loaded yet"),
 * so trades are read a chunk at a time. A chunk that comes back cut off by the
 * relay limit or by a timeout is read again one trade at a time, so batching
 * never makes a record look more complete than the old per-trade read did.
 */
export async function readPublicConductTrades(pubkey: string, kinds: number[], query: ConductQuery,
  readSpend: (trade: EscrowState) => Promise<ConductSpend | null>,
  options: { chunk?: number; parallel?: number } = {}): Promise<{ trades: ConductTrade[]; complete: boolean }> {
  const chunk = Math.max(1, options.chunk ?? 10), parallel = Math.max(1, options.parallel ?? 2);
  const reads = await Promise.all([query({ kinds, authors: [pubkey], limit: LIMIT }), query({ kinds, '#p': [pubkey], limit: LIMIT })]);
  let complete = reads.every(r => r.complete && r.events.length < LIMIT);
  const ids = [...new Set(reads.flatMap(r => r.events).map(e => e.tags.find(t => t[0] === 'd')?.[1]).filter((id): id is string => !!id))].sort();
  if (ids.length > MAX_TRADES) complete = false;
  const wanted = ids.slice(0, MAX_TRADES);
  const results: (ConductTrade | null)[] = new Array(wanted.length).fill(null);

  const take = async (index: number, events: readonly NostrEvent[]) => {
    const trade = replayPublicConduct(events);
    if (!trade || !Object.values(trade.participants).includes(pubkey)) { complete = false; return; }
    if (!trade.lock.onchain) return;
    results[index] = { state: trade, spend: await readSpend(trade).catch(() => null) };
  };
  const oneByOne = async (start: number, group: string[]) => {
    for (const [offset, id] of group.entries()) {
      try {
        const read = await query({ kinds, '#d': [id], limit: LIMIT });
        complete &&= read.complete && read.events.length < LIMIT;
        await take(start + offset, read.events);
      } catch { complete = false; }
    }
  };
  const readChunk = async (start: number) => {
    const group = wanted.slice(start, start + chunk);
    let read: Awaited<ReturnType<ConductQuery>>;
    try { read = await query({ kinds, '#d': group, limit: LIMIT }); } catch { return oneByOne(start, group); }
    if (!read.complete || read.events.length >= LIMIT) return oneByOne(start, group);
    const byId = new Map<string, NostrEvent[]>(group.map(id => [id, []]));
    for (const event of read.events) for (const tag of event.tags)
      if (tag[0] === 'd' && byId.has(tag[1])) byId.get(tag[1])!.push(event);
    for (const [offset, id] of group.entries()) {
      try { await take(start + offset, byId.get(id)!); } catch { complete = false; }
    }
  };

  const starts = Array.from({ length: Math.ceil(wanted.length / chunk) }, (_, i) => i * chunk);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(parallel, starts.length) }, async () => {
    while (next < starts.length) await readChunk(starts[next++]);
  }));
  return { trades: results.filter((t): t is ConductTrade => !!t), complete };
}
