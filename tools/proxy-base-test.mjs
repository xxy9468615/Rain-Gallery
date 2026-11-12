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

/* ---- Python 解释器探测（Windows 常只有 python 没有 python3） ---- */
let _pyCmd = null;
let _pyProbed = false;
function pythonCmd() {
  if (_pyProbed) return _pyCmd;
  _pyProbed = true;
  // 探针必须覆盖测试脚本真实的语法需求：_strip_quotes 与 docstring 扫描都用了
  // Py3 的类型注解（(v: str) -> str）。只探 print(1) 的话 Python 2 也能过，
  // 随后跑到真脚本就 SyntaxError 炸掉 pre-commit（CodeRabbit 抓到）。
  const probe = "def f(v: str) -> str:\n    return v\nprint(f('1'))";
  for (const cmd of ['python3', 'python']) {
    try {
      const out = execFileSync(cmd, ['-c', probe], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out === '1') { _pyCmd = cmd; break; }
    } catch (e) { /* 不可用或版本过低，试下一个 */ }
  }
  return _pyCmd;
}

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
  const PY = pythonCmd();
  if (!PY) {
    console.log('  \x1b[33m⚠\x1b[0m _strip_quotes 测试跳过（未找到 python3/python）');
  } else for (const [raw, want] of cases) {
    const out = execFileSync(PY, ['-c', `
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
  // 未跳过才断言：PY 为空时 allOk 仍是初值 true，无条件断言会伪装成通过（假绿）
  if (PY) {
    t(allOk, '_strip_quotes 语义正确（成对引号才剥，单引号/空值不动）', got.join(' · '));
  }

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

  // 8.2 白名单里必须有免费通道默认在用的模型，否则下拉框选不到真实模型
  //     （2026-11 选型后默认 = gemma-4-31B-it，备用 = gpt-oss-120b）
  t(MODEL_OPTIONS.some((m) => m.id === 'gemma-4-31B-it'), 'MODEL_OPTIONS 含默认模型 gemma-4-31B-it',
    MODEL_OPTIONS.map((m) => m.id).join(' '));
  t(MODEL_OPTIONS.some((m) => m.id === 'gpt-oss-120b'), 'MODEL_OPTIONS 含备用模型 gpt-oss-120b');
  t(MODEL_OPTIONS.every((m) => ['gemma-4-31B-it', 'gpt-oss-120b'].includes(m.id)),
    '不在架的模型已从 MODEL_OPTIONS 清理');

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
  const htmlSrc = read('index.html');
  const { createStreamSanitizer, withTimeout } = await import('../js/ai-client.js?v=3.6.0');

  // 11.1（Major）流式思维链：跨 chunk 有状态剥离，两处分支都接 sanitizer
  t(/function createStreamSanitizer\(\)/.test(aiSrc), '流式剥离改为跨 chunk 有状态');
  t((aiSrc.match(/sanitizer\.push\(sseDeltaPiece/g) || []).length === 2, '两处 SSE 分支都接 sanitizer');
  t((aiSrc.match(/sanitizer\.flush\(\)/g) || []).length === 2, '两处都有 flush 收尾');
  t(!/typeof delta\.content === 'string'\) return stripThinking/.test(aiSrc),
    'sseDeltaPiece 不再逐 chunk 调 stripThinking');
  t((aiSrc.match(/if \(!full\) throw \{ code: 'EMPTY'/g) || []).length === 2,
    '两处流式分支都做 EMPTY 判空（空响应走非流式兜底）');

  // 11.1b（第三轮）行为用例：真跑 sanitizer，验证跨 chunk 拼接而不只查源码结构
  {
    const run = (chunks) => {
      const s = createStreamSanitizer();
      let out = '';
      for (const c of chunks) out += s.push(c);
      return out + s.flush();
    };
    const splitThink = run(['<thi', 'nk>想', '很久</th', 'ink>你好']);
    t(splitThink === '你好', 'sanitizer 跨 chunk 剥离被拆开的思维链',
      `实际 ${JSON.stringify(splitThink)}`);
    const spaced = run(['Hello', ' world']);
    t(spaced === 'Hello world', 'sanitizer 跨 chunk 保留英文空格',
      `实际 ${JSON.stringify(spaced)}`);
    const dangling = run(['你好<']);
    t(dangling === '你好<', 'flush 放行末尾未闭合的 <',
      `实际 ${JSON.stringify(dangling)}`);

    // 无配对开标签的闭标签会作为字面文本出现——这是已知边界（注释里列过），
    // 固化成断言，防止将来有人"顺手修好"它时破坏累积串语义。
    const orphanClose = run(['正文', '</' + 'think' + '>']);
    t(orphanClose === '正文</' + 'think' + '>', '无配对开标签的闭标签按字面处理',
      `实际 ${JSON.stringify(orphanClose)}`);

    // 等价性：同一输入按不同 chunk 切分，输出必须一致。
    // 这是守住 sanitizer 语义的最强防线——曾想改成"只扫尾部"的增量版，
    // 单测全过却在随机切分下 112/200 组不一致（CodeRabbit 的谨慎是对的）。
    const seededRandom = (seed) => {          // 确定性 PRNG：测试不靠运气
      let s = (seed * 9301 + 49297) % 233280;
      return () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    };
    let mismatch = 0; let firstBad = '';
    for (let i = 0; i < 200; i++) {
      const rnd = seededRandom(i + 1);
      const n = 1 + Math.floor(rnd() * 30);
      let src = '';
      for (let j = 0; j < n; j++) {
        const r = rnd();
        // 四类标签形态都要覆盖：完整开标签（进隐藏区）/ 成对闭标签（出隐藏区）/
        // 未闭合开标签（挂在末尾被暂扣）/ 畸形标签（缺 > 的边界）——早先漏了第一种，
        // 200 组样本实际没测过"进出隐藏区"的切分一致性（CodeRabbit 抓到）。
        src += r < 0.08 ? '<' + 'think' + '>想'                 // 完整开标签 → 进隐藏区
          : r < 0.16 ? '</' + 'think' + '>正文'                  // 闭标签 → 出隐藏区
          : r < 0.22 ? '<' + 'think' + '想'                      // 畸形：缺 >
          : r < 0.28 ? ' '
          : `词${j} `;
      }
      const whole = run([src]);                       // 整串一次
      const perChar = run([...src]);                  // 最苛刻：逐字符
      const halves = run([src.slice(0, Math.ceil(src.length / 2)),
                          src.slice(Math.ceil(src.length / 2))]);
      if (whole !== perChar || whole !== halves) {
        mismatch += 1;
        if (!firstBad) firstBad = `src=${JSON.stringify(src)} 整串=${JSON.stringify(whole)} 逐字=${JSON.stringify(perChar)}`;
      }
    }
    t(mismatch === 0, 'sanitizer 输出与 chunk 切分无关（200 组随机）', firstBad);
  }

  // 11.1c（第四轮）超时必须中止底层请求，避免占死 LOAD_GATE 槽位
  {
    let seen = null;
    const err = await withTimeout((signal) => {
      seen = signal;
      return new Promise((_, rej) => {
        signal.addEventListener('abort', () => rej({ code: 'ABORT' }), { once: true });
      });
    }, 30).catch((e) => e);
    t(seen && seen.aborted === true && err && err.code === 'TIMEOUT',
      'withTimeout 超时中止底层请求并返回 TIMEOUT',
      `aborted=${seen && seen.aborted} err=${err && err.code}`);
    t(/await acquireGate\(opts\.signal\)/.test(aiSrc), '闸门获取接收中止信号');
    t(/signal\.addEventListener\('abort', onAbort/.test(aiSrc), '排队中的请求可被中止撤销');
    t(/promiseFactory\(controller\.signal\)/.test(aiSrc), '超时信号传入请求工厂');
    t((saSrc.match(/NPC_MAX_TOKENS, signal/g) || []).length === 4, '四处 NPC 调用转发 signal');
    t(/kind: 'judge', signal/.test(saSrc) && /JURY_TOKENS, signal/.test(saSrc),
      '裁判 / 陪审团调用转发 signal');
    t(/maxTokens: 200, signal/.test(hintSrc), '求助调用转发 signal');
    t(/maxTokens: 900, signal/.test(read('js/profiler.js')), '侧写报告调用转发 signal');
  }

  // 11.2 CORS 暴露 Retry-After + 注释与配置一致
  t(/expose_headers=\["Retry-After"\]/.test(appSrc), 'CORS expose_headers 含 Retry-After');
  t(!/Authorization 头予以允许/.test(appSrc), 'CORS 注释不再声称放行 Authorization');

  // 11.3 崩溃摇头 + 心跳不再互相覆盖（rotate/scale 独立属性）
  t(/@keyframes headShake[\s\S]{0,80}rotate:/.test(cssSrc), 'headShake 改用 rotate 属性');
  t(/@keyframes tensionPulse[\s\S]{0,60}scale:/.test(cssSrc), 'tensionPulse 改用 scale 属性');
  t(/\.avatar-dialog\.mood-broken\s*\{[^}]*animation:[^;]*tensionPulse/.test(cssSrc),
    '崩溃态摇头与心跳合并播放（不被 animation 简写覆盖）');
  t(!/\.dialog-head \.avatar\s*\{[^}]*transition: all/.test(cssSrc), '头像过渡不再用 transition: all');

  // 11.4 评级徽章不被 ID 选择器 display 覆盖 hidden
  t(!/#score-rank-badge\s*\{[^}]*display:/.test(cssSrc), '徽章无 display 覆盖（hidden 生效）');

  // 11.5 求助并发守卫 + 切换嫌疑人校验 + 旧档 NaN 兜底
  t(/let hintBusy = false/.test(gameSrc) && /if \(hintBusy\) return/.test(gameSrc), '求助并发守卫');
  t(/state\.activeSuspect !== sid/.test(gameSrc), '求助回来校验嫌疑人未切换');
  t(/const stats = ensureStats\(\);\s*\n\s*stats\.hintsUsed \+= 1/.test(gameSrc), '求助先 ensureStats（防 NaN）');
  t(/left: hintsLeft\(used\) \}/.test(gameSrc), '兜底旁白 left 与 requestHint 契约一致');
  t(/stats\.hintsUsed = Math\.max\(0, stats\.hintsUsed - 1\)/.test(gameSrc),
    '切走时未送达旁白退回求助额度');
  t(/stats\.hintsUsed = Math\.max\(0, stats\.hintsUsed - 1\);\s*\n\s*renderSuggestQuestions\(\);/.test(gameSrc),
    '退回额度后立即重绘求助区');

  // 11.6 出示物证后刷新对峙条 + 头像态统一 avatarMood
  t(/renderEvidenceBar\(\);\s*\n\s*renderSuggestQuestions\(\);\s*\n\s*save\(\);/.test(gameSrc),
    'doPresent 成功后刷新对峙条');
  t(!/const curMood = stageOf\(st\)/.test(gameSrc), '头像重绘不再用 stageOf');

  // 11.7 评级音效判定按前缀（不能整串比较——label 是完整文案，恒 false）
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
  t(/try:\s*\n\s*import gradio as gr[\s\S]{0,140}except ImportError as e:/.test(appSrc),
    'app.py gradio 导入可缺省（与 dev-server 探测一致）');
  t(/except ImportError as e:[\s\S]{0,140}getattr\(e, 'name', None\) != 'gradio'/.test(appSrc),
    '仅 gradio 缺失时回退，内部依赖故障照常抛出');
  t(/gr is not None[\s\S]{0,400}_root = app/.test(appSrc), '无 gradio 时回退 FastAPI 宿主');
  t(!/没有装 fastapi 的解释器也允许启动/.test(devSrc), '删除误导的回退注释');

  // 11.16 proxy-base-test 自身 first() 偏移
  t(!/m\.index \+ body\.slice\(0, m\.index\)\.length/.test(read('tools/proxy-base-test.mjs')),
    'first() 偏移不再算成 2*m.index');

  // 11.17 README 断言数黑名单已停用：写死数字 + 历史黑名单每次加断言都要同步改，
  // 漏改时报的红与功能无关。改到文件末尾与运行时 pass+fail 总数对账。

  // 11.18 .gitattributes 注释不再说"按平台还原"
  t(!/检出时按平台还原/.test(gitattr), '.gitattributes 注释已纠正');

  // 11.27 部署契约：dev-server 不得让 .env 覆盖外部环境变量
  //   （实测踩过：shell 里 export 了 spark-x2.6，跑起来仍是 gemma——
  //     set -a; . .env 无条件覆盖，表现为"换了配置却不生效"）
  {
    const src = read('tools/dev-server.sh');
    t(/_EXT_TOKEN="\$\{RG_PROXY_TOKEN-__unset__\}"/.test(src)
      && /export RG_PROXY_TOKEN="\$_EXT_TOKEN"/.test(src),
      'dev-server：外部 RG_PROXY_* 优先于 .env');
    t(/RG_PROXY_SKIP_ENV_FILE/.test(src), 'dev-server：可用 SKIP_ENV_FILE 完全绕过 .env');
  }

  // 11.28 app.py 默认值与当前在用的免费通道一致（漏配时不会落到已下架模型）
  t(/RG_PROXY_MODEL", "gemma-4-31B-it"/.test(appSrc), 'app.py 默认模型 = gemma-4-31B-it');
  t(/RG_PROXY_API_BASE", "https:\/\/api\.generalcompute\.com/.test(appSrc),
    'app.py 默认端点 = generalcompute');
  t(/MODELSCOPE_SDK_TOKEN/.test(appSrc), 'app.py Token 回退读 MODELSCOPE_SDK_TOKEN');

  // 11.39 整数环境变量溢出也要兜住（int(float('1e309')) 抛 OverflowError）
  t(/except \(TypeError, ValueError, OverflowError\)/.test(appSrc),
    '_int_env 捕获 OverflowError（1e309/inf 不崩）');
  const preSrc2 = read('tools/precheck.mjs');
  t(/u\.protocol !== 'https:'/.test(preSrc2),
    'precheck 回退魔搭令牌前要求 HTTPS（http 明文不发令牌）');
  t(/if \(TOKEN && MODEL\)/.test(preSrc2),
    'precheck 用最终选中的 TOKEN 判断配置（只配 MODELSCOPE_TOKEN 不误判为空）');

  // 11.29 Python 函数 docstring 全覆盖（CodeRabbit Docstring Coverage 门槛）
  // 扫描逻辑抽成函数：既跑真实扫描，也用来验证 catch 分支真会把失败记下来。
  // 早先是自指正则（在测试文件里搜自己的字符串），恒为真、守不住行为——
  // CodeRabbit 抓到，改为注入必然崩溃的脚本做行为验证。
  const runDocstringScan = (script) => {
    try {
      const cmd = pythonCmd();
      if (!cmd) return { skipped: true };   // 两处调用统一走探测：Windows 只有 python
      return { missing: execFileSync(cmd, ['-c', script], { cwd: ROOT, encoding: 'utf8' }).trim() };
    } catch (e) {
      if (e && e.code === 'ENOENT') return { skipped: true };   // 解释器缺失 → 跳过
      const tail = String((e && (e.stderr || e.message)) || e).trim().split('\n').slice(-1)[0];
      return { error: tail };                                   // 扫描崩溃 → 记失败
    }
  };
  {
    const scan = [
      'import ast, pathlib',
      'bad = []',
      'for p in sorted(pathlib.Path(".").rglob("*.py")):',
      '    if set(p.parts) & {".git","node_modules",".venv-test","雨夜画廊游戏展示"}:',
      '        continue',
      '    tree = ast.parse(p.read_text(encoding="utf-8"))',
      '    for n in ast.walk(tree):',
      '        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and ast.get_docstring(n) is None:',
      '            bad.append(f"{p}:{n.name}")',
      'print(len(bad))',
    ].join('\n');
    const r = runDocstringScan(scan);
    if (r.skipped) console.log('  \x1b[33m⚠\x1b[0m Python docstring 检查跳过（python3 不可用）');
    else t(r.missing === '0', 'Python 函数 docstring 全覆盖',
      r.error || (r.missing === '0' ? '' : `缺失 ${r.missing} 个`));
  }
  {
    // 先处理 skipped：只有 python3 确实存在时才验证「崩溃会被记录」。
    // 否则 Windows（常有 python 无 python3）上这条自测会把 CI 染红。
    const probe = runDocstringScan('print(1)');
    if (probe.skipped) {
      console.log('  \x1b[33m⚠\x1b[0m 扫描错误自测跳过（python3 不可用）');
    } else {
      const r = runDocstringScan('def broken(:');
      t(!r.skipped && !!r.error, '扫描崩溃时记失败而非静默跳过', r.error || '（被吞掉了）');
    }
  }

  // 11.20 UI 分层收ulaire：设置页三段 + 高级折叠
  t(/class="settings-section"/g.test(htmlSrc) && (htmlSrc.match(/class="settings-section"/g) || []).length >= 3,
    '设置页分为三段收纳');
  t((htmlSrc.match(/class="settings-fold"/g) || []).length >= 4, '高级项收进折叠块');
  t(!/#custom-key-block\.dim \{ opacity:/.test(cssSrc) && /#custom-key-block\.dim \{ display: none; \}/.test(cssSrc),
    '免费模式下高级区整块隐藏（不再半透明铺开）');

  // 11.21 合议庭进行中反馈（分步状态 + 不定进度 + 计时）
  t(/function startJuryPending\(\)/.test(gameSrc), '合议庭有进行中可视化');
  t(/jury-seal/.test(gameSrc) && /jury-step/.test(gameSrc) && /jury-progress/.test(gameSrc),
    '等待态含状态分步与进度条');
  t(/setInterval/.test(gameSrc) && /clearInterval\(timer\)/.test(gameSrc), '计时器可正确清理');
  t(/const stopJuryPending = startJuryPending\(\)/.test(gameSrc)
    && /stopJuryPending\(\);/.test(gameSrc), '启动与终止配对（成功/失败路径都收尾）');

  // 11.22 终幕卷宗化：时间线节点卡片 + 真相导语 + 五维条
  t(/className = 'tl-node'/.test(gameSrc) && /tl-dot/.test(gameSrc) && /tl-card/.test(gameSrc),
    '时间线改为时间徽标 + 轨道卡片');
  t(/className = 'lead'/.test(gameSrc), '真相首段作导语');
  t(/class="dims-bars"/.test(gameSrc), '能力报告补五维数值条');
  t(/function escapeHtml\(/.test(gameSrc) && /esc\(report\.title\)/.test(gameSrc),
    'AI 报告文本经 escapeHtml 后再进 innerHTML');

  // 11.23 免费通道模型选型（2026-11 实测）：默认 gemma · 备用 gpt-oss-120b
  t(/id: 'gemma-4-31B-it'/.test(aiSrc) && /默认/.test(aiSrc.match(/id: 'gemma-4-31B-it'.*/)[0]),
    'MODEL_OPTIONS 默认 = gemma-4-31B-it');
  {
    const block = aiSrc.slice(aiSrc.indexOf('export const MODEL_OPTIONS'));
    const body = block.slice(0, block.indexOf('];'));
    const ids = (body.match(/\{ id: '([^']+)'/g) || []).map((s) => s.replace(/\{ id: '|'$/g, ''));
    t(ids.length === 2 && ids.includes('gpt-oss-120b'), 'MODEL_OPTIONS 只保留默认 + 备用',
      ids.join(' '));
  }

  // 11.24 模型输出被 markdown 代码块包裹也能解析（gemma 实测如此）
  t(/match\(\/\\\{\[\\s\\S\]\*\\\}\/\)/.test(saSrc), '裁判 JSON 从代码块中提取');
  const stripFence = (t) => String(t).replace(/```json\s*|```/g, '').match(/\{[\s\S]*\}/);
  t(!!stripFence('```json\n{"tag":"a","confidence":0.9}\n```'), '代码块包裹的 JSON 可被提取');

  // 11.25 结案音效按评级分四档（此前只有「S/A vs 其他」二值）
  const audSrc = read('js/audio.js');
  ['rankS', 'rankA', 'rankB', 'rankC'].forEach((fn) => {
    t(new RegExp(`${fn}\\(\\)\\s*\\{`).test(audSrc), `audio.${fn}() 已定义`);
  });
  t(/rankS, A: audio\.rankA/.test(gameSrc) || /\{ S: audio\.rankS, A: audio\.rankA/.test(gameSrc),
    'renderScore 按评级调用四档音色');
  t(!/audio\.wrong\(\)/.test(gameSrc), '不再用失败音播放低分评级');

  // 11.26 文案不用港台用语
  for (const [word, why] of [['在架', '在售/提供'], ['在綫', '在线'], ['備份', '备份']]) {
    t(!new RegExp(word).test(aiSrc + htmlSrc + gameSrc + cssSrc), `文案无「${word}」（应作${why}）`);
  }

  // 11.30 不把「怎么问」的策略贴在输入框下方（降低推理难度）
  t(!/id="dialog-hint"/.test(htmlSrc), '审讯区无「问到点子上」常驻提示');
  t(!/dialog-hint/.test(gameSrc + cssSrc), '无 JS/CSS 残留引用 dialog-hint');
  t(/旁白只点方向/.test(gameSrc), '求助入口保留代价说明（扣分告知，非难度提示）');

  // 11.31 物证弹窗不再附送「该拿这条去对质谁」（注释里留说明可以，渲染逻辑不行）
  {
    const codeOnly = gameSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    t(!/侦探直觉/.test(codeOnly), '物证弹窗无「侦探直觉」指向提示');
    t(!/class="implicate"/.test(codeOnly), 'openEvidenceModal 不再渲染 implicate 段落');
  }
  // 但 implicates 字段本身必须保留：suspect-ai 的 addCrack 算分依赖它
  t(/evidence\.implicates/.test(saSrc), 'implicates 仍供 addCrack 内部算分使用');

  // 11.32 物证 detail 不得写成结论（不得出现「就该找X」「已确认是X干的」这类断语）
  const caseSrc = read('js/case-data.js');
  t(!/这是.{0,6}的秘密/.test(caseSrc), 'detail 不直接点破「这是谁的秘密」');
  t(!/她谎称/.test(caseSrc), 'detail 不替玩家下「她在撒谎」的判断');
  t(!/值得当面对质/.test(caseSrc), 'detail 不指示下一步该怎么操作');

  // 11.33 模型测试按钮读对 testConnection 的返回字段（Major 误报为不可用）
  t(/const r = await testConnection\(/.test(gameSrc) && /r\.latency/.test(gameSrc),
    '测试结果显示 latency（不是不存在的 ok/ms）');
  t(!/r\.ok \?/.test(gameSrc), '不再读不存在的 r.ok');

  // 11.34 魔搭 SDK Token 不会在第三方端点被回退（凭据误用防护）
  // 必须按 URL 主机名判断：字符串包含会被 modelscope.cn.attacker.example 绕过
  // （CodeRabbit 抓到）。断言的是"用 urlparse + hostname"，不是那个漏洞写法。
  t(/_modelscope_fallback_ok/.test(appSrc) && /urlparse/.test(appSrc)
    && /parsed\.hostname/.test(appSrc),
    'Token 回退按 URL 主机名判断（不被相似域名绕过）');
  t(!/"modelscope\.cn" in API_BASE/.test(appSrc), '已移除字符串包含判断');
  // 分步读入 + 前置条件判断；不用单行 or 链（那既是缺陷形态，
  // 也会被托管平台的内容扫描误判为敏感模式而回退文件）
  t(/_sdk_token_if_allowed/.test(appSrc) && /PROXY_TOKEN = _PROXY_TOKEN_PRIMARY or _PROXY_TOKEN_FALLBACK/.test(appSrc),
    'Token 分步读入且带前置条件');
  t(!/os\.environ\.get\("RG_PROXY_TOKEN"\)\s*\n?\s*or \(os\.environ\.get\("MODELSCOPE_SDK_TOKEN/.test(appSrc),
    '不再是单行 or 链');

  // 11.35 SKIP_ENV_FILE=1 时无 .env 也能启动
  t(/SKIP_ENV_FILE:-0\}" != "1" \]/.test(devSrc), '无 .env 时认 SKIP_ENV_FILE 开关');

  // 11.36 docstring 扫描失败必须记失败，不能吞掉算通过
  const selfSrc = read('tools/proxy-base-test.mjs');
  // （11.36 的两条自指正则已删除：它们在测试文件里搜自己的字符串，恒为真、
  //   守不住行为。改为上面注入崩溃脚本的行为验证。）
  // README 的断言数改到文件末尾与运行时 pass+fail 对账，不再写死数字。

  // 11.37 静态字段也走 escapeHtml（与 renderEvalBox 同规则，避免以后漏改）
  t(/esc\(title\)/.test(gameSrc) && /esc\(found\)/.test(gameSrc), '物证弹窗文本经 escapeHtml');
  t(/esc\(sc\.rank\.label\)/.test(gameSrc) && /esc\(sc\.rank\.desc\)/.test(gameSrc),
    '评级 badge/desc 经 escapeHtml');

  // 11.38 预检工具默认上游与服务端一致（否则凭据发错服务商）
  const preSrc = read('tools/precheck.mjs');
  t(/api\.generalcompute\.com\/v1\/chat\/completions/.test(preSrc),
    'precheck 默认上游 = generalcompute（与 app.py 一致）');
}

/* ============================================================
 * 汇总
 * ============================================================ */
/* ---------- README 断言数对账（运行时总数，不写死数字） ----------
 * 放在所有断言之后：加减断言无需同步改任何固定值，README 对不上就报红。
 * +1 是把这条对账断言自己算进去（它也会计入 pass），否则永远差一。 */
{
  const readme = read('README.md');
  const m = readme.match(/proxy-base-test (\d+) 断言/);
  // 无 python 环境会跳过 3~4 条（_strip_quotes、docstring 扫描及其自测），
  // 因此允许"少于 README"，只不许凭空多出来。
  const actual = pass + fail + 1;
  const hasPython = !!pythonCmd();
  t(!!m && (hasPython ? Number(m[1]) === actual : Number(m[1]) >= actual),
    'README 断言数与运行时一致',
    m
      ? `README=${m[1]} 实际=${actual}${hasPython ? '' : '（无 python，跳过若干条，允许少于 README）'}`
      : 'README 未记录断言数');
}

console.log(`\n\x1b[1m合计\x1b[0m  \x1b[32m通过 ${pass}\x1b[0m · \x1b[31m失败 ${fail}\x1b[0m`);
if (fail) {
  console.log('\n\x1b[31m失败项：\x1b[0m');
  failures.forEach((f) => console.log('  · ' + f));
  process.exit(1);
}
console.log('\x1b[32m✓ 代理基址 / CORS / 模型配置链回归全部通过\x1b[0m');
