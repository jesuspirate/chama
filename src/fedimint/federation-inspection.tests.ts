import assert from "node:assert/strict";
import { federationFacts, publicShareLimit, type FederationInspection } from "./federation-inspection.js";
import { CURATED_PRESETS } from "./federation-config.js";
const host = "ab".repeat(32);
const inspect = (urls: string[], meta: Record<string, unknown> = {}): FederationInspection => ({ federationId: "cd".repeat(32), metaStatus: "ready", consensusMeta: { revision: 1, value: meta }, config: { global: { meta: { federation_name: "Test mint" }, api_endpoints: Object.fromEntries(urls.map((url, i) => [i, { url }])), broadcast_public_keys: {} } } });
const independent = ["wss://a.example.com", "wss://b.example.org", "wss://c.example.net", "wss://d.example.co.uk"];
const normal = inspect(independent);
assert.equal(federationFacts(CURATED_PRESETS[0].inviteCode, normal).curated, true);
assert.equal(federationFacts("fed1custom", normal).curated, false);
assert.equal(federationFacts("fed1custom", normal).singleOperator, false);
assert.equal(federationFacts("", inspect(independent.slice(0, 3))).singleOperator, true);
for (const endpoints of [
  ["wss://one.test:443/a", "wss://one.test:444/b", "https://one.test/c", "wss://one.test/d"],
  ["wss://a.host.co.uk", "wss://b.host.co.uk", "wss://c.host.co.uk", "wss://d.host.co.uk"],
  Array(4).fill("wss://127.0.0.1:443"), Array(4).fill("wss://[::1]:443"),
]) assert.equal(federationFacts("", inspect(endpoints)).singleOperator, true);
assert.equal(federationFacts("", inspect(["wss://a.github.io", "wss://b.github.io", "wss://c.github.io", "wss://d.github.io"])).singleOperator, false);
assert.equal(federationFacts("", inspect([1,2,3,4].map(n => `iroh://${String(n).repeat(64)}`))).singleOperator, false, "a relay is not a guardian host");
const keys = structuredClone(normal); (keys.config as any).global.broadcast_public_keys[0] = "02" + host;
assert.equal(federationFacts("", keys, host).singleOperator, true);
assert.equal(federationFacts("", null).guardians, null);
assert.equal(federationFacts("", null).singleOperator, false, "unknown is not zero guardians");
const withMeta = (meta: Record<string, unknown>) => inspect(independent, meta);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "100000000", "fedi:max_balance_msats": "250000000" }), 5), 50000);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": 1000000, "fedi:max_balance_msats": "250000000" }), 5), 1000);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "1000999" }), null), 1000);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "1000000", "fedi:max_balance_msats": "250000000" }), null), null, "unlimited seats cannot prove payout fits balance");
for (const bad of [undefined, null, "", "0", 0, -1, "-1", "1e6", 1.5, Number.MAX_SAFE_INTEGER + 1, {}, true]) {
  assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": bad }), 5), null);
  assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "1000000", "fedi:max_balance_msats": bad }), 5), null);
}
assert.equal(publicShareLimit({ ...withMeta({ "fedi:max_invoice_msats": "1000000" }), metaStatus: "unavailable" }, 5), null);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "1000000", "fedi:max_balance_msats": "1" }), 5), 0);
assert.equal(publicShareLimit(withMeta({ "fedi:max_invoice_msats": "1000000", "fedi:max_balance_msats": "1" }), 0), null);
console.log("PASS federation custody signals, public-suffix/IP/iroh cases, unknown configuration, safe share ceilings");

// Integration seam: existing wallet reads stay on that wallet; inspecting a
// different federation previews public config, never opens/joins/switches.
const { adaptRealWallet } = await import("./sdk-adapter.js");
const { createJoinDiagnostics } = await import("./join-diagnostics.js");
const calls: string[] = [];
let failMeta = false;
const localConfig = { ...(normal.config as object), modules: { 5: { kind: "meta" } } };
const real = {
  isOpen: () => true,
  open: async () => { throw new Error("must not open"); },
  joinFederation: async () => { throw new Error("must not join"); },
  federation: {
    getFederationId: async () => normal.federationId,
    getConfig: async () => { calls.push("config"); return localConfig; },
    getMetaConsensusValue: async () => { calls.push("meta"); if (failMeta) throw new Error("offline"); return { revision: 1, value: { "fedi:max_invoice_msats": "1000000" } }; },
  },
};
const foreignId = "ef".repeat(32);
const adapter = adaptRealWallet(real as any, undefined, undefined, false, undefined, false, {
  capture: createJoinDiagnostics(),
  director: {
    parseInviteCode: async invite => ({ url: "wss://example.test", federation_id: invite === "local" ? normal.federationId : foreignId }),
    previewFederation: async () => { calls.push("preview"); return { federation_id: foreignId, config: localConfig }; },
  },
});
const active = await adapter.federation.inspectInvite!("local");
assert.deepEqual(calls.splice(0), ["config", "meta"]);
assert.equal(publicShareLimit(active, 5), 1000);
const foreign = await adapter.federation.inspectInvite!("foreign");
assert.deepEqual(calls.splice(0), ["preview"]);
assert.equal(foreign.federationId, foreignId);
assert.equal(foreign.metaStatus, "unavailable", "public preview cannot claim consensus limits it did not read");
failMeta = true;
assert.equal((await adapter.federation.inspectInvite!("local")).metaStatus, "unavailable");
console.log("PASS read-only active/foreign inspection and failed consensus read");

assert.equal(federationFacts("", inspect(Array(4).fill(`iroh://${"1".repeat(64)}`))).singleOperator, true, "repeating one node identity is a common-host signal");
const { createSimWallet } = await import("../sim/sim-wallet.js");
const sim = await createSimWallet({ npub: null });
const simulationInfo = await sim.federation.inspectInvite!("fed1sim");
assert.equal(simulationInfo.federationId.startsWith("sim_fed_"), true);
assert.equal(publicShareLimit(simulationInfo, 5), 100000);
await sim.cleanup();
console.log("PASS simulation inspection uses only explicit synthetic metadata");

for (const bad of ["invalid JSON", "[]", "false", 42, []]) {
  const stale = withMeta({});
  (stale.config as any).global.meta["fedi:max_invoice_msats"] = "100000000";
  stale.consensusMeta = { revision: 2, value: bad };
  assert.equal(publicShareLimit(stale, 5), null, "malformed consensus must not silently revive a static ceiling");
}
