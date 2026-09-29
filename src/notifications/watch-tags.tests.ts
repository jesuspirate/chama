import assert from 'node:assert/strict';
import { openTradeWatchTags } from './watch-tags.js';
import { deriveWatchTag } from './web-push-client.js';
import { EscrowStatus, Role, type EscrowState } from '../escrow-engine/types.js';
import type { Signer } from '../escrow-engine/escrow-client.js';
const key = new Uint8Array(32).fill(7);
const signer = { getPublicKey: async () => 'buyer', conversationKey: async () => key } as unknown as Signer;
const trade = { id: 'sm_existing', status: EscrowStatus.LOCKED, provenance: 'replayed',
  participants: { [Role.BUYER]: 'buyer', [Role.SELLER]: 'seller', [Role.ARBITER]: null },
  communityArbiters: ['bystander'],
} as unknown as EscrowState;
const expected = [await deriveWatchTag(key, trade.id, 0)];
assert.deepEqual(await openTradeWatchTags(signer, [trade]), expected, 'existing trade needs no own publish');
assert.deepEqual(await openTradeWatchTags(signer, [trade, trade]), expected, 'deduplicated');
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, status: EscrowStatus.COMPLETED }]), []);
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, provenance: 'summary' }]), []);
assert.deepEqual(await openTradeWatchTags({ ...signer, getPublicKey: async () => 'bystander' }, [trade]), [], 'pool membership is not participation');
assert.deepEqual(await openTradeWatchTags({ ...signer, conversationKey: undefined }, [trade]), [], 'no local ECDH');
assert.deepEqual(await openTradeWatchTags(signer, [{ ...trade, status: EscrowStatus.EXPIRED }]), expected, 'expired escrow can still resolve');
console.log('PASS watch existing open participant trades without publishing');
