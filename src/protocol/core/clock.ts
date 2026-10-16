// ══════════════════════════════════════════════════════════════════════════
// Protocol core — the clock port
// ══════════════════════════════════════════════════════════════════════════
//
// The core never decides what time it is on its own. Every "now" default in
// the core reads this one function, so a host (a server, a test harness, a
// headless client) can supply its own clock with setProtocolClock().
//
// Replay itself never reads the clock: a trade's state is computed from the
// signed events. The clock only answers "how does this trade look right now"
// questions (deadlines, whether a vote is still allowed).

export type ProtocolClock = () => number;

const systemClock: ProtocolClock = () => Math.floor(Date.now() / 1000);
let clock: ProtocolClock = systemClock;

/** Current time in whole Unix seconds, from the installed clock. */
export function nowSeconds(): number {
  return clock();
}

/** Install a clock for the whole core. Pass nothing to restore the system clock. */
export function setProtocolClock(next?: ProtocolClock): void {
  clock = next ?? systemClock;
}
