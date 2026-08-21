import { T } from "../theme.js";

// The Woven Trust lockup + tagline shown at the top of every onboarding
// surface (connect, welcome intro, country picker). Extracted to a shared
// component so the globe picker and ConnectScreen render one source of truth.
export function BrandHeader() {
  return (
    <div style={{ marginBottom: 24 }}>
      <div
        aria-label="Chama — community, trust, reputation"
        style={{
          display: "flex",
          alignItems: "center",
          gap: 13,
          margin: "0 auto 18px",
          width: "min(78vw, 300px)",
          maxWidth: "100%",
        }}
      >
        <img
          src="/icons/favicon-192x192.png"
          alt=""
          width={78}
          height={78}
          fetchPriority="high"
          decoding="async"
          style={{
            display: "block",
            width: 78,
            height: 78,
            flex: "0 0 78px",
            filter: "drop-shadow(0 0 28px #f7931a22)",
          }}
        />
        <div style={{ minWidth: 0, textAlign: "left" }}>
          <div style={{
            color: T.text, fontFamily: T.sans, fontSize: 27,
            fontWeight: 800, lineHeight: 1, letterSpacing: -1.2,
          }}>
            Chama
          </div>
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            marginTop: 12, color: T.muted, fontFamily: T.sans,
            fontSize: 7.5, fontWeight: 700, letterSpacing: 1.25,
            textTransform: "uppercase", whiteSpace: "nowrap",
          }}>
            <span>community</span><span style={{ color: T.accent }}>●</span>
            <span>trust</span><span style={{ color: T.teal }}>●</span>
            <span>reputation</span>
          </div>
        </div>
      </div>
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 3, textTransform: "uppercase",
      }}>
        local money, bitcoin rails
      </div>
    </div>
  );
}
