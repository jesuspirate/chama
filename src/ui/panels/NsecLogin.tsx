import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { isTauriRuntime } from "../sign-in-environment.js";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";
import { useT } from "../../i18n/index.js";

// ── v6.4 runway #13 (revised 2026-09-19): the app keeps the key ────────────
// Every client — browser, PWA, APK, Tauri, Start9's served page — persists the
// nsec on login by default. The opt-out lives HERE, as a pre-checked "keep me
// signed in" checkbox on the login screen itself — no extra screen after
// login; you land straight on Browse. The copy-then-re-paste ritual stays
// retired, and the paste field is a real current-password control so a manager
// can FILL a key the user saved themselves — import restored (Jet, 2026-09-18).
// The v6.3.x SAVE apparatus is back for exactly one moment: the instant Chama
// generates a brand-new key (Jet, 2026-09-19 — "it's our last shot"; the app is
// non-custodial and may never raise the key again). That moment gets
// credentials.store() on Chromium and the credential pair + unmount + same-URL
// History push WebKit needs. Nothing else prompts: pasting a key you already
// have never offers to save it.
export function NsecLogin({
  onSubmit,
  defaultOpen = false,
  friendly = false,
  friendlySecondary,
  allowCreate = true,
  minimalPaste = false,
  autoFocusInput = false,
  keepKey: keepKeyProp,
  onKeepKeyChange,
  choiceFooter,
}: {
  onSubmit: (nsec: string, remember: boolean, wasGenerated: boolean) => void | Promise<void>;
  defaultOpen?: boolean;
  friendly?: boolean;
  friendlySecondary?: {
    label: string;
    hint?: string;
    onClick: () => void;
    disabled?: boolean;
    tone?: "accent" | "neutral";
  };
  allowCreate?: boolean;
  minimalPaste?: boolean;
  /** Focus the recovery field when this instance mounts. */
  autoFocusInput?: boolean;
  /** Controlled "keep me signed in" (ConnectScreen owns ONE toggle for the
   *  whole screen, so the two NsecLogin instances can't each draw their own —
   *  the duplicate boxes Jet caught, 2026-09-18). When provided, this panel
   *  renders no checkbox of its own. */
  keepKey?: boolean;
  onKeepKeyChange?: (keep: boolean) => void;
  // Overrides the choice-mode footer copy. ConnectScreen swaps in
  // recovery-specific guidance once "I'm a returning Chama citizen" reveals
  // the paste box, so the "we'll create a key" line never sits above a box
  // that's asking for an existing one.
  choiceFooter?: ReactNode;
}) {
  const { t } = useT();
  const isNative = Capacitor.isNativePlatform() || isTauriRuntime();
  const [showNsec, setShowNsec] = useState(isNative || defaultOpen || friendly);
  const [mode, setMode] = useState<"choice" | "create" | "paste">(
    friendly ? "choice" : "paste",
  );
  const [nsecInput, setNsecInput] = useState("");
  // Runway #13 (revised): keep-by-default, opt-out on the login screen itself.
  // Controlled by ConnectScreen where one toggle serves the whole screen;
  // uncontrolled (with its own checkbox) for any standalone use.
  const [keepKeyOwn, setKeepKeyOwn] = useState(true);
  const controlledKeep = keepKeyProp !== undefined && onKeepKeyChange !== undefined;
  const keepKey = controlledKeep ? keepKeyProp! : keepKeyOwn;
  const setKeepKey = controlledKeep ? onKeepKeyChange! : setKeepKeyOwn;
  const remember = keepKey;
  const [generatedNsec, setGeneratedNsec] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  // True from the instant a valid submit is accepted: swaps the form for the
  // signing-in placeholder while the shell boots the wallet behind it.
  const [handoffDone, setHandoffDone] = useState(false);
  const autoSubmittedKeyRef = useRef<string | null>(null);
  // The npub labels the saved credential so a manager entry reads as an
  // account, not an opaque secret. Kept in a ref too: managers inspect the
  // form at SUBMIT time, which can precede React's next render.
  const credentialUsernameRef = useRef<HTMLInputElement | null>(null);
  const [credentialUsername, setCredentialUsername] = useState("Chama Nostr account");
  // Chromium exposes the Credential Management API; WebKit does not. Where it
  // exists we save through it EXCLUSIVELY — rendering the WebKit-heuristic
  // fields too made Android show TWO Bitwarden prompts at once (Jet's
  // GrapheneOS recording, v6.3.1).
  const supportsCredentialStore =
    typeof (globalThis as any).PasswordCredential === "function"
    && !!(navigator as any).credentials?.store;

  const identifyCredential = async (secretKey: Uint8Array): Promise<string> => {
    const [{ getPublicKey }, { nip19 }] = await Promise.all([
      import("nostr-tools/pure"),
      import("nostr-tools"),
    ]);
    const username = nip19.npubEncode(getPublicKey(secretKey));
    setCredentialUsername(username);
    if (credentialUsernameRef.current) credentialUsernameRef.current.value = username;
    return username;
  };

  const handleGenerate = async () => {
    setMode("create");
    setGenerating(true);
    setGenerateError(null);
    setInputError(null);
    try {
      const [{ generateSecretKey }, { nip19 }] = await Promise.all([
        import("nostr-tools/pure"),
        import("nostr-tools"),
      ]);
      const secretKey = generateSecretKey();
      const nsec = nip19.nsecEncode(secretKey);
      await identifyCredential(secretKey);
      setNsecInput(nsec);
      setGeneratedNsec(nsec);
      setShowKey(true);
    } catch (e: any) {
      setGenerateError(e?.message || t("chat.couldNotCreateKey"));
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!nsecInput.trim()) return;
    const validated = await validateRecoveryKeyInput(nsecInput);
    if (!validated.ok) {
      setInputError(validated.error);
      return;
    }
    setInputError(null);
    // Tell the shell whether this key was generated in Chama (so only
    // generated keys get the master-key reveal in Me › Advanced). The
    // submitted key matching the just-generated one is the signal.
    const wasGenerated = generatedNsec !== null && nsecInput.trim() === generatedNsec;

    // ── The one save offer we make (creation only) ──────────────────────
    // Two engines, two contracts. Chromium/Android WebView store the pair
    // explicitly — no heuristics. iOS/macOS Safari has no credentials.store and
    // decides to offer a save when a submitted form's credential fields LEAVE
    // the DOM or the page navigates; handoffDone unmounts them immediately and
    // the same-URL History push below is the SPA-legal "login succeeded"
    // signal WebKit actually releases the offer on (field-verified, v6.3.2).
    // A refusal never blocks sign-in, and a PASTED key never reaches here.
    if (wasGenerated) {
      const username = await identifyCredential(validated.secretKey);
      try {
        const CredCtor = (globalThis as any).PasswordCredential;
        if (CredCtor && (navigator as any).credentials?.store) {
          await (navigator as any).credentials.store(new CredCtor({
            id: username,
            name: "Chama recovery key",
            password: nsecInput.trim(),
          }));
        }
      } catch {
        // Optional enhancement only.
      }
    }

    (document.activeElement as HTMLElement | null)?.blur?.();
    setHandoffDone(true);
    if (wasGenerated) {
      try {
        history.pushState({ chamaSignedIn: true }, "", window.location.href);
      } catch { /* cosmetic only */ }
    }
    try {
      await onSubmit(nsecInput.trim(), remember, wasGenerated);
    } catch (e: any) {
      // Bring the form back — a failed boot must never strand the user on
      // the handoff placeholder.
      setHandoffDone(false);
      setInputError(e?.message || String(e));
    }
  };

  const generatedActive = generatedNsec !== null && nsecInput.trim() === generatedNsec;
  const submitDisabled = !nsecInput.trim();
  const showPasteInput = !generatedActive || mode === "paste";

  useEffect(() => {
    const value = nsecInput.trim();
    if (!showPasteInput || !value || generatedActive) return;
    if (autoSubmittedKeyRef.current === value) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const validated = await validateRecoveryKeyInput(value);
      if (cancelled || !validated.ok) return;
      autoSubmittedKeyRef.current = value;
      setInputError(null);
      // Auto-submit only fires for a PASTED key (gated on !generatedActive
      // above), so it's never the Chama-generated one.
      onSubmit(value, remember, false);
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    nsecInput,
    showPasteInput,
    generatedActive,
    remember,
    onSubmit,
  ]);

  if (!showNsec) {
    return (
      <div
        onClick={() => setShowNsec(true)}
        style={{
          marginTop: 8, fontSize: 10, color: T.muted,
          fontFamily: T.mono, cursor: "pointer",
          transition: "color 0.2s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = T.text)}
        onMouseLeave={(e) => (e.currentTarget.style.color = T.muted)}
      >
        {t("chat.useExistingAccount")}
      </div>
    );
  }

  if (friendly && mode === "choice") {
    const secondaryAccent = friendlySecondary?.tone === "accent";
    return (
      <div style={{ width: "100%", maxWidth: 360 }}>
        <button
          onClick={handleGenerate}
          disabled={generating}
          style={{
            width: "100%", padding: "16px", borderRadius: T.r,
            background: T.accent, border: "none", color: T.bg,
            fontFamily: T.sans, fontSize: 15, fontWeight: 800,
            cursor: generating ? "default" : "pointer",
            marginBottom: 10,
          }}
        >
          {generating ? t("chat.creating") : t("chat.createMyAccount")}
        </button>
        <button
          onClick={friendlySecondary
            ? friendlySecondary.onClick
            : () => {
                setMode("paste");
                setGeneratedNsec(null);
                setInputError(null);
              }}
          disabled={friendlySecondary?.disabled}
          style={{
            width: "100%", padding: "13px", borderRadius: T.r,
            background: secondaryAccent ? T.accentDim : T.surface,
            border: `1px solid ${secondaryAccent ? `${T.accent}99` : T.border}`,
            color: friendlySecondary?.disabled ? T.muted : secondaryAccent ? T.accent : T.text,
            fontFamily: T.sans, fontSize: 13,
            fontWeight: 700,
            cursor: friendlySecondary?.disabled ? "default" : "pointer",
          }}
        >
          <span style={{ display: "block" }}>
            {friendlySecondary?.label ?? t("chat.haveKey")}
          </span>
          {friendlySecondary?.hint && (
            <span style={{ display: "block", marginTop: 3, fontSize: 10, fontWeight: 500, color: T.muted }}>
              ({friendlySecondary.hint})
            </span>
          )}
        </button>
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.sans,
          textAlign: "center", marginTop: 12, lineHeight: 1.5,
        }}>
          {choiceFooter ?? t("chat.keyChoiceFooter")}
        </div>
        {generateError && <InlineError>{generateError}</InlineError>}
      </div>
    );
  }

  if (handoffDone) {
    // Post-submit handoff: the shell is booting the wallet behind this. The
    // key is being kept on this device (default) — the keep-notice on the
    // next screen is where the user can say no.
    return (
      <div style={{
        marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360,
        padding: "28px 0", textAlign: "center", color: T.muted,
        fontFamily: T.mono, fontSize: 12,
      }}>
        <div>{t("chat.signingIn")}</div>
        {generatedActive && (
          <div style={{
            marginTop: 12, color: T.text, fontFamily: T.sans, fontSize: 13,
            lineHeight: 1.5,
          }}>
            {t("chat.saveOfferHint")}
          </div>
        )}
        {keepKey && !generatedActive && (
          <div style={{
            marginTop: 12, color: T.text, fontFamily: T.sans, fontSize: 13,
            lineHeight: 1.5,
          }}>
            {t("chat.keySavedHint")}
          </div>
        )}
      </div>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      autoComplete="off"
      style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}
    >
      {/* Creation-only credential pair. A real username/password pair at
          submit time is the contract browser and Android WebView autofill
          use; the npub labels the saved account without exposing the nsec
          twice. Visually hidden, never type="hidden" (managers ignore hidden
          credential controls) and never focusable (so iOS's strong-password
          sheet can't attach). Rendered ONLY while a freshly generated key is
          on screen, so the paste path stays free of save prompts — and only
          where credentials.store() is absent, because rendering both made
          Android fire two prompts at once. */}
      {generatedActive && !supportsCredentialStore && (
        <>
          <input
            ref={credentialUsernameRef}
            name="username"
            value={credentialUsername}
            readOnly
            autoComplete="username"
            aria-label="Nostr public account"
            tabIndex={-1}
            style={HIDDEN_CREDENTIAL_STYLE}
          />
          {!showPasteInput && (
            <input
              name="password"
              type="password"
              value={nsecInput}
              readOnly
              autoComplete="new-password"
              aria-hidden="true"
              tabIndex={-1}
              style={HIDDEN_CREDENTIAL_STYLE}
            />
          )}
        </>
      )}
      {isNative && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 8, textAlign: "center",
        }}>
          {t("chat.signIn")}
        </div>
      )}

      {friendly && (
        <button
          type="button"
          onClick={() => {
            setMode("choice");
            setNsecInput("");
            setGeneratedNsec(null);
            setInputError(null);
          }}
          style={{
            background: "transparent", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 10, cursor: "pointer",
            marginBottom: 10,
          }}
        >
          {t("chat.back")}
        </button>
      )}

      {showPasteInput && (
        <>
          <input
            /* A real current-password control, so password managers OFFER TO
               FILL a key the user saved themselves (import restored, Jet
               2026-09-18). current-password never summons iOS's
               strong-password sheet — that hijack rode new-password — and
               with no username field and no credentials.store() there is no
               deterministic save prompt of ours; anything beyond that is the
               browser's own sign-in behavior. */
            name="password"
            value={nsecInput}
            onChange={(e) => {
              setNsecInput(e.target.value);
              setInputError(null);
              if (generatedNsec && e.target.value.trim() !== generatedNsec) {
                setGeneratedNsec(null);
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
            placeholder={t("chat.pasteRecoveryKey")}
            type={showKey ? "text" : "password"}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocusInput}
            style={{
              width: "100%", padding: "14px 16px", boxSizing: "border-box",
              background: T.surface, border: `1px solid ${inputError ? T.red : T.border}`,
              borderRadius: T.rs, color: T.text,
              fontFamily: T.mono, fontSize: 12, outline: "none",
              marginBottom: 8,
            }}
          />
          <div style={{
            display: "flex", gap: 8, marginBottom: 8,
            justifyContent: allowCreate ? "stretch" : "flex-end",
          }}>
            {allowCreate && (
              <button
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  flex: 1, padding: "10px 12px",
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: T.rs, color: T.text,
                  fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  cursor: generating ? "default" : "pointer",
                }}
              >
                {generating ? t("chat.creating") : t("chat.createNewAccount")}
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowKey(!showKey)}
              disabled={!nsecInput.trim()}
              style={{
                width: allowCreate ? 92 : 120, padding: "10px 12px",
                background: "transparent", border: `1px solid ${T.border}`,
                borderRadius: T.rs, color: nsecInput.trim() ? T.muted : T.muted + "66",
                fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                cursor: nsecInput.trim() ? "pointer" : "default",
              }}
            >
              {showKey ? t("chat.hide") : t("chat.show")}
            </button>
          </div>
        </>
      )}

      {generateError && <InlineError>{generateError}</InlineError>}
      {inputError && <InlineError>{inputError}</InlineError>}

      {generatedActive && (
        <div style={{
          marginBottom: 12, padding: 16,
          background: T.amberDim, border: `1px solid ${T.amber}55`,
          borderRadius: T.r, textAlign: "left",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>🔑</span>
            <span style={{ fontSize: 15, fontWeight: 800, color: T.text, fontFamily: T.sans }}>
              {t("chat.saveRecoveryKey")}
            </span>
          </div>
          <div style={{
            fontSize: 13, color: T.muted, fontFamily: T.sans,
            lineHeight: 1.55, marginBottom: 12,
          }}>
            {t("chat.keyOnlyBefore")}
            <span style={{ color: T.text, fontWeight: 700 }}>
              {t("chat.keyOnlyBold")}
            </span>{t("chat.keyOnlyAfter")}
          </div>
          <div style={{
            fontSize: 11, color: T.text, fontFamily: T.mono,
            lineHeight: 1.55, wordBreak: "break-all",
            padding: 12, background: T.bg, border: `1px solid ${T.border}`,
            borderRadius: T.rs, marginBottom: 11,
          }}>
            {generatedNsec}
          </div>
          {/* Runway #13: a plain copy button, full stop. No copy-gating, no
              re-paste verification, no password-manager hint. The app keeps
              the key on this device; this button is for whoever also wants
              their own external copy. */}
          <CopyButton
            value={generatedNsec ?? ""}
            disabled={!generatedNsec}
            label={t("chat.copyKey")}
            copiedLabel={t("chat.copiedKey")}
            style={{
              padding: "9px 14px", flexShrink: 0,
              background: T.surface, border: `1px solid ${T.borderHi}`,
              borderRadius: T.rs, color: T.text,
              fontFamily: T.sans, fontSize: 12, fontWeight: 700,
              cursor: "pointer",
            }}
          />
        </div>
      )}

      {/* Runway #13 (revised): the keep choice IS the login screen — one
          pre-checked box, no screen after. Unchecking = paste-every-time.
          Hidden when ConnectScreen owns the toggle for the whole screen. */}
      {!controlledKeep && <label style={{
        display: "flex", alignItems: "center", gap: 9, margin: "2px 0 12px",
        cursor: "pointer", fontFamily: T.sans, fontSize: 12.5, color: T.text,
        userSelect: "none",
      }}>
        <input
          type="checkbox"
          checked={keepKey}
          onChange={e => setKeepKey(e.target.checked)}
          style={{ width: 17, height: 17, accentColor: T.accent, cursor: "pointer", margin: 0 }}
        />
        <span>
          {t("chat.keepSignedIn")}
          <span style={{ display: "block", fontSize: 10.5, color: T.muted, marginTop: 1 }}>
            {keepKey ? t("chat.keepSignedInHintOn") : t("chat.keepSignedInHintOff")}
          </span>
        </span>
      </label>}

      {/* v2.5: minimalPaste (the returning-user box attached to "I'm a
          returning Chama citizen") drops the Continue button entirely —
          a valid paste auto-submits, and Enter also works — and the
          footer, so the user just pastes and is in. The Continue stays
          for the generation flow and the native sign-in. */}
      {!minimalPaste && (
        <button
          type="submit"
          disabled={submitDisabled}
          style={{
            width: "100%", padding: "14px",
            background: !submitDisabled ? T.accent : T.surface,
            border: `1px solid ${!submitDisabled ? T.accent : T.border}`,
            borderRadius: T.rs, color: !submitDisabled ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 13, fontWeight: 700,
            cursor: !submitDisabled ? "pointer" : "default",
            letterSpacing: 0.5,
            transition: "all 0.2s",
          }}
        >
          {generatedActive ? t("chat.continueWithKey") : t("chat.continue")}
        </button>
      )}
      {!minimalPaste && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.sans,
          textAlign: "center", marginTop: 10, lineHeight: 1.5,
        }}>
          {generatedActive
            ? (isNative
                ? t("chat.footerGeneratedNative")
                : t("chat.footerGeneratedWeb"))
            : (isNative
                ? t("chat.footerPasteNative")
                : t("chat.footerPasteWeb"))}
        </div>
      )}
    </form>
  );
}

/** Visually hidden, but a REAL control — password managers skip
 *  display:none / type=hidden credential fields. */
const HIDDEN_CREDENTIAL_STYLE: CSSProperties = {
  position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
  overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0,
};

function InlineError({ children }: { children: string }) {
  return (
    <div style={{
      marginBottom: 8, padding: "8px 10px",
      background: T.redDim, border: `1px solid ${T.red}33`,
      borderRadius: T.rs, color: T.red,
      fontSize: 10, fontFamily: T.mono,
    }}>
      {children}
    </div>
  );
}
