import assert from 'node:assert/strict';
import * as btc from '@scure/btc-signer';
import { safetyFixture } from '../../scripts/lib/escrow-safety-fixture.js';
import { buildSettlementPsbt, coSignSettlement } from '../bond-multisig/onchain-escrow-settle.js';
import { SIGNET } from '../bond-multisig/multisig.js';
import { applyEvent } from './state-machine.js';
import { winnerSettlementChoice } from './onchain-settlement-choice.js';
import { EscrowEventKind as Kind, EscrowStatus, Outcome, Role, type EscrowState, type SettlementPayload } from './types.js';

for (const reverse of [false, true]) {
  const keys = { buyer: new Uint8Array(32).fill(11), seller: new Uint8Array(32).fill(12), arbiter: new Uint8Array(32).fill(13) };
  const f = safetyFixture({buyer:btc.utils.pubSchnorr(keys.buyer),seller:btc.utils.pubSchnorr(keys.seller),arbiter:btc.utils.pubSchnorr(keys.arbiter)},2_000_000);
  const winner = reverse ? Role.SELLER : Role.BUYER, other = reverse ? Role.BUYER : Role.SELLER;
  let state: EscrowState = {...f.state,category:reverse?'marketplace':'p2p-trade',status:EscrowStatus.LOCKED,onchainAtomicRelease:true,
    lock:{...f.state.lock,lockedAt:1,onchain:{...f.terms,amountSats:'100000',fundingTxid:'11'.repeat(32),fundingVout:0}}};
  const destination = btc.p2tr(btc.utils.pubSchnorr(new Uint8Array(32).fill(24)),undefined,SIGNET).address!;
  const psbt = buildSettlementPsbt({escrow:f.escrow,utxos:[{txid:'11'.repeat(32),index:0,amountSats:100000n}],destination,feeSats:500n});
  const vote = (role: Role.BUYER | Role.SELLER, payout?: SettlementPayload) => f.event(Kind.VOTE,role,{type:'escrow:vote',role,outcome:Outcome.RELEASE,votedAt:1,...(payout?{onchainRelease:payout}:{})});
  assert.equal(applyEvent(state,vote(winner)).ok,false,'new trades require the destination in the paid vote');
  const paid = vote(winner,{type:'escrow:settlement',psbt,role:winner,leaf:'coop',payoutAddress:destination});
  const accepted = applyEvent(state,paid); assert.ok(accepted.ok); state=accepted.state;
  assert.equal(winnerSettlementChoice(state)?.destination,destination,'destination exists before approval');
  assert.equal(applyEvent(state,vote(other)).ok,false,'cannot confirm without signing');
  assert.equal(applyEvent(state,vote(other,{type:'escrow:settlement',psbt,role:other,leaf:'coop'})).ok,false,'unsigned confirmation rejected');
  assert.equal(applyEvent(state,vote(other,{type:'escrow:settlement',psbt:coSignSettlement(psbt,keys[winner]),role:other,leaf:'coop'})).ok,false,'wrong Bitcoin key rejected');
  const confirming=vote(other,{type:'escrow:settlement',psbt:coSignSettlement(psbt,keys[other]),role:other,leaf:'coop'});
  const result=applyEvent(state,confirming); assert.ok(result.ok);
  assert.equal(result.state.votes[other],Outcome.RELEASE);
  assert.equal(result.state.settlements?.at(-1)?.raw.id,confirming.raw.id,'vote and payout signature are one signed event');
  assert.equal(winnerSettlementChoice(result.state)?.locked,true);
  const legacy=applyEvent({...state,onchainAtomicRelease:undefined},vote(other));
  assert.ok(legacy.ok,'old signed history remains replayable');
}
console.log('PASS atomic on-chain RELEASE: destination with paid, signature with confirm, both principal directions, wrong keys, legacy replay');
