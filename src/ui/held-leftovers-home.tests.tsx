import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider, translate } from "../i18n/index.js";

// 6.4.31: Home lists the leftover places sats sit (readHeldLeftovers), each
// with who holds them, until when and at most one way out. A place Chama
// couldn't read says "couldn't check", never nothing. The on-chain key
// backup refusal (SEED_BACKUP_UNCONFIRMED) reaches the screen translated.
const { HeldLeftovers, leftoversShowSomething } = await import("./components/HeldLeftovers.js");
const { localizeSeedBackupError, withSeedBackupCopy } = await import("./seed-backup-copy.js");
const { SEED_BACKUP_UNCONFIRMED, SeedBackupUnconfirmed } = await import("../fedimint/seed-manager.js");
type Read = Parameters<typeof HeldLeftovers>[0]["result"];

const opened: string[] = [];
const render = (result: Read, onOpenBond?: () => void) => renderToStaticMarkup(
  <LangProvider>
    <HeldLeftovers result={result} onOpenTrade={id => opened.push(id)} onOpenBond={onOpenBond} onCheckAgain={() => {}} />
  </LangProvider>,
);
const en = (key: string) => translate("en", key).replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

{
  // Loading shows nothing yet, and nothing to show is nothing.
  assert.equal(render({ status: "loading" }), "");
  assert.equal(render({ status: "ok", data: { entries: [], unchecked: [] } }), "");
  assert.equal(leftoversShowSomething({ status: "ok", data: { entries: [], unchecked: [] } }), false);
  assert.equal(leftoversShowSomething({ status: "loading" }), false);
}

{
  // A failed read is "couldn't check", never an empty Home.
  const html = render({ status: "failed" });
  assert.ok(html.includes(en("dash.leftover.uncheckedAll")), "whole-read failure names it");
  assert.ok(html.includes(en("dash.leftover.checkAgain")));
  assert.equal(leftoversShowSomething({ status: "failed" }), true, "HeldSats must not return null on a failed read");
}

{
  // Each unreadable place is named once, alongside what was read.
  const result: Read = { status: "ok", data: {
    entries: [{ kind: "claim-retrying", id: "claim:t1", escrowId: "t1", amountMsats: 5_000_000, attempts: 2, holder: "federation", until: "automatic-retry" }],
    unchecked: [
      { source: "onchain-payouts", escrowId: "a", reason: "explorer down" },
      { source: "onchain-payouts", escrowId: "b", reason: "explorer down" },
      { source: "bonds", reason: "corrupt" },
    ],
  } };
  assert.equal(leftoversShowSomething(result), true);
  assert.equal(leftoversShowSomething({ status: "ok", data: { entries: [], unchecked: [{ source: "claims", reason: "x" }] } }), true,
    "unchecked alone still shows");
  const html = render(result);
  assert.ok(html.includes(en("dash.leftover.claimRetryingTitle")), "the readable entry still shows");
  assert.equal(html.split(en("dash.leftover.unchecked.onchain-payouts")).length - 1, 1, "one line per place");
  assert.ok(html.includes(en("dash.leftover.unchecked.bonds")));
}

{
  // Every kind: holder and until are on the card; the way out matches.
  const result: Read = { status: "ok", data: { unchecked: [], entries: [
    { kind: "claim-retrying", id: "claim:t1", escrowId: "t1", amountMsats: 5_000_000, attempts: 1, holder: "federation", until: "automatic-retry" },
    { kind: "fedi-funding-returning", id: "fedi-funding:t2", escrowId: "t2", amountMsats: 2_000_000, attempts: 0, holder: "fedi", until: "next-fedi-session" },
    { kind: "bond-key-waiting", id: "bond-key:b1", bondId: "b1", amountSats: 30_000n, address: "bc1q", holder: "your-key", until: "you-send-it-out" },
    { kind: "bond-credit-confirming", id: "bond-credit:b2", bondId: "b2", amountSats: 20_000n, txid: "ff", holder: "federation", until: "confirmations" },
    { kind: "onchain-payout", id: "onchain-payout:t3", escrowId: "t3", amountSats: 70_000n, address: "bc1p", unconfirmed: true, holder: "your-key", until: "you-send-it-out" },
  ] } };
  const html = render(result, () => opened.push("bond"));
  for (const kind of ["claim-retrying", "fedi-funding-returning", "bond-key-waiting", "bond-credit-confirming", "onchain-payout"]) {
    assert.ok(html.includes(`data-held-leftover="${kind}"`), kind);
  }
  assert.ok(html.includes('data-holder="your-key" data-until="you-send-it-out"'));
  assert.ok(html.includes(en("dash.leftover.fediReturningBodyNext")), "outside Fedi it says to open Chama in Fedi");
  assert.ok(html.includes(en("dash.leftover.onchainPayoutUnconfirmed")));
  assert.ok(html.includes(en("dash.leftover.bondKeyCta")) && html.includes(en("dash.leftover.onchainPayoutCta")));
  // Bond credit confirming has no button: nothing to do but wait.
  const credit = html.slice(html.indexOf('data-held-leftover="bond-credit-confirming"'), html.indexOf('data-held-leftover="onchain-payout"'));
  assert.ok(!credit.includes("<button"), "confirming bond has no action");
  // Amounts: msats round down to sats; bigint sats shown as-is.
  assert.ok(html.includes("5,000") || html.includes("5 000") || html.includes("5000"));
  // Without a bond screen, the bond-key card has no dead button.
  const noBond = render(result);
  const bondCard = noBond.slice(noBond.indexOf('data-held-leftover="bond-key-waiting"'), noBond.indexOf('data-held-leftover="bond-credit-confirming"'));
  assert.ok(!bondCard.includes("<button"));
}

{
  // The refusal is translated with code and problem kept; other errors pass.
  const refusal = new SeedBackupUnconfirmed("not-on-relays");
  const fr = localizeSeedBackupError(refusal, "fr") as Error & { code: string; problem: string };
  assert.equal(fr.code, SEED_BACKUP_UNCONFIRMED);
  assert.equal(fr.problem, "not-on-relays");
  assert.equal(fr.message, translate("fr", "onchain.seedBackupUnconfirmed"));
  const sw = localizeSeedBackupError(new SeedBackupUnconfirmed("different-seed-on-relays"), "sw") as Error;
  assert.equal(sw.message, translate("sw", "onchain.seedBackupDifferent"));
  const other = new Error("boom");
  assert.equal(localizeSeedBackupError(other, "es"), other);
  // English copy matches seed-manager's own message, so the wording agrees.
  assert.equal((localizeSeedBackupError(refusal, "en") as Error).message, refusal.message, "en copy matches seed-manager");
  assert.equal((localizeSeedBackupError(new SeedBackupUnconfirmed("different-seed-on-relays"), "en") as Error).message,
    new SeedBackupUnconfirmed("different-seed-on-relays").message);
  // Wrapped actions rethrow translated, and resolve unchanged.
  await assert.rejects(withSeedBackupCopy(async () => { throw refusal; })(), (e: any) => e.code === SEED_BACKUP_UNCONFIRMED);
  assert.equal(await withSeedBackupCopy(async (n: number) => n + 1)(1), 2);
}

{
  // Wiring: App wraps the three refusing actions and feeds Home the reader.
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  for (const name of ["createEscrow", "joinEscrow", "prepareOnchainFunding"]) {
    assert.ok(app.includes(`${name}: withSeedBackupCopy(rawActions.${name})`), name);
  }
  assert.ok(app.includes("readLeftovers={actions.readHeldLeftovers}"));
  const held = readFileSync(new URL("./components/HeldSats.tsx", import.meta.url), "utf8");
  assert.ok(held.includes("!leftoversShowSomething(leftovers.result)"), "HeldSats keeps leftovers out of the empty check");
  assert.ok(held.includes("<HeldLeftovers "));
}

console.log("Home leftovers: every kind with holder/until and one way out, unchecked never empty, translated backup refusal passed");
