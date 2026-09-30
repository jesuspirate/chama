import { sha256 } from '@noble/hashes/sha2.js';
import { base64urlnopad } from '@scure/base';
import type { NostrEvent } from '../escrow-engine/types.js';

/** Only device-local mappings; the push server still sees opaque tags alone. */
export function buildWakeIndex(events: readonly NostrEvent[], homeCommunity?: string) {
  const trades: Record<string, string[]> = {}, communities: Record<string, string> = {};
  for (const event of events) {
    const id = event.tags.find(t => t[0] === 'd')?.[1];
    if (!id) continue;
    for (const tag of event.tags.filter(t => t[0] === 'w' && t[1])) {
      const ids = trades[tag[1]] ??= [];
      if (!ids.includes(id)) ids.push(id);
    }
    const community = event.tags.find(t => t[0] === 'community')?.[1];
    if (community) communities[communityWakeTag(community)] = community;
  }
  if (homeCommunity) communities[communityWakeTag(homeCommunity)] = homeCommunity;
  return { watchTrades: trades, watchCommunities: communities };
}
export function communityWakeTag(slug: string): string {
  return base64urlnopad.encode(sha256(new TextEncoder().encode(`chama:community-wake:v1:${slug.trim().toLowerCase()}`))).slice(0, 16);
}
