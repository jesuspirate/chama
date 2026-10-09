import type { EscrowState } from '../escrow-engine/types.js';
import { needsLockPaymentDetails, type LockPaymentChoice } from '../payments/lock-payment-details.js';

export interface LockPaymentPrompt {
  state: EscrowState;
  initialId?: string;
  resolve: (choice: LockPaymentChoice | null) => void;
}

/** Ref ownership is synchronous, including two calls before React renders. */
export function requestLockPaymentDetails(
  current: { current: LockPaymentPrompt | null },
  show: (prompt: LockPaymentPrompt | null) => void,
  state: EscrowState,
  initialId?: string,
): Promise<LockPaymentChoice | null> {
  current.current?.resolve(null);
  if (!needsLockPaymentDetails(state)) {
    show(null);
    return Promise.resolve({ inChat: true });
  }
  return new Promise(resolve => {
    const prompt: LockPaymentPrompt = { state, initialId, resolve: choice => {
      if (current.current === prompt) {
        current.current = null;
        show(null);
      }
      resolve(choice);
    } };
    current.current = prompt;
    show(prompt);
  });
}
