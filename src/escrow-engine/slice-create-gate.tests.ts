// v6.0 consensus gates on CREATE: settlementPolicy⇔escrowMode agreement and
// the onchain-slicing rejection. Exercises the real reducer (applyEvent).
import {
  EscrowEventKind, Role, type CreatePayload, type NostrEvent,
} from "./types.js";
import { parseEscrowEvent } from "./event-parser.js";
import { applyEvent } from "./state-machine.js";
import {
  SETTLEMENT_POLICY_ECASH_SLICES, SETTLEMENT_POLICY_ONCHAIN_FULL, MAX_SLICE_COUNT,
} from "./slice-policy.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}
function assertRejects(payload: CreatePayload, code: string, message: string): void {
  const event = parseEscrowEvent(raw("ab".repeat(32), SELLER, payload), JSON.stringify(payload), true);
  if (!event.ok) throw new Error(`parse failed for ${message}`);
  const result = applyEvent(null, event.event);
  assert(!result.ok && result.error.code === code, message);
}

const SELLER = "11".repeat(32);
const ESCROW = "22".repeat(32);
function raw(id: string, pubkey: string, content: unknown): NostrEvent {
  return { id, pubkey, kind: EscrowEventKind.CREATE, created_at: 1_800_000_000,
    tags: [["d", ESCROW], ["t", (content as { type: string }).type]],
    content: JSON.stringify(content), sig: "00".repeat(64) };
}

const base: CreatePayload = {
  type: "escrow:create", description: "v6 gate test", amountMsats: 100_000_000,
  fiatAmount: 100, fiatCurrency: "USD", category: "p2p-trade", fulfillment: "service",
  mintUrl: "fed1test", platformFeeBps: 25, platformFeePubkey: SELLER,
  arbiterFeeMsats: 1_000, expirySeconds: 86_400, createdAt: 1_800_000_000,
};

console.log("\n── V6 CREATE GATES ──");

// Policy/mode agreement gate (contract test #5).
assertRejects({ ...base, escrowMode: "onchain", settlementPolicy: SETTLEMENT_POLICY_ECASH_SLICES },
  "SETTLEMENT_POLICY_MODE_MISMATCH", "ecash policy on an onchain CREATE is rejected");
assertRejects({ ...base, escrowMode: "ecash", settlementPolicy: SETTLEMENT_POLICY_ONCHAIN_FULL },
  "SETTLEMENT_POLICY_MODE_MISMATCH", "onchain policy on an ecash CREATE is rejected");

// Onchain slicing rejection (contract test #5).
assertRejects({ ...base, escrowMode: "onchain", sliceCount: 3 },
  "ONCHAIN_SLICING_UNSUPPORTED", "sliceCount on an onchain CREATE is rejected");

// sliceCount validity.
assertRejects({ ...base, escrowMode: "ecash", sliceCount: 0 },
  "INVALID_CREATE", "sliceCount 0 is rejected");
assertRejects({ ...base, escrowMode: "ecash", sliceCount: 1.5 },
  "INVALID_CREATE", "non-integer sliceCount is rejected");

// Happy paths: defaults + explicit agreement.
function accepts(payload: CreatePayload, message: string): ReturnType<typeof applyEvent> {
  const event = parseEscrowEvent(raw("cd".repeat(32), SELLER, payload), JSON.stringify(payload), true);
  if (!event.ok) throw new Error(`parse failed for ${message}`);
  const result = applyEvent(null, event.event);
  assert(result.ok, message);
  return result;
}

// Cold-review L1/L2 consensus bounds.
assertRejects({ ...base, escrowMode: "ecash", sliceCount: MAX_SLICE_COUNT + 1 },
  "INVALID_CREATE", "sliceCount above MAX_SLICE_COUNT is rejected");
assertRejects({ ...base, escrowMode: "ecash", amountMsats: 200_000_000_001, sliceCount: 1 },
  "INVALID_CREATE", "amount requiring more than MAX_SLICE_COUNT capped slices is rejected");
assertRejects({ ...base, escrowMode: "ecash", amountMsats: 1_000, sliceCount: 2 },
  "INVALID_CREATE", "sliceCount the amount can't fill with ≥1 sat/slice is rejected");
accepts({ ...base, escrowMode: "ecash", amountMsats: 2_000, sliceCount: 2 },
  "exactly 1 sat per slice is accepted at the CREATE gate");
const legacy = accepts({ ...base }, "legacy CREATE (no policy/mode) still replays");
assert(legacy.ok && legacy.state.escrowMode === "ecash" && legacy.state.settlementPolicy === SETTLEMENT_POLICY_ECASH_SLICES,
  "legacy CREATE defaults to ecash + slices policy");
const sliced = accepts({ ...base, escrowMode: "ecash", settlementPolicy: SETTLEMENT_POLICY_ECASH_SLICES, sliceCount: 3 },
  "explicit ecash slices CREATE is accepted");
assert(sliced.ok && sliced.state.sliceCount === 3, "sliceCount is recorded in state");
const onchain = accepts({ ...base, escrowMode: "onchain" }, "onchain CREATE without sliceCount is accepted");
assert(onchain.ok && onchain.state.settlementPolicy === SETTLEMENT_POLICY_ONCHAIN_FULL && onchain.state.sliceCount === undefined,
  "onchain CREATE defaults policy and carries no sliceCount");

console.log("\nV6 CREATE-gate tests passed.");
