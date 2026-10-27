// ══════════════════════════════════════════════════════════════════════════
// Chama — the sats Chama holds for you (Home)
// ══════════════════════════════════════════════════════════════════════════
//
// Chama is not a wallet: sats sit here only while a trade holds them or a
// payout went wrong. Home answers one question, "is Chama holding any of my
// sats right now, who holds them, and how do I get them out?", so every
// recovery card that used to sit above Me's tabs lives here, with the same
// selectors, handlers, focus rules and copy as before. When nothing is held,
// Home says so in one line. There is deliberately no total.

import { useEffect, useState, type ReactNode } from "react";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { HeldLeftovers, leftoversShowSomething, useHeldLeftovers } from "./HeldLeftovers.js";
import type { HeldLeftovers as HeldLeftoversData } from "../../payments/held-leftovers.js";
import { walletHome } from "../wallet-location.js";
import { MAIN_SURFACE_RECOVERY_MIN_SATS, selectMoneySafetyFocus, type MoneySafetyEntry } from "../decisions.js";
import { lightningPayoutReserveSats, maxLightningPayoutSats } from "../../payments/lightning-fees.js";
import { describeSatsTrace, type SatsTraceEntry } from "../../payments/sats-trace.js";
import { getEcashExport } from "../../payments/ecash-exports.js";
import { listPaidLockRecoveries, acknowledgePaidLockRecoveries } from "../../payments/paid-lock-recovery.js";
import type { ReabsorbOutcome } from "../../fedimint/reabsorb-bearer-notes.js";
import {
  excludeStrandedRedemptionsOwnedByExport,
  listPendingRedemptions,
  listStrandedRedemptions,
  partitionStrandedClaims,
  reopenBalanceReconciledCredit,
  resolveUnresolvedCredit,
  type StrandedRedemption,
} from "../../fedimint/pending-redemptions.js";
import type { PendingNativeLock } from "../../fedimint/pending-native-locks.js";
// Kept-wallet and balance rows stay defined in MeScreen, where the
// federation-switch work edits them; Home only places them.
import { ParkedWallets, WalletBalance, parkedWalletRoutes, withdrawEcashHintKey } from "../screens/MeScreen.js";

export interface MoneySafetyInput {
  balanceMsats: number;
  hasActiveCommitment: boolean;
  paidLockFederationId?: string;
  satsTrace?: SatsTraceEntry | null;
  /** v2.4 #56 — open the "withdraw as ecash" (fee-free Fedimint note) flow. */
  onWithdrawEcash?: () => void;
  /** v3.4.0 C13 — open the export modal for a stranded claim's bearer
   *  note (a pending-redemption entry automatic retry gave up on). */
  onExportStrandedClaim?: (entry: StrandedRedemption) => void;
  /** 6.0.2 liveness probe. Ask the federation whether a bearer note is still
   *  live by TAKING it back into this wallet, and act on the answer (App owns
   *  the storage resolution + the toast; this screen only triggers and
   *  re-reads). Deliberately a prop and not a render-time effect: reissuing a
   *  LIVE note takes it back from whoever was about to claim it, so it must
   *  never fire except on a user's tap. */
  onReabsorbBearerNotes?: (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }) => Promise<ReabsorbOutcome>;
  /** #37: an actionable pending lock attempt owns the balance story. */
  hasPendingNativeLock?: boolean;
  /** Stranded-payout recovery: an unfinished claim payout owns the balance. */
  hasPendingClaimPayout?: boolean;
  /** #37: lock-recovery entries whose automatic retries were exhausted. */
  stuckNativeLocks?: PendingNativeLock[];
}

/** Every money-safety reading the recovery cards need, moved unchanged from
 *  Me. Me also calls it, only to know whether to point at Home. */
export function useMoneySafety({
  balanceMsats, hasActiveCommitment, paidLockFederationId, satsTrace,
  onWithdrawEcash, onExportStrandedClaim, onReabsorbBearerNotes,
  hasPendingNativeLock, hasPendingClaimPayout, stuckNativeLocks,
}: MoneySafetyInput) {
  const { t } = useT();
  const localRecoverySats = Math.floor(Math.max(0, balanceMsats) / 1000);
  const localRecoverableSats = maxLightningPayoutSats(balanceMsats);
  const localReserveSats = lightningPayoutReserveSats(balanceMsats);
  // #37: while a pending lock attempt owns the balance story, the drain
  // card hides — recovering here would abandon a resumable live trade.
  // Stranded-payout recovery: same rule while an unfinished claim payout
  // owns it — the "Finish your payout" card is the honest surface.
  const showLocalRecovery =
    !hasActiveCommitment && localRecoverySats > 0
    && !hasPendingNativeLock && !hasPendingClaimPayout;
  const isSmallLeftover = localRecoverySats < MAIN_SURFACE_RECOVERY_MIN_SATS;
  // A leftover below the material dust line never offers an ACTIVE recover
  // button — recovering ~1 sat burns more than itself in Lightning fees (the
  // same line the switch guard and recovery banner use). The card stays as a
  // quiet "accumulating" note until the pile is worth the fees.
  const recoverWorthwhile = !isSmallLeftover && localRecoverableSats > 0;
  // v2.4 #56 — a pending ecash export (generated but not yet confirmed
  // imported). Surfaced even when the balance reads 0, so the user can always
  // get back to the bearer note they minted.
  const pendingEcashExportRecord = getEcashExport();
  const pendingEcashExport = pendingEcashExportRecord;
  // v3.4.0 C13 — claims whose bearer notes automatic retry gave up on.
  // These sit in clearable localStorage while the chain reads COMPLETED;
  // without a loud surface, a data-clear or federation switch destroys
  // the only copy of the money. Rendered as the topmost alarm card.
  // v4.0.0: bump to force a re-read after a dismiss mutates the stash.
  const [, bumpStrandedTick] = useState(0);
  useEffect(() => {
    // A previous build treated the pending export's face value as proof that a
    // consumed claim had landed and archived its warning. An export is not
    // proof—the receiving wallet can reject it as already spent. Reopen only
    // those automatic archives while the unconfirmed export still exists.
    if (!pendingEcashExport) return;
    let reopened = false;
    for (const entry of listPendingRedemptions()) {
      if (reopenBalanceReconciledCredit(entry.escrowId)) reopened = true;
    }
    if (reopened) bumpStrandedTick((tick) => tick + 1);
  }, [pendingEcashExport?.createdAt]);
  const strandedClaims = excludeStrandedRedemptionsOwnedByExport(
    listStrandedRedemptions(),
    pendingEcashExport?.notes,
  );
  // Reconcile the "unresolved-credit" sliver against the wallet balance the
  // copy already invokes — covered → resolve silently; short → calm nudge;
  // poisoned / retries-exhausted stay loud (may be live money). See
  // partitionStrandedClaims.
  const { loud: loudClaims, calm: calmClaims, reconciledIds } =
    // A pending export is not proof of value: the receiver may find that note
    // already consumed. Only confirmed wallet balance can reconcile a failed
    // claim automatically.
    partitionStrandedClaims(strandedClaims, balanceMsats);
  const reconciledKey = reconciledIds.join(",");
  useEffect(() => {
    if (!reconciledKey) return;
    for (const id of reconciledKey.split(",")) resolveUnresolvedCredit(id, "balance-reconciled");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconciledKey]);
  const dismissClaim = (escrowId: string) => {
    resolveUnresolvedCredit(escrowId, "user-dismissed");
    bumpStrandedTick((t) => t + 1);
  };
  // 6.0.2 liveness probe. Keyed by the exact bearer string so two cards
  // holding different notes stay independently tappable, and so a double-tap
  // on one card can't fire twice (the probe layer coalesces too, but a
  // disabled button is the honest surface).
  const [probingNotes, setProbingNotes] = useState<string | null>(null);
  const reabsorb = async (input: {
    oobNotes: string;
    expectedMsats: number;
    context: "pending-export" | "stranded-claim";
    escrowId?: string;
  }) => {
    if (!onReabsorbBearerNotes || probingNotes) return;
    setProbingNotes(input.oobNotes);
    try {
      await onReabsorbBearerNotes(input);
    } finally {
      setProbingNotes(null);
      // App has already resolved the storage records; re-read them. An
      // `unknown` outcome changes nothing, and the re-read shows exactly that.
      bumpStrandedTick((t) => t + 1);
    }
  };
  /** The one action shared by all three recovery cards. */
  const reabsorbButton = (
    input: {
      oobNotes: string;
      expectedMsats: number;
      context: "pending-export" | "stranded-claim";
      escrowId?: string;
    },
    opts: { label: string; accent: string },
  ) => {
    const busy = probingNotes === input.oobNotes;
    return (
      <button
        onClick={(e) => { e.stopPropagation(); void reabsorb(input); }}
        disabled={probingNotes !== null}
        style={{
          width: "100%",
          minHeight: 40, padding: "11px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${opts.accent}66`,
          color: opts.accent, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
          cursor: probingNotes === null ? "pointer" : "default",
          opacity: probingNotes !== null && !busy ? 0.5 : 1,
        }}
      >
        {busy ? t("me.reabsorbBusy") : opts.label}
      </button>
    );
  };
  const paidLockRows = listPaidLockRecoveries().filter(row => row.federationId === paidLockFederationId);

  const moneyEntries: MoneySafetyEntry[] = [
    ...paidLockRows.map(row => ({ ...row, key: `paid-lock:${row.escrowId}` })),
    ...(onExportStrandedClaim ? loudClaims.map(e => ({ kind: "stranded-claim" as const, key: `claim:${e.escrowId}`, ...e })) : []),
    ...calmClaims.map(e => ({ ...e, kind: "unresolved-credit" as const, key: `credit:${e.escrowId}` })),
    ...(showLocalRecovery && !isSmallLeftover ? [{ kind: "leftover" as const, key: "leftover", amountMsats: balanceMsats, createdAt: 0 }] : []),
    ...(stuckNativeLocks ?? []).map(e => ({ ...e, kind: "lock-recovery" as const, key: `lock:${e.escrowId}` })),
    ...(pendingEcashExport && onWithdrawEcash ? [{ ...pendingEcashExport, kind: "pending-ecash-export" as const, key: "export" }] : []),
  ];
  const safety = selectMoneySafetyFocus(moneyEntries);
  const isFocus = (key: string) => safety.focus?.key === key;
  const isClaimPayoutRecovery = !isSmallLeftover && Boolean(satsTrace?.escrowId);
  const traceCopy = describeSatsTrace(satsTrace ?? null);

  const hasVisibleMoneyAction =
    loudClaims.length > 0
    || calmClaims.length > 0
    || (showLocalRecovery && !isSmallLeftover)
    || Boolean(stuckNativeLocks?.length)
    || Boolean(pendingEcashExport && onWithdrawEcash);
  return {
    localRecoverySats, localRecoverableSats, localReserveSats, isSmallLeftover, recoverWorthwhile,
    pendingEcashExport, loudClaims, calmClaims, dismissClaim, reabsorbButton, paidLockRows,
    moneyEntries, safety, isFocus, isClaimPayoutRecovery, traceCopy, hasVisibleMoneyAction,
  };
}

export function HeldSats({
  pubkey, balanceKnown = true, balanceUnreadable = false, walletInvite, onRecoverSats, onOpenTrade,
  walletNeedsTap = false, onUseWallet, pendingCards, readLeftovers, leftoversRevision, onOpenBond, ...input
}: MoneySafetyInput & {
  pubkey: string;
  balanceKnown?: boolean;
  /** The wallet is open but its balance could not be read. "Can't read" is
   *  never "none", so Home says Chama can't check rather than nothing. */
  balanceUnreadable?: boolean;
  walletInvite?: string;
  /** The "Finish locking" and "Finish your payout" cards: while either owns
   *  the balance, they are its way out, so Home shows them here too. */
  pendingCards?: ReactNode;
  onRecoverSats: () => void;
  onOpenTrade: (id: string) => void;
  /** The signer needs a tap before the wallet can open, so Chama cannot yet
   *  see what it holds. Opening it stays a tap, never automatic. */
  walletNeedsTap?: boolean;
  onUseWallet?: () => void;
  /** The remaining places sats can sit (claims still redeeming, Fedi ecash
   *  going back, reclaimed bonds, on-chain payouts). */
  readLeftovers?: () => Promise<HeldLeftoversData>;
  leftoversRevision?: number;
  onOpenBond?: () => void;
}) {
  const { t, lang } = useT();
  const leftovers = useHeldLeftovers(readLeftovers, leftoversRevision);
  const {
    balanceMsats, satsTrace, stuckNativeLocks, paidLockFederationId,
    onWithdrawEcash, onExportStrandedClaim, onReabsorbBearerNotes,
    hasPendingNativeLock, hasPendingClaimPayout,
  } = input;
  const {
    localRecoverySats, localRecoverableSats, localReserveSats, isSmallLeftover, recoverWorthwhile,
    pendingEcashExport, loudClaims, calmClaims, dismissClaim, reabsorbButton, paidLockRows,
    moneyEntries, safety, isFocus, isClaimPayoutRecovery, traceCopy,
  } = useMoneySafety(input);
  // These rows used to be acknowledged when Me's Wallet tab was shown; Home is
  // where they are on screen now, beside the balance they were refunded to.
  const unseenPaidLocks = paidLockRows.filter(row => !row.seen).map(row => row.escrowId).join(",");
  useEffect(() => {
    if (!paidLockFederationId) return;
    // A corrupt record must not take Home down with it: Home is where people
    // land, and the rows stay unacknowledged (still shown) if this fails.
    try { acknowledgePaidLockRecoveries(paidLockFederationId, balanceMsats); }
    catch (error) { console.error("[chama] paid-lock acknowledgement failed:", error); }
  }, [paidLockFederationId, balanceMsats, unseenPaidLocks]);

  const parked = parkedWalletRoutes(pubkey, walletInvite);
  const leftoverCard = moneyEntries.some(entry => entry.kind === "leftover");
  // Any sats the wallet holds that no card above already names (a leftover
  // below the dust line, or one a pending lock or payout is about to use).
  const showBalanceLine = balanceKnown && balanceMsats > 0 && !leftoverCard;
  // While a pending lock or claim payout owns the balance, sending it out
  // here would abandon a resumable trade (#37): those cards are the way out.
  const balanceCanLeave = Boolean(onWithdrawEcash) && !hasPendingNativeLock && !hasPendingClaimPayout;
  // When nothing shows, Home says nothing. It never claims Chama holds none
  // of your sats: some places sats can sit (bonds, an on-chain payout not
  // yet swept, a claim still redeeming) are shown on their own screens, so a
  // "nothing here" line could be false (second review of #78).
  if (moneyEntries.length === 0 && !showBalanceLine && parked.length === 0 && !walletNeedsTap
    && !balanceUnreadable && !pendingCards && !leftoversShowSomething(leftovers.result)) return null;

  return (
    <section data-held-sats style={{ display: "flex", flexDirection: "column" }}>
      <h2 style={{ margin: "0 0 10px", fontFamily: T.sans, fontSize: T.fs.title2, fontWeight: 700, color: T.ink }}>
        {t("dash.yourSats")}
      </h2>
      {walletNeedsTap && onUseWallet && (
        <button type="button" data-held-sats-open onClick={onUseWallet} style={{
          minHeight: T.size.touch, marginBottom: 16, padding: "12px 14px", borderRadius: T.rs, textAlign: "left",
          background: T.surface, border: `1px solid ${T.border}`, color: T.text,
          fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
        }}>
          {t("dash.checkHeldSats")} ›
        </button>
      )}
      {balanceUnreadable && (
        <div data-held-sats-unreadable style={{
          background: T.card, border: `1px solid ${T.amber}55`, borderRadius: T.r, marginBottom: 16, overflow: "hidden",
        }}>
          <WalletBalance balanceMsats={0} known={false} invite={walletInvite} />
          <div style={{ padding: "0 16px 16px", color: T.text, fontFamily: T.sans, fontSize: T.fs.secondary, lineHeight: 1.5 }}>
            {t("dash.cantCheckSats")}
          </div>
        </div>
      )}
      {pendingCards}
      <HeldLeftovers result={leftovers.result} onOpenTrade={onOpenTrade} onOpenBond={onOpenBond} onCheckAgain={leftovers.refresh} />
      {/* ── MONEY-SAFETY, always visible (never collapsed) ──────────────────
          Recovery / stranded-claim / lock-recovery / pending-ecash cards are
          money-critical, so they sit right under the hero — never hidden in a
          closed accordion. */}

      <div data-money-safety-focus={safety.focus?.key} data-tone={safety.focusTone ?? undefined}>
      {/* v3.4.0 C13 — stranded claim notes. INVARIANT(stranded-notes-surfaced):
          a bearer note the drain gave up on gets a persistent, actionable
          alarm — not a console line. Tap → EcashExportModal (preset mode)
          with QR + copy, so the user can move the money to safety. */}
      {/* LOUD: poisoned / retries-exhausted — the bearer note is (or may be)
          LIVE money the drain couldn't redeem. Stays a red, tap-to-export alarm;
          never balance-downgraded. */}
      {onExportStrandedClaim && loudClaims.filter(e => isFocus(`claim:${e.escrowId}`)).map((entry) => (
        <div
          key={entry.escrowId}
          onClick={() => onExportStrandedClaim(entry)}
          style={{
            background: T.redDim, border: `1px solid ${T.red}88`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
            boxShadow: `0 0 30px ${T.red}22`,
          }}
        >
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 600, color: T.red,
            fontFamily: T.sans, marginBottom: 8,
          }}>
            {t("me.strandedClaimTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{t(walletHome() === "app" ? "me.strandedClaimBodyApp" : "me.strandedClaimBody")}
          </div>
          {/* The honest alternative to exporting a note nobody has tested:
              ask the federation by taking it. Either the sats land in the
              balance or this card learns it was chasing nothing. */}
          {onReabsorbBearerNotes && (
            <div style={{ marginTop: 12 }}>
              {reabsorbButton(
                {
                  oobNotes: entry.oobNotes,
                  expectedMsats: entry.amountMsats,
                  context: "stranded-claim",
                  escrowId: entry.escrowId,
                },
                { label: t("me.reabsorbCta"), accent: T.text },
              )}
            </div>
          )}
        </div>
      ))}

      {/* CALM: unresolved-credit whose amount the wallet balance does NOT cover.
          The note was reported already-redeemed (so it's not live money to
          rescue) but this wallet is short. Honest, dismissible nudge; the note
          is archived (kept) on dismiss. The balance-covered case never reaches
          here — it auto-reconciles silently. */}
      {calmClaims.filter(e => isFocus(`credit:${e.escrowId}`)).map((entry) => {
        // Two different states share this card, and only one has been tested.
        // Unprobed: where the sats went is NOT established — the copy names no
        // cause and points at the probe (the reabsorb CTA) as the way to find
        // out. Probed consumed-uncredited: the federation confirmed it took the
        // notes, and where the sats went is still NOT established, so neither
        // state ever asserts a location.
        const probedConsumed = entry.probeVerdict === "consumed-uncredited";
        return (
        <div
          key={entry.escrowId}
          style={{
            background: T.card, border: `1px solid ${T.amber}55`,
            borderRadius: T.r, padding: 18, marginBottom: 16,
          }}
        >
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 600, color: T.amber,
            fontFamily: T.sans, marginBottom: 8,
          }}>
            {probedConsumed ? t("me.probedConsumedTitle") : t("me.checkOtherDeviceTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 12 }}>
            <BitcoinAmount sats={Math.floor(entry.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{probedConsumed ? t("me.probedConsumedBody") : t("me.checkOtherDeviceBody")}
          </div>
          {/* WHEN this was stashed. These cards are kept on purpose as
              evidence (v6.0 staged-settlement work: historical cases are
              never rewritten as recovered), so the date is what tells you
              whether you are looking at an old scar or a new wound. */}
          {entry.createdAt > 0 && (
            <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginBottom: 12 }}>
              {t("me.strandedSince", {
                date: new Date(entry.createdAt).toLocaleDateString(lang, {
                  year: "numeric", month: "short", day: "numeric",
                }),
              })}
            </div>
          )}
          {/* The unprobed card's whole claim is an inference; the probe is the
              only thing that can settle it. Once it HAS been settled, offering
              to probe again is offering to re-ask a question already answered
              — so the button goes away with the guess it replaced. */}
          {onReabsorbBearerNotes && !probedConsumed && (
            <div style={{ marginBottom: 8 }}>
              {reabsorbButton(
                {
                  oobNotes: entry.oobNotes,
                  expectedMsats: entry.amountMsats,
                  context: "stranded-claim",
                  escrowId: entry.escrowId,
                },
                { label: t("me.reabsorbCta"), accent: T.amber },
              )}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {onExportStrandedClaim && (
              <button
                onClick={() => onExportStrandedClaim(entry)}
                style={{
                  flex: 1, minHeight: 40, borderRadius: T.rs,
                  background: "none", border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                {t("me.viewNote")}
              </button>
            )}
            <button
              onClick={() => dismissClaim(entry.escrowId)}
              style={{
                flex: 1, minHeight: 40, borderRadius: T.rs,
                background: T.amberDim, border: `1px solid ${T.amber}66`,
                color: T.amber, fontFamily: T.sans, fontSize: 13, fontWeight: 800,
                cursor: "pointer",
              }}
            >
              {t("me.dismiss")}
            </button>
          </div>
        </div>
        );
      })}

      {/* Only surface a leftover once it's worth acting on. Below the dust line it
          reads as "you're losing sats in limbo" — against Chama's no-wallet promise —
          so it stays hidden and silently accumulates until it crosses the threshold,
          when this card (and its fee-free ecash exit) reappears. A pending minted
          ecash note still shows below regardless. */}
      {isFocus("leftover") && (
        <div style={{
          background: isClaimPayoutRecovery ? T.amberDim : T.card,
          border: `1px solid ${isSmallLeftover ? T.border : T.amber}`,
          borderRadius: T.r, padding: 20, marginBottom: 16,
          boxShadow: isClaimPayoutRecovery ? `0 0 30px ${T.amber}22` : "none",
        }}>
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 600, color: isSmallLeftover ? T.muted : T.amber,
            fontFamily: T.sans, marginBottom: 12,
          }}>
            {isClaimPayoutRecovery ? t("me.payoutRecoveryTitle") : t("me.satsRecoveryTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {isSmallLeftover ? (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.smallLeftoverBody")}
              </>
            ) : (
              <>
                <BitcoinAmount sats={localRecoverySats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.recoverReadyBody")}
                {localReserveSats > 0 && (
                  <>
                    {" "}{t("me.reservedForFeesBefore")} <BitcoinAmount sats={localReserveSats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} /> {t("me.reservedForFeesAfter")}
                  </>
                )}
              </>
            )}
          </div>
          {traceCopy && (
            <div style={{
              marginTop: 10, padding: "9px 10px",
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, color: T.muted,
              fontFamily: T.mono, fontSize: 10, lineHeight: 1.45,
            }}>
              {t("me.tracePrefix", { trace: traceCopy })}
              {satsTrace?.escrowId ? (
                <div style={{ wordBreak: "break-all" as const, marginTop: 4 }}>
                  {satsTrace.escrowId}
                </div>
              ) : null}
            </div>
          )}
          <button
            onClick={onRecoverSats}
            disabled={!recoverWorthwhile}
            style={{
              width: "100%", padding: "12px", marginTop: 14,
              background: recoverWorthwhile ? T.amberDim : T.surface,
              border: `1px solid ${recoverWorthwhile ? T.amber + "66" : T.border}`,
              borderRadius: T.rs,
              color: recoverWorthwhile ? T.amber : T.muted,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
              cursor: recoverWorthwhile ? "pointer" : "default",
            }}
          >
            {recoverWorthwhile
              ? <>{isClaimPayoutRecovery ? t("me.recoverPayout") : t("me.recover")} <BitcoinAmount sats={localRecoverableSats} size={T.fs.secondary} gap={4} glyphScale={1.18} color="inherit" glyphColor="inherit" /></>
              : isSmallLeftover
                ? t("me.accumulatingTooSmall")
                : t("me.waitingEnoughSats")}
          </button>
          {/* v2.4 #56 — fee-free ecash exit. Available for ANY balance,
              including dust the LN "Recover" button can't economically move.
              Spends the balance into a Fedimint note importable into Fedi or
              any Fedimint wallet on this federation. */}
          {onWithdrawEcash && (
            <button
              onClick={onWithdrawEcash}
              style={{
                width: "100%", padding: "11px", marginTop: 8,
                background: T.surface, border: `1px solid ${T.teal}55`,
                borderRadius: T.rs, color: T.teal,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
              }}
            >
              {t("me.withdrawEcash")}
            </button>
          )}
          {onWithdrawEcash && (
            <div style={{
              marginTop: 6, fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans,
              lineHeight: 1.5, textAlign: "center",
            }}>
              {t(withdrawEcashHintKey())}
            </div>
          )}
        </div>
      )}

      {paidLockRows.map(row => <p key={row.createdAt} data-paid-lock-recovery>{row.message}</p>)}
      {/* #37 — lock-recovery entries whose automatic retries were exhausted.
          Calm + informational (the notes are kept safe, nothing is lost):
          re-opening the trade and tapping Fund/Finish retries recovery with
          a fresh budget. Deliberately NOT the loud red treatment — the
          value is bearer notes in localStorage, not maybe-live claim money. */}
      {stuckNativeLocks && stuckNativeLocks.length > 0 && stuckNativeLocks.filter(e => isFocus(`lock:${e.escrowId}`)).map((entry) => (
        <div key={entry.escrowId} style={{
          background: T.card, border: `1px solid ${T.amber}55`,
          borderRadius: T.r, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 600, color: T.amber,
            fontFamily: T.sans, marginBottom: 10,
          }}>
            {t("me.lockRecoveryPausedTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {t("me.lockRecoveryBodyBefore")}{" "}
            <BitcoinAmount msats={entry.amountMsats} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />{" "}
            {t("me.lockRecoveryBodyAfter")}
          </div>
          <div style={{
            marginTop: 8, fontFamily: T.mono, fontSize: 10, color: T.muted,
            wordBreak: "break-all" as const,
          }}>
            {entry.escrowId}
            {entry.lastError ? <div style={{ marginTop: 4 }}>{t("me.lastError", { error: entry.lastError.slice(0, 120) })}</div> : null}
          </div>
          <button
            onClick={() => onOpenTrade(entry.escrowId)}
            style={{
              width: "100%", padding: "11px", marginTop: 12,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, color: T.text,
              fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
            }}
          >
            {t("me.openTrade")}
          </button>
        </div>
      ))}

      {/* v2.4 #56 — pending ecash export re-entry. After generating a note the
          balance reads 0, so the SATS RECOVERY card hides; this is how the user
          gets back to the bearer note they minted until they confirm import. */}
      {isFocus("export") && pendingEcashExport && onWithdrawEcash && (
        <div
          onClick={onWithdrawEcash}
          style={{
            background: T.amberDim, border: `1px solid ${T.amber}66`,
            borderRadius: T.r, padding: 20, marginBottom: 16, cursor: "pointer",
          }}
        >
          <div style={{
            fontSize: T.fs.secondary, fontWeight: 600, color: T.amber,
            fontFamily: T.sans, marginBottom: 8,
          }}>
            {t("me.pendingEcashExportTitle")}
          </div>
          <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
            {t("me.mintedEcashBefore")}{" "}
            <BitcoinAmount sats={Math.floor(pendingEcashExport.amountMsats / 1000)} size={13} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
            {" "}{pendingEcashExport.federationLabel
              ? t("me.mintedEcashAfterOnFed", { federation: pendingEcashExport.federationLabel })
              : t("me.mintedEcashAfter")}
          </div>
          {/* The missing exit. Before this, onWithdrawEcash was the card's
              ONLY action, so a note the user knows is dead could not be
              cleared and assertEcashExportWritable then blocked every future
              export. This needs no "are you sure?" — nothing is being
              discarded. The user either gets the money back or learns there
              was none. It IS a cancel-send, so it says so. */}
          {onReabsorbBearerNotes && (
            <div style={{ marginTop: 12 }}>
              {reabsorbButton(
                {
                  oobNotes: pendingEcashExport.notes,
                  expectedMsats: pendingEcashExport.amountMsats,
                  context: "pending-export",
                  escrowId: pendingEcashExport.escrowId,
                },
                { label: t("me.reabsorbCancelCta"), accent: T.amber },
              )}
            </div>
          )}
        </div>
      )}

      </div>
      {safety.quiet.length > 0 && <div data-money-safety-quiet data-tone={safety.quietTone} style={{ border: `1px solid ${T.border}`, borderRadius: T.r, marginBottom: 16 }}>
        <div style={{ padding: "12px 14px", color: T.muted, font: `600 ${T.fs.secondary} ${T.sans}` }}>{t("me.moneySafetyOther")}</div>
        {safety.quiet.map(item => {
          const claim = [...loudClaims, ...calmClaims].find(e => e.escrowId === item.escrowId);
          const title = item.kind === "stranded-claim" ? t("me.strandedClaimTitle")
            : item.kind === "unresolved-credit" ? t(claim?.probeVerdict === "consumed-uncredited" ? "me.probedConsumedTitle" : "me.checkOtherDeviceTitle")
            : item.kind === "leftover" ? t("me.satsRecoveryTitle")
            : item.kind === "lock-recovery" ? t("me.lockRecoveryPausedTitle") : t("me.pendingEcashExportTitle");
          const open = () => {
            if ((item.kind === "stranded-claim" || item.kind === "unresolved-credit") && claim) onExportStrandedClaim?.(claim);
            else if (item.kind === "leftover") { if (recoverWorthwhile) onRecoverSats(); else onWithdrawEcash?.(); }
            else if (item.kind === "lock-recovery") onOpenTrade(item.escrowId!);
            else if (item.kind === "pending-ecash-export") onWithdrawEcash?.();
          };
          return <div key={item.key} data-money-safety-row={item.key} style={{ borderTop: `1px solid ${T.border}`, padding: "10px 14px" }}>
            <button type="button" onClick={open} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", minHeight: 44, padding: 0, border: 0, background: "none", color: T.text, textAlign: "left", cursor: "pointer" }}>
              <span style={{ flex: 1, minWidth: 0 }}>{title}</span><BitcoinAmount msats={item.amountMsats} size={T.fs.secondary} color={T.text} glyphColor={T.muted}/><span aria-hidden="true">›</span>
            </button>
            {onReabsorbBearerNotes && claim && (item.kind === "stranded-claim" || item.kind === "unresolved-credit" && claim.probeVerdict !== "consumed-uncredited") && reabsorbButton({ oobNotes: claim.oobNotes, expectedMsats: claim.amountMsats, context: "stranded-claim", escrowId: claim.escrowId }, { label: t("me.reabsorbCta"), accent: T.muted })}
            {item.kind === "unresolved-credit" && <button type="button" onClick={() => dismissClaim(item.escrowId!)} style={{ background: "none", border: 0, minHeight: 40, color: T.muted, cursor: "pointer" }}>{t("me.dismiss")}</button>}
            {item.kind === "leftover" && onWithdrawEcash && <button type="button" onClick={onWithdrawEcash} style={{ background: "none", border: 0, minHeight: 40, color: T.muted, cursor: "pointer" }}>{t("me.withdrawEcash")}</button>}
            {item.kind === "pending-ecash-export" && pendingEcashExport && onReabsorbBearerNotes && reabsorbButton({ oobNotes: pendingEcashExport.notes, expectedMsats: pendingEcashExport.amountMsats, context: "pending-export", escrowId: pendingEcashExport.escrowId }, { label: t("me.reabsorbCancelCta"), accent: T.muted })}
          </div>;
        })}
      </div>}

      {showBalanceLine && (
        <div data-held-sats-balance style={{
          background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, marginBottom: 16, overflow: "hidden",
        }}>
          <WalletBalance balanceMsats={balanceMsats} known={balanceKnown} invite={walletInvite} />
          {balanceCanLeave && (
            <div style={{ padding: "0 16px 16px" }}>
              <button type="button" onClick={onWithdrawEcash} style={{
                width: "100%", minHeight: T.size.touch, padding: "11px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.teal}55`, color: T.teal,
                fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, cursor: "pointer",
              }}>
                {t("me.withdrawEcash")}
              </button>
              <div style={{ marginTop: 6, fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, lineHeight: 1.5, textAlign: "center" }}>
                {t(withdrawEcashHintKey())}
              </div>
            </div>
          )}
        </div>
      )}
      {parked.length > 0 && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, paddingTop: 16, marginBottom: 16 }}>
          <ParkedWallets pubkey={pubkey} activeInvite={walletInvite} />
        </div>
      )}
    </section>
  );
}
