#!/usr/bin/env node
/* ============================================================
 * 免费通道代理基址 / CORS 修复回归
 * ------------------------------------------------------------
 * 针对 v3.6.1 评审意见的常驻断言，零外部依赖、不需要后端、
 * 不消耗上游额度——可直接放进 CI 的阻断级 static job。
 *
 * 覆盖点：
 *   1. 基址校验矩阵：path / query / hash / userinfo / 协议 / 非法 URL 必须被拒
 *   2. 归一化落盘：setProxyBase 只保存根址（origin），拼接 /api/* 不会落进参数
 *   3. 探测超时在位：probeProxy 体内含 AbortController + clearTimeout + 超时常量
 *   4. 保存流程顺序：validateProxyBase 必须早于全部 setter（先校验后落盘）
 *   5. DOM 位置：基址输入必须在 #custom-key-block 之外（免费模式不被 dim 禁用）
 *   6. CORS fail-closed：app.py 不得把空白名单回落成 ["*"]
 *   7. v3.7 · 求助系统不可一键通关（合规闸 + 计分惩罚 + 落盘字段）
 *   8. v3.7 · 模型 ID 配置链 + 流式思维链剥离（见上方 getModel/modelOptions/stripThinking 断言）
 *   9. v3.7 · 终幕契约：评估不自动跑、computeScore 可存档重算、行为快照带关系数值
 *
 * 用法：node tools/proxy-base-test.mjs
 * ============================================================ */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const failures = [];
const t = (ok, msg, extra) => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${msg}${extra ? `  \x1b[2m${extra}\x1b[0m` : ''}`); }
  else { fail++; failures.push(msg); console.log(`  \x1b[31m✗\x1b[0m ${msg}${extra ? `  \x1b[2m→ ${extra}\x1b[0m` : ''}`); }
};
const section = (name) => console.log(`\n\x1b[36m▌${name}\x1b[0m`);

const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');

/* ============================================================
 * 1. 基址校验矩阵（真跑 js/ai-client.js 的导出函数）
 * ============================================================ */
section('1 · 代理基址校验矩阵');
const { validateProxyBase, setProxyBase, getProxyBase } = await import('../js/ai-client.js?v=3.6.0');

const ACCEPT = ['', 'https://h', 'https://h/', 'https://host.example', 'http://127.0.0.1:8092'];
const REJECT = [
  ['https://h?x=1', '查询参数'],
  ['https://h/?x=1', '查询参数（尾斜杠后）'],
  ['https://h#x', '片段'],
  ['https://h/api', '路径'],
  ['https://h/api/', '路径（尾斜杠）'],
  ['ftp://h', '非 http(s) 协议'],
  ['javascript:alert(1)', '危险协议'],
  ['data:text/plain,x', 'data URL'],
  ['https://u:p@h', 'URL 内嵌凭据'],
  ['https://h:99999', '非法端口'],
  ['not a url', '非法 URL'],
];

for (const v of ACCEPT) {
  const r = validateProxyBase(v);
  t(r.ok === true, `接受：${JSON.stringify(v)}`, r.message);
}
for (const [v, why] of REJECT) {
  const r = validateProxyBase(v);
  t(r.ok === false, `拒绝：${JSON.stringify(v)}（${why}）`, r.ok ? `竟然通过 → ${r.message}` : r.message);
}

/* ============================================================
 * 2. 归一化落盘：拼接 /api/* 不得落入 path/query/hash
 * ============================================================ */
section('2 · 归一化与拼接');
const NORMALIZE = [
  ['https://api.example.com', 'https://api.example.com/api/status'],
  ['https://api.example.com/', 'https://api.example.com/api/status'],
  ['https://api.example.com///', 'https://api.example.com/api/status'],
  ['http://127.0.0.1:8092', 'http://127.0.0.1:8092/api/status'],
  ['', '/api/status'],   // 留空 = 同源相对路径
];
for (const [input, expected] of NORMALIZE) {
  const saved = setProxyBase(input);
  const joined = `${getProxyBase()}/api/status`;
  t(joined === expected, `拼接：${JSON.stringify(input)} → ${expected}`, `实际 ${joined}（落盘 ${JSON.stringify(saved)}）`);
}
// 非法输入落盘必须被清空（回退同源），不能把脏值写进 localStorage
for (const bad of ['https://h/api', 'https://h?x=1', 'https://h#x', 'https://u:p@h']) {
  const saved = setProxyBase(bad);
  t(saved === '', `非法输入清空存储：${JSON.stringify(bad)}`, `落盘 ${JSON.stringify(saved)}`);
}
setProxyBase('');   // 复位

/* ============================================================
 * 3. 探测超时在位（源码静态断言）
 * ============================================================ */
section('3 · probeProxy 超时');
{
  const src = read('js/ai-client.js');
  const start = src.indexOf('export async function probeProxy()');
  t(start >= 0, 'probeProxy 存在');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  t(/AbortController/.test(body), 'probeProxy 使用 AbortController');
  t(/clearTimeout\(/.test(body), 'probeProxy 清理定时器（防泄漏）');
  t(/controller\.abort\(\)/.test(body), 'probeProxy 有 abort 调用点');
  t(/PROBE_TIMEOUT_MS/.test(src), '定义了 PROBE_TIMEOUT_MS 常量');
  const cst = src.match(/const PROBE_TIMEOUT_MS = (\d+);/);
  t(!!cst && Number(cst[1]) > 0 && Number(cst[1]) <= 30000, 'PROBE_TIMEOUT_MS 取值合理',
    cst ? `${cst[1]}ms` : '未找到');
}

/* ============================================================
 * 4. 保存流程顺序：先全部校验，再统一落盘
 * ============================================================ */
section('4 · 设置保存流程顺序');
{
  const src = read('js/game.js');
  // 取保存按钮 handler 的函数体（从 addEventListener 到第一个匹配的收尾）
  const anchor = src.indexOf("$('btn-save-settings').addEventListener('click'");
  t(anchor >= 0, '定位保存按钮 handler');
  const body = src.slice(anchor, anchor + 6000);
  const first = (re) => {
    const m = body.match(re);
    // 绝对偏移 = body 起始 + 命中位置。原先写成 m.index + body.slice(0,m.index).length
    // 等于 2*m.index，报出的 L… 行号是错的（CodeRabbit 抓到）。
    return m ? anchor + m.index : -1;
  };
  const lineOf = (idx) => (idx < 0 ? -1 : src.slice(0, idx).split('\n').length);

  const lineValidateProxy = lineOf(first(/validateProxyBase\(/));
  const lineValidateEp = lineOf(first(/validateEndpointUrl\(/));
  const lineSetProxy = lineOf(first(/setProxyBase\(/));
  const lineSetEp = lineOf(first(/setEndpointUrl\(/));
  const lineSetWl = lineOf(first(/setEndpointWhitelist\(/));
  const lineSetToken = lineOf(first(/aiSettings\.setToken\(/));

  t(lineValidateProxy > 0 && lineSetProxy > lineValidateProxy,
    'validateProxyBase 早于 setProxyBase', `校验 L${lineValidateProxy} / 落盘 L${lineSetProxy}`);
  t(lineValidateEp > 0 && lineSetEp > lineValidateEp,
    'validateEndpointUrl 早于 setEndpointUrl', `校验 L${lineValidateEp} / 落盘 L${lineSetEp}`);
  // 核心：任何 setter 都不得出现在对应校验之前
  t(lineSetEp > lineValidateEp && lineSetWl > lineValidateEp && lineSetProxy > lineValidateProxy,
    '端点/白名单/基址三类 setter 全部晚于校验',
    `端点 ${lineSetEp} > ${lineValidateEp} · 白名单 ${lineSetWl} · 基址 ${lineSetProxy} > ${lineValidateProxy}`);
  t(lineSetToken > lineSetProxy && lineSetToken > lineSetEp,
    'aiSettings.setToken 在所有 setter 之后', `L${lineSetToken} 晚于 setProxyBase(L${lineSetProxy}) / setEndpointUrl(L${lineSetEp})`);

  // 附带修正：代理基址变更必须能触发重探测（旧代码恒为 false）
  const probe = anchor + body.indexOf('probeProxy()');
  t(/getProxyBase\(\) !== prevProxy|proxyChanged/.test(body) && probe > 0,
    '代理基址变更后可触发重新探测');
}

/* ============================================================
 * 5. DOM 位置：基址输入必须在 #custom-key-block 之外
 * ============================================================ */
section('5 · 设置面板 DOM 位置');
{
  const html = read('index.html');
  const lines = html.split('\n');
  const blockLine = lines.findIndex((l) => l.includes('id="custom-key-block"')) + 1;
  const lastProxyLine = lines.reduce((acc, l, i) => (l.includes('settings-proxy-base') ? i + 1 : acc), 0);
  const firstProxyLine = lines.findIndex((l) => l.includes('settings-proxy-base')) + 1;
  t(blockLine > 0, '找到 #custom-key-block', `L${blockLine}`);
  t(lastProxyLine > 0, '找到 settings-proxy-base', `L${firstProxyLine}~L${lastProxyLine}`);
  t(lastProxyLine < blockLine, '基址输入在 #custom-key-block 之前（免费模式可编辑）',
    `基址 L${lastProxyLine} < 容器 L${blockLine}`);
  // 反向：容器区间内不得再出现基址控件
  const blockIdx = html.indexOf('id="custom-key-block"');
  const closeIdx = html.lastIndexOf('<!-- /custom-key-block -->');
  const inside = closeIdx > blockIdx ? html.slice(blockIdx, closeIdx) : '';
  t(!inside.includes('settings-proxy-base'), '容器内已无基址控件',
    inside.includes('settings-proxy-base') ? '仍在 #custom-key-block 内' : '已移出');
}

/* ============================================================
 * 6. CORS fail-closed
 * ============================================================ */
section('6 · 服务端 CORS 默认拒绝');
{
  const py = read('app.py');
  // 关键回归：任何形式的「空白名单回落通配」都不允许出现
  const allowLine = py.split('\n').find((l) => /^\s*allow_origins\s*=/.test(l)) || '';
  t(!!allowLine, '找到 allow_origins 配置行', allowLine.trim());
  t(!/\bor\s*\[?\s*["']\*["']\s*\]?/.test(allowLine),
    'allow_origins 未把空白名单回落成 ["*"]', allowLine.trim());
  t(/allow_origins\s*=\s*_cors_origins\(\)/.test(py),
    'allow_origins 直接取 _cors_origins() 的返回值（空列表 = 拒绝跨域）', allowLine.trim());
  t(/def _cors_origins\(\)/.test(py), '白名单解析收敛到 _cors_origins()');
  t(/allow_credentials=False/.test(py), 'allow_credentials 保持 False（不与通配 Origin 组合）');
  const doc = py.split('\n').find((l) => l.includes('def _cors_origins'));
  const idx = py.indexOf('def _cors_origins');
  t(/"""[\s\S]*?"""/.test(py.slice(idx, idx + 400)), '_cors_origins 带 docstring');
}

/* ============================================================
 * 7. .env 引号剥离（Linux 沙盒踩坑回归）
 *    .env 写成 RG_PROXY_API_BASE="https://..." 时若不剥引号，
 *    值会带引号进入 httpx → scheme 变成 https" → UnsupportedProtocol → 502。
 *    表现为 URL repr 完全正常，极难定位。
 * ============================================================ */
section('7 · .env 引号剥离（上游 502 UnsupportedProtocol 回归）');
{
  const srv = read('tools/_api_server.py');
  t(/def _strip_quotes\(/.test(srv), '_api_server.py 定义了 _strip_quotes()');
  t(/_strip_quotes\(m\[1\]\)/.test(srv), '.env 值经过 _strip_quotes 处理');
  t(/line\.startswith\('#'\)/.test(srv), '.env 解析跳过空行与注释行');

  // 真跑剥离逻辑（用 python 直接验证语义，避免 python/node 语法差异）
  const cases = [
    ['"https://h/v1/chat/completions"', 'https://h/v1/chat/completions'],
    ["'https://h/v1/chat/completions'", 'https://h/v1/chat/completions'],
    ['https://h/v1/chat/completions', 'https://h/v1/chat/completions'],
    ['  "https://h"  ', 'https://h'],
    ['"', '"'],            // 单个引号不配成对，原样保留
    ['', ''],
  ];
  let allOk = true;
  const got = [];
  for (const [raw, want] of cases) {
    const out = execFileSync('python3', ['-c', `
import sys
def _strip_quotes(v: str) -> str:
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] and v[0] in ('"', "'"):
        return v[1:-1]
    return v
print(_strip_quotes(sys.argv[1]))
`, raw]).toString().trim();
    got.push(`${JSON.stringify(raw)} → ${JSON.stringify(out)}`);
    if (out !== want) allOk = false;
  }
  t(allOk, '_strip_quotes 语义正确（成对引号才剥，单引号/空值不动）', got.join(' · '));

  // app.py 自己也该对上游 URL 做防御性 strip：即便有人绕过加载器直接导出裸引号值
  t(/os\.environ\.get\("RG_PROXY_API_BASE"[^)]*\)\.strip\(\)/.test(read('app.py')),
    'app.py 对 API_BASE 做了 strip（与加载器双保险）');
}

/* ============================================================
 * 8. 模型配置链（Phase 0：getModel 门槛 / MODEL_OPTIONS / 流式剥思维链 / 跨局计数）
 * ============================================================ */
section('8 · 模型 ID 配置链与流式思维链剥离');
{
  const { aiSettings, stripThinking, MODEL_OPTIONS, rotateSessionId, proxyState } =
    await import('../js/ai-client.js?v=3.6.0');

  // 8.1 setModel(x) → getModel() === x：任何非空 ID 都是合法模型
  // 分两条腿测，缺一条就漏：
  //   a) 同实例：memoryModel 命中（页面内切换模型）
  //   b) 重新 import：memoryModel 为空，走 storage.getItem 的冷启动分支——
  //      这才是原 bug 的所在（刷新页面/新开一局后自定义 ID 被白名单重置）。
  //      Node 下 storage.js 降级为进程内 Map，所以必须重新 import 模块才能重置 memoryModel。
  const saved = aiSettings.getModel();
  let keepOk = true;
  let coldOk = true;
  const keepDetail = [];
  const coldDetail = [];

  for (const m of ['glm-4-plus', 'spark-x2.6', 'Qwen/Qwen3.5-27B', 'my/custom-model-9000']) {
    aiSettings.setModel(m);
    if (aiSettings.getModel() !== m) { keepOk = false; keepDetail.push(`${m} → ${aiSettings.getModel()}`); }

    // 冷启动分支：换一个全新模块实例（相当于刷新页面）
    const fresh = await import('../js/ai-client.js?v=3.6.0&cold=' + encodeURIComponent(m));
    if (fresh.aiSettings.getModel() !== m) {
      coldOk = false;
      coldDetail.push(`${m} → ${fresh.aiSettings.getModel()}`);
    }
  }
  t(keepOk, 'getModel() 同实例不过滤自定义模型 ID', keepDetail.join(' · '));
  t(coldOk, 'getModel() 冷启动（刷新后）不过滤自定义模型 ID', coldDetail.join(' · '));
  aiSettings.setModel(saved);   // 还原，避免污染后续模块读默认值

  // 8.2 白名单里必须有免费通道在用的模型，否则下拉框选不到真实模型
  t(MODEL_OPTIONS.some((m) => m.id === 'spark-x2.6'), 'MODEL_OPTIONS 含 spark-x2.6（免费通道在用）',
    MODEL_OPTIONS.map((m) => m.id).join(' '));

  // 8.3 思维链四种形态都不泄漏（含截断的未闭合标签）
  const OPEN = '<' + 'think' + '>';
  const CLOSE = '</' + 'think' + '>';
  const B_OPEN = '<|begin_of_thought|>';
  const B_CLOSE = '<|end_of_thought|>';
  const stripCases = [
    [OPEN + 'a' + CLOSE + 'b', 'b', '闭合 think 段'],
    [B_OPEN + '思维链' + B_CLOSE + '正文', '正文', '闭合 begin_of_thought 段'],
    [OPEN + '半句被 max_tokens 截断的思维链', '', '未闭合 think（截断残留）'],
    [B_OPEN + '只有开头标记', '', '未闭合 begin_of_thought'],
    ['（指节收紧）……我昨晚在家。', '（指节收紧）……我昨晚在家。', '普通台词不受影响'],
  ];
  for (const [input, want, why] of stripCases) {
    const got = stripThinking(input);
    t(got === want, `剥离思维链：${why}`, `got ${JSON.stringify(got)}`);
  }

  // 8.4 跨局计数归零：rotateSessionId 后「本局剩余 N 次」必须从 0 重新计
  proxyState.sessionUsed = 7;
  rotateSessionId();
  t(proxyState.sessionUsed === 0, 'rotateSessionId() 归零本局计数', `实际 ${proxyState.sessionUsed}`);
  aiSettings.setModel(saved);   // 还原，避免污染后续模块读默认值
}

/* ============================================================
 * 9. 求助系统：不给一键通关，扣分可存档重算
 * ============================================================ */
section('9 · 求助系统（方向性提示 + 计分惩罚）');
{
  const { hintPenalty, hintsLeft, HINT_LIMIT, sanitizeHint } = await import('../js/hint.js?v=3.6.0');

  // 9.1 扣分曲线：每次 -2、封顶 -6，脏数据归零不返负
  const penCases = [[0, 0], [1, 2], [2, 4], [3, 6], [4, 6], [-1, 0], [undefined, 0], ['2', 4]];
  let penOk = true; const penDetail = [];
  for (const [n, want] of penCases) {
    const got = hintPenalty(n);
    if (got !== want) { penOk = false; penDetail.push(`${n}→${got}(期望${want})`); }
  }
  t(penOk, 'hintPenalty 曲线（每次-2/封顶-6/脏数据归零）', penDetail.join(' · '));

  // 9.2 次数上限：一局 3 次，越界归零不返负
  t(HINT_LIMIT === 3, '一局 3 次求助');
  t(hintsLeft(0) === 3 && hintsLeft(3) === 0 && hintsLeft(9) === 0, '剩余次数不返负');

  // 9.3 合规闸：方向性提示放行，代写问句/物证名/结论/引号复述/paraphrase 一律拦
  const { CASE } = await import('../js/case-data.js?v=3.6.0');
  const sus = CASE.suspects.find((s) => s.id === 'chenmo');
  const known = CASE.evidences.slice(0, 2);
  const badHints = [
    ['你能告诉我画框夹层里的信是谁留下的吗？', '代写可照抄问句'],
    ['那把沾着钴蓝颜料的 CZ-07 裁纸刀就是关键。', 'paraphrase 点名物证（子串匹配失效）'],
    ['关于' + known[0].name + '，你再想想。', '物证原名'],
    ['真凶就是陈默。', '直接给结论'],
    ['他说「我八点半才到馆里」时眼神躲闪。', '全角引号复述原话'],
    ['试试把"痕迹"和"物品"连起来问。', '半角引号复述（实测出现过）'],
    ['x'.repeat(200), '超长'],
    ['', '空串'],
  ];
  let gateOk = true; const gateDetail = [];
  for (const [bad, why] of badHints) {
    if (sanitizeHint(bad, sus, known) !== null) { gateOk = false; gateDetail.push(why); }
  }
  t(gateOk, '合规闸拦下全部违规提示（不许一键通关）', gateDetail.join(' · '));
  t(sanitizeHint('他谈到母亲时语速变了。', sus, known) === '他谈到母亲时语速变了。', '方向性提示正常放行');
}

/* ============================================================
 * 10. 终幕契约：评估不自动跑 + 评分可重算 + 快照带关系数值
 * ============================================================ */
section('10 · 终幕契约（动感计分 / 主动评估 / 快照补全）');
{
  const gameSrc = read('js/game.js');
  const profSrc = read('js/profiler.js');

  // 10.1 runFinal 不得自动渲染评估报告——必须走 CTA
  t(!/renderEvaluationReport\(sc\);\s*\n\s*state\.finished/.test(gameSrc),
    'runFinal 不自动调用 renderEvaluationReport（改为 renderCapabilityCTA）');
  t(/renderCapabilityCTA\(sc\)/.test(gameSrc), 'runFinal 渲染能力评估 CTA');
  t(/id="btn-capability"[\s\S]{0,200}renderEvaluationReport\(sc\)/.test(gameSrc),
    'CTA 按钮点击后才调 renderEvaluationReport');

  // 10.2 resumeGamePhase 的 final 分支也不得自动跑（续玩未生成的应显示 CTA）
  t(!/state\.evaluation\s*&&\s*state\.evaluation\.profile[\s\S]{0,160}renderEvaluationReport\(sc\)/.test(gameSrc),
    'resumeGamePhase final 分支不自动生成评估');

  // 10.3 computeScore 纯函数：只读落盘字段（hintsUsed 会进存档）
  t(/const hints = \(state\.stats && state\.stats\.hintsUsed\) \|\| 0;/.test(gameSrc)
    && /hintPenalty\(hints\)/.test(gameSrc), 'computeScore 从 state.stats.hintsUsed 算惩罚（可存档重算）');

  // 10.4 动感计分组件在位
  t(/requestAnimationFrame/.test(gameSrc) && /function animateScoreRow/.test(gameSrc)
    && /function animateTotal/.test(gameSrc), '动感计分三件套（rAF / 单行 / 总分）');

  // 10.5 行为快照补全：信任/敌意/阶段/丢失物证
  // 注意必须把正则限定在 buildBehaviorSnapshot 函数体内——
  // 直接在全文件搜 `trust: st.trust` 会被别处（关系条/陪审团 digest）命中，
  // 快照自己那份被删掉也查不出来（变异测试实测踩过）。
  const snapFn = (() => {
    const m = gameSrc.match(/function buildBehaviorSnapshot\(\)[\s\S]*?\n\}/);
    return m ? m[0] : '';
  })();
  t(snapFn.length > 0
    && /trust: st\.trust/.test(snapFn) && /hostility: st\.hostility/.test(snapFn)
    && /stage: stageOf\(st\)/.test(snapFn) && /lostEvidence: state\.lostEvidence/.test(snapFn),
    'buildBehaviorSnapshot 函数体内含 trust/hostility/stage/lostEvidence',
    snapFn ? '' : '未定位到 buildBehaviorSnapshot');
  t(/关系走向（终局）/.test(profSrc) && /被销毁丢失/.test(profSrc),
    'buildStatsDigest 输出关系走向与被销毁物证行');
}

/* ============================================================
 * 11. CodeRabbit 第二轮修复回归（18 条，逐条钉死防回退）
 * ============================================================ */
section('11 · 第二轮评审修复回归');
{
  const aiSrc = read('js/ai-client.js');
  const gameSrc = read('js/game.js');
  const cssSrc = read('css/style.css');
  const promptSrc = read('js/prompts.js');
  const saSrc = read('js/suspect-ai.js');
  const hintSrc = read('js/hint.js');
  const appSrc = read('app.py');
  const gitattr = read('.gitattributes');
  const devSrc = read('tools/dev-server.sh');

  // 11.1（Major）流式思维链：跨 chunk 有状态剥离，两处分支都接 sanitizer
  t(/function createStreamSanitizer\(\)/.test(aiSrc), '流式剥离改为跨 chunk 有状态');
  t((aiSrc.match(/sanitizer\.push\(sseDeltaPiece/g) || []).length === 2, '两处 SSE 分支都接 sanitizer');
  t((aiSrc.match(/sanitizer\.flush\(\)/g) || []).length === 2, '两处都有 flush 收尾');
  t(!/typeof delta\.content === 'string'\) return stripThinking/.test(aiSrc),
    'sseDeltaPiece 不再逐 chunk 调 stripThinking');

  // 11.2 CORS 暴露 Retry-After + 注释与配置一致
  t(/expose_headers=\["Retry-After"\]/.test(appSrc), 'CORS expose_headers 含 Retry-After');
  t(!/Authorization 头予以允许/.test(appSrc), 'CORS 注释不再声称放行 Authorization');

  // 11.3 崩溃摇头 + 心跳不再互相覆盖（rotate/scale 独立属性）
  t(/@keyframes headShake[\s\S]{0,80}rotate:/.test(cssSrc), 'headShake 改用 rotate 属性');
  t(/@keyframes tensionPulse[\s\S]{0,60}scale:/.test(cssSrc), 'tensionPulse 改用 scale 属性');

  // 11.4 评级徽章不被 ID 选择器 display 覆盖 hidden
  t(!/#score-rank-badge\s*\{[^}]*display:/.test(cssSrc), '徽章无 display 覆盖（hidden 生效）');

  // 11.5 求助并发守卫 + 切换嫌疑人校验 + 旧档 NaN 兜底
  t(/let hintBusy = false/.test(gameSrc) && /if \(hintBusy\) return/.test(gameSrc), '求助并发守卫');
  t(/state\.activeSuspect !== sid/.test(gameSrc), '求助回来校验嫌疑人未切换');
  t(/const stats = ensureStats\(\);\s*\n\s*stats\.hintsUsed \+= 1/.test(gameSrc), '求助先 ensureStats（防 NaN）');

  // 11.6 出示物证后刷新对峙条 + 头像态统一 avatarMood
  t(/renderEvidenceBar\(\);\s*\n\s*renderSuggestQuestions\(\);\s*\n\s*save\(\);/.test(gameSrc),
    'doPresent 成功后刷新对峙条');
  t(!/const curMood = stageOf\(st\)/.test(gameSrc), '头像重绘不再用 stageOf');

  // 11.7 评级音效判定按前缀
  t(/\/\^\[SA\]\/\.test\(sc\.rank\.label\)/.test(gameSrc), '评级音效按 label 前缀判断');
  t(!/\['S', 'A'\]\.includes\(sc\.rank\.label\)/.test(gameSrc), '不再整串比较 label');

  // 11.8 模型 ID 校验在阶段一（落盘之前）
  {
    const iValidate = gameSrc.indexOf('选择了「自定义模型」但没填 ID');
    const iPersist = gameSrc.indexOf('if (epVal) setEndpointUrl(epVal)');
    t(iValidate > 0 && iPersist > 0 && iValidate < iPersist, '模型 ID 校验早于落盘',
      `校验@${iValidate} 落盘@${iPersist}`);
  }

  // 11.9 免费通道模型说明随 syncEndpointUI 刷新
  t(/showFreeChannelModel\(\);\s*\n\}/.test(gameSrc), 'syncEndpointUI 末尾刷新模型说明');

  // 11.10 求助超时真正生效
  t(/withTimeout\([\s\S]{0,400}HINT_TIMEOUT_MS/.test(hintSrc), 'requestHint 用 withTimeout(HINT_TIMEOUT_MS)');

  // 11.11 反注入标签真实存在（askSuspect 包裹 question）
  t(/<侦探问话>\$\{question\}<\/侦探问话>/.test(saSrc), 'askSuspect 包裹 <侦探问话>');
  t(!/content: \(preHint \? preHint \+ '\\n' : ''\) \+ question \}/.test(saSrc), '裸 question 推送已移除');

  // 11.12 非流式兜底有超时 + 回收裁判结果
  t(/result = await withTimeout\([\s\S]{0,320}NPC_TIMEOUT_MS/.test(saSrc), '兜底调用加超时');
  t(/judgeHit = await judgeSettled/.test(saSrc), '兜底路径回收裁判结果');

  // 11.13 开场句括号配对
  t(/（玩家"老陆"）的当面问话/.test(promptSrc), '开场句括号配对');

  // 11.14 陈默身份文案（之子非遗孀）
  t(!/遗孀/.test(read('js/case-data.js')), 'case-data 无「遗孀」误写');

  // 11.15 dev-server 探活三件套
  t(/import fastapi, uvicorn, httpx/.test(devSrc), 'dev-server 探活 fastapi+uvicorn+httpx');
  t(!/没有装 fastapi 的解释器也允许启动/.test(devSrc), '删除误导的回退注释');

  // 11.16 proxy-base-test 自身 first() 偏移
  t(!/m\.index \+ body\.slice\(0, m\.index\)\.length/.test(read('tools/proxy-base-test.mjs')),
    'first() 偏移不再算成 2*m.index');

  // 11.17 README 断言数与实际一致（74）
  t(!/proxy-base-test 61 断言/.test(read('README.md')), 'README 断言数已更新');
  t(/proxy-base-test 74 断言/.test(read('README.md')), 'README 记录 74 断言');

  // 11.18 .gitattributes 注释不再说"按平台还原"
  t(!/检出时按平台还原/.test(gitattr), '.gitattributes 注释已纠正');
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
console.log('\x1b[32m✓ 代理基址 / CORS / 模型配置链回归全部通过\x1b[0m');
