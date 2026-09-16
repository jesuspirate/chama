import { useState, useEffect } from "react";
import { generatedNameFor } from "../nostr-profiles.js";
import type { EscrowState } from "../../escrow-engine/types.js";
import type { CircleRound } from "../../chama/types.js";
import { circleFromEscrow } from "../../chama/policy.js";
import { sharesForCircle } from "../../chama/wiring.js";
import { circleSurfaceModel } from "../../chama/surface.js";
import { circleMemberStats } from "../../chama/stats.js";
import { CircleSeatRing } from "../components/CircleSeatRing.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { T, fmtSats } from "../theme.js";
import { useT, type TFunc } from "../../i18n/index.js";
import { shareTradeLink } from "../share-link.js";

export function circleTimeText(seconds: number, t: TFunc): string {
  if (seconds >= 86400) return t("circle.days", { count: Math.ceil(seconds / 86400) });
  if (seconds >= 3600) return t("circle.hours", { count: Math.ceil(seconds / 3600) });
  return t("circle.minutes", { count: Math.max(0, Math.ceil(seconds / 60)) });
}

export function CircleSurface({ parent, escrows, viewerPubkey, backLabel, childrenLoaded, loadError, onBack, onLock, onReturn, onClaim, onNextRound, onRefresh }: {
  parent: EscrowState; escrows: ReadonlyMap<string, EscrowState>; viewerPubkey: string;
  backLabel: string; childrenLoaded: boolean; loadError?: string | null; onBack: () => void;
  onLock: () => Promise<void>; onReturn: () => Promise<void>;
  /** REFUND resolved on the viewer's share: fire the SAME ClaimPayoutModal
   *  flow every trade uses, aimed at the share escrow. The last leg home. */
  onClaim: () => Promise<void>;
  onNextRound: (circle: CircleRound) => void; onRefresh: () => Promise<void>;
}) {
  const { t, lang } = useT();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false), [message, setMessage] = useState<string | null>(null);
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15000); return () => clearInterval(id); }, []);
  const circle = circleFromEscrow(parent);
  if (!circle) return null;
  const shares = sharesForCircle(escrows.values(), circle.circleId);
  const model = circleSurfaceModel(circle, shares, viewerPubkey, now);
  const stats = circleMemberStats(escrows.values(), viewerPubkey, now);
  const date = (at: number) => new Date(at * 1000).toLocaleDateString(lang, { month: "short", day: "numeric" });
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setMessage(null); try { await action(); } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const invite = async () => { const result = await shareTradeLink(circle.circleId); if (result !== "shared") setMessage(t(result === "copied" ? "circle.copied" : "circle.shareFailed")); };
  const status = !childrenLoaded ? t("circle.syncing") : model.status === "filling"
    // Fixed round clock: a FILLED circle keeps filling until the deadline
    // (no early start), so "waiting for 0 more" was arithmetically true and
    // humanly nonsense. Say the real thing: everyone's in, here's when it
    // starts. Members and host both get it; an outside viewer keeps N-of-M.
    ? model.filled && (model.seated || model.isHost)
      ? t("circle.filledStarts", { time: circleTimeText(model.secsToFillDeadline, t) })
      : model.move === "invite" && !model.isHost ? t("circle.yourShareIn", { count: Math.max(0, model.seatThreshold - model.seatsLocked) }) : t("circle.seats", { filled: model.seatsLocked, total: model.seatThreshold })
    : model.status === "running" ? t("circle.backBy", { date: date(circle.roundEndSec) })
    : model.status === "refund-due" ? t("circle.failedFill") : t("circle.complete");
  const moveKey = { lock: "circle.lock", invite: "circle.invite", collect: "circle.collect", "return-now": "circle.returnNow", "next-round": "circle.nextRound" } as const;
  const action = model.move === "lock" ? onLock : model.move === "invite" ? invite : model.move === "collect" ? onClaim : model.move === "return-now" ? onReturn : model.move === "next-round" ? async () => onNextRound(circle) : null;
  return <section className="circle-surface" style={{ maxWidth: 640, margin: "0 auto", padding: "24px 18px 38px", color: T.text }}>
    <button type="button" data-chama-shortcut="back" onClick={onBack} style={{ background: "none", border: 0, color: T.muted, padding: "8px 0", cursor: "pointer" }}>‹ {backLabel}</button>
    <div style={{ display: "flex", alignItems: "center", gap: 9, color: T.accent, font: `700 11px ${T.mono}`, letterSpacing: 2 }}><VerticalIcon vertical="chama" size={30} />CHAMA</div>
    <h1 style={{ fontSize: "clamp(32px, 6vw, 52px)", letterSpacing: "-.05em", margin: "10px 0 24px" }}>{circle.name}{circle.roundIndex > 1 && <span style={{ color: T.muted, fontWeight: 500 }}> · {t("circle.roundN", { n: circle.roundIndex })}</span>}</h1>
    <div style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: 30, padding: "clamp(22px,4vw,36px)", textAlign: "center" }}>
      {childrenLoaded && <CircleSeatRing filled={model.seatsLocked} total={model.seatThreshold} potMsats={model.potMsats} targetMsats={circle.shareMsats * model.seatThreshold} />}
      <h2 aria-live="polite" style={{ fontSize: "clamp(22px,4vw,30px)", lineHeight: 1.2, marginBottom: 12 }}>{status}</h2>
      <p style={{ color: T.muted, fontFamily: T.mono, lineHeight: 1.6 }}>{t("circle.satsEach", { amount: fmtSats(circle.shareMsats) })}{model.status === "filling" && ` · ${t("circle.closesIn", { time: circleTimeText(model.secsToFillDeadline, t) })}`}</p>
      {model.status === "running" && <p style={{ color: T.accent }}>{t("circle.countdown", { time: circleTimeText(model.secsToRoundEnd, t) })}</p>}
      {(model.move === "returning" || model.move === "return-now") && <p>{t("circle.returning")}</p>}
      {model.move === "collect" && <p style={{ color: T.accent, fontWeight: 700 }}>{t("circle.readyCollect")}</p>}
      {model.refusal && <p>{t(model.refusal === "full" ? "circle.full" : model.refusal === "closed" ? "circle.closed" : model.refusal === "host-waits" ? "circle.hostLocksLast" : "circle.alreadySeated")}</p>}
      {model.status === "complete" && childrenLoaded && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, margin: "26px 0" }}>
          {[["circle.completedCircles", stats.completed], ["circle.onTime", stats.onTime], ["circle.standing", Math.round(stats.standing).toLocaleString(lang)]].map(([label, value]) => <div key={label} style={{ padding: "16px 4px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16 }}><strong style={{ display: "block", fontSize: 24 }}>{value}</strong><small style={{ color: T.muted }}>{t(String(label))}</small></div>)}
        </div><h3>{t("circle.nextTitle")}</h3><p style={{ color: T.muted, lineHeight: 1.6 }}>{t("circle.nextBody")}</p>
      </>}
      {action && childrenLoaded && <button type="button" disabled={busy} onClick={() => void run(action)} style={{ width: "100%", minHeight: 60, marginTop: 16, border: 0, borderRadius: 999, background: T.accent, color: T.bg, font: `800 18px ${T.sans}`, cursor: busy ? "wait" : "pointer", opacity: busy ? .6 : 1 }}>{t(moveKey[model.move as keyof typeof moveKey])}</button>}
      {!childrenLoaded && <button type="button" onClick={() => void run(onRefresh)} disabled={busy}>{t("circle.retry")}</button>}
      {(message || loadError) && <p role="status" style={{ color: T.accent, lineHeight: 1.5 }}>{message ?? loadError}</p>}
    </div>
    {childrenLoaded && shares.some(sh => sh.circleId === circle.circleId) && <div style={{ marginTop: 26, background: T.card, border: `1px solid ${T.border}`, borderRadius: 22, padding: "18px 20px" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 15, color: T.muted, letterSpacing: 1, textTransform: "uppercase" }}>{t("circle.members")}</h3>
      {shares.filter(sh => sh.circleId === circle.circleId)
        .sort((a, b) => (a.lockedAtSec ?? Infinity) - (b.lockedAtSec ?? Infinity))
        .map((sh, index) => {
          const you = sh.memberPubkey.toLowerCase() === viewerPubkey.toLowerCase();
          return <div key={sh.memberPubkey} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "9px 0", borderTop: index ? `1px solid ${T.border}` : "none" }}>
            <span style={{ color: T.muted, font: `600 12px ${T.mono}`, minWidth: 22 }}>{sh.lockedAtSec !== null ? `#${index + 1}` : "·"}</span>
            <strong style={{ flex: 1, fontSize: 15 }}>{generatedNameFor(sh.memberPubkey, lang)}{you && <span style={{ color: T.accent, fontWeight: 600 }}> · {t("circle.you")}</span>}</strong>
            <small style={{ color: sh.lockedAtSec !== null ? T.accent : T.muted, fontFamily: T.mono }}>{sh.lockedAtSec !== null ? t("circle.lockedOn", { date: date(sh.lockedAtSec) }) : t("circle.reservedSeat")}</small>
          </div>;
        })}
    </div>}
    <p style={{ textAlign: "center", color: T.muted, lineHeight: 1.7, fontSize: 13, margin: "22px auto 0", maxWidth: 430 }}>{t("circle.footer")}</p>
  </section>;
}
