import { useState } from "react";
import { type FedimintState } from "../../hooks/useEscrow.js";
import {
  CURATED_PRESETS,
  BP_FEDERATION_INVITE,
} from "../../fedimint/federation-config.js";
import { T, inputStyle } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { isListedFederationInvite } from "../decisions.js";
import { SheetSelect } from "../components/SheetSelect.js";

// Renders inside Sandbox mode (Settings → Advanced) when the user is
// already joined to a federation. Lets the user pick a different
// route (curated or pasted invite) and commit the switch.
// v0.1.85: relocated out of the home screen — too dangerous
// for normie users to encounter incidentally.
export function SwitchFederationPanel({
  fedimint,
  onSwitch,
}: {
  fedimint: FedimintState;
  onSwitch: (inviteCode: string, opts?: { force?: boolean }) => Promise<void>;
}) {
  const { t } = useT();
  const presets = CURATED_PRESETS;
  const [selectedInvite, setSelectedInvite] = useState<string>(BP_FEDERATION_INVITE);
  const [customInvite, setCustomInvite] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [errCode, setErrCode] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ name: string; invite: string } | null>(null);

  const selectedPreset = presets.find((p) => p.inviteCode === selectedInvite) || presets[0];
  // The route already open: switching to it would only re-run the switch.
  const isCurrentFederation = (federationId: string | undefined) =>
    !!federationId && !!fedimint.federationId
    && federationId.trim().toLowerCase() === fedimint.federationId.trim().toLowerCase();
  const customTrimmed = customInvite.trim();
  const customValid = customTrimmed.startsWith("fed1");

  const requestPresetSwitch = () => {
    if (!selectedPreset) return;
    setConfirming({ name: selectedPreset.name, invite: selectedPreset.inviteCode });
  };
  const requestCustomSwitch = () => {
    if (!customValid) return;
    setConfirming({
      name: t("chat.externalRoute"),
      invite: customTrimmed,
    });
  };

  const doSwitch = async (target: { name: string; invite: string }, force: boolean) => {
    setBusy(true);
    setErr(null);
    setErrCode(null);
    try {
      await onSwitch(target.invite, force ? { force: true } : undefined);
      setConfirming(null);
      setCustomInvite("");
    } catch (e: any) {
      setErr(e?.message || t("chat.switchFailed"));
      setErrCode(typeof e?.code === "string" ? e.code : null);
    } finally {
      setBusy(false);
    }
  };

  // A wallet holding sats that couldn't be kept aside. Only sandbox practice
  // sats may be erased to switch; anywhere else the person sends them out
  // first, and Switch just tries again.
  const heldBack = errCode === "SWITCH_REFUSED_NONZERO_BALANCE" || errCode === "RECONCILE_REFUSED_NONZERO_BALANCE";
  const refusalCode = heldBack && isSimModeOn() ? "balance" : null;

  return (
    <div style={{
      marginTop: 14, paddingTop: 12, borderTop: `1px dashed ${T.border}`,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        {t("chat.switchRoute")}
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginBottom: 10, lineHeight: 1.5 }}>
        {t("chat.nowOn")}<span style={{ color: T.text }}>{fedimint.federationName}</span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <SheetSelect
          value={selectedInvite}
          onChange={setSelectedInvite}
          disabled={busy}
          title={t("chat.chooseFederation")}
          options={presets.filter((p) => p.source === "curated").map((p) => ({ value: p.inviteCode, label: p.name }))}
          style={{
            flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 11,
          }}
        />
        <button
          disabled={busy || !selectedPreset || isCurrentFederation(selectedPreset.federationId)}
          onClick={requestPresetSwitch}
          style={{
            padding: "8px 14px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: busy ? "not-allowed" : "pointer", whiteSpace: "nowrap",
          }}
        >
          {busy ? t("chat.switching") : t("chat.switch")}
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <input
          type="text"
          placeholder={t("chat.pasteInvitePlaceholder")}
          value={customInvite}
          onChange={(e) => setCustomInvite(e.target.value)}
          disabled={busy}
          style={{ ...inputStyle, flex: 1, marginBottom: 0 }}
        />
        <button
          disabled={busy || !customValid}
          onClick={requestCustomSwitch}
          style={{
            padding: "8px 14px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: customValid ? T.text : T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            cursor: busy || !customValid ? "not-allowed" : "pointer", whiteSpace: "nowrap",
          }}
        >
          {t("chat.switch")}
        </button>
      </div>

      {err && !confirming && (
        <div style={{
          marginTop: 8, padding: 8, borderRadius: T.rs,
          background: T.redDim, border: `1px solid ${T.red}44`,
          color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.4,
        }}>
          {err}
        </div>
      )}

      {confirming && (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 20, zIndex: 1000,
        }}>
          <div style={{
            maxWidth: 420, width: "100%", padding: 20, borderRadius: T.r,
            background: T.card, border: `1px solid ${T.border}`,
          }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: T.text, fontFamily: T.mono, letterSpacing: 1, marginBottom: 12 }}>
              {t("chat.confirmRouteSwitch")}
            </div>
            <div style={{ fontSize: 13, color: T.text, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 16 }}>
              {t("chat.switchFromBefore")}<strong>{fedimint.federationName}</strong>{t("chat.switchFromJoin")}
              <strong>{confirming.name}</strong>{t("chat.switchFromAfter")}
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 16 }}>
              {t(isSimModeOn() ? "chat.switchWipeWarning" : "chat.switchKeepWarning")}
            </div>
            {!isListedFederationInvite(confirming.invite) && (
              <div data-federation-warning="unlisted" style={{ fontSize: 13, color: T.amber, fontFamily: T.sans, lineHeight: 1.55, marginBottom: 16 }}>
                {t("app.unlistedFedBody")}
              </div>
            )}

            {err && (
              <div style={{
                marginBottom: 16, padding: 10, borderRadius: T.rs,
                background: T.redDim, border: `1px solid ${T.red}44`,
                color: T.red, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
              }}>
                {err}
                {refusalCode === "balance" && (
                  <div style={{ marginTop: 8, color: T.amber }}>
                    {t("chat.destroyOverrideBefore")}<strong>{t("chat.destroyOverrideBold")}</strong>{t("chat.destroyOverrideAfter")}
                  </div>
                )}
                {heldBack && refusalCode !== "balance" && (
                  <div style={{ marginTop: 8, color: T.amber }}>{t("chat.switchSendOutFirst")}</div>
                )}
              </div>
            )}

            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => { setConfirming(null); setErr(null); setErrCode(null); }}
                disabled={busy}
                style={{
                  flex: 1, padding: "10px 14px", borderRadius: T.rs,
                  background: T.surface, border: `1px solid ${T.border}`,
                  color: T.text, fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => doSwitch(confirming, refusalCode === "balance")}
                disabled={busy}
                style={{
                  flex: 1, padding: "10px 14px", borderRadius: T.rs,
                  background: refusalCode === "balance" ? T.red : T.accent,
                  border: "none",
                  color: refusalCode === "balance" ? "#fff" : T.onInk,
                  fontFamily: T.mono, fontSize: 12, fontWeight: 700,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                {busy ? t("chat.switching")
                  : refusalCode === "balance" ? t("chat.switchAndDestroy")
                  : t("chat.switchRouteBtn")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
