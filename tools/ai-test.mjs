#!/usr/bin/env node
/* ============================================================
 * 大模型模拟生产测试（一键入口）
 * ------------------------------------------------------------
 * 串起三层验证，依次执行、逐层给出结论：
 *
 *   1. 预检      tools/precheck.mjs     凭证 / 模型 / 后端连通性
 *   2. 契约      tools/contract-test.mjs /api/* 出站契约 + 计额 + 安全守卫
 *   3. 端到端    tools/e2e-real.mjs      真实浏览器跑完整一局（含流式 AI）
 *
 * 用法：
 *   node tools/ai-test.mjs                 # 全部
 *   node tools/ai-test.mjs --contract      # 只跑契约
 *   node tools/ai-test.mjs --e2e           # 只跑端到端
 *   node tools/ai-test.mjs --base http://127.0.0.1:8092
 *
 * 前置条件：
 *   - .env 已配置 RG_PROXY_TOKEN / RG_PROXY_MODEL / RG_PROXY_API_BASE
 *   - 后端已启动（默认 127.0.0.1:8092，可用 --base 指定）
 *   - 端到端另需本机 Chrome（脚本内已写死常见路径）
 *
 * 密钥只从 .env / 环境变量读取，绝不打印，绝不写入日志或提交物。
 * ============================================================ */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const BASE = opt('--base', process.env.E2E_BASE || 'http://127.0.0.1:8092');
const ONLY_CONTRACT = flag('--contract');
const ONLY_E2E = flag('--e2e');
const SKIP_PRECHECK = flag('--skip-precheck');

const run = (script, args = [], { allowFail = false } = {}) => {
  const path = resolve(ROOT, 'tools', script);
  if (!existsSync(path)) { console.log(`  ⚠ 缺少 ${script}，跳过`); return false; }
  const t0 = Date.now();
  try {
    execFileSync(process.execPath, [path, ...args], {
      cwd: ROOT, encoding: 'utf8', stdio: 'inherit',
      env: { ...process.env, E2E_BASE: BASE }, timeout: 900000,
    });
    console.log(`\n  ✓ ${script} 通过（${Math.round((Date.now() - t0) / 1000)}s）\n`);
    return true;
  } catch (e) {
    console.log(`\n  ✗ ${script} 未通过（${Math.round((Date.now() - t0) / 1000)}s）`);
    if (e.stdout) console.log(e.stdout);
    if (e.stderr) console.log(e.stderr);
    if (!allowFail) process.exit(1);
    return false;
  }
};

const line = (t) => console.log(`\n\x1b[36m${'='.repeat(60)}\n ${t}\n${'='.repeat(60)}\x1b[0m`);

if (!existsSync(resolve(ROOT, '.env'))) {
  console.log('\n✗ 未找到 .env —— 大模型测试需要配置上游凭证。');
  console.log('  请参考 README「免费 AI 通道配置」创建 .env（该文件已被 gitignore）。\n');
  process.exit(1);
}

let ok = true;

if (!SKIP_PRECHECK && !ONLY_CONTRACT && !ONLY_E2E) {
  line('1/3 · 通道预检');
  ok = run('precheck.mjs', ['--base', BASE]) && ok;
}

if (!ONLY_E2E) {
  line('2/3 · API 契约测试');
  ok = run('contract-test.mjs', ['--base', BASE]) && ok;
}

if (!ONLY_CONTRACT) {
  line('3/3 · 真实 AI 端到端');
  ok = run('e2e-real.mjs', [BASE]) && ok;
}

line(ok ? '全部通过 ✓' : '存在未通过项 ✗');
process.exit(ok ? 0 : 1);
