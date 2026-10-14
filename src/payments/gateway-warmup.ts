// Lock invoice, Step 1 (Jet, 6.4.25): warm the Lightning path before the
// press. Opening the funding sheet first asks the wallet how many Lightning
// gateways it can use (browser: refresh the gateway cache; Android: the
// bridge's /gateways), and the sheet waits for that answer — up to 8 s —
// before it asks for the invoice. When the trade screen offers Lock, the app
// asks the same question in the background and the sheet reuses the answer.
//
// Read-only: no invoice is created, nothing is payable, no sats move. Only a
// positive count is kept, for a short while and for one federation; zero,
// unknown and failures are always asked again when the sheet opens.

export const GATEWAY_COUNT_FRESH_MS = 2 * 60_000;

type Fetch = () => Promise<number | null>;

let kept: { federationId: string; count: number; at: number } | null = null;
let asking: { federationId: string; answer: Promise<number | null> } | null = null;

const clock = () => Date.now();

function ask(federationId: string, fetch: Fetch): Promise<number | null> {
  if (asking?.federationId === federationId) return asking.answer;
  const answer = fetch().catch(() => null).then(count => {
    if (typeof count === "number" && count > 0) kept = { federationId, count, at: clock() };
    return count;
  }).finally(() => { if (asking?.answer === answer) asking = null; });
  asking = { federationId, answer };
  return answer;
}

/** A positive gateway count for this federation from the last two minutes. */
export function warmGatewayCount(federationId: string | null): number | null {
  if (!federationId || !kept || kept.federationId !== federationId) return null;
  return clock() - kept.at < GATEWAY_COUNT_FRESH_MS ? kept.count : null;
}

/** Start the check in the background (the trade screen offers Lock). */
export function warmGateways(federationId: string | null, fetch: Fetch): void {
  if (!federationId || warmGatewayCount(federationId) !== null) return;
  void ask(federationId, fetch);
}

/** The sheet's check: a warm answer at once, a check already under way, or
 *  a fresh one. */
export function gatewayCount(federationId: string | null, fetch: Fetch): Promise<number | null> {
  if (!federationId) return fetch();
  const warm = warmGatewayCount(federationId);
  if (warm !== null) return Promise.resolve(warm);
  return ask(federationId, fetch);
}

/** Tests only. */
export function resetGatewayWarmup(): void {
  kept = null; asking = null;
}
