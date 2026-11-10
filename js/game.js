/* ============================================================
 * 《雨夜画廊》主程序
 * 四幕状态机：开场 → 现场调查 → 审讯 → 指认/结案
 * 进度自动保存（SafeStorage 封装 localStorage，无痕模式自动降级内存），重进续玩
 * ============================================================ */

import { CASE } from './case-data.js?v=3.6.0';
import { audio, scheduleThunder } from './audio.js?v=3.6.0';
import { storage } from './storage.js?v=3.6.0';
import {
  aiSettings, MODEL_OPTIONS, testConnection, STORAGE_MODE,
  onLoadState, validateTokenFormat,
  proxyState, ENDPOINT_MODE, getEndpointMode, setEndpointMode,
  probeProxy, describeEndpoint, rotateSessionId, aiActive,
  getEndpointUrl, setEndpointUrl, validateEndpointUrl, getEndpointWhitelist, setEndpointWhitelist,
  getProxyBase, setProxyBase, validateProxyBase,
  DEFAULT_ENDPOINT_URL,
} from './ai-client.js?v=3.6.0';
import {
  suspectState, stageOf, askSuspect, presentToSuspect,
  greetingOf, juryVerdict, setActionContext, getDecisionLog, applyRel,
} from './suspect-ai.js?v=3.6.0';
import {
  buildProfile, aiProfileReport, radarSVG,
} from './profiler.js?v=3.6.0';
import {
  requestHint, hintPenalty, hintsLeft, HINT_LIMIT, fallbackHint,
} from './hint.js?v=3.6.0';

const $ = (id) => document.getElementById(id);
const SAVE_KEY = 'rain-gallery-save';
const PHASE_LABELS = {
  intro: '序幕 · 暴雨', invest: '第二幕 · 现场调查',
  interrogate: '第三幕 · 审讯', accuse: '第四幕 · 指认', final: '终幕 · 结案',
};

/* ============================================================
 * 游戏状态
 * ============================================================ */

const state = {
  phase: 'intro',
  currentRoom: 'atrium',
  found: [],                 // 已收集物证 id
  lostEvidence: [],          // v3.0 · 被销毁的物证 id（苏晓删照等，本局永久丢失）
  dramasSeen: [],            // 已查看的剧情/NPC热点（如老周）
  suspects: new Map(),       // suspectId → 审讯状态
  crackCount: 0,             // 总戳穿次数（评分用）
  askedTotal: 0,
  accused: null,             // 指认的嫌疑人 id
  chosenEvidence: [],        // 勾选的定罪物证 id
  activeSuspect: null,       // 当前审讯对象
  finished: false,
  stats: null,               // 行为痕迹（侧写报告用）
  evaluation: null,          // 已生成的侧写报告（终幕持久化）
  resumePhase: null,         // 存档 phase 快照（load 时写入，续玩判定用）
  volunteerNoted: false,     // v3.0 · 林曼青已主动交代（线索册批注）
  epilogue: null,            // v3.0 · 局末关系尾声文案（结案展示）
};

/* ---------- 行为痕迹采集（AI 评测报告的数据源） ---------- */

const GUIDE_KEY = 'rain-gallery-guided';

function defaultStats() {
  return {
    startedAt: 0,            // 点「开始调查」的时间戳
    playedMs: 0,             // 有效游玩毫秒（单次增量封顶 120s，防挂机/防刷新重置）
    _lastTick: 0,            // 上次计时点（不落盘）
    roomVisits: {},          // roomId → 进入次数
    hotspotClicks: 0,        // 热点点击总数
    repeatViews: 0,          // 重复查看已收集物证的次数
    questionsPerSuspect: {}, // suspectId → 提问数
    repeatQuestions: 0,      // 与近期提问相似的重复提问数
    recentQuestions: [],     // 近 8 条提问（归一化，不落盘）
    presentsTotal: 0,        // 出示物证总次数
    presentsUnique: 0,       // 出示的不同物证种数
    presentedIds: [],        // 已出示过的物证 id
    evidenceOrder: [],       // 物证发现顺序
    hintsUsed: 0,            // 求助次数（一局 3 次；computeScore 按次扣分）
  };
}

function ensureStats() {
  if (!state.stats) state.stats = defaultStats();
  // 旧存档缺字段补默认
  const d = defaultStats();
  Object.keys(d).forEach((k) => {
    if (state.stats[k] === undefined) state.stats[k] = d[k];
  });
  return state.stats;
}

function tickPlayTime() {
  const st = state.stats;
  if (!st || !st.startedAt) return;
  const now = Date.now();
  if (!st._lastTick) { st._lastTick = now; return; }
  const delta = now - st._lastTick;
  st._lastTick = now;
  if (delta > 0 && delta < 120000) st.playedMs += delta;
}

function normQuestion(q) {
  return String(q).toLowerCase().replace(/[\s，。？！?!,.''"「」『』、：:－—-]/g, '');
}

/** 全量重置游戏状态（「开始新游戏」清空旧存档后调用） */
function resetGameState() {
  state.phase = 'intro';
  state.currentRoom = 'atrium';
  state.found = [];
  state.lostEvidence = [];
  state.dramasSeen = [];
  state.suspects.clear();
  CASE.suspects.forEach((s) => state.suspects.set(s.id, suspectState(s.id)));
  state.crackCount = 0;
  state.askedTotal = 0;
  state.accused = null;
  state.chosenEvidence = [];
  state.activeSuspect = null;
  state.finished = false;
  state.stats = defaultStats();
  state.evaluation = null;
  state.resumePhase = null;
  state.volunteerNoted = false;
  state.epilogue = null;
  rotateSessionId(); // v3.0 · 新局新会话（免费通道额度重新计数）
  // 物证弱化标记复位（靴子）
  const boots = CASE.evidences.find((e) => e.id === 'boots');
  if (boots) boots.weakened = false;
}

CASE.suspects.forEach((s) => state.suspects.set(s.id, suspectState(s.id)));

/* ---------- 存档 ---------- */

function save() {
  tickPlayTime();
  const suspects = {};
  state.suspects.forEach((st, id) => {
    suspects[id] = {
      pressure: st.pressure,
      triggeredKeys: [...st.triggeredKeys],
      confessed: st.confessed,
      confessionStep: st.confessionStep || 0,
      trust: st.trust,
      hostility: st.hostility,
      usedActions: [...(st.usedActions || [])],
      lawyerLock: !!st.lawyerLock,
      requestedStorage: !!st.requestedStorage,
    };
  });
  const data = {
    phase: state.phase, currentRoom: state.currentRoom, found: state.found,
    lostEvidence: state.lostEvidence || [],
    dramasSeen: state.dramasSeen || [],
    suspects, crackCount: state.crackCount, askedTotal: state.askedTotal,
    accused: state.accused, chosenEvidence: state.chosenEvidence,
    finished: state.finished,
    stats: state.stats || null,
    evaluation: state.evaluation || null,
    volunteerNoted: !!state.volunteerNoted,
    sessionId: undefined, // 每次会话独立，不落盘
  };
  try { storage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (e) { /* 私隐模式 */ }
}

function load() {
  try {
    const raw = storage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    Object.assign(state, {
      phase: d.phase || 'intro', currentRoom: d.currentRoom || 'atrium',
      found: d.found || [], lostEvidence: d.lostEvidence || [],
      dramasSeen: Array.isArray(d.dramasSeen) ? d.dramasSeen : [],
      crackCount: d.crackCount || 0,
      askedTotal: d.askedTotal || 0, accused: d.accused || null,
      chosenEvidence: d.chosenEvidence || [], finished: !!d.finished,
      stats: d.stats || null, evaluation: d.evaluation || null,
      volunteerNoted: !!d.volunteerNoted,
    });
    state.resumePhase = d.phase || 'intro'; // 存档 phase 快照（封面展示会改写 state.phase，续玩以快照为准）
    if (d.suspects) {
      Object.entries(d.suspects).forEach(([id, st]) => {
        if (state.suspects.has(id)) {
          const base = suspectState(id); // 旧存档缺新字段补默认
          Object.assign(state.suspects.get(id), base, st, {
            triggeredKeys: new Set(st.triggeredKeys || []),
            usedActions: new Set(st.usedActions || []),
          });
        }
      });
    }
    return true;
  } catch (e) { return false; }
}

/* ============================================================
 * 工具：toast / 打字机
 * ============================================================ */

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

/* ---------- 矛盾击穿反馈（规范 §6 · 150ms 强光闪烁） ---------- */
let strikeFlashEl = null;
function triggerStrike() {
  if (!strikeFlashEl) {
    strikeFlashEl = document.createElement('div');
    strikeFlashEl.className = 'strike-flash';
    strikeFlashEl.setAttribute('aria-hidden', 'true');
    document.body.appendChild(strikeFlashEl);
  }
  strikeFlashEl.classList.remove('on');
  void strikeFlashEl.offsetWidth; // 强制重排以重启动画
  strikeFlashEl.classList.add('on');
}

/* ---------- 游戏内确认/输入弹窗（替代浏览器原生 confirm/prompt） ---------- */

let activeConfirmCancel = null;
let activePromptCancel = null;

/**
 * 游戏内确认弹窗。resolve(true)=确定，resolve(false)=取消/关闭
 */
function gameConfirm(message, { title = '确认操作', okText = '确定', cancelText = '取消', danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $('modal-confirm');
    $('confirm-title').textContent = title;
    $('confirm-message').textContent = message;
    const okBtn = $('btn-confirm-ok');
    const cancelBtn = $('btn-confirm-cancel');
    okBtn.textContent = okText;
    okBtn.className = danger ? 'danger-btn' : 'primary-btn';
    cancelBtn.textContent = cancelText;
    modal.classList.remove('hidden');
    let settled = false;
    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      activeConfirmCancel = null;
      resolve(result);
    };
    okBtn.onclick = () => { audio.click(); cleanup(true); };
    cancelBtn.onclick = () => { audio.click(); cleanup(false); };
    activeConfirmCancel = () => cleanup(false); // ✕ / 遮罩关闭视为取消
  });
}

/**
 * 游戏内输入弹窗。resolve(输入值)；取消/关闭/空输入 resolve(null)
 */
function gamePrompt(message, { title = '输入', placeholder = '', initial = '' } = {}) {
  return new Promise((resolve) => {
    const modal = $('modal-prompt');
    $('prompt-title').textContent = title;
    $('prompt-message').textContent = message;
    const input = $('prompt-input');
    input.value = initial;
    input.placeholder = placeholder;
    const okBtn = $('btn-prompt-ok');
    const cancelBtn = $('btn-prompt-cancel');
    modal.classList.remove('hidden');
    setTimeout(() => input.focus(), 60);
    let settled = false;
    const cleanup = (result) => {
      if (settled) return;
      settled = true;
      modal.classList.add('hidden');
      input.onkeydown = null;
      activePromptCancel = null;
      resolve(result);
    };
    const submit = () => { audio.click(); cleanup(input.value.trim() || null); };
    okBtn.onclick = submit;
    cancelBtn.onclick = () => { audio.click(); cleanup(null); };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') submit(); };
    activePromptCancel = () => cleanup(null); // ✕ / 遮罩关闭视为取消
  });
}

/** 打字机（可被点击跳过）。返回 Promise，resolve(true)=自然完成 */
function typeText(el, text, speed = 26) {
  return new Promise((resolve) => {
    let i = 0; let skipped = false; let timer = null;
    const cursor = '<span class="cursor"> </span>';
    const finish = () => {
      if (skipped) return;
      skipped = true;
      clearInterval(timer);
      el.innerHTML = '';
      el.append(text);
      resolve(true);
    };
    el.parentElement.addEventListener('click', finish, { once: true });
    const step = () => {
      if (skipped) return;
      if (i >= text.length) { finish(); return; }
      i++;
      el.innerHTML = '';
      el.append(text.slice(0, i));
      el.insertAdjacentHTML('beforeend', cursor);
      if (i % 3 === 0) audio.type();
    };
    timer = setInterval(step, speed);
  });
}

/** 逐行打字（intro 多段合并为一段文本） */
function typeTextBlock(el, lines, speed = 26) {
  return typeText(el, lines.join('\n\n'), speed);
}

/* ============================================================
 * 弹窗无障碍层（焦点圈定 + ESC 关闭 + 焦点归还）
 * ------------------------------------------------------------
 * 所有 .modal 打开时：记录来源焦点 → 焦点移入卡片首个可聚焦元素 →
 * Tab / Shift+Tab 在卡片内循环；按 ESC 关闭并归还焦点。
 * 使用事件委托 + MutationObserver，无需逐个弹窗改造调用点。
 * ============================================================ */

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';
let lastFocusedBeforeModal = null;
let lastFocusKey = '';
let activeModalEl = null;
// 最近一次由指针或键盘聚焦的可交互元素（供关闭弹窗时归还焦点）
let lastPointerTarget = null;
let lastKeyboardTarget = null;

/** 为可交互元素生成稳定的“身份选择器”，用于重绘后找回等价节点 */
function focusKeyOf(el) {
  if (!el || el.nodeType !== 1) return '';
  if (el.id) return `#${CSS.escape(el.id)}`;
  const attrs = ['data-hotspot', 'data-room', 'data-ev', 'data-suspect'];
  for (const a of attrs) {
    const v = el.getAttribute(a);
    if (v) return `[${a}="${CSS.escape(v)}"]`;
  }
  return '';
}

/** 弹窗打开数量 → 背景滚动锁（多层弹窗叠加时按计数还原） */
let openModalCount = 0;
function syncBodyScrollLock(open) {
  openModalCount = Math.max(0, openModalCount + (open ? 1 : -1));
  document.body.style.overflow = openModalCount > 0 ? 'hidden' : '';
}

function focusablesIn(card) {
  return Array.from(card.querySelectorAll(FOCUSABLE))
    .filter((el) => {
      if (el.disabled) return false;
      // 用布局矩形判定可见性：兼容 fixed 定位祖先（offsetParent 可能为 null）
      return el.getClientRects().length > 0;
    });
}

function onModalOpened(modal) {
  if (activeModalEl === modal) return;
  syncBodyScrollLock(true);
  activeModalEl = modal;
  // 优先记住当前真实焦点；SVG 点击 / 列表重绘等情况下回退到最近交互目标
  lastFocusedBeforeModal = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : (lastKeyboardTarget || lastPointerTarget);
  lastFocusKey = focusKeyOf(lastFocusedBeforeModal);
  modal.setAttribute('aria-hidden', 'false');
  // 焦点移入：优先主操作按钮，其次是带 data-autofocus 的元素，最后才回退首个可聚焦元素
  const card = modal.querySelector('.modal-card') || modal;
  const preferred = card.querySelector('[data-autofocus]')
    || card.querySelector('.confirm-actions > button:last-of-type') // 确定/指认等主操作恒在末尾
    || card.querySelector('.settings-actions .primary-btn')
    || card.querySelector('.guide-actions .primary-btn');
  setTimeout(() => {
    if (activeModalEl !== modal) return; // 期间已关闭/切换
    if (preferred && preferred.getClientRects().length) preferred.focus({ preventScroll: true });
    else {
      const list = focusablesIn(card);
      if (list.length) list[0].focus({ preventScroll: true });
      else { card.setAttribute('tabindex', '-1'); card.focus({ preventScroll: true }); }
    }
  }, 30);
}

function onModalClosed(modal) {
  modal.setAttribute('aria-hidden', 'true');
  syncBodyScrollLock(false);
  if (activeModalEl !== modal) return;
  activeModalEl = null;
  let restore = lastFocusedBeforeModal;
  // 弹窗打开期间列表可能整体重绘（如收集物证后的房间刷新），原节点已脱离文档
  if ((!restore || !restore.isConnected) && lastFocusKey) {
    try { restore = document.querySelector(lastFocusKey); } catch (e) { restore = null; }
  }
  if (restore && typeof restore.focus === 'function' && restore.isConnected) {
    restore.focus({ preventScroll: true });
  }
  lastFocusedBeforeModal = null;
  lastFocusKey = '';
}

/** 监听所有 .modal 的显隐（class 变化），统一接管焦点 */
function initModalAccessibility() {
  // 追踪最近一次指针交互的可聚焦目标（供焦点归还兜底）
  document.addEventListener('pointerdown', (ev) => {
    const t = ev.target.closest(FOCUSABLE);
    if (t) lastPointerTarget = t;
  }, { passive: true, capture: true });
  // 追踪键盘焦点目标（列表重绘前最后一次键盘聚焦的元素）
  document.addEventListener('focusin', (ev) => {
    const t = ev.target;
    if (t && t.nodeType === 1 && t.closest('.modal') === null) lastKeyboardTarget = t;
  }, true);

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.setAttribute('aria-hidden', 'true');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    // 用开合状态变化而非每次 class 写入做判断，避免重复 setAttribute 导致计数错乱
    let wasOpen = !modal.classList.contains('hidden');
    const observer = new MutationObserver(() => {
      const nowOpen = !modal.classList.contains('hidden');
      if (nowOpen === wasOpen) return;
      wasOpen = nowOpen;
      if (nowOpen) onModalOpened(modal);
      else onModalClosed(modal);
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });
  });

  // Tab 焦点圈定（仅在激活弹窗内循环）
  document.addEventListener('keydown', (ev) => {
    if (!activeModalEl) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      // 确认/输入弹窗有 promise 收口，走各自的取消逻辑
      if (activeModalEl.id === 'modal-confirm' && activeConfirmCancel) { activeConfirmCancel(); return; }
      if (activeModalEl.id === 'modal-prompt' && activePromptCancel) { activePromptCancel(); return; }
      // 引导弹窗被 ESC 关闭时同样记为已读完，避免下次重复弹出
      if (activeModalEl.id === 'modal-guide') markGuided();
      activeModalEl.classList.add('hidden');
      return;
    }
    if (ev.key !== 'Tab') return;
    const card = activeModalEl.querySelector('.modal-card') || activeModalEl;
    const list = focusablesIn(card);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault(); last.focus({ preventScroll: true });
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault(); first.focus({ preventScroll: true });
    }
  });
}

/* ============================================================
 * SVG 生成器
 * ============================================================ */

/* ---------- 嫌疑人与人物高精矢量肖像（Neo-Noir 风格，支持三段动态微表情） ---------- */

function avatarSVG(s, mood = 'calm', { size = 80 } = {}) {
  const c = s.color || '#7aa5c4';
  const id = s.id || 'chenmo';

  // 1. 守夜人老周
  if (id === 'zhou') {
    const isAwake = mood === 'awake';
    return `<svg viewBox="0 0 80 80" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg-zhou" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#19232e"/><stop offset="100%" stop-color="#0b1016"/>
        </radialGradient>
      </defs>
      <rect width="80" height="80" rx="10" fill="url(#bg-zhou)"/>
      <circle cx="40" cy="40" r="38" fill="none" stroke="#485c70" stroke-width="1.2" opacity=".35"/>
      <!-- 制服躯干 -->
      <path d="M12 80 C12 61 24 55 40 55 C56 55 68 61 68 80 Z" fill="#1e2834"/>
      <path d="M30 55 L40 68 L50 55 Z" fill="#2d3c4e"/>
      <line x1="22" y1="58" x2="30" y2="59" stroke="#d4ab4e" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="58" y1="58" x2="50" y2="59" stroke="#d4ab4e" stroke-width="2.5" stroke-linecap="round"/>
      <!-- 头部与面部 -->
      <rect x="35" y="44" width="10" height="13" fill="#c4ad99"/>
      <path d="M26 33 C26 21 54 21 54 33 C54 46 47 52 40 52 C33 52 26 46 26 33 Z" fill="#d5beaf"/>
      <!-- 老保安大檐帽 -->
      <path d="M26 21 H54 V27 H26 Z" fill="#1b2532"/>
      <path d="M22 27 H58 L55 31 H25 Z" fill="#101720"/>
      <circle cx="40" cy="24" r="2.2" fill="#d4ab4e"/>
      <!-- 胡茬与沧桑皱纹 -->
      <path d="M29 44 Q40 50 51 44" stroke="#687685" stroke-width="2" fill="none" opacity=".8"/>
      <line x1="28" y1="36" x2="31" y2="38" stroke="#aa9382" stroke-width="1.2" opacity=".6"/>
      <line x1="52" y1="36" x2="49" y2="38" stroke="#aa9382" stroke-width="1.2" opacity=".6"/>
      ${isAwake ? `
        <!-- 苏醒慈祥状态 -->
        <circle cx="34" cy="36" r="1.8" fill="#1a2026"/><circle cx="46" cy="36" r="1.8" fill="#1a2026"/>
        <rect x="44" y="27" width="9" height="7" rx="1.5" fill="#f0ebe4" opacity=".95"/>
        <path d="M36 46 Q40 48.5 44 46" stroke="#7a5c54" stroke-width="1.8" fill="none" stroke-linecap="round"/>
      ` : `
        <!-- 昏迷受伤状态 -->
        <line x1="31" y1="36.5" x2="36.5" y2="36.5" stroke="#48362e" stroke-width="2" stroke-linecap="round"/>
        <line x1="43.5" y1="36.5" x2="49" y2="36.5" stroke="#48362e" stroke-width="2" stroke-linecap="round"/>
        <ellipse cx="48" cy="30" rx="4.5" ry="3.5" fill="#7a2a3e" opacity=".65"/>
        <line x1="36" y1="46" x2="44" y2="46" stroke="#7a5c54" stroke-width="1.6" stroke-linecap="round"/>
      `}
    </svg>`;
  }

  // 2. 策展助理 —— 陈默
  if (id === 'chenmo') {
    const isShaken = mood === 'shaken';
    const isBroken = mood === 'broken';
    return `<svg viewBox="0 0 80 80" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg-chenmo" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#141e2a"/><stop offset="100%" stop-color="#080d13"/>
        </radialGradient>
      </defs>
      <rect width="80" height="80" rx="10" fill="url(#bg-chenmo)"/>
      <circle cx="40" cy="40" r="38" fill="none" stroke="${c}" stroke-width="1.2" opacity=".35"/>
      <!-- 工装夹克躯干与高领内搭 -->
      <path d="M12 80 C12 62 25 55 40 55 C55 55 68 62 68 80 Z" fill="#15212d"/>
      <path d="M32 55 L40 68 L48 55 Z" fill="#243343"/>
      <rect x="33" y="47" width="14" height="10" fill="#1b2532"/>
      <line x1="40" y1="57" x2="40" y2="76" stroke="#7aa5c4" stroke-width="1.5" stroke-dasharray="2 2" opacity=".6"/>
      <!-- 脖颈与下颌 -->
      <rect x="35" y="44" width="10" height="12" fill="#cfbba8"/>
      <path d="M34 46 Q40 51 46 46 Z" fill="#b09985" opacity=".5"/>
      <path d="M26 33 C26 21 54 21 54 33 C54 46 47 52 40 52 C33 52 26 46 26 33 Z" fill="#decbc0"/>
      <!-- 耳朵 -->
      <circle cx="25.5" cy="35" r="3.2" fill="#d2beaF"/><circle cx="54.5" cy="35" r="3.2" fill="#d2beaF"/>
      <!-- 层次感深黑短发 -->
      <path d="M24 31 C24 16 56 16 56 31 C56 24 50 14 40 14 C30 14 24 22 24 31 Z" fill="#1a222a"/>
      <path d="M24 25 C32 17 48 17 56 25 L56 19 C48 11 32 11 24 19 Z" fill="#283441"/>
      <path d="M25 24 C31 21 38 25 45 22 C37 18 29 19 25 24 Z" fill="#394a5c"/>
      <!-- 眼镜框 -->
      <rect x="27" y="32" width="11" height="9" rx="2" fill="none" stroke="#9db6c9" stroke-width="1.5"/>
      <rect x="42" y="32" width="11" height="9" rx="2" fill="none" stroke="#9db6c9" stroke-width="1.5"/>
      <line x1="38" y1="36" x2="42" y2="36" stroke="#9db6c9" stroke-width="1.5"/>
      <!-- 动态微表情 -->
      ${isBroken ? `
        <!-- 崩溃：面部阴影加深、眼眶通红噙泪、绝望 -->
        <path d="M25 24 H55 V35 Q40 40 25 35 Z" fill="#000000" opacity=".35"/>
        <ellipse cx="32.5" cy="38" rx="3.2" ry="1.6" fill="#8c3a44" opacity=".55"/>
        <ellipse cx="47.5" cy="38" rx="3.2" ry="1.6" fill="#8c3a44" opacity=".55"/>
        <circle cx="32.5" cy="37" r="1.6" fill="#141a20"/><circle cx="47.5" cy="37" r="1.6" fill="#141a20"/>
        <path d="M28 32 Q33 30 37 33" stroke="#242e38" stroke-width="2" fill="none"/>
        <path d="M43 33 Q47 30 52 32" stroke="#242e38" stroke-width="2" fill="none"/>
        <path d="M31.5 40 Q30 46 32.5 50" stroke="#7eb5e6" stroke-width="1.8" fill="none"/>
        <circle cx="32.5" cy="50" r="1.4" fill="#a4d1f7"/>
        <path d="M36 47 Q40 49 44 47" stroke="#7a524a" stroke-width="2" fill="none"/>
        <line x1="36" y1="19" x2="38" y2="33" stroke="#1a222a" stroke-width="1.6"/>
      ` : isShaken ? `
        <!-- 动摇：眼神慌乱、冷汗滑落、紧绷 -->
        <circle cx="33" cy="36.5" r="1.6" fill="#141a20"/><circle cx="47" cy="36.5" r="1.6" fill="#141a20"/>
        <path d="M28 31 Q33 28 37 30.5" stroke="#283441" stroke-width="1.8" fill="none"/>
        <path d="M43 30.5 Q47 28 52 31" stroke="#283441" stroke-width="1.8" fill="none"/>
        <path d="M36 46.5 Q40 45 44 46.5" stroke="#7a524a" stroke-width="1.6" fill="none"/>
        <path d="M53 32 Q54.5 37 53 40" stroke="#7eb5e6" stroke-width="1.5" fill="none"/>
        <circle cx="53" cy="40" r="1.3" fill="#9eccf5"/>
      ` : `
        <!-- 镇定：冷峻理智、镜片反光、平视 -->
        <path d="M28.5 33 L36 40" stroke="#ffffff" stroke-width="1.3" opacity=".65"/>
        <circle cx="32.5" cy="36.5" r="1.8" fill="#141a20"/><circle cx="47.5" cy="36.5" r="1.8" fill="#141a20"/>
        <circle cx="33.2" cy="35.8" r=".6" fill="#fff"/><circle cx="48.2" cy="35.8" r=".6" fill="#fff"/>
        <line x1="28" y1="30" x2="37" y2="30.5" stroke="#283441" stroke-width="1.5"/>
        <line x1="43" y1="30.5" x2="52" y2="30" stroke="#283441" stroke-width="1.5"/>
        <line x1="36" y1="46" x2="44" y2="46" stroke="#7a524a" stroke-width="1.6" stroke-linecap="round"/>
      `}
    </svg>`;
  }

  // 3. 画廊老板 —— 林曼青
  if (id === 'linmanqing') {
    const isShaken = mood === 'shaken';
    const isBroken = mood === 'broken';
    return `<svg viewBox="0 0 80 80" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <radialGradient id="bg-lin" cx="50%" cy="40%" r="60%">
          <stop offset="0%" stop-color="#24141e"/><stop offset="100%" stop-color="#0e080c"/>
        </radialGradient>
      </defs>
      <rect width="80" height="80" rx="10" fill="url(#bg-lin)"/>
      <circle cx="40" cy="40" r="38" fill="none" stroke="${c}" stroke-width="1.2" opacity=".35"/>
      <!-- 酒红丝绒西装与内衬 -->
      <path d="M10 80 C10 60 24 53 40 53 C56 53 70 60 70 80 Z" fill="#461c2b"/>
      <path d="M27 53 L40 69 L53 53 Z" fill="#ece3da"/>
      <path d="M23 53 L37 72 L31 80 Z" fill="#5c2438"/>
      <path d="M57 53 L43 72 L49 80 Z" fill="#5c2438"/>
      <circle cx="40" cy="74" r="2.2" fill="#d4af42"/>
      <!-- 脖颈与面部轮廓 -->
      <rect x="35" y="44" width="10" height="12" fill="#dfc6b5"/>
      <path d="M26 32 C26 20 54 20 54 32 C54 45 47 51 40 51 C33 51 26 45 26 32 Z" fill="#ebd7cc"/>
      <!-- 华丽深发侧挽髻与高光 -->
      <circle cx="40" cy="21" r="16" fill="#24161f"/>
      <path d="M22 34 C20 18 36 11 56 20 C60 28 58 40 56 46 C52 38 52 27 40 27 C30 27 24 31 22 34 Z" fill="#392431"/>
      <path d="M28 19 C36 14 48 15 54 23" stroke="#563b4b" stroke-width="2" fill="none"/>
      <!-- 珍珠耳坠 -->
      <circle cx="23.5" cy="38.5" r="2.2" fill="#f4ece4"/>
      <line x1="24.5" y1="35.5" x2="23.5" y2="37.5" stroke="#d4af42" stroke-width="1.2"/>
      <!-- 动态微表情 -->
      ${isBroken ? `
        <!-- 崩溃：精致武装卸下、妆容微花、神色灰败 -->
        <path d="M28 30.5 Q33 29.5 37 31.5" stroke="#321e29" stroke-width="1.8" fill="none"/>
        <path d="M43 31.5 Q47 29.5 52 30.5" stroke="#321e29" stroke-width="1.8" fill="none"/>
        <ellipse cx="33" cy="36.5" rx="3.5" ry="1.6" fill="#1e1219" opacity=".5"/>
        <ellipse cx="47" cy="36.5" rx="3.5" ry="1.6" fill="#1e1219" opacity=".5"/>
        <circle cx="33" cy="35.5" r="1.8" fill="#23161f"/><circle cx="47" cy="35.5" r="1.8" fill="#23161f"/>
        <path d="M35 48 Q40 45.5 45 48" stroke="#7a2a35" stroke-width="2.2" fill="none" stroke-linecap="round"/>
        <path d="M48 24 Q44 32 46 42" stroke="#24161f" stroke-width="1.6" fill="none"/>
      ` : isShaken ? `
        <!-- 动摇：眉头紧锁、神色紧绷焦躁 -->
        <path d="M28 29.5 Q33 26.5 37 28.5" stroke="#321e29" stroke-width="2.2" fill="none"/>
        <path d="M43 28.5 Q47 26.5 52 29.5" stroke="#321e29" stroke-width="2.2" fill="none"/>
        <circle cx="33" cy="34.5" r="2.1" fill="#23161f"/><circle cx="47" cy="34.5" r="2.1" fill="#23161f"/>
        <line x1="39.5" y1="27.5" x2="40.5" y2="30.5" stroke="#321e29" stroke-width="1.2"/>
        <line x1="35" y1="46" x2="45" y2="46" stroke="#9e2838" stroke-width="2.6" stroke-linecap="round"/>
        <circle cx="26" cy="30.5" r="1.3" fill="#88b7e0"/>
      ` : `
        <!-- 镇定：红唇艳丽、居高临下挑衅冷笑 -->
        <path d="M28 28.5 Q34 25.5 38 27.5" stroke="#321e29" stroke-width="1.8" fill="none"/>
        <path d="M42 27.5 Q46 25.5 52 28.5" stroke="#321e29" stroke-width="1.8" fill="none"/>
        <ellipse cx="33" cy="34.5" rx="2.5" ry="2" fill="#23161f"/>
        <ellipse cx="47" cy="34.5" rx="2.5" ry="2" fill="#23161f"/>
        <circle cx="34" cy="34" r=".7" fill="#fff"/><circle cx="48" cy="34" r=".7" fill="#fff"/>
        <path d="M35 46 Q40 48.5 45 46" stroke="#a02637" stroke-width="2.5" fill="none" stroke-linecap="round"/>
      `}
    </svg>`;
  }

  // 4. 美院实习生 —— 苏晓
  const isShaken = mood === 'shaken';
  const isBroken = mood === 'broken';
  return `<svg viewBox="0 0 80 80" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="bg-su" cx="50%" cy="40%" r="60%">
        <stop offset="0%" stop-color="#192419"/><stop offset="100%" stop-color="#0a100a"/>
      </radialGradient>
    </defs>
    <rect width="80" height="80" rx="10" fill="url(#bg-su)"/>
    <circle cx="40" cy="40" r="38" fill="none" stroke="${c}" stroke-width="1.2" opacity=".35"/>
    <!-- 宽松青绿卫衣与抽绳 -->
    <path d="M12 80 C12 59 24 53 40 53 C56 53 68 59 68 80 Z" fill="#30442f"/>
    <path d="M28 53 Q40 62 52 53 Z" fill="#243323"/>
    <path d="M36 58 V75 M44 58 V73" stroke="#b4ccb0" stroke-width="2" stroke-linecap="round"/>
    <circle cx="36" cy="75" r="1.5" fill="#e2ede0"/>
    <circle cx="44" cy="73" r="1.5" fill="#e2ede0"/>
    <!-- 脸庞与双丸子头 -->
    <rect x="35" y="44" width="10" height="12" fill="#e0c7b6"/>
    <path d="M26 33 C26 21 54 21 54 33 C54 46 47 52 40 52 C33 52 26 46 26 33 Z" fill="#f2ddcf"/>
    <!-- 双丸子头与刘海 -->
    <circle cx="21" cy="21" r="7.5" fill="#251c17"/><circle cx="59" cy="21" r="7.5" fill="#251c17"/>
    <circle cx="21" cy="21" r="5" fill="#3d2f26"/><circle cx="59" cy="21" r="5" fill="#3d2f26"/>
    <path d="M24 30 C22 17 58 17 56 30 C52 22 46 22 40 24 C34 22 28 22 24 30 Z" fill="#251c17"/>
    <path d="M23 30 Q22 42 24 45 M57 30 Q58 42 56 45" stroke="#3d2f26" stroke-width="2" fill="none"/>
    <!-- 俏皮小雀斑 -->
    <circle cx="32" cy="40" r=".7" fill="#a87a66"/><circle cx="34" cy="41" r=".7" fill="#a87a66"/><circle cx="46" cy="40" r=".7" fill="#a87a66"/><circle cx="48" cy="41" r=".7" fill="#a87a66"/><circle cx="40" cy="40" r=".7" fill="#a87a66"/>
    <!-- 动态微表情 -->
    ${isBroken ? `
      <!-- 崩溃：大哭掉眼泪、眼圈鼻尖通红、全盘认错 -->
      <circle cx="33" cy="36" r="2.8" fill="#1b1512"/><circle cx="47" cy="36" r="2.8" fill="#1b1512"/>
      <path d="M33 39 Q31 46 34 52" stroke="#7eb5e6" stroke-width="2.2" fill="none"/>
      <path d="M47 39 Q49 46 46 52" stroke="#7eb5e6" stroke-width="2.2" fill="none"/>
      <circle cx="34" cy="52" r="1.6" fill="#a4d1f7"/><circle cx="46" cy="52" r="1.6" fill="#a4d1f7"/>
      <circle cx="40" cy="42" r="2.4" fill="#cf6874" opacity=".55"/>
      <path d="M28 28.5 Q33 25.5 38 29.5" stroke="#251c17" stroke-width="2" fill="none"/>
      <path d="M42 29.5 Q47 25.5 52 28.5" stroke="#251c17" stroke-width="2" fill="none"/>
      <path d="M35 48 Q40 45 45 48" stroke="#8c3a44" stroke-width="2.2" fill="none" stroke-linecap="round"/>
    ` : isShaken ? `
      <!-- 动摇：瞳孔地震惊恐、张嘴惊呼、冷汗 -->
      <ellipse cx="33" cy="35" rx="3.6" ry="4" fill="#1b1512"/>
      <ellipse cx="47" cy="35" rx="3.6" ry="4" fill="#1b1512"/>
      <circle cx="34" cy="34" r="1.4" fill="#fff"/><circle cx="48" cy="34" r="1.4" fill="#fff"/>
      <circle cx="33" cy="35" r="4.3" stroke="#fff" stroke-width=".8" fill="none" opacity=".8"/>
      <circle cx="47" cy="35" r="4.3" stroke="#fff" stroke-width=".8" fill="none" opacity=".8"/>
      <path d="M28 26.5 Q33 22.5 38 26.5" stroke="#251c17" stroke-width="2" fill="none"/>
      <path d="M42 26.5 Q47 22.5 52 26.5" stroke="#251c17" stroke-width="2" fill="none"/>
      <ellipse cx="40" cy="47" rx="2.5" ry="3" fill="#6e2d28"/>
      <circle cx="28" cy="30.5" r="1.3" fill="#88b7e0"/><circle cx="52" cy="30" r="1.3" fill="#88b7e0"/>
    ` : `
      <!-- 镇定：大眼睛好奇张望、尴尬微笑 -->
      <ellipse cx="33" cy="35" rx="3" ry="3.5" fill="#1b1512"/>
      <ellipse cx="47" cy="35" rx="3" ry="3.5" fill="#1b1512"/>
      <circle cx="34" cy="34" r="1.2" fill="#fff"/><circle cx="48" cy="34" r="1.2" fill="#fff"/>
      <path d="M28 27.5 Q33 25.5 37 27.5" stroke="#251c17" stroke-width="1.6" fill="none"/>
      <path d="M43 27.5 Q47 25.5 52 27.5" stroke="#251c17" stroke-width="1.6" fill="none"/>
      <path d="M36 46 Q40 48.5 44 46" stroke="#b0645c" stroke-width="2" fill="none" stroke-linecap="round"/>
    `}
  </svg>`;
}

/* ---------- 平面图 ---------- */

const MAP_LAYOUT = {
  corridor: { x: 8, y: 8, w: 48, h: 64, label: '后廊' },
  hall: { x: 60, y: 8, w: 80, h: 64, label: '主展厅' },
  storage: { x: 144, y: 8, w: 48, h: 64, label: '储物间' },
  atrium: { x: 8, y: 76, w: 184, h: 98, label: '中庭' },
  office: { x: 8, y: 178, w: 184, h: 60, label: '办公室' },
};

function renderMap() {
  const svgParts = Object.entries(MAP_LAYOUT).map(([id, r]) => {
    const room = CASE.rooms.find((rm) => rm.id === id);
    const active = state.currentRoom === id;
    const evCount = room.hotspots.filter((h) => isCollected(h.id)).length;
    const total = room.hotspots.filter((h) => CASE.evidences.some((e) => e.id === h.id)).length;
    const cleared = total > 0 && evCount >= total;
    const badge = total ? ` ${evCount}/${total}` : '';
    // 三态：active 当前 / cleared 已清空 / pending 待勘查
    const cls = `map-g${active ? ' active' : ''}${cleared ? ' cleared' : ''}${(!active && !cleared && total > 0) ? ' pending' : ''}`;
    const title = `<title>${room.name} · ${cleared ? '已勘查完毕 ✓' : `还有 ${total - evCount} 处待勘查`}${badge ? `（物证 ${badge.trim()}）` : ''}</title>`;
    // 外扩 2 单位的透明命中垫底，覆盖房间间隙防误触/点不中
    const hit = `<rect class="map-hit" x="${r.x - 2}" y="${r.y - 2}" width="${r.w + 4}" height="${r.h + 4}" rx="5" fill="transparent"/>`;
    const check = cleared ? `<text class="map-mark" x="${r.x + r.w - 10}" y="${r.y + 13}" font-size="9">✓</text>` : '';
    const dot = (!cleared && total > 0 && evCount < total)
      ? `<circle class="map-mark-dot" cx="${r.x + r.w - 10}" cy="${r.y + 10}" r="3"/>` : '';
    return `<g class="${cls}" data-room="${id}" role="button" tabindex="0"
        aria-label="${room.name}，${cleared ? '已勘查完毕' : `还有 ${total - evCount} 处待勘查`}">
      ${title}
      <rect class="map-room" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}"
        rx="4" fill="#1a2432" stroke="#3a4a5e"/>
      ${dot}
      <text x="${r.x + r.w / 2}" y="${r.y + r.h / 2 + 2}" text-anchor="middle"
        font-size="11" fill="#aebccd" font-family="serif">${r.label}${badge}</text>
      ${check}
      ${hit}
    </g>`;
  });
  $('floor-map').innerHTML = `<svg viewBox="0 0 200 246" xmlns="http://www.w3.org/2000/svg">
    <rect width="200" height="246" fill="#0a0e14" rx="8"/>
    ${svgParts.join('')}
    <text x="100" y="240" text-anchor="middle" font-size="8" fill="#4a5a6c">▲ 北 · 出入口在南侧</text>
  </svg>`;
  $('floor-map').querySelectorAll('.map-g').forEach((el) => {
    el.addEventListener('click', () => { audio.click(); enterRoom(el.dataset.room); });
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); audio.click(); enterRoom(el.dataset.room); }
    });
  });
}

/* ---------- 房间内景 ---------- */

const W = 400, H = 240;

function windowRain(x, y, w, h) {
  let lines = '';
  for (let i = 1; i < 5; i++) {
    const lx = x + (w / 5) * i;
    lines += `<line x1="${lx}" y1="${y + 4}" x2="${lx - 5}" y2="${y + h - 4}" stroke="#5d7a95" stroke-width="1" opacity=".5"/>`;
  }
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#141d2a" stroke="#3a4a5e"/>
    ${lines}
    <rect x="${x + w / 2 - 1}" y="${y}" width="2" height="${h}" fill="#3a4a5e"/>`;
}

const ROOM_ART = {
  atrum: '',
  atrium: () => `
    <rect width="${W}" height="${H}" fill="#0e131b"/>
    <ellipse cx="200" cy="40" rx="150" ry="26" fill="#18222f"/>
    <path d="M60 40 L200 18 L340 40" stroke="#2c3c4e" fill="none" stroke-width="2"/>
    ${Array.from({ length: 9 }, (_, i) => `<line x1="${110 + i * 22}" y1="46" x2="${104 + i * 22}" y2="${64 + (i % 3) * 6}" stroke="#4a6076" stroke-width="1" opacity=".6"/>`).join('')}
    <rect x="14" y="120" width="90" height="16" rx="3" fill="#1c2735"/>
    <rect x="20" y="104" width="30" height="18" rx="2" fill="#232f3f"/>
    <circle cx="34" cy="106" r="9" fill="#e8c56a" opacity=".85"/>
    <circle cx="34" cy="106" r="20" fill="#e8c56a" opacity=".12"/>
    ${windowRain(318, 60, 62, 84)}
    <rect x="252" y="168" width="110" height="10" rx="3" fill="#1c2735"/>
    <rect x="262" y="178" width="8" height="14" fill="#1c2735"/><rect x="344" y="178" width="8" height="14" fill="#1c2735"/>
    <!-- 倒地守夜人老周（逼真人形侧卧姿态，跌落的大檐帽与手电筒光晕） -->
    <g id="scene-guard-zhou">
      <!-- 地面深色投射阴影 -->
      <ellipse cx="178" cy="195" rx="46" ry="11" fill="#06090e" opacity=".75"/>
      <!-- 跌落在身旁的手电筒及漫射光束 -->
      <polygon points="124,196 210,175 220,215" fill="#fdf4d2" opacity=".13"/>
      <ellipse cx="212" cy="195" rx="18" ry="12" fill="#fdf4d2" opacity=".07"/>
      <rect x="112" y="194" width="13" height="5" rx="1.5" fill="#394654" transform="rotate(-15 112 194)"/>
      <rect x="123" y="192.5" width="4" height="7" rx="1" fill="#cbd6e2" transform="rotate(-15 112 194)"/>
      <!-- 跌落在一旁的保安大檐帽 -->
      <path d="M136 178 H152 V183 H136 Z" fill="#1b2430"/>
      <path d="M133 183 H155 L153 186 H135 Z" fill="#101720"/>
      <circle cx="144" cy="180.5" r="1.3" fill="#d4ab4e"/>
      <!-- 侧卧躯干（深藏青保安夹克与金色肩章） -->
      <path d="M164 182 C172 178 188 180 198 187 L194 198 C182 198 170 196 164 189 Z" fill="#1e2834"/>
      <line x1="168" y1="181" x2="173" y2="183" stroke="#d4ab4e" stroke-width="2" stroke-linecap="round"/>
      <!-- 头部枕地与太阳穴挫伤 -->
      <path d="M149 183 C147 176 158 174 165 178 Z" fill="#525d6b"/>
      <ellipse cx="157" cy="183.5" rx="8" ry="6" fill="#cfbba8"/>
      <ellipse cx="155" cy="180.5" rx="2" ry="1.5" fill="#6b2636" opacity=".7"/>
      <line x1="157" y1="184" x2="160" y2="184" stroke="#48362e" stroke-width="1.2" stroke-linecap="round"/>
      <!-- 垂在身侧与摊开在地的手臂 -->
      <path d="M168 186 Q164 194 156 195" stroke="#1e2834" stroke-width="5" fill="none" stroke-linecap="round"/>
      <circle cx="154" cy="195" r="2.8" fill="#cfbba8"/>
      <path d="M184 188 Q180 194 174 197" stroke="#17202b" stroke-width="4.5" fill="none" stroke-linecap="round"/>
      <!-- 屈膝侧卧的双腿与保安黑皮鞋 -->
      <path d="M196 189 Q208 191 216 197 L210 200 Q200 195 192 196 Z" fill="#151d26"/>
      <path d="M216 197 L226 201" stroke="#151d26" stroke-width="5.5" stroke-linecap="round"/>
      <path d="M194 196 Q206 199 220 204" stroke="#0f161e" stroke-width="5" stroke-linecap="round"/>
      <ellipse cx="229" cy="202" rx="4.5" ry="2.5" fill="#090d12"/>
      <ellipse cx="223" cy="205" rx="4.2" ry="2.2" fill="#090d12"/>
    </g>
    <ellipse cx="200" cy="214" rx="120" ry="18" fill="#0a0e14" opacity=".5"/>`,
  hall: () => `
    <rect width="${W}" height="${H}" fill="#0d1119"/>
    <rect x="0" y="20" width="${W}" height="120" fill="#131a26"/>
    <rect x="30" y="46" width="52" height="66" fill="#232d3c" stroke="#3a4a5e"/>
    <rect x="34" y="50" width="44" height="58" fill="#2b3a52"/>
    <rect x="316" y="46" width="52" height="66" fill="#232d3c" stroke="#3a4a5e"/>
    <rect x="320" y="50" width="44" height="58" fill="#3d3348"/>
    <rect x="118" y="30" width="164" height="106" fill="#1b2536" stroke="#4a5a6c" stroke-width="3"/>
    <defs><linearGradient id="rainart" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2e4d6b"/><stop offset=".6" stop-color="#38618c"/><stop offset="1" stop-color="#22364d"/>
    </linearGradient></defs>
    <rect x="130" y="38" width="140" height="90" fill="url(#rainart)"/>
    ${Array.from({ length: 14 }, (_, i) => `<line x1="${136 + i * 10}" y1="44" x2="${130 + i * 10}" y2="122" stroke="#9fc2e0" stroke-width="1" opacity=".35"/>`).join('')}
    <path d="M131 84 L269 76" stroke="#e8e2d4" stroke-width="2.5" stroke-dasharray="7 4" opacity=".95"/>
    <rect x="290" y="150" width="80" height="46" rx="4" fill="#1a2432" stroke="#3a4a5e"/>
    <rect x="296" y="156" width="68" height="6" rx="2" fill="#242f40"/>
    <rect x="296" y="166" width="40" height="6" rx="2" fill="#242f40"/>
    <rect x="96" y="160" width="180" height="5" rx="2" fill="#1e2938"/>
    <rect x="150" y="165" width="7" height="40" fill="#1e2938"/><rect x="262" y="165" width="7" height="40" fill="#1e2938"/>
    <ellipse cx="200" cy="222" rx="140" ry="16" fill="#080c12" opacity=".6"/>`,
  office: () => `
    <rect width="${W}" height="${H}" fill="#10151e"/>
    ${windowRain(20, 30, 70, 90)}
    <rect x="130" y="130" width="220" height="12" rx="3" fill="#242f40"/>
    <rect x="146" y="142" width="10" height="40" fill="#1c2735"/><rect x="330" y="142" width="10" height="40" fill="#1c2735"/>
    <rect x="170" y="100" width="52" height="32" rx="3" fill="#0d1119" stroke="#3a4a5e"/>
    <rect x="174" y="104" width="44" height="24" fill="#16202e"/>
    <path d="M188 128 L204 128 L200 134 L192 134 Z" fill="#242f40"/>
    <g><rect x="240" y="112" width="16" height="18" rx="2" fill="#d8d2c4"/>
      <path d="M242 108 Q248 100 254 108" stroke="#8a97a8" stroke-width="1.6" fill="none" opacity=".7"/>
      <path d="M244 104 Q248 98 252 104" stroke="#8a97a8" stroke-width="1.2" fill="none" opacity=".4"/></g>
    <rect x="296" y="86" width="14" height="56" rx="7" fill="#2a3a4c" stroke="#4a5a6c"/>
    <circle cx="303" cy="86" r="7" fill="#1e2938"/>
    <rect x="34" y="196" width="120" height="8" rx="3" fill="#1c2735" opacity=".7"/>
    <ellipse cx="200" cy="226" rx="150" ry="14" fill="#080c12" opacity=".55"/>`,
  storage: () => `
    <rect width="${W}" height="${H}" fill="#0e1219"/>
    ${[46, 92, 138].map((y, r) => [60, 118, 176, 262].map((x, c) => `
      <rect x="${x}" y="${y}" width="52" height="44" fill="#1a2330" stroke="#2e3c4c" stroke-width="1.2"/>
      <path d="M${x + 12} ${y + 30} h28 M${x + 26} ${y + 12} v18" stroke="#141b25" stroke-width="3"/>`).join('')).join('')}
    <rect x="40" y="176" width="130" height="10" rx="3" fill="#232f3f"/>
    <rect x="52" y="186" width="8" height="16" fill="#1c2735"/><rect x="150" y="186" width="8" height="16" fill="#1c2735"/>
    <rect x="292" y="60" width="70" height="126" fill="#1a2432" stroke="#3a4a5e"/>
    ${[0, 1, 2].map((i) => `<rect x="298" y="${76 + i * 36}" width="58" height="8" rx="2" fill="#242f40"/>`).join('')}
    <circle cx="200" cy="26" r="7" fill="#e8c56a" opacity=".9"/>
    <circle cx="200" cy="26" r="34" fill="#e8c56a" opacity=".07"/>
    <ellipse cx="200" cy="224" rx="150" ry="14" fill="#080c12" opacity=".55"/>`,
  corridor: () => `
    <rect width="${W}" height="${H}" fill="#0c1016"/>
    <path d="M0 0 L120 60 L120 180 L0 240 Z" fill="#121926"/>
    <path d="M400 0 L280 60 L280 180 L400 240 Z" fill="#121926"/>
    <path d="M120 60 H280 V180 H120 Z" fill="#0e141d"/>
    <rect x="150" y="66" width="100" height="64" rx="3" fill="#1a2432" stroke="#4a5a6c" stroke-width="2"/>
    ${[0, 1, 2, 3].map((i) => `<rect x="${158 + i * 24}" y="${76}" width="16" height="30" rx="2" fill="#232f40"/>
      <rect x="${158 + i * 24}" y="${110}" width="16" height="12" rx="2" fill="${i === 0 ? '#c4574e' : '#2c3c4e'}"/>`).join('')}
    <path d="M130 150 H270" stroke="#1e2938" stroke-width="3"/>
    <line x1="150" y1="150" x2="150" y2="176" stroke="#1e2938" stroke-width="4"/>
    <path d="M143 176 h14 M150 176 v-10" stroke="#3a4a5e" stroke-width="2.5" fill="none"/>
    <rect x="86" y="120" width="10" height="52" fill="#242f40"/>
    <path d="M91 120 q-16 4 -12 20 l10 -4 Z" fill="#8a97a8" opacity=".5"/>
    <circle cx="200" cy="30" r="5" fill="#c4574e"/>
    <circle cx="200" cy="30" r="12" fill="#c4574e" opacity=".15"/>`,
};

function roomArtSVG(room) {
  const art = (ROOM_ART[room.art] || ROOM_ART.atrium)();
  const spots = room.hotspots.map((h) => {
    const isDrama = !!CASE.dramaPoints[h.id];
    const done = isDrama ? (state.dramasSeen && state.dramasSeen.includes(h.id)) : isCollected(h.id);
    const cx = (h.x / 100) * W, cy = (h.y / 100) * H;
    return `<g class="hotspot${done ? ' done' : ''}" data-hotspot="${h.id}"
        role="button" tabindex="0" aria-label="${h.label}${done ? '，已勘查' : ''}"
        transform="translate(${cx} ${cy})">
      <!-- 透明命中垫底：44px+ 触控标准，标签与圆点间空隙也可点 -->
      <circle class="hitpad" r="26" fill="transparent"/>
      <circle class="pulse" r="7" fill="#e8c56a" opacity=".8" pointer-events="none"/>
      <circle class="dot" r="5" fill="#e8c56a" stroke="#14100a" stroke-width="1.5"/>
      <rect class="hs-label" x="-46" y="-40" width="92" height="26" rx="5" fill="#0a0e14" stroke="#3a4a5e" opacity=".92"/>
      <text x="0" y="-23" text-anchor="middle" font-size="11" fill="#dce3ec">${h.label}</text>
    </g>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${art}${spots}
    <text x="${W - 10}" y="18" text-anchor="end" font-size="9" letter-spacing="2" fill="#5d7a95" opacity=".85" font-family="monospace">◉ CRIME SCENE · 雨夜画廊</text>
  </svg>`;
}

/* ============================================================
 * 第一幕：开场（15秒情景讲述 + 旁白同步 + 零日志AI引导）
 * ============================================================ */

let narrationTimer = null;
let narrationProgressTimer = null;

function updateIntroAICard() {
  const cardBadge = $('intro-ai-badge');
  if (!cardBadge) return;
  const desc = describeEndpoint();
  if (desc.startsWith('🎁') || desc.startsWith('🔑') || desc.startsWith('🧪')) {
    cardBadge.className = 'chip-badge ai-on';
    cardBadge.textContent = `已接入 ${desc}`;
  } else {
    cardBadge.className = 'chip-badge';
    cardBadge.textContent = '⚠ 未接入 AI（需要接入才能游玩）';
  }
}

function startNarrationStory() {
  audio.ensure();
  audio.startRain();
  audio.startBgm();
  scheduleThunder();

  const progressBar = $('narration-progress');
  const countdownEl = $('narration-countdown');
  const sub1 = $('sub-1');
  const sub2 = $('sub-2');
  const sub3 = $('sub-3');

  if (narrationTimer) clearInterval(narrationTimer);
  if (narrationProgressTimer) clearInterval(narrationProgressTimer);

  const TOTAL_DURATION = 14.5;
  const startTime = performance.now();

  function updateSubtitles(cur) {
    if (cur < 6.4) {
      if (sub1) sub1.className = 'sub-line active';
      if (sub2) sub2.className = 'sub-line';
      if (sub3) sub3.className = 'sub-line';
    } else if (cur < 9.8) {
      if (sub1) sub1.className = 'sub-line done';
      if (sub2) sub2.className = 'sub-line active';
      if (sub3) sub3.className = 'sub-line';
    } else if (cur < 13.2) {
      if (sub1) sub1.className = 'sub-line done';
      if (sub2) sub2.className = 'sub-line done';
      if (sub3) sub3.className = 'sub-line active';
    } else {
      if (sub1) sub1.className = 'sub-line done';
      if (sub2) sub2.className = 'sub-line done';
      if (sub3) sub3.className = 'sub-line done';
    }
  }

  // 播放开场旁白
  audio.playNarration('assets/audio/intro-narration.mp3', {
    onTimeUpdate: (cur) => {
      updateSubtitles(cur);
    },
    onEnded: () => {
      finishIntroNarration();
    },
  });

  narrationProgressTimer = setInterval(() => {
    const elapsed = (performance.now() - startTime) / 1000;
    const remain = Math.max(0, Math.ceil(TOTAL_DURATION - elapsed));
    if (countdownEl) countdownEl.textContent = `00:${remain.toString().padStart(2, '0')}`;
    const pct = Math.min(100, (elapsed / TOTAL_DURATION) * 100);
    if (progressBar) progressBar.style.width = `${pct}%`;

    updateSubtitles(elapsed);

    if (elapsed >= TOTAL_DURATION) {
      finishIntroNarration();
    }
  }, 100);
}

function finishIntroNarration() {
  audio.stopNarration(200);
  if (narrationTimer) { clearInterval(narrationTimer); narrationTimer = null; }
  if (narrationProgressTimer) { clearInterval(narrationProgressTimer); narrationProgressTimer = null; }

  const progressBar = $('narration-progress');
  const countdownEl = $('narration-countdown');
  if (progressBar) progressBar.style.width = '100%';
  if (countdownEl) countdownEl.textContent = '00:00';

  ['sub-1', 'sub-2', 'sub-3'].forEach((id) => {
    const el = $(id);
    if (el) el.className = 'sub-line done';
  });

  const introText = $('intro-text');
  if (introText) {
    introText.classList.remove('hidden');
    if (!introText.dataset.filled) {
      introText.dataset.filled = '1';
      introText.innerHTML = CASE.intro.map((p) => `<p class="intro-p">${p}</p>`).join('');
    }
  }

  $('intro-actions').classList.remove('hidden');

  // 开场叙事结束 → 首次玩家弹出上手引导（仅首次，跳过讲述路径同样覆盖）
  setTimeout(maybeShowGuide, 800);
}

/* ============================================================
 * 首次上手引导（玩法三步 + AI 接入 + 小手点击指引）
 * ============================================================ */

function wasGuided() {
  return storage.getItem(GUIDE_KEY) === '1';
}
function markGuided() {
  storage.setItem(GUIDE_KEY, '1');
}

function maybeShowGuide() {
  if (wasGuided()) return;
  showGuide();
}

function showGuide() {
  const modal = $('modal-guide');
  if (!modal) return;
  modal.classList.remove('hidden');
  // v3.2 · AI 已可用(免费通道或自填 Key)时直接跳到第 3 步
  const aiReady = aiActive();
  gotoGuideStep(aiReady ? 3 : 1);
}

function gotoGuideStep(n) {
  const modal = $('modal-guide');
  if (!modal) return;
  [1, 2, 3].forEach((i) => {
    const el = $(`guide-step-${i}`);
    if (el) el.classList.toggle('hidden', i !== n);
    const dot = $(`guide-dot-${i}`);
    if (dot) dot.classList.toggle('on', i <= n);
  });
  const prev = $('btn-guide-prev');
  const next = $('btn-guide-next');
  const goConfig = $('btn-guide-go-config');
  const skip = $('btn-guide-skip');
  // v3.2 · 「已接入」= 免费通道可用或自填 Key
  const aiReady = aiActive();
  if (prev) prev.classList.toggle('hidden', n === 1);
  if (next) next.classList.toggle('hidden', n === 3);
  if (goConfig) goConfig.classList.toggle('hidden', n !== 3 || aiReady);
  if (skip) {
    // v3.2 · 本作仅 AI 模式：未接入时按钮改为去配置
    skip.textContent = n === 3
      ? (aiReady ? '🚪 开始调查' : '⚙️ 去接入 AI（必需）')
      : '跳过引导';
  }
  // 第 2 步动态内容：是否已接入 AI
  const aiState = $('guide-ai-state');
  if (aiState) {
    if (aiReady) {
      aiState.innerHTML = `<div class="guide-ai-on">✓ AI 已就绪（${describeEndpoint()}）——迎接你的将是实时扮演、实时决策的嫌疑人，结案后还会生成 AI 能力侧写报告。</div>`;
    } else {
      aiState.innerHTML = '<div class="guide-ai-off">⚠ 尚未接入 AI。本作仅支持 AI 模式——请先配置免费通道或自定义 Key，否则无法开始调查。</div>';
    }
  }
}

/* ---------- 小手动态点击指引 ---------- */

let handTarget = null;   // 当前指向的元素
let handIntent = '';     // 'config' = 正在进行接入引导链路

/** 检测目标是否被某个可滚动祖先（如弹窗卡片）裁剪 */
function clippedByScrollAncestor(el) {
  let p = el.parentElement;
  while (p) {
    const cs = getComputedStyle(p);
    if (/(auto|scroll)/.test(cs.overflowY)) {
      const pr = p.getBoundingClientRect();
      const er = el.getBoundingClientRect();
      return er.top < pr.top || er.bottom > pr.bottom;
    }
    p = p.parentElement;
  }
  return false;
}

/** 同步重算小手位置（scroll/resize 事件驱动，不依赖 rAF，避免节流环境下漂移） */
function updateHandPosition() {
  const hand = $('guide-hand');
  if (!hand || !handTarget || hand.classList.contains('hidden')) return;
  const r = handTarget.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) { hideHand(); return; } // 目标被隐藏（如弹窗已关）
  // 小手悬于目标上方中央，指尖朝下点向按钮
  hand.style.left = `${Math.round(r.left + r.width / 2 - 15)}px`;
  hand.style.top = `${Math.round(r.top - 34)}px`;
}

function pointHandAt(el) {
  const hand = $('guide-hand');
  if (!hand || !el) return;
  handTarget = el;
  hand.classList.remove('hidden');
  // 目标不在视口内 / 被滚动容器裁剪 → 瞬时滚到可见位置
  // （不用 smooth：滚动动画期间小手会定位在旧坐标，视觉上"漂移/消失"）
  const r0 = el.getBoundingClientRect();
  if (r0.top < 70 || r0.bottom > window.innerHeight - 10 || clippedByScrollAncestor(el)) {
    el.scrollIntoView({ behavior: 'auto', block: 'center' });
  }
  updateHandPosition();
  // 事件驱动跟随：页面滚动 / 弹窗内滚动（capture 捕获）/ 窗口尺寸变化
  if (!hand._bound) {
    window.addEventListener('scroll', updateHandPosition, true);
    window.addEventListener('resize', updateHandPosition);
    hand._bound = true;
  }
}

function hideHand() {
  const hand = $('guide-hand');
  if (hand) hand.classList.add('hidden');
  handTarget = null;
}

/** 引导第 3 步「现在去配置」→ 指向开场页 AI 卡片的接入按钮 */
function startGuideConfigFlow() {
  markGuided();
  const modal = $('modal-guide');
  if (modal) modal.classList.add('hidden');
  handIntent = 'config';
  const target = $('btn-intro-config-ai') || $('btn-settings');
  if (target) pointHandAt(target);
}

function setupIntroGateway(hasSave) {
  // 先判定可续玩：以存档 phase 快照为准（封面 showPhase 会改写 state.phase 为 intro）
  const resumable = hasSave && state.resumePhase && state.resumePhase !== 'intro';
  const resumePhase = state.resumePhase || state.phase;
  showPhase('intro', { silent: true }); // 封面仅为展示，不覆盖进行中的存档 phase
  updateIntroAICard();

  const coverActions = $('intro-cover-actions');
  const narrationContainer = $('narration-container');
  const introText = $('intro-text');
  const introActions = $('intro-actions');

  if (coverActions) coverActions.classList.remove('hidden');
  if (narrationContainer) narrationContainer.classList.add('hidden');
  if (introText) introText.classList.add('hidden');
  if (introActions) introActions.classList.add('hidden');

  if (resumable) {
    const saveActions = $('cover-save-actions');
    if (saveActions) {
      saveActions.classList.remove('hidden');
      const descEl = $('resume-phase-desc');
      if (descEl) descEl.textContent = `${PHASE_LABELS[resumePhase] || '进行中'} · 线索 ${state.found.length}/11`;
    }
  }
}

async function runIntro() {
  setupIntroGateway(false);
}

/* ============================================================
 * 第二幕：现场调查
 * ============================================================ */

function isCollected(id) { return state.found.includes(id); }

/* ---------- v3.0 · 剩余可收集判定（被销毁物证的热点自动隐藏） ---------- */
function isLostEvidence(id) { return (state.lostEvidence || []).includes(id); }

function enterRoom(roomId) {
  state.currentRoom = roomId;
  ensureStats().roomVisits[roomId] = (ensureStats().roomVisits[roomId] || 0) + 1;
  const room = CASE.rooms.find((r) => r.id === roomId);
  const head = $('room-head');
  if (head) {
    head.classList.remove('room-head-fade');
    void head.offsetWidth;
    head.classList.add('room-head-fade');
  }
  $('room-name').textContent = `${room.icon} ${room.name}`;
  $('room-desc').textContent = room.desc;
  const art = $('room-art');
  // v3.0 · 已销毁物证（如照片被删）不再渲染热点/标签
  const liveHotspots = room.hotspots.filter((h) => !isLostEvidence(h.id));
  const art2 = { ...room, hotspots: liveHotspots };
  art.innerHTML = roomArtSVG(art2);
  // 房间切换过渡：重触发 fadein 动画
  art.classList.remove('room-fade');
  void art.offsetWidth;
  art.classList.add('room-fade');
  art.querySelectorAll('.hotspot').forEach((el) => {
    el.addEventListener('click', () => onHotspot(el.dataset.hotspot));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onHotspot(el.dataset.hotspot); }
    });
  });
  $('hotspot-hints').innerHTML = liveHotspots.map((h) => {
    const isDrama = !!CASE.dramaPoints[h.id];
    const done = isDrama ? (state.dramasSeen && state.dramasSeen.includes(h.id)) : isCollected(h.id);
    return `<span class="hotspot-tag${done ? ' done' : ''}" data-hotspot="${h.id}"
      role="button" tabindex="0" aria-label="${done ? '已勘查' : '勘查'}：${h.label}">${h.label}</span>`;
  }).join('');
  $('hotspot-hints').querySelectorAll('.hotspot-tag').forEach((el) => {
    el.addEventListener('click', () => onHotspot(el.dataset.hotspot));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); onHotspot(el.dataset.hotspot); }
    });
  });
  renderMap();
  save();
}

function onHotspot(id) {
  ensureStats().hotspotClicks++;
  if (CASE.dramaPoints[id]) {
    const d = CASE.dramaPoints[id];
    if (!state.dramasSeen) state.dramasSeen = [];
    if (!state.dramasSeen.includes(id)) {
      state.dramasSeen.push(id);
      enterRoom(state.currentRoom);
    } else {
      ensureStats().repeatViews++;
    }
    const art = id === 'zhou' ? avatarSVG({ id: 'zhou', name: '守夜人老周' }, 'unconscious', { size: 96 }) : null;
    openEvidenceModal(d.name, d.found, null, null, art);
    audio.click();
    save();
    return;
  }
  const ev = CASE.evidences.find((e) => e.id === id);
  if (!ev) return;
  if (isCollected(id)) {
    ensureStats().repeatViews++;
    audio.click(); // 重复查看也有点击反馈
    openEvidenceModal(`${ev.icon} ${ev.name}`, ev.found, ev.detail, ev);
  } else {
    state.found.push(id);
    ensureStats().evidenceOrder.push(id);
    audio.discover();
    openEvidenceModal(`${ev.icon} 发现物证：${ev.name}`, ev.found, ev.detail, ev);
    updateNotebookCount();
    enterRoom(state.currentRoom); // 刷新热点状态
  }
  save();
}

function openEvidenceModal(title, found, detail, ev, customArt = null) {  $('evidence-title').innerHTML = title;
  let implicate = '';
  if (ev && ev.implicates) {
    const s = CASE.suspects.find((x) => x.id === ev.implicates);
    implicate = `<p class="implicate">→ 侦探直觉：这条线索与 <b>${s.name}</b> 的说法存在出入。</p>`;
  }
  $('evidence-body').innerHTML = `
    ${customArt ? `<div class="evidence-art-wrap" style="text-align:center;margin-bottom:14px;">${customArt}</div>` : ''}
    <div class="big">${found}</div>
    ${detail ? `<div class="detail">🔎 ${detail}</div>` : ''}
    ${implicate}`;
  $('modal-evidence').classList.remove('hidden');
}

function updateNotebookCount() {
  $('notebook-count').textContent = `${state.found.length}/${CASE.evidences.length}`;
}

function renderNotebook() {
  const list = $('notebook-list');
  if (!state.found.length) {
    list.innerHTML = '<p class="notebook-empty">线索册空空如也。去房间里点一点那些发亮的角落。</p>';
    return;
  }
  list.innerHTML = state.found.map((id) => {
    const e = CASE.evidences.find((x) => x.id === id);
    return `<div class="note-item">
      <div class="nt">${e.icon} ${e.name}${e.key ? '<span class="key-mark">关键</span>' : ''}</div>
      <div class="nb">${e.detail}</div>
    </div>`;
  }).join('');
}

/* ============================================================
 * 第三幕：审讯
 * ============================================================ */

const suspectById = (id) => CASE.suspects.find((s) => s.id === id);
const evidenceById = (id) => CASE.evidences.find((e) => e.id === id);
const MOOD_TEXT = { calm: '🛡 镇定', shaken: '🌀 动摇', broken: '💥 防线崩溃' };

/* ---------- v3.0 · 三维关系数值条（卡片 + 审讯头部实时可见） ----------
 * 规范 §5：350ms 缓动 / 压力 >80% 震颤红光 / 信任达阈脉冲 / 敌意告警橙边 */
const trustPulsePlayed = new Set(); // 信任脉冲每局只播一次，避免列表重绘反复闪动

function relBarsHTML(st) {
  const p = Math.min(100, (st.pressure / 8) * 100);
  const t = st.trust, h = st.hostility;
  const criticalCls = p >= 80 ? ' critical' : '';
  const alarmCls = h >= 70 ? ' alarm' : '';
  // 信任 ≥60 视为「即将松口」，首次跨过阈值时播放一次脉冲光环
  let unlockCls = '';
  if (t >= 60) {
    const key = `${st.id || 'x'}:trust`;
    if (!trustPulsePlayed.has(key)) { trustPulsePlayed.add(key); unlockCls = ' unlock'; }
    else unlockCls = ' unlock-held';
  }
  return `<div class="rel-bars" role="group" aria-label="嫌疑人关系数值">
    <span class="rel-row${criticalCls}" title="压力：被戳穿的次数（规则驱动）"><i class="rl">📊压力</i><span class="rel-track" role="progressbar" aria-label="压力" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(p)}"><span class="rel-fill pressure" style="width:${Math.min(100, p)}%"></span></span></span>
    <span class="rel-row${unlockCls}" title="信任：AI 决策驱动（±2/轮 钳制）"><i class="rl">🤝信任</i><span class="rel-track" role="progressbar" aria-label="信任" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${t}"><span class="rel-fill trust" style="width:${t}%"></span></span></span>
    <span class="rel-row${alarmCls}" title="敌意：AI 决策驱动（±2/轮 钳制）"><i class="rl">⚔敌意</i><span class="rel-track" role="progressbar" aria-label="敌意" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${h}"><span class="rel-fill hostility" style="width:${h}%"></span></span></span>
  </div>`;
}

function renderSuspectList() {
  $('suspect-list').innerHTML = CASE.suspects.map((s) => {
    const st = state.suspects.get(s.id);
    const mood = stageOf(st);
    const active = state.activeSuspect === s.id ? ' active' : '';
    const locked = st.lawyerLock ? ' locked' : '';
    return `<button class="suspect-card${active}${locked}" data-suspect="${s.id}" ${st.lawyerLock ? 'title="律师到场，拒绝问话"' : ''} aria-pressed="${state.activeSuspect === s.id}" aria-label="审问 ${s.name}，${s.role}，当前状态${MOOD_TEXT[mood]}">
      <span class="avatar">${avatarSVG(s, mood, { size: 46 })}</span>
      <span class="meta">
        <span class="nm">${s.name}${st.lawyerLock ? ' ⚖️ 拒审' : ''}</span>
        <span class="rl">${s.role} · ${s.age}岁</span><br>
        <span class="mood ${mood}">${MOOD_TEXT[mood]}</span>
        ${relBarsHTML(st)}
      </span>
    </button>`;
  }).join('');
  $('suspect-list').querySelectorAll('.suspect-card').forEach((el) => {
    el.addEventListener('click', () => selectSuspect(el.dataset.suspect));
  });
}

function knownEvidences() {
  return state.found.map((id) => CASE.evidences.find((e) => e.id === id)).filter(Boolean);
}

/* ============================================================
 * v3.0 · AI NPC 行动执行上下文（由 suspect-ai.js 规则层回调）
 * ============================================================ */

const npcCtx = {
  /** 解锁物证（苏晓交照片）：直接进线索册 + toast 播报 */
  unlockEvidence(evId) {
    if (isCollected(evId)) return;
    const ev = CASE.evidences.find((e) => e.id === evId);
    if (!ev) return;
    state.found.push(evId);
    ensureStats().evidenceOrder.push(evId);
    updateNotebookCount();
    toast(`🎁 新物证入册：《${ev.name}》——嫌疑人主动提供的`, 4000);
    save();
  },
  /** 永久丢失物证（苏晓删照）：从线索册移除 + 场景热点隐藏 */
  loseEvidence(evId) {
    state.lostEvidence = state.lostEvidence || [];
    if (!state.lostEvidence.includes(evId)) state.lostEvidence.push(evId);
    const i = state.found.indexOf(evId);
    if (i >= 0) state.found.splice(i, 1); // 已收集的也被销毁
    const j = state.chosenEvidence.indexOf(evId);
    if (j >= 0) state.chosenEvidence.splice(j, 1);
    if (state.activeSuspect === 'suxiao' && state.phase === 'interrogate') {
      enterRoom(state.currentRoom);
      renderAccuse();
    }
    toast('⚠ 关键物证被销毁——这条线索本局找不回来了', 4200);
    save();
  },
  /** 律师锁（林曼青） */
  onLawyerLock() {
    const st = state.suspects.get('linmanqing');
    if (st) st.lawyerLock = true;
    if (state.phase === 'interrogate') {
      renderSuspectList();
      if (state.activeSuspect === 'linmanqing') {
        addBubble('system', '⚖️ 林曼青的律师已到场——她依法拒绝继续问话。这条审讯线锁死了。（换个嫌疑人，或去现场找更多物证）');
      }
    }
    save();
  },
  /** 主动交代（林曼青）：线索册批注 + 排除嫌疑提示 */
  onVolunteer() {
    state.volunteerNoted = true;
    toast('🤝 林曼青主动交代了卖画计划——她的动机清楚了', 4000);
    save();
  },
  /** 甩锅（陈默 → 苏晓压力 +1，敌意 +1） */
  onShiftBlame() {
    const sx = state.suspects.get('suxiao');
    if (sx) {
      sx.pressure += 1; // 与行动气泡文案一致：她被卷进旋涡
      applyRel(sx, -1, 1, '被陈默祸水东引');
    }
    if (state.phase === 'interrogate') renderSuspectList();
    save();
  },
  /** 储物间抉择：弹 noir 风格确认弹窗 */
  async onRequestStorage() {
    const ok = await gameConfirm(
      '陈默想去储物间「看一眼自己的柜子」。\n放行——他会有一分钟独处（你听到储物间传来窸窣声）；\n拒绝——保持审讯节奏，但他会记恨这个决定。',
      { title: '审讯抉择 🚪', okText: '放行（有风险）', cancelText: '拒绝（敌意+2）' },
    );
    const st = state.suspects.get('chenmo');
    if (ok) {
      // 靴子物证被弱化：若未收集，改为「被擦净」版本；已收集则不受影响
      const boots = CASE.evidences.find((e) => e.id === 'boots');
      if (boots && !isCollected('boots')) {
        boots.weakened = true;
        addBubble('system', '🚪 陈默回来时神色松弛了些。事后你会知道——鞋柜里那双靴子，泥被擦得干干净净。（《鞋柜里的靴子》物证文本已弱化）');
      }
    } else if (st) {
      applyRel(st, 0, 2, '请求去储物间被拒');
      addBubble('system', '你拒绝了他。陈默抿紧了嘴，眼里的抵触又深了一层。（敌意 +2）');
      renderSuspectList();
    }
    save();
  },
  getSuspect(id) { return state.suspects.get(id); },
};

setActionContext(npcCtx);

function selectSuspect(id, force = false) {
  if (state.activeSuspect === id && !force) return;
  const s = suspectById(id);
  const st = state.suspects.get(id);
  const mood = stageOf(st);

  // v3.0 · 律师锁：林曼青叫了律师后无法再选她
  if (st.lawyerLock) {
    toast('⚖️ 林曼青的律师在场——她依法拒绝问话。去审别人，或回现场补充物证。');
    return;
  }

  state.activeSuspect = id;
  audio.suspect();
  renderSuspectList();

  const modeText = describeEndpoint();
  const isAI = modeText.startsWith('🎁') || modeText.startsWith('🔑') || modeText.startsWith('🧪');
  $('dialog-head').innerHTML = `
    <span class="avatar avatar-dialog mood-${mood}${mood === 'broken' ? ' tension-heartbeat' : ''}">${avatarSVG(s, mood, { size: 54 })}</span>
    <span class="who">
      <div class="nm">${s.name}</div>
      <div class="rl">${s.oneLine}</div>
      ${relBarsHTML(st)}
    </span>
    <span class="mode-tag ${isAI ? 'ai' : 'local'}">${modeText}</span>`;
  const stream = $('dialog-stream');
  stream.innerHTML = '';
  addBubble('system', `—— 审讯室 · ${s.name}（${s.role}）——`);
  addBubble('system', `对外口径：${s.publicStory}`);
  if (st.confessed) addBubble('system', '（此人已完整坦白）');
  addBubble('suspect', greetingOf(s, st), s.color);
  renderSuggestQuestions();
}

function addBubble(kind, text, color) {
  const stream = $('dialog-stream');
  const div = document.createElement('div');
  div.className = `bubble ${kind}`;
  if (kind === 'suspect' && color) div.style.borderLeftColor = color;
  div.textContent = text;
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  return div;
}

/* 嫌疑人"思考中"气泡:推理模型思维链阶段(约 3~9s)不干等,
 * 轮换显示人设化的斟酌话术,让等待有叙事感 */
const THINKING_LINES = [
  '（他在斟酌措辞）',
  '（指尖轻敲桌面，没接话）',
  '（目光移开，像在算什么）',
  '（沉默，指节收紧了）',
];
let thinkingTimer = null;
let thinkingIdx = 0;
function showTyping() {
  const stream = $('dialog-stream');
  const div = document.createElement('div');
  div.className = 'bubble suspect typing';
  div.id = 'typing-bubble';
  div.innerHTML = '<i></i><i></i><i></i>';
  stream.appendChild(div);
  stream.scrollTop = stream.scrollHeight;
  // 1.6s 后开始轮换斟酌话术(首个 chunk 到达即被 hideTyping 清掉)
  clearInterval(thinkingTimer);
  thinkingIdx = 0;
  thinkingTimer = setInterval(() => {
    const t = $('typing-bubble');
    if (!t) { clearInterval(thinkingTimer); return; }
    t.innerHTML = `<span class="think-line">${THINKING_LINES[thinkingIdx % THINKING_LINES.length]}</span>`;
    thinkingIdx++;
    stream.scrollTop = stream.scrollHeight;
  }, 1600);
}
function hideTyping() {
  clearInterval(thinkingTimer);
  const t = $('typing-bubble');
  if (t) t.remove();
}

let busy = false;
let lastQuestion = '';

/* ---------- v3.7 · 求助系统（旁白顾问给方向，不给问句） ---------- */

/**
 * 渲染求助入口。取代原先的「建议提问」chip——
 * 那套把最优提问原文填进输入框，推理乐趣归零。
 * 这里只给一个按钮，点开后向 AI 要一个**方向**，
 * 玩家必须自己把方向翻译成问句。
 */
function renderSuggestQuestions() {
  const box = $('suggest-questions');
  if (!box || !state.activeSuspect) return;
  const used = state.stats ? state.stats.hintsUsed : 0;
  const left = hintsLeft(used);
  if (left <= 0) {
    box.innerHTML = '<span class="sq-label">🧭 求助次数已用完——剩下的，靠你自己了。</span>';
    return;
  }
  box.innerHTML = `<button class="hint-btn" id="btn-hint">🧭 求助（剩 ${left}/${HINT_LIMIT} 次）</button>`
    + '<span class="sq-label">旁白只点方向，不替你发问；每次求助将在结案评分中扣 2 分。</span>';
  const btn = $('btn-hint');
  if (btn) btn.addEventListener('click', onHintRequest);
}

/** 点击求助：向 AI 要一个方向，以旁白气泡呈现（不自动填输入框） */
async function onHintRequest() {
  const btn = $('btn-hint');
  if (btn) btn.disabled = true;
  if (state.stats) state.stats.hintsUsed += 1;
  const used = state.stats ? state.stats.hintsUsed : 1;
  const box = $('suggest-questions');
  if (box) box.innerHTML = '<span class="sq-label">⏳ 旁白在观察……</span>';

  const s = suspectById(state.activeSuspect);
  const st = state.suspects.get(state.activeSuspect);
  const known = state.found.map((id) => evidenceById(id)).filter(Boolean);
  let out;
  try {
    out = await requestHint(s, st, known, used);
  } catch (e) {
    out = { text: fallbackHint(), source: 'fallback', left: hintsLeft(used) - 1 };
  }
  appendHintBubble(out, used);
  renderSuggestQuestions();
  // hintsUsed 是评分输入（computeScore 读它算 hintPenalty），
  // 必须落盘——否则刷新页面后 3 次额度重置，且已扣过的分凭空消失。
  save();
}

/** 旁白气泡：独立的视觉样式，与嫌疑人/系统气泡区分开 */
function appendHintBubble(out, used) {
  const stream = $('dialog-stream');
  if (!stream) return;
  const wrap = document.createElement('div');
  wrap.className = 'bubble hint';
  const tag = document.createElement('span');
  tag.className = 'hint-tag';
  tag.textContent = '🧭 旁白';
  const body = document.createElement('span');
  body.className = 'hint-body';
  body.textContent = out.text;                      // textContent：旁白内容一律不走 innerHTML
  const note = document.createElement('span');
  note.className = 'hint-fallback';
  note.textContent = out.source === 'fallback' ? '（离线旁白）' : '';
  wrap.append(tag, body, note);
  stream.appendChild(wrap);
  stream.scrollTop = stream.scrollHeight;
  audio.discover();
  logDecisionForHint(out, used);
}

/** 写进 NPC 决策日志（applyRel 的 note 字段），让终幕叙事也能看到求助行为 */
function logDecisionForHint(out, used) {
  const st = state.suspects.get(state.activeSuspect);
  if (!st) return;
  applyRel(st, 0, 0, `求助旁白（第 ${used} 次，${out.source}）`);
}


async function sendQuestion(isRetry = false) {
  if (busy || !state.activeSuspect) return;
  if (state.suspects.get(state.activeSuspect).lawyerLock) {
    toast('⚖️ 她的律师在场，拒绝回答任何问题。');
    return;
  }
  const input = $('dialog-input');
  let q = input.value.trim();
  if (!q) {
    if (isRetry && lastQuestion) q = lastQuestion; // 重试:重发上一条提问
    else return;
  }
  input.value = '';
  lastQuestion = q;
  busy = true;
  // 行为痕迹：提问分布与重复提问
  const stats = ensureStats();
  stats.questionsPerSuspect[state.activeSuspect] = (stats.questionsPerSuspect[state.activeSuspect] || 0) + 1;
  const nq = normQuestion(q);
  if (nq && stats.recentQuestions.includes(nq)) stats.repeatQuestions++;
  stats.recentQuestions.push(nq);
  if (stats.recentQuestions.length > 8) stats.recentQuestions.shift();
  const s = suspectById(state.activeSuspect);
  const st = state.suspects.get(s.id);
  addBubble('player', `🧐 ${q}`);
  showTyping();
  // v3.0 · 流式显示:创建一个流式气泡承接增量字符(推理模型思维链在服务端剥离,首字更快)
  let streamBubble = null;
  let streamBuf = '';
  const onStream = (piece, full) => {
    streamBuf = full;
    if (!streamBubble) {
      streamBubble = document.createElement('div');
      streamBubble.className = 'bubble suspect streaming';
      streamBubble.style.borderLeftColor = s.color || '';
      $('dialog-stream').appendChild(streamBubble);
    }
    streamBubble.textContent = full;
    const stream = $('dialog-stream');
    stream.scrollTop = stream.scrollHeight;
  };
  try {
    const res = await askSuspect(s, st, q, knownEvidences(), { onStream });
    hideTyping();
    // 流式气泡退场(最终以解析后的 reply 为准重绘,避免把 JSON 残留展示给玩家)
    if (streamBubble) { streamBubble.remove(); streamBubble = null; }
    if (res.note) addBubble('system', `⚠ ${res.note}`);
    // v3.0 · AI 裁判命中（与关键词命中并集，共同保证进度下限）
    if (res.judgeHit) {
      const idx = Number(res.judgeHit.tag.split(':')[1]);
      const point = s.keywordHits[idx] && s.keywordHits[idx].point;
      addBubble('crack', `💥 他的神色变了——你点破了：${point || res.judgeHit.reason}`);
      audio.crack();
      triggerStrike();
    }
    // v3.0 · NPC 行动播报（物证解锁/销毁、律师、甩锅、储物间）
    if (res.actionNote) addBubble('action', res.actionNote);
    if (res.cracked) { audio.crack(); triggerStrike(); } else { audio.click(); }
    addBubble('suspect', res.text, s.color);
    if (res.cracked) {
      state.crackCount++;
      const mood = stageOf(st);
      if (mood === 'broken' && !st.confessed) {
        addBubble('system', `【${s.name} 的心理防线已崩溃——继续追问让他吐露实情】`);
      } else if (mood === 'shaken') {
        addBubble('system', `【${s.name} 开始动摇了】`);
      }
    }
    state.askedTotal++;
    renderSuspectList();
    refreshDialogHeadRel(s, st);
    renderSuggestQuestions();
    save();
  } catch (err) {
    hideTyping();
    if (streamBubble) { streamBubble.remove(); streamBubble = null; } // 失败时清理流式气泡
    console.error('[sendQuestion]', err);
    // v3.2 · 仅 AI 模式：通道不可用则阻断提示（无本地回退），重试即重发上一条提问
    const msg = (err && err.message) || 'AI 通道不可用';
    if ((err && err.code) === 'AI_UNAVAILABLE') {
      showAiBlockedModal(msg, () => sendQuestion(true));
    } else {
      addBubble('system', `⚠ ${msg}——请重试`);
    }
  } finally {
    busy = false;
  }
}

/** 审讯头部三维条即时刷新（不动头像） */
function refreshDialogHeadRel(s, st) {
  const wrap = $('dialog-head').querySelector('.rel-bars');
  if (wrap) {
    const tmp = document.createElement('div');
    tmp.innerHTML = relBarsHTML(st);
    wrap.replaceWith(tmp.firstElementChild);
  }
}

/* ---------- v3.2 · AI 通道阻断提示（游戏仅支持 AI，无离线回退） ---------- */
let aiBlockedRetry = null;
function showAiBlockedModal(detail, retryFn) {
  const modal = $('modal-ai-blocked');
  aiBlockedRetry = typeof retryFn === 'function' ? retryFn : null;
  if (!modal) { toast('🤖 AI 通道不可用:' + detail, 5000); return; }
  const d = $('ai-blocked-detail');
  if (d) d.textContent = detail || '未知原因';
  modal.classList.remove('hidden');
}

function openPresentModal() {
  if (!state.activeSuspect) { toast('先选择一名嫌疑人'); return; }
  if (!state.found.length) { toast('你还没有收集到任何物证'); return; }
  const list = $('present-list');
  list.innerHTML = state.found.map((id) => {
    const e = CASE.evidences.find((x) => x.id === id);
    return `<button class="present-item" data-ev="${id}">
      <span class="ic">${e.icon}</span><span>${e.name}</span></button>`;
  }).join('');
  list.querySelectorAll('.present-item').forEach((el) => {
    el.addEventListener('click', () => {
      audio.click();
      $('modal-present').classList.add('hidden');
      doPresent(el.dataset.ev);
    });
  });
  $('modal-present').classList.remove('hidden');
}

async function doPresent(evidenceId) {
  if (busy || !state.activeSuspect) return;
  const lockSt = state.suspects.get(state.activeSuspect);
  if (lockSt.lawyerLock) { toast('⚖️ 她的律师在场，拒绝查看任何物证。'); return; }
  busy = true;
  // 行为痕迹：出示物证总量与去重
  const stats = ensureStats();
  stats.presentsTotal++;
  if (!stats.presentedIds.includes(evidenceId)) {
    stats.presentedIds.push(evidenceId);
    stats.presentsUnique++;
  }
  const s = suspectById(state.activeSuspect);
  const st = state.suspects.get(s.id);
  const e = CASE.evidences.find((x) => x.id === evidenceId);
  addBubble('player', `🔍【出示物证】${e.icon} ${e.name}`);
  showTyping();
  try {
    const res = await presentToSuspect(s, st, e, knownEvidences());
    hideTyping();
    if (res.note) addBubble('system', `⚠ ${res.note}`);
    if (res.actionNote) addBubble('action', res.actionNote); // v3.0 · 出示触发行动（如苏晓看到手机后删照）
    audio.crack();
    if (res.cracked) triggerStrike();
    addBubble('suspect', res.text, s.color);
    if (res.cracked) state.crackCount++;
    const mood = stageOf(st);
    if (mood === 'broken' && !st.confessed) {
      addBubble('system', `【${s.name} 的心理防线已崩溃——继续追问让他吐露实情】`);
    }
    renderSuspectList();
    refreshDialogHeadRel(s, st);
    const curMood = stageOf(st);
    const headAvatar = $('dialog-head').querySelector('.avatar');
    if (headAvatar) {
      headAvatar.className = `avatar avatar-dialog mood-${curMood}${curMood === 'broken' ? ' tension-heartbeat' : ''}`;
      headAvatar.innerHTML = avatarSVG(s, curMood, { size: 54 });
    }
    renderSuggestQuestions();
    save();
  } catch (err) {
    hideTyping();
    console.error('[doPresent]', err);
    // v3.2 · 仅 AI 模式：通道不可用则阻断提示（无本地回退）
    const msg = (err && err.message) || 'AI 通道不可用';
    if ((err && err.code) === 'AI_UNAVAILABLE') {
      showAiBlockedModal(msg, () => doPresent(evidenceId));
    } else {
      addBubble('system', `⚠ ${msg}——请重试`);
    }
  } finally {
    busy = false;
  }
}

/* ============================================================
 * 第四幕：指认
 * ============================================================ */

function renderAccuse() {
  const box = $('accuse-suspects');
  box.innerHTML = CASE.suspects.map((s) => `
    <div class="accuse-card${state.accused === s.id ? ' selected' : ''}" data-suspect="${s.id}"
      role="radio" tabindex="0" aria-checked="${state.accused === s.id}"
      aria-label="指认 ${s.name}（${s.role}）">
      <div class="avatar">${avatarSVG(s, 'calm', { size: 68 })}</div>
      <div class="nm">${s.name}</div>
      <div class="rl">${s.role}</div>
    </div>`).join('');
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', '选择要指认的嫌疑人');
  const chooseSuspect = (el) => {
    audio.click();
    state.accused = el.dataset.suspect;
    box.querySelectorAll('.accuse-card').forEach((c) => {
      c.classList.remove('selected');
      c.setAttribute('aria-checked', 'false');
    });
    el.classList.add('selected');
    el.setAttribute('aria-checked', 'true');
    updateAccuseSubmit();
  };
  box.querySelectorAll('.accuse-card').forEach((el) => {
    el.addEventListener('click', () => chooseSuspect(el));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); chooseSuspect(el); }
    });
  });

  const evBox = $('accuse-evidences');
  if (!state.found.length) {
    evBox.innerHTML = '<p class="notebook-empty">（你没有收集到任何物证——空手指认也可以，但你真的要这样吗？）</p>';
  } else {
    evBox.innerHTML = state.found.map((id) => {
      const e = CASE.evidences.find((x) => x.id === id);
      const checked = state.chosenEvidence.includes(id);
      return `<div class="evidence-check${checked ? ' checked' : ''}" data-ev="${id}"
        role="checkbox" tabindex="0" aria-checked="${checked}" aria-label="作为定罪证据：${e.name}">
        <span class="box" aria-hidden="true"></span><span>${e.icon} ${e.name}</span></div>`;
    }).join('');
    const toggleEvidence = (el) => {
      audio.click();
      const id = el.dataset.ev;
      const i = state.chosenEvidence.indexOf(id);
      if (i >= 0) {
        state.chosenEvidence.splice(i, 1);
        el.classList.remove('checked');
        el.setAttribute('aria-checked', 'false');
      } else {
        state.chosenEvidence.push(id);
        el.classList.add('checked');
        el.setAttribute('aria-checked', 'true');
      }
    };
    evBox.querySelectorAll('.evidence-check').forEach((el) => {
      el.addEventListener('click', () => toggleEvidence(el));
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); toggleEvidence(el); }
      });
    });
  }
  updateAccuseSubmit();
}

function updateAccuseSubmit() {
  $('btn-accuse-submit').disabled = !state.accused;
}

/* ============================================================
 * 终幕：结案与评分
 * ============================================================ */

function computeScore(juryCorrect) {
  const t = CASE.truth;
  const culpritOk = state.accused === t.culprit;
  const keyHits = t.keyEvidenceIds.filter((id) => state.chosenEvidence.includes(id)).length;
  const investigate = Math.round((state.found.length / CASE.evidences.length) * 12);
  const interrogation = Math.min(12, state.crackCount * 2);
  const evidenceScore = Math.min(36, keyHits * 6);
  // 求助惩罚：每次 -2、封顶 -6。只从总分扣，不推翻单项分——
  // 玩家即使求助了，前面的实打实进展仍算数。
  // 纯函数：只读 state.stats.hintsUsed（会落盘），续玩档可重算。
  const hints = (state.stats && state.stats.hintsUsed) || 0;
  const hintCut = hintPenalty(hints);
  const total = Math.max(0, (culpritOk ? 40 : 0) + evidenceScore + investigate + interrogation - hintCut);
  const rank = CASE.scoring.ranks.find((r) => total >= r.min) || CASE.scoring.ranks[CASE.scoring.ranks.length - 1];
  return { culpritOk, keyHits, evidenceScore, investigate, interrogation, hintCut, hintsUsed: hints, total, rank };
}

function renderScore(sc) {
  const box = $('score-box');
  box.classList.remove('hidden');
  const hintRow = sc.hintCut
    ? `<div class="score-row score-row-penalty"><span>旁白求助（${sc.hintsUsed} 次）</span><b>-${sc.hintCut}</b></div>`
    : '';
  box.innerHTML = `
    <div class="score-rank">${sc.rank.label}</div>
    <div class="score-rank-desc">${sc.rank.desc}</div>
    <div class="score-row"><span>凶手指认（${sc.culpritOk ? '✓ 正确' : '✗ 错误'}）</span><b>${sc.culpritOk ? 40 : 0} / 40</b></div>
    <div class="score-row"><span>定罪证据链（命中关键证据 ${sc.keyHits} 条）</span><b>${sc.evidenceScore} / 36</b></div>
    <div class="score-row"><span>现场调查（物证 ${state.found.length}/${CASE.evidences.length}）</span><b>${sc.investigate} / 12</b></div>
    <div class="score-row"><span>审讯攻防（戳穿 ${state.crackCount} 次）</span><b>${sc.interrogation} / 12</b></div>${hintRow}
    <div class="score-total"><span>综合评分</span><b>${sc.total}</b></div>`;
}

function renderTruth() {
  const box = $('truth-box');
  box.classList.remove('hidden');
  $('timeline').innerHTML = CASE.truth.timeline.map(([tm, ev]) =>
    `<div class="timeline-item"><time>${tm}</time><span>${ev}</span></div>`).join('');
  $('reveal').textContent = CASE.truth.reveal.join('\n\n');
}

/* ---------------- AI 侦探能力侧写报告 ---------------- */

function buildBehaviorSnapshot() {
  const stats = ensureStats();
  let confessedCount = 0;
  state.suspects.forEach((st) => { if (st.confessed) confessedCount++; });
  const suspectsState = {};
  state.suspects.forEach((st, id) => { suspectsState[id] = { confessed: st.confessed, pressure: st.pressure }; });
  return {
    stats,
    found: state.found,
    dramasSeen: state.dramasSeen || [],
    crackCount: state.crackCount,
    askedTotal: state.askedTotal,
    accused: state.accused,
    chosenEvidence: state.chosenEvidence,
    confessedCount,
    usedPresent: stats.presentsTotal > 0,
  };
}

async function renderEvaluationReport(sc) {
  const box = $('eval-box');
  if (!box) return;
  box.classList.remove('hidden');
  box.innerHTML = '<div class="eval-loading">🧠 正在根据你的行为痕迹生成能力侧写报告…</div>';

  const snap = buildBehaviorSnapshot();
  const profile = buildProfile(snap, sc);
  try {
    if (!aiActive()) throw { code: 'AI_UNAVAILABLE', message: 'AI 通道不可用' };
    const report = await aiProfileReport(profile, snap, sc);
    state.evaluation = { profile, report };
    renderEvalBox(profile, report);
  } catch (err) {
    // v3.2 · 仅 AI 模式：侧写报告不再回退本地模板，给出重试入口
    box.innerHTML = `<div class="eval-error">
      <div class="eval-title">🕵️ 侦探能力侧写报告</div>
      <p>⚠ 能力侧写需要 AI 通道（${(err && (err.message || err.code)) || '未知错误'}）。</p>
      <p class="dim">审讯/评分/真相已全部保存，重新接入网络后可单独重试生成。</p>
      <button id="btn-eval-retry" class="primary-btn">↻ 重试生成侧写</button>
    </div>`;
    const retry = $('btn-eval-retry');
    if (retry) retry.addEventListener('click', () => { audio.click(); renderEvaluationReport(sc); });
  }
}

function renderEvalBox(profile, report) {
  const box = $('eval-box');
  if (!box) return;
  box.classList.remove('hidden');
  const modeTag = '<span class="eval-mode ai">🤖 AI 深度侧写</span>';
  const strengthsHtml = (report.strengths || []).map((s) => `
    <div class="eval-strength">
      <div class="es-name">长板 · ${s.name}</div>
      <div class="es-text">${s.text}</div>
    </div>`).join('');
  box.innerHTML = `
    <div class="eval-head">
      <div class="eval-title">🕵️ 侦探能力侧写报告</div>
      ${modeTag}
    </div>
    <div class="eval-grid">
      <div class="eval-radar">${radarSVG(profile)}</div>
      <div class="eval-main">
        <div class="eval-style"><span class="es-label">思维风格</span><b>${report.title}</b><span class="es-note">${report.note || ''}</span></div>
        <div class="eval-strengths">${strengthsHtml}</div>
        <div class="eval-blind"><span class="eb-label">盲区提醒</span>${report.blind || ''}</div>
        <div class="eval-advice"><span class="ea-label">下一案建议</span>${report.advice || ''}</div>
      </div>
    </div>`;
}

/* ---------------- v3.0 · 差异化尾声（按最终关系值触发） ---------------- */

function buildEpilogue() {
  const sx = state.suspects.get('suxiao');
  const lmq = state.suspects.get('linmanqing');
  const cm = state.suspects.get('chenmo');
  const parts = [];
  // 苏晓：出庭作证 / 沉默
  if ((sx.trust >= 60 || isCollected('phone')) && !(state.lostEvidence || []).includes('phone')) {
    parts.push('苏晓主动请缨出庭作证——那张她差点删掉的照片，成了呈堂证供。她说：「周叔待我那么好，我不能装没看见。」');
  } else if ((sx.hostility >= 75 || (state.lostEvidence || []).includes('phone'))) {
    parts.push('苏晓最终选择了沉默。删掉的照片、没敢留名的报警电话——没有目击者，案件只剩物证孤证。（关键物证《苏晓的手机》未入卷）');
  }
  // 林曼青：交出合同 / 律师墙
  if (lmq.confessed || state.volunteerNoted) {
    parts.push('林曼青赶在律师函之前，把私洽合同主动交给了检方——「我不想再欠这幅画什么了。」画廊宣布歇业整顿。');
  } else if (lmq.lawyerLock) {
    parts.push('林曼青的律师团把整晚的问话记录拦在了法庭之外。卖画的秘密，随她一起进了证人保护般的沉默。');
  }
  // 陈默：平静自首
  if (cm.confessed && (state.found.includes('recorder'))) {
    parts.push('陈默在铁证与「老周还活着」的事实前平静自首。他在笔录最后写道：信已读完，随画同殉。');
  } else if (cm.pressure >= 4) {
    parts.push('陈默的防线碎了，但坦白不完整——他只承认在场，死咬着「只是一个偷母亲遗物的贼」。');
  }
  return parts.length
    ? '【关系尾声】\n' + parts.join('\n')
    : '【关系尾声】三名嫌疑人与你维持了一夜的僵持——没有谁真正向你敞开。';
}

/* ---------------- NPC 决策日志摘要（结案展示用） ---------------- */

function decisionLogDigest() {
  const log = getDecisionLog();
  if (!log.length) return null;
  const lines = log.slice(-12).map((e) => {
    const tag = {
      rel_event: '· 关系事件', judge: '· AI裁判', hand_over_photo: '· ✅交出照片',
      delete_photo: '· 💥删除照片', call_lawyer: '· ⚖️叫律师', volunteer_info: '· 🤝主动交代',
      shift_blame: '· 🎯祸水东引', request_storage: '· 🚪请求去储物间',
    }[e.action] || `· ${e.action}`;
    const okText = e.ok === false ? '【规则层拒绝→重决策】' : e.ok ? '' : '';
    return `${e.suspect} ${tag} 压${e.pressure}/信${e.trust}/敌${e.hostility} ${e.note || ''} ${okText}`.trim();
  });
  return `NPC 决策日志（末 ${lines.length} 条 / 共 ${log.length} 条）：\n${lines.join('\n')}`;
}

/** 结案陈词兜底清洗：模型偶发越界输出 JSON 时提取正文，避免原始 JSON 直出给玩家 */
function sanitizeJuryText(text) {
  const raw = String(text || '').trim();
  if (!raw) return '（陪审团沉默了片刻，没有留下陈词。）';
  if (!/^\{[\s\S]*\}$/.test(raw)) return raw;
  try {
    const obj = JSON.parse(raw);
    const pick = obj.reply || obj.text || obj.verdict || obj.content;
    if (typeof pick === 'string' && pick.trim()) return pick.trim();
  } catch (e) { /* 非合法 JSON → 原样展示 */ }
  return raw;
}

async function runFinal() {
  showPhase('final');
  const accusedSuspect = suspectById(state.accused);
  const chosen = state.chosenEvidence.map((id) => CASE.evidences.find((e) => e.id === id));
  state.epilogue = buildEpilogue();

  // 审讯记录摘要（给陪审团）
  const digestParts = [];
  state.suspects.forEach((st, id) => {
    const s = suspectById(id);
    digestParts.push(`${s.name}：被戳穿 ${st.pressure} 次${st.confessed ? '，已完整坦白' : `，情绪${stageOf(st)}`}，信任 ${st.trust}、敌意 ${st.hostility}`);
  });
  let jury;
  try {
    jury = await juryVerdict({
      accusedName: accusedSuspect ? accusedSuspect.name : '（无人）',
      chosenEvidences: chosen,
      foundCount: state.found.length,
      totalEvidences: CASE.evidences.length,
      crackCount: state.crackCount,
      dialogueDigest: digestParts.join('；'),
      epilogue: state.epilogue,
    });
  } catch (err) {
    // v3.2 · 仅 AI 模式：结案陈词需 AI，失败则退回指认幕并提示重试
    showPhase('accuse');
    const msg = (err && err.message) || 'AI 通道不可用';
    showAiBlockedModal(msg, () => runFinal());
    return;
  }

  $('final-title').textContent = jury.isCorrect ? '真相只有一个' : '陪审团合议完毕';
  audio.verdict();
  const sc = computeScore(jury.isCorrect);
  await typeText($('jury-box'), sanitizeJuryText(jury.text), 24);
  renderScore(sc);
  renderTruth();
  // v3.0 · 关系尾声 + NPC 决策日志摘要
  const epBox = $('epilogue-box');
  if (epBox) {
    epBox.classList.remove('hidden');
    const logDigest = decisionLogDigest();
    epBox.innerHTML = `<h3>🕯 尾声 · 由你与三人的关系决定</h3>
      <div class="epilogue-text">${(state.epilogue || '').replace('【关系尾声】\n', '')}</div>
      ${logDigest ? `<details class="decision-log"><summary>🧪 NPC 决策日志（AI 决策 × 规则层校验，共 ${getDecisionLog().length} 条）</summary><pre>${logDigest.replace(/^.*：\n/, '')}</pre></details>` : ''}`;
  }
  await renderEvaluationReport(sc);
  state.finished = true;
  save();
  // 密钥安全：结案后自动销毁策略（0 保留，进度/报告已先行落盘）
  if (getTokenPolicy() === 'caseEnd') executeAutoDestroy('caseEnd');
}

/* ============================================================
 * 相位切换
 * ============================================================ */

function showPhase(phase, opts = {}) {
  state.phase = phase;
  document.querySelectorAll('.phase').forEach((el) => el.classList.add('hidden'));
  $(`phase-${phase}`).classList.remove('hidden');
  $('topbar').classList.remove('hidden');
  $('phase-label').textContent = PHASE_LABELS[phase] || '';
  window.scrollTo({ top: 0 });
  // silent：仅切视图不落盘（封面展示用，避免把进行中的存档 phase 污染成 intro）
  if (!opts.silent) save();
}

function gotoInvest() { showPhase('invest'); enterRoom(state.currentRoom); }
function gotoInterrogate() {
  if (state.found.length < 3) {
    toast('线索太少了——至少收集 3 条物证再提审，否则只是打草惊蛇。');
    return;
  }
  // v3.2 · 仅 AI 模式：无 AI 无法审讯
  if (!requireAI(() => gotoInterrogate())) return;
  showPhase('interrogate');
  renderSuspectList();
  if (!state.activeSuspect) selectSuspect(CASE.suspects[0].id, true);
  else selectSuspect(state.activeSuspect, true);
}
function gotoAccuse() {
  if (state.askedTotal < 1 && state.crackCount < 1) {
    toast('你还没审过任何人。至少开一次口，再下结论。');
    return;
  }
  showPhase('accuse');
  renderAccuse();
}

/* ============================================================
 * 设置面板
 * ============================================================ */

function updateAIBadge() {
  const b = $('ai-badge');
  b.textContent = describeEndpoint();
}

/* v3.0 · 接口来源选择面板同步 */
function syncEndpointUI() {
  const freeOpt = $('endpoint-free');
  const customOpt = $('endpoint-custom');
  if (!freeOpt || !customOpt) return;
  const mode = getEndpointMode();
  freeOpt.checked = mode === ENDPOINT_MODE.FREE;
  customOpt.checked = mode === ENDPOINT_MODE.CUSTOM;

  const status = $('free-channel-status');
  const customBlock = $('custom-key-block');
  if (proxyState.available) {
    if (status) {
      const left = Math.max(0, proxyState.sessionCap - proxyState.sessionUsed);
      status.textContent = `✓ 免费通道可用 · 模型 ${proxyState.model || '（服务端配置）'} · 本局剩余 ${left} 次`;
      status.className = 'free-status ok';
    }
    freeOpt.disabled = false;
  } else {
    if (status) {
      status.textContent = '✗ 当前环境未启用免费通道（本地 file:// 或纯静态托管）——必须切换自定义 Key 才能游玩';
      status.className = 'free-status err';
    }
    // 免费通道不可用 → 自动切到自定义并禁用免费选项
    if (mode === ENDPOINT_MODE.FREE && proxyState.checked) {
      setEndpointMode(ENDPOINT_MODE.CUSTOM);
      customOpt.checked = true;
    }
    freeOpt.disabled = true;
  }
  if (customBlock) customBlock.classList.toggle('dim', mode !== ENDPOINT_MODE.CUSTOM);
}

function initSettings() {
  // v3.0 · 接口来源选择
  const freeOpt = $('endpoint-free');
  const customOpt = $('endpoint-custom');
  if (freeOpt) freeOpt.addEventListener('change', () => {
    if (!freeOpt.checked) return;
    setEndpointMode(ENDPOINT_MODE.FREE);
    audio.click();
    syncEndpointUI();
    updateAIBadge();
    updateIntroAICard();
  });
  if (customOpt) customOpt.addEventListener('change', () => {
    if (!customOpt.checked) return;
    setEndpointMode(ENDPOINT_MODE.CUSTOM);
    audio.click();
    syncEndpointUI();
    updateAIBadge();
    updateIntroAICard();
  });
  syncEndpointUI();

  const sel = $('settings-model');
  sel.innerHTML = MODEL_OPTIONS.map((m) =>
    `<option value="${m.id}">${m.label}</option>`).join('') +
    `<option value="__custom__">自定义模型…</option>`;
  const current = aiSettings.getModel();
  const known = MODEL_OPTIONS.some((m) => m.id === current);
  if (!known) {
    sel.value = '__custom__';
    const custom = document.createElement('option');
    custom.value = current; custom.textContent = `自定义：${current}`;
    sel.appendChild(custom); sel.value = current;
  } else sel.value = current;

  /* v3.7 · 模型 ID 输入框 + 测试按钮 */
  const modelInput = $('settings-model-id');
  const testModelBtn = $('btn-test-model');
  if (modelInput) {
    // 同步当前模型：白名单内的也填进去，省得玩家想微调时还要先切到自定义
    modelInput.value = current;
    const syncCustomState = () => {
      const isCustom = sel.value === '__custom__';
      modelInput.classList.toggle('is-custom', isCustom);
      if (isCustom && !modelInput.value) modelInput.focus();
    };
    syncCustomState();
    sel.addEventListener('change', () => {
      syncCustomState();
      // 切到白名单项时同步输入框，避免「下拉显示 X、输入框留着 Y」的割裂
      if (sel.value !== '__custom__') modelInput.value = sel.value;
    });
  }
  // 免费通道模型展示：让玩家知道免费通道实际在打哪个模型
  showFreeChannelModel();

  // 存储模式单选同步
  const curMode = aiSettings.getStorageMode();
  const modeMem = $('mode-memory');
  const modeEnc = $('mode-encrypted');
  if (modeMem && modeEnc) {
    if (curMode === STORAGE_MODE.ENCRYPTED) modeEnc.checked = true;
    else modeMem.checked = true;
  }

  $('settings-token').value = aiSettings.getToken();

  /* v3.5 · 自定义端点：初始化 + 实时校验 */
  const epPreset = $('settings-endpoint-preset');
  const epInput = $('settings-endpoint');
  const epHint = $('endpoint-hint');
  const wlInput = $('settings-endpoint-whitelist');
  if (epInput) {
    const currentUrl = getEndpointUrl() || DEFAULT_ENDPOINT_URL;
    const isDefault = currentUrl === DEFAULT_ENDPOINT_URL;
    if (epPreset) epPreset.value = isDefault ? 'modelscope' : 'custom';
    epInput.value = currentUrl;
    epInput.disabled = isDefault;

    const reflect = () => {
      const v = epInput.value.trim();
      if (!v) {
        if (epHint) { epHint.textContent = '默认直连魔搭官方；也可填自建网关 / 其他厂商 / 本地推理服务的 OpenAI 兼容地址。'; epHint.className = 'hint-line'; }
        return;
      }
      const check = validateEndpointUrl(v);
      if (epHint) {
        if (check.ok) {
          epHint.textContent = `✓ 端点可用：${check.hostname}`;
          epHint.className = 'hint-line ok-text';
        } else {
          epHint.textContent = `✗ ${check.message}`;
          epHint.className = 'hint-line err-text';
        }
      }
    };
    epInput.addEventListener('input', reflect);
    epInput.addEventListener('blur', reflect);
    if (epPreset) epPreset.addEventListener('change', () => {
      const custom = epPreset.value === 'custom';
      epInput.disabled = !custom;
      if (!custom) {
        epInput.value = DEFAULT_ENDPOINT_URL;
        setEndpointUrl('');
      } else if (!epInput.value.trim() || epInput.value.trim() === DEFAULT_ENDPOINT_URL) {
        // 切到自定义且当前仍是默认值 → 清空，引导填写
        epInput.value = '';
        epInput.focus();
      }
      reflect();
    });
    reflect();
  }
  if (wlInput) {
    wlInput.value = getEndpointWhitelist().join('\n');
  }

  /* v3.6 · 免费通道代理基址：初始化 + 实时校验 */
  const pbInput = $('settings-proxy-base');
  if (pbInput) {
    pbInput.value = getProxyBase();
    const reflectProxy = () => {
      const hint = $('proxy-base-hint');
      if (!hint) return;
      const raw = pbInput.value.trim();
      if (!raw) {
        hint.textContent = '✓ 同源（默认）——适合后端与前端同域部署';
        hint.className = 'hint-line ok-text';
        return;
      }
      const check = validateProxyBase(raw);
      hint.textContent = check.ok ? `✓ 代理基址：${check.origin}` : `✗ ${check.message}`;
      hint.className = `hint-line ${check.ok ? 'ok-text' : 'err-text'}`;
    };
    pbInput.addEventListener('input', reflectProxy);
    pbInput.addEventListener('blur', reflectProxy);
    reflectProxy();
  }

  // 明文切换
  const visBtn = $('btn-toggle-token-vis');
  if (visBtn) {
    visBtn.addEventListener('click', () => {
      const input = $('settings-token');
      input.type = input.type === 'password' ? 'text' : 'password';
      visBtn.textContent = input.type === 'password' ? '👁' : '🔒';
    });
  }

  // 保存
  $('btn-save-settings').addEventListener('click', async () => {
    const rawToken = $('settings-token').value.trim();
    const st = $('settings-status');
    // 一人一 Key：格式校验（ms- 前缀），不合格不落盘
    // 自定义端点（非魔搭官方）时各家 Token 前缀不同，不强制 ms- 前缀
    const isModelScopeEndpoint = getEndpointUrl() === DEFAULT_ENDPOINT_URL;
    if (rawToken && isModelScopeEndpoint && !validateTokenFormat(rawToken)) {
      st.className = 'err';
      st.textContent = '✗ Token 格式不正确：应为 ms- 开头的完整访问令牌（如 ms-xxxxxxxxxxxx），请到 modelscope.cn → 访问令牌 重新复制';
      return;
    }
    if (rawToken && !isModelScopeEndpoint && rawToken.length < 8) {
      st.className = 'err';
      st.textContent = '✗ Token 过短：请确认已完整复制所选服务商的 API Key';
      return;
    }

    // ── 阶段一：全部校验。任何一项失败都只报错返回，绝不写任何存储 ──
    // 顺序很重要：以前把"校验"和"落盘"交织在一起，端点已写进 localStorage
    // 之后才发现代理基址不合法 → 这次"保存失败"却把 Token 下次请求发往新端点。
    const epVal = epInput ? epInput.value.trim() : '';
    if (epVal) {
      const check = validateEndpointUrl(epVal);
      if (!check.ok) {
        st.className = 'err';
        st.textContent = `✗ 端点未保存：${check.message}`;
        return;
      }
    }

    // v3.6 · 代理基址校验（同样必须在校验段，避免部分落盘）
    const proxyRaw = pbInput ? pbInput.value.trim() : '';
    if (proxyRaw) {
      const check = validateProxyBase(proxyRaw);
      if (!check.ok) {
        st.className = 'err';
        st.textContent = `✗ 代理基址未保存：${check.message}`;
        return;
      }
    }

    // ── 阶段二：全部通过，才统一落盘 ──
    // 代理基址归一为 origin 后再存，保证 proxyUrl() 拼接不会落入 path/query/hash
    const prevProxy = getProxyBase();
    if (epVal) setEndpointUrl(epVal); else setEndpointUrl('');
    if (wlInput) setEndpointWhitelist(wlInput.value);
    if (pbInput) setProxyBase(proxyRaw);
    const proxyChanged = pbInput ? getProxyBase() !== prevProxy : false;

    const mode = modeEnc && modeEnc.checked ? STORAGE_MODE.ENCRYPTED : STORAGE_MODE.MEMORY;
    await aiSettings.setToken(rawToken, mode);

    // v3.7 · 模型 ID：优先取输入框（取代原先的 gamePrompt 弹窗）。
    // 存什么读什么，白名单不再作为过滤条件——玩家手填的 glm-4-plus 之类
    // 以前每次都被重置回默认值，等于"换了模型但没换"。
    let model = sel.value;
    const typed = $('settings-model-id');
    if (model === '__custom__' || (typed && typed.value.trim())) {
      const typedVal = (typed && typed.value.trim()) || '';
      if (typedVal) {
        model = typedVal;
      } else if (sel.value !== '__custom__') {
        model = sel.value;
      } else {
        // 选了「自定义」却没填任何值 → 保留当前模型，不让配置变空
        model = aiSettings.getModel();
        st.className = 'err';
        st.textContent = '✗ 选择了「自定义模型」但没填 ID——请填入模型 ID，或改选列表中的模型';
        return;
      }
    }
    aiSettings.setModel(model);
    if (modelInput) modelInput.value = model;

    updateAIBadge();
    updateIntroAICard();
    // v3.6 · 代理基址变更后免费通道可用性需重新探测（原结论基于旧地址）
    if (proxyChanged) {
      st.className = 'ok';
      st.textContent = '↻ 正在重新探测免费通道…';
      await probeProxy();
      syncEndpointUI();
      updateAIBadge();
      updateIntroAICard();
    }
    const modeDesc = mode === STORAGE_MODE.ENCRYPTED ? '已启用 AES-GCM-256 加密存储' : '已启用纯内存阅后即焚模式';
    st.className = 'ok';
    st.textContent = aiSettings.hasToken()
      ? `✓ 已保存（${modeDesc}，AI 实时扮演生效）`
      : (proxyState.checked && proxyState.available
        ? '✓ 已保存（未填 Token，将使用内置免费通道）'
        : (proxyState.checked
          ? '⚠ 未接入任何 AI 通道：免费通道不可用，本作仅支持 AI 模式，请填写 Token'
          : '⚠ 未接入任何 AI 通道：免费通道探测未完成，请点「测试连接」重试'));
    // 引导链路收尾：配置成功 → 小手退场
    if (aiSettings.hasToken() && handTarget) {
      hideHand();
      handIntent = '';
      toast('🤖 AI 已接入！嫌疑人将被实时扮演，结案后可获深度侧写报告');
    }
    save();
  });

  /* v3.7 · 「测试该模型」：用输入框里的模型 ID 发一次最小请求。
   * 只测不存——玩家可能只是想看看某个 ID 能不能用，未必想切过去。
   * 免费通道模式下模型由服务端强制，这里给出明确说明，不让玩家误判。 */
  if (testModelBtn && modelInput) {
    testModelBtn.addEventListener('click', async () => {
      const id = modelInput.value.trim();
      const st = $('settings-status');
      if (!id) {
        st.className = 'err';
        st.textContent = '✗ 先填入要测试的模型 ID';
        return;
      }
      const customMode = getEndpointMode() === ENDPOINT_MODE.CUSTOM;
      if (!customMode || !aiSettings.hasToken()) {
        st.className = 'err';
        st.textContent = '✗ 测试模型需要「自定义」模式且已填 Token（免费通道的模型由服务端决定，前端不可选）';
        return;
      }
      st.className = 'ok';
      st.textContent = `⏳ 正在用 ${id} 测试…`;
      const prev = aiSettings.getModel();
      aiSettings.setModel(id);
      try {
        const r = await testConnection(aiSettings.getToken(), id);
        st.className = r.ok ? 'ok' : 'err';
        st.textContent = r.ok
          ? `✓ ${id} 可用（${r.ms}ms）`
          : `✗ ${id} 不可用：${r.message || '请求失败'}`;
      } catch (e) {
        st.className = 'err';
        st.textContent = `✗ 测试失败：${(e && e.message) || '未知错误'}`;
      } finally {
        aiSettings.setModel(prev);   // 只测不改，恢复原模型
        updateAIBadge();
      }
    });
  }

  // 销毁 Token（游戏内确认弹窗 · 0 保留确认）
  const clearBtn = $('btn-clear-settings');
  if (clearBtn) {
    clearBtn.addEventListener('click', async () => {
      const ok = await gameConfirm(
        '确认销毁并清空当前 Token？\n系统将执行内存覆写覆盖并彻底移除本地存储，零日志零保留。',
        { title: '销毁 Token 🛡️', okText: '确认销毁', danger: true },
      );
      if (ok) {
        executeAutoDestroy('manual');
        const st = $('settings-status');
        st.className = 'ok';
        st.textContent = '✓ 0 保留确认：内存覆写 ✓ · 本地密文清除 ✓ · 零日志零保留 ✓';
      }
    });
  }

  // 自动销毁策略单选（一人一 Key · 玩家自选时机）
  const policyInputs = document.querySelectorAll('input[name="destroy-policy"]');
  if (policyInputs.length) {
    const cur = getTokenPolicy();
    policyInputs.forEach((r) => { r.checked = r.value === cur; });
    policyInputs.forEach((r) => r.addEventListener('change', () => {
      if (!r.checked) return;
      setTokenPolicy(r.value);
      audio.click();
      resetIdleDestroyTimer();
      const labels = {
        off: '已关闭自动销毁（Token 保留至手动销毁）',
        idle30m: `已开启：无操作 ${Math.round(IDLE_DESTROY_MS / 60000)} 分钟自动销毁`,
        caseEnd: '已开启：结案后自动销毁',
        pageClose: '已开启：关闭页面即焚（阅后即焚模式）',
      };
      toast(`🛡️ ${labels[r.value] || '策略已更新'}`, 3000);
    }));
  }

  // 测试连接
  $('btn-test-settings').addEventListener('click', async () => {
    const st = $('settings-status');
    const token = $('settings-token').value.trim() || aiSettings.getToken();
    if (!token) { st.className = 'err'; st.textContent = '✗ 请先填写 Token'; return; }
    st.className = ''; st.textContent = '⏳ 正在向魔搭官方端点测试推理…';
    try {
      // v3.7 · 模型取值：输入框优先（里面通常就是玩家想测的那个），否则下拉/当前模型
      const typedModel = ($('settings-model-id') && $('settings-model-id').value.trim()) || '';
      const model = typedModel || (sel.value === '__custom__' ? aiSettings.getModel() : sel.value);
      const { reply, latency } = await testConnection(token, model);
      st.className = 'ok';
      st.textContent = `✓ 连通成功！延迟 ${latency}ms（回复：${reply.slice(0, 20)}）`;
    } catch (err) {
      st.className = 'err';
      st.textContent = `✗ ${err.message || err.code || '连接失败'}`;
    }
  });
}

/**
 * v3.7 · 在模型 ID 输入框旁显示免费通道实际在用的模型。
 * 免费通道的模型由服务端 _forward 强制（前端传什么都不作数），
 * 所以必须明示——否则玩家看到下拉里默认的 Qwen3.8-Flash，
 * 以为在用那个，实际打的是 spark-x2.6。
 */
function showFreeChannelModel() {
  const note = $('free-model-note');
  if (!note) return;
  note.classList.remove('hidden');
  const current = getEndpointMode();
  if (current === ENDPOINT_MODE.CUSTOM && aiSettings.hasToken()) {
    note.textContent = '当前为自定义 Key 模式，上方模型 ID 完全由你决定。';
    note.className = '';
    return;
  }
  const m = proxyState.model || '';
  if (proxyState.checked && proxyState.available && m) {
    note.textContent = `（免费通道当前实际使用：${m}——由服务端决定，前端不可选；填了自定义 Key 后才可自行指定。）`;
  } else if (proxyState.checked) {
    note.textContent = '（免费通道暂不可用；下方自定义 Key 模式可自行指定模型。）';
  } else {
    note.textContent = '（免费通道探测中……）';
  }
  note.className = 'free-model-note';
}

function initVisualizerAndAudioControls() {
  // 静音控制
  const muteBtn = $('btn-mute');
  if (muteBtn) {
    const updateIcon = () => {
      muteBtn.textContent = audio.isMuted() ? '🔇' : '🔊';
      muteBtn.title = audio.isMuted() ? '点击取消静音' : '点击静音';
      muteBtn.setAttribute('aria-label', audio.isMuted() ? '取消静音' : '静音');
    };
    updateIcon();
    muteBtn.addEventListener('click', () => {
      audio.toggleMute();
      updateIcon();
    });
  }

  // 声波律动仪
  const visualizer = $('audio-visualizer');
  const bars = visualizer ? visualizer.querySelectorAll('.v-bar') : [];
  function renderVisualizer() {
    if (bars.length) {
      const energy = audio.getAudioEnergy();
      const b1 = Math.max(3, energy.bass * 20);
      const b2 = Math.max(3, ((energy.bass + energy.mid) / 2) * 22);
      const b3 = Math.max(3, energy.mid * 20);
      const b4 = Math.max(3, energy.treble * 18);
      bars[0].style.height = `${b1}px`;
      bars[1].style.height = `${b2}px`;
      bars[2].style.height = `${b3}px`;
      bars[3].style.height = `${b4}px`;
    }
    requestAnimationFrame(renderVisualizer);
  }
  requestAnimationFrame(renderVisualizer);

  // 雷声闪电联动
  const lightningLayer = $('lightning-layer');
  audio.onThunder(() => {
    if (lightningLayer) {
      lightningLayer.classList.add('flash');
      setTimeout(() => lightningLayer.classList.remove('flash'), 180);
    }
  });
}

/* ============================================================
 * 负载排队 UI（顶栏胶囊 + 审讯对话气泡 + 结案报告 loading 透传）
 * 数据源：ai-client loadState（真实限流退避/并发排队状态）
 * ============================================================ */

let queueTimer = null;
let queueHideTimer = null;

function fmtQueueText(st) {
  if (st.phase === 'queued') {
    const remain = Math.max(1, Math.ceil((st.waitMs) / 1000));
    return `⏳ 排队重试 ${st.attempt}/3 · 约${remain}s`;
  }
  if (st.phase === 'gate') {
    return st.depth > 0 ? `⏳ 排队中 · 前面 ${st.depth} 个请求` : '⏳ 排队中';
  }
  return '';
}

function showQueueFeedback(st) {
  const badge = $('queue-badge');
  if (badge) {
    clearTimeout(queueHideTimer);
    badge.classList.remove('hidden');
    badge.textContent = fmtQueueText(st);
    clearInterval(queueTimer);
    queueTimer = setInterval(() => {
      // queued 阶段做本地倒计时（waitMs 随时间递减）
      if (loadStateNow.phase === 'queued' && loadStateNow.waitMs > 0) {
        loadStateNow.waitMs = Math.max(0, loadStateNow.waitMs - 500);
        badge.textContent = fmtQueueText(loadStateNow);
      }
    }, 500);
  }
  // 审讯对话气泡（仅审讯幕且对话进行中）
  if (state.phase === 'interrogate' && busy) {
    let bubble = $('queue-bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.id = 'queue-bubble';
      bubble.className = 'bubble system queue-bubble';
      $('dialog-stream').appendChild(bubble);
    }
    bubble.textContent = `🛰️ AI 线路繁忙，${fmtQueueText(st).replace('⏳ ', '')}——挂机等待即可，无需操作。`;
    const stream = $('dialog-stream');
    stream.scrollTop = stream.scrollHeight;
  }
  // 结案报告 loading 文案透传
  const loading = document.querySelector('.eval-loading');
  if (loading && loading.textContent.includes('侧写')) {
    loading.textContent = `🧠 ${fmtQueueText(st)}，正在生成能力侧写报告…`;
  }
}

function hideQueueFeedback() {
  clearInterval(queueTimer);
  queueTimer = null;
  const badge = $('queue-badge');
  if (badge) {
    clearTimeout(queueHideTimer);
    queueHideTimer = setTimeout(() => badge.classList.add('hidden'), 800);
  }
  const bubble = $('queue-bubble');
  if (bubble) bubble.remove();
}

let loadStateNow = { phase: 'idle', depth: 0, attempt: 0, waitMs: 0 };
function initLoadQueueUI() {
  onLoadState((st) => {
    loadStateNow = st;
    if (st.phase === 'queued' || st.phase === 'gate') showQueueFeedback(st);
    else hideQueueFeedback();
  });
}

/* ============================================================
 * 多人密钥安全：一人一 Key · 自动销毁策略（玩家自选）· 0 保留补偿
 * 策略：off（默认）| idle30m（无操作30分钟）| caseEnd（结案后）| pageClose（关闭即焚）
 * ============================================================ */

const POLICY_KEY = 'rain-gallery-token-policy';

function getTokenPolicy() {
  return storage.getItem(POLICY_KEY) || 'off';
}
function setTokenPolicy(p) {
  storage.setItem(POLICY_KEY, p);
}

/** 统一销毁流程：Zero-Fill 清 Token → 刷新徽标 → 补偿提示（0 保留） */
function executeAutoDestroy(reason) {
  if (!aiSettings.hasToken()) return;
  aiSettings.clearToken();
  const input = $('settings-token');
  if (input) input.value = '';
  updateAIBadge();
  updateIntroAICard();
  const notes = {
    idle30m: '⏱ 检测到 30 分钟无操作，Token 已自动销毁（0 保留）· 游戏进度/评分/报告均已保存，随时可 30 秒重新接入',
    caseEnd: '🛡️ 本案已结，Token 已按策略自动销毁（0 保留）· 进度与能力侧写报告均已保存',
    pageClose: '',
    manual: '🛡️ Token 已彻底安全销毁（0 保留）· 游戏进度不受影响',
  };
  const msg = notes[reason];
  if (msg) toast(msg, 3600);
  save();
}

let idleDestroyTimer = null;
const IDLE_DESTROY_MS = Math.max(
  3000,
  Number(storage.getItem('rain-gallery-idle-ms')) || 30 * 60 * 1000,
);

function resetIdleDestroyTimer() {
  clearTimeout(idleDestroyTimer);
  if (getTokenPolicy() !== 'idle30m') return;
  idleDestroyTimer = setTimeout(() => {
    if (getTokenPolicy() === 'idle30m') executeAutoDestroy('idle30m');
  }, IDLE_DESTROY_MS);
}

function initTokenSafety() {
  // 无操作自动销毁：任意交互重置计时
  ['pointerdown', 'keydown', 'scroll', 'visibilitychange'].forEach((ev) => {
    document.addEventListener(ev, resetIdleDestroyTimer, { passive: true });
  });
  resetIdleDestroyTimer();

  // 关闭页面即焚
  window.addEventListener('pagehide', () => {
    if (getTokenPolicy() === 'pageClose') aiSettings.clearToken();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && getTokenPolicy() === 'pageClose') {
      aiSettings.clearToken();
    }
  });
}

/* ============================================================
 * 事件绑定 & 启动
 * ============================================================ */

function resumeGamePhase() {
  // 以存档 phase 快照恢复（封面的 intro 展示态不改写存档进度）
  state.phase = state.resumePhase || state.phase;
  updateNotebookCount();
  if (state.phase === 'final' && state.finished) {
    showPhase('final');
    $('final-title').textContent = '陪审团合议完毕（存档回放）';
    $('jury-box').textContent = '（本局已结案。评分与真相如下。）';
    const sc = computeScore(state.accused === CASE.truth.culprit);
    renderScore(sc);
    renderTruth();
    // 存档中已有侧写报告 → 直接重渲染，不再调 AI
    if (state.evaluation && state.evaluation.profile && state.evaluation.report) {
      renderEvalBox(state.evaluation.profile, state.evaluation.report);
    } else {
      renderEvaluationReport(sc);
    }
  } else if (state.phase === 'invest') {
    gotoInvest();
  } else if (state.phase === 'interrogate') {
    showPhase('interrogate');
    renderSuspectList();
    if (!state.activeSuspect) selectSuspect(CASE.suspects[0].id, true);
    else selectSuspect(state.activeSuspect, true);
    toast('已恢复上次的调查进度 📂');
  } else if (state.phase === 'accuse') {
    gotoAccuse();
  } else {
    gotoInvest();
  }
}

function bindEvents() {
  const beginBtn = $('btn-begin-game');
  if (beginBtn) {
    beginBtn.addEventListener('click', async () => {
      // v3.2 · 仅 AI 模式：未接入 AI 不可开始
      if (!requireAI(() => beginBtn.click())) return;
      audio.click();
      // 「开始游戏」= 明确的新开意图：检测到上次进度时先确认（避免重走剧情后带着旧线索的困惑）
      const hasProgress = state.found.length > 0 || state.crackCount > 0 || state.askedTotal > 0 || state.phase !== 'intro';
      if (hasProgress) {
        const phaseDesc = state.phase !== 'intro' ? ` · ${PHASE_LABELS[state.resumePhase] || '进行中'}` : '';
        const ok = await gameConfirm(
          `检测到上次的调查进度（线索 ${state.found.length}/${CASE.evidences.length}${phaseDesc}）。\n开始新游戏将清空该进度；想接着查请关闭后点「📂 继续上次调查」。`,
          { title: '开始新游戏 🌧️', okText: '清空并重新开始', cancelText: '取消', danger: true },
        );
        if (!ok) return;
        storage.removeItem(SAVE_KEY);
        resetGameState();
        updateNotebookCount();
        const saveActions = $('cover-save-actions');
        if (saveActions) saveActions.classList.add('hidden'); // 存档已清，收起续玩按钮
      }
      const cover = $('intro-cover-actions');
      if (cover) cover.classList.add('hidden');
      const nar = $('narration-container');
      if (nar) nar.classList.remove('hidden');
      startNarrationStory();
    });
  }

  const resumeBtn = $('btn-resume-game');
  if (resumeBtn) {
    resumeBtn.addEventListener('click', () => {
      // v3.2 · 仅 AI 模式：未接入 AI 不可继续
      if (!requireAI(() => resumeBtn.click())) return;
      audio.ensure();
      audio.startRain();
      audio.startBgm();
      scheduleThunder();
      audio.click();
      resumeGamePhase();
    });
  }

  const clearSaveBtn = $('btn-clear-save');
  if (clearSaveBtn) {
    clearSaveBtn.addEventListener('click', async () => {
      const ok = await gameConfirm('确认清空历史调查进度，从头开始破案？', { title: '清空存档', okText: '确认清空', danger: true });
      if (ok) {
        storage.removeItem(SAVE_KEY);
        location.reload();
      }
    });
  }

  $('btn-start').addEventListener('click', () => {
    // v3.2 · 仅 AI 模式：未接入 AI 不可进入调查
    if (!requireAI(() => $('btn-start').click())) return;
    audio.ensure();
    audio.stopNarration(150);
    audio.startRain();
    audio.startBgm();
    scheduleThunder();
    audio.click();
    const stats = ensureStats();
    stats.startedAt = Date.now();
    stats._lastTick = Date.now();
    hideHand(); // 若引导链路中小手仍指向设置，开始游戏即收起
    gotoInvest();
  });

  const skipBtn = $('btn-skip-intro');
  if (skipBtn) skipBtn.addEventListener('click', () => { audio.click(); finishIntroNarration(); });

  const replayBtn = $('btn-replay-narration');
  if (replayBtn) replayBtn.addEventListener('click', () => { audio.click(); startNarrationStory(); });

  const configAiBtn = $('btn-intro-config-ai');
  if (configAiBtn) {
    configAiBtn.addEventListener('click', () => {
      audio.click();
      $('modal-settings').classList.remove('hidden');
      // 引导链路：接入配置 → 小手改指 Token 输入框
      if (handTarget === configAiBtn) {
        setTimeout(() => {
          const tokenInput = $('settings-token');
          if (tokenInput) { pointHandAt(tokenInput); tokenInput.focus({ preventScroll: true }); }
        }, 300);
      }
    });
  }

  $('btn-notebook').addEventListener('click', () => {
    audio.click();
    renderNotebook();
    $('modal-notebook').classList.remove('hidden');
  });
  $('btn-settings').addEventListener('click', () => {
    audio.click();
    $('modal-settings').classList.remove('hidden');
    // 引导链路备用入口（顶栏设置按钮）
    if (handTarget && (handTarget.id === 'btn-settings')) {
      setTimeout(() => {
        const tokenInput = $('settings-token');
        if (tokenInput) { pointHandAt(tokenInput); tokenInput.focus({ preventScroll: true }); }
      }, 300);
    }
  });
  /* v3.2 · AI 阻断弹窗:去设置 / 重试(重发上一条提问) */
  const abSettings = $('btn-ai-blocked-settings');
  if (abSettings) abSettings.addEventListener('click', () => {
    audio.click();
    $('modal-ai-blocked').classList.add('hidden');
    $('modal-settings').classList.remove('hidden');
  });
  const abRetry = $('btn-ai-blocked-retry');
  if (abRetry) abRetry.addEventListener('click', async () => {
    audio.click();
    $('modal-ai-blocked').classList.add('hidden');
    // 先重新探测免费通道，再执行上一次失败的动作（提问/出示/结案/开始）
    try { await probeProxy(); } catch (e) { /* ignore */ }
    updateAIBadge();
    syncEndpointUI();
    const fn = aiBlockedRetry;
    aiBlockedRetry = null;
    if (fn) fn();
    else if (state.phase === 'interrogate') sendQuestion(true);
  });

  $('btn-present').addEventListener('click', () => { audio.click(); openPresentModal(); });

  /* ---------- 引导弹窗 ---------- */
  const gPrev = $('btn-guide-prev');
  if (gPrev) gPrev.addEventListener('click', () => {
    audio.click();
    const cur = [1, 2, 3].findIndex((i) => !$(`guide-step-${i}`)?.classList.contains('hidden')) + 1;
    gotoGuideStep(Math.max(1, cur - 1));
  });
  const gNext = $('btn-guide-next');
  if (gNext) gNext.addEventListener('click', () => {
    audio.click();
    const cur = [1, 2, 3].findIndex((i) => !$(`guide-step-${i}`)?.classList.contains('hidden')) + 1;
    gotoGuideStep(Math.min(3, cur + 1));
  });
  const gConfig = $('btn-guide-go-config');
  if (gConfig) gConfig.addEventListener('click', () => { audio.click(); startGuideConfigFlow(); });
  const gSkip = $('btn-guide-skip');
  if (gSkip) gSkip.addEventListener('click', () => {
    audio.click();
    markGuided();
    // 关闭引导弹窗（仅写标记不关窗会让按钮看起来无效）
    const modal = $('modal-guide');
    if (modal) modal.classList.add('hidden');
    // v3.2 · 未接入 AI 时该按钮充当「去接入」入口
    if (!aiActive()) {
      $('modal-settings').classList.remove('hidden');
      hideHand();
      return;
    }
    hideHand(); // 防御性收尾
  });
  // 引导弹窗被 ✕ / 遮罩关闭（通用处理器负责隐藏）时也写入已完成标记
  const guideModal = $('modal-guide');
  if (guideModal) guideModal.addEventListener('click', (ev) => {
    if (ev.target.classList.contains('modal-close') || ev.target.classList.contains('modal')) markGuided();
  });

  /* ---------- hover 轻音效（事件委托 + 120ms 节流；AudioContext 就绪后才发声） ---------- */
  let lastHoverSfx = 0;
  document.addEventListener('mouseover', (ev) => {
    if (!audio.ctx || audio.ctx.state !== 'running' || audio.isMuted()) return;
    const t = ev.target.closest('.primary-btn, .chip-btn, .suspect-card, .accuse-card, .present-item, .evidence-check, .map-g, .hotspot');
    if (!t) return;
    const now = performance.now();
    if (now - lastHoverSfx > 120) { lastHoverSfx = now; audio.hover(); }
  });

  document.querySelectorAll('.modal-close, .modal').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('modal-close') || ev.target.classList.contains('modal')) {
        el.closest('.modal').classList.add('hidden');
        audio.click();
      }
    });
  });

  // 游戏内确认/输入弹窗：✕ / 遮罩关闭 → 视为取消（promise 收口）
  const confirmModal = $('modal-confirm');
  if (confirmModal) confirmModal.addEventListener('click', (ev) => {
    if ((ev.target.classList.contains('modal-close') || ev.target.classList.contains('modal')) && activeConfirmCancel) {
      activeConfirmCancel();
    }
  });
  const promptModal = $('modal-prompt');
  if (promptModal) promptModal.addEventListener('click', (ev) => {
    if ((ev.target.classList.contains('modal-close') || ev.target.classList.contains('modal')) && activePromptCancel) {
      activePromptCancel();
    }
  });

  $('btn-to-interrogate').addEventListener('click', () => { audio.click(); gotoInterrogate(); });
  $('btn-back-invest').addEventListener('click', () => { audio.click(); gotoInvest(); });
  $('btn-to-verdict').addEventListener('click', () => { audio.click(); gotoAccuse(); });
  $('btn-accuse-back').addEventListener('click', () => { audio.click(); gotoInterrogate(); });
  $('btn-accuse-submit').addEventListener('click', async () => {
    const s = suspectById(state.accused);
    const ok = await gameConfirm(
      `你将当众指认【${s ? s.name : '？'}】为毁画伤人者。\n这个指控不可撤回。确定吗？`,
      { title: '庄严指认 ⚖', okText: '确认指认', cancelText: '再想想', danger: true },
    );
    if (ok) runFinal();
  });
  $('btn-restart').addEventListener('click', async () => {
    const ok = await gameConfirm('清空本局进度，从头开始？', { title: '重玩本局', okText: '确认重玩', danger: true });
    if (ok) {
      storage.removeItem(SAVE_KEY);
      location.reload();
    }
  });

  const input = $('dialog-input');
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') sendQuestion();
  });
  /* 移动端软键盘：弹出时把最新气泡与输入区滚入可视范围，避免遮挡（规范 §7 验证项） */
  const keepDialogVisible = () => {
    const stream = $('dialog-stream');
    if (stream) stream.scrollTop = stream.scrollHeight;
  };
  input.addEventListener('focus', () => {
    setTimeout(() => {
      keepDialogVisible();
      input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 260);
  });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', keepDialogVisible);
  }
  $('btn-send').addEventListener('click', () => {
    audio.click();
    sendQuestion();
  });
}

/** AI 门禁：未接入任何通道时阻断，弹窗「重试」成功后再执行原动作 */
function requireAI(onReady) {
  if (aiActive()) return true; // AI 可用 → 调用方继续原有流程（不再重复调用回调，避免递归）
  showAiBlockedModal(
    '当前未接入任何 AI 通道——本作仅支持 AI 模式，嫌疑人必须由大模型实时扮演。请配置免费通道或自定义 Key 后再试。',
    () => { if (aiActive() && typeof onReady === 'function') onReady(); },
  );
  return false;
}

async function boot() {
  // 探测失败不得阻断任何后续初始化(按钮事件绑定、设置面板、存档加载都必须执行)
  try {
    await aiSettings.init();
    await probeProxy();          // v3.2 · 探测同源免费通道（不可用时设置面板自动置灰）
    // 冷启动竞态:页面加载可能早于后端就绪,失败时短退避重试一次,避免误标"未接入 AI"
    if (!proxyState.available && !aiSettings.hasToken()) {
      await new Promise((r) => setTimeout(r, 500));
      await probeProxy();
    }
  } catch (e) { /* 忽略:初始化继续 */ }
  bindEvents();
  initSettings();
  syncEndpointUI();              // 探测结果同步到设置面板
  updateAIBadge();
  updateIntroAICard();
  initVisualizerAndAudioControls();
  audio.initLifecycle();         // 切后台挂起 / 回前台平滑恢复
  initModalAccessibility();      // 弹窗焦点圈定 / ESC 关闭 / 焦点归还
  initLoadQueueUI();
  initTokenSafety();

  const has = load();
  setupIntroGateway(has);
  updateNotebookCount(); // load 之后刷新线索册计数（有存档时顶栏显示真实进度）
}

boot();
