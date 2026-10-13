import { useRef } from "react";

/** True when two lists hold the same items in the same order. Items compare
 *  with `same` (identity by default). */
export function sameList<T>(a: readonly T[], b: readonly T[], same: (x: T, y: T) => boolean = Object.is): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
  return true;
}

/** Shallow equality for plain records (every own key equal by identity). */
export function sameRecord(a: object, b: object): boolean {
  if (a === b) return true;
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every(k => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Keeps the previous array while a freshly computed list is equal to it, so
 *  screens memoised on the list only redo work when its contents change. The
 *  contents are always the fresh ones: this only preserves identity. */
export function useStableList<T>(next: T[], same: (x: T, y: T) => boolean = Object.is): T[] {
  const ref = useRef(next);
  if (!sameList(ref.current, next, same)) ref.current = next;
  return ref.current;
}

/** A function whose identity never changes but which always calls the latest
 *  `fn`. Lets memoised children skip redraws when a parent passes a fresh
 *  inline callback on every render. Undefined stays undefined, so optional
 *  handlers keep their "absent" meaning. */
export function useStableCallback<A extends unknown[], R>(fn: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined {
  const latest = useRef(fn);
  latest.current = fn;
  const stable = useRef<((...args: A) => R) | null>(null);
  if (!stable.current) stable.current = (...args: A) => latest.current!(...args);
  return fn ? stable.current : undefined;
}
