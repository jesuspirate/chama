// Chama — cross-device arbiter earnings history
//
// Bearer ecash remains in the Fedimint wallet that redeemed it. This module
// synchronizes only the identity's historical accounting: one signed,
// NIP-44-encrypted parameterized-replaceable receipt per premium event.

import type { EscrowClient, UnsignedEvent } from "../escrow-engine/escrow-client.js";
import type { NostrEvent } from "../escrow-engine/types.js";
import {
  listArbiterEarningRecords,
  mergeSyncedEarningRedeemed,
  type ArbiterEarningRecord,
} from "./arbiter-earnings.js";

export const ARBITER_EARNINGS_SYNC_KIND = 30079;
export const ARBITER_EARNINGS_SYNC_TAG = "chama-arbiter-earning-v1";

export interface SyncedArbiterEarning {
  version: 1;
  premiumEventId: string;
  escrowId: string;
  payer: string;
  amountMsats: number;
  noteKind: "ambient" | "dispute";
  redeemedAt: number;
}

function validHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

export function parseSyncedArbiterEarning(value: unknown): SyncedArbiterEarning | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<SyncedArbiterEarning>;
  if (v.version !== 1 || !validHex64(v.premiumEventId) || typeof v.escrowId !== "string" || !v.escrowId) return null;
  if (!validHex64(v.payer) || !Number.isSafeInteger(v.amountMsats) || (v.amountMsats ?? 0) <= 0) return null;
  if (v.noteKind !== "ambient" && v.noteKind !== "dispute") return null;
  if (!Number.isSafeInteger(v.redeemedAt) || (v.redeemedAt ?? 0) <= 0) return null;
  return v as SyncedArbiterEarning;
}

function fromLocal(record: ArbiterEarningRecord): SyncedArbiterEarning {
  return {
    version: 1,
    premiumEventId: record.eventId,
    escrowId: record.escrowId,
    payer: record.payer,
    amountMsats: record.amountMsats,
    noteKind: record.noteKind,
    redeemedAt: record.updatedAt,
  };
}

async function publishReceipt(client: EscrowClient, receipt: SyncedArbiterEarning): Promise<void> {
  const signer = client.getSigner();
  const pubkey = await client.getPubkey();
  const content = await signer.nip44Encrypt(JSON.stringify(receipt), pubkey);
  const unsigned: UnsignedEvent = {
    kind: ARBITER_EARNINGS_SYNC_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ["d", `${ARBITER_EARNINGS_SYNC_TAG}:${receipt.premiumEventId}`],
      ["t", ARBITER_EARNINGS_SYNC_TAG],
    ],
    content,
  };
  await client.publishRaw(await signer.signEvent(unsigned));
}

async function decryptReceipt(client: EscrowClient, event: NostrEvent, pubkey: string): Promise<SyncedArbiterEarning | null> {
  if (event.kind !== ARBITER_EARNINGS_SYNC_KIND || event.pubkey !== pubkey) return null;
  if (!event.tags.some((tag) => tag[0] === "t" && tag[1] === ARBITER_EARNINGS_SYNC_TAG)) return null;
  try {
    const plaintext = await client.getSigner().nip44Decrypt(event.content, pubkey);
    return parseSyncedArbiterEarning(JSON.parse(plaintext));
  } catch {
    return null;
  }
}

export interface EarningsSyncResult {
  recovered: number;
  published: number;
}

/** Pull identity-wide receipts first, then publish every locally redeemed
 * legacy record. Parameterized replacement + premiumEventId dedupe make the
 * operation safe to repeat on every boot and every device. */
export async function syncArbiterEarnings(client: EscrowClient): Promise<EarningsSyncResult> {
  // Automatic history synchronization must never summon an extension.
  if (client.getSigner().requiresUserAction) return { recovered: 0, published: 0 };
  const pubkey = await client.getPubkey();
  let recovered = 0;
  let events: NostrEvent[] = [];
  try {
    events = await client.queryOnce({
      kinds: [ARBITER_EARNINGS_SYNC_KIND],
      authors: [pubkey],
      "#t": [ARBITER_EARNINGS_SYNC_TAG],
      limit: 1000,
    } as any, 8_000);
  } catch { /* relay history is fail-soft; local records still publish below */ }

  for (const event of events) {
    const receipt = await decryptReceipt(client, event, pubkey);
    if (!receipt) continue;
    if (mergeSyncedEarningRedeemed({
      eventId: receipt.premiumEventId,
      escrowId: receipt.escrowId,
      payer: receipt.payer,
      amountMsats: receipt.amountMsats,
      noteKind: receipt.noteKind,
      redeemedAt: receipt.redeemedAt,
    })) recovered++;
  }

  let published = 0;
  for (const record of listArbiterEarningRecords()) {
    if (record.status !== "redeemed" || record.amountMsats <= 0) continue;
    try {
      await publishReceipt(client, fromLocal(record));
      published++;
    } catch { /* one relay failure must not block the rest or app startup */ }
  }
  return { recovered, published };
}
