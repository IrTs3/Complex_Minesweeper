#!/usr/bin/env python3
"""网页版访问闸门的鉴权服务（服务端）。

只监听回环（默认 127.0.0.1:8090），由 nginx 的 auth_request / proxy_pass 调用，
**不直接对公网暴露**。

五个端点
--------
  GET  /auth    给 nginx auth_request 用：204 = 放行，401 = 拒
  GET  /entry   秘密入口的「已登录」分支：302 → /game（未登录 401）
  POST /login   校验密码，成功则下发会话 cookie
  POST /logout  清 cookie
  GET  /health  存活与状态（仅回环可见）

依赖：仅 Python 3 标准库。

安全说明（重要）
----------------
**本服务自己不带 TLS**：它只监听回环（127.0.0.1:8090），对外一律由 nginx 终结
HTTPS（443），密码与会话 cookie 因此**过网是加密的**（cookie 带 Secure）。
本服务仍只能算"防误入 / 软隔离"，不是安全边界——真正的边界是 nginx 那层
（auth_request + 404 隐藏资源 + 限流）。详见 docs/密码闸门.md。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import signal
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# --------------------------------------------------------------------------
# 与 tools/gate_manager.py **必须逐字一致**的常量。改动要同时改两端并跑两边 selftest。
# --------------------------------------------------------------------------
STORE_VERSION = 1
KDF_NAME = "scrypt"
KDF_N, KDF_R, KDF_P, KDF_DKLEN, KDF_SALT_BYTES = 16384, 8, 1, 32, 16
KDF_MAXMEM = 64 * 1024 * 1024

VECTOR_SALT = bytes(range(16))
VECTOR_PW = "cmsgate-selftest"
# 用 hex 而不是 Base64 —— Base64 有 standard/urlsafe 两种变体，跨实现比对时容易踩坑
VECTOR_HASH_HEX = "965b82216c97b2fb0d69f7f5e680bb42c97250ce7dc6e60971975fff4b14e44e"

COOKIE_NAME = "cmsgate"
COOKIE_VERSION = 1
SIG_PREFIX = b"cmsgate.v1."
MAX_COOKIE = 512                        # 超过就当没有 cookie
MAX_BODY = 8 * 1024
MAX_PW_LEN = 256
DEFAULT_SESSION_TTL = 24 * 3600         # 会话 cookie 之上的绝对上限
USAGE_MAX_BYTES = 5 * 1024 * 1024       # 使用记录超过就轮转
GATE_OPEN_DEDUPE_S = 300                # 免密放行记录的去重窗口：同 ip+UA 只记一条

# 闸门全局配置（gateconfig.json）——与 tools/gate_manager.py 的 GATE_VERSION 必须一致
GATE_VERSION = 1
GATE_CONFIG_NAME = "gateconfig.json"
ISO_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
UA_MAX = 300                            # 使用记录里 UA 原文的截断长度

# 拒绝原因（写进使用记录，也回给密码页决定文案）
R_BAD_PW = "bad_password"
R_THROTTLED = "throttled"
R_DISABLED = "disabled"
R_EXPIRED = "expired"
# 闸门开放（免密）放行——只进 usage.jsonl，不是给密码页看的文案
R_GATE_OPEN = "gate_open"
# 原因 → 说给用户的话。**必须与 web/gate/gate.js 的 MSG 逐字一致**（T55 钉住），
# 否则同一个失败在「有 JS」和「无 JS」两条路上会显示成两句不一样的话。
REASON_ZH = {
    R_BAD_PW: "密码不正确，请重试",
    R_THROTTLED: "尝试过于频繁，请等一会儿再试",
    R_DISABLED: "这个密码已被停用，请找管理员换一个",
    R_EXPIRED: "这个密码已过期，请找管理员换一个",
}

# 无 JavaScript 的原生表单提交走这条：把提示写在**本响应体**里，不做任何跳转。
# 密码页挂在随机路径 /gate/<TOKEN>/ 上，authd 不知道也不该知道它（拼一个公开路径
# 302 过去等于把入口广播出去，老代码跳 /gate/?e=N 则会被 404 模型吃掉）。
# ★ 页面里不许有 <style>/style=/内联 <script>：继承的 CSP 是 style-src/script-src
#   'self'，写了只会被浏览器静默拦掉。裸 HTML 正是这条降级路径想要的样子。
NOJS_PAGE = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>复数扫雷 · 访问验证</title>
</head>
<body>
<h1>复数扫雷 · 访问验证</h1>
<p>{msg}</p>
<p>请用浏览器的前退（Back）回到登录页，重新输入密码。</p>
</body>
</html>
"""


def nojs_page(msg: str) -> bytes:
    """只接受 REASON_ZH 里的固定句子（或带整秒数的节流句），不回显任何请求内容。"""
    return NOJS_PAGE.format(msg=msg).encode("utf-8")


def reason_sentence(reason: str, retry: int) -> str:
    base = REASON_ZH.get(reason, REASON_ZH[R_BAD_PW])
    if reason == R_THROTTLED and retry > 0:
        return f"尝试过于频繁，请等 {retry} 秒后再试"
    return base

# 应用层节流（与 nginx 的 limit_req 互补：nginx 挡高频，这里挡低频慢速字典攻击）
# nginx 侧已经把登录卡到 10 r/m，所以这里不必太激进；阈值放宽一点，
# 免得正常用户手滑几次就被锁（被锁时会给 429，不是 401 —— 见 _handle_login）
THROTTLE_SOFT = 8                       # 连败到此开始短期锁定
THROTTLE_HARD = 20                      # 连败到此开始长期锁定
THROTTLE_SOFT_LOCK = 60
THROTTLE_HARD_LOCK = 900
THROTTLE_FAIL_SLEEP = 0.5


def now_ts() -> int:
    return int(time.time())


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64u_decode(text: str) -> bytes:
    pad = "=" * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def die(msg: str, code: int = 1):
    print(f"authd: 致命错误：{msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def log(msg: str) -> None:
    print(f"authd: {msg}", file=sys.stderr, flush=True)


# --------------------------------------------------------------------------
# 密码表（按 mtime 热重载）
# --------------------------------------------------------------------------
class Store:
    """passwords.json 的只读视图。文件被原子替换后，下一次请求自动加载新表。"""

    def __init__(self, state: Path):
        self.path = state / "passwords.json"
        self._lock = threading.Lock()
        self._mtime = None
        self._gen = 0
        self._entries: dict[str, dict] = {}
        self._last_error = ""
        self.reload(force=True)

    def reload(self, *, force: bool = False) -> bool:
        """返回 True 表示本次真的重新加载了。"""
        with self._lock:
            try:
                st = self.path.stat()
            except OSError as e:
                if force or self._mtime is not None:
                    self._set_empty(f"读不到密码表：{e}")
                return False
            if not force and self._mtime == st.st_mtime_ns:
                return False
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                gen, entries = self._validate(data)
            except Exception as e:                      # 解析失败 → 拒绝（fail closed）
                self._set_empty(f"密码表不可用：{e}")
                return False
            self._mtime = st.st_mtime_ns
            self._gen = gen
            self._entries = entries
            self._last_error = ""
            log(f"已加载密码表：gen={gen} 条目={len(entries)}")
            return True

    def _set_empty(self, why: str) -> None:
        if self._last_error != why:
            log(f"警告：{why}（按「无有效密码」处理，所有人都会看到密码页）")
        self._last_error = why
        self._gen = 0
        self._entries = {}

    def _validate(self, data) -> tuple[int, dict[str, dict]]:
        if not isinstance(data, dict):
            raise ValueError("顶层不是对象")
        if data.get("version") != STORE_VERSION:
            raise ValueError(f"version={data.get('version')!r} 不支持")
        gen = data.get("gen")
        if not isinstance(gen, int) or gen < 0:
            raise ValueError("gen 非法")
        params = data.get("params")
        if not isinstance(params, dict) or params.get("kdf") != KDF_NAME:
            raise ValueError("params.kdf 非法")
        for k, want in (("n", KDF_N), ("r", KDF_R), ("p", KDF_P),
                        ("dklen", KDF_DKLEN), ("salt_bytes", KDF_SALT_BYTES)):
            if params.get(k) != want:
                raise ValueError(f"params.{k}={params.get(k)!r} 与本服务不符（期望 {want}）")
        raw = data.get("entries")
        if not isinstance(raw, list):
            raise ValueError("entries 不是数组")
        out: dict[str, dict] = {}
        for e in raw:
            if not isinstance(e, dict):
                raise ValueError("条目不是对象")
            eid = e.get("id")
            if not isinstance(eid, str) or not eid or len(eid) > 32:
                raise ValueError("条目 id 非法")
            if eid in out:
                raise ValueError(f"条目 id 重复：{eid}")
            salt = b64u_decode(e["salt"]) if isinstance(e.get("salt"), str) else None
            h = b64u_decode(e["hash"]) if isinstance(e.get("hash"), str) else None
            if salt is None or len(salt) != KDF_SALT_BYTES:
                raise ValueError(f"条目 {eid} 的 salt 长度错误")
            if h is None or len(h) != KDF_DKLEN:
                raise ValueError(f"条目 {eid} 的 hash 长度错误")
            rev = e.get("rev", 1)
            if not isinstance(rev, int):
                raise ValueError(f"条目 {eid} 的 rev 非法")
            enabled = e.get("enabled", True)
            if not isinstance(enabled, bool):
                raise ValueError(f"条目 {eid} 的 enabled 不是布尔值")
            exp_raw = e.get("expires_at")
            expires_ts = 0
            if exp_raw is not None:
                if not isinstance(exp_raw, str) or not ISO_Z_RE.match(exp_raw):
                    raise ValueError(f"条目 {eid} 的 expires_at 不是 ISO UTC 串")
                expires_ts = int(datetime.strptime(exp_raw, "%Y-%m-%dT%H:%M:%SZ")
                                 .replace(tzinfo=timezone.utc).timestamp())
            out[eid] = {"salt": salt, "hash": h, "rev": rev,
                        "label": str(e.get("label", ""))[:64],
                        "enabled": enabled, "expires_ts": expires_ts,
                        "expires_at": exp_raw or ""}
        return gen, out

    def snapshot(self) -> tuple[int, dict[str, dict]]:
        with self._lock:
            return self._gen, dict(self._entries)

    @property
    def last_error(self) -> str:
        return self._last_error

    def count(self) -> int:
        with self._lock:
            return len(self._entries)


# --------------------------------------------------------------------------
# 闸门全局配置（gateconfig.json，按 mtime 热重载）
# --------------------------------------------------------------------------
class GateConfig:
    """总开关 `require_password` + 管理口令哈希。

    **缺文件 / 解析失败 → 一律按「需要密码」处理（fail closed）**：
    宁可多要一次密码，也不能因为读不到配置就把整站敞开。
    """

    def __init__(self, state: Path):
        self.path = state / GATE_CONFIG_NAME
        self._lock = threading.Lock()
        self._mtime = None
        self._require = True
        self._admin: dict | None = None
        self._updated_at = ""
        self._last_error = ""
        self.reload(force=True)

    def reload(self, *, force: bool = False) -> bool:
        with self._lock:
            try:
                st = self.path.stat()
            except OSError:
                first = self._mtime is None and not force
                self._reset("配置文件不存在")
                if first:
                    log(f"闸门配置：{self.path} 不存在，按「需要密码」处理")
                return False
            if not force and self._mtime == st.st_mtime_ns:
                return False
            try:
                data = json.loads(self.path.read_text(encoding="utf-8"))
                require, admin, updated = self._validate(data)
            except Exception as e:
                self._reset(f"闸门配置不可用：{e}")
                self._mtime = st.st_mtime_ns          # 别每个请求都重读 + 重报
                log(f"警告：{self._last_error}（按「需要密码」处理）")
                return False
            self._mtime = st.st_mtime_ns
            self._require, self._admin, self._updated_at = require, admin, updated
            self._last_error = ""
            log(f"已加载闸门配置：需要密码={require} "
                f"管理口令={'已设置' if admin else '未设置'}")
            return True

    def _reset(self, why: str) -> None:
        self._require, self._admin, self._updated_at = True, None, ""
        self._last_error = why

    @staticmethod
    def _validate(data) -> tuple[bool, dict | None, str]:
        if not isinstance(data, dict):
            raise ValueError("顶层不是对象")
        if data.get("version") != GATE_VERSION:
            raise ValueError(f"version={data.get('version')!r} 不支持")
        require = data.get("require_password")
        if not isinstance(require, bool):
            raise ValueError("require_password 不是布尔值")
        updated = data.get("updated_at", "")
        if not isinstance(updated, str) or (updated and not ISO_Z_RE.match(updated)):
            raise ValueError("updated_at 不是 ISO UTC 串")
        raw = data.get("admin")
        admin = None
        if raw is not None:
            if not isinstance(raw, dict):
                raise ValueError("admin 不是对象")
            if raw.get("kdf") != KDF_NAME:
                raise ValueError("admin.kdf 非法")
            for k, want in (("n", KDF_N), ("r", KDF_R), ("p", KDF_P),
                            ("dklen", KDF_DKLEN), ("salt_bytes", KDF_SALT_BYTES)):
                if raw.get(k) != want:
                    raise ValueError(f"admin.{k}={raw.get(k)!r} 与本服务不符（期望 {want}）")
            try:
                salt = b64u_decode(raw["salt"]) if isinstance(raw.get("salt"), str) else None
                h = b64u_decode(raw["hash"]) if isinstance(raw.get("hash"), str) else None
            except Exception:
                raise ValueError("admin 的 salt/hash 不是合法 Base64")
            if salt is None or len(salt) != KDF_SALT_BYTES:
                raise ValueError("admin.salt 长度错误")
            if h is None or len(h) != KDF_DKLEN:
                raise ValueError("admin.hash 长度错误")
            admin = {"salt": salt, "hash": h}
        return require, admin, updated

    def snapshot(self) -> tuple[bool, dict | None, str]:
        with self._lock:
            return self._require, self._admin, self._updated_at

    def require_password(self) -> bool:
        with self._lock:
            return self._require

    @property
    def last_error(self) -> str:
        return self._last_error


# --------------------------------------------------------------------------
# 会话 cookie
# --------------------------------------------------------------------------
class Sessions:
    def __init__(self, state: Path, ttl: int):
        self.ttl = ttl
        self.key = self._load_key(state)
        # IP 假名化用的子密钥：对外分享日志时只给 ip_hash。
        # 本机 usage.jsonl 仍并存明文 ip（管理员排障需要看 IP，见 docs/密码闸门.md「访问日志与隐私」）。
        self.ip_key = hmac.new(self.key, b"cmsgate.ipkey.v1", hashlib.sha256).digest()
        # 登出后的会话签名 → 该签名原本的到期时间。服务端无状态签名意味着
        # 只清浏览器 cookie 的话，被复制走的那份仍然有效到 24h 后——登出必须
        # 在服务端也作废它。只存签名（不存 payload），到期自动清。
        # 表落盘到 state 目录（0600）：重启后这些登出依然作废，不给
        # 「被复制走的 cookie 等一次重启就复活」留窗口。
        self._rev_path = state / "revoked.json"
        self._revoked: dict[str, int] = self._load_revoked(state)
        self._rev_lock = threading.Lock()

    @staticmethod
    def _load_key(state: Path) -> bytes:
        p = state / "secret.key"
        try:
            raw = p.read_bytes()
            if len(raw) >= 32:
                return raw
        except OSError:
            pass
        raw = secrets.token_bytes(32)
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "wb") as f:
            f.write(raw)
        log(f"已生成新的签名密钥：{p}（旧会话全部失效）")
        return raw

    def _load_revoked(self, state: Path) -> dict[str, int]:
        """启动时恢复吊销表；文件缺失/损坏都当成空表（只影响历史登出，不影响新登出）。"""
        try:
            data = json.loads((state / "revoked.json").read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(data, dict):
            return {}
        t = now_ts()
        return {str(k): v for k, v in data.items()
                if isinstance(k, str) and isinstance(v, int) and v >= t}

    def _persist_revoked(self) -> None:
        # 临时文件 + os.replace 原子换入；写失败只记日志——内存表仍在，
        # 本次登出依旧生效，只是重启后回到「无落盘」的旧窗口。
        try:
            tmp = self._rev_path.with_suffix(".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self._revoked, f)
            os.replace(tmp, self._rev_path)
        except OSError as e:
            log(f"吊销表落盘失败（重启后未落盘的登出会失效）：{e}")

    def _sign(self, payload_b64: str) -> str:
        mac = hmac.new(self.key, SIG_PREFIX + payload_b64.encode("ascii"), hashlib.sha256).digest()
        return b64u_encode(mac)

    def issue(self, pwid: str, rev: int, gen: int) -> str:
        iat = now_ts()
        payload = {"v": COOKIE_VERSION, "pwid": pwid, "rev": rev, "gen": gen,
                   "iat": iat, "exp": iat + self.ttl}
        p = b64u_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode())
        return f"{p}.{self._sign(p)}"

    def verify(self, cookie: str, store: Store) -> str | None:
        """返回命中的 pwid，或 None。"""
        if not cookie or len(cookie) > MAX_COOKIE or cookie.count(".") != 1:
            return None
        p, sig = cookie.split(".", 1)
        # _sign 里是 .encode("ascii")：非 ASCII 的 cookie 会在 try 之外抛
        # UnicodeEncodeError，把整个请求变成 500（正常应是 401）。
        if not p.isascii() or not sig.isascii():
            return None
        if not hmac.compare_digest(sig, self._sign(p)):     # 常量时间
            return None
        with self._rev_lock:
            if sig in self._revoked:                        # 已登出
                return None
        try:
            payload = json.loads(b64u_decode(p))
        except Exception:
            return None
        if not isinstance(payload, dict) or payload.get("v") != COOKIE_VERSION:
            return None
        exp, iat = payload.get("exp"), payload.get("iat")
        if not isinstance(exp, int) or not isinstance(iat, int):
            return None
        t = now_ts()
        if exp < t or iat > t + 300:                        # 过期 / 签发时间离谱
            return None
        pwid = payload.get("pwid")
        if not isinstance(pwid, str):
            return None
        gen, entries = store.snapshot()
        if payload.get("gen") != gen:                       # revoke-all 已生效
            return None
        e = entries.get(pwid)
        if e is None:                                       # 该密码已被删除
            return None
        if not e["enabled"]:                                # 该密码已被禁用
            return None                                     # → 已登录的会话立刻失效
        if e["expires_ts"] and e["expires_ts"] < t:         # 该密码已过期
            return None
        if payload.get("rev") != e["rev"]:                  # 该密码已被轮换
            return None
        return pwid

    def revoke(self, cookie: str) -> None:
        """登出：把这份 cookie 的签名记进吊销表（到它原本的 exp 为止）。"""
        if not cookie or len(cookie) > MAX_COOKIE or cookie.count(".") != 1:
            return
        p, sig = cookie.split(".", 1)
        if not p.isascii() or not sig.isascii():
            return
        if not hmac.compare_digest(sig, self._sign(p)):
            return  # 不是我们签的，不给攻击者往表里塞垃圾的机会
        try:
            payload = json.loads(b64u_decode(p))
        except Exception:
            return
        exp = payload.get("exp") if isinstance(payload, dict) else None
        t = now_ts()
        if not isinstance(exp, int) or exp < t:
            exp = t + self.ttl
        with self._rev_lock:
            for k in [k for k, v in self._revoked.items() if v < t]:
                self._revoked.pop(k, None)
            self._revoked[sig] = min(exp, t + self.ttl)
            self._persist_revoked()

    def ip_hash(self, ip: str) -> str:
        return hmac.new(self.ip_key, ip.encode("utf-8"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------
# 应用层防爆破
# --------------------------------------------------------------------------
class Throttle:
    def __init__(self):
        self._lock = threading.Lock()
        self._state: dict[str, dict] = {}
        self._last_sweep = now_ts()

    def check(self, ip: str) -> int:
        """返回还需等待的秒数（0 = 放行）。"""
        with self._lock:
            s = self._state.get(ip)
            if not s:
                return 0
            left = s.get("locked_until", 0) - now_ts()
            return max(0, left)

    def fail(self, ip: str) -> float:
        """记一次失败，返回本次应 sleep 的秒数。"""
        with self._lock:
            s = self._state.setdefault(ip, {"fails": 0, "locked_until": 0})
            s["fails"] += 1
            n = s["fails"]
            if n >= THROTTLE_HARD:
                s["locked_until"] = now_ts() + THROTTLE_HARD_LOCK
            elif n >= THROTTLE_SOFT:
                s["locked_until"] = now_ts() + THROTTLE_SOFT_LOCK
            return min(THROTTLE_FAIL_SLEEP + 0.25 * (n - 1), 2.0)

    def ok(self, ip: str) -> None:
        with self._lock:
            self._state.pop(ip, None)

    def maybe_sweep(self) -> None:
        """每隔一段时间清一次；sweep 本身不能只写在文件里没人调。"""
        with self._lock:
            t = now_ts()
            if t - self._last_sweep < 300:
                return
            self._last_sweep = t
            cut = t - 3600
            # fails<8 的条目 locked_until 恒为 0，本就立即清；
            # fails>=8 的条目 locked_until 在每次失败都刷新，等价于「最近活动时间」
            # —— 旧谓词把这类条目排除在外，导致永不清理、内存只增不减。
            # 活跃锁（locked_until 在未来）不受影响：60s/900s 远小于 1h 的 cut。
            for ip in [k for k, v in self._state.items()
                       if v.get("locked_until", 0) < cut]:
                self._state.pop(ip, None)


# --------------------------------------------------------------------------
# 使用记录
# --------------------------------------------------------------------------
# UA 解析：纯正则、零依赖。**顺序即优先级**——微信/Edge 的 UA 里同时带着
# Chrome 与 Safari 的标记，先判外壳再判内核，否则全都认成 Chrome。
# 识别不出来就老实回 "-"，不瞎猜。
UA_BROWSERS = (
    ("WeChat", r"MicroMessenger/(\d+[\d.]*)"),
    ("Edge", r"Edg(?:e|A|iOS)?/(\d+[\d.]*)"),
    ("Opera", r"(?:OPR|Opera)[/ ](\d+[\d.]*)"),
    ("Samsung Internet", r"SamsungBrowser/(\d+[\d.]*)"),
    ("Firefox", r"(?:Firefox|FxiOS)/(\d+[\d.]*)"),
    ("Chrome", r"(?:Chrome|CriOS)/(\d+[\d.]*)"),
    ("Safari", r"Version/(\d+[\d.]*)[^)]*Safari/"),
    ("curl", r"curl/(\d+[\d.]*)"),
    ("wget", r"[Ww]get/(\d+[\d.]*)"),
    ("python-requests", r"python-requests/(\d+[\d.]*)"),
    ("okhttp", r"okhttp/(\d+[\d.]*)"),
    ("Go-http-client", r"Go-http-client/(\d+[\d.]*)"),
)


def _win_name(nt: str) -> str:
    # Windows 11 在 UA 里也报 NT 10.0，无法区分，所以写「10/11」
    return {"10.0": "Windows 10/11", "6.3": "Windows 8.1", "6.2": "Windows 8",
            "6.1": "Windows 7", "6.0": "Windows Vista"}.get(nt, f"Windows NT {nt}")


def pick_pw_entry(entries: dict[str, dict], pw: str) -> tuple[str | None, dict | None]:
    """拿明文密码在整表里选条目，返回 (id, entry) 或 (None, None)。

    没有匹配也把**整表**走完、被停用/过期的条目**同样要算 scrypt**——
    否则会从耗时上泄漏"这条密码存在"。同一密码可能有多个条目（比如一条
    被停用、一条还启用着）：优先挑「启用且未过期」的命中，别让字典序
    靠前的停用条目把人挡在门外；全部命中都不可用才回落第一个命中，
    让调用方报出准确的停用/过期原因。
    """
    hit_id, hit = None, None
    ok_id, ok_hit = None, None
    for eid, e in entries.items():
        try:
            d = hashlib.scrypt(pw.encode("utf-8"), salt=e["salt"], n=KDF_N, r=KDF_R,
                               p=KDF_P, dklen=KDF_DKLEN, maxmem=KDF_MAXMEM)
        except Exception:
            continue
        if hmac.compare_digest(d, e["hash"]):
            if hit is None:
                hit_id, hit = eid, e
            if ok_hit is None and e["enabled"] and (e["expires_ts"] == 0
                                                    or e["expires_ts"] >= now_ts()):
                ok_id, ok_hit = eid, e
    if ok_hit is not None:
        return ok_id, ok_hit
    return hit_id, hit


def parse_ua(ua: str) -> dict[str, str]:
    """把 User-Agent 拆成 家族 / 浏览器+版本 / 系统+版本 / 设备型号。

    启发式，不是权威解析——够管理员回答「这个密码都是什么人在用」就行。
    已知局限：iPadOS 13+ 的 Safari 自称 Macintosh，会被认成 Mac；Chromium 系
    内核版本与外壳版本可能不一致（这里报的是外壳版本）。
    """
    u = (ua or "").strip()
    out = {"family": "-", "browser": "-", "os": "-", "device": "-"}
    if not u:
        return out

    for name, pat in UA_BROWSERS:
        m = re.search(pat, u)
        if m:
            out["family"] = name
            out["browser"] = f"{name} {m.group(1)}"
            break

    m = re.search(r"Windows NT (\d+\.\d+)", u)
    if m:
        out["os"] = _win_name(m.group(1))
    elif (m := re.search(r"(?:iPhone|iPad|iPod).*?OS (\d+[_\d]*)", u)):
        out["os"] = "iOS " + m.group(1).replace("_", ".")
    elif (m := re.search(r"Mac OS X (\d+[_\d]*)", u)):
        out["os"] = "macOS " + m.group(1).replace("_", ".")
    elif (m := re.search(r"Android (\d+(?:\.\d+)*)", u)):
        out["os"] = "Android " + m.group(1)
    elif "CrOS" in u:
        out["os"] = "ChromeOS"
    elif "Linux" in u:
        out["os"] = "Linux"

    if re.search(r"\biPhone\b", u):
        out["device"] = "iPhone"
    elif re.search(r"\biPad\b", u):
        out["device"] = "iPad"
    elif "Android" in u:
        m = re.search(r"Android[^;)]*;\s*([^;)]+?)(?:\s+Build[/)]|\))", u)
        model = (m.group(1).strip() if m else "").replace(";", "")
        # 常见机型码（如 SM-G991B / Pixel 7）保留，泛称（如 "K"）不保留
        out["device"] = f"Android {model}" if len(model) > 2 else "Android"
    elif "Macintosh" in u or "Mac OS X" in u:
        out["device"] = "Mac"
    elif "Windows" in u:
        out["device"] = "Windows PC"
    elif "Linux" in u:
        out["device"] = "Linux PC"
    return out


def ua_family(ua: str) -> str:
    return parse_ua(ua)["family"]


class UsageLog:
    def __init__(self, state: Path, ip_key_hasher):
        self.path = state / "usage.jsonl"
        self._lock = threading.Lock()
        self._ip_hash = ip_key_hasher
        self._pass_seen: dict[tuple[str, str], float] = {}  # (ip_hash, UA) → 上次登记时刻

    def append(self, *, ok: bool, pwid: str | None, label: str, ip: str, ua: str,
               reason: str = "") -> None:
        parsed = parse_ua(ua)
        rec = {
            "ts": now_iso(), "event": "login", "ok": bool(ok),
            "pwid": pwid, "label": label, "reason": reason,
            # 明文 IP：管理员要能回答「这条密码是谁在用、从哪来的」。
            # ip_hash 一并保留——旧记录只有它，且分享日志时可以只给哈希。
            "ip": ip,
            "ip_hash": self._ip_hash(ip)[:32],
            "ua": ua[:UA_MAX],
            "ua_family": parsed["family"],
            "browser": parsed["browser"],
            "os": parsed["os"],
            "device": parsed["device"],
        }
        line = json.dumps(rec, ensure_ascii=False) + "\n"
        with self._lock:
            try:
                if self.path.exists() and self.path.stat().st_size > USAGE_MAX_BYTES:
                    self.path.replace(self.path.with_name("usage.jsonl.1"))
                fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError as e:
                log(f"写使用记录失败（不影响登录）：{e}")

    def append_gate_open(self, *, ip: str, ua: str) -> None:
        """闸门开放（require_password=false）时的放行也登记一条。

        为什么要去重：nginx auth_request 对页面和**每个资源**都打一次 /auth，
        一个访客能刷出几十条同质记录。按 (ip_hash, UA) 在窗口内只记一条；
        窗口内的重复请求跳过。宁可少记也不做「一个字都不记」——关闸后访问
        完全无记录，是 2026-10-29 用户点名要补的洞。
        """
        now = time.time()
        key = (self._ip_hash(ip)[:32], ua[:UA_MAX])
        with self._lock:
            seen = self._pass_seen
            if len(seen) > 4096:            # 太大才清一次，避免每请求全表扫描
                cutoff = now - GATE_OPEN_DEDUPE_S
                for k in [k for k, t in seen.items() if t < cutoff]:
                    del seen[k]
            last = seen.get(key)
            if last is not None and now - last < GATE_OPEN_DEDUPE_S:
                return
            seen[key] = now
        self.append(ok=True, pwid=None, label="", reason=R_GATE_OPEN, ip=ip, ua=ua)


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------
class AuthError(Exception):
    pass


class Handler(BaseHTTPRequestHandler):
    server_version = "authd"        # 不回显 Python 版本（nginx 侧还会再 hide 一次）
    sys_version = ""
    protocol_version = "HTTP/1.1"

    # —— 由 make_server() 注入 ——
    store: Store
    sessions: Sessions
    throttle: Throttle
    usage: UsageLog

    def log_message(self, fmt, *args):          # 默认会打到 stderr，太吵；只记异常
        pass

    # ---- 工具 ----
    def _client_ip(self) -> str:
        real = self.headers.get("X-Real-IP")
        if real:
            return real.strip()[:64]
        return (self.client_address[0] if self.client_address else "?")[:64]

    def _secure_suffix(self) -> str:
        """浏览器在 https 上才肯带 Secure 的 cookie —— 但这里**条件**加，不是无条件。

        无条件加会当场打死所有明文通路：nginx 还在 127.0.0.1 上留了一个端口给自己人用，
        本地开发也是 http，浏览器不会在非 https 主机上存 Secure cookie，
        表现是「密码明明对却登不进去」，而且只有那几个入口会坏，最难查。
        判据用 X-Forwarded-Proto：它由 nginx 的 proxy_set_header **覆盖写入**
        （不是追加），客户端自己带的同名头进不来；本服务只监听回环，除了 nginx 没人能直连。
        """
        proto = (self.headers.get("X-Forwarded-Proto") or "").split(",")[0].strip().lower()
        return "; Secure" if proto == "https" else ""

    def _send(self, code: int, body: bytes = b"", *, ctype: str | None = None,
              cookie: str | None = None, location: str | None = None,
              extra: list[tuple[str, str]] | None = None) -> None:
        self.send_response(code)
        if ctype:
            self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if cookie is not None:
            self.send_header("Set-Cookie", cookie)
        if location:
            self.send_header("Location", location)
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                # 客户端提前断开（例如用户点了别处 / 页面被导航走了）。
                # 这是正常现象，不该在 journal 里刷一坨堆栈。
                log("客户端在读回复前断开（正常，忽略）")

    def _read_body(self) -> bytes:
        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            raise AuthError("Content-Length 非法")
        if n < 0 or n > MAX_BODY:
            raise AuthError("请求体过大")
        return self.rfile.read(n) if n else b""

    def _cookie_value(self) -> str:
        raw = self.headers.get("Cookie") or ""
        if len(raw) > 4096:                     # 超大 Cookie 直接忽略
            return ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(COOKIE_NAME + "="):
                return part[len(COOKIE_NAME) + 1:]
        return ""

    # ---- 路由 ----
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/auth":
            return self._handle_auth()
        if path == "/entry":
            return self._handle_entry()
        if path == "/health":
            return self._handle_health()
        if path in ("/login", "/logout"):
            # 这两个端点只收 POST；显式 405 而不是 404，便于排错
            self.send_response(405)
            self.send_header("Allow", "POST")
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return
        return self._send(404, b'{"ok":false}')

    def do_HEAD(self):
        return self.do_GET()

    def do_POST(self):
        path = urllib.parse.urlsplit(self.path).path
        if path == "/login":
            return self._handle_login()
        if path == "/logout":
            return self._handle_logout()
        return self._send(405, b'{"ok":false}')

    def do_PUT(self):
        return self._send(405, b'{"ok":false}')

    do_DELETE = do_PATCH = do_PUT

    # ---- 各端点 ----
    def _handle_auth(self):
        self.config.reload()
        if not self.config.require_password():
            # 总闸门已关：所有人放行，不再看 cookie —— 但放行本身要登记
            self.usage.append_gate_open(ip=self._client_ip(),
                                        ua=self.headers.get("User-Agent", ""))
            return self._send(204)
        self.store.reload()
        pwid = self.sessions.verify(self._cookie_value(), self.store)
        if pwid:
            return self._send(204)
        return self._send(401)

    def _handle_entry(self):
        """秘密登录入口的「已登录」分支：302 → /game。

        nginx 在同一 location 上先跑 auth_request，未登录的请求被 error_page
        送去公开的密码页，根本到不了这里；能到就说明会话有效。这里仍复查一次，
        是为了 nginx 配置万一被改松时最坏也只回 401，而不是把人直接放进游戏。
        """
        self.config.reload()
        if not self.config.require_password():
            return self._send(302, location="/game")
        self.store.reload()
        if self.sessions.verify(self._cookie_value(), self.store):
            return self._send(302, location="/game")
        return self._send(401)

    def _handle_health(self):
        self.store.reload()
        self.config.reload()
        require, admin, updated = self.config.snapshot()
        gen, entries = self.store.snapshot()
        t = now_ts()
        disabled = sum(1 for e in entries.values() if not e["enabled"])
        expired = sum(1 for e in entries.values()
                      if e["enabled"] and e["expires_ts"] and e["expires_ts"] < t)
        body = json.dumps({"ok": True, "gen": gen, "entries": len(entries),
                           "require_password": require,
                           "admin_set": admin is not None,
                           "gate_updated_at": updated,
                           "disabled": disabled, "expired": expired}).encode()
        return self._send(200, body, ctype="application/json")

    def _handle_logout(self):
        # 只清浏览器 cookie 不够：cookie 被复制走（或浏览器「恢复标签页」）时，
        # 那份签名仍然有效到 24h 后。登出必须同时在服务端吊销这份会话。
        self.sessions.revoke(self._cookie_value())
        # 清 cookie 的属性必须与下发时**完全一致**（含按 scheme 决定的 Secure），
        # 否则在另一种 scheme 下发的那份删不掉，留下一个「已登出但浏览器还存着会话」的尾巴。
        clear = f"{COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax{self._secure_suffix()}; Max-Age=0"
        return self._send(204, cookie=clear)

    def _handle_login(self):
        is_fetch = (self.headers.get("X-CMSGATE") or "") == "1"
        ip = self._client_ip()
        ua = self.headers.get("User-Agent", "")

        def deny(reason: str, retry: int = 0):
            """按原因分别响应。

            节流必须是 429 而非 401：否则用户输对密码却看到「密码不正确」，
            会以为自己记错了（这个坑踩过一次）。禁用/过期也同样要能与
            「密码错」区分开，否则用户会一直重试一个永远不会通过的密码。
            """
            extra = [("Retry-After", str(min(max(retry, 1), 900)))] if retry else None
            if is_fetch:
                body = json.dumps({"ok": False, "reason": reason}).encode()
                return self._send(429 if retry else 401, body,
                                  ctype="application/json", extra=extra)
            # 无 JS 的原生表单提交：直接把话写在这一响应的正文里。
            return self._send(429 if retry else 401,
                              nojs_page(reason_sentence(reason, retry)),
                              ctype="text/html; charset=utf-8", extra=extra)

        try:
            body = self._read_body()
        except AuthError:
            return self._send(413, b'{"ok":false}')

        self.throttle.maybe_sweep()
        # 锁定期：不花任何计算时间，直接拒。
        wait = self.throttle.check(ip)
        if wait > 0:
            log(f"登录被节流：ip_hash={self.sessions.ip_hash(ip)[:8]} 还需 {wait}s")
            self.usage.append(ok=False, pwid=None, label="", reason=R_THROTTLED,
                              ip=ip, ua=ua)
            return deny(R_THROTTLED, retry=wait)

        try:
            form = urllib.parse.parse_qs(body.decode("utf-8", "strict"), strict_parsing=False,
                                         max_num_fields=8)
        except Exception:
            self.usage.append(ok=False, pwid=None, label="", reason=R_BAD_PW, ip=ip, ua=ua)
            time.sleep(self.throttle.fail(ip))
            return deny(R_BAD_PW)
        pw = (form.get("pw") or [""])[0]
        if not isinstance(pw, str) or not (1 <= len(pw) <= MAX_PW_LEN):
            self.usage.append(ok=False, pwid=None, label="", reason=R_BAD_PW, ip=ip, ua=ua)
            time.sleep(self.throttle.fail(ip))
            return deny(R_BAD_PW)

        self.store.reload()
        gen, entries = self.store.snapshot()

        # 选条目（整表 scrypt + 优先可用条目，见 pick_pw_entry 的注释）
        hit_id, hit = pick_pw_entry(entries, pw)

        reason = ""
        if hit is not None:
            if not hit["enabled"]:
                reason = R_DISABLED
            elif hit["expires_ts"] and hit["expires_ts"] < now_ts():
                reason = R_EXPIRED

        if hit is None or reason:
            self.usage.append(ok=False, pwid=hit_id, label=(hit["label"] if hit else ""),
                              reason=(reason or R_BAD_PW), ip=ip, ua=ua)
            time.sleep(self.throttle.fail(ip))
            log(f"登录失败（{reason or R_BAD_PW}）：id={hit_id or '-'} "
                f"ip={ip} ip_hash={self.sessions.ip_hash(ip)[:8]}")
            return deny(reason or R_BAD_PW)

        self.throttle.ok(ip)
        # Secure 按 scheme 条件加（判据见 _secure_suffix），且**下发与清除用同一条**：
        # 浏览器只允许 secure 请求覆盖/删除一个 Secure cookie，属性对不上就是白登出；
        # 反过来在明文请求里发 Secure 会被整条丢弃，隧道那边的登出会静默失效。
        cookie = (f"{COOKIE_NAME}={self.sessions.issue(hit_id, hit['rev'], gen)}; "
                  f"Path=/; HttpOnly; SameSite=Lax{self._secure_suffix()}")  # 不设 Max-Age → 会话 cookie
        self.usage.append(ok=True, pwid=hit_id, label=hit.get("label", ""),
                          reason="", ip=ip, ua=ua)
        log(f"登录成功：id={hit_id} ip={ip} ip_hash={self.sessions.ip_hash(ip)[:8]}")
        if is_fetch:
            return self._send(204, cookie=cookie)
        # 无 JS 的表单提交走这条 303。落点必须是 /game 而非 /：
        # 学习站模式下 / 会 302 去 /learn/，刚登录的人会被弹去学习站。
        return self._send(303, cookie=cookie, location="/game")


# --------------------------------------------------------------------------
def make_server(listen: str, state: Path, ttl: int) -> ThreadingHTTPServer:
    host, _, port = listen.rpartition(":")
    if not host or not port.isdigit():
        die(f"--listen 格式应为 host:port，收到 {listen!r}")
    if host not in ("127.0.0.1", "localhost", "::1"):
        die(f"拒绝监听非回环地址 {host!r}——本服务只能被 nginx 从本机调用")

    state.mkdir(parents=True, exist_ok=True)
    os.chmod(state, 0o700)

    store = Store(state)
    if store.last_error:
        log(f"注意：{store.last_error}")

    Handler.store = store
    Handler.config = GateConfig(state)
    if Handler.config.last_error:
        log(f"注意：{Handler.config.last_error}")
    Handler.sessions = Sessions(state, ttl)
    Handler.throttle = Throttle()
    Handler.usage = UsageLog(state, Handler.sessions.ip_hash)

    srv = ThreadingHTTPServer((host, int(port)), Handler)
    srv.daemon_threads = True
    srv.store = store
    require, admin, _ = Handler.config.snapshot()
    log(f"已启动：{host}:{port}  数据目录={state}  会话上限={ttl}s  "
        f"有效密码 {store.count()} 条  需要密码={require}  "
        f"管理口令={'已设置' if admin else '未设置'}")
    return srv


def run_selftest(state: Path) -> None:
    ok = True

    def chk(cond: bool, what: str) -> None:
        nonlocal ok
        print(("  ✓ " if cond else "  ✗ ") + what)
        ok = ok and cond

    print("密码派生（跨端向量）")
    d = hashlib.scrypt(VECTOR_PW.encode(), salt=VECTOR_SALT, n=KDF_N, r=KDF_R, p=KDF_P,
                       dklen=KDF_DKLEN, maxmem=KDF_MAXMEM)
    chk(d.hex() == VECTOR_HASH_HEX, "scrypt 结果与 gate_manager.py 的向量一致")

    print("salt/hash 编码（与工具一致：urlsafe base64 无填充）")
    for raw in (bytes(range(16)), bytes([0xfb, 0xef, 0xbe]), b"\x00\xff\xfe\xfd" * 8):
        enc = b64u_encode(raw)
        chk("+" not in enc and "/" not in enc and "=" not in enc,
            f"编码不含 + / = ：{enc[:24]}")
        chk(b64u_decode(enc) == raw, f"往返一致（{len(raw)} 字节）")
    chk(b64u_decode(b64u_encode(b"a")) == b"a", "长度非 3 倍数也可往返")

    print("会话签名")
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        os.chmod(st, 0o700)
        sess = Sessions(st, 3600)
        store = Store(st)
        c = sess.issue("abc123", 1, 0)
        chk(sess.issue("abc123", 1, 0) != c or True, "cookie 可签发")
        parts = c.split(".")
        chk(len(parts) == 2, "cookie 形如 payload.sig")
        tampered = parts[0] + "." + parts[1][:-1] + ("A" if parts[1][-1] != "A" else "B")
        chk(sess.verify(tampered, store) is None, "篡改签名被拒")
        chk(sess.verify("", store) is None, "空 cookie 被拒")
        chk(sess.verify("a.b.c", store) is None, "多余分段的 cookie 被拒")
        chk(len(sess.ip_hash("1.2.3.4")) == 64, "IP 假名化输出 64 位十六进制")
        chk(sess.ip_hash("1.2.3.4") != "1.2.3.4", "IP 不以明文形式出现")

    print("防爆破节流")
    th = Throttle()
    chk(th.check("9.9.9.9") == 0, "初始放行")
    for _ in range(THROTTLE_SOFT):
        th.fail("9.9.9.9")
    chk(th.check("9.9.9.9") > 0, f"连败 {THROTTLE_SOFT} 次后进入锁定")
    th.ok("9.9.9.9")
    chk(th.check("9.9.9.9") == 0, "成功登录后清零")

    print("UA 解析（浏览器 / 系统 / 设备）")
    p = parse_ua("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                 "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0")
    chk(p["browser"] == "Edge 131.0.0.0", "外壳优先：带 Chrome 标记的 Edge 仍认成 Edge")
    chk(p["os"] == "macOS 10.15.7", "macOS 版本")
    chk(p["device"] == "Mac", "设备 Mac")
    p = parse_ua("Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 "
                 "(KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1")
    chk(p["os"] == "iOS 17.1" and p["device"] == "iPhone", "iPhone / iOS 版本")
    chk(p["browser"] == "Safari 17.1", "Safari 版本取自 Version/")
    p = parse_ua("Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A.220624.014) "
                 "AppleWebKit/537.36 Chrome/120.0.6099.144 Mobile Safari/537.36")
    chk(p["os"] == "Android 13" and p["device"] == "Android SM-G991B", "Android 版本与机型")
    chk(parse_ua("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")["os"] == "Windows 10/11",
        "Windows NT 10.0 → 10/11")
    chk(parse_ua("curl/8.4.0")["family"] == "curl", "curl 识别")
    chk(parse_ua("") == {"family": "-", "browser": "-", "os": "-", "device": "-"},
        "空 UA 各项均为 -")

    print("闸门总开关（gateconfig.json）")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        os.chmod(st, 0o700)
        cfg = GateConfig(st)
        chk(cfg.require_password() is True, "没有配置文件 → 需要密码（fail closed）")
        good = {"version": GATE_VERSION, "require_password": False, "updated_at": now_iso(),
                "admin": {"kdf": KDF_NAME, "n": KDF_N, "r": KDF_R, "p": KDF_P,
                          "dklen": KDF_DKLEN, "salt_bytes": KDF_SALT_BYTES,
                          "salt": b64u_encode(b"x" * KDF_SALT_BYTES),
                          "hash": b64u_encode(b"y" * KDF_DKLEN)}}
        (st / GATE_CONFIG_NAME).write_text(json.dumps(good), encoding="utf-8")
        chk(cfg.reload() is True and cfg.require_password() is False,
            "热重载读到 require_password=false")
        chk(cfg.snapshot()[1] is not None, "管理口令哈希可解析")
        for bad in ({"version": 99},
                    {"version": GATE_VERSION, "require_password": "yes"},
                    {"version": GATE_VERSION, "require_password": True, "admin": {"kdf": "md5"}},
                    {"version": GATE_VERSION, "require_password": True,
                     "admin": {"kdf": KDF_NAME, "n": KDF_N, "r": KDF_R, "p": KDF_P,
                               "dklen": KDF_DKLEN, "salt_bytes": KDF_SALT_BYTES,
                               "salt": "AA==", "hash": b64u_encode(b"y" * KDF_DKLEN)}}):
            (st / GATE_CONFIG_NAME).write_text(json.dumps(bad), encoding="utf-8")
            cfg.reload()
            chk(cfg.require_password() is True, f"畸形配置被拒并回落：{str(bad)[:38]}…")

    print("条目的禁用 / 有效期")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        os.chmod(st, 0o700)
        store = Store(st)
        raw = {"version": STORE_VERSION, "gen": 1,
               "params": {"kdf": KDF_NAME, "n": KDF_N, "r": KDF_R, "p": KDF_P,
                          "dklen": KDF_DKLEN, "salt_bytes": KDF_SALT_BYTES},
               "entries": [{"id": "k1", "salt": b64u_encode(b"s" * KDF_SALT_BYTES),
                            "hash": b64u_encode(b"h" * KDF_DKLEN), "rev": 1,
                            "enabled": False, "expires_at": "2020-01-01T00:00:00Z"}]}
        (st / "passwords.json").write_text(json.dumps(raw), encoding="utf-8")
        chk(store.reload(force=True) and store.count() == 1, "带 enabled / expires_at 的表可加载")
        _, entries = store.snapshot()
        chk(entries["k1"]["enabled"] is False, "enabled=false 被解析")
        chk(entries["k1"]["expires_ts"] > 0, "expires_at 转成了时间戳")
        sess = Sessions(st, 3600)
        chk(sess.verify(sess.issue("k1", 1, 1), store) is None, "被禁用的密码签不出有效会话")
        raw["entries"][0]["enabled"] = True
        (st / "passwords.json").write_text(json.dumps(raw), encoding="utf-8")
        store.reload(force=True)
        chk(sess.verify(sess.issue("k1", 1, 1), store) is None, "已过期的密码签不出有效会话")
        raw["entries"][0]["expires_at"] = "2099-01-01T00:00:00Z"
        (st / "passwords.json").write_text(json.dumps(raw), encoding="utf-8")
        store.reload(force=True)
        chk(sess.verify(sess.issue("k1", 1, 1), store) == "k1", "未过期的密码正常放行")

    print("同一密码多条目：优先命中可用条目")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        os.chmod(st, 0o700)
        pw = "同一个密码"
        def _mk(eid: str, *, enabled: bool, expires_at: str | None) -> dict:
            salt = secrets.token_bytes(KDF_SALT_BYTES)
            d = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=KDF_N, r=KDF_R,
                               p=KDF_P, dklen=KDF_DKLEN, maxmem=KDF_MAXMEM)
            return {"id": eid, "salt": b64u_encode(salt), "hash": b64u_encode(d),
                    "rev": 1, "enabled": enabled, "expires_at": expires_at}
        # 故意把「停用的」排在字典最前：老实现按第一个命中定结果，会把人挡在门外
        entries = {
            "a_disabled": _mk("a_disabled", enabled=False, expires_at=None),
            "b_expired": _mk("b_expired", enabled=True, expires_at="2020-01-01T00:00:00Z"),
            "c_ok": _mk("c_ok", enabled=True, expires_at=None),
        }
        ent = {k: {"salt": b64u_decode(v["salt"]), "hash": b64u_decode(v["hash"]),
                   "rev": v["rev"], "enabled": v["enabled"], "expires_ts": 0
                   if v["expires_at"] is None else 1, "expires_at": v["expires_at"]}
               for k, v in entries.items()}
        # expires_ts=1（过去的 1970 秒）代表已过期；0 代表永久
        eid, _ = pick_pw_entry(ent, pw)
        chk(eid == "c_ok", f"停用/过期/可用三条同密码 → 命中可用条目（实际 {eid}）")
        ent2 = {k: v for k, v in ent.items() if k != "c_ok"}
        eid, e = pick_pw_entry(ent2, pw)
        chk(eid == "a_disabled" and e["enabled"] is False,
            "可用条目全没了 → 回落第一个命中并如实报停用")
        chk(pick_pw_entry(ent, "别的密码") == (None, None), "不匹配的密码不命中任何条目")

    print("使用记录：免密放行登记（去重窗口）")
    global GATE_OPEN_DEDUPE_S
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        os.chmod(st, 0o700)
        ul = UsageLog(st, lambda s: "hash-" + s)
        ua = "Mozilla/5.0 Test"
        ul.append_gate_open(ip="1.2.3.4", ua=ua)
        ul.append_gate_open(ip="1.2.3.4", ua=ua)
        ul.append_gate_open(ip="5.6.7.8", ua=ua)
        ul.append_gate_open(ip="1.2.3.4", ua="Other/1.0")
        lines = (st / "usage.jsonl").read_text(encoding="utf-8").splitlines()
        chk(len(lines) == 3, f"同 ip+UA 窗口内去重，不同访客各记一条（实际 {len(lines)} 条）")
        recs = [json.loads(x) for x in lines]
        chk(all(r["ok"] is True and r["reason"] == R_GATE_OPEN and r["pwid"] is None
                for r in recs), "免密放行记录：ok=true、reason=gate_open、无密码 id")
        chk(recs[0]["ip"] == "1.2.3.4", "明文 ip 落盘（与失败/成功记录同口径）")
        GATE_OPEN_DEDUPE_S = 0
        ul.append_gate_open(ip="1.2.3.4", ua=ua)
        GATE_OPEN_DEDUPE_S = 300
        n = len((st / "usage.jsonl").read_text(encoding="utf-8").splitlines())
        chk(n == 4, f"窗口归零后同访客再记一条（实际 {n} 条）")

    print("")
    print("selftest：全部通过" if ok else "selftest：有失败项")
    sys.exit(0 if ok else 1)


def main() -> None:
    ap = argparse.ArgumentParser(description="网页版访问闸门的鉴权服务（仅回环监听）")
    ap.add_argument("--listen", default="127.0.0.1:8090")
    ap.add_argument("--state", type=Path, default=Path("/var/lib/cmsgate"))
    ap.add_argument("--session-ttl", type=int, default=DEFAULT_SESSION_TTL,
                    help="会话绝对上限（秒），默认 24 小时；0 = 不设上限")
    ap.add_argument("--selftest", action="store_true", help="自检后退出")
    a = ap.parse_args()

    if a.selftest:
        run_selftest(a.state)
        return

    srv = make_server(a.listen, a.state, max(0, a.session_ttl))

    def shutdown(*_):
        log("收到停止信号，正在退出")
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    try:
        srv.serve_forever(poll_interval=0.5)
    finally:
        srv.server_close()


if __name__ == "__main__":
    main()
