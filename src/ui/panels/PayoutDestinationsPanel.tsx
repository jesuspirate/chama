import { useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { OverlaySheet } from "../components/OverlaySheet.js";
import {
  type PayoutDestination,
  listPayoutDestinations,
  deletePayoutDestination,
} from "../../payments/payout-destinations.js";

// Local Lightning Addresses used by Claim and Recover. NWC bearer
// credentials live in Advanced > NWC wallets, keeping this screen focused
// on addresses the user can understand at a glance.
export function PayoutDestinationsPanel({ onClose }: {
  onClose: () => void;
}) {
  const { t } = useT();
  const [destinations, setDestinations] = useState<PayoutDestination[]>(
    () => listPayoutDestinations(),
  );

  const handleDelete = (id: string) => {
    deletePayoutDestination(id);
    setDestinations(listPayoutDestinations());
  };

  return (
    // Shown in front of Me, not instead of it (Jet, 2026-09-20): closing
    // lands you exactly where you were, and the × that used to throw people
    // back to the wrong tab is gone. Copy comes from i18n now — this panel
    // was hardcoded English while its translations sat unused.
    <OverlaySheet
      title={t("claim.lightningAddresses")}
      subtitle={t("claim.lightningAddressesBody")}
      onClose={onClose}
    >
      {destinations.length === 0 ? (
        <div style={{
          padding: 24, textAlign: "center", borderRadius: T.r,
          background: T.surface, border: `1px dashed ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          lineHeight: 1.5,
        }}>
          {t("claim.noLightningAddresses")}
        </div>
      ) : (
        <div>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 1, marginBottom: 8 }}>
            {t("claim.savedAddresses")}
          </div>
          {destinations.map((destination, i) => (
            <div key={destination.id} style={{
              background: T.card, border: `1px solid ${T.border}`,
              borderRadius: T.rs, padding: 12, marginBottom: 8,
              display: "flex", alignItems: "center", justifyContent: "space-between",
              gap: 12,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
                <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 14 }}>⚡</span>
                <span style={{
                  color: T.text, fontFamily: T.mono, fontSize: 12,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {destination.address}
                </span>
                {i === 0 && (
                  <span style={{
                    fontSize: 8, fontFamily: T.mono, letterSpacing: 1,
                    color: T.accent, background: T.accentDim,
                    padding: "2px 6px", borderRadius: 4, flexShrink: 0,
                  }}>DEFAULT</span>
                )}
              </div>
              <button
                onClick={() => handleDelete(destination.id)}
                style={{
                  background: "none", border: "none",
                  color: T.red, fontFamily: T.mono, fontSize: 10,
                  cursor: "pointer", padding: "0 4px", flexShrink: 0,
                }}
              >{t("me.delete")}</button>
            </div>
          ))}
        </div>
      )}
    </OverlaySheet>
  );
}
