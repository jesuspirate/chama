import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onchainFundingInputsChanged } from './onchain-funding-terms.js';
import { EscrowStatus, Role, type EscrowState } from './types.js';

// Oct 28 mainnet: the funder's "prepare the deposit address" refused with
// "The order changed" because a chat message replaced the state object while
// the seed-backup and bond checks were awaited. Only inputs to the address or
// the funder's JOIN may refuse it.
const base = {
  id: 'e1', status: EscrowStatus.CREATED, escrowMode: 'onchain', onchainNetwork: 'mainnet', community: 'c1',
  amountMsats: 29_400_000, category: 'exchange',
  participants: { [Role.BUYER]: 'b'.repeat(64), [Role.SELLER]: 's'.repeat(64), [Role.ARBITER]: 'a'.repeat(64) },
  escrowKeys: { [Role.BUYER]: '1'.repeat(64), [Role.SELLER]: '2'.repeat(64) },
  joinHolds: { [Role.BUYER]: { role: Role.BUYER, pubkey: 'b'.repeat(64), joinedAt: 1, expiresAt: 2, eventId: 'j', amountMsats: 29_400_000 } },
  communityArbiters: ['a'.repeat(64)], chat: [],
} as unknown as EscrowState;
const copy = (patch: Record<string, unknown> = {}) => ({ ...structuredClone(base), ...patch }) as EscrowState;

assert.equal(onchainFundingInputsChanged(base, copy()), false, 'a new object with the same inputs must not refuse');
assert.equal(onchainFundingInputsChanged(base, copy({ chat: [{ text: 'hi' }] })), false, 'a chat message must not refuse');
assert.equal(onchainFundingInputsChanged(base, null), true);
assert.equal(onchainFundingInputsChanged(base, copy({ status: EscrowStatus.CANCELLED })), true, 'cancel refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ amountMsats: 1 })), true, 'amount refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ onchainNetwork: 'signet' })), true, 'network refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ escrowKeys: { ...base.escrowKeys, [Role.BUYER]: '9'.repeat(64) } })), true, 'buyer key refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ escrowKeys: { ...base.escrowKeys, [Role.ARBITER]: '3'.repeat(64) } })), true, 'arbiter key refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ participants: { ...base.participants, [Role.BUYER]: 'c'.repeat(64) } })), true, 'new buyer refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ participants: { ...base.participants, [Role.ARBITER]: undefined }, communityArbiters: ['d'.repeat(64)] })), true, 'different arbiter refuses');
const unseated = copy({ participants: { ...base.participants, [Role.ARBITER]: undefined } });
assert.equal(onchainFundingInputsChanged(unseated, { ...structuredClone(unseated), communityArbiters: ['d'.repeat(64)] } as EscrowState), true, 'picked arbiter change alone refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ community: 'c2' })), true, 'community refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ escrowKeys: { ...base.escrowKeys, [Role.SELLER]: '8'.repeat(64) } })), true, 'seller key refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ joinHolds: { [Role.BUYER]: { ...base.joinHolds![Role.BUYER]!, expiresAt: 99, eventId: 'j2' } } })), false, 'a rejoin with the same amount does not refuse');
assert.equal(onchainFundingInputsChanged(base, copy({ joinHolds: { [Role.BUYER]: { ...base.joinHolds![Role.BUYER]!, amountMsats: 5 } } })), true, 'order amount refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ onchainFundingTerms: { address: 'x' } })), true, 'terms already published refuses');
assert.equal(onchainFundingInputsChanged(base, copy({ category: 'marketplace' })), true, 'funder change refuses');

// The hook must use the field comparison, not object identity.
const hook = readFileSync(new URL('../hooks/useEscrow.ts', import.meta.url), 'utf8');
const prepare = hook.slice(hook.indexOf('const prepareOnchainFunding'), hook.indexOf('const checkOnchainFunding'));
assert.match(prepare, /onchainFundingInputsChanged\(trade, current\)/);
assert.doesNotMatch(prepare, /current !== trade/);
console.log('onchain-prepare-race: 18 checks passed');
