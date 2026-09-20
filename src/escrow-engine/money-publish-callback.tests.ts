import assert from "node:assert/strict";
import { EscrowClient, type Signer } from "./escrow-client.js";
import { EscrowEventKind, type NostrEvent } from "./types.js";
import {
  defaultDurableMoneyPublishStore, enqueueDurableMoneyPublish, readDurableMoneyPublishes,
} from "./durable-money-publish.js";
import { recordPremiumSending, recordPremiumPaid, getPremiumOutboxRecord } from "../arbiters/arbiter-earnings.js";
import { getLocalStorageUserScope, setLocalStorageUserScope } from "../storage/user-scope.js";

// Exercise real RelayManager OK delivery, EscrowClient's callback, and the real
// payer ledger. Only storage and the websocket are replaced; no private client
// methods or acknowledgement helpers are called by the test.
class RelaySocket {
  static instances: RelaySocket[] = [];
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  constructor(public url: string) { RelaySocket.instances.push(this); }
  send(message: string) { this.sent.push(message); }
  close() {}
  ack(id: string) { this.onmessage?.({ data: JSON.stringify(["OK", id, true, "saved"]) } as MessageEvent); }
  published(id: string) { return this.sent.map(s => JSON.parse(s)).filter(m => m[0] === "EVENT" && m[1].id === id); }
}
const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalScope = getLocalStorageUserScope();
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
} });
setLocalStorageUserScope("premium_callback_test");
const signer: Signer = {
  getPublicKey: async () => "payer",
  signEvent: async () => { throw new Error("A durable retry must reuse the signed event"); },
  nip44Encrypt: async () => { throw new Error("No fresh encryption during retry"); },
  nip44Decrypt: async value => value,
};
const paidCalls: string[] = [];
const client = new EscrowClient(signer, { relays: ["wss://relay.test"], wsImpl: RelaySocket as unknown as typeof WebSocket }, {
  onMoneyPublishAcknowledged: entry => {
    // Same ledger side effect used by useEscrow's acknowledgement callback.
    if (entry.type === "premium" && entry.amountMsats) {
      paidCalls.push(entry.escrowId);
      recordPremiumPaid(entry.escrowId, entry.amountMsats, entry.operationId);
    }
  },
});
try {
  client.connect();
  const socket = RelaySocket.instances[0]!;
  socket.onopen?.({} as Event);
  const now = Math.floor(Date.now() / 1000);
  const store = defaultDurableMoneyPublishStore();
  const enqueue = (id: string) => {
    recordPremiumSending(id, 25_000);
    enqueueDurableMoneyPublish(store, {
      event: { id, pubkey: "payer", sig: "already-signed", kind: EscrowEventKind.PREMIUM,
        created_at: now, tags: [["d", id]], content: JSON.stringify({ type: "escrow:premium", noteEnvelope: { encryptedFor: {} } }),
      } as NostrEvent,
      escrowId: id, type: "premium", amountMsats: 25_000, operationId: `op_${id}`,
      spentAt: now, liveUntil: now + 10,
    });
  };
  const awaitPublish = async (id: string) => {
    for (let i = 0; i < 100 && socket.published(id).length === 0; i++) await new Promise(r => setTimeout(r, 1));
    assert.equal(socket.published(id).length, 1, "the original signed premium reached the relay transport");
  };

  enqueue("expired_premium");
  const inFlight = client.drainDurableMoneyPublishes(now);
  await awaitPublish("expired_premium");
  // While publish awaits its ACK, the horizon is reached by a subsequent drain.
  await client.drainDurableMoneyPublishes(now + 10);
  assert.equal(readDurableMoneyPublishes(store)[0]?.status, "expired-unacked");
  socket.ack("expired_premium");
  await inFlight; // Includes both the onOk handler and publish promise continuation.
  socket.ack("expired_premium"); // Late duplicate ACK must be equally harmless.
  assert.deepEqual(paidCalls, [], "an expired ACK must not reach recordPremiumPaid through the client callback");
  assert.equal(getPremiumOutboxRecord("expired_premium")?.status, "sending", "the actual payer ledger must not advance to paid");
  assert.equal(readDurableMoneyPublishes(store)[0]?.status, "expired-unacked", "keep the recovery evidence");
  assert.equal(socket.published("expired_premium").length, 1, "never retransmit the quarantined notes");

  // Positive control proves the callback and storage wiring are active, rather
  // than passing the negative assertion because nothing can reach the ledger.
  enqueue("live_premium");
  const live = client.drainDurableMoneyPublishes(now);
  await awaitPublish("live_premium");
  socket.ack("live_premium");
  await live;
  socket.ack("live_premium");
  assert.deepEqual(paidCalls, ["live_premium"], "a live ACK records payment exactly once");
  assert.equal(getPremiumOutboxRecord("live_premium")?.status, "paid");
  assert.equal(getPremiumOutboxRecord("expired_premium")?.status, "sending");
  assert.deepEqual(readDurableMoneyPublishes(store).map(entry => entry.event.id), ["expired_premium"]);
  console.log("Money publish callback: expired ACK cannot mark premium paid; live ACK records payment once");
} finally {
  client.disconnect();
  setLocalStorageUserScope(originalScope);
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else Reflect.deleteProperty(globalThis, "localStorage");
}
