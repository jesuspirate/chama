// Lightning-address claims on Android (Jet, 6.4.25 rc): LNURL lookups and
// invoice callbacks travel over native HTTP in the Android app, every check on
// the answer is unchanged, and an unreachable server says plainly which
// server, which step, and that nothing was paid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { bech32 } from "@scure/base";
import { LNURL_TIMEOUT_MS, nativeLnurlFetch, useNativeLnurlHttp, withLnurlTimeout } from "./lnurl-transport.js";
import { LnurlError, resolveLightningAddressToInvoice, resolveRawLnurlToInvoice } from "./lnurl.js";

const now = Math.floor(Date.now() / 1000);
const invoiceFor = (sats: number) => {
  const timeWords = Array.from({ length: 7 }, (_, i) => Math.floor(now / 32 ** (6 - i)) % 32);
  return bech32.encode(`lnbc${sats * 10}n`, [...timeWords, ...Array(104).fill(0)], 5000);
};
type Call = { url: string; headers?: Record<string, string>; responseType?: string; connectTimeout?: number };
const strikeMeta = { tag: "payRequest", callback: "https://strike.me/api/lnurlp/bitcrazy/", minSendable: 1000, maxSendable: 16_000_000_000, metadata: "[]" };
const fakeHttp = (answer: (url: string) => { status: number; data: unknown } | Error) => {
  const calls: Call[] = [];
  return {
    calls,
    http: { async get(o: Call) { calls.push(o); const a = answer(o.url); if (a instanceof Error) throw a; return { ...a, headers: { "Content-Type": "application/json" } }; } },
  };
};

// Where native HTTP is used: the Android app only.
assert.equal(useNativeLnurlHttp("android", true), true);
assert.equal(useNativeLnurlHttp("ios", true), false, "iOS app unchanged");
assert.equal(useNativeLnurlHttp("web", false), false, "web and PWA unchanged");
assert.equal(useNativeLnurlHttp("android", false), false, "Android Chrome/Vanadium web unchanged");
console.log("PASS LNURL transport: native HTTP in the Android app only");

{
  // A real-shaped Strike lookup and callback, over native HTTP, resolve to the
  // invoice; the request asks for JSON as text, with timeouts.
  const { calls, http } = fakeHttp(url => url.includes(".well-known")
    ? { status: 200, data: JSON.stringify(strikeMeta) }
    : { status: 200, data: { pr: invoiceFor(992) } });
  const pr = await resolveLightningAddressToInvoice("bitcrazy@strike.me", 992, nativeLnurlFetch(http as any));
  assert.equal(pr, invoiceFor(992));
  assert.deepEqual(calls.map(c => c.url), ["https://strike.me/.well-known/lnurlp/bitcrazy", "https://strike.me/api/lnurlp/bitcrazy/?amount=992000"]);
  assert.ok(calls.every(c => c.responseType === "text" && c.headers?.Accept === "application/json" && c.connectTimeout === LNURL_TIMEOUT_MS));
}
{
  // Every check on the answer still runs: wrong amount, server error, bad JSON.
  const wrong = fakeHttp(url => url.includes(".well-known") ? { status: 200, data: JSON.stringify(strikeMeta) } : { status: 200, data: { pr: invoiceFor(500) } });
  await assert.rejects(resolveLightningAddressToInvoice("bitcrazy@strike.me", 992, nativeLnurlFetch(wrong.http as any)), /wrong amount/);
  const refused = fakeHttp(() => ({ status: 404, data: JSON.stringify({ status: "ERROR", reason: "User not found" }) }));
  await assert.rejects(resolveLightningAddressToInvoice("nobody@strike.me", 992, nativeLnurlFetch(refused.http as any)),
    (e: unknown) => e instanceof LnurlError && e.code === "LnurlServerError" && /User not found \(HTTP 404\)/.test(e.message));
  const html = fakeHttp(() => ({ status: 200, data: "<html>" }));
  await assert.rejects(resolveLightningAddressToInvoice("a@strike.me", 992, nativeLnurlFetch(html.http as any)),
    (e: unknown) => e instanceof LnurlError && e.code === "LnurlMalformedError");
  const noAnswer = fakeHttp(() => ({ status: 0, data: "" }));
  await assert.rejects(resolveLightningAddressToInvoice("a@strike.me", 992, nativeLnurlFetch(noAnswer.http as any)),
    (e: unknown) => e instanceof LnurlError && e.code === "LnurlDnsError");
}
console.log("PASS LNURL over native HTTP: Strike address resolves; amount, server error, JSON and no-answer checks unchanged");

{
  // Unreachable lookup: which server, which step, nothing paid.
  const down = fakeHttp(() => new Error("Failed to fetch"));
  await assert.rejects(resolveLightningAddressToInvoice("bitcrazy@strike.me", 992, nativeLnurlFetch(down.http as any)), (e: unknown) =>
    e instanceof LnurlError && e.code === "LnurlDnsError"
    && e.unreachable?.host === "strike.me" && e.unreachable.step === "lookup"
    && e.message === "Couldn't reach strike.me to look up this wallet (Failed to fetch). Nothing was paid.");
  // Lookup fine, callback unreachable: the callback's host and the invoice step.
  const fedi = "https://prod.recurringd.vai1f.org/lnv1/paycodes/e44e";
  const lnurl = bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(fedi)), 2000);
  const halfway = fakeHttp(url => url === fedi
    ? { status: 200, data: JSON.stringify({ tag: "payRequest", callback: `${fedi}/invoice`, minSendable: 1, maxSendable: 1e11, metadata: "[]" }) }
    : new Error("Failed to fetch"));
  await assert.rejects(resolveRawLnurlToInvoice(lnurl, 992, nativeLnurlFetch(halfway.http as any)), (e: unknown) =>
    e instanceof LnurlError && e.unreachable?.host === "prod.recurringd.vai1f.org" && e.unreachable.step === "invoice"
    && /to get an invoice \(Failed to fetch\)\. Nothing was paid\.$/.test(e.message));
  // A server that never answers gives up after the timeout, as unreachable.
  const hang = withLnurlTimeout(() => new Promise<Response>(() => {}), 20);
  await assert.rejects(resolveLightningAddressToInvoice("a@strike.me", 992, hang), (e: unknown) =>
    e instanceof LnurlError && e.code === "LnurlDnsError" && /no answer within 0 seconds/.test(e.message));
}
console.log("PASS LNURL unreachable: names the server and the step (lookup or invoice), says nothing was paid, times out");

{
  // Plain translated words in the claim sheet, all four languages.
  const { lnurlUnreachableText } = await import("../ui/components/DestinationPicker.js");
  const e = new LnurlError("LnurlDnsError", "x", { host: "strike.me", step: "lookup" });
  assert.equal(lnurlUnreachableText(e, "en"), "Couldn't reach strike.me to look up this wallet. Nothing was paid. Check the address, or choose another wallet.");
  const inv = new LnurlError("LnurlDnsError", "x", { host: "strike.me", step: "invoice" });
  assert.match(lnurlUnreachableText(inv, "en")!, /^Couldn't reach strike\.me to get an invoice\. Nothing was paid\./);
  for (const lang of ["fr", "es", "sw"] as const) {
    const text = lnurlUnreachableText(e, lang)!;
    assert.ok(text.includes("strike.me") && !text.startsWith("Couldn't"), `${lang} is translated`);
  }
  assert.equal(lnurlUnreachableText(new LnurlError("LnurlServerError", "x"), "en"), null);
}
{
  // Saved-wallet claims: the wallet is asked for an invoice BEFORE the claim
  // starts. A failed ask shows "your claim hasn't started", never "recovering
  // your share" or "your claim is published", and never dispatches the claim.
  const modal = readFileSync(new URL("../ui/panels/ClaimPayoutModal.tsx", import.meta.url), "utf8");
  const saved = modal.slice(modal.indexOf("const dispatchSavedWalletClaim"), modal.indexOf("const dispatchSavedNwcClaim"));
  assert.match(saved, /setStage\(\{ kind: "resolving" \}\)/);
  assert.match(saved, /catch \(e: any\) \{\n\s*setStage\(\{ kind: "destination-failed"[^\n]*\n\s*return;/);
  assert.ok(saved.indexOf("resolveDestination(invoice") > saved.indexOf("return;"), "the claim is dispatched only after an invoice arrived");
  assert.doesNotMatch(saved, /kind: "claiming"|claim-failed/);
  const nwc = modal.slice(modal.indexOf("const dispatchSavedNwcClaim"), modal.indexOf("// Saved Strike opens"));
  assert.match(nwc, /setStage\(\{ kind: "resolving" \}\)/);
  assert.match(nwc, /kind: "destination-failed"/);
  assert.doesNotMatch(nwc, /claim-failed/);
  const resolving = modal.slice(modal.indexOf('{stage.kind === "resolving"'), modal.indexOf('{stage.kind === "destination-failed"'));
  assert.match(resolving, /claim\.phaseAskingWallet/);
  assert.match(resolving, /claim\.notStartedYet/);
  assert.doesNotMatch(resolving, /longRunningEscape|phaseClaiming/);
  const en = readFileSync(new URL("../i18n/en/claim.ts", import.meta.url), "utf8");
  assert.match(en, /"claim\.notStartedYet": "Your claim hasn't started yet, so your sats are still in the trade\."/);
}
console.log("PASS claim sheet: plain lookup errors in en/fr/es/sw; a saved wallet is asked before the claim starts, and a failed ask never claims");
