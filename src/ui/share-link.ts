// Portable trade links (Jet 2026-09-05): a plain https URL any friend can tap
// to land directly on a listing — App already consumes `?trade=sm_...` on boot
// (one-shot, address cleaned after open), so sharing is just building the URL.

export function tradeShareUrl(escrowId: string, href = window.location.href): string {
  const here = new URL(href);
  const host = here.hostname.toLowerCase().replace(/\.$/, "");
  const privateHost = host === "localhost" || host.endsWith(".localhost")
    || host === "127.0.0.1" || host === "[::1]"
    || host.endsWith(".local") || host.endsWith(".onion");
  const publicWeb = ["https:", "http:"].includes(here.protocol) && !privateHost;
  const base = publicWeb ? `${here.origin}${here.pathname}` : "https://getchama.app/";
  return `${base}?trade=${encodeURIComponent(escrowId)}`;
}

/** Native share sheet where the platform has one; clipboard everywhere else.
 *  "shared" also covers a cancelled sheet — nothing further owed to the user. */
export async function shareTradeLink(escrowId: string): Promise<"shared" | "copied" | "failed"> {
  const url = tradeShareUrl(escrowId);
  const nav = navigator as Navigator & { share?: (data: { url: string }) => Promise<void> };
  if (typeof nav.share === "function") {
    try { await nav.share({ url }); return "shared"; }
    catch { /* cancelled or unsupported payload — fall through to clipboard */ }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; }
  catch { return "failed"; }
}
