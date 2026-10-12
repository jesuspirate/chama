import { nip19 } from "nostr-tools";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { PaymentButton } from "../components/PaymentCard.js";
import { isTauriRuntime } from "../sign-in-environment.js";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";
import { useT } from "../../i18n/index.js";

// Save & continue submits visible credential fields; only Me can confirm a manager backup.
export function NsecLogin({
  onSubmit,
  onCreatingChange,
  defaultOpen = false,
  createOnMount = false,
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
  onCreatingChange?: (creating: boolean) => void;
  defaultOpen?: boolean;
  /** Mounted only after an explicit Become a citizen choice. */
  createOnMount?: boolean;
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
  const [showNsec, setShowNsec] = useState(isNative || defaultOpen || friendly || createOnMount);
  const [mode, setMode] = useState<"choice" | "create" | "paste">(
    createOnMount ? "create" : friendly ? "choice" : "paste",
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
  const [generating, setGenerating] = useState(createOnMount);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  // True from the instant a valid submit is accepted: swaps the form for the
  // signing-in placeholder while the shell boots the wallet behind it.
  const [handoffDone, setHandoffDone] = useState(false);
  const autoSubmittedKeyRef = useRef<string | null>(null);
  const [generatedPubkey, setGeneratedPubkey] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitInFlight = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const handleGenerate = async () => {
    setMode("create");
    onCreatingChange?.(true);
    setGenerating(true);
    setGenerateError(null);
    setInputError(null);
    try {
      const [{ generateSecretKey, getPublicKey }, { nip19 }] = await Promise.all([
        import("nostr-tools/pure"),
        import("nostr-tools"),
      ]);
      if (!mounted.current) return;
      const secretKey = generateSecretKey();
      const nsec = nip19.nsecEncode(secretKey);
      setGeneratedPubkey(getPublicKey(secretKey));
      setNsecInput(nsec);
      setGeneratedNsec(nsec);
    } catch (e: any) {
      if (mounted.current) setGenerateError(e?.message || t("chat.couldNotCreateKey"));
    } finally {
      if (mounted.current) setGenerating(false);
    }
  };

  const generationStarted = useRef(false);
  useEffect(() => {
    if (createOnMount && !generationStarted.current) {
      generationStarted.current = true;
      void handleGenerate();
    }
  }, [createOnMount]);

  const handleSubmit = async (submittedKey?: string) => {
    const key = (submittedKey ?? nsecInput).trim();
    if (handoffDone || submitInFlight.current) return;
    if (!key) { setInputError(t("connect.invalidKey")); return; }
    submitInFlight.current = true;
    setSubmitting(true);
    setNsecInput(key);
    try {
      const validated = await validateRecoveryKeyInput(key);
      if (!mounted.current) return;
      if (!validated.ok) { setInputError(t("connect.invalidKey")); return; }
      setInputError(null);
      // Submitting cannot confirm that a password manager saved the key.
      const wasGenerated = generatedNsec !== null && key === generatedNsec;
      (document.activeElement as HTMLElement | null)?.blur?.();
      setHandoffDone(true);
      await onSubmit(key, remember, wasGenerated);
    } catch (e: any) {
      if (mounted.current) { setHandoffDone(false); setInputError(e?.message || String(e)); }
    } finally {
      submitInFlight.current = false;
      if (mounted.current) setSubmitting(false);
    }
  };

  // A manager may fill a previously saved key. That must still require the
  // generated form's submit; never fall into the pasted-key auto-submit path.
  const generatedActive = generatedNsec !== null;
  // Manager autofill may update the native control without a React event.
  // Returning submit stays enabled and reads the form's actual password.
  const submitDisabled = generatedActive && !nsecInput.trim();
  const showPasteInput = !createOnMount && (!generatedActive || mode === "paste");

  useEffect(() => {
    const value = nsecInput.trim();
    if (!showPasteInput || !value || generatedActive) return;
    if (autoSubmittedKeyRef.current === value) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const validated = await validateRecoveryKeyInput(value);
      if (cancelled) return;
      if (!validated.ok) { setInputError(t("connect.invalidKey")); return; }
      autoSubmittedKeyRef.current = value;
      setInputError(null);
      // Auto-submit only fires for a PASTED key (gated on !generatedActive
      // above), so it's never the Chama-generated one.
      void handleSubmit(value);
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
        <PaymentButton
          onClick={handleGenerate}
          disabled={generating}
          style={{
            width: "100%", padding: "16px", borderRadius: 999,
            background: T.accent, border: "none", color: T.bg,
            fontFamily: T.sans, fontSize: 15, fontWeight: 800,
            cursor: generating ? "default" : "pointer",
            marginBottom: 10,
          }}
        >
          {generating ? t("chat.creating") : t("chat.createMyAccount")}
        </PaymentButton>
        {friendlySecondary && <PaymentButton
          onClick={friendlySecondary
            ? friendlySecondary.onClick
            : () => {
                setMode("paste");
                setGeneratedNsec(null);
                setInputError(null);
              }}
          disabled={friendlySecondary?.disabled}
          style={{
            width: "100%", padding: "13px", borderRadius: 999,
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
        </PaymentButton>}
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

  if (handoffDone && !generatedActive) {
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
            {t("backup.reason")}
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
        const password = new FormData(e.currentTarget).get("password");
        void handleSubmit(typeof password === "string" ? password : undefined);
      }}
      autoComplete="on"
      style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}
    >
      {isNative && !minimalPaste && !createOnMount && (
        <div style={{
          fontSize: 10, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 8, textAlign: "center",
        }}>
          {t("chat.signIn")}
        </div>
      )}

      {friendly && (
        <PaymentButton
          type="button"
          disabled={submitting}
          onClick={() => {
            setMode("choice");
            onCreatingChange?.(false);
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
        </PaymentButton>
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
            placeholder={t("chat.pasteRecoveryKey")}
            type="password"
            className={inputError ? "key-invalid" : undefined}
            autoComplete="current-password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={autoFocusInput}
            style={{
              width: "100%", padding: "14px 16px", boxSizing: "border-box",
              background: T.surface, border: `1px solid ${inputError ? T.red : T.border}`,
              borderRadius: 999, color: T.text,
              fontFamily: T.mono, fontSize: 12, outline: "none",
              marginBottom: 8,
            }}
          />
          <div style={{
            display: "flex", gap: 8, marginBottom: 8,
            justifyContent: allowCreate ? "stretch" : "flex-end",
          }}>
            {allowCreate && (
              <PaymentButton
                type="button"
                onClick={handleGenerate}
                disabled={generating}
                style={{
                  flex: 1, padding: "10px 12px",
                  background: T.surface, border: `1px solid ${T.border}`,
                  borderRadius: 999, color: T.text,
                  fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  cursor: generating ? "default" : "pointer",
                }}
              >
                {generating ? t("chat.creating") : t("chat.createNewAccount")}
              </PaymentButton>
            )}

          </div>
        </>
      )}

      {generateError && <><InlineError>{generateError}</InlineError>{createOnMount && <PaymentButton type="button" onClick={handleGenerate}>{t("common.retry")}</PaymentButton>}</>}
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
            {t("backup.identityOnly")}
          </div>
          <style>{`.chama-generated-credential{box-sizing:border-box;width:100%;padding:12px;border:1px solid ${T.border};border-radius:${T.rs}px;background:${T.bg};color:${T.text};font:11px/1.55 ${T.mono};}`}</style>
          <label style={{ display: "block", color: T.muted, fontSize: 11, marginBottom: 10 }}>
            {t("backup.publicKey")}
            <input className="chama-generated-credential" name="username" autoComplete="username" defaultValue={nip19.npubEncode(generatedPubkey)} autoCapitalize="off" spellCheck={false} />
          </label>
          <label style={{ display: "block", color: T.muted, fontSize: 11 }}>
            {t("backup.title")}
            <input className="chama-generated-credential" name="password" type="password" autoComplete="current-password" value={nsecInput}
              onChange={e => { if (!submitting) { setNsecInput(e.target.value); setInputError(null); } }} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
            {/* Password masking is browser-enforced. Keep the actual credential
                control visible and give the person a readable copy alongside it. */}
            <output data-generated-key style={{ display: "block", padding: "10px 12px", background: T.bg, borderRadius: T.rs, color: T.text, font: `11px/1.55 ${T.mono}`, overflowWrap: "anywhere", userSelect: "text" }}>{nsecInput}</output>
          </label>
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

      {/* Valid paste opens automatically; native form submission also works
          for Enter and password-manager autofill without a React event. */}
      <style>{`@keyframes key-invalid{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}.key-invalid{animation:key-invalid .22s ease-out}@media(prefers-reduced-motion:reduce){.key-invalid{animation:none!important}}`}</style>
      {(!minimalPaste && (!createOnMount || generatedActive)) && <PaymentButton
          type="submit"
          aria-live="polite"
          disabled={submitDisabled || handoffDone || submitting}
          style={{
            width: "100%", padding: "14px",
            background: !submitDisabled ? T.accent : T.surface,
            border: `1px solid ${!submitDisabled ? T.accent : T.border}`,
            borderRadius: 999, color: !submitDisabled ? T.bg : T.muted,
            fontFamily: T.mono, fontSize: 13, fontWeight: 700,
            cursor: !submitDisabled ? "pointer" : "default",
            letterSpacing: 0.5,
            transition: "background-color .2s, color .2s, box-shadow .2s",
          }}
        >
          {generatedActive ? t("backup.saveContinue") : t("connect.openDoor")}
      </PaymentButton>}
      {!minimalPaste && !createOnMount && (
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
    <div role="alert" style={{
      marginBottom: 8, padding: "4px 0",
      color: T.red,
      fontSize: 10, fontFamily: T.mono,
    }}>
      {children}
    </div>
  );
}
