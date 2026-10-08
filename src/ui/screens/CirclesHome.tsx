// ══════════════════════════════════════════════════════════════════════════
// Chama — Circles home (v7 redesign, canvas "Circles")
// ══════════════════════════════════════════════════════════════════════════
//
// The Circles tab is circles end to end (Jet, 2026-10-06): your circles, the
// circles open to join, "Start a circle" and an invite box. With no circles
// at all it is an inviting empty state. Presentation only: the same circle
// cards Browse used, the same circle canvas behind "Start a circle", and the
// same invite parser the canvas used.

import { useState } from "react";
import type { EscrowState } from "../../escrow-engine/types.js";
import { circleFromEscrow } from "../../chama/policy.js";
import { sharesForCircle } from "../../chama/wiring.js";
import { circleInviteId } from "../../chama/canvas.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";
import { Button } from "../components/Button.js";
import { TradeCard } from "../components/TradeCard.js";
import { VerticalIcon } from "../components/VerticalIcon.js";
import type { AmountDisplayMode } from "../amount-display.js";
import type { NostrProfileNameMap } from "../nostr-profiles.js";

export function circleBuckets(all: readonly EscrowState[], visible: readonly EscrowState[], pubkey: string) {
  const me = pubkey.toLowerCase();
  const isMine = (e: EscrowState) => {
    const circle = circleFromEscrow(e);
    if (!circle) return false;
    if (circle.creatorPubkey.toLowerCase() === me) return true;
    return sharesForCircle(all, circle.circleId).some(sh => sh.memberPubkey.toLowerCase() === me);
  };
  const parents = all.filter(e => !!circleFromEscrow(e));
  const mine = parents.filter(isMine);
  const mineIds = new Set(mine.map(e => e.id));
  const open = visible.filter(e => !!circleFromEscrow(e) && !mineIds.has(e.id));
  return { mine, open };
}

export function CirclesHome({
  allEscrows, visibleListings, pubkey, onOpenTrade, onStartCircle,
  amountDisplayMode, quoteCurrency, profileNames, kind0Enabled,
}: {
  allEscrows: readonly EscrowState[];
  visibleListings: readonly EscrowState[];
  pubkey: string;
  onOpenTrade: (id: string) => void;
  /** Absent when circles are switched off. */
  onStartCircle?: () => void;
  amountDisplayMode?: AmountDisplayMode;
  quoteCurrency?: string | null;
  profileNames?: NostrProfileNameMap;
  kind0Enabled?: boolean;
}) {
  const { t } = useT();
  const [inviteDraft, setInviteDraft] = useState("");
  const [inviteError, setInviteError] = useState(false);
  const { mine, open } = circleBuckets(allEscrows, visibleListings, pubkey);
  const openInvite = () => {
    const id = circleInviteId(inviteDraft);
    if (id) onOpenTrade(id); else setInviteError(true);
  };
  const card = (e: EscrowState) => (
    <TradeCard key={e.id} state={e} pubkey={pubkey} onSelect={() => onOpenTrade(e.id)}
      allEscrows={allEscrows as EscrowState[]} amountDisplayMode={amountDisplayMode}
      quoteCurrency={quoteCurrency ?? undefined} profileNames={profileNames} kind0Enabled={kind0Enabled} />
  );
  const h2 = { margin: 0, fontFamily: T.sans, fontSize: T.fs.title2, fontWeight: 700, color: T.ink } as const;
  const empty = mine.length === 0 && open.length === 0;

  return (
    <div style={{ maxWidth: 760, margin: "0 auto", padding: "20px 16px 32px", display: "flex", flexDirection: "column", gap: 24, fontFamily: T.sans }}>
      <div>
        {(mine.length + open.length) > 0 && (
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: T.fs.secondary, fontWeight: 700, color: T.ink2, letterSpacing: ".04em", textTransform: "uppercase" }}>
            <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: T.pos }} />
            {t("browse.circlesCount", { count: mine.length + open.length })}
          </div>
        )}
        <h1 style={{ margin: 0, fontSize: T.fs.largeTitle, fontWeight: 700, letterSpacing: "-0.02em", color: T.ink, lineHeight: 1.15 }}>
          {t("browse.navCircles")}
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: T.fs.body, lineHeight: 1.45, color: T.ink2 }}>{t("create.verticalChamaDesc")}</p>
      </div>

      {empty ? (
        <section data-circles-empty style={{
          display: "flex", flexDirection: "column", alignItems: "center", gap: 14, textAlign: "center",
          padding: "28px 20px", borderRadius: T.rCard, background: T.surface, border: `1px solid ${T.line}`,
        }}>
          <VerticalIcon vertical="chama" size={72} />
          <div style={{ fontSize: T.fs.title2, fontWeight: 700, color: T.ink }}>{t("browse.circlesEmptyTitle")}</div>
          <div style={{ fontSize: T.fs.body, color: T.ink2, lineHeight: 1.45, maxWidth: 420 }}>{t("canvas.circleSub")}</div>
          {onStartCircle && <div style={{ width: "100%", maxWidth: 360 }}><Button onClick={onStartCircle}>{t("browse.startCircle")}</Button></div>}
        </section>
      ) : (
        <>
          {mine.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={h2}>{t("browse.yourCircles")}</h2>
              {mine.map(card)}
            </section>
          )}
          {open.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <h2 style={h2}>{t("browse.openToJoin")}</h2>
              {open.map(card)}
            </section>
          )}
        </>
      )}

      <section style={{ display: "flex", flexDirection: "column", gap: 8, padding: 16, borderRadius: T.rCard, background: T.surface, border: `1px solid ${T.line}` }}>
        <label htmlFor="chama-circle-invite" style={{ fontSize: T.fs.secondary, fontWeight: 600, color: T.ink2 }}>{t("canvas.circleInvited")}</label>
        <div style={{ display: "flex", gap: 10 }}>
          <input id="chama-circle-invite" value={inviteDraft}
            onChange={e => { setInviteDraft(e.target.value); setInviteError(false); }}
            onKeyDown={e => { if (e.key === "Enter") openInvite(); }}
            placeholder={t("canvas.circlePaste")}
            style={{ flex: 1, minWidth: 0, minHeight: T.size.touch, padding: "0 14px", borderRadius: T.rs, border: `1px solid ${T.line}`, background: T.bg, color: T.ink, fontFamily: T.sans, fontSize: T.fs.body }} />
          <Button variant="secondary" fullWidth={false} disabled={!inviteDraft.trim()} onClick={openInvite}>{t("canvas.circleOpen")}</Button>
        </div>
        {inviteError && <div role="alert" style={{ fontSize: T.fs.secondary, color: T.crit }}>{t("canvas.circleBadInvite")}</div>}
      </section>
      {/* Figma pass: one primary action, at the bottom where the thumb is. */}
      {!empty && onStartCircle && <Button onClick={onStartCircle}>{t("browse.startCircle")}</Button>}
    </div>
  );
}
