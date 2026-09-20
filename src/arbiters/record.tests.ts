import assert from 'node:assert/strict';
import { arbiterRecord } from './record.js';
import { EscrowEventKind as K, Role, Outcome, type EscrowState } from '../escrow-engine/types.js';
const record = arbiterRecord('arb', [], [], new Map(), 1000);
assert.equal(record.healings, 0); assert.equal(record.disputes, 0);
assert.equal(record.lastSeen, null); assert.equal(record.medianResponseSec, null);
assert.equal(record.tenureBlocks, null); assert.equal(record.liveness, null);
assert.equal(record.bondSats, 0n);
const event = (role: Role, timestamp: number, outcome: Outcome) => ({kind: K.VOTE, pubkey: role === Role.ARBITER ? 'arb' : role, timestamp,
  raw: {pubkey: role === Role.ARBITER ? 'arb' : role}, payload: {role, outcome}});
const trade = {id:'one', createdAt:1, expiresAt:900, eventChain:[event(Role.BUYER,100,Outcome.RELEASE),event(Role.SELLER,110,Outcome.REFUND),event(Role.ARBITER,150,Outcome.RELEASE)],votes:{},participants:{[Role.BUYER]:"buyer",[Role.SELLER]:"seller",[Role.ARBITER]:"arb"},lock:{}} as unknown as EscrowState;
const observed = arbiterRecord('arb',[trade,trade],[],new Map(),1000);
assert.equal(observed.disputes,1); assert.equal(observed.medianResponseSec,40); assert.equal(observed.lastSeen,150);
assert.equal(arbiterRecord('arb',[trade],[],new Map(),120).disputes,0);
assert.equal(arbiterRecord('arb',[trade],[],new Map(),120).concentration.rulings,0);
assert.equal(observed.concentration.rulings,1);
console.log('Arbiter record: empty, deduplication, signed response and future cutoff passed');
