/* ============================================================
 * 求助系统（旁白顾问）· v3.7
 * ------------------------------------------------------------
 * 取代原先静态的 suggestQuestions（三个嫌疑人共 30 条硬编码问句，
 * renderSuggestQuestions() 直接渲染 3 条成可点击 chip、点击即填入
 * 输入框）——那套做法把最优提问原文喂给玩家，推理乐趣归零。
 *
 * 设计约束（缺一条就退回老问题）：
 *   1. 只给「方向」，不替玩家组织问句（prompt 明确禁止写出可照抄原话）
 *   2. 不点名物证（prompt 明确禁止出现名称与编号）
 *   3. 不给结论（谁是真凶、哪个证据是关键）
 *   4. 不自动填入输入框——玩家必须自己把方向翻译成提问
 *   5. 一局 3 次，用一次少一次；用完按钮禁用
 *   6. 扣分但不改关系值（第一期不动 applyRel/敌意，避免牵动审讯平衡）
 * ============================================================ */

import { PROMPTS } from './prompts.js?v=3.6.0';
import { chatCompletion, withTimeout } from './ai-client.js?v=3.6.0';

/** 一局可求助次数 */
export const HINT_LIMIT = 3;

/** 单次求助的评分惩罚上限（总分扣 6 分封顶，防止一次求助定生死） */
export const HINT_PENALTY_CAP = 6;

/** 每次求助扣 2 分 */
export const HINT_PENALTY_EACH = 2;

/** 求助通道超时。旁白提示应当轻快，等 10s 不如让玩家自己再想想。 */
const HINT_TIMEOUT_MS = 10000;

/** 旁白提示的最大字数（prompt 里也要求 ≤60，这里再兜一层） */
const HINT_MAX_CHARS = 60;

/**
 * 计算求助扣分。纯函数——computeScore 必须能从存档重算，
 * 所以这里只依赖 hintsUsed 这个会落盘的计数。
 * @param {number} hintsUsed 本局已用求助次数
 * @returns {number} 要扣的分数
 */
export function hintPenalty(hintsUsed) {
  const n = Math.max(0, Math.min(HINT_LIMIT, Math.floor(Number(hintsUsed) || 0)));
  return Math.min(HINT_PENALTY_CAP, n * HINT_PENALTY_EACH);
}

/** 剩余次数 */
export function hintsLeft(hintsUsed) {
  return Math.max(0, HINT_LIMIT - Math.max(0, Math.floor(Number(hintsUsed) || 0)));
}

/* ---------------- 兜底提示（AI 不可用 / 超时 / 输出不合规） ---------------- */

/**
 * AI 求助通道失败时不出垃圾话，也不给唯一解——
 * 给一条**方法论层面的**观察角度，不含本案任何具体事实。
 * 这样即使 AI 挂了，玩家得到的也只是思考框架，不会因此通关。
 */
const FALLBACK_HINTS = [
  '他回答问题的方式，有时比答案本身更值得注意。',
  '时间线是最容易藏谎的地方——把每个人的说法对齐一遍看。',
  '谁在害怕什么，谁就在掩饰什么。',
  '你说得太快时，对方会用更漂亮的话回敬你；慢下来反而有效。',
  '注意他主动提起的话题——人常常在不经意间为真话开路。',
  '有些细节他一口咬定，越确定越可能是因为他确定的是另一件事。',
];

let fallbackCursor = 0;

export function fallbackHint() {
  const h = FALLBACK_HINTS[fallbackCursor % FALLBACK_HINTS.length];
  fallbackCursor += 1;
  return h;
}

/* ---------------- 合规校验 ---------------- */

/**
 * 本案高辨识词表。
 * 靠物证 name 子串匹配挡不住 paraphrase（模型说「沾着钴蓝颜料的刀」
 * 而 name 是「沾钴蓝颜料的裁纸刀」——子串匹配失效）。
 * 所以再叠一层：这些词在正常的"方向性提示"里完全没有出现必要，
 * 一旦出现，只可能是模型在泄漏本案具体事实。
 * 不含常见词、不含人名词根，避免误伤正常提示。
 */
const CASE_MARKERS = [
  'cz-07', '钴蓝', '画框夹层', '方兰', '夹层里', '侧窗', '泥脚印',
  '越洋', '私洽', '调包', '复制品', '高仿', '雨夜画廊',
  '关于母亲', '装裱师', '储物间', '直播物料', '花絮', '老周',
  '陈默', '林曼青', '苏晓', '黑影', '总闸', '对讲机',
];

/** 归一化：去空格、统一大小写，让「CZ-07」和「cz 07」都拦得住 */
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/**
 * 检查 AI 返回的提示是否违规。任一命中即整条丢弃、改用兜底。
 * 这是「不让玩家一键通关」的最后一道闸：prompt 层约束软，
 * 模型仍可能越界（实测出现过把物证名写出来、以及换词规避的情况）。
 */
export function sanitizeHint(text, suspect, knownEvidences) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (raw.length > HINT_MAX_CHARS) return null;
  const flat = norm(raw);

  // 1. 带问号的长句基本等于代写问句
  if (/[？?]/.test(raw) && raw.length > 18) return null;

  // 2. 点名了本案物证 → 直接拒绝（玩家应当自己去发现）
  for (const e of knownEvidences || []) {
    if (e.name && raw.includes(e.name)) return null;
  }

  // 3. 本案高辨识词（挡住 paraphrase：换措辞但说的是同一个具体事实）
  for (const m of CASE_MARKERS) {
    if (flat.includes(norm(m))) return null;
  }

  // 4. 嫌疑人名字（含同姓称呼）
  for (const su of (suspect ? [suspect] : [])) {
    if (su.name && flat.includes(norm(su.name))) return null;
  }

  // 5. 出现「真凶/凶手是」这类结论性表述
  if (/(真凶|凶手是|就是.{0,4}干的|关键证据是)/.test(raw)) return null;

  // 6. 带引号的原话引用，往往是在复述嫌疑人说过的话——复述不等于方向。
  //    ASCII 的 " ' 也要拦：模型常把中文引号写成半角（实测出现过），
  //    只查全角会让「把\"痕迹\"和\"物品\"连起来问」这类复述直接漏过。
  if (/[“”「」『』"']/.test(raw)) return null;

  return raw;
}

/* ---------------- 主接口 ---------------- */

/**
 * 取一条旁白提示（方向，不是问句）。
 * @param {object} suspect  case-data.js 嫌疑人条目
 * @param {object} st       嫌疑人运行时状态
 * @param {Array}  knownEvidences 已收集物证
 * @param {number} hintsUsed **含本次在内**的总求助次数（调用方先自增再传进来）；
 *                   这样 `left` 就是本次之后真正剩下的次数
 * @returns {Promise<{text:string, source:'ai'|'fallback', left:number}>}
 */
export async function requestHint(suspect, st, knownEvidences, hintsUsed = 1) {
  const left = hintsLeft(hintsUsed);   // hintsUsed 已含本次
  let raw = '';
  try {
    // HINT_TIMEOUT_MS 必须真正生效（此前定义了却没接 withTimeout——CodeRabbit 抓到）：
    // 上游挂起时界面会永远停在「⏳ 旁白在观察……」，而 hintsUsed 已 +1、
    // 分已扣——玩家白白损失一次额度还看不到任何回应。
    raw = await withTimeout(
      () => chatCompletion(
        [
          { role: 'system', content: '你是《雨夜画廊》的旁白顾问。回复只能是提示本身，不要解释、不要 JSON、不要思考过程。' },
          { role: 'user', content: PROMPTS.HINT(suspect, st, knownEvidences, left) },
        ],
        { temperature: 0.9, maxTokens: 200 },
      ),
      HINT_TIMEOUT_MS,
    );
  } catch (e) {
    return { text: fallbackHint(), source: 'fallback', left };
  }

  const clean = sanitizeHint(raw, suspect, knownEvidences);
  return { text: clean || fallbackHint(), source: clean ? 'ai' : 'fallback', left };
}
