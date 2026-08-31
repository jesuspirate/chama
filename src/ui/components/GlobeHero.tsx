// PHILOSOPHY.md §6 "Hey Chama, where's home?" onboarding hero.
//
// This used to run a cobe WebGL globe on an unbounded requestAnimationFrame
// loop. The country picker is often opened in several browser profiles during
// remote-bridge testing; one such profile was observed making Chrome's renderer
// unresponsive with no application exception. Motion here is decorative, so
// keep onboarding cheap and deterministic instead of spending GPU/CPU for the
// entire time a visitor considers their country.

import { useEffect, useRef } from "react";

type Marker = readonly [number, number];

export function GlobeHero({
  size = 190,
  onReady,
}: {
  size?: number;
  /** Retained for call-site compatibility; the static asset has baked-in dots. */
  markers?: readonly Marker[];
  /** Fires after the actual rendered artwork has decoded (or fails open). */
  onReady?: () => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const onReadyRef = useRef(onReady);
  const didReportReady = useRef(false);
  onReadyRef.current = onReady;

  const reportReady = () => {
    if (didReportReady.current) return;
    didReportReady.current = true;
    onReadyRef.current?.();
  };

  const decodeThenReport = (image: HTMLImageElement) => {
    if (typeof image.decode === "function") image.decode().then(reportReady, reportReady);
    else reportReady();
  };

  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) decodeThenReport(image);
    // Some embedded webviews do not reliably emit an image error. Never leave
    // onboarding permanently hidden if the asset genuinely cannot be read.
    const failOpen = window.setTimeout(reportReady, 2500);
    return () => window.clearTimeout(failOpen);
  }, []);

  return (
    <div
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0c1e2c",
        border: "1px solid #2a2a3e",
      }}
    >
      <img
        ref={imageRef}
        src="/icons/africa-globe-base.png"
        alt=""
        width={size}
        height={size}
        loading="eager"
        decoding="sync"
        onLoad={(event) => decodeThenReport(event.currentTarget)}
        onError={reportReady}
        draggable={false}
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          opacity: 0.92,
          userSelect: "none",
        }}
      />
    </div>
  );
}
