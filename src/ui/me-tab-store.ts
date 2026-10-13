import { useSyncExternalStore } from "react";

export type MeTabKey = "trades" | "sats" | "seller" | "arbiter" | "profile" | "community" | "settings";

/** Which Me tab is pressed and which is shown, outside React state, so a tab
 *  tap re-renders only the pill row and the two panes that swap — not the Me
 *  screen, and nothing outside it (Jet, 6.4.24 rc: taps waited behind
 *  re-renders of the whole screen).
 *
 *  `press` highlights the pill at once; the pane swaps on the next frame, so
 *  the highlight paints before any first-visit mount starts. */
export type MeTabStore = ReturnType<typeof createMeTabStore>;
export function createMeTabStore(initial: MeTabKey) {
  let pressed = initial;
  let shown = initial;
  const visited = new Set<MeTabKey>([initial]);
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());
  let pending: { key: MeTabKey } | null = null;
  const show = (key: MeTabKey) => {
    shown = key;
    visited.add(key);
    emit();
  };
  const nextFrame = (fn: () => void) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(fn, 0));
    else setTimeout(fn, 0);
  };
  return {
    getPressed: () => pressed,
    getShown: () => shown,
    isVisited: (key: MeTabKey) => visited.has(key),
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** A pill tap: highlight now, show the pane on the next frame. */
    press(key: MeTabKey) {
      pressed = key;
      emit();
      const request = { key };
      pending = request;
      nextFrame(() => { if (pending === request) { pending = null; show(key); } });
    },
    /** Programmatic navigation (a "go to Wallet" request): both at once. */
    set(key: MeTabKey) {
      pending = null;
      pressed = key;
      show(key);
    },
  };
}

export function useMePressedTab(store: MeTabStore): MeTabKey {
  return useSyncExternalStore(store.subscribe, store.getPressed, store.getPressed);
}

export function useMeShownTab(store: MeTabStore): MeTabKey {
  return useSyncExternalStore(store.subscribe, store.getShown, store.getShown);
}
