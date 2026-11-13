#!/usr/bin/env python3
"""check_invariants.py —— 把「安全修复不许被后来的改动悄悄绕过」变成可执行的断言。

为什么需要它
------------
图片闸门那类修复的失效方式很特别：**代码还在、测试还绿，但有人新加了一处
`loadFromFile`**，闸门就被绕过去了，而且没有任何报错。这类回归只能靠静态断言拦。

这些断言刻意写得「笨」（数出现次数、看有没有某句话），因为笨的断言不会自己出 bug。

用法：python3 tools/check_invariants.py        退出码 0 = 全部成立
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))


def read(p: str) -> str:
    return (ROOT / p).read_text(encoding="utf-8")


def strip_c_comments(src: str) -> str:
    """去掉 // 与 /* */ 注释（字符串字面量里的 // 不处理，本项目的路径里没有）。"""
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    out = []
    for line in src.split("\n"):
        idx = line.find("//")
        out.append(line[:idx] if idx >= 0 else line)
    return "\n".join(out)


# ── 1) 桌面端：解码只走 readWholeFile 一次读入 + loadFromMemory，不许再出现 loadFromFile ──
# 2026-10-22 起 loadImageChecked 改成「读一次字节、探同一份字节、解同一份字节」，
# 为的是堵住 probe 与 decode 之间换文件的 TOCTOU。留着 loadFromFile 就等于留下一条
# 「探的是 A、解的是 B」的旁路。
renderer = strip_c_comments(read("src/desktop/Renderer.cpp"))
n_load = renderer.count(".loadFromFile(")
check("Renderer.cpp 没有 .loadFromFile(（统一走 readWholeFile + loadFromMemory）",
      n_load == 0, f"实际 {n_load} 处")

fn_start = renderer.find("bool Renderer::loadImageChecked")
fn_end = renderer.find("\n}\n", fn_start) if fn_start >= 0 else -1
check("loadImageChecked 存在", fn_start >= 0)
if fn_start >= 0 and fn_end > fn_start:
    body = renderer[fn_start:fn_end]
    check("loadImageChecked 用 imgprobe::readWholeFile 单次读入", "imgprobe::readWholeFile" in body)
    check("loadImageChecked 解的是同一份字节（loadFromMemory）",
          ".loadFromMemory(" in body and "loadFromFile" not in body,
          "探一份、解另一份 → TOCTOU")

# ── 2) 三个加载入口都调闸门 ──
for fn in ("loadMarkerImageFromFile", "loadBlankImageFromFile", "loadBackgroundFromFile"):
    body_start = renderer.find(f"bool Renderer::{fn}(")
    ok = False
    if body_start >= 0:
        body = renderer[body_start : body_start + 900]
        ok = "loadImageChecked(" in body
    check(f"{fn} 调用了 loadImageChecked", ok)

# ── 3) 导入路径过闸 + 软链 ──
settings_io = strip_c_comments(read("src/desktop/SettingsIO.cpp"))
imp = settings_io.find("std::string importImage(")
imp_body = settings_io[imp : imp + 2000] if imp >= 0 else ""
check("importImage 用 imgprobe::probeFile", "imgprobe::probeFile" in imp_body)
check("importImage 落盘前摘软链", "is_symlink" in imp_body)
probe_h = read("src/desktop/ImageProbe.h")
check("probeFile 用 symlink_status（不跟随链接）", "symlink_status" in probe_h)
check("probeFile 检查 is_symlink", "is_symlink" in probe_h)
check("readWholeFile 也只读一次、并在同一份字节上 probe",
      "readWholeFile" in probe_h and "probeMemory(std::span<const std::uint8_t>" in probe_h)
check(
    "ImageProbe 的读取都先过 has()",
    probe_h.count("detail::has(") + probe_h.count("has(n,") >= 5,
)
# ifstream::read 需要 uint8_t* → char*，那是合法的；真正要禁的是「把字节缓冲区
# 当成多字节整数指针来读」那种类型双关（未对齐 + 严格别名双重 UB）。
_bad_casts = re.findall(r"reinterpret_cast<\s*(?!char\s*\*)[^>]*>", probe_h)
check("ImageProbe 不做类型双关式 reinterpret_cast", not _bad_casts, str(_bad_casts[:3]))

# ── 4) settings.ini 有尺寸上限 ──
check("settings.ini 有界读取", "kMaxSettingsBytes" in settings_io and "find_last_of" in settings_io)

# ── 5) safeImageName 挡 Windows 盘符 ──
san = settings_io[settings_io.find("bool safeImageName(") :][:1600]
check("safeImageName 拒绝 ':'（Windows 盘符相对路径）", "case ':'" in san)
check("safeImageName 拒绝 Windows 设备名", "CON" in san and "LPT" in san)

# ── 6) 三端 JSON 空白判据都存在 ──
seed_h = read("src/core/Seed.h")
codec_ts = read("web/ts/seedcodec.ts")
base_cpp = read("tools/base.cpp")
check("Seed.h 有 jsonWs 且被 jsonFieldEquals 使用", "inline bool jsonWs" in seed_h and "jsonWs(json[i])" in seed_h)
check("seedcodec.ts 有 isJsonWs 且被使用", "isJsonWs" in codec_ts and "isJsonWs(json[i])" in codec_ts)
check("base.cpp 有 jsonWs 且被使用", "jsonWs" in base_cpp and "jsonWs(json[i])" in base_cpp)

# ── 6b) 两端种子解析契约必须一致（2026-10-22 安全审计 P11）──
# 背景：桌面端此前是手写扫描器（"9.5" 回退默认值 9），网页端是 JSON.parse（给 NaN）
#      → 同一颗种子串在两端解出不同棋盘，排行榜回放校验的地基就塌了。
# 现在两端统一为 fail-closed 契约：字段存在但非法 → 整条拒收。
# 这里钉死的是「不许再退回手写扫描器」和「两端都做有限整数检查」两件事；
# 具体行为一致性由 web/test/seed-parse-parity.mjs 逐字节对拍负责。
seedjson_h = read("src/core/SeedJson.h")
seedparse_cpp = read("tools/seedparse.cpp")
seedparse_mjs = read("web/test/seed-parse-parity.mjs")

check("Seed.h 引入 SeedJson.h（桌面端改用真 JSON 解析器）",
      '#include "SeedJson.h"' in seed_h)
check("桌面端不再有手写扫描器 seedJsonField/seedJsonIntClamped/seedJsonStringArray",
      not re.search(r"inline\s+.*\bseedJsonField\s*\(", seed_h)
      and "seedJsonIntClamped" not in seed_h
      and "seedJsonStringArray" not in seed_h)
check("桌面端数字字段做有限性+整数性检查（fail-closed，不产 NaN）",
      "std::isfinite" in seed_h and "std::floor" in seed_h)
check("网页端数字字段做 Number.isFinite+Number.isInteger 检查",
      "Number.isFinite" in codec_ts and "Number.isInteger" in codec_ts)
check("两端 rngSeed 上限同值（0xFFFFFFFF / 4294967295）",
      "kRngSeedMax = 4294967295LL" in seed_h
      and "K_RNG_SEED_MAX = 4294967295" in codec_ts)
check("网页端 seedFromJson 已导出（供对拍测试直接调用）",
      "export function seedFromJson" in codec_ts)
check("跨端解析对拍闸门存在（tools/seedparse.cpp + web/test/seed-parse-parity.mjs）",
      "seedFromJson" in seedparse_cpp and "seedFromJson" in seedparse_mjs)
check("对拍两侧都有程序化用例生成器（不手写 JSON 字面量，防漏 ']'）",
      "nineRows" in seedparse_cpp and "nineRows" in seedparse_mjs)
check("CMakeLists.txt 有 seedparse 目标（对拍闸门可被构建）",
      "add_executable(seedparse" in read("CMakeLists.txt"))

# ── 6c) rngSeed 落地宽度（2026-11-02）──
# 背景：seedJsonIntField 的 out 写死 int，`static_cast<int>(double)` 对 ≥2^31 的值是
#      **饱和**（结果 2147483647）而不是回绕。区间检查用 long long 拦不住这一步，于是
#      桌面端把约一半的盘解成另一张盘，网页端（JS number）解的是对的那张。
seed_h_code = strip_c_comments(seed_h)
sig = re.search(r"template\s*<\s*typename\s+T\s*>\s*\n?\s*inline bool seedJsonIntField\s*\(([^)]*)\)",
                seed_h_code)
check("Seed.h 的 seedJsonIntField 按 out 类型模板化（不再固定 int&）",
      sig is not None and "T& out" in sig.group(1) and "int& out" not in sig.group(1),
      sig.group(1)[:60] if sig else "没匹配到带 template 的定义")
check("桌面端两个 rngSeed 解析点都用 std::uint32_t 接收（Seed.h + Renderer.cpp）",
      "std::uint32_t rng = 0;" in seed_h_code and "std::uint32_t rng = 0;" in renderer)
check("两个解析点都不许再出现 int rng（会饱和到 INT_MAX）",
      "int rng = 0;" not in seed_h_code and "int rng = 0;" not in renderer)
# 对拍表两侧的行序是逐字节比对的前提，且 ≥2^31 那三条必须两边都有
cpp_ids = [int(x) for x in re.findall(r"push_back\(\{(\d+),", seedparse_cpp)]
mjs_ids = [int(x) for x in re.findall(r"^\s*\[(\d+),", seedparse_mjs, flags=re.M)]
check("对拍用例表两侧 id 序列逐条相同（改一条要同时改两边）",
      cpp_ids == mjs_ids and len(cpp_ids) >= 30,
      f"cpp={len(cpp_ids)} 条 / mjs={len(mjs_ids)} 条")
for _v in ("2147483648", "3556999816", "4294967295"):
    check(f"对拍表覆盖 rngSeed ≥ 2^31 的宽度用例（{_v}）",
          _v in seedparse_cpp and _v in seedparse_mjs)

# ── 7) 网页端 ──
settings_ts = read("web/ts/settings.ts")
check("settings.ts 有 isSafeImageSrc", "export function isSafeImageSrc" in settings_ts)
check(
    "loadSettings 的背景/marker 都过白名单",
    settings_ts.count("isSafeImageSrc(") >= 3,
    "至少要覆盖 background + mk() + loadImage",
)

learn = read("web/learn/app.js")
check("learn esc() 转义双引号", '&quot;' in learn)
check("learn hashId() 有 try/catch", re.search(r"try \{[^}]*decodeURIComponent", learn) is not None)
check("learn route() 用 hasOwnProperty", "hasOwnProperty.call(byId" in learn)

gate = read("web/gate/gate.js")
check("gate MSG 是无原型对象", "Object.create(null)" in gate)
check("gate 不再整份 JSON.parse 设置", "JSON.parse(raw)" not in gate)

# ── 8) 学习站内容里不许出现可执行标签/事件属性 ──
bad_pages: list[str] = []
for p in sorted((ROOT / "web/learn/pages").glob("*.js")):
    t = p.read_text(encoding="utf-8")
    for pat in ("<script", "<iframe", "srcdoc", "javascript:"):
        if pat in t:
            bad_pages.append(f"{p.name}:{pat}")
    if re.search(r"\son[a-z]+\s*=", t):
        bad_pages.append(f"{p.name}: on*=")
check("learn/pages/*.js 无危险标签/事件属性", not bad_pages, ", ".join(bad_pages[:4]))

# ── 9) 秘密入口的日志面：token 只能走「不落盘」这一条路（2026-10-22）──
# access_log off 只关了一半：error_log 不受它影响，limit_req 的 429 与「文件不存在」的
# open() 失败都会以 error 级把**完整 URI** 写进去。所以两个渲染器的入口块必须同时关两边。
dw_src = read("scripts/web/deploy-web.sh")
gm_src = read("tools/gate_manager.py")
hc_src = read("server/cmsgate-healthcheck.sh")


def _block(src: str, marker: str, span: int = 900) -> str:
    i = src.find(marker)
    return src[i : i + span] if i >= 0 else ""


for _label, _src, _marker in (
    ("gate_manager.gate_path_text", gm_src, "location ^~ /gate/{token}/"),
    ("deploy-web.sh 片段模板", dw_src, "location ^~ /gate/$TOK/"),
):
    _blk = _block(_src, _marker)
    check(f"{_label} 的入口块有 access_log off", "access_log off;" in _blk)
    check(f"{_label} 的入口块 error_log 不落盘", "error_log /dev/null crit;" in _blk)

_blk80 = _block(dw_src, "location ^~ /gate/ {")
check(
    "明文 80 的 /gate/ 块 access_log off + error_log 不落盘",
    "access_log off;" in _blk80 and "error_log /dev/null crit;" in _blk80,
)
check("部署自测扫全部 nginx 日志（access + error、含 .1/.gz）",
      "count_tok_hits" in dw_src and "/var/log/nginx/error.log" in dw_src)
check("部署自测把 token 日志增量作为硬断言（增量非 0 即失败）",
      "n_log_after" in dw_src and "n_log_before" in dw_src)

# curl 的 URL 不许拼进 argv：/proc/<pid>/cmdline 对所有本地账户可读（无 hidepid）
_bad_curl = [
    l.strip()
    for l in hc_src.splitlines()
    if re.search(r'curl[^"\n]*"[^"\n]*gate/\$\{?TOK', l)
]
check("健康检查的 curl 不把 token 拼进 argv", not _bad_curl, str(_bad_curl[:2]))
check("健康检查用 curl -K - 从 stdin 收 URL", hc_src.count("-K -") >= 2)

# ── 11b) 跑分客户端的 RAM 读数口径（2026-11-03）──
# Windows 没有 resource 模块：任务结束那行「本任务solver峰值RAM」必须走客户端自己记下的
# _peak。原先它直接调 resource.getrusage → AttributeError 被函数尾的 except 吞成 n/a，
# 于是 Windows 用户只剩一个实时数，读起来像「客户端在漏内存」。
dc_raw = read("tools/dist_client.py")
dc_src = strip_c_comments(dc_raw)
_i = dc_src.find("def child_rss_mb")
_fn = dc_src[_i:dc_src.find("\ndef ", _i + 10)] if _i >= 0 else ""
check("dist_client 的两条实时读数分支都往 _peak 记最大值（PSAPI + ps）",
      _fn.count('_peak["kb"] = max(') == 2, _fn.count('_peak["kb"] = max('))
check("dist_client 在没有 resource 模块时走 _peak，且在碰 getrusage 之前判（Windows 峰值不再 n/a）",
      "if resource is None:" in _fn
      and (_fn.index("if resource is None:") < _fn.index("resource.getrusage")))
check("dist_client 面板与收尾两处 RAM 文案都点明「本任务 / solver 进程」",
      "本任务solver RAM" in dc_raw and "本任务solver峰值RAM" in dc_raw)

# ── 12) 散热番茄钟（2026-11-03，用户提「跑分机太烫」）──
# 三条不许被改坏的边界：① 休息只落在局与局之间（跨局停 = 客户端判「solver 提前结束」整任务作废）
# ② 休息行不是局（进了 records 就局数超标，服务器按「records 数量不符」400 拒收）
# ③ 传给 solver 之前先探它认不认 --pomodoro（旧包不认 → 用法退出 → 0 局 → 作废 → 再领，空转烧队列）
sv12 = strip_c_comments(read("tools/solver.cpp"))
check("solver 的休息只在局间：最后一局算完直接 return，不再歇",
      "g + 1 >= games) return;" in sv12
      and "pomodoroRest(g, games, jsonl," in sv12)
check("solver 计的是「真在算」的时长：够阈值才歇、歇完清零（否则歇完立刻又够 = 歇到天荒地老）",
      "g_pomo.activeMs += gameMs;" in sv12
      and "g_pomo.activeMs >= g_pomo.workSec * 1000LL" in sv12
      and "g_pomo.activeMs = 0;" in sv12)
check("solver 侧 --pomodoro 写错要吭声并退出非 0（静默当没开，用户会以为机器在歇）",
      'a == "--pomodoro"' in sv12 and "if (!setPomodoro(argv[i + 1]))" in sv12
      and sv12.index('a == "--pomodoro"') < sv12.index("if (!setPomodoro(argv[i + 1]))")
      and "printf(\"--pomodoro 格式" in sv12.split("if (!setPomodoro(argv[i + 1]))", 1)[1][:400])
# 两端各写一份时长解析，最容易烂在「裸数字算什么」这种小地方：solver 当分钟、客户端当秒，
# 客户端就会把 25/5 归一成 25s/5s 转过去，歇的时间跟用户写的差 60 倍。
check("solver 与 dist_client 对「裸数字=分钟」口径一致（两端各一份解析）",
      "if (hasNum) total += num * 60;" in sv12 and "total += num * 60" in dc_raw)
_dc12 = strip_c_comments(dc_raw)
_seg12 = _dc12.split('if "summary" in obj:', 1)[-1]
check("dist_client 在 records.append 之前拦下休息行（局数一超，整任务被服务器拒收）",
      '"rest" in obj' in _seg12 and _seg12.index('"rest" in obj') < _seg12.index("records.append(obj)"))
check("dist_client 先探 solver 认不认番茄钟两个参数，不认就降级并说出来",
      "def probe_pomodoro(" in _dc12 and "pomo_ok = probe_pomodoro(solver)" in _dc12
      and "if not pomo_ok:" in _dc12)
check("dist_client 的 ETA 与面板都认休息：歇掉的秒数从「本局已跑」里扣走",
      'ran -= st["rest_sec"]' in _dc12 and "休息一下 剩余" in _dc12)

# ── 13) 调度番茄钟（2026-11-03 用户改口径：番茄钟要管「分配任务」，不只管单机散热）──
# 语义：服务器按墙上时钟算全局相位；到点 ① 不再发新任务 ② 已领的在**局与局之间**睡到这段结束。
# 最容易烂的三处：① 相位算术三份拷贝走歪；② 休息期误写成 state 落盘（本来为省 CPU 才节流）；
# ③ 客户端把服务器的 anchor 当本机时钟用（没对时的机器会多歇/少歇十分钟）。
ds13 = read("tools/dist_server.py")
check("调度番茄钟的相位是纯函数（无 timer/cron/守护线程），重启后仍按同一墙上时钟",
      "def pomo_phase(cfg, now=None):" in ds13
      and "threading.Timer" not in ds13 and "POMO_CRON" not in ds13)
check("服务端/客户端/solver 三份相位算术同式：pos = (now-anchor) % cycle，pos >= work 才算歇",
      "int((now - a) // (w + r)) * (w + r)" in ds13 and "(now - cs) >= w" in ds13
      and "pos = d % cycle_sec" in _dc12 and "pos >= work_sec" in _dc12
      and "d % g_sched.cycleSec" in sv12 and "pos >= g_sched.workSec" in sv12)
check("三份算术都把「本机钟快过服务器」当连算，不做负数取模（负数取模=在别的语言里会误判成歇）",
      "if d < 0:" in _dc12 and "if (d < 0) d = 0;" in sv12 and "if now < a:" in ds13)
check("客户端把 anchor 换算到本机时钟域再下发（服务器 anchor 直接用 = 没对时的机器错开相位）",
      "a + (time.time() - sn)" in _dc12
      and '"server_now"' in _dc12 and '"server_now"' in ds13)
check("/claim 的休息段拒发走「手动暂停」同一条不写盘分支（别为纯相位判定落一次 state.json）",
      'if cfg.get("paused") or (ph and ph["in_rest"]):' in ds13
      and ds13.index('if cfg.get("paused") or (ph and ph["in_rest"]):')
      < ds13.index('"reason": "manual" if cfg.get("paused") else "pomodoro"'))
check("/claim 成功时把相位随任务下发（正在跑的那单才知道什么时候该睡）",
      '"pomo": pomo_wire(cfg)' in ds13 and '"pomo": pomo_wire' in ds13
      and "task.get(\"pomo\")" in _dc12)
check("客户端只在探测确认 solver 认参数后才追加 --pomodoro-phase（半支持=用法退出=整任务作废）",
      'argv += ["--pomodoro-phase", pomo_phase_arg(st["phase"])]' in _dc12
      and _dc12.index("if pomo_ok:")
      < _dc12.index('argv += ["--pomodoro-phase"'))
check("solver 的 --pomodoro-phase 读不懂当场退出非 0（静默当没开，机器不歇而屏上说要歇）",
      'a == "--pomodoro-phase"' in sv12 and "if (!setSchedPhase(argv[i + 1]))" in sv12
      and sv12.index('a == "--pomodoro-phase"') < sv12.index("if (!setSchedPhase(argv[i + 1]))"))
check("相位参数三整数（anchor:连算:整轮）两端同式：客户端拼的正是 solver sscanf 的",
      'return f"{int(a)}:{w}:{c}"' in _dc12 and '"%lld:%lld:%lld"' in sv12)
check("休息期文案：番茄钟的暂停说「休息一下」，只有管理员手动暂停才说「暂停发放」",
      ("散热休息中" not in _dc12
       and 'if task.get("reason") == "pomodoro":' in _dc12
       and _dc12.index('if task.get("reason") == "pomodoro":')
       < _dc12.index('print("⏸ 服务器已暂停发放'))
       and "☕ 休息一下，还剩" in _dc12
       and "☕ 休息一下 剩余" in _dc12)

# ctlui 上「休息段不发任务」以前只有表单末尾一行小灰字，管理员扫一眼看不见，
# 也不知道几点恢复。三处标志 + 钟点；置灰只认休息段——手动暂停时那个按钮是唯一的恢复入口。
_aj13 = read("tools/ctlui/app.js")
_ui13 = read("tools/ctlui/index.html")
check("ctlui 休息段三处明显标志（顶部一格 + 队列卡黄条 + 暂停按钮置灰），给钟点不只给倒计时，"
      "且置灰只认休息段（手动暂停时按钮必须还能点）",
      'id="c-pomo"' in _ui13 and 'id="pomo-banner"' in _ui13 and "rest-banner" in _ui13
      and "btn.disabled = rest && !PAUSED" in _aj13 and "let PAUSED = false" in _aj13
      and "const pomoClock = " in _aj13 and "${due} 恢复发放" in _aj13)


# ── 14) 客户端身份：solver 指纹只是一半（2026-11-03 用户指出「求解器版本和客户端版本不是一个东西」）──
# 更新是**逐文件**换的：Windows 上 solver.exe 正被十个进程用着就换不动，于是「新客户端 + 老求解器」
# 这种半更新在只看 solver_ver 的看板上完全隐形。所以两个身份各报一半、并且**成对**展示。
dc14 = read("tools/dist_client.py")
ds14 = read("tools/dist_server.py")
dt14 = read("tools/distctl.py")
cu14 = read("tools/ctl_ui.py")
aj14 = read("tools/ctlui/app.js")
ui14 = read("tools/ctlui/index.html")

check("客户端身份与 manifest 同口径：onefile 哈希 sys.executable，免安装包哈希自身那个 .py",
      'sys.executable if _upd_mode() == "onefile"' in dc14
      and "os.path.realpath(__file__)" in dc14 and dc14.count("def client_ver()") == 1)
check("身份读不到就留空 = 看板上的「未上报」，绝不编一个哈希充数",
      '_CLIENT_VER = ""' in dc14)
check("两个身份都随 /claim 与 /result 上报（只报一处 = 交完结果就查不到这批数据是谁算的）",
      dc14.count('"client_ver": client_ver()') == 2
      and ds14.count('client_ver = str(data.get("client_ver", ""))[:16]') == 2)
check("服务端两个投影都带上 client_ver（漏一个 = 界面那一列永远「未上报」）",
      '"client_ver": v.get("client_ver", "")' in ds14
      and '"client_ver"' in ds14.split("DONE_UI_KEYS = (", 1)[1].split(")", 1)[0])
check("看板按「求解器 · 客户端」成对聚合，不拆两行（拆着看半更新会被藏起来）",
      "t.client_ver || UNKNOWN" in aj14 and "${chip(sv)} · ${chip(cv)}" in aj14
      and "每格是「求解器 · 客户端」" in aj14)
check("五张表都有「客户端」列（三张数据表 + 两张版本历史表），且进行中的组行 colspan 跟着 +1",
      ui14.count(">客户端</th>") == 5 and aj14.count('colspan="8"') == 2
      and "t.client_ver" in aj14 and "r.client_ver" in aj14)
check("「已发布」的客户端是三份（每平台一份程序字节），不挑一份代表全部",
      "CLIENT_MANIFEST_KEYS" in cu14 and "def _published_client_vers()" in cu14
      and "Object.entries(m).map" in aj14)
check("distctl status 同一行报两个身份（终端里只看求解器会漏掉半更新）",
      "线上在跑: " in dt14 and 't.get("client_ver")' in dt14
      and "求解器 {s} + 客户端 {c} ×{n} 终端" in dt14)
check("版本历史两个身份**共用一条时间线**：收录条件是「任一身份变了」，去重也按这一对",
      'CLIENT_VER_PATH = "tools/dist_client.py"' in cu14
      and "*SOLVER_VER_PATHS, CLIENT_VER_PATH" in cu14
      and '(keep[-1]["ver"], keep[-1]["client"]) != (e["ver"], e["client"])' in cu14
      and "e.ver === cur && e.client === curClient" in aj14)
check("客户端自己那一屏也两个身份都报（启动横幅 + 面板 Seed 行）：本机排查不必先去翻服务器",
      'f"（{solver_ver}）"' in dc14 and "客户端 {client_ver() or '未知'}" in dc14
      and 'f"  solver {solver_ver}"' in dc14 and 'f"  client {cv}"' in dc14)


# ── 输出 ──
failed = [c for c in checks if not c[1]]
for name, ok, detail in checks:
    if not ok:
        print(f"  ✗ {name}" + (f" —— {detail}" if detail else ""))
print(f"invariants: {len(checks)} checks, {len(failed)} failed")
sys.exit(0 if not failed else 1)
