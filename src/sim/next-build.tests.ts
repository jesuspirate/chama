import type { CircleShareLock } from "../chama/types.js";
import assert from "node:assert/strict";
import { CHAMA_NEXT } from "./next-build.js";
import { isSimModeOn, setSimMode, shouldDropForSimPolicy, simTagOrNull } from "./simMode.js";
import { CHAMA_RING_WRITER_ENABLED, CHAMA_ROTATION_ENABLED } from "../escrow-engine/experimental-escrow-features.js";
import { DEFAULT_RELAYS, CHAMA_RELAY } from "../escrow-engine/default-relays.js";
import { chamaClientTag } from "../escrow-engine/client-tag.js";
import { circleCanvasRound, circleCanvasErrors } from "../chama/canvas.js";
import { canTakeSeat } from "../chama/circle.js";
import { COLLECT_WINDOW_SEC, collectWindowSeconds, roundOutcomeAt } from "../chama/rotation.js";
import { chamaCreateError } from "../chama/policy.js";
import { EscrowEventKind as K, type CreatePayload, type NostrEvent } from "../escrow-engine/types.js";
import { RelayManager } from "../escrow-engine/relay-manager.js";

// Unavailable storage + explicit opt-out must still never unlock real money in NEXT.
Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { search: "?sim=0" } } });
assert.equal(isSimModeOn(), CHAMA_NEXT);
setSimMode(false);
assert.equal(isSimModeOn(), CHAMA_NEXT);
assert.equal(CHAMA_RING_WRITER_ENABLED, CHAMA_NEXT);
assert.equal(CHAMA_ROTATION_ENABLED, CHAMA_NEXT);
assert.equal(chamaClientTag("test")[1], CHAMA_NEXT ? "chama-next" : "chama");
if (CHAMA_NEXT) assert.deepEqual(DEFAULT_RELAYS, [CHAMA_RELAY]);
else assert(DEFAULT_RELAYS.length > 1);
assert.equal(simTagOrNull()?.[0] ?? null, CHAMA_NEXT ? "chama-sim" : null);
assert.equal(COLLECT_WINDOW_SEC, 604800);
assert.equal(collectWindowSeconds({}), 604800);
const T = 1900000000, H = "11".repeat(32), M1 = "22".repeat(32), M2 = "33".repeat(32);
const round = circleCanvasRound({ shareSats: 1000, threshold: 3, cap: 3, durationSec: 600,
  collectWindowSec: 600, createdAt: T, creatorPubkey: H, community: "test", mintUrl: "test", name: "NEXT" });
assert.equal(round.pot, CHAMA_NEXT ? "rotation-v2" : undefined);
assert.equal(round.collectWindowSec, CHAMA_NEXT ? 600 : undefined);
assert.equal(circleCanvasErrors(round).length, 0);
if (CHAMA_NEXT) {
  assert(circleCanvasErrors({ ...round, roundEndSec: T + 599 }).length);
  assert.equal(roundOutcomeAt(round, 2, 2, T + 600), "release");
  assert.equal(roundOutcomeAt(round, 2, 2, T + 1199), "release");
  assert.equal(roundOutcomeAt(round, 2, 2, T + 1200), "refund");
  assert.equal(roundOutcomeAt(round, 1, 2, round.fillDeadlineSec), "refund");
  const lock = (memberPubkey: string, at: number): CircleShareLock => ({ circleId: round.circleId,
    memberPubkey, lockedAtSec: at, escrowId: memberPubkey, status: "locked" });
  assert(!canTakeSeat(round, [], H, T + 10).ok);
  assert(!canTakeSeat(round, [lock(M1, T + 10)], H, T + 20).ok);
  assert(canTakeSeat(round, [lock(M1, T + 10), lock(M2, T + 20)], H, T + 30).ok);
}
const payload: CreatePayload = { type: "escrow:create", category: "chama", description: "Test",
  amountMsats: 1000000, mintUrl: "test", platformFeeBps: 0, platformFeePubkey: H, createdAt: T,
  expirySeconds: 600, chamaCircle: { ...round, collectWindowSec: 600 } };
assert.match(chamaCreateError(payload, "id", H, T)!, /sim-tagged/);
assert.equal(chamaCreateError(payload, "id", H, T, undefined, undefined, undefined, true), null);
for (const value of [0, 599, 604801, NaN, 600.5])
  assert(chamaCreateError({ ...payload, chamaCircle: { ...payload.chamaCircle!, collectWindowSec: value } }, "id", H, T, undefined, undefined, undefined, true));

// Real relay ingest routes: neither live callback nor either fetch reaches the
// parser with events from the other money partition. Both share schemas covered.
class Socket {
  static all: Socket[] = [];
  onopen?: (event: Event) => void;
  onmessage?: (event: MessageEvent) => void;
  sent: unknown[][] = [];
  constructor(public url: string) { Socket.all.push(this); }
  send(message: string) { this.sent.push(JSON.parse(message)); }
  close() {}
  emit(frame: unknown[]) { this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent); }
}
let parserCalls = 0;
const relay = new RelayManager([CHAMA_RELAY], { shouldDropEvent: shouldDropForSimPolicy,
  verifyEvent: () => true, onEvent: () => { parserCalls++; } }, Socket as unknown as typeof WebSocket);
relay.connect();
const socket = Socket.all[0]; socket.onopen?.({} as Event);
const raws: NostrEvent[] = ["share-v2", "share-v1"].map((policy, i) => ({ id: String(i + 1).repeat(64),
  kind: K.CREATE, pubkey: H, created_at: T, sig: "00".repeat(64),
  tags: [["d", "circle-share"], ...(CHAMA_NEXT ? [] : [["chama-sim", "v1"]])],
  content: JSON.stringify({ type: "escrow:create", category: "chama-share", chamaPolicy: policy, sellerPubkey: M1 }) }));
try {
  const sub = relay.subscribe({ kinds: [K.CREATE] });
  for (const raw of raws) socket.emit(["EVENT", sub, raw]);
  assert.equal(parserCalls, 0, "other partition dropped before live parser");
  for (const fetch of [() => relay.fetchOnce({ kinds: [K.CREATE] }, 100), () => relay.fetchEscrowEvents("circle-share", 100)]) {
    const pending = fetch();
    const req = socket.sent.filter(frame => frame[0] === "REQ").at(-1)!;
    for (const raw of raws) socket.emit(["EVENT", req[1], raw]);
    socket.emit(["EOSE", req[1]]);
    assert.deepEqual(await pending, [], "other partition dropped before fetch parser");
  }
} finally { relay.disconnect(); }
console.log(`${CHAMA_NEXT ? "NEXT" : "Live"} build isolation, sim clocks and relay ingest: passed`);
