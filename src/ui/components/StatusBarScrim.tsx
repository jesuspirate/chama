import { T } from "../theme.js";

/**
 * Jet (6.4.23 RC, Pixel 8): Android 15+ draws the app edge to edge, so the
 * phone's status bar is transparent. The shell pads its top by the safe-area
 * inset, but that padding scrolls away with the page and the header then slides
 * under the clock and icons. This strip stays fixed over the inset, so scrolled
 * content passes beneath it and the top bar always starts below the status bar.
 * Zero height wherever the platform reports no inset (desktop, plain browsers).
 */
export function StatusBarScrim() {
  return (
    <div
      aria-hidden="true"
      className="chama-status-scrim"
      style={{
        position: "fixed", top: 0, left: 0, right: 0, zIndex: 150,
        height: "env(safe-area-inset-top, 0px)",
        background: T.bg, pointerEvents: "none",
      }}
    />
  );
}
