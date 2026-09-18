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
  --remote-debugging-address=0.0.0.0 \
  --remote-debugging-port=9222 \
  --user-data-dir="${CHROMIUM_PROFILE_DIR}" \
  --no-first-run \
  --disable-default-apps \
  about:blank &
CHROMIUM_PID=$!

# Forward signals to child processes
trap 'kill ${CHROMIUM_PID} ${XVFB_PID} 2>/dev/null; exit 0' SIGTERM SIGINT

# Wait for Chromium to exit; if Xvfb dies first the container exits too
wait ${CHROMIUM_PID}
