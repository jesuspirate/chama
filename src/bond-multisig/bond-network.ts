// ══════════════════════════════════════════════════════════════════════════
// Chama — which network commitment BONDS live on
// ══════════════════════════════════════════════════════════════════════════
//
// Bonds are real money. This module exists so there is exactly ONE answer to
// "which chain", and so the test escape hatch below cannot survive a build.
//
// ⭐ THE PRODUCTION ANSWER IS MAINNET, ALWAYS.
//
// The escape hatch exists for one reason: an on-chain escrow needs a BONDED
// arbiter (the arbiter's escrow key comes from their bond announcement), and
// the escrow itself is on signet during testing. Without this, testing the
// signet escrow path would require posting a real mainnet bond large enough to
// cover the test trade — paying real sats to exercise test coins.
//
// ⚠ TWO INDEPENDENT LOCKS, both of which must be open:
//
//   1. `import.meta.env.DEV` — a build-time literal. Vite substitutes `false`
//      into production bundles, so the whole branch is dead code the minifier
//      removes. A shipped Chama does not contain the ability to post a signet
//      bond; it is not a flag someone can find and flip.
//   2. An explicit localStorage opt-in on that device.
//
// Resolved ONCE at module load, deliberately. A value that could change
// mid-session would mean bond records written under one network being read
// under another, which is how a user's real bond stops rendering halfway
// through a session.
//
// TO REMOVE (planned, after the signet escrow pass): delete this file, restore
// `import { MAINNET as BOND_NETWORK } from "./multisig.js"` at the three call
// sites, and drop the prefix check in commitment-store. Nothing else depends
// on it.

import { MAINNET, SIGNET, type BtcNetwork } from "./multisig.js";

/** Device opt-in. Only consulted in a dev build. */
const TEST_BOND_NETWORK_KEY = "chama_test_bond_signet";

function testBondsEnabled(): boolean {
  // Lock 1: statically false in any production bundle.
  if (!import.meta.env?.DEV) return false;
  // Lock 2: explicit per-device opt-in. Absent/unreadable ⇒ mainnet.
  try {
    return globalThis.localStorage?.getItem(TEST_BOND_NETWORK_KEY) === "1";
  } catch {
    return false;
  }
}

/** The network every commitment bond is built, funded, verified and reclaimed
 *  on. Mainnet unless BOTH locks above are open. */
export const BOND_NETWORK: BtcNetwork = testBondsEnabled() ? SIGNET : MAINNET;

/** True only in a dev build with the opt-in set. UI may use this to say so out
 *  loud — a bond screen that silently switched chains would be far worse than
 *  one that admits it. */
export const BOND_NETWORK_IS_TEST: boolean = BOND_NETWORK === SIGNET;

/** Address prefix bonds must carry on the active network. `bc1` on mainnet,
 *  `tb1` on signet/testnet (they share the HRP). Used to hide foreign-chain
 *  leftovers without deleting them. */
export const BOND_ADDRESS_PREFIX: string = BOND_NETWORK_IS_TEST ? "tb1" : "bc1";
