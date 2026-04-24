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

// ── Constants ──────────────────────────────────────────────────────────────

/** NIP-33 replaceable event kind — 30000-39999 range, 30078 = app-specific data */
export const CHAMA_SEED_KIND = 30078;
/** Parameterized `d`-tag — version suffix lets us rotate the format later */
export const CHAMA_SEED_D_TAG = "chama-fedimint-seed-v1";

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

/** Clear the cache — call on disconnect / signer change */
export function clearSeedCache(): void {
  cachedSeed = null;
  cachedForPubkey = null;
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

  // ── 1. Try to recover existing seed ─────────────────────────────────────
  const existing = await client.queryOnce(
    {
      kinds: [CHAMA_SEED_KIND],
      authors: [pubkey],
      "#d": [CHAMA_SEED_D_TAG],
      limit: 4,
    },
    5_000
  );

  if (existing.length > 0) {
    // Sort by newest first. Try each event until one decrypts to a valid mnemonic.
    // This handles the case where multiple seed events exist (e.g. published
    // from different sessions) and the newest might not be decryptable by this key.
    const sorted = [...existing].sort((a, b) => b.created_at - a.created_at);

    for (const candidate of sorted) {
    // Try multiple decrypt methods — seed may have been encrypted with
    // NIP-44, NIP-04, or even stored as plaintext (dev/testing)
    let plaintext: string | null = null;
    const newest = candidate; // keep variable name for minimal diff

    // Helper: check if decrypted text looks like a valid BIP-39 mnemonic
    const looksLikeMnemonic = (text: string | null): boolean => {
      if (!text) return false;
      const w = text.trim().split(/\s+/);
      return w.length >= 12 && w.length <= 24 && w.every(word => /^[a-z]+$/.test(word));
    };

    // Try 1: NIP-44 decrypt
    try {
      const attempt = await signer.nip44Decrypt(newest.content, pubkey);
      if (looksLikeMnemonic(attempt)) {
        plaintext = attempt;
        console.debug("[chama] Seed decrypted via NIP-44");
      } else {
        console.debug("[chama] NIP-44 decrypted but result is not a valid mnemonic — trying NIP-04");
      }
    } catch (e1) {
      console.debug("[chama] NIP-44 seed decrypt failed:", (e1 as Error)?.message?.slice(0, 50));
    }

    // Try 2: NIP-04 decrypt (seed may have been encrypted with older method)
    if (!plaintext) {
      try {
        const nostr = (window as any).nostr;
        if (nostr?.nip04?.decrypt) {
          const attempt = await nostr.nip04.decrypt(pubkey, newest.content);
          if (looksLikeMnemonic(attempt)) {
            plaintext = attempt;
            console.debug("[chama] Seed decrypted via NIP-04");
          } else {
            console.debug("[chama] NIP-04 decrypted but result is not a valid mnemonic");
          }
        }
      } catch (e2) {
        console.debug("[chama] NIP-04 seed decrypt failed:", (e2 as Error)?.message?.slice(0, 50));
      }
    }

    // Try 3: content might be plaintext JSON or raw mnemonic (dev mode)
    if (!plaintext) {
      try {
        const raw = newest.content.trim();
        const testWords = raw.split(/\s+/);
        if (testWords.length >= 12 && testWords.length <= 24 && testWords.every((w: string) => /^[a-z]+$/.test(w))) {
          plaintext = raw;
          console.debug("[chama] Seed found as plaintext mnemonic");
        }
      } catch {}
    }

    if (plaintext) {
      const words = plaintext.trim().split(/\s+/);
      if (words.length >= 12 && words.length <= 24) {
        cachedSeed = words;
        cachedForPubkey = pubkey;
        console.info("[chama] Fedimint seed recovered from Nostr relays");
        return words;
      }
    }

    } // end for-loop over candidate events

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
        "Cannot decrypt your Fedimint seed from Nostr. " +
        "Try using the same signer (NIP-07 extension) that originally created your seed. " +
        "If you've never joined a federation, click 'Reset local wallet' to start fresh."
      );
    }
  }

  // ── 2. Generate a fresh mnemonic and publish it ─────────────────────────
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

  cachedSeed = words;
  cachedForPubkey = pubkey;
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
    const existing = await client.queryOnce(
      {
        kinds: [CHAMA_SEED_KIND],
        authors: [pubkey],
        "#d": [CHAMA_SEED_D_TAG],
        limit: 4,
      },
      5_000
    );

    health.relaysReturnedSeed = existing.length;

    if (existing.length === 0) {
      // No seed event on relays at all. This is surprising — getOrCreateSeed
      // either recovered or generated one earlier this session. Could mean
      // the relays we're connected to don't have it yet, or the event was
      // pruned. Either way, if we have a cached seed, republish defensively.
      if (cachedSeed) {
        console.warn(
          "[chama] No seed event found on relays — republishing cached seed"
        );
        try {
          await republishSeed(client, signer);
          health.lastPublishedAt = Date.now();
        } catch (e) {
          console.warn("[chama] defensive seed republish failed:", e);
        }
      }
      saveSeedHealth(health);
      return health;
    }

    // Find the newest event
    const newest = existing.reduce((a, b) =>
      b.created_at > a.created_at ? b : a
    );
    health.newestEventCreatedAt = newest.created_at;

    // Staleness check: republish if the newest event is older than
    // SEED_REPUBLISH_INTERVAL_MS
    const ageMs = now - newest.created_at * 1000;
    if (ageMs > SEED_REPUBLISH_INTERVAL_MS) {
      console.info(
        `[chama] seed event is ${Math.round(ageMs / 86400000)} days old ` +
        `— republishing to keep it warm on relays`
      );
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
