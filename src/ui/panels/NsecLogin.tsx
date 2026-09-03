import { useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { isTauriRuntime } from "../sign-in-environment.js";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";
import { useT } from "../../i18n/index.js";

export function NsecLogin({
  onSubmit,
  defaultOpen = false,
  friendly = false,
  friendlySecondary,
  allowCreate = true,
  minimalPaste = false,
  autoFocusInput = false,
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
  // v2.5: no more "Remember me" toggle. On native we always persist the key to
  // secure storage so auto-login just works next launch (sign-out is the
  // forget switch); on web nothing is persisted regardless. Simpler, and it's
  // what people expect on their own phone.
  const remember = isNative;
  const [generatedNsec, setGeneratedNsec] = useState<string | null>(null);
  const [backupActionDone, setBackupActionDone] = useState(false);
  const [backupVerification, setBackupVerification] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const autoSubmittedKeyRef = useRef<string | null>(null);
  const credentialUsernameRef = useRef<HTMLInputElement | null>(null);
  const [credentialUsername, setCredentialUsername] = useState("Chama Nostr account");

  const identifyCredential = async (secretKey: Uint8Array): Promise<string> => {
    const [{ getPublicKey }, { nip19 }] = await Promise.all([
      import("nostr-tools/pure"),
      import("nostr-tools"),
    ]);
    const username = nip19.npubEncode(getPublicKey(secretKey));
    setCredentialUsername(username);
    // Password managers inspect the form at submission time. React's state
    // render may not have flushed yet, so update the actual form control too.
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
      setBackupActionDone(false);
      setBackupVerification("");
      setShowKey(true);
    } catch (e: any) {
      setGenerateError(e?.message || t("chat.couldNotCreateKey"));
    } finally {
      setGenerating(false);
    }
  };

  const handleSubmit = async () => {
    if (!nsecInput.trim()) return;
    if (generatedNsec && nsecInput.trim() === generatedNsec
      && (!backupActionDone || backupVerification.trim() !== generatedNsec)) return;
    const validated = await validateRecoveryKeyInput(nsecInput);
    if (!validated.ok) {
      setInputError(validated.error);
      return;
    }
    setInputError(null);
    await identifyCredential(validated.secretKey);
    // v2.5: tell the shell whether this key was generated in Chama (so only
    // generated keys get the master-key reveal in Me › Advanced). The submitted
    // key matching the just-generated one is the signal.
    const wasGenerated = generatedNsec !== null && nsecInput.trim() === generatedNsec;
    await onSubmit(nsecInput.trim(), remember, wasGenerated);
  };

  const generatedActive = generatedNsec !== null && nsecInput.trim() === generatedNsec;
  const backupVerified = generatedActive
    && backupActionDone
    && backupVerification.trim() === generatedNsec;
  const submitDisabled = !nsecInput.trim() || (generatedActive && !backupVerified);
  const showPasteInput = !generatedActive || mode === "paste";

  useEffect(() => {
    const value = nsecInput.trim();
    if (!showPasteInput || !value || generatedActive) return;
    if (generatedNsec && value === generatedNsec && !backupVerified) return;
    if (autoSubmittedKeyRef.current === value) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const validated = await validateRecoveryKeyInput(value);
      if (cancelled || !validated.ok) return;
      await identifyCredential(validated.secretKey);
      if (cancelled) return;
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
    generatedNsec,
    backupVerified,
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
                setBackupActionDone(false);
                setBackupVerification("");
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

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void handleSubmit();
      }}
      style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}
    >
      {/* A real username/password form is the contract used by browser and
          Android WebView autofill. The npub labels the saved account without
          exposing the nsec twice. Keep it visually hidden, not type=hidden,
          because password managers ignore hidden credential controls. */}
      <input
        ref={credentialUsernameRef}
        name="username"
        value={credentialUsername}
        readOnly
        autoComplete="username"
        aria-label="Nostr public account"
        tabIndex={-1}
        style={{
          position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
          overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap",
          border: 0,
        }}
      />
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
            setBackupActionDone(false);
            setBackupVerification("");
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
            name="password"
            value={nsecInput}
            onChange={(e) => {
              setNsecInput(e.target.value);
              setInputError(null);
              if (generatedNsec && e.target.value.trim() !== generatedNsec) {
                setGeneratedNsec(null);
                setBackupActionDone(false);
                setBackupVerification("");
              }
            }}
            onKeyDown={(e) => e.key === "Enter" && void handleSubmit()}
            placeholder={t("chat.pasteRecoveryKey")}
            type={showKey ? "text" : "password"}
            autoComplete={generatedActive ? "new-password" : "current-password"}
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
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <CopyButton
              value={generatedNsec ?? ""}
              disabled={!generatedNsec}
              label={t("chat.copyKey")}
              copiedLabel={t("chat.copiedKey")}
              onCopied={() => {
                setBackupActionDone(true);
                setBackupVerification("");
              }}
              style={{
                padding: "9px 14px", flexShrink: 0,
                background: T.surface, border: `1px solid ${T.borderHi}`,
                borderRadius: T.rs, color: T.text,
                fontFamily: T.sans, fontSize: 12, fontWeight: 700,
                cursor: "pointer",
              }}
            />
            <span style={{
              color: backupActionDone ? T.green : T.muted,
              fontSize: 12, fontFamily: T.sans, fontWeight: 700,
            }}>
              {backupActionDone ? t("chat.copyDone") : t("chat.copyFirst")}
            </span>
          </div>
          {backupActionDone && (
            <label style={{ display: "block", marginTop: 12 }}>
              <span style={{
                display: "block", color: T.text, fontSize: 12,
                fontFamily: T.sans, fontWeight: 700, marginBottom: 7,
              }}>
                {backupVerified ? t("chat.keyVerified") : t("chat.verifyKey")}
              </span>
              <input
                name="password"
                value={backupVerification}
                onChange={(e) => setBackupVerification(e.target.value)}
                placeholder={t("chat.verifyKeyPlaceholder")}
                type="password"
                autoComplete="new-password"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "12px 13px",
                  background: T.bg,
                  border: `1px solid ${backupVerified ? T.green : T.border}`,
                  borderRadius: T.rs, color: T.text, fontFamily: T.mono,
                  fontSize: 12, outline: "none",
                }}
              />
            </label>
          )}
          <div style={{
            marginTop: 10, color: T.muted, fontSize: 10,
            fontFamily: T.sans, lineHeight: 1.5,
          }}>
            {t("chat.passwordManagerHint")}
          </div>
        </div>
      )}

      {/* v2.5: minimalPaste (the returning-user box attached to "I'm a
          returning Chama citizen") drops the Continue button entirely —
          a valid paste auto-submits, and Enter also works — and the
          footer, so the user just pastes and is in. The Continue stays
          for the generation flow (where an explicit "I saved it" confirm
          is required) and the native sign-in. */}
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
