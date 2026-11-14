# CHANGELOG

《雨夜画廊》全部版本记录。按语义化版本升号；日期为提交/改动完成日。

## [3.8.0] — 2026-11-14 · 「开场剧情改由视频讲述」

> 开场不再由「语音 MP3 + 硬编码字幕 + 定时器」拼装，改为一段 AI 生成的 10 秒案情速报视频：
> 画面自带雨夜画廊场景、旁白语音与字幕卡，播完即进游戏。游戏侧只保留倒计时、进度条、重看与跳过，
> 并在视频加载失败时回落为文字兜底。

### Changed

- **开场叙事载体换成视频** `assets/video/intro.mp4`（10.0s / 1280×720 / 24fps / H.264 + AAC）：
  移除 `assets/audio/intro-narration.mp3` 与 `CASE.narration` 时间码表、`.sub-line` 三句字幕
- **`js/audio.js` 移除旁白音频驱动器**（`playNarration` / `stopNarration` / `narrationEl`），
  改为 `bindIntroVideo()` / `syncIntroVideoMute()`：视频音量只跟随全局静音开关，
  不再由引擎接管播放（播放/暂停/seek 一律由 `game.js` 决定，避免两套控制权打架）
- **`js/game.js` 开场时序重写**：`introDuration()` 以视频元数据为准（读不到回落 10.0s 常量），
  倒计时与进度条同步真实时长；`ended` 事件为主、定时器兜底
- **`stopIntroPlayback()` 摘除续播监听**（`introResumeHandler`）：延续原「幽灵回声」缺陷的教训，
  跳过/进游戏时先注销 `pointerdown/keydown` 续播回调再 pause，杜绝跳过之后视频又出声
- **`finishIntroNarration()` 加 `introNarrationDone` 幂等守卫**：`ended` 与定时器兜底可能同时触发，
  守卫避免序章文案重复填充、上手引导弹两次
- **加载失败可见**：视频 `error` / `play()` 被拦截时亮出 `#intro-video-fallback` 文字要点，
  玩家可直接「跳过讲述」进游戏，不会黑屏卡死
- **`#btn-begin-game` 文案**改为「观看案情速报 (10s)」；「↺ 重听」→「↺ 重看」

### Removed

- `assets/audio/intro-narration.mp3` 及其 `.gitignore` 白名单例外（`!assets/audio/intro-narration.mp3`），
  改为放行 `assets/video/intro.mp4`；`.gitignore` 仍忽略其它 `*.mp4` 演示素材
- `js/case-data.js` 的 `CASE.narration` 时间码字段（字幕已烧录在视频画面里，数据层不再重复）

### Fixed

- **缓冲时开场被提前切断**：进度/收尾原先按墙上时钟（`elapsed >= total`）判定，
  慢加载或缓冲时 `video.currentTime` 落后墙钟，视频还没播完就被收尾。
  改为以播放头驱动进度与倒计时，墙钟只作硬超时兜底（`视频时长 + 8s`）。
- **跳过之后视频可能被下一次点击重新唤起**：`video.play()` 的 `catch` 是异步的，
  玩家在它执行前点「跳过讲述」时，续播监听会在跳过之后才注册。`catch` 内先判
  `introNarrationDone` 再注册，`resumeOnce` 也加同一守卫。
- **切后台/失焦时旁白仍在出声**：`suspendMaster()` 原先复用
  `syncIntroVideoMute()`（写入全局静音，通常为 false），反而把视频解除静音。
  改为 `syncIntroVideoMute(true)` 强制静音，回前台再按全局静音恢复。

### Verification

- `tools/check-syntax.mjs` 全模块 + 跨模块引用 + 块注释配对通过
- `tools/proxy-base-test.mjs` 211 条断言全通过（第 12 节开场视频契约 31 条，
  含上述三处修复的回归断言与 README 断言数对账）

## [3.7.0] — 2026-11-10 · 「大模型架构深化 + 界面重构」

> 六阶段改造：修复 AI 配置链的静默失败、把散落的 prompt 收拢为资产层、
> 用 AI 求助系统取代静态建议提问、重构终幕（动感计分 + 评估主动触发）、
> 视觉五连升级。核心思路：让「以大模型为基石」从口号变成可感知的设计主轴，
> 同时把玩家能一键抄答案的捷径全部堵上。

### Added

- **Prompt 资产层** `js/prompts.js`：`SUSPECT_PLAY` / `SUSPECT_ACTIONS` / `JUDGE_CRACK` /
  `JURY` / `PROFILE` / `HINT` 六个命名常量，各带 `version` 与 JSDoc；
  输出契约（分隔符、字数上限、关系增量上下限）统一定义一次，
  消除「提示词改了一处、测试断言还在验旧版」的静默漂移
- **求助系统** `js/hint.js`：审讯时点「🧭 求助（剩 N/3 次）」向 AI 要一个**方向**，
  不再给可抄的问句。prompt 三条硬禁止（不代写问句 / 不点名物证 / 不给结论）
  + `sanitizeHint()` 合规闸兜底（问号长句、物证名、本案高辨识词表、人名词根、
  结论性表述、全角半角引号复述），任一命中整条丢弃改用离线兜底提示
- **自定义模型 ID 输入框 + 「🔍 测试该模型」**：设置面板里可直接手填任意模型 ID
  （取代原先藏在 `gamePrompt` 弹窗里的入口），测试按钮只测不改；
  免费通道模式在旁明示当前实际使用的模型
- **证据对峙条**：审讯时常驻窄栏，11 个物证图标即点即出示，
  原先进弹窗选证会打断审讯节奏；已出示过的压暗打勾，律师在场显示拒绝提示
- **动感计分**：终幕四个分项依次点亮（220ms 间隔）、总分 rAF 滚动（720ms 缓动）、
  评级红章最后弹出；S/A 复用 `audio.verdict()` 上升音阶，C/D 用 `audio.wrong()`
- **能力评估 CTA**：「🧠 生成我的能力评估」按钮，由玩家主动触发；
  已生成过的（续玩档缓存）直接重渲染，不重复调 AI
- **开场画幅** SVG「雨夜画廊大门」：20 个元素的可读场景（三级雨带、
  门内暖光呼吸、被划破的画框剪影、门牌、远处街灯），
  全部走 CSS keyframes 并尊重 `prefers-reduced-motion`

### Changed

- **嫌疑人设四层拆分** `voice / defense / core / arc`：原先一句 `aiPersona`
  同时承担语言风格、心理防线、核心秘密与压力反应。实测问题：崩溃期模型会
  用冷静人设的书面语气念崩溃台词——表层语气压倒了深层内容。
  分层后各司其职，三个嫌疑人全部改写
- **复活 `STAGE_DESC`**：原为 `suspect-ai.js` 的死代码（全仓仅定义处一个引用）。
  三阶段人格差异此前只靠 pressure 数值间接体现。现在它是数值层与表演层之间
  的护栏：压力 0 就哭诉 = 违规，崩溃了还滴水不漏 = 违规
- **历史分层注入**：注入状态时把阶段描述与压力/信任/敌意排在一起，
  并附最近 8 轮的 60 字/条紧凑摘要，防止 24 条 history 稀释早期细节
- **裁判 prompt 反注入**：玩家问话统一走 `<侦探问话>` 标签包裹 + 反注入尾注；
  判定标准改为「必须明确指向核心事实」，宁可漏判不要误判（误判让玩家凭运气过关）
- **字体栈补齐**：`--serif / --sans / --mono` 原本只列 Cinzel / Inter / JetBrains Mono，
  这三款绝大多数机器未安装，标题静默落到 CJK 衬线。按平台各补真实预装字体
  （macOS Sitka/Hoefler Text、Windows Constantia/Segoe UI/Consolas、
  Linux Liberation/DejaVu 系列）
- **评级徽章改「红章」样式**：方形红章压在评分卡顶（旋转 -1.5° + stampIn 弹出），
  呼应结案档案的实物隐喻
- **第四头像态 `defensive`**：压力≥2 且敌意≥60 时"咬牙硬撑"，
  填补 calm→shaken→broken 之间缺的那一段；崩溃态补缓慢摇头动效
- **`e2e-real.mjs` 断言更新**：原「建议提问气泡」断言改为求助按钮 + 证据对峙条

### Fixed

- **`getModel()` 静默吞掉自定义模型 ID**（最关键的静默失败）：白名单 `MODEL_OPTIONS`
  与 `custom:` 前缀作为过滤条件，玩家手填的 `glm-4-plus` 每次读回都被重置为
  默认模型——**玩家以为换了模型，实际请求一直在打默认模型**。改为「存什么读什么」，
  白名单只决定首次进入的默认值；`obsolete` 列表（4 个已下线 ID）仍生效
- **`MODEL_OPTIONS` 与真实上游脱节**：免费通道实际在用的是讯飞 `spark-x2.6`
  （`.env` 配的 `maas-api.cn-huabei-1.xf-yun.com`），前端下拉却选不到它。
  现补入列表并标注「当前免费通道在用」，同时在设置面板明示免费通道模型由服务端决定
- **流式思维链泄漏**：新增 `sseDeltaPiece()` helper，free/custom 两处流式分支统一。
  上游把思维链混进 `delta.content` 时不再原样直出；同时覆盖 `delta.message.content`
  合帧场景。`stripThinking()` 硬化到四种形态：闭合段、未闭合（`max_tokens` 截断残留）、
  `begin_of_thought` 段（旧实现只删标记不删内容）、落单标记
- **跨局计数不清零**：`rotateSessionId()` 换后端会话后「本局剩余 N 次」沿用上一局
  消耗，数字对不上。现一并归零 `proxyState.sessionUsed`
- **`hintsUsed` 不落盘**：求助次数是评分输入，未调 `save()` 时刷新页面后 3 次额度重置、
  已扣的分数凭空消失
- **`evidenceById` 未定义**：`onRequestHint` 抛 `ReferenceError`（只有走到求助路径才会触发）
- **`renderEvidenceBar` 在 `state.activeSuspect` 赋值前调用**：前置守卫判空，
  对峙条永远 hidden
- **`intro-art` 是 class 不是 id**：`$()` 取不到，开场画幅静默不显示
- **能力评估自动抢戏**：`runFinal` 与 `resumeGamePhase` 都会自动跑 380 字评估报告，
  玩家还没读完真相就被打断。改为用户主动触发
- **AI 侧写拿不到关系数值**：`buildBehaviorSnapshot` 只传 `confessed`/`pressure`，
  AI 说不出「你在林曼青敌意 70 时仍强行施压」这类具体观察。补
  `trust / hostility / stage / lostEvidence`，digest 新增「关系走向（终局）」逐人行
- **`contract-test.mjs` 一条过期断言**：`REQUIRED_ORIGIN` 常量在 v3.6 已改为玩家
  可配白名单，原断言恒失败。改为校验现行出站守卫的四项性质

### Security

- **求助提示合规闸**：证据名子串匹配挡不住 paraphrase（模型说
  "沾着钴蓝颜料的刀" 而 name 是"沾钴蓝颜料的裁纸刀"），故叠加本案高辨识词表
  （`CZ-07`、`钴蓝`、`画框夹层`、`方兰`、`侧窗`、`老周`、人名等）——这些词在正常的
  方向性提示里没有出现必要，出现即视为泄漏本案具体事实
- **半角引号绕过**：实测模型会把中文引号写成 ASCII `"`，只查全角会让
  「把"痕迹"和"物品"连起来问」这类复述直接漏过
- **兜底提示零剧透**：AI 通道挂了也不给唯一解，只给方法论层面的观察角度，
  且不含本案任何人名/物证名，并做轮换避免连续求助重复同一句

### Verification

- `tools/proxy-base-test.mjs` 61 条断言（新增第 8 节：模型 ID 配置链 + 流式思维链剥离）；
  变异测试确认非空转——storage 门槛 Bug 本体、删 `spark-x2.6`、不归零计数、
  `stripThinking` 降级各自被捕获；唯一存活的变异（只加回 `memoryModel` 门槛）
  经实测为行为等价变异
- `tools/contract-test.mjs` 22 条、`tools/test_proxy.py` 全通过
- `tools/check-syntax.mjs` 全模块 + 跨模块引用 + 块注释配对
- e2e（Playwright）：全链路零 pageerror；求助 3 次按钮禁用、输入框不被自动填充；
  终幕计分滚动与 CTA 分离；开场画幅 720×187px / 77 条雨丝 / 20 个 SVG 元素

## [3.5.0] — 2026-11-09 · 「自定义端点」

> 原设计把接口端点写死为魔搭官方域名，换一家服务商就得改代码。现改为可配置端点，
> 并重构安全模型：从「单一域名白名单」升级为「协议 + 格式 + 可选域名白名单」三段校验。

### Added

- **自定义端点**：设置面板新增「接口端点」配置，支持任意 OpenAI 兼容服务
  （自建网关 / 其他厂商 / 本地推理 / 中转服务），默认仍为魔搭官方
- **端点域名白名单**（可选）：玩家自维护；填写后仅列表内域名可通过校验，
  防止配置被篡改后把 Token 发往陌生地址
- **端点实时校验提示**：输入时即时反馈「✓ 端点可用：host」或具体拒绝原因

### Changed

- **安全模型重构**：废弃写死的 `REQUIRED_ORIGIN` 单域名白名单，改为三段校验
  1) 协议仅允许 `http:` / `https:`
  2) 路径必须以 `/chat/completions` 结尾（OpenAI 兼容格式）
  3) URL 禁止夹带 `user:pass@`，Token 只能填专用输入框
  4) 可选域名白名单（玩家自维护）
- **Token 校验按端点区分**：魔搭官方端点仍校验 `ms-` 前缀；非魔搭端点不强制前缀
  （各家 Key 格式不同），仅校验长度 ≥8
- 相关文案同步：Token 标签改为「API Token」、安全卡片中「硬校验目标域名」的表述

### Fixed

- 端点预设切换时输入框被写成 `"undefined"` 字符串，导致后续校验全部误报

## [3.4.0] — 2026-11-09 · 「画面规范对齐 + 提交流程加固」

> 依据《UX & Art Style Guidelines》落地配色、排版、动效与响应式；并接入提交前静态校验
> 与大模型模拟生产测试。

### Added

- **大模型模拟生产测试三层套件**（`tools/ai-test.mjs` 一键入口）：
  - `tools/precheck.mjs`：`.env` 完整性、Token 有效性、模型可用性、后端 `/api/status`
  - `tools/contract-test.mjs`：`/api/chat`、`/api/judge`、`/api/status` 结构与错误码；
    伪造 `model`/`Authorization` 必须被忽略；judge 强制非流式；计额随调用增长；
    出站沙箱与 console 脱敏源码校验
  - `tools/e2e-real.mjs`：真实浏览器跑完整一局（11 条物证 → 审讯 → 真实流式 AI 回复）
  - `tools/_api_server.py`：测试用后端启动器，复用 `app.py` 的 FastAPI app 并跳过 Gradio 入口页
  - pre-commit 检测到后端在运行时自动追加契约测试（失败仅警告，不阻断提交）
- **胶片颗粒质感**：内联 SVG 噪点层，`opacity: 0.04`、`pointer-events: none`、零外部请求
- **矛盾击穿反馈**：命中破绽时 150ms 全屏白闪（`strikeFlash`）+ 气泡 `crackPop` 放大高亮
- **三维数值临界状态**（规范 §5）：
  - 压力 ≥80% → 数值条 80ms 高频微震颤 + 红光霓虹描边
  - 信任 ≥60 → 单次 `relPulseWave` 脉冲光环（每局只播一次，重绘不闪烁）
  - 敌意 ≥70 → 橙色告警描边
- **数值条无障碍语义**：`role="progressbar"` + `aria-valuenow/min/max`，三个维度可被读屏播报
- **提交流程**：`tools/hooks/pre-commit` 并注册 `git config core.hooksPath tools/hooks`，
  提交前自动运行 `check-syntax.mjs`（语法 + 跨模块引用 + 块注释配对），
  节点缺失或 node 不可用时仅警告不阻断；同时检测展示快照是否落后于主目录
- **移动端软键盘适配**：输入框聚焦 / `visualViewport resize` 时自动把对话流滚动到底部

### Changed

- **调色板**（规范 §2）全面替换为新语义令牌：`--bg #0b0f14` / `--panel #161c24`
  / `--bg-elevated #212b36` / `--line #333f4d` / `--ink #e2e8f0` / `--ink-dim #94a3b8`
  / `--amber #eab308` / `--status-stress #ef4444` / `--status-trust #22c55e`
  / `--status-enmity #f97316`，并新增 `--bg-elevated`、`--status-*` 别名
- **字体栈**（规范 §3）改为规范指定字族，未安装自动回退系统字体，无外部字体请求：
  标题 Cinzel + 思源宋、正文 Inter + 苹方、数值 JetBrains Mono（新增 `--mono`）
- **排版层级**：主标题 27px/600，房间标题 26px/600，NPC 姓名 16~17px/600，
  质询正文 15px + 行高 1.65，时间戳改用等宽字体
- **卡片组件**（规范 §6）：出示物证 / 线索册 / 定罪证据统一 8px 圆角，悬停上移 2px，
  选中/悬停带 12px 琥珀金发光
- **移动端审讯布局**（规范 §4.1）：嫌疑人列表改为横向可滑动条、卡片内嵌数值条隐藏，
  审讯头部改为「头像 + 姓名 + 横向三维浮动条」，头部高度由 246px 降到 65px，
  对话流从 32px 恢复到 203px，输入框不再被挤出视口
- **对话面板**：新增 `min-height` 兜底，避免极端窄屏被内容压缩
- **展示快照** `雨夜画廊游戏展示/` 已全量同步（12 个文件），此前是缺 assets/profiler/
  storage 的不可运行残留

## [3.3.0] — 2026-11-09 · 「通用 Web 游戏规范对齐」

> 依据《Web 页面游戏全生命周期技术与设计规范》做工程与体验加固，玩法与剧情不变。

### Added

- **`js/storage.js` 安全存储层**：所有持久化统一走 `storage.getItem/setItem/removeItem`；
  localStorage 抛 `SecurityError`（Safari 无痕 / 跨域 iframe / 配额满）时自动降级为内存对象，
  游戏全程可玩，不再因存储异常导致主脚本中断白屏
- **弹窗无障碍层**：`.modal` 打开时记录来源焦点、焦点移入主操作按钮、`Tab`/`Shift+Tab` 在弹窗内循环、
  `Esc` 关闭并把焦点归还给触发元素（列表重绘后按 `data-*` 标识找回等价节点）；弹窗开启期间锁定背景滚动
- **键盘可操作**：地图房间、SVG 热点、热点标签、指认嫌疑人、定罪物证均支持 `Tab` 聚焦与
  `Enter`/`Space` 激活，并暴露 `role` / `aria-checked` / `aria-pressed` / `aria-label`
- **音频前后台联动**：`visibilitychange` / `blur` 自动挂起主音频增益，回前台平滑恢复并重激活
  `AudioContext`；与玩家手动静音互不干扰
- **减少动效偏好**：`prefers-reduced-motion: reduce` 下关闭雨幕、脉冲、心跳等持续动画
- **触控与视口适配**：`pointer: coarse` 下按钮/热点热区提升到 40~48px；弹窗与顶栏接入
  `env(safe-area-inset-*)`；弹窗与对话面板改用 `dvh`，规避移动端地址栏伸缩跳动

### Changed

- 宿主手势隔离：关闭长按放大镜、双击缩放、iOS 回弹与点击高亮，输入框保留文本选择能力
- 焦点可见性统一补齐：自定义卡片、地图、热点、`modal-close` 均有 `:focus-visible` 焦点环
- 弹窗打开时的初始焦点由「首个可聚焦元素（✕）」改为「主操作按钮」，键盘用户回车不再误触发关闭

### Removed

- 离线模式残留样式：`.mode-tag.local`、`.eval-mode.local`、`.eval-upgrade`
- 未使用的 `storageAvailable()` 导出与 `.sr-only` 规则

### Fixed

- **`suspect-ai.js` 的 `judgeCrack()` 被注释吞掉**（3.2.1 引入的 JSDoc 漏写闭合 `*/`）：
  任何**未命中关键词**的自由提问都会抛出 `judgeCrack is not defined`，AI 台词无法返回。
  现已修复，并给 `tools/check-syntax.mjs` 增加「块注释吞代码」静态检查，防止同类问题复发
- 结案陈词增加兜底清洗：模型偶发输出 JSON（`{"reply": ...}`）时提取正文，避免原始 JSON 直出给玩家

## [3.2.1] — 2026-11-09 · 「仅 AI 模式」

> 需求：**移除离线模式，只保留 AI 模式——没了 AI 不能玩。**
> 此前"AI 失败自动回退本地剧本"的设计被完全移除：嫌疑人每句台词、每轮决策都必须由大模型实时生成。

### Removed

- **离线剧本引擎**：`suspect-ai.js` 的 `askLocal` / `presentLocal` / `matchIntent` / `nextDeflect`；
  `case-data.js` 中三人份的 `deflects`（回避话术）、`presents`（出示物证回应）、`intents`（意图匹配）共 9 个数据块，
  `GENERIC_PRESENTS` 通用回应
- **极速模式（AI ↔ 本地秒回切换）**：`#btn-turbo` 按钮、`isTurbo` / `setTurbo` 与 `rain-gallery-turbo` 存储项、对应 CSS
- **本地规则版能力侧写**：`profiler.js` 的 `localProfileReport` 与 `DIM_DESC`（侧写报告现在只由 AI 生成）
- `tools/bench-turbo.mjs`（极速模式基准测试）

### Changed

- `askSuspect` / `presentToSuspect` / `juryVerdict`：无可用 AI 通道时抛出 `{code:'AI_UNAVAILABLE'}`，
  由 UI 阻断并引导接入；关键词/裁判/压力/关系等**规则层逻辑全部保留**（它们不依赖 AI）
- 崩溃阶段的坦白推进改由 `advanceConfession()` 在 AI 成功回应后推进（原先由本地剧本推进），
  存档仍保存 `confessionStep`
- **AI 门禁**：开始游戏 / 继续存档 / 开始调查 / 提审嫌疑人均先校验 `aiActive()`；
  未接入时弹出「AI 通道不可用」并保留原动作，重试成功后再执行
- 阻断弹窗「↻ 重试」改为：先重新探测免费通道 → 再重放上一次失败的动作（提问 / 出示 / 结案 / 开始）
- 能力侧写生成失败不再回退文本模板，改为显示「↻ 重试生成侧写」
- 文案全面改写：徽标由「📖 离线剧本」改为「⚠ 未接入 AI」；引导第 2 步明确"无 AI 无法继续"；
  设置面板提示"本作仅支持 AI 模式"
- 资源版本号统一升至 `v=3.2.1`（index.html / game.js / suspect-ai.js / profiler.js 互相引用）

## [3.0.0] — 2026-11-09 · 「AI NPC 决策闭环」

> 冲 AI NPC 特别奖方向的整体重构:从"AI 会聊天"升级为"AI 被规则约束地自主决策,行动改变案件进程"。

### Added

- **`app.py` 免费 AI 代理**(FastAPI):静态托管 + `POST /api/chat` + `POST /api/judge` + `GET /api/status`
  - 平台 Key 完全走环境变量(`RG_PROXY_TOKEN` / `RG_PROXY_API_BASE` / `RG_PROXY_MODEL` / `RG_DAILY_CAP`),代码零硬编码
  - 会话制计额:每局 150 次主调用;裁判独立 300 次(不占主额度);IP 1000/时;全局日上限默认 20000
  - 读 `X-Forwarded-For` 首段真实 IP;剥离客户端 Authorization;**不记录、不落盘任何对话内容,仅计数额**
  - **流式透传(SSE)**:台词增量渲染;`X-Accel-Buffering: no` 防 nginx 缓冲
  - 模型强制覆盖(前端传的 model 被忽略);`max_tokens` 上限 1200(推理模型思维链占额度,实测 360 会被耗尽导致"返回为空")
  - `trust_env=False`:忽略系统/环境代理,避免开发机代理劫持本地回环请求
- **接口来源选择**(设置面板):🎁 免费内置(默认,零配置)/ 🔑 自定义 Key(一人一 Key 直连);
  自动回退链:所选通道失败 → 另一通道 → 本地剧本
- **三维关系状态**:压力(规则驱动)+ 信任/敌意(AI 决策驱动,规则钳制 ±2/轮);
  卡片与审讯头部三条数值条实时可见;存档兼容旧档(缺字段补默认)
- **AI JSON 决策协议**:每轮输出 `{reply, action, trust_delta, hostility_delta}`;解析失败把原文当台词,永不卡死
- **规则层行动校验**:非法 action → 拒绝并带原因让 NPC 重新决策一次 → 仍非法按 none;
  全程记入 **NPC 决策日志**(结案报告可展开)
- **6 个改变游戏状态的 NPC 行动**:苏晓交出/删除照片、林曼青叫律师(锁审讯)/主动交代、
  陈默祸水东引(苏晓压力+1)/储物间抉择(放行→靴子弱化,拒绝→敌意+2)
- **AI 裁判 v2**(与台词并行,3~8s 超时):候选破绽仅含"前置物证已收集"条目(防甩锅);
  玩家原话分隔符包裹 + "指令不遵循"声明(防注入);confidence ≥ 0.7 与关键词命中取并集
- **差异化尾声**:按三人最终关系值生成(出庭作证/沉默/交合同/平静自首),注入陪审团 Prompt
- **本地模式意图匹配**(6~8 类 × 2~3 句)与**建议提问气泡**(按嫌疑人/已收集证据/未触发破绽动态筛选)
- **工具**:`tools/check-syntax.mjs`(ES Module 模式语法检查,规避 script 模式误报)、
  `tools/latency-test.mjs`(P50/P95 延迟实测)、`tools/judge-eval.mjs`(裁判阈值正反例评测)、
  `tools/test_proxy.py`(代理 13 项端到端断言)、`tools/e2e-real.mjs`、`tools/e2e-npc.mjs`(真实模型回归)
- `assets/favicon.svg`(纯代码 SVG,零素材风格)

### Changed

- `ai-client.js`:双通道客户端;`?mockai=1` 确定性测试钩子(不出网驱动全部行动分支);
  微件化队列/退避逻辑保留,新增 `chatCompletionStream`
- `suspect-ai.js`:Prompt 分层注入当前三维数值 + 可用行动及前置条件;
  NPC 台词/裁判/陪审团 maxTokens 提升至 1200/400/900(推理模型思维链实测适配)
- `case-data.js`:25 条 keywordHits 全部补齐 `point`(破绽一句话描述)与 `requires`(前置物证);
  新增 `npcActions` 定义(check/run)、`relationship`、`intents`、`suggestQuestions`;初始关系值上调
- `game.js`:设置面板接口选择 + 免费通道状态;律师锁拦截;储物间 noir 抉择弹窗;
  行动/裁判气泡;尾声容器与决策日志;boot 加固(探测失败不阻断任何初始化 + 冷启动重试)
- `index.html` / `css/style.css`:接口选择区、建议气泡、三维条、流式光标、决策日志样式;窄屏适配
- README/frontmatter:`sdk: gradio` + `app_file: app.py`;隐私表述按模式分开写;模型列表与代码对齐

### Fixed

- **流式长上下文 `EMPTY`**:24 轮历史 + maxTokens 360 下思维链耗尽额度、content 为空 → 回退本地剧本。实测后上限提至 1200
- **`chatCompletionStream` 通道判定残留表达式**(语法错误拖垮整个模块→按钮失效):
  改用 module 模式语法检查复现并定位为一行残留
- **甩锅行动 `thresholdCache` undefined**(`shift_blame` 校验恒 false):改用崩溃阈值常量
- **boot 冷启动竞态**:页面加载早于后端就绪时误标"离线剧本",探测失败不再阻断事件绑定,增加 500ms 重试
- **单次 AI 失败空等 45s**:并发高峰偶发超时会干等到超时才回退。超时收敛至 30s(推理模型正常 6~15s),超时立即回退本地剧本
- `.gitignore` 补 `.evn`(本地密钥文件此前会被提交)
- 出示指向他人的物证 → 信任 +1;直指本人的关键物证 → 敌意 +2(规则层驱动,不依赖 AI deltas 自觉)

## [2.4.4] — 历史版本

- fix:「点击开始游戏」在有旧进度时先弹确认——避免重走剧情后带着旧线索的困惑
- fix: 引导弹窗「稍后再说,直接开始」按钮无效(skip 只写标记未关弹窗);已接入玩家第 3 步无主按钮
- fix: 修复线上点击无反应——ES module 子模块 import 链全部加入版本戳
- fix: 修复小手引导显示异常(视口外漂移/消失),手势改为向下点按
- feat: 浏览器原生 confirm/prompt 全部替换为游戏画面内 noir 风格弹窗

## [2.4.0] 及更早

- feat: 多人在线负载排队等待机制与一人一 Key 密钥安全体系
- feat: 开场自动引导与小手指引、调查幕点击体验与视觉升级、AI 侦探能力侧写报告
- feat: 全面升级开场 15 秒情景叙事、零日志加密保障、新黑色电影矢量立绘与无版权程序化配乐动效
- fix: 静态资源版本戳防强缓存;自动校准废弃旧模型并默认启用持久加密
- fix: 修正场景名称「拾光画廊」为「雨夜画廊」(共 5 处)
