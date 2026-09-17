import { useEffect, useRef, useState, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { isTauriRuntime } from "../sign-in-environment.js";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";
import { useT } from "../../i18n/index.js";

// ── v6.4 runway #13 (sealed 2026-09-18): the app keeps the key ──────────────
// Every client — browser, PWA, APK, Tauri, Start9's served page — persists the
// nsec on login by default (the shell's writeSavedNsec), and the screen right
// after login carries the keep-notice with the active opt-out. That retires
// the whole v6.3.x password-manager apparatus that used to live here: the
// deterministic credentials.store() call, the hidden username+password form
// built to summon Safari/Bitwarden save sheets, the History push that released
// WebKit's batched save decision, and the copy-then-re-paste backup
// verification ritual. What remains is a plain copy button on the generated
// key for whoever wants an external backup — nothing more, and deliberately
// NO password-manager prompt of ours anywhere. The paste field is masked with
// -webkit-text-security instead of type="password" (the codebase-verified
// trick from the old verify field) precisely so no manager heuristic ever
// attaches a save or strong-password sheet to it.
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
  // Runway #13: the key is kept by default on EVERY client. The post-login
  // keep-notice (App's NsecKeepNotice) is where the user actively opts out.
  const remember = true;
  const [generatedNsec, setGeneratedNsec] = useState<string | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  // True from the instant a valid submit is accepted: swaps the form for the
  // signing-in placeholder while the shell boots the wallet behind it.
  const [handoffDone, setHandoffDone] = useState(false);
  const autoSubmittedKeyRef = useRef<string | null>(null);

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
    (document.activeElement as HTMLElement | null)?.blur?.();
    setHandoffDone(true);
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
        <div style={{
          marginTop: 12, color: T.text, fontFamily: T.sans, fontSize: 13,
          lineHeight: 1.5,
        }}>
          {t("chat.keySavedHint")}
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
      autoComplete="off"
      style={{ marginTop: isNative ? 0 : 8, width: "100%", maxWidth: 360 }}
    >
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
            /* Masked with -webkit-text-security instead of type="password":
               a password-classified control is exactly what summons manager
               save offers and iOS's strong-password sheet, and runway #13
               wants NONE of that. The ignore attrs cover Bitwarden /
               1Password / LastPass. */
            name="nsec-recovery-key"
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
            type="text"
            autoComplete="off"
            data-bwignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
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
              ...(showKey ? {} : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)),
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
