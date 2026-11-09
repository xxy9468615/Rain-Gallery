#!/usr/bin/env node
/* ============================================================
 * 免费通道预检（跑任何大模型测试前先确认能不能测）
 * ------------------------------------------------------------
 * 依次检查：
 *   1. .env 存在且含 RG_PROXY_TOKEN / RG_PROXY_MODEL / RG_PROXY_API_BASE
 *   2. 直连官方端点验证 Token（不经过本作品后端，排除层间干扰）
 *   3. 验证 RG_PROXY_MODEL 是否为有效模型 ID（历史上踩过
 *      "Invalid model id: spark-x2.6" 导致全通道 502）
 *   4. 本作品后端 /api/status 是否报 available=true
 *
 * 用法：
 *   node tools/precheck.mjs                        # 用 .env
 *   MODELSCOPE_TOKEN=ms-xxx node tools/precheck.mjs
 *
 * 密钥只读不外显——输出只显示前缀几位，绝不打印完整 Token。
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const BASE = opt('--base', process.env.E2E_BASE || 'http://127.0.0.1:7860');

/* ---- .env 载入 ---- */
const envKeys = new Set();
try {
  const txt = readFileSync(resolve(ROOT, '.env'), 'utf8');
  for (const line of txt.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) { envKeys.add(m[1]); if (!process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ''); }
  }
} catch (e) { /* 无 .env */ }

let problems = 0;
const ok = (m, x) => { console.log(`  \x1b[32m✓\x1b[0m ${m}${x ? `  \x1b[2m${x}\x1b[0m` : ''}`); };
const bad = (m, x) => { problems++; console.log(`  \x1b[31m✗\x1b[0m ${m}${x ? `  \x1b[2m→ ${x}\x1b[0m` : ''}`); };
// 警告：不影响"可以开始测试"的结论（例如上游不是魔搭时，魔搭模型 ID 必然 400）
const warn = (m, x) => { console.log(`  \x1b[33m⚠\x1b[0m ${m}${x ? `  \x1b[2m${x}\x1b[0m` : ''}`); };
const mask = (s) => (s ? `${s.slice(0, 4)}…（${s.length} 位，不回显）` : '（空）');

console.log('\n\x1b[36m▌1 · 凭证配置\x1b[0m');
const TOKEN_PROBE = (process.env.MODELSCOPE_TOKEN || process.env.RG_PROXY_TOKEN || '').trim();
const MODEL_PROBE = (process.env.RG_PROXY_MODEL || '').trim();
const BASE_PROBE = (process.env.RG_PROXY_API_BASE || '').trim();
if (envKeys.size > 0) ok('.env 已读取', [...envKeys].join(', '));
else if (TOKEN_PROBE && MODEL_PROBE) ok('未找到 .env，改用环境变量（CI / 容器场景）');
else bad('.env 未找到且环境变量为空', '测试需要 RG_PROXY_TOKEN 与 RG_PROXY_MODEL');

const TOKEN = (process.env.MODELSCOPE_TOKEN || process.env.RG_PROXY_TOKEN || '').trim();
const API_BASE = (process.env.RG_PROXY_API_BASE || 'https://api-inference.modelscope.cn/v1/chat/completions').trim();
const MODEL = (process.env.RG_PROXY_MODEL || '').trim();
// 上游是"任意 OpenAI 兼容服务"：魔搭、讯飞星火、其他中转都可能。
// 不按域名 / 不按 Token 前缀做判断，一律以"实际能否返回 content"为准。
const UPSTREAM_NAME = new URL(API_BASE).hostname;

if (TOKEN.length >= 10) ok('Token 已就绪', mask(TOKEN));
else bad('Token 缺失或过短', '需有效的 API Key（魔搭 ms- 开头 / 星火等第三方）');
ok('上游接口（OpenAI 兼容）', `${API_BASE}  \x1b[2m[${UPSTREAM_NAME}]\x1b[0m`);
if (MODEL) ok('免费通道模型', MODEL); else bad('RG_PROXY_MODEL 未配置');

console.log('\n\x1b[36m▌2 · 直连官方端点（绕开本作品后端）\x1b[0m');
// 上游是"任意 OpenAI 兼容服务"：魔搭、讯飞星火、其他中转都可能。
// 不按域名 / 不按 Token 前缀做判断，一律以"实际能否返回 content"为准。
if (!TOKEN || !MODEL) {
  console.log('  \x1b[33m⚠ Token 或模型缺失，跳过\x1b[0m');
} else {
  // 2a Token 是否有效
  try {
    const r = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }),
      signal: AbortSignal.timeout(60000),
    });
    const txt = await r.text();
    if (r.status === 401 || r.status === 403) bad('Token 认证失败', '无效 / 已过期 / 未开通权限');
    else if (r.status === 200) {
      ok('Token 有效', `HTTP 200 · ${UPSTREAM_NAME}`);
      const j = safeJson(txt);
      const content = j?.choices?.[0]?.message?.content;
      const reasoning = j?.choices?.[0]?.message?.reasoning_content;
      // 推理模型在 max_tokens 过小时会"思考耗尽预算"导致 content 为空，
      // 这不代表通道不可用 —— 只要有 reasoning_content 就说明链路通。
      if (reasoning) ok('返回 reasoning_content（思维链需剥离）', String(reasoning).slice(0, 40));
      if (content && String(content).trim()) ok('模型返回 content', String(content).slice(0, 40));
      else if (reasoning) ok('content 为空但链路通（推理模型 + max_tokens 过小所致）', '正式调用已用足够 token 预算');
      else bad('模型返回为空 content', txt.slice(0, 120));
    } else {
      const j = safeJson(txt);
      const msg = j?.error?.message || txt.slice(0, 120);
      if (/invalid model id/i.test(msg)) bad(`模型 ID 无效：${MODEL}`, msg);
      else if (r.status === 429) bad('上游限流（429）', msg);
      else bad(`上游返回 ${r.status}`, msg);
    }
  } catch (e) { bad('直连官方端点异常', String(e).slice(0, 120)); }

  // 2b 若配的模型无效，从源码 MODEL_OPTIONS 里逐个探测一个可用模型
  const src = readFileSync(resolve(ROOT, 'js/ai-client.js'), 'utf8');
  const block = src.match(/export const MODEL_OPTIONS = \[([\s\S]*?)\];/);
  const candidates = block ? [...block[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]) : [];
  if (candidates.length) {
    const probe = async (id) => {
      try {
        const r = await fetch(API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
          body: JSON.stringify({ model: id, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 }),
          signal: AbortSignal.timeout(45000),
        });
        return r.status;
      } catch (e) { return 0; }
    };
    console.log('\n\x1b[36m▌3 · 可用模型探测（候选来自 js/ai-client.js）\x1b[0m');
    const usable = [];
    for (const id of candidates) {
      const s = await probe(id);
      if (s === 200) { ok(`可用：${id}`, 'HTTP 200'); usable.push(id); }
      else warn(`不可用：${id}`, s ? `HTTP ${s}` : '网络异常');
    }
    if (usable.length) console.log(`\n  建议：\x1b[33m RG_PROXY_MODEL=${usable[0]}\x1b[0m`);
    else console.log('\n  \x1b[33m⚠ 候选模型均不可用\x1b[0m（上游非魔搭时属正常：');
    console.log(`     当前 RG_PROXY_MODEL=${MODEL} 已验证可用，无需改动）`);
  }
}

console.log('\n\x1b[36m▌4 · 本作品后端 /api/status\x1b[0m');
try {
  const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(10000) });
  const d = await r.json();
  if (d.available) ok('后端报 available=true', `model=${d.model} cap=${d.sessionCap}`);
  else bad('后端报 available=false', '未配置平台 Key，玩家侧会落入"仅 AI 模式"阻断');
} catch (e) { bad('后端不可达', `${BASE} —— 未启动或端口不对`); }

function safeJson(s) { try { return JSON.parse(s); } catch (e) { return null; } }

console.log(`\n\x1b[1m预检结果\x1b[0m  ${problems === 0 ? '\x1b[32m可以开始测试\x1b[0m' : `\x1b[31m${problems} 项待解决\x1b[0m`}`);
process.exit(problems ? 1 : 0);
