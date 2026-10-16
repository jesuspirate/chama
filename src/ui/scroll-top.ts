// Tapping the tab you are already on brings you back to the top (Jet,
// 6.4.25-rc.6: "Home is a bit long to scroll"). index.html gives html and
// body `height: 100%` with `overflow-x: hidden`, which makes <body> the
// element that scrolls, not the window: document.scrollingElement and
// window.scrollY stay at 0 (rc.7 on the Pixel). So check every candidate
// and scroll whichever one is actually down the page.

type ScrollRoot = { scrollTop: number; scrollTo?: (opts: ScrollToOptions) => void };

/** The elements that can be the page's scroller: the document's scrolling
 *  element and <body> (the real one with Chama's html/body CSS). */
export function defaultScrollRoots(): ScrollRoot[] {
  if (typeof document === "undefined") return [];
  const roots = [document.scrollingElement, document.body].filter(Boolean) as ScrollRoot[];
  return [...new Set(roots)];
}

/** Scrolls every scrolled candidate to the top and returns true, or returns
 *  false when none is scrolled (so a second tap can keep another meaning). */
export function scrollToTopIfScrolled(
  roots: ReadonlyArray<ScrollRoot | null | undefined> = defaultScrollRoots(),
  reduceMotion = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
): boolean {
  const scrolled = roots.filter((root): root is ScrollRoot => !!root && root.scrollTop > 4);
  for (const root of scrolled) {
    if (typeof root.scrollTo === "function") root.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    else root.scrollTop = 0;
  }
  return scrolled.length > 0;
}
