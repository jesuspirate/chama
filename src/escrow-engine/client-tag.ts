import { TAGS } from "./types.js";

/** Outer Nostr metadata only. Vite replaces the version in shipped builds. */
export function chamaClientTag(version: string = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__): string[] {
  return [TAGS.CLIENT, "chama", version];
}

export function isChamaClientTagKind(kind: number): boolean {
  return (kind >= 38100 && kind <= 38118) || kind === 38135;
}

/** The Chama version an event's `client` tag names, or null (other clients,
 *  dev builds without a version, no tag). Metadata only, never consensus. */
export function chamaClientVersion(tags: string[][] | undefined): [number, number, number] | null {
  const tag = tags?.find(t => t[0] === TAGS.CLIENT && t[1] === "chama");
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(tag?.[2] ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** #43 writer policy: the first release that reads withheld shares, accepts
 *  and releases. A counterparty below it gets today's all-shares LOCK. */
export const WITHHELD_SHARES_READER_VERSION: [number, number, number] = [6, 4, 34];

export function versionAtLeast(version: [number, number, number] | null, min: [number, number, number]): boolean {
  if (!version) return false;
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i];
  return true;
}

/** True when `pubkey`'s most recent event in this chain was signed by a Chama
 *  app that reads withheld shares. No event, or no version, ⇒ false. */
export function signsWithWithheldShareReader(
  chain: ReadonlyArray<{ pubkey: string; timestamp: number; raw: { tags: string[][] } }>,
  pubkey: string,
): boolean {
  let latest: { timestamp: number; raw: { tags: string[][] } } | undefined;
  for (const event of chain) if (event.pubkey === pubkey && (!latest || event.timestamp >= latest.timestamp)) latest = event;
  return versionAtLeast(chamaClientVersion(latest?.raw.tags), WITHHELD_SHARES_READER_VERSION);
}
