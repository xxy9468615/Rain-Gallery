/* ============================================================
 * 魔搭 API-Inference 客户端（OpenAI 兼容格式）· v3.0 双通道
 * ------------------------------------------------------------
 * AI 接口来源（设置面板可选，默认免费内置）：
 *   🎁 free    同源代理 /api/chat、/api/judge（作品创空间后端持有平台 Key，
 *              免配置；后端仅做额度计数、不记录对话内容，代码开源可查）
 *   🔑 custom  玩家自填魔搭 Token，浏览器直连官方端点（一人一 Key）
 * 任一通道失败自动回退另一通道；都不可用则阻断游戏——本作仅支持 AI 模式。
 *
 * 零日志安全（仅适用于自定义 Key 直连模式）：
 * 1. 控制台强制静默与敏感特征脱敏拦截（Console Privacy Guard）
 * 2. 双存储模式：纯内存阅后即焚 / WebCrypto AES-GCM-256 加密持久化
 * 3. 内存覆写安全销毁（Zero-Fill Wipe）
 * 4. 网络出站单向沙箱守卫（协议 / 格式 / 可选域名白名单校验）
 * 5. 负载排队层：并发闸门 + 限流指数退避重试
 *
 * 测试钩子：URL 带 ?mockai=1 时所有调用走本地 mock（不发出网络请求），
 * 供自动化端到端测试在无 Key 环境驱动 NPC 行动分支。
 * ============================================================ */

import { storage } from './storage.js?v=3.6.0';

/**
 * 自定义端点（v3.5）
 * ------------------------------------------------------------
 * 默认仍是魔搭官方端点；玩家可在设置里改成任意 OpenAI 兼容端点
 * （自建网关 / 其他厂商 / 本地推理服务）。
 *
 * 安全模型（重要）：
 *   过去写死单一域名做白名单，导致换一家服务商就得改代码。
 *   现在改为「协议 + 格式 + 可选域名白名单」三段校验：
 *     1) 只允许 https:（本地开发可显式填 http:// 并自行承担风险）
 *     2) 路径必须以 /chat/completions 结尾（OpenAI 兼容格式）
 *     3) 可选：玩家自行维护域名白名单；留空则不限制域名（但仍有 1、2 约束）
 *   同时禁止 URL 中夹带凭据（user:pass@host）。
 */
const LS_ENDPOINT_URL = 'rain-gallery-endpoint-url';
const LS_ENDPOINT_WHITELIST = 'rain-gallery-endpoint-whitelist';

/** 魔搭官方端点（默认值，也是"恢复默认"的选项） */
export const DEFAULT_ENDPOINT_URL = 'https://api-inference.modelscope.cn/v1/chat/completions';
/** 预置常见服务商，方便一键选择 */
export const ENDPOINT_PRESETS = [
  { id: 'modelscope', label: '魔搭 ModelScope（官方）', url: 'https://api-inference.modelscope.cn/v1/chat/completions' },
  { id: 'custom', label: '自定义端点…', url: '' },
];

/**
 * 免费通道代理基址（v3.6）
 * ------------------------------------------------------------
 * 默认同源（/api/*），适合后端与前端同域部署（如魔搭创空间）。
 * 静态托管（如 GitHub Pages）时填独立后端的完整地址即可跨域访问，
 * 服务端需开启 CORS（app.py 已支持，通过 CORS_ALLOWED_ORIGINS 白名单约束）。
 * 留空则回退同源相对路径。
 */
const LS_PROXY_BASE = 'rain-gallery-proxy-base';

export function getProxyBase() {
  const v = (storage.getItem(LS_PROXY_BASE) || '').trim().replace(/\/+$/, '');
  return v;
}

/** 归一化为可直接拼接 /api/* 的根址（origin）。非法输入返回 ''（同源回退）。 */
export function normalizeProxyBase(url) {
  const check = validateProxyBase(url);
  return check.ok ? (check.origin || '') : '';
}

export function setProxyBase(url) {
  const clean = normalizeProxyBase(url);
  if (!clean) { storage.removeItem(LS_PROXY_BASE); return ''; }
  storage.setItem(LS_PROXY_BASE, clean);
  return clean;
}

/**
 * 校验代理基址：绝对 URL + http(s) + 不含凭据 + 纯根址
 * ------------------------------------------------------------
 * 只接受「根地址」——即 scheme://host[:port]，不得带：
 *   - 路径        （https://host/api  →  /api/chat 会被拼成 /api/api/chat）
 *   - 查询参数    （https://host?x=1  →  /api/chat 落进 ? 后面）
 *   - 片段        （https://host#x    →  浏览器根本不会把它发出去）
 *   - userinfo    （https://u:p@host → 可能被 SDK / 代理当作凭据使用）
 * 合法时返回归一化后的 origin 供落盘，拼接 proxyUrl(path) 才不会出意外。
 */
export function validateProxyBase(url) {
  const raw = String(url || '').trim().replace(/\/+$/, '');
  if (!raw) return { ok: true, message: '同源（默认）' };
  let u;
  try { u = new URL(raw); } catch (e) {
    return { ok: false, message: '不是合法的 URL' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, message: `不支持的协议：${u.protocol}` };
  }
  if (u.username || u.password) {
    return { ok: false, message: 'URL 中不能包含账号密码' };
  }
  if (u.search) {
    return { ok: false, message: '只填基址（如 https://host），不要带查询参数' };
  }
  if (u.hash) {
    return { ok: false, message: '只填基址（如 https://host），不要带片段（#…）' };
  }
  if (u.pathname && u.pathname !== '/') {
    return { ok: false, message: '只填基址（如 https://host），不要带路径' };
  }
  return { ok: true, message: 'ok', origin: u.origin };
}

const proxyUrl = (path) => {
  const base = getProxyBase();
  return base ? `${base}${path}` : path;
};

const PROXY_CHAT_PATH = '/api/chat';
const PROXY_JUDGE_PATH = '/api/judge';
const PROXY_STATUS_PATH = '/api/status';

/** /api/status 探测超时：探测失败不得卡住 boot() 之后的初始化 */
const PROBE_TIMEOUT_MS = 8000;

/** 当前自定义端点（带容错读取与归一化） */
export function getEndpointUrl() {
  const v = (storage.getItem(LS_ENDPOINT_URL) || '').trim();
  return v || DEFAULT_ENDPOINT_URL;
}

export function setEndpointUrl(url) {
  const clean = String(url || '').trim();
  if (!clean) { storage.removeItem(LS_ENDPOINT_URL); return DEFAULT_ENDPOINT_URL; }
  storage.setItem(LS_ENDPOINT_URL, clean);
  return clean;
}

/** 域名白名单（换行或逗号分隔；空 = 不限制域名） */
export function getEndpointWhitelist() {
  const raw = (storage.getItem(LS_ENDPOINT_WHITELIST) || '').trim();
  return raw.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function setEndpointWhitelist(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[\s,]+/);
  const clean = arr.map((s) => String(s).trim().toLowerCase()).filter(Boolean);
  if (!clean.length) storage.removeItem(LS_ENDPOINT_WHITELIST);
  else storage.setItem(LS_ENDPOINT_WHITELIST, clean.join('\n'));
  return clean;
}

/**
 * 端点安全校验。返回 { ok, message, origin }
 *  - 必须是绝对 URL 且协议为 http/https
 *  - 路径需以 /chat/completions 结尾（OpenAI 兼容）
 *  - 禁止 userinfo（user:pass@host）
 *  - 若设置了域名白名单，hostname 必须在其中
 */
export function validateEndpointUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return { ok: false, message: '端点地址不能为空' };
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return { ok: false, message: '不是合法的 URL（需以 http:// 或 https:// 开头）' };
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    return { ok: false, message: `不支持的协议：${u.protocol}（仅允许 http/https）` };
  }
  if (u.username || u.password) {
    return { ok: false, message: 'URL 中不能包含账号密码（请把 Token 填在专用输入框）' };
  }
  if (!/\/chat\/completions\/?$/.test(u.pathname)) {
    return { ok: false, message: '路径需为 OpenAI 兼容的 /chat/completions 结尾' };
  }
  const whitelist = getEndpointWhitelist();
  if (whitelist.length && !whitelist.includes(u.hostname.toLowerCase())) {
    return { ok: false, message: `域名 ${u.hostname} 不在白名单中` };
  }
  return { ok: true, message: 'ok', origin: u.origin, hostname: u.hostname };
}

/** ?mockai=1 —— 确定性 mock 通道（自动化测试用，不出网） */
export const MOCK_AI = typeof location !== 'undefined'
  && new URLSearchParams(location.search).has('mockai');

/**
 * 可选手搓模型（仅「自定义 Key」模式可选）。
 * ------------------------------------------------------------
 * 2026-11 实测选型：免费通道上游 generalcompute.com 提供的 3 个模型，
 * 用真实 SUSPECT_PLAY prompt 各跑 4 轮压力场景：
 *   gemma-4-31B-it      JSON 4/4 · 阶段自洽 3/4 · 均值 2.5s  ← 默认
 *   gpt-oss-120b        JSON 1/4 · 均值 4.2s（出现过 13s）  ← 备用
 *   minimax-m3.1-flash  无 JSON 输出
 * 所以默认只列 gemma，备用列 gpt-oss-120b；其余一概下架，
 * 玩家也可在「自定义模型 ID…」手填任意 ID（存什么读什么）。
 */
export const MODEL_OPTIONS = [
  { id: 'gemma-4-31B-it', label: 'gemma-4-31B-it（默认 · 免费通道在用）' },
  { id: 'gpt-oss-120b', label: 'gpt-oss-120b（备用 · 默认端点抖动时切换）' },
];

export const STORAGE_MODE = {
  MEMORY: 'memory',       // 纯内存驻留：刷新/关网页即焚，磁盘0留存
  ENCRYPTED: 'encrypted', // 本地 AES-GCM-256 位硬件级加密存储
};

const LS_TOKEN_ENC = 'rain-gallery-token-enc';
const LS_SALT = 'rain-gallery-salt';
const LS_MODE = 'rain-gallery-mode';
const LS_MODEL = 'rain-gallery-model';
const LS_ENDPOINT_MODE = 'rain-gallery-endpoint-mode'; // free | custom
const LS_SESSION_ID = 'rain-gallery-session-id';       // 一局一会话（代理计额单位）

// ------------------------------------------------------------
// 1. 控制台强制静默与敏感特征脱敏拦截器（Console Privacy Guard）
// ------------------------------------------------------------
(function installConsolePrivacyGuard() {
  if (typeof window === 'undefined') return;
  const TOKEN_REGEX = /(?:ms-[a-zA-Z0-9_-]{12,}|Bearer\s+[a-zA-Z0-9_\-\.]{12,})/gi;

  function sanitize(val) {
    if (typeof val === 'string') {
      return val.replace(TOKEN_REGEX, '[PROTECTED_TOKEN]');
    }
    if (val && typeof val === 'object') {
      try {
        const str = JSON.stringify(val);
        if (TOKEN_REGEX.test(str)) {
          return JSON.parse(str.replace(TOKEN_REGEX, '[PROTECTED_TOKEN]'));
        }
      } catch (e) { /* ignore circular */ }
    }
    return val;
  }

  const originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };

  ['log', 'info', 'warn', 'error', 'debug'].forEach((level) => {
    const orig = originalConsole[level] || console.log;
    console[level] = function (...args) {
      const sanitized = args.map(sanitize);
      orig.apply(console, sanitized);
    };
  });
})();

// ------------------------------------------------------------
// 2. Web Cryptography（AES-GCM-256 + PBKDF2）加密与派生工具
// ------------------------------------------------------------
function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuf(hex) {
  if (!hex || hex.length % 2 !== 0) return new Uint8Array(0);
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    arr[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return arr;
}

function getOrCreateSalt() {
  let saltHex = storage.getItem(LS_SALT);
  if (!saltHex || saltHex.length < 32) {
    const saltBuf = crypto.getRandomValues(new Uint8Array(16));
    saltHex = bufToHex(saltBuf);
    storage.setItem(LS_SALT, saltHex);
  }
  return hexToBuf(saltHex);
}

async function deriveAesKey(saltBytes) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode('RainGallery::ModelScope::ZeroLog::Shield::v2'),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: saltBytes,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptToken(plainText) {
  if (!plainText) return '';
  if (!crypto?.subtle) {
    // 极端环境降级为简单混淆（现代浏览器均支持 WebCrypto）
    return 'b64:' + btoa(encodeURIComponent(plainText));
  }
  const salt = getOrCreateSalt();
  const key = await deriveAesKey(salt);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    enc.encode(plainText)
  );
  return `${bufToHex(iv)}:${bufToHex(new Uint8Array(ciphertext))}`;
}

async function decryptToken(payload) {
  if (!payload) return '';
  if (payload.startsWith('b64:')) {
    try { return decodeURIComponent(atob(payload.slice(4))); } catch (e) { return ''; }
  }
  if (!payload.includes(':') || !crypto?.subtle) return '';
  try {
    const [ivHex, ctHex] = payload.split(':');
    const iv = hexToBuf(ivHex);
    const ct = hexToBuf(ctHex);
    const salt = getOrCreateSalt();
    const key = await deriveAesKey(salt);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ct
    );
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '';
  }
}

// ------------------------------------------------------------
// 3. 内存驻留与双模式凭证管理器（Token State Manager）
// ------------------------------------------------------------
let memoryToken = '';
let memoryModel = '';
let initialized = false;

export const aiSettings = {
  /** 异步初始化（读取加密存储并加载到闭包内存） */
  async init() {
    if (initialized) return;
    initialized = true;

    // 检查是否有旧版本明文 Token，如有则平滑迁移为加密存储并清除明文
    const legacyPlain = storage.getItem('rain-gallery-token');
    if (legacyPlain && legacyPlain.startsWith('ms-')) {
      await this.setToken(legacyPlain, STORAGE_MODE.ENCRYPTED);
      storage.removeItem('rain-gallery-token');
      return;
    }

    // 检查加密持久化
    const mode = this.getStorageMode();
    if (mode === STORAGE_MODE.ENCRYPTED) {
      try {
        const encPayload = storage.getItem(LS_TOKEN_ENC);
        if (encPayload) {
          memoryToken = await decryptToken(encPayload);
        }
      } catch (e) {
        memoryToken = '';
      }
    }
  },

  /** 同步获取当前内存中的 Token */
  getToken() {
    return memoryToken || '';
  },

  /** 存储模式（memory 或 encrypted） */
  getStorageMode() {
    return storage.getItem(LS_MODE) || STORAGE_MODE.ENCRYPTED;
  },

  setStorageMode(mode) {
    storage.setItem(LS_MODE, mode);
  },

  /**
   * 保存 Token
   * @param {string} token 原始 Token
   * @param {string} mode 存储模式 (memory | encrypted)
   */
  async setToken(token, mode = null) {
    const clean = (token || '').trim();
    memoryToken = clean;

    const targetMode = mode || this.getStorageMode();
    this.setStorageMode(targetMode);

    if (targetMode === STORAGE_MODE.ENCRYPTED && clean) {
      const enc = await encryptToken(clean);
      storage.setItem(LS_TOKEN_ENC, enc);
    } else {
      // 纯内存模式，确保存储无残留
      storage.removeItem(LS_TOKEN_ENC);
    }
  },

  /** 物理覆写并安全销毁凭证（Zero-Fill Wipe） */
  clearToken() {
    // 内存覆写覆盖
    if (memoryToken) {
      const dummy = '0'.repeat(memoryToken.length);
      memoryToken = dummy;
    }
    memoryToken = '';
    storage.removeItem(LS_TOKEN_ENC);
    storage.removeItem('rain-gallery-token');
  },

  /**
   * 读取当前模型 ID。语义：存什么读什么。
   * 白名单 MODEL_OPTIONS 只决定「首次进入的默认值」，不作为过滤条件——
   * 过去这里要求 memoryModel / saved 必须在白名单内或以 'custom:' 开头，
   * 导致玩家在设置里手填的模型 ID（如 glm-4-plus）每次都被静默重置回默认值：
   * 玩家以为换了模型，实际请求一直在打默认模型。
   * obsolete 列表仍生效（已从上游下线的旧 ID 重置为默认）。
   */
  getModel() {
    if (memoryModel) return memoryModel;
    const saved = storage.getItem(LS_MODEL);
    const obsolete = ['Qwen/Qwen3-8b', 'Qwen/Qwen2.5-7B-Instruct', 'deepseek-ai/DeepSeek-V3.1', 'ZhipuAI/GLM-4-9B-0414-Flash'];
    if (!saved || obsolete.includes(saved)) {
      storage.setItem(LS_MODEL, MODEL_OPTIONS[0].id);
      return MODEL_OPTIONS[0].id;
    }
    return saved;
  },

  setModel(m) {
    const clean = String(m || '').trim();
    memoryModel = clean;
    storage.setItem(LS_MODEL, clean);
    return clean;
  },

  hasToken() {
    return this.getToken().length > 8;
  },
};

/* ============================================================
 * 3.5 AI 接口来源选择（v3.0：默认免费内置代理，可切自定义 Key）
 *    - free   ：同源 /api/chat 代理（创空间后端持 Key，免配置）
 *    - custom ：玩家自填 Token 直连官方端点（一人一 Key）
 * ============================================================ */

export const ENDPOINT_MODE = { FREE: 'free', CUSTOM: 'custom' };

/** 免费通道状态（/api/status 探测结果） */
export const proxyState = {
  available: false,
  model: '',
  sessionCap: 150,
  sessionUsed: 0,
  checked: false,
};

export function getEndpointMode() {
  const v = storage.getItem(LS_ENDPOINT_MODE);
  return v === ENDPOINT_MODE.CUSTOM ? ENDPOINT_MODE.CUSTOM : ENDPOINT_MODE.FREE;
}

export function setEndpointMode(mode) {
  storage.setItem(LS_ENDPOINT_MODE, mode === ENDPOINT_MODE.CUSTOM ? 'custom' : 'free');
}

/** 一局一会话：代理端按会话计额；重开局时由游戏调用 rotateSessionId() 换新 */
export function getSessionId() {
  let sid = storage.getItem(LS_SESSION_ID);
  if (!sid) {
    sid = (crypto.randomUUID ? crypto.randomUUID() : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2));
    storage.setItem(LS_SESSION_ID, sid);
  }
  return sid;
}

export function rotateSessionId() {
  storage.removeItem(LS_SESSION_ID);
  // 换新会话的同时把本局计数归零：否则「本局剩余 N 次」会沿用上一局的消耗，
  // 玩家看到的是一个对不上的数字（后端已按新会话重新计额，前端却还在扣旧的）。
  proxyState.sessionUsed = 0;
  return getSessionId();
}

/**
 * 探测免费通道（file:// / 纯静态托管 / 后端不可达时置灰）
 * ------------------------------------------------------------
 * 必须带超时：boot() 的顺序是「await 探测 → bindEvents()/initSettings()」，
 * 若填了独立后端基址而该后端把 /api/status 挂住不返回，页面会一直停在探测前——
 * 玩家连设置面板都打不开，也就没机会改回基址。因此 fetch 与 resp.json 都套
 * AbortController 超时，超时后走下面既有的失败分支（available=false），
 * 启动流程继续执行。
 */
export async function probeProxy() {
  if (MOCK_AI) { // mock 模式视同免费通道可用，便于全链路测试
    proxyState.available = true;
    proxyState.model = 'mock-model';
    proxyState.checked = true;
    return { ...proxyState };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(proxyUrl(PROXY_STATUS_PATH), {
      headers: { 'X-Session-Id': getSessionId() },
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(String(resp.status));
    const data = await resp.json();
    proxyState.available = !!data.available;
    proxyState.model = data.model || '';
    proxyState.sessionCap = data.sessionCap || 150;
    proxyState.sessionUsed = data.sessionUsed || 0;
  } catch (e) {
    // AbortError（超时）与网络错误同等对待：置灰，交由 requireAI 引导玩家去设置
    proxyState.available = false;
  } finally {
    clearTimeout(timer);
    proxyState.checked = true;
  }
  return { ...proxyState };
}

/** 当前是否处于可用 AI 状态（任一通道可用且被选中） */
export function aiActive() {
  if (MOCK_AI) return true;
  const mode = getEndpointMode();
  if (mode === ENDPOINT_MODE.CUSTOM) return aiSettings.hasToken() || proxyState.available;
  return proxyState.available || aiSettings.hasToken();
}

/** 徽标文案：「🎁 免费AI·模型」/「🔑 自有Key·模型」/「⚠ 未接入 AI」 */
export function describeEndpoint() {
  if (MOCK_AI) return '🧪 Mock·AI';
  const mode = getEndpointMode();
  if (mode === ENDPOINT_MODE.CUSTOM) {
    if (aiSettings.hasToken()) return `🔑 自有Key·${aiSettings.getModel().split('/').pop()}`;
    if (proxyState.available) return `🎁 免费AI·${(proxyState.model || '').split('/').pop() || '内置'}`;
    return '⚠ 未接入 AI';
  }
  if (proxyState.available) return `🎁 免费AI·${(proxyState.model || '').split('/').pop() || '内置'}`;
  if (aiSettings.hasToken()) return `🔑 自有Key·${aiSettings.getModel().split('/').pop()}`;
  return '⚠ 未接入 AI';
}

/** 最近一次 chatCompletion 实际使用的通道（suspect-ai 用于标注 mode/note） */
let _lastTransport = { transport: 'none', model: '' };
export function lastTransport() { return { ..._lastTransport }; }

// ------------------------------------------------------------
// 4. 网络出站单向沙箱守卫与调用
// ------------------------------------------------------------
/**
 * 剥离推理模型返回的思维链段落。玩家看到的是「台词」，不是模型的内心独白。
 * 覆盖四种形态，任一漏掉都会把推理原文怼到玩家脸上：
 *   1. 闭合 <think> ... </think>：整段删除（非贪婪，遇首个闭合标签即停）
 *   2. 未闭合 <think>：模型被 max_tokens 截断时只剩开标签，其后全是残留，切到结尾
 *   3. <|begin_of_thought|> ... <|end_of_thought|>：整段删除（早期实现只删标记不删内容）
 *   4. 落单的起止标记：兜底把标记字符本身删掉
 */
export function stripThinking(text) {
  const raw = String(text || '');
  if (!raw) return '';
  return raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/<\|begin_of_thought\|>[\s\S]*?(?:<\|end_of_thought\|>|$)/gi, '')
    .replace(/<\|?(?:begin|end)_of_thought\|>/gi, '')
    .trim();
}

/** 魔搭访问令牌格式校验（ms- 前缀，主体 ≥12 位） */
export function validateTokenFormat(token) {
  return /^ms-[A-Za-z0-9_-]{12,}$/.test(String(token || '').trim());
}

/**
 * 流式思维链剥离器（有状态，跨 chunk）。
 * ------------------------------------------------------------
 * 正确做法必须基于**累积原文**：标记和正文会被拆进不同的 SSE chunk，
 * 逐 chunk 调 stripThinking 会四连漏（实测被 CodeRabbit 抓到）：
 *   1. 首个 chunk 只有开标签 → 被"未闭合"规则整段吃掉，正文永不出现
 *   2. 后续纯思维链 chunk 不含任何标签 → 原样漏给玩家
 *   3. 单独到达的闭标签不匹配任何规则 → 作为字面文本漏出
 *   4. 逐 chunk 的 .trim() 会吃掉英文单词间的空格（" world"→"world"）
 *
 * 策略：累积原始文本 → 对累积串整体 stripThinking → 与上次已确认输出
 * 的干净长度做前缀差分 → 只把新增部分发给 onDelta。
 * 末尾若有未闭合的 `<…` 暂扣不发（标签可能被拆在 chunk 边界），
 * 等下一 chunk 到齐或流结束时再放行。
 */
export function createStreamSanitizer() {
  let raw = '';        // 累积原文
  let cleanLen = 0;     // 已确认输出的干净前缀长度
  return {
    /** 喂入一个 chunk 的原始正文，返回本段新增的干净文本（可能为空串） */
    push(piece) {
      raw += piece;
      // 末尾悬挂着未闭合的 `<`：标签可能被拆在 chunk 边界，整段暂扣
      const hangIdx = raw.lastIndexOf('<');
      const safeEnd = (hangIdx >= 0 && raw.indexOf('>', hangIdx) < 0) ? hangIdx : raw.length;
      const clean = stripThinking(raw.slice(0, safeEnd));
      // stripThinking 带 trim：干净前缀不会以空白结尾，直接按长度截新增段
      if (clean.length <= cleanLen) return '';
      const fresh = clean.slice(cleanLen);
      cleanLen = clean.length;
      return fresh;
    },
    /** 流结束：对完整原文做最终剥离（此前被暂扣的尾巴在此放行） */
    flush() {
      const clean = stripThinking(raw);
      const fresh = clean.length > cleanLen ? clean.slice(cleanLen) : '';
      cleanLen = clean.length;
      raw = clean;   // 后续若还有人调用也不会重复输出
      return fresh;
    },
  };
}

/**
 * 从一条 SSE chunk 里取出本段**原始**正文（不做剥离）。
 * ------------------------------------------------------------
 * 剥离由调用方持有的 createStreamSanitizer() 实例做（跨 chunk 有状态）。
 * 三种上游形态都覆盖：
 *   - delta.content             绝大多数 OpenAI 兼容上游
 *   - delta.message.content     合帧场景（上游把整条 message 塞进 delta）
 */
function sseDeltaPiece(parsed) {
  const delta = parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].delta;
  if (!delta) return '';
  if (typeof delta.content === 'string') return delta.content;
  if (typeof delta.message === 'object' && delta.message
      && typeof delta.message.content === 'string') {
    return delta.message.content;
  }
  return '';
}

// ------------------------------------------------------------
// 5. 负载排队层（多人在线场景：并发闸门 + 限流指数退避重试）
//    - 同浏览器并发闸门：最多 MAX 个在途请求，超出按 FIFO 排队
//    - 429 / 5xx / 网络错误：读取 Retry-After（优先）或指数退避自动重试
//    - 重试耗尽后抛出原有结构化错误 → 调用方阻断并提示重试（游戏仅支持 AI）
// ------------------------------------------------------------
const LOAD_GATE = { active: 0, MAX: 2, queue: [] };

export const loadState = {
  phase: 'idle',        // idle | gate（并发排队） | queued（限流退避） | running
  depth: 0,             // 闸门等待队列长度
  attempt: 0,           // 当前重试次数
  waitMs: 0,            // 本次等待毫秒数
  reason: '',           // gate | RATE_LIMIT | HTTP_5xx | NETWORK
};

const loadListeners = new Set();
export function onLoadState(cb) {
  if (typeof cb === 'function') loadListeners.add(cb);
  return () => loadListeners.delete(cb);
}
function emitLoadState(patch = {}) {
  Object.assign(loadState, patch);
  loadState.depth = LOAD_GATE.queue.length;
  loadListeners.forEach((cb) => { try { cb({ ...loadState }); } catch (e) { /* ignore */ } });
}

function acquireGate(signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      const i = LOAD_GATE.queue.indexOf(tryAcquire);
      if (i >= 0) {
        LOAD_GATE.queue.splice(i, 1);
        emitLoadState({ depth: LOAD_GATE.queue.length });
      }
      reject({ code: 'ABORT', message: '请求已取消' });
    };
    const tryAcquire = () => {
      if (signal && signal.aborted) { onAbort(); return; }
      if (LOAD_GATE.active < LOAD_GATE.MAX) {
        LOAD_GATE.active++;
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      } else {
        LOAD_GATE.queue.push(tryAcquire);
        emitLoadState({ phase: 'gate', reason: 'gate', depth: LOAD_GATE.queue.length });
      }
    };
    // 超时中止时把仍在排队的请求撤出队列，避免它之后白占一个槽位
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    tryAcquire();
  });
}

function releaseGate() {
  LOAD_GATE.active = Math.max(0, LOAD_GATE.active - 1);
  const next = LOAD_GATE.queue.shift();
  emitLoadState({ depth: LOAD_GATE.queue.length, ...(next ? { phase: 'running' } : {}) });
  if (next) setTimeout(next, 0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const parseRetryAfter = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(10000, n * 1000) : 0;
};
function isRetryableError(err) {
  const code = String(err && err.code || '');
  return code === 'RATE_LIMIT' || code === 'NETWORK' || /^HTTP_5/.test(code) || code === 'HTTP_429';
}

/** 单次原始请求 · 🔑 自定义 Key 直连（端点可在设置中配置，一人一 Key，零中转） */
async function _rawDirect(messages, opts = {}) {
  // 出站安全校验：协议 / 路径格式 / 可选域名白名单（见 validateEndpointUrl）
  const endpoint = getEndpointUrl();
  const check = validateEndpointUrl(endpoint);
  if (!check.ok) {
    throw { code: 'SECURITY_BLOCKED', message: `端点校验未通过：${check.message}` };
  }
  const token = opts.token || aiSettings.getToken();
  if (!token) throw { code: 'NO_TOKEN', message: '未配置 API Token' };

  const model = opts.model || aiSettings.getModel();
  const body = {
    model,
    messages,
    temperature: opts.temperature ?? 0.8,
    max_tokens: opts.maxTokens ?? 420,
    stream: false,
  };

  let resp;
  try {
    resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw { code: 'ABORT', message: '请求已取消' };
    throw { code: 'NETWORK', message: '网络错误或跨域被拦截：' + (e.message || e) };
  }

  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 160); } catch (e) { /* ignore */ }
    const retryAfter = parseRetryAfter(resp.headers && resp.headers.get('retry-after'));
    if (resp.status === 401 || resp.status === 403) {
      throw { code: 'BAD_TOKEN', message: `Token 无效或权限缺失（请确认勾选了 API-Inference 权限，HTTP ${resp.status}）` };
    }
    if (resp.status === 429) {
      throw { code: 'RATE_LIMIT', message: '调用太频繁（HTTP 429），已自动排队重试', retryAfterMs: retryAfter };
    }
    if (resp.status >= 500) {
      throw { code: `HTTP_${resp.status}`, message: `模型服务繁忙（HTTP ${resp.status}），已自动排队重试`, retryAfterMs: retryAfter };
    }
    throw { code: `HTTP_${resp.status}`, message: `模型服务返回 ${resp.status}：${detail}` };
  }

  let data;
  try { data = await resp.json(); }
  catch (e) { throw { code: 'BAD_JSON', message: '返回数据解析失败' }; }

  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const cleaned = stripThinking(content);
  if (!cleaned) throw { code: 'EMPTY', message: '模型返回为空' };
  return cleaned;
}

/** 单次原始请求 · 🎁 免费通道同源代理（平台 Key 在服务端，前端零凭证） */
async function _rawProxy(messages, opts = {}) {
  const judge = opts.kind === 'judge';
  const body = {
    messages,
    temperature: opts.temperature ?? 0.8,
    maxTokens: opts.maxTokens ?? 420,
  };
  let resp;
  try {
    resp = await fetch(judge ? proxyUrl(PROXY_JUDGE_PATH) : proxyUrl(PROXY_CHAT_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e && e.name === 'AbortError') throw { code: 'ABORT', message: '请求已取消' };
    throw { code: 'NETWORK', message: '免费通道网络错误：' + (e.message || e) };
  }

  if (!resp.ok) {
    let payload = null; let detail = '';
    try {
      const text = await resp.text();
      detail = text.slice(0, 160);
      try { payload = JSON.parse(text); } catch (e) { /* 非 JSON */ }
    } catch (e) { /* ignore */ }
    const code = (payload && payload.error && payload.error.code) || `HTTP_${resp.status}`;
    const message = (payload && payload.error && payload.error.message) || detail || `免费通道返回 ${resp.status}`;
    const retryAfter = parseRetryAfter(resp.headers && resp.headers.get('retry-after'));
    // 上游限流 → 可重试；配额/配置类错误 → 致命（切换通道或阻断提示）
    if (resp.status === 429 && code === 'RATE_LIMIT') {
      throw { code: 'RATE_LIMIT', message, retryAfterMs: retryAfter };
    }
    if (['SESSION_LIMIT', 'GLOBAL_LIMIT', 'IP_LIMIT', 'PROXY_UNAVAILABLE', 'UPSTREAM_AUTH'].includes(code)) {
      throw { code, message };
    }
    if (resp.status >= 500) {
      throw { code: `HTTP_${resp.status}`, message, retryAfterMs: retryAfter };
    }
    throw { code, message };
  }

  let data;
  try { data = await resp.json(); }
  catch (e) { throw { code: 'BAD_JSON', message: '返回数据解析失败' }; }

  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  const cleaned = stripThinking(content);
  if (!cleaned) throw { code: 'EMPTY', message: '模型返回为空' };
  return cleaned;
}

/** 🧪 mock 通道：从 window.__rgMock.queue 取脚本化决策（自动化测试驱动行动分支）
 *  裁判与主调用并行发出：主调用 shift 本轮脚本，裁判读取同一轮脚本里的 judge 字段 */
function mockChat(messages, opts) {
  const store = (typeof window !== 'undefined') ? window.__rgMock : null;
  if (opts.kind === 'judge') {
    const cur = store && store.last;
    const obj = (cur && typeof cur === 'object' && cur.judge) ? cur.judge : { tag: null, confidence: 0, reason: '未命中' };
    return Promise.resolve(JSON.stringify(obj));
  }
  const q = (store && Array.isArray(store.queue)) ? store.queue : [];
  const scripted = q.length ? q.shift() : null;
  if (store) store.last = scripted;
  if (typeof scripted === 'string') return Promise.resolve(scripted);
  if (scripted && typeof scripted === 'object') return Promise.resolve(JSON.stringify(scripted));
  return Promise.resolve(JSON.stringify({ reply: '（看了你一眼，指节轻敲桌面）……继续说，我在听。', action: 'none', trust_delta: 0, hostility_delta: 0 }));
}

/** 排队 + 限流退避编排（通道选择在外层 chatCompletion） */
async function chatWithRetry(messages, opts, rawFn) {
  const maxRetries = opts.noQueue ? 0 : 3;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await acquireGate(opts.signal);
    let result;
    try {
      emitLoadState({ phase: 'running', attempt, waitMs: 0, reason: '' });
      result = await rawFn(messages, opts);
    } catch (err) {
      lastErr = err;
      const canRetry = attempt < maxRetries && isRetryableError(err);
      if (!canRetry) {
        emitLoadState({ phase: 'idle', attempt: 0, waitMs: 0, reason: '' });
        throw err;
      }
      const backoff = Math.min(10000, err.retryAfterMs || 2000 * Math.pow(2, attempt));
      emitLoadState({
        phase: 'queued', attempt: attempt + 1, waitMs: backoff,
        reason: String(err.code || ''), depth: LOAD_GATE.queue.length,
      });
      await sleep(backoff);
      continue; // 携带 lastErr 进入下一次尝试
    } finally {
      releaseGate();
    }
    emitLoadState({ phase: 'idle', attempt: 0, waitMs: 0, reason: '' });
    return result;
  }
  throw lastErr; // 防御性兜底（循环内必 return 或 throw）
}

/**
 * 调用 AI（双通道 + 负载排队 + 限流自动重试）
 * 通道优先级：
 *   - 强制 opts.transport = 'direct' | 'proxy' 时只用该通道（测试 / testConnection 用）
 *   - 否则按「接口来源」选择：custom → 直连优先、失败切代理；free → 代理优先、失败切直连
 * @param {Array<{role:string,content:string}>} messages
 * @param {{temperature?:number, maxTokens?:number, model?:string, signal?:AbortSignal,
 *          token?:string, noQueue?:boolean, kind?:'chat'|'judge', transport?:'direct'|'proxy'}} opts
 * @returns {Promise<string>} 助手回复文本
 * @throws {{code:string,message:string}} 结构化错误
 */
export async function chatCompletion(messages, opts = {}) {
  if (MOCK_AI) {
    _lastTransport = { transport: 'mock', model: 'mock-model' };
    return mockChat(messages, opts);
  }

  if (!proxyState.checked) { try { await probeProxy(); } catch (e) { /* ignore */ } }

  const hasCustom = !!(opts.token || aiSettings.getToken());
  const proxyUsable = proxyState.available;
  const mode = getEndpointMode();

  // 决定尝试顺序
  let order;
  if (opts.transport === 'direct') order = ['direct'];
  else if (opts.transport === 'proxy') order = ['proxy'];
  else if (mode === ENDPOINT_MODE.CUSTOM) order = hasCustom ? ['direct', 'proxy'] : ['proxy'];
  else order = proxyUsable ? ['proxy', 'direct'] : ['direct'];

  let lastErr = null;
  for (const transport of order) {
    if (transport === 'direct' && !hasCustom) {
      lastErr = { code: 'NO_TOKEN', message: '未配置魔搭 API Token' };
      continue;
    }
    if (transport === 'proxy' && !proxyUsable) {
      lastErr = { code: 'PROXY_UNAVAILABLE', message: '当前环境未启用免费 AI 通道' };
      continue;
    }
    try {
      const raw = transport === 'direct' ? _rawDirect : _rawProxy;
      const out = await chatWithRetry(messages, opts, raw);
      _lastTransport = {
        transport,
        model: transport === 'direct' ? (opts.model || aiSettings.getModel()) : (proxyState.model || PROXY_MODEL_FALLBACK),
      };
      // 代理计价额度实时递减（用于设置面板显示）
      if (transport === 'proxy' && opts.kind !== 'judge') proxyState.sessionUsed += 1;
      return out;
    } catch (err) {
      lastErr = err;
      // 仅有「配额耗尽 / 通道不可用 / 无凭证」这类致命错误才切通道；
      // 网络/限流已在 chatWithRetry 内重试过，直接向上抛给调用方阻断提示。
      const fatal = ['SESSION_LIMIT', 'GLOBAL_LIMIT', 'IP_LIMIT', 'PROXY_UNAVAILABLE', 'UPSTREAM_AUTH', 'NO_TOKEN', 'BAD_TOKEN'].includes(err && err.code);
      if (!fatal) throw err;
    }
  }
  throw lastErr || { code: 'NO_TRANSPORT', message: '没有可用的 AI 通道' };
}

const PROXY_MODEL_FALLBACK = '内置模型';

/**
 * 流式调用（SSE）:台词边生成边回调
 * 通道决策与 chatCompletion 一致:免费模式优先代理,自定义模式优先直连;
 * 流式中途失败不再自动切通道(已写出的增量无法收回),直接抛错由调用方阻断提示。
 * @param {Array<{role:string,content:string}>} messages
 * @param {{temperature?, maxTokens?, onDelta:(piece, full)=>void, signal?, kind?:'chat'|'judge', forceProxy?:boolean}} opts
 * @returns {Promise<string>} 完整文本
 */
export async function chatCompletionStream(messages, opts = {}) {
  if (MOCK_AI) {
    const out = mockChat(messages, opts);
    opts.onDelta && opts.onDelta(out);
    return out;
  }

  const judge = opts.kind === 'judge';
  const hasCustom = !!aiSettings.getToken();
  // 与 chatCompletion 相同的优先级逻辑
  const preferProxy = opts.forceProxy !== undefined
    ? opts.forceProxy
    : (getEndpointMode() === ENDPOINT_MODE.FREE ? (proxyState.available || !hasCustom) : !hasCustom);

  if (preferProxy) {
    const resp = await fetch(judge ? proxyUrl(PROXY_JUDGE_PATH) : proxyUrl(PROXY_CHAT_PATH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() },
      body: JSON.stringify({
        messages,
        temperature: opts.temperature ?? 0.8,
        maxTokens: opts.maxTokens ?? 420,
        stream: !judge,
      }),
      signal: opts.signal,
    });
    if (judge) { // 裁判始终非流式
      if (!resp.ok) {
        let code = `HTTP_${resp.status}`;
        try { const p = JSON.parse(await resp.text()); code = p.error?.code || code; } catch (e) { /* ignore */ }
        throw { code, message: '裁判通道错误' };
      }
      const data = await resp.json();
      return data.choices[0].message.content || '';
    }
    if (!resp.ok) {
      let code = 'SESSION_LIMIT', message = `HTTP ${resp.status}`;
      try { const p = JSON.parse(await resp.text()); code = p.error?.code || code; message = p.error?.message || message; } catch (e) { /* ignore */ }
      throw { code, message };
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    const sanitizer = createStreamSanitizer();   // 跨 chunk 剥思维链（标记会被拆进不同 chunk）
    let buffer = '';
    let full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const dataStr = t.slice(5).trim();
        if (!dataStr || dataStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(dataStr);
          const piece = sanitizer.push(sseDeltaPiece(parsed));
          if (piece) { full += piece; opts.onDelta && opts.onDelta(piece, full); }
        } catch (e) { /* SSE keep-alive 行或非标准 chunk,忽略 */ }
      }
    }
    // 流结束：放行此前被暂扣的尾巴（未闭合 <… 的判断到此失效，做最终整体剥离）
    const tail = sanitizer.flush();
    if (tail) { full += tail; opts.onDelta && opts.onDelta(tail, full); }
    if (!full) throw { code: 'EMPTY', message: '模型流式返回为空' };
    if (opts.kind !== 'judge') proxyState.sessionUsed += 1;
    return full;
  }

  // 自定义 Key 直连（端点可在设置中配置，也支持流式）
  const endpoint = getEndpointUrl();
  const check = validateEndpointUrl(endpoint);
  if (!check.ok) throw { code: 'SECURITY_BLOCKED', message: `端点校验未通过：${check.message}` };
  const token = aiSettings.getToken();
  if (!token) throw { code: 'NO_TOKEN', message: '未配置 API Token' };
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({
      model: opts.model || aiSettings.getModel(),
      messages,
      temperature: opts.temperature ?? 0.8,
      max_tokens: opts.maxTokens ?? 420,
      stream: !judge,
    }),
    signal: opts.signal,
  });
  if (!resp.ok) throw { code: `HTTP_${resp.status}`, message: `直连返回 ${resp.status}` };
  if (judge) {
    const data = await resp.json();
    return data.choices[0].message.content || '';
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  const sanitizer = createStreamSanitizer();   // 与 free 通道同一套跨 chunk 剥离
  let buffer = '';
  let full = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const dataStr = t.slice(5).trim();
      if (!dataStr || dataStr === '[DONE]') continue;
      try {
        const parsed = JSON.parse(dataStr);
        const piece = sanitizer.push(sseDeltaPiece(parsed));
        if (piece) { full += piece; opts.onDelta && opts.onDelta(piece, full); }
      } catch (e) { /* ignore */ }
    }
  }
  const tail = sanitizer.flush();
  if (tail) { full += tail; opts.onDelta && opts.onDelta(tail, full); }
  // 与免费通道一致：正文被思维链占满 / content 为空时抛 EMPTY，
  // 让 askSuspect 走既有非流式兜底，而不是把空串写进历史渲染空气泡
  if (!full) throw { code: 'EMPTY', message: '模型流式返回为空' };
  return full;
}

/** 测试连接并计算毫秒延迟（noQueue：即时反馈，不做排队重试） */
export async function testConnection(token, model) {
  const start = performance.now();
  // 优先测试「玩家填写的 Token 直连」；没传 Token 时测试免费通道
  const useDirect = !!String(token || '').trim();
  const reply = await chatCompletion([
    { role: 'user', content: '请仅回复“OK”两个字母以测试连接。' }
  ], {
    token: useDirect ? token : undefined,
    model,
    maxTokens: 10,
    temperature: 0.1,
    noQueue: true,
    transport: useDirect ? 'direct' : 'proxy',
  });
  const latency = Math.round(performance.now() - start);
  return { reply, latency };
}

/**
 * 请求超时包装。
 * 超时不仅让外层 Promise 失败，还要 abort 底层 fetch 并从 LOAD_GATE 队列撤销——
 * 否则上游挂起时槽位一直被占，两次超时就能把并发闸门堵死（CodeRabbit 抓到）。
 * @param {(signal:AbortSignal)=>Promise<any>} promiseFactory 接收中止信号
 */
export function withTimeout(promiseFactory, ms = 45000) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => {
      controller.abort();
      rej({ code: 'TIMEOUT', message: `请求超时（${ms / 1000}s）` });
    }, ms);
  });
  const run = Promise.resolve().then(() => promiseFactory(controller.signal));
  return Promise.race([run, timeout]).finally(() => clearTimeout(timer));
}
