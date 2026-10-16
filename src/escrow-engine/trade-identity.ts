// ══════════════════════════════════════════════════════════════════════════
// Chama — Trade identity: a trade is (creator pubkey, d), not d alone
// ══════════════════════════════════════════════════════════════════════════
//
// An escrow id is public: it is the `d` tag on every event of the trade. Until
// this module nothing tied an id to the key that created the trade, and replay
// rooted a chain at the EARLIEST CREATE carrying the id. `created_at` is chosen
// by the signer, so a stranger could publish a backdated CREATE under someone
// else's id and become the root: an unlocked listing then showed the stranger's
// terms with the stranger seated as the party to pay.
//
// Two defences, both pure so every client and every replay agrees:
//
//   1. NEW ids carry the first 16 hex characters of the creator's pubkey. A
//      CREATE under such an id from any other key is not a CREATE of that
//      trade and is rejected wherever it is parsed or applied. Matching an
//      existing id means grinding a key to a chosen 64-bit prefix.
//
//   2. OLD ids (and derived ids that are not creator-tagged) cannot be checked
//      from the id. Replay then needs the creator from whoever named the trade
//      (a link, this device's own record of it), and without one it refuses a
//      chain whose CREATEs come from more than one author instead of guessing.
//      Refusing is the outcome the old code reached by accident on a locked
//      trade; on an unlocked one it guessed, and guessed the forgery.

import { EscrowEventKind, type CreatePayload, type ParsedEscrowEvent } from "./types.js";
import { chamaCreateError } from "../chama/policy.js";
import { eventIsSim } from "../sim/simMode.js";

/** Hex characters of the creator's pubkey carried by a creator-tagged id. */
export const CREATOR_TAG_HEX = 16;

// sm_<base36 time>_<16 hex of creator pubkey>_<random>. The untagged form is
// sm_<time>_<random>: two segments, so it can never match. The random part
// stays last because the UI labels a trade by the tail of its id.
const CREATOR_TAGGED_ID = /^sm_[0-9a-z]+_([0-9a-f]{16})_[0-9a-z]+$/;

/** Build a creator-tagged escrow id. */
export function creatorTaggedEscrowId(time: string, random: string, creatorPubkey: string): string {
  const pk = creatorPubkey.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(pk)) throw new Error("Escrow id needs the creator's hex pubkey");
  return `sm_${time}_${pk.slice(0, CREATOR_TAG_HEX)}_${random}`;
}

/** The creator prefix an id commits to, or null for an untagged id. */
export function escrowIdCreatorTag(escrowId: string): string | null {
  return CREATOR_TAGGED_ID.exec(escrowId)?.[1] ?? null;
}

/** False only when the id names a creator and `pubkey` is not it. */
export function creatorMatchesEscrowId(escrowId: string, pubkey: string): boolean {
  const tag = escrowIdCreatorTag(escrowId);
  return tag === null || pubkey.toLowerCase().startsWith(tag);
}

/** A chained rotation round. Its id is derived from the cycle and ANY sealed
 *  member may publish it, so several authors under one id is the design; the
 *  CREATE gate (chamaCreateError) admits sealed members only, and the payloads
 *  are derived from the same cycle. */
function isRotationRound(event: ParsedEscrowEvent): boolean {
  const circle = (event.payload as CreatePayload).chamaCircle;
  return (event.payload as CreatePayload).category === "chama"
    && circle?.pot === "rotation-v2" && circle.roundIndex >= 2;
}

export type TradeRootSelection =
  | { ok: true; events: ParsedEscrowEvent[]; ignored: ParsedEscrowEvent[] }
  | { ok: false; code: "CONFLICTING_CREATES" | "CREATOR_NOT_FOUND" | "INVALID_CHAMA"; message: string };

/**
 * Decide which CREATE may root a replay. Returns the events to replay (order
 * preserved) and any CREATE set aside as belonging to someone else's key.
 *
 * `creator` is the pubkey the caller already knows created this trade. Without
 * it, a chain whose CREATEs come from more than one author is refused.
 */
export function selectTradeRoot(events: ParsedEscrowEvent[], creator?: string | null): TradeRootSelection {
  const creates = events.filter(event => event.kind === EscrowEventKind.CREATE);
  const all = { ok: true as const, events, ignored: [] };
  if (creates.length === 0) return all;
  // A successor belongs to its validated cycle, not an arbitrary author.
  // Recheck the full CREATE law before choosing a root: direct replay and
  // parent lookup must be as strict as the contextual wire parser.
  const rounds = creates.filter(isRotationRound);
  const valid = rounds.filter(event => chamaCreateError(event.payload as CreatePayload,
    event.escrowId, event.pubkey, event.timestamp, event.chamaParent, event.chamaWitness,
    event.chamaCycle, eventIsSim(event.raw)) === null)
    .sort((a, b) => a.timestamp - b.timestamp || a.raw.id.localeCompare(b.raw.id));
  if (valid.length) {
    const keep = new Set(valid);
    const ignored = creates.filter(event => !keep.has(event));
    // Keep valid rival roots as harmless duplicates so a child's predecessor
    // can reference either member's CREATE. The chosen root is always first.
    return { ok: true, events: [...valid, ...events.filter(event => event.kind !== EscrowEventKind.CREATE)], ignored };
  }
  if (rounds.length === creates.length) return { ok: false, code: "INVALID_CHAMA",
    message: "No rotation CREATE is valid for the sealed cycle" };

  const by = creator?.toLowerCase();
  if (by) {
    const ignored = creates.filter(event => event.pubkey.toLowerCase() !== by);
    if (ignored.length === creates.length) {
      return { ok: false, code: "CREATOR_NOT_FOUND",
        message: "No CREATE for this trade is signed by its expected creator" };
    }
    if (ignored.length === 0) return all;
    const drop = new Set(ignored);
    return { ok: true, events: events.filter(event => !drop.has(event)), ignored };
  }

  if (new Set(creates.map(event => event.pubkey.toLowerCase())).size > 1) {
    return { ok: false, code: "CONFLICTING_CREATES",
      message: "More than one key has published a CREATE under this trade id" };
  }
  return all;
}
