import { useReducer, useRef } from "react";
import { EscrowEventKind, type EscrowState } from "../escrow-engine/types.js";

export function browseCreateId(state: EscrowState): string {
  return state.eventChain.find(e => e.kind === EscrowEventKind.CREATE)?.raw?.id ?? state.id;
}
export function scrollBrowseResults(target: HTMLElement | null, force = false): void {
  if (!target) return;
  const rect = target.getBoundingClientRect();
  const main = target.closest("main")?.getBoundingClientRect();
  const bottom = Math.min(window.innerHeight, main?.bottom ?? Infinity);
  if (force || rect.top >= bottom) target.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
}
export function browseAtTop(target: HTMLElement | null): boolean {
  if (!target) return true;
  const top = Math.max(0, target.closest("main")?.getBoundingClientRect().top ?? 0);
  return target.getBoundingClientRect().top >= top - 8;
}

export interface BrowseArrivalState { scope: string; admitted: string[] }
/** Only verified/replayed states enter here. Event identity survives cache hydration
 * and relay redelivery. Existing rows retain order while new rows wait. */
export function reconcileBrowseArrivals(previous: BrowseArrivalState | null, scope: string, listings: readonly EscrowState[], admit: boolean): { state: BrowseArrivalState; visible: EscrowState[]; pending: EscrowState[] } {
  const byEvent = new Map(listings.map(l => [browseCreateId(l), l]));
  const old = previous?.scope === scope ? previous.admitted : [...byEvent.keys()];
  const seen = new Set(old);
  const incoming = [...byEvent.keys()].filter(id => !seen.has(id));
  const admitted = admit ? [...incoming, ...old] : old;
  const uniqueTrades = (ids: string[]) => [...new Map(ids.flatMap(id => byEvent.has(id) ? [[byEvent.get(id)!.id, byEvent.get(id)!] as const] : [])).values()];
  return { state: { scope, admitted }, visible: uniqueTrades(admitted), pending: admit ? [] : uniqueTrades(incoming) };
}
export function useBrowseArrivals(scope: string, listings: readonly EscrowState[], header: React.RefObject<HTMLElement | null>) {
  const ledger = useRef<BrowseArrivalState | null>(null);
  const [flush, rerender] = useReducer(n => n + 1, 0);
  const lastFlush = useRef(flush);
  const result = reconcileBrowseArrivals(ledger.current, scope, listings, browseAtTop(header.current) || lastFlush.current !== flush);
  ledger.current = result.state;
  lastFlush.current = flush;
  return { ...result, flush: () => { rerender(); } };
}
