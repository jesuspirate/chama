// Chama — default Nostr relay pool
//
// The launch-grade answer — own the reliability instead of renting it — is
// CHAMA_RELAY: Chama's own always-up relay that every client publishes to AND
// fetches from, so votes + chat land and rehydrate instantly (it fixes the
// "vote2 didn't arrive" glitch structurally, not by luck of public-relay uptime).
// It is listed FIRST and kept ALONGSIDE a small public pool for redundancy — one
// relay is a single point of failure, so the publics are the fallback.
//
// Keep the public list biased toward relays that behave well in browser smoke
// tests: a wall of red connection states erodes trust. offchain.pub + snort.social
// were pruned 2026-07-01 (chronically down/flaky, and unnecessary once the Chama
// relay became the reliable anchor); confirm/swap the rest against smoke-test
// behavior over time.
//
// The fetch quorum adapts to this list's length (relay-manager.ts effectiveQuorum:
// min(3, relayCount-1)), so growing/shrinking this list is safe.
//
// (A DEV-only ws://localhost relay gate lived here while the Chama relay was being
// built; removed once relay.chama.community went live. Re-add a dev-gated local
// relay only if you ever want fully-offline 3-instance testing.)

// Chama's own production relay (khatru). Writes restricted
// to Chama's event kinds, reads open; stores every event and never collapses chat
// (escrow/chat live in the addressable 38xxx range).
export const CHAMA_RELAY = "wss://relay.chama.community";

const PUBLIC_RELAYS: string[] = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://nostr.mom",
  "wss://nostr.land",
];

// Offline profiling harness only: a build-time relay override lets the
// production bundle run against a deterministic local relay. Normal builds do
// not define it and remain byte-for-byte on the production pool below.
const PROFILE_RELAY = (import.meta as any).env?.VITE_CHAMA_PROFILE_RELAY?.trim?.();

// Chama relay first (the reliable anchor); public pool as fallback / redundancy.
export const DEFAULT_RELAYS: string[] = PROFILE_RELAY
  ? PROFILE_RELAY.split(",").map((url: string) => url.trim()).filter(Boolean)
  : [CHAMA_RELAY, ...PUBLIC_RELAYS];
