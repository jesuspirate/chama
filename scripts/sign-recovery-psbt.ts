// ─────────────────────────────────────────────────────────────────────────────
// Operator signing tool for the funded-but-frozen parent escrow recovery PSBT.
//
// Reads the mnemonic from a hidden TTY prompt so it never appears in argv, env,
// or shell history. Reads the unsigned/partially-signed PSBT from a file or
// stdin. Verifies live funding and the settlement expectation locally, adds this
// party's signature, and prints the updated base64 PSBT to stdout.
//
// Usage:
//   npx tsx scripts/sign-recovery-psbt.ts \
//     --role buyer \
//     --parent-id sm_msl0k7rp_gyuf2w0i \
//     --expected-address tb1p... \
//     --buyer-key <64-hex> \
//     --seller-key <64-hex> \
//     --arbiter-key <64-hex> \
//     --funder seller \
//     --network signet \
//     --refund-lock-until <height> \
//     --txid <64-hex> \
//     --vout 0 \
//     --amount-sats 100000 \
//     --destination tb1p... \
//     --max-fee-sats 500 \
//     [--psbt-file unsigned.psbt]
// ─────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from "node:url";
import {
  checkRecoveryPsbt,
  deriveRecoverySigningKey,
  hiddenPrompt,
  parseSignerArgs,
  readPsbt,
  signRecoveryPsbt,
  verifyRecoveryFunding,
  zeroKeyBuffers,
} from "./recovery-signer-shared.js";

export async function main(argv: string[]): Promise<void> {
  const inputs = parseSignerArgs(argv);
  const psbtB64 = await readPsbt(inputs.psbtFile);

  const verified = await verifyRecoveryFunding(inputs);
  const check = checkRecoveryPsbt(psbtB64, inputs, verified.escrow);
  if (!check.ok) {
    throw new Error(`Recovery PSBT verification failed:\n${check.failures.join("\n")}`);
  }

  const roleDisplay = inputs.role === "buyer" ? "buyer" : "seller";
  let mnemonic = await hiddenPrompt(`Enter ${roleDisplay} mnemonic`);
  if (!mnemonic) throw new Error("Mnemonic is required");

  let key;
  try {
    key = deriveRecoverySigningKey(mnemonic, inputs.parentId, inputs.network);
  } finally {
    // Best-effort: drop the mnemonic reference so it can be GC'd.
    mnemonic = "";
  }

  // Verify the derived public key matches the expected recovery escrow key.
  const expectedKey = inputs.role === "buyer" ? inputs.buyerKey : inputs.sellerKey;
  const derivedHex = bytesToHex(key.xonly);
  if (derivedHex !== expectedKey) {
    zeroKeyBuffers(key.priv, key.xonly);
    throw new Error(
      `Derived ${roleDisplay} key does not match expected key:\n  expected: ${expectedKey}\n  derived:  ${derivedHex}`,
    );
  }

  let signedPsbt: string;
  try {
    signedPsbt = signRecoveryPsbt(psbtB64, key.priv);
  } finally {
    zeroKeyBuffers(key.priv, key.xonly);
  }

  console.log(signedPsbt);
}

import { bytesToHex } from "@noble/hashes/utils.js";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
