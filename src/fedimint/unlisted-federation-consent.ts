// H4: a person's own "yes" to an unlisted federation.
//
// Sellers may list on any federation they paste. Before Chama moves anyone
// else onto one it doesn't ship, that person confirms they know who runs it,
// because whoever runs a federation holds the sats while a trade is open.
// This records that confirmation per identity and per invite on this device.
// A failed read or write means "not agreed": the question is asked again.

const STORE_PREFIX = "chama_unlisted_federation_ok_v1";

function key(pubkey: string): string {
  return `${STORE_PREFIX}:${pubkey.trim().toLowerCase()}`;
}

function read(pubkey: string): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const parsed = JSON.parse(localStorage.getItem(key(pubkey)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.startsWith("fed1")) : [];
  } catch {
    return [];
  }
}

export function hasAcceptedUnlistedFederation(pubkey: string | null | undefined, invite: string): boolean {
  if (!pubkey) return false;
  return read(pubkey).includes(invite.trim());
}

/** Returns false when the answer could not be saved; the caller may still
 *  proceed this once, but it will be asked again next time. */
export function acceptUnlistedFederation(pubkey: string | null | undefined, invite: string): boolean {
  const trimmed = invite.trim();
  if (!pubkey || !trimmed.startsWith("fed1")) return false;
  try {
    const current = read(pubkey);
    if (!current.includes(trimmed)) current.push(trimmed);
    localStorage.setItem(key(pubkey), JSON.stringify(current));
    return true;
  } catch {
    return false;
  }
}
