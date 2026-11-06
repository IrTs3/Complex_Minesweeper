#!/usr/bin/env python3
# dist_client.py — 复数扫雷求解器基准 · 终端客户端（无密钥，拿到就能跑）
#
# 用法：
#   python3 dist_client.py --server https://ty0712.com:12712 \
#       [--solver /tmp/solver-expert] [--name 你的名字] [--pomodoro 25m/5m|off]
#
# 循环：领任务 → 跑 solver --jsonl → 逐局实时显示 → 交结果 → 领下一个。
# Ctrl+C 第一段：跑完当前任务后退出（不丢已跑的局）；第二段：向服务器 /release
# 放弃当前任务（立刻回队列，不用等租约），已跑的局不足整任务作废不交。
# 断网时结果落盘 ~/dist-pending/ 稍后自动补报，绝不丢数据。

import argparse
import base64
import ctypes
import hashlib
import json
import os
import platform
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

try:
    import resource
except ImportError:  # Windows 没有 resource 模块，RSS 走 PSAPI 分支
    resource = None

import ed25519

PENDING_DIR = os.path.join(os.path.expanduser("~"), "dist-pending")
LOG_PATH = os.path.join(os.path.expanduser("~"), "cmsdist-client.log")
PID_PATH = os.path.join(os.path.expanduser("~"), "cmsdist-client.pid")
STOP_PATH = os.path.join(os.path.expanduser("~"), "cmsdist-client.stop")
_panel_cleared = False  # 本次进程里是否已整屏清过（第一个任务清屏，后续往下排）
_panel_w = None         # 上一帧画时的终端宽度（面板 draw 用，检测拉伸窗口）
_HEADLESS = False       # 后台模式（--detach / pythonw）：stdout 不是 tty，不画面板

# 当前任务句柄：信号处理器要用（第二段 Ctrl+C 杀 solver、算剩余时间）。
# 字典套一层免 global 声明；读写都是单引用赋值，无撕裂风险。
cur_proc = {"p": None}
cur_st = {"st": None}
# 退出提示：信号处理器只改这里，由面板的 draw() 画在 Waiting 行——
# 绝不能在信号处理器里 print：光标被挪走会把面板的相对重画撞出错位（踩过）
hint = {"msg": ""}


def die(msg):
    print(msg, file=sys.stderr)
    sys.exit(1)


def _char_w(ch):
    o = ord(ch)
    return 2 if (0x1100 <= o <= 0x115F or 0x2E80 <= o <= 0x303E or 0x3041 <= o <= 0x33FF
                 or 0x3400 <= o <= 0x4DBF or 0x4E00 <= o <= 0x9FFF or 0xF900 <= o <= 0xFAFF
                 or 0xFF00 <= o <= 0xFF60 or 0xFFE0 <= o <= 0xFFE6) else 1


def fit_line(s, width):
    """按显示宽度截断一行到终端宽度。中英混排不能按 len 切（会把汉字切一半）。
    结果保证 ≤ width-1 列：写满最后一列时部分终端会挂起换行，同样毁掉
    面板的相对重画。"""
    out, w = [], 0
    for ch in s:
        cw = _char_w(ch)
        if w + cw > width - 2:
            return "".join(out) + "…"
        out.append(ch)
        w += cw
    return s


def http_json(server, path, payload=None, timeout=30):
    """POST/GET JSON。返回 (code, obj)。抛 urllib.error.HTTPError 时也返回 (code, body)。"""
    url = server.rstrip("/") + path
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET",
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode())
        except Exception:
            return e.code, {}
    # URLError 原样抛给上层做重试


_last_live = {"kb": 0}
# 本任务见过的 solver 峰值。Windows 没有 resource 模块，任务结束那行只能靠自己记 ——
# 原先直接走 getrusage，AttributeError 被 except 吞成 n/a（2026-11-03 修）。
# 记的是 OS 报的 PeakWorkingSetSize / 实测 RSS，不是「采样点里最大的那个」，所以
# 0.1s 一轮的 tick 不会漏掉两次采样之间的尖峰。
_peak = {"kb": 0}


def _fmt_kb(kb):
    return f"{kb / 1024:.0f}MB" if kb >= 1024 else f"{kb:.0f}KB"


def child_rss_mb(pid=None):
    """solver 的内存占用。pid 给定且进程还在 → 实时 RSS（任务进行中也可见）；
    否则返回本任务的峰值：mac/Linux 走 getrusage（只统计已 reap 的子进程），
    Windows 没有 resource 模块，用峰值期间记下的 _peak。取不到就 n/a。"""
    try:
        if pid is not None and platform.system() == "Windows":
            import ctypes.wintypes as wt

            class PMC(ctypes.Structure):
                _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                            ("PeakWorkingSetSize", ctypes.c_size_t),
                            ("WorkingSetSize", ctypes.c_size_t),
                            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                            ("PagefileUsage", ctypes.c_size_t),
                            ("PeakPagefileUsage", ctypes.c_size_t)]

            pmc = PMC()
            pmc.cb = ctypes.sizeof(PMC)
            k32 = ctypes.windll.kernel32
            h = k32.OpenProcess(0x0400, False, pid)  # PROCESS_QUERY_INFORMATION
            if h:
                ok = ctypes.windll.psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb)
                k32.CloseHandle(h)
                if ok:
                    _peak["kb"] = max(_peak["kb"], pmc.PeakWorkingSetSize / 1024)
                    return f"{pmc.WorkingSetSize / 1048576:.0f}MB"
            return "n/a"
        if pid is not None:
            try:
                out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)],
                                     capture_output=True, text=True, timeout=5)
                kb = int(out.stdout.strip() or 0)
            except Exception:
                kb = 0  # macOS fork 偶发瞬时失败
            if kb > 0:
                _last_live["kb"] = kb
                _peak["kb"] = max(_peak["kb"], kb)
            elif _last_live["kb"]:
                kb = _last_live["kb"]  # 读不到就用上一个实测值，别闪 n/a
            if kb > 0:
                return _fmt_kb(kb)
        if resource is None:
            return _fmt_kb(_peak["kb"]) if _peak["kb"] else "n/a"
        ru = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss
        mb = ru / 1048576 if platform.system() == "Darwin" else ru / 1024  # mac=字节 linux=KB
        return f"{mb:.0f}MB" if mb >= 1 else f"{mb * 1024:.0f}KB"
    except Exception:
        return "n/a"


def fmt_mmss(sec):
    return f"{int(sec) // 60:02d}:{int(sec) % 60:02d}"


def _eta_sec(st):
    """预估剩余秒数（2026-11-01 口径）。唯一实现，面板、进度上报、Ctrl+C 提示
    都读这里——两处数字不一样会被当成 bug。

    均值 = **本任务已完成所有局**的 solver 真实耗时（`sec_sum / n`），不用最近
    20 局的滑动窗口：单局离群会拖全程这件事，由「过一秒少一秒的倒计时」形态吸收。
    形态：均值 × 剩余局数(含当前局) − 当前局已跑，负数封到 0；慢局掉得比秒表还快
    （预支了后面的局），局完成时按新均值回跳一档，但不会出现「越等越涨」。
    攒够 5 局才给（样本太少没意义）。"""
    n = st["n"]
    if n < 5:
        return None
    mu = st["sec_sum"] / n
    games = st["games_total"]
    ran = time.time() - st["cur_t0"]
    # 散热休息（番茄钟）不属于「这一局已跑」：歇了多少秒就从这段时间里扣掉多少，
    # 否则一次 5 分钟的休息能把 ETA 直接砍到 0，看着像「马上完了」。
    if st["rest_until"]:
        ran -= st["rest_sec"] - max(0.0, st["rest_until"] - time.time())
    return max(0.0, mu * max(0, games - n) - max(0.0, ran))


def find_solver(arg):
    if arg:
        return arg
    here = os.path.dirname(os.path.abspath(__file__))
    exe = "solver-expert.exe" if platform.system() == "Windows" else "solver-expert"
    cands = [os.path.join(here, exe)]
    meipass = getattr(sys, "_MEIPASS", None)  # PyInstaller onefile 解包目录
    if meipass:
        cands.insert(0, os.path.join(meipass, exe))
    cands.append(os.path.join("/tmp", exe))
    cands.append(os.path.join(os.getcwd(), exe))
    for cand in cands:
        if os.path.exists(cand):
            return cand
    die("找不到 solver 二进制：用 --solver 指定（mac/linux 编译："
        "g++ -O2 -std=c++17 -I src tools/solver.cpp src/core/Board.cpp -o solver-expert）")


def probe_solver_ver(solver):
    """solver --version：编译期烙进二进制的源码指纹（CMake -DSOLVER_VER，见 CMakeLists）。
    分布式结果按它归因——混跑新旧包时分得清谁算的。返回 (指纹, 致命错误)：

    · 跑不起来（缺 DLL / 无执行权限 / 架构不对）→ 致命错误非空。这种包领任何
      任务都是 0 局，必须吭声退出，不能静默进「领任务→solver 秒退→作废→再领」的空转。
    · 老版 solver 不认 --version（打印用法、退出非 0）→ 返回空串，不是错误：
      显示留空、上报留空，空值本身就是版本标记。"""
    try:
        r = subprocess.run([solver, "--version"], capture_output=True, text=True, timeout=10)
    except OSError as e:
        return "", f"solver 起不来：{e}"
    except Exception as e:
        return "", f"solver 起不来：{type(e).__name__}: {e}"
    s = (r.stdout or "").strip().split()
    if r.returncode == 0 and s:
        return s[0][:16], ""
    return "", ""


def probe_pomodoro(solver):
    """这个 solver 认不认番茄钟的两个参数（本机计时 --pomodoro + 调度相位 --pomodoro-phase）。
    旧包不认时会在参数解析处打印用法并退出非 0，而 --version 恒返回 0，两条一起当探针用。
    ★一次探两条：只探其中一条会出现「半支持」——相位传过去它不认，就是 0 局 → 整任务作废。

    为什么必须先探再传：直接塞 --pomodoro 给旧 solver，它用法退出 1、0 局都不算，
    客户端每次都是「solver 提前结束 → 本任务作废」→ 领下一个 → 又作废，队列白烧。

    探针自己起不来（超时/权限）一律答「不认」：宁可不开番茄钟，也不许把任务跑成 0 局作废。"""
    try:
        r = subprocess.run([solver, "--pomodoro", "1s/1s", "--pomodoro-phase", "0:1:2", "--version"],
                           capture_output=True, text=True, timeout=10)
        return r.returncode == 0 and bool((r.stdout or "").strip())
    except Exception:
        pass
    return False


_CLIENT_VER = None


def client_ver():
    """「我在跑哪一份客户端字节」——与 manifest **同口径**的短哈希，所以看板上能直接跟
    「已发布」那份对：onefile（mac）取 `sys.executable` = manifest 的 `macos-bin`，
    免安装包（win/linux）取自身那个 `dist_client.py` = `win64-py` / `linux64-py`。

    为什么要它：`solver_ver` 只说**求解器**新旧，而更新是逐文件换的 —— Windows 上
    `solver.exe` 正被十个进程用着就换不动，于是「py 是新的、solver 是老的」这种半更新
    在只看 solver 的看板上完全隐形。两个身份各报一半，对不上「已发布」的那一半就是没换过来。
    只算一次：更新走 `execv` 换进程镜像，新进程自己重算。仓库裸跑也算（= 工作区那份）。"""
    global _CLIENT_VER
    if _CLIENT_VER is None:
        path = (sys.executable if _upd_mode() == "onefile"
                else os.path.realpath(__file__))
        try:
            h = hashlib.sha256()
            with open(path, "rb") as f:
                for chunk in iter(lambda: f.read(1 << 20), b""):
                    h.update(chunk)
            _CLIENT_VER = h.hexdigest()[:8]
        except OSError:
            _CLIENT_VER = ""       # 读不到就留空 = 看板上归「未上报」，绝不编一个
    return _CLIENT_VER


def phase_now(anchor, work_sec, cycle_sec, now=None):
    """调度相位的算术：与 dist_server.pomo_phase、solver 的 pomodoroRest 是同一套的三份拷贝
    （分发形态逼的：客户端是单文件、solver 是纯 C++，都 import 不到公共模块）。
    返回 (在不在休息段, 这一段还剩几秒)；T74 拿一串时刻点把这几份对拉，谁改歪当场红。"""
    if work_sec <= 0 or cycle_sec <= work_sec:
        return False, 0.0
    now = time.time() if now is None else now
    d = now - anchor
    if d < 0:           # 本机钟快过服务器：当「刚开始连算」，别把负数取模当成在歇
        return False, float(work_sec)
    pos = d % cycle_sec
    return (pos >= work_sec, (cycle_sec - pos) if pos >= work_sec else (work_sec - pos))


def pomo_local(task):
    """服务器随任务发下来的相位 → **本机时钟域**的 (anchor, 连算秒, 整轮秒)；没开/字段不合法 → None。
    机房那几台没对时：不换算的话钟慢 10 分钟的机器多歇 10 分钟、钟快的少歇，
    面板显示的剩余时间也会跟实际睡的时间不一致。"""
    p = task.get("pomo") or {}
    if not p.get("on"):
        return None
    try:
        w, r = int(p["work_sec"]), int(p["rest_sec"])
        a, sn = float(p["anchor"]), float(p["server_now"])
    except (KeyError, TypeError, ValueError):
        return None
    if w <= 0 or r <= 0:
        return None
    return (a + (time.time() - sn), w, w + r)


def pomo_phase_arg(ph):
    """pomo_local 的结果拼成 solver 的 --pomodoro-phase 参数（整轮=连算+休息，
    solver 那侧少存一个数就少一处能写歪的地方）。"""
    if not ph:
        return ""
    a, w, c = ph
    return f"{int(a)}:{w}:{c}"


_POMO_SEC = {"h": 3600, "m": 60, "s": 1}


def pomo_parse(seg):
    """与 solver 侧 parseDur 同口径：1h30m / 45m / 90s / 裸数字=分钟 / 0 / off → 秒；
    None = 读不懂。两边必须一致，否则客户端放行、solver 退出 1 = 任务白作废。"""
    seg = seg.strip()
    if seg in ("off", "0"):
        return 0
    total = num = 0
    has = False
    for ch in seg:
        if ch in "0123456789":
            num = num * 10 + int(ch)
            has = True
            continue
        mult = _POMO_SEC.get(ch)
        if mult is None or not has:
            return None
        total += num * mult
        num = 0
        has = False
    if has:
        total += num * 60   # 尾巴没单位 = 分钟（与 solver 侧 parseDur 必须一致）
    return total


def pomo_spec(spec):
    """把 --pomodoro 的写法按 solver 同一口径校验并归一成 "<跑>s/<歇>s"；"" = 不开。
    写错立刻退出，不能等 solver 用法退出后掉进「0 局 → 作废 → 再领」的空转。"""
    fmt = "格式：<连算>/<休息>，每段可带 h/m/s（如 25m/5m、1h30m/10m、90s/30s），off 关闭。"
    if not spec or spec.strip().lower() in ("off", "0"):
        return ""
    parts = spec.split("/")
    if len(parts) != 2:
        die(f'--pomodoro 要 "<跑>/<歇>" 两段。{fmt}收到 "{spec}"')
    w, r = pomo_parse(parts[0]), pomo_parse(parts[1])
    if w is None or r is None:
        die(f"--pomodoro 读不懂。{fmt}收到 \"{spec}\"")
    if (w > 0) != (r > 0):
        die(f"--pomodoro 两段得同开同关（一段 0 一段非 0 是写错）。{fmt}收到 \"{spec}\"")
    return "" if w == 0 else f"{w}s/{r}s"


# ---------------------------------------------------------------------------
# 自动更新（打包形态才启用；仓库源码跑绝不自更新）
# 流程：启动时 + 每个任务边界查 /client/manifest（Ed25519 验签，公钥焊在包里，
# 私钥只在打包机）→ 哈希对不上就下载 → 原子顶掉旧文件 → execv 重启。
# Windows 上运行中的文件删不掉但能改名：先 .old 挪开再顶上；.old 由任意实例
# 下次启动顺手删。跑着的旧实例干完手里的活，到任务边界发现磁盘变了就重启进新版。
# 多窗口互踩防护：更新先抢 ~/cmsdist-update.lock（O_CREAT|O_EXCL 原子占坑，
# 内容=pid+时间戳，超过 15 分钟视为孤儿锁接管），等待窗口空转到锁释放——
# 轮到它时磁盘多半已被第一个窗口换好，重查哈希相同就跳过下载直接 execv。
# 任何一步失败都静默返回，继续跑当前版本——更新是锦上添花，不是任务的一部分。
# ---------------------------------------------------------------------------

_UPD_SELF_SHA = None   # 启动时记下「我是什么」，之后磁盘被别的实例换了能看出来
_UPD_SELF_INO = None   # 同上的 inode 号：字节变了但 inode 没变 = 原地覆写，重启必死
_UPD_STUCK = False     # 换完再读还是旧内容 = 写入没生效，本进程不再试（防下载-重启死循环）
_UPD_LOCK = os.path.join(os.path.expanduser("~"), "cmsdist-update.lock")
_UPD_LOCK_STALE = 900   # 下载超时 300s×2 文件还有余量；pid 判活失效（复用/读不出）时的兜底
# 装不上的兜底落点：原目录换不动（只读/同步盘/权限）时，把校验过的字节装到这里再 execv 它，
# 当前进程就能真的进新版，而不是原地重下。onefile 是单文件，搬得走；win/linux 免安装包
# 要靠同目录的 python.exe，搬不动，所以那条路只吭声不兜底。
_UPD_ALT_DIR = os.path.join(os.path.expanduser("~"), "cmsdist-client")
_UPD_COOLDOWN_SEC = 600    # 一次失败后隔多久才再试：队列暂停时任务边界退化成 60s 一轮，
                           # 没有冷却就会「发现新版本→装不上→60s 后再来」无限刷 7MB 下载。
                           # 2026-11-05 从 1800 收到 600：换代期别让失败机干等半小时
_upd_fail = {"ver": None, "until": 0.0}   # 最近一次失败的目标版本 + 冷却截止时刻


def _upd_note_fail(ver, why):
    """更新没做成**必须**走这里：把原因打在屏幕上，并给这个版本一段冷却。
    以前只有 _upd_verify（换成功但读回旧字节）会吭声并置 _UPD_STUCK，而
    `_upd_swap` 返回 False、下载被配额 429 拒、写盘 EACCES 这三条路都被
    `except Exception: return False` 静默吞掉 —— 用户看到的就只有每分钟一行
    「发现新版本」，一句原因都没有（2026-11-03 机房 Air 的死循环就是这么来的）。"""
    print(f"⚠ 自动更新没做成（{'ver=' + str(ver) if ver is not None else '还没查到目标版本'}）：{why}")
    sys.stdout.flush()
    _upd_fail["ver"] = ver
    _upd_fail["until"] = time.time() + _UPD_COOLDOWN_SEC


def _upd_cooling():
    """冷却中就不再去查/下同一个版本。静默返回——原因已经在失败那行说过了。"""
    return time.time() < _upd_fail["until"]


def _pid_alive(pid):
    """进程还活着吗——只探活，绝不发信号。Windows 上 os.kill(pid, 0) 不是探活：
    0 就是 CTRL_C_EVENT（wincon.h），CPython 的 os_kill_impl 先给目标进程组投一次
    Ctrl+C；投不动（跨控制台/目标无控制台，分离进程很常见）它**不返回**，接着
    OpenProcess(PROCESS_ALL_ACCESS) + TerminateProcess(handle, 0) 直接把目标杀掉。
    两条路径都是干扰——更新锁判活与 --status 都会打到另一个窗口，故走 ctypes
    只申请 PROCESS_QUERY_LIMITED_INFORMATION(0x1000) 的句柄。"""
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)   # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        k.CloseHandle(h)
        return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    try:  # pid 可能被系统复用给别的进程，误杀不可接受——核验进程名
        out = subprocess.run(["ps", "-p", str(pid), "-o", "comm="],
                             capture_output=True, text=True).stdout or ""
        low = out.lower()   # mac 框架版 comm 是 …/MacOS/Python，大小写都得认
        return "dist-client" in low or "python" in low
    except Exception:
        return True


def _upd_lock_acquire():
    """原子占坑拿更新锁。False=别的窗口正在更新（调用方等待重试）。
    持有者进程已死（更新中途被关窗/强杀）立即摘锁接管，不等陈旧兜底；
    重抢瞬间两个等待窗口可能都进（unlink 与 create 之间无原子性），
    后果只是两份相同字节各下一遍，无害。"""
    for _ in range(3):
        try:
            fd = os.open(_UPD_LOCK, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
            os.write(fd, f"{os.getpid()} {time.time():.0f}".encode())
            os.close(fd)
            return True
        except FileExistsError:
            try:
                pid_s, ts_s = open(_UPD_LOCK).read().split()
                pid, ts = int(pid_s), float(ts_s)
            except (OSError, ValueError):
                return False            # 内容读不出来，按有人持锁处理，走陈旧兜底
            if not _pid_alive(pid) or time.time() - ts > _UPD_LOCK_STALE:
                try:
                    os.unlink(_UPD_LOCK)   # 死锁/孤儿锁，接管
                except OSError:
                    return False
                continue
            return False
    return False


def _upd_lock_release():
    try:
        os.unlink(_UPD_LOCK)
    except OSError:
        pass


def _upd_wait_lock():
    """锁被占就空转等（任务边界手上没活，等几秒下载无害），抢到为止。"""
    if _upd_lock_acquire():
        return
    print("⏳ 其他窗口正在更新，等它完成后一起进新版本 …")
    while not _upd_lock_acquire():
        time.sleep(1)


def _sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _upd_mode():
    """'onefile'（PyInstaller 整包，mac）/ 'files'（win/linux 免安装包）/ None（仓库裸跑）。"""
    if getattr(sys, "frozen", False) and sys.platform == "darwin":
        return "onefile"
    here = os.path.dirname(os.path.abspath(__file__))
    if os.path.exists(os.path.join(here, "python.exe")):
        return "files"    # win 包：dist_client.py 与 python.exe 平级
    if os.path.exists(os.path.join(here, "ed25519-pub.hex")):
        return "files"    # linux 包：公钥只随打包形态发，仓库裸跑没有这个文件
    return None


def _upd_pubkey():
    meipass = getattr(sys, "_MEIPASS", None)
    cands = ([os.path.join(meipass, "ed25519-pub.hex")] if meipass else []) + \
            [os.path.join(os.path.dirname(os.path.abspath(__file__)), "ed25519-pub.hex")]
    for c in cands:
        if os.path.exists(c):
            try:
                return bytes.fromhex(open(c, encoding="utf-8").read().strip())
            except (ValueError, OSError):
                return None
    return None


def _upd_cleanup_old(*paths):
    for p in paths:
        try:
            if not os.path.exists(p) and os.path.exists(p + ".old"):
                # 上次换到一半断了：主文件没了、旧版备份还在。这时删 .old 等于
                # 把最后一份可用字节也毁掉（启动脚本会报「解压不完整」），先还原。
                os.rename(p + ".old", p)
            elif os.path.exists(p + ".old"):
                os.unlink(p + ".old")   # 还有实例在跑就删不掉，留给下次启动
        except OSError:
            pass


def _upd_swap(path, new_path, rename_aside=True):
    """换文件。rename_aside=False 表示「被占着就放弃，别挪开旧文件腾位置」：
    挪开再换不回去会把主文件弄丢（只剩 .old），那是给被自己锁住的文件
    （dist_client.py / onefile 可执行）用的兜底；solver 是子进程，占着它的
    多半是另一个还在跑任务的窗口，动它不如等下一轮。"""
    try:
        os.replace(new_path, path)      # macOS：运行中的进程握着旧 inode，直接顶
        return True
    except OSError:                     # Windows：目标被运行中的进程锁着
        if not rename_aside:
            return False
        old = path + ".old"
        try:
            os.rename(path, old)
        except OSError:
            os.unlink(new_path)
            return False
        try:
            os.replace(new_path, path)
            return True
        except OSError:
            try:
                os.rename(old, path)    # 尽量还原，别把现场弄得更糟
            except OSError:
                pass
            return False


def _upd_verify(dest, want, label):
    """换完再读一遍。还对不上 = 写进去的字节没落到我读的这份文件上
    （网盘/同步盘目录典型症状：WebDAV 读缓存、或云端旧版把本地顶回去）。
    这时重启只会「下载→替换→读回旧版」原地死循环，所以吭一声、本进程不再试。"""
    global _UPD_STUCK
    try:
        ok = _sha256_file(dest) == want
    except OSError:
        ok = False
    if not ok:
        _UPD_STUCK = True
        print(f"⚠ 更新写入未生效（{label}）：下载校验是通过的，但重新读回来还是旧内容——"
              f"这个目录多半是网盘/同步盘。请把客户端整个文件夹移到本地磁盘后重新运行，"
              f"本轮继续用当前版本跑分。")
        sys.stdout.flush()
    return ok


def _upd_alt_path():
    return os.path.join(_UPD_ALT_DIR, os.path.basename(sys.executable))


def _upd_alt_ready(entry):
    """兜底落点里已经是目标版 → 返回那个路径，否则 None。
    那份文件自己的哈希就是记账本：下次用户仍从旧路径启动时，靠它判定
    「新版早就装好了，别再重下 7MB，去跑那份」，不需要额外的状态文件。"""
    alt = _upd_alt_path()
    try:
        if os.path.exists(alt) and _sha256_file(alt) == entry["sha256"]:
            return alt
    except OSError:
        return None
    return None


def _upd_alt_install(tmp, entry):
    """原目录换不动时的兜底：把**已校验过**的字节装进 ~/cmsdist-client/ 并读回核对。
    成功返回该路径（调用方 execv 它，当前进程立刻进新版）；失败抛 ValueError，由
    check_self_update 的统一失败出口吭声 + 进冷却——别在这里把原因打两遍。"""
    alt = _upd_alt_path()
    try:
        os.makedirs(_UPD_ALT_DIR, exist_ok=True)
        try:
            os.replace(tmp, alt)
        except OSError:
            # 跨卷（客户端在移动盘/网盘上）时 replace 报 EXDEV，改成同卷两段式
            shutil.copyfile(tmp, alt + ".new")
            os.replace(alt + ".new", alt)
        os.chmod(alt, 0o755)
    except OSError as e:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise ValueError(f"原地换不动，兜底目录也装不上（{alt}）：{e}") from None
    if not _upd_verify(alt, entry["sha256"], alt):
        raise ValueError(f"原地换不动，兜底目录装完读回来还是旧内容（{alt}）")
    return alt


def _upd_download(server, entry, dest):
    """下载 entry 指向的文件到 dest+'.new'。更新是用户看得见的事：终端里打
    百分比进度，重定向/后台只吭一声开始。sha256 对不上就地作废。"""
    url = server.rstrip("/") + entry["file"]
    req = urllib.request.Request(url, headers={"User-Agent": "cmsdist-client"})
    name = os.path.basename(dest)
    show = sys.stdout is not None and sys.stdout.isatty()
    if not show:
        print(f"⬇ 下载更新：{name} …")
    chunks = []
    try:
        r = urllib.request.urlopen(req, timeout=300)
    except urllib.error.HTTPError as e:
        # 服务器拒绝时把它的原话透出来：配额那句「每 IP 每小时 20 次 + 把文件夹移到本地
        # 磁盘」是用户唯一能照做的下一步，被上层 except 吞掉就只剩「一直检查更新」。
        raise ValueError(f"服务器拒绝下载（HTTP {e.code}）：{_http_err_body(e)}") from None
    with r:
        total = int(r.headers.get("Content-Length") or 0)
        got = 0
        while True:
            c = r.read(1 << 16)
            if not c:
                break
            chunks.append(c)
            got += len(c)
            if show:
                if total:
                    sys.stdout.write(f"\r⬇ {name}  {100 * got // total:3d}%"
                                     f"（{got >> 20}/{total >> 20}MB）")
                else:
                    sys.stdout.write(f"\r⬇ {name}  已下 {got >> 20}MB")
                sys.stdout.flush()
    blob = b"".join(chunks)
    if show:
        print()
    if hashlib.sha256(blob).hexdigest() != entry["sha256"]:
        raise ValueError("下载的更新 sha256 不符")
    tmp = dest + ".new"
    try:
        with open(tmp, "wb") as f:
            f.write(blob)
        os.chmod(tmp, 0o755)
    except OSError as e:
        raise ValueError(f"写不进 {tmp}：{e}（这个目录多半只读，或是网盘/同步盘）") from None
    return tmp


def _http_err_body(e):
    """把服务器 4xx/5xx 的 JSON error 字段读成人话（读不出就退回状态码）。"""
    try:
        return json.loads(e.read().decode("utf-8", "replace")).get("error") or f"HTTP {e.code}"
    except (OSError, ValueError, AttributeError):
        return f"HTTP {e.code}（响应体读不出来）"


def check_self_update(server, solver_is_bundled):
    """任务边界调用。更新了就 execv（不回来）；没做成要**吭声 + 进冷却**（旧版是
    静默 return False，配上暂停期 60 秒一轮的空转，就成了无限重下 7MB）。"""
    global _UPD_SELF_SHA, _UPD_SELF_INO
    mode = _upd_mode()
    if mode is None or _UPD_STUCK:
        return False
    if _upd_cooling():
        return False        # 刚失败过：原因已在失败那行打过，静默等冷却，别再下一遍
    pub = _upd_pubkey()
    if not pub:
        return False
    ver = None
    try:
        code, man = http_json(server, "/client/manifest", timeout=20)
        if code != 200 or not isinstance(man, dict):
            return False
        files = man.get("files")
        if not isinstance(files, dict):
            return False
        payload = json.dumps({"ver": man.get("ver"), "files": files},
                             sort_keys=True, separators=(",", ":")).encode()
        if not ed25519.verify(pub, base64.b64decode(man.get("sig", "")), payload):
            return False
        ver = man.get("ver")     # 失败时要报「哪个版本没装上」，也用作冷却的键

        if mode == "onefile":
            entry = files.get("macos-bin")
            exe = sys.executable           # onefile 的 sys.executable 就是自身
            if not entry:
                return False
            _upd_cleanup_old(exe)
            if _UPD_SELF_SHA is None:
                _UPD_SELF_SHA = _sha256_file(exe)
                _UPD_SELF_INO = os.stat(exe).st_ino
            disk = _sha256_file(exe)
            if disk == entry["sha256"]:
                if disk != _UPD_SELF_SHA:
                    # 磁盘已是目标版而我在跑旧版 = 别的窗口已换好 → 重启进新版。
                    # 但 inode 若还是我启动时那个 = 有人原地覆写了字节（打包脚本
                    # cp 顶掉运行中的二进制）：macOS 对「被映射后又改过的 vnode」
                    # 永久 exec 判死，execv 必 137——别自杀，吭一声继续用旧版跑。
                    if _UPD_SELF_INO is not None and os.stat(exe).st_ino == _UPD_SELF_INO:
                        print("⚠ 版本文件被原地覆盖（不是正常的自动更新）：重启会被系统拦杀，"
                              "本窗口继续用当前版本跑分。请手动关窗重开，或别在客户端运行时重跑打包。")
                        sys.stdout.flush()
                        return False
                    print("⬇ 其他窗口已完成更新，重启进入新版本 …")
                    sys.stdout.flush()
                    time.sleep(0.5)
                    os.execv(exe, [exe] + sys.argv[1:])   # 不回来
                return False              # 我跑的就是最新版，无事可做
            if disk != _UPD_SELF_SHA:
                return False               # 磁盘既不是我也不是目标版，来路不明别动
            alt = _upd_alt_ready(entry)
            if alt:
                # 上一轮已经装到兜底位置了：别再重下一遍，说清楚该跑哪份
                print(f"⚠ 原目录 {os.path.dirname(exe)} 换不动文件；新版已装在 {alt}。"
                      f"请关掉本窗口、以后从那里启动。本窗口继续用当前版本跑分。")
                sys.stdout.flush()
                return False
            print(f"🆕 发现新版本 ver={ver}，更新后自动继续跑分 …")
            _upd_wait_lock()
            restart_to = exe
            try:
                # 排队期间磁盘可能已被前面的窗口换好：现读现算，别信启动时的缓存。
                # 等于目标版 → 白嫖（不下载不换文件，配额每 IP 每小时 20 次，
                # 同目录 N 个窗口一次发布只该花 1 次下载）；等于我启动那份 → 该我下；
                # 都不是 → 有人动了文件（多半是运行中重跑了打包），来路不明别 execv。
                disk2 = _sha256_file(exe)
                if disk2 == entry["sha256"]:
                    print("⬇ 排队期间别的窗口已完成下载，直接重启进入新版本 …")
                    sys.stdout.flush()
                elif disk2 == _UPD_SELF_SHA:
                    tmp = _upd_download(server, entry, exe)
                    if _upd_swap(exe, tmp):
                        if not _upd_verify(exe, entry["sha256"], os.path.basename(exe)):
                            restart_to = None      # _upd_verify 已吭声并置了 _UPD_STUCK
                    else:
                        # 原地换不动 ≠ 用不上新版：装进 ~/cmsdist-client 并重启进它
                        restart_to = _upd_alt_install(tmp, entry)
                        print(f"⬇ 原目录换不动文件，已装到 {restart_to} …")
                        sys.stdout.flush()
                else:
                    restart_to = None
                    raise ValueError(f"排队期间 {exe} 的内容变了（既不是目标版也不是本窗口"
                                     f"启动那份），来路不明，本轮不更新")
            finally:
                # 释放必须在 execv 之前：换进程镜像不返回，finally 就不会跑，
                # 锁会留成一个「pid 还活着」的死锁，重启后永远卡在等锁上。
                _upd_lock_release()
            if restart_to is None:
                return False
            print("⬇ 客户端已自动更新，重启进入新版本 …")
            sys.stdout.flush()
            time.sleep(0.5)
            os.execv(restart_to, [restart_to] + sys.argv[1:])   # 不回来

        # 免安装包（win/linux）：换 dist_client.py（要重启）和 solver 二进制（不用重启）
        here = os.path.dirname(os.path.abspath(__file__))
        my_py = os.path.abspath(__file__)
        if platform.system() == "Windows":
            py_entry, solver_entry = files.get("win64-py"), files.get("solver-win64")
        else:
            py_entry, solver_entry = files.get("linux64-py"), files.get("solver-linux64")
        if not py_entry:
            return False
        _upd_cleanup_old(my_py)
        if _UPD_SELF_SHA is None:
            _UPD_SELF_SHA = _sha256_file(my_py)
        disk = _sha256_file(my_py)
        py_done = disk == py_entry["sha256"]
        if py_done and disk != _UPD_SELF_SHA:
            # 别的窗口已换好 py 而我还在跑旧版 → 重启进新版（solver 顺带也新了）
            print("⬇ 其他窗口已完成更新，重启进入新版本 …")
            sys.stdout.flush()
            time.sleep(0.5)
            os.execv(sys.executable, [sys.executable, my_py] + sys.argv[1:])
        if not py_done and disk != _UPD_SELF_SHA:
            return False               # 来路不明别动
        need_restart = not py_done
        solver_name = "solver-expert.exe" if platform.system() == "Windows" else "solver-expert"
        sibling = os.path.join(here, solver_name)
        solver_stale = (solver_is_bundled and bool(solver_entry)
                        and os.path.exists(sibling)
                        and _sha256_file(sibling) != solver_entry["sha256"])
        if need_restart or solver_stale:
            print(f"🆕 发现新版本 ver={ver}，更新后自动继续跑分 …")
            _upd_wait_lock()
            try:
                # 排队期间可能已被前面的窗口换好：现读现算，三分支口径同 onefile。
                disk2 = _sha256_file(my_py)
                if not need_restart:
                    pass                   # py 已是最新，这一轮只为 solver
                elif disk2 == py_entry["sha256"]:
                    need_restart = True    # 白嫖：别的窗口已换好，重启进新版即可
                elif disk2 == _UPD_SELF_SHA:
                    tmp = _upd_download(server, py_entry, my_py)
                    if not _upd_swap(my_py, tmp):
                        # 免安装包要靠同目录的 python.exe 才能跑，搬不走兜底目录，
                        # 所以这里只能把话说清楚 + 进冷却，让人去移文件夹（别再每 60s 重下）
                        raise ValueError(f"换不动 {my_py}：目录不可写或被占用，"
                                         f"请把客户端整个文件夹移到本机本地磁盘后重开窗口")
                    if not _upd_verify(my_py, py_entry["sha256"], "dist_client.py"):
                        return False
                    need_restart = True
                else:
                    raise ValueError(f"排队期间 {my_py} 的内容变了（既不是目标版也不是"
                                     f"本窗口启动那份），来路不明，本轮不更新")
                if solver_is_bundled and solver_entry and os.path.exists(sibling) \
                        and _sha256_file(sibling) != solver_entry["sha256"]:
                    tmp = _upd_download(server, solver_entry, sibling)
                    if _upd_swap(sibling, tmp, rename_aside=False):   # 下个任务用新 solver
                        _upd_verify(sibling, solver_entry["sha256"], solver_name)
                    else:
                        _upd_note_fail(ver, f"solver 换不上（{sibling} 被别的窗口的任务占着）"
                                            f"，下个任务边界再试")
            finally:
                _upd_lock_release()
        if need_restart:
            print("⬇ 客户端已自动更新，重启进入新版本 …")
            sys.stdout.flush()
            time.sleep(0.5)
            os.execv(sys.executable, [sys.executable, my_py] + sys.argv[1:])
        return False
    except Exception as e:
        # 统一失败出口：任何一步没做成都要留下原因 + 冷却（网络抖动也不例外——
        # 代价是这类失败 30 分钟内不再重试，更新本来就不急，换来的是不再刷屏）。
        _upd_note_fail(ver, f"{type(e).__name__}: {e}")
        return False


# ---------------------------------------------------------------------------
# 后台模式：--detach 脱离终端，--status 查看，--stop 优雅收尾。
# 解决「终端窗口一堆/不敢关」：--detach 把自己变成没有终端的后台进程，
# 日志进 ~/cmsdist-client.log，进度照常 10s 上报（ctlui 上看全局面板）。
# ---------------------------------------------------------------------------

def _read_pid():
    try:
        return int(open(PID_PATH, encoding="utf-8").read().strip())
    except (OSError, ValueError):
        return None


def do_detach():
    """脱离终端。POSIX fork+setsid；Windows 重拉 pythonw（无控制台解释器）。
    父进程立即退出——启动它的终端窗口当场就能关，跟这个进程再无关系。"""
    if os.name == "nt":
        pythonw = os.path.join(os.path.dirname(sys.executable), "pythonw.exe")
        if not os.path.exists(pythonw):
            pythonw = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pythonw.exe")
        if not os.path.exists(pythonw):
            print("✗ 找不到 pythonw.exe，无法进后台（继续在前台跑）。")
            return
        args = [pythonw, os.path.abspath(__file__)] + \
               [x for x in sys.argv[1:] if x != "--detach"]
        flags = getattr(subprocess, "DETACHED_PROCESS", 0) | \
            getattr(subprocess, "CREATE_NO_WINDOW", 0) | \
            getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        subprocess.Popen(args, creationflags=flags, close_fds=True)
        print(f"✓ 已在后台启动（日志 {LOG_PATH}）；本窗口可以关了。")
        sys.exit(0)
    pid = os.fork()
    if pid > 0:
        print(f"✓ 已在后台启动（日志 {LOG_PATH}）；本窗口可以关了。")
        sys.stdout.flush()
        os._exit(0)
    os.setsid()
    sys.stdout.flush()
    sys.stderr.flush()
    log = open(LOG_PATH, "ab", buffering=0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    with open(PID_PATH, "w", encoding="utf-8") as f:
        f.write(str(os.getpid()))


def do_status():
    pid = _read_pid()
    if pid is None or not _pid_alive(pid):
        print("后台客户端没在跑（pid 文件没有或已失效）。")
        return
    print(f"后台客户端运行中：pid {pid}")
    try:
        with open(LOG_PATH, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 16384))
            tail = f.read().decode("utf-8", "replace")
        esc = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\[2J")
        keep = [esc.sub("", ln).strip() for ln in tail.splitlines()]
        keep = [ln for ln in keep if ln]
        shown = 0
        for ln in reversed(keep):
            print("  " + ln[:130])
            shown += 1
            if shown >= 12:
                break
    except OSError:
        print(f"  （日志读不到：{LOG_PATH}）")


def do_stop():
    pid = _read_pid()
    alive = pid is not None and _pid_alive(pid)
    # 先落停止标记：Windows 没有优雅信号，全靠任务边界软停；POSIX 也兜一层
    open(STOP_PATH, "w", encoding="utf-8").write("stop")
    if alive and os.name != "nt":
        os.kill(pid, signal.SIGTERM)   # 复用现成的优雅出口：跑完当前任务、交了结果再退
        print(f"已向后台客户端（pid {pid}）发送停止信号：跑完当前任务、交了结果就退。")
    elif alive:
        print(f"已写入停止标记：后台客户端（pid {pid}）将在当前任务跑完交结果后退出。")
    else:
        print("后台客户端没在跑；停止标记已写入（下次启动会被立即消费掉）。")


def save_pending(task, records):
    os.makedirs(PENDING_DIR, exist_ok=True)
    p = os.path.join(PENDING_DIR, f"{task['task_id']}.json")
    with open(p, "w", encoding="utf-8") as f:
        json.dump({**task, "records": records}, f, ensure_ascii=False)
    print(f"⚠ 结果已落盘 {p}（联网后会自动补报）")


def os_label():
    """系统标签，ctlui 按「系统 / 设备」显示（cmsui 同款口径）。"""
    s = platform.system()
    if s == "Darwin":
        v = platform.mac_ver()[0] or platform.release()
        return f"macOS {v}" if v else "macOS"
    if s == "Windows":
        r = platform.release()
        return f"Windows {r}" if r else "Windows"
    if s == "Linux":
        r = platform.release()
        return f"Linux {r}" if r else "Linux"
    return s or "?"


def _drop(path):
    """删掉一份已处理的补报文件。文件已经不在（重复调用、自更新互踩）不算错——
    为这个抛出去会把整个客户端打死，而这里丢的只是一份已经交过/作废的记录。"""
    try:
        os.remove(path)
    except FileNotFoundError:
        pass


def flush_pending(server, name):
    if not os.path.isdir(PENDING_DIR):
        return
    for fn in sorted(os.listdir(PENDING_DIR)):
        if not fn.endswith(".json"):
            continue
        p = os.path.join(PENDING_DIR, fn)
        try:
            with open(p, "r", encoding="utf-8") as f:
                payload = json.load(f)
        except Exception:
            continue
        payload["name"] = name
        payload["os"] = os_label()
        try:
            code, resp = http_json(server, "/result", payload, timeout=60)
        except Exception:
            return  # 还是不通，下次再试
        if code == 200:
            _drop(p)
            print(f"✓ 补报成功：{payload['task_id']}（{resp.get('wins')}/{resp.get('games')}）")
        elif code == 409:
            _drop(p)  # 服务器已有（重复补报），丢弃
            print(f"✓ 补报跳过（服务器已有）：{payload['task_id']}")
        else:
            # 拒绝（403 任务不属于我们 / 410 超时 / 其他）= 永远交不上，作废丢弃，不积死文件。
            # ★ 这里曾经连着写两次 os.remove，第二次抛 FileNotFoundError 把整个客户端打死
            #   （2026-11-02 服务器 state 损坏、补报集体 403 时才撞上）。
            _drop(p)
            print(f"✗ 补报被拒（{code}）：{payload['task_id']} {(resp or {}).get('error', '')}——作废丢弃")


def run_one(server, name, task, solver, solver_ver, stop, abort, gone, pomo="", pomo_ok=False):
    """跑一个任务并交结果（固定面板 UI，0.1s 实时刷新）。
    返回 True=已交/已处理（含任务被服务器收走的跳过），False=该停了（第二段 Ctrl+C）。
    pomo_ok：探测过这个 solver 认番茄钟参数，才允许往下传；不认就一个参数都不加
    （旧 solver 收到 --pomodoro 是「用法退出 → 0 局 → 整任务作废 → 再领」的空转）。
    pomo = 本机连算计时（`<跑>s/<歇>s` 或 off）；调度相位从 task["pomo"] 换算，两条闸独立。"""
    tid, nonce = task["task_id"], task["nonce"]
    board = f"{task['cols']}x{task['rows']}x{task['mines']}"
    games = task["games"]
    global _panel_cleared, _panel_w
    if _HEADLESS:
        # 后台模式：没有 tty，面板/清屏序列只会往日志里倒垃圾。
        # 进度照常 10s 上报（ctlui 上看得见），日志留任务头与收尾行。
        _panel_cleared = True
    elif not _panel_cleared:
        # 整屏清屏 + 关自动换行（?7l）：面板靠相对光标移动重画，哪帧恰好写满一行
        # 触发软换行，光标就整体下坠一行，之后每帧全画错位、屏上留下旧帧残行
        # （实测：多出一条旧 Waiting、数字缺角）。关掉换行，超宽只会被裁不串行。
        sys.stdout.write("\033[2J\033[H\x1b[?7l")
        _panel_cleared = True
    head_task = f"任务 {time.strftime('%Y%m%d_%H:%M:%S')}  {task['model']}  {board}  {games}局"
    # Seed 行带上**两个身份**：截图/肉眼比对时直接看出这局是哪份代码算的。只写 solver 会漏掉
    # 「新客户端 + 老求解器」的半更新（逐文件换包的常态），只写 client 又看不出求解器新旧。
    cv = client_ver()
    head_seed = (f"Seed: {task['seed']}"
                 + (f"  solver {solver_ver}" if solver_ver else "")
                 + (f"  client {cv}" if cv else ""))
    tw0 = shutil.get_terminal_size().columns
    _panel_w = None
    print(fit_line(head_task, tw0))
    if not _HEADLESS:
        print()
        print(fit_line(head_seed, tw0))
        print()
        for _ in range(7):  # 占位：状态行 / 当前局 / 空行 / 最近三局 / 退出提示（都在光标行上方 -7..-1）
            print()

    lock = threading.Lock()
    st = {"n": 0, "wins": 0, "t0": time.time(), "cur_t0": time.time(),
          "done": [], "ram": "n/a", "games_total": games, "sec_sum": 0.0,
          "rest_until": 0.0, "rest_sec": 0, "rest_ran_ms": 0, "rest_src": "local",
          "phase": pomo_local(task) if pomo_ok else None}
    hint["msg"] = ""   # 新任务新面板，上一任务的退出提示不带走
    ev = threading.Event()

    def _hintline(tw):
        """面板最底行的退出提示。红字：先按显示宽截断再包色，转义码不进宽度计算，
        不然 fit_line 会把色码当可见字符算宽。无提示时返回空串（\x1b[K 清行）。"""
        if not hint["msg"]:
            return ""
        s = fit_line(hint["msg"], tw)
        return "\x1b[1;31m" + s + "\x1b[0m"

    def eta_now():
        """预估剩余秒数——见模块级 _eta_sec()。只读不锁：draw() 与逐局循环
        都在持有 lock 时调用，threading.Lock 不可重入。"""
        return _eta_sec(st)

    def draw():
        """重画面板动态行（相对光标移动，不怕终端滚动）。画完光标回到面板尾行。
        前提是每行都不超过终端宽度——超宽会软换行，7 个逻辑行变 10 个物理行，
        相对移动全部错位。所以：每行先 fit_line 截断；检测到宽度变化（拉伸窗口）
        就整屏清空、连任务头一起重排，甩掉旧宽度换出来的残行。"""
        global _panel_w
        if _HEADLESS:
            return
        n, wins = st["n"], st["wins"]
        tw = shutil.get_terminal_size().columns
        if _panel_w is not None and tw != _panel_w:
            sys.stdout.write("\x1b[2J\x1b[H")
            print(fit_line(head_task, tw))
            print()
            print(fit_line(head_seed, tw))
            print()
            for _ in range(7):
                print()
        _panel_w = tw
        el = time.time() - st["t0"]
        # 平均每局只算已完成局的真实耗时（solver 上报的 sec）——正在跑的这局
        # 不参与，否则跑到一半把均值和剩余时间越拉越大（用户裁决）
        avg = st["sec_sum"] / n if n else 0.0
        rate = f"{100.0 * wins / n:.1f}% ({wins}/{n})" if n else "-- (0/0)"
        status = (f"总进度：{n}/{games}  总用时：{fmt_mmss(el)}"
                  f"  平均每局：{avg:.3f}s" if n else
                  f"总进度：{n}/{games}  总用时：{fmt_mmss(el)}  平均每局：--")
        # 预估剩余时间：倒计时口径，见 eta_now()
        eta = eta_now()
        # RAM 那行的口径（2026-11-03 用户读错一次 981MB 之后改准）：它是 **solver 子进程**的
        # 实时 RSS，且一个任务共用一个 solver 进程 —— 分层 DP 在最硬那局要过的页还回分配器
        # 但不还内核，所以这个数只升不降，读作「本任务至今要过多少」而不是「当前这局要多少」。
        status += (f"  当前胜率：{rate}  本任务solver RAM：{st['ram']}"
                   f"  预估剩余时间：{fmt_mmss(eta) if eta is not None else '--'}")
        waiting_el = time.time() - st["cur_t0"] if n < games else None
        done = st["done"][:3]
        # 局号按总局数的位数对齐（定宽）：原先宽度跟着「已完成的最长局号」变，
        # 一过 9/99 整行左右抖动，休息那行加进来后抖动更明显（0.1s 一帧）。
        w0 = len(str(games))
        rows = [(d["g"] + 1, "Win" if d["win"] else "Lose", d["mid"], d["end"], d["sec"])
                for d in done]
        # 可变字段动态对齐：宽度取当前显示的三局 + 正在跑的这局。
        # 必须先算宽度再拼 waiting —— waiting 里也要用 wn 对齐，宽度后置会引用到未定义的变量。
        wn = max([len(str(g)) for g, *_ in rows] + [len(str(n + 1))])
        wx = max([len(str(x)) for _, _, x, *_ in rows] + [1])
        wy = max([len(str(y)) for _, _, _, y, _ in rows] + [1])
        wt = max([len(f"{s:.1f}s") for *_, s in rows]
                 + ([len(f"{waiting_el:.1f}s")] if waiting_el is not None else []) + [4])
        # 面板 7 行里的第二行：三种态按优先级给一个
        #   ① solver 真睡着了（它报了休息行）→ 报倒计时，不留「当前局已跑」一直涨
        #   ② 到点了但这局还没算完 → 说清「等这局算完就睡」，否则机器还烫着而屏上没交代
        #   ③ 正常在算 → 本局已跑多少秒
        # 措辞统一「休息一下」：管理口径（暂停发放那一类）不是测试者想听的，
        # 不变量第 13 组钉住这一行不能漂回去
        now = time.time()
        waiting = ""
        if st["rest_until"] > now:
            left = st["rest_until"] - now
            why = (f"已连算 {fmt_mmss(st['rest_ran_ms'] / 1000.0)}"
                   if st["rest_src"] == "local" else "调度定的")
            waiting = (f"[#{n + 1:>{wn}}] ☕ 休息一下 剩余 {fmt_mmss(left)}"
                       f"（{why}，#{n + 1} 局歇完再开）")
        elif st["phase"]:
            in_rest, left = phase_now(*st["phase"])
            if in_rest:
                waiting = (f"[#{n + 1:>{wn}}] ☕ 该休息一下了：这局算完就睡，"
                           f"还剩 {fmt_mmss(left)}")
        if not waiting:
            waiting = (f"[#{n + 1:>{wn}}] Waiting 用时：{waiting_el:>{wt}.1f}s"
                       if waiting_el is not None else "")
        # 面板 7 行：状态 / Waiting / 空行 / 三局 / 退出提示（提示不占 Waiting 行，
        # 不然把正在跑的局用时盖掉——用户裁决：提示固定挂最底下）
        buf = ["\x1b[7A\x1b[K" + fit_line(status, tw),
               "\r\x1b[1B\x1b[K" + fit_line(waiting, tw)]
        for i in range(3):
            if i < len(rows):
                g, res, x, y, s = rows[i]
                row = (f"[#{g:>{wn}}] {res:<4} 猜测次数{x:>{wx}}/{y:>{wy}}"
                       f" 用时：{s:>{wt}.1f}s")
            else:
                row = ""
            buf.append(f"\r\x1b[{2 if i == 0 else 1}B\x1b[K" + fit_line(row, tw))
        # 帧尾光标必须落在面板下方一行（status+7）：7A 才能精确回到状态行。
        # 少走一行，每帧整体上漂一格、旧帧残行永远擦不掉（resize 实测复现）
        buf.append("\r\x1b[1B\x1b[K" + _hintline(tw) + "\r\x1b[1B")
        sys.stdout.write("".join(buf))
        sys.stdout.flush()

    # solver 必须对终端 SIGINT/SIGHUP 免疫：Ctrl+C 发给整个前台进程组，
    # 若 solver 一起死，客户端只能作废任务——「跑完当前任务」就永远是空话。
    # 退出节奏完全由客户端编排（第一段等它算完，第二段由客户端 kill）。
    popen_kw = {}
    if os.name == "nt":
        popen_kw["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        def _solver_sigign():
            signal.signal(signal.SIGINT, signal.SIG_IGN)
            signal.signal(signal.SIGHUP, signal.SIG_IGN)
        popen_kw["preexec_fn"] = _solver_sigign
    argv = [solver, "--board", board, "--games", str(games),
            "--seed", str(task["seed"]), "--model", task["model"], "--jsonl"]
    if pomo_ok:
        # 只在探测确认 solver 认这两个参数后才传（旧包会用法退出→0 局→任务作废）
        argv += ["--pomodoro", pomo or "off"]
        if st["phase"]:
            argv += ["--pomodoro-phase", pomo_phase_arg(st["phase"])]
    proc = subprocess.Popen(argv,
                            stdout=subprocess.PIPE, text=True,
                            encoding="utf-8", errors="replace", **popen_kw)
    cur_proc["p"] = proc
    cur_st["st"] = st

    def tick():
        while not ev.is_set():
            st["ram"] = child_rss_mb(proc.pid)
            # 散热休息结束：下一局从这一刻才算起。不改的话「当前局已跑」和
            # 预估剩余时间会把歇的几分钟算进那一局（ETA 越歇越短）。
            if st["rest_until"] and time.time() >= st["rest_until"]:
                st["rest_until"] = 0.0
                st["cur_t0"] = time.time()
            with lock:
                draw()
            ev.wait(0.1)

    ticker = threading.Thread(target=tick, daemon=True)
    ticker.start()

    # 进度上报（best-effort）：每 10s 把 x/y 报给服务器，ctlui「进行中」能看到百分比。
    # 断网/其他失败一律静默——这不是协议的必要环节，别为它吭声。
    # 例外：服务器「明确」回 403/404 = 任务已不属于我们（被剔除/收走重发），
    # 这时杀掉当前任务立刻领下一个，别把算力烧在注定交不上去的局上（2026-11-01 用户定稿）。
    def progress_loop():
        while not ev.wait(10):
            if ev.is_set():
                break
            n = st["n"]
            # 跟面板同一口径（见 _eta_sec）：已完成所有局的均值 × 剩余局数 − 当前局已跑
            eta = eta_now()
            eta = round(eta) if eta is not None else None
            try:
                code, resp = http_json(server, "/progress",
                                       {"task_id": tid, "nonce": nonce, "done": n, "eta_sec": eta},
                                       timeout=15)
                if code in (403, 404):
                    # 服务器明确说这任务已经不属于我们了（被剔除 / 租约收走后被他人重领）。
                    # 只有「服务器亲口拒绝」才算数，网络异常走 except 照旧静默——
                    # 继续算也是白算：杀掉 solver，主循环走「任务被收回」分支领下一个。
                    gone["flag"] = True
                    p = cur_proc["p"]
                    if p and p.poll() is None:
                        p.kill()   # 输出管道 EOF，读取循环当即结束
                    return
            except Exception:
                pass
    threading.Thread(target=progress_loop, daemon=True).start()

    records = []
    # Windows 的阻塞管道读（ReadFile）不可被 Ctrl+C 中断：主线程直接
    # `for line in proc.stdout` 时，SIGINT 要等 solver 下一局输出（复数一局
    # ~8s）才轮得上处理，体感就是「按了没反应」。读取挪进后台线程，主线程
    # 短超时轮询取行，信号处理永远能在 0.2s 内插进来（Win10 实测踩过）。
    lines = queue.Queue()

    def pump():
        try:
            for line in proc.stdout:
                lines.put(line)
        finally:
            lines.put(None)  # EOF 哨兵
    threading.Thread(target=pump, daemon=True).start()
    while True:
        try:
            line = lines.get(timeout=0.2)
        except queue.Empty:
            if stop["flag"] and proc.poll() is not None:
                break
            continue
        if line is None:
            break
        line = line.strip()
        if not line.startswith("{"):
            continue  # 人类可读表格行，客户端跳过
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if "summary" in obj:
            continue  # 汇总行：服务器端会按逐局记录重算，不信任客户端汇总
        if "rest" in obj:
            # 番茄钟的散热休息：不是局，绝不进 records（进了就把 len(records)
            # 撑过 games，交结果时按「局数不符」作废）。
            with lock:
                st["rest_sec"] = int(obj["rest"])
                st["rest_ran_ms"] = int(obj.get("ran_ms", 0))
                # src 告诉面板这觉是谁让睡的：调度相位（sched）说「调度定的」，
                # 本机番茄钟说「已连算 mm:ss」——口径不同，混报会误导测试者
                st["rest_src"] = "sched" if obj.get("src") == "sched" else "local"
                st["rest_until"] = time.time() + st["rest_sec"]
                if st["rest_until"] <= time.time():   # 0 秒休息：立刻算休息结束
                    st["rest_until"] = 0.0
                    st["cur_t0"] = time.time()
            if _HEADLESS:
                why = (f"已连算 {fmt_mmss(st['rest_ran_ms'] / 1000.0)}"
                       if st["rest_src"] == "local" else "调度定的")
                print(f"☕ 休息一下 {obj['rest']} 秒（{why}）")
            else:
                draw()
            continue
        records.append(obj)
        with lock:
            st["n"] += 1
            st["wins"] += obj["win"]
            st["sec_sum"] += obj["sec"]
            st["done"].insert(0, obj)
            del st["done"][3:]
            st["cur_t0"] = time.time()
            draw()
        if stop["flag"] and proc.poll() is not None:
            break
    ev.set()
    ticker.join()
    proc.wait()
    cur_proc["p"] = None
    cur_st["st"] = None
    # 用户裁决：做完把 Waiting 行和「最近三局」整行删掉（不留空行），面板收拢后接 Finished
    if not _HEADLESS:
        sys.stdout.write("\x1b[6A\x1b[6M\r\x1b[?7h")  # 删 6 行（Waiting+空行+三局+提示行），恢复自动换行
        sys.stdout.flush()
    print()

    def panel_divider():
        print()
        print()
        print("─" * 46)
        print()
        print()
    if abort["flag"] and len(records) != games:
        # 第二段 Ctrl+C：放弃任务。已跑的局不足整任务，服务器也没法核验，不交；
        # 先给服务器发 /release 把任务立刻还回队列（并发名额当即释放），再退。
        print(f"\n放弃任务 {tid}（已跑 {len(records)}/{games} 局，不足整任务作废不交）")
        code, resp = None, {}
        for attempt in range(3):
            try:
                code, resp = http_json(server, "/release",
                                       {"task_id": tid, "nonce": nonce}, timeout=30)
                break
            except Exception as e:
                if attempt < 2:
                    print(f"⚠ release 失败（{e}），5s 后重试 …")
                    time.sleep(5)
        if code == 200:
            print("✓ 任务已还回队列，其他客户端可立即领取；本进程退出。")
        elif code == 404:
            print("✓ 任务已不在进行中（租约先到期收走了）；本进程退出。")
        else:
            print(f"⚠ release 没成（{code or '网络不通'}）——任务等租约到期自动回收；本进程退出。")
        panel_divider()
        return False
    if gone["flag"] and len(records) != games:
        # 服务器把任务收走了（心跳 403/404，见 progress_loop）：不交也不还——
        # 服务器那边早已另有安排（回队冷却中/他人重领），还 /release 只会吃 403。
        # 已跑的局作废（结果按裁决不落盘），直接当无事发生，主循环领下一个。
        print(f"✗ 任务 {tid} 已被服务器收回（被剔除或租约回收），"
              f"已跑 {len(records)}/{games} 局作废，自动领下一个任务")
        panel_divider()
        return True
    if len(records) != games:
        print(f"⚠ solver 提前结束（{len(records)}/{games} 局），本任务作废不交")
        return True
    print(f"Finished! 总用时：{fmt_mmss(time.time() - st['t0'])}"
          f"  胜率：{100.0 * st['wins'] / games:.1f}% ({st['wins']}/{games})"
          f"  本任务solver峰值RAM：{child_rss_mb()}")
    payload = {"task_id": tid, "nonce": nonce, "name": name, "os": os_label(),
               "solver_ver": solver_ver, "client_ver": client_ver(), "records": records}
    for attempt in range(3):
        try:
            code, resp = http_json(server, "/result", payload, timeout=120)
        except Exception as e:
            if attempt < 2:
                print(f"⚠ 上报失败（{e}），30s 后重试 {attempt + 2}/3 …")
                time.sleep(30)
                continue
            print("✗ 上报 3 次未成，放弃本任务（结果已落盘，联网后自动补报）")
            save_pending(task, records)
            panel_divider()
            return True
        if code == 200:
            print(f"结果已上传 Seed:{task['seed']} {task['model']} {board} {games}局")
            panel_divider()
            return True
        if code == 409:
            print(f"✓ 服务器已有 {tid}（重复上报，丢弃）")
            panel_divider()
            return True
        # 服务器明确拒绝（含 410 超时不收）：重试无意义，直接下一个任务
        print(f"✗ 服务器拒绝（{code}）：{resp.get('error', '')}——本任务结果作废")
        panel_divider()
        return True
    return True


def main():
    if sys.stdout is None:   # pythonw.exe（Windows 后台）：没有控制台，日志顶上
        sys.stdout = open(LOG_PATH, "a", buffering=1, encoding="utf-8", errors="replace")
        sys.stderr = sys.stdout
    ap = argparse.ArgumentParser(description="复数扫雷求解器基准 · 分布式客户端")
    ap.add_argument("--server", default="https://ty0712.com:12712",
                    help="调度服务器（默认 ty0712 的 12712 TLS 入口；明文 7120 是过渡期老地址）")
    ap.add_argument("--solver", default=None, help="solver 二进制路径（默认自动找）")
    ap.add_argument("--name", default=socket.gethostname(), help="客户端名字（结果表里显示）")
    ap.add_argument("--detach", action="store_true",
                    help="后台跑：脱离终端，日志进 ~/cmsdist-client.log，终端窗口随手关")
    ap.add_argument("--status", action="store_true", help="看后台客户端还活着没 + 日志尾部")
    ap.add_argument("--stop", action="store_true", help="让后台客户端跑完当前任务后优雅退出")
    ap.add_argument("--pomodoro", default=None,
                    help="散热番茄钟 <连算>/<休息>（每段可带 h/m/s，如 25m/5m、1h30m/10m）；"
                         "off 关掉。没显式给就读环境变量 CMS_POMODORO，都没有按 25m/5m。"
                         "只歇在局与局之间，不会打断正在算的局")
    ap.add_argument("--detached", action="store_true", help=argparse.SUPPRESS)  # 内部：Windows 重拉标记
    a = ap.parse_args()
    if a.status:
        do_status()
        return
    if a.stop:
        do_stop()
        return
    if a.detach and not a.detached:
        do_detach()          # POSIX：父进程在此退出/子进程继续；Windows：重拉+退出
    elif a.detached:
        with open(PID_PATH, "w", encoding="utf-8") as f:
            f.write(str(os.getpid()))
    global _HEADLESS
    try:
        _HEADLESS = not sys.stdout.isatty()
    except Exception:
        _HEADLESS = True
    solver = find_solver(a.solver)
    solver_ver, solver_err = probe_solver_ver(solver)   # 编译期源码指纹；老 solver 为空串
    if solver_err:
        # 不领任务直接退：solver 起不来时继续跑就是「领了→0 局→作废→再领」的空转，
        # 白烧服务器队列，测试者那边只看到 Waiting 一直涨（2026-11-01 Win11 缺
        # libstdc++-6.dll 实测）。
        die(f"{solver_err}\n"
            f"  二进制：{solver}\n"
            f"  Windows 上多半是这个包太旧（旧版 solver 动态链接 mingw 运行时）——"
            f"请重新完整解压最新 zip，或向管理员要新包；mac/Linux 上检查文件权限。")
    if os.name == "nt":
        # 经典 conhost（Win10 的 cmd）默认不解析 ANSI/VT 转义序列，
        # 不开这个，TUI 的 \x1b[... 全被当字面字符打成乱码（Win10 实测踩过）。
        # 输出被重定向时 GetConsoleMode 拿不到控制台模式，静默跳过即可。
        try:
            k32 = ctypes.windll.kernel32
            h = k32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
            mode = ctypes.c_uint32()
            if k32.GetConsoleMode(h, ctypes.byref(mode)):
                k32.SetConsoleMode(h, mode.value | 0x0004)  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
        except Exception:
            pass
    # 双击启动器（.bat / .command）没法带参数，所以节奏也认环境变量 CMS_POMODORO：
    # 命令行 > 环境变量 > 默认 25m/5m。关的时候也要显式传 off —— solver 自己认同一个变量，
    # 「不传参数」等于放它去读环境，用户命令行里的 --pomodoro off 会被环境里的值翻盘。
    pomo = pomo_spec(a.pomodoro or os.environ.get("CMS_POMODORO") or "25m/5m") or "off"
    pomo_ok = probe_pomodoro(solver)
    if not pomo_ok:
        # 旧包的 solver 不认番茄钟参数：传过去就是「用法退出 → 0 局 → 任务作废」空转，
        # 所以本机计时与调度相位一起降级为不传，并把原因说出来（静默失效会被当成「功能坏了」）。
        print("⚠ 当前 solver 不认番茄钟参数（包太旧），本机计时与调度相位本次都未启用；"
              "客户端会自动更新 solver 二进制，更新后生效")
        pomo = ""
    else:
        print(f"☕ 本机番茄钟：{pomo}（只在局与局之间歇，最后一局算完不歇）；"
              f"改节奏用 --pomodoro 1h30m/10m 或环境变量 CMS_POMODORO，关掉用 off")
    stop = {"flag": False}
    abort = {"flag": False}
    gone = {"flag": False}   # 服务器明确收回当前任务（心跳 403/404），见 progress_loop
    sigs = {"n": 0, "last": 0.0}

    def on_sig(signum, _frame):
        now = time.time()
        # 终端里按住 Ctrl+C 会连发：3s 内的后续按键一律当没按，
        # 否则一次长按被判成两次、任务直接被放弃（Win10 实测踩过）
        if sigs["n"] and now - sigs["last"] < 3.0:
            return
        sigs["last"] = now
        sigs["n"] += 1
        if sigs["n"] == 1:
            stop["flag"] = True
            st = cur_st["st"]
            if st:
                remain = st["games_total"] - st["n"]
                eta_sec = _eta_sec(st)      # 与面板同一个数：已完成所有局的均值
                eta = fmt_mmss(eta_sec) if eta_sec is not None else "--"
                # 不能在这里 print——光标被挪走会撞坏面板的相对重画（踩过），写提示行由面板画
                hint["msg"] = (f"⏸ 已收到 Ctrl+C：跑完当前任务后退出（还剩 {remain} 局，约 {eta}）；"
                               f"再按一次放弃任务并立即还回队列")
            else:
                print("\n\x1b[1;31m收到 Ctrl+C：正在退出（当前没有在跑的任务）……\x1b[0m")
            if signum != signal.SIGINT:
                # 关终端窗口（SIGHUP）/ kill（SIGTERM）：tty 已经没了，之后每句 print
                # 都会抛 OSError，优雅上传会中途摔死。stdout/stderr 切到 /dev/null，
                # 静默跑完当前任务并把结果交上去。后台模式本来就写的日志文件，别切。
                try:
                    if sys.stdout is None or sys.stdout.isatty():
                        sys.stdout.flush()
                        devnull = os.open(os.devnull, os.O_WRONLY)
                        os.dup2(devnull, 1)
                        os.dup2(devnull, 2)
                except (OSError, ValueError, AttributeError):
                    pass
        else:
            abort["flag"] = True
            stop["flag"] = True
            hint["msg"] = "⏹ Ctrl+C ×2：放弃当前任务，还回队列中……"
            p = cur_proc["p"]
            if p and p.poll() is None:
                p.kill()  # solver 一死，输出管道 EOF，主循环走放弃分支

    # Ctrl+C 之外，关终端窗口（SIGHUP）/ kill（SIGTERM）也走同一个优雅出口：
    # 跑完当前任务、把结果交上去再退——否则任务在服务器挂到租约才回收。
    # Windows 关窗口走 SIGBREAK，一并接住。
    for sig in [getattr(signal, name) for name in
                ("SIGINT", "SIGHUP", "SIGTERM", "SIGBREAK") if hasattr(signal, name)]:
        try:
            signal.signal(sig, on_sig)
        except (OSError, ValueError, AttributeError):
            pass
    # 两个身份分开报：solver 指纹说的是**求解器**，客户端哈希说的是**这份程序字节**。
    # 更新是逐文件换的，「新 py + 老 solver.exe」这种半更新只有两个一起看才看得出。
    print(f"cmsdist 客户端：server={a.server}  solver={solver}"
          + (f"（{solver_ver}）" if solver_ver else "（未知版本）")
          + f"  客户端 {client_ver() or '未知'}  name={a.name}")
    print("Ctrl+C：跑完当前任务后退出；再按一次立即退出并还回任务。")
    solver_is_bundled = a.solver is None
    while not stop["flag"]:
        if os.path.exists(STOP_PATH):
            try:
                os.unlink(STOP_PATH)
            except OSError:
                pass
            stop["flag"] = True
            print("\n收到停止标记：跑完当前任务后退出 …")
            if not cur_st["st"]:
                break
        check_self_update(a.server, solver_is_bundled)   # 失败静默，见函数注释
        flush_pending(a.server, a.name)
        try:
            code, task = http_json(a.server, "/claim",
                                   {"name": a.name, "os": os_label(), "solver_ver": solver_ver,
                                    "client_ver": client_ver()},
                                   timeout=60)
        except Exception as e:
            print(f"⚠ 领任务失败（{e}），30s 后重试 …")
            time.sleep(30)
            continue
        if code == 429:
            print("⏳ 该 IP 并发任务已满，60s 后再试 …")
            time.sleep(60)
            continue
        if code != 200:
            print(f"✗ 领任务被拒（{code}）：{task.get('error', '')}，30s 后重试")
            time.sleep(30)
            continue
        if task.get("paused"):
            # 「暂停发放」是管理口径，测试者只想知道能歇会儿 —— 番茄钟的休息照实说「休息一下」，
            # 并把到点时间给出来（管理员手动暂停仍然说「暂停发放」，那不是休息，是别来占机器）
            if task.get("reason") == "pomodoro":
                left = task.get("rest_left")
                if isinstance(left, (int, float)) and left > 0:
                    nxt = min(60, max(5, round(left)))
                    print(f"☕ 休息一下，还剩 {fmt_mmss(left)}（{nxt}s 后再查）…")
                    time.sleep(nxt)
                else:
                    print("☕ 休息一下（服务器到了休息段），60s 后再查 …")
                    time.sleep(60)
                continue
            print("⏸ 服务器已暂停发放，60s 后再查 …")
            time.sleep(60)
            continue
        if stop["flag"]:
            # Ctrl+C 落在领任务的空当：退出信号已吭过声（红字），这里把刚领到的
            # 任务立刻还回队列，不多跑一个「额外的当前任务」；还不回去就等租约回收
            try:
                http_json(a.server, "/release",
                          {"task_id": task["task_id"], "nonce": task["nonce"]}, timeout=30)
            except Exception:
                pass
            break
        if not run_one(a.server, a.name, task, solver, solver_ver, stop, abort, gone,
                       pomo, pomo_ok):
            break
        gone["flag"] = False   # 每个任务一份：跳过被收走的任务后照常继续
    try:  # 被信号杀掉的极端情况下终端还停在「关自动换行」，退场前兜底恢复
        if sys.stdout is not None and sys.stdout.isatty():
            sys.stdout.write("\x1b[?7h")
            sys.stdout.flush()
    except (OSError, ValueError, AttributeError):
        pass
    print("\n收到退出信号，收工。")
    try:
        if _read_pid() == os.getpid():
            os.unlink(PID_PATH)
    except OSError:
        pass


if __name__ == "__main__":
    main()
