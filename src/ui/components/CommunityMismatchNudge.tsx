import { useEffect, useState } from "react";
import { timezoneMismatchCountry, timezoneNudgeSeen, markTimezoneNudgeSeen } from "../../communities/timezone-nudge.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { countryName, getAllPickerCountries } from "../../communities/countries.js";
import { COUNTRY_ISO3 } from "../../communities/geography-data.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";

export function CommunityMismatchNudge({ slug, suppressed, onOpen }: {
  slug: string; suppressed?: boolean; onOpen: (country: string) => void;
}) {
  const { t, lang } = useT();
  const [country, setCountry] = useState(() => {
    if (suppressed || timezoneNudgeSeen(slug)) return null;
    const code = timezoneMismatchCountry(slug);
    return code && getAllPickerCountries().some(c => c.code === code) ? code : null;
  });
  useEffect(() => { if (country && !suppressed) markTimezoneNudgeSeen(slug); }, [country, slug, suppressed]);
  if (!country || suppressed) return null;
  const current = getCommunityBySlug(slug)?.country;
  const dismiss = () => { markTimezoneNudgeSeen(slug); setCountry(null); };
  return <div data-community-nudge style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
    marginBottom: 16, padding: "10px 12px", border: `1px solid ${T.border}`, borderRadius: T.rs,
    color: T.muted, font: `12px ${T.sans}`, lineHeight: 1.5 }}>
    <span style={{ flex: "1 1 220px" }}>{t("browse.timezoneMismatch", {
      current: current ? COUNTRY_ISO3[current] ?? current : "", detected: countryName(country, lang),
    })}</span>
    <div style={{ display: "flex", alignItems: "center", gap: 12, marginLeft: "auto" }}>
    <button type="button" data-community-nudge-switch onClick={() => { dismiss(); onOpen(country); }}
      style={{ background: T.accentDim, border: `1px solid ${T.accent}`, color: T.accent,
        borderRadius: 999, padding: "7px 12px", cursor: "pointer", font: `600 12px ${T.sans}` }}>{t("me.switch")}</button>
    <button type="button" data-community-nudge-dismiss onClick={dismiss}
      style={{ background: "none", border: "none", color: T.muted, padding: "7px 4px", cursor: "pointer", font: `12px ${T.sans}` }}>{t("browse.notNow")}</button>
    </div>
  </div>;
}
