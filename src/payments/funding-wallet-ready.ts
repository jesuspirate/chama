/** Waiting for startup must end as soon as joining fails. Never retry a join
 * or queue a payment here; the caller still requires a ready wallet. */
export async function waitForFundingWallet(opts: {
  isReady: () => boolean;
  joinFailure: () => string | null;
  nudge: () => void;
  waitMs: number;
  pollMs: number;
}): Promise<boolean> {
  const check = () => {
    if (opts.isReady()) return true;
    const failure = opts.joinFailure();
    if (failure) throw new Error(failure);
    return false;
  };
  if (check()) return true;
  try { opts.nudge(); } catch {}
  for (let waited = 0; waited < opts.waitMs; waited += opts.pollMs) {
    await new Promise(resolve => setTimeout(resolve, opts.pollMs));
    if (check()) return true;
  }
  return check();
}
