import { useEffect } from 'react';

/** Safari pans its visual viewport as well as shrinking it for the keyboard. */
export function trackVisualViewport(win: Window = window, doc: Document = document): () => void {
  const viewport = win.visualViewport;
  const root = doc.documentElement;
  let frame = 0;
  const update = () => {
    win.cancelAnimationFrame(frame);
    frame = win.requestAnimationFrame(() => {
      root.style.setProperty('--chama-viewport-height', `${viewport?.height ?? win.innerHeight}px`);
      root.style.setProperty('--chama-viewport-top', `${viewport?.offsetTop ?? 0}px`);
      root.style.setProperty('--chama-viewport-left', `${viewport?.offsetLeft ?? 0}px`);
      root.style.setProperty('--chama-viewport-width', `${viewport?.width ?? win.innerWidth}px`);
      root.toggleAttribute('data-chat-focused', !!doc.activeElement?.matches('[data-chat-composer]'));
    });
  };
  update();
  viewport?.addEventListener('resize', update);
  viewport?.addEventListener('scroll', update);
  win.addEventListener('resize', update);
  doc.addEventListener('focusin', update);
  doc.addEventListener('focusout', update);
  return () => {
    win.cancelAnimationFrame(frame);
    viewport?.removeEventListener('resize', update);
    viewport?.removeEventListener('scroll', update);
    win.removeEventListener('resize', update);
    doc.removeEventListener('focusin', update);
    doc.removeEventListener('focusout', update);
    for (const key of ['height', 'top', 'left', 'width']) root.style.removeProperty(`--chama-viewport-${key}`);
    root.removeAttribute('data-chat-focused');
  };
}

export function useVisualViewport(): void {
  useEffect(() => trackVisualViewport(), []);
}
