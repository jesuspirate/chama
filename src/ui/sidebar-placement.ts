import { useEffect, useState } from 'react';
import { NAV_WIDE_MIN_PX } from './components/BottomNav.js';

/** Presentation-only placement; the existing controls and callbacks are reused. */
export function useSidebarWidth(): boolean {
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${NAV_WIDE_MIN_PX}px)`);
    const update = () => setWide(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return wide;
}
