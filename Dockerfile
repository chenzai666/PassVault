FROM node:22-slim

# 安装必要工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    cron \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制 package.json 以利用 Docker 层缓存
COPY package*.json ./
RUN npm ci

# 复制源码并构建前端
COPY . .
RUN npm run build

# 创建持久化目录
RUN mkdir -p .wrangler/state

# 配置定时任务：每5分钟通过受保护的内部端点触发备份检查
RUN printf '*/5 * * * * root CRON_SECRET=$(cat /app/.wrangler/state/.cron_secret 2>/dev/null || true); [ -n "$CRON_SECRET" ] && curl -sf -X POST -H "X-Cron-Token: $CRON_SECRET" http://localhost:8787/api/internal/cron-trigger > /dev/null 2>&1\n' > /etc/cron.d/passvault-backup \
    && chmod 644 /etc/cron.d/passvault-backup

EXPOSE 8787

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
