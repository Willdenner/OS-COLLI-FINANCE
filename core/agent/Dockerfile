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

COPY package*.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

COPY src ./src
COPY database ./database
COPY README.md ./
COPY .env.example ./

RUN mkdir -p /app/data

EXPOSE 3000

VOLUME ["/app/data"]

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
