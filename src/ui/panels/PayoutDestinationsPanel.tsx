import { listSavedNwcConnections, renameSavedNwcConnection, deleteSavedNwcConnection, displayNwcConnection } from "../../payments/nwc-connections.js";
import { SavedWalletRow } from "../components/SavedWalletRow.js";
import { useState } from "react";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { OverlaySheet } from "../components/OverlaySheet.js";
import {
  type PayoutDestination,
  listPayoutDestinations,
  deletePayoutDestination, renamePayoutDestination, payoutDestinationLabel, displayPayoutDestination,
} from "../../payments/payout-destinations.js";

// One management list for receive addresses and saved wallet connections.
// Connection rows show only a public identifier, never bearer credentials.
export function PayoutDestinationsPanel({ onClose }: {
  onClose: () => void;
}) {
  const { t } = useT();
  const [destinations, setDestinations] = useState<PayoutDestination[]>(
    () => listPayoutDestinations(),
  );

  const [connections, setConnections] = useState(listSavedNwcConnections);

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
      title={t("me.lightningAddresses")}
      onClose={onClose}
    >
      {destinations.length === 0 && connections.length === 0 ? (
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
          {connections.map(connection => <SavedWalletRow key={connection.id}
            label={connection.label} detail={displayNwcConnection(connection)}
            onRename={label => { renameSavedNwcConnection(connection.id, label); setConnections(listSavedNwcConnections()); }}
            onRemove={() => { deleteSavedNwcConnection(connection.id); setConnections(listSavedNwcConnections()); }} />)}
          {destinations.map(destination => <SavedWalletRow key={destination.id}
            label={payoutDestinationLabel(destination)} detail={destination.label ? destination.address : displayPayoutDestination(destination.address)}
            onRename={label => { renamePayoutDestination(destination.id, label); setDestinations(listPayoutDestinations()); }}
            onRemove={() => handleDelete(destination.id)} />)}
        </div>
      )}
    </OverlaySheet>
  );
}
