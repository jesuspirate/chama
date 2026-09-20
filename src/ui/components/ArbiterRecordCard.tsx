import { ProfileAvatar } from "./ProfileAvatar.js";
import type { ArbiterRecord } from '../../arbiters/record.js';
import { useT } from '../../i18n/index.js';
import { profileNameFor } from '../nostr-profiles.js';
import { T } from '../theme.js';
export function ArbiterRecordCard({ record, expanded = false }: { record: ArbiterRecord; expanded?: boolean }) {
  const { t } = useT();
  return <details open={expanded || undefined} style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, margin: '12px 0', color: T.text }}>
    <summary style={{ cursor: 'pointer' }}><ProfileAvatar pubkey={record.pubkey} fallback={null} size={24} /> {t('trade.arbiterRecord')} · {profileNameFor(undefined, record.pubkey, false)} · {record.bondSats.toString()} sats
    <div>{t('trade.arbiterRecordStats', { healings: record.healings, disputes: record.disputes,
      latency: record.medianResponseSec == null ? '—' : `${Math.round(record.medianResponseSec / 60)} min`,
      tenure: record.tenureBlocks ?? '—', seen: record.lastSeen == null ? '—' : new Date(record.lastSeen * 1000).toLocaleString() })}</div></summary>
    <p>{t('trade.arbiterConduct')}</p>
    <p>{t('trade.arbiterRecordLiveness', { count: record.liveness?.arbiterCount ?? "—" })}</p>
    <p>{t('trade.arbiterRecordSample', { count: record.observedTrades,
      rulings: record.concentration.rulings, top: record.concentration.byBeneficiary[0]?.count ?? 0 })}</p>
  </details>;
}
