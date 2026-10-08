import { translate, getCurrentLang } from "../i18n/index.js";
import { buildWakeIndex } from "./wake-index.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64urlnopad } from "@scure/base";
/** Read-only wake replay: deliberately imports no client, signer or wallet. */
import { nip19, nip44, getPublicKey, verifyEvent } from 'nostr-tools';
import { parseEscrowEvent, sortEventChain } from '../escrow-engine/event-parser.js';
import { replayEventChain } from '../escrow-engine/state-machine.js';
import { needsYouReasonFor } from '../ui/decisions.js';
import { onchainAttention } from '../escrow-engine/onchain-attention.js';
import { joinedListingNotification, newListingNotificationFor, chatNotificationFor, onchainNotificationBody, notificationForTransition, type DmNotifyPref, type TradeNotification } from './trade-notifications.js';
import { Role, EscrowStatus, selectedMenuItemsTotalMsats, type NostrEvent, type EscrowState } from '../escrow-engine/types.js';

export interface WakeSnapshot { pubkey: string; events: NostrEvent[]; relays: string[]; names?: Record<string, string>; settledClaimIds?: string[]; fired?: string[]; dmNotifyPref?: DmNotifyPref; cachedAt?: number; watchTrades?: Record<string, string[]>; watchCommunities?: Record<string, string>; homeCommunity?: string; newListings?: { enabled: boolean; verticals: "all" | string[] }; }
export function wakeNotification(state: EscrowState, previous: EscrowState | null, pubkey: string, names?: Record<string, string>, settledClaimIds?: ReadonlySet<string>): TradeNotification | null {
  const reason = needsYouReasonFor(state, pubkey, undefined, settledClaimIds);
  const action = onchainAttention(state, pubkey);
  if (action && reason) return { escrowId: state.id, title: 'Your trade needs you', body: onchainNotificationBody(state, pubkey, action.text, names), tag: `${state.id}:onchain:${action.key}` };
  const joined = joinedListingNotification(previous, state, pubkey, names);
  if (joined) return joined;
  const transition = notificationForTransition(previous, state, pubkey, undefined, undefined, names);
  if (transition && !(transition.tag.endsWith(':approved') && settledClaimIds?.has(state.id))) return transition;
  if (!reason) return null;
  return {
    escrowId: state.id, title: 'Your trade needs you',
    body: ({ 'funding-refund': 'Take your funding back',
      claim: 'Claim your sats', dispute: 'A dispute needs your reply', vote: 'Confirm the trade',
      'arbiter-key': 'Open the trade to publish your escrow key', waiting: 'A buyer is waiting for you', onchain: 'Open the trade' })[reason],
    tag: `${state.id}:wake:${reason}:${state.eventChain.at(-1)?.raw.id}`,
  };
}

export function selectWakeNotifications(next: Iterable<EscrowState>, old: Map<string, EscrowState>, snapshot: WakeSnapshot, lastWake: number, fired: readonly string[]): TradeNotification[] {
  const seen = new Set([...fired, ...(snapshot.fired ?? [])]);
  return [...next].flatMap(state => {
    const activity = [...state.eventChain, ...state.chatMessages, ...(state.settlements ?? [])];
    const cachedIds = new Set(snapshot.events.map(e => e.id));
    if (!activity.some(e => !cachedIds.has(e.raw.id))) return [];
    const changedTrade = [...state.eventChain, ...(state.settlements ?? [])].some(e => e.kind !== 38108 && !cachedIds.has(e.raw.id));
    const note = changedTrade ? wakeNotification(state, old.get(state.id) ?? null, snapshot.pubkey, snapshot.names, new Set(snapshot.settledClaimIds)) : null;
    const cached = new Set(snapshot.events.map(event => event.id));
    const chats = state.chatMessages.filter(message => !cached.has(message.raw.id))
      .map(message => chatNotificationFor(state, message, snapshot.pubkey, snapshot.dmNotifyPref === 'off' ? 'off' : 'on',
        Math.floor((snapshot.cachedAt ?? lastWake) / 1000)))
      .filter((chat): chat is TradeNotification => !!chat)
      .map(chat => {
        const message = state.chatMessages.find(m => chat.tag.endsWith(m.raw.id))!;
        return { ...chat, sender: snapshot.names?.[message.pubkey] || translate(getCurrentLang(), "notify.partnerFallback"), body: `${snapshot.names?.[message.pubkey] || translate(getCurrentLang(), "notify.partnerFallback")}: ${chat.message}` };
      });
    const root = state.eventChain.find(e => e.kind === 38100);
    const listing = snapshot.newListings?.enabled && root && !root.raw.tags.some(t => t[0] === 'renewal')
      && (snapshot.newListings.verticals === 'all' || snapshot.newListings.verticals.includes(state.category))
      ? newListingNotificationFor(old.get(state.id), state, snapshot.pubkey, snapshot.homeCommunity,
          snapshot.homeCommunity ?? '', Math.floor((snapshot.cachedAt ?? lastWake) / 1000)) : null;
    if (listing) { listing.body = `${snapshot.names?.[state.initiator.pubkey] || 'A seller'}: ${state.description}${state.amountMsats > 0 ? `, ${Math.floor(state.amountMsats / 1000).toLocaleString('en-US')} sats` : ''}`; listing.group = `chama-listings:${state.community}`; }
    return [...(note ? [note] : []), ...chats, ...(listing ? [listing] : [])].filter(note => !seen.has(note.tag));
  });
}

export function replayWake(events: NostrEvent[], pubkey: string, nsec: string,
  /** Creator of each trade this device already holds (trade-identity.ts). */
  creators?: ReadonlyMap<string, string>): Map<string, EscrowState> {
  let secret: Uint8Array | undefined;
  if (nsec) {
    const decoded = nip19.decode(nsec);
    if (decoded.type !== 'nsec' || getPublicKey(decoded.data) !== pubkey) throw Error('Identity changed');
    secret = decoded.data;
  }
  const decrypt = (cipher: string, sender: string) => {
    if (!secret) throw Error('No local decryption key');
    const key = nip44.v2.utils.getConversationKey(secret, sender);
    try { return nip44.v2.decrypt(cipher, key); } finally { key.fill(0); }
  };
  try {
  const groups = new Map<string, ReturnType<typeof sortEventChain>>();
  for (const event of new Map(events.map(e => [e.id, e])).values()) {
    if (!verifyEvent(event)) continue;
    let content = event.content;
    let obj;
    try { obj = JSON.parse(content); } catch { /* legacy ciphertext */ }
    const cipher = obj?.encryptedFor?.[pubkey] ?? (!obj ? content : undefined);
    if (obj?.encryptedFor && !cipher) continue;
    if (cipher) {
      content = decrypt(cipher, event.pubkey);
    }
    if (event.kind === 38108) {
      const payload = JSON.parse(content);
      if (payload.bodyEnvelope) {
        const chatCipher = payload.bodyEnvelope.encryptedFor?.[pubkey];
        if (!chatCipher) continue;
        const body = JSON.parse(decrypt(chatCipher, event.pubkey));
        if (typeof body.message !== 'string') throw Error('Invalid chat body');
        content = JSON.stringify({...payload, message: body.message, attachments: body.attachments});
      }
    }
    const parsed = parseEscrowEvent(event, content);
    if (!parsed.ok) continue;
    const group = groups.get(parsed.event.escrowId) ?? [];
    group.push(parsed.event); groups.set(parsed.event.escrowId, group);
  }
  const result = new Map<string, EscrowState>();
  for (const [id, events] of groups) {
    const replay = replayEventChain(sortEventChain(events), { creator: creators?.get(id) });
    if (!replay.ok) throw Error(`Incomplete trade: ${replay.error.code}`);
    result.set(id, replay.state);
  }
  return result;
  } finally { secret?.fill(0); }
}

/** Inclusive delta cursor keeps events from the snapshot's final second. */
export function wakeFilters(snapshot: WakeSnapshot, tags: readonly string[] = []): Record<string, unknown>[] {
  const since = Math.max(0, Math.floor((snapshot.cachedAt ?? 0) / 1000) - 1);
  if (!tags.length) {
    const ids = [...new Set(snapshot.events.flatMap(e => e.tags.filter(t => t[0] === 'd').map(t => t[1])))];
    return [{ kinds: Array.from({length: 100}, (_, i) => 38100 + i), '#p': [snapshot.pubkey], since },
      ...(ids.length ? [{ '#d': ids, since }] : [])];
  }
  const ids = [...new Set(tags.flatMap(tag => snapshot.watchTrades?.[tag] ?? []))];
  const communities = [...new Set(tags.flatMap(tag => snapshot.watchCommunities?.[tag] ? [snapshot.watchCommunities[tag]] : []))];
  const unknown = tags.filter(tag => !snapshot.watchTrades?.[tag] && !snapshot.watchCommunities?.[tag]);
  return [...(ids.length ? [{ '#d': ids, since }] : []),
    ...(communities.length ? [{ kinds: [38100, 38101], '#community': communities, since }] : []),
    ...(unknown.length ? [{ '#w': unknown, since }] : [])];
}

/** First complete EOSE wins; idle public relays cannot consume the job budget. */
export async function fetchWakeEvents(snapshot: WakeSnapshot, tags: readonly string[] = []): Promise<NostrEvent[]> {
  const filters = wakeFilters(snapshot, tags);
  if (!filters.length) return [];
  const sockets = new Set<WebSocket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let completeEmpty = false;
  try {
    return await Promise.any(snapshot.relays.map((url, index) => new Promise<NostrEvent[]>((resolve, reject) => {
      const socket = new WebSocket(url), events: NostrEvent[] = [];
      sockets.add(socket);
      let fetchingRoots = false, finished = false;
      const end = (error?: Error) => {
        if (finished) return; finished = true;
        clearTimeout(timer); timers.delete(timer); socket.close(); sockets.delete(socket);
        if (!error && events.length === 0) {
          completeEmpty = true;
          if (index > 0) { reject(Error("Empty fallback relay")); return; }
        }
        error ? reject(error) : resolve(events);
      };
      const timer = setTimeout(() => end(Error('Relay timeout')), 10000);
      timers.add(timer);
      socket.onopen = () => socket.send(JSON.stringify(['REQ', 'wake', ...filters]));
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
  } catch { if (completeEmpty) return []; throw Error('No relay replied'); }
  finally { for (const timer of timers) clearTimeout(timer); for (const socket of sockets) socket.close(); }
}

export interface WakeInput { snapshot: WakeSnapshot; nsec: string; lastWake: number; fired: string[]; tags?: string[]; }
/** Never replay unrelated old trades. One invalid affected trade cannot hide
 * a valid JOIN or CHAT on another trade in the same wake. */
export async function runWakeJob(input: WakeInput) {
  const fresh = (await fetchWakeEvents(input.snapshot, input.tags)).filter(e => verifyEvent(e));
  const ids = new Set(fresh.flatMap(e => e.tags.filter(t => t[0] === 'd').map(t => t[1])));
  const old = new Map<string, EscrowState>(), next = new Map<string, EscrowState>();
  const failures: string[] = [];
  for (const id of ids) {
    const belongs = (e: NostrEvent) => e.tags.some(t => t[0] === 'd' && t[1] === id);
    const cached = input.snapshot.events.filter(belongs);
    try { for (const [key, state] of replayWake(cached, input.snapshot.pubkey, input.nsec)) old.set(key, state); }
    catch { /* An incomplete old baseline cannot veto a complete new replay. */ }
    try { for (const [key, state] of replayWake([...cached, ...fresh.filter(belongs)], input.snapshot.pubkey, input.nsec,
      new Map([...old].map(([key, state]) => [key, state.initiator.pubkey])))) next.set(key, state); }
    catch (error) { failures.push(error instanceof Error ? error.message : 'Replay error'); }
  }
  if (failures.length && !next.size) throw Error(failures[0]);
  const watchTags = wakePeerTags(next.values(), input.snapshot.pubkey, input.nsec);
  return { notifications: selectWakeNotifications(next.values(), old, input.snapshot, input.lastWake, input.fired),
    watchTags, snapshotDelta: fresh.filter(e => verifyEvent(e)),
    ...buildWakeIndex([...input.snapshot.events, ...fresh.filter(e => verifyEvent(e))], input.snapshot.homeCommunity),
    result: failures.length ? 'partial replay' : ids.size ? 'replayed' : 'nothing new', affectedTrades: ids.size, failedTrades: failures.length };
}

/** A first community JOIN must seed the exact new peer watches while closed. */
export function wakePeerTags(states: Iterable<EscrowState>, pubkey: string, nsec: string): string[] {
  if (!nsec) return [];
  const decoded = nip19.decode(nsec);
  if (decoded.type !== 'nsec' || getPublicKey(decoded.data) !== pubkey) throw Error('Identity changed');
  const tags = new Set<string>();
  try {
    for (const state of states) {
      if ([EscrowStatus.COMPLETED, EscrowStatus.CANCELLED].includes(state.status)) continue;
      const peers = Object.values(state.participants);
      if (!peers.includes(pubkey)) continue;
      for (const peer of peers) {
        if (!peer || peer === pubkey) continue;
        const key = nip44.v2.utils.getConversationKey(decoded.data, peer);
        try { tags.add(base64urlnopad.encode(hmac(sha256, key, new TextEncoder().encode(`${state.id}:0`))).slice(0, 16)); }
        finally { key.fill(0); }
      }
    }
    return [...tags];
  } finally { decoded.data.fill(0); }
}
