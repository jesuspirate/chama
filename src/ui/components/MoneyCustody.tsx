import { federationFacts } from "../../fedimint/federation-inspection.js";
import { useFederationInfo } from "./FederationDisclosure.js";
import { InlineExplanation } from "./InlineExplanation.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";
import { EscrowStatus, NEVER_EXPIRES, type EscrowState } from "../../escrow-engine/types.js";

/** Committed terms only: a pre-lock listing expiry is not the trade deadline. */
export function ecashHoldingPeriod(state: EscrowState): { deadline?: number; seconds?: number } {
  if (state.chamaPolicy || state.parent || state.lock.lockedAt !== null) {
    return state.expiresAt > 0 && state.expiresAt !== NEVER_EXPIRES && Number.isFinite(state.expiresAt) ? { deadline: state.expiresAt } : {};
  }
  const seconds = state.tradeTimeoutSeconds ?? Math.max(1, state.expiresAt - state.createdAt);
  return seconds > 0 && Number.isFinite(seconds) && seconds !== NEVER_EXPIRES ? { seconds } : {};
}
export function EcashCustody({ invite = "", issued = false, trade, warn = false, part = "all" }: { invite?: string; issued?: boolean; trade?: EscrowState; warn?: boolean;
  /** v7 trade room: "warnings" renders only the federation warnings (kept
   *  above a lock), "facts" only the custody facts (moved below it). */
  part?: "all" | "warnings" | "facts" }) {
  const { info, communityInvite } = useFederationInfo(invite);
  const { t, lang } = useT();
  const facts = federationFacts(invite, info, trade?.initiator.pubkey);
  const period = trade ? ecashHoldingPeriod(trade) : {};
  const name = facts.name ?? t("custody.unknown");
  const held = t(facts.guardians === null ? "custody.heldUnknown" : "custody.held", { name, count: facts.guardians ?? "?" });
  const summary = issued ? <>{t("custody.issued", { name })} · {facts.guardians === null ? t("custody.guardiansUnknown") : t("custody.guardians", { count: facts.guardians })}</> : held;
  const unlisted = !!invite && !facts.curated && invite.trim() !== communityInvite?.trim();
  const warnings = <>
    {warn && unlisted && <p data-custody-warning="unlisted" style={{ margin: "4px 0 8px", fontSize: T.fs.warn, fontWeight: 600, color: T.attnInk }}>{t("custody.unlisted")}</p>}
    {warn && facts.singleOperator && <p data-custody-warning="operator" style={{ margin: "4px 0 8px", fontSize: T.fs.warn, fontWeight: 600, color: T.crit }}>{t("custody.operator")}</p>}
  </>;
  if (part === "warnings") return (warn && (unlisted || facts.singleOperator)) ? <div data-money-custody="ecash-warnings" style={{ fontFamily: T.sans, lineHeight: 1.5 }}>{warnings}</div> : null;
  return <div data-money-custody="ecash" style={{ fontFamily: T.sans, lineHeight: 1.5 }}>
    <InlineExplanation summary={summary}>{t(trade ? "custody.tradeExplanation" : "custody.notes")}</InlineExplanation>
    {trade && <div style={{ fontSize: T.fs.secondary, color: T.ink2, marginBottom: 8 }}>
      {t("custody.settlement")} · {period.deadline ? t("custody.deadline", { date: new Date(period.deadline * 1000).toLocaleString(lang) }) : period.seconds ? t("custody.window", { hours: Number((period.seconds / 3600).toFixed(2)) }) : t("custody.deadlineUnknown")}
      {period.seconds && period.seconds > 7 * 86400 && <> · {t("custody.days", { days: Math.ceil(period.seconds / 86400) })}</>}
      {period.deadline && period.deadline - (trade.lock.lockedAt ?? trade.createdAt) > 7 * 86400 && <> · {t("custody.days", { days: Math.ceil((period.deadline - (trade.lock.lockedAt ?? trade.createdAt)) / 86400) })}</>}
    </div>}
    {part === "all" && warnings}
  </div>;
}
export function BitcoinCustody({ refundHeight, settled = false }: { refundHeight?: number | null; settled?: boolean }) {
  const { t } = useT();
  const known = Number.isSafeInteger(refundHeight) && (refundHeight ?? 0) > 0;
  return <div data-money-custody="bitcoin"><InlineExplanation summary={settled ? t("custody.settled") : t(known ? "custody.bitcoin" : "custody.bitcoinUnknown", { height: refundHeight ?? "?" })}>{t("custody.bitcoinExplanation")}</InlineExplanation></div>;
}
export function TradeCustody({ state, warn = false, part = "all" }: { state: EscrowState; warn?: boolean; part?: "all" | "warnings" | "facts" }) {
  if (state.escrowMode === "onchain" && part === "warnings") return null;
  return state.escrowMode === "onchain" ? <BitcoinCustody refundHeight={(state.lock.onchain ?? state.onchainFundingTerms)?.refundLockUntil} settled={state.status === EscrowStatus.COMPLETED} />
    : <EcashCustody key={state.mintUrl} invite={state.mintUrl} trade={state} warn={warn} part={part} />;
}
