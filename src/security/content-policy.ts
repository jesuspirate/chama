// ══════════════════════════════════════════════════════════════════════════
// Chama — Content-Security-Policy for every shell (audit M8)
// ══════════════════════════════════════════════════════════════════════════
//
// The backstop for a bad dependency or an injection we haven't found: the
// page runs only scripts it ships itself. Injected markup can't run inline
// script, load a script from elsewhere, frame the app or post a form away.
//
// Built pages carry it as a <meta> tag (vite.config.ts), so the web app,
// PWA, Android (Capacitor), desktop (Tauri) and StartOS all get the same
// policy. The dev server is left without it: its hot-reload preamble is an
// inline script.
//
// Network reach stays wide on purpose: relays, federations, Lightning
// addresses and explorers are chosen by users and sellers, so connect-src
// can't be a fixed list. Listing photos can come from any https host.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // Fedimint's wallet is WebAssembly; nothing else may be compiled or eval'd.
  "script-src 'self' 'wasm-unsafe-eval'",
  // The UI sets inline styles throughout (React style props, <style> tags).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  // Relays (wss/ws), federations, LNURL and explorers (https), the native
  // wallet bridge on this device (127.0.0.1 / localhost), Tor LNURL (.onion)
  // and Tauri's IPC.
  "connect-src 'self' https: wss: ws: http://127.0.0.1:* http://localhost:* http://*.onion ipc: http://ipc.localhost",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** The <meta> tag carrying the policy, for the built HTML pages. */
export function contentPolicyMetaTag(): string {
  return `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}">`;
}
