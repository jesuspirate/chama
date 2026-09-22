import { Wordmark } from "./Wordmark.js";
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
          src="/icons/favicon-192x192.png?v=approved-star-20260921"
          alt=""
          width={78}
          height={78}
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
          <Wordmark size={27} showMark={false} />
          <div style={{
            display: "flex", alignItems: "center", gap: 7,
            marginTop: 12, color: T.muted, fontFamily: T.sans,
            fontSize: 7.5, fontWeight: 700, letterSpacing: 1.25,
            textTransform: "uppercase", whiteSpace: "nowrap",
          }}>
            <span>community</span><span aria-hidden="true" style={{ fontSize: 5, opacity: 0.65 }}>●</span>
            <span>trust</span><span aria-hidden="true" style={{ fontSize: 5, opacity: 0.65 }}>●</span>
            <span>reputation</span>
          </div>
        </div>
      </div>
      <div style={{
        fontSize: 10, color: T.muted, fontFamily: T.mono,
        letterSpacing: 3, textTransform: "uppercase",
      }}>
        bitcoin commerce, together
      </div>
    </div>
  );
}
