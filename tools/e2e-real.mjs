/* 真实 AI 端到端回归(本地测试用):加载 → 徽标 → 开新局 → 收集物证 → 审讯 → 流式/裁判/行动
 *
 * 依赖 playwright-core(仅本地测试用,不属于游戏运行时):
 *   npm i --no-save playwright-core   # 另需本机 Chrome/Chromium
 * 运行(服务端需带 .env 配置启动,游戏本体挂在 /game/):
 *   node tools/e2e-real.mjs [http://127.0.0.1:8092]
 * 浏览器探测顺序见 tools/_browser.mjs（CHROME_PATH 可显式指定）
 */
import { launchBrowser } from './_browser.mjs';
const BASE = (process.argv[2] || 'http://127.0.0.1:8092').replace(/\/$/, '');
// app.py 把游戏本体挂在 /game/（Gradio 占根路径），/api/* 与静态同源
const GAME = `${BASE}/game/`;
const b = await launchBrowser();
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 150)));
p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });

const step = async (name, fn) => { const r = await fn(); console.log(`[${r ? '✓' : '✗'}] ${name}${typeof r === 'string' ? ' → ' + r : ''}`); return r; };

await p.goto(GAME, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600);

await step('徽标=免费AI(免费通道就绪)', async () => {
  const t = await p.evaluate(() => document.querySelector('#ai-badge').textContent);
  return t.includes('免费AI') ? t : t;
});

// 新开一局
await p.evaluate(() => { localStorage.clear(); });
await p.goto(GAME, { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600);
await step('开始游戏', async () => { await p.locator('#btn-begin-game').click(); await p.waitForTimeout(600); return p.evaluate(() => !document.querySelector('#narration-container').classList.contains('hidden') || !document.querySelector('#intro-text').classList.contains('hidden')); });
await step('跳过旁白', async () => { await p.evaluate(() => document.querySelector('#btn-skip-intro')?.click()); await p.waitForTimeout(400); return p.evaluate(() => !!document.querySelector('#btn-start')); });
await step('进入调查', async () => { await p.evaluate(() => document.querySelector('#btn-start')?.click()); await p.waitForTimeout(600); return p.evaluate(() => !document.querySelector('#phase-invest').classList.contains('hidden')); });

// 收集全部物证
let collected = 0;
for (const r of ['atrium', 'hall', 'office', 'storage', 'corridor']) {
  await p.evaluate((room) => {
    const g = [...document.querySelectorAll('.map-g')].find(el => el.dataset.room === room);
    g && g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, r);
  await p.waitForTimeout(350);
  for (let i = 0; i < 5; i++) {
    const ok = await p.evaluate(() => {
      const tags = [...document.querySelectorAll('#hotspot-hints .hotspot-tag:not(.done)')];
      if (!tags.length) return false;
      tags[0].click(); return true;
    });
    if (!ok) break;
    await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector('#modal-evidence .modal-close')?.click());
    await p.waitForTimeout(120);
  }
}
await step('物证 11/11', async () => p.locator('#notebook-count').textContent());

// 关闭首次上手引导弹窗(它会拦截点击)
await p.evaluate(() => { const g = document.querySelector('#modal-guide'); if (g && !g.classList.contains('hidden')) document.querySelector('#btn-guide-skip')?.click(); });
await p.waitForTimeout(300);
await step('进入审讯', async () => { await p.locator('#btn-to-interrogate').click(); await p.waitForTimeout(700); return p.evaluate(() => !document.querySelector('#phase-interrogate').classList.contains('hidden')); });
await step('三维数值条渲染', async () => p.evaluate(() => document.querySelectorAll('#dialog-head .rel-fill').length >= 3));
await step('建议提问气泡', async () => p.evaluate(() => document.querySelectorAll('.suggest-chip').length >= 3));

// 真实 AI 提问(含流式)
const t0 = Date.now();
await p.locator('#dialog-input').fill('登记簿上你是20:00到的，不是你说 的八点半。这半小时你在哪？');
await p.locator('#dialog-input').press('Enter');
let streamed = false; let replyText = '';
for (let i = 0; i < 40; i++) {
  const s = await p.evaluate(() => {
    const sb = document.querySelector('#dialog-stream .bubble.suspect.streaming');
    const typing = document.querySelector('#typing-bubble');
    const sus = [...document.querySelectorAll('#dialog-stream .bubble.suspect')].filter(b => !b.classList.contains('streaming'));
    return { streaming: sb ? sb.textContent.length : 0, typing: !!typing, done: sus.length, last: sus.length ? sus[sus.length - 1].textContent.slice(0, 60) : null };
  });
  if (s.streaming > 0) streamed = true;
  if (!s.typing && s.done >= 2) { replyText = s.last; break; }
  await p.waitForTimeout(1000);
}
await step('AI 流式回复(增量渲染)', async () => (streamed ? 'streamed' : 'NOT-streamed') + ' | ' + Math.round((Date.now() - t0) / 1000) + 's');
await step('回复内容', async () => replyText || '(空)');
await step('无 pageerror 无 console.error', () => errs.length ? 'errs: ' + errs.join(' / ') : true);

await b.close();
process.exit(0);
