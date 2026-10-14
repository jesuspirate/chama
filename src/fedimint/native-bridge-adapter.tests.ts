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

// Public inspection is callable without opening or joining a wallet and uses
// the bridge's camelCase request schema, like its existing join endpoint.
const inspectFetch = globalThis.fetch;
try {
  const requests: Array<{ url: string; body: any }> = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ federationId: "f".repeat(64), config: { global: {} }, metaStatus: "absent" }), { headers: { "content-type": "application/json" } });
  };
  const reader = createNativeBridgeWallet("http://127.0.0.1:8787");
  const info = await reader.federation.inspectInvite!("fed1public-inspection");
  assert.equal(info.federationId, "f".repeat(64));
  assert.deepEqual(requests, [{ url: "http://127.0.0.1:8787/federation-preview", body: { inviteCode: "fed1public-inspection" } }]);
  assert.equal(reader.isOpen(), false);
} finally { globalThis.fetch = inspectFetch; }
console.info("✓ native public preview does not open a wallet");
// A link must never choose where the wallet lives outside a dev build.
{
  const { getNativeBridgeUrl, isNativeBridgeModeOn, DEFAULT_NATIVE_BRIDGE_URL } = await import("./native-bridge-adapter.js");
  clearNativeBridgeConfig();
  const originalWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { href: "https://getchama.app/?nativeFedimint=1&nativeFedimintUrl=https://evil.example" } },
  });
  try {
    assert.equal(getNativeBridgeUrl(), DEFAULT_NATIVE_BRIDGE_URL, "query URL is ignored in production");
    assert.equal(isNativeBridgeModeOn(), false, "query flag cannot switch on bridge mode in production");
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  }
  console.log("PASS crafted links cannot repoint the wallet bridge");
}

{
  // Jet (6.4.23-rc.5, Pixel 8): the first launch after an update opened the
  // wallet before the app's own bridge was listening and showed "Native Fedimint
  // bridge is enabled but unreachable". In an app shell, opening, joining and
  // switching now wait through "connection refused" like every spend does.
  clearNativeBridgeConfig();
  values.set(NATIVE_BRIDGE_MODE_KEY, "1");
  const originalCapacitor = (globalThis as { Capacitor?: unknown }).Capacitor;
  const healthy = () => new Response(JSON.stringify({
    ok: true, joined: true, api_version: 3,
    capabilities: ["reset", "idempotent_join", "effective_iroh_config"],
  }), { status: 200 });
  const paths: string[] = [];
  let refusals = 2;
  globalThis.fetch = (async (url: unknown) => {
    const path = new URL(String(url)).pathname;
    paths.push(path);
    if (path === "/health") {
      if (refusals > 0) { refusals--; throw new TypeError("Failed to fetch"); }
      return healthy();
    }
    if (path === "/info") {
      return new Response(JSON.stringify({ federation_id: "fed-1", network: "bitcoin", total_amount_msat: 21_000, meta: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as typeof fetch;
  try {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const wallet = createNativeBridgeWallet("http://127.0.0.1:8787");
    await wallet.open();
    assert.deepEqual(paths, ["/health", "/health", "/health", "/info"],
      "open waits for the shell's bridge to start listening, then opens the wallet");
    assert.equal(wallet.isOpen(), true);

    // Jet (6.4.25, Pixel 8): "Your wallet didn't answer in time" on opening.
    // A bridge that is listening but too busy to answer /health within 5 s
    // is still starting too: wait and ask again, instead of failing at once.
    paths.length = 0;
    let slow = 1;
    globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      if (path === "/health" && slow > 0) {
        slow--;
        return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      if (path === "/health") return healthy();
      return new Response(JSON.stringify({ federation_id: "fed-1", network: "bitcoin", total_amount_msat: 21_000, meta: {} }), { status: 200 });
    }) as typeof fetch;
    // Loading @capacitor/core during the first open replaces the stub; set it again.
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const busy = createNativeBridgeWallet("http://127.0.0.1:8787");
    await busy.open();
    assert.deepEqual(paths, ["/health", "/health", "/info"], "a slow /health while starting is asked again, then the wallet opens");
    assert.equal(busy.isOpen(), true);

    // The first /info after start-up opens the wallet inside the bridge and
    // can run past its limit too: asked again, not reported as a failure.
    // (Timers over 4 s fire after 5 ms here so the limits can be exercised.)
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, ms?: number) => realSetTimeout(fn, (ms ?? 0) > 4000 ? 5 : ms)) as typeof setTimeout;
    try {
      paths.length = 0;
      let slowInfo = 2;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/info" && slowInfo > 0) {
          slowInfo--;
          return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
        }
        if (path === "/health") return healthy();
        return new Response(JSON.stringify({ federation_id: "fed-1", network: "bitcoin", total_amount_msat: 21_000, meta: {} }), { status: 200 });
      }) as typeof fetch;
      const opening = createNativeBridgeWallet("http://127.0.0.1:8787");
      await opening.open();
      assert.deepEqual(paths, ["/health", "/info", "/info", "/info"], "two slow /info answers are asked again; the third opens the wallet");
      assert.equal(opening.isOpen(), true);

      // Still no answer after every try: then, and only then, it is reported.
      paths.length = 0;
      globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path === "/health") return healthy();
        return await new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }) as typeof fetch;
      await assert.rejects(createNativeBridgeWallet("http://127.0.0.1:8787").open(), /native_fedimint_bridge_timeout/);
      assert.deepEqual(paths, ["/health", "/info", "/info", "/info"]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // A bridge that answers but is incompatible is not "still starting": no wait.
    paths.length = 0;
    globalThis.fetch = (async (url: unknown) => {
      paths.push(new URL(String(url)).pathname);
      return new Response(JSON.stringify({ ok: false }), { status: 200 });
    }) as typeof fetch;
    await assert.rejects(createNativeBridgeWallet("http://127.0.0.1:8787").open(), /native_fedimint_bridge_incompatible/);
    assert.deepEqual(paths, ["/health"], "an incompatible bridge fails at once, without retries");

    // A bridge the user runs themselves (no app shell) is checked once.
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    paths.length = 0;
    globalThis.fetch = (async (url: unknown) => {
      paths.push(new URL(String(url)).pathname);
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await assert.rejects(createNativeBridgeWallet("http://127.0.0.1:8787").open(), /native_fedimint_bridge_unavailable/);
    assert.deepEqual(paths, ["/health"], "outside an app shell an unreachable bridge is reported at once");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCapacitor === undefined) delete (globalThis as { Capacitor?: unknown }).Capacitor;
    else (globalThis as { Capacitor?: unknown }).Capacitor = originalCapacitor;
    values.delete(NATIVE_BRIDGE_MODE_KEY);
  }
  console.log("PASS app-shell wallet open waits for its bridge to start (refused, slow /health, slow first /info); reports only a real failure; other failures stay immediate");
}
