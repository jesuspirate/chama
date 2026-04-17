// ══════════════════════════════════════════════════════════════════════════
// Chama DM Notification Service
// ══════════════════════════════════════════════════════════════════════════
//
// Sends NIP-04 encrypted DMs to participants and community arbiters
// when key events happen in a trade. Uses the user's NIP-07 signer
// (nos2x / Alby) to encrypt and sign the DM events.
//
// DM events are kind:4 (NIP-04 encrypted direct messages).
// Future: upgrade to NIP-17 (kind:14 sealed sender) for better privacy.

import type { EscrowState, Role } from "./types.js";
import type { Signer } from "./escrow-client.js";
import type { RelayManager } from "./relay-manager.js";

export interface NotificationConfig {
  enabled: boolean;
  /** Send DMs to community arbiter pool on trade creation */
  notifyArbitersOnCreate: boolean;
  /** Send DMs to all participants on state changes */
  notifyOnStateChange: boolean;
}

export const DEFAULT_NOTIFICATION_CONFIG: NotificationConfig = {
  enabled: true,
  notifyArbitersOnCreate: true,
  notifyOnStateChange: true,
};

export class EscrowNotifier {
  private signer: Signer;
  private relayManager: RelayManager;
  private config: NotificationConfig;

  constructor(signer: Signer, relayManager: RelayManager, config?: Partial<NotificationConfig>) {
    this.signer = signer;
    this.relayManager = relayManager;
    this.config = { ...DEFAULT_NOTIFICATION_CONFIG, ...config };
  }

  // ── Send a DM to a specific pubkey ──────────────────────────────────────

  private async sendDM(recipientPubkey: string, message: string): Promise<void> {
    if (!this.config.enabled) return;

    try {
      const now = Math.floor(Date.now() / 1000);

      // NIP-04: kind:4, content is encrypted to the recipient
      const encrypted = await this.signer.nip44Encrypt(message, recipientPubkey);

      const unsigned = {
        kind: 4,
        created_at: now,
        tags: [["p", recipientPubkey]],
        content: encrypted,
      };

      const signed = await this.signer.signEvent(unsigned);
      await this.relayManager.publish(signed);
      console.debug(`[chama] DM sent to ${recipientPubkey.slice(0, 8)}...`);
    } catch (e) {
      // DM failures are non-fatal — log and continue
      console.warn(`[chama] DM failed to ${recipientPubkey.slice(0, 8)}:`, e);
    }
  }

  // ── Notify multiple recipients ──────────────────────────────────────────

  private async notifyMany(pubkeys: string[], message: string): Promise<void> {
    const myPubkey = await this.signer.getPublicKey();
    // Don't DM yourself
    const recipients = pubkeys.filter(pk => pk && pk !== myPubkey);
    await Promise.allSettled(recipients.map(pk => this.sendDM(pk, message)));
  }

  // ── Get all participant pubkeys from state ──────────────────────────────

  private getParticipantPubkeys(state: EscrowState): string[] {
    return [
      state.participants.buyer,
      state.participants.seller,
      state.participants.arbiter,
    ].filter(Boolean) as string[];
  }

  // ══════════════════════════════════════════════════════════════════════════
  // EVENT-SPECIFIC NOTIFICATIONS
  // ══════════════════════════════════════════════════════════════════════════

  /** Notify community arbiters that a new trade was created */
  async onTradeCreated(state: EscrowState): Promise<void> {
    if (!this.config.notifyArbitersOnCreate) return;

    const arbiters = state.communityArbiters || [];
    if (arbiters.length === 0) return;

    const sats = Math.floor(state.amountMsats / 1000).toLocaleString();
    const msg = `🔔 New Chama trade: "${state.description}" (${sats} sats). ` +
      `Join as arbiter → ${state.id}`;

    await this.notifyMany(arbiters, msg);
  }

  /** Notify when someone joins the trade */
  async onParticipantJoined(state: EscrowState, joinerRole: Role): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const filled = pubkeys.length;
    const msg = `✅ ${joinerRole} joined trade "${state.description}" (${filled}/3 participants)`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Notify all participants that ecash is locked */
  async onEscrowLocked(state: EscrowState): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const sats = Math.floor(state.amountMsats / 1000).toLocaleString();
    const msg = `🔒 ${sats} sats locked in escrow "${state.description}". ` +
      `Time to fulfill the trade and vote.`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Nudge non-voters when a vote is cast */
  async onVoteCast(state: EscrowState, voterRole: Role): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const voteCount = Object.keys(state.votes).length;
    const msg = `🗳️ ${voterRole} voted on "${state.description}" (${voteCount}/3 votes). ` +
      `Your vote may be needed.`;

    await this.notifyMany(pubkeys, msg);
  }

  /** Notify everyone that the trade is resolved */
  async onTradeResolved(state: EscrowState): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    // Also notify community arbiters
    const arbiters = state.communityArbiters || [];
    const allRecipients = [...new Set([...pubkeys, ...arbiters])];

    const outcome = state.resolvedOutcome === "release" ? "RELEASE ✓" : "REFUND ↩";
    const msg = `⚖️ Trade "${state.description}" resolved: ${outcome}. ` +
      `Winner can now claim the ecash.`;

    await this.notifyMany(allRecipients, msg);
  }

  /** Notify when readiness is needed */
  async onReadinessNeeded(state: EscrowState): Promise<void> {
    if (!this.config.notifyOnStateChange) return;

    const pubkeys = this.getParticipantPubkeys(state);
    const msg = `⏳ All 3 participants joined "${state.description}". ` +
      `Please confirm you're ready so we can lock the ecash.`;

    await this.notifyMany(pubkeys, msg);
  }
}
