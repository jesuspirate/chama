import { useState } from "react";
import { T } from "../theme.js";
import { HoldToConfirm } from "./Button.js";
import { EscrowStatus, type EscrowState } from "../../escrow-engine/types.js";
import { defaultWithheldShareStore } from "../../escrow-engine/withheld-share-store.js";

/** This device's recorded step for the LOCK's notes, if any. */
function savedStep(state: EscrowState): "release" | "withdraw" | undefined {
  try { return state.lock.notesHash ? defaultWithheldShareStore().load(state.id, state.lock.notesHash)?.step : undefined; }
  catch { return undefined; }
}

/** #43: a LOCK that held back two shares is not escrow yet. The funder is told
 *  the trade starts on acceptance and, until the other side accepts, can take
 *  the sats back with a hold; everyone else is told not to deliver. Shown
 *  until the funder's release lands. Mirrors EscrowClient.canWithdrawWithheldLock. */
export function WithheldSharesNotice({ state, pubkey, t, onWithdraw }: {
  state: EscrowState;
  pubkey: string | null | undefined;
  t: (key: string) => string;
  onWithdraw?: (id: string) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withheld = state.lock.withheld;
  if (!withheld || withheld.releaseEventId) return null;
  const funder = !!pubkey && pubkey === withheld.lockerPubkey;
  // Before the other side accepts; after it only to retry a withdraw this
  // device already chose, or past the deadline (no release then).
  const step = funder ? savedStep(state) : undefined;
  const canWithdraw = funder && !!onWithdraw && step !== "release"
    && (!state.lock.acceptEventId || step === "withdraw" || state.status === EscrowStatus.EXPIRED);
  return <div role="status" data-withheld-shares style={{ padding: 14, marginBottom: 12, borderRadius: T.rs, border: `1px solid ${T.amber}` }}>
    <p>{t(!funder ? "trade.sharesWaitingOther"
      : step === "withdraw" ? "trade.sharesWithdrawRetry"
      : state.status === EscrowStatus.EXPIRED ? "trade.sharesExpiredFunder"
      : state.lock.acceptEventId ? "trade.sharesSendingFunder"
      : "trade.sharesWaitingFunder")}</p>
    {canWithdraw && <HoldToConfirm
      variant="secondary"
      label={t("trade.takeSatsBack")}
      hint={t("common.holdToConfirm")}
      armedLabel={t("common.holdArmed")}
      busy={busy}
      onConfirm={() => {
        if (busy) return;
        setBusy(true); setError(null);
        void onWithdraw!(state.id)
          .catch(e => setError(e instanceof Error ? e.message : String(e)))
          .finally(() => setBusy(false));
      }} />}
    {error && <p role="alert">{error}</p>}
  </div>;
}
