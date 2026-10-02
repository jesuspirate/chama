import { nip19 } from 'nostr-tools';
import { EscrowEventKind, EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
import { getCommunityBySlug } from '../communities/registry.js';
import { isOwnListing } from './browse-own-filter.js';
export interface BrowseDiagnosticsContext {
  clock: number;
  relays: readonly string[];
  knownIds: readonly string[];
  excludedReasons: Record<string, string>;
}
/** Content-free, read-only evidence from the same filters that painted Browse. */
export function browseDiagnostics(input: BrowseDiagnosticsContext & {
  viewer: string; community: string; currency: string; scope: string; category: string;
  search: string; otherCurrencies: boolean; mine: boolean;
  states: readonly EscrowState[]; visibleIds: ReadonlySet<string>;
  matchingIds: ReadonlySet<string>; currencyIds: ReadonlySet<string>; searchIds: ReadonlySet<string>;
}) {
  const states = new Map(input.states.map(s => [s.id, s]));
  const listings = [...new Set([...states.keys(), ...input.knownIds])].sort().map(id => {
    const state = states.get(id);
    const included = input.visibleIds.has(id);
    if (!state) return {id, included:false, in:[] as string[], out:['not-fetched'], createAt:null, cancelAt:null, presenceDeadline:null};
    const createAt = state.eventChain.find(e => e.kind === EscrowEventKind.CREATE)?.timestamp ?? state.createdAt;
    const cancelAt = state.eventChain.find(e => e.kind === EscrowEventKind.CANCEL)?.timestamp ?? state.cancelledAt ?? null;
    const currency = (state.fiatCurrency || getCommunityBySlug(state.community ?? '')?.currency || 'BTC').toUpperCase();
    let out: string[] = [];
    if (!included) {
      if (state.status === EscrowStatus.CANCELLED) out = [`cancelled@${cancelAt ?? 'unknown'}`];
      else if (state.status !== EscrowStatus.CREATED) out = [`status:${state.status}`];
      else if (state.expiresAt < input.clock) out = [`presence-lapsed@${state.expiresAt}`];
      else if (isOwnListing(state,input.viewer) !== input.mine) out = [input.mine ? 'not-mine' : 'mine'];
      else if (input.excludedReasons[id]) out = [input.excludedReasons[id]];
      else if (input.scope === 'local' && !input.matchingIds.has(id)) out = ['other-community'];
      else if (!input.currencyIds.has(id)) out = [`currency:${currency}`];
      else if (!input.searchIds.has(id)) out = ['search'];
      else out = [`category:${state.category}`];
    }
    return {id, included, in:included ? [isOwnListing(state,input.viewer) ? 'mine' : input.matchingIds.has(id) ? 'community' : 'all', `currency:${currency}`] : [],
      out, createAt, cancelAt, presenceDeadline:state.expiresAt};
  });
  const count = (reason:string) => listings.filter(row => row.out.some(r=>r===reason || r.startsWith(reason))).length;
  const summary = `shown ${listings.filter(row=>row.included).length} · mine ${count('mine')} · other-currency ${count('currency:')} · lapsed ${count('presence-lapsed@')} · cancelled ${count('cancelled@')} · unfetched ${count('not-fetched')}`;
  return {summary,
    viewer: /^[0-9a-f]{64}$/i.test(input.viewer) ? nip19.npubEncode(input.viewer) : null,
    community: input.community, currency: input.currency, scope: input.scope,
    category: input.category, search: input.search, mine: input.mine,
    otherCurrencies: input.otherCurrencies, clock: input.clock, relays: [...input.relays].sort(),
    coverage: 'Loaded states and locally indexed ids; unseen relay ids are unknown.', listings,
  };
}
