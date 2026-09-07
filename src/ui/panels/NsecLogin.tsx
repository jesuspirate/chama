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
  // True from the instant a valid submit is accepted: swaps the credential
  // form out of the DOM so Safari's save-password heuristic gets its
  // completion signal NOW instead of on a later visibility change.
  const [handoffDone, setHandoffDone] = useState(false);
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
    const username = await identifyCredential(validated.secretKey);
    // v2.5: tell the shell whether this key was generated in Chama (so only
    // generated keys get the master-key reveal in Me › Advanced). The submitted
    // key matching the just-generated one is the signal.
    const wasGenerated = generatedNsec !== null && nsecInput.trim() === generatedNsec;

    // ── Make the password-manager save offer DETERMINISTIC (v6.3.2) ──
    // Two engines, two contracts:
    //  · Chromium / Android WebView (the APK): the Credential Management API
    //    stores the pair explicitly — no heuristics involved.
    //  · iOS/macOS Safari has no credentials.store; it decides to offer a save
    //    when a submitted form's credential fields LEAVE the DOM (or the page
    //    navigates). In this SPA the form used to stay mounted while the
    //    wallet booted, so Safari sat on the offer and fired it on a random
    //    visibility change (Jet's app-switching, v6.3.1 tunnel test).
    //    handoffDone below unmounts the credential fields immediately.
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
      // Optional enhancement only — a refusal or unsupported ctor never
      // blocks sign-in.
    }
    (document.activeElement as HTMLElement | null)?.blur?.();
    setHandoffDone(true);
    // WebKit batches its save-password decision and releases it on a
    // NAVIGATION, not on DOM teardown — field-verified: the sheet appeared
    // the instant a manual reload began. A same-URL History push is the
    // SPA-legal navigation signal both WebKit and Chromium accept as
    // "login succeeded, page moved on". Same URL, so routing is untouched;
    // worst case is one inert back-button entry.
    try {
      history.pushState({ chamaSignedIn: true }, "", window.location.href);
    } catch { /* cosmetic only */ }

    try {
      await onSubmit(nsecInput.trim(), remember, wasGenerated);
    } catch (e: any) {
      // Bring the form back — a failed boot must never strand the user on
      // the handoff placeholder.
      setHandoffDone(false);
      setInputError(e?.message || String(e));
    }
  };

  // Chromium exposes the Credential Management API; WebKit does not. Where
  // it exists we save through it EXCLUSIVELY — rendering the WebKit-heuristic
  // hidden password field too made Android show TWO Bitwarden prompts at
  // once (the store() dialog plus the autofill framework's bottom sheet —
  // Jet's GrapheneOS recording, v6.3.1 tunnel test).
  const supportsCredentialStore =
    typeof (globalThis as any).PasswordCredential === "function" &&
    !!(navigator as any).credentials?.store;

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

  if (handoffDone) {
    // Post-submit handoff: credential fields are gone (see handleSubmit);
    // the shell is booting the wallet behind this.
    return (
      <div style={{
        marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360,
        padding: "28px 0", textAlign: "center", color: T.muted,
        fontFamily: T.mono, fontSize: 12,
      }}>
        <div>{t("chat.signingIn")}</div>
        <div style={{
          marginTop: 12, color: T.text, fontFamily: T.sans, fontSize: 13,
          lineHeight: 1.5,
        }}>
          {t("chat.saveOfferHint")}
        </div>
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
      {/* v6.3.2 follow-up: in the GENERATED flow the visible paste input is
          not rendered and the verify field is deliberately invisible to
          password managers — which left the form with a username and NO
          password-classified control at submit, so Safari/Bitwarden had
          nothing to offer to save (the old flaky offer rode the verify
          field's name="password", the same attribute that summoned the
          strong-password hijack). This hidden-but-real field restores the
          username+password pair managers capture at submission. Never
          focusable, so iOS's strong-password sheet cannot attach to it. */}
      {generatedActive && !showPasteInput && !supportsCredentialStore && (
        <input
          name="password"
          type="password"
          value={nsecInput}
          readOnly
          autoComplete="new-password"
          aria-hidden="true"
          tabIndex={-1}
          style={{
            position: "absolute", width: 1, height: 1, padding: 0, margin: -1,
            overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap",
            border: 0,
          }}
        />
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
                /* This field PROVES the user manually saved their key — a
                   password manager filling it defeats the verification, and
                   name="password" + type="password" + new-password summoned
                   iOS's "Use Strong Password" sheet offering to REPLACE the
                   pasted nsec with a generated password (Jet's screenshot,
                   v6.3.1). type=text + -webkit-text-security keeps the
                   shoulder-surfing mask without tripping those heuristics;
                   the ignore attrs cover Bitwarden/1Password/LastPass. */
                name="nsec-backup-verification"
                value={backupVerification}
                onChange={(e) => setBackupVerification(e.target.value)}
                placeholder={t("chat.verifyKeyPlaceholder")}
                type="text"
                autoComplete="off"
                data-bwignore="true"
                data-1p-ignore="true"
                data-lpignore="true"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                style={{
                  width: "100%", boxSizing: "border-box", padding: "12px 13px",
                  background: T.bg,
                  border: `1px solid ${backupVerified ? T.green : T.border}`,
                  borderRadius: T.rs, color: T.text, fontFamily: T.mono,
                  fontSize: 12, outline: "none",
                  ...({ WebkitTextSecurity: "disc" } as React.CSSProperties),
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
