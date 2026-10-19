// Audit M3: a storefront purchase is written by the buyer, so its money terms
// count only when they are the listing's own.
import assert from 'node:assert/strict';
import { matchingChildren, overcommittedChildren, remainingStock, storefrontChildMismatches } from './storefront.js';
import { EscrowStatus as S, Role, type EscrowState } from './types.js';
const [seller, buyer, arbiter, rogue] = ['a', 'b', 'c', 'd'].map((c) => c.repeat(64));
const now = 1_800_000_000;
const parent = { id: 'listing', category: 'marketplace', amountMsats: 10_000_000, mintUrl: 'fed11listing', stock: 3,
  communityArbiters: [arbiter], participants: { [Role.SELLER]: seller, [Role.BUYER]: null, [Role.ARBITER]: null } } as unknown as EscrowState;
let n = 0;
function child(over: Partial<EscrowState> = {}, qty = 1): EscrowState {
  return { id: `order-${++n}`, parent: parent.id, claimedQuantity: qty, category: 'marketplace', amountMsats: parent.amountMsats * qty,
    mintUrl: 'fed11listing', communityArbiters: [arbiter], status: S.LOCKED, createdAt: now, lock: { lockedAt: now + n }, joinHolds: {},
    participants: { [Role.SELLER]: seller, [Role.BUYER]: buyer, [Role.ARBITER]: arbiter }, ...over } as unknown as EscrowState;
}
const good = child({}, 2);
assert.deepEqual(storefrontChildMismatches(parent, good), []);
assert.deepEqual(storefrontChildMismatches(parent, child({ mintUrl: ' fed11listing ', communityArbiters: [arbiter.toUpperCase(), arbiter] })), [],
  'whitespace, case and repeats are not a change of terms');
const forged: [string, EscrowState][] = [
  ['price', child({ amountMsats: 1_000 })],
  ['price', child({ amountMsats: parent.amountMsats }, 3)],
  ['federation', child({ mintUrl: 'fed11buyers-own' })],
  ['arbiters', child({ communityArbiters: [rogue] })],
  ['arbiters', child({ communityArbiters: [arbiter, rogue] })],
  ['arbiters', child({ communityArbiters: [] })],
  ['seller', child({ participants: { [Role.SELLER]: rogue, [Role.BUYER]: buyer, [Role.ARBITER]: arbiter } as EscrowState['participants'] })],
  ['category', child({ category: 'p2p-trade' })],
];
for (const [what, c] of forged) assert(storefrontChildMismatches(parent, c).includes(what), `a buyer-written ${what} is caught`);
// A forged order neither holds nor sells a unit, and is never "oversold".
const all = [good, ...forged.map(([, c]) => c)];
assert.deepEqual(matchingChildren(parent, all).map((c) => c.id), [good.id]);
assert.equal(remainingStock(parent, all, now), 1, 'only the matching order counts against stock');
assert.deepEqual(overcommittedChildren(parent, [good, child({}, 1), child({ amountMsats: 1 }, 1)]).map((c) => c.id), [],
  'a forged order cannot push a real one over the stock line');
// Circle shares and tranche children have their own checks.
assert.deepEqual(storefrontChildMismatches(parent, child({ chamaPolicy: 'share-v1', amountMsats: 1 })), []);
assert.deepEqual(storefrontChildMismatches(parent, child({ trancheChild: {} as EscrowState['trancheChild'], amountMsats: 1 })), []);
// A legacy order with no unit count is one unit at the listing's price.
assert.deepEqual(storefrontChildMismatches(parent, child({ claimedQuantity: undefined })), []);
console.log('PASS M3: storefront orders count only on the listing\'s own price, federation, arbiters and seller');
