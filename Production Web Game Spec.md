
# Web 页面游戏全生命周期技术与设计规范 (Production Web Game Spec)

> **版本**：v2.4 (Production & Automated QA Ready)
> **适用场景**：轻量 H5 游戏、WebGL/Canvas 互动应用、解谜交互体验、跨端网页游戏平台。
> **核心目标**：提供无歧义、高信息密度、可自动化验证的工程约束与设计基准，便于直接注入 Agent System Prompt 或作为 CI/CD 质检基线。

---

## 1. 宿主与沙箱隔离规范 (Sandbox & Environment Isolation)

### 1.1 DOM 与默认手势隔离
Web 游戏画布及挂载容器必须彻底切断浏览器的原生干扰交互（长按放大镜、选中文本、弹性回弹、右键菜单），避免污染用户操作体验：
```css
html, body, #game-container, canvas {
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  touch-action: none;
  -webkit-touch-callout: none;
  -webkit-user-select: none;
  user-select: none;
  overscroll-behavior: contain;
  outline: none;
  -webkit-tap-highlight-color: transparent;
}



### 1.2 按键陷阱防护 (Keyboard Event Trapping)

* **默认滚动阻止**：对所有游戏控制键（`ArrowUp`, `ArrowDown`, `ArrowLeft`, `ArrowRight`, `Space`, `Tab`, `Backspace` 等），在画布聚焦时必须显式调用 `e.preventDefault()`，防止外层页面滚动条或父级 iframe 产生意外滚动。
* **桌面标准键位映射**：
* 必须支持 `Escape` 或 `Space` 键唤起“暂停/恢复”。
* 触发暂停/恢复时，必须同步派发相应的平台状态与音频挂起事件。



### 1.3 无痕模式与存储安全 (Storage Fallback)

* 在 Safari 隐身模式、部分跨域 iframe 或开启强隐私限制的浏览器中，直接访问 `window.localStorage` 会抛出 `SecurityError` 导致主脚本崩溃。
* **强制封装规范**：所有数据持久化操作必须封装进 `try...catch`，并在抛出异常时自动无缝降级为内存对象（Memory Cache），确保在无痕模式下游戏全程可正常运行：

```typescript
export class SafeStorage {
  private static memoryFallback: Record<string, string> = {};

  static setItem(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      this.memoryFallback[key] = value;
    }
  }

  static getItem(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return this.memoryFallback[key] ?? null;
    }
  }
}

```

### 1.4 外部请求与资源闭环 (Zero External Requests)

* **禁止运行时外部 CDN 请求**：所有字体文件、第三方脚本库、材质图集、音效必须打包到构建产物包内，禁止在游戏运行中途拉取未经验证的公共外部 CDN，以防 CSP 拦截或离线失效。
* **外链跳转策略**：禁止在代码中直接使用 `window.open()` 或 `<a>` 标签打开外部社区、Discord 或个人主页；若有跳转需求，必须接入宿主平台提供的 SDK 专有接口（例如 `PokiSDK.openExternalLink('URL')`）进行沙箱化跳转。

---

## 2. 视口适配与多端交互 (Viewport & Adaptive Input)

### 2.1 宽高比与布局策略 (16:9 Standard)

* **基准比例**：以 **16:9**（横屏推荐基准 `1920×1080`、`1334×750`、`1031×580` 或 `836×470`；竖屏基准 `750×1334`）为核心安全视口设计逻辑画布。
* **多屏适配规则**：
* **Safe Area (核心安全区)**：所有的操作按钮、HUD、得分看板必须完全约束在 16:9 安全框内。
* **Extending Bleed (外延背景)**：背景底图与非核心视觉装饰必须向四周延展，通过“等比缩放 + 边缘裁切/填充”自适应超宽屏（如 21:9、19.5:9 全面屏）或 4:3 平板屏幕，严禁单向拉伸变形，常规情况下禁止出现单调的黑边（Letterboxing）。


* **高分屏渲染保护 (DPR Capping)**：
* 严禁无节制地直接绑定 `window.devicePixelRatio`。
* 画布倍率必须进行上限截断，通常锁定在 **2.0** 以内：`Math.min(window.devicePixelRatio || 1, 2.0)`，避免 3x/4x 视网膜屏造成移动端 GPU 功耗过高和发热掉帧。



### 2.2 触控与设备自适应

* **平板强制触控化 (Tablet Mandatory Rule)**：检测到 iPad、Android Pad 等触控平板时，**严禁显示 PC 键盘/鼠标引导**，必须自动强制启用移动端虚拟摇杆或触控 UI。
* **触控目标尺寸**：
* 按钮点击热区（Hit Area）物理尺寸不得小于 **48 × 48 px**。
* 移动端事件流统一绑定 `PointerEvents`（`pointerdown` / `pointerup`），屏蔽原生 `click` 带来的 300ms 点击延迟。


* **方向锁与引导**：单向游戏（如仅支持横屏或竖屏）在检测到反向视口时，顶层必须渲染全屏阻断性的“请旋转屏幕”动态图示引导。

---

## 3. 性能预算与显存稳定性 (Performance Budgets)

### 3.1 加载预算 (Time-to-Interactive)

| 指标 | 目标预算 (Target) | 警戒上限 (Hard Cap) | 应对机制 |
| --- | --- | --- | --- |
| **首屏包体 (Initial Download)** | $\le 3\text{ MB}$ | $5\text{ MB}$ | 核心代码 + 首关资源优先入包 |
| **首屏可交互时间 (TTI)** | $\le 2\text{ 秒}$ | $3\text{ 秒}$ | 骨架屏就绪，异步预拉取分包 |
| **总包体加载等待** | $\le 5\text{ 秒}$ | $10\text{ 秒}$ | 超过 10s 玩家流失率骤增，加微交互过渡 |

### 3.2 内存红线与 WebGL 容灾

* **内存上限 (iOS Safari 限流)**：JS Heap 与 GPU 显存总占用须稳定在 **300MB 以内**，峰值不得越过 **500MB**，避免触发 WebKit 强制 OOM 白屏刷新。
* **WebGL 上下文丢失处理 (Context Loss Recovery)**：
* 必须全局监听 `webglcontextlost` 与 `webglcontextrestored`。
* 遭遇上下文丢失时暂停主循环，释放当前显存句柄；上下文恢复后自动重建 Shader、重载材质并恢复游戏场景，杜绝无响应黑屏。


* **DrawCall 与贴图管理**：
* 移动端同屏 DrawCall 控制在 **30 ~ 80** 之间。
* 精灵图必须整合进 $2^n$（如 $1024 \times 1024$ / $2048 \times 2048$）尺寸的图集（Texture Atlas），优先采用 ASTC / KTX2 / Basis 现代自适应纹理压缩格式。



---

## 4. Web Audio 现代生命周期管理 (Web Audio Life Cycle)

### 4.1 自动播放合规 (Autoplay Compliance)

* 现代浏览器强制禁止非手势唤醒的音频流。
* **手势解锁**：首屏交互（如点击“开始游戏”或触控屏幕）的首次 `pointerdown` 事件中，必须同步执行 `AudioContext.resume()`。
* **静默挂起**：在音频上下文激活就绪前，音频系统应将播放指令静默排队或丢弃，严禁向控制台抛出未捕获的 `NotAllowedError`。

### 4.2 前后台与广告静音联动

* **切出后台监听**：基于 `visibilitychange` 与 `blur` 事件建立全自动挂起管线：
```javascript
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    AudioManager.muteMaster();
    GameEngine.pause();
  } else {
    if (!UserSettings.isManuallyMuted) AudioManager.unmuteMaster();
    if (!GameFlow.isPlayerPaused) GameEngine.resume();
  }
});

```


* **广告冲突阻断**：展示任何平台级中插或激励广告时，底层的游戏主音频通道必须被完全静音。

---

## 5. 平台状态机与流程接入标准 (SDK Lifecycle State Machine)

游戏运行流程需与平台提供的生命周期严格对齐，禁止乱序调用：

```
       [资源加载完成]
              │
              ▼
       ┌──────────────┐
       │  Title / UI  │◄────────────┐
       └──────┬───────┘             │
              │ 首次有效玩家输入     │
              ▼                     │
       ┌──────────────┐             │
       │ gameplayStart│             │
       └──────┬───────┘             │
              │                     │
       ┌──────┴─────────────────────┴┐
       │                             │
 [游戏暂停/菜单]              [关卡结算/死亡]
       │                             │
       ▼                             ▼
┌──────────────┐              ┌──────────────┐
│ gameplayStop │              │ gameplayStop │
└──────┬───────┘              └──────┬───────┘
       │                             │
       ▼                             ▼
┌──────────────┐              ┌──────────────┐
│ commercial() │              │ rewarded()   │
└──────┬───────┘              └──────┬───────┘
       │ 关闭广告                    │ 发放奖励
       └──────────────┬──────────────┘
                      ▼
               [重新开始/继续]

```

### 5.1 状态调用铁律

1. **禁止连续调用**：
* `gameplayStart()` 调用后，严禁连续二次触发 `gameplayStart()`。
* `gameplayStop()` 调用后，严禁连续二次触发 `gameplayStop()`。


2. **准确挂载点**：
* `gameplayStart` **必须在玩家产生实际游玩操作时派发**（例如点击“Play”、操纵角色起步），绝对不能在“资源 Loading 完成”时自动触发。
* `gameplayStop` 必须在一切非游玩打断点派发（打开暂停菜单、关卡结算、全屏剧情动画等）。


3. **中插广告触发节点 (Commercial Break)**：
* 仅允许在**玩家从暂停或打断状态重回游戏流程的过渡点**触发（例如：玩家点击“关闭暂停菜单并返回”）。
* 严禁在“玩家退出关卡回到主菜单”时强行插播。



---

## 6. UI/UX 简化与防流失规范 (UX & Retention Engineering)

### 6.1 零门槛进入 (Zero Barrier Onboarding)

* **两步进入操作**：摒弃“过场黑屏 -> 发行商动画 -> 制作团队 Logo -> 用户协议 -> 繁琐引导”的传统流程。玩家进入页面后，在 **2 次点击**以内必须进入第一局核心操作。
* **视觉化引导**：玩法教学优先采用动态手指划动、微动画或高亮指向，避免整屏纯文字说明。

### 6.2 激励广告与按钮规范 (Reward Design Rules)

* **视觉层级对等**：
* 凡是出现“🎬 激励视频”按钮的场景，必须**同时并列**提供尺寸同等或更大的常规继续/跳过按钮。
* 常规按钮应位于激励按钮的同排侧边或上方。


* **防欺诈色彩与标记**：
* 激励广告按钮**严禁使用绿色**等具有诱导性、暗示无风险的主色调。
* 激励按钮上必须带有显眼的视频播放图标（🎬 或明确的“Ad”标牌）。


* **广告拦截环境静默处理 (AdBlock Resilience)**：
* 游戏必须在用户启用广告拦截插件的情况下保持核心功能 100% 可玩。
* 检测到广告请求失败或广告被拦截时，静默关闭激励弹窗或置灰该按钮，**严禁主动弹出“请关闭 AdBlock”类阻断性自定义弹窗**。



---

## 7. 自动化 QA 验证检查清单 (Verification Checklist)

* [ ] **[无痕模式]** 在 Chrome 隐身模式下完整运行 3 个关卡，存档、读档与高分记录无脚本报错。
* [ ] **[手势隔离]** 快速连续轻触、双击、滑动画布边缘，宿主页面不发生弹性位移或拉出滚动条。
* [ ] **[平板检测]** 使用模拟器切换至 iPad/Android 平板尺寸，UI 界面自动隐藏键盘操作提示，全部替换为触控按键。
* [ ] **[焦点切换]** 游戏在游玩过程中最小化或切出标签页，音效立即停止；切回后状态平稳恢复。
* [ ] **[内存泄漏]** 限制 4x CPU 减速状态下循环游玩 15 分钟，JS Heap 曲线平稳，未见内存无序爬升。
* [ ] **[上下文恢复]** 在控制台手动调用 `gl.getExtension('WEBGL_lose_context').loseContext()`，验证游戏画面能否在几秒内自我重绘恢复。

```

```
