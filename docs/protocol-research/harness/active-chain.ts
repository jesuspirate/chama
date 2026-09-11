// Research-only, unpruned-regtest transaction history. No txindex required.
// Cache blocks by hash, rebuild ACTIVE indexes after a reorg, and retry if the tip
// changes during observation. Production needs a bounded persistent index/rescan.
import type {Rpc} from './lib.js';
export interface ChainView { tipHash:string; tipHeight:number; txs:Map<string,{height:number;blockHash:string;tx:any}>; spends:Map<string,string>; mempool:Set<string> }
const caches=new WeakMap<Rpc,Map<string,any>>();
export async function activeChain(rpc:Rpc):Promise<ChainView>{
 const cache=caches.get(rpc)??new Map<string,any>();caches.set(rpc,cache);
 for(let attempt=0;attempt<3;attempt++){
  const tipHash=await rpc<string>('getbestblockhash',[],'');let hash=tipHash;const blocks:any[]=[];
  while(hash){let b=cache.get(hash);if(!b){b=await rpc<any>('getblock',[hash,2],'');cache.set(hash,b);}blocks.push(b);hash=b.previousblockhash;}
  const mempool=new Set(await rpc<string[]>('getrawmempool',[],''));
  if(await rpc<string>('getbestblockhash',[],'')!==tipHash)continue;
  const txs:ChainView['txs']=new Map(),spends:ChainView['spends']=new Map();
  for(const b of blocks.reverse())for(const tx of b.tx){txs.set(tx.txid,{height:b.height,blockHash:b.hash,tx});for(const vin of tx.vin)if(vin.txid)spends.set(`${vin.txid}:${vin.vout}`,tx.txid);}
  return {tipHash,tipHeight:blocks.at(-1).height,txs,spends,mempool};
 }
 throw new Error('active chain changed repeatedly; retry observation');
}
