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
  if (!Number.isSafeInteger(deviceIndex) || deviceIndex < 0 || deviceIndex >= 0x80000000) throw new Error("invalid hardened device index");
  const root = HDKey.fromMasterSeed(sha256(seed));
  const k = root.derive(`m/86'/1'/1337'/${deviceIndex}'/0`);
  return keypair(k.privateKey!);
}
export class DeviceSponsorPool {
  private db: DatabaseSync;
  constructor(file: string, public deviceId: string, private ownerScriptHex: string) {
    if (!deviceId || !/^5120[0-9a-f]{64}$/.test(ownerScriptHex ?? "")) throw new Error("explicit device identity and P2TR owner script required");
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coins (coin TEXT PRIMARY KEY, device TEXT NOT NULL, amount INTEGER NOT NULL, reserved_by TEXT);`);
    this.tx(() => {
      const dev = (this.db.prepare("SELECT v FROM meta WHERE k='device'").get() as any)?.v;
      const script = (this.db.prepare("SELECT v FROM meta WHERE k='ownerScript'").get() as any)?.v;
      if (dev && (dev !== deviceId || script !== ownerScriptHex)) throw new Error("device/script mismatch or legacy unbound database: explicit migration required");
      if (!dev) { this.db.prepare("INSERT INTO meta VALUES ('device',?)").run(deviceId); this.db.prepare("INSERT INTO meta VALUES ('ownerScript',?)").run(ownerScriptHex); }
    });
  }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  register(coin: Outpoint) { if (!/^[0-9a-f]{64}$/.test(coin.txid) || !Number.isSafeInteger(coin.vout) || coin.vout < 0 || coin.vout > 0xffffffff || coin.amount <= 0n || coin.amount > 2100000000000000n) throw new Error("invalid coin metadata"); this.tx(() => this.db.prepare("INSERT OR IGNORE INTO coins VALUES (?,?,?,NULL)").run(`${coin.txid}:${coin.vout}`, this.deviceId, Number(coin.amount))); }
  /** Reserve one of THIS device's confirmed, unreserved coins for a contract. Never another device's. */
  async reserve(rpc: Rpc, contract: string, ownerXonlyScriptHex: string): Promise<Outpoint | null> {
    if (ownerXonlyScriptHex !== this.ownerScriptHex) throw new Error("caller cannot substitute another sponsor script");
    const rows = this.db.prepare("SELECT coin,amount FROM coins WHERE device=? AND reserved_by IS NULL").all(this.deviceId) as any[];
    for (const r of rows) {
      const [txid, vout] = r.coin.split(":");
      const o = await rpc<any>("gettxout", [txid, Number(vout), true]);
      if (!o || o.confirmations < 1 || o.scriptPubKey.hex !== this.ownerScriptHex || Math.round(o.value * 1e8) !== r.amount) continue;
      const claimed = this.tx(() => this.db.prepare("UPDATE coins SET reserved_by=? WHERE coin=? AND device=? AND reserved_by IS NULL").run(contract, r.coin, this.deviceId).changes === 1);
      if (claimed) return { txid, vout: Number(vout), amount: BigInt(r.amount) };
    }
    return null;
  }
  /** Attempting to reserve a coin registered to another device is refused, even if the outpoint is known. */
  reserveForeign(_coin: Outpoint, _contract: string): boolean { return false; } // no chain-validation bypass
  /** Fresh policy input; registry totals alone are not confirmed liquidity. */
  async available(rpc: Rpc): Promise<{ totalSats: number; coins: Outpoint[]; tipHash: string }> {
    const tipHash = await rpc<string>("getbestblockhash", [], "");
    const rows = this.db.prepare("SELECT coin,amount FROM coins WHERE device=? AND reserved_by IS NULL").all(this.deviceId) as any[];
    const coins: Outpoint[] = [];
    for (const r of rows) {
      const [txid, n] = r.coin.split(":"); const vout = Number(n);
      const o = await rpc<any>("gettxout", [txid, vout, true]);
      if (!o || o.confirmations < 1 || o.scriptPubKey.hex !== this.ownerScriptHex || Math.round(o.value * 1e8) !== r.amount) continue;
      // The query is observational, not an atomic admission/reservation operation.
      const stillFree = this.db.prepare("SELECT 1 FROM coins WHERE coin=? AND reserved_by IS NULL").get(r.coin);
      if (stillFree) coins.push({ txid, vout, amount: BigInt(r.amount) });
    }
    if (await rpc<string>("getbestblockhash", [], "") !== tipHash) throw new Error("chain moved during liquidity query; retry");
    return { totalSats: coins.reduce((n,c)=>n+Number(c.amount),0), coins, tipHash };
  }
  /** Registered-only accounting; never feed directly to admission. */
  unreservedSats(): number { return (this.db.prepare("SELECT COALESCE(SUM(amount),0) s FROM coins WHERE device=? AND reserved_by IS NULL").get(this.deviceId) as any).s; }
  close() { this.db.close(); }
}
