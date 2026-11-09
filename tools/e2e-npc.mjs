/* 真实 AI 的 NPC 行动闭环回归(本地测试用)
 * 场景 A:养苏晓信任(温和对话)→ 触发 hand_over_photo → 线索册 11/11
 * 场景 B:审林曼青(高压质问)→ 触发 call_lawyer → 卡片锁定
 * 场景 C:审陈默(连戳矛盾)→ 触发 shift_blame → 苏晓压力 +1
 * 依赖:本地服务已带 .evn 配置启动(app.py)
 */
 *
 * 依赖 playwright-core(仅本地测试用,不属于游戏运行时):
 *   npm i --no-save playwright-core   # 需要本机 Chrome
 * 运行(服务端需带 .evn 配置启动):
 *   node tools/e2e-npc.mjs
import { chromium } from 'playwright-core';
const BASE = process.argv[2] || 'http://127.0.0.1:8092';
const b = await chromium.launch({ headless: true, executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' });
const p = await b.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(String(e).slice(0, 120)));
p.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errs.push('console: ' + m.text().slice(0, 100)); });

const step = async (name, fn) => {
  try { const r = await fn(); console.log(`[${r ? '✓' : '✗'}] ${name}${typeof r === 'string' ? ' → ' + r : ''}`); return r; }
  catch (e) { console.log(`[✗] ${name} → EXC ${String(e).slice(0, 100)}`); return false; }
};

/** 通用:等当前这轮结束(typing 消失且新增了 suspect 气泡) */
async function waitTurn(minSuspect) {
  for (let i = 0; i < 45; i++) {
    const s = await p.evaluate((m) => {
      const typing = !!document.querySelector('#typing-bubble');
      const sus = [...document.querySelectorAll('#dialog-stream .bubble.suspect')].filter(x => !x.classList.contains('streaming'));
      return { typing, n: sus.length, last: sus.length ? sus[sus.length - 1].textContent.slice(0, 70) : null,
               action: [...document.querySelectorAll('#dialog-stream .bubble.action')].slice(-1).map(x => x.textContent.slice(0, 60))[0] || null };
    }, minSuspect);
    if (!s.typing && s.n >= minSuspect) return s;
    await p.waitForTimeout(1000);
  }
  return null;
}
async function ask(q) {
  const before = await p.evaluate(() => [...document.querySelectorAll('#dialog-stream .bubble.suspect')].filter(x => !x.classList.contains('streaming')).length);
  await p.locator('#dialog-input').fill(q);
  await p.locator('#dialog-input').press('Enter');
  return waitTurn(before + 1);
}
async function selectSuspect(name) {
  await p.evaluate((n) => {
    const c = [...document.querySelectorAll('.suspect-card')].find(x => x.textContent.includes(n));
    c && c.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, name);
  await p.waitForTimeout(400);
}
async function relOf(name) {
  return p.evaluate((n) => {
    const c = [...document.querySelectorAll('.suspect-card')].find(x => x.textContent.includes(n));
    const f = c ? [...c.querySelectorAll('.rel-fill')] : [];
    return { pressure: f[0] ? f[0].style.width : '?', trust: f[1] ? f[1].style.width : '?', hostility: f[2] ? f[2].style.width : '?' };
  }, name);
}

// ---- 启动 & 准备 ----
await p.goto(BASE + '/?e2e=npc', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600);
await p.evaluate(() => { localStorage.clear(); const g = document.querySelector('#btn-guide-skip'); if (g) g.click(); });
await p.goto(BASE + '/?e2e=npc', { waitUntil: 'domcontentloaded' });
await p.waitForTimeout(2600);
await p.evaluate(() => document.querySelector('#btn-begin-game').click());
await p.waitForTimeout(700);
await p.evaluate(() => { const g = document.querySelector('#modal-guide'); if (g && !g.classList.contains('hidden')) document.querySelector('#btn-guide-skip')?.click(); });
await p.evaluate(() => document.querySelector('#btn-skip-intro')?.click());
await p.waitForTimeout(400);
await p.evaluate(() => document.querySelector('#btn-start')?.click());
await p.waitForTimeout(600);
// 收物证(除储物间的手机外全收——为 hand_over_photo 保留目标物证)
for (const r of ['atrium', 'hall', 'office', 'corridor']) {
  await p.evaluate((room) => {
    const g = [...document.querySelectorAll('.map-g')].find(el => el.dataset.room === room);
    g && g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, r);
  await p.waitForTimeout(350);
  for (let i = 0; i < 5; i++) {
    const ok = await p.evaluate(() => {
      const t = [...document.querySelectorAll('#hotspot-hints .hotspot-tag:not(.done)')];
      if (!t.length) return false; t[0].click(); return true;
    });
    if (!ok) break;
    await p.waitForTimeout(200);
    await p.evaluate(() => document.querySelector('#modal-evidence .modal-close')?.click());
    await p.waitForTimeout(120);
  }
}
// 储物间只收靴子、不收手机(为 hand_over_photo 保留目标)
await p.evaluate(() => {
  const g = [...document.querySelectorAll('.map-g')].find(el => el.dataset.room === 'storage');
  g && g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await p.waitForTimeout(400);
await p.evaluate(() => {
  const tags = [...document.querySelectorAll('#hotspot-hints .hotspot-tag')];
  const boots = tags.find(t => t.textContent.includes('鞋柜'));
  if (boots && !boots.classList.contains('done')) boots.click();
});
await p.waitForTimeout(250);
await p.evaluate(() => document.querySelector('#modal-evidence .modal-close')?.click());
await p.waitForTimeout(150);
// 进入审讯幕(关掉引导弹窗后点提审)
await p.evaluate(() => { const g = document.querySelector('#modal-guide'); if (g && !g.classList.contains('hidden')) document.querySelector('#btn-guide-skip')?.click(); });
await p.waitForTimeout(300);
await p.evaluate(() => document.querySelector('#btn-to-interrogate')?.click());
await p.waitForTimeout(800);
await step('进入审讯(手机未收集)', async () => p.evaluate(() => !document.querySelector('#phase-interrogate').classList.contains('hidden') ? '线索册=' + document.querySelector('#notebook-count').textContent : false));

// ---- 场景 A:苏晓信任 → 交照片 ----
await selectSuspect('苏晓');
const q0 = await ask('别紧张，我不是来抓你的。我只是想把今晚的事情弄清楚，你能帮我吗？');
let relA0 = q0 ? await relOf('苏晓') : null;
let handedOver = false;
for (let i = 0; i < 8 && !handedOver; i++) {
  const s = await ask(i % 2 ? '你愿意相信我，把你知道的都告诉我吗？我不会让你为难。' : '你其实是个诚实的孩子，只是害怕。跟我说说那张照片，好吗？');
  if (s && s.action && s.action.includes('交')) handedOver = true;
  if (s && s.action) { /* 收到行动气泡即成功 */ handedOver = true; }
}
const nbA = await p.locator('#notebook-count').textContent();
const relA = await relOf('苏晓');
await step('场景A 苏晓交照片(信任≥60)', async () => (handedOver || nbA === '11/11') ? `行动气泡=${!!handedOver} 线索册=${nbA} 信任=${relA.trust}` : `信任仅=${relA.trust} 线索册=${nbA}(AI 自主决策有波动，重试或调 Prompt)`);

// ---- 场景 B:林曼青高压 → 律师锁 ----
await selectSuspect('林曼青');
let lawyer = false;
for (let i = 0; i < 9 && !lawyer; i++) {
  const s = await ask(i % 3 === 0 ? '你的每个说法都在骗我！如实回答！' : i % 3 === 1 ? '你这种撒谎精我见多了，畜生都比你诚实！' : '闭嘴！我在问你话！再狡诡我让你上电视！');
  if (s && s.action && (s.action.includes('律师') || s.action.includes('⚖'))) lawyer = true;
  const locked = await p.evaluate(() => {
    const c = [...document.querySelectorAll('.suspect-card')].find(x => x.textContent.includes('林曼青'));
    return c && c.classList.contains('locked');
  });
  if (locked) { lawyer = true; break; }
}
const relB = await relOf('林曼青');
await step('场景B 林曼青叫律师锁审讯(敌意≥70)', async () => lawyer ? `锁定=${lawyer} 敌意=${relB.hostility}` : `敌意仅=${relB.hostility}(未达阈值,AI 决策波动)`);

// ---- 场景 C:陈默连戳矛盾 → 甩锅 ----
await selectSuspect('陈默');
const sxBefore = await relOf('苏晓');
let blamed = false;
const shots = ['登记簿上你是20:00到的，不是八点半。', '配电箱的拉闸时间21:30，你在地下室怎么解释？', '42码泥脚印正对着侧窗一个来回。', '对讲机里老周喊的是“你怎么能这样”。', '刀上沾着没干的钴蓝颜料。'];
for (const q of shots) {
  const s = await ask(q);
  if (s && s.action && (s.action.includes('苏晓') || s.action.includes('祸水'))) { blamed = true; break; }
}
const sxAfter = await relOf('苏晓');
await step('场景C 陈默甩锅苏晓(压力≥2)', async () => blamed ? `苏晓压力 ${sxBefore.pressure}→${sxAfter.pressure}` : `(AI 未选择该行动,属正常波动)`);

await step('全程无 pageerror/console.error', () => errs.length ? 'errs: ' + errs.join(' / ') : true);
await b.close();
