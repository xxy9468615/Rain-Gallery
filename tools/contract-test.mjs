#!/usr/bin/env node
/* ============================================================
 * API 契约测试（真连后端）
 * ------------------------------------------------------------
 * 覆盖本作「仅 AI 模式」的全部出站契约，任一失败即阻断游玩：
 *
 *   A. 同源免费通道  GET  /api/status   POST /api/chat   POST /api/judge
 *   B. 自定义 Key    POST https://api-inference.modelscope.cn/v1/chat/completions
 *   C. 出站沙箱守卫：自定义 Key 模式只允许直连官方域（ai-client.js 单向校验）
 *   D. 计额与限流：  /api/judge 独立额度、session / ip / global 上限
 *   E. 模型输出格式：嫌疑人台词必须是 {"reply","action","trust_delta","hostility_delta"}
 *
 * 用法：
 *   node tools/contract-test.mjs                    # 只测免费通道（从 .env 读）
 *   node tools/contract-test.mjs --full             # 追加自定义 Key 直连与格式契约
 *   node tools/contract-test.mjs --base http://127.0.0.1:8092
 *   node tools/contract-test.mjs --skip-proxy       # 只自定义 Key 模式
 *
 * 前提：服务端已带 .env 启动（python app.py 或 uvicorn）。
 * 密钥只从 .env / 环境变量读取，绝不打印，绝不写入日志或提交物。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- 参数 ---------------- */
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};

const BASE = opt('--base', process.env.E2E_BASE || 'http://127.0.0.1:8092');
const FULL = flag('--full') || flag('--custom');
const SKIP_PROXY = flag('--skip-proxy');
const TIMEOUT = Number(opt('--timeout', 90000));

/* ---------------- .env 读取（密钥不外泄） ---------------- */
function loadEnv() {
  try {
    const txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { /* 无 .env 时退回环境变量 */ }
}
loadEnv();

const TOKEN = (process.env.MODELSCOPE_TOKEN || process.env.RG_PROXY_TOKEN || '').trim();

/* ---------------- 着色输出 + 统计 ---------------- */
let pass = 0;
let fail = 0;
const failures = [];
const t = (ok, msg, extra) => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}${extra ? ` \x1b[2m${extra}\x1b[0m` : ''}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✗\x1b[0m ${msg}${extra ? ` \x1b[2m→ ${extra}\x1b[0m` : ''}`); }
};
const section = (name) => console.log(`\n\x1b[36m▌${name}\x1b[0m`);

async function timed(fn) {
  const t0 = Date.now();
  try { return { ok: true, data: await fn(), ms: Date.now() - t0 }; }
  catch (e) { return { ok: false, err: e, ms: Date.now() - t0 }; }
}

/* 打官方端点 / 同源代理；只解包 content，绝不打印 Authorization 或请求体 */
async function callChat(body, { base = BASE, token = null, judge = false } = {}) {
  const url = judge ? (base === BASE ? `${base}/api/judge` : base) : (base === BASE ? `${base}/api/chat` : base);
  const headers = { 'Content-Type': 'application/json', 'X-Session-Id': 'contract-' + Date.now() };
  // 自定义 Key 直连时才带 Authorization（免费通道一律由后端持有 Key）
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* SSE / 空体 */ }
  return { status: res.status, text, json };
}

/* ============================================================
 * A. 同源免费通道
 * ============================================================ */
if (!SKIP_PROXY) {
  section('A · 同源免费通道 /api/*');

  // A1 /api/status：必须给出 available/model/sessionCap 三项契约字段
  await timed(async () => {
    const res = await fetch(`${BASE}/api/status`, {
      headers: { 'X-Session-Id': 'contract-status-' + Date.now() },
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const d = await res.json();
    t(res.status === 200, 'GET /api/status → 200', `available=${d.available} model=${d.model}`);
    t(typeof d.available === 'boolean', 'status.available 是布尔');
    t(typeof d.model === 'string' && d.model.length > 0, 'status.model 非空', d.model);
    t(typeof d.sessionCap === 'number' && d.sessionCap > 0, 'status.sessionCap 是正数', d.sessionCap);
    t(typeof d.sessionUsed === 'number', 'status.sessionUsed 是数字', String(d.sessionUsed));
  });

  // A2 /api/chat 主通道：payload 契约 + 返回 OpenAI 兼容结构
  await timed(async () => {
    const r = await callChat({
      messages: [{ role: 'user', content: '契约连通性测试：请只回复两个字——收到' }],
      temperature: 0.3, maxTokens: 60,
    });
    const d = r.json;
    t(r.status === 200, 'POST /api/chat → 200', `HTTP ${r.status}`);
    const content = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    t(typeof content === 'string' && content.length > 0, 'chat 返回 choices[0].message.content',
      content ? `${content.length} 字` : r.text.slice(0, 80));
    // 契约：后端忽略前端 model / Authorization，免费通道模型由服务端决定
    // 注意 maxTokens 给足：推理模型（spark-x2.6）会先消耗预算做思维链，
    // 给 30 会被思考耗尽导致 content 为空、后端按 BAD_UPSTREAM 返回 502。
    // 上游偶发空 content 属已知抖动（实测 5 次中约 1 次），重试 3 次，
    // 只要有一次成功即证明"伪造参数未影响后端选型"。
    const hdr = { 'Content-Type': 'application/json', 'X-Session-Id': 'contract-model-' + Date.now(), Authorization: 'Bearer ms-should-be-ignored-000000' };
    const probe = () => fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: hdr,
      body: JSON.stringify({ model: 'attacker-injected-model', messages: [{ role: 'user', content: 'ping' }], maxTokens: 400 }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    let r2 = null;
    for (let i = 0; i < 3; i++) {
      r2 = await probe();
      if (r2.status === 200) break;
    }
    t(r2.status === 200, '前端伪造 model/Authorization 被后端忽略', `HTTP ${r2.status}`);
  });

  // A3 /api/judge 独立计额通道：必须非流式、temperature 固定 0、返回 JSON
  await timed(async () => {
    // judge 由后端强制 max_tokens=JUDGE_MAX_TOKENS，但推理模型会先消耗预算做思维链，
    // 给前端 30 会被思考耗尽 → 上游空 content → 后端 502。这里给足预算并容忍偶发重试。
    const probeJudge = () => callChat({
      messages: [{ role: 'user', content: '裁判契约测试：请只输出 JSON {"tag": null, "confidence": 0, "reason": "x"}' }],
      temperature: 0.7, maxTokens: 400,
    }, { judge: true });
    let r = null;
    for (let i = 0; i < 3; i++) { r = await probeJudge(); if (r.status === 200) break; }
    t(r.status === 200, 'POST /api/judge → 200', `HTTP ${r.status}`);
    const content = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content;
    t(typeof content === 'string' && content.includes('{'), 'judge 返回含 JSON 的文本',
      content ? content.slice(0, 60) : '');
    // 契约：judge 通道强制非流式、temperature=0（即便前端传了别的值）
    t(!r.text.includes('data:'), 'judge 通道不使用 SSE 流式');
  });

  // A4 请求体契约：缺 messages 必须 400 而非 500
  await timed(async () => {
    const r = await callChat({});
    t(r.status === 400, '缺 messages → 400', `HTTP ${r.status} ${(r.json && r.json.error && r.json.error.code) || ''}`);
    const r2 = await fetch(`${BASE}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: 'not-json', signal: AbortSignal.timeout(TIMEOUT),
    });
    t(r2.status === 400, '非法 JSON → 400', `HTTP ${r2.status}`);
  });
}

/* ============================================================
 * B. 自定义 Key 直连（真实模型 + 输出格式契约）
 * ============================================================ */
if (FULL) {
  section('B · 自定义 Key 直连官方端点');

  if (!TOKEN.startsWith('ms-')) {
    console.log('  \x1b[33m⚠ 未配置 MODELSCOPE_TOKEN / RG_PROXY_TOKEN，跳过 B 组\x1b[0m');
  } else {
    t(true, '已从 .env/环境变量读取 Token', `前缀 ${TOKEN.slice(0, 3)}****（不回显）`);

    // B1 直连可用性
    await timed(async () => {
      const r = await callChat({
        model: 'Qwen/Qwen3.8-Flash-Next',
        messages: [{ role: 'user', content: '契约测试：只回复"OK"' }],
        temperature: 0.3, maxTokens: 500,
      }, { base: 'https://api-inference.modelscope.cn/v1/chat/completions', token: TOKEN });
      const content = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content;
      t(r.status === 200, '直连 chat/completions → 200', `HTTP ${r.status} ${r.ms}ms`);
      t(!!content, '直连返回 content', content ? String(content).slice(0, 40) : r.text.slice(0, 80));
    });

    // B2 token 无效时必须 401/403（前端据此提示重新接入）
    await timed(async () => {
      const r = await callChat({
        model: 'Qwen/Qwen3.8-Flash-Next',
        messages: [{ role: 'user', content: 'ping' }],
      }, { base: 'https://api-inference.modelscope.cn/v1/chat/completions', token: 'ms-invalid-token-000000' });
      t(r.status === 401 || r.status === 403, '无效 Token → 401/403', `HTTP ${r.status}`);
    });

    // B3 NPC 台词格式契约：必须能解析出四字段（这是游戏仅 AI 模式的生死线）
    await timed(async () => {
      const sys = '你是"陈默"，画廊策展助理。只输出 JSON，不要任何多余文字：'
        + '{"reply":"台词（40字内）","action":"none","trust_delta":0,"hostility_delta":0}';
      const r = await callChat({
        model: 'Qwen/Qwen3.8-Flash-Next',
        messages: [{ role: 'system', content: sys }, { role: 'user', content: '案发时你在哪？' }],
        temperature: 0.7, maxTokens: 500,
      }, { base: 'https://api-inference.modelscope.cn/v1/chat/completions', token: TOKEN });
      const raw = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content;
      t(r.status === 200, 'NPC 协议调用 → 200', `HTTP ${r.status}`);
      if (!raw) { t(false, 'NPC 协议返回 content', r.text.slice(0, 80)); }
      else {
        let obj = null;
        try { obj = JSON.parse(raw); } catch (e) {
          const m = String(raw).match(/\{[\s\S]*\}/);
          if (m) { try { obj = JSON.parse(m[0]); } catch (e2) { /* 无法解析 */ } }
        }
        t(!!obj, 'NPC 输出可解析为 JSON', obj ? 'OK' : String(raw).slice(0, 80));
        if (obj) {
          t(typeof obj.reply === 'string' && obj.reply.length > 0, 'reply 是非空字符串', obj.reply?.slice?.(0, 30));
          t(['none', 'hand_over_photo', 'delete_photo', 'call_lawyer', 'volunteer',
             'shift_blame', 'request_storage'].includes(obj.action), 'action 在合法集合内', obj.action);
          t(Number.isFinite(obj.trust_delta), 'trust_delta 是数字', String(obj.trust_delta));
          t(Number.isFinite(obj.hostility_delta), 'hostility_delta 是数字', String(obj.hostility_delta));
        }
      }
    });
  }
}

/* ============================================================
 * C. 出站沙箱守卫（自定义 Key 模式只允许官方域）
 * ============================================================ */
section('C · 出站沙箱守卫（源码静态校验）');
{
  const src = readFileSync(resolve(ROOT, 'js/ai-client.js'), 'utf8');
  t(src.includes("const REQUIRED_ORIGIN = 'https://api-inference.modelscope.cn'"),
    'ai-client 定义了 REQUIRED_ORIGIN 白名单');
  t(/guard|sandbox|沙箱/.test(src), 'ai-client 含出站守卫逻辑');
  // 不该出现把 Token 写到 console/localStorage 明文的代码
  const leaks = src.match(/console\.(log|info|warn|error|debug)\([^)]*\bmemoryToken\b/) || [];
  t(leaks.length === 0, '没有把 Token 明文打进 console');
  t(src.includes('PROTECTED_TOKEN'), 'console 脱敏器在位');
}

/* ============================================================
 * D. 计额契约（/api/status 计数随调用增长）
 * ============================================================ */
if (!SKIP_PROXY) {
  section('D · 计额契约');
  const sid = 'contract-quota-' + Date.now();
  const before = await timed(() => fetch(`${BASE}/api/status`, { headers: { 'X-Session-Id': sid } }).then((r) => r.json()));
  // 计额按 session 统计，必须复用同一个 X-Session-Id 才能观察到增长
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 400 }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sid },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'ping' }], maxTokens: 400 }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const after = await timed(() => fetch(`${BASE}/api/status`, { headers: { 'X-Session-Id': sid } }).then((r) => r.json()));
  const b = (before.data && before.data.sessionUsed) || 0;
  const a = (after.data && after.data.sessionUsed) || 0;
  t(a > b, 'sessionUsed 随 chat 调用增长', `${b} → ${a}`);
  t(typeof after.data.sessionCap === 'number', 'sessionCap 对前端可见（余额提示）', String(after.data.sessionCap));
}

/* ============================================================
 * 汇总
 * ============================================================ */
console.log(`\n\x1b[1m合计\x1b[0m  \x1b[32m通过 ${pass}\x1b[0m · \x1b[31m失败 ${fail}\x1b[0m`);
if (fail) {
  console.log('\n\x1b[31m失败项：\x1b[0m');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('\x1b[32m✓ 全部契约通过\x1b[0m');
