import { getDomain } from "tldts";
import { CURATED_PRESETS, federationNameForInvite } from "./federation-config.js";

/** Public configuration only. No wallet, bearer notes, or secret material. */
export interface FederationInspection {
  federationId: string;
  config: unknown;
  consensusMeta?: unknown;
  /** A failed/unavailable consensus read must never fall back to stale limits. */
  metaStatus: "ready" | "absent" | "unavailable";
}
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function metadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") { try { return object(JSON.parse(value)); } catch { return {}; } }
  return object(value);
}
export function federationFacts(invite: string, inspection?: FederationInspection | null, hostPubkey?: string) {
  const global = object(object(inspection?.config).global);
  const consensus = metadata(object(inspection?.consensusMeta).value ?? inspection?.consensusMeta);
  const meta = { ...object(global.meta), ...consensus };
  const endpoints = Object.values(object(global.api_endpoints));
  const urls = endpoints.map(entry => {
    try { return new URL(String(object(entry).url)); } catch { return null; }
  });
  // iroh:// addresses identify distinct guardian nodes. Sharing an iroh relay
  // is not evidence that those guardians live on the same machine.
  const hosts = urls.map(url => url && /^(https?|wss?):$/.test(url.protocol)
    ? url.hostname.toLowerCase().replace(/\.$/, "") : null);
  const domains = hosts.map((host, index) => urls[index]?.protocol === "iroh:" ? `iroh:${urls[index]!.hostname}` : host ? getDomain(host, { allowPrivateDomains: true }) ?? host : null);
  const sameHost = endpoints.length > 0 && domains.every(Boolean) && new Set(domains).size === 1;
  const guardianKeys = Object.values(object(global.broadcast_public_keys)).map(key => String(key).toLowerCase().replace(/^0[23](?=[0-9a-f]{64}$)/, ""));
  const hostIsGuardian = !!hostPubkey && guardianKeys.includes(hostPubkey.toLowerCase());
  const knownPreset = inspection ? CURATED_PRESETS.find(preset => preset.federationId === inspection.federationId) : undefined;
  const name = federationNameForInvite(invite) || knownPreset?.name || (typeof meta.federation_name === "string" ? meta.federation_name.slice(0, 100) : "") || inspection?.federationId.slice(0, 12) || null;
  return { name, guardians: endpoints.length || null, singleOperator: (endpoints.length > 0 && endpoints.length < 4) || sameHost || hostIsGuardian,
    curated: !!knownPreset || CURATED_PRESETS.some(preset => preset.inviteCode.trim() === invite.trim()), meta };
}
function msats(value: unknown): bigint | null {
  // Reject floats, unsafe JS integers, negatives, empty text and coercions.
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  if (typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value)) return BigInt(value);
  return null;
}
/** Whole-satoshi UI ceiling. Missing balance is optional; malformed balance is not. */
export function publicShareLimit(inspection: FederationInspection | null | undefined, seats: number | null): number | null {
  if (!inspection || inspection.metaStatus === "unavailable") return null;
  let consensus = object(inspection.consensusMeta).value ?? inspection.consensusMeta;
  if (typeof consensus === "string") { try { consensus = JSON.parse(consensus); } catch { return null; } }
  if (consensus != null && (typeof consensus !== "object" || Array.isArray(consensus))) return null;
  const { meta } = federationFacts("", inspection);
  const invoice = msats(meta["fedi:max_invoice_msats"]);
  if (invoice === null) return null;
  let maximum = invoice;
  if (Object.hasOwn(meta, "fedi:max_balance_msats")) {
    const balance = msats(meta["fedi:max_balance_msats"]);
    if (balance === null || seats === null || !Number.isSafeInteger(seats) || seats < 2) return null;
    const perSeat = balance / BigInt(seats);
    if (perSeat < maximum) maximum = perSeat;
  }
  const sats = maximum / 1000n;
  return sats <= BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1000)) ? Number(sats) : Math.floor(Number.MAX_SAFE_INTEGER / 1000);
}
export async function boundedInspection<T>(work: Promise<T>, timeoutMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Federation information unavailable")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
