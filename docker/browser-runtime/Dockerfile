FROM debian:bookworm-slim

ARG DEBIAN_MIRROR=

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    BROWSER_PROFILE_DIR=/data/profile

RUN if [ -n "$DEBIAN_MIRROR" ]; then \
      sed -i "s|deb.debian.org|$DEBIAN_MIRROR|g" /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        chromium-sandbox \
        curl \
        fonts-liberation \
        gosu \
        novnc \
        socat \
        tini \
        util-linux \
        websockify \
        x11vnc \
        xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 1000 --shell /bin/sh browser \
    && mkdir -p /data/profile \
    && chown -R browser:browser /data

COPY start-browser.sh /usr/local/bin/start-browser
COPY health-browser.sh /usr/local/bin/health-browser

RUN chmod +x /usr/local/bin/start-browser /usr/local/bin/health-browser

EXPOSE 6080 9222

HEALTHCHECK --interval=5s --timeout=3s --start-period=15s --retries=12 \
  CMD ["/usr/local/bin/health-browser"]

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/start-browser"]
