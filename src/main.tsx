import React from "react";
import ReactDOM from "react-dom/client";
import App from "./ui/App.js";
import { LangProvider } from "./i18n/index.js";
import { assertProductionEncryption } from "./escrow-engine/encryption-config.js";
import { requestPersistentStorageIfWorthwhile } from "./storage/persistent-storage.js";

// SECURITY: hard-fail at boot if a production build is somehow
// shipping with DEV encryption (which would publish LOCK / VOTE /
// CLAIM / RESOLVE payloads in cleartext to every relay we touch).
// Vite injects `import.meta.env.PROD = true` for `vite build`
// output and false for `vite dev`, so this is a no-op for the dev
// server while remaining a guaranteed tripwire on every shipped APK
// or web bundle.
assertProductionEncryption(import.meta.env.PROD);

// Remote-bridge "friend wallet" invite links carried `#bridge=<url>&token=<t>`
// in the URL fragment — a wallet-repoint primitive: opening such a link used to
// silently point your money lane at the sender's node. Friend links were soft-
// shut-down (2026-08-24, nobody uses them; the in-browser WASM wallet replaced
// them), so we NO LONGER CLAIM the fragment for anyone. We only NEUTRALIZE it:
// if such a fragment is present we strip it from the URL and do nothing else,
// so an old or hostile link can't leave a bearer token lingering in the address
// bar or history. Manual bridge config through Settings → Advanced (power-user
// only) is the sole remaining way in. Runs before render so nothing ever reads
// a fragment-supplied bridge URL.
function neutralizeRemoteBridgeInviteFragment(): void {
  try {
    if (typeof window === "undefined") return;
    const rawHash = window.location.hash.replace(/^#/, "");
    if (!rawHash) return;
    // Match the invite shape: either key alone is enough to justify stripping,
    // so a partial link that left only a `token=` behind is cleaned too. No
    // other feature uses the URL fragment, so this can't clobber real state.
    if (!/(?:^|[&?])(?:bridge|token)=/.test(rawHash)) return;
    window.history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } catch {
    // Best-effort: the fragment is client-side only and was never claimed, so
    // a failed strip transmits nothing and repoints nothing.
  }
}
neutralizeRemoteBridgeInviteFragment();

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

// A friend-wallet invite arriving in an already-running Chama tab is a same-
// document hash navigation, so `main.tsx` does not execute again. We no longer
// claim it (see above) — we only strip it, so a link opened into a live tab
// likewise can't leave a bearer token in the address bar. No reload: nothing
// was claimed, so there is nothing to rebuild the wallet against.
window.addEventListener("hashchange", () => {
  neutralizeRemoteBridgeInviteFragment();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>
);
