/** Enforce timestamps ourselves; a relay may ignore REQ.since or replay on reconnect. */
export function freshWake(createdAt, connectedAt, registeredAt, now = Date.now()) {
  return Number.isSafeInteger(createdAt) && createdAt * 1000 > Math.max(connectedAt, registeredAt)
    && createdAt * 1000 <= now && now - createdAt * 1000 <= 120_000;
}

/** Public listing lifecycle: the first JOIN must wake a closed creator. */
export function communityWakeSlugs(event) {
  if (event.kind === 38100 && event.tags.some(t => t[0] === "renewal" && t[1])) return [];
  if (![38100, 38101].includes(event.kind) || event.tags.some(t => t[0] === "parent" && t[1])) return [];
  return [...new Set(event.tags.filter(t => t[0] === "community" && t[1]).map(t => t[1]))];
}
