import { hexToBytes } from "@noble/hashes/utils.js";
import { buildCommitmentBond } from "../bond-multisig/commitment-bond.js";
import { pickPreferredArbiter } from "../arbiters/pool.js";
import { Role, getEffectiveParticipantAt, type EscrowState, type OnchainFundingTerms, type OnchainLockTerms } from './types.js';
import { resolveFundingPlan } from '../bond-multisig/onchain-escrow-funding.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import { parseBondAnnouncementEvent } from '../bond-multisig/bond-announcement.js';
import { DISPUTE_CSV_BLOCKS } from '../bond-multisig/onchain-escrow.js';

export function fundingArbiter(state: EscrowState): string | null {
  return state.participants[Role.ARBITER] ?? pickPreferredArbiter(state.communityArbiters, state.bondedArbiters,
    state.id, [state.participants[Role.BUYER], state.participants[Role.SELLER]]) ?? null;
}

export function onchainFunder(state: EscrowState): Role.BUYER | Role.SELLER {
  return state.category === 'marketplace' || state.chamaPolicy ? Role.BUYER : Role.SELLER;
}

/** Pure replay gate. A funder's signature cannot attest somebody else's key.
 * Bond ownership is signature-verified here; live bond/deposit verification is
 * performed separately by each client before it displays funded status. */
export function fundingTermsError(state: EscrowState, terms: OnchainFundingTerms, at: number): string | null {
  try {
    if (state.escrowMode !== 'onchain') return 'Not an on-chain trade';
    if (terms.network !== (state.onchainNetwork ?? 'mainnet')) return 'Wrong Bitcoin network';
    if (terms.funder !== onchainFunder(state)) return 'Wrong funder';
    if (terms.disputeCsvBlocks !== DISPUTE_CSV_BLOCKS) return 'Wrong dispute delay';
    for (const role of [Role.BUYER, Role.SELLER] as const) {
      if (!getEffectiveParticipantAt(state, role, at)) return `Missing ${role}`;
      if (!state.escrowKeys?.[role] || terms[`${role}Xonly`] !== state.escrowKeys[role]) return `Unpublished ${role} key`;
    }
    const arbiter = fundingArbiter(state);
    if (!arbiter) return 'Missing arbiter';
    if (state.escrowKeys?.[Role.ARBITER]) {
      if (terms.arbiterXonly !== state.escrowKeys[Role.ARBITER]) return 'Unpublished arbiter key';
    } else {
      const bond = terms.arbiterBond && parseBondAnnouncementEvent(terms.arbiterBond);
      if (!bond || bond.npub !== arbiter || bond.community !== state.community
        || bond.network !== terms.network || bond.ownerXonly !== terms.arbiterXonly
        || !bond.roles.includes('arbiter')) return 'Unverified arbiter bond key';
      const rebuiltBond = buildCommitmentBond(hexToBytes(bond.ownerXonly), bond.lockUntil,
        terms.network === 'signet' ? SIGNET : MAINNET);
      if (rebuiltBond.address !== bond.address) return 'Arbiter bond descriptor does not reproduce';
    }
    const plan = resolveFundingPlan({ ...terms, network: terms.network === 'signet' ? SIGNET : MAINNET });
    if (!plan.ready || plan.address !== terms.address) return 'Address does not match published keys and terms';
    return null;
  } catch { return 'Invalid funding terms'; }
}

export function onchainLockError(state: EscrowState, terms: OnchainLockTerms, at: number): string | null {
  const committed = state.onchainFundingTerms;
  if (!committed) return 'Funding terms were not published before LOCK';
  const error = fundingTermsError(state, committed, at);
  if (error) return error;
  for (const key of ['address', 'buyerXonly', 'sellerXonly', 'arbiterXonly', 'funder', 'refundLockUntil', 'disputeCsvBlocks', 'network'] as const) {
    if (terms[key] !== committed[key]) return `LOCK changed ${key}`;
  }
  if (!/^\d+$/.test(terms.amountSats) || BigInt(terms.amountSats) * 1000n < BigInt(state.amountMsats)) return 'Insufficient deposit amount';
  return null;
}
