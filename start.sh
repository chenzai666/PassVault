#!/bin/sh
set -e

STATE_DIR="/app/.wrangler/state"
JWT_SECRET_FILE="$STATE_DIR/.jwt_secret"
CRON_SECRET_FILE="$STATE_DIR/.cron_secret"

# 自动生成并持久化密钥的通用函数
load_or_gen_secret() {
  local file="$1" label="$2"
  if [ -f "$file" ]; then
    cat "$file"
  else
    local val
    val="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")"
    mkdir -p "$STATE_DIR"
    printf '%s' "$val" > "$file"
    chmod 600 "$file"
    echo "PassVault: $label 已自动生成并保存至 $file" >&2
    printf '%s' "$val"
  fi
}

if [ -z "${JWT_SECRET:-}" ]; then
  JWT_SECRET="$(load_or_gen_secret "$JWT_SECRET_FILE" "JWT_SECRET")"
fi

if [ -z "${CRON_SECRET:-}" ]; then
  CRON_SECRET="$(load_or_gen_secret "$CRON_SECRET_FILE" "CRON_SECRET")"
fi

# 将环境变量写入 wrangler 所需的 .dev.vars 文件
{
  echo "JWT_SECRET=${JWT_SECRET}"
  echo "CRON_SECRET=${CRON_SECRET}"
  [ -n "${WEBAUTHN_RP_ID:-}" ]          && echo "WEBAUTHN_RP_ID=${WEBAUTHN_RP_ID}"
  [ -n "${WEBAUTHN_RP_NAME:-}" ]        && echo "WEBAUTHN_RP_NAME=${WEBAUTHN_RP_NAME}"
  [ -n "${WEBAUTHN_ALLOWED_ORIGINS:-}" ] && echo "WEBAUTHN_ALLOWED_ORIGINS=${WEBAUTHN_ALLOWED_ORIGINS}"
} > /app/.dev.vars

# 确保挂载的 volume 对 node 用户可写（volume 初次创建时可能为 root 所有）
chown -R node:node "$STATE_DIR"

# 启动系统 cron 守护进程（需要 root，仅执行 curl 触发内部端点）
cron

# 主进程以非 root 的 node 用户运行，gosu 保证信号正确转发
exec gosu node /app/node_modules/.bin/wrangler dev \
  -c wrangler.docker.toml \
  --ip 0.0.0.0 \
  --port 8787 \
  --no-live-reload
