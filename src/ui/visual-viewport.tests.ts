import assert from 'node:assert/strict';
import { trackVisualViewport } from './useVisualViewport.js';
const values = new Map<string, string>();
let focused = false, attribute = false;
const viewport = Object.assign(new EventTarget(), { height: 800, width: 390, offsetTop: 0, offsetLeft: 0 });
let callback: FrameRequestCallback | undefined;
const win = Object.assign(new EventTarget(), { visualViewport: viewport, innerHeight: 800, innerWidth: 390,
  requestAnimationFrame: (fn: FrameRequestCallback) => { callback = fn; return 1; }, cancelAnimationFrame: () => { callback = undefined; } });
const doc = Object.assign(new EventTarget(), { activeElement: { matches: () => focused }, documentElement: {
  style: { setProperty: (k: string, v: string) => values.set(k,v), removeProperty: (k: string) => values.delete(k) },
  toggleAttribute: (_: string, v: boolean) => { attribute = v; }, removeAttribute: () => { attribute = false; },
} });
const stop = trackVisualViewport(win as unknown as Window, doc as unknown as Document);
const flush = () => { const fn = callback; callback = undefined; fn?.(0); };
flush();
assert.equal(values.get('--chama-viewport-height'), '800px');
focused = true; doc.dispatchEvent(new Event('focusin')); flush();
assert.equal(attribute, true);
viewport.height = 410; viewport.offsetTop = 160;
viewport.dispatchEvent(new Event('resize')); flush();
assert.equal(values.get('--chama-viewport-height'), '410px');
assert.equal(values.get('--chama-viewport-top'), '160px', 'the room follows Safari keyboard panning');
viewport.offsetTop = 220; viewport.dispatchEvent(new Event('scroll')); flush();
assert.equal(values.get('--chama-viewport-top'), '220px', 'scroll without resize still repositions the room');
focused = false; doc.dispatchEvent(new Event('focusout')); flush();
assert.equal(attribute, false, 'normal document scrolling resumes on blur');
stop();
viewport.dispatchEvent(new Event('resize')); flush();
assert.equal(values.size, 0, 'unmount removes geometry and listeners');
console.log('PASS visual viewport keyboard resize, pan, blur and cleanup');
