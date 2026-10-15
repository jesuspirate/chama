// Phone trade chat (Jet, 6.4.25-rc.8 on a Pixel): on phones the chat no
// longer shares the screen with the decision. It is a floating 💬 button with
// the unread count that opens the chat as a full-height sheet, so the
// decision has the whole page and never scrolls inside a box. The button is
// fixed bottom-right above the trade view at every scroll position (Jet,
// rc.9: it used to hop up the screen to dodge controls). Ported from
// the redesign branch (#34, 273e6011), on main's own read marks
// (chat/unread.ts) so the trade list and this button agree.
import { useEffect, useRef, useState } from "react";
import { countUnreadChat, getLastReadChatAt, markChatReadThrough } from "../chat/unread.js";
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
    if (seated && (open || !phone)) setReadAt(markChatReadThrough(state.id, state.chatMessages));
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
    openChat: () => { setReadAt(markChatReadThrough(state.id, state.chatMessages)); setOpen(true); },
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
