import { selectLatestAnnouncements, verifyBondAnnouncement, type ParsedBondAnnouncement, type VerifiedBond } from "../bond-multisig/bond-announcement.js";
import { esploraTipHeight, type EsploraFetch } from "../bond-multisig/fund-watcher.js";
import type { BtcNetwork } from "../bond-multisig/multisig.js";
import type { NostrEvent } from "../escrow-engine/types.js";
async function mapPool<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await worker(items[i]);
  }));
  return results;
}

/** Public display only. Incomplete relay/chain evidence is not an empty community. */
export async function readLivenessBonds(input: {
  community: string; network: BtcNetwork; fetchJson: EsploraFetch; signal?: AbortSignal;
  readAnnouncements: () => Promise<{ events: NostrEvent[]; complete: boolean }>;
  verify?: (announcement: ParsedBondAnnouncement, context: { network: BtcNetwork; fetchJson: EsploraFetch; tipHeight: number }) => Promise<VerifiedBond | null>;
}) {
  const checkAbort = () => { if (input.signal?.aborted) throw input.signal.reason ?? new DOMException("Aborted", "AbortError"); };
  checkAbort();
  const [tip, reading] = await Promise.all([esploraTipHeight(input.fetchJson), input.readAnnouncements()]);
  if (!Number.isSafeInteger(tip) || tip <= 0) throw new Error("Block explorer did not return a valid chain tip");
  if (!reading.complete) throw new Error("The relay reading is incomplete; bonded coverage is unknown");
  checkAbort();
  const candidates = selectLatestAnnouncements(reading.events).filter(a => a.community === input.community);
  // A malformed explorer response must not become [] inside the general bond
  // watcher. Keep this strictness local to public liveness, not money operations.
  const neededOutputs = new Map<string, Set<number>>();
  const strictFetch: EsploraFetch = async path => {
    checkAbort();
    if (path === "/blocks/tip/height") return tip;
    const value = await input.fetchJson(path);
    if (path.endsWith("/utxo") && (!Array.isArray(value) || value.some(u => !u || typeof u.status?.confirmed !== "boolean" || !Number.isSafeInteger(u.value) || u.value < 0 || typeof u.txid !== "string" || !/^[0-9a-f]{64}$/i.test(u.txid) || !Number.isSafeInteger(u.vout) || u.vout < 0))) throw new Error("Block explorer returned an unreadable bond deposit list");
    if (path.endsWith("/utxo")) for (const u of value) {
      if (!u.status.confirmed) continue;
      const indices = neededOutputs.get(u.txid) ?? new Set<number>();
      indices.add(u.vout); neededOutputs.set(u.txid, indices);
    }
    if (/^\/tx\/[0-9a-f]{64}$/i.test(path)) {
      const indices = [...(neededOutputs.get(path.slice(4)) ?? [])];
      if (!Array.isArray(value?.vout) || indices.some(index => typeof value.vout[index]?.scriptpubkey !== "string" || !/^(?:[0-9a-f]{2})+$/i.test(value.vout[index].scriptpubkey))) throw new Error("Block explorer returned unreadable bond transaction outputs");
    }
    return value;
  };
  const bonds = await mapPool(candidates, 6, async announcement => {
    checkAbort();
    // Null is a structurally/domain-invalid bond. A rejected read is UNKNOWN:
    // let it reject the generation instead of converting it to null/zero.
    return (input.verify ?? verifyBondAnnouncement)(announcement, { network: input.network, fetchJson: strictFetch, tipHeight: tip });
  });
  checkAbort();
  return { tip, bonds: bonds.filter((bond): bond is VerifiedBond => bond !== null) };
}
