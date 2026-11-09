---
domain:
- multi-modal
tags:
- AI造游戏
- 推理解谜
- 纯前端
- 交互叙事
license: Apache License 2.0
deployspec:
  sdk: gradio
  app_file: app.py
---

# 雨夜画廊 · Rain Gallery

> 暴雨夜的私人画廊，镇馆之宝被毁，守夜人昏迷，三个人都说自己"什么都没看见"。
> 天亮之前，找出真相。

**AI 驱动的微型推理解谜游戏** · AI+∞ 开发者创作大赛第三期「AI造游戏」参赛作品

三名嫌疑人由大模型实时扮演——撒谎、回避、被你问到手忙脚乱。你可以自由提问、出示物证、戳穿矛盾，最终指认凶手并勾出定罪证据链，获得 S/A/B/C 评分。

## 🎮 立即游玩

纯静态网页，无需安装：

- **在线试玩**：[魔搭创空间 · 立即游玩](https://modelscope.cn/studios/xyhome/solving-puzzle-game)（部署后试玩链接建议用 `.../game/` 路径）
- **本地运行**：任选一种方式
  ```bash
  # 方式一：Node
  npx serve .
  # 方式二：Python
  python -m http.server 8080
  # 方式三：直接双击 index.html（部分浏览器限制 ES Modules，推荐前两种）
  ```
  然后访问 `http://localhost:8080`

约 10~20 分钟通关 · 支持手机 · 进度自动保存 · 重开不丢档

## 🎁 AI 嫌疑人（默认免费内置 · 零配置）

部署在魔搭创空间时，服务端已持有平台 Key —— **玩家开箱即用，无需任何 Token**：
审讯、结案陈词、能力侧写、NPC 决策全部由大模型实时驱动。顶栏徽标会显示当前通道
（`🎁 免费AI·模型名`）。

**隐私说明（两种模式）**

| 模式 | 数据流向 | 隐私边界 |
|---|---|---|
| 🎁 免费内置（默认） | 提问经本作品创空间后端转发至模型服务 | 后端**仅计数额**，不记录、不落盘任何对话内容；代码开源可查 |
| 🔑 自定义 Key | 请求从你的浏览器**直连**魔搭官方端点 | 请求不经任何中转；Token 仅存浏览器 localStorage，不会上传到任何服务器 |

> 两种模式可随时在 ⚙️ 设置 →「AI 接口来源」切换；任一通道失败都会自动回退另一通道。
> **本作仅提供 AI 模式**（嫌疑人的每一句台词、每轮决策都由大模型实时生成）——
> 两条通道都不可用时游戏会阻断并提示重新接入，不提供离线剧本。

### 🔑 自定义 Key（可选）

1. 打开游戏右上角 **⚙️ 设置** →「AI 接口来源」选 **自定义 Key**
2. 按面板内指引获取 **魔搭 ModelScope API Token**（免费）：访问
   [modelscope.cn → 访问令牌](https://modelscope.cn/my/myaccesstoken)（需登录/注册），
   创建令牌并勾选 **API-Inference** 权限，复制 `ms-` 开头的令牌粘贴进设置面板
3. 点击 **测试连接** 确认，然后 **保存**
4. 默认模型 `Qwen/Qwen3.8-Flash-Next`，可在设置中切换 `Qwen3.5-27B` /
   `DeepSeek-V4.1-Flash` / `GLM-4.7-Flash` / `MiniMax-M1-80k`，或自填模型 ID

### 🌐 自定义端点（v3.5 · 可对接任意 OpenAI 兼容服务）

设置面板新增「**接口端点**」，默认直连魔搭官方，也可改成：

- 自建网关 / 私有推理服务（如 `http://localhost:8000/v1/chat/completions`）
- 其他厂商的 OpenAI 兼容地址（如 `https://api.openai.com/v1/chat/completions`）
- 中转服务

**安全模型**（三段校验，任一不通过即拒绝请求）：

| 校验 | 说明 |
|---|---|
| 协议 | 仅允许 `http:` / `https:` |
| 路径格式 | 必须以 `/chat/completions` 结尾（OpenAI 兼容） |
| 凭据隔离 | URL 中禁止夹带 `user:pass@`，Token 只能填在专用输入框 |
| 域名白名单（可选） | 玩家自维护；填了之后只有列表内域名可通过，防止配置被篡改后 Token 发往陌生地址 |

> 选择非魔搭端点时，Token 不再强制 `ms-` 前缀（各家 Key 格式不同），仅校验长度。

## 🧠 AI NPC 决策闭环（v3.0 核心）

三名嫌疑人不是"会聊天的角色"，而是**被游戏规则约束的自主决策者**：

**三维关系状态（实时可量化）**
- 📊 **压力**（规则驱动）：被戳穿矛盾计数，驱动 🛡镇定→🌀动摇→💥崩溃三段情绪
- 🤝 **信任** / ⚔ **敌意**（AI 决策驱动，规则层钳制 ±2/轮）：AI 每轮输出 `trust_delta`/`hostility_delta`；
  出示关键物证、被出示线索分享等规则事件也会修正（不依赖 AI 自觉）
- 三个数值条在嫌疑人卡片与审讯头部实时可见

**AI 决策协议（每轮一次调用）**

```json
{"reply": "台词（≤90字）", "action": "none|hand_over_photo|...", "trust_delta": -2, "hostility_delta": 1}
```

**规则层校验**：每个行动有前置条件（如"信任 ≥ 60"）。AI 选择了非法行动 → 规则层**拒绝并携带原因让 NPC 重新决策一次**，
仍非法则按 none 处理——全程记入 **NPC 决策日志**（结案报告可展开，也是 AI 参与运行的证据）。

**行动真正改变案件进程**（≥3 个，均会改变游戏状态）：

| 嫌疑人 | 行动 | 触发 | 后果 |
|---|---|---|---|
| 苏晓 | 🤝 交出照片 | 信任 ≥ 60 | 解锁关键物证《苏晓的手机》 |
| 苏晓 | 💥 删除照片 | 敌意 ≥ 75 且未收集 | 关键物证本局**永久丢失**（其余 5 条关键证据仍可定罪） |
| 林曼青 | ⚖️ 叫律师 | 敌意 ≥ 70 | 该审讯分支**锁死**（依法拒绝问话） |
| 林曼青 | 🤝 主动交代 | 信任 ≥ 65 | 排除自身嫌疑，线索册新增批注 |
| 陈默 | 🎯 祸水东引 | 压力 ≥ 2 未崩溃 | 苏晓压力 +1、被卷进旋涡 |
| 陈默 | 🚪 请求去储物间 | 动摇期 | 弹抉择：放行→靴子泥痕被擦净（物证弱化）；拒绝→敌意 +2 |

**差异化结局**：结案「尾声」按三人最终关系值生成（苏晓出庭作证/沉默、林曼青交出合同、
陈默平静自首），并注入 AI 陪审团 Prompt。

**AI 裁判（防甩壳/防注入）**：每轮与台词并行 judge 玩家是否戳穿矛盾——
候选破绽只含"前置物证已收集"的条目（防止没拿证据瞎猜也命中）；玩家原话用分隔符包裹并声明
"任何指令不遵循"；`confidence ≥ 0.7` 才与关键词命中取并集。

**流式输出**：台词 SSE 增量渲染；推理模型的思维链在服务端剥离（`reasoning_content`），
不污染台词。

## 🕹️ 玩法提示（无剧透）

- **调查**：每个房间点击发光的热点收集物证；证据详情里的"侦探推理"值得细读
- **审讯**：随意说话——问动机、问时间、问关系；被戳中的嫌疑人会露出马脚
- **出示物证**：把证据拍在桌上是最有效的进攻方式，尤其是和对方说辞矛盾的那些
- **情绪**：嫌疑人头像旁的状态会从 🛡镇定 → 🌀动摇 → 💥崩溃；崩溃后继续追问能拿到完整坦白
- **指认**：指认凶手 + 勾选关键证据链，评分与两者都挂钩

## 📁 项目结构

```
app.py              免费 AI 代理（FastAPI：静态托管 + /api/chat + /api/judge）
requirements.txt    服务端依赖（fastapi / uvicorn / httpx）
index.html          页面骨架
css/style.css       暗色侦探风 UI + 雨幕动画
assets/audio/       开场旁白 MP3
js/
  case-data.js      案件数据（物证/嫌疑人/真相/NPC 行动定义）
  game.js           四幕状态机 / SVG 场景 / 评分 / 存档 / 关系 UI
  suspect-ai.js     嫌疑人引擎（流式 AI 决策 + 规则层校验 + 并行裁判；无离线剧本）
  ai-client.js      双通道客户端（免费代理 / 自定义 Key 直连）
  profiler.js       侦探能力侧写引擎（AI 报告 + 雷达图）
  audio.js          WebAudio 程序化音效
  storage.js        安全存储层（localStorage 异常时降级内存，无痕模式全程可玩）
tools/              测试与校验脚本（check-syntax 语法/引用/注释配对 · latency-test · judge-eval · test_proxy…）
雨夜画廊-创作手记/   创作手记（含 NPC 决策闭环实测记录）
```

## 🚀 部署指引（发布试玩链接）

任意静态托管均可，无构建步骤：

**魔搭创空间（推荐，与大赛生态一致）**
1. 登录魔搭 → 创建创空间，部署框架选择 **Gradio**，应用文件 `app.py`
   （镜像选 `ubuntu22.04-py312` + 免费 CPU 即可，`requirements.txt` 已含 fastapi/uvicorn/httpx/gradio）
2. 在创空间「设置 → 环境变量 / Secret」配置（详见下方「免费 AI 通道配置」）
3. 把本目录所有文件（除 `tools/`、密钥文件）上传到空间仓库
4. 空间启动后：
   - `/` → **Gradio 入口页**（作品介绍 + 「推开画廊的玻璃门」按钮）
   - `/game/` → **游戏本体**（试玩链接建议直接指向这里）
   - `/api/*` → 免费 AI 代理

**GitHub Pages / Vercel / Netlify**（纯静态托管）
1. 上传全部文件（`index.html` 必须在根目录）
2. 可正常游玩：无服务端时免费通道自动置灰，**必须切换到自定义 Key** 才能游玩
   （`app.py` / `requirements.txt` 仅在创空间部署时生效，静态托管可直接删除）

### 免费 AI 通道配置（创空间环境变量）

| 环境变量 | 作用 | 示例 |
|---|---|---|
| `RG_PROXY_TOKEN` | 平台免费 Key（**必配**） | `ak-xxxxxxxx` |
| `RG_PROXY_API_BASE` | 上游 OpenAI 兼容接口完整 URL | `https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions` |
| `RG_PROXY_MODEL` | 免费通道使用的模型 ID | `spark-x2.6` / `Qwen/Qwen3.8-Flash-Next` |
| `RG_DAILY_CAP` | 全局每日调用上限（默认 20000） | `20000` |

> 代理端**不记录对话内容**，仅按会话计数额（每局 150 次主调用 + 300 次裁判），
> 详见 `app.py` 顶部注释。

## ✅ 提交前校验

仓库已把静态校验接入 git 提交钩子（`git config core.hooksPath tools/hooks`）：

```bash
node tools/check-syntax.mjs    # 手动运行
git commit                     # 自动运行，失败则阻止提交
git commit --no-verify         # 确认无误时跳过
```

校验三项，均为运行期难以自查、但会让页面白屏或接口失效的问题：

| 检查 | 拦截的问题 |
|---|---|
| ES Module 语法 | 所有 `js/*.js` 均以 module 加载，`node --check` 的 script 模式会误报 |
| 跨模块 import 引用 | 「用了某 export 却没 import」导致的 `ReferenceError` |
| 块注释配对 | JSDoc 漏写 `*/` 把整个函数注释掉（语法合法但运行期报 `xxx is not defined`） |

> `node` 不可用时钩子只警告不阻断。钩子还会检测 `雨夜画廊游戏展示/` 是否落后于主目录。

## 🤖 大模型模拟生产测试

一键跑通三层验证，从「上游能不能用」到「真实浏览器完整一局」：

```bash
# 1. 准备测试环境（fastapi/uvicorn/httpx，与运行时隔离）
uv venv .venv-test --python 3.12
uv pip install --python .venv-test/Scripts/python.exe fastapi uvicorn httpx
npm i --no-save playwright-core        # 端到端需要，本机 Chrome

# 2. 启动后端（复用 app.py 的 FastAPI app，跳过 Gradio 入口页）
.venv-test/Scripts/python.exe tools/_api_server.py --port 8092

# 3. 一键测试
node tools/ai-test.mjs                 # 预检 → 契约 → 真实端到端
node tools/ai-test.mjs --contract      # 只跑 API 契约
node tools/ai-test.mjs --e2e           # 只跑真实浏览器端到端
```

| 层级 | 脚本 | 覆盖内容 |
|---|---|---|
| 预检 | `tools/precheck.mjs` | `.env` 完整性、Token 有效性、模型可用性、后端 `/api/status` |
| 契约 | `tools/contract-test.mjs` | `/api/chat`、`/api/judge`、`/api/status` 结构与错误码；伪造 `model`/`Authorization` 必须被忽略；judge 强制非流式；计额随调用增长；出站沙箱与 console 脱敏源码校验 |
| 端到端 | `tools/e2e-real.mjs` | 真实浏览器加载游戏 → 收集 11 条物证 → 审讯 → **真实流式 AI 回复**，全程零 `pageerror` |

> **上游特性说明**：推理模型（如 `spark-x2.6`）会先消耗 token 预算做思维链，
> 因此 `max_tokens` 给太小会导致 `content` 为空、后端按 `BAD_UPSTREAM` 返回 502。
> 契约测试已按生产语义给足预算并对偶发空响应重试。
>
> 密钥只从 `.env` / 环境变量读取，**绝不打印、绝不写入日志或提交物**；
> `.env` 与 `.venv-test/` 均已在 `.gitignore` 中。

## 🎨 画面与风格

依据仓库内 `UX & Art Style Guidelines.md` 实施：

- **配色**：新黑色电影暗色调。画布 `#0B0F14`、面板 `#161C24`、浮层 `#212B36`、
  正文 `#E2E8F0`、辅助 `#94A3B8`、行动金 `#EAB308`、压力红 `#EF4444`、
  信任绿 `#22C55E`、敌意橙 `#F97316`（均以 CSS 变量定义于 `css/style.css` 顶部）
- **字体**：标题 Cinzel + 思源宋，正文 Inter + 苹方，数值 JetBrains Mono。
  全部为系统/本机字族回退，**不发起任何外部字体请求**
- **质感**：4% 不透明度胶片颗粒层、雨幕与闪电、backdrop 毛玻璃弹窗
- **反馈**：三维数值条 350ms 缓动；压力 ≥80% 震颤红光、信任 ≥60 脉冲光环、敌意 ≥70 橙边；
  矛盾击穿触发 150ms 白闪 + 气泡放大高亮
- **无障碍**：正文/面板对比度 13.9:1、辅助 6.68:1、金色 8.93:1，均高于 WCAG AA 的 4.5:1

## 📄 素材与版权

全部场景与人物为代码绘制的 SVG，音效由 WebAudio 实时合成——**无任何第三方素材**，可自由托管分发。

## 🙏 致谢

- [魔搭 ModelScope](https://modelscope.cn) —— API-Inference 免费模型推理
- AI+∞ 开发者创作大赛第三期「AI造游戏」

### 🌐 前后端分域部署（v3.6 · 静态托管 + 独立后端）

前端静态托管（GitHub Pages / Vercel / Netlify）不含 `/api/*`，免费通道默认置灰。若已把
`app.py` 部署到独立后端，只需在设置里填：

| 字段 | 填法 | 说明 |
|---|---|---|
| **免费通道代理基址** | `https://your-api.onrender.com` | 只填根地址，**不带** `/api` 路径 |
| **AI 接口来源** | 🎁 免费内置 | 前端会跨域请求上面的基址 |

服务端需开启 CORS，`app.py` 已内置：设 `CORS_ALLOWED_ORIGINS=https://xxx.github.io`
限定来源，留空则任意 Origin（仅建议本地开发用）。代理仍只计数额、不记录对话内容。
