import { EscrowStatus, Role, selectedMenuItemsTotalMsats, type EscrowState } from "../escrow-engine/types.js";

/** A bracket remains a bracket until a valid choice or committed order exists. */
export function guidedListingAmount(state: EscrowState, draftSats = ""): { minMsats: number; maxMsats?: number } {
  if (state.status !== EscrowStatus.CREATED || state.lock.notesHash) return { minMsats: state.amountMsats };
  const hold = state.joinHolds?.[Role.BUYER];
  const committed = hold?.amountMsats ?? (hold?.selectedItems?.length ? selectedMenuItemsTotalMsats(hold.selectedItems) : undefined);
  if (hold?.orderFinalizedAt && committed) return { minMsats: committed };
  const bracket = state.items?.length === 1 && state.items[0].kind === "exchange-bracket" ? state.items[0] : null;
  if (!bracket) return { minMsats: state.amountMsats };
  const minMsats = bracket.minAmountMsats ?? bracket.amountMsats;
  const maxMsats = bracket.maxAmountMsats ?? bracket.amountMsats;
  const sats = Number(draftSats), msats = sats * 1000;
  if (draftSats.trim() && Number.isSafeInteger(sats) && msats >= minMsats && msats <= maxMsats) return { minMsats: msats };
  return { minMsats, maxMsats };
}
