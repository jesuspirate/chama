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

// The status subscription uses the same wire states as the simulator and owns
// every timer it creates, including when cleanup races an in-flight response.
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map<number, { fn: () => void; delay: number }>();
let timerId = 0;
globalThis.setTimeout = ((fn: () => void, delay: number) => { timers.set(++timerId,{fn,delay}); return timerId; }) as any;
globalThis.clearTimeout = ((id: number) => timers.delete(id)) as any;
const flush = async () => { for(let n=0;n<30;n++) await Promise.resolve(); };
try {
 let nextStatus = 'waiting'; let requests = 0;
 globalThis.fetch = async () => { requests++; return new Response(JSON.stringify({status:nextStatus,btcDeposited:2000,outpoint:'tx:0'}),{headers:{'content-type':'application/json'}}); };
 const wallet = createNativeBridgeWallet('http://127.0.0.1:8173');
 const seen: string[]=[];
 const unsubscribe=wallet.onchain!.subscribeDeposit!('test',p=>{seen.push(p.status);assert.equal(p.confirmations,undefined);});
 await flush();
 for(const status of ['seen','confirmed','claimed']) {
  nextStatus=status;
  const entry=[...timers].find(([,t])=>t.delay===3000);assert.ok(entry);
  timers.delete(entry[0]);entry[1].fn();await flush();
 }
 assert.deepEqual(seen,['waiting','seen','confirmed','claimed']);assert.equal(timers.size,0);
 unsubscribe();
 nextStatus='waiting';
 const stop=wallet.onchain!.subscribeDeposit!('another',()=>{});await flush();stop();assert.equal(timers.size,0);
 wallet.onchain!.subscribeDeposit!('cleanup',()=>{});await flush();await wallet.cleanup();assert.equal(timers.size,0);
 let resolveResponse!: (value:Response)=>void;
 globalThis.fetch=()=>new Promise(resolve=>{resolveResponse=resolve;});
 let lateCallbacks=0;
 wallet.onchain!.subscribeDeposit!('in-flight',()=>lateCallbacks++);
 await wallet.cleanup();
 resolveResponse(new Response(JSON.stringify({status:'seen'}),{headers:{'content-type':'application/json'}}));await flush();
 assert.equal(lateCallbacks,0);assert.equal(timers.size,0);
 assert.ok(requests>=6);
 console.log('PASS native deposit progress: shared wire states, terminal stop, unsubscribe and cleanup');
} finally {
 globalThis.fetch=originalFetch;globalThis.setTimeout=originalSetTimeout;globalThis.clearTimeout=originalClearTimeout;
}
