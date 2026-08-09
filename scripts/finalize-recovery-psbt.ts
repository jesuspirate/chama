// ─────────────────────────────────────────────────────────────────────────────
// Recovery PSBT finalizer for the funded-but-frozen parent escrow.
//
// Takes one or more partially signed PSBTs, verifies live funding and the
// settlement expectation locally, combines the signatures, finalizes the
// cooperative spend, and prints the raw transaction hex and txid to stdout.
//
// This script does NOT broadcast. The operator must review the raw tx and
// broadcast it explicitly.
//
// Usage:
//   npx tsx scripts/finalize-recovery-psbt.ts \
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
//     --psbt-file buyer-signed.psbt \
//     --psbt-file seller-signed.psbt
// ─────────────────────────────────────────────────────────────────────────────
import { pathToFileURL } from "node:url";
import {
  checkRecoveryPsbt,
  combineAndFinalizeRecoveryPsbt,
  parseFinalizerArgs,
  readPsbt,
  verifyRecoveryFunding,
} from "./recovery-signer-shared.js";

export async function main(argv: string[]): Promise<void> {
  const inputs = parseFinalizerArgs(argv);

  const psbts: string[] = [];
  for (const file of inputs.psbtFiles) {
    psbts.push(await readPsbt(file === "-" ? undefined : file));
  }

  const verified = await verifyRecoveryFunding(inputs);

  for (let i = 0; i < psbts.length; i++) {
    const check = checkRecoveryPsbt(psbts[i], inputs, verified.escrow);
    if (!check.ok) {
      throw new Error(`PSBT ${i + 1} verification failed:\n${check.failures.join("\n")}`);
    }
  }

  const { txHex, txid } = combineAndFinalizeRecoveryPsbt(psbts, verified.escrow, {
    buyerKey: inputs.buyerKey,
    sellerKey: inputs.sellerKey,
    amountSats: inputs.amountSats,
    destination: inputs.destination,
    maxFeeSats: inputs.maxFeeSats,
    expectedFeeSats: inputs.expectedFeeSats,
  });

  console.log("FINALIZED RECOVERY TRANSACTION (not broadcast)");
  console.log(`  txid: ${txid}`);
  console.log("  raw tx hex:");
  console.log(txHex);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv).catch((err) => {
    console.error("ERROR:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
