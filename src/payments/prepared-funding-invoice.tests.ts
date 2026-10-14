// Lock invoice, Step 2b: an invoice asked for when the Lock hold begins is
// adopted only by the funding flow, only on identical terms, and is
// otherwise abandoned unshown. Asserts the journal's record of every invoice
// and that nothing reaches a payer before adoption.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  EventRelay, PREPARED_INVOICE_MAX_AGE_MS, PREPARED_EXPIRY_SLACK_SECONDS,
  abandonPreparedInvoice, adoptPreparedInvoice, isPreparing, prepareInvoice, resetPreparedInvoice, sameTerms,
  type PreparedInvoiceTerms,
} from "./prepared-funding-invoice.js";

let now = 1_700_000_000_000;
const terms: PreparedInvoiceTerms = {
  escrowId: "trade-1", federationId: "fed-a", amountMsats: 25_062_000, description: "Chama trade · Fund Escrow",
  savedHandleId: "h1", paymentDetailsInChat: false, itemsKey: "", seatDeadline: 1_700_003_600,
};
const EXPIRY = 855;
const journal = () => {
  const log: string[] = [];
  return { log, record: (i: string) => { log.push(`record ${i}`); }, stop: (locked: boolean) => { log.push(`stop ${locked}`); } };
};
type S = string; type G = { operationId: string };
const creator = (bolt11: string | Error, events: Array<["state", S] | ["gateway", G]> = []) => {
  const c = {
    calls: 0,
    create: async (onState: (s: S) => void, onGateway: (g: G) => void) => {
      c.calls++;
      for (const [kind, value] of events) kind === "state" ? onState(value as S) : onGateway(value as G);
      if (bolt11 instanceof Error) throw bolt11;
      return bolt11;
    },
  };
  return c;
};
const settle = () => new Promise(r => setTimeout(r, 0));

{
  // Identical terms, completed hold: adopted once, events replayed gateway
  // first, then forwarded; the prepared journal recorded it and is not
  // stopped (the flow's journal owns its final state).
  resetPreparedInvoice(() => now);
  const j = journal(), c = creator("lnbc1prepared", [["state", "created"], ["gateway", { operationId: "op-1" }], ["state", "awaiting_funds"]]);
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: c.create });
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: c.create });
  assert.equal(c.calls, 1, "one invoice per hold");
  assert.ok(isPreparing("trade-1"));
  now += 1_300;
  const seen: string[] = [];
  const bolt11 = await adoptPreparedInvoice<S, G>({ ...terms }, EXPIRY, s => seen.push(`state ${s}`), g => seen.push(`gateway ${g.operationId}`));
  assert.equal(bolt11, "lnbc1prepared");
  assert.deepEqual(seen, ["gateway op-1", "state created", "state awaiting_funds"]);
  assert.deepEqual(j.log, ["record lnbc1prepared"], "recorded before it could be shown; not marked abandoned");
  assert.equal(isPreparing(), false);
  assert.equal(await adoptPreparedInvoice<S, G>(terms, EXPIRY), null, "adopted once only");
  abandonPreparedInvoice();
  assert.deepEqual(j.log, ["record lnbc1prepared"], "abandon after adoption changes nothing");
}

{
  // Lifted hold: abandoned unshown; later events are dropped, and the flow
  // finds nothing to adopt.
  resetPreparedInvoice(() => now);
  const j = journal(), c = creator("lnbc1lifted");
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: c.create });
  await settle();
  abandonPreparedInvoice();
  assert.deepEqual(j.log, ["record lnbc1lifted", "stop false"]);
  assert.equal(await adoptPreparedInvoice<S, G>(terms, EXPIRY), null);
}

{
  // Lifted while the federation is still making it: the journal still ends
  // abandoned (stop first; the later record keeps the abandoned state).
  resetPreparedInvoice(() => now);
  const j = journal();
  let release!: (v: string) => void;
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: () => new Promise<string>(r => { release = r; }) });
  abandonPreparedInvoice();
  release("lnbc1late");
  await settle();
  assert.deepEqual(j.log, ["stop false", "record lnbc1late"]);
}

{
  // Any different term: abandoned, and the flow makes a fresh invoice.
  const variants: Array<Partial<PreparedInvoiceTerms>> = [
    { escrowId: "trade-2" }, { federationId: "fed-b" }, { amountMsats: 25_000_000 }, { description: "Chama trade · Lock Sats" },
    { savedHandleId: "h2" }, { savedHandleId: undefined, paymentDetailsInChat: true }, { itemsKey: "[{\"id\":\"x\"}]" }, { seatDeadline: 1_700_003_000 },
  ];
  for (const change of variants) {
    resetPreparedInvoice(() => now);
    const j = journal();
    prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: creator("lnbc1x").create });
    await settle();
    assert.equal(sameTerms(terms, { ...terms, ...change }), false, JSON.stringify(change));
    assert.equal(await adoptPreparedInvoice<S, G>({ ...terms, ...change }, EXPIRY), null, JSON.stringify(change));
    assert.deepEqual(j.log, ["record lnbc1x", "stop false"], `abandoned on ${JSON.stringify(change)}`);
  }
}

{
  // Too old, or expiring later than a fresh invoice would, or much earlier:
  // abandoned, fresh one made.
  for (const [age, expiry] of [[PREPARED_INVOICE_MAX_AGE_MS, EXPIRY], [1_000, EXPIRY - 10], [(PREPARED_EXPIRY_SLACK_SECONDS + 5) * 1000, EXPIRY]] as const) {
    resetPreparedInvoice(() => now);
    const j = journal();
    prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: creator("lnbc1old").create });
    await settle();
    now += age;
    assert.equal(await adoptPreparedInvoice<S, G>(terms, expiry), null, `age ${age} expiry ${expiry}`);
    assert.deepEqual(j.log, ["record lnbc1old", "stop false"]);
  }
  // A shorter-lived fresh request (seat nearer) refuses an invoice that would
  // outlive it: never later than a fresh invoice.
  resetPreparedInvoice(() => now);
  const j = journal();
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: creator("lnbc1long").create });
  await settle();
  now += 1_200;
  assert.equal(await adoptPreparedInvoice<S, G>(terms, EXPIRY - 30), null);
}

{
  // A failed preparation leaves nothing; the flow creates a fresh invoice.
  resetPreparedInvoice(() => now);
  const j = journal();
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j, create: creator(new Error("gateway down")).create });
  await settle();
  assert.equal(isPreparing(), false);
  assert.equal(await adoptPreparedInvoice<S, G>(terms, EXPIRY), null);
  assert.deepEqual(j.log, ["stop false"]);
  // Failing after adoption began: null, journal stopped, fresh invoice next.
  resetPreparedInvoice(() => now);
  const j2 = journal();
  let fail!: (e: Error) => void;
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j2, create: () => new Promise<string>((_, rej) => { fail = rej; }) });
  const adopting = adoptPreparedInvoice<S, G>(terms, EXPIRY);
  fail(new Error("timeout"));
  assert.equal(await adopting, null);
  assert.deepEqual(j2.log, ["stop false"]);
}

{
  // A new hold for another trade abandons the old prepared invoice first.
  resetPreparedInvoice(() => now);
  const j1 = journal(), j2 = journal();
  prepareInvoice<S, G>({ terms, expirySeconds: EXPIRY, journal: j1, create: creator("lnbc1a").create });
  await settle();
  prepareInvoice<S, G>({ terms: { ...terms, escrowId: "trade-2" }, expirySeconds: EXPIRY, journal: j2, create: creator("lnbc1b").create });
  assert.deepEqual(j1.log, ["record lnbc1a", "stop false"]);
  assert.equal(await adoptPreparedInvoice<S, G>({ ...terms, escrowId: "trade-2" }, EXPIRY), "lnbc1b");
}

{
  // The relay: closed relays drop everything; attach happens once.
  const r = new EventRelay<S, G>();
  r.state("a"); r.close(); r.state("b");
  const seen: string[] = [];
  r.attach(s => seen.push(s));
  assert.deepEqual(seen, [], "a closed relay forwards nothing");
}
console.log("PASS prepared Lock invoice: adopted only on identical terms by the funding flow; otherwise abandoned unshown and journalled");

{
  // Wiring: prepared only on press, adopted only inside runFundAndLock's
  // invoice step (after settle and a fresh preflight), the same lifetime rule
  // and seat check as a fresh invoice, and nothing shown before adoption.
  const hook = readFileSync(new URL("../hooks/useEscrow.ts", import.meta.url), "utf8");
  const adapterAt = hook.indexOf("createFundingInvoice: async (amountMsats, description, onReceiveState, onGateway, expirySeconds) => {");
  const adapter = hook.slice(adapterAt, adapterAt + 2_400);
  assert.match(adapter, /const fresh = await requireBridge\(\)\.preflightLock\([\s\S]*const adopted = isSimModeOn\(\) \? null : await adoptPreparedInvoice/, "a fresh preflight runs before adoption");
  assert.match(adapter, /const invoice = adopted \?\? await createFundingInvoice\(/);
  assert.match(adapter, /invoiceJournal\?\.record\(invoice\);\s*assertFundingInvoiceWithinSeat\(invoice, fresh\.seatDeadline\);/, "adopted or fresh, the same seat check and journal");
  assert.equal((hook.match(/adoptPreparedInvoice</g) ?? []).length, 1, "adopted in one place only");
  const settleAt = hook.indexOf("settlePendingNativeLock(escrowId, {");
  assert.ok(settleAt > 0 && settleAt < adapterAt, "the #37 settle runs before the invoice step");
  const prep = hook.slice(hook.indexOf("const prepareFundingInvoiceAction = useCallback("), hook.indexOf("// R3-1b: re-attach to a submitted payout"));
  assert.match(prep, /if \(getPendingNativeLock\(escrowId\)\) return;/, "never beside a prior attempt");
  assert.match(prep, /if \(inflight && !inflight\.aborted\) return;/, "never beside a running funding flow");
  assert.match(prep, /hasFediInternalGenerateEcash\(\) \|\| isFediMiniAppRuntime\(\) \|\| hasFediInternalEcash\(\)/);
  assert.match(prep, /const journal = createFundingInvoiceJournal\(\{ escrowId, amountMsats, federationId \}\);/, "journalled like any funding invoice");
  assert.doesNotMatch(prep, /payInvoice|lockAndPublish|onPhase|autoPay|spend/, "preparing never pays, locks or shows");
  assert.match(hook, /const PAYMENT_DEADLINE_SECONDS = 900;/);
  const fal = readFileSync(new URL("./fund-and-lock.ts", import.meta.url), "utf8");
  assert.match(fal, /export const DEFAULT_PAYMENT_DEADLINE_MS = 15 \* 60 \* 1000;/, "the prepared lifetime uses the flow's payment deadline");
  const app = readFileSync(new URL("../ui/App.tsx", import.meta.url), "utf8");
  assert.match(app, /onLockHoldStart=\{lockOpts => primeLockPath\(selected, lockOpts\)\}\s*onLockHoldCancel=\{\(\) => actions\.abandonPreparedFundingInvoice\(\)\}/);
  const lts = readFileSync(new URL("../ui/screens/LiveTradeSurface.tsx", import.meta.url), "utf8");
  assert.match(lts, /onHoldStart=\{onLockHoldStart && \(\(\) => onLockHoldStart\(lockOpts\(\)\)\)\}\s*onHoldCancel=\{onLockHoldCancel\}\s*onConfirm=\{\(\) => run\(\(\) => onLock\(lockOpts\(\)\)\)\}/, "press and confirm use the same options");
}
console.log("PASS prepared Lock invoice wiring: press prepares, the funding flow adopts after settle and preflight, same seat check and journal");
