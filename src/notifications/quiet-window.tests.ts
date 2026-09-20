import assert from 'node:assert/strict';
import { notificationWindowAllows } from './quiet-window.js';
import { Role, type EscrowState } from '../escrow-engine/types.js';
const state = { participants: {[Role.BUYER]:'buyer',[Role.SELLER]:'seller',[Role.ARBITER]:null}, communityArbiters:['pool'], eventChain:[], joinHolds:{} } as unknown as EscrowState;
const base = {connectedAt:100, now:102, signedAt:101, state, viewer:'buyer'};
assert.equal(notificationWindowAllows({...base,signedAt:99}),false);
assert.equal(notificationWindowAllows({...base,signedAt:100}),false);
assert.equal(notificationWindowAllows({...base,viewer:'pool'}),false);
assert.equal(notificationWindowAllows(base),true);
assert.equal(notificationWindowAllows({...base,now:111,viewer:'pool'}),true); // window only; transition policy still requires a seat
assert.equal(notificationWindowAllows({...base,connectedAt:Infinity}),false);
console.log('Quiet window: historical, equality, pool-only and seated freshness passed');
