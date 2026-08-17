// ══════════════════════════════════════════════════════════════════════════
// Chama — Bond ceremony (single-key TIMELOCK COMMITMENT — the sealed v1 model)
// ══════════════════════════════════════════════════════════════════════════
//
// An arbiter posts a bond by locking THEIR OWN sats to THEIR OWN key until a
// term-end block height T — one Taproot CLTV leaf, no cabinet, no custody, no
// co-sign. Collusion-impossible by construction. The bond is a public, costly
// COMMITMENT signal, not a seizure pool (PHILOSOPHY §2.11, DECISIONS 2026-07-03).
// "Bonded" is how much × how long.
//
// Shape: a small "Your bonds" LIST (an arbiter can hold several — post another,
// watch each, reclaim each), with per-bond detail flows hanging off it:
//   describe (amount + term, min-term enforced) → funding (auto-polled — deposits
//   are DETECTED, not button-mashed) → locked (live countdown) → reclaimed.
//
// Chain-facing rules baked in (not patched on):
//   • the tip is polled once for the whole modal and is MONOTONIC — a
//     load-balanced Esplora jitters up/down, but a timelock only ever passes;
//   • the countdown is informational only — CONSENSUS is the reclaim authority
//     (the hook broadcasts and translates a genuine too-early rejection calmly);
//   • reclaim is a deliberate, confirmed, secondary action — never the reflexive
//     primary (that's Done), so a stray tap can't end a bond.
//
// Gated by SHOW_BOND_CEREMONY — LIVE for all users as of v5.0 (real mainnet bonds).
// Any arbiter can self-bond; there is no cabinet gate.

import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { T } from "../theme.js";
import { useT, translate, getCurrentLang } from "../../i18n/index.js";
import { CopyButton } from "../components/CopyButton.js";
import { listCommitmentBonds, getCommitmentBond, removeCommitmentBond, type CommitmentRecord } from "../../bond-multisig/commitment-store.js";
import {
  MIN_COMMITMENT_TERM_BLOCKS,
  validateBitcoinAddressForNetwork,
  type CommitmentReclaimDestination,
  type ReclaimDestinationChoice,
  type ReclaimDestinationKind,
} from "../../bond-multisig/commitment-bond.js";
import { MAINNET as BOND_NETWORK } from "../../bond-multisig/multisig.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { getAllPickerCountries, type PickerCountry } from "../../communities/countries.js";
import { countryMatchesSearch, countrySubline, resolveCountryCommunitySlug } from "../../communities/country-resolve.js";
import { getUserCommunitySlug } from "../../communities/storage.js";
import type { BondRole } from "../../bond-multisig/bond-announcement.js";

const QRCode = lazy(() => import("../QRCode.js"));

/** Ship gate — LIVE for all users as of v5.0: anyone can post a real mainnet
 *  Bitcoin bond and become an assignable arbiter. Independent of BONDS_ENFORCED. */
export const SHOW_BOND_CEREMONY = true;

const SEED_AMOUNT_SATS = 21_000;
/** Term presets in BLOCKS (what the CLTV leaf commits to). Mainnet mines ~10-min
 *  blocks → ~144/day. The shortest preset IS the enforced minimum — anything shorter
 *  can expire before funding confirms. */
const TERM_PRESETS: { labelKey: string; labelParams?: Record<string, number>; blocks: number }[] = [
  { labelKey: "bond.term1Day", labelParams: { blocks: MIN_COMMITMENT_TERM_BLOCKS }, blocks: MIN_COMMITMENT_TERM_BLOCKS },
  { labelKey: "bond.term1Week", blocks: 1008 },
  { labelKey: "bond.term1Month", blocks: 4320 },
  { labelKey: "bond.term3Months", blocks: 12960 },
];
/** Warn on the funding screen when fewer than this many blocks remain. */
const NEAR_END_BLOCKS = 10;
const TIP_POLL_MS = 15_000;
const FUNDING_POLL_MS = 10_000;
const CREDIT_POLL_MS = 8_000;
// A "planned" (created-but-unfunded) bond is just a generated address the user
// never sent sats to. Auto-clear it after this window so drafts don't linger —
// but ONLY after a fresh on-chain check confirms it's unfunded (a funded draft
// promotes to LOCKED instead of being removed; funds are never hidden).
const PLANNED_BOND_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export interface BondCeremonyModalProps {
  createCommitmentBond: (p: { amountSats: bigint; termBlocks: number }) =>
    Promise<{ bondId: string; address: string; lockUntil: number; amountSats: bigint; tipAtCreate: number }>;
  checkCommitmentFunding: (bondId: string) => Promise<{ locked: boolean; txid?: string; lockedSats?: bigint; deposits?: number }>;
  getCommitmentReclaimQuote: (bondId: string) => Promise<{ finalityDelay: number; minimumDepositSats: number; pegInFeeSats: number; minerFeeSats: bigint; estimatedNetSats: bigint } | null>;
  renewCommitmentBond: (bondId: string, termBlocks: number) => Promise<{ bondId: string; txid: string; amountSats: bigint; feeSats: bigint; lockUntil: number; pending: boolean }>;
  /** Rebuild this device's bond records from the user's own on-chain announcements + seed. */
  recoverMyBonds: () => Promise<{ recovered: number }>;
  reclaimCommitmentBond: (bondId: string, destination?: ReclaimDestinationChoice) => Promise<{
    txid: string;
    alreadyReclaimed?: boolean;
    creditedToChama?: boolean;
    creditOperationId?: string;
    returnAddress?: string;
    destinationAddress?: string;
    reclaimDestination?: CommitmentReclaimDestination;
  }>;
  creditReclaimedCommitmentBond: (bondId: string) => Promise<{ txid: string; operationId?: string; amountSats?: bigint; alreadyCredited?: boolean }>;
  getBondChainTip: () => Promise<number>;
  /** Publish the chain-verifiable kind:38135 bond announcement FOR a community —
   *  the data source for that community's live-chama liveness. Optional so the
   *  ceremony still renders where a caller hasn't wired it. */
  publishBondAnnouncement?: (bondId: string, community: string, roles?: readonly BondRole[]) => Promise<{ community: string; address: string }>;
  onClose: () => void;
}

type View =
  | { kind: "list" }
  | { kind: "describe" }
  | { kind: "working"; label: string }
  | { kind: "funding"; bondId: string }
  | { kind: "locked"; bondId: string; foundNote?: string }
  | {
      kind: "reclaimed";
      bondId: string;
      txid: string;
      creditedToChama?: boolean;
      creditTxid?: string;
      returnAddress?: string;
      reclaimDestination?: CommitmentReclaimDestination;
    }
  | { kind: "error"; message: string };

export function BondCeremonyModal({ createCommitmentBond, checkCommitmentFunding, getCommitmentReclaimQuote, renewCommitmentBond, recoverMyBonds, reclaimCommitmentBond, creditReclaimedCommitmentBond, getBondChainTip, publishBondAnnouncement, onClose }: BondCeremonyModalProps) {
  const { t } = useT();
  // Open on the list when any bond exists; straight to describe on a first run.
  const [view, setView] = useState<View>(() => (listCommitmentBonds().length > 0 ? { kind: "list" } : { kind: "describe" }));
  const [amountStr, setAmountStr] = useState(String(SEED_AMOUNT_SATS));
  const [termBlocks, setTermBlocks] = useState(TERM_PRESETS[0].blocks);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [tip, setTip] = useState<number | null>(null);
  const [confirmReclaim, setConfirmReclaim] = useState(false);
  const [reclaimChoice, setReclaimChoice] = useState<ReclaimDestinationKind>("chama");
  const [externalReclaimAddress, setExternalReclaimAddress] = useState("");
  const [reclaimQuote, setReclaimQuote] = useState<{ finalityDelay: number; minimumDepositSats: number; pegInFeeSats: number; minerFeeSats: bigint; estimatedNetSats: bigint } | null>(null);
  // Announce-to-community state (locked screen). Default to the user's own community.
  const [announceSlug, setAnnounceSlug] = useState<string>(() => getUserCommunitySlug());
  const [announcing, setAnnouncing] = useState(false);
  const [announcedTo, setAnnouncedTo] = useState<string | null>(null);
  const [announceErr, setAnnounceErr] = useState<string | null>(null);
  // Bump to re-read the store after a check/reclaim mutates it.
  const [storeRev, setStoreRev] = useState(0);

  // Pin the action props in refs so the poll effects' identities never change
  // (else the intervals are torn down every render and never fire).
  const tipFnRef = useRef(getBondChainTip);
  tipFnRef.current = getBondChainTip;
  const checkFnRef = useRef(checkCommitmentFunding);
  checkFnRef.current = checkCommitmentFunding;
  // Bonds already auto-announced this session (so opening a locked bond from the
  // list doesn't re-fire — only a fresh on-chain lock detection does).
  const autoAnnouncedRef = useRef<Set<string>>(new Set());

  // ── Cross-device recovery: pull my own on-chain bonds into THIS device ────────
  // A bond posted on another device (same npub) has no local record here; rebuild it
  // from my kind-38135 announcement + seed so it shows + reclaims on every device.
  // Once per open, fail-soft (a fetch hiccup just leaves the local list as-is).
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (recoveredRef.current) return;
    recoveredRef.current = true;
    void recoverMyBonds()
      .then((r) => {
        if (r.recovered > 0) {
          setStoreRev((n) => n + 1);
          setView((v) => (v.kind === "describe" && listCommitmentBonds().length > 0 ? { kind: "list" } : v));
        }
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Auto-clear abandoned draft bonds (created-but-unfunded past the TTL) ──────
  // Fund-safe: each stale draft gets a fresh on-chain check first; a funded one
  // promotes to LOCKED (checkCommitmentFunding), only a confirmed-unfunded draft
  // is removed. Runs once per open, fail-soft.
  const cleanedDraftsRef = useRef(false);
  useEffect(() => {
    if (cleanedDraftsRef.current) return;
    cleanedDraftsRef.current = true;
    const stale = listCommitmentBonds().filter(
      (b) => b.phase === "created" && !b.renewedFromBondId && Date.now() - b.createdAt > PLANNED_BOND_TTL_MS,
    );
    if (stale.length === 0) return;
    void (async () => {
      let changed = false;
      for (const b of stale) {
        try { await checkFnRef.current(b.bondId); } catch { /* chain hiccup — keep the draft */ continue; }
        if (getCommitmentBond(b.bondId)?.phase === "created") { removeCommitmentBond(b.bondId); changed = true; }
      }
      if (changed) setStoreRev((n) => n + 1);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── ONE monotonic chain tip for the whole modal ──────────────────────────────
  // A load-balanced Esplora is served across nodes at slightly different
  // heights, so raw polls jitter up/down; a timelock only ever passes, so never
  // let a lower reading re-lock a ready bond. Informational only — consensus is
  // the reclaim authority.
  useEffect(() => {
    let cancelled = false;
    const pull = () => { tipFnRef.current().then((t) => { if (!cancelled && Number.isFinite(t)) setTip((prev) => (prev == null ? t : Math.max(prev, t))); }).catch(() => {}); };
    pull();
    const id = setInterval(pull, TIP_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Funding auto-poll: deposits are DETECTED, not button-mashed ──────────────
  const fundingBondId = view.kind === "funding" ? view.bondId : null;
  useEffect(() => {
    if (!fundingBondId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const r = await checkFnRef.current(fundingBondId);
        if (cancelled) return;
        setStoreRev((n) => n + 1);
        if (r.locked) {
          const n = r.deposits ?? 1;
          setNote(null);
          autoAnnounceOnLock(fundingBondId);
          setView({ kind: "locked", bondId: fundingBondId, foundNote: t(n === 1 ? "bond.foundDepositOne" : "bond.foundDepositMany", { count: n, sats: (r.lockedSats ?? 0n).toString() }) });
        }
      } catch { /* transient — keep watching */ }
    };
    void poll();
    const id = setInterval(() => void poll(), FUNDING_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [fundingBondId]);

  // ── Credit-landed poll: while a reclaimed bond's peg-in is confirming, re-read
  // the store so the "on their way" screen flips to "landed" the moment the
  // watcher (in useEscrow) stamps creditConfirmedAt. Stops once confirmed. ─────
  const creditPendingBondId =
    view.kind === "reclaimed" && view.creditedToChama ? view.bondId : null;
  useEffect(() => {
    if (!creditPendingBondId) return;
    if (listCommitmentBonds().find((b) => b.bondId === creditPendingBondId)?.creditConfirmedAt) return;
    const id = setInterval(() => setStoreRev((n) => n + 1), CREDIT_POLL_MS);
    return () => clearInterval(id);
  }, [creditPendingBondId]);

  const bonds = (() => { void storeRev; return listCommitmentBonds(); })();
  const resetReclaimForm = () => {
    setConfirmReclaim(false);
    setReclaimChoice("chama");
    setExternalReclaimAddress("");
    setReclaimQuote(null);
  };
  const backToList = () => { setNote(null); resetReclaimForm(); setAnnouncedTo(null); setAnnounceErr(null); setStoreRev((n) => n + 1); setView({ kind: "list" }); };

  const amountSats = (() => { const n = Math.floor(Number(amountStr)); return Number.isFinite(n) && n > 0 ? BigInt(n) : 0n; })();

  const post = async () => {
    if (amountSats <= 0n) { setView({ kind: "error", message: t("bond.enterAmount") }); return; }
    setView({ kind: "working", label: t("bond.building") });
    try {
      const r = await createCommitmentBond({ amountSats, termBlocks });
      setStoreRev((n) => n + 1);
      setView({ kind: "funding", bondId: r.bondId });
    } catch (e: any) {
      setView({ kind: "error", message: e?.message || t("bond.buildFailed") });
    }
  };

  const checkNow = async (bondId: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await checkFnRef.current(bondId);
      setStoreRev((n) => n + 1);
      if (r.locked) {
        const n = r.deposits ?? 1;
        autoAnnounceOnLock(bondId);
        setView({ kind: "locked", bondId, foundNote: t(n === 1 ? "bond.foundDepositOne" : "bond.foundDepositMany", { count: n, sats: (r.lockedSats ?? 0n).toString() }) });
      } else setNote(t("bond.nothingConfirmed"));
    } catch (e: any) { setNote(e?.message || t("bond.chainUnreachable")); }
    finally { setBusy(false); }
  };

  // Discard an unfunded draft. Safe: a draft has no on-chain state until sats
  // are sent; if the user later funds this address, cross-device recovery /
  // re-derivation resurfaces it (funds are never lost, only this UI row).
  const discardDraft = (bondId: string) => {
    const rec = getCommitmentBond(bondId);
    if (!rec || rec.phase !== "created") return; // never discard a funded/locked bond
    removeCommitmentBond(bondId);
    setStoreRev((n) => n + 1);
    setView(listCommitmentBonds().length > 0 ? { kind: "list" } : { kind: "describe" });
  };

  const reclaim = async (bondId: string, destination: ReclaimDestinationChoice) => {
    setBusy(true); setNote(null);
    try {
      const r = await reclaimCommitmentBond(bondId, destination);
      setStoreRev((n) => n + 1);
      const rec = getCommitmentBond(bondId);
      const reclaimDestination = r.reclaimDestination ?? rec?.reclaimDestination;
      setView({
        kind: "reclaimed",
        bondId,
        txid: r.txid,
        creditedToChama: r.creditedToChama || !!rec?.creditTxid,
        creditTxid: rec?.creditTxid,
        returnAddress: r.returnAddress ?? (reclaimDestination?.actual === "bond-key" ? reclaimDestination.address : undefined),
        reclaimDestination,
      });
    } catch (e: any) { setNote(e?.message || t("bond.reclaimFailed")); }
    finally { setBusy(false); }
  };

  const renew = async (bondId: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await renewCommitmentBond(bondId, termBlocks);
      setStoreRev((n) => n + 1);
      setView({ kind: "funding", bondId: r.bondId });
      setNote(t("bond.renewBroadcast", { sats: r.amountSats.toString(), fee: r.feeSats.toString() }));
    } catch (e: any) { setNote(e?.message || t("bond.renewFailed")); }
    finally { setBusy(false); }
  };

  const creditToChama = async (bondId: string) => {
    setBusy(true); setNote(null);
    try {
      const r = await creditReclaimedCommitmentBond(bondId);
      setStoreRev((n) => n + 1);
      setNote(t("bond.creditSubmitted"));
      setView((prev) => prev.kind === "reclaimed"
        ? { ...prev, creditedToChama: true, creditTxid: r.txid }
        : prev);
    } catch (e: any) { setNote(e?.message || t("bond.creditFailed")); }
    finally { setBusy(false); }
  };

  // Fire the liveness announcement the instant a bond locks — a funded bond IS
  // the signal, so it publishes to the arbiter's HOME community automatically,
  // no button press. Once per bond; the manual picker below stays for
  // re-announcing or announcing to ANOTHER community. Fails soft (retry re-arms).
  const autoAnnounceOnLock = (bondId: string) => {
    if (!publishBondAnnouncement || autoAnnouncedRef.current.has(bondId)) return;
    // Never auto-publish a DEAD signal: once a bond's term ends it reads
    // active=false on-chain, so it wouldn't count toward liveness anyway.
    const recForBond = getCommitmentBond(bondId);
    if (recForBond && tip != null && tip >= recForBond.bond.lockUntil) return;
    autoAnnouncedRef.current.add(bondId);
    const slug = getUserCommunitySlug();
    // Auto-announce carries no role, so it defaults to arbiter — the historical
    // behaviour. A merchant declares themselves deliberately in the panel below
    // and re-announces; nobody is opted out of the pool by an automatic event.
    void publishBondAnnouncement(bondId, slug)
      .then(() => { setAnnounceSlug(slug); setAnnouncedTo(getCommunityBySlug(slug)?.displayName ?? slug); })
      .catch(() => { autoAnnouncedRef.current.delete(bondId); });
  };

  const announce = async (bondId: string, slug: string) => {
    if (!publishBondAnnouncement) return;
    setAnnouncing(true); setAnnounceErr(null); setAnnouncedTo(null);
    try {
      const r = await publishBondAnnouncement(bondId, slug, merchantOnly ? ["merchant"] : ["arbiter"]);
      setAnnouncedTo(getCommunityBySlug(r.community)?.displayName ?? r.community);
    } catch (e: any) {
      setAnnounceErr(e?.message || t("bond.announceFailed"));
    } finally { setAnnouncing(false); }
  };

  // A2 merchant lane: a shopkeeper who wants painless listing renewal should
  // not be conscripted as a judge. Declaring `merchant` keeps the bond out of
  // the assignable arbiter pool. Default OFF — arbiter is what every bond has
  // always been, and opting out has to be a deliberate, signed statement.
  const [merchantOnly, setMerchantOnly] = useState(false);

  const closeable = view.kind !== "working";

  // Only treat a backdrop click as "dismiss" when the press STARTED on the
  // backdrop. Otherwise a drag-select inside an input that happens to end on
  // the backdrop (mousedown in field → mouseup outside) fires a click on the
  // backdrop and wrongly closes the modal (the sneaky amount-select glitch).
  const backdropPressRef = useRef(false);

  return (
    <div style={{ position: "fixed", inset: 0, background: "#000c", zIndex: 9998, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}
      onMouseDown={(e) => { backdropPressRef.current = e.target === e.currentTarget; }}
      onClick={(e) => { if (backdropPressRef.current && e.target === e.currentTarget && closeable) onClose(); backdropPressRef.current = false; }}>
      <div style={{ background: T.card, border: `1px solid ${T.borderHi}`, borderRadius: T.r, width: "100%", maxWidth: 380, maxHeight: "90vh", overflow: "auto", padding: 20 }}>
        <Header onClose={onClose} closeable={closeable} />

        {view.kind === "list" && (
          <BondList
            bonds={bonds}
            tip={tip}
            onOpen={(rec) => {
              setNote(null); resetReclaimForm();
              if (rec.phase === "created") setView({ kind: "funding", bondId: rec.bondId });
              else if (rec.phase === "locked") setView({ kind: "locked", bondId: rec.bondId });
              else if (rec.reclaimTxid) setView({
                kind: "reclaimed",
                bondId: rec.bondId,
                txid: rec.reclaimTxid,
                creditedToChama: !!rec.creditTxid,
                creditTxid: rec.creditTxid,
                returnAddress: rec.reclaimDestination?.actual === "bond-key" ? rec.reclaimDestination.address : undefined,
                reclaimDestination: rec.reclaimDestination,
              });
            }}
            onPostNew={() => { setNote(null); resetReclaimForm(); setView({ kind: "describe" }); }}
          />
        )}

        {view.kind === "describe" && (
          <>
            {bonds.length > 0 && <BackToBonds onClick={backToList} />}
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 16, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "12px 14px" }}>
              {t("bond.introPart1")}<b>{t("bond.introBoldOwnSats")}</b>{t("bond.introPart2")}<b>{t("bond.introBoldOwnKey")}</b>{t("bond.introPart3")}<b>{t("bond.introBoldNoPull")}</b>{t("bond.introPart4")}<b style={{ color: T.accent }}>{t("bond.introBoldHowMuch")}</b>{t("bond.introPart5")}
            </div>
            {/* Accountability #4 — name the tradeoff before a critic does.
                PHILOSOPHY 2.11: the bond is a costly public signal, NOT a
                seizure pool. Saying so here is what makes the honest version
                credible; leaving it unsaid is what makes it look like a flaw. */}
            <div style={{
              fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6,
              background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: T.rs, padding: "10px 12px", marginBottom: 14,
            }}>
              {t("bond.introHonestTradeoff")}
            </div>
            <label style={labelStyle}>{t("bond.amountLabel")}</label>
            <input value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric"
              style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 15, padding: "10px 12px", marginBottom: 12 }} />
            <label style={labelStyle}>{t("bond.termLabel")}</label>
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {TERM_PRESETS.map((p) => (
                <button key={p.blocks} onClick={() => setTermBlocks(p.blocks)}
                  style={{ ...secondaryBtn, marginBottom: 0, textAlign: "left", border: `1px solid ${termBlocks === p.blocks ? T.accent : T.border}`, color: termBlocks === p.blocks ? T.text : T.muted }}>
                  {termBlocks === p.blocks ? "◉ " : "○ "}{t(p.labelKey, p.labelParams)}
                </button>
              ))}
            </div>
            <button onClick={post} disabled={amountSats <= 0n} style={primaryBtn(amountSats > 0n)}>{t("bond.postMyBond")}</button>
          </>
        )}

        {view.kind === "working" && (
          <div style={{ padding: "28px 0", textAlign: "center" }}>
            <div style={{ fontSize: 26, marginBottom: 12 }}>⚙️</div>
            <div style={{ fontSize: 13, color: T.text, fontFamily: T.mono }}>{view.label}</div>
            <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 6 }}>{t("bond.noSatsMove")}</div>
          </div>
        )}

        {view.kind === "funding" && (() => {
          const rec = getCommitmentBond(view.bondId);
          if (!rec) return <MissingBond onBack={backToList} />;
          const isRenewal = !!rec.renewedFromBondId;
          const toGo = tip != null ? rec.bond.lockUntil - tip : null;
          return (
            <div>
              <BackToBonds onClick={backToList} />
              <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono, marginBottom: 4 }}>{t(isRenewal ? "bond.renewConfirmingTitle" : "bond.fundHeading")}</div>
              <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 12, lineHeight: 1.5 }}>
                {isRenewal ? t("bond.renewConfirmingBody", { source: (rec.amountSats + (rec.renewalFeeSats ?? 0n)).toString(), sats: rec.amountSats.toString(), block: rec.bond.lockUntil, fee: (rec.renewalFeeSats ?? 0n).toString() }) : <>{t("bond.fundSendBefore")}<b style={{ color: T.text }}>{t("bond.fundSendAtLeast", { sats: rec.amountSats.toString() })}</b>{t("bond.fundSendMiddle")}<b style={{ color: T.text }}>{rec.bond.lockUntil}</b>{t("bond.fundSendAfter")}</>}
              </div>
              {toGo != null && toGo > 0 && (
                <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, marginBottom: 12, lineHeight: 1.55, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "9px 11px" }}>
                  {t("bond.fundLocksFor", { time: humanTime(toGo) })}
                </div>
              )}
              {toGo != null && toGo <= 0 && (
                <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginBottom: 10, lineHeight: 1.5, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px" }}>
                  {t("bond.warnEndedBefore")}<b>{t("bond.warnEndedBold")}</b>{t("bond.warnEndedAfter")}
                </div>
              )}
              {toGo != null && toGo > 0 && toGo <= NEAR_END_BLOCKS && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginBottom: 10, lineHeight: 1.5 }}>
                  {t(toGo === 1 ? "bond.nearEndOne" : "bond.nearEndMany", { blocks: toGo, time: humanTime(toGo) })}
                </div>
              )}
              {!isRenewal && <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
                <Suspense fallback={<div style={{ width: 180, height: 180, background: T.surface, borderRadius: T.rs }} />}>
                  <QRCode data={rec.bond.address} size={180} />
                </Suspense>
              </div>}
              {!isRenewal && <><div style={{ fontSize: 10.5, color: T.text, fontFamily: T.mono, wordBreak: "break-all", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 8 }}>{rec.bond.address}</div><CopyButton value={rec.bond.address} label={t("bond.copyAddress")} style={secondaryBtn} /></>}
              {isRenewal && rec.renewalTxid && (
                <CopyableValue heading={t("bond.renewalTxid")} label={t("bond.copyTxid")} value={rec.renewalTxid} />
              )}
              <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, textAlign: "center", marginTop: 4, lineHeight: 1.5 }}>
                {t("bond.watchingChain", { secs: FUNDING_POLL_MS / 1000 })}
              </div>
              <button onClick={() => void checkNow(view.bondId)} disabled={busy} style={{ ...secondaryBtn, marginTop: 8 }}>
                {busy ? t("bond.checking") : t("bond.checkNow")}
              </button>
              {!isRenewal && <button onClick={() => discardDraft(view.bondId)} disabled={busy}
                style={{ ...secondaryBtn, color: T.muted, borderColor: T.border, marginTop: 2 }}>
                {t("bond.discardDraft")}
              </button>}
              {note && <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5, textAlign: "center" }}>{note}</div>}
            </div>
          );
        })()}

        {view.kind === "locked" && (() => {
          const rec = getCommitmentBond(view.bondId);
          if (!rec) return <MissingBond onBack={backToList} />;
          const deposits = rec.utxos ?? [];
          const notYet = tip != null && tip < rec.bond.lockUntil;
          const expired = tip != null && !notYet; // term ended — the signal is dead until renewed
          const toGo = tip != null ? Math.max(0, rec.bond.lockUntil - tip) : null;
          return (
            <div style={{ padding: "2px 0", textAlign: "center" }}>
              <BackToBonds onClick={backToList} />
              <div style={{ fontSize: 30, marginBottom: 10 }}>{expired ? "⏳" : "🔒"}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: expired ? T.accent : T.green, fontFamily: T.mono, marginBottom: 8 }}>{expired ? t("bond.termEndedTitle") : t("bond.lockedTitle")}</div>
              {view.foundNote && <div style={{ fontSize: 10.5, color: T.green, fontFamily: T.mono, marginBottom: 8 }}>{view.foundNote}</div>}
              <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
                <b>{t("bond.satsAmount", { sats: rec.amountSats.toString() })}</b>{t("bond.lockedCommitted")}{deposits.length > 1 ? <>{t("bond.lockedAcrossBefore")}<b>{t("bond.lockedAcrossDeposits", { count: deposits.length })}</b></> : null}{t("bond.lockedUntilBefore")}<b>{rec.bond.lockUntil}</b>{t("bond.lockedUntilAfter")}
              </div>
              {!expired && <ArbiterDuties />}
              {deposits.length > 0 && (
                <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 12 }}>
                  <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 }}>{t(deposits.length === 1 ? "bond.depositsAtAddressOne" : "bond.depositsAtAddressMany", { count: deposits.length })}</div>
                  {deposits.map((d) => (
                    <div key={`${d.txid}:${d.index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: T.text, fontFamily: T.mono, marginBottom: 3 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.txid.slice(0, 10)}…{d.txid.slice(-6)}:{d.index}</span>
                      <span style={{ flexShrink: 0, color: T.muted }}>{d.amountSats.toString()}</span>
                    </div>
                  ))}
                  <button onClick={() => void checkNow(view.bondId)} disabled={busy}
                    style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 9.5, cursor: "pointer", padding: "4px 0 0", textDecoration: "underline" }}>
                    {busy ? t("bond.checkingLower") : t("bond.checkForMore")}
                  </button>
                </div>
              )}
              {/* Informational countdown only (monotonic tip). Reclaim is a DELIBERATE
                  two-step action, never the reflexive primary button (which is Done),
                  so a stray tap after locking can't return the bond. Consensus is the
                  real gate: an early reclaim is rejected and surfaced as "almost". */}
              {notYet && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, marginBottom: 8, lineHeight: 1.5, textAlign: "center" }}>
                  {t(toGo === 1 ? "bond.unlocksAtOne" : "bond.unlocksAtMany", { block: rec.bond.lockUntil, blocks: toGo!, time: humanTime(toGo!) })}
                </div>
              )}
              {!notYet && tip != null && (
                <div style={{ fontSize: 10.5, color: T.accent, fontFamily: T.mono, marginBottom: 8, lineHeight: 1.5, textAlign: "center" }}>
                  {t("bond.termUpReclaim")}
                </div>
              )}
              {/* Announce this bond to a community — publishes the chain-verifiable
                  kind:38135 event so the community's live-chama score can count it.
                  A commitment made in public is the whole point of the signal. */}
              {publishBondAnnouncement && !confirmReclaim && !expired && (
                <AnnounceBond
                  slug={announceSlug} onSlug={setAnnounceSlug}
                  announcing={announcing} announcedTo={announcedTo} error={announceErr}
                  merchantOnly={merchantOnly} onMerchantOnly={setMerchantOnly}
                  onAnnounce={() => void announce(view.bondId, announceSlug)}
                />
              )}
              {confirmReclaim ? (
                <ReclaimDestinationPicker
                  choice={reclaimChoice}
                  onChoice={setReclaimChoice}
                  externalAddress={externalReclaimAddress}
                  onExternalAddress={setExternalReclaimAddress}
                  busy={busy}
                  quote={reclaimQuote}
                  onSubmit={(destination) => { resetReclaimForm(); void reclaim(view.bondId, destination); }}
                  onCancel={resetReclaimForm}
                />
              ) : expired ? (
                <>
                  <div style={{ textAlign: "left", margin: "0 0 10px" }}>
                    <label style={labelStyle}>{t("bond.renewTermLabel")}</label>
                    <div style={{ display: "grid", gap: 6 }}>
                      {TERM_PRESETS.map((p) => (
                        <button key={p.blocks} onClick={() => setTermBlocks(p.blocks)} disabled={busy}
                          style={{ ...secondaryBtn, marginBottom: 0, textAlign: "left", border: `1px solid ${termBlocks === p.blocks ? T.accent : T.border}`, color: termBlocks === p.blocks ? T.text : T.muted }}>
                          {termBlocks === p.blocks ? "◉ " : "○ "}{t(p.labelKey, p.labelParams)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <button onClick={() => void renew(view.bondId)} disabled={busy} style={primaryBtn(!busy)}>
                    {busy ? t("bond.renewing") : t("bond.renewBond")}
                  </button>
                  <button onClick={() => { setNote(null); setConfirmReclaim(true); void getCommitmentReclaimQuote(view.bondId).then(setReclaimQuote).catch(() => setReclaimQuote(null)); }}
                    style={{ ...secondaryBtn, marginTop: 6 }}>
                    {t("bond.reclaimMyBond")}
                  </button>
                  <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>{t("bond.notNow")}</button>
                </>
              ) : (
                <>
                  <button onClick={onClose} style={primaryBtn(true)}>{t("common.done")}</button>
                  <button onClick={() => { setNote(null); setConfirmReclaim(true); void getCommitmentReclaimQuote(view.bondId).then(setReclaimQuote).catch(() => setReclaimQuote(null)); }} style={{ ...secondaryBtn, marginTop: 6 }}>{t("bond.reclaimMyBond")}</button>
                </>
              )}
              {note && <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
            </div>
          );
        })()}

        {view.kind === "reclaimed" && (() => {
          const actual = view.reclaimDestination?.actual;
          const destinationAddress = view.reclaimDestination?.actual !== "bond-key" ? view.reclaimDestination?.address : undefined;
          const returnAddress = view.returnAddress ?? (actual === "bond-key" ? view.reclaimDestination?.address : undefined);
          // Live record catches the peg-in confirmation the watcher stamps (durable
          // across reloads) so the screen flips from "on their way" → "landed".
          const liveRec = bonds.find((b) => b.bondId === view.bondId);
          const creditConfirmed = !!liveRec?.creditConfirmedAt;
          const creditSubmitted = view.creditedToChama && !creditConfirmed;
          const canCredit = !view.creditedToChama && (!actual || actual === "bond-key");
          const bodyKey = creditConfirmed
            ? "bond.creditLandedBody"
            : view.creditedToChama
              ? "bond.reclaimedToChamaBody"
              : actual === "external"
                ? "bond.reclaimedExternalBody"
                : "bond.reclaimedSelfCustodyBody";
          const emoji = canCredit ? "🔓" : creditSubmitted ? "⏳" : "🎉";
          const titleColor = canCredit ? T.accent : creditSubmitted ? T.amber : T.green;
          return (
            <div style={{ padding: "6px 0", textAlign: "center" }}>
              <BackToBonds onClick={backToList} />
              <div style={{ fontSize: 30, marginBottom: 10 }}>{emoji}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: titleColor, fontFamily: T.mono, marginBottom: 8 }}>{t(creditConfirmed ? "bond.creditLandedTitle" : "bond.bondReclaimed")}</div>
              <div style={{ fontSize: 11, color: T.text, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
                {t(bodyKey)}
              </div>
              <CopyableValue label={t("bond.copyTxid")} value={view.txid} />
              {destinationAddress && (
                <CopyableValue
                  heading={t(actual === "chama" ? "bond.chamaDepositAddress" : "bond.destinationAddress")}
                  label={t("bond.copyAddress")}
                  value={destinationAddress}
                />
              )}
              {view.reclaimDestination?.fallbackReason && (
                <div style={{ fontSize: 10.5, color: T.amber, fontFamily: T.mono, lineHeight: 1.5, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 8, textAlign: "left" }}>
                  <b>{t("bond.reclaimFallbackNotice")}</b> {view.reclaimDestination.fallbackReason}
                </div>
              )}
              {returnAddress && !view.creditedToChama && (
                <CopyableValue heading={t("bond.returnAddress")} label={t("bond.copyReturnAddress")} value={returnAddress} />
              )}
              {view.creditTxid && (
                <CopyableValue heading={t("bond.creditTxid")} label={t("bond.copyTxid")} value={view.creditTxid} />
              )}
              {canCredit && (
                <button onClick={() => void creditToChama(view.bondId)} disabled={busy} style={primaryBtn(!busy)}>{busy ? t("bond.creditingToChama") : t("bond.creditToChama")}</button>
              )}
              <button onClick={() => setView({ kind: "describe" })} style={view.creditedToChama ? primaryBtn(true) : { ...secondaryBtn, marginTop: 6 }}>{t("bond.postFreshBond")}</button>
              <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>{t("common.done")}</button>
              {note && <div style={{ fontSize: 10.5, color: view.creditedToChama ? T.green : T.red, fontFamily: T.mono, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
            </div>
          );
        })()}

        {view.kind === "error" && (
          <div style={{ padding: "8px 0" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.mono, marginBottom: 8 }}>{t("bond.somethingWrong")}</div>
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 16 }}>{view.message}</div>
            <button onClick={() => setView({ kind: "describe" })} style={primaryBtn(true)}>{t("common.back")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The "Your bonds" list — post another · watch each · reclaim each ─────────
function BondList({ bonds, tip, onOpen, onPostNew }: {
  bonds: CommitmentRecord[];
  tip: number | null;
  onOpen: (rec: CommitmentRecord) => void;
  onPostNew: () => void;
}) {
  const { t } = useT();
  const [showPast, setShowPast] = useState(false);
  // A renewal SPENDS the old bond's UTXO into the new one, but the predecessor
  // record stays `locked` with a past lockUntil forever — so without this it
  // kept being offered for renewal, pointing at an outpoint that no longer
  // exists. Any bond some successor was renewed FROM is spent, full stop.
  const renewedFromIds = new Set(
    bonds.map((b) => b.renewedFromBondId).filter((id): id is string => !!id),
  );
  const expired = tip == null
    ? undefined
    : bonds.find((b) =>
        b.phase === "locked" &&
        tip >= b.bond.lockUntil &&
        !renewedFromIds.has(b.bondId));
  const current = bonds.filter((b) => b.phase === "created" || (b.phase === "locked" && (tip == null || tip < b.bond.lockUntil)));
  const past = bonds.filter((b) => b.phase === "reclaimed" || (b.phase === "locked" && tip != null && tip >= b.bond.lockUntil));
  return (
    <div>
      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono, marginBottom: 10 }}>{t("bond.currentBond")}</div>
      {current.length === 0 && (
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
          {t("bond.noLiveBond")}
        </div>
      )}
      {current.map((b) => <BondRow key={b.bondId} rec={b} tip={tip} onOpen={onOpen} />)}
      {/* Renewing a stale bond is only "recommended" when you have no live one.
          With a bond already standing it is a legitimate but secondary action
          (revive old capital), so it drops out of the primary slot. */}
      {expired && (
        <button
          onClick={() => onOpen(expired)}
          style={{
            ...(current.length > 0 ? secondaryBtn : primaryBtn(true)),
            marginTop: 6,
          }}
        >
          {t(current.length > 0 ? "bond.renewExpiredOptional" : "bond.renewPreferred")}
        </button>
      )}
      <button onClick={onPostNew} style={{ ...secondaryBtn, marginTop: 6 }}>{t(expired ? "bond.postAdditionalBond" : "bond.postNewBond")}</button>
      {past.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button type="button" onClick={() => setShowPast((v) => !v)}
            style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "transparent", border: 0, color: T.muted, fontFamily: T.mono, fontSize: 9, letterSpacing: 1, padding: "6px 0", cursor: "pointer" }}>
            <span>{t("bond.pastBondsCount", { count: past.length })}</span><span>{showPast ? "▴" : "▾"}</span>
          </button>
          {showPast && past.map((b) => <BondRow key={b.bondId} rec={b} tip={tip} onOpen={onOpen} />)}
        </div>
      )}
    </div>
  );
}

function BondRow({ rec, tip, onOpen }: { rec: CommitmentRecord; tip: number | null; onOpen: (rec: CommitmentRecord) => void }) {
  const { t } = useT();
  const toGo = tip != null ? rec.bond.lockUntil - tip : null;
  const status = (() => {
    if (rec.phase === "created" && rec.renewedFromBondId) return {
      chip: t("bond.chipConfirming"), color: T.amber,
      line: rec.renewalTxid ? t("bond.rowLineRenewalTx", { txid: `${rec.renewalTxid.slice(0, 10)}…` }) : t("bond.rowLineRenewalPrepared"),
    };
    if (rec.phase === "created") return { chip: t("bond.chipAwaitingFunding"), color: T.amber, line: t("bond.rowLineActivate") };
    const actual = rec.reclaimDestination?.actual;
    const requested = rec.reclaimDestination?.requested;
    if (rec.phase === "reclaimed") return {
      chip: t("bond.chipReclaimed"),
      color: rec.creditTxid || actual === "chama" ? T.green : T.muted,
      line: rec.creditTxid
        ? t("bond.rowLineCreditedTx", { txid: rec.creditTxid.slice(0, 10) })
        : rec.reclaimTxid && actual === "external" ? t("bond.rowLineExternalTx", { txid: rec.reclaimTxid.slice(0, 10) })
        : rec.reclaimTxid && actual === "chama" ? t("bond.rowLineChamaTx", { txid: rec.reclaimTxid.slice(0, 10) })
        : rec.reclaimTxid && requested === "chama" && actual === "bond-key" ? t("bond.rowLineWaitingCreditTx", { txid: rec.reclaimTxid.slice(0, 10) })
        : rec.reclaimTxid ? t("bond.rowLineSweptTx", { txid: rec.reclaimTxid.slice(0, 10) }) : t("bond.rowLineSwept"),
    };
    if (toGo != null && toGo <= 0) return { chip: t("bond.chipTermEnded"), color: T.accent, line: t("bond.rowLineReclaimable") };
    if (toGo != null && toGo <= 4_320) {
      const window = toGo <= 144 ? "~1 day" : toGo <= 1_008 ? "~7 days" : "~30 days";
      return { chip: t("bond.chipEndingSoon"), color: T.amber, line: t("bond.rowLineRenewSoon", { window, blocks: toGo, time: humanTime(toGo) }) };
    }
    return { chip: t("bond.chipLocked"), color: T.green, line: toGo != null ? t("bond.rowLineUnlocksIn", { blocks: toGo, time: humanTime(toGo) }) : t("bond.rowLineUnlocksAt", { block: rec.bond.lockUntil }) };
  })();
  return (
    <button onClick={() => onOpen(rec)}
      style={{ display: "block", width: "100%", textAlign: "left", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "10px 12px", marginBottom: 8, cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.mono }}>
          {rec.phase === "created" && !rec.renewedFromBondId ? t("bond.satsPlanned", { sats: rec.amountSats.toString() }) : t("bond.satsAmount", { sats: rec.amountSats.toString() })}
        </span>
        <span style={{ fontSize: 8.5, fontWeight: 800, color: status.color, fontFamily: T.mono, letterSpacing: 1, border: `1px solid ${status.color}`, borderRadius: 99, padding: "2px 8px", flexShrink: 0 }}>
          {status.chip}
        </span>
      </div>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginTop: 4 }}>
        {t("bond.rowUntilBlock", { block: rec.bond.lockUntil, line: status.line })}
      </div>
    </button>
  );
}

function ReclaimDestinationPicker({ choice, onChoice, externalAddress, onExternalAddress, busy, quote, onSubmit, onCancel }: {
  choice: ReclaimDestinationKind;
  onChoice: (choice: ReclaimDestinationKind) => void;
  externalAddress: string;
  onExternalAddress: (address: string) => void;
  busy: boolean;
  quote: { finalityDelay: number; minimumDepositSats: number; pegInFeeSats: number; minerFeeSats: bigint; estimatedNetSats: bigint } | null;
  onSubmit: (destination: ReclaimDestinationChoice) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const externalValidation = validateBitcoinAddressForNetwork(externalAddress, BOND_NETWORK);
  const externalReady = choice !== "external" || externalValidation.ok;
  const canSubmit = !busy && externalReady;
  const submit = () => {
    if (!canSubmit) return;
    const destination: ReclaimDestinationChoice = choice === "external"
      ? { kind: "external", address: externalValidation.ok ? externalValidation.address : externalAddress.trim() }
      : { kind: choice };
    onSubmit(destination);
  };
  return (
    <div style={{ textAlign: "left", marginTop: 4 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: T.text, fontFamily: T.mono, marginBottom: 6 }}>
        {t("bond.reclaimDestinationHeading")}
      </div>
      <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 10 }}>
        {t("bond.confirmReclaimBefore")}<b style={{ color: T.text }}>{t("bond.confirmReclaimBold")}</b>{t("bond.confirmReclaimAfter")} {t("bond.reclaimDestinationBody")}
      </div>
      {choice === "chama" && quote && (
        <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, lineHeight: 1.55, marginBottom: 10, padding: "8px 10px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs }}>
          {t("bond.reclaimQuote", { confirmations: quote.finalityDelay, minimum: quote.minimumDepositSats, pegFee: quote.pegInFeeSats, minerFee: quote.minerFeeSats.toString(), net: quote.estimatedNetSats.toString() })}
        </div>
      )}
      <div style={{ display: "grid", gap: 7, marginBottom: 10 }}>
        <ReclaimOptionButton
          selected={choice === "chama"}
          title={t("bond.reclaimBackToChama")}
          badge={t("bond.reclaimRecommended")}
          body={t("bond.reclaimBackToChamaBody")}
          onClick={() => onChoice("chama")}
          disabled={busy}
        />
        <ReclaimOptionButton
          selected={choice === "external"}
          title={t("bond.reclaimExternal")}
          body={t("bond.reclaimExternalBody")}
          onClick={() => onChoice("external")}
          disabled={busy}
        />
        {choice === "external" && (
          <>
            <input
              value={externalAddress}
              onChange={(e) => onExternalAddress(e.target.value)}
              disabled={busy}
              placeholder={t("bond.reclaimExternalPlaceholder")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${externalValidation.ok ? T.border : T.amber}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 11.5, padding: "9px 11px", outline: "none" }}
            />
            {!externalValidation.ok && (
              <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, lineHeight: 1.4, marginTop: -3 }}>
                {externalValidation.message}
              </div>
            )}
          </>
        )}
        <ReclaimOptionButton
          selected={choice === "bond-key"}
          title={t("bond.reclaimBondKey")}
          body={t("bond.reclaimBondKeyBody")}
          onClick={() => onChoice("bond-key")}
          disabled={busy}
        />
      </div>
      <button onClick={submit} disabled={!canSubmit} style={{ ...primaryBtn(canSubmit), background: canSubmit ? T.amber : T.surface, borderColor: canSubmit ? T.amber : T.border }}>
        {busy ? t("bond.reclaiming") : t("bond.reclaimSelectedDestination")}
      </button>
      <button onClick={onCancel} disabled={busy} style={{ ...secondaryBtn, marginTop: 6 }}>{t("common.cancel")}</button>
    </div>
  );
}

function ReclaimOptionButton({ selected, title, body, badge, onClick, disabled }: {
  selected: boolean;
  title: string;
  body: string;
  badge?: string;
  onClick: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: "100%",
        textAlign: "left",
        background: T.surface,
        border: `1px solid ${selected ? T.accent : T.border}`,
        borderRadius: T.rs,
        color: T.text,
        fontFamily: T.mono,
        padding: "9px 10px",
        cursor: disabled ? "default" : "pointer",
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 4 }}>
        <span style={{ width: 14, color: selected ? T.accent : T.muted, flexShrink: 0 }}>{selected ? "●" : "○"}</span>
        <span style={{ fontSize: 11.5, fontWeight: 800, flex: 1 }}>{title}</span>
        {badge && <span style={{ fontSize: 8.5, color: T.accent, border: `1px solid ${T.accent}`, borderRadius: 99, padding: "1px 6px", flexShrink: 0 }}>{badge}</span>}
      </span>
      <span style={{ display: "block", paddingLeft: 21, fontSize: 10, color: T.muted, lineHeight: 1.45 }}>
        {body}
      </span>
    </button>
  );
}

// What a bonded arbiter is actually signing up for — shown the moment they lock,
// so "place your sats here while you perform your duties" states the duties plainly.
// Your bond is a commitment TO these; it's the stake behind your word.
function ArbiterDuties() {
  const { t } = useT();
  const duties: { icon: string; text: string }[] = [
    { icon: "⚖️", text: t("bond.dutyDisputes") },
    { icon: "💬", text: t("bond.dutyReachable") },
    { icon: "🤝", text: t("bond.dutyHonest") },
  ];
  return (
    <div style={{ background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "10px 12px", marginBottom: 12, textAlign: "left" }}>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>{t("bond.dutiesHeading")}</div>
      <div style={{ display: "grid", gap: 8 }}>
        {duties.map((d) => (
          <div key={d.text} style={{ display: "flex", alignItems: "flex-start", gap: 9 }}>
            <span style={{ fontSize: 13, lineHeight: 1.3, flexShrink: 0 }}>{d.icon}</span>
            <span style={{ fontSize: 10.5, color: T.text, fontFamily: T.mono, lineHeight: 1.5 }}>{d.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// The announce-to-community control on the locked screen. A search over ALL 190
// countries (NOT just the curated feds) — a Chama is any community living inside a
// country, with or without a G-Bot fed, so an arbiter can bond for any of them.
// Picking a country resolves it to a stable community slug (persisting a generated
// shell so it's real). One publish button; success is a calm line, never a modal.
// Re-announcing is fine (replaceable event — it just refreshes).
function AnnounceBond({ slug, onSlug, announcing, announcedTo, error, merchantOnly, onMerchantOnly, onAnnounce }: {
  slug: string;
  onSlug: (slug: string) => void;
  announcing: boolean;
  announcedTo: string | null;
  error: string | null;
  merchantOnly: boolean;
  onMerchantOnly: (v: boolean) => void;
  onAnnounce: () => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const countries = getAllPickerCountries();
  const selected = getCommunityBySlug(slug);
  const search = query.trim().toLowerCase();
  const matches = search ? countries.filter((c) => countryMatchesSearch(c, search)).slice(0, 40) : [];
  const pick = (c: PickerCountry) => { onSlug(resolveCountryCommunitySlug(c)); setQuery(""); };
  return (
    <div style={{ marginTop: 12, marginBottom: 6, paddingTop: 12, borderTop: `1px solid ${T.border}`, textAlign: "left" }}>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 }}>{t("bond.announceHeading")}</div>
      <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 8 }}>
        {t("bond.announceBodyBefore")}<b style={{ color: T.text }}>{t("bond.announceBodyBold")}</b>{t("bond.announceBodyAfter")}
      </div>
      {/* The chama this bond will announce for (defaults to your home). */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "9px 11px", marginBottom: 8 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>{selected?.flagEmoji ?? "🌍"}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected?.displayName ?? slug}</div>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>{t("bond.announcingHere")}</div>
        </div>
      </div>
      <input
        value={query} onChange={(e) => setQuery(e.target.value)} disabled={announcing}
        placeholder={t("bond.searchCountries")} autoComplete="off" autoCapitalize="off" spellCheck={false}
        style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 12, padding: "9px 11px", marginBottom: 8, outline: "none" }}
      />
      {search && (
        <div style={{ display: "grid", gap: 6, maxHeight: 176, overflowY: "auto", marginBottom: 8, paddingRight: 2 }}>
          {matches.length === 0 ? (
            <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.mono, padding: "8px 4px" }}>{t("bond.noCountryMatch", { query })}</div>
          ) : matches.map((c) => (
            <button key={c.code} onClick={() => pick(c)} disabled={announcing}
              style={{ display: "flex", alignItems: "center", gap: 9, width: "100%", textAlign: "left", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", cursor: "pointer" }}>
              <span style={{ fontSize: 16, lineHeight: 1 }}>{c.flag}</span>
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontSize: 12, color: T.text, fontFamily: T.mono, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</span>
                <span style={{ display: "block", fontSize: 9, color: T.muted, fontFamily: T.mono }}>{countrySubline(c)}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {/* A2 merchant lane. Off by default: an arbiter bond is what every bond
          has always been, and it is also the only one that EARNS — the 0.25%
          insurance premium is an arbiter's return on their stake. So the cost
          of opting out is stated here rather than discovered later. */}
      <label style={{
        display: "flex", alignItems: "flex-start", gap: 9, marginBottom: 10,
        background: T.surface, border: `1px solid ${T.border}`,
        borderRadius: T.rs, padding: "9px 11px", cursor: announcing ? "default" : "pointer",
      }}>
        <input
          type="checkbox"
          checked={merchantOnly}
          disabled={announcing}
          onChange={(e) => onMerchantOnly(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: "block", fontSize: 11.5, color: T.text, fontFamily: T.mono, lineHeight: 1.45 }}>
            {t("bond.merchantOnly")}
          </span>
          <span style={{ display: "block", fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginTop: 3 }}>
            {t("bond.merchantOnlyBody")}
          </span>
        </span>
      </label>
      <button onClick={onAnnounce} disabled={announcing || !slug} style={{ ...secondaryBtn, marginBottom: 0, borderColor: T.accent, color: T.accent }}>
        {announcing ? t("bond.announcing") : announcedTo ? t("bond.announceAgain") : t("bond.announceMyBond")}
      </button>
      {announcedTo && (
        <div style={{ fontSize: 10.5, color: T.green, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5 }}>
          {t("bond.announcedToBefore")}<b>{announcedTo}</b>{t("bond.announcedToAfter")}
        </div>
      )}
      {error && <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

function BackToBonds({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button onClick={onClick}
      style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 10.5, cursor: "pointer", padding: 0, marginBottom: 10, display: "block", textAlign: "left" }}>
      {t("bond.allBonds")}
    </button>
  );
}

function MissingBond({ onBack }: { onBack: () => void }) {
  const { t } = useT();
  return (
    <div style={{ padding: "8px 0" }}>
      <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
        {t("bond.missingBond")}
      </div>
      <button onClick={onBack} style={primaryBtn(true)}>{t("bond.backToBonds")}</button>
    </div>
  );
}

function CopyableValue({ heading, label, value }: { heading?: string; label: string; value: string }) {
  return (
    <>
      {heading && <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, margin: "8px 0 5px", textAlign: "left" }}>{heading}</div>}
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, wordBreak: "break-all", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "6px 8px", marginBottom: 8 }}>{value}</div>
      <CopyButton value={value} label={label} style={secondaryBtn} />
    </>
  );
}

function Header({ onClose, closeable }: { onClose: () => void; closeable: boolean }) {
  const { t } = useT();
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
      <div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 4 }}>{t("bond.headerKicker")}</div>
        <div style={{ fontSize: 18, fontWeight: 800, color: T.text, fontFamily: T.mono, letterSpacing: -0.3 }}>{t("bond.headerTitle")}</div>
      </div>
      {closeable && <button onClick={onClose} style={{ background: "none", border: "none", color: T.muted, fontSize: 20, cursor: "pointer", lineHeight: 1, padding: 4 }}>×</button>}
    </div>
  );
}

// Rough human time for a block count (mainnet mines ~10-min blocks).
function humanTime(blocks: number): string {
  const mins = blocks * 10;
  if (mins < 90) return `${Math.max(1, Math.ceil(mins))} min`;
  const hrs = mins / 60;
  if (hrs < 48) return `${Math.round(hrs)} h`;
  return `${Math.round(hrs / 24)} days`;
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 6 };
const secondaryBtn: React.CSSProperties = { width: "100%", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 12, padding: "9px 12px", cursor: "pointer", marginBottom: 8 };
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: "100%", background: enabled ? T.accent : T.surface, border: `1px solid ${enabled ? T.accent : T.border}`, borderRadius: T.rs, color: enabled ? "#0a0a0f" : T.muted, fontFamily: T.mono, fontSize: 13, fontWeight: 700, padding: "11px 12px", cursor: enabled ? "pointer" : "default" };
}
