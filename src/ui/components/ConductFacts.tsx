import { useT } from "../../i18n/index.js";
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
export function ConductFacts({pubkey, showEmpty = false}: {pubkey?:string|null; showEmpty?:boolean}) {
  const { t } = useT();
  const load=useContext(Context);
  const [record,setRecord]=useState<PublicConductRecord|null>(null);
  useEffect(()=>{
    let stopped=false; setRecord(null);
    const refresh=()=>{if(load && pubkey) void load(pubkey).then(value=>{if(!stopped)setRecord(value);}).catch(()=>{});};
    refresh();
    const timer=setInterval(refresh,60_000);
    return ()=>{stopped=true;clearInterval(timer);};
  },[load,pubkey]);
  return record ? <ConductFactLines record={record} showEmpty={showEmpty} /> : showEmpty ? <span>{t("circle.conductUnknown")}</span> : null;
}

export function ConductFactLines({record, showEmpty = false}: {record:PublicConductRecord; showEmpty?:boolean}) {
  const { t, lang } = useT();
  const standing=record.standing;
  const hasFacts = record.marks > 0 || standing?.sellerSpeed || standing?.arbiterSpeed
    || standing?.bonded || (standing?.settledTrades ?? 0) > 0;
  if (!hasFacts) return showEmpty ? <span>{t("circle.conductEmpty")}</span> : null;
  const duration=(seconds:number)=>new Intl.NumberFormat(lang,{style:"unit",unit:seconds<60?"second":seconds<3600?"minute":"hour",unitDisplay:"long",maximumFractionDigits:1}).format(seconds<60?Math.ceil(seconds):seconds<3600?Math.ceil(seconds/60):Math.round(seconds/360)/10);
  return <span style={{display:'block',flexBasis:'100%',minWidth:0,overflowWrap:'anywhere',whiteSpace:'normal',fontSize:11,lineHeight:1.4,color:T.muted}}>
    {record.marks>0 && <span style={{display:'block',color:T.red,fontSize:12,fontWeight:700}}>
      {t(record.marks === 1 ? (record.complete ? "circle.conductPenaltyOne" : "circle.conductPenaltyPartialOne") : (record.complete ? "circle.conductPenalty" : "circle.conductPenaltyPartial"),{count:record.marks})}
    </span>}
    {standing?.sellerSpeed && <span style={{display:'block'}}>{t("circle.conductSigns",{time:duration(standing.sellerSpeed.medianSeconds),count:standing.sellerSpeed.samples})}</span>}
    {standing?.arbiterSpeed && <span style={{display:'block'}}>{t("circle.conductRules",{time:duration(standing.arbiterSpeed.medianSeconds),count:standing.arbiterSpeed.samples})}</span>}
    {standing?.bonded && <span style={{display:'block'}}>{t(standing.bonded.days === 1 ? "trade.bondedAmountDaysOne" : "trade.bondedAmountDaysMany", { amount: Number(standing.bonded.sats).toLocaleString(), count: standing.bonded.days })}</span>}
    {standing?.settledTrades != null && standing.settledTrades>0 && <span style={{display:'block'}}>{t(standing.settledTrades === 1 ? "circle.conductSettledOne" : "circle.conductSettled",{count:standing.settledTrades})}</span>}
  </span>;
}
