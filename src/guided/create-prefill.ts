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
  /** Exchange range (Jet 2026-09-05: "no single offers ever"): with both
   *  amountSats (min) and maxAmountSats set on a p2p-trade prefill, Create
   *  seeds ONE exchange-bracket menu item [min..max] instead of a single-amount
   *  listing, so any buyer can take a slice of the range. */
  maxAmountSats?: number;
  fiatAmount?: number;
  fiatCurrency?: string;
  billType?: string;
  paymentMethods?: string[];
  /** S4.3: the premium the canvas already asked for (Exchange %, CBP bonus), in bps. */
  premiumBps?: number;
  /** S4.3: single-listing stock so a marketplace publish validates without the form. */
  stock?: number;
  /** S4.3: publish immediately by headlessly reusing this form's proven assembly,
   *  then route to the canvas status screen — the guided user never sees this form. */
  autoPublish?: boolean;
}
