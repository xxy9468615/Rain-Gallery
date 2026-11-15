# -*- coding: utf-8 -*-
"""============================================================
 静态资源的强校验码（ETag）生成
 ------------------------------------------------------------
 只依赖标准库，便于在「不装 fastapi/starlette」的 CI 静态 job 里
 做零依赖行为测试；框架接线（StaticFiles 子类）留在 app.py。

 为什么不直接用 Starlette 的 ETag：
   父类是 md5(st_mtime + "-" + st_size)，**不含文件内容**。同一秒内
   同样大小的两次改写会算出同一个 ETag，客户端拿到 304 继续用旧脚本
   ——「内容变了但校验码没变」正是缓存陈旧故障的根因。
============================================================"""
import hashlib
import os

#: 超过此大小不做内容哈希（避免把超大文件反复读进内存），
#: 退化为 mtime+size 版本。当前游戏素材（含 4.7 MB 开场视频）均小于它。
HASH_CONTENT_MAX_BYTES = 8 * 1024 * 1024

#: (路径, mtime_ns, ctime_ns, size, inode) → ETag 的结果缓存。
#: 浏览器带 Cache-Control: no-cache 时**每次页面加载都会回源校验**，
#: 若每次都重读 4.7 MB 视频算 SHA-256，代价过高；用 stat 指纹命中缓存。
#:
#: 指纹**不能只用 mtime+size**：部署工具（rsync -t / tar -p / 镜像层）
#: 会保留 mtime，恰好可能造成「内容变了、mtime 与大小都没变」。ctime 由
#: 内核在写入/改属性时更新且无法由用户态回拨，inode 可识别整文件替换，
#: 两者一起才能覆盖这种场景（CodeRabbit 抓到）。
_ETAG_CACHE = {}
_ETAG_CACHE_LIMIT = 512


def content_etag(full_path, max_bytes=HASH_CONTENT_MAX_BYTES) -> str:
    """按文件内容生成强 ETag；超过 max_bytes 时退化为 mtime+size 版本。

    返回带双引号的强校验器（如 ``"a1b2…"``），可直接用于 If-None-Match 比较。
    同一内容必得同一 ETag；mtime 变化但内容不变时 ETag 保持不变（避免无谓重传）。

    读取与哈希是**同步 I/O**：在 async 请求路径里调用时必须放进线程
    （``anyio.to_thread.run_sync``），否则会阻塞事件循环。
    命中 _ETAG_CACHE 时只做一次 os.stat，不再读文件。
    """
    st = os.stat(full_path)
    key = (
        os.path.abspath(full_path),
        st.st_mtime_ns,
        getattr(st, "st_ctime_ns", int(st.st_ctime * 1e9)),
        st.st_size,
        getattr(st, "st_ino", 0),
    )
    cached = _ETAG_CACHE.get(key)
    if cached is not None:
        return cached

    if st.st_size <= max_bytes:
        h = hashlib.sha256()
        with open(full_path, "rb") as f:
            for chunk in iter(lambda: f.read(256 * 1024), b""):
                h.update(chunk)
        base = f"content-{st.st_size}-{h.hexdigest()}"
    else:
        base = f"meta-{st.st_mtime}-{st.st_size}"
    etag = '"' + hashlib.sha256(base.encode()).hexdigest()[:32] + '"'

    # 简单的容量上限：条目只增不减会随部署次数缓慢增长（服务重启即清零）
    if len(_ETAG_CACHE) >= _ETAG_CACHE_LIMIT:
        _ETAG_CACHE.clear()
    _ETAG_CACHE[key] = etag
    return etag