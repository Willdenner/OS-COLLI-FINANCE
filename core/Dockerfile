FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    BOT_DATA_DIR=/app/data

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

COPY agent/package*.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

COPY agent/src ./src
COPY agent/database ./database
COPY agent/README.md ./

RUN mkdir -p /app/data

EXPOSE 3000

VOLUME ["/app/data"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
