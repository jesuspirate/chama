// ══════════════════════════════════════════════════════════════════════════
// Chama — Dashboard (v6.3 "Pulse" — approved design 2026-09-05)
// ══════════════════════════════════════════════════════════════════════════
//
// The standing home, rebuilt to the approved Option A "Pulse" canvas:
//   HERO      — sats-traded volume over a selectable window, drawn live from
//               the user's own trades (money that actually reached escrow).
//   TILES     — trades / completed / live / rating / sats-on-this-device.
//   BREAKDOWN — where you trade (Exchange / Bill Pay / Market share).
//   EARNINGS  — lifetime arbiter premiums (+ the on-device withdraw).
//   LIVENESS  — how live your chama is (unchanged component).
//   BOND      — your commitment bond(s) (dev-gated, logic unchanged).
//
// Read-only + composed from data the app already has; no new money path.
// Never called a "wallet" anywhere — Chama is not a wallet.

import { useEffect, useMemo, useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { useLiveness } from "../components/LivenessSignal.js";
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

/** Sats that actually moved: the trade reached a funded state at some point. */
function movedMsats(e: EscrowState): number {
  if (e.status === EscrowStatus.CREATED || e.status === EscrowStatus.CANCELLED) return 0;
  return e.amountMsats;
}

type WindowKey = "90d" | "year" | "all";

export function DashboardScreen({
  pubkey,
  ratings,
  myTrades,
  communitySlug,
  loadLiveness,
  livenessBlocksPerDay = 144,
  onOpenBondCeremony,
  earningsRevision = 0,
  balanceMsats = 0,
  onWithdrawEcash,
  fetchMyBonds,
  getBondChainTip,
}: {
  pubkey: string;
  ratings: AggregateRatings | null;
  myTrades: EscrowState[];
  communitySlug?: string | null;
  loadLiveness?: (slug: string, signal?: AbortSignal) => Promise<ChamaLiveness | null>;
  livenessBlocksPerDay?: number;
  onOpenBondCeremony?: () => void;
  earningsRevision?: number;
  balanceMsats?: number;
  onWithdrawEcash?: () => void;
  fetchMyBonds?: () => Promise<VerifiedBond[]>;
  getBondChainTip?: () => Promise<number>;
}) {
  const { t } = useT();
  const [converterOpen, setConverterOpen] = useState(false);
  const [windowKey, setWindowKey] = useState<WindowKey>("90d");
  const lower = pubkey.toLowerCase();
  const community = communitySlug ? getCommunityBySlug(communitySlug) : null;
  const nowSec = Math.floor(Date.now() / 1000);

  const windowSec = windowKey === "90d" ? 90 * 86400 : windowKey === "year" ? 365 * 86400 : null;
  const windowStart = windowSec ? nowSec - windowSec : 0;

  const windowTrades = useMemo(
    () => (windowSec ? myTrades.filter((e) => (e.createdAt ?? 0) >= windowStart) : myTrades),
    [myTrades, windowStart, windowSec],
  );

  // Lean stats over the selected window (arbiter count stays lifetime).
  const stats = useMemo(() => {
    let completed = 0, live = 0, asArbiter = 0;
    for (const e of windowTrades) {
      if (e.status === EscrowStatus.COMPLETED) completed++;
      else if (!TERMINAL.has(e.status)) live++;
    }
    for (const e of myTrades) {
      if (e.participants?.[Role.ARBITER]?.toLowerCase() === lower) asArbiter++;
    }
    return { total: windowTrades.length, completed, live, asArbiter };
  }, [windowTrades, myTrades, lower]);

  // Volume engine: 12 buckets across the window; sats that reached escrow.
  const volume = useMemo(() => {
    const moved = windowTrades
      .map((e) => ({ at: e.createdAt ?? 0, sats: Math.floor(movedMsats(e) / 1000) }))
      .filter((r) => r.sats > 0);
    const totalSats = moved.reduce((s, r) => s + r.sats, 0);
    const liveMsats = windowTrades
      .filter((e) => !TERMINAL.has(e.status) && e.status !== EscrowStatus.CREATED && e.status !== EscrowStatus.EXPIRED)
      .reduce((s, e) => s + e.amountMsats, 0);
    const start = windowSec
      ? windowStart
      : Math.min(nowSec - 86400, ...moved.map((r) => r.at).filter((a) => a > 0));
    const span = Math.max(nowSec - start, 86400);
    const buckets = new Array(12).fill(0) as number[];
    for (const r of moved) {
      const idx = Math.min(11, Math.max(0, Math.floor(((r.at - start) / span) * 12)));
      buckets[idx] += r.sats;
    }
    // Prior-window comparison (only for bounded windows).
    let deltaPct: number | null = null;
    if (windowSec) {
      const prior = myTrades
        .filter((e) => (e.createdAt ?? 0) >= windowStart - windowSec && (e.createdAt ?? 0) < windowStart)
        .reduce((s, e) => s + Math.floor(movedMsats(e) / 1000), 0);
      // Only meaningful when the prior window carried REAL volume — a 300%
      // banner off a 100-sat test window is noise, not signal.
      if (prior >= 1_000 && prior >= totalSats * 0.05) {
        deltaPct = Math.round(((totalSats - prior) / prior) * 100);
      }
    }
    return { totalSats, buckets, start, deltaPct, liveSats: Math.floor(liveMsats / 1000) };
  }, [windowTrades, myTrades, windowSec, windowStart, nowSec]);

  // Where you trade: share of moved volume per live vertical.
  const verticals = useMemo(() => {
    const sums = new Map<string, number>();
    for (const e of windowTrades) {
      const sats = Math.floor(movedMsats(e) / 1000);
      if (sats <= 0) continue;
      sums.set(e.category, (sums.get(e.category) ?? 0) + sats);
    }
    const total = [...sums.values()].reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    const order: Array<{ key: string; labelKey: string; color: string }> = [
      { key: "p2p-trade", labelKey: "me.categoryExchange", color: T.accent },
      { key: "bill-pay", labelKey: "browse.catBillPay", color: T.purple },
      { key: "marketplace", labelKey: "me.categoryMarket", color: T.teal },
    ];
    const rows = order
      .map((o) => ({ ...o, pct: Math.round(((sums.get(o.key) ?? 0) / total) * 100) }))
      .filter((r) => r.pct > 0);
    const other = 100 - rows.reduce((s, r) => s + r.pct, 0);
    if (other > 0 && rows.length > 0) rows[rows.length - 1]!.pct += other; // rounding dust
    return rows;
  }, [windowTrades]);

  const noShowCount = useMemo(
    () => countArbiterNoShows(myTrades, pubkey, nowSec),
    [myTrades, pubkey, nowSec],
  );

  const bonds = listCommitmentBonds();
  const [bondTip, setBondTip] = useState<number | null>(null);
  const earnings = useMemo(() => summarizeArbiterEarnings(), [myTrades, earningsRevision]);
  const localActive = useMemo(
    () => bonds.filter((b) => b.phase === "created" || (b.phase === "locked" && (bondTip == null || b.bond.lockUntil > bondTip))),
    [bonds, bondTip],
  );

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

  const kickerStyle = { fontSize: 9, fontWeight: 700, color: T.muted, fontFamily: T.mono, letterSpacing: 1.4, textTransform: "uppercase" as const };
  const cardStyle = { background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: "16px 18px" };
  const windowLabel = (k: WindowKey) => k === "90d" ? t("dash.window90") : k === "year" ? t("dash.windowYear") : t("dash.windowAll");

  return (
    <div style={{ padding: 16, maxWidth: 1080, margin: "0 auto", animation: "fadeIn 0.3s ease" }}>
      <style>{`
        .dash-tiles{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
        .dash-band{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:10px;margin-top:10px}
        @media(max-width:900px){.dash-tiles{grid-template-columns:repeat(3,minmax(0,1fr))}.dash-band{grid-template-columns:1fr}}
        @media(max-width:560px){.dash-tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}
      `}</style>

      {/* Header: kicker + title + window pills + converter */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.accent, fontFamily: T.mono, letterSpacing: 1.6 }}>
            {t("bond.dashHeading")}
          </div>
          <div style={{ fontSize: 28, fontWeight: 700, color: T.text, fontFamily: T.sans, letterSpacing: "-0.03em", lineHeight: 1.05, marginTop: 4 }}>
            {t("bond.dashTitle")}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {(["90d", "year", "all"] as WindowKey[]).map((k) => {
            const on = windowKey === k;
            return (
              <button key={k} type="button" aria-pressed={on} onClick={() => setWindowKey(k)}
                style={{ padding: "6px 13px", borderRadius: 999, cursor: "pointer", fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: 0.5, border: `1px solid ${on ? T.accent : T.borderHi}`, background: on ? T.accentDim : "transparent", color: on ? T.accent : T.muted }}>
                {windowLabel(k)}
              </button>
            );
          })}
          <button
            type="button"
            aria-expanded={converterOpen}
            onClick={() => setConverterOpen((open) => !open)}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 11px", borderRadius: 999, border: `1px solid ${converterOpen ? T.accent : T.accent + "66"}`, background: converterOpen ? T.accentDim : T.card, color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 800, letterSpacing: .4, cursor: "pointer" }}
          >
            <img src="/icons/bitcoin-mark-64.png" alt="" aria-hidden="true" width={16} height={16} style={{ display: "block", width: 16, height: 16 }} />
            {t("bond.converterHeading")}
          </button>
        </div>
      </div>

      {converterOpen && <BitcoinConverter communitySlug={communitySlug} />}

      {/* HERO — sats traded + volume line */}
      <div style={{ ...cardStyle, border: `1px solid ${T.borderHi}` }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
          <span style={kickerStyle}>{t("dash.volumeLabel")}</span>
          <span style={{ fontFamily: T.mono, fontSize: 26, fontWeight: 800, color: T.text }}>
            {volume.totalSats.toLocaleString()}
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.muted }}>sats</span>
          {volume.deltaPct !== null && (
            <span style={{ fontFamily: T.mono, fontSize: 11, fontWeight: 700, color: volume.deltaPct >= 0 ? T.green : T.red }}>
              {volume.deltaPct >= 0 ? "▲" : "▼"} {Math.abs(volume.deltaPct)}% {t("dash.vsPrior")}
            </span>
          )}
        </div>
        {volume.totalSats > 0 ? (
          <VolumeChart buckets={volume.buckets} startSec={volume.start} endSec={nowSec} />
        ) : (
          <div style={{ marginTop: 14, fontSize: 12.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.5 }}>
            {t("dash.noVolumeYet")}
          </div>
        )}
      </div>

      {/* TILES */}
      <div className="dash-tiles" style={{ marginTop: 10 }}>
        <StatTile label={t("bond.dashStatTrades")} value={String(stats.total)} />
        <StatTile label={t("bond.dashStatCompleted")} value={String(stats.completed)} accent={T.green} />
        <StatTile label={t("bond.dashStatLive")} value={String(stats.live)} accent={stats.live > 0 ? T.purple : undefined}
          sub={volume.liveSats > 0 ? t("dash.liveEscrow", { sats: volume.liveSats.toLocaleString() }) : undefined} />
        <StatTile label={t("dash.ratingTile")} value={ratePct !== null ? `${ratePct}%` : "—"}
          sub={ratings && ratings.count > 0 ? t("me.ratingsFromTradesMany", { count: ratings.count }) : t("me.reputationNone")} />
        <StatTile label={t("dash.onDevice")} value={Math.floor(balanceMsats / 1000).toLocaleString()} accent={T.accent} sub="sats" />
      </div>

      {noShowCount > 0 && (
        <div style={{ marginTop: 10, padding: "10px 14px", borderRadius: T.rs, border: `1px solid ${T.amber}44`, background: T.amberDim, fontSize: 11, fontFamily: T.mono, color: T.amber, lineHeight: 1.5 }}>
          {t("bond.dashNoShows", { count: noShowCount })}
        </div>
      )}

      {/* BAND — where you trade · earnings · liveness */}
      <div className="dash-band">
        <div style={cardStyle}>
          <div style={{ ...kickerStyle, marginBottom: 12 }}>{t("dash.whereYouTrade")}</div>
          {verticals.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {verticals.map((v) => (
                <div key={v.key} style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: T.mono, fontSize: 11 }}>
                  <span style={{ width: 82, color: T.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t(v.labelKey)}</span>
                  <div style={{ flex: 1, height: 11, borderRadius: 4, background: T.surface, overflow: "hidden" }}>
                    <div style={{ width: `${v.pct}%`, height: "100%", borderRadius: 4, background: v.color }} />
                  </div>
                  <span style={{ width: 36, textAlign: "right", color: T.text, fontWeight: 700 }}>{v.pct}%</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.5 }}>{t("dash.noVerticalsYet")}</div>
          )}
        </div>

        {(earnings.noteCount > 0 || SHOW_BOND_CEREMONY) ? (
          <div style={cardStyle}>
            <div style={{ ...kickerStyle, marginBottom: 10 }}>{t("bond.dashEarnings")}</div>
            {earnings.noteCount > 0 ? (
              <>
                <BitcoinAmount sats={Math.floor(earnings.totalMsats / 1000)} size={22} gap={6} glyphScale={1.15} color={T.green} glyphColor={T.green} />
                <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginTop: 8 }}>
                  {t("bond.dashEarningsCovered", { count: earnings.tradeCount })}
                </div>
                {balanceMsats >= 1_000 && onWithdrawEcash && (
                  <button
                    type="button"
                    onClick={onWithdrawEcash}
                    style={{ width: "100%", marginTop: 12, padding: "10px 12px", borderRadius: T.rs, background: T.purpleDim, border: `1px solid ${T.purple}66`, color: T.purple, fontFamily: T.mono, fontSize: 10, fontWeight: 800, cursor: "pointer" }}
                  >
                    {t("bond.dashClaimRewardsEcash", { sats: Math.floor(balanceMsats / 1000).toLocaleString() })}
                  </button>
                )}
              </>
            ) : (
              <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.55 }}>
                {t("bond.dashEarningsEmpty")}
              </div>
            )}
          </div>
        ) : (
          <div style={cardStyle}>
            <div style={{ ...kickerStyle, marginBottom: 10 }}>{t("bond.dashStanding")}</div>
            {ratePct !== null ? (
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 28, fontWeight: 900, color: T.green, fontFamily: T.sans, lineHeight: 1 }}>{ratePct}%</span>
                <span style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>{t("bond.dashPositive")}</span>
              </div>
            ) : (
              <div style={{ fontSize: 12.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.55 }}>{t("bond.dashNewHereBody")}</div>
            )}
          </div>
        )}

        {loadLiveness && communitySlug ? (
          <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 16 }}>
            <LivenessRing score={liveness?.score ?? null} loading={livenessLoading}
              healthy={!!liveness && liveness.isLive && liveness.arbiterCount > 1} />
            <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
              <span style={kickerStyle}>{t("dash.livenessKicker")}</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: T.text, fontFamily: T.sans, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {community?.flagEmoji ?? "🌍"} {community?.displayName ?? communitySlug}
              </span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.muted, lineHeight: 1.4 }}>
                {livenessLoading
                  ? t("bond.livenessChecking")
                  : liveness
                    ? `${t(liveness.arbiterCount === 1 ? "bond.arbiterCountOne" : "bond.arbiterCountMany", { count: liveness.arbiterCount })}${liveness.isLive ? ` · ${t("dash.livenessLive")}` : ""}`
                    : livenessOutcome === "timeout" ? t("bond.livenessTimeout") : t("bond.livenessUnknown")}
              </span>
            </div>
          </div>
        ) : (
          <div style={cardStyle}>
            <div style={{ ...kickerStyle, marginBottom: 10 }}>{t("bond.dashStanding")}</div>
            <div style={{ fontSize: 12, color: T.muted, fontFamily: T.mono }}>
              {ratings ? t("bond.dashRatedLine", { positive: ratings.positive, negative: ratings.negative, count: ratings.count }) : "—"}
            </div>
          </div>
        )}
      </div>

      {stats.asArbiter > 0 && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: T.muted, fontFamily: T.mono, textAlign: "center" }}>
          {t("bond.dashArbitratedBefore")}<span style={{ color: T.text, fontWeight: 700 }}>{stats.asArbiter}</span>{t(stats.asArbiter === 1 ? "bond.dashArbitratedAfterOne" : "bond.dashArbitratedAfterMany")}
        </div>
      )}

      {/* BOND — dev-gated; logic byte-identical to v5, restyled shell only. */}
      {SHOW_BOND_CEREMONY && (
        <div style={{ ...cardStyle, marginTop: 10, border: mergedBonds.length > 0 ? `1px solid ${T.accent}55` : `1px solid ${T.border}`, background: mergedBonds.length > 0 ? `${T.accent}14` : T.card }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
            <div style={{ ...kickerStyle, color: mergedBonds.length > 0 ? T.accent : T.muted }}>
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
    </div>
  );
}

/** The Pulse hero line: 12 buckets, area fill, peak label. Pure SVG, no libs. */
function VolumeChart({ buckets, startSec, endSec }: { buckets: number[]; startSec: number; endSec: number }) {
  const W = 1000, H = 170, PAD_TOP = 14, PAD_BOTTOM = 26;
  const max = Math.max(...buckets, 1);
  const plotH = H - PAD_TOP - PAD_BOTTOM;
  const pts = buckets.map((v, i) => ({
    x: (i / (buckets.length - 1)) * W,
    y: PAD_TOP + plotH - (v / max) * plotH,
    v,
  }));
  // ZapStore-smooth: Catmull-Rom through the buckets, rendered as cubic
  // beziers — curvy, never pointy (Jet 2026-09-05).
  const line = smoothPath(pts);
  const area = `${line} L${W} ${H - PAD_BOTTOM} L0 ${H - PAD_BOTTOM} Z`;
  const peak = pts.reduce((a, b) => (b.v > a.v ? b : a), pts[0]!);
  const fmt = (s: number) => new Date(s * 1000).toLocaleString(undefined, { month: "short" }).toUpperCase();
  const midSec = Math.floor((startSec + endSec) / 2);
  const short = (v: number) => v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 1_000 ? `${Math.round(v / 1_000)}k` : String(v);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ display: "block", width: "100%", height: "auto", marginTop: 6 }} role="img" aria-label="volume">
      <g stroke={T.border} strokeWidth="1">
        <line x1="0" y1={PAD_TOP + plotH * 0.33} x2={W} y2={PAD_TOP + plotH * 0.33} />
        <line x1="0" y1={PAD_TOP + plotH * 0.66} x2={W} y2={PAD_TOP + plotH * 0.66} />
      </g>
      <defs>
        <linearGradient id="dashVol" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={T.accent} stopOpacity="0.26" />
          <stop offset="1" stopColor={T.accent} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#dashVol)" />
      <path d={line} fill="none" stroke={T.accent} strokeWidth="2.5" strokeLinejoin="round" />
      <circle cx={peak.x} cy={peak.y} r="4" fill={T.accent} stroke={T.card} strokeWidth="2" />
      <text x={Math.min(peak.x, W - 40)} y={Math.max(peak.y - 8, 11)} fontFamily="JetBrains Mono, monospace" fontSize="11" fontWeight="700" fill={T.text} textAnchor={peak.x > W - 60 ? "end" : "middle"}>
        {short(peak.v)}
      </text>
      <g fontFamily="JetBrains Mono, monospace" fontSize="10" fill={T.muted}>
        <text x="0" y={H - 8}>{fmt(startSec)}</text>
        <text x={W / 2} y={H - 8} textAnchor="middle">{fmt(midSec)}</text>
        <text x={W} y={H - 8} textAnchor="end">{fmt(endSec)}</text>
      </g>
    </svg>
  );
}

/** The approved ring gauge: score 0-100 as an arc, number centered. */
function LivenessRing({ score, loading, healthy }: { score: number | null; loading: boolean; healthy: boolean }) {
  const R = 30, C = 2 * Math.PI * R;
  const pct = score === null ? 0 : Math.max(0, Math.min(100, score));
  const color = score === null ? T.muted : healthy ? T.green : T.amber;
  return (
    <svg width="76" height="76" viewBox="0 0 76 76" role="img" aria-label={score !== null ? `${pct} / 100` : ""} style={{ flexShrink: 0 }}>
      <circle cx="38" cy="38" r={R} fill="none" stroke={T.border} strokeWidth="7" />
      {score !== null && (
        <circle cx="38" cy="38" r={R} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${(pct / 100) * C} ${C}`} transform="rotate(-90 38 38)" />
      )}
      <text x="38" y="43" textAnchor="middle" fontFamily="JetBrains Mono, monospace" fontSize="17" fontWeight="800" fill={T.text}>
        {loading && score === null ? "…" : score !== null ? String(pct) : "—"}
      </text>
    </svg>
  );
}

/** Catmull-Rom → cubic bezier path through the points (open, clamped ends). */
function smoothPath(pts: Array<{ x: number; y: number }>): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0]!.x.toFixed(1)} ${pts[0]!.y.toFixed(1)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return d;
}

function StatTile({ label, value, accent, sub }: { label: string; value: string; accent?: string; sub?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: T.r, padding: "13px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ fontSize: 8.5, color: T.muted, fontFamily: T.mono, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 23, fontWeight: 800, color: accent ?? T.text, fontFamily: T.mono, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 9.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.35 }}>{sub}</div>}
    </div>
  );
}
