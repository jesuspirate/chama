import { useState } from "react";
import { T } from "../theme.js";
export function RejectedLockRefund({amountMsats, onReclaim}: {amountMsats: number; onReclaim: () => Promise<void>}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sats = Math.floor(amountMsats / 1000);
  return <div style={{padding: 14, marginBottom: 12, borderRadius: T.rs, border: `1px solid ${T.amber}`}}>
    <p>This lock didn't reach the trade — the buyer's seat had lapsed. Take your {sats} sats back.</p>
    <button disabled={busy} onClick={() => {
      setBusy(true); setError(null);
      void onReclaim().catch(e => setError(e instanceof Error ? e.message : String(e))).finally(() => setBusy(false));
    }}>{busy ? "Taking your sats back…" : `Take your ${sats} sats back`}</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
