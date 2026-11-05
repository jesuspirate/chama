import { T } from "../theme.js";
import type { EscrowState } from "../../escrow-engine/types.js";

/** #43: a LOCK that held back two shares is not escrow yet. The funder is told
 *  the trade starts on acceptance; everyone else is told not to deliver. Shown
 *  until the funder's release lands. */
export function WithheldSharesNotice({ state, pubkey, t }: {
  state: EscrowState;
  pubkey: string | null | undefined;
  t: (key: string) => string;
}) {
  const withheld = state.lock.withheld;
  if (!withheld || withheld.releaseEventId) return null;
  const funder = !!pubkey && pubkey === withheld.lockerPubkey;
  return <div role="status" data-withheld-shares style={{ padding: 14, marginBottom: 12, borderRadius: T.rs, border: `1px solid ${T.amber}` }}>
    <p>{t(funder ? "trade.sharesWaitingFunder" : "trade.sharesWaitingOther")}</p>
  </div>;
}
