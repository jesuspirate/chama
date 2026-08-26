import { useState, useEffect, useRef, type ReactNode } from "react";
import { type FedimintState } from "../../hooks/useEscrow.js";
import { T, inputStyle } from "../theme.js";
import { CopyButton } from "../components/CopyButton.js";
import { BitcoinAmount } from "../components/BitcoinAmount.js";
import { isPowerUserModeOn, setPowerUserMode } from "../powerUserMode.js";
import { SwitchFederationPanel } from "../panels/SwitchFederationPanel.js";
import { isSimModeOn } from "../../sim/simMode.js";
import { getCommunityBySlug } from "../../communities/registry.js";
import { resolveRosterAuthority } from "../../arbiters/roster.js";
import { normalizeTrustedArbiterInput, readVerifiedRosterPool } from "../../arbiters/pool.js";
import { isNwcConnectionString } from "../../payments/nwc.js";
import {
  addOrTouchSavedNwcConnection,
  deleteSavedNwcConnection,
  listSavedNwcConnections,
  type SavedNwcConnection,
} from "../../payments/nwc-connections.js";
import {
  lightningPayoutReserveSats,
  maxLightningPayoutSats,
} from "../../payments/lightning-fees.js";
import { getCachedSeedWords } from "../../fedimint/seed-manager.js";
import {
  getLastDiscoveryRun,
  subscribeDiscoveryRun,
  getLastHydrateRun,
  subscribeHydrateRun,
  type DiscoveryRunDiag,
  type FetchLegDiag,
  type ResolvedBy,
  type HydrateRunDiag,
  type HydrateIdDiag,
} from "../../escrow-engine/discovery-diagnostics.js";
import { getPinnedIdentity } from "../../storage/identity-pin.js";
import { QRCode } from "../QRCode.js";
import { Preferences } from "@capacitor/preferences";
import { isTauriRuntime } from "../sign-in-environment.js";
import {
  NATIVE_BRIDGE_TOKEN_KEY,
  NATIVE_BRIDGE_URL_KEY,
  clearNativeBridgeConfig,
  setNativeBridgeConfig,
} from "../../fedimint/native-bridge-adapter.js";

// Settings → Advanced — the home of Power-user mode (formerly
// "Sandbox mode" through v0.4.1) and the federation-switching tools
// that previously lived on the home screen. Per the v0.2.0 brief,
// these surfaces are too dangerous for normie users to encounter
// incidentally. v0.1.85 relocates them here.
//
// First-time onboarding happens via community pill taps in BrowseView
// (one-tap join). Power-user mode is the only on-shell home for picking
// a non-community-mapped federation or pasting a custom invite — and the
// shell's onSwitchFederation handler dispatches init-vs-switch so this
// works for both first-time-join and federation-switch flows.
export function SettingsAdvanced({
  fedimint,
  loadActiveRecoveryKey,
  onBack,
  onSwitchFederation,
  onResetLocalWallet,
  onSandboxFund,
  focusNwc = false,
  communitySlug,
  userPubkey,
  onPublishRoster,
  onFetchApplications,
  onRunDiscovery,
  onProbeFetchById,
}: {
  fedimint: FedimintState;
  /** Explicit, user-triggered export for an in-memory local signer. Remote
   * signers return null and never expose key material to Chama. */
  loadActiveRecoveryKey?: () => Promise<string | null>;
  onBack: () => void;
  onSwitchFederation: (inviteCode: string, opts?: { force?: boolean }) => Promise<void>;
  onResetLocalWallet: () => Promise<void>;
  /** INSTRUMENT-FIRST (Fedi round 3): re-run My Trades discovery (the same
   *  path Refresh uses) so the debug card can read the last fetch's anatomy. */
  onRunDiscovery?: () => Promise<number>;
  /** INSTRUMENT-FIRST (Fedi round 3): pubkey-independent `#d` transport
   *  control — fetch one known escrow id and return its per-relay probe. */
  onProbeFetchById?: (escrowId: string) => Promise<FetchLegDiag>;
  /** V3 roster keystone: the active community + the signed-roster publish
   *  path. The steward card renders only when userPubkey is in the
   *  community's roster authority (registry pin or shell creator). */
  communitySlug?: string | null;
  userPubkey?: string | null;
  onPublishRoster?: (community: string, arbiters: string[]) => Promise<void>;
  /** V3 #74: steward review — fetch the community's signed applications. */
  onFetchApplications?: (
    community: string,
    excludePubkeys?: string[],
  ) => Promise<{ applicant: string; statement: string; createdAt: number }[]>;
  /** When true (arrived via the "Change" link on the trade-page NWC banner),
   *  open expanded on the NWC wallets section and scroll it into view. */
  focusNwc?: boolean;
  /** v0.3.0 Phase 5: opens FundWalletModal — the only remaining
   *  callsite of that surface in production. Reachable only when
   *  Power-user mode is on. The label on the button below carries the
   *  warning in plain English; do not surface this from any other
   *  production path. */
  onSandboxFund?: () => void;
}) {
  const [powerUserOn, setPowerUserOn] = useState(isPowerUserModeOn);
  // v2.5: inline reset error (window.alert is a no-op in the webview).
  const [resetError, setResetError] = useState<string | null>(null);
  // Toggle the flag — dev builds remain auto-on regardless
  useEffect(() => { setPowerUserMode(powerUserOn); }, [powerUserOn]);

  const isDev = (() => {
    try { return !!(import.meta as any).env?.DEV; } catch { return false; }
  })();

  // v0.4.2: sim mode is the only way for prod testers to fund a fresh
  // wallet (atomic funding is buyer-side and assumes a counterparty).
  // Expose the manual-fund affordance whenever sim mode is on, even if
  // the user hasn't separately enabled power-user mode. The federation
  // switcher and OPFS reset stay behind power-user — those are
  // dangerous in real life and pointless in sim.
  const simOn = isSimModeOn();
  const balanceMsats = Math.max(0, Math.floor(fedimint.balanceMsats ?? 0));
  const wholeSats = Math.floor(balanceMsats / 1000);
  const recoverableSats = maxLightningPayoutSats(balanceMsats);
  const reserveSats = lightningPayoutReserveSats(balanceMsats);
  const routeLabel = fedimint.federationName || (fedimint.joined ? "Joined route" : "No Chama");
  const [nwcManagerOpen, setNwcManagerOpen] = useState(focusNwc);
  const [savedNwcConnections, setSavedNwcConnections] = useState<SavedNwcConnection[]>(
    () => listSavedNwcConnections(),
  );
  const [nwcInput, setNwcInput] = useState("");
  const [nwcError, setNwcError] = useState<string | null>(null);
  const nwcInputReady = isNwcConnectionString(nwcInput);

  // Arrived from the trade-page NWC "Change" link → land on the NWC wallets
  // section: expand it and scroll it into view once layout settles.
  const nwcSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusNwc) return;
    setNwcManagerOpen(true);
    const t = setTimeout(() => {
      nwcSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
    return () => clearTimeout(t);
  }, [focusNwc]);

  const refreshNwcConnections = () => setSavedNwcConnections(listSavedNwcConnections());
  const handleSaveNwc = () => {
    setNwcError(null);
    try {
      addOrTouchSavedNwcConnection(nwcInput);
      setNwcInput("");
      refreshNwcConnections();
    } catch (e: any) {
      setNwcError(e?.message || "NWC connection could not be saved");
    }
  };
  const handleDeleteNwc = (id: string) => {
    deleteSavedNwcConnection(id);
    refreshNwcConnections();
  };

  return (
    <div style={{ padding: 16, maxWidth: 560, margin: "0 auto" }}>
      <div style={{
        display: "flex", justifyContent: "space-between",
        alignItems: "center", marginBottom: 20,
      }}>
        <button onClick={onBack} style={{
          background: "none", border: "none", color: T.muted,
          fontFamily: T.mono, fontSize: 12, cursor: "pointer", padding: 0,
        }}>
          ← Back
        </button>
        <span style={{ fontSize: 18, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
          Advanced
        </span>
        <span style={{ width: 50 }} />
      </div>

      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div style={{
          fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
          letterSpacing: 1, marginBottom: 10,
        }}>
          LOCAL WALLET BALANCE
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 8,
          marginBottom: 12,
        }}>
          <BalanceMetric label="Raw" value={balanceMsats.toLocaleString()} suffix="msats" />
          <BalanceMetric label="Whole" value={<BitcoinAmount sats={wholeSats} size={13} gap={3} glyphScale={1.18} color={T.text} glyphColor={T.muted} />} />
          <BalanceMetric label="Recoverable" value={<BitcoinAmount sats={recoverableSats} size={13} gap={3} glyphScale={1.18} color={recoverableSats > 0 ? T.amber : T.muted} glyphColor={recoverableSats > 0 ? T.amber : T.muted} />} tone={recoverableSats > 0 ? T.amber : T.muted} />
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.6 }}>
          Route: <span style={{ color: T.text }}>{routeLabel}</span>
          {" · "}
          Status: <span style={{ color: fedimint.joined ? T.green : fedimint.busy ? T.amber : T.muted }}>
            {fedimint.joined ? "joined" : fedimint.busy ? "connecting" : "not joined"}
          </span>
          {" · "}
          Lightning reserve: <span style={{ color: reserveSats > 0 ? T.amber : T.muted }}>
            <BitcoinAmount sats={reserveSats} size={10} gap={3} glyphScale={1.18} color={reserveSats > 0 ? T.amber : T.muted} glyphColor={reserveSats > 0 ? T.amber : T.muted} />
          </span>
        </div>
        {fedimint.federationId && (
          <div style={{
            fontSize: 9, color: T.muted, fontFamily: T.mono,
            marginTop: 8, wordBreak: "break-all",
          }}>
            fed {fedimint.federationId}
          </div>
        )}
      </div>

      <div ref={nwcSectionRef} style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div
          onClick={() => setNwcManagerOpen(!nwcManagerOpen)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: "pointer", gap: 12,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
              NWC wallets
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
              Advanced wallet links for fast payouts and auto-funding.
            </div>
          </div>
          <div style={{
            color: T.muted, fontFamily: T.mono, fontSize: 12,
            transform: nwcManagerOpen ? "rotate(90deg)" : "rotate(0)",
            transition: "transform 0.16s ease",
          }}>
            ▸
          </div>
        </div>

        {nwcManagerOpen && (
          <NwcManager
            saved={savedNwcConnections}
            input={nwcInput}
            error={nwcError}
            inputReady={nwcInputReady}
            onInput={setNwcInput}
            onSave={handleSaveNwc}
            onDelete={handleDeleteNwc}
          />
        )}
      </div>

      {/* Remote-bridge "friend wallet": point this browser at a Rust bridge
          running on a trusted person's server. Every money leg then runs in
          the Rust lane (identical to Tauri) — the browser is pure UI.

          Soft-shutdown (2026-08-24): friend links are retired, so this manual
          config form is now power-user gated — the same home as its sibling
          route-switching / external-invite-paste surfaces below. The card, its
          i18n, and native-bridge-adapter.ts are untouched; a power user (or a
          dev build, isDev) still gets the form for manual bridge testing. */}
      {(powerUserOn || isDev) && (
        <RemoteBridgeCard />
      )}

      {/* v2.4 — Recovery phrase. Visible to ALL users (not power-user gated):
          backing up your own funds is a right, not an advanced toggle. Chama
          is not a wallet — these 12 words are the private key to the ecash. */}
      <RecoveryPhraseCard />

      <StewardRosterCard
        communitySlug={communitySlug ?? null}
        userPubkey={userPubkey ?? null}
        onPublishRoster={onPublishRoster}
        onFetchApplications={onFetchApplications}
      />

      {/* v2.5 — Account key (nsec). Explicitly requested from the active local
          signer, or loaded from secure storage for older generated accounts.
          Extension and NIP-46 keys never touch Chama and cannot be revealed. */}
      <NsecRevealCard loadActiveRecoveryKey={loadActiveRecoveryKey} />

      {/* Power-user toggle */}
      <div style={{
        background: T.card, border: `1px solid ${T.border}`,
        borderRadius: T.r, padding: 16, marginBottom: 16,
      }}>
        <div
          onClick={() => !isDev && setPowerUserOn(!powerUserOn)}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            cursor: isDev ? "default" : "pointer",
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
              Power-user mode
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
              Reveals power-user surfaces: route switching, external invite
              paste, OPFS reset. Off by default.
              {isDev && (
                <span style={{ color: T.amber, display: "block", marginTop: 4 }}>
                  Auto-on in dev builds.
                </span>
              )}
            </div>
          </div>
          <div style={{
            width: 40, height: 22, borderRadius: 11,
            background: (powerUserOn || isDev) ? T.accent : T.border,
            padding: 2, transition: "background 0.2s",
            opacity: isDev ? 0.7 : 1,
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: "50%",
              background: T.bg, transition: "transform 0.2s",
              transform: (powerUserOn || isDev) ? "translateX(18px)" : "translateX(0)",
            }} />
          </div>
        </div>
      </div>

      {(powerUserOn || isDev) && (
        <>
          {/* Route switching */}
          <div style={{
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: T.r, padding: 16, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              ROUTE
            </div>
            {/* v2.3.1: disambiguate from Me › Your Chama. That surface switches
                your COMMUNITY (registry-listed, friendly, sets your home). This
                one switches the raw FEDERATION — for custom or non-listed feds
                you paste yourself. Two layers, kept on purpose. */}
            <div style={{
              fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5,
              marginBottom: 10,
            }}>
              For a custom or non-listed federation. To change your community
              Chama, use Your Chama on the Me screen.
            </div>
            {/* SwitchFederationPanel renders for both joined and pre-join
                states — the shell's onSwitchFederation handler dispatches
                init-vs-switch based on whether a fed is loaded. v0.1.85:
                this is the only first-time-join surface for power users
                (the on-shell picker has been retired). */}
            <SwitchFederationPanel
              fedimint={fedimint}
              onSwitch={onSwitchFederation}
            />
          </div>

          {/* Reset local Chama */}
          <div style={{
            background: T.card, border: `1px solid ${T.border}`,
            borderRadius: T.r, padding: 16, marginBottom: 16,
          }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
              letterSpacing: 1, marginBottom: 8,
            }}>
              RESET LOCAL CHAMA
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
              Wipes the OPFS-bound Fedimint client. Your Nostr-backed seed and
              trade history survive. The v0.1.76 fund-loss guard refuses if a
              balance is present — withdraw via Lightning first.
            </div>
            <button
              onClick={() => {
                setResetError(null);
                onResetLocalWallet().catch((e: any) => setResetError(e?.message || "Reset failed"));
              }}
              style={{
                background: "none",
                border: `1px solid ${T.border}`,
                color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                padding: "8px 12px", borderRadius: T.rs,
                cursor: "pointer", letterSpacing: 0.5,
              }}
            >
              ↺ Reset local Chama
            </button>
            {resetError && (
              <div style={{
                marginTop: 10, padding: "9px 11px", borderRadius: T.rs,
                background: T.redDim, border: `1px solid ${T.red}55`,
                color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5,
                wordBreak: "break-word" as const,
              }}>
                ⚠ {resetError}
              </div>
            )}
          </div>
        </>
      )}

      {/* v0.3.0 Phase 5 / v0.4.2 sim mode: Manual fund — the only
          remaining entry point to FundWalletModal in production. Gated
          behind Power-user mode OR Sim mode. The label IS the warning
          (per Phase 5 reminder #2): users see "Production trades use
          atomic funding via listing-tap" and understand at a glance
          that this is a testing surface, not the normal funding path.
          In sim mode this is the natural starter step: fund the sim
          wallet from 0, then trade. */}
      {onSandboxFund && (powerUserOn || isDev || simOn) && (
        <div style={{
          background: T.card, border: `1px solid ${simOn ? T.red : T.border}`,
          borderRadius: T.r, padding: 16, marginBottom: 16,
        }}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
            letterSpacing: 1, marginBottom: 8,
          }}>
            {simOn ? "FUND SIM WALLET" : "MANUAL FUND (POWER USER)"}
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
            {simOn
              ? "Generate a sim Lightning invoice. It auto-settles after a few seconds — no real wallet needed."
              : "Generate an arbitrary-amount Lightning invoice for testing. Production trades use atomic funding via listing-tap."}
          </div>
          <button
            onClick={onSandboxFund}
            style={{
              background: "none",
              border: `1px solid ${T.border}`,
              color: T.muted,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700,
              padding: "8px 12px", borderRadius: T.rs,
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >
            ⚡ Open manual fund
          </button>
        </div>
      )}

      {/* Arbiter-substitution live testing: per-device override of the CREATE
          expiry. Consensus-safe — the value is committed wire data in the
          CREATE event, so every client derives the same expiry and the same
          backup-arbiter floor (min(4h, half remaining life)). Only the
          CREATING device needs it set. Power-user gated like manual fund. */}
      {(powerUserOn || isDev || simOn) && (
        <TestExpiryOverrideCard />
      )}

      {(powerUserOn || isDev || simOn) && (
        <TestSubstitutionGraceCard />
      )}

      {(powerUserOn || isDev) && (
        <FediWeblnProbeCard />
      )}

      {(powerUserOn || isDev) && (
        <DiscoveryDiagnosticCard
          queriedPubkey={userPubkey ?? null}
          onRunDiscovery={onRunDiscovery}
          onProbeFetchById={onProbeFetchById}
        />
      )}

      {!(powerUserOn || isDev) && (
        <div style={{
          padding: 24, textAlign: "center" as const,
          background: T.surface, border: `1px dashed ${T.border}`,
          borderRadius: T.r, color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.7,
        }}>
          Power-user surfaces are hidden in production. Flip Power-user
          mode above to reveal them.
        </div>
      )}
    </div>
  );
}

function BalanceMetric({
  label,
  value,
  suffix,
  tone = T.text,
}: {
  label: string;
  value: ReactNode;
  suffix?: string;
  tone?: string;
}) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.rs,
      padding: "10px 8px",
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 9,
        color: T.muted,
        fontFamily: T.mono,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 5,
      }}>
        {label}
      </div>
      <div style={{
        fontSize: 13,
        color: tone,
        fontFamily: T.mono,
        fontWeight: 800,
        lineHeight: 1.2,
        wordBreak: "break-word",
      }}>
        {value}
      </div>
      {suffix && (
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 3 }}>
          {suffix}
        </div>
      )}
    </div>
  );
}

function NwcManager({
  saved,
  input,
  error,
  inputReady,
  onInput,
  onSave,
  onDelete,
}: {
  saved: SavedNwcConnection[];
  input: string;
  error: string | null;
  inputReady: boolean;
  onInput: (value: string) => void;
  onSave: () => void;
  onDelete: (id: string) => void;
}) {
  return (
    <div style={{
      marginTop: 14,
      paddingTop: 14,
      borderTop: `1px solid ${T.border}`,
    }}>
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 8,
        marginBottom: 12,
      }}>
        <NwcPermissionCard
          title="Payouts"
          value="Create invoices"
          hint="Needed for Claim and Recover to send sats to this wallet."
        />
        <NwcPermissionCard
          title="Auto-fund"
          value="Send payments"
          hint="Needed only when you want Chama to lock trades from this wallet."
        />
      </div>

      <div style={{
        padding: "10px 12px",
        background: T.surface,
        border: `1px solid ${T.border}`,
        borderRadius: T.rs,
        marginBottom: 12,
      }}>
        <div style={{
          fontSize: 10,
          color: T.text,
          fontFamily: T.mono,
          fontWeight: 800,
          letterSpacing: 0.4,
          marginBottom: 6,
        }}>
          SETUP
        </div>
        <ol style={{
          margin: 0,
          paddingLeft: 18,
          color: T.muted,
          fontFamily: T.mono,
          fontSize: 10,
          lineHeight: 1.65,
        }}>
          <li>Name it Chama.</li>
          <li>Use Custom permissions.</li>
          <li>Enable Create invoices.</li>
          <li>Enable Send payments for auto-funding.</li>
          <li>Set a budget at least as large as your expected trades.</li>
          <li>Use an expiration you are comfortable revoking later.</li>
        </ol>
      </div>

      {saved.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{
            fontSize: 9,
            color: T.muted,
            fontFamily: T.mono,
            letterSpacing: 1,
            marginBottom: 6,
          }}>
            SAVED
          </div>
          {saved.map((connection) => (
            <div
              key={connection.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                padding: "10px 12px",
                background: T.surface,
                border: `1px solid ${T.border}`,
                borderRadius: T.rs,
                marginBottom: 6,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{
                  color: T.text,
                  fontFamily: T.mono,
                  fontSize: 11,
                  fontWeight: 800,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}>
                  {connection.label}
                </div>
                <div style={{
                  color: T.muted,
                  fontFamily: T.mono,
                  fontSize: 9,
                  marginTop: 3,
                }}>
                  {connection.relayCount} relay{connection.relayCount === 1 ? "" : "s"} · {connection.walletPubkey.slice(0, 8)}
                </div>
              </div>
              <button
                onClick={() => onDelete(connection.id)}
                style={{
                  background: "none",
                  border: "none",
                  color: T.red,
                  fontFamily: T.mono,
                  fontSize: 10,
                  cursor: "pointer",
                  padding: "4px 0",
                  flexShrink: 0,
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{
        fontSize: 9,
        color: T.muted,
        fontFamily: T.mono,
        letterSpacing: 1,
        marginBottom: 6,
      }}>
        PASTE CONNECTION
      </div>
      <textarea
        value={input}
        onChange={(e) => onInput(e.target.value)}
        placeholder="nostr+walletconnect://..."
        rows={3}
        style={{ ...inputStyle, resize: "vertical" as const, minHeight: 62, marginBottom: 8 }}
      />
      {error && (
        <div style={{
          padding: "8px 10px",
          background: T.redDim,
          border: `1px solid ${T.red}44`,
          color: T.red,
          borderRadius: T.rs,
          fontFamily: T.mono,
          fontSize: 10,
          marginBottom: 8,
        }}>
          {error}
        </div>
      )}
      <button
        onClick={onSave}
        disabled={!inputReady}
        style={{
          width: "100%",
          padding: "11px 12px",
          borderRadius: T.rs,
          background: inputReady ? T.accent : T.surface,
          border: `1px solid ${inputReady ? T.accent : T.border}`,
          color: inputReady ? "#000" : T.muted,
          fontFamily: T.mono,
          fontSize: 11,
          fontWeight: 800,
          cursor: inputReady ? "pointer" : "not-allowed",
        }}
      >
        Save NWC wallet
      </button>
    </div>
  );
}

function NwcPermissionCard({
  title,
  value,
  hint,
}: {
  title: string;
  value: string;
  hint: string;
}) {
  return (
    <div style={{
      background: T.surface,
      border: `1px solid ${T.border}`,
      borderRadius: T.rs,
      padding: 10,
      minWidth: 0,
    }}>
      <div style={{
        fontSize: 9,
        color: T.muted,
        fontFamily: T.mono,
        textTransform: "uppercase",
        letterSpacing: 0.8,
        marginBottom: 5,
      }}>
        {title}
      </div>
      <div style={{
        fontSize: 12,
        color: T.accent,
        fontFamily: T.mono,
        fontWeight: 900,
        lineHeight: 1.25,
        marginBottom: 5,
      }}>
        {value}
      </div>
      <div style={{
        color: T.muted,
        fontFamily: T.mono,
        fontSize: 9,
        lineHeight: 1.45,
      }}>
        {hint}
      </div>
    </div>
  );
}

// ── Recovery phrase (v2.4) ───────────────────────────────────────────────
// Chama is not a wallet — it puts the user in total control. The 12-word
// BIP-39 mnemonic is the private key to the ecash that passed through their
// account; it lives NIP-44-encrypted on Nostr, but the user has every right to
// hold it offline too (paper backup) so they can restore on any Fedimint
// wallet even if they lose this device or their Nostr account. Hidden by
// default behind a deliberate reveal; the words never leave the device unless
// the user copies/QRs them on purpose.
// Remote-bridge "friend wallet" config (2026-07-14 brief): URL + bearer token
// for a Rust bridge hosted by someone the user personally trusts. Deliberate
// choices: the token is paste-only (never a URL query param — those land in
// history/server logs; invite links use the self-stripping #fragment instead),
// and Save/Disconnect reload the app because the wallet adapter binds its
// bridge URL at init. Plain-English like the rest of this screen (i18n for
// SettingsAdvanced is a tracked deferral).
function RemoteBridgeCard() {
  const [open, setOpen] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const configuredUrl = (() => {
    try { return localStorage.getItem(NATIVE_BRIDGE_URL_KEY)?.trim() || null; } catch { return null; }
  })();
  const hasToken = (() => {
    try { return !!localStorage.getItem(NATIVE_BRIDGE_TOKEN_KEY)?.trim(); } catch { return false; }
  })();

  const handleConnect = () => {
    setError(null);
    const url = urlInput.trim();
    if (!/^https?:\/\//i.test(url)) {
      setError("The node address must start with https:// (or http:// for localhost testing).");
      return;
    }
    setNativeBridgeConfig(url, tokenInput.trim() || null);
    window.location.reload();
  };
  const handleDisconnect = () => {
    clearNativeBridgeConfig();
    window.location.reload();
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div
        onClick={() => setOpen(!open)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          cursor: "pointer", gap: 12,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: T.sans }}>
            Chama node
          </div>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, marginTop: 4, lineHeight: 1.5 }}>
            {configuredUrl
              ? <>Connected to <span style={{ color: T.green }}>{configuredUrl}</span>{hasToken ? " · token set" : ""}</>
              : "Run your wallet on a node hosted by someone you trust."}
          </div>
        </div>
        <div style={{
          color: T.muted, fontFamily: T.mono, fontSize: 12,
          transform: open ? "rotate(90deg)" : "rotate(0)",
          transition: "transform 0.16s ease",
        }}>
          ▸
        </div>
      </div>

      {open && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 10 }}>
            Your wallet keys live on that node — connect only to a node run by a
            person you personally trust, and use it from ONE browser only.
            Sats pass through during trades and settle out; Chama holds nothing
            between trades.
          </div>
          <input
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder={configuredUrl ?? "https://node.example.com/w/yourname"}
            style={{ ...inputStyle, marginBottom: 8 }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <input
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
            placeholder="Access token (from your invite)"
            type="password"
            style={{ ...inputStyle, marginBottom: 8 }}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          {error && (
            <div style={{ fontSize: 11, color: T.red, fontFamily: T.mono, marginBottom: 8 }}>
              {error}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleConnect}
              disabled={!urlInput.trim()}
              style={{
                flex: 1, padding: "10px 12px", borderRadius: 8,
                border: `1px solid ${T.border}`,
                background: urlInput.trim() ? T.accent : T.card,
                color: urlInput.trim() ? "#fff" : T.muted,
                fontFamily: T.sans, fontSize: 13, fontWeight: 700,
                cursor: urlInput.trim() ? "pointer" : "default",
              }}
            >
              Connect (reloads app)
            </button>
            {configuredUrl && (
              <button
                onClick={handleDisconnect}
                style={{
                  padding: "10px 12px", borderRadius: 8,
                  border: `1px solid ${T.border}`, background: "none",
                  color: T.red, fontFamily: T.sans, fontSize: 13,
                  fontWeight: 600, cursor: "pointer",
                }}
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RecoveryPhraseCard() {
  const [revealed, setRevealed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const words = getCachedSeedWords();
  const phrase = words ? words.join(" ") : "";

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        RECOVERY PHRASE
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
        Chama is not a wallet — it puts you in total control. These 12 words are
        the private key to the ecash that passed through your account. Back them
        up offline and you can restore your funds on any Fedimint wallet, even if
        you lose this device or your Nostr account.
      </div>

      {!words ? (
        <div style={{
          padding: "10px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
        }}>
          Connect your Chama first, then come back to reveal your recovery phrase.
        </div>
      ) : !revealed ? (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
            background: T.amberDim, border: `1px solid ${T.amber}44`,
            color: T.amber, fontFamily: T.mono, fontSize: 10, lineHeight: 1.6,
          }}>
            ⚠ Anyone with these words can take your funds. Never type them into a
            website, and never share them — Chama will never ask for them. Make
            sure no one is watching your screen.
          </div>
          <button
            onClick={() => setRevealed(true)}
            style={{
              width: "100%", padding: "11px 14px", borderRadius: T.rs,
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >
            Reveal recovery phrase
          </button>
        </>
      ) : (
        <>
          <div style={{
            display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6,
            marginBottom: 12,
          }}>
            {words.map((word, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "baseline", gap: 6,
                padding: "7px 10px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                fontFamily: T.mono,
              }}>
                <span style={{ fontSize: 9, color: T.muted, minWidth: 14, textAlign: "right" }}>{i + 1}</span>
                <span style={{ fontSize: 12, color: T.text, fontWeight: 700 }}>{word}</span>
              </div>
            ))}
          </div>

          {showQr && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <QRCode data={phrase} size={240} margin={4} />
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
            <CopyButton
              value={phrase}
              label="Copy"
              copiedLabel="✓ Copied"
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            />
            <button
              onClick={() => setShowQr((v) => !v)}
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              {showQr ? "Hide QR" : "Show QR"}
            </button>
            <button
              onClick={() => { setRevealed(false); setShowQr(false); }}
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              Hide
            </button>
          </div>
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, textAlign: "center" }}>
            Write these on paper, in order. Copy and QR expose the phrase — use them only into your own backup.
          </div>
        </>
      )}
    </div>
  );
}

// ── Account key reveal (v2.5) ────────────────────────────────────────────
// The nsec is the MASTER key: it owns the Nostr identity AND decrypts the
// wallet seed stored on Nostr — so it can recover everything. We reveal it
// The reveal is an explicit user action. It asks the active local signer for
// its in-memory key, with a secure-storage fallback for older generated
// accounts. Extension and NIP-46 keys never touch Chama and cannot be revealed.
function NsecRevealCard({
  loadActiveRecoveryKey,
}: {
  loadActiveRecoveryKey?: () => Promise<string | null>;
}) {
  const [loaded, setLoaded] = useState(false);
  const [origin, setOrigin] = useState<string | null>(null);
  const [nsec, setNsec] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [revealError, setRevealError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let originVal: string | null = null;
      let nsecVal: string | null = null;
      try { originVal = (await Preferences.get({ key: "chama_nsec_origin" })).value; } catch { /* secure storage unavailable */ }
      try { nsecVal = (await Preferences.get({ key: "chama_saved_nsec" })).value; } catch { /* secure storage unavailable */ }
      if (isTauriRuntime()) {
        try { originVal = originVal ?? localStorage.getItem("chama_nsec_origin"); } catch { /* local storage unavailable */ }
        try { nsecVal = nsecVal ?? localStorage.getItem("chama_saved_nsec"); } catch { /* local storage unavailable */ }
      }
      if (cancelled) return;
      setOrigin(originVal);
      setNsec(nsecVal);
      setLoaded(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const canRevealStored = origin === "generated" && !!nsec;
  const canRequestActive = typeof loadActiveRecoveryKey === "function";

  const revealKey = async () => {
    setRevealError(null);
    if (canRevealStored) {
      setRevealed(true);
      return;
    }
    try {
      const active = await loadActiveRecoveryKey?.();
      if (!active) {
        setRevealError("This account uses an extension or remote signer, so Chama does not hold a recovery key to reveal.");
        return;
      }
      setNsec(active);
      setOrigin("active");
      setRevealed(true);
    } catch {
      setRevealError("Chama could not read the active local recovery key. Keep this session open and try again.");
    }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        ACCOUNT KEY (NSEC)
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
        Your nsec is the master key to this account — it owns your Nostr identity
        and can recover your wallet. It is strictly more powerful than your
        recovery phrase: anyone who has it owns everything.
      </div>

      {!loaded ? (
        <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>Checking your device…</div>
      ) : !canRevealStored && !canRequestActive ? (
        <div style={{
          padding: "10px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 11, lineHeight: 1.6,
        }}>
          {origin === "imported"
            ? "You signed in with your own key, so Chama doesn't reveal it — back it up where you created it."
            : "Chama only reveals a key it generated for you and stored on this device. If you use a remote signer (NIP-46), your key stays in your signer app."}
        </div>
      ) : !revealed ? (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
            background: T.redDim, border: `1px solid ${T.red}44`,
            color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.6,
          }}>
            ⚠ This is the master key to your whole account. Never type it into a
            website, never share it, and make sure no one is watching your screen.
            Chama will never ask for it.
          </div>
          <button
            onClick={() => void revealKey()}
            style={{
              width: "100%", padding: "11px 14px", borderRadius: T.rs,
              background: T.accentDim, border: `1px solid ${T.accent}66`,
              color: T.accent, fontFamily: T.mono, fontSize: 12, fontWeight: 800,
              cursor: "pointer", letterSpacing: 0.5,
            }}
          >
            Reveal active recovery key
          </button>
          {revealError && (
            <div style={{ marginTop: 10, color: T.red, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5 }}>
              {revealError}
            </div>
          )}
        </>
      ) : (
        <>
          <div style={{
            padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
            background: T.bg, border: `1px solid ${T.border}`,
            color: T.text, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
            wordBreak: "break-all" as const,
          }}>
            {nsec}
          </div>

          {showQr && nsec && (
            <div style={{ display: "flex", justifyContent: "center", marginBottom: 12 }}>
              <QRCode data={nsec} size={240} margin={4} />
            </div>
          )}

          <div style={{ display: "flex", gap: 8 }}>
            <CopyButton
              value={nsec ?? ""}
              disabled={!nsec}
              label="Copy"
              copiedLabel="✓ Copied"
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`, color: T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            />
            <button
              onClick={() => setShowQr((v) => !v)}
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              {showQr ? "Hide QR" : "Show QR"}
            </button>
            <button
              onClick={() => { setRevealed(false); setShowQr(false); }}
              style={{
                flex: 1, padding: "9px 12px", borderRadius: T.rs,
                background: T.surface, border: `1px solid ${T.border}`,
                color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
              }}
            >
              Hide
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Arbiter-substitution test lever ──────────────────────────────────────
// Writes chama_create_expiry_seconds, which createEscrow reads as the CREATE
// expiry override. Consensus-safe: the value is committed into the CREATE
// event itself, so all clients derive the same expiry + the same backup-
// arbiter floor. Only the creating device needs it. Power-user gated.
const CREATE_EXPIRY_OVERRIDE_KEY = "chama_create_expiry_seconds";

function readExpiryOverrideRaw(): string {
  try {
    return typeof localStorage === "undefined"
      ? ""
      : localStorage.getItem(CREATE_EXPIRY_OVERRIDE_KEY) ?? "";
  } catch {
    return "";
  }
}

function TestExpiryOverrideCard() {
  const [value, setValue] = useState<string>(() => readExpiryOverrideRaw());
  const active = readExpiryOverrideRaw() !== "";
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 300 && parsed <= 30 * 86400;

  const save = () => {
    try {
      if (!valid) return;
      localStorage.setItem(CREATE_EXPIRY_OVERRIDE_KEY, String(Math.floor(parsed)));
      setValue(String(Math.floor(parsed)));
    } catch { /* storage unavailable — no-op */ }
  };
  const clear = () => {
    try {
      localStorage.removeItem(CREATE_EXPIRY_OVERRIDE_KEY);
      setValue("");
    } catch { /* no-op */ }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${active ? T.amber : T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: active ? T.amber : T.muted,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        TEST TRADE EXPIRY {active ? "· ACTIVE" : "(POWER USER)"}
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
        Overrides the expiry baked into trades CREATED on this device (seconds,
        5 min – 30 days). A 1800s trade opens the backup-arbiter floor after
        ~15 min — every device follows the trade, only the creator needs this.
        Clear it after testing or you will list 30-minute trades for real.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 1800"
          inputMode="numeric"
          style={{ ...inputStyle, flex: 1, fontFamily: T.mono, fontSize: 12 }}
        />
        <button
          onClick={save}
          disabled={!valid}
          style={{
            background: valid ? T.amberDim : "none",
            border: `1px solid ${valid ? T.amber + "66" : T.border}`,
            color: valid ? T.amber : T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs,
            cursor: valid ? "pointer" : "default",
          }}
        >
          Set
        </button>
        <button
          onClick={clear}
          style={{
            background: "none", border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs, cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ── Substitution-grace test lever (v2.3) ─────────────────────────────────
// Writes chama_substitution_grace_seconds, committed into the LOCK by the
// locking device. Consensus-safe like the expiry override: every client
// replays the same committed grace, so the backup-arbiter floor opens at the
// identical moment everywhere. Lets a tester drive a SHORT floor (e.g. 60s)
// without manufacturing a long-expiry trade first. Power-user gated.
const SUBSTITUTION_GRACE_OVERRIDE_KEY = "chama_substitution_grace_seconds";

function readGraceOverrideRaw(): string {
  try {
    return typeof localStorage === "undefined"
      ? ""
      : localStorage.getItem(SUBSTITUTION_GRACE_OVERRIDE_KEY) ?? "";
  } catch {
    return "";
  }
}

function TestSubstitutionGraceCard() {
  const [value, setValue] = useState<string>(() => readGraceOverrideRaw());
  const active = readGraceOverrideRaw() !== "";
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 4 * 3600;

  const save = () => {
    try {
      if (!valid) return;
      localStorage.setItem(SUBSTITUTION_GRACE_OVERRIDE_KEY, String(Math.floor(parsed)));
      setValue(String(Math.floor(parsed)));
    } catch { /* storage unavailable — no-op */ }
  };
  const clear = () => {
    try {
      localStorage.removeItem(SUBSTITUTION_GRACE_OVERRIDE_KEY);
      setValue("");
    } catch { /* no-op */ }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${active ? T.amber : T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: active ? T.amber : T.muted,
        fontFamily: T.mono, letterSpacing: 1, marginBottom: 8,
      }}>
        TEST SUBSTITUTION GRACE {active ? "· ACTIVE" : "(POWER USER)"}
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 12 }}>
        Sets the grace ceiling (seconds, 0 – 4h) committed into trades LOCKED on
        this device — how long the assigned arbiter keeps the dispute to itself
        before a backup may step in. 60 opens the floor a minute after a dispute
        instead of hours; still floored by half the trade's remaining life.
        Clear it after testing.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. 60"
          inputMode="numeric"
          style={{ ...inputStyle, flex: 1, fontFamily: T.mono, fontSize: 12 }}
        />
        <button
          onClick={save}
          disabled={!valid}
          style={{
            background: valid ? T.amberDim : "none",
            border: `1px solid ${valid ? T.amber + "66" : T.border}`,
            color: valid ? T.amber : T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs,
            cursor: valid ? "pointer" : "default",
          }}
        >
          Set
        </button>
        <button
          onClick={clear}
          style={{
            background: "none", border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700,
            padding: "8px 12px", borderRadius: T.rs, cursor: "pointer",
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

// ── Fedi WebLN probe (v2.5 #52 spike) ────────────────────────────────────
// Run INSIDE the real Fedi mini-app. Answers the one open question for the
// cross-federation sandwich: can Chama's WASM Fedimint client run in the Fedi
// WebView, and what does the host's window.webln actually expose? The funding
// leg (webln.sendPayment) is already field-confirmed; the WASM prerequisites
// (SharedArrayBuffer / crossOriginIsolated / OPFS) are the unknowns. Read out,
// copy, send back — no side effects beyond an optional webln.enable() prompt.
function FediWeblnProbeCard() {
  const [report, setReport] = useState<string | null>(null);
  const [weblnResult, setWeblnResult] = useState<string | null>(null);
  const [communities, setCommunities] = useState<string | null>(null);

  const run = () => {
    const w = window as unknown as Record<string, any>;
    const yn = (b: boolean) => (b ? "YES" : "no");
    const methodsOf = (o: any) => {
      if (!o) return "(absent)";
      try {
        const keys = [
          ...Object.keys(o),
          ...Object.getOwnPropertyNames(Object.getPrototypeOf(o) ?? {}),
        ].filter((k) => k !== "constructor");
        return Array.from(new Set(keys)).join(", ") || "(none enumerable)";
      } catch { return "(unreadable)"; }
    };
    const lines = [
      `fediInternal: ${yn(!!w.fediInternal)}`,
      `  fediInternal methods: ${methodsOf(w.fediInternal)}`,
      `webln: ${yn(!!w.webln)}`,
      `  webln methods: ${methodsOf(w.webln)}`,
      `WebAssembly: ${yn(typeof WebAssembly !== "undefined")}`,
      `OPFS (storage.getDirectory): ${yn(!!(navigator as any).storage?.getDirectory)}`,
      `SharedArrayBuffer: ${yn(typeof SharedArrayBuffer !== "undefined")}`,
      `crossOriginIsolated: ${yn(!!w.crossOriginIsolated)}`,
      `isSecureContext: ${yn(!!w.isSecureContext)}`,
      `hardwareConcurrency: ${(navigator as any).hardwareConcurrency ?? "?"}`,
      `UA: ${navigator.userAgent.slice(0, 100)}`,
    ];
    setReport(lines.join("\n"));
  };

  const testWebln = async () => {
    const w = window as unknown as Record<string, any>;
    if (!w.webln) { setWeblnResult("webln: not present"); return; }
    try {
      if (typeof w.webln.enable === "function") await w.webln.enable();
      let info = "";
      if (typeof w.webln.getInfo === "function") {
        try { info = JSON.stringify(await w.webln.getInfo()).slice(0, 140); } catch {}
      }
      setWeblnResult(`enable() OK${info ? " · getInfo: " + info : " (no getInfo)"}`);
    } catch (e: any) {
      setWeblnResult(`webln error: ${(e?.message || String(e)).slice(0, 140)}`);
    }
  };

  // v2.5 #52 — READ-ONLY community map. No fund movement, no setSelectedCommunity
  // (that would change your active Fedi state). Just dumps the shapes of the
  // host's communities + the selected fed's currency/member, so we can see
  // whether a Fedi "community" carries its federation (id/invite/currency) and
  // how the switch-and-act flow should address fed B.
  const mapCommunities = async () => {
    const fi = (window as unknown as Record<string, any>).fediInternal;
    if (!fi) { setCommunities("fediInternal: not present"); return; }
    const out: string[] = [];
    const call = async (name: string, fn: any) => {
      if (typeof fn !== "function") { out.push(`${name}: (not a function)`); return; }
      try {
        const r = await fn.call(fi);
        const dump = typeof r === "string" ? r : JSON.stringify(r);
        out.push(`${name}: ${(dump ?? String(r)).slice(0, 500)}`);
      } catch (e: any) {
        out.push(`${name}: ERROR ${(e?.message || String(e)).slice(0, 140)}`);
      }
    };
    await call("getAuthenticatedMember", fi.getAuthenticatedMember);
    await call("getCurrencyCode", fi.getCurrencyCode);
    await call("getLanguageCode", fi.getLanguageCode);
    await call("listCreatedCommunities", fi.listCreatedCommunities);
    await call("getInstalledMiniApps", fi.getInstalledMiniApps);
    setCommunities(out.join("\n\n"));
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        FEDI WEBLN PROBE (#52 SPIKE)
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
        Run this inside the Fedi mini-app. It reports whether Chama's Fedimint
        WASM client can run here (SharedArrayBuffer / crossOriginIsolated / OPFS)
        and what the host's WebLN exposes — the last unknowns for cross-Chama
        trading. Copy the readout and send it back.
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          onClick={run}
          style={{
            flex: 1, padding: "10px 12px", borderRadius: T.rs,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
          }}
        >
          Run probe
        </button>
        <button
          onClick={() => void testWebln()}
          style={{
            flex: 1, padding: "10px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
          }}
        >
          Test WebLN
        </button>
      </div>

      <button
        onClick={() => void mapCommunities()}
        style={{
          width: "100%", padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
          background: T.tealDim, border: `1px solid ${T.teal}55`,
          color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 800, cursor: "pointer",
        }}
      >
        Map communities (read-only)
      </button>

      {report && (
        <div style={{
          padding: "10px 12px", borderRadius: T.rs,
          background: T.bg, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.mono, fontSize: 10, lineHeight: 1.6,
          whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const,
          marginBottom: weblnResult ? 8 : 10,
        }}>
          {report}
        </div>
      )}
      {weblnResult && (
        <div style={{
          padding: "9px 11px", borderRadius: T.rs, marginBottom: 10,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5,
          whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const,
        }}>
          WebLN · {weblnResult}
        </div>
      )}
      {communities && (
        <div style={{
          padding: "10px 12px", borderRadius: T.rs, marginBottom: 10,
          background: T.bg, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.mono, fontSize: 9, lineHeight: 1.6,
          whiteSpace: "pre-wrap" as const, wordBreak: "break-all" as const,
          maxHeight: 220, overflowY: "auto",
        }}>
          {communities}
        </div>
      )}
      {(report || communities) && (
        <CopyButton
          value={[
            report,
            weblnResult ? `webln: ${weblnResult}` : "",
            communities ? `--- communities ---\n${communities}` : "",
          ].filter(Boolean).join("\n\n")}
          label="Copy readout"
          copiedLabel="✓ Copied"
          style={{
            width: "100%", padding: "9px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`, color: T.muted,
            fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
          }}
        />
      )}
    </div>
  );
}

// ── Discovery diagnostics (Fedi round 3, INSTRUMENT-FIRST) ───────────────────
// Read-only on-device anatomy of the last "My Trades" discovery fetch, for the
// Fedi-webview empty/partial defect (relays connected + data present, yet
// discovery returns empty/partial and Refresh×15 does nothing). Three readouts,
// each disambiguating a different candidate:
//   1. resolvedBy per leg (THE headline) — EOSE+0 events = relays answered
//      "nothing for this key" (wrong query key, candidate 1) vs TIMEOUT+0 = no
//      frames came back (blocked transport, candidate 2/3).
//   2. three-way pubkey compare — a FRESH window.nostr.getPublicKey() vs the
//      key discovery actually queried (state.pubkey — Refresh re-queries this,
//      not a fresh read) vs the pinned identity. A mismatch is candidate 1, a
//      connect-time mis-seed at useEscrow.ts:905.
//   3. #d transport control — fetch one KNOWN escrow id over the SAME fetch
//      path, pubkey-independent. Events back ⇒ transport fine ⇒ it's the key.
// Modeled on FediWeblnProbeCard: power-user-gated, copyable, zero side effects.

function shortRelay(url: string): string {
  return url.replace(/^wss?:\/\//, "").replace(/\/$/, "");
}

function resolvedTone(by: ResolvedBy): string {
  switch (by) {
    case "eose": return T.green;        // every relay responded — transport healthy
    case "eose-quorum": return T.teal;  // quorum responded, skipped a laggard
    case "timeout": return T.red;       // no quorum — transport suspect
    case "no-relays": return T.muted;
    default: return T.amber;            // pending
  }
}

function resolvedLabel(by: ResolvedBy): string {
  switch (by) {
    case "eose": return "EOSE";
    case "eose-quorum": return "EOSE·Q";
    case "timeout": return "TIMEOUT";
    case "no-relays": return "NO RELAYS";
    default: return "PENDING";
  }
}

/** One-line read of what a leg's resolvedBy + event count means. */
function legVerdict(leg: FetchLegDiag): { text: string; tone: string } {
  const skippedLaggard = leg.perRelay.some(r => r.reqSent && !r.eose);
  const quorumNote = leg.resolvedBy === "eose-quorum" && skippedLaggard
    ? " (resolved on quorum — a connected relay never EOSE'd; no full-timeout stall)"
    : "";
  if (leg.totalEvents > 0) {
    return { text: `${leg.totalEvents} event(s) returned — transport OK on this leg${quorumNote}`, tone: T.green };
  }
  if (leg.resolvedBy === "eose" || leg.resolvedBy === "eose-quorum") {
    return { text: `EOSE with 0 events — relays answered EMPTY → query key likely WRONG (candidate 1)${quorumNote}`, tone: T.amber };
  }
  if (leg.resolvedBy === "timeout") {
    return { text: "Timed out, 0 events — REQs out, no frames back → transport blocked (candidate 2/3)", tone: T.red };
  }
  if (leg.resolvedBy === "no-relays") {
    return { text: "No relays connected at dispatch", tone: T.muted };
  }
  return { text: "Did not resolve", tone: T.amber };
}

function legTextLines(leg: FetchLegDiag): string[] {
  const out: string[] = [];
  out.push(`[${leg.label}] ${resolvedLabel(leg.resolvedBy)} · unique:${leg.totalEvents} · ${leg.elapsedMs}ms`);
  out.push(`  filter: ${leg.filterSummary}`);
  for (const r of leg.perRelay) {
    out.push(`  ${shortRelay(r.url)} conn:${r.connected ? "Y" : "n"} req:${r.reqSent ? "Y" : "n"} ev:${r.events} eose:${r.eose ? "Y" : "n"}`);
  }
  out.push(`  -> ${legVerdict(leg).text}`);
  return out;
}

async function readFreshSignerPubkey(): Promise<{ value: string | null; error: string | null }> {
  try {
    const nostr = (window as unknown as Record<string, any>).nostr;
    if (!nostr?.getPublicKey) return { value: null, error: "window.nostr.getPublicKey absent" };
    const raw = await nostr.getPublicKey();
    const clean = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(clean)) {
      return { value: clean || null, error: clean ? "not 64-hex" : "returned empty" };
    }
    return { value: clean, error: null };
  } catch (e: any) {
    return { value: null, error: (e?.message || String(e)).slice(0, 120) };
  }
}

function LegBlock({ leg }: { leg: FetchLegDiag }) {
  const verdict = legVerdict(leg);
  return (
    <div style={{
      padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
      background: T.bg, border: `1px solid ${T.border}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: T.text, fontFamily: T.mono, fontWeight: 800 }}>
          {leg.label}
        </span>
        <span style={{
          fontSize: 10, fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.5,
          padding: "2px 7px", borderRadius: 999,
          color: resolvedTone(leg.resolvedBy),
          background: `${resolvedTone(leg.resolvedBy)}1f`,
          border: `1px solid ${resolvedTone(leg.resolvedBy)}55`,
        }}>
          {resolvedLabel(leg.resolvedBy)}
        </span>
        <span style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>
          unique:{leg.totalEvents} · {leg.elapsedMs}ms
        </span>
      </div>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginBottom: 6, wordBreak: "break-all" }}>
        {leg.filterSummary}
      </div>
      {leg.perRelay.length === 0 ? (
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono }}>(no relays touched)</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 6 }}>
          {leg.perRelay.map((r) => (
            <div key={r.url} style={{
              display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
              fontSize: 10, fontFamily: T.mono, color: T.text,
            }}>
              <span style={{ minWidth: 120, color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {shortRelay(r.url)}
              </span>
              <span style={{ color: r.connected ? T.green : T.muted }}>conn:{r.connected ? "Y" : "n"}</span>
              <span style={{ color: r.reqSent ? T.green : T.red }}>req:{r.reqSent ? "Y" : "n"}</span>
              <span style={{ color: r.events > 0 ? T.green : T.muted }}>ev:{r.events}</span>
              <span style={{ color: r.eose ? T.green : T.muted }}>eose:{r.eose ? "Y" : "n"}</span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 10, color: verdict.tone, fontFamily: T.mono, lineHeight: 1.5 }}>
        → {verdict.text}
      </div>
    </div>
  );
}

function KeyRow({ label, value, tone = T.text }: { label: string; value: string | null; tone?: string }) {
  return (
    <div style={{ marginBottom: 7 }}>
      <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, letterSpacing: 0.5, marginBottom: 2 }}>
        {label}
      </div>
      <div style={{ fontSize: 10, color: value ? tone : T.muted, fontFamily: T.mono, wordBreak: "break-all", lineHeight: 1.45 }}>
        {value ?? "(none)"}
      </div>
    </div>
  );
}

function shortId(id: string): string {
  return id.length > 22 ? `${id.slice(0, 14)}…${id.slice(-5)}` : id;
}

function hydrateClassTone(cls: HydrateIdDiag["cls"]): string {
  switch (cls) {
    case "fresh": return T.accent;
    case "known": return T.amber;     // the skip-and-never-heal bucket
    default: return T.muted;          // forgotten
  }
}

function hydrateOutcomeTone(d: HydrateIdDiag): string {
  if (d.discarded || d.outcome.startsWith("load-failed") || d.outcome === "load-null") return T.red;
  if (/COMPLETED|CANCELLED/.test(d.outcome)) return T.green;   // settled or healed-done
  if (/EXPIRED/.test(d.outcome)) return T.amber;               // still stuck (pre-heal or unhealed)
  return T.text;                                               // in-flight: LOCKED/APPROVED/CLAIMED
}

/** One-line read of a hydrate run (post fix (a): the path now re-heals known
 *  non-terminal trades, so this is a health readout, not a bug-finder). */
function hydrateVerdict(run: HydrateRunDiag): { text: string; tone: string } {
  const healed = run.ids.filter(d => d.outcome.startsWith("loaded:")).length;
  const settled = run.ids.filter(d => d.outcome.startsWith("settled:")).length;
  const discarded = run.ids.filter(d => d.discarded).length;
  const failed = run.ids.filter(d => d.outcome.startsWith("load-failed") || d.outcome === "load-null").length;
  const stuck = run.ids.filter(d => /loaded:(EXPIRED|LOCKED|APPROVED|CLAIMED)/.test(d.outcome)).length;
  if (healed > 0) {
    const tail = [
      run.added ? `${run.added} new` : "",
      settled ? `${settled} settled skipped` : "",
      discarded ? `${discarded} discarded` : "",
      failed ? `${failed} failed` : "",
    ].filter(Boolean).join(" · ");
    return {
      text: `Re-loaded ${healed} non-terminal trade(s)${tail ? " · " + tail : ""}` +
        (stuck ? ` — ${stuck} still not COMPLETED (tail may still be missing; try again)` : ""),
      tone: stuck ? T.amber : T.green,
    };
  }
  if (settled > 0 && discarded === 0 && failed === 0) {
    return { text: `Nothing to heal — all ${settled} discovered trade(s) already settled`, tone: T.muted };
  }
  if (failed > 0) {
    return { text: `${failed} trade(s) failed to load — slow/blocked fetch? Run the #d control`, tone: T.amber };
  }
  if (discarded > 0) {
    return { text: `${discarded} fresh id(s) discarded as expired-unfunded (never funded, past expiry)`, tone: T.amber };
  }
  return { text: `discovered ${run.discovered} · healed ${healed} · added ${run.added}`, tone: T.muted };
}

function hydrateTextLines(run: HydrateRunDiag): string[] {
  const out: string[] = [];
  out.push("-- hydrate run --");
  out.push(`discovered:${run.discovered} known:${run.knownCount} forgotten:${run.forgottenCount} fresh:${run.freshCount} added:${run.added}`);
  out.push(`verdict: ${hydrateVerdict(run).text}`);
  for (const d of run.ids) {
    out.push(`  [${d.cls}] ${d.id} -> ${d.outcome}${d.terminal ? " (terminal)" : ""}`);
  }
  return out;
}

function HydrateBlock({ run }: { run: HydrateRunDiag }) {
  const verdict = hydrateVerdict(run);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
        HYDRATE · discovered:{run.discovered} · known:{run.knownCount} · forgotten:{run.forgottenCount} · fresh:{run.freshCount} · added:{run.added}
      </div>
      <div style={{
        padding: "9px 11px", borderRadius: T.rs, marginBottom: 8,
        background: T.surface, border: `1px solid ${verdict.tone}55`,
        color: verdict.tone, fontFamily: T.mono, fontSize: 10, lineHeight: 1.55,
      }}>
        {verdict.text}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
        {run.ids.slice(0, 30).map((d) => (
          <div key={d.id} style={{
            display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
            fontSize: 10, fontFamily: T.mono,
          }}>
            <span style={{
              fontSize: 9, fontWeight: 800, letterSpacing: 0.3, padding: "1px 6px",
              borderRadius: 999, color: hydrateClassTone(d.cls),
              background: `${hydrateClassTone(d.cls)}1f`, border: `1px solid ${hydrateClassTone(d.cls)}55`,
            }}>
              {d.cls}
            </span>
            <span style={{ color: T.muted, minWidth: 110, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {shortId(d.id)}
            </span>
            <span style={{ color: hydrateOutcomeTone(d), wordBreak: "break-all" }}>
              {d.outcome}
            </span>
          </div>
        ))}
        {run.ids.length > 30 && (
          <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
            … +{run.ids.length - 30} more (in the copied readout)
          </div>
        )}
      </div>
    </div>
  );
}

function DiscoveryDiagnosticCard({
  queriedPubkey,
  onRunDiscovery,
  onProbeFetchById,
}: {
  queriedPubkey: string | null;
  onRunDiscovery?: () => Promise<number>;
  onProbeFetchById?: (escrowId: string) => Promise<FetchLegDiag>;
}) {
  const [run, setRun] = useState<DiscoveryRunDiag | null>(() => getLastDiscoveryRun());
  const [hydrate, setHydrate] = useState<HydrateRunDiag | null>(() => getLastHydrateRun());
  const [running, setRunning] = useState(false);
  const [runResult, setRunResult] = useState<string | null>(null);
  const [fresh, setFresh] = useState<{ value: string | null; error: string | null } | null>(null);
  const [idInput, setIdInput] = useState("");
  const [idProbe, setIdProbe] = useState<FetchLegDiag | null>(null);
  const [idBusy, setIdBusy] = useState(false);
  const [idError, setIdError] = useState<string | null>(null);

  // Reflect auto-runs (connect + relay-growth), not just button presses.
  useEffect(() => {
    setRun(getLastDiscoveryRun());
    return subscribeDiscoveryRun(() => setRun(getLastDiscoveryRun()));
  }, []);
  useEffect(() => {
    setHydrate(getLastHydrateRun());
    return subscribeHydrateRun(() => setHydrate(getLastHydrateRun()));
  }, []);

  const checkIdentity = () => { void readFreshSignerPubkey().then(setFresh); };
  // Fresh signer read on mount — capture failure/empty as a RESULT, not a crash.
  useEffect(() => { checkIdentity(); }, []);

  const pinned = (() => { try { return getPinnedIdentity(); } catch { return null; } })();
  const queried = queriedPubkey ? queriedPubkey.toLowerCase() : null;

  const runDiscovery = async () => {
    if (!onRunDiscovery) return;
    setRunning(true);
    setRunResult(null);
    checkIdentity();
    try {
      const added = await onRunDiscovery();
      setRun(getLastDiscoveryRun());
      setHydrate(getLastHydrateRun());
      setRunResult(`Discovery ran · ${added} new trade(s) hydrated`);
    } catch (e: any) {
      setRunResult(`Discovery error: ${(e?.message || String(e)).slice(0, 120)}`);
    } finally {
      setRunning(false);
    }
  };

  const probeId = async () => {
    if (!onProbeFetchById) return;
    const id = idInput.trim();
    if (!id) { setIdError("Paste an escrow id (e.g. sm_…)."); return; }
    setIdBusy(true);
    setIdError(null);
    setIdProbe(null);
    try {
      setIdProbe(await onProbeFetchById(id));
    } catch (e: any) {
      setIdError((e?.message || String(e)).slice(0, 120));
    } finally {
      setIdBusy(false);
    }
  };

  const identityVerdict: { text: string; tone: string } = (() => {
    if (!fresh) return { text: "Reading signer…", tone: T.muted };
    if (fresh.error && !fresh.value) return { text: `Fresh signer read failed: ${fresh.error} (a signal, not a crash)`, tone: T.amber };
    const f = fresh.value;
    if (f && queried && f !== queried) {
      return { text: "⚠ MISMATCH: fresh signer ≠ queried key → candidate 1 (signer drift / connect-time mis-seed)", tone: T.red };
    }
    if (pinned && queried && pinned.toLowerCase() !== queried) {
      return { text: "⚠ Queried key ≠ pinned identity — a re-scope happened; confirm which key owns the trades", tone: T.amber };
    }
    if (f && queried && f === queried && (!pinned || pinned.toLowerCase() === queried)) {
      return { text: "✓ Fresh signer = queried key = pin — identity consistent; the defect is transport (see legs above)", tone: T.green };
    }
    return { text: "Partial identity info — compare the three keys below", tone: T.muted };
  })();

  const readoutText = (() => {
    const lines: string[] = [];
    lines.push("=== CHAMA DISCOVERY DIAGNOSTIC (Fedi R3) ===");
    lines.push(`queried pubkey (state): ${queried ?? "(none)"}`);
    lines.push(`fresh window.nostr:     ${fresh?.value ?? (fresh?.error ? "ERR " + fresh.error : "(unread)")}`);
    lines.push(`pinned identity:        ${pinned ?? "(none)"}`);
    lines.push(`identity verdict: ${identityVerdict.text}`);
    lines.push("");
    if (run) {
      lines.push(`-- discovery run --`);
      lines.push(`queriedPubkey: ${run.queriedPubkey}`);
      lines.push(`idsDiscovered: ${run.idsDiscovered} · eventsFetched: ${run.eventsFetched}`);
      for (const leg of run.legs) lines.push(...legTextLines(leg));
    } else {
      lines.push("(no discovery run captured yet)");
    }
    lines.push("");
    if (hydrate) {
      lines.push(...hydrateTextLines(hydrate));
    } else {
      lines.push("(no hydrate run captured yet)");
    }
    if (idProbe) {
      lines.push("");
      lines.push("-- #d transport control --");
      lines.push(...legTextLines(idProbe));
    }
    return lines.join("\n");
  })();

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        MY TRADES DISCOVERY (FEDI R3)
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono, lineHeight: 1.6, marginBottom: 12 }}>
        Run this inside Fedi when My Trades is empty/partial. It shows the last
        discovery fetch's anatomy: whether each leg ended on EOSE (relays
        answered) or TIMEOUT (no frames came back), the exact pubkey queried vs a
        fresh signer read, and a pubkey-independent #d control. Copy the readout
        and send it back.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <button
          onClick={() => void runDiscovery()}
          disabled={!onRunDiscovery || running}
          style={{
            flex: 1, minWidth: 150, padding: "10px 12px", borderRadius: T.rs,
            background: T.accentDim, border: `1px solid ${T.accent}66`,
            color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            cursor: !onRunDiscovery || running ? "default" : "pointer",
            opacity: !onRunDiscovery || running ? 0.6 : 1,
          }}
        >
          {running ? "Running…" : "Run discovery now"}
        </button>
        <button
          onClick={checkIdentity}
          style={{
            padding: "10px 12px", borderRadius: T.rs,
            background: T.surface, border: `1px solid ${T.border}`,
            color: T.muted, fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
          }}
        >
          Re-check identity
        </button>
      </div>
      {runResult && (
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 12, lineHeight: 1.5 }}>
          {runResult}
        </div>
      )}

      {/* Identity triangulation (candidate 1) */}
      <div style={{
        padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
        background: T.surface, border: `1px solid ${identityVerdict.tone}55`,
      }}>
        <div style={{ fontSize: 10, color: identityVerdict.tone, fontFamily: T.mono, fontWeight: 800, lineHeight: 1.5, marginBottom: 8 }}>
          {identityVerdict.text}
        </div>
        <KeyRow label="QUERIED KEY (state.pubkey — what Refresh queries)" value={queried} />
        <KeyRow
          label="FRESH window.nostr.getPublicKey()"
          value={fresh ? (fresh.value ?? `ERR: ${fresh.error}`) : "reading…"}
          tone={fresh?.value && queried && fresh.value !== queried ? T.red : T.text}
        />
        <KeyRow label="PINNED IDENTITY" value={pinned} />
      </div>

      {/* Discovery legs (candidate 2/3 — the resolvedBy headline) */}
      {run ? (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, marginBottom: 6 }}>
            DISCOVERY · {run.idsDiscovered} id(s) · {run.eventsFetched} event(s)
          </div>
          {run.legs.map((leg, i) => <LegBlock key={i} leg={leg} />)}
        </div>
      ) : (
        <div style={{
          padding: "10px 12px", borderRadius: T.rs, marginBottom: 12,
          background: T.bg, border: `1px solid ${T.border}`,
          color: T.muted, fontFamily: T.mono, fontSize: 10, lineHeight: 1.5,
        }}>
          No discovery run captured yet — tap Run discovery now.
        </div>
      )}

      {/* Hydrate path (round 3b — discovery finds them, why aren't they shown?) */}
      {hydrate && <HydrateBlock run={hydrate} />}

      {/* #d transport control (pubkey-independent) */}
      <div style={{
        padding: "10px 12px", borderRadius: T.rs,
        background: T.surface, border: `1px solid ${T.border}`, marginBottom: 12,
      }}>
        <div style={{ fontSize: 10, color: T.text, fontFamily: T.mono, fontWeight: 800, letterSpacing: 0.4, marginBottom: 6 }}>
          #d TRANSPORT CONTROL
        </div>
        <div style={{ fontSize: 10, color: T.muted, fontFamily: T.mono, lineHeight: 1.5, marginBottom: 8 }}>
          Fetch one KNOWN trade by id over the same path — no signer involved.
          Events back ⇒ transport works ⇒ an empty discovery is the query key.
          Times out empty ⇒ transport is blocked.
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: idProbe || idError ? 10 : 0 }}>
          <input
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            placeholder="sm_mqm0mzwh_mr207nq0"
            style={{ ...inputStyle, flex: 1, fontFamily: T.mono, fontSize: 11 }}
          />
          <button
            onClick={() => void probeId()}
            disabled={!onProbeFetchById || idBusy}
            style={{
              padding: "8px 12px", borderRadius: T.rs,
              background: T.tealDim, border: `1px solid ${T.teal}55`,
              color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: !onProbeFetchById || idBusy ? "default" : "pointer",
              opacity: !onProbeFetchById || idBusy ? 0.6 : 1,
            }}
          >
            {idBusy ? "Probing…" : "Probe by id"}
          </button>
        </div>
        {idError && (
          <div style={{ fontSize: 10, color: T.red, fontFamily: T.mono, lineHeight: 1.5 }}>⚠ {idError}</div>
        )}
        {idProbe && <LegBlock leg={idProbe} />}
      </div>

      <CopyButton
        value={readoutText}
        label="Copy readout"
        copiedLabel="✓ Copied"
        style={{
          width: "100%", padding: "9px 12px", borderRadius: T.rs,
          background: T.surface, border: `1px solid ${T.border}`, color: T.muted,
          fontFamily: T.mono, fontSize: 11, fontWeight: 700, cursor: "pointer",
        }}
      />
    </div>
  );
}

// ── V3 roster keystone: steward publish surface ─────────────────────────────
// Renders ONLY when the signed-in user is in the community's roster
// authority (registry steward pin, else the shell creator) — everyone else
// never sees it. Publishing signs a kind:38120 replaceable event; verifiers
// everywhere re-check authority + signature, so a stray publish from a
// non-authority key is ignored by every other client (and by this one).
function StewardRosterCard({
  communitySlug,
  userPubkey,
  onPublishRoster,
  onFetchApplications,
}: {
  communitySlug: string | null;
  userPubkey: string | null;
  onPublishRoster?: (community: string, arbiters: string[]) => Promise<void>;
  onFetchApplications?: (
    community: string,
    excludePubkeys?: string[],
  ) => Promise<{ applicant: string; statement: string; createdAt: number }[]>;
}) {
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [applications, setApplications] = useState<
    { applicant: string; statement: string; createdAt: number }[] | null
  >(null);
  const [appsBusy, setAppsBusy] = useState(false);

  if (!communitySlug || !userPubkey || !onPublishRoster) return null;
  const entry = getCommunityBySlug(communitySlug);
  const authority = resolveRosterAuthority({
    stewardPubkey: entry?.stewardPubkey ?? null,
    creatorPubkey: entry?.creatorPubkey ?? null,
  });
  if (!authority.includes(userPubkey.toLowerCase())) return null;

  const current = readVerifiedRosterPool(communitySlug);
  const displayName = entry?.displayName ?? communitySlug;

  const publish = async () => {
    const arbiters = normalizeTrustedArbiterInput(draft);
    if (arbiters.length === 0) {
      setError("Paste at least one arbiter key (npub or hex, one per line).");
      return;
    }
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await onPublishRoster(communitySlug, arbiters);
      setStatus(`Signed roster published — ${arbiters.length} arbiter${arbiters.length === 1 ? "" : "s"} for ${displayName}.`);
      setDraft("");
    } catch (e: any) {
      setError(e?.message || "Publish failed — check relays and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: T.muted, fontFamily: T.mono,
        letterSpacing: 1, marginBottom: 8,
      }}>
        COMMUNITY ARBITER ROSTER · STEWARD
      </div>
      <div style={{ fontSize: 11, color: T.muted, fontFamily: T.sans, lineHeight: 1.5, marginBottom: 10 }}>
        You hold the roster authority for {displayName}. Publishing signs the
        community's recognized-arbiter list (kind:38120) — every Chama client
        verifies it against your key and treats it as the strongest provenance
        source. Newest roster replaces the old one.
      </div>
      {current.length > 0 && (
        <div style={{
          fontSize: 10, color: T.text, fontFamily: T.mono, lineHeight: 1.6,
          padding: "8px 10px", borderRadius: T.rs, marginBottom: 10,
          background: T.surface, border: `1px solid ${T.border}`,
        }}>
          Current verified roster ({current.length}):{" "}
          {current.map(pk => `${pk.slice(0, 8)}…${pk.slice(-4)}`).join(" · ")}
        </div>
      )}
      <textarea
        value={draft}
        onChange={e => setDraft(e.target.value)}
        placeholder={"npub1… or hex, one arbiter per line"}
        rows={3}
        style={{
          width: "100%", boxSizing: "border-box", resize: "vertical",
          padding: "10px 12px", borderRadius: T.rs, marginBottom: 8,
          background: T.surface, border: `1px solid ${T.border}`,
          color: T.text, fontFamily: T.mono, fontSize: 11, lineHeight: 1.5,
        }}
      />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          onClick={publish}
          disabled={busy}
          style={{
            padding: "10px 14px", borderRadius: T.rs,
            border: `1px solid ${T.accent}66`, background: T.accentDim,
            color: T.accent, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
            cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? "Publishing…" : "Sign + publish roster"}
        </button>
        {onFetchApplications && (
          <button
            onClick={async () => {
              setAppsBusy(true);
              setError(null);
              try {
                setApplications(await onFetchApplications(communitySlug, current));
              } catch (e: any) {
                setError(e?.message || "Couldn't fetch applications.");
              } finally {
                setAppsBusy(false);
              }
            }}
            disabled={appsBusy}
            style={{
              padding: "10px 14px", borderRadius: T.rs,
              border: `1px solid ${T.teal}66`, background: T.tealDim,
              color: T.teal, fontFamily: T.mono, fontSize: 11, fontWeight: 800,
              cursor: appsBusy ? "default" : "pointer", opacity: appsBusy ? 0.6 : 1,
            }}
          >
            {appsBusy ? "Fetching…" : "Review applications"}
          </button>
        )}
      </div>
      {applications && (
        <div style={{ marginTop: 10 }}>
          {applications.length === 0 ? (
            <div style={{ fontSize: 11, color: T.muted, fontFamily: T.mono }}>
              No pending applications for {displayName} (already-rostered keys are filtered out).
            </div>
          ) : applications.map(app => (
            <div
              key={app.applicant}
              style={{
                padding: "8px 10px", borderRadius: T.rs, marginBottom: 6,
                background: T.surface, border: `1px solid ${T.border}`,
              }}
            >
              <div style={{
                display: "flex", justifyContent: "space-between",
                alignItems: "center", gap: 8, marginBottom: 4,
              }}>
                <span style={{ fontSize: 10, color: T.teal, fontFamily: T.mono, fontWeight: 800 }}>
                  {app.applicant.slice(0, 8)}…{app.applicant.slice(-4)}
                </span>
                <button
                  onClick={() => setDraft(d => (d.trim() ? `${d.trim()}\n${app.applicant}` : app.applicant))}
                  style={{
                    padding: "4px 9px", borderRadius: 999,
                    border: `1px solid ${T.green}66`, background: T.greenDim,
                    color: T.green, fontFamily: T.mono, fontSize: 10, fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  + Add to roster
                </button>
              </div>
              <div style={{ fontSize: 11, color: T.text, fontFamily: T.sans, lineHeight: 1.5 }}>
                {app.statement}
              </div>
            </div>
          ))}
        </div>
      )}
      {status && (
        <div style={{ marginTop: 8, fontSize: 11, color: T.green, fontFamily: T.mono }}>
          ✓ {status}
        </div>
      )}
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: T.red, fontFamily: T.mono }}>
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
