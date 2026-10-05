import assert from "node:assert/strict";
import { WalletDirector } from "@fedimint/core";
import { Transport, type TransportRequest } from "@fedimint/types";
import { createJoinErrorCapture, joinErrorDetail } from "./join-error-capture.js";
import { adaptRealWallet, type RealFedimintWallet } from "./sdk-adapter.js";
import { BLF_FEDERATION_INVITE } from "./federation-invites.js";
import { FedimintClient } from "./fedimint-client.js";
import { fundingDiagnostics } from "../payments/funding-diagnostics.js";
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
 getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key),
}});
const lines: unknown[][] = [];
const capture = createJoinErrorCapture([], { debug() {}, info() {}, warn() {}, error: (...args: unknown[]) => lines.push(args) });
class TestTransport extends Transport {
 logger = capture.logger;
 error: unknown = { message: "Client already exists in database", code: "AlreadyExists" };
 requests: TransportRequest[] = [];
 postMessage(request: TransportRequest) {
   this.requests.push(request);
   this.messageHandler({ type: "data", request_id: request.requestId,
     ...(request.type === "join_federation" && this.error ? { error: this.error }
       : request.type === "open_client" ? { error: "Client database not initialized" } : { data: null }) });
 }
}
const transport = new TestTransport(), director = new WalletDirector(transport, "test.db", true);
director.setLogLevel("error");
const sdk = await director.createWallet();
const wallet = adaptRealWallet(sdk as unknown as RealFedimintWallet, undefined, undefined, false, undefined, false, capture);
await assert.rejects(wallet.open(), cause => cause === "Client database not initialized", "open classification remains untouched");
await assert.rejects(wallet.joinFederation(BLF_FEDERATION_INVITE), /did not join the federation:.*Client already exists/);
assert.match(JSON.stringify(lines), /Error joining federation.*Client already exists/);
assert.match(JSON.stringify(fundingDiagnostics().at(-1)), /fedimint_join_failed.*Client already exists/);
assert.equal(transport.requests.filter(r => r.type === "join_federation").length, 1, "reporting sends the same single join RPC");
assert.equal(transport.requests.some(r => /parse_invite|preview_federation/.test(r.type)), false, "no diagnostic guardian probes");
transport.error = "TLS handshake failed";
await assert.rejects(wallet.joinFederation(BLF_FEDERATION_INVITE), /TLS handshake failed/);
assert.doesNotMatch(String(fundingDiagnostics().at(-1)?.error), /AlreadyExists/);
const forced = adaptRealWallet(sdk as unknown as RealFedimintWallet, undefined, undefined, true, undefined, true, capture);
await assert.rejects(forced.joinFederation(BLF_FEDERATION_INVITE), /did not start forced wallet recovery: TLS handshake failed/);
assert.equal((transport.requests.at(-1)!.payload as { force_recover: boolean }).force_recover, true);
const blocked = adaptRealWallet(sdk as unknown as RealFedimintWallet, undefined, undefined, true, undefined, false, capture);
const before = transport.requests.length;
await assert.rejects(blocked.joinFederation(BLF_FEDERATION_INVITE), /did not run recovery during boot/);
assert.equal(transport.requests.length, before, "reporting never bypasses explicit recovery permission");
// The existing client/hook/toast path receives Error.message without a UI patch.
const client = new FedimintClient({}, async () => wallet);
await client.init();
await assert.rejects(client.joinFederation(BLF_FEDERATION_INVITE), error => {
  assert.ok(error instanceof Error, "existing toast catch receives Error.message");
  assert.match(error.message, /TLS handshake failed/);
  return true;
});
transport.error = null;
const ok = await director.createWallet();
assert.equal(await ok.joinFederation(BLF_FEDERATION_INVITE), true);
const alreadyOpen = adaptRealWallet(ok as unknown as RealFedimintWallet, undefined, undefined, false, undefined, false, capture);
await assert.rejects(alreadyOpen.joinFederation(BLF_FEDERATION_INVITE), /already open/);
assert.match(String(fundingDiagnostics().at(-1)?.sdkError), /already open/);
capture.reset(); assert.match(capture.failure("failed").message, /SDK supplied no error detail/);
const secret = "alpha beta gamma delta";
const safe = joinErrorDetail({ message: `failed ${secret} nsec1abcdef https://name:password@example.test/?token=secret`, mnemonic: secret, notes: "bearer cash" }, [secret]);
assert.doesNotMatch(safe, /alpha|nsec1abcdef|password|token=secret|bearer cash/);
assert.equal(joinErrorDetail("x".repeat(5000)).length, 2000);
const cyclic: any = {}; cyclic.cause = cyclic; assert.equal(joinErrorDetail(cyclic), "");
console.log("Join error capture: installed SDK exception, breadcrumbs, retry isolation, unchanged join/recovery/open and secret redaction passed");
