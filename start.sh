#!/bin/sh
set -e

# 校验必填变量
: "${JWT_SECRET:?请在 .env 文件中设置 JWT_SECRET}"

# 将环境变量写入 wrangler 所需的 .dev.vars 文件
{
  echo "JWT_SECRET=${JWT_SECRET}"
  [ -n "${WEBAUTHN_RP_ID:-}" ]          && echo "WEBAUTHN_RP_ID=${WEBAUTHN_RP_ID}"
  [ -n "${WEBAUTHN_RP_NAME:-}" ]        && echo "WEBAUTHN_RP_NAME=${WEBAUTHN_RP_NAME}"
  [ -n "${WEBAUTHN_ALLOWED_ORIGINS:-}" ] && echo "WEBAUTHN_ALLOWED_ORIGINS=${WEBAUTHN_ALLOWED_ORIGINS}"
} > /app/.dev.vars

exec /app/node_modules/.bin/wrangler dev \
  -c wrangler.docker.toml \
  --ip 0.0.0.0 \
  --port 8787 \
  --no-live-reload
