import { useEffect, useRef, useState } from 'react';
import type { EscrowState } from '../escrow-engine/types.js';
import { T } from './theme.js';

type Messages = EscrowState['chatMessages'];
export function unreadTradeMessages(messages: Messages, viewer: string, parties: readonly string[], lastSeen: number): Messages {
  const seats = new Set(parties.map(p => p.toLowerCase()));
  return messages.filter(message => message.raw.pubkey.toLowerCase() !== viewer.toLowerCase()
    && seats.has(message.raw.pubkey.toLowerCase()) && message.raw.created_at > lastSeen);
}
const seenKey = (trade: string, viewer: string) => `chama-chat-seen:${viewer.toLowerCase()}:${trade}`;
export function readChatSeen(trade: string, viewer: string): number {
  try { const value = Number(localStorage.getItem(seenKey(trade, viewer))); return Number.isFinite(value) && value >= 0 ? value : 0; }
  catch { return 0; }
}
export function writeChatSeen(trade: string, viewer: string, at: number): void {
  try { localStorage.setItem(seenKey(trade, viewer), String(at)); } catch { /* Private mode keeps the in-memory receipt. */ }
}
export function usePhoneTradeChat(trade: string, viewer: string, messages: Messages, parties: readonly string[], seated: boolean) {
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width:720px)').matches);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(() => readChatSeen(trade, viewer));
  const [pulse, setPulse] = useState(0);
  const previous = useRef(new Set(messages.map(m => m.raw.id)));
  useEffect(() => {
    const media = window.matchMedia('(max-width:720px)');
    const update = () => setPhone(media.matches);
    update(); media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => { setOpen(false); setSeen(readChatSeen(trade, viewer)); previous.current = new Set(messages.map(m => m.raw.id)); }, [trade, viewer]);
  const unread = unreadTradeMessages(messages, viewer, parties, seen);
  const latest = Math.max(0, ...messages.map(m => m.raw.created_at));
  const markSeen = () => {
    const at = Math.max(Date.now() / 1000, latest);
    setSeen(at); writeChatSeen(trade, viewer, at);
  };
  useEffect(() => {
    if (seated && (open || !phone)) markSeen();
    else if (seated && unread.some(m => !previous.current.has(m.raw.id))) setPulse(n => n + 1);
    previous.current = new Set(messages.map(m => m.raw.id));
  }, [messages, latest, open, phone, seated, trade, viewer]);
  useEffect(() => { if (!phone || !seated) setOpen(false); }, [phone, seated]);
  return { phone, open: open && phone && seated, count: unread.length, pulse,
    show: phone && seated, openChat: () => { markSeen(); setOpen(true); }, closeChat: () => setOpen(false) };
}

export function phoneTradeChatCss(): string {
  return `
  .lts-chat-bubble{display:none}
  @keyframes ltsChatPulse{0%,100%{transform:scale(1)}40%{transform:scale(1.12)}}
  .lts-chat-bubble[data-pulse="true"]{animation:ltsChatPulse 420ms ease-out}
  @media(prefers-reduced-motion:reduce){.lts-chat-bubble[data-pulse="true"]{animation:none}}
  @media(max-width:720px){
    .lts-grid{grid-template-columns:1fr;grid-template-rows:1fr}
    .lts-grid .lts-chat{display:none}
    .lts-votes{max-height:none!important;padding-bottom:calc(156px + env(safe-area-inset-bottom,0px))!important}
    .lts-grid.lts-prejoin .lts-votes{padding-bottom:18px!important}
    .lts-chat-bubble{position:fixed;display:flex;align-items:center;justify-content:center;right:16px;bottom:calc(80px + env(safe-area-inset-bottom,0px));width:60px;height:60px;border-radius:50%;border:1px solid ${T.line};background:${T.ink};color:${T.onInk};box-shadow:0 4px 16px #0003;z-index:120;cursor:pointer}
    .lts-prejoin~.lts-chat-bubble{display:none}
  }`;
}
