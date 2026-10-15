// rc.8 trade room (Jet, Pixel): the phone trade screen is one page that
// scrolls as a whole, the amount and the three people share one card, and
// the chat is a floating 💬 button with the unread count that opens a sheet
// (ported from #34's 273e6011 onto main's read marks). rc.9: the button stays
// fixed bottom-right at every scroll position; the page ends with room for it
// so the last control scrolls clear instead of the button moving.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

{
  const lts = read("./screens/LiveTradeSurface.tsx");
  const chat = read("./phone-trade-chat.ts");
  // Fixed bottom-right, above the trade view, at every scroll position.
  const bubbleCss = chat.slice(chat.indexOf(".lts-chat-bubble{position:fixed;"), chat.indexOf("cursor:pointer}"));
  assert.match(bubbleCss, /right:16px;\s*bottom:calc\(20px \+ env\(safe-area-inset-bottom,0px\)\);/);
  assert.match(bubbleCss, /z-index:120/);
  assert.doesNotMatch(chat + lts, /useBubbleDodge|bubbleLift|style\.translate/, "it never moves to dodge controls");
  // The page ends with room for it, so the last control scrolls clear of it.
  assert.match(lts, /\.lts-root\{padding-bottom:calc\(96px \+ env\(safe-area-inset-bottom,0px\)\)!important\}/);
}
console.log("PASS chat bubble: fixed bottom-right at every scroll position; the last control scrolls clear of it");

{
  const lts = read("./screens/LiveTradeSurface.tsx");
  const phone = lts.slice(lts.indexOf("/* Phones (Jet, 6.4.25-rc.8 on a Pixel)"), lts.indexOf("@keyframes ltsPulse"));
  assert.match(phone, /\.lts-root\{overflow-y:auto/, "the page scrolls as one");
  assert.match(phone, /\.lts-pane\.lts-votes\{overflow:visible;max-height:none/, "no scroll box inside the page");
  assert.match(phone, /\.lts-chat\{display:none\}/, "the chat leaves the page on phones");
  assert.match(phone, /\.lts-home\{display:none!important\}/, "no extra wordmark row");
  assert.match(phone, /\.lts-summary\{margin:12px 16px;border-radius:\$\{T\.rCard\}px;background:\$\{T\.surface\};border:1px solid \$\{T\.line\}\}/, "amount and people share one card");
  assert.match(phone, /\.lts-person-name\{white-space:nowrap;overflow:hidden;text-overflow:ellipsis\}/, "long names stay on one line");
  assert.match(phone, /\.lts-person-conduct\{display:none\}/);
  assert.match(lts, /<span className="lts-person-conduct"><ConductFacts pubkey=\{person\.pubkey\} \/><\/span>/);
  assert.match(lts, /<ConductFacts pubkey=\{party\.pubkey\} \/>/, "the record stays one tap away in the person's sheet");
  assert.doesNotMatch(lts, /calc\(var\(--chama-viewport-height, 100dvh\) \* \.52\)/, "the old half-screen pane is gone");
  // Chat: the desktop pane stays; phones get the bubble and a full-height sheet.
  assert.match(lts, /\{!phoneChat\.phone && <div className="lts-pane lts-chat">/);
  assert.match(lts, /\{phoneChat\.show && <button key=\{phoneChat\.pulse\} type="button" className="lts-chat-bubble" data-chat-bubble/);
  assert.match(lts, /aria-label=\{tr\("lts\.chatUnread", \{ count: phoneChat\.count \}\)\} aria-haspopup="dialog"/);
  assert.match(lts, /\{phoneChat\.open && <OverlaySheet fullHeight showClose showDone=\{false\} title=\{chatTitle\}/);
  assert.match(lts, /<div ref=\{rootRef\} className="lts-root"/);
  const chat = read("./phone-trade-chat.ts");
  assert.match(chat, /import \{ countUnreadChat, getLastReadChatAt, markChatRead \} from "\.\.\/chat\/unread\.js";/, "the same read marks as the trade list");
  assert.match(chat, /openChat: \(\) => \{ setReadAt\(markChatRead\(state\.id\)\); setOpen\(true\); \}/);
  assert.match(chat, /const seated = myRole !== null;/, "only someone with a seat has a chat");
  const sheet = read("./components/OverlaySheet.tsx");
  assert.match(sheet, /fullHeight = false/);
  assert.match(sheet, /alignItems: fullHeight \? "flex-end" : "center"/);
  for (const lang of ["en", "es", "fr", "sw"]) {
    const strings = read(`../i18n/${lang}/lts.ts`);
    for (const key of ["lts.chatWith", "lts.chatWithArbiter", "lts.chatUnread", "lts.chatParticipants"]) {
      assert.match(strings, new RegExp(`"${key.replace(".", "\\.")}":`), `${lang} ${key}`);
    }
  }
}
console.log("PASS trade room on phones: one page, one trade card, chat behind the 💬 button");
