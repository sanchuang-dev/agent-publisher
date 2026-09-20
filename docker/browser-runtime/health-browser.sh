#!/bin/sh
set -eu

runtime_dir="${BROWSER_RUNTIME_DIR:-/run/browser-runtime}"

check_process() {
  process_name="$1"
  pid_file="${runtime_dir}/${process_name}.pid"

  [ -r "${pid_file}" ] || {
    echo "Missing pid file for ${process_name}" >&2
    exit 1
  }

  process_pid="$(cat "${pid_file}")"
  case "${process_pid}" in
    ''|*[!0-9]*)
      echo "Invalid pid for ${process_name}" >&2
      exit 1
      ;;
  esac

  stat_file="/proc/${process_pid}/stat"
  [ -r "${stat_file}" ] || {
    echo "${process_name} is not running" >&2
    exit 1
  }

  process_state="$(cut -d ' ' -f 3 "${stat_file}" 2>/dev/null || true)"
  if [ -z "${process_state}" ] || [ "${process_state}" = "Z" ] || ! kill -0 "${process_pid}" 2>/dev/null; then
    echo "${process_name} is not healthy" >&2
    exit 1
  fi
}

for process_name in xvfb chromium cdp-proxy x11vnc websockify; do
  check_process "${process_name}"
done

# 9223 proves Chromium's loopback DevTools endpoint is alive; 9222 proves the
# Compose-facing proxy path is alive as well.
curl --fail --silent --show-error --max-time 1 http://127.0.0.1:9223/json/version >/dev/null
curl --fail --silent --show-error --max-time 1 http://127.0.0.1:9222/json/version >/dev/null
curl --fail --silent --show-error --max-time 1 http://127.0.0.1:6080/vnc.html >/dev/null
