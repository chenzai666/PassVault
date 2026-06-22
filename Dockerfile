FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    curl \
    gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

RUN mkdir -p .wrangler/state \
    && chown -R node:node /app

# cron job 以 root 身份运行（系统 cron 守护进程要求），仅执行 curl 触发内部端点
RUN printf '*/5 * * * * root CRON_SECRET=$(cat /app/.wrangler/state/.cron_secret 2>/dev/null || true); [ -n "$CRON_SECRET" ] && curl -sf -X POST -H "X-Cron-Token: $CRON_SECRET" http://localhost:8787/api/internal/cron-trigger > /dev/null 2>&1\n' > /etc/cron.d/passvault-backup \
    && chmod 644 /etc/cron.d/passvault-backup

EXPOSE 8787

COPY start.sh /start.sh
RUN chmod +x /start.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD curl -sf http://localhost:8787/api/version || exit 1

CMD ["/start.sh"]
