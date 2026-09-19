import { useState, useEffect } from "react";
import { generatedNameFor, profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
import { rotationView } from "../../chama/rotation.js";
import { EscrowStatus, Outcome, Role } from "../../escrow-engine/types.js";
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

export function CircleSurface({ parent, escrows, viewerPubkey, backLabel, childrenLoaded, loadError, profileNames, kind0Enabled = false, onBack, onLock, onReturn, onClaim, onNextRound, onRefresh }: {
  parent: EscrowState; escrows: ReadonlyMap<string, EscrowState>; viewerPubkey: string;
  backLabel: string; childrenLoaded: boolean; loadError?: string | null;
  /** Circles used to render the deterministic nym directly, which ignored a
   *  user's own chosen name and every kind-0 profile — "circles doesn't care
   *  about my new name" (Jet, 2026-09-18). Same name resolution as every
   *  other surface now. */
  profileNames?: NostrProfileNameMap; kind0Enabled?: boolean;
  onBack: () => void;
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
  const allStates = [...escrows.values()];
  const rot = circle.pot === "rotation-v2" ? rotationView(allStates, circle.circleId, circle.roundIndex, circle.prevCircleId) : null;
  const claimable = rot ? allStates.filter(e => e.parent === circle.circleId && e.chamaPolicy === "share-v2"
    && e.participants[Role.SELLER]?.toLowerCase() === viewerPubkey.toLowerCase()
    && e.resolvedOutcome === Outcome.RELEASE && e.status === EscrowStatus.APPROVED).length : 0;
  const model = circleSurfaceModel(circle, shares, viewerPubkey, now,
    rot ? { collector: rot.collector, sealed: rot.order, claimable } : undefined);
  // A chosen name REPLACES the generated one (Jet, 2026-09-20: "if a user
  // wants the new name they definitely don't want the generated name"). A
  // nickname is the privacy-preserving choice precisely because the person
  // picked it; the deterministic nym is the fallback for everyone who never
  // chose, and it is identical on every client.
  const nym = (pk: string) => profileNameFor(profileNames, pk, kind0Enabled, lang)
    ?? generatedNameFor(pk, lang);
  // Who hosts. The creator pubkey is already public in the circle's own chain
  // event, so hiding it in the UI would only blind honest members — and the
  // host is the one person everyone may need to nudge (they lock last, and
  // they open the next round). Shown on every circle, public or private.
  const viewerIsHost = circle.creatorPubkey.toLowerCase() === viewerPubkey.toLowerCase();
  const isCollectionRound = rot !== null && circle.roundIndex >= 2;
  const viewerIsCollector = isCollectionRound && rot!.collector === viewerPubkey.toLowerCase();
  const stats = circleMemberStats(escrows.values(), viewerPubkey, now);
  const date = (at: number) => new Date(at * 1000).toLocaleDateString(lang, { month: "short", day: "numeric" });
  const [celebrate, setCelebrate] = useState(false);
  const run = async (action: () => Promise<void>) => { if (busy) return; setBusy(true); setMessage(null);
    const wasLock = model.move === "lock";
    try { await action(); if (wasLock) { setCelebrate(true); setTimeout(() => setCelebrate(false), 1700); } }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
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
  const moveKey = { lock: "circle.lock", invite: "circle.invite", collect: "circle.collect", "return-now": "circle.returnNow",
    "next-round": model.status === "refund-due" ? "circle.runAgain" : "circle.nextRound" } as const;
  const action = model.move === "lock" ? onLock : model.move === "invite" ? invite : model.move === "collect" ? onClaim : model.move === "return-now" ? onReturn : model.move === "next-round" ? async () => onNextRound(circle) : null;
  return <section className="circle-surface" style={{ maxWidth: 640, margin: "0 auto", padding: "24px 18px 38px", color: T.text }}>
    <style>{`
      .circle-loader{display:flex;justify-content:center;margin:14px 0 20px}
      .circle-loader-arc{transform-origin:60px 60px;animation:circleSpin 1.4s cubic-bezier(.6,.15,.4,.85) infinite}
      .circle-loader-seat{transform-origin:60px 60px;animation:circleSeatGlow 1.1s ease-in-out infinite}
      @keyframes circleSpin{to{transform:rotate(360deg)}}
      @keyframes circleSeatGlow{0%,100%{opacity:.25}50%{opacity:1}}
      .circle-lock-btn{animation:circleLockBreathe 2.6s ease-in-out infinite;transition:transform .12s ease}
      .circle-lock-btn:active{transform:scale(.965)}
      .circle-lock-btn.charging{animation:none}
      .circle-lock-btn.charging::after{content:"";position:absolute;inset:0;border-radius:999px;background:linear-gradient(110deg,transparent 20%,${T.bg}2e 50%,transparent 80%);animation:circleCharge .9s linear infinite}
      @keyframes circleLockBreathe{0%,100%{box-shadow:0 0 0 0 ${T.accent}00}50%{box-shadow:0 0 26px 0 ${T.accent}59}}
      @keyframes circleCharge{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
      .circle-locked-burst{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;font-size:64px;pointer-events:none;z-index:60;animation:circleBurstPop 1.7s cubic-bezier(.2,.9,.3,1) forwards}
      .circle-locked-burst span{position:absolute;width:14px;height:14px;border-radius:50%;background:${T.accent}}
      .circle-locked-burst span:nth-child(1){animation:circleFly1 1.2s ease-out forwards}
      .circle-locked-burst span:nth-child(2){animation:circleFly2 1.2s .06s ease-out forwards}
      .circle-locked-burst span:nth-child(3){animation:circleFly3 1.2s .12s ease-out forwards}
      @keyframes circleBurstPop{0%{opacity:0;transform:scale(.4)}12%{opacity:1;transform:scale(1.15)}22%{transform:scale(1)}78%{opacity:1}100%{opacity:0;transform:scale(1.05)}}
      @keyframes circleFly1{from{opacity:1;transform:translate(0,0)}to{opacity:0;transform:translate(-110px,-140px)}}
      @keyframes circleFly2{from{opacity:1;transform:translate(0,0)}to{opacity:0;transform:translate(120px,-110px)}}
      @keyframes circleFly3{from{opacity:1;transform:translate(0,0)}to{opacity:0;transform:translate(0,150px)}}
      @media (prefers-reduced-motion: reduce){.circle-lock-btn,.circle-loader-arc,.circle-loader-seat,.circle-lock-btn.charging::after{animation:none}.circle-locked-burst{animation:circleBurstPop 1.7s forwards}}
    `}</style>
    <button type="button" data-chama-shortcut="back" onClick={onBack} style={{ background: "none", border: 0, color: T.muted, padding: "8px 0", cursor: "pointer" }}>‹ {backLabel}</button>
    <div style={{ display: "flex", alignItems: "center", gap: 9, color: T.accent, font: `700 11px ${T.mono}`, letterSpacing: 2 }}><VerticalIcon vertical="chama" size={30} />CHAMA</div>
    <h1 style={{ fontSize: "clamp(32px, 6vw, 52px)", letterSpacing: "-.05em", margin: "10px 0 8px" }}>{circle.name}{circle.roundIndex > 1 && <span style={{ color: T.muted, fontWeight: 500 }}> · {isCollectionRound ? t("circle.roundOf", { n: circle.roundIndex, total: rot!.totalRounds }) : t("circle.roundN", { n: circle.roundIndex })}</span>}</h1>
    {viewerIsHost ? (
      // The host's job is structural (they lock last, they open the next
      // round), so it gets the weight of an instruction, not a footnote.
      <p style={{
        margin: "0 0 18px", display: "inline-flex", alignItems: "center", gap: 8,
        padding: "7px 14px", borderRadius: 999,
        background: T.accentDim, border: `1px solid ${T.accent}66`,
        color: T.accent, font: `800 13px ${T.sans}`,
      }}>
        <span aria-hidden="true">★</span>{t("circle.youHost")}
      </p>
    ) : (
      <p style={{ margin: "0 0 18px", color: T.muted, fontSize: 14 }}>
        {t("circle.hostedBy", { name: nym(circle.creatorPubkey) })}
      </p>
    )}
    {isCollectionRound && rot!.collector && <p style={{ margin: "0 0 24px", color: T.accent, fontWeight: 700, fontSize: 17 }}>
      {viewerIsCollector ? t("circle.yourPayday") : t("circle.payday", { name: nym(rot!.collector) })}
      <span style={{ color: T.muted, fontWeight: 500 }}> · {t("circle.potPays", { amount: fmtSats(circle.shareMsats * circle.seatThreshold) })}</span>
    </p>}
    <div style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: 30, padding: "clamp(22px,4vw,36px)", textAlign: "center" }}>
      {childrenLoaded
        ? <CircleSeatRing filled={model.seatsLocked} total={model.seatThreshold} potMsats={model.potMsats} targetMsats={circle.shareMsats * model.seatThreshold} />
        : <div className="circle-loader" aria-hidden="true">
            <svg viewBox="0 0 120 120" width="120" height="120">
              <circle className="circle-loader-track" cx="60" cy="60" r="50" fill="none" stroke={T.border} strokeWidth="6" />
              <circle className="circle-loader-arc" cx="60" cy="60" r="50" fill="none" stroke={T.accent} strokeWidth="6" strokeLinecap="round" strokeDasharray="82 232" />
              {[0, 1, 2, 3, 4].map(i => <circle key={i} className="circle-loader-seat" style={{ animationDelay: `${i * 0.22}s` }}
                cx={60 + 50 * Math.cos((i / 5) * 2 * Math.PI - Math.PI / 2)} cy={60 + 50 * Math.sin((i / 5) * 2 * Math.PI - Math.PI / 2)} r="5.5" fill={T.accent} />)}
            </svg>
          </div>}
      <h2 aria-live="polite" style={{ fontSize: "clamp(22px,4vw,30px)", lineHeight: 1.2, marginBottom: 12 }}>{status}</h2>
      <p style={{ color: T.muted, fontFamily: T.mono, lineHeight: 1.6, margin: 0 }}>{t("circle.satsEach", { amount: fmtSats(circle.shareMsats) })}</p>
      {model.status === "filling" && <p style={{ color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginTop: 2 }}>{t("circle.closesIn", { time: circleTimeText(model.secsToFillDeadline, t) })}</p>}
      {model.status === "running" && <p style={{ color: T.accent }}>{t("circle.countdown", { time: circleTimeText(model.secsToRoundEnd, t) })}</p>}
      {(model.move === "returning" || model.move === "return-now") && <p>{t("circle.returning")}</p>}
      {model.move === "collect" && <p style={{ color: T.accent, fontWeight: 700 }}>{t(viewerIsCollector ? "circle.potReady" : "circle.readyCollect")}</p>}
      {viewerIsCollector && model.move === "wait" && model.status === "filling" && <p style={{ color: T.muted }}>{t("circle.sitOut")}</p>}
      {model.refusal && <p>{t(model.refusal === "full" ? "circle.full" : model.refusal === "closed" ? "circle.closed" : model.refusal === "host-waits" ? "circle.hostLocksLast" : "circle.alreadySeated")}</p>}
      {model.status === "complete" && childrenLoaded && <>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,minmax(0,1fr))", gap: 10, margin: "26px 0" }}>
          {[["circle.completedCircles", stats.completed], ["circle.onTime", stats.onTime], ["circle.standing", Math.round(stats.standing).toLocaleString(lang)]].map(([label, value]) => <div key={label} style={{ padding: "16px 4px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 16 }}><strong style={{ display: "block", fontSize: 24 }}>{value}</strong><small style={{ color: T.muted }}>{t(String(label))}</small></div>)}
        </div><h3>{t("circle.nextTitle")}</h3><p style={{ color: T.muted, lineHeight: 1.6 }}>{t("circle.nextBody")}</p>
      </>}
      {action && childrenLoaded && <button type="button" disabled={busy} onClick={() => void run(action)}
        className={model.move === "lock" ? `circle-lock-btn${busy ? " charging" : ""}` : undefined}
        style={{ width: "100%", minHeight: 60, marginTop: 16, border: 0, borderRadius: 999, background: T.accent, color: T.bg, font: `800 18px ${T.sans}`, cursor: busy ? "wait" : "pointer", opacity: busy && model.move !== "lock" ? .6 : 1, position: "relative", overflow: "hidden" }}>{t(moveKey[model.move as keyof typeof moveKey])}</button>}
      {celebrate && <div className="circle-locked-burst" aria-hidden="true"><span /><span /><span />🔒</div>}
      {!childrenLoaded && <button type="button" onClick={() => void run(onRefresh)} disabled={busy}>{t("circle.retry")}</button>}
      {(message || loadError) && <p role="status" style={{ color: T.accent, lineHeight: 1.5 }}>{message ?? loadError}</p>}
    </div>
    {rot !== null && rot.queue.length > 0 && <div style={{ marginTop: 26, background: T.card, border: `1px solid ${T.border}`, borderRadius: 22, padding: "18px 20px" }}>
      <h3 style={{ margin: "0 0 6px", fontSize: 15, color: T.muted, letterSpacing: 1, textTransform: "uppercase" }}>{t("circle.queueTitle")}</h3>
      <p style={{ margin: "0 0 12px", color: T.muted, fontSize: 13, lineHeight: 1.5 }}>{t("circle.raceHint")}</p>
      {rot.queue.map(entry => <div key={entry.roundIndex} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "7px 0" }}>
        <span style={{ color: T.muted, font: `600 12px ${T.mono}`, minWidth: 64 }}>{t("circle.roundN", { n: entry.roundIndex })}</span>
        <strong style={{ flex: 1, fontSize: 15, color: entry.collector ? T.text : T.muted }}>{entry.collector ? nym(entry.collector) : t("circle.queueOpen")}</strong>
        {entry.collector?.toLowerCase() === viewerPubkey.toLowerCase() && <small style={{ color: T.accent, fontFamily: T.mono }}>{t("circle.you")}</small>}
      </div>)}
    </div>}
    {childrenLoaded && shares.some(sh => sh.circleId === circle.circleId) && <div style={{ marginTop: 26, background: T.card, border: `1px solid ${T.border}`, borderRadius: 22, padding: "18px 20px" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 15, color: T.muted, letterSpacing: 1, textTransform: "uppercase" }}>{t("circle.members")}</h3>
      {shares.filter(sh => sh.circleId === circle.circleId)
        .sort((a, b) => (a.lockedAtSec ?? Infinity) - (b.lockedAtSec ?? Infinity))
        .map((sh, index) => {
          const you = sh.memberPubkey.toLowerCase() === viewerPubkey.toLowerCase();
          return <div key={sh.memberPubkey} style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "9px 0", borderTop: index ? `1px solid ${T.border}` : "none" }}>
            <span style={{ color: T.muted, font: `600 12px ${T.mono}`, minWidth: 22 }}>{sh.lockedAtSec !== null ? `#${index + 1}` : "·"}</span>
            <strong style={{ flex: 1, fontSize: 15 }}>{nym(sh.memberPubkey)}{you && <span style={{ color: T.accent, fontWeight: 600 }}> · {t("circle.you")}</span>}{sh.memberPubkey.toLowerCase() === circle.creatorPubkey.toLowerCase() && <span style={{ marginLeft: 7, padding: "2px 7px", borderRadius: 999, background: `${T.purple}22`, color: T.purple, border: `1px solid ${T.purple}55`, font: `700 10px ${T.mono}`, textTransform: "uppercase", letterSpacing: .5 }}>{t("circle.hostBadge")}</span>}</strong>
            <small style={{ color: sh.lockedAtSec !== null ? T.accent : T.muted, fontFamily: T.mono }}>{
              sh.status === "returned" || sh.status === "refunded" || sh.status === "paid" ? t("circle.claimedBadge")
              : sh.readyToClaim ? t("circle.canClaimNow")
              : sh.lockedAtSec !== null ? t("circle.lockedOn", { date: date(sh.lockedAtSec) })
              : t("circle.reservedSeat")}</small>
          </div>;
        })}
    </div>}
    <p style={{ textAlign: "center", color: T.muted, lineHeight: 1.7, fontSize: 13, margin: "22px auto 0", maxWidth: 430 }}>{t("circle.footer")}</p>
  </section>;
}
