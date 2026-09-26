import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { LangProvider } from "../i18n/index.js";
import { OnchainEscrowPanel } from "./panels/OnchainEscrowPanel.js";
import type { OnchainEscrowView } from "../escrow-engine/onchain-escrow-view.js";

const view: OnchainEscrowView = {
  stage: "awaiting-funding", address: "bc1ptestaddress", expectedSats: 100_000n,
  blockers: [], viewerFunds: true, fundingTxid: null, appealWindow: null,
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
assert.match(buyerHtml, /next time they open Chama/);
console.log("Brief 04 on-chain funding status: waiting, seen and confirmed are explicit");

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
