// ══════════════════════════════════════════════════════════════════════════
// QR Code Component — uses 'qrcode' npm package for real scannable output
// ══════════════════════════════════════════════════════════════════════════

import { useState, useEffect, type CSSProperties } from "react";

interface QRCodeProps {
  data: string | string[];
  size?: number;
  fgColor?: string;
  bgColor?: string;
  margin?: number;
  alt?: string;
  errorCorrectionLevel?: "L" | "M" | "Q" | "H";
  showLogo?: boolean;
  /** Frame cadence for qrloop/multipart data. Fedi uses 100 ms natively. */
  frameIntervalMs?: number;
}

export function QRCode({
  data,
  size = 220,
  fgColor = "#050505",
  bgColor = "#ffffff",
  margin = 2,
  alt = "QR code",
  errorCorrectionLevel = "H",
  showLogo = true,
  frameIntervalMs = 100,
}: QRCodeProps) {
  const [dataUrls, setDataUrls] = useState<string[]>([]);
  const [activeFrame, setActiveFrame] = useState(0);
  const [error, setError] = useState(false);
  const shellPad = Math.round(Math.min(16, Math.max(10, size * 0.055)));
  const shellSize = size + shellPad * 2;
  const cornerSize = Math.round(Math.min(34, Math.max(22, size * 0.12)));
  const cornerStroke = Math.max(2, Math.round(size * 0.011));
  const logoIslandSize = Math.round(Math.min(40, Math.max(26, size * 0.14)));
  const logoSize = Math.round(logoIslandSize * 0.76);
  const canShowLogo = showLogo && errorCorrectionLevel !== "L" && size >= 180;
  const cornerBase: CSSProperties = {
    position: "absolute",
    width: cornerSize,
    height: cornerSize,
    pointerEvents: "none",
    filter: "drop-shadow(0 0 10px rgba(46,230,214,.28))",
  };
  const corners: CSSProperties[] = [
    {
      ...cornerBase,
      left: 0,
      top: 0,
      borderLeft: `${cornerStroke}px solid #F7931A`,
      borderTop: `${cornerStroke}px solid #F7931A`,
      borderTopLeftRadius: 10,
    },
    {
      ...cornerBase,
      right: 0,
      top: 0,
      borderRight: `${cornerStroke}px solid #2EE6D6`,
      borderTop: `${cornerStroke}px solid #2EE6D6`,
      borderTopRightRadius: 10,
    },
    {
      ...cornerBase,
      left: 0,
      bottom: 0,
      borderLeft: `${cornerStroke}px solid #BF5AF2`,
      borderBottom: `${cornerStroke}px solid #BF5AF2`,
      borderBottomLeftRadius: 10,
    },
    {
      ...cornerBase,
      right: 0,
      bottom: 0,
      borderRight: `${cornerStroke}px solid #F7931A`,
      borderBottom: `${cornerStroke}px solid #F7931A`,
      borderBottomRightRadius: 10,
    },
  ];

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
        const urls = await Promise.all(values.map((value) => QRCodeLib.toDataURL(value, {
          width: size,
          margin,
          color: {
            dark: fgColor,
            light: bgColor,
          },
          errorCorrectionLevel,
        })));

        if (!cancelled) setDataUrls(urls);
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
        background:
          "radial-gradient(circle at 30% 20%, rgba(46,230,214,.10), transparent 48%), rgba(10,10,10,.30)",
      }}
    >
      {corners.map((style, index) => (
        <span key={index} aria-hidden="true" style={style} />
      ))}
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
          boxShadow: "0 12px 34px rgba(0,0,0,.24), 0 0 0 1px rgba(255,255,255,.92)",
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
            boxShadow: "0 5px 16px rgba(0,0,0,.24), 0 0 0 2px rgba(255,255,255,.92)",
          }}
        >
          <img
            src="/icons/chama-woven-trust-mark-transparent-64.png"
            alt=""
            width={logoSize}
            height={logoSize}
            style={{ display: "block", width: logoSize, height: logoSize }}
          />
        </span>
      )}
    </div>
  );
}

export default QRCode;
