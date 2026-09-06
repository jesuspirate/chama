import { useEffect, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import { type ChatImageAttachment, type EscrowState, EscrowStatus, Role } from "../../escrow-engine/types.js";
import { T } from "../theme.js";
import { useT } from "../../i18n/index.js";
import { RatingTap } from "../components/RatingTap.js";
import type { RatingThumb } from "../../reputation/ratings.js";
import { randomId } from "../../storage/random-id.js";
import {
  type SystemBubble,
  type SystemBubbleTone,
  isStructuredMarkDoneMessage,
} from "../../labels/trade-progress.js";

type ChatMessage = EscrowState["chatMessages"][number];

// One entry in the living feed: a human message bubble, or a centered system
// bubble (a lifecycle event from the chain, or a structured mark-done note that
// rode the chat). Woven together and sorted by time.
type FeedItem =
  | { kind: "msg"; at: number; key: string; chat: ChatMessage }
  | { kind: "sys"; at: number; key: string; bubble: SystemBubble };

/** Merge human chat messages with derived system bubbles into one time-sorted
 *  feed. Structured mark-done notes (any vertical) are lifted out of the speech
 *  stream into green system bubbles so the deed reads as a trade event, not a
 *  message. Pure + display-only — publishes nothing. */
function weaveFeed(messages: ChatMessage[], systemBubbles: SystemBubble[]): FeedItem[] {
  const items: FeedItem[] = [];
  messages.forEach((chat, i) => {
    const p = chat.payload as { sentAt?: number; message?: string };
    const at = p.sentAt ?? chat.raw.created_at ?? 0;
    const key = chat.raw.id || `m${i}`;
    if (isStructuredMarkDoneMessage(p.message)) {
      items.push({ kind: "sys", at, key, bubble: { key, at, icon: "", text: p.message!, tone: "green" } });
    } else {
      items.push({ kind: "msg", at, key, chat });
    }
  });
  for (const b of systemBubbles) items.push({ kind: "sys", at: b.at, key: b.key, bubble: b });
  // Stable sort by time (Array.prototype.sort is stable in modern engines), so
  // bubbles sharing a second keep their natural create→lock→vote order.
  return items.sort((a, b) => a.at - b.at);
}

// System-bubble palette — colour follows meaning (living-chat mockup).
function sysToneStyle(tone: SystemBubbleTone): CSSProperties {
  const map: Record<SystemBubbleTone, { bg: string; bd: string; c: string; w?: number }> = {
    teal:  { bg: `${T.teal}14`,   bd: `${T.teal}3a`,   c: T.teal },
    lock:  { bg: `${T.purple}14`, bd: `${T.purple}3a`, c: T.purple },
    green: { bg: `${T.green}14`,  bd: `${T.green}3a`,  c: T.green },
    vote:  { bg: `${T.accent}14`, bd: `${T.accent}3a`, c: T.accent },
    amber: { bg: `${T.amber}14`,  bd: `${T.amber}3a`,  c: T.amber },
    win:   { bg: `${T.green}1c`,  bd: `${T.green}55`,  c: T.green, w: 800 },
  };
  const s = map[tone] ?? map.green;
  return {
    alignSelf: "center", display: "inline-flex", alignItems: "center", gap: 6,
    maxWidth: "90%", textAlign: "center", padding: "7px 14px", borderRadius: 20,
    fontSize: 12, fontWeight: s.w ?? 700, lineHeight: 1.35,
    background: s.bg, border: `1px solid ${s.bd}`, color: s.c, fontFamily: T.sans,
  };
}

// The chat body (message + image) is NIP-44-encrypted SEPARATELY to all THREE
// participants in the bodyEnvelope, so the published event is roughly
// 3 × (1.33 × image) + overhead ≈ 4× the image dataUrl. Relays drop events over
// MAX_EVENT_CONTENT_BYTES (128 KB) on BOTH publish and receive — silently — so a
// "small enough looking" image never crosses devices. Budget the IMAGE so the
// tripled, base64-inflated event still fits under 128 KB with margin: cap the
// dataUrl at ~24 KB (≈ 4× → ~100 KB event) and shrink the longest edge to keep
// quality usable at that byte budget. (Old values 120 KB / 960 px produced
// ~480 KB events — the silent image-upload failure across APK/Tauri.)
const MAX_CHAT_IMAGE_DATA_URL_CHARS = 24_000;
const CHAT_IMAGE_MAX_EDGE_PX = 720;
const CHAT_IMAGE_ACCEPT = [
  "image/*",
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
].join(",");

const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

type SendChatInput = string | { message: string; attachments?: ChatImageAttachment[] };

async function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Couldn't read image"));
    reader.readAsDataURL(file);
  });
}

async function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Couldn't load image"));
    img.src = dataUrl;
  });
}

function imageId(): string {
  return `img_${Date.now().toString(36)}_${randomId(6)}`;
}

function inferChatImageMimeType(file: File): string | null {
  if (file.type.startsWith("image/")) return file.type;
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME_BY_EXTENSION[extension] ?? null;
}

function normalizeImageDataUrl(file: File, dataUrl: string): string | null {
  if (dataUrl.startsWith("data:image/")) return dataUrl;
  const mimeType = inferChatImageMimeType(file);
  const marker = ";base64,";
  const markerIndex = dataUrl.indexOf(marker);
  if (!mimeType || markerIndex < 0 || !dataUrl.startsWith("data:")) return null;
  return `data:${mimeType};base64,${dataUrl.slice(markerIndex + marker.length)}`;
}

async function prepareChatImage(file: File): Promise<ChatImageAttachment> {
  const mimeType = inferChatImageMimeType(file);
  if (!mimeType) {
    throw new Error("Choose a supported image file");
  }

  const original = normalizeImageDataUrl(file, await readFileAsDataUrl(file));
  if (!original) {
    throw new Error("That file does not look like a supported photo");
  }
  let img: HTMLImageElement | null = null;
  try {
    img = await loadImage(original);
  } catch {
    if (original.length <= MAX_CHAT_IMAGE_DATA_URL_CHARS) {
      return {
        id: imageId(),
        kind: "image",
        mimeType,
        dataUrl: original,
        name: file.name,
        sizeBytes: file.size,
      };
    }
    throw new Error("This browser cannot preview that photo format yet. Try PNG, JPG, or WebP.");
  }
  const width = img.naturalWidth || img.width;
  const height = img.naturalHeight || img.height;

  if (original.length <= MAX_CHAT_IMAGE_DATA_URL_CHARS) {
    return {
      id: imageId(),
      kind: "image",
      mimeType,
      dataUrl: original,
      name: file.name,
      width,
      height,
      sizeBytes: file.size,
    };
  }

  // Re-encode to JPEG, shrinking BOTH the edge and the quality until it fits the
  // per-event byte budget. Phone screenshots (Android + iOS both save PNG) are
  // the common case and decode fine; a dark, low-detail Chama screenshot fits
  // easily at 720px, while a busy or photographic one falls back to smaller
  // edges so it ALWAYS sends rather than hard-failing. The final throw is a
  // clear, non-silent error reserved for pathological input.
  for (const maxEdge of [CHAT_IMAGE_MAX_EDGE_PX, 560, 440, 340]) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Image preview is not available in this browser");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

    for (const quality of [0.72, 0.6, 0.48, 0.38, 0.3]) {
      const dataUrl = canvas.toDataURL("image/jpeg", quality);
      if (dataUrl.length <= MAX_CHAT_IMAGE_DATA_URL_CHARS) {
        return {
          id: imageId(),
          kind: "image",
          mimeType: "image/jpeg",
          dataUrl,
          name: file.name,
          width: targetWidth,
          height: targetHeight,
          sizeBytes: Math.ceil(dataUrl.length * 0.75),
        };
      }
    }
  }

  throw new Error("That image is too large for encrypted chat. Try a tighter screenshot.");
}

export function ChatPanel({ state, myRole, onSend, embedded = false, hideHeader = false, fill = false, systemBubbles = [], ratingCta = null }: {
  state: EscrowState;
  myRole: Role | null;
  onSend: (message: SendChatInput) => void;
  embedded?: boolean;
  /** v4.1 ratings-in-chat: the SAME one-tap counterparty RatingTap, surfaced at the
   *  END of the chat feed at settlement (where the user actually is). Null = hide;
   *  it shares myGivenRatings with the Parties + Me copies, so a tap anywhere
   *  collapses all three to the "you rated" state. */
  ratingCta?: {
    tradeId: string;
    ratee: string;
    ratedThumb?: RatingThumb;
    onRate: (tradeId: string, ratee: string, thumb: RatingThumb) => Promise<void>;
  } | null;
  /** v3.1: suppress the internal "CHAT" header when the panel sits inside a
   *  disclosure row that already supplies the label (avoids a doubled header). */
  hideHeader?: boolean;
  /** TradeView pass: fill the parent's height (flex column) so the message feed
   *  scrolls and the composer pins to the bottom of the pager pane. */
  fill?: boolean;
  /** TradeView pass: lifecycle event bubbles derived from the event chain
   *  (display-only), woven into the message feed by time. */
  systemBubbles?: SystemBubble[];
}) {
  const { t } = useT();
  const [msg, setMsg] = useState("");
  const [attachment, setAttachment] = useState<ChatImageAttachment | null>(null);
  const [viewer, setViewer] = useState<ChatImageAttachment | null>(null);
  const [sending, setSending] = useState(false);
  const [imageBusy, setImageBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Auto-scroll to bottom when new messages or attachments arrive — and (A) when the
  // closing rating CTA appears. The COMPLETED transition adds no new message, so the
  // length-keyed deps miss it and the CTA lands below the fold; key on its presence too.
  const hasRatingCta = Boolean(ratingCta);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [state.chatMessages.length, hasRatingCta]);

  const handleSend = async () => {
    const text = msg.trim();
    if ((!text && !attachment) || !myRole || sending) return;
    setSending(true);
    setErr(null);
    try {
      onSend({
        message: text,
        ...(attachment ? { attachments: [attachment] } : {}),
      });
      setMsg("");
      setAttachment(null);
    } finally {
      setTimeout(() => setSending(false), 500);
    }
  };

  const handleImagePick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = "";
    if (!file || imageBusy) return;
    setImageBusy(true);
    setErr(null);
    try {
      setAttachment(await prepareChatImage(file));
    } catch (error: any) {
      setErr(error?.message || t("chat.couldNotAttachImage"));
    } finally {
      setImageBusy(false);
    }
  };

  const roleColor = (role: string) =>
    role === "buyer" ? "#BF5AF2" : role === "seller" ? "#F7931A" : role === "arbiter" ? "#5AC8FA" : T.muted;

  const roleName = (role: string) =>
    role === "buyer" ? t("chat.roleBuyer") : role === "seller" ? t("chat.roleSeller") : role === "arbiter" ? t("chat.roleArbiter") : t("chat.roleUnknown");

  const canSend = (!!msg.trim() || !!attachment) && !sending && !imageBusy;

  const feed = weaveFeed(state.chatMessages, systemBubbles);
  // #17: a settled trade closes its chat — the composer mutes (post-settlement
  // messages would vanish into the void) and the rating CTA becomes the closing act.
  const chatClosed = state.status === EscrowStatus.COMPLETED;

  return (
    <div style={{
      background: embedded ? "transparent" : T.card,
      border: embedded ? "none" : `1px solid ${T.border}`,
      borderRadius: embedded ? 0 : T.r,
      marginBottom: embedded ? 0 : 16,
      overflow: "hidden",
      ...(fill ? { height: "100%", display: "flex", flexDirection: "column", minHeight: 0 } : {}),
    }}>
      {/* Header */}
      {!hideHeader && (
      <div style={{
        padding: embedded ? "16px 14px 10px" : "12px 16px",
        borderBottom: `1px solid ${T.border}`,
        borderTop: embedded ? `1px solid ${T.border}` : "none",
        display: "flex", justifyContent: "space-between", alignItems: "center",
      }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: T.muted, fontFamily: T.mono, letterSpacing: 1 }}>
          {t("chat.chatHeader")}
        </div>
        <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono }}>
          {state.chatMessages.length !== 1
            ? t("chat.messageCountMany", { count: state.chatMessages.length })
            : t("chat.messageCountOne", { count: state.chatMessages.length })}
        </div>
      </div>
      )}

      {/* Messages — the living feed: human bubbles + system event bubbles. */}
      <div style={{
        ...(fill ? { flex: 1, minHeight: 0 } : { maxHeight: embedded ? 340 : 280 }),
        overflowY: "auto",
        padding: embedded ? "14px 14px" : "12px 16px",
        display: "flex", flexDirection: "column", gap: 10,
      }}>
        {feed.length === 0 ? (
          <div style={{
            textAlign: "center", padding: "20px 0",
            color: T.muted, fontFamily: T.mono, fontSize: 11,
          }}>
            {t("chat.noMessagesYet")}
          </div>
        ) : (
          feed.map((item) => {
            if (item.kind === "sys") {
              return (
                <div key={item.key} style={sysToneStyle(item.bubble.tone)}>
                  {item.bubble.icon ? <span aria-hidden="true">{item.bubble.icon}</span> : null}
                  <span>{item.bubble.text}</span>
                </div>
              );
            }
            const chat = item.chat;
            const payload = chat.payload as any;
            const attachments: ChatImageAttachment[] = Array.isArray(payload.attachments)
              ? payload.attachments.filter((a: any): a is ChatImageAttachment => a?.kind === "image")
              : [];
            const isMe = myRole === payload.senderRole;
            const color = roleColor(payload.senderRole);
            return (
              <div key={item.key} style={{
                display: "flex", flexDirection: "column",
                alignItems: isMe ? "flex-end" : "flex-start",
              }}>
                <div style={{
                  fontSize: 9, color, fontFamily: T.mono,
                  fontWeight: 600, marginBottom: 2,
                }}>
                  {isMe ? t("chat.you") : roleName(payload.senderRole)}
                </div>
                <div style={{
                  padding: attachments.length > 0 ? 6 : "9px 13px",
                  borderRadius: 14,
                  borderBottomRightRadius: isMe ? 4 : 14,
                  borderBottomLeftRadius: isMe ? 14 : 4,
                  background: isMe ? `${color}1f` : T.card,
                  border: `1px solid ${isMe ? color + "44" : T.border}`,
                  maxWidth: "84%",
                }}>
                  {attachments.map((image) => (
                    <button
                      key={image.id}
                      onClick={() => setViewer(image)}
                      style={{
                        display: "block", padding: 0, margin: payload.message ? "0 0 8px" : 0,
                        border: "none", background: "transparent", cursor: "zoom-in",
                        width: "100%", maxWidth: 220,
                      }}
                    >
                      <img
                        src={image.dataUrl}
                        alt={image.name || t("chat.altChatAttachment")}
                        style={{
                          display: "block", width: "100%", maxHeight: 180,
                          objectFit: "cover", borderRadius: 8,
                          border: `1px solid ${T.border}`,
                        }}
                      />
                    </button>
                  ))}
                  {payload.message && (
                    <div style={{
                      fontSize: 12, color: T.text, fontFamily: T.sans,
                      lineHeight: 1.4, wordBreak: "break-word",
                      padding: attachments.length > 0 ? "0 4px 2px" : 0,
                    }}>
                      {payload.message}
                    </div>
                  )}
                </div>
                <div style={{
                  fontSize: 8, color: T.muted, fontFamily: T.mono, marginTop: 2,
                }}>
                  {new Date(payload.sentAt * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
              </div>
            );
          })
        )}
        {ratingCta && (
          // #17: glow the closing rating CTA so it reads as the next action now that
          // the chat is settled, not a buried trailing card.
          <div style={{
            margin: "8px auto 4px",
            maxWidth: 340,
            width: "100%",
            // RatingTap (leading) carries 2px top but 16px bottom margin; offset
            // that here so the row sits vertically centered in the glow box
            // (top gap 16+2 ≈ bottom gap 2+16) instead of riding high.
            padding: "16px 14px 2px",
            borderRadius: T.r,
            background: `${T.green}10`,
            border: `1px solid ${T.green}44`,
            boxShadow: `0 0 0 3px ${T.green}14`,
            textAlign: "center",
          }}>
            <RatingTap
              tradeId={ratingCta.tradeId}
              ratee={ratingCta.ratee}
              ratedThumb={ratingCta.ratedThumb}
              onRate={ratingCta.onRate}
              leading
            />
          </div>
        )}
        <div ref={chatEndRef} />
      </div>

      {/* #17: once the trade is settled the chat closes — the composer is muted (a
          post-settlement message would vanish into the void) and a gentle line points
          back to the rating CTA above. */}
      {myRole && chatClosed && (
        <div style={{
          padding: embedded ? "12px 14px 12px" : "12px 16px",
          borderTop: `1px solid ${T.border}`,
          textAlign: "center" as const,
        }}>
          <span style={{ fontFamily: T.mono, fontSize: 10.5, color: T.muted, letterSpacing: 0.3 }}>
            {t("chat.closed")}
          </span>
        </div>
      )}
      {/* Input bar */}
      {myRole && !chatClosed && (
        <div style={{
          padding: embedded ? "10px 14px 12px" : "10px 12px",
          borderTop: `1px solid ${T.border}`,
          borderBottom: embedded ? `1px solid ${T.border}` : undefined,
          display: "grid", gap: 8,
          // R3-3: keep the grid (and its flex input row) shrinkable so a wide
          // attachment preview / narrow embedded column can never overflow and
          // push the Send button out of view.
          minWidth: 0,
        }}>
          {attachment && (
            <div style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: 8, background: T.surface, border: `1px solid ${T.border}`,
              borderRadius: 12,
              // R3-3 (completing the fix): this preview is a GRID ITEM carrying the
              // long filename as nowrap text; without minWidth:0 its min-content forces
              // the grid track wider than the narrow embedded column, pushing Send off
              // the right edge. The inner ellipsis hides it visually but doesn't shrink
              // the intrinsic width — only this does. Matches the input row's minWidth:0.
              minWidth: 0,
            }}>
              <img
                src={attachment.dataUrl}
                alt={attachment.name || t("chat.altSelectedReceipt")}
                style={{
                  width: 56, height: 56, objectFit: "cover",
                  borderRadius: 8, border: `1px solid ${T.border}`,
                  flex: "0 0 auto",
                }}
              />
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{
                  fontSize: 11, color: T.text, fontFamily: T.sans,
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {attachment.name || t("chat.imageReady")}
                </div>
                <div style={{ fontSize: 9, color: T.muted, fontFamily: T.mono, marginTop: 2 }}>
                  {t("chat.encryptedReceiptImage")}
                </div>
              </div>
              <button
                onClick={() => setAttachment(null)}
                style={{
                  background: "none", border: `1px solid ${T.border}`,
                  color: T.muted, borderRadius: 999, width: 28, height: 28,
                  cursor: "pointer", fontSize: 16, lineHeight: 1,
                }}
              >
                x
              </button>
            </div>
          )}
          {err && (
            <div style={{
              padding: "8px 10px", background: T.redDim,
              border: `1px solid ${T.red}33`, borderRadius: 10,
              color: T.red, fontSize: 10, fontFamily: T.mono,
            }}>
              {err}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", minWidth: 0 }}>
            <input
              ref={fileRef}
              type="file"
              accept={CHAT_IMAGE_ACCEPT}
              onChange={handleImagePick}
              style={{ display: "none" }}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={imageBusy || sending}
              title={t("chat.attachTitle")}
              style={{
                width: 38, height: 38, borderRadius: 20,
                background: imageBusy ? T.surface : T.tealDim,
                border: `1px solid ${imageBusy ? T.border : T.teal + "44"}`,
                color: imageBusy ? T.muted : T.teal,
                fontFamily: T.mono, fontSize: 17, fontWeight: 900,
                cursor: imageBusy || sending ? "default" : "pointer",
                flex: "0 0 auto",
              }}
            >
              {imageBusy ? "..." : "+"}
            </button>
            <input
              value={msg}
              onChange={e => setMsg(e.target.value)}
              onKeyDown={e => e.key === "Enter" && !e.shiftKey && handleSend()}
              placeholder={attachment ? t("chat.notePlaceholder") : t("chat.typeMessagePlaceholder")}
              style={{
                flex: 1, minWidth: 0, padding: "9px 12px",
                background: T.surface, border: `1px solid ${T.border}`,
                borderRadius: 20, color: T.text,
                fontFamily: T.sans, fontSize: 12, outline: "none",
              }}
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              style={{
                padding: "9px 14px", borderRadius: 20,
                background: canSend ? T.accentDim : T.surface,
                border: `1px solid ${canSend ? T.accent + "44" : T.border}`,
                color: canSend ? T.accent : T.muted,
                fontFamily: T.mono, fontSize: 11, fontWeight: 700,
                cursor: canSend ? "pointer" : "default",
                transition: "all 0.2s",
                flex: "0 0 auto",
              }}
            >
              {t("chat.send")}
            </button>
          </div>
        </div>
      )}

      {viewer && (
        <div
          onClick={() => setViewer(null)}
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "#000d", display: "flex",
            alignItems: "center", justifyContent: "center",
            padding: 16,
          }}
        >
          <button
            onClick={() => setViewer(null)}
            style={{
              position: "absolute", top: 14, right: 14,
              width: 36, height: 36, borderRadius: 999,
              border: `1px solid ${T.borderHi}`,
              background: T.card, color: T.text,
              fontSize: 22, lineHeight: 1, cursor: "pointer",
            }}
          >
            x
          </button>
          <img
            onClick={(e) => e.stopPropagation()}
            src={viewer.dataUrl}
            alt={viewer.name || t("chat.altChatAttachment")}
            style={{
              maxWidth: "100%", maxHeight: "100%",
              objectFit: "contain", borderRadius: 8,
              border: `1px solid ${T.borderHi}`,
              background: T.card,
            }}
          />
        </div>
      )}
    </div>
  );
}
