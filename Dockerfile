FROM node:24-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

# Install OpenCode CLI globally (optional but used by Engineering Agent)
RUN npm install -g @anthropic-ai/opencode@latest 2>/dev/null || true

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY core/ core/
COPY storage/ storage/
COPY connectors/ connectors/
COPY apps/hq/server.ts apps/hq/server.ts
COPY apps/hq/public/ apps/hq/public/
COPY config/ config/

# Create required directories for runtime
RUN mkdir -p /data/vault /app/data

ENV HQ_HOST=0.0.0.0
ENV HQ_PORT=3200
ENV SECOND_BRAIN_VAULT=/data/vault
ENV SECOND_BRAIN_DATA_DIR=/app/data
ENV NODE_ENV=production

EXPOSE 3200

HEALTHCHECK --interval=15s --timeout=10s --start-period=20s --retries=5 \
  CMD curl -f http://localhost:3200/health || exit 1

CMD ["node", "--experimental-strip-types", "apps/hq/server.ts"]
