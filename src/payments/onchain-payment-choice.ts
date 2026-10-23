// ══════════════════════════════════════════════════════════════════════════
// Chama — where the cash goes, for an on-chain trade (local, per trade)
// ══════════════════════════════════════════════════════════════════════════
//
// An ecash lock reveals the funder's payment details in the same step that
// moves the sats. An on-chain trade cannot: the deposit address appears
// after the funding-terms JOIN, the deposit confirms later, and only then is
// the LOCK published. So the funder chooses the details before the address
// exists (prepareOnchainFunding), this store keeps that choice, and
// publishOnchainLock reveals it inside the LOCK's encrypted handle envelope.
//
// The choice is a snapshot of the saved detail, so deleting or editing the
// saved entry afterwards still reveals what the funder agreed to. A missing
// or unreadable choice at lock time never blocks the lock: the deposit is
// already on-chain, so the trade continues with the agreed methods plus chat
// (AGENTS.md "after sats move").

import type { SavedHandle } from './saved-handles.js';
import { readStrictScopedStorageItem, setStrictScopedStorageItem } from '../storage/user-scope.js';

export const ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY = 'chama_onchain_payment_choice';

export interface OnchainPaymentChoice {
  handleId: string;
  handle: string;
  rail: string;
  networks?: string[];
  /** Unix ms the funder chose it. */
  chosenAt: number;
}

function isChoice(value: unknown): value is OnchainPaymentChoice {
  const v = value as Record<string, unknown> | null;
  return !!v && typeof v === 'object'
    && typeof v.handleId === 'string' && v.handleId.length > 0
    && typeof v.handle === 'string' && v.handle.trim().length > 0
    && typeof v.rail === 'string' && v.rail.length > 0
    && (v.networks === undefined || (Array.isArray(v.networks) && v.networks.every(n => typeof n === 'string')))
    && typeof v.chosenAt === 'number';
}

/** Throws when the store can't be read or parsed. */
function readAll(): Record<string, OnchainPaymentChoice> {
  const raw = readStrictScopedStorageItem(ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Saved payment choices couldn’t be read.');
  const out: Record<string, OnchainPaymentChoice> = {};
  for (const [escrowId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (isChoice(value)) out[escrowId] = value;
  }
  return out;
}

/** The funder's choice for this trade, or null when none is stored or the
 *  store can't be read. Callers treat null as "ask again" before sats move
 *  and as "agreed methods plus chat" after. */
export function getOnchainPaymentChoice(escrowId: string): OnchainPaymentChoice | null {
  try { return readAll()[escrowId] ?? null; }
  catch { return null; }
}

/** Store the choice and read it back. Throws when it did not stick, so the
 *  caller stops before publishing the deposit address. */
export function saveOnchainPaymentChoice(escrowId: string, saved: SavedHandle, now = Date.now()): OnchainPaymentChoice {
  const choice: OnchainPaymentChoice = {
    handleId: saved.id, handle: saved.handle.trim(), rail: saved.rail,
    ...(saved.networks && saved.networks.length > 0 ? { networks: [...saved.networks] } : {}),
    chosenAt: now,
  };
  if (!isChoice(choice)) throw new Error('These payment details are empty. Choose others before funding. No sats moved.');
  let all: Record<string, OnchainPaymentChoice>;
  try { all = readAll(); }
  catch (error) {
    // A store that no longer parses only held earlier choices, never money.
    // Keep its text aside and start again rather than block funding forever;
    // a store the browser can't read at all still throws.
    const raw = readStrictScopedStorageItem(ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY);
    if (raw === null) throw error;
    setStrictScopedStorageItem(`${ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY}_unreadable`, raw);
    all = {};
  }
  all[escrowId] = choice;
  setStrictScopedStorageItem(ONCHAIN_PAYMENT_CHOICE_STORAGE_KEY, JSON.stringify(all));
  const back = getOnchainPaymentChoice(escrowId);
  if (!back || back.handleId !== choice.handleId || back.handle !== choice.handle) {
    throw new Error('Chama couldn’t save where the cash goes on this device. No sats moved.');
  }
  return back;
}

/** The LOCK's handle fields for a stored choice. */
export function onchainLockHandleParams(choice: OnchainPaymentChoice | null): {
  handleId?: string; handle?: string; rail?: string; handleNetworks?: string[];
} {
  if (!choice) return {};
  return {
    handleId: choice.handleId, handle: choice.handle, rail: choice.rail,
    ...(choice.networks && choice.networks.length > 0 ? { handleNetworks: choice.networks } : {}),
  };
}
