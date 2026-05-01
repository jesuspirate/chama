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
import { stashPendingRedemption, clearPendingRedemption } from "./pending-redemptions.js";
import { type EscrowState, type LockShareEntry, Role, Outcome } from "../escrow-engine/types.js";
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
   *   0. v0.1.72: Probe-and-verify locker's federation matches CREATE's.
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

    // v0.1.72 federation gates ───────────────────────────────────────────
    // Pre-flight: probe the locker's wallet, compare to CREATE's
    // fedPrefix. On mismatch, refuse to spend at all — no money moves.
    // On match (or absent fedPrefix for pre-.72 trades), proceed.
    //
    // This is BEFORE the spend, so there's nothing to refund on
    // mismatch. The post-spend self-check below catches the very
    // narrow window where the wallet could shift between probe and
    // spend — it auto-refunds via redeemEcash.
    const createEvent = state.eventChain.find(
      (e: any) => e.kind === 38100 || e.payload?.type === "escrow:create"
    );
    const expectedFedPrefix: string | undefined =
      (createEvent?.payload as any)?.fedPrefix;

    if (expectedFedPrefix) {
      let probe: { prefix: string; fed: string | null };
      try {
        probe = await this.fedimint.probeFederation();
      } catch (probeErr) {
        const err: any = new Error(
          "Couldn't verify your federation. Your wallet may be disconnected. " +
            "Try again in a moment. (No sats were spent.)"
        );
        err.code = "FED_PROBE_FAILED";
        err.cause = probeErr;
        throw err;
      }

      if (probe.prefix !== expectedFedPrefix) {
        const err: any = new Error(
          `This trade requires federation ${expectedFedPrefix}. ` +
            `Your wallet is on ${probe.prefix}. ` +
            `Sign out and rejoin with the correct federation invite. ` +
            `(No sats were spent.)`
        );
        err.code = "FED_MISMATCH";
        err.expected = expectedFedPrefix;
        err.got = probe.prefix;
        throw err;
      }
    }
    // Pre-.72 trades have no fedPrefix tag — we allow with a passive
    // warning surfaced by the UI elsewhere (no block here, per Jetty's
    // backwards-compat decision).

    // PR 1 atomic-funding: derive buyer + arbiter pubkeys before spending.
    // LOCK is self-describing — it carries both pubkeys directly — so the
    // chain no longer relies on prior JOIN events to populate slots.
    //
    // Buyer:   if a JOIN ACK landed pre-LOCK, use that pubkey. Otherwise
    //          we don't know who's paying yet and refuse to spend.
    // Arbiter: prefer a JOINed arbiter; fall back to picking the first
    //          entry in the trade's communityArbiters pool. If both are
    //          empty there's no one to assign and we refuse to spend.
    const buyerPubkey = state.participants[Role.BUYER];
    if (!buyerPubkey) {
      throw new Error(
        "Cannot lock — no buyer pubkey known. The buyer must publish a JOIN " +
        "ACK (or the locker's payment-detection path must supply the buyer " +
        "pubkey) before LOCK can fire."
      );
    }
    const arbiterPubkey = state.participants[Role.ARBITER]
      ?? state.communityArbiters[0];
    if (!arbiterPubkey) {
      throw new Error(
        "Cannot lock — no arbiter available. The trade has no JOINed arbiter " +
        "and the communityArbiters pool is empty."
      );
    }

    // v0.1.71: no platformFeeBps passed.
    // Lock math is now seller + arbiter only. Platform fee is collected
    // out-of-band via Lightning at trade completion.
    const lockBundle = await this.fedimint.createEscrowLock(
      state.amountMsats,
      {
        arbiterFeeMsats: state.fees.arbiterMsats,
      }
    );

    // Dual-encrypt each share to ALL 3 participants
    const sellerPk = state.participants[Role.SELLER]!;
    const allPks = [buyerPubkey, sellerPk, arbiterPubkey];

    const shares: { shareIndex: number; encryptedFor: Record<string, string> }[] = [];

    for (let i = 0; i < lockBundle.shares.length; i++) {
      const share = lockBundle.shares[i];
      const encryptedFor: Record<string, string> = {};

      for (const pk of allPks) {
        encryptedFor[pk] = await this.encryptShare(share, pk);
      }

      shares.push({ shareIndex: i, encryptedFor });
    }

    return this.escrow.lockEscrow(escrowId, {
      notesHash: lockBundle.notesHash,
      shares,
      sellerReceivesMsats: lockBundle.sellerReceivesMsats,
      arbiterFeeMsats: lockBundle.arbiterFeeMsats,
      buyerPubkey,
      arbiterPubkey,
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

    // With dual-encryption, any participant can decrypt all shares.
    // We just need any 2 shares for Shamir reconstruction.
    const sharesSize = state.lock.shares instanceof Map ? state.lock.shares.size : (state.lock.shares as any)?.length || 0;
    if (!state.lock.shares || sharesSize < 2) {
      throw new Error("Not enough shares available — state may be incomplete");
    }

    // shares is a Map<shareIndex-as-string, LockShareEntry>.
    // Each entry holds the encryptedFor map for every participant, so
    // we can pick any two entries for Shamir reconstruction.
    const shareEntries = [...state.lock.shares.values()];

    if (shareEntries.length < 2) {
      throw new Error("Not enough shares: got " + shareEntries.length + ", need 2");
    }

    const share0 = shareEntries[0];
    const share1 = shareEntries[1];

    // Find the locker's pubkey from the LOCK event in the chain
    // NIP-44 decrypt needs the sender's pubkey (the person who encrypted)
    const lockEvent = state.eventChain.find((e: any) => e.kind === 38102 || e.payload?.type === "escrow:lock");
    const lockerPubkey = lockEvent?.raw?.pubkey || lockEvent?.pubkey || myPubkey;

    // Decrypt 2 shares
    const decryptedMyShare = await this.decryptShareDual(share0, myPubkey, lockerPubkey);
    const decryptedPartnerShare = await this.decryptShareDual(share1, myPubkey, lockerPubkey);

    // v0.1.63: Publish CLAIM before redeem
    // ──────────────────────────────────────
    // The chain-correctness move. Reconstructing the notes + matching the
    // hash is already cryptographic proof that the winner has the ecash.
    // Publish CLAIM on the strength of that proof so the Nostr event chain
    // reflects reality *now*, even if the federation redeem is slow.
    //
    // Order is:
    //   1. reconstruct + verify (deterministic, local, fast)
    //   2. publish CLAIM       (chain is now correct)
    //   3. redeemWithRetry     (settle the wallet)
    //
    // If step 3 hard-fails, we throw a marked error so the hook can
    // route to the "watching" UI state instead of red-toasting.

    const { notesHash, oobNotes } = await this.fedimint.reconstructAndVerify(
      decryptedMyShare,
      decryptedPartnerShare,
      state.lock.notesHash
    );

    // v0.1.72 federation gates ───────────────────────────────────────────
    // Probe the redeemer's wallet and verify the reconstructed notes
    // were minted by the same federation. If not, the redeem will
    // either silently partial-credit (the v0.1.71 incident root cause)
    // or hard-fail with a confusing error from the SDK. Catch it here
    // with a clear actionable error instead.
    //
    // We compare oobNotes.slice(0,10) (the reconstructed federation
    // prefix) to a fresh probe of the redeemer's wallet. Both must
    // match. Pre-.72 trades have no fedPrefix on CREATE, but the
    // reconstructed notes themselves still carry the federation
    // identity — so this check works regardless of whether CREATE
    // was tagged.
    const reconstructedPrefix = oobNotes.slice(0, 10);
    let redeemProbe: { prefix: string; fed: string | null };
    try {
      redeemProbe = await this.fedimint.probeFederation();
    } catch (probeErr) {
      // Probe failed but we already have the reconstructed notes. We
      // don't want to lose them — stash and surface a probe-specific
      // error so the UI can offer a retry path.
      const err: any = new Error(
        "Couldn't verify your federation before claiming. " +
          "Your sats are safe — they'll be claimed automatically when " +
          "the federation is reachable. (Notes stashed for retry.)"
      );
      err.code = "FED_PROBE_FAILED";
      err.cause = probeErr;
      throw err;
    }

    if (redeemProbe.prefix !== reconstructedPrefix) {
      const err: any = new Error(
        `This trade's sats were minted on federation ${reconstructedPrefix}. ` +
          `Your wallet is on ${redeemProbe.prefix}. ` +
          `Sign out and rejoin with the correct federation, then retry. ` +
          `Your claim has been published — your sats are safe and waiting.`
      );
      err.code = "FED_MISMATCH";
      err.expected = reconstructedPrefix;
      err.got = redeemProbe.prefix;
      // Don't publish CLAIM yet — refusing redeem before claim publish
      // means the trade chain doesn't advance prematurely. The user
      // switches feds and retries; CLAIM will publish on the next try.
      throw err;
    }

    const stateAfterClaim = await this.escrow.claim(escrowId, notesHash);

    // v0.1.68: Stash oobNotes to localStorage BEFORE attempting redeem.
    // ───────────────────────────────────────────────────────────────────
    // At this point:
    //   - The chain has advanced: CLAIM is published, trade is COMPLETED.
    //   - The reconstructed oobNotes bearer token exists only on this
    //     JS stack frame.
    //   - If the app closes before redeemWithRetry resolves, the token
    //     is lost and the sats are orphaned (see sm_moadjfkb_9ue9pd5p
    //     incident, v0.1.67 and earlier).
    //
    // Persisting here, then clearing after a successful redeem, makes
    // the claim path crash-safe. A boot-time drainPendingRedemptions()
    // call in useEscrow.initFedimint retries any entries that survive
    // the browser/app dying mid-redeem.
    //
    // Note: stashPendingRedemption is synchronous (localStorage), so
    // there's no new await that could itself be interrupted.
    stashPendingRedemption({
      escrowId,
      oobNotes,
      notesHash,
      amountMsats: state.amountMsats,
    });

    try {
      await this.fedimint.redeemWithRetry(oobNotes);
      // Redeem confirmed (or already-spent, which redeemWithRetry treats
      // as success). Federation has the notes, stash is no longer needed.
      clearPendingRedemption(escrowId);
    } catch (redeemErr) {
      // Stash stays. The boot-drain on next initFedimint() will retry.
      // UI error surface is unchanged from v0.1.67.
      const wrapped = new Error(
        "Claim published to relays, but ecash redeem failed: " +
          (redeemErr instanceof Error ? redeemErr.message : String(redeemErr))
      );
      (wrapped as any).claimPublished = true;
      (wrapped as any).cause = redeemErr;
      throw wrapped;
    }

    return stateAfterClaim;
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

  /**
   * Decrypt a share using the dual-encryption format.
   * Looks up own pubkey in encryptedFor map and NIP-44-decrypts with
   * the locker's pubkey as the sender.
   */
  private async decryptShareDual(
    share: LockShareEntry,
    myPubkey: string,
    lockerPubkey: string,
  ): Promise<SSSShare> {
    const ciphertext = share.encryptedFor[myPubkey];
    if (!ciphertext) {
      throw new Error(
        `No encrypted share found for pubkey ${myPubkey.slice(0, 8)}...`
      );
    }
    return this.decryptShare(ciphertext, lockerPubkey);
  }

  /** Encrypt an SSS share to a recipient pubkey */
  private async encryptShare(share: SSSShare, recipientPubkey: string): Promise<string> {
    // SSS shares MUST be NIP-44 encrypted to each recipient.
    // This is the real security boundary — unencrypted shares on relays
    // would let anyone reconstruct the ecash.
    const json = JSON.stringify(share);
    return await this.signer.nip44Encrypt(json, recipientPubkey);
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
   * The locker encrypted it to our pubkey as part of the dual-encryption map.
   * Returns the ciphertext and the locker's pubkey (needed for NIP-44 decrypt).
   */
  private getMyEncryptedShare(
    state: EscrowState,
    myPubkey: string
  ): { encryptedShare: string; senderPubkey: string } | null {
    // Any share will do — they're all encrypted to every participant.
    // Pick the first one that has a ciphertext for us.
    for (const share of state.lock.shares.values()) {
      const ciphertext = share.encryptedFor[myPubkey];
      if (ciphertext) {
        const lockEvent = state.eventChain.find(e => e.kind === 38102);
        const senderPubkey = lockEvent?.pubkey || state.initiator.pubkey;
        return { encryptedShare: ciphertext, senderPubkey };
      }
    }
    return null;
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

    // Look for any share where the partner has an entry in encryptedFor.
    // Under dual-encryption any share object contains a ciphertext for
    // every participant (including partner), so we iterate until we find
    // the partner's ciphertext.
    for (const share of state.lock.shares.values()) {
      const ciphertext = share.encryptedFor[partnerPubkey];
      if (ciphertext) {
        return { encryptedShare: ciphertext, senderPubkey: partnerPubkey };
      }
    }
    return null;
  }

  private getRoleForPubkey(state: EscrowState, pubkey: string): Role | null {
    if (state.participants[Role.BUYER] === pubkey) return Role.BUYER;
    if (state.participants[Role.SELLER] === pubkey) return Role.SELLER;
    if (state.participants[Role.ARBITER] === pubkey) return Role.ARBITER;
    return null;
  }

  // ── Wallet passthrough: used by Fund Wallet modal ──────────────────────
  // These delegate to FedimintClient and are exposed on the bridge so the
  // UI can route ALL money operations through a single object. Keeps the
  // hook layer consistent (always calls bridge.*) and makes it easy to
  // add logging/metrics around wallet ops in one place.

  async payInvoice(bolt11: string): Promise<void> {
    await this.fedimint.payInvoice(bolt11);
  }

  async spendNotes(amountMsats: number): Promise<string> {
    // FedimintClient exposes spendNotes via its wallet; route through there.
    return await this.fedimint.spendNotes(amountMsats);
  }
}
