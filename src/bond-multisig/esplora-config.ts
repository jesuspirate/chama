// ══════════════════════════════════════════════════════════════════════════
// Chama — which block explorer we ask about the chain
// ══════════════════════════════════════════════════════════════════════════
//
// ⭐ WHY THIS EXISTS: the sharpest privacy leak left in Chama.
//
// Every bond address, every on-chain escrow address, and every funding poll has
// been going to a single hardcoded host (mempool.space). That host can
// therefore correlate a user's bonds with their escrows with their IP — for a
// product whose entire thesis is that no server knows who trades with whom.
// Tier 2.1 made it worse, because an on-chain escrow discloses more addresses
// per trade than ecash ever did.
//
// So the explorer becomes a setting. The default is unchanged, which matters:
// this is not a self-hosting feature. Anyone can point Chama at an Esplora they
// trust — their own Mempool on a Start9 box, a friend's, a public alternative —
// without running anything themselves.
//
// ⚠ TWO RULES THAT MATTER MORE THAN THE SETTING ITSELF
//
//   1. NEVER PERSIST AN UNVERIFIED ENDPOINT. A misconfigured explorer makes
//      every bond unverifiable, which silently un-seats legitimate arbiters and
//      strands trades. That is a worse outcome than the leak this fixes. So a
//      base is probed BEFORE it is saved, and a failed probe leaves the previous
//      value untouched.
//   2. "COULDN'T CHECK" IS NOT "NOT FUNDED". Callers must keep letting read
//      failures throw rather than collapsing them into a negative answer. This
//      module never converts an error into a fact.

import { SIGNET, type BtcNetwork } from "./multisig.js";
import { getScopedStorageItem, setScopedStorageItem } from "../storage/user-scope.js";

/** Per-network override map. User-scoped: two npubs on one device may trust
 *  different explorers, and one should never inherit the other's. */
const ESPLORA_OVERRIDE_KEY = "chama_esplora_base_v1";

/** Shipped defaults. Unchanged from the hardcoded values they replace. */
export const BUILTIN_ESPLORA_BASE = {
  mainnet: "https://mempool.space/api",
  signet: "https://mutinynet.com/api",
} as const;

/** Bitcoin mainnet's genesis block hash. The one chain-identity fact that is
 *  fixed forever and cheap to check. */
export const MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f";

export type EsploraProbeVerdict =
  | "ok"
  /** Did not answer, timed out, or returned non-2xx. */
  | "unreachable"
  /** Answered, but not with anything an Esplora would say. */
  | "not-esplora"
  /** Answered about a DIFFERENT chain. The dangerous one. */
  | "wrong-network";

export interface EsploraProbeResult {
  verdict: EsploraProbeVerdict;
  /** Tip height, when the probe got that far. Useful to show the user. */
  tipHeight?: number;
}

function networkKey(network: BtcNetwork): "mainnet" | "signet" {
  return network === SIGNET ? "signet" : "mainnet";
}

/**
 * Clean a user-typed base URL, or reject it.
 *
 * Pure — no network. Rejects anything that is not plainly an http(s) origin,
 * because the value gets string-concatenated with paths like `/address/bc1…`
 * throughout `fund-watcher`. A base with a query string or a fragment would
 * silently produce nonsense URLs rather than an error.
 */
export function normalizeEsploraBase(raw: string): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  let url: URL;
  try { url = new URL(trimmed); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.search || url.hash) return null;
  // Strip trailing slashes — every caller concatenates a leading-slash path.
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

/**
 * Ask an endpoint whether it is a working Esplora for the network we expect.
 *
 * The fetcher is injected so this is testable without a network, and so the
 * caller controls the timeout.
 *
 * ⚠ ASYMMETRIC BY DESIGN. On **mainnet** the genesis hash must match: real
 * money is at stake, and an explorer quietly reporting a different chain would
 * report every bond as unfunded. On **test networks** any reachable Esplora is
 * accepted, because signet variants (Mutinynet among them) legitimately have
 * different genesis hashes and pinning one would reject the very endpoint we
 * ship as the default.
 */
export async function probeEsplora(
  network: BtcNetwork,
  fetchJson: (path: string) => Promise<any>,
): Promise<EsploraProbeResult> {
  let tipHeight: number;
  try {
    const raw = await fetchJson("/blocks/tip/height");
    const n = typeof raw === "number" ? raw : Number(raw);
    if (!Number.isFinite(n) || n < 0) return { verdict: "not-esplora" };
    tipHeight = n;
  } catch {
    return { verdict: "unreachable" };
  }

  if (networkKey(network) === "mainnet") {
    try {
      const genesis = await fetchJson("/block-height/0");
      if (typeof genesis !== "string") return { verdict: "not-esplora" };
      if (genesis.trim().toLowerCase() !== MAINNET_GENESIS_HASH) {
        return { verdict: "wrong-network", tipHeight };
      }
    } catch {
      return { verdict: "unreachable", tipHeight };
    }
  }

  return { verdict: "ok", tipHeight };
}

/** The stored override for a network, or null. Never throws. */
export function readEsploraOverride(network: BtcNetwork): string | null {
  try {
    const raw = getScopedStorageItem(ESPLORA_OVERRIDE_KEY);
    if (!raw) return null;
    const map = JSON.parse(raw) as Record<string, unknown>;
    const value = map?.[networkKey(network)];
    return typeof value === "string" ? normalizeEsploraBase(value) : null;
  } catch {
    // A corrupt entry must not take the explorer down with it.
    return null;
  }
}

/**
 * Persist an override. Returns false if the value is unusable.
 *
 * ⚠ Callers must have probed FIRST. This function deliberately does not probe:
 * making the write the same call as the network check would tempt a caller into
 * saving on a timeout. Probe, show the user the verdict, then save.
 */
export function setEsploraOverride(network: BtcNetwork, base: string): boolean {
  const normalized = normalizeEsploraBase(base);
  if (!normalized) return false;
  try {
    const raw = getScopedStorageItem(ESPLORA_OVERRIDE_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    map[networkKey(network)] = normalized;
    setScopedStorageItem(ESPLORA_OVERRIDE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

/** Drop the override and go back to the shipped default. Always available —
 *  a setting you cannot undo is a trap. */
export function clearEsploraOverride(network: BtcNetwork): void {
  try {
    const raw = getScopedStorageItem(ESPLORA_OVERRIDE_KEY);
    if (!raw) return;
    const map = JSON.parse(raw) as Record<string, string>;
    delete map[networkKey(network)];
    setScopedStorageItem(ESPLORA_OVERRIDE_KEY, JSON.stringify(map));
  } catch { /* nothing to undo */ }
}

/** The explorer to use: the user's verified choice, else the shipped default. */
export function resolveEsploraBase(network: BtcNetwork): string {
  return readEsploraOverride(network) ?? BUILTIN_ESPLORA_BASE[networkKey(network)];
}

/** Human-facing transaction page for the same explorer/network used by chain
 * reads. Mempool-compatible deployments conventionally expose their UI beside
 * the `/api` root; keeping this derivation here prevents the UI from silently
 * linking a Mutinynet transaction to Bitcoin Core signet. */
export function esploraTransactionUrl(network: BtcNetwork, txid: string): string {
  const base = resolveEsploraBase(network).replace(/\/api$/i, "");
  return `${base}/tx/${encodeURIComponent(txid)}`;
}

/** True when the user is pointed somewhere other than the shipped default —
 *  the UI should say so, because a wrong explorer explains symptoms that
 *  otherwise look like a broken bond. */
export function usingCustomEsplora(network: BtcNetwork): boolean {
  return readEsploraOverride(network) !== null;
}
