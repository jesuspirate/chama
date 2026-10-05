// Payment IDs are counterparty routing details, not Chama/Nostr credentials.
// Reuse the phone field's manager hints; auth fields keep their own contract.
export const privatePaymentFieldProps = {
  autoComplete: "off",
  "data-bwignore": "true",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-form-type": "other",
} as const;
