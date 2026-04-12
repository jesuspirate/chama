// ══════════════════════════════════════════════════════════════════════════
// QR Code Component — uses 'qrcode' npm package for real scannable output
// ══════════════════════════════════════════════════════════════════════════

import { useState, useEffect } from "react";

interface QRCodeProps {
  data: string;
  size?: number;
  fgColor?: string;
  bgColor?: string;
}

export function QRCode({ data, size = 220, fgColor = "#a78bfa", bgColor = "#111118" }: QRCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        // Dynamic import — only loaded when QR is needed
        const QRCodeLib = await import("qrcode");

        const url = await QRCodeLib.toDataURL(data, {
          width: size,
          margin: 2,
          color: {
            dark: fgColor,
            light: bgColor,
          },
          errorCorrectionLevel: "L", // Low EC for long URIs
        });

        if (!cancelled) setDataUrl(url);
      } catch (e) {
        console.error("[chama] QR generation failed:", e);
        if (!cancelled) setError(true);
      }
    })();

    return () => { cancelled = true; };
  }, [data, size, fgColor, bgColor]);

  if (error) {
    return (
      <div style={{
        width: size, height: size, display: "flex",
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
        width: size, height: size, display: "flex",
        alignItems: "center", justifyContent: "center",
      }}>
        <div style={{
          width: 24, height: 24, border: "2px solid #a78bfa",
          borderTopColor: "transparent", borderRadius: "50%",
          animation: "spin 1s linear infinite",
        }} />
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      </div>
    );
  }

  return (
    <img
      src={dataUrl}
      alt="Scan to connect"
      width={size}
      height={size}
      style={{ borderRadius: 8 }}
    />
  );
}

export default QRCode;
