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
console.log("Brief 04 on-chain funding status: waiting, seen and confirmed are explicit");
