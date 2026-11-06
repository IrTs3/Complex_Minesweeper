#!/usr/bin/env python3
# dist_server.py — 复数扫雷求解器基准 · 调度服务器（公开 HTTP，端口 7120）
#
# 设计见 docs 与方案：无密钥无 token，防护靠任务绑定 nonce + 严格校验 +
# 每 IP 并发上限 + lease 自愈 + 管理端一键作废。管理操作不走 HTTP，
# 由 root SSH 调本文件的 admin-* 子命令（tools/distctl.py 是它的本机封装）。
#
# 用法：
#   dist_server.py serve [HOST] [PORT]        # systemd 入口（默认 0.0.0.0:7120）
#   dist_server.py admin-status               # 以下为管理命令（root SSH 调用）
#   dist_server.py admin-lite [N]             # ctlui 热路径：最近 N 条结果 + 规格聚合（小包）
#   dist_server.py admin-history              # ctlui 历史弹窗：全量结果，只投影 UI 字段
#   dist_server.py admin-default <complex|classic> [CxRxM] [games]
#   dist_server.py admin-insert <n> <complex|classic> [CxRxM] [games] [起种子]
#   dist_server.py admin-pause | admin-resume | admin-clear-queue
#   dist_server.py admin-pomo on | off | set <连算>/<休息> | status   # 散热番茄钟（全局相位）
#   dist_server.py admin-lease <Xh> [Ym]
#   dist_server.py admin-invalidate <task_id | ip:ADDR | name:NAME>
#   dist_server.py admin-export               # 全部逐局记录 JSON 打到 stdout
#   （kick=进行中收回队列重发；dequeue=删队列任务；drop=删进行中任务不回队列）
#
# 状态目录：CMSDIST_STATE 环境变量覆盖，默认 /var/lib/cmsdist
#   state.json（0600，flock）+ results/<task_id>.json.gz + secret（HMAC 密钥）

import base64
import gzip
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STATE_DIR = os.environ.get("CMSDIST_STATE", "/var/lib/cmsdist")
STATE_FILE = os.path.join(STATE_DIR, "state.json")
# ★ 互斥锁单独一个文件，永不 os.replace。锁加在 inode 上，而每次保存都会换掉
#   state.json 的 inode —— 排队等锁的人醒来时锁的是份已被替换的死文件，
#   对后来者毫无约束力，于是两个写者同时往同一个 .tmp 里各写一份，拼出坏档
#   （2026-11-02 12:12 实测：完整 JSON + 多出一个 '}' → 全服务 500 两小时）。
LOCK_FILE = os.path.join(STATE_DIR, "state.lock")
RESULTS_DIR = os.path.join(STATE_DIR, "results")
SECRET_FILE = os.path.join(STATE_DIR, "secret")
CLIENT_DIR = os.path.join(STATE_DIR, "client")   # 自动更新：manifest.json + 各端二进制
GATECONFIG = os.environ.get("CMSDIST_GATECONFIG", "/var/lib/cmsgate/gateconfig.json")

MAX_BODY = 2 * 1024 * 1024          # result 包上限（经典 10000 局逐局记录 ~1MB 原始）
MAX_IP_INPROG = 3                   # 每 IP 同时领用上限
DEFAULT_LEASE_SEC = 2 * 3600
# 从未上报过进度的任务不按整份租约等：客户端领完任务 10 秒内就报第一次进度，
# 15 分钟还一声没有基本是「领完就死」——按宽限收回，名额别白占 2 小时。
# 但反复被收满 HEARTBEAT_MISS_CAP 次仍无心跳的退回整份租约：老客户端压根不发
# 进度，一直按宽限收会把它们的任务打成无限重发循环。
HEARTBEAT_GRACE_SEC = 15 * 60
HEARTBEAT_MISS_CAP = 3
#: 散热番茄钟（2026-11-03，用户提「跑分机太烫」）。相位不靠定时器、也不靠进程内存：
#: 只存 anchor（墙上秒），任意时刻 pos = (now - anchor) % (work + rest)，pos < work 干活、
#: 否则休息。重启/换进程/多读者都算出同一个相位，全舰队统一，ctlui 上「现在在歇」对谁都成立。
#: 休息相位做两件事：① /claim 不发新任务；② schedule 随任务发给客户端 → 转给 solver，
#: 正在跑的那个任务在**两局之间**睡到相位结束（进程不死、已算的局不丢，见 tools/solver.cpp）。
#: 关掉只影响之后领的任务：在跑的那单按它领到的 schedule 走完，不硬杀。
POMO_DEFAULT = {"on": False, "work_sec": 1500, "rest_sec": 300, "anchor": 0}


def pomo_dur(seg):
    """时长一段的解析："1h30m" / "45m" / "90s" / 裸数字=分钟 / "0" / "off" → 秒；None=读不懂。
    ★与 tools/solver.cpp 的 parseDur、tools/dist_client.py 的 pomo_parse 是同一把尺的三份拷贝
      （分发包不许 import 公共模块，solver 又必须是纯 C++）；「裸数字=分钟」不许分叉，
      由 tools/check_invariants.py 钉住。"""
    seg = (seg or "").strip()
    if seg in ("off", "0"):
        return 0
    total = num = 0
    has = False
    for ch in seg:
        if ch in "0123456789":
            num = num * 10 + int(ch)
            has = True
            continue
        mult = {"h": 3600, "m": 60, "s": 1}.get(ch)
        if mult is None or not has:
            return None
        total += num * mult
        num = 0
        has = False
    if has:
        total += num * 60   # 裸数字 = 分钟
    return total


def pomo_phase(cfg, now=None):
    """当前相位；没开或参数不合法 → None（调用方按「没有番茄钟」处理）。"""
    p = dict(POMO_DEFAULT)
    p.update(cfg.get("pomo") or {})
    try:
        w, r = int(p["work_sec"]), int(p["rest_sec"])
        a = float(p["anchor"] or 0)
    except (TypeError, ValueError):
        return None
    if not p.get("on") or w <= 0 or r <= 0:
        return None
    now = time.time() if now is None else now
    if now < a:   # anchor 在未来（手动拨过钟）：当「刚开始连算」，别把负数取模当成休息
        return {"on": True, "work_sec": w, "rest_sec": r, "anchor": a, "in_rest": False,
                "left": a + w - now, "until": a + w, "server_now": now}
    cs = a + int((now - a) // (w + r)) * (w + r)
    in_rest = (now - cs) >= w
    until = cs + (w + r if in_rest else w)
    return {"on": True, "work_sec": w, "rest_sec": r, "anchor": a, "in_rest": in_rest,
            "left": until - now, "until": until, "server_now": now}


def pomo_wire(cfg, ph=None):
    """给客户端/ctlui 的那份：`anchor` 是**服务器**时钟域的绝对秒，客户端换算到自己机器时钟，
    机房机器没对时也不会错开相位（不换算的话，慢 10 分钟的机器会多歇 10 分钟）。"""
    ph = pomo_phase(cfg) if ph is None else ph
    if not ph:
        # 关着也要把两段时长回给 ctlui：否则管理员改过 30m/10m 再关掉，
        # 下次打开时输入框会漂回默认 25m/5m，看着像没保存。
        p = dict(POMO_DEFAULT)
        p.update(cfg.get("pomo") or {})
        # 这条在 /claim 热路径上：state.json 被手改坏过一段就绝不能 500 掉整个服务
        try:
            w, r = int(p["work_sec"]), int(p["rest_sec"])
        except (TypeError, ValueError):
            w, r = POMO_DEFAULT["work_sec"], POMO_DEFAULT["rest_sec"]
        return {"on": False, "work_sec": w, "rest_sec": r}
    return {"on": True, "work_sec": ph["work_sec"], "rest_sec": ph["rest_sec"],
            "anchor": round(ph["anchor"], 3), "server_now": round(ph["server_now"], 3),
            "in_rest": ph["in_rest"], "left": round(ph["left"], 1), "until": round(ph["until"], 3)}

#: 被 kick/租约收回的任务重入队后的冷却期：不立即再发出去，给管理员留时间删
DEFAULT_COOL_SEC = 60
#: /progress 落盘节流窗口。客户端每 10s/任务报一次进度，实测 2.7 次/秒，而每次
#: 上报原来都要把整份 state.json（~935KB）序列化 + fsync 一遍 —— 这台 2 核机
#: 的 CPU 头号去处就是它。进度只是看板上的小数（ctlui 本身 15s 刷一次），真正
#: 的结果走 /result；所以窗口内的最新值先存内存 _prog_overlay，由下一次写顺带
#: 落盘。代价：进程被 kill 时磁盘上的进度最多旧 PROG_FLUSH_SEC 秒，逐局记录还在
#: 客户端 pending 里补报，不丢数据。
PROG_FLUSH_SEC = 5.0
#: 更新包下载配额：同一 IP 每小时最多这么多次 GET /client/file/*，超了 429。
#: 线上账（2026-11-02）：机房一台 Air 的 9 个窗口全天把同一个 8,135,808 字节的
#: mac 包重下 674 次 ≈ 5.5GB 上行/天，把公网出口占满（网站/闸门/ctlui 一起被挤），
#: 而服务器对「同一份字节」本来有求必应。反复重下 = 它换不上新版（目录写不落地），
#: 多给一次就多烧 8MB，给到无限就是今天这样。5 次/小时本来够一台机器开几个窗口
#: 正常换代（命中即白嫖不下载），挡住的窗口下个整点重试自愈。2026-11-05 上调到 20：
#: 7443 TLS 换代要全舰队过一遍包，5 次的口子配冷却 30 分钟拖慢换代，先放宽这轮。
DL_LIMIT_PER_HOUR = 20
DL_WINDOW_SEC = 3600
RECORD_KEYS = {"g", "win", "guess", "mid", "end", "trap", "zero", "flagpath", "sec"}
BOARD_RE = re.compile(r"^(\d{1,4})x(\d{1,4})x(\d{1,4})$")

# —— 与 tools/gate_manager.py 逐字一致的 scrypt 参数（共用管理口令哈希）——
KDF_N, KDF_R, KDF_P, KDF_DKLEN = 16384, 8, 1, 32


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


# --------------------------------------------------------------------------
# 状态读写（flock 串行化；单文件小，整读整写足够）
# --------------------------------------------------------------------------

_lock = threading.Lock()

# 挂起的进度上报（task_id -> {"prog":…, "prog_at":…}）。只在 _lock 持有期间读写：
# 它是本进程的内存，跨进程的 admin-* 命令看不到 —— 那些读者拿到的就是磁盘上
# 「最多旧 PROG_FLUSH_SEC 秒」的版本，这是节流的既定代价。
_prog_overlay = {}
_prog_last_flush = 0.0

# 处理器在锁内证明「这次一个字都没改状态」时置位，__exit__ 就跳过落盘。
# 和 _prog_overlay 一样只在 _lock 持有期间读写，每次取锁先清零。
_no_write = False


def _skip_save(nothing_changed):
    """nothing_changed 必须由调用点把「可能已经改动状态的来源」算进去再传：
    claim 里就是 sweep_expired 的返回值 —— 传反了会静默丢一次写。"""
    global _no_write
    _no_write = bool(nothing_changed)


# 更新包下载配额（ip -> 命中时刻列表）。跟 state 无关，所以用自己的小锁，
# 别去蹭 _lock：_lock 的语义是「正在读改写 state」，这里根本不碰 state。
_dl_lock = threading.Lock()
_dl_hits = {}


def _dl_allow(ip):
    """能不能发这一次更新包。返回 (允许?, 距窗口滑走还要多少秒)。
    只判不计：计数由真正发出字节之后 _dl_record 负责，404 之类不占额度。"""
    now = time.time()
    with _dl_lock:
        hits = [t for t in _dl_hits.get(ip, []) if now - t < DL_WINDOW_SEC]
        if len(hits) >= DL_LIMIT_PER_HOUR:
            _dl_hits[ip] = hits
            wait = int(DL_WINDOW_SEC - (now - hits[0])) + 1
            return False, max(1, wait)
        return True, 0


def _dl_record(ip):
    now = time.time()
    with _dl_lock:
        hits = [t for t in _dl_hits.get(ip, []) if now - t < DL_WINDOW_SEC]
        hits.append(now)
        _dl_hits[ip] = hits
        if len(_dl_hits) > 512:      # 公网 IP 会一直换，别让这张表只增不减
            for k in [k for k, v in _dl_hits.items() if not v or now - v[-1] >= DL_WINDOW_SEC]:
                _dl_hits.pop(k, None)


def _merge_overlay(st):
    """把挂起进度盖回新解析的 state，返回本次真正盖进去的键（供落盘后剪枝）。
    只盖 inprog 里还在的任务：已被 /result 收走或被 kick 删掉的，条目直接作废。"""
    applied = {}
    for tid, vals in list(_prog_overlay.items()):
        t = st["inprog"].get(tid)
        if t is None:
            del _prog_overlay[tid]
            continue
        t["prog"] = vals["prog"]
        t["prog_at"] = vals["prog_at"]
        applied[tid] = vals
    return applied


def _default_state():
    return {
        "config": {
            "default": {"model": "complex", "cols": 30, "rows": 16, "mines": 99, "games": 100},
            "seed_next": 20261201,
            "lease_sec": DEFAULT_LEASE_SEC,
            "paused": False,
            "pomo": dict(POMO_DEFAULT),
        },
        "queue": [],      # 优先任务（插队）：[{task_id, seed, model, cols, rows, mines, games, queued_at}]
        "inprog": {},     # task_id -> {seed,model,cols,rows,mines,games,nonce,ip,name,claimed_at}
        "done": {},       # task_id -> {seed,model,cols,rows,mines,games,wins,ip,name,time,file,valid}
    }


def load_state():
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_state(st):
    # ★ 临时名必须每次唯一：共用一个 state.json.tmp 时，两个并发的写者会往同一个
    #   文件里各写一份完整文档，短的那份覆盖前缀、长的那位留个尾巴 → 扶正即坏档。
    fd, tmp = tempfile.mkstemp(dir=STATE_DIR, prefix=".state-", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(st, f, ensure_ascii=False, separators=(",", ":"))
        f.flush()
        os.fsync(f.fileno())
        # 权限要在 replace 之前落在临时文件上：state.json 里有每个客户端的 IP 与
        # 机器名，走 umask 会得到 0644 = 同机任何用户可读（文件头注释一直写的 0600）。
        os.fchmod(f.fileno(), 0o600)
    # root 跑 admin 写命令时不能把 state.json 改成 root 属主——服务以 cmsgate 运行，
    # root 属主的 600 文件会让服务读不到 state，进而卡死全部请求。
    if os.geteuid() == 0:
        try:
            d = os.stat(STATE_DIR)
            os.chown(tmp, d.st_uid, d.st_gid)
        except OSError:
            pass
    os.replace(tmp, STATE_FILE)


class StateLock:
    """flock 独占 + 读改写。with StateLock() as st: ... 改完自动落盘。

    readonly=True 用于只读命令（admin-status/export）：不落盘，root 跑也不碰属主。
    写锁里若处理器确认自己什么都没改（暂停期的空领取），调 _skip_save() 也能不落盘。
    __enter__ 里任何一步失败都必须把 _lock 还回来——锁是进程级 threading.Lock，
    忘了还，后续所有请求会堵死在 acquire 上（真发生过：root 属主 state.json →
    服务 EACCES → 锁不还 → 全服务楔死）。"""

    def __init__(self, readonly=False):
        self.readonly = readonly

    def __enter__(self):
        global _no_write
        _lock.acquire()
        self.fd = None
        self.merged = {}
        _no_write = False
        try:
            # flock 只要一个能持有引用的 fd，读句柄就够；锁的文件本身永不被 replace，
            # 所以这把锁对「后来打开同一路径的人」是真的互斥（详见 LOCK_FILE 那段注释）。
            self.fd = os.open(LOCK_FILE, os.O_RDONLY | os.O_CREAT, 0o600)
            import fcntl
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            self.st = load_state()
            # 每次取锁都从磁盘重读，所以节流期内的进度必须先盖回来：否则下一次写
            # 会把「磁盘上还没落的那几个 prog_at」当成最新状态覆盖上去，存活时钟倒退。
            self.merged = _merge_overlay(self.st)
        except Exception:
            if self.fd is not None:
                try:
                    import fcntl
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
                    os.close(self.fd)
                except OSError:
                    pass
            _lock.release()
            raise
        return self.st

    def __exit__(self, *exc):
        import fcntl
        try:
            if not exc[0] and not self.readonly and not _no_write:
                save_state(self.st)
                # 落盘成功了才作废内存里的挂起值；期间若有更新的进度挤进来
                # （值对象被换掉，identity 不同），那条继续留着等下次落盘。
                for tid, vals in self.merged.items():
                    if _prog_overlay.get(tid) is vals:
                        _prog_overlay.pop(tid)
        finally:
            fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            _lock.release()
        return False


def ensure_dirs():
    os.makedirs(STATE_DIR, exist_ok=True)
    os.makedirs(RESULTS_DIR, exist_ok=True)
    os.makedirs(CLIENT_DIR, exist_ok=True)
    if not os.path.exists(STATE_FILE):
        save_state(_default_state())
    if not os.path.exists(SECRET_FILE):
        with open(SECRET_FILE, "w", encoding="utf-8") as f:
            f.write(secrets.token_hex(32))
        os.chmod(SECRET_FILE, 0o600)


def _secret() -> bytes:
    with open(SECRET_FILE, "r", encoding="utf-8") as f:
        return bytes.fromhex(f.read().strip())


def nonce_for(task_id: str) -> str:
    """（已废弃的确定性方案）保留给历史测试引用；claim 现在发随机 nonce。"""
    return hmac.new(_secret(), task_id.encode(), hashlib.sha256).hexdigest()[:32]


# --------------------------------------------------------------------------
# 任务生成与校验
# --------------------------------------------------------------------------

def new_task_id(st, model: str, cols: int, rows: int, mines: int) -> str:
    seed = st["config"]["seed_next"]
    st["config"]["seed_next"] = seed + 1
    return f"{seed}-{model}-{cols}x{rows}x{mines}"


def _dup(st, seed: int, model: str, cols: int, rows: int, mines: int) -> bool:
    """同种子+同模式+同盘面是否已有任务（在跑/排队/有效结果）。
    task_id 新格式自带盘面（<seed>-<model>-CxRxM）；state 里残留的旧格式
    <seed>-<model> 条目按盘面字段二次核对——旧盘面不同不算重复。"""
    board = (cols, rows, mines)
    for tid in (f"{seed}-{model}-{cols}x{rows}x{mines}", f"{seed}-{model}"):
        if tid in st["inprog"] or any(q["task_id"] == tid for q in st["queue"]):
            return True
        r = st["done"].get(tid)
        if r and r.get("valid", True) and (r["cols"], r["rows"], r["mines"]) == board:
            return True
    return False


def sweep_expired(st, now=None):
    """lease 超时的 in-progress 任务重回队列（经典任务耗时长，阈值由 admin-lease 调）。
    存活时钟 = max(领取时刻, 最近进度上报时刻)：新客户端每 10s 报一次进度，
    只要还活着就永不被收走；lease 量的是「失联多久」，不是「总共跑了多久」。
    从未上报过进度的按 HEARTBEAT_GRACE_SEC 宽限收；空转满 HEARTBEAT_MISS_CAP 次
    仍无心跳的退回整份租约（老客户端不发进度，别把它们打进重发循环）。"""
    now = now or time.time()
    lease = st["config"].get("lease_sec", DEFAULT_LEASE_SEC)
    back = []
    for tid, t in st["inprog"].items():
        age = now - max(t["claimed_at"], t.get("prog_at", 0))
        limit = lease
        if "prog_at" not in t and t.get("nh", 0) < HEARTBEAT_MISS_CAP:
            limit = min(limit, HEARTBEAT_GRACE_SEC)
        if age > limit:
            back.append(tid)
    for tid in back:
        t = st["inprog"].pop(tid)
        t.pop("nonce", None)
        if "prog_at" not in t:
            t["nh"] = t.get("nh", 0) + 1
        t["queued_at"] = now
        t["cool_until"] = now + st["config"].get("cool_sec", DEFAULT_COOL_SEC)
        st["queue"].append(t)
    return back


# --------------------------------------------------------------------------
# HTTP 端点（claim / result / release / ping 四个，全部无敏感数据）
# --------------------------------------------------------------------------

def _ip(handler) -> str:
    ip = handler.client_address[0]
    if ip in ("127.0.0.1", "::1"):
        # TLS 反代（nginx 12712 → 本机 7120）后面，真实来源在 X-Real-IP：每 IP 并发
        # 上限、下载配额、done 记录全靠它，不认的话全舰队挤成一个回环身份。
        # 头只信回环对端——7120 直连的公网客户端伪造它不会被读到，等于没开这扇门。
        real = (handler.headers.get("X-Real-IP") or "").strip()
        if real:
            return real
    return ip


def _read_body(handler):
    n = int(handler.headers.get("Content-Length") or 0)
    if n > MAX_BODY:
        return None, "too large"
    if n <= 0:
        return b"", None
    return handler.rfile.read(n), None


def _json(handler, code, obj):
    body = json.dumps(obj, ensure_ascii=False).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def _raw(handler, code, body, ctype):
    """非 JSON 响应（自动更新的 manifest/二进制下载）。"""
    handler.send_response(code)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def handle_claim(handler, payload):
    try:
        data = json.loads(payload.decode("utf-8")) if payload else {}
    except Exception:
        return _json(handler, 400, {"error": "bad json"})
    name = str(data.get("name", ""))[:64]
    osname = str(data.get("os", ""))[:40]
    # 领取时就带指纹 → 进行中表能按版本聚合「谁正在跑哪版」；老客户端不带=空串。
    # 只作展示与归因，不参与任何校验判定。
    solver_ver = str(data.get("solver_ver", ""))[:16]
    # 客户端自己的身份（这份程序字节的短哈希）。两个身份各管一半：更新是逐文件换的，
    # 「新 py + 老 solver.exe」这种半更新只看 solver_ver 完全隐形（Windows 上的常态）。
    client_ver = str(data.get("client_ver", ""))[:16]
    ip = _ip(handler)
    with StateLock() as st:
        # 收走过期租约=改了状态，这一条决定了后面两个「不干活直接回」的分支能不能免落盘
        moved = sweep_expired(st)
        cfg = st["config"]
        ph = pomo_phase(cfg)
        if cfg.get("paused") or (ph and ph["in_rest"]):
            # 暂停期客户端还在按节奏轮询领取（实测 0.3 次/秒）：回答「没活给你」
            # 本不该重写整份状态 —— /progress 节流之后，这台机的写盘大头就换成了它。
            # 番茄钟的休息相位走同一条出口：只是「现在不发活」，不新增一次落盘。
            _skip_save(not moved)
            out = {"paused": True,
                   "reason": "manual" if cfg.get("paused") else "pomodoro",
                   # 手动暂停优先于番茄钟显示：管理员按下暂停时，别报「休息中还剩 X 分」
                   "rest_left": round(ph["left"], 1) if (ph and not cfg.get("paused")) else None}
            return _json(handler, 200, out)
        if sum(1 for t in st["inprog"].values() if t["ip"] == ip) >= cfg.get("max_ip_inprog", MAX_IP_INPROG):
            _skip_save(not moved)
            return _json(handler, 429, {"error": "too many in-progress tasks from this IP"})
        if st["queue"]:
            # 冷却中的任务跳过（刚被 kick/租约收回的，管理员可能正要删）；
            # 全在冷却就先发默认流，冷却一过队列任务照常优先
            now = time.time()
            qi = next((i for i, q in enumerate(st["queue"])
                       if q.get("cool_until", 0) <= now), None)
            if qi is not None:
                t = st["queue"].pop(qi)
            else:
                t = None
        else:
            t = None
        if t is None:
            d = cfg["default"]
            # 跳过「同种子+同模式+同盘面已有有效结果/在跑/排队」的种子号：
            # 全是 dict 查找每步 O(1)，只连续跳过已用掉的那段
            seed = cfg["seed_next"]
            while _dup(st, seed, d["model"], d["cols"], d["rows"], d["mines"]):
                seed += 1
            cfg["seed_next"] = seed + 1
            tid = f"{seed}-{d['model']}-{d['cols']}x{d['rows']}x{d['mines']}"
            t = {"task_id": tid, "seed": seed, "model": d["model"],
                 "cols": d["cols"], "rows": d["rows"], "mines": d["mines"], "games": d["games"]}
        tid = t["task_id"]
        # nonce 每次领取随机生成：任务被收走重发后，旧持有者的上报全部对不上号——
        # 「超时一律拒收」的裁决靠它落实（确定性 HMAC nonce 会让旧结果冒新名额）
        st["inprog"][tid] = {"task_id": tid, "seed": t["seed"], "model": t["model"],
                             "cols": t["cols"], "rows": t["rows"], "mines": t["mines"],
                             "games": t["games"], "nonce": secrets.token_hex(16), "ip": ip,
                             "name": name, "os": osname, "solver_ver": solver_ver,
                             "client_ver": client_ver, "nh": t.get("nh", 0),
                             "claimed_at": time.time()}
    return _json(handler, 200, {"task_id": tid, "nonce": st["inprog"][tid]["nonce"] if tid in st["inprog"] else secrets.token_hex(16),
                                "seed": t["seed"], "model": t["model"], "cols": t["cols"],
                                "rows": t["rows"], "mines": t["mines"], "games": t["games"],
                                # 任务随附的散热相位：客户端换算到自己机器时钟后转给 solver，
                                # 正在跑的这单就会在两局之间睡到相位结束（不发新任务是另一层）
                                "pomo": pomo_wire(cfg)})


def handle_release(handler, payload):
    """客户端放弃当前任务（第二次 Ctrl+C）：nonce 对上就立刻回队列头，
    并发名额当即释放，不用等 lease。.partial 局数不收（服务器无法核验）。"""
    try:
        data = json.loads(payload.decode("utf-8")) if payload else {}
    except Exception:
        return _json(handler, 400, {"error": "bad json"})
    tid = str(data.get("task_id", ""))
    given = str(data.get("nonce", ""))
    with StateLock() as st:
        sweep_expired(st)
        t = st["inprog"].get(tid)
        if t is None:
            return _json(handler, 404, {"error": "task not in progress"})
        if not hmac.compare_digest(given, str(t.get("nonce", ""))):
            return _json(handler, 403, {"error": "bad nonce"})
        st["inprog"].pop(tid)
        t.pop("nonce", None)
        t["queued_at"] = time.time()
        st["queue"].insert(0, t)
    return _json(handler, 200, {"released": tid, "requeued": True})


def validate_records(records, games):
    """逐局记录 schema 校验。返回 None 或错误说明。"""
    if not isinstance(records, list) or len(records) != games:
        return "records 数量不符"
    int_keys = ("g", "win", "guess", "mid", "end", "trap", "zero", "flagpath")
    for i, r in enumerate(records):
        if not isinstance(r, dict) or set(r.keys()) != RECORD_KEYS:
            return f"第{i}局字段不符"
        for k in int_keys:
            v = r[k]
            if not isinstance(v, int) or isinstance(v, bool) or v < 0:
                return f"第{i}局 {k} 非法"
        if not isinstance(r["sec"], (int, float)) or r["sec"] < 0 or r["sec"] > 3600:
            return f"第{i}局 sec 非法"
        if r["g"] != i:
            return f"第{i}局 g 序号错"
        if r["win"] > 1 or r["zero"] > 1:
            return f"第{i}局 win/zero 非布尔"
        if r["guess"] != r["mid"] + r["end"]:
            return f"第{i}局 猜次与中残局之和不一致"
    return None


def handle_progress(handler, payload):
    """进行中进度上报（best-effort，客户端失败静默）：nonce 对上就记 x/y + eta。
    进度既是 lease 的存活心跳（sweep 看 prog_at）也是看板上的那行数，所以「下个
    请求必须还能看见它」这条不能破 —— 但看见不等于每次都要全量重写磁盘：最新值
    先进 _prog_overlay，StateLock 每次取锁都把它合并回来（本进程等价于已落盘），
    落盘本身按 PROG_FLUSH_SEC 节流；跨进程的 admin-* 读者顶多看到旧 5 秒的版本。"""
    global _prog_last_flush
    try:
        data = json.loads(payload.decode("utf-8")) if payload else {}
    except Exception:
        return _json(handler, 400, {"error": "bad json"})
    tid, nonce = data.get("task_id"), data.get("nonce")
    done, eta = data.get("done"), data.get("eta_sec")
    if not isinstance(tid, str) or not isinstance(nonce, str):
        return _json(handler, 400, {"error": "missing task_id/nonce"})
    if not isinstance(done, int) or isinstance(done, bool) or not (0 <= done <= 20000):
        return _json(handler, 400, {"error": "bad done"})
    if eta is not None and (not isinstance(eta, (int, float)) or isinstance(eta, bool)
                            or not (0 <= eta <= 7 * 86400)):
        return _json(handler, 400, {"error": "bad eta_sec"})
    now = time.time()
    with StateLock(readonly=True) as st:
        t = st["inprog"].get(tid)
        if t is None:
            return _json(handler, 404, {"error": "task not in progress"})
        if not hmac.compare_digest(nonce, t["nonce"]):
            return _json(handler, 403, {"error": "bad nonce"})
        _prog_overlay[tid] = {"prog": {"done": min(done, t["games"]), "eta_sec": eta, "at": now},
                              "prog_at": now}   # 刷新存活时钟：活着就永不被 lease 收走
        due = now - _prog_last_flush >= PROG_FLUSH_SEC
        if due:
            _prog_last_flush = now
    # 到点的那次落盘必须出了锁再做：_lock 不可重入，with 里再开写锁是自己锁死自己
    if due:
        with StateLock():
            pass
    return _json(handler, 200, {"ok": True})


def handle_result(handler, payload):
    if payload is None:
        return _json(handler, 413, {"error": "too large"})
    try:
        data = json.loads(payload.decode("utf-8"))
    except Exception:
        return _json(handler, 400, {"error": "bad json"})
    if not isinstance(data, dict):
        return _json(handler, 400, {"error": "bad json"})
    tid, nonce = data.get("task_id"), data.get("nonce")
    if not isinstance(tid, str) or not isinstance(nonce, str):
        return _json(handler, 400, {"error": "missing task_id/nonce"})
    ip, name = _ip(handler), str(data.get("name", ""))[:64]
    osname = str(data.get("os", ""))[:40]
    # 求解器版本指纹（客户端编译期烙进 solver 的源码哈希前 8 位，见 CMakeLists）。
    # 老客户端不带此字段=空串——混跑期空值本身就是「旧包」标记。
    solver_ver = str(data.get("solver_ver", ""))[:16]
    client_ver = str(data.get("client_ver", ""))[:16]   # 客户端程序字节的哈希，同上口径
    with StateLock() as st:
        t = st["inprog"].get(tid)
        if t is None:
            return _json(handler, 409 if tid in st["done"] else 403, {"error": "unknown or done task"})
        if not hmac.compare_digest(nonce, t["nonce"]):
            return _json(handler, 403, {"error": "bad nonce"})
        # 超时裁决（用户定稿）：lease 到期一律不收——任务已（或即将）回队重发，
        # 迟到的结果没有效力。410 只在「过期但还没被 sweep 回队」的窗口里出现。
        # 存活时钟与 sweep 同口径：进度上报刷新，活着的客户端不会被误判超时。
        if time.time() - max(t["claimed_at"], t.get("prog_at", 0)) > st["config"].get("lease_sec", DEFAULT_LEASE_SEC):
            return _json(handler, 410, {"error": "lease expired"})
        err = validate_records(data.get("records"), t["games"])
        if err:
            return _json(handler, 400, {"error": err})
        records = data["records"]
        wins = sum(r["win"] for r in records)
        rec = {"seed": t["seed"], "model": t["model"], "cols": t["cols"], "rows": t["rows"],
               "mines": t["mines"], "games": t["games"], "wins": wins,
               "zeroGuessWins": sum(r["zero"] for r in records),
               "guesses": sum(r["guess"] for r in records),
               "guessTrap": sum(r["trap"] for r in records),
               "ip": t["ip"], "name": name, "os": osname, "claimed_at": t["claimed_at"],
               "solver_ver": solver_ver, "client_ver": client_ver,
               "time": time.time(), "valid": True, "file": f"results/{tid}.json.gz"}
        blob = json.dumps({"task": {k: t[k] for k in ("seed", "model", "cols", "rows", "mines", "games")},
                           "client": {"ip": t["ip"], "name": name, "os": osname,
                                      "solver_ver": solver_ver, "client_ver": client_ver},
                           "claimed_at": t["claimed_at"], "done_at": rec["time"],
                           "records": records}, ensure_ascii=False).encode()
        tmp = os.path.join(RESULTS_DIR, f"{tid}.json.gz.tmp")
        with gzip.open(tmp, "wb", compresslevel=9) as f:
            f.write(blob)
        os.replace(tmp, os.path.join(RESULTS_DIR, f"{tid}.json.gz"))
        st["inprog"].pop(tid)
        st["done"][tid] = rec
    return _json(handler, 200, {"ok": True, "wins": wins, "games": t["games"]})


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "cmsdist/1"

    def log_message(self, fmt, *args):  # journald 默认收 stdout；错误访问也留痕但不打 payload
        sys.stderr.write("%s - %s\n" % (self.client_address[0], fmt % args))

    def do_GET(self):
        if self.path == "/ping":
            try:
                # ★ 只读锁：这条是每 2 分钟一次的存活探针，拿可写锁等于为了回答
                #   "你还活着吗" 把整份状态重新序列化+落盘一遍（一天 ~720 次全量重写，
                #   白烧这台 2 核机器的 CPU，还平白多出 720 次撞写竞态的机会）。
                #   sweep 在这里只为把显示口径算准，不落盘；真正收租约由 /claim 那次写做。
                with StateLock(readonly=True) as st:
                    sweep_expired(st)
                    info = {"ok": True, "paused": st["config"].get("paused", False),
                            "queue": len(st["queue"]), "inprog": len(st["inprog"]),
                            "done": len(st["done"])}
            except Exception as e:
                return _json(self, 500, {"ok": False, "error": "state unreadable"})
            return _json(self, 200, info)
        if self.path == "/client/manifest":
            # 自动更新清单（Ed25519 签名），打包脚本上传。没有 = 客户端不更新。
            p = os.path.join(CLIENT_DIR, "manifest.json")
            try:
                with open(p, "rb") as f:
                    return _raw(self, 200, f.read(), "application/json; charset=utf-8")
            except OSError:
                return _json(self, 404, {"error": "no manifest"})
        if self.path.startswith("/client/file/"):
            # 只允许白名单字符，杜绝路径穿越；内容是打包脚本放进来的二进制
            name = self.path[len("/client/file/"):]
            if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", name) or ".." in name:
                return _json(self, 404, {"error": "not found"})
            p = os.path.join(CLIENT_DIR, name)
            if os.path.dirname(os.path.realpath(p)) != os.path.realpath(CLIENT_DIR):
                return _json(self, 404, {"error": "not found"})
            # 配额在「打开 8MB 文件」之前判：被拒的请求连读盘都不该有
            allowed, wait = _dl_allow(_ip(self))
            if not allowed:
                sys.stderr.write("%s - 更新包下载超限（每 IP 每小时 %d 次）：%s\n"
                                 % (_ip(self), DL_LIMIT_PER_HOUR, name))
                return _json(self, 429, {"error": f"更新包下载已达上限（每 IP 每小时 "
                                                  f"{DL_LIMIT_PER_HOUR} 次，约 {wait} 秒后恢复）："
                                                  "反复重下同一个包说明新版没换上——客户端目录多半"
                                                  "写不落地（网盘/同步盘）或没有写权限，请把整个"
                                                  "文件夹移到本机本地磁盘后重开跑分窗口"})
            try:
                with open(p, "rb") as f:
                    blob = f.read()
            except OSError:
                return _json(self, 404, {"error": "not found"})
            _dl_record(_ip(self))
            return _raw(self, 200, blob, "application/octet-stream")
        return _json(self, 404, {"error": "not found"})

    def do_POST(self):
        payload, err = _read_body(self)
        if err:
            return _json(self, 413, {"error": err})
        if self.path == "/claim":
            return handle_claim(self, payload)
        if self.path == "/result":
            return handle_result(self, payload)
        if self.path == "/release":
            return handle_release(self, payload)
        if self.path == "/progress":
            return handle_progress(self, payload)
        return _json(self, 404, {"error": "not found"})


def cmd_serve(argv):
    host = argv[0] if argv else "0.0.0.0"
    port = int(argv[1]) if len(argv) > 1 else 7120
    ensure_dirs()
    srv = ThreadingHTTPServer((host, port), Handler)
    sys.stderr.write(f"cmsdist serving on {host}:{port} (state={STATE_DIR})\n")
    srv.serve_forever()


# --------------------------------------------------------------------------
# 管理命令（root SSH 调用；危险操作要管理口令，scrypt 与 cms 共用同一份哈希）
# --------------------------------------------------------------------------

def _b64d(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def verify_admin_pw(pw: str) -> bool:
    """校验 /var/lib/cmsgate/gateconfig.json 的 admin 块（与 cms 共用同一份口令）。"""
    try:
        with open(GATECONFIG, "r", encoding="utf-8") as f:
            admin = json.load(f).get("admin") or {}
        salt, want = _b64d(admin["salt"]), _b64d(admin["hash"])
        dk = hashlib.scrypt(pw.encode("utf-8"), salt=salt, n=KDF_N, r=KDF_R, p=KDF_P,
                            dklen=KDF_DKLEN, maxmem=64 * 1024 * 1024)
        return hmac.compare_digest(dk, want)
    except Exception:
        die("管理口令校验失败（读不到 gateconfig 或解释器无 scrypt）", 2)


def require_pw():
    pw = sys.stdin.readline().rstrip("\n")
    if not pw or not verify_admin_pw(pw):
        die("管理口令不正确，操作未执行。", 3)


def parse_board(args, default):
    """args 里若有 CxRxM 则取之，否则用当前默认；返回 (cols,rows,mines, 剩余args)。"""
    if args and BOARD_RE.match(args[0]):
        c, r, m = map(int, BOARD_RE.match(args[0]).groups())
        if not (c >= 2 and r >= 2 and 0 < m < c * r):
            die(f"盘面规格非法：{args[0]}")
        return c, r, m, args[1:]
    d = default
    return d["cols"], d["rows"], d["mines"], args


def parse_model(args, cur):
    if args and args[0] in ("complex", "classic"):
        return args[0], args[1:]
    return cur, args


def cmd_admin_default(argv):
    # 口令校验统一在 main()（needs_pw），这里不再读 stdin——否则吃掉第二行必失败
    with StateLock() as st:
        d = st["config"]["default"]
        model, rest = parse_model(argv, d["model"])
        cols, rows, mines, rest = parse_board(rest, d)
        games = int(rest[0]) if rest else d["games"]
        if not (1 <= games <= 20000):
            die("games 超出范围（1..20000）")
        st["config"]["default"] = {"model": model, "cols": cols, "rows": rows, "mines": mines, "games": games}
        print(json.dumps(st["config"]["default"], ensure_ascii=False))


def cmd_admin_insert(argv):
    if len(argv) < 2:
        die("用法：admin-insert <n> <complex|classic> [CxRxM] [games] [起种子]")
    n = int(argv[0])
    with StateLock() as st:
        d = st["config"]["default"]
        model, rest = parse_model(argv[1:], d["model"])
        cols, rows, mines, rest = parse_board(rest, d)
        games = int(rest[0]) if rest else d["games"]
        seed = int(rest[1]) if len(rest) > 1 else None
        now = time.time()
        made = []
        for i in range(n):
            if seed is not None:
                s = seed + i
                if s >= st["config"]["seed_next"]:
                    st["config"]["seed_next"] = s + 1
            else:
                s = st["config"]["seed_next"]
                st["config"]["seed_next"] = s + 1
            tid = f"{s}-{model}-{cols}x{rows}x{mines}"
            if _dup(st, s, model, cols, rows, mines):
                continue  # 同种子+同模式+同盘面已有任务；不同盘面的同种子照发
            st["queue"].append({"task_id": tid, "seed": s, "model": model, "cols": cols,
                                "rows": rows, "mines": mines, "games": games, "queued_at": now})
            made.append(tid)
        # 区间里有已做过的种子时是「跳过续插」：回执里把实际入队的连续段报出来，
        # 让界面能说清「砍成了几段、跳了几个」，别让人对不上数量以为丢了任务
        segs = []
        for t in made:
            s = int(t.split("-")[0])
            if segs and s == segs[-1][1] + 1:
                segs[-1][1] = s
            else:
                segs.append([s, s])
        print(json.dumps({"queued": made, "segs": segs, "skipped": n - len(made)},
                         ensure_ascii=False))


def _inprog_view(st):
    """admin-status / admin-lite 共用的「进行中」视图，别各写一份。"""
    return [{"task_id": k, "ip": v["ip"], "name": v["name"], "os": v.get("os", ""),
             "solver_ver": v.get("solver_ver", ""), "client_ver": v.get("client_ver", ""),
             "model": v["model"], "seed": v["seed"],
             "cols": v["cols"], "rows": v["rows"], "mines": v["mines"],
             "games": v["games"],
             "prog": v.get("prog"),
             "claimed_min_ago": round((time.time() - v["claimed_at"]) / 60, 1)}
            for k, v in st["inprog"].items()]


# done 记录里 ctlui 一个都不读的字段：file 是结果落盘路径（38B/条），
# claimed_at / seed 表格里另有出处，zeroGuessWins / guesses / guessTrap 是分析用指标。
# 1877 条 × 这些字段 ≈ 全量明细的一半体积，所以看板只投影要用的那些。
DONE_UI_KEYS = ("model", "cols", "rows", "mines", "games", "wins",
                "ip", "name", "os", "solver_ver", "client_ver", "time", "valid")


def _done_ui(r):
    return {k: r.get(k) for k in DONE_UI_KEYS}


def _agg_spec(st):
    """全量有效结果按 模式×规格 精确聚合。ctlui 的合计卡要的是这个口径；
    明细不发过去（见 cmd_admin_lite），聚合就得在这儿算完。"""
    agg = {}
    for r in st["done"].values():
        if not r.get("valid", True):
            continue
        key = (r["model"], r["cols"], r["rows"], r["mines"])
        a = agg.get(key)
        if a is None:
            a = agg[key] = {"model": key[0], "cols": key[1], "rows": key[2],
                            "mines": key[3], "tasks": 0, "games": 0, "wins": 0}
        a["tasks"] += 1
        a["games"] += r["games"]
        a["wins"] += r["wins"]
    return list(agg.values())


def cmd_admin_lite(argv):
    """ctlui 每 15 秒刷一次的那一跳——只回看板要的东西。

    实测账（2026-11-02）：admin-status 全量 741KB / gzip 70KB，其中 done 明细占 92%；
    这台 ECS 的公网链路只有 15~40KB/s（还要和在线客户端分），于是传输段 1.7~5.0s，
    而握手 0.27s、远端生成 0.4s 全程稳定。慢的是字节数，不是服务器。
    这条只回最近 N 条结果 + 全量规格聚合，整包 ~16KB / gzip ~1KB。
    完整历史由 ctlui 的「历史记录」弹窗点开时经 admin-history 现拉。"""
    n = 30
    if argv and str(argv[0]).isdigit():
        n = max(1, min(500, int(argv[0])))
    with StateLock(readonly=True) as st:
        sweep_expired(st)
        recent = sorted(st["done"].items(),
                        key=lambda kv: kv[1].get("time", 0), reverse=True)[:n]
        out = {"config": st["config"], "queue": st["queue"], "inprog": _inprog_view(st),
               "done_recent": {k: _done_ui(v) for k, v in recent},
               "done_total": len(st["done"]), "agg_spec": _agg_spec(st),
               # ctlui 的番茄钟卡片：开关 + 时长 + 「现在在连算还是在歇、还剩多久」
               "pomo": pomo_wire(st["config"])}
    print(json.dumps(out, ensure_ascii=False))


def cmd_admin_history(_argv):
    """历史弹窗专用：全量 done，但只投影 UI 要用的字段（约省一半）。
    筛选/排序/分页都在浏览器里做，所以这里给的是全集，不分页。"""
    with StateLock(readonly=True) as st:
        sweep_expired(st)
        out = {"done": {k: _done_ui(v) for k, v in st["done"].items()},
               "done_total": len(st["done"])}
    print(json.dumps(out, ensure_ascii=False))


def cmd_admin_status(_argv):
    with StateLock(readonly=True) as st:  # 只读：root 跑也不改写 state.json 属主
        sweep_expired(st)
        agg = {}
        for tid, r in st["done"].items():
            if not r.get("valid", True):
                continue
            a = agg.setdefault(r["model"], {"tasks": 0, "games": 0, "wins": 0})
            a["tasks"] += 1
            a["games"] += r["games"]
            a["wins"] += r["wins"]
        out = {"config": st["config"], "queue": st["queue"],
               "inprog": _inprog_view(st),
               "done": st["done"], "aggregate": agg, "pomo": pomo_wire(st["config"])}
    print(json.dumps(out, ensure_ascii=False))


def cmd_admin_export(_argv):
    """导出全部（含作废标记）逐局记录到 stdout——统计脚本消费。

    ⚠ 高危口子（2026-11-05 线上 OOM 事故，见 docs 红线）：整份结果在内存拼完才发回，
    1400 万局 ≈ 上 GB。只许对量小的本地 state 跑；线上逐局级统计一律走 cmd_admin_agg。"""
    out = []
    for tid, r in sorted(st_done_items(), key=lambda kv: kv[1]["time"]):
        path = os.path.join(STATE_DIR, r["file"])
        try:
            with gzip.open(path, "rb") as f:
                out.append({"task_id": tid, **r, "records": json.load(f)["records"]})
        except FileNotFoundError:
            continue
    print(json.dumps(out, ensure_ascii=False))


#: admin-agg 的猜雷次数直方图上限：超过的并入溢出桶（索引 cap+1）。
AGG_GUESS_CAP = 99


def cmd_admin_agg(argv):
    """逐局级统计的**流式**聚合：一次只解压一个任务的 blob（≤1MB），累计的只有
    分桶计数，回执 KB 级——admin-export 那种全量内存拼在这台 2 核小内存机上会 OOM
    （2026-11-05 事故实录）。逐局级分析一律走这里，别再碰 export。

    用法：admin-agg <complex|classic> <cols> <rows> <mines>
    输出：按「猜雷次数」分桶的直方图（每桶 games/wins/陷阱猜局/无猜胜/耗时和）
          + 任务级合计。桶索引 = 次数（0..99），99+ 并入溢出桶 100。"""
    if len(argv) != 4 or argv[0] not in ("complex", "classic") \
            or not all(x.isdigit() for x in argv[1:]):
        die("用法：admin-agg <complex|classic> <cols> <rows> <mines>")
    spec = (argv[0], int(argv[1]), int(argv[2]), int(argv[3]))
    st = load_state()
    hist = {}          # 桶索引 -> [games, wins, trap局, zero局, sec和]；只留非空桶
    games = wins = trap_games = trap_total = zero_games = guesses = tasks = 0
    sec_sum = 0.0
    for tid, rec in st["done"].items():
        if not rec.get("valid", True) or rec.get("file") is None:
            continue
        if (rec["model"], rec["cols"], rec["rows"], rec["mines"]) != spec:
            continue
        try:
            with gzip.open(os.path.join(STATE_DIR, rec["file"]), "rb") as f:
                records = json.load(f)["records"]
        except (FileNotFoundError, KeyError, ValueError):
            continue     # blob 缺了/坏了跳过，不 500 掉整个统计
        tasks += 1
        for g in records:
            i = g["guess"] if g["guess"] <= AGG_GUESS_CAP else AGG_GUESS_CAP + 1
            b = hist.setdefault(i, [0, 0, 0, 0, 0.0])
            b[0] += 1
            b[1] += g["win"]
            b[2] += 1 if g["trap"] > 0 else 0
            b[3] += g["zero"]
            b[4] += g["sec"]
            games += 1
            wins += g["win"]
            trap_total += g["trap"]
            trap_games += 1 if g["trap"] > 0 else 0
            zero_games += g["zero"]
            guesses += g["guess"]
            sec_sum += g["sec"]
    print(json.dumps({
        "model": spec[0], "cols": spec[1], "rows": spec[2], "mines": spec[3],
        "tasks": tasks, "games": games, "wins": wins,
        "trap_games": trap_games, "trap_total": trap_total,
        "zero_games": zero_games, "guesses": guesses,
        "sec_mean": round(sec_sum / games, 3) if games else 0.0,
        "hist": {str(i): {"games": b[0], "wins": b[1], "trap": b[2],
                          "zero": b[3], "sec": round(b[4], 1)}
                 for i, b in sorted(hist.items())},
    }, ensure_ascii=False))


def st_done_items():
    st = load_state()
    return list(st["done"].items())


def pomo_set_spec(p, spec):
    """校验 "<连算>/<休息>" 并写进 p（含 anchor 重拨）；读不懂 die。
    与 ctlui 前端、dist_client 的 pomo_spec 是同一把尺，口径不许分叉。"""
    parts = (spec or "").split("/")
    if len(parts) != 2:
        die(f"「{spec}」要写成 <连算>/<休息> 两段，如 25m/5m、1h30m/10m")
    w, r = pomo_dur(parts[0]), pomo_dur(parts[1])
    if w is None or r is None:
        die(f"读不懂「{spec}」：每段可带 h/m/s，裸数字按分钟")
    if (w > 0) != (r > 0) or w <= 0 or r <= 0:
        die(f"两段得都是正秒数且同开同关（连算 {w}s / 休息 {r}s）——关掉请用 admin-pomo off，别写成 0")
    if w + r < 60:
        die(f"一轮 {w + r}s 太短（下限 60s）：歇得太碎，交结果的开销比算得还多")
    p["work_sec"], p["rest_sec"] = w, r
    p["anchor"] = time.time()


def cmd_admin_pomo(argv):
    """散热番茄钟：admin-pomo on [连算>/<休息>] | off | set <连算>/<休息> | status。
    `on` 和 `set` 都把 anchor 拨到此刻 —— 不重拨的话 (now-anchor) % 周期 会一步跨进休息段，
    管理员刚按下「开」就看到全舰队停摆，像在惩罚自己。
    `off` 只影响之后领的任务：在跑的那单按它领到的时刻表走完（硬杀=整任务作废，不划算）。"""
    if not argv or argv[0] not in ("on", "off", "set", "status"):
        die("用法：admin-pomo on [25m/5m] | off | set <连算>/<休息>（如 1h30m/10m）| status")
    act = argv[0]
    if act == "status":
        with StateLock(readonly=True) as st:
            print(json.dumps({"pomo": pomo_wire(st["config"])}, ensure_ascii=False))
        return
    with StateLock() as st:
        p = dict(POMO_DEFAULT)
        p.update(st["config"].get("pomo") or {})
        if act == "on":
            # 带时长时一并写：ctlui 的「开」是一次按下，不该先让人改再让人开（两次口令两次往返）
            if len(argv) > 1:
                pomo_set_spec(p, argv[1])
            elif int(p["work_sec"]) <= 0 or int(p["rest_sec"]) <= 0:
                die(f"番茄钟时长不合法（连算 {p['work_sec']}s / 休息 {p['rest_sec']}s）——"
                    f"先 admin-pomo set <连算>/<休息> 写好再开")
            p["on"] = True
            p["anchor"] = time.time()
        elif act == "off":
            p["on"] = False
        else:
            if len(argv) < 2:
                die("set 要两段时长：<连算>/<休息>（如 25m/5m）")
            pomo_set_spec(p, argv[1])
        st["config"]["pomo"] = p
        print(json.dumps({"ok": True, "pomo": pomo_wire(st["config"], pomo_phase(st["config"]))},
                         ensure_ascii=False))


def _set_pause(v):
    with StateLock() as st:
        st["config"]["paused"] = v
        print(json.dumps({"paused": v}))


def cmd_admin_clear_queue(_argv):
    with StateLock() as st:
        n = len(st["queue"])
        st["queue"] = []
        print(json.dumps({"cleared": n}))


def cmd_admin_lease(argv):
    if not argv:
        die("用法：admin-lease <Xh> [Ym]   例：admin-lease 2h 0m")
    m = re.match(r"^(\d+)h$", argv[0])
    hours = int(m.group(1)) if m else 0
    mins = 0
    if len(argv) > 1:
        m = re.match(r"^(\d+)m$", argv[1])
        if not m:
            die(f"lease 参数非法：{argv[1]}（应为 Xh Ym）")
        mins = int(m.group(1))
    sec = hours * 3600 + mins * 60
    if not (60 <= sec <= 7 * 24 * 3600):
        die("lease 超出范围（1 分钟 .. 7 天）")
    with StateLock() as st:
        st["config"]["lease_sec"] = sec
        print(json.dumps({"lease_sec": sec}))


def cmd_admin_invalidate(argv):
    if len(argv) != 1:
        die("用法：admin-invalidate <task_id | ip:ADDR | name:NAME>")
    key = argv[0]
    with StateLock() as st:
        if key.startswith("ip:"):
            v = key[3:]
            hit = [tid for tid, r in st["done"].items() if r["ip"] == v]
        elif key.startswith("name:"):
            v = key[4:]
            hit = [tid for tid, r in st["done"].items() if r.get("name") == v]
        elif key in st["done"]:
            hit = [key]
        else:
            die(f"没找到匹配的结果：{key}")
        for tid in hit:
            st["done"][tid]["valid"] = False
        print(json.dumps({"invalidated": hit}))


def cmd_admin_seed(argv):
    """改下一个种子。改小可能撞上已有结果——claim 侧会自动跳过有效的种子+规模组合。"""
    if len(argv) != 1 or not argv[0].isdigit():
        die("用法：admin-seed <下一个种子>   例：admin-seed 20261301")
    n = int(argv[0])
    if not (1 <= n <= 9_999_999_999):
        die(f"种子超出范围：{n}")
    with StateLock() as st:
        st["config"]["seed_next"] = n
        print(json.dumps({"seed_next": n}))


def cmd_admin_limit(argv):
    """改每 IP 同时领用上限（>6 由管理界面另行确认）。"""
    if len(argv) != 1 or not argv[0].isdigit():
        die("用法：admin-limit <每IP并发上限>")
    n = int(argv[0])
    if not (1 <= n <= 50):
        die(f"每 IP 并发上限超出范围（1..50）：{n}")
    with StateLock() as st:
        st["config"]["max_ip_inprog"] = n
        print(json.dumps({"max_ip_inprog": n}))


def cmd_admin_cool(argv):
    """被 kick/租约收回的任务重入队后的冷却期（0 = 关掉冷却，收回即领）。"""
    units = {"d": 86400, "h": 3600, "m": 60, "s": 1}
    if not argv or len(argv) > 4:
        die("用法：admin-cool <Dd> [Hh] [Mm] [Ss]   例：admin-cool 1m / 0d 0h 1m 30s")
    sec = 0
    for a in argv:
        m = re.match(r"^(\d+)([dhms])$", a)
        if not m:
            die(f"冷却参数非法：{a}（应为 数字+d/h/m/s）")
        sec += int(m.group(1)) * units[m.group(2)]
    if not (0 <= sec <= 7 * 24 * 3600):
        die("冷却超出范围（0 .. 7 天）")
    with StateLock() as st:
        st["config"]["cool_sec"] = sec
        print(json.dumps({"cool_sec": sec}))


def cmd_admin_kick(argv):
    """剔除非线性会话：把指定任务强制收回队列重发（结果没交的种子由健康客户端重算）。
    被剔除客户端手里的 nonce 已随 inprog 条目一起销毁，它跑完交上来只会吃 403。"""
    if not argv:
        die("用法：admin-kick <task_id> [...]")
    with StateLock() as st:
        kicked = []
        now = time.time()
        for tid in argv[:64]:
            t = st["inprog"].pop(tid, None)
            if t:
                t.pop("nonce", None)
                t["queued_at"] = now
                t["cool_until"] = now + st["config"].get("cool_sec", DEFAULT_COOL_SEC)
                st["queue"].append(t)
                kicked.append(tid)
        print(json.dumps({"kicked": kicked}, ensure_ascii=False))


def cmd_admin_dequeue(argv):
    """把队列里的任务直接删掉（kick/插入错了用）：只删还在排队的，
    在跑/已完成的分别走 admin-kick 和 admin-invalidate。"""
    if not argv:
        die("用法：admin-dequeue <task_id> [...]")
    with StateLock() as st:
        removed, missing = [], list(argv[:64])
        keep = []
        for q in st["queue"]:
            if q["task_id"] in missing:
                removed.append(q["task_id"])
                missing.remove(q["task_id"])
            else:
                keep.append(q)
        st["queue"] = keep
        print(json.dumps({"removed": removed, "not_in_queue": missing}, ensure_ascii=False))


def cmd_admin_drop(argv):
    """把进行中的任务直接删除（不回队列）：种子彻底蒸发。
    与 kick 相反——kick 是收回重发（种子由健康客户端重算），drop 是连种子
    一起扔（插错的脏任务/已无价值的目标）。nonce 随 inprog 条目一起销毁：
    新客户端心跳 404 自动放弃换下一个，旧客户端跑完交结果吃 403 作废。"""
    if not argv:
        die("用法：admin-drop <task_id> [...]")
    with StateLock() as st:
        dropped, not_in = [], list(argv[:64])
        for tid in list(not_in):
            if st["inprog"].pop(tid, None):
                dropped.append(tid)
                not_in.remove(tid)
        print(json.dumps({"dropped": dropped, "not_in_progress": not_in}, ensure_ascii=False))


def main():
    admin_cmds = {
        "admin-status": (cmd_admin_status, False),
        "admin-export": (cmd_admin_export, False),
        # 这两条也是只读视图，和 admin-status 同一口径（数据同源、都只能从 SSH root 进来，
        # 7120 已收回环，公网只有 12712 TLS 一条路）；口令是给「改状态的操作」设的，读不新增暴露面。
        "admin-lite": (cmd_admin_lite, False),
        "admin-history": (cmd_admin_history, False),
        # 只读聚合：一次一个 blob、只回分桶计数（admin-export 全量内存拼会 OOM，见其 docstring）
        "admin-agg": (cmd_admin_agg, False),
        # 其余全是写操作：一律要管理口令（2026-10-31 裁决：所有操作都要口令）
        "admin-default": (cmd_admin_default, True),
        "admin-insert": (cmd_admin_insert, True),
        "admin-pause": (lambda a: _set_pause(True), True),
        "admin-resume": (lambda a: _set_pause(False), True),
        "admin-pomo": (cmd_admin_pomo, True),
        "admin-clear-queue": (cmd_admin_clear_queue, True),
        "admin-lease": (cmd_admin_lease, True),
        "admin-seed": (cmd_admin_seed, True),
        "admin-limit": (cmd_admin_limit, True),
        "admin-invalidate": (cmd_admin_invalidate, True),
        "admin-kick": (cmd_admin_kick, True),
        "admin-cool": (cmd_admin_cool, True),
        "admin-dequeue": (cmd_admin_dequeue, True),
        "admin-drop": (cmd_admin_drop, True),
    }
    if len(sys.argv) < 2:
        die(__doc__)
    cmd, argv = sys.argv[1], sys.argv[2:]
    if cmd == "serve":
        ensure_dirs()
        return cmd_serve(argv)
    if cmd in admin_cmds:
        fn, needs_pw = admin_cmds[cmd]
        ensure_dirs()
        if needs_pw:
            require_pw()
        return fn(argv)
    die(f"未知命令：{cmd}")


if __name__ == "__main__":
    main()
