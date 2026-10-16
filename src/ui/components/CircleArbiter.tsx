import type { EscrowState } from "../../escrow-engine/types.js";
import { Role } from "../../escrow-engine/types.js";
import { useT } from "../../i18n/index.js";
import { generatedNameFor, profileNameFor, type NostrProfileNameMap } from "../nostr-profiles.js";
/** Never substitute the circle's pool pick for the viewer's committed share seat. */
export function viewerCircleShare(states: Iterable<EscrowState>, parent: string, viewer: string) {
  return [...states].find(s => s.parent === parent && !!s.chamaPolicy && s.participants[Role.BUYER]?.toLowerCase() === viewer.toLowerCase());
}
export function CircleArbiter({ share, profileNames, kind0Enabled, onProfile }: { share?: EscrowState; profileNames?: NostrProfileNameMap; kind0Enabled?: boolean; onProfile?: (key:string)=>void }) {
  const { t, lang } = useT();
  const key = share?.participants[Role.ARBITER];
  const name = key ? profileNameFor(profileNames,key,kind0Enabled ?? false,lang) ?? generatedNameFor(key,lang) : null;
  return <div data-circle-arbiter style={{ margin: "10px 0", lineHeight: 1.5 }}>
    {key && name ? onProfile ? <button type="button" onClick={()=>onProfile(key)} style={{ background:"none", border:0, padding:"10px 0", color:"inherit", font:"inherit", cursor:"pointer", textAlign:"left" }}>{t("circle.arbiter",{name})} ›</button> : <span>{t("circle.arbiter",{name})}</span> : <span>{t("circle.assignedOnLock")}</span>}
    <small style={{ display:"block" }}>{t("circle.perShare")}</small>
  </div>;
}
