#!/bin/sh
set -e

SECRET_FILE="/app/.wrangler/state/.jwt_secret"

# 若未手动指定 JWT_SECRET，则从持久化文件读取或自动生成
if [ -z "${JWT_SECRET:-}" ]; then
  if [ -f "$SECRET_FILE" ]; then
    JWT_SECRET="$(cat "$SECRET_FILE")"
  else
    JWT_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(48).toString('hex'))")"
    mkdir -p "$(dirname "$SECRET_FILE")"
    printf '%s' "$JWT_SECRET" > "$SECRET_FILE"
    chmod 600 "$SECRET_FILE"
    echo "PassVault: JWT_SECRET 已自动生成并保存至 $SECRET_FILE"
  fi
fi

# 将环境变量写入 wrangler 所需的 .dev.vars 文件
{
  echo "JWT_SECRET=${JWT_SECRET}"
  [ -n "${WEBAUTHN_RP_ID:-}" ]          && echo "WEBAUTHN_RP_ID=${WEBAUTHN_RP_ID}"
  [ -n "${WEBAUTHN_RP_NAME:-}" ]        && echo "WEBAUTHN_RP_NAME=${WEBAUTHN_RP_NAME}"
  [ -n "${WEBAUTHN_ALLOWED_ORIGINS:-}" ] && echo "WEBAUTHN_ALLOWED_ORIGINS=${WEBAUTHN_ALLOWED_ORIGINS}"
} > /app/.dev.vars

# 启动系统 cron 守护进程（用于定时触发 WebDAV 备份）
cron

exec /app/node_modules/.bin/wrangler dev \
  -c wrangler.docker.toml \
  --ip 0.0.0.0 \
  --port 8787 \
  --no-live-reload
