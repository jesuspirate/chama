import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicConductRecord } from '../../escrow-engine/public-conduct.js';
import { T } from '../theme.js';

type Load = (pubkey: string) => Promise<PublicConductRecord>;
const Context = createContext<Load | null>(null);
/** One public read per key per screen session, shared by every surface. */
export function ConductProvider({load,children}: {load:Load;children:ReactNode}) {
  const latest=useRef(load); latest.current=load;
  const cached=useRef(new Map<string,{promise:Promise<PublicConductRecord>;at:number}>());
  const running=useRef(0), queue=useRef<Array<()=>void>>([]);
  const get=useMemo<Load>(()=>key=>{
    let value=cached.current.get(key);
    if (!value || Date.now()-value.at>=60_000) {
      const entry={promise:Promise.resolve(null as unknown as PublicConductRecord),at:Infinity};
      entry.promise=new Promise<PublicConductRecord>((resolve,reject)=>{
        const start=()=>{
          running.current++;
          void latest.current(key).then(resolve,reject).finally(()=>{
            entry.at=Date.now(); running.current--; queue.current.shift()?.();
          });
        };
        if(running.current<2) start(); else queue.current.push(start);
      });
      value=entry; cached.current.set(key,entry);
    }
    return value.promise;
  },[]);
  return <Context.Provider value={get}>{children}</Context.Provider>;
}
export function ConductFacts({pubkey}: {pubkey?:string|null}) {
  const load=useContext(Context);
  const [record,setRecord]=useState<PublicConductRecord|null>(null);
  useEffect(()=>{
    let stopped=false; setRecord(null);
    const refresh=()=>{if(load && pubkey) void load(pubkey).then(value=>{if(!stopped)setRecord(value);}).catch(()=>{});};
    refresh();
    const timer=setInterval(refresh,60_000);
    return ()=>{stopped=true;clearInterval(timer);};
  },[load,pubkey]);
  return record ? <ConductFactLines record={record} /> : null;
}

export function ConductFactLines({record}: {record:PublicConductRecord}) {
  const standing=record.standing;
  const duration=(seconds:number)=>seconds<60?`${Math.ceil(seconds)} seconds`:seconds<3600?`${Math.ceil(seconds/60)} minutes`:`${Math.round(seconds/360)/10} hours`;
  return <span style={{display:'block',flexBasis:'100%',minWidth:0,overflowWrap:'anywhere',whiteSpace:'normal',fontSize:11,lineHeight:1.4,color:T.muted}}>
    {record.marks>0 && <span style={{display:'block',color:T.red,fontSize:12,fontWeight:700}}>
      Made a buyer wait for the arbiter after agreeing to pay — {record.complete ? '' : 'at least '}{record.marks===1?'once':`${record.marks} times`}.
    </span>}
    {standing?.sellerSpeed && <span style={{display:'block'}}>Signs within {duration(standing.sellerSpeed.medianSeconds)} (median of {standing.sellerSpeed.samples})</span>}
    {standing?.arbiterSpeed && <span style={{display:'block'}}>Rules within {duration(standing.arbiterSpeed.medianSeconds)} (median of {standing.arbiterSpeed.samples})</span>}
    {standing?.bonded && <span style={{display:'block'}}>Bonded {Number(standing.bonded.sats).toLocaleString('en-US')} sats for {standing.bonded.days} days</span>}
    {standing?.settledTrades != null && standing.settledTrades>0 && <span style={{display:'block'}}>{standing.settledTrades} trades settled on chain</span>}
    {standing?.newHere && <span>New here · no history yet.</span>}
    {!record.complete && record.marks===0 && !standing?.bonded && <span>Public history unavailable.</span>}
  </span>;
}
