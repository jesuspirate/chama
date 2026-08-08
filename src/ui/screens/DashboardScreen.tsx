// ══════════════════════════════════════════════════════════════════════════
// Chama — Dashboard (v5.0 "finish the bond" — the standing home)
// ══════════════════════════════════════════════════════════════════════════
//
// The home the bond + ratings have waited for. Replaces the v4.2.1 "coming soon"
// placeholder with the four things a Chama identity is made of:
//   1. STANDING   — public, trade-verified ratings (the trust you've earned).
//   2. YOUR BOND  — your commitment bond(s): capital locked in the open = "how
//                   much × how long" (dev-gated behind SHOW_BOND_CEREMONY until
//                   the bond ships to prod; this is where "become an arbiter" lives).
//   3. LIVENESS   — how live your chama is (bonded arbiters, computed, never faked).
//   4. STATS      — your trade activity at a glance.
//
// Read-only + composed from data the app already has; no new money path.

import { useEffect, useMemo, useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { LivenessSignal, useLiveness } from "../components/LivenessSignal.js";
import { countArbiterNoShows } from "../../escrow-engine/arbiter-substitution.js";
import type { ChamaLiveness } from "../../arbiters/live-chama.js";
import { listCommitmentBonds } from "../../bond-multisig/commitment-store.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
import { mergeDashboardBonds } from "../../bond-multisig/dashboard-bonds.js";
import { summarizeArbiterEarnings } from "../../arbiters/arbiter-earnings.js";
import { SHOW_BOND_CEREMONY } from "../panels/BondCeremonyModal.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { EscrowStatus, Role, type EscrowState } from "../../escrow-engine/types.js";
import type { AggregateRatings } from "../../reputation/ratings.js";
import { BitcoinConverter } from "../components/BitcoinConverter.js";

const TERMINAL = new Set<EscrowStatus>([
  EscrowStatus.COMPLETED, EscrowStatus.CANCELLED, EscrowStatus.CLAIMED,
]);

export function DashboardScreen({
  pubkey,
  ratings,
  myTrades,
  communitySlug,
  loadLiveness,
  livenessBlocksPerDay = 144,
  onOpenBondCeremony,
  earningsRevision = 0,
  fetchMyBonds,
  getBondChainTip,
}: {
  pubkey: string;
  /** The user's own trade-verified public rating (null until it can verify any). */
  ratings: AggregateRatings | null;
  myTrades: EscrowState[];
  communitySlug?: string | null;
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  livenessBlocksPerDay?: number;
  /** Open the bond ceremony (dev-gated). */
  onOpenBondCeremony?: () => void;
  /** Relay/local earnings reconciliation revision from useEscrow. */
  earningsRevision?: number;
  /** #77: fetch the signed-in npub's own chain-verified announced bonds, so a bond
   *  shows cross-device (a fresh install has no local commitment record). Fail-soft. */
  fetchMyBonds?: () => Promise<VerifiedBond[]>;
  getBondChainTip?: () => Promise<number>;
}) {
  const { t } = useT();
  const [converterOpen, setConverterOpen] = useState(false);
  const lower = pubkey.toLowerCase();
  const community = communitySlug ? getCommunityBySlug(communitySlug) : null;

  // Lean stats — completed / live / as-arbiter, computed inline (buildMeDashboard
  // is MeScreen's heavier queue model; the Dashboard only needs the headline counts).
  const stats = useMemo(() => {
    let completed = 0, live = 0, asArbiter = 0;
    for (const t of myTrades) {
      if (t.status === EscrowStatus.COMPLETED) completed++;
      else if (!TERMINAL.has(t.status)) live++;
      if (t.participants?.[Role.ARBITER]?.toLowerCase() === lower) asArbiter++;
    }
    return { total: myTrades.length, completed, live, asArbiter };
  }, [myTrades, lower]);

  // Disputes this npub was seated on, never voted in, and a backup had to rule.
  // Derived from the committed chain — see isArbiterNoShow.
  const noShowCount = useMemo(
    () => countArbiterNoShows(myTrades, pubkey, Math.floor(Date.now() / 1000)),
    [myTrades, pubkey],
  );

  // Read on every Dashboard render. Bond funding/renewal mutates the scoped
  // local store outside React; memoizing forever left a freshly confirmed bond
  // stuck visually at "awaiting funding" until the whole app remounted.
  const bonds = listCommitmentBonds();
  const [bondTip, setBondTip] = useState<number | null>(null);
  // Arbiter earnings (task #53 E1): sync ledger read, recomputed when the
  // trade set changes (a redeem lands via the App sweep → escrows update →
  // myTrades identity changes → fresh summary).
  const earnings = useMemo(() => summarizeArbiterEarnings(), [myTrades, earningsRevision]);
  const localActive = useMemo(
    () => bonds.filter((b) => b.phase === "created" || (b.phase === "locked" && (bondTip == null || b.bond.lockUntil > bondTip))),
    [bonds, bondTip],
  );

  // #77: cross-device bond visibility. Fetch-once-on-mount (keyed on pubkey),
  // fail-soft — a relay/esplora hiccup leaves the local set unchanged. Merged
  // below with the local commitment records, deduped by bond address.
  const [announcedBonds, setAnnouncedBonds] = useState<VerifiedBond[]>([]);
  useEffect(() => {
    if (!fetchMyBonds) return;
    let cancelled = false;
    void fetchMyBonds()
      .then((v) => { if (!cancelled) setAnnouncedBonds(v); })
      .catch(() => { /* fail-soft: keep local bonds only */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lower]);
  useEffect(() => {
    if (!getBondChainTip) return;
    let cancelled = false;
    const pull = () => void getBondChainTip().then((tip) => { if (!cancelled) setBondTip((old) => old == null ? tip : Math.max(old, tip)); }).catch(() => {});
    pull();
    const id = setInterval(pull, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [getBondChainTip]);

  const mergedBonds = useMemo(
    () => mergeDashboardBonds(localActive, announcedBonds, lower),
    [localActive, announcedBonds, lower],
  );

  const { liveness, loading: livenessLoading, outcome: livenessOutcome } = useLiveness(communitySlug ?? null, loadLiveness, { intervalMs: 90_000 });

  const ratePct = ratings && ratings.count > 0 ? Math.round((ratings.positive / ratings.count) * 100) : null;

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto", animation: "fadeIn 0.3s ease" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>
            {t("bond.dashHeading")}
          </div>
          <div style={{ fontSize: 22, fontWeight: 900, color: T.text, fontFamily: T.sans }}>
            {t("bond.dashTitle")}
          </div>
        </div>
        <button
          type="button"
          aria-expanded={converterOpen}
          onClick={() => setConverterOpen((open) => !open)}
          style={{ display: "flex", alignItems: "center", gap: 7, flex: "0 0 auto", padding: "9px 11px", borderRadius: T.rs, border: `1px solid ${converterOpen ? T.accent : T.accent + "66"}`, background: converterOpen ? T.accentDim : T.card, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: .4, cursor: "pointer", boxShadow: `0 0 0 1px ${T.accent}12` }}
        >
          <span aria-hidden="true" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", background: "#f7931a", color: "#fff", fontFamily: T.sans, fontSize: 14, fontWeight: 900, lineHeight: 1 }}>₿</span>
          {t("bond.converterHeading")}
        </button>
      </div>

      {converterOpen && <BitcoinConverter communitySlug={communitySlug} />}

      {/* 0. EARNINGS (task #53 E1) — insurance premiums redeemed as a bonded
          arbiter. THE recruitment ad: shown whenever the ceremony is exposed,
          with honest zero-state copy until the first premium lands. */}
      {(earnings.noteCount > 0 || SHOW_BOND_CEREMONY) && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 10 }}>
            {t("bond.dashEarnings")}
          </div>
          {earnings.noteCount > 0 ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <BitcoinAmount sats={Math.floor(earnings.totalMsats / 1000)} size={24} gap={6} glyphScale={1.15} color={T.green} glyphColor={T.green} />
                <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
                  {t("bond.dashEarningsCovered", { count: earnings.tradeCount })}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginTop: 10 }}>
                {t("bond.dashEarningsHint")}
              </div>
            </>
          ) : (
            <div style={{ fontSize: 12.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.55 }}>
              {t("bond.dashEarningsEmpty")}
            </div>
          )}
        </div>
      )}

      {/* 1. STANDING — the hero. Public, trade-verified trust. */}
      <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 14 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
          {t("bond.dashStanding")}
        </div>
        {ratePct !== null ? (
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 34, fontWeight: 900, color: T.green, fontFamily: T.sans, lineHeight: 1 }}>
              {ratePct}%
            </span>
            <span style={{ fontSize: 13, color: T.muted, fontFamily: T.mono }}>{t("bond.dashPositive")}</span>
            <span style={{ marginLeft: "auto", fontSize: 12, color: T.muted, fontFamily: T.mono }}>
              {t("bond.dashRatedLine", { positive: ratings!.positive, negative: ratings!.negative, count: ratings!.count })}
            </span>
          </div>
        ) : (
          <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
            {t("bond.dashNewHereBefore")}<span style={{ color: T.muted }}>{t("bond.dashNewHereBody")}</span>
          </div>
        )}
        {noShowCount > 0 && (
          // Accountability #1: your own record, shown to you first. Ratings say
          // how you ruled; this says whether you turned up at all — the one
          // arbiter failure the chain can prove.
          <div style={{
            marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}`,
            fontSize: 11, fontFamily: T.mono, color: T.amber, lineHeight: 1.5,
          }}>
            {t("bond.dashNoShows", { count: noShowCount })}
          </div>
        )}
      </div>

      {/* 2. YOUR BOND — dev-gated until the bond ships to prod. Where "become an
          arbiter" lives: locked capital, in the open, is the commitment signal. */}
      {SHOW_BOND_CEREMONY && (
        <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: 20, marginBottom: 14 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>
              {t("bond.dashYourBond")}
            </div>
            {onOpenBondCeremony && (
              <button onClick={onOpenBondCeremony}
                style={{ background: T.accentDim, border: `1px solid ${T.accent}66`, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, padding: "5px 10px", borderRadius: T.rs, cursor: "pointer" }}>
                {mergedBonds.length > 0 ? t("bond.dashManage") : t("bond.dashPostABond")}
              </button>
            )}
          </div>
          {mergedBonds.length > 0 ? (
            <div style={{ display: "grid", gap: 8 }}>
              {mergedBonds.map((b) => (
                <div key={b.key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, padding: "10px 12px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs }}>
                  <span style={{ fontSize: 14, fontWeight: 800, color: T.text, fontFamily: T.mono }}>
                    <BitcoinAmount sats={b.amountSats} size={14} gap={4} glyphScale={1.18} color={T.text} glyphColor={T.muted} />
                    {bondTip != null && b.locked && b.lockUntil - bondTip <= 4_320 && (
                      <span style={{ display: "block", marginTop: 4, fontSize: 9.5, color: b.lockUntil <= bondTip ? T.red : T.amber, fontWeight: 700 }}>
                        {b.lockUntil <= bondTip
                          ? t("bond.dashExpired")
                          : t("bond.dashExpiresIn", { blocks: b.lockUntil - bondTip })}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 1, fontFamily: T.mono, color: b.locked && (bondTip == null || b.lockUntil > bondTip) ? T.green : T.amber, border: `1px solid ${b.locked && (bondTip == null || b.lockUntil > bondTip) ? T.green : T.amber}`, borderRadius: 99, padding: "2px 8px" }}>
                    {b.locked ? (bondTip != null && b.lockUntil <= bondTip ? t("bond.chipTermEnded") : t("bond.chipLockedEmoji")) : t("bond.chipAwaitingFunding")}
                  </span>
                </div>
              ))}
              {/* Announced-only bonds have no local reclaim material (the reclaim
                  key is device-local) — say so instead of implying a reclaim that
                  can't run here. */}
              {mergedBonds.some((b) => !b.local) && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, lineHeight: 1.5, marginTop: 2 }}>
                  {t("bond.dashAnnouncedElsewhere")}
                </div>
              )}
              <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginTop: 2 }}>
                {t("bond.dashLockedCapital")}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 14, color: T.text, fontFamily: T.sans, lineHeight: 1.55 }}>
              {t("bond.dashNoBondBefore")}<span style={{ color: T.muted }}>{t("bond.dashNoBondBody")}</span>
            </div>
          )}
        </div>
      )}

      {/* 3. CHAMA LIVENESS — how live your community is (computed, chain-verified). */}
      {loadLiveness && communitySlug && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
            {community?.flagEmoji ?? "🌍"} {community?.displayName ?? communitySlug}
          </div>
          <LivenessSignal liveness={liveness} loading={livenessLoading} outcome={livenessOutcome} blocksPerDay={livenessBlocksPerDay} />
        </div>
      )}

      {/* 4. STATS — trade activity at a glance. */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
        <StatTile label={t("bond.dashStatTrades")} value={stats.total} />
        <StatTile label={t("bond.dashStatCompleted")} value={stats.completed} accent={T.green} />
        <StatTile label={t("bond.dashStatLive")} value={stats.live} accent={stats.live > 0 ? T.accent : undefined} />
      </div>
      {stats.asArbiter > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.muted, fontFamily: T.mono, textAlign: "center" }}>
          {t("bond.dashArbitratedBefore")}<span style={{ color: T.text, fontWeight: 700 }}>{stats.asArbiter}</span>{t(stats.asArbiter === 1 ? "bond.dashArbitratedAfterOne" : "bond.dashArbitratedAfterMany")}
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div style={{ background: T.surface, borderRadius: T.r, padding: "14px 12px", textAlign: "center" }}>
      <div style={{ fontSize: 24, fontWeight: 900, color: accent ?? T.text, fontFamily: T.sans, lineHeight: 1 }}>{value}</div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5, marginTop: 6, textTransform: "uppercase" }}>{label}</div>
    </div>
  );
}
