import { T } from "../theme.js";
import { BitcoinAmount } from "./BitcoinAmount.js";
import { useT } from "../../i18n/index.js";

export function SubscriptionTimeline({ subscription, onRelease }: {
  subscription: any;
  onRelease: (periodIndex: number) => void;
}) {
  const { t } = useT();
  const now = Math.floor(Date.now() / 1000);
  const sub = subscription;
  if (!sub) return null;

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.purple}22`,
      borderRadius: T.r, padding: 16, marginBottom: 16,
    }}>
      <div style={{
        fontSize: T.fs.secondary, fontWeight: 600, color: T.purple, fontFamily: T.sans, marginBottom: 12,
      }}>
        {t("card.subscriptionHeader", { released: sub.releasedCount, total: sub.totalPeriods })}
      </div>

      {/* Period blocks */}
      <div style={{ display: "flex", gap: 3, marginBottom: 12 }}>
        {sub.periodStatuses.map((status: string, i: number) => {
          const startTime = sub.periodStartTimes[i];
          const endTime = startTime + sub.periodDurationSeconds;
          const isActive = now >= startTime && now < endTime;
          const isPast = now >= endTime;

          const color = status === "released" ? T.green
            : status === "disputed" ? T.red
            : status === "refunded" ? T.amber
            : isActive ? T.purple
            : T.border;

          return (
            <div key={i} style={{
              flex: 1, height: 28, borderRadius: 4,
              background: `${color}${status === "released" ? "44" : isActive ? "66" : "22"}`,
              border: `1px solid ${color}${isActive ? "88" : "33"}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: T.fs.secondary, fontFamily: T.sans, color,
              fontWeight: isActive ? 700 : 400,
              animation: isActive ? "pulse 2s ease-in-out infinite" : "none",
              cursor: (isActive || isPast) && status === "pending" ? "pointer" : "default",
            }}
              title={t("card.periodTitle", { number: i + 1, status })}
            >
              {i + 1}
            </div>
          );
        })}
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          { c: T.green, l: t("card.legendReleased") },
          { c: T.purple, l: t("card.legendActive") },
          { c: T.border, l: t("card.legendPending") },
          { c: T.red, l: t("card.legendDisputed") },
        ].map(item => (
          <div key={item.l} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: item.c + "66" }} />
            <span style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans }}>{item.l}</span>
          </div>
        ))}
      </div>

      {/* Active period details + release button */}
      {sub.periodStatuses.map((status: string, i: number) => {
        const startTime = sub.periodStartTimes[i];
        const endTime = startTime + sub.periodDurationSeconds;
        const isActive = now >= startTime && now < endTime;
        const canRelease = (isActive || now >= endTime) && status !== "released" && status !== "refunded";

        if (!isActive && status !== "pending") return null;
        if (!canRelease) return null;

        const remaining = endTime - now;
        const days = Math.floor(remaining / 86400);
        const hours = Math.floor((remaining % 86400) / 3600);

        return (
          <div key={"release-" + i} style={{
            padding: "12px", background: T.surface,
            borderRadius: T.rs, border: `1px solid ${T.purple}22`,
            marginBottom: 8,
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <div style={{ fontSize: T.fs.secondary, color: T.purple, fontFamily: T.sans, fontWeight: 600 }}>
                  {t("card.periodLabel", { number: i + 1 })} · <BitcoinAmount msats={sub.periodAmountMsats} size={T.fs.secondary} gap={3} glyphScale={1.18} color={T.purple} glyphColor={T.purple} />
                </div>
                {remaining > 0 && (
                  <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, marginTop: 2 }}>
                    {t("card.autoReleasesIn", { time: `${days > 0 ? `${days}d ` : ""}${hours}h` })}
                  </div>
                )}
              </div>
              <button onClick={() => onRelease(i)} style={{
                padding: "8px 16px", borderRadius: T.rs,
                background: T.greenDim, border: `1px solid ${T.green}33`,
                color: T.green, fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 600,
                cursor: "pointer",
              }}>
                {t("card.release")}
              </button>
            </div>
          </div>
        );
      })}

      {/* Summary */}
      <div style={{ fontSize: T.fs.secondary, color: T.muted, fontFamily: T.sans, textAlign: "center" }}>
        <BitcoinAmount msats={sub.totalReleasedMsats} size={T.fs.secondary} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> /{" "}
        <BitcoinAmount msats={sub.totalPeriods * sub.periodAmountMsats} size={T.fs.secondary} gap={3} glyphScale={1.18} color={T.muted} glyphColor={T.muted} /> {t("card.releasedSuffix")}
      </div>
    </div>
  );
}
