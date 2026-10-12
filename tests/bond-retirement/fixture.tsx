import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, getPublicKey } from "nostr-tools/pure";
import { setLocalStorageUserScope } from "../../src/storage/user-scope.js";
import { LangProvider } from "../../src/i18n/index.js";
import { applyThemeMode, T } from "../../src/ui/theme.js";
import { BondCeremonyModal } from "../../src/ui/panels/BondCeremonyModal.js";
import { DashboardScreen } from "../../src/ui/screens/DashboardScreen.js";
import { buildCommitmentBond } from "../../src/bond-multisig/commitment-bond.js";
import { upsertCommitmentBond, getCommitmentBond } from "../../src/bond-multisig/commitment-store.js";
import { buildBondAnnouncementEvent, type VerifiedBond } from "../../src/bond-multisig/bond-announcement.js";
import { MAINNET } from "../../src/bond-multisig/multisig.js";

// Disposable browser fixture. No relays, explorer, wallet or money actions.
const params = new URLSearchParams(location.search);
localStorage.clear();
localStorage.setItem("chama_lang", params.get("lang") ?? "en");
applyThemeMode(params.get("theme") === "dark" ? "dark" : "light");
const secret = new Uint8Array(32).fill(65), owner = getPublicKey(secret);
setLocalStorageUserScope(owner);
const bond = buildCommitmentBond(hexToBytes(owner), 970000, MAINNET);
const phase = params.get("phase") ?? "locked";
if (phase !== "empty") upsertCommitmentBond({ bondId: "fixture-bond", bond, amountSats: 21000n,
  phase: phase === "created" ? "created" : phase === "reclaimed" ? "reclaimed" : "locked", createdAt: Date.now(),
  ...(phase === "reclaimed" ? { reclaimTxid: "a".repeat(64), reclaimDestination: { requested: "external", actual: "external", address: bond.address } } : {}),
  utxos: [{ txid: "b".repeat(64), index: 0, amountSats: 21000n }] });
let announced: VerifiedBond = { npub: owner, community: "us-blf", address: bond.address,
  lockUntil: bond.lockUntil, claimedSats: 21000n, actualSats: 21000n, funded: true, active: phase !== "expired" && phase !== "reclaimed" && phase !== "empty",
  roles: params.has("arbiter") ? ["arbiter"] : ["merchant"], announcedAt: 100 };
const w = window as any; w.publications = []; w.moneyCalls = 0; w.buildCalls = []; w.reads = 0;
const money = async () => { w.moneyCalls++; throw Error("Money action forbidden in fixture"); };
function Fixture() {
  const [open, setOpen] = useState(params.has("open")), [revision, setRevision] = useState(0);
  return <main style={{ background: T.bg, color: T.text, minHeight: "100dvh" }}>
    <DashboardScreen pubkey={owner} ratings={null} myTrades={[]} communitySlug="us-blf"
      fetchMyBonds={async () => phase === "empty" ? [] : [announced]} getBondChainTip={async () => phase === "expired" ? 970100 : 960000}
      bondsRevision={revision} onOpenBondCeremony={() => setOpen(true)} />
    {open && <BondCeremonyModal createCommitmentBond={async p => {
        w.buildCalls.push({ amountSats: p.amountSats.toString(), termBlocks: p.termBlocks });
        const draft = buildCommitmentBond(hexToBytes(owner), 960000 + p.termBlocks, MAINNET);
        upsertCommitmentBond({ bondId: "fixture-draft", bond: draft, amountSats: p.amountSats, phase: "created", createdAt: Date.now() });
        return { bondId: "fixture-draft", address: draft.address, lockUntil: draft.lockUntil, amountSats: p.amountSats, tipAtCreate: 960000 };
      }} checkCommitmentFunding={async id => {
        w.reads++;
        if (!w.funded) return { locked: false };
        upsertCommitmentBond({ ...getCommitmentBond(id)!, phase: "locked" });
        return { locked: true, lockedSats: 21000n, deposits: 1 };
      }}
      getCommitmentReclaimQuote={async () => ({ finalityDelay: 10, minimumDepositSats: 1000, pegInFeeSats: 0, minerFeeSats: 200n, estimatedNetSats: 20800n })} renewCommitmentBond={money} reclaimCommitmentBond={money}
      creditReclaimedCommitmentBond={money} recoverMyBonds={async () => ({ recovered: 0 })}
      getBondChainTip={async () => phase === "expired" ? 970100 : 960000}
      fetchMyBonds={async () => phase === "empty" ? [] : [announced]}
      publishBondAnnouncement={async (...args) => {
        const [bondId, community, roles] = args;
        const event = finalizeEvent(buildBondAnnouncementEvent({ pubkey: owner, community,
          ownerXonly: bond.ownerXonly, lockUntil: bond.lockUntil, amountSats: 21000n,
          address: bond.address, network: MAINNET, roles, createdAt: 200 }), secret);
        w.publications.push({ args, payload: JSON.parse(event.content) });
        announced = { ...announced, community, roles: ["arbiter"], announcedAt: 200 };
        return { community, address: bond.address };
      }}
      onClose={() => { setOpen(false); setRevision(n => n + 1); }} />}
  </main>;
}
createRoot(document.getElementById("root")!).render(<LangProvider><Fixture /></LangProvider>);
