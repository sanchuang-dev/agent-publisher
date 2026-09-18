#!/bin/sh
set -eu

display="${DISPLAY:-:99}"
profile_dir="${BROWSER_PROFILE_DIR:-/data/profile}"
runtime_dir="${BROWSER_RUNTIME_DIR:-/run/browser-runtime}"

# Internal browser-runtime transport contract. Host/reverse-proxy exposure belongs
# to Compose or the application boundary instead of a second container port config.
vnc_port="5900"
novnc_port="6080"

display_number="${display#:}"
x_socket="/tmp/.X11-unix/X${display_number}"

mkdir -p "${profile_dir}" "${runtime_dir}"
chown -R browser:browser "${profile_dir}"
rm -f "${runtime_dir}"/*.pid

xvfb_pid=""
chromium_pid=""
x11vnc_pid=""
websockify_pid=""

record_pid() {
  process_name="$1"
  process_pid="$2"
  printf '%s\n' "${process_pid}" > "${runtime_dir}/${process_name}.pid"
}

process_is_alive() {
  process_pid="$1"
  stat_file="/proc/${process_pid}/stat"

  [ -r "${stat_file}" ] || return 1
  process_state="$(cut -d ' ' -f 3 "${stat_file}" 2>/dev/null || true)"
  [ -n "${process_state}" ] && [ "${process_state}" != "Z" ] && kill -0 "${process_pid}" 2>/dev/null
}

cleanup() {
  for process_pid in "${websockify_pid}" "${x11vnc_pid}" "${chromium_pid}" "${xvfb_pid}"; do
    if [ -n "${process_pid}" ]; then
      kill "${process_pid}" 2>/dev/null || true
    fi
  done

  for process_pid in "${websockify_pid}" "${x11vnc_pid}" "${chromium_pid}" "${xvfb_pid}"; do
    if [ -n "${process_pid}" ]; then
      wait "${process_pid}" 2>/dev/null || true
    fi
  done

  rm -f "${runtime_dir}"/*.pid
}

shutdown() {
  trap - EXIT
  cleanup
  exit 0
}

trap cleanup EXIT
trap shutdown INT TERM

gosu browser Xvfb "${display}" \
  -screen 0 1440x900x24 \
  -nolisten tcp \
  -ac &
xvfb_pid=$!
record_pid xvfb "${xvfb_pid}"

attempt=0
while [ ! -S "${x_socket}" ]; do
  if ! process_is_alive "${xvfb_pid}"; then
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
record_pid chromium "${chromium_pid}"

gosu browser x11vnc \
  -display "${display}" \
  -rfbport "${vnc_port}" \
  -localhost \
  -forever \
  -shared \
  -nopw \
  -xkb &
x11vnc_pid=$!
record_pid x11vnc "${x11vnc_pid}"

gosu browser websockify \
  --web=/usr/share/novnc/ \
  "${novnc_port}" \
  "127.0.0.1:${vnc_port}" &
websockify_pid=$!
record_pid websockify "${websockify_pid}"

while :; do
  if ! process_is_alive "${xvfb_pid}"; then
    echo "Xvfb exited unexpectedly" >&2
    exit 1
  fi
  if ! process_is_alive "${chromium_pid}"; then
    echo "Chromium exited unexpectedly" >&2
    exit 1
  fi
  if ! process_is_alive "${x11vnc_pid}"; then
    echo "x11vnc exited unexpectedly" >&2
    exit 1
  fi
  if ! process_is_alive "${websockify_pid}"; then
    echo "websockify exited unexpectedly" >&2
    exit 1
  fi

  sleep 1
done
