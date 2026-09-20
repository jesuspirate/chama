import fs from "node:fs";
import crypto from "node:crypto";

/** Only operator-trusted HTTPS push hosts. Never let registration become an SSRF proxy. */
export function validSubscription(s, extraHosts = []) {
  if (s?.transport === "fcm") return typeof s.token === "string" && /^[A-Za-z0-9:_-]{80,4096}$/.test(s.token);
  if (s?.transport && !["webpush", "unifiedpush"].includes(s.transport)) return false;
  try {
    const url = new URL(s.endpoint);
    const trusted = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com", "ntfy.sh", ...extraHosts];
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash) return false;
    if (!trusted.includes(url.hostname)) return false;
    const keys = s.keys;
    return typeof keys?.p256dh === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh)
      && Buffer.from(keys.p256dh, "base64url").length === 65
      && typeof keys?.auth === "string" && /^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth)
      && Buffer.from(keys.auth, "base64url").length === 16;
  } catch { return false; }
}
export function endpointKeyOf(s) { return s?.transport === "fcm" ? `fcm:${s.token}` : String(s?.endpoint || ""); }

/** Service account is read only on the VPS. Nothing from it goes to a client. */
export function createFcmSender(credentialsPath, fetchImpl = fetch) {
  let token = null;
  let expiresAt = 0;
  let pending = null;
  let account;
  async function accessToken() {
    if (token && expiresAt > Date.now() + 60_000) return token;
    if (pending) return pending;
    pending = (async () => {
      if (!credentialsPath) throw new Error("FCM is not configured");
      account ??= JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      if (!/^[a-z0-9-]+$/.test(account.project_id)) throw new Error("Invalid Firebase project");
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
      const claims = Buffer.from(JSON.stringify({ iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
      })).toString("base64url");
      const input = `${header}.${claims}`;
      const assertion = `${input}.${crypto.sign("RSA-SHA256", Buffer.from(input), account.private_key).toString("base64url")}`;
      const response = await fetchImpl("https://oauth2.googleapis.com/token", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      });
      if (!response.ok) throw new Error("FCM authentication failed");
      const result = await response.json();
      if (typeof result.access_token !== "string") throw new Error("FCM authentication failed");
      token = result.access_token; expiresAt = Date.now() + Math.min(Number(result.expires_in) || 0, 3600) * 1000;
      return token;
    })();
    try { return await pending; } finally { pending = null; }
  }
  return async (subscription) => {
    const bearer = await accessToken();
    const response = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: JSON.stringify({ message: { token: subscription.token, data: { wake: "1" },
        android: { priority: "high", ttl: "120s", collapse_key: "chama-wake" } } }),
    });
    if (!response.ok) {
      if (response.status === 401) { token = null; expiresAt = 0; }
      const err = new Error("FCM send failed");
      const result = await response.json().catch(() => ({}));
      // A project/auth failure is NOT evidence that a user's token is dead.
      if (result.error?.details?.some(d => d.errorCode === "UNREGISTERED")) err.statusCode = 410;
      throw err;
    }
  };
}
