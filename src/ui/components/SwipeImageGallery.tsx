import { useRef, useState } from "react";
import { T } from "../theme.js";

export function SwipeImageGallery({
  images,
  height,
  edgeToEdge = false,
  label = "Listing photos",
}: {
  images: string[];
  height: number;
  edgeToEdge?: boolean;
  label?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const multiple = images.length > 1;

  const scrollToIndex = (index: number) => {
    const scroller = scrollerRef.current;
    const target = scroller?.children[index] as HTMLElement | undefined;
    if (!scroller || !target) return;
    scroller.scrollTo({ left: target.offsetLeft - scroller.offsetLeft, behavior: "smooth" });
  };

  const updateActiveIndex = () => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const slides = Array.from(scroller.children) as HTMLElement[];
    let closest = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < slides.length; index += 1) {
      const nextDistance = Math.abs(slides[index].offsetLeft - scroller.offsetLeft - scroller.scrollLeft);
      if (nextDistance < distance) {
        closest = index;
        distance = nextDistance;
      }
    }
    setActiveIndex(closest);
  };

  if (images.length === 0) return null;

  return (
    <div
      aria-label={label}
      style={{
        position: "relative",
        margin: edgeToEdge ? "-14px -14px 12px" : 0,
        overflow: "hidden",
        background: T.surface,
      }}
    >
      <div
        ref={scrollerRef}
        onScroll={updateActiveIndex}
        className="payment-rail-scroll"
        style={{
          display: "flex",
          gap: multiple ? 8 : 0,
          height,
          overflowX: multiple ? "auto" : "hidden",
          overflowY: "hidden",
          scrollSnapType: "x mandatory",
          scrollBehavior: "smooth",
          WebkitOverflowScrolling: "touch",
          scrollbarWidth: "none",
          touchAction: "pan-x",
          paddingRight: multiple ? 34 : 0,
        }}
      >
        {images.map((src, index) => (
          <div
            key={`${src.slice(0, 32)}_${index}`}
            style={{
              flex: multiple ? "0 0 calc(100% - 34px)" : "0 0 100%",
              height: "100%",
              scrollSnapAlign: "start",
              overflow: "hidden",
              background: T.card,
            }}
          >
            <img
              src={src}
              alt=""
              draggable={false}
              style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
            />
          </div>
        ))}
      </div>

      {multiple && (
        <>
          {activeIndex > 0 && (
            <button
              type="button"
              aria-label="Previous photo"
              onClick={event => {
                event.stopPropagation();
                scrollToIndex(activeIndex - 1);
              }}
              style={{ ...arrowStyle, left: 8 }}
            >
              ‹
            </button>
          )}
          {activeIndex < images.length - 1 && (
            <button
              type="button"
              aria-label="Next photo"
              onClick={event => {
                event.stopPropagation();
                scrollToIndex(activeIndex + 1);
              }}
              style={{ ...arrowStyle, right: 42 }}
            >
              ›
            </button>
          )}
          <div style={{
            position: "absolute", right: 8, bottom: 8,
            display: "inline-flex", alignItems: "center", gap: 5,
            padding: "4px 7px", borderRadius: 999,
            background: "rgba(6, 6, 12, 0.72)", color: "#fff",
            fontFamily: T.sans, fontSize: T.fs.secondary, fontWeight: 700,
            pointerEvents: "none",
          }}>
            ↔ {activeIndex + 1}/{images.length}
          </div>
          <div style={{
            position: "absolute", left: "50%", bottom: 9,
            transform: "translateX(-50%)", display: "flex", gap: 4,
            pointerEvents: "none",
          }}>
            {images.map((_, index) => (
              <span key={index} style={{
                width: index === activeIndex ? 12 : 4,
                height: 4,
                borderRadius: 999,
                background: index === activeIndex ? "#fff" : "rgba(255,255,255,.48)",
                transition: "width .18s ease, background .18s ease",
              }} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const arrowStyle = {
  position: "absolute" as const,
  top: "50%",
  transform: "translateY(-50%)",
  zIndex: 2,
  width: 34,
  height: 34,
  padding: 0,
  borderRadius: 999,
  border: "1px solid rgba(255,255,255,.24)",
  background: "rgba(6, 6, 12, 0.66)",
  color: "#fff",
  fontSize: 23,
  lineHeight: 1,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  textIndent: 0,
  cursor: "pointer",
  backdropFilter: "blur(5px)",
};
