#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
profile_dir="${BROWSER_PROFILE_DIR:-/data/profile}"
display_number="${display#:}"
x_socket="/tmp/.X11-unix/X${display_number}"

mkdir -p "${profile_dir}"
chown -R browser:browser "${profile_dir}"

xvfb_pid=""
chromium_pid=""

cleanup() {
  if [ -n "${chromium_pid}" ]; then
    kill "${chromium_pid}" 2>/dev/null || true
  fi
  if [ -n "${xvfb_pid}" ]; then
    kill "${xvfb_pid}" 2>/dev/null || true
  fi

  if [ -n "${chromium_pid}" ]; then
    wait "${chromium_pid}" 2>/dev/null || true
  fi
  if [ -n "${xvfb_pid}" ]; then
    wait "${xvfb_pid}" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

gosu browser Xvfb "${display}" \
  -screen 0 1440x900x24 \
  -nolisten tcp \
  -ac &
xvfb_pid=$!

attempt=0
while [ ! -S "${x_socket}" ]; do
  if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
    echo "Xvfb exited before display ${display} became ready" >&2
    exit 1
  fi

  attempt=$((attempt + 1))
  if [ "${attempt}" -ge 50 ]; then
    echo "Timed out waiting for Xvfb display ${display}" >&2
    exit 1
  fi

  sleep 0.1
done

gosu browser chromium \
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir="${profile_dir}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  about:blank &
chromium_pid=$!

wait "${chromium_pid}"
