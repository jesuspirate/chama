import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App.js";
import { LangProvider } from "./i18n/index.js";
import { assertProductionEncryption } from "./escrow-engine/encryption-config.js";
import { claimRemoteBridgeInviteFromFragment } from "./fedimint/native-bridge-adapter.js";
import { requestPersistentStorageIfWorthwhile } from "./storage/persistent-storage.js";

// SECURITY: hard-fail at boot if a production build is somehow
// shipping with DEV encryption (which would publish LOCK / VOTE /
// CLAIM / RESOLVE payloads in cleartext to every relay we touch).
// Vite injects `import.meta.env.PROD = true` for `vite build`
// output and false for `vite dev`, so this is a no-op for the dev
// server while remaining a guaranteed tripwire on every shipped APK
// or web bundle.
assertProductionEncryption(import.meta.env.PROD);

// Remote-bridge "friend wallet" invite links carry `#bridge=<url>&token=<t>`
// in the URL fragment. Claim it into localStorage and strip it BEFORE the app
// renders, so the first wallet init already talks to the invited bridge and
// the token never lingers in the address bar.
claimRemoteBridgeInviteFromFragment();

// Android Chrome/PWA requires web notifications to be shown by a service
// worker; the page-level Notification constructor may be present yet throw.
if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/chama-sw.js").catch((error) => {
    console.warn("[chama/notify] service worker registration failed", error);
  });
}

// Ask the browser not to evict us. A browser client keeps its Fedimint wallet
// in OPFS and its escrow history in IndexedDB, and both are "best-effort"
// storage that WebKit and Chromium evict least-recently-used once a site goes
// unused — which loses a WALLET, not a preference. The call is self-gating: it
// skips a first-time visitor entirely (Firefox would prompt) and
// short-circuits once the origin is already persistent. Never blocks render.
//
// This does not keep anyone signed in: in a browser or PWA the nsec is never
// written to disk at all (see shouldPersistNsecInShell) — that is a separate,
// deliberate decision.
void requestPersistentStorageIfWorthwhile().then((outcome) => {
  if (outcome === "denied") {
    console.warn(
      "[chama/storage] persistent storage refused — this origin's wallet and " +
        "trade history remain evictable. Installing Chama to the home screen " +
        "is what most often flips this.",
    );
  }
});

// Opening another friend-wallet invite in an already-running Chama tab is a
// same-document hash navigation, so `main.tsx` does not execute again. Claim
// that new invite as soon as the hash changes, then reload once so every wallet
// consumer is rebuilt against the newly selected isolated bridge. The claim
// strips the hash before reload, preventing a loop and keeping the token out of
// the address bar.
window.addEventListener("hashchange", () => {
  if (claimRemoteBridgeInviteFromFragment()) window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
