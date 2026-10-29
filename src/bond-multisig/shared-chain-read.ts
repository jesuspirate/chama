// One chain read per trade at a time, reused briefly.
//
// Oct 28 mainnet: the trade room, the trade page, lock recovery and the
// attention scan each polled the same deposit every 30 to 60 seconds, across
// three explorers, in every open tab. That is how one person hit the public
// explorers' hourly limits. Callers asking about the same trade now share the
// read in flight and its answer for a few seconds. Failures are never kept,
// so "couldn't check" is always asked again.

export const SHARED_CHAIN_READ_TTL_MS = 15_000;

export function createSharedChainRead<T>(opts: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = opts.ttlMs ?? SHARED_CHAIN_READ_TTL_MS;
  const now = opts.now ?? Date.now;
  const inFlight = new Map<string, Promise<T>>();
  const answers = new Map<string, { at: number; value: T }>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const kept = answers.get(key);
    if (kept && now() - kept.at < ttlMs) return Promise.resolve(kept.value);
    const pending = inFlight.get(key);
    if (pending) return pending;
    const attempt = read().then(
      value => { answers.set(key, { at: now(), value }); return value; },
      error => { answers.delete(key); throw error; },
    ).finally(() => inFlight.delete(key));
    inFlight.set(key, attempt);
    return attempt;
  };
}
