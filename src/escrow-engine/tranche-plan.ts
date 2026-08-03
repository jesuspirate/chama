import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import {
  EscrowStatus,
  Role,
  type CreatePayload,
  type EscrowState,
  type PlanStartPayload,
  type TrancheBitcoinNetwork,
  type TrancheChildDescriptor,
  type TrancheDescriptor,
} from "./types.js";

const HEX_64 = /^[0-9a-f]{64}$/;

function digest(value: string): string {
  return bytesToHex(sha256(utf8ToBytes(value)));
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

/** Digest only immutable commercial terms; participant and plan fields are
 * committed separately by the signed PLAN_START event. */
export function trancheTermsDigest(payload: CreatePayload): string {
  return digest(canonical({
    description: payload.description,
    category: payload.category,
    fulfillment: payload.fulfillment,
    community: payload.community,
    fiatAmount: payload.fiatAmount,
    fiatCurrency: payload.fiatCurrency,
    premiumBps: payload.premiumBps,
    paymentMethods: payload.paymentMethods,
    mintUrl: payload.mintUrl,
    platformFeeBps: payload.platformFeeBps,
    platformFeePubkey: payload.platformFeePubkey,
    arbiterFeeMsats: payload.arbiterFeeMsats,
    expirySeconds: payload.expirySeconds,
  }));
}

export function tranchePlanId(parentId: string, termsDigest: string, buyerPubkey: string): string {
  return digest(`chama-tranche-plan-v1\u0000${parentId}\u0000${termsDigest}\u0000${buyerPubkey}`);
}

export function trancheChildId(parentId: string, planId: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error("Tranche index must be a non-negative integer");
  return digest(`chama-tranche-child-v1\u0000${parentId}\u0000${planId}\u0000${index}`);
}

export function splitTranches(totalMsats: number, maximumChildMsats: number): TrancheDescriptor[] {
  if (!Number.isSafeInteger(totalMsats) || totalMsats <= 0) throw new Error("Total must be positive integer msats");
  if (!Number.isSafeInteger(maximumChildMsats) || maximumChildMsats <= 0) throw new Error("Child maximum must be positive integer msats");
  const result: TrancheDescriptor[] = [];
  for (let remaining = totalMsats, index = 0; remaining > 0; index++) {
    const amountMsats = Math.min(remaining, maximumChildMsats);
    result.push({ index, amountMsats });
    remaining -= amountMsats;
  }
  return result;
}

export function validatePlanStart(plan: PlanStartPayload): string | null {
  if (!HEX_64.test(plan.planId) || !HEX_64.test(plan.termsDigest)) return "invalid plan or terms digest";
  if (!HEX_64.test(plan.buyerPubkey) || !HEX_64.test(plan.sellerPubkey) || !HEX_64.test(plan.arbiterPubkey)) return "invalid participant pubkey";
  if (plan.coordinatorPubkey !== plan.sellerPubkey) return "coordinator must be the parent initiator/seller";
  if (plan.bitcoinNetwork !== "mainnet" && plan.bitcoinNetwork !== "signet") return "invalid Bitcoin network";
  if (!Number.isInteger(plan.total) || plan.total < 1 || plan.total > 100) return "invalid tranche count";
  if (!Number.isSafeInteger(plan.totalMsats) || plan.totalMsats <= 0) return "invalid total amount";
  if (!Array.isArray(plan.tranches) || plan.tranches.length !== plan.total) return "tranche count mismatch";
  let sum = 0;
  for (let index = 0; index < plan.tranches.length; index++) {
    const tranche = plan.tranches[index];
    if (tranche.index !== index || !Number.isSafeInteger(tranche.amountMsats) || tranche.amountMsats <= 0) return "invalid tranche descriptor";
    sum += tranche.amountMsats;
  }
  return sum === plan.totalMsats ? null : "tranche amount mismatch";
}

export function buildChildDescriptor(
  parentId: string,
  planStartEventId: string,
  plan: PlanStartPayload,
  index: number,
): TrancheChildDescriptor {
  const tranche = plan.tranches[index];
  if (!tranche) throw new Error(`Missing tranche ${index}`);
  return {
    privatePlanChild: true,
    parent: parentId,
    planId: plan.planId,
    planStartEventId,
    index,
    total: plan.total,
    totalMsats: plan.totalMsats,
    buyerPubkey: plan.buyerPubkey,
    sellerPubkey: plan.sellerPubkey,
    arbiterPubkey: plan.arbiterPubkey,
    termsDigest: plan.termsDigest,
    coordinatorPubkey: plan.coordinatorPubkey,
    bitcoinNetwork: plan.bitcoinNetwork,
  };
}

export function verifyTrancheChild(
  parentId: string,
  planStartEventId: string,
  plan: PlanStartPayload,
  childId: string,
  payload: CreatePayload,
): string | null {
  const child = payload.trancheChild;
  if (!child?.privatePlanChild) return "not a private plan child";
  if (child.parent !== parentId || child.planStartEventId !== planStartEventId || child.planId !== plan.planId) return "wrong parent plan";
  if (childId !== trancheChildId(parentId, plan.planId, child.index)) return "non-deterministic child id";
  const expected = buildChildDescriptor(parentId, planStartEventId, plan, child.index);
  for (const key of Object.keys(expected) as (keyof TrancheChildDescriptor)[]) {
    if (child[key] !== expected[key]) return `child ${key} does not match parent plan`;
  }
  if (payload.amountMsats !== plan.tranches[child.index].amountMsats) return "wrong child amount";
  if (trancheTermsDigest(payload) !== plan.termsDigest) return "child commercial terms changed";
  return null;
}

export function isPrivatePlanChild(payload: Pick<CreatePayload, "parent" | "trancheChild">): boolean {
  return payload.trancheChild?.privatePlanChild === true;
}

export interface PlanState {
  plan: PlanStartPayload;
  children: Array<{ id: string; index: number; amountMsats: number; status: EscrowStatus; valid: boolean; error?: string }>;
  settledCount: number;
  outstandingMsats: number;
  activeChildId: string | null;
  stoppedReason: string | null;
  nextSafeAction: "publish-missing-children" | "fund-active-child" | "settle-active-child" | "complete" | "repair-plan";
}

export function derivePlanState(parent: EscrowState, children: EscrowState[]): PlanState | null {
  const frozen = parent.tranchePlan;
  if (!frozen) return null;
  const byIndex = new Map(children.filter(c => c.trancheChild?.planId === frozen.planId).map(c => [c.trancheChild!.index, c]));
  const rows: PlanState["children"] = [];
  let settledCount = 0;
  let outstandingMsats = frozen.totalMsats;
  let stoppedReason: string | null = null;
  for (const tranche of frozen.tranches) {
    const child = byIndex.get(tranche.index);
    if (!child) {
      rows.push({ id: trancheChildId(parent.id, frozen.planId, tranche.index), index: tranche.index, amountMsats: tranche.amountMsats, status: EscrowStatus.CREATED, valid: false, error: "missing child" });
      continue;
    }
    const createPayload = child.eventChain.find(event => event.kind === 38100)?.payload as CreatePayload | undefined;
    const verificationError = createPayload
      ? verifyTrancheChild(parent.id, frozen.eventId, frozen, child.id, createPayload)
      : "missing child CREATE";
    const exactParticipants = child.participants[Role.BUYER] === frozen.buyerPubkey
      && child.participants[Role.SELLER] === frozen.sellerPubkey
      && child.participants[Role.ARBITER] === frozen.arbiterPubkey;
    const valid = verificationError === null && exactParticipants;
    rows.push({ id: child.id, index: tranche.index, amountMsats: tranche.amountMsats, status: child.status, valid,
      ...(!valid ? { error: verificationError ?? "child participants do not match frozen plan" } : {}) });
    if (!valid && !stoppedReason) stoppedReason = `Invalid tranche ${tranche.index + 1}`;
    if (valid && child.status === EscrowStatus.COMPLETED && tranche.index === settledCount) {
      settledCount++;
      outstandingMsats -= tranche.amountMsats;
    }
  }
  const active = stoppedReason ? null : rows.find(row => row.index === settledCount && row.valid) ?? null;
  const missing = rows.some(row => row.error === "missing child");
  return {
    plan: frozen,
    children: rows,
    settledCount,
    outstandingMsats,
    activeChildId: active?.id ?? null,
    stoppedReason,
    nextSafeAction: stoppedReason ? "repair-plan"
      : missing ? "publish-missing-children"
      : settledCount === frozen.total ? "complete"
      : active?.status === EscrowStatus.CREATED ? "fund-active-child"
      : "settle-active-child",
  };
}

export function canFundTranche(parent: EscrowState, children: EscrowState[], childId: string): boolean {
  const plan = derivePlanState(parent, children);
  return plan?.activeChildId === childId && plan.nextSafeAction === "fund-active-child";
}

export function networkMatches(parentNetwork: TrancheBitcoinNetwork, childNetwork: TrancheBitcoinNetwork): boolean {
  return parentNetwork === childNetwork;
}
