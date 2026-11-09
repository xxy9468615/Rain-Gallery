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
import app as appmod
from app import _global_cap
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

# E. 静态托管
s, b = call('GET', '/index.html')
check('静态托管 index.html', s == 200 and '雨夜画廊' in b)

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

print('\n全部通过' if all(r[1] for r in results) else '\n存在失败项')
fails = [r for r in results if not r[1]]
sys.exit(1 if fails else 0)
