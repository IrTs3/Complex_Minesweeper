#!/usr/bin/env python3
"""密码管理工具的**本地可视化界面**（只在本机可访问）。

    python3 /Users/wenweiqi/CLionProjects/Project/tools/gate_ui.py            # 起服务，终端会打印一个带 token 的网址
    python3 /Users/wenweiqi/CLionProjects/Project/tools/gate_ui.py --port 8730

为什么是「本地网页」而不是桌面程序
----------------------------------
这个项目的视觉体系（#66ccff、浅色主题、系统字体）本来就在 Web 侧，
而密码表要展示的东西——表格、筛选、有效期倒计时、访问时间线——用 HTML 做
比 tkinter 省力得多。且**零新增依赖**：只用 Python 标准库起一个 http.server。

⚠️ 但网页形态带来一个必须正面处理的攻击面
------------------------------------------
本地起了 HTTP 服务之后，**浏览器里任意一个恶意网页都可能向
`127.0.0.1:<端口>` 发请求**（CSRF），甚至用 DNS rebinding 伪装成同源。
而这个工具能改密码、能踢人、能开关整站闸门——被 CSRF 一次就是全站失守。

所以这里有**四层**防护，缺一不可（每一层都对应一种真实攻击手法）：

  1. **只绑 127.0.0.1**（不是 0.0.0.0）：局域网里的机器连不上。
  2. **一次性 token**：启动时生成，只有终端里那个网址带它。
     别的进程/网页猜不到（`secrets.token_urlsafe(32)`）。没 token 一律 403。
     校验通过后换成 `HttpOnly; SameSite=Strict` 的 cookie，并把 token 从
     地址栏抹掉（免得留在浏览器历史里）。
  3. **Host 头白名单**：只接受 `127.0.0.1:<port>` / `localhost:<port>`。
     这是**挡 DNS rebinding 的关键**——攻击者把自己的域名解析到 127.0.0.1，
     浏览器就以为是同源；但它发来的 Host 是那个域名，在这里被拒。
  4. **必须带自定义头 `X-CMSUI: 1`**：跨站表单发不出自定义头，
     而带自定义头的跨站请求会触发 CORS 预检，本服务不响应预检 → 被浏览器拦下。

另外**写操作不做任何自己的权限判断**，而是转调原 CLI（`gate_manager.py`）：

    · 「哪些命令需要管理口令」从 `gate_manager.ADMIN_GUARDED_CMDS` **导入**，
      不在这里另抄一份（抄一份就迟早会漂移）。
    · 口令通过 stdin 喂（`--admin-stdin`），**不进 argv**——argv 对同机任何
      进程可见（`ps aux`）。
    · 真正的校验仍然发生在 CLI 里。**界面没有任何办法绕过那道门。**

用法提示
--------
    · 打印出来的网址**不要**贴给别人/发到聊天里——它就是钥匙。
    · 服务只在内存里持有 token，进程一退就失效；重新起会换新的。
    · 不想开界面时，原来那套命令一个字都没变，照常用。
"""
from __future__ import annotations

import argparse
import contextlib
import hmac
import http.server
import importlib.util
import io
import json
import os
import re
import secrets
import subprocess
import sys
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
ASSET_DIR = HERE / "gateui"
#: 种子工具箱用：与游戏**同一份**编解码器（web/dist/seedcodec.js，tsc 产物）。
#: 放在前端跑而不在 Python 里重写一份 Rabbit+base64 —— 第三份实现迟早和两端漂移。
SEEDCODEC_JS = HERE.parent / "web" / "dist" / "seedcodec.js"

#: 本进程的启动时刻，用来发现「源码比进程新」。
#:
#: 前端资源（`index.html` / `app.js` / `app.css`）是**每次请求从磁盘读**的，
#: 改了刷新就生效；但 **本文件是被 Python 载入内存的**，改了必须重启进程。
#: 这会造出一个极易误判的局面：页面看着是新的、行为却是旧的——2026-10-17 就踩过：
#: 新前端去调新接口，旧进程不认那些参数，结果「只有时间列能筛，别的列全空」。
#: 所以这里记下启动时刻，`/api/overview` 回报 `stale`，界面直接用红字说出来。
STARTED_AT = time.time()
TOOL = HERE / "gate_manager.py"

#: 游戏站对外地址的前缀——「复制入口链接」时拼在路径前面，给出一条能直接发人的完整网址。
#:
#: 为什么放在这里而不是 CLI：gate_manager 的 `gate-path status` 刻意**只回路径**，
#: 整站的对外地址（IP/域名/端口）不归那个工具决定（见它的注释），免得长出第二份
#: 「站点地址」真相。cmsui 是这套部署唯一的管理界面，前缀由它持有一份：
#: 日后备案下来换域名或上 HTTPS，改这里（或环境变量 CMSGATE_SITE）一处即可。
#: 只存前缀、不存 token：token 永远只从 CLI 的只读接口来。
#: 2026-10-20 明文收口后改成域名 + https：IP:8080 已收回环，复制出去别人打不开。
SITE_ORIGIN = os.environ.get("CMSGATE_SITE", "https://ty0712.com").rstrip("/")

# --------------------------------------------------------------------------
# 载入 gate_manager 作为模块：复用它的**唯一一份**校验与解析逻辑
# --------------------------------------------------------------------------
#
# 用 importlib 按路径载入，而不是 `import gate_manager`：
# 后者要求 tools/ 在 sys.path 上，而这个名字太泛，容易和别处的东西撞车。


def _load_gate_manager():
    spec = importlib.util.spec_from_file_location("cmsgate_manager", TOOL)
    if spec is None or spec.loader is None:                       # pragma: no cover
        raise SystemExit(f"载入失败：{TOOL}")
    mod = importlib.util.module_from_spec(spec)
    # 注意：**不要**把本模块放进 sys.modules。gate_manager 的 main() 会读
    # sys.argv，而我们在调用它时用的是 subprocess（另一个进程），互不影响。
    spec.loader.exec_module(mod)
    return mod


gm = _load_gate_manager()


class ApiError(Exception):
    """带 HTTP 状态码的业务错误。前端拿到 {ok:false, error}。"""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.message = message
        self.status = status


def safe_call(fn, *args, **kwargs):
    """调用 gate_manager 里的函数，把它的 `die()` 转成可回给前端的错误。

    gate_manager 用 `die()` 报错、而 `die()` 会 `sys.exit()`。在 CLI 里那没问题，
    但在服务进程里会直接杀掉整个服务。所以这里捕获 SystemExit，
    并把它写进 stdout/stderr 的那段说明**原样**捞出来回给前端。

    直接复用这些函数（而不是重写一遍读取逻辑）是刻意的：
    密码表的校验规则（版本、KDF 参数、字段上限）只有一份实现。
    """
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(buf):
            return fn(*args, **kwargs)
    except SystemExit as e:
        msg = buf.getvalue().strip() or f"{fn.__name__} 失败"
        # die() 的 code 就是有意义的退出码（0 = 其实成功）
        code = getattr(e, "code", 1) or 0
        if code == 0:
            return None
        raise ApiError(msg, 400) from None
    except ApiError:
        raise
    except Exception as e:                                        # noqa: BLE001
        raise ApiError(f"{type(e).__name__}: {e}", 500) from None


# --------------------------------------------------------------------------
# 允许通过界面执行的操作
# --------------------------------------------------------------------------
#
# 这份表是**白名单**：界面能做的事就是这些，之外一概拒绝。
#
# 每条声明三件事，**不含任何权限判断**（权限由 CLI 自己判）：
#   argv   : 命令行参数；{name} 会被 params[name] 替换
#   stdin  : [(参数名, 启用这一行的 flag)]，**按顺序**喂给 stdin
#   expiry : True 表示由 params["expiry"] 拼 --hours/--days/--until/--never
#   force  : 若 params["force"] 为真则追加这个 flag
#   len    : 若 params["len"] 有值则追加 --len
#
# ★ 为什么 stdin 要「一行配一个 flag」，而不是统一写 --admin-stdin：
#   CLI 里**两类命令喂口令的参数名不一样**——
#     · 普通写操作（add / rm / push …）走 `_add_admin_args` → `--admin-stdin`
#     · gate / admin-* 走它们自己的 `--password-stdin`
#   一律写 --admin-stdin 会让 `gate on` 直接 argparse 报「无法识别的参数」。
#   这个错很容易写出来，所以 `_verify_ops()` 会用每个命令**自己的 --help**
#   核对这里出现的每个 flag 是否真被接受，对不上就拒绝启动。
#
# ★ 顺序也是契约：add / passwd 必须**先管理口令、再新密码**——
#   CLI 的 main() 先 require_admin() 读第一行，之后 cmd_* 才读第二行。
#   反了会表现为「口令莫名其妙不对」，极难排查（见 gate_manager._stdin_line）。

OPS = {
    # ── 只读（不需要管理口令）──
    "list":         {"argv": ["list"]},
    "show":         {"argv": ["show", "{id}"]},
    "usage":        {"argv": ["usage", "--limit", "{limit}"]},
    "usage_remote": {"argv": ["usage", "--remote", "--limit", "{limit}"]},
    "gate_status":  {"argv": ["gate", "status"]},
    "selftest":     {"argv": ["selftest"]},
    # 本地还没有密码表时用它建空表（不受管理口令保护——它不碰线上状态，
    # 也不产生任何凭据，只是把文件建出来）。
    "init":         {"argv": ["init"]},

    # ── 写：密码表条目（口令走 --admin-stdin）──
    "add": {"argv": ["add", "--label", "{label}", "--note", "{note}"],
            "stdin": [("admin", "--admin-stdin"), ("newpw", "--password-stdin")],
            "len": True, "expiry": True},
    "passwd": {"argv": ["passwd", "{id}"],
               "stdin": [("admin", "--admin-stdin"), ("newpw", "--password-stdin")],
               "len": True},
    "rm":      {"argv": ["rm", "{id}", "--yes"], "stdin": [("admin", "--admin-stdin")]},
    "disable": {"argv": ["disable", "{id}"], "stdin": [("admin", "--admin-stdin")]},
    "enable":  {"argv": ["enable", "{id}"], "stdin": [("admin", "--admin-stdin")]},
    "note":    {"argv": ["note", "{id}", "--label", "{label}", "--note", "{note}"],
                "stdin": [("admin", "--admin-stdin")]},
    "expire":  {"argv": ["expire", "{id}"], "stdin": [("admin", "--admin-stdin")],
                "expiry": True, "expiry_required": True},

    # ── 写：影响线上状态 ──
    "push":       {"argv": ["push"], "stdin": [("admin", "--admin-stdin")],
                   "force": "--force"},
    "pull":       {"argv": ["pull"], "stdin": [("admin", "--admin-stdin")],
                   "force": "--force"},
    "revoke-all": {"argv": ["revoke-all", "--yes"],
                   "stdin": [("admin", "--admin-stdin")]},

    # ── 网页背景图（版权未授权 → 要能一键撤下成白底）──
    # status 只读；on/off/push 的管理口令走 --admin-stdin（cmd_webbg 就地校验）。
    "webbg_status": {"argv": ["webbg", "status", "--json"]},
    "webbg_on":     {"argv": ["webbg", "on"], "stdin": [("admin", "--admin-stdin")]},
    "webbg_off":    {"argv": ["webbg", "off"], "stdin": [("admin", "--admin-stdin")]},
    # ★ 用 `force` 而不是 `{desktop}` 占位符：占位符在值为空时会填成空串，
    #   变成 `--desktop ""` —— argparse 把**任何非空字符串**都当真值，
    #   于是"没勾也生效"，用户以为没勾桌面端、结果图标被换了。
    #   `force` 的语义正是「为真才追加这个 flag」。
    # ★ 三个 flag 用 `flags` 机制而不是 `{name}` 占位符：占位符在值为空时会填成
    #   空串，变成 `--mac ""` —— argparse 把**任何非空字符串**都当真值，
    #   于是「没勾也生效」，用户以为只选了 mac、结果两端都换了。
    #   `flags` 的语义正是「只给勾中的那些」。
    # ★ `--desktop` 一个 flag 就够：两端同源，分开给 flag 只能控制
    #   「更新哪几个产物目录」，不是「用不同的图」。界面也只有一个复选框。
    #   `--mac` / `--win` 仍在 CLI 上（脚本能用），界面不再区分。
    # ★ timeout：勾了桌面端会**真的重新打包**（mac 复用二进制重做 .app/zip/dmg，
    #   win 重编 exe 把图标塞进去）。默认 120 秒不够 —— 首次 win 打包要编
    #   freetype/SFML，可能 4~8 分钟。给 20 分钟，别在打包中途把进程杀掉。
    "webbg_push":   {"argv": ["webbg", "push", "--image", "{image}"],
                     "stdin": [("admin", "--admin-stdin")],
                     # ★ 必须用 flags（key = 前端载荷里的字段名），**不能**用 force。
                     #   force 读的是 params["force"]，而界面发的是 desktop ——
                     #   参数名对不上，flag 就永远不追加，桌面端整段悄悄不执行：
                     #   勾了也白勾、裁剪器照弹、图却只换网页端。
                     #   2026-10-18 真发生过（合并复选框那次的回归）。
                     "flags": [("desktop", "--desktop")],
                     # 用户裁的那块图标必须传给 CLI（它是两端图标的唯一源）
                     "value_flags": [("icon", "--icon")],
                     "timeout": 1200},

    # ── 总开关：cmd_gate 就地校验，用它自己的 --password-stdin ──
    "gate_on":  {"argv": ["gate", "on"], "stdin": [("admin", "--password-stdin")]},
    "gate_off": {"argv": ["gate", "off"], "stdin": [("admin", "--password-stdin")]},

    # ── 默认页：游戏 or 学习站（监管要求根路径能切到公开学习内容）──
    # status 只读；learn/game 的管理口令走 --admin-stdin（cmd_landing 就地校验）。
    # 界面不重写任何 nginx 逻辑——一律转调 cms landing，回滚/审计都复用 CLI 那份。
    "landing_status": {"argv": ["landing", "status", "--json"]},
    "landing_learn":  {"argv": ["landing", "learn"], "stdin": [("admin", "--admin-stdin")]},
    "landing_game":   {"argv": ["landing", "game"], "stdin": [("admin", "--admin-stdin")]},

    # ── 秘密登录入口：/gate/<TOKEN>/ ──
    # status 只读；set/rotate 的管理口令走 --admin-stdin（cmd_gate_path 就地校验）。
    # token 的**校验发生在 CLI 里**（^[a-z0-9]{12,32}$，且在任何远端动作之前）——
    # 界面不抄一份规则，免得两处口径漂。传空串 = CLI 直接拒绝。
    "gate_path_status": {"argv": ["gate-path", "status", "--json"]},
    # token 走 **stdin**，不进 argv：argv 对同机任意进程可见（`ps aux`），而 token 就是
    # 唯一登录凭据（2026-10-21 审计 ★8）。stdin 的顺序即契约 —— CLI 里先读 token
    # （set 分支），再由 `require_admin` 读管理口令，所以 token 必须排在前面。
    "gate_path_set":    {"argv": ["gate-path", "set"],
                         "stdin": [("token", "--token-stdin"), ("admin", "--admin-stdin")]},
    "gate_path_rotate": {"argv": ["gate-path", "rotate"],
                         "stdin": [("admin", "--admin-stdin")]},

    # ── 管理口令自身 ──
    # 更换：先「当前口令」再「新口令」；一个 --password-stdin 覆盖两次读，
    # 所以第二行不重复加 flag（写 None）。
    "admin_passwd": {"argv": ["admin-passwd"],
                     "stdin": [("current", "--password-stdin"), ("newpw", None)]},
    # 首次设置：此时还没有口令可校验（bootstrap 路径，只靠 SSH 私钥）。
    "admin_init": {"argv": ["admin-init"],
                   "stdin": [("newpw", "--password-stdin")]},
}


def _op_command(spec: dict) -> str:
    """取一条操作对应的 CLI 子命令名（argv 里第一个既非选项也非占位符的 token）。"""
    return next(t for t in spec["argv"] if not t.startswith("-") and not t.startswith("{"))


def _authoritative_commands() -> set[str]:
    """从 CLI 自己的 `--help` 里取出权威的子命令表。

    不硬编码命令名、也不去正则扒源码：argparse 打印的 `{a,b,c}` 就是它真正认识的。
    """
    try:
        r = subprocess.run([sys.executable, str(TOOL), "--help"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        raise SystemExit(f"跑不了 {TOOL} --help：{e}")
    m = re.search(r"\{([a-z][a-z0-9,\-]*)\}", r.stdout)
    if not m:
        raise SystemExit("无法从 --help 解析出子命令表，拒绝启动（宁可不开也别瞎猜）")
    return set(m.group(1).split(","))


def _verify_ops() -> None:
    """启动自检：界面这张表必须与 CLI **真实接受**的参数逐条对得上。

    三段检查，每一段都对应一种「点了按钮才发现」的故障：
      ① 命令名存在        —— 否则 subprocess 报 unrecognized arguments
      ② 每个 flag 被接受   —— 否则 argparse 报错（如把 gate 的 --password-stdin
                              写成 --admin-stdin）。核对方式是**跑该命令自己的
                              --help**，不是靠我记住。
      ③ 受保护命令喂了口令 —— 受保护却没喂 admin 行，子进程会去 getpass，
                              没有 TTY 就直接失败，前端只看到一句「已取消」。

    任何一条不过就拒绝启动：**宁可这个界面开不起来，也不要开起来之后
    让用户在某个按钮上反复失败却看不出原因。**
    """
    real = _authoritative_commands()
    used = {_op_command(s) for s in OPS.values()}
    missing = used - real
    if missing:
        raise SystemExit(f"界面用到了 CLI 里不存在的命令：{sorted(missing)}\n"
                         f"  CLI 实际支持：{sorted(real)}")

    help_cache: dict[str, str] = {}

    def cmd_help(cmd: str) -> str:
        if cmd not in help_cache:
            try:
                r = subprocess.run([sys.executable, str(TOOL), cmd, "--help"],
                                   capture_output=True, text=True, timeout=60)
            except (OSError, subprocess.SubprocessError) as e:
                raise SystemExit(f"跑不了 {cmd} --help：{e}")
            help_cache[cmd] = r.stdout + r.stderr
        return help_cache[cmd]

    problems: list[str] = []
    for op, spec in OPS.items():
        cmd = _op_command(spec)
        text = cmd_help(cmd)
        flags = {t for t in spec["argv"] if t.startswith("--")}
        flags |= {f for _, f in spec.get("stdin", []) if f}
        if spec.get("force"):
            flags.add(spec["force"])
        flags |= {f for _, f in spec.get("flags", []) if f}
        flags |= {f for _, f in spec.get("value_flags", []) if f}
        if spec.get("len"):
            flags.add("--len")
        if spec.get("expiry"):
            flags |= {"--hours", "--days", "--until", "--never"}
        for f in sorted(flags):
            if f not in text:
                problems.append(f"{op}: `{cmd}` 不接受 {f}")
    if problems:
        raise SystemExit("界面的参数与 CLI 对不上（用户点了只会看到一句报错）：\n  "
                         + "\n  ".join(problems))

    for op, spec in OPS.items():
        cmd = _op_command(spec)
        fed = {name for name, _ in spec.get("stdin", [])}
        if cmd in gm.ADMIN_GUARDED_CMDS and "admin" not in fed:
            raise SystemExit(f"{op}: `{cmd}` 受管理口令保护，但界面没喂 admin 行 → 必然失败")
        # `gate` / `webbg` 在 CLI 里是**就地校验**（status 只读、on/off 才问），
        # 所以它们不在 ADMIN_GUARDED_CMDS 里，界面却仍然要喂 admin 行。
        # 这个判断读 CLI 的常量，别在这里再抄一份命令名。
        if (cmd not in gm.ADMIN_GUARDED_CMDS and "admin" in fed
                and cmd not in gm.INPLACE_ADMIN_CMDS):
            raise SystemExit(f"{op}: `{cmd}` 并不需要管理口令，界面却要输入 → 会误导用户")


# --------------------------------------------------------------------------
# 执行操作：一律 subprocess 调原 CLI
# --------------------------------------------------------------------------
#
# 为什么不 import 进来直接调 cmd_*？
#   · cmd_* 用 argparse 的 Namespace 当参数，手工拼 Namespace 很容易漏字段；
#   · 它们大量 `print()`，在服务进程里会污染 stdout；
#   · 最要紧的是：**管理口令校验发生在 CLI 的 main() 里**。走命令行才是完整的
#     那条路径，校验一定被跑到。自己调 cmd_* 反而要重新实现一遍。

_EXEC_LOCK = threading.Lock()      # 写操作串行化：并发改同一个 JSON 会互相覆盖

#: 远端参数（`main()` 按命令行填）。
#:
#: ★ 集中一份是为了修一个**静默不一致**：以前子进程只收到 `--state`，
#:   于是界面顶栏写着「服务器 A」、而 push/usage 实际连的是 CLI 的默认服务器。
#:   现在 `run_op` 会把这三个参数原样带给 CLI（它们是**全局参数**，任何子命令都收）。
_REMOTE = {"server": None, "ssh_port": None, "remote_dir": None, "web_root": None,
           "offline_admin_config": None}


def _remote_args() -> list[str]:
    """`--server / --ssh-port / --remote-dir / --web-root` 四个全局参数（未设置则不带）。

    第五个 `--offline-admin-config` 是**测试专用**：界面进程自己不会带上它，只有
    启动 cmsui 时显式给了才转发给子进程。以前它走环境变量
    （`CMSGATE_OFFLINE_SELFTEST`），而环境变量会被继承 —— 谁 export 过一次忘了取消，
    真实运维的写操作就静默降级到「你自己指定的那份假凭据」，而命令随后照样连真服务器。
    """
    out: list[str] = []
    for key, flag in (("server", "--server"), ("ssh_port", "--ssh-port"),
                      ("remote_dir", "--remote-dir"), ("web_root", "--web-root"),
                      ("offline_admin_config", "--offline-admin-config")):
        if _REMOTE.get(key):
            out += [flag, str(_REMOTE[key])]
    return out


#: --len（随机生成长度）的合法范围。下限对齐 CLI 的 `max(8, …)`：
#: 以前写 4，界面给 4~7 会被 CLI 静默抬到 8，前后不一致；这里直接拒掉。
#: 注意这是**随机生成长度**，不是自定义口令下限——自定义口令由 CLI 的
#: MIN_CUSTOM_PW(=12) 把关，与本常量无关。
MIN_PW_LEN, MAX_PW_LEN = 8, 512


def _build_argv(spec: dict, params: dict) -> list[str]:
    argv = []
    for tok in spec["argv"]:
        m = re.fullmatch(r"\{(\w+)\}", tok)
        if not m:
            argv.append(tok)
            continue
        val = params.get(m.group(1))
        if val is None:
            # 空值给空串而不是省略参数：CLI 对 `--label ""` 是「清空」，
            # 省略则是「不改」，语义不同，不能混。
            val = ""
        argv.append(str(val))
    return argv


def run_op(op: str, params: dict) -> dict:
    """执行一个操作，返回 {ok, code, out}。"""
    spec = OPS.get(op)
    if spec is None:
        raise ApiError(f"不支持的操作：{op}", 404)

    argv = _build_argv(spec, params)

    # ── 1) 先校验要喂的 stdin ──
    # 顺序有意为之：**管理口令是门，缺它时不该先去抱怨别的参数**。
    # （踩过：`add` 同时缺口令和有效期时，用户看到的是「请选择有效期」，
    #   于是以为跟权限无关，绕一大圈。）
    why = {
        "admin": "这个操作需要管理口令",
        "current": "更换管理口令要先输入「当前管理口令」",
        "newpw": "缺少新密码",
        "token": "设置登录入口要先给一个 token（12~32 位小写字母或数字）",
    }
    stdin_feed: list[tuple[str, str | None, str]] = []      # (值, flag, 参数名)
    for name, flag in spec.get("stdin", []):
        val = params.get(name)
        # ★ `add` / `passwd` 的 `newpw` 是**可选**的：不喂它，CLI 就会自己随机
        #   生成（`_read_new_password` 里没有 `--password-stdin` 就走 `secrets.choice`）。
        #   以前这里对所有操作无条件 `if not val: raise` —— 于是界面上「随机生成」
        #   这条路根本走不通（一点就报「缺少新密码」），而且也**没法自定义密码**。
        #   喂了就用你给的（自定义），不喂就随机；两者都是 CLI 的原生行为，
        #   界面不替它发明规则。
        #
        # ⚠️ **只对这两个命令放宽**。`admin_init` / `admin_passwd` 的 newpw
        #   是**必须**的 —— 换管理口令时不提供密码等于什么都没做。
        #   用「命令名 + 参数名」双重判定，别图省事只判参数名。
        cmd_name = _op_command(spec)
        optional_newpw = cmd_name in ("add", "passwd")
        if name == "newpw" and not val and optional_newpw:
            continue
        if not val:
            raise ApiError(why.get(name, f"缺少 {name}"))
        stdin_feed.append((str(val), flag, name))

    # ── 2) 有效期：--hours/--days/--until/--never 四选一 ──
    # 注意 `add` 的有效期是**可选**的（不给就是永久，CLI 的行为如此），
    # 只有 `expire` 必须给（那是它存在的唯一目的）。
    if spec.get("expiry"):
        exp = params.get("expiry") or {}
        kind = exp.get("kind")
        if kind in (None, "", "keep"):
            if spec.get("expiry_required"):
                raise ApiError("请选择有效期（按小时 / 按天 / 到某天 / 永久）")
            # 不传任何 flag = 不过期
        elif kind == "never":
            argv.append("--never")
        elif kind in ("hours", "days", "until"):
            val = str(exp.get("value", "")).strip()
            if not val:
                raise ApiError("有效期的数值不能为空")
            argv += [f"--{kind}", val]
        else:
            raise ApiError(f"不认识的有效期方式：{kind!r}")

    # ── 3) 长度 / force ──
    if spec.get("len"):
        raw = params.get("len")
        if raw not in (None, ""):
            try:
                n = int(raw)
            except (TypeError, ValueError):
                raise ApiError("密码长度必须是整数") from None
            if not MIN_PW_LEN <= n <= MAX_PW_LEN:
                raise ApiError(f"密码长度应在 {MIN_PW_LEN}..{MAX_PW_LEN} 之间")
            argv += ["--len", str(n)]

    if spec.get("force") and params.get("force"):
        argv.append(spec["force"])

    # ── 3b) flags：多个布尔开关，只给**勾中的那些** ──
    # ★ 不能用 `{name}` 占位符表达布尔开关：占位符为空时会填成空串，
    #   变成 `--mac ""`，而 argparse 把**任何非空字符串**都当真值 ——
    #   于是「没勾也生效」，用户以为只选了 mac、结果两端都换了。
    for key, flag in spec.get("flags", []):
        if params.get(key):
            argv.append(flag)

    # ── 3c) value_flags：**带值**的开关，有值才追加（空值整对省略）──
    # ★ 为什么不用 `{name}` 占位符：占位符空值会变成 `--icon ""`，
    #   让 CLI 收到一个「指向当前目录」的假路径，还要多打印一条警告。
    #   为什么需要这条：`{icon}` 当初压根没写进 OPS 的 argv，
    #   于是「界面裁的图标」上传后**从来没被转发给 CLI**（2026-10-18 发现）——
    #   用户裁了、服务端存了、CLI 不知道，图标永远退回背景图居中裁。
    for key, flag in spec.get("value_flags", []):
        val = params.get(key)
        if val not in (None, ""):
            argv += [flag, str(val)]

    # ── 4) 最后把 stdin 的 flag 补进 argv（顺序即契约，flag 只加一次）──
    stdin_lines: list[str] = []
    #: 需要在输出里打码的那些（**只含管理口令，不含新密码**）。
    mask_in_output: list[str] = []
    flagged: set[str] = set()
    for val, flag, name in stdin_feed:
        if flag and flag not in flagged:
            argv.append(flag)
            flagged.add(flag)
        stdin_lines.append(val)
        if name in ("admin", "current"):
            mask_in_output.append(val)

    cmd = [sys.executable, str(TOOL), "--state", str(params["_state"]),
           *_remote_args(), *argv]
    payload = "".join(line + "\n" for line in stdin_lines)

    with _EXEC_LOCK:
        try:
            # ★ 超时按操作给：推图带打包要几分钟，别的操作 120 秒足够。
            #   全局写死 120 会在打包中途杀进程 —— 那比慢糟得多。
            tmo = int(spec.get("timeout", 120))
            r = subprocess.run(cmd, input=payload, capture_output=True,
                               text=True, timeout=tmo)
        except subprocess.TimeoutExpired:
            return {"ok": False, "code": 124,
                    "out": f"命令超时（{tmo} 秒）。若是 push/pull，多半是网络或 SSH 卡住了；"
                           "若是推背景图，可能是打包卡住了。"}
        except OSError as e:
            return {"ok": False, "code": 1, "out": f"起子进程失败：{e}"}

    out = (r.stdout or "") + (r.stderr or "")
    # 管理口令回显防护：万一 CLI 的报错把它带出来了，抹掉。
    #
    # ⚠️ **只抹管理口令，绝不抹新密码**。CLI 的 `add` / `passwd` 会刻意把新密码
    #    打印一次让用户保存——那不是泄漏，是唯一一次交付机会。
    #    我第一版把 stdin 里所有值都抹了，结果用户只看到 `密码 : ******`，
    #    测试 T18 直接抓到（"响应里带出了明文密码"失败）。
    for secret in mask_in_output:
        if secret and len(secret) >= 6:
            out = out.replace(secret, "******")
    return {"ok": r.returncode == 0, "code": r.returncode, "out": out.strip()}


# --------------------------------------------------------------------------
# 只读数据（直接复用 gate_manager 的纯函数，不起子进程）
# --------------------------------------------------------------------------

def _code_stale() -> bool:
    """源码是否比本进程新（= 改了 gate_ui.py 但没重启）。

    留 1 秒余量：文件系统和编辑器的 mtime 精度不一，掐着同一秒容易误报。
    """
    try:
        return TOOL.stat().st_mtime > STARTED_AT + 1.0
    except OSError:
        return False


def read_overview(state: Path) -> dict:
    """本地总览：不需要 SSH，首屏要快。"""
    out = {"initialized": False, "gen": None, "count": 0,
           # 复用 CLI 的判定（clean / pending / unknown）。**不要自己拿 sha 比**——
           # 「有没有忘推」的规则（含 .pushed 标记的意义）只该有一份实现。
           "push_state": gm.push_state(state), "recent": None,
           # 「你改了 Python 但没重启」——界面据此显示红字，别让人去猜为什么行为是旧的
           "stale": _code_stale()}
    if not gm.store_path(state).exists():
        return out
    store = safe_call(gm.load_store, state)
    out["initialized"] = True
    out["gen"] = store.get("gen")
    out["count"] = len(store["entries"])
    return out


def _expiring_soon(e: dict, *, days: int = 7) -> bool:
    """这条密码会不会在 7 天内到期（已禁用/已过期/永久都不算）。

    放在服务端算：`expires_at` 是严格的 `%Y-%m-%dT%H:%M:%SZ`，用 Python 解析
    比在 JS 里 `Date.parse` 稳妥（前端一旦换格式就会静默变成 false）。
    """
    if not e.get("enabled", True):
        return False
    dt = _utc_dt(e.get("expires_at"))
    if dt is None:
        return False
    left = (dt - datetime.now(timezone.utc)).total_seconds()
    return 0 <= left <= days * 86400


def read_entries(state: Path) -> list[dict]:
    if not gm.store_path(state).exists():
        return []
    store = safe_call(gm.load_store, state)
    agg = safe_call(gm.usage_summary, state) or {}
    rows = []
    # 最新的在最上面（按创建时间倒序），和 CLI 的 `list` 保持同一方向。
    for e in sorted(store["entries"], key=lambda x: x.get("created_at", ""), reverse=True):
        a = agg.get(e.get("id", ""), {})
        rows.append({
            "id": e.get("id"),
            "label": e.get("label") or "",
            "note": e.get("note") or "",
            "state": safe_call(gm.entry_state, e),
            "expiry": safe_call(gm.entry_expiry_text, e, utc=False),
            "expiry_utc": e.get("expires_at"),
            "expiring_soon": _expiring_soon(e),
            "created": safe_call(gm.iso_to_local, e.get("created_at")),
            "rotated": safe_call(gm.iso_to_local, e.get("rotated_at")) if e.get("rotated_at") else "",
            "rev": e.get("rev", 1),
            "enabled": e.get("enabled", True),
            "dup": e.get("dup"),
            "ok": a.get("ok", 0),
            "fail": a.get("fail", 0),
            "last": safe_call(gm.iso_to_local, a.get("last")) if a.get("last") else "",
        })
    return rows


def _store_ids(state: Path) -> set[str]:
    """本地密码表里现存的 id 集合（表不存在就是空集）。"""
    if not gm.store_path(state).exists():
        return set()
    st = safe_call(gm.load_store, state)
    return {e.get("id") for e in (st.get("entries") or []) if e.get("id")}


def _store_created(state: Path) -> dict[str, str]:
    """id → created_at（UTC ISO 串）。用来按「创建时间从晚到早」排序。"""
    if not gm.store_path(state).exists():
        return {}
    st = safe_call(gm.load_store, state)
    return {e["id"]: str(e.get("created_at") or "")
            for e in (st.get("entries") or []) if e.get("id")}


def _ms_to_utc(v) -> datetime | None:
    """毫秒时间戳 → aware UTC。空值返回 None。

    前端传毫秒而不是「本地时间字符串」是刻意的：浏览器用 `new Date(input.value)`
    算出的毫秒已经带上了本机时区，服务端不必再猜时区——虽然这里是本机回环、
    时区必然一致，但少一层假设就少一个「差 8 小时」的机会。
    """
    if v in (None, ""):
        return None
    try:
        ms = float(v)
    except (TypeError, ValueError):
        raise ApiError("时间范围的起止值不是毫秒时间戳") from None
    return datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)


def _time_bounds(from_ms, to_ms) -> tuple[datetime | None, datetime | None]:
    """把「起 / 止」换算成 UTC 的 [lo, hi) 区间。

    `hi` 加 60 秒：界面上的结束时间是**分钟精度**（`datetime-local` 的默认），
    用户选「到 12:00」意思是**含 12:00 这一分钟**。不加的话
    `12:00:30` 的记录会被排除，看起来像「明明有记录却查不到」。
    """
    lo, hi = _ms_to_utc(from_ms), _ms_to_utc(to_ms)
    if lo is not None and hi is not None and lo > hi:
        raise ApiError("开始时间晚于结束时间")
    if hi is not None:
        hi = hi + timedelta(seconds=60)
    return lo, hi


def _ip_text(r: dict) -> str:
    """IP 列的显示值 = 筛选值 = 返回值，**只在这里算一次**。

    没有明文 ip 时退回 `hash:<前 8 位>`（服务器可能只记了哈希）。
    三处（显示 / 筛选 / facet）共用同一个函数，避免哪天改了一处另两处漂移。
    """
    return str(r.get("ip") or f"hash:{str(r.get('ip_hash') or '')[:8]}")


def _osdev_text(r: dict) -> str:
    """系统 / 设备列的组合文本（显示与筛选共用）。"""
    os_, dev = str(r.get("os") or ""), str(r.get("device") or "")
    return (os_ + " / " + dev) if (os_ and dev) else (os_ or dev)


#: 浏览器串里「版本号」的那一段：`155.0.0.0`、`v8.7.1`、`537.36` 都算。
#: 只认**纯数字段**，所以 `Mobile Safari 17.0` 会断在 `17.0` 之前，
#: 名字保留成 `Mobile Safari` —— 不会像「取第一个词」那样退化成 `Mobile`。
_VERSION_TOKEN = re.compile(r"^[vV]?\d+(?:[._]\d+)*$")


def _browser_name(s: str) -> str:
    """浏览器串去掉版本号：`Edge 155.0.0.0` → `Edge`；`Mobile Safari 17.0` → `Mobile Safari`。

    为什么需要：UA 解析出来的串带版本号，同一个人升级一次浏览器就变成另一个选项。
    真实数据里 13 个不同的串其实只有 Edge / Chrome / Safari / curl 4 种浏览器，
    升级 Edge 就多出一个选项，筛选列表越用越长。

    ★ 边界刻意选在「第一个数字段之前」，而不是「第一个空格之前」：
      后者会把 `Mobile Safari`、`Headless Chrome` 这种两词名字砍掉一半。
      遇到整串就是版本号（没有名字）时**原样返回**，不返回空串——
      否则它会和「没记到浏览器」的空值混成一类。
    """
    s = (s or "").strip()
    if not s:
        return ""
    words: list[str] = []
    for tok in re.split(r"[\s/]+", s):
        if not tok:
            continue
        if _VERSION_TOKEN.match(tok):
            break
        words.append(tok)
    return " ".join(words) or s


#: 失败原因里认得的几种（其它一律归 `other`，不给每台奇怪的 reason 建新列）
_FAIL_REASONS = ("bad_password", "throttled", "disabled", "expired")


def _result_code(r: dict) -> str:
    """把一条记录压成一个稳定的「结果代码」，用于筛选与 facet。

    为什么不用中文文案当筛选值：文案会改、要 URL 编码，而且 `成功`/`失败`
    粒度过粗——`密码错` 和 `已禁用` 是完全不同的事，审计时要分得开。
    """
    if r.get("ok"):
        # 免密放行（闸门开放）也进来了，但和「输对密码」是两回事，facet 分开
        return "gate_open" if r.get("reason") == "gate_open" else "ok"
    reason = str(r.get("reason") or "")
    return reason if reason in _FAIL_REASONS else "other"


def _split(v) -> set[str]:
    """把 `a,b,c` 拆成集合（也接受已经是集合/列表的值）。"""
    if not v:
        return set()
    if isinstance(v, (set, frozenset, list, tuple)):
        return {str(x) for x in v if str(x)}
    return {p for p in (s.strip() for s in str(v).split(",")) if p}


#: 「这一列的值为空」的占位值。
#:
#: 为什么需要它：`browser=` 空串在查询串里等于「不限」，而「只看没记到浏览器的」
#: 是个真实需求（老记录没有 UA）。所以给空值一个显式 token，传输时不会和「不限」撞车。
#: 万一真有浏览器叫这个名字，最多是筛错，不会误放行任何东西——但现实中不可能。
_BLANK = "__blank__"


def _split_values(v) -> set[str]:
    """同 `_split`，但把 `_BLANK` 还原成空串。"""
    return {"" if x == _BLANK else x for x in _split(v)}


def _usage_matches_result(r: dict, wanted: set[str]) -> bool:
    """`fail` 是「任何失败」的别名，方便一句「只看失败的」。

    免密放行（gate_open）进来了但没验密码，不算成功登录也不算失败。
    """
    code = _result_code(r)
    if code in wanted:
        return True
    return "fail" in wanted and code not in ("ok", "gate_open")


def read_usage(state: Path, *, limit: int, offset: int = 0, pwid=None,
               result=None, since: str | None = None,
               q: str | None = None, ip=None, browser=None, osdev=None,
               from_ms=None, to_ms=None, existing: bool = False,
               bname: bool = False) -> dict:
    """访问记录：**最新的在最前**，并且在服务端就把筛选做完。

    为什么筛选放在服务端而不是前端
    ------------------------------
    前端只拿得到 `limit` 条。若在这 `limit` 条里再筛「仅失败」，那么
    「最近 200 条里没有失败」会被显示成「没有失败」——而 300 条之前可能
    失败了一大片。审计表格**不能出这种静默漏判**，所以筛选必须在
    「取 limit 条」之前做，并且把 `total` / `matched` 一起回给前端，
    让人一眼看出「筛掉的比显示的多」。

    筛选参数都是**多选**（`a,b,c` 逗号分隔，空 = 不限），对应「点列头
    弹出来的那排复选框」。多值之间是「或」，不同列之间是「且」——
    和 Excel 的自动筛选一致。

    返回 {rows, total, matched, offset, limit}：
      total   —— 缓存里的总条数（不筛）
      matched —— 通过全部筛选的条数（还没被 limit 截断）
      rows    —— matched 里第 offset 条起的 limit 条，**倒序（最新在前）**

    `existing=True`：只保留「密码表里还存在的密码」的记录。
    ★ 但**没有 pwid 的匿名记录要保留**——那是密码输错时的失败记录（服务器查不到
      对应哪条密码，本来就没有 pwid）。把这些一起藏掉等于把审计里最该看的
      东西藏了：真实数据里 111/170 条都是这种。

    `bname=True`：浏览器列按**名字**筛（忽略版本号），与 facet 的合并模式配套。
    两种模式的筛选值不通用（一个要 `Edge`，一个要 `Edge 155.0.0.0`），
    所以前端切模式时必须清掉已选的浏览器值，否则会静默 0 条。
    """
    recs = safe_call(gm.read_usage, state) or []
    total = len(recs)

    # 「只看还存在的密码」：藏掉「有 pwid 但已经不在表里」的记录（删掉的测试密码之类）。
    # ★ `dropped_existing` 必须一起回给前端：这个开关**默认开着**，所以「共 N 条」
    #   和「筛选后 M 条」天生就不相等。前端若只显示两个数字，用户会以为数字错了
    #   或者自己手滑加了筛选——必须告诉他是哪一条筛掉的、筛掉了多少。
    dropped_existing = 0
    if existing:
        ids = _store_ids(state)
        before = len(recs)
        recs = [r for r in recs
                if not r.get("pwid") or r.get("pwid") in ids]
        dropped_existing = before - len(recs)

    want_pwid = _split(pwid)
    if want_pwid:
        recs = [r for r in recs if (r.get("pwid") or "") in want_pwid]

    want_res = _split(result)
    if want_res:
        recs = [r for r in recs if _usage_matches_result(r, want_res)]

    want_ip = _split_values(ip)
    if want_ip:
        recs = [r for r in recs if _ip_text(r) in want_ip]

    want_br = _split_values(browser)
    if want_br:
        if bname:
            recs = [r for r in recs if _browser_name(r.get("browser") or "") in want_br]
        else:
            recs = [r for r in recs if (r.get("browser") or "") in want_br]

    want_os = _split_values(osdev)
    if want_os:
        recs = [r for r in recs if _osdev_text(r) in want_os]

    bound = _since_boundary(since)
    if bound is not None:
        recs = [r for r in recs
                if (dt := _utc_dt(r.get("ts"))) is not None and dt >= bound]

    # 自定义起止（毫秒）优先于 since：界面上选了「自定义」就只发 from/to
    lo, hi = _time_bounds(from_ms, to_ms)
    if lo is not None or hi is not None:
        kept = []
        for r in recs:
            dt = _utc_dt(r.get("ts"))
            if dt is None:
                continue
            if lo is not None and dt < lo:
                continue
            if hi is not None and dt >= hi:
                continue
            kept.append(r)
        recs = kept

    needle = (q or "").strip().lower()
    if needle:
        recs = [r for r in recs if needle in _usage_haystack(r)]

    matched = len(recs)
    # ★ 按 `ts` 排序，**不依赖文件里的先后顺序**。
    #   `ts` 是定长的 UTC ISO 串，字典序 == 时间序，所以直接按字符串倒排即可。
    #   为什么不 `recs[-limit:][::-1]`：那假设缓存一定按时间追加。真实缓存来自
    #   `tail -n N usage.jsonl`（追加序 = 时间序），但这就成了一个**隐式前提**——
    #   哪天缓存被合并/重写过，顺序一乱，页面就会「最新的不在最上面」而没有任何报错。
    #
    # 分页：`offset` 是**筛选之后**的下标（不是原始下标的偏移）。
    # 顺序固定为「最新在前」，所以第 1 页永远是最新的那批。
    ordered = sorted(recs, key=lambda r: str(r.get("ts") or ""), reverse=True)
    rows = ordered[offset:offset + limit]

    out = []
    for r in rows:
        out.append({
            "time": safe_call(gm.iso_to_local, r.get("ts")),
            "ts": str(r.get("ts") or ""),
            "ok": bool(r.get("ok")),
            "result": safe_call(gm._result_text, r),
            "result_code": _result_code(r),
            "pwid": r.get("pwid") or "",
            "label": r.get("label") or "",
            "ip": _ip_text(r),
            "browser": r.get("browser") or "",
            "os": r.get("os") or "",
            "osdev": _osdev_text(r),
            "device": r.get("device") or "",
        })
    return {"rows": out, "total": total, "matched": matched,
            "offset": offset, "limit": limit,
            "dropped_existing": dropped_existing}


def _usage_haystack(r: dict) -> str:
    """一条记录参与「关键词搜索」的字段，统一小写拼成一串。"""
    parts = [r.get("ip"), r.get("ip_hash"), r.get("browser"), r.get("os"),
             r.get("device"), r.get("label"), r.get("pwid"),
             gm._result_text(r)]
    return " ".join(str(x) for x in parts if x).lower()


def _utc_dt(ts) -> datetime | None:
    """把存储里的 UTC ISO 串解析成 aware datetime；解析不了返回 None（不猜）。

    存储侧一律 UTC（见 gate_manager.iso_to_local 的说明），所以这里无条件按
    UTC 解释——注意 `iso_to_local` 是「只有结尾带 Z/+00:00 才当 UTC」，
    那个宽松规则是给**显示**用的，拿来做时间比较会在遇到裸串时错 8 小时。
    """
    try:
        dt = datetime.strptime(str(ts or "")[:19], "%Y-%m-%dT%H:%M:%S")
    except ValueError:
        return None
    return dt.replace(tzinfo=timezone.utc)


#: `since` 参数的合法取值 → 往前推多久。`today` 是**本地零点**，不是 24 小时前。
SINCE_CHOICES = {"today": 0, "7d": 7, "30d": 30}


def _since_boundary(since: str | None) -> datetime | None:
    """把 `since= today|7d|30d` 换算成 UTC 下界；空值返回 None（不筛）。

    口径：`today` = 本机时区的今天 00:00 换算成 UTC。用 UTC 零点会让东八区
    用户在早上 8 点前看到「今天」是空的——那种「明明刚登录过却查不到」最难解释。
    """
    if not since:
        return None
    if since not in SINCE_CHOICES:
        raise ApiError(f"不认识的时间范围：{since!r}（只支持 today / 7d / 30d）")
    now = datetime.now().astimezone()
    if since == "today":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    else:
        start = now - timedelta(days=SINCE_CHOICES[since])
    return start.astimezone(timezone.utc)


def _code_text(code: str) -> str:
    """结果代码 → 给人看的文案。**复用 CLI 的 `_result_text`**，不另抄一份映射。"""
    if code == "ok":
        return safe_call(gm._result_text, {"ok": True}) or "成功"
    if code == "gate_open":
        return safe_call(gm._result_text, {"ok": True, "reason": code}) or code
    if code == "other":
        return "失败"
    return safe_call(gm._result_text, {"ok": False, "reason": code}) or code


#: 结果列的下拉顺序：成功在最前，失败原因按严重程度排
_RESULT_ORDER = ("ok", "gate_open", "bad_password", "throttled", "disabled", "expired",
                 "other")


def read_usage_facets(state: Path, *, existing: bool = False,
                      bname: bool = False) -> dict:
    """每一列的可选值 + 条数，供「点列头弹出来的那排复选框」用。

    ★ 刻意基于**未经筛选的全量记录**：Excel 的自动筛选列表也是这样。
    若按当前筛选结果生成，用户勾了「成功」之后再想改选「密码错」，
    会发现那一项已经从列表里消失了——只能先清空再点，很难用。

    `existing=True` 时密码列只列「密码表里还在的」，并且**按创建时间从晚到早**排；
    已删除的密码排在后面（表里没有 created_at，只能按出现次数排）。

    `bname=True` 时浏览器列按**名字**合并（`Edge` 而不是 `Edge 155.0.0.0`），
    并额外带 `versions` = 这条名字下有几个不同版本，让「合并了 4 个版本」
    这件事在界面上是**看得见**的，而不是悄悄吞掉信息。
    """
    recs = safe_call(gm.read_usage, state) or []
    created = _store_created(state)

    if existing:
        recs = [r for r in recs
                if not r.get("pwid") or r.get("pwid") in created]

    def tally(fn) -> dict[str, int]:
        c: dict[str, int] = {}
        for r in recs:
            k = fn(r)
            c[k] = c.get(k, 0) + 1
        return c

    def pack(counter: dict[str, int], textfn, limit: int = 80) -> list[dict]:
        items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
        return [{"value": _BLANK if v == "" else v, "text": textfn(v), "n": n}
                for v, n in items]

    # 密码列要显示标签（人认标签，不认 12 位十六进制）。标签可能后来改过，取最近一条。
    labels: dict[str, str] = {}
    for r in recs:
        pid = str(r.get("pwid") or "")
        if pid and r.get("label"):
            labels[pid] = str(r["label"])

    res_counter = tally(_result_code)
    results = [{"value": k, "text": _code_text(k), "n": res_counter[k]}
               for k in sorted(res_counter,
                               key=lambda k: (_RESULT_ORDER.index(k)
                                              if k in _RESULT_ORDER else 99, k))]

    pwid_counter = tally(lambda r: str(r.get("pwid") or ""))
    pwid_items = [{"value": _BLANK if v == "" else v,
                   "text": labels.get(v) or (v or "（无 id）"),
                   "n": n,
                   "created": created.get(v, "")}
                  for v, n in pwid_counter.items()]

    # 排序规格：**创建时间从晚到早**（和条目表同一个方向）。
    # 用三次「稳定排序」拼复合键，比手写取负码的 tuple 好读：
    #   ① 次数多的在前（次要）→ ② 创建时间晚的在前（再次）→ ③ 现存 > 已删除 > 无 id（主）
    # Python 的 sort 是稳定的，所以后一次排序会保留前一次在相等键上的顺序。
    pwid_items.sort(key=lambda it: it["n"], reverse=True)
    pwid_items.sort(key=lambda it: it["created"], reverse=True)
    pwid_items.sort(key=lambda it: _pwid_group(it["value"], created))

    return {
        "total": len(recs),
        "results": results,
        "pwids": pwid_items,
        "ips": pack(tally(_ip_text), lambda v: v or "（空）", limit=200),
        "browsers": _browser_facet(recs, bname=bname),
        "osdev": pack(tally(_osdev_text), lambda v: v or "（空）"),
        "bname": bname,
    }


def _browser_facet(recs: list[dict], *, bname: bool) -> list[dict]:
    """浏览器列的可选值。

    `bname=True` 时把 `Edge 155.0.0.0` / `Edge 153.0.0.0` 合成一条 `Edge`，
    并带上 `versions`（这一名下有几个不同版本）与 `examples`（最多 3 个原串）。
    合并是为了列表短，但「同一浏览器有多少个版本」这件事对排查有用，
    所以不把它藏起来——原始串仍完整保存在记录里，表格那一列也照旧显示全名。
    """
    counter: dict[str, int] = {}
    versions: dict[str, set[str]] = {}
    for r in recs:
        full = str(r.get("browser") or "")
        key = _browser_name(full) if bname else full
        counter[key] = counter.get(key, 0) + 1
        if bname:
            versions.setdefault(key, set()).add(full)

    items = sorted(counter.items(), key=lambda kv: (-kv[1], kv[0]))[:80]
    out = []
    for v, n in items:
        it = {"value": _BLANK if v == "" else v, "text": v or "（空）", "n": n}
        if bname:
            vs = sorted(x for x in versions.get(v, ()) if x)
            it["versions"] = len(vs)
            it["examples"] = vs[:3]
        out.append(it)
    return out


def _pwid_group(value: str, created: dict[str, str]) -> int:
    """密码列的分组：0 = 表里还在，1 = 已删除，2 = 没有 id（匿名失败）。

    现存的排最前，因为那才是用户要挑的；已删除的（历史记录还在）其次；
    匿名记录不具备「密码」的语义，放最后。
    """
    if value == _BLANK or value == "":
        return 2
    return 0 if value in created else 1


def read_usage_pwids(state: Path) -> list[dict]:
    """访问记录里出现过的所有密码（含已删除的），供筛选下拉框用。

    刻意不从 `store.entries` 取：**删掉的密码，它的历史记录还在**，
    如果下拉框只列现存条目，那些记录就再也筛不出来了。
    """
    recs = safe_call(gm.read_usage, state) or []
    agg: dict[str, dict] = {}
    for r in recs:
        pid = r.get("pwid")
        if not isinstance(pid, str) or not pid:
            continue
        slot = agg.setdefault(pid, {"pwid": pid, "label": "", "count": 0,
                                    "ok": 0, "fail": 0})
        slot["count"] += 1
        if r.get("ok"):
            slot["ok"] += 1
        else:
            slot["fail"] += 1
        # 标签可能后来改过名字，取最近一条记录里的那个
        if r.get("label"):
            slot["label"] = r.get("label")
    return sorted(agg.values(), key=lambda x: (-x["count"], x["pwid"]))


def read_audit(state: Path, *, limit: int = 200) -> list[dict]:
    p = state / "gate_audit.jsonl"
    if not p.exists():
        return []
    rows = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            rec["time"] = safe_call(gm.iso_to_local, rec.get("ts"))
            rows.append(rec)
    return rows[-limit:]


def _remote_ns(state: Path, server: str, ssh_port: str, remote_dir: str,
               web_root: str | None = None):
    """拼一个与 CLI argparse Namespace 同形状的小对象，喂给 gate_manager 的远程函数。

    只放它们真的会读的字段（state / server / ssh_port / remote_dir / web_root）。
    不复制 `ssh_cmd` 之类的逻辑——那会变成第二份实现，迟早和 CLI 漂移。
    """
    class _A:
        pass

    a = _A()
    a.state = state
    a.server = server
    a.ssh_port = ssh_port
    a.remote_dir = remote_dir
    # webbg 的几个函数要读 a.web_root（网站根目录 = nginx 的 root）。
    # 不给就用 CLI 的默认：单一真相在 gate_manager 里，别在这里再抄一份。
    a.web_root = web_root or gm.DEFAULT_WEB_ROOT
    return a


#: 从线上取背景图给界面预览时的**字节上限**。防止一个超大文件把内存吃光
#: （也顺便挡住了「路径被换成 /dev/zero 这类无限文件」）。8 MB 足够当缩略图了。
WEBBG_FETCH_MAX = 8 * 1024 * 1024


def fetch_webbg_image(state: Path, *, server: str, ssh_port: str, remote_dir: str,
                      web_root: str | None, which: str) -> tuple:
    """从服务器把背景图**取回来**（预览 / 下载用）。只读，不改任何东西。

    返回 `(bytes, content_type, 文件名)`。取不到就抛 `ApiError`。

    为什么走 ssh 而不是直接读线上 URL：那张图**本来就是公开资源**
    （`/assets/bg.webp`），但 cmsui 绑在回环 + token 上，让浏览器自己去
    `https://ty0712.com/assets/bg.webp` 取等于把本机的地址
    泄露出去。而且撤下之后那张 URL 变成白图 —— 预览就永远看不到原图了。
    这里直接向服务器要，才能预览「私藏备份里那张原图」。
    """
    # ★ which 只认白名单里的键，**绝不把用户给的值拼进 ssh 命令**。
    names = {"webp": ("assets/bg.webp", "image/webp", "bg.webp"),
             "jpg": ("assets/bg.jpg", "image/jpeg", "bg.jpg"),
             "blank": ("blank.webp", "image/webp", "blank.webp")}
    if which not in names:
        raise ApiError("只能预览 webp / jpg")
    rel, ctype, fname = names[which]
    a = _remote_ns(state, server, ssh_port, remote_dir, web_root)
    root = a.web_root
    # ★ 必须**二进制**取，不能走 gm.run（它 text=True，会把图片按 UTF-8 解码
    #   → UnicodeDecodeError 直接把请求线程干掉，浏览器只看到「Failed to fetch」）。
    #   这类"传字节流"的活不能用面向文本的封装 —— 我第一版就是这么写的。
    #   `head -c` 先截断：即使文件超大也只传上限那么多，不会把内存吃光。
    import subprocess
    cmd = gm.ssh_cmd(a) + [f"cd '{root}' && head -c {WEBBG_FETCH_MAX} '{rel}'"]
    r = subprocess.run(cmd, capture_output=True, check=False,
                       stdin=subprocess.DEVNULL)
    data = r.stdout or b""
    if r.returncode != 0 or not data:
        raise ApiError(f"取不到 {rel}（服务器没回内容）")
    # webp/jpg 都有魔数；被截断的 webp 仍带 RIFF 头，据此判断取到的是不是图片。
    if which == "webp" and not data.startswith(b"RIFF"):
        raise ApiError(f"{rel} 的内容不是 webp（可能被替换成了别的东西）")
    if which == "jpg" and not data.startswith(b"\xff\xd8\xff"):
        raise ApiError(f"{rel} 的内容不是 jpg")
    return data, ctype, fname


def read_webbg(state: Path, *, server: str, ssh_port: str, remote_dir: str,
               web_root: str | None = None) -> dict:
    """线上背景图现状（只读）。转调 gate_manager 的 `webbg_status`——不重写 ssh 那套逻辑。

    `webbg_status` 里会 `die()` 的地方（远端 JSON 坏了）由 `safe_call` 接住，
    否则会把这个请求线程干掉，前端只看到连接被断。
    """
    a = _remote_ns(state, server, ssh_port, remote_dir, web_root)
    st = safe_call(gm.webbg_status, a)
    if not isinstance(st, dict):
        return {"reachable": False, "error": "读不到背景图状态", "mode": "unknown"}
    return st


#: 上传的图片大小上限（原始字节，不是 base64 后的大小）。
#:
#: 200 MB 是为了能接超大原图（现在 UI 也会先在浏览器里压到 1920 再传，
#: 实际用到的多半是几百 KB —— 但偶尔也会有人直接丢一张几十 MB 的原图进来）。
#:
#: ★ 这个数字大到什么程度才安全，取决于 `save_webbg_upload` 是否**流式**。
#:   实测（`ru_maxrss`，macOS 上单位是**字节**）：
#:     · 6.2 MB 图走「整个 body 读进内存 → base64 → json.loads」→ 峰值 +24 MB
#:     · 280 MB 请求体（≈ 200 MB 图）走同一条路 → **峰值 +533 MB**
#:   而它跑在 `ThreadingHTTPServer` 的**请求线程**里 —— 并发两个就 1 GB。
#:   所以流式不是优化，是**这个上限能成立的前提**。
WEBBG_UPLOAD_MAX = 200 * 1024 * 1024

#: 流式接收与解码的分块大小。太小则系统调用多，太大又白占内存；
#: 256 KB 是个稳妥值（峰值内存与它同量级，不随图片大小变化）。
WEBBG_CHUNK = 256 * 1024

#: 本机 state/uploads/ 只留最近几个原图。每张可能几十 MB，攒着很快撑大磁盘。
WEBBG_UPLOAD_KEEP_LOCAL = 10

#: 只认这几种图片。**并且要按魔数再验一遍**——只看 MIME 等于让调用方自称是什么。
_WEBBG_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", ".png"),
    (b"\xff\xd8\xff", ".jpg"),
    (b"GIF87a", ".gif"),
    (b"GIF89a", ".gif"),
    (b"BM", ".bmp"),
    (b"II*\x00", ".tif"),
    (b"MM\x00*", ".tif"),
)


def _webbg_sniff(raw: bytes) -> str | None:
    for magic, ext in _WEBBG_MAGIC:
        if raw.startswith(magic):
            return ext
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return None


def save_webbg_upload(state: Path, data_url: str) -> dict:
    """把浏览器选来的图落到 state/uploads/，返回路径（供 webbg push 用）。

    为什么要有这一步：浏览器拿不到文件的**真实路径**（`<input type=file>` 的
    `.value` 只有 `C:\\fakepath\\…`），所以只能把内容传上来再落盘。
    它是本机回环上的写操作，仍然要卡三道：只收图片（按魔数验）、有大小上限、
    落进专用目录且用 O_EXCL + 随机名（撞名就直接失败，不覆盖任何已有文件）。
    """
    import base64
    import secrets as _secrets

    m = re.fullmatch(r"data:(image/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)",
                     (data_url or "").strip())
    if not m:
        raise ApiError("只接受 data:image/...;base64 的图片数据")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", m.group(2)), validate=True)
    except (ValueError, TypeError):
        raise ApiError("base64 解不开（数据被截断了？）") from None
    if not raw:
        raise ApiError("图片是空的")
    if len(raw) > WEBBG_UPLOAD_MAX:
        raise ApiError(f"图片太大：{len(raw):,} 字节（上限 "
                       f"{WEBBG_UPLOAD_MAX // (1024 * 1024)} MB）")
    ext = _webbg_sniff(raw)
    if not ext:
        raise ApiError("这不是我能认出来的图片（png / jpg / webp / gif / bmp / tif）")

    up = state / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    os.chmod(up, 0o700)
    name = f"bg-{_secrets.token_urlsafe(9)}{ext}"
    dst = up / name
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(raw)

    _webbg_prune_uploads(up)      # 与流式那条共用同一个裁剪逻辑（别两份清单）
    return {"path": str(dst), "name": name, "bytes": len(raw)}


def _webbg_prune_uploads(up: Path, keep: int = WEBBG_UPLOAD_KEEP_LOCAL) -> None:
    """只留最近 keep 个**背景图**上传件。多出来的一律删掉。

    ⚠️ 只处理 `bg-*` —— `icon-*`（裁剪出来的图标）不参与。
    """
    try:
        olds = sorted((p for p in up.iterdir()
                       if p.is_file() and p.name.startswith("bg-")),
                      key=lambda p: p.stat().st_mtime, reverse=True)[keep:]
    except OSError:
        return
    for p in olds:
        try:
            p.unlink()
        except OSError:
            pass


def _drain(rfile, n: int, chunk: int = WEBBG_CHUNK) -> None:
    """把还没读完的 `n` 字节**丢进黑洞**（分块读、不存）。

    为什么需要：HTTP/1.1 里若服务端直接回响应而不管请求体，客户端可能还在
    写 —— 表现是客户端收到 **Broken pipe** 而不是状态码，于是「文件太大」
    变成「网络错误」，用户完全不知道原因。
    读掉是必须的，但**绝不存进内存或磁盘**（否则拒绝一个 10 GB 的上传
    反而把它写满了）。
    """
    left = n
    while left > 0:
        b = rfile.read(min(chunk, left))
        if not b:
            return                    # 客户端自己断了，本来就不指望响应
        left -= len(b)


def save_webbg_stream(state: Path, rfile, content_length: int,
                      limit: int = WEBBG_UPLOAD_MAX, *,
                      kind: str = "bg") -> dict:
    """**流式**接收 base64 图片并落盘，全程内存占用与图片大小无关。

    为什么必须流式：老路 `save_webbg_upload` 是「整个请求体 `rfile.read(n)`
    进内存 → decode 成 str → `json.loads`」，实测 200 MB 的图会让峰值内存
    涨到 **533 MB**，而且是在 `ThreadingHTTPServer` 的请求线程里 ——
    并发两个就 1 GB。设大上限而不同步改成流式，那个上限就是不负责任的。

    这里怎么做的：
    1. `Content-Length` 先给个**硬上限**，超了直接 413，连读都不读
       （不然恶意/误传一个 10 GB 的 body 会把磁盘写满）。
    2. 头部先读一小段，用魔数认出是什么图片 —— 认不出就**立刻停**，
       不再往磁盘写后面的内容。
    3. 余下内容按 `WEBBG_CHUNK` 分块读，base64 在**读的同时**解，
       直接写进临时文件。内存里始终只有一块 chunk。
    4. 写完 `os.replace` 到最终名（同目录，保证原子），并**顺带裁剪**暂存目录。

    `base64.b64decode` 每次能解 3 字节的倍数，所以要按块对齐 ——
    否则跨块的 base64 会解不出正确字节。
    """
    import base64
    import secrets as _secrets

    if content_length <= 0:
        raise ApiError("请求体是空的")
    # base64 会把体积放大约 4/3，再留 1 KB 余量给 JSON 包裹
    if content_length > (limit * 4 // 3) + 4096:
        raise ApiError(f"请求体太大：约 {content_length // (1024 * 1024)} MB "
                       f"（上限 {limit // (1024 * 1024)} MB 的图）")

    up = state / "uploads"
    up.mkdir(parents=True, exist_ok=True)
    os.chmod(up, 0o700)

    # 临时名 → 认出类型后再改成带正确扩展名的正式名
    tmp = up / f".incoming-{_secrets.token_urlsafe(9)}.bin"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    remaining = content_length
    raw_bytes = 0
    b64_tail = ""            # 跨块残留的 base64 字符（不足 4 个一组）
    head = b""               # 已解码的头部字节（认魔数要用**解码后**的字节）
    ext: str | None = None
    try:
        with os.fdopen(fd, "wb") as f:
            while remaining > 0:
                chunk = rfile.read(min(WEBBG_CHUNK, remaining))
                if not chunk:
                    raise ApiError("连接在传输中断了（图片没收全）")
                remaining -= len(chunk)
                # 先把不足一整组的尾巴留住，凑满 4 个再解
                data = b64_tail + chunk.decode("ascii", "ignore")
                take = len(data) - (len(data) % 4)
                b64_tail = data[take:]
                if not take:
                    continue
                try:
                    out = base64.b64decode(data[:take])
                except (ValueError, TypeError):
                    raise ApiError("数据不是合法的 base64（传输可能损坏了）") from None
                if raw_bytes + len(out) > limit:
                    raise ApiError(f"图片超过 {limit // (1024 * 1024)} MB 上限")
                f.write(out)
                raw_bytes += len(out)
                if ext is None:
                    # ★ 魔数要在**解码后**的字节上认（我第一版拿 base64 文本去试，
                    #   于是无论什么图都「认不出来」——探针一试就露馅了）。
                    head += out[:32]
                    ext = _webbg_sniff(head)
                    if not ext:
                        raise ApiError("这不是我能认出来的图片"
                                       "（png / jpg / webp / gif / bmp / tif）")
        if b64_tail:
            raise ApiError("数据在传输中被截断了（base64 长度不对）")
        if raw_bytes == 0:
            raise ApiError("图片是空的")
        prefix = "icon" if kind == "icon" else "bg"
        name = f"{prefix}-{_secrets.token_urlsafe(9)}{ext}"
        dst = up / name
        os.replace(tmp, dst)          # 同目录 rename = 原子
        tmp = None                    # 已挪走
    finally:
        if tmp is not None:
            try:
                tmp.unlink()
            except OSError:
                pass
    if kind != "icon":
        # ★ 只裁背景图那一池。图标是**这次要用的**，被「留最近 10 张」的
        #   规则顺手删掉就白传了（而且报错点离这里很远，极难查）。
        _webbg_prune_uploads(up)
    return {"path": str(dst), "name": name, "bytes": raw_bytes}


def read_remote(state: Path, *, server: str, ssh_port: str, remote_dir: str) -> dict:
    """线上状态。要 SSH，所以单独一个接口、前端异步加载（慢不能拖垮首屏）。"""
    a = _remote_ns(state, server, ssh_port, remote_dir)
    out: dict = {"reachable": False}
    try:
        cfg = safe_call(gm._load_gate_config, a) or {}
    except ApiError as e:
        out["error"] = e.message
        return out
    out["reachable"] = True
    admin = cfg.get("admin")
    out["gate_on"] = bool(cfg.get("require_password"))
    out["admin_set"] = isinstance(admin, dict)
    out["admin_set_at"] = str(admin.get("set_at", ""))[:19] if isinstance(admin, dict) else ""
    out["updated_at"] = safe_call(gm.iso_to_local, cfg["updated_at"]) if cfg.get("updated_at") else ""
    try:
        out["remote_gen"] = safe_call(gm.remote_store_gen, a)
    except ApiError as e:
        out["remote_gen"] = None
        out["error"] = e.message
    return out


# --------------------------------------------------------------------------
# 「有改动未推送」到底改了哪些 —— 逐条比对本地与线上
# --------------------------------------------------------------------------
#
# 为什么比的是**线上那份**，而不是「上次推送时的快照」
# ------------------------------------------------------
# 工具里的 `.pushed` 只存了一串 sha256，没有内容，所以「相对上次推送改了什么」
# 本身是**算不出来的**（除非另存快照）。而用户真正要知道的是：
# **线上现在还缺哪些改动**——因为「未推送」意味着访客此刻看到的还是旧表。
# 直接拿线上那份逐条比，既回答了这个问题，也能发现「别人从另一台机器推过」
# 这种 .pushed 标记察觉不到的情况。
#
# ⚠️ 比对在服务端做，**密码哈希绝不外传**：前端只需要知道「这条的密码变了」。

#: 逐条比对的字段与给人看的名字（顺序即展示顺序）
_DIFF_FIELDS = (
    ("label", "标签"),
    ("note", "备注"),
    ("enabled", "启用状态"),
    ("expires_at", "有效期"),
    ("rev", "轮换次数"),
    ("cred", "密码"),
)


def _entry_fp(e: dict) -> dict:
    """把一条密码压成「可比指纹」。`cred` 只在服务端参与比较，不进返回值。"""
    return {
        "label": e.get("label") or "",
        "note": e.get("note") or "",
        "enabled": bool(e.get("enabled", True)),
        "expires_at": e.get("expires_at"),
        "rev": int(e.get("rev") or 1),
        "cred": (str(e.get("salt") or ""), str(e.get("hash") or "")),
    }


def read_push_diff(state: Path, *, server: str, ssh_port: str,
                   remote_dir: str) -> dict:
    """本地密码表 vs 线上那份：新增 / 删除 / 修改逐条列出。"""
    # 注意别把 gen 写成常量 None：`a["entries"] if cond else []` 这种写法里，
    # 条件只作用在那一小段，gen 会永远是 None（我第一版就这么写的，T24 抓到了）。
    if gm.store_path(state).exists():
        st = safe_call(gm.load_store, state)
    else:
        st = {"gen": None, "entries": []}
    local = {"gen": st.get("gen"), "entries": st.get("entries") or []}

    a = _remote_ns(state, server, ssh_port, remote_dir)
    # 用 safe_call 包一层：`remote_read_json` 在「远端 JSON 坏了」时会 `die()`
    # （= sys.exit），在服务进程里会直接把请求线程干掉，前端只看到连接被断。
    remote = safe_call(gm.remote_read_json, a, "passwords.json")
    remote_missing = False
    if remote is None:
        # `remote_read_json` 用 None 同时表示「文件不存在」和「ssh 失败」。
        # 这两种后果完全相反：前者是首次推送（本地全部算新增），后者必须报错，
        # 绝不能把「连不上」显示成「线上什么都没有」。
        try:
            safe_call(gm._load_gate_config, a)
        except ApiError as e:
            return {"reachable": False, "error": e.message}
        remote_missing = True
        remote = {"gen": None, "entries": []}
    if not isinstance(remote, dict):
        return {"reachable": True, "error": "线上那份不是 JSON 对象，无法比对"}

    lo = {e.get("id"): e for e in local.get("entries") or [] if e.get("id")}
    ro = {e.get("id"): e for e in remote.get("entries") or [] if e.get("id")}

    rows: list[dict] = []

    for eid, e in lo.items():
        if eid not in ro:
            rows.append({
                "kind": "added", "id": eid,
                "label": e.get("label") or "",
                "detail": "线上没有这一条 —— 推送后对方才能用它登录",
            })

    for eid, e in ro.items():
        if eid not in lo:
            rows.append({
                "kind": "removed", "id": eid,
                "label": e.get("label") or "",
                "detail": "本地已删除，线上还在 —— 推送后这条立即失效",
            })

    for eid, e in lo.items():
        if eid not in ro:
            continue
        lf, rf = _entry_fp(e), _entry_fp(ro[eid])
        changed = [name for key, name in _DIFF_FIELDS if lf[key] != rf[key]]
        if changed:
            rows.append({
                "kind": "changed", "id": eid,
                "label": lf["label"] or rf["label"] or "",
                "fields": changed,
                "detail": "已修改：" + "、".join(changed),
            })

    order = {"added": 0, "removed": 1, "changed": 2}
    rows.sort(key=lambda r: (order[r["kind"]], r["label"], r["id"]))

    counts = {"added": 0, "removed": 0, "changed": 0}
    for r in rows:
        counts[r["kind"]] += 1
    same = len(set(lo) & set(ro)) - counts["changed"]

    local_sha = safe_call(gm.store_sha, state)
    pushed_sha = safe_call(gm.read_pushed, state)
    return {
        "reachable": True,
        "remote_missing": remote_missing,
        "local_gen": local.get("gen"),
        "remote_gen": remote.get("gen"),
        "local_sha": local_sha,
        "pushed_sha": pushed_sha,
        # 标记说「已同步」但线上其实不一样 → 多半是别的机器推过
        "marker_clean": bool(local_sha) and local_sha == pushed_sha,
        "counts": dict(counts, same=max(0, same)),
        "rows": rows,
    }


# --------------------------------------------------------------------------
# 从服务器拉访问记录（「刷新就该是最新的」）
# --------------------------------------------------------------------------

#: 拉取时向服务器要多少行。
#:
#: ★ 刻意**不跟着「显示条数」下拉走**。下拉只决定表格显示几行，这里决定
#:   缓存里存多少。若跟着下拉走，用户选「50 条」时缓存会被裁到 250 行，
#:   「共 N 条」就会莫名其妙变小——那是审计数据，变小看起来像记录丢了。
PULL_LIMIT = 1000

#: 两次拉取之间的最小间隔（秒）。按钮连点、两个标签页同时刷新时兜底。
PULL_MIN_GAP = 2.0

#: 是否允许发起远端拉取。`--no-pull` 关掉（离线、或不想让它碰 ssh 时）。
PULL_ENABLED = True

_PULL_LOCK = threading.Lock()
_pull_meta: dict = {
    "epoch": 0.0,      # 最后一次**成功**拉取的墙上时间（给前端显示「已同步 12:39:41」）
    "mono": 0.0,       # 最后一次**尝试**的单调时钟（算最小间隔用，不受改系统时间影响）
    "error": None,     # 最后一次失败的说明（成功后清空）
    "skipped": 0,      # 因「正在拉 / 太频繁 / 有写操作在跑」被跳过的次数
    "skip_reason": None,   # gap / busy / exec / disabled —— 让界面能说清为什么没拉
    "count": 0,        # 成功次数
}


def pull_meta() -> dict:
    """当前拉取状态（**不发起任何请求**）。"""
    return {"pulled_epoch": _pull_meta["epoch"],
            "pull_error": _pull_meta["error"],
            "pull_skipped": _pull_meta["skipped"],
            "pull_skip_reason": _pull_meta["skip_reason"],
            "pull_count": _pull_meta["count"]}


def _skip_pull(reason: str) -> dict:
    _pull_meta["skipped"] += 1
    _pull_meta["skip_reason"] = reason
    return pull_meta()


def _first_line(s: str) -> str:
    """报错取第一行（CLI 的 `die()` 会把长说明铺好几行，界面上放不下）。"""
    for line in (s or "").split("\n"):
        line = line.strip().lstrip("*").strip()
        if line:
            return line[:160]
    return ""


def pull_usage(state: Path, *, limit: int = PULL_LIMIT) -> dict:
    """从服务器拉一份访问记录到本地缓存，返回拉取状态。

    为什么不让前端直接调 `/api/exec usage_remote`：那样每个标签页、每次自动
    刷新都是一次独立的 ssh，两个标签页就会并发连——服务器那边看到的是
    「一串突然密集的 ssh 连接」。这里用**非阻塞**的单飞锁兜住：

      · 已经有拉取在跑 → **直接跳过**（不排队）。排队的话自动刷新会越积越多，
        最后变成一串 ssh 排着队跑，而页面反而更卡。
      · 距上次尝试不到 `PULL_MIN_GAP` 秒 → 跳过（按钮连点保护）。
      · 有写操作（push / revoke…）正在跑 → 跳过，不去抢同一台机器的 ssh。
      · 失败时**绝不清空缓存**：表格继续显示旧数据，只把错误记在 `pull_error`。
        否则一次断网就会把「最近访问」变成空白，看起来像记录全丢了。
    """
    if not PULL_ENABLED:
        _pull_meta["error"] = "已关闭自动拉取（--no-pull）"
        return _skip_pull("disabled")

    if not _PULL_LOCK.acquire(blocking=False):
        return _skip_pull("busy")
    try:
        if _pull_meta["mono"] and time.monotonic() - _pull_meta["mono"] < PULL_MIN_GAP:
            return _skip_pull("gap")
        if _EXEC_LOCK.locked():
            return _skip_pull("exec")

        r = run_op("usage_remote", {"limit": limit, "_state": state})
        # 失败也记一次「刚试过」：否则失败时会瞬间重试成风暴。
        _pull_meta["mono"] = time.monotonic()
        if r.get("ok"):
            _pull_meta["epoch"] = time.time()
            _pull_meta["error"] = None
            _pull_meta["skip_reason"] = None
            _pull_meta["count"] += 1
        else:
            _pull_meta["error"] = _first_line(r.get("out")) or "拉取失败"
            _pull_meta["skip_reason"] = None
    finally:
        _PULL_LOCK.release()
    return pull_meta()


# --------------------------------------------------------------------------
# HTTP 服务
# --------------------------------------------------------------------------

#: 保护「一次性 token 是否已兑换」的检查-置位，避免两个并发请求都通过。
_TOKEN_LOCK = threading.Lock()


def _query_flag(q: dict, name: str) -> bool:
    """查询串里的布尔开关：`1 / true / yes / on` 为真，缺省为假。

    集中一处，是因为这个判断原先在三处各写了一份 `in ("1", "true", "yes")`；
    加第四个开关时很容易只记得改其中两处，于是「界面打了勾、服务端没收到」。
    """
    vals = q.get(name) or [""]
    return str(vals[0]).strip().lower() in ("1", "true", "yes", "on")


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = "cmsgate-ui/1"
    protocol_version = "HTTP/1.1"

    # 由 main() 注入
    token: str = ""
    #: 初始 `?k=` 是否已经被兑换过。Handler 每个请求一个新实例，所以必须是类属性；
    #: 兑换一次后失效 —— 那把钥匙只该在「终端里打印 → 打开」这一次出现。
    token_consumed: bool = False
    port: int = 0
    state: Path = gm.DEFAULT_STATE
    server_addr: str = ""
    ssh_port: str = ""
    remote_dir: str = ""
    #: 网站根目录（nginx 的 root）。背景图开关要动它，默认跟 CLI 一致。
    web_root: str = gm.DEFAULT_WEB_ROOT

    # ---- 基础设施 ----
    def log_message(self, fmt, *args):          # noqa: A002
        """默认实现会把整个 URL（含 token！）写进日志。这里改成只记方法+路径。

        ⚠️ **绝不能记完整 URL 或 query**——初始访问的 `?k=<token>` 就是钥匙，
        写进日志文件等于把钥匙留在磁盘上。
        """
        path = urllib.parse.urlsplit(self.path).path
        sys.stderr.write(f"  {self.command} {path} → {args[1] if len(args) > 1 else '?'}\n")

    def _allowed_hosts(self) -> set[str]:
        return {f"127.0.0.1:{self.port}", f"localhost:{self.port}",
                f"[::1]:{self.port}", f"127.0.0.1", f"localhost"}

    def _host_ok(self) -> bool:
        """★ 第二层：Host 必须是我们自己的回环地址。

        这是**挡 DNS rebinding 的关键**。攻击者把 `evil.com` 解析到 127.0.0.1，
        浏览器就认为请求与目标是同源、于是带上 cookie 发过来；但它发的
        `Host:` 头是 `evil.com`，在这里被拒。
        """
        host = (self.headers.get("Host") or "").strip().lower()
        return host in self._allowed_hosts()

    def _origin_ok(self) -> bool:
        """有 Origin/Referer 时必须指向我们自己（没有则放行：非浏览器客户端）。

        比的是 **host:port**，不只是主机名：同机另一个端口上的页面（比如先起的
        本地开发服务器、别人的工具）与我们是不同源，但它发来的 Origin 主机名
        同样是 127.0.0.1 —— 只看 hostname 会把这类跨站请求放进来。
        """
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
            if part.startswith("cmsui="):
                return part[len("cmsui="):]
        return ""

    def _authed(self) -> bool:
        return hmac.compare_digest(self._cookie_token(), self.token)

    def _send(self, code: int, body: bytes = b"", *,
              ctype: str = "application/json; charset=utf-8",
              extra: list[tuple[str, str]] | None = None) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 本地管理界面一律不缓存：缓存住一份旧的 = 看到过期的账号状态
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        # 前端刻意不写任何内联脚本/内联样式，所以这里能给严格 CSP：
        # 万一哪天有人往页面里塞了段注入脚本，它连执行的机会都没有。
        #   frame-ancestors 'none' —— 顺带挡住「被别的页面嵌进 iframe 里点」。
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; img-src 'self' data:; "
                         "script-src 'self'; style-src 'self'; "
                         "connect-src 'self'; form-action 'self'; "
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
    def do_GET(self):                                            # noqa: N802
        u = urllib.parse.urlsplit(self.path)
        path, q = u.path, urllib.parse.parse_qs(u.query)

        if not self._host_ok():
            return self._fail(403, "Host 不被允许（只接受 127.0.0.1 / localhost）")

        # ① 用一次性 token 换 cookie
        if path == "/":
            k = (q.get("k") or [""])[0]
            if k and hmac.compare_digest(k, self.token):
                # 真正的一次性：兑换过一次后，同一个 URL 再被打开（从终端复制、
                # 浏览器历史、别人的截图里）就失效。已经拿着 cookie 的重载放行，
                # 否则刷新一下自己就被锁在门外。
                with _TOKEN_LOCK:
                    fresh = not type(self).token_consumed
                    if fresh:
                        type(self).token_consumed = True
                if not fresh and not self._authed():
                    return self._send(403, _NO_TOKEN_PAGE.encode("utf-8"),
                                      ctype="text/html; charset=utf-8")
                # 换完立刻重定向，把 token 从地址栏（和浏览器历史）里抹掉
                return self._send(303, b"", ctype="text/plain",
                                  extra=[("Set-Cookie",
                                          f"cmsui={self.token}; Path=/; HttpOnly; SameSite=Strict"),
                                         ("Location", "/")])
            if not self._authed():
                return self._send(403, _NO_TOKEN_PAGE.encode("utf-8"),
                                  ctype="text/html; charset=utf-8")
            return self._send(200, (ASSET_DIR / "index.html").read_bytes(),
                              ctype="text/html; charset=utf-8")

        # 静态资源也要鉴权：否则跨站页面能用 <script src> 探测服务是否存在
        if path in ("/app.css", "/app.js"):
            if not self._authed():
                return self._fail(403, "未授权")
            name = path.lstrip("/")
            ctype = "text/css; charset=utf-8" if name.endswith(".css") else \
                "text/javascript; charset=utf-8"
            return self._send(200, (ASSET_DIR / name).read_bytes(), ctype=ctype)

        # 种子工具箱的前端编解码器（ES module，页面里 dynamic import）。
        # 同样要鉴权：它虽不含密钥以外的秘密，但「服务存在性」不对外。
        if path == "/seedcodec.js":
            if not self._authed():
                return self._fail(403, "未授权")
            if not SEEDCODEC_JS.is_file():
                return self._fail(404, "web/dist/seedcodec.js 不存在（先在 web/ 下跑 tsc 构建）")
            return self._send(200, SEEDCODEC_JS.read_bytes(),
                              ctype="text/javascript; charset=utf-8")

        if path == "/favicon.ico":
            return self._send(204)

        if path.startswith("/api/"):
            if not self._authed():
                return self._fail(403, "未授权（请用终端里打印的那个网址打开）")
            return self._api_get(path, q)

        return self._fail(404, "没有这个路径")

    def do_HEAD(self):                                           # noqa: N802
        self.do_GET()

    def _api_get(self, path: str, q: dict) -> None:
        st = self.state
        try:
            if path == "/api/overview":
                return self._json({"ok": True, "data": read_overview(st)})
            if path == "/api/entries":
                return self._json({"ok": True, "data": read_entries(st)})
            if path == "/api/usage":
                try:
                    limit = int((q.get("limit") or ["100"])[0])
                except (TypeError, ValueError):
                    raise ApiError("limit 必须是数字") from None
                limit = max(1, min(limit, 2000))
                try:
                    offset = int((q.get("offset") or ["0"])[0])
                except (TypeError, ValueError):
                    raise ApiError("offset 必须是数字") from None
                offset = max(0, min(offset, 1_000_000))

                def _first(name):
                    return (q.get(name) or [None])[0]

                # `pull=1`：先向服务器拉一份，再按当前筛选读缓存。
                # 拉取本身有限速与单飞（见 pull_usage），所以自动刷新不会打爆 ssh。
                # ★ 失败时**照常返回缓存里的行**，只多带一个 `pull_error` 让前端提示。
                meta = pull_usage(st) if _query_flag(q, "pull") else pull_meta()

                data = read_usage(
                    st, limit=limit, offset=offset, pwid=_first("id"), result=_first("result"),
                    since=_first("since"), q=_first("q") or "",
                    ip=_first("ip"), browser=_first("browser"), osdev=_first("os"),
                    from_ms=_first("from"), to_ms=_first("to"),
                    existing=_query_flag(q, "existing"),
                    bname=_query_flag(q, "bname"))
                data.update(meta)
                return self._json({"ok": True, "data": data})
            if path == "/api/usage_facets":
                return self._json({"ok": True, "data": read_usage_facets(
                    st, existing=_query_flag(q, "existing"),
                    bname=_query_flag(q, "bname"))})
            if path == "/api/usage_pwids":
                return self._json({"ok": True, "data": read_usage_pwids(st)})
            if path == "/api/audit":
                return self._json({"ok": True, "data": read_audit(st)})
            if path == "/api/remote":
                d = read_remote(st, server=self.server_addr,
                                ssh_port=self.ssh_port, remote_dir=self.remote_dir)
                return self._json({"ok": True, "data": d})
            if path == "/api/webbg":
                d = read_webbg(st, server=self.server_addr, ssh_port=self.ssh_port,
                               remote_dir=self.remote_dir, web_root=self.web_root)
                return self._json({"ok": True, "data": d})
            if path == "/api/webbg_image":
                which = (q.get("which") or ["webp"])[0]
                data, ctype, fname = fetch_webbg_image(
                    st, server=self.server_addr, ssh_port=self.ssh_port,
                    remote_dir=self.remote_dir, web_root=self.web_root, which=which)
                # 「预览」和「下载」同一个字节流，只是多一个附件头。
                # no-store 由 _send 统一带（缓存住一份旧的 = 永远看到旧背景图）。
                extra = []
                if (q.get("download") or ["0"])[0] == "1":
                    extra.append(
                        ("Content-Disposition", f'attachment; filename="{fname}"'))
                return self._send(200, data, ctype=ctype, extra=extra)
            if path == "/api/push_diff":
                d = read_push_diff(st, server=self.server_addr,
                                   ssh_port=self.ssh_port, remote_dir=self.remote_dir)
                return self._json({"ok": True, "data": d})
            if path == "/api/landing":
                # 默认页现状（只读）。转调 `cms landing status --json`，
                # 界面不自己读 nginx 片段 —— 解析口径与 CLI 永远一致。
                r = run_op("landing_status", {"_state": self.state})
                mode = None
                for line in (r.get("out") or "").splitlines():
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            mode = json.loads(line).get("mode")
                        except json.JSONDecodeError:
                            mode = None
                return self._json({"ok": True, "data": {"mode": mode}})
            if path == "/api/gate-path":
                # 登录入口现状（只读）。同样转调 CLI，界面不自己解析 nginx 片段：
                # token 的合法性判断（^[a-z0-9]{12,32}$）只在 CLI 有一份。
                # 走这个接口要 cmsui 会话（本机 + SameSite=Strict），
                # 而它回的就是「谁能打开登录页」的那把钥匙，口径与 CLI status 一致。
                r = run_op("gate_path_status", {"_state": self.state})
                data = {"token": None, "path": None, "exists": False}
                for line in (r.get("out") or "").splitlines():
                    line = line.strip()
                    if line.startswith("{"):
                        try:
                            j = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        data = {"token": j.get("token"), "path": j.get("path"),
                                "exists": bool(j.get("exists"))}
                # 前缀与路径分开回：token 只来自 CLI，SITE_ORIGIN 只是站点地址，
                # 由前端拼成完整网址（复制给用户的就是拼好的那条）。
                data["site"] = SITE_ORIGIN
                return self._json({"ok": True, "data": data})
            if path == "/api/ops":
                # 让前端知道哪些操作存在、哪些要口令（不暴露任何敏感信息）
                return self._json({"ok": True, "data": {
                    k: {"admin": bool(v.get("admin")), "expiry": bool(v.get("expiry"))}
                    for k, v in OPS.items()}})
        except ApiError as e:
            return self._fail(e.status, e.message)
        return self._fail(404, "没有这个接口")

    def do_POST(self):                                           # noqa: N802
        u = urllib.parse.urlsplit(self.path)
        if not self._host_ok():
            return self._fail(403, "Host 不被允许")
        # ★ 第四层：自定义头。跨站表单发不出自定义头；带自定义头的跨站请求
        #   会触发 CORS 预检，而本服务不响应预检 → 浏览器直接拦下。
        if self.headers.get("X-CMSUI") != "1":
            return self._fail(403, "缺少 X-CMSUI 头（拒绝可能的跨站请求）")
        if not self._origin_ok():
            return self._fail(403, "Origin 不是本机")
        if not self._authed():
            return self._fail(403, "未授权")

        if u.path == "/api/webbg_upload":
            # 上传走**原始 base64 体**（不是 JSON 包裹），且**流式**接收。
            # 老路是「整个 body read(n) → decode → json.loads」，实测 200 MB 的图
            # 峰值内存 +533 MB —— 上限调到 200 MB 就必须同时改成流式，
            # 否则那个上限是不负责任的（见 WEBBG_UPLOAD_MAX 的注释）。
            #
            # JSON 那条路（save_webbg_upload）留着：小图走它更省事，
            # 而且测试要用它验证「非图片被拒」这类分支。
            raw_ct = (self.headers.get("Content-Type") or "").split(";")[0].strip()
            # kind=icon：这是裁剪后的**图标**，不是背景图。两者要分开放 ——
            # 背景图那个池子只留最近 10 张，图标混进去会被当旧背景图裁掉。
            qs = urllib.parse.parse_qs(u.query)
            _kind = (qs.get("kind") or [""])[0].strip().lower()
            if _kind not in ("", "icon"):
                return self._fail(400, f"不认识的 kind：{_kind}")
            try:
                n = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._fail(400, "Content-Length 非法")
            cap = WEBBG_UPLOAD_MAX * 4 // 3 + 4096      # base64 膨胀 4/3，留点余量
            if n <= 0 or n > cap:
                # ★ 超限时**要把剩余的请求体读掉再回 413**，否则客户端看到的是
                #   Broken pipe 而不是「文件太大」—— 它已经把几百 MB 发出去了，
                #   我们中途断开，浏览器只报「网络错误」，用户完全不知道原因。
                #   读掉是必须的（HTTP/1.1 不允许在同一连接上直接回响应而不管 body），
                #   但**分块丢进 /dev/null**，内存与磁盘都不占。
                #   真读到一半连接断了（客户端自己放弃）就当没这回事，直接回。
                if n > cap:
                    _drain(self.rfile, n)
                return self._fail(413, f"请求体为空或过大"
                                       f"（上限 {WEBBG_UPLOAD_MAX // (1024 * 1024)} MB 的图，"
                                       f"约 {cap // (1024 * 1024)} MB 的 base64）")
            try:
                if raw_ct == "application/json":
                    body = json.loads(self.rfile.read(n).decode("utf-8"))
                    if not isinstance(body, dict):
                        return self._fail(400, "请求体应为对象")
                    d = save_webbg_upload(self.state,
                                          str(body.get("data_url") or ""))
                else:
                    # ★ 流式：Content-Type 不是 JSON 就当原始 base64 读
                    d = save_webbg_stream(self.state, self.rfile, n,
                                          kind=("icon" if _kind == "icon" else "bg"))
            except ApiError as e:
                return self._fail(e.status, e.message)
            except OSError as e:
                return self._fail(500, f"存文件失败：{e}")
            return self._json({"ok": True, "data": d})

        if u.path != "/api/exec":
            return self._fail(404, "没有这个接口")

        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return self._fail(400, "Content-Length 非法")
        if n <= 0 or n > 64 * 1024:
            return self._fail(400, "请求体为空或过大")
        try:
            body = json.loads(self.rfile.read(n).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return self._fail(400, "请求体不是合法 JSON")
        if not isinstance(body, dict):
            return self._fail(400, "请求体应为对象")

        op = body.get("op")
        params = body.get("params") or {}
        if not isinstance(params, dict):
            return self._fail(400, "params 应为对象")
        # 以防前端被劫持后塞进来一个怪 key
        if "_state" in params:
            return self._fail(400, "params 里不允许出现 _state")
        params = dict(params)
        params["_state"] = self.state

        try:
            return self._json({"ok": True, "data": run_op(str(op), params)})
        except ApiError as e:
            return self._fail(e.status, e.message)


_NO_TOKEN_PAGE = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>需要钥匙</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#eef2f6;color:#2b3440;
      font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
 .box{max-width:520px;padding:32px 36px;background:#fff;border-radius:14px;
      box-shadow:0 8px 30px rgba(20,40,70,.10)}
 h1{margin:0 0 12px;font-size:19px;font-weight:600}
 code{background:#f0f4f8;padding:2px 7px;border-radius:5px;font-size:13px}
 .k{color:#0a7ea4;font-weight:600}
 p{margin:10px 0;color:#55606e}
</style></head><body>
<div class="box">
  <h1>这个页面需要钥匙</h1>
  <p>直接在浏览器里打开本机地址是进不来的 —— 那会让<b>任意网页</b>都能操作你的密码表。</p>
  <p>请回到终端，复制程序启动时打印的那条带 <code>?k=</code> 的完整网址。</p>
  <p class="k">忘了的话，重启一次 gate_ui.py 就会打印新的。</p>
</div></body></html>
"""


# --------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(description="密码管理工具的本地可视化界面")
    ap.add_argument("--port", type=int, default=8730,
                    help="端口（默认 8730；只绑 127.0.0.1，不对外）")
    ap.add_argument("--state", type=Path, default=gm.DEFAULT_STATE)
    ap.add_argument("--server", default=gm.DEFAULT_SERVER)
    ap.add_argument("--ssh-port", default=gm.DEFAULT_SSH_PORT)
    ap.add_argument("--remote-dir", default=gm.DEFAULT_REMOTE_DIR)
    ap.add_argument("--web-root", default=gm.DEFAULT_WEB_ROOT,
                    help="网站根目录（nginx 的 root），背景图开关要动它")
    ap.add_argument("--offline-admin-config", metavar="PATH", default=None,
                    help="【测试专用】把写操作的管理口令校验指到这份本地假 gateconfig，"
                         "并原样转发给子进程。真实运维千万别加（见 _remote_args 的注释）。")
    ap.add_argument("--no-browser", action="store_true",
                    help="不自动打开浏览器（默认也不打开，这个参数留着以后用）")
    ap.add_argument("--no-pull", action="store_true",
                    help="不自动从服务器拉访问记录（离线、或不想让它碰 ssh 时用）")
    a = ap.parse_args()

    # ★ 同一道字符集关卡（见 gate_manager 的 `_refuse_shell_unsafe_endpoints`）：
    #   cmsui 自己也会拼 ssh 命令串（背景图预览 `cd '<web_root>' && head -c …`），
    #   只在 gate_manager 的 main() 里设卡管不到这里 —— 而起服务前拒掉是唯一便宜的时机：
    #   这些值是**启动参数**，不是请求内容，浏览器侧的输入从来进不了它们。
    gm._refuse_shell_unsafe_endpoints(a)

    _verify_ops()

    global PULL_ENABLED
    PULL_ENABLED = not a.no_pull
    _REMOTE.update(server=a.server, ssh_port=a.ssh_port, remote_dir=a.remote_dir,
                   web_root=a.web_root, offline_admin_config=a.offline_admin_config)

    if not (ASSET_DIR / "index.html").exists():
        raise SystemExit(f"前端资源缺失：{ASSET_DIR}/index.html")

    Handler.token = secrets.token_urlsafe(32)
    Handler.port = a.port
    Handler.state = a.state
    Handler.server_addr = a.server
    Handler.ssh_port = a.ssh_port
    Handler.remote_dir = a.remote_dir
    Handler.web_root = a.web_root

    try:
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", a.port), Handler)
    except OSError as e:
        raise SystemExit(f"起不了服务（端口 {a.port} 被占用？）：{e}") from None

    url = f"http://127.0.0.1:{a.port}/?k={Handler.token}"
    # ★ 把**真实绑定地址**打出来（从 getsockname 拿，不是把我们写死的字符串再打一遍）。
    #   回归测试据此验证「只绑回环」—— 它在子进程里，测试拿不到 socket，
    #   而从外面试着连会被 VPN 隧道（utun / 198.18.0.x）干扰。
    #   写成 `BIND <addr> <port>` 单行，便于机器解析；这是给测试看的，不影响人读。
    _bound_host, _bound_port = httpd.socket.getsockname()[:2]
    print(f"BIND {_bound_host} {_bound_port}")
    print()
    print("  密码管理界面已启动（只在本机可访问）")
    print()
    print("  用浏览器打开这条网址（含钥匙，请勿外发）：")
    print(f"    {url}")
    print()
    print(f"  数据目录 : {a.state}")
    print(f"  服务器   : {a.server}:{a.ssh_port}（远端 {a.remote_dir}）")
    print("  访问记录 : " + ("页面开着时自动拉取（默认 10 秒一次，可在页面上改）"
                             if PULL_ENABLED else "已关闭自动拉取（--no-pull）"))
    print()
    print("  ⚠️ 这条网址带一次性钥匙。别人拿到它 = 拿到你的密码管理界面。")
    print("  ⚠️ 改密码/踢人等写操作仍要输入**管理口令**，界面绕不过那道门。")
    print()
    print("  Ctrl-C 停止。原来的命令行工具照常可用，一个字都没改。")
    print()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
