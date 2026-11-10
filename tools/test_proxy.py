# -*- coding: utf-8 -*-
"""app.py 端到端验证脚本:mock 上游 + app.py + 断言一体化(仅本地测试用,不部署)"""
import json
import threading
import time
import urllib.request
import sys
import os

# ---- 1. mock 上游(线程) ----
from http.server import BaseHTTPRequestHandler, HTTPServer

STATE = {'429': False}

class MockUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('Content-Length', '0') or 0)
        body = json.loads(self.rfile.read(length) or b'{}')
        # 校验 app.py 是否强制覆盖 model、剥离客户端 token
        ok_model = body.get('model') == 'Test-Model'
        if STATE['429']:
            payload, code = json.dumps({'error': 'rate'}), 429
        else:
            payload, code = json.dumps({
                'choices': [{'message': {'content': json.dumps({
                    'reply': '(mock 台词)', 'action': 'none',
                    'trust_delta': 1, 'hostility_delta': 2})}}]
            }), 200
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload.encode())
        # 断言写文件供后续检查
        with open(os.path.join(os.path.dirname(__file__), '_upstream_ok.txt'), 'w') as f:
            f.write('model_ok' if ok_model else 'model_bad')

    def log_message(self, *a): pass

# urllib 会尊重 http_proxy/HTTP_PROXY 环境变量；本脚本靠的是本机 mock 上游与
# 127.0.0.1 自托管端口，一旦开发机设了系统代理就会被劫走（表现为莫名 502）。
# 因此这里显式关掉本脚本的代理，与 app.py 的 trust_env=False 保持一致。
for _k in ('http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY'):
    os.environ.pop(_k, None)

def call(method, path, headers=None, data=None):
    req = urllib.request.Request(f'http://127.0.0.1:7905{path}', method=method,
                                 data=json.dumps(data).encode() if data else None)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()

up = HTTPServer(('127.0.0.1', 9198), MockUpstream)
threading.Thread(target=up.serve_forever, daemon=True).start()

# ---- 2. 启动 app(同进程导入,避免端口/进程混乱) ----
os.environ['RG_PROXY_TOKEN'] = 'fake-ms-token-for-test'
os.environ['RG_PROXY_API_BASE'] = 'http://127.0.0.1:9198/v1/chat/completions'
os.environ['RG_PROXY_MODEL'] = 'Test-Model'
os.environ['PORT'] = '7905'

# 本脚本只测 /api/* 与静态托管，不需要 Gradio 入口页。
# 打桩 gradio:app.py 顶部 `import gradio` 在本地/CI 常未安装,不桩会直接 ImportError。
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class _GradioStub:
    """吸收 gradio 的属性访问与调用,让 app.py 在无 gradio 环境也能导入。"""
    def __getattr__(self, _k):
        return _GradioStub()

    def __call__(self, *a, **kw):
        return _GradioStub()

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def mount_gradio_app(self, app, *a, **kw):
        return app


if 'gradio' not in sys.modules:
    sys.modules['gradio'] = _GradioStub()  # type: ignore[assignment]

import app as appmod
from app import _global_cap, _cors_origins
import uvicorn
threading.Thread(
    target=lambda: uvicorn.run(appmod.app, host='127.0.0.1', port=7905, log_level='warning'),
    daemon=True).start()
time.sleep(3)

results = []
def check(name, cond, detail=''):
    results.append((name, cond, detail))
    print(('✓' if cond else '✗ FAIL'), name, detail if not cond else '')

s, b = call('GET', '/api/status', {'X-Session-Id': 'sess1'})
check('status 200', s == 200, b)

# A. 成功路径
s, b = call('POST', '/api/chat', {'X-Session-Id': 'sess1', 'Content-Type': 'application/json'},
            {'messages': [{'role': 'user', 'content': 'hi'}], 'maxTokens': 999999})
check('chat 200 + 上游强制模型', s == 200 and 'mock' in b, b)
check('上游看到服务端模型(忽略前端 model)', open(os.path.join(os.path.dirname(__file__), '_upstream_ok.txt')).read() == 'model_ok')

# B. judge 独立计额
for i in range(3):
    s, b = call('POST', '/api/judge', {'X-Session-Id': 'sessJ'}, {'messages': [{'role': 'user', 'content': 'j'}]})
check('judge 200 x3', s == 200, b)
s, b = call('GET', '/api/status', {'X-Session-Id': 'sessJ'})
check('judge 不占主额度(used=0)', '"sessionUsed":0' in b, b)

# C. 参数校验
s, b = call('POST', '/api/chat', {'X-Session-Id': 'x'}, {})
check('空 messages → 400', s == 400, b)

# D. X-Forwarded-For 取首段
s, b = call('POST', '/api/chat', {'X-Session-Id': 'xff1', 'X-Forwarded-For': '9.9.9.9, 10.0.0.1'}, {'messages': []})
# (messages 空会 400,但 IP 闸计数已生效——仅验证不崩溃)
check('XFF 解析不崩溃', s in (200, 400), b)

# E. 静态托管（app.py 把游戏挂在 /game/，根路径归 Gradio 入口页）
s, b = call('GET', '/game/index.html')
check('静态托管 /game/index.html', s == 200 and '雨夜画廊' in b, b[:80])
s, b = call('GET', '/game/')
check('目录索引 /game/', s == 200 and '雨夜画廊' in b, b[:80])

# G. 会话限流:150 次封顶 → SESSION_LIMIT
sess = 'limit-sess'
codes = []
for i in range(151):
    s, _ = call('POST', '/api/chat', {'X-Session-Id': sess}, {'messages': [{'role': 'user', 'content': 'x'}]})
    codes.append(s)
check('前 150 次全 200', all(c == 200 for c in codes[:150]), f'异常:{[c for c in codes[:150] if c != 200][:3]}')
check('第 151 次 → 429 SESSION_LIMIT', codes[150] == 429, f'got {codes[150]}')
s, b = call('GET', '/api/status', {'X-Session-Id': sess})
check('status 显示额度用尽', '"sessionRemaining":0' in b, b)
# judge 独立:主额度爆了 judge 仍可用
s, b = call('POST', '/api/judge', {'X-Session-Id': sess}, {'messages': [{'role': 'user', 'content': 'j'}]})
check('主额度爆后 judge 仍 200', s == 200, b)

# H. 全局日上限(小 cap 快速验证)
from app import _global_cap, _today, _global as G
_global_cap.value = 3
G["day"] = _today()   # 先对齐日期,避免 _global_ok 重置 count
G["count"] = 999      # 逼近上限:下一次即触发
s, b = call('POST', '/api/chat', {'X-Session-Id': 'g1'}, {'messages': [{'role': 'user', 'content': 'x'}]})
check('全局上限 → 429 GLOBAL_LIMIT', s == 429 and 'GLOBAL_LIMIT' in b, b)

# I. CORS fail-closed（未配置白名单 = 拒绝跨域，同源不受影响）
# 注意：进程级 CORS 中间件按启动时的 CORS_ALLOWED_ORIGINS 构建，
# 运行时改 env 无效，因此这里按当前进程实际配置反推断言。
#   未配置 → _cors_origins() 为空 → allow_origins=[] → 跨域请求不带 ACAO 头（浏览器拦截）
#   已配置 → 列出的源带回显 ACAO，未列出的源不带
ALLOWED = _cors_origins()
print('\nCORS 白名单:', ALLOWED or '（空 → 拒绝跨域）')

from starlette.testclient import TestClient  # noqa: E402
from starlette.middleware.cors import CORSMiddleware  # noqa: E402

_cors_mw = [m for m in appmod.app.user_middleware if m.cls is CORSMiddleware]
check('已注册 CORSMiddleware', len(_cors_mw) == 1)
if _cors_mw:
    check('allow_credentials=False', _cors_mw[0].kwargs.get('allow_credentials') is False)

_unknown_origin = 'https://cors-probe.example'
_allowed_origin = ALLOWED[0] if ALLOWED and ALLOWED[0] != '*' else 'https://a.github.io'
_client = TestClient(appmod.app)

# 未列来源：服务可用（CORS 拦不住非浏览器客户端），但不得回显 ACAO
_r = _client.get('/api/status', headers={'X-Session-Id': 'cors1', 'Origin': _unknown_origin})
check('未列来源的跨域请求:状态仍可用(非浏览器客户端照旧)',
      _r.status_code == 200, f'HTTP {_r.status_code}')
if '*' not in ALLOWED:
    check('未列来源 → 不回显 ACAO（浏览器会拦截）',
          _r.headers.get('access-control-allow-origin') is None,
          f'ACAO={_r.headers.get("access-control-allow-origin")}')

if ALLOWED:
    _ra = _client.get('/api/status', headers={'X-Session-Id': 'cors1', 'Origin': _allowed_origin})
    _acao = _ra.headers.get('access-control-allow-origin')
    if '*' in ALLOWED:
        check('通配配置 → 任意源获得 ACAO', _acao == '*', f'ACAO={_acao}')
    else:
        check('白名单源可获得 ACAO 回显', _acao == _allowed_origin, f'ACAO={_acao} 期望={_allowed_origin}')
else:
    _re = _client.get('/api/status', headers={'X-Session-Id': 'cors1', 'Origin': _unknown_origin})
    check('白名单为空 → 跨域请求不带 ACAO（默认拒绝）',
          _re.headers.get('access-control-allow-origin') is None,
          f'ACAO={_re.headers.get("access-control-allow-origin")}')

# 同源（无 Origin）必须始终放行：同域部署 / app.py 自托管静态文件都依赖这条
_r2 = _client.get('/api/status', headers={'X-Session-Id': 'cors2'})
check('同源请求(无 Origin) → 200', _r2.status_code == 200, f'HTTP {_r2.status_code}')

# 预检：白名单外的源不得拿到 allow-origin，白名单内的源必须拿到
_pre = _client.options('/api/chat', headers={
    'Origin': _unknown_origin,
    'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-session-id',
})
_pre_acao = _pre.headers.get('access-control-allow-origin')
check('预检:白名单外源不得获得 ACAO', _pre_acao is None or '*' in ALLOWED,
      f'ACAO={_pre_acao} 白名单={ALLOWED or "空"}')

if ALLOWED and '*' not in ALLOWED:
    _pre_ok = _client.options('/api/chat', headers={
        'Origin': _allowed_origin,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type,x-session-id',
    })
    check('预检:白名单内源获得 ACAO',
          _pre_ok.headers.get('access-control-allow-origin') == _allowed_origin,
          f'ACAO={_pre_ok.headers.get("access-control-allow-origin")} 期望={_allowed_origin}')

print('\n全部通过' if all(r[1] for r in results) else '\n存在失败项')
fails = [r for r in results if not r[1]]
sys.exit(1 if fails else 0)
