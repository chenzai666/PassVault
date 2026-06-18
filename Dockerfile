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

# 配置定时任务，每5分钟触发一次 scheduled 事件
RUN echo '*/5 * * * * root curl -sf "http://localhost:8787/__scheduled?cron=*%%2F5+*+*+*+*" > /dev/null 2>&1' > /etc/cron.d/passvault-backup \
    && chmod 644 /etc/cron.d/passvault-backup

EXPOSE 8787

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
