import { useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { NsecLogin } from "../panels/NsecLogin.js";
import { PaymentButton } from "../components/PaymentCard.js";
import { BrandHeader } from "../components/BrandHeader.js";
import { LanguagePills } from "../components/LanguagePills.js";
import { useT, type TFunc } from "../../i18n/index.js";
import { getSignInEnvironment, isFediWebViewSignInEnvironment, isTauriRuntime } from "../sign-in-environment.js";
import { isNativeBridgeModeOn } from "../../fedimint/native-bridge-adapter.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getUserCommunitySlugRaw, getLastHomeHint } from "../../communities/storage.js";
import { resolveJoiningCommunitySlug } from "../../communities/joining-default.js";
import { getPendingCommunityReport } from "../../communities/community-request.js";

function isExplicitFedimintRecoveryDiagnostic(): boolean {
  try {
    return !!(import.meta as any).env?.DEV
      && new URLSearchParams(window.location.search).get("forceFedimintRecovery") === "1";
  } catch { return false; }
}

type Door = "create" | "returning";
type KeySubmit = (nsec: string, remember: boolean, wasGenerated: boolean) => void | Promise<void>;

/** Only the selected door mounts credential controls. Stored-key startup stays in App. */
export function ConnectScreen({ onConnect, onConnectNsec, loading, error }: {
  onConnect: () => void;
  onConnectNsec: (nsec: string, remember: boolean, wasGenerated: boolean, fastSetup?: boolean, setupCommunity?: string) => void | Promise<void>;
  loading: boolean;
  error: string | null;
}) {
  const { t } = useT();
  const isNative = Capacitor.isNativePlatform() || isTauriRuntime() || isNativeBridgeModeOn();
  const signInEnvironment = { ...getSignInEnvironment(), isNativePlatform: isNative };
  const isFediWebView = isFediWebViewSignInEnvironment(signInEnvironment);
  const hasHomeHint = !!(getUserCommunitySlugRaw() ?? getLastHomeHint());
  const [homeSlug] = useState(resolveJoiningCommunitySlug);
  const homeCommunity = homeSlug ? getCommunityBySlug(homeSlug) : null;
  const pendingReport = getPendingCommunityReport();
  const [door, setDoor] = useState<Door | null>(null);
  const [choosing, setChoosing] = useState<Door | null>(null);
  const [keepKey, setKeepKey] = useState(true);
  const [extensionAttempted, setExtensionAttempted] = useState(false);
  const [keyAttempted, setKeyAttempted] = useState(false);
  const choiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (choiceTimer.current !== null) clearTimeout(choiceTimer.current); }, []);
  const choose = (next: Door) => {
    if (choosing) return;
    setExtensionAttempted(false);
    setKeyAttempted(false);
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { setDoor(next); return; }
    setChoosing(next);
    choiceTimer.current = setTimeout(() => { setDoor(next); setChoosing(null); choiceTimer.current = null; }, 250);
  };
  const submitNsec: KeySubmit = (nsec, remember, wasGenerated) => {
    setExtensionAttempted(false);
    setKeyAttempted(true);
    // Keep the default fast setup; the two doors do not expose setup machinery.
    return onConnectNsec(nsec, remember, wasGenerated, door === "create" || !hasHomeHint, homeSlug);
  };
  const hasExtension = typeof window !== "undefined" && !!(window as any).nostr && !isExplicitFedimintRecoveryDiagnostic();

  return <OnboardingShell>
    <BrandHeader />
    <style>{`
      .connect-choice{display:grid;grid-template-rows:1fr;opacity:1;margin-bottom:12px;transition:grid-template-rows .25s ease,opacity .25s ease,margin .25s ease}
      .connect-choice-away{grid-template-rows:0fr;opacity:0;margin-bottom:0;pointer-events:none}
      .connect-choice>div{min-height:0;overflow:visible}
      .connect-choice-away>div{overflow:hidden}
      @keyframes connect-flow{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      .connect-flow{animation:connect-flow .25s ease-out}
      @media(prefers-reduced-motion:reduce){.connect-choice{transition:none}.connect-flow{animation:none}}
    `}</style>
    {isFediWebView ? <>
      {error && <ErrorBox>{friendlySignInError(error, t)}</ErrorBox>}
      <FediOnlyConnectButton loading={loading} onConnect={onConnect} />
    </> : !door ? <div data-connect-chooser style={{ width: "100%", maxWidth: 360 }}>
      {homeCommunity && <div style={{ marginBottom: 18, padding: 14, borderRadius: T.r, background: T.surface, border: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 10, textAlign: "left" }}>
        <span style={{ fontSize: 24 }}>{homeCommunity.flagEmoji}</span>
        <div><div style={{ fontSize: 12, fontWeight: 800 }}>{homeCommunity.displayName}</div>
          {hasHomeHint && <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>{t("connect.lastChamaHere")}</div>}</div>
      </div>}
      <p style={{ fontSize: 14, color: T.muted, lineHeight: 1.8, margin: "0 0 26px" }}>
        {pendingReport ? t("connect.pendingReportSignIn", { chama: pendingReport.requestedChama }) : <>{t("connect.tagline1")}<br /><span style={{ color: T.text }}>{t("connect.tagline2")}</span></>}
      </p>
      {(["create", "returning"] as const).map(next => <div key={next} className={`connect-choice${choosing && choosing !== next ? " connect-choice-away" : ""}`} aria-hidden={!!choosing && choosing !== next}>
        <div><PaymentButton type="button" data-connect-door={next} onClick={() => choose(next)} disabled={!!choosing || loading}
          style={{ width: "100%", padding: 16, borderRadius: 999, background: next === "create" ? T.accent : T.surface, border: `1px solid ${next === "create" ? T.accent : T.border}`, color: next === "create" ? T.bg : T.text, font: `800 15px ${T.sans}` }}>
          {t(next === "create" ? "chooser.become" : "chooser.citizen")}
        </PaymentButton></div>
      </div>)}
      <div data-connect-language style={{ marginTop: 8 }}><LanguagePills /></div>
    </div> : <div className="connect-flow" style={{ width: "100%", maxWidth: 360, textAlign: "left" }}>
      <button type="button" data-connect-back disabled={loading} onClick={() => { setDoor(null); setExtensionAttempted(false); setKeyAttempted(false); }}
        style={{ border: "none", background: "none", padding: "0 0 14px", color: T.muted, font: `12px ${T.sans}`, cursor: "pointer" }}>{t("chat.back")}</button>
      {door === "create" ? <CreateAccountFlow onSubmit={submitNsec} keepKey={keepKey} onKeepKeyChange={setKeepKey} />
        : <ReturningAccountFlow onSubmit={submitNsec} keepKey={keepKey} onKeepKeyChange={setKeepKey}
            hasExtension={hasExtension} loading={loading} error={extensionAttempted ? error : null}
            onExtension={() => { setExtensionAttempted(true); onConnect(); }} />}
      {error && keyAttempted && !extensionAttempted && <ErrorBox>{friendlySignInError(error, t)}</ErrorBox>}
    </div>}
  </OnboardingShell>;
}

function CreateAccountFlow({ onSubmit, keepKey, onKeepKeyChange }: { onSubmit: KeySubmit; keepKey: boolean; onKeepKeyChange: (keep: boolean) => void }) {
  return <div data-connect-flow="create">
    <NsecLogin onSubmit={onSubmit} createOnMount keepKey={keepKey} onKeepKeyChange={onKeepKeyChange} />
    <KeepSignedIn checked={keepKey} onChange={onKeepKeyChange} />
  </div>;
}

function ReturningAccountFlow({ onSubmit, keepKey, onKeepKeyChange, hasExtension, loading, error, onExtension }: {
  onSubmit: KeySubmit; keepKey: boolean; onKeepKeyChange: (keep: boolean) => void;
  hasExtension: boolean; loading: boolean; error: string | null; onExtension: () => void;
}) {
  const { t } = useT();
  return <div data-connect-flow="returning">
    <h2 data-connect-home-heading style={{ margin: "0 0 8px", font: `800 16px ${T.sans}`, color: T.text }}>{t("connect.homeHeading")}</h2>
    <p style={{ margin: "0 0 12px", fontSize: 13, color: T.muted, lineHeight: 1.6 }}>{t("connect.pastePrimary")}</p>
    <NsecLogin onSubmit={onSubmit} keepKey={keepKey} onKeepKeyChange={onKeepKeyChange} defaultOpen allowCreate={false} minimalPaste />
    <KeepSignedIn checked={keepKey} onChange={onKeepKeyChange} />
    {hasExtension && <div style={{ marginTop: 20 }}>
      <PaymentButton type="button" data-extension-sign-in onClick={onExtension} disabled={loading}
        style={{ width: "100%", padding: 14, borderRadius: 999, border: `1px solid ${T.border}`, background: T.surface, color: T.text, font: `700 13px ${T.sans}` }}>
        {t("connect.browserExtension")}
      </PaymentButton>
      {error && <p role="alert" style={{ fontSize: 12, color: T.red, lineHeight: 1.5 }}>{t("connect.signerRefused")}</p>}
      <p style={{ fontSize: 11, color: T.muted, lineHeight: 1.5 }}>{t("connect.extensionHint", { name: extensionName() })}</p>
    </div>}
  </div>;
}

function KeepSignedIn({ checked, onChange }: { checked: boolean; onChange: (keep: boolean) => void }) {
  const { t } = useT();
  return <label style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 12, font: `12.5px ${T.sans}`, color: T.text, cursor: "pointer" }}>
    <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} style={{ width: 17, height: 17, accentColor: T.accent, margin: 0 }} />
    {t("chat.keepSignedIn")}
  </label>;
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

function extensionName(): string {
  const provider = typeof window !== "undefined" ? (window as any).nostr : null;
  return typeof provider?.name === "string" ? provider.name.slice(0, 40) : "";
}
