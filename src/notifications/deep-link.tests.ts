import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  consumePendingTradeDeepLink,
  handleWebNotificationClickMessage,
} from "./deep-link.js";

type NotificationClickHandler = (event: {
  notification: { data?: { escrowId?: string }; close: () => void };
  waitUntil: (work: Promise<unknown>) => void;
}) => void;

function loadServiceWorker(windows: Array<Record<string, unknown>>) {
  let clickHandler: NotificationClickHandler | null = null;
  let matchOptions: unknown = null;
  let openedTarget: string | null = null;
  const source = readFileSync(new URL("../../public/chama-sw.js", import.meta.url), "utf8");
  const self = {
    addEventListener(type: string, handler: NotificationClickHandler) {
      if (type === "notificationclick") clickHandler = handler;
    },
    clients: {
      async matchAll(options: unknown) {
        matchOptions = options;
        return windows;
      },
      async openWindow(target: string) {
        openedTarget = target;
        return { target };
      },
    },
  };
  runInNewContext(source, { self, encodeURIComponent });
  assert.ok(clickHandler, "service worker registers notificationclick");
  return {
    fire(data?: { escrowId?: string }) {
      let closed = false;
      let completion: Promise<unknown> | null = null;
      clickHandler!({
        notification: { data, close: () => { closed = true; } },
        waitUntil: (work) => { completion = work; },
      });
      assert.equal(closed, true, "notification is closed immediately");
      assert.ok(completion, "notification work is kept alive");
      return completion!;
    },
    get matchOptions() { return matchOptions; },
    get openedTarget() { return openedTarget; },
  };
}

console.log("\n── Web notification deep links ──");

consumePendingTradeDeepLink();
handleWebNotificationClickMessage({ type: "unrelated", escrowId: "sm_ignore_1" });
assert.equal(consumePendingTradeDeepLink(), null, "unrelated service-worker messages are ignored");

handleWebNotificationClickMessage({ type: "chama:notificationclick", escrowId: "not-an-escrow" });
assert.equal(consumePendingTradeDeepLink(), null, "malformed service-worker trade ids are ignored");

handleWebNotificationClickMessage({ type: "chama:notificationclick", escrowId: "sm_trade_123" });
assert.equal(consumePendingTradeDeepLink(), "sm_trade_123", "valid warm taps enter the app buffer");

let focused = 0;
const messages: unknown[] = [];
const warmClient = {
  postMessage(message: unknown) { messages.push(message); },
  async focus() { focused += 1; return warmClient; },
};
const warm = loadServiceWorker([warmClient]);
await warm.fire({ escrowId: "sm_trade_123" });
assert.equal(JSON.stringify(warm.matchOptions), JSON.stringify({ type: "window", includeUncontrolled: true }));
assert.equal(JSON.stringify(messages), JSON.stringify([{ type: "chama:notificationclick", escrowId: "sm_trade_123" }]));
assert.equal(focused, 1, "warm tap focuses the existing client");
assert.equal(warm.openedTarget, null, "warm tap never opens or navigates a document");

const cold = loadServiceWorker([]);
await cold.fire({ escrowId: "sm_trade_123" });
assert.equal(cold.openedTarget, "/?trade=sm_trade_123", "cold tap opens the trade URL");

const genericMessages: unknown[] = [];
const genericClient = {
  postMessage(message: unknown) { genericMessages.push(message); },
  async focus() { return genericClient; },
};
const generic = loadServiceWorker([genericClient]);
await generic.fire();
assert.equal(JSON.stringify(genericMessages), JSON.stringify([{ type: "chama:notificationclick", escrowId: null }]));

console.log("  ✓ warm taps preserve the document; cold taps retain URL routing");
