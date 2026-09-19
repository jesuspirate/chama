import assert from "node:assert/strict";

// A tiny localStorage stand-in: the module reads sim state through it.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const { worldScopedKey, SIM_KEY_SUFFIX } = await import("./sim-partition.js");
const { setSimMode } = await import("./simMode.js");

setSimMode(false);
assert.equal(worldScopedKey("chama_trade_index_v1"), "chama_trade_index_v1",
  "the real world keeps its key exactly — no migration, nothing lost");

setSimMode(true);
assert.equal(worldScopedKey("chama_trade_index_v1"), "chama_trade_index_v1" + SIM_KEY_SUFFIX,
  "the sandbox writes its history somewhere else entirely");
assert.notEqual(worldScopedKey("chama_escrow_ids:abc"), "chama_escrow_ids:abc",
  "the saved-id list partitions too, so prod never tries to reload a sim trade");

setSimMode(false);
assert.equal(worldScopedKey("chama_trade_index_v1"), "chama_trade_index_v1",
  "leaving the sandbox restores the real history untouched");

console.log("Sim/prod history partition regressions passed.");
