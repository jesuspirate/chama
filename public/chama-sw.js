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

// ── A6 web push (opt-in, closed-app wake-ups) ──────────────────────────────
// The VPS watcher sends an OPAQUE wake-up: the payload carries NO trade content
// (no escrow id, amount, or counterparty) — it cannot, by design, and must not.
// A wake means only "you have activity"; the client fetches the real state from
// relays on open, exactly as the resume-catch-up path already does. Lock-screen
// text stays generic for privacy and because the VPS has nothing specific to say.
self.addEventListener("push", (event) => {
  let body = "A new offer appeared. Open Chama to check your match.";
  // Tolerate (and ignore) any payload: a well-behaved watcher sends none, but a
  // future opaque hint must never leak content onto the lock screen.
  try {
    if (event.data) {
      const text = event.data.text();
      if (text && text.length <= 64 && !/[{}[\]]/.test(text)) body = text;
    }
  } catch { /* opaque wake, keep the generic body */ }
  event.waitUntil(
    self.registration.showNotification("Chama", {
      body,
      tag: "chama-wake",          // collapse a burst of wakes into one buzz
      renotify: true,
      icon: "/icons/android-chrome-192x192.png",
      badge: "/icons/favicon-96x96.png",
      data: { wake: true },       // no escrowId — resolved by the client on open
    }),
  );
});

// The push subscription can be rotated by the browser/OS at any time. When that
// happens the old endpoint is dead; re-subscribe and let the client re-register
// its watch-tags against the new endpoint on next focus (it reconciles on load).
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of clientsList) {
        client.postMessage({ type: "chama:pushsubscriptionchange" });
      }
    } catch { /* the client re-subscribes on next load regardless */ }
  })());
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
      // routes through the same pending trade-deep-link buffer. A wake-only tap
      // (no escrowId) just focuses the app so it can catch up from relays.
      existing.postMessage({
        type: "chama:notificationclick",
        escrowId: escrowId || null,
      });
      return existing.focus();
    }
    return self.clients.openWindow(target);
  })());
});
