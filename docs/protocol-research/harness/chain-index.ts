// RESEARCH: retained block hashes + watched transaction/spend history.
// RPC reads precede SQL mutations. A block's matches, cursor and rescan progress
// commit together. Consumers must sync successfully before interpreting absence.
import {DatabaseSync} from 'node:sqlite';
import type {Rpc} from './lib.js';
export class HistoryUnavailable extends Error {constructor(public height:number,cause:string){super(`block history unavailable at height ${height}: ${cause}`);}}
export class ReorgTooDeep extends Error {constructor(public retained:number){super(`reorg deeper than ${retained} retained hashes; explicit rescan required`);}}
export class ChainChanged extends Error {}
export class ConcurrentIndexUpdate extends Error {}
export class ChainIndex {
 private db:DatabaseSync;
 constructor(file:string,public retainBlocks=100,public deviceId='default'){
  if(!Number.isSafeInteger(retainBlocks)||retainBlocks<1||!deviceId)throw new Error('invalid index configuration');
  this.db=new DatabaseSync(file);this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
  CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS watched(key TEXT PRIMARY KEY,kind TEXT NOT NULL,birth INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS txs(txid TEXT PRIMARY KEY,height INTEGER NOT NULL,hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS spends(outpoint TEXT PRIMARY KEY,spender TEXT NOT NULL,height INTEGER NOT NULL);`);
  this.tx(()=>{const dev=this.meta('device');if(dev&&(dev!==deviceId||this.meta('schema')!=='2'))throw new Error('index device mismatch or legacy schema: explicit rebuild required');if(!dev){this.set('device',deviceId);this.set('schema','2');}});
 }
 private meta(k:string):string|undefined{return (this.db.prepare('SELECT v FROM meta WHERE k=?').get(k) as any)?.v;}
 private set(k:string,v:string){this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,v);}
 private tx<T>(fn:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=fn();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get cursor():{height:number;hash:string}|null{const h=this.meta('cursorHeight');return h===undefined?null:{height:Number(h),hash:this.meta('cursorHash')!};}
 get pendingRescanFrom():number|null{const h=this.meta('pendingRescan');return h===undefined?null:Number(h);}
 private validBirth(h:number){if(!Number.isSafeInteger(h)||h<1)throw new Error('birth must be an integer height >=1');}
 init(birth:number,birthHash:string){this.validBirth(birth);if(!/^[0-9a-f]{64}$/.test(birthHash))throw new Error('invalid predecessor hash');this.tx(()=>{if(this.cursor)return;this.set('birth',String(birth));this.set('cursorHeight',String(birth-1));this.set('cursorHash',birthHash);this.db.prepare('INSERT INTO blocks VALUES (?,?)').run(birth-1,birthHash);});}
 watchTx(txid:string,birth:number){if(!/^[0-9a-f]{64}$/.test(txid))throw new Error('invalid txid');this.register(txid,'tx',birth);}
 watchOutpoint(txid:string,vout:number,birth:number){if(!/^[0-9a-f]{64}$/.test(txid)||!Number.isSafeInteger(vout)||vout<0||vout>0xffffffff)throw new Error('invalid outpoint');this.register(`${txid}:${vout}`,'outpoint',birth);}
 private register(key:string,kind:string,birth:number){this.validBirth(birth);this.tx(()=>{
  const old=this.db.prepare('SELECT birth FROM watched WHERE key=?').get(key) as any;if(old&&old.birth<=birth)return;
  this.db.prepare('INSERT INTO watched VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET birth=MIN(birth,excluded.birth)').run(key,kind,birth);
  this.set('watchRevision',String(Number(this.meta('watchRevision')??0)+1));
  if(this.cursor&&birth<=this.cursor.height)this.set('pendingRescan',String(Math.min(this.pendingRescanFrom??Infinity,birth)));
 });}
 status(txid:string):{height:number;hash:string}|null{return (this.db.prepare('SELECT height,hash FROM txs WHERE txid=?').get(txid) as any)??null;}
 spender(txid:string,vout:number):{spender:string;height:number}|null{return (this.db.prepare('SELECT spender,height FROM spends WHERE outpoint=?').get(`${txid}:${vout}`) as any)??null;}
 private checkCursor(c:{height:number;hash:string},revision?:string){const now=this.cursor;if(now?.height!==c.height||now.hash!==c.hash||(revision!==undefined&&(this.meta('watchRevision')??'0')!==revision))throw new ConcurrentIndexUpdate('index changed during RPC; retry sync');}
 private rewind(height:number,hash:string){this.db.prepare('DELETE FROM txs WHERE height>?').run(height);this.db.prepare('DELETE FROM spends WHERE height>?').run(height);this.db.prepare('DELETE FROM blocks WHERE height>?').run(height);this.db.prepare('INSERT OR REPLACE INTO blocks VALUES (?,?)').run(height,hash);this.set('cursorHeight',String(height));this.set('cursorHash',hash);}
 async sync(rpc:Rpc):Promise<{from:number;to:number;reorgedFrom?:number;rescannedFrom?:number;found:number}>{
  let c=this.cursor;if(!c)throw new Error('index not initialised');
  const info=await rpc<any>('getblockchaininfo',[],'');if(info.chain!=='regtest')throw new Error('research index requires regtest');
  const tip=info.blocks as number,tipHash=info.bestblockhash as string;
  let h=c.height,ancestor:string|undefined,steps=0,reorgedFrom:number|undefined,rescannedFrom:number|undefined,found=0;
  while(h>=0){const stored=(this.db.prepare('SELECT hash FROM blocks WHERE height=?').get(h) as any)?.hash;if(stored===undefined)throw new ReorgTooDeep(this.retainBlocks);const active=h<=tip?await rpc<string>('getblockhash',[h],''):null;if(stored===active){ancestor=stored;break;}if(++steps>this.retainBlocks)throw new ReorgTooDeep(this.retainBlocks);h--;}
  if(ancestor===undefined)throw new ReorgTooDeep(this.retainBlocks);
  if(h<c.height){this.tx(()=>{this.checkCursor(c!);this.rewind(h,ancestor!);});reorgedFrom=h+1;c=this.cursor!;}
  const pending=this.pendingRescanFrom;
  if(pending!==null&&pending<=c.height){const revision=this.meta('watchRevision')??'0';const hash=await rpc<string>('getblockhash',[pending-1],'');this.tx(()=>{this.checkCursor(c!,revision);this.rewind(pending-1,hash);});rescannedFrom=pending;c=this.cursor!;}
  const from=c.height+1;
  for(let height=from;height<=tip;height++){
   const expected=this.cursor!,revision=this.meta('watchRevision')??'0';let hash:string,block:any;
   try{hash=await rpc<string>('getblockhash',[height],'');block=await rpc<any>('getblock',[hash,2],'');}catch(e){throw new HistoryUnavailable(height,(e as Error).message);}
   if(block.hash!==hash||block.height!==height||block.previousblockhash!==expected.hash||await rpc<string>('getblockhash',[height],'')!==hash)throw new ChainChanged('chain changed while fetching block; retry sync');
   const count=this.tx(()=>{
    this.checkCursor(expected,revision);
    const watchedTx=new Set((this.db.prepare("SELECT key FROM watched WHERE kind='tx'").all() as any[]).map(x=>x.key));
    const watchedOut=new Set((this.db.prepare("SELECT key FROM watched WHERE kind='outpoint'").all() as any[]).map(x=>x.key));let count=0;
    for(const t of block.tx){if(watchedTx.has(t.txid)){this.db.prepare('INSERT OR REPLACE INTO txs VALUES (?,?,?)').run(t.txid,height,hash);count++;}for(const vin of t.vin){if(vin.txid&&watchedOut.has(`${vin.txid}:${vin.vout}`)){this.db.prepare('INSERT OR REPLACE INTO spends VALUES (?,?,?)').run(`${vin.txid}:${vin.vout}`,t.txid,height);count++;}}}
    this.db.prepare('INSERT OR REPLACE INTO blocks VALUES (?,?)').run(height,hash);this.db.prepare('DELETE FROM blocks WHERE height<?').run(height-this.retainBlocks);
    this.set('cursorHeight',String(height));this.set('cursorHash',hash);
    if(this.pendingRescanFrom!==null)this.set('pendingRescan',String(height+1));
    return count;
   });found+=count;
  }
  if(await rpc<string>('getbestblockhash',[],'')!==tipHash)throw new ChainChanged('tip changed before sync completed; retry');
  this.tx(()=>{const last=this.cursor;if(last?.height!==tip||last.hash!==tipHash)throw new ConcurrentIndexUpdate('cursor no longer matches sync result');if(this.pendingRescanFrom!==null&&this.pendingRescanFrom<=tip)throw new ConcurrentIndexUpdate('new rescan registration requires retry');this.db.prepare("DELETE FROM meta WHERE k='pendingRescan'").run();this.set('lastSuccessfulTip',tipHash);});
  return {from,to:tip,reorgedFrom,rescannedFrom,found};
 }
 async rescanFrom(rpc:Rpc,height:number){this.validBirth(height);const min=(this.db.prepare('SELECT MIN(birth) AS birth FROM watched').get() as any)?.birth;if(min!==null&&min!==undefined&&height>min)throw new Error('rescan must cover every watched birth');const hash=await rpc<string>('getblockhash',[height-1],'');this.tx(()=>{this.db.exec('DELETE FROM txs; DELETE FROM spends; DELETE FROM blocks;');this.rewind(height-1,hash);this.set('pendingRescan',String(height));});return this.sync(rpc);}
 close(){this.db.close();}
}
