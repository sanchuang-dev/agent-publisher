FROM debian:bookworm-slim

# Install Xvfb, Chromium, and curl for healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        xvfb \
        curl \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user for running the browser
RUN useradd -m -u 1000 -s /bin/bash browseruser

# Profile directory
ENV CHROMIUM_PROFILE_DIR=/data/profile
ENV DISPLAY=:99

RUN mkdir -p /data/profile && chown browseruser:browseruser /data/profile

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Internal CDP port
EXPOSE 9222

USER browseruser

ENTRYPOINT ["/entrypoint.sh"]
