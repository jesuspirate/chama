import { getCommunityBySlug } from "../../communities/registry.js";
import { COUNTRY_ISO3 } from "../../communities/geography-data.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";

/** Navigation to the single community switcher; never changes a wallet. */
export function CommunityChip({ slug, onOpen }: { slug: string; onOpen?: () => void }) {
  const { t } = useT();
  const community = getCommunityBySlug(slug);
  if (!community || !onOpen) return null;
  const code = community.country ? COUNTRY_ISO3[community.country] ?? community.country : t("me.globalRegion");
  return <button type="button" data-community-chip onClick={onOpen}
    aria-label={t("browse.openCommunity", { chama: community.displayName })} title={community.displayName}
    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 10px", minHeight: 36,
      borderRadius: 999, background: T.surface, border: `1px solid ${T.border}`, color: T.text,
      font: `600 11px ${T.mono}`, cursor: "pointer", flexShrink: 0 }}>
    <span aria-hidden="true" style={{ fontSize: 16 }}>{community.flagEmoji}</span><span>{code}</span>
  </button>;
}
