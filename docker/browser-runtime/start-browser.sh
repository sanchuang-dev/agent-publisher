#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
profile_dir="${BROWSER_PROFILE_DIR:-/data/profile}"
vnc_port="${VNC_PORT:-5900}"
novnc_port="${NOVNC_PORT:-6080}"
display_number="${display#:}"
x_socket="/tmp/.X11-unix/X${display_number}"

mkdir -p "${profile_dir}"
chown -R browser:browser "${profile_dir}"

xvfb_pid=""
chromium_pid=""
x11vnc_pid=""
websockify_pid=""

cleanup() {
  if [ -n "${chromium_pid}" ]; then
    kill "${chromium_pid}" 2>/dev/null || true
  fi
  if [ -n "${websockify_pid}" ]; then
    kill "${websockify_pid}" 2>/dev/null || true
  fi
  if [ -n "${x11vnc_pid}" ]; then
    kill "${x11vnc_pid}" 2>/dev/null || true
  fi
  if [ -n "${xvfb_pid}" ]; then
    kill "${xvfb_pid}" 2>/dev/null || true
  fi

  if [ -n "${chromium_pid}" ]; then
    wait "${chromium_pid}" 2>/dev/null || true
  fi
  if [ -n "${websockify_pid}" ]; then
    wait "${websockify_pid}" 2>/dev/null || true
  fi
  if [ -n "${x11vnc_pid}" ]; then
    wait "${x11vnc_pid}" 2>/dev/null || true
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

gosu browser x11vnc \
  -display "${display}" \
  -rfbport "${vnc_port}" \
  -localhost \
  -forever \
  -shared \
  -nopw \
  -xkb &
x11vnc_pid=$!

gosu browser websockify \
  --web=/usr/share/novnc/ \
  "${novnc_port}" \
  "127.0.0.1:${vnc_port}" &
websockify_pid=$!

while :; do
  if ! kill -0 "${xvfb_pid}" 2>/dev/null; then
    echo "Xvfb exited unexpectedly" >&2
    exit 1
  fi
  if ! kill -0 "${chromium_pid}" 2>/dev/null; then
    echo "Chromium exited unexpectedly" >&2
    exit 1
  fi
  if ! kill -0 "${x11vnc_pid}" 2>/dev/null; then
    echo "x11vnc exited unexpectedly" >&2
    exit 1
  fi
  if ! kill -0 "${websockify_pid}" 2>/dev/null; then
    echo "websockify exited unexpectedly" >&2
    exit 1
  fi

  sleep 1
done
