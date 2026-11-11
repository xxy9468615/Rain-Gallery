#!/usr/bin/env bash
# 本地开发服务:加载本地密钥配置启动 app.py(与创空间环境变量同构)
# 支持 .env(推荐,标准 RG_PROXY_* 命名)或 .evn(旧命名,自动映射)
# 用法:bash tools/dev-server.sh [端口]
# 跨平台:pip/PATH 探测 Python,不再假设 .venv-test/Scripts(Windows venv 布局)
set -e
ENV_FILE=""
[ -f ./.env ] && ENV_FILE="./.env"
[ -z "$ENV_FILE" ] && [ -f ./.evn ] && ENV_FILE="./.evn"
# RG_PROXY_SKIP_ENV_FILE=1 时允许完全没有 .env——纯外部环境变量启动
# （CI / 平台 Secret 形态）。存在性检查必须认这个开关，否则会先 exit 1。
if [ -z "$ENV_FILE" ] && [ "${RG_PROXY_SKIP_ENV_FILE:-0}" != "1" ]; then
  echo "✗ 未找到 .env 或 .evn。请创建 .env,内容:"
  echo '  RG_PROXY_API_BASE="https://.../v1/chat/completions"'
  echo '  RG_PROXY_TOKEN=ak-xxxx'
  echo '  RG_PROXY_MODEL=model-id'
  echo '  或设 RG_PROXY_SKIP_ENV_FILE=1 完全使用外部环境变量启动'
  exit 1
fi
# .env 只补空、不覆盖：外部环境变量（CI / 平台 Secret / 命令行临时覆盖）优先。
# 否则本地 .env 会静默盖掉 RG_PROXY_MODEL 等，表现为"明明换了配置却跑旧模型"。
if [ "${RG_PROXY_SKIP_ENV_FILE:-0}" = "1" ]; then
  echo "  ⚠ RG_PROXY_SKIP_ENV_FILE=1：跳过 .env，全部使用外部环境变量"
else
  # 先记下外部已设的值（含空值以外的任何显式设置），再 source
  _EXT_TOKEN="${RG_PROXY_TOKEN-__unset__}"
  _EXT_BASE="${RG_PROXY_API_BASE-__unset__}"
  _EXT_MODEL="${RG_PROXY_MODEL-__unset__}"
  _EXT_CAP="${RG_DAILY_CAP-__unset__}"
  _EXT_CORS="${CORS_ALLOWED_ORIGINS-__unset__}"
  set -a
  . "$ENV_FILE"
  set +a
  # 已显式设置的外部变量压回，避免被 .env 覆盖
  [ "$_EXT_TOKEN" != "__unset__" ] && export RG_PROXY_TOKEN="$_EXT_TOKEN"
  [ "$_EXT_BASE"  != "__unset__" ] && export RG_PROXY_API_BASE="$_EXT_BASE"
  [ "$_EXT_MODEL" != "__unset__" ] && export RG_PROXY_MODEL="$_EXT_MODEL"
  [ "$_EXT_CAP"   != "__unset__" ] && export RG_DAILY_CAP="$_EXT_CAP"
  [ "$_EXT_CORS"  != "__unset__" ] && export CORS_ALLOWED_ORIGINS="$_EXT_CORS"
  unset _EXT_TOKEN _EXT_BASE _EXT_MODEL _EXT_CAP _EXT_CORS
fi
# 旧格式兼容:CUEL/API_KEY/MODEL → RG_PROXY_*（仅当 RG_PROXY_* 仍未设置）
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
