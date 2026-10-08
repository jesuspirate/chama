import { randomBytes } from 'node:crypto';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { EscrowEventKind } from '../../src/escrow-engine/types.js';

/** Read-only fixtures: fresh keys only, no valid federation, no money events. */
export function makeReplayConflictFixture(baseUrl: string, now = Math.floor(Date.now() / 1000)) {
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Use an HTTP(S) app URL without credentials');
  }
  base.search = ''; base.hash = '';
  const seller = generateSecretKey(), stranger = generateSecretKey();
  const creator = getPublicKey(seller);
  // Deliberately legacy, so both signed CREATEs pass the id parser.
  const tradeId = `sm_${now.toString(36)}_${randomBytes(12).toString('hex')}`;
  const controlId = `sm_${now.toString(36)}_${randomBytes(12).toString('hex')}`;
  const sign = (key: Uint8Array, id: string, at: number, label: string, amountMsats: number) => finalizeEvent({
    kind: EscrowEventKind.CREATE, created_at: at,
    tags: [['d', id], ['t', 'escrow:create'], ['expiration', String(now + 86400)]],
    content: JSON.stringify({ type: 'escrow:create', category: 'p2p-trade',
      description: `6.4.20 READ-ONLY TEST — ${label} — DO NOT FUND`, amountMsats,
      mintUrl: 'replay-fixture:no-wallet', platformFeeBps: 0,
      platformFeePubkey: getPublicKey(key), arbiterFeeMsats: 0,
      paymentMethods: [], expirySeconds: 86400, createdAt: at }),
  }, key);
  const genuine = sign(seller, tradeId, now - 5, 'genuine listing (1 sat)', 1000);
  const forged = sign(stranger, tradeId, now - 125, 'stranger listing (2 sats)', 2000);
  const control = sign(seller, controlId, now - 5, 'unambiguous control (1 sat)', 1000);
  const link = (id: string, by?: string) => {
    const url = new URL(base); url.searchParams.set('trade', id);
    if (by) url.searchParams.set('by', by);
    return url.href;
  };
  // No private keys are returned, persisted, read from storage or printed.
  return { tradeId, creator, genuine, forged, control,
    plainLink: link(tradeId), creatorLink: link(tradeId, creator), controlLink: link(controlId) };
}
