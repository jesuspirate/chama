import { hexToBytes } from '@noble/hashes/utils.js';
import { base64 } from '@scure/base';
import * as btc from '@scure/btc-signer';
import { buildOnchainEscrow } from '../bond-multisig/onchain-escrow.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import type { EsploraFetch } from '../bond-multisig/fund-watcher.js';
import { escrowDepositWindowSafe } from '../bond-multisig/onchain-escrow-funding.js';
import { onchainFunder } from './onchain-funding-terms.js';
import { winnerSettlementChoice } from './onchain-settlement-choice.js';
import { finalArbiterSettlementProof, finalCoopSettlementProof, hasValidSettlementSignatureForRole, observedRefundSpend } from './onchain-settlement-transport.js';
import { getWinner } from './state-machine.js';
import { EscrowStatus, Outcome, Role, type EscrowState } from './types.js';

/** Device observations, never reducer input or signed trade facts. */
export interface OnchainObservation {
  deposit?: 'waiting' | 'seen' | 'confirmed';
  depositSafe?: boolean;
  remainingSats?: number;
  refundAvailable?: boolean;
  refundSpent?: boolean;
  payout?: { txid: string; confirmed: boolean; sats: string; destination: string };
}
export interface OnchainAttention {
  key: string;
  text: string;
  actionable: boolean;
}

/** One source for the attention bar/queue and every notification delivery. */
export function onchainAttention(state: EscrowState, viewer: string, observation?: OnchainObservation): OnchainAttention | null {
  if (state.escrowMode !== 'onchain') return null;
  const role = Object.values(Role).find(r => state.participants[r] === viewer)
    ?? (state.actingArbiter === viewer ? Role.ARBITER : undefined);
  if (!role) return null;
  const funder = onchainFunder(state);
  const principal = role === Role.BUYER || role === Role.SELLER;
  const result = (key: string, text: string, actionable = true) => ({key, text, actionable});
  if (observation?.payout && principal) {
    const p = observation.payout;
    return p.confirmed
      ? result(`confirmed:${p.txid}`, `Payout confirmed · ${Number(p.sats).toLocaleString('en-US')} sats to ${p.destination.slice(0, 12)}…`, false)
      : result(`broadcast:${p.txid}`, `Payout sent · waiting for confirmation · ${p.txid.slice(0, 8)}…`, false);
  }
  if (observation?.refundSpent) return null;
  if (observation?.refundAvailable) return role === funder ? result('refund', 'Your refund is available') : null;
  if (state.status === EscrowStatus.CREATED && state.onchainFundingTerms && role === funder) {
    if (!observation?.deposit) return result('deposit-check', 'Open the trade to check the deposit');
    if (observation?.deposit === 'confirmed') return result('lock', 'Your deposit is confirmed — open the trade to lock it');
    if (observation?.deposit === 'seen') return null;
    const required = Math.floor((state.joinHolds?.buyer?.amountMsats ?? state.amountMsats) / 1000);
    const remaining = observation.remainingSats ?? required;
    return result(remaining < required ? `top-up:${remaining}` : 'deposit', `Send ${remaining.toLocaleString('en-US')}${remaining < required ? ' more' : ''} sats to the escrow address`);
  }
  if (state.status === EscrowStatus.LOCKED) {
    if (funder === Role.SELLER && role === Role.BUYER && state.votes[role] === undefined) {
      if (!observation?.depositSafe) return result('check-deposit', 'Open the trade to check the deposit before paying');
      const fiat = state.fiatAmount && state.fiatCurrency ? `${state.fiatAmount.toFixed(2)} ${state.fiatCurrency}` : 'the payment';
      const method = state.lock.handle?.rail ?? state.paymentMethods?.join(' / ');
      return result('pay', `The seller locked ${Math.floor(state.amountMsats / 1000).toLocaleString('en-US')} sats — pay ${fiat}${method ? ` via ${method}` : ''}, then confirm`);
    }
    const other = funder === Role.BUYER ? Role.SELLER : Role.BUYER;
    if (role === funder && state.votes[other] === Outcome.RELEASE && state.votes[funder] === undefined) {
      return result('confirm-paid', 'Your counterparty says they paid — confirm to release');
    }
  }
  if (state.status !== EscrowStatus.APPROVED || !state.lock.onchain) return null;
  const winner = getWinner(state);
  if (!winner) return null;
  const other = state.resolvedMajority?.includes(Role.ARBITER) ? Role.ARBITER : winner.role === Role.BUYER ? Role.SELLER : Role.BUYER;
  if (role !== winner.role && role !== other) return null;
  const choice = winnerSettlementChoice(state);
  if (!choice) return role === winner.role ? result('choose', 'Choose where your sats go, then sign') : null;
  const terms = state.lock.onchain;
  const escrow = buildOnchainEscrow({...terms, buyerXonly: hexToBytes(terms.buyerXonly), sellerXonly: hexToBytes(terms.sellerXonly), arbiterXonly: hexToBytes(terms.arbiterXonly), network: terms.network === 'mainnet' ? MAINNET : SIGNET});
  const leaf = other === Role.ARBITER ? 'dispute' : 'coop';
  const signed = (signer: Role) => choice.messages.some(m => hasValidSettlementSignatureForRole(m.payload.psbt, escrow, signer, leaf));
  // A crash after the second signature but before broadcast must not strand
  // a fully signed payout with both people told they have nothing left to do.
  if (signed(winner.role) && signed(other)) return result(`send:${choice.id}`, 'Open the trade to send the signed payout');
  if (signed(role)) return null;
  return result(`sign:${choice.id}`, role === winner.role ? 'Sign to receive your sats' : 'Sign the payout to the winner');
}

/** Read only: require the verified final transaction and every spent input
 * before calling a payout sent; a relay COMPLETE alone is not confirmation. */
export async function observeOnchainAttention(state: EscrowState, fetchJson: EsploraFetch): Promise<OnchainObservation> {
  if (state.onchainPayoutTxid && state.onchainPayoutAddress && state.onchainPayoutSats) {
    const status = await fetchJson(`/tx/${state.onchainPayoutTxid}/status`);
    if (typeof status?.confirmed !== 'boolean') throw Error('Invalid payout status');
    return { payout: { txid: state.onchainPayoutTxid, confirmed: status.confirmed,
      sats: state.onchainPayoutSats, destination: state.onchainPayoutAddress } };
  }
  const terms = state.onchainFundingTerms;
  if (!terms) return {};
  const winner = getWinner(state);
  if (state.lock.onchain && winner && winner.role !== Role.ARBITER) {
    for (const message of [...(state.settlements ?? [])].reverse()) {
      const proof = (state.resolvedMajority?.includes(Role.ARBITER) ? finalArbiterSettlementProof : finalCoopSettlementProof)(message, state.lock.onchain, winner.role, state.settlements, winner.pubkey);
      if (!proof) continue;
      const spends = await Promise.all(proof.inputs.map(i => fetchJson(`/tx/${i.txid}/outspend/${i.index}`)));
      if (!spends.every(s => s?.spent && s.txid === proof.txid)) continue;
      const tx = btc.Transaction.fromPSBT(base64.decode(message.payload.psbt), {allowUnknown:true,allowUnknownOutputs:true});
      const network = terms.network === 'mainnet' ? MAINNET : SIGNET;
      const output = tx.getOutput(0);
      const destination = btc.Address(network).encode(btc.OutScript.decode(output.script!));
      return { payout: {txid:proof.txid,confirmed:spends.every(s => s.status?.confirmed === true),sats:output.amount!.toString(),destination} };
    }
  }
  const refunded = await observedRefundSpend(terms, state.settlements ?? [], fetchJson);
  if (refunded) return {refundSpent:true};
  const rows = await fetchJson(`/address/${terms.address}/utxo`);
  if (!Array.isArray(rows)) throw Error('Invalid block explorer response');
  const tip = Number(await fetchJson('/blocks/tip/height'));
  if (!Number.isSafeInteger(tip) || tip < 0) throw Error('Invalid block height');
  const funded = rows.filter(r => r?.status?.confirmed && Number.isSafeInteger(r.value) && r.value > 0);
  const total = funded.reduce((sum, r) => sum + r.value, 0);
  const required = Math.floor((state.joinHolds?.buyer?.amountMsats ?? state.amountMsats) / 1000);
  const received = rows.filter(r => Number.isSafeInteger(r?.value) && r.value > 0).reduce((sum, r) => sum + r.value, 0);
  return {
    remainingSats: Math.max(0, required - received),
    deposit: total >= required ? 'confirmed' : received >= required ? 'seen' : 'waiting',
    depositSafe: total >= required && !!state.lock.onchain
      && funded.some(r => r.txid === state.lock.onchain!.fundingTxid && r.vout === state.lock.onchain!.fundingVout)
      && funded.every(r => Number.isSafeInteger(r.status.block_height))
      && escrowDepositWindowSafe({refundLockUntil:terms.refundLockUntil,fundingHeights:funded.map(r => r.status.block_height),tipHeight:tip,awaitingCounterpayment:true}),
    refundAvailable: total > 0 && tip >= terms.refundLockUntil,
  };
}
