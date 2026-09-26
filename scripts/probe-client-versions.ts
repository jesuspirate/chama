/** Count recent escrow-event client tags independently on each relay.
 * Read-only: npx tsx scripts/probe-client-versions.ts [days] [wss://relay ...]
 * A relay may cap results; counts are a sampled view, not unique fleet devices.
 */
import WebSocket from "ws";
import { DEFAULT_RELAYS } from "../src/escrow-engine/default-relays.js";

const argDays = process.argv[2] && !process.argv[2].startsWith("wss://") ? Number(process.argv[2]) : 7;
if (!Number.isInteger(argDays) || argDays < 1 || argDays > 90) {
  console.error("Usage: npx tsx scripts/probe-client-versions.ts [days 1-90] [wss://relay ...]");
  process.exit(1);
}
const relayArgs = process.argv.slice(process.argv[2]?.startsWith("wss://") ? 2 : 3);
const relays = [...new Set([...DEFAULT_RELAYS, ...relayArgs])];
const since = Math.floor(Date.now() / 1000) - argDays * 86_400;
const kinds = [...Array.from({ length: 17 }, (_, i) => 38100 + i), 38135];
const LIMIT = 5000;
const TIMEOUT_MS = 10_000;

type Sample = { relay: string; counts: Map<string, number>; total: number; eose: boolean; error?: string };
function probe(relay: string): Promise<Sample> {
  return new Promise(resolve => {
    const counts = new Map<string, number>();
    const ids = new Set<string>();
    let socket: WebSocket | undefined;
    let settled = false;
    let eose = false;
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { /* already closed */ }
      resolve({ relay, counts, total: ids.size, eose, ...(error ? { error } : {}) });
    };
    const timer = setTimeout(() => finish("timeout"), TIMEOUT_MS);
    try { socket = new WebSocket(relay); }
    catch (error) { finish(String(error)); return; }
    socket.on("open", () => socket?.send(JSON.stringify(["REQ", "chama-client-probe", { kinds, since, limit: LIMIT }] )));
    socket.on("message", raw => {
      let msg: unknown;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (!Array.isArray(msg)) return;
      if (msg[0] === "EOSE") { eose = true; finish(); return; }
      if (msg[0] === "CLOSED") { finish(String(msg[2] ?? "closed by relay")); return; }
      if (msg[0] !== "EVENT" || typeof msg[2] !== "object" || msg[2] === null) return;
      const event = msg[2] as { id?: unknown; kind?: unknown; created_at?: unknown; tags?: unknown };
      if (typeof event.id !== "string" || ids.has(event.id)
        || typeof event.kind !== "number" || !kinds.includes(event.kind)
        || typeof event.created_at !== "number" || event.created_at < since) return;
      ids.add(event.id);
      const tag = Array.isArray(event.tags) ? event.tags.find((entry: unknown) => Array.isArray(entry) && entry[0] === "client") : undefined;
      const key = !tag ? "untagged"
        : Array.isArray(tag) && tag[1] === "chama" && typeof tag[2] === "string" && tag[2].trim()
          ? `chama/${tag[2]}` : "other/invalid tag";
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
    socket.on("error", error => finish(error.message));
    socket.on("close", () => finish(eose ? undefined : "closed before EOSE"));
  });
}

console.log(`Chama client tags — last ${argDays} days, up to ${LIMIT} recent events per relay`);
for (const sample of await Promise.all(relays.map(probe))) {
  console.log(`\n${sample.relay}: ${sample.total} events${sample.error ? ` (${sample.error})` : ""}`);
  for (const [key, count] of [...sample.counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${key}: ${count} (${(count / sample.total * 100).toFixed(1)}%)`);
  }
}
