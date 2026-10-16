// Security audit lows (Oct 16): LNURL endpoints are https (or Tor .onion),
// an invoice must match the description it was asked for, and a link can't
// swap the cached Amber identity.
import assert from "node:assert/strict";
import { bech32 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBolt11Payment } from "./bolt11.js";
import {
  fetchLnurlPayMetadataUrl,
  isAllowedLnurlUrl,
  parseRawLnurl,
  requestLnurlInvoice,
  type LnurlPayMetadata,
} from "./lnurl.js";

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
const { AmberSigner, isAmberPubkey, markAmberPubkeyRequest, takeAmberPubkeyRequest } =
  await import("../escrow-engine/signers.js");

const encodeLnurl = (url: string) =>
  bech32.encode("lnurl", bech32.toWords(new TextEncoder().encode(url)), 2000);

// ── https only ──────────────────────────────────────────────────────────
assert.equal(parseRawLnurl(encodeLnurl("https://pay.example.com/lnurlp/a")), "https://pay.example.com/lnurlp/a");
assert.throws(() => parseRawLnurl(encodeLnurl("http://pay.example.com/lnurlp/a")), /https/, "plain http LNURL refused");
assert.equal(
  parseRawLnurl(encodeLnurl("http://abcdefghijklmnop.onion/lnurlp/a")),
  "http://abcdefghijklmnop.onion/lnurlp/a",
  "Tor .onion may use http (LUD-01)",
);
assert.equal(isAllowedLnurlUrl("http://example.onion.evil.com/x"), false, "an .onion label inside another domain is not Tor");
assert.equal(isAllowedLnurlUrl("javascript:alert(1)"), false);
assert.equal(isAllowedLnurlUrl("not a url"), false);

const jsonFetch = (body: unknown) => async () =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const goodMeta = {
  tag: "payRequest", callback: "https://pay.example.com/cb", minSendable: 1000, maxSendable: 10_000_000,
  metadata: '[["text/plain","Pay Jet"]]',
};
const meta = await fetchLnurlPayMetadataUrl("https://pay.example.com/.well-known/lnurlp/jet", undefined, jsonFetch(goodMeta));
assert.equal(meta.callback, "https://pay.example.com/cb");
await assert.rejects(
  fetchLnurlPayMetadataUrl("https://pay.example.com/.well-known/lnurlp/jet", undefined, jsonFetch({ ...goodMeta, callback: "http://pay.example.com/cb" })),
  /isn't https/,
  "an http invoice callback is refused before any invoice is asked for",
);

// ── description hash ────────────────────────────────────────────────────
function invoice(amountSats: number, hash?: Uint8Array): string {
  const now = Math.floor(Date.now() / 1000);
  const ts: number[] = [];
  for (let i = 6, t = now; i >= 0; i--, t = Math.floor(t / 32)) ts[i] = t % 32;
  const tagged: number[] = [];
  if (hash) {
    const w = bech32.toWords(hash);
    tagged.push(23, Math.floor(w.length / 32), w.length % 32, ...w);
  }
  const words = [...ts, ...tagged, ...new Array(104).fill(0)];
  return bech32.encode(`lnbc${amountSats * 10}n`, words, 5000);
}
const metaHash = sha256(new TextEncoder().encode(goodMeta.metadata));
assert.equal(decodeBolt11Payment(invoice(1000, metaHash))?.descriptionHash, Buffer.from(metaHash).toString("hex"));
assert.equal(decodeBolt11Payment(invoice(1000))?.descriptionHash, undefined);

const pay = (pr: string) => requestLnurlInvoice(meta as LnurlPayMetadata, 1000, jsonFetch({ pr }));
assert.equal(await pay(invoice(1000, metaHash)), invoice(1000, metaHash), "matching description hash is accepted");
assert.equal(await pay(invoice(1000)), invoice(1000), "an invoice without a description hash is still accepted");
await assert.rejects(
  pay(invoice(1000, sha256(new TextEncoder().encode("something else")))),
  /different request/,
  "an invoice committing to other metadata is refused before it is paid",
);

// ── Amber identity ──────────────────────────────────────────────────────
const real = "a".repeat(64);
const attacker = "b".repeat(64);
assert.equal(isAmberPubkey(real), true);
assert.equal(isAmberPubkey("npub1" + "q".repeat(58)), true);
assert.equal(isAmberPubkey("<script>"), false);
assert.equal(takeAmberPubkeyRequest(), false, "no request was made");
markAmberPubkeyRequest(1_000);
assert.equal(takeAmberPubkeyRequest(1_000 + 11 * 60 * 1000), false, "a request older than ten minutes is not honoured");
markAmberPubkeyRequest(1_000);
assert.equal(takeAmberPubkeyRequest(2_000), true);
assert.equal(takeAmberPubkeyRequest(2_000), false, "a request is honoured once");

function openAt(query: string) {
  const href = `https://getchama.app/${query}`;
  (globalThis as any).window = {
    location: { href, origin: "https://getchama.app", pathname: "/" },
    history: { replaceState: () => {} },
  };
  return new AmberSigner();
}
store.set("chama_amber_pubkey", real);
const forged = openAt(`?amber_type=get_public_key&event=${attacker}`);
assert.equal(await forged.getPublicKey(), real, "a link can't replace the Amber key");
assert.equal(store.get("chama_amber_pubkey"), real);

store.delete("chama_amber_pubkey");
markAmberPubkeyRequest();
const answered = openAt(`?amber_type=get_public_key&event=${real}`);
assert.equal(await answered.getPublicKey(), real, "Amber's answer to our own request is kept");
assert.equal(store.get("chama_amber_pubkey"), real);

console.log("PASS audit lows: https-only LNURL, invoice description hash, Amber key only from our own request");
