import { mergeManageBonds, type BondRecoveryReport } from '../../bond-multisig/bond-recovery.js';
import { BondManageActions } from '../components/BondManageActions.js';
import { bondManageActions, type BondChainObservation } from '../../bond-multisig/manage-actions.js';
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
import { EcashCustody } from "../components/MoneyCustody.js";
import { OverlaySheet } from "../components/OverlaySheet.js";
import { InlineExplanation } from "../components/InlineExplanation.js";
import { HelpTip } from "../components/HelpTip.js";
import { PaymentButton } from "../components/PaymentCard.js";
import type { VerifiedBond } from "../../bond-multisig/bond-announcement.js";
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
  checkCommitmentFunding: (bondId: string) => Promise<{ locked: boolean; txid?: string; lockedSats?: bigint; deposits?: number; chainConfirmed?: boolean }>;
  getCommitmentReclaimQuote: (bondId: string) => Promise<{ finalityDelay: number; minimumDepositSats: number; pegInFeeSats: number; minerFeeSats: bigint; estimatedNetSats: bigint } | null>;
  renewCommitmentBond: (bondId: string, termBlocks: number) => Promise<{ bondId: string; txid: string; amountSats: bigint; feeSats: bigint; lockUntil: number; pending: boolean }>;
  /** Rebuild this device's bond records from the user's own on-chain announcements + seed. */
  recoverMyBonds: (opts?: { allowUserAction?: boolean }) => Promise<{ recovered: number; issues?: BondRecoveryReport["issues"] }>;
  findMyBond?: (address: string, lockUntil: number) => Promise<{ bondId: string }>;
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
  publishBondAnnouncement?: (bondId: string, community: string) => Promise<{ community: string; address: string }>;
  fetchMyBonds?: () => Promise<VerifiedBond[]>;
  walletInvite?: string;
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

export function BondCeremonyModal({ createCommitmentBond, checkCommitmentFunding, getCommitmentReclaimQuote, renewCommitmentBond, recoverMyBonds, findMyBond, reclaimCommitmentBond, creditReclaimedCommitmentBond, getBondChainTip, publishBondAnnouncement, fetchMyBonds, walletInvite, onClose }: BondCeremonyModalProps) {
  const { t } = useT();
  // Open on the list when any bond exists; straight to describe on a first run.
  const [view, setView] = useState<View>({ kind: "list" });
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
  const [announced, setAnnounced] = useState<Set<string>>(() => new Set());
  const markAnnounced = (bondId: string, slug: string) => {
    const rec = getCommitmentBond(bondId);
    if (rec) setAnnounced(old => new Set([...old, `${rec.bond.address}|${slug}`]));
  };
  const [announceErr, setAnnounceErr] = useState<string | null>(null);
  // Bump to re-read the store after a check/reclaim mutates it.
  const [storeRev, setStoreRev] = useState(0);

  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => { contentRef.current?.focus({ preventScroll: true }); }, [view.kind, confirmReclaim]);

  // Pin the action props in refs so the poll effects' identities never change
  // (else the intervals are torn down every render and never fire).
  const tipFnRef = useRef(getBondChainTip);
  tipFnRef.current = getBondChainTip;
  const checkFnRef = useRef(checkCommitmentFunding);
  checkFnRef.current = checkCommitmentFunding;
  // Bonds already auto-announced this session (so opening a locked bond from the
  // list doesn't re-fire — only a fresh on-chain lock detection does).
  const autoAnnouncedRef = useRef<Set<string>>(new Set());

  const recoveryMessage = (issue: { code?: string; reason: string }) => {
    const key = { 'seed-locked': 'bond.seedLocked', 'seed-missing': 'bond.seedMissing', 'key-not-found': 'bond.keyNotFound', 'funds-not-confirmed': 'bond.fundsNotConfirmed' }[issue.code ?? ''];
    return key ? t(key) : issue.reason;
  };
  const [verifiedBonds, setVerifiedBonds] = useState<VerifiedBond[]>([]);
  const [recoveryIssues, setRecoveryIssues] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(true);
  const [findAddress, setFindAddress] = useState('');
  const [findBlock, setFindBlock] = useState('');
  const [findError, setFindError] = useState<string | null>(null);
  const alive = useRef(true);
  const recoveryBusy = useRef(false);
  const refreshBonds = async (allowUserAction = false) => {
    if (recoveryBusy.current) return;
    recoveryBusy.current = true; setRecovering(true);
    const [publicRead, recovery] = await Promise.allSettled([
      fetchMyBonds ? fetchMyBonds() : Promise.resolve([] as VerifiedBond[]),
      recoverMyBonds({ allowUserAction }),
    ]);
    if (alive.current) {
      const issues: string[] = [];
      if (publicRead.status === 'fulfilled') {
        setVerifiedBonds(publicRead.value);
        setAnnounced(old => new Set([...old, ...publicRead.value.map(b => `${b.address}|${b.community}`)]));
      } else issues.push(publicRead.reason?.message || t('bond.recoveryFailed'));
      if (recovery.status === 'fulfilled') issues.push(...(recovery.value.issues ?? []).map(recoveryMessage));
      else issues.push(recovery.reason?.message || t('bond.recoveryFailed'));
      setRecoveryIssues(issues); setStoreRev(n => n + 1); setRecovering(false);
    }
    recoveryBusy.current = false;
  };
  useEffect(() => {
    alive.current = true; void refreshBonds();
    return () => { alive.current = false; };
    // One read per open. Retry is an explicit wallet-unlock gesture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const findBond = async () => {
    if (!findMyBond || busy) return;
    setBusy(true); setFindError(null);
    try {
      const found = await findMyBond(findAddress.trim(), Number(findBlock));
      if (!alive.current) return;
      setStoreRev(n => n + 1); setRecoveryIssues([]); setFindAddress(''); setFindBlock('');
      const rec = getCommitmentBond(found.bondId);
      setView(rec?.phase === 'reclaimed' ? { kind: 'list' } : { kind: 'locked', bondId: found.bondId });
    } catch (error) { if (alive.current) setFindError(recoveryMessage({ code: (error as { code?: string }).code, reason: (error as Error).message })); }
    finally { if (alive.current) setBusy(false); }
  };

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
  const managedBondId = 'bondId' in view ? view.bondId : null;
  const [manageChain, setManageChain] = useState<{ bondId: string; observation: BondChainObservation } | null>(null);
  useEffect(() => {
    if (!managedBondId) { setManageChain(null); return; }
    let cancelled = false;
    const pull = async () => {
      try {
        const [height, funding] = await Promise.all([tipFnRef.current(), checkFnRef.current(managedBondId)]);
        if (!cancelled) {
          setManageChain({ bondId: managedBondId, observation: { tip: height, unspent: funding.chainConfirmed === true } });
          setStoreRev(n => n + 1);
        }
      } catch { if (!cancelled) setManageChain(null); }
    };
    void pull();
    const timer = setInterval(() => void pull(), TIP_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [managedBondId]);
  const managedRec = managedBondId ? bonds.find(b => b.bondId === managedBondId) : undefined;
  const managedObservation = manageChain?.bondId === managedBondId ? manageChain.observation : null;

  const resetReclaimForm = () => {
    setConfirmReclaim(false);
    setReclaimChoice("chama");
    setExternalReclaimAddress("");
    setReclaimQuote(null);
  };
  const backToList = () => { setNote(null); resetReclaimForm(); setAnnounceErr(null); setStoreRev((n) => n + 1); setView({ kind: "list" }); };

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
    // New announcements use the arbiter default and emit no roles field.
    // Existing locked bonds are not auto-announced merely by opening them.
    void publishBondAnnouncement(bondId, slug)
      .then(() => { setAnnounceSlug(slug); markAnnounced(bondId, slug); })
      .catch(() => { autoAnnouncedRef.current.delete(bondId); });
  };

  const announce = async (bondId: string, slug: string) => {
    if (!publishBondAnnouncement) return;
    setAnnouncing(true); setAnnounceErr(null);
    try {
      const r = await publishBondAnnouncement(bondId, slug);
      markAnnounced(bondId, r.community);
    } catch (e: any) {
      setAnnounceErr(e?.message || t("bond.announceFailed"));
    } finally { setAnnouncing(false); }
  };

  const closeable = view.kind !== "working";

  return (
    <OverlaySheet title={t(view.kind === "describe" ? "bond.newTitle" : confirmReclaim ? "bond.reclaimMyBond" : "bond.manageTitle")}
      onClose={onClose} dismissible={closeable} showDone={false}>
      <div data-bond-ceremony ref={contentRef} tabIndex={-1} style={{ fontFamily: T.sans, outline: "none" }}>
        <style>{`.bond-term:focus-visible,[data-bond-ceremony] summary:focus-visible{outline:2px solid ${T.accent};outline-offset:3px}`}</style>

        {managedRec && !confirmReclaim && <BondManageActions rec={managedRec} chain={managedObservation} busy={busy || announcing}
          onAnnounce={publishBondAnnouncement ? () => void announce(managedRec.bondId, announceSlug) : undefined}
          onAdd={() => { setNote(null); resetReclaimForm(); setView({ kind: "describe" }); }}
          onClaim={() => {
            if (!bondManageActions(managedRec, managedObservation).claim.enabled) return;
            setNote(null); setConfirmReclaim(true); setView({ kind: "locked", bondId: managedRec.bondId });
            void getCommitmentReclaimQuote(managedRec.bondId).then(setReclaimQuote).catch(() => setReclaimQuote(null));
          }} />}

        {view.kind === "list" && <>
          <BondRecoveryNotice issues={recoveryIssues} busy={recovering} onRetry={() => void refreshBonds(true)} />
          <BondList
            bonds={bonds}
            verified={verifiedBonds}
            checking={recovering || (recoveryIssues.length > 0 && bonds.length === 0 && verifiedBonds.length === 0)}
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
          {findMyBond && <details style={{ marginTop: 12 }}>
            <summary style={{ minHeight: 44, cursor: 'pointer' }}>{t('bond.findMyBonds')}</summary>
            <div style={{ margin: '8px 0' }}>{t('bond.findHelp')}</div>
            <label style={labelStyle}>{t('bond.findAddress')}</label>
            <input aria-label={t('bond.findAddress')} value={findAddress} onChange={e => setFindAddress(e.target.value)} style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, padding: '10px 12px', marginBottom: 12 }} />
            <label style={labelStyle}>{t('bond.findUnlockBlock')}</label>
            <input aria-label={t('bond.findUnlockBlock')} value={findBlock} onChange={e => setFindBlock(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" style={{ width: '100%', boxSizing: 'border-box', minHeight: 44, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, padding: '10px 12px', marginBottom: 12 }} />
            {findError && <div role="alert" style={{ color: T.amber, margin: '8px 0' }}>{findError}</div>}
            <PaymentButton disabled={busy || recovering || !findAddress.trim() || !Number(findBlock)} onClick={() => void findBond()}>{busy ? t('bond.checking') : t('bond.findMyBonds')}</PaymentButton>
          </details>}
        </>}

        {view.kind === "describe" && (
          <>
            {(bonds.length > 0 || verifiedBonds.length > 0) && <BackToBonds onClick={backToList} />}
            <div style={{ marginBottom: 14 }}><BondCustody /></div>
            <ArbiterDuties />
            <label style={labelStyle}>{t("bond.amountLabel")}</label>
            <input aria-label={t("bond.amountLabel")} value={amountStr} onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9]/g, ""))} inputMode="numeric"
              style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 18, minHeight: 44, padding: "10px 12px", marginBottom: 16 }} />
            <TermChoices value={termBlocks} onChange={setTermBlocks} />
            <div style={{ fontSize: 12, color: T.muted, margin: "12px 0" }}>{t("bond.noSatsMove")}</div>
            <PaymentButton tier="primary" onClick={post} disabled={amountSats <= 0n} style={primaryBtn(amountSats > 0n)}>{t("bond.createAddress")}</PaymentButton>
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
              <div style={{ fontSize: 15, fontWeight: 700, color: T.text, fontFamily: T.sans, marginBottom: 4 }}>{t(isRenewal ? "bond.renewConfirmingTitle" : "bond.fundHeading")}</div>
              <div style={{ fontSize: 14, color: T.text, lineHeight: 1.5, marginBottom: 8 }}>
                {isRenewal ? t("bond.renewConfirmingBody", { source: (rec.amountSats + (rec.renewalFeeSats ?? 0n)).toString(), sats: rec.amountSats.toString(), block: rec.bond.lockUntil, fee: (rec.renewalFeeSats ?? 0n).toString() }) : t("bond.fundAmount", { sats: rec.amountSats.toString() })}
              </div>
              <BondCustody block={rec.bond.lockUntil} remainingBlocks={toGo} prospective />
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
              {!confirmReclaim && <div style={{ fontSize: 12, color: expired ? T.accent : T.green, marginBottom: 8 }}>
                {t(expired ? "bond.termEndedTitle" : "bond.lockedTitle")}
              </div>}
              <div style={{ fontSize: 28, fontWeight: 700, color: T.text, marginBottom: 8 }}>
                {t("bond.satsAmount", { sats: rec.amountSats.toLocaleString() })}
              </div>
              {!confirmReclaim && view.foundNote && <div style={{ fontSize: 12, color: T.green, marginBottom: 8 }}>{view.foundNote}</div>}
              <BondCustody block={rec.bond.lockUntil} remainingBlocks={toGo} />
              {!confirmReclaim && !expired && <ArbiterDuties />}
              {!confirmReclaim && deposits.length > 0 && (
                <details style={{ textAlign: "left", borderTop: `1px solid ${T.border}`, padding: "12px 0", marginBottom: 8 }}>
                  <summary style={{ fontSize: 12, color: T.muted, cursor: "pointer", minHeight: 44, alignContent: "center" }}>{t(deposits.length === 1 ? "bond.depositDetailsOne" : "bond.depositDetailsMany", { count: deposits.length })}</summary>
                  {deposits.map((d) => (
                    <div key={`${d.txid}:${d.index}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 10, color: T.text, fontFamily: T.mono, marginBottom: 3 }}>
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.txid.slice(0, 10)}…{d.txid.slice(-6)}:{d.index}</span>
                      <span style={{ flexShrink: 0, color: T.muted }}>{d.amountSats.toString()}</span>
                    </div>
                  ))}
                  <button onClick={() => void checkNow(view.bondId)} disabled={busy}
                    style={{ background: "none", border: "none", color: T.muted, fontFamily: T.mono, fontSize: 12, cursor: "pointer", minHeight: 44, padding: "4px 0 0", boxShadow: "none" }}>
                    {busy ? t("bond.checkingLower") : t("bond.checkForMore")}
                  </button>
                </details>
              )}
              {/* Informational countdown only (monotonic tip). Reclaim is a DELIBERATE
                  two-step action, never the reflexive primary button (which is Done),
                  so a stray tap after locking can't return the bond. Consensus is the
                  real gate: an early reclaim is rejected and surfaced as "almost". */}
              {!confirmReclaim && !notYet && tip != null && (
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
                  announcing={announcing} announcedTo={announced.has(`${rec.bond.address}|${announceSlug}`) ? getCommunityBySlug(announceSlug)?.displayName ?? announceSlug : null} error={announceErr}
                  onAnnounce={() => void announce(view.bondId, announceSlug)}
                />
              )}
              {confirmReclaim ? (
                <ReclaimDestinationPicker
                  walletInvite={walletInvite}
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
                    <TermChoices value={termBlocks} onChange={setTermBlocks} disabled={busy} renewal />
                  </div>
                  <PaymentButton tier="primary" onClick={() => void renew(view.bondId)} disabled={busy || !bondManageActions(rec, managedObservation).claim.enabled} style={primaryBtn(!busy && bondManageActions(rec, managedObservation).claim.enabled)}>
                    {busy ? t("bond.renewing") : t("bond.renewBond")}
                  </PaymentButton>
                  <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>{t("common.done")}</button>
                </>
              ) : (
                <>
                  <PaymentButton tier="quiet" disabled>{t("bond.renewBond")}</PaymentButton>
                  <div style={{ fontSize: 12, color: T.muted }}>{t("bond.claimAtBlock", { block: rec.bond.lockUntil })}</div>
                  <PaymentButton tier={publishBondAnnouncement && !announced.has(`${rec.bond.address}|${announceSlug}`) ? "quiet" : "primary"} onClick={onClose} style={publishBondAnnouncement && !announced.has(`${rec.bond.address}|${announceSlug}`) ? secondaryBtn : primaryBtn(true)}>{t("common.done")}</PaymentButton>

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
              <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.6, marginBottom: 12 }}>
                {t(bodyKey)}
              </div>
              {creditConfirmed && <EcashCustody />}
              {creditSubmitted && <div style={{ fontSize: 12, color: T.muted, marginBottom: 12 }}>{t("bond.depositPending")}</div>}
              <CopyableValue label={t("bond.copyTxid")} value={view.txid} />
              {destinationAddress && (
                <CopyableValue
                  heading={t(actual === "chama" ? "bond.chamaDepositAddress" : "bond.destinationAddress")}
                  label={t("bond.copyAddress")}
                  value={destinationAddress}
                />
              )}
              {view.reclaimDestination?.fallbackReason && (
                <div style={{ fontSize: 12, color: T.amber, fontFamily: T.sans, lineHeight: 1.5, background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs, padding: "8px 10px", marginBottom: 8, textAlign: "left" }}>
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
                <PaymentButton tier="primary" onClick={() => void creditToChama(view.bondId)} disabled={busy} style={primaryBtn(!busy)}>{busy ? t("bond.creditingToChama") : t("bond.creditToChama")}</PaymentButton>
              )}
              <PaymentButton tier="primary" onClick={() => setView({ kind: "describe" })} style={view.creditedToChama ? primaryBtn(true) : { ...secondaryBtn, marginTop: 6 }}>{t("bond.postFreshBond")}</PaymentButton>
              <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 6 }}>{t("common.done")}</button>
              {note && <div style={{ fontSize: 10.5, color: view.creditedToChama ? T.green : T.red, fontFamily: T.mono, marginTop: 10, lineHeight: 1.5 }}>{note}</div>}
            </div>
          );
        })()}

        {closeable && (view.kind === "list" || view.kind === "describe" || view.kind === "funding" || view.kind === "error") && (
          <button onClick={onClose} style={{ ...secondaryBtn, marginTop: 16 }}>{t("common.done")}</button>
        )}

        {view.kind === "error" && (
          <div style={{ padding: "8px 0" }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: T.mono, marginBottom: 8 }}>{t("bond.somethingWrong")}</div>
            <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 16 }}>{view.message}</div>
            <PaymentButton tier="primary" onClick={() => setView({ kind: "describe" })} style={primaryBtn(true)}>{t("common.back")}</PaymentButton>
          </div>
        )}
      </div>
    </OverlaySheet>
  );
}

// ── The "Your bonds" list — post another · watch each · reclaim each ─────────
export function BondRecoveryNotice({ issues, busy, onRetry }: { issues: readonly string[]; busy?: boolean; onRetry: () => void }) {
  const { t } = useT();
  if (!issues.length) return busy ? <div>{t('bond.checking')}</div> : null;
  return <div style={{ marginBottom: 12 }}>
    <div role="alert" style={{ color: T.amber }}>{[...new Set(issues)].join(' ')}</div>
    <PaymentButton tier="quiet" disabled={busy} onClick={onRetry}>{t('common.retry')}</PaymentButton>
  </div>;
}

export function BondList({ bonds, verified = [], checking, tip, onOpen, onPostNew }: {
  bonds: CommitmentRecord[]; verified?: VerifiedBond[]; checking?: boolean;
  tip: number | null; onOpen: (rec: CommitmentRecord) => void; onPostNew: () => void;
}) {
  const { t } = useT();
  const rows = mergeManageBonds(bonds, verified);
  return <div>
    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 10 }}>{t('bond.yourBonds')}</div>
    {rows.map(row => row.local
      ? <BondRow key={row.address} rec={row.local} tip={tip} onOpen={onOpen} />
      : <div key={row.address} data-announced-bond={row.address} style={{ borderBottom: `1px solid ${T.border}`, padding: '14px 0' }}>
          <div>{t('bond.satsAmount', { sats: row.announced!.actualSats.toString() })}</div>
          <BondCustody block={row.announced!.lockUntil} />
          <div style={{ overflowWrap: 'anywhere', fontFamily: T.mono, fontSize: 11 }}>{row.address}</div>
          <div style={{ fontSize: 12, color: T.muted, margin: '8px 0', lineHeight: 1.5 }}>{t('bond.recoverBeforeManage')}</div>
          <PaymentButton disabled>{t('bond.announceAgain')}</PaymentButton>
          <PaymentButton disabled>{t('bond.renewBond')}</PaymentButton>
          <PaymentButton disabled>{t('bond.reclaimMyBond')}</PaymentButton>
        </div>)}
    {!checking && rows.length === 0 && <div>{t('bond.noLiveBond')}</div>}
    <PaymentButton tier="quiet" disabled={checking} onClick={onPostNew}>
      {t(rows.length ? 'bond.postAdditionalBond' : 'bond.postNewBond')}
    </PaymentButton>
  </div>;
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
      const window = humanTime(toGo <= 144 ? 144 : toGo <= 1_008 ? 1_008 : 4_320);
      return { chip: t("bond.chipEndingSoon"), color: T.amber, line: t("bond.rowLineRenewSoon", { window, blocks: toGo, time: humanTime(toGo) }) };
    }
    return { chip: t("bond.chipLocked"), color: T.green, line: toGo != null ? t("bond.rowLineUnlocksIn", { blocks: toGo, time: humanTime(toGo) }) : t("bond.rowLineUnlocksAt", { block: rec.bond.lockUntil }) };
  })();
  return (
    <button onClick={() => onOpen(rec)}
      style={{ display: "block", width: "100%", textAlign: "left", background: "none", border: 0, borderBottom: `1px solid ${T.border}`, borderRadius: 0, boxShadow: "none", minHeight: 72, padding: "14px 0", marginBottom: 8, cursor: "pointer" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <span style={{ fontSize: 15, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          {rec.phase === "created" && !rec.renewedFromBondId ? t("bond.satsPlanned", { sats: rec.amountSats.toString() }) : t("bond.satsAmount", { sats: rec.amountSats.toString() })}
        </span>
        <span style={{ fontSize: 8.5, fontWeight: 800, color: status.color, fontFamily: T.mono, letterSpacing: 1, border: `1px solid ${status.color}`, borderRadius: 99, padding: "2px 8px", flexShrink: 0 }}>
          {status.chip}
        </span>
      </div>
      <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, marginTop: 6 }}>
        <span style={{ overflowWrap: 'anywhere', fontFamily: T.mono, fontSize: 11 }}>{rec.bond.address}</span><br />
        {rec.phase !== "reclaimed" && <>{t(rec.phase === "created" ? "bond.rowPlanned" : "bond.rowHolding", { block: rec.bond.lockUntil })}<br /></>}{status.line}
      </div>
    </button>
  );
}

function ReclaimDestinationPicker({ walletInvite, choice, onChoice, externalAddress, onExternalAddress, busy, quote, onSubmit, onCancel }: {
  walletInvite?: string;
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
      <div style={{ fontSize: 15, fontWeight: 700, color: T.text, fontFamily: T.sans, marginBottom: 6 }}>
        {t("bond.reclaimDestinationHeading")}
      </div>
      <div style={{ fontSize: 12, color: T.muted, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 10 }}>
        {t("bond.reclaimConsequence")} {t("bond.reclaimDestinationBody")}
      </div>
      {choice === "chama" && <EcashCustody invite={walletInvite} issued />}
      {choice === "chama" && quote && (
        <div style={{ fontSize: 12, color: T.amber, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 10, padding: "8px 10px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: T.rs }}>
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
              aria-label={t("bond.reclaimExternal")}
              placeholder={t("bond.reclaimExternalPlaceholder")}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              style={{ width: "100%", boxSizing: "border-box", background: T.surface, border: `1px solid ${externalValidation.ok ? T.border : T.amber}`, borderRadius: T.rs, color: T.text, fontFamily: T.mono, fontSize: 11.5, padding: "9px 11px", outline: "none" }}
            />
            {!externalValidation.ok && (
              <div style={{ fontSize: 10, color: T.amber, fontFamily: T.mono, lineHeight: 1.4, marginTop: -3 }}>
                {t(`bond.addressError.${externalValidation.code}`)}
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
      <PaymentButton tier="primary" onClick={submit} disabled={!canSubmit} style={{ ...primaryBtn(canSubmit), background: canSubmit ? T.amber : T.surface, borderColor: canSubmit ? T.amber : T.border }}>
        {busy ? t("bond.reclaiming") : t("bond.reclaimSelectedDestination")}
      </PaymentButton>
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
      aria-pressed={selected}
      style={{
        width: "100%",
        textAlign: "left",
        background: selected ? T.accentDim : "none",
        border: 0,
        borderBottom: `1px solid ${T.border}`,
        borderRadius: T.rs,
        boxShadow: "none",
        minHeight: 64,
        color: T.text,
        fontFamily: T.sans,
        padding: "12px 10px",
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

function BondCustody({ block, remainingBlocks, prospective = false }: { block?: number; remainingBlocks?: number | null; prospective?: boolean }) {
  const { t, lang } = useT();
  const timed = remainingBlocks != null && remainingBlocks > 0;
  const key = block === undefined ? "bond.custodyPlan" : prospective
    ? timed ? "bond.custodyFundingTime" : "bond.custodyFunding"
    : timed ? "bond.custodyLockedTime" : "bond.custodyLocked";
  return <InlineExplanation summary={t(key, { block: block?.toLocaleString(lang) ?? "?", time: timed ? humanTime(remainingBlocks) : "?" })}
    title={t("bond.custodyTitle")}>
    {t("bond.custodyHelp")}
  </InlineExplanation>;
}

function ArbiterDuties() {
  const { t } = useT();
  return <div style={{ marginBottom: 12, textAlign: "left" }}>
    <InlineExplanation summary={t("bond.dutiesSummary")} title={t("bond.dutiesTitle")}>
      <div style={{ display: "grid", gap: 8 }}>
        {["bond.dutyDisputes", "bond.dutyReachable", "bond.dutyHonest"].map(key => <div key={key}>{t(key)}</div>)}
      </div>
    </InlineExplanation>
  </div>;
}

function TermChoices({ value, onChange, disabled = false, renewal = false }: {
  value: number; onChange: (blocks: number) => void; disabled?: boolean; renewal?: boolean;
}) {
  const { t } = useT();
  return <div style={{ marginBottom: 16 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ fontSize: 12, color: T.muted }}>{t(renewal ? "bond.renewTermLabel" : "bond.termLabel")}</span>
      <HelpTip title={t("bond.termLabel")}>{t("bond.validityHelp", { blocks: MIN_COMMITMENT_TERM_BLOCKS })}</HelpTip>
    </div>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 8 }}>
      {TERM_PRESETS.map((p, index) => <button type="button" key={p.blocks} className="bond-term"
        aria-pressed={value === p.blocks} disabled={disabled} onClick={() => onChange(p.blocks)}
        style={{ background: value === p.blocks ? T.accentDim : "none", border: `1px solid ${value === p.blocks ? T.accent : T.border}`,
          borderRadius: 999, boxShadow: "none", color: value === p.blocks ? T.accent : T.text, minHeight: 44, padding: "10px 8px", fontFamily: T.sans, fontSize: 13, cursor: disabled ? "default" : "pointer" }}>
        {t(["bond.termDayShort", "bond.termWeekShort", "bond.termMonthShort", "bond.termQuarterShort"][index])}
      </button>)}
    </div>
  </div>;
}

// The announce-to-community control on the locked screen. A search over ALL 190
// countries (NOT just the curated feds) — a Chama is any community living inside a
// country, with or without a G-Bot fed, so an arbiter can bond for any of them.
// Picking a country resolves it to a stable community slug (persisting a generated
// shell so it's real). One publish button; success is a calm line, never a modal.
// Re-announcing is fine (replaceable event — it just refreshes).
function AnnounceBond({ slug, onSlug, announcing, announcedTo, error, onAnnounce }: {
  slug: string;
  onSlug: (slug: string) => void;
  announcing: boolean;
  announcedTo: string | null;
  error: string | null;
  onAnnounce: () => void;
}) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [choosing, setChoosing] = useState(false);
  const chooserRef = useRef<HTMLButtonElement>(null);
  const countries = getAllPickerCountries();
  const selected = getCommunityBySlug(slug);
  const search = query.trim().toLowerCase();
  const matches = search ? countries.filter((c) => countryMatchesSearch(c, search)).slice(0, 40) : [];
  const pick = (c: PickerCountry) => { onSlug(resolveCountryCommunitySlug(c)); setQuery(""); setChoosing(false); chooserRef.current?.focus({ preventScroll: true }); };
  return (
    <div style={{ marginTop: 12, marginBottom: 6, paddingTop: 12, borderTop: `1px solid ${T.border}`, textAlign: "left" }}>
      <InlineExplanation summary={announcedTo ? t("bond.announceSuccess", { community: announcedTo }) : t("bond.announceSummary")} title={t("bond.announceTitle")}>
        {t("bond.announceHelp")}
      </InlineExplanation>
      {/* The chama this bond will announce for (defaults to your home). */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, background: "none", border: 0, borderBottom: `1px solid ${T.border}`, padding: "12px 0", marginBottom: 12 }}>
        <span style={{ fontSize: 18, lineHeight: 1 }}>{selected?.flagEmoji ?? "🌍"}</span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: T.text, fontFamily: T.mono, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selected?.displayName ?? slug}</div>
        </div>
        <button type="button" ref={chooserRef} disabled={announcing} aria-expanded={choosing} onClick={() => setChoosing(v => !v)}
          style={{ background: "none", border: 0, boxShadow: "none", minHeight: 44, color: T.accent, fontSize: 12, cursor: "pointer" }}>{t("bond.changeCommunity")}</button>
      </div>
      {choosing && <>
      <input
        value={query} onChange={(e) => setQuery(e.target.value)} disabled={announcing}
        aria-label={t("bond.searchCountries")} autoFocus placeholder={t("bond.searchCountries")} autoComplete="off" autoCapitalize="off" spellCheck={false}
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
      </>}
      {error && <div style={{ fontSize: 10.5, color: T.red, fontFamily: T.mono, marginTop: 6, lineHeight: 1.5 }}>{error}</div>}
    </div>
  );
}

function BackToBonds({ onClick }: { onClick: () => void }) {
  const { t } = useT();
  return (
    <button onClick={onClick}
      style={{ background: "none", border: "none", color: T.muted, fontFamily: T.sans, fontSize: 12, minHeight: 44, boxShadow: "none", cursor: "pointer", padding: 0, marginBottom: 10, display: "block", textAlign: "left" }}>
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
      <PaymentButton tier="primary" onClick={onBack} style={primaryBtn(true)}>{t("bond.backToBonds")}</PaymentButton>
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

// Rough human time for a block count (mainnet mines ~10-min blocks).
function humanTime(blocks: number): string {
  const mins = blocks * 10;
  if (mins < 90) return translate(getCurrentLang(), "bond.timeMin", { n: Math.max(1, Math.ceil(mins)) });
  const hrs = mins / 60;
  if (hrs < 48) return translate(getCurrentLang(), "bond.timeH", { n: Math.round(hrs) });
  return translate(getCurrentLang(), "bond.timeDays", { n: Math.round(hrs / 24) });
}

const labelStyle: React.CSSProperties = { display: "block", fontSize: 12, get color() { return T.muted; }, fontFamily: T.sans, marginBottom: 8 };
const secondaryBtn: React.CSSProperties = { width: "100%", background: "none", get border() { return `1px solid ${T.border}`; }, borderRadius: 999, boxShadow: "none", minHeight: 44, get color() { return T.text; }, fontFamily: T.sans, fontSize: 13, padding: "10px 14px", cursor: "pointer", marginBottom: 8 };
function primaryBtn(enabled: boolean): React.CSSProperties {
  return { width: "100%", background: enabled ? T.accent : T.surface, border: `1px solid ${enabled ? T.accent : T.border}`, borderRadius: 999, minHeight: 48, color: enabled ? T.bg : T.muted, fontFamily: T.sans, fontSize: 14, fontWeight: 700, padding: "12px 16px", cursor: enabled ? "pointer" : "default" };
}
