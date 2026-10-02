// Portable trade links (Jet 2026-09-05): a plain https URL any friend can tap
// to land directly on a listing — App already consumes `?trade=sm_...` on boot
// (one-shot, address cleaned after open), so sharing is just building the URL.

//
// `by` names the key that created the trade. A trade is (creator, id): with it
// the opener roots the chain at that key's CREATE and nothing else
// (escrow-engine/trade-identity.ts). Links minted before it still open.

export function tradeShareUrl(escrowId: string, href = window.location.href, creator?: string | null): string {
  const here = new URL(href);
  const host = here.hostname.toLowerCase().replace(/\.$/, "");
  const privateHost = host === "localhost" || host.endsWith(".localhost")
    || host === "127.0.0.1" || host === "[::1]"
    || host.endsWith(".local") || host.endsWith(".onion");
  const publicWeb = ["https:", "http:"].includes(here.protocol) && !privateHost;
  const base = publicWeb ? `${here.origin}${here.pathname}` : "https://getchama.app/";
  const by = creator && /^[0-9a-f]{64}$/i.test(creator) ? `&by=${creator.toLowerCase()}` : "";
  return `${base}?trade=${encodeURIComponent(escrowId)}${by}`;
}

/** Native share sheet where the platform has one; clipboard everywhere else.
 *  "shared" also covers a cancelled sheet — nothing further owed to the user. */
export async function shareTradeLink(escrowId: string, creator?: string | null): Promise<"shared" | "copied" | "failed"> {
  const url = tradeShareUrl(escrowId, undefined, creator);
  const nav = navigator as Navigator & { share?: (data: { url: string }) => Promise<void> };
  if (typeof nav.share === "function") {
    try { await nav.share({ url }); return "shared"; }
    catch { /* cancelled or unsupported payload — fall through to clipboard */ }
  }
  try { await navigator.clipboard.writeText(url); return "copied"; }
  catch { return "failed"; }
}
