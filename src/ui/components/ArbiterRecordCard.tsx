import { ConductFacts } from "./ConductFacts.js";
import { ProfileAvatar } from "./ProfileAvatar.js";
import type { ArbiterRecord } from '../../arbiters/record.js';
import { useT } from '../../i18n/index.js';
import { generatedNameFor, profileNameFor, type NostrProfileNameMap } from '../nostr-profiles.js';
import { T } from '../theme.js';
export function ArbiterRecordCard({ record, profileNames, kind0Enabled = false, bondsKnown = true }: { record: ArbiterRecord; bondsKnown?: boolean; expanded?: boolean; profileNames?: NostrProfileNameMap; kind0Enabled?: boolean }) {
  const { t, lang } = useT();
  const name = profileNameFor(profileNames, record.pubkey, kind0Enabled, lang) ?? generatedNameFor(record.pubkey,lang);
  // A partial local trade history cannot support a shared reputation claim.
  // Only the independently verified, funded and active bond is shown here.
  return <div style={{ border: `1px solid ${T.border}`, borderRadius: 12, padding: 12, margin: '12px 0',
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: record.bondSats === 0n ? T.muted : T.text }}>
    <ConductFacts pubkey={record.pubkey} showEmpty />
    <ProfileAvatar pubkey={record.pubkey} fallback={null} size={24} />
    <span>{!bondsKnown ? t("circle.bondUnknown") : record.bondSats === 0n
      ? t("trade.arbiterNoStake", { name })
      : t("trade.arbiterVerdict", { name, amount: record.bondSats.toLocaleString() })}</span>
    {record.bondTerms.map(b => <small key={b.address} style={{display:"block",flexBasis:"100%"}}>{t("circle.bondTerm", {amount:b.sats.toLocaleString(),block:b.lockUntil.toLocaleString()})}</small>)}
  </div>;
}
