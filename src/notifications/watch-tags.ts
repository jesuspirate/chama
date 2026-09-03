// ══════════════════════════════════════════════════════════════════════════
// A6 watch-tags — the trade-lifecycle half of VPS web push (P3)
// ══════════════════════════════════════════════════════════════════════════
//
// Brief: design/mockups/chama-a6-vps-webpush-brief.md
//
// Turns an escrow-chain publish into a wake for the sleeping counterparty, and
// (symmetrically) registers this device to be woken when THEY act. It hangs off
// exactly one seam: an injected `chainEventTagger` on the EscrowClient. When
// background push is OFF (the default), the tagger returns [] immediately, so
// the engine's signing path is byte-identical to today.
//
// ⭐ The symmetry that keeps this tiny: the watch-tag for a pair is
//   deriveWatchTag(conversationKey(me, them), escrowId) — and conversationKey is
//   ECDH, so THEY compute the exact same value. One tag per pair per trade.
//   That single value is BOTH what I attach (to wake them) AND what I register
//   (to be woken by them). So the tagger can register as a side-effect and we
//   need no separate participant enumeration off EscrowState.

import { deriveWatchTag, deriveCommunityWakeTag, registerWatchTags, ensureWebPushSubscription, disableWebPush } from "./web-push-client.js";
import { TAGS } from "../escrow-engine/types.js";
import type { Signer, UnsignedEvent } from "../escrow-engine/escrow-client.js";

// Device-scoped opt-in. Default OFF: nothing about the trade path changes until
// the user turns background push on (the P4 toggle calls enableBackgroundPush).
const BG_PUSH_KEY = "chama_bg_push_enabled";

export function backgroundPushEnabled(): boolean {
  try { return localStorage.getItem(BG_PUSH_KEY) === "1"; } catch { return false; }
}

function setEnabledFlag(on: boolean): void {
  try { if (on) localStorage.setItem(BG_PUSH_KEY, "1"); else localStorage.removeItem(BG_PUSH_KEY); }
  catch { /* private-mode etc.; the tagger simply stays a no-op */ }
}

/** Turn background push on: flip the flag and warm the push subscription so the
 *  first registration has an endpoint. Returns false when the platform can't
 *  deliver (unsupported, denied, iOS Safari tab, or no VAPID key deployed yet). */
export async function enableBackgroundPush(): Promise<boolean> {
  setEnabledFlag(true);
  const sub = await ensureWebPushSubscription();
  if (!sub) { setEnabledFlag(false); return false; }
  return true;
}

/** Turn it off: drop the flag and tear down the subscription. */
export async function disableBackgroundPush(): Promise<void> {
  setEnabledFlag(false);
  await disableWebPush();
}

/**
 * Build the EscrowClient `chainEventTagger`. Bound to the session's signer.
 * On each escrow-chain event this device publishes, it derives the opaque
 * wake-tag for every OTHER participant named on the event, registers those
 * tags for this device (so their later actions wake us), and returns them to
 * be appended as `["w", tag]` (so this action wakes them). All best-effort.
 */
export function makeChainEventTagger(signer: Signer): (unsigned: UnsignedEvent) => Promise<string[][]> {
  return async (unsigned: UnsignedEvent): Promise<string[][]> => {
    if (!backgroundPushEnabled()) return [];
    const conv = signer.conversationKey;
    if (!conv) return []; // remote signer (bunker/extension): no local ECDH → skip

    const escrowId = unsigned.tags.find(t => t[0] === TAGS.ESCROW_ID)?.[1];
    if (!escrowId) return [];

    let me: string;
    try { me = await signer.getPublicKey(); } catch { return []; }

    const others = [...new Set(
      unsigned.tags.filter(t => t[0] === TAGS.PARTICIPANT && t[1] && t[1] !== me).map(t => t[1]),
    )];
    if (others.length === 0) return []; // e.g. CREATE before anyone joined

    const wTags: string[][] = [];
    const toRegister: string[] = [];
    for (const peer of others) {
      try {
        const key = await conv.call(signer, peer);
        const tag = await deriveWatchTag(key, escrowId, 0); // epoch 0; ratchet is a hardening follow-up (brief §6.1)
        wTags.push(["w", tag]);
        toRegister.push(tag);
      } catch { /* skip this peer; a derivation miss must not block the publish */ }
    }
    // Symmetric: register the same tags for THIS device so the peer's future
    // actions wake us. Fire-and-forget; a down watcher just means no wake.
    if (toRegister.length) void registerWatchTags(toRegister);
    return wTags;
  };
}

/** S4.2 — register interest in NEW listings for a community, so the watcher can
 *  wake this device (closed-app) when one appears. Best-effort; subscribes and
 *  prompts permission as needed. In-app alerts work regardless via the live feed. */
export async function registerCommunityWake(slug: string): Promise<void> {
  const s = slug?.trim();
  if (!s) return;
  try { await registerWatchTags([await deriveCommunityWakeTag(s)]); }
  catch { /* best-effort */ }
}
