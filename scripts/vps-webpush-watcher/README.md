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
