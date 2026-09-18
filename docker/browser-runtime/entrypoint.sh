#!/usr/bin/env bash
set -euo pipefail

# Start virtual framebuffer
Xvfb "${DISPLAY}" -screen 0 1280x800x24 -nolisten tcp &
XVFB_PID=$!

# Give Xvfb a moment to initialise
sleep 1

# Start Chromium in headful mode with remote debugging on the internal port
chromium \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 \
  --user-data-dir="${CHROMIUM_PROFILE_DIR}" \
  --no-first-run \
  --disable-default-apps \
  about:blank &
CHROMIUM_PID=$!

# Forward signals to child processes
trap 'kill ${CHROMIUM_PID} ${XVFB_PID} 2>/dev/null; exit 0' SIGTERM SIGINT

# Exit the container if either Xvfb or Chromium exits, so Docker can restart it.
wait_any() {
  while kill -0 "${XVFB_PID}" 2>/dev/null && kill -0 "${CHROMIUM_PID}" 2>/dev/null; do
    sleep 2
  done
}
wait_any
kill ${CHROMIUM_PID} ${XVFB_PID} 2>/dev/null
exit 1
