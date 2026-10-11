import {
  MAX_STACKS,
  allocatedMsats,
  applyRebuild,
  createStack,
  deleteStack,
  emptyStackLedger,
  mainMsats,
  moveToMain,
  moveToStack,
  parseStackLabelSnapshot,
  rebuildFromLabels,
  reconcileStacks,
  shortfallFromMain,
  stackGoalProgress,
  stackLabelSnapshot,
  updateStackLabels,
  type StackLedger,
  type StackResult,
} from "./ledger.js";

let passed = 0;
let failed = 0;

function assert(condition: unknown, name: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

function must(result: StackResult): StackLedger {
  if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`);
  return result.ledger;
}

const SAT = 1000;
const T0 = 1_900_000_000;

function twoStacks(): StackLedger {
  let l = must(createStack(emptyStackLedger(), { id: "house", name: "House", goalMsats: 500_000 * SAT, cadence: "weekly" }, T0));
  l = must(createStack(l, { id: "school", name: "School fees" }, T0 + 1));
  return l;
}

console.log("\n── Stack ledger: creating and naming ──");
{
  let l = emptyStackLedger();
  for (let i = 0; i < MAX_STACKS; i++) l = must(createStack(l, { id: `s${i}`, name: `Stack ${i}` }, T0));
  const sixth = createStack(l, { id: "s5", name: "One too many" }, T0);
  assert(!sixth.ok && sixth.reason === "too-many-stacks", "a sixth stack is refused (Strike parity: five)");
  const l2 = twoStacks();
  const dup = createStack(l2, { id: "x", name: "  house " }, T0);
  assert(!dup.ok && dup.reason === "duplicate-name", "names are unique ignoring case and spacing");
  const blank = createStack(l2, { id: "x", name: "   " }, T0);
  assert(!blank.ok && blank.reason === "invalid-name", "a blank name is refused");
  const long = createStack(l2, { id: "x", name: "x".repeat(33) }, T0);
  assert(!long.ok && long.reason === "invalid-name", "a name over 32 characters is refused");
  const renamed = must(updateStackLabels(l2, "school", { name: "  Kids'   school  " }));
  assert(renamed.stacks[1].name === "Kids' school", "rename normalizes whitespace");
  const clash = updateStackLabels(l2, "school", { name: "HOUSE" });
  assert(!clash.ok && clash.reason === "duplicate-name", "rename cannot collide with another stack");
  const badGoal = updateStackLabels(l2, "house", { goalMsats: -5 });
  assert(!badGoal.ok && badGoal.reason === "invalid-amount", "a negative goal is refused");
}

console.log("\n── Law 1: the wallet balance is truth; Main is computed ──");
{
  let l = twoStacks();
  const spendable = 100_000 * SAT;
  assert(mainMsats(l, spendable) === spendable, "with empty stacks, everything is Main");
  l = must(moveToStack(l, "house", 60_000 * SAT, spendable, T0 + 10));
  assert(mainMsats(l, spendable) === 40_000 * SAT, "moving into a stack takes from Main");
  const over = moveToStack(l, "school", 40_001 * SAT, spendable, T0 + 11);
  assert(!over.ok && over.reason === "exceeds-main", "cannot move more than Main holds");
  const zero = moveToStack(l, "school", 0, spendable, T0 + 11);
  assert(!zero.ok && zero.reason === "invalid-amount", "a zero move is refused");
  const frac = moveToStack(l, "school", 1.5, spendable, T0 + 11);
  assert(!frac.ok && frac.reason === "invalid-amount", "a fractional msat move is refused");
  const nan = moveToStack(l, "school", SAT, Number.NaN, T0 + 11);
  assert(!nan.ok && nan.reason === "invalid-balance", "an unreadable balance refuses the move");
  assert(mainMsats(l, Number.NaN) === 0, "an unreadable balance shows Main as 0, never a guess");
  const back = must(moveToMain(l, "house", 10_000 * SAT));
  assert(mainMsats(back, spendable) === 50_000 * SAT, "moving back to Main is free");
  const tooMuch = moveToMain(l, "house", 60_001 * SAT);
  assert(!tooMuch.ok && tooMuch.reason === "exceeds-stack", "cannot take more than a stack holds");
  const gone = must(deleteStack(l, "house"));
  assert(mainMsats(gone, spendable) === spendable && allocatedMsats(gone) === 0, "deleting a stack returns its sats to Main");
}

console.log("\n── Law 3: shrink Main first, then the most recently filled stack ──");
{
  let l = twoStacks();
  const spendable = 100_000 * SAT;
  l = must(moveToStack(l, "house", 50_000 * SAT, spendable, T0 + 10));
  l = must(moveToStack(l, "school", 30_000 * SAT, spendable, T0 + 20));
  const fine = reconcileStacks(l, 90_000 * SAT);
  assert(fine.ok && fine.shrunk.length === 0 && fine.ledger === l, "a drop Main can absorb shrinks no stack");
  const drop = reconcileStacks(l, 70_000 * SAT);
  assert(drop.ok && drop.shrunk.length === 1 && drop.shrunk[0].id === "school" && drop.shrunk[0].shrunkMsats === 10_000 * SAT,
    "past Main, the most recently filled stack shrinks first");
  const deep = reconcileStacks(l, 20_000 * SAT);
  assert(deep.ok && allocatedMsats(deep.ledger) === 20_000 * SAT
    && deep.ledger.stacks.find((s) => s.id === "school")!.allocatedMsats === 0
    && deep.ledger.stacks.find((s) => s.id === "house")!.allocatedMsats === 20_000 * SAT,
    "a deep drop empties the newest stack, then cuts the next");
  const empty = reconcileStacks(l, 0);
  assert(empty.ok && allocatedMsats(empty.ledger) === 0, "an empty wallet leaves every stack at zero");
  const bad = reconcileStacks(l, -1);
  assert(!bad.ok, "an unreadable balance changes nothing");
  const refilled = must(moveToStack(must(moveToMain(l, "house", SAT)), "house", SAT, spendable, T0 + 30));
  const after = reconcileStacks(refilled, 70_000 * SAT);
  assert(after.ok && after.shrunk[0].id === "house", "refilling a stack moves it to the front of the shrink order");
  if (deep.ok) assert(mainMsats(deep.ledger, 20_000 * SAT) === 0 && allocatedMsats(deep.ledger) <= 20_000 * SAT,
    "after reconcile the stacks never sum past the balance");
}

console.log("\n── Law 5: sats leave from Main; stacks only size an offer ──");
{
  let l = twoStacks();
  const spendable = 100_000 * SAT;
  l = must(moveToStack(l, "house", 80_000 * SAT, spendable, T0 + 10));
  assert(shortfallFromMain(l, spendable, 15_000 * SAT) === 0, "Main covers it: no offer");
  assert(shortfallFromMain(l, spendable, 35_000 * SAT) === 15_000 * SAT, "Main short: offer to move exactly the difference");
  assert(shortfallFromMain(l, spendable, 150_000 * SAT) === 0, "the wallet can't cover it: no offer, the payment's own checks decide");
  assert(shortfallFromMain(l, Number.NaN, SAT) === 0, "an unreadable balance makes no offer");
}

console.log("\n── Goals ──");
{
  let l = twoStacks();
  l = must(moveToStack(l, "house", 250_000 * SAT, 1_000_000 * SAT, T0 + 10));
  const p = stackGoalProgress(l.stacks[0]);
  assert(p.fraction === 0.5 && !p.reached, "half way to the goal");
  const none = stackGoalProgress(l.stacks[1]);
  assert(none.fraction === null && !none.reached, "no goal, no progress fraction");
}

console.log("\n── Law 8: labels survive a restore; amounts are rebuilt by the user ──");
{
  let l = twoStacks();
  l = must(moveToStack(l, "house", 60_000 * SAT, 100_000 * SAT, T0 + 10));
  l = must(moveToStack(l, "school", 30_000 * SAT, 100_000 * SAT, T0 + 20));
  const snap = stackLabelSnapshot(l, T0 + 30);
  const json = JSON.parse(JSON.stringify(snap));
  assert(!JSON.stringify(snap).match(/notes|ecash|seed|nsec|secret/i), "the snapshot carries no money and no secrets");
  const parsed = parseStackLabelSnapshot(json);
  assert(parsed !== null && parsed.labels.length === 2 && parsed.labels[0].name === "House"
    && parsed.labels[0].goalMsats === 500_000 * SAT && parsed.labels[0].cadence === "weekly",
    "names, goals and schedules round-trip");
  const fewer = rebuildFromLabels(parsed!, 70_000 * SAT);
  assert(fewer[0].suggestedMsats === 60_000 * SAT && fewer[1].suggestedMsats === 10_000 * SAT,
    "hints are capped so the total never exceeds Main");
  const confirmed = applyRebuild(fewer.map((s) => ({ label: s.label, amountMsats: s.suggestedMsats })), 70_000 * SAT, T0 + 40);
  assert(confirmed.ok && allocatedMsats(confirmed.ledger) === 70_000 * SAT, "a confirmed rebuild lands within the balance");
  const greedy = applyRebuild([{ label: parsed!.labels[0], amountMsats: 80_000 * SAT }], 70_000 * SAT, T0 + 40);
  assert(!greedy.ok && greedy.reason === "exceeds-main", "a rebuild cannot claim more than Main holds");
  assert(parseStackLabelSnapshot(null) === null && parseStackLabelSnapshot({ version: 2, labels: [] }) === null,
    "an unreadable copy means start with Main");
  const hostile = parseStackLabelSnapshot({
    version: 1,
    savedAt: T0,
    labels: [
      { id: "a", name: "Ok", goalMsats: null, cadence: null, scheduleMsats: null, lastKnownMsats: 5 },
      { id: "b", name: "OK", goalMsats: null, cadence: null, scheduleMsats: null, lastKnownMsats: 5 },
      { id: "c", name: "Bad goal", goalMsats: -1 },
      { id: "d", name: "Bad cadence", cadence: "daily" },
      { id: "e", name: "Bad hint", lastKnownMsats: "lots" },
      "junk",
      { id: "f", name: "F" }, { id: "g", name: "G" }, { id: "h", name: "H" }, { id: "i", name: "I" },
    ],
  });
  assert(hostile !== null && hostile.labels.length === MAX_STACKS
    && hostile.labels.map((x) => x.id).join() === "a,e,f,g,h"
    && hostile.labels[1].lastKnownMsats === 0,
    "malformed, duplicate and sixth-onward labels are dropped; a bad hint becomes 0");
}

console.log(`\nStack ledger results: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
