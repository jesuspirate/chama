// ══════════════════════════════════════════════════════════════════════════
// Chama — Stack ledger: named stacks on one wallet (docs/stack-brief.md)
// ══════════════════════════════════════════════════════════════════════════
//
// Pure bookkeeping. No storage, no wallet calls, no events. A stack is a
// LABEL on part of the spendable balance; it never holds its own ecash.
//
//   ⭐ THE WALLET BALANCE IS TRUTH; STACKS ARE INTENT. Every function that
//   shows or changes an allocation takes `spendableMsats` from the wallet
//   and refuses to let the stacks sum past it. Main is computed, never
//   stored, so it cannot drift.
//
//   ⭐ STACKS NEVER TOUCH THE MONEY PATH. Nothing here gates a lock, claim,
//   refund or recovery. `shortfallFromMain` only sizes an OFFER to move
//   sats; callers must never turn it into a refusal.
//
//   ⭐ LABELS SURVIVE A RESTORE, AMOUNTS ARE REBUILT BY THE USER. The label
//   snapshot carries last-known amounts as hints only; `rebuildFromLabels`
//   caps them at what Main actually holds and the user confirms.

/** Strike Stacks parity (Jet, 2026-10-07): up to five named stacks. */
export const MAX_STACKS = 5;
export const MAX_STACK_NAME_LENGTH = 32;

export type StackCadence = "weekly" | "monthly";

export interface StackBucket {
  id: string;
  name: string;
  /** Optional savings goal; progress framing only. */
  goalMsats: number | null;
  /** Optional reminder schedule into an Exchange buy (phase 3). */
  cadence: StackCadence | null;
  scheduleMsats: number | null;
  allocatedMsats: number;
  /** Last time sats moved INTO this stack. Drives the shrink order. */
  lastFilledAt: number;
  createdAt: number;
}

export interface StackLedger {
  version: 1;
  stacks: StackBucket[];
}

export type StackResult =
  | { ok: true; ledger: StackLedger }
  | { ok: false; reason: StackRefusal };

export type StackRefusal =
  | "too-many-stacks"
  | "invalid-name"
  | "duplicate-name"
  | "unknown-stack"
  | "invalid-amount"
  | "exceeds-main"
  | "exceeds-stack"
  | "invalid-balance";

export function emptyStackLedger(): StackLedger {
  return { version: 1, stacks: [] };
}

function isMsats(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveMsats(value: unknown): value is number {
  return isMsats(value) && value > 0;
}

function optionalMsats(value: unknown): value is number | null {
  return value === null || isPositiveMsats(value);
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function nameKey(name: string): string {
  return normalizeName(name).toLocaleLowerCase();
}

function validName(name: string): boolean {
  const normalized = normalizeName(name);
  return normalized.length > 0 && normalized.length <= MAX_STACK_NAME_LENGTH;
}

function nameTaken(ledger: StackLedger, name: string, exceptId?: string): boolean {
  const key = nameKey(name);
  return ledger.stacks.some((s) => s.id !== exceptId && nameKey(s.name) === key);
}

export function allocatedMsats(ledger: StackLedger): number {
  return ledger.stacks.reduce((sum, s) => sum + s.allocatedMsats, 0);
}

/** Main = balance − stacks, never negative. Call `reconcileStacks` first
 *  when the balance may have fallen; this alone does not shrink anything. */
export function mainMsats(ledger: StackLedger, spendableMsats: number): number {
  if (!isMsats(spendableMsats)) return 0;
  return Math.max(0, spendableMsats - allocatedMsats(ledger));
}

export interface NewStackInput {
  id: string;
  name: string;
  goalMsats?: number | null;
  cadence?: StackCadence | null;
  scheduleMsats?: number | null;
}

export function createStack(ledger: StackLedger, input: NewStackInput, nowSec: number): StackResult {
  if (ledger.stacks.length >= MAX_STACKS) return { ok: false, reason: "too-many-stacks" };
  if (!validName(input.name)) return { ok: false, reason: "invalid-name" };
  if (nameTaken(ledger, input.name) || ledger.stacks.some((s) => s.id === input.id)) {
    return { ok: false, reason: "duplicate-name" };
  }
  const goalMsats = input.goalMsats ?? null;
  const scheduleMsats = input.scheduleMsats ?? null;
  if (!optionalMsats(goalMsats) || !optionalMsats(scheduleMsats)) {
    return { ok: false, reason: "invalid-amount" };
  }
  const stack: StackBucket = {
    id: input.id,
    name: normalizeName(input.name),
    goalMsats,
    cadence: input.cadence ?? null,
    scheduleMsats,
    allocatedMsats: 0,
    lastFilledAt: 0,
    createdAt: nowSec,
  };
  return { ok: true, ledger: { ...ledger, stacks: [...ledger.stacks, stack] } };
}

export interface StackLabelUpdate {
  name?: string;
  goalMsats?: number | null;
  cadence?: StackCadence | null;
  scheduleMsats?: number | null;
}

/** Edits labels only; never touches an amount. */
export function updateStackLabels(ledger: StackLedger, id: string, update: StackLabelUpdate): StackResult {
  const current = ledger.stacks.find((s) => s.id === id);
  if (!current) return { ok: false, reason: "unknown-stack" };
  if (update.name !== undefined) {
    if (!validName(update.name)) return { ok: false, reason: "invalid-name" };
    if (nameTaken(ledger, update.name, id)) return { ok: false, reason: "duplicate-name" };
  }
  if (update.goalMsats !== undefined && !optionalMsats(update.goalMsats)) {
    return { ok: false, reason: "invalid-amount" };
  }
  if (update.scheduleMsats !== undefined && !optionalMsats(update.scheduleMsats)) {
    return { ok: false, reason: "invalid-amount" };
  }
  const next: StackBucket = {
    ...current,
    ...(update.name !== undefined ? { name: normalizeName(update.name) } : {}),
    ...(update.goalMsats !== undefined ? { goalMsats: update.goalMsats } : {}),
    ...(update.cadence !== undefined ? { cadence: update.cadence } : {}),
    ...(update.scheduleMsats !== undefined ? { scheduleMsats: update.scheduleMsats } : {}),
  };
  return { ok: true, ledger: { ...ledger, stacks: ledger.stacks.map((s) => (s.id === id ? next : s)) } };
}

/** Removing a stack returns its sats to Main; no money moves. */
export function deleteStack(ledger: StackLedger, id: string): StackResult {
  if (!ledger.stacks.some((s) => s.id === id)) return { ok: false, reason: "unknown-stack" };
  return { ok: true, ledger: { ...ledger, stacks: ledger.stacks.filter((s) => s.id !== id) } };
}

/** Main → stack. Free and instant; bounded by what Main holds right now. */
export function moveToStack(
  ledger: StackLedger,
  id: string,
  amountMsats: number,
  spendableMsats: number,
  nowSec: number,
): StackResult {
  if (!isMsats(spendableMsats)) return { ok: false, reason: "invalid-balance" };
  if (!isPositiveMsats(amountMsats)) return { ok: false, reason: "invalid-amount" };
  const current = ledger.stacks.find((s) => s.id === id);
  if (!current) return { ok: false, reason: "unknown-stack" };
  if (amountMsats > mainMsats(ledger, spendableMsats)) return { ok: false, reason: "exceeds-main" };
  const next = { ...current, allocatedMsats: current.allocatedMsats + amountMsats, lastFilledAt: nowSec };
  return { ok: true, ledger: { ...ledger, stacks: ledger.stacks.map((s) => (s.id === id ? next : s)) } };
}

/** Stack → Main. */
export function moveToMain(ledger: StackLedger, id: string, amountMsats: number): StackResult {
  if (!isPositiveMsats(amountMsats)) return { ok: false, reason: "invalid-amount" };
  const current = ledger.stacks.find((s) => s.id === id);
  if (!current) return { ok: false, reason: "unknown-stack" };
  if (amountMsats > current.allocatedMsats) return { ok: false, reason: "exceeds-stack" };
  const next = { ...current, allocatedMsats: current.allocatedMsats - amountMsats };
  return { ok: true, ledger: { ...ledger, stacks: ledger.stacks.map((s) => (s.id === id ? next : s)) } };
}

/** Most recently filled first; ties broken newest-created, then by id so
 *  the order is identical on every run. */
function shrinkOrder(a: StackBucket, b: StackBucket): number {
  return b.lastFilledAt - a.lastFilledAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface StackShrink {
  id: string;
  name: string;
  shrunkMsats: number;
}

export type ReconcileResult =
  | { ok: true; ledger: StackLedger; shrunk: StackShrink[] }
  | { ok: false; reason: "invalid-balance" };

/** The balance fell below what the stacks hold (a send from elsewhere, a
 *  federation quirk). Main absorbs it first by construction; past that,
 *  the most recently filled stack shrinks first (Jet, 2026-10-07).
 *  `shrunk` is what the UI says once, in plain words. An unreadable
 *  balance changes nothing. */
export function reconcileStacks(ledger: StackLedger, spendableMsats: number): ReconcileResult {
  if (!isMsats(spendableMsats)) return { ok: false, reason: "invalid-balance" };
  let excess = allocatedMsats(ledger) - spendableMsats;
  if (excess <= 0) return { ok: true, ledger, shrunk: [] };
  const cuts = new Map<string, number>();
  for (const stack of [...ledger.stacks].sort(shrinkOrder)) {
    if (excess <= 0) break;
    const cut = Math.min(stack.allocatedMsats, excess);
    if (cut > 0) {
      cuts.set(stack.id, cut);
      excess -= cut;
    }
  }
  const stacks = ledger.stacks.map((s) => {
    const cut = cuts.get(s.id);
    return cut ? { ...s, allocatedMsats: s.allocatedMsats - cut } : s;
  });
  const shrunk = ledger.stacks
    .filter((s) => cuts.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, shrunkMsats: cuts.get(s.id)! }));
  return { ok: true, ledger: { ...ledger, stacks }, shrunk };
}

/** Sats leave from Main. When Main can't cover a payment, this sizes the
 *  "Move N sats from House to pay this?" offer. 0 = Main covers it, or the
 *  wallet can't cover it at all (the payment's own checks decide that).
 *  Never a refusal. */
export function shortfallFromMain(ledger: StackLedger, spendableMsats: number, neededMsats: number): number {
  if (!isMsats(spendableMsats) || !isPositiveMsats(neededMsats)) return 0;
  if (neededMsats > spendableMsats) return 0;
  return Math.max(0, neededMsats - mainMsats(ledger, spendableMsats));
}

export interface StackGoalProgress {
  allocatedMsats: number;
  goalMsats: number | null;
  /** 0..1, or null without a goal. */
  fraction: number | null;
  reached: boolean;
}

export function stackGoalProgress(stack: StackBucket): StackGoalProgress {
  const goal = stack.goalMsats;
  if (!goal) return { allocatedMsats: stack.allocatedMsats, goalMsats: null, fraction: null, reached: false };
  return {
    allocatedMsats: stack.allocatedMsats,
    goalMsats: goal,
    fraction: Math.min(1, stack.allocatedMsats / goal),
    reached: stack.allocatedMsats >= goal,
  };
}

// ── Restore: labels follow the user, amounts are rebuilt by them ──────────

export interface StackLabel {
  id: string;
  name: string;
  goalMsats: number | null;
  cadence: StackCadence | null;
  scheduleMsats: number | null;
  /** Hint only. Never applied without the user's confirmation. */
  lastKnownMsats: number;
}

export interface StackLabelSnapshot {
  version: 1;
  savedAt: number;
  labels: StackLabel[];
}

/** What gets saved, self-encrypted, to the user's Nostr account. Labels and
 *  hints only: no ecash, no keys, nothing that can move money. */
export function stackLabelSnapshot(ledger: StackLedger, nowSec: number): StackLabelSnapshot {
  return {
    version: 1,
    savedAt: nowSec,
    labels: ledger.stacks.map((s) => ({
      id: s.id,
      name: s.name,
      goalMsats: s.goalMsats,
      cadence: s.cadence,
      scheduleMsats: s.scheduleMsats,
      lastKnownMsats: s.allocatedMsats,
    })),
  };
}

function isCadence(value: unknown): value is StackCadence | null {
  return value === null || value === "weekly" || value === "monthly";
}

/** Adversarial-on-read: a snapshot comes back from relays. Malformed labels
 *  are dropped, duplicates and the sixth-and-later are ignored. Returns
 *  null when nothing usable is left, which means "start with Main". */
export function parseStackLabelSnapshot(raw: unknown): StackLabelSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || !Array.isArray(obj.labels)) return null;
  const labels: StackLabel[] = [];
  const seenNames = new Set<string>();
  const seenIds = new Set<string>();
  for (const entry of obj.labels) {
    if (labels.length >= MAX_STACKS) break;
    if (!entry || typeof entry !== "object") continue;
    const l = entry as Record<string, unknown>;
    if (typeof l.id !== "string" || !l.id || typeof l.name !== "string" || !validName(l.name)) continue;
    const goalMsats = l.goalMsats ?? null;
    const scheduleMsats = l.scheduleMsats ?? null;
    const cadence = l.cadence ?? null;
    if (!optionalMsats(goalMsats) || !optionalMsats(scheduleMsats) || !isCadence(cadence)) continue;
    const key = nameKey(l.name);
    if (seenNames.has(key) || seenIds.has(l.id)) continue;
    seenNames.add(key);
    seenIds.add(l.id);
    labels.push({
      id: l.id,
      name: normalizeName(l.name),
      goalMsats,
      cadence,
      scheduleMsats,
      lastKnownMsats: isMsats(l.lastKnownMsats) ? l.lastKnownMsats : 0,
    });
  }
  if (labels.length === 0) return null;
  return { version: 1, savedAt: isMsats(obj.savedAt) ? obj.savedAt : 0, labels };
}

export interface StackRebuildSuggestion {
  label: StackLabel;
  /** Pre-filled amount: the hint, capped so the total never exceeds Main. */
  suggestedMsats: number;
}

/** "Rebuild your stacks" on a fresh device: every sat starts in Main. Hints
 *  are honoured in saved order until Main runs out; the user edits and
 *  confirms. Pure suggestion, never applied here. */
export function rebuildFromLabels(snapshot: StackLabelSnapshot, spendableMsats: number): StackRebuildSuggestion[] {
  let remaining = isMsats(spendableMsats) ? spendableMsats : 0;
  return snapshot.labels.map((label) => {
    const suggestedMsats = Math.min(label.lastKnownMsats, remaining);
    remaining -= suggestedMsats;
    return { label, suggestedMsats };
  });
}

/** Applies a confirmed rebuild onto an empty ledger. Amounts the user
 *  confirmed still go through `moveToStack`, so the balance cap holds. */
export function applyRebuild(
  confirmed: readonly { label: StackLabel; amountMsats: number }[],
  spendableMsats: number,
  nowSec: number,
): StackResult {
  let ledger = emptyStackLedger();
  for (const { label, amountMsats } of confirmed) {
    const created = createStack(ledger, label, nowSec);
    if (!created.ok) return created;
    ledger = created.ledger;
    if (amountMsats > 0) {
      const moved = moveToStack(ledger, label.id, amountMsats, spendableMsats, nowSec);
      if (!moved.ok) return moved;
      ledger = moved.ledger;
    }
  }
  return { ok: true, ledger };
}
