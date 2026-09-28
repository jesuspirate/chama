/** Read-only wake replay: deliberately imports no client, signer or wallet. */
import { nip19, nip44, getPublicKey, verifyEvent } from 'nostr-tools';
import { parseEscrowEvent, sortEventChain } from '../escrow-engine/event-parser.js';
import { replayEventChain } from '../escrow-engine/state-machine.js';
import { needsYouReasonFor } from '../ui/decisions.js';
import { onchainAttention } from '../escrow-engine/onchain-attention.js';
import { chatNotificationFor, onchainNotificationBody, notificationForTransition, type DmNotifyPref, type TradeNotification } from './trade-notifications.js';
import type { NostrEvent, EscrowState } from '../escrow-engine/types.js';

export interface WakeSnapshot { pubkey: string; events: NostrEvent[]; relays: string[]; names?: Record<string, string>; settledClaimIds?: string[]; fired?: string[]; dmNotifyPref?: DmNotifyPref; cachedAt?: number; }
export function wakeNotification(state: EscrowState, previous: EscrowState | null, pubkey: string, names?: Record<string, string>, settledClaimIds?: ReadonlySet<string>): TradeNotification | null {
  const reason = needsYouReasonFor(state, pubkey, undefined, settledClaimIds);
  const action = onchainAttention(state, pubkey);
  if (action && reason) return { escrowId: state.id, title: 'Your trade needs you', body: onchainNotificationBody(state, pubkey, action.text, names), tag: `${state.id}:onchain:${action.key}` };
  const transition = notificationForTransition(previous, state, pubkey);
  if (transition && !(transition.tag.endsWith(':approved') && settledClaimIds?.has(state.id))) return transition;
  if (!reason) return null;
  return {
    escrowId: state.id, title: 'Your trade needs you',
    body: ({ claim: 'Claim your sats', dispute: 'A dispute needs your reply', vote: 'Confirm the trade',
      'arbiter-key': 'Open the trade to publish your escrow key', waiting: 'A buyer is waiting for you', onchain: 'Open the trade' })[reason],
    tag: `${state.id}:wake:${reason}:${state.eventChain.at(-1)?.raw.id}`,
  };
}

export function selectWakeNotifications(next: Iterable<EscrowState>, old: Map<string, EscrowState>, snapshot: WakeSnapshot, lastWake: number, fired: readonly string[]): TradeNotification[] {
  const seen = new Set([...fired, ...(snapshot.fired ?? [])]);
  return [...next].flatMap(state => {
    const activity = [...state.eventChain, ...state.chatMessages, ...(state.settlements ?? [])];
    if (!activity.some(e => e.timestamp >= Math.floor(lastWake / 1000))) return [];
    const note = wakeNotification(state, old.get(state.id) ?? null, snapshot.pubkey, snapshot.names, new Set(snapshot.settledClaimIds));
    const cached = new Set(snapshot.events.map(event => event.id));
    const chats = state.chatMessages.filter(message => !cached.has(message.raw.id))
      .map(message => chatNotificationFor(state, message, snapshot.pubkey, snapshot.dmNotifyPref ?? 'auto',
        Math.floor((snapshot.cachedAt ?? lastWake) / 1000)))
      .filter((chat): chat is TradeNotification => !!chat);
    return [...(note ? [note] : []), ...chats].filter(note => !seen.has(note.tag));
  });
}

export function replayWake(events: NostrEvent[], pubkey: string, nsec: string): Map<string, EscrowState> {
  let secret: Uint8Array | undefined;
  if (nsec) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec' || getPublicKey(decoded.data) !== pubkey) throw Error('Identity changed');
    secret = decoded.data;
  }
  const groups = new Map<string, ReturnType<typeof sortEventChain>>();
  for (const event of new Map(events.map(e => [e.id, e])).values()) {
    if (!verifyEvent(event)) continue;
    let content = event.content;
    let obj;
    try { obj = JSON.parse(content); } catch { /* legacy ciphertext */ }
    const cipher = obj?.encryptedFor?.[pubkey] ?? (!obj ? content : undefined);
    if (obj?.encryptedFor && !cipher) continue;
    if (cipher) {
      if (!secret) throw Error('No local decryption key');
      content = nip44.v2.decrypt(cipher, nip44.v2.utils.getConversationKey(secret, event.pubkey));
    }
    const parsed = parseEscrowEvent(event, content);
    if (!parsed.ok) continue;
    const group = groups.get(parsed.event.escrowId) ?? [];
    group.push(parsed.event); groups.set(parsed.event.escrowId, group);
  }
  const result = new Map<string, EscrowState>();
  for (const [id, events] of groups) {
    const replay = replayEventChain(sortEventChain(events));
    if (!replay.ok) throw Error('Incomplete trade');
    result.set(id, replay.state);
  }
  secret?.fill(0);
  return result;
}

/** EOSE, rather than connection/open, is the successful empty-result boundary. */
export async function fetchWakeEvents(snapshot: WakeSnapshot): Promise<NostrEvent[]> {
  const ids = [...new Set(snapshot.events.flatMap(e => e.tags.filter(t => t[0] === 'd').map(t => t[1])))];
  const replies = await Promise.allSettled(snapshot.relays.map(url => new Promise<NostrEvent[]>((resolve, reject) => {
    const socket = new WebSocket(url), events: NostrEvent[] = [];
    let fetchingRoots = false;
    const timer = setTimeout(() => { socket.close(); reject(Error('Relay timeout')); }, 5000);
    const end = (error?: Error) => { clearTimeout(timer); socket.close(); error ? reject(error) : resolve(events); };
    socket.onopen = () => socket.send(JSON.stringify(['REQ', 'wake',
      { kinds: Array.from({length: 100}, (_, i) => 38100 + i), '#p': [snapshot.pubkey] },
      ...(ids.length ? [{ '#d': ids }] : []),
    ]));
    socket.onerror = () => end(Error('Relay unavailable'));
    socket.onmessage = message => {
      try {
        const value = JSON.parse(message.data);
        if (value[1] !== 'wake') return;
        if (value[0] === 'EVENT' && events.length < 10000) events.push(value[2]);
        if (value[0] === 'EOSE') {
          const roots = new Set([...snapshot.events, ...events].filter(e => e.kind === 38100).flatMap(e => e.tags.filter(t => t[0] === 'd').map(t => t[1])));
          const missing = [...new Set(events.flatMap(e => e.tags.filter(t => t[0] === 'd' && !roots.has(t[1])).map(t => t[1])))];
          if (!fetchingRoots && missing.length) {
            fetchingRoots = true;
            socket.send(JSON.stringify(['REQ', 'wake', { '#d': missing }]));
          } else end();
        }
        if (value[0] === 'CLOSED') end(Error('Relay refused query'));
      } catch { end(Error('Invalid relay response')); }
    };
  })));
  const good = replies.filter((r): r is PromiseFulfilledResult<NostrEvent[]> => r.status === 'fulfilled');
  if (!good.length) throw Error('No relay replied');
  return good.flatMap(r => r.value);
}
