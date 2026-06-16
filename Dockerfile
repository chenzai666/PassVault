FROM node:22-slim

# 安装必要工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
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

EXPOSE 8787

COPY start.sh /start.sh
RUN chmod +x /start.sh

CMD ["/start.sh"]
