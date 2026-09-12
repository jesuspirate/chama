// Fee-sponsor OWNERSHIP across devices. RESEARCH.
//
// Decision implemented: separate, non-overlapping sponsor coins per device. Each device
// has its own sponsor key (derived from a device index) and its own authoritative
// database. Coins are registered to exactly one device; a device can only reserve its
// own. A database that records another device id refuses to open. This covers
// accidental cross-device reuse. It does NOT coordinate deliberately cloned devices,
// and it does NOT enforce a combined cap across devices; see the negative row.
import { DatabaseSync } from "node:sqlite";
import { HDKey } from "@scure/bip32";
import { sha256 } from "@noble/hashes/sha2.js";
import { keypair, type Keypair, type Outpoint, type Rpc } from "./lib.js";

export function deviceSponsorKey(seed: Uint8Array, deviceIndex: number): Keypair {
  const root = HDKey.fromMasterSeed(sha256(seed));
  const k = root.derive(`m/86'/1'/1337'/${deviceIndex}'/0`);
  return keypair(k.privateKey!);
}
export class DeviceSponsorPool {
  private db: DatabaseSync;
  constructor(file: string, public deviceId: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coins (coin TEXT PRIMARY KEY, device TEXT NOT NULL, amount INTEGER NOT NULL, reserved_by TEXT);`);
    const dev = (this.db.prepare("SELECT v FROM meta WHERE k='device'").get() as any)?.v;
    if (dev && dev !== deviceId) throw new Error(`sponsor database belongs to device ${dev}, opened as ${deviceId}: refusing a copied database`);
    if (!dev) this.db.prepare("INSERT INTO meta VALUES ('device',?)").run(deviceId);
  }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  register(coin: Outpoint) { this.tx(() => this.db.prepare("INSERT OR IGNORE INTO coins VALUES (?,?,?,NULL)").run(`${coin.txid}:${coin.vout}`, this.deviceId, Number(coin.amount))); }
  /** Reserve one of THIS device's confirmed, unreserved coins for a contract. Never another device's. */
  async reserve(rpc: Rpc, contract: string, ownerXonlyScriptHex: string): Promise<Outpoint | null> {
    const rows = this.db.prepare("SELECT coin,amount FROM coins WHERE device=? AND reserved_by IS NULL").all(this.deviceId) as any[];
    for (const r of rows) {
      const [txid, vout] = r.coin.split(":");
      const o = await rpc<any>("gettxout", [txid, Number(vout), false]).catch(() => null);
      if (!o || o.confirmations < 1 || o.scriptPubKey.hex !== ownerXonlyScriptHex) continue;
      const claimed = this.tx(() => this.db.prepare("UPDATE coins SET reserved_by=? WHERE coin=? AND device=? AND reserved_by IS NULL").run(contract, r.coin, this.deviceId).changes === 1);
      if (claimed) return { txid, vout: Number(vout), amount: BigInt(r.amount) };
    }
    return null;
  }
  /** Attempting to reserve a coin registered to another device is refused, even if the outpoint is known. */
  reserveForeign(coin: Outpoint, contract: string): boolean {
    return this.tx(() => this.db.prepare("UPDATE coins SET reserved_by=? WHERE coin=? AND device=? AND reserved_by IS NULL").run(contract, `${coin.txid}:${coin.vout}`, this.deviceId).changes === 1);
  }
  unreservedSats(): number { return (this.db.prepare("SELECT COALESCE(SUM(amount),0) s FROM coins WHERE device=? AND reserved_by IS NULL").get(this.deviceId) as any).s; }
  close() { this.db.close(); }
}
