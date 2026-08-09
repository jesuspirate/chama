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
//     --expected-fee-sats 162 \
//     [--psbt-file unsigned.psbt]
// ─────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from "node:url";
import {
  checkRecoveryPsbt,
  assertRoleKeyMatch,
  deriveRecoverySigningKey,
  hasSignerSignature,
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
  try {
    assertRoleKeyMatch(inputs, key.xonly);
  } catch (error) {
    zeroKeyBuffers(key.priv, key.xonly);
    throw error;
  }

  let signedPsbt: string;
  try {
    signedPsbt = signRecoveryPsbt(psbtB64, key.priv);
  } finally {
    zeroKeyBuffers(key.priv, key.xonly);
  }

  // Re-verify after signing: the signature must be present and every structural
  // check (input, destination, payout, fee, SIGHASH_DEFAULT) must still pass.
  if (!hasSignerSignature(signedPsbt, expectedKey, verified.escrow)) {
    throw new Error(`Signature for ${roleDisplay} was not produced`);
  }
  const postCheck = checkRecoveryPsbt(signedPsbt, inputs, verified.escrow);
  if (!postCheck.ok) {
    throw new Error(`Post-sign PSBT verification failed:\n${postCheck.failures.join("\n")}`);
  }

  console.log(signedPsbt);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
