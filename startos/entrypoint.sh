#!/bin/sh
set -eu

pids=""
stop() {
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
}
trap stop INT TERM EXIT

# Preserve the original Client One wallet path. The retired Client Two/Three
# directories are deliberately left untouched in /data so an upgrade never
# deletes wallet evidence or removes it from StartOS backups.
data_dir="/data/client-1"
mkdir -p "$data_dir"
chama-fedimint-bridge --data-dir "$data_dir" serve --bind "127.0.0.1:8787" &
pids="$pids $!"

nginx -g 'daemon off;' &
nginx_pid=$!
pids="$pids $nginx_pid"

# Exit if any child dies so StartOS restarts the whole service
# (UI-up / bridge-down is not a healthy package).
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
