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
import { SIGNET, type BtcNetwork, type BondUtxo } from "./multisig.js";
import { BUILTIN_ESPLORA_BASE, resolveEsploraBase } from "./esplora-config.js";

/** Minimal shape of an Esplora `/address/{addr}/utxo` entry. */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean; block_height?: number };
}

/** An injected Esplora GET that returns parsed JSON for a path like
 *  `/address/{addr}/utxo` or `/tx/{txid}`. In the app this wraps `fetch`; in tests
 *  it's a fake. */
export type EsploraFetch = (path: string) => Promise<any>;

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

/** Build a deadline-bound `fetch`-backed EsploraFetch for the app (throws on
 * non-2xx). An overall generation signal may cancel every chain read together. */
export function esploraFetcher(
  base: string,
  opts: { signal?: AbortSignal; timeoutMs?: number; network?: BtcNetwork } = {},
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
    const candidates = opts.network !== SIGNET && normalizedBase === builtinMainnet
      ? [normalizedBase, "https://blockstream.info/api"]
      : [normalizedBase];

    const controllers = candidates.map(() => new AbortController());
    let winner = false;
    let completed = 0;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    const errors: unknown[] = [];

    return new Promise<any>((resolve, reject) => {
      const finishFailure = (index: number, error: unknown) => {
        errors[index] = error;
        completed += 1;
        if (winner) return;
        // A fast explicit failure should not wait for the hedge delay.
        if (index === 0 && candidates.length > 1 && fallbackTimer) {
          clearTimeout(fallbackTimer);
          fallbackTimer = null;
          launch(1);
        }
        if (completed >= candidates.length) {
          reject(errors.find(Boolean) ?? new Error(`Esplora unavailable for ${path}`));
        }
      };

      const launch = (index: number) => {
        const controller = controllers[index];
        if (!controller || winner) return;
        const timeout = setTimeout(
          () => controller.abort(new DOMException("Esplora request timed out", "TimeoutError")),
          opts.timeoutMs ?? 8_000,
        );
        const abortOverall = () => controller.abort(opts.signal?.reason);
        if (opts.signal?.aborted) abortOverall();
        else opts.signal?.addEventListener("abort", abortOverall, { once: true });

        void fetch(`${candidates[index]}${path}`, { signal: controller.signal })
          .then(async (res) => {
            if (!res.ok) throw new Error(`Esplora ${res.status} for ${path}`);
            return res.json();
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
          launch(1);
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

/** Broadcast a raw tx hex to Esplora; returns the txid, or throws with the node's
 *  rejection reason (e.g. a CLTV "Locktime requirement not satisfied" before term). */
export async function esploraBroadcast(base: string, rawHex: string): Promise<string> {
  const res = await fetch(`${base}/tx`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: rawHex });
  const body = await res.text();
  if (!res.ok) throw new Error(body || `broadcast failed (${res.status})`);
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

export interface BondFunding {
  utxo: BondUtxo;
  /** Block the deposit confirmed in, when Esplora reported it. This is the
   *  tenure clock: unforgeable, and instantly checkable by anyone. */
  blockHeight?: number;
  /** The ACTUAL on-chain output script at (txid, vout), read off the funding tx —
   *  recompute-don't-trust reaches the deposit. */
  fundingScript: Uint8Array;
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
