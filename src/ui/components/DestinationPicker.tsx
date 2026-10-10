import { CardBack } from "./CardBack.js";
import { useCardDraft, type CardDraft } from "../hooks/useCardDraft.js";
// ══════════════════════════════════════════════════════════════════════════
// Chama — DestinationPicker (v0.3.0 send-side affordance)
// ══════════════════════════════════════════════════════════════════════════
//
// The canonical "user provides a destination to receive sats" surface,
// reused by the claim flow, recovery banner, and destroy-modal recovery
// path. See destination-picker-logic.ts for the pure decision logic
// (tested in src/escrow-engine/tests.ts).
//
// API contract:
//
//   props.amountSats     — the exact amount the consumer needs to receive
//   props.savedDestinations — listPayoutDestinations() result, passed in
//                            so the consumer controls when to refresh
//   props.title          — header text (caller-customized: "Claim",
//                          "Recover sats", etc.)
//   props.onResolve      — fired with (bolt11, { saveAfter, addressUsed })
//                          once the picker has a BOLT11. The consumer
//                          dispatches the actual outbound LN send and
//                          decides whether to call addOrTouchPayoutDestination
//                          based on saveAfter
//   props.onCancel       — modal dismissed without committing
//
// The picker handles Lightning Address LNURL-pay resolution and NWC
// make_invoice resolution internally; the consumer only sees BOLT11.

import { HoldToConfirm } from "./Button.js";
import { lazy, Suspense, useMemo, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { Capacitor } from "@capacitor/core";
import { T, inputStyle } from "../theme.js";
import { displayPayoutDestination, payoutDestinationLabel, type PayoutDestination } from "../../payments/payout-destinations.js";
import type { SavedNwcConnection } from "../../payments/nwc-connections.js";
import {
  resolveLightningAddressToInvoice,
  resolveRawLnurlToInvoice,
  LnurlError,
} from "../../payments/lnurl.js";
import { resolveNwcConnectionToInvoice, NwcError } from "../../payments/nwc.js";
import {
  decoratePayoutDestinationsForPicker,
  classifyDestinationInput,
  decideDispatch,
} from "./destination-picker-logic.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { useT, translate, getCurrentLang } from "../../i18n/index.js";
import { isTauriRuntime } from "../sign-in-environment.js";

const QRScanner = lazy(() => import("../QRScanner.js"));

export function resolveReceiveCode(value: string, amountSats: number): Promise<string> {
  const input = classifyDestinationInput(value);
  return input.kind === "lnurl"
    ? resolveRawLnurlToInvoice(input.lnurl, amountSats)
    : resolveLightningAddressToInvoice(value, amountSats);
}

export interface DestinationPickerResolveOpts {
  /** Whether the consumer should call addOrTouchPayoutDestination. */
  saveAfter: boolean;
  /** The Lightning Address used (if any) — passed back so the consumer
   *  doesn't need to re-derive it from the BOLT11. Unset for Tier 3
   *  pasted-BOLT11 dispatch. */
  addressUsed?: string;
  /** NWC connection used to create the returned BOLT11, if any. */
  nwcConnectionString?: string;
  /** Whether the caller should save/touch the NWC connection after success. */
  saveNwcAfter?: boolean;
}

export interface DestinationPickerProps {
  draft?: CardDraft;
  onBack?: () => void;
  /** Exact amount the consumer needs to receive. Passed into LNURL
   *  metadata validation and into the callback URL. */
  amountSats: number;
  /** Prefill from a saved wallet; still requires the usual confirmation. */
  initialAddress?: string;
  /** Lightning Address payout destinations previously saved by the user.
   *  Caller fetches these via listPayoutDestinations(). */
  savedDestinations: PayoutDestination[];
  /** Saved NWC wallets. Caller fetches via listSavedNwcConnections(). */
  savedNwcConnections?: SavedNwcConnection[];
  /** Modal header. "Claim", "Recover sats", etc. */
  title: string;
  /** Optional one-line subtitle below the title. */
  subtitle?: ReactNode | ((destinationKnown: boolean) => ReactNode);
  /** Fired with BOLT11 plus metadata describing whether/what to save. */
  onResolve: (bolt11: string, opts: DestinationPickerResolveOpts) => void;
  /** v7 redesign (Jet's option b): every send in this picker is a hold. A
   *  saved row then SELECTS its destination and the hold below sends to it;
   *  each hold calls exactly the dispatch its old tap did. */
  holdToSend?: boolean;
  /** Fired when the user dismisses the modal without committing. */
  onCancel: () => void;
  /** Optional first-tier destination supplied by a caller-specific
   *  adapter, such as Chapsmart for Tanzania TZS payouts. */
  topSlot?: ReactNode;
}

export function DestinationPicker({
  draft, onBack,
  amountSats,
  initialAddress = "",
  savedDestinations,
  savedNwcConnections = [],
  title,
  subtitle,
  onResolve,
  holdToSend = false,
  onCancel,
  topSlot,
}: DestinationPickerProps) {
  const { t } = useT();
  const [typed, setTyped] = useCardDraft<string>(draft, "lightning-typed", initialAddress);
  const [bolt11, setBolt11] = useCardDraft<string>(draft, "lightning-bolt11", "");
  const [showAdvanced, setShowAdvanced] = useCardDraft<boolean>(draft, "lightning-showAdvanced", false);
  const [rememberNwc, setRememberNwc] = useCardDraft<boolean>(draft, "lightning-rememberNwc", true);
  const [busy, setBusy] = useState(false);
  // v7 (Jet, 2026-10-10): one send button plus a "save this address" box,
  // instead of two competing holds. Same two handlers as before:
  // dispatchTyped(true) saved the address, dispatchTyped(false) did not.
  const [saveTyped, setSaveTyped] = useState(true);
  /** holdToSend: the saved destination a row tap selected for the hold. */
  const [pendingSend, setPendingSend] = useState<
    { kind: "saved"; destination: PayoutDestination } | { kind: "nwc"; connection: SavedNwcConnection } | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);

  const typedInput = useMemo(() => classifyDestinationInput(typed), [typed]);
  const bolt11PasteInput = useMemo(
    () => showAdvanced ? classifyDestinationInput(bolt11) : undefined,
    [bolt11, showAdvanced],
  );
  const dispatchPreview = useMemo(
    () => decideDispatch({
      typedInput,
      bolt11PasteInput,
      saveToggleOn: true,
    }),
    [typedInput, bolt11PasteInput],
  );

  const decoratedRows = useMemo(
    () => decoratePayoutDestinationsForPicker(savedDestinations),
    [savedDestinations],
  );

  const dispatchSavedRow = async (destination: PayoutDestination) => {
    setErr(null);
    setBusy(true);
    try {
      const invoice = await resolveReceiveCode(
        destination.address,
        amountSats,
      );
      onResolve(invoice, { saveAfter: true, addressUsed: destination.address });
    } catch (e) {
      setErr(formatLnurlError(e, classifyDestinationInput(destination.address).kind === "lnurl"));
    } finally {
      setBusy(false);
    }
  };

  const dispatchSavedNwc = async (connection: SavedNwcConnection) => {
    setErr(null);
    setBusy(true);
    try {
      const invoice = await resolveNwcConnectionToInvoice(
        connection.connectionString,
        amountSats,
        { description: "Chama payout" },
      );
      onResolve(invoice, {
        saveAfter: false,
        nwcConnectionString: connection.connectionString,
        saveNwcAfter: true,
      });
    } catch (e) {
      setErr(formatLnurlError(e));
    } finally {
      setBusy(false);
    }
  };

  const dispatchTyped = async (saveAfterOverride = true) => {
    setErr(null);
    const decision = decideDispatch({
      typedInput,
      bolt11PasteInput,
      saveToggleOn: saveAfterOverride,
    });
    if (!decision.ok) {
      setErr(decision.reason);
      return;
    }
    setBusy(true);
    try {
      if (decision.decision.tier === "pasted-bolt11") {
        const resolvedBolt11 = bolt11PasteInput?.kind === "bolt11"
          ? bolt11PasteInput.bolt11
          : typedInput.kind === "bolt11"
            ? typedInput.bolt11
            : (showAdvanced && bolt11.trim()) || typed.trim();
        onResolve(resolvedBolt11, { saveAfter: false });
        return;
      }
      if (decision.decision.tier === "pasted-nwc") {
        const connectionString = bolt11PasteInput?.kind === "nwc"
          ? bolt11PasteInput.connectionString
          : typedInput.kind === "nwc"
            ? typedInput.connectionString
            : (showAdvanced && bolt11.trim()) || typed.trim();
        const invoice = await resolveNwcConnectionToInvoice(
          connectionString,
          amountSats,
          { description: "Chama payout" },
        );
        onResolve(invoice, {
          saveAfter: false,
          nwcConnectionString: connectionString,
          saveNwcAfter: rememberNwc,
        });
        return;
      }
      // typed-address path
      const address = decision.decision.addressUsed!;
      const invoice = await resolveReceiveCode(
        address,
        amountSats,
      );
      onResolve(invoice, {
        saveAfter: decision.decision.saveAfter,
        addressUsed: address,
      });
    } catch (e) {
      setErr(formatLnurlError(e, classifyDestinationInput(decision.decision.addressUsed ?? "").kind === "lnurl"));
    } finally {
      setBusy(false);
    }
  };

  const commitOnEnter = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || busy) return;
    e.preventDefault();
    void dispatchTyped(saveTyped);
  };

  const handleTypedPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text");
    const pasted = classifyDestinationInput(text);
    if (pasted.kind === "bolt11" || pasted.kind === "nwc") {
      e.preventDefault();
      setTyped("");
      setBolt11(pasted.kind === "bolt11" ? pasted.bolt11 : pasted.connectionString);
      if (pasted.kind === "nwc") setRememberNwc(true);
      setShowAdvanced(true);
      setErr(null);
    }
  };

  const handleAdvancedPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const text = e.clipboardData.getData("text");
    const pasted = classifyDestinationInput(text);
    if (pasted.kind === "lightning-address" || pasted.kind === "lnurl") {
      e.preventDefault();
      setTyped(pasted.kind === "lnurl" ? pasted.lnurl : pasted.address);
      setBolt11("");
      setShowAdvanced(false);
      setErr(null);
    }
  };

  const activeSubmit = dispatchPreview.ok && !busy;
  const previewTier = dispatchPreview.ok ? dispatchPreview.decision.tier : null;
  const submitAmount = (
    <BitcoinAmount sats={amountSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" />
  );
  const submitLabel = busy
    ? t("claim.resolving")
    : dispatchPreview.ok && dispatchPreview.decision.tier === "pasted-bolt11"
      ? <>{t("claim.payInvoiceBefore")} {submitAmount}</>
      : dispatchPreview.ok && dispatchPreview.decision.tier === "pasted-nwc"
        ? <>{t("claim.nwcInvoiceBefore")} {submitAmount}</>
        : dispatchPreview.ok && dispatchPreview.decision.tier === "typed-address"
          ? <>{t("claim.sendTo", { amount: amountSats.toLocaleString(), destination: displayPayoutDestination(dispatchPreview.decision.addressUsed!) })}</>
          : <>{t("claim.submitSendBefore")} {submitAmount} →</>;

  const destinationSummary = pendingSend
    ? pendingSend.kind === "saved" ? displayPayoutDestination(pendingSend.destination.address) : pendingSend.connection.label
    : dispatchPreview.ok && dispatchPreview.decision.tier === "typed-address"
      ? displayPayoutDestination(dispatchPreview.decision.addressUsed!) : null;

  const renderPrimarySubmitButton = (marginBottom = 10, saveAfterOverride = true) => holdToSend ? (
    <div style={{ marginBottom }}>
      <HoldToConfirm label={busy ? submitLabel : t("claim.holdToSend", { amount: amountSats.toLocaleString() })} disabled={busy} busy={busy}
        onConfirm={() => void dispatchTyped(saveAfterOverride)}
        hint={t("common.holdToConfirm")} armedLabel={t("common.holdArmed")} />
    </div>
  ) : (
    <button
      disabled={busy}
      onClick={() => void dispatchTyped(saveAfterOverride)}
      style={{
        width: "100%", padding: "12px 16px", borderRadius: T.rs,
        background: activeSubmit ? T.accent : T.surface,
        border: `1px solid ${activeSubmit ? T.accent : T.border}`,
        color: activeSubmit ? T.onInk : T.muted,
        fontFamily: T.sans, fontSize: T.fs.button, fontWeight: 700,
        cursor: busy ? "not-allowed" : "pointer", marginBottom,
      }}
    >
      {submitLabel}
    </button>
  );

  const renderActionButtons = (marginBottom = 10) => {
    if (previewTier !== "typed-address") {
      return renderPrimarySubmitButton(marginBottom);
    }

    return (
      <div style={{ marginBottom }}>
        <label style={{
          display: "flex", alignItems: "center", gap: 12, minHeight: T.size.touch, marginBottom: 10,
          color: T.ink, fontFamily: T.sans, fontSize: T.fs.body, cursor: busy ? "not-allowed" : "pointer",
        }}>
          <input type="checkbox" checked={saveTyped} disabled={busy} onChange={(e) => setSaveTyped(e.target.checked)}
            style={{ width: 22, height: 22, accentColor: T.ink, flexShrink: 0 }} />
          {t("claim.saveForNextTime")}
        </label>
        {renderPrimarySubmitButton(0, saveTyped)}
      </div>
    );
  };

  return (
    <div onClick={onCancel} style={{
      position: "fixed", inset: 0, background: "#000a", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: T.fs.title2, fontWeight: 700, color: T.ink, fontFamily: T.sans }}>
            {title}
          </div>
          <CardBack onClick={onBack ?? onCancel} disabled={busy} />
        </div>
        {/* The money, first and big; the fee and insurance fine print under it. */}
        <div style={{ margin: "10px 0 4px" }}>
          <BitcoinAmount sats={amountSats} size={T.fs.amount} gap={6} glyphScale={1.1} color={T.ink} glyphColor={T.ink2} />
        </div>
        {destinationSummary && <div style={{ fontSize: T.fs.body, color: T.ink, fontFamily: T.sans, lineHeight: 1.45, overflowWrap: "anywhere", marginBottom: 8 }}>
          {t("claim.toDestination", { destination: destinationSummary })}
        </div>}
        <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, lineHeight: 1.45, marginBottom: 18 }}>
          {typeof subtitle === "function" ? subtitle(!!destinationSummary) : subtitle ?? (!destinationSummary ? t("claim.sendToWalletAfter") : null)}
        </div>

        {topSlot && (
          <div style={{ marginBottom: 16 }}>
            {topSlot}
          </div>
        )}

        {/* Tier 1: saved rows */}
        {(decoratedRows.length > 0 || savedNwcConnections.length > 0) && (
          <div style={{ marginBottom: 16 }}>
            {decoratedRows.length > 0 && (
              <>
                <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, fontWeight: 600, marginBottom: 6 }}>
                  {t("claim.savedDestinations")}
                </div>
                {decoratedRows.map(({ destination, isDefault }) => (
                  <button
                    key={destination.id}
                    disabled={busy}
                    onClick={() => holdToSend ? setPendingSend({ kind: "saved", destination }) : dispatchSavedRow(destination)}
                    aria-pressed={holdToSend ? pendingSend?.kind === "saved" && pendingSend.destination.id === destination.id : undefined}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "10px 12px", marginBottom: 6, minHeight: T.size.touch,
                      background: T.surface, borderRadius: T.rs,
                      border: holdToSend && pendingSend?.kind === "saved" && pendingSend.destination.id === destination.id ? `2px solid ${T.ink}` : `1px solid ${T.border}`,
                      cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ color: T.accent, fontFamily: T.sans, fontSize: T.fs.secondary }}>⚡</span>
                      <span style={{
                        color: T.text, fontFamily: T.mono, fontSize: 11,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {payoutDestinationLabel(destination)}
                        {destination.label && <span style={{ display: "block", color: T.ink2, fontSize: T.fs.secondary }}>{displayPayoutDestination(destination.address)}</span>}
                      </span>
                    </span>
                    {isDefault && (
                      <span style={{
                        fontSize: T.fs.secondary, fontFamily: T.sans,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4,
                      }}>{t("claim.defaultBadge")}</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {savedNwcConnections.length > 0 && (
              <>
                <div style={{
                  fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, fontWeight: 600,
                  margin: decoratedRows.length > 0 ? "10px 0 6px" : "0 0 6px",
                }}>
                  {t("claim.savedNwcWallets")}
                </div>
                {savedNwcConnections.map((connection, i) => (
                  <button
                    key={connection.id}
                    disabled={busy}
                    onClick={() => holdToSend ? setPendingSend({ kind: "nwc", connection }) : dispatchSavedNwc(connection)}
                    aria-pressed={holdToSend ? pendingSend?.kind === "nwc" && pendingSend.connection.id === connection.id : undefined}
                    style={{
                      display: "flex", alignItems: "center", justifyContent: "space-between",
                      width: "100%", padding: "10px 12px", marginBottom: 6, minHeight: T.size.touch,
                      background: T.surface, borderRadius: T.rs,
                      border: holdToSend && pendingSend?.kind === "nwc" && pendingSend.connection.id === connection.id ? `2px solid ${T.ink}` : `1px solid ${T.border}`,
                      cursor: busy ? "not-allowed" : "pointer", textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                      <span style={{ color: T.accent, fontFamily: T.sans, fontSize: T.fs.secondary }}>NWC</span>
                      <span style={{
                        color: T.text, fontFamily: T.sans, fontSize: T.fs.secondary,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}>
                        {connection.label}
                      </span>
                    </span>
                    {i === 0 && (
                      <span style={{
                        fontSize: T.fs.secondary, fontFamily: T.sans,
                        color: T.accent, background: T.accentDim,
                        padding: "2px 6px", borderRadius: 4,
                      }}>{t("claim.defaultBadge")}</span>
                    )}
                  </button>
                ))}
              </>
            )}
            {holdToSend && pendingSend && (
              <div style={{ marginTop: 6 }}>
                <HoldToConfirm
                  disabled={busy} busy={busy}
                  resetKey={pendingSend.kind === "saved" ? pendingSend.destination.id : pendingSend.connection.id}
                  label={t("claim.holdToSend", { amount: amountSats.toLocaleString() })}
                  onConfirm={() => void (pendingSend.kind === "saved" ? dispatchSavedRow(pendingSend.destination) : dispatchSavedNwc(pendingSend.connection))}
                  hint={t("common.holdToConfirm")} armedLabel={t("common.holdArmed")} />
              </div>
            )}
          </div>
        )}

        {/* Tier 2: typed Lightning Address or LNURL-pay receive code */}
        <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, fontWeight: 600, marginBottom: 6 }}>
          {(decoratedRows.length > 0 || savedNwcConnections.length > 0) ? t("claim.orSendNewAddress") : t("claim.sendToLightningAddress")}
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input
          type="text"
          inputMode="text"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setErr(null); }}
          onPaste={handleTypedPaste}
          onKeyDown={commitOnEnter}
          placeholder="you@wallet.app or lnurl1…"
          disabled={busy}
          style={{ ...inputStyle, flex: 1, minWidth: 0, minHeight: T.size.touch, fontSize: T.fs.body }}
        />
        <button type="button" disabled={busy} onClick={() => setScannerOpen(true)} aria-label={t("claim.scanReceiveCode")} title={t("claim.scanReceiveCode")} style={{
          flex: "0 0 auto", minWidth: T.size.touch, minHeight: T.size.touch, padding: "0 12px",
          background: T.surface, border: `1px solid ${T.line}`, borderRadius: T.rs, color: T.ink, cursor: "pointer",
          display: "inline-flex", alignItems: "center", gap: 6, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
        }}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" /><path d="M7 12h10" /></svg>
          {t("claim.scan")}
        </button>
        </div>
        {scannerOpen && <Suspense fallback={null}><QRScanner
          onClose={() => setScannerOpen(false)}
          onScan={(scanned) => {
            setScannerOpen(false);
            const input = classifyDestinationInput(scanned);
            if (input.kind === "lnurl" || input.kind === "lightning-address") {
              setTyped(input.kind === "lnurl" ? input.lnurl : input.address);
              setBolt11("");
              setShowAdvanced(false);
              setErr(null);
            } else if (input.kind === "bolt11") {
              setTyped(""); setBolt11(input.bolt11); setShowAdvanced(true); setErr(null);
            } else setErr(input.kind === "invalid" ? input.reason : t("claim.errEnterDestination"));
          }}
        /></Suspense>}

        {!showAdvanced && renderActionButtons(10)}

        {/* Tier 3: BOLT11/NWC paste under disclosure */}
        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          style={{
            width: "100%", padding: "6px 0", borderRadius: T.rs,
            background: "transparent", border: "none",
            color: T.muted, fontFamily: T.sans, fontSize: T.fs.secondary,
            cursor: "pointer", marginBottom: showAdvanced ? 8 : 0,
          }}
        >
          {showAdvanced ? t("claim.moreOptionsOpen") : t("claim.moreOptionsClosed")}
        </button>
        {showAdvanced && (
          <>
            <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, fontWeight: 600, marginBottom: 6 }}>
              {t("claim.pasteBolt11OrNwc")}
            </div>
            <textarea
              value={bolt11}
              onChange={(e) => { setBolt11(e.target.value); setErr(null); }}
              onPaste={handleAdvancedPaste}
              onKeyDown={commitOnEnter}
              placeholder="lnbc... or nostr+walletconnect://..."
              rows={3}
              disabled={busy}
              style={{ ...inputStyle, resize: "vertical" as const, minHeight: 60, marginBottom: 8 }}
            />
            <div style={{ fontSize: T.fs.secondary, color: T.ink2, fontFamily: T.sans, marginBottom: 12 }}>
              {t("claim.invoiceOnlyHint")}
            </div>
            {bolt11PasteInput?.kind === "nwc" && (
              <label style={{
                display: "flex", alignItems: "center", gap: 8,
                marginBottom: 12, color: T.muted, fontFamily: T.sans,
                fontSize: T.fs.secondary, cursor: busy ? "not-allowed" : "pointer",
              }}>
                <input
                  type="checkbox"
                  checked={rememberNwc}
                  disabled={busy}
                  onChange={(e) => setRememberNwc(e.target.checked)}
                />
                {t("claim.rememberNwcWallet")}
              </label>
            )}
            {renderActionButtons(10)}
          </>
        )}

        {err && (
          <div style={{
            marginTop: 4, padding: 10, borderRadius: T.rs,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.sans, fontSize: T.fs.secondary,
          }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}

function formatLnurlError(e: unknown, rawLnurl = false): string {
  if (e instanceof LnurlError) {
    switch (e.code) {
      case "LnurlParseError":
        return e.message;
      case "LnurlDnsError":
        return rawLnurl && typeof window !== "undefined" && !Capacitor.isNativePlatform() && !isTauriRuntime()
          ? translate(getCurrentLang(), "claim.errLnurlBrowserCors")
          : translate(getCurrentLang(), "claim.errWalletServerUnreachable", { message: e.message });
      case "LnurlWithdrawRequestError":
        return translate(getCurrentLang(), "claim.errLnurlWithdraw");
      case "LnurlServerError":
        return translate(getCurrentLang(), "claim.errWalletServerUnhappy", { message: e.message });
      case "LnurlMalformedError":
        return translate(getCurrentLang(), "claim.errWalletUnexpected", { message: e.message });
      case "LnurlAmountOutOfRangeError":
        return e.message;
    }
  }
  if (e instanceof NwcError) {
    switch (e.code) {
      case "NwcParseError":
        return e.message;
      case "NwcUnsupportedWallet":
        return e.message;
      case "NwcRelayError":
        return translate(getCurrentLang(), "claim.errNwcRelayUnreachable", { message: e.message });
      case "NwcTimeout":
        return e.message;
      case "NwcWalletError":
        return translate(getCurrentLang(), "claim.errNwcRefused", { message: e.message });
      case "NwcMalformedResponse":
        return translate(getCurrentLang(), "claim.errNwcUnexpected", { message: e.message });
    }
  }
  return (e as { message?: string })?.message
    || translate(getCurrentLang(), "claim.errResolveDestination");
}
