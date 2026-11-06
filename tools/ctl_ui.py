#!/usr/bin/env python3
"""跑分调度管理的**本地可视化界面**（ctlui）——仿 cmsui/gate_ui 的形态。

    ctlui                          # 已装进 PATH（scripts/dist/install-ctlui.sh 装的软链）
    python3 tools/ctl_ui.py        # 等价；默认端口 8712（712 等低端口要 root，绑不上）
    python3 tools/ctl_ui.py --port 8740

与 gate_ui.py 同一套四层防护（缺一不可）：

  1. **只绑 127.0.0.1**：局域网连不上。
  2. **一次性 token**：启动时生成（secrets.token_urlsafe(32)），只有终端里那个
     网址带它；兑换一次后失效，换成 HttpOnly; SameSite=Strict 的 cookie，
     并立刻 303 把 token 从地址栏抹掉。
  3. **Host 头白名单**：挡 DNS rebinding——恶意域名解析到 127.0.0.1 也过不了
     Host 检查。Origin/Referer 存在时还须精确到 host:port 同源。
  4. **API 必须带自定义头 `X-CTLUI: 1`**：跨站表单发不出自定义头，带自定义头
     的跨站请求会触发 CORS 预检，本服务不响应预检 → 浏览器拦下。

写操作**不在界面里另做权限判断**，而是转调 distctl（SSH → 服务器上的
dist_server.py admin-*）：哪些命令要管理口令、scrypt 校验，全在那一侧。
口令经本服务 stdin 喂给 ssh，**不进 argv、不写日志、不落盘**；浏览器到本服务
之间是 127.0.0.1 明文（与 cmsui 同一信任模型——能读本机回环的进程本来就能
读你的 SSH 私钥）。

用法提示
--------
    · 终端打印的网址**不要**贴给别人——它就是钥匙。
    · 进程一退 token 即失效；重启换新的。
    · CLI（distctl.py）一字未变，照常可用。
"""
from __future__ import annotations

import argparse
import hmac
import http.server
import json
import os
import subprocess
import sys
import threading
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import distctl  # noqa: E402  复用 REMOTE/REMOTE_PY/remote_argv——SSH 目标与转义只此一份

HERE = os.path.dirname(os.path.realpath(__file__))  # realpath：ctlui 是软链时也能找到资源
ASSET_DIR = os.path.join(HERE, "ctlui")
REPO_ROOT = os.path.dirname(HERE)                   # solver 版本历史要跑 git，仓库根为工作目录

#: 本进程启动时刻，用来发现「源码比进程新」（cmsui 同款口径）。
#: 前端资源每次请求从磁盘读，改了刷新就生效；本文件被 Python 载入内存，
#: 改了必须重启——否则页面看着是新的、接口行为却是旧的，非常莫名其妙。
STARTED_AT = time.time()

#: 热路径带回的最近结果条数。卡面只显示最新 10 条，30 是给「刚跑完几条想一眼看到」
#: 留的余量——再多就是往那条 15~40KB/s 的公网上白塞字节。
DONE_RECENT_N = 30

#: op -> admin 子命令。2026-10-31 裁决：所有管理操作都要口令（GUARDED=全集，
#: 服务器端 admin_cmds 的 needs_pw 已同步为除 status/export/lite/history 外全 True）。
#: 后四条都是只读视图，数据同源且只能从 root SSH 进来，公网 7120 碰不到。
OPS = {
    "insert": "admin-insert",
    "pause": "admin-pause",
    "resume": "admin-resume",
    "lease": "admin-lease",
    "seed": "admin-seed",
    "limit": "admin-limit",
    "default": "admin-default",
    "clear-queue": "admin-clear-queue",
    "invalidate": "admin-invalidate",
    "kick": "admin-kick",
    "drop": "admin-drop",
    "rm": "admin-dequeue",
    "cool": "admin-cool",
    "pomo": "admin-pomo",
}
GUARDED = set(OPS)


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def op_run(op: str, args: list[str], admin: str) -> dict:
    """执行一个管理操作。guarded 的 op 必须带口令；口令只经 stdin 进 ssh。"""
    if op not in OPS:
        raise ApiError(f"未知操作：{op}")
    if not isinstance(args, list) or len(args) > 64 or not all(isinstance(a, str) for a in args):
        raise ApiError("args 非法")
    if any("\n" in a or "\r" in a for a in args):
        raise ApiError("参数里不能有换行")
    admin_cmd = OPS[op]
    stdin_data = None
    if op in GUARDED:
        if not isinstance(admin, str) or not admin:
            raise ApiError("这个操作需要管理口令")
        stdin_data = admin + "\n"
    try:
        p = subprocess.run(distctl.remote_argv(admin_cmd, args), input=stdin_data,
                           capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        raise ApiError("远端执行超时", 504)
    out = (p.stdout or "").strip()
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()
        # 远端 die() 的最后一行是人话（口令不正确/参数非法…），往前带一行上下文
        msg = "\n".join(err[-2:]) if err else f"退出码 {p.returncode}"
        raise ApiError(msg, 403 if "口令" in msg else 400)
    try:
        return {"ok": True, "data": json.loads(out) if out else {}}
    except Exception:
        raise ApiError(f"远端输出不是 JSON：{out[:200]}", 502)


def _remote_json(admin_cmd: str, args: list[str], what: str) -> dict:
    """跑一条只读 admin 命令，stdout 收成 dict。写操作不走这里（见 op_run：要喂口令）。"""
    try:
        p = subprocess.run(distctl.remote_argv(admin_cmd, args), capture_output=True,
                           text=True, timeout=60)
    except subprocess.TimeoutExpired:
        raise ApiError(f"{what} 超时（SSH 不通？）", 504)
    if p.returncode != 0:
        err = (p.stderr or "").strip().splitlines()
        msg = err[-1] if err else f"退出码 {p.returncode}"
        if "未知命令" in msg:
            # 本机 ctlui 比服务器新时会撞到这里——说清要部署，别让人以为是网络慢
            msg += " —— 调度端还是旧版，先跑 scripts/dist/deploy-dist.sh 部署 dist_server.py"
        raise ApiError(f"{what} 失败：{msg[-300:]}", 502)
    try:
        return json.loads(p.stdout or "{}")
    except Exception:
        raise ApiError(f"{what} 输出不是 JSON：{(p.stdout or '')[:200]}", 502)


def _code_stale() -> bool:
    """ctl_ui.py 是否比本进程新（= 改了没重启）。留 1 秒余量防 mtime 精度误报。"""
    try:
        return os.stat(os.path.realpath(__file__)).st_mtime > STARTED_AT + 1.0
    except OSError:
        return False


#: 前端三件套（每次请求从磁盘读，改完不用重启进程）
ASSET_FILES = ("index.html", "app.js", "app.css")


def assets_ver() -> str:
    """磁盘上前端三件套的「代」——mtime+体积的短哈希，只 stat 不读内容。
    浏览器里跑的 app.js 是**页面加载那一刻**的快照，磁盘换了不重新加载就永远用旧 JS；
    过去只能等用户手动刷新才发现「怎么没这功能」，现在每次看板刷新都比对一次，
    不一样就把条子挂出来（跟「服务端没重启」那条分开写，因为要做的动作不同）。"""
    import hashlib
    h = hashlib.sha256()
    for f in ASSET_FILES:
        try:
            st = os.stat(os.path.join(ASSET_DIR, f))
            h.update(f"{f}:{st.st_mtime_ns}:{st.st_size}".encode())
        except OSError:
            h.update(f"{f}:missing".encode())
    return h.hexdigest()[:12]


def status() -> dict:
    """看板热路径：走 admin-lite（最近 30 条 + 规格聚合，~16KB）。

    实测账（2026-11-02）：一次刷新的握手 0.27s、远端生成 0.4s 都稳，
    传输段却要 1.7~5.0s——因为 admin-status 全量 741KB（gzip 70KB）里
    92% 是 done 明细，而这条公网链路只有 15~40KB/s 还要和在线客户端分。
    所以明细不进热路径，完整历史改由「历史记录」弹窗点开时现拉（/api/history）。
    """
    d = _remote_json("admin-lite", [str(DONE_RECENT_N)], "status")
    d["stale"] = _code_stale()
    d["assets_ver"] = assets_ver()
    return {"ok": True, "data": d}


def history() -> dict:
    """完整历史：全量 done（只投影 UI 要用的字段）。慢是慢在这一次，值。"""
    return {"ok": True, "data": _remote_json("admin-history", [], "历史记录")}


_TOKEN_LOCK = threading.Lock()

# ---- 求解器版本历史 ---------------------------------------------------------
# 指纹算法必须与 CMakeLists / package-dist-client.sh 逐字节一致：
# 文件序 = tools/solver.cpp、src/core/Board.cpp、src/core/Board.h、src/solver/*.h（字典序），
# 每文件 sha256 的 hex 直接拼接（无分隔）→ 再 sha256 → 取前 8 位。
# 历史 = 逐提交把当时那份内容重算一遍（git 只有几十个 solver 提交，全量 <1s，按 HEAD 缓存）。
SOLVER_VER_PATHS = ["tools/solver.cpp", "src/core/Board.cpp", "src/core/Board.h", "src/solver"]
#: 客户端那条轴只有一个文件——它的字节哈希就是身份（与 dist_client.client_ver 同口径）
CLIENT_VER_PATH = "tools/dist_client.py"
_solver_hist_cache: dict = {"key": None, "data": None}


def _git_out(*args: str) -> str:
    p = subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise ApiError(f"git {' '.join(args)} 失败：{p.stderr.strip()[:200]}", 502)
    return p.stdout


def _fingerprint(rev: str | None) -> str:
    """rev=None → 工作区文件；否则 git show <rev>:<path>。该提交缺的文件跳过参与拼接
    （早期二进制本就编不出这个指纹——指纹链路 71835a2 才有）。"""
    import hashlib
    parts: list[str] = []
    for path in SOLVER_VER_PATHS[:3]:
        try:
            data = (open(os.path.join(REPO_ROOT, path), "rb").read() if rev is None
                    else _git_bytes(rev, path))
        except (OSError, ApiError):
            continue
        parts.append(hashlib.sha256(data).hexdigest())
    if rev is None:
        eng = sorted(f for f in os.listdir(os.path.join(REPO_ROOT, "src/solver")) if f.endswith(".h"))
        blobs = [(f, open(os.path.join(REPO_ROOT, "src/solver", f), "rb").read()) for f in eng]
    else:
        listing = _git_out("ls-tree", "-r", "--name-only", rev, "--", "src/solver") \
            if _git_ok("rev-parse", "-q", "--verify", f"{rev}:src/solver") else ""
        eng = sorted(os.path.basename(x) for x in listing.split() if x.endswith(".h"))
        blobs = [(f, _git_bytes(rev, f"src/solver/{f}")) for f in eng]
    parts += [hashlib.sha256(b).hexdigest() for _, b in blobs]
    return hashlib.sha256("".join(parts).encode()).hexdigest()[:8]


def _client_fingerprint(rev: str | None) -> str:
    """某个提交里 `dist_client.py` 的短哈希 = **客户端身份的历史值**。
    与 `dist_client.client_ver()` 同口径（免安装形态下客户端哈希的就是这个文件），
    所以历史表里那一列能直接跟「线上在跑」「已发布」对。
    rev=None 走 `client_ws_ver()`（同一份语义只留一个实现，顺带吃它的 mtime 缓存）。
    那个提交还没有这个文件（客户端 2026-10-31 才有）→ 空串，页面显示「—」。"""
    import hashlib
    if rev is None:
        return client_ws_ver()
    try:
        data = _git_bytes(rev, CLIENT_VER_PATH)
    except (OSError, ApiError):
        return ""
    return hashlib.sha256(data).hexdigest()[:8]


def _git_ok(*args: str) -> bool:
    return subprocess.run(["git", *args], cwd=REPO_ROOT, capture_output=True, check=False).returncode == 0


#: 自动更新清单在服务器上的落点（打包脚本 scp 到这里，与 dist_server 的 CLIENT_DIR 同一份）
MANIFEST_REMOTE = "/var/lib/cmsdist/client/manifest.json"
_manifest_cache: dict = {"ts": 0.0, "man": None}


def _published_manifest() -> dict | None:
    """线上 manifest 整份（60s 缓存）。走同一条 SSH（目标只此一份，见 distctl.REMOTE）：
    这张卡默认 15s 刷一次，不该为此每分钟多打几次 ssh。取不到返回 None → 页面显示「—」
    不弹错，manifest 只是补充口径，核心数据在 state 里。"""
    now = time.time()
    if now - _manifest_cache["ts"] < 60:
        return _manifest_cache["man"]
    _manifest_cache["ts"] = now
    man = None
    try:
        p = subprocess.run(["ssh"] + distctl.SSH_OPTS + distctl.REMOTE.split()
                           + [f"cat {MANIFEST_REMOTE}"],
                           capture_output=True, text=True, timeout=20)
        m = json.loads(p.stdout) if p.returncode == 0 else None
        if isinstance(m, dict):
            man = m
    except (OSError, ValueError, subprocess.SubprocessError):
        man = None
    _manifest_cache["man"] = man
    return man


def _hex8(v) -> str | None:
    """只认 8 位以上的纯十六进制（短哈希口径）；别的形状一律 None，不往页面上塞垃圾。"""
    if isinstance(v, str) and len(v) >= 8 and all(c in "0123456789abcdef" for c in v[:8]):
        return v[:8]
    return None


def _published_solver_ver() -> str | None:
    """线上 manifest 里的 solver_ver = 「下一个领任务的客户端会变成哪版求解器」。"""
    man = _published_manifest()
    v = man.get("solver_ver") if man else None
    return v if isinstance(v, str) and 6 <= len(v) <= 16 \
        and all(c in "0123456789abcdef" for c in v) else None


#: manifest 里客户端那三份的键 → 页面用的平台名（solver 那三份叫 solver-*，是另一条轴）
CLIENT_MANIFEST_KEYS = (("mac", "macos-bin"), ("win", "win64-py"), ("linux", "linux64-py"))


def _published_client_vers() -> dict:
    """已发布的**客户端**身份：manifest 里每个平台那份程序字节的 sha256 前 8 位。
    与客户端自报的 `client_ver` 同口径，所以两边能直接对 —— 对不上的那一半就是没换过来
    （更新是逐文件换的：Windows 上 solver.exe 在用换不动，就会出现「新客户端 + 老求解器」）。"""
    files = (_published_manifest() or {}).get("files")
    files = files if isinstance(files, dict) else {}
    out = {}
    for label, key in CLIENT_MANIFEST_KEYS:
        e = files.get(key)
        sha = e.get("sha256") if isinstance(e, dict) else None
        h = _hex8(sha)
        if h:
            out[label] = h
    return out


_client_ws_cache: dict = {"key": None, "ver": ""}


def client_ws_ver() -> str:
    """工作区那份 `tools/dist_client.py` 的短哈希 —— 与客户端自报的 `client_ver`
    同口径（免安装包形态下客户端哈希的就是这个文件），所以「工作区 ≠ 已发布」= 改了没发。
    按 (mtime_ns, size) 缓存：改一次算一次，不改就只 stat。"""
    import hashlib
    p = os.path.join(REPO_ROOT, "tools", "dist_client.py")
    try:
        s = os.stat(p)
    except OSError:
        return ""
    key = (s.st_mtime_ns, s.st_size)
    if _client_ws_cache["key"] != key:
        try:
            with open(p, "rb") as f:
                _client_ws_cache["ver"] = hashlib.sha256(f.read()).hexdigest()[:8]
        except OSError:
            _client_ws_cache["ver"] = ""
        _client_ws_cache["key"] = key
    return _client_ws_cache["ver"]


def _git_bytes(rev: str, path: str) -> bytes:
    p = subprocess.run(["git", "show", f"{rev}:{path}"], cwd=REPO_ROOT,
                       capture_output=True, check=False)
    if p.returncode != 0:
        raise ApiError("missing", 404)
    return p.stdout


def solver_history() -> dict:
    head = _git_out("rev-parse", "HEAD").strip()
    if _solver_hist_cache["key"] != head:
        # 两个身份**一条时间线**：任一轴的指纹变了就收一条（同一个提交可能同时动两边）。
        # 分两张表会让人对不上「这次发版到底换了哪一半」。
        log = _git_out("log", "--format=%H\x1f%ct\x1f%s", "--",
                       *SOLVER_VER_PATHS, CLIENT_VER_PATH)
        entries = []
        for line in log.strip().splitlines():
            sha, ct, subj = line.split("\x1f", 2)
            try:
                entries.append({"ver": _fingerprint(sha), "client": _client_fingerprint(sha),
                                "sha": sha[:8], "ts": int(ct), "subject": subj})
            except ApiError:
                continue
        # 只保留「任一身份变了」的提交：两个都没变的更早提交没有信息量
        keep: list[dict] = []
        for e in entries:
            if not keep or (keep[-1]["ver"], keep[-1]["client"]) != (e["ver"], e["client"]):
                keep.append(e)
        _solver_hist_cache["data"] = keep
        _solver_hist_cache["key"] = head
    cur = _fingerprint(None)  # 工作区（含未提交改动）每次现算，代价 5 个本地哈希
    dirty = bool(_git_out("status", "--porcelain", "--",
                          *SOLVER_VER_PATHS, CLIENT_VER_PATH).strip())
    return {"ok": True, "data": {"current": cur, "dirty": dirty,
                                 "published": _published_solver_ver(),
                                 # 客户端那条轴的三口径（历史表两个轴共用一条时间线）
                                 "current_client": client_ws_ver(),
                                 "published_client": _published_client_vers(),
                                 "entries": _solver_hist_cache["data"]}}


_NO_TOKEN_PAGE = """<!DOCTYPE html><html lang="zh"><meta charset="utf-8">
<title>ctlui</title><body style="font-family:system-ui;background:#f5f7fa;
display:grid;place-items:center;height:100vh;color:#5b6b7a">
<div style="text-align:center"><p style="font-size:42px;margin:0">🔒</p>
<p>没有令牌。回到终端里那个带 <code>?k=</code> 的网址打开。</p></div>"""


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "cmsdist-ui/1"
    protocol_version = "HTTP/1.1"
    token: str = ""
    token_consumed: bool = False
    port: int = 0

    def log_message(self, fmt, *args):
        # 绝不记完整 URL / query——初始 ?k= 就是钥匙
        path = urllib.parse.urlsplit(self.path).path
        sys.stderr.write(f"  {self.command} {path}\n")

    # ---- 防护层 ----
    def _allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}",
                f"[::1]:{self.port}", "127.0.0.1", "localhost"}

    def _host_ok(self) -> bool:
        host = (self.headers.get("Host") or "").strip().lower()
        return host in self._allowed_hosts()

    def _origin_ok(self) -> bool:
        for h in ("Origin", "Referer"):
            v = self.headers.get(h)
            if not v:
                continue
            u = urllib.parse.urlsplit(v)
            if (u.netloc or "").lower() not in self._allowed_hosts():
                return False
        return True

    def _cookie_token(self) -> str:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith("ctlui="):
                return part[len("ctlui="):]
        return ""

    def _authed(self) -> bool:
        return hmac.compare_digest(self._cookie_token(), self.token)

    # ---- 发送 ----
    def _send(self, code: int, body: bytes = b"", *, ctype: str = "application/json; charset=utf-8",
              extra: list[tuple[str, str]] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; script-src 'self'; "
                         "style-src 'self'; connect-src 'self'; form-action 'self'; "
                         "frame-ancestors 'none'; base-uri 'none'; object-src 'none'")
        self.send_header("X-Frame-Options", "DENY")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _fail(self, code: int, msg: str) -> None:
        self._json({"ok": False, "error": msg}, code)

    # ---- 路由 ----
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        path, q = u.path, urllib.parse.parse_qs(u.query)
        if not self._host_ok():
            return self._fail(403, "Host 不被允许")
        if path == "/":
            k = (q.get("k") or [""])[0]
            if k and hmac.compare_digest(k, self.token):
                with _TOKEN_LOCK:
                    fresh = not type(self).token_consumed
                    if fresh:
                        type(self).token_consumed = True
                if not fresh and not self._authed():
                    return self._send(403, _NO_TOKEN_PAGE.encode("utf-8"),
                                      ctype="text/html; charset=utf-8")
                return self._send(303, b"", ctype="text/plain",
                                  extra=[("Set-Cookie",
                                          f"ctlui={self.token}; Path=/; HttpOnly; SameSite=Strict"),
                                         ("Location", "/")])
            if not self._authed():
                return self._send(403, _NO_TOKEN_PAGE.encode("utf-8"),
                                  ctype="text/html; charset=utf-8")
            return self._send(200, open(os.path.join(ASSET_DIR, "index.html"), "rb").read(),
                              ctype="text/html; charset=utf-8")
        if not self._authed():
            return self._fail(403, "未授权")
        fn = os.path.normpath(path.lstrip("/"))
        if fn in ("app.js", "app.css"):
            fp = os.path.join(ASSET_DIR, fn)
            ctype = "application/javascript; charset=utf-8" if fn.endswith(".js") else "text/css; charset=utf-8"
            return self._send(200, open(fp, "rb").read(), ctype=ctype)
        return self._fail(404, "not found")

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        if not self._host_ok():
            return self._fail(403, "Host 不被允许")
        if not self._origin_ok():
            return self._fail(403, "Origin 不被允许")
        if not self._authed():
            return self._fail(403, "未授权")
        if self.headers.get("X-CTLUI") != "1":
            return self._fail(403, "缺自定义头（跨站请求？）")
        n = int(self.headers.get("Content-Length") or 0)
        if n > 64 * 1024:
            return self._fail(413, "too large")
        try:
            req = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        except Exception:
            return self._fail(400, "bad json")
        try:
            if u.path == "/api/status":
                return self._json(status())
            if u.path == "/api/history":
                return self._json(history())
            if u.path == "/api/solver-history":
                return self._json(solver_history())
            if u.path == "/api/op":
                return self._json(op_run(str(req.get("op", "")), req.get("args") or [],
                                         req.get("admin") or ""))
            return self._fail(404, "not found")
        except ApiError as e:
            return self._fail(e.status, str(e))


def main():
    ap = argparse.ArgumentParser(description="ctlui — 跑分调度本地管理界面")
    ap.add_argument("--port", type=int, default=8712)  # <1024 要 root，712 绑不上
    a = ap.parse_args()
    import secrets
    token = secrets.token_urlsafe(32)
    Handler.token = token
    Handler.port = a.port
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    print(__doc__.strip().splitlines()[0])
    print()
    print("  跑分管理界面已启动（只在本机可访问）")
    print()
    print("  用浏览器打开这条网址（含钥匙，请勿外发）：")
    print(f"    http://127.0.0.1:{a.port}/?k={token}")
    print()
    print("  打开一次即换成本地会话，令牌随即作废；")
    print("  令牌只显示这一次，别发给别人；进程退出即失效。Ctrl+C 退出。")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
