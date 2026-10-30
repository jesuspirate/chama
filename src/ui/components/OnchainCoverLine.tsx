import { ONCHAIN_ESCROW_MINIMUM_SATS } from "../../bond-multisig/onchain-escrow.js";
import { useT } from "../../i18n/index.js";
import { onchainCoverShort, type OnchainCover } from "../onchain-cover.js";
import { T } from "../theme.js";

/** One line under the rail choice: how large an on-chain trade this chama's
 *  arbiters can cover today, shown only when the amount is above it. Silent
 *  while loading or when it fits, so it never shows a number it has not read. */
export function OnchainCoverLine({ cover, coverageSats }: { cover: OnchainCover; coverageSats: number }) {
  const { t } = useT();
  if (cover.status === "unchecked") {
    return <div data-onchain-cover-unchecked style={{ fontSize: 12, color: T.muted, marginTop: 8, lineHeight: 1.45 }}>{t("onchain.coverUnchecked")}</div>;
  }
  if (cover.status !== "ready" || !onchainCoverShort(coverageSats, cover)) return null;
  const text = cover.sats < Number(ONCHAIN_ESCROW_MINIMUM_SATS)
    ? t("onchain.coverNone")
    : t("onchain.coverLimit", { amount: cover.sats.toLocaleString() });
  const own = cover.ownBond ? ` ${t("onchain.coverOwnBond")}` : "";
  return <div role="status" data-onchain-cover-limit style={{ fontSize: 12.5, color: T.amber, marginTop: 8, lineHeight: 1.45, fontWeight: 700 }}>{text}{own}</div>;
}
