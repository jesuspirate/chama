import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../i18n/index.js";
import { OnchainEscrowPanel } from "./panels/OnchainEscrowPanel.js";
import type { OnchainEscrowView } from "../escrow-engine/onchain-escrow-view.js";

const view: OnchainEscrowView = {
  stage: "awaiting-funding", address: "bc1ptestaddress", expectedSats: 100_000n,
  blockers: [], viewerFunds: true, fundingTxid: null, payoutTxid: null, payoutAddress: null, appealWindow: null,
  canSettle: false, viewerMustPublishKey: false,
};
const render = (depositStatus: "waiting" | "seen" | "confirmed", fundingNote: string | null) =>
  renderToStaticMarkup(<LangProvider><OnchainEscrowPanel view={view} network="mainnet"
    depositStatus={depositStatus} fundingNote={fundingNote} onCheckFunding={() => {}} /></LangProvider>);

const waiting = render("waiting", "No confirmed deposit at the escrow address yet.");
assert.match(waiting, /Waiting for the deposit/);
assert.doesNotMatch(waiting, /Deposit seen; waiting for confirmation/);
assert.match(render("seen", null), /Deposit seen; waiting for confirmation/);
assert.match(render("confirmed", null), /Deposit confirmed/);
const buyerHtml = renderToStaticMarkup(<LangProvider><OnchainEscrowPanel view={{ ...view, viewerFunds: false }} network="mainnet" depositStatus="confirmed" /></LangProvider>);
assert.match(buyerHtml, /funder next opens Chama/);
// Jet's final pass: the buyer read "Deposit: N sats" beside the QR as "pay
// this". The non-funder is told who deposits and that they send nothing.
const buyerWaiting = renderToStaticMarkup(<LangProvider><OnchainEscrowPanel view={{ ...view, viewerFunds: false }} network="mainnet" depositStatus="waiting" funderName="Jetty" /></LangProvider>);
assert.match(buyerWaiting, /Jetty deposits 100,000 sats at this address\./);
assert.match(buyerWaiting, /You don(&#x27;|')t send anything to this address\./);
assert.doesNotMatch(buyerWaiting, /Deposit: |Send 100,000 sats/);
assert.match(buyerHtml, /The person funding this trade deposits 100,000 sats/, "unnamed funder still named by role");
assert.match(waiting, /Send 100,000 sats to this address/);
assert.doesNotMatch(waiting, /don(&#x27;|')t send anything/);
assert.match(render("seen", null), /Deposit: 100,000 sats/);
console.log("Brief 04 on-chain funding status: waiting, seen and confirmed are explicit; non-funder is told they send nothing");

// Both guided and full trade controls render this panel. Read-only buyers get
// the independently derived address/history, never a fund or signing action.
assert.match(buyerHtml, /\/address\/bc1ptestaddress/);
assert.doesNotMatch(buyerHtml, /I have sent it/);
for (const ok of [true, false]) for (const canSign of [true, false]) {
  const html = renderToStaticMarkup(<LangProvider><OnchainEscrowPanel
    view={{ ...view, stage: 'settling', canSettle: true }} network="mainnet"
    settlementCheck={{ ok, failures: ok ? [] : ['changed destination'] }}
    onSign={canSign ? () => {} : undefined} /></LangProvider>);
  const sign = html.match(/<button[^>]*>Sign the payout<\/button>/)?.[0];
  assert.ok(sign);
  assert.equal(sign.includes('disabled'), !ok || !canSign, 'signing needs a passed check and an eligible signer');
}
