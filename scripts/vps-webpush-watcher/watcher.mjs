// ══════════════════════════════════════════════════════════════════════════
// Chama A6 — VPS web-push watcher  (brief: design/mockups/chama-a6-vps-webpush-brief.md)
// ══════════════════════════════════════════════════════════════════════════
//
// The one job: stay subscribed to the Chama Nostr band while every client is
// closed, and when a state event carries a registered opaque watch-tag, send an
// EMPTY web-push wake-up to the endpoints that registered it. That's all.
//
// ⭐ THE INVARIANT (non-negotiable): this process learns nothing linkable.
//    It stores only { opaque watch-tag -> [ push endpoint ] }. No pubkey, no
//    escrow id, no amount, no counterparty, no event body — in memory, on disk,
//    or in logs. A subpoena of this box must not answer "who traded with whom".
//    Everything below is written to keep that true; do not add "helpful" logging.
//
// Transport-agnostic by construction: a push endpoint is just a URL, so the same
// store also holds UnifiedPush endpoints for the de-Googled Android follow-on.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import webpush from "web-push";
import { SimplePool, useWebSocketImplementation } from "nostr-tools/pool";
import WebSocket from "ws";

useWebSocketImplementation(WebSocket);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) { console.error(`[watcher] missing required env ${name}`); process.exit(1); }
  return v;
}

// ── Config (all from env; nothing sensitive is hard-coded) ─────────────────
const VAPID_PUBLIC = requireEnv("VAPID_PUBLIC");
const VAPID_PRIVATE = requireEnv("VAPID_PRIVATE");
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:ops@chama.community";
const RELAYS = (process.env.CHAMA_RELAYS || "wss://relay.chama.community")
  .split(",").map(s => s.trim()).filter(Boolean);
const PORT = Number(process.env.PORT || 8890);
const BIND = process.env.BIND || "127.0.0.1"; // behind Caddy; never bind public directly
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "https://getchama.app,https://chama.community")
  .split(",").map(s => s.trim()).filter(Boolean);
const STORE_PATH = process.env.STORE_PATH ||
  path.join(path.dirname(fileURLToPath(import.meta.url)), "registrations.json");

// Chama reserves the whole 38100–38199 protocol band (docs/RELAY_OPERATIONS.md).
const KIND_LO = 38100, KIND_HI = 38199;
const CHAMA_KINDS = Array.from({ length: KIND_HI - KIND_LO + 1 }, (_, i) => KIND_LO + i);

const REG_TTL_MS = 30 * 24 * 3600 * 1000;   // registrations expire after 30 days idle
const COLLAPSE_MS = 5000;                    // one wake per (tag,endpoint) per 5s
const MAX_TAGS_PER_REGISTER = 200;           // abuse cap
const MAX_BODY_BYTES = 16 * 1024;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

// Opaque community wake-tag — identical formula to the client's
// deriveCommunityWakeTag: base64url(sha256("chama:community-wake:v1:"+slug))[:16].
// Lets a CREATE in community X wake everyone watching X, without the watcher
// learning what they want. slug is already public on the relay.
function communityWakeTag(slug) {
  const digest = crypto.createHash("sha256").update(`chama:community-wake:v1:${String(slug).trim().toLowerCase()}`).digest();
  return digest.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}

// ── Store: tag -> Map(endpointKey -> { subscription, expiresAt }) ──────────
const byTag = new Map();
const tagsByEndpoint = new Map();
const lastSent = new Map(); // `${tag} ${endpointKey}` -> ms

function endpointKeyOf(subscription) {
  return String(subscription?.endpoint || "");
}

function addRegistration(subscription, tags) {
  const key = endpointKeyOf(subscription);
  if (!key) return 0;
  const expiresAt = Date.now() + REG_TTL_MS;
  let added = 0;
  const set = tagsByEndpoint.get(key) || new Set();
  for (const tag of tags) {
    let m = byTag.get(tag);
    if (!m) { m = new Map(); byTag.set(tag, m); }
    if (!m.has(key)) added++;
    m.set(key, { subscription, expiresAt });
    set.add(tag);
  }
  tagsByEndpoint.set(key, set);
  return added;
}

function removeRegistration(subscription, tags) {
  const key = endpointKeyOf(subscription);
  if (!key) return;
  const set = tagsByEndpoint.get(key);
  for (const tag of tags) {
    const m = byTag.get(tag);
    if (m) { m.delete(key); if (m.size === 0) byTag.delete(tag); }
    set?.delete(tag);
  }
  if (set && set.size === 0) tagsByEndpoint.delete(key);
}

function pruneEndpoint(key) {
  const set = tagsByEndpoint.get(key);
  if (!set) return;
  for (const tag of set) {
    const m = byTag.get(tag);
    if (m) { m.delete(key); if (m.size === 0) byTag.delete(tag); }
  }
  tagsByEndpoint.delete(key);
}

function expireSweep() {
  const now = Date.now();
  for (const [tag, m] of byTag) {
    for (const [key, rec] of m) {
      if (rec.expiresAt <= now) { m.delete(key); tagsByEndpoint.get(key)?.delete(tag); }
    }
    if (m.size === 0) byTag.delete(tag);
  }
  persist();
}

// ── Persistence (survive restarts). Opaque endpoints + tags only. ──────────
function persist() {
  try {
    const rows = [];
    const seen = new Set();
    for (const m of byTag.values()) {
      for (const [key, rec] of m) {
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ subscription: rec.subscription, tags: [...(tagsByEndpoint.get(key) || [])], expiresAt: rec.expiresAt });
      }
    }
    fs.writeFileSync(STORE_PATH, JSON.stringify({ v: 1, rows }), "utf8");
  } catch (e) { console.warn("[watcher] persist failed:", e.message); }
}

function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return;
    const { rows } = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    const now = Date.now();
    for (const row of rows || []) {
      if (!row?.subscription || row.expiresAt <= now) continue;
      addRegistration(row.subscription, row.tags || []);
    }
    console.log(`[watcher] loaded ${tagsByEndpoint.size} endpoint(s), ${byTag.size} tag(s)`);
  } catch (e) { console.warn("[watcher] load failed:", e.message); }
}

// ── Delivery ───────────────────────────────────────────────────────────────
async function wake(tag) {
  const m = byTag.get(tag);
  if (!m) return;
  const now = Date.now();
  for (const [key, rec] of m) {
    const dedupKey = `${tag} ${key}`;
    if (now - (lastSent.get(dedupKey) || 0) < COLLAPSE_MS) continue;
    lastSent.set(dedupKey, now);
    try {
      // Empty payload = opaque wake. TTL short: a stale wake helps no one.
      await webpush.sendNotification(rec.subscription, "", { TTL: 120, urgency: "high" });
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) pruneEndpoint(key); // dead endpoint
      else console.warn("[watcher] push send error status:", code || "?");
    }
  }
}

// ── Nostr subscription (broad band, match #w locally) ──────────────────────
// Subscribing to the whole band and matching the opaque tag in-process (rather
// than putting thousands of #w values in the filter) is simpler and more robust:
// registrations change constantly, and re-issuing REQs on every change would
// thrash the relay. We only ever MATCH on tags; we never store the event.
const pool = new SimplePool();
let sub = null;

function startNostr() {
  const sinceSec = Math.floor(Date.now() / 1000); // only new transitions
  sub = pool.subscribeMany(RELAYS, [{ kinds: CHAMA_KINDS, since: sinceSec }], {
    onevent(evt) {
      const tags = evt.tags;
      const isParentListingCreate = evt.kind === 38100
        && !tags.some(t => t[0] === "parent" && t[1]);
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (t[0] === "w" && t[1]) void wake(t[1]);
        // S4.2: only a public parent CREATE is a new listing. JOIN/LOCK/chat/
        // settlement events and child purchases also carry community context;
        // waking saved-intent users for those would be noisy and misleading.
        else if (isParentListingCreate && t[0] === "community" && t[1]) {
          void wake(communityWakeTag(t[1]));
        }
      }
    },
    oneose() { /* live tail continues */ },
  });
  console.log(`[watcher] subscribed to ${RELAYS.length} relay(s), kinds ${KIND_LO}-${KIND_HI}`);
}

// ── HTTP API (register / unregister / health) ──────────────────────────────
const buckets = new Map(); // ip -> { tokens, ts }
function rateOk(ip) {
  const now = Date.now();
  const b = buckets.get(ip) || { tokens: 30, ts: now };
  b.tokens = Math.min(30, b.tokens + (now - b.ts) / 1000); // ~1/s refill, burst 30
  b.ts = now;
  if (b.tokens < 1) { buckets.set(ip, b); return false; }
  b.tokens -= 1; buckets.set(ip, b); return true;
}

function cors(res, origin) {
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", c => { n += c.length; if (n > MAX_BODY_BYTES) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function validTags(v) {
  return Array.isArray(v) && v.length > 0 && v.length <= MAX_TAGS_PER_REGISTER &&
    v.every(t => typeof t === "string" && t.length > 0 && t.length <= 64);
}
function validSubscription(s) {
  return s && typeof s.endpoint === "string" && /^https:\/\//.test(s.endpoint);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  cors(res, origin);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, endpoints: tagsByEndpoint.size, tags: byTag.size, relays: RELAYS.length }));
  }

  if (req.method === "POST" && (req.url === "/register" || req.url === "/unregister")) {
    const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").toString().split(",")[0].trim();
    if (!rateOk(ip)) { res.writeHead(429); return res.end("slow down"); }
    let body;
    try { body = await readJson(req); } catch { res.writeHead(400); return res.end("bad body"); }
    if (!validSubscription(body.endpoint) || !validTags(body.tags)) { res.writeHead(400); return res.end("bad fields"); }
    if (req.url === "/register") addRegistration(body.endpoint, body.tags);
    else removeRegistration(body.endpoint, body.tags);
    persist();
    res.writeHead(204); return res.end();
  }

  res.writeHead(404); res.end("not found");
});

// ── Boot ────────────────────────────────────────────────────────────────────
loadStore();
startNostr();
setInterval(expireSweep, 3600 * 1000).unref();
server.listen(PORT, BIND, () => console.log(`[watcher] listening on ${BIND}:${PORT}`));

function shutdown() { try { sub?.close(); } catch {} try { pool.close(RELAYS); } catch {} persist(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
