#!/usr/bin/env node
/* ============================================================
 * 延迟与模型可用性实测工具
 * 用法：
 *   MODELSCOPE_TOKEN=ms-xxx node tools/latency-test.mjs            # 测全部 MODEL_OPTIONS 模型
 *   MODELSCOPE_TOKEN=ms-xxx node tools/latency-test.mjs Qwen/Qwen3.8-Flash-Next  # 测单个模型
 *   node tools/latency-test.mjs --help
 * 输出：每个模型 20 次调用的 P50/P95/平均延迟、成功率、总 token 估算。
 * 结果供创作手记引用——没跑出来的数据不要写进文档。
 * ============================================================ */
import { readFileSync } from 'node:fs';

const TOKEN = process.env.MODELSCOPE_TOKEN || process.env.RG_PROXY_TOKEN || '';
if (!TOKEN || !TOKEN.startsWith('ms-')) {
  console.error('✗ 未检测到有效 Token。请设置环境变量：MODELSCOPE_TOKEN=ms-xxxx node tools/latency-test.mjs');
  process.exit(1);
}

// 从源码同步模型列表，避免清单漂移
const src = readFileSync(new URL('../js/ai-client.js', import.meta.url), 'utf8');
const MODEL_BLOCK = src.match(/export const MODEL_OPTIONS = \[([\s\S]*?)\];/);
if (!MODEL_BLOCK) { console.error('✗ 无法从 ai-client.js 解析 MODEL_OPTIONS'); process.exit(1); }
const MODELS = [...MODEL_BLOCK[1].matchAll(/id: '([^']+)'/g)].map((m) => m[1]);
const TARGETS = process.argv[2] && !process.argv[2].startsWith('-') ? [process.argv[2]] : MODELS;
const N = Number(process.env.N || 20);
const API = 'https://api-inference.modelscope.cn/v1/chat/completions';

const percentile = (arr, p) => arr[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))];

for (const model of TARGETS) {
  const latencies = [];
  const fails = [];
  for (let i = 0; i < N; i++) {
    const prompt = i % 3 === 0
      ? '你是推理游戏里的嫌疑人陈默，用不超过40个字回应：侦探问你「21:30断电时你在哪」。'
      : '用一句话（≤30字）描述暴雨夜的画廊。';
    const t0 = Date.now();
    try {
      const resp = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` },
        body: JSON.stringify({
          model, messages: [{ role: 'user', content: prompt }],
          temperature: 0.8, max_tokens: 360, stream: false,
        }),
        signal: AbortSignal.timeout(45000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 80)}`);
      const data = await resp.json();
      const content = data?.choices?.[0]?.message?.content || '';
      if (!content.trim()) throw new Error('空回复');
      latencies.push(Date.now() - t0);
    } catch (e) {
      fails.push(String(e.message || e).slice(0, 60));
    }
    await new Promise((r) => setTimeout(r, 300)); // 轻微间隔防 429
  }
  if (!latencies.length) {
    console.log(`\n✗ ${model}：${N} 次全部失败——${[...new Set(fails)][0] || '未知'}（建议从 MODEL_OPTIONS 删除或标注不可用）`);
    continue;
  }
  latencies.sort((a, b) => a - b);
  const okRate = ((latencies.length / N) * 100).toFixed(0);
  console.log(`\n✓ ${model}`);
  console.log(`  成功率 ${latencies.length}/${N}（${okRate}%）`);
  console.log(`  延迟  P50 ${percentile(latencies, 50)}ms · P95 ${percentile(latencies, 95)}ms · 平均 ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)}ms · 最大 ${latencies[latencies.length - 1]}ms`);
  if (fails.length) console.log(`  失败样本：${[...new Set(fails)].slice(0, 3).join(' | ')}`);
}
console.log('\n（把以上实测数据写进创作手记时请如实引用；本工具不记录任何对话内容。）');
