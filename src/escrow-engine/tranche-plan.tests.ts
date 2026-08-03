import {
  EscrowEventKind, EscrowStatus, Role, getEffectiveParticipantAt,
  type CreatePayload, type EscrowState, type NostrEvent, type PlanStartPayload,
} from "./types.js";
import { parseEscrowEvent } from "./event-parser.js";
import { applyEvent } from "./state-machine.js";
import { shouldShowOnBrowse } from "../ui/decisions.js";
import {
  buildChildDescriptor, canFundTranche, derivePlanState, isPrivatePlanChild,
  splitTranches, trancheChildId, tranchePlanId, trancheTermsDigest, verifyTrancheChild,
} from "./tranche-plan.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ✓ ${message}`);
}

const SELLER = "11".repeat(32);
const BUYER = "22".repeat(32);
const ARBITER = "33".repeat(32);
const PARENT = "44".repeat(32);
const START_EVENT = "55".repeat(32);

function raw(id: string, pubkey: string, kind: EscrowEventKind, escrowId: string, content: unknown, tags: string[][] = []): NostrEvent {
  return { id, pubkey, kind, created_at: 1_800_000_000, tags: [["d", escrowId], ["t", (content as { type: string }).type], ...tags], content: JSON.stringify(content), sig: "00".repeat(64) };
}

function parse(event: NostrEvent) {
  const result = parseEscrowEvent(event, event.content, true);
  assert(result.ok, `parser accepts ${JSON.parse(event.content).type}`);
  return result.event;
}

const parentPayload: CreatePayload = {
  type: "escrow:create", description: "Buy 300k sats", amountMsats: 300_000_000,
  fiatAmount: 300, fiatCurrency: "USD", category: "p2p-trade", fulfillment: "service",
  mintUrl: "fed1test", platformFeeBps: 25, platformFeePubkey: SELLER,
  arbiterFeeMsats: 1_000, expirySeconds: 86_400, communityArbiters: [ARBITER], createdAt: 1_800_000_000,
};
const termsDigest = trancheTermsDigest(parentPayload);
const planId = tranchePlanId(PARENT, termsDigest, BUYER);
const tranches = splitTranches(parentPayload.amountMsats, 100_000_000);
const plan: PlanStartPayload = {
  type: "escrow:plan_start", planId, total: tranches.length, totalMsats: parentPayload.amountMsats,
  buyerPubkey: BUYER, sellerPubkey: SELLER, arbiterPubkey: ARBITER,
  termsDigest, coordinatorPubkey: SELLER, bitcoinNetwork: "signet", tranches, startedAt: 1_800_000_003,
};

console.log("\n── PARENT/CHILD TRANCHE PROTOCOL ──");
assert(tranches.length === 3 && tranches.every(t => t.amountMsats === 100_000_000), "split is deterministic and preserves total");
assert(trancheChildId(PARENT, planId, 0) === trancheChildId(PARENT, planId, 0), "child id is retry-stable");
assert(trancheChildId(PARENT, planId, 0) !== trancheChildId(PARENT, planId, 1), "child index produces a unique id");

let parent = applyEvent(null, parse(raw(PARENT, SELLER, EscrowEventKind.CREATE, PARENT, parentPayload)));
assert(parent.ok, "parent CREATE replays");
const buyerJoin = { type: "escrow:join" as const, role: Role.BUYER, joinedAt: 1_800_000_001, holdExpiresAt: 1_800_000_301 };
parent = applyEvent(parent.state, parse(raw("66".repeat(32), BUYER, EscrowEventKind.JOIN, PARENT, buyerJoin, [["e", PARENT, "", "reply"], ["p", BUYER]])));
assert(parent.ok, "buyer seats once on parent");
const arbiterJoin = { type: "escrow:join" as const, role: Role.ARBITER, joinedAt: 1_800_000_002 };
parent = applyEvent(parent.state, parse(raw("77".repeat(32), ARBITER, EscrowEventKind.JOIN, PARENT, arbiterJoin, [["e", "66".repeat(32), "", "reply"], ["p", ARBITER]])));
assert(parent.ok, "arbiter seats once on parent");
parent = applyEvent(parent.state, parse(raw(START_EVENT, SELLER, EscrowEventKind.PLAN_START, PARENT, plan, [["e", "77".repeat(32), "", "reply"]])));
assert(parent.ok && parent.state.tranchePlan?.planId === planId, "signed plan start freezes the parent snapshot");
assert(!shouldShowOnBrowse({ escrow: parent.state, browseCategory: "all", nowSec: 1_800_000_004 }), "frozen parent cannot be retaken from Browse");
assert(getEffectiveParticipantAt(parent.state, Role.BUYER, 1_900_000_000) === BUYER, "frozen parent buyer seat does not lapse");

const children: EscrowState[] = [];
for (const row of tranches) {
  const tranche = buildChildDescriptor(PARENT, START_EVENT, plan, row.index);
  const childPayload: CreatePayload = { ...parentPayload, amountMsats: row.amountMsats, parent: PARENT, sellerPubkey: SELLER, tranche };
  const childId = trancheChildId(PARENT, planId, row.index);
  assert(verifyTrancheChild(PARENT, START_EVENT, plan, childId, childPayload) === null, `child ${row.index + 1} verifies against frozen terms`);
  assert(isPrivatePlanChild(childPayload), `child ${row.index + 1} is excluded from public Browse`);
  const applied = applyEvent(null, parse(raw(childId, SELLER, EscrowEventKind.CREATE, childId, childPayload,
    [["parent", PARENT], ["p", BUYER], ["p", SELLER], ["p", ARBITER], ["bitcoin_network", "signet"]])));
  assert(applied.ok, `child ${row.index + 1} pre-seats the exact three participants`);
  children.push(applied.state);
}

let derived = derivePlanState(parent.state, children);
assert(derived?.activeChildId === children[0].id && canFundTranche(parent.state, children, children[0].id), "only child 1 can fund initially");
assert(!canFundTranche(parent.state, children, children[1].id), "child 2 cannot fund before child 1 payout proof");
children[0] = { ...children[0], status: EscrowStatus.COMPLETED };
derived = derivePlanState(parent.state, children);
assert(derived?.activeChildId === children[1].id && derived.settledCount === 1, "proven child 1 completion activates child 2");

const wrongNetwork: CreatePayload = { ...parentPayload, amountMsats: tranches[0].amountMsats, parent: PARENT, sellerPubkey: SELLER,
  tranche: { ...buildChildDescriptor(PARENT, START_EVENT, plan, 0), bitcoinNetwork: "mainnet" } };
assert(verifyTrancheChild(PARENT, START_EVENT, plan, trancheChildId(PARENT, planId, 0), wrongNetwork)?.includes("bitcoinNetwork") === true,
  "cross-network child is rejected before funding");

const keyPayload = { type: "escrow:child_key" as const, planId, parent: PARENT, index: 0, role: Role.BUYER,
  bitcoinNetwork: "signet" as const, xOnlyPubkey: "aa".repeat(32), publishedAt: 1_800_000_010 };
const keyTarget = { ...children[0], status: EscrowStatus.CREATED };
const keyed = applyEvent(keyTarget, parse(raw("88".repeat(32), BUYER, EscrowEventKind.CHILD_KEY, keyTarget.id, keyPayload,
  [["e", children[0].eventChain.at(-1)!.raw.id, "", "reply"]])));
assert(keyed.ok && keyed.state.childKeys?.buyer === keyPayload.xOnlyPubkey, "pre-seated buyer publishes a per-child key without JOIN");

console.log("\nParent/child tranche protocol tests passed.");
