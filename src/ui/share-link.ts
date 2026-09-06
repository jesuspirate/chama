// Portable trade links (Jet 2026-09-05): a plain https URL any friend can tap
// to land directly on a listing — App already consumes `?trade=sm_...` on boot
// (one-shot, address cleaned after open), so sharing is just building the URL.

export function tradeShareUrl(escrowId: string): string {
  const here = new URL(window.location.href);
  return `${here.origin}${here.pathname}?trade=${escrowId}`;
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
