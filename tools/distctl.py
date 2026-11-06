#!/usr/bin/env python3
# distctl.py — 复数扫雷求解器基准 · 管理界面（仿 cms：本机命令，SSH 到服务器执行）
#
# 用法：
#   distctl.py status                          # 总览：队列/进行中/完成 + 结果表 + 各模式胜率
#   distctl.py default <complex|classic> [CxRxM] [games]   # 设默认任务流
#   distctl.py insert <n> <complex|classic> [CxRxM] [games] [起种子]   # 插队
#   distctl.py pause | resume | clear-queue    # 暂停发放 / 恢复 / 清优先队列
#   distctl.py kick <task_id> [...]            # 剔除进行中的任务（收回队列，60s 冷却）
#   distctl.py rm <task_id> [...]              # 删掉队列里的任务（在跑的先 kick）
#   distctl.py cool <Dd> [Hh] [Mm] [Ss]        # 回收冷却（0 = 关掉），默认 1m
#   distctl.py seed <下一个种子>               # 改下一个种子（发放会自动跳过已完成的种子+规模）
#   distctl.py limit <n>                       # 改每 IP 并发上限
#   distctl.py lease <Xh> [Ym]                 # 改领用超时（默认 2h）
#   distctl.py pomo <on|off|set <跑>/<歇>|status>   # 调度番茄钟：到点停发货 + 在跑的局间歇
#   distctl.py invalidate <task_id|ip:ADDR|name:NAME>      # 作废可疑结果
#   distctl.py export > results.json           # 导出全部逐局记录（默认排除作废项）
#                                              #   ⚠ 全量在服务器内存拼（上 GB），线上别跑！
#   distctl.py agg <complex|classic> C R M     # 逐局级流式聚合（安全，逐局统计用这条）
#
# 除 status / export 外一律要管理口令（stdin 喂，不进 argv）。
#
# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>；CMSDIST_SSH 环境变量可整体覆盖。

import getpass
import json
import os
import subprocess
import sys
import time
from pathlib import Path


def die(msg, code=1):
    print(msg, file=sys.stderr)
    sys.exit(code)


def _deploy_env() -> dict:
    env = {}
    p = Path.home() / ".cmsdist" / "deploy.env"
    if p.is_file():
        for line in p.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


_DEP = _deploy_env()
CMS_HOST = os.environ.get("CMSDIST_SSH_HOST") or _DEP.get("CMS_HOST", "")
CMS_PORT = os.environ.get("CMSDIST_SSH_PORT") or _DEP.get("CMS_SSH_PORT", "")
if not (CMS_HOST and CMS_PORT):
    die("缺 SSH 目标：建 ~/.cmsdist/deploy.env，写两行："
        "CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>"
        "（或用 CMSDIST_SSH_HOST / CMSDIST_SSH_PORT 环境变量临时覆盖）")
REMOTE = os.environ.get("CMSDIST_SSH") or f"{CMS_HOST} -p {CMS_PORT}"
REMOTE_PY = "/opt/cmsdist/dist_server.py"
#: 2026-10-31 起所有写操作一律要管理口令（与服务器端 admin_cmds 的 needs_pw 同步）
GUARDED = {"admin-default", "admin-insert", "admin-pause", "admin-resume",
           "admin-clear-queue", "admin-lease", "admin-seed", "admin-limit",
           "admin-invalidate", "admin-kick", "admin-dequeue", "admin-cool",
           "admin-drop", "admin-pomo"}


#: 所有远端调用都开 ssh 压缩（`-C`）。`admin-status` 一次回 674 KB，其中 1661 条
#: 已完成任务的明细字段名逐条重复，gzip 后只剩 60 KB（9%）——传输是这条链路上
#: 唯一白捡的一截。握手不是瓶颈：实测 ControlMaster 复用连接不省时间（建连本身 0.73s）。
SSH_OPTS = ["-C"]


def remote_argv(admin_cmd, args):
    """构造远端 admin 命令的 argv。ctl_ui 也用它——SSH 目标/转义/选项只此一份，防漂移。"""
    return ["ssh"] + SSH_OPTS + REMOTE.split() + [
        f"python3 {REMOTE_PY} {admin_cmd} "
        + " ".join("'" + a.replace("'", "'\\''") + "'" for a in args)]


def run_remote(admin_cmd, args, stdin_data=None):
    """执行远端 admin 命令，成功返回 stdout，失败 die。stdin_data 原样喂给远端。"""
    p = subprocess.run(remote_argv(admin_cmd, args), input=stdin_data,
                       capture_output=True, text=True)
    if p.returncode != 0:
        die(f"远端执行失败（{admin_cmd}）：\n{p.stderr.strip()}", p.returncode or 1)
    return p.stdout


def remote(admin_cmd, args, needs_pw=False):
    stdin_data = getpass.getpass("管理口令：") + "\n" if needs_pw else None
    return run_remote(admin_cmd, args, stdin_data)


def load_state():
    raw = remote("admin-status", [])
    try:
        return json.loads(raw)
    except Exception:
        die(f"status 输出不是 JSON：\n{raw[:500]}")


def cmd_status():
    st = load_state()
    cfg = st["config"]
    d = cfg["default"]
    paused = "⏸ 已暂停" if cfg.get("paused") else "运行中"
    lease_h = cfg.get("lease_sec", 7200) / 3600
    print(f"默认流: {d['model']} {d['cols']}x{d['rows']}x{d['mines']} × {d['games']}局   "
          f"下一个种子: {cfg['seed_next']}   lease: {lease_h:.2f}h   [{paused}]")
    # 番茄钟跟「暂停」是两回事：一个是节拍到点自动歇，一个是人手动停 —— 只报后者会看漏
    ph = st.get("pomo") or {}

    def _dur(s):
        s = int(round(s or 0))
        h, m, sec = s // 3600, s % 3600 // 60, s % 60
        return f"{h}h{m:02d}m{sec:02d}s" if h else f"{m}m{sec:02d}s"

    if ph.get("on"):
        stage = "☕ 休息一下（不发新任务）" if ph.get("in_rest") else "连算中"
        left = "后恢复发放" if ph.get("in_rest") else "后进入休息"
        print(f"番茄钟: 开 连算 {_dur(ph.get('work_sec'))} / 歇 {_dur(ph.get('rest_sec'))}"
              f"（全舰队统一相位）→ {stage}，{left}还有 {_dur(ph.get('left'))}")
    else:
        print(f"番茄钟: 未开（任务一直发）；两段时长记为 连算 {_dur(ph.get('work_sec'))} / "
              f"歇 {_dur(ph.get('rest_sec'))}")
    # 两个身份一起报：更新是**逐文件**换的，「客户端换了、solver.exe 因为在用换不动」
    # 这种半更新只看求解器指纹完全隐形（Windows 上的常态）。老包两个字段都没有 = 未上报。
    pairs = {}
    for t in st["inprog"]:
        k = (t.get("solver_ver") or "未上报", t.get("client_ver") or "未上报")
        pairs[k] = pairs.get(k, 0) + 1
    print("线上在跑: " + ("、".join(f"求解器 {s} + 客户端 {c} ×{n} 终端"
                                  for (s, c), n in sorted(pairs.items(), key=lambda kv: -kv[1]))
                       if pairs else "当前没有任务"))
    print(f"优先队列: {len(st['queue'])}   进行中: {len(st['inprog'])}   完成: {len(st['done'])}")
    if st["queue"]:
        print("\n—— 优先队列（先发）——")
        for q in st["queue"][:10]:
            print(f"  {q['task_id']}  {q['model']} {q['cols']}x{q['rows']}x{q['mines']} × {q['games']}")
        if len(st["queue"]) > 10:
            print(f"  … 共 {len(st['queue'])} 个")
    if st["inprog"]:
        print("\n—— 进行中 ——")
        for t in st["inprog"]:
            print(f"  {t['task_id']}  {t['model']}  {t['ip']:<15} {t['name'] or '-':<12} 已 {t['claimed_min_ago']}min")
    agg = st["aggregate"]
    if agg:
        print("\n—— 合计（有效结果）——")
        for model, a in sorted(agg.items()):
            print(f"  {model:<8} {a['tasks']} 任务  {a['games']} 局  胜率 {100.0 * a['wins'] / a['games']:.1f}%")
    done = sorted(st["done"].items(), key=lambda kv: kv[1]["time"], reverse=True)
    if done:
        print(f"\n—— 最近结果（最多 30 条；× = 已作废）——")
        for tid, r in done[:30]:
            mark = "×" if not r.get("valid", True) else " "
            rate = 100.0 * r["wins"] / r["games"] if r["games"] else 0.0
            t = time.strftime("%m-%d %H:%M", time.localtime(r["time"]))
            print(f" {mark} {tid:<22} {r['model']:<8} {r['cols']}x{r['rows']}x{r['mines']:<4} "
                  f"{r['games']:>5}局 胜率{rate:5.1f}%  {r['ip']:<15} {r.get('name') or '-':<12} {t}")
        if len(done) > 30:
            print(f"  … 共 {len(done)} 条（export 可导全部）")


def cmd_export():
    raw = remote("admin-export", [])
    try:
        rows = json.loads(raw)
    except Exception:
        die(f"export 输出不是 JSON：\n{raw[:300]}")
    valid = [r for r in rows if r.get("valid", True)]
    print(json.dumps(valid, ensure_ascii=False, indent=1))
    print(f"/* {len(valid)} 条有效（共 {len(rows)} 条，作废项已排除）*/", file=sys.stderr)


def cmd_agg(args):
    """逐局级流式聚合（服务器侧一次只解压一个 blob，只回 KB 级）。
    admin-export 是全量内存拼——2026-11-05 在线上拉全量把机器推进 OOM（docs 红线），
    逐局级统计一律走这条。"""
    if len(args) != 4 or args[0] not in ("complex", "classic") \
            or not all(x.isdigit() for x in args[1:]):
        die("用法：distctl agg <complex|classic> <cols> <rows> <mines>   "
            "例：distctl agg complex 30 16 99")
    raw = remote("admin-agg", args)
    try:
        d = json.loads(raw)
    except Exception:
        die(f"admin-agg 输出不是 JSON：\n{raw[:300]}")
    g, w = d["games"], d["wins"]
    print(f"{d['model']} {d['cols']}x{d['rows']}x{d['mines']}  "
          f"{d['tasks']} 任务 {g} 局  胜率 {100.0 * w / g if g else 0:.1f}%")
    print(f"  平均每局猜 {d['guesses'] / g if g else 0:.2f} 次；"
          f"陷阱猜 {d['trap_total']} 次（{d['trap_games']} 局有）；无猜胜 {d['zero_games']} 局；"
          f"平均每局 {d['sec_mean']:.2f}s")
    print("  猜雷次数直方图（次数: 局数 / 胜率 / 陷阱猜局占比）:")
    for k, b in d["hist"].items():
        n, wins_ = b["games"], b["wins"]
        label = f"{k}+" if int(k) > 99 else k
        print(f"    {label:>4}: {n:>8} 局  胜率 {100.0 * wins_ / n if n else 0:5.1f}%"
              f"  陷阱猜局 {100.0 * b['trap'] / n if n else 0:5.1f}%"
              f"  无猜胜标记 {b['zero']}")


def main():
    if len(sys.argv) < 2:
        die(__doc__)
    cmd, args = sys.argv[1], sys.argv[2:]
    table = {
        "status": ("admin-status", [], False),
        "default": ("admin-default", args, True),
        "insert": ("admin-insert", args, True),
        "pause": ("admin-pause", [], True),
        "resume": ("admin-resume", [], True),
        "clear-queue": ("admin-clear-queue", [], True),
        "lease": ("admin-lease", args, True),
        "seed": ("admin-seed", args, True),
        "limit": ("admin-limit", args, True),
        "invalidate": ("admin-invalidate", args, True),
        "kick": ("admin-kick", args, True),
        "drop": ("admin-drop", args, True),
        "rm": ("admin-dequeue", args, True),
        "cool": ("admin-cool", args, True),
        "pomo": ("admin-pomo", args, True),
        "export": ("admin-export", [], False),
    }
    if cmd == "status":
        cmd_status()
        return
    if cmd == "export":
        cmd_export()
        return
    if cmd == "agg":
        cmd_agg(args)
        return
    if cmd not in table:
        die(__doc__)
    admin_cmd, fwd, needs_pw = table[cmd]
    print(remote(admin_cmd, fwd, needs_pw).strip())


if __name__ == "__main__":
    main()
