#!/usr/bin/env node
// Confirms a Zapstore release actually landed: a signed kind 30063 release
// event for <identifier>@<version> by the publisher in zapstore.yaml.
//
// A quiet zsp run prints nothing on success and also exits 0 when it found
// nothing to do, so "no output" proves nothing. android-release.sh runs this
// after every quiet publish; it can also be run by hand:
//   node scripts/verify-zapstore-release.mjs [--version X.Y.Z] [--since <unix>] [--require-new]
// --require-new (used for --overwrite-zapstore) fails when only an event from
// before --since exists, i.e. the re-publish landed nothing new.
// Exit 0 = found, 1 = not found (or stale), 2 = relay unreachable / bad input.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nip19, verifyEvent } from 'nostr-tools';

export const DEFAULT_RELAY = 'wss://relay.zapstore.dev';

export function publisherHex(yaml) {
  const line = yaml.split('\n').find(l => /^pubkey:\s*/.test(l));
  if (!line) throw new Error('zapstore.yaml has no pubkey');
  const value = line.replace(/^pubkey:\s*/, '').trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase();
  const decoded = nip19.decode(value);
  if (decoded.type !== 'npub') throw new Error('zapstore.yaml pubkey is not an npub');
  return decoded.data;
}

export function applicationId(gradle) {
  const match = gradle.match(/applicationId\s+["']([^"']+)["']/);
  if (!match) throw new Error('No applicationId in android/app/build.gradle');
  return match[1];
}

/** Picks the newest valid release event, or explains why none qualifies. */
export function judge(events, { pubkey, identifier, version, since, requireNew = false, verify = verifyEvent }) {
  const d = `${identifier}@${version}`;
  const matching = events.filter(e => e && e.kind === 30063 && e.pubkey === pubkey
    && (e.tags || []).some(t => t[0] === 'd' && t[1] === d) && verify(e));
  if (!matching.length) return { ok: false, reason: `no signed release event ${d} from the publisher` };
  const newest = matching.reduce((a, b) => (b.created_at > a.created_at ? b : a));
  // Allow a little clock skew between this Mac and the signer. An older event
  // means this run published nothing new (zsp exits 0 when there is nothing
  // to do): the release is live, so report it plainly instead of failing.
  const stale = !!since && newest.created_at < since - 120;
  // A deliberate re-publish (--overwrite-zapstore) exists to replace the
  // release event. If only the old one is there, the re-publish did nothing.
  if (stale && requireNew) {
    return { ok: false, stale, event: newest, reason: `${d} was not re-published: the newest release event is from ${new Date(newest.created_at * 1000).toISOString()}, before this run` };
  }
  return { ok: true, stale, event: newest };
}

export function fetchEvents(relay, filter, timeoutMs = 15000) {
  return new Promise((resolveP, reject) => {
    const events = [];
    let ws;
    const timer = setTimeout(() => { try { ws?.close(); } catch {} reject(new Error('relay timed out')); }, timeoutMs);
    try { ws = new WebSocket(relay); } catch (error) { clearTimeout(timer); reject(error); return; }
    ws.onopen = () => ws.send(JSON.stringify(['REQ', 'verify', filter]));
    ws.onerror = () => { clearTimeout(timer); reject(new Error('relay connection failed')); };
    ws.onmessage = message => {
      let data; try { data = JSON.parse(message.data); } catch { return; }
      if (data[0] === 'EVENT') events.push(data[2]);
      if (data[0] === 'EOSE' || data[0] === 'CLOSED') { clearTimeout(timer); try { ws.close(); } catch {} resolveP(events); }
    };
  });
}

export async function verifyRelease({ relay, pubkey, identifier, version, since, requireNew = false, attempts = 4, delayMs = 5000, fetcher = fetchEvents }) {
  let last = { ok: false, reason: 'not checked' };
  for (let i = 0; i < attempts; i++) {
    if (i) await new Promise(r => setTimeout(r, delayMs));
    let events;
    try { events = await fetcher(relay, { kinds: [30063], authors: [pubkey], '#d': [`${identifier}@${version}`] }); }
    catch (error) { last = { ok: false, unreachable: true, reason: error.message }; continue; }
    last = judge(events, { pubkey, identifier, version, since, requireNew });
    if (last.ok) return last;
  }
  return last;
}

function arg(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  try {
    const root = resolve(fileURLToPath(import.meta.url), '../..');
    const pubkey = publisherHex(readFileSync(arg(args, '--config') ?? resolve(root, 'zapstore.yaml'), 'utf8'));
    const identifier = arg(args, '--identifier') ?? applicationId(readFileSync(resolve(root, 'android/app/build.gradle'), 'utf8'));
    const version = arg(args, '--version') ?? JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
    const since = arg(args, '--since') ? Number(arg(args, '--since')) : undefined;
    const relay = arg(args, '--relay') ?? DEFAULT_RELAY;
    const requireNew = args.includes('--require-new');
    if (requireNew && !since) throw new Error('--require-new needs --since');
    const result = await verifyRelease({ relay, pubkey, identifier, version, since, requireNew });
    if (result.ok) {
      const at = new Date(result.event.created_at * 1000).toISOString();
      console.log(result.stale
        ? `⚠️  Zapstore: ${identifier}@${version} was already published (signed ${at}); this run published nothing new.`
        : `✅ Zapstore: ${identifier}@${version} is published (signed ${at}).`);
    } else {
      console.error(`❌ Zapstore: ${result.reason}${result.unreachable ? ` (${relay})` : ''}.`);
      process.exitCode = result.unreachable ? 2 : 1;
    }
  } catch (error) {
    console.error(`❌ Zapstore check could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
