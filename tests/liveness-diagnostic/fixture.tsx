// Public read only, on a dedicated localhost origin. No signing, wallet or funding.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { useEscrow } from "../../src/hooks/useEscrow";
import { LangProvider } from "../../src/i18n";
import { LivenessSignal } from "../../src/ui/components/LivenessSignal";
import { getLivenessDiagnostics, loadCoordinatedLiveness, readCachedLiveness } from "../../src/arbiters/liveness-coordinator";
import { applyThemeMode } from "../../src/ui/theme";
applyThemeMode("light");
const w = window as any;
const key = getPublicKey(generateSecretKey()); // Discard the unused secret immediately.
const refuse = async () => { throw new Error("Diagnostic identity cannot sign or decrypt"); };
w.__chama_nip46_signer = { requiresUserAction: true, getPublicKey: async () => key, signEvent: refuse, nip44Encrypt: refuse, nip44Decrypt: refuse };
function Diagnostic() {
 const [state, actions] = useEscrow();
 const [result, setResult] = useState<any>(null), [loading, setLoading] = useState(false);
 const community = new URLSearchParams(location.search).get("community") ?? "us-blf";
 w.diagnosticState = { pubkey: state.pubkey, connected: state.connected, relays: [...state.relayStatuses], initialized: state.fedimint.initialized, joined: state.fedimint.joined };
 w.captureDiagnostics = () => ({ community, cacheBefore: w.cacheBefore ?? null, result: w.result ?? null, diagnostics: getLivenessDiagnostics(), state: w.diagnosticState, errors: w.errors ?? [] });
 w.runLiveness = async () => {
  w.cacheBefore = readCachedLiveness(community); setLoading(true);
  const r = await loadCoordinatedLiveness(community, async (slug, signal) => {
   try { return await actions.getChamaLiveness(slug, signal); }
   catch (e) { (w.errors ??= []).push(String(e)); throw e; }
  });
  w.result = r; setResult(r); setLoading(false);
  return w.captureDiagnostics();
 };
 useEffect(() => { void actions.connect(); return () => actions.disconnect(); }, []);
 return <main style={{ maxWidth: 390, margin: "auto", padding: 16 }}><h2>Fresh identity · public liveness</h2><p>{community}</p>
 <button type="button" disabled={!state.connected || loading} onClick={() => void w.runLiveness()}>Read public liveness</button>
 <LivenessSignal liveness={result?.liveness ?? null} outcome={result?.outcome} loading={loading} />
 <pre style={{ whiteSpace: "pre-wrap", fontSize: 11 }}>{JSON.stringify(w.captureDiagnostics(), (_, value) => typeof value === "bigint" ? value.toString() : value, 2)}</pre></main>;
}
createRoot(document.getElementById("root")!).render(<LangProvider><Diagnostic /></LangProvider>);
