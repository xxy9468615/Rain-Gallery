#!/usr/bin/env bash
# 本地开发服务:加载本地密钥配置启动 app.py(与创空间环境变量同构)
# 支持 .env(推荐,标准 RG_PROXY_* 命名)或 .evn(旧命名,自动映射)
# 用法:bash tools/dev-server.sh [端口]
# 跨平台:pip/PATH 探测 Python,不再假设 .venv-test/Scripts(Windows venv 布局)
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

# ── Python 解释器探测（跨平台）──
# 优先 $PYTHON 环境变量；其次本仓库 venv（按平台区分 bin/Scripts）；
# 最后退回 PATH 上的 python3/python。
# 注意：.venv-test/ 若是在别的平台建的（Windows 的 Scripts/ 在 Linux 下不可执行），
# 只查文件存在会选中一个跑不起来的解释器，因此必须真正执行一次探活。
pick_python() {
  local c
  for c in "${PYTHON:-}" ./.venv-test/bin/python ./.venv-test/Scripts/python.exe python3 python; do
    [ -n "$c" ] || continue
    command -v "$c" >/dev/null 2>&1 || [ -x "$c" ] || continue
    # 三件套都要探活：app.py 顶层无条件 import fastapi/uvicorn/httpx，
    # 只查 fastapi 会在缺 uvicorn/httpx 时选中一个 import 阶段就崩的解释器
    if "$c" -c 'import fastapi, uvicorn, httpx' 2>/dev/null; then echo "$c"; return 0; fi
  done
  return 1
}

PY="$(pick_python)" || {
  echo "✗ 未找到可用的 Python 解释器（需已安装 fastapi / uvicorn / httpx）。"
  echo "  安装：python3 -m pip install -r requirements.txt"
  echo "  或设 PYTHON=/path/to/python 指定已装好依赖的解释器。"
  exit 1
}

echo "▶ 启动 app.py (PORT=$PORT MODEL=$RG_PROXY_MODEL BASE=$RG_PROXY_API_BASE)"
echo "  解释器: $PY"
# 仓库根入 sys.path，使 `python tools/_api_server.py` 之外的方式也能 import app
PYTHONPATH="$(pwd)${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" app.py
