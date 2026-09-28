import { useEffect } from 'react';

/** WebView's layout viewport can remain behind the IME even with adjustResize. */
export function useVisualViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        root.style.setProperty('--chama-viewport-height', `${viewport?.height ?? window.innerHeight}px`);
        const composer = document.activeElement?.matches('[data-chat-composer]');
        root.toggleAttribute('data-chat-focused', !!composer);
      });
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', update);
      document.removeEventListener('focusout', update);
      root.style.removeProperty('--chama-viewport-height');
      root.removeAttribute('data-chat-focused');
    };
  }, []);
}
