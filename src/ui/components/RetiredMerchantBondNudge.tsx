import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";

/** Display only: the signed opt-out remains authoritative until re-announced.
 * Callers supply the reader's current, verified announcements, never local drafts. */
export function RetiredMerchantBondNudge({ bonds, owner }: {
  bonds: readonly VerifiedBond[];
  owner: string;
}) {
  const { t } = useT();
  const latest = bonds.filter(b => b.npub.toLowerCase() === owner.toLowerCase())
    .sort((a, b) => (b.announcedAt ?? 0) - (a.announcedAt ?? 0))[0];
  if (!latest?.roles?.includes("merchant") || latest.roles.includes("arbiter")) return null;
  return <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 10 }}>
    {t("bond.merchantRetired")}
  </div>;
}
