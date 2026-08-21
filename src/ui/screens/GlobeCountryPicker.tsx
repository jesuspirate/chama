import { useEffect, useMemo, useState, type ReactNode } from "react";
import { T } from "../theme.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { GlobeHero } from "../components/GlobeHero.js";
import { LivenessSignal } from "../components/LivenessSignal.js";
import { loadCoordinatedLiveness, type LivenessGenerationDiagnostic } from "../../arbiters/liveness-coordinator.js";
import { LanguagePills } from "../components/LanguagePills.js";
import { useT } from "../../i18n/index.js";
import type { ChamaLiveness } from "../../arbiters/live-chama.js";
import {
  getAllPickerCountries,
  GLOBE_MARKERS,
  type PickerCountry,
} from "../../communities/countries.js";
import {
  DEFAULT_COMMUNITY_SLUG,
  addCustomCommunity,
  getCommunityBySlug,
  isRealLocalChama,
} from "../../communities/registry.js";

// v2.6 / v4.1 "US-activation": the full-world "Hey Chama, where's home?" picker
// (PHILOSOPHY.md §6). A spinning globe hero + a searchable, full-world country
// list. Every country is tappable and lands on its OWN flag + currency + fed.
//
// NEVER-DARK RULE (the anchor — the old "no local Chama, an arbiter would be a
// stranger" dark landing nearly cost a real first trader). Never make a visitor
// feel they're standing in the dark. Every covered country reads green ("you can
// trade here today"); only a genuinely-uncovered "comingSoon" recedes — never red.
//   • ✓ covered (green) — trade today, backed by Chama's arbiters. Effectively
//                everywhere. NEVER claims elected local arbiters by fiat.
//   • Coming soon (quiet, rare — still not red) — genuinely uncovered feds.
// NO hardcoded "Live" tier: liveness is EARNED, shown as the computed 🛡 bonded-
// arbiter count (loadBondedCounts) — never a baked-in badge that blessed Kenya as
// special when it wasn't true. Kenya lists like any country; its 🛡 count is real.
//
// The arbiter / "run your country's Chama" on-ramp moved OUT of onboarding to
// the blue Listings FAB (ArbiterApplyForm) — a leader pitch belongs where a
// self-selecting leader looks, not in every newcomer's first 10 seconds.
//
// i18n (Session A): language pills live HERE — language pairs naturally with
// picking a country, and this is the first screen a fresh npub meets.

// Derive the user's OWN country from the device locale (privacy-clean: no
// geo-IP, no network call — just navigator.language(s)'s region subtag). We
// feature THAT one country, never a hardcoded VIP list: a fixed set reads as
// arbitrary and re-creates the exact "is *my* country in?" anxiety the green
// tiers exist to kill. "en-US" → US, "pt-BR" → BR, "zh-Hant-TW" → TW.
function localeCountryCode(): string | null {
  try {
    const nav = typeof navigator !== "undefined" ? navigator : null;
    if (!nav) return null;
    const tags = (nav.languages && nav.languages.length ? nav.languages : [nav.language])
      .filter(Boolean) as string[];
    for (const tag of tags) {
      const parts = tag.split("-");
      // Region is the last 2-letter subtag (after script/variants).
      for (let i = parts.length - 1; i >= 1; i--) {
        if (/^[A-Za-z]{2}$/.test(parts[i]!)) return parts[i]!.toUpperCase();
      }
    }
  } catch {
    /* older webview without navigator.languages — no featuring, picker still works */
  }
  return null;
}

export function GlobeCountryPicker({ onSelect, loadLiveness, loadBondedCounts, livenessBlocksPerDay = 144 }: {
  onSelect: (slug: string) => void;
  /** Optional: compute a community's chain-verified liveness (getChamaLiveness).
   *  Absent during pre-signer onboarding (no connected client) — the detail screen
   *  then falls back to the "trade today" reassurance, never a dark landing. When a
   *  caller CAN fetch (post-connect re-pick), the graduated signal renders for real. */
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  /** Optional: ONE batched per-community bonded-arbiter count (slug → count of
   *  chain-verified funded+active bonds; fetchBondedArbiterCounts). ADDITIVE over
   *  the registry tiers: rows with real bonds gain a "🛡 N bonded" note, rows
   *  without lose nothing — the computed signal can only light up, never darken.
   *  Fails soft; absent (pre-signer callers) the registry tiers stand alone. */
  loadBondedCounts?: () => Promise<Record<string, number>>;
  /** Blocks/day for the liveness "~D-day" term readout (signet ~2880, mainnet ~144). */
  livenessBlocksPerDay?: number;
}) {
  const { t } = useT();
  const countries = useMemo(() => getAllPickerCountries(), []);
  // The user's own country, featured at the top (locale-derived, privacy-clean).
  // No hardcoded "Live" tier any more — liveness is EARNED from bonds (the
  // computed 🛡 count), never a baked-in badge — so every country lists equally;
  // the home country just gets a gentle head-start. Null when locale is unknown.
  const homeCountry = useMemo(() => {
    const code = localeCountryCode();
    if (!code) return null;
    return countries.find((x) => x.code === code) ?? null;
  }, [countries]);
  const featuredCodes = useMemo(
    () => new Set(homeCountry ? [homeCountry.code] : []),
    [homeCountry],
  );
  // The full searchable world, minus the featured home-country row (no dupes).
  const restCountries = useMemo(
    () => countries.filter((c) => !featuredCodes.has(c.code)),
    [countries, featuredCodes],
  );

  const [query, setQuery] = useState("");
  // The header mark is tiny and decodes almost instantly; the globe is a much
  // larger asset. Hold the main picker's first visible paint until the globe
  // has decoded so onboarding arrives as one composed surface instead of a
  // logo-first / globe-later flash. The timeout fails open if an embedded
  // webview reports neither load nor error.
  const [globeArtworkReady, setGlobeArtworkReady] = useState(false);
  // A country opened for disambiguation (≥2 chamas) or the green landing.
  const [selected, setSelected] = useState<PickerCountry | null>(null);
  // Chain-verified liveness for the opened single-community landing (best-effort).
  const [liveness, setLiveness] = useState<ChamaLiveness | null>(null);
  const [livenessLoading, setLivenessLoading] = useState(false);
  const [livenessOutcome, setLivenessOutcome] = useState<LivenessGenerationDiagnostic["outcome"] | null>(null);

  // The batched list signal: slug → chain-verified bonded-arbiter count.
  // Fetched once per mount, fail-soft (null ⇒ registry tiers stand alone).
  const [bondedBySlug, setBondedBySlug] = useState<Record<string, number> | null>(null);
  useEffect(() => {
    if (!loadBondedCounts) return;
    let cancelled = false;
    loadBondedCounts()
      .then((r) => { if (!cancelled) setBondedBySlug(r); })
      .catch(() => { /* fail-soft — the list never darkens for a failed read */ });
    return () => { cancelled = true; };
    // Fire once per mount — the prop is a fresh identity each render but reads
    // the live client internally, so a stale closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A country's note sums its chamas' counts (an arbiter bonded in two chamas of
  // one country counts per chama — the per-chama truth lives on the detail view).
  const bondedForCountry = (c: PickerCountry): number => {
    if (!bondedBySlug) return 0;
    const slugs = new Set<string>([...c.chamas.map((x) => x.slug), c.defaultCommunity.slug]);
    let n = 0;
    for (const s of slugs) n += bondedBySlug[s] ?? 0;
    return n;
  };

  // Fetch liveness once, when a SINGLE-community country is opened and a fetcher
  // is wired. Multi-chama countries disambiguate first (per-chama liveness is a
  // later pass). Fails soft — a null/throw just leaves the reassurance standing.
  useEffect(() => {
    setLiveness(null);
    if (!selected || !loadLiveness || selected.chamas.length >= 2) return;
    const slug = selected.defaultCommunity.slug;
    let cancelled = false;
    setLivenessLoading(true);
    loadCoordinatedLiveness(slug, (community, signal) => loadLiveness(community, signal))
      .then((result) => {
        if (!cancelled) {
          setLiveness(result.liveness);
          setLivenessOutcome(result.outcome);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLiveness(null);
          setLivenessOutcome("error");
        }
      })
      .finally(() => { if (!cancelled) setLivenessLoading(false); });
    return () => { cancelled = true; };
    // Key off the opened country only — `loadLiveness` is a fresh identity each
    // render (reads the live client internally), so a stale closure is fine.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const q = query.trim().toLowerCase();
  const results = q
    ? countries.filter(
        (c) => c.name.toLowerCase().includes(q) || c.code.toLowerCase() === q,
      )
    : [];

  const openCountry = (c: PickerCountry) => {
    // N-chama drill-down: ≥2 named chamas (real OR available) → disambiguate,
    // exactly Kenya's path, now for any country. A single REAL local chama
    // opens straight through; a single available chama / bare shell lands on
    // the green "Available now" screen (one tap to Continue).
    if (c.chamas.length >= 2) {
      setSelected(c);
      return;
    }
    if (c.realChamas.length === 1) {
      onSelect(c.realChamas[0]!.slug);
      return;
    }
    setSelected(c);
  };

  // Land on a country's default community (its flag + currency on a default
  // federation). A generated shell isn't in the pre-seed registry, so persist
  // it (addCustomCommunity) before selecting so getCommunityBySlug resolves it
  // downstream; on any persistence failure, fall back to Global · USD so the
  // user is never stuck on the picker.
  const selectDefault = (c: PickerCountry) => {
    const dc = c.defaultCommunity;
    try {
      if (c.isGeneratedShell && !getCommunityBySlug(dc.slug) && dc.federationInvite) {
        addCustomCommunity({
          slug: dc.slug,
          displayName: dc.displayName,
          currency: dc.currency,
          country: dc.country,
          flagEmoji: dc.flagEmoji,
          federationInvite: dc.federationInvite,
          browserReliable: dc.browserReliable,
          languages: dc.languages,
          disambiguator: dc.disambiguator,
        });
      }
      onSelect(dc.slug);
    } catch {
      onSelect(DEFAULT_COMMUNITY_SLUG);
    }
  };

  const backToList = () => setSelected(null);

  // ── Country detail: N-chama disambiguation (≥2 chamas) or the green landing ──
  if (selected) {
    const multi = selected.chamas.length >= 2;
    const comingSoon = selected.availability === "comingSoon";
    return (
      <>
        <BrandHeader />
        <BackButton label={t("picker.allCountries")} onClick={backToList} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, width: "100%", maxWidth: 380 }}>
          <span style={{ fontSize: 34, lineHeight: 1 }}>{selected.flag}</span>
          <div style={{ textAlign: "left" }}>
            <div style={{ fontSize: 22, fontWeight: 900, color: T.text, fontFamily: T.sans, lineHeight: 1.1 }}>
              {selected.name}
            </div>
            <div style={{ fontSize: 11, color: multi ? T.muted : T.green, fontFamily: T.mono, marginTop: 2 }}>
              {multi
                ? t("picker.chooseYourChama")
                : comingSoon
                  ? t("picker.subComingSoon", { currency: selected.currency })
                  : t("picker.subAvailableNow", { currency: selected.currency })}
            </div>
          </div>
        </div>

        {multi ? (
          // The N-chama drill-down — all named chamas for the country, each
          // tier-tagged: a real elected-local Chama reads ⚡ "live local Chama";
          // a native-verified one reads ✓ "available now" (honest — no false
          // local-arbiter claim). Same path Kenya already uses, now for any N.
          <div style={{ display: "grid", gap: 10, width: "100%", maxWidth: 380 }}>
            {selected.chamas.map((c) => {
              const real = isRealLocalChama(c);
              return (
              <button
                key={c.slug}
                onClick={() => onSelect(c.slug)}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, padding: "13px 14px", borderRadius: T.r,
                  background: T.card, border: `1px solid ${real ? T.green + "44" : T.border}`,
                  color: T.text, cursor: "pointer", textAlign: "left",
                }}
              >
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: "block", fontFamily: T.sans, fontSize: 14, fontWeight: 800 }}>
                    {c.disambiguator ?? c.displayName}
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: T.mono, color: T.muted, fontSize: 10, marginTop: 3 }}>
                    <CheckDot />
                    {real
                      ? t("picker.subLocalChama", { currency: c.currency })
                      : t("picker.subAvailableNow", { currency: c.currency })}
                  </span>
                </span>
                <span style={{ fontFamily: T.mono, color: T.accent, fontSize: 16, lineHeight: 1 }}>→</span>
              </button>
              );
            })}
          </div>
        ) : (
          // The green landing — two greens, the words carry the distinction.
          // "Available now" never claims a local Chama; it states the route
          // works and the cabinet backs the trade. "Coming soon" stays calm
          // (still not red) and still lets the user in on the global fed.
          <div style={{ width: "100%", maxWidth: 380, display: "grid", gap: 12 }}>
            {/* The computed liveness signal — earned, chain-verified, graduated.
                Only when a fetcher is wired (post-connect); pre-signer onboarding
                shows the reassurance below on its own, never a dark landing. */}
            {loadLiveness && (
              <LivenessSignal liveness={liveness} loading={livenessLoading} outcome={livenessOutcome} blocksPerDay={livenessBlocksPerDay} />
            )}
            <div style={{
              padding: "14px 15px", borderRadius: T.r,
              background: `${T.green}12`, border: `1px solid ${T.green}44`,
              boxShadow: `0 0 0 3px ${T.green}10`,
              color: T.text, fontFamily: T.sans, fontSize: 13.5, lineHeight: 1.6,
              textAlign: "left",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontFamily: T.mono, fontWeight: 800, fontSize: 11, letterSpacing: 0.5, color: T.green }}>
                {comingSoon ? t("picker.comingSoonBadge") : t("picker.availableNowBadge")}
              </div>
              {comingSoon ? (
                <>
                  {t("picker.comingSoonBodyBefore", { name: selected.name })}{" "}
                  <span style={{ fontWeight: 700 }}>
                    {selected.flag} {selected.name} · {selected.currency}
                  </span>{" "}
                  {t("picker.comingSoonBodyAfter")}
                </>
              ) : (
                <>
                  {t("picker.availableBodyBefore", { name: selected.name })}{" "}
                  <span style={{ fontWeight: 700 }}>
                    {selected.flag} {selected.name} · {selected.currency}
                  </span>{" "}
                  {t("picker.availableBodyAfter")}
                </>
              )}
            </div>
            <button
              onClick={() => selectDefault(selected)}
              style={{
                width: "100%", padding: "15px", borderRadius: T.r,
                background: T.green, border: "none", color: T.bg,
                fontFamily: T.sans, fontSize: 14, fontWeight: 800, cursor: "pointer",
              }}
            >
              {t("picker.continueAs", { flag: selected.flag, name: selected.name, currency: selected.currency })}
            </button>
          </div>
        )}
      </>
    );
  }

  // ── Main: globe hero + searchable full-world list ──
  return (
    <div
      aria-busy={!globeArtworkReady}
      style={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        opacity: globeArtworkReady ? 1 : 0,
        visibility: globeArtworkReady ? "visible" : "hidden",
        transition: "opacity 140ms ease",
      }}
    >
      <BrandHeader />
      {/* Language pills — the first screen a fresh npub meets, and the natural
          moment: language pairs with picking where home is. */}
      <div style={{ marginBottom: 14 }}>
        <LanguagePills />
      </div>
      <div style={{ fontSize: 28, lineHeight: 1.1, color: T.text, fontFamily: T.sans, fontWeight: 900, marginBottom: 8 }}>
        {t("picker.whereHome")}
      </div>
      <div style={{ maxWidth: 340, color: T.muted, fontFamily: T.sans, fontSize: 14, lineHeight: 1.6, marginBottom: 16 }}>
        {t("picker.findCountry")}
      </div>

      <div style={{ marginBottom: 18 }}>
        <GlobeHero
          size={186}
          markers={GLOBE_MARKERS}
          onReady={() => setGlobeArtworkReady(true)}
        />
      </div>

      <div style={{ width: "100%", maxWidth: 380, marginBottom: 12 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("picker.searchPlaceholder")}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-label={t("picker.searchAria")}
          style={{
            width: "100%", boxSizing: "border-box", padding: "12px 14px",
            borderRadius: T.r, border: `1px solid ${T.border}`,
            background: T.surface, color: T.text, fontFamily: T.sans,
            fontSize: 14, outline: "none",
          }}
        />
      </div>

      {q ? (
        <>
          <SectionLabel>
            {results.length === 1
              ? t("picker.matchOne")
              : t("picker.matchMany", { count: results.length })}
          </SectionLabel>
          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380 }}>
            {results.map((c) => (
              <CountryRow key={c.code} country={c} bonded={bondedForCountry(c)} onTap={() => openCountry(c)} />
            ))}
            {results.length === 0 && (
              <div style={{
                padding: "16px", borderRadius: T.r, background: T.surface,
                border: `1px dashed ${T.border}`, color: T.muted,
                fontFamily: T.sans, fontSize: 13, textAlign: "center",
              }}>
                {t("picker.noMatch", { query })}
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          {homeCountry && (
            <>
              <SectionLabel accent>
                <CheckDot /> {t("picker.yourCountry")}
              </SectionLabel>
              <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380, marginBottom: 18 }}>
                <CountryRow country={homeCountry} bonded={bondedForCountry(homeCountry)} onTap={() => openCountry(homeCountry)} />
              </div>
            </>
          )}
          <SectionLabel>{t("picker.everyCountry")}</SectionLabel>
          <div style={{ display: "grid", gap: 8, width: "100%", maxWidth: 380 }}>
            {restCountries.map((c) => (
              <CountryRow key={c.code} country={c} bonded={bondedForCountry(c)} onTap={() => openCountry(c)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function CountryRow({ country, bonded = 0, onTap }: { country: PickerCountry; bonded?: number; onTap: () => void }) {
  const { t } = useT();
  const tier = country.availability;
  // No "Live" tier: a covered country reads green ("you can trade here"), only a
  // genuinely-uncovered "comingSoon" recedes — never red. Liveness (bonded
  // arbiters) is the computed 🛡 note, not a baked-in badge.
  const green = tier !== "comingSoon";
  const subtitle =
    country.realChamas.length > 1
      ? t("picker.subChamas", { currency: country.currency, count: country.realChamas.length })
      : green
        ? t("picker.subAvailableNow", { currency: country.currency })
        : t("picker.subComingSoon", { currency: country.currency });
  return (
    <button
      onClick={onTap}
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        gap: 12, padding: "12px 14px", borderRadius: T.r,
        background: T.card, border: `1px solid ${green ? T.green + "44" : T.border}`,
        color: T.text, cursor: "pointer", textAlign: "left",
        opacity: green ? 1 : 0.82,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <span style={{ fontSize: 24, lineHeight: 1 }}>{country.flag}</span>
        <span style={{ minWidth: 0 }}>
          <span style={{
            display: "block", fontFamily: T.sans, fontSize: 14, fontWeight: 800,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {country.name}
          </span>
          <span style={{ display: "flex", alignItems: "center", gap: 5, fontFamily: T.mono, color: T.muted, fontSize: 10, marginTop: 2 }}>
            {green && <CheckDot />}
            {subtitle}
            {/* The computed layer over the registry tiers: chain-verified
                funded+active bonds. Purely additive — appears only when real
                sats back real arbiters here; its absence changes nothing. */}
            {bonded > 0 && (
              <span style={{ color: T.green, fontWeight: 800, whiteSpace: "nowrap" }}>
                {t("picker.bondedNote", { count: bonded })}
              </span>
            )}
          </span>
        </span>
      </span>
      <span style={{ fontFamily: T.mono, color: green ? T.accent : T.muted, fontSize: 16, lineHeight: 1 }}>→</span>
    </button>
  );
}

// The "✓ covered" mark — a calm green check ("you can trade here"). No pulsing
// "Live" dot any more: a country is never labeled special/live by fiat; real
// liveness is the computed 🛡 bonded count. Green ≠ "live", just "covered".
function CheckDot() {
  return (
    <span style={{
      fontSize: 9, lineHeight: 1, color: T.green, fontWeight: 900, flexShrink: 0,
    }}>
      ✓
    </span>
  );
}

function SectionLabel({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <div style={{
      width: "100%", maxWidth: 380, textAlign: "left", margin: "2px 0 10px",
      color: accent ? T.green : T.muted, fontFamily: T.mono, fontSize: 10, fontWeight: 800,
      letterSpacing: 1, textTransform: "uppercase",
      display: "flex", alignItems: "center", gap: 6,
    }}>
      {children}
    </div>
  );
}

function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  // Constrained to the same 380px content column as the cards below, so the
  // link sits at the column's left edge — not flung to the far edge of the
  // (centered) shell on a wide viewport.
  return (
    <div style={{ width: "100%", maxWidth: 380, marginBottom: 12, textAlign: "left" }}>
      <button
        onClick={onClick}
        style={{
          display: "inline-flex", alignItems: "center", gap: 6,
          padding: "6px 10px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer",
        }}
      >
        <span style={{ fontSize: 12, lineHeight: 1 }}>←</span>
        {label}
      </button>
    </div>
  );
}
