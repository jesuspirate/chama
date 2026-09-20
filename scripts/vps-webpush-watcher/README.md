# chama-webpush-watcher — A6 VPS web-push watcher (deploy runbook)

The privacy-preserving watcher from `design/mockups/chama-a6-vps-webpush-brief.md`.
It stays subscribed to the Chama Nostr band while every client is closed, and when a
state event carries a registered **opaque watch-tag** it sends an **empty** web-push
wake-up to the endpoints that registered it. The client wakes, fetches the real state
from relays, and shows the notification itself.

## The invariant (why this is safe)

The watcher stores only `{ opaque watch-tag → [ push endpoint ] }`. **No pubkey, no
escrow id, no amount, no counterparty, no event body** — in memory, on disk, or in
logs. Watch-tags are `HMAC(per-trade key, escrowId:epoch)` computed by the two
participants; the relay and this box see a random string. The push payload is empty.
A subpoena of this box cannot answer "who traded with whom". Do not add content
logging "to debug" — the diagnosable unit is counts (`/health`), never tags or endpoints.

## What it is

- `watcher.mjs` — the whole service: Nostr subscription (nostr-tools) + `#w` match +
  VAPID send (web-push) + a tiny HTTP API (`/register`, `/unregister`, `/health`) +
  a TTL'd opaque store persisted to `registrations.json`.
- `chama-webpush-watcher.service` — systemd unit (hardened; loopback bind).
- `.env.example` — config template.

## Deploy (on the getchama.app VPS, beside the relay)

1. **Copy the dir to the VPS** (e.g. `~/chama-webpush-watcher`) and install:
   ```sh
   cd ~/chama-webpush-watcher && npm ci --omit=dev   # or: npm install --omit=dev
   ```
2. **Generate the VAPID pair once** and put it in `.env`:
   ```sh
   npm run gen-vapid          # prints VAPID_PUBLIC / VAPID_PRIVATE
   cp .env.example .env && $EDITOR .env
   ```
   Then paste the **public** key into the app: `WEB_PUSH_VAPID_PUBLIC` in
   `src/notifications/web-push-client.ts`. The private key stays only in `.env`.
3. **Caddy** — run the included idempotent installer as root. It backs up the
   current config, adds `push.chama.community`, validates, and only then reloads:
   ```sh
   sudo ./install-caddy-route.sh
   ```
   The installed site is deliberately only a proxy to the loopback service:
   ```
   push.chama.community {
     reverse_proxy 127.0.0.1:8890
   }
   ```
   (The service binds `127.0.0.1` and refuses to be reached except through Caddy.)
4. **systemd** — adjust `WorkingDirectory`/`EnvironmentFile`/user in the unit to match
   the deploy path, then:
   ```sh
   sudo cp chama-webpush-watcher.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now chama-webpush-watcher
   ```

## Smoke checks (run after deploy — mandatory)

```sh
# 1. Health through the proxy (should be JSON with ok:true).
curl -s https://push.chama.community/health

# 2. CORS + validation: a garbage body must 400, not 204.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://push.chama.community/register \
  -H 'content-type: application/json' -d '{"nope":1}'      # expect 400

# 3. End-to-end (real): open getchama.app on a second device, enable notifications,
#    run a signet trade with BOTH tabs closed, advance a state → the counterparty
#    device buzzes within ~1-2s. Confirm `/health` endpoint/tag counts move.

# 4. Privacy audit: inspect registrations.json and the journal — there must be NO
#    pubkey, escrow id, amount, or event body anywhere. Only endpoints + opaque tags.
```

## Notes

- **Best-effort, not a guarantee.** Web Push is best-effort; keep the app's resume
  catch-up as the backstop (brief §6.5). Push is the fast path, resume is the net.
- **iOS** gets push only to a home-screen-installed PWA — the app gates that
  (`iosNeedsInstallForPush`), nothing to do here.
- **UnifiedPush/ntfy (de-Googled Android)** reuses this exact store — a UnifiedPush
  endpoint is just another URL. That last-mile is a separate follow-on (brief §7).
- **Relay dependency:** the watcher is only as live as its relay subscriptions.
  It reconnects via nostr-tools' SimplePool; if you run a second relay, add it to
  `CHAMA_RELAYS` so a single relay outage isn't a silent notification outage.


## Android transports (v6.5)

Deploy this watcher together with the quiet-sign-in client and native receivers.
The old empty Web Push wake remains compatible with PWA clients. Android uses:

- `transport: "unifiedpush"` with the connector’s HTTPS endpoint and Web Push
  keys. The watcher encrypts `{wake: 1, sentAt: <milliseconds>}` with VAPID.
- `transport: "fcm"` with an opaque device token. Set `FCM_SERVICE_ACCOUNT_FILE`
  to a protected server-side JSON service-account file authorized to send for the
  matching Firebase project. The watcher obtains short-lived OAuth credentials
  and sends data-only messages, never Firebase display-notification payloads.

Build the APK with the Firebase Android app’s public `google-services.json` for
`app.chama.market` to enable FCM. Do not put service-account/private keys in the
APK or this repository. Without Firebase configuration, UnifiedPush still works
with an installed distributor. Both transports require the user to enable alerts.

`PUSH_ENDPOINT_HOSTS` is a comma-separated list of additional exact trusted HTTPS
push hosts. Defaults allow `ntfy.sh`, `fcm.googleapis.com`,
`updates.push.services.mozilla.com` and `web.push.apple.com`. Add a self-hosted
UnifiedPush server explicitly; do not accept arbitrary registration-supplied hosts
or wildcards. These hosts are trusted egress destinations, must remain publicly
routed, and must not resolve to internal services. Redirects are not a supported
endpoint configuration. Registration carries endpoint capabilities and opaque tags,
never account keys, trade identifiers or event content. Protect the registration
store as bearer-capability material.

The watcher now checks signed timestamps itself instead of trusting relay filters.
Events at/before startup or registration, more than 120 seconds old, or in the
future do not wake a device. Relay duplicate IDs are suppressed. Registration
expiry survives restart. Native receivers reject stale payloads, suppress wakes
while foregrounded, and display only generic copy. Network registration is best
effort and retried on app resume; endpoint delivery and force-stopped-app behavior
must be checked on the actual OS/distributor. No background trade signing occurs.

Run `node scripts/vps-webpush-watcher/wake-policy.tests.mjs` from the repository
root for timestamp, endpoint validation and mocked FCM transport checks. Android
policy tests run with `cd android && ./gradlew :app:testDebugUnitTest` using JDK 21.
Before declaring shipped, record an app-closed fresh-event wake and a historical
replay non-wake on both a no-Play-services device and a Play-services device, plus
permission denial, opt-out, endpoint rotation and notification-tap reopening.

API references: [UnifiedPush connector](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector/-unified-push/),
[UnifiedPush service](https://unifiedpush.org/kdoc/connector/org.unifiedpush.android.connector/-push-service/),
[Firebase receive messages](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).
