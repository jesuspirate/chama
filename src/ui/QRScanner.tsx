import { useState, useEffect, useRef, useCallback } from "react";
import jsQR from "jsqr";

interface QRScannerProps {
  onScan: (data: string) => void;
  onClose: () => void;
}

export default function QRScanner({ onScan, onClose }: QRScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const [pasteMode, setPasteMode] = useState(false);
  const [pasteInput, setPasteInput] = useState("");
  const animFrameRef = useRef<number>(0);
  const lastScanRef = useRef<number>(0);

  const stopCamera = useCallback(() => {
    setScanning(false);
    cancelAnimationFrame(animFrameRef.current);
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (pasteMode) return;
    let mounted = true;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 960 },
          }
        });
        if (!mounted) { stream.getTracks().forEach(t => t.stop()); return; }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
      } catch (e: any) {
        if (mounted) setError(e.message || "Camera access denied");
      }
    })();
    return () => { mounted = false; stopCamera(); };
  }, [stopCamera, pasteMode]);

  useEffect(() => {
    if (!scanning || pasteMode) return;

    const tick = () => {
      const now = Date.now();
      // Scan every 200ms instead of every frame — gives camera time to focus
      if (now - lastScanRef.current < 200) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }
      lastScanRef.current = now;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState !== video.HAVE_ENOUGH_DATA) {
        animFrameRef.current = requestAnimationFrame(tick);
        return;
      }

      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) { animFrameRef.current = requestAnimationFrame(tick); return; }

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      // Try both normal and inverted for better detection
      const code = jsQR(imageData.data, imageData.width, imageData.height, {
        inversionAttempts: "attemptBoth",
      });

      if (code && code.data) {
        stopCamera();
        onScan(code.data);
        return;
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };

    animFrameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [scanning, onScan, stopCamera, pasteMode]);

  const handlePaste = () => {
    const v = pasteInput.trim();
    if (v) { onScan(v); }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "#000", zIndex: 9999,
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    }}>
      {error ? (
        <div style={{ color: "#f87171", fontFamily: "monospace", fontSize: 14, padding: 32, textAlign: "center" }}>
          Camera: {error}
          <div style={{ marginTop: 16, display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => { setError(null); setPasteMode(true); }} style={{
              padding: "12px 24px", background: "#a78bfa22", border: "1px solid #a78bfa44",
              borderRadius: 8, color: "#a78bfa", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Paste instead</button>
            <button onClick={onClose} style={{
              padding: "12px 24px", background: "#1e1e2e", border: "1px solid #333",
              borderRadius: 8, color: "#999", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Close</button>
          </div>
        </div>
      ) : pasteMode ? (
        <div style={{ padding: 32, width: "100%", maxWidth: 360 }}>
          <div style={{ fontSize: 11, color: "#a78bfa", fontFamily: "monospace", marginBottom: 12, letterSpacing: 1, textAlign: "center" }}>
            PASTE NSEC OR BUNKER URI
          </div>
          <input
            value={pasteInput}
            onChange={(e) => setPasteInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handlePaste()}
            placeholder="nsec1... or nostrconnect://..."
            type="password"
            autoFocus
            style={{
              width: "100%", padding: "14px 16px", boxSizing: "border-box" as const,
              background: "#1e1e2e", border: "1px solid #333",
              borderRadius: 8, color: "#e0e0e0",
              fontFamily: "monospace", fontSize: 12, outline: "none",
              marginBottom: 12,
            }}
          />
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handlePaste} style={{
              flex: 1, padding: "12px", background: "#a78bfa", border: "none",
              borderRadius: 8, color: "#000", fontFamily: "monospace", fontSize: 13,
              fontWeight: 700, cursor: "pointer",
            }}>Submit</button>
            <button onClick={() => { setPasteMode(false); setError(null); }} style={{
              padding: "12px 20px", background: "#1e1e2e", border: "1px solid #333",
              borderRadius: 8, color: "#999", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Camera</button>
            <button onClick={onClose} style={{
              padding: "12px 20px", background: "#1e1e2e", border: "1px solid #333",
              borderRadius: 8, color: "#999", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Close</button>
          </div>
        </div>
      ) : (
        <>
          <div style={{ position: "relative", width: "100%", maxWidth: 400 }}>
            <video ref={videoRef} playsInline muted
              style={{ width: "100%", borderRadius: 12, display: "block" }} />
            <div style={{
              position: "absolute", inset: "15%",
              border: "2px solid #a78bfa88", borderRadius: 16,
              boxShadow: "0 0 0 9999px rgba(0,0,0,0.4)",
            }} />
            <div style={{
              position: "absolute", top: "15%", left: "50%",
              transform: "translateX(-50%) translateY(-28px)",
              color: "#a78bfa", fontFamily: "monospace", fontSize: 11,
              fontWeight: 600, letterSpacing: 1,
            }}>POINT AT QR CODE</div>
          </div>
          <canvas ref={canvasRef} style={{ display: "none" }} />
          <div style={{ display: "flex", gap: 12, marginTop: 24 }}>
            <button onClick={() => { stopCamera(); setPasteMode(true); }} style={{
              padding: "14px 32px", background: "#a78bfa22", border: "1px solid #a78bfa44",
              borderRadius: 8, color: "#a78bfa", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Paste instead</button>
            <button onClick={() => { stopCamera(); onClose(); }} style={{
              padding: "14px 32px", background: "none", border: "1px solid #555",
              borderRadius: 8, color: "#999", fontFamily: "monospace", fontSize: 12, cursor: "pointer",
            }}>Cancel</button>
          </div>
        </>
      )}
    </div>
  );
}
