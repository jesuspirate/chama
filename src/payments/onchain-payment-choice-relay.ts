// ══════════════════════════════════════════════════════════════════════════
// Chama — the funder's on-chain cash choice, copied to relays for their
// other devices
// ══════════════════════════════════════════════════════════════════════════
//
// Jet (6.4.31): any device signed in as the funder can publish an on-chain
// LOCK (automatic lock recovery), but only the device that chose where the
// cash goes had the choice. This keeps one copy on relays, NIP-44 encrypted
// to the funder's own key, in a replaceable app-data event (kind 30078, the
// same kind as the seed backup) with one d-tag per trade. The tag is a hash
// of the trade id, so relays learn only that this account kept a choice.
//
// Not a protocol event: no escrow reducer reads it, no other participant
// needs it. The LOCK's handle envelope remains what buyer and arbiter see.

import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { NostrEvent } from '../escrow-engine/types.js';
import { isOnchainPaymentChoice, type OnchainPaymentChoice } from './onchain-payment-choice.js';

export const CASH_CHOICE_KIND = 30078;
const CASH_CHOICE_D_PREFIX = 'chama-cash-to-v1:';

export function cashChoiceDTag(escrowId: string): string {
  return CASH_CHOICE_D_PREFIX + bytesToHex(sha256(utf8ToBytes(`chama-cash-to-v1|${escrowId}`)));
}

export interface CashChoiceSigner {
  getPublicKey(): Promise<string>;
  nip44Encrypt(plaintext: string, recipientPubkey: string): Promise<string>;
  nip44Decrypt(ciphertext: string, senderPubkey: string): Promise<string>;
  signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }): Promise<NostrEvent>;
}

/** Publish the copy. Throws when signing or every relay refuses, so the
 *  caller stops before the deposit address exists. */
export async function publishCashChoiceCopy(opts: {
  escrowId: string; choice: OnchainPaymentChoice; signer: CashChoiceSigner;
  publish: (event: NostrEvent) => Promise<void>; now?: number;
}): Promise<void> {
  const pubkey = await opts.signer.getPublicKey();
  const content = await opts.signer.nip44Encrypt(JSON.stringify({ escrowId: opts.escrowId, choice: opts.choice }), pubkey);
  const signed = await opts.signer.signEvent({
    kind: CASH_CHOICE_KIND,
    created_at: opts.now ?? Math.floor(Date.now() / 1000),
    tags: [['d', cashChoiceDTag(opts.escrowId)], ['client', 'chama']],
    content,
  });
  if (signed.pubkey !== pubkey) throw new Error('Your Nostr signer changed. Where the cash goes was not saved. No sats moved.');
  await opts.publish(signed);
}

/** This account's copy for a trade, or null when none can be found or read.
 *  Only used once the deposit exists, where "not found" means the LOCK goes
 *  out with the agreed methods plus chat. */
export async function fetchCashChoiceCopy(opts: {
  escrowId: string; signer: CashChoiceSigner;
  query: (filter: Record<string, unknown>) => Promise<NostrEvent[]>;
}): Promise<OnchainPaymentChoice | null> {
  try {
    const pubkey = await opts.signer.getPublicKey();
    const events = (await opts.query({ kinds: [CASH_CHOICE_KIND], authors: [pubkey], '#d': [cashChoiceDTag(opts.escrowId)] }))
      .filter(event => event.pubkey === pubkey && event.kind === CASH_CHOICE_KIND
        && event.tags.some(tag => tag[0] === 'd' && tag[1] === cashChoiceDTag(opts.escrowId)))
      .sort((a, b) => b.created_at - a.created_at);
    for (const event of events) {
      try {
        const value = JSON.parse(await opts.signer.nip44Decrypt(event.content, pubkey)) as { escrowId?: unknown; choice?: unknown };
        // The trade id inside the ciphertext must match: a copy can't be
        // replayed onto another trade under a colliding or reused tag.
        if (value.escrowId === opts.escrowId && isOnchainPaymentChoice(value.choice)) return value.choice;
      } catch { /* try an older copy */ }
    }
    return null;
  } catch {
    return null;
  }
}
