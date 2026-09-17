import assert from "node:assert/strict";
import { saveNsecWithNotice, SAVED_NSEC_KEY, NSEC_ORIGIN_KEY, NSEC_KEEP_NOTICE_KEY } from "./saved-nsec.js";
const data = new Map<string, string>();
const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
await saveNsecWithNotice("test-key", "generated", storage);
assert.equal(data.get(SAVED_NSEC_KEY), "test-key");
assert.equal(data.get(NSEC_ORIGIN_KEY), "generated");
assert.equal(data.get(NSEC_KEEP_NOTICE_KEY), "pending");
data.set(NSEC_KEEP_NOTICE_KEY, "done");
await saveNsecWithNotice("other-test-key", "imported", storage);
assert.equal(data.get(NSEC_KEEP_NOTICE_KEY), "done", "normal sign-in does not repeat an acknowledged notice");
data.clear();
await assert.rejects(saveNsecWithNotice("test-key", "generated", {
  getItem: storage.getItem,
  setItem: (key, value) => { if (key === SAVED_NSEC_KEY) throw new Error("storage blocked"); storage.setItem(key, value); },
}));
assert.equal(data.get(NSEC_KEEP_NOTICE_KEY), undefined, "failed browser save must not claim the key was saved");
await assert.rejects(saveNsecWithNotice("test-key", "imported", storage, { set: async () => { throw new Error("native write failed"); } }));
assert.equal(data.get(NSEC_KEEP_NOTICE_KEY), undefined, "failed native save must not arm the notice");
const native = new Map<string, string>();
await saveNsecWithNotice("native-test-key", "imported", storage, { set: async ({ key, value }) => { native.set(key, value); } });
assert.equal(native.get(SAVED_NSEC_KEY), "native-test-key");
assert.equal(data.get(SAVED_NSEC_KEY), undefined, "native secrets must not be copied into browser storage");
assert.equal(data.get(NSEC_KEEP_NOTICE_KEY), "pending");
console.log("Saved-key persistence and failed-write notice regressions passed.");
