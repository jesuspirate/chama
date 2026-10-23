import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";

/** Audit M3: a storefront order is written by the buyer. When its price,
 *  federation or arbiters aren't the listing's, the seller is told not to
 *  send anything for it (see storefrontChildMismatches). */
export function OrderMismatchBanner() {
  const { t } = useT();
  return (
    <div data-order-mismatch style={{
      background: T.amberDim, border: `1px solid ${T.amber}66`,
      borderRadius: T.r, padding: 14, marginBottom: 16,
      color: T.amber, fontFamily: T.sans, fontSize: T.fs.body, lineHeight: 1.5,
    }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>{t("trade.orderMismatchTitle")}</div>
      {t("trade.orderMismatchSellerBody")}
    </div>
  );
}
