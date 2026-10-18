// 6.4.27: putting a pending ecash note back ("Cancel send · return to my
// balance") on a federation that charges a reissue fee. On the play-sats
// federation (2026-10-18) every put-back credited the note minus ~12 sats on
// 50,000, so the exact balance rule called a successful put-back "unknown"
// and kept offering a note that was already spent. The fee is now allowed;
// zero, an over-credit and a large shortfall still stay unknown.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isThisNotesCredit,
  reabsorbBearerNotes,
  reissueFeeAllowanceMsats,
  type ReabsorbWallet,
} from "./reabsorb-bearer-notes.js";
import { translate } from "../i18n/index.js";

const sats = (n: number) => n * 1000;

/** A wallet whose reissue credits `credit` msats (or throws). */
function wallet(opts: { balance: number; credit: number; throws?: Error; noteFed?: string; walletFed?: string }): ReabsorbWallet & { redeemed: number } {
  let balance = opts.balance;
  const w = {
    redeemed: 0,
    parseNotes: async () => ({ totalAmount: 0, federationId: opts.noteFed }),
    getFederationId: () => opts.walletFed ?? null,
    getBalance: async () => balance,
    redeemWithRetry: async () => {
      w.redeemed += 1;
      balance += opts.credit;
      if (opts.throws) throw opts.throws;
    },
  };
  return w;
}

const probe = (w: ReabsorbWallet, expectedMsats: number) =>
  reabsorbBearerNotes(w, { oobNotes: `note-${Math.random()}`, expectedMsats, context: "pending-export" });

{
  // The allowance: 0.5% of the note, never under 10 sats.
  assert.equal(reissueFeeAllowanceMsats(sats(121)), sats(10));
  assert.equal(reissueFeeAllowanceMsats(sats(50_000)), sats(250));
  assert.equal(isThisNotesCredit(sats(49_740), sats(50_000)), false, "260 sats short on 50,000 is not a fee");
  // Measured on the play-sats federation.
  assert.equal(isThisNotesCredit(49_982_078 - 0, 49_993_998), true, "full balance, 11.92 sats fee");
  assert.equal(isThisNotesCredit(20_000_000 - 1_904, 20_000_000), true, "20,000 sats, 1.9 sats fee");
  // Exact still counts.
  assert.equal(isThisNotesCredit(sats(121), sats(121)), true);
  // Never zero, never more than the note, never a large shortfall.
  assert.equal(isThisNotesCredit(0, sats(121)), false, "no credit is never a put-back");
  assert.equal(isThisNotesCredit(sats(122), sats(121)), false, "an over-credit is something else too");
  assert.equal(isThisNotesCredit(sats(100), sats(121)), false, "21 sats short is more than a fee");
  assert.equal(isThisNotesCredit(sats(2), sats(5)), false, "less than half the note is never this note");
  assert.equal(isThisNotesCredit(-sats(1), sats(121)), false);
  assert.equal(isThisNotesCredit(sats(121), 0), false);
}
console.log("PASS reissue fee allowance: fee-short credits count, zero/over/large shortfalls do not");

{
  // A clean reissue short by a fee is recovered, and reports what arrived.
  const w = wallet({ balance: 0, credit: sats(119) });
  const r = await probe(w, sats(121));
  assert.equal(r.outcome, "recovered");
  assert.equal(r.outcome === "recovered" && r.recoveredMsats, sats(119));
  assert.equal(r.outcome === "recovered" && r.expectedMsats, sats(121));
  assert.equal(w.redeemed, 1, "one reissue per tap");

  // Exact is still recovered.
  const exact = await probe(wallet({ balance: sats(5), credit: sats(121) }), sats(121));
  assert.equal(exact.outcome, "recovered");

  // The 2026-08-19 case: success reported, balance did not move. Still unknown,
  // so the card stays. Same for a repeated reissue that reattaches to the old
  // operation and answers "done" without crediting again.
  const none = await probe(wallet({ balance: sats(121), credit: 0 }), sats(121));
  assert.equal(none.outcome, "unknown");

  // A shortfall bigger than a fee is not this note.
  const short = await probe(wallet({ balance: 0, credit: sats(90) }), sats(121));
  assert.equal(short.outcome, "unknown");

  // An over-credit (a Lightning receive landing in the window) is not this note.
  const over = await probe(wallet({ balance: 0, credit: sats(200) }), sats(121));
  assert.equal(over.outcome, "unknown");

  // After a non-definitive throw (timeout) the same window applies: a
  // fee-short late credit is this note's, a larger shortfall is not.
  const late = await probe(wallet({ balance: 0, credit: sats(119), throws: new Error("timeout") }), sats(121));
  assert.equal(late.outcome, "recovered");
  assert.equal(late.outcome === "recovered" && late.lateCredit, true);
  const lateShort = await probe(wallet({ balance: 0, credit: sats(90), throws: new Error("timeout") }), sats(121));
  assert.equal(lateShort.outcome, "unknown");
  // A definitive rejection outranks any balance movement in the window.
  const rejected = await probe(wallet({ balance: 0, credit: sats(121), throws: new Error("note already spent") }), sats(121));
  assert.equal(rejected.outcome, "consumed-uncredited");

  // A foreign note is never reissued here.
  const foreign = wallet({ balance: 0, credit: sats(121), noteFed: "aaaa", walletFed: "bbbb" });
  assert.equal((await probe(foreign, sats(121))).outcome, "foreign");
  assert.equal(foreign.redeemed, 0, "no reissue on the wrong federation");
}
console.log("PASS put-back probe: fee-short success or late credit recovers; no credit, big shortfall, over-credit and rejections do not");

{
  // The person is told the fee, in every language, and "nothing changed"
  // stays on screen until tapped.
  for (const lang of ["en", "es", "fr", "sw"] as const) {
    const text = translate(lang, "app.reabsorbRecoveredFee", { sats: "119", fee: "2" });
    assert.ok(text.includes("119") && text.includes("2"), `${lang}: ${text}`);
    assert.notEqual(text, "app.reabsorbRecoveredFee", `${lang} has the key`);
  }
  const app = readFileSync(new URL("../ui/App.tsx", import.meta.url), "utf8");
  const block = app.slice(app.indexOf("const handleReabsorbBearerNotes"), app.indexOf("return result.outcome;"));
  assert.match(block, /app\.reabsorbRecoveredFee/);
  const unknownToast = block.slice(block.indexOf("app.reabsorbForeign"));
  assert.match(unknownToast, /sticky: true/, "unknown/foreign answer stays until tapped");
  const threw = block.slice(block.indexOf("reabsorb probe threw"), block.indexOf("const pending"));
  assert.match(threw, /sticky: true/, "a probe that threw also stays until tapped");
}
console.log("PASS put-back copy: the fee is named in en/es/fr/sw and 'nothing changed' stays on screen");
