import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { freshWake } from "./wake-policy.mjs";
import { validSubscription, endpointKeyOf, createFcmSender } from "./delivery.mjs";

assert.equal(freshWake(100, 100_000, 90_000, 101_000), false); // strict connect boundary
assert.equal(freshWake(101, 100_000, 102_000, 103_000), false); // registered after event
assert.equal(freshWake(101, 100_000, 100_000, 103_000), true);
assert.equal(freshWake(104, 100_000, 100_000, 103_000), false); // future signed timestamp
assert.equal(freshWake(101, 100_000, 100_000, 222_000), false); // stale replay
assert.equal(freshWake(NaN, 0, 0), false);
const sub = { endpoint: "https://ntfy.sh/up/example", transport: "unifiedpush",
  keys: { p256dh: Buffer.alloc(65, 1).toString("base64url"), auth: Buffer.alloc(16, 1).toString("base64url") } };
assert(validSubscription(sub));
for (const endpoint of ["http://ntfy.sh/a", "https://127.0.0.1/a", "https://169.254.169.254/a", "https://ntfy.sh.evil.test/a", "https://user@ntfy.sh/a", "https://ntfy.sh:8443/a", "https://[::1]/a"]) {
  assert.equal(validSubscription({ ...sub, endpoint }), false, endpoint);
}
assert.equal(validSubscription({ ...sub, keys: {} }), false);
assert.equal(validSubscription({ ...sub, endpoint: "https://push.example.org/x" }, ["push.example.org"]), true);
const fcm = { transport: "fcm", token: "a".repeat(150) };
assert(validSubscription(fcm));
assert.equal(endpointKeyOf(fcm), `fcm:${fcm.token}`);
assert.equal(validSubscription({ transport: "fcm", token: "https://evil.test" }), false);

// Real RSA signing; fake network. No production credential or device needed.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chama-fcm-test-"));
try {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const accountPath = path.join(dir, "service.json");
  fs.writeFileSync(accountPath, JSON.stringify({ project_id: "chama-test", client_email: "sender@example.test",
    private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }));
  let authCalls = 0; let sends = 0; let expired = false;
  const send = createFcmSender(accountPath, async (url, opts) => {
    if (url.includes("oauth2")) {
      authCalls++;
      const jwt = opts.body.get("assertion").split(".");
      assert(crypto.verify("RSA-SHA256", Buffer.from(jwt.slice(0, 2).join(".")), keys.publicKey, Buffer.from(jwt[2], "base64url")));
      return { ok: true, json: async () => ({ access_token: "test-token", expires_in: 3600 }) };
    }
    sends++;
    assert.equal(url, "https://fcm.googleapis.com/v1/projects/chama-test/messages:send");
    const body = JSON.parse(opts.body);
    assert.equal(body.message.notification, undefined); // SDK cannot bypass our native policy
    assert.deepEqual(body.message.data, { wake: "1" });
    assert.equal(body.message.android.ttl, "120s");
    assert.equal(opts.headers.authorization, "Bearer test-token");
    return expired ? { ok: false, status: 404, json: async () => ({ error: { details: [{ errorCode: "UNREGISTERED" }] } }) } : { ok: true };
  });
  await send(fcm); await send(fcm);
  assert.equal(authCalls, 1); assert.equal(sends, 2);
  expired = true;
  await assert.rejects(send(fcm), e => e.statusCode === 410);
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
console.log("Native wake transport: freshness, endpoint policy, FCM authentication/data-only delivery and dead-token handling passed");
