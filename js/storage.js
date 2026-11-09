/* ============================================================
 * 安全存储层（SafeStorage）
 * ------------------------------------------------------------
 * 浏览器在以下场景访问 localStorage 会直接抛 SecurityError / QuotaExceededError：
 *   - Safari 无痕模式 / 部分跨域 iframe / 强隐私策略 / 存储配额已满
 * 一旦未捕获，整个 ES Module 主脚本会中断 → 游戏白屏。
 *
 * 因此本项目所有持久化操作统一走此封装：
 *   1. 读写异常时自动降级为内存对象（Memory Fallback）
 *   2. 无痕模式下全程可玩，只是关闭页面后进度不保留
 * ============================================================ */

const memoryFallback = new Map();

function getBackend() {
  try {
    return window.localStorage;
  } catch (e) {
    return null;
  }
}

export const storage = {
  getItem(key) {
    const ls = getBackend();
    if (ls) {
      try {
        return ls.getItem(key);
      } catch (e) { /* 降级到内存 */ }
    }
    return memoryFallback.has(key) ? memoryFallback.get(key) : null;
  },

  setItem(key, value) {
    const str = String(value);
    const ls = getBackend();
    if (ls) {
      try {
        ls.setItem(key, str);
        return true;
      } catch (e) { /* 配额满 / 隐私模式 → 降级 */ }
    }
    memoryFallback.set(key, str);
    return false;
  },

  removeItem(key) {
    const ls = getBackend();
    if (ls) {
      try {
        ls.removeItem(key);
      } catch (e) { /* 降级到内存 */ }
    }
    memoryFallback.delete(key);
  },

  /** JSON 便捷读：解析失败返回 fallback，绝不抛出 */
  getJSON(key, fallback = null) {
    try {
      const raw = this.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  },

  setJSON(key, value) {
    try {
      return this.setItem(key, JSON.stringify(value));
    } catch (e) {
      return false;
    }
  },
};
