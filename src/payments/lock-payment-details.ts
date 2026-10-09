import type { EscrowState } from '../escrow-engine/types.js';
import { addSavedHandle, getSavedHandle, type SavedHandle } from './saved-handles.js';
import { toRailKey } from './rail-registry.js';
import { getStrictScopedStorageItem, setStrictScopedStorageItem } from '../storage/user-scope.js';
export type LockPaymentChoice = { savedHandleId: string } | { inChat: true };
const key = (id: string) => `chama_lock_payment_details:${id}`;
export function needsLockPaymentDetails(state: EscrowState): boolean {
  return state.category === 'p2p-trade' || state.category === 'bill-pay';
}
export function handleMatchesTrade(handle: SavedHandle, state: EscrowState): boolean {
  const methods = (state.paymentMethods ?? []).map(toRailKey);
  return !!handle.handle.trim() && [handle.rail, ...(handle.networks ?? [])].some(rail => methods.includes(toRailKey(rail)));
}
export function confirmLockPaymentChoice(state: EscrowState, choice: LockPaymentChoice): LockPaymentChoice {
  if ('savedHandleId' in choice) {
    const handle = getSavedHandle(choice.savedHandleId);
    if (!handle || !handleMatchesTrade(handle, state)) throw new Error('Choose payment details for one of this trade’s methods.');
  } else if (choice.inChat !== true) throw new Error('Confirm how you will send the payment details.');
  setStrictScopedStorageItem(key(state.id), JSON.stringify(choice));
  if (!readLockPaymentChoice(state)) throw new Error("Could not save payment details. Try again before locking.");
  return choice;
}
export function readLockPaymentChoice(state: EscrowState): LockPaymentChoice | null {
  try {
    const raw = JSON.parse(getStrictScopedStorageItem(key(state.id)) ?? 'null');
    if (raw?.inChat === true) return { inChat: true };
    const handle = raw?.savedHandleId && getSavedHandle(raw.savedHandleId);
    return handle && handleMatchesTrade(handle, state) ? { savedHandleId: handle.id } : null;
  } catch { return null; }
}
export function enterLockPaymentDetails(state: EscrowState, rail: string, value: string): LockPaymentChoice {
  if (!(state.paymentMethods ?? []).map(toRailKey).includes(toRailKey(rail)) || !value.trim()) throw new Error('Enter payment details for one of this trade’s methods.');
  const handle = addSavedHandle(rail, value);
  return confirmLockPaymentChoice(state, { savedHandleId: handle.id });
}

/** Existing LOCK fields; an invalid previously confirmed handle must not vanish. */
export function confirmedLockPaymentFields(state: EscrowState): { handleId?: string; handle?: string; rail?: string; handleNetworks?: string[] } {
  const choice = readLockPaymentChoice(state);
  if (!choice && getStrictScopedStorageItem(key(state.id))) throw new Error('Payment details changed. Confirm them again before locking.');
  if (!choice || 'inChat' in choice) return {};
  const handle = getSavedHandle(choice.savedHandleId)!;
  return { handleId: handle.id, handle: handle.handle, rail: handle.rail, handleNetworks: handle.networks };
}
