#!/usr/bin/env bash
set -euo pipefail

# Idempotently expose the already-loopback-bound watcher through Caddy. Run as
# root on the Chama VPS; the script backs up and validates before reloading.
CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
BACKUP="${CADDYFILE}.before-chama-push"

if ! grep -Fq "push.chama.community {" "$CADDYFILE"; then
  cp "$CADDYFILE" "$BACKUP"
  cat >> "$CADDYFILE" <<'EOF'

# Chama S4.2 — privacy-preserving Web Push watcher.
push.chama.community {
	reverse_proxy 127.0.0.1:8890
	header -Server
}
EOF
fi

if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  if [ -f "$BACKUP" ]; then cp "$BACKUP" "$CADDYFILE"; fi
  echo "Caddy validation failed; the previous configuration was restored." >&2
  exit 1
fi

systemctl reload caddy
echo "Caddy route installed. Verify: https://push.chama.community/health"
