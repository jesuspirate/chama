import { balanceBlocksFederationSwitch } from "../payments/lightning-fees.js";

/** What the start-up reconcile may do with the wallet it is about to replace
 *  (Jet, 6.4.25: "balance unknown reported as 0 at start-up").
 *
 *  - unknown: the balance could not be read, or the answer is not a whole
 *    non-negative amount. Unknown stays unknown: never 0, never a switch.
 *  - refuse:  a recoverable balance; the person decides in the confirm sheet.
 *  - replace: a balance that was read and is empty or dust, or the person
 *    already confirmed (force). */
export type ReconcileBalanceDecision =
  | { kind: "unknown" }
  | { kind: "refuse"; balanceMsats: number }
  | { kind: "replace"; balanceMsats: number | null };

export async function decideReconcileBalance(
  readBalance: () => Promise<number>,
  force: boolean,
): Promise<ReconcileBalanceDecision> {
  let balanceMsats: number | null = null;
  try {
    const read = await readBalance();
    balanceMsats = Number.isFinite(read) && read >= 0 ? read : null;
  } catch (e) {
    console.debug("[chama] reconcile: balance read failed:", e);
  }
  if (force) return { kind: "replace", balanceMsats };
  if (balanceMsats === null) return { kind: "unknown" };
  if (balanceBlocksFederationSwitch(balanceMsats)) return { kind: "refuse", balanceMsats };
  return { kind: "replace", balanceMsats };
}
