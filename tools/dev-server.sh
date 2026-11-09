#!/usr/bin/env bash
# 本地开发服务:加载本地密钥配置启动 app.py(与创空间环境变量同构)
# 支持 .env(推荐,标准 RG_PROXY_* 命名)或 .evn(旧命名,自动映射)
# 用法:bash tools/dev-server.sh [端口]
set -e
ENV_FILE=""
[ -f ./.env ] && ENV_FILE="./.env"
[ -z "$ENV_FILE" ] && [ -f ./.evn ] && ENV_FILE="./.evn"
if [ -z "$ENV_FILE" ]; then
  echo "✗ 未找到 .env 或 .evn。请创建 .env,内容:"
  echo '  RG_PROXY_API_BASE="https://.../v1/chat/completions"'
  echo '  RG_PROXY_TOKEN=ak-xxxx'
  echo '  RG_PROXY_MODEL=model-id'
  exit 1
fi
set -a
. "$ENV_FILE"
set +a
# 旧格式兼容:CUEL/API_KEY/MODEL → RG_PROXY_*
export RG_PROXY_TOKEN="${RG_PROXY_TOKEN:-$API_KEY}"
export RG_PROXY_API_BASE="${RG_PROXY_API_BASE:-$CUEL}"
export RG_PROXY_MODEL="${RG_PROXY_MODEL:-$MODEL}"
export PORT="${1:-8092}"
echo "▶ 启动 app.py (PORT=$PORT MODEL=$RG_PROXY_MODEL BASE=$RG_PROXY_API_BASE)"
.venv-test/Scripts/python.exe app.py
