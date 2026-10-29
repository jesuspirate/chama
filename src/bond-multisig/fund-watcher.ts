// ══════════════════════════════════════════════════════════════════════════
// Chama — Bond funding watcher (direct on-chain, Esplora-backed)
// ══════════════════════════════════════════════════════════════════════════
//
// The commitment bond's chain eyes: the arbiter sends sats on-chain to the
// locally-recomputed bond address, and this watcher spots every confirmed deposit
// (any amount, any count — more is a bigger bond) so the ceremony can mark it
// LOCKED. It is deliberately SOURCE-AGNOSTIC — the sats can arrive from any
// wallet, a swap claim, or a Fedimint peg-out; all land as an on-chain UTXO at
// the same address and feed this same watcher.
//
// ⭐ RECOMPUTE-DON'T-TRUST reaches the deposit: the watcher reads the REAL output
// scriptPubKey off each confirmed funding tx (the queried address is a HINT for
// which UTXOs to look at, never the trust source), and the reclaim rebuilds the
// address from the bond key before sweeping.
//
// Pure over an injected `fetchJson` (an Esplora GET → parsed JSON), so tests use a
// fake and nothing here bakes in a transport or an endpoint.

import { hexToBytes } from "@noble/hashes/utils.js";
import { SIGNET, type BtcNetwork } from "./multisig.js";
import { BUILTIN_ESPLORA_BASE, resolveEsploraBase } from "./esplora-config.js";

/** Minimal shape of an Esplora `/address/{addr}/utxo` entry. */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean; block_height?: number };
}

// The chain-data port's shapes live in the protocol core; re-exported here.
export type { EsploraFetch, BondFunding } from "../protocol/core/chain-data.js";
import type { EsploraFetch, BondFunding } from "../protocol/core/chain-data.js";

/** The default Esplora base per network. Mainnet (our bond network as of v5.0) →
 *  mempool.space. Signet → the endpoint the live-attack harness used. */
export function defaultEsploraBase(network: BtcNetwork): string {
  // ⭐ Now consults the user's verified override (esplora-config.ts). Absent
  // one, this returns exactly what it always returned. Routing it through the
  // single existing accessor means every call site — bond funding, reclaim,
  // rollover, announcement verification, on-chain escrow — follows the user's
  // choice without any of them knowing a choice exists.
  return resolveEsploraBase(network);
}

/** Confirmation depth to require before a bond reads locked. 1 conf on both nets.
 *  A caller can always override with an explicit `minConfs`. */
export function defaultMinConfs(network: BtcNetwork): number {
  // Jetty (2026-07-09): 1-conf funding on mainnet too. A bond locks the POSTER'S
  // OWN capital (not a payment we accept), so the "one conf, done" ceremony UX wins
  // over a ~1h 6-conf wait — a deep reorg would only un-fund the poster's own
  // deposit, which they'd simply re-post. Signet is 1 as well.
  return network === SIGNET ? 1 : 1;
}

/** Transport failure is not a failed settlement checklist. */
export class EsploraUnavailableError extends Error {
  constructor(readonly hosts: readonly string[], readonly causes: readonly unknown[]) {
    super(`Block explorer unavailable: ${causes.map(e => e instanceof Error ? e.message : String(e)).join('; ')}`);
    this.name = 'EsploraUnavailableError';
  }
}
export const SETTLEMENT_EXPLORER_TIMEOUT_MS = 20_000;

/** Build a deadline-bound `fetch`-backed EsploraFetch for the app (throws on
 * non-2xx). An overall generation signal may cancel every chain read together. */
/** The shipped mainnet explorer and the two public explorers it is hedged and
 *  corroborated against. Independent operators, so one lying or stalled host
 *  cannot decide a read on its own. */
export const MAINNET_HEDGE_EXPLORERS = [
  "https://mempool.space/api",
  "https://blockstream.info/api",
  "https://mempool.emzy.de/api",
] as const;

// Oct 28 mainnet: several Chama tabs on one connection polled every explorer
// until blockstream.info and mempool.space rate-limited the IP (700 requests
// an hour). Every further poll was then refused too, so the limit never
// lifted while Chama stayed open. A host that answers 429, or fails three
// times in a row, is left alone for a while; reads then fail fast as
// "couldn't check", exactly as if it had answered with an error.
export class ExplorerCoolingDownError extends Error {
  constructor(readonly host: string, readonly untilMs: number) {
    super(`Block explorer ${host} is resting after too many requests`);
    this.name = "ExplorerCoolingDownError";
  }
}
const EXPLORER_FAILURE_STREAK = 3;
const EXPLORER_COOLDOWN_MIN_MS = 60_000;
const EXPLORER_COOLDOWN_MAX_MS = 15 * 60_000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const explorerHealth = new Map<string, { failures: number; coolings: number; untilMs: number }>();

/** When a host may be asked again, or 0 when it may be asked now. */
export function explorerCoolingUntil(host: string, nowMs = Date.now()): number {
  const until = explorerHealth.get(host)?.untilMs ?? 0;
  return until > nowMs ? until : 0;
}

/** Seconds from a Retry-After header, clamped; null when absent or unreadable. */
export function retryAfterMs(header: string | null, nowMs = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(EXPLORER_COOLDOWN_MAX_MS, Math.max(EXPLORER_COOLDOWN_MIN_MS, ms));
}

export function noteExplorerSuccess(host: string): void {
  explorerHealth.delete(host);
}

export function noteExplorerFailure(host: string, opts: { rateLimitedForMs?: number | null; nowMs?: number } = {}): void {
  const nowMs = opts.nowMs ?? Date.now();
  const health = explorerHealth.get(host) ?? { failures: 0, coolings: 0, untilMs: 0 };
  health.failures += 1;
  if (opts.rateLimitedForMs !== undefined || health.failures >= EXPLORER_FAILURE_STREAK) {
    const backoff = Math.min(EXPLORER_COOLDOWN_MAX_MS, EXPLORER_COOLDOWN_MIN_MS * 2 ** health.coolings);
    health.untilMs = nowMs + (opts.rateLimitedForMs ?? (opts.rateLimitedForMs === null ? DEFAULT_RATE_LIMIT_COOLDOWN_MS : backoff));
    health.coolings += 1;
    health.failures = 0;
  }
  explorerHealth.set(host, health);
}

/** Forget every cooldown: the device came back online, or a test starts. */
export function resetExplorerCooldowns(): void {
  explorerHealth.clear();
}
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("online", resetExplorerCooldowns);
}

export function esploraFetcher(
  base: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; network?: BtcNetwork; hedge?: boolean } = {},
): EsploraFetch {
  return async (path: string) => {
    // Never send a stale foreign-network address to an explorer. After the
    // v5 mainnet flip, old local signet bond records can still contain tb1…;
    // mempool.space correctly rejects those with HTTP 400. Fail locally so
    // background bond housekeeping stays quiet and cannot look like a live
    // mainnet failure in the browser console.
    const addressMatch = path.match(/^\/address\/([^/]+)(?:\/|$)/);
    const address = addressMatch?.[1]?.toLowerCase();
    // ⚠ Prefer the CALLER'S declared network over sniffing the URL. The old
    // check asked "is this base mempool.space?" and treated anything else as a
    // test explorer — which was fine while the host was hardcoded, and becomes
    // a real bug the moment a user points at their own mainnet Esplora: every
    // bc1… read would be refused locally and their bonds would read unfunded.
    // URL sniffing survives only as the fallback for callers that pass no
    // network, so existing behaviour is unchanged where nothing was declared.
    const mainnetExplorer = opts.network !== undefined
      ? opts.network !== SIGNET
      : /^https:\/\/(?:www\.)?mempool\.space(?:\/|$)/i.test(base);
    if (address && ((mainnetExplorer && address.startsWith("tb1")) || (!mainnetExplorer && address.startsWith("bc1")))) {
      throw new Error(`Bitcoin address network does not match explorer: ${address.slice(0, 8)}…`);
    }
    const normalizedBase = base.replace(/\/+$/, "");
    const builtinMainnet = BUILTIN_ESPLORA_BASE.mainnet.replace(/\/+$/, "");
    // Firefox-family privacy browsers have been observed leaving a perfectly
    // valid mempool.space fetch pending for several seconds while
    // blockstream.info answers immediately (and vice versa is possible). A
    // single public explorer must not turn a chain-verified bonded count into a
    // silent zero. Hedge only the SHIPPED mainnet endpoint; a user-selected
    // explorer remains authoritative and is never bypassed behind their back.
    // `hedge: false` pins one host: corroborated reads need each answer to
    // come from the explorer they asked, not whichever raced in first.
    const candidates = opts.hedge !== false && opts.network !== SIGNET && normalizedBase === builtinMainnet
      ? [normalizedBase, ...MAINNET_HEDGE_EXPLORERS.slice(1)]
      : [normalizedBase];

    const controllers = candidates.map(() => new AbortController());
    let winner = false;
    let completed = 0;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const errors: unknown[] = [];
    const started = new Set<number>();

    return new Promise<any>((resolve, reject) => {
      const finishFailure = (index: number, error: unknown) => {
        errors[index] = error;
        completed += 1;
        if (winner) return;
        console.warn(`[chama] Block explorer ${new URL(candidates[index]).host} failed`, error instanceof Error ? error.name : 'request failed');
        // A fast explicit failure should not wait for the hedge delay.
        if (index === 0 && candidates.length > 1 && fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
          candidates.forEach((_, i) => { if (i > 0) launch(i); });
        }
        if (completed >= candidates.length) {
          reject(opts.signal?.aborted ? opts.signal.reason : new EsploraUnavailableError(candidates, errors));
        }
      };

      const launch = (index: number) => {
        const controller = controllers[index];
        if (!controller || winner || started.has(index)) return;
        started.add(index);
        const host = new URL(candidates[index]).host;
        const coolingUntil = explorerCoolingUntil(host);
        if (coolingUntil) {
          queueMicrotask(() => finishFailure(index, new ExplorerCoolingDownError(host, coolingUntil)));
          return;
        }
        const timeout = setTimeout(
          () => controller.abort(new DOMException("Esplora request timed out", "TimeoutError")),
          opts.timeoutMs ?? 8_000,
        );
        const abortOverall = () => controller.abort(opts.signal?.reason);
        if (opts.signal?.aborted) abortOverall();
        else opts.signal?.addEventListener("abort", abortOverall, { once: true });

        void fetch(`${candidates[index]}${path}`, { signal: controller.signal })
          .then(async (res) => {
            if (res.status === 429) {
              noteExplorerFailure(host, { rateLimitedForMs: retryAfterMs(res.headers?.get?.("retry-after") ?? null) });
              throw new Error(`Esplora 429 for ${path}`);
            }
            if (!res.ok) throw new Error(`Esplora ${res.status} for ${path}`);
            const value = await res.json();
            noteExplorerSuccess(host);
            return value;
          }, (error) => {
            // Losing a hedge race or the caller giving up says nothing about
            // the host; a timeout or a refused connection does.
            const lostRace = controller.signal.aborted && (controller.signal.reason as DOMException | undefined)?.name !== "TimeoutError";
            if (!lostRace) noteExplorerFailure(host);
            throw error;
          })
          .then((value) => {
            if (winner) return;
            winner = true;
            if (fallbackTimer) clearTimeout(fallbackTimer);
            controllers.forEach((other, otherIndex) => {
              if (otherIndex !== index) other.abort(new DOMException("Esplora hedge won", "AbortError"));
            });
            resolve(value);
          })
          .catch((error) => finishFailure(index, error))
          .finally(() => {
            clearTimeout(timeout);
            opts.signal?.removeEventListener("abort", abortOverall);
          });
      };

      launch(0);
      if (candidates.length > 1) {
        // Keep the normal one-request path when the primary is healthy, while
        // preventing a privacy-browser stall from consuming the whole UI
        // deadline. 600 ms is below a perceptible onboarding pause but avoids
        // doubling routine explorer traffic.
        fallbackTimer = setTimeout(() => {
          fallbackTimer = null;
          candidates.forEach((_, i) => { if (i > 0) launch(i); });
        }, 600);
      }
    });
  };
}

/** Current chain tip height (for measuring confirmation depth / timelock readiness). */
export async function esploraTipHeight(fetchJson: EsploraFetch): Promise<number> {
  const h = await fetchJson("/blocks/tip/height");
  const n = typeof h === "number" ? h : Number(h);
  if (!Number.isFinite(n)) throw new Error("Bad tip height from Esplora");
  return n;
}

/** Current recommended fee rate (sat/vB) from a mempool.space-style Esplora
 *  `/v1/fees/recommended`. A bond reclaim is NON-urgent (the owner's own capital
 *  after the term), so it targets the ~1-hour tier and clamps into [floor, cap].
 *  Any fetch/shape failure falls back to `floorPerVb` — it must NEVER block a
 *  reclaim; a low-but-relayable fee still confirms and the owner can bump it. */
export async function esploraRecommendedFeeRate(
  fetchJson: EsploraFetch,
  opts: { floorPerVb?: bigint; capPerVb?: bigint } = {},
): Promise<bigint> {
  const floor = opts.floorPerVb ?? 2n;
  const cap = opts.capPerVb ?? 100n;
  try {
    const r = await fetchJson("/v1/fees/recommended");
    const raw = r?.hourFee ?? r?.halfHourFee ?? r?.economyFee ?? r?.minimumFee;
    const rate = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? BigInt(Math.ceil(raw)) : floor;
    return rate < floor ? floor : rate > cap ? cap : rate;
  } catch {
    return floor;
  }
}

/** Highest fee rate an escrow settlement, refund or payout sweep will pay,
 *  matching the bond reclaim cap. One wrong explorer answer must not hand the
 *  escrow to miners; a capped transaction still relays and confirms. */
export const MAX_SETTLEMENT_FEE_RATE = 100n;

/** Settlement must not silently use a stale minimum when the fee API fails,
 *  and never pays above MAX_SETTLEMENT_FEE_RATE whatever the explorer says. */
export async function esploraRequiredFeeRate(fetchJson: EsploraFetch): Promise<bigint> {
  const r = await fetchJson("/v1/fees/recommended");
  const raw = r?.hourFee ?? r?.halfHourFee ?? r?.economyFee;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw new Error("Current Bitcoin fees are unavailable. Try settlement again when the fee estimate returns.");
  }
  return capSettlementFeeRate(BigInt(Math.ceil(raw)));
}

export function capSettlementFeeRate(rate: bigint): bigint {
  return rate > MAX_SETTLEMENT_FEE_RATE ? MAX_SETTLEMENT_FEE_RATE : rate;
}

/** Broadcast a raw tx hex to Esplora; returns the txid, or throws with the node's
 *  rejection reason (e.g. a CLTV "Locktime requirement not satisfied" before term). */
export async function esploraBroadcast(base: string, rawHex: string): Promise<string> {
  let res: Response, body: string;
  try {
    res = await fetch(`${base}/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawHex,
      signal: AbortSignal.timeout(SETTLEMENT_EXPLORER_TIMEOUT_MS) });
    body = await res.text();
  } catch (error) {
    console.warn(`[chama] Block explorer ${new URL(base).host} failed during broadcast`);
    throw new EsploraUnavailableError([base], [error]);
  }
  if (!res.ok) {
    const error = new Error(body || `broadcast failed (${res.status})`);
    if (res.status >= 500) {
      console.warn(`[chama] Block explorer ${new URL(base).host} failed during broadcast (${res.status})`);
      throw new EsploraUnavailableError([base], [error]);
    }
    throw error; // a node's transaction rejection is not an availability failure
  }
  return body;
}

/** Whether (txid:vout) is spent, and by which tx — Esplora `/tx/…/outspend/…`
 *  (mempool spends included). The commitment-bond reclaim uses this to RECOVER a
 *  broadcast-then-lost-state reclaim: the bond leaf is owner-key-only (NUMS internal
 *  key, single CLTV leaf), so a spend of a bond UTXO can only ever BE the owner's
 *  reclaim — finding one means the reclaim already happened. */
export async function esploraOutspend(
  fetchJson: EsploraFetch,
  txid: string,
  vout: number,
): Promise<{ spent: boolean; txid?: string }> {
  const r = await fetchJson(`/tx/${txid}/outspend/${vout}`);
  if (!r || typeof r.spent !== "boolean") throw new Error("Bad outspend response from Esplora");
  return { spent: r.spent, ...(typeof r.txid === "string" ? { txid: r.txid } : {}) };
}


/** Find ALL confirmed, minConfs-deep UTXOs at `address` — of ANY amount. For the
 *  COMMITMENT bond: the arbiter locks their own sats to their own address, so we
 *  accept whatever they send (one deposit or several; more = a bigger bond) rather
 *  than demanding an exact amount. Each carries its real scriptPubKey. Empty ⇒ keep
 *  polling. (The recompute-don't-trust script check happens at reclaim, where the
 *  address is rebuilt from the bond key.) */
export async function findBondFundingUtxos(params: {
  address: string;
  fetchJson: EsploraFetch;
  minConfs?: number;
}): Promise<BondFunding[]> {
  const minConfs = Math.max(1, Math.floor(params.minConfs ?? 1));
  const raw = await params.fetchJson(`/address/${params.address}/utxo`);
  if (!Array.isArray(raw)) return [];
  let confirmed = (raw as EsploraUtxo[]).filter((u) => u?.status?.confirmed === true && typeof u.value === "number" && u.value > 0);
  if (confirmed.length === 0) return [];
  if (minConfs > 1) {
    // Depth gate, but NEVER silently drop a confirmed deposit we can't measure: only
    // reject a UTXO whose depth is KNOWN and too shallow. A missing block_height or a
    // failed tip fetch → accept the confirmed UTXO (better than "I funded it, nothing
    // shows"). Reorg safety still holds where depth is measurable (mainnet).
    try {
      const tipRaw = await params.fetchJson(`/blocks/tip/height`);
      const tip = typeof tipRaw === "number" ? tipRaw : Number(tipRaw);
      if (Number.isFinite(tip)) {
        confirmed = confirmed.filter((u) => {
          const bh = u.status?.block_height;
          return typeof bh !== "number" || tip - bh + 1 >= minConfs;
        });
      }
    } catch { /* tip unavailable → keep the confirmed set */ }
  }
  const out: BondFunding[] = [];
  for (const u of confirmed) {
    const tx = await params.fetchJson(`/tx/${u.txid}`);
    const spkHex = tx?.vout?.[u.vout]?.scriptpubkey;
    if (typeof spkHex !== "string" || !/^[0-9a-fA-F]+$/.test(spkHex)) continue;
    out.push({
      utxo: { txid: u.txid, index: u.vout, amountSats: BigInt(u.value) },
      fundingScript: hexToBytes(spkHex),
      blockHeight: typeof u.status?.block_height === "number" ? u.status.block_height : undefined,
    });
  }
  return out;
}
