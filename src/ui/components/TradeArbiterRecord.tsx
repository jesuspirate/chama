import type { NostrProfileNameMap } from '../nostr-profiles.js';
import { useEffect, useState } from 'react';
import type { EscrowState } from '../../escrow-engine/types.js';
import { displayedTradeArbiter } from '../../arbiters/trade-arbiter.js';
import { arbiterRecord } from '../../arbiters/record.js';
import type { VerifiedBond } from '../../bond-multisig/bond-announcement.js';
import { readCachedCommunityBonds } from '../../arbiters/bonded-pool-cache.js';
import { ArbiterRecordCard } from './ArbiterRecordCard.js';
export function TradeArbiterRecord({ state, trades, fetchBonds, profileNames, kind0Enabled }: {
  state: EscrowState; trades: readonly EscrowState[];
  fetchBonds?: (community: string) => Promise<VerifiedBond[]>;
  profileNames?: NostrProfileNameMap; kind0Enabled?: boolean;
}) {
  const cached = () => state.community ? readCachedCommunityBonds(state.community) ?? [] : [];
  const [bonds, setBonds] = useState<VerifiedBond[]>(cached);
  const key = displayedTradeArbiter(state);
  useEffect(() => {
    let cancelled = false;
    setBonds(cached());
    if (state.community && fetchBonds) void fetchBonds(state.community).then(value => {
      // Absence from a partial roster is not proof that this arbiter has no bond.
      if (!cancelled && value.length) setBonds(previous => [
        ...previous.filter(old => !value.some(b => b.npub.toLowerCase() === old.npub.toLowerCase())), ...value,
      ]);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [state.community, fetchBonds]);
  return key ? <ArbiterRecordCard
    bondsKnown={bonds.some(b => b.npub.toLowerCase() === key.toLowerCase())}
    profileNames={profileNames} kind0Enabled={kind0Enabled}
    record={arbiterRecord(key, trades, bonds, new Map(), Math.floor(Date.now() / 1000))} /> : null;
}
