import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../i18n/index.js";
import { setLocalStorageUserScope } from "../storage/user-scope.js";

// Chama is not a wallet (Jet, Oct 19): Home is the one place that lists the
// sats Chama holds for you, each with its way out, and says so plainly when it
// holds none. Me has no Wallet tab; it points at Home when sats need you.
const values = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); },
  removeItem: (k: string) => { values.delete(k); }, key: (i: number) => [...values.keys()][i] ?? null,
  get length() { return values.size; }, clear: () => values.clear(),
} });
const pk = "a".repeat(64);
setLocalStorageUserScope(pk);

const { HeldSats } = await import("./components/HeldSats.js");
const { HomeHero } = await import("./components/HomeHero.js");
const { MeScreen } = await import("./screens/MeScreen.js");
const { stashEcashExport, clearEcashExport } = await import("../payments/ecash-exports.js");
const { stashPendingRedemption, markPoisoned } = await import("../fedimint/pending-redemptions.js");

const calls: string[] = [];
const spy = (name: string) => () => { calls.push(name); };
type HeldProps = Parameters<typeof HeldSats>[0];
const held = (props: Partial<HeldProps> = {}) => renderToStaticMarkup(
  <LangProvider>
    <HeldSats pubkey={pk} balanceMsats={0} hasActiveCommitment={false} inTradeMsats={0}
      onRecoverSats={spy("recover")} onOpenTrade={spy("open")} onWithdrawEcash={spy("withdraw")}
      onUseWallet={spy("use-wallet")} {...props} />
  </LangProvider>,
);

{
  const empty = held();
  assert.match(empty, /data-held-sats-empty/);
  assert.match(empty, /Chama isn(’|'|&#x27;)t holding any of your sats\./, "nothing held is said in one plain line");
  assert.doesNotMatch(empty, /data-money-safety-focus|data-held-sats-balance/);
  assert.equal(held({ inTradeMsats: 5_000_000 }), "", "sats in a live trade are never called nothing; the trade rows show them");
  assert.equal(held({ balanceKnown: false }), "", "an unopened wallet is never reported as empty");
}

{
  const tap = held({ walletNeedsTap: true, balanceKnown: false });
  assert.match(tap, /data-held-sats-open/, "a signer that needs a tap gets a button to look");
  assert.doesNotMatch(tap, /data-held-sats-empty/);
  assert.deepEqual(calls, [], "rendering Home never starts the wallet or any money action");
  const src = readFileSync(new URL("./components/HeldSats.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /useEffect\([^)]*onUseWallet/, "the wallet starts on a tap, never on mount");
}

{
  // A leftover too small for a Lightning payout still shows, with its way out.
  const small = held({ balanceMsats: 500_000 });
  assert.match(small, /data-held-sats-balance/);
  assert.match(small, /Left in Chama:/);
  assert.match(small, /Withdraw as ecash/);
  assert.doesNotMatch(small, /data-held-sats-empty/);
  // While a pending lock or payout owns the balance, sending it out here would
  // abandon a resumable trade (#37): that card is the way out, not this one.
  assert.doesNotMatch(held({ balanceMsats: 500_000, hasPendingNativeLock: true }), /Withdraw as ecash/);
  assert.doesNotMatch(held({ balanceMsats: 500_000, hasPendingClaimPayout: true }), /Withdraw as ecash/);
  // A worthwhile leftover gets the recovery card, not a second balance line.
  const big = held({ balanceMsats: 50_000_000 });
  assert.match(big, /data-money-safety-focus="leftover"/);
  assert.doesNotMatch(big, /data-held-sats-balance/, "one line per place sats sit");
}

{
  stashEcashExport({ notes: "TEST-ONLY-note", amountMsats: 121_000, federationLabel: "Bitcoin Life" });
  const note = held();
  assert.match(note, /data-money-safety-focus="export"/, "a note being sent shows on Home");
  assert.match(note, /121/);
  assert.doesNotMatch(note, /data-held-sats-empty/);
  clearEcashExport();
}

{
  for (const [id, amount] of [["stranded-one", 2_000_000], ["stranded-two", 1_000_000]] as const) {
    stashPendingRedemption({ escrowId: id, oobNotes: `TEST-ONLY-${id}`, notesHash: "test", amountMsats: amount });
    markPoisoned(id, "Fixture: automatic retries exhausted");
  }
  const stuck = held({ onExportStrandedClaim: spy("export") as never,
    stuckNativeLocks: [{ escrowId: "stuck-lock", amountMsats: 1_500_000, createdAt: 1 } as never] });
  assert.equal((stuck.match(/data-money-safety-focus="/g) ?? []).length, 1, "one focused card");
  assert.ok((stuck.match(/data-money-safety-row="/g) ?? []).length >= 2, "every other entry stays visible");
  assert.doesNotMatch(stuck, /data-held-sats-empty/);

  // Me no longer draws these cards; it points at Home instead of "all clear".
  const me = renderToStaticMarkup(<LangProvider>
    <MeScreen pubkey={pk} myTrades={[]} ratings={null} balanceMsats={0} hasActiveCommitment={false}
      onOpenHome={spy("home")} onOpenTrade={spy("open")} onOpenSavedHandles={spy("handles")}
      onOpenPayoutDestinations={spy("ln")} onOpenAdvanced={spy("adv")} onOpenHelp={spy("help")}
      onRecoverSats={spy("recover")} onSignOut={spy("out")} onExportStrandedClaim={spy("export") as never} />
  </LangProvider>);
  assert.match(me, /data-me-held-sats/);
  assert.match(me, /See them on Home/);
  assert.doesNotMatch(me, /data-money-safety-focus/, "the recovery cards live on Home only");
  assert.doesNotMatch(me, />Wallet</, "Me has no Wallet tab");
  assert.deepEqual(calls, [], "rendering takes no money action");
}

{
  const hero = renderToStaticMarkup(<LangProvider>
    <HomeHero inEscrowMsats={0} readyToCollectCount={0} needsYou={[]} alsoGoingOn={[]} pubkey={pk}
      onOpenTrade={() => {}} heldSats={<p data-slot>held</p>} />
  </LangProvider>);
  assert.match(hero, /data-slot/, "Home places the held-sats list");
  assert.doesNotMatch(hero, /In your wallet|data-home-in-escrow/, "no balance hero and no zero tiles");

  const meSrc = readFileSync(new URL("./screens/MeScreen.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(meSrc, /\["sats", t\(/, "no Wallet pill");
  const settings = meSrc.slice(meSrc.indexOf('<MePane store={tabs} id="settings">'));
  const order = ['t("me.groupGettingPaid")', "<RecoveryKeyRow", 't("me.groupDisplay")'].map(s => settings.indexOf(s));
  assert.ok(order.every(i => i >= 0) && order[0] < order[1] && order[1] < order[2],
    "Settings opens with where you get paid, then your key");
  const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
  assert.match(app, /onTapStranded=\{\(\) => unseenPaidLockMsats > 0 \? \(setView\("dashboard"\)/, "the bar's stranded tap opens Home");
  assert.doesNotMatch(app, /setMeRequestTab\("sats"\)/);
  const keyRow = readFileSync(new URL("./components/RecoveryKey.tsx", import.meta.url), "utf8");
  assert.match(keyRow, /label=\{t\("backup\.rowTitle"\)\}/);
  assert.match(readFileSync(new URL("../i18n/en/me.ts", import.meta.url), "utf8"), /"backup\.rowHint": "Sign in on another device with it"/);
  const held = readFileSync(new URL("./components/HeldSats.tsx", import.meta.url), "utf8");
  assert.match(held, /acknowledgePaidLockRecoveries\(paidLockFederationId, balanceMsats\)/,
    "refunded paid-lock rows are acknowledged where they are shown");
}
console.log("PASS Home lists every sat Chama holds with its way out, says so when it holds none; Me has no Wallet tab");
