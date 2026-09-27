import { ConductFacts } from "./ConductFacts.js";
import { ProfileAvatar } from "./ProfileAvatar.js";
import type { ArbiterRecord } from '../../arbiters/record.js';
import { useT } from '../../i18n/index.js';
import { profileNameFor, type NostrProfileNameMap } from '../nostr-profiles.js';
import { T } from '../theme.js';
export function ArbiterRecordCard({ record, profileNames, kind0Enabled = false }: { record: ArbiterRecord; expanded?: boolean; profileNames?: NostrProfileNameMap; kind0Enabled?: boolean }) {
  const { t } = useT();
  const name = profileNameFor(profileNames, record.pubkey, kind0Enabled) ?? "…";
  // A partial local trade history cannot support a shared reputation claim.
  // Only the independently verified, funded and active bond is shown here.
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, margin: '12px 0',
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: record.bondSats === 0n ? T.muted : T.text }}>
    <ConductFacts pubkey={record.pubkey} showEmpty />
    <ProfileAvatar pubkey={record.pubkey} fallback={null} size={24} />
    <span>{record.bondSats === 0n
      ? t("trade.arbiterNoStake", { name })
      : t("trade.arbiterVerdict", { name, amount: record.bondSats.toLocaleString() })}</span>
  </div>;
}
