# CBP private payment references

Status: parked for a protocol pass after v6.0. Do not put these values in a
public CREATE event.

## Why this deserves a first-class field

Many bills can be paid by someone other than the account holder using a short
reference:

- Kenya M-PESA Paybill commonly needs a business number plus an account,
  customer, or meter reference. Kenya Power publishes Paybill `888880` for
  prepaid purchases and asks for the meter number as the account reference.
- Tanzania's GePG uses a control number for government bills. Tanzanian water
  authorities also use control numbers; electricity may instead use a meter or
  account number.
- Uganda Revenue Authority generates a Payment Registration Number (PRN).
- Rwanda IremboGov generates an expiring Bill ID.

This is not safely modelled as one global `billNumber` string. The payer needs
to know both what kind of reference it is and, for Paybill-style routes, which
bill issuer/business number receives it.

## Privacy constraint

Today a private handle is added at LOCK and encrypted to the buyer, seller, and
arbiter. A recurring CBP owner publishes CREATE before a buyer exists, so their
bill reference cannot use that envelope at listing creation. Publishing it in
CREATE, tags, descriptions, or menu metadata would leak it to every relay
reader.

## Proposed wire shape

Add an auxiliary post-JOIN event, not a consensus-state transition:

```ts
type PrivatePaymentReference = {
  version: 1;
  escrowId: string;
  scheme: "paybill-account" | "control-number" | "meter-number" |
          "account-number" | "payment-registration-number" | "bill-id" |
          "other";
  issuer?: string;          // e.g. Kenya Power / GePG / Irembo
  businessNumber?: string;  // e.g. an M-PESA Paybill number
  reference: string;
  expiresAt?: number;
  note?: string;
};
```

The bill owner creates it only after a buyer has JOINed. Encrypt the same
validated payload independently with NIP-44 to the buyer, seller, and assigned
arbiter, as the existing private handle envelope does. Bind ciphertext to the
escrow id, sender, seated recipient keys, and newest valid buyer JOIN. A
replacement buyer must receive a new reveal; an expired buyer must not retain a
reusable listing-level secret.

## UI

- Only show the input for Community Bill Pay.
- Ask first for reference type, then issuer/business number when that scheme
  requires it, then the private reference.
- Label the disclosure explicitly: “Shared privately after someone reserves
  this bill.”
- In the trade room, show the decrypted value only to the three participants,
  with a copy button and issuer-specific payment hint.
- Never place the clear value in notifications, analytics, logs, search, trade
  cards, or the durable public listing index.

## Validation and rollout

- Per-field length caps, printable-character allowlists, and no URLs/HTML.
- Country templates are UX defaults only; the encrypted wire schema remains
  country-neutral.
- Add Kenya (`paybill-account`, `meter-number`) and Tanzania
  (`control-number`, `meter-number`) first, then Uganda PRN and Rwanda Bill ID.
- Tests must prove public events/caches contain no reference, only seated
  recipients decrypt, replacement buyers require a fresh reveal, and malformed
  or oversized envelopes are rejected.

## Primary references

- Safaricom M-PESA Paybill FAQ and business-payment guide:
  https://www.safaricom.co.ke/media-center-landing/frequently-asked-questions/m-pesa-paybill?tmpl=component
  and https://www.safaricom.co.ke/lipa-na-m-pesa/paying-to-businesses-and-online
- Kenya Power customer support: https://www.kplc.co.ke/customer-support
- Tanzania GePG bill lookup: https://epay.gepg.go.tz/
- Uganda Revenue Authority payment registration:
  https://ura.go.ug/en/domestic-taxes/make-a-payment/
- Rwanda IremboGov bill-payment guide:
  https://support.irembo.gov.rw/en/support/solutions/articles/47001146862-how-to-pay-for-a-service-on-irembogov
