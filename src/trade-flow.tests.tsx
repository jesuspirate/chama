import { RelayManager } from './escrow-engine/relay-manager.js';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { finalizeEvent, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { EscrowClient } from './escrow-engine/escrow-client.js';
import { EscrowStatus as S, EscrowEventKind as K, Role, Outcome, JOIN_HOLD_SECONDS, type EscrowState, type NostrEvent } from './escrow-engine/types.js';
import { canVote } from './escrow-engine/state-machine.js';
import { buildRenewCreateParams } from './escrow-engine/listing-renewal.js';
import { countCounterDemand } from './guided/counter-demand.js';
import { sameCommunity } from './guided/join-eligibility.js';
import { matchGuidedListings } from './guided/match-listings.js';
import { canShowTradeFunding } from './payments/seat-funding.js';
import { assertTradePaymentDetails } from './payments/trade-payment-details.js';
import { EscrowFedimintBridge } from './fedimint/escrow-bridge.js';
import { effectiveCreateFederationId } from './fedimint/federation-config.js';
import { hashNotes } from './fedimint/fedimint-client.js';
import { stashNativeLockIntent, upgradeNativeLockToSpent, getPendingNativeLock } from './fedimint/pending-native-locks.js';
import { addSavedHandle } from './payments/saved-handles.js';
import { AtomicFundingModal } from './ui/panels/AtomicFundingModal.js';
import { BuyerPaymentDetails, TradePaymentDetailsChoice } from './ui/components/TradePaymentDetails.js';
import { BondManageActions } from './ui/components/BondManageActions.js';
import { bondManageActions, assertBondClaimReady } from './bond-multisig/manage-actions.js';
import type { CommitmentRecord } from './bond-multisig/commitment-store.js';
import { buildCommitmentBond } from './bond-multisig/commitment-bond.js';
import { SIGNET } from './bond-multisig/multisig.js';
import { canOfferClaim } from './ui/decisions.js';
import { LangProvider, LANGS } from './i18n/index.js';
import { setSimMode } from './sim/simMode.js';
import { clearEventCache } from './escrow-engine/escrow-event-cache.js';
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k),
} });
const sellerKey = new Uint8Array(32).fill(71), buyerKey = new Uint8Array(32).fill(72), arbiterKey = new Uint8Array(32).fill(73);
const sellerPk = getPublicKey(sellerKey), buyerPk = getPublicKey(buyerKey), arbiterPk = getPublicKey(arbiterKey);
class Relay {
  static all: Relay[] = []; static events: NostrEvent[] = []; static votes: { socket: Relay; event: NostrEvent }[] = [];
  onopen?: (e: Event) => void; onmessage?: (e: MessageEvent) => void;
  constructor(public url: string) { Relay.all.push(this); }
  emit(message: unknown[]) { this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent); }
  ack(event: NostrEvent, accepted: boolean) {
    if (accepted && !Relay.events.some(e => e.id === event.id)) Relay.events.push(event);
    this.emit(['OK', event.id, accepted, accepted ? 'saved' : 'blocked: fixture']);
  }
  send(wire: string) {
    const message = JSON.parse(wire);
    if (message[0] === 'REQ') {
      const filter = message[2];
      queueMicrotask(() => {
        for (const e of Relay.events) if ((!filter.kinds || filter.kinds.includes(e.kind))
          && (!filter['#d'] || e.tags.some(t => t[0] === 'd' && filter['#d'].includes(t[1])))
          && (!filter.authors || filter.authors.includes(e.pubkey))) this.emit(['EVENT', message[1], e]);
        this.emit(['EOSE', message[1]]);
      });
    }
    if (message[0] !== 'EVENT') return;
    const event = message[1] as NostrEvent; assert(verifyEvent(event as any));
    // Deliberately no subscription echo: local delivery must not wait for it.
    if (event.kind === K.VOTE) Relay.votes.push({ socket: this, event });
    else queueMicrotask(() => this.ack(event, true));
  }
  close() {}
}
const previews: EscrowState[] = [];
const clients: EscrowClient[] = [];
function open(key: Uint8Array, observe = false) {
  const client = new EscrowClient({
    getPublicKey: async () => getPublicKey(key), signEvent: async e => finalizeEvent(e, key),
    nip44Encrypt: async value => value, nip44Decrypt: async value => value,
  }, { relays: ['wss://relay.chama.community'], wsImpl: Relay as unknown as typeof WebSocket },
    observe ? { onStateUpdate: (_id, state) => previews.push(state) } : {});
  clients.push(client); client.connect(); Relay.all.at(-1)!.onopen?.({} as Event); return client;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i++) await new Promise(r => setTimeout(r, 1));
  assert(check(), 'expected async transition');
}
const render = (node: React.ReactNode) => renderToStaticMarkup(<LangProvider>{node}</LangProvider>);
setSimMode(true);
await clearEventCache();
const seller = open(sellerKey, true), buyer = open(buyerKey);
try {
  const { escrowId, state: offer } = await seller.createEscrow({
    description: 'Trade-flow regression', category: 'p2p-trade', community: 'global-usd',
    amountMsats: 1_000_000, mintUrl: 'test-only', paymentMethods: ['cash-app'], communityArbiters: [arbiterPk], arbiterFeeMsats: 0,
  });
  const now = Math.floor(Date.now() / 1000);
  const inputs = [
    offer,
    { ...offer, id: 'untagged', community: null },
    { ...offer, id: 'own-seat', initiator: { pubkey: sellerPk, role: Role.SELLER }, participants: { ...offer.participants, seller: buyerPk } },
    { ...offer, id: 'other-fed', mintUrl: 'other-fed' },
    { ...offer, id: 'legacy-seat', participants: { ...offer.participants, buyer: 'other' } },
    { ...offer, id: 'held', participants: { ...offer.participants, buyer: 'other' },
      joinHolds: { buyer: { role: Role.BUYER, pubkey: 'other', joinedAt: now, expiresAt: now + 300, eventId: 'hold' } } },
    { ...offer, id: 'own-hold', participants: { ...offer.participants, buyer: buyerPk },
      joinHolds: { buyer: { role: Role.BUYER, pubkey: buyerPk, joinedAt: now, expiresAt: now + 300, eventId: 'hold' } } },
    { ...offer, id: 'grace', participants: { ...offer.participants, buyer: 'other' },
      joinHolds: { buyer: { role: Role.BUYER, pubkey: 'other', joinedAt: now - 301, expiresAt: now - 1, eventId: 'hold' } } },
    { ...offer, id: 'stale-hold', joinHolds: { buyer: { role: Role.BUYER, pubkey: 'other', joinedAt: now, expiresAt: now + 300, eventId: 'hold' } } },
  ].map(listing => ({ listing }));
  const ctx = { viewerPubkey: buyerPk, community: 'global-usd', mintUrl: 'test-only', nowSec: now };
  const count = countCounterDemand('cash', 'sats', inputs, ctx);
  const matched = matchGuidedListings({ version: 1, direction: 'buy_sats', amountSats: 1000,
    paymentRails: ['cash-app'], community: ctx.community, mintUrl: ctx.mintUrl, strategy: 'available_now' }, inputs, { viewerPubkey: buyerPk, nowSec: now, limit: 20 });
  assert.deepEqual([...count.listingIds].sort(), matched.candidates.map(c => c.listing.id).sort());
  assert.equal(count.count, 3);
  assert.equal(sameCommunity(undefined, 'global-usd'), false);
  assert.equal(sameCommunity(' Global-USD ', 'global-usd'), true);
  assert.equal(canShowTradeFunding(undefined, now * 1000), false);
  assert.equal(canShowTradeFunding(offer, now * 1000), false, 'empty buyer cannot be funded');
  const held = { ...offer, participants: { ...offer.participants, buyer: buyerPk },
    joinHolds: { buyer: { role: Role.BUYER, pubkey: buyerPk, joinedAt: now - 500, expiresAt: now - 200, eventId: 'expired' } } };
  assert.equal(canShowTradeFunding(held, now * 1000), false);
  const closed = render(<AtomicFundingModal escrowId={escrowId} custodyState={held} amountMsats={1_000_000} ctaLabel="Fund"
    fundAndLock={async () => { throw Error('must not fund'); }} lockAndPublish={async () => { throw Error('must not lock'); }}
    supportsOnchain={false} getOnchainInfo={async () => { throw Error('must not prepare'); }} onClose={() => {}} />);
  assert.match(closed, /no longer open/);
  assert.doesNotMatch(closed, /data-funding-rails|textarea|bolt11|Pay within/);
  assert.throws(() => assertTradePaymentDetails(offer, {}), /Add payment details/);
  assertTradePaymentDetails(offer, { paymentDetailsInChat: true });
  const handle = addSavedHandle('cash-app', '$trade-fixture');
  assertTradePaymentDetails(offer, { savedHandleId: handle.id });
  const wrong = addSavedHandle('m-pesa', '+255 700 000 000');
  assert.throws(() => assertTradePaymentDetails(offer, { savedHandleId: wrong.id }), /agreed methods/);
  assert.throws(() => assertTradePaymentDetails(offer, { savedHandleId: 'deleted', paymentDetailsInChat: true }), /agreed methods/);
  const locked = await seller.lockEscrow(escrowId, { notesHash: 'fixture-notes-hash',
    shares: [0, 1, 2].map(shareIndex => ({ shareIndex, encryptedFor: { [buyerPk]: 'share', [sellerPk]: 'share', [arbiterPk]: 'share' } })),
    buyerPubkey: buyerPk, arbiterPubkey: arbiterPk, sellerReceivesMsats: 1_000_000, arbiterFeeMsats: 0,
    handle: handle.handle, rail: handle.rail });
  assert.match(render(<BuyerPaymentDetails state={locked} />), /\$trade-fixture/);
  const buyerState = await buyer.loadEscrow(escrowId, { fullHistory: true });
  assert.equal(buyerState?.lock.handle?.value, '$trade-fixture', 'the buyer decrypts the committed handle');
  const fallback = render(<BuyerPaymentDetails state={{ ...locked, lock: { ...locked.lock, handle: null } }} />);
  assert.match(fallback, /cash-app/); assert.match(fallback, /chat before sending money/);
  assert.match(render(<TradePaymentDetailsChoice state={offer} value="" onChange={() => {}} />), /send payment details in chat/);

  // Legacy native stash options predate paymentDetailsInChat. Resume the real
  // bridge flow: reabsorb the provably unpublished notes, re-spend, and commit
  // a signed LOCK. Missing/deleted handles must not strand existing funding.
  for (const legacyOpts of [{}, { savedHandleId: 'since-deleted-handle' }]) {
    const legacy = await seller.createEscrow({ description: 'Legacy funded resume', category: 'p2p-trade',
      community: 'global-usd', mintUrl: 'test-only', amountMsats: 1_000_000, paymentMethods: ['cash-app'],
      communityArbiters: [arbiterPk], arbiterFeeMsats: 0 });
    await buyer.loadEscrow(legacy.escrowId, { fullHistory: true });
    await buyer.joinEscrow(legacy.escrowId, Role.BUYER);
    await seller.loadEscrow(legacy.escrowId, { fullHistory: true });
    const notes = `fixture-only-legacy-notes-${legacy.escrowId}`;
    let reabsorbs = 0, spends = 0;
    const fed = effectiveCreateFederationId(legacy.state.eventChain[0].payload as any)!;
    const wallet = {
      getFederationId: () => fed, probeReachable: async () => ({ fed }),
      parseNotes: async () => ({ federationId: fed, totalAmount: 1_000_000 }),
      redeemWithRetry: async (saved: string) => { assert.equal(saved, notes); reabsorbs++; },
      spendNotesForLock: async (amount: number, _meta: unknown, onSpent?: (notes: string) => void) => {
        assert.equal(reabsorbs, 1); assert.equal(amount, 1_000_000); spends++; onSpent?.(notes); return { oobNotes: notes };
      },
      buildEscrowLockBundle: async () => ({ notesHash: await hashNotes(notes), totalMsats: 1_000_000,
        sellerReceivesMsats: 1_000_000, arbiterFeeMsats: 0,
        shares: [0, 1, 2].map(index => ({ index, data: 'fixture-only-share' })) }),
    };
    const bridge = new EscrowFedimintBridge(seller, wallet as any, {
      getPublicKey: async () => sellerPk, signEvent: async e => finalizeEvent(e, sellerKey),
      nip44Encrypt: async value => value, nip44Decrypt: async value => value,
    });
    await assert.rejects(bridge.preflightLock(legacy.escrowId, legacyOpts), /payment details/,
      'new funding still requires valid payment details or an explicit chat choice');
    const input = { escrowId: legacy.escrowId, amountMsats: 1_000_000,
      federationId: fed, lockOpts: legacyOpts };
    stashNativeLockIntent(input); upgradeNativeLockToSpent({ ...input, oobNotes: notes });
    const saved = getPendingNativeLock(legacy.escrowId)!;
    assert.equal(saved.stage, 'spent'); assert.equal(saved.lockOpts?.paymentDetailsInChat, undefined);
    setSimMode(false);
    try {
      const resumed = await bridge.lockAndPublish(saved.escrowId, saved.lockOpts);
      assert.equal(resumed.status, S.LOCKED); assert.equal(resumed.lock.notesHash, await hashNotes(notes));
      assert.equal(resumed.lock.handle, null); assert.equal(getPendingNativeLock(saved.escrowId), null);
      assert.equal(reabsorbs, 1); assert.equal(spends, 1);
      const paid = await buyer.loadEscrow(saved.escrowId, { fullHistory: true });
      assert.equal(paid?.status, S.LOCKED);
      assert.match(render(<BuyerPaymentDetails state={paid!} />), /cash-app/);
      assert.match(render(<BuyerPaymentDetails state={paid!} />), /chat before sending money/);
    } finally { setSimMode(true); }
  }

  let vote = seller.vote(escrowId, Outcome.REFUND).then(state => ({ state, error: undefined }), error => ({ state: undefined, error }));
  await until(() => Relay.votes.length === 1);
  const preview = previews.at(-1)!;
  assert(preview.pendingVote); assert.equal(preview.votes.seller, Outcome.REFUND, 'signed vote projects immediately');
  assert.equal(seller.getState(escrowId)?.votes.seller, undefined, 'preview cannot enter committed engine state');
  assert.equal(canOfferClaim(preview), false); assert.equal(canVote(preview, sellerPk).canVote, false);
  Relay.votes[0].socket.ack(Relay.votes[0].event, false);
  const rejected = await vote; assert(rejected.error instanceof Error);
  assert.equal(previews.at(-1)?.pendingVote, undefined); assert.equal(previews.at(-1)?.votes.seller, undefined);
  vote = seller.vote(escrowId, Outcome.REFUND).then(state => ({ state, error: undefined }), error => ({ state: undefined, error }));
  await until(() => Relay.votes.length === 2);
  // No ACK and no echo: the real transport timeout must remove the preview.
  const silent = await vote;
  assert(silent.error instanceof Error);
  assert.equal(previews.at(-1)?.pendingVote, undefined, 'a silent relay cannot leave a vote looking confirmed');
  assert.equal(seller.getState(escrowId)?.votes.seller, undefined);
  // Restore the fake transport after the bounded reconnect attempt.
  Relay.all.at(-1)!.onopen?.({} as Event);
  const previewStart = previews.length;
  vote = seller.vote(escrowId, Outcome.REFUND).then(state => ({ state, error: undefined }), error => ({ state: undefined, error }));
  await until(() => {
    const id = previews.slice(previewStart).filter(state => state.pendingVote).at(-1)?.pendingVote?.eventId;
    return !!id && Relay.votes.some(item => item.event.id === id);
  });
  const pendingId = previews.slice(previewStart).filter(state => state.pendingVote).at(-1)!.pendingVote!.eventId;
  const acceptedVote = Relay.votes.filter(item => item.event.id === pendingId).at(-1)!;
  acceptedVote.socket.ack(acceptedVote.event, true);
  assert.equal((await vote).error, undefined);
  assert.equal(seller.getState(escrowId)?.votes.seller, Outcome.REFUND, 'positive ACK commits without relay echo');
  assert.equal(seller.getState(escrowId)?.status, S.LOCKED, 'one committed vote never authorizes Claim');
  assert.equal(previews.at(-1)?.pendingVote, undefined);

  const old = { ...offer, participants: { ...offer.participants, buyer: buyerPk },
    joinHolds: held.joinHolds, expiresAt: now - 1, listingExpiresAt: now - 1 };
  const replacement = await seller.createEscrow({ ...buildRenewCreateParams(old),
    items: [{ id: 'bracket', label: 'Range', kind: 'exchange-bracket', amountMsats: 1_000_000,
      minAmountMsats: 1_000_000, maxAmountMsats: 5_000_000 }] });
  assert.notEqual(replacement.escrowId, escrowId);
  assert.equal(replacement.state.participants.buyer, null);
  assert.deepEqual(replacement.state.joinHolds, {});
  assert(replacement.state.expiresAt > now);
  await buyer.loadEscrow(replacement.escrowId, { fullHistory: true });
  await assert.rejects(buyer.joinEscrow(replacement.escrowId, Role.BUYER), /Choose an amount/);
  const joined = await buyer.joinEscrow(replacement.escrowId, Role.BUYER, { amountMsats: 2_000_000, orderFinalized: true,
    selectedItems: [{ itemId: 'bracket', label: 'Range', kind: 'exchange-bracket', amountMsats: 2_000_000, quantity: 1,
      minAmountMsats: 1_000_000, maxAmountMsats: 5_000_000 }] });
  assert.equal(joined.joinHolds?.buyer?.expiresAt, joined.joinHolds?.buyer!.joinedAt! + JOIN_HOLD_SECONDS);
  assert.equal(joined.joinHolds?.buyer?.amountMsats, 2_000_000);
  assert.equal(canShowTradeFunding(joined), true);

  const rec: CommitmentRecord = { bondId: 'fixture', bond: buildCommitmentBond(new Uint8Array(32).fill(3), 1000, SIGNET),
    phase: 'locked', amountSats: 100_000n, createdAt: 1 };
  for (const [name, phase, tip, expected] of [
    ['active', 'locked', 900, [true, true, false]],
    ['expiring', 'locked', 999, [true, true, false]],
    ['claimable', 'locked', 1000, [false, true, true]],
    ['reclaimed', 'reclaimed', 1001, [false, true, false]],
  ] as const) {
    const record = { ...rec, phase }; const chain = { tip, unspent: phase === 'locked' };
    const actions = bondManageActions(record, chain);
    assert.deepEqual([actions.announce.enabled, actions.add.enabled, actions.claim.enabled], expected, name);
    for (const action of [actions.announce, actions.claim]) if (!action.enabled) assert(action.reason);
    const html = render(<BondManageActions rec={record} chain={chain} onAnnounce={() => {}} onAdd={() => {}} onClaim={() => {}} />);
    assert.equal((html.match(/<button/g) ?? []).length, 3, name + ': all three actions remain visible');
    assert.match(html, /Announce again/); assert.match(html, /Post an additional bond/);
  }
  assert.throws(() => assertBondClaimReady(rec, null), /not yet confirmed/);
  assert.throws(() => assertBondClaimReady(rec, { tip: 1000, unspent: false }), /not yet confirmed/);
  assert.throws(() => assertBondClaimReady(rec, { tip: 999, unspent: true }), /not yet confirmed/);
  assertBondClaimReady(rec, { tip: 1000, unspent: true });
  for (const lang of LANGS) {
    storage.set('chama_lang', lang);
    assert.doesNotMatch(render(<BuyerPaymentDetails state={locked} />), /trade\.howToPay/);
    assert.doesNotMatch(render(<BondManageActions rec={rec} chain={null} onAdd={() => {}} onClaim={() => {}} />), /bond\.checkChainFirst/);
  }
  const transport = new RelayManager(['wss://duplicate.invalid'], {}, Relay as unknown as typeof WebSocket, { publishTimeoutMs: 100 });
  transport.connect(); Relay.all.at(-1)!.onopen?.({} as Event);
  try {
    const event = finalizeEvent({ kind: K.VOTE, created_at: now, tags: [['d','duplicate-ack']], content: '{}' }, sellerKey);
    const first = transport.publish(event), concurrent = transport.publish(event);
    await until(() => Relay.votes.some(item => item.event.id === event.id));
    const frames = Relay.votes.filter(item => item.event.id === event.id);
    assert.equal(frames.length, 1, 'parallel sends of one signed event share one ACK wait');
    frames[0].socket.ack(event, true);
    assert.equal((await first).accepted, 1); assert.equal((await concurrent).accepted, 1);
  } finally { transport.disconnect(); }
  console.log('PASS trade-flow: matching parity, funding gate, fresh repost and amount, private payment details, signed optimistic vote/rollback/claim isolation, and all bond action states.');
} finally { clients.forEach(client => client.disconnect()); setSimMode(false); await clearEventCache(); }
