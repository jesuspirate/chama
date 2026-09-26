import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PublicConductRecord } from '../../escrow-engine/public-conduct.js';
import { T } from '../theme.js';

type Load = (pubkey: string) => Promise<PublicConductRecord>;
const Context = createContext<Load | null>(null);
/** One public read per key per screen session, shared by every surface. */
export function ConductProvider({load,children}: {load:Load;children:ReactNode}) {
  const latest=useRef(load); latest.current=load;
  const cached=useRef(new Map<string,Promise<PublicConductRecord>>());
  const get=useMemo<Load>(()=>key=>{
    let value=cached.current.get(key);
    if (!value) { value=latest.current(key); cached.current.set(key,value); }
    return value;
  },[]);
  return <Context.Provider value={get}>{children}</Context.Provider>;
}
export function ConductFacts({pubkey}: {pubkey?:string|null}) {
  const load=useContext(Context);
  const [record,setRecord]=useState<PublicConductRecord|null>(null);
  useEffect(()=>{
    let stopped=false; setRecord(null);
    if (load && pubkey) void load(pubkey).then(value=>{if(!stopped)setRecord(value);}).catch(()=>{});
    return ()=>{stopped=true;};
  },[load,pubkey]);
  if (!record?.marks) return null;
  return <span style={{display:'block',whiteSpace:'normal',color:T.red,fontSize:12,fontWeight:700,lineHeight:1.4}}>
    Made a buyer wait for the arbiter after agreeing to pay — {record.complete ? '' : 'at least '}{record.marks===1?'once':`${record.marks} times`}.
  </span>;
}
