import { ProfileAvatar } from "./ProfileAvatar.js";
import type { ArbiterRecord } from '../../arbiters/record.js';
import { useT } from '../../i18n/index.js';
import { profileNameFor, type NostrProfileNameMap } from '../nostr-profiles.js';
import { T } from '../theme.js';
export function ArbiterRecordCard({ record, expanded = false, profileNames, kind0Enabled = false }: { record: ArbiterRecord; expanded?: boolean; profileNames?: NostrProfileNameMap; kind0Enabled?: boolean }) {
  const { t, lang } = useT();
  const name = profileNameFor(profileNames, record.pubkey, kind0Enabled) ?? "…";
  const hours = record.medianResponseSec == null ? null : Math.max(1, Math.ceil(record.medianResponseSec / 3600));
  const latency = hours == null ? "—" : hours < 24 ? t("trade.responseHours", { count: hours }) : t("trade.responseDays", { count: Math.ceil(hours / 24) });
  const days = record.lastSeen == null ? null : Math.max(0, Math.floor((Date.now() / 1000 - record.lastSeen) / 86400));
  const seen = days == null ? "—" : new Intl.RelativeTimeFormat(lang, { numeric: "auto" }).format(days >= 7 ? -Math.floor(days / 7) : -days, days >= 7 ? "week" : "day");
  return <details open={expanded || undefined} style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, margin: '12px 0', color: T.text }}>
    <summary style={{ cursor: 'pointer', color: record.bondSats === 0n ? T.amber : T.text }}>
      <ProfileAvatar pubkey={record.pubkey} fallback={null} size={24} /> {record.bondSats === 0n
        ? t("trade.arbiterNoStake", { name })
        : t("trade.arbiterVerdict", { name, amount: record.bondSats.toLocaleString(), count: record.disputes })}
      {hours != null && <> {t("trade.arbiterResponse", { time: latency })}</>}
      <div style={{ fontSize: 11, color: T.muted }}>{t("trade.deviceSample")}</div>
    </summary>
    <p>{t('trade.arbiterRecordStats', { healings: record.healings, disputes: record.disputes,
      latency, tenure: record.tenureBlocks ?? '—', seen })}</p>
    <p>{t('trade.arbiterConduct')}</p>
    <p>{t('trade.arbiterRecordLiveness', { count: record.liveness?.arbiterCount ?? "—" })}</p>
    <p>{t('trade.arbiterRecordSample', { count: record.observedTrades,
      rulings: record.concentration.rulings, top: record.concentration.byBeneficiary[0]?.count ?? 0 })}</p>
  </details>;
}
