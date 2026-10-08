import { walletUri, nativeWalletLinks } from '../../payments/wallet-link.js';
import { PaymentTarget, usePaymentTarget } from './PaymentTarget.js';
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { TradeAmount } from "./TradeAmount.js";
import { QRCode } from "../QRCode.js";
import { PagerPills } from "../screens/tradedetail/PagerPills.js";
import { copyTextRobust, copyTextConfirmed } from "./CopyButton.js";

export type PaymentRail = "lightning" | "onchain" | "ecash";
export type OnchainRailContext =
  | { kind: "bitcoin" }
  | { kind: "deposit"; federation: string; pegInFeeSats?: number; finalityDelay?: number }
  | { kind: "withdrawal"; federation: string; pegOutFeeSats?: number };
const icons = { lightning: "⚡", onchain: "🔗", ecash: "🥜" };
export function PaymentRails({ rail, rails = ["lightning", "onchain", "ecash"], onSelect, disabledReasons, lockedRail, alternativeRailAvailable, onchainContext = {kind:"bitcoin"} }: {
  onchainContext?: OnchainRailContext;
  lockedRail?: PaymentRail;
  alternativeRailAvailable?: boolean;
  disabledReasons?: Partial<Record<PaymentRail, string>>;
  rail: PaymentRail; rails?: PaymentRail[]; onSelect?: (rail: PaymentRail) => void;
}) {
  const { t } = useT();
  const disabled = (r: PaymentRail) => !!disabledReasons?.[r] || !!lockedRail && r !== lockedRail;
  const railLabel = (r: PaymentRail) => r !== "onchain" ? t(`payment.${r}`)
    : onchainContext.kind === "bitcoin" ? t("payment.bitcoin")
    : t(onchainContext.kind === "deposit" ? "payment.deposit" : "payment.onchain");
  const onchainDetail = onchainContext.kind === "bitcoin" ? t("payment.bitcoinHeld")
    : onchainContext.kind === "deposit" ? onchainContext.pegInFeeSats !== undefined && onchainContext.finalityDelay !== undefined
      ? t("payment.depositLine", {federation:onchainContext.federation, fee:onchainContext.pegInFeeSats, confirmations:onchainContext.finalityDelay})
      : t("payment.federationDeposit", {federation:onchainContext.federation}) + " · " + t("fund.checkingOnchainFee")
    : t(onchainContext.pegOutFeeSats !== undefined ? "payment.withdrawalLine" : "payment.withdrawalUnavailable", {fee:onchainContext.kind === "withdrawal" ? onchainContext.pegOutFeeSats ?? 0 : 0});
  return <><PagerPills wrapLabels disabled={rails.map(disabled)} tabIds={rails} tabs={rails.map(railLabel)} icons={rails.map(r => icons[r])}
    active={Math.max(0, rails.indexOf(rail))} chevrons={false} label={t("payment.rail")}
    onSelect={i => { if (!disabled(rails[i])) onSelect?.(rails[i]); }} />
    {rail === "onchain" && <div data-onchain-purpose={onchainContext.kind} style={{fontSize:11, color:T.muted, lineHeight:1.5, marginBottom:6}}>{onchainDetail}</div>}
    {lockedRail && <div style={{ fontSize: 11, color: T.muted, lineHeight: 1.4, marginBottom: 4 }}>{t((alternativeRailAvailable ?? rails.some(r => r !== lockedRail && !disabledReasons?.[r])) ? "fund.railLocked" : "fund.railLockedOnly", { rail: railLabel(lockedRail) })}</div>}
    {rails.filter(r => disabledReasons?.[r]).map(r => <div key={r} style={{ fontSize: 11, color: T.muted, lineHeight: 1.4, marginBottom: 4 }}>{railLabel(r)}: {disabledReasons?.[r]}</div>)}
  </>;
}

export function PaymentButton({ tier = "raised", tone = "accent", style, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & {
  tier?: "primary" | "raised" | "quiet"; tone?: "accent" | "teal";
}) {
  void tone;
  return <><style>{`.payment-button{box-shadow:inset 0 1px 0 #ffffff24,0 1px 0 #0006,0 2px 3px #0003,0 7px 16px #0002;transition:transform .12s,box-shadow .12s}.payment-button:active{transform:translateY(1px);box-shadow:inset 0 1px 0 #ffffff24,0 1px 2px #0003}.payment-button:disabled{box-shadow:none;filter:saturate(0);opacity:.45;cursor:default}.payment-button:focus-visible{outline:2px solid ${T.accent};outline-offset:3px}@media(prefers-reduced-motion:reduce){.payment-button{transition:none}}`}</style><button {...props} type={props.type ?? "button"} className={`payment-button ${props.className ?? ""}`}
    // v7 redesign: primary = the ink money button (60px / 19px on phones);
    // raised = secondary; quiet = text. `tone` is kept for callers but no
    // longer paints a role colour onto a button.
    style={{ ...(tier === "primary" ? { width: "100%" } : {}), background: tier === "primary" ? T.ink : tier === "quiet" ? "transparent" : T.raised,
      color: tier === "primary" ? T.onInk : T.ink, border: tier === "primary" ? "none" : `1px solid ${T.line}`, borderRadius: T.r,
      boxShadow: tier === "primary" ? undefined : "none",
      minHeight: tier === "primary" ? T.size.moneyButton : T.size.touch, padding: "10px 18px",
      fontFamily: T.sans, fontWeight: 600, fontSize: tier === "primary" ? T.fs.moneyButton : T.fs.button, lineHeight: 1.2, cursor: "pointer",
      ...style }} /></>;
}

export function PaymentCopyChip({ value, address = false, uri }: { value: string; address?: boolean; uri?: string }) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const {failed, handlers} = usePaymentTarget(uri ?? (address ? walletUri(value, 'onchain') : undefined), async () => {
    const ok = await copyTextConfirmed(value);
    setCopied(ok); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600);
    return ok;
  });
  const label = value.length > 24 ? `${value.slice(0, address ? 6 : 12)}…${value.slice(address ? -6 : -12)}` : value;
  return <><button {...handlers} type="button" className={`payment-copy ${copied ? "is-copied" : ""}`} title={value}
    aria-label={copied ? t("common.copied") : `${t("common.copy")} ${value}`}
    style={{ position: "relative", isolation: "isolate", overflow: "hidden", width: "100%", minHeight: 44,
      borderRadius: 999, border: `1px solid ${copied ? T.accent : T.borderHi}`, background: T.surface,
      color: copied ? T.accent : T.text, font: `700 11px ${T.mono}`, cursor: "pointer", padding: "10px 12px" }}>
    {!copied && <span aria-hidden="true">⧉ </span>}<span role="status">{copied ? t("common.copied") : label}</span>
  </button>{failed && <div role="status">{failed}</div>}</>;
}

export function OpenWith({ value }: { value: string }) {
  const { t } = useT();
  const [error, setError] = useState("");
  const data = { text: value };
  if (typeof navigator === "undefined" || !navigator.share || !navigator.canShare?.(data)) return null;
  return <><PaymentButton onClick={() => { setError(""); void navigator.share(data).catch(e => {
    if (e?.name !== "AbortError") setError(t("payment.shareFailed"));
  }); }}>{t("payment.openWith")}</PaymentButton>{error && <span role="status">{error}</span>}</>;
}

/** Reserve payment regions while allowing wallet-link feedback to fit below the code. */
export function PaymentCard({ hideRails = false, amountMsats, rail, rails, onRail, data, copyValue, status, helper, details, actions, motion = false, ecash = false, onchainContext }: {
  onchainContext?: OnchainRailContext;
  hideRails?: boolean; amountMsats: number; rail: PaymentRail; rails?: PaymentRail[]; onRail?: (rail: PaymentRail) => void;
  data?: string | string[]; copyValue?: string; status: ReactNode; helper?: ReactNode; details?: ReactNode; actions?: ReactNode;
  motion?: boolean; ecash?: boolean;
}) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(180);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(entries => setSize(Math.max(120, Math.min(240, Math.floor(entries[0].contentRect.width - 44)))));
    observer.observe(ref.current); return () => observer.disconnect();
  }, []);
  const uri = typeof data === 'string' && rail !== 'ecash' ? walletUri(data, rail) : undefined;
  const qr = data ? <QRCode data={data} size={size} logo={motion ? "motion" : "static"} errorCorrectionLevel={ecash ? "L" : "H"} showLogo={!ecash} /> : null;
  return <section ref={ref} className="payment-card" style={{ color: T.text, minWidth: 0, width: "100%", fontFamily: T.sans,
    gridTemplateRows: hideRails ? "64px minmax(284px, auto) 0px 78px 100px auto" : undefined, "--payment-glow": T.accentDim, "--payment-focus": T.accent } as React.CSSProperties}>
    <style>{`
      .payment-card{display:grid;grid-template-rows:64px minmax(284px,auto) minmax(58px,auto) 78px 100px auto}
      .payment-card>*{min-width:0;box-sizing:border-box}
      .payment-button{box-shadow:inset 0 1px 0 #ffffff24,0 1px 0 #0006,0 2px 3px #0003,0 7px 16px #0002;transition:transform .12s,box-shadow .12s}
      .payment-button:active{transform:translateY(1px);box-shadow:inset 0 1px 0 #ffffff24,0 1px 2px #0003}
      .payment-button:disabled{box-shadow:none;filter:saturate(0);opacity:.45;cursor:default}
      .payment-button:focus-visible,.payment-copy:focus-visible,.payment-card button:focus-visible{outline:2px solid var(--payment-focus,#f7931a);outline-offset:3px}
      .payment-copy.is-copied{animation:payment-ring 1.6s ease-out}
      .payment-copy.is-copied:after{content:"";position:absolute;inset:0;background:linear-gradient(110deg,transparent, #ffffff40,transparent);animation:payment-sheen .65s ease-out;pointer-events:none}
      @keyframes payment-sheen{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
      @keyframes payment-ring{0%{box-shadow:0 0 0 0 var(--payment-glow)}55%{box-shadow:0 0 0 9px transparent}100%{box-shadow:none}}
      @media(prefers-reduced-motion:reduce){.payment-card *,.payment-button{animation:none!important;transition:none!important}.payment-copy:after{display:none}}
    `}</style>
    <div style={{ textAlign: "center", alignSelf: "center" }}><TradeAmount msats={amountMsats} size={28} interactive color={T.accent} /></div>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
      {data ? uri ? <PaymentTarget uri={uri} copyValue={copyValue ?? String(data)}>{qr}</PaymentTarget> : qr : actions}
    </div>
    {hideRails ? <div /> : <div><PaymentRails rail={rail} rails={rails ?? [rail]} onSelect={onRail} onchainContext={onchainContext} /></div>}
    <div role="status" style={{ textAlign: "center", alignSelf: "stretch", overflowY: "auto", padding: "10px 4px", fontSize: 12, lineHeight: 1.5 }}>{status}</div>
    <div style={{ display: "grid", gap: 6, alignContent: "start", textAlign: "center", fontSize: 11, color: T.muted }}>
      {copyValue && <PaymentCopyChip value={copyValue} address={rail === "onchain"} uri={uri} />}<div style={{ maxHeight: 50, overflowY: "auto", lineHeight: 1.5 }}>{helper}</div>
    </div>
    <div style={{ display: "grid", gap: 10, paddingTop: 8 }}>
      {!nativeWalletLinks() && data && typeof data === "string" && <OpenWith value={data} />}{data && actions}
      {details && <details><summary style={{ minHeight: 44, cursor: "pointer", paddingTop: 12 }}>{t("payment.details")}</summary><div style={{ fontSize: 12, lineHeight: 1.6, overflowWrap: "anywhere" }}>{details}</div></details>}
    </div>
  </section>;
}
