// Small BOLT11 helpers for payout/funding routing decisions.
import { bech32 } from "@scure/base";

export function stripLightningUri(raw: string): string {
  return String(raw || "").trim().replace(/^lightning:/i, "");
}

export function isBolt11PaymentInfo(raw: string): boolean {
  return /^ln(?!url)(bc|tb|bcrt|sb|bcsim)/i.test(stripLightningUri(raw));
}

/**
 * Extract the msat amount encoded in a BOLT11 human-readable prefix.
 * Returns null for amountless invoices, non-BOLT11 input, or unsupported
 * networks.
 */
export function parseBolt11Msats(raw: string): number | null {
  const invoice = stripLightningUri(raw).toLowerCase();
  const match = /^ln(?:bc|tb|bcrt|sb|bcsim)(\d*)([munp]?)1/.exec(invoice);
  if (!match || !match[1]) return null;

  const amount = Number.parseInt(match[1], 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;

  switch (match[2]) {
    case "m": return amount * 100_000_000;
    case "u": return amount * 100_000;
    case "n": return amount * 100;
    case "p": return Math.floor(amount / 10);
    case "": return amount * 100_000_000_000;
    default: return null;
  }
}

export function hasBolt11Amount(raw: string): boolean {
  return parseBolt11Msats(raw) !== null;
}

/** Decode the signed invoice envelope enough to enforce payout amount and
 * expiry before handing an LNURL callback's invoice to a money sender. */
export function decodeBolt11Payment(raw: string): { amountMsats: number; expiresAt: number } | null {
  try {
    const invoice = stripLightningUri(raw).toLowerCase();
    const { words } = bech32.decode(invoice as `${string}1${string}`, 5000);
    const amountMsats = parseBolt11Msats(invoice);
    if (amountMsats === null || !Number.isSafeInteger(amountMsats) || words.length < 7 + 104) return null;
    let timestamp = 0;
    for (const word of words.slice(0, 7)) timestamp = timestamp * 32 + word;
    let expiry = 3600;
    const tagEnd = words.length - 104; // 65-byte compact signature
    for (let i = 7; i < tagEnd;) {
      if (i + 3 > tagEnd) return null;
      const tag = words[i++];
      const length = words[i++] * 32 + words[i++];
      if (i + length > tagEnd) return null;
      if (tag === 6) { // BOLT11 `x` expiry tag
        expiry = 0;
        for (const word of words.slice(i, i + length)) expiry = expiry * 32 + word;
      }
      i += length;
    }
    if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(expiry) || expiry <= 0) return null;
    return { amountMsats, expiresAt: timestamp + expiry };
  } catch { return null; }
}
