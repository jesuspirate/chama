import assert from "node:assert/strict";
import { saveNsec, SAVED_NSEC_KEY, NSEC_ORIGIN_KEY } from "./saved-nsec.js";
const data = new Map<string, string>();
const storage = { setItem: (key: string, value: string) => { data.set(key, value); } };
await saveNsec("test-key", "generated", storage);
assert.equal(data.get(SAVED_NSEC_KEY), "test-key");
assert.equal(data.get(NSEC_ORIGIN_KEY), "generated");
data.clear();
await assert.rejects(saveNsec("test-key", "generated", {
  setItem: (key, value) => { if (key === SAVED_NSEC_KEY) throw new Error("storage blocked"); storage.setItem(key, value); },
}), Error, "a blocked browser write must propagate — never claim the key was kept");
await assert.rejects(saveNsec("test-key", "imported", storage, { set: async () => { throw new Error("native write failed"); } }),
  Error, "a failed native write must propagate too");
const native = new Map<string, string>();
await saveNsec("native-test-key", "imported", storage, { set: async ({ key, value }) => { native.set(key, value); } });
assert.equal(native.get(SAVED_NSEC_KEY), "native-test-key");
assert.equal(native.get(NSEC_ORIGIN_KEY), "imported");
assert.equal(data.get(SAVED_NSEC_KEY), undefined, "native secrets must not be copied into browser storage");
console.log("Saved-key persistence regressions passed (checkbox era — no notice arming).");
