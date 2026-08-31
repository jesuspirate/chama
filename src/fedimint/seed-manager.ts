// ══════════════════════════════════════════════════════════════════════════
// Chama — Nostr-backed Fedimint Seed Manager
// ══════════════════════════════════════════════════════════════════════════
//
// The Fedimint WASM wallet needs a BIP-39 mnemonic to derive its keys.
// Chama stores that mnemonic as a NIP-44-encrypted kind-30078 *replaceable*
// event on the user's Nostr relays (d-tag: "chama-fedimint-seed-v1").
//
// Properties:
//   - The mnemonic is randomly generated, not derived from the Nostr key.
//     Compromise of the Nostr privkey does not immediately leak the seed
//     unless the attacker also has relay access at the same moment.
//
//   - Recovery: any device with the user's Nostr signer + at least one
//     relay that still holds the replaceable event can reconstruct the
//     wallet. "Lost my phone, still have my nsec" ⇒ funds recoverable.
//
//   - Replaceable: kind 30078 is NIP-33 parameterized replaceable, so each
//     relay only keeps the latest per (pubkey, d-tag) pair. No accumulation.
//
//   - Self-to-self NIP-44: the signer both encrypts and decrypts against
//     its own pubkey. Only the holder of the privkey can decrypt.
//
// This module never sees the Nostr private key directly. All crypto goes
// through the Signer interface, which delegates to NIP-07 / custom signers.

import type { NostrEvent } from "../escrow-engine/types.js";
import type { EscrowClient, Signer, UnsignedEvent } from "../escrow-engine/escrow-client.js";
import { generateSeedWords } from "nostr-tools/nip06";
import { verifyEvent as verifyNostrEventSignature } from "nostr-tools/pure";

// ── Constants ──────────────────────────────────────────────────────────────

/** NIP-33 replaceable event kind — 30000-39999 range, 30078 = app-specific data */
export const CHAMA_SEED_KIND = 30078;
/** Parameterized `d`-tag — version suffix lets us rotate the format later */
export const CHAMA_SEED_D_TAG = "chama-fedimint-seed-v1";

function isChamaSeedEvent(event: NostrEvent, pubkey: string): boolean {
  return (
    event.kind === CHAMA_SEED_KIND &&
    event.pubkey === pubkey &&
    event.tags?.some(tag => tag[0] === "d" && tag[1] === CHAMA_SEED_D_TAG) === true
  );
}

// ── v0.1.69: Seed resilience constants ──────────────────────────────────

/**
 * Republish the seed event if the most recent one we can find on relays
 * is older than this threshold. 7 days gives us weekly refreshes, which
 * keeps the event "warm" on relays that prune inactive replaceable events
 * without hammering relays on every session.
 */
export const SEED_REPUBLISH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** localStorage key for seed health tracking (for UI consumption) */
export const SEED_HEALTH_STORAGE_KEY = "chama_seed_health_v1";

// ── v0.1.74 seed safety ─────────────────────────────────────────────────

/**
 * localStorage key. Set on a per-pubkey basis the first time we
 * successfully publish a seed event for that pubkey on this device.
 * Used as the "previously had a seed" gate that prevents silent fresh-
 * seed generation on later launches when relay recovery returns empty.
 *
 * Format: { [pubkey: string]: { firstPublishedAt: number, lastEventId: string } }
 */
export const SEED_PUBLISHED_MARKER_KEY = "chama_seed_published_v1";
/** Per-pubkey proof that this browser created a seed but has not completed its
 * first federation join yet. This lets a reload resume a brand-new wallet
 * without misclassifying its just-published relay event as an old wallet that
 * needs force_recover. */
export const SEED_PENDING_FIRST_JOIN_KEY = "chama_seed_pending_first_join_v1";
/** Signed, still-encrypted seed event cached per npub. This contains no
 * plaintext mnemonic; the active signer must decrypt it again. Returning
 * identities can therefore open their mapped local wallet without waiting
 * for a 15-second relay round trip on every login. */
export const SEED_LOCAL_EVENT_CACHE_KEY = "chama_seed_event_cache_v1";

/** Longer recovery timeout — was 5s, far too short on slow networks. */
export const SEED_RECOVERY_TIMEOUT_MS = 15_000;

/** v0.1.85 Bug G — backoff schedule for retrying a zero-event recovery
 *  query when we KNOW a seed should exist (marker present). Three
 *  retries at 1s / 2s / 4s — addresses transient relay flakiness on
 *  cold-start auto-init without compromising the safety semantics for
 *  genuinely lost seeds. The initial query already runs once before
 *  the retry helper engages, so total attempts = 4. */
export const SEED_RECOVERY_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * Fedi Mini-App cold starts can expose `window.nostr` before its NIP-44
 * decrypt path is fully ready. If relays return the seed event but the
 * first self-decrypt fails, retry before surfacing the scary wrong-signer
 * error. This does not loosen seed safety: if all retries fail, we still
 * refuse to generate a replacement seed.
 */
export const SEED_DECRYPT_RETRY_DELAYS_MS = [750, 1_500, 3_000];
export const FEDI_SEED_DECRYPT_RETRY_DELAYS_MS = [750, 1_500, 3_000, 6_000, 10_000];
export const SEED_RECOVERY_RELAYS_UNREADY = "SEED_RECOVERY_RELAYS_UNREADY";

function seedRecoveryRelaysUnreadyError(): Error & { code: string } {
  const error = new Error(
    "Your Nostr relays are still connecting, so Chama did not create or replace a wallet seed. " +
    "Your account is signed in; tap Reconnect in the Chama bar when the relay count recovers.",
  ) as Error & { code: string };
  error.code = SEED_RECOVERY_RELAYS_UNREADY;
  return error;
}

function hasFediRuntime(): boolean {
  return typeof window !== "undefined" && !!(window as any).fediInternal;
}

function seedDecryptRetryDelaysForRuntime(): number[] {
  return hasFediRuntime()
    ? FEDI_SEED_DECRYPT_RETRY_DELAYS_MS
    : SEED_DECRYPT_RETRY_DELAYS_MS;
}

/**
 * Run `queryFn` up to `delaysMs.length` times, sleeping between attempts.
 * Returns the first non-empty result, or [] if every attempt was empty.
 *
 * Pure: takes the query function and an optional sleep injector so the
 * retry behavior can be unit-tested without real timers or relays.
 *
 * Used by getOrCreateSeed when an initial recovery query returns zero
 * events AND a seed-published marker exists locally (i.e. we expect
 * the seed to be on relays — empty result must be transient).
 */
export async function queryUntilFound<T>(
  queryFn: () => Promise<T[]>,
  delaysMs: number[],
  sleepFn: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T[]> {
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) await sleepFn(delaysMs[i]);
    const events = await queryFn();
    if (events.length > 0) return events;
  }
  return [];
}

function looksLikeMnemonic(text: string | null): boolean {
  if (!text) return false;
  const w = text.trim().split(/\s+/);
  return w.length >= 12 && w.length <= 24 && w.every(word => /^[a-z]+$/.test(word));
}

async function tryDecryptSeedEvent(
  candidate: NostrEvent,
  pubkey: string,
  signer: Signer,
): Promise<string | null> {
  // Try 1: NIP-44 decrypt
  try {
    const attempt = await signer.nip44Decrypt(candidate.content, pubkey);
    if (looksLikeMnemonic(attempt)) {
      console.debug("[chama] Seed decrypted via NIP-44");
      return attempt;
    }
    console.debug("[chama] NIP-44 decrypted but result is not a valid mnemonic — trying NIP-04");
  } catch (e1) {
    console.debug("[chama] NIP-44 seed decrypt failed:", (e1 as Error)?.message?.slice(0, 50));
  }

  // Try 2: NIP-04 decrypt (seed may have been encrypted with older method)
  try {
    const nostr = (window as any).nostr;
    if (nostr?.nip04?.decrypt) {
      const attempt = await nostr.nip04.decrypt(pubkey, candidate.content);
      if (looksLikeMnemonic(attempt)) {
        console.debug("[chama] Seed decrypted via NIP-04");
        return attempt;
      }
      console.debug("[chama] NIP-04 decrypted but result is not a valid mnemonic");
    }
  } catch (e2) {
    console.debug("[chama] NIP-04 seed decrypt failed:", (e2 as Error)?.message?.slice(0, 50));
  }

  // Try 3: content might be plaintext JSON or raw mnemonic (dev mode)
  try {
    const raw = candidate.content.trim();
    if (looksLikeMnemonic(raw)) {
      console.debug("[chama] Seed found as plaintext mnemonic");
      return raw;
    }
  } catch {}

  return null;
}

export async function recoverSeedWordsFromEvents(
  events: NostrEvent[],
  pubkey: string,
  signer: Signer,
  options: {
    delaysMs?: number[];
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<{ words: string[]; event: NostrEvent } | null> {
  const sorted = [...events].sort((a, b) => b.created_at - a.created_at);
  const delaysMs = options.delaysMs ?? seedDecryptRetryDelaysForRuntime();
  const sleepFn = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      const delayMs = delaysMs[attempt - 1];
      mlog("SEED-DECRYPT-RETRY", {
        pubkey: pubkey.slice(0, 8),
        attempt,
        delayMs,
      });
      await sleepFn(delayMs);
    }

    for (const candidate of sorted) {
      const plaintext = await tryDecryptSeedEvent(candidate, pubkey, signer);
      if (!plaintext) continue;

      const words = plaintext.trim().split(/\s+/);
      if (words.length >= 12 && words.length <= 24) {
        return { words, event: candidate };
      }
    }
  }

  return null;
}

/**
 * v0.1.74 [$$] money-flow instrumentation, gated on
 * localStorage.chama_debug_money === "1". Used to trace the seed
 * lifecycle without depending on remote logs.
 */
function mlog(checkpoint: string, fields: Record<string, unknown> = {}): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem("chama_debug_money") !== "1") return;
  } catch { return; }
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
  console.info(`[$$] ${checkpoint} ${parts}`);
}

/** Read the per-pubkey seed-published marker from localStorage. */
function loadSeedPublishedMarker(pubkey: string): { firstPublishedAt: number; lastEventId: string } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SEED_PUBLISHED_MARKER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const entry = parsed[pubkey];
    if (!entry || typeof entry !== "object") return null;
    if (typeof entry.firstPublishedAt !== "number") return null;
    if (typeof entry.lastEventId !== "string") return null;
    return entry;
  } catch {
    return null;
  }
}

/** Write the per-pubkey seed-published marker to localStorage. */
function saveSeedPublishedMarker(pubkey: string, eventId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    let parsed: Record<string, { firstPublishedAt: number; lastEventId: string }> = {};
    try {
      const raw = localStorage.getItem(SEED_PUBLISHED_MARKER_KEY);
      if (raw) parsed = JSON.parse(raw) || {};
    } catch { /* parse failure -> overwrite with fresh */ }
    const existing = parsed[pubkey];
    parsed[pubkey] = {
      firstPublishedAt: existing?.firstPublishedAt ?? Date.now(),
      lastEventId: eventId,
    };
    localStorage.setItem(SEED_PUBLISHED_MARKER_KEY, JSON.stringify(parsed));
  } catch (e) {
    console.warn("[chama] saveSeedPublishedMarker failed:", e);
  }
}

function localSeedEventKey(pubkey: string): string {
  return `${SEED_LOCAL_EVENT_CACHE_KEY}:${pubkey}`;
}

function saveLocalSeedEvent(pubkey: string, event: NostrEvent): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(localSeedEventKey(pubkey), JSON.stringify(event));
  } catch (error) {
    console.debug("[chama] Couldn't cache encrypted seed event locally:", error);
  }
}

function loadLocalSeedEvent(pubkey: string): NostrEvent | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(localSeedEventKey(pubkey));
    if (!raw) return null;
    const event = JSON.parse(raw) as NostrEvent;
    const marker = loadSeedPublishedMarker(pubkey);
    if (!marker || marker.lastEventId !== event.id) return null;
    if (!isChamaSeedEvent(event, pubkey)) return null;
    if (!verifyNostrEventSignature(event as any)) return null;
    return event;
  } catch {
    return null;
  }
}

/**
 * Snapshot of seed-backup health. Consumed by UI (v0.1.71+) to render
 * a "your seed is backed up on N relays" indicator.
 */
export interface SeedHealth {
  /** How many seed events the relays returned on the last check */
  relaysReturnedSeed: number;
  /** Unix seconds — created_at of the newest seed event found */
  newestEventCreatedAt: number | null;
  /** Unix ms — when we last verified presence on relays */
  lastCheckedAt: number;
  /** Unix ms — when we last published (or republished) the seed */
  lastPublishedAt: number | null;
}

// ── In-memory cache (per session) ──────────────────────────────────────────

let cachedSeed: string[] | null = null;
let cachedForPubkey: string | null = null;
let cachedSeedSource: "fresh" | "recovered" | null = null;

/** Clear the cache — call on disconnect / signer change */
export function clearSeedCache(): void {
  cachedSeed = null;
  cachedForPubkey = null;
  cachedSeedSource = null;
}

/**
 * Tell wallet bootstrap whether the cached mnemonic predates this browser
 * wallet. Recovery is required for a seed read from relays, because it may
 * already have mint state on another device. A seed generated moments ago for
 * a genuinely new identity has nothing to recover and must join normally.
 */
export function cachedSeedRequiresFederationRecovery(pubkey: string): boolean {
  return cachedForPubkey === pubkey && cachedSeedSource === "recovered";
}

function loadPendingFirstJoin(pubkey: string): { eventId: string; createdAt: number } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const parsed = JSON.parse(localStorage.getItem(SEED_PENDING_FIRST_JOIN_KEY) || "{}");
    const entry = parsed?.[pubkey];
    return entry && typeof entry.eventId === "string" && typeof entry.createdAt === "number"
      ? entry
      : null;
  } catch {
    return null;
  }
}

function savePendingFirstJoin(pubkey: string, eventId: string): void {
  try {
    if (typeof localStorage === "undefined") return;
    const parsed = JSON.parse(localStorage.getItem(SEED_PENDING_FIRST_JOIN_KEY) || "{}");
    parsed[pubkey] = { eventId, createdAt: Date.now() };
    localStorage.setItem(SEED_PENDING_FIRST_JOIN_KEY, JSON.stringify(parsed));
  } catch (error) {
    console.warn("[chama] Couldn't persist fresh-wallet first-join state:", error);
  }
}

/** Mark the first federation join complete. Future fresh-database openings for
 * this seed must use force_recover because mint state may now exist. */
export function markCachedSeedFederationJoined(pubkey: string): void {
  if (cachedForPubkey === pubkey) cachedSeedSource = "recovered";
  try {
    if (typeof localStorage === "undefined") return;
    const parsed = JSON.parse(localStorage.getItem(SEED_PENDING_FIRST_JOIN_KEY) || "{}");
    if (!parsed?.[pubkey]) return;
    delete parsed[pubkey];
    if (Object.keys(parsed).length > 0) {
      localStorage.setItem(SEED_PENDING_FIRST_JOIN_KEY, JSON.stringify(parsed));
    } else {
      localStorage.removeItem(SEED_PENDING_FIRST_JOIN_KEY);
    }
  } catch (error) {
    console.warn("[chama] Couldn't clear fresh-wallet first-join state:", error);
  }
}

/** v2.4 — read the in-memory BIP-39 mnemonic for the recovery-phrase reveal
 *  (Me › Advanced). Returns the 12 words ONLY after getOrCreateSeed has run
 *  this session (i.e. the wallet initialized); null otherwise, so the UI can
 *  prompt the user to connect first. The words never leave the device here —
 *  this is the user's own offline-backup escape hatch, the private key to the
 *  ecash Chama never custodies. Returns a copy so callers can't mutate the
 *  cache. */
export function getCachedSeedWords(): string[] | null {
  return cachedSeed ? [...cachedSeed] : null;
}

// ══════════════════════════════════════════════════════════════════════════
// PUBLIC API
// ══════════════════════════════════════════════════════════════════════════

/**
 * Fetch the user's Chama Fedimint seed, or generate one if none exists.
 *
 * Flow:
 *   1. Query relays for the latest kind-30078 event with d="chama-fedimint-seed-v1"
 *      authored by the user's pubkey.
 *   2. If found, NIP-44 decrypt to self and return the mnemonic words.
 *   3. If not found (or decryption fails), generate a fresh BIP-39 mnemonic,
 *      NIP-44 encrypt to self, publish as a replaceable event, return.
 *
 * Idempotent: subsequent calls within the same session hit the cache.
 */
export async function getOrCreateSeed(
  client: EscrowClient,
  signer: Signer
): Promise<string[]> {
  const pubkey = await signer.getPublicKey();

  if (cachedSeed && cachedForPubkey === pubkey) {
    return cachedSeed;
  }

  // Returning-device fast path. The cached object is the same signed,
  // NIP-44-encrypted event previously accepted from relays (or published by
  // this signer), never a plaintext mnemonic. Verify its event signature and
  // marker binding, then ask the current signer to decrypt it. Relay health is
  // checked fire-and-forget after wallet startup, so this removes login
  // latency without weakening the remote backup or replacement-seed guards.
  const localEvent = loadLocalSeedEvent(pubkey);
  if (localEvent) {
    const local = await recoverSeedWordsFromEvents(
      [localEvent],
      pubkey,
      signer,
      { delaysMs: [] },
    );
    if (local) {
      cachedSeed = local.words;
      cachedForPubkey = pubkey;
      cachedSeedSource = loadPendingFirstJoin(pubkey) ? "fresh" : "recovered";
      console.info("[chama] Fedimint seed opened from verified local encrypted cache");
      return local.words;
    }
  }

  // ── 1. Try to recover existing seed ─────────────────────────────────────
  // v0.1.74 seed safety: longer timeout, paranoid empty-result handling.
  // The 5-second timeout used previously was the upstream cause of the
  // silent fresh-seed bug — slow relays + cold WebSocket pool + first-
  // load WASM contention frequently exceeded 5s, leading to a false-
  // negative "no seed exists" result and a fresh-mnemonic generation
  // that displaced the user's real seed on relays.
  mlog("SEED-RECOVERY-START", { pubkey: pubkey.slice(0, 8), timeoutMs: SEED_RECOVERY_TIMEOUT_MS });
  const seedFilter = {
    kinds: [CHAMA_SEED_KIND],
    authors: [pubkey],
    "#d": [CHAMA_SEED_D_TAG],
    limit: 4,
  };
  let existing = (await client.queryOnce(seedFilter, SEED_RECOVERY_TIMEOUT_MS))
    .filter(event => isChamaSeedEvent(event, pubkey));
  mlog("SEED-RECOVERY-RESULT", {
    pubkey: pubkey.slice(0, 8),
    eventCount: existing.length,
    eventIds: existing.map(e => e.id?.slice(0, 8)).join(","),
  });

  // v0.1.85 Bug G — retry-with-backoff for cold-start relay flakiness.
  // Only retry when we have a marker (we KNOW a seed should exist);
  // for true first-launch (no marker) zero events is the correct
  // signal and we should proceed straight to fresh-mnemonic generation
  // without artificial latency. The retry doesn't loosen the safety
  // guard — it just gives the relay pool a chance to warm up before
  // we declare the seed unreachable. After all retries exhaust, the
  // existing v0.1.74 refuse-fresh logic still kicks in.
  if (existing.length === 0 && loadSeedPublishedMarker(pubkey)) {
    mlog("SEED-RECOVERY-RETRY-START", {
      pubkey: pubkey.slice(0, 8),
      delaysMs: SEED_RECOVERY_RETRY_DELAYS_MS.join(","),
    });
    existing = await queryUntilFound(
      async () => (await client.queryOnce(seedFilter, SEED_RECOVERY_TIMEOUT_MS))
        .filter(event => isChamaSeedEvent(event, pubkey)),
      SEED_RECOVERY_RETRY_DELAYS_MS,
    );
    mlog("SEED-RECOVERY-RETRY-RESULT", {
      pubkey: pubkey.slice(0, 8),
      eventCount: existing.length,
    });
    if (existing.length > 0) {
      console.info("[chama] Fedimint seed recovered on retry (relay pool warmed up)");
    }
  }

  if (existing.length > 0) {
    const recovered = await recoverSeedWordsFromEvents(existing, pubkey, signer);
    if (recovered) {
      const { words, event } = recovered;
      cachedSeed = words;
      cachedForPubkey = pubkey;
      cachedSeedSource = loadPendingFirstJoin(pubkey)?.eventId === event.id
        ? "fresh"
        : "recovered";
      // v0.1.74 seed safety: record marker on recovery so future
      // sessions are protected even if the seed was originally
      // generated on a different device.
      saveSeedPublishedMarker(pubkey, event.id);
      saveLocalSeedEvent(pubkey, event);
      mlog("SEED-RECOVERY-OK", {
        pubkey: pubkey.slice(0, 8),
        eventId: event.id.slice(0, 8),
        createdAt: event.created_at,
      });
      console.info("[chama] Fedimint seed recovered from Nostr relays");
      return words;
    }

    // None of the seed events decrypted to a valid mnemonic
    {
      const e = new Error("All decrypt methods failed on all seed events");
      console.error(
        "[chama] Seed event found but decryption failed.",
        "This could mean: (1) you're using a different signer than the one that created the seed,",
        "(2) the NIP-44 implementation differs, or (3) the seed event is corrupted.",
        "NOT generating a new seed to prevent overwriting your existing funds.",
        e
      );
      // DO NOT fall through to generate fresh — that would overwrite the
      // existing seed on relays and orphan any wallet that has the old seed.
      // Instead, throw so the caller can show an error to the user.
      throw new Error(
        "Couldn't decrypt your Fedimint seed from Nostr yet. Tap Reconnect and try again. " +
        "In Fedi, use Continue with Fedi. In a browser, use the same NIP-07 signer that originally created your seed. " +
        "If you've never joined a federation, click 'Reset local wallet' to start fresh."
      );
    }
  }

  // ── 2. v0.1.74 seed safety: REFUSE to generate fresh if this pubkey
  //      has previously published a seed from this device. ────────────
  //
  // Reaching this branch means recovery returned zero events. Before
  // v0.1.74, we'd silently generate a new mnemonic and publish it,
  // displacing the user's existing seed on relays via NIP-33 eviction
  // and stranding their funds. That is the fatal money-loss bug this
  // patch fixes.
  //
  // The published-marker is our local memory of "this pubkey has had
  // a seed published from this device at least once before." If it
  // exists, we know recovery returning empty is a transient relay
  // issue, NOT a true first launch. Refuse to generate fresh, throw
  // a clear error the user can act on.
  const marker = loadSeedPublishedMarker(pubkey);
  if (marker) {
    mlog("SEED-REFUSE-FRESH", {
      pubkey: pubkey.slice(0, 8),
      markerFirstPublishedAt: marker.firstPublishedAt,
      lastEventId: marker.lastEventId.slice(0, 8),
    });
    console.error(
      "[chama] v0.1.74 seed safety: recovery returned no seed events, " +
      "but this device has previously published a seed for this pubkey " +
      `(first published: ${new Date(marker.firstPublishedAt).toISOString()}, ` +
      `last event id: ${marker.lastEventId.slice(0, 16)}…). ` +
      "REFUSING to generate a fresh seed — that would displace your " +
      "existing seed on relays and strand your funds."
    );
    throw new Error(
      "Couldn't reach your seed on Nostr relays. Your funds are safe — " +
      "please check your network connection and try again. " +
      "(To prevent fund loss, Chama refuses to generate a new seed when " +
      "this device has previously stored one.)"
    );
  }

  // A zero-event read is only evidence of "no prior wallet" when enough of
  // the configured relay pool actually answered. This matters most on mobile
  // webviews: `connected` means the Nostr client was constructed, not that its
  // WebSockets have opened. Before this guard, a fresh device with an OLD npub
  // could query zero relays, conclude there was no backup, and attempt to
  // publish a replacement seed. The later publish usually failed too, which
  // appeared to the user as a login failure; worse, a partial pool could have
  // accepted the replacement. Fail closed and let reconnect retry instead.
  if (!client.hasRecoveryReadQuorum()) {
    mlog("SEED-REFUSE-FRESH-RELAY-QUORUM", {
      pubkey: pubkey.slice(0, 8),
      connectedRelays: client.getConnectedRelayCount(),
    });
    throw seedRecoveryRelaysUnreadyError();
  }

  // ── 3. True first launch — no marker, no recovery. Generate fresh. ──
  mlog("SEED-FIRST-LAUNCH", { pubkey: pubkey.slice(0, 8) });
  const mnemonic = generateSeedWords(); // 12-word BIP-39 via @scure/bip39
  const words = mnemonic.trim().split(/\s+/);

  const ciphertext = await signer.nip44Encrypt(mnemonic, pubkey);

  const now = Math.floor(Date.now() / 1000);
  const unsigned: UnsignedEvent = {
    kind: CHAMA_SEED_KIND,
    created_at: now,
    tags: [
      ["d", CHAMA_SEED_D_TAG],
      ["client", "chama"],
    ],
    content: ciphertext,
  };

  const signed: NostrEvent = await signer.signEvent(unsigned);
  await client.publishRaw(signed);
  recordSeedPublished();

  // v0.1.74 seed safety: record the marker so future sessions on this
  // device know this pubkey has had a seed published before, and won't
  // be allowed to silently regenerate on a relay timeout.
  saveSeedPublishedMarker(pubkey, signed.id);
  saveLocalSeedEvent(pubkey, signed);
  savePendingFirstJoin(pubkey, signed.id);
  mlog("SEED-PUBLISH-OK", {
    pubkey: pubkey.slice(0, 8),
    eventId: signed.id.slice(0, 8),
    source: "first-launch",
  });

  cachedSeed = words;
  cachedForPubkey = pubkey;
  cachedSeedSource = "fresh";
  console.info("[chama] Fresh Fedimint seed generated and published to relays");
  return words;
}

/**
 * Force a republish of the current seed. Useful when joining new relays
 * that may not have the event yet. No-op if no seed is cached.
 */
export async function republishSeed(
  client: EscrowClient,
  signer: Signer
): Promise<void> {
  if (!cachedSeed) return;
  const pubkey = await signer.getPublicKey();
  const mnemonic = cachedSeed.join(" ");
  const ciphertext = await signer.nip44Encrypt(mnemonic, pubkey);
  const now = Math.floor(Date.now() / 1000);
  const unsigned: UnsignedEvent = {
    kind: CHAMA_SEED_KIND,
    created_at: now,
    tags: [
      ["d", CHAMA_SEED_D_TAG],
      ["client", "chama"],
    ],
    content: ciphertext,
  };
  const signed = await signer.signEvent(unsigned);
  await client.publishRaw(signed);
  recordSeedPublished();
  // v0.1.74 seed safety: keep the marker fresh on every republish so
  // a device that successfully republishes is locked into the safety
  // gate going forward.
  saveSeedPublishedMarker(pubkey, signed.id);
  saveLocalSeedEvent(pubkey, signed);
  mlog("SEED-PUBLISH-OK", {
    pubkey: pubkey.slice(0, 8),
    eventId: signed.id.slice(0, 8),
    source: "republish",
  });
}

// ══════════════════════════════════════════════════════════════════════════
// v0.1.69 — SEED RESILIENCE: staleness check, republish, health tracking
// ══════════════════════════════════════════════════════════════════════════

/**
 * Check how many seed events exist on relays, and republish if the newest
 * is older than SEED_REPUBLISH_INTERVAL_MS. Records health info to
 * localStorage for UI consumption.
 *
 * Called fire-and-forget from useEscrow.initFedimint after getOrCreateSeed.
 * "Only republish on recovery, not fresh generation" is satisfied naturally:
 * a freshly-generated seed has created_at ≈ now, so staleness check returns
 * false and the republish branch is a no-op.
 *
 * Non-throwing by design — this is resilience work, and errors here should
 * never block the user from using the wallet. All failures log and return.
 */
export async function checkAndMaybeRepublishSeed(
  client: EscrowClient,
  signer: Signer
): Promise<SeedHealth> {
  const now = Date.now();
  let health: SeedHealth = {
    relaysReturnedSeed: 0,
    newestEventCreatedAt: null,
    lastCheckedAt: now,
    lastPublishedAt: loadSeedHealth()?.lastPublishedAt ?? null,
  };

  try {
    const pubkey = await signer.getPublicKey();

    // Query relays for the current seed event(s)
    const existing = (await client.queryOnce(
      {
        kinds: [CHAMA_SEED_KIND],
        authors: [pubkey],
        "#d": [CHAMA_SEED_D_TAG],
        limit: 4,
      },
      5_000
    )).filter(event => isChamaSeedEvent(event, pubkey));

    health.relaysReturnedSeed = existing.length;

    if (existing.length === 0) {
      // v0.1.74 seed safety: REMOVED the "republish defensively" branch.
      //
      // Original behavior:
      //   On zero events found, the cached seed was republished. The
      //   intent was "the network must have lost it, push our copy
      //   back up." But this code path is exactly what made the
      //   silent-fresh-seed bug durable: if getOrCreateSeed had just
      //   minutes earlier fallen into its 5-second-timeout-empty trap
      //   and generated a brand-new mnemonic, this branch would then
      //   republish that fresh mnemonic, evicting any genuine seed
      //   that did exist on relays a moment later.
      //
      // New behavior:
      //   Zero events on relays is a SCARY result, not a routine one.
      //   Surface it to the user via the health snapshot. Do not
      //   self-heal silently — that's how funds get displaced.
      //
      //   The correct action when the user sees "0 relays returned
      //   the seed" is to investigate (relay outage? pruned events?
      //   wrong nsec?), not to push a republish that may overwrite
      //   the very seed we're hoping the network can recover.
      console.warn(
        "[chama] Seed health check: zero events found on relays. " +
        "Not republishing — see v0.1.74 seed safety. If you believe " +
        "your seed has been lost from relays, investigate manually."
      );
      mlog("SEED-HEALTH-ZERO", { pubkey: pubkey.slice(0, 8) });
      saveSeedHealth(health);
      return health;
    }

    // Find the newest event
    const newest = existing.reduce((a, b) =>
      b.created_at > a.created_at ? b : a
    );
    health.newestEventCreatedAt = newest.created_at;

    // Staleness check: republish if the newest event is older than
    // SEED_REPUBLISH_INTERVAL_MS. v0.1.74 seed safety: this is now the
    // ONLY path that can trigger a republish from the health-check side.
    // The "zero events found → republish defensively" branch was
    // removed because it was the durability mechanism for the silent
    // fresh-seed displacement bug.
    const ageMs = now - newest.created_at * 1000;
    if (ageMs > SEED_REPUBLISH_INTERVAL_MS) {
      console.info(
        `[chama] seed event is ${Math.round(ageMs / 86400000)} days old ` +
        `— republishing to keep it warm on relays`
      );
      mlog("SEED-STALENESS-REPUBLISH", {
        pubkey: pubkey.slice(0, 8),
        ageDays: Math.round(ageMs / 86400000),
        previousEventId: newest.id?.slice(0, 8),
      });
      try {
        await republishSeed(client, signer);
        health.lastPublishedAt = Date.now();
      } catch (e) {
        console.warn("[chama] staleness-triggered seed republish failed:", e);
      }
    }

    saveSeedHealth(health);
    return health;
  } catch (e) {
    console.warn("[chama] seed health check failed (non-fatal):", e);
    saveSeedHealth(health);
    return health;
  }
}

/**
 * Read the most recently recorded seed health snapshot. Returns null if
 * no health check has ever run (first launch, or pre-v0.1.69 data).
 */
export function getSeedHealth(): SeedHealth | null {
  return loadSeedHealth();
}

// ── Internal: seed health storage ────────────────────────────────────────

function loadSeedHealth(): SeedHealth | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(SEED_HEALTH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed as SeedHealth;
  } catch {
    return null;
  }
}

function saveSeedHealth(health: SeedHealth): void {
  try {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(SEED_HEALTH_STORAGE_KEY, JSON.stringify(health));
  } catch (e) {
    console.warn("[chama] saveSeedHealth failed:", e);
  }
}

/** Called by getOrCreateSeed and republishSeed on successful publish */
function recordSeedPublished(): void {
  const existing = loadSeedHealth();
  const updated: SeedHealth = {
    relaysReturnedSeed: existing?.relaysReturnedSeed ?? 0,
    newestEventCreatedAt: Math.floor(Date.now() / 1000),
    lastCheckedAt: existing?.lastCheckedAt ?? Date.now(),
    lastPublishedAt: Date.now(),
  };
  saveSeedHealth(updated);
}
