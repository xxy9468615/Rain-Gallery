#!/usr/bin/env node
/* 全模块语法检查(严格按浏览器 ES Module 模式,而非 script 模式)
 * 背景:node --check 对无 package.json 的 .js 默认按 script 解析,
 * 会把 export 提前报错、掩盖真实语法错误。本项目源码全部以 module 加载。
 * 附带跨模块引用校验:防止"用了某 export 却没 import" 这类运行期 ReferenceError
 * (node --check 查不出未定义标识符,曾经两次因此拖垮整个页面)。
 * 用法:node tools/check-syntax.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const dir = resolve(process.cwd(), 'js');
const files = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => resolve(dir, f));
let fail = 0;
const sources = {};

for (const f of files) {
  const src = readFileSync(f, 'utf8');
  sources[f.replace(/^.*[\/]/, '')] = src;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--check', '-'], { input: src, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log('✓', f.replace(/^.*[\/]/, ''));
  } catch (e) {
    fail++;
    console.log('✗', f.replace(/^.*[\/]/, ''), '\n', (e.stderr || '').toString().split('\n').slice(0, 5).join('\n'));
  }
}

/* ---------- 跨模块引用校验 ----------
 * 收集所有 export 名,再扫描每个 import 的具名清单:
 * 1) import 了但源模块没有该 export → 死引用
 * 2) (轻量)模块内调用某 export 但未 import → ReferenceError 风险
 *    做法:汇总本目录全部 export 名,对每个模块找"被调用/被引用但既未 import 也未本地定义"的名字
 */
const exportsOf = {}; // module -> Set(names)
for (const [name, src] of Object.entries(sources)) {
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const as = part.match(/([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/);
      names.add(as ? as[2].trim() : part.trim());
    }
  }
  exportsOf[name] = names;
}
const LOCAL_DEF = /^(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;

for (const [name, src] of Object.entries(sources)) {
  const problems = [];
  // 1) import 的具名是否存在于被导入模块
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/([\w.-]+\.js)/g)) {
    const target = im[2].replace(/\?.*$/, '');
    const list = im[1];
    for (const part of list.split(',')) {
      const raw = part.replace(/\/\/.*/, '').trim();
      if (!raw) continue;
      const as = raw.match(/^([A-Za-z_$][\w$]*)\s+as\s+/);
      const want = as ? as[1] : raw;
      if (exportsOf[target] && !exportsOf[target].has(want)) {
        problems.push(`import 了 ${want} ← ${target} 未导出该名字(死引用)`);
      }
    }
  }
  // 2) 引用了"全项目只有别处 export"的标识符,而本文件既未 import 也未定义
  const imported = new Set();
  for (const im of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
    for (const part of im[1].split(',')) {
      const as = part.trim().match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)/);
      imported.add(as ? as[2].trim() : part.trim());
    }
  }
  const locallyDefined = new Set();
  for (const line of src.split('\n')) {
    const d = line.match(LOCAL_DEF);
    if (d) locallyDefined.add(d[2]);
    const p = line.match(/^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (p) locallyDefined.add(p[1]);
  }
  for (const [mod, set] of Object.entries(exportsOf)) {
    if (mod === name) continue; // 本模块 export 不算跨模块引用问题
    for (const sym of set) {
      if (sym.length < 4) continue; // 太短的易误报
      const used = new RegExp(`(?<![.\\w$])${sym}\\s*\\(`, 'm').test(src) || new RegExp(`\\b${sym}\\b`).test(src.replace(/import[^;]*;/g, ''));
      const isKnownLocal = locallyDefined.has(sym) || imported.has(sym);
      const usesAsCall = new RegExp(`(?<![.\\w$'"\`])${sym}\\s*\\(`).test(src);
      if (usesAsCall && !isKnownLocal && !imported.has(sym)) {
        // 排除:本文件也 export 了同名(再导出/自引用),或变量名恰好同名且本地有定义
        if (!exportsOf[name].has(sym) && !locallyDefined.has(sym)) {
          problems.push(`引用了 ${sym}()(来自 ${mod})但未 import → 运行期 ReferenceError 风险`);
        }
      }
    }
  }
  if (problems.length) {
    fail++;
    console.log('✗', name, '\n ', [...new Set(problems)].join('\n  '));
  }
}

if (fail === 0) console.log('✓ 跨模块引用校验通过');

/* ---------- 块注释吞代码校验 ----------
 * 曾经发生过:JSDoc 少写一个 "* /" 闭合,把紧随其后的整个函数注释掉。
 * 语法检查完全合法,但运行时会报 "xxx is not defined"。
 * 这里扫描每个块注释体,若其中出现顶格声明语句即视为异常。
 */
for (const [name, src] of Object.entries(sources)) {
  const re = /\/\*/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index;
    const lineStart = src.lastIndexOf('\n', start) + 1;
    if (src.slice(lineStart, start).includes('//')) { re.lastIndex = start + 2; continue; }
    const end = src.indexOf('*/', start + 2);
    const body = end === -1 ? src.slice(start) : src.slice(start, end + 2);
    if (/^(?:async\s+function|function|export|const\s|let\s)/m.test(body)) {
      const line = src.slice(0, start).split('\n').length;
      fail++;
      console.log(`✗ ${name}:${line} 块注释未闭合,疑似注释掉了后续声明`);
    }
    if (end === -1) break;
    re.lastIndex = end + 2;
  }
}
if (fail === 0) console.log('✓ 块注释配对校验通过');

process.exit(fail ? 1 : 0);
