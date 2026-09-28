import assert from 'node:assert/strict';
import { tradeClock, tradeClockText } from './trade-clock.js';
import { preLockDeadline } from './decisions.js';
import { EscrowStatus, Role, Outcome, type EscrowState } from '../escrow-engine/types.js';
const now = 2_000_000_000;
const created = {status: EscrowStatus.CREATED, category: 'p2p-trade', expiresAt: now + 9000,
  participants: {buyer:'buyer',seller:'seller',arbiter:'arbiter'},
  joinHolds: {buyer:{pubkey:'buyer',joinedAt:now-60,expiresAt:now+300}},
  lock: {lockedAt:null}, eventChain: [], votes:{}} as unknown as EscrowState;
assert.equal((tradeClock(created, now) as {at:number}).at, preLockDeadline(created, now)?.at);
const locked = {...created, status:EscrowStatus.LOCKED, expiresAt: now+5220, lock:{...created.lock,lockedAt:now-60}};
assert.equal(tradeClockText(tradeClock(locked, now)!, now, ()=>'Bestie'), 'Bestie has 1h 27m to pay');
assert.deepEqual(tradeClock(locked, now), tradeClock(JSON.parse(JSON.stringify(locked)), now), 'all devices replay the same clock');
assert.equal(tradeClock({...locked,votes:{buyer:Outcome.RELEASE}}, now)?.kind,'confirm');
const terms={funder:'seller',refundLockUntil:10000,disputeCsvBlocks:144};
const chain={...created,escrowMode:'onchain',onchainFundingTerms:terms} as EscrowState;
assert.equal(tradeClock(chain,now,{deposit:'seen'})?.kind,'confirmation');
const refund=tradeClock({...chain,status:EscrowStatus.APPROVED},now,{tipHeight:5824});
assert.equal(tradeClockText(refund!,now,()=>''),'Refund possible from block 10000 (≈ 29 days)');
assert.equal(tradeClockText(tradeClock({...chain,status:EscrowStatus.APPROVED},now)!,now,()=>''),'Refund possible from block 10000','unknown tip never invents a time estimate');
assert.equal(tradeClock({...locked,status:EscrowStatus.COMPLETED},now),null);
console.log('PASS shared trade clock: signed hold, lock/payment, confirm, confirmation, refund, unknown tip, identical replay');
const disputeAt=now-100;
const votes=[{kind:38103,payload:{role:Role.BUYER,outcome:Outcome.RELEASE},raw:{created_at:disputeAt}},
  {kind:38103,payload:{role:Role.SELLER,outcome:Outcome.REFUND},raw:{created_at:disputeAt}}] as EscrowState['eventChain'];
const disputed={...locked,eventChain:votes,votes:{buyer:Outcome.RELEASE,seller:Outcome.REFUND}};
assert.equal(tradeClock(disputed,now)?.kind,'dispute');
assert.deepEqual(tradeClock(disputed,now),tradeClock({...disputed,eventChain:[...votes].reverse()},now));
assert.equal(tradeClock({...disputed,onchainFundingTerms:terms} as EscrowState,now,{fundingHeight:5000,tipHeight:5100})?.kind,'appeal');
