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
// can't be a fixed list. That includes plain http, for a user's own
// explorer on their home network (StartOS opened over the LAN). Listing
// photos can come from any https host.
//
// A <meta> policy covers the page only. The wallet's worker and the
// service worker load from their own URLs and take no policy from it.

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // WebAssembly may compile (Fedimint's wallet); the page may not eval.
  "script-src 'self' 'wasm-unsafe-eval'",
  // The UI sets inline styles throughout (React style props, <style> tags).
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "media-src 'self' data: blob: https:",
  // Relays (wss/ws), federations, LNURL and explorers (https, or http for
  // a user's own explorer, the wallet bridge on this device and .onion)
  // and Tauri's IPC.
  "connect-src 'self' https: wss: ws: http: ipc: http://ipc.localhost",
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

/**
 * Refuse a finished page the policy would break: no policy tag, an inline
 * script or handler (refused at runtime, so the app could load blank), or
 * <meta charset> pushed past the first 1024 bytes by the tag.
 */
export function checkBuiltPage(name: string, html: string): void {
  const tag = contentPolicyMetaTag();
  if (!html.includes(tag)) throw new Error(`content policy: ${name} has no content policy tag`);
  for (const script of html.match(/<script\b[^>]*>/gi) ?? []) {
    if (!/\bsrc\s*=/i.test(script)) throw new Error(`content policy: ${name} has an inline <script>, which would be refused`);
    if (/\son[a-z]+\s*=/i.test(script)) throw new Error(`content policy: ${name} has an inline event handler, which would be refused`);
  }
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) throw new Error(`content policy: ${name} has an inline event handler, which would be refused`);
  const charset = html.search(/<meta\s+charset/i);
  if (charset === -1 || charset > 1024) throw new Error(`content policy: ${name} must declare its charset in the first 1024 bytes`);
}
