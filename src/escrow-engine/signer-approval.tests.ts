import {EscrowFedimintBridge} from "../fedimint/escrow-bridge.js";
import assert from 'node:assert/strict';
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure';
import { NIP07Signer } from './signers.js';
import { EscrowClient } from './escrow-client.js';
import { SignerApprovalError, isSignerApprovalError, signerAction } from './signer-approval.js';
import { recoverSeedWordsFromEvents } from '../fedimint/seed-manager.js';
import { syncArbiterEarnings } from '../arbiters/arbiter-earnings-sync.js';
import { decryptFromEnvelope } from './envelope.js';
import { EscrowEventKind as K, Role, Outcome, type NostrEvent } from './types.js';
const key = new Uint8Array(32).fill(51), pubkey = getPublicKey(key);
const calls: string[] = [];
let deny = false;
const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
Object.defineProperty(globalThis, 'window', { configurable: true, value: { nostr: {
  getPublicKey: async () => { calls.push('pubkey'); return pubkey; },
  signEvent: async (event: any) => { calls.push('sign'); if (deny) throw Error('nos2x: RAW permission refused'); return finalizeEvent(event, key); },
  nip44: {
    encrypt: async (_peer: string, value: string) => { calls.push('encrypt'); if (deny) throw Error('RAW encryption denied'); return value; },
    decrypt: async (_peer: string, value: string) => { calls.push(`decrypt:${value}`); if (deny) throw Error('RAW decrypt denied'); return value === 'newest' ? mnemonic : '{"type":"escrow:vote"}'; },
  },
  nip04: { decrypt: async () => { calls.push('legacy-decrypt'); return mnemonic; } },
} } });
const signer = new NIP07Signer();
await signer.getPublicKey(); await signer.getPublicKey();
assert.deepEqual(calls, ['pubkey'], 'sign-in only asks for the public key, once');
const client = new EscrowClient(signer, {relays: []});
assert.deepEqual(await syncArbiterEarnings(client), { recovered: 0, published: 0 });
const raw = {pubkey, content: JSON.stringify({encryptedFor: {[pubkey]: 'vote'}})} as NostrEvent;
assert.equal(await (client as any).decryptEventContent(raw), null);
assert.deepEqual(calls, ['pubkey'], 'listing/background reads cannot ask to decrypt');
assert.match(await (client as any).decryptEventContent(raw, true), /escrow:vote/);
assert.equal(calls.filter(c => c.startsWith('decrypt:')).length, 1, 'explicit open decrypts once');
await (client as any).decryptEventContent(raw, true); await (client as any).decryptEventContent(raw);
assert.equal(calls.filter(c => c.startsWith('decrypt:')).length, 1, 'reopen and background reuse successful cached decryption');
const event = (content: string, created_at: number) => ({id:content,content,created_at,pubkey}) as NostrEvent;
const recovered = await recoverSeedWordsFromEvents([event('older', 1),event('newest', 2)], pubkey, signer);
assert.equal(recovered?.event.content, 'newest');
assert.equal(calls.includes('decrypt:older'), false, 'newest successful seed stops lookup before older candidates');
deny = true;
const before = calls.length;
await assert.rejects(recoverSeedWordsFromEvents([event('refused-new', 4),event('refused-old', 3)], pubkey, signer, {delaysMs:[0,0]}), isSignerApprovalError);
assert.deepEqual(calls.slice(before), ['decrypt:refused-new'], 'refusal never tries older events, legacy decryption, or automatic retries');
await assert.rejects(decryptFromEnvelope({encryptedFor:{[pubkey]:'denied'}}, pubkey, pubkey, (ct,pk)=>signer.nip44Decrypt(ct,pk)), isSignerApprovalError, 'envelope helpers must preserve permission failures');
const beforeShare = calls.length;
await assert.rejects((EscrowFedimintBridge.prototype as any).decryptShare.call({signer}, '{}', pubkey), isSignerApprovalError);
assert.deepEqual(calls.slice(beforeShare), ['decrypt:{}'], 'a refused share decrypt is neither retried nor treated as plaintext');
const voteState = { category:'p2p-trade', participants:{[Role.BUYER]:pubkey}, lock:{sharePolicy:'holder-only-v1', shares:new Map([['0',{encryptedFor:{[pubkey]:'vote-share-refused'}}]])}, eventChain:[{kind:K.LOCK,raw:{pubkey}}] };
const beforeVote = calls.length;
await assert.rejects((client as any).buildVoteShareEnvelope(voteState, Role.BUYER, pubkey, Outcome.RELEASE), isSignerApprovalError);
assert.deepEqual(calls.slice(beforeVote), ['decrypt:vote-share-refused'], 'a rejected voting-share request stops before re-encryption or signing');
let published = 0;
(client as any).relayManager.publish = async () => { published++; };
await assert.rejects(client.createEscrow({ category: 'p2p-trade', description:'Rejected creation', amountMsats:1000000, mintUrl:'test-only', arbiterFeeMsats:0, communityArbiters:['ab'.repeat(32)] }), isSignerApprovalError);
assert.equal(published, 0, 'a rejected real CREATE operation publishes nothing');
assert.equal(client.getAllStates().size, 0, 'a refused CREATE does not apply local state');
await assert.rejects(signerAction('sendMessage', () => signer.nip44Encrypt('message', pubkey)), error => {
 assert.ok(error instanceof SignerApprovalError); assert.match(error.message, /sending this message.*Nothing was sent.*Try again/); assert.doesNotMatch(error.message, /RAW|nos2x/); return true;
});
deny = false;
await signer.nip44Decrypt('refused-new', pubkey);
assert.equal(calls.filter(c => c==='decrypt:refused-new').length, 2, 'an explicit retry after refusal works');
console.log('PASS extension approval: pubkey-only sign-in; background/cached reads; newest-first seed; refusal stops prompts; rejected CREATE publishes/applies nothing; plain retry errors');
