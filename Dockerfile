FROM node:24-slim

# Force fresh build - cache bust
LABEL version="2.0"

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Copy all core modules
COPY core/ core/
COPY storage/ storage/
COPY connectors/ connectors/
COPY config/ config/
COPY schemas/ schemas/

# Copy apps
COPY apps/hq/server.ts apps/hq/server.ts
COPY apps/hq/public/ apps/hq/public/
COPY apps/hq/package.json apps/hq/package.json
COPY apps/agent/ apps/agent/
COPY apps/nutriva/src/ apps/nutriva/src/
COPY apps/nutriva/public/ apps/nutriva/public/
COPY apps/nutriva/package.json apps/nutriva/package.json
COPY apps/cli/ apps/cli/

# Copy scripts
COPY scripts/ scripts/

# MCP
COPY mcp/src/ mcp/src/
COPY mcp/package.json mcp/package.json 2>/dev/null || true

RUN mkdir -p /data/vault /app/data

ENV HQ_HOST=0.0.0.0
ENV HQ_PORT=3200
ENV SECOND_BRAIN_VAULT=/data/vault
ENV SECOND_BRAIN_DATA_DIR=/app/data
ENV NODE_ENV=production

EXPOSE 3200

CMD ["node", "--experimental-strip-types", "apps/hq/server.ts"]
