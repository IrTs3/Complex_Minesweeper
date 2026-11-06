#!/usr/bin/env python3
"""网页版访问密码管理工具（本地）。

管理「哪些密码可以进网页版」，并把哈希表推送到服务器上的鉴权服务（server/authd.py）。

设计要点
--------
* **明文只显示一次**：仅在 `add` / `passwd` 时打印到 stdout。不落盘、不写日志、不进 argv
  （自定义密码一律从 stdin 读，避免被 `ps` 看到）。
* **本地不保存签名密钥**：cookie 签名密钥只存在于服务器。本工具只推送哈希表，
  所以丢了密钥最坏也只是"所有人重新登录"，不会把你自己锁在门外。
* **推送是原子且可回滚的**：先传 `.new` → 远端校验 JSON → 备份现有 → `mv` 原子替换。
  服务端按文件 mtime 热重载，无需重启。

用法见 `--help`；每步远程命令都是独立的 ssh/scp，可单独手工执行。
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import time
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import unicodedata
import getpass
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


def shq(s) -> str:
    """shlex.quote(str(s))：凡是拼进**远端 shell 命令串**的值一律从这里走。"""
    return shlex.quote(str(s))

# --------------------------------------------------------------------------
# 与 server/authd.py **必须逐字一致**的常量。
# 改动任何一项都要同时改两端，并跑 `selftest`（内含跨端向量）验证。
# --------------------------------------------------------------------------
STORE_VERSION = 1
KDF_NAME = "scrypt"
KDF_N, KDF_R, KDF_P, KDF_DKLEN, KDF_SALT_BYTES = 16384, 8, 1, 32, 16
KDF_MAXMEM = 64 * 1024 * 1024          # 显式给出，否则 OpenSSL 默认上限会误报
MAX_ENTRIES = 64                       # 校验要遍历所有条目，每条一次 scrypt（本机 19ms）
MAX_LABEL = 64
MAX_NOTE = 128
MIN_CUSTOM_PW = 12

# 闸门全局配置（gateconfig.json）——与 server/authd.py 的常量必须一致
GATE_VERSION = 1
GATE_CONFIG_NAME = "gateconfig.json"
ADMIN_MIN_PW = 12                      # 管理口令下限（比访问密码更敏感）
MAX_UA_SHOW = 300
ISO_Z_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

# 跨端自检向量：scrypt(b"cmsgate-selftest", salt=bytes(range(16))) 的结果。
# 两端各自的 selftest 都比对它——一旦实现漂移，这里立刻炸。
# 用 hex 而不是 Base64：Base64 有 standard/urlsafe 两种变体，跨实现比对时容易踩坑。
VECTOR_SALT = bytes(range(16))
VECTOR_PW = "cmsgate-selftest"
VECTOR_HASH_HEX = "965b82216c97b2fb0d69f7f5e680bb42c97250ce7dc6e60971975fff4b14e44e"

#: selftest 用的管理口令。**只在离线自检环境里有效**（配合 `--offline-admin-config`，
#: 那条路径的凭据来自 selftest 自建的假 gateconfig，见 require_admin 的注释）。
#: 它不是任何真实凭据，也不在任何地方被复用。
SELFTEST_ADMIN_PW = "selftest-admin-pw-2026"

#: 自检里「应该因口令错误而被拒」的用例要用的错口令。
SELFTEST_WRONG_PW = "selftest-admin-wrong"


DEFAULT_STATE = Path.home() / ".cmsgate"


def _deploy_env() -> dict:
    """~/.cmsdist/deploy.env：全仓 SSH 目标的唯一来源（不进仓库，公开快照里不许有真实 IP）。

    两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。与 scripts/ 下
    deploy-*.sh 的 source 是同一份文件；缺文件时本地子命令照常可用，
    只有真正发起 ssh/scp 的那刻才报错（见 run()）。
    """
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
DEFAULT_SERVER = os.environ.get("SERVER") or _DEP.get("CMS_HOST", "")
DEFAULT_SSH_PORT = os.environ.get("SSH_PORT") or _DEP.get("CMS_SSH_PORT", "")
DEFAULT_REMOTE_DIR = "/var/lib/cmsgate"
# 每次 push 都会给远端文件留一份 .bak-<epoch>。不清理就会无限堆积（实测 3 天堆到 70 份），
# 而且每日 tar 快照会把它们**一起打包**，让备份越滚越大。只保留最近这么多份足够回退几次误操作；
# 更久的历史本来就在每日快照里（服务器留 28 份）。
BAK_KEEP = 20


# --------------------------------------------------------------------------
# 密码学
# --------------------------------------------------------------------------
# 哪些子命令真的需要 scrypt（其余命令在没有 scrypt 的解释器上也能跑）
SCRYPT_CMDS = frozenset({"add", "passwd", "selftest", "gate", "admin-init", "admin-passwd",
                        # 下面这些现在也要做 scrypt 校验管理口令了，必须一起换解释器。
                        # **漏一个的后果很隐蔽**：在 macOS 自带 python3 上它会抛
                        # AttributeError，而不是给一句「请换解释器」。
                        "rm", "disable", "enable", "expire", "note", "push", "pull",
                        # landing 的 learn/game 也要 scrypt 校验管理口令（status 只读用不到，
                        # 但同一条子命令共用一个解释器判断，故整条登记进来）。
                        # gate-path 同理：set/rotate 要校验口令，故整条登记。
                        "revoke-all", "webbg", "landing", "gate-path",
                        # dupmark 本身不碰明文，但要校验管理口令（受保护命令），
                        # 在自带 python3 上同样需要能算 scrypt。
                        "dupmark"})


def python_candidates() -> list[str]:
    """探测本机能**做 scrypt**的 Python 3 解释器（返回可用的路径）。

    macOS 自带的 `/usr/bin/python3` 链接 LibreSSL 2.8.3，没有 `hashlib.scrypt`，
    于是 `add` / `passwd` / `selftest` 会直接抛 `AttributeError`。用户敲的 `python3`
    往往正是它——所以这里主动找一个能用的解释器，并自动重新执行（见 ensure_scrypt）。
    """
    names = ("python3.13", "python3.12", "python3.11", "python3.10", "python3")
    paths = [p for p in (shutil.which(n) for n in names) if p]
    paths += [
        "/opt/homebrew/bin/python3",
        "/opt/homebrew/opt/python@3.13/libexec/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    probe = "import hashlib,sys;print(1 if hasattr(hashlib,'scrypt') else 0)"
    out: list[str] = []
    seen: set[str] = set()
    for p in paths:
        rp = os.path.realpath(p)
        if rp in seen:
            continue
        seen.add(rp)
        try:
            r = subprocess.run([p, "-c", probe], capture_output=True, text=True, timeout=15)
        except (OSError, subprocess.SubprocessError):
            continue
        if r.stdout.strip() == "1":
            out.append(p)
    return out


def scrypt_missing_help() -> str:
    """没找到任何能做 scrypt 的解释器时给的话。"""
    try:
        import ssl
        tls = ssl.OPENSSL_VERSION
    except Exception:                                     # pragma: no cover
        tls = "未知"
    return (
        f"当前解释器不支持 scrypt，无法派生 / 校验密码：\n"
        f"  {sys.executable}  (Python {sys.version.split()[0]}, {tls})\n"
        "\n"
        "`hashlib.scrypt` 需要 OpenSSL 1.1+；macOS 自带的 /usr/bin/python3 链接的是\n"
        "LibreSSL，所以 add / passwd / selftest 会在这一步失败（list 不需要它，不受影响）。\n"
        "\n"
        "装一个带 OpenSSL 的 Python 3（brew install python@3.13），或用绝对路径调用。"
    )


def ensure_scrypt() -> None:
    """需要 scrypt 的子命令在开工前调用：能自动换解释器就换，否则给可读的错误。"""
    if hasattr(hashlib, "scrypt"):
        return
    if not os.environ.get("CMSGATE_REEXEC"):
        for alt in python_candidates():
            if os.path.realpath(alt) == os.path.realpath(sys.executable):
                continue
            # 走 stderr 并 flush：stdout 只留给数据（密码明文、表格），
            # 否则 `add > 密码.txt` 会把这句提示一起写进文件；不 flush 还会因
            # 管道缓冲被挤到子进程输出之后。
            print(f"提示：{sys.executable} 不支持 scrypt（Python {sys.version.split()[0]}），"
                  f"自动改用 {alt}", file=sys.stderr, flush=True)
            env = dict(os.environ, CMSGATE_REEXEC="1")
            sys.exit(subprocess.call([alt, os.path.abspath(__file__), *sys.argv[1:]], env=env))
    die(scrypt_missing_help())


def derive_pw(password: str, salt: bytes) -> bytes:
    """把密码派生成 32 字节密钥材料。两端必须用同一实现。"""
    return hashlib.scrypt(password.encode("utf-8"), salt=salt, n=KDF_N, r=KDF_R, p=KDF_P,
                          dklen=KDF_DKLEN, maxmem=KDF_MAXMEM)


def hash_password(password: str) -> tuple[str, str]:
    """返回 (salt_b64, hash_b64)。每条密码用独立随机盐。"""
    salt = secrets.token_bytes(KDF_SALT_BYTES)
    return b64e(salt), b64e(derive_pw(password, salt))


def verify_password(password: str, salt_b64: str, hash_b64: str) -> bool:
    try:
        salt = b64d(salt_b64)
        want = b64d(hash_b64)
    except Exception:
        return False
    return hmac.compare_digest(derive_pw(password, salt), want)


def b64e(raw: bytes) -> str:
    """urlsafe base64，无填充 —— 与 server/authd.py 的编码**必须**一致。"""
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64d(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def find_same_password(store: dict, password: str, *, exclude_id: str | None = None) -> list[str]:
    """哪些现存条目的密码与 password 相同（逐条 scrypt 验证，按表序返回 id）。

    只有**手里有明文**的时刻才调得起（cmd_add / cmd_passwd）——条目里只有
    独立盐的 scrypt 哈希，事后从数据上根本比不出"密码相同"，存量重复只能
    靠 `cms dupmark` 手动补标。每条一次 scrypt（本机 ~19ms），64 条封顶。
    """
    ids = []
    for e in store["entries"]:
        if exclude_id and e["id"] == exclude_id:
            continue
        if verify_password(password, e["salt"], e["hash"]):
            ids.append(e["id"])
    return ids


def assign_dup_group(store: dict, member_ids: list[str]) -> str:
    """把 member_ids 圈进同一个重复组，返回组锚 id。

    约定：组里每个条目（含锚自己）的 `dup` 字段都写锚的 id。已有组就并入
    旧组（选字典序最小的旧锚做新锚，防两个组合并后各留一半），全新组用
    created_at 最早的成员当锚。cmsui 按这个字段给整组上同一底色。
    """
    members = [e for e in store["entries"] if e["id"] in set(member_ids)]
    old_anchors = sorted({e["dup"] for e in members if e.get("dup")})
    if old_anchors:
        anchor = old_anchors[0]
    else:
        anchor = min(members, key=lambda x: x.get("created_at", ""))["id"]
    for e in store["entries"]:
        if e["id"] in old_anchors or e.get("dup") in old_anchors or e["id"] in set(member_ids):
            e["dup"] = anchor
    return anchor


def dup_group_labels(store: dict, anchor: str) -> str:
    """重复组里各条目的「标签 (id)」清单，用于人话提示。"""
    members = [e for e in store["entries"] if e.get("dup") == anchor]
    return "、".join(f"{e.get('label') or '-'} ({e['id']})" for e in members)


# --------------------------------------------------------------------------
# 密码表读写
# --------------------------------------------------------------------------
def empty_store() -> dict:
    return {
        "version": STORE_VERSION,
        "gen": 1,
        "params": {"kdf": KDF_NAME, "n": KDF_N, "r": KDF_R, "p": KDF_P,
                   "dklen": KDF_DKLEN, "salt_bytes": KDF_SALT_BYTES},
        "entries": [],
    }


def store_path(state: Path) -> Path:
    return state / "passwords.json"


def load_store(state: Path) -> dict:
    p = store_path(state)
    if not p.exists():
        die(f"密码表不存在：{p}\n先跑：{prog()} init")
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        die(f"密码表不是合法 JSON：{p}\n{e}")
    validate_store(data, path=p)
    return data


def validate_store(data: dict, *, path: Path | None = None) -> None:
    """严格校验，宁可拒绝也不「尽力解析」（方案 §9/§12）。"""
    where = f"（{path}）" if path else ""
    if not isinstance(data, dict):
        die(f"密码表结构错误{where}：顶层不是对象")
    if data.get("version") != STORE_VERSION:
        die(f"密码表版本不支持{where}：{data.get('version')!r}，期望 {STORE_VERSION}")
    if not isinstance(data.get("gen"), int) or data["gen"] < 0:
        die(f"密码表 gen 字段非法{where}")
    params = data.get("params")
    if not isinstance(params, dict) or params.get("kdf") != KDF_NAME:
        die(f"密码表 params 非法{where}：只支持 {KDF_NAME}")
    for k, want in (("n", KDF_N), ("r", KDF_R), ("p", KDF_P),
                    ("dklen", KDF_DKLEN), ("salt_bytes", KDF_SALT_BYTES)):
        if params.get(k) != want:
            die(f"密码表 KDF 参数 {k}={params.get(k)!r} 与工具不符（期望 {want}）{where}")
    entries = data.get("entries")
    if not isinstance(entries, list):
        die(f"密码表 entries 非法{where}：不是数组")
    if len(entries) > MAX_ENTRIES:
        die(f"密码条目过多{where}：{len(entries)} > 上限 {MAX_ENTRIES}")
    seen = set()
    for i, e in enumerate(entries):
        if not isinstance(e, dict):
            die(f"第 {i} 条密码不是对象{where}")
        eid = e.get("id")
        if not isinstance(eid, str) or not eid or len(eid) > 32:
            die(f"第 {i} 条密码 id 非法{where}")
        if eid in seen:
            die(f"密码 id 重复：{eid}{where}")
        seen.add(eid)
        for field, cap in (("label", MAX_LABEL), ("note", MAX_NOTE)):
            v = e.get(field, "")
            if not isinstance(v, str) or len(v) > cap:
                die(f"密码 {eid} 的 {field} 非法（须为长度 ≤{cap} 的字符串）{where}")
        for field in ("salt", "hash"):
            v = e.get(field)
            if not isinstance(v, str) or not v:
                die(f"密码 {eid} 缺 {field}{where}")
            try:
                raw = b64d(v)
            except Exception:
                die(f"密码 {eid} 的 {field} 不是合法 Base64{where}")
            if field == "salt" and len(raw) != KDF_SALT_BYTES:
                die(f"密码 {eid} 的 salt 长度错误：{len(raw)} ≠ {KDF_SALT_BYTES}{where}")
            if field == "hash" and len(raw) != KDF_DKLEN:
                die(f"密码 {eid} 的 hash 长度错误：{len(raw)} ≠ {KDF_DKLEN}{where}")
        if not isinstance(e.get("rev", 0), int):
            die(f"密码 {eid} 的 rev 字段非法{where}")
        # 可选字段：缺失时按「启用 + 永久」处理（兼容加这两个字段之前写下的表）
        if not isinstance(e.get("enabled", True), bool):
            die(f"密码 {eid} 的 enabled 不是布尔值{where}")
        exp = e.get("expires_at")
        if exp is not None and (not isinstance(exp, str) or not ISO_Z_RE.match(exp)):
            die(f"密码 {eid} 的 expires_at 不是 ISO UTC 串（如 2026-11-01T23:59:59Z）{where}")
        # 重复组标记（cmsui 底色用）：组锚的 id；可选字段，id 合法性不在这里追
        # （锚被删掉时组自然散，UI 对「组里只剩一条」不上色）
        dup = e.get("dup")
        if dup is not None and (not isinstance(dup, str) or not dup or len(dup) > 32):
            die(f"密码 {eid} 的 dup 不是合法的组锚 id{where}")


def save_store(state: Path, data: dict) -> None:
    """原子写 + 0600。"""
    state.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(state, 0o700)
    except OSError:
        pass
    tmp = store_path(state).with_suffix(".json.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, store_path(state))


def new_id(existing: set[str]) -> str:
    for _ in range(64):
        eid = secrets.token_hex(6)          # 12 个十六进制字符
        if eid not in existing:
            return eid
    die("无法生成唯一 id")


# --------------------------------------------------------------------------
# 「有没有忘记 push」——本地改动与服务端最后一次成功推送的比对
#
# 血泪教训：`add` 只写本地文件，线上要 `push` 才生效。用户加完密码直接去浏览器
# 试，看到「密码不正确」，以为是密码记错了 / 闸门坏了。工具必须自己把这件事说出来，
# 而不是在输出末尾附一句「别忘了推送」（没人看得到）。
# --------------------------------------------------------------------------
def store_sha(state: Path) -> str:
    p = store_path(state)
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else ""


def pushed_marker_path(state: Path) -> Path:
    return state / ".pushed"


def mark_pushed(state: Path, sha: str) -> None:
    try:
        state.mkdir(parents=True, exist_ok=True)
        fd = os.open(pushed_marker_path(state), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(sha + "\n")
    except OSError:
        pass                                    # 标记写不了只是少一层提醒，不该让命令失败


def read_pushed(state: Path) -> str:
    try:
        return pushed_marker_path(state).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def push_state(state: Path) -> str:
    """返回 'clean'（与服务端一致）/ 'pending'（有改动未推送）/ 'unknown'（没有推送记录）。"""
    cur = store_sha(state)
    if not cur:
        return "unknown"
    was = read_pushed(state)
    if not was:
        return "unknown"
    return "clean" if was == cur else "pending"


def warn_if_pending_push(state: Path) -> None:
    """任何改动本地密码表的命令结束后都调它。**要显眼**——用户就是在这里栽的。"""
    st = push_state(state)
    if st == "clean":
        return
    info("")
    if st == "pending":
        info("  ⚠⚠ 本地改动**还没推送**到服务器——线上现在仍然是旧的密码表，")
        info("      新加的密码 / 刚禁用的密码此刻都不生效。")
    else:
        info("  ⚠ 无法确认线上是否是最新的（本机没有推送记录）。")
    info(f"      推送命令： {prog()} push")


# --------------------------------------------------------------------------
# 闸门全局配置（gateconfig.json）
#
# **只在服务器上保存**（里面是管理口令的哈希）。本地不留副本，免得出现
# 「删掉本地文件就能绕过校验」这种假安全感——切换开关本来就要 ssh。
# --------------------------------------------------------------------------
def validate_gate_config(data: dict, *, where: str = "") -> None:
    tag = f"（{where}）" if where else ""
    if not isinstance(data, dict):
        die(f"闸门配置结构错误{tag}：顶层不是对象")
    if data.get("version") != GATE_VERSION:
        die(f"闸门配置版本不支持{tag}：{data.get('version')!r}，期望 {GATE_VERSION}")
    if not isinstance(data.get("require_password"), bool):
        die(f"闸门配置 require_password 不是布尔值{tag}")
    updated = data.get("updated_at", "")
    if not isinstance(updated, str) or (updated and not ISO_Z_RE.match(updated)):
        die(f"闸门配置 updated_at 非法{tag}")
    admin = data.get("admin")
    if admin is None:
        return
    if not isinstance(admin, dict) or admin.get("kdf") != KDF_NAME:
        die(f"闸门配置 admin 非法{tag}")
    for k, want in (("n", KDF_N), ("r", KDF_R), ("p", KDF_P),
                    ("dklen", KDF_DKLEN), ("salt_bytes", KDF_SALT_BYTES)):
        if admin.get(k) != want:
            die(f"闸门配置 admin.{k}={admin.get(k)!r} 不符（期望 {want}）{tag}")
    for field, want_len in (("salt", KDF_SALT_BYTES), ("hash", KDF_DKLEN)):
        v = admin.get(field)
        if not isinstance(v, str) or not v:
            die(f"闸门配置 admin 缺 {field}{tag}")
        try:
            raw = b64d(v)
        except Exception:
            die(f"闸门配置 admin.{field} 不是合法 Base64{tag}")
        if len(raw) != want_len:
            die(f"闸门配置 admin.{field} 长度错误：{len(raw)} ≠ {want_len}{tag}")


def make_admin_block(pw: str) -> dict:
    salt_b64, hash_b64 = hash_password(pw)
    return {"kdf": KDF_NAME, "n": KDF_N, "r": KDF_R, "p": KDF_P,
            "dklen": KDF_DKLEN, "salt_bytes": KDF_SALT_BYTES,
            "salt": salt_b64, "hash": hash_b64, "set_at": now_iso()}


def _read_secret(a, prompt: str, *, min_len: int = 1) -> str:
    """读管理口令。**只从 stdin 读，绝不从 argv 读**（argv 会被 ps 与 shell 历史看到）。"""
    if getattr(a, "password_stdin", False):
        pw = sys.stdin.readline().rstrip("\n")
    else:
        try:
            pw = getpass.getpass(prompt)
        except (EOFError, KeyboardInterrupt):
            print()
            die("已取消")
    if len(pw) < min_len:
        die(f"口令至少 {min_len} 个字符，你给的只有 {len(pw)} 个（中文按 1 个字算）。")
    return pw


# --------------------------------------------------------------------------
# stdin 的消费约定
# --------------------------------------------------------------------------
#
# 为什么需要约定：`add` / `passwd` 的 `--password-stdin` 早就把 stdin 用于**新密码**了。
# 加了管理口令校验后，同一条命令可能要连续读两行（先是管理口令，再是新密码）。
# 读是能读的，但没有写死顺序就很容易在某次重构里调换——而顺序错了只表现为
# 「口令莫名其妙不对」，极难排查。
#
# 约定：**同一进程内按调用顺序逐行消费**（sys.stdin.readline 本身就是这个语义）。
#   管理口令（--admin-stdin）→ 新密码（--password-stdin）
# 不要用 sys.stdin.read()：它会一直读到 EOF，交互式敲 `--password-stdin`
# 的人输完密码按回车后会**挂住**等 Ctrl-D。逐行读没这个问题。


def _stdin_line() -> str:
    """从 stdin 取一行（去掉行尾换行）。多次调用按顺序消费。

    ⚠️ 调用前**必须**把需要交互的子进程（ssh / scp）跑完。
       它们会继承同一个 stdin，并且在需要认证时把管道里的内容读空——
       于是后面这里就变成「stdin 已结束」。这个坑的表现是
       「密码明明给了却说没给」，很难第一眼联想到 ssh。
       所以顺序固定为：先远端交互（如果有），再读口令。
    """
    line = sys.stdin.readline()
    if not line:
        die("stdin 已结束，但还需要一行输入（管理口令）。\n"
            "  若你用的是 `printf ... | cms push --admin-stdin`，检查一下管道里是否真有内容。")
    return line.rstrip("\n")


def _refuse_argv_admin(a) -> None:
    """接住「管理口令写在命令行里」——`ps aux` 能看到，shell 历史也会留下。

    与 `_refuse_argv_password` 分开是因为它对应另一个隐藏参数（`--admin`）。
    """
    if getattr(a, "admin_argv", None):
        die("管理口令不要写在命令行里：`ps aux` 能看到、shell 历史也会留下。\n"
            "  改用 --admin-stdin（从 stdin 喂）或直接回车在提示里输入（不回显）。")


#: 会被拼进**远端 shell 命令串**的三个参数，允许的字符集。
#: 刻意不含空格与任何 shell 元字符（`' " ` $ \ ; & | ( )` 换行）。
_SAFE_HOST_RE = re.compile(r"[A-Za-z0-9._:@/-]{1,128}")
_SAFE_PATH_RE = re.compile(r"[A-Za-z0-9._/-]{1,200}")


def _refuse_shell_unsafe_endpoints(a) -> None:
    """`--server / --remote-dir / --web-root` 里不许出现引号、空格与 shell 元字符。

    为什么在入口处一次性设卡，而不是要求每一处拼接都记得 `shlex.quote`：
    这三个值散落在**十几条**远端命令里（`cd '<web_root>' && …`、
    `printf … > '<state>.new'`、scp 的目标路径、备份轮转的 `ls -1t`…），
    漏掉一处就是一次「以 root 在服务器上执行任意命令」，而且脚本照常打印
    「✓ 已推送」—— 事后没有任何痕迹。字符集收紧的代价（服务器路径本来就该是
    ASCII 绝对路径）远小于这个失败模式。
    """
    for flag, val, pat, why in (
        ("--server", a.server, _SAFE_HOST_RE, "user@host，只允许字母数字与 . _ : @ / -"),
        ("--remote-dir", a.remote_dir, _SAFE_PATH_RE, "绝对路径，不含空格"),
        ("--web-root", a.web_root, _SAFE_PATH_RE, "绝对路径，不含空格"),
    ):
        if not pat.fullmatch(val or ""):
            die(f"{flag} 的值不合规矩：{val!r}\n"
                f"  要求：{why}。\n"
                f"  为什么管这么宽：它会被拼进服务器上的 shell 命令串，一个 `'` 就能"
                f"提前闭合引号，后半段以 root 执行。")
        # 以 `-` 开头另有一层风险：`--server=-oProxyCommand=…` 用等号形式时 argparse
        # 照样收下它，于是这个值被 ssh 当成**自己的选项**，在**本机**执行任意命令。
        # 字符集里没有 `=` 和空格，所以 ProxyCommand 那串写不出来；这条把源头堵住。
        if (val or "").startswith("-"):
            die(f"{flag} 的值不能以 `-` 开头：{val!r}\n"
                f"  ssh 会把它当成自己的选项（`-oProxyCommand=` 之类能直接执行命令），"
                f"而不是主机名。")


def _read_admin_secret(a, action: str) -> str:
    """读管理口令：交互式隐藏输入，或 `--admin-stdin` 从 stdin 消费一行。"""
    if getattr(a, "admin_stdin", False):
        return _stdin_line()
    try:
        return getpass.getpass(f"管理口令（{action}需要）: ")
    except (EOFError, KeyboardInterrupt):
        print()
        die("已取消")


def _positive_number(raw: str, what: str, lo: float, hi: float) -> float:
    """把 `--days` / `--hours` 的值读成小数并校验范围。

    故意**不用** `type=float`：argparse 对非法值只会报一句英文
    `invalid float value: '7.5天'`，用户看不出是自己写错了单位还是格式不对。
    """
    s = str(raw).strip()
    try:
        v = float(s)
    except ValueError:
        die(f"{what} 的值 {s!r} 不是数字。\n"
            f"  按天写 --days 7，按小时写 --hours 6；都支持小数"
            f"（半天 --days 0.5、半小时 --hours 0.5）。")
    if v != v or v in (float("inf"), float("-inf")):      # NaN / Inf
        die(f"{what} 的值 {s!r} 不是有限数字（不能是 nan 或 inf）")
    if not lo <= v <= hi:
        die(f"{what} 应在 {lo:g}..{hi:g} 之间（收到 {v:g}）")
    return v


#: 哪几个参数算「用户给了有效期」。**只在这里定义一次。**
#
# 为什么单独拎出来：`cmd_add` 里原本手写了一遍
#     has_exp = (days is not None or until or never)
# 漏掉了 `--hours`，于是 `cms add --hours 6` 被**静默忽略**、照样永久有效。
# 这类「清单抄两遍，漏一个」的 bug 不会报错，只会让人觉得"命令没生效"。
# 现在两边都从这一个元组取，加新参数不会再漏。
EXPIRY_ARG_NAMES = ("hours", "days", "until")


def expiry_given(a) -> bool:
    """用户到底给没给有效期？不给 = 永久（`expiry_from_args` 什么都没给时会 die）。"""
    return any(getattr(a, n, None) is not None for n in EXPIRY_ARG_NAMES) \
        or bool(getattr(a, "never", False))


def expiry_from_args(a) -> str | None:
    """`--hours H` / `--days N` / `--until YYYY-MM-DD` / `--never` → ISO UTC 串（None = 永久）。

    **天数与小时都支持小数**（`--days 0.5` = 12 小时），内部统一按秒算。
    存储精度到秒。
    """
    hours = getattr(a, "hours", None)
    days = getattr(a, "days", None)
    until = getattr(a, "until", None)
    given = [f"--{n}" for n in EXPIRY_ARG_NAMES if getattr(a, n, None) is not None]

    if getattr(a, "never", False):
        if given:
            die("--never 不能与 --hours / --days / --until 同时使用")
        return None
    if len(given) > 1:
        die(f"这几个参数只能给一个：{'、'.join(given)}")

    if hours is not None:
        h = _positive_number(hours, "--hours", 0.01, 24 * 3650)
        return (datetime.now(timezone.utc) + timedelta(hours=h)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if days is not None:
        d = _positive_number(days, "--days", 0.01, 3650)
        return (datetime.now(timezone.utc) + timedelta(days=d)).strftime("%Y-%m-%dT%H:%M:%SZ")
    if until:
        try:
            d = datetime.strptime(until, "%Y-%m-%d")
        except ValueError:
            die("--until 格式应为 YYYY-MM-DD")
        # 取当天结束（UTC 23:59:59）——符合「有效期到某天」的直觉
        return d.replace(hour=23, minute=59, second=59,
                         tzinfo=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    die("需要 --hours H / --days N / --until YYYY-MM-DD / --never 四者之一")


def entry_state(e: dict) -> str:
    if not e.get("enabled", True):
        return "已禁用"
    exp = e.get("expires_at")
    if exp:
        try:
            t = datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            if t < datetime.now(timezone.utc):
                return "已过期"
        except ValueError:
            return "有效期非法"
    return "启用"


def entry_expiry_text(e: dict, *, utc: bool = False) -> str:
    exp = e.get("expires_at")
    if not exp:
        return "永久"
    # `--utc` 分支也要把 "T" 换成空格：这一列与相邻列都是 "YYYY-MM-DD HH:MM:SS"，
    # 只有它是 "YYYY-MM-DDTHH:MM:SS"，表格会看着像多了一道竖线。
    return str(exp)[:19].replace("T", " ") if utc else iso_to_local(exp)


# --------------------------------------------------------------------------
# 服务器上的 JSON 读写（原子、可回滚）
# --------------------------------------------------------------------------
def remote_path(a, name: str) -> str:
    return f"{a.remote_dir}/{name}"


def remote_read_json(a, name: str) -> dict | None:
    """从服务器读一份 JSON。文件不存在返回 None；内容非法直接报错，不猜。"""
    r = run(ssh_cmd(a) + [f"cat {remote_path(a, name)} 2>/dev/null"], check=False)
    txt = (r.stdout or "").strip()
    if r.returncode != 0 or not txt:
        return None
    try:
        return json.loads(txt)
    except json.JSONDecodeError as e:
        die(f"服务器上的 {name} 不是合法 JSON：{e}")


def remote_rotate_bak(a, remote_file: str) -> None:
    """只保留最近 BAK_KEEP 份 {remote_file}.bak-<epoch>，删掉更旧的。
    ls -1t 按 mtime 新→旧，tail -n +BAK_KEEP+1 吐出该留的之外那些，xargs -r 空输入不动手。
    纯清理，失败绝不影响 push（check=False）；服务器是 GNU，-r 可用。"""
    run(ssh_cmd(a) + [f"ls -1t {remote_file}.bak-* 2>/dev/null | tail -n +{BAK_KEEP + 1} "
                      f"| xargs -r rm -f"], check=False)


def remote_put_json(a, name: str, data: dict, *, label: str) -> None:
    """原子替换服务器上的一份 JSON：.new → 远端预校验 → 备份 → mv（与 push 同套路）。"""
    dst = remote_path(a, name)
    tmp = dst + ".new"
    fd, local = tempfile.mkstemp(prefix="cmsgate-", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.chmod(local, 0o600)
        r = run(["scp", "-P", a.ssh_port, "-o", "BatchMode=yes", local, f"{a.server}:{tmp}"],
                check=False)
        if r.returncode != 0:
            die(f"scp 失败（{label}）：{r.stderr.strip() or r.stdout.strip()}")
        r = run(ssh_cmd(a) + [f"python3 -m json.tool {tmp} >/dev/null"], check=False)
        if r.returncode != 0:
            run(ssh_cmd(a) + [f"rm -f {tmp}"], check=False)
            die(f"远端 JSON 预校验失败（{label}），已丢弃 .new；线上未被改动")
        run(ssh_cmd(a) + [f"[ -f {dst} ] && cp -a {dst} {dst}.bak-$(date +%s) || true"],
            check=False)
        remote_rotate_bak(a, dst)
        r = run(ssh_cmd(a) + [f"mv {tmp} {dst} && chown cmsgate:cmsgate {dst} "
                              f"&& chmod 600 {dst}"], check=False)
        if r.returncode != 0:
            die(f"远端替换失败（{label}）：{r.stderr.strip()}")
    finally:
        os.unlink(local)


def remote_store_gen(a) -> int | None:
    """服务器上密码表的 gen。用于阻止「把旧 gen 推上去」这种会踢掉所有人的误操作。"""
    data = remote_read_json(a, "passwords.json")
    if isinstance(data, dict) and isinstance(data.get("gen"), int):
        return data["gen"]
    return None


def gate_audit(state: Path, what: str) -> None:
    """本地审计：谁在什么时候动过总开关 / 管理口令。只记本地，不涉密。"""
    try:
        state.mkdir(parents=True, exist_ok=True)
        p = state / "gate_audit.jsonl"
        fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps({"ts": now_iso(), "action": what}, ensure_ascii=False) + "\n")
    except OSError as e:
        # 写失败不该让命令失败（改动可能已经生效了），但**必须吭声**：
        # 静默的审计等于没有审计，事后查「谁换的入口」会得到一片空白。
        print(f"  ⚠ 审计写入失败（{state / 'gate_audit.jsonl'}）：{e}", file=sys.stderr, flush=True)


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --------------------------------------------------------------------------
# 管理口令：写操作的两层门之一
# --------------------------------------------------------------------------
#
# 为什么除 SSH 私钥之外还要再要一次口令——**两道门挡的是不同的东西**：
#
#   SSH 私钥（BatchMode=yes，服务器强制公钥）挡的是「网络上的攻击者」：
#   私钥没泄露，工具就完全连不上服务器，所有远端命令都无从谈起。
#
#   管理口令挡的是「已经拿到你本机用户权限的人」：能以你的身份跑进程，就能读
#   ~/.cmsgate/passwords.json（0600，只挡别人不挡你）、能改 gen、能 add 密码。
#   这些改动**一旦 push 就立即对所有人生效**——而 push 只需要敲一下回车。
#   没有第二道门时，「拿到本机文件」≈「拥有整个网站」。
#
# 所以：**读操作不需要口令，写操作一律需要**。
#
# 不提供 --no-admin-check 之类的绕过开关：那等于把这道门又变成装饰。
# 真要绕过（比如自动化），用 --admin-stdin 从管道喂，不在 argv 里留痕。

#: 必须先校验管理口令才能执行的命令（凡是会改动本地表或线上状态的）。
ADMIN_GUARDED_CMDS = frozenset({
    "add", "rm", "disable", "enable", "expire", "passwd", "note",
    "push", "pull", "revoke-all", "dupmark",
})

#: 明确豁免的命令及理由。**任何豁免都要在这里写清为什么**，
#: 免得后来的人顺手加一条就把门拆了。
ADMIN_EXEMPT_CMDS = {
    # 设置管理口令本身：此时还没有口令可校验，只能靠 SSH 私钥。
    # 这也是唯一合理的 bootstrap 路径。--force 覆盖时同样只靠私钥。
    "admin-init": "首次设置管理口令，此时无从校验（bootstrap 路径，只靠 SSH 私钥）",
    # 更换管理口令：**已经**校验当前口令了（cmd_admin_passwd 第一步就 verify），
    # 重复问一次当前口令没有任何额外保护作用，只会让用户输两遍。
    # 注意：它能改口令这件事本身仍是两道门（SSH 私钥 + 当前口令）。
    "admin-passwd": "cmd_admin_passwd 已先校验「当前管理口令」，不必问两遍",
    # 读操作不碰密码表，也不碰线上状态。
    "list": "只读本地表", "show": "只读", "usage": "只读",
    "init": "只建空表，无凭据泄露", "selftest": "自检无副作用",
    # gate 已有自己的校验路径（在 cmd_gate 里就地校验，见下方 note）。
    "gate": "cmd_gate 内部自己校验管理口令，不要重复问用户",
    # 同理：webbg 的 status 是只读、不该问口令；on/off/push 在 cmd_webbg 里
    # 就地 require_admin。这里豁免只是为了**别把 status 也拦下来要口令**。
    "webbg": "cmd_webbg 内部自己校验（status 只读不问口令），不要重复问用户",
    # 同理：landing 的 status 只读、不该问口令；learn/game 在 cmd_landing 里
    # 就地 require_admin。豁免同样只是为了别把只读的 status 也拦下来要口令。
    "landing": "cmd_landing 内部自己校验（status 只读不问口令），不要重复问用户",
    # 同理：gate-path 的 status 只读、不该问口令；set/rotate 在 cmd_gate_path 里
    # 就地 require_admin。
    "gate-path": "cmd_gate_path 内部自己校验（status 只读不问口令），不要重复问用户",
}

#: **在命令自己内部**校验管理口令的命令（不在 ADMIN_GUARDED_CMDS 里，
#: 因为它们的 `status` 是只读的，不该问口令；但 `on/off/push`、`learn/game`、
#: `set/rotate` 必须问）。
#:
#: 界面（gate_ui._verify_ops）要判断「这个操作喂了 admin 行对不对」，靠的就是这个
#: 集合——**别在界面里硬编码命令名**，那会变成第二份清单，改名时静默失效。
INPLACE_ADMIN_CMDS = frozenset({"gate", "webbg", "landing", "gate-path"})
assert INPLACE_ADMIN_CMDS <= set(ADMIN_EXEMPT_CMDS), "就地校验的命令必须同时写进豁免表并说明理由"
assert not (INPLACE_ADMIN_CMDS & ADMIN_GUARDED_CMDS), \
    "就地校验的命令不能同时出现在 ADMIN_GUARDED_CMDS 里（会问两遍口令）"

#: 校验通过时提示用户「你正在保护什么」用的一句话。
_ADMIN_ACTION_TEXT = {
    "add": "新增密码", "rm": "删除密码", "disable": "禁用密码",
    "enable": "启用密码", "expire": "改有效期", "passwd": "轮换密码",
    "note": "改备注", "push": "推送到服务器", "pull": "从服务器拉取（会覆盖本地）",
    "revoke-all": "踢掉所有在线会话",
}


def require_admin(a, *, action: str) -> None:
    """写操作前的管理口令校验。口令不对就 `die`，绝不静默放行。

    口令**只从 stdin / 交互式隐藏输入**读，绝不从 argv 读——
    argv 对同机任何进程可见（`ps aux`），还会进 shell 历史。

    `action` 是一句中文说明，会印在提示符与审计里，让人知道自己正在被保护。
    """
    # ── 离线自检旁路（**只能显式开，且必须留痕**）──
    # selftest 要在没有服务器的情况下验证「改了 gen 对不对」「密码写没写进去」
    # 这类**纯本地逻辑**，否则它每次都得连线上、还得知道管理口令明文——
    # 那等于把口令交给测试脚本。
    #
    # ★ 2026-10-21 从环境变量 `CMSGATE_OFFLINE_SELFTEST` 改成显式 argv 参数。
    #   原因是环境变量的失效方式很静默：它会被**每一个子进程继承**，谁在 shell
    #   里 export 过一次忘了取消，之后的写操作就都在拿「自己指定的那份假凭据」
    #   做认证——而认证过了，命令随后**照样按 --server 去连真实服务器**。
    #   （旧注释写的「不可能被用来操作真实服务器」是错的，别再信它。）
    #   argv 参数不会被继承，路径也不是密钥，所以进 argv 安全。
    # ★ 这个文件等于「一把你自己写的管理口令表」，所以要求它 0600 且属主是自己：
    #   否则别人（或某个共享目录里放着的）一份可写 config 就成了你的凭据来源。
    # ★ 走这条分支也要写审计，且明确标出 offline：事后能从 usage/audit 里看出
    #   「那次写操作没经过线上 gateconfig」。
    offline_cfg = getattr(a, "offline_admin_config", None)
    if offline_cfg:
        # ★ 2026-10-22：这条旁路只允许**纯本地**的密码表操作（selftest 要跑的那些）。
        #   它校验的是「你自己指定的一份假凭据」——如果还能授权 webbg/landing/
        #   gate-path/push/pull，那就等于「本机上一个能写文件的人，可以绕过管理口令
        #   去改线上状态」，第二道门直接作废。
        _cmd = getattr(a, "cmd", "")
        _local = _cmd in {"add", "rm", "disable", "enable", "expire", "passwd", "note",
                          # dupmark 只写本地 passwords.json 的 dup 字段（组标记），
                          # 不碰线上；推送仍要走 push 的口令。
                          "dupmark"}
        if _cmd == "revoke-all":
            # 不带 --no-push 会推送 gen 到线上；不带 --yes 的调用稍后本来就会拒绝，
            # 放它过去让那条「请加 --yes」的提示照常出现。
            _local = bool(getattr(a, "no_push", False) or not getattr(a, "yes", False))
        if not _local:
            die(f"--offline-admin-config 只能用于纯本地的密码表操作；"
                f"「{action}」（{_cmd or '?'}）会改动线上状态，必须用服务器上的管理口令。")
        # 直接读本地文件，**不要走 remote_read_json**（那个会拼 remote_dir 前缀再走 ssh，
        # 拿本地绝对路径去 cat 只会读到空）。
        f = Path(offline_cfg)
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
            st = f.stat()
        except (OSError, json.JSONDecodeError) as e:
            die(f"--offline-admin-config 指向的文件读不出来：{offline_cfg}（{e}）")
        if st.st_mode & 0o077 or st.st_uid != os.getuid():
            die(f"--offline-admin-config 指向的文件权限必须是 0600 且属主是你自己："
                f"{offline_cfg}（现在 {oct(st.st_mode & 0o777)}，uid {st.st_uid}）。"
                f"\n  它是「你自己指定的一份管理凭据」，别人能改就等于别人能过这道门。")
        if not isinstance(data, dict) or not isinstance(data.get("admin"), dict):
            die(f"--offline-admin-config 指向的文件里没有 admin 块：{offline_cfg}")
        admin = data["admin"]
        pw = _read_admin_secret(a, action)
        if not verify_password(pw, admin["salt"], admin["hash"]):
            die(f"管理口令不正确，「{action}」**未**执行。")
        gate_audit(a.state, f"admin-ok-offline:{action}")
        info(f"⚠ 本次「{action}」的管理口令校验走的是**离线自检凭据**（{offline_cfg}），"
             f"不是服务器上的那份。这是给 selftest/测试用的，别在真实运维时用。")
        return
    _refuse_argv_admin(a)
    cfg = _load_gate_config(a)
    admin = cfg.get("admin")
    if not isinstance(admin, dict):
        die(f"服务器上没有管理口令，无法执行「{action}」。\n"
            f"  先设置： {prog()} admin-init\n"
            f"  （设置口令这一步只靠 SSH 私钥；设好之后所有写操作都会问口令。）")
    pw = _read_admin_secret(a, action)
    if not verify_password(pw, admin["salt"], admin["hash"]):
        die(f"管理口令不正确，「{action}」**未**执行。\n"
            f"  闸门状态： {prog()} gate status")
    gate_audit(a.state, f"admin-ok:{action}")


# --------------------------------------------------------------------------
# 网页背景图：一键撤下 / 恢复 / 换新图
# --------------------------------------------------------------------------
#
# 为什么要有它：背景图的**公开使用授权还没拿到**。在那之前必须能「点一下就撤下来」，
# 而且撤下来之后**原图要从公开目录里消失**——只在前端加个开关没有意义，
# `wget http://…/assets/bg.webp` 照样拿得到原图。
#
# 做法（全程 SSH，不碰前端、不碰 nginx、不用重新部署）：
#   off  把线上那张图挪进 {remote_dir}/webbg/（nginx **不服务**这个目录），
#        再把一张几十字节的纯白图放进原来的位置。访客刷新即白底，
#        而 wget 只能拿到白图。
#   on   从 {remote_dir}/webbg/ 搬回来。
#   push 本地转成 webp + jpg → 原子替换线上两张图（顺带更新备份）→ 置为「开」。
#
# ★ 三条必须如实说明的边界（别让人以为开了就万事大吉）：
#   ① 已经把图加载进来的浏览器，内存里仍有那张图（这是浏览器行为，撤不回来）。
#      新访问 / 刷新才会看到白底。
#   ② 2026-10-17 之前 nginx 给这两个文件发的是 `expires 7d`，于是**已经访问过**
#      的访客最长 7 天不会重新请求，界面上仍显示旧图。所以配套要改
#      deploy-web.sh 里这两个公开 location 的缓存头（改成 no-cache, must-revalidate），
#      否则「关掉」要等一周才见效。
#   ③ 再跑 deploy-web.sh 时 `rsync --delete` 会把本地 web/assets/bg.webp 重新同步
#      上去，等于又「开」了。`webbg status` 会检出这种漂移并明确提示。

#: 网站根目录（nginx 的 root）。**必须与 scripts/web/deploy-web.sh 的 REMOTE_DIR 一致**，
#: 否则推的图会落到一个没人访问的目录（selftest 里有一条断言专门盯这件事）。
DEFAULT_WEB_ROOT = "/srv/complexminesweeper"

#: 要一起换掉的两张图。少换一张就会留下漏网之鱼：
#:   assets/bg.webp —— 游戏 canvas 的内置背景（web/ts/renderer.ts 的 kDefaultBg）
#:   assets/bg.jpg  —— **密码页**的 CSS 背景，同时也是老浏览器解不开 webp 时的兜底
WEBBG_FILES = ("assets/bg.webp", "assets/bg.jpg")

#: 状态文件名（放在 remote_dir 下，nginx 不服务那里，所以访客看不到）。
WEBBG_STATE = "webbg.json"

#: 本地那张纯白图（关背景时推上去的就是它）。
WEBBG_BLANK_DIR = Path(__file__).resolve().parent / "webbg"


def webbg_backup_dir(a) -> str:
    """原图存放处。**必须在 nginx 的 root 之外**——放在里面等于没撤。"""
    return f"{a.remote_dir}/webbg"


#: 推图时把**原图**也存到这个文件名（私藏目录里，nginx 不服务）。
#: 为什么留：日后想换个尺寸 / 换个质量重新转码时，原图在手才不用重新找。
#: 命名固定（不按时间戳堆文件）——留的是「当前这张的原图」，
#: 而不是历史全量：原图动辄 5–6 MB，按时间戳堆很快就撑爆磁盘。
WEBBG_SOURCE_NAME = "source"

#: 本机 `state/uploads/` 只保留最近几张原图（每次推送一张进去）。
#: 10 张足够回溯，再多就是纯占地方（每张动辄 5–6 MB）。
WEBBG_UPLOAD_KEEP = 10


def uploads_dir(a) -> Path:
    """本机暂存目录（cmsui 上传落盘的地方）。"""
    return Path(a.state) / "uploads"


def prune_uploads(a, *, keep: int = WEBBG_UPLOAD_KEEP,
                  protect: Path | None = None) -> list[Path]:
    """暂存目录只留**最近 keep 张**（按 mtime），其余删掉。返回删掉的文件。

    为什么需要：每推一次图就多一个几 MB 的原图，不清的话很快就堆到几百 MB。
    「本地留一份」是有用的（重推时不用重新找图），但留十张足够回溯了。

    ★ 只动 `uploads/` 里的 `bg-*`：
      - 不碰别的目录（用户可能传的是自己 Desktop 里的图，那个**绝不能**删）；
      - `protect` 指定的文件（刚推的那张）永远不删；
      - 只删自己约定的前缀，目录里别人的东西原样保留。
    删不掉就跳过并如实报出来，不静默失败。
    """
    d = uploads_dir(a)
    if not d.is_dir():
        return []
    try:
        items = [p for p in d.iterdir()
                 if p.is_file() and p.name.startswith("bg-")]
    except Exception:
        return []
    if not items:
        return []
    # ★ **两边都要 resolve** 再比。macOS 上 `/var` 与 `/private/var` 是同一个
    #   目录、但字符串不同；只 resolve 一边 → `set` 比不相等 → protect 形同虚设
    #   （实测：明明 protect 了最老的那张，还是被删了）。
    items.sort(key=lambda p: (-p.stat().st_mtime, p.name))
    keep_set = {p.resolve() for p in items[:keep]}
    if protect is not None:
        try:
            keep_set.add(Path(protect).expanduser().resolve())
        except Exception:
            pass
    gone: list[Path] = []
    for p in items:
        try:
            if p.resolve() in keep_set:
                continue
        except Exception:
            continue
        try:
            p.unlink()
            gone.append(p)
        except Exception:
            continue                          # 删不掉就留着，别中断推送
    return gone


def webbg_state_path(a) -> str:
    return remote_path(a, WEBBG_STATE)


def _webbg_blank(kind: str) -> Path:
    p = WEBBG_BLANK_DIR / f"blank.{kind}"
    if not p.exists() or p.stat().st_size == 0:
        die(f"缺少本地白底图 {p}\n  （它应该在版本库里；缺了就重新生成一张纯白的）")
    return p


def webbg_blank_shas() -> dict:
    """本地两张白图的 sha256。用来判断线上是不是真的被换成了白图。"""
    out = {}
    for kind in ("webp", "jpg"):
        out[kind] = local_sha(_webbg_blank(kind))
    return out


def parse_webbg_probe(text: str) -> dict:
    """解析一次远端探针的输出。

    远端脚本只做「读」，输出固定的三段（`F` 文件 / `S` 状态 / `B` 备份），
    用 `F <路径> <sha|MISSING> <字节> <mtime>` 这种行式格式而不是 JSON：
    服务器上未必有 python3，JSON 也得拼接，而行式输出 `cut`/`awk` 就够。

    拆成独立纯函数是为了能**离线测**：这一段最容易错（少一个字段就静默
    变成「状态未知」），而真去连服务器测既慢又会碰线上机器。
    """
    files: dict = {}
    state: dict = {}
    backups: list = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("F "):
            parts = line.split()
            if len(parts) < 3:
                continue
            name = parts[1]
            if parts[2] == "MISSING":
                files[name] = {"present": False}
            else:
                files[name] = {
                    "present": True,
                    "sha": parts[2],
                    "size": int(parts[3]) if len(parts) > 3 and parts[3].isdigit() else None,
                    "mtime": int(parts[4]) if len(parts) > 4 and parts[4].isdigit() else None,
                }
        elif line.startswith("S "):
            try:
                obj = json.loads(line[2:] or "{}")
                if isinstance(obj, dict):
                    state = obj
            except json.JSONDecodeError:
                state = {}
        elif line.startswith("B "):
            backups = [b for b in line[2:].strip().split(",") if b]
    return {"files": files, "state": state, "backups": backups}


def webbg_probe(a) -> dict:
    """一次 SSH 读完所有需要的东西（**不要拆成多次 ssh**：会被限速，且状态会读串）。

    每行格式：`F <路径> <sha|MISSING> <字节> <mtime>`。
    ⚠️ sha 必须用 `$(...)` 取（管道会多出一个换行，把 sha 和 stat 拆成两行，
    解析器就会把 size 读成 None —— 这正是第一版栽的地方）。
    """
    root, backups, st = a.web_root, webbg_backup_dir(a), webbg_state_path(a)
    loop = " ".join(WEBBG_FILES)
    cmd = (
        f'for f in {loop}; do '
        f'if [ -f "$f" ]; then '
        f'printf "F %s %s " "$f" "$(sha256sum "$f" | cut -d" " -f1)"; stat -c "%s %Y" "$f"; '
        f'else printf "F %s MISSING\\n" "$f"; fi; done; '
        f'printf "S "; cat "{st}" 2>/dev/null || printf "{{}}"; printf "\\n"; '
        f'printf "B "; ls -1 "{backups}" 2>/dev/null | tr "\\n" ","; printf "\\n"'
    )
    r = run(ssh_cmd(a) + [f"cd {shq(root)} && {cmd}"], check=False)
    if r.returncode != 0:
        return {"files": {}, "state": {}, "backups": [], "error":
                (r.stderr or r.stdout or "").strip()[:200]}
    return parse_webbg_probe(r.stdout)


def webbg_status(a) -> dict:
    """背景图现状。**只读**，不要管理口令。"""
    p = webbg_probe(a)
    if p.get("error"):
        return {"reachable": False, "error": p["error"], "web_root": a.web_root}
    blank = webbg_blank_shas()
    mode = p["state"].get("mode") or "unknown"
    on_line = p["files"].get(WEBBG_FILES[0], {})
    is_blank = on_line.get("sha") == blank["webp"]

    # 漂移 = 记录的模式与线上实际内容对不上。最常见的原因是又跑了
    # deploy-web.sh（rsync --delete 把本地图同步回去了）。
    drifted = False
    if mode == "off":
        drifted = not is_blank
    elif mode == "on":
        backed = str(p["state"].get("webp_sha") or "")
        live = str(on_line.get("sha") or "")
        # 用**前缀**比较：早期版本存的是截断过的 16 位 sha。直接比会判成
        # 「永远不相等」→ 每次刚推完图就报漂移。
        # ★ 已知取舍：16 位记录遇上「前 16 位相同、后面被改」会漏判
        #   （32 bit 撞上 ≈ 1/2^32）。要根治就让新记录一律存全量（已改）。
        drifted = bool(backed) and bool(live) and not live.startswith(backed)
    return {
        "reachable": True,
        "web_root": a.web_root,
        "mode": mode,
        "is_blank": is_blank,
        "drifted": drifted,
        # ★ 必须过 iso_to_local：`at` 存的是 UTC（`2026-10-17T06:08:12Z`），
        #   东八区用户看到 06:08 会以为推图发生在早上六点（其实下午两点）。
        #   其它所有时间字段（条目表、访问表）早就是本地时间，只有这里漏了。
        #   iso_to_local 解析不了会原样返回，不会抛。
        "at": iso_to_local(p["state"].get("at") or ""),
        "at_utc": p["state"].get("at") or "",
        "source": p["state"].get("source") or "",
        "source_kept": p["state"].get("source_kept") or "",
        "source_bytes": p["state"].get("source_bytes") or 0,
        "note": p["state"].get("note") or "",
        "files": p["files"],
        "backups": p["backups"],
        "can_restore": "bg.webp" in p["backups"],
    }


#: 转 webp 用的参数。q=75 是肉眼几乎无损的档（记忆里那张 210 KB 的 jpg
#: 转成 82 KB 就是它），m=6 是一次性搜索，够快。
CWEBP_ARGS = ("-q", "75", "-m", "6")


def _tool(name: str) -> str | None:
    import shutil as _sh
    return _sh.which(name)


#: 推上去的背景图**长边上限**（像素）。超出的先等比缩小再转码。
#:
#: 为什么必须限：密码页是 `background-size: cover`、游戏 canvas 也是拉伸铺满，
#: 所以**任何超过屏幕的分辨率都是纯浪费**（cover 还会把溢出部分裁掉）。
#: 实测一张 4800×2738 的图，q75 转出来 511 KB；等比缩到 1920 长边后同样
#: q75 只要 **136 KB**（省 73%）。而显示效果在 1440 屏上**看不出差别**。
#: 更糟的是密码页有 `background-attachment: fixed` —— 每次滚动都要重绘
#: 整张图，图越大越卡。
WEBBG_MAX_EDGE = 1920


def _shrink_to(src: Path, dst: Path, max_edge: int) -> Path:
    """等比缩小到长边 ≤ max_edge；已经够小或缩不了就**原样返回 src**。

    返回值是**实际该用的那个文件路径** —— 调用方必须用返回值，不能继续用 src。
    缩图失败绝不能报错：原图能用就继续用，只是文件大一点而已。
    """
    try:
        dims = _image_size(src)
    except Exception:
        return src                       # 读不出尺寸 → 当它已经合格
    if not dims:
        return src
    w, h = dims
    if max(w, h) <= max_edge:
        return src                       # 已经够小，别做无谓的重编码（会掉画质）
    sips = _tool("sips")
    if sips:
        # ★ capture=True（默认）而不是 capture=False：sips 会把「改写了哪个文件」
        #   打到 stdout，capture=False 会让这些噪声混进命令输出里。
        #   这里本来就只看返回码，不读输出。
        r = run([sips, "-Z", str(max_edge), str(src), "--out", str(dst)],
                check=False)
        if r.returncode == 0 and dst.exists() and dst.stat().st_size > 0:
            return dst
    try:
        from PIL import Image
        with Image.open(src) as im:
            scale = max_edge / max(im.size)
            nw, nh = max(1, round(im.width * scale)), max(1, round(im.height * scale))
            im.convert("RGB").save(dst, "PNG", optimize=True)
        if dst.exists() and dst.stat().st_size > 0:
            return dst
    except Exception:
        pass
    return src                           # 缩不了就用原图，别静默失败


def _image_size(path: Path) -> tuple:
    """(宽, 高)。读不出就抛异常（调用方据此当作「不缩」）。"""
    sips = _tool("sips")
    if sips:
        r = run([sips, "-g", "pixelWidth", "-g", "pixelHeight", str(path)],
                check=False)
        out = (r.stdout or "") + (r.stderr or "")
        w = h = None
        for line in out.splitlines():
            if "pixelWidth" in line:
                w = int(line.rsplit(":", 1)[-1].strip())
            elif "pixelHeight" in line:
                h = int(line.rsplit(":", 1)[-1].strip())
        if w and h:
            return (w, h)
    from PIL import Image
    with Image.open(path) as im:
        return im.size


def webbg_encode(src: Path, out_webp: Path, out_jpg: Path,
                 workdir: Path | None = None) -> tuple:
    """一张图 → webp + jpg。两条路都失败就报错，**绝不悄悄只推一张**。

    少一张的后果：密码页（用 jpg）继续显示旧图，或者老浏览器（webp 解不开时
    回退 jpg）继续显示旧图 —— 而那正是「以为已经撤干净了」的假象。

    转码前先按 `WEBBG_MAX_EDGE` 等比缩小（见那里的说明）。缩小的中间文件放在
    `workdir`（没给就用系统临时目录），**不留**在用户目录里。
    """
    src = Path(src).expanduser()
    if not src.is_file():
        die(f"图片不存在： {src}")
    if src.stat().st_size == 0:
        die(f"图片是空文件： {src}")

    cw = _tool("cwebp")
    if not cw:
        die("找不到 cwebp（libwebp 的命令行工具），没法把图片转成 webp。\n"
            "  macOS: brew install webp")

    # ── 先缩到长边上限 ──
    if workdir is None:
        import tempfile
        with tempfile.TemporaryDirectory(prefix="cmsgate-webbg-") as td:
            return webbg_encode(src, out_webp, out_jpg, Path(td))
    small = _shrink_to(src, workdir / "small.png", WEBBG_MAX_EDGE)
    if small != src:
        try:
            w, h = _image_size(small)
            info(f"已缩到长边 ≤ {WEBBG_MAX_EDGE}：{w}×{h}")
        except Exception:
            info(f"已缩到长边 ≤ {WEBBG_MAX_EDGE}")

    r = run([cw, *CWEBP_ARGS, str(small), "-o", str(out_webp)], check=False)
    if r.returncode != 0 or not out_webp.exists() or out_webp.stat().st_size == 0:
        die(f"cwebp 转码失败：{(r.stderr or r.stdout or '').strip()[:300]}")

    # jpg：优先 sips（macOS 自带，零依赖），否则 Pillow。
    ok = False
    sips = _tool("sips")
    if sips:
        r = run([sips, "-s", "format", "jpeg", "-s", "formatOptions", "80",
                 str(small), "--out", str(out_jpg)], check=False)
        ok = r.returncode == 0 and out_jpg.exists() and out_jpg.stat().st_size > 0
    if not ok:
        try:
            from PIL import Image
            with Image.open(small) as im:
                im.convert("RGB").save(out_jpg, "JPEG", quality=80, optimize=True)
            ok = out_jpg.exists() and out_jpg.stat().st_size > 0
        except Exception:
            ok = False
    if not ok:
        die("转 jpg 也失败了（sips 与 Pillow 都不行）。\n"
            "  密码页与老浏览器都靠这张 jpg，不能只推 webp。")
    return local_sha(out_webp), local_sha(out_jpg)


def _remote_tmpdir(a, prefix: str) -> str:
    """在 remote_dir 下建一个**随机名**的临时目录，返回它的路径。

    为什么不能再用固定名（如 webbg-blank.webp.tmp）：remote_dir 的属主是
    cmsgate，而这条 scp 以 root 落地。谁能在里面预置一个同名软链，root 就会
    顺着链把上传内容写到任意路径（symlink 攻击）。mktemp -d 的名字不可预测。
    """
    pattern = shlex.quote(f"{a.remote_dir}/{prefix}.XXXXXX")
    r = run(ssh_cmd(a) + [f"umask 077 && mktemp -d {pattern}"], check=False)
    d = (r.stdout or "").strip()
    if r.returncode != 0 or not re.fullmatch(r"[A-Za-z0-9._/+-]+", d) \
            or f"/{prefix}." not in d or d.endswith("/"):
        die(f"服务器上建临时目录失败：{(r.stderr or r.stdout or '').strip()[:300]}")
    return d


def _scp_up(a, local: Path, remote_tmp: str, *, label: str) -> None:
    r = run(["scp", "-P", a.ssh_port, "-o", "BatchMode=yes", str(local),
             f"{a.server}:{remote_tmp}"], check=False)
    if r.returncode != 0:
        die(f"上传失败（{label}）：{(r.stderr or r.stdout or '').strip()[:300]}")


def _webbg_put_state(a, data: dict) -> None:
    """写状态文件（一次 SSH）。

    ★ payload 必须 `shlex.quote`：它里面有一个**外部来的字符串**——
      `webbg push --image <路径>` 把 `str(src)` 记进 `"source"` 字段。文件名里只要
      带一个 `'`（macOS 允许，聊天工具传来的图也常有），原来的写法
      `printf '%s' '<payload>'` 就会被那个引号**提前闭合**，剩下的部分以 root
      在服务器上执行，而脚本照常打印「✓ 已推送」，事后没有任何痕迹。
      路径本身（remote_dir / web_root）由 main() 的字符集关卡兜（见
      `_refuse_shell_unsafe_endpoints`），带内容的那一条只能在这里引对。
    """
    payload = json.dumps(data, ensure_ascii=False)
    path = webbg_state_path(a)
    r = run(ssh_cmd(a) + [f"printf '%s' {shlex.quote(payload)} > {shlex.quote(path + '.new')} && "
                          f"mv {shlex.quote(path + '.new')} {shlex.quote(path)} && "
                          f"chmod 600 {shlex.quote(path)}"], check=False)
    if r.returncode != 0:
        die(f"写背景图状态失败：{(r.stderr or r.stdout or '').strip()[:300]}")


def cmd_webbg(a) -> None:
    _refuse_argv_password(a)
    _refuse_argv_admin(a)
    action = a.action

    if action == "status":
        st = webbg_status(a)
        if a.json:
            print(json.dumps(st, ensure_ascii=False))
            return
        if not st.get("reachable"):
            die(f"读不到服务器上的背景图状态：{st.get('error')}")
        mode = st["mode"]
        shown = {"on": "开 —— 显示背景图", "off": "关 —— 纯白底",
                 "unknown": "从未操作过（默认开）"}[mode]
        info(f"网站根目录: {st['web_root']}")
        info(f"背景图    : {shown}")
        if st.get("source"):
            info(f"最近来源  : {st['source']}")
        if st.get("at"):
            info(f"上次改动  : {iso_to_local(st['at'])}")
        for name, f in st["files"].items():
            info(f"  {name:<18} "
                 + (f"{(f.get('size') or 0):>9,} 字节  sha {str(f.get('sha'))[:12]}"
                    if f.get("present") else "不存在"))
        info(f"私藏备份  : {', '.join(st['backups']) or '（没有）'}")
        if st["is_blank"]:
            info("线上当前拿到的就是那张纯白图。")
        if st["drifted"]:
            info("⚠ 记录与线上实际不一致 —— 多半是之后又跑过 deploy-web.sh"
                 "（rsync 会把本地图同步回去）。\n"
                 f"     对齐一下： {prog()} webbg off   或   {prog()} webbg push --image <图>")
        return

    # ── 写操作：先校验管理口令（与 push/rm 同一道门）──
    what = {"on": "恢复网页背景图", "off": "撤下网页背景图",
            "push": "推送新的网页背景图"}[action]
    require_admin(a, action=what)

    if action in ("on", "off"):
        st = webbg_status(a)
        if not st.get("reachable"):
            die(f"连不上服务器，什么都没改：{st.get('error')}")
        if action == "on" and not st["can_restore"]:
            die("私藏目录里没有原图，恢复不了。\n"
                "  （原图在关掉的那一刻被挪走了；现在只能推一张新的："
                f" {prog()} webbg push --image <图>）")
        if st["mode"] == action:
            info(f"背景图已经是「{'开' if action == 'on' else '关'}」，未做改动。")
            return

        backups, root = webbg_backup_dir(a), a.web_root
        want_blank = (action == "off")
        if want_blank:
            # 白图先 scp 到 **remote_dir 下的临时名**（那个目录一定存在：
            # 私藏目录可能还没建，直接 scp 进去会失败），再由同一个 ssh
            # 脚本 mkdir + 搬进去 + 替换 —— 全程只连一次。
            #
            # 远端靠**内容比对**判断「当前是不是已经是白图」：否则「关第二次」
            # 会把白图当成原件存起来，之后 on 回来就变成一张纯白图，且原图永丢。
            tmpdir = _remote_tmpdir(a, "webbg")
            for kind, rel in (("webp", WEBBG_FILES[0]), ("jpg", WEBBG_FILES[1])):
                _scp_up(a, _webbg_blank(kind), f"{tmpdir}/blank.{kind}",
                        label=f"blank.{kind}")
            script = "\n".join([
                "set -e",
                f"mkdir -p {shq(backups)}",
                f"chmod 700 {shq(backups)}",
            ] + [
                f"mv {shq(f'{tmpdir}/blank.{kind}')} {shq(f'{backups}/blank.{kind}')}"
                for kind, _ in (("webp", 0), ("jpg", 1))
            ] + [
                f"if [ -f {shq(rel)} ] && ! cmp -s {shq(rel)} {shq(f'{backups}/blank.{kind}')}; "
                f"then cp -a {shq(rel)} {shq(f'{backups}/{Path(rel).name}')}; fi"
                for kind, rel in (("webp", WEBBG_FILES[0]), ("jpg", WEBBG_FILES[1]))
            ] + [
                f"cp -a {shq(f'{backups}/blank.{kind}')} {shq(rel)}"
                for kind, rel in (("webp", WEBBG_FILES[0]), ("jpg", WEBBG_FILES[1]))
            ] + [f"rmdir {shq(tmpdir)}"])
        else:
            script = "\n".join(
                ["set -e"]
                + [f"test -s {shq(f'{backups}/{Path(rel).name}')}" for rel in WEBBG_FILES]
                + [f"cp -a {shq(f'{backups}/{Path(rel).name}')} {shq(f'{root}/{rel}')}" for rel in WEBBG_FILES]
            )
        r = run(ssh_cmd(a) + [f"cd {shq(root)} && {script}"], check=False)
        if r.returncode != 0:
            die(f"远端替换失败（线上未被改动）：{(r.stderr or r.stdout or '').strip()[:300]}")

        _webbg_put_state(a, {"mode": action, "at": now_iso(), "by": f"webbg {action}"})
        gate_audit(a.state, f"webbg {action}")
        info("")
        if want_blank:
            info("  ✓ 已撤下：游戏与密码页现在都是纯白底。")
            info(f"     原图挪到了 {backups}（nginx 不服务那个目录，wget 拿不到）。")
            info("     访客**刷新页面**后生效；已经加载过图的浏览器内存里仍有旧图。")
            info(f"     恢复： {prog()} webbg on")
        else:
            info("  ✓ 已恢复：原图回到网站目录，访客刷新即看到。")
        return

    # ── push：转码 → 上传 → 原子替换（顺带把新图存成私藏备份）──
    src = Path(a.image)
    if not src.is_file():
        die(f"图片不存在： {src}")
    backups, root = webbg_backup_dir(a), a.web_root
    # 原图的扩展名（存回服务器时保持原样，便于日后认出是什么格式）
    src_ext = (src.suffix or ".png").lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,5}", src_ext):
        src_ext = ".png"
    src_size = src.stat().st_size
    with tempfile.TemporaryDirectory(prefix="cmsgate-webbg-") as td:
        td = Path(td)
        webp, jpg = td / "bg.webp", td / "bg.jpg"
        webp_sha, jpg_sha = webbg_encode(src, webp, jpg)
        info(f"本地图片: {src}（{src_size:,} 字节）")
        info(f"转码结果: webp {webp.stat().st_size:,} 字节 · jpg {jpg.stat().st_size:,} 字节")
        _scp_up(a, webp, f"{root}/{WEBBG_FILES[0]}.new", label="bg.webp")
        _scp_up(a, jpg, f"{root}/{WEBBG_FILES[1]}.new", label="bg.jpg")

    # 原图先传到**私藏目录外的临时名**：目录可能还不存在，直接 scp 进去会失败。
    src_remote_tmp = f"{a.remote_dir}/webbg-source.tmp"
    _scp_up(a, src, src_remote_tmp, label=f"原图{src_ext}")

    # 白图也放进私有目录：以后 webbg off 才有「当前是不是白图」的判据
    _scp_up(a, _webbg_blank("webp"), f"{a.remote_dir}/webbg-blank.webp.tmp", label="blank.webp")
    _scp_up(a, _webbg_blank("jpg"), f"{a.remote_dir}/webbg-blank.jpg.tmp", label="blank.jpg")

    script = "\n".join(
        ["set -e", f"mkdir -p {shq(backups)}", f"chmod 700 {shq(backups)}"]
        + [f"mv {shq(f'{a.remote_dir}/webbg-blank.{kind}.tmp')} {shq(f'{backups}/blank.{kind}')}"
           for kind in ("webp", "jpg")]
        # 先确认两张新图都在，再开始替换——半张新图半张旧图比不改更糟
        + [f"test -s {shq(f'{rel}.new')}" for rel in WEBBG_FILES]
        + [f"mv {shq(f'{rel}.new')} {shq(rel)}" for rel in WEBBG_FILES]
        + [f"cp -a {shq(rel)} {shq(f'{backups}/{Path(rel).name}')}" for rel in WEBBG_FILES]
        # ★ 原图：先确认大小对得上（scp 中断会留下半个文件），再搬进私藏目录。
        #   `mv` 之后服务器上**不留任何临时文件**（失败路径另有一条 rm 兜底）。
        #   `rm -f source.*` 顺带清掉上一次的原图 —— 服务器上只留「当前这张」，
        #   免得每推一次多堆一份 6 MB。本地另留最近 10 张（见 WEBBG_UPLOAD_KEEP）。
        + [f"test $(wc -c < {shq(src_remote_tmp)}) -eq {src_size}"]
        + [f"rm -f {shq(backups)}/{WEBBG_SOURCE_NAME}.*"]
        + [f"mv {shq(src_remote_tmp)} {shq(f'{backups}/{WEBBG_SOURCE_NAME}{src_ext}')}"]
        + [f"chmod 600 {shq(f'{backups}/{WEBBG_SOURCE_NAME}{src_ext}')}"]
    )
    r = run(ssh_cmd(a) + [f"cd {shq(root)} && {script}"], check=False)
    if r.returncode != 0:
        run(ssh_cmd(a) + [f"rm -f {shq(f'{root}/{WEBBG_FILES[0]}.new')} {shq(f'{root}/{WEBBG_FILES[1]}.new')} "
                          f"{shq(src_remote_tmp)}"], check=False)
        die(f"远端替换失败，已清掉临时文件（线上未被改动）："
            f"{(r.stderr or r.stdout or '').strip()[:300]}")

    _webbg_put_state(a, {"mode": "on", "at": now_iso(), "by": "webbg push",
                         "source": str(src), "source_kept":
                             f"{backups}/{WEBBG_SOURCE_NAME}{src_ext}",
                         "source_bytes": src_size,
                         "webp_sha": webp_sha, "jpg_sha": jpg_sha})
    gate_audit(a.state, "webbg push")

    # ── 本地暂存目录只保留最近 N 张（不含刚推的这张之外的旧图）──
    pruned = prune_uploads(a, keep=WEBBG_UPLOAD_KEEP, protect=src)

    info("")
    info("  ✓ 已推送并**置为「开」**：游戏与密码页都用新图。")
    info(f"     新图同时存进了 {backups}，所以 {prog()} webbg off 之后还能 on 回来。")
    info(f"     **原图也存到了 {backups}/{WEBBG_SOURCE_NAME}{src_ext}**"
         f"（{src_size:,} 字节）——日后想换个尺寸重转时不用再找原图。"
         f"服务器上的临时文件已清掉。")
    if pruned:
        info(f"     本地暂存只留最近 {WEBBG_UPLOAD_KEEP} 张，清掉 {len(pruned)} 个旧的："
             + "、".join(p.name for p in pruned))
    info("     访客刷新页面即生效。")

    # ── 顺手重建桌面端图标（纯本地，不碰线上）──
    # 只有明确给了 --desktop 才会真去换 assets/bg.jpg；不给也仍会重建图标
    # （源图没变时是幂等的，顺手做一下省得用户以为图标坏了）。
    # 桌面端：mac 与 win 分别独立开关（它们读各自产物目录里的 assets/）
    want_mac = getattr(a, "mac", False) or getattr(a, "desktop", False)
    want_win = getattr(a, "win", False) or getattr(a, "desktop", False)
    if want_mac or want_win:
        icon_src = getattr(a, "icon", None)
        if icon_src and not Path(icon_src).expanduser().is_file():
            info(f"     ⚠ --icon 指向的文件不存在（{icon_src}），改用背景图居中裁")
            icon_src = None
        # 勾了桌面端就**真的重新打包**（dmg 背景 / exe 内图标 / .app 签名
        # 都只能在那一步更新）。`--no-rebuild` 可以关掉，只换文件。
        for note in apply_desktop_image(
                src, mac=want_mac, win=want_win,
                icon=(Path(icon_src).expanduser() if icon_src else None),
                rebuild=not getattr(a, "no_rebuild", False)):
            info(f"     {note}")

    # 推完顺手把服务器上那两张取回本机 —— 否则下次 deploy-web.sh 的 rsync
    # 会拿本机旧副本覆盖回去（今天真踩过，deploy-web.sh 自己不报错）。
    msg = sync_webbg_to_local(a)
    if msg:
        info(f"     {msg}")


def _to_desktop_jpg(src: Path, dst: Path) -> None:
    """把 `src` 转成 JPEG 写到 `dst`（桌面端要的就是 jpg）。"""
    sips = _tool("sips")
    if not sips:
        raise OSError("找不到 sips（macOS 自带，这里不该发生）")
    r = run([sips, "-s", "format", "jpeg", "-s", "formatOptions", "88",
             str(src), "--out", str(dst)], check=False)
    if r.returncode != 0:
        raise OSError(f"sips 退出码 {r.returncode}")


def _tail(text: str, n: int = 110) -> str:
    """取最后一行非空输出，截断 —— 报错时只保留最有用的一句。"""
    for line in reversed((text or "").splitlines()):
        if line.strip():
            return line.strip()[:n]
    return "无输出"


def _repackage(proj: Path, *, mac: bool, win: bool) -> list[str]:
    """重做桌面端**外包装**：真正跑打包脚本（不是只换文件）。

    ★ 为什么必须是「真打包」而不是「就地换文件」：
      - **dmg 安装界面的背景**是 `package.sh` 在生成 dmg 时用 sips 从
        `assets/bg.jpg` 现场裁出来的（660:420 → 1x/2x）。不重做 dmg，
        访客/你自己装的时候看到的还是旧背景，改数据库都改不到它。
      - **Windows 的图标**编在 exe 的 PE 资源段里，不重新链接就永远是旧的。
      - **mac 的 .app 会失签**：`refresh_icon.sh` 只往 Resources 里写
        icon.icns，不动签名；而 arm64 上改过内容的包 `codesign --verify`
        会失败，系统可能直接拒启动。只有 `package.sh` 里那步
        `codesign --force --deep --sign -` 能把它救回来。

    ★ mac 用 `PKG_REUSE_BIN=1`：跳过 `rm -rf build-release` + 全量编译，
      复用已编好的二进制。两个理由：
        1) 推一张背景图不该顺带重编几分钟；
        2) 更重要 —— 绝不能把**工作区里未提交的改动**打进分发包
           （正在写一半的代码被打进包，是比慢更糟的事）。
      win 没有这个待遇：图标必须重新链接，绕不过去（约 7 秒，库已在时）。

    失败只报告，不抛 —— 它是 push 的收尾步骤，那时线上已经生效了。
    """
    notes: list[str] = []
    if mac:
        sh = proj / "scripts" / "game" / "package.sh"
        if not sh.is_file():
            notes.append("⚠ 找不到 scripts/game/package.sh，mac 没有重新打包")
        else:
            try:
                t0 = time.monotonic()
                r = run(["bash", str(sh)], check=False,
                        env={**os.environ, "PKG_REUSE_BIN": "1"})
                dt = time.monotonic() - t0
                out = ((r.stdout or "") + (r.stderr or "")).strip()
                if r.returncode == 0:
                    notes.append(f"mac 已重新打包（{dt:.0f} 秒）"
                                 "—— .app / zip / dmg 背景都是新图，图标已重签")
                else:
                    notes.append(f"⚠ mac 打包失败（{dt:.0f} 秒，第 {r.returncode} 号退出）："
                                 f"{_tail(out)}")
            except Exception as e:                      # noqa: BLE001
                # 这里绝不能抛：它是 push 的收尾，线上那一刻已经生效了。
                notes.append(f"⚠ mac 打包没能完成（{type(e).__name__}: {e}）")
    if win:
        sh = proj / "scripts" / "game" / "build_windows.sh"
        if not sh.is_file():
            notes.append("⚠ 找不到 scripts/game/build_windows.sh，win 没有重新打包")
        else:
            try:
                t0 = time.monotonic()
                r = run(["bash", str(sh)], check=False)
                dt = time.monotonic() - t0
                out = ((r.stdout or "") + (r.stderr or "")).strip()
                if r.returncode == 0:
                    notes.append(f"win 已重新打包（{dt:.0f} 秒）"
                                 "—— exe 里的图标与 win64.zip 都是新图")
                else:
                    notes.append(f"⚠ win 打包失败（{dt:.0f} 秒，第 {r.returncode} 号退出）："
                                 f"{_tail(out)}")
            except Exception as e:                      # noqa: BLE001
                notes.append(f"⚠ win 打包没能完成（{type(e).__name__}: {e}）")
    return notes


def _resign_mac(proj: Path) -> str:
    """只重签 .app（不打包）。给「跳过打包」那条路兜底。

    ★ 为什么必须有：改 Resources（bg.jpg / icon.icns）会让原有签名失效，
      arm64 上内核会校验主线二进制所在 bundle 的完整性 —— 不重签
      可能直接起不来。`package.sh` 里那步 `codesign --verify` 失败即终止，
      说明签名不是可选项。
    """
    app = proj / "dist" / "ComplexMinesweeper.app"
    if not app.is_dir():
        return ""
    r = run(["codesign", "--force", "--deep", "--sign", "-", str(app)], check=False)
    if r.returncode != 0:
        return f"⚠ .app 重签失败，可能无法启动：{_tail((r.stdout or '') + (r.stderr or ''))}"
    v = run(["codesign", "--verify", "--strict", str(app)], check=False)
    if v.returncode != 0:
        return "⚠ .app 重签后验签仍不通过，可能无法启动"
    return ""


def apply_desktop_image(src: Path, *, mac: bool = True,
                        win: bool = True,
                        icon: Path | None = None,
                        rebuild: bool = True) -> list[str]:
    """把 `src` 用作**桌面端**背景（mac 与/或 win）。返回一句句说明。

    ★ 为什么 mac 与 win 要分开：它们**读的是各自产物目录里的 assets/**，
      而不是项目里的那份：
        mac → dist/ComplexMinesweeper.app/Contents/Resources/assets/bg.jpg
        win → dist/ComplexMinesweeper-win64/assets/bg.jpg
      但 `package.sh` / `build_windows.sh` 打包时都是 `cp -R assets`，
      所以**下次打包会覆盖掉这里的改动** —— 所以也要一并更新项目里的
      `assets/bg.jpg`，让下次打包带的是新图。

    ★ 「换文件」只能解决**背景**，另有三样东西换文件换不到
      （见 `_repackage` 的说明）：dmg 安装界面的背景、Windows exe 里的图标、
      mac 的签名。所以 `rebuild=True`（默认）会**真的重跑打包脚本**：

        mac → scripts/game/package.sh（PKG_REUSE_BIN=1，复用二进制，不重编）
              重建 .app（新 bg + 新 icns）+ 重签 + zip + **dmg（新背景）**
        win → scripts/game/build_windows.sh（必须重编才能把 ico 塞进 exe）
              + 重组 win64 + zip

      `rebuild=False` 时退回「就地换文件」，并给 mac 重签一下
      （否则改过 Resources 的 .app 会失签）——但图标与 dmg 背景会是旧的，
      返回值里会明说。

    任何一步失败都只**如实报告**、绝不中断 —— 网页端那时已经推成功了。
    """
    proj = Path(__file__).resolve().parent.parent
    src_bg = proj / "assets" / "bg.jpg"
    mac_bg = proj / "dist" / "ComplexMinesweeper.app" / "Contents" / "Resources" / "assets" / "bg.jpg"
    win_bg = proj / "dist" / "ComplexMinesweeper-win64" / "assets" / "bg.jpg"
    notes: list[str] = []

    # 0) 图标源。★ 用户裁过就用他裁的（`assets/icon.png`），别再从背景图
    #    居中裁一遍 —— 那等于把用户的选择丢掉，还会裁到别的地方。
    icon_bg = proj / "assets" / "icon.png"
    if icon is not None:
        try:
            icon_bg.write_bytes(Path(icon).read_bytes())
            notes.append("assets/icon.png（你裁的那块）")
        except Exception as e:
            notes.append(f"⚠ 图标写入失败（{e}），退回从背景图居中裁")
    elif icon_bg.is_file():
        # 没给新图标但历史上有 —— 保留旧的，不要悄悄换成背景图居中裁
        notes.append("assets/icon.png（沿用的）")

    # 1) 项目里的那份先更新 —— 否则下次打包会把它带回去
    try:
        _to_desktop_jpg(src, src_bg)
        notes.append("assets/bg.jpg")
    except Exception as e:
        return [f"⚠ 桌面端图转换失败（{e}）—— 图标与两端产物都保持原样"]

    # 2) 已打好的产物：目录在就换，不在就跳过（用户可能还没打过包）
    if mac and mac_bg.parent.is_dir():
        try:
            _to_desktop_jpg(src, mac_bg)
            notes.append("mac 端")
        except Exception as e:
            notes.append(f"⚠ mac 端图没换成功（{e}）")
    if win and win_bg.parent.is_dir():
        try:
            _to_desktop_jpg(src, win_bg)
            notes.append("win 端")
        except Exception as e:
            notes.append(f"⚠ win 端图没换成功（{e}）")

        # ★ Windows 图标**编在 exe 里**，所以换图光换文件不够 ——
        #   还要重新生成 .ico 并**重跑 build_windows.sh**（约 7 秒，库已在的话）。
        #   这里只做第一步（生成 .ico）；真正的 exe 更新由用户跑打包脚本。
        mk = proj / "scripts" / "game" / "make_win_icon.sh"
        if mk.is_file():
            ico = proj / "build-win" / "icon.ico"
            r = run(["bash", str(mk), str(ico)], check=False)
            out = ((r.stdout or "") + (r.stderr or "")).strip()
            if r.returncode == 0:
                notes.append("win 图标 .ico")
            else:
                tail = out.splitlines()[-1][:90] if out else "未知原因"
                notes.append(f"⚠ win 图标没生成（不影响网页与 mac）：{tail}")

    # 3) mac 图标（从 package.sh 里抽取那图标段执行，不另抄一份）
    if mac:
        script = proj / "scripts" / "game" / "refresh_icon.sh"
        if script.is_file():
            r = run(["bash", str(script)], check=False, capture=False)
            out = ((r.stdout or "") + (r.stderr or "")).strip()
            if r.returncode != 0:
                tail = out.splitlines()[-1][:100] if out else "未知原因"
                notes.append(f"⚠ 图标重建失败（不影响网页）：{tail}")
            elif any(l.strip().startswith("✓") for l in out.splitlines()):
                notes.append("图标")

    # 4) 重做「外包装」：dmg 背景、exe 内图标、.app 签名都只能在这一步更新
    if mac or win:
        if rebuild:
            notes.extend(_repackage(
                proj,
                mac=mac and (proj / "dist" / "ComplexMinesweeper.app").is_dir(),
                win=win and (proj / "dist" / "ComplexMinesweeper-win64").is_dir()))
        else:
            if mac:
                warn = _resign_mac(proj)
                if warn:
                    notes.append(warn)
            notes.append("⚠ 按你的选择跳过了打包 —— dmg 背景与 win 的 exe 图标还是旧的")
    return notes


def sync_webbg_to_local(a, dst_dir: Path | None = None) -> str:
    """把服务器上当前的 webbg 两张**取回本机** `web/assets/`，返回一句说明。

    ★ 为什么必须有这一步：`scripts/web/deploy-web.sh` 用 rsync 把本机
      `web/assets/` **覆盖**到服务器。于是推完新图后，两边就不一致了 ——
      下次部署会把新图无声改回旧图（而且 deploy-web.sh 自己不报错，
      「怎么又变回去了」）。今天真踩过：线上已压到 84 KB、本机还是 510 KB。

      推完顺手取回来，两边就永远一致，rsync 判定「不用传」。

    ★ 这个函数**绝不允许抛异常**。它跑在 `webbg push` 的**最末尾** ——
      那时图已经传上去、已经置为「开」、用户已经看到成功信息了。
      在这里崩掉会在成功的输出后面接一整段 traceback，
      看着像「失败了」，实际线上已经好了（2026-10-18 真发生过：
      多传了一个 run() 不接受的 stdin= 参数）。
      所有失败都降级成返回值里的一句 ⚠，调用方照常收尾。

    ★ 必须**二进制**读：`run()` 是 `text=True` 的，用它接图片会让
      `stdout` 变成 str，`write_bytes()` 直接 TypeError；
      就算改成先 decode 再 encode，也会按本地编码来回转一遍，
      把二进制内容改坏（在 locale 不是 utf-8 的机器上尤其明显）。
      所以这里绕过 `run()`，直接 `subprocess.run(..., capture_output=True)`
      （不加 text=True），拿到原始 bytes。

    `dst_dir` 可注入，只为测试能在临时目录里跑，不碰仓库里的 web/assets。
    """
    try:
        proj = Path(__file__).resolve().parent.parent
        if dst_dir is None:
            dst_dir = proj / "web" / "assets"
        if not dst_dir.is_dir():
            return ""
        root = a.web_root
        got: list[str] = []
        for rel, name in ((WEBBG_FILES[0], "bg.webp"), (WEBBG_FILES[1], "bg.jpg")):
            # ⚠️ 别用 run()：它 text=True，会把二进制读成 str。
            r = subprocess.run(ssh_cmd(a) + [f"cat {shq(f'{root}/{rel}')}"],
                              capture_output=True, check=False,
                              stdin=subprocess.DEVNULL)
            data = r.stdout or b""
            if r.returncode != 0 or not data:
                hit = "、".join(got) if got else "一张都没"
                return f"⚠ 本机副本没同步上（服务器读不到 {name}；已同步：{hit}）"
            (dst_dir / name).write_bytes(data)
            got.append(name)
        return f"本机 web/assets 已同步（{'、'.join(got)}）—— 下次部署不会改回去"
    except Exception as e:                      # noqa: BLE001 —— 见上面那段说明
        return f"⚠ 本机副本没同步上（{type(e).__name__}: {e}）—— 线上已生效，不影响访客"


# --------------------------------------------------------------------------
# 站点默认页：游戏 / 公开 C++ 学习站(/learn/) 之间切换（Phase 3，cms landing）
# --------------------------------------------------------------------------
#
# 为什么要它：监管要求根路径 `/` 的默认页能在「游戏」（开放站）与「公开 C++ 学习站
# /learn/」之间切换，且**必须可回滚、不能把线上 nginx 搞挂**。
#
# 做法：服务器上放一份 nginx 片段 cms-landing-root.conf，由主配置 include 进
# `server{}`；切换 = 原子替换这份片段 → `nginx -t` 校验 → `systemctl reload nginx`。
# 任一步失败就把 .bak 恢复回去、再校验一次，**绝不让坏配置留在线上**——否则下一次
# 任何人 reload 都会失败，等于把整站拖下水。
#
# ★ 两种模式的路由（2026-10-22 重定）：
#   game （开放站）：`/` 与任何未定义路径 302 → /game；/game 必须登录（否则 404）；
#                   /learn/ 公开。
#   learn（学习站）：`/` 302 → /learn/（公开）；/game 必须登录（否则 404）；
#                   其余路径一律 404。
#   两种模式里 /gate/<TOKEN>/ 都是秘密入口：已登录 302 → /game，未登录才给密码页
#   （见 cms-gate-path.conf）。少了这一条，开放站就变成「看得见、永远进不去」。
#
# ★ 契约（与并行改 scripts/web/deploy-web.sh 的任务共用同一份片段，**必须逐字一致**）：
#   - 第 1 行是模式标记 `# landing-mode: game|learn`，status 靠它判断当前模式；
#   - 两份片段都自带兜底 `location /`（主配置里没有兜底块，省得两处路由打架）；
#   - `location = /game` 的 body 两份完全一致（都走闸门鉴权）。

#: 服务器上的 nginx 片段路径（主配置 include 它）。**与并行任务的契约常量一致**。
LANDING_CONF = "/etc/nginx/snippets/cms-landing-root.conf"

#: 合法模式。首行标记里的取值只能是这两个之一，其余一律当作「标记损坏」。
LANDING_MODES = ("game", "learn")

#: game 模式全文：开放站。`/` 与兜底路径都 302 到 /game，由 /game 自己走闸门。
#: `location = /game` 的 body 必须与 learn 那份逐字一致（唯一的游戏入口）。
LANDING_GAME = """# landing-mode: game
# 开放站：根路径与任何未定义路径都 302 到 /game；游戏是否可见由 /game 的闸门决定
location = / {
    return 302 /game;
}

# 游戏入口：必须登录；未登录由 error_page 映射成 404「当作不存在」
location = /game {
    auth_request /__auth;
    error_page 401 403 502 504 =404 /__nf;
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    try_files /index.html =404;
}

# 带斜杠的写法纠正到 /game。302 不用 301：换路由方案时别让浏览器被永久缓存钉住
location = /game/ {
    return 302 /game;
}

# 兜底：其他任何路径都去游戏（开放站希望访客直接落到游戏，而不是看见 404）
location / {
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    return 302 /game;
}
"""

#: learn 模式全文：默认页 = 公开学习站。根路径 302 到 /learn/，游戏只在 /game。
LANDING_LEARN = """# landing-mode: learn
# 学习站：根路径 302 到公开学习站 /learn/；游戏只在 /game，其余路径一律 404
location = / {
    return 302 /learn/;
}

# 游戏入口：必须登录；未登录由 error_page 映射成 404「当作不存在」
location = /game {
    auth_request /__auth;
    error_page 401 403 502 504 =404 /__nf;
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    try_files /index.html =404;
}

# 带斜杠的写法纠正到 /game。302 不用 301：换路由方案时别让浏览器被永久缓存钉住
location = /game/ {
    return 302 /game;
}

# 兜底：学习站模式下，除 /learn/ 与 /game 之外的任何路径一律 404（不承认受保护内容）
location / {
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    return 404;
}
"""

#: 模式 → 全文。写文件时按这张表取内容，免得在 landing_write 里散落 if/else。
LANDING_TEXT = {"game": LANDING_GAME, "learn": LANDING_LEARN}


def landing_mode(a) -> str | None:
    """读服务器上那份片段的**第 1 行**，解析出当前模式。

    返回 "game" / "learn"；文件不存在返回 None；首行标记损坏（不是
    `# landing-mode: X`，或 X 不在 LANDING_MODES 里）同样返回 None。
    status 会另外查一次「文件存不存在」，据此区分「还没部署」与「标记损坏」。

    只取首行（契约规定标记就在第 1 行）：多读会把 location 体里的内容误当标记，
    也没必要为一次判断把整份配置拉回来。`head` 对不存在的文件返回非零 → None。
    """
    r = run(ssh_cmd(a) + [f"head -n1 {shq(LANDING_CONF)} 2>/dev/null"], check=False)
    if r.returncode != 0:
        return None
    m = re.match(r"^#\s*landing-mode:\s*(\S+)\s*$", (r.stdout or "").strip())
    if not m:
        return None
    mode = m.group(1)
    return mode if mode in LANDING_MODES else None


def landing_write(a, mode: str) -> None:
    """把默认页切换到 `mode`（"game"/"learn"）：全程可回滚，绝不让坏配置留在线上。

    四步（每步都用 `run(..., check=False)` 自己看返回码，**不让异常裸抛**）：
      1) 现有片段先 `cp -a` 成 `.bak`（不存在则跳过备份）；
      2) 目标全文写进 `.new` 再 `mv` 成正式文件——原子替换，中途失败也不留半份；
      3) `nginx -t`；不过就把 `.bak` 恢复回去、再 `nginx -t`，明确报「已回滚」；
      4) 校验通过才 `systemctl reload nginx`；reload 失败同样恢复 `.bak` + 再校验。

    为什么 reload 失败后**不再 reload**：reload 失败意味着 nginx 仍在内存里跑
    **旧**配置（新配置根本没被加载），此时把 `.bak` 恢复回磁盘，磁盘与内存就又
    一致了，无需再动它——再 reload 反而可能二次失败、把状态搅浑。
    """
    if mode not in LANDING_MODES:
        die(f"未知的默认页模式：{mode}（只支持 {'/'.join(LANDING_MODES)}）")
    conf, bak, new = LANDING_CONF, LANDING_CONF + ".bak", LANDING_CONF + ".new"
    text = LANDING_TEXT[mode]
    # 回滚片段：有备份就恢复；没备份（原本就不存在这份文件）就把刚写的坏文件删掉，
    # 总之绝不让一份 `nginx -t` 报错的配置留在线上。
    rollback = (f"if [ -f {shq(bak)} ]; then cp -a {shq(bak)} {shq(conf)}; "
                f"else rm -f {shq(conf)}; fi")

    # ── 1) 备份 + 2) 原子写入（一次 SSH 做完，少一次往返）──
    # 用**单引号 heredoc**（<<'CMS_LANDING_EOF'）关闭一切 shell 展开：内容里有
    # { } " 和中文，虽然不含 $ 或反引号，但引号定界符最稳妥，写上去的就是原文正体。
    write_script = (
        f"if [ -f {shq(conf)} ]; then cp -a {shq(conf)} {shq(bak)} || exit 1; fi\n"
        f"cat > {shq(new)} <<'CMS_LANDING_EOF'\n"
        f"{text}"
        f"CMS_LANDING_EOF\n"
        f"mv {shq(new)} {shq(conf)}"
    )
    r = run(ssh_cmd(a) + [write_script], check=False)
    if r.returncode != 0:
        die(f"写入新片段失败（线上未改动）：{(r.stderr or r.stdout or '').strip()[:300]}")

    # ── 3) nginx -t 校验；不过就回滚并再校验 ──
    r = run(ssh_cmd(a) + ["nginx -t"], check=False)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()[:300]
        rb = run(ssh_cmd(a) + [f"{rollback} && nginx -t"], check=False)
        verdict = ("已回滚到切换前，并重新校验通过（线上仍是原默认页）"
                   if rb.returncode == 0 else
                   "⚠ 已尝试回滚，但回滚后 nginx -t 仍失败——请立刻人工检查线上配置")
        die(f"nginx -t 未通过，切换中止。{verdict}。\n  原始报错：{err}")

    # ── 4) reload；失败同样回滚 + 再校验（见函数头：此时无需再 reload）──
    r = run(ssh_cmd(a) + ["systemctl reload nginx"], check=False)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()[:300]
        rb = run(ssh_cmd(a) + [f"{rollback} && nginx -t"], check=False)
        verdict = ("已回滚到切换前（nginx 仍跑原配置，磁盘已恢复一致）"
                   if rb.returncode == 0 else
                   "⚠ 已尝试回滚，但回滚后 nginx -t 仍失败——请立刻人工检查线上配置")
        die(f"reload nginx 失败，切换中止。{verdict}。\n  原始报错：{err}")


def cmd_landing(a) -> None:
    _refuse_argv_password(a)
    _refuse_argv_admin(a)
    action = a.action

    # ── status：只读，不问口令（照 webbg status）──
    if action == "status":
        mode = landing_mode(a)
        # 单独查一次「文件在不在」，好把「还没部署」与「标记损坏」区分开
        r = run(ssh_cmd(a) + [f"test -f {shq(LANDING_CONF)} && echo yes || echo no"],
                check=False)
        exists = (r.stdout or "").strip() == "yes"
        if a.json:
            print(json.dumps({"mode": mode, "exists": exists, "conf": LANDING_CONF},
                             ensure_ascii=False))
            return
        info(f"配置文件: {LANDING_CONF}（{'存在' if exists else '不存在'}）")
        if not exists:
            info("当前模式: （无）—— 片段还没部署，根路径行为由主配置里的 "
                 "`location = /` 决定（现状 = 游戏）。")
            info(f"  切到学习站： {prog()} landing learn      切回游戏： {prog()} landing game")
            return
        if mode is None:
            info("当前模式: ⚠ 首行标记损坏（读不出 `# landing-mode: game|learn`）。")
            info("  线上根路径行为未知；重写一次即可修好标记：")
            info(f"    {prog()} landing game      或      {prog()} landing learn")
            return
        info(f"当前模式: {mode}")
        if mode == "learn":
            info("  学习站：`/` 302 到公开的 /learn/；游戏在 /game（未登录 404）；其余路径 404。")
        else:
            info("  开放站：`/` 与任何未定义路径 302 到 /game；未登录的 /game 返回 404。")
        info("  两种模式的登录入口都是秘密路径 /gate/<TOKEN>/（已登录会直接跳去 /game）。")
        other = "game" if mode == "learn" else "learn"
        info(f"  切换到另一种： {prog()} landing {other}")
        return

    # ── learn / game：写操作，就地校验管理口令（与 webbg on/off 同一道门）──
    what = {"learn": "把根路径默认页切到学习站 /learn/",
            "game": "把根路径默认页切回游戏"}[action]
    require_admin(a, action=what)

    cur = landing_mode(a)
    if cur == action:
        # 目标 == 现状：不写文件、不 reload（无谓的 reload 也是一次线上风险）。
        info(f"默认页已经是「{action}」模式，未做改动。")
        return

    landing_write(a, action)
    gate_audit(a.state, f"landing {action}")
    info("")
    info(f"  ✓ 默认页已切换：{cur or '（原无标记）'} → {action}")
    info(f"     配置文件 : {LANDING_CONF}")
    info(f"     备份     : {LANDING_CONF}.bak（切换前内容，可手工回退）")
    info("     nginx -t : 通过      systemctl reload nginx : 已生效")
    if action == "learn":
        info("     现在根路径 `/` 302 到 /learn/；游戏在 /game（未登录 404），其余路径 404。")
    else:
        info("     现在根路径与未定义路径都 302 到 /game；未登录的 /game 返回 404。")


# --------------------------------------------------------------------------
# 秘密登录入口（gate-path）
# --------------------------------------------------------------------------
# 404 模型下，公开的 /gate/ 本身也是一扇「承认存在」的门：一个谁都摸得到的
# 密码页，等于告诉扫描器「这后面有受保护的东西」。所以登录页挪到一条随机
# 不可猜的路径 `/gate/<TOKEN>/`，而 /gate/ 与其余游戏路径对无会话者一律 404。
#
# 别把它做成「要登录才能看登录页」——那是死循环。密码页本身必须公开，
# 靠的是不可猜（熵来自 token 本身）。入口那条精确 location 只多做一件事：
# 已登录的访客直接送去 /game，未登录的仍然看到公开的密码页（error_page 兜底）。
#
# 与 landing 同一套契约：真相在服务器那份 nginx 片段里（**不进 git**），
# 首行 `# gate-token: <TOKEN>` 是唯一标记；工具只读它、只原子地换它，
# 换完必须 `nginx -t` 通过才 reload，任何一步失败都回滚。

#: 服务器上的 nginx 片段路径（主配置 include 它）。
GATE_PATH_CONF = "/etc/nginx/snippets/cms-gate-path.conf"

#: 密码页在服务器磁盘上的目录——片段里的 alias 指向它。
GATE_ROOT = "/srv/complexminesweeper/gate"

#: token 允许的**形状**。它会被直接拼进 nginx 的 `location` 行，
#: 放宽一个字符就等于开放配置注入（`}` 能提前闭合 location、换行能注入
#: 任意指令），所以这里宁可严到难读：只许小写字母和数字。
#: 下限 12 位是**形状**要求（挡配置注入），不是熵要求 —— 这两件事分开算：
#:
#: ★ 2026-10-21 修正：这段原来把 token 当成 base36 算（6 位写 36^6≈21.8 亿、
#:   12 位写 36^12≈4.7×10^18），**两行都在同一个字母表假设下、内部就已经不自洽**。
#:   实际生成走的是十六进制，基数是 **16 不是 36**，所以安全余量被高估了约 1.7 万倍：
#:     6  位 = 16^6  ≈ 1.7×10^7   （按 1000 IP × 20 r/s 分布式撞，几十分钟）
#:     12 位 = 16^12 ≈ 2.8×10^14  （同一打法要上千年量级，不是"上千万年"）
#:     24 位 = 16^24 ≈ 7.9×10^28  = 2^96（96 bit）
#:   12 位在「未登录一律 404 + 按 IP 限流」下够用，但**别再照着 4.7×10^18 做决策**。
#: ★ 2026-10-21 定下的长度口径（用户裁决 ★3）：
#:   - **随机**生成（`rotate`、deploy 首次渲染）固定 12 字节 = 24 个十六进制字符；
#:   - **手动** `set` 仍然允许 12~32 位，并且**不加熵警告**：下限 12 是给"我就是要一个
#:     短入口"留的口子，短的那一截风险自担，工具不替人判断。
#:   所以这道正则只管形状；想靠放宽它来提高熵是走错的门 —— 形状放宽一个字符
#:   就等于开放注入（见上面两段）。
#: 换长度只影响**下次**生成/轮换；当前正在用的入口不动 —— 改成 32 位会让所有已发出去
#: 的登录网址立刻失效，那一步必须人主动做。
GATE_TOKEN_RE = re.compile(r"^[a-z0-9]{12,32}$")


def gate_path_text(token: str) -> str:
    """渲染秘密入口片段全文（首行标记是契约，`gate_token()` 按它读）。

    `^~` 不是可选修饰：登录页自带的 `gate.css` / `gate.js` 必须命中**这块**
    公开 location，否则会被主配置里带 auth_request 的正则
    `~* \\.(js|css|...)$` 抢走 → 匿名登不了录（登录页裸奔）。跟 /learn/ 同理。

    入口本身（精确匹配 `/gate/<TOKEN>/`）是**有状态的**：先 auth_request，
    已登录就 proxy 到 authd 的 /entry（回 302 /game），未登录由 error_page
    送去密码页。不要改成 `if + return`：rewrite 阶段早于 auth_request。

    ★ 这段文本和 `scripts/web/deploy-web.sh` 里 `<<GATE_PATH_BODY` 那份是**同一份片段的
      两个渲染器**，谁后写谁覆盖（deploy 每次重渲染、`gate-path set/rotate` 整段重写）。
      所以除 `$TOK`/`$ROOT` → 实参之外两边必须逐行一致，改动要同时改两处；
      有测试按「非注释行集合相等」盯着这件事。注释不一致只表现为文件读起来漂了，
      **指令少一行就是线上行为变了** —— 那条才是真正的代价。
    """
    return (
        f"# gate-token: {token}\n"
        f"# 秘密登录入口：/gate/ 与游戏页对无会话者一律 404，密码页只在下面这条随机路径可达。\n"
        f"# 查看/换入口：cms gate-path status|set|rotate（或 cmsui 顶栏芯片）。\n"
        # 用 302 不用 301：301 会被浏览器永久缓存，轮换 token 后，
        # 存过旧地址的人会被缓存里那条 301 直接带进一个 404，怎么刷新都回不来。
        f"# 302 不是 301：永久跳转会被浏览器缓存，换 token 后存过旧地址的人会被缓存钉在 404 上。\n"
        f"location = /gate/{token} {{ access_log off; return 302 /gate/{token}/; }}\n"
        f"\n"
        f"# 入口守卫：已登录直接送去 /game，未登录才显示密码页。\n"
        f"# 为什么用 proxy_pass 而不是 if + return：nginx 的 rewrite 阶段早于 auth_request，\n"
        f"# if 里拿不到「登没登录」；能走到内容阶段（proxy_pass）就说明 auth_request 已放行。\n"
        f"# authd 的 /entry 只回一条 302 /game，权限判断仍在 auth_request 那一步。\n"
        f"location = /gate/{token}/ {{\n"
        f"    access_log off;\n"
        f"    error_log /dev/null crit;\n"
        f"    auth_request /__auth;\n"
        f"    error_page 401 403 500 502 504 = /gate/{token}/index.html;\n"
        f"    proxy_pass http://127.0.0.1:8090/entry;\n"
        f"    proxy_hide_header Server;\n"
        f"}}\n"
        f"\n"
        f"# 密码页与它自带的 gate.css / gate.js：公开（凭 token 不可猜）。\n"
        f"# 这里**不能**挂 auth_request —— 要登录才能看登录页就是死循环。\n"
        f"location ^~ /gate/{token}/ {{\n"
        f"    alias {GATE_ROOT}/;\n"
        f"    index index.html;\n"
        # ★ M1（2026-10-21 审计）：token 明文就在这条 URL 里。access_log 会把它原样
        #   写进 /var/log/nginx/access.log（rotate 多份、还会被采集/备份带走）→ 入口等于公开。
        #   明文 80 上那条 `/gate/` 404 块（deploy-web.sh）同样要关 —— ★2 就是漏了它。
        f"    # token 明文就在这条 URL 里，access_log 会把它原样写进 /var/log/nginx/access.log\n"
        f"    #   （rotate 14 份、640 www-data:adm，还常被采集/备份带走）→ 入口等于公开。\n"
        f"    #   项目自己的口径就是「token 不进日志」，这里之前是漏的（2026-10-21 审计 M1）。\n"
        f"    #   代价：这条路径上的访问不再留痕 —— 对一个\"谁访问都算暴露\"的神秘路径，这是对的取舍。\n"
        f"    access_log off;\n"
        f"    # error_log 是另一条管道：limit_req 的 429 与 alias 的 open() 失败都以 error 级\n"
        f"    #   写入完整 URI（error.log 640、rotate 14）。crit 把这两类丢掉 = 这条路径零留痕。\n"
        f"    error_log /dev/null crit;\n"
        f'    add_header Cache-Control "no-store" always;\n'
        f"    include /etc/nginx/snippets/cms-security-headers.conf;\n"
        f"}}\n"
    )


def gate_token(a) -> str | None:
    """读服务器上那份片段的首行，解析出当前 token。

    文件不存在 / 首行标记损坏 / token 不合法 → 一律 None（宁可不认，
    也不要把一个可能被注入过的字符串当入口报给用户）。
    """
    r = run(ssh_cmd(a) + [f"head -n1 {shq(GATE_PATH_CONF)} 2>/dev/null"], check=False)
    if r.returncode != 0:
        return None
    m = re.match(r"^#\s*gate-token:\s*(\S+)\s*$", (r.stdout or "").strip())
    if not m:
        return None
    tok = m.group(1)
    return tok if GATE_TOKEN_RE.fullmatch(tok) else None


def gate_path_write(a, token: str) -> None:
    """把登录入口换成 `token`：全程可回滚，绝不让坏配置留在线上。

    四步与 `landing_write()` 逐字同构（备份 → 原子写 → nginx -t → reload，
    失败回滚）。改的是另一份片段，但「先校验再 reload、reload 失败不再 reload」
    的理由完全一样，见 landing_write 的函数头。
    """
    if not GATE_TOKEN_RE.fullmatch(token or ""):
        die(f"token 不合法：{token!r}（只允许 12~32 位小写字母或数字）")
    conf, bak, new = GATE_PATH_CONF, GATE_PATH_CONF + ".bak", GATE_PATH_CONF + ".new"
    text = gate_path_text(token)
    rollback = (f"if [ -f {shq(bak)} ]; then cp -a {shq(bak)} {shq(conf)}; "
                f"else rm -f {shq(conf)}; fi")

    # 单引号 heredoc 关闭一切 shell 展开（内容里有 { } 和中文）。
    # token 在上面已按 ^[a-z0-9]{12,32}$ 校验，这里拼进 location 行是安全的。
    write_script = (
        f"if [ -f {shq(conf)} ]; then cp -a {shq(conf)} {shq(bak)} || exit 1; fi\n"
        f"cat > {shq(new)} <<'CMS_GATEPATH_EOF'\n"
        f"{text}"
        f"CMS_GATEPATH_EOF\n"
        f"mv {shq(new)} {shq(conf)}\n"
        # ★ M3（2026-10-21 审计）：原来没有这句，`mv` 出来的文件吃默认 umask（644），
        #   于是 token 明文在服务器上全局可读 —— 任意本地账户都能读到唯一登录入口。
        #   nginx master 以 root 读配置，600 完全够。deploy-web.sh 那边也同步改成 600。
        f"chmod 600 {shq(conf)}"
    )
    r = run(ssh_cmd(a) + [write_script], check=False)
    if r.returncode != 0:
        die(f"写入新片段失败（线上未改动）：{(r.stderr or r.stdout or '').strip()[:300]}")

    r = run(ssh_cmd(a) + ["nginx -t"], check=False)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()[:300]
        rb = run(ssh_cmd(a) + [f"{rollback} && nginx -t"], check=False)
        verdict = ("已回滚到换入口前，并重新校验通过（线上仍是原入口）"
                   if rb.returncode == 0 else
                   "⚠ 已尝试回滚，但回滚后 nginx -t 仍失败——请立刻人工检查线上配置")
        die(f"nginx -t 未通过，切换中止。{verdict}。\n  原始报错：{err}")

    r = run(ssh_cmd(a) + ["systemctl reload nginx"], check=False)
    if r.returncode != 0:
        err = (r.stderr or r.stdout or "").strip()[:300]
        rb = run(ssh_cmd(a) + [f"{rollback} && nginx -t"], check=False)
        verdict = ("已回滚到换入口前（nginx 仍跑原配置，磁盘已恢复一致）"
                   if rb.returncode == 0 else
                   "⚠ 已尝试回滚，但回滚后 nginx -t 仍失败——请立刻人工检查线上配置")
        die(f"reload nginx 失败，切换中止。{verdict}。\n  原始报错：{err}")


def cmd_gate_path(a) -> None:
    _refuse_argv_password(a)
    _refuse_argv_admin(a)
    action = a.action

    # ── status：只读，不问口令（照 landing / webbg）──
    if action == "status":
        tok = gate_token(a)
        r = run(ssh_cmd(a) + [f"test -f {shq(GATE_PATH_CONF)} && echo yes || echo no"],
                check=False)
        exists = (r.stdout or "").strip() == "yes"
        # 只回路径，不回完整 URL：整站的对外地址（IP/域名/端口）不归这个工具决定，
        # 界面拿自己知道的前缀去拼，免得这里长出一个第二份「站点地址」真相。
        if a.json:
            print(json.dumps({"token": tok, "exists": exists,
                              "path": f"/gate/{tok}/" if tok else None,
                              "conf": GATE_PATH_CONF}, ensure_ascii=False))
            return
        info(f"配置文件: {GATE_PATH_CONF}（{'存在' if exists else '不存在'}）")
        if not exists:
            info("当前入口: （无）—— 片段还没部署，登录页仍挂在旧的 /gate/ 上。")
            info(f"  设一个入口： {prog()} gate-path set <token>")
            return
        if tok is None:
            info("当前入口: ⚠ 首行标记损坏或 token 不合法（读不出 `# gate-token: [a-z0-9]{12,32}`）。")
            info("  线上登录页位置未知；重写一次即可修好：")
            info(f"    {prog()} gate-path rotate")
            return
        info(f"当前入口: /gate/{tok}/")
        info("  除这条路径外，/gate/ 与所有游戏页面对无会话者一律 404。")
        info(f"  换一个（旧链接立刻失效）： {prog()} gate-path rotate")

    # ── set / rotate：写操作，就地校验管理口令 ──
    else:
        if action == "set":
            if a.token_stdin and (a.token or "").strip():
                die("set 的 token 只能给一处：位置参数或 --token-stdin，别两个都给")
            # 界面用 --token-stdin（argv 会被同机任意进程用 `ps aux` 扫到，而 token 就是
            # 唯一登录凭据）；人手敲命令仍可以直接给位置参数 —— 那种场景要看得见才好确认。
            # ★ 读取顺序即契约：这里先消费 token 那一行，`require_admin` 再消费口令那一行。
            token = _stdin_line().strip() if a.token_stdin else (a.token or "").strip()
            if not token:
                die("set 需要给一个 token：cms gate-path set <token>（12~32 位小写字母或数字）"
                    "，或者用 --token-stdin 从 stdin 喂一行")
            # ★ M2 的后半（2026-10-21 复审 ★1）：`require_admin` 会把这句 action **原文**写进
            #   审计（`admin-ok:{action}`），而 gate_ui.py 的 /api/audit 又把它回给浏览器 ——
            #   上一版只遮了后面那条 `gate-path set`，这条漏了，所以全文 token 还在往审计里写。
            #   提示符/报错里也一起遮掉：那些文本会被截图、贴进工单。
            what = f"把登录入口改为 /gate/{token[:4]}…（其余位已隐去）"
        else:
            if a.token_stdin:
                die("--token-stdin 只配 `gate-path set`；换一个随机的用 `gate-path rotate`")
            # ★ 2026-10-21：6 → 12 字节（48 → 96 bit，24 个十六进制字符）。
            #   用户定的长度。只影响**下次** rotate/首次生成，不会动当前正在用的入口
            #   （旧网址照旧有效，直到有人主动换）。
            #   96 bit 对"猜网址"这个威胁模型已经绰绰有余：即使 1000 个 IP 各 20 r/s
            #   分布式硬撞，期望也要 10^22 年量级。
            token = secrets.token_hex(12)  # 24 个十六进制字符，正好落在 GATE_TOKEN_RE 内
            what = "轮换登录入口（随机新 token）"
        if not GATE_TOKEN_RE.fullmatch(token):
            die(f"token 不合法：{token!r}（只允许 12~32 位小写字母或数字）")
        require_admin(a, action=what)

        cur = gate_token(a)
        if cur == token:
            info("入口已经是这个 token，未做改动。")
            return
        gate_path_write(a, token)
        # ★ M2（2026-10-21 审计）：原来这里记的是**完整 token**。审计文件 0600，但
        #   gate_ui.py 的 /api/audit 会把它读出来回给浏览器，而 token 就是「谁能打开
        #   密码页」的唯一凭据 —— 记全文等于把它复制到一个会被前端读到的地方。
        #   只留前 4 位：足够和 `cms gate-path status` 对上，又不能被拿去拼 URL。
        #   口径也统一了：rotate 本来就不记 token，现在 set 同样不记全文。
        gate_audit(a.state, f"gate-path {action}" + (f" {token[:4]}…（token 已遮罩）" if action == "set" else ""))
        info("")
        info(f"  ✓ 登录入口已更新：{(cur or '（原无）')[:8]}… → {token}")
        info(f"     新入口   : https://<域名>/gate/{token}/")
        info(f"     配置文件 : {GATE_PATH_CONF}")
        info(f"     备份     : {GATE_PATH_CONF}.bak（换入口前内容，可手工回退）")
        info("     nginx -t : 通过      systemctl reload nginx : 已生效")
        if cur:
            info(f"     ⚠ 旧入口 /gate/{cur}/ 已**立刻失效**，收藏过旧链接的人要重新给地址。")
        info("     已登录访客不受影响（会话 cookie 是 Path=/，与入口路径无关）。")


# --------------------------------------------------------------------------
# 使用记录缓存（服务器端产生的 usage.jsonl 拉回来后的本地副本）
# --------------------------------------------------------------------------
def usage_cache_path(state: Path) -> Path:
    return state / "usage.cache.jsonl"


def read_usage(state: Path) -> list[dict]:
    p = usage_cache_path(state)
    if not p.exists():
        return []
    out = []
    for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(rec, dict):
            out.append(rec)
    return out


def usage_summary(state: Path) -> dict[str, dict]:
    """按 pwid 聚合：最近一次成功登录时间 + 成功/失败次数。"""
    agg: dict[str, dict] = {}
    for rec in read_usage(state):
        if rec.get("event") != "login":
            continue
        pid = rec.get("pwid")
        if not isinstance(pid, str):
            continue
        slot = agg.setdefault(pid, {"last": "", "ok": 0, "fail": 0})
        if rec.get("ok"):
            slot["ok"] += 1
            ts = rec.get("ts", "")
            if ts > slot["last"]:
                slot["last"] = ts
        else:
            slot["fail"] += 1
    return agg


# --------------------------------------------------------------------------
# 远程操作
# --------------------------------------------------------------------------
def ssh_cmd(a) -> list[str]:
    return ["ssh", "-p", a.ssh_port, "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", a.server]


def run(cmd: list[str], *, capture: bool = True, check: bool = True,
        env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    # 远端目标没配置时在这里吭声（本地子命令不受影响）：缺 ~/.cmsdist/deploy.env
    # 直接把 ssh/scp 发出去只会得到 ssh 的 usage 报错，用户不知道去哪补。
    if cmd and cmd[0] in ("ssh", "scp") and (not DEFAULT_SERVER or not DEFAULT_SSH_PORT):
        die("缺 SSH 目标：建 ~/.cmsdist/deploy.env，写两行："
            "CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>，或用 --server/--ssh-port 指定")
    # ⚠️ stdin 一律接 /dev/null，**不要**让子进程继承我们的 stdin。
    #   踩过的坑：`printf '口令\n' | cms push --admin-stdin` 会报
    #   「stdin 已结束，但还需要一行输入」—— 因为前面读 gateconfig.json 的那次
    #   ssh 继承了同一个管道，把口令那一行读走了。
    #   表现极具误导性：用户明明喂了口令，却被告知没喂。
    #   ssh_cmd 已经带 BatchMode=yes，本来就不该有任何交互，所以关掉是安全的。
    # ★ errors="replace"：子进程的输出不一定是 UTF-8（打包脚本里有
    #   hdiutil / AppleScript / 本地化文件名，实测真的出现过 0xef 这种
    #   非法续字节）。默认 strict 解码会抛 UnicodeDecodeError ——
    #   表现为「命令本身成功了，Python 却崩了」，极难联想到编码。
    #   我们只用它做提示文案，替换成 ¿ 完全无所谓。
    return subprocess.run(cmd, capture_output=capture, text=True, errors="replace",
                          check=check, stdin=subprocess.DEVNULL, env=env)


def remote_sha(a, remote_file: str) -> str:
    r = run(ssh_cmd(a) + [f"sha256sum {remote_file} 2>/dev/null | cut -c1-16"], check=False)
    return (r.stdout or "").strip()


def local_sha(path: Path) -> str:
    """全量 sha256。**不要截断** —— 截断过的和全量比永远不相等。

    曾因此把「漂移」判成**永远为真**：`webbg push` 存的是 16 位，
    而 `webbg_probe` 从远端 `sha256sum` 拿到的是 64 位全量，
    于是每次刚推完图，界面立刻红字报「记录与线上实际不一致」。
    提醒看得见却不代表它对 —— 一个恒真的告警比没有告警更糟。
    """
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------
def prog() -> str:
    return "python3 tools/gate_manager.py"


def die(msg: str, code: int = 1):
    # 先把 stdout 冲干净再往 stderr 写。管道/重定向时 stdout 是**块缓冲**的，
    # 不冲就会让「为什么被拒」的说明排到错误消息后面（看起来像两条不相干的输出）。
    try:
        sys.stdout.flush()
    except (OSError, ValueError):
        pass
    print(f"错误：{msg}", file=sys.stderr)
    sys.exit(code)


def info(msg: str) -> None:
    print(msg)


def disp_width(s: str) -> int:
    """终端显示宽度：CJK 宽/全角字符占 2 列，其余 1 列。

    **不能用 len()**：`标签` 的 len 是 2 但显示 4 列。按 len 补齐会让表头与
    数据行错位（`创建` 那列的竖线对不上），表格直接没法看。
    """
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)


def pad(s: str, width: int) -> str:
    """按**显示宽度**左对齐补齐。超宽不截断，只是不再补空格。"""
    return s + " " * max(0, width - disp_width(s))


def trunc(s: str, width: int) -> str:
    """按显示宽度截断并加省略号（宽字符不会被切一半）。"""
    if disp_width(s) <= width:
        return s
    out, w = "", 0
    for ch in s:
        cw = 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
        if w + cw > width - 1:
            break
        out += ch
        w += cw
    return out + "…"


def sep_line(cols: tuple[int, ...], gap: int = 1) -> str:
    """与表头同宽的横线，宽度按显示列数算（pad 的列宽都是显示宽度）。"""
    return "-" * (sum(cols) + gap * (len(cols) - 1))


def iso_to_local(ts: str) -> str:
    """把存储里的 UTC ISO 串转成**本地时间**给人看。

    落盘一律 UTC（跨机器、跨时区无歧义），但 `list` / `usage` 是给人看的：
    直接印 UTC 会让 GMT+8 的人看到「8 小时前」的时间，误以为记录是昨天的。
    解析不了就原样返回（宁可显示原始串，也不要吞掉或崩掉）。
    """
    s = str(ts or "")
    try:
        dt = datetime.strptime(s[:19], "%Y-%m-%dT%H:%M:%S")
        if s.endswith("Z") or s.endswith("+00:00"):
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone().strftime("%Y-%m-%d %H:%M:%S")
    except ValueError:
        return s[:19].replace("T", " ")


def zone_name(utc: bool) -> str:
    if utc:
        return "UTC"
    z = datetime.now().astimezone().strftime("%z")
    return f"本地时间 UTC{z[:3]}:{z[3:]}" if len(z) == 5 else "本地时间"


def zone_footer(utc: bool) -> str:
    """时间列的脚注：存储一律 UTC，默认按本地时区显示。"""
    if utc:
        return "时间为 UTC（存储原值）——去掉 --utc 按本地时区显示。"
    return f"时间为{zone_name(False)}（存储与传输一律 UTC）——加 --utc 看存储原值。"


# `list` / `usage` 的列宽（显示宽度，非 len）。
# 创建/有效期/最近使用三列必须 ≥ 19（`YYYY-MM-DD HH:MM:SS` 的长度），否则时间戳会顶破列。
ENTRY_COLS = (14, 14, 6, 20, 20, 9)           # id 标签 状态 有效期 最近使用 成功/失败
USAGE_COLS = (20, 6, 12, 9, 16, 15, 22)        # 时间 结果 id 标签 IP 浏览器 系统/设备
# 时间列窄于 19 会把 `YYYY-MM-DD HH:MM:SS` 顶破列；改列宽时让导入直接失败，而不是静默破版。
assert ENTRY_COLS[3] >= 19 and ENTRY_COLS[4] >= 19 and USAGE_COLS[0] >= 19, "时间列宽必须 ≥ 19"


def fmt_entry_line(e: dict, agg: dict[str, dict], *, utc: bool = False) -> str:
    stat = agg.get(e.get("id", ""), {})
    stamp = (lambda v: str(v or "-")[:19] if utc else iso_to_local(v) or "-")
    last = stamp(stat.get("last")) if stat.get("last") else "-"
    used = f"{stat.get('ok', 0)}/{stat.get('fail', 0)}" if stat else "-/-"
    cols = (e.get("id", ""), e.get("label") or "-", entry_state(e),
            entry_expiry_text(e, utc=utc), last, used)
    return " ".join(pad(c, w) for c, w in zip(cols, ENTRY_COLS)) + f" {e.get('note') or ''}"


def _result_text(rec: dict) -> str:
    if rec.get("ok"):
        # 闸门开放时的免密放行也算"进来了"，但要和输对密码的登录分得开
        return "免密放行" if rec.get("reason") == "gate_open" else "成功"
    # 失败要把原因分开显示——「密码错」和「已禁用」是完全不同的事
    return {"bad_password": "密码错", "throttled": "被限流",
            "disabled": "已禁用", "expired": "已过期"}.get(rec.get("reason") or "", "失败")


def _usage_cells(rec: dict, *, utc: bool) -> tuple[str, ...]:
    # ⚠️ 顺序有讲究：**先交给 iso_to_local 换算，再截断到秒**。
    # 反过来写（先 [:19] 再换算）会把结尾的 "Z" 切掉，于是 iso_to_local
    # 认不出这是 UTC，走了「无时区」分支原样返回 —— 东八区就整整少 8 小时，
    # 而且显示得像一份正常的本地时间，**很难看出是 bug**（2026-10-16 修过一次）。
    raw = str(rec.get("ts", ""))
    ts = raw[:19].replace("T", " ") if utc else iso_to_local(raw)
    ip = rec.get("ip") or ("hash:" + str(rec.get("ip_hash") or "")[:8])
    os_dev = f"{rec.get('os') or '-'} / {rec.get('device') or '-'}"
    return (ts,
            _result_text(rec),
            str(rec.get("pwid") or "-"),
            str(rec.get("label") or "-"),
            ip,
            str(rec.get("browser") or rec.get("ua_family") or "-"),
            os_dev)


def _print_usage_rows(recs: list[dict], *, utc: bool, show_ua: bool = False) -> None:
    info(" ".join(pad(h, w) for h, w in zip(("时间", "结果", "id", "标签", "IP",
                                             "浏览器", "系统 / 设备"), USAGE_COLS)))
    info(sep_line(USAGE_COLS))
    for r in recs:
        cells = _usage_cells(r, utc=utc)
        info(" ".join(pad(trunc(c, w), w) for c, w in zip(cells, USAGE_COLS)))
        if show_ua:
            info(f"      UA: {str(r.get('ua') or '-')[:MAX_UA_SHOW]}")


# --------------------------------------------------------------------------
# 子命令
# --------------------------------------------------------------------------
def cmd_init(a) -> None:
    state: Path = a.state
    p = store_path(state)
    if p.exists():
        info(f"已存在，未改动：{p}")
        return
    save_store(state, empty_store())
    info(f"已初始化：{p}")
    info(f"目录权限已设为 0700：{state}")


def _check_min_pw(pw: str, *, what: str = "自定义密码") -> str:
    """长度校验 + **可执行**的补救建议（只说"太短"，用户还是不知道该怎么办）。"""
    if len(pw) < MIN_CUSTOM_PW:
        die(f"{what}至少 {MIN_CUSTOM_PW} 个字符，你给的只有 {len(pw)} 个（中文按 1 个字算）。\n"
            f"  想自己定： --password-prompt（不回显地输两遍，推荐）或 --password-stdin < 文件\n"
            f"  不想自己定：去掉这些参数，工具会生成一个随机的强密码")
    return pw


def _refuse_argv_password(a) -> None:
    """把「密码写在命令行里」这种写法接住，给一句人话，而不是 argparse 的 unrecognized。

    argv 对同机任何进程都可见（`ps aux`），还会进 shell 历史——所以工具从不从 argv 读密码。
    """
    if getattr(a, "password_argv", None):
        die("密码不要写在命令行里：`ps aux` 能看到、shell 历史也会留下。\n"
            "  改用 --password-prompt（不回显地输两遍）或 --password-stdin（从文件/管道喂）。")


def _add_pw_args(p) -> None:
    """给「要自己定密码」的命令挂上两种交互方式（默认仍是随机生成一个强密码）。"""
    g = p.add_mutually_exclusive_group()
    g.add_argument("--password-prompt", dest="password_prompt", action="store_true",
                   help="交互式输入密码（不回显，需输两遍确认）")
    g.add_argument("--password-stdin", action="store_true",
                   help=f"从 stdin 读一行作为密码（≥{MIN_CUSTOM_PW} 字符），给管道/文件用")
    _add_argv_pw_guard(p)


def _add_admin_args(p) -> None:
    """给需要管理口令的写操作挂上「怎么把口令喂进来」。

    默认是交互式隐藏输入（回车后敲，不回显）；`--admin-stdin` 给脚本/管道用。
    刻意**没有** `--no-admin-check`：那等于把这道门重新变成装饰。
    """
    p.add_argument("--admin-stdin", action="store_true",
                   help="管理口令从 stdin 读一行（给脚本/管道用；不写进 argv）")
    p.add_argument("--admin", dest="admin_argv", metavar="口令", help=argparse.SUPPRESS)


def _add_expiry_args(p, prefix: str) -> None:
    """挂上有效期相关的四个参数（`add` 与 `expire` 共用，免得两处各写一遍走偏）。

    **`--hours` / `--days` 都支持小数**（`--days 0.5` = 12 小时），所以故意不给 `type=int`——
    那样 argparse 只会报一句英文的 `invalid int value`，看不出是自己单位写错还是格式不对。
    真正的解析与范围校验在 `expiry_from_args` 里做。
    """
    p.add_argument("--hours", metavar="H", help=f"{prefix}H 小时后过期（支持小数，如 0.5 = 30 分钟）")
    p.add_argument("--days", metavar="N", help=f"{prefix}N 天后过期（支持小数，如 0.5 = 12 小时）")
    p.add_argument("--until", metavar="日期", help=f"{prefix}YYYY-MM-DD 当天结束（UTC）时过期")
    p.add_argument("--never", action="store_true", help=f"明确设为永不过期{prefix and '（默认即如此）' or ''}")


def _add_argv_pw_guard(p) -> None:
    """隐藏参数，专门用来接住 `--password 明文`：宁可给一句解释，也别让人以为"不能自定义"。"""
    p.add_argument("--password", dest="password_argv", metavar="密码", help=argparse.SUPPRESS)


def _read_new_password(a) -> str:
    """自定义密码的三个来源：--password-prompt（不回显）/ --password-stdin（管道）/ 随机生成。"""
    _refuse_argv_password(a)
    if getattr(a, "password_prompt", False):
        try:
            pw = getpass.getpass("输入密码（不回显）: ")
            if getpass.getpass("再输一次以便确认: ") != pw:
                die("两次输入不一致，未改动任何文件。")
        except (EOFError, KeyboardInterrupt):
            print()
            die("已取消")
        return _check_min_pw(pw)
    if getattr(a, "password_stdin", False):
        return _check_min_pw(sys.stdin.readline().rstrip("\n"))
    n = max(8, min(128, getattr(a, "len", 24)))
    # 去掉了容易混淆的 0/O/1/l/I
    alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_.~!*"
    return "".join(secrets.choice(alphabet) for _ in range(n))


def _announce(pw: str, eid: str, label: str) -> None:
    print()
    print(f"  id    : {eid}")
    print(f"  标签  : {label or '-'}")
    print(f"  密码  : {pw}")
    print()
    if sys.stdout.isatty():
        print("  ⚠ 此密码只显示这一次，请立即保存到密码管理器。")
        print("    忘记后无法找回，只能 `passwd` 轮换或删掉重建。")


def cmd_add(a) -> None:
    _refuse_argv_password(a)
    store = load_store(a.state)
    if len(store["entries"]) >= MAX_ENTRIES:
        die(f"已达条目上限 {MAX_ENTRIES}")
    pw = _read_new_password(a)
    eid = new_id({e["id"] for e in store["entries"]})
    salt_b64, hash_b64 = hash_password(pw)
    has_exp = expiry_given(a)
    entry = {
        "id": eid,
        "label": (a.label or "")[:MAX_LABEL],
        "note": (a.note or "")[:MAX_NOTE],
        "salt": salt_b64,
        "hash": hash_b64,
        "rev": 1,
        "enabled": True,
        "expires_at": expiry_from_args(a) if has_exp else None,
        "created_at": now_iso(),
        "created_by": "local",
    }
    dup_ids = find_same_password(store, pw)
    if dup_ids:
        dup_ids.append(eid)
        anchor = assign_dup_group(store, dup_ids)
        entry["dup"] = anchor
        info(f"⚠ 这条密码与已有条目相同：{dup_group_labels(store, anchor)}")
        info("  同一密码多条目时，登录会优先命中「启用且未过期」的那条；建议错开密码。")
    store["entries"].append(entry)
    save_store(a.state, store)
    _announce(pw, eid, a.label or "")
    info(f"  已写入 {store_path(a.state)}（共 {len(store['entries'])} 条）")
    warn_if_pending_push(a.state)


def cmd_list(a) -> None:
    store = load_store(a.state)
    agg = usage_summary(a.state)
    info(f"密码表：{store_path(a.state)}    gen={store['gen']}    条目={len(store['entries'])}")
    if not store["entries"]:
        info("（空表——还没有任何有效密码）")
        return
    info("")
    info(" ".join(pad(h, w) for h, w in zip(("id", "标签", "状态", "有效期", "最近使用",
                                             "成功/失败"), ENTRY_COLS)) + " 备注")
    info(sep_line(ENTRY_COLS))
    # 最新的在最上面（按创建时间倒序）。`cms list` 和网页界面保持同一个方向——
    # 两处不一致会让人对着两个屏幕数半天。（历史原因：这里原本是正序。）
    for e in sorted(store["entries"], key=lambda x: x.get("created_at", ""), reverse=True):
        info(fmt_entry_line(e, agg, utc=a.utc))
    info("")
    if not agg:
        info("（还没有使用记录；用 `usage --remote` 从服务器拉取）")
    info(zone_footer(a.utc))
    warn_if_pending_push(a.state)


def _find(store: dict, eid: str) -> dict:
    for e in store["entries"]:
        if e["id"] == eid:
            return e
    die(f"找不到 id 为 {eid} 的密码（用 list 查看）")
    raise AssertionError  # 不可达


def cmd_rm(a) -> None:
    store = load_store(a.state)
    e = _find(store, a.id)
    if not a.yes:
        print(f"将删除：{e['id']}  标签={e.get('label') or '-'}  备注={e.get('note') or '-'}")
        print("该密码的所有在线会话会立即失效。")
        ans = input("确认删除？输入 yes 继续：").strip().lower()
        if ans not in ("y", "yes"):
            info("已取消")
            return
    store["entries"] = [x for x in store["entries"] if x["id"] != a.id]
    save_store(a.state, store)
    info(f"已删除 {a.id}（剩余 {len(store['entries'])} 条）")
    warn_if_pending_push(a.state)


def cmd_note(a) -> None:
    store = load_store(a.state)
    e = _find(store, a.id)
    if a.label is not None:
        e["label"] = a.label[:MAX_LABEL]
    if a.note is not None:
        e["note"] = a.note[:MAX_NOTE]
    save_store(a.state, store)
    info(f"已更新 {a.id}：标签={e.get('label') or '-'}  备注={e.get('note') or '-'}")
    warn_if_pending_push(a.state)


def cmd_passwd(a) -> None:
    _refuse_argv_password(a)
    store = load_store(a.state)
    e = _find(store, a.id)
    pw = _read_new_password(a)
    e["salt"], e["hash"] = hash_password(pw)
    e["rev"] = int(e.get("rev", 1)) + 1          # 让该条密码已签发的会话全部失效
    e["rotated_at"] = now_iso()
    dup_ids = find_same_password(store, pw, exclude_id=e["id"])
    if dup_ids:
        dup_ids.append(e["id"])
        anchor = assign_dup_group(store, dup_ids)
        e["dup"] = anchor
        info(f"⚠ 轮换后的密码与已有条目相同：{dup_group_labels(store, anchor)}")
    elif e.pop("dup", None) is not None:
        info("  该条目已脱离原重复组（新密码不再与任何条目相同）。")
    save_store(a.state, store)
    _announce(pw, e["id"], e.get("label") or "")
    info(f"  该密码的旧会话已失效（rev={e['rev']}），其他密码不受影响。")
    warn_if_pending_push(a.state)


def cmd_dupmark(a) -> None:
    """手动补标重复组：存量条目手里没有明文，自动检测认不出，只能人来指认。"""
    store = load_store(a.state)
    if a.clear:
        e = _find(store, a.clear)
        if e.pop("dup", None) is None:
            die(f"条目 {a.clear} 本来就不在任何重复组里")
        save_store(a.state, store)
        info(f"已把 {a.clear} 移出重复组。")
        warn_if_pending_push(a.state)
        return
    if len(a.ids) < 2:
        die("至少给两个条目 id——要标记的是「同一密码」的全部条目（用 list 查 id）")
    entries = [_find(store, i) for i in a.ids]
    anchor = assign_dup_group(store, [x["id"] for x in entries])
    save_store(a.state, store)
    info(f"已把 {len(a.ids)} 条标进重复组（锚 {anchor}）：")
    info(f"  {dup_group_labels(store, anchor)}")
    info("推送后 cmsui 会给这几行画同一底色。")
    warn_if_pending_push(a.state)


def cmd_revoke_all(a) -> None:
    """强制退登：把 gen 提升 1，让**所有**在线会话失效。

    两个当初踩过坑的地方，都在这里堵掉：
      1. 它会踢掉**包括你自己在内**的所有人——所以必须先说明、再要求 `--yes`。
      2. gen 是在**本地**提升的，不 push 就等于什么都没发生。旧版只留一句「别忘了推送」，
         用户停在半截状态，还以为浏览器是被别的东西弹出的。现在默认顺手推送（一次到位）。
    """
    store = load_store(a.state)
    before = int(store.get("gen", 1))
    after = before + 1

    if not a.yes:
        # 正常路径不该走到这里（main() 的 precheck 已经处理了），留着是为了
        # 直接调用 cmd_revoke_all 的脚本也不会漏掉这道护栏。
        _revoke_all_explain_and_refuse(a)

    store["gen"] = after
    save_store(a.state, store)
    info(f"本地 gen：{before} → {after}（未推送前，线上谁都还没被踢）")

    if a.no_push:
        info("（--no-push）线上仍是旧 gen，此刻谁都还没被踢。")
        warn_if_pending_push(a.state)
        return

    try:
        do_push(a)
    except SystemExit:
        info("")
        info("⚠ 推送没成功——本地 gen 已经提升，但**线上还是旧的**，此刻没人被踢。")
        warn_if_pending_push(a.state)
        raise

    remote_gen = remote_store_gen(a)
    if remote_gen == after:
        info(f"✓ 服务器已生效（gen={remote_gen}）。所有在线会话——包括你自己这个浏览器——")
        info("  下一次请求就会回到密码页，重新输一次密码（用哪条有效密码都行）。")
    else:
        info(f"⚠ 服务器上的 gen 读到的是 {remote_gen}，与本地 {after} 不一致——请检查上面的推送输出。")


def cmd_show(a) -> None:
    """单条密码的详情 + **它自己的**访问记录（用户要的「本密码访问日志」）。"""
    store = load_store(a.state)
    e = _find(store, a.id)
    st = entry_state(e)
    info(f"id        : {e['id']}")
    info(f"标签      : {e.get('label') or '-'}")
    info(f"备注      : {e.get('note') or '-'}")
    info(f"状态      : {st}")
    info(f"有效期    : {entry_expiry_text(e, utc=a.utc)}")
    info(f"创建      : {iso_to_local(e.get('created_at'))}")
    if e.get("rotated_at"):
        info(f"上次轮换  : {iso_to_local(e.get('rotated_at'))}")
    info(f"rev       : {e.get('rev', 1)}（每次轮换 +1，旧会话立即失效）")
    if st == "启用":
        info("会话      : 有效——直到浏览器关闭（会话 cookie）或 24 小时绝对上限")
    else:
        info("会话      : 已失效——本条不可用时，已登录的会话下一次请求就被拒")
    recs = [r for r in read_usage(a.state) if r.get("pwid") == a.id]
    info("")
    if not recs:
        info("（本地没有这条密码的访问记录；先跑 `usage --remote` 从服务器拉取）")
        return
    info(f"访问记录：最近 {min(len(recs), a.limit)} 条（本地缓存共 {len(recs)} 条）")
    _print_usage_rows(recs[-a.limit:], utc=a.utc, show_ua=a.ua)
    info("")
    info(zone_footer(a.utc))


def _set_enabled(a, on: bool) -> None:
    store = load_store(a.state)
    e = _find(store, a.id)
    if e.get("enabled", True) == on:
        info(f"{a.id} 已经处于「{entry_state(e)}」，未改动。")
        return
    e["enabled"] = on
    e["enabled_at"] = now_iso()
    save_store(a.state, store)
    info(f"{a.id}（{e.get('label') or '-'}）→ {'启用' if on else '已禁用'}")
    if not on:
        info("  该密码已登录的会话会在下一次请求时立即失效（记录保留，不删）。")
    warn_if_pending_push(a.state)


def cmd_disable(a) -> None:
    _set_enabled(a, False)


def cmd_enable(a) -> None:
    _set_enabled(a, True)


def cmd_expire(a) -> None:
    store = load_store(a.state)
    e = _find(store, a.id)
    exp = expiry_from_args(a)
    e["expires_at"] = exp
    save_store(a.state, store)
    info(f"{a.id}（{e.get('label') or '-'}）有效期 → "
         f"{'永久（不过期）' if exp is None else iso_to_local(exp) + '（本地时间）'}")
    if exp is not None:
        info("  过期后该密码的会话也会立即失效。")
    warn_if_pending_push(a.state)


# --------------------------------------------------------------------------
# 总开关与管理口令
# --------------------------------------------------------------------------
#: 命令自己声明的「动手前本地判断」。在**问口令之前**跑，
#: 这样「你还没加 --yes」这种拒绝不会浪费用户输一遍口令，也不会让人以为口令是错的。
PRECHECK_CMDS = frozenset({"revoke-all"})


def _run_precheck(a) -> None:
    """执行命令声明的动手前判断。走到这一步说明参数层面已经齐全了。"""
    if a.cmd == "revoke-all" and not a.yes:
        _revoke_all_explain_and_refuse(a)


def _revoke_all_explain_and_refuse(a) -> None:
    """revoke-all 的「先说明、再拒绝」。**一个字节都不改动。**

    单独抽出来是为了能在问管理口令**之前**跑：用户漏了 --yes 时，
    正确的反馈是「加 --yes」，而不是「口令不正确」——后者会让人
    反复重输一个根本没输错的口令。
    """
    try:
        store = load_store(a.state)
        before = int(store.get("gen", 1))
    except SystemExit:
        before = 1
    after = before + 1
    info("revoke-all：让**所有**在线会话立即失效——包括你自己此刻开着的那个浏览器。")
    info("")
    info(f"  做法：密码表的 gen 由 {before} 改成 {after}")
    info("        每个会话 cookie 里都记着签发时的 gen，服务端比对不上就拒 → 全部回到密码页")
    info("        （想只踢某一条密码，用 `passwd <id>`：只让那一条的旧会话失效）")
    info("")
    info("  生效**必须推送到服务器**。本命令默认紧接着帮你推（一次到位）；")
    info(f"  加 --no-push 则只改本地，之后自己跑 {prog()} push。")
    info("")
    info("  注意：确认执行时还会要求**管理口令**（它会踢掉所有人，值得多一道确认）。")
    die("已中止，未改动任何文件。确认要踢人（含你自己）请加 --yes。")


def _load_gate_config(a, *, need_admin: bool = False) -> dict:
    data = remote_read_json(a, GATE_CONFIG_NAME)
    if data is None:
        if need_admin:
            die(f"服务器上还没有 {GATE_CONFIG_NAME}（也就没有管理口令）。\n"
                f"先跑： {prog()} admin-init")
        return {"version": GATE_VERSION, "require_password": True,
                "updated_at": "", "updated_by": "", "admin": None}
    validate_gate_config(data, where=f"{a.server}:{remote_path(a, GATE_CONFIG_NAME)}")
    return data


def cmd_gate(a) -> None:
    _refuse_argv_password(a)
    cfg = _load_gate_config(a)
    require = cfg["require_password"]
    if a.action == "status":
        admin = cfg.get("admin")
        info(f"位置    : {a.server}:{remote_path(a, GATE_CONFIG_NAME)}")
        info(f"闸门    : {'开 —— 访问需要密码' if require else '关 —— 任何人不用密码就能进'}")
        info(f"管理口令: {'已设置' if admin else '未设置'}"
             + (f"（{str(admin.get('set_at', '?'))[:19]}Z 设置）" if admin else ""))
        if cfg.get("updated_at"):
            info(f"上次改动: {iso_to_local(cfg['updated_at'])}（{cfg.get('updated_by') or '-'}）")
        return

    want = (a.action == "on")
    if want == require:
        info(f"闸门已经是「{'开' if want else '关'}」，未做改动。")
        return
    admin = cfg.get("admin")
    if not isinstance(admin, dict):
        die(f"服务器上没有管理口令，无法切换闸门。先跑： {prog()} admin-init")
    pw = _read_secret(a, f"管理口令（把闸门{'打开' if want else '关闭'}需要校验）: ")
    if not verify_password(pw, admin["salt"], admin["hash"]):
        die("管理口令不正确，闸门**未**改动。")
    cfg["require_password"] = want
    cfg["updated_at"] = now_iso()
    cfg["updated_by"] = "gate_manager"
    remote_put_json(a, GATE_CONFIG_NAME, cfg, label="闸门配置")
    gate_audit(a.state, f"gate {'on' if want else 'off'}")
    info("")
    if want:
        info("  ✓ 闸门已打开：访问需要密码，未通过的访客只能看到密码页。")
    else:
        info("  ⚠ 闸门已关闭：**任何人**打这个地址都能直接进游戏，不再需要密码。")
        info(f"     要恢复保护： {prog()} gate on")
    info("  立即生效（服务端按 mtime 热重载，不用重启服务、也不用动 nginx）。")


def cmd_admin_init(a) -> None:
    _refuse_argv_password(a)
    cfg = _load_gate_config(a)
    if isinstance(cfg.get("admin"), dict) and not a.force:
        die("服务器上已经设置了管理口令。要更换请用 admin-passwd；确实要覆盖请加 --force")
    pw = _read_secret(a, f"设置管理口令（至少 {ADMIN_MIN_PW} 位，不回显）: ",
                      min_len=ADMIN_MIN_PW)
    if not a.password_stdin:
        if _read_secret(a, "再输一次以便确认: ", min_len=ADMIN_MIN_PW) != pw:
            die("两次输入不一致，未改动")
    cfg["admin"] = make_admin_block(pw)
    cfg["updated_at"] = now_iso()
    cfg["updated_by"] = "gate_manager"
    remote_put_json(a, GATE_CONFIG_NAME, cfg, label="管理口令")
    gate_audit(a.state, "admin-init")
    info("")
    info("  ✓ 管理口令已设置（服务器上只存 scrypt 哈希，明文不落盘、不进 argv）。")
    info(f"    切换闸门时用它校验： {prog()} gate off")


def cmd_admin_passwd(a) -> None:
    _refuse_argv_password(a)
    cfg = _load_gate_config(a, need_admin=True)
    admin = cfg.get("admin")
    if not isinstance(admin, dict):
        die(f"还没有管理口令。先跑： {prog()} admin-init")
    if not verify_password(_read_secret(a, "当前管理口令: "), admin["salt"], admin["hash"]):
        die("当前管理口令不正确，未改动。")
    pw = _read_secret(a, f"新管理口令（至少 {ADMIN_MIN_PW} 位）: ", min_len=ADMIN_MIN_PW)
    if not a.password_stdin:
        if _read_secret(a, "再输一次以便确认: ", min_len=ADMIN_MIN_PW) != pw:
            die("两次输入不一致，未改动")
    cfg["admin"] = make_admin_block(pw)
    cfg["updated_at"] = now_iso()
    cfg["updated_by"] = "gate_manager"
    remote_put_json(a, GATE_CONFIG_NAME, cfg, label="管理口令")
    gate_audit(a.state, "admin-passwd")
    info("  ✓ 管理口令已更换，下次切换闸门用新口令。")


def cmd_usage(a) -> None:
    if a.remote:
        a.state.mkdir(parents=True, exist_ok=True)
        remote = f"{a.remote_dir}/usage.jsonl"
        r = run(ssh_cmd(a) + [f"tail -n {max(1, min(a.limit * 5, 5000))} {remote} 2>/dev/null"],
                check=False)
        if r.returncode != 0 or not (r.stdout or "").strip():
            die("拉取失败（或服务器还没有使用记录）。检查 ssh 与文件路径。")
        usage_cache_path(a.state).write_text(r.stdout, encoding="utf-8")
        os.chmod(usage_cache_path(a.state), 0o600)
        info(f"已拉取到本地缓存：{usage_cache_path(a.state)}")
    recs = read_usage(a.state)
    if a.id:
        recs = [r for r in recs if r.get("pwid") == a.id]
    recs = recs[-a.limit:]
    if not recs:
        info("（没有记录）")
        return
    _print_usage_rows(recs, utc=a.utc, show_ua=getattr(a, "ua", False))
    info("")
    info(zone_footer(a.utc))


def do_push(a, *, force: bool = False, dry_run: bool = False) -> bool:
    """把本地密码表推送到服务器。成功返回 True。

    单独抽出来是因为 `revoke-all` 也必须走这里——踢人只有推上去才算数，
    两步操作会让人停在「本地改了、线上没变」的半截状态。
    """
    store = load_store(a.state)
    if not store["entries"] and not force:
        die("拒绝推送空表——那会让所有人都进不去。确实要清空请显式加 --force")
    src = store_path(a.state)
    lh = local_sha(src)
    remote_file = f"{a.remote_dir}/passwords.json"
    remote_new = f"{a.remote_dir}/passwords.json.new"

    rh = remote_sha(a, remote_file)
    if rh and rh == lh and not force:
        mark_pushed(a.state, store_sha(a.state))
        info(f"远端已是最新（sha256 {lh}…），无需推送。")
        return True

    # ↓ 护栏：把 gen「推回旧的」看着像能踢人，其实是**反向**的——cookie 里带着 gen，
    #   服务端一比对不上就拒；gen 降回去会让**已经被踢掉的老 cookie 重新生效**（误放行）。
    #   典型误操作：revoke-all 没推、又 pull 了一次，本地 gen 被拉回旧值，随后 push 就降回去了。
    if not force:
        remote_gen = remote_store_gen(a)
        local_gen = store.get("gen", 1)
        if isinstance(remote_gen, int) and local_gen < remote_gen:
            die(f"拒绝推送：本地 gen={local_gen} 低于服务器的 gen={remote_gen}。\n"
                f"  推上去会让**已经被踢掉的旧会话重新生效**（等于撤销了上次 revoke-all）。\n"
                f"  先跑 `pull` 把服务器那份取回来再改；确实要回退 gen 请加 --force。")

    steps = [
        f"scp -P {a.ssh_port} {src} {a.server}:{remote_new}",
        f"ssh -p {a.ssh_port} {a.server} 'python3 -m json.tool {remote_new} >/dev/null'",
        f"ssh -p {a.ssh_port} {a.server} 'cp -a {remote_file} {remote_file}.bak-$(date +%s)'",
        f"ssh -p {a.ssh_port} {a.server} 'ls -1t {remote_file}.bak-* | tail -n +{BAK_KEEP + 1} "
        f"| xargs -r rm -f'  # 只留最近 {BAK_KEEP} 份",
        f"ssh -p {a.ssh_port} {a.server} 'mv {remote_new} {remote_file} && "
        f"chown cmsgate:cmsgate {remote_file} && chmod 600 {remote_file}'",
    ]
    if dry_run:
        info("--dry-run，将执行：")
        for s in steps:
            info("  " + s)
        info(f"（本地 sha256 {lh}…）")
        return True

    # 1) 上传到 .new（先落到临时名，避免半截文件覆盖线上）
    r = run(["scp", "-P", a.ssh_port, "-o", "BatchMode=yes", str(src), f"{a.server}:{remote_new}"],
            check=False)
    if r.returncode != 0:
        die(f"scp 失败：{r.stderr.strip() or r.stdout.strip()}")

    # 2) 远端预校验 JSON（解析失败即拒绝，绝不「尽力解析」）
    r = run(ssh_cmd(a) + [f"python3 -m json.tool {remote_new} >/dev/null"], check=False)
    if r.returncode != 0:
        run(ssh_cmd(a) + [f"rm -f {remote_new}"], check=False)
        die("远端 JSON 预校验失败，已丢弃 .new（线上未被改动）")

    # 3) 备份现有（首次部署时文件可能不存在），再裁掉超出 BAK_KEEP 的旧备份
    run(ssh_cmd(a) + [f"[ -f {remote_file} ] && cp -a {remote_file} {remote_file}.bak-$(date +%s) || true"],
        check=False)
    remote_rotate_bak(a, remote_file)

    # 4) 原子替换
    r = run(ssh_cmd(a) + [f"mv {remote_new} {remote_file} && chown cmsgate:cmsgate {remote_file} "
                          f"&& chmod 600 {remote_file}"], check=False)
    if r.returncode != 0:
        die(f"远端替换失败：{r.stderr.strip()}")
    mark_pushed(a.state, store_sha(a.state))
    info(f"已推送（本地 sha256 {lh}…）——服务端按 mtime 热重载，无需重启。")
    return True


def cmd_push(a) -> None:
    do_push(a, force=a.force, dry_run=a.dry_run)


def cmd_pull(a) -> None:
    remote_file = f"{a.remote_dir}/passwords.json"
    r = run(ssh_cmd(a) + [f"cat {remote_file} 2>/dev/null"], check=False)
    if r.returncode != 0 or not (r.stdout or "").strip():
        die("拉取失败（或远端还没有密码表）")
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        die(f"远端内容不是合法 JSON：{e}")
    validate_store(data)

    # ↓ 护栏：pull 是**覆盖式**的。本地未推送的新条目会被静默抹掉——
    #   用户就是在「add 完没 push，又 pull 一下」之后发现"刚建的用户不见了"。
    #   这里必须先说清楚会被抹掉什么，而不是默默覆盖。
    if not a.force:
        try:
            cur = load_store(a.state)
        except SystemExit:
            cur = None
        if cur:
            server_ids = {e["id"] for e in data["entries"]}
            lost = [e for e in cur["entries"] if e["id"] not in server_ids]
            cur_gen, new_gen = cur.get("gen"), data.get("gen")
            if lost or (isinstance(cur_gen, int) and isinstance(new_gen, int)
                        and cur_gen != new_gen):
                info("⚠ 这次 pull 会**覆盖**本地密码表，并且：")
                for e in lost:
                    info(f"    · 丢弃本地条目 {e['id']}（{e.get('label') or '-'}）"
                         f"——服务器上没有它（多半是你 add 完没 push）")
                if cur_gen != new_gen:
                    info(f"    · gen 由 {cur_gen} 变为 {new_gen}")
                info("")
                info("  本地那份不会被自动备份。若那些条目还要，先 `push` 再 `pull`；")
                info(f"  确实要丢弃本地改动、以服务器为准，请加 --force 重跑。")
                die("已中止，未改动本地文件。")

    a.state.mkdir(parents=True, exist_ok=True)
    save_store(a.state, data)
    info(f"已同步到本地：{store_path(a.state)}（{len(data['entries'])} 条，gen={data['gen']}）")


def cmd_selftest(a) -> None:
    ok = True

    def chk(cond: bool, what: str) -> None:
        nonlocal ok
        print(("  ✓ " if cond else "  ✗ ") + what)
        ok = ok and cond

    # ── 离线自检环境 ──
    # 自检里有一批**子进程**调用（要真的走一遍 argparse、改文件、比对结果）。
    # 加了管理口令校验后，那些子进程也会被问口令——而自检可能跑在没有网络的机器上。
    # 所以这里自建一份**假 gateconfig**，用 `--offline-admin-config` 指过去，
    # 并把口令喂给子进程。这样自检不依赖服务器、也不需要知道真实口令。
    # ★ 走 argv 而不是环境变量：环境变量会被继承，「谁 export 过一次忘了取消」
    #   就让真实运维静默降级到假凭据（详见 require_admin 的注释）。
    selftest_offline = tempfile.mkdtemp(prefix="cmsgate-selftest-")
    _fake_cfg = os.path.join(selftest_offline, "gateconfig.json")
    with open(_fake_cfg, "w", encoding="utf-8") as f:
        json.dump({"version": GATE_VERSION, "require_password": True,
                   "updated_at": now_iso(), "updated_by": "selftest",
                   "admin": make_admin_block(SELFTEST_ADMIN_PW)}, f, ensure_ascii=False)
    os.chmod(_fake_cfg, 0o600)

    # 每个子进程 argv 里都带上它（而不是塞进 env）。
    OFFLINE_ARG = ["--offline-admin-config", _fake_cfg]

    info("密码派生（跨端向量）")
    chk(derive_pw(VECTOR_PW, VECTOR_SALT).hex() == VECTOR_HASH_HEX,
        "scrypt 结果与 authd.py 的向量一致")

    info("salt/hash 编码（与 authd.py 一致：urlsafe base64 无填充）")
    for raw in (bytes(range(16)), bytes([0xfb, 0xef, 0xbe]), b"\x00\xff\xfe\xfd" * 8):
        enc = b64e(raw)
        chk("+" not in enc and "/" not in enc and "=" not in enc, f"编码不含 + / = ：{enc[:24]}")
        chk(b64d(enc) == raw, f"往返一致（{len(raw)} 字节）")

    info("哈希与校验")
    salt_b64, hash_b64 = hash_password("正确密码123456")
    chk(verify_password("正确密码123456", salt_b64, hash_b64), "正确密码通过")
    chk(not verify_password("错误密码123456", salt_b64, hash_b64), "错误密码被拒")
    chk(not verify_password("", salt_b64, hash_b64), "空密码被拒")
    chk(not verify_password("正确密码123456", "!!非法", hash_b64), "畸形 salt 不抛异常而是拒绝")

    info("常量时间比较")
    chk(hmac.compare_digest(b"a" * 32, b"a" * 32) and not hmac.compare_digest(b"a" * 32, b"b" * 32),
        "compare_digest 行为正常")

    info("密码表往返")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        s = load_store(st)
        chk(s["entries"] == [] and s["version"] == STORE_VERSION, "空表可写可读")
        chk((st.stat().st_mode & 0o777) == 0o700, "目录权限为 0700")
        chk((store_path(st).stat().st_mode & 0o777) == 0o600, "文件权限为 0600")
        for bad in ("{}", '{"version":99}', '{"version":1,"gen":1,"params":{"kdf":"md5"},"entries":[]}',
                    '{"version":1,"gen":1,"params":{"kdf":"scrypt","n":16384,"r":8,"p":1,"dklen":32,"salt_bytes":16},"entries":[{"id":"a","salt":"AA==","hash":"AA=="}]}'):
            try:
                validate_store(json.loads(bad))
                good = False
            except SystemExit:
                good = True
            chk(good, f"畸形表被拒：{bad[:46]}…")

    info("「忘了 push」检测（本地改完不推，线上仍是旧表）")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        chk(push_state(st) == "unknown", "没有推送记录 → unknown（宁可多提醒）")
        mark_pushed(st, store_sha(st))
        chk(push_state(st) == "clean", "标记与文件一致 → clean")
        s = load_store(st)
        salt_b64, hash_b64 = hash_password("新增一条用于检测")
        s["entries"].append({"id": "abcdefabcdef", "label": "", "note": "",
                             "salt": salt_b64, "hash": hash_b64, "rev": 1,
                             "created_at": now_iso(), "created_by": "selftest"})
        save_store(st, s)
        chk(push_state(st) == "pending", "文件改动后 → pending")
        mark_pushed(st, store_sha(st))
        chk(push_state(st) == "clean", "重新标记后 → clean")

    info("revoke-all：不给 --yes 就绝不动文件；给了才提升 gen")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        s = load_store(st)
        salt_b64, hash_b64 = hash_password("revoke-all 自检用密码")
        s["entries"].append({"id": "abcdefabcdef", "label": "自检", "note": "",
                             "salt": salt_b64, "hash": hash_b64, "rev": 1,
                             "created_at": now_iso(), "created_by": "selftest"})
        save_store(st, s)
        mark_pushed(st, store_sha(st))      # 假装刚推过一次，这样 revoke-all 之后才叫 pending
        gen0 = load_store(st)["gen"]
        me = str(Path(__file__).resolve())

        def run_gm(*args: str):
            return subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), *args, "--admin-stdin"],
                                  input=SELFTEST_ADMIN_PW + "\n",
                                  capture_output=True, text=True)

        r = run_gm("revoke-all")
        chk(r.returncode != 0, "不带 --yes → 非 0 退出（拒绝执行）")
        chk(load_store(st)["gen"] == gen0, "被拒绝时 gen 一个字节都没变")
        chk("--yes" in (r.stdout + r.stderr), "拒绝时告诉用户要加 --yes")

        # 合并 stdout+stderr（模拟 `2>&1 | tee`），说明必须在错误行**之前**——
        # 否则用户先看到「错误：已中止」，不知道在说哪件事。
        r2 = subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "revoke-all"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        out = r2.stdout
        chk(out.index("revoke-all：让") < out.index("错误："),
            "说明排在错误行之前（stdout 已先 flush）")

        r = run_gm("revoke-all", "--yes", "--no-push")
        chk(r.returncode == 0, "--yes --no-push → 成功")
        chk(load_store(st)["gen"] == gen0 + 1, "gen 提升 1")
        r = run_gm("revoke-all", "--yes", "--no-push")
        chk(load_store(st)["gen"] == gen0 + 2, "再跑一次再 +1（线性，不是置位）")
        chk(push_state(st) == "pending", "本地改了没推 → 处于 pending（会醒目提醒）")

    info("自定义访问密码：三种来源 + 拒绝把密码写在命令行里")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        me = str(Path(__file__).resolve())

        def gm(*args: str, stdin: str = ""):
            return subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), *args, "--admin-stdin"],
                                  input=SELFTEST_ADMIN_PW + "\n" + stdin,
                                  capture_output=True, text=True)

        n0 = len(load_store(st)["entries"])

        r = gm("add", "--label", "x", "--password", "明文密码写在参数里")
        chk(r.returncode != 0 and len(load_store(st)["entries"]) == n0,
            "`--password 明文` 被拒且未写入（argv 会被 ps 与 shell 历史看到）")
        chk("--password-prompt" in (r.stdout + r.stderr), "拒绝时给出可执行的替代写法")

        r = gm("add", "--label", "x", "--password-stdin", stdin="太短了")
        chk(r.returncode != 0 and len(load_store(st)["entries"]) == n0, "少于 12 字符的自定义密码被拒")

        mine = "我自己定的密码2026!"
        r = gm("add", "--label", "自定义", "--password-stdin", stdin=mine)
        chk(r.returncode == 0, "从 stdin 喂自定义密码 → 成功")
        e = load_store(st)["entries"][0]
        chk(verify_password(mine, e["salt"], e["hash"]), "写入的就是我设的那个密码")
        chk(not verify_password(mine + "x", e["salt"], e["hash"]), "差一个字符就验不过")

        r = gm("add", "--label", "y", "--password-stdin", "--password-prompt")
        chk(r.returncode != 0, "两种输入方式互斥（argparse 层就拦住）")

    info("有效期：--hours / --days 都支持小数 + 非法输入给中文提示")
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        me = str(Path(__file__).resolve())
        subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "init"],
                       input=SELFTEST_ADMIN_PW + "\n",
                       capture_output=True, text=True)
        subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "add", "--label", "t",
                        "--password-stdin", "--admin-stdin"],
                       input=SELFTEST_ADMIN_PW + "\nexpiry-selftest-pw-2026\n",
                       capture_output=True, text=True)
        eid = load_store(st)["entries"][0]["id"]

        def hours_left(flag: str, val: str) -> float:
            r = subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "expire", eid, flag, val, "--admin-stdin"],
                               input=SELFTEST_ADMIN_PW + "\n",
                               capture_output=True, text=True)
            assert r.returncode == 0, (flag, val, r.stdout, r.stderr)
            exp = load_store(st)["entries"][0]["expires_at"]
            t = datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            return (t - datetime.now(timezone.utc)).total_seconds() / 3600.0

        for flag, val, want_h in (("--hours", "6", 6.0), ("--hours", "0.5", 0.5),
                                  ("--hours", "0.01", 0.01), ("--days", "7.5", 180.0),
                                  ("--days", "0.5", 12.0), ("--days", "7", 168.0)):
            got = hours_left(flag, val)
            chk(abs(got - want_h) < 0.02, f"{flag} {val} → {want_h:g} 小时（实测 {got:.3f}）")

        def bad(*args: str):
            return subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "expire", eid, *args, "--admin-stdin"],
                                  input=SELFTEST_ADMIN_PW + "\n",
                                  capture_output=True, text=True)

        r = bad("--days", "abc")
        chk(r.returncode != 0 and "不是数字" in r.stderr, "`--days abc` 被拒且给中文提示")
        chk("--hours 6" in r.stderr and "--days 0.5" in r.stderr, "提示里示范了正确写法")
        r = bad("--days", "0")
        chk(r.returncode != 0 and "0.01..3650" in r.stderr, "`--days 0` 被拒（0 天等于立即过期）")
        r = bad("--hours", "-1")
        chk(r.returncode != 0, "负数被拒")
        r = bad("--hours", "nan")
        chk(r.returncode != 0 and "有限数字" in r.stderr, "nan 被拒（float('nan') 能通过范围比较）")
        r = bad("--days", "1", "--hours", "1")
        chk(r.returncode != 0 and "只能给一个" in r.stderr, "同时给 --days 与 --hours 被拒")
        r = bad("--never", "--days", "1")
        chk(r.returncode != 0, "--never 与具体时长互斥")
        r = bad()
        chk(r.returncode != 0 and "四者之一" in r.stderr, "什么都不给 → 提示四选一")

    info("管理口令：写操作必须过第二道门（SSH 私钥之外的第二层）")
    # 这一段的断言针对**集合与常量**，不联网、不需要真实服务器——
    # 目的是「以后有人加了新命令却忘了加进受保护集合」时这里立刻红。
    real_cmds = set(re.findall(r'sub\.add_parser\("([^"]+)"',
                               Path(__file__).read_text(encoding="utf-8")))
    chk(not (real_cmds - ADMIN_GUARDED_CMDS - set(ADMIN_EXEMPT_CMDS)),
        f"每个子命令都在受保护集或豁免表里（漏={real_cmds - ADMIN_GUARDED_CMDS - set(ADMIN_EXEMPT_CMDS)}）")
    chk(not ((ADMIN_GUARDED_CMDS | set(ADMIN_EXEMPT_CMDS)) - real_cmds),
        "受保护/豁免表里没有不存在的命令（不会写错名字）")
    chk(all(ADMIN_EXEMPT_CMDS.get(c) for c in ADMIN_EXEMPT_CMDS),
        "每个豁免项都写了理由（免得后来人顺手加一条就把门拆了）")
    # ★ 真正的不变量：凡是会改动本地表或线上状态的命令，都必须受保护
    writeish = {"add", "rm", "disable", "enable", "expire", "passwd", "note",
                "push", "pull", "revoke-all"}
    chk(writeish <= ADMIN_GUARDED_CMDS, f"全部写操作受保护（漏={writeish - ADMIN_GUARDED_CMDS}）")
    chk(not (ADMIN_GUARDED_CMDS & {"list", "show", "usage", "init", "selftest"}),
        "读操作不该被拦（否则日常查看也要输口令）")
    chk("gate" in ADMIN_EXEMPT_CMDS and "admin-init" in ADMIN_EXEMPT_CMDS,
        "gate / admin-init 已豁免（各有就地校验或属bootstrap）")
    # ★ SCRYPT_CMDS 必须覆盖全部受保护命令：漏一个的话，在 macOS 自带 python3 上
    #   它会抛 AttributeError 而不是给一句「请换解释器」，而且只在那一台上出现。
    chk(ADMIN_GUARDED_CMDS <= SCRYPT_CMDS,
        f"SCRYPT_CMDS 覆盖受保护命令（漏={ADMIN_GUARDED_CMDS - SCRYPT_CMDS}）")
    # ★ 不该存在「跳过管理口令校验」的开关——那等于把这道门重新变成装饰。
    #   检查法不是 grep 源码（会漏），而是**真的解析一遍参数**：任何
    #   --no-admin / --skip-admin / --force-admin 之类的选项都不该被接受。
    import argparse as _ap
    p_probe = _ap.ArgumentParser()
    _add_admin_args(p_probe)
    known = {s for act in p_probe._actions for s in act.option_strings}
    chk("--admin-stdin" in known, "提供了 --admin-stdin（脚本化喂口令）")
    # 背景图：status 只读不该问口令，on/off/push 必须问 → 所以整条命令走
    # 「就地校验」，而界面（gate_ui）靠这个集合判断要不要喂 admin 行。
    chk("webbg" in INPLACE_ADMIN_CMDS and "webbg" in SCRYPT_CMDS,
        "webbg 已登记为就地校验 + 需要 scrypt")
    chk("webbg" not in ADMIN_GUARDED_CMDS and "webbg" in ADMIN_EXEMPT_CMDS,
        "webbg 不在受保护表里（status 只读），但豁免表写了理由")
    # 默认页切换（landing）与 webbg 同理：status 只读不问口令，learn/game 就地校验。
    chk("landing" in INPLACE_ADMIN_CMDS and "landing" in SCRYPT_CMDS,
        "landing 已登记为就地校验 + 需要 scrypt")
    chk("landing" not in ADMIN_GUARDED_CMDS and "landing" in ADMIN_EXEMPT_CMDS,
        "landing 不在受保护表里（status 只读），但豁免表写了理由")
    # 契约：两份模式全文的首行标记必须逐字正确，否则 status 认不出当前模式。
    chk(LANDING_GAME.splitlines()[0] == "# landing-mode: game"
        and LANDING_LEARN.splitlines()[0] == "# landing-mode: learn",
        "landing 两份片段的首行模式标记与契约一致")
    # 秘密登录入口（gate-path）与 landing 同理：status 只读不问口令，set/rotate 就地校验。
    chk("gate-path" in INPLACE_ADMIN_CMDS and "gate-path" in SCRYPT_CMDS,
        "gate-path 已登记为就地校验 + 需要 scrypt")
    chk("gate-path" not in ADMIN_GUARDED_CMDS and "gate-path" in ADMIN_EXEMPT_CMDS,
        "gate-path 不在受保护表里（status 只读），但豁免表写了理由")
    # 契约：片段首行标记必须正好能被 gate_token() 读出来（写↔读同一个格式）。
    # 样例必须是 12 位以上 —— 否则这条 chk 会拿一个「新规则下不合法」的 token 去测。
    chk(gate_path_text("abc123def456").splitlines()[0] == "# gate-token: abc123def456",
        "gate-path 片段首行标记与 gate_token() 的读法一致")
    # 补一句 302（不是 301）：换 token 后老访客不该被浏览器缓存的永久跳转钉死在 404 上。
    chk("return 302 /gate/abc123def456/" in gate_path_text("abc123def456")
        and "return 301" not in gate_path_text("abc123def456"),
        "gate-path 片段用 302 补尾斜杠（不用会被永久缓存的 301）")
    # ★ token 是「拼进 nginx location 行」的字符串，形状校验必须是白名单，
    #   而且要真的挡住注入样本——只查正则写没写不算，要拿坏例子喂它。
    chk(all(not GATE_TOKEN_RE.fullmatch(bad) for bad in
            ("a" * 11, "a" * 33, "Abc123def456", "abc123def45}",
             "abc123def4\nlocation / {", 'ab"cdefghijkl', "", "abc_123def45")),
        "token 形状校验挡住注入样本（提前闭合 location、换行注入、引号、超长、不足 12 位）")
    chk(all(GATE_TOKEN_RE.fullmatch(good) for good in
            ("a" * 12, "ustc2026gate7", "a" * 32, secrets.token_hex(6))),
        "token 形状校验放过合法样本（12~32 位小写字母数字，含 rotate 的实际产物）")
    bypass = [o for o in known if "skip" in o.lower() or o.startswith("--no-")]
    chk(not bypass, f"没有跳过校验的开关（发现 {bypass}）")

    # ★ 真正的行为断言：口令错必须**一个字节都不改**。
    #   只查集合不够——集合对了但调用顺序错了（先改文件再校验）照样是漏洞。
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        me = str(Path(__file__).resolve())

        def gm2(*args: str, stdin: str = ""):
            return subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), *args, "--admin-stdin"],
                                  input=stdin, capture_output=True, text=True)

        r = gm2("add", "--label", "x", "--password-stdin",
                stdin=SELFTEST_WRONG_PW + "\n" + "新密码够长了xyz-2026")
        chk(r.returncode != 0, "口令错 → 拒绝执行")
        chk(len(load_store(st)["entries"]) == 0, "口令错时密码表**一个字节都没变**")
        chk("未" in r.stderr and "执行" in r.stderr,
            "错误文案说清「未执行」，而不是含糊的「失败」")

        r = gm2("add", "--label", "x", "--password-stdin",
                stdin=SELFTEST_ADMIN_PW + "\n" + "新密码够长了xyz-2026")
        chk(r.returncode == 0 and len(load_store(st)["entries"]) == 1,
            "口令对 → 放行（同时把新密码也写了）")

        # ★ 非法 token 要在**任何**远端动作之前被挡下（这里没有服务器可连，
        #   跑到 SSH 只会超时/报错，看不到「被校验拦住」这个真实原因）。
        r = gm2("gate-path", "set", "bad;token")
        chk(r.returncode != 0 and "不合法" in (r.stderr + r.stdout),
            "gate-path set 的非法 token 被拒（防把 nginx 配置写坏）")

    info("add 的有效期：--hours 必须生效（曾静默忽略）")
    # 这个 bug 的表现极其隐蔽：`cms add --hours 6` **不报错**、也**不设有效期**，
    # 用户以为设了，实际是永久。根因是 cmd_add 里手写了一份 flag 清单、漏了 hours。
    # 所以这里两个方向都要断：给了生效、没给仍是永久。
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        me = str(Path(__file__).resolve())

        def add_with(extra: list[str]) -> dict:
            r = subprocess.run([sys.executable, me, *OFFLINE_ARG, "--state", str(st), "add",
                                "--label", "t", "--password-stdin", "--admin-stdin", *extra],
                               input=SELFTEST_ADMIN_PW + "\nexpiry-selftest-pw-2026\n",
                               capture_output=True, text=True)
            chk(r.returncode == 0, f"add {' '.join(extra) or '(无有效期参数)'} 执行成功")
            entries = load_store(st)["entries"]
            return entries[-1]

        e = add_with(["--hours", "1"])
        exp = e.get("expires_at")
        chk(exp is not None, "★ `add --hours 1` 真的写了 expires_at（不是 None）")
        if exp:
            t = datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            left = (t - datetime.now(timezone.utc)).total_seconds() / 3600.0
            chk(0.9 < left < 1.1, f"剩余时长约 1 小时（实测 {left:.3f}h）")

        e2 = add_with([])
        chk(e2.get("expires_at") is None, "★ 不给有效期参数时仍是「永久」（反向断言）")

        e3 = add_with(["--days", "0.5"])
        chk(e3.get("expires_at") is not None, "`add --days 0.5` 也生效（小数天数）")

    info("重复密码组：add 自动并组 / passwd 出组 / dupmark 手动补标")
    # 存量重复没法自动认出（条目里只有独立盐的哈希），所以「自动检测」只覆盖
    # 手里有明文的 add / passwd；组本身的判断就靠这三条路径把 dup 字段写对。
    with tempfile.TemporaryDirectory() as td:
        st = Path(td)
        save_store(st, empty_store())
        me = str(Path(__file__).resolve())

        def gm3(*args: str, stdin: str = "", pw_stdin: bool = True):
            argv = [sys.executable, me, *OFFLINE_ARG, "--state", str(st), *args, "--admin-stdin"]
            if pw_stdin:
                argv.append("--password-stdin")
            return subprocess.run(argv, input=stdin, capture_output=True, text=True)
        PW_A = "dup-selftest-alpha-2026"
        PW_B = "dup-selftest-beta-2026"
        ADM = SELFTEST_ADMIN_PW + "\n"
        r = gm3("add", "--label", "d1", stdin=ADM + PW_A + "\n")
        chk(r.returncode == 0, "add d1 执行成功")
        d1 = load_store(st)["entries"][0]
        chk(d1.get("dup") is None, "首条无重复 → 不写 dup")

        r = gm3("add", "--label", "d2", stdin=ADM + PW_A + "\n")
        chk(r.returncode == 0 and "相同" in r.stdout, "add 同密码第二条 → 执行成功并提示「相同」")
        ents = {e["label"]: e for e in load_store(st)["entries"]}
        chk(ents["d1"].get("dup") == ents["d2"].get("dup") == ents["d1"]["id"],
            "两条进了同一组，锚 = 最早成员（d1），且锚自身也带 dup")
        chk("d1" in r.stdout and "d2" in r.stdout, "提示里列出组内全部条目")

        d2_id = ents["d2"]["id"]
        r = gm3("passwd", d2_id, stdin=ADM + PW_B + "\n")
        ents = {e["label"]: e for e in load_store(st)["entries"]}
        chk(r.returncode == 0 and ents["d2"].get("dup") is None and ents["d1"].get("dup") is not None,
            "轮换出新密码 → 该条目出组（dup 移除），原组保留")

        r = gm3("dupmark", ents["d1"]["id"], ents["d2"]["id"], stdin=ADM + "\n", pw_stdin=False)
        ents = {e["label"]: e for e in load_store(st)["entries"]}
        chk(r.returncode == 0 and ents["d1"].get("dup") == ents["d2"].get("dup"),
            "dupmark 手动把两条标回同一组")
        chk(ents["d1"]["dup"] == ents["d1"]["id"], "dupmark 锚取最早成员")

        r = gm3("dupmark", "--clear", ents["d2"]["id"], stdin=ADM + "\n", pw_stdin=False)
        ents = {e["label"]: e for e in load_store(st)["entries"]}
        chk(r.returncode == 0 and ents["d2"].get("dup") is None, "dupmark --clear 移出重复组")

        r = gm3("dupmark", ents["d2"]["id"], stdin=ADM + "\n", pw_stdin=False)
        chk(r.returncode != 0, "dupmark 只给一个 id → 拒绝（组至少要两条）")

    info("表格对齐（CJK 按 2 列计，否则表头与数据行会错位）")
    chk(disp_width("abc") == 3 and disp_width("标签") == 4 and disp_width("成功/失败") == 9,
        "disp_width 认得出全角字符")
    chk(pad("标签", 10) == "标签" + " " * 6, "按显示宽度补齐（占 4 列 → 补 6 空格）")
    chk(pad("abcdefghijk", 4) == "abcdefghijk", "超宽列不截断（只是不补空格）")
    chk(iso_to_local("2026-10-15T17:37:56Z") == iso_to_local("2026-10-15T17:37:56+00:00"),
        "UTC 串与 +00:00 等价")
    chk(iso_to_local("乱七八糟") == "乱七八糟", "无法解析的时间原样返回，不抛异常")

    # ★ 这组断言是 2026-10-16 补的：`usage` 把东八区的时间整整少显示 8 小时，
    #   而当时那条断言只查 `len(...) == 19` —— 长度对、值错，照样通过。
    #   **只断言长度不断言数值，等于没断言。**
    #   真实 bug：`_usage_cells` 先 `[:19]` 把结尾的 "Z" 切掉再换算，
    #   于是 iso_to_local 认不出是 UTC、原样返回 —— 显示成 06:45（UTC 原值），
    #   真实本地时间其实是 14:45。看起来"像一份正常的本地时间"，最难发现。
    _off = (datetime.now().astimezone().utcoffset() or timedelta(0)).total_seconds() / 3600
    _rec = {"ts": "2026-01-02T06:45:26Z", "reason": "bad_password", "pwid": None,
            "label": "", "ip": "1.2.3.4", "os": "macOS", "device": "Mac",
            "created_at": "2026-01-02T06:00:00Z", "expires_at": "2026-01-02T20:00:00Z"}
    _shown = _usage_cells(_rec, utc=False)[0]
    _utc = datetime.strptime(_rec["ts"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    _got = datetime.strptime(_shown, "%Y-%m-%d %H:%M:%S")
    chk(abs((_got - _utc.replace(tzinfo=None)).total_seconds() / 3600 - _off) < 1e-6,
        f"usage 的本地时间真的加了时区偏移（{_shown}，偏移 {_off:+.0f}h）")
    chk(_usage_cells(_rec, utc=True)[0] == "2026-01-02 06:45:26",
        "`--utc` 原样给存储值、且用空格分隔（与相邻列一致）")
    chk("T" not in entry_expiry_text({"expires_at": "2026-01-02T20:00:00Z"}, utc=True),
        "有效期列在 --utc 下也不用 T 分隔")
    chk(entry_expiry_text({"expires_at": "2026-01-02T20:00:00Z"}, utc=False).endswith("04:00:00"),
        "有效期本地时间跨天也对（20:00Z +8h = 次日 04:00）")
    pw = sum(ENTRY_COLS) + len(ENTRY_COLS) - 1
    hdr = " ".join(pad(h, w) for h, w in zip(("id", "标签", "状态", "有效期", "最近使用",
                                             "成功/失败"), ENTRY_COLS))
    chk(disp_width(hdr) == pw, "表头宽度与列定义一致")
    samples = (
        ("短中文标签", {"id": "7adadbc64d18", "label": "给小明", "created_at": "2026-10-15T17:37:56Z"}, "备注汉字"),
        ("刚好占满的标签", {"id": "ab12", "label": "team-member-01",
                            "created_at": "2026-10-15T17:37:56Z"}, "beta"),
        ("空标签", {"id": "ab12"}, "x"),
        ("无创建时间", {"id": "ab12", "label": "bob"}, "beta tester"),
        ("已禁用", {"id": "ab12", "label": "bob", "enabled": False}, "n"),
        ("已过期", {"id": "ab12", "label": "bob", "expires_at": "2020-01-01T00:00:00Z"}, "n"),
    )
    for what, ent, note in samples:
        row = fmt_entry_line(dict(ent, note=note), {})
        body = row[: len(row) - 1 - len(note)]        # 去掉「空格 + 备注」尾巴
        chk(disp_width(body) == pw and row.endswith(" " + note),
            f"数据行与表头对齐（{what}）")
    # 超宽单元格（如 64 字符标签）**不截断**——宁可这一行挤一点，也不隐藏用户填的信息。
    wide = fmt_entry_line({"id": "ab12", "label": "L" * 40, "note": "n"}, {})
    chk(wide.count("L") == 40 and disp_width(wide[: len(wide) - 2]) == pw + 40 - ENTRY_COLS[1],
        "超宽标签不截断（整行变宽，信息不丢）")

    info("网页背景图（撤下 / 恢复 / 换新图）")
    # 白图本身：存在、非空、而且**小得离谱**（纯色压缩后只有几十字节）。
    # 用「小于 4 KB」当判据而不是去解码像素——解码要 PIL，而 selftest 不该有额外依赖；
    # 而一张真照片压到 q75 也有几十 KB，4 KB 这条线不可能误判。
    for kind in ("webp", "jpg"):
        f = WEBBG_BLANK_DIR / f"blank.{kind}"
        chk(f.exists() and f.stat().st_size > 0, f"白底图 blank.{kind} 在（{f.name}）")
        chk(f.exists() and f.stat().st_size < 4096,
            f"blank.{kind} 小于 4 KB（{f.stat().st_size if f.exists() else '-'} 字节）→ 真的是纯色")
    # 备份目录必须在网站根目录**之外**：放在里面等于没撤（wget 照样拿得到）
    chk(not DEFAULT_WEB_ROOT.startswith(DEFAULT_REMOTE_DIR + "/")
        and not DEFAULT_REMOTE_DIR.startswith(DEFAULT_WEB_ROOT + "/"),
        f"私藏目录 {DEFAULT_REMOTE_DIR}/webbg 在网站根目录 {DEFAULT_WEB_ROOT} 之外")
    # 部署脚本的 REMOTE_DIR 必须与 CLI 默认一致：改脚本忘了改 CLI，背景图就会
    # 推进一个没人访问的目录，而且**看起来完全成功**（scp 不报错）
    dep = Path(__file__).resolve().parent.parent / "scripts" / "web" / "deploy-web.sh"
    m = re.search(r'REMOTE_DIR="([^"]+)"', dep.read_text(encoding="utf-8")) if dep.exists() else None
    chk(m is not None and m.group(1) == DEFAULT_WEB_ROOT,
        "deploy-web.sh 的 REMOTE_DIR 与 CLI 的 --web-root 一致"
        + (f"（脚本={m.group(1) if m else '?'} CLI={DEFAULT_WEB_ROOT}）" if m else "（读不到脚本）"))
    # 换的这两个路径，必须正是**前端真正在用**的那两个
    root = Path(__file__).resolve().parent.parent / "web"
    tss = (root / "ts" / "renderer.ts").read_text(encoding="utf-8")
    csss = (root / "gate" / "gate.css").read_text(encoding="utf-8")
    chk("assets/bg.webp" in tss,
        "游戏画布确实在用 assets/bg.webp（webbg 换的就是这张）")
    # ★ 2026-10-19：登录页**不再**引这张图。它是未授权商用素材，而登录页恰恰是
    #   给「还没有会话」的匿名访客看的 —— 继续当背景等于对公网分发原图。
    #   现在它是闸门内资源（匿名 404），登录页改用 CSS 渐变。
    chk("url('/assets/bg" not in csss and "gradient" in csss,
        "登录页 CSS 不引背景图、改用渐变（未授权素材不许对匿名访客显示）")
    chk("assets/bg.jpg" in tss, "老浏览器兜底仍指向 assets/bg.jpg")
    chk(set(WEBBG_FILES) == {"assets/bg.webp", "assets/bg.jpg"},
        f"WEBBG_FILES 正好是这两张（现在 {WEBBG_FILES}）")
    # ★ 解析器：远端输出是**行式文本**，格式一变就静默读成 None —— 这段最易错
    probe_txt = (
        "F assets/bg.webp 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef 81950 1757000000\n"
        "F assets/bg.jpg MISSING\n"
        'S {"mode": "off", "at": "2026-10-17T05:00:00Z"}\n'
        "B bg.webp,bg.jpg,\n"
    )
    pr = parse_webbg_probe(probe_txt)
    chk(pr["files"]["assets/bg.webp"] == {"present": True,
        "sha": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "size": 81950, "mtime": 1757000000},
        f"探针解析：sha/字节/mtime 都在（{pr['files'].get('assets/bg.webp')}）")
    chk(pr["files"]["assets/bg.jpg"] == {"present": False}, "探针解析：MISSING 也认得")
    chk(pr["state"].get("mode") == "off" and pr["backups"] == ["bg.webp", "bg.jpg"],
        f"探针解析：状态与备份列表（state={pr['state']} backups={pr['backups']}）")
    junk = parse_webbg_probe("S 这不是 JSON\nF 只有两个字段 x y\nB \n")
    chk(junk["state"] == {} and junk["backups"] == [], "探针解析：坏 JSON / 残缺行不炸")
    # ★ 漂移判定：monkeypatch 掉 ssh，纯离线验证（远端真的被 rsync 覆盖过）
    class _A2:
        state = Path(tempfile.mkdtemp())
        server = DEFAULT_SERVER
        ssh_port = DEFAULT_SSH_PORT
        remote_dir = DEFAULT_REMOTE_DIR
        web_root = DEFAULT_WEB_ROOT
    a2 = _A2()
    # ⚠️ 必须走 globals()：**在本函数里写 `webbg_probe = …` 会让 Python 把它
    # 当成局部变量**，于是连「读一下原值」都会抛 UnboundLocalError（第一版就这样，
    # selftest 一路绿到末尾才崩在这里）。同名全局只认 globals() 这一条路。
    g = globals()
    real_probe, real_shas = g["webbg_probe"], g["webbg_blank_shas"]
    try:
        g["webbg_blank_shas"] = lambda: {"webp": "AAA", "jpg": "BBB"}

        def stub(ret):
            g["webbg_probe"] = (lambda _a: ret)

        stub({"files": {"assets/bg.webp": {"present": True, "sha": "AAA", "size": 58}},
              "state": {"mode": "off"}, "backups": ["bg.webp", "bg.jpg"]})
        st = webbg_status(a2)
        chk(st["mode"] == "off" and st["is_blank"] and not st["drifted"],
            "off + 线上就是白图 → 不算漂移")
        stub({"files": {"assets/bg.webp": {"present": True, "sha": "ZZZ", "size": 81950}},
              "state": {"mode": "off"}, "backups": ["bg.webp", "bg.jpg"]})
        chk(webbg_status(a2)["drifted"], "off 但线上不是白图（被 rsync 部署覆盖）→ 报漂移")
        stub({"files": {"assets/bg.webp": {"present": True, "sha": "NEW", "size": 58}},
              "state": {"mode": "on", "webp_sha": "OLD"}, "backups": ["bg.webp"]})
        chk(webbg_status(a2)["drifted"], "on 但线上 sha 与记录不符 → 报漂移")
        stub({"files": {}, "state": {}, "backups": []})
        st = webbg_status(a2)
        chk(st["mode"] == "unknown" and not st["can_restore"],
            "从没操作过 → mode=unknown 且不能恢复")
        stub({"files": {}, "state": {}, "backups": ["bg.webp", "bg.jpg"]})
        chk(webbg_status(a2)["can_restore"], "私藏里有 bg.webp 才允许恢复")
        stub({"error": "ssh 拒绝连接", "files": {}, "state": {}, "backups": []})
        st = webbg_status(a2)
        chk(st["reachable"] is False and "拒绝连接" in st["error"],
            "ssh 失败要如实报「读不到」，不能当成「从没操作过」")
    finally:
        g["webbg_probe"] = real_probe
        g["webbg_blank_shas"] = real_shas

    info("解释器探测（macOS 自带的 /usr/bin/python3 是 LibreSSL，没有 hashlib.scrypt）")
    cands = python_candidates()
    chk(bool(cands), f"能找到支持 scrypt 的 Python（{len(cands)} 个：{'、'.join(cands[:3])}）")

    info("")
    if ok:
        info("selftest：全部通过")
    else:
        info("selftest：有失败项")
        sys.exit(1)


# --------------------------------------------------------------------------
def main() -> None:
    ap = argparse.ArgumentParser(
        prog="gate_manager.py",
        description="管理网页版的访问密码，并推送到服务器鉴权服务。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "示例：\n"
            f"  {prog()} init\n"
            f"  {prog()} add --label '给小明' --note '2026-10 内测'\n"
            f"  {prog()} add --password-stdin < 我的密码.txt\n"
            f"  {prog()} list\n"
            f"  {prog()} push\n"
            f"  {prog()} usage --remote\n"
            f"  {prog()} webbg status            # 背景图现状（只读）\n"
            f"  {prog()} webbg off               # 撤下背景图（纯白底，原图挪到非公开目录）\n"
            f"  {prog()} webbg push --image ~/图.png   # 转 webp 后上传并启用\n"
            f"  {prog()} landing status          # 看当前是开放站还是学习站（只读）\n"
            f"  {prog()} landing learn           # 学习站：/ → /learn/；游戏在 /game；其余 404\n"
            f"  {prog()} landing game            # 开放站：/ 与未定义路径都 302 到 /game\n"
            f"  {prog()} rm 7f3a9c2e4b1d\n"
            f"  {prog()} revoke-all          # 只打印后果，不动任何东西\n"
            f"  {prog()} revoke-all --yes    # 踢掉所有在线会话（含你自己）并直接推送\n"))
    ap.add_argument("--state", type=Path, default=DEFAULT_STATE,
                    help=f"本地数据目录（默认 {DEFAULT_STATE}）")
    ap.add_argument("--server", default=DEFAULT_SERVER,
                    help="SSH 目标（默认读 ~/.cmsdist/deploy.env 的 CMS_HOST）")
    ap.add_argument("--ssh-port", default=DEFAULT_SSH_PORT,
                    help="SSH 端口（默认读 ~/.cmsdist/deploy.env 的 CMS_SSH_PORT）")
    ap.add_argument("--remote-dir", default=DEFAULT_REMOTE_DIR, help=f"默认 {DEFAULT_REMOTE_DIR}")
    ap.add_argument("--web-root", default=DEFAULT_WEB_ROOT,
                    help=f"网站根目录（nginx 的 root，默认 {DEFAULT_WEB_ROOT}）；"
                         "必须与 deploy-web.sh 的 REMOTE_DIR 一致")
    ap.add_argument("--offline-admin-config", metavar="PATH",
                    help="【自检/测试专用】管理口令改从这份**本地** gateconfig 校验，"
                         "而不是服务器那份。它绕过的只是「凭据从哪来」，写操作仍会按 "
                         "--server 去连真实服务器，所以日常运维千万别加这个参数。"
                         "文件必须 0600 且属主是你自己。")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="初始化本地密码表").set_defaults(fn=cmd_init)

    p = sub.add_parser("add", help="新增一个密码（明文只显示一次）")
    p.add_argument("--label", help="标签，例如「给小明」")
    p.add_argument("--note", help="备注")
    p.add_argument("--len", type=int, default=24, help="随机密码长度（默认 24）")
    _add_pw_args(p)
    _add_expiry_args(p, "该密码 ")
    _add_admin_args(p)          # 管理口令（add）
    p.set_defaults(fn=cmd_add)

    p = sub.add_parser("list", help="列出所有有效密码")
    p.add_argument("--utc", action="store_true", help="时间按 UTC 显示（默认本地时间）")
    p.set_defaults(fn=cmd_list)

    p = sub.add_parser("show", help="看某条密码的详情与它自己的访问记录")
    p.add_argument("id")
    p.add_argument("--limit", type=int, default=20)
    p.add_argument("--utc", action="store_true")
    p.add_argument("--ua", action="store_true", help="附带完整 User-Agent")
    p.set_defaults(fn=cmd_show)

    p = sub.add_parser("disable", help="禁用某条密码（会话立即失效，记录保留）")
    p.add_argument("id")
    _add_admin_args(p)          # 管理口令（disable）
    p.set_defaults(fn=cmd_disable)

    p = sub.add_parser("enable", help="重新启用某条密码")
    p.add_argument("id")
    _add_admin_args(p)          # 管理口令（enable）
    p.set_defaults(fn=cmd_enable)

    p = sub.add_parser("expire", help="设置 / 清除某条密码的有效期")
    p.add_argument("id")
    _add_expiry_args(p, "")
    _add_admin_args(p)          # 管理口令（expire）
    p.set_defaults(fn=cmd_expire)

    p = sub.add_parser("rm", help="删除一个密码")
    p.add_argument("id")
    p.add_argument("--yes", action="store_true", help="跳过确认")
    _add_admin_args(p)          # 管理口令（rm）
    p.set_defaults(fn=cmd_rm)

    p = sub.add_parser("note", help="修改标签/备注")
    p.add_argument("id")
    p.add_argument("--label")
    p.add_argument("--note")
    _add_admin_args(p)          # 管理口令（note）
    p.set_defaults(fn=cmd_note)

    p = sub.add_parser("dupmark",
                       help="手动把几条密码标成同一重复组（存量重复自动检测认不出）")
    p.add_argument("ids", nargs="*", help="同一密码的全部条目 id（≥2 个）")
    p.add_argument("--clear", metavar="ID", help="把某条移出重复组")
    _add_admin_args(p)          # 管理口令（dupmark）
    p.set_defaults(fn=cmd_dupmark)

    p = sub.add_parser("passwd", help="轮换某条密码（旧会话失效）")
    p.add_argument("id")
    p.add_argument("--len", type=int, default=24)
    _add_pw_args(p)
    _add_admin_args(p)          # 管理口令（passwd）
    p.set_defaults(fn=cmd_passwd)

    p = sub.add_parser("revoke-all",
                       help="强制退登：踢掉所有在线会话（**包括你自己**），默认顺手推送")
    p.add_argument("--yes", action="store_true", help="确认执行（不加则只打印后果、什么都不做）")
    p.add_argument("--no-push", dest="no_push", action="store_true",
                   help="只提升本地 gen，不推送（仍需 --yes）")
    _add_admin_args(p)          # 管理口令（revoke-all）
    p.set_defaults(fn=cmd_revoke_all)

    p = sub.add_parser("usage", help="查看访问记录（时间 / 结果 / 密码 / IP / 浏览器 / 设备）")
    p.add_argument("--remote", action="store_true", help="先从服务器拉取")
    p.add_argument("--id", help="只看某条密码")
    p.add_argument("--limit", type=int, default=50)
    p.add_argument("--utc", action="store_true", help="时间按 UTC 显示（默认本地时间）")
    p.add_argument("--ua", action="store_true", help="附带完整 User-Agent")
    p.set_defaults(fn=cmd_usage)

    p = sub.add_parser("push", help="推送密码表到服务器")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument("--force", action="store_true", help="允许推送空表 / 跳过 sha 相同判断")
    _add_admin_args(p)          # 管理口令（push）
    p.set_defaults(fn=cmd_push)

    p = sub.add_parser("pull", help="从服务器拉回密码表（覆盖式，会先警告）")
    p.add_argument("--force", action="store_true",
                   help="确实要丢弃本地未推送的改动、以服务器为准")
    _add_admin_args(p)          # 管理口令（pull）
    p.set_defaults(fn=cmd_pull)
    sub.add_parser("selftest", help="自检（无副作用）").set_defaults(fn=cmd_selftest)

    p = sub.add_parser("gate", help="总开关：网站访问是否需要密码")
    p.add_argument("action", choices=("status", "on", "off"),
                   help="status 只看状态；on 需要密码才能访问；off 任何人可直接访问")
    p.add_argument("--password-stdin", action="store_true",
                   help="管理口令从 stdin 读（脚本化；否则交互式隐藏输入）")
    _add_argv_pw_guard(p)
    p.set_defaults(fn=cmd_gate)

    p = sub.add_parser("admin-init", help="首次设置管理口令（切换闸门时校验）")
    p.add_argument("--password-stdin", action="store_true")
    p.add_argument("--force", action="store_true", help="覆盖已存在的管理口令")
    _add_argv_pw_guard(p)
    p.set_defaults(fn=cmd_admin_init)

    p = sub.add_parser("admin-passwd", help="更换管理口令")
    p.add_argument("--password-stdin", action="store_true")
    _add_argv_pw_guard(p)
    p.set_defaults(fn=cmd_admin_passwd)

    # 网页背景图。status 只读；on/off/push 要管理口令（cmd_webbg 里就地校验）。
    p = sub.add_parser("webbg", help="网页背景图：撤下 / 恢复 / 换新图（版权未授权时要能一键白底）")
    p.add_argument("action", choices=("status", "on", "off", "push"),
                   help="status 只看现状；off 撤下成白底；on 恢复；push 推一张新图")
    p.add_argument("--image", help="push 用：本地图片路径（png / jpg / webp 都行，会转成 webp + jpg）")
    p.add_argument("--icon",
                   help="push 用：**裁剪好的方形图标**（png）。给了就用它做桌面端图标；"
                        "不给则从背景图居中裁（可能裁偏）。界面勾了 mac/win 时一定会给")
    p.add_argument("--desktop", action="store_true",
                   help="push 时**两端都**更新并重新打包（等价于同时给 --mac 与 --win）")
    p.add_argument("--mac", action="store_true",
                   help="push 时只更新 mac 端：换背景 + 重建图标 + 重打包 .app/zip/dmg")
    p.add_argument("--win", action="store_true",
                   help="push 时只更新 win 端：换背景 + 重新打包（图标必须重编进 exe）")
    p.add_argument("--no-rebuild", dest="no_rebuild", action="store_true",
                   help="只换文件、**不重新打包**（快，但 dmg 背景与 win 的 exe 图标"
                        "会是旧的；mac 的 .app 会顺手重签，否则改过内容会失签）")
    p.add_argument("--json", action="store_true", help="status 输出 JSON（给界面读）")
    _add_admin_args(p)          # 管理口令（on / off / push）
    p.set_defaults(fn=cmd_webbg)

    # 站点默认页切换（Phase 3）。status 只读；learn/game 要管理口令（cmd_landing 里就地校验）。
    p = sub.add_parser("landing",
                       help="站点默认页：游戏 / 公开 C++ 学习站(/learn/) 之间切换（可回滚，不弄挂 nginx）")
    p.add_argument("action", choices=("status", "learn", "game"),
                   help="status 只看当前模式；learn 让 / 去 /learn/；game 让 / 与未定义路径都去 /game")
    p.add_argument("--json", action="store_true", help="status 输出一行 JSON（给界面读）")
    _add_admin_args(p)          # 管理口令（learn / game）
    p.set_defaults(fn=cmd_landing)

    # 秘密登录入口。status 只读；set/rotate 要管理口令（cmd_gate_path 里就地校验）。
    p = sub.add_parser("gate-path",
                       help="登录入口路径：/gate/<token>/ 的秘密网址——看现状 / 指定 / 轮换（可回滚，不弄挂 nginx）")
    p.add_argument("action", choices=("status", "set", "rotate"),
                   help="status 只看当前入口；set 指定一个 token；rotate 换一个随机的")
    p.add_argument("token", nargs="?",
                   help="set 用：12~32 位小写字母或数字（想随机换一个请用 rotate）")
    # token 走 stdin 的那条路是给界面用的：argv 对同机任意进程可见（`ps aux`），
    # 而 token 就是「谁能打开密码页」的唯一凭据，不该进 argv（2026-10-21 审计 ★8）。
    p.add_argument("--token-stdin", action="store_true",
                   help="set 用：token 从 stdin 读一行（给界面/脚本用，不进 argv）")
    p.add_argument("--json", action="store_true", help="status 输出一行 JSON（给界面读）")
    _add_admin_args(p)          # 管理口令（set / rotate）
    p.set_defaults(fn=cmd_gate_path)

    a = ap.parse_args()
    # ★ 先验「会进远端 shell 的参数」，再谈别的：万一有人把 --web-root 写成带引号的
    #   东西，那是一条 root 命令执行通道，必须在任何动作之前就拒掉（理由见函数注释）。
    _refuse_shell_unsafe_endpoints(a)
    if a.cmd in SCRYPT_CMDS:
        ensure_scrypt()          # macOS 自带的 python3 没有 scrypt，自动换解释器
    # ★ 顺序很重要，分三步：
    #   1) precheck —— 本地无害判断（"你还没加 --yes"）。放最前面，
    #      这样这类拒绝不会浪费用户输一遍口令，更不会让人误以为口令错了。
    #   2) require_admin —— 要真动手了才校验管理口令。
    #   3) 执行。
    #  写操作统一在 2) 校验，不要在各个 cmd_* 里各写一遍——
    #  漏一个就是一道没锁的门，而漏掉的门不会报错、只会静静失效。
    #  `gate` / `admin-init` / `admin-passwd` 各自有就地校验，理由见 ADMIN_EXEMPT_CMDS。
    if a.cmd in PRECHECK_CMDS:
        _run_precheck(a)
    if a.cmd in ADMIN_GUARDED_CMDS:
        require_admin(a, action=_ADMIN_ACTION_TEXT.get(a.cmd, a.cmd))
    a.fn(a)


if __name__ == "__main__":
    main()
