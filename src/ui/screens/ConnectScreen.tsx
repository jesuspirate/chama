import { useEffect, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { VerticalIcon, type ChamaVerticalIconId } from "../components/VerticalIcon.js";
import { useT, type TFunc } from "../../i18n/index.js";
import {
  getSignInEnvironment,
  isFediWebViewSignInEnvironment,
  isTauriRuntime,
} from "../sign-in-environment.js";
import { isNativeBridgeModeOn } from "../../fedimint/native-bridge-adapter.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import {
  getUserCommunitySlugRaw,
  getLastHomeHint,
} from "../../communities/storage.js";
import { getPendingCommunityReport } from "../../communities/community-request.js";

// v2.6: the orientation moment. A brand-new user (no home community yet)
// historically met "Choose your local market" cold — the app asked for a
// commitment before it said what it was. The clearest description of Chama
// (the four trade types) lived three taps deep inside Create. WelcomeIntro
// surfaces that "what is this, what can I do, why is it safe" answer once,
// before sign-in. Browser-wide localStorage (pre-identity, no npub yet) so it
// fires once per device.
//
// v4.3 AUTH-FIRST: the market picker moved OUT of ConnectScreen to AFTER connect
// (App's post-connect "no home yet → GlobeCountryPicker" gate). Sign-in is now
// the first gate — the npub is known before the pick, so the pick writes STRAIGHT
// to the npub's scope and the old pre-signer pending-stash race-fix is retired.
// A returning user's remembered chama still shows here as read-only reassurance.
const INTRO_SEEN_KEY = "chama_intro_seen";

function readIntroSeen(): boolean {
  try {
    return typeof localStorage !== "undefined"
      && localStorage.getItem(INTRO_SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markIntroSeen(): void {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(INTRO_SEEN_KEY, "1");
  } catch {
    // private mode / storage disabled — the intro just shows again next launch.
  }
}

function isExplicitFedimintRecoveryDiagnostic(): boolean {
  try {
    return !!(import.meta as any).env?.DEV
      && new URLSearchParams(window.location.search)
        .get("forceFedimintRecovery") === "1";
  } catch {
    return false;
  }
}

// The public things you can do. Mirrors the Create
// wizard's trade-type cards (CreateForm) so the model a newcomer learns
// here is the exact model they act on later — no re-teaching. Tints are
// drawn from the theme palette (not the sacred buyer/seller/arbiter role
// hexes) purely for glanceable variety.
// `soon` marks a vertical that's on the way but not yet a Create option — shown
// so the splash sells the full vision without promising a button that isn't there
// Work and Chip In are parked for a future release. Keep their underlying
// protocol/rendering support intact so existing relay history remains readable.
// i18n: title/blurb are DICTIONARY KEYS, resolved with t() at render so the
// splash follows the live language (module-level constants can't call hooks).
const INTRO_USE_CASES: { vertical: ChamaVerticalIconId; titleKey: string; blurbKey: string; soon?: boolean }[] = [
  { vertical: "p2p-trade", titleKey: "connect.useCaseExchange",    blurbKey: "connect.useCaseExchangeBlurb" },
  { vertical: "bill-pay", titleKey: "connect.useCaseBillPay",     blurbKey: "connect.useCaseBillPayBlurb" },
  { vertical: "marketplace", titleKey: "connect.useCaseMarketplace", blurbKey: "connect.useCaseMarketplaceBlurb" },
  // Parked for later:
  // { vertical: "work", titleKey: "connect.useCaseWork", blurbKey: "connect.useCaseWorkBlurb" },
  // { vertical: "chip-in", titleKey: "connect.useCaseChipIn", blurbKey: "connect.useCaseChipInBlurb", soon: true },
  { vertical: "stack", titleKey: "connect.useCaseStack",       blurbKey: "connect.useCaseStackBlurb", soon: true },
];

export function ConnectScreen({
  onConnect, onConnectNsec, onRequestHomeChange, loading, error,
}: {
  onConnect: () => void;
  onConnectNsec: (nsec: string, remember: boolean, wasGenerated: boolean) => void | Promise<void>;
  /** A pre-sign-in home is only a browser-wide display hint. Request the real
   *  picker after authentication, when the choice can be scoped to the npub. */
  onRequestHomeChange: () => void;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useT();
  // A browser pointed at a remote Rust bridge (the VPS "friend wallet" link) is
  // running in native/bridge mode — no NIP-07 extension exists there, so treat it
  // like native for login: go straight to the nsec paste box instead of attempting
  // the extension and surfacing an "extension not found" error.
  const isNative = Capacitor.isNativePlatform() || isTauriRuntime() || isNativeBridgeModeOn();
  const signInEnvironment = {
    ...getSignInEnvironment(),
    isNativePlatform: isNative,
  };
  const isFediWebView = isFediWebViewSignInEnvironment(signInEnvironment);
  // A returning npub's choice is scoped (read post-connect); the unscoped "last
  // home" hint (#6) is a display-only fallback so a returning user sees "welcome
  // back to <chama>" pre-signin. It never resolves a committed home, so it can't
  // leak across npubs. Auth-first: this is REASSURANCE only. The Change action
  // below can request a re-pick, but the actual mutation waits until post-connect.
  const homeSlug = getUserCommunitySlugRaw() ?? getLastHomeHint();
  // v2.6: gate the one-time orientation screen ahead of the market picker.
  const [introSeen, setIntroSeen] = useState<boolean>(() => readIntroSeen());
  // v2.5: the recovery-key paste box, revealed by "I'm a returning Chama
  // citizen" on the platforms where pasting is the right path — no hint detour,
  // no intermediate button.
  const [showRecoveryKey, setShowRecoveryKey] = useState(false);
  const [returningSignInAttempted, setReturningSignInAttempted] = useState(false);
  const [homeChangeRequested, setHomeChangeRequested] = useState(false);
  const homeCommunity = homeSlug ? getCommunityBySlug(homeSlug) : null;
  // NIP-07 browser extension (Alby, nos2x, …). Only meaningful in a desktop
  // browser — native shells and the Fedi WebView don't inject window.nostr.
  const hasNostrExtension = typeof window !== "undefined" && !!(window as any).nostr;

  // Prefer the browser extension when one is present. If there is no extension,
  // or that attempt fails, reveal the recovery field; NsecLogin autofocuses it.
  const handleReturningSignIn = () => {
    // A field-recovery run must be tied to the exact affected nsec. Browser
    // extensions can be connected to another identity, which would make the
    // diagnostic rotate/recover the wrong identity-scoped OPFS wallet. In dev,
    // the explicit recovery URL therefore opens the private recovery-key field
    // directly and never consults window.nostr.
    if (isExplicitFedimintRecoveryDiagnostic()) {
      setShowRecoveryKey(true);
      return;
    }
    if (!hasNostrExtension) {
      setShowRecoveryKey(true);
      return;
    }
    setReturningSignInAttempted(true);
    onConnect();
  };

  useEffect(() => {
    if (!returningSignInAttempted || loading || !error) return;
    setShowRecoveryKey(true);
  }, [returningSignInAttempted, loading, error]);

  // First-ever launch on this device → orient before asking for anything.
  // Auth-first: after the intro we go STRAIGHT to sign-in (the market picker is
  // now a post-connect gate in App, once the npub is known).
  if (!introSeen) {
    return (
      <OnboardingShell>
        <WelcomeIntro
          onContinue={() => {
            markIntroSeen();
            setIntroSeen(true);
          }}
        />
      </OnboardingShell>
    );
  }

  // v2.7: if the user tapped "no Chama here — report it" on the globe (which
  // runs pre-signer), the report is stashed and we reframe sign-in as the
  // moment it gets sent. Read fresh each render so a report queued after mount
  // (picker → here, same ConnectScreen instance) is reflected.
  const pendingReport = getPendingCommunityReport();

  return (
    <OnboardingShell>
      <BrandHeader />

      {/* Browser-wide continuity hint, explicitly labelled as such. Change only
          queues the authenticated picker; it never writes another npub's home. */}
      {!isNative && homeCommunity && (
        <div style={{
          maxWidth: 360, width: "100%", marginBottom: 18,
          padding: 14, borderRadius: T.r,
          background: T.surface, border: `1px solid ${T.border}`,
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
            <span style={{ fontSize: 24, lineHeight: 1 }}>{homeCommunity.flagEmoji}</span>
            <div style={{ minWidth: 0, textAlign: "left" }}>
              <div style={{ fontSize: 12, color: T.text, fontFamily: T.sans, fontWeight: 800 }}>
                {homeCommunity.displayName}
              </div>
              <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
                {homeChangeRequested ? t("connect.chooseAfterSignIn") : t("connect.lastChamaHere")}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setHomeChangeRequested(true);
              onRequestHomeChange();
            }}
            disabled={homeChangeRequested}
            style={{
              flexShrink: 0, padding: "7px 10px", borderRadius: T.rs,
              background: homeChangeRequested ? "transparent" : T.accentDim,
              border: `1px solid ${homeChangeRequested ? T.border : `${T.accent}66`}`,
              color: homeChangeRequested ? T.green : T.accent,
              fontFamily: T.sans, fontSize: 11, fontWeight: 800,
              cursor: homeChangeRequested ? "default" : "pointer",
            }}
          >
            {homeChangeRequested ? t("connect.changeQueued") : t("connect.changeHome")}
          </button>
        </div>
      )}

      {pendingReport ? (
        <div style={{ width: "100%", maxWidth: 360, marginBottom: 26 }}>
          <InstructionBox>
            {t("connect.pendingReportSignIn", { chama: pendingReport.requestedChama })}
          </InstructionBox>
        </div>
      ) : (
        <div style={{
          maxWidth: 330, fontSize: 14, color: T.muted, lineHeight: 1.8,
          fontFamily: T.sans, marginBottom: 26,
        }}>
          {t("connect.tagline1")}
          <br />
          <span style={{ color: T.text }}>{t("connect.tagline2")}</span>
        </div>
      )}

      {error && <ErrorBox>{friendlySignInError(error, t)}</ErrorBox>}

      <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%", maxWidth: 360 }}>
        {isFediWebView ? (
          <FediOnlyConnectButton
            loading={loading}
            onConnect={onConnect}
          />
        ) : (
          <>
            <NsecLogin
              onSubmit={onConnectNsec}
              friendly
              // Once "I'm a returning Chama citizen" reveals the paste box
              // below, the create-a-key footer no longer applies — swap in
              // recovery guidance so the copy matches what the box is asking
              // for. Create mode (paste box hidden) keeps the original line.
              choiceFooter={showRecoveryKey
                ? t("connect.recoveryFooter")
                : undefined}
              friendlySecondary={{
                label: loading ? t("common.connecting") : t("connect.returningCitizen"),
                hint: t("connect.returningCitizenHint"),
                // Opens and focuses the attached recovery-key field directly.
                onClick: handleReturningSignIn,
                disabled: loading,
                tone: "accent",
              }}
            />

            {showRecoveryKey && !isNative && (
              // Browser-only security nudge: we only land here after the
              // extension was absent or dismissed. Pasting an nsec into a web
              // page is the least-safe path, so name that + point at the front
              // door before offering the box.
              <div style={{
                maxWidth: 360, fontSize: 11, color: T.muted, fontFamily: T.mono,
                lineHeight: 1.55, background: T.surface, border: `1px solid ${T.amber}44`,
                borderRadius: T.rs, padding: "10px 12px",
              }}>
                <span style={{ color: T.amber, fontWeight: 700 }}>{t("connect.saferExtTitle")}</span>{" "}
                {t("connect.saferExtBody")}
              </div>
            )}

            {showRecoveryKey && (
              // The paste box, attached to "I'm a returning Chama citizen".
              // minimalPaste: just the field + Show; a valid paste (or Enter)
              // signs you in — no Continue button, no clutter.
              <NsecLogin
                onSubmit={onConnectNsec}
                defaultOpen
                allowCreate={false}
                minimalPaste
                autoFocusInput
              />
            )}

          </>
        )}
      </div>

      <div style={{
        marginTop: 34, fontSize: 9, color: T.muted + "66", fontFamily: T.mono,
        lineHeight: 1.8, maxWidth: 280,
      }}>
        {t("connect.footerNonCustodial")}
        <br />
        {t("connect.footerRails")}
      </div>
    </OnboardingShell>
  );
}

function FediOnlyConnectButton({
  loading,
  onConnect,
}: {
  loading: boolean;
  onConnect: () => void;
}) {
  const { t } = useT();
  return (
    <div style={{ width: "100%", maxWidth: 360 }}>
      <button
        onClick={onConnect}
        disabled={loading}
        style={{
          width: "100%", padding: "16px", borderRadius: T.r,
          background: T.accent, border: "none", color: T.bg,
          fontFamily: T.sans, fontSize: 15, fontWeight: 800,
          cursor: loading ? "default" : "pointer",
        }}
      >
        {loading ? t("common.connecting") : t("connect.welcomeHome")}
      </button>
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.sans,
        textAlign: "center", marginTop: 12, lineHeight: 1.5,
      }}>
        {t("connect.fediBody")}
      </div>
    </div>
  );
}

function OnboardingShell({ children }: { children: ReactNode }) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      justifyContent: "center", minHeight: "100dvh", padding: "36px 18px",
      textAlign: "center",
      background: `linear-gradient(180deg, ${T.bg} 0%, ${T.surface} 46%, ${T.bg} 100%)`,
    }}>
      {children}
    </div>
  );
}

function WelcomeIntro({ onContinue }: { onContinue: () => void }) {
  const { t } = useT();
  return (
    <>
      <BrandHeader />

      <div style={{
        fontSize: 27, lineHeight: 1.12, color: T.text,
        fontFamily: T.sans, fontWeight: 900, marginBottom: 12,
        maxWidth: 360,
      }}>
        {t("connect.introTitle")}
      </div>
      <div style={{
        maxWidth: 340, color: T.muted, fontFamily: T.sans,
        fontSize: 14, lineHeight: 1.6, marginBottom: 22,
      }}>
        {t("connect.introBody")}{" "}
        <span style={{ color: T.text }}>{t("connect.introNeverHolds")}</span>
      </div>

      <div style={{
        display: "grid", gap: 8, width: "100%", maxWidth: 380,
        marginBottom: 16,
      }}>
        {INTRO_USE_CASES.map(({ vertical, titleKey, blurbKey, soon }) => (
          <div
            key={titleKey}
            style={{
              display: "flex", alignItems: "center", gap: 13,
              padding: "11px 13px", borderRadius: T.r,
              background: T.card, border: `1px solid ${T.border}`,
              textAlign: "left",
              opacity: soon ? 0.66 : 1,
            }}
          >
            <span style={{
              flexShrink: 0,
              width: 38, height: 38, borderRadius: T.rs,
              display: "flex", alignItems: "center", justifyContent: "center",
              lineHeight: 1,
              background: T.surface, border: `1px solid ${T.border}`,
            }}>
              <VerticalIcon vertical={vertical} size={32} />
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{
                display: "flex", alignItems: "center", gap: 7, fontFamily: T.sans,
                fontSize: 14, fontWeight: 800, color: T.text,
              }}>
                {t(titleKey)}
                {soon && (
                  <span style={{
                    fontFamily: T.mono, fontSize: 8.5, fontWeight: 800, letterSpacing: 0.6,
                    color: T.muted, border: `1px solid ${T.border}`, borderRadius: 99,
                    padding: "1px 6px", textTransform: "uppercase", flexShrink: 0,
                  }}>
                    {t("common.soon")}
                  </span>
                )}
              </span>
              <span style={{
                display: "block", fontFamily: T.sans,
                fontSize: 12, color: T.muted, marginTop: 1, lineHeight: 1.35,
              }}>
                {t(blurbKey)}
              </span>
            </span>
          </div>
        ))}
      </div>

      {/* The differentiator, stated where it reassures: every trade is
          2-of-3 escrow with a community arbiter, never custodied by us. */}
      <div style={{
        display: "flex", alignItems: "flex-start", gap: 11,
        width: "100%", maxWidth: 380, marginBottom: 24,
        padding: "12px 14px", borderRadius: T.r,
        background: T.accentDim, border: `1px solid ${T.accent}44`,
        textAlign: "left",
      }}>
        <span style={{ fontSize: 17, lineHeight: 1.2, flexShrink: 0 }}>🛡️</span>
        <span style={{
          fontFamily: T.sans, fontSize: 12, lineHeight: 1.5, color: T.text,
        }}>
          <span style={{ fontWeight: 800 }}>{t("connect.shieldTitle")}</span>{" "}
          <span style={{ color: T.muted }}>
            {t("connect.shieldBody")}
          </span>
        </span>
      </div>

      <button
        data-chama-shortcut="enter"
        onClick={onContinue}
        style={{
          width: "100%", maxWidth: 380, padding: "16px",
          borderRadius: T.r, background: T.accent, border: "none",
          color: T.bg, fontFamily: T.sans, fontSize: 15, fontWeight: 800,
          cursor: "pointer",
        }}
      >
        {t("connect.getStarted")}
      </button>

      <div style={{
        marginTop: 14, fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 0.4, lineHeight: 1.6, maxWidth: 300,
      }}>
        {t("connect.footerTagline")}
      </div>
    </>
  );
}

function ErrorBox({ children }: { children: string }) {
  return (
    <div style={{
      padding: "10px 16px", borderRadius: T.rs, marginBottom: 16,
      background: T.redDim, border: `1px solid ${T.red}33`,
      color: T.red, fontSize: 11, fontFamily: T.mono,
      maxWidth: 340, wordBreak: "break-word",
    }}>
      {children}
    </div>
  );
}

function InstructionBox({ children }: { children: string }) {
  return (
    <div style={{
      padding: "12px 14px", borderRadius: T.rs, marginBottom: 2,
      background: T.accentDim, border: `1px solid ${T.accent}55`,
      color: T.text, fontSize: 12, fontFamily: T.sans,
      lineHeight: 1.5,
    }}>
      {children}
    </div>
  );
}

// i18n: takes the live t so the friendly rewrite follows the app language.
// The regex matches the RAW (English) error messages thrown by the sign-in
// paths — those stay untranslated internals; only the user-facing rewrite
// goes through the dictionary.
function friendlySignInError(message: string, t: TFunc): string {
  if (/No Nostr signer|NIP-07|open in Fedi|Amber|browser signer|No browser environment/i.test(message)) {
    return t("connect.errorNoSigner");
  }
  return message;
}
