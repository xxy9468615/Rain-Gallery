/* ============================================================
 * 跨平台浏览器启动（playwright-core 仅本地测试用，非运行时依赖）
 * ------------------------------------------------------------
 * 背景：e2e 脚本原先把 Chrome 路径写死成 Windows 的
 *   C:/Program Files/Google/Chrome/Application/chrome.exe
 * 换到 Linux/macOS 沙盒后必然失败（且没有可读的错误提示）。
 *
 * 这里按优先级探测常见安装位置，全部找不到时给出明确指引，
 * 而不是抛一个难以定位的 ENOENT。
 *
 * 优先级：
 *   1. 环境变量 CHROME_PATH（用户显式指定，最高优先）
 *   2. 各平台常见安装路径（见下表）
 *   3. playwright 自己的注册表缓存（chromium.headless shell）
 * ============================================================ */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/** 各平台常见浏览器可执行文件路径 */
const CANDIDATES = {
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    join(homedir(), 'AppData/Local/Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/local/bin/chromium',
    '/snap/bin/chromium',
    join(homedir(), '.local/bin/chromium'),
    // Flatpak 安装的 Chromium
    '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
    join(homedir(), '.local/share/flatpak/exports/bin/org.chromium.Chromium'),
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    join(homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  ],
};

const isExe = (p) => {
  try { return existsSync(p) && statSync(p).isFile(); } catch (e) { return false; }
};

/** 取出第一个真实存在的路径；找不到返回 null */
export function findBrowser() {
  const fromEnv = (process.env.CHROME_PATH || '').trim();
  if (fromEnv && isExe(fromEnv)) return fromEnv;

  const list = CANDIDATES[platform()] || [];
  for (const p of list) if (isExe(p)) return p;

  // 兜底：playwright 浏览器缓存（完整版 playwright 装过就会有）
  const cacheRoots = [
    join(homedir(), '.cache/ms-playwright'),
    join(homedir(), 'AppData/Local/ms-playwright'),
    join(homedir(), 'Library/Caches/ms-playwright'),
  ];
  // 新版 Chromium 用 chrome-linux64/，旧版用 chrome-linux/，都要覆盖
  const binDirs = ['chrome-linux64', 'chrome-linux', 'chrome-mac', 'chrome-win64', 'chrome-win32'];
  const binNames = platform() === 'win32'
    ? ['chrome.exe']
    : ['chrome', 'headless_shell', 'Chromium'];
  for (const root of cacheRoots) {
    if (!existsSync(root)) continue;
    let builds;
    try { builds = readdirSync(root); } catch (e) { continue; }
    for (const build of builds) {
      for (const dir of binDirs) {
        for (const name of binNames) {
          const p = join(root, build, dir, name);
          if (isExe(p)) return p;
        }
      }
    }
  }
  return null;
}

/**
 * 启动浏览器；找不到可执行文件时抛带指引的错误，
 * 而不是让调用方收到一个莫名其妙的 ENOENT。
 */
export async function launchBrowser(options = {}) {
  const { chromium } = await import('playwright-core');
  const executablePath = options.executablePath || findBrowser();
  if (!executablePath) {
    throw new Error(
      '未找到可用的 Chrome/Chromium 可执行文件。\n'
      + `  当前平台：${platform()}\n`
      + '  解决方式（任选其一）：\n'
      + '    · 设环境变量 CHROME_PATH=/path/to/chrome\n'
      + '    · Linux 安装：sudo apt install chromium-browser（或 google-chrome-stable）\n'
      + '    · Windows：安装 Chrome 到默认位置\n'
      + '  注意：e2e 测试属本地工具，不影响游戏运行时。',
    );
  }
  return chromium.launch({
    headless: true,
    executablePath,
    ...options.launchOptions,
  });
}
