# -*- coding: utf-8 -*-
"""测试用 API 启动器：复用 app.py 的真实 FastAPI app 与 /api/* 路由，
但不构建 Gradio 入口页（本地/CI 无需安装 gradio）。
用法：tools/_api_server.py [--port 8092]
"""
import os, sys, argparse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)


class _Any:
    """吸收 gradio 的所有属性访问与调用，用于测试环境跳过入口页构建。"""
    def __getattr__(self, _k):
        return _Any()

    def __call__(self, *a, **kw):
        return _Any()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


sys.modules['gradio'] = _Any()

# 优先用环境变量（CI / 容器），本地无 env 时回退读 .env
#
# 必须剥掉成对引号：.env 里写成 RG_PROXY_API_BASE="https://host/v1/chat/completions"
# 是常见写法（dotenv 标准），若不剥离，值会带着引号进入 httpx，URL scheme 变成
# 『https"』→ httpx 抛 UnsupportedProtocol，表现为 502 UPSTREAM_ERROR，
# 而 URL 本身看 repr 完全正常，极难定位。precheck.mjs 早就剥了，这里补齐对齐。
def _strip_quotes(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v


env_path = os.path.join(ROOT, '.env')
if os.path.exists(env_path):
    for line in open(env_path, encoding='utf-8'):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = line.split('=', 1)
        if len(m) == 2 and m[0].isupper() and not os.environ.get(m[0]):
            os.environ[m[0]] = _strip_quotes(m[1])

import importlib  # noqa: E402
import uvicorn  # noqa: E402

app_mod = importlib.import_module('app')

ap = argparse.ArgumentParser()
ap.add_argument('--port', type=int, default=8092)
ap.add_argument('--host', default='127.0.0.1')
args = ap.parse_args()

if __name__ == '__main__':
    uvicorn.run(app_mod.app, host=args.host, port=args.port, log_level='warning')
