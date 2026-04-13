// ══════════════════════════════════════════════════════════════════════════
// Chama — Escrow ↔ Fedimint Bridge
// ══════════════════════════════════════════════════════════════════════════
//
// Glues the EscrowClient (trade protocol on Nostr) to the FedimintClient
// (ecash operations via WASM). Provides the full escrow flow in two
// high-level methods:
//
//   lockAndPublish()  — Spend ecash, SSS split, encrypt shares, publish LOCK
//   claimAndRedeem()  — Decrypt shares, SSS combine, verify, redeem, publish CLAIM
//
// This is the integration layer the UI calls for the money-critical steps.

import { type EscrowClient, type Signer } from "../escrow-engine/escrow-client.js";
import { type FedimintClient, type SSSShare } from "./fedimint-client.js";
import { type EscrowState, Role, Outcome } from "../escrow-engine/types.js";
import { getWinner } from "../escrow-engine/state-machine.js";

// ══════════════════════════════════════════════════════════════════════════
// BRIDGE
// ══════════════════════════════════════════════════════════════════════════

export class EscrowFedimintBridge {
  private escrow: EscrowClient;
  private fedimint: FedimintClient;
  private signer: Signer;

  constructor(escrow: EscrowClient, fedimint: FedimintClient, signer: Signer) {
    this.escrow = escrow;
    this.fedimint = fedimint;
    this.signer = signer;
  }

  // ── Lock: Spend ecash → SSS split → encrypt shares → publish LOCK ──────

  /**
   * Full lock flow:
   *   1. Spend ecash from Fedimint wallet (total trade amount)
   *   2. Split into 2-of-3 SSS shares
   *   3. NIP-44 encrypt each share to its recipient
   *   4. Publish the LOCK event to Nostr relays
   *
   * After this, the money is in escrow — no one can move it alone.
   */
  async lockAndPublish(escrowId: string): Promise<EscrowState> {
    const state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    // Create the SSS lock bundle (spends ecash from wallet)
    const lockBundle = await this.fedimint.createEscrowLock(
      state.amountMsats,
      {
        platformFeeBps: state.fees.platformBps,
        arbiterFeeMsats: state.fees.arbiterMsats,
      }
    );

    // Encrypt each share to its intended recipient
    const buyerPk = state.participants[Role.BUYER]!;
    const sellerPk = state.participants[Role.SELLER]!;
    const arbiterPk = state.participants[Role.ARBITER]!;

    const encryptedShares = await Promise.all([
      this.encryptShare(lockBundle.shares[0], buyerPk),
      this.encryptShare(lockBundle.shares[1], sellerPk),
      this.encryptShare(lockBundle.shares[2], arbiterPk),
    ]);

    // Publish the LOCK event
    return this.escrow.lockEscrow(escrowId, {
      notesHash: lockBundle.notesHash,
      shares: [
        { recipientPubkey: buyerPk, encryptedShare: encryptedShares[0], shareIndex: 0 },
        { recipientPubkey: sellerPk, encryptedShare: encryptedShares[1], shareIndex: 1 },
        { recipientPubkey: arbiterPk, encryptedShare: encryptedShares[2], shareIndex: 2 },
      ],
      sellerReceivesMsats: lockBundle.sellerReceivesMsats,
      arbiterFeeMsats: lockBundle.arbiterFeeMsats,
      platformFeeMsats: lockBundle.platformFeeMsats,
    });
  }

  // ── Claim: Decrypt shares → SSS combine → verify → redeem → publish CLAIM

  /**
   * Full claim flow (winner only):
   *   1. Identify which 2 shares the winner can access
   *      (their own share + the share of a voter who agreed with them)
   *   2. Decrypt both shares
   *   3. Reconstruct the original ecash via SSS combine
   *   4. Verify the hash matches the LOCK event
   *   5. Redeem the ecash into their Fedimint wallet
   *   6. Publish the CLAIM event to Nostr relays
   *
   * After this, the money is in the winner's wallet.
   */
  async claimAndRedeem(escrowId: string): Promise<EscrowState> {
    const state = this.escrow.getState(escrowId);
    if (!state) throw new Error(`Escrow ${escrowId} not loaded`);

    const myPubkey = await this.signer.getPublicKey();
    const winner = getWinner(state);
    if (!winner || winner.pubkey !== myPubkey) {
      throw new Error("You are not the winner of this escrow");
    }

    if (!state.lock.notesHash) {
      throw new Error("No lock data available — escrow may not be fully loaded");
    }

    // Determine which 2 shares we can access:
    // - Our own share (always available)
    // - The share of a voter who voted the same way as the majority
    const myShare = this.getMyEncryptedShare(state, myPubkey);
    const partnerShare = this.getPartnerEncryptedShare(state, myPubkey);

    if (!myShare || !partnerShare) {
      throw new Error("Cannot find 2 accessible shares — state may be incomplete");
    }

    // Decrypt both shares
    const decryptedMyShare = await this.decryptShare(myShare.encryptedShare, myShare.senderPubkey);
    const decryptedPartnerShare = await this.decryptShare(partnerShare.encryptedShare, partnerShare.senderPubkey);

    // Reconstruct and redeem
    const { notesHash } = await this.fedimint.claimEscrow(
      decryptedMyShare,
      decryptedPartnerShare,
      state.lock.notesHash
    );

    // Publish the CLAIM event
    return this.escrow.claim(escrowId, notesHash);
  }

  // ── Pre-claim verification (optional but recommended) ───────────────────

  /**
   * Verify that the shares can reconstruct valid ecash
   * BEFORE actually redeeming. Non-destructive check.
   */
  async verifyClaim(escrowId: string): Promise<{
    valid: boolean;
    amountMsats?: number;
    error?: string;
  }> {
    const state = this.escrow.getState(escrowId);
    if (!state) return { valid: false, error: "Escrow not loaded" };

    const myPubkey = await this.signer.getPublicKey();
    const myShare = this.getMyEncryptedShare(state, myPubkey);
    const partnerShare = this.getPartnerEncryptedShare(state, myPubkey);

    if (!myShare || !partnerShare) {
      return { valid: false, error: "Cannot find 2 accessible shares" };
    }

    try {
      const decMyShare = await this.decryptShare(myShare.encryptedShare, myShare.senderPubkey);
      const decPartnerShare = await this.decryptShare(partnerShare.encryptedShare, partnerShare.senderPubkey);

      return this.fedimint.verifyShares(
        decMyShare,
        decPartnerShare,
        state.lock.notesHash!
      );
    } catch (e) {
      return { valid: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  /** Encrypt an SSS share to a recipient pubkey */
  private async encryptShare(share: SSSShare, recipientPubkey: string): Promise<string> {
    return this.signer.nip44Encrypt(JSON.stringify(share), recipientPubkey);
  }

  /** Decrypt an SSS share from a sender */
  private async decryptShare(encryptedShare: string, senderPubkey: string): Promise<SSSShare> {
    // In dev/plaintext mode, shares are not encrypted — try parsing directly first
    let decrypted: string;
    try {
      const parsed = JSON.parse(encryptedShare);
      if (parsed && (parsed.index !== undefined || parsed.data !== undefined)) {
        // Already plaintext JSON — no decryption needed
        decrypted = encryptedShare;
      } else {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      }
    } catch {
      // Not valid JSON — must be encrypted, decrypt it
      try {
        decrypted = await this.signer.nip44Decrypt(encryptedShare, senderPubkey);
      } catch (decryptErr) {
        // If decrypt also fails, the share might be a simulated plaintext string
        // (from simulatedLock which uses "sim_share_0_..." format)
        console.warn("[chama] Share decrypt failed, using as-is:", encryptedShare.slice(0, 30));
        decrypted = encryptedShare;
      }
    }
    // Try parsing as JSON (real SSS shares are JSON objects)
    try {
      return JSON.parse(decrypted) as SSSShare;
    } catch {
      // Not JSON — simulated or raw share string
      // Wrap it as a minimal SSSShare-like object so downstream code can handle it
      console.warn("[chama] Share is not JSON, wrapping as raw:", decrypted.slice(0, 30));
      return { index: 0, data: decrypted } as unknown as SSSShare;
    }
  }

  /**
   * Get our own encrypted share from the escrow state.
   * The locker encrypted it to our pubkey.
   */
  private getMyEncryptedShare(
    state: EscrowState,
    myPubkey: string
  ): { encryptedShare: string; senderPubkey: string } | null {
    const share = state.lock.shares.get(myPubkey);
    if (!share) return null;

    // The locker's pubkey is whoever published the LOCK event
    const lockEvent = state.eventChain.find(e => e.kind === 38102); // EscrowEventKind.LOCK
    const senderPubkey = lockEvent?.pubkey || state.initiator.pubkey;

    return { encryptedShare: share, senderPubkey };
  }

  /**
   * Get a partner's encrypted share — someone who voted the same as the majority.
   *
   * In the happy path (buyer + seller agree): the winner gets both their
   * own share plus the other agreeing voter's share.
   *
   * In a dispute: the winner gets their share + the arbiter's share
   * (since the arbiter sided with them).
   *
   * The trick: the shares were encrypted to EACH recipient by the locker.
   * So the winner can't directly decrypt another participant's share.
   * Instead, the majority voters need to RE-ENCRYPT their shares to the
   * winner after the vote resolves. This is handled by a share-exchange
   * step that happens after RESOLVE and before CLAIM.
   *
   * For the MVP: we assume the escrow client handles share exchange
   * via NIP-44 DMs between majority voters. The bridge just reads
   * whatever shares are available in state.lock.shares.
   */
  private getPartnerEncryptedShare(
    state: EscrowState,
    myPubkey: string
  ): { encryptedShare: string; senderPubkey: string } | null {
    if (!state.resolvedOutcome || !state.resolvedMajority) return null;

    // Find the other voter in the majority who isn't me
    const myRole = this.getRoleForPubkey(state, myPubkey);
    if (!myRole) return null;

    const partnerRole = state.resolvedMajority.find(r => r !== myRole);
    if (!partnerRole) return null;

    const partnerPubkey = state.participants[partnerRole];
    if (!partnerPubkey) return null;

    // Look for the partner's share (which they re-encrypted to us)
    const share = state.lock.shares.get(partnerPubkey);
    if (!share) return null;

    return { encryptedShare: share, senderPubkey: partnerPubkey };
  }

  private getRoleForPubkey(state: EscrowState, pubkey: string): Role | null {
    if (state.participants[Role.BUYER] === pubkey) return Role.BUYER;
    if (state.participants[Role.SELLER] === pubkey) return Role.SELLER;
    if (state.participants[Role.ARBITER] === pubkey) return Role.ARBITER;
    return null;
  }
}
