// Bounded, persistent chain index for a set of watched txids and outpoints. RESEARCH, REGTEST.
//
// Replaces the research full-chain scan. Persists a cursor and the last K block hashes
// in SQLite; advances block by block in one transaction per block; detects reorgs by
// hash comparison and rewinds within K; refuses (explicitly) to guess beyond K or when
// history is missing. Late registrations carry a birth height and trigger a targeted
// rescan. Nothing here infers "spent" from a null gettxout.
import { DatabaseSync } from "node:sqlite";
import type { Rpc } from "./lib.js";

export class HistoryUnavailable extends Error { constructor(public height: number, cause: string) { super(`block history unavailable at height ${height}: ${cause}`); } }
export class ReorgTooDeep extends Error { constructor(public retained: number) { super(`reorg deeper than the ${retained} retained block hashes: explicit rescan from birth required`); } }

export class ChainIndex {
  private db: DatabaseSync;
  constructor(file: string, public retainBlocks = 100, public deviceId = "default") {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (height INTEGER PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS watched (key TEXT PRIMARY KEY, kind TEXT NOT NULL, birth INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS txs (txid TEXT PRIMARY KEY, height INTEGER NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spends (outpoint TEXT PRIMARY KEY, spender TEXT NOT NULL, height INTEGER NOT NULL);`);
    const dev = this.meta("device");
    if (dev && dev !== deviceId) throw new Error(`index belongs to device ${dev}, opened as ${deviceId}: refusing a copied index`);
    if (!dev) this.setMeta("device", deviceId);
  }
  private meta(k: string): string | undefined { return (this.db.prepare("SELECT v FROM meta WHERE k=?").get(k) as any)?.v; }
  private setMeta(k: string, v: string) { this.db.prepare("INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(k, v); }
  private tx<T>(fn: () => T): T { this.db.exec("BEGIN IMMEDIATE"); try { const r = fn(); this.db.exec("COMMIT"); return r; } catch (e) { this.db.exec("ROLLBACK"); throw e; } }
  get cursor(): { height: number; hash: string } | null { const h = this.meta("cursorHeight"); return h ? { height: Number(h), hash: this.meta("cursorHash")! } : null; }

  /** Start indexing from `birth` (the first height that can contain anything watched). */
  init(birth: number, birthHash: string) { if (!this.cursor) this.tx(() => { this.setMeta("cursorHeight", String(birth - 1)); this.setMeta("cursorHash", ""); this.setMeta("birth", String(birth)); this.db.prepare("INSERT OR REPLACE INTO blocks VALUES (?,?)").run(birth - 1, birthHash); }); }
  watchTx(txid: string, birth: number) { this.register(txid, "tx", birth); }
  watchOutpoint(txid: string, vout: number, birth: number) { this.register(`${txid}:${vout}`, "outpoint", birth); }
  private pendingRescanFrom: number | null = null;
  private register(key: string, kind: string, birth: number) {
    this.tx(() => {
      const exists = this.db.prepare("SELECT 1 FROM watched WHERE key=?").get(key);
      if (exists) return;
      this.db.prepare("INSERT INTO watched VALUES (?,?,?)").run(key, kind, birth);
      const c = this.cursor;
      if (c && birth <= c.height) this.pendingRescanFrom = Math.min(this.pendingRescanFrom ?? Infinity, birth);   // late registration: targeted rescan
    });
  }
  status(txid: string): { height: number; hash: string } | null { return (this.db.prepare("SELECT height,hash FROM txs WHERE txid=?").get(txid) as any) ?? null; }
  spender(txid: string, vout: number): { spender: string; height: number } | null { return (this.db.prepare("SELECT spender,height FROM spends WHERE outpoint=?").get(`${txid}:${vout}`) as any) ?? null; }

  private async scanBlock(rpc: Rpc, height: number): Promise<{ hash: string; found: number }> {
    let hash: string, block: any;
    try { hash = await rpc<string>("getblockhash", [height], ""); block = await rpc<any>("getblock", [hash, 2], ""); }
    catch (e) { throw new HistoryUnavailable(height, (e as Error).message); }
    const watchedTx = new Set((this.db.prepare("SELECT key FROM watched WHERE kind='tx'").all() as any[]).map((r) => r.key));
    const watchedOut = new Set((this.db.prepare("SELECT key FROM watched WHERE kind='outpoint'").all() as any[]).map((r) => r.key));
    let found = 0;
    for (const t of block.tx) {
      if (watchedTx.has(t.txid)) { this.db.prepare("INSERT OR REPLACE INTO txs VALUES (?,?,?)").run(t.txid, height, hash); found++; }
      for (const vin of t.vin) { if (vin.txid !== undefined) { const op = `${vin.txid}:${vin.vout}`; if (watchedOut.has(op)) { this.db.prepare("INSERT OR REPLACE INTO spends VALUES (?,?,?)").run(op, t.txid, height); found++; } } }
    }
    return { hash, found };
  }
  private rewindTo(height: number) {
    this.db.prepare("DELETE FROM txs WHERE height>?").run(height);
    this.db.prepare("DELETE FROM spends WHERE height>?").run(height);
    this.db.prepare("DELETE FROM blocks WHERE height>?").run(height);
    this.setMeta("cursorHeight", String(height)); this.setMeta("cursorHash", (this.db.prepare("SELECT hash FROM blocks WHERE height=?").get(height) as any)?.hash ?? "");
  }
  /** Advance to the node's tip. Each block commits atomically; a failure leaves the cursor at the last good block. */
  async sync(rpc: Rpc): Promise<{ from: number; to: number; reorgedFrom?: number; rescannedFrom?: number; found: number }> {
    const c = this.cursor; if (!c) throw new Error("index not initialised");
    const tip = await rpc<number>("getblockcount", [], "");
    let from = c.height + 1, reorgedFrom: number | undefined, rescannedFrom: number | undefined, found = 0;
    // Reorg detection: walk back from the cursor until a stored hash matches the active chain (bounded by retained blocks).
    let h = c.height; let steps = 0;
    while (h >= 0) {
      const stored = (this.db.prepare("SELECT hash FROM blocks WHERE height=?").get(h) as any)?.hash;
      if (stored === undefined) throw new ReorgTooDeep(this.retainBlocks);
      const active = h <= tip ? await rpc<string>("getblockhash", [h], "") : null;
      if (stored === active || stored === "") break;
      h--; steps++; if (steps > this.retainBlocks) throw new ReorgTooDeep(this.retainBlocks);
    }
    if (h < c.height) { this.tx(() => this.rewindTo(h)); reorgedFrom = h + 1; from = h + 1; }
    if (this.pendingRescanFrom !== null && this.pendingRescanFrom < from) { rescannedFrom = this.pendingRescanFrom; from = this.pendingRescanFrom; this.pendingRescanFrom = null; }
    for (let height = from; height <= tip; height++) {
      const r = await this.scanBlock(rpc, height);    // RPC outside the transaction; writes inside it
      // scanBlock wrote rows outside a transaction; wrap the cursor/blocks update and make it atomic with a re-check.
      this.tx(() => {
        this.db.prepare("INSERT OR REPLACE INTO blocks VALUES (?,?)").run(height, r.hash);
        this.db.prepare("DELETE FROM blocks WHERE height<?").run(height - this.retainBlocks);
        this.setMeta("cursorHeight", String(height)); this.setMeta("cursorHash", r.hash);
      });
      found += r.found;
    }
    return { from, to: tip, reorgedFrom, rescannedFrom, found };
  }
  /** Explicit recovery: drop everything above `height` and rescan from there. */
  async rescanFrom(rpc: Rpc, height: number) { const hash = await rpc<string>("getblockhash", [height - 1], ""); this.tx(() => { this.db.exec("DELETE FROM txs; DELETE FROM spends; DELETE FROM blocks;"); this.db.prepare("INSERT INTO blocks VALUES (?,?)").run(height - 1, hash); this.setMeta("cursorHeight", String(height - 1)); this.setMeta("cursorHash", hash); }); return this.sync(rpc); }
  close() { this.db.close(); }
}
