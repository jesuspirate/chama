import { base64 } from '@scure/base';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import * as btc from '@scure/btc-signer';
import { buildOnchainEscrow } from '../bond-multisig/onchain-escrow.js';
import { verifySettlementPsbt } from '../bond-multisig/onchain-escrow-settle.js';
import { MAINNET, SIGNET } from '../bond-multisig/multisig.js';
import { payoutRecipientFor } from './recipients.js';
import { EscrowStatus, Outcome, Role, type EscrowState, type ParsedEscrowEvent, type SettlementPayload, type VotePayload } from './types.js';
import { hasValidSettlementSignatureForRole, settlementUnsignedId } from './onchain-settlement-transport.js';

export function settlementWinner(state: EscrowState) {
  return payoutRecipientFor(state, state.resolvedOutcome ?? Outcome.RELEASE);
}

/** Select only a winner-authored transaction. Once another required signer
 * signs it, a newer destination cannot replace it. Live actions separately
 * verify current UTXOs, fee bounds and dispute maturity before signing. */
export function winnerSettlementChoice(state: EscrowState) {
  const terms = state.lock.onchain, winner = settlementWinner(state);
  if (!terms || !winner || (winner.role !== Role.BUYER && winner.role !== Role.SELLER)) return null;
  const network = terms.network === 'mainnet' ? MAINNET : SIGNET;
  const escrow = buildOnchainEscrow({...terms, buyerXonly:hexToBytes(terms.buyerXonly),
    sellerXonly:hexToBytes(terms.sellerXonly),arbiterXonly:hexToBytes(terms.arbiterXonly),network});
  if (escrow.address !== terms.address) return null;
  const arbitrated = (state.settlementStalled || state.resolvedMajority?.includes(Role.ARBITER));
  const leaf = arbitrated ? 'dispute' : 'coop';
  const wireLeaf = arbitrated ? 'arbiter' : 'coop';
  const otherRole = arbitrated ? Role.ARBITER : winner.role === Role.BUYER ? Role.SELLER : Role.BUYER;
  const fallback = btc.p2tr(hexToBytes(winner.role === Role.BUYER ? terms.buyerXonly : terms.sellerXonly),undefined,network).address!;
  const messages = (state.settlements ?? []).filter(m => m.payload.leaf === wireLeaf);
  const seen = new Set<string>();
  let latest = null as null | { id:string; destination:string; locked:boolean; messages:typeof messages; proposal:typeof messages[number] };
  for (const proposal of messages) {
    if (proposal.pubkey !== winner.pubkey || proposal.payload.role !== winner.role) continue;
    try {
      const id = settlementUnsignedId(proposal.payload.psbt);
      if (seen.has(id)) continue;
      const destination = proposal.payload.payoutAddress || fallback;
      if (state.settlementStalled && destination !== state.settlementStalled.destination) continue;
      const tx = btc.Transaction.fromPSBT(base64.decode(proposal.payload.psbt),{allowUnknown:true,allowUnknownOutputs:true});
      const utxos = Array.from({length:tx.inputsLength},(_,i)=>{
        const input=tx.getInput(i);
        if (!input.txid || input.index === undefined || !input.witnessUtxo) throw Error('Incomplete input');
        return {txid:bytesToHex(input.txid),index:input.index,amountSats:input.witnessUtxo.amount};
      });
      if (!utxos.some(u=>u.txid===terms.fundingTxid && u.index===terms.fundingVout)) continue;
      if (!verifySettlementPsbt(proposal.payload.psbt,{escrow,utxos,destination,network,leaf,
        maxFeeSats:utxos.reduce((s,u)=>s+u.amountSats,0n)}).ok) continue;
      seen.add(id);
      const group=messages.filter(m=>{try{return settlementUnsignedId(m.payload.psbt)===id;}catch{return false;}});
      const locked=group.some(m=>hasValidSettlementSignatureForRole(m.payload.psbt,escrow,otherRole,leaf));
      latest={id,destination,locked,messages:group,proposal};
      if (locked) return latest;
    } catch { /* Invalid traffic cannot replace or freeze a valid proposal. */ }
  }
  return latest;
}

export function assertWinnerMayChoose(state: EscrowState, pubkey: string, destination: string): void {
  if (settlementWinner(state)?.pubkey !== pubkey) throw Error('Only the winner can choose where the sats go.');
  const choice=winnerSettlementChoice(state);
  if (choice?.locked && choice.destination!==destination) throw Error('The other signer has already signed. The payout destination cannot change.');
}

/** Only the winner's per-trade output belongs to the recovery wallet. */
export function payoutUsesTradeKey(state: EscrowState): boolean {
  const terms = state.lock.onchain, winner = settlementWinner(state);
  if (!terms || !winner || winner.role === Role.ARBITER) return false;
  const destination = state.onchainPayoutAddress ?? winnerSettlementChoice(state)?.destination;
  if (!destination) return true; // Older trades without a direct choice.
  const key = winner.role === Role.BUYER ? terms.buyerXonly : terms.sellerXonly;
  return destination === btc.p2tr(hexToBytes(key), undefined, terms.network === 'mainnet' ? MAINNET : SIGNET).address;
}

/** Projection of the payout carried by a signed vote, never a second event. */
export function voteSettlement(event: ParsedEscrowEvent<VotePayload>): ParsedEscrowEvent<SettlementPayload> | null {
  return event.payload.onchainRelease ? { ...event, payload: event.payload.onchainRelease } : null;
}

export function atomicReleaseError(state: EscrowState, event: ParsedEscrowEvent<VotePayload>): string | null {
  const p = event.payload;
  if (!state.lock.onchain || p.outcome !== Outcome.RELEASE || p.role === Role.ARBITER) {
    return p.onchainRelease ? 'Payout signature is only valid on a principal on-chain RELEASE.' : null;
  }
  const message = voteSettlement(event);
  if (!message) return state.onchainAtomicRelease ? 'Choose or sign the payout before confirming.' : null;
  if (message.payload.role !== p.role || message.payload.leaf !== 'coop' || message.payload.final)
    return 'The vote must carry this participant’s cooperative payout.';
  const winner = settlementWinner(state);
  const choice = winnerSettlementChoice({ ...state, settlements: [...(state.settlements ?? []), message] });
  if (!winner || !choice || choice.id !== settlementUnsignedId(message.payload.psbt)) return 'The payout does not match the winner’s verified choice.';
  if (p.role !== winner.role && !choice.locked) return 'Confirming requires a valid Bitcoin signature from the releasing participant.';
  return null;
}
