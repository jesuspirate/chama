import type { ChamaLiveness } from "./live-chama.js";

export const LIVENESS_GENERATION_TIMEOUT_MS = 12_000;
export const LIVENESS_CACHE_TTL_MS = 5 * 60_000;
export const LIVENESS_DIAGNOSTICS_KEY = "chama_liveness_diagnostics_v1";
export const LIVENESS_CACHE_KEY = "chama_liveness_verified_cache_v1";
const MAX_DIAGNOSTICS = 40;

export interface LivenessGenerationDiagnostic {
  community: string;
  startedAt: number;
  finishedAt: number | null;
  durationMs: number;
  joinedCallers: number;
  maxSimultaneous: number;
  outcome: "in-flight" | "verified" | "empty" | "timeout" | "aborted" | "error";
}

export interface CoordinatedLivenessResult {
  liveness: ChamaLiveness | null;
  source: "live" | "cache" | "none";
  outcome: LivenessGenerationDiagnostic["outcome"];
}

interface Generation {
  promise: Promise<CoordinatedLivenessResult>;
  controller: AbortController;
  diagnostic: LivenessGenerationDiagnostic;
}

const inFlight = new Map<string, Generation>();
const verifiedCache = new Map<string, { value: ChamaLiveness; at: number }>();
let simultaneous = 0;

function readDiagnostics(): LivenessGenerationDiagnostic[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(LIVENESS_DIAGNOSTICS_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.slice(-MAX_DIAGNOSTICS) : [];
  } catch {
    return [];
  }
}

function persist(diagnostic: LivenessGenerationDiagnostic): void {
  try {
    const rows = readDiagnostics();
    const index = rows.findIndex(
      row => row.community === diagnostic.community && row.startedAt === diagnostic.startedAt,
    );
    if (index >= 0) rows[index] = diagnostic;
    else rows.push(diagnostic);
    localStorage.setItem(LIVENESS_DIAGNOSTICS_KEY, JSON.stringify(rows.slice(-MAX_DIAGNOSTICS)));
  } catch {
    // Diagnostics must never affect liveness.
  }
}

export function readCachedLiveness(community: string, now = Date.now()): ChamaLiveness | null {
  let entry = verifiedCache.get(community);
  if (!entry) {
    try {
      const raw = JSON.parse(localStorage.getItem(LIVENESS_CACHE_KEY) ?? "{}")[community];
      if (raw && typeof raw.at === "number" && raw.value) {
        entry = {
          at: raw.at,
          value: {
            ...raw.value,
            totalBondSats: BigInt(raw.value.totalBondSats),
            bondWeightSatBlocks: BigInt(raw.value.bondWeightSatBlocks),
          },
        };
        verifiedCache.set(community, entry);
      }
    } catch {
      entry = undefined;
    }
  }
  return entry && now - entry.at <= LIVENESS_CACHE_TTL_MS ? entry.value : null;
}

function rememberVerified(community: string, value: ChamaLiveness, at: number): void {
  verifiedCache.set(community, { value, at });
  try {
    const store = JSON.parse(localStorage.getItem(LIVENESS_CACHE_KEY) ?? "{}");
    store[community] = {
      at,
      value: {
        ...value,
        totalBondSats: value.totalBondSats.toString(),
        bondWeightSatBlocks: value.bondWeightSatBlocks.toString(),
      },
    };
    localStorage.setItem(LIVENESS_CACHE_KEY, JSON.stringify(store));
  } catch {
    // A verified in-memory result remains usable when storage is unavailable.
  }
}

export function getLivenessDiagnostics(): LivenessGenerationDiagnostic[] {
  return readDiagnostics();
}

export function loadCoordinatedLiveness(
  community: string,
  loader: (community: string, signal: AbortSignal) => Promise<ChamaLiveness | null>,
  timeoutMs = LIVENESS_GENERATION_TIMEOUT_MS,
): Promise<CoordinatedLivenessResult> {
  const existing = inFlight.get(community);
  if (existing) {
    existing.diagnostic.joinedCallers++;
    persist(existing.diagnostic);
    return existing.promise;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  simultaneous++;
  const diagnostic: LivenessGenerationDiagnostic = {
    community,
    startedAt,
    finishedAt: null,
    durationMs: 0,
    joinedCallers: 0,
    maxSimultaneous: simultaneous,
    outcome: "in-flight",
  };
  persist(diagnostic);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Liveness generation timed out", "TimeoutError"));
  }, timeoutMs);

  const finish = (
    outcome: LivenessGenerationDiagnostic["outcome"],
    value: ChamaLiveness | null,
  ): CoordinatedLivenessResult => {
    diagnostic.finishedAt = Date.now();
    diagnostic.durationMs = diagnostic.finishedAt - startedAt;
    diagnostic.outcome = outcome;
    persist(diagnostic);
    if (value) rememberVerified(community, value, diagnostic.finishedAt);
    const fallback = value ?? readCachedLiveness(community, diagnostic.finishedAt);
    return { liveness: fallback, source: value ? "live" : fallback ? "cache" : "none", outcome };
  };

  const abortPromise = new Promise<never>((_, reject) => {
    controller.signal.addEventListener(
      "abort",
      () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError")),
      { once: true },
    );
  });
  const promise = Promise.race([loader(community, controller.signal), abortPromise])
    .then(value => finish(value ? "verified" : "empty", value))
    .catch(error => {
      const aborted = controller.signal.aborted;
      return finish(timedOut ? "timeout" : aborted ? "aborted" : "error", null);
    })
    .finally(() => {
      clearTimeout(timer);
      simultaneous = Math.max(0, simultaneous - 1);
      if (inFlight.get(community)?.promise === promise) inFlight.delete(community);
    });

  inFlight.set(community, { promise, controller, diagnostic });
  return promise;
}

/** Test/cleanup seam. Aborts generations; never clears user-facing app data. */
export function resetLivenessCoordinator(): void {
  for (const generation of inFlight.values()) generation.controller.abort();
  inFlight.clear();
  verifiedCache.clear();
  simultaneous = 0;
}
