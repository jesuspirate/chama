self.addEventListener("install", (event) => {
  // This worker owns notification clicks only (no fetch/cache protocol), so a
  // new version is safe to activate against already-open Chama documents.
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  // Take over live clients immediately; otherwise the old navigating worker can
  // remain in control until every Chama tab closes — exactly the session this
  // update is meant to preserve.
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const escrowId = event.notification.data && event.notification.data.escrowId;
  const target = escrowId ? `/?trade=${encodeURIComponent(escrowId)}` : "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      // Browser sessions deliberately keep the nsec in memory only. Navigating
      // an already-open client destroys that session and sends the user back to
      // sign-in, so warm notification taps route inside the live document.
      // Cold launches still use the query-param URL below; App drains both
      // routes through the same pending trade-deep-link buffer.
      existing.postMessage({
        type: "chama:notificationclick",
        escrowId: escrowId || null,
      });
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
