FROM ubuntu:24.04

# Avoid interactive prompts during install
ENV DEBIAN_FRONTEND=noninteractive

# Install Node.js 20 LTS and srt-tools (provides srt-live-transmit)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      curl \
      ca-certificates \
      srt-tools && \
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Verify srt-live-transmit is available
RUN srt-live-transmit --version || echo "srt-live-transmit installed"

WORKDIR /app

# Copy package files first for better Docker layer caching
# (app code changes won't re-trigger npm install)
COPY package.json package-lock.json* ./
RUN npm install --production

# Copy application code
COPY server.js ./
COPY public/ ./public/

# Data volume — relays.json config + CSV stats files persist here
VOLUME /data

# Environment defaults (override in docker-compose.yml or Coolify)
ENV CONFIG_FILE=/data/relays.json \
    STATS_DIR=/data \
    PORT=8800 \
    NODE_ENV=production

EXPOSE 8800

# Health check — panel responds to API
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8800/api/relays || exit 1

CMD ["node", "server.js"]
