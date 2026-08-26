import { useState, useEffect, lazy, Suspense, type WheelEvent } from "react";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { CopyButton } from "../components/CopyButton.js";
import { isSimModeOn, setSimMode } from "../../sim/simMode.js";
import { makeLightningInvoiceQrPayload } from "../../payments/lightning-qr.js";
import {
  clearPendingRedemption,
  LEGACY_MANUAL_ECASH_EXPORT_ID,
  listPendingRedemptions,
} from "../../fedimint/pending-redemptions.js";
import {
  assertEcashExportWritable,
  clearEcashExport,
  getEcashExport,
  stashEcashExport,
  type EcashExport,
} from "../../payments/ecash-exports.js";
import type { ReabsorbOutcome } from "../../fedimint/reabsorb-bearer-notes.js";

/** Resume the dedicated outgoing-export stash. Migrate the legacy synthetic
 * claim entry on sight; pending-redemptions also excludes it from its boot
 * drain, so opening this modal can never race an automatic re-absorb. */
function readManualFundStash(): EcashExport | null {
  const current = getEcashExport();
  // Claim exports have their own completion boundary; this generic wallet
  // modal must never redeem or clear one behind ClaimPayoutModal's back.
  if (current) return current.source === "claim" ? null : current;
  const legacy = listPendingRedemptions().find(
    r => r.escrowId === LEGACY_MANUAL_ECASH_EXPORT_ID,
  );
  if (!legacy) return null;
  try {
    stashEcashExport({
      notes: legacy.oobNotes,
      amountMsats: legacy.amountMsats,
      source: "wallet",
    });
    clearPendingRedemption(LEGACY_MANUAL_ECASH_EXPORT_ID);
    return getEcashExport();
  } catch (e) {
    console.warn("[chama] couldn't migrate legacy manual ecash export:", e);
    return {
      notes: legacy.oobNotes,
      amountMsats: legacy.amountMsats,
      createdAt: legacy.createdAt,
      source: "wallet",
    };
  }
}

const QRCode = lazy(() => import("../QRCode.js"));

function blurNumberInputOnWheel(e: WheelEvent<HTMLInputElement>) {
  e.currentTarget.blur();
}

export function FundWalletModal({ onClose, onCreateInvoice, onPayInvoice, onSpendNotes, onRedeemEcash, onReabsorbBearerNotes, balanceMsats }: {
  onClose: () => void;
  onCreateInvoice: (amountSats: number, description: string) => Promise<string>;
  onPayInvoice: (bolt11: string) => Promise<void>;
  onSpendNotes: (amountMsats: number) => Promise<string>;
  onRedeemEcash: (oobNotes: string) => Promise<void>;
  /** 6.1 · the same liveness probe the Me-screen teal card runs. Ask the
   *  federation whether an uncollected note is still live by TAKING it back,
   *  and let App own the storage resolution + verdict toast. The real mount
   *  wires it; kept optional only so a test caller can omit it, in which case
   *  the UNCOLLECTED ECASH "put it back" button falls back to a plain redeem. */
  onReabsorbBearerNotes?: (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }) => Promise<ReabsorbOutcome>;
  balanceMsats: number;
}) {
  const { t } = useT();
  const [tab, setTab] = useState<"receive" | "send">("receive");
  const [receiveType, setReceiveType] = useState<"lightning" | "ecash">("lightning");
  const [amountSats, setAmountSats] = useState("10000");
  const [description, setDescription] = useState("Chama top-up");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [sendType, setSendType] = useState<"lightning" | "ecash">("lightning");
  const [bolt11Input, setBolt11Input] = useState("");
  const [ecashInput, setEcashInput] = useState("");
  const [ecashOutput, setEcashOutput] = useState<string | null>(null);
  // An uncollected note bundle from a previous visit, if any.
  const [stashed, setStashed] = useState(() => readManualFundStash());

  // Receive-confirmation tracking.
  const [balanceAtInvoice, setBalanceAtInvoice] = useState<number | null>(null);
  const [expectedMsats, setExpectedMsats] = useState<number>(0);
  const [invoiceExpiresAt, setInvoiceExpiresAt] = useState<number | null>(null);
  const [received, setReceived] = useState(false);
  const [nowTick, setNowTick] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    if (!invoice || received) return;
    const id = setInterval(() => setNowTick(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(id);
  }, [invoice, received]);

  // NOTE: `received` intentionally NOT in deps — see v0.1.62 bug notes.
  useEffect(() => {
    if (!invoice || received || balanceAtInvoice === null) return;
    const delta = balanceMsats - balanceAtInvoice;
    if (delta >= expectedMsats && expectedMsats > 0) {
      setReceived(true);
      if (typeof navigator !== "undefined" && navigator.vibrate) {
        navigator.vibrate([40, 30, 40, 30, 120]);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balanceMsats, balanceAtInvoice, expectedMsats, invoice]);

  useEffect(() => {
    if (!received) return;
    const t = setTimeout(() => {
      setInvoice(null);
      setBalanceAtInvoice(null);
      setExpectedMsats(0);
      setInvoiceExpiresAt(null);
      setReceived(false);
    }, 3500);
    return () => clearTimeout(t);
  }, [received]);

  const handleGenerate = async () => {
    const n = parseInt(amountSats, 10);
    if (!n || n <= 0) { setErr(t("fund.enterValidSats")); return; }
    setBusy(true); setErr(null);
    try {
      const bolt11 = await onCreateInvoice(n, description || "Chama top-up");
      setBalanceAtInvoice(balanceMsats);
      setExpectedMsats(n * 1000);
      setInvoiceExpiresAt(Math.floor(Date.now() / 1000) + 600);
      setReceived(false);
      setInvoice(bolt11);
    } catch (e: any) {
      setErr(e.message || t("fund.failedToCreateInvoice"));
    } finally { setBusy(false); }
  };

  const handlePayInvoice = async () => {
    if (!bolt11Input.trim()) { setErr(t("fund.pasteLightningInvoiceErr")); return; }
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await onPayInvoice(bolt11Input.trim());
      setSuccess(t("fund.paymentSent")); setBolt11Input("");
    } catch (e: any) {
      setErr(e.message || t("fund.paymentFailed"));
    } finally { setBusy(false); }
  };

  const handleRedeemEcash = async () => {
    if (!ecashInput.trim()) { setErr(t("fund.pasteEcashNotesErr")); return; }
    setBusy(true); setErr(null); setSuccess(null);
    try {
      await onRedeemEcash(ecashInput.trim());
      setSuccess(t("fund.ecashRedeemed")); setEcashInput("");
    } catch (e: any) {
      setErr(e.message || t("fund.redeemFailed"));
    } finally { setBusy(false); }
  };

  // Manual ecash is an OUTGOING bearer payment. Keep its recovery copy in the
  // export stash, never the claim-redemption queue (whose boot drain consumes
  // notes back into this wallet). Prove storage before spending and reabsorb if
  // the post-spend write unexpectedly fails.
  const createEcashExport = async (amountMsats: number) => {
    assertEcashExportWritable();
    const notes = await onSpendNotes(amountMsats);
    try {
      stashEcashExport({ notes, amountMsats, source: "wallet" });
    } catch (stashError) {
      try {
        await onRedeemEcash(notes);
      } catch (redeemError) {
        console.error("[chama] unstashed manual ecash reabsorb failed:", redeemError);
      }
      throw new Error(t("recovery.exportStashFailedReabsorbed"), { cause: stashError });
    }
    setEcashOutput(notes);
    setStashed(getEcashExport());
  };

  const handleSpendAll = async () => {
    if (balanceMsats <= 0) { setErr(t("fund.noBalanceToSend")); return; }
    setBusy(true); setErr(null);
    try {
      await createEcashExport(balanceMsats);
    }
    catch (e: any) { setErr(e.message || t("fund.failed")); }
    finally { setBusy(false); }
  };

  const handleSpendAmount = async () => {
    const n = parseInt(amountSats, 10);
    if (!n || n <= 0) { setErr(t("fund.enterValidSats")); return; }
    setBusy(true); setErr(null);
    try {
      await createEcashExport(n * 1000);
    }
    catch (e: any) { setErr(e.message || t("fund.failed")); }
    finally { setBusy(false); }
  };

  /** Put an uncollected note bundle back into the wallet.
   *
   * 6.1 · this is the 4th surface that holds a bearer note, and it used to be
   * the last one still redeeming it blind — `onRedeemEcash(stashed.notes)`
   * inside a try/catch. On a note the federation had already consumed that
   * THREW correctly (so it was never dangerous), but it showed a raw error
   * instead of the honest verdict, wrote NO unresolved-credit record, and had
   * no balance bracket — so the untested unverified-success shape (reissue
   * reports success, balance doesn't move) would have silently cleared the
   * stash here. Route it through the SAME probe the teal card runs so the two
   * give identical structured answers for the same note. App owns the storage
   * resolution (clear / record / leave-untouched) and the verdict toast; this
   * modal only re-reads its own view of the stash from the outcome.
   *
   * When no probe handler is wired (a test caller that omits the optional
   * prop) fall back to the old direct redeem — that path is unchanged. */
  const handleRestash = async () => {
    if (!stashed) return;
    setBusy(true); setErr(null); setSuccess(null);

    if (!onReabsorbBearerNotes) {
      try {
        await onRedeemEcash(stashed.notes);
        clearEcashExport();
        clearPendingRedemption(LEGACY_MANUAL_ECASH_EXPORT_ID);
        setStashed(null);
        setEcashOutput(null);
        setSuccess(t("fund.ecashRestashed"));
      } catch (e: any) {
        setErr(e.message || t("fund.failed"));
      } finally { setBusy(false); }
      return;
    }

    try {
      const outcome = await onReabsorbBearerNotes({
        oobNotes: stashed.notes,
        expectedMsats: stashed.amountMsats,
        context: "pending-export",
        escrowId: stashed.escrowId,
      });
      // App has already spoken the verdict (toast) and resolved storage: on a
      // terminal outcome it cleared the export stash and wrote any record; on
      // unknown / foreign it changed nothing. Mirror only the LOCAL view.
      //
      //   recovered           → sats are in the balance
      //   consumed-uncredited → note dead, record written, sats an open Q
      //   dead                → note was never valid
      // …all three retire this card. unknown / foreign leave it exactly as it
      // was so the note stays recoverable — the whole point of the probe.
      if (outcome === "recovered" || outcome === "consumed-uncredited" || outcome === "dead") {
        // A failed legacy migration may still be displaying that entry.
        clearPendingRedemption(LEGACY_MANUAL_ECASH_EXPORT_ID);
        setStashed(null);
        setEcashOutput(null);
      } else {
        // unknown / foreign: re-read in case another surface touched it, but
        // never assume this note is gone.
        setStashed(getEcashExport());
      }
    } finally { setBusy(false); }
  };

  const diagnostics = err ? extractChamaDiagnostics(err) : null;
  const nativeBridgeUnavailable = !!err &&
    /native_fedimint_bridge_unavailable|Native Fedimint bridge is enabled but unreachable/i.test(err);
  const gatewayTrustError = !!err && /wallet-verifiable Lightning receive gateway/i.test(err);

  const tabBtn = (tabId: "receive" | "send", label: string) => (
    <button onClick={() => { setTab(tabId); setErr(null); setSuccess(null); setInvoice(null); setEcashOutput(null); }} style={{
      flex: 1, padding: "8px 0", borderRadius: T.rs, border: "none",
      background: tab === tabId ? T.accent : T.surface,
      color: tab === tabId ? "#000" : T.muted,
      fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
    }}>{label}</button>
  );

  return (
    <div onClick={onClose} style={{
      position: "fixed", inset: 0, background: "#000a", zIndex: 9998,
      display: "flex", alignItems: "center", justifyContent: "center",
      padding: 16, animation: "fadeIn 0.2s ease",
    }}>
      <div onClick={(e) => e.stopPropagation()} style={{
        background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r,
        padding: 24, maxWidth: 420, width: "100%",
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: T.sans }}>Chama</div>
          <button onClick={onClose} style={{
            background: "none", border: "none", color: T.muted,
            fontFamily: T.mono, fontSize: 18, cursor: "pointer", padding: 0, lineHeight: 1,
          }}>×</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {tabBtn("receive", t("fund.receive"))}
          {tabBtn("send", t("fund.send"))}
        </div>

        {/* RECEIVE */}
        {tab === "receive" && !invoice && (<>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={() => { setReceiveType("lightning"); setErr(null); setSuccess(null); }} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: receiveType === "lightning" ? `1px solid ${T.accent}` : `1px solid ${T.border}`, background: receiveType === "lightning" ? T.accentDim : T.surface, color: receiveType === "lightning" ? T.accent : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>Lightning</button>
            <button onClick={() => { setReceiveType("ecash"); setErr(null); setSuccess(null); }} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: receiveType === "ecash" ? `1px solid ${T.amber}` : `1px solid ${T.border}`, background: receiveType === "ecash" ? T.amberDim : T.surface, color: receiveType === "ecash" ? T.amber : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>{t("fund.ecash")}</button>
          </div>

          {receiveType === "lightning" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>{t("fund.amountSats")}</div>
            <input
              type="number"
              name="chama-lightning-receive-amount"
              autoComplete="off"
              data-bwignore="true"
              data-1p-ignore="true"
              data-lpignore="true"
              data-form-type="other"
              value={amountSats}
              onChange={(e) => setAmountSats(e.target.value)}
              onWheel={blurNumberInputOnWheel}
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>{t("fund.description")}</div>
            <input type="text" name="chama-lightning-receive-description" autoComplete="off"
              data-bwignore="true" data-1p-ignore="true" data-lpignore="true" data-form-type="other"
              value={description} onChange={(e) => setDescription(e.target.value)} style={{ ...inputStyle, marginBottom: 16 }} />
            <button type="button" disabled={busy} onClick={handleGenerate} style={{
              width: "100%", padding: "12px 16px", borderRadius: T.rs,
              background: busy ? T.surface : T.accent, border: `1px solid ${T.accent}`,
              color: busy ? T.muted : "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: busy ? "not-allowed" : "pointer",
            }}>{busy ? t("fund.generating") : t("fund.generateLightningInvoice")}</button>
          </>)}

          {receiveType === "ecash" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>{t("fund.pasteEcashNotes")}</div>
            <textarea value={ecashInput} onChange={(e) => setEcashInput(e.target.value)} placeholder="fedimint..." rows={4} style={{ ...inputStyle, resize: "vertical" as const, marginBottom: 12, minHeight: 90 }} />
            <button disabled={busy} onClick={handleRedeemEcash} style={{
              width: "100%", padding: "12px 16px", borderRadius: T.rs,
              background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`,
              color: busy ? T.muted : "#000", fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: busy ? "not-allowed" : "pointer",
            }}>{busy ? t("fund.redeeming") : t("fund.redeemEcashNotes")}</button>
          </>)}
        </>)}

        {tab === "receive" && invoice && received && (
          <div style={{
            padding: "32px 16px", textAlign: "center",
            background: T.greenDim, border: `1px solid ${T.green}66`,
            borderRadius: T.r, animation: "fadeIn 0.3s ease",
          }}>
            <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: T.green, fontFamily: T.sans, marginBottom: 6 }}>
              {t("fund.paymentReceived")}
            </div>
            <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.5 }}>
              +<BitcoinAmount sats={expectedMsats / 1000} size={22} gap={6} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            </div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 12 }}>
              {t("fund.balanceUpdatedClosing")}
            </div>
          </div>
        )}
        {tab === "receive" && invoice && !received && (<>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 8, letterSpacing: 1, textAlign: "center" }}>{t("fund.scanOrCopyToPay")}</div>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
            <Suspense fallback={<div style={{ width: 280, height: 280, background: "#fff", borderRadius: T.rs }} />}>
              <QRCode
                data={makeLightningInvoiceQrPayload(invoice)}
                size={280}
                fgColor="#050505"
                bgColor="#ffffff"
                margin={4}
                alt={t("fund.lightningQrAlt")}
              />
            </Suspense>
          </div>
          {(() => {
            const remaining = invoiceExpiresAt ? Math.max(0, invoiceExpiresAt - nowTick) : 0;
            const mins = Math.floor(remaining / 60);
            const secs = remaining % 60;
            const expired = invoiceExpiresAt !== null && remaining === 0;
            return (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 8, marginBottom: 12, padding: "6px 12px",
                borderRadius: T.rs,
                background: expired ? T.redDim : T.surface,
                border: `1px solid ${expired ? T.red + "44" : T.border}`,
              }}>
                {!expired && (
                  <div style={{
                    width: 8, height: 8, borderRadius: "50%",
                    background: T.accent, animation: "pulse 1.4s ease-in-out infinite",
                  }} />
                )}
                <span style={{
                  fontSize: 10, fontFamily: T.mono,
                  color: expired ? T.red : T.muted, letterSpacing: 0.5,
                }}>
                  {expired
                    ? t("fund.invoiceExpiredGenerateNew")
                    : t("fund.waitingForPayment", { time: `${mins}:${secs.toString().padStart(2, "0")}` })}
                </span>
              </div>
            );
          })()}
          <div style={{ padding: 8, marginBottom: 12, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 8, color: T.muted, wordBreak: "break-all", maxHeight: 60, overflowY: "auto", textAlign: "center" }}>{invoice}</div>
          {/* v0.4.2 sim-mode honest disclosure (Pillar 2.7). Sim invoices
              auto-settle 3-8s after creation regardless of whether the
              user does anything with the QR. Without this notice, users
              report confusion when the balance credits after they've
              dismissed the modal without action. Amber matches the
              SIM MODE pill's warning palette. */}
          {isSimModeOn() && (
            <div style={{
              padding: "8px 12px", marginBottom: 12, borderRadius: T.rs,
              background: T.amberDim, border: `1px solid ${T.amber}55`,
              fontFamily: T.mono, fontSize: 10, color: T.amber,
              lineHeight: 1.5, textAlign: "center",
            }}>
              {t("fund.simAutoCredit")}<br />
              {t("fund.simDoNotFund")}
            </div>
          )}
          <CopyButton value={invoice} label={t("fund.copyInvoice")} copiedLabel={t("common.copied")} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.accentDim, border: `1px solid ${T.accent}44`, color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 8 }} />
          <button onClick={() => {
            setInvoice(null);
            setBalanceAtInvoice(null);
            setExpectedMsats(0);
            setInvoiceExpiresAt(null);
          }} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{t("fund.newInvoice")}</button>
        </>)}

        {/* SEND */}
        {/* Uncollected ecash from a previous visit. Bearer notes that were
            generated and never copied would otherwise be invisible until the
            mint's auto-refund — this is the way back. */}
        {tab === "send" && !ecashOutput && stashed && (
          <div style={{
            background: T.amberDim, border: `1px solid ${T.amber}66`,
            borderRadius: T.rs, padding: 12, marginBottom: 12,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.amber, fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 6 }}>
              {t("fund.uncollectedEcashTitle")}
            </div>
            <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.55, marginBottom: 10 }}>
              {t("fund.uncollectedEcashBody", { sats: Math.floor(stashed.amountMsats / 1000).toLocaleString() })}
            </div>
            <button
              disabled={busy}
              onClick={handleRestash}
              style={{
                width: "100%", padding: "10px 16px", borderRadius: T.rs,
                background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`,
                color: busy ? T.muted : "#1d1c24", fontFamily: T.mono, fontSize: 11,
                fontWeight: 800, cursor: busy ? "not-allowed" : "pointer", marginBottom: 8,
              }}
            >
              {busy ? t("fund.sending") : t("fund.putEcashBack")}
            </button>
            <CopyButton
              value={stashed.notes}
              label={t("fund.copyEcashAgain")}
              copiedLabel={t("common.copied")}
              style={{
                width: "100%", padding: "8px 16px", borderRadius: T.rs,
                background: "transparent", border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 10.5, cursor: "pointer",
              }}
            />
          </div>
        )}

        {tab === "send" && !ecashOutput && (<>
          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <button onClick={() => setSendType("lightning")} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: sendType === "lightning" ? `1px solid ${T.accent}` : `1px solid ${T.border}`, background: sendType === "lightning" ? T.accentDim : T.surface, color: sendType === "lightning" ? T.accent : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>Lightning</button>
            <button onClick={() => setSendType("ecash")} style={{ flex: 1, padding: "6px 0", borderRadius: T.rs, border: sendType === "ecash" ? `1px solid ${T.amber}` : `1px solid ${T.border}`, background: sendType === "ecash" ? T.amberDim : T.surface, color: sendType === "ecash" ? T.amber : T.muted, fontFamily: T.mono, fontSize: 10, cursor: "pointer" }}>{t("fund.ecash")}</button>
          </div>

          {sendType === "lightning" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>{t("fund.pasteLightningInvoice")}</div>
            <textarea value={bolt11Input} onChange={(e) => setBolt11Input(e.target.value)} placeholder="lnbc1..." rows={3} style={{ ...inputStyle, resize: "vertical" as const, marginBottom: 12, minHeight: 60 }} />
            <button disabled={busy} onClick={handlePayInvoice} style={{ width: "100%", padding: "12px 16px", borderRadius: T.rs, background: busy ? T.surface : T.red, border: `1px solid ${T.red}`, color: busy ? T.muted : "#fff", fontFamily: T.mono, fontSize: 12, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{busy ? t("fund.sending") : t("fund.payInvoice")}</button>
          </>)}

          {sendType === "ecash" && (<>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 4, letterSpacing: 1 }}>{t("fund.amountSats")}</div>
            <input
              type="number"
              value={amountSats}
              onChange={(e) => setAmountSats(e.target.value)}
              onWheel={blurNumberInputOnWheel}
              style={{ ...inputStyle, marginBottom: 12 }}
            />
            <div style={{ display: "flex", gap: 8 }}>
              <button disabled={busy} onClick={handleSpendAmount} style={{ flex: 1, padding: "12px 8px", borderRadius: T.rs, background: busy ? T.surface : T.amber, border: `1px solid ${T.amber}`, color: busy ? T.muted : "#000", fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{busy ? t("fund.creating") : t("fund.createEcash")}</button>
              <button disabled={busy} onClick={handleSpendAll} style={{ flex: 1, padding: "12px 8px", borderRadius: T.rs, background: busy ? T.surface : T.red, border: `1px solid ${T.red}`, color: busy ? T.muted : "#fff", fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: busy ? "not-allowed" : "pointer" }}>{t("fund.sendAllBefore")}<BitcoinAmount sats={Math.floor(balanceMsats / 1000)} size={11} gap={3} glyphScale={1.18} color="inherit" glyphColor="inherit" />{t("fund.sendAllAfter")}</button>
            </div>
          </>)}
        </>)}

        {tab === "send" && ecashOutput && (<>
          <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, marginBottom: 8, letterSpacing: 1, textAlign: "center" }}>{t("fund.ecashNotesCopySend")}</div>
          <div style={{ padding: 8, marginBottom: 12, borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, fontFamily: T.mono, fontSize: 8, color: T.text, wordBreak: "break-all", maxHeight: 100, overflowY: "auto" }}>{ecashOutput}</div>
          <CopyButton value={ecashOutput} label={t("fund.copyEcashNotes")} copiedLabel={t("common.copied")} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.amberDim, border: `1px solid ${T.amber}44`, color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", marginBottom: 8 }} />
          <button onClick={() => setEcashOutput(null)} style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.surface, border: `1px solid ${T.border}`, color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer" }}>{t("common.done")}</button>
        </>)}

        {success && <div style={{ marginTop: 12, padding: 10, borderRadius: T.rs, background: T.greenDim, border: `1px solid ${T.green}44`, color: T.green, fontFamily: T.mono, fontSize: 10 }}>{success}</div>}
        {err && (
          <>
            <div style={{ marginTop: 12, padding: 10, borderRadius: T.rs, background: T.redDim, border: `1px solid ${T.red}44`, color: T.red, fontFamily: T.mono, fontSize: 10, wordBreak: "break-word" }}>
              {nativeBridgeUnavailable
                ? t("fund.nativeBridgeUnavailableShort")
                : gatewayTrustError
                ? t("fund.sdkGatewayShort")
                : err}
            </div>
            {diagnostics && (
              <CopyButton
                value={diagnostics}
                label={t("fund.copyDiagnostics")}
                copiedLabel={t("common.copied")}
                style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.redDim, border: `1px solid ${T.red}44`, color: T.red, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer", marginTop: 8 }}
              />
            )}
            {gatewayTrustError && !nativeBridgeUnavailable && !isSimModeOn() && (
              <button
                onClick={openSimDemo}
                style={{ width: "100%", padding: "10px 16px", borderRadius: T.rs, background: T.amberDim, border: `1px solid ${T.amber}55`, color: T.amber, fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer", marginTop: 8 }}
              >
                {t("fund.openSimDemo")}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function extractChamaDiagnostics(error: string): string | null {
  const marker = "Chama diagnostics:";
  const index = error.indexOf(marker);
  if (index === -1) return null;
  return error.slice(index + marker.length).trim() || null;
}

function openSimDemo(): void {
  setSimMode(true);
  try {
    const next = new URL(window.location.href);
    next.searchParams.set("sim", "1");
    window.location.assign(next.toString());
  } catch {
    window.location.reload();
  }
}
