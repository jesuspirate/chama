import assert from "node:assert/strict";
import { WalletDirector } from "@fedimint/core";
import { Transport, type TransportRequest } from "@fedimint/types";
import { createJoinDiagnostics, joinErrorDetail } from "./join-diagnostics.js";
import { adaptRealWallet, type RealFedimintWallet } from "./sdk-adapter.js";
import { FedimintClient } from "./fedimint-client.js";
import { BLF_FEDERATION_ID, BLF_FEDERATION_INVITE, AFRIBIT_KIBERA_FEDERATION_INVITE } from "./federation-invites.js";
import { fundingDiagnostics } from "../payments/funding-diagnostics.js";
import { waitForFundingWallet } from "../payments/funding-wallet-ready.js";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
}});
const consoleLines: unknown[][] = [];
const quiet = { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => consoleLines.push(args) };
const capture = createJoinDiagnostics([], quiet);
class TestTransport extends Transport {
  logger = capture.logger;
  joinError: unknown = { message: "Client already exists in database", code: "AlreadyExists" };
  openError: unknown = "Client database not initialized";
  requests: TransportRequest[] = [];
  postMessage(request: TransportRequest) {
    this.requests.push(request);
    this.messageHandler({ type: "data", request_id: request.requestId,
      ...(request.type === "join_federation" ? { error: this.joinError }
        : request.type === "open_client" && this.openError ? { error: this.openError } : { data: null }) });
  }
}
const transport = new TestTransport();
const director = new WalletDirector(transport, "test.db", true);
director.setLogLevel("error");
const sdkWallet = await director.createWallet();
const previewCalls: string[] = [];
const preview = {
  async parseInviteCode() { previewCalls.push("parse"); return { url: "wss://guardian.example:8443/api" }; },
  async previewFederation() { previewCalls.push("preview"); throw new Error("WebSocket connection failed"); },
};
const wallet = adaptRealWallet(sdkWallet as unknown as RealFedimintWallet,
  undefined, undefined, false, undefined, false, { capture, director: preview });
await assert.rejects(wallet.open(), error => error === "Client database not initialized",
  "Logging must preserve the open rejection used to classify a fresh database");
await assert.rejects(wallet.joinFederation(BLF_FEDERATION_INVITE), error => {
  assert.ok(error instanceof Error);
  assert.match(error.message, /Client already exists in database/);
  assert.match(error.message, /wss:\/\/guardian.example:8443/);
  assert.match(error.message, /WebSocket connection failed/);
  return true;
});
assert.deepEqual(previewCalls, ["parse", "preview"]);
assert.equal(transport.requests.filter(r => r.type === "join_federation").length, 1, "Preview failure does not prevent or retry the original join");
assert.match(JSON.stringify(consoleLines), /Error joining federation.*Client already exists/);
assert.match(JSON.stringify(fundingDiagnostics()), /fedimint_join_failed.*Client already exists/);
assert.equal(fundingDiagnostics().at(-1)!.openState, "failed");
assert.equal(fundingDiagnostics().at(-1)!.openError, "Client database not initialized");
transport.joinError = "TLS handshake failed";
await assert.rejects(wallet.joinFederation(BLF_FEDERATION_INVITE), /TLS handshake failed/);
assert.ok(!fundingDiagnostics().at(-1)!.error?.toString().includes("AlreadyExists"), "Retry forgets previous SDK error");
const forced = adaptRealWallet(sdkWallet as unknown as RealFedimintWallet,
  undefined, undefined, true, undefined, true, { capture, director: preview });
await assert.rejects(forced.joinFederation(BLF_FEDERATION_INVITE), /did not start forced wallet recovery: TLS handshake failed/);
assert.equal((transport.requests.at(-1)!.payload as { force_recover: boolean }).force_recover, true);
const callsBeforeBlockedRecovery = previewCalls.length;
const blockedRecovery = adaptRealWallet(sdkWallet as unknown as RealFedimintWallet,
  undefined, undefined, true, undefined, false, { capture, director: preview });
await assert.rejects(blockedRecovery.joinFederation(BLF_FEDERATION_INVITE), /did not run recovery during boot/);
assert.equal(previewCalls.length, callsBeforeBlockedRecovery, "Diagnostics do not bypass recovery permission");
// An already-open SDK wallet throws before its catch/logger. Preserve that
// diagnostic as well and never dispatch another join_federation RPC.
transport.openError = null;
await sdkWallet.open();
const joinCountBefore = transport.requests.filter(r => r.type === "join_federation").length;
await assert.rejects(wallet.joinFederation(BLF_FEDERATION_INVITE), /already open/);
assert.equal(transport.requests.filter(r => r.type === "join_federation").length, joinCountBefore);
assert.match(String(fundingDiagnostics().at(-1)!.sdkError), /already open/);
capture.reset();
assert.match(capture.failure("failed").message, /SDK supplied no error detail/);
const secret = "alpha beta gamma delta";
const safe = joinErrorDetail({ message: `failed ${secret} nsec1abcdef https://name:password@example.test/?token=secret`, notes: "bearer cash", mnemonic: secret }, [secret]);
assert.ok(!/alpha|nsec1abcdef|password|token=secret|bearer cash/.test(safe));
assert.equal(joinErrorDetail("x".repeat(5000)).length, 2000);
const cyclic: any = {}; cyclic.cause = cyclic;
assert.equal(joinErrorDetail(cyclic), "");
const pending = new Promise<never>(() => {});
assert.match((await capture.preview({ ...preview, previewFederation: () => pending }, "invite", 5)).error!, /timed out/);
assert.match((await capture.preview({ ...preview, parseInviteCode: async () => { throw "Bad invite"; } }, "bad")).error!, /Could not parse.*Bad invite/);
assert.deepEqual(await capture.preview({ ...preview, previewFederation: async () => ({}) }, "valid"), {});
let completeParse!: (value: { url: string }) => void;
let latePreviewCalls = 0;
await capture.preview({ parseInviteCode: () => new Promise(resolve => { completeParse = resolve; }),
  previewFederation: async () => { latePreviewCalls++; } }, "late", 5);
completeParse({ url: "wss://guardian.example" });
await Promise.resolve();
assert.equal(latePreviewCalls, 0, "A timed-out parse cannot start another probe later");

// Actual FedimintClient lifecycle, with a wallet standing in for persisted OPFS.
for (const state of ["matching", "empty", "different", "unreadable"] as const) {
  let opened = false;
  let opens = 0;
  let joins = 0;
  const stub = {
    async open() { opens++; if (state === "empty") throw new Error("Client database not initialized"); if (state === "unreadable") throw new Error("OPFS read failed"); opened = true; },
    isOpen: () => opened,
    async joinFederation() { joins++; opened = true; },
    balance: { getBalance: async () => 0, subscribeBalance: () => () => {} },
    federation: { getFederationId: async () => BLF_FEDERATION_ID, getInviteCode: async () => BLF_FEDERATION_INVITE },
    recovery: { hasPendingRecoveries: async () => false, waitForAllRecoveries: async () => {} },
    mint: {}, lightning: {}, cleanup: async () => {},
  };
  const client = new FedimintClient({}, async () => stub as any);
  if (state === "unreadable") await assert.rejects(client.init(), /OPFS read failed/);
  else {
    await client.init();
    if (state === "different") await assert.rejects(client.joinFederation(AFRIBIT_KIBERA_FEDERATION_INVITE), /wallet belongs to a different federation/);
    else assert.equal(await client.joinFederation(BLF_FEDERATION_INVITE), BLF_FEDERATION_ID);
  }
  assert.equal(opens, 1);
  assert.equal(joins, state === "empty" ? 1 : 0, `${state}: only a confirmed empty wallet joins`);
  await client.cleanup();
}
// A failed startup ends the waiting phase immediately with the original text.
let checks = 0;
const readyOptions = { isReady: () => false, joinFailure: () => ++checks >= 2 ? "SDK join: stale client" : null, nudge() {}, waitMs: 1000, pollMs: 1 };
await assert.rejects(waitForFundingWallet(readyOptions), /SDK join: stale client/);
assert.equal(checks, 2, "Stop waiting on the first observed failure");
assert.equal(await waitForFundingWallet({ ...readyOptions, isReady: () => true }), true);
assert.equal(await waitForFundingWallet({ ...readyOptions, joinFailure: () => null, waitMs: 2 }), false);
console.log("Join diagnostics: installed SDK logger, preserved errors/breadcrumbs, bounded read-only preview, open/join/mismatch/unreadable, and failed funding startup passed.");
