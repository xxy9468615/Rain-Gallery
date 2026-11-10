# -*- coding: utf-8 -*-
"""============================================================
 《雨夜画廊》免费内置 AI 代理（v3.0）
 ------------------------------------------------------------
 作用：
   1. 托管游戏静态文件（index.html / css / js / assets）
   2. POST /api/chat  —— 嫌疑人台词 / 陪审团 / 侧写报告（主通道）
   3. POST /api/judge —— 「是否戳穿矛盾」AI 裁判（独立计额，不占主额度）
   4. GET  /api/status—— 免费通道可用性 / 模型名 / 本会话剩余额度

 配置（全部来自环境变量 / 创空间 Secret，代码零硬编码）：
   RG_PROXY_TOKEN     平台免费 Key（主用；缺省回退读 MODELSCOPE_SDK_TOKEN）
   RG_PROXY_API_BASE  上游 OpenAI 兼容接口完整 URL
   RG_PROXY_MODEL     免费通道使用的模型 ID（前端不可指定）
   RG_DAILY_CAP       全局每日调用上限（默认 20000，评审期可调大）

 隐私声明（重要，与 README / 设置面板 / 创作手记保持一致）：
   本代理**不记录、不落盘任何对话内容**，内存中仅保存计数额
   （会话 ID → 次数、IP → 次数、当日全局计数）。重启即清零。
   自填 Token 模式不经本代理，浏览器直连官方端点。

 运行：python app.py（默认监听 0.0.0.0:7860，创空间 Gradio SDK 兼容）
============================================================"""
import os
import time
from datetime import date

import httpx
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

# ---------------- 配置 ----------------
PROXY_TOKEN = (os.environ.get("RG_PROXY_TOKEN") or os.environ.get("MODELSCOPE_SDK_TOKEN") or "").strip()
API_BASE = os.environ.get("RG_PROXY_API_BASE", "https://api-inference.modelscope.cn/v1/chat/completions").strip()
PROXY_MODEL = os.environ.get("RG_PROXY_MODEL", "Qwen/Qwen3.8-Flash-Next").strip()
DAILY_CAP = max(1, int(os.environ.get("RG_DAILY_CAP", "20000")))

SESSION_CAP = 150          # 每局（会话）主调用上限：一局问答约 30~60 次，余量充足
JUDGE_SESSION_CAP = 300    # 裁判调用独立额度（不占 150 主额度），仅防滥用
IP_HOURLY_CAP = 1000       # 单 IP 每小时总调用（防脚本刷量；正常玩家远达不到）
# max_tokens 上限：推理模型（如 spark-x2.6）思维链也占额度，台词语 JSON 约 100~200
# 但长上下文下思维链可达数千 token。1200 为实测安全下限，防止"content 为空"回退本地。
MAX_TOKENS_CAP = 1200
JUDGE_MAX_TOKENS = 400     # 裁判只输出小 JSON，但思维链较长,400 才够
UPSTREAM_TIMEOUT = 90.0


def _global_cap():
    """允许测试与运维动态调整全局日上限（默认 RG_DAILY_CAP）"""
    return getattr(_global_cap, "value", DAILY_CAP)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

app = FastAPI(title="Rain Gallery Free-AI Proxy", docs_url=None, redoc_url=None)

# ---------------- CORS（静态托管的前端需要跨域调用本代理） ----------------
# 策略：留空 = 只允许同源，跨域一律拒绝（默认拒绝，fail-closed）。
#   - 同域部署（创空间 / 本仓库 app.py 自己托管静态文件）：浏览器不发 Origin，
#     中间件直接放行，无需任何配置。
#   - 前后端分域（前端 GitHub Pages + 后端 Render）：必须显式把前端 Origin
#     写进 CORS_ALLOWED_ORIGINS，例如 https://user.github.io。
#   - 只有在本地调试时才值得写 CORS_ALLOWED_ORIGINS=*（任意来源可跨域调用，
#     会消耗共享日额度，且 CORS 拦不住非浏览器客户端，不能当鉴权用）。
# allow_credentials=False：免费通道不依赖 Cookie，绝不与 allow_origins=["*"] 组合放大风险。
# 注意：前端不向本代理发送 Authorization 头（免费通道由服务端持 Key），
#       故 allow_headers 只列实际会用到的两个；多列一个会让预检放宽而毫无收益。
def _cors_origins() -> list:
    """解析 CORS 来源白名单（逗号分隔）；空列表 = 未配置 = 拒绝跨域。"""
    raw = os.environ.get("CORS_ALLOWED_ORIGINS", "")
    return [o.strip() for o in raw.split(",") if o.strip()]


app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "X-Session-Id"],
    # 跨域时浏览器默认只让脚本读取 CORS 安全响应头；Retry-After 不在其中。
    # 前端 _rawProxy 靠它做限流退避，不透出的话分域部署下会静默退回固定 2s 退避
    # ——而这正是本 PR 新增的场景（CodeRabbit 抓到）。
    expose_headers=["Retry-After"],
)

# ---------------- 计数额（内存态，重启清零；不含任何对话内容） ----------------
_sessions = {}   # sessionId -> {"chat": int, "judge": int}
_ip_hour = {}    # ip -> (hour_bucket, count)
_global = {"day": None, "count": 0}


def _today():
    """当天日期字符串，全局日上限按它归零。"""
    return date.today().isoformat()


def _client_ip(request: Request) -> str:
    """创空间等平台有反向代理：优先取 X-Forwarded-For 首段真实 IP。"""
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip", "")
    if real:
        return real.strip()
    return request.client.host if request.client else "unknown"


def _session_counts(session_id: str):
    """取（必要时创建）某会话的计额桶；仅存计数，不含任何对话内容。"""
    return _sessions.setdefault(session_id, {"chat": 0, "judge": 0})


def _global_ok() -> bool:
    """全局当日额度是否还有余量；跨天自动归零。"""
    today = _today()
    if _global["day"] != today:
        _global["day"] = today
        _global["count"] = 0
    return _global["count"] < _global_cap()


def _ip_ok(ip: str) -> bool:
    """单 IP 每小时额度闸（防脚本刷量）；超额返回 False 即拒绝。"""
    bucket = int(time.time() // 3600)
    cur = _ip_hour.get(ip)
    if not cur or cur[0] != bucket:
        _ip_hour[ip] = (bucket, 1)
        return True
    if cur[1] >= IP_HOURLY_CAP:
        return False
    _ip_hour[ip] = (bucket, cur[1] + 1)
    return True


def _err(status: int, code: str, message: str) -> JSONResponse:
    """统一错误响应体：{"error": {"code", "message"}}，前端按 code 分流提示。"""
    return JSONResponse({"error": {"code": code, "message": message}}, status_code=status)


# ---------------- 免费通道状态 ----------------
@app.get("/api/status")
async def api_status(request: Request):
    """免费通道可用性 / 模型名 / 本会话与当日剩余额度（无任何对话内容）。"""
    session_id = request.headers.get("x-session-id", "")
    used = _sessions.get(session_id, {}).get("chat", 0) if session_id else 0
    return {
        "available": bool(PROXY_TOKEN),
        "model": PROXY_MODEL,
        "sessionCap": SESSION_CAP,
        "sessionUsed": used,
        "sessionRemaining": max(0, SESSION_CAP - used),
        "dailyRemaining": max(0, _global_cap() - _global["count"]) if _global["day"] == _today() else _global_cap(),
    }


# ---------------- 统一转发 ----------------
async def _forward(request: Request, kind: str):
    """免费通道统一入口：校验 → 计额 → 转发上游（chat 支持 SSE 流式，judge 非流式）。

    前端传来的 model / Authorization 一律忽略：模型与 Key 由服务端环境变量决定，
    玩家 Token 也不会经过本代理（自填 Key 时浏览器直连官方端点）。
    """
    if not PROXY_TOKEN:
        return _err(503, "PROXY_UNAVAILABLE", "免费通道未配置平台 Key（RG_PROXY_TOKEN），请使用自定义 Key 模式")

    body = await request.body()
    try:
        import json
        payload = json.loads(body or b"{}")
    except Exception:
        return _err(400, "BAD_JSON", "请求体不是合法 JSON")

    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        return _err(400, "BAD_REQUEST", "缺少 messages")

    # 关键：忽略前端传来的 model / Authorization —— 免费通道一律用平台配置的模型与 Key
    stream = bool(payload.get("stream"))
    upstream = {
        "model": PROXY_MODEL,
        "messages": messages,
        "temperature": float(payload.get("temperature", 0.8)),
        "stream": stream,
    }
    if kind == "judge":
        # 裁判只输出小 JSON，且不允许流式（前端按键判定、解析简单）
        upstream["max_tokens"] = JUDGE_MAX_TOKENS
        upstream["temperature"] = 0.0
        upstream["stream"] = False
        stream = False
    else:
        upstream["max_tokens"] = min(MAX_TOKENS_CAP, int(payload.get("maxTokens", 360) or 360))

    # ---- 计额（对话内容不入内存、不入日志） ----
    ip = _client_ip(request)
    if not _ip_ok(ip):
        return _err(429, "IP_LIMIT", "该地址请求过于频繁，请稍后再试")
    if not _global_ok():
        return _err(429, "GLOBAL_LIMIT", "今日免费额度已用完，可填写自己的魔搭 Token 继续")
    session_id = request.headers.get("x-session-id", "") or ip
    counts = _session_counts(session_id)
    key = "judge" if kind == "judge" else "chat"
    cap = JUDGE_SESSION_CAP if kind == "judge" else SESSION_CAP
    if counts[key] >= cap:
        left = max(0, SESSION_CAP - counts["chat"])
        return _err(429, "SESSION_LIMIT",
                    f"本局免费 AI 次数已用完（{cap} 次）。{'' if kind == 'judge' else f'主通道剩余 {left} 次；'}可填写自己的魔搭 Token 继续深挖")
    counts[key] += 1
    _global["count"] += 1

    # ---- 转发上游 ----
    # trust_env=False：忽略 HTTP(S)_PROXY 与系统代理，直连上游端点
    # （本地开发机的系统代理会把 127.0.0.1/内网请求也劫走，创空间环境同理更稳妥）
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {PROXY_TOKEN}"}

    # ---- 流式透传（SSE）:台词边生成边显示，缓解长推理模型的等待感 ----
    if stream:
        async def event_gen():
            """逐行透传上游 SSE；流已开始则以 error 事件通知前端回退本地剧本。"""
            try:
                async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT, trust_env=False) as client:
                    async with client.stream("POST", API_BASE, json=upstream, headers=headers) as resp:
                        if resp.status_code != 200:
                            # 流已开始则无法改状态码，以 SSE error 事件通知前端回退
                            detail = (await resp.aread()).decode("utf-8", "ignore")[:160]
                            yield f"event: error\ndata: {json.dumps({'code': f'HTTP_{resp.status_code}', 'message': detail or '上游错误'})}\n\n"
                            return
                        async for line in resp.aiter_lines():
                            if line is None:
                                continue
                            yield line + "\n"
                            if line.strip() == "data: [DONE]":
                                return
            except httpx.TimeoutException:
                yield f"event: error\ndata: {json.dumps({'code': 'UPSTREAM_TIMEOUT', 'message': '上游流式响应超时'})}\n\n"
            except Exception as exc:
                yield f"event: error\ndata: {json.dumps({'code': 'UPSTREAM_ERROR', 'message': f'上游连接中断：{type(exc).__name__}'})}\n\n"

        return StreamingResponse(event_gen(), media_type="text/event-stream", headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # 禁用 nginx 缓冲，确保逐行推送
        })

    # ---- 非流式 ----
    try:
        async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT, trust_env=False) as client:
            resp = await client.post(API_BASE, json=upstream, headers=headers)
    except httpx.TimeoutException:
        return _err(504, "UPSTREAM_TIMEOUT", "上游模型服务超时，请稍后重试")
    except Exception as exc:  # 网络异常等
        return _err(502, "UPSTREAM_ERROR", f"上游请求失败：{type(exc).__name__}")

    if resp.status_code == 401 or resp.status_code == 403:
        return _err(502, "UPSTREAM_AUTH", "平台 Key 无效或缺少权限（请检查 RG_PROXY_TOKEN 是否勾选 API-Inference）")
    if resp.status_code == 429:
        # 上游限流：前端会按 RATE_LIMIT 自动退避重试
        retry_after = resp.headers.get("retry-after", "")
        out = _err(429, "RATE_LIMIT", "模型服务繁忙（上游 429），已自动排队重试")
        if retry_after:
            out.headers["retry-after"] = retry_after
        return out
    if resp.status_code >= 500:
        return _err(resp.status_code, f"HTTP_{resp.status_code}", "模型服务繁忙，已自动排队重试")
    if resp.status_code != 200:
        detail = resp.text[:160]
        return _err(resp.status_code, f"HTTP_{resp.status_code}", f"上游返回 {resp.status_code}：{detail}")

    # 透传上游 JSON（OpenAI 兼容格式）；只解包校验，不落盘
    try:
        data = resp.json()
        content = data["choices"][0]["message"]["content"]
        if not content:
            raise KeyError("empty")
    except Exception:
        return _err(502, "BAD_UPSTREAM", "上游返回内容异常")
    return JSONResponse(data)



@app.post("/api/chat")
async def api_chat(request: Request):
    """嫌疑人台词 / 陪审团 / 侧写报告主通道（可流式，占用会话主额度）。"""
    return await _forward(request, "chat")


@app.post("/api/judge")
async def api_judge(request: Request):
    """「是否戳穿矛盾」AI 裁判通道（强制非流式，占用独立额度）。"""
    return await _forward(request, "judge")


# ---------------- Gradio 入口页（创空间 gradio 框架要求 app.py 暴露 demo） ----------------
# 布局：/        → Gradio 入口页（作品介绍 + 开始游戏按钮）
#       /game/   → 游戏本体（静态托管，index.html 在此）
#       /api/*   → 免费 AI 代理（/api/chat /api/judge /api/status）
import gradio as gr  # noqa: E402（延迟导入：本地静态模式无 gradio 也能跑）


def _build_demo():
    """构建创空间 Gradio 入口页（介绍 + 开始游戏按钮），本地静态模式无 gradio 时跳过。"""
    with gr.Blocks(title="雨夜画廊 · Rain Gallery", theme=gr.themes.Default()) as demo:
        gr.HTML("""
        <div style="text-align:center;font-family:serif;padding:26px 10px 8px;">
          <h1 style="letter-spacing:.25em;color:#e0c56a;margin:0 0 6px;">雨 夜 画 廊</h1>
          <p style="color:#9aa8bb;font-size:13px;margin:0 0 18px;">暴雨夜的私人画廊，镇馆之宝被毁、守夜人昏迷，
          三名嫌疑人都说「什么都没看见」。</p>
        </div>""")
        gr.Markdown(
            "**AI 驱动的微型推理解谜游戏** — 由大模型实时扮演会撒谎、会动摇、会崩溃的嫌疑人："
            "自由审问、出示物证、戳穿矛盾，天亮前指认真凶。\n\n"
            "- 🎁 免费 AI 已内置（本站后端持有平台 Key，**无需配置即可体验**）\n"
            "- 🧠 NPC 决策闭环：嫌疑人会**自主决策**（交出/销毁照片、叫律师、甩锅……），"
            "行动由游戏规则层校验并**真实改变案情**\n"
            "- 📊 每名嫌疑人实时显示 压力 / 信任 / 敌意 三维数值\n"
            "- 约 10~20 分钟通关 · 支持手机 · 进度自动保存 · 断网自动切本地剧本",
            elem_id="intro-md",
        )
        gr.HTML("""
        <div style="text-align:center;margin:14px 0 24px;">
          <a href="/game/" style="display:inline-block;padding:12px 34px;border-radius:10px;
             background:linear-gradient(135deg,#e0a94e,#c98a2e);color:#14100a;font-weight:700;
             font-size:16px;text-decoration:none;letter-spacing:.08em;">▶ 推开画廊的玻璃门 · 开始游戏</a>
        </div>""")
        gr.Markdown(
            "---\n<sub>AI+∞ 开发者创作大赛第三期「AI造游戏」参赛作品 · "
            "提问内容经本站后端转送至模型服务，后端仅计数额、不记录对话内容（代码开源可查）· "
            "也可在游戏内切换「自定义 Key」模式直连官方端点</sub>",
            elem_id="foot-md",
        )
    return demo


demo = _build_demo()

# 游戏挂在 /game/（Gradio 占根路径；/api/* 已在 Gradio 挂载前注册，保持可用）
app.mount("/game", StaticFiles(directory=BASE_DIR, html=True), name="game")

# 统一入口：Gradio 提供根路径 UI + 文档 + 静态资源，原 FastAPI 应用作为宿主
_root = gr.mount_gradio_app(app, demo, path="/", favicon_path=os.path.join(BASE_DIR, "assets", "favicon.svg"))

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "7860"))
    uvicorn.run(_root, host="0.0.0.0", port=port, log_level="warning")
