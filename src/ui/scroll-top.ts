// Tapping the tab you are already on brings you back to the top (Jet,
// 6.4.25-rc.6: "Home is a bit long to scroll"). The page itself scrolls, so
// this is the document's scrolling element.

type ScrollRoot = { scrollTop: number; scrollTo?: (opts: ScrollToOptions) => void };

/** Scrolls the page to the top and returns true, or returns false when it is
 *  already there (so a second tap can keep another meaning). */
export function scrollToTopIfScrolled(
  root: ScrollRoot | null = typeof document !== "undefined" ? document.scrollingElement as ScrollRoot | null : null,
  reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
): boolean {
  if (!root || root.scrollTop <= 4) return false;
  if (typeof root.scrollTo === "function") root.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  else root.scrollTop = 0;
  return true;
}
