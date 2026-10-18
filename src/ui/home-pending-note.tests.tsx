import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../i18n/index.js";
import { HomeHero } from "./components/HomeHero.js";

// Jet (6.4.26 rc.8): after "Withdraw as ecash" the wallet read ₿0 on Home and
// only Me mentioned the note, so ₿121 looked lost. While a note is pending,
// Home names it and points to Me.
const render = (pendingNoteMsats?: number) => renderToStaticMarkup(
  <LangProvider>
    <HomeHero balanceMsats={0} inEscrowMsats={0} readyToCollectCount={0} needsYou={[]} alsoGoingOn={[]}
      pubkey={"a".repeat(64)} onOpenTrade={() => {}} pendingNoteMsats={pendingNoteMsats} onOpenPendingNote={() => {}} />
  </LangProvider>,
);

const withNote = render(121_000);
assert.match(withNote, /data-home-pending-note/, "a pending note is named on Home");
assert.match(withNote, /₿121 waiting in an ecash note · open it in Me/, "with its amount and where to find it");
assert.doesNotMatch(render(0), /data-home-pending-note/, "no line without a pending note");
assert.doesNotMatch(render(undefined), /data-home-pending-note/, "no line when the caller passes nothing");

const app = readFileSync(new URL("./App.tsx", import.meta.url), "utf8");
assert.match(app, /pendingNoteMsats=\{getEcashExport\(\)\?\.amountMsats \?\? 0\}/, "Home reads the same pending export Me shows");
assert.match(app, /onOpenPendingNote=\{\(\) => \{ setView\("me"\)/, "tapping it opens Me, where the note's card is");

for (const lang of ["es", "fr", "sw"]) {
  const dash = readFileSync(new URL(`../i18n/${lang}/dash.ts`, import.meta.url), "utf8");
  assert.match(dash, /"dash\.pendingNote": "₿\{sats\} /, `${lang} has the line with its amount`);
}
console.log("PASS Home: a pending ecash note is named with its amount and opens Me");
