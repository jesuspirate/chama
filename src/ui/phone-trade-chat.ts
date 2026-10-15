// Phone trade chat (Jet, 6.4.25-rc.8 on a Pixel): on phones the chat no
// longer shares the screen with the decision. It is a floating 💬 button with
// the unread count that opens the chat as a full-height sheet, so the
// decision has the whole page and never scrolls inside a box. Ported from
// the redesign branch (#34, 273e6011), on main's own read marks
// (chat/unread.ts) so the trade list and this button agree.
import { useEffect, useRef, useState } from "react";
import { countUnreadChat, getLastReadChatAt, markChatRead } from "../chat/unread.js";
import type { EscrowState, Role } from "../escrow-engine/types.js";
import { T } from "./theme.js";

export const PHONE_TRADE_QUERY = "(max-width:720px)";

function usePhone(): boolean {
  const [phone, setPhone] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(PHONE_TRADE_QUERY).matches);
  useEffect(() => {
    const media = window.matchMedia?.(PHONE_TRADE_QUERY);
    if (!media) return;
    const update = () => setPhone(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return phone;
}

/** `seated`: only someone with a seat has a chat (the same rule ChatPanel
 *  and the trade list use). Desktop keeps the chat pane beside the decision,
 *  where reading it marks it read. */
export function usePhoneTradeChat(state: EscrowState, myRole: Role | null) {
  const phone = usePhone();
  const seated = myRole !== null;
  const [open, setOpen] = useState(false);
  const [readAt, setReadAt] = useState(() => getLastReadChatAt(state.id));
  const [pulse, setPulse] = useState(0);
  const seen = useRef(new Set(state.chatMessages.map(m => m.raw.id)));
  useEffect(() => {
    setOpen(false);
    setReadAt(getLastReadChatAt(state.id));
    seen.current = new Set(state.chatMessages.map(m => m.raw.id));
  }, [state.id]);
  const unread = countUnreadChat(state.chatMessages, myRole, readAt);
  useEffect(() => {
    if (seated && (open || !phone)) setReadAt(markChatRead(state.id));
    else if (seated && state.chatMessages.some(m => !seen.current.has(m.raw.id) && m.payload?.senderRole !== myRole)) setPulse(n => n + 1);
    seen.current = new Set(state.chatMessages.map(m => m.raw.id));
  }, [state.chatMessages, open, phone, seated, state.id, myRole]);
  useEffect(() => { if (!phone || !seated) setOpen(false); }, [phone, seated]);
  return {
    phone,
    show: phone && seated,
    open: open && phone && seated,
    count: unread,
    pulse,
    openChat: () => { setReadAt(markChatRead(state.id)); setOpen(true); },
    closeChat: () => setOpen(false),
  };
}

export function phoneTradeChatCss(): string {
  return `
  .lts-chat-bubble{display:none}
  @keyframes ltsChatPulse{0%,100%{transform:scale(1)}40%{transform:scale(1.12)}}
  .lts-chat-bubble[data-pulse="true"]{animation:ltsChatPulse 420ms ease-out}
  @media (prefers-reduced-motion:reduce){.lts-chat-bubble[data-pulse="true"]{animation:none}}
  @media ${PHONE_TRADE_QUERY}{
    .lts-chat-bubble{position:fixed;display:flex;align-items:center;justify-content:center;right:16px;
      bottom:calc(20px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;
      border:1px solid ${T.line};background:${T.ink};color:${T.bg};box-shadow:0 4px 16px #0003;z-index:120;cursor:pointer}
  }`;
}

const BUBBLE = 60, BUBBLE_RIGHT = 16, BUBBLE_BOTTOM = 20, GAP = 10;

/** How far above its resting place the bubble must sit so it never covers a
 *  control of the decision (a hold-to-confirm money button above all): it
 *  rises above whatever it would overlap. Pure for tests. */
export function bubbleLift(viewport: { width: number; height: number }, controls: readonly { top: number; bottom: number; left: number; right: number }[]): number {
  let bottom = BUBBLE_BOTTOM;
  for (let pass = 0; pass < 4; pass++) {
    const box = { left: viewport.width - BUBBLE_RIGHT - BUBBLE - GAP, right: viewport.width - BUBBLE_RIGHT + GAP,
      top: viewport.height - bottom - BUBBLE - GAP, bottom: viewport.height - bottom + GAP };
    const hit = controls.filter(c => c.bottom > box.top && c.top < box.bottom && c.right > box.left && c.left < box.right);
    if (!hit.length) return bottom - BUBBLE_BOTTOM;
    bottom = viewport.height - Math.min(...hit.map(c => c.top)) + GAP;
  }
  return bottom - BUBBLE_BOTTOM;
}

/** Keeps the floating bubble clear of the decision's controls as the page
 *  scrolls or changes. */
export function useBubbleDodge(bubble: { current: HTMLElement | null }, root: { current: HTMLElement | null }, active: boolean, remount: number): void {
  useEffect(() => {
    const scroller = root.current;
    if (!active || !scroller) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const el = bubble.current;
      if (!el) return;
      const controls = Array.from(scroller.querySelectorAll<HTMLElement>(".lts-decision-well button, .lts-decision-well [data-hold-state], .lts-decision-well input, .lts-decision-well textarea"))
        .map(c => c.getBoundingClientRect()).filter(r => r.width > 0 && r.height > 0);
      const lift = bubbleLift({ width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight }, controls);
      // `translate`, not `transform`: the arrival pulse animates transform.
      el.style.translate = lift > 0 ? `0 ${-lift}px` : "";
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };
    place();
    scroller.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    observer?.observe(scroller);
    const content = scroller.querySelector(".lts-decision-well");
    if (content) observer?.observe(content);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      observer?.disconnect();
    };
  }, [active, bubble, root, remount]);
}
