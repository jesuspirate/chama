import assert from "node:assert/strict";
import {
  NATIVE_BRIDGE_MODE_KEY,
  NATIVE_BRIDGE_TOKEN_KEY,
  NATIVE_BRIDGE_URL_KEY,
  REMOTE_BRIDGE_REVOKED_EVENT,
  REMOTE_BRIDGE_REVOKED_KEY,
  announceRemoteBridgeRevoked,
  clearNativeBridgeConfig,
  createNativeBridgeWallet,
  isBrowserRemoteBridgeMode,
  isNativeBridgeAuthFailure,
} from "./native-bridge-adapter.js";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, String(value)),
    removeItem: (key: string) => values.delete(key),
  },
});

values.set(NATIVE_BRIDGE_URL_KEY, "https://getchama.app/w/old-friend");
values.set(NATIVE_BRIDGE_TOKEN_KEY, "revoked-token");
values.set(NATIVE_BRIDGE_MODE_KEY, "1");
assert.equal(isBrowserRemoteBridgeMode(), true);

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(
  JSON.stringify({ error: "missing or invalid bridge auth token" }),
  { status: 401, headers: { "content-type": "application/json" } },
);

let rejected: unknown;
try {
  await createNativeBridgeWallet("https://getchama.app/w/old-friend").open();
} catch (error) {
  rejected = error;
}
assert.equal(isNativeBridgeAuthFailure(rejected), true);

clearNativeBridgeConfig();
assert.equal(values.has(NATIVE_BRIDGE_URL_KEY), false);
assert.equal(values.has(NATIVE_BRIDGE_TOKEN_KEY), false);
assert.equal(values.has(NATIVE_BRIDGE_MODE_KEY), false);
assert.equal(isBrowserRemoteBridgeMode(), false);

let revokeEvents = 0;
const revokeTarget = new EventTarget();
Object.defineProperty(globalThis, "dispatchEvent", {
  configurable: true,
  value: revokeTarget.dispatchEvent.bind(revokeTarget),
});
revokeTarget.addEventListener(REMOTE_BRIDGE_REVOKED_EVENT, () => { revokeEvents++; }, { once: true });
announceRemoteBridgeRevoked();
assert.equal(values.get(REMOTE_BRIDGE_REVOKED_KEY), "1");
assert.equal(revokeEvents, 1, "same-tab fallback is announced immediately");

globalThis.fetch = originalFetch;
console.info("✓ stale browser bridge authorization is recoverable");
