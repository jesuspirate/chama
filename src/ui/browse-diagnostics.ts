import { nip19 } from 'nostr-tools';
import { EscrowEventKind, EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
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
  return {
    viewer: /^[0-9a-f]{64}$/i.test(input.viewer) ? nip19.npubEncode(input.viewer) : null,
    community: input.community, currency: input.currency, scope: input.scope,
    category: input.category, search: input.search, mine: input.mine,
    otherCurrencies: input.otherCurrencies, clock: input.clock, relays: [...input.relays].sort(),
    coverage: 'Loaded states and locally indexed ids; unseen relay ids are unknown.',
    listings: [...new Set([...states.keys(), ...input.knownIds])].sort().map(id => {
      const state = states.get(id);
      const included = input.visibleIds.has(id);
      if (!state) return {id, included:false, reasons:['not-fetched'], createAt:null, cancelAt:null, presenceDeadline:null};
      const createAt = state.eventChain.find(e => e.kind === EscrowEventKind.CREATE)?.timestamp ?? state.createdAt;
      const cancelAt = state.eventChain.find(e => e.kind === EscrowEventKind.CANCEL)?.timestamp ?? state.cancelledAt ?? null;
      let reasons: string[];
      if (included) reasons = [isOwnListing(state,input.viewer) ? 'mine' : input.matchingIds.has(id) ? 'community' : 'all', input.otherCurrencies ? 'other-currency' : 'currency'];
      else if (state.status === EscrowStatus.CANCELLED) reasons = [`cancelled@${cancelAt ?? 'unknown'}`];
      else if (state.status === EscrowStatus.CREATED && state.expiresAt < input.clock) reasons = [`presence-lapsed@${state.expiresAt}`];
      else if (input.excludedReasons[id]) reasons = [input.excludedReasons[id]];
      else if (isOwnListing(state,input.viewer) !== input.mine) reasons = ['mine'];
      else if (input.scope === 'local' && !input.matchingIds.has(id)) reasons = ['community'];
      else if (!input.currencyIds.has(id)) reasons = ['currency'];
      else if (!input.searchIds.has(id)) reasons = ['search'];
      else reasons = ['category'];
      return {id, included, reasons, createAt, cancelAt, presenceDeadline:state.expiresAt};
    }),
  };
}
