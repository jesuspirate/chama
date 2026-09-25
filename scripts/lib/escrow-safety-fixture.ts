/** Signed protocol fixture shared by offline safety tests and Mutinynet. */
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { buildOnchainEscrow, DISPUTE_CSV_BLOCKS } from '../../src/bond-multisig/onchain-escrow.js';
import { SIGNET } from '../../src/bond-multisig/multisig.js';
import { buildBondAnnouncementEvent } from '../../src/bond-multisig/bond-announcement.js';
import { buildCommitmentBond } from '../../src/bond-multisig/commitment-bond.js';
import { EscrowEventKind as Kind, Role, type EscrowPayload, type EscrowState } from '../../src/escrow-engine/types.js';
import { parseEscrowEvent } from '../../src/escrow-engine/event-parser.js';
import { applyEvent } from '../../src/escrow-engine/state-machine.js';

export function safetyFixture(keys: { buyer: Uint8Array; seller: Uint8Array; arbiter: Uint8Array }, height: number, id = '649-safety') {
  const identities = { buyer: new Uint8Array(32).fill(31), seller: new Uint8Array(32).fill(32), arbiter: new Uint8Array(32).fill(33) };
  const pks = { buyer: getPublicKey(identities.buyer), seller: getPublicKey(identities.seller), arbiter: getPublicKey(identities.arbiter) };
  let clock = Math.floor(Date.now() / 1000);
  let state: EscrowState | null = null;
  const events: ReturnType<typeof event>[] = [];
  function event(kind: Kind, role: keyof typeof identities, payload: EscrowPayload, extraTags: string[][] = []) {
    const raw = finalizeEvent({ kind, created_at: clock++, tags: [['d', id], ['t', payload.type],
      ...(state?.eventChain.at(-1) ? [['e', state.eventChain.at(-1)!.raw.id, '', 'reply']] : []), ...extraTags], content: JSON.stringify(payload) }, identities[role]);
    const parsed = parseEscrowEvent(raw, raw.content);
    if (!parsed.ok) throw new Error(parsed.error.message);
    return parsed.event;
  }
  function apply(e: ReturnType<typeof event>) {
    const result = applyEvent(state, e);
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
    state = result.state; events.push(e); return state;
  }
  apply(event(Kind.CREATE, 'seller', { type: 'escrow:create', description: 'On-chain safety test', amountMsats: 100_000_000,
    category: 'p2p-trade', mintUrl: 'test-only', platformFeeBps: 0, platformFeePubkey: pks.seller,
    arbiterFeeMsats: 0, expirySeconds: 86400, createdAt: clock, community: '649-test',
    communityArbiters: [pks.arbiter], bondedArbiters: [pks.arbiter], escrowMode: 'onchain', onchainNetwork: 'signet', escrowXonly: bytesToHex(keys.seller) }));
  apply(event(Kind.JOIN, 'buyer', { type: 'escrow:join', role: Role.BUYER, joinedAt: clock, escrowXonly: bytesToHex(keys.buyer) }));
  const bond = buildCommitmentBond(keys.arbiter, height + 5000, SIGNET);
  const announcement = finalizeEvent(buildBondAnnouncementEvent({ pubkey: pks.arbiter, community: '649-test', ownerXonly: keys.arbiter,
    lockUntil: bond.lockUntil, amountSats: 100_000n, network: SIGNET, address: bond.address }), identities.arbiter);
  const escrow = buildOnchainEscrow({ buyerXonly: keys.buyer, sellerXonly: keys.seller, arbiterXonly: keys.arbiter,
    funder: 'seller', refundLockUntil: height, disputeCsvBlocks: DISPUTE_CSV_BLOCKS, network: SIGNET });
  const terms = { address: escrow.address, buyerXonly: bytesToHex(keys.buyer), sellerXonly: bytesToHex(keys.seller),
    arbiterXonly: bytesToHex(keys.arbiter), funder: 'seller' as const, refundLockUntil: height,
    disputeCsvBlocks: DISPUTE_CSV_BLOCKS, network: 'signet' as const, arbiterBond: announcement };
  return { get state() { return state!; }, events, event, apply, terms, escrow, pks, bond };
}
