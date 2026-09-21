// ══════════════════════════════════════════════════════════════════════════
// QR Code Component — uses 'qrcode' npm package for real scannable output
// ══════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";
import { T } from "./theme.js";
import { ChamaLoader } from "./components/ChamaLoader.js";

interface QRCodeProps {
  data: string | string[];
  size?: number;
  fgColor?: string;
  bgColor?: string;
  margin?: number;
  alt?: string;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  showLogo?: boolean;
  logo?: "static" | "motion";
  /** Frame cadence for qrloop/multipart data. Fedi uses 100 ms natively. */
  frameIntervalMs?: number;
}

export function QRCode({
  data,
  size = 220,
  fgColor = "#050505",
  bgColor = "#ffffff",
  margin = 4,
  alt = "QR code",
  errorCorrectionLevel = "H",
  showLogo = true,
  logo = "static",
  frameIntervalMs = 100,
}: QRCodeProps) {
  const [dataUrls, setDataUrls] = useState<string[]>([]);
  const [activeFrame, setActiveFrame] = useState(0);
  const [error, setError] = useState(false);
  const shellPad = 22;
  const shellSize = size + shellPad * 2;
  const logoIslandSize = Math.round(Math.min(40, Math.max(26, size * 0.14)));
  const logoSize = Math.round(logoIslandSize * 0.76);
  const canShowLogo = showLogo && errorCorrectionLevel !== "L" && size >= 180;

  useEffect(() => {
    let cancelled = false;
    setError(false);
    setDataUrls([]);
    setActiveFrame(0);

    (async () => {
      try {
        // Dynamic import — only loaded when QR is needed
        const QRCodeLib = await import("qrcode");
        const values = Array.isArray(data) ? data : [data];
        if (!values.length || values.some((value) => !value)) {
          throw new Error("QR data is empty");
        }
        const render = (value: string) => QRCodeLib.toDataURL(value, {
          width: size,
          margin,
          color: {
            dark: fgColor,
            light: bgColor,
          },
          errorCorrectionLevel,
        });

        // Multipart invite-bearing ecash can have many frames. Waiting for
        // Promise.all made the safe portable export feel much slower than an
        // old compact note even though frame 1 was already renderable. Paint
        // the first QR immediately, then build the remaining animation frames
        // in the background without weakening the exported instrument.
        const first = await render(values[0]);
        if (!cancelled) setDataUrls([first]);
        if (values.length > 1) {
          const rest = await Promise.all(values.slice(1).map(render));
          if (!cancelled) setDataUrls([first, ...rest]);
        }
      } catch (e) {
        console.error("[chama] QR generation failed:", e);
        if (!cancelled) setError(true);
      }
    })();

    return () => { cancelled = true; };
  }, [data, size, fgColor, bgColor, margin, errorCorrectionLevel]);

  useEffect(() => {
    if (dataUrls.length < 2) return;
    const interval = window.setInterval(() => {
      setActiveFrame((frame) => (frame + 1) % dataUrls.length);
    }, frameIntervalMs);
    return () => window.clearInterval(interval);
  }, [dataUrls, frameIntervalMs]);

  const dataUrl = dataUrls[activeFrame] ?? null;

  if (error) {
    return (
      <div style={{
        width: shellSize, height: shellSize, display: "flex",
        alignItems: "center", justifyContent: "center",
        border: "1px dashed #6b6980", borderRadius: 8,
        fontSize: 9, color: "#6b6980", fontFamily: "monospace",
        padding: 8, textAlign: "center",
      }}>
        QR unavailable — use the link below
      </div>
    );
  }

  if (!dataUrl) {
    return (
      <div style={{
        width: shellSize, height: shellSize, display: "flex",
        alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: 24, height: 24, border: "2px solid #888",
          borderTopColor: "transparent", borderRadius: "50%",
          animation: "spin 1s linear infinite",
        }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "relative",
        width: shellSize,
        height: shellSize,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 18,
        maxWidth: "100%",
      }}
    >
      <svg aria-hidden="true" width={shellSize} height={shellSize} viewBox={`0 0 ${shellSize} ${shellSize}`}
        style={{ position: "absolute", inset: 0, pointerEvents: "none", filter: `drop-shadow(0 0 8px ${T.tealDim})` }}
        fill="none" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
        <path stroke="#F7931A" d="M 38 2 H 18 A 16 16 0 0 0 2 18 V 38" />
        <path stroke="#2EE6D6" d={`M ${shellSize-38} 2 H ${shellSize-18} A 16 16 0 0 1 ${shellSize-2} 18 V 38`} />
        <path stroke="#BF5AF2" d={`M 2 ${shellSize-38} V ${shellSize-18} A 16 16 0 0 0 18 ${shellSize-2} H 38`} />
        <path stroke="#F7931A" d={`M ${shellSize-38} ${shellSize-2} H ${shellSize-18} A 16 16 0 0 0 ${shellSize-2} ${shellSize-18} V ${shellSize-38}`} />
      </svg>
      <img
        src={dataUrl}
        alt={dataUrls.length > 1 ? `${alt} — frame ${activeFrame + 1} of ${dataUrls.length}` : alt}
        width={size}
        height={size}
        style={{
          width: size,
          height: size,
          borderRadius: 12,
          background: bgColor,
          boxShadow: `0 8px 24px ${T.border}`,
        }}
      />
      {canShowLogo && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: logoIslandSize,
            height: logoIslandSize,
            transform: "translate(-50%, -50%)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "50%",
            background: "#ffffff",
            border: "1px solid rgba(10,10,10,.10)",
            boxShadow: `0 3px 10px ${T.border}`,
          }}
        >
          {logo === "motion" ? <ChamaLoader size={logoSize} /> : <img
            src="/icons/chama-woven-trust-mark-transparent-64.png"
            alt=""
            width={logoSize}
            height={logoSize}
            style={{ display: "block", width: logoSize, height: logoSize }}
          />}
        </span>
      )}
    </div>
  );
}

export default QRCode;
