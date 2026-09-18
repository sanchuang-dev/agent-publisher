FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    BROWSER_PROFILE_DIR=/data/profile

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        chromium-sandbox \
        curl \
        fonts-liberation \
        gosu \
        novnc \
        tini \
        websockify \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/sh browser \
    && mkdir -p /data/profile \
    && chown -R browser:browser /data

COPY start-browser.sh /usr/local/bin/start-browser

RUN chmod +x /usr/local/bin/start-browser

EXPOSE 6080 9222

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 \
  CMD curl --fail --silent --show-error http://127.0.0.1:9222/json/version >/dev/null \
    && curl --fail --silent --show-error http://127.0.0.1:6080/vnc.html >/dev/null \
    || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-browser"]
