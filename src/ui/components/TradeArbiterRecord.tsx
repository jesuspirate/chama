import { useEffect, useState } from 'react';
import { Role, type EscrowState } from '../../escrow-engine/types.js';
import { pickPreferredArbiter } from '../../arbiters/pool.js';
import { arbiterRecord } from '../../arbiters/record.js';
import type { VerifiedBond } from '../../bond-multisig/bond-announcement.js';
import { ArbiterRecordCard } from './ArbiterRecordCard.js';
export function TradeArbiterRecord({state, trades, fetchBonds}: {state: EscrowState; trades: readonly EscrowState[];
  fetchBonds?: (community: string) => Promise<VerifiedBond[]>}) {
  const [bonds,setBonds] = useState<VerifiedBond[]>([]);
  const key = state.participants[Role.ARBITER] ?? pickPreferredArbiter(state.communityArbiters,state.bondedArbiters,state.id,
    [state.participants[Role.BUYER],state.participants[Role.SELLER]].filter((p): p is string => !!p));
  useEffect(() => {
    let cancelled = false; setBonds([]);
    if (state.community && fetchBonds) void fetchBonds(state.community).then(value => {if (!cancelled) setBonds(value);}).catch(() => {});
    return () => {cancelled = true;};
  },[state.community,fetchBonds]);
  return key ? <ArbiterRecordCard record={arbiterRecord(key,trades,bonds,new Map(),Math.floor(Date.now()/1000))} /> : null;
}
