/** Enforce timestamps ourselves; a relay may ignore REQ.since or replay on reconnect. */
export function freshWake(createdAt, connectedAt, registeredAt, now = Date.now()) {
  return Number.isSafeInteger(createdAt) && createdAt * 1000 > Math.max(connectedAt, registeredAt)
    && createdAt * 1000 <= now && now - createdAt * 1000 <= 120_000;
}
