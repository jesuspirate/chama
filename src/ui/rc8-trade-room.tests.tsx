// rc.8 trade room (Jet, Pixel): the phone trade screen is one page that
// scrolls as a whole, the amount and the three people share one card, and
// the chat is a floating 💬 button with the unread count that opens a sheet
// (ported from #34's 273e6011 onto main's read marks). The button never sits
// on a decision control, a hold-to-confirm money button above all.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bubbleLift } from "./phone-trade-chat.js";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

{
  // The bubble rests 20px above the bottom, 16px from the right, 60px square.
  const vp = { width: 412, height: 915 };
  assert.equal(bubbleLift(vp, []), 0, "nothing to avoid: it rests in place");
  assert.equal(bubbleLift(vp, [{ left: 16, right: 180, top: 820, bottom: 880 }]), 0, "a control to the left is not covered");
  const hold = { left: 16, right: 396, top: 800, bottom: 860 };
  const lifted = bubbleLift(vp, [hold]);
  assert.ok(lifted > 0, "a hold button under the bubble lifts it");
  const bubbleBottom = vp.height - 20 - lifted;
  assert.ok(bubbleBottom <= hold.top, "the lifted bubble ends above the hold button");
  const picker = { left: 16, right: 396, top: 730, bottom: 780 };
  const both = bubbleLift(vp, [hold, picker]);
  assert.ok(vp.height - 20 - both <= picker.top, "and above a control stacked over it");
  assert.equal(bubbleLift(vp, [{ left: 16, right: 396, top: 100, bottom: 160 }]), 0, "controls far above do not move it");
}
console.log("PASS chat bubble: never covers a decision control");

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
  assert.match(lts, /\{phoneChat\.show && <button ref=\{bubbleRef\}[^>]*className="lts-chat-bubble" data-chat-bubble/);
  assert.match(lts, /aria-label=\{tr\("lts\.chatUnread", \{ count: phoneChat\.count \}\)\} aria-haspopup="dialog"/);
  assert.match(lts, /\{phoneChat\.open && <OverlaySheet fullHeight showClose showDone=\{false\} title=\{chatTitle\}/);
  assert.match(lts, /useBubbleDodge\(bubbleRef, rootRef, phoneChat\.show, phoneChat\.pulse\);/);
  assert.match(lts, /<div ref=\{rootRef\} className="lts-root"/);
  const chat = read("./phone-trade-chat.ts");
  assert.match(chat, /import \{ countUnreadChat, getLastReadChatAt, markChatRead \} from "\.\.\/chat\/unread\.js";/, "the same read marks as the trade list");
  assert.match(chat, /openChat: \(\) => \{ setReadAt\(markChatRead\(state\.id\)\); setOpen\(true\); \}/);
  assert.match(chat, /const seated = myRole !== null;/, "only someone with a seat has a chat");
  assert.match(chat, /\.lts-decision-well button, \.lts-decision-well \[data-hold-state\]/, "the bubble avoids every decision control");
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
