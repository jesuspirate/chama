import { translate, getCurrentLang } from "../i18n/index.js";
import { walletNameParts, type PayoutDestination } from "../payments/payout-destinations.js";

/** The words a person sees for a saved wallet: the name they gave it, else a
 *  recognisable one ("Strike · bitcrazy", "Fedi wallet"), never a full LNURL. */
export function walletName(destination: Pick<PayoutDestination, "address" | "label">, lang = getCurrentLang()): string {
  if (destination.label) return destination.label;
  const parts = walletNameParts(destination.address);
  switch (parts.kind) {
    case "brand": return `${parts.brand} · ${parts.user}`;
    case "fedi": return translate(lang, "claim.fediWallet");
    case "host": return translate(lang, "claim.lightningWalletAt", { host: parts.host });
    case "plain": return parts.text;
  }
}
