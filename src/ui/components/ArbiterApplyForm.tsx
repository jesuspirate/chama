import { useState } from "react";
import { T, ROLE_COLOR } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { HelpTip } from "./HelpTip.js";

// v3.1.1: the arbiter application form, extracted from MeScreen so it can live
// inline inside the Browse floating-menu "Become an arbiter" toast — the single
// place to apply (no more hard-link bounce to Me › Arbiter). Submitting signs a
// kind:38121 application the community's roster steward reviews; no schema
// change (the federation-operator credential rides inside the statement text).
export function ArbiterApplyForm({
  communitySlug,
  onApply,
  onClose,
}: {
  communitySlug: string;
  onApply: (community: string, statement: string) => Promise<void>;
  onClose?: () => void;
}) {
  const { t } = useT();
  const [statement, setStatement] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fedInvite, setFedInvite] = useState("");
  const community = getCommunityBySlug(communitySlug);
  const displayName = community?.displayName ?? communitySlug;

  const submit = async () => {
    if (!statement.trim()) {
      setError(t("bond.applyErrorEmpty"));
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // v3.1 A3: fed operators are the strongest anchors — carry the invite +
      // steward key inside the statement text (no kind:38121 schema change).
      const fullStatement = fedInvite.trim()
        ? `${statement.trim()}\n\nFederation operator — invite + steward key: ${fedInvite.trim()}`
        : statement;
      await onApply(communitySlug, fullStatement);
      setStatus(t("bond.applySuccess"));
      setStatement("");
      setFedInvite("");
    } catch (e: any) {
      setError(e?.message || t("bond.applyFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 15, lineHeight: 1 }}>⚖️</span>
          <span style={{ fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700, color: ROLE_COLOR.arbiter,}}>
            {t("bond.applyHeading")}
          </span>
          <HelpTip title={t("bond.applyTipTitle")} label={t("bond.applyTipLabel")}>
            {t("bond.applyTipP1")}<strong>{t("bond.applyTipBold1")}</strong>{t("bond.applyTipP2")}<strong>{t("bond.applyTipBold2")}</strong>{t("bond.applyTipP3")}
            {/* TODO(bond 2A): add "post a bond to raise your exposure cap" line here once BONDS_ENFORCED ships. */}
          </HelpTip>
        </span>
        {onClose && (
          <button
            type="button" onClick={onClose} aria-label={t("common.close")}
            style={{ background: "none", border: "none", color: T.muted, fontSize: 20, lineHeight: 1, cursor: "pointer", padding: "0 2px", flexShrink: 0 }}
          >×</button>
        )}
      </div>
      {/* v4.1 C1 reframe: the arbiter on-ramp is the aspirational LEADER pitch,
          self-selecting — recruiter voice up top, then an honest bond-ceremony
          teaser (real custody lands with Phase 2A; today it's apply-and-build). */}
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 10 }}>
        <span style={{ color: T.text, fontWeight: 700 }}>
          {t("bond.applyPitchLead")}
        </span>{" "}
        {t("bond.applyPitchBody")}
        <div style={{
          marginTop: 8, paddingTop: 8, borderTop: `1px solid ${T.border}`,
          fontSize: 10.5, lineHeight: 1.5,
        }}>
          <span style={{ color: ROLE_COLOR.arbiter, fontWeight: 700 }}>{t("bond.applyComingLabel")}</span>{" "}
          {t("bond.applyComingBefore")}<strong>{t("bond.applyComingBold")}</strong>{t("bond.applyComingAfter")}
        </div>
      </div>
      <textarea
        value={statement}
        onChange={e => setStatement(e.target.value)}
        placeholder={t("bond.applyPlaceholder", { community: displayName })}
        rows={3}
        maxLength={800}
        style={{
          width: "100%", boxSizing: "border-box", resize: "vertical",
          padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.sans, fontSize: 12, lineHeight: 1.5,
        }}
      />
      {/* v3.1 A3: federation-owner credential — the premier "proof of work"
          anchor path. Form + copy only; the invite rides in the statement. */}
      <div style={{
        marginBottom: 8, padding: "10px 12px", borderRadius: T.rs,
        background: `${ROLE_COLOR.arbiter}0f`, border: `1px solid ${ROLE_COLOR.arbiter}33`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
          <span style={{ fontSize: T.fs.secondary, fontWeight: 700, color: ROLE_COLOR.arbiter, fontFamily: T.sans,}}>
            {t("bond.applyFedHeading")}
          </span>
          <HelpTip title={t("bond.applyFedTipTitle")} label={t("bond.applyFedTipLabel")}>
            {t("bond.applyFedTipBody")}
          </HelpTip>
        </div>
        <div style={{ fontSize: 10.5, color: T.muted, fontFamily: T.sans, lineHeight: 1.45, marginBottom: 8 }}>
          {t("bond.applyFedBody")}
        </div>
        <input
          value={fedInvite}
          onChange={e => setFedInvite(e.target.value)}
          placeholder={t("bond.applyFedPlaceholder")}
          style={{
            width: "100%", boxSizing: "border-box",
            padding: "9px 11px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.sans, fontSize: T.fs.secondary,
          }}
        />
      </div>
      <button
        onClick={submit}
        disabled={busy}
        style={{
          width: "100%", padding: "10px 14px", borderRadius: T.rs,
          border: `1px solid ${ROLE_COLOR.arbiter}66`, background: `${ROLE_COLOR.arbiter}22`,
          color: ROLE_COLOR.arbiter, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
          cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
        }}
      >
        {busy ? t("bond.applyPublishing") : t("bond.applySubmit")}
      </button>
      {status && (
        <div style={{ marginTop: 8, fontSize: T.fs.secondary, color: T.green, fontFamily: T.sans, lineHeight: 1.4 }}>
          ✓ {status}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: T.fs.secondary, color: T.red, fontFamily: T.sans, lineHeight: 1.4 }}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
