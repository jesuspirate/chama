#!/bin/sh
set -eu

pids=""
stop() {
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
}
trap stop INT TERM EXIT

security_dir="/data/security"
mkdir -p "$security_dir"
chown root:nginx "$security_dir"
chmod 750 "$security_dir"

access_password_file="$security_dir/access-password"
if [ ! -s "$access_password_file" ]; then
  umask 077
  openssl rand -hex 24 > "$access_password_file"
fi
access_password="$(tr -d '\r\n' < "$access_password_file")"
if [ "${#access_password}" -ne 48 ]; then
  echo "chama-startos: invalid access password state" >&2
  exit 1
fi
htpasswd -bcB "$security_dir/htpasswd" chama "$access_password" >/dev/null
chown root:nginx "$security_dir/htpasswd"
chmod 600 "$access_password_file"
chmod 640 "$security_dir/htpasswd"

data_dir="/data/client-1"
token_file="$security_dir/bridge-token-1"
mkdir -p "$data_dir"
if [ ! -s "$token_file" ]; then
  umask 077
  openssl rand -hex 32 > "$token_file"
fi
bridge_token="$(tr -d '\r\n' < "$token_file")"
if [ "${#bridge_token}" -ne 64 ]; then
  echo "chama-startos: invalid bridge token state" >&2
  exit 1
fi
chmod 600 "$token_file"
chama-fedimint-bridge --data-dir "$data_dir" serve \
  --bind "127.0.0.1:8787" \
  --auth-token "$bridge_token" &
pids="$pids $!"

export CHAMA_BRIDGE_TOKEN_1="$(tr -d '\r\n' < "$security_dir/bridge-token-1")"
envsubst '${CHAMA_BRIDGE_TOKEN_1}' \
  < /etc/nginx/nginx.conf.template > /tmp/nginx.conf
chmod 600 /tmp/nginx.conf

nginx -c /tmp/nginx.conf -g 'daemon off;' &
nginx_pid=$!
pids="$pids $nginx_pid"

# Exit if any child dies so StartOS restarts the whole service
# (UI-up / bridges-down is not a healthy lab package).
while kill -0 "$nginx_pid" 2>/dev/null; do
  for pid in $pids; do
    # `kill -0` still succeeds for an unreaped zombie. Without this state
    # check, a native bridge abort leaves nginx serving a healthy-looking UI
    # whose `/bridge/*` upstream is permanently dead.
    state="$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true)"
    if ! kill -0 "$pid" 2>/dev/null || [ "$state" = "Z" ]; then
      echo "chama-startos: child $pid exited" >&2
      exit 1
    fi
  done
  sleep 2
done
wait "$nginx_pid" || exit 1
