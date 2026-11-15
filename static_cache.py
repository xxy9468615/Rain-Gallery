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


def content_etag(full_path, max_bytes=HASH_CONTENT_MAX_BYTES) -> str:
    """按文件内容生成强 ETag；超过 max_bytes 时退化为 mtime+size 版本。

    返回带双引号的强校验器（如 ``"a1b2…"``），可直接用于 If-None-Match 比较。
    同一内容必得同一 ETag；mtime 变化但内容不变时 ETag 保持不变（避免无谓重传）。
    """
    st = os.stat(full_path)
    if st.st_size <= max_bytes:
        h = hashlib.sha256()
        with open(full_path, "rb") as f:
            for chunk in iter(lambda: f.read(256 * 1024), b""):
                h.update(chunk)
        base = f"content-{st.st_size}-{h.hexdigest()}"
    else:
        base = f"meta-{st.st_mtime}-{st.st_size}"
    return '"' + hashlib.sha256(base.encode()).hexdigest()[:32] + '"'