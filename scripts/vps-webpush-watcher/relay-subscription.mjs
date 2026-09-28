/** nostr-tools 2.23 uses a single Filter, not the older Filter[] API. */
export function subscribeWakeBand(pool, relays, kinds, since, handlers) {
  return pool.subscribeMany(relays, { kinds, since }, handlers);
}
