/* ============================================================
 * 侦探能力侧写引擎（AI 玩家评测报告）
 * - 行为痕迹量化：把玩家在调查/审讯中的操作痕迹派生为五维能力分（0-100）
 * - 评估维度与解谜行为强绑定，给出具体的执行长板，而非空泛赞美
 * - 仅 AI 模式：走魔搭 chatCompletion 生成深度人格侧写（与嫌疑人扮演同一管道）
 * - 雷达图：纯代码 SVG 绘制，延续零素材风格
 * ============================================================ */

import { CASE } from './case-data.js?v=3.6.0';
import { chatCompletion, withTimeout } from './ai-client.js?v=3.6.0';
import { PROMPTS } from './prompts.js?v=3.6.0';

/* ---------------- 五维能力定义 ---------------- */

export const DIM_LABELS = ['观察敏锐', '证据链思维', '心理攻防', '探索效率', '决断节奏'];

const clamp = (v) => Math.max(3, Math.min(100, Math.round(v)));

/* ---------------- 行为快照 → 五维派生分 ---------------- */

/**
 * @param {object} snap 行为快照（game.js buildBehaviorSnapshot 产出）
 * @param {object} sc   computeScore() 的评分结果
 */
export function buildProfile(snap, sc) {
  const stats = snap.stats || {};
  const totalEv = CASE.evidences.length;
  const keyIds = CASE.truth.keyEvidenceIds;
  const foundRatio = snap.found.length / totalEv;
  const dramaRatio = (snap.dramasSeen && snap.dramasSeen.length) ? 1 : 0;
  const order = stats.evidenceOrder || [];
  const roomVisits = stats.roomVisits || {};

  // 1) 观察敏锐：收集率为主 + 关键物证发现顺序加权（越早锁定关键痕迹越敏锐）+ 剧情热点
  const keyPos = keyIds.map((id) => order.indexOf(id)).filter((p) => p >= 0);
  const keyEarly = keyPos.length
    ? keyPos.reduce((a, p) => a + (1 - p / Math.max(1, order.length)), 0) / keyIds.length
    : 0;
  const observation = clamp(foundRatio * 62 + keyEarly * 23 + dramaRatio * 15);

  // 2) 证据链思维：关键证据命中率为主 + 指认正确加分
  const chain = clamp((sc.keyHits / keyIds.length) * 72 + (sc.culpritOk ? 28 : (snap.accused ? 8 : 0)));

  // 3) 心理攻防：戳穿次数 + 完整坦白推进 + 出示物证的多样性（有效出示比）
  const presentEff = stats.presentsTotal ? stats.presentsUnique / stats.presentsTotal : 0;
  const psych = clamp(
    Math.min(52, snap.crackCount * 11)
    + snap.confessedCount * 9
    + presentEff * 26
    + (snap.usedPresent ? 6 : 0),
  );

  // 4) 探索效率：完成度 + 节奏（14 分钟为基准线）- 重复操作惩罚
  const minutes = (stats.playedMs || 0) / 60000;
  const pace = minutes > 0 ? Math.min(1.4, 14 / Math.max(5, minutes)) : 0.75;
  const repeatPenalty = Math.min(28, ((stats.repeatViews || 0) + (stats.repeatQuestions || 0)) * 3.5);
  const efficiency = clamp(foundRatio * 58 + pace * 27 + dramaRatio * 10 - repeatPenalty);

  // 5) 决断节奏：提问→戳穿的转化精度 + 房间覆盖广度 + 是否敢于出示 + 整体推进
  const precision = snap.askedTotal ? Math.min(1, snap.crackCount / snap.askedTotal) : 0;
  const roomSpread = Object.keys(roomVisits).length / CASE.rooms.length;
  const decisiveness = clamp(precision * 44 + roomSpread * 24 + presentEff * 14 + (sc.total >= 60 ? 18 : 6));

  return {
    labels: DIM_LABELS,
    dims: [observation, chain, psych, efficiency, decisiveness],
    minutes,
  };
}

/* ---------------- 思维风格称号（规则版） ---------------- */

const STYLE_TITLES = [
  { t: '现场明察者', n: '你不放过任何一处会发光的角落，现场就是你的第一证人。' },
  { t: '链式推理者', n: '你的每一份证据都指向同一个结论，链条咬合紧密。' },
  { t: '攻势审讯官', n: '你擅长在对话中施压，让对方自己撕开防线。' },
  { t: '效率勘查派', n: '你用最少的弯路撬开最多的真相，时间在你手里是武器。' },
  { t: '一击必中决断者', n: '你出手不多，但每次都打在要害上。' },
];

export function styleTitle(profile) {
  let idx = 0;
  profile.dims.forEach((v, i) => { if (v > profile.dims[idx]) idx = i; });
  return STYLE_TITLES[idx];
}

/* ---------------- 行为数据摘要（喂给 AI / 本地报告共用） ---------------- */

export function buildStatsDigest(snap, sc) {
  const stats = snap.stats || {};
  const roomVisits = stats.roomVisits || {};
  const rooms = CASE.rooms.map((r) => `${r.name}×${roomVisits[r.id] || 0}`).join('、');
  const minutes = ((stats.playedMs || 0) / 60000).toFixed(1);
  const firstRoomObj = CASE.rooms.find((r) => roomVisits[r.id]);
  const qLine = CASE.suspects
    .map((s) => `${s.name} ${(stats.questionsPerSuspect || {})[s.id] || 0} 问`)
    .join('、');
  const firstFound = stats.evidenceOrder && stats.evidenceOrder.length
    ? (CASE.evidences.find((e) => e.id === stats.evidenceOrder[0]) || {}).name || stats.evidenceOrder[0]
    : '（无）';
  const presents = stats.presentsTotal
    ? `${stats.presentsTotal} 次（其中不同物证 ${stats.presentsUnique} 种）`
    : '0 次（全程未出示物证）';
  const confessions = CASE.suspects
    .filter((s) => {
      const st = snap.suspectsState && snap.suspectsState[s.id];
      return st && st.confessed;
    })
    .map((s) => s.name)
    .join('、') || '无人完整坦白';

  return [
    `用时：约 ${minutes} 分钟`,
    `物证：找到 ${snap.found.length}/${CASE.evidences.length} 条，发现顺序为「${(stats.evidenceOrder || []).join(' → ') || '无'}」，第一件发现的是《${firstFound}》`,
    `剧情热点：查看 ${snap.dramasSeen.length}/1 处；房间访问分布：${rooms}（首选进入：${firstRoomObj ? firstRoomObj.name : '无'}）`,
    `审讯：总提问 ${snap.askedTotal} 次（${qLine}），戳穿 ${snap.crackCount} 次，${confessions}`,
    `出示物证：${presents}；重复查看已收集物证 ${stats.repeatViews || 0} 次，重复提问 ${stats.repeatQuestions || 0} 次`,
    `指认：${snap.accused ? (CASE.suspects.find((s) => s.id === snap.accused) || {}).name : '（未指认）'}；定罪证据勾选 ${(snap.chosenEvidence || []).length} 条`,
    `结算：综合 ${sc.total}/100（指认${sc.culpritOk ? '正确' : '错误'}，关键证据命中 ${sc.keyHits}/${CASE.truth.keyEvidenceIds.length}），评级 ${sc.rank.label}`,
  ].join('\n');
}

/* ---------------- AI 深度侧写报告 ---------------- */

/**
 * @returns {Promise<{title,note,strengths:[{name,text}],blind,advice,raw,mode:'ai'}>}
 */
export async function aiProfileReport(profile, snap, sc) {
  const digest = buildStatsDigest(snap, sc);
  const dimsLine = profile.labels.map((l, i) => `${l} ${profile.dims[i]}`).join(' / ');
  const titleSeed = styleTitle(profile);

  const sys = '你是《雨夜画廊》推理游戏里的资深刑侦顾问。回复正文就是侧写报告本身，不要 JSON、不要标题编号、不要解释你的评估过程。';
  const user = PROMPTS.PROFILE(digest, dimsLine, titleSeed);

  const reply = await withTimeout(
    () => chatCompletion(
      [{ role: 'system', content: sys }, { role: 'user', content: user }],
      { temperature: 0.5, maxTokens: 900 },
    ),
    45000,
  );
  return parseReport(reply, 'ai');
}

/* ---------------- 报告文本解析 ---------------- */

function parseReport(text, mode) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const report = { title: '', note: '', strengths: [], blind: '', advice: '', raw: String(text || ''), mode };
  lines.forEach((line) => {
    if (/^风格称号/.test(line)) {
      const [t, n] = line.replace(/^风格称号[：:]\s*/, '').split(/[｜|]/);
      report.title = (t || '').trim();
      report.note = (n || '').trim();
    } else if (/^长板/.test(line)) {
      const body = line.replace(/^长板[·•・]?\s*/, '');
      const name = (body.match(/^([^：:]{2,12})[：:]/) || [])[1] || '执行长板';
      report.strengths.push({ name: name.trim(), text: body.replace(/^[^：:]{2,12}[：:]\s*/, '').trim() || body });
    } else if (/^盲区提醒/.test(line)) {
      report.blind = line.replace(/^盲区提醒[：:]\s*/, '');
    } else if (/^下一案建议/.test(line)) {
      report.advice = line.replace(/^下一案建议[：:]\s*/, '');
    }
  });
  if (!report.title) report.title = styleTitle(profile0Fallback()).t;
  return report;
}
function profile0Fallback() { return { dims: [50, 50, 50, 50, 50] }; }

/* ---------------- 五维雷达图（纯 SVG） ---------------- */

export function radarSVG(profile, { size = 250 } = {}) {
  const cx = size / 2;
  const cy = size / 2 + 4;
  const R = size / 2 - 36;
  const n = profile.dims.length;
  const pt = (i, r) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [+(cx + Math.cos(a) * r).toFixed(1), +(cy + Math.sin(a) * r).toFixed(1)];
  };
  const ring = (ratio) => profile.dims.map((_, i) => pt(i, R * ratio).join(',')).join(' ');
  const rings = [0.25, 0.5, 0.75, 1].map((r) =>
    `<polygon points="${ring(r)}" fill="none" stroke="#2a3646" stroke-width="${r === 1 ? 1.2 : 0.7}" opacity="${r === 1 ? 0.9 : 0.6}"/>`).join('');
  const axes = profile.dims.map((_, i) => {
    const [x, y] = pt(i, R);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="#2a3646" stroke-width=".7" opacity=".6"/>`;
  }).join('');
  const valuePts = profile.dims.map((v, i) => pt(i, (Math.max(4, v) / 100) * R).join(',')).join(' ');
  const labels = profile.labels.map((l, i) => {
    const [x, y] = pt(i, R + 20);
    const anchor = Math.abs(x - cx) < 6 ? 'middle' : x > cx ? 'start' : 'end';
    const [vx, vy] = pt(i, (Math.max(4, profile.dims[i]) / 100) * R);
    return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-size="11" fill="#dce3ec" font-family="serif">${l}</text>
      <text x="${(x + vx) / 2}" y="${(y + vy) / 2 - 4}" text-anchor="middle" font-size="9" fill="#e0a94e">${profile.dims[i]}</text>`;
  }).join('');
  return `<svg viewBox="-40 -8 ${size + 80} ${size + 12}" xmlns="http://www.w3.org/2000/svg" class="radar-svg">
    ${rings}${axes}
    <polygon points="${valuePts}" fill="rgba(224,169,78,.18)" stroke="#e0a94e" stroke-width="1.6" stroke-linejoin="round"/>
    ${profile.dims.map((v, i) => { const [x, y] = pt(i, (Math.max(4, v) / 100) * R); return `<circle cx="${x}" cy="${y}" r="2.6" fill="#e0a94e"/>`; }).join('')}
    ${labels}
  </svg>`;
}
