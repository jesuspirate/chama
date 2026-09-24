import { EscrowStatus, type EscrowState } from '../escrow-engine/types.js';
import { canLockFromBalance } from '../ui/decisions.js';
import { errorText } from './error-text.js';
import type { FundAndLockPhase, FundAndLockTerminal } from './fund-and-lock.js';

/** No receive invoice or receive journal: the existing lock owns spend recovery. */
export async function lockFromBalance(opts: {
  amountMsats: number;
  premiumMsats?: number;
  readSpendable: () => Promise<number>;
  getTrade: () => EscrowState | null | undefined;
  actualAmount: (trade: EscrowState) => number;
  lock: () => Promise<EscrowState | null | undefined>;
  signal?: AbortSignal;
  onPhase: (phase: FundAndLockPhase) => void;
}): Promise<FundAndLockTerminal> {
  try {
    const spendable = await opts.readSpendable();
    if (opts.signal?.aborted) return { kind: 'aborted' };
    const trade = opts.getTrade();
    if (!trade || opts.actualAmount(trade) !== opts.amountMsats || !canLockFromBalance(trade, spendable, opts.amountMsats, opts.premiumMsats)) {
      throw new Error('This trade cannot use your balance right now. Nothing was taken.');
    }
    opts.onPhase({ kind: 'locking' });
    const locked = await opts.lock();
    if (!locked?.lock?.notesHash || locked.status === EscrowStatus.CREATED) {
      throw new Error('This trade could no longer be locked — your sats stay in your wallet.');
    }
    opts.onPhase({ kind: 'locked' });
    return { kind: 'locked' };
  } catch (error) {
    const terminal = { kind: 'lock-failed' as const, error: errorText(error) };
    opts.onPhase(terminal);
    return terminal;
  }
}
