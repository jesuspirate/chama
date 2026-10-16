// ══════════════════════════════════════════════════════════════════════════
// lnurl-transport — how LNURL-pay lookups and invoice callbacks travel.
//
// Jet (6.4.25 rc, Pixel 8 on GrapheneOS): Lightning-address claims failed in
// the Android app with "Failed to fetch" for strike.me and Fedi's LNURL server,
// while Vanadium on the same phone reached strike.me fine. Both servers send
// `Access-Control-Allow-Origin: *` to the app's https://localhost origin for
// the lookup and the callback (checked 2026-10-14), so CORS is not the cause;
// the WebView's network request fails before any response. On Android these
// requests now go through the native HTTP stack (CapacitorHttp), as Tauri
// desktop already does for market data (market-fetch.ts). Only the transport
// changes: every check on the response (status, JSON, tag, callback, invoice
// amount and expiry) stays in lnurl.ts.
// ══════════════════════════════════════════════════════════════════════════

import { Capacitor, CapacitorHttp } from "@capacitor/core";

export type LnurlFetch = (url: string) => Promise<Response>;

/** Seconds to wait for a wallet server before saying it did not answer. */
export const LNURL_TIMEOUT_MS = 20_000;

type NativeHttp = {
  get(options: { url: string; headers?: Record<string, string>; connectTimeout?: number; readTimeout?: number; responseType?: "text" }): Promise<{ data: unknown; status: number; headers: Record<string, string> }>;
};

/** True where LNURL requests must avoid the WebView: the Android app. */
export function useNativeLnurlHttp(platform = Capacitor.getPlatform(), native = Capacitor.isNativePlatform()): boolean {
  return native && platform === "android";
}

/** A fetch-shaped call over native HTTP. The body is handed back as text so
 *  lnurl.ts parses and validates it exactly as it does a WebView response. */
export function nativeLnurlFetch(http: NativeHttp = CapacitorHttp as unknown as NativeHttp): LnurlFetch {
  return async (url: string) => {
    const res = await http.get({
      url,
      headers: { Accept: "application/json" },
      connectTimeout: LNURL_TIMEOUT_MS,
      readTimeout: LNURL_TIMEOUT_MS,
      responseType: "text",
    });
    const body = typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? null);
    // Response rejects statuses outside 200–599; such a reply is no answer.
    if (!(res.status >= 200 && res.status <= 599)) throw new Error(`no HTTP answer (status ${res.status})`);
    return new Response(body, { status: res.status, headers: { "content-type": res.headers?.["Content-Type"] ?? res.headers?.["content-type"] ?? "application/json" } });
  };
}

export function withLnurlTimeout(fetchImpl: LnurlFetch, ms = LNURL_TIMEOUT_MS): LnurlFetch {
  return (url: string) => new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${Math.round(ms / 1000)} seconds`)), ms);
    fetchImpl(url).then(
      res => { clearTimeout(timer); resolve(res); },
      err => { clearTimeout(timer); reject(err); },
    );
  });
}

/** The default transport for LNURL-pay: native HTTP in the Android app, the
 *  global fetch everywhere else; both give up after LNURL_TIMEOUT_MS. */
export function defaultLnurlFetch(): LnurlFetch {
  if (useNativeLnurlHttp()) return withLnurlTimeout(nativeLnurlFetch());
  if (typeof fetch === "undefined") return async () => { throw new Error("fetch is not available in this environment"); };
  return withLnurlTimeout((url: string) => fetch(url));
}
