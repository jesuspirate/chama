// ══════════════════════════════════════════════════════════════════════════
// Chama — the tranche plan strip
// ══════════════════════════════════════════════════════════════════════════
//
// Shows a split trade honestly: how many slices settled, how much is still to
// come, and whether it is safe to start the next one.
//
// ⚠ THE STOP IS THE FEATURE. When a slice completes without the sats landing,
// this must read as a STOP, not as a spinner or a soft "pending". That state is
// the drained-escrow signature (escrow-engine/tranche.ts), and it is the entire
// reason the trade was split in the first place. A design that made it look
// like a normal wait would have thrown away the detection tranching exists to
// create — so it is red, it is unmissable, and it offers no way onward.
//
// The strip renders for BOTH parties, but only the exposed party — the
// non-locker, who performs the irreversible leg — gets the advance button. The
// funder has nothing to decide here.

import { useT } from "../../i18n/index.js";
import type { EscrowState } from "../../escrow-engine/types.js";
import { outstandingMsats, type TrancheGate } from "../../escrow-engine/tranche.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { T } from "../theme.js";

export function TranchePlanStrip({
  state,
  gate,
  canAdvance,
  advancing,
  error,
  onAdvance,
}: {
  state: EscrowState;
  gate: TrancheGate;
  /** Is the viewer the exposed party, i.e. the one who decides to continue? */
  canAdvance: boolean;
  advancing: boolean;
  error?: string | null;
  onAdvance: () => void;
}) {
  const { t } = useT();
  const ref = state.tranche;
  if (!ref) return null;

  const outstanding = outstandingMsats(ref, gate.settled);
  const tone = gate.stopped ? T.red : gate.settled === gate.total ? T.green : T.accent;

  return (
    <div style={{
      padding: "11px 13px", marginBottom: 12, borderRadius: T.rs,
      background: `${tone}10`, border: `1px solid ${tone}44`, fontFamily: T.sans,
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8,
        fontSize: 12.5, fontWeight: 800, color: tone,
      }}>
        <span>{t("tranche.title", { done: gate.settled, total: gate.total })}</span>
        <span style={{ marginLeft: "auto", fontFamily: T.mono, fontSize: 11, color: T.muted }}>
          {t("tranche.outstanding")} <BitcoinAmount sats={Math.round(outstanding / 1000)} size={11} gap={2} />
        </span>
      </div>

      {/* Numbered slices make the plan read as one continuing commitment, not
          an unexplained progress bar attached to an isolated trade. */}
      <div style={{ display: "flex", gap: 5, marginBottom: 9 }}>
        {Array.from({ length: gate.total }, (_, i) => {
          const settled = i < gate.settled;
          const current = i === (gate.nextIndex ?? gate.settled);
          return (
            <div key={i} style={{
              minWidth: 0, flex: 1, padding: "5px 2px", borderRadius: 6,
              textAlign: "center", fontFamily: T.mono, fontSize: 9.5, fontWeight: 800,
              color: settled ? T.bg : current ? tone : T.muted,
              background: settled ? tone : current ? `${tone}1c` : `${T.muted}12`,
              border: `1px solid ${settled || current ? tone + "55" : T.border}`,
            }}>
              {settled ? "✓ " : ""}{i + 1}
            </div>
          );
        })}
      </div>

      <div style={{ fontSize: 12, color: gate.stopped ? T.red : T.muted, lineHeight: 1.55 }}>
        {gate.stopped
          ? t("tranche.stoppedBody")
          : gate.settled === gate.total
            ? t("tranche.completeBody")
            : gate.canProceed
              ? t("tranche.readyBody", { max: Math.round(outstanding / 1000) })
              : t("tranche.liveBody")}
      </div>

      {error && (
        <div role="alert" style={{ marginTop: 8, color: T.red, fontSize: 11.5, lineHeight: 1.45 }}>
          {error}
        </div>
      )}

      {canAdvance && gate.canProceed && (
        <button
          type="button"
          onClick={onAdvance}
          disabled={advancing}
          style={{
            marginTop: 10, width: "100%", padding: "11px 14px", borderRadius: T.rs,
            background: advancing ? T.surface : `${T.accent}1f`,
            border: `1px solid ${advancing ? T.border : T.accent}`,
            color: advancing ? T.muted : T.accent,
            fontFamily: T.sans, fontSize: 14, fontWeight: 800,
            cursor: advancing ? "default" : "pointer",
          }}
        >
          {advancing ? t("tranche.starting") : t("tranche.startNext", { n: (gate.nextIndex ?? 0) + 1 })}
        </button>
      )}
    </div>
  );
}
