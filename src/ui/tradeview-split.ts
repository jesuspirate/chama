// ══════════════════════════════════════════════════════════════════════════
// Chama — TradeView split preference (draggable divider persistence)
// ══════════════════════════════════════════════════════════════════════════
//
// TradeDetail is two vertical zones — the action/status card (`.td-action-scroll`)
// on top and the pager (`.td-lower`, Chat · Details · Parties) below — inside a
// shell that never scrolls. A draggable divider lets the viewer choose how the
// two SHARE the height instead of a fixed flex ratio deciding it. The chosen
// split is stored here as a FRACTION (the top zone's share of the space the two
// zones divide), so it survives a viewport or orientation change; a pixel value
// would not.
//
// This is a pure layout preference, device-local and shared across ALL trades —
// never per-trade state. `null` means "no preference": render exactly as before
// this feature existed (top sized to content, bottom takes the rest).

/** localStorage key. Per-viewer; one preference for every trade. */
export const TRADEVIEW_SPLIT_KEY = "chama_tradeview_split";

// Hard bounds on the stored FRACTION. These are deliberately inside (0, 1) so a
// stored value can never drive either zone toward zero height; the CSS
// `minHeight` floors on each zone are the pixel-level hard limit, and the live
// drag is clamped to the same bounds. 0.12 / 0.88 keeps both readable minimums
// satisfiable on ordinary phone viewports.
export const SPLIT_MIN = 0.12;
export const SPLIT_MAX = 0.88;

/**
 * Normalize a raw stored string into a usable top-share fraction, or `null`.
 *
 *   - absent / empty / non-numeric  → `null`  (render the default, no preference)
 *   - any finite number             → snapped into [SPLIT_MIN, SPLIT_MAX]
 *
 * A corrupt value therefore falls back to the default rather than throwing, and
 * an out-of-range number snaps into range rather than rendering a zero-height
 * zone — the guard rail the brief asks for.
 */
export function normalizeStoredSplit(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return clampSplitFrac(n);
}

/** Clamp a live drag fraction to the same hard bounds the stored value uses. */
export function clampSplitFrac(frac: number): number {
  if (!Number.isFinite(frac)) return SPLIT_MIN;
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, frac));
}

/** Read the persisted split. Never throws — a blocked/absent store is `null`
 *  (the default layout). */
export function readSplitFrac(): number | null {
  try {
    return normalizeStoredSplit(localStorage.getItem(TRADEVIEW_SPLIT_KEY));
  } catch {
    return null;
  }
}

/** Persist a split fraction (clamped). Best-effort — a private window or blocked
 *  store simply doesn't remember, and never throws into the drag handler. */
export function writeSplitFrac(frac: number): void {
  try {
    localStorage.setItem(TRADEVIEW_SPLIT_KEY, String(clampSplitFrac(frac)));
  } catch {
    /* private mode / storage disabled — the split just isn't remembered */
  }
}

/** Forget the split (reset to default). Never throws. */
export function clearSplitFrac(): void {
  try {
    localStorage.removeItem(TRADEVIEW_SPLIT_KEY);
  } catch {
    /* ignore */
  }
}
