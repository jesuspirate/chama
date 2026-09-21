import { useLayoutEffect, useRef } from "react";

/** Measure the available question canvas below the app chrome and above navigation. */
export function useCanvasViewport<T extends HTMLElement = HTMLDivElement>() {
  // Runway #6: stop guessing the surrounding chrome. The old hardcoded
  // `100dvh - 360px` (mobile: 116px) held only while the header stack stayed
  // under the guess — one banner away from the amount slide scrolling again.
  // Measure instead: chrome above = this element's offset from the document
  // top (header stack, price banner, WalletBar, ChamaBar, sim pill — whatever
  // is actually mounted today); chrome below = the fixed bottom nav, live.
  // Published as --assisted-chrome on the canvas root; the CSS falls back to
  // the old guesses wherever measurement is unavailable.
  const rootRef = useRef<T | null>(null);
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || typeof window === "undefined") return;
    const measure = () => {
      // scrollY-corrected so a mid-scroll re-measure can't poison the value.
      const top = Math.max(0, Math.round(el.getBoundingClientRect().top + window.scrollY));
      const nav = document.querySelector<HTMLElement>("[data-chama-bottom-nav]");
      const bottom = nav ? Math.round(nav.getBoundingClientRect().height) : 0;
      el.style.setProperty("--assisted-chrome", `${top + bottom}px`);
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(document.body);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);
  return rootRef;
}
