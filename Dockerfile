FROM node:20-slim

ENV NODE_ENV=production \
    PORT=3000 \
    BOT_DATA_DIR=/app/data

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY core/agent/package*.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

COPY core/agent/src ./src
COPY core/agent/database ./database
COPY core/agent/README.md ./

RUN mkdir -p /app/data

EXPOSE 3000

VOLUME ["/app/data"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
