/** Safe handoff from Assisted Chama into the existing Create wizard.
 *
 * The canvas may prefill ordinary draft fields, but it never publishes. The
 * Create wizard remains the review/consent boundary and validates everything
 * again before emitting an escrow event. */
export interface CanvasCreatePrefill {
  vertical: "p2p-trade" | "bill-pay" | "marketplace";
  /** The assisted route is publishing a sats-for-local-money offer or a bill
   *  request. Create should surface the remaining pricing judgment—the
   *  Exchange premium or Community Bill Pay volunteer bonus—instead of
   *  silently publishing the ordinary 0% fallback. */
  emphasizePremium?: boolean;
  /** The assistant deliberately did not ask a contextual payment-method
   *  question. Keep it in Create, but make the missing real-world rail
   *  unmistakable at the final editable boundary. */
  emphasizePaymentMethods?: boolean;
  description?: string;
  amountSats?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  billType?: string;
  paymentMethods?: string[];
}
