import assert from "node:assert/strict";

// Bundled twice by scripts/test-sandbox-build.mjs: once with
// __CHAMA_SANDBOX__ = false (dev / Android / Tauri / live web) and once with
// it true (the poc.getchama.app sandbox). The sandbox contract is that sim
// mode is on and nothing can switch it off.

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const { CHAMA_SANDBOX, SANDBOX_BUILD_MARKER } = await import("./sandbox-build.js");
const { isSimModeOn, setSimMode, simTagOrNull } = await import("./simMode.js");

assert.equal(SANDBOX_BUILD_MARKER, CHAMA_SANDBOX ? "chama-sandbox-build" : "",
  "deploy-sandbox.sh and release.sh grep bundles for this exact literal; only a sandbox build may carry it");

if (CHAMA_SANDBOX) {
  assert.equal(isSimModeOn(), true, "sandbox: sim mode is on without ?sim=1");
  setSimMode(false);
  assert.equal(isSimModeOn(), true, "sandbox: the entry-modal exit cannot leave sim");
  assert.equal(store.has("chama_sim_mode"), false, "sandbox: sim state is not a storage flag");
  assert.deepEqual(simTagOrNull(), ["chama-sim", "v1"], "sandbox: every event is sim-tagged");
  console.log("✓ sandbox build: sim mode forced on, exit ignored, events tagged");
} else {
  assert.equal(isSimModeOn(), false, "live: no URL flag means real mode");
  setSimMode(true);
  assert.equal(isSimModeOn(), true, "live: the URL/modal toggle still works");
  setSimMode(false);
  assert.equal(isSimModeOn(), false, "live: and still switches off");
  assert.equal(simTagOrNull(), null, "live: real events carry no sim tag");
  console.log("✓ live build: sim mode stays URL-driven");
}
