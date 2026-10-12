import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { boundedInspection, federationFacts, publicShareLimit, type FederationInspection } from "../../fedimint/federation-inspection.js";
import type { CircleRound } from "../../chama/types.js";
import { useT } from "../../i18n/index.js";
import { T } from "../theme.js";

type Load = (invite: string) => Promise<FederationInspection>;
const Context = createContext<{ load?: Load; activeId?: string | null; communityInvite?: string }>({});
export function FederationInfoProvider({ load, activeId, communityInvite, children }: { load: Load; activeId?: string | null; communityInvite?: string; children: ReactNode }) {
  const latest = useRef(load); latest.current = load;
  const cachedLoad = useMemo<Load>(() => {
    const cache = new Map<string, { at: number; promise: Promise<FederationInspection> }>();
    let running = 0;
    const queue: Array<() => void> = [];
    return invite => {
      const cached = cache.get(invite);
      if (cached && Date.now() - cached.at < 60_000) return cached.promise;
      const promise = new Promise<FederationInspection>((resolve, reject) => {
        const start = () => {
          running++;
          boundedInspection(Promise.resolve().then(() => latest.current(invite))).then(resolve, reject).finally(() => { running--; queue.shift()?.(); });
        };
        if (running < 2) start(); else queue.push(start);
      });
      cache.set(invite, { at: Date.now(), promise });
      if (cache.size > 128) cache.delete(cache.keys().next().value!);
      return promise;
    };
  }, [activeId]); // A joined wallet can now read consensus limits for its federation.
  const value = useMemo(() => ({ load: cachedLoad, activeId, communityInvite }), [cachedLoad, activeId, communityInvite]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useFederationInfo(invite: string) {
  const context = useContext(Context);
  const [state, setState] = useState<{ invite: string; info: FederationInspection | null; loading: boolean }>({ invite, info: null, loading: !!context.load });
  useEffect(() => {
    let stopped = false;
    const refresh = () => {
      setState(old => ({ invite, info: old.invite === invite ? old.info : null, loading: old.invite === invite && old.info ? false : !!context.load && !!invite }));
      if (!context.load || !invite) return;
      // Includes queue time: a long Browse list must not hold a seat button forever.
      boundedInspection(context.load(invite)).then(info => { if (!stopped) setState({ invite, info, loading: false }); }, () => { if (!stopped) setState({ invite, info: null, loading: false }); });
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [context.load, invite]);
  return { ...context, info: state.invite === invite ? state.info : null, loading: state.invite === invite ? state.loading : !!context.load };
}
export function FederationDisclosure({ circle, compact = false, warningsOnly = false }: { circle: CircleRound; compact?: boolean; warningsOnly?: boolean }) {
  const { info, activeId, communityInvite } = useFederationInfo(circle.mintUrl);
  const { t, lang } = useT();
  const facts = federationFacts(circle.mintUrl, info, circle.creatorPubkey);
  const unlistedFederation = !facts.curated && (!communityInvite || circle.mintUrl.trim() !== communityInvite.trim());
  return <span data-federation-disclosure style={{ display: "block", fontSize: compact ? 11 : 13, fontFamily: T.sans, lineHeight: 1.5, overflowWrap: "anywhere", margin: compact ? 0 : "12px 0", color: T.muted }}>
    {!warningsOnly && <span style={{ display: "block" }}>{t(facts.guardians === null ? "circle.custodyUnknown" : "circle.custody", { name: facts.name ?? t("circle.unknownFederation"), count: facts.guardians ?? "?" })}{info && activeId === info.federationId && <> · {t("trade.sameFederation")}</>}</span>}
    {unlistedFederation && <span data-federation-warning="unlisted" style={{ display: "block", color: T.amber }}>{t("circle.unvettedGuardians", { date: new Date(circle.roundEndSec * 1000).toLocaleDateString(lang) })}</span>}
    {facts.singleOperator && <span data-federation-warning="operator" style={{ display: "block", color: T.red }}>{t("circle.singleOperator")}</span>}
  </span>;
}
export function CircleShareLabel({ circle, amount }: { circle: CircleRound; amount: string }) {
  const { info } = useFederationInfo(circle.mintUrl);
  const { t, lang } = useT();
  const max = publicShareLimit(info, circle.seatCap);
  return <span style={{ color: T.accent, fontWeight: 700 }}>{t("circle.satsEach", { amount })}{!circle.unlisted && <> · {t(max === null ? "circle.publicLimitUnknown" : "circle.publicLimit", { max: max?.toLocaleString(lang) ?? "?" })}</>}</span>;
}
