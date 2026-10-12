import assert from "node:assert/strict";

// The sandbox's one-tap claim mints a sim invoice and pays it through the
// ordinary claim dispatch. These pin the two facts that make that safe:
// the sim wallet reads back exactly the claimed amount, and the string can
// never be mistaken for a real Lightning invoice.

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

const { sandboxClaimInvoice, parseBolt11Msats, createSimWallet } = await import("./sim-wallet.js");

for (const sats of [1, 495, 500, 123_456]) {
  const invoice = sandboxClaimInvoice(sats);
  assert.equal(parseBolt11Msats(invoice), sats * 1000, `${sats} sats round-trips through the sim parser`);
  assert.match(invoice, /^lnbcsim\d+n1p/, "carries the sim-only prefix, not a mainnet lnbc");
}
assert.throws(() => sandboxClaimInvoice(0));
assert.throws(() => sandboxClaimInvoice(49.5));

// End to end against the mock: a funded sim wallet pays the minted invoice
// and is debited by exactly the claimed amount.
const wallet = createSimWallet({ npub: null });
await wallet.joinFederation("sim");
await wallet.mint.redeemEcash("SBX_sim0v1_1_1000000"); // 1,000 sats of sim notes
const funded = await wallet.balance.getBalance();
assert.ok(funded >= 1_000_000, "sim wallet funded for the test");
await wallet.lightning.payInvoice(sandboxClaimInvoice(495));
assert.equal(await wallet.balance.getBalance(), funded - 495_000, "sim wallet debited by exactly the claimed sats");
await wallet.cleanup();
console.log("✓ sandbox claim: invoice round-trips and the sim wallet settles it");
