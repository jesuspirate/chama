import { useState } from "react";
import { T, inputStyle } from "../theme.js";
import { useT, type TFunc } from "../../i18n/index.js";
import {
  type SavedHandle,
  listSavedHandles,
  addSavedHandle,
  updateSavedHandle,
  deleteSavedHandle,
  setHandleVisibility,
  maskHandle,
  formatPhoneNumber,
  formatPhoneNumberRevealed,
  getPhoneNumberSaveError,
  getPhoneNumberDisplayParts,
  getPhoneCountryHint,
  phonePlaceholderForCountryIso,
  paymentHandleNeedsCountryCode,
  sanitizePhoneNumberForSave,
} from "../../payments/saved-handles.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import {
  type Rail,
  getRailByKey,
  railsForCommunity,
  searchableRailsForCommunity,
  railAllowsPublicHandle,
  phoneNetworksForCommunity,
} from "../../payments/rail-registry.js";

const PHONE_NUMBER_RAIL = "phone-number";
const MAX_METHOD_RESULTS = 7;
const MAX_NETWORK_RESULTS = 6;

const RAIL_SEARCH_HINTS: Record<string, string> = {
  "phone-number": "mobile money phone number tel momo",
  wave: "senegal cfa mobile money phone",
  "orange-money": "orange money senegal africa mobile phone",
  wizall: "senegal cfa mobile money",
  "free-money": "senegal cfa mobile money",
  "moov-money": "benin west africa mobile money",
  "vodafone-cash": "ghana mobile money",
  "airtel-tigo-money": "ghana mobile money",
  "m-pesa": "mpesa kenya tanzania safaricom vodacom mobile money",
  "airtel-money": "airtel africa kenya uganda tanzania mobile money",
  "mtn-momo": "mtn momo mobile money ghana cameroon uganda rwanda",
  "tigo-pesa": "tanzania mobile money yas mixx",
  halopesa: "tanzania mobile money",
  azampesa: "tanzania mobile money",
  telebirr: "ethiopia mobile money",
  ecocash: "zimbabwe mobile money",
  opay: "nigeria mobile wallet money",
  paga: "nigeria mobile wallet money",
  palmpay: "nigeria mobile wallet money",
  "chipper-cash": "africa mobile wallet",
  mukuru: "southern africa mobile remittance",
  fawry: "egypt mobile wallet",
  upi: "india bharat vpa mobile bank instant transfer",
  bkash: "bangladesh mobile money",
  nagad: "bangladesh mobile money",
  rocket: "bangladesh mobile money dutch bangla",
  gcash: "philippines mobile wallet",
  maya: "philippines mobile wallet paymaya",
  easypaisa: "pakistan mobile money",
  jazzcash: "pakistan mobile money",
  truemoney: "thailand cambodia southeast asia mobile wallet",
  dana: "indonesia mobile wallet",
  gopay: "indonesia mobile wallet gojek",
  ovo: "indonesia mobile wallet",
  "momo-vietnam": "vietnam mobile wallet",
  "touch-n-go": "malaysia mobile wallet tng",
  grabpay: "southeast asia singapore malaysia philippines mobile wallet",
  pix: "brazil mobile bank instant transfer",
  "mercado-pago": "latin america mobile wallet argentina mexico chile colombia peru",
  nequi: "colombia mobile wallet",
  yape: "peru mobile wallet",
  plin: "peru mobile bank wallet",
  codi: "mexico mobile bank qr",
  spei: "mexico mobile bank transfer",
  "sinpe-movil": "costa rica mobile bank phone transfer",
  strike: "bitcoin dollar mobile payment username",
  revtag: "revolut mobile payment username",
  cashtag: "cash app mobile payment username",
  zbd: "bitcoin lightning mobile wallet username",
  "wise-tag": "wise mobile international transfer username",
  paypal: "mobile app email payment",
  venmo: "mobile app username payment",
  zelle: "mobile bank email phone payment",
  "bank-transfer": "mobile banking account iban bank transfer",
};

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/[^a-z0-9+@$]+/g, "");
}

function railSearchRank(rail: Rail, terms: string[]): number | null {
  const visible = normalizeSearchText(`${rail.displayName} ${rail.key.replace(/-/g, " ")}`);
  const visibleCompact = compactSearchText(`${rail.displayName} ${rail.key}`);
  const aliasWords = normalizeSearchText(RAIL_SEARCH_HINTS[rail.key] ?? "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const placeholder = normalizeSearchText(rail.placeholder ?? "");
  let rank = 0;

  for (const term of terms) {
    const compactTerm = compactSearchText(term);
    if (!compactTerm) continue;

    if (visible.includes(term) || visibleCompact.includes(compactTerm)) {
      rank += 0;
      continue;
    }

    // Short searches should feel literal. Typing "or" should match visible
    // names like Orange Money, not hidden words such as Singapore or "or" in
    // a placeholder. Longer searches can use aliases/country hints.
    if (compactTerm.length >= 3 && aliasWords.some(word => word.startsWith(compactTerm))) {
      rank += 2;
      continue;
    }

    if (compactTerm.length >= 3 && placeholder.includes(term)) {
      rank += 3;
      continue;
    }

    return null;
  }

  return rank;
}

function filterRails(rails: Rail[], query: string): Rail[] {
  const terms = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rails;
  return rails
    .map((rail, index) => ({ rail, index, rank: railSearchRank(rail, terms) }))
    .filter((entry): entry is { rail: Rail; index: number; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(entry => entry.rail);
}

function railPrivacyLabel(rail: Rail, t: TFunc): string {
  return rail.allowPublicHandle ? t("claim.privacyPublicOptIn") : t("claim.privacyPrivate");
}

function displayNetworkLabels(keys: readonly string[]): string[] {
  return keys.map(key => getRailByKey(key)?.displayName ?? key);
}

// Add/edit/delete local payment methods. Phone numbers stay a first-class
// default for mobile money, while app, wallet, and mobile-bank identifiers use
// the searchable rail picker below. Handles are still private by default and
// only become public when the rail explicitly allows that opt-in path.
export function SavedHandlesPanel({ communitySlug, onClose }: {
  communitySlug: string;
  onClose: () => void;
}) {
  const { t } = useT();
  const [handles, setHandles] = useState<SavedHandle[]>(() => listSavedHandles());
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());
  const [addRail, setAddRail] = useState<string>("");
  const [addValue, setAddValue] = useState<string>("");
  const [railQuery, setRailQuery] = useState<string>("");
  const [phoneValue, setPhoneValue] = useState<string>("");
  const [phoneNetworks, setPhoneNetworks] = useState<Set<string>>(new Set());
  const [phoneNetworkQuery, setPhoneNetworkQuery] = useState<string>("");
  const [editingNetworkHandleId, setEditingNetworkHandleId] = useState<string | null>(null);
  const [handleNetworkQuery, setHandleNetworkQuery] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [banksOpen, setBanksOpen] = useState<boolean>(false);

  const refresh = () => {
    setHandles(listSavedHandles());
  };

  // Phone-shaped rails (M-Pesa, Tigo Pesa, Airtel Money…) live in the phone
  // section above as network tags — keep them OUT of "Banks & apps" so the same
  // network never shows up in both places. Uses the SAME predicate that fills
  // the phone tags, so the two sections can never overlap.
  const phoneShapedKeys = new Set(
    phoneNetworksForCommunity(communitySlug, { includeSearchable: true }).map(r => r.key),
  );
  const isBankOrApp = (r: Rail) => r.key !== PHONE_NUMBER_RAIL && !phoneShapedKeys.has(r.key);
  const localAvailableRails = railsForCommunity(communitySlug).filter(isBankOrApp);
  const searchableAvailableRails = searchableRailsForCommunity(communitySlug).filter(isBankOrApp);
  const availableRails = railQuery.trim() ? searchableAvailableRails : localAvailableRails;
  const methodResults = filterRails(availableRails, railQuery).slice(0, MAX_METHOD_RESULTS);
  const selectedRail = getRailByKey(addRail);
  const localPhoneNetworkOptions = phoneNetworksForCommunity(communitySlug);
  const searchablePhoneNetworkOptions = phoneNetworksForCommunity(communitySlug, { includeSearchable: true });
  const phoneNetworkOptions = phoneNetworkQuery.trim()
    ? searchablePhoneNetworkOptions
    : localPhoneNetworkOptions;
  const phoneNetworkResults = filterRails(phoneNetworkOptions, phoneNetworkQuery)
    .slice(0, MAX_NETWORK_RESULTS);
  const phoneRail = getRailByKey(PHONE_NUMBER_RAIL);
  // Prefer the user's OWN country dial code + national format (Kenya → +254 …,
  // Cameroon → +237 …) so the placeholder always matches where they live — a
  // region-matched or first-"+" rail could otherwise leak a foreign example
  // (e.g. Brazil's +55) when no local phone rail is tagged for the community.
  const communityCountryIso = getCommunityBySlug(communitySlug)?.countries?.[0] ?? null;
  const phonePlaceholder = phonePlaceholderForCountryIso(communityCountryIso)
    || localPhoneNetworkOptions.find(r =>
      r.region?.includes(communitySlug) && r.placeholder?.startsWith("+")
    )?.placeholder
    || localPhoneNetworkOptions.find(r => r.placeholder?.startsWith("+"))?.placeholder
    || phoneRail?.placeholder
    || "+254 712-345-678";
  const phoneParts = getPhoneNumberDisplayParts(phoneValue);
  const phoneCountryHint = getPhoneCountryHint(phoneValue);
  const phonePlaceholderParts = getPhoneNumberDisplayParts(phonePlaceholder);
  const phoneSaveError = phoneValue.trim() ? getPhoneNumberSaveError(phoneValue) : null;
  const phonePrefix = phoneCountryHint
    ? `${phoneCountryHint.flagEmoji ? `${phoneCountryHint.flagEmoji} ` : ""}+${phoneCountryHint.countryCode}`
    : "+";
  const phoneInputHasInternationalPrefix = phoneValue.trim().startsWith("+");
  const phoneInputDigits = phoneValue.replace(/\D/g, "");
  const phoneInputValue = phoneValue
    ? (phoneCountryHint
        ? phoneParts.nationalFormatted
        : phoneInputHasInternationalPrefix
          ? phoneInputDigits
          : phoneParts.normalized)
    : "";
  const phoneInputPlaceholder = phoneCountryHint
    ? phoneCountryHint.nationalPlaceholder
    : !phoneValue && phonePlaceholderParts.countryCode
      ? `${phonePlaceholderParts.countryCode} ${phonePlaceholderParts.inputValue}`
      : phonePlaceholderParts.inputValue || phonePlaceholderParts.normalized;
  const showPhoneSaveError = phoneSaveError && (!phoneCountryHint || phoneParts.nationalDigits.length > 0);
  const phoneProgressHint = phoneCountryHint
    ? t("claim.phoneProgressHint", {
        country: phoneCountryHint.countryName ?? `+${phoneCountryHint.countryCode}`,
        expected: phoneCountryHint.expectedLength,
        code: phoneCountryHint.countryCode,
      })
    : null;
  const selectedRailNeedsCountryCode = selectedRail
    ? selectedRail.placeholder?.includes("+") === true
      && (!addValue.trim() || paymentHandleNeedsCountryCode(selectedRail.key, addValue))
    : false;

  const handlePhoneInputChange = (rawInput: string) => {
    setError(null);
    if (!rawInput.trim()) {
      setPhoneValue(phoneParts.countryCode ? formatPhoneNumber(`+${phoneParts.countryCode}`) : "");
      return;
    }
    const trimmed = rawInput.trim();
    const nextRaw = trimmed.startsWith("+")
      ? trimmed
      : phoneParts.countryCode
        ? `+${phoneParts.countryCode}${trimmed}`
        : `+${trimmed}`;
    setPhoneValue(formatPhoneNumber(nextRaw));
  };

  const deletePhoneCountryDigit = (): boolean => {
    if (!phoneCountryHint || phoneParts.nationalDigits.length > 0 || phoneInputValue.length > 0) {
      return false;
    }
    const nextDigits = phoneInputDigits.slice(0, -1);
    setPhoneValue(nextDigits ? formatPhoneNumber(`+${nextDigits}`) : "");
    setError(null);
    return true;
  };

  const togglePhoneNetwork = (key: string) => {
    setPhoneNetworks(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleAddPhone = () => {
    setError(null);
    if (!phoneValue.trim()) {
      setError(t("claim.errEnterPhone"));
      return;
    }
    try {
      const normalized = sanitizePhoneNumberForSave(phoneValue.trim());
      addSavedHandle(PHONE_NUMBER_RAIL, normalized, {
        networks: [...phoneNetworks],
      });
      setPhoneValue("");
      setPhoneNetworks(new Set());
      setPhoneNetworkQuery("");
      refresh();
    } catch (e: any) {
      setError(e?.message || t("claim.errSavePhoneFailed"));
    }
  };

  const handleToggleHandleNetwork = (h: SavedHandle, networkKey: string) => {
    const current = new Set(h.networks ?? []);
    if (current.has(networkKey)) current.delete(networkKey);
    else current.add(networkKey);
    updateSavedHandle(h.id, { networks: [...current] });
    refresh();
  };

  const handleAdd = () => {
    setError(null);
    if (!addRail || !addValue.trim()) {
      setError(t("claim.errChooseMethodAndId"));
      return;
    }
    try {
      addSavedHandle(addRail, addValue.trim());
      setAddRail("");
      setAddValue("");
      setRailQuery("");
      refresh();
    } catch (e: any) {
      setError(e?.message || t("claim.errSaveMethodFailed"));
    }
  };

  const handleDelete = (id: string) => {
    deleteSavedHandle(id);
    refresh();
  };

  const handleToggleVisibility = (h: SavedHandle) => {
    setError(null);
    const next = h.visibility === "public" ? "private" : "public";
    const result = setHandleVisibility(h.id, next);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    refresh();
  };

  const handleReveal = (id: string) => {
    setRevealedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 18,
      }}>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          {t("claim.paymentMethods")}
        </span>
        <button onClick={onClose} style={{
          background: "none", border: "none",
          color: T.muted, fontSize: 20, cursor: "pointer",
        }}>×</button>
      </div>

      <div style={{
        fontSize: 11, color: T.muted, fontFamily: T.mono,
        marginBottom: 14, lineHeight: 1.5,
      }}>
        {t("claim.paymentMethodsBody")}
      </div>

      <div style={{
        background: T.card,
        border: `1px solid ${T.teal + "55"}`,
        borderRadius: T.r,
        padding: 14,
        marginBottom: 12,
      }}>
        <div style={{
          display: "flex", justifyContent: "space-between",
          alignItems: "baseline", gap: 12, marginBottom: 8,
        }}>
          <div>
            <div style={{
              fontSize: 10, fontWeight: 800, color: T.teal,
              fontFamily: T.mono, letterSpacing: 1,
              textTransform: "uppercase",
            }}>
              {t("claim.defaultForMobileMoney")}
            </div>
            <div style={{
              fontSize: 16, fontWeight: 800, color: T.text,
              fontFamily: T.sans, marginTop: 2,
            }}>
              {t("claim.phoneNumber")}
            </div>
          </div>
          <span style={{
            padding: "3px 9px", borderRadius: 999,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 9,
            fontWeight: 800, letterSpacing: 0.3, flexShrink: 0,
          }}>
            {t("claim.privateBadge")}
          </span>
        </div>
        <div style={{
          fontSize: 11, color: T.muted, fontFamily: T.sans,
          lineHeight: 1.45, marginBottom: 12,
        }}>
          {t("claim.worksForWallets")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <div style={{
            display: "flex", alignItems: "center", flex: "1 1 220px", minWidth: 0,
            background: T.surface, border: `1px solid ${T.border}`,
            borderRadius: T.rs, overflow: "hidden",
          }}
          onKeyDownCapture={e => {
            if ((e.key === "Backspace" || e.key === "Delete") && deletePhoneCountryDigit()) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          >
            <span style={{
              width: phoneCountryHint ? 86 : 44,
              textAlign: "center", flexShrink: 0,
              fontSize: phoneCountryHint ? 12 : 20,
              lineHeight: phoneCountryHint ? "16px" : "20px",
              color: phoneCountryHint ? T.text : T.text,
              fontFamily: phoneCountryHint ? T.mono : T.sans,
              fontWeight: phoneCountryHint ? 800 : 400,
              borderRight: `1px solid ${T.border}`,
            }}>
              {phonePrefix}
            </span>
            <input
              value={phoneInputValue}
              onChange={e => handlePhoneInputChange(e.target.value)}
              onBeforeInput={e => {
                const inputType = (e.nativeEvent as InputEvent).inputType;
                if (
                  (inputType === "deleteContentBackward" || inputType === "deleteContentForward")
                  && deletePhoneCountryDigit()
                ) {
                  e.preventDefault();
                }
              }}
              onKeyDown={e => {
                if (
                  (e.key === "Backspace" || e.key === "Delete")
                  && deletePhoneCountryDigit()
                ) {
                  e.preventDefault();
                }
              }}
              onBlur={() => setPhoneValue(v => formatPhoneNumber(v))}
              placeholder={phoneInputPlaceholder}
              inputMode="tel"
              autoComplete="off"
              name="chama-private-payment-phone"
              data-bwignore="true"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              style={{
                ...inputStyle,
                marginBottom: 0, border: "none", borderRadius: 0,
                background: "transparent", flex: 1, minWidth: 0,
              }}
            />
          </div>
          <button
            onClick={handleAddPhone}
            disabled={!phoneValue.trim() || !!phoneSaveError}
            style={{
              padding: "0 14px", borderRadius: T.rs,
              background: !phoneValue.trim() || phoneSaveError ? T.surface : T.tealDim,
              border: `1px solid ${!phoneValue.trim() || phoneSaveError ? T.border : T.teal + "66"}`,
              color: !phoneValue.trim() || phoneSaveError ? T.muted : T.teal,
              fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: !phoneValue.trim() || phoneSaveError ? "default" : "pointer",
              whiteSpace: "nowrap" as const,
            }}
          >
            {t("claim.savePhone")}
          </button>
        </div>
        {phoneProgressHint && !showPhoneSaveError && (
          <div style={{
            marginTop: 8, color: T.teal, fontFamily: T.mono,
            fontSize: 10, lineHeight: 1.45,
          }}>
            {phoneProgressHint}
          </div>
        )}
        {showPhoneSaveError && (
          <div style={{
            marginTop: 8, color: T.red, fontFamily: T.mono,
            fontSize: 10, lineHeight: 1.45,
          }}>
            {phoneSaveError}
          </div>
        )}

        {phoneNetworkOptions.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 8, marginBottom: 7,
            }}>
              <div style={{
                fontSize: 10, color: T.muted, fontFamily: T.mono,
                letterSpacing: 0.4,
              }}>
                {t("claim.optionalNetworkTags")}
              </div>
              {phoneNetworks.size > 0 && (
                <span style={{ fontSize: 10, color: T.teal, fontFamily: T.mono }}>
                  {t("claim.selectedCount", { count: [...phoneNetworks].length })}
                </span>
              )}
            </div>
            {phoneNetworks.size > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                {displayNetworkLabels([...phoneNetworks]).map(label => (
                  <span key={label} style={{
                    padding: "4px 8px", borderRadius: 999,
                    background: T.tealDim, border: `1px solid ${T.teal + "55"}`,
                    color: T.teal, fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                  }}>
                    {label}
                  </span>
                ))}
              </div>
            )}
            <input
              value={phoneNetworkQuery}
              onChange={e => setPhoneNetworkQuery(e.target.value)}
              placeholder={t("claim.searchNetworksForPhone")}
              style={{ ...inputStyle, marginBottom: 8, padding: "10px 12px", fontSize: 12 }}
            />
            <div style={{ display: "grid", gap: 6 }}>
              {phoneNetworkResults.map((rail, i) => {
                const selected = phoneNetworks.has(rail.key);
                return (
                  <button
                    key={rail.key}
                    onClick={() => togglePhoneNetwork(rail.key)}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      gap: 10, width: "100%", padding: "8px 10px",
                      borderRadius: T.rs,
                      background: selected ? T.tealDim : T.surface,
                      border: `1px solid ${selected ? T.teal + "66" : T.border}`,
                      color: selected ? T.teal : T.text,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                      cursor: "pointer", textAlign: "left" as const,
                      animation: `fadeIn 0.18s ease ${i * 0.025}s both`,
                    }}
                  >
                    <span>{rail.displayName}</span>
                    <span style={{ color: selected ? T.teal : T.muted }}>
                      {selected ? t("claim.added") : t("claim.add")}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{
        background: T.card,
        border: `1px solid ${T.border}`,
        borderRadius: T.r,
        padding: 14,
        marginBottom: 18,
      }}>
        <button
          onClick={() => setBanksOpen(o => !o)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            gap: 12, width: "100%", background: "none", border: "none",
            padding: 0, cursor: "pointer", textAlign: "left" as const,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontSize: 10, fontWeight: 800, color: T.accent,
              fontFamily: T.mono, letterSpacing: 1,
              textTransform: "uppercase",
            }}>
              {t("claim.banksAndApps")}
            </div>
            <div style={{
              fontSize: 11, color: T.muted, fontFamily: T.sans,
              lineHeight: 1.4, marginTop: 3,
            }}>
              {t("claim.banksAndAppsBody")}
            </div>
          </div>
          <span style={{
            color: T.muted, fontSize: 13, fontFamily: T.mono, flexShrink: 0,
            transform: banksOpen ? "rotate(90deg)" : "none",
            transition: "transform 0.15s ease",
          }}>▸</span>
        </button>

        {banksOpen && (
        <div style={{ marginTop: 12, animation: "fadeIn 0.18s ease" }}>
        <input
          value={railQuery}
          onChange={e => {
            setRailQuery(e.target.value);
            setAddRail("");
            setAddValue("");
            setError(null);
          }}
          placeholder={t("claim.searchBanksPlaceholder")}
          style={{ ...inputStyle, marginBottom: 8 }}
        />
        <div style={{ display: "grid", gap: 6, marginBottom: selectedRail ? 12 : 0 }}>
          {methodResults.length === 0 ? (
            <div style={{
              padding: 12, borderRadius: T.rs, background: T.surface,
              border: `1px dashed ${T.border}`, color: T.muted,
              fontFamily: T.mono, fontSize: 11,
            }}>
              {t("claim.noMatchYet")}
            </div>
          ) : (
            methodResults.map((rail, i) => {
              const selected = addRail === rail.key;
              return (
                <button
                  key={rail.key}
                  onClick={() => {
                    setAddRail(rail.key);
                    setRailQuery(rail.displayName);
                    setError(null);
                  }}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    gap: 10, width: "100%", padding: "9px 10px",
                    borderRadius: T.rs,
                    background: selected ? T.accentDim : T.surface,
                    border: `1px solid ${selected ? T.accent + "66" : T.border}`,
                    color: selected ? T.accent : T.text,
                    cursor: "pointer", textAlign: "left" as const,
                    animation: `fadeIn 0.2s ease ${i * 0.03}s both`,
                  }}
                >
                  <span style={{ minWidth: 0 }}>
                    <span style={{
                      display: "block", fontFamily: T.sans,
                      fontSize: 13, fontWeight: 800,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {rail.displayName}
                    </span>
                    <span style={{
                      display: "block", color: T.muted, fontFamily: T.mono,
                      fontSize: 10, marginTop: 2,
                      overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                    }}>
                      {rail.placeholderKey ? t(rail.placeholderKey) : (rail.placeholder ?? t("claim.paymentIdFallback"))}
                    </span>
                  </span>
                  <span style={{
                    padding: "3px 8px", borderRadius: 999,
                    background: selected ? T.accentDim : T.card,
                    border: `1px solid ${selected ? T.accent + "44" : T.border}`,
                    color: selected ? T.accent : T.muted,
                    fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                    flexShrink: 0,
                  }}>
                    {railPrivacyLabel(rail, t)}
                  </span>
                </button>
              );
            })
          )}
        </div>

        {selectedRail && (
          <div style={{ animation: "fadeIn 0.18s ease" }}>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
              {t("claim.paymentIdFor", { rail: selectedRail.displayName })}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={addValue}
                onChange={e => { setAddValue(e.target.value); setError(null); }}
                placeholder={selectedRail.placeholderKey ? t(selectedRail.placeholderKey) : (selectedRail.placeholder || t("claim.yourPaymentId"))}
                style={{ ...inputStyle, marginBottom: 0, flex: "1 1 220px" }}
              />
              <button
                onClick={handleAdd}
                disabled={!addValue.trim()}
                style={{
                  padding: "0 14px", borderRadius: T.rs,
                  background: !addValue.trim() ? T.surface : T.accentDim,
                  border: `1px solid ${!addValue.trim() ? T.border : T.accent + "66"}`,
                  color: !addValue.trim() ? T.muted : T.accent,
                  fontFamily: T.mono, fontSize: 11, fontWeight: 800,
                  cursor: !addValue.trim() ? "default" : "pointer",
                  whiteSpace: "nowrap" as const,
                }}
              >
                {t("claim.saveMethod")}
              </button>
            </div>
            {selectedRailNeedsCountryCode && (
              <div style={{
                marginTop: 7, color: T.amber, fontFamily: T.mono,
                fontSize: 10, lineHeight: 1.45,
              }}>
                {t("claim.phoneCountryCodeNudge", { example: phonePlaceholder })}
              </div>
            )}
          </div>
        )}
        </div>
        )}
      </div>

      {error && (
        <div style={{
          color: T.red, fontFamily: T.mono, fontSize: 11,
          marginBottom: 12, padding: "10px 12px",
          background: T.redDim, border: `1px solid ${T.red + "44"}`,
          borderRadius: T.rs,
        }}>{error}</div>
      )}

      <div style={{
        fontSize: 10, fontWeight: 800, color: T.muted,
        fontFamily: T.mono, letterSpacing: 1.3, marginBottom: 10,
        textTransform: "uppercase",
      }}>
        {t("claim.savedMethods")}
      </div>
      {handles.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center", borderRadius: T.r,
          background: T.surface, border: `1px dashed ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          marginBottom: 20, lineHeight: 1.5,
        }}>
          {t("claim.noSavedMethods")}
        </div>
      ) : (
        <div style={{ marginBottom: 24 }}>
          {handles.map(h => {
            const rail = getRailByKey(h.rail);
            const railName = rail?.displayName || h.rail;
            const allowsPublic = railAllowsPublicHandle(h.rail);
            const revealed = revealedIds.has(h.id);
            const display = revealed
              ? (h.handle.startsWith("+") ? formatPhoneNumberRevealed(h.handle) : h.handle)
              : maskHandle(h.handle);
            const networkLabels = displayNetworkLabels(h.networks ?? []);
            const editingNetworks = editingNetworkHandleId === h.id;
            const editorNetworkResults = filterRails(phoneNetworkOptions, handleNetworkQuery)
              .slice(0, MAX_NETWORK_RESULTS);
            return (
              <div key={h.id} style={{
                background: T.card, border: `1px solid ${T.border}`,
                borderRadius: T.r, padding: 13, marginBottom: 9,
              }}>
                <div style={{
                  display: "flex", justifyContent: "space-between",
                  alignItems: "center", gap: 10, marginBottom: 8,
                }}>
                  <span style={{
                    fontSize: 13, fontWeight: 800, color: T.text,
                    fontFamily: T.sans, minWidth: 0,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{railName}</span>
                  {allowsPublic ? (
                    <button
                      onClick={() => handleToggleVisibility(h)}
                      style={{
                        padding: "3px 9px", borderRadius: 999,
                        background: h.visibility === "public" ? T.greenDim : T.surface,
                        border: `1px solid ${h.visibility === "public" ? T.green + "66" : T.border}`,
                        color: h.visibility === "public" ? T.green : T.muted,
                        fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                        cursor: "pointer", letterSpacing: 0.3,
                        flexShrink: 0,
                      }}
                    >
                      {h.visibility === "public" ? t("claim.publicBadge") : t("claim.privateBadge")}
                    </button>
                  ) : (
                    <span style={{
                      padding: "3px 9px", borderRadius: 999,
                      background: T.surface, border: `1px solid ${T.border}`,
                      color: T.muted, fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                      letterSpacing: 0.3, flexShrink: 0,
                    }}>{t("claim.privateBadge")}</span>
                  )}
                </div>
                <button
                  onClick={() => handleReveal(h.id)}
                  style={{
                    width: "100%", fontFamily: T.mono, fontSize: 13, color: T.text,
                    padding: "8px 10px", background: T.surface,
                    borderRadius: T.rs, cursor: "pointer",
                    border: `1px solid ${T.border}`, marginBottom: 8,
                    display: "flex", justifyContent: "space-between",
                    gap: 10, textAlign: "left" as const,
                  }}
                  title={revealed ? t("claim.tapToMask") : t("claim.tapToReveal")}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {display}
                  </span>
                  <span style={{ color: T.muted, fontSize: 10, flexShrink: 0 }}>
                    {revealed ? t("claim.mask") : t("claim.reveal")}
                  </span>
                </button>

                {h.rail === PHONE_NUMBER_RAIL && phoneNetworkOptions.length > 0 && (
                  <div style={{
                    borderTop: `1px solid ${T.border}`,
                    marginTop: 9, paddingTop: 9, marginBottom: 8,
                  }}>
                    <div style={{
                      display: "flex", alignItems: "center",
                      justifyContent: "space-between", gap: 8, marginBottom: 7,
                    }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{
                          fontSize: 9, color: T.muted, fontFamily: T.mono,
                          letterSpacing: 0.6, textTransform: "uppercase",
                        }}>
                          {t("claim.networkTags")}
                        </div>
                        <div style={{
                          color: networkLabels.length ? T.teal : T.muted,
                          fontFamily: T.mono, fontSize: 10, marginTop: 3,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                        }}>
                          {networkLabels.length ? networkLabels.join(" · ") : t("claim.noTagsYet")}
                        </div>
                      </div>
                      <button
                        onClick={() => {
                          setEditingNetworkHandleId(editingNetworks ? null : h.id);
                          setHandleNetworkQuery("");
                        }}
                        style={{
                          padding: "5px 9px", borderRadius: 999,
                          background: editingNetworks ? T.tealDim : T.surface,
                          border: `1px solid ${editingNetworks ? T.teal + "55" : T.border}`,
                          color: editingNetworks ? T.teal : T.muted,
                          fontFamily: T.mono, fontSize: 9, fontWeight: 800,
                          cursor: "pointer", flexShrink: 0,
                        }}
                      >
                        {editingNetworks ? t("common.done") : t("claim.edit")}
                      </button>
                    </div>
                    {editingNetworks && (
                      <div style={{ animation: "fadeIn 0.18s ease" }}>
                        <input
                          value={handleNetworkQuery}
                          onChange={e => setHandleNetworkQuery(e.target.value)}
                          placeholder={t("claim.searchNetworks")}
                          style={{ ...inputStyle, marginBottom: 8, padding: "9px 11px", fontSize: 12 }}
                        />
                        <div style={{ display: "grid", gap: 6 }}>
                          {editorNetworkResults.map((rail, i) => {
                            const selected = (h.networks ?? []).includes(rail.key);
                            return (
                              <button
                                key={rail.key}
                                onClick={() => handleToggleHandleNetwork(h, rail.key)}
                                style={{
                                  display: "flex", alignItems: "center", justifyContent: "space-between",
                                  gap: 10, padding: "7px 9px", borderRadius: T.rs,
                                  background: selected ? T.tealDim : T.surface,
                                  border: `1px solid ${selected ? T.teal + "66" : T.border}`,
                                  color: selected ? T.teal : T.text,
                                  fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                                  cursor: "pointer", textAlign: "left" as const,
                                  animation: `fadeIn 0.18s ease ${i * 0.025}s both`,
                                }}
                              >
                                <span>{rail.displayName}</span>
                                <span style={{ color: selected ? T.teal : T.muted }}>
                                  {selected ? t("claim.added") : t("claim.add")}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                <button
                  onClick={() => handleDelete(h.id)}
                  style={{
                    background: "none", border: "none",
                    color: T.red, fontFamily: T.mono, fontSize: 10,
                    cursor: "pointer", padding: 0,
                  }}
                >{t("claim.delete")}</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
