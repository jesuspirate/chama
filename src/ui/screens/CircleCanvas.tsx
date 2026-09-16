import { useState } from "react";
import { isSimModeOn } from "../../sim/simMode.js";
import type { CircleRound } from "../../chama/types.js";
import { DEFAULT_ROUND_SEC } from "../../chama/types.js";
import { circleCanvasRound, circleCanvasErrors } from "../../chama/canvas.js";
import { Back, QuestionCard, Primary, headingStyle, subStyle, reviewStyle, canvasCss } from "./AssistedCanvas.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { useBitcoinPrice } from "../hooks/useBitcoinPrice.js";
import { useFiatRates } from "../hooks/useFiatRates.js";
import { formatEstimatedFiatForMsats } from "../amount-display.js";
import { defaultCurrencyForCommunity } from "../../communities/currency.js";

export function CircleCanvas({ viewerPubkey, community, mintUrl, initial, onBack, onPublish }: {
  viewerPubkey: string; community: string; mintUrl: string; initial?: CircleRound;
  onBack: () => void; onPublish: (round: CircleRound) => Promise<void>;
}) {
  const { t, lang } = useT();
  const price = useBitcoinPrice(), rates = useFiatRates();
  const [step, setStep] = useState(0);
  const [sats, setSats] = useState(String(initial ? initial.shareMsats / 1000 : 10000));
  const [threshold, setThreshold] = useState(initial?.seatThreshold ?? 5);
  // Jet's audience split (2026-09-15): the old screen asked a MARKET question
  // (floor + ceiling) when the human question is WHO IS THIS FOR. "Just us"
  // collapses both numbers into one — everyone must lock, seats = the group,
  // shared by link, unlisted. "Anyone" keeps only the floor and stays open.
  const [audience, setAudience] = useState<"friends" | "anyone">(
    initial ? (initial.unlisted || initial.seatCap === initial.seatThreshold ? "friends" : "anyone") : "friends");
  const cap = audience === "friends" ? threshold : null;
  const [duration, setDuration] = useState(initial ? initial.roundEndSec - initial.createdAt : DEFAULT_ROUND_SEC);
  // The circle's IDENTITY (Jet, completion night: three circles all named
  // "Your Circle" made My Trades a guessing game). Empty falls back to the
  // default; a re-formed round inherits its lineage's name.
  const [name, setName] = useState(initial?.name ?? "");
  const [createdAt] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const round = circleCanvasRound({ shareSats: Number(sats), threshold, cap, durationSec: duration, createdAt,
    unlisted: audience === "friends",
    creatorPubkey: viewerPubkey, community, mintUrl, name: name.trim() || t("circle.defaultName"), previous: initial });
  const validAmount = Number.isSafeInteger(Number(sats)) && Number(sats) > 0;
  const validSeats = Number.isSafeInteger(threshold) && threshold >= 2;
  const date = (at: number) => new Date(at * 1000).toLocaleDateString(lang, { weekday: "short", month: "short", day: "numeric" });
  const quote = formatEstimatedFiatForMsats({ amountMsats: round.shareMsats, currency: defaultCurrencyForCommunity(community), usdPerBtc: price.usd, usdFiatRates: rates.rates });
  const publish = async () => { if (busy) return; setBusy(true); setError(null); try { await onPublish(round); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  const titles = ["circle.amountQuestion", "circle.seatsQuestion", "circle.endQuestion", "circle.reviewQuestion"];
  return <section className="assisted-canvas circle-canvas" aria-label={t("circle.createTitle")}>
    <style>{canvasCss()}{circleCss()}</style>
    <div className="assisted-canvas-main">
      <Back onClick={step ? () => setStep(step - 1) : onBack}>{t("common.back")}</Back>
      <div className="circle-eyebrow"><VerticalIcon vertical="chama" size={32} />{t("circle.createTitle")}</div>
      <h1 style={headingStyle()}>{t(titles[step])}</h1>
      {step === 0 && <><p style={subStyle()}>{t("circle.equalShares")}</p><QuestionCard>
        <div className="circle-chips">{[5000, 10000, 25000].map(n => <button key={n} type="button" aria-pressed={Number(sats) === n} onClick={() => setSats(String(n))}>{n / 1000}k</button>)}<button type="button" onClick={() => document.getElementById("circle-amount")?.focus()}>{t("circle.custom")}</button></div>
        <label className="circle-amount"><input id="circle-amount" aria-label={t("circle.amountQuestion")} inputMode="numeric" value={sats} onChange={e => setSats(e.target.value.replace(/[^0-9]/g, ""))} /><span>{t("circle.sats")}</span></label>
        <p className="circle-muted">{quote ?? t("circle.quoteUnavailable")}</p>
        {/* Tiny-share guidance (ui-wiring-spec §5 ruling): no protocol floor —
            the 1-sat funding floor stands and testing stays possible — but
            fill-or-refund means a failed circle pays fees BOTH ways, so a
            dust share can cost more than it holds. Soft warning, never a
            block. */}
        {validAmount && Number(sats) < 1000 && (
          <p className="circle-muted" style={{ color: T.amber }}>{t("circle.tinyShare")}</p>
        )}
        {!validAmount && <p role="alert">{t("circle.amountError")}</p>}
      </QuestionCard></>}
      {step === 1 && <><p style={subStyle()}>{t("circle.thresholdWhy")}</p><QuestionCard>
        {/* One human question — WHO is this circle for — instead of the old
            floor-and-ceiling tangle (Jet, 2026-09-15: "why are we making
            things so weirdly close to each other?"). "Just us" makes the two
            numbers ONE: everyone must lock, seats = the group, invite-link
            only. "Anyone" keeps only the go-ahead floor and stays open. */}
        <p className="circle-caption">{t("circle.whoFor")}</p>
        <div className="circle-chips">
          <button type="button" aria-pressed={audience === "friends"} onClick={() => setAudience("friends")}>{t("circle.justUs")}</button>
          <button type="button" aria-pressed={audience === "anyone"} onClick={() => setAudience("anyone")}>{t("circle.anyoneJoin")}</button>
        </div>
        <p className="circle-caption">{t(audience === "friends" ? "circle.groupSize" : "circle.minCaption")}</p>
        <div className="circle-stepper"><button type="button" aria-label={t("circle.fewer")} disabled={threshold <= 2} onClick={() => setThreshold(n => n - 1)}>−</button><output aria-live="polite">{threshold}</output><button type="button" aria-label={t("circle.more")} onClick={() => setThreshold(n => n + 1)}>+</button></div>
        <p className="circle-muted">{audience === "friends"
          ? t("circle.privateNote", { count: threshold })
          : t("circle.publicNote", { count: threshold })}</p>
      </QuestionCard></>}
      {step === 2 && <><p style={subStyle()}>{t("circle.twoWeekBound")}</p><QuestionCard>
        <div className="circle-chips">{[7, 14].map(days => <button type="button" key={days} aria-pressed={duration === days * 86400} onClick={() => setDuration(days * 86400)}>{t(days === 7 ? "circle.oneWeek" : "circle.twoWeeks")}</button>)}{isSimModeOn() && <button type="button" aria-pressed={duration === 300} onClick={() => setDuration(300)}>{t("circle.testDrive")}</button>}</div>
        <h2>{t("circle.backBy", { date: date(round.roundEndSec) })}</h2><p className="circle-muted">{t("circle.closesDate", { date: date(round.fillDeadlineSec) })}</p>
      </QuestionCard></>}
      {step === 3 && <div style={reviewStyle()}>
        <label className="circle-name">
          <span className="circle-caption">{t("circle.nameLabel")}</span>
          <input value={name} placeholder={t("circle.defaultName")} maxLength={48}
            onChange={e => setName(e.target.value)} aria-label={t("circle.nameLabel")} />
        </label>
        <dl className="circle-review">
        <div><dt>{t("circle.share")}</dt><dd>{t("circle.satsEach", { amount: Number(sats).toLocaleString(lang) })}</dd></div>
        <div><dt>{t("circle.people")}</dt><dd>{threshold}{audience === "friends" ? ` · ${t("circle.justUs")}` : ` · ${t("circle.openAnyone")}`}</dd></div>
        <div><dt>{t("circle.whoFor")}</dt><dd>{audience === "friends" ? t("circle.byInvite") : t("circle.listedBrowse")}</dd></div>
        <div><dt>{t("circle.fillsBy")}</dt><dd>{date(round.fillDeadlineSec)}</dd></div><div><dt>{t("circle.returnDate")}</dt><dd>{date(round.roundEndSec)}</dd></div>
      </dl><p>{t("circle.promise", { date: date(round.fillDeadlineSec) })}</p><p className="circle-host-note">{t("circle.hostNote")}</p></div>}
      {error && <p role="alert" style={{ color: T.red }}>{error}</p>}
      <div style={{ margin: "clamp(12px, 2.6vh, 24px) 0" }}><Primary disabled={busy || !validAmount || !validSeats || (step === 3 && circleCanvasErrors(round).length > 0)} onClick={step === 3 ? () => void publish() : () => setStep(step + 1)}>{t(busy ? "circle.publishing" : step === 3 ? "circle.openCircle" : "circle.continue")}</Primary></div>
    </div>
    <footer className="assisted-canvas-footer"><span>{t("circle.noMoneyYet")}</span><div aria-label={t("circle.step", { current: step + 1, total: 4 })}>{titles.map((key, i) => <span key={key} className={i === step ? "on" : ""} />)}</div><small>{step + 1} / 4</small></footer>
  </section>;
}

export function circleCss() { return `
.circle-canvas{min-height:calc(100dvh - 210px)}
.circle-caption{margin:0 0 6px;}.circle-chips+.circle-caption{margin-top:clamp(18px,3vh,30px)}
.circle-caption{color:${T.muted};font:700 10px/1.4 ${T.mono};letter-spacing:.14em;text-transform:uppercase}.circle-eyebrow{display:flex;align-items:center;gap:10px;color:${T.accent};font:700 11px ${T.mono};letter-spacing:.14em;text-transform:uppercase}
.circle-chips{display:flex;flex-wrap:wrap;gap:10px}.circle-chips button,.circle-stepper button{padding:12px 22px;min-height:46px;border-radius:999px;border:1px solid ${T.borderHi};background:${T.bg};color:${T.text};font:700 15px ${T.sans};cursor:pointer}.circle-chips button[aria-pressed=true]{background:${T.accentDim};border-color:${T.accent};color:${T.accent}}
.circle-amount{display:flex;align-items:baseline;gap:14px;margin-top:clamp(12px,2.4vh,22px);border-bottom:2px dashed ${T.muted};padding-bottom:12px}.circle-amount input{width:100%;min-width:0;background:none;border:0;color:${T.text};font:650 clamp(36px,7vw,64px) ${T.sans};outline:none}.circle-amount span,.circle-muted{color:${T.muted};font-family:${T.mono};line-height:1.6}.circle-amount:focus-within{border-color:${T.accent}}
.circle-stepper{display:flex;align-items:center;justify-content:center;gap:32px;margin:clamp(4px,1vh,8px) 0 clamp(14px,3vh,30px)}.circle-stepper output{font:650 clamp(44px,7vh,64px) ${T.sans}}.circle-stepper button:disabled{opacity:.4}.circle-cap{display:flex;align-items:center;gap:14px;margin-top:20px}.circle-cap input{width:90px;padding:10px;border:1px solid ${T.borderHi};border-radius:10px;background:${T.bg};color:${T.text};font:600 20px ${T.sans}}
.circle-name{display:block;margin-bottom:clamp(10px,1.8vh,16px)}.circle-name input{width:100%;padding:12px 14px;border:1px solid ${T.borderHi};border-radius:12px;background:${T.bg};color:${T.text};font:650 20px ${T.sans};outline:none}.circle-name input:focus{border-color:${T.accent}}
.circle-review{margin:0}.circle-review div{display:flex;justify-content:space-between;gap:24px;padding:clamp(9px,1.6vh,14px) 0;border-bottom:1px solid ${T.border}}.circle-review dt{color:${T.muted}}.circle-review dd{margin:0;text-align:right;font-weight:700}.circle-host-note{color:${T.muted};font-size:13px;line-height:1.6;padding-top:10px}.circle-canvas button:focus-visible{outline:3px solid ${T.accent};outline-offset:3px}
@media(max-width:600px){.circle-canvas{padding:22px 18px 16px}.circle-canvas .assisted-canvas-footer{grid-template-columns:1fr auto}.circle-canvas .assisted-canvas-footer small{display:none}}
`; }
