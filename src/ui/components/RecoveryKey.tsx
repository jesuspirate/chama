import { SettingsRow } from "./SettingsRow.js";
import { OverlaySheet } from "./OverlaySheet.js";
import { PaymentButton } from "./PaymentCard.js";
import { useEffect, useState } from "react";
import { getPublicKey } from "nostr-tools/pure";
import { nip19 } from "nostr-tools";
import { validateRecoveryKeyInput } from "../../escrow-engine/nsec-signer.js";
import { BACKUP_CHANGED, markRecoveryKeyBackedUp, recoveryKeyBackedUp } from "../../storage/recovery-key-backup.js";
import { copyTextConfirmed } from "./CopyButton.js";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

export function useRecoveryKeyBackup(pubkey: string) {
  const [saved, setSaved] = useState(() => recoveryKeyBackedUp(pubkey));
  useEffect(() => {
    const refresh = () => setSaved(recoveryKeyBackedUp(pubkey));
    refresh();
    window.addEventListener(BACKUP_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    return () => { window.removeEventListener(BACKUP_CHANGED, refresh); window.removeEventListener("storage", refresh); };
  }, [pubkey]);
  return saved;
}


export function RecoveryKeyActions({ nsec, pubkey, onSaved }: { nsec: string; pubkey: string; onSaved?: () => void }) {
  const buttonStyle = { padding: "10px 14px", borderRadius: 999, border: `1px solid ${T.border}`, background: T.surface, color: T.text, fontFamily: T.sans, cursor: "pointer" };
  const { t } = useT();
  const [result, setResult] = useState<"copied" | "saved" | "copyFailed" | "saveFailed" | null>(null);
  const [busy, setBusy] = useState(false);
  // No WebKit heuristic or POST of a private key. Only expose a real supported API.
  const canStore = typeof (globalThis as any).PasswordCredential === "function" && typeof navigator !== "undefined" && !!navigator.credentials?.store;
  const record = () => { markRecoveryKeyBackedUp(pubkey); onSaved?.(); };
  return <div>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <PaymentButton type="button" tier="raised" data-key-copy disabled={busy} style={buttonStyle} onClick={async () => {
        setBusy(true);
        const copied = await copyTextConfirmed(nsec);
        setResult(copied ? "copied" : "copyFailed");
        if (copied) record();
        setBusy(false);
      }}>{t(result === "copied" ? "chat.copiedKey" : "backup.copyKey")}</PaymentButton>
      {canStore && <PaymentButton type="button" data-key-save disabled={busy} style={buttonStyle} onClick={async () => {
        setBusy(true);
        try {
          await navigator.credentials.store(new (globalThis as any).PasswordCredential({ id: nip19.npubEncode(pubkey), name: "Chama", password: nsec }));
          record(); setResult("saved");
        } catch { setResult("saveFailed"); }
        finally { setBusy(false); }
      }}>{t(result === "saved" ? "backup.saved" : "backup.savePasswords")}</PaymentButton>}
    </div>
    {(result === "copyFailed" || result === "saveFailed") && <p role="alert" style={{ color: T.amber }}>{t(`backup.${result}`)}</p>}
  </div>;
}

export function RecoveryKeyBlock({ pubkey, loadKey, onSaved, onReady }: {
  pubkey: string; loadKey?: () => Promise<string | null>; onSaved?: () => void; onReady?: () => void;
}) {
  const { t } = useT();
  const [key, setKey] = useState<string | null>(null);
  const [message, setMessage] = useState("backup.reading");
  useEffect(() => {
    let active = true;
    const timer = setTimeout(() => { if (active) { active = false; setMessage("backup.readFailed"); onReady?.(); } }, 5000);
    (async () => {
      try {
        const raw = await loadKey?.();
        if (!active) return;
        if (!raw) { setMessage("backup.external"); return; }
        const checked = await validateRecoveryKeyInput(raw);
        if (!active) return;
        if (!checked.ok || getPublicKey(checked.secretKey).toLowerCase() !== pubkey.toLowerCase()) throw new Error("wrong identity");
        setKey(nip19.nsecEncode(checked.secretKey));
      } catch { if (active) setMessage("backup.readFailed"); }
      finally { if (active) { clearTimeout(timer); onReady?.(); } }
    })();
    return () => { active = false; clearTimeout(timer); };
  }, [pubkey, loadKey, onReady]);
  return <div style={{ margin: "12px 0", color: T.text }}>
    <p style={{ color: T.muted, fontSize: 13 }}>{t("backup.identityOnly")}</p>
    {key ? <><div data-recovery-key style={{ padding: 12, marginBottom: 12, background: T.bg, border: `1px solid ${T.border}`, borderRadius: T.rs, font: `12px ${T.mono}`, overflowWrap: "anywhere", userSelect: "text" }}>{key}</div><RecoveryKeyActions nsec={key} pubkey={pubkey} onSaved={onSaved} /></> : <p role="status">{t(message)}</p>}
  </div>;
}

export function RecoveryKeyReminder({ pubkey, loadKey }: { pubkey: string; loadKey?: () => Promise<string | null> }) {
  const { t } = useT();
  const saved = useRecoveryKeyBackup(pubkey);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  if (saved) return null;

  const copyKey = async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = Promise.race([
      (async () => {
        const raw = await loadKey?.();
        if (!raw) throw new Error("backup.external");
        const checked = await validateRecoveryKeyInput(raw);
        if (!checked.ok || getPublicKey(checked.secretKey).toLowerCase() !== pubkey.toLowerCase()) throw new Error("backup.readFailed");
        return nip19.nsecEncode(checked.secretKey);
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("backup.readFailed")), 5000); }),
    ]);
    try {
      let copied = false;
      // Start the write in the tap, before async signer export/validation.
      // WebKit requires this user gesture; ClipboardItem can await its data.
      // https://webkit.org/blog/10855/async-clipboard-api/
      if (typeof ClipboardItem === "function" && navigator.clipboard?.write) {
        const data = key.then(value => new Blob([value], { type: "text/plain" }));
        void data.catch(() => {});
        try { await navigator.clipboard.write([new ClipboardItem({ "text/plain": data })]); copied = true; }
        catch { copied = await copyTextConfirmed(await key); }
      } else {
        copied = await copyTextConfirmed(await key);
      }
      await key;
      if (copied) markRecoveryKeyBackedUp(pubkey);
      else setMessage("backup.copyFailed");
    } catch (e) {
      setMessage(e instanceof Error && e.message === "backup.external" ? "backup.external" : "backup.readFailed");
    } finally {
      clearTimeout(timer);
      setBusy(false);
    }
  };
  return <div data-recovery-reminder style={{ marginBottom: 16, padding: 16, borderRadius: T.r, border: `1px solid ${T.amber}`, background: T.amberDim, color: T.text, boxShadow: `0 0 12px ${T.amber}22` }}>
    <strong>{t("backup.managerQuestion")}</strong>
    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
      <PaymentButton type="button" data-key-confirm onClick={() => markRecoveryKeyBackedUp(pubkey)}>{t("backup.confirmSaved")}</PaymentButton>
      <PaymentButton type="button" data-key-reminder-copy disabled={busy} onClick={() => void copyKey()}>{t("backup.copyKey")}</PaymentButton>
    </div>
    {message && <p role="alert" style={{ color: T.amber, fontSize: 12 }}>{t(message)}</p>}
  </div>;
}

export function RecoveryKeyRow({ pubkey, loadKey }: { pubkey: string; loadKey?: () => Promise<string | null> }) {
  const { t } = useT();
  const saved = useRecoveryKeyBackup(pubkey);
  const [open, setOpen] = useState(false);
  return <>
    <SettingsRow label={t("backup.title")} hint={t(saved ? "backup.saved" : "backup.unsaved")}
      data-recovery-row data-key-reveal aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
    {open && <OverlaySheet title={t("backup.title")} onClose={() => setOpen(false)}>
      <RecoveryKeyBlock key={pubkey} pubkey={pubkey} loadKey={loadKey} />
    </OverlaySheet>}
  </>;
}
