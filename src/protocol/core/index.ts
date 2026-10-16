// ══════════════════════════════════════════════════════════════════════════
// Chama protocol core — public entry
// ══════════════════════════════════════════════════════════════════════════
//
// Signed events in, trade state out. Nothing reachable from this file may
// touch device storage, the network, the UI or the system clock; the
// boundary check (npm run protocol:boundary -- --strict, part of npm test)
// enforces that. Platform concerns enter only through ports: the clock
// (setProtocolClock) and the chain-data fetcher passed to chain reads.
//
// The reducer and parser still live under src/escrow-engine/ for now; moving
// the files here is a later, purely mechanical step. Import from this entry
// rather than from those paths in new code.

export * from "../../escrow-engine/types.js";
export * from "../../escrow-engine/event-parser.js";
export * from "../../escrow-engine/state-machine.js";
export * from "./clock.js";
export * from "./sim-tag.js";
export * from "./listing-image-ref.js";
export * from "./arbiter-pick.js";
export * from "./bond-announcement.js";
export * from "./commitment-record.js";
export * from "./chain-data.js";
