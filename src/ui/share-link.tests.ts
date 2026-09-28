import assert from "node:assert/strict";
import { tradeShareUrl } from "./share-link.js";

for (const origin of ["https://localhost", "http://localhost:3000", "capacitor://localhost", "https://box.local", "http://abc.onion", "http://127.0.0.1:3000", "http://[::1]:3000"]) {
  assert.equal(tradeShareUrl("sm_trade", `${origin}/private?old=yes`), "https://getchama.app/?trade=sm_trade");
}
assert.equal(tradeShareUrl("sm_trade", "https://getchama.app/?old=yes#fragment"), "https://getchama.app/?trade=sm_trade");
assert.equal(tradeShareUrl("sm_trade", "https://example.com/chama/?old=yes"), "https://example.com/chama/?trade=sm_trade");
console.log("Share links: passed");
