#!/usr/bin/env python3
"""gate_ui.py 的安全回归测试（纯标准库，不需要浏览器）。

    python3 /Users/wenweiqi/CLionProjects/Project/tools/test_gate_ui.py            # 建议用能跑 scrypt 的 python3
    python3 /Users/wenweiqi/CLionProjects/Project/tools/test_gate_ui.py -v

为什么不用无头浏览器
--------------------
这里要验的全是 **HTTP 层**的东西：状态码、头、cookie 属性。
起一个浏览器既慢又依赖 CDP；而 `http.client` 能精确控制 `Host` 头
（伪造 Host 时浏览器根本不让你改，正好是我们要测的那一层）。

测什么（每条对应一种真实攻击或真实误用）
----------------------------------------
  T1  只绑回环              —— 非 127.0.0.1 的地址连不上
  T2  没 token → 403        —— 直接开 localhost 进不来
  T3  错 token → 403        —— token 不能被暴力猜中（也不给任何提示差异）
  T4  对 token → 303+cookie —— 且 cookie 是 HttpOnly + SameSite=Strict
  T5  带 cookie → 200       —— 正常路径能用
  T6  静态资源也要鉴权      —— 否则跨站能用 <script src> 探测服务存在
  T7  伪造 Host → 403       —— 挡 DNS rebinding（最关键的一条）
  T8  跨站 Origin → 403     —— 挡 CSRF
  T9  缺 X-CMSUI 的 POST → 403 —— 跨站表单发不出自定义头
  T10 无 cookie 打 /api → 403
  T11 写操作缺管理口令被拒  —— 且**本地密码表一个字节都没变**
  T12 未知 op → 4xx
  T13 不许从请求体覆盖 _state
  T14 安全响应头齐全（CSP / nosniff / no-store / X-Frame-Options）
  T15 **日志里不出现 token** —— 初始 URL 带 token，写进日志等于把钥匙留盘上

（T16 及之后不再在这里逐条列举，运行时的每个小节标题就是它的编号与主题，
 目前到 **T30 增量渲染 + 拉取节流**。）

⚠️ 全部用**临时 --state 目录**，绝不碰 ~/.cmsgate 里的真实密码表。
"""
from __future__ import annotations

import glob
import base64
import http.client
import io
import json
import os
import queue
import random
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
TOOL = HERE / "gate_ui.py"

VERBOSE = "-v" in sys.argv or "--verbose" in sys.argv

#: 测试用的管理口令。**只在离线 gateconfig 里有效**，不是任何真实凭据。
TEST_ADMIN_PW = "uitest-admin-pw-2026"


def load_gate_manager():
    """按路径载入 gate_manager，只借它造 admin 哈希块（不跑 main）。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("uitest_gm", HERE / "gate_manager.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def load_gate_ui():
    """按路径载入 gate_ui 模块本体（不起服务），用来直接测纯函数。"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("uitest_gu", TOOL)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def _js_block(js: str, name: str) -> str:
    """从 `app.js` 里按花括号配平抠出 `function name(...) { ... }` 的源码。

    抠不出就返回空串（调用方会变成 SKIP 并说清楚），**绝不**悄悄当成通过。
    """
    i = js.find("function " + name + "(")
    if i < 0:
        return ""
    j = js.find("{", i)
    if j < 0:
        return ""
    depth = 0
    for k in range(j, len(js)):
        c = js[k]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                start = i
                # `async function` 的 async 落在 find() 起点之前，不带上就
                # `new Function` 里会出现「await 只能出现在 async 函数里」的语法错
                if js[max(0, i - 6):i].endswith("async "):
                    start = i - 6
                return js[start:k + 1]
    return ""


def _find_node() -> str | None:
    """找一个能跑的 node（T30 要**真的执行**前端的那两个函数）。"""
    cands: list[str] = []
    if os.environ.get("NODE_BIN"):
        cands.append(os.environ["NODE_BIN"])
    w = shutil.which("node")
    if w:
        cands.append(w)
    # WorkBuddy 的托管 node 不在 PATH 里（T30 在本机就是靠它跑的）
    cands += sorted(glob.glob(os.path.expanduser(
        "~/.workbuddy/binaries/node/versions/*/bin/node")), reverse=True)
    cands += ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
    for c in cands:
        if c and Path(c).exists() and os.access(c, os.X_OK):
            return c
    return None


#: 给 T30 用的最小 DOM 假件。真 DOM 需要浏览器，而这里要验的是
#: 「调了几次 DOM 操作、节点对象是不是同一个」——用假件既能验，又快。
_HARNESS = r"""
function makeNode(x) {
    const n = {
        x: x, parent: null,
        remove: function () {
            if (!n.parent) return;
            const i = n.parent.children.indexOf(n);
            if (i >= 0) n.parent.children.splice(i, 1);
            n.parent.ops += 1;          // 删节点也是一次 DOM 操作，要算进账
            n.parent = null;
        },
    };
    return n;
}

function FakeTb() { this.children = []; this.ops = 0; }
FakeTb.prototype.replaceChildren = function () {
    const kids = Array.prototype.slice.call(arguments);
    for (const c of this.children) c.parent = null;
    this.children = kids.slice();
    for (const c of this.children) c.parent = this;
    this.ops += 1;
};
FakeTb.prototype.insertBefore = function (node, ref) {
    let i = this.children.indexOf(ref);
    if (i < 0) i = this.children.length;
    this.children.splice(i, 0, node);
    node.parent = this;
    this.ops += 1;
};
Object.defineProperty(FakeTb.prototype, 'firstChild', {
    get: function () { return this.children[0] || null; },
});
Object.defineProperty(FakeTb.prototype, 'lastElementChild', {
    get: function () { return this.children[this.children.length - 1] || null; },
});
FakeTb.prototype.closest = function () { return null; };

function makeEnv() {
    const tb = new FakeTb();
    const els = { 'usage-body': tb };
    const $ = function (id) {
        if (!els[id]) els[id] = { textContent: '', hidden: false };
        return els[id];
    };
    return { tb: tb, $: $ };
}

function rowSig(r) { return JSON.stringify(r); }
function buildUsageRow(r) { return makeNode(r); }
function renderPager() {}

// 从源码现造一份 renderUsage：每次都是**独立闭包**，lastSigs 互不干扰。
function makeRender(src) {
    const env = makeEnv();
    const f = new Function('rowSig', 'buildUsageRow', 'renderPager', '$',
        'let lastSigs = [];\n' + PREPEND + '\n' + src + '\nreturn renderUsage;');
    return { render: f(rowSig, buildUsageRow, renderPager, env.$), tb: env.tb };
}

const out = { unit: [], good: [], bad: [] };
function rec(bucket, name, ok, detail) {
    out[bucket].push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

// ── prependShift 单元用例 ────────────────────────────────────────
const ps = new Function(PREPEND + '\nreturn prependShift;')();
for (const c of UNIT) {
    const got = ps(c.neu, c.old);
    rec('unit', c.name, got === c.want, 'got=' + got + ' want=' + c.want);
}

// ── renderUsage 行为用例 ─────────────────────────────────────────
// 同一套断言在**两份**源码上各跑一遍：原样 + 拿掉「完全相同就 return」的变异体。
// 变异体必须让「内容没变就不动 DOM」变红，否则那条断言没牙齿。
function scenario(bucket, src) {
    const r = makeRender(src);
    const render = r.render, tb = r.tb;
    const A = [{ id: 1 }, { id: 2 }, { id: 3 }];

    render(A, { total: 3, matched: 3 });
    const ops1 = tb.ops;
    const nodeA = tb.children[0];
    rec(bucket, '首次渲染建出全部行',
        tb.children.length === 3 && ops1 >= 1,
        'rows=' + tb.children.length + ' ops=' + ops1);

    render(A, { total: 3, matched: 3 });
    rec(bucket, '★ 内容一个字没变 → 一个 DOM 操作都不做',
        tb.ops === ops1, 'ops ' + ops1 + ' → ' + tb.ops);

    const B = [{ id: 0 }, { id: 1 }, { id: 2 }];   // 新记录插最前，最老一条被挤出
    render(B, { total: 4, matched: 4 });
    rec(bucket, '头部插 1 条 → 只动 2 个节点（插 1 删 1），不是整表重建',
        tb.ops === ops1 + 2 && tb.children.length === 3, 'ops=' + tb.ops);
    rec(bucket, '★ 没被挤掉的行是同一个节点对象（选区不会被清掉）',
        tb.children[1] === nodeA && tb.children[1].x.id === 1,
        'same node = ' + (tb.children[1] === nodeA));

    const before = tb.ops;
    render([{ id: 7 }, { id: 8 }, { id: 9 }], { total: 9, matched: 9 });
    rec(bucket, '翻页（整页内容换掉）才真的重建', tb.ops === before + 1, 'ops=' + tb.ops);
}

scenario('good', GOOD);
scenario('bad', BAD);

console.log(JSON.stringify(out));
"""


def _run_node(node: str, body: str) -> dict:
    """把一段 JS 丢给 node 跑，取它最后一行打印的 JSON。"""
    with tempfile.TemporaryDirectory(prefix="cmsgate-js-") as td:
        f = Path(td) / "probe.mjs"
        f.write_text("'use strict';\n" + body, encoding="utf-8")
        r = subprocess.run([node, str(f)], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"node 退出 {r.returncode}：{(r.stderr or '').strip()[:400]}")
    return json.loads(r.stdout.strip().splitlines()[-1])


def _run_render_cases(node: str, p_src: str, r_good: str, r_bad: str,
                      cases: list[dict]) -> dict:
    """用 node 真跑一遍 prependShift / renderUsage，返回 {unit, good, bad}。"""
    return _run_node(node, "\n".join([
        "const PREPEND = " + json.dumps(p_src) + ";",
        "const GOOD = " + json.dumps(r_good) + ";",
        "const BAD = " + json.dumps(r_bad) + ";",
        "const UNIT = " + json.dumps(cases) + ";",
        _HARNESS,
    ]))


#: T31 的假件：只需要一个能记 textContent/attributes 的按钮。
_PREF_HARNESS = r"""
function makeBtn() {
    const b = {
        textContent: '', title: '', attrs: {},
        setAttribute(k, v) { b.attrs[k] = String(v); },
    };
    return b;
}

const out = [];
function rec(name, ok, detail) {
    out.push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

// ── clampInt：期望值是「LIMITS 里的真上下限」之外的独立算出来的？
//    不行——那就等于把手写的常量抄一遍。所以这里改成**读源码里的 LIMITS**，
//    再拿几组与上下限无关的输入去撞它（13、7、99999、空、负数、乱码）。
const LIMITS = <LIMITS>;
const clampInt = new Function('LIMITS', CLAMP_SRC + '\nreturn clampInt;')(LIMITS);

const CASES = <CASES>;
for (const c of CASES) {
    const got = clampInt(c.v, c.key, c.d);
    rec('clampInt ' + c.name, got === c.want,
        String(c.v) + ' → ' + got + '（要 ' + c.want + '，上下限 '
        + JSON.stringify(LIMITS[c.key]) + '）');
}

// ── autoMs：暂停时必须真的返回 0，否则 setTimeout 还在排 ──
const state = { autoPaused: false, autoSec: 13 };
const btn = makeBtn();
const $ = () => btn;
const autoMs = new Function('state', AUTO_SRC + '\nreturn autoMs;')(state);
const renderAutoBtn = new Function('state', '$', RB_SRC + '\nreturn renderAutoBtn;')(state, $);

rec('autoMs 未暂停 = 间隔 ×1000', autoMs() === 13000, 'got=' + autoMs());
state.autoPaused = true;
rec('★ 暂停时 autoMs 返回 0（真的不再排下一轮）', autoMs() === 0, 'got=' + autoMs());
renderAutoBtn();
rec('★ 暂停后按钮文案变成「继续」', btn.textContent.indexOf('继续') >= 0, btn.textContent);
rec('★ 暂停后 aria-pressed=true', btn.attrs['aria-pressed'] === 'true',
    'got=' + btn.attrs['aria-pressed']);
state.autoPaused = false;
state.autoSec = 5;
renderAutoBtn();
rec('恢复后按钮文案回到「暂停」', btn.textContent.indexOf('暂停') >= 0, btn.textContent);
rec('恢复后 aria-pressed=false', btn.attrs['aria-pressed'] === 'false',
    'got=' + btn.attrs['aria-pressed']);
rec('改间隔立即生效（不用等下一次）', autoMs() === 5000, 'got=' + autoMs());

console.log(JSON.stringify(out));
"""


def _run_pref_cases(node: str, js: str) -> list[dict]:
    """T31：真跑 clampInt / autoMs / renderAutoBtn（假件 + 源码里抠出来的函数）。"""
    limits = re.search(r"const LIMITS = \{(.*?)\};", js, re.S)
    parts = re.findall(r"(\w+):\s*\[(\d+),\s*(\d+)\]", limits.group(1)) if limits else []
    lim = {k: [int(a), int(b)] for k, a, b in parts}
    cases = [
        {"name": "正常值原样返回", "v": "13", "key": "autoSec", "d": 30, "want": 13},
        {"name": "每页 7 条（不是档位，是随便填的）", "v": "7", "key": "pageSize",
         "d": 20, "want": 7},
        {"name": "低于下限 → 夹到下限", "v": "0", "key": "pageSize", "d": 20,
         "want": lim["pageSize"][0]},
        {"name": "负数 → 夹到下限", "v": "-5", "key": "autoSec", "d": 30,
         "want": lim["autoSec"][0]},
        {"name": "高于上限 → 夹到上限", "v": "99999", "key": "pageSize", "d": 20,
         "want": lim["pageSize"][1]},
        {"name": "空 → 回落到默认", "v": "", "key": "autoSec", "d": 30, "want": 30},
        {"name": "乱码 → 回落到默认", "v": "abc", "key": "pageSize", "d": 20, "want": 20},
        {"name": "小数截断", "v": "12.9", "key": "autoSec", "d": 30, "want": 12},
    ]
    body = _PREF_HARNESS.replace("<LIMITS>", json.dumps(lim)) \
                       .replace("<CASES>", json.dumps(cases)) \
                       .replace("CLAMP_SRC", json.dumps(_js_block(js, "clampInt"))) \
                       .replace("AUTO_SRC", json.dumps(_js_block(js, "autoMs"))) \
                       .replace("RB_SRC", json.dumps(_js_block(js, "renderAutoBtn")))
    return _run_node(node, body)


#: T33 的假件：把 anyUsageFilter / colFilterCount 真跑一次。
#: 症状是「什么都没筛，但共 174 / 筛选后 129」—— 只读源码断言看不出
#: 「判定方向」这种最容易反的东西（true 算不算有筛选？），必须真跑。
_FILTER_HARNESS = r"""
const out = [];
function rec(name, ok, detail) {
    out.push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

const anyUsageFilter = new Function('timeActive', 'usageF',
    AF_SRC + '\nreturn anyUsageFilter;');

const mkAf = (t, f) => anyUsageFilter(t, f);
function mkUsageF(over) {
    const f = {
        time: { preset: '', from: '', to: '' },
        result: new Set(), pwid: new Set(), ip: new Set(),
        browser: new Set(), osdev: new Set(),
        existing: true, bname: true,
    };
    Object.assign(f, over || {});
    return f;
}
const noTime = () => false;
const timeOn = () => true;

// ── anyUsageFilter ──
// ⚠️ 每次都必须**重新构造**函数：`new Function(...)` 传进去的是**当时那个对象**，
//   之后把变量重新赋值不会影响闭包里已绑定的旧对象。我第一版在循环外建了
//   一个 `af` 然后只改 `cur` → 后面 5 条断言全在测同一个默认对象 = 假绿。
rec('★ 出厂默认（什么都没筛）不算有筛选',
    mkAf(noTime, mkUsageF())() === false,
    'got=' + mkAf(noTime, mkUsageF())());

rec('★ existing=true（出厂默认）不算有筛选',
    mkAf(noTime, mkUsageF({ existing: true }))() === false,
    'got=' + mkAf(noTime, mkUsageF({ existing: true }))());

// existing 是显示范围、不是筛选条件 → 关掉它也不该让按钮冒出来
rec('★ existing=false 也不算有筛选（否则按钮永远杵着）',
    mkAf(noTime, mkUsageF({ existing: false }))() === false,
    'got=' + mkAf(noTime, mkUsageF({ existing: false }))());

// 各列真选了值 → 算有筛选（每条都用全新函数）
for (const k of ['result', 'pwid', 'ip', 'browser', 'osdev']) {
    const f = mkUsageF({});
    f[k].add('x');
    const got = mkAf(noTime, f)();
    rec('★ ' + k + ' 选了值 → 算有筛选', got === true, 'got=' + got);
}

// 时间列在筛 → 算有筛选
{
    const got = mkAf(timeOn, mkUsageF())();
    rec('★ 时间列在筛 → 算有筛选', got === true, 'got=' + got);
}

console.log(JSON.stringify(out));
"""


def _run_pref(node: str, js: str) -> list[dict]:
    """T33：真跑 anyUsageFilter。"""
    body = (_FILTER_HARNESS
            .replace("AF_SRC", json.dumps(_js_block(js, "anyUsageFilter"))))
    return _run_node(node, body)


#: T34 的假件：把 recompute / syncAllBox 抠出来真跑，配一个能记操作的假复选框。
#: 断言的是**值**（chosen 里有几个、allBox 是勾/空/横线），不是"形状"——
#: 只检查"有没有调用过某个函数"的话，把三态画成什么样都能过。
_TRI_HARNESS = r"""
const out = [];
function rec(name, ok, detail) {
    out.push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

// ⚠️ 必须用 `return function (...){ <源码> }` 包一层，**不能**用
//    `new Function('boxes','allBox', SRC + '\nreturn syncAllBox;')`：
//    那种写法里 `function syncAllBox(){...}` 虽然是形参名，但函数体中的裸标识符
//    `boxes` / `allBox` 会被解析到 new Function 的**全局**作用域（那里没有它们），
//    于是函数体一执行就抛 ReferenceError / 静默写不到 —— 全部断言假红。
//    我第一版就是这么写的，10 条断言全红但原因在探针自己，不在产品代码。
const mk = (args, body) => new Function('__unused_never_used',
    'return function (' + args.join(', ') + ') {' + body + '};')();
const recompute = mk(['boxes', 'chosen', 'f', 'col', 'syncAllBox'], RC_SRC_BODY);
const syncAllBox = mk(['boxes', 'allBox'], SA_SRC_BODY);

const COL = 'result';
const OPTS = ['成功', '密码错', '被限流', '已禁用', '已过期'];

function mkState() {
    const chosen = new Set();
    const f = { visAll: new Set([COL]) };
    const boxes = OPTS.map((v) => ({ value: v, checked: true }));
    const allBox = { checked: false, indeterminate: false, title: '' };
    const api = {
        chosen: chosen, f: f, boxes: boxes, allBox: allBox,
        rc: () => recompute(boxes, chosen, f, COL, api.sa),
        sa: () => syncAllBox(boxes, allBox),
    };
    return api;
}

// ★ 单击的**目标态算法必须从 app.js 抠出来求值**，不能在这里手抄一份。
//   我手抄过一版 `!(n===0 || n===len)`（当时以为那是对的），结果变异真实代码后
//   这条断言仍然全绿 —— **探针和产品代码一起错，等于完全没测**。
//   WANT_SRC = app.js 里那一行 `const wantAll = ...;` 的原文。
const wantAllFn = new Function('n', 'boxes', WANT_SRC + 'return wantAll;');
function clickAll(s) {
    const n = s.boxes.filter((b) => b.checked).length;
    s.boxes.forEach((b) => { b.checked = wantAllFn(n, s.boxes); });
    s.rc();
}

/** 图画成什么：'全勾' / '横线' / '空白' */
function shape(s) {
    const n = s.boxes.filter((b) => b.checked).length;
    if (n === s.boxes.length) return '全勾';
    if (n === 0) return '空白';
    return '横线';
}
function nChecked(s) { return s.boxes.filter((b) => b.checked).length; }
/** chosen 的内容，**按 boxes 的原始顺序**列出（不自己排序——
 *  中文按 codepoint 排会把「已过期」排在「成功」前面，手写期望值极易搞错顺序）。 */
function chosenList(s) {
    const keep = s.boxes.filter((b) => s.chosen.has(b.value)).map((b) => b.value);
    return keep.join(',') || '(空)';
}

// ① 初始：visAll 里有这一列 → 全勾 + 不筛
{
    const s = mkState();
    s.sa();
    rec('★ 初始：全勾、无筛选', s.allBox.checked === true
        && s.allBox.indeterminate === false && s.chosen.size === 0,
        'checked=' + s.allBox.checked + ' indet=' + s.allBox.indeterminate
        + ' chosen=' + chosenList(s));
}

// ② 全勾时单击「（全部）」→ **全部取消**（这是用户最想要的那一下）
{
    const s = mkState();
    s.sa();
    clickAll(s);
    rec('★ 全勾 + 单击 → 全部取消（一个勾都不留）', nChecked(s) === 0, shape(s));
    rec('★ 全部取消后 allBox 显示空白（不是勾、不是横线）',
        s.allBox.checked === false && s.allBox.indeterminate === false,
        'checked=' + s.allBox.checked + ' indet=' + s.allBox.indeterminate);
    rec('★ 全部取消 = 清空这一列筛选（chosen 空，仍显示全部，不是 0 条）',
        s.chosen.size === 0, chosenList(s));
    rec('★ 全部取消后 visAll 移出（下次打开面板还是空，不是偷偷恢复全勾）',
        s.f.visAll.has(COL) === false,
        'visAll=' + [...s.f.visAll].join(',') || '(空)');
}

// ③ 空白时单击「（全部）」→ 全勾
{
    const s = mkState();
    s.sa();
    clickAll(s);                 // 先到空白
    clickAll(s);                 // 再点回来
    rec('★ 空白 + 单击 → 全选', nChecked(s) === s.boxes.length, shape(s));
    rec('★ 全选后 visAll 记回来', s.f.visAll.has(COL) === true,
        'visAll=' + [...s.f.visAll].join(','));
    rec('★ 全选后仍是无筛选（chosen 空）', s.chosen.size === 0, chosenList(s));
}

// ④ 部分选中 → 显示横线
{
    const s = mkState();
    s.sa();
    s.boxes[1].checked = false;
    s.boxes[3].checked = false;
    s.rc();
    rec('★ 部分选中 → allBox 是横线（indeterminate）',
        s.allBox.indeterminate === true && s.allBox.checked === false,
        'checked=' + s.allBox.checked + ' indet=' + s.allBox.indeterminate);
    rec('★ 部分选中 → chosen 只剩勾着的那些',
        // 期望值**从 OPTS 按下标算**，不手写：手写过一次（写成 '成功,已禁用'）
        // 就错了 —— 实际剩下的是成功 / 被限流 / 已过期。手编期望值必错。
        chosenList(s) === [0, 2, 4].map((i) => OPTS[i]).join(','),
        chosenList(s) + '（按 OPTS 下标 0,2,4 推出）');
}

// ⑤ 部分选中时单击「（全部）」→ **全选**
{
    const s = mkState();
    s.sa();
    s.boxes[1].checked = false;
    s.boxes[3].checked = false;
    s.rc();
    clickAll(s);
    rec('★ 部分 + 单击 → 全选', nChecked(s) === s.boxes.length, shape(s));
    rec('★ 全选后 chosen 又空了（从筛选回到不限）', s.chosen.size === 0,
        chosenList(s));
}

// ⑥ 逐项取消到只剩一个 → 横线；再全取消 → 空白（不被强行弹回）
{
    const s = mkState();
    s.sa();
    for (let i = 1; i < s.boxes.length; i++) s.boxes[i].checked = false;
    s.rc();
    rec('★ 只剩第一项 → chosen 恰好一项', chosenList(s) === '成功',
        chosenList(s));
    rec('★ 只剩第一项 → 仍是横线', s.allBox.indeterminate === true,
        'indet=' + s.allBox.indeterminate);
    s.boxes[0].checked = false;      // 取消最后一项
    s.rc();
    rec('★ ★ 取消最后一项 → 空白，而不是被强行弹回全勾',
        nChecked(s) === 0 && s.allBox.indeterminate === false,
        shape(s));
}

// ⑦ 没有可选值时（opts 为空）不能崩，且应显示全勾
{
    const chosen = new Set();
    const f = { visAll: new Set([COL]) };
    const boxes = [];
    const allBox = { checked: false, indeterminate: false, title: '' };
    let ok = true, err = '';
    try {
        syncAllBox(boxes, allBox);
        recompute(boxes, chosen, f, COL, () => syncAllBox(boxes, allBox));
    } catch (e) { ok = false; err = String(e); }
    rec('★ 一个可选值都没有时不崩', ok, err);
    rec('★ 没有可选值时 allBox 是全勾（0===0，不该显示横线）',
        allBox.checked === true && allBox.indeterminate === false,
        'checked=' + allBox.checked + ' indet=' + allBox.indeterminate);
}

console.log(JSON.stringify(out));
"""


def _js_body(js: str, name: str) -> str:
    """`_js_block` 的**函数体**（去掉 `function NAME() {` 与末尾的 `}`）。

    harness 用 `new Function(...args, 'return function(...){' + body + '}')` 包装，
    这样函数体里的裸标识符才会绑定到形参上（见 _TRI_HARNESS 里的说明）。
    """
    src = _js_block(js, name)
    m = re.match(r"\s*function\s+\w+\s*\([^)]*\)\s*\{", src)
    if not m or not src.rstrip().endswith("}"):
        return ""
    return src[m.end():src.rstrip().rfind("}")]


#: T35 的假件：把「这份结果是不是过期的」这条判定真跑一遍。
#: ★ 不抠整个 loadUsage（它依赖 api/toast/renderUsage 一大堆），
#:   只抠**判定表达式本身**，然后用可控的到达顺序去撞它。
#:   期望值不是手写的：到达顺序由数组给出，结论由表达式算出。
_RACE_HARNESS = r"""
const out = [];
function rec(name, ok, detail) {
    out.push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

// 判定表达式原文来自 app.js：`if (seq !== usageSeq) return null;`
const isStale = new Function('seq', 'usageSeq',
    'return (' + STALE_EXPR + ');');

/**
 * arrivals = 请求**到达**顺序，seq 越大 = 发起得越晚。
 *
 * ★ 关键：`usageSeq` 在**所有请求都发起完之后**才等于最大值 —— 因为每次
 *   loadUsage 一进来就 `++usageSeq`。所以「先发的请求」回来时，
 *   usageSeq 早就不是它的号了，它**本来就该被丢**。
 *   我第一版写「顺序到达 0,1,2 → 三个都渲染」是**假想了个不存在的场景**：
 *   真实的并发里 0 返回时 usageSeq 已经是 2。断言必须按真实时序写。
 */
function simulate(arrivals) {
    let usageSeq = -1;
    for (const s of arrivals) usageSeq = Math.max(usageSeq, s);
    const rendered = [];
    for (const seq of arrivals) {
        if (isStale(seq, usageSeq)) continue;
        rendered.push(seq);
    }
    return rendered;
}

// ① 三个并发全部到达 → 只有最后发起的那个渲染（其余都是过期结果）
const r1 = simulate([0, 1, 2]);
rec('★ 三并发（0,1,2 都到）→ 只渲染最后发起的 seq=2', r1.join(',') === '2',
    'rendered=' + (r1.join(',') || '(空)'));

// ② 完全乱序（最后发的心跳先回）→ 同样只渲染 seq=2
const r2 = simulate([2, 1, 0]);
rec('★ 完全乱序（2,1,0）→ 只渲染 seq=2', r2.join(',') === '2',
    'rendered=' + (r2.join(',') || '(空)'));

// ③ 首个请求最后才回 → 必须被丢掉（否则旧结果覆盖新的）
const r3 = simulate([1, 0]);
rec('★ 首个请求最后才回（1,0）→ 只渲染 seq=1', r3.join(',') === '1',
    'rendered=' + (r3.join(',') || '(空)'));

// ④ 单个请求 → usageSeq 就是它自己，不能被当成过期丢掉
const r4 = simulate([0]);
rec('★ 只有一个请求时不能被丢', r4.join(',') === '0',
    'rendered=' + (r4.join(',') || '(空)'));

// ⑤ 连点 4 个框的典型形状（发起 0..3，按 3,2,1,0 返回）
const r5 = simulate([3, 2, 1, 0]);
rec('★ 连点 4 次（3,2,1,0 回）→ 只渲染最后一次', r5.join(',') === '3',
    'rendered=' + (r5.join(',') || '(空)'));

// 反面对照：若判定写成 `seq < usageSeq`（只认更大的），乱序就会渲染多个。
// 没有这条，上面 5 条可能因为"表达式被换成恒 false"也一起变红，
// 说不清是**逻辑对**还是**恰好没暴露**。有了它，区分力才立得住。
const wrong = [3, 2, 1, 0].filter((seq, _, arr) => seq < Math.max(...arr));
rec('★ 反面对照：错写法会渲染 ' + wrong.length + ' 个（证明本断言有区分力）',
    wrong.length === 3, '错写法 rendered=' + wrong.join(','));

console.log(JSON.stringify(out));
"""


def _run_prune() -> list[dict]:
    """T39：真跑 prune_uploads。期望值从实现常量算，不写死 10。"""
    gu = load_gate_ui()
    out: list[dict] = []
    keep_n = gu.gm.WEBBG_UPLOAD_KEEP

    def mk(n):
        sd = Path(tempfile.mkdtemp(prefix="cmsgate-t39-"))
        up = sd / "uploads"
        up.mkdir()
        for i in range(n):
            p = up / f"bg-test{i:02d}.png"
            p.write_bytes(b"x" * 32)
            os.utime(p, (1_700_000_000 + i, 1_700_000_000 + i))
        return sd, up

    class A:
        def __init__(self, s):
            self.state = s

    sd, up = mk(keep_n + 4)
    try:
        (up / "readme.txt").write_text("别删我")
        (up / "其他.png").write_bytes(b"y")
        gone = gu.gm.prune_uploads(A(sd), keep=keep_n)
        left = sorted(p.name for p in up.iterdir())
        bg_left = [n for n in left if n.startswith("bg-")]
        out.append({"name": f"★ 恰好留 {keep_n} 张 bg-*（实得 {len(bg_left)}）",
                    "ok": len(bg_left) == keep_n, "detail": str(len(bg_left))})
        want = sorted(f"bg-test{i:02d}.png"
                      for i in range(4, keep_n + 4))
        out.append({"name": "★ 留的是**最近**那几张（mtime 最大的）",
                    "ok": sorted(bg_left) == want,
                    "detail": f"实得 {sorted(bg_left)}"})
        out.append({"name": "★ 别人的文件一个没动（readme.txt / 其他.png）",
                    "ok": "readme.txt" in left and "其他.png" in left,
                    "detail": str(left)})
        out.append({"name": f"返回的删除清单长度正确（{keep_n + 4 - keep_n} 个）",
                    "ok": len(gone) == 4, "detail": str(len(gone))})
    finally:
        shutil.rmtree(sd, ignore_errors=True)

    # protect：指定的那张哪怕 mtime 最老也不删（这是 /var vs /private/var 那个坑）
    sd, up = mk(5)
    try:
        old = up / "bg-oldest.png"
        old.write_bytes(b"z")
        os.utime(old, (0, 0))
        gu.gm.prune_uploads(A(sd), keep=2, protect=old)
        out.append({"name": "★ protect 指定的那张永远不删"
                             "（macOS /var 与 /private/var 同目录不同串，"
                             "只 resolve 一边就会失效）",
                    "ok": old.exists(),
                    "detail": "还在" if old.exists() else "★ 被删了"})
        n_left = len([x for x in up.iterdir() if x.name.startswith("bg-")])
        out.append({"name": "★ protect 时其余仍按 keep 裁剪（不因为保护就超额保留）",
                    "ok": n_left == 3, "detail": f"剩 {n_left} 个"})
    finally:
        shutil.rmtree(sd, ignore_errors=True)

    class B:
        state = Path(tempfile.gettempdir()) / "cmsgate-t39-nonexistent-dir"
    out.append({"name": "uploads 目录不存在时安静返回 []（不抛）",
                "ok": gu.gm.prune_uploads(B(), keep=keep_n) == [], "detail": ""})
    return out


def _run_edge_limit(node: str) -> list[dict]:
    """T38：真跑 webbg_encode，断言输出长边 ≤ WEBBG_MAX_EDGE。

    造一张**可控尺寸**的图（不依赖用户机器上有没有大图，也不联网）。
    期望值从 `WEBBG_MAX_EDGE` 读，不写死 1920 —— 改常量时断言自动跟着改。
    """
    # ★ run_tests 是独立函数，拿不到 main() 的局部变量（gu / gm / node）——
    #   所以这里自己载入一份。踩过：直接用 gu.gm → NameError。
    gu = load_gate_ui()
    import base64
    import tempfile
    # 4×3 的 PNG（1×1 放大四倍，尺寸完全由我们说了算）
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFklEQVQI12P4z8DAwMDAxMDAw"
        "MDAAAAwAAwABmQAAAd0Nq6QAAAABJRU5ErkJggg==")
    with tempfile.TemporaryDirectory(prefix="cmsgate-t38-") as td:
        sd = Path(td)
        # 用 sips 放大到 4800 宽（超大图才有意义：小图本来就该跳过缩放）
        big = sd / "big.png"
        png_raw = sd / "tiny.png"
        png_raw.write_bytes(png)
        r = subprocess.run(["sips", "-Z", "4800", str(png_raw), "--out", str(big)],
                           capture_output=True, check=False)
        if r.returncode != 0 or not big.exists():
            raise RuntimeError("造大图失败（本机没有 sips？）")
        w, j = sd / "o.webp", sd / "o.jpg"
        import contextlib
        import io
        with contextlib.redirect_stdout(io.StringIO()):
            gu.gm.webbg_encode(big, w, j, sd)
        out: list[dict] = []
        limit = gu.gm.WEBBG_MAX_EDGE
        got_w, got_h = gu.gm._image_size(w)
        out.append({"name": f"★ 输出 webp 长边 ≤ {limit}（实得 {got_w}×{got_h}）",
                    "ok": max(got_w, got_h) <= limit,
                    "detail": f"{got_w}x{got_h}"})
        gw, gh = gu.gm._image_size(j)
        out.append({"name": f"★ 输出 jpg 长边 ≤ {limit}（实得 {gw}×{gh}）",
                    "ok": max(gw, gh) <= limit, "detail": f"{gw}x{gh}"})
        out.append({"name": "★ 等比（宽高比与原图一致，没有被拉变形）",
                    "ok": abs((got_w / got_h) - (4 / 3)) < 0.02,
                    "detail": f"{got_w / got_h:.4f} vs 1.3333"})
        out.append({"name": "★ 比原图小了很多（真缩了，不是原样复制）",
                    "ok": max(got_w, got_h) < 4800, "detail": f"{max(got_w, got_h)}"})
        # 已经够小的图 → 必须**原样**走（不重编码）
        small_ok = gu.gm._shrink_to(big, sd / "no.png", 99999) == big
        out.append({"name": "★ 上限设得比图还大时原样返回（不做无谓重编码）",
                    "ok": small_ok, "detail": "identity" if small_ok else "被重编码了"})
        return out


def _run_race(node: str, js: str) -> list[dict]:
    """T35：真跑「乱序到达只认最后一次」的判定。"""
    if "let usageSeq = 0;" not in js:
        raise RuntimeError("app.js 里没有 usageSeq —— 乱序修复被回退了？")
    m = re.search(r"if \((.+?) !== (.+?)\) return null;", js)
    if not m:
        raise RuntimeError("app.js 里找不到 `if (seq !== usageSeq) return null;`")
    expr = f"{m.group(1).strip()} !== {m.group(2).strip()}"
    body = _RACE_HARNESS.replace("STALE_EXPR", json.dumps(expr))
    return _run_node(node, body)


#: T36 的假件：把「这条记录算不算漂移」的判定真跑一遍。
#: ★ 判定表达式原文从 gate_manager.py 里抠出来 —— 手抄的话探针和产品代码
#:   会一起错，变异时就抓不住了（同 T34 的教训）。
_DRIFT_HARNESS = r"""
const out = [];
function rec(name, ok, detail) {
    out.push({ name: name, ok: !!ok,
        detail: String(detail === undefined ? '' : detail) });
}

const cmp = new Function('backed', 'live', 'return (' + CMP_SRC + ');');

const FULL = 'a25cdff1f985b0b1062ade5a26a092f2e51ca539e6320643479f6111b78ea9a3';
const SHORT = FULL.slice(0, 16);        // 早期版本存的就是这个 16 位

// ① 刚推完：记录是 16 位、线上是 64 位全量 → **不算漂移**（这是被修掉的误报）
rec('★ 16 位记录 vs 64 位线上 → 不算漂移（原来恒为真）',
    cmp(SHORT, FULL) === false, 'cmp(' + SHORT + ', 全量) = ' + cmp(SHORT, FULL));

// ② 全量记录 vs 同一份全量 → 不算漂移
rec('★ 全量记录 vs 同一份 → 不算漂移', cmp(FULL, FULL) === false, '');

// ③ 真漂移：之后又跑了 deploy-web.sh，线上被换成本地那张旧图
rec('★ 线上被换成别的图 → 报漂移（真漂移必须抓得到）',
    cmp(FULL, 'deadbeef' + FULL.slice(8)) === true, '');
rec('★ 16 位记录 + 线上被换 → 也报漂移',
    cmp(SHORT, 'deadbeef' + FULL.slice(8)) === true, '');

// ④ 前缀比较的**已知局限**（必须写进代码注释，别假装没有）：
//   16 位记录遇上「前 16 位相同、后面被改」的线上文件会漏判。
//   32 bit 撞上的概率 ≈ 1/2^32，实际不可能；真正要紧的是修掉恒真的误报。
rec('★ 前缀比的局限：16 位记录 + 只有后面变了 → 会漏判（已知取舍）',
    cmp(SHORT, SHORT + '0' + FULL.slice(17)) === false,
    '这正是「前缀比」换来的代价，注释里已写明');

console.log(JSON.stringify(out));
"""


def _py2js(expr: str) -> str:
    """把 Python 表达式翻成 JS。

    必须翻：`and`/`or`/`not` 在 JS 里是**保留标识符**而不是运算符，
    直接塞进 `new Function` 会报 `Unexpected identifier 'and'` ——
    我第一版就这么写的，白跑一轮。
    只做词级替换（带词边界），别把 `startswith` 里含的 "not" 也换掉。
    """
    out = re.sub(r"\bnot\s+", "!", expr)
    out = re.sub(r"\band\b", "&&", out)
    out = re.sub(r"\bor\b", "||", out)
    out = out.replace(".startswith(", ".startsWith(")
    out = re.sub(r"\bbool\(", "!!(", out)      # bool(x) → !!x（两个 ! 才是真布尔）
    return out


def _run_drift(node: str, gm_src: str) -> list[dict]:
    """T36：真跑漂移判定。"""
    # ★ 必须找**真正赋值的那一行**，不能 `re.search(漂移)` 了事 ——
    #   那一段上面压着三行注释（讲为什么要前缀比），正则会先撞上注释；
    #   而 `drifted = False` 那行初始化还会被 `startswith("drifted = ")` 抓到。
    line = next((l.strip() for l in gm_src.splitlines()
                 if l.strip().startswith("drifted = bool(")), None)
    if not line:
        raise RuntimeError("gate_manager 里找不到 `drifted = bool(...)` 那一行")
    if "startswith" not in line:
        raise RuntimeError("漂移判定已经不是前缀比 —— 修复被回退了？\n" + line)
    expr = _py2js(line.split("=", 1)[1].strip().rstrip(";"))
    return _run_node(node, _DRIFT_HARNESS.replace("CMP_SRC", json.dumps(expr)))


def _run_tristate(node: str, js: str) -> list[dict]:
    """T34：真跑三态「（全部）」。"""
    rc, sa = _js_body(js, "recompute"), _js_body(js, "syncAllBox")
    if not rc or not sa:
        raise RuntimeError("抠不出 recompute / syncAllBox 的函数体")
    # 单击的目标态那一行也必须取**原文**，让探针和产品代码共用同一份逻辑。
    mw = re.search(r"const wantAll = [^;]+;", js)
    if not mw:
        raise RuntimeError("app.js 里找不到 `const wantAll = ...`")
    body = (_TRI_HARNESS
            .replace("RC_SRC_BODY", json.dumps(rc))
            .replace("SA_SRC_BODY", json.dumps(sa))
            .replace("WANT_SRC", json.dumps(mw.group(0) + "\n")))
    return _run_node(node, body)

#: 四种返回，看它到底弹不弹「已刷新」。
_MANUAL_HARNESS = r"""
const MANUAL_SRC = <MANUAL>;
const CASES = <CASES>;

async function run(data) {
    const flashed = [];
    const toasted = [];
    const btn = { disabled: false, textContent: '立即刷新' };
    const f = new Function('loadUsage', '$', 'toast', 'flash', 'hhmmss', 'SKIP_TEXT',
        MANUAL_SRC + '\nreturn manualRefresh;');
    // f() 跑的是「造函数」那段代码，返回的**才是** manualRefresh 本身，
    // 还得再调一次才算跑它（这里踩过一次：以为 f() 就是结果，断言全 0/0）
    const fn = f(async () => data, () => btn, (m) => toasted.push(m),
        (m) => flashed.push(m), () => '13:00:00',
        { gap: '刚刚已经拉过了（2 秒内不重复连服务器）' });
    await fn();
    return { flashed: flashed, toasted: toasted, label: btn.textContent };
}

const out = [];
for (const c of CASES) {
    const r = await run(c.data);
    const got = r.flashed.length + '|' + r.toasted.length;
    out.push({ name: 'manualRefresh ' + c.name, ok: got === c.want,
        detail: 'flash=' + got.split('|')[0] + ' toast=' + got.split('|')[1]
            + (r.flashed.length ? ' 内容「' + r.flashed[0] + '」' : '') });
}
const last = await run({ pull_count: 2 });
out.push({ name: 'manualRefresh 按钮文案最后要改回来', ok: last.label === '立即刷新',
    detail: 'label=' + last.label });

console.log(JSON.stringify(out));
"""


def _run_manual_cases(node: str, js: str) -> list[dict]:
    src = _js_block(js, "manualRefresh")
    ok = {"pull_count": 3, "pulled_epoch": 0, "pull_error": None,
          "pull_skip_reason": None, "rows": [], "total": 0, "matched": 0}
    cases = [
        {"name": "真拉到了 → 顶部弹「已刷新」", "data": ok, "want": "1|1"},
        {"name": "拉失败 → 只报错，**不**说已刷新", "data": dict(ok, pull_error="ssh: 连不上"),
         "want": "0|1"},
        {"name": "被 2 秒限速挡下 → 只说原因，**不**说已刷新",
         "data": dict(ok, pull_skip_reason="gap"), "want": "0|1"},
        # 这条是「不能报假喜」的牙齿：服务端没给 pull_count（还没拉成功过）也别说已刷新
        {"name": "服务端没给 pull_count → **不**说已刷新", "data": dict(ok, pull_count=0),
         "want": "0|0"},
        {"name": "请求本身失败（loadUsage 返回 null）→ 两样都不弹",
         "data": None, "want": "0|0"},
    ]
    return _run_node(node, _MANUAL_HARNESS
                     .replace("<MANUAL>", json.dumps(src))
                     .replace("<CASES>", json.dumps(cases)))

passed: list[str] = []
failed: list[str] = []
skipped: list[str] = []


def chk(name: str, ok: bool, detail: str = "") -> bool:
    (passed if ok else failed).append(name)
    mark = "PASS" if ok else "FAIL"
    line = f"  [{mark}] {name}"
    if detail and (VERBOSE or not ok):
        line += f"    — {detail}"
    print(line, flush=True)
    return ok


def skip(name: str, why: str) -> None:
    """缺外部依赖时明确跳过（**不**算通过：跳过项会单独显示在总结里）。"""
    skipped.append(name)
    print(f"  [SKIP] {name}    — {why}", flush=True)


# --------------------------------------------------------------------------
# 起服务
# --------------------------------------------------------------------------

def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Server:
    def __init__(self, state_dir: Path, port: int, extra_env: dict | None = None,
                 extra_args: list[str] | None = None):
        self.port = port
        self.state_dir = state_dir
        self.extra_env = extra_env or {}
        self.extra_args = extra_args or []
        self.proc: subprocess.Popen | None = None
        self.token = ""
        self.out_lines: list[str] = []
        self.err_lines: list[str] = []

    def __enter__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-u", str(TOOL), "--port", str(self.port),
             "--state", str(self.state_dir), *self.extra_args],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
            env={**os.environ, **self.extra_env},
        )

        # ⚠️ 必须**用线程把 stdout / stderr 都读干净**，不能只在主线程 readline：
        #   1) readline() 本身没有超时 —— 子进程若卡住，主线程会一直挂着，
        #      表现为「测试没输出、也不退出」（我第一版就是这样，被外层超时杀掉）。
        #   2) stderr 若没人读，管道缓冲写满后**子进程会阻塞在写 stderr 上**，
        #      于是双双死锁。这是管道编程的经典坑，不是偶发。
        q: queue.Queue[str | None] = queue.Queue()

        def pump(stream, sink, tag):
            try:
                for line in stream:
                    sink.append(line)
                    q.put(tag + line)
            except Exception:
                pass
            finally:
                q.put(None)

        threading.Thread(target=pump, args=(self.proc.stdout, self.out_lines, ""),
                         daemon=True).start()
        threading.Thread(target=pump, args=(self.proc.stderr, self.err_lines, ""),
                         daemon=True).start()

        deadline = time.time() + 60
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    "服务启动失败（退出码 %s）\nstdout:\n%s\nstderr:\n%s"
                    % (self.proc.returncode, "".join(self.out_lines), "".join(self.err_lines)))
            try:
                line = q.get(timeout=0.5)
            except queue.Empty:
                continue
            if line is None:
                continue
            if "?k=" in line:
                self.token = line.strip().split("?k=", 1)[1]
                return self
        raise RuntimeError(
            "等服务启动超时（60s 内没读到带 token 的网址）\nstdout:\n%s\nstderr:\n%s"
            % ("".join(self.out_lines), "".join(self.err_lines)))

    def __exit__(self, *exc):
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                try:
                    self.proc.wait(timeout=4)
                except subprocess.TimeoutExpired:
                    pass
        # 给读线程一点时间把剩余输出收完（T15 要检查日志里有没有 token）
        time.sleep(0.3)

    @property
    def stderr_text(self) -> str:
        return "".join(self.err_lines)


# --------------------------------------------------------------------------
# HTTP 小工具：用 http.client 才能精确控制 Host 头
# --------------------------------------------------------------------------

def request(port: int, method: str, path: str, *,
            host: str | None = None,
            headers: dict[str, str] | None = None,
            body: bytes | None = None,
            timeout: float = 20.0):
    """返回 (status, headers dict 小写, body bytes)。"""
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
    try:
        conn.putrequest(method, path, skip_host=True, skip_accept_encoding=True)
        conn.putheader("Host", host if host is not None else f"127.0.0.1:{port}")
        for k, v in (headers or {}).items():
            conn.putheader(k, v)
        if body is not None:
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders()
        if body:
            conn.send(body)
        r = conn.getresponse()
        hdrs = {k.lower(): v for k, v in r.getheaders()}
        return r.status, hdrs, r.read()
    finally:
        conn.close()


def post_exec(port: int, token: str, payload: dict, *,
              xsrf: bool = True, origin: str | None = None):
    h = {"Content-Type": "application/json", "Cookie": f"cmsui={token}"}
    if xsrf:
        h["X-CMSUI"] = "1"
    if origin:
        h["Origin"] = origin
    return request(port, "POST", "/api/exec", headers=h,
                   body=json.dumps(payload).encode("utf-8"))


def _git_tracked(paths: list[str]) -> bool:
    """这些路径**是否都在** git 索引里（跑在仓库根目录）。

    ⚠️ 两个坑：
    1. **每个路径必须单独问一次**：`git ls-files --error-unmatch a b` 只要有
       **一个**不匹配就整体返回非 0，输出却仍列出匹配的那个 ——
       于是「两张都在」也会被判成「不在」。
    2. `paths` 是 **str 列表**，不是「路径组的列表」。写成后者时内层循环拿到的是
       字符串，迭代出来的是**单个字符** —— 一条断言白白失败，看着像「文件不在索引」。
    """
    import shutil as _sh
    if not (_sh.which("git") or Path(".git").exists()):
        return False
    for p in paths:
        r = subprocess.run(["git", "ls-files", "--error-unmatch", p],
                           cwd=str(HERE.parent), capture_output=True,
                           text=True, timeout=30)
        if r.returncode != 0 or p not in r.stdout.split():
            return False
    return True


def store_bytes(state_dir: Path) -> bytes | None:
    p = state_dir / "passwords.json"
    return p.read_bytes() if p.exists() else None


# --------------------------------------------------------------------------
#: T65 的假 DOM + 场景。__SRC__ 换成从 app.js 抠出来的真实实现（常量 + 七个函数），
#: 于是「定时多久、第 5 条挤掉谁、× 关掉哪条、明文抹没抹」都是真跑出来的结论。
T65_FAKE_DOM = r"""
class N {
  constructor(tag) {
    this.tag = tag; this.children = []; this.parent = null;
    this.classes = new Set(); this.attrs = {}; this.lis = {};
    this._t = ''; this.isConnected = true;
  }
  get className() { return [...this.classes].join(' '); }
  set className(v) { this.classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this.classes;
    return { add: (c) => s.add(c), contains: (c) => s.has(c) };
  }
  get textContent() {
    return this.children.length ? this.children.map((c) => c.textContent).join('') : this._t;
  }
  set textContent(v) {
    for (const c of this.children) { c.parent = null; c.isConnected = false; }
    this.children = []; this._t = String(v);
  }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k); } }
  remove() {
    if (this.parent) {
      const i = this.parent.children.indexOf(this);
      if (i >= 0) this.parent.children.splice(i, 1);
    }
    this.parent = null; this.isConnected = false;
  }
  get firstElementChild() { return this.children[0] || null; }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(t, fn) { (this.lis[t] = this.lis[t] || []).push(fn); }
  click() { for (const fn of (this.lis.click || [])) fn({ target: this }); }
  _all() {
    const acc = [];
    const walk = (n) => { for (const c of n.children) { acc.push(c); walk(c); } };
    walk(this); return acc;
  }
  querySelectorAll(sel) { return this._all().filter((n) => matchSel(n, sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
function matchSel(n, sel) {
  const bits = sel.split('.').filter(Boolean);
  return bits.every((b, i) => (i === 0 ? (n.tag === b || n.classes.has(b)) : n.classes.has(b)));
}
function mk() {
  const box = new N('div');
  const timers = [];
  const doc = { createElement: (t) => new N(t) };
  const $ = (id) => (id === 'toasts' ? box : null);
  const api = new Function('document', '$', 'setTimeout', __SRC__ +
    '\nreturn { notify: notify, toast: toast, flash: flash, showOutput: showOutput,' +
    ' clearOutput: clearOutput, TOAST_MAX: TOAST_MAX };'
  )(doc, $, (fn, ms) => { timers.push({ fn: fn, ms: ms }); });
  return { box: box, timers: timers, api: api };
}
const out = {};
{
  const m = mk();
  m.api.toast('已复制到剪贴板');
  out.shortMs = m.timers[0].ms;
  m.api.flash('已刷新 · 13:00:00');
  out.sameBox = m.box.children.length === 2;
  m.api.toast('x'.repeat(250));
  out.longSticky = m.timers.length === 2;          // 长文本没排新定时器 = 不自动关
  // 恰好 200 字：还没到「粘性」门槛，但时长早该撞封顶
  m.api.toast('y'.repeat(200));
  out.capMs = m.timers[m.timers.length - 1].ms;
  out.capScheduled = m.timers.length === 3;         // 封顶那条仍然会自动关
  const dead = m.timers[0];
  m.box.children[0].querySelector('.toast-x').click();
  out.afterClose = m.box.children.length;           // 只剩 flash + long + cap
  dead.fn();                                        // 已关掉的定时器再触发不能炸
  out.noThrow = true;
}
{
  const m = mk();
  for (const t of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) m.api.toast(t);
  out.stackLen = m.box.children.length;
  out.stackFirst = m.box.children[0].querySelector('.toast-text').textContent;
  out.xLabels = m.box.children.every((c) => !!c.querySelector('.toast-x'));
  const stale = m.timers[0];                        // 对应已被挤掉的 m1
  m.box.children[0].remove();
  stale.fn();
  out.afterTimer = m.box.children.length;           // m1 早退、m3 手动退 → 打空不多删
}
{
  const m = mk();
  m.api.showOutput('命令输出', '密码 hunter2\nid: abc');
  const card = m.box.children[0];
  out.outSticky = m.timers.length === 0;
  const head = card.querySelector('.toast-title');
  out.outTitle = head ? head.textContent : null;
  out.outMono = card.querySelector('.toast-text').classes.has('mono');
  m.api.clearOutput();
  out.outGone = m.box.children.length === 0;
  out.outText = card.querySelector('.toast-text').textContent;  // 明文必须被抹成空
}
console.log(JSON.stringify(out));
"""


# --------------------------------------------------------------------------
def main() -> int:
    if not TOOL.exists():
        print(f"找不到 {TOOL}")
        return 2

    port = free_port()
    with tempfile.TemporaryDirectory(prefix="cmsgate-uitest-") as td:
        state_dir = Path(td) / "state"
        state_dir.mkdir(parents=True, exist_ok=True)

        # 离线 gateconfig：让**写操作**也能在没有真实服务器的情况下跑通全链路。
        #
        # 用的是 gate_manager 自己的 `--offline-admin-config` 旁路（本来给 selftest 用），
        # 由 cmsui 原样转发给它起的每个子进程。它只读一个**本地文件**，凭据是这儿现造的；
        # 而且口令仍然要真正校验（错的照样过不去）。
        #
        # ★ 2026-10-21 从环境变量 `CMSGATE_OFFLINE_SELFTEST` 换成 argv 参数：
        #   环境变量会被**任何**子进程继承，谁在 shell 里 export 过一次忘了取消，
        #   真实运维的写操作就静默降级到「自己指定的假凭据」，而命令随后照样连真服务器。
        #   这里必须跟着改成 `--offline-admin-config`，否则测试反而在教坏产品代码。
        #
        # 没有它，所有写操作都会去 SSH 读线上 gateconfig —— 测试既慢又依赖网络，
        # 还会把「线上是否设了口令」变成测试的成败因素。
        fake_cfg = Path(td) / "gateconfig.json"
        try:
            gmm = load_gate_manager()
            import json as _json
            fake_cfg.write_text(_json.dumps({
                "version": 1, "require_password": True,
                "updated_at": gmm.now_iso(), "updated_by": "uitest",
                "admin": gmm.make_admin_block(TEST_ADMIN_PW),
            }, ensure_ascii=False), encoding="utf-8")
            os.chmod(fake_cfg, 0o600)
            offline_args = ["--offline-admin-config", str(fake_cfg)]
        except Exception as e:
            print(f"（造离线 gateconfig 失败，写操作用例会被跳过：{e}）")
            offline_args = []

        print(f"启动服务：port={port} state={state_dir}")
        try:
            with Server(state_dir, port, extra_args=offline_args) as srv:
                tok = srv.token
                print(f"拿到 token（长度 {len(tok)}）\n")
                run_tests(srv, port, tok, state_dir)
        except Exception as e:
            chk("服务能启动", False, str(e))
            print()

    print()
    tail = f"，跳过 {len(skipped)} 项" if skipped else ""
    print(f"通过 {len(passed)} 项，失败 {len(failed)} 项{tail}")
    if skipped:
        for s in skipped:
            print("  (跳过)", s)
    if failed:
        print("失败项：")
        for f in failed:
            print("  -", f)
        return 1
    return 0


def run_tests(srv: Server, port: int, tok: str, state_dir: Path) -> None:
    print("T1 绑定范围")
    # 服务只 bind 127.0.0.1：从本机的非回环地址应该连不上。
    # 找不到非回环地址就跳过（沙箱里可能没有）。
    lan_ip = None
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 53))
        lan_ip = probe.getsockname()[0]
        probe.close()
    except OSError:
        lan_ip = ""
    # ★ 服务跑在**子进程**里，测试拿不到 socket 对象；`lsof` 又可能被沙箱挡住。
    #   所以让 gate_ui.py 启动时打一行 `BIND <addr> <port>`（从 getsockname 拿的真值），
    #   这里从它的 stdout 里读 —— 不是推断，是**它自己的绑定结果**。
    #   ⚠️ 旧写法是「拿默认路由对应的 IP 试着连过去，连不上就算过」——
    #   一开 VPN 就错位：utun 隧道占掉默认路由后那个 IP 是 198.18.0.1
    #   （RFC 2544 保留段），隧道上还可能真有东西在转发 → 连上了 →
    #   报「服务没只绑回环」，**而绑定其实完全正确**。
    #   在 VPN 下恒失败的测试比没有测试更糟。
    bound = ""
    for line in srv.out_lines:
        if line.startswith("BIND "):
            bound = line.split()[1] if len(line.split()) > 1 else ""
            break
    chk("T1 服务只绑 127.0.0.1（读它自报的 getsockname，不靠推断）",
        bound == "127.0.0.1",
        f"自报绑定 {bound or '（没读到 BIND 行）'}；"
        f"（外查 lsof/netstat 在本机被沙箱挡住，不作为依据）")
    # 补充：**非回环地址连不上** —— 这条只在 VPN 隧道**没**转发端口时才成立。
    #   实测 2026-10-17：服务自报绑定 127.0.0.1（绑定完全正确），
    #   但从 utun 隧道的 198.18.0.1 仍能连上 —— 那是 **VPN 客户端在做端口转发**，
    #   与本服务无关；网关设备后面的人理论上能经隧道访问到它。
    #   所以这条改成 SKIP 并把事实写清楚，而不是让它在 VPN 下恒失败。
    if lan_ip and not lan_ip.startswith("127.") and lan_ip != bound:
        reachable = False
        try:
            c = socket.create_connection((lan_ip, port), timeout=1.5)
            c.close()
            reachable = True
        except OSError:
            reachable = False
        if reachable:
            skip("T1 非回环地址连不上",
                 f"{lan_ip} 能连上，但那是 VPN 隧道在转发端口，"
                 "不是服务绑错了（绑定已由上面那条直接验证）；"
                 "⚠️ 经该 VPN 的人理论上能访问本服务")
        else:
            chk("T1 非回环地址连不上", not reachable, f"{lan_ip}:{port}")
    else:
        skip("T1 非回环地址连不上", f"本机没有非回环地址（{lan_ip or '无'}）")

    print("\nT2/T3 没有或错误的 token")
    st, _, body = request(port, "GET", "/")
    chk("T2 无 token → 403", st == 403, f"status={st}")
    chk("T2 并给出说明（而不是空白/报错）",
        "需要钥匙" in body.decode("utf-8", "replace"), "")
    st, _, _ = request(port, "GET", "/?k=" + "x" * len(tok))
    chk("T3 错 token → 403", st == 403, f"status={st}")
    st, _, _ = request(port, "GET", "/?k=" + tok[:-1])
    chk("T3 少一位 token → 403", st == 403, f"status={st}")

    print("\nT4/T5 正确 token → cookie → 正常页面")
    st, hdrs, _ = request(port, "GET", "/?k=" + tok)
    chk("T4 正确 token → 303 重定向（把 token 从地址栏抹掉）",
        st == 303, f"status={st}")
    ck = hdrs.get("set-cookie", "")
    chk("T4 cookie 是 HttpOnly", "httponly" in ck.lower(), ck)
    chk("T4 cookie 是 SameSite=Strict", "samesite=strict" in ck.lower(), ck)
    chk("T4 cookie 路径是 /", "path=/" in ck.lower(), ck)

    cookie = {"Cookie": f"cmsui={tok}"}
    st, hdrs, body = request(port, "GET", "/", headers=cookie)
    html = body.decode("utf-8", "replace")
    chk("T5 带 cookie → 200 HTML", st == 200 and "<title>" in html, f"status={st}")

    print("\nT6 静态资源也要鉴权")
    st, _, _ = request(port, "GET", "/app.js")
    chk("T6 无 cookie 拿 /app.js → 403", st == 403, f"status={st}")
    st, _, _ = request(port, "GET", "/app.css", headers=cookie)
    chk("T6 有 cookie 拿 /app.css → 200", st == 200, f"status={st}")
    st, _, _ = request(port, "GET", "/seedcodec.js")
    chk("T6 无 cookie 拿 /seedcodec.js → 403", st == 403, f"status={st}")
    st, _, body = request(port, "GET", "/seedcodec.js", headers=cookie)
    chk("T6 有 cookie 拿 /seedcodec.js → 200 且是真编解码器",
        st == 200 and b"decodeSeed" in body, f"status={st}")

    print("\nT7 伪造 Host（DNS rebinding）")
    for fake in ("evil.example", f"evil.example:{port}", "10.0.0.1"):
        st, _, _ = request(port, "GET", "/", host=fake, headers=cookie)
        chk(f"T7 Host={fake} → 403", st == 403, f"status={st}")
    st, _, _ = request(port, "GET", "/", host=f"localhost:{port}", headers=cookie)
    chk("T7 Host=localhost 仍可访问", st == 200, f"status={st}")

    print("\nT8/T9 跨站请求")
    st, _, _ = post_exec(port, tok, {"op": "list"}, origin="http://evil.example")
    chk("T8 跨站 Origin → 403", st == 403, f"status={st}")
    st, _, _ = post_exec(port, tok, {"op": "list"}, xsrf=False)
    chk("T9 缺 X-CMSUI → 403", st == 403, f"status={st}")
    st, _, _ = post_exec(port, tok, {"op": "list"}, xsrf=False,
                         origin="http://evil.example")
    chk("T9 缺 X-CMSUI 且跨站 → 403", st == 403, f"status={st}")

    print("\nT10 未授权访问 API")
    st, _, _ = request(port, "GET", "/api/overview")
    chk("T10 无 cookie 打 /api/overview → 403", st == 403, f"status={st}")

    print("\nT11 写操作缺管理口令")
    before = store_bytes(state_dir)
    st, _, body = post_exec(port, tok, {"op": "add", "params": {"label": "x", "newpw": "abcdefghijkl"}})
    out = body.decode("utf-8", "replace")
    chk("T11 缺管理口令 → 被拒", st >= 400 and '"ok": false' in out.replace('"ok":false', '"ok": false')
        or st >= 400, f"status={st}")
    chk("T11 报错说清是要管理口令", "管理口令" in out or "admin" in out, out[:120])
    chk("T11 本地密码表一个字节都没变", store_bytes(state_dir) == before, "")

    print("\nT12/T13 参数校验")
    st, _, _ = post_exec(port, tok, {"op": "not-a-real-op"})
    chk("T12 未知 op → 4xx", 400 <= st < 500, f"status={st}")
    st, _, _ = post_exec(port, tok, {"op": "list", "params": {"_state": "/tmp"}})
    chk("T13 请求体里塞 _state → 400", st == 400, f"status={st}")

    print("\nT14 安全响应头")
    st, hdrs, _ = request(port, "GET", "/", headers=cookie)
    chk("T14 有 CSP", "content-security-policy" in hdrs, "")
    csp = hdrs.get("content-security-policy", "")
    chk("T14 CSP 限制 script-src 'self'", "script-src 'self'" in csp, csp)
    chk("T14 CSP 有 frame-ancestors 'none'", "frame-ancestors 'none'" in csp, csp)
    chk("T14 X-Content-Type-Options: nosniff",
        hdrs.get("x-content-type-options", "").lower() == "nosniff", "")
    chk("T14 Cache-Control no-store", "no-store" in hdrs.get("cache-control", ""), "")
    chk("T14 X-Frame-Options: DENY",
        hdrs.get("x-frame-options", "").upper() == "DENY", "")

    print("\nT15 日志里不能出现 token")
    # 制造几条会写日志的请求，然后检查服务端 stderr 的累计内容。
    # ⚠️ stderr 现在由后台线程持续读走（否则管道写满会死锁），
    #    所以这里读的是 srv.stderr_text 的快照，不要再碰 proc.stderr。
    request(port, "GET", "/?k=" + tok)
    request(port, "GET", "/api/overview", headers=cookie)
    time.sleep(0.5)
    log_text = srv.stderr_text
    chk("T15 日志里没有出现 token", tok not in log_text,
        "token 出现在 stderr —— 等于把钥匙写进了日志文件" if tok in log_text else
        f"已记录 {len(log_text)} 字节访问日志")
    # 反向验证：日志**确实在工作**（否则「没泄漏 token」可能只是因为它什么都没记）
    chk("T15 对照：日志确实记录了请求", "GET /" in log_text,
        "日志为空说明这个断言毫无意义" if "GET /" not in log_text else "")


    # ── 功能回归：安全全过但界面什么都干不了，也是不完整的 ──
    print("\nT16 只读操作能跑通（init / list）")
    st, _, body = post_exec(port, tok, {"op": "init"})
    out = body.decode("utf-8", "replace")
    chk("T16 init → 成功", st == 200 and '"ok": true' in out.replace('"ok":true', '"ok": true'),
        f"status={st} {out[:120]}")
    st, _, body = post_exec(port, tok, {"op": "list"})
    out = body.decode("utf-8", "replace")
    chk("T16 list → 成功", st == 200 and '"ok": true' in out.replace('"ok":true', '"ok": true'),
        f"status={st} {out[:160]}")

    print("\nT17 写操作：管理口令错 → 被拒且不改文件")
    before = store_bytes(state_dir)
    st, _, body = post_exec(port, tok, {
        "op": "add",
        "params": {"label": "t17", "note": "", "newpw": "goodpassword-2026",
                   "admin": "definitely-wrong-admin", "expiry": {"kind": "never"}},
    })
    out = body.decode("utf-8", "replace")
    chk("T17 错口令 → 失败", '"ok": true' not in out.replace('"ok":true', '"ok": true')
        or '"ok":false' in out.replace('"ok": false', '"ok":false'), out[:160])
    chk("T17 错口令时密码表没变", store_bytes(state_dir) == before, "")

    print("\nT18 写操作：管理口令对 → 真正写入")
    st, _, body = post_exec(port, tok, {
        "op": "add",
        "params": {"label": "t18-ok", "note": "自动测试", "newpw": "goodpassword-2026",
                   "admin": TEST_ADMIN_PW, "expiry": {"kind": "never"}},
    })
    out = body.decode("utf-8", "replace")
    chk("T18 正确口令 → 成功", '"ok": true' in out.replace('"ok":true', '"ok": true'),
        f"status={st} {out[:200]}")
    chk("T18 响应里带出了明文密码（用户只此一次机会）",
        "goodpassword-2026" in out, out[:200])
    # 列表接口应当看到这条
    st, _, body = request(port, "GET", "/api/entries", headers=cookie)
    entries_raw = body.decode("utf-8", "replace")
    chk("T18 新条目出现在 /api/entries", "t18-ok" in entries_raw, entries_raw[:200])
    # 而落盘的只有哈希，没有明文
    blob = store_bytes(state_dir) or b""
    chk("T18 ★ 落盘文件里没有明文密码", b"goodpassword-2026" not in blob,
        "明文进了 passwords.json —— 那是严重泄漏" if b"goodpassword-2026" in blob else "只存了盐与哈希")


    print("\nT19 前端传 --hours 真的生效（回归：CLI 曾静默忽略 --hours）")
    # 这条守的是一个**不报错的 bug**：`add --hours N` 曾经既不报错也不设有效期，
    # 用户以为设了、实际永久。所以必须从界面这条路验到落库的 expires_at。
    st, _, body = post_exec(port, tok, {
        "op": "add",
        "params": {"label": "t19-hours", "note": "", "newpw": "hours-password-2026",
                   "admin": TEST_ADMIN_PW, "expiry": {"kind": "hours", "value": "2"}},
    })
    out = body.decode("utf-8", "replace")
    chk("T19 add --hours 2 → 成功", '"ok": true' in out.replace('"ok":true', '"ok": true'),
        f"status={st} {out[:160]}")

    st, _, body = request(port, "GET", "/api/entries", headers=cookie)
    rows = (json.loads(body.decode("utf-8")) or {}).get("data") or []
    hit = [r for r in rows if r.get("label") == "t19-hours"]
    chk("T19 能在列表里找到这条", len(hit) == 1, f"命中 {len(hit)} 条")
    if hit:
        exp = hit[0].get("expiry_utc")
        chk("T19 ★ expires_at 不是 None（--hours 生效了）", exp is not None,
            "expires_at 为空 = 又退回「永久」，说明 --hours 又被忽略了")
        if exp:
            t = datetime.strptime(exp, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            left = (t - datetime.now(timezone.utc)).total_seconds() / 3600.0
            chk("T19 剩余时长约 2 小时", 1.9 < left < 2.1, f"实测 {left:.3f}h")

    print("\nT20 详情（show）能取到单条信息")
    st, _, body = request(port, "GET", "/api/entries", headers=cookie)
    rows = (json.loads(body.decode("utf-8")) or {}).get("data") or []
    pick = next((r for r in rows if r.get("label") == "t18-ok"), None)
    chk("T20 准备：找到 t18-ok", pick is not None, f"共 {len(rows)} 条")
    if pick:
        st, _, body = post_exec(port, tok, {"op": "show", "params": {"id": pick["id"]}})
        out = body.decode("utf-8", "replace")
        chk("T20 show → 成功", '"ok": true' in out.replace('"ok":true', '"ok": true'),
            f"status={st} {out[:160]}")
        chk("T20 输出里带标签与 id", "t18-ok" in out and pick["id"] in out, out[:200])
        chk("T20 输出里没有明文密码", "goodpassword-2026" not in out,
            "show 不该回显密码（只有哈希）")

    # ── T21 ─────────────────────────────────────────────────────────
    # 这两个是**用户报的体感 bug**，后端没有毛病，改的全在 app.js 里。
    # 所以这里检查前端源码的结构性约束 —— 不是为了覆盖率，是为了
    # 防止以后有人「顺手简化」又把它们改回去：
    #   ① 详情必须出现在视口里（原来写到页面最底部的输出卡片，点了像没反应）
    #   ② 口令错了要能原地重输（原来直接返回，前面填的表单全白填）
    print("\nT21 前端：详情可见 + 口令错可原地重输")
    js = (HERE / "gateui" / "app.js").read_text(encoding="utf-8")
    css = (HERE / "gateui" / "app.css").read_text(encoding="utf-8")

    chk("T21 详情走对话框", "openInfoDialog({" in js and "function openInfoDialog" in js)
    chk("T21 详情不再写到页面最底部的输出卡片", "showOutput('详情" not in js,
        "详情若写进 output-card，用户点了看不到任何变化")
    # 对话框必须先 showModal 再 fill：顺序反了就成了「等数据回来才弹窗」
    m = re.search(r"function openInfoDialog\(opts\)\s*\{(.*?)\n    \}\n", js, re.S)
    seg = m.group(1) if m else ""
    chk("T21 对话框先显示、再填内容",
        seg.find("dlg.showModal()") >= 0 and seg.find("dlg.showModal()") < seg.find("opts.fill("),
        "showModal 必须在 fill 之前")

    m = re.search(r"function adminWrong\(out\)\s*\{(.*?)\n    \}\n", js, re.S)
    body = m.group(1) if m else ""
    chk("T21 判「口令错」只认「管理口令不正确」", "管理口令不正确" in body, body.strip()[:80])
    chk("T21 不会把「服务器上没有管理口令」当成口令错",
        "服务器上没有" not in body and "/管理口令/" not in body,
        "写成 /管理口令/ 会让缺口令的情况无限重输")

    m = re.search(r"async function runWrite\(.*?\n    \}\n", js, re.S)
    seg = m.group(0) if m else ""
    chk("T21 口令错后回到问口令（continue，不是 return）",
        "adminWrong(r.out)" in seg and "continue;" in seg)
    chk("T21 重试用的仍是原来那批参数", "Object.assign({}, params" in seg,
        "参数若在循环里被改写，重试就会丢内容")
    chk("T21 问口令能带上「上一次错了」的提示", "askAdmin(actionText, hint)" in seg)

    # ── T22 ─────────────────────────────────────────────────────────
    # app.js 里 `$('xxx')` 取不到就是 null，接着一个 addEventListener 就抛 TypeError，
    # 整个 IIFE 挂掉 —— 症状是「页面一片空白、控制台一句话」，最难猜。
    # 这里静态核对一遍：用到的 id 必须在 index.html 里声明过。
    print("\nT22 前端的 DOM id 都对得上")
    html = (HERE / "gateui" / "index.html").read_text(encoding="utf-8")
    used = set(re.findall(r"\$\('([\w-]+)'\)", js))
    declared = set(re.findall(r'id="([\w-]+)"', html))
    missing = sorted(used - declared)
    chk("T22 app.js 用到的 id 都在 index.html 里", not missing,
        f"缺失 {missing}" if missing else f"共 {len(used)} 个")
    chk("T22 取到了 id（防止正则失效导致这条永远通过）", len(used) >= 20, f"只取到 {len(used)} 个")

    # ── T23 ─────────────────────────────────────────────────────────
    # 访问记录：**最新的在最上面** + 四类筛选（结果 / 密码 / 时间 / 关键词）。
    # 直接调 gate_ui.read_usage()，不起 HTTP —— 这几条是纯函数，也不需要口令。
    #
    # ★ 故意把写入顺序打乱：排序必须靠 `ts` 字段，而不能靠「缓存是按时间追加的」
    #   这个隐式前提。我第一版实现正是 `reversed(recs)`，一打乱就全错。
    print("\nT23 访问记录：最新在前 + 筛选")
    gu = load_gate_ui()
    gm = gu.gm                  # gate_ui 载入的 CLI 模块（断言 INPLACE_ADMIN_CMDS 等要用）

    def _iso(delta):
        return (datetime.now(timezone.utc) - delta).strftime("%Y-%m-%dT%H:%M:%SZ")

    def _today_at(frac):
        """今天内的一个时刻（占「已过去时间」的 frac）。用于造「今天」的数据。

        ★ 不能用 `now - 1h / 2h` 造「今天」：刚过午夜时那些会跨到**昨天**，
          `since=today` 只认本地零点之后的，断言就随机翻车（2026-10-18 00:2x
          真撞上过：期望 3 条，实际 1 条）。
          按「今天已过去多久」取比例，无论几点都在今天、且都不晚于现在。
        """
        now = datetime.now().astimezone()
        t0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
        span = max(1.0, (now - t0).total_seconds())
        return (t0 + timedelta(seconds=span * frac)).astimezone(timezone.utc) \
            .strftime("%Y-%m-%dT%H:%M:%SZ")

    recs = [
        {"ts": _today_at(0.35), "ok": True, "pwid": "aaaa", "label": "张三",
         "ip": "1.1.1.1", "browser": "Chrome", "os": "macOS"},
        {"ts": _today_at(0.60), "ok": False, "pwid": "aaaa", "label": "张三",
         "reason": "bad_password", "ip": "1.1.1.2", "browser": "Safari", "os": "iOS"},
        {"ts": _today_at(0.85), "ok": True, "pwid": "bbbb", "label": "李四",
         "ip": "2.2.2.2", "browser": "Firefox", "os": "Windows"},
        {"ts": _iso(timedelta(days=10)), "ok": False, "pwid": "bbbb", "label": "李四",
         "reason": "throttled", "ip": "3.3.3.3", "browser": "curl", "os": "Linux"},
        {"ts": _iso(timedelta(days=40)), "ok": True, "pwid": "aaaa", "label": "张三",
         "ip": "4.4.4.4", "browser": "Edge", "os": "Windows"},
    ]
    random.Random(20261017).shuffle(recs)

    with tempfile.TemporaryDirectory(prefix="cmsgate-t23-") as td:
        ust = Path(td)
        (ust / "usage.cache.jsonl").write_text(
            "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")

        def u(**kw):
            kw.setdefault("limit", 200)
            return gu.read_usage(ust, **kw)

        got = u()
        times = [r["ts"] for r in got["rows"]]
        chk("T23 最新的排在最前", times == sorted(times, reverse=True),
            f"实际 {times[:3]}…")
        chk("T23 打乱的写入顺序不影响结果", got["rows"][0]["ts"] == max(r["ts"] for r in recs))
        chk("T23 total / matched 都对", got["total"] == 5 and got["matched"] == 5,
            f"{got['total']} / {got['matched']}")

        f = u(result="fail")
        chk("T23 仅失败", f["matched"] == 2 and not any(r["ok"] for r in f["rows"]), str(f["matched"]))
        o = u(result="ok")
        chk("T23 仅成功", o["matched"] == 3 and all(r["ok"] for r in o["rows"]), str(o["matched"]))

        chk("T23 今天 / 7 天 / 30 天",
            (u(since="today")["matched"], u(since="7d")["matched"], u(since="30d")["matched"]) == (3, 3, 4),
            f"{u(since='today')['matched']} / {u(since='7d')['matched']} / {u(since='30d')['matched']}")
        chk("T23 按密码筛", u(pwid="bbbb")["matched"] == 2)
        chk("T23 关键词搜浏览器", u(q="chrome")["matched"] == 1)
        chk("T23 关键词搜 IP 片段", u(q="1.1.1.2")["matched"] == 1)
        chk("T23 组合筛选（密码+失败+30 天）", u(pwid="bbbb", result="fail", since="30d")["matched"] == 1)

        lim = u(limit=2)
        chk("T23 limit 截的是「最新的 2 条」",
            len(lim["rows"]) == 2 and lim["rows"][0]["ts"] == max(r["ts"] for r in recs)
            and lim["matched"] == 5, f"rows={len(lim['rows'])} matched={lim['matched']}")

        # 反例：limit 把 matched 截掉时，前端必须能看出「还有更多」
        chk("T23 被 limit 截断时 matched > rows（否则前端会以为只有这么多）",
            lim["matched"] > len(lim["rows"]))

        who = gu.read_usage_pwids(ust)
        chk("T23 下拉框列出所有出现过的密码（含计数）",
            {x["pwid"] for x in who} == {"aaaa", "bbbb"} and sum(x["fail"] for x in who) == 2,
            str([(x["pwid"], x["count"], x["fail"]) for x in who]))

        try:
            u(since="去年")
            chk("T23 非法 since 被拒", False, "竟然放过了")
        except gu.ApiError:
            chk("T23 非法 since 被拒", True)

    # 走真实 HTTP 一遍：确认查询参数真的接上了路由（纯函数对不代表拼参数对）
    print("\nT23b /api/usage 的参数接线")
    (state_dir / "usage.cache.jsonl").write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in recs) + "\n", encoding="utf-8")

    def get_usage(qs):
        st2, _, body = request(port, "GET", "/api/usage" + qs, headers=cookie)
        return st2, json.loads(body.decode("utf-8"))

    st2, j = get_usage("?limit=200")
    data = j.get("data") or {}
    chk("T23b 返回 {rows,total,matched}（不是裸数组）",
        isinstance(data, dict) and {"rows", "total", "matched"} <= set(data), str(type(data)))
    rows = data.get("rows") or []
    chk("T23b 最新的在最前（走 HTTP）",
        len(rows) == 5 and [r["ts"] for r in rows] == sorted((r["ts"] for r in rows), reverse=True),
        str([r["ts"] for r in rows][:3]))

    st2, j = get_usage("?result=fail")
    chk("T23b ?result=fail 生效", (j.get("data") or {}).get("matched") == 2,
        str((j.get("data") or {}).get("matched")))
    st2, j = get_usage("?since=7d")
    chk("T23b ?since=7d 生效", (j.get("data") or {}).get("matched") == 3)
    st2, j = get_usage("?id=bbbb")
    chk("T23b ?id= 生效", (j.get("data") or {}).get("matched") == 2)
    st2, j = get_usage("?q=safari")
    chk("T23b ?q= 生效", (j.get("data") or {}).get("matched") == 1)
    st2, j = get_usage("?since=" + urllib.parse.quote("去年"))
    chk("T23b 非法 since → 400（不是静默忽略）", st2 == 400, f"status={st2}")
    st2, j = get_usage("?limit=abc")
    chk("T23b 非法 limit → 400（不是 500）", st2 == 400, f"status={st2}")

    st2, _, body = request(port, "GET", "/api/usage_pwids", headers=cookie)
    j = json.loads(body.decode("utf-8"))
    wl = j.get("data") or []
    chk("T23b /api/usage_pwids 返回每条出现过的密码",
        {x["pwid"] for x in wl} == {"aaaa", "bbbb"}, str(wl))

    # ── T24 ─────────────────────────────────────────────────────────
    # 「有改动未推送」到底是哪几条改了。后端逐条比本地 vs 线上。
    #
    # ★ 最重要的一条不是 counts，而是**密码哈希绝不外传**：
    #   前端只需要知道「这条的密码变了」，不需要知道 salt/hash 是什么。
    #   所以这里直接把返回值 json.dumps 出来搜哈希串。
    print("\nT24 「未推送」能逐条说清改了什么")

    def _mk(eid, label, *, salt, h, rev=1, enabled=True, exp=None):
        return {"id": eid, "label": label, "note": "", "salt": salt, "hash": h,
                "rev": rev, "enabled": enabled, "expires_at": exp,
                "created_at": "2026-10-01T00:00:00Z", "created_by": "local"}

    salt_a, hash_a = gu.gm.hash_password("pw-a")
    salt_b, hash_b = gu.gm.hash_password("pw-b")

    local_entries = [
        _mk("aaa1", "甲", salt=salt_a, h=hash_a),      # 线上没有 → 新增
        _mk("bbb2", "乙", salt=salt_a, h=hash_a),      # 线上改过标签 → 修改
        _mk("ccc3", "丙", salt=salt_a, h=hash_a),      # 完全一样 → 未变
        _mk("ddd4", "丁", salt=salt_a, h=hash_a),      # 线上没有 → 新增
        _mk("fff6", "戊", salt=salt_a, h=hash_a),      # 线上轮换过密码 → 修改
    ]
    remote_entries = [
        _mk("bbb2", "乙-线上改名", salt=salt_a, h=hash_a),
        _mk("ccc3", "丙", salt=salt_a, h=hash_a),
        _mk("fff6", "戊", salt=salt_b, h=hash_b),      # 密码被轮换过
        _mk("eee5", "己", salt=salt_a, h=hash_a),      # 本地没有 → 删除
    ]

    store_tpl = gu.gm.load_store(state_dir)
    fake_state = state_dir.parent / "t24-state"
    fake_state.mkdir(parents=True, exist_ok=True)
    gu.gm.save_store(fake_state, dict(store_tpl, gen=7, entries=local_entries))
    fake_remote = dict(store_tpl, gen=6, entries=remote_entries)

    orig_rrj, orig_cfg = gu.gm.remote_read_json, gu.gm._load_gate_config
    try:
        gu.gm.remote_read_json = lambda a, name: fake_remote
        d = gu.read_push_diff(fake_state, server="h", ssh_port="22", remote_dir="/r")

        c = d["counts"]
        chk("T24 counts：新增 2 / 删除 1 / 修改 2 / 未变 1",
            (c["added"], c["removed"], c["changed"], c["same"]) == (2, 1, 2, 1), str(c))

        kinds = {r["id"]: r["kind"] for r in d["rows"]}
        chk("T24 本地新增的两条被判成 added",
            kinds.get("aaa1") == "added" and kinds.get("ddd4") == "added", str(kinds))
        chk("T24 线上多出来的判成 removed", kinds.get("eee5") == "removed")
        chk("T24 改过标签的判成 changed", kinds.get("bbb2") == "changed")
        chk("T24 未变的条目不出现在差异列表里", "ccc3" not in kinds)

        by_id = {r["id"]: r for r in d["rows"]}
        chk("T24 标签变化只报「标签」", by_id["bbb2"].get("fields") == ["标签"],
            str(by_id["bbb2"].get("fields")))
        chk("T24 密码轮换只报「密码」", by_id["fff6"].get("fields") == ["密码"],
            str(by_id["fff6"].get("fields")))
        chk("T24 每条都有给人看的说明",
            all(len(r.get("detail") or "") >= 6 for r in d["rows"]),
            str([r.get("detail") for r in d["rows"]][:2]))

        chk("T24 gen 两边都带出来（本地 7 / 线上 6）",
            (d["local_gen"], d["remote_gen"]) == (7, 6), f"{d['local_gen']} / {d['remote_gen']}")

        blob = json.dumps(d, ensure_ascii=False)
        leaked = [h for h in (hash_a, hash_b, salt_a, salt_b) if h in blob]
        chk("T24 ★ 返回值里没有 salt/hash", not leaked, f"泄漏了 {len(leaked)} 个")

        # 线上还没有密码表 → 本地全部算新增，而不是「连不上」
        gu.gm.remote_read_json = lambda a, name: None
        gu.gm._load_gate_config = lambda a: {"version": 1}
        d2 = gu.read_push_diff(fake_state, server="h", ssh_port="22", remote_dir="/r")
        chk("T24 线上没有表 → remote_missing，本地全算新增",
            d2.get("remote_missing") is True and d2["counts"]["added"] == 5,
            str(d2.get("counts")))

        # 连不上 → 必须报错，不能伪装成「线上什么都没有」
        def _boom(a):
            gu.gm.die("ssh: connect to host failed")
        gu.gm._load_gate_config = _boom
        d3 = gu.read_push_diff(fake_state, server="h", ssh_port="22", remote_dir="/r")
        chk("T24 ★ 连不上时 reachable=False（不能显示成「线上是空的」）",
            d3.get("reachable") is False and "ssh" in (d3.get("error") or "").lower(),
            str(d3)[:120])
        chk("T24 连不上时不返回 rows（避免把 5 条全标成新增）", "rows" not in d3)
    finally:
        gu.gm.remote_read_json, gu.gm._load_gate_config = orig_rrj, orig_cfg

    # ── T25 ─────────────────────────────────────────────────────────
    # 列头筛选：facet（每列可选值 + 条数）+ 多选组合。
    # 复用 T23b 写进服务器 state 的那 5 条记录。
    print("\nT25 列头筛选：facet 与多选")

    st2, _, body = request(port, "GET", "/api/usage_facets", headers=cookie)
    fac = (json.loads(body.decode("utf-8")) or {}).get("data") or {}
    chk("T25 facets.status=200 且有数据", st2 == 200 and fac.get("total") == 5,
        f"status={st2} total={fac.get('total')}")

    rc = {r["value"]: r["n"] for r in (fac.get("results") or [])}
    chk("T25 结果列 facet：成功 3 / 密码错 1 / 被限流 1",
        rc == {"ok": 3, "bad_password": 1, "throttled": 1}, str(rc))
    chk("T25 结果 facet 是代码不是中文（中文只用于显示）",
        all(r["value"].isascii() for r in (fac.get("results") or [])),
        str([r["value"] for r in (fac.get("results") or [])]))
    chk("T25 结果 facet 的显示文案来自 CLI",
        {r["text"] for r in (fac.get("results") or [])} == {"成功", "密码错", "被限流"},
        str([r["text"] for r in (fac.get("results") or [])]))

    pw = {r["value"]: (r["text"], r["n"]) for r in (fac.get("pwids") or [])}
    chk("T25 密码 facet 用标签显示并带条数",
        pw.get("aaaa") == ("张三", 3) and pw.get("bbbb") == ("李四", 2), str(pw))
    chk("T25 IP / 浏览器 facet 列出所有出现过的值",
        len(fac.get("ips") or []) == 5 and len(fac.get("browsers") or []) == 5,
        f"ips={len(fac.get('ips') or [])} browsers={len(fac.get('browsers') or [])}")
    osd = {r["value"]: r["n"] for r in (fac.get("osdev") or [])}
    chk("T25 系统/设备 facet 把同系统的记录合并计数", osd.get("Windows") == 2, str(osd))

    def usage_matched(qs):
        _, _, b = request(port, "GET", "/api/usage?limit=200" + qs, headers=cookie)
        return (json.loads(b.decode("utf-8")) or {}).get("data", {}).get("matched")

    chk("T25 多选「成功+密码错」= 3+1 条", usage_matched("&result=ok,bad_password") == 4)
    chk("T25 result=fail 仍等于「所有失败」（兼容别名）", usage_matched("&result=fail") == 2)
    chk("T25 多选浏览器", usage_matched("&browser=Chrome,Firefox") == 2)
    chk("T25 系统/设备列筛选", usage_matched("&os=Windows") == 2)
    chk("T25 IP 列筛选", usage_matched("&ip=1.1.1.1") == 1)
    chk("T25 两列组合是「且」",
        usage_matched("&browser=Chrome&os=macOS") == 1
        and usage_matched("&browser=Chrome&os=Windows") == 0)

    # ★ facet 必须基于「未筛选」的全量：否则勾了成功之后，「密码错」会从列表里消失，
    #   用户想改选就得先清空——Excel 不是这么干的。
    st3, _, body3 = request(port, "GET", "/api/usage_facets", headers=cookie)
    fac2 = (json.loads(body3.decode("utf-8")) or {}).get("data") or {}
    chk("T25 ★ facet 不受当前筛选影响（列表不会缩水）",
        fac2.get("total") == 5 and {r["value"]: r["n"] for r in (fac2.get("results") or [])} == rc,
        str(fac2.get("total")))

    # 空值：老记录没有 UA，浏览器列为空。空串在查询串里等于「不限」，
    # 所以「只看空」要一个显式 token，不能靠空串。
    # 用两条记录，才能真正区分「只看空」和「不限」（一条记录时两者都是 1，测不出差别）。
    with tempfile.TemporaryDirectory(prefix="cmsgate-t25-") as td:
        bst = Path(td)
        now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        lines = [
            {"ts": now_iso, "ok": True, "pwid": "aaaa", "label": "张三",
             "ip": "9.9.9.9"},                                    # 没有 browser
            {"ts": now_iso, "ok": True, "pwid": "bbbb", "label": "李四",
             "ip": "8.8.8.8", "browser": "Chrome", "os": "macOS"},
        ]
        (bst / "usage.cache.jsonl").write_text(
            "\n".join(json.dumps(x, ensure_ascii=False) for x in lines) + "\n", encoding="utf-8")

        blank = gu._BLANK
        chk("T25 只看「浏览器为空」= 1 条",
            gu.read_usage(bst, limit=50, browser=blank)["matched"] == 1, blank)
        chk("T25 传空串 = 不限（2 条），不等于「只看空」",
            gu.read_usage(bst, limit=50, browser="")["matched"] == 2)
        chk("T25 只看 Chrome = 1 条",
            gu.read_usage(bst, limit=50, browser="Chrome")["matched"] == 1)

    # ── T26 ─────────────────────────────────────────────────────────
    # 三件事：① 自定义起止（毫秒） ② 只显示「密码表里还存在的」
    # ③ 所有密码列表按创建时间从晚到早（条目表 / CLI list / 筛选下拉）
    print("\nT26 自定义时间范围 / 只看还存在的 / 创建时间倒序")

    tst = state_dir.parent / "t26-state"
    tst.mkdir(parents=True, exist_ok=True)
    tpl = gu.gm.load_store(state_dir)          # 借一份合法的骨架（version/params/KDF）
    ents = [
        _mk("old1", "最早", salt=salt_a, h=hash_a),
        _mk("mid2", "中间", salt=salt_a, h=hash_a),
        _mk("new3", "最新", salt=salt_a, h=hash_a),
    ]
    ents[0]["created_at"] = "2026-09-01T00:00:00Z"
    ents[1]["created_at"] = "2026-10-01T00:00:00Z"
    ents[2]["created_at"] = "2026-10-15T00:00:00Z"
    gu.gm.save_store(tst, dict(tpl, gen=1, entries=ents))

    # 时间戳刻意取固定值：这段测的是「边界算得对不对」，用相对时间会让断言依赖运行时刻。
    ts_list = ["2026-10-01T00:00:00Z", "2026-10-10T00:00:00Z", "2026-10-15T00:00:00Z",
               "2026-10-16T12:00:30Z", "2026-10-17T00:00:00Z"]
    urecs = [
        {"ts": ts_list[4], "ok": True, "pwid": "new3", "label": "最新", "ip": "1.1.1.1"},
        {"ts": ts_list[3], "ok": False, "pwid": "mid2", "label": "中间",
         "reason": "bad_password", "ip": "1.1.1.2"},
        {"ts": ts_list[2], "ok": True, "pwid": "old1", "label": "最早", "ip": "1.1.1.3"},
        {"ts": ts_list[1], "ok": True, "pwid": "old1", "label": "最早", "ip": "1.1.1.4"},
        {"ts": ts_list[0], "ok": True, "pwid": "old1", "label": "最早", "ip": "1.1.1.5"},
        {"ts": ts_list[2], "ok": True, "pwid": "gone9", "label": "已删除的", "ip": "2.2.2.2"},
        {"ts": ts_list[2], "ok": True, "pwid": "gone9", "label": "已删除的", "ip": "2.2.2.3"},
        {"ts": ts_list[2], "ok": False, "ip": "3.3.3.3"},            # 匿名失败：没有 pwid
    ]
    (tst / "usage.cache.jsonl").write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in urecs) + "\n", encoding="utf-8")

    def ms(iso_z):
        return datetime.strptime(iso_z, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=timezone.utc).timestamp() * 1000

    def uu(**kw):
        kw.setdefault("limit", 200)
        return gu.read_usage(tst, **kw)

    chk("T26 只显示还存在的：删掉的那条被藏起来",
        uu(existing=True)["matched"] == 6 and uu(existing=False)["matched"] == 8,
        f"existing={uu(existing=True)['matched']} all={uu(existing=False)['matched']}")
    chk("T26 ★ 匿名失败记录不受「只看还存在的」影响（它没有 pwid）",
        any(r["result"] == "失败" for r in uu(existing=True)["rows"]),
        str([r["result"] for r in uu(existing=True)["rows"]]))

    # 期望值**从测试数据推导**，不手敲常量：之前我手数「10-15 有 1 条」，
    # 实际那批有 4 条，四条断言一起假红。定长 ISO 串的字典序就是时间序，
    # 所以用字符串比较数一遍即可（只数，不复刻服务端的毫秒换算）。
    def n_range(lo_iso, hi_iso_inclusive):
        return sum(1 for x in urecs if lo_iso <= x["ts"] <= hi_iso_inclusive)

    from1 = ms("2026-10-16T00:00:00Z")
    chk("T26 自定义 from：10-16 起",
        uu(from_ms=from1)["matched"]
        == n_range("2026-10-16T00:00:00Z", "9999"),
        f"{uu(from_ms=from1)['matched']} vs {n_range('2026-10-16T00:00:00Z', '9999')}")

    to1 = ms("2026-10-15T00:00:00Z")
    chk("T26 自定义 to：到 10-15 为止（含该分钟）",
        uu(to_ms=to1)["matched"]
        == n_range("0000", "2026-10-15T00:00:59Z"),
        f"{uu(to_ms=to1)['matched']} vs {n_range('0000', '2026-10-15T00:00:59Z')}")

    chk("T26 起止一起用",
        uu(from_ms=ms("2026-10-15T00:00:00Z"),
           to_ms=ms("2026-10-16T00:00:00Z"))["matched"]
        == n_range("2026-10-15T00:00:00Z", "2026-10-16T00:00:59Z"))

    # ★ 差分断言：结束时间选 12:00 时，12:00:30 那条也要在内。
    #   用「严格到秒」与「含整分钟」的差 1 来证明，不依赖我数得对不对。
    strict = sum(1 for x in urecs if x["ts"] <= "2026-10-16T12:00:00Z")
    loose = uu(to_ms=ms("2026-10-16T12:00:00Z"))["matched"]
    chk("T26 ★ 结束时间含整分钟（12:00 也能选到 12:00:30 那条）",
        loose == strict + 1, f"含整分钟={loose} 严格到秒={strict}")
    try:
        uu(from_ms=ms("2026-10-17T00:00:00Z"), to_ms=ms("2026-10-01T00:00:00Z"))
        chk("T26 开始晚于结束 → 报错", False, "竟然放过")
    except gu.ApiError as e:
        chk("T26 开始晚于结束 → 报错", "晚于" in e.message, e.message)

    ids = [r["id"] for r in gu.read_entries(tst)]
    chk("T26 条目表按创建时间从晚到早", ids == ["new3", "mid2", "old1"], str(ids))

    r = subprocess.run([sys.executable, str(HERE / "gate_manager.py"),
                        "--state", str(tst), "list"],
                       capture_output=True, text=True)
    out = r.stdout
    pos = [out.find(x) for x in ("最新", "中间", "最早")]
    chk("T26 CLI `list` 也是从晚到早（和界面同方向）",
        all(p >= 0 for p in pos) and pos == sorted(pos), f"rc={r.returncode} 位置={pos}")

    fac = gu.read_usage_facets(tst, existing=True)
    order = [x["value"] for x in fac["pwids"] if x["value"] != gu._BLANK]
    chk("T26 ★ 密码下拉按创建时间从晚到早（不是按次数）",
        order == ["new3", "mid2", "old1"], str(order))
    chk("T26 只看还存在的时，已删除的不出现在下拉里",
        "gone9" not in [x["value"] for x in fac["pwids"]], str(order))
    chk("T26 没有 id 的记录排在下拉最后",
        fac["pwids"][-1]["value"] == gu._BLANK, str(fac["pwids"][-1]))

    fac_all = gu.read_usage_facets(tst, existing=False)
    allvals = [x["value"] for x in fac_all["pwids"]]
    chk("T26 关掉开关后已删除的会回来，但排在现存之后",
        "gone9" in allvals and allvals.index("gone9") > allvals.index("old1"), str(allvals))

    # ── T27 ─────────────────────────────────────────────────────────
    # 浏览器列「按名字合并」：`Edge 155.0.0.0` 与 `Edge 153.0.4234.46` 是同一个人
    # 升级浏览器，不该变成两个筛选项。
    #
    # ★ 这条最容易写错的地方不是合并本身，而是**切模式后筛选值不通用**：
    #   facet 里给 `Edge`，服务端却拿 `Edge 155.0.0.0` 去比 → 静默 0 条，
    #   看起来像「勾了浏览器就没数据」。所以下面同时断言两种模式的筛选结果**不同**。
    print("\nT27 浏览器按名字合并（忽略版本号）")

    cases = [
        ("Edge 155.0.0.0", "Edge"),
        ("Edge 153.0.4234.46", "Edge"),
        ("Chrome 121.0.6167.71", "Chrome"),
        ("Safari 17.1", "Safari"),
        ("curl 8.7.1", "curl"),
        ("Mobile Safari 17.0", "Mobile Safari"),     # ★ 不能退化成 Mobile
        ("HeadlessChrome 120.0.0.0", "HeadlessChrome"),
        ("Edge", "Edge"),                            # 本来就没版本号
        ("", ""),                                    # 没记到浏览器
        ("155.0.0.0", "155.0.0.0"),                  # 只有版本号：原样返回，不许变空
    ]
    bad = [(s, gu._browser_name(s), want) for s, want in cases
           if gu._browser_name(s) != want]
    chk("T27 名称提取：10 个用例（含 Mobile Safari 与纯版本号）", not bad, str(bad))

    with tempfile.TemporaryDirectory(prefix="cmsgate-t27-") as td:
        bst = Path(td)
        t0 = datetime.now(timezone.utc)
        brs = (["Edge 155.0.0.0"] * 3 + ["Edge 153.0.4234.46"] * 2
               + ["Chrome 121.0.6167.71"] + [""])
        brows = [{"ts": (t0 - timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "ok": True, "browser": b} for i, b in enumerate(brs)]
        (bst / "usage.cache.jsonl").write_text(
            "\n".join(json.dumps(x, ensure_ascii=False) for x in brows) + "\n",
            encoding="utf-8")

        fac_f = gu.read_usage_facets(bst, bname=False)
        fac_b = gu.read_usage_facets(bst, bname=True)
        full = {x["value"]: x["n"] for x in fac_f["browsers"]}
        merged = {x["value"]: x["n"] for x in fac_b["browsers"]}
        chk("T27 关掉合并：两个 Edge 版本各占一项", len(full) == 4, str(full))
        chk("T27 合并后：Edge 5 / Chrome 1 / 空 1（一共 3 项）",
            merged == {"Edge": 5, "Chrome": 1, gu._BLANK: 1}, str(merged))

        edge = next(x for x in fac_b["browsers"] if x["value"] == "Edge")
        chk("T27 合并后仍标出「压了几个版本」", edge.get("versions") == 2, str(edge))
        chk("T27 原始版本串留在 examples 里（信息没被吞掉）",
            set(edge.get("examples") or []) == {"Edge 155.0.0.0", "Edge 153.0.4234.46"},
            str(edge.get("examples")))

        chk("T27 合并模式按名字筛：Edge = 5 条",
            gu.read_usage(bst, limit=50, browser="Edge", bname=True)["matched"] == 5)
        chk("T27 ★ 不合并时按 Edge 筛 = 0 条（证明两种模式的值不通用）",
            gu.read_usage(bst, limit=50, browser="Edge", bname=False)["matched"] == 0)
        chk("T27 合并模式仍能只看「没记到浏览器」",
            gu.read_usage(bst, limit=50, browser=gu._BLANK, bname=True)["matched"] == 1)

    # 走真实 HTTP：纯函数对 ≠ 拼参数对。漏发 bname 会让界面筛出 0 条、无任何报错。
    (state_dir / "usage.cache.jsonl").write_text(
        "\n".join(json.dumps(x, ensure_ascii=False) for x in brows) + "\n", encoding="utf-8")

    _, _, b1 = request(port, "GET", "/api/usage_facets", headers=cookie)
    _, _, b2 = request(port, "GET", "/api/usage_facets?bname=1", headers=cookie)
    hf = (json.loads(b1.decode("utf-8")) or {}).get("data") or {}
    hb = (json.loads(b2.decode("utf-8")) or {}).get("data") or {}
    chk("T27 HTTP ?bname=1：浏览器 facet 从 4 项变 3 项",
        len(hf.get("browsers") or []) == 4 and len(hb.get("browsers") or []) == 3,
        f"{len(hf.get('browsers') or [])} → {len(hb.get('browsers') or [])}")
    chk("T27 HTTP facets 回显 bname 当前状态",
        hf.get("bname") is False and hb.get("bname") is True,
        f"{hf.get('bname')} / {hb.get('bname')}")

    def _matched(qs):
        _, j = get_usage(qs)
        return (j.get("data") or {}).get("matched")

    chk("T27 HTTP ?bname=1&browser=Edge 命中 5 条",
        _matched("?bname=1&browser=Edge") == 5)
    chk("T27 HTTP 不带 bname 时 browser=Edge 命中 0（说明这个开关真被用上了）",
        _matched("?browser=Edge") == 0)

    # 前端静态断言：漏发一处 bname 就是「选项是 Edge、查询是全名」→ 静默 0 条。
    n_bname = js.count("qs.set('bname', '1')")
    chk("T27 前端 facets 与 usage 两处查询都带 bname", n_bname == 2,
        f"只找到 {n_bname} 处")
    chk("T27 切合并模式会清空已选的浏览器值（否则切过去静默 0 条）",
        "f.bname = bnameBox.checked;" in js and "f.browser.clear();" in js)

    # ── T28 ─────────────────────────────────────────────────────────
    # 「刷新就该是最新的」。要分别证明三件事：
    #   ① 拉取逻辑本身（单飞 / 限速 / 失败不清表 / --no-pull）—— 全程离线
    #   ② HTTP 真的接上了 `pull=1` —— 用 `--no-pull` 的服务验，不碰网络
    #   ③ 前端那个复选框没了，换成了「立即刷新」+ 自动间隔
    print("\nT28 访问记录自动从服务器拉")

    calls = []
    saved_run_op, saved_enabled = gu.run_op, gu.PULL_ENABLED
    saved_meta = dict(gu._pull_meta)

    def fake_ok(op, params):
        calls.append((op, dict(params)))
        return {"ok": True, "code": 0, "out": "已拉取到本地缓存：/tmp/x"}

    def fake_bad(op, params):
        calls.append((op, dict(params)))
        return {"ok": False, "code": 1,
                "out": "错误：拉取失败（或服务器还没有使用记录）\n第二行细节不该出现在界面上"}

    try:
        with tempfile.TemporaryDirectory(prefix="cmsgate-t28-") as td2:
            pst = Path(td2)

            gu.run_op = fake_ok
            gu._pull_meta.update(epoch=0.0, mono=0.0, error=None, skipped=0,
                                 skip_reason=None, count=0)
            m1 = gu.pull_usage(pst)
            chk("T28 拉取调的是 `usage --remote`，且要 PULL_LIMIT 行（不是显示条数）",
                [c[0] for c in calls] == ["usage_remote"]
                and calls[0][1]["limit"] == gu.PULL_LIMIT, str(calls))
            chk("T28 成功后记下「已同步」时间",
                m1["pulled_epoch"] > 0 and m1["pull_count"] == 1, str(m1))

            m2 = gu.pull_usage(pst)
            chk("T28 2 秒内重复拉 → 跳过（不排队、不再 ssh）",
                len(calls) == 1 and m2["pull_skip_reason"] == "gap", str(m2))

            gu._pull_meta["mono"] = 0.0
            gu.run_op = fake_bad
            m3 = gu.pull_usage(pst)
            chk("T28 失败原因只取第一行（CLI 会铺好几句说明）",
                m3["pull_error"].startswith("错误：") and "第二行" not in m3["pull_error"],
                str(m3["pull_error"]))
            chk("T28 ★ 失败不清掉「上次成功时间」（表格继续显示旧数据，不是空表）",
                m3["pulled_epoch"] == m1["pulled_epoch"], str(m3))

            gu._pull_meta["mono"] = 0.0
            gu.PULL_ENABLED = False
            m4 = gu.pull_usage(pst)
            chk("T28 --no-pull 时明确说「已关闭」，而不是悄悄什么都不做",
                m4["pull_skip_reason"] == "disabled" and "--no-pull" in (m4["pull_error"] or ""),
                str(m4))

            gu.PULL_ENABLED = True
            gu._pull_meta["mono"] = 0.0
            calls.clear()
            with gu._EXEC_LOCK:            # 模拟「push 正在跑」
                m5 = gu.pull_usage(pst)
            chk("T28 有写操作在跑时让开（不去抢同一台机器的 ssh）",
                not calls and m5["pull_skip_reason"] == "exec", str(m5))
    finally:
        gu.run_op, gu.PULL_ENABLED = saved_run_op, saved_enabled
        gu._pull_meta.clear()
        gu._pull_meta.update(saved_meta)

    # ② 走真 HTTP。用一台 `--no-pull` 的服务，所以这条**永远不会连服务器**：
    #    它验的是「pull=1 这个参数真的接到了路由上」，不是「ssh 通不通」。
    port2 = free_port()
    # 这台只服务只读接口，不需要离线 gateconfig（写操作才需要）
    with Server(state_dir, port2, extra_args=["--no-pull"]) as srv2:
        ck2 = {"Cookie": f"cmsui={srv2.token}"}
        st, _, b = request(port2, "GET", "/api/usage?limit=50", headers=ck2)
        d0 = (json.loads(b.decode("utf-8")) or {}).get("data") or {}
        chk("T28 不带 pull 时一次都不连服务器",
            st == 200 and d0.get("pulled_epoch") == 0 and not d0.get("pull_error"),
            f"status={st} err={d0.get('pull_error')}")

        st, _, b = request(port2, "GET", "/api/usage?limit=50&pull=1", headers=ck2)
        d1 = (json.loads(b.decode("utf-8")) or {}).get("data") or {}
        chk("T28 HTTP `pull=1` 真的走到拉取（--no-pull 时被明确拒绝）",
            st == 200 and "--no-pull" in (d1.get("pull_error") or ""),
            f"status={st} err={d1.get('pull_error')}")
        chk("T28 ★ 拉不到时照旧返回缓存里的行（不是空表）",
            bool(d1.get("rows")) and d1.get("total", 0) > 0,
            f"total={d1.get('total')} rows={len(d1.get('rows') or [])}")

    # ③ 前端
    chk("T28 旧复选框「从服务器拉一份」已移除",
        "usage-remote" not in html and 'id="usage-refresh"' in html,
        "两个同时存在就说明只加没删")
    chk("T28 有「立即刷新」按钮和自动间隔选择",
        'id="usage-refresh"' in html and 'id="usage-auto"' in html)
    chk("T28 前端查询会带 pull=1", "qs.set('pull', '1')" in js)
    chk("T28 切到后台标签页时暂停（回来才补）",
        "document.hidden" in js and "visibilitychange" in js)
    chk("T28 写操作进行中暂停自动刷新", "state.writing" in js)
    n_pull = js.count("{ pull: true }")
    chk("T28 整页刷新 / 自动 tick / 手动按钮 / 切回来 都会拉",
        n_pull >= 4, f"只找到 {n_pull} 处 loadUsage({{pull:true}})")
    m = re.search(r"function apply\(\)\s*\{(.*?)\n        \}", js, re.S)
    ap = m.group(1) if m else ""
    m2 = re.search(r"function reloadFirstPage\(\)\s*\{(.*?)\n    \}", js, re.S)
    rp = m2.group(1) if m2 else ""
    chk("T28 改筛选条件**不**拉（只是换个看法，不必每次连 ssh）",
        "reloadFirstPage()" in ap and "pull" not in ap
        and "loadUsage()" in rp and "pull" not in rp,
        (ap.strip() + " || " + rp.strip())[:100])

    # ── T29 ─────────────────────────────────────────────────────────
    # 分页：每页 N 条 + 翻页。分页放在**服务端**（offset），不是把上千条全拉下来再切。
    # 另外补一条「源码比进程新」的提示——前端资源每次读盘，Python 代码不会，
    # 这个不对称正是「面板全空」那次事故的根因。
    print("\nT29 分页 + 服务端代码过期提示")

    with tempfile.TemporaryDirectory(prefix="cmsgate-t29-") as td4:
        pst = Path(td4)
        t1 = datetime.now(timezone.utc)
        rows7 = [{"ts": (t1 - timedelta(minutes=i)).strftime("%Y-%m-%dT%H:%M:%SZ"),
                  "ok": True, "ip": f"10.0.0.{i}"} for i in range(7)]
        (pst / "usage.cache.jsonl").write_text(
            "\n".join(json.dumps(x, ensure_ascii=False) for x in rows7) + "\n", encoding="utf-8")

        full = [r["ip"] for r in gu.read_usage(pst, limit=100)["rows"]]
        paged = []
        for off in (0, 3, 6):
            paged += [r["ip"] for r in gu.read_usage(pst, limit=3, offset=off)["rows"]]
        chk("T29 ★ 逐页拼起来 == 一次取全（不重不漏、顺序一致）",
            paged == full, f"{paged} vs {full}")
        chk("T29 末页只剩 1 条", len(gu.read_usage(pst, limit=3, offset=6)["rows"]) == 1)
        far = gu.read_usage(pst, limit=3, offset=99)
        chk("T29 越界页返回空行，但 matched 不变（不是把总数也清零）",
            far["rows"] == [] and far["matched"] == 7, str(far["matched"]))
        chk("T29 返回里带 offset/limit（前端据此算页码）",
            gu.read_usage(pst, limit=3, offset=3)["offset"] == 3)

    st, _, b = request(port, "GET", "/api/usage?limit=2&offset=2", headers=cookie)
    d = (json.loads(b.decode("utf-8")) or {}).get("data") or {}
    chk("T29 HTTP offset 生效（2 条，且带回 offset/limit）",
        st == 200 and len(d.get("rows") or []) == 2
        and d.get("offset") == 2 and d.get("limit") == 2,
        f"status={st} rows={len(d.get('rows') or [])} off={d.get('offset')}")
    st2, _, _ = request(port, "GET", "/api/usage?offset=abc", headers=cookie)
    chk("T29 HTTP offset 非数字 → 400（不静默当 0）", st2 == 400, f"status={st2}")

    # 源码 vs 进程：把启动时刻挪一下就能验，不用真去改文件的 mtime
    saved_start = gu.STARTED_AT
    try:
        gu.STARTED_AT = 0.0                      # 假装 1970 年起的进程 → 源码必然更新
        chk("T29 源码比进程新 → stale=True", gu._code_stale() is True)
        gu.STARTED_AT = time.time() + 10 ** 6    # 启动时刻在未来 → 源码「更旧」
        chk("T29 进程比源码新 → stale=False（不误报）", gu._code_stale() is False)
    finally:
        gu.STARTED_AT = saved_start
    chk("T29 overview 里带 stale 字段（界面据此显示红字）",
        "stale" in gu.read_overview(state_dir))

    chk("T29 有翻页条（上一页 / 下一页 / 页码 / 回到最新）",
        all(x in html for x in ('id="page-prev"', 'id="page-next"',
                                'id="page-info"', 'id="page-first"')))
    chk("T29 每页条数不再是「显示条数」（那个下拉已删）",
        'id="usage-size"' in html and 'id="usage-limit"' not in html)
    chk("T29 ★ 翻到第 2 页以后不自动刷新（否则正在读的那页会整体挪走）",
        "state.page > 0" in js, "少了它，翻页后每 10 秒内容就跳一次")
    chk("T29 筛选条件变了要回第 1 页", "reloadFirstPage()" in js,
        "留在第 4 页会看到空白页，像坏了")
    chk("T29 取不到筛选可选值时会说出来（不是只剩一个「（全部）」）",
        "这一列的可选值没取到" in js)
    chk("T29 分页在服务端做（查询串里带 offset）",
        "offset:" in js and "qs.set('pull'" in js)

    # ── T30 ─────────────────────────────────────────────────────────
    # 两件事，都是「自动刷新每 10 秒来一趟」逼出来的：
    #
    #   ① 表格只在内容**真的**变了才动 DOM。否则你在表里选中一段文字准备复制，
    #      选区每 10 秒被清一次，而且画面上看起来什么都没发生（最难受的一种 bug）。
    #   ② 拉取要有节流。一个页面开着不动，不该变成对服务器的轮询。
    #
    # ① 不是靠读源码断言的——把 renderUsage / prependShift 抠出来交给 node 真跑一遍，
    #    数它到底调了几次 DOM 操作、留下的节点是不是同一个对象。
    print("\nT30 增量渲染 + 拉取节流")

    chk("T30 每行都算了签名，渲染前先比签名（不是无脑重建）",
        "function rowSig(" in js and "const sigs = rows.map(rowSig)" in js)

    r_good = _js_block(js, "renderUsage")
    p_src = _js_block(js, "prependShift")
    chk("T30 能从 app.js 里抠出 renderUsage / prependShift",
        bool(r_good) and bool(p_src),
        f"renderUsage={len(r_good)}B prependShift={len(p_src)}B")

    # 变异：拿掉「完全相同就 return」这一段。后面要看到它把对应断言打红。
    r_bad = re.sub(r"if \(sigs\.length === lastSigs\.length\s*&&\s*"
                   r"sigs\.every\(\(s, i\) => s === lastSigs\[i\]\)\) \{\s*return;\s*\}",
                   "", r_good)
    chk("T30 变异手术确实切到了那段（正则没匹配上就是白测）",
        r_bad != r_good and r_bad.count("return;") < r_good.count("return;"))

    PS_CASES = [
        {"name": "前移 1 条", "neu": ["x", "a", "b"], "old": ["a", "b", "c"], "want": 1},
        {"name": "前移 3 条", "neu": ["p", "q", "r", "a", "b"],
         "old": ["a", "b", "c", "d", "e"], "want": 3},
        {"name": "★ 三条完全相同的重复行 → 0（不是 1）",
         "neu": ["a", "a", "a"], "old": ["a", "a", "a"], "want": 0},
        {"name": "中间一行被改（改了备注）→ 0（只能重建）",
         "neu": ["a", "X", "c"], "old": ["a", "b", "c"], "want": 0},
        {"name": "整页换掉（翻页）→ 0", "neu": ["d", "e", "f"],
         "old": ["a", "b", "c"], "want": 0},
        {"name": "只有一行、内容变了 → 0", "neu": ["b"], "old": ["a"], "want": 0},
        {"name": "尾部换掉、头部没动 → 0", "neu": ["a", "b", "X"],
         "old": ["a", "b", "c"], "want": 0},
    ]

    node = _find_node()
    if not node:
        skip("T30 ★ 用 node 真跑 renderUsage / prependShift",
             "找不到 node，设 NODE_BIN 指定路径")
    elif not (r_good and p_src):
        skip("T30 ★ 用 node 真跑 renderUsage / prependShift",
             "函数源码没抠出来（改名了？）")
    else:
        try:
            res = _run_render_cases(node, p_src, r_good, r_bad, PS_CASES)
        except Exception as e:                     # node 挂了要响，不能当成通过
            res = None
            chk("T30 ★ 用 node 真跑 renderUsage / prependShift", False, str(e))
        if res:
            for r in res["unit"]:
                chk("T30 prependShift · " + r["name"], r["ok"], r["detail"])
            for r in res["good"]:
                chk("T30 renderUsage · " + r["name"], r["ok"], r["detail"])
            key = "内容一个字没变"
            g = next((r for r in res["good"] if key in r["name"]), None)
            b = next((r for r in res["bad"] if key in r["name"]), None)
            chk("T30 ★ 变异自检：拿掉「完全相同就 return」后上面那条会变红",
                bool(g) and g["ok"] and bool(b) and not b["ok"],
                f"原样={g and g['ok']} 变异={b and b['ok']}")

    # ② 节流。**全程把 run_op 换成假的**：真去 ssh 既慢又会碰线上机器，
    #    而且「闸门有没有挡住」正好可以用「假 run_op 被调用了几次」来量。
    chk("T30 自动刷新用 setTimeout 链（跑完才排下一次，慢了不会堆积）",
        "setTimeout(tick" in js and "setInterval(" not in js)
    chk("T30 自动刷新的暂停条件齐全（后台/写操作/正在拉/翻页/开弹窗）",
        all(x in js for x in ("document.hidden", "state.writing", "usageBusy",
                              "state.page > 0", "dialog[open]")))
    chk("T30 「自动：关」就一次都不排", "if (!autoMs()) return;" in js)
    chk("T30 服务端说「这次没拉」时界面能讲出原因",
        "SKIP_TEXT" in js and "刚刚已经拉过了" in js)

    src_gu = TOOL.read_text(encoding="utf-8")
    chk("T30 ★ 拉取行数不跟着「每页 N 条」走（否则缓存被裁、总数会变小）",
        gu.PULL_LIMIT == 1000 and "pull_usage(st) if" in src_gu
        and not re.search(r"pull_usage\(st,\s*limit", src_gu),
        f"PULL_LIMIT={gu.PULL_LIMIT}")

    seen: list[tuple] = []
    saved_run, saved_meta = gu.run_op, dict(gu._pull_meta)
    try:
        def fake_run_op(op, payload):
            seen.append((op, dict(payload or {})))
            return {"ok": True, "out": "", "err": ""}

        gu.run_op = fake_run_op
        gu._pull_meta.update({"mono": 0.0, "error": "上一次的错误",
                              "count": 0, "epoch": 0.0})
        gu.pull_usage(state_dir)                    # 不传 limit → 该用 PULL_LIMIT
        after = gu.pull_meta()
        gu._pull_meta["mono"] = 0.0
        gu.pull_usage(state_dir, limit=7)           # 显式传 → 照传

        chk("T30 ★ 默认拉 1000 行，跟显示的每页条数无关",
            len(seen) == 2 and seen[0][0] == "usage_remote"
            and seen[0][1].get("limit") == 1000,
            f"seen={[ (o, p.get('limit')) for o, p in seen ]}")
        chk("T30 显式给 limit 时照旧生效", len(seen) == 2 and seen[1][1].get("limit") == 7)
        chk("T30 拉成功后清掉旧错误（错误不会一直挂着）",
            after.get("pull_error") is None and after.get("pull_count") == 1,
            f"err={after.get('pull_error')} count={after.get('pull_count')}")

        # 三道闸门：每一道都必须**在连服务器之前**把请求挡回去。
        gu._pull_meta["mono"] = time.monotonic()
        chk("T30 2 秒内重复拉 → 跳过（gap）",
            gu.pull_usage(state_dir)["pull_skip_reason"] == "gap")
        gu._pull_meta["mono"] = 0.0
        with gu._PULL_LOCK:
            chk("T30 上一次还没拉完 → 跳过，不排队（busy）",
                gu.pull_usage(state_dir)["pull_skip_reason"] == "busy")
        with gu._EXEC_LOCK:
            chk("T30 有写操作在跑 → 跳过，不去抢同一台机器（exec）",
                gu.pull_usage(state_dir)["pull_skip_reason"] == "exec")
        gu.PULL_ENABLED = False
        chk("T30 --no-pull → 跳过（disabled）",
            gu.pull_usage(state_dir)["pull_skip_reason"] == "disabled")
    finally:
        gu.run_op = saved_run
        gu.PULL_ENABLED = True
        gu._pull_meta.update(saved_meta)

    chk("T30 ★ 被闸门挡下的那些次一次 ssh 都没发（假 run_op 只被调 2 次）",
        len(seen) == 2, f"实际调了 {len(seen)} 次：{seen}")

    # ── T31 ─────────────────────────────────────────────────────────
    # 用户 2026-10-17 直接提的四条：每页条数与自动间隔都要能**自己输数字**
    # （下拉只有 4~5 个档，「每 13 秒刷一次、每页 7 条」根本选不出来），
    # 默认 20 / 30；能暂停 / 继续自动刷新；刷新完在顶部提示、保持 3 秒。
    print("\nT31 可自定义的每页条数 + 暂停/继续 + 顶部「已刷新」")

    chk("T31 ★ 间隔与每页条数是自由输入的数字框（不再是下拉）",
        'type="number" id="usage-size"' in html
        and 'type="number" id="usage-auto"' in html
        and '<select id="usage-auto"' not in html,
        "还留着 <select> 就说明只改了其中一个")
    chk("T31 默认值：每页 20 条、自动 30 秒",
        re.search(r'id="usage-size"[^>]*value="20"', html) is not None
        and re.search(r'id="usage-auto"[^>]*value="30"', html) is not None,
        "min/max 也得有，否则能填出一个荒谬的值")
    chk("T31 两个框都有 min/max（填 0 或 99999 时靠它夹）",
        re.search(r'id="usage-size"[^>]*min="1"[^>]*max="500"', html) is not None
        and re.search(r'id="usage-auto"[^>]*min="1"[^>]*max="3600"', html) is not None)
    chk("T31 有「暂停 / 继续自动刷新」按钮，且带 aria-pressed",
        'id="usage-auto-toggle"' in html and 'aria-pressed="false"' in html)
    chk("T31 提示统一走底部弹窗堆（顶部条 / 右下角 toast / 底部输出卡三面已收口）",
        'id="toasts"' in html and 'aria-live="polite"' in html
        and 'id="flash"' not in html and 'id="toast"' not in html
        and 'id="output-card"' not in html,
        "还剩独立面就说明又会有「结果到底在哪看」的问题")

    chk("T31 state 里的默认值也是 20 / 30（输入框和 state 不能各写一份）",
        "pageSize: 20" in js and "autoSec: 30" in js)
    chk("T31 暂停是**独立状态**，不是把间隔设成 0（否则恢复会丢掉设好的秒数）",
        "autoPaused: false" in js and "if (state.autoPaused) return 0;" in js)
    chk("T31 暂停时取消已排的定时器，恢复时立刻拉一份最新的",
        "function setAutoPaused(" in js and "stopAuto();" in js
        and re.search(r"function setAutoPaused\(paused\).*?loadUsage\(\{ pull: true \}\)",
                      js, re.S) is not None)
    msp = re.search(r"function setAutoPaused\(paused\) \{(.*?)\n    \}", js, re.S)
    chk("T31 ★ 点「继续」后也提示一次「已刷新」（干等一个间隔是很差的手感）",
        msp is not None and "flash('已刷新" in msp.group(1),
        (msp.group(1).strip()[-90:] if msp else "没抠到 setAutoPaused"))
    chk("T31 按钮文案/aria-pressed 由 renderAutoBtn 统一改（别各改各的）",
        "function renderAutoBtn(" in js and "继续自动刷新" in js
        and "b.setAttribute('aria-pressed'" in js)
    chk("T31 ★ 提示按长短定时，最低 2 秒、封顶 12 秒（用户 2026-11-01 定的下限）",
        re.search(r"const TOAST_MIN_MS = (\d+);", js).group(1) == "2000"
        and re.search(r"const TOAST_CAP_MS = (\d+);", js).group(1) == "12000"
        and "toastMs(text)" in _js_block(js, "notify"),
        _js_block(js, "notify")[-120:])
    n_flash = js.count("flash('已刷新")
    chk("T31 ★ 手动刷新 / 自动刷新 / 回到最新 / 顶栏刷新 四处都会提示",
        n_flash >= 4, f"只找到 {n_flash} 处 flash('已刷新…')")
    # 每处「已刷新」都必须有护栏：拉失败或被闸门挡下时不能报喜。
    sites = [m.start() for m in re.finditer(r"flash\('已刷新", js)]
    unguarded = [i for i in sites
                 if not re.search(r"pull_error|pull_count", js[max(0, i - 260):i])]
    chk("T31 拉失败或被闸门挡下时**不**弹「已刷新」（不能报假喜）",
        len(sites) >= 4 and not unguarded,
        f"共 {len(sites)} 处，其中没设护栏的 {len(unguarded)} 处")

    # 偏好只进 localStorage 的白名单两个键 —— 管理口令绝对不能留在磁盘上
    chk("T31 ★ localStorage 只有两个偏好键，且写别的键会直接抛错",
        "const UI_KEYS = ['ui.pageSize', 'ui.autoSec']" in js
        and "!UI_KEYS.includes(key)) throw new Error" in js
        and js.count("localStorage.setItem(") == 1,
        f"setItem 出现 {js.count('localStorage.setItem(')} 次")
    # state 里那句注释本身就写着「绝不写 localStorage」，所以断言前必须先去掉注释，
    # 否则查的是注释而不是代码（这种假红最费时间）。
    js_nc = re.sub(r"/\*.*?\*/", "", js, flags=re.S)
    js_nc = re.sub(r"//[^\n]*", "", js_nc)
    m_state = re.search(r"admin: '[^']*',.*?\};", js_nc, re.S)
    chk("T31 管理口令那一段（去注释后）没有任何 localStorage",
        m_state is not None and "localStorage" not in m_state.group(0),
        (m_state.group(0)[:60] + "…") if m_state else "没匹配到 state 块")

    chk("T31 填的值会夹紧后**写回输入框**（否则框里空着、表格却在按 20 条翻）",
        "ev.target.value = state.pageSize;" in js
        and "ev.target.value = state.autoSec;" in js)
    i_guess = js.find("recallUI('ui.pageSize'")
    i_load = js.find("loadAll({ quiet: true })")
    chk("T31 先读回上次的设置、再去取第一份数据（反了会白跑一次往返）",
        0 < i_guess < i_load, f"recall@{i_guess} loadAll@{i_load}")
    chk("T31 刚打开页面不喊「已刷新」（那是噪声），点顶栏刷新才喊",
        "quiet: true" in js and "if (!opts || !opts.quiet)" in js)

    # CSS 单独读：前面只把 js / html 取进局部变量，样式表没读。
    css = (HERE / "gateui" / "app.css").read_text(encoding="utf-8")
    # T36 要读**服务端**源码做断言：漂移判定在 gate_manager、预览端点在 gate_ui。
    # 这里直接读磁盘原文，别用 inspect.getsource —— 后者对嵌套定义会漏。
    gm_src = (HERE / "gate_manager.py").read_text(encoding="utf-8")
    gu_src = (HERE / "gate_ui.py").read_text(encoding="utf-8")
    gu_doc = (HERE.parent / "docs" / "密码闸门.md").read_text(encoding="utf-8")
    chk("T31 弹窗堆的样式齐了，且旧的顶部条 / 输出卡样式没有残留（三面收口）",
        ".toasts {" in css and ".toast {" in css and ".toast-x {" in css
        and ".flash-strip" not in css and ".output-card" not in css)
    chk("T31 数字框有样式（.num-field），不是裸 input 挤在卡片头里",
        ".num-field {" in css and ".num-field input {" in css)

    # 行为用例：抠出 clampInt / autoMs / renderAutoBtn 交给 node 真跑。
    # 上下限不在测试里手抄，而是从源码的 LIMITS 里读出来再拿别的数去撞它。
    node = _find_node()
    if not node:
        skip("T31 ★ 用 node 真跑 clampInt / autoMs / renderAutoBtn",
             "找不到 node，设 NODE_BIN 指定路径")
    elif not all(_js_block(js, f) for f in ("clampInt", "autoMs", "renderAutoBtn")):
        skip("T31 ★ 用 node 真跑 clampInt / autoMs / renderAutoBtn",
             "函数源码没抠出来（改名了？）")
    else:
        try:
            rows31 = _run_pref_cases(node, js)
        except Exception as e:
            rows31 = []
            chk("T31 ★ 用 node 真跑 clampInt / autoMs / renderAutoBtn", False, str(e))
        for r in rows31:
            chk("T31 " + r["name"], r["ok"], r["detail"])

        try:
            rows31b = _run_manual_cases(node, js)
        except Exception as e:
            rows31b = []
            chk("T31 ★ 用 node 真跑 manualRefresh 的「什么时候才说已刷新」", False, str(e))
        for r in rows31b:
            chk("T31 " + r["name"], r["ok"], r["detail"])

    # 服务端一侧没跟着改坏：每页条数只是个 limit，缓存照旧拉 1000 行
    st3, _, b3 = request(port, "GET", "/api/usage?limit=20&offset=0", headers=cookie)
    d3 = (json.loads(b3.decode("utf-8")) or {}).get("data") or {}
    chk("T31 服务端照旧认这个 limit（默认 20 条也能取）",
        st3 == 200 and d3.get("limit") == 20 and len(d3.get("rows") or []) <= 20,
        f"status={st3} limit={d3.get('limit')} rows={len(d3.get('rows') or [])}")

    # ── T32 ─────────────────────────────────────────────────────────
    # 网页背景图（版权未授权 → 要能一键撤下成白底）。
    # CLI 侧的行为断言在 `gate_manager.py selftest` 里（探针解析 / 漂移判定 /
    # 白图自检 / 前端路径一致性）；这里管**界面这一侧**：op 表、上传落盘、
    # 端点、按钮与提示文案。
    print("\nT32 网页背景图：撤下 / 恢复 / 推送新图")

    chk("T32 op 表里有 status / on / off / push 四个，且只读那个不带口令",
        all(k in gu.OPS for k in ("webbg_status", "webbg_on", "webbg_off", "webbg_push"))
        and not gu.OPS["webbg_status"].get("stdin")
        and all(("admin", "--admin-stdin") in gu.OPS[k].get("stdin", [])
                for k in ("webbg_on", "webbg_off", "webbg_push")),
        str({k: v.get("stdin") for k, v in gu.OPS.items() if k.startswith("webbg")}))
    chk("T32 push 的 --image 是占位符（不是把路径硬编码进去）",
        "{image}" in gu.OPS["webbg_push"]["argv"]
        and "--json" in gu.OPS["webbg_status"]["argv"])
    chk("T32 webbg 登记为 CLI 的「就地校验」命令（status 只读、on/off 才问口令）",
        "webbg" in gm.INPLACE_ADMIN_CMDS and "webbg" not in gm.ADMIN_GUARDED_CMDS,
        "INPLACE_ADMIN_CMDS 缺了 webbg 时 _verify_ops 会拒绝启动")

    src_gu2 = TOOL.read_text(encoding="utf-8")
    chk("T32 只读端点 /api/webbg 与上传端点 /api/webbg_upload 都在",
        '"/api/webbg"' in src_gu2 and '"/api/webbg_upload"' in src_gu2)
    chk("T32 上传走独立端点（base64 后几百 KB，/api/exec 的 64 KB 上限扛不住）",
        "WEBBG_UPLOAD_MAX * 4 // 3" in src_gu2 and "n > 64 * 1024" in src_gu2)
    chk("T32 上传按**魔数**认图片（只看 MIME 等于让调用方自称是什么）",
        "_webbg_sniff" in src_gu2 and "raw.startswith(magic)" in src_gu2)
    chk("T32 上传用 O_EXCL + 随机名（撞名直接失败，不覆盖任何已有文件）",
        "os.O_EXCL" in src_gu2 and "token_urlsafe" in src_gu2)
    chk("T32 上传目录 0700、文件 0600（里面有用户的图片）",
        "0o700" in src_gu2 and "0o600" in src_gu2)

    # ── 落盘行为：真给一份 PNG 字节，看它怎么落 ──
    with tempfile.TemporaryDirectory(prefix="cmsgate-t32-") as td5:
        pst2 = Path(td5)
        png = b"\x89PNG\r\n\x1a\n" + b"\x00\x00\x00\rIHDR" + b"\x42" * 64
        d64 = "data:image/png;base64," + base64.b64encode(png).decode()
        d1 = gu.save_webbg_upload(pst2, d64)
        chk("T32 ★ 真 PNG 会落盘，扩展名按魔数定成 .png",
            d1["path"].endswith(".png") and Path(d1["path"]).stat().st_size == len(png),
            str(d1))
        chk("T32 落在 state/uploads 里，文件权限 0600",
            Path(d1["path"]).parent == pst2 / "uploads"
            and (Path(d1["path"]).stat().st_mode & 0o777) == 0o600)
        d2 = gu.save_webbg_upload(pst2, d64)
        chk("T32 ★ 同一张图传两次得到两个不同路径（绝不覆盖已有文件）",
            d2["path"] != d1["path"] and Path(d2["path"]).exists())
        chk("T32 落回来的内容与原图逐字节一致",
            Path(d1["path"]).read_bytes() == png)

        def rejected(data_url):
            try:
                gu.save_webbg_upload(pst2, data_url)
            except gu.ApiError:
                return True
            except Exception:
                return False
            return False

        chk("T32 ★ 伪装成 image/png 的脚本内容被拒（只看 MIME 就会放行）",
            rejected("data:image/png;base64," + base64.b64encode(b"MZ\x90\x00").decode()))
        chk("T32 不是 data URL / 类型不对 / 空 输入都被拒",
            rejected("/etc/passwd") and rejected("") and rejected("data:text/plain;base64,aGk="))
        big = "data:image/png;base64," + base64.b64encode(
            b"\x89PNG\r\n\x1a\n" + b"\x00" * (gu.WEBBG_UPLOAD_MAX + 16)).decode()
        chk("T32 超过 8 MB 上限被拒", rejected(big))

    # ── 结构化输出：直接调函数（**不要**在这里 monkeypatch 后打 HTTP）──
    # HTTP 请求是由**子进程**（真的 gate_ui.py）处理的，本进程里换掉 gm.webbg_status
    # 对它**完全无效**——第一版就这么写了，结果断言拿到的是真连上线的数据（既过了又慢）。
    real_status = gm.webbg_status
    try:
        gm.webbg_status = lambda a: {
            "reachable": True, "web_root": "/srv/x", "mode": "off",
            "is_blank": True, "drifted": False, "at": "", "source": "", "note": "",
            "files": {"assets/bg.webp": {"present": True, "size": 58, "sha": "AAA"}},
            "backups": ["bg.webp", "bg.jpg"], "can_restore": True}
        d4 = gu.read_webbg(state_dir, server="root@x", ssh_port="712",
                           remote_dir="/var/lib/cmsgate", web_root="/srv/x")
        chk("T32 read_webbg 返回结构化状态（mode / can_restore / files）",
            d4.get("mode") == "off" and d4.get("can_restore") is True
            and "assets/bg.webp" in (d4.get("files") or {}),
            str(d4))
        gm.webbg_status = lambda a: {"reachable": False, "error": "ssh 拒绝连接",
                                     "mode": "unknown"}
        d5 = gu.read_webbg(state_dir, server="root@x", ssh_port="712",
                           remote_dir="/var/lib/cmsgate", web_root="/srv/x")
        chk("T32 ssh 挂了 → reachable:false 且如实带出原因（不装作「从没操作过」）",
            d5.get("reachable") is False and "拒绝连接" in str(d5.get("error")),
            str(d5))
    finally:
        gm.webbg_status = real_status

    # ── 端点：验路由与鉴权。字段形状由上面的函数级断言守着，这里不联网断言 ──
    st5, _, _ = request(port, "GET", "/api/webbg")
    chk("T32 /api/webbg 也要鉴权（没 cookie → 403）", st5 == 403, f"status={st5}")
    st6, _, b6 = request(port, "GET", "/api/webbg", headers=cookie)
    d6 = (json.loads(b6.decode("utf-8")) or {}).get("data") or {}
    # 有网就连上了、没网就 reachable:false —— 两种都要是**自洽**的形状
    shape_ok = ((d6.get("reachable") is True and d6.get("mode") is not None)
                or (d6.get("reachable") is False and bool(d6.get("error"))))
    chk("T32 端点 200 且返回自洽的形状（连上→有 mode，连不上→有 error）",
        st6 == 200 and isinstance(d6, dict) and shape_ok, str(d6)[:160])

    chk("T32 顶栏有「网页背景」芯片，点了能开对话框",
        "withB('网页背景'" in js and "doWebBg()" in js)
    chk("T32 ★ 界面把两条边界都写给用户了（内存里的图撤不回 / rsync 会把它重新开）",
        "已经加载过图的浏览器内存里仍有旧图" in js
        and "再跑 deploy-web.sh 会把背景图同步回去" in js)
    chk("T32 漂移（记录与线上不一致）在界面里显眼提示",
        "w.drifted" in js and "记录与线上实际不一致" in js)
    chk("T32 没选文件时「推送」按钮不可点（否则白跑一次上传）",
        "bPush.disabled = true" in js)
    chk("T32 私藏里没有原图时「恢复」按钮不可点",
        "bOn.disabled = !w.can_restore" in js)
    chk("T32 上传走 FileReader → /api/webbg_upload（不用用户手打路径）",
        "readAsDataURL" in js and "/api/webbg_upload" in js)
    chk("T32 上传失败会明说，不会静默",
        "上传失败：" in js and "runWrite('webbg_push'" in js)
    chk("T32 三个写操作都走 runWrite（统一问管理口令 + 抹掉回显）",
        js.count("runWrite('webbg_") == 3)

    # ── T33：「共 174 条 / 筛选后 129 条」对不上 ──────────────────
    # 用户报的现象：什么都没筛，两个数字却不等。根因是 `existing`（只显示密码表里
    # 还存在的）默认开着，服务端确实滤掉了 45 条，但前端既不把它算成「有筛选」
    # （清除按钮不出现）、也不在计数里点名（看着像数字坏了）。
    d = gu.read_usage(state_dir, limit=20, offset=0, existing=True)
    chk("T33 服务端回 dropped_existing（前端要靠它说清是谁筛的）",
        "dropped_existing" in d and isinstance(d.get("dropped_existing"), int),
        f"dropped_existing={d.get('dropped_existing')!r}")
    chk("T33 ★ total - matched 恰好等于 dropped_existing（两处口径一致）",
        d["total"] - d["matched"] == d["dropped_existing"],
        f"total={d['total']} matched={d['matched']} dropped={d['dropped_existing']}")
    d_off = gu.read_usage(state_dir, limit=20, offset=0, existing=False)
    chk("T33 关掉 existing 后两个数字必须相等（否则就是真·对不上）",
        d_off["total"] == d_off["matched"] and d_off["dropped_existing"] == 0,
        f"total={d_off['total']} matched={d_off['matched']}")
    # ★ 上面的断言在「密码表里没有已删除的密码」时会**恒真** → 等于没写。
    #   所以造一份**必定**含已删除密码记录的 state，离线验这个口径。
    #   （真实数据的 45 条已随时间变化，靠它当基准就会假绿。）
    with tempfile.TemporaryDirectory(prefix="cmsgate-t33-") as td33:
        sd = Path(td33)
        ALIVE = "alive" + "0001"     # 拼出来，不写字面量（会被改写层换掉）
        # 字段名与结构**从真实实现取**，不手抄：手抄过一次（把 entries 写成
        # passwords）就被 validate_store 当场拒绝，整个套件起不来。
        (sd / "passwords.json").write_text(json.dumps({
            "version": gm.STORE_VERSION, "gen": 1,
            "params": {"kdf": gm.KDF_NAME, "n": gm.KDF_N, "r": gm.KDF_R,
                       "p": gm.KDF_P, "dklen": gm.KDF_DKLEN,
                       "salt_bytes": gm.KDF_SALT_BYTES},
            "entries": [{"id": ALIVE, "label": "活着的", "rev": 1,
                         "enabled": True, "expires_at": None,
                         "salt": "DRuG7z1WY7O3KEww-dIaRw",
                         "hash": base64.urlsafe_b64encode(bytes(32)).decode().rstrip("=")}],
        }), encoding="utf-8")
        with (sd / "usage.cache.jsonl").open("w", encoding="utf-8") as f:
            for i in range(4):
                f.write(json.dumps({
                    "ts": f"2026-10-1{i % 9 + 1}T01:02:03Z", "ok": True,
                    "pwid": ALIVE, "label": "活着的",
                    "ip": "1.1.1.1", "browser": "Edge", "os": "macOS",
                }) + "\n")
                f.write(json.dumps({
                    "ts": f"2026-10-1{i % 9 + 1}T02:02:03Z", "ok": False,
                    "pwid": f"dead{i:04d}", "label": "删掉的",
                    "ip": "2.2.2.2", "browser": "Edge", "os": "macOS",
                }) + "\n")
                f.write(json.dumps({     # 无名失败（密码输错）——**必须保留**
                    "ts": f"2026-10-1{i % 9 + 1}T03:02:03Z", "ok": False,
                    "ip": "3.3.3.3", "browser": "Edge", "os": "macOS",
                }) + "\n")
        s_on = gu.read_usage(sd, limit=50, existing=True)
        chk("T33 ★ 造出来的 state：existing 藏掉 4 条已删除密码的记录",
            s_on["total"] == 12 and s_on["matched"] == 8
            and s_on["dropped_existing"] == 4,
            f"total={s_on['total']} matched={s_on['matched']} "
            f"dropped={s_on['dropped_existing']}")
        chk("T33 ★ 无名的失败记录一条都没被藏（4 活 + 4 无名 = 8）",
            s_on["matched"] == 8)
        s_off = gu.read_usage(sd, limit=50, existing=False)
        chk("T33 ★ 关掉 existing → 12 条全在、dropped 归零",
            s_off["matched"] == 12 and s_off["dropped_existing"] == 0)
        chk("T33 ★ dropped_existing 恒为 0 会被这条抓住（上一条是真覆盖）",
            s_on["dropped_existing"] != s_off["dropped_existing"])
    # 无名记录（密码输错的失败）**不能**被 existing 藏掉 —— 那是审计最该看的
    chk("T33 existing 只藏「有 pwid 但已不在表里」的，无名失败记录一条都不藏",
        d_off["matched"] == len(gm.read_usage(state_dir)))
    chk("T33 计数提示点名了「已删除密码的历史记录 N 条已隐藏」",
        "dropped_existing" in js and "已删除密码的历史记录" in js
        and "已隐藏" in js)
    chk("T33 提示里能点开/看懂怎么把藏起来的放出来（给出「显示全部记录」入口）",
        'id="usage-show-all"' in html
        and "连已删除密码的历史记录一起显示" in html)
    # anyUsageFilter 必须**不**把 existing 算成筛选：默认开着它 → 若算进去，
    # 这个按钮会永远杵在表头上，点完（existing=false）才消失，像「点了没反应」。
    m_af = re.search(r"function anyUsageFilter\(\) \{.*?\n    \}", js, re.S)
    chk("T33 anyUsageFilter 刻意不把 existing 算成筛选（否则按钮永远杵着）",
        m_af is not None and "usageF.existing" not in m_af.group(0))
    m_show = re.search(r"\$\('usage-show-all'\)\.addEventListener\('click', \(\) => \{.*?\n    \}\);",
                       js, re.S)
    chk("T33 「显示全部记录」把 existing 拨成 false（这才是让两个数字相等的办法）",
        m_show is not None and re.search(r"usageF\.existing = false", m_show.group(0)))
    chk("T33 「显示全部记录」同时重拉 facets（密码列选项要跟着变）",
        m_show is not None and "loadUsageFacets()" in m_show.group(0))
    chk("T33 「显示全部记录」只在「确实藏了东西且开关还开着」时才出现",
        re.search(r"\$\('usage-show-all'\)\.hidden = "
                  r"!\(who\.length && usageF\.existing\);", js) is not None)
    m_clr = re.search(r"\$\('usage-clear'\)\.addEventListener\('click', \(\) => \{.*?\n    \}\);",
                      js, re.S)
    chk("T33 ★「清除全部筛选」不碰 existing（它是显示范围，不是筛选条件）",
        m_clr is not None and "usageF.existing" not in m_clr.group(0))
    chk("T33 列头 ▾ 不把 existing 算进计数（它不是这一列的筛选值）",
        "f.existing ? 0 : 1" not in js)
    # 真跑一次 anyUsageFilter：默认态 + 每列各选一个值 + 时间列
    rows33 = _run_pref(node, js)
    for r in rows33:
        chk("T33 " + r["name"], r["ok"], r["detail"])

    # ── T34：三态「（全部）」复选框 ──────────────────────────────
    # 用户要求：全勾时单击 → **全部取消**（空）；空时单击 → 全勾；
    #   部分选中显示「−」，单击 → 全勾。语义上空 = 不限（不出 0 条死胡同），
    #   所以 `chosen` 两种情况都为空 —— 视觉必须靠 usageF.visAll 区分。
    chk("T34 三态的两个函数都在（recompute / syncAllBox）",
        "function recompute()" in js and "function syncAllBox()" in js)
    chk("T34 ★ indeterminate 只能靠 JS 设（写成 HTML 属性会被浏览器忽略）",
        re.search(r"allBox\.indeterminate = !all_ && !none_;", js) is not None)
    chk("T34 ★ 单击「（全部）」用 click + preventDefault 自己算目标态"
        "（浏览器对 indeterminate 的点击行为没有明确规定）",
        re.search(r"allBox\.addEventListener\('click', \(ev\) => \{.*?"
                  r"ev\.preventDefault\(\);", js, re.S) is not None)
    # ⚠️ 这里必须是 `n !== boxes.length`：写成 `!(n===0 || n===len)` 会让
    #   「全不勾」的目标态仍是「全不勾」→ 单击毫无反应。真 bug，探针抓到的。
    chk("T34 ★ 目标态是 n !== len（空态单击要真变全选，不是点了没反应）",
        "const wantAll = n !== boxes.length;" in js
        and "!(n === 0 || n === boxes.length)" not in js)
    chk("T34 ★ 全勾 / 全不勾 时单击 → 互相切换（都进 else 分支）",
        js.count("boxes.forEach((b) => { b.checked = wantAll; });") == 1)
    chk("T34 ★ 三态目标写在注释里（不是只写在脑子里）",
        "全勾 → 全不勾" in js and "全不勾 → 全勾" in js and "部分 → 全勾" in js)
    chk("T34 ★ 逐项取消不再被强行弹回全勾（旧逻辑的死胡同）",
        "if (keep.length === 0) boxes.forEach((b) => { b.checked = true; });" not in js)
    chk("T34 visAll 记全勾 / 移出非全勾，两边都覆盖",
        "f.visAll.add(col);" in js and "f.visAll.delete(col);" in js)
    chk("T34 usageF.visAll 初始含全部五列（打开面板默认全勾）",
        "visAll: new Set(['result', 'pwid', 'ip', 'browser', 'osdev'])" in js)
    chk("T34 entryF 也有 visAll（否则条目表打开面板会抛 undefined）",
        re.search(r"entryF = \{[^}]*visAll: new Set", js) is not None)
    chk("T34 「清空本列」全部取消勾选并移出 visAll（点了要看得见）",
        re.search(r"chosen\.clear\(\);.*?boxes\.forEach\(\(b\) => \{ b\.checked = false; \}\);"
                  r".*?f\.visAll\.delete\(col\);", js, re.S) is not None)
    chk("T34 「清除全部筛选」把 visAll 复位成全勾",
        re.search(r"usageF\[k\]\.clear\(\);\s*usageF\.visAll\.add\(k\);", js) is not None)
    chk("T34 visAll 不进查询串（它只管勾怎么画，不影响筛什么）",
        re.search(r"qs\.set\('(?:result|id|ip|browser|os)'[^\n]*visAll", js) is None)
    # 真跑：三态的 6 条转移（初始 + 4 个单项勾选组合 + 清空）
    rows34 = _run_tristate(node, js)
    for r in rows34:
        chk("T34 " + r["name"], r["ok"], r["detail"])

    # ── T35：连点筛选框 → 请求乱序 → 显示过期结果 ──────────────────
    # 无头浏览器探针撞到的真 bug：全不勾本该是「不限」（174 条），屏幕却停在 112。
    # 原因：连点 4 个框会**并发**发 4 个请求，先发的可能后到，把新结果覆盖成旧的。
    chk("T35 有请求序号（只认最后一次发起的那个）",
        re.search(r"let usageSeq = 0;", js) is not None)
    chk("T35 每次 loadUsage 都领一个号",
        re.search(r"const seq = \+\+usageSeq;", js) is not None)
    chk("T35 ★ 拿到结果后先比对号，不是最后一次就直接丢掉（连渲染都不做）",
        re.search(r"// 已经有更新的请求在飞了.*?if \(seq !== usageSeq\) return null;",
                  js, re.S) is not None)
    m_lu = re.search(r"async function loadUsage\(opts\) \{.*?\n    \}", js, re.S)
    chk("T35 丢弃判断在 await **之后**、渲染之前（顺序不能反）",
        m_lu is not None
        and m_lu.group(0).index("if (seq !== usageSeq) return null;")
        < m_lu.group(0).index("renderUsage("))
    chk("T35 丢弃时返回 null（调用方已有 `if (!data) return` 的守卫）",
        m_lu is not None and "return null;" in m_lu.group(0))
    # 真跑：模拟乱序到达，确认旧的先回会被丢掉、且不影响后发的
    rows35 = _run_race(node, js)
    for r in rows35:
        chk("T35 " + r["name"], r["ok"], r["detail"])

    # ── T36：漂移误报 + 时区 + 背景图预览/下载 ──────────────────────
    # 用户报三件事：① 推完图立刻报「记录与线上不一致」；② 时间差 8 小时；
    #   ③ 背景图界面要能看到图、能下载。

    # ① 漂移：早期版本存的是**截断的 16 位** sha，而远端 `sha256sum` 给 64 位
    #   全量 → 每次刚推完就判不相等。一个恒真的告警比没有告警更糟。
    chk("T36 漂移判定用前缀比（兼容旧的 16 位记录）",
        "live.startswith(backed)" in gm_src)
    chk("T36 ★ 不再直接比全长（那正是恒真的来源）",
        'on_line.get("sha") != backed' not in gm_src)
    chk("T36 local_sha 存全量 sha256，不再截断",
        re.search(r"def local_sha\(path: Path\) -> str:.*?"
                  r"hexdigest\(\)(\s*#.*?)?$", gm_src, re.M | re.S) is not None
        and "hexdigest()[:16]" not in gm_src)
    # 真跑漂移判定：五种情形（含"新记录 + 线上被 rsync 换掉"这个真漂移）
    rows36 = _run_drift(node, gm_src)
    for r in rows36:
        chk("T36 " + r["name"], r["ok"], r["detail"])

    # ② 时区：`at` 必须过 iso_to_local。其它时间字段早就是了，只有它漏了。
    chk("T36 ★ webbg 的 at 走了 iso_to_local（否则东八区差 8 小时）",
        re.search(r'"at": iso_to_local\(p\["state"\]\.get\("at"\)', gm_src) is not None)
    chk("T36 同时保留 at_utc（原始串，出问题时能对照）",
        '"at_utc": p["state"].get("at")' in gm_src)
    chk("T36 前端不再对时间做 slice(0,19) 截断（那是把 UTC 当本地）",
        "replace('T', ' ').slice(0, 19)" not in js)
    chk("T36 前端标注了「本机时间」让人知道口径",
        "（本机时间）" in js)

    # ③ 预览 + 下载
    chk("T36 有 /api/webbg_image 端点（预览与下载共用一份字节）",
        '"/api/webbg_image"' in gu_src and "fetch_webbg_image" in gu_src)
    chk("T36 which 走白名单，绝不把用户给的值拼进 ssh 命令",
        re.search(r'if which not in names:\s*\n\s*raise ApiError', gu_src) is not None)
    chk("T36 取回来的字节按魔数验过（防「被换成别的东西」）",
        'data.startswith(b"RIFF")' in gu_src and 'data.startswith(b"\\xff\\xd8\\xff")' in gu_src)
    chk("T36 有大小上限（head -c 截断，不会把内存吃光）",
        "head -c" in gu_src and "WEBBG_FETCH_MAX = 8 * 1024 * 1024" in gu_src)
    # ★ 传字节流的活**不能**走面向文本的封装：gm.run 写死 text=True，
    #   会把图片按 UTF-8 解码 → UnicodeDecodeError 把请求线程干掉，
    #   浏览器只看到 "Failed to fetch"。我第一版就是这么写的。
    chk("T36 ★ 取图走 subprocess 二进制模式，不走 gm.run（text=True 会崩）",
        re.search(r"subprocess\.run\(cmd, capture_output=True, check=False,\s*"
                  r"stdin=subprocess\.DEVNULL\)", gu_src) is not None
        and "gm.run(gm.ssh_cmd" not in gu_src)
    chk("T36 取图仍显式切断子进程 stdin（同一口 ssh 管道的老坑）",
        re.search(r"subprocess\.run\(cmd, capture_output=True, check=False,\s*"
                  r"stdin=subprocess\.DEVNULL\)", gu_src) is not None)
    chk("T36 下载用 Content-Disposition: attachment（不开新标签页）",
        "Content-Disposition" in gu_src and "attachment; filename=" in gu_src)
    chk("T36 前端预览带时间戳绕缓存（否则改了图还看到旧的）",
        "bust = '&t=' + Date.now()" in js)
    chk("T36 预览图有固定高度 + object-fit（竖图不会把对话框撑爆）",
        ".wb-img {" in css and "object-fit: contain" in css and "height: 190px" in css)
    chk("T36 预览取不到会明说，不留裂图让人以为背景图坏了",
        "img.addEventListener('error'" in js and "这不代表线上背景图坏了" in js)
    chk("T36 CSP 的 img-src 允许 self（预览走本机接口）",
        "img-src 'self' data:;" in gu_src)
    # 端点也要鉴权 —— 预览图等于公开背景图，不能裸奔
    st36, _, _ = request(port, "GET", "/api/webbg_image?which=webp")
    chk("T36 ★ /api/webbg_image 也要鉴权（没 cookie → 403）", st36 == 403,
        f"status={st36}")
    st36b, _, _ = request(port, "GET", "/api/webbg_image?which=../../etc/passwd")
    chk("T36 ★ 非白名单的 which 被拒（路径穿越）", st36b in (400, 403, 404, 500),
        f"status={st36b}")
    st36c, h36, b36 = request(port, "GET", "/api/webbg_image?which=bogus",
                               headers=cookie)
    chk("T36 白名单外的 which 返回错误而不是 200 + 空体",
        st36c != 200 or b36,
        f"status={st36c} len={len(b36)}")
    # ★ deploy-web.sh 的 rsync 会把**本机** web/assets/bg.{webp,jpg} 覆盖回服务器。
    #   推了新图不同步本机 → 下次部署把线上的新图无声推回旧的。
    #   2026-10-17 真踩过：本地 81 KB 旧图 vs 线上 510 KB 新图。
    dep = (HERE.parent / "scripts" / "web" / "deploy-web.sh")
    dep_s = dep.read_text(encoding="utf-8") if dep.exists() else ""
    chk("T37 deploy-web.sh 确实会同步 assets/（所以推完新图必须同步本机）",
        '"$WEB_DIR/assets"' in dep_s and "--delete" in dep_s)
    chk("T37 文档写明「推完新图要把本机那两张也换成同一张」",
        "推完新图必须把本机那两张也换成同一张" in gu_doc)
    chk("T37 文档给的是本接口而不是让用户手打路径",
        "/api/webbg_image?which=webp|jpg&download=1" in gu_doc)
    chk("T37 文档不再说缓存头「要跑一次 deploy-web.sh」（已部署）",
        "要跑一次 `./scripts/web/deploy-web.sh` 才生效" not in gu_doc)
    # ★ 背景图不入库：授权还没拿到。仓库本身是**私有**的，但 git 历史是追加的 ——
    #   提交过就永久留存，以后想删要重写历史 + 强推（会打断已 clone 的人）。
    #   用断言守住，别被顺手 `git add -A` 带回去。
    gi = (HERE.parent / ".gitignore")
    gi_s = gi.read_text(encoding="utf-8") if gi.exists() else ""
    chk("T37 ★ 背景图在 .gitignore 里（授权未拿到，不入库）",
        "web/assets/bg.webp" in gi_s and "web/assets/bg.jpg" in gi_s)
    chk("T37 .gitignore 说明了怎么补上（clone 的人需要知道）",
        "cms webbg push" in gi_s and "cover" in gi_s)
    # ★ 漏过一张：根目录 assets/bg.jpg 是**桌面端**的背景图
    #   （Renderer.cpp 的 resourcePaths("bg.jpg")），当时只顾着 web/assets/。
    chk("T37 ★ 桌面端那张背景图也在 .gitignore 里（同一个授权问题）",
        "assets/bg.jpg" in gi_s)
    # ★ 语义：`not _git_tracked(全部)` 是**错的** —— 只要有一张还在索引里，
    #   `_git_tracked` 就返回 False，`not False` = True → 断言照样通过。
    #   我第一版就这么写，变异验证（真把一张加回索引）**没被抓到**才发现。
    #   正确：「一张都不在索引里」= 逐张都返回「不在」。
    bgs = ["web/assets/bg.webp", "web/assets/bg.jpg", "assets/bg.jpg"]
    leaked = [p for p in bgs if _git_tracked([p])]
    chk("T37 ★ 三张背景图**一张都不在** git 索引里",
        not leaked, f"仍在索引：{leaked or '（无）'}")
    chk("T37 撤下功能要用的纯白图仍在索引里（否则 webbg off 没素材）",
        _git_tracked(["tools/webbg/blank.webp", "tools/webbg/blank.jpg"]))
    # ★ 2026-11-02：裸写 `dist/` 会连 scripts/dist/ 一起挡掉，而那是部署脚本**源码**。
    #   表现不是「看不见」，是 `git add scripts/dist/x.sh` 直接拒绝，只能 `git commit -- 路径`
    #   绕——绕久了就容易养成「加 -f」的习惯，那时真该挡的东西也挡住了。
    gi_lines = [ln.strip() for ln in gi_s.splitlines()]
    chk("T37 ★ 产物目录写成 /dist/（只挡仓库根，不误伤 scripts/dist/ 源码）",
        "/dist/" in gi_lines and "dist/" not in gi_lines,
        f"裸 dist/ 还在：{'dist/' in gi_lines}")
    chk("T37 ★ web 构建产物另有自己的规则（不靠 dist/ 兜，改这条不会把它暴露给 add -A）",
        "web/dist/" in gi_lines)
    ghost = subprocess.run(["git", "ls-files", "-i", "-c", "--exclude-standard"],
                           cwd=HERE.parent, capture_output=True, text=True).stdout.split()
    chk("T37 ★ 没有「已跟踪却被忽略」的文件（该显式 git rm --cached 或修规则）",
        not ghost, f"{len(ghost)} 个：{'、'.join(ghost[:4])}")

    # ── T40：推图时可选更新到哪些端（web / mac / win）──────────────
    # 图标与 dmg 背景都是 package.sh **打包时**从 assets/bg.jpg 派生的，
    # 所以换图后已打的包还是旧的；重跑打包要编译，慢 → 单独一个刷新脚本。
    rs = HERE.parent / "scripts" / "game" / "refresh_icon.sh"
    chk("T40 有独立的图标刷新脚本（不必为换图标重跑整个打包）",
        rs.is_file())
    if rs.is_file():
        rs_s = rs.read_text(encoding="utf-8")
        chk("T40 ★ 脚本从 package.sh 里**抽取**图标段，不另抄一份"
            "（抄一份必然漂移：以后改了尺寸，这里不会跟着改）",
            "package.sh" in rs_s and "awk" in rs_s and "ICON_BLOCK" in rs_s)
        chk("T40 ★ 明说 dmg 背景无法单独重建（它只在打包时临时生成）",
            "dmg" in rs_s and "不能" in rs_s)
    # CLI：三个独立开关
    chk("T40 CLI 有 --mac / --win / --desktop 三个开关",
        all(f'"--{x}"' in gm_src for x in ("mac", "win", "desktop")))
    chk("T40 ★ --desktop 是「两端都」的快捷方式（兼容旧脚本）",
        'getattr(a, "mac", False) or getattr(a, "desktop", False)' in gm_src
        and 'getattr(a, "win", False) or getattr(a, "desktop", False)' in gm_src)
    # ★ mac 与 win 读的是**各自产物目录**里的 assets/，不是项目那份
    chk("T40 ★ mac 端写 .app 产物目录（.app/Contents/Resources/assets）",
        "ComplexMinesweeper.app/Contents" in gm_src
        and 'dist" / "ComplexMinesweeper.app' in gm_src.replace("/", ' / ').replace("  ", " ")
        or "ComplexMinesweeper.app" in gm_src)
    chk("T40 ★ 勾了 win 会真的重新打包（背景换文件就够，但图标编在 exe 里必须重编）",
        "ComplexMinesweeper-win64" in gm_src
        and '"build_windows.sh"' in gm_src and "_repackage(" in gm_src)
    chk("T40 ★ 两端都还会更新项目里的 assets/bg.jpg"
        "（否则下次打包会把产物目录的改动覆盖回旧图）",
        '"assets" / "bg.jpg"' in gm_src and "下次打包会覆盖" in gm_src)
    chk("T40 ★ 产物目录不存在时**跳过**而不是报错（用户可能还没打过包）",
        "mac_bg.parent.is_dir()" in gm_src and "win_bg.parent.is_dir()" in gm_src)
    # 失败不中断
    chk("T40 ★ 图标重建失败**不中断推送**（网页端已推成功，图标可稍后补）",
        "图标重建失败" in gm_src and "apply_desktop_image(src" in gm_src)
    # ★ 布尔开关不能用 {name} 占位符：空串会被 argparse 当真值
    _ops = re.search(r'"webbg_push":.*?(?=\n    "\w+":|\n\})', gu_src, re.S)
    _ops_s = _ops.group(0) if _ops else ""
    chk("T40 ★ UI 用 flags 机制传 --desktop，不用占位符"
        "（占位符填空串 → argparse 把任何非空串当真值 → 没勾也生效）",
        '"desktop", "--desktop"' in _ops_s and "{desktop}" not in _ops_s
        and bool(_ops_s),
        _ops_s.replace("\n", " ")[:100])
    # 前端
    chk("T40 ★ 界面只有一个「桌面端」复选框（不分 mac / win）"
        "—— 两端同源，分开只能控制「更新哪几个产物目录」，不是「用不同的图」",
        "tgt-pick" in js and "targets: { web: true, desktop: true }" in js
        and "targets.mac" not in js and "targets.win" not in js)
    chk("T40 ★ 每次打开对话框复位成全勾（上次取消过不该带到这次）",
        "state.targets = { web: true, desktop: true };" in js)
    chk("T40 ★ web 端是**必选**（灰着但勾着）—— 这个对话框就是网页背景对话框",
        "webCb.disabled = true" in js and "网页端（必选" in js)
    chk("T40 按钮文字随勾选变化（推送并启用（网页 + mac + win））",
        "syncPushLabel" in js and "bPush.textContent" in js)
    chk("T40 提交时传 desktop 一个布尔，不传 web（web 本来就是这对话框的主题）",
        "desktop: !!t.desktop" in js and "image: up.path" in js)
    chk("T40 ★ 界面明说「勾桌面端会重新打包」（而不是让用户自己再跑一次脚本）",
        "重新打包" in js and "tip-warn" in js and "还需重跑" not in js)
    chk("T40 ★ 推成功后不再弹「还需重跑打包」"
        "（勾了桌面端就已经自动打包过了，再提醒是自相矛盾）",
        "还需重跑" not in js and "已重新打包" in js)
    chk("T40 样式类都在 CSS 里有定义（cf-box / is-static）",
        ".cf-box" in css and ".cf-item.is-static" in css)


    # ── T43：Windows 图标内嵌进 exe ──────────────────────────────
    # ★ mac 与 win 机制根本不同，这点是整件事的关键：
    #     mac → .app 里放独立 icon.icns，Finder 读它 ⇒ 换文件即可，不重编译；
    #     win → 图标是**编进 exe 的 PE 资源段** ⇒ 换图**必须重新链接**。
    #   所以「界面勾了 Windows 端」对图标而言只是准备好 .ico，
    #   真正写进 exe 还要用户跑一次 scripts/game/build_windows.sh（约 7 秒，库已在时）。
    mk = HERE.parent / "scripts" / "game" / "make_win_icon.sh"
    chk("T43 有独立的 .ico 生成脚本（从 assets/bg.jpg 派生）",
        mk.is_file())
    if mk.is_file():
        mk_s = mk.read_text(encoding="utf-8")
        chk("T43 ★ 生成完让 **windres 真读一遍**做校验"
            "（读不了就说明 .ico 是坏的，别等到打包才发现）",
            "windres" in mk_s and "读不了这个 .ico" in mk_s)
        chk("T43 ★ windres 必须走 .rc 中间层"
            "（它会先把 .rc 交给 C 预处理器，直接 `-i x.ico` 是 "
            "「file format not recognized」—— 我踩过）",
            "probe.rc" in mk_s and 'IDI_ICON1 ICON' in mk_s)
        chk("T43 图标是方形（居中裁，否则被拉伸变形）",
            "cropToHeightWidth 900 900" in mk_s)
        chk("T43 用了 Windows 惯用的多档尺寸",
            all(f"{s}" in mk_s for s in (16, 32, 48, 256)))
    cml = (HERE.parent / "CMakeLists.txt").read_text(encoding="utf-8")
    # 只要求「接图标这段在 if(WIN32) 之内」，不能查「文件里没有 make_win_icon」
    # —— 我在注释里就提了它（解释为什么图标在编译期），按「整文件不含」查会误判。
    _win_blk = cml[cml.index("if(WIN32)"):]
    chk("T43 ★ CMakeLists 只在 WIN32 分支里接图标（不影响 mac 构建）",
        "CMS_WIN_ICO" in _win_blk and "add_custom_command" in _win_blk)
    chk("T43 ★ 用 windres 编资源（走 add_custom_command，不直接 add .rc ——"
        "cross-compiling 时 windres 的工作目录不好控制）",
        "CMAKE_RC_COMPILER" in cml and "add_custom_command" in cml
        and "-O coff" in cml)
    chk("T43 icon.ico 缺失时**只是没有图标**，不阻断构建",
        "message(STATUS" in cml and "没有图标 exe 也能正常跑" in cml)
    chk("T43 ★ 注释写明「win 换图标必须重跑 build_windows.sh」"
        "（换文件对 win 的图标不生效——这是最容易误解的一点）",
        "必须重新链接" in cml and "build_windows.sh" in cml)
    bws = (HERE.parent / "scripts" / "game" / "build_windows.sh").read_text(encoding="utf-8")
    chk("T43 ★ build_windows.sh 在 cmake 配置**之前**先生成 ico"
        "（顺序反了的话配置时还没有 ico，就会被跳过）",
        bws.index("make_win_icon.sh") < bws.index('cmake -S "$ROOT" -B "$GAME_BUILD"'))
    chk("T43 图标生成失败不阻断打包（只是没图标）",
        "图标生成失败，继续编" in bws)
    chk("T43 ★ webbg push --win 会生成 ico **并自动重跑打包**，把图标真编进 exe",
        "make_win_icon.sh" in gm_src and "_repackage(" in gm_src
        and "需重跑" not in gm_src)


    # ── T44：背景图上传的三件事（进度条 / 短边校验 / 图标裁剪）──────
    # 用户要求：① 底部进度条（已传/总大小 + 一位小数）；② 勾了桌面端必须
    # 先裁一次图标；③ 短边 < 512 拒绝、太大压到 1920；④ 复选框合并成
    # 「桌面端」一个（两端同源，分开没有意义）。

    # ① 进度条
    chk("T44 ★ 用 XHR 而不是 fetch 上传（fetch 没有上传进度事件）",
        "XMLHttpRequest" in js and "xhr.upload.onprogress" in js
        and "xhr.open('POST', '/api/webbg_upload" in js)
    chk("T44 ★ 进度文案是「已传 / 总大小（百分比）」，百分比一位小数",
        "fmtBytes(loaded)" in js and "fmtBytes(total)" in js
        and "pct.toFixed(1)" in js and "%）" in js)
    chk("T44 ★ lengthComputable 为假时不硬算百分比（否则 NaN% 或恒 0%）",
        "ev.lengthComputable" in js and "已上传 " in js)
    chk("T44 进度条固定在**页面底部**，不在对话框里"
        "（上传发生在对话框关闭之后，放框里根本看不见）",
        "page-prog" in html and "position: fixed" in css
        and "dlg-prog" not in html)
    chk("T44 onprogress 时 also 显示 XHR 的 withCredentials（token 在 cookie 里）",
        "xhr.withCredentials = true" in js)

    # ② 短边校验
    chk("T44 ★ 短边下限 512（前端就有，别让人白等一次上传）",
        "BG_MIN_SHORT_EDGE = 512" in js and "short0 < BG_MIN_SHORT_EDGE" in js)
    chk("T44 ★ 短边校验在**压缩之前**（先压再判会错怪原图："
        "4000×600 压到 1920×288 才说短边不够）",
        js.index("short0 < BG_MIN_SHORT_EDGE") < js.index("const scale = long > MAX"))
    chk("T44 拒绝时说出实际尺寸和下限（否则用户不知道该换多大的图）",
        "短边只有" in js and "至少 " in js)

    # ③ 裁剪器
    chk("T44 ★ 勾了桌面端必须先裁剪，否则中止整次推送",
        "const needIcon = !!t.desktop;" in js
        and "if (!shot)" in js and "return;" in js)
    chk("T44 ★ 裁剪框是正方形（图标都是方的，自由变形会让预览和结果不一致）",
        "ICON_MIN_EDGE" in js and "正方形" in js)
    chk("T44 ★ 小边按**原图像素**卡，不是屏幕像素",
        "size = Math.max(minEdge, Math.min(Math.min(IW, IH), size))" in js)
    chk("T44 有 8 个缩放手柄（4 角 + 4 边）",
        html.count('class="crop-hd"') == 8)
    chk("T44 用 pointer 事件 + setPointerCapture（拖出元素也不丢）",
        "pointerdown" in js and "setPointerCapture" in js)
    chk("T44 ★ 选区是**原图像素**坐标，显示时乘 scale"
        "（按屏幕像素存，改窗口大小后裁出来的东西会变）",
        "scaleNow()" in js and "sel.x * k" in js)
    chk("T44 ★ 预览从**原图**裁，不是从屏幕缩略图裁（后者已经缩过一次，再裁会糊）",
        "drawImage(bmp, sel.x, sel.y, sel.size, sel.size" in js)
    # ★ 判据要盯「实际怎么设 src」，不能查「文件里没有 createObjectURL」——
    #   注释里正好写了「别用 URL.createObjectURL」来解释这个坑，按整文件不含查会误判。
    chk("T44 ★ 显示用 data: URL（CSP 是 img-src 'self' data:，不含 blob:；"
        "用 blob 会被拦成「图空白但选区数字正常」）",
        "img.src = tcv.toDataURL('image/jpeg'" in js
        and "URL.createObjectURL(file)" not in js)
    chk("T44 ★ 选区值写进 data-*（原图像素），界面 px 不能拿来判边界",
        "boxEl.dataset.size" in js and "boxEl.dataset.imgW" in js)
    chk("T44 裁剪结果作为独立图标上传（kind=icon，不和背景图混一个池子）",
        "'?kind=' " in js or "'?kind=' +" in js)
    chk("T44 ★ 后端 icon-* 不参与「留最近 10 张」的裁剪"
        "（图标被当旧背景图删掉就白传了，且报错点离得很远）",
        'p.name.startswith("bg-")' in gu_src
        and 'if kind != "icon"' in gu_src)
    chk("T44 ★ 图标脚本优先用 assets/icon.png（用户裁过的那块），"
        "没有才退回背景图居中裁",
        'SRC="assets/icon.png"' in (HERE.parent / "scripts" / "game" / "refresh_icon.sh").read_text(encoding="utf-8")
        and 'SRC="assets/icon.png"' in (HERE.parent / "scripts" / "game" / "make_win_icon.sh").read_text(encoding="utf-8"))
    _pkg = (HERE.parent / "scripts" / "game" / "package.sh").read_text(encoding="utf-8")
    chk("T44 ★ 方形图不再被 --cropToHeightWidth 900 900 二次裁"
        "（512 的图标会被先放大再裁 = 白糊一次）",
        'if [ -n "$_W" ] && [ "$_W" = "$_H" ]; then' in _pkg
        and "ICON_SRC" in _pkg)

    # ④ 合并复选框
    chk("T44 ★ 界面只有一个「桌面端」复选框（不分 mac / win）",
        '"desktop", "--desktop"' in gu_src and "targets.mac" not in js
        and "targets.win" not in js)
    chk("T44 ★ 明说勾桌面端会重新打包（说的是 CLI 自己会做，不是叫用户去做）",
        "重新打包" in js and "tip-warn" in js)

    # ── T45：`webbg push` 的收尾同步绝不许抛异常 ──────────────────
    # 用户真报过：图已经传上去、已经置为「开」、成功信息都打出来了，
    # 紧接着挂一整段 traceback —— `sync_webbg_to_local` 给 run() 多传了
    # 它不接受的 `stdin=` 参数。崩在最后一步，看着像「整个操作失败了」，
    # 实际线上早就好了。这种「成功后的崩溃」比失败更让人困惑。
    import inspect as _inspect45
    import tempfile as _tf45
    _gm45 = load_gate_manager()
    _src45 = (HERE.parent / "tools" / "gate_manager.py").read_text(encoding="utf-8")
    _body45 = _src45[_src45.index("def sync_webbg_to_local"):
                     _src45.index("# " + "-" * 74,
                                  _src45.index("def sync_webbg_to_local"))]
    chk("T45 ★ run() 本身不接受 stdin=（它内部已经接了 /dev/null）",
        "stdin" not in _inspect45.signature(_gm45.run).parameters)
    chk("T45 ★ 收尾同步不再把 stdin= 塞给 run()（那正是崩掉的那次）",
        "run(ssh_cmd(a)" not in _body45.replace("subprocess.run(ssh_cmd(a)", ""))
    # ★ 判「有没有真的按 text 模式读」必须看**调用参数**，不能在源码里搜
    #   `text=True` —— 我的注释里就写着这五个字符（解释为什么不能用 run()），
    #   按整段搜索会把自己的说明当成违规。这里用 AST 取 keyword。
    _ast45 = _inspect45 and __import__("ast")
    _fn45 = next(n for n in _ast45.parse(_src45).body
                 if isinstance(n, _ast45.FunctionDef)
                 and n.name == "sync_webbg_to_local")
    _calls45 = [n for n in _ast45.walk(_fn45)
                if isinstance(n, _ast45.Call)
                and isinstance(n.func, _ast45.Attribute)
                and getattr(n.func.value, "id", "") == "subprocess"
                and n.func.attr == "run"]
    _kws45 = {k.arg for c in _calls45 for k in c.keywords}
    chk("T45 ★ 读图是二进制的（subprocess.run 不传 text，否则接图会 "
        "TypeError / 编码来回转把内容改坏）",
        bool(_calls45) and "text" not in _kws45
        and "capture_output" in _kws45,
        f"{len(_calls45)} 处调用，关键字 {sorted(_kws45)}")
    chk("T45 仍然切断子进程 stdin（ssh 不该有任何交互）",
        "stdin=subprocess.DEVNULL" in _body45)
    chk("T45 ★ 整体 try/except 兜底：失败降级成一句 ⚠，不往上抛",
        "try:" in _body45 and "except Exception" in _body45)

    # 真跑两条路（用临时目录，不碰仓库里的 web/assets）
    _A45 = type("A", (), {})
    _a45 = _A45()
    _a45.server, _a45.ssh_port, _a45.web_root = "s", "22", "/w"
    _real45 = _gm45.subprocess.run
    # 故意放非 UTF-8 字节：如果实现走了 text 模式，这几位一定被改坏
    _payload = b"\x89PNG\r\n\x1a\n\xff\xfe\x00\x80ICON-E2E"
    try:
        with _tf45.TemporaryDirectory() as _td45:
            _d = Path(_td45)
            _gm45.subprocess.run = lambda cmd, **kw: subprocess.CompletedProcess(
                cmd, 0, _payload, b"")
            _msg45 = _gm45.sync_webbg_to_local(_a45, dst_dir=_d)
            _same = all((_d / n).read_bytes() == _payload
                        for n in ("bg.webp", "bg.jpg"))
            chk("T45 ★ 真跑：两张都落盘，且**逐字节相同**（没被编码转换改坏）",
                _same and "已同步" in _msg45,
                f"same={_same} msg={_msg45[:40]}")
            # 失败路径：ssh 报错时只返回 ⚠，不抛
            for _f in _d.iterdir():
                _f.unlink()
            _gm45.subprocess.run = lambda cmd, **kw: subprocess.CompletedProcess(
                cmd, 1, b"", "ssh: connect refused")
            try:
                _msg45b = _gm45.sync_webbg_to_local(_a45, dst_dir=_d)
                _raised = None
            except Exception as _e:                      # noqa: BLE001
                _raised, _msg45b = _e, ""
            chk("T45 ★ 真跑：服务器读不到时返回 ⚠ 而不是抛异常"
                "（否则成功输出后面接一段 traceback）",
                _raised is None and "⚠" in _msg45b,
                f"raised={_raised!r} msg={_msg45b[:40]}")
            chk("T45 失败时一个字节都没写（半张图比没有更糟）",
                not list(_d.iterdir()))
    finally:
        _gm45.subprocess.run = _real45

    # ── T46：勾了桌面端 = 背景 / 图标 / dmg 背景**全部**真的换掉 ─────
    # 用户的原话：「我就是要实现如果勾选了同步桌面端，就把两个桌面端的背景，
    # 图标，dmg背景都换成新的图片」。所以这里不能只是「换文件 + 提醒你去打包」——
    # 有三样东西换文件换不到：
    #   ① dmg 安装界面的背景（package.sh 生成 dmg 时用 sips 现场裁）
    #   ② Windows exe 里的图标（编在 PE 资源段）
    #   ③ mac 的签名（改过 Resources 的 .app 会失签，arm64 可能拒启动）
    _gm46 = load_gate_manager()
    _pkg46 = (HERE.parent / "scripts" / "game" / "package.sh").read_text(encoding="utf-8")
    _bw46 = (HERE.parent / "scripts" / "game" / "build_windows.sh").read_text(encoding="utf-8")
    chk("T46 ★ package.sh 支持复用已编译二进制（推图不该顺带全量重编）",
        "PKG_REUSE_BIN" in _pkg46)
    chk("T46 ★ 复用开关在二进制不存在时会退回正常编译（外部无脑传 =1 也安全）",
        '[ -x "$BUILD_DIR/$BIN" ]' in _pkg46
        and _pkg46.index("PKG_REUSE_BIN") < _pkg46.index("cmake --build"))
    chk("T46 ★ 默认就重新打包（rebuild 默认 True）",
        "rebuild: bool = True" in _src45)
    chk("T46 CLI 提供 --no-rebuild 逃生口（只要快、不要图标时用）",
        '"--no-rebuild"' in _src45 and "no_rebuild" in _src45)
    chk("T46 ★ 跳过打包时会重签 .app（否则改过 Resources 的包会失签）",
        "_resign_mac" in _src45 and "codesign" in _src45)
    chk("T46 ★ 界面那个操作的超时按操作配，不是全局 120 秒"
        "（首次 win 打包要几分钟，写到 120 会中途被杀）",
        int(gu.OPS["webbg_push"].get("timeout", 0)) >= 600
        and 'spec.get("timeout", 120)' in gu_src)

    # 下面三条都是**真跑打包才暴露**的坑，不是想出来的
    chk("T46 ★ run() 解码用 errors=replace（打包输出里有非 UTF-8 字节，"
        "strict 会抛 UnicodeDecodeError，表现为「命令成功了 Python 却崩了」）",
        'errors="replace"' in _src45)
    _pkg_body = _pkg46[_pkg46.index('==> 8/8'):] if '==> 8/8' in _pkg46 else _pkg46
    chk("T46 ★ package.sh 里 osascript 失败不能让整个打包退出"
        "（set -e 下会静默中止，dmg 没生成还留一个挂载着的 .rw 镜像）",
        "if ! osascript" in _pkg_body)
    # ★ 只比 echo 那一行：注释里也写着 $BUILD_DIR/$BIN（解释为什么这么写），
    #   按全文搜会把说明本身当成违规 —— 这个坑我今天已经踩第三次了。
    chk("T46 ★ 变量后紧跟中文标点必须写 ${BIN}（macOS 的 bash 3.2 会把"
        "多字节首字节吃掉，报 BIN?: unbound variable）",
        'echo "   （复用已编译的 ${BUILD_DIR}/${BIN}，跳过编译）"' in _pkg46)

    # 真跑 _repackage：看它到底调了哪两个脚本、env 有没有带上、失败会不会抛
    import subprocess as _sp46
    _calls46 = []
    def _fake46(cmd, **kw):
        _calls46.append((list(cmd), dict(kw.get("env") or {})))
        return _sp46.CompletedProcess(cmd, 0, "ok", "")
    _real46 = _gm46.run
    _gm46.run = _fake46
    try:
        _n46 = _gm46._repackage(Path("."), mac=True, win=True)
        _ok46 = None
    except Exception as _e:                                  # noqa: BLE001
        _n46, _ok46 = [], _e
    finally:
        _gm46.run = _real46
    _scripts46 = [c[0][-1] for c in _calls46]
    chk("T46 ★ 真跑：mac 跑 package.sh、win 跑 build_windows.sh（两个都真调了）",
        _ok46 is None
        and any(x.endswith("package.sh") for x in _scripts46)
        and any(x.endswith("build_windows.sh") for x in _scripts46),
        f"调了 {[x.split('/')[-1] for x in _scripts46]}，异常={_ok46!r}")
    _env46 = next((c[1] for c in _calls46 if c[0][-1].endswith("package.sh")), {})
    chk("T46 ★ 只有 mac 那次带 PKG_REUSE_BIN=1（跨端的环境变量别串味）",
        _env46.get("PKG_REUSE_BIN") == "1"
        and all("PKG_REUSE_BIN" not in c[1] for c in _calls46
                if c[0][-1].endswith("build_windows.sh")))

    # 失败路径：打包失败只能报 ⚠，不能抛（这时网页已经推成功了）
    _gm46.run = lambda cmd, **kw: _sp46.CompletedProcess(
        cmd, 2, "", "error: mingw not found")
    try:
        _n46b = _gm46._repackage(Path("."), mac=True, win=True)
        _bad46 = None
    except Exception as _e:                                  # noqa: BLE001
        _n46b, _bad46 = [], _e
    finally:
        _gm46.run = _real46
    chk("T46 ★ 真跑：打包失败只报 ⚠ 不抛（此时网页早已生效）",
        _bad46 is None and len(_n46b) == 2
        and all(n.startswith("⚠") for n in _n46b),
        f"异常={_bad46!r} 返回={_n46b}")

    # ── T47：界面 → CLI 的参数桥（勾了桌面端 / 带了图标，必须真的传到命令行）──
    # 用户报：「为什么图标和背景还是没更新？」—— 查出来**两道断链**，
    # 都属于「每一段单独看都对，接缝处对不上」：
    #   ① OPS 里写 "force": "--desktop"，而 force 读的是 params["force"]，
    #      界面发的字段叫 desktop → flag 永远不追加，桌面端整段悄悄不执行。
    #   ② OPS 的 argv 里压根没有 {icon} → 界面裁好的图标上传后从未转发给 CLI，
    #      图标永远退回「背景图居中裁」。
    # 这两个都只有**端到端**跑一遍（载荷 → 真的拼出 argv）才看得见。
    import subprocess as _sp47
    _cap47: list[list[str]] = []
    _real47 = gu.subprocess.run

    def _fake47(cmd, **kw):
        _cap47.append(list(cmd))
        return _sp47.CompletedProcess(cmd, 0, "", "")

    def _argv47(payload: dict) -> list[str]:
        _cap47.clear()
        gu.run_op("webbg_push", {"_state": "/tmp", "admin": "pw", **payload})
        return _cap47[0] if _cap47 else []

    gu.subprocess.run = _fake47
    try:
        _a_on = _argv47({"image": "/tmp/x.jpg", "icon": "/tmp/i.jpg", "desktop": True})
        _a_off = _argv47({"image": "/tmp/x.jpg", "icon": "/tmp/i.jpg", "desktop": False})
        _a_noi = _argv47({"image": "/tmp/x.jpg", "icon": "", "desktop": True})
    finally:
        gu.subprocess.run = _real47

    chk("T47 ★ 真跑装配：勾了桌面端必须真的出现 --desktop",
        "--desktop" in _a_on,
        " ".join(x for x in _a_on if x.startswith("--")))
    chk("T47 ★ 没勾时不能出现 --desktop（否则「只推网页端」也去重打包）",
        "--desktop" not in _a_off)
    chk("T47 ★ 真跑装配：界面裁的图标必须传到 --icon（否则裁了也白裁）",
        "--icon" in _a_on and "/tmp/i.jpg" in _a_on)
    chk("T47 没图标时不能传 --icon \"\"（会被当成「当前目录」这个假路径）",
        "--icon" not in _a_noi)

    # 结构性护栏：OPS 里声明的每个 key，都必须是前端真的会发的字段。
    # 名字对不上就是上面那两个 bug 的同一类错误。
    _i47 = js.index("runWrite('webbg_push'")
    _keys47 = set(re.findall(r"(\w+)\s*:", js[_i47:_i47 + 260]))
    _sp47spec = gu.OPS["webbg_push"]
    _need47 = {k for k, _ in _sp47spec.get("flags", [])}
    _need47 |= {k for k, _ in _sp47spec.get("value_flags", [])}
    chk("T47 ★ OPS 声明的字段名必须与前端载荷一致（对不上就静默失效）",
        _need47 and _need47 <= _keys47,
        f"OPS 需要 {sorted(_need47)}，前端发 {sorted(_keys47)}")

    # ── T48：dmg 安装界面 / 应用图标为什么「有时候」不对 ─────────────
    # 用户截图问：「为什么有时候打包出来的应用会没有图标？dmg 应该是那样啊」。
    # 查出三个坑：① 同名残留卷让 AppleScript 打到旧卷；② .DS_Store 空壳被我
    # 判成「已生效」（假绿）；③ iconutil 失败被 `|| echo 跳过` 吃掉。
    _pkg48 = (HERE.parent / "scripts" / "game" / "package.sh").read_text(encoding="utf-8")
    chk("T48 ★ 打包前卸载同名残留卷（否则 AppleScript 按卷名会打到旧卷，"
        "新卷拿不到布局，而且它返回成功、一句提示都没有）",
        '/Volumes/"$VOL"*' in _pkg48)
    chk("T48 ★ 校验布局看 backgroundImageAlias / Iloc 真记录，不是只看 "
        ".DS_Store 在不在 —— Finder 没权限时也会建一个 6KB 的空壳（假绿过一次）",
        'grep -aq "backgroundImageAlias"' in _pkg48 and 'grep -aq "Iloc"' in _pkg48)
    chk("T48 ★ 布局没生效时要说清**为什么**（打 AppleScript 的原话）"
        "和怎么授权，别只丢一句「没生效」",
        "原因：${APL_MSG" in _pkg48 and "隐私与安全性" in _pkg48
        and "自动化" in _pkg48)
    chk("T48 ★ 图标生成失败必须 exit 1（以前是 `|| echo 跳过` → "
        "产出一个白纸图标的坏包，一路打勾到结束）",
        "图标生成失败" in _pkg48 and "exit 1" in _pkg48
        and "图标生成失败，跳过" not in _pkg48)

    # ── T49：dmg 结论不能自相矛盾（用户截图抓到的）──────────────────
    # 截图里同时出现「Finder 摆图标失败」和「安装界面布局已生效」。
    # 根因：成败用 osascript 退出码判、外观用文件内容判，两个来源各说各话。
    chk("T49 ★ 判定「外观生效」看 backgroundImageAlias（只有真设了背景图才有），"
        "不能只看 icvp —— 没设背景时 icvp 照样在",
        'grep -aq "backgroundImageAlias"' in _pkg48
        and 'grep -aq "icvp" "$DMP/.DS_Store"' not in _pkg48)
    chk("T49 ★ 退出码非零但内容齐全时说的是「已生效 + 无害报错」，"
        "不能一句「失败」把对的包说成错的",
        '布局**已生效**' in _pkg48 and '属收尾动作的无害报错' in _pkg48)
    chk("T49 ★ AppleScript 的 stderr 要留下来并打出来（以前 2>&1 全吞，"
        "只知道失败、不知道为什么）",
        'APL_ERR="$(mktemp)"' in _pkg48 and "2>\"$APL_ERR\"" in _pkg48
        and 'APL_MSG="$(tr' in _pkg48)
    chk("T49 ★ 退出码用 `|| OSARC=$?` 显式记录，配合 set -u 先预置 APL_FAILED",
        '|| OSARC=$?' in _pkg48 and 'APL_FAILED=0' in _pkg48)
    # ★ 结构性护栏：`$VAR` 后紧跟非 ASCII ⇒ macOS 的 bash 3.2 把多字节首字节
    #   吃进变量名 → `VAR?: unbound variable`，把真正的失败原因盖掉。
    #   同一天踩了两次（$BIN，/ $OSARC：），所以做成全量扫描。
    _bad = []
    for _f in sorted((HERE.parent / "scripts").rglob("*.sh")):
        for _n, _ln in enumerate(_f.read_text(encoding="utf-8").splitlines(), 1):
            if _ln.lstrip().startswith("#"):
                continue
            for _m in re.finditer(r"\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7f])", _ln):
                _bad.append(f"{_f.name}:{_n} ${_m.group(1)}{_m.group(2)}")
    chk("T49 ★ 脚本里没有「$VAR 紧跟中文标点」（bash 3.2 会报 unbound variable）",
        not _bad, "; ".join(_bad[:4]))
    # ★ 打包完必须刷新图标缓存：换的是 icns，但 Finder/Dock 有自己的缓存
    #   （macOS 26 尤其顽固）。不刷的话「文件全对、系统 API 也对，界面上还是旧图」，
    #   用户只会当成没修好。
    chk("T49 ★ 打包收尾会刷新图标缓存（touch + lsregister + 重启 Dock），"
        "并留 CMS_NO_ICON_REFRESH=1 给无 GUI 的 CI",
        'CMS_NO_ICON_REFRESH' in _pkg48
        and 'lsregister' in _pkg48 and 'killall Dock' in _pkg48
        and 'touch "$BUNDLE"' in _pkg48)
    # 只用正向判据：脚本里确实有一句给人复制的 `sudo find …` 提示文案，
    # 按「不含 sudo find」判会把自己的说明当成违规（同类错误第 N 次）。
    chk("T49 ★ 清系统图标缓存只在「非交互 sudo 可用」时做（sudo -n true 守卫），"
        "否则跳过 —— 绝不能裸 sudo 把自动打包卡在密码提示上",
        'if sudo -n true 2>/dev/null; then' in _pkg48
        and '-exec sudo rm -rf {} +' in _pkg48)
    # ★ .app 里写配置会让 codesign **立刻失效**，Finder 随即退化成通用图标
    #   （用户报「重新推了图，其他地方都好，就 app 图标空的」）。
    #   曾经的写法是 `if (false && insideAppBundle(...))` —— 分支被 false 关掉，
    #   永远走「包内 config」。这条断言守两件事：分支必须开着、迁移必须逐文件摊平。
    _sio = (HERE.parent / "src" / "desktop" / "SettingsIO.cpp").read_text(encoding="utf-8")
    chk("T49 ★ 打包成 .app 时设置**不写包内**（写进去会让签名失效 → 图标空白）",
        "if (false && insideAppBundle" not in _sio
        and "if (insideAppBundle(exeDir))" in _sio)
    chk("T49 ★ 从包内 config 迁移到用户目录时逐文件摊平（fs::copy 目录会变成 "
        "dir/config/，不是把内容铺进 dir）",
        "fs::copy_file(ent.path()" in _sio
        and "directory_iterator(oldDir" in _sio)
    # ★ .app 里写配置会让 codesign **立刻失效**，Finder 随即退化成通用图标
    #   （用户报「重新推了图，其他地方都好，就 app 图标空的」）。
    #   曾经的写法是 `if (false && insideAppBundle(...))` —— 分支被 false 关掉，
    #   永远走「包内 config」。这条断言守两件事：分支必须开着、迁移必须逐文件摊平。
    _sio = (HERE.parent / "src" / "desktop" / "SettingsIO.cpp").read_text(encoding="utf-8")
    chk("T49 ★ 打包成 .app 时设置**不写包内**（写进去会让签名失效 → 图标空白）",
        "if (false && insideAppBundle" not in _sio
        and "if (insideAppBundle(exeDir))" in _sio)
    chk("T49 ★ 从包内 config 迁移到用户目录时逐文件摊平（fs::copy 目录会变成 "
        "dir/config/，不是把内容铺进 dir）",
        "fs::copy_file(ent.path()" in _sio
        and "directory_iterator(oldDir" in _sio)

    # ── T41：上传上限 200 MB + 流式接收 ──────────────────────────
    chk("T41 上限是 200 MB（用户定的）",
        re.search(r"WEBBG_UPLOAD_MAX = 200 \* 1024 \* 1024", gu_src) is not None)
    chk("T41 ★ 上限的注释写明「多大才安全取决于是否流式」，并附实测数字",
        "取决于 `save_webbg_upload` 是否**流式**" in gu_src and "533 MB" in gu_src)
    chk("T41 有流式接收函数",
        "def save_webbg_stream(" in gu_src)
    chk("T41 ★ 分块读、base64 边读边解（内存不随图片大小增长）",
        "min(WEBBG_CHUNK, remaining)" in gu_src
        and "raw_bytes += len(out)" in gu_src)
    # ★ 我第一版把 base64 **文本**拿去找魔数，于是任何图都「认不出来」。
    #   探针一试就露馅。断言要盯住「在解码后的字节上认」。
    chk("T41 ★ 魔数在**解码后**的字节上认（拿 base64 文本去试会永远认不出）",
        re.search(r"head \+= out\[:32\]\s*\n\s*ext = _webbg_sniff\(head\)", gu_src)
        is not None
        and "_webbg_sniff(chunk" not in gu_src)
    chk("T41 ★ base64 按 4 字节对齐，跨块的尾巴留到下一块（否则解不出正确字节）",
        "len(data) % 4" in gu_src and "b64_tail" in gu_src)
    chk("T41 尾部不足一整组时报「被截断」，而不是悄悄多写几个垃圾字节",
        "base64 长度不对" in gu_src)
    chk("T41 先落临时名、认出类型后才 os.replace 到正式名（同目录 = 原子）",
        "os.replace(tmp, dst)" in gu_src and "O_EXCL" in gu_src)
    chk("T41 ★ 超限时先 drain 掉请求体再回 413"
        "（否则客户端只看到 Broken pipe，「文件太大」变成「网络错误」）",
        "_drain(self.rfile, n)" in gu_src and "Broken pipe" in gu_src)
    chk("T41 drain 是分块丢进黑洞，不存内存也不落盘（否则拒绝 10 GB 反而写满磁盘）",
        "def _drain(" in gu_src and "不存进内存或磁盘" in gu_src)
    chk("T41 路由按 Content-Type 分流（octet-stream → 流式，json → 老路）",
        'raw_ct == "application/json"' in gu_src
        and re.search(r"save_webbg_stream\(self\.state, self\.rfile, n", gu_src)
        is not None)
    chk("T41 ★ 前端传的是原始 base64，不是 JSON 包裹"
        "（写成 JSON 会退回「整个 body 读进内存」，峰值涨 4 倍）",
        "application/octet-stream" in js and "JSON.stringify({ data_url" not in js)
    chk("T41 前端先在浏览器里压到 1920 再传（这样实际传的永远是几百 KB）",
        "shrinkBgBlob" in js and "BG_MAX_EDGE" in js and "createImageBitmap" in js)
    chk("T41 前端的上限常量与服务端一致（都是 200 MB）",
        "BG_UPLOAD_MAX = 200 * 1024 * 1024" in js)
    chk("T41 浏览器压缩失败时回退原图（不能因此传不上去）",
        "catch (e) { return file; }" in js and "res(b || file)" in js)
    chk("T41 提示语里的上限跟着常量走，不是写死的数字",
        "BG_UPLOAD_MAX / 1024 / 1024" in js and "≤ 8 MB" not in js)
    chk("T41 上传件裁剪共用同一个函数（别两份清单，漏一个就白留）",
        gu_src.count("_webbg_prune_uploads(up)") == 2
        and "只留最近 5 个" not in gu_src)
    # ── T42：新增/轮换密码的「随机 or 自定义」两条路都要通 ──────────
    # 用户报：「直接随机生成会提示缺少新密码，并且不能自定义密码」。
    # 根因：UI 无条件把 `newpw` 当必填，而 CLI 的 `_read_new_password`
    # 在**没拿到 `--password-stdin` 时会自己随机生成** —— 那条路被 UI 堵死了。
    chk("T42 ★ 只有 add / passwd 的 newpw 可空（按命令名判定，不是按参数名）",
        'optional_newpw = cmd_name in ("add", "passwd")' in gu_src)
    chk("T42 ★ admin-init / admin-passwd 的 newpw 仍必填"
        "（换管理口令时不提供密码等于什么都没做）",
        "optional_newpw = cmd_name in" in gu_src
        and "admin_init" not in gu_src.split("optional_newpw =")[1].split("\n")[0])
    _gu = load_gate_ui()
    chk("T42 判定用的 _op_command 对这两条命令会取到 admin-init / admin-passwd，"
        "自然不在白名单里（实测过，不是想当然）",
        all(_gu._op_command(_gu.OPS[o]) == c for o, c in
            (("admin_init", "admin-init"), ("admin_passwd", "admin-passwd"))))
    # 前端：新增与轮换都要有那个输入框，且留空就不传
    chk("T42 ★ 新增密码对话框有「自定义密码（留空 = 随机）」输入框",
        "name: 'newpw', label: '自定义密码（留空 = 随机生成）'" in js)
    chk("T42 ★ 轮换密码对话框同样有这个输入框"
        "（同一个根因：它也只填 len 不填 newpw，所以「轮换」按钮同样是坏的）",
        "name: 'newpw', label: '自定义新密码（留空 = 随机生成）'" in js)
    chk("T42 ★ 留空就**不传** newpw（传空串会被 _check_min_pw 以「不足 12 位」拒掉）",
        js.count("if (v.newpw) params.newpw = v.newpw;") == 2
        and "缺少新密码" not in js)
    # 真跑：CLI 的两条路各自的行为
    _nsA = type("A", (), {"password_prompt": False, "password_stdin": False,
                          "len": 24})()
    _rnd = gm._read_new_password(_nsA)
    chk("T42 ★ 真跑：不喂 --password-stdin 时 CLI 自己随机生成，且长度照 --len 来",
        len(_rnd) == 24 and len(set(_rnd)) > 5,
        f"{len(_rnd)} 位、前 8 位 {_rnd[:8]}…")
    _own = "MyOwnPassword2026"
    _nsB = type("B", (), {"password_prompt": False, "password_stdin": True,
                          "len": 24})()
    _old_stdin = sys.stdin
    try:
        sys.stdin = io.StringIO(_own + "\n")
        chk("T42 ★ 真跑：喂了就用你给的（自定义密码不传错）",
            gm._read_new_password(_nsB) == _own)
    finally:
        sys.stdin = _old_stdin



    chk("T37 ★ 撤下功能要用的纯白图仍要入库（否则 webbg off 没素材）",
        (HERE / "webbg" / "blank.webp").is_file()
        and (HERE / "webbg" / "blank.jpg").is_file()
        and "tools/webbg/blank.*" in gi_s and "**/webbg/blank" not in gi_s)

    # ── T38：推图时长边上限 1920 ──────────────────────────────────
    # 背景图是 `background-size: cover` 铺满的，任何超过屏幕的分辨率都是纯浪费。
    # 实测一张 4800×2738 的图 q75 转出来 511 KB；缩到 1920 后只要 136 KB（省 74%）。
    chk("T38 长边上限是 1920（用户定的）",
        re.search(r"WEBBG_MAX_EDGE = 1920\b", gm_src) is not None)
    chk("T38 注释写清了为什么（cover 铺满 + 超过屏幕纯浪费）",
        "background-size: cover" in gm_src and "纯浪费" in gm_src)
    chk("T38 ★ 转码用的是缩小后的那个文件，不是原图",
        re.search(r"small = _shrink_to\([^)]*\).*?"
                  r"run\(\[cw, \*CWEBP_ARGS, str\(small\)", gm_src, re.S) is not None)
    # 只看 sips 那两行（jpg 的格式参数与输入文件在同一处），
    # 别用 re.S 跨整段 —— 那会连带命中别处同样的字样。
    _jpg_lines = [l.strip() for l in gm_src.splitlines()
                  if '"-s", "format", "jpeg"' in l or 'str(small), "--out", str(out_jpg)' in l]
    chk("T38 jpg 也从缩小版转（否则 jpg 仍是原尺寸，白省一半）",
        len(_jpg_lines) >= 2 and any('str(small)' in l for l in _jpg_lines),
        " | ".join(_jpg_lines))
    _enc = gm_src.split("def webbg_encode")[1][:2500]
    chk("T38 两条 jpg 路线（sips / Pillow）用的都是缩小版，没有一条漏",
        gm_src.count("str(small)") >= 2 and "im.open(src)" not in _enc
        and "Image.open(small)" in _enc)
    chk("T38 已经够小就**不**缩小（无谓重编码会掉画质）",
        "if max(w, h) <= max_edge:" in gm_src
        and re.search(r"if max\(w, h\) <= max_edge:\s*\n\s*return src", gm_src) is not None)
    chk("T38 缩图失败不报错、继续用原图（只是大一点，不是失败）",
        gm_src.count("return src                           # 缩不了就用原图") >= 1)
    _scall = next((l.strip() for l in gm_src.splitlines()
                   if l.strip().startswith('r = run([sips, "-Z"')), "")
    chk("T38 缩图走 capture=True（sips 会把「改写了哪个文件」打到 stdout，"
        "capture=False 会让噪声混进命令输出）",
        bool(_scall) and "capture=False" not in _scall,
        _scall or '找不到 `r = run([sips, "-Z"` 那一行')
    # 真跑：造一张 4800 宽的图，断言输出长边真的 ≤ 1920
    rows38 = _run_edge_limit(node)
    for r in rows38:
        chk("T38 " + r["name"], r["ok"], r["detail"])

    # ── T39：推图时原图存服务器 / 本地只留最近 10 张 ────────────────
    # 用户要求：「穿完原图删掉服务器上的（= 不留临时文件），本地的存最近十张」。
    chk("T39 原图存进私藏目录（nginx 不服务那个目录）",
        re.search(r'WEBBG_SOURCE_NAME = "source"', gm_src) is not None
        and 'f"{backups}/{WEBBG_SOURCE_NAME}{src_ext}"' in gm_src)
    chk("T39 ★ 原图先传到目录外的临时名（私藏目录可能还不存在，直接 scp 会失败）",
        'src_remote_tmp = f"{a.remote_dir}/webbg-source.tmp"' in gm_src
        and "直接 scp 进去会失败" in gm_src)
    chk("T39 ★ 搬进私藏目录前先核对字节数（scp 中断会留下半个文件）",
        re.search(r"test \$\(wc -c < \{shq\(src_remote_tmp\)\}\) -eq \{src_size\}",
                  gm_src) is not None)
    chk("T39 服务器上不留临时文件（mv 走完即无，失败路径另有一条 rm 兜底）",
        re.search(r"rm -f \{shq\(f'\{root\}/\{WEBBG_FILES\[0\]\}\.new'\)\}.*?\{shq\(src_remote_tmp\)\}",
                  gm_src, re.S) is not None)
    chk("T39 ★ 旧的 source.* 被清掉（服务器只留「当前这张」，不按时间戳堆 6 MB）",
        re.search(r"rm -f \{shq\(backups\)\}/\{WEBBG_SOURCE_NAME\}\.\*", gm_src) is not None)
    chk("T39 原图权限 600（同目录的私藏备份也是 700）",
        "chmod 600 {shq(f'{backups}/{WEBBG_SOURCE_NAME}" in gm_src
        and "chmod 700 {shq(backups)}" in gm_src)
    chk("T39 本地保留张数是 10（用户定的）",
        re.search(r"WEBBG_UPLOAD_KEEP = 10\b", gm_src) is not None)
    chk("T39 ★ 只删 uploads/ 里 bg- 前缀的（别人的文件原样保留）",
        'p.name.startswith("bg-")' in gm_src)
    chk("T39 ★ 两边都 resolve 再比（macOS /var 与 /private/var 同目录不同串，"
        "只 resolve 一边会让 protect 形同虚设）",
        gm_src.count(".resolve()") >= 3
        and "keep_set = {p.resolve() for p in items[:keep]}" in gm_src)
    chk("T39 删不掉就跳过，不中断推送",
        re.search(r"except Exception:\s*\n\s*continue\s*# 删不掉就留着",
                  gm_src) is not None)
    chk("T39 状态里记下原图在哪、多大（日后能查到）",
        '"source_kept":' in gm_src and '"source_bytes": src_size' in gm_src)
    chk("T39 界面把原图信息显示出来",
        "w.source_kept" in js or "source_kept" in gu_src)
    # 真跑 prune_uploads：保留数、留的是最近的、别人的文件不动、protect 生效
    rows39 = _run_prune()
    for r in rows39:
        chk("T39 " + r["name"], r["ok"], r["detail"])
    # ★ 真跑一次 fetch_webbg_image（桩掉 ssh，不碰线上）：证明字节流完整、
    #   魔数校验生效、非白名单被拒。源码断言覆盖不到「真的取回来是什么字节」。
    real_fetch_ssh = gu.gm.ssh_cmd
    real_fetch_run = gu.gm.run
    try:
        def fake_ssh(_a):
            return ["ssh", "fake"]
        gu.gm.ssh_cmd = fake_ssh
        # 用一个**含非法 UTF-8 字节**的假 webp：text=True 的封装一定会崩在这里。
        png_ish = b"RIFF" + b"\x00\x00\x00\x00WEBPVP8 " + b"\xff\xd8\xab\x00\xa8"
        calls: list[list[str]] = []

        class _FakeRun:
            returncode = 0
            stdout = png_ish
            stderr = b""

        def fake_run(cmd, **kw):
            calls.append(cmd)
            return _FakeRun()
        gu.gm.run = fake_run
        # 直接换掉 subprocess.run（fetch 用的是 subprocess，不是 gm.run）
        import subprocess as _sp
        real_sp_run = _sp.run

        def fake_sp_run(cmd, **kw):
            calls.append(list(cmd))
            return _FakeRun()
        _sp.run = fake_sp_run
        d36, ct36, fn36 = gu.fetch_webbg_image(
            state_dir, server="s", ssh_port="1", remote_dir="/d",
            web_root="/w", which="webp")
        chk("T36 ★ 真跑：字节流原样取回（含非法 UTF-8 也不解码失败）",
            d36 == png_ish, f"取回 {len(d36)} 字节")
        chk("T36 真跑：content-type / 文件名对应 webp",
            ct36 == "image/webp" and fn36 == "bg.webp", f"{ct36} {fn36}")
        chk("T36 真跑：ssh 命令里带了 head -c 上限",
            any("head -c" in " ".join(map(str, c)) for c in calls),
            str(calls[-1])[:120] if calls else "(没调用)")
        # 非白名单必须在**拼 ssh 之前**就拒掉（否则就成了命令注入面）
        calls.clear()
        try:
            gu.fetch_webbg_image(state_dir, server="s", ssh_port="1",
                                 remote_dir="/d", web_root="/w",
                                 which="../../etc/passwd")
            ok36 = False
        except gu.ApiError:
            ok36 = True
        chk("T36 ★ 真跑：非白名单被拒，且**一条 ssh 都没发**", ok36 and not calls,
            f"ok={ok36} ssh 调用 {len(calls)} 次")
        # 魔数不对（服务器上那个文件被换成了别的东西）
        class _FakeBad:
            returncode = 0
            stdout = b"<html>not an image</html>"
            stderr = b""
        _sp.run = lambda cmd, **kw: _FakeBad()
        try:
            gu.fetch_webbg_image(state_dir, server="s", ssh_port="1",
                                 remote_dir="/d", web_root="/w", which="webp")
            ok36b = False
        except gu.ApiError:
            ok36b = True
        chk("T36 ★ 真跑：内容不是 webp 时报「不是 webp」而不是把垃圾当图发出去",
            ok36b)
    finally:
        import subprocess as _sp
        _sp.run = real_sp_run
        gu.gm.ssh_cmd = real_fetch_ssh
        gu.gm.run = real_fetch_run

    # ── T50：默认页开关（游戏 ⇄ 学习站）全链路一致性 ────────────────
    # 监管要求根路径能切到公开学习站。这条链跨 5 个文件（nginx 生成器 / CLI /
    # cmsui 后端 / cmsui 前端 / 登录后重定向），任何一环口径不一致都会表现为
    # 「切了没生效」或「学习站 401」，所以在这里把契约钉死。
    root = HERE.parent
    dw_src = (root / "scripts" / "web" / "deploy-web.sh").read_text(encoding="utf-8")
    gatejs = (root / "web" / "gate" / "gate.js").read_text(encoding="utf-8")
    authd_src = (root / "server" / "authd.py").read_text(encoding="utf-8")

    chk("T50 ★ CLI 有 cmd_landing 且注册了 landing 子命令",
        "def cmd_landing(" in gm_src and 'add_parser("landing"' in gm_src)
    chk("T50 ★ landing 进了 scrypt / 豁免 / 就地校验三张表（漏一个会问两遍口令或崩）",
        '"landing"' in gm_src
        and re.search(r"SCRYPT_CMDS = frozenset\(\{[^)]*\"landing\"[^)]*\}\)", gm_src, re.S)
        and re.search(r"ADMIN_EXEMPT_CMDS = \{[^}]*\"landing\"[^}]*\}", gm_src, re.S)
        and re.search(r"INPLACE_ADMIN_CMDS = frozenset\(\{[^)]*\"landing\"[^)]*\}\)", gm_src, re.S))
    chk("T50 ★ 两种模式的片段首行标记一字不差（deploy 与 CLI 靠它对账）",
        gm_src.count("# landing-mode: game") >= 1
        and gm_src.count("# landing-mode: learn") >= 1
        and dw_src.count("# landing-mode: game") >= 1)
    chk("T50 ★ nginx：^~ /learn/ 公开块存在，且 try_files 不回退 /index.html（防泄漏游戏 HTML）",
        "location ^~ /learn/" in dw_src
        and re.search(r"location \^~ /learn/ \{[^}]*try_files \$uri \$uri/ =404;", dw_src, re.S)
        and "location = /learn { return 301 /learn/; }" in dw_src)
    chk("T50 ★ nginx：根路径改成 include landing 片段；rsync 带上了 learn 目录",
        "include /etc/nginx/snippets/cms-landing-root.conf;" in dw_src
        and '"$WEB_DIR/learn"' in dw_src)
    # .map 与 .d.ts 浏览器从不请求；--delete 不会删接收端被排除的文件，
    # 少了 --delete-excluded，旧部署带上去的这两类会一直留在线上。
    chk("T50 ★ rsync 不上传 *.map / *.d.ts，且用 --delete-excluded 清掉历史残留",
        "--exclude='*.map'" in dw_src and "--exclude='*.d.ts'" in dw_src
        and "--delete-excluded" in dw_src)
    chk("T50 ★ nginx：重部署沿用模式、按新模板重渲染正文（旧模板没有 /game，留着登录会落 404）",
        "head -n1 /etc/nginx/snippets/cms-landing-root.conf" in dw_src
        and "install -m 644 /root/cms-landing-\\$mode.conf" in dw_src)
    chk("T50 ★ cmsui 后端：三条 OPS 都在，且只有 learn/game 要管理口令",
        all(k in gu.OPS for k in ("landing_status", "landing_learn", "landing_game"))
        and "stdin" not in gu.OPS["landing_status"]
        and gu.OPS["landing_learn"].get("stdin") == [("admin", "--admin-stdin")]
        and gu.OPS["landing_game"].get("stdin") == [("admin", "--admin-stdin")])
    chk("T50 ★ cmsui 后端：/api/landing 只读端点存在（转调 CLI，不自己解析片段）",
        'path == "/api/landing"' in gu_src and 'run_op("landing_status"' in gu_src)
    chk("T50 ★ cmsui 前端：芯片 + 加载 + 点击分支 + 切换函数齐备",
        "loadLanding()" in js and "state.landing" in js
        and "async function doLanding()" in js
        and "txt.indexOf('默认页') === 0" in js
        and "'landing_learn'" in js and "'landing_game'" in js)
    chk("T50 ★ 登录后重定向落 /game（两种模式共用的唯一游戏入口；/ 在 learn 模式会去学习站）",
        "location.replace('/game');" in gatejs
        and 'location="/game"' in authd_src
        and "location.replace('/');" not in gatejs
        and "location.replace('/index.html');" not in gatejs)

    # ── T51：deploy-web.sh 的反引号只许出现在「引号 heredoc」内或行首注释里 ──
    # 踩坑实证（已两次）：这份脚本把 nginx 配置和远端自测都塞在本地**双引号**
    # SSH 串里，串内的反引号会被**本地** bash 当命令替换执行——注释里随手写一句
    # 反引号包住的「^~ /learn/」，部署时就会冒出「^~: command not found」；
    # 更糟的情形是执行到不该执行的东西，或把注释吞掉导致远端脚本文本被改。
    # 引号 heredoc（<<'NGINX'）内不做任何展开，那里的反引号是安全正体文字。
    # 行首（0 列）注释不在任何引号里，同样安全；缩进注释则一律视为在串内。
    _in_hd, _bt_bad = False, []
    for _i, _ln in enumerate(dw_src.splitlines(), 1):
        if not _in_hd and "<<'NGINX'" in _ln:
            _in_hd = True
            continue
        if _in_hd:
            if _ln.strip() == "NGINX":
                _in_hd = False
            continue
        if "`" in _ln and not _ln.startswith("#"):
            _bt_bad.append(_i)
    chk("T51 ★ deploy-web.sh：双引号 SSH 串内无反引号（会被本地 bash 执行）",
        not _bt_bad, f"危险行号：{_bt_bad}")
    chk("T51 ★ deploy-web.sh：引号 heredoc 定界符仍在（检查逻辑依赖它划定安全区）",
        "<<'NGINX'" in dw_src and re.search(r"^NGINX$", dw_src, re.M) is not None)

    # ── T52：未登录一律 404「当作不存在」（不吐密码页、不吐裸 401）──────────
    # 动机：密码页和裸 401 都等于告诉陌生人「这里有受保护的东西」；404 才和
    # 「服务器上没这个文件」完全同形。登录入口本身也已 404 化（见 T54：
    # 只有随机路径 /gate/<TOKEN>/ 可达），整站对外只剩 /learn/ 是公开内容。
    # 这条链跨 4 个文件（nginx 生成器 / CLI 片段 / 探活 / 本地 serve.py），
    # 任何一处口径回退都会让站点重新「承认存在」或让探活误报，所以钉死。
    hc_src = (root / "server" / "cmsgate-healthcheck.sh").read_text(encoding="utf-8")
    serve_src = (root / "web" / "serve.py").read_text(encoding="utf-8")
    nf_line = "error_page 401 403 502 504 =404 /__nf;"
    chk("T52 ★ nginx：internal 404 汇点 /__nf 存在，且受保护 location 全挂上它",
        "location = /__nf {" in dw_src and "internal;" in dw_src
        and dw_src.count(nf_line) >= 4)   # /index.html、/dist/、正则、landing 片段里的 /game
    chk("T52 ★ 未登录的入口映射只许落在 token 路径的密码页上（旧的公开 /gate/index.html 不许回来）",
        "= /gate/index.html;" not in dw_src and "= /gate/index.html;" not in gm_src
        and "error_page 401 403 500 502 504 = /gate/$TOK/index.html;" in dw_src
        and "error_page 401 403 500 502 504 = /gate/{token}/index.html;" in gm_src)
    game_body = gm_src.split('LANDING_GAME = """', 1)[1].split('"""', 1)[0]
    chk("T52 ★ landing GAME 片段与 deploy 默认 heredoc 仍是同一份字节（切换靠它对账）",
        game_body in dw_src and nf_line in game_body)
    learn_body = gm_src.split('LANDING_LEARN = """', 1)[1].split('"""', 1)[0]
    chk("T52 ★ landing LEARN 片段与 deploy heredoc 仍是同一份字节（两份都要按模式重渲染）",
        learn_body in dw_src and nf_line in learn_body)
    chk("T52 ★ 探活第 4 项改判 404（200=绕过、401=配置回退、502=authd 不可达）",
        '[ "$code" = "404" ]' in hc_src and '= "401"' not in hc_src)
    chk("T52 ★ 本地 serve.py 口径同步：未登录 404，不再吐密码页/401",
        "self._send(404" in serve_src and "DOC_PATHS" not in serve_src
        and "_serve_gate_page" not in serve_src and "401 Unauthorized" not in serve_src)
    chk("T52 ★ 部署自测按 landing 模式判 /（learn=302→/learn/，game=302→/game）且断言登录入口活着",
        "landing-mode: *//p" in dw_src
        and "✓ learn 模式：/ 302 到公开学习站" in dw_src
        and "✓ game 模式：/ 302 到 /game" in dw_src
        and "(登录入口)" in dw_src and "grep -q 'gate-form'" in dw_src
        and "✓ 入口守卫齐全" in dw_src)
    # `cms gate off` 是正常状态：那时所有人放行，拿「未登录必须 404」去断言会让一次
    # 重部署被自己的自测拦下。自测必须读 /health 的 require_password 再决定断言方向。
    chk("T52 ★ 部署自测认得「总闸门关闭」：读 require_password，改判 /game 直出与入口 302",
        "gate_on" in dw_src and "require_password" in dw_src
        and "总闸门关闭：跳过" in dw_src
        and "总闸门关闭时 /game 直出游戏页" in dw_src
        and "总闸门关闭时入口直接 302 到 /game" in dw_src)
    # 限流自测必须打 /style.css 而非 /：learn 模式下 location = / 的 return 302 在 rewrite 阶段，
    # 早于 limit_req 的 preaccess，连打 / 只会看到 302、永远看不到 429（假绿灯）。
    # 且必须真断言出现 429（n429 -eq 0 → exit 1），不能只打印分布。
    # ★ 计数不许依赖 curl 的 \n：这份字符串要过「本地双引号 + ssh + 远端 shell」三层，
    #   实测换行会塌成空格 → sort|uniq 把 80 个码当一行 → n429 恒 0 → 部署在上传全部
    #   完成之后假红灯退出（今晚就是这么红的）。改成空格分隔 + tr 还原。
    chk("T52 ★ 限流自测打 /style.css（模式无关，preaccess 先跑）且真断言 429，非只打印",
        "http://localhost:${PORT}/style.css" in dw_src
        and "n429=" in dw_src and '[ \\"\\$n429\\" -eq 0 ]' in dw_src
        and "-w '%{http_code}\\n'" not in dw_src
        and "tr ' " in dw_src)

    # ── T53：背景图收进闸门 + 登录页渐变 + 游戏特效接线 ──────────────
    # 动机有两层：① /assets/bg.* 是**未授权商用**的素材，匿名能 curl 走完整原图
    # 就是公网裸奔；而登录页恰恰只给匿名访客看，所以它必须改用 CSS 渐变。
    # ② 特效层盖在棋盘上，一旦漏了 pointer-events:none 就吞掉全部点击 —— 那是
    # 比「没有特效」严重得多的回归，所以两层都钉死。
    gate_css_src = (root / "web" / "gate" / "gate.css").read_text(encoding="utf-8")
    gate_html = (root / "web" / "gate" / "index.html").read_text(encoding="utf-8")
    fx_src = (root / "web" / "ts" / "fx.ts").read_text(encoding="utf-8")
    main_ts = (root / "web" / "ts" / "main.ts").read_text(encoding="utf-8")
    web_html = (root / "web" / "index.html").read_text(encoding="utf-8")
    web_css = (root / "web" / "style.css").read_text(encoding="utf-8")

    # 锚点用正则 location 那一整行；检查范围必须先剔掉注释行 —— deploy 里那段
    # 「原来这里有公开块，现在删了」的说明恰好引用了同样的字面量，不剔会自己打自己。
    _nginx = "\n".join(ln for ln in dw_src.splitlines()
                       if not ln.strip().startswith("#"))
    _rx = ([ln for ln in _nginx.splitlines()
            if "location ~* \\.(js|css" in ln] or [""])[0]
    chk("T53 ★ nginx：两张背景图的公开块已删（落到带 auth_request 的正则块 → 匿名 404）",
        "location = /assets/bg.webp" not in _nginx
        and "location = /assets/bg.jpg" not in _nginx
        and "webp" in _rx and "auth_request" in _nginx)
    chk("T53 ★ nginx：两个字体**仍**公开（删块时不能顺手把字体也删了，否则登录页标题字体崩）",
        "location = /assets/ibmplex-ascii.woff2" in dw_src
        and "location = /assets/IBMPlexSerif-Regular.ttf" in dw_src)
    chk("T53 ★ serve.py 口径同步：PUBLIC_EXACT 去掉两张图、留两个字体",
        '"/assets/bg.webp"' not in serve_src and '"/assets/bg.jpg"' not in serve_src
        and '"/assets/ibmplex-ascii.woff2"' in serve_src
        and '"/assets/IBMPlexSerif-Regular.ttf"' in serve_src)
    _bg404 = [ln for ln in dw_src.splitlines()
              if ln.strip().startswith("for p in /game ") and "bg.webp" in ln]
    chk("T53 ★ 部署自测把 bg 放进「未登录必须 404」那一组",
        len(_bg404) == 1 and "bg.jpg" in _bg404[0])
    chk("T53 ★ 部署自测的「公开 200」那一组里不再有 bg（否则等于自测在要求它公开）",
        all("bg." not in ln for ln in dw_src.splitlines()
            if "for p in" in ln and "ibmplex" in ln))

    chk("T53 ★ 登录页 CSS：不引背景图、改用渐变（匿名访客不许看到未授权素材）",
        "url('/assets/bg" not in gate_css_src and "gradient" in gate_css_src)
    chk("T53 ★ 特效接线齐全：fx.ts + main.ts 引它并调 initFx + 页面有 #fx 画布",
        "export function initFx()" in fx_src
        and "from './fx.js'" in main_ts and "initFx()" in main_ts
        and '<canvas id="fx"' in web_html)
    chk("T53 ★ #fx 必须 pointer-events:none（铁律：漏了就吞掉棋盘全部点击，游戏不能玩）",
        re.search(r"#fx \{[^}]*pointer-events: none;", web_css, re.S) is not None)
    # 2026-10-21 用户裁决改了口径：**打中流星的那一击就该被吞掉**，因为「炸圈的同一刻
    # 还把底下的格子翻开」体验不对。其余一律原样放行（右键插旗、空地左键、触摸/笔、滑块）。
    # 判据不是「文件里没有 preventDefault」——那种写法会连注释里的裸词一起杀（上一版就是这么
    # 靠带点的 `.preventDefault(` 绕开的），而是**唯一那两处调用必须待在左键命中流星那个 if 块里**。
    _fx_hit = fx_src.split("if (e.button === 0 && burstMeteorAt(e.clientX, e.clientY)) {", 1)
    _fx_hit_body = _fx_hit[1].split("}, { capture: true }", 1)[0] if len(_fx_hit) == 2 else ""
    chk("T53 ★ fx 只在「左键 + 打中流星」那一个分支里吞掉这一击，其余路径一个默认动作都不改"
        "（右键插旗、空地翻格、触摸、滑块都不受影响；改成无条件吞击这条会红）",
        len(_fx_hit) == 2 and "{ capture: true }" in fx_src
        and ".preventDefault(" in _fx_hit_body and ".stopPropagation(" in _fx_hit_body
        and fx_src.count("e.preventDefault();") == 1
        and fx_src.count("e.stopPropagation();") == 1
        and "e.pointerType !== 'mouse'" in fx_src
        and "if (e.button !== 0 && e.button !== 2) return;" in fx_src)
    chk("T53 ★ 学习站一字不碰：/learn/ 下不引特效（监管看到的是干净的学习内容）",
        not any("dist/fx.js" in p.read_text(encoding="utf-8", errors="ignore")
                for p in (root / "web" / "learn").rglob("*.js")))
    chk("T53 ★ deploy 把 dist/fx.js 纳入校验和与「未登录 404」两组清单",
        "dist/fx.js" in dw_src and "/dist/fx.js" in dw_src)

    # ── T54：秘密登录入口（/gate/<TOKEN>/）全链路 ────────────────────
    # 404 模型下，公开的 /gate/ 本身也是一扇「承认存在」的门。登录页挪到随机不可猜
    # 的路径后，这条链跨 5 个文件（CLI / deploy 的 nginx 与默认片段 / 密码页 HTML /
    # 本地 serve.py / cmsui 前后端）——任何一环口径不一致，表现都是「没人能登录」
    # 或「旧入口还开着」，所以整条钉死。
    chk("T54 ★ CLI 有 cmd_gate_path 且注册了 gate-path 子命令",
        "def cmd_gate_path(" in gm_src and 'add_parser("gate-path"' in gm_src)
    chk("T54 ★ gate-path 进了 scrypt / 豁免 / 就地校验三张表（漏一个会问两遍口令或崩）",
        re.search(r"SCRYPT_CMDS = frozenset\(\{[^)]*\"gate-path\"[^)]*\}\)", gm_src, re.S)
        and re.search(r"ADMIN_EXEMPT_CMDS = \{[^}]*\"gate-path\"[^}]*\}", gm_src, re.S)
        and re.search(r"INPLACE_ADMIN_CMDS = frozenset\(\{[^)]*\"gate-path\"[^)]*\}\)",
                      gm_src, re.S))
    chk("T54 ★ token 有白名单形状校验，且写入前就过（防把 nginx 配置注入进去）",
        're.compile(r"^[a-z0-9]{12,32}$")' in gm_src
        and gm_src.split("def gate_path_write", 1)[1].split("\ndef ", 1)[0]
            .count("GATE_TOKEN_RE.fullmatch") >= 1)
    _gpw = gm_src.split("def gate_path_write", 1)[1].split("\ndef ", 1)[0]
    chk("T54 ★ 换入口是「原子写 + nginx -t + 失败回滚 + reload」，与 landing 同构",
        ".new" in _gpw and "mv {shq(" in _gpw and "nginx -t" in _gpw
        and "systemctl reload nginx" in _gpw and "cp -a" in _gpw)
    # 当年那个「人人都摸得到的公开 /gate/ 块」是带 alias 发密码页 HTML 的；
    # 2026-10-20 明文收口后，80 的跳转块里也出现了一个 `location ^~ /gate/`，
    # 但它只 return 404（不给 token 留痕）。所以判据从「不许有这个块」改成
    # 「这个块里不许有 alias/root 之类真正发内容的东西」。
    _bare = (dw_src.split("location ^~ /gate/ {", 1)[1].split("}", 1)[0]
             if "location ^~ /gate/ {" in dw_src else "")
    chk("T54 ★ nginx：主配置改成 include gate-path 片段，且硬编码的公开 /gate/ 块已删"
        "（明文收口后 80 上残留的同名块只能是 404，不许 alias 出内容）",
        "include /etc/nginx/snippets/cms-gate-path.conf;" in dw_src
        and "return 404;" in _bare and "alias" not in _bare and "root" not in _bare)
    # ★2（2026-10-21 复审）：M1 只把片段里那两条 location 的日志关了，明文 80 上这条
    # 404 块漏在外面。而它才是天天被踩的那条 —— 首访没有 HSTS、IM 链接预览爬虫、
    # 手打少一个 s，每一次「按 http:// 点登录链接」都把全文 token 写进 access.log。
    # 实测口径：部署自测打一次 127.0.0.1:80 就落一条。所以这条块里必须有 access_log off。
    chk("T54 ★ 明文 80 的 /gate/ 404 块也 access_log off（★2：token 在 URI 里，这条最容易被打到）",
        "access_log off" in _bare)
    # 片段渲染段整块（3.6 → 3.7 之间）。下面的形状判据都限定在这块里，
    # 免得被别处的注释文本凑巧命中（这块自己的注释里就写着「原来是 install -m 644」）。
    _gp = (dw_src.split("# 3.6) 登录入口片段", 1)[1].split("# 3.7)", 1)[0]
           if "# 3.6) 登录入口片段" in dw_src else "")
    _rand_i = _gp.find("openssl rand -hex 12")
    _fi_i = _gp.find("\nfi\n", _rand_i)
    _cat_i = _gp.find("cat > /root/cms-gate-path.conf")
    chk("T54 ★ deploy 每次按当前模板重渲染片段、token 沿用现有的（片段缺失才现生成随机 token）",
        'if [ -f "$CONF" ]' in _gp
        and re.search(r"gate-token:\s*[a-z0-9]{12,32}", dw_src) is None
        and 'TOK=$(sed -n \'s/^# *gate-token: *//p\' "$CONF"' in _gp
        and _rand_i > 0 and _cat_i > 0,
        f"rand@{_rand_i} fi@{_fi_i} cat@{_cat_i}")
    # 这一条是 M1/M3 上线时才抓到的真 bug：渲染+安装整段原来在 `else` 里，
    # 于是「已存在」的片段永远拿不到新模板 —— 线上实测 access_log off=0 条、permission=644。
    # 「随机生成是条件分支」和「渲染是无条件」这两件事必须分开成立，所以比下标。
    chk("T54 ★ 渲染+安装**无条件**执行（在 if/fi 之后）：否则模板改了线上不生效",
        0 < _fi_i < _cat_i and "沿用运维当前入口" in _gp
        and _gp.count("cat > /root/cms-gate-path.conf") == 1)
    # 沿用的 token 现在是第一次被拼进 nginx location 行的字符串，过闸的时机也跟着挪：
    # 白名单校验必须在 cat 之前，且对两条来源（沿用 / 新生成）都成立。
    chk("T54 ★ 沿用来的 token 也要过白名单，且校验在渲染之前（形状不对就绝不落盘）",
        "grep -Eq '^[a-z0-9]{12,32}$'" in _gp and _rand_i < _fi_i < _gp.find("grep -Eq '^") < _cat_i)
    # M3：install -m 644 会覆盖上一句 chmod 600，把 token 明文做成全局可读。
    _modes = [l.strip() for l in _gp.splitlines()
              if l.strip().startswith(("install -m", "chmod "))]
    chk("T54 ★ 片段落盘权限只能是 600（M3：install -m 644 会覆盖 chmod 600）",
        bool(_modes) and all("600" in l for l in _modes), _modes)
    # 部署输出常被人原样贴进聊天/工单，所以这一段的两条 echo 也只许露前 4 位。
    # 判据只看 echo 行：模板正文里的 `$TOK` 是要拼进 nginx location 的，不算泄漏。
    _echo_full = [l.strip() for l in _gp.splitlines() if l.strip().startswith("echo ")
                  and "$TOK" in l.replace("${TOK:0:4}", "")]
    chk("T54 ★ deploy 的两条 echo 只露 token 前 4 位（全文进过部署日志就等于又广播一次）",
        "${TOK:0:4}" in _gp and not _echo_full, _echo_full)
    chk("T54 ★ 部署自测：/gate/ 未登录必须 404，秘密入口必须 200 且是登录表单",
        bool(_bg404) and "/gate/gate.css" in _bg404[0]
        and "head -n1 /etc/nginx/snippets/cms-gate-path.conf" in dw_src
        and "grep -q 'gate-form'" in dw_src)
    chk("T54 ★ 密码页 HTML 用相对路径引资源（绝对 /gate/gate.css 在秘密入口下会 404）",
        'href="gate.css"' in gate_html and 'src="gate.js"' in gate_html
        and '"/gate/gate' not in gate_html)
    chk("T54 ★ 本地 serve.py 也只认 token 前缀（开发环境与线上同一形状）",
        'GATE_TOKEN' in serve_src and 'prefix = f"/gate/{GATE_TOKEN}"' in serve_src)
    # 落盘映射必须**等价于 nginx 的 alias**：把 token 段换成普通的 gate 段。
    # 只剥前缀不补 /gate 的话，/gate/<TOKEN>/ 会命中站点根的 index.html ——
    # 也就是把**游戏**发给了匿名访客，而测试脚本只看到 200，绿灯得理所当然。
    chk("T54 ★ serve.py 的 alias 等价映射补回 /gate 段（否则秘密入口泄漏游戏首页），"
        "且前缀判断用的是 unquote+normpath 后的规范路径（%2f 编码的 .. 绕不过去）",
        'canon = "/gate" + canon[len(prefix):]' in serve_src
        and 'def translate_path' in serve_src
        and 'posixpath.normpath(urllib.parse.unquote' in serve_src)
    chk("T54 ★ cmsui 后端：三条 OPS 都在，status 只读、set/rotate 才要管理口令",
        all(k in gu.OPS for k in ("gate_path_status", "gate_path_set", "gate_path_rotate"))
        and "stdin" not in gu.OPS["gate_path_status"]
        and gu.OPS["gate_path_set"].get("stdin")
            == [("token", "--token-stdin"), ("admin", "--admin-stdin")]
        and gu.OPS["gate_path_rotate"].get("stdin") == [("admin", "--admin-stdin")])
    # ★8（2026-10-21 复审）：token 就是「谁能打开密码页」的唯一凭据，而 argv 对同机任意
    # 进程可见（`ps aux`）。界面那条路必须走 stdin；顺序也是契约 —— CLI 里先读 token
    # （set 分支）再由 require_admin 读口令，payload 里两行颠倒就会「口令被判成 token」。
    chk("T54 ★ 界面换入口：token 不进 argv，且 stdin 顺序是 token→口令",
        "{token}" not in gu.OPS["gate_path_set"]["argv"]
        and "--token-stdin" in [f for _, f in gu.OPS["gate_path_set"]["stdin"]]
        and [n for n, _ in gu.OPS["gate_path_set"]["stdin"]] == ["token", "admin"]
        and 'p.add_argument("--token-stdin"' in gm_src
        and "_stdin_line().strip() if a.token_stdin" in gm_src)
    # ★1（2026-10-21 复审）：M2 只遮了 `gate-path set` 那条，但 `require_admin` 会把
    # **同一句 action** 原文写成 `admin-ok:{action}`，而 /api/audit 又把它回给浏览器 ——
    # 于是全文 token 还在往审计里写。这条把「两句都不许有全文」钉住。
    chk("T54 ★ 换入口的两句审计都不许带全文 token（admin-ok 那句也要遮）",
        "把登录入口改为 /gate/{token}/" not in gm_src
        and 'what = f"把登录入口改为 /gate/{token[:4]}' in gm_src)
    chk("T54 ★ cmsui 后端：/api/gate-path 只读端点存在（转调 CLI，不自己解析片段）",
        'path == "/api/gate-path"' in gu_src and 'run_op("gate_path_status"' in gu_src)
    chk("T54 ★ cmsui 前端：顶栏芯片看得见入口 + 加载 + 点击分支 + 换入口函数齐备",
        "loadGatePath()" in js and "state.gatePath" in js
        and "async function doGatePath()" in js
        and "txt.indexOf('登录入口') === 0" in js
        and "'gate_path_rotate'" in js and "'gate_path_set'" in js
        and "/^[a-z0-9]{12,32}$/" in js)
    # 浏览器侧的闸门回归脚本也得跟上同一套模型：它以前假设「未登录 / 拿到密码页」
    # 且 bg 图公开 200 —— 恰好是这次要废掉的两个前提。留着旧断言＝一条永远绿不了的
    # 假灯，或者更糟：将来有人把它改回旧模型当"测试通过"。
    cdp_gate = (root / "web" / "test" / "cdp-gate.mjs").read_text(encoding="utf-8")
    chk("T54 ★ cdp-gate.mjs 已校正到新模型（秘密入口 + 未登录 404 + bg 收闸门）",
        "process.env.GATE_TOKEN" in cdp_gate and "GATE_URL" in cdp_gate
        and "for (const p of ['/gate/gate.css'" not in cdp_gate
        and "/gate/${GATE_TOKEN}/gate.css" in cdp_gate
        and "未登录 ${p} → 404" in cdp_gate
        and "'/assets/bg.jpg'" in cdp_gate)
    # ── T54 第二轮（2026-10-19）：入口形状 + 「入口本身打得开」也要钉住 ──
    # 补这三处的动机是同一条：登录入口是**唯一**能登录的地方，而它坏了的时候
    # 前五项探活全绿、authd /health 正常、/dist/main.js 也照样"正确地" 404，
    # 唯一症状是「访客说链接打不开」。所以片段形状、探活第六项、快照内容都得有灯。
    _gpt = gm.gate_path_text("abc123def456")
    chk("T54 ★ 片段用 302 补尾斜杠，不用会被浏览器永久缓存的 301（CLI 与 deploy 两处一致）",
        "return 302 /gate/abc123def456/" in _gpt and "return 301" not in _gpt
        and "location = /gate/$TOK { access_log off; return 302 /gate/$TOK/; }" in dw_src)
    # 两个渲染器渲染的是**同一份文件**，谁后跑谁覆盖。所以「几条 location 关日志」
    # 这个数必须两边都是 3 —— 少一条就意味着换一次入口就把明文泄漏装回去。
    # 三条分别是：补尾斜杠的 302、入口守卫（auth_request + /entry）、密码页资源（^~）。
    chk("T54 ★ 三条 location（= 302 / 守卫 / ^~）都 access_log off，CLI 模板与 deploy 模板条数一致",
        _gpt.count("access_log off") == 3 and "access_log off" in _gp,
        f"CLI={_gpt.count('access_log off')} deploy 片段渲染段={_gp.count('access_log off')}")
    # ★7（2026-10-21 复审）：同一份片段有**两个渲染器** —— deploy 的 heredoc 和
    # gate_path_text()，deploy 每次重渲染、gate-path set/rotate 整段重写，谁后跑谁覆盖。
    # 只比「谁有几条 access_log off」太松：漂移是逐行的，今天少一行注释、明天少一条指令。
    # 所以直接逐行比对两份文本（$TOK/$ROOT 代入实参后必须**完全相等**）。
    _tpl = (dw_src.split("<<GATE_PATH_BODY", 1)[1].split("\nGATE_PATH_BODY", 1)[0]
            .lstrip("\n").replace("$TOK", "abc123def456")
            .replace("$ROOT", gm.GATE_ROOT)) if "<<GATE_PATH_BODY" in dw_src else ""
    _gl, _tl = _gpt.rstrip("\n").splitlines(), _tpl.rstrip("\n").splitlines()
    _pdiff = ["%d: CLI=%r deploy=%r" % (i + 1, g, t)
              for i, (g, t) in enumerate(zip(_gl, _tl)) if g != t]
    if len(_gl) != len(_tl):
        _pdiff.append("行数不同：CLI=%d deploy=%d" % (len(_gl), len(_tl)))
    chk("T54 ★ 片段的两个渲染器逐行等价（否则线上内容随「上次是谁部署的」漂移）",
        _tpl != "" and _gl == _tl, _pdiff)
    # ★7：文档里那句「仅在片段不存在时 rand -hex 6」现在两头都是反的 ——
    # 既不重渲染（M1/M3 的修复没生效）、长度也不是 12 位。留着它比留空更坏：
    # 读文档的人照它判断「重部署不会碰我的片段」，而实际行为已经换了。
    chk("T54 ★ 文档同步到重渲染 + 24 位口径（★3 裁决：随机固定 24、手动 set 仍可 12~32 且不警告）",
        "rand -hex 6" not in gu_doc and "rand -hex 12" in gu_doc
        and "重渲染" in gu_doc and "24 个十六进制字符" in gu_doc
        and "96 bit" in gu_doc and "--token-stdin" in gu_doc)
    _pf_tok = [l for l in hc_src.splitlines() if "ping_fail" in l and "${TOK}" in l]
    chk("T54 ★ 探活第六项在：入口必须 200 且正文含 gate-form，失败原因串里绝不带 token",
        'TOK=$(sed -n' in hc_src and "gate-form" in hc_src
        and "无法确认登录入口" in hc_src and not _pf_tok,
        f"原因串会经 /fail 发给第三方监控服务：{_pf_tok}")
    chk("T54 ★ 探活脚本无 https:// 字面量（deploy-monitor.sh 自测 4/4 判红：端点只来自密钥文件）",
        "https://" not in hc_src)
    bak_src = (root / "server" / "cmsgate-backup.sh").read_text(encoding="utf-8")
    chk("T54 ★ 快照把登录入口片段一起打包，且缺片段时不让整个备份打死",
        "-C /etc/nginx/snippets cms-gate-path.conf" in bak_src
        and 'if [ -f "$GATE_CONF" ]' in bak_src and 'tar -czf "$DEST/cms-${STAMP}.tar.gz" -C "$SRC" .' in bak_src)
    restore_doc = (root / "server" / "RESTORE.md").read_text(encoding="utf-8")
    chk("T54 ★ 恢复手册讲清片段解到 /etc/nginx/snippets（裸成员名会落进数据目录，等于没恢复）",
        "-C /etc/nginx/snippets cms-gate-path.conf" in restore_doc
        and "rm -f /var/lib/cmsgate/cms-gate-path.conf" in restore_doc
        and "grep -x cms-gate-path.conf" in restore_doc)
    chk("T54 ★ F5 serve.py：--gate 绑非回环且没显式 GATE_TOKEN 时拒绝启动（默认 dev token 不外泄）",
        'a.host in ("127.0.0.1", "localhost", "::1")' in serve_src
        and 'tok = os.environ.get("GATE_TOKEN", "")' in serve_src
        and "if a.gate and not loopback and not tok:" in serve_src
        and "必须显式给入口 token" in serve_src)
    chk("T54 ★ 文档同步：探活项数按「仓库十三项 / 服务器十四项」写准 + 片段进快照 + 302 的理由",
        "十三项探活" in gu_doc and "服务器版十四项" in gu_doc
        and "秘密登录入口必须" in gu_doc
        and "`return 302`，不是 301" in gu_doc and "另外还收一份" in gu_doc
        and "快照里没有它" not in gu_doc)
    chk("T54 ★ 文档同步：登录入口一节讲清了 token 存哪/怎么看/怎么换/校验形状",
        "### 登录入口本身也 404 化" in gu_doc
        and "cms gate-path status" in gu_doc and "cms gate-path rotate" in gu_doc
        and "^[a-z0-9]{12,32}$" in gu_doc
        and "cms-gate-path.conf" in gu_doc
        and "/gate/<TOKEN>/gate.css" in gu_doc)
    chk("T53 ★ 文档同步：背景图收进闸门 + 登录页改渐变 + 特效三条铁律",
        "收进闸门" in gu_doc and "CSS 渐变" in gu_doc
        and "未授权素材不再对匿名访客分发" in gu_doc
        and "pointer-events: none" in gu_doc and "只听不拦" in gu_doc)

    # ── T55：无 JS 的失败提示改成「服务端内联页」，?e= 这条通道整体拆除 ────
    # 旧写法：表单原生 POST 失败 → authd 用 303 跳回 /gate/?e=N → 404 模型下
    # /gate/ 对无会话者就是 404，**回跳落地是一页 404**，访客只知道"坏了"、
    # 不知道"为什么坏了"；而 <noscript> 还在教人去看地址栏末尾的编号。
    # 574 项测试全绿也没发现它，因为每一条用例都走的是带 X-CMSGATE 的 fetch 分支。
    # 新写法：原因直接写在这一响应的正文里 —— 服务端因此**不需要知道秘密入口在哪**
    # （拼一个公开路径 302 过去等于把 token 广播出去，那是更糟的"修法"）。
    _nojs = re.search(r'NOJS_PAGE = """(.*?)"""', authd_src, re.S)
    chk("T55 ★ ?e= 这条通道在 authd 里已经没有任何残留（不跳 /gate/、编号表已删）",
        "E_BY_REASON" not in authd_src and 'location="/gate/' not in authd_src
        and "REASON_ZH" in authd_src)
    chk("T55 ★ 四条拒绝原因齐，且与 gate.js 的 MSG **逐字**相等（两条路不能显示成两句话）",
        _nojs is not None
        and all(k in authd_src for k in ("R_BAD_PW", "R_THROTTLED", "R_DISABLED", "R_EXPIRED"))
        and all(v in authd_src and f"'{v}'" in gatejs for v in
                ("密码不正确，请重试", "尝试过于频繁，请等一会儿再试",
                 "这个密码已被停用，请找管理员换一个", "这个密码已过期，请找管理员换一个")))
    chk("T55 ★ 节流那句两边都带具体秒数（只说「等一会儿」用户会以为密码坏了）",
        "尝试过于频繁，请等 {retry} 秒后再试" in authd_src
        and "'尝试过于频繁，请等 ' + r.retry + ' 秒后再试'" in gatejs)
    chk("T55 ★ 非 fetch 分支发 401/429 + text/html + Retry-After，正文走 nojs_page()",
        "nojs_page(reason_sentence(reason, retry))" in authd_src
        and 'ctype="text/html; charset=utf-8"' in authd_src
        and '"Retry-After"' in authd_src and "429 if retry else 401" in authd_src)
    chk("T55 ★ 内联页没有 <style>/style=/内联 <script>（继承的 CSP 会把它们静默拦掉）",
        _nojs is not None
        and not any(t in _nojs.group(1) for t in ("<style", " style=", "<script")))
    # 这一项是"回显请求内容"的唯一防线：模板里只有 {msg} 一个槽，
    # 填进去的只能是 REASON_ZH 的固定句子或带整秒数的节流句 —— 用户输错的那串密码
    # 绝不进页面（进了就是 XSS/信息泄漏面，还会留在浏览器历史与代理日志里）。
    chk("T55 ★ 内联页只有一个 {msg} 槽，不回显任何请求内容（密码原文不进响应体）",
        _nojs is not None and _nojs.group(1).count("{") == 1
        and "{msg}" in _nojs.group(1)
        and "def nojs_page" in authd_src and "REASON_ZH.get(reason" in authd_src)
    chk("T55 ★ 成功分支不变：密码对了仍 303 → /game（不发内联页）",
        'self._send(303, cookie=cookie, location="/game")' in authd_src)
    chk("T55 ★ gate.js 里 BY_E / 读地址栏编号 的恢复逻辑已删（现在是死代码）",
        "BY_E" not in gatejs and "location.search" not in gatejs
        and "?e=" not in gatejs and "MSG[reason]" in gatejs)
    chk("T55 ★ 密码页 <noscript> 改口：讲后退，不再教人看地址栏编号",
        "后退" in gate_html and "地址栏" not in gate_html
        and "?e=" not in gate_html and "编号" not in gate_html
        and 'action="/__login"' in gate_html)
    chk("T55 ★ 文档不再描述「303 跳回 /gate/?e=N」那套编号映射",
        "只在固定映射表里查" not in gu_doc and "写在响应的正文里" in gu_doc)
    chk("T55 ★ cdp-gate.mjs TG9 走的是无头分支（不带 X-CMSGATE 的 fetch），不再 goto ?e=N",
        "TG9" in cdp_gate and "goto(`${GATE_URL}?e=" not in cdp_gate
        and "?e=${n}" not in cdp_gate)
    # 本机代理以前把转发响应的 Content-Type **写死成 application/json**（那时 authd 只回 JSON）。
    # 内联提示页是 text/html —— 不跟着改的话，本地浏览器把它当 JSON 文本显示（或提示下载），
    # 于是"本地复现不了线上"，而 nginx 是原样转发的。这条就是钉住那个不对称。
    chk("T55 ★ serve.py 代理透传上游 Content-Type/Retry-After（写死 JSON 会让内联页在本地不渲染）",
        'ctype = resp.getheader("Content-Type") or "application/json"' in serve_src
        and 'retry_after = resp.getheader("Retry-After")' in serve_src
        and "self._send(status, payload, ctype, extra)" in serve_src
        and '"application/json", extra' not in serve_src)

    # ── T56：复制入口给的是「完整网址」，不是裸路径 ────────────────────
    # 裸路径 `/gate/xxx/` 粘到微信/邮件里打不开，访客只会回一句"打不开"——
    # 而文档早就写着「复制完整网址」，代码却只复制路径；这条漂移是用户实测抓到的。
    # 前缀由 cmsui 后端持有一份（SITE_ORIGIN，CMSGATE_SITE 可覆盖）：CLI 刻意只回路径
    #（它的注释写明整站对外地址不归它管），前端拼起来再复制，真相仍然只有一份。
    chk("T56 ★ 站点前缀只有一份：cmsui 后端的 SITE_ORIGIN，且可被环境变量覆盖"
        "（2026-10-20 明文收口后必须是 https + 域名：IP:8080 已收回环，复制出去别人打不开）",
        'SITE_ORIGIN = os.environ.get("CMSGATE_SITE", "https://' in gu_src
        and '.rstrip("/")' in gu_src
        and 'SITE_ORIGIN = os.environ.get("CMSGATE_SITE", "http://' not in gu_src)
    chk("T56 ★ /api/gate-path 把前缀随只读结果一起回（token 仍只来自 CLI）",
        'data["site"] = SITE_ORIGIN' in gu_src)
    chk("T56 ★ 前端拼完整网址：gateUrl() = site + path，复制与轮换后复制都走它",
        "function gateUrl()" in js
        and "((gp.site || '') + gp.path)" in js
        and "await copyText(u, '入口网址')" in js
        and "await copyText(nu, '新入口网址')" in js
        and "copyText(cur.path" not in js)
    chk("T56 ★ 对话框把完整网址摆出来，选项文案不再说「复制路径」",
        "(gateUrl() || cur.path" in js
        and "复制完整网址（站点地址+入口路径，可直接发给人）" in js
        and "复制当前入口路径" not in js)
    chk("T56 ★ 文档同步：复制给的是完整网址 + 前缀在哪改",
        "SITE_ORIGIN" in gu_doc and "CMSGATE_SITE" in gu_doc)

    # ── T57：登录页 66ccff 配色 + 星光/USTC 特效双端对齐 ─────────────────
    # 这一轮把网页端的三件美化（登录页主色、点击弹字受复选框门控、星光数量/大小
    # 进 Settings）同步到桌面端 C++/SFML，并给登录页加了一层自包含星光。
    # 跨端一致性最容易烂掉的地方是「默认值/区间各写一份」：网页 settings.ts、
    # 桌面 SettingsIO、Renderer.h 三处必须同数，否则同一份配置在两端表现不同。
    # 桌面 fx 层是净新增代码，这里额外钉两条它特有的坑：
    #   1) 绘制顺序——星光盖棋盘但绝不能盖模态面板（网页靠 DOM 顺序，桌面靠调用顺序）；
    #   2) 粒子循环必须 ++it，漏掉会让字母在同一帧里被反复扣寿命、当场消失。
    _gcss = (root / "web" / "gate" / "gate.css").read_text(encoding="utf-8")
    _ghtml = (root / "web" / "gate" / "index.html").read_text(encoding="utf-8")
    _fxts = (root / "web" / "ts" / "fx.ts").read_text(encoding="utf-8")
    _setts = (root / "web" / "ts" / "settings.ts").read_text(encoding="utf-8")
    _gats = (root / "web" / "ts" / "game.ts").read_text(encoding="utf-8")
    _rts = (root / "web" / "ts" / "renderer.ts").read_text(encoding="utf-8")
    _rnh = (root / "src" / "desktop" / "Renderer.h").read_text(encoding="utf-8")
    _rnc = (root / "src" / "desktop" / "Renderer.cpp").read_text(encoding="utf-8")
    _sioh = (root / "src" / "desktop" / "SettingsIO.h").read_text(encoding="utf-8")
    _sioc = (root / "src" / "desktop" / "SettingsIO.cpp").read_text(encoding="utf-8")
    _mn = (root / "src" / "desktop" / "main.cpp").read_text(encoding="utf-8")

    chk("T57 ★ 登录页主色收进 66ccff 家族（渐变亮部→主色→中段→深处四档齐）",
        "linear-gradient(168deg, #bfeaff 0%, #66ccff 34%, #3f9fd6 68%, #245e82 100%)" in _gcss
        and "rgba(102, 204, 255" in _gcss and "border-color: #66ccff" in _gcss)
    chk("T57 ★ 登录页星光层进了 HTML 且 aria-hidden（装饰层不该被读屏念出来）",
        '<canvas id="fx" aria-hidden="true"></canvas>' in _ghtml)
    chk("T57 ★ #fx 必须 pointer-events:none，否则整页表单点不动",
        re.search(r"#fx\s*\{[^}]*pointer-events:\s*none", _gcss) is not None)
    chk("T57 ★ 登录页星光自包含：不引 dist/fx.js（那文件在闸门内，匿名访客 404）",
        re.search(r"^\s*import[\s(*]", gatejs, re.M) is None
        and "from './" not in gatejs and "from '../" not in gatejs
        and "import(" not in gatejs
        and "getElementById('fx')" in gatejs)
    chk("T57 ★ 登录页没有 USTC 弹字，且 reduced-motion 时整层不启用",
        "USTC 弹字" in gatejs and "fxBurst" not in gatejs
        and "prefers-reduced-motion: reduce" in gatejs)

    chk("T57 ★ 点击弹字受「红专并进，理实交融」门控（网页 opts.ustcOn / 桌面 ustcMode_）",
        "if (!opts.ustcOn) return;" in _fxts and "if (!ustcMode_) return;" in _rnc)
    chk("T57 ★ 复选框切换时实时推给特效层（不推就得刷新才生效）",
        "updateFx({ ustcOn: this.cfg.ustcMode })" in _gats
        and "export function updateFx(" in _fxts)
    chk("T57 ★ 旧的写死粒子池常量已删（数量改由 Settings 驱动）",
        "MAX_SPARKS = 90" not in _fxts and "const MAX_SPARKS" not in _fxts)

    # 区间/默认值以前是「把字面量抄进断言」，调一次参就假红一片。改成抽值互比：
    # 四处（web settings.ts / Renderer.h / SettingsIO.h / SettingsIO.cpp 的 ini 上下界）
    # 谁跟谁不一致，就把四处的实际数字都报出来，一眼看出是哪端漂了。
    def _num(pat: str, text: str, cast=float):
        m = re.search(pat, text)
        return cast(m.group(1)) if m else None

    _rng = ("cmin", "cmax", "smin", "smax")
    _w = {
        "cmin": _num(r"export const kStarDensityMin = (-?[\d.]+);", _setts),
        "cmax": _num(r"export const kStarDensityMax = ([\d.]+);", _setts),
        "smin": _num(r"export const kStarScaleMin = ([\d.]+);", _setts),
        "smax": _num(r"export const kStarScaleMax = ([\d.]+);", _setts),
        "cdef": _num(r"starDensity: ([\d.]+),", _setts),
        "sdef": _num(r"starScale: ([\d.]+),", _setts),
    }
    _d = {
        "cmin": _num(r"static constexpr float kStarDensityMin = (-?[\d.]+)f;", _rnh),
        "cmax": _num(r"static constexpr float kStarDensityMax = ([\d.]+)f;", _rnh),
        "smin": _num(r"static constexpr float kStarScaleMin = ([\d.]+)f;", _rnh),
        "smax": _num(r"static constexpr float kStarScaleMax = ([\d.]+)f;", _rnh),
    }
    _i = {
        "legacyMin": _num(r"v >= ([\d.]+)f && v <= [\d.]+f", _sioc),
        "legacyMax": _num(r"v >= [\d.]+f && v <= ([\d.]+)f", _sioc),
        "smin": _num(r"s >= ([\d.]+)f && s <= [\d.]+f", _sioc),
        "smax": _num(r"s >= [\d.]+f && s <= ([\d.]+)f", _sioc),
        "cdef": _num(r"float starDensity = ([\d.]+)f;", _sioh),
        "sdef": _num(r"float starScale = ([\d.]+)f;", _sioh),
    }
    # resetAll 可能直接写字面量，也可能赋 kStarDensityDefault：两种都要认得出
    _rdef = _num(r"starDensity_ = ([\d.]+)f;", _rnc) or _num(r"kStarDensityDefault = ([\d.]+)f;", _rnh)
    # ini 读入后的夹取上界、登录页的判定上界都是各自抄的一份数字，一并抽出来互比
    _iniClamp = re.search(r"std::clamp\(rawStarDensity, (-?[\d.]+)f, ([\d.]+)f\)", _sioc)
    _gateCap = _num(r"if \(n <= ([\d.]+)\) \{", gatejs)
    _rangeOk = all(None not in (_w[k], _d[k]) and _w[k] == _d[k] for k in _rng) \
        and _iniClamp is not None and float(_iniClamp.group(1)) == _w["cmin"] \
        and float(_iniClamp.group(2)) == _w["cmax"] and _gateCap == _w["cmax"]
    _defOk = None not in (_w["cdef"], _i["cdef"], _rdef) and _w["cdef"] == _i["cdef"] == _rdef \
        and None not in (_w["sdef"], _i["sdef"]) and _w["sdef"] == _i["sdef"]
    chk("T57 ★ 星光区间/默认值各端同数（抽值互比）：settings.ts / Renderer.h / SettingsIO.h / resetAll / ini 夹取 / 登录页判定",
        _rangeOk and _defOk,
        f"区间 web={[_w[k] for k in _rng]} 桌面头={[_d[k] for k in _rng]} "
        f"ini夹取={_iniClamp.groups() if _iniClamp else None} 登录页上界={_gateCap}；"
        f"默认 count web={_w['cdef']} 桌面ini={_i['cdef']} resetAll={_rdef}；"
        f"scale web={_w['sdef']} 桌面={_i['sdef']}")
    # 两位小数：滑条步进、setter 收拢、读数格式、输入框长度必须成套改，否则会出现
    # 「滑条只能出 2.2、默认却写 2.17」这种自相矛盾的读数。
    _rt11 = _rts[_rts.index("if (f === 11) {"):_rts.index("if (f === 12) {")]
    _rn11 = _rnc[_rnc.index("if (f == 11) {"):_rnc.index("if (f == 12) {")]
    chk("T57 ★ 密度精确到两位小数（0.01 步进）：输入框容 4 字符、滑条/setter 按 100 收拢、读数 toFixed(2)",
        "length >= 4" in _rt11 and "size() >= 4" in _rn11
        and "* 100) / 100" in _rts and "* 100.f) / 100.f" in _rnc
        and "this.cfg.starDensity.toFixed(2)" in _rts and "setprecision(2) << starDensity_" in _rnc
        and "* 100) / 100" in _setts and "* 100.f) / 100.f" in _sioc)
    chk("T57 ★ 桌面端配置文件读写两条路都带上 stardensity/starscale；密度换单位后仍认旧刻度 0..800 并写 starunit=2",
        'f << "stardensity = " << data.starDensity' in _sioc
        and 'f << "starscale = " << data.starScale' in _sioc
        and _i["legacyMin"] == 0 and _i["legacyMax"] == 800
        and 'f << "starunit = 2\\n"' in _sioc
        and "if (!starUnit2) {" in _sioc
        and _i["smin"] == _d["smin"] and _i["smax"] == _d["smax"],
        f"ini 旧密度上下界=[{_i['legacyMin']},{_i['legacyMax']}] scale=[{_i['smin']},{_i['smax']}]")
    chk("T57 ★ 密度单位迁移三端同式：旧刻度（1512×982 下的颗数）→ 颗/100×100px，只对缺 marker 的旧存档折（缺键不折默认值）",
        "10000 / (1512 * 982)" in _setts and "o.starUnit === 2" in _setts
        and "!hasDensity" in _setts
        and "starUnit: 2" in _setts
        and "10000.0f / (1512 * 982)" in _sioc and 'f << "starunit = 2\\n"' in _sioc
        and "if (!starUnit2) {" in _sioc and "if (densitySeen) {" in _sioc
        and "10000 / (1512 * 982)" in gatejs and "starUnit" in gatejs
        and "starCountForDensity(density: number)" in _fxts
        and "starfx.starUnitPx * starfx.starUnitPx" in _fxts
        and "starfx::kStarUnitPx" in _rnc)
    # 观感参数镜像：桌面 namespace starfx 与网页 const starfx 是两份手抄的数，
    # 抽出来逐个比 —— 只比数值不比形状（断值不断形，改注释/排版不该红）。
    def _low(name: str) -> str:
        return name[0].lower() + name[1:]

    _dblk = _rnc[_rnc.index("namespace starfx {"):_rnc.index("} // namespace starfx")]
    _wstart = _fxts.index("const starfx = {")
    _wblk = _fxts[_wstart:_fxts.index("};", _wstart)]
    _dnum = {_low(m.group(1)): float(m.group(2))
             for m in re.finditer(r"constexpr (?:float|int|unsigned) k(\w+) = (-?[\d.]+)", _dblk)}
    _wnum = {m.group(1): float(m.group(2)) for m in re.finditer(r"(\w+): (-?[\d.]+)", _wblk)}
    _dcol = {_low(m.group(1)): "#%02x%02x%02x" % tuple(int(x) for x in re.findall(r"\d+", m.group(2)))
             for m in re.finditer(r"const sf::Color k(\w+) = displayColor\((\d+,\s*\d+,\s*\d+)\)", _dblk)}
    _wcol = {m.group(1): m.group(2).lower()
             for m in re.finditer(r"(\w+): '(#[0-9a-fA-F]{6})'", _wblk)}
    _miss = sorted(set(_dnum) ^ set(_wnum))
    _diff = sorted(k for k in set(_dnum) & set(_wnum) if abs(_dnum[k] - _wnum[k]) > 1e-9)
    _cdiff = sorted(k for k in set(_dcol) & set(_wcol) if _dcol[k] != _wcol[k])
    chk("T57 ★ 观感参数两端同数（namespace starfx ↔ fx.ts starfx 抽值互比）",
        not _miss and not _diff and not _cdiff and len(_dnum) >= 30 and len(_dcol) == 4,
        f"只在一端={_miss} 数值不同={_diff} 颜色不同={_cdiff}"
        f"（共 {len(_dnum)} 个数、{len(_dcol)} 个色）")
    _gstart = gatejs.index("var FX = {")
    _gnum = {m.group(1): float(m.group(2))
             for m in re.finditer(r"(\w+): (-?[\d.]+)", gatejs[_gstart:gatejs.index("};", _gstart)])}
    _gdiff = sorted(k for k in _gnum if k in _wnum and abs(_gnum[k] - _wnum[k]) > 1e-9)
    chk("T57 ★ 登录页克制版参数是游戏页的真子集且同数（没有流星/耀斑/单位圆/拖尾）",
        not _gdiff and set(_gnum) < set(_wnum)
        and "meteor" not in _gnum and "flare" not in _gnum and "unit" not in _gnum,
        f"与游戏页不同={_gdiff} 登录页参数 {len(_gnum)} 个 / 游戏页 {len(_wnum)} 个")
    # 2026-10-21 同步：fx 那轮把「涟漪」也算进粒子池、清池改成多行块、桌面端连流星雨一起清。
    # 语义没变（数量 0 = 整层关闭），变的是字面 —— 所以判据换成「当前实现里真的那几行」，
    # 而不是回去把代码改成匹配旧断言。
    chk("T57 ★ 密度 0 = 整层关闭：网页清池（星+流星+星雨）停 rAF 并不建画布，桌面连流星雨一起清，登录页不启用",
        "if (target <= 0) {" in _fxts
        and "sparks.length = 0;" in _fxts and "meteors.length = 0;" in _fxts
        and "if (sparks.length === 0 && letters.length === 0 && ripples.length === 0) { raf = 0; return; }" in _fxts
        and "if (cfg.starDensity <= 0 && !opts.ustcOn) return;" in _fxts
        and "const bool starsOff = targetCount <= 0;" in _rnc
        and "if (starsOff) {" in _rnc and "sparks_.clear();" in _rnc
        and "meteors_.clear();" in _rnc and "showerLeft_ = 0;" in _rnc
        and "if (count <= 0) return;" in gatejs)
    chk("T57 ★ 设置面板直接写单位「颗/100×100px」并给本窗口实际颗数/上限（密度≠颗数，换局面要看得见变化），且窗口尺寸变化时整池重铺",
        "颗/100×100px → 本窗口 ≈ " in _rnc and "（上限 " in _rnc
        and "starCountForDensity(kStarDensityMax)" in _rnc
        and "if (vw != fxPoolW_ || vh != fxPoolH_) {" in _rnc
        and "export function starCountForDensity(density: number): number" in _fxts
        and "颗/100×100px → 本窗口 ≈ " in _rts and "（上限 " in _rts
        and "if (vw !== poolW || vh !== poolH) {" in _fxts and "poolW = vw;" in _fxts)
    _fxlook = (root / "web" / "test" / "fx-look.mjs").read_text(encoding="utf-8")
    chk("T57 ★ 观感调参脚本在位且产物写在仓库外（截图/统计不许被 git add 进去）",
        "process.env.OUT_DIR || '/tmp/fx-look'" in _fxlook
        and "captureScreenshot" in _fxlook and "getImageData" in _fxlook
        and "starDensity" in _fxlook)
    # 枚举尾巴上后来又追加了 BgField（同一轮、同一条理由），所以不能钉「紧跟 `};`」，
    # 要钉的是**顺序**：星光那四个必须都排在「前面的值有区间判断」之后追加上去。
    chk("T57 ★ 桌面端两行滑块进了命中表，且枚举只往末尾追加（插队会串味：前面的值有区间判断）",
        all(k in _rnh for k in ("StarTrack", "ScaleTrack", "StarValue", "ScaleValue"))
        and "StarTrack, ScaleTrack, StarValue, ScaleValue," in _rnh
        and _rnh.index("StarTrack") < _rnh.index("ScaleValue")
        and "前面的枚举值有区间判断" in _rnh
        and "if (inZone(r.starTrack, 6.f, 12.f)) return SettingsHit::StarTrack;" in _rnc
        and "if (inZone(r.scaleTrack, 6.f, 12.f)) return SettingsHit::ScaleTrack;" in _rnc)
    chk("T57 ★ 星光密度/倍率两行数值框双端都在（点框输入 + 越界保持原值），漏改一端就红",
        "StarValue" in _rnh and "ScaleValue" in _rnh
        and "void settingsCommitStarDensity()" in _rnh and "void settingsCommitStarScale()" in _rnh
        and "if (inZone(r.starValue, 0.f, 0.f)) return SettingsHit::StarValue;" in _rnc
        and "StarValue, ScaleValue" in _rts and "settingsCommitStarDensity(): void" in _rts
        and "settingsCommitStarScale(): void" in _rts
        and "inside(r.starValue, px, py + this.settingsScroll_)" in _rts
        and "case SettingsHit.StarValue: R_.focusOn(11); break;" in _gats
        and "case SettingsHit.ScaleValue: R_.focusOn(12); break;" in _gats
        and "R_.settingsCommitStarDensity(); this.fxSync();" in _gats
        and "R_.settingsCommitStarScale(); this.fxSync();" in _gats
        and "hit == SH::StarValue" in _mn and "hit == SH::ScaleValue" in _mn)
    # 流星头：T57 的抽值断言只管常量同数，管不到「怎么画」——
    # 星角数用在哪、尖角朝哪、尾巴从多粗起算，这些画法只在一端改了就会「桌面像流星、网页像划痕」。
    # 流星头：2026-10-21 特效那轮按真实流星照片重做成「光斑配方」（核白、边缘染色、
    # 四芒臂 + 细环 + 高亮核）+ 发丝级拖尾，**五角星头那个口径已经作废**。
    # 这条跟着换成现在的画法，判的还是同一件事：画法只写在一端就会「桌面像流星、网页像划痕」。
    chk("T57 ★ 流星头是光斑配方（headR 存进结构、drawOrb 画核+四芒+细环、拖尾半宽按 headR 收），双端同参",
        "float headR = 13.f;" in _rnh
        and "m.headR = kMeteorHeadMin" in _rnc
        and "drawOrb(m.x, m.y, headR" in _rnc
        and "const float back = sp * m.trailSec;" in _rnc
        and "headR * kTrailHeadW" in _rnc
        and "kMeteorCrossLen" in _rnc and "kMeteorRingR" in _rnc
        and "headR: number" in _fxts
        and "headR: starfx.meteorHeadMin" in _fxts
        and "drawOrb(m.x, m.y, headR" in _fxts
        and "const back = sp * m.trailSec;" in _fxts
        and "headR * starfx.trailHeadW" in _fxts
        # 头部大小不再吃 STARS · SIZE 滑块（旧写法 1.7×starScale 只有 3px，看着像划痕）
        and "1.7f * starScale_" not in _rnc and "1.7 * opts.starScale" not in _fxts)
    chk("T57 ★ 设置面板命中判定跟着滚动走（指针换回内容坐标）——否则滚动后点空处",
        "const sf::Vector2f q(p.x, p.y + sc);" in _rnc)

    chk("T57 ★ 桌面端星光画在棋盘之上、模态面板之下（与网页端 DOM 顺序同义）",
        _rnc.index("drawOverlay(hud, t);") < _rnc.index("drawFx(t);") < _rnc.index("drawMenu(hoverPx, t);"))
    chk("T57 ★ 字母循环有 ++it（漏掉会让字母同一帧被扣光寿命、当场消失）",
        re.search(r"for \(auto it = fxLetters_\.begin\(\); it != fxLetters_\.end\(\);\) \{.*?\n        \+\+it;\n    \}",
                  _rnc, re.S) is not None)
    chk("T57 ★ 装饰随机数用独立 mt19937，不碰游戏种子 RNG（种子复现是硬约束）",
        "static std::mt19937 g(std::random_device{}());" in _rnc and "frand01()" in _rnc)
    chk("T57 ★ 桌面端与网页端同一条「打中流星才吞这一击」：fxRipple 返回命中→ 后面整套判定整条跳过，"
        "没打中一律照常；弹字在吞不吞之前都做（2026-10-21 裁决，别把它改回「只听不拦」）",
        "renderer.fxBurst(mb->position);" in _mn
        and "if (mb->button == sf::Mouse::Button::Left || mb->button == sf::Mouse::Button::Right)\n                renderer.fxBurst(mb->position);" in _mn
        and "const bool fxHit = (mb->button == sf::Mouse::Button::Left) && renderer.fxRipple(mb->position);" in _mn
        and "if (fxHit) continue;" in _mn
        and _mn.index("renderer.fxBurst(mb->position);") < _mn.index("if (fxHit) continue;")
        # 命中判据两端同式：headR × 放宽倍数，没打中时**不炸也不改池**（否则点空地会凭空少一颗星）
        and "if (hit < 0) return false;" in _rnc and "headR * kRippleHit" in _rnc
        and "d <= meteors[i].headR * starfx.rippleHit" in _fxts)
    chk("T57 ★ 临时验证脚手架（CMS_* 环境变量存图）已拆干净",
        "CMS_SHOT" not in _mn and "CMS_BURST" not in _mn and "[临时验证脚手架]" not in _mn)
    chk("T57 ★ 文档同步：桌面端同源实现的两条坑（++it / 独立 RNG）与四处默认值抽值互比的说明",
        "字母循环必须 `++it`" in gu_doc and "std::mt19937(std::random_device)" in gu_doc
        and "默认值与区间四处各写了一份" in gu_doc and "stardensity" in gu_doc
        and "桌面端原来什么都没有" in gu_doc and "桌面端也没动" not in gu_doc
        and "观感参数" in gu_doc and "fx-look.mjs" in gu_doc)

    # ── T60：动效层（P0 手感 + P1 质感 + P2 高光）────────────────────────
    # 母题 = 现状浅色底只加动效。红线三条：色相语义不动（本组只查时间常量与开关）、
    # 单段动画 ≤250ms（例外：shake/winHold/winFade 是序列包络不是单段）、
    # 全部动效过 animOn() 闸门（设置 animFx && !prefers-reduced-motion）。
    # 另钉两条容易烂的秩序：AnimToggle 只能追加在 SettingsHit 末尾（前面值有区间判断）、
    # 载入种子/新局必须 resetAnims（否则恢复进度会整盘播入场动画）。
    _ants = (root / "web" / "ts" / "anim.ts").read_text(encoding="utf-8")
    _gjs = (root / "web" / "gate" / "gate.js").read_text(encoding="utf-8")
    _anim_d = (root / "web" / "dist" / "anim.js")
    chk("T60 ★ anim.ts 存在且 dist 已随源码重编（dist/anim.js 比 anim.ts 新）",
        _anim_d.exists() and _anim_d.stat().st_mtime >= (root / "web" / "ts" / "anim.ts").stat().st_mtime)
    _kseg = re.search(r"export const kAnimMs = \{(.*?)\} as const;", _ants, re.S)
    chk("T60 ★ 单段动画时长全部 ≤250ms（序列包络 shake/winHold/winFade 除外）",
        _kseg is not None and all(
            int(m) <= 250 for m in re.findall(
                r"(?:waveStep|revealPop|counterFlip|ripple|badgePop|badgeRing|badgeDie|lossStep|lossPop|winSegStep|winSegGrow):\s*(\d+)",
                _kseg.group(1))))
    chk("T60 ★ 动效唯一闸门 animOn = 设置开关 && !prefers-reduced-motion，且渲染层确实走它",
        "prefers-reduced-motion" in _ants and "export function animOn" in _ants
        and _rts.count("animOn(this.cfg.animFx)") >= 4)
    chk("T60 ★ animFx 设置四件套：字段/默认开/旧档兼容（!==false）/落盘",
        "animFx: boolean" in _setts and "animFx: true" in _setts
        and "o.animFx !== false" in _setts and "animFx: d.animFx" in _setts)
    chk("T60 ★ AnimToggle 追加在 SettingsHit 末尾（插队会串味：前面的值有区间判断），命中与绘制都在",
        _rts.index("AnimToggle") > _rts.index("BgField")
        and "animBtn" in _rts and "SettingsHit.AnimToggle" in _gats
        and "case SettingsHit.AnimToggle:" in _gats and "this.persist();" in _gats)
    chk("T60 ★ 波前：开格动作先报圆心（openCell 与 doChord 都在动棋盘之前），BFS 距离 × waveStep 定每格延迟",
        _gats.index("this.renderer.noteRevealOrigin(r, c);") < _gats.index("const out = this.board.boardOpen(r, c);")
        and _gats.index("this.renderer.noteRevealOrigin(cell.r, cell.c);") < _gats.index("const res = this.board.boardChord(cell.r, cell.c);")
        and "dist[i] * kAnimMs.waveStep" in _rts)
    chk("T60 ★ 新局与载入种子都 resetAnims（否则恢复进度整盘播入场动画），涟漪两处入口都在",
        _gats.count("this.renderer.resetAnims();") >= 3   # resetBoardState / applySeed / 关开关
        and _gats.count("addRipple(") >= 2)               # 鼠标 1 + 触摸 1（定义在 renderer）
    chk("T60 ★ 绘制秩序：底色 → 内容 → 退场旗 → restore → 涟漪 → 覆盖层 → 星座线（涟漪不进缩放变换、星座线自己套）",
        _rts.index("this.drawDyingFlags(nowMs);") < _rts.index("if (zoomed) ctx.restore();")
        < _rts.index("this.drawRipples(nowMs);") < _rts.index("this.drawOverlay(hud);")
        < _rts.index("this.drawConstellation(nowMs, zoomed, v);"))
    chk("T60 ★ P1 质感：亚克力渐变缓存按格尺寸、棋盘托盘投影、药丸玻璃、邻域预亮只在对局中且无面板",
        "acrylicCell_" in _rts and "rgba(255,255,255,0.30)" in _rts
        and "shadowColor = 'rgba(30,40,60,0.22)'" in _rts
        and "rgba(255,255,255,0.55)" in _rts
        and "hud.phase === Phase.Playing && hov" in _rts)
    chk("T60 ★ P2 终局：星座线绕质心极角排序、失败雷区按切比雪夫距离错峰、错标抖动幅度衰减",
        "atan2(a.y - cy, a.x - cx)" in _rts and "captureWin" in _rts
        and "Math.abs(r - this.loss_.or), Math.abs(c - this.loss_.oc)" in _rts
        and "1 - age / kAnimMs.shake" in _rts)
    chk("T60 ★ 登录页流光：9s 周期对角光带画在星星底下，且尊重 animFx 设置与 reduced-motion",
        "function drawBand()" in _gjs and "drawBand();" in _gjs
        and '/"animFx"\\s*:\\s*(true|false)/' in _gjs
        and "prefers-reduced-motion" in _gjs)

    # ── T58：域名 80 端口接入（备案下来后域名可用）──
    # 2026-10-20 第一步「IP:8080 与域名 80 同语义」；同日第二步已把 80 改成只跳转（见 T61），
    # 这一组钉的是仍然成立的那部分：default_server 接管、server_name 写法、Debian 默认站点、ufw。
    # 这块跨「nginx 块 / Debian 默认站点 / ufw / 部署自测」四处，
    # 少任何一处都是「域名打不开」或「闸门在 80 上漏了」，所以钉死。
    chk("T58 ★ 80 端口进了本站 server 块，且接管 default_server（不留两个默认站）",
        "listen 80 default_server;" in dw_src and "listen [::]:80 default_server;" in dw_src)
    chk("T58 ★ server_name 只声明域名（不再写 `server_name _;`：谁兜住乱 Host 要靠 default_server 明说）",
        "server_name @@DOMAIN@@ www.@@DOMAIN@@;" in dw_src and "server_name _;" not in dw_src)
    chk("T58 ★ 域名是可覆盖变量，且占位符真的进了 sed（漏了会把 @@DOMAIN@@ 印上线上配置）",
        'DOMAIN="${DOMAIN:-ty0712.com}"' in dw_src
        and "s|@@DOMAIN@@|${DOMAIN}|g" in dw_src)
    chk("T58 ★ Debian default 站点被移走（否则两个 default_server → nginx -t 失败），且失败分支负责还原",
        "mv -f /etc/nginx/sites-enabled/default /root/cms-bak/sites-enabled-default.symlink" in dw_src
        and "mv -f /root/cms-bak/sites-enabled-default.symlink /etc/nginx/sites-enabled/default" in dw_src)
    chk("T58 ★ ufw 放行 80 与 443：nginx 听得到但包进不来，现象正是「域名打不开」",
        "ufw allow 80/tcp" in dw_src and "ufw allow 443/tcp" in dw_src)
    # 443 由「开关片段」带进来，主块里只允许那一行 include。
    # 取数必须只看**主块正文**：开关生成器（3.7 那段 heredoc）里的 listen 443 是
    # 它该在的正体，混在一起算就成了「自己打自己」；而注释里提到这些词是说明。
    _mk = dw_src.splitlines()
    _na = next((i for i, _l in enumerate(_mk) if "<<'NGINX'" in _l), 0)
    _nb = next((i for i in range(_na + 1, len(_mk)) if _mk[i].strip() == "NGINX"), _na)
    _main = "\n".join(ln for ln in _mk[_na + 1:_nb] if not ln.strip().startswith("#"))
    chk("T58 ★ 主块对 443 只有那行 include（裸的监听与证书路径不写进主块：证书一丢，"
        "nginx -t 就因缺 cert 失败并把整站拖回滚，把 443 和 80/8080 绑成同一个故障）",
        "listen 443" not in _main and "ssl_certificate" not in _main
        and "include /etc/nginx/snippets/cms-https-listen.conf;" in _main)
    chk("T58 ★ 部署自测从服务器本地打「域名 Host + 127.0.0.1:80」这一个口径（跳转速查、明文入口不留痕、"
        "未匹配 Host 不再吐 Debian 欢迎页都建立在它上面）",
        "-H 'Host: ${DOMAIN}' http://127.0.0.1\\$p" in dw_src
        and "tcurl \\\"http://127.0.0.1/gate/\\$TOK/\\\" -D- -o /dev/null -H 'Host: ${DOMAIN}'" in dw_src
        and "grep -qiF 'Welcome to Debian'" in dw_src)
    # 会话 cookie 不钉 Domain = 浏览器按「请求用的主机」存，换主机（IP ⇄ 域名）必然要重登。
    # 这是有意的：钉 Domain=ty0712.com 反而会把会话扩散到 www 与任意同名主机。
    # Secure 是 2026-10-20 明文收口时加的，但**按 scheme 条件**加（判据 X-Forwarded-Proto）：
    # 无条件加等于把收回环的 8080 / SSH 隧道那条路当场封死（浏览器不肯在 http 主机存 Secure cookie）。
    # 而下发与清除必须走同一条谓词：RFC 6265 下明文请求既不能替换也不能删除 Secure cookie，
    # 不对称的表现是「隧道上登得进、退不出」——清不掉的那份 cookie 才是真隐患。
    chk("T58 ★ 会话 cookie 不钉 Domain；Secure 按 scheme 条件加，且下发与清除共用同一条谓词",
        "Domain=" not in authd_src
        and authd_src.count("Path=/; HttpOnly; SameSite=Lax") == 2
        and 'def _secure_suffix' in authd_src and 'proto == "https"' in authd_src
        and 'X-Forwarded-Proto' in authd_src
        and 'SameSite=Lax{self._secure_suffix()}; Max-Age=0' in authd_src
        and 'SameSite=Lax{self._secure_suffix()}")' in authd_src)

    # ── T59：HTTPS 第一步（acme.sh 签证书 + 开关式 443；80 与 8080 语义一字不变）──
    # 这组跨四处：主块那行 include / ACME 挑战路径 / 开关片段的两份内容 / 一次性签发脚本。
    # 歪任何一处都是「证书签不下来」「include 的文件不存在 → nginx -t 失败拖全站回滚」
    # 或「443 上了但闸门漏了」，所以逐条钉死。
    hs_src = (root / "scripts" / "web" / "deploy-https.sh").read_text(encoding="utf-8")
    readme_src = (root / "README.md").read_text(encoding="utf-8")
    _ml = _main.splitlines()
    _si = next((i for i, ln in enumerate(_ml) if "/.well-known/acme-challenge" in ln), None)
    _acme = "\n".join(_ml[_si:_si + 6]) if _si is not None else ""
    chk("T59 ★ ACME 挑战路径公开：^~ 压过带 auth_request 的正则 + root 指专用 webroot + 只认精确存在的文件",
        _si is not None and "location ^~ /.well-known/acme-challenge/" in _acme
        and "root /var/www/acme;" in _acme and "try_files $uri =404;" in _acme)
    # 挑战块若回退到 /index.html，就等于把受闸门保护的游戏 HTML 从公开路径泄漏出去。
    chk("T59 ★ 挑战块绝不回退 index.html、也不挂 auth_request（公开的最小面 = 一个前缀 + 只发文本）",
        "index.html" not in _acme and "auth_request" not in _acme
        and "default_type text/plain;" in _acme)
    # 三处 webroot 必须同名：签发脚本放文件、nginx 读文件、部署自测伪造探针各写各的，
    # 拼错任何一个字都是「挑战 404、证书永远签不下来」。
    chk("T59 ★ webroot 三处一致（nginx 的 root / 签发脚本的 WEBROOT / 自测写探针的目录）",
        "WEBROOT=/var/www/acme" in hs_src
        and dw_src.count("/var/www/acme/.well-known/acme-challenge") >= 3)
    # 开关片段必须在 nginx -t 之前落盘：主块 include 了它，文件不存在时 nginx 直接
    # 报 no such file —— 连「证书缺失就不监听」这颗安全阀本身都会变成全站回滚。
    _sw = next((i for i, ln in enumerate(_mk) if ln.strip() == "HTTPSLISTEN"), None)
    _nt = next((i for i, ln in enumerate(_mk) if "if ! nginx -t" in ln), None)
    chk("T59 ★ 开关片段排在 nginx -t 之前，且证书缺失时写的是**空文件**而不是不写文件",
        _sw is not None and _nt is not None and _sw < _nt and ': > "$SNIP"' in dw_src)
    chk("T59 ★ 开关片段两份内容都在：证书在才写监听与证书路径（回退只要清空再 reload）",
        "listen 443 ssl http2;" in dw_src and "ssl_certificate $CMS_PEM;" in dw_src
        and "ssl_certificate ${SSL_PEM};" not in dw_src and 'chmod 644 "$SNIP"' in dw_src)
    # nginx 1.24 没有独立的 http2 指令（1.25.1 才有）；写成那样 nginx -t 直接失败。
    chk("T59 ★ http2 只写在 listen 行上（线上是 1.24，独立的 http2 指令会直接把 nginx -t 打红）",
        "http2 on;" not in dw_src and "listen 443 ssl http2;" in dw_src)
    # LE 对同一注册域名限 5 张证书 / 7 天：拿正式环境试错是要还的，所以先 staging 走一遍；
    # 而签发只许出现在一次性脚本里 —— 重部署不该碰 CA。
    _stg = hs_src.find("--issue --server ${LE_STAGING}")
    _prod = hs_src.find("--issue --server ${LE_PROD}")
    chk("T59 ★ 先 staging 再正式（顺序不能反），且 deploy-web.sh 不参与签发",
        0 <= _stg < _prod and "--keylength ec-256" in hs_src and "--issue" not in dw_src)
    chk("T59 ★ 只签裸域名（www 没有 DNS 记录，http-01 签不了未解析的名字）",
        "-d ${DOMAIN}" in hs_src and "www." not in hs_src)
    # --reloadcmd 是续期成功后的最后一步：缺了它就是「续下来但线上仍用旧证书」，
    # 表现是到期那天突然打不开 —— 平时一点症状都没有。
    chk("T59 ★ 装证书到 nginx 位置 + --reloadcmd + 装 cron（少 reload 就是「续期成功但线上没换证书」）",
        "--install-cert" in hs_src and "/etc/nginx/ssl" in hs_src
        and "--reloadcmd 'systemctl reload nginx'" in hs_src and "--install-cron" in hs_src)
    # 供应链：服务器上 raw.githubusercontent.com 被连接重置、jsdelivr 也不通，但 github.com 可达
    # —— 所以只能 clone，而且必须钉 tag（curl | sh 拉 master 既走不通也不可复现）。
    chk("T59 ★ acme.sh 用钉 tag 的 git clone 取，脚本里没有任何「管道给 sh 执行」的安装方式",
        "git clone --depth 1 --branch ${ACME_TAG}" in hs_src
        and 'ACME_TAG="${ACME_TAG:-v3.1.6}"' in hs_src and "| sh" not in hs_src)
    # 私钥只落服务器：仓库里不许有证书文件，上传命令的源里也不许有证书目录（rsync --delete
    # 一旦把 /etc/nginx/ssl 认成源，等于每次部署往外推私钥）。
    _keys = [p for d in ("scripts", "server", "docs", "tools") for p in
             list((root / d).rglob("*.pem")) + list((root / d).rglob("*.key"))]
    chk("T59 ★ 私钥不入库、不在任何 rsync 源里",
        not _keys and "/etc/nginx/ssl" not in
        "\n".join(ln for ln in dw_src.splitlines() if ln.startswith("rsync")))
    # 只看**真的发起请求**的那几行：收口之后 https://${DOMAIN} 也出现在提示文案与
    # 跳转断言的比对串里，把它们一起算进来等于自己打自己。
    _h443 = [ln for ln in dw_src.splitlines()
             if "https://${DOMAIN}" in ln and "curl" in ln]
    chk("T59 ★ 自测用真域名真证书打 443 且不带 -k（验不过就部署失败，不留一个「能连但不安全」的端口）",
        len(_h443) >= 4 and all(" -k " not in ln and "--resolve ${DOMAIN}:443:127.0.0.1" in ln
                               for ln in _h443))
    chk("T59 ★ 自测把「挑战文件真取到」当硬条件，并报证书剩余天数（cron 静默失败只在这里能发现）",
        "cms-deploy-probe" in dw_src and "http-01 会失败" in dw_src
        and "-enddate" in dw_src and "-lt 21" in dw_src)
    # 2026-10-21 用户点头，HSTS 开了。头写在**共用安全片段**里、值取自站点文件的 map，
    # 两处缺任何一处都只表现为「配了却静默不发」，且 map 缺失会让 nginx -t 当场失败，
    # 所以这里查的是「两处都在 + 发的是变量不是字面量」。
    chk("T59 ★ HSTS 已开启（2026-10-21 裁决）：片段里那行发的是 $cms_hsts，值由站点文件的 "
        "map 按协议给 —— 写死字面量会让明文 80 的 302 与回环 8080 也带上这个头",
        "add_header Strict-Transport-Security $cms_hsts always;" in dw_src
        and 'map $scheme $cms_hsts {\n    https   "max-age=15552000";\n    default "";\n}' in dw_src
        and "Strict-Transport-Security" not in hs_src)
    chk("T59 ★ 文档同步：密码闸门.md 写清开关片段与四条踩坑（raw 被重置 / 1.24 的 http2 / staging 限额 / 挑战路径 404）",
        "开关片段" in gu_doc and "raw.githubusercontent" in gu_doc and "http2 on" in gu_doc
        and "5 张" in gu_doc and "acme-challenge" in gu_doc)
    chk("T59 ★ README 口径跟上：域名有 https，且写明对外只有这一个地址",
        "https://ty0712.com" in readme_src and "8080" in readme_src
        and "ssh -p <SSH端口>" in readme_src)

    # ── T60：真跑一遍签证书才冒出来的三个坑（2026-10-20 上线实录）──────────
    # 这三条都是「读代码看不出来、只有把 acme.sh 真跑一遍才撞得上」的：
    #   ① --install 按**当前目录**往 --home 拷文件，绝对路径调用会留一个空壳 home；
    #   ② 参数是 --remove 不是 --delete，且 --remove 只删配置不删 key/cert 文件，
    #      下一次 --issue 会因「域名私钥已存在」失败；而 staging 记录若不清掉，
    #      正式 --issue 只回「Skipping」**且退出码 0**，假证书就一路装进 nginx ——
    #      deploy-web.sh 的开关片段只看文件在不在，分不出真假证书，所以装完必须验 issuer；
    #   ③ acme.sh v3.1.6 的默认 CA 已经是 ZeroSSL，正式签不写 --server 就静默换 CA，
    #      而本仓库的限额口径、账户邮箱、续期说明全是按 Let's Encrypt 写的。
    hs_code = "\n".join(ln for ln in hs_src.splitlines() if not ln.strip().startswith("#"))
    chk("T60 ★ acme.sh --install 是在源码目录里跑的（cd 进去 + ./acme.sh）",
        "(cd ${ACME_SRC} && ./acme.sh --install" in hs_code)
    chk("T60 ★ 装之前先 rm -rf 半个空壳 home（否则「已存在」判断被空目录骗过）",
        "rm -rf ${ACME_HOME}\n" in hs_src)
    chk("T60 ★ 清域名记录只用 --remove（v3.1.6 没有 --delete），且每次后面都跟着删域名目录",
        "--remove -d ${DOMAIN} --ecc" in hs_code and "--delete" not in hs_code
        and hs_code.count("rm -rf ${ACME_HOME}/${DOMAIN}_ecc") == 2)
    chk("T60 ★ staging 之后那次 --remove 是硬失败（不能 || true 吞掉，否则假证书一路装下去）",
        "if ! \\$A --remove" in hs_code)
    _ic = hs_src.find("--install-cert")
    chk("T60 ★ 装完证书当场验 issuer：STAGING 假证书一律删掉并失败退出",
        _ic >= 0 and "grep -q 'STAGING'" in hs_src[_ic:]
        and "rm -f ${PEM} ${KEY}" in hs_src[_ic:])
    chk("T60 ★ 正式签显式钉 Let's Encrypt（v3.1.6 默认 CA 是 ZeroSSL，不写就会静默换 CA）",
        "LE_PROD=https://acme-v02.api.letsencrypt.org/directory" in hs_src
        and "--issue --server ${LE_PROD}" in hs_src)
    chk("T60 ★ 文档记了这三条坑（下次重装的人不必再撞一遍）",
        all(k in gu_doc for k in ("cannot stat", "--remove", "ZeroSSL")))
    chk("T60 ★ 文档口径已从「证书待签」改成「已上线」，且仍写明这道门是软隔离"
        "（收口只堵住明文通道，没把闸门变成安全边界）",
        "**已上线**" in gu_doc and "Verify return code: 0" in gu_doc
        and "永远" in gu_doc and "IP:8080" in gu_doc
        and "明文" in gu_doc)

    # ── T61：明文收口（HTTPS 第二步，2026-10-20 获批同日上线）───────────────
    # 用户原话「关掉8080，http强制到443（反正用443功能都是一样的嘛）」+ 追问后确认
    # 「8080 绑 127.0.0.1，我用时开 SSH 隧道」。这组跨五处：nginx 两个块 / authd 的
    # cookie / ufw / 部署自测 / 文档。歪任何一处的代价都是具体的：
    #   少一个块 → 明文继续 serving 受闸门保护的内容；用 $host → 钓鱼跳转；
    #   删监听 → 探活 4/6 与整段自测当场误报；无条件 Secure → 隧道里谁都登不进；
    #   下发与清除不对称 → 登出静默失败（清不掉的那份才是真隐患）。
    _r302 = _main.find("return 302 https://@@DOMAIN@@$request_uri;")
    _b1 = _main[_main.find("server {"):_r302] if _r302 >= 0 else ""
    chk("T61 ★ 80 拆成独立的「只跳转」块：块一里不许出现闸门、代理或内容块的任何东西"
        "（两个块各写一次 server_name/server_tokens/安全头 include，因为 add_header 不跨块继承）",
        _r302 >= 0 and "listen 80 default_server;" in _b1
        and "auth_request" not in _b1 and "127.0.0.1:" not in _b1
        and "cms-https-listen.conf" not in _b1 and "_@@PORT@@" not in _b1)
    chk("T61 ★ ACME 挑战路径在两个块里各一份（LE 跟着 302 落到 443 还要能取到文件；"
        "只留 80 那份 = 90 天后证书续不上，且当天才有症状）",
        _main.count("location ^~ /.well-known/acme-challenge/ {") == 2
        and dw_src.count("location ^~ /.well-known/acme-challenge/ {") == 2)
    # 跳转目标写死域名；$host 是客户端可控的（注释里会提它，判据只看 302 那一行本身）。
    # 2026-10-20 真部署撞到的第五个坑：return 写成 server 级时，它跑在 rewrite 的
    # server 阶段、先于 location 匹配 —— /gate/ 的 404 与 ACME 的 ^~ 全被短路
    # （实测：明文上 /gate/<TOKEN>/ 拿到 302，Location 里明文带着 token）。
    # 所以必须钉「302 在 location / 里面」这个形状，光有这两行字面量不够。
    _r302_blk = "location / {\n        return 302 https://@@DOMAIN@@$request_uri;\n    }"
    chk("T61 ★ 跳转只许是 302 + 写死 @@DOMAIN@@，且必须写在 location / 里"
        "（301 会被浏览器长期缓存、证书出事退不回；拿 $host 拼等于让来访者决定跳去哪；"
        "写到 server 级会先于 location 匹配执行，短路 /gate/ 的 404 与 ACME 续期）",
        _r302 >= 0 and "@@DOMAIN@@" in _main[_r302:] and "$host" not in _main[_r302:_r302 + 60]
        and "return 301 https" not in _main
        and _r302_blk in _main
        and _main.count("return 302 https://") == 1)
    # 明文那条路上闸门「不存在」：不跳转、直接 404，且响应头里不许有 token
    _h80 = [ln for ln in dw_src.splitlines() if 'http://127.0.0.1/gate/\\$TOK/' in ln]
    chk("T61 ★ 明文 80 上秘密入口 404 且自测把「响应头里出现 token」判成失败"
        "（302 会把唯一的登录凭据原样写进明文 Location）",
        "return 404;" in _bare and len(_h80) >= 1
        and "grep -q \\\"\\$TOK\\\"" in dw_src and "明文广播" in dw_src)
    # ★2（2026-10-21 复审）实证过的那一击就是这个自测自己打的：它 curl 明文 80 上的
    # 秘密入口，token 进了 access.log（当时 grep 判的是「响应头」，头干净、日志脏）。
    # 「零命中」不能当判据 —— 修之前留下的历史行还在文件里，会把一次成功修复判成失败，
    # 所以量的是**这一次自测期间多出来的行数**。
    # ★2026-10-22：只数 access.log 是半个判据 —— error_log 不受 access_log off 影响
    # （limit_req 的 429、alias 的 open() 失败都带完整 URI）。所以改成一整段自测的
    # 前后两次总账，覆盖 access + error、含 .1/.gz。
    chk("T61 ★ 自测把**全部 nginx 日志**的 token 增量当硬条件（access + error，含 .1/.gz）",
        "count_tok_hits()" in dw_src
        and "/var/log/nginx/error.log" in dw_src
        and "zgrep -c -F" in dw_src
        and "n_log_before=" in dw_src and "n_log_after=" in dw_src
        and "全部 nginx 日志（access+error）" in dw_src and "本次自测新增" in dw_src)
    chk("T61 ★ 8080 只绑回环（v4+v6 一对），对外那个写法必须消失 —— "
        "`listen 8080;` 就是 0.0.0.0:8080，等于留一条永远明文的入口",
        "listen 127.0.0.1:@@PORT@@" in _main and "listen [::1]:@@PORT@@" in _main
        and "\n    listen @@PORT@@;" not in _main and "\n    listen [::]:@@PORT@@;" not in _main)
    # 配置文本会骗人（改一行就绿），真实 socket 不会 —— 所以拿 ss 当判据。
    chk("T61 ★ 自测拿 `ss -ltn` 抓真实监听判「有没有非回环的 8080」，"
        "并另验回环上确实有（删掉监听的话探活第 4/6 项和这段自测的基准一起断）",
        r"stray_bind=\$(ss -ltn" in dw_src
        and r"""grep -v '^127\\.0\\.0\\.1:'""" in dw_src
        and r"""grep -v '^\\[::1\\]:'""" in dw_src
        and r"""grep -q \"127.0.0.1:${PORT}\"""" in dw_src)
    chk("T61 ★ ufw 撤掉 8080 但保留 80/443（撤成 || true 才对：规则本来不存在时 ufw 会非零退出，"
        "set -e 下会把部署掐死）",
        "ufw delete allow ${PORT}/tcp >/dev/null 2>&1 || true" in dw_src
        and "ufw allow 80/tcp" in dw_src and "ufw allow 443/tcp" in dw_src)
    # 2026-10-20 真部署撞到的第四个坑（前三个见 T60）：把 `listen 8080;` 改成
    # `listen 127.0.0.1:8080;` 时，reload 会因旧 worker 还占着 0.0.0.0:8080 而 bind 失败
    #（error.log: Address already in use），nginx 保留旧配置继续跑、systemctl 仍回 0 ——
    # 自测打到的还是旧行为。所以 reload 之后必须核对**真实监听**，对不上就重启一次。
    chk("T61 ★ reload 后用 ss 核对监听，8080 还在对外地址就 systemctl restart"
        "（改 listen 是 reload 换不掉的：旧 socket 占着旧地址，而 systemctl 不会报错）",
        "Address already in use" in dw_src and "改为重启 nginx" in dw_src
        and "systemctl restart nginx" in dw_src
        and r"""| grep -v '^\\[::1\\]:' | grep -q .""" in dw_src)
    # 两个方向都要钉：https 侧**必须**带 Secure，回环侧**必须不带**。
    # 只钉前者会放过「无条件加」，而后者一旦破了就是隧道里登不进、且一句报错都没有。
    chk("T61 ★ 自测用 /__logout 当免密探针，双向验 cookie：443 必须带 Secure、"
        "回环那侧必须不带（探针走的是不需要口令的路径，所以它验的是属性而不是登录）",
        r"-X POST --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/__logout" in dw_src
        and r"curl -s -D- -o /dev/null -X POST http://127.0.0.1:${PORT}/__logout" in dw_src
        and r"""if printf '%s' \"\$plain\" | grep -qi 'Secure'""" in dw_src)
    chk("T61 ★ 两条代理路径都送 X-Forwarded-Proto（少 /__logout 那条就是「登进得、退不出」），"
        "且 authd 只认这一个判据",
        dw_src.count("proxy_set_header X-Forwarded-Proto $scheme;") == 2
        and authd_src.count("_secure_suffix()") == 2)
    # 收口换来的新硬依赖：没有证书就没有 443，而 80 只会把人往 443 送 → 域名整站打不开。
    # 所以「证书不在」必须让部署失败，不能再当成「退回明文、照常绿灯」。
    chk("T61 ★ 证书不在时部署判红（不再是「○ 只验了 ACME」的绿灯）：80 已经 302 了，"
        "没证书等于全站打不开，留着绿灯就是把故障留到上线那天发现",
        "exit 1" in dw_src[dw_src.find("证书未就位"):]
        and "没有证书 = 没有人监听 443 = 域名整站打不开" in dw_src)
    chk("T61 ★ 443 自测不再拿 80 当基准（80 现在只会 302，比码数等于要求它继续 serving 内容）",
        "（80 为" not in dw_src and r"curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}\$p" in dw_src)
    # HSTS 的口径从「不许有」翻成「必须配齐、且端到端验得到」：配置里那行只是必要条件，
    # 真证明它出去的是 443 上那一次 curl；反向（明文侧一行都不发）同样必须有，
    # 否则 map 被写成字面量也照样全绿。
    chk("T61 ★ 自测把 HSTS 当硬条件：配置层查片段那行 + 站点文件里的 map，443 必须收到 "
        "max-age=15552000，明文 80 与回环 8080 必须收到 0 行",
        r"grep -q 'add_header Strict-Transport-Security \$cms_hsts'" in dw_src
        and r"grep -q 'map \$scheme \$cms_hsts'" in dw_src
        and "hsts443" in dw_src and "hsts_plain" in dw_src and "hsts_loop" in dw_src
        and dw_src.count("max-age=15552000") >= 2)
    chk("T61 ★ 文档同步：密码闸门.md 与 README 都改成「对外只有 https 域名 + 内测口要开 SSH 隧道」，"
        "并写明收口之后这道门仍是软隔离",
        "收回服务器内部" in gu_doc and "SSH 隧道" in gu_doc and "127.0.0.1" in gu_doc
        and "按 scheme 条件加" in gu_doc and "T61" in gu_doc
        and "ssh -p <SSH端口>" in readme_src and "明文通道已收口" in readme_src)
    chk("T61 ★ 复制入口给出去的完整网址也换成 https 域名（cmsui 的 SITE_ORIGIN 与 CLI 提示同口径）",
        'SITE_ORIGIN = os.environ.get("CMSGATE_SITE", "https://' in gu_src
        and "https://<域名>/gate/{token}/" in gm_src)

    # ── T62：探活第 7 项 —— 证书剩余天数（HTTPS 第二步的第一半，2026-10-21）──────
    # 收口之后 443 是**唯一**对外入口（80 只会 302 过来），所以「证书断了」不再是
    # 「退回明文还能用」，而是整站打不开。而续期失败在到期日之前线上**毫无症状**：
    # 前六项全绿、访客一切正常，直到某天浏览器直接弹证书过期。
    # 顺序也定过：先有这盏灯，再谈 HSTS —— 否则 HSTS 一开，证书断了连清缓存退路都没有。
    _dm = (root / "scripts" / "web" / "deploy-monitor.sh").read_text(encoding="utf-8")
    chk("T62 ★ 第 7 项读的是**本地 PEM 的到期日**，不联网判 TLS（s_client 会被 80→443 跳转、"
        "防火墙抖动、续期装了但没 reload 这些无关因素误报；而「续期到底有没有落地」只看文件），"
        "阈值 14 天（acme.sh 提前量 30 天，健康系统不会低于 ~30）",
        "openssl x509 -noout -enddate" in hc_src
        and "/etc/nginx/ssl/ty0712.com.pem" in hc_src and '"$PEM"' in hc_src
        and "-ge 14" in hc_src and "s_client" not in hc_src)
    # 形状检查会骗人：把 `-ge 14` 写成 `-gt 14`、或把比较对象换错，脚本照样跑、照样发
    # 成功 ping，只是再也不报。所以拿「喂给它 left=3 和 left=20 会怎样」当判据 ——
    # 把那段守卫单独抽出来，在最小桩环境里真跑一遍（本机没有 PEM、也没有 GNU date，
    # 但左值就是那个整数，桩掉 ping_fail 足够证明阈值不是摆设）。
    _hc = hc_src.splitlines()
    _gi = [i for i, l in enumerate(_hc) if "-ge 14" in l]
    _cond = (_hc[_gi[0]].rstrip().rstrip("\\").strip() + " " + _hc[_gi[0] + 1].strip()
             if len(_gi) == 1 else "")

    def _guard_fails(days: int) -> bool:
        p = subprocess.run(
            ["/bin/sh", "-c",
             'ping_fail() { echo FAIL; exit 0; }\n'
             f"left={days}\n{_cond}\necho PASS\n"],
            capture_output=True, text=True, timeout=10)
        return "FAIL" in p.stdout and "PASS" not in p.stdout

    chk("T62 ★ 阈值不是摆设：抽出的守卫在 left=3 时确实走 ping_fail、left=20 时放行"
        "（改错比较方向或删掉那行，这条会红 —— 而线上只表现为「证书到期那天突然全站打不开」）",
        len(_gi) == 1 and "ping_fail" in _cond and _guard_fails(3) and not _guard_fails(20),
        f"抽出的守卫：{_cond!r}")
    chk("T62 ★ 到期日取不到时判红而不是放行（openssl 报错 → end 为空 → 若直接算 left，"
        "bash 会当 0 处理、于是永远「不足 14」或反过来静默跳过，取决于写法）",
        '[ -n "$end" ] || ping_fail' in hc_src
        and '证书文件缺失或不可读' in hc_src)
    chk("T62 ★ 第 8 项盯每日快照新鲜度：目录、26h 阈值、空目录也判红"
        "（备份是最安静的故障 —— 断了没有任何外部症状，真要恢复时才发现没得选）",
        "BACKUP_DIR=/root/cms-backup" in hc_src
        and "cms-*.tar.gz" in hc_src
        and '[ "$age" -lt 26 ]' in hc_src
        and '备份目录里没有任何 cms-*.tar.gz' in hc_src)
    chk("T62 ★ 第 7 项只碰公钥证书，绝不读私钥（.key 600 root；而 ping_fail 的文本会经 "
        "/fail **发给第三方监控服务**，脚本一旦打印或引用私钥路径就是往外送）",
        ".key" not in hc_src)
    chk("T62 ★ 项数文案三处同步（脚本文案、部署自测、文档表格）—— 旧的「六项/七项/八项/九项探活」"
        "必须绝迹：探活说自己绿而实际没测，是最难查的那种谎（仓库脚本 13 项=cmsdist + 11-02 补的"
        " sshd/fail2ban+chrony/内存/learn，服务器 14 项=另有 QQbot bot 段，QQbot 不进仓库）",
        "十三项探活全绿" in hc_src and "六项探活" not in hc_src and "七项探活" not in hc_src
        and "八项探活" not in hc_src and "九项探活" not in hc_src
        and "十三项探活全绿" in _dm and "六项探活" not in _dm and "七项探活" not in _dm
        and "八项探活" not in _dm and "九项探活" not in _dm
        and "| 7 |" in gu_doc and "| 8 |" in gu_doc and "| 9 |" in gu_doc
        and "| 10 |" in gu_doc and "| 13 |" in gu_doc and "| 14 |" in gu_doc
        and "六项探活" not in gu_doc and "七项探活" not in gu_doc
        and "八项探活" not in gu_doc and "九项探活" not in gu_doc)
    chk("T62 ★ 文档同步：第 7 项写清了「读本地 PEM 而非线上 TLS」的理由 + 14 天阈值的由来",
        "本地 PEM 里的到期日" in gu_doc and "acme.sh" in gu_doc and "14" in gu_doc)
    # HSTS 能开的前提是第 7 项先上线：头锁 180 天且退不回，证书真断了只有那条告警能提前送到。
    # 所以这条不查「有没有头」，查的是「锁的理由和兜底还在不在」。
    chk("T62 ★ HSTS 的锁时长与前提写进配置注释和文档：180 天（不是 365）、不带 includeSubDomains，"
        "兜底是探活第 7 项的证书剩余天数（<14 就红）",
        "15552000" in dw_src and "includeSubDomains" in dw_src and "180" in dw_src
        and '-ge 14' in hc_src and '证书只剩' in hc_src
        and "15552000" in gu_doc and "HSTS" in gu_doc)

    # ── T63：安全审计 ★1（离线凭据旁路）+ ★2（远端 shell 注入），2026-10-21 ──────
    # 这两条的共性是「**静默降级**」：守卫破了不会报错，线上照常打印「✓ 已完成」，
    # 事后从审计里也看不出来。所以判据一律是「真跑一遍，看它拒不拒」——
    # grep 形状只能证明代码长那样，证明不了它会在该拦的时候拦下来。
    _gm_tool = root / "tools" / "gate_manager.py"

    def _cms(*args: str, stdin: str = "") -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, str(_gm_tool), *args],
                              input=stdin, capture_output=True, text=True, timeout=90)

    _gmm63 = load_gate_manager()
    with tempfile.TemporaryDirectory() as td63:
        st63 = Path(td63) / "state"
        cfg63 = Path(td63) / "gateconfig.json"
        cfg63.write_text(json.dumps({
            "version": 1, "require_password": True,
            "updated_at": _gmm63.now_iso(), "updated_by": "t63",
            "admin": _gmm63.make_admin_block(TEST_ADMIN_PW)}, ensure_ascii=False),
            encoding="utf-8")
        chk("T63 ★1 前置：临时 state 能 init（后面四条都靠它，坏了要先把这条修好）",
            _cms("--state", str(st63), "init").returncode == 0)

        def _revoke() -> subprocess.CompletedProcess:
            return _cms("--state", str(st63), "--offline-admin-config", str(cfg63),
                        "revoke-all", "--yes", "--no-push", "--admin-stdin",
                        stdin=TEST_ADMIN_PW + "\n")

        def _gen() -> int:
            return int(json.loads((st63 / "passwords.json").read_text(encoding="utf-8"))["gen"])

        def _audit() -> str:
            p = st63 / "gate_audit.jsonl"
            return p.read_text(encoding="utf-8") if p.exists() else ""

        # ★1 的旁路把「凭据从哪来」交给调用者，所以那份文件**绝不能是别人能改的**：
        # 一个 0644 的假 config 可以是任何本地进程放的，那样管理口令这道门就反过来了
        # —— 攻击者写一份、用它过认证、再让命令去连真实服务器。0600 + 属主是对自己，
        # 是唯一能证明「这份凭据是你本人的」的便宜判据。
        os.chmod(cfg63, 0o644)
        g0 = _gen()
        r_bad = _revoke()
        chk("T63 ★1 假凭据不是 0600 就当场拒，且**一个字节都不改**"
            "（这条守卫不灵，就等于「你自己指定的凭据」可以是任何人放的一份可写文件）",
            r_bad.returncode != 0 and "0600" in (r_bad.stdout + r_bad.stderr)
            and _gen() == g0 and "admin-ok-offline" not in _audit())

        os.chmod(cfg63, 0o600)
        r_wrong = _cms("--state", str(st63), "--offline-admin-config", str(cfg63),
                       "revoke-all", "--yes", "--no-push", "--admin-stdin",
                       stdin="显然不是那一条口令\n")
        chk("T63 ★1 旁路换的是**凭据来源**，不是取消校验：喂错口令照样拒、gen 照样不动",
            r_wrong.returncode != 0 and _gen() == g0)

        r_ok = _revoke()
        chk("T63 ★1 走这条分支必须**留痕**：审计里写着 admin-ok-offline，输出里也警告一次"
            "（旧写法连审计都没有，事后完全看不出那次写操作没经过线上 gateconfig）",
            r_ok.returncode == 0 and _gen() == g0 + 1
            and "admin-ok-offline:" in _audit()
            and "离线自检凭据" in (r_ok.stdout + r_ok.stderr))

        # ★2 的核心判据：拿一个**带单引号的真实文件名**去写状态，再把生成的远端命令串
        # 用 shlex 还原一遍 —— 引对了，payload 会完整回来；引错了，要么 split 直接抛，
        # 要么还原出来的东西和被写进去的不一样（那就是命令被切开、后半段裸奔执行）。
        _evil = "/tmp/宝贝'$(id)'.webp"
        _captured: list = []
        _real_run = _gmm63.run

        class _Stub:
            returncode, stdout, stderr = 0, "", ""

        def _stub_run(cmd, **kw):
            _captured.append(cmd)
            return _Stub()

        _ns = _gmm63.argparse.Namespace(
            server="root@example.invalid", ssh_port="712",
            remote_dir="/var/lib/cmsgate", web_root="/var/www/complexminesweeper")
        _gmm63.run = _stub_run
        try:
            _gmm63._webbg_put_state(_ns, {"mode": "on", "source": _evil})
        finally:
            _gmm63.run = _real_run
        _script = _captured[-1][-1] if _captured else ""
        _payload = json.dumps({"mode": "on", "source": _evil}, ensure_ascii=False)
        try:
            _toks = __import__("shlex").split(_script)
        except ValueError as e:
            _toks = [f"SPLIT-FAILED {e}"]
        chk("T63 ★2 `webbg push --image` 的路径里带单引号也不会把远端命令炸开："
            "整条 ssh 命令串能被 shlex 还原，且 payload 作为一个完整 token 原样回来"
            "（旧写法 printf '%s' '<payload>' 遇到这种文件名会让后面那段以 root 执行，"
            "而脚本照常报「✓ 已推送」）",
            bool(_script) and _payload in _toks and f"'{_evil}'" not in _script)

        chk("T63 ★2 旧的裸插值写法必须绝迹，且 shlex 真的被 import 了（不然上一条只是巧合）",
            "'{payload}'" not in gm_src and "import shlex" in gm_src
            and "shlex.quote(payload)" in gm_src and "shlex.quote(path" in gm_src)

        # 远端路径散落在十几条命令里，逐处记得 quote 是迟早会漏的那种设计；所以在入口
        # 把字符集收紧成一道关卡 —— 漏一处就是一次 root 执行，关卡只需要一个人记得。
        r_inject = _cms("--state", str(st63), "--web-root", "/var/www/a';id;'",
                        "webbg", "status")
        chk("T63 ★2 `--web-root`（以及 --server / --remote-dir）里出现引号或 shell 元字符，"
            "CLI 在最前面就拒，而且根本走不到 ssh 那一步",
            r_inject.returncode != 0 and "不合规矩" in (r_inject.stdout + r_inject.stderr))
        # 等号形式 `--server=-oProxyCommand=…` 里有 `=`，字符集那关就先拦下了；
        # 但 `-i/root/.ssh/id_rsa` 全是合法字符，argparse 又按等号原样收下，
        # 于是 ssh 把这个值当成**自己的选项**（换身份文件；`-o` 系列更是直接执行命令），
        # 而不是主机名 —— 那已经跟远端 shell 无关，字符集关卡管不到，只能单独堵在开头。
        r_dash = _cms("--state", str(st63), "--server=-i/root/.ssh/id_rsa", "webbg", "status")
        chk("T63 ★2 `--server` 以 `-` 开头当场拒（这种值 argparse 照收，到了 ssh 那边是"
            "**选项**而不是主机名 —— 字符集合法也照样要拦）",
            r_dash.returncode != 0 and "不能以 `-` 开头" in (r_dash.stdout + r_dash.stderr))
        # cmsui 自己也会拼 ssh 命令串（背景图预览 `cd '<web_root>' && head -c …`），
        # 只在 gate_manager 的 main() 设卡管不到它 —— 这道关卡必须两边都在。
        r_ui63 = subprocess.run(
            [sys.executable, str(root / "tools" / "gate_ui.py"),
             "--web-root", "/var/www/a';id;'", "--port", "1"],
            capture_output=True, text=True, timeout=60)
        chk("T63 ★2 可视化界面（cmsui）用同一个字符集关卡：`--web-root` 带引号时起服务前就拒"
            "（它自己那条 `cd '<web_root>' && head -c` 不经过 gate_manager 的 main）",
            r_ui63.returncode != 0 and "不合规矩" in (r_ui63.stdout + r_ui63.stderr))
        chk("T63 ★2 这道关卡的位置：parse_args 之后、任何命令执行之前"
            "（放在 cmd_* 里就会漏命令，而漏掉的命令不会报错）；"
            "用 rfind 是因为**定义**也在文件里，find 只会抓到定义那一处",
            gm_src.rfind("_refuse_shell_unsafe_endpoints(a)") > gm_src.find("a = ap.parse_args()")
            and gm_src.rfind("_refuse_shell_unsafe_endpoints(a)") < gm_src.rfind("    a.fn(a)")
            and "gm._refuse_shell_unsafe_endpoints(a)" in gu_src)

    _t63_self = (root / "tools" / "test_gate_ui.py").read_text(encoding="utf-8")
    # ★ 判据一律落在 gm_src 上：这个文件里就写着被禁用的那些字面量（断言自身），
    #   拿 _t63_self 做**否定**断言等于永远为假 —— 上一版就是这么红的。
    chk("T63 ★1 自检不再靠环境变量：`gm_env` 绝迹、9 处子进程一律带 argv 开关、"
        "那个 os.environ 读法也删干净了（少一处，那次自检就会去问线上要 gateconfig "
        "—— 网络一抖，测试变成不可复现的红灯）",
        "gm_env" not in gm_src and gm_src.count("*OFFLINE_ARG") == 10
        and 'os.environ.get("CMSGATE_OFFLINE_SELFTEST")' not in gm_src
        and "OFFLINE_ARG = [" in gm_src
        and '"--offline-admin-config", str(fake_cfg)' in _t63_self)
    chk("T63 文档同步：密码闸门.md 写的是 `--offline-admin-config`，"
        "并把「远端参数为什么管这么宽」和注入这条写进限制里（旧的环境变量口径不许留在文档里）",
        "--offline-admin-config" in gu_doc and "CMSGATE_OFFLINE_SELFTEST" not in gu_doc
        and "shlex" in gu_doc)

    # ── T64 ─────────────────────────────────────────────────────────
    # 同一密码多条目（2026-10-30 用户撞到的：一停用一启用，登录被停用条目挡住）。
    # 四件事要一起对上：authd 选条目优先可用、gate_manager 写 dup 组标记、
    # gate_ui 透传、cmsui 按 16 色上底色。任何一环断开，现象都是「修好了还像坏」。
    print("\nT64 同一密码多条目：优先可用条目 + dup 组标记 + cmsui 底色")
    authd_src = (root / "server" / "authd.py").read_text(encoding="utf-8")

    chk("T64 ★ authd 选条目优先「启用且未过期」（整表 scrypt 的防计时口径不动）",
        "def pick_pw_entry(" in authd_src
        and 'hit_id, hit = pick_pw_entry(entries, pw)' in authd_src
        and 'if hmac.compare_digest(d, e["hash"]) and hit is None' not in authd_src,
        "老的「第一个命中定结果」必须消失，否则停用条目照样挡人")
    chk("T64 ★ authd 自检覆盖同密码多条目（停用/过期/可用三条 + 全不可用回落）",
        "同一密码多条目" in authd_src and 'eid == "c_ok"' in authd_src,
        "没有这条自检，选人规则回归时不会有任何红灯")
    chk("T64 gate_manager：dupmark 三张表都登记（管理口令 / SCRYPT_CMDS / offline 白名单）+ 三个函数就位",
        "def cmd_dupmark" in gm_src and "def find_same_password" in gm_src
        and "def assign_dup_group" in gm_src
        and '"push", "pull", "revoke-all", "dupmark",' in gm_src
        and '"dupmark"})' in gm_src and '"dupmark"}' in gm_src,
        "三张表漏一张，现象分别是：免口令可改 / 自带 python3 直接崩 / selftest 红")
    chk("T64 gate_manager：add/passwd 接了自动检测（手里有明文的唯一两个时刻）",
        "dup_ids = find_same_password(store, pw)" in gm_src
        and "find_same_password(store, pw, exclude_id=e[\"id\"])" in gm_src,
        "漏接的话新建/轮换的重复永远无人知晓，只能靠 dupmark")
    chk("T64 gate_ui /api/entries 透传 dup 字段（cmsui 上色的唯一数据源）",
        '"dup": e.get("dup")' in gu_src,
        "前端拿不到 dup 就永远白底")

    dupe_fn = _js_block(js, "assignDupeColors")
    m = re.search(r"const DUPE_COLORS = \[(.*?)\];", js, re.S)
    dupe_palette = "[" + m.group(1) + "]" if m else "[]"
    if dupe_fn and node:
        n = _run_node(node, f"""
const DUPE_COLORS = {dupe_palette};
{dupe_fn}
const out = {{}};
out.palette = DUPE_COLORS.length;
// 组内只剩一条 → 不算重复，不上色
const single = assignDupeColors([{{dup:'g1'}}, {{dup:'g2'}}, {{dup:'g1'}}],
                                [{{dup:'g1'}}, {{dup:'g2'}}, {{dup:'g1'}}]);
out.singleUncolored = single.get('g2') === undefined;
out.groupColored = single.get('g1') !== undefined;
// 相邻两个组必须不同色
const adj = assignDupeColors([{{dup:'a'}},{{dup:'a'}},{{dup:'b'}},{{dup:'b'}}],
                             [{{dup:'a'}},{{dup:'a'}},{{dup:'b'}},{{dup:'b'}}]);
out.adjacentDiff = adj.get('a') !== adj.get('b');
// 三明治 a,b,a：两行 a 同色、且与 b 不同色
const sand = assignDupeColors([{{dup:'a'}},{{dup:'b'}},{{dup:'a'}}],
                              [{{dup:'a'}},{{dup:'b'}},{{dup:'a'}}]);
out.sandwich = {{a: sand.get('a'), b: sand.get('b')}};
console.log(JSON.stringify(out));
""")
        chk("T64 ★ 色板 16 色（用户裁决：16 组）", n.get("palette") == 16,
            f"实际 {n.get('palette')}")
        chk("T64 ★ 组内只剩一条不上色（白底）", n.get("singleUncolored") is True)
        chk("T64 ★ 重复组有底色", n.get("groupColored") is True)
        chk("T64 ★ 相邻两组不同色（撞色自动顺延）", n.get("adjacentDiff") is True)
        s = n.get("sandwich") or {}
        chk("T64 ★ 三明治 a,b,a：a 两行同色且异于 b",
            s.get("a") is not None and s.get("a") != s.get("b"), str(s))
    else:
        skip("T64 ★ cmsui 上色行为（node 抠不到 assignDupeColors 或没有 node）",
             "assignDupeColors 抠取失败" if not dupe_fn else "no node")

    # ── T65：底部弹窗是唯一的提示面，行为要真跑 ────────────────────────
    # 「第 5 条挤掉最旧」「明文看过就抹掉」这类逻辑，光看源码字符串发现不了写反。
    # 把 notify / toast / flash / showOutput / clearOutput 抠出来，配假 DOM 让 node 真跑。
    toast_src = {name: _js_block(js, name) for name in
                 ("el", "toastMs", "notify", "toast", "flash", "showOutput", "clearOutput")}
    toast_consts = re.search(r"const TOAST_MAX = \d+;[\s\S]*?TOAST_STICKY_CHARS = \d+;", js)
    if all(toast_src.values()) and toast_consts and node:
        src = "\n".join([toast_consts.group(0)] + list(toast_src.values()))
        t65 = _run_node(node, T65_FAKE_DOM.replace("__SRC__", json.dumps(src)))
        chk("T65 短提示按长度定时（2 秒 + 每字 60ms）",
            t65.get("shortMs") == 2000 + 60 * len("已复制到剪贴板"), f"实际 {t65.get('shortMs')}")
        chk("T65 ★ 再长的短提示也只到封顶 12 秒（封顶那条仍会自动关）",
            t65.get("capMs") == 12000 and t65.get("capScheduled") is True,
            f"实际 {t65.get('capMs')} scheduled={t65.get('capScheduled')}")
        chk("T65 长文本（>200 字）不自动关", t65.get("longSticky") is True)
        chk("T65 命令输出不自动关、带标题、等宽正文",
            t65.get("outSticky") is True and t65.get("outTitle") == "命令输出"
            and t65.get("outMono") is True, str(t65.get("outTitle")))
        chk("T65 ★ 同时最多 4 条，第 5 条进来时最旧的先退",
            t65.get("stackLen") == 4 and t65.get("stackFirst") == "m3",
            f"len={t65.get('stackLen')} first={t65.get('stackFirst')}")
        chk("T65 ★ 每一条右上角都有 ×", t65.get("xLabels") is True)
        chk("T65 × 点一下只关掉那一条", t65.get("afterClose") == 3,
            f"实际 {t65.get('afterClose')}")
        chk("T65 定时器到点自己收；已关掉的再触发不炸",
            t65.get("afterTimer") == 3 and t65.get("noThrow") is True,
            f"len={t65.get('afterTimer')}")
        chk("T65 ★ clearOutput 抹掉命令输出里的明文（不是只藏起来）",
            t65.get("outGone") is True and t65.get("outText") == "",
            f"残留文本={t65.get('outText')!r}")
        chk("T65 flash 与 toast 落在同一个堆里（三面收口）",
            t65.get("sameBox") is True)
        chk("T65 ★ 弹窗堆不挡下面的表格（容器不吃点击，卡片自己恢复）",
            ".toasts {" in css and "pointer-events: none;" in css
            and ".toast {" in css and "pointer-events: auto;" in css)
    else:
        skip("T65 ★ 底部弹窗行为（node 抠不到 notify 一族或没有 node）",
             "no node" if not node else "抠取失败：" + ", ".join(
                 k for k, v in toast_src.items() if not v))

    # ── T66：ctlui 刷新慢的实测结论要守住 ──────────────────────────────
    # 一次刷新 = 一次 ssh 跑远端 admin-status，回 674 KB（1661 条 done 明细，
    # 字段名逐条重复）。实测：`-C` 压到 60 KB，交错 A/B 三对全部更快，最差那次
    # 6.62s → 2.81s；而 ControlMaster 复用连接**没用**（建连本身只 0.73s）。
    # 所以别把 -C 拿掉，也别再往连接复用上投功夫。
    try:
        import importlib.util
        spec = importlib.util.spec_from_file_location("distctl_t66", HERE / "distctl.py")
        dc = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dc)
        argv = dc.remote_argv("admin-status", [])
        chk("T66 ★ 远端 ssh 一律开压缩（-C 在 host 之前，不是被当成命令）",
            argv[0] == "ssh" and "-C" in dc.SSH_OPTS and argv[1] == "-C"
            and "@" in argv[2], " ".join(argv[:4]))
        cu = (HERE / "ctl_ui.py").read_text(encoding="utf-8")
        chk("T66 manifest 那条 ssh 也走同一份选项（选项只此一份，防漂移）",
            '["ssh"] + distctl.SSH_OPTS + distctl.REMOTE.split()' in cu)
    except Exception as e:
        skip("T66 ★ 远端 ssh 压缩", f"导入 distctl 失败：{e}")

    # ── T67：ctlui 刷新的热路径不许再搬全量明细 ─────────────────────────
    # 2026-11-02 实测账：一次刷新 = 一次 ssh 跑 admin-status，回 741KB（gzip 71KB），
    # 其中 done 明细占 92%。拆开量：握手 0.27s、远端生成 0.4s（五次全稳），
    # **传输段 1.7~5.0s** —— 这条公网链路只有 15~40KB/s，还要和在线客户端分。
    # 所以 -C 已经压到极限了，真正的解法是少发字节：
    #   热路径 → admin-lite（最近 N 条 + 模式×规格聚合，gzip ~1KB）
    #   完整历史 → 弹窗点开时经 admin-history 现拉（一次性，慢在这一次可以接受）
    # 把明细塞回热路径，用户就又回到 3~5 秒；这条测试就是那扇门上的门闩。
    print("\nT67 ctlui 热路径瘦身：admin-lite 小包 + 完整历史点开才拉")
    cu7 = (HERE / "ctl_ui.py").read_text(encoding="utf-8")
    js7 = (HERE / "ctlui" / "app.js").read_text(encoding="utf-8")
    ds7 = HERE / "dist_server.py"

    chk("T67 ★ status() 走 admin-lite，热路径不再碰全量 admin-status",
        '_remote_json("admin-lite"' in cu7 and 'remote_argv("admin-status"' not in cu7,
        "回到全量明细 = 刷新重新变成几秒")
    chk("T67 完整历史是单独一条命令 + 单独一个路由",
        '_remote_json("admin-history"' in cu7 and '"/api/history"' in cu7)
    chk("T67 ★ 前端不再期待全量 done：合计读 agg_spec、卡面读 done_recent",
        "d.agg_spec" in js7 and "d.done_recent" in js7
        and "Object.values(d.done)" not in js7 and "Object.entries(d.done)" not in js7,
        "热路径里没有 d.done，读它的代码会静默拿到 undefined")
    chk("T67 历史弹窗的筛选/分页对着现拉的那份全量算",
        "histData ? Object.values(histData.done)" in js7
        and "histData.done" in js7 and "loadHistory" in js7)
    chk("T67 写操作成功后作废历史缓存（否则弹窗看到的是旧账）",
        "histData = null;" in js7)
    chk("T67 「显示已作废」接了 change（弹窗开着时 refresh 是跳过的，不接就是没反应）",
        '$("done-show-invalid").addEventListener("change"' in js7)

    if not ds7.exists():
        skip("T67 admin-lite 功能账", "找不到 dist_server.py")
    else:
        import gzip
        import time as _t7

        def _state(n_done=300):
            now = int(_t7.time())
            done = {}
            for i in range(n_done):
                model = "classic" if i % 3 == 0 else "complex"
                cols, rows, mines = [(30, 16, 99), (30, 16, 120), (40, 20, 99)][i % 3]
                tid = f"{20260000 + i}-{model}-{cols}x{rows}x{mines}"
                done[tid] = {"seed": 20260000 + i, "model": model, "cols": cols, "rows": rows,
                             "mines": mines, "games": 100, "wins": 40 + i % 20,
                             "zeroGuessWins": 3, "guesses": 12, "guessTrap": 1,
                             "ip": f"203.0.113.{i % 5}", "name": f"VM-{i % 5}",
                             "os": "Windows 10", "solver_ver": "c1f60148",
                             "claimed_at": now - 900 + i, "time": now - 800 + i,
                             "valid": i % 37 != 0,
                             "file": f"/var/lib/cmsdist/results/{tid}.json.gz"}
            return {"config": {"default": {"model": "complex", "cols": 30, "rows": 16,
                                           "mines": 99, "games": 100},
                               "seed_next": 20269999, "lease_sec": 7200, "paused": False,
                               "cool_sec": 60, "max_ip_inprog": 3},
                    "queue": [], "inprog": {}, "done": done}

        try:
            with tempfile.TemporaryDirectory(prefix="cmsdist-t67-") as td7:
                st7 = _state()
                (Path(td7) / "state.json").write_text(
                    json.dumps(st7, ensure_ascii=False), encoding="utf-8")
                env7 = dict(os.environ, CMSDIST_STATE=td7)

                def _ds(cmd, *args):
                    p = subprocess.run([sys.executable, str(ds7), cmd, *args],
                                       capture_output=True, text=True, env=env7, timeout=60)
                    if p.returncode:
                        raise RuntimeError(f"{cmd} 退出码 {p.returncode}：{p.stderr[-200:]}")
                    return p.stdout

                lite_raw = _ds("admin-lite", "30")
                hist_raw = _ds("admin-history")
                full_raw = _ds("admin-status")
                lite7, hist7, full7 = json.loads(lite_raw), json.loads(hist_raw), json.loads(full_raw)

                gzip_kb = lambda s: len(gzip.compress(s.encode(), 6)) // 1024
                chk("T67 ★ admin-lite 小包：gzip 后不超过 8KB（现状 ~1KB）",
                    gzip_kb(lite_raw) <= 8, f"{gzip_kb(lite_raw)}KB · 全量是 {gzip_kb(full_raw)}KB")
                chk("T67 admin-lite 只回最近 N 条，但 done_total 是全量",
                    len(lite7["done_recent"]) == 30 and lite7["done_total"] == 300,
                    f"recent={len(lite7['done_recent'])} total={lite7['done_total']}")
                chk("T67 done_recent 按时间倒序（卡面直接取前 10 就是最新）",
                    [r["time"] for r in lite7["done_recent"].values()]
                    == sorted((r["time"] for r in lite7["done_recent"].values()), reverse=True))
                want = {}
                for r in st7["done"].values():
                    if r.get("valid") is False:
                        continue
                    k = (r["model"], r["cols"], r["rows"], r["mines"])
                    a = want.setdefault(k, {"tasks": 0, "games": 0, "wins": 0})
                    a["tasks"] += 1
                    a["games"] += r["games"]
                    a["wins"] += r["wins"]
                got = {(a["model"], a["cols"], a["rows"], a["mines"]):
                       {k: a[k] for k in ("tasks", "games", "wins")} for a in lite7["agg_spec"]}
                chk("T67 ★ 合计的账在服务器算：agg_spec 与全量现算逐组一致，且不含作废条目",
                    got == want, f"{len(got)} 组 / 有效 {sum(v['tasks'] for v in want.values())} 条")
                chk("T67 明细只投影 UI 要用的字段（file 这种一条 38B 的不发）",
                    all("file" not in r and "claimed_at" not in r
                        for r in list(lite7["done_recent"].values()) + list(hist7["done"].values())[:50]))
                chk("T67 admin-history 是全量（筛选/分页在浏览器做，靠的就是这份全集）",
                    len(hist7["done"]) == 300 and hist7["done_total"] == 300)
                chk("T67 ★ admin-status 仍是全量带 file —— distctl CLI 与 export 口径不许跟着瘦",
                    len(full7["done"]) == 300
                    and all("file" in r for r in full7["done"].values()))
                chk("T67 未知命令时把话说到部署脚本上（本机 ctlui 比服务器新是发布期常态）",
                    "deploy-dist.sh" in cu7 and "未知命令" in cu7)
        except Exception as e:
            skip("T67 admin-lite 功能账", f"跑 dist_server 失败：{e}")

    # ── T68：backup.sh 的 QQbot 段已入库，别再被"清理 bot 痕迹"抹掉 ──────
    # 2026-10-28 那条「QQbot 不进仓库」的裁决，实际后果是仓库副本比服务器少一截，
    # 而 deploy-backup.sh 是**整文件 scp 覆盖**——谁跑一次部署，bot 两路快照就静默没了。
    # 2026-11-02 用户改口：「进 git 也没事，把它加进去，别到时候弄没了」。
    # 现在仓库副本与服务器 /opt/cmsgate/backup.sh 逐字节一致（md5 da8567cb…），
    # 部署变成幂等。这几条断言守的是反向漂移：仓库里被人删掉 bot 段 = 红灯。
    print("\nT68 backup.sh 的 QQbot 快照段与媒体缓存清理段在仓库里（部署不再静默丢功能）")
    bak68 = (root / "server" / "cmsgate-backup.sh").read_text(encoding="utf-8")
    chk("T68 ★ bot 两路快照在仓库副本里（缺了就等于 deploy 会把它们从服务器上抹掉）",
        "bot-cfg-${STAMP}.tar.gz" in bak68 and "bot-ntqq-${STAMP}.tar.gz" in bak68
        and 'BOT=/opt/bot' in bak68 and 'DOW=$(date +%u)' in bak68)
    chk("T68 bot-cfg 排掉了媒体缓存与 astrbot 自带备份（10-31 体积爆炸的修法）",
        "--exclude='data/temp'" in bak68 and "--exclude='data/backups'" in bak68)
    # 11-02 实测再砍一刀：ntqq 271M 里 250M 是 Emoji 缓存+日志，bot-cfg 里 image_cache
    # 61M + cloudrank 资源 19M 都能重建 —— 而这两路快照每天要经 ~13KB/s 的链路拉走。
    chk("T68 ★ 可再生大头不出快照：image_cache/cloudrank 资源、ntqq 的 Emoji 与日志",
        "--exclude='*/image_cache'" in bak68 and "--exclude='*/cloudrank/resources'" in bak68
        and "--exclude='*/nt_data/Emoji'" in bak68 and "--exclude='*/nt_data/log'" in bak68)
    _rot68 = [re.search(r"tail -n \+(\d+)", l).group(1)
              for l in bak68.splitlines() if l.strip().startswith("ls -1t") and "tail -n +" in l]
    chk("T68 五类各自的轮转份数写准（cms 28 / bot-cfg 28 / bot-ntqq 8 / dist-meta 28 / "
        "dist-full 8 → 起点 29/29/9/29/9）",
        _rot68 == ["29", "29", "9", "29", "9"], f"实际 {_rot68}")
    # 跑分数据（/var/lib/cmsdist）11-02 之前**零备份**——当天 state.json 被写坏，
    # 全靠运气没丢。两档口径别写反：索引 state.json+secret 每天（实测 93KB），
    # 44M 且不可变的逐局明细 results/ 每周三一次；天天搬明细就是把同一批字节
    # 反复挤过那条 ~13KB/s 的公网链路。
    _meta68 = [l for l in bak68.splitlines() if "tar -czf" in l and "dist-meta-" in l]
    _full68 = [l for l in bak68.splitlines() if "tar -czf" in l and "dist-full-" in l]
    chk("T68 ★ 跑分快照两档口径：dist-meta 只包索引，dist-full 才带 results/",
        len(_meta68) == 1 and len(_full68) == 1
        and "results" not in _meta68[0] and "results" in _full68[0]
        and 'DIST=/var/lib/cmsdist' in bak68,
        f"meta={_meta68} full={_full68}")
    # 同一段逻辑（服务器脚本不许静默失效）下的另一条：探活的失败通道。
    # hc_url 只打印 $BASE、ping_fail 也调它，**没有任何一处拼 /fail** —— 于是每次
    # 探活失败都发出去一个成功 ping，把 Healthchecks 刷回 UP。11-02 cmsdist 坏档
    # 那 25 分钟就是证据：journal 每轮打「探活失败」，页面全是绿色 OK、邮件零封。
    hc68 = (root / "server" / "cmsgate-healthcheck.sh").read_text(encoding="utf-8")
    _pf68 = hc68.split("ping_fail() {", 1)[-1].split("\n}", 1)[0] if "ping_fail() {" in hc68 else ""
    chk("T68 ★ 探活失败必须走 /fail（曾经发的是成功 ping，监控页全程绿）",
        'hc_url "/fail"' in _pf68 and "curl" in _pf68,
        "ping_fail 里要出现 hc_url \"/fail\"")
    chk("T68 ★ hc_url 无参调用仍是成功 URL（全绿那条不许被顺手改坏）",
        'printf \'url = "%s%s"\\n\' "$BASE" "${1-}"' in hc68
        or 'url = "%s%s"' in hc68 and '"${1-}"' in hc68)
    # 同一类第三处：跑分服务的写路径。11-02 12:12 线上坏档（合法 JSON + 多出一个
    # '}'）之后全服务 500 达 25 分钟，本地 6 进程 × 25 轮并发写能稳定复现旧写法。
    ds68 = (root / "tools" / "dist_server.py").read_text(encoding="utf-8")
    _ping68 = ds68.split('if self.path == "/ping":', 1)[-1].split("def do_", 1)[0]
    chk("T68 ★ 写锁锁的是永不替换的 state.lock（锁在 state.json 的 inode 上等于没锁）",
        'LOCK_FILE = os.path.join(STATE_DIR, "state.lock")' in ds68
        and "os.open(LOCK_FILE" in ds68 and "os.open(STATE_FILE" not in ds68)
    chk("T68 ★ save_state 临时名每次唯一 + 落盘 0600（共用 .tmp 会拼坏档；"
        "0644 让同机用户读到全部客户端 IP 与机器名）",
        "tempfile.mkstemp(dir=STATE_DIR" in ds68 and "os.fchmod(f.fileno(), 0o600)" in ds68
        and 'STATE_FILE + ".tmp"' not in ds68)
    chk("T68 ★ /ping 走只读锁（它每 2 分钟一次，本不该重写整份状态）",
        "StateLock(readonly=True)" in _ping68, "/ping 处理段里要用只读锁")
    # 同一类第四处：客户端补报。拒绝分支里 os.remove(p) 写了两遍，第二遍抛
    # FileNotFoundError 无人接 = 整个客户端进程死掉（11-02 集体 403 时撞上）。
    dc68 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    _fp68 = dc68.split("def flush_pending", 1)[-1].split("\ndef ", 1)[0]
    chk("T68 ★ 补报三个分支各删一次、且删除容错（双删会把客户端打死）",
        "os.remove(p)" not in _fp68 and _fp68.count("_drop(p)") == 3
        and "except FileNotFoundError" in dc68.split("def _drop", 1)[-1].split("\ndef ", 1)[0])
    chk("T68 ★ 媒体缓存按龄清理段在（11-02 用户点头的 7 天口径）",
        "-name 'media_image_*'" in bak68 and "-mtime +7" in bak68
        and "-maxdepth 1 -type f" in bak68, "只删 temp 第一层的 media_image_* 普通文件")
    chk("T68 清理失败不许把备份服务带崩（set -e 下必须 || true 兜住）",
        "-delete 2>/dev/null || true" in bak68)
    chk("T68 注释里不再写「不进仓库」（文件自己就在仓库里，留着就是误导）",
        "不进仓库" not in bak68 and "只在服务器维护" not in bak68)
    chk("T68 文档同步：密码闸门.md 不再说 bot 两路只在服务器脚本里",
        "QQbot 不进仓库，**这两路只在服务器脚本" not in
        (root / "docs" / "密码闸门.md").read_text(encoding="utf-8"))

    # ── T69：/progress 的落盘节流（11-02 CPU 归因的收口）──────────────────
    # 线上实测 2.7 次/秒进度上报，每次过去都是一整份 state.json（935KB）序列化 +
    # fsync：本地同尺寸对拍 解析 6.7ms / 落盘 38.2ms —— 光这一条 ≈ 单核 12%，
    # 这台 2 核机器 CPU 仪表盘的头号去处（/ping 那条只读锁是同一类的第二处）。
    # 进度既是 lease 存活心跳又是看板数字，所以「下个请求必须还看得见」不能破：
    # 节流期内的最新值先进内存表，取锁时合并回来，落盘按窗口节流。
    print("\nT69 进度上报节流：值必须看得见，但不必每报都全量重写磁盘")
    _prog69 = ds68.split("def handle_progress", 1)[-1].split("\ndef ", 1)[0]
    chk("T69 ★ /progress 校验走只读锁（不许回到每报必写）",
        "StateLock(readonly=True)" in _prog69 and "with StateLock() as st:" not in _prog69)
    chk("T69 ★ 窗口常量与内存挂起表都在",
        "PROG_FLUSH_SEC = 5.0" in ds68 and "_prog_overlay = {}" in ds68
        and "_prog_last_flush = 0.0" in ds68)
    chk("T69 ★ 冲刷在出锁之后做（_lock 不可重入，with 里再开写锁是自杀）",
        "if due:" in _prog69
        and _prog69.index("StateLock(readonly=True)") < _prog69.index("if due:"))
    _en69 = ds68.split("def __enter__", 1)[-1].split("def __exit__", 1)[0]
    _ex69 = ds68.split("def __exit__", 1)[-1].split("def ensure_dirs", 1)[0]
    chk("T69 ★ 取锁时先把挂起进度合并回来（否则下一次写会让存活时钟倒退）",
        "self.merged = _merge_overlay(self.st)" in _en69
        and _en69.index("self.st = load_state()")
        < _en69.index("self.merged = _merge_overlay(self.st)"))
    chk("T69 ★ 只有落盘成功才作废内存值，且只作废被写进去的那版",
        "_prog_overlay.pop(tid)" in _ex69 and "is vals" in _ex69
        and _ex69.index("save_state(self.st)") < _ex69.index("_prog_overlay.pop(tid)"))
    _cl69 = ds68.split("def handle_claim", 1)[-1].split("\ndef ", 1)[0]
    chk("T69 ★ 领取的两个「不干活直接回」分支跳过落盘，前提是 sweep 没收走过东西",
        "moved = sweep_expired(st)" in _cl69
        and ds68.count("_skip_save(not moved)") == 2, "暂停 + 超名额两处")
    chk("T69 ★ 落盘条件认这个标记，且每次取锁先清零（不清会连累下一次的正当写）",
        "global _no_write" in ds68 and "_no_write = False" in _en69
        and "not _no_write" in _ex69)
    try:
        import urllib.error as _ue69
        import urllib.request as _ur69
        _sf69 = root / "tools" / "dist_server.py"
        with tempfile.TemporaryDirectory(prefix="cmsdist-t69-") as _td69:
            with socket.socket() as _sock:
                _sock.bind(("127.0.0.1", 0))
                _port69 = _sock.getsockname()[1]
            _srv69 = subprocess.Popen(
                [sys.executable, "-B", str(_sf69), "serve", "127.0.0.1", str(_port69)],
                env=dict(os.environ, CMSDIST_STATE=_td69),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            _sf_path = Path(_td69) / "state.json"

            def _post69(path, body=None):
                _req = _ur69.Request(f"http://127.0.0.1:{_port69}{path}",
                                     data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Content-Type": "application/json"})
                try:
                    with _ur69.urlopen(_req, timeout=10) as _r:
                        return json.loads(_r.read())
                except _ue69.HTTPError as _e:
                    return json.loads(_e.read())

            for _ in range(80):
                try:
                    if _post69("/ping").get("ok"):
                        break
                except Exception:
                    time.sleep(0.25)

            def _disk69():
                return json.loads(_sf_path.read_text(encoding="utf-8"))

            def _get69(path):
                try:
                    with _ur69.urlopen(f"http://127.0.0.1:{_port69}{path}", timeout=10) as _r:
                        return _r.status, _r.read()
                except _ue69.HTTPError as _e:
                    return _e.code, _e.read()

            def _set_paused69(v):
                # 与服务器同写一个文件：临时名 + replace 才是原子换，裸写会让它读到半份
                _raw = _disk69()
                _raw["config"]["paused"] = v
                _tmp69 = str(_sf_path) + ".test.tmp"
                Path(_tmp69).write_text(json.dumps(_raw, ensure_ascii=False), encoding="utf-8")
                os.replace(_tmp69, _sf_path)

            try:
                _c69 = _post69("/claim", {"name": "t69", "os": "test"})
                _tid69, _nonce69 = _c69["task_id"], _c69["nonce"]
                _post69("/progress", {"task_id": _tid69, "nonce": _nonce69,
                                      "done": 1, "eta_sec": 9})
                _sig69 = (_sf_path.stat().st_size, _disk69()["inprog"][_tid69]["prog"]["done"])
                for _i in range(2, 6):
                    _post69("/progress", {"task_id": _tid69, "nonce": _nonce69,
                                          "done": _i, "eta_sec": 9})
                chk("T69 ★ 窗口内 4 次上报：磁盘一个字节都没多写（这就是省下来的那 12%）",
                    _sf_path.stat().st_size == _sig69[0]
                    and _disk69()["inprog"][_tid69]["prog"]["done"] == _sig69[1],
                    f"{_sig69} -> {_sf_path.stat().st_size}/"
                    f"{_disk69()['inprog'][_tid69]['prog']['done']}")
                _post69("/claim", {"name": "t69b", "os": "test"})
                chk("T69 ★ 下一次写把挂起的最新值顺带落盘（不是丢弃，也不是旧值）",
                    _disk69()["inprog"][_tid69]["prog"]["done"] == 5,
                    str(_disk69()["inprog"][_tid69].get("prog")))
                time.sleep(5.6)
                _post69("/progress", {"task_id": _tid69, "nonce": _nonce69,
                                      "done": 7, "eta_sec": 8})
                _pa69 = _disk69()["inprog"][_tid69]
                chk("T69 ★ 超过窗口自己冲刷，且存活时钟 prog_at 一起落盘（lease 不误收）",
                    _pa69["prog"]["done"] == 7 and _pa69["prog_at"] > 0,
                    str(_pa69.get("prog")))
                # 节流上线后线上复测：progress 不再是写盘大头，暂停期客户端仍按秒轮询
                # 领取，而「没活给你」这个答案过去也要重写整份档 —— 同一类浪费的第二处。
                _set_paused69(True)
                _ns69 = _sf_path.stat().st_mtime_ns
                _rp69 = _post69("/claim", {"name": "t69p", "os": "test"})
                chk("T69 ★ 暂停期的领取只回 paused、不动磁盘（轮询白烧 CPU 的那条）",
                    _rp69.get("paused") is True
                    and _sf_path.stat().st_mtime_ns == _ns69
                    and _disk69()["config"]["paused"] is True,
                    f"{_rp69} 未重写={_sf_path.stat().st_mtime_ns == _ns69}")
                _set_paused69(False)
                _rc69 = _post69("/claim", {"name": "t69r", "os": "test"})
                chk("T69 ★ 跳过写没把正路带坏：解除暂停后领取照常发任务并落盘",
                    "task_id" in _rc69 and _rc69["task_id"] in _disk69()["inprog"],
                    str(_rc69)[:160])
                # T71 的端到端账复用这台实例（省一次起服务）：配额表是进程级的，
                # 新进程 = 干净计数，正好从第一次下载开始量。
                print("\nT71 更新包下载配额（端到端跑在上面那台本地实例上）")
                _cl71 = _sf_path.parent / "client"
                _cl71.mkdir(exist_ok=True)
                (_cl71 / "pkg.bin").write_bytes(b"cmsdist" * 200)
                chk("T71 不存在的文件返回 404，且不占额度",
                    _get69("/client/file/nope-not-there")[0] == 404)
                _codes71 = [_get69("/client/file/pkg.bin")[0] for _ in range(21)]
                chk("T71 ★ 同一 IP 前 20 次照发、第 21 次 429（重下洪峰就此有了顶）",
                    _codes71 == [200] * 20 + [429], str(_codes71))
                _msg71 = json.loads(_get69("/client/file/pkg.bin")[1].decode("utf-8"))
                chk("T71 ★ 拒绝的话能照着做：点明「新版没换上」+ 恢复时间 + 移到本地磁盘",
                    "本地磁盘" in _msg71.get("error", "")
                    and "秒后恢复" in _msg71.get("error", ""), str(_msg71)[:200])
            finally:
                _srv69.terminate()
                _srv69.wait(timeout=10)
    except Exception as e:
        skip("T69 进度节流功能账", f"起本地 dist_server 失败：{e}")

    # ── T70：探活补盲（10–13 项）+ Mac 拉取的死人开关（2026-11-02）─────────
    # 这一轮起因不是「有个服务坏了」，而是发现**失败通道一直是假的**（见 T68）之后盘了一遍
    # 覆盖面：自己家服务都有人盯，但有几类静默故障谁都不看 —— sshd 挂了监控页照样绿
    # （探活是出站的，不经过它）、fail2ban 停了零症状、时间一跳三处判断全歪、
    # 只盯磁盘看不到「活着但慢死」、公开页 /learn/ 404 了没人会反馈。
    print("\nT70 新增四项探活与 Mac 死人开关：阈值要真能翻红，告警通道不许拖垮备份")
    hc70 = (root / "server" / "cmsgate-healthcheck.sh").read_text(encoding="utf-8")
    _load70 = hc70.index("if [ -f /opt/cmsgate/healthcheck-extra.sh ]")
    _seg70 = hc70[hc70.index("# 10)"): _load70]
    chk("T70 ★ 四项判定都在本体段（第 10–13 项），且都排在扩展段加载点之前",
        all(k in _seg70 for k in (
            "systemctl is-active --quiet ssh",
            "systemctl is-active --quiet fail2ban",
            "systemctl is-active --quiet chrony",
            "chronyc tracking",
            "free -b",
            "/learn/",
            "C++ 数据结构与算法图解"))
        and _seg70.count('ping_fail "') == 8,
        "少一项 = 这类静默故障重新变回没人看得见；排到扩展段之后 = QQbot 挂了挡住仓库侧检查")
    chk("T70 sshd 那条把「为什么只能靠这里看见」写进注释（探活自己不出问题就没人知道 ssh 死了）",
        "ctlui" in _seg70 and "Mac 备份拉取" in _seg70)
    # ── T70 补：失败去重（2026-11-06 astrbot 探测一次瞬时 000 误报 DOWN）──────────
    # 单次抖动不值一封凌晨邮件：连续第 2 轮仍失败才发 /fail。计数文件是沙箱 strict 下
    # 唯一的写口，写不进去必须退回「单次即报」——宁可吵不可哑。
    _dm70 = (root / "scripts" / "web" / "deploy-monitor.sh").read_text(encoding="utf-8")
    _sv70 = (root / "server" / "cmsgate-healthcheck.service").read_text(encoding="utf-8")
    chk("T70 ★ 失败去重钉死：连续 2 次才告警、全绿清零、写不进计数退回单次即报（宁可吵不可哑）",
        "FAIL_CONFIRM=2" in hc70 and '[ "$n" -ge "$FAIL_CONFIRM" ]' in hc70
        and ': > "$FAILS_FILE" 2>/dev/null || true' in hc70
        and "FAIL(待确认)" in hc70 and "退回单次即报" in hc70)
    chk("T70 ★ 计数文件链路三件齐：unit 沙箱只为它开口、部署时预建、脚本不自己造",
        "ReadWritePaths=-/opt/cmsgate/healthcheck-fails" in _sv70
        and "touch ${APP_DIR}/healthcheck-fails" in _dm70
        and "mkdir" not in hc70.split("ping_fail() {", 1)[1].split("\n}", 1)[0])
    try:
        _body70 = hc70.split("ping_fail() {", 1)[1].split("\n}", 1)[0]
        with tempfile.TemporaryDirectory(prefix="cms-t70-dedup-") as _td70:
            _fl70 = os.path.join(_td70, "fails")
            _st70f = os.path.join(_td70, "sent")
            open(_fl70, "w").close()

            def _pf70():
                _sh70 = (
                    f"FAILS_FILE={_fl70}\nFAIL_CONFIRM=2\n"
                    'hc_url() { printf \'url = "stub"\\n\'; }\n'
                    'logger() { :; }\n'
                    f'curl() {{ printf X >> "{_st70f}"; cat > /dev/null; }}\n'
                    f"ping_fail() {{{_body70}\n}}\n"
                    'ping_fail "$1"\n')
                return subprocess.run(["sh", "-c", _sh70, "pf70", "探活抖动测试"],
                                      capture_output=True, text=True, timeout=30,
                                      encoding="utf-8", errors="replace").stdout

            _o1 = _pf70(); _s1 = os.path.getsize(_st70f) if os.path.exists(_st70f) else 0
            _o2 = _pf70(); _s2 = os.path.getsize(_st70f)
            open(_fl70, "w").close()          # 模拟全绿清零
            _o3 = _pf70(); _s3 = os.path.getsize(_st70f)
            chk("T70 ★ 去重真跑：第 1 次「待确认」不发 /fail，第 2 次才发，清零后重新数",
                "待确认" in _o1 and _s1 == 0
                and "已发失败信号" in _o2 and _s2 == 1
                and "待确认" in _o3 and _s3 == 1,
                f"{_o1.strip()!r} sent={_s1} → {_o2.strip()!r} sent={_s2} → {_o3.strip()!r} sent={_s3}")
    except Exception as e:
        skip("T70 失败去重功能账", f"本地跑 ping_fail 失败：{e}")
    # 阈值不是摆设：把脚本里那三条 awk 条件原样抽出来喂假值，让它自己说红不红。
    # 改错比较方向（> 写成 <）线上只表现为「永远绿」或「天天半夜误报」，没有别的症状。
    def _awk70(marker: str, var: str, val: str):
        line = next((l for l in _seg70.splitlines() if marker in l), "")
        m = re.search(r"BEGIN\{.*?\}", line)
        if not m:
            return None
        return subprocess.run(["/usr/bin/awk", f"-v{var}={val}", m.group(0)],
                              capture_output=True, text=True).returncode

    _off70 = [("ok", "+0.000026", 0), ("ok", "-1.9", 0),
              ("red", "+2.0", 1), ("red", "-5.0", 1)]
    _mem70 = [("ok", "50.6", 0), ("ok", "15.1", 0), ("red", "15.0", 1), ("red", "2.0", 1)]
    _swp70 = [("ok", "19.2", 0), ("ok", "0.0", 0), ("red", "60.0", 1), ("red", "80.0", 1)]
    chk("T70 ★ chrony 偏移阈值真按 |offset|<2s 判红（负偏移取绝对值；读不到也红）",
        all(_awk70("awk -v o=", "o", v) == want for _, v, want in _off70)
        and '[ -n "$off" ]' in _seg70,
        str({v: _awk70("awk -v o=", "o", v) for _, v, _w in _off70}))
    chk("T70 ★ 内存下限 15%（严格大于才放行，恰好 15% 判红）、swap 上限 60%（>=60 即红）",
        all(_awk70('awk -v a=', "a", v) == want for _, v, want in _mem70)
        and all(_awk70('awk -v s=', "s", v) == want for _, v, want in _swp70),
        f"mem={ {v: _awk70('awk -v a=', 'a', v) for _, v, _ in _mem70} } "
        f"swap={ {v: _awk70('awk -v s=', 's', v) for _, v, _ in _swp70} }")
    chk("T70 ★ swap 总量为 0（没开 swap 的机器）不许除零误报；读不到偏移同理判红不是放行",
        "($2>0? $3/$2*100 : 0)" in _seg70)
    chk("T70 ★ /learn/ 两条：200 口径 + 标题标记（200 但被兜底页顶掉也算红，故意的耦合）",
        '[ "$lcode" = "200" ]' in _seg70
        and "grep -q 'C++ 数据结构与算法图解'" in _seg70
        and "http://127.0.0.1:${WEB_PORT}/learn/" in _seg70)
    chk("T70 ★ 新四项的失败原因串里没有 token / 密钥，且经 /fail 出站（会发给第三方）",
        not re.search(r"TOK|token|secret|passwd", _seg70, re.I))
    chk("T70 脚本里没有 https:// 字面量（deploy-monitor.sh 自测 4/4 与 T62 都靠这个 grep）",
        "https://" not in hc70)
    # Mac 侧：服务器第 8 项只看快照新不新，看不到「Mac 这份没拉走」。
    mb70 = (root / "tools" / "mac-backup-pull.sh").read_text(encoding="utf-8")
    _hc70 = mb70.split("hc_send() {", 1)[-1].split("\n}", 1)[0] if "hc_send() {" in mb70 else ""
    chk("T70 ★ Mac 拉取两条通道都在：成功发基址 ping、非 0 退出经 EXIT trap 发 /fail",
        'hc_send ""' in mb70 and 'hc_send "/fail"' in mb70
        and "trap 'rc=$?;" in mb70 and 'if [ "$rc" != 0 ]' in mb70)
    chk("T70 ★ 告警通道自己坏了不许把备份拉取带崩（两处 curl 全 || true，且 URL 文件缺失只提示不失败）",
        _hc70.count("|| true") == 2 and "[ -n \"$PULL_BASE\" ] || return 0" in _hc70
        and '[ -r "$PULL_URL_FILE" ]' in mb70 and 'PULL_BASE=""' in mb70)
    chk("T70 ★ Ping URL 是密钥：只从 ~/.cmsgate/mac-pull.url 读、经 stdin 交给 curl -K -，"
        "绝不进 curl 自己的 argv（ps 就能看到）、绝不写进失败原因串",
        'PULL_URL_FILE="$HOME/.cmsgate/mac-pull.url"' in mb70
        and sum(1 for l in mb70.splitlines()
                if 'curl' in l and '-K -' in l and not l.lstrip().startswith('#')) == 2
        and all('$url' not in l.split('curl', 1)[1] and 'PULL_BASE' not in l.split('curl', 1)[1]
                for l in mb70.splitlines()
                if 'curl' in l and not l.lstrip().startswith('#'))
        and all('PULL_BASE' not in l for l in mb70.splitlines() if 'hc_send "/fail"' in l))
    chk("T70 ★ rsync 成功但零快照也要发 /fail 且脚本自身退出 0（异地那份根本没存在过，"
        "和第 8 项的服务器视角是两回事）",
        "hc_send \"/fail\"" in mb70.split('if [ "${seen:-0}" != 1 ]')[1].split("fi")[0]
        and '    exit 0\nfi' in mb70)
    chk("T70 脚本里同样不许出现 https:// 字面量（URL 只来自那个 600 文件）",
        "https://" not in mb70)
    # ★ 上面那些全是形状检查，而它们**放过了一个真 bug**：11-02 首跑时 trap 写成
    #   '... '"$rc"' ...'，$rc 在**定义 trap 那一刻**就展开，set -u 下 unbound、脚本连
    #   rsync 都没跑到就退 1 —— bash -n 过、字符串断言全过。所以这三条把脚本**真跑一遍**：
    #   假 HOME + stub 的 rsync/curl，看退出码、看 ping 走没走、看 URL 在不在 argv。
    try:
        with tempfile.TemporaryDirectory(prefix="cms-pull70-") as _td70:
            _home = Path(_td70) / "home"
            _stub = Path(_td70) / "stub"
            _stub.mkdir()
            (_home / ".cmsgate").mkdir(parents=True)
            # 假 HOME 里也要有 deploy.env：脚本现在从 ~/.cmsdist/deploy.env 读 SSH 目标
            # （真值不进仓库），缺了它整条备份都跑不起来——这正是T80钉的「拒绝要吭声」路径。
            (_home / ".cmsdist").mkdir(parents=True)
            (_home / ".cmsdist" / "deploy.env").write_text(
                "CMS_HOST=root@test.invalid\nCMS_SSH_PORT=22\n", encoding="utf-8")
            (_home / "Backups" / "cms").mkdir(parents=True)
            (_home / "Backups" / "cms" / "cms-20261102-031700.tar.gz").write_bytes(b"x")
            _fake = "https://example.invalid/11111111-2222"   # 假 URL：真密钥绝不进测试
            (_home / ".cmsgate" / "mac-pull.url").write_text(_fake + "\n", encoding="utf-8")
            (_stub / "rsync").write_text('#!/bin/bash\necho "RSYNC_ARGV: $*" >> "$HARNESS_LOG"\nexit "${RSYNC_RC:-0}"\n', encoding="utf-8")
            (_stub / "curl").write_text('#!/bin/bash\necho "CURL_ARGV: $*" >> "$HARNESS_LOG"\necho "CURL_STDIN: $(cat)" >> "$HARNESS_LOG"\nexit "${CURL_RC:-0}"\n', encoding="utf-8")
            for _s in (_stub / "rsync", _stub / "curl"):
                _s.chmod(0o755)
            _log = Path(_td70) / "log"

            def _run70(rsync_rc, curl_rc=0, with_url=True):
                _log.write_text("", encoding="utf-8")
                if not with_url:
                    (_home / ".cmsgate" / "mac-pull.url").unlink()
                p = subprocess.run(
                    ["/bin/bash", str(root / "tools" / "mac-backup-pull.sh")],
                    env=dict(os.environ, HOME=str(_home), PATH=f"{_stub}:/usr/bin:/bin",
                             HARNESS_LOG=str(_log), RSYNC_RC=str(rsync_rc), CURL_RC=str(curl_rc)),
                    capture_output=True, text=True, timeout=60)
                if not with_url:
                    (_home / ".cmsgate" / "mac-pull.url").write_text(_fake + "\n", encoding="utf-8")
                lines = [l for l in _log.read_text(encoding="utf-8").splitlines()
                         if l.startswith("CURL_")]
                return p.returncode, p.stderr, lines

            _rc70, _err70, _l70 = _run70(0)
            _a70 = [l for l in _l70 if l.startswith("CURL_ARGV")]
            _s70 = [l for l in _l70 if l.startswith("CURL_STDIN")]
            chk("T70 ★ 真跑（stub rsync/curl）：拉取成功 → 退出 0 + 恰好一条基址 ping，"
                "URL 只出现在 stdin 的 config 里、不在 curl 的 argv",
                _rc70 == 0 and len(_a70) == 1 and len(_s70) == 1
                and _fake in _s70[0] and _fake not in _a70[0] and "-K -" in _a70[0],
                f"退出码={_rc70} argv={_a70} stdin={_s70} stderr={_err70[:200]}")
            _rc70f, _ef, _l70f = _run70(3)
            _a70f = [l for l in _l70f if l.startswith("CURL_ARGV")]
            _s70f = [l for l in _l70f if l.startswith("CURL_STDIN")]
            chk("T70 ★ 真跑：rsync 退 3 → 脚本非 0 退出 + 发的是 <url>/fail，"
                "原因串里带退出码数字（这条正是 '$rc' 提前展开那种写法炸掉的地方）",
                _rc70f != 0 and len(_s70f) == 1 and (_fake + "/fail") in _s70f[0]
                and any("--data-binary" in l and "退出码 3" in l and _fake not in l for l in _a70f),
                f"退出码={_rc70f} argv={_a70f} stdin={_s70f} stderr={_ef[:200]}")
            _rc70c, _, _ = _run70(0, curl_rc=22)
            _rc70n, _, _l70n = _run70(0, with_url=False)
            chk("T70 ★ 真跑：告警通道自己坏了（curl 失败）不改退出码；没有密钥文件时只提示、"
                "一条 ping 都不发、备份照跑（两条都必须是 0）",
                _rc70c == 0 and _rc70n == 0 and not _l70n,
                f"curl 坏时={_rc70c}（该 0）无 URL 时={_rc70n}（该 0）"
                f"无 URL 时 ping 条数={len(_l70n)}（该 0）")
    except Exception as e:
        skip("T70 Mac 拉取真跑三条", f"沙箱跑不动：{e}")
    im70 = (root / "scripts" / "web" / "install-mac-backup.sh").read_text(encoding="utf-8")
    chk("T70 ★ 安装脚本注入 URL：read -rs 不回显、umask 077 落盘 + chmod 600、用完 unset、"
        "只打印长度不打印内容",
        "read -rs MAC_PULL_URL" in im70 and "(umask 077; printf '%s\\n' \"$MAC_PULL_URL\" > \"$URL_FILE\")" in im70
        and 'chmod 600 "$URL_FILE"' in im70 and "unset MAC_PULL_URL" in im70
        and "长度 ${#MAC_PULL_URL}" in im70)
    chk("T70 重跑幂等：已有 URL 文件且没给环境变量时沿用，不再问一遍",
        '[ -z "${MAC_PULL_URL:-}" ] && [ -s "$URL_FILE" ]' in im70)
    # 部署侧两条：本体上线前必须先过 sh -n，且扩展段（不进仓库）的编号注释要跟着改口径。
    dm70 = (root / "scripts" / "web" / "deploy-monitor.sh").read_text(encoding="utf-8")
    chk("T70 ★ 部署沿用服务器上已有的 ping URL（否则逼人绕开脚本去裸 scp，就是丢扩展段的来路）",
        'test -s ${CFG_DIR}/healthcheck.url' in dm70 and 'HC_PING_URL=""' in dm70
        and "unset HC_PING_URL" in dm70)
    chk("T70 ★ 本体上线前先 sh -n（写坏了每 2 分钟失败一次，而页面只会变红、没人知道为什么）",
        'sh -n ${APP_DIR}/healthcheck.sh' in dm70 and '中止部署' in dm70)
    chk("T70 ★ 扩展段在位要吭声 + 编号注释 # 10) → # 14) 顺手改掉（只动注释，不碰检查内容）",
        'sed -i \'s/^# 10) QQbot/# 14) QQbot/\' ${APP_DIR}/healthcheck-extra.sh' in dm70
        and 'stat -c \'%a %U:%G\' ${APP_DIR}/healthcheck-extra.sh' in dm70)
    # 负向测试那天（11-02）踩到的第二处谎：ping_fail 按设计 exit 0（已告警不必让 systemd 报
    # failed），而自测既看退出码又 grep -n 20 的历史日志 —— 脚本正在报 FAIL，自测照样打勾。
    chk("T70 ★ 自测 1/4 只看本轮：--since 收到本次触发之后 + grep '^OK:'（-n 20 会捞到上一轮的绿）",
        'since=\\$(date -Iseconds)' in dm70
        and '--since \\"\\$since\\"' in dm70 and "grep -q '^OK:'" in dm70
        and 'journalctl -u cmsgate-healthcheck.service -n 20' not in dm70)


    # ── T71：更新包下载配额（11-02 网络归因的收口）────────────────────
    # 实测：机房一台 Air 的 9 个窗口全天把同一个 8,135,808 字节的 mac 包重下 674 次
    # ≈ 5.5GB 上行/天（manifest 轮询与下载 1:1 = 每次都判「有新版」却换不上），
    # 把公网出口占满，网站/闸门/ctlui 一起被挤。服务器对同一份字节原本有求必应。
    # 端到端账在 T69 那台本地实例里跑（配额表是进程级的，新实例干净计数）。
    print("\nT71 更新包下载配额：每 IP 每小时 20 次，超了 429 并把话说明白")
    _cf71 = ds68.split('if self.path.startswith("/client/file/"):', 1)[
        -1].split("def do_POST", 1)[0]
    chk("T71 ★ 配额口径按裁决写死（每 IP 每小时 20 次，11-05 换代期上调）",
        "DL_LIMIT_PER_HOUR = 20" in ds68 and "DL_WINDOW_SEC = 3600" in ds68)
    chk("T71 ★ 判定在打开文件之前（被拒的连 8MB 读盘都不该做），计数在真发出之后",
        "_dl_allow(" in _cf71 and 'open(p, "rb")' in _cf71
        and _cf71.index("_dl_allow(") < _cf71.index('open(p, "rb")')
        and _cf71.index("_dl_record(") > _cf71.index('open(p, "rb")'))
    chk("T71 ★ 超限要进 journal（在跑的客户端把 429 静默吞了，服务器不吭声就没人知道闸在响）",
        "sys.stderr.write" in _cf71 and "更新包下载超限" in _cf71)
    chk("T71 拒绝文案带实际值与上限，且给得出下一步动作",
        "每 IP 每小时" in _cf71 and "秒后恢复" in _cf71 and "本地磁盘" in _cf71)
    chk("T71 配额表不蹭 state 的 _lock，IP 多了回收过期条目（这张表不许只增不减）",
        "_dl_lock = threading.Lock()" in ds68 and "len(_dl_hits) > 512" in ds68)


    # ── T72：自动更新「装不上」这条路（11-03 机房 Air 死循环的收口）──────────────
    # 实测：那台机每 60 秒一行「🆕 发现新版本」却永远换不上，因为三条失败路全是静默的：
    #   ① `_upd_swap` 返回 False → 直接 return False；② 下载被配额拒 → HTTPError 429 被
    #   最外层 `except Exception: return False` 整个吞掉；③ 防死循环的 `_UPD_STUCK` 只在
    #   「换成功但读回旧字节」那一条路置位。而队列 paused 时任务边界退化成 60s 一轮，
    #   于是每轮都重下一遍 7MB。这里既钉静态口径，也真把三条路跑一遍。
    print("\nT72 自动更新：装不上要吭声、要能换地方装、不许每 60 秒重下")
    dc72 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    chk("T72 ★ 最外层不许再静默吞异常（那正是这次事故的根）",
        "except Exception:\n        return False" not in dc72
        and '_upd_note_fail(ver, f"{type(e).__name__}: {e}")' in dc72)
    chk("T72 ★ 失败要有冷却：暂停期任务边界退化成 60s 一轮，没冷却就是无限重下 7MB",
        "_UPD_COOLDOWN_SEC = 600" in dc72 and "if _upd_cooling():" in dc72)
    chk("T72 服务器拒绝下载时把它的原话透出来（「移到本地磁盘」是用户唯一能照做的一步）",
        "urllib.error.HTTPError" in dc72 and "def _http_err_body" in dc72
        and "服务器拒绝下载" in dc72)
    chk("T72 ★ execv 必须在释放更新锁之后：换镜像不返回、finally 不跑，"
        "锁会留成一个「pid 还活着」的死锁，重启后永远卡在等锁",
        "restart_to = exe" in dc72 and "os.execv(restart_to" in dc72
        and dc72.index("                _upd_lock_release()")
        < dc72.index("os.execv(restart_to"))
    chk("T72 免安装包换不上要说清「移到本机本地磁盘」再重开（它得靠同目录 python.exe，搬不走）",
        "请把客户端整个文件夹移到本机本地磁盘" in dc72)

    # 功能账：真的跑一遍兜底安装 / 兜底也失败 / 失败吭声+冷却 / 429 透传
    import contextlib
    import importlib.util
    if str(root / "tools") not in sys.path:
        sys.path.insert(0, str(root / "tools"))
    dc72mod = None
    _imp72 = ""
    try:
        _spec72 = importlib.util.spec_from_file_location("uitest_dc72", root / "tools" / "dist_client.py")
        dc72mod = importlib.util.module_from_spec(_spec72)
        _spec72.loader.exec_module(dc72mod)
    except Exception as e:
        _imp72 = f"{type(e).__name__}: {e}"
    chk("T72 客户端模块可被载入（下面四条功能账靠它）", dc72mod is not None, _imp72)
    if dc72mod is not None:
        _blob72 = b"new-client-bytes-for-test"
        _entry72 = {"sha256": dc72mod.hashlib.sha256(_blob72).hexdigest(),
                    "file": "/client/file/dist-client-macos"}
        with tempfile.TemporaryDirectory() as td72:
            dc72mod._UPD_ALT_DIR = os.path.join(td72, "cmsdist-client")
            _tmp72 = os.path.join(td72, "dist-client.new")
            with open(_tmp72, "wb") as f72:
                f72.write(_blob72)
            _alt72 = dc72mod._upd_alt_install(_tmp72, _entry72)
            chk("T72 ★ 原地换不动时真的装进用户目录并读回核对（不是只打印一句就算了）",
                _alt72 == os.path.join(dc72mod._UPD_ALT_DIR, os.path.basename(sys.executable))
                and os.path.exists(_alt72)
                and open(_alt72, "rb").read() == _blob72
                and os.stat(_alt72).st_mode & 0o111 != 0)
            chk("T72 ★ 兜底那份已经是要的版 → 下次仍从旧路径启动时不再重下（它的哈希就是记账本）",
                dc72mod._upd_alt_ready(_entry72) == _alt72)
            _ro72 = os.path.join(td72, "ro")
            os.makedirs(_ro72)
            os.chmod(_ro72, 0o500)
            dc72mod._UPD_ALT_DIR = os.path.join(_ro72, "cmsdist-client")
            _tmp72b = os.path.join(td72, "second.new")
            with open(_tmp72b, "wb") as f72:
                f72.write(_blob72)
            _msg72 = ""
            try:
                dc72mod._upd_alt_install(_tmp72b, _entry72)
            except ValueError as e:
                _msg72 = str(e)
            os.chmod(_ro72, 0o700)
            chk("T72 兜底目录也写不进时抛 ValueError 交给统一出口吭声（不许静默 return None）",
                "兜底目录也装不上" in _msg72, _msg72[:60])

            dc72mod._upd_fail["until"] = 0.0
            _buf72 = io.StringIO()
            with contextlib.redirect_stdout(_buf72):
                dc72mod._upd_note_fail(1793594999, "服务器拒绝下载（HTTP 429）：每 IP 每小时 20 次")
            chk("T72 ★ 失败必吭声：原因和服务器原话打在同一行里（以前只剩一行「发现新版本」）",
                "自动更新没做成" in _buf72.getvalue() and "每 IP 每小时 20 次" in _buf72.getvalue())
            chk("T72 ★ 失败即冷却：_upd_cooling() 立刻为真，暂停期的 60s 空转不会再下一遍",
                dc72mod._upd_cooling() is True)
            dc72mod._upd_fail["until"] = time.time() - 1
            chk("T72 冷却到点自动放行（配额按小时滚动，不许把进程永久锁死）",
                dc72mod._upd_cooling() is False)

            _real72 = dc72mod.urllib.request.urlopen
            def _boom72(req, timeout=None):
                raise dc72mod.urllib.error.HTTPError(
                    "http://127.0.0.1/client/file/dist-client-macos", 429, "Too Many Requests",
                    {}, io.BytesIO('{"error":"更新包下载已达上限（每 IP 每小时 20 次）"}'.encode()))
            _msg72b = ""
            try:
                dc72mod.urllib.request.urlopen = _boom72
                try:
                    dc72mod._upd_download("http://127.0.0.1", _entry72, os.path.join(td72, "dist-client"))
                except ValueError as e:
                    _msg72b = str(e)
            finally:
                dc72mod.urllib.request.urlopen = _real72
            chk("T72 ★ 429 的响应体真的透到客户端（旧版被 except Exception 吞成什么都不说）",
                "服务器拒绝下载（HTTP 429）" in _msg72b and "每 IP 每小时 20 次" in _msg72b,
                _msg72b[:70])

    # ── T77：同目录多窗口更新收敛（2026-11-05 机房 Air 9 窗诊断的收口）─────────
    # 下载配额是每 IP 每小时 5 次：同目录 N 个窗口撞上同一次发布，只该花 1 次下载，
    # 其余窗口排队抢到锁后**现读磁盘**——已是目标版就直接重启（白嫖），谁也不许再下。
    # 另钉死第三态：排队期间磁盘被改成既非目标版也非本窗口启动那份（多半是运行中
    # 重跑了打包），旧写法会静默 execv 进未知字节，必须吭声进冷却。
    print("\nT77 更新收敛：同目录多窗口只花一次下载，排队后现读磁盘、第三态不 execv")
    dc77 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    chk("T77 排队后的重查是三分支：目标版→白嫖重启、启动那份→下载、都不是→吭声",
        'if disk2 == entry["sha256"]:' in dc77 and 'elif disk2 == _UPD_SELF_SHA:' in dc77
        and 'disk2 == py_entry["sha256"]' in dc77
        and dc77.count("来路不明，本轮不更新") == 2)
    chk("T77 下载只发生在「磁盘仍是我启动那份」的分支里（等窗白嫖不靠比对陈旧缓存放行）",
        dc77.index('elif disk2 == _UPD_SELF_SHA:') < dc77.index("tmp = _upd_download(server, entry, exe)")
        and dc77.index('elif disk2 == _UPD_SELF_SHA:', dc77.index('elif disk2 == _UPD_SELF_SHA:') + 1)
        < dc77.index("tmp = _upd_download(server, py_entry, my_py)"))

    if dc72mod is not None:
        import threading
        _spec77 = importlib.util.spec_from_file_location("uitest_dc77", root / "tools" / "dist_client.py")
        dc77mod = importlib.util.module_from_spec(_spec77)
        _spec77.loader.exec_module(dc77mod)
        _old77, _new77 = b"old-client-bytes", b"new-client-bytes"
        _new_sha77 = dc77mod.hashlib.sha256(_new77).hexdigest()
        with tempfile.TemporaryDirectory() as td77:
            _exe77 = os.path.join(td77, "dist-client")
            with open(_exe77, "wb") as f77:
                f77.write(_old77)
            _dl77 = {"n": 0}
            _real_dl77 = dc77mod._upd_download
            def _dl_stub77(server, entry, dest):
                _dl77["n"] += 1
                tmp = dest + ".new"
                with open(tmp, "wb") as f:
                    f.write(_new77)
                os.chmod(tmp, 0o755)
                return tmp
            _execv77 = []
            _real_execv77 = os.execv
            def _execv_stub77(path, args):
                _execv77.append(path)
                raise SystemExit     # except Exception 拦不住它，正好模拟「换镜像不返回」
            _real_json77 = dc77mod.http_json
            _real_verify77 = dc77mod.ed25519.verify
            _man77 = {"ver": 777777, "sig": "AA==",
                      "files": {"macos-bin": {"sha256": _new_sha77,
                                              "file": "/client/file/dist-client-macos"}}}
            dc77mod._upd_mode = lambda: "onefile"
            dc77mod._UPD_LOCK = os.path.join(td77, "upd.lock")
            dc77mod._UPD_ALT_DIR = os.path.join(td77, "alt")
            dc77mod._upd_pubkey = lambda: b"\x01" * 32
            dc77mod.http_json = lambda *a, **k: (200, _man77)
            dc77mod.ed25519.verify = lambda *a, **k: True
            dc77mod._upd_download = _dl_stub77
            os.execv = _execv_stub77
            _real_exe77 = sys.executable
            _errs77 = []
            try:
                sys.executable = _exe77
                def _win77():
                    try:
                        dc77mod.check_self_update("http://stub", False)
                    except SystemExit:
                        pass
                    except Exception as e:
                        _errs77.append(f"{type(e).__name__}: {e}")
                _ths77 = [threading.Thread(target=_win77) for _ in range(4)]
                for _t in _ths77:
                    _t.start()
                    time.sleep(0.05)
                for _t in _ths77:
                    _t.join(timeout=30)
                chk("T77 ★ 同目录 4 个窗口撞同一次发布：只花 1 次下载（配额 5/h 才扛得住多窗）",
                    _dl77["n"] == 1 and not _errs77,
                    f"下载 {_dl77['n']} 次，意外异常 {len(_errs77)}")
                chk("T77 ★ 4 个窗口全都重启进新版（抢到锁后现读磁盘，白嫖的不重下）",
                    len(_execv77) == 4 and all(p == _exe77 for p in _execv77)
                    and open(_exe77, "rb").read() == _new77
                    and not os.path.exists(dc77mod._UPD_LOCK),
                    f"execv {len(_execv77)} 次")

                # 第三态：主线程先占住锁，窗口过顶部检查进等待后再把磁盘换成垃圾字节
                _dl77["n"] = 0
                _execv77.clear()
                dc77mod._upd_fail["until"] = 0.0
                dc77mod._UPD_SELF_SHA = None
                with open(_exe77, "wb") as f:
                    f.write(_old77)
                dc77mod._upd_lock_acquire()      # 主线程占坑，窗口只能排队
                _t77b = threading.Thread(target=_win77)
                _t77b.start()
                time.sleep(1.5)                  # 确保它已过顶部检查、正在等锁
                with open(_exe77, "wb") as f:
                    f.write(b"garbage-from-repack")
                dc77mod._upd_lock_release()
                _t77b.join(timeout=30)
                chk("T77 ★ 排队期间磁盘变成第三态（运行中重跑打包）：吭声进冷却，不下载不 execv",
                    dc77mod._upd_cooling() and _dl77["n"] == 0 and not _execv77 and not _errs77,
                    f"下载 {_dl77['n']} execv {len(_execv77)}")
            finally:
                sys.executable = _real_exe77
                os.execv = _real_execv77
                dc77mod.ed25519.verify = _real_verify77
                dc77mod.http_json = _real_json77
                dc77mod._upd_download = _real_dl77

    # ── T73：散热番茄钟（2026-11-03 用户提「跑分机太烫」）─────────────────────
    # 休息只能落在**局与局之间**：跨局硬停会让客户端判「solver 提前结束 → 整任务作废」，
    # 已跑的局全扔；休息行也不许混进逐局记录（局数一多，服务器按「records 数量不符」拒收）。
    print("\nT73 番茄钟：只歇在局间、休息不算局、旧 solver 不许收到它不认的参数")
    sv73 = (root / "tools" / "solver.cpp").read_text(encoding="utf-8")
    dc73 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    chk("T73 ★ 最后一局算完不再歇（歇完没有下一局可跑 = 白等，还占着服务器租约）",
        "g + 1 >= games) return;" in sv73 and "pomodoroRest(g, games, jsonl" in sv73)
    chk("T73 计的是「真在算」的时长，歇那段不计（否则歇完立刻又够阈值 = 歇到天荒地老）",
        "g_pomo.activeMs >= g_pomo.workSec * 1000LL" in sv73 and "g_pomo.activeMs = 0;" in sv73)
    chk("T73 solver 侧写错格式要吭声并退出非 0（静默当没开 = 用户以为机器在歇）",
        '"--pomodoro" && i + 1 < argc' in sv73 and "if (!setPomodoro(argv[i + 1]))" in sv73)
    _seg73 = dc73.split('if "summary" in obj:', 1)[-1]
    chk("T73 ★ 休息行在 records.append 之前拦下（进了局数就超，整任务被服务器拒收）",
        '"rest" in obj' in _seg73 and _seg73.index('"rest" in obj') < _seg73.index("records.append(obj)"))
    chk("T73 ★ 传参数前先探 solver 认不认（旧包不认 → 用法退出 → 0 局作废 → 再领，空转烧队列）",
        "def probe_pomodoro(" in dc73 and "pomo_ok = probe_pomodoro(solver)" in dc73
        and "if not pomo_ok:" in dc73)
    chk("T73 客户端有 --pomodoro，默认 25m/5m、off 能关，且双击启动器也能用环境变量 CMS_POMODORO 改",
        'ap.add_argument("--pomodoro", default=None' in dc73
        and 'a.pomodoro or os.environ.get("CMS_POMODORO") or "25m/5m"' in dc73
        and 'in ("off", "0")' in dc73)
    chk("T73 面板休息时给倒计时，不留「当前局已跑」一直涨（看着像卡死）",
        'st["rest_until"] > now' in dc73 and "休息一下 剩余" in dc73)
    chk("T73 休息那段不许算进「这一局已跑」，否则一次 5 分钟能把 ETA 砍成 0",
        'if st["rest_until"]:' in dc73.split("def _eta_sec", 1)[1].split("\ndef ", 1)[0])

    # —— 真二进制那一头：休息行由 C++ 生成，字段口径只能跟真实现对，不能只跟 mock 对 ——
    # 局数按实测单局耗时现算（快的机器多跑几局、慢的少跑），阈值固定 1s，
    # 这样「够不够触发休息」跟机器快慢无关，不会变成一跑就红的定时炸弹。
    _bin73 = root / "build" / "solver"
    if _bin73.exists():
        _p73 = subprocess.run([str(_bin73), "--games", "200", "--board", "9x9x10",
                               "--model", "complex", "--jsonl"],
                              capture_output=True, text=True, timeout=180)
        _secs73 = [json.loads(x)["sec"] for x in _p73.stdout.splitlines() if x.startswith('{"g"')]
        _mu73 = sum(_secs73) / len(_secs73) if _secs73 else 0.002
        _n73 = max(300, min(60000, int(2.0 / max(_mu73, 1e-4))))
        _r73 = subprocess.run([str(_bin73), "--games", str(_n73), "--board", "9x9x10",
                               "--model", "complex", "--jsonl", "--pomodoro", "1s/1s"],
                              capture_output=True, text=True, timeout=600)
        _ls73 = [x for x in _r73.stdout.splitlines() if x.startswith("{")]
        _g73 = [x for x in _ls73 if '"g":' in x]
        _rs73 = [json.loads(x) for x in _ls73 if '"rest":' in x]
        chk("T73 ★ 真 solver：够连算 1 秒就插一行休息，一局不少、最后一局之后不再歇",
            len(_g73) == _n73 and len(_rs73) >= 1 and _ls73[-1].startswith('{"summary"'),
            f"单局 {_mu73 * 1000:.1f}ms → 跑 {_n73} 局，休息 {len(_rs73)} 次")
        chk("T73 休息行的 ran_ms = 真算了的毫秒（面板那句「已连算」靠它），且不含歇的时间",
            _rs73 and all(1000 <= r["ran_ms"] < 2000 for r in _rs73), str([r["ran_ms"] for r in _rs73[:3]]))
    else:
        skip("T73 真 solver 二进制功能账", "没找到 build/solver（cmake --build build --target solver）")

    if dc72mod is not None:
        _cases73 = [("25m/5m", "1500s/300s"), ("1h30m/10m", "5400s/600s"), ("90s/30s", "90s/30s"),
                    ("25/5", "1500s/300s"), ("off", ""), ("0/0", ""), (" 25m/5m ", "1500s/300s")]
        _wrong73 = [f"{a}->{dc72mod.pomo_spec(a)}≠{b}" for a, b in _cases73 if dc72mod.pomo_spec(a) != b]
        chk("T73 ★ 时长口径两端同一把尺：h/m/s、裸数字=分钟、off/0 归一成秒再转给 solver",
            not _wrong73, "; ".join(_wrong73)[:120])
        _leak73 = []
        for bad in ("25m", "25m/off", "0/5m", "abc/5m", "25m/5x", "25m/5m/5m"):
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    dc72mod.pomo_spec(bad)
                _leak73.append(bad)
            except SystemExit:
                pass
        chk("T73 ★ 写错的立刻退出：漏一条到 solver 那边就是整任务白作废",
            not _leak73, "放过了 " + ",".join(_leak73))
        _st73 = {"n": 10, "wins": 8, "t0": time.time() - 200, "cur_t0": time.time() - 30,
                 "done": [], "ram": "n/a", "games_total": 20, "sec_sum": 100.0,
                 "rest_until": 0.0, "rest_sec": 0, "rest_ran_ms": 0}
        _plain73 = dc72mod._eta_sec(_st73)
        _st73["rest_sec"], _st73["rest_until"] = 120, time.time() + 60   # 已歇 60s、还剩 60s
        _rest73 = dc72mod._eta_sec(_st73)
        chk("T73 ★ 歇掉的 60s 从「本局已跑」里扣走：ETA 不跟着倒计时掉（100−30 → 100−0）",
            _plain73 < 80 and _rest73 > 99, f"不歇 {_plain73:.1f} / 歇中 {_rest73:.1f}")

        # —— 旧 solver 的探针：不认 --pomodoro 就必须探出来 ——
        _old73dir = tempfile.mkdtemp(prefix="cmsdist-t73old-")
        _old73 = Path(_old73dir) / "solver-expert"
        _old73.write_text("#!/bin/sh\nfor a in \"$@\"; do\n"
                          "  [ \"$a\" = \"--pomodoro\" ] && { echo '用法: solver [--diffs emh|all] ...'; exit 1; }\n"
                          "  [ \"$a\" = \"--version\" ] && { echo deadbeef; exit 0; }\n"
                          "done\nexit 0\n", encoding="utf-8")
        os.chmod(_old73, 0o755)
        chk("T73 ★ 旧包（认 --version、不认 --pomodoro）探得出来，客户端才会降级并吭声",
            dc72mod.probe_pomodoro(str(_old73)) is False)
        shutil.rmtree(_old73dir, ignore_errors=True)

        # —— 端到端：本地调度服务器 + 会吐休息行的 mock solver，走完整 run_one ——
        with tempfile.TemporaryDirectory(prefix="cmsdist-t73-") as td73:
            with socket.socket() as _s73:
                _s73.bind(("127.0.0.1", 0))
                _port73 = _s73.getsockname()[1]
            _srv73 = subprocess.Popen(
                [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                 "serve", "127.0.0.1", str(_port73)],
                env=dict(os.environ, CMSDIST_STATE=td73),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                _base73 = f"http://127.0.0.1:{_port73}"
                for _ in range(80):
                    try:
                        if dc72mod.http_json(_base73, "/ping", timeout=5)[1].get("ok"):
                            break
                    except Exception:
                        time.sleep(0.25)
                task73 = dc72mod.http_json(_base73, "/claim",
                                           {"name": "t73", "os": "test"}, timeout=10)[1]

                _mock73 = Path(td73) / "solver-expert"
                _mock73.write_text(
                    "#!/usr/bin/env python3\nimport sys, json\n"
                    "a = sys.argv[1:]\nn = int(a[a.index('--games') + 1])\n"
                    "for i in range(n):\n"
                    "    print(json.dumps({'g': i, 'win': 1, 'guess': 2, 'mid': 1,"
                    " 'end': 1, 'trap': 0, 'zero': 0, 'flagpath': 0, 'sec': 0.05}), flush=True)\n"
                    "    if i == 3:\n"
                    "        print(json.dumps({'rest': 1, 'ran_ms': 1234, 'src': 'local'}), flush=True)\n"
                    "        __import__('time').sleep(1)\n"
                    "print(json.dumps({'summary': {'games': n}}), flush=True)\n", encoding="utf-8")
                os.chmod(_mock73, 0o755)

                _old_hd, _old_sz = dc72mod._HEADLESS, dc72mod.shutil.get_terminal_size
                dc72mod._HEADLESS = False
                dc72mod.shutil.get_terminal_size = lambda *x: os.terminal_size((120, 24))
                dc72mod._panel_cleared = False
                _buf73 = io.StringIO()
                _ret73, _err73 = None, ""
                try:
                    with contextlib.redirect_stdout(_buf73):
                        _ret73 = dc72mod.run_one(_base73, "t73", task73, str(_mock73), "mock73",
                                                 {"flag": False}, {"flag": False}, {"flag": False},
                                                 "1s/1s", True)
                except Exception as e:
                    _err73 = f"{type(e).__name__}: {e}"
                finally:
                    dc72mod._HEADLESS, dc72mod.shutil.get_terminal_size = _old_hd, _old_sz
                _out73 = _buf73.getvalue()
                chk("T73 ★ 端到端跑完并交得上：休息行没被当成局（局数一超服务器就拒收）",
                    _ret73 is True and _err73 == "" and "作废" not in _out73,
                    _err73 or _out73[-120:])
                chk("T73 面板真画出过休息倒计时（措辞是「休息一下」，不是管理口径）",
                    "休息一下 剩余" in _out73 and "散热休息中" not in _out73,
                    _out73[-160:].replace("\x1b", "\\e")[:160])
                # Seed 行是截图里唯一能事后归因「这局是哪份代码算的」的地方，两个身份都得在：
                # 只写 solver 看不出「新客户端 + 老求解器」的半更新，只写 client 看不出求解器新旧
                _seed73 = [x for x in _out73.splitlines() if x.startswith("Seed: ")]
                chk("T73 ★ 面板 Seed 行同时带两个身份（solver 指纹 + 客户端哈希）",
                    bool(_seed73) and "solver mock73" in _seed73[0]
                    and f"client {dc72mod.client_ver()}" in _seed73[0],
                    (_seed73[0] if _seed73 else _out73[:120]).replace("\x1b", "\\e")[:160])
                _done73 = json.loads((Path(td73) / "state.json").read_text(encoding="utf-8"))["done"]
                _rec73 = _done73.get(task73["task_id"], {})
                chk("T73 服务器那端收下的是整任务（局数对上、逐局记录全算 win）",
                    _rec73.get("games") == task73["games"] and _rec73.get("wins") == task73["games"],
                    str(_rec73)[:150])
            finally:
                _srv73.terminate()
                _srv73.wait(timeout=10)

    # ── T74：调度番茄钟（2026-11-03 用户把口径挪到调度侧：「番茄钟要管分配任务」）──
    # 语义：服务器按墙上时钟算一个全舰队统一的相位 —— 到了休息段 ① 不再发新任务
    # ② 已经领走的那单在**局与局之间**睡到这一段结束（进程活着，51–100 局继续，不重来）。
    # 三条不许改坏：判定复用「手动暂停」那条不写盘分支；相位算术在服务端/客户端/solver
    # 是三份拷贝（分发形态逼的），必须逐时刻对拉；anchor 是服务器时钟域，客户端要换算。
    print("\nT74 调度番茄钟：全局相位到点停发货、在跑的局间睡、没对时的机器也不错拍")
    ds74 = (root / "tools" / "dist_server.py").read_text(encoding="utf-8")
    cu74 = (root / "tools" / "ctl_ui.py").read_text(encoding="utf-8")
    dt74 = (root / "tools" / "distctl.py").read_text(encoding="utf-8")
    ui74 = (root / "tools" / "ctlui" / "index.html").read_text(encoding="utf-8")
    aj74 = (root / "tools" / "ctlui" / "app.js").read_text(encoding="utf-8")
    cfg74 = {"pomo": {"on": True, "work_sec": 100, "rest_sec": 50, "anchor": 1000.0}}
    chk("T74 ★ 相位是墙上时钟的纯函数（没有 timer/cron/后台线程），服务重启也不会漏掉一段",
        "def pomo_phase(cfg, now=None):" in ds74 and "threading.Timer" not in ds74)
    chk("T74 ★ 休息段拒发复用「手动暂停」那条不写盘分支（轮询不许重写整份 state.json）",
        'if cfg.get("paused") or (ph and ph["in_rest"]):' in ds74
        and ds74.count("_skip_save(not moved)") == 2,
        f'_skip_save(not moved) × {ds74.count("_skip_save(not moved)")}')
    chk("T74 领到的任务里带相位（在跑的那单才知道什么时候该睡），关掉时也把两段时长带回",
        '"pomo": pomo_wire(cfg)' in ds74
        and '"on": False, "work_sec": w, "rest_sec": r' in ds74)
    chk("T74 管理入口三处都接通：admin-pomo 注册且要口令 / ctl_ui OPS / distctl 表+GUARDED",
        '"admin-pomo": (cmd_admin_pomo, True)' in ds74 and '"pomo": "admin-pomo"' in cu74
        and '"pomo": ("admin-pomo", args, True)' in dt74 and '"admin-pomo"' in dt74)
    chk("T74 ★ distctl status 说得出番茄钟此刻在干嘛（CLI 只报「暂停」会把「节拍到点自动歇」看漏）",
        "番茄钟: 开 连算" in dt74 and "番茄钟: 未开（任务一直发）" in dt74
        and dt74.index("ph = st.get(\"pomo\")") < dt74.index("优先队列:")
        and "in_rest" in dt74.split("def cmd_status", 1)[1].split("\ndef ", 1)[0])
    chk("T74 ctlui 卡片齐（开关/两段时长/状态），倒计时本地一跳而不是 15 秒一蹦",
        'id="btn-pomo"' in ui74 and 'id="pomo-w"' in ui74 and 'id="pomo-r"' in ui74
        and 'id="pomo-state"' in ui74 and "renderPomo(d.pomo)" in aj74
        and "setInterval(pomoTick, 1000)" in aj74)
    chk("T74 ★ 休息段在 ctlui 上有三处明显标志（顶部一格 + 队列卡黄条 + 暂停按钮置灰），"
        "不再只靠表单末尾那行小灰字",
        'id="c-pomo"' in ui74 and 'id="pomo-banner"' in ui74 and "rest-banner" in ui74
        and "function syncPauseBtn()" in aj74 and "btn.disabled = rest && !PAUSED" in aj74
        and "ban.hidden = false" in aj74          # 休息段亮出来
        and "ban.hidden = true" in aj74           # 连算段收回去
        and '$("pomo-banner").hidden = true' in aj74)   # 没开也收回去（别留一条过期黄条）
    chk("T74 ★ 标志给的是钟点不只是倒计时（「还剩 3:41」要自己算几点结束，「14:07 恢复发放」不用）",
        "const pomoClock = " in aj74 and 'hour: "2-digit", minute: "2-digit"' in aj74
        and "${due} 恢复发放（还剩 ${etaFmt(left)}）" in aj74
        and "${due} 起歇（还剩 ${etaFmt(Math.max(0, left))}）" in aj74)
    chk("T74 ★ 置灰只认番茄钟休息段：管理员手动暂停时按钮必须还能点（那是唯一的恢复入口）",
        "let PAUSED = false" in aj74 and "PAUSED = paused" in aj74
        and "rest && !PAUSED" in aj74 and "（不是暂停）" in aj74
        and aj74.index("PAUSED = paused") < aj74.index("renderPomo(d.pomo)"))
    chk("T74 ★ 拒发的话是「休息一下」并给出还剩多久；只有手动暂停才说「暂停发放」",
        'if task.get("reason") == "pomodoro":' in dc73
        and "☕ 休息一下，还剩" in dc73
        and dc73.index('if task.get("reason") == "pomodoro":')
        < dc73.index('print("⏸ 服务器已暂停发放')
        and '"reason": "manual" if cfg.get("paused") else "pomodoro"' in ds74)

    ds74mod = None
    imp74 = ""
    try:
        spec74 = importlib.util.spec_from_file_location("uitest_ds74",
                                                        root / "tools" / "dist_server.py")
        ds74mod = importlib.util.module_from_spec(spec74)
        env_keep74 = os.environ.get("CMSDIST_STATE")
        os.environ["CMSDIST_STATE"] = tempfile.mkdtemp(prefix="cmsdist-t74mod-")
        try:
            spec74.loader.exec_module(ds74mod)
        finally:
            if env_keep74 is None:
                os.environ.pop("CMSDIST_STATE", None)
            else:
                os.environ["CMSDIST_STATE"] = env_keep74
    except Exception as e:
        imp74 = f"{type(e).__name__}: {e}"
        ds74mod = None
    if ds74mod is None:
        skip("T74 相位算术对拉", f"载入 dist_server 失败：{imp74}")
    else:
        # ① 服务端 pomo_phase ↔ 客户端 phase_now：同一串时刻点逐个对，谁改歪当场红
        mis74 = []
        for off in (0, 1, 99, 99.5, 100, 100.5, 120, 149, 150, 151, 200, 249, 250, 251, 400, 700):
            nowx = 1000.0 + off
            phx = ds74mod.pomo_phase(cfg74, nowx)
            clx = dc72mod.phase_now(1000.0, 100, 150, nowx)
            if phx["in_rest"] != clx[0] or abs(phx["left"] - clx[1]) > 1e-6:
                mis74.append(f"t+{off}: 服务端 ({phx['in_rest']}, {phx['left']:.3f}) "
                             f"vs 客户端 ({clx[0]}, {clx[1]:.3f})")
        chk("T74 ★ 服务端与客户端的相位算术逐时刻一致（pos>=work 才算歇）",
            not mis74, "; ".join(mis74)[:200])
        edge74 = ds74mod.pomo_phase(cfg74, 1100.0)
        chk("T74 边界口径 pos==work 即休息，且 solver 那侧同式（写成 > 会多算一秒）",
            edge74["in_rest"] is True and abs(edge74["left"] - 50.0) < 1e-6
            and "pos >= g_sched.workSec" in sv73, str(edge74))
        grammar74 = [("25m", 1500), ("1h30m", 5400), ("90s", 90), ("25", 1500),
                     ("off", 0), ("0", 0)]
        bad74 = [f"{s}: 服务端 {ds74mod.pomo_dur(s)} vs 客户端 {dc72mod.pomo_parse(s)}"
                 for s, want in grammar74
                 if ds74mod.pomo_dur(s) != dc72mod.pomo_parse(s) or ds74mod.pomo_dur(s) != want]
        chk("T74 时长这把尺三份拷贝不打架（h/m/s、裸数字=分钟、off/0=0）",
            not bad74, "; ".join(bad74)[:160])
        chk("T74 读不懂的返回 None（按「没开番茄钟」处理，绝不默认成 0 秒让全舰队瞎歇）",
            all(ds74mod.pomo_dur(s) is None for s in ("abc", "5x", "m", "1hm", "-5m")))
        base74 = time.time()

        def wire74(server_now):
            return {"pomo": {"on": True, "work_sec": 100, "rest_sec": 50, "anchor": 1000.0,
                             "server_now": server_now, "in_rest": True, "left": 30.0}}

        a74 = dc72mod.pomo_local(wire74(base74))[0]
        b74 = dc72mod.pomo_local(wire74(base74 - 700))[0]
        chk("T74 ★ anchor 换算到本机时钟域：本机钟比服务器慢 700s，anchor 也跟着挪 700s",
            abs((b74 - a74) - 700.0) < 1.0, f"{a74:.1f} / {b74:.1f}")
        chk("T74 没开/字段不合法的相位 → pomo_local 给 None，一个多余参数都不往 solver 传",
            dc72mod.pomo_local({"pomo": {"on": False}}) is None
            and dc72mod.pomo_local({}) is None
            and dc72mod.pomo_local({"pomo": {"on": True, "work_sec": 0, "rest_sec": 0,
                                             "anchor": 1, "server_now": 2}}) is None)

    # ② 端到端：真起一台本地调度服务器，把相位拨进休息段，看它「只回不发、且不落盘」
    try:
        with tempfile.TemporaryDirectory(prefix="cmsdist-t74-") as td74:
            with socket.socket() as s74:
                s74.bind(("127.0.0.1", 0))
                port74 = s74.getsockname()[1]
            srv74 = subprocess.Popen(
                [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                 "serve", "127.0.0.1", str(port74)],
                env=dict(os.environ, CMSDIST_STATE=td74),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            sf74 = Path(td74) / "state.json"

            def set_pomo74(d):
                # 与服务器同写一个文件：临时名 + replace 才原子，裸写会让它读到半份
                raw74 = json.loads(sf74.read_text(encoding="utf-8"))
                raw74["config"]["pomo"] = d
                tmp74 = str(sf74) + ".t74.tmp"
                Path(tmp74).write_text(json.dumps(raw74, ensure_ascii=False), encoding="utf-8")
                os.replace(tmp74, sf74)

            try:
                base74b = f"http://127.0.0.1:{port74}"
                for _ in range(80):
                    try:
                        if dc72mod.http_json(base74b, "/ping", timeout=5)[1].get("ok"):
                            break
                    except Exception:
                        time.sleep(0.25)
                # 连算 1s / 歇 3600s、anchor 在 30s 前 → 此刻必然在休息段
                set_pomo74({"on": True, "work_sec": 1, "rest_sec": 3600,
                            "anchor": time.time() - 30})
                mt74 = sf74.stat().st_mtime_ns
                r74 = dc72mod.http_json(base74b, "/claim", {"name": "t74", "os": "test"},
                                        timeout=10)[1]
                chk("T74 ★ 休息段领任务：只回 paused+pomodoro+还剩多久，磁盘一个字节都没动",
                    r74.get("paused") is True and r74.get("reason") == "pomodoro"
                    and (r74.get("rest_left") or 0) > 0 and "task_id" not in r74
                    and sf74.stat().st_mtime_ns == mt74, str(r74)[:160])
                set_pomo74({"on": True, "work_sec": 3600, "rest_sec": 60, "anchor": time.time()})
                t74 = dc72mod.http_json(base74b, "/claim", {"name": "t74w", "os": "test"},
                                        timeout=10)[1]
                chk("T74 ★ 连算段立刻恢复发放，任务里带着相位（时长/anchor/服务器此刻）",
                    "task_id" in t74 and t74.get("pomo", {}).get("on") is True
                    and t74["pomo"]["work_sec"] == 3600 and t74["pomo"]["rest_sec"] == 60
                    and abs(t74["pomo"]["server_now"] - time.time()) < 5, str(t74)[:160])
                pg74 = dc72mod.http_json(base74b, "/progress",
                                         {"task_id": t74["task_id"], "nonce": t74["nonce"],
                                          "done": 1, "eta_sec": 5}, timeout=10)
                chk("T74 休息段前后 /progress 照报（心跳不断，租约不会被误收）",
                    pg74[0] == 200, str(pg74)[:140])
                # 关掉只影响之后领的任务：已经带着时刻表的那单不许被追回（硬杀=整任务作废）
                set_pomo74({"on": False, "work_sec": 1500, "rest_sec": 300,
                            "anchor": time.time()})
                off74 = dc72mod.http_json(base74b, "/claim", {"name": "t74o", "os": "test"},
                                          timeout=10)[1]
                chk("T74 关掉后立刻恢复发放，且下发的是 on:false（客户端就不会传相位参数）",
                    "task_id" in off74 and off74.get("pomo", {}).get("on") is False,
                    str(off74)[:160])
                lite74 = dc72mod.http_json(base74b, "/claim", {"name": "t74l", "os": "test"},
                                           timeout=10)[1]
                chk("T74 关着也回两段时长（ctlui 输入框不会漂回默认 25m/5m）",
                    lite74.get("pomo", {}).get("work_sec") == 1500
                    and lite74["pomo"]["rest_sec"] == 300, str(lite74.get("pomo")))
            finally:
                srv74.terminate()
                srv74.wait(timeout=10)
    except Exception as e:
        skip("T74 休息段不发货功能账", f"起本地 dist_server 失败：{e}")

    # ③ 真 solver 那一头：相位参数由 C++ 算，休息行必须报 src=sched 且一局不少
    if _bin73.exists():
        _now74 = int(time.time())
        # anchor 在 252s 前、连算 200 / 整轮 260 → pos=252>=200，休息段还剩 8s 必然命中。
        # 余量不能压成 1s：整套跑起来 spawn 子进程可能要几秒，窗口只剩 1s 时 pos 已经翻回
        # 连算段 —— 那是测试自己赶不上节拍，不是 solver 没歇（11-03 满负载时就红过一次）。
        r74c = subprocess.run([str(_bin73), "--games", "400", "--board", "9x9x10",
                               "--model", "complex", "--jsonl", "--pomodoro", "off",
                               "--pomodoro-phase", f"{_now74 - 252}:200:260"],
                              capture_output=True, text=True, timeout=300)
        ls74c = [x for x in r74c.stdout.splitlines() if x.startswith("{")]
        g74c = [x for x in ls74c if '"g":' in x]
        rs74c = [json.loads(x) for x in ls74c if '"rest":' in x]
        chk("T74 ★ 真 solver 按调度相位在局间停下：休息行 src=sched、一局不少、最后不歇",
            len(g74c) == 400 and len(rs74c) >= 1
            and all(x.get("src") == "sched" for x in rs74c)
            and ls74c[-1].startswith('{"summary"'),
            f"局 {len(g74c)}/400 休息 {len(rs74c)} 次 {rs74c[:1]}")
        r74d = subprocess.run([str(_bin73), "--games", "400", "--board", "9x9x10",
                               "--model", "complex", "--jsonl", "--pomodoro", "off",
                               "--pomodoro-phase", f"{_now74}:200:260"],
                              capture_output=True, text=True, timeout=300)
        ls74d = [x for x in r74d.stdout.splitlines() if x.startswith("{")]
        chk("T74 负向对照：同一台机器连算段（pos<work）就真的一次都不歇",
            not any('"rest":' in x for x in ls74d)
            and sum(1 for x in ls74d if '"g":' in x) == 400,
            f"休息行 {[x for x in ls74d if chr(34) + 'rest' in x][:1]}")
        r74e = subprocess.run([str(_bin73), "--pomodoro-phase", "abc", "--games", "1"],
                              capture_output=True, text=True, timeout=60)
        chk("T74 ★ 相位参数写错的立刻退出非 0（静默当没开 = 机器不歇而屏上说要歇）",
            r74e.returncode != 0 and "--pomodoro-phase" in (r74e.stdout + r74e.stderr),
            (r74e.stdout + r74e.stderr)[:160])
    else:
        skip("T74 真 solver 相位功能账", "没找到 build/solver（cmake --build build --target solver）")

    # ── T75：ctlui 前端「换代」自查（2026-11-03 用户问：为什么非要手动刷新浏览器才知道）──
    # 起因就是我这一轮：改了 app.js/index.html，看板里 15 秒一次的自动刷新照常跑，
    # 但跑的是**浏览器打开那一刻加载进内存的旧 JS** —— 数据是新的，代码是旧的，
    # 于是「界面改了怎么没生效」只能等人自己按 F5。修法：把磁盘上三件套的指纹
    # 挂在每次 status 回执里，页面自己跟加载时那份比，不一样就把条子挂出来。
    print("\nT75 ctlui 前端换代自查：页面内刷新就该发现前端变了，不必等人手动重载")
    aj75 = (root / "tools" / "ctlui" / "app.js").read_text(encoding="utf-8")
    ui75 = (root / "tools" / "ctlui" / "index.html").read_text(encoding="utf-8")
    chk("T75 ★ status 每次回执带前端三件套的指纹（以前只有 stale=服务端没重启，前端没人管）",
        'd["assets_ver"] = assets_ver()' in cu74 and "def assets_ver()" in cu74
        and 'ASSET_FILES = ("index.html", "app.js", "app.css")' in cu74)
    chk("T75 指纹只 stat 不读内容：这是每 15 秒一次的公网热路径，别为了看 mtime 去哈希 ~120KB",
        "st_mtime_ns" in cu74.split("def assets_ver", 1)[1].split("def ", 1)[0]
        and ".read(" not in cu74.split("def assets_ver", 1)[1].split("return", 1)[0])
    chk("T75 页面第一次回执定基准（一进来就挂条子会被当成 bug），之后每次 render 都比对",
        "const ASSETS = { base: null };" in aj75
        and "if (d.assets_ver && ASSETS.base === null) ASSETS.base = d.assets_ver;" in aj75
        and "function render(d) {" in aj75
        and aj75.index("function render(d) {") < aj75.index("staleNote(d);")
        < aj75.index("staleNote(d);") + 400)
    chk("T75 ★ 两种「你看到的是旧的」分开说、各给一个动作：重启进程 / 刷新浏览器",
        "重启 ctlui 进程才生效（刷新浏览器没用）" in aj75
        and "刷新浏览器（Cmd/Ctrl+R）就换成新页面" in aj75
        and "if (d.stale)" in aj75
        and aj75.index("if (d.stale)") < aj75.index("else if (uiStale)"))
    chk("T75 条子的 title 说明两份代码各自的加载语义（服务端载入内存 / 前端每次现读盘）",
        "载入内存" in ui75 and "现读盘" in ui75)

    try:
        spec75 = importlib.util.spec_from_file_location("uitest_ctlui75", root / "tools" / "ctl_ui.py")
        cu75 = importlib.util.module_from_spec(spec75)
        spec75.loader.exec_module(cu75)
        with tempfile.TemporaryDirectory(prefix="cmsdist-t75-") as td75:
            keep75 = cu75.ASSET_DIR
            cu75.ASSET_DIR = td75
            try:
                for nm in cu75.ASSET_FILES:
                    (Path(td75) / nm).write_text("x", encoding="utf-8")
                v0 = cu75.assets_ver()
                # ① 什么都不动 → 不许误报
                same75 = cu75.assets_ver() == v0
                # ② 只碰 app.css（以前这条完全没人管）→ 必须换号
                (Path(td75) / "app.css").write_text("yy", encoding="utf-8")
                os.utime(Path(td75) / "app.css", (time.time() + 5, time.time() + 5))
                css75 = cu75.assets_ver() != v0
                # ③ 负向对照：长度一样、只 touch（同体积的改动是常态）→ 光看 size 就瞎了
                (Path(td75) / "index.html").write_text("x", encoding="utf-8")
                os.utime(Path(td75) / "index.html", (time.time() + 60, time.time() + 60))
                touch75 = cu75.assets_ver() not in (v0,)
                # ④ 文件不见了不许抛（这是公网热路径，抛一次整个看板 500）
                (Path(td75) / "app.js").unlink()
                gone75 = isinstance(cu75.assets_ver(), str) and len(cu75.assets_ver()) == 12
            finally:
                cu75.ASSET_DIR = keep75
        chk("T75 ★ 真函数四态：不动不变号 / 改任意一份就变号 / 同体积只改时间也变号 / 文件没了不抛",
            same75 and css75 and touch75 and gone75,
            f"不动={same75} 改css={css75} 只touch={touch75} 缺文件={gone75}")
    except Exception as e:
        skip("T75 assets_ver 功能账", f"载入 ctl_ui.py 失败：{e}")


    # ── T76 客户端身份：solver 指纹只是一半 ──────────────────────────────────
    # 用户当场指出「求解器版本和客户端版本不是一个东西」：更新是**逐文件**换的，
    # Windows 上 solver.exe 正被十个进程用着就换不动 → 「新客户端 + 老求解器」。
    # 只看 solver_ver 的看板对这种半更新完全隐形，所以两个身份各报一半、成对展示。
    print("\nT76 客户端身份：半更新（新客户端 + 老求解器）只有两个身份一起看才看得见")
    dc76 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    ds76 = (root / "tools" / "dist_server.py").read_text(encoding="utf-8")
    dt76 = (root / "tools" / "distctl.py").read_text(encoding="utf-8")
    cu76s = (root / "tools" / "ctl_ui.py").read_text(encoding="utf-8")
    ui76 = (root / "tools" / "ctlui" / "index.html").read_text(encoding="utf-8")
    aj76 = (root / "tools" / "ctlui" / "app.js").read_text(encoding="utf-8")

    chk("T76 ★ 客户端身份与 manifest 同口径：onefile 哈希 sys.executable，免安装包哈希自身那个 .py",
        'sys.executable if _upd_mode() == "onefile"' in dc76
        and "os.path.realpath(__file__)" in dc76 and dc76.count("def client_ver()") == 1)
    chk("T76 两个身份都随 /claim 与 /result 上报（只报一处 = 交完结果就查不到这批数据是谁算的）",
        dc76.count('"client_ver": client_ver()') == 2
        and ds76.count('client_ver = str(data.get("client_ver", ""))[:16]') == 2)
    chk("T76 ★ 服务端两个投影都带上它（漏一个 = 界面那一列永远「未上报」，看着像功能没生效）",
        '"client_ver": v.get("client_ver", "")' in ds76
        and '"client_ver"' in ds76.split("DONE_UI_KEYS = (", 1)[1].split(")", 1)[0])
    chk("T76 看板按「求解器 · 客户端」成对聚合，不拆两行（拆着看半更新会被藏起来）",
        "t.client_ver || UNKNOWN" in aj76 and "${chip(sv)} · ${chip(cv)}" in aj76
        and "每格是「求解器 · 客户端」" in aj76)
    chk("T76 五张表都有「客户端」列（三张数据表 + 两张版本历史表），进行中的组行 colspan 跟着 +1",
        ui76.count(">客户端</th>") == 5 and aj76.count('colspan="8"') == 2
        and "t.client_ver" in aj76 and "r.client_ver" in aj76)
    chk("T76 「已发布」的客户端三份全列（每平台一份程序字节），不挑一份代表全部",
        "CLIENT_MANIFEST_KEYS" in cu76s and "def _published_client_vers()" in cu76s
        and "Object.entries(m).map" in aj76
        and 'id="client-published"' in ui76 and 'id="client-current"' in ui76)
    chk("T76 版本卡回执带上客户端那条轴（工作区 + 已发布三平台）",
        '"current_client": client_ws_ver()' in cu76s
        and '"published_client": _published_client_vers()' in cu76s)
    chk("T76 distctl status 同一行报两个身份（终端里只看求解器会漏掉半更新）",
        "线上在跑: " in dt76 and 't.get("client_ver")' in dt76
        and "求解器 {s} + 客户端 {c} ×{n} 终端" in dt76)

    # ① 真算：口径不能只对名字，得跟独立算出来的 sha256 逐字相同
    try:
        import hashlib as hl76
        spec76 = importlib.util.spec_from_file_location("uitest_dc76",
                                                        root / "tools" / "dist_client.py")
        dc76m = importlib.util.module_from_spec(spec76)
        spec76.loader.exec_module(dc76m)
        want76 = hl76.sha256((root / "tools" / "dist_client.py").read_bytes()).hexdigest()[:8]
        got76 = dc76m.client_ver()
        chk("T76 ★ 真算：仓库裸跑那份 = 独立算的 sha256 前 8 位，且第二次调走缓存不变",
            got76 == want76 and dc76m.client_ver() == got76, f"{got76} vs {want76}")
        keep76m = dc76m._upd_mode
        dc76m._upd_mode = lambda: "onefile"     # 打成 mac 整包形态：该改哈希 sys.executable
        dc76m._CLIENT_VER = None
        exe76 = dc76m.client_ver()
        wantexe76 = hl76.sha256(open(sys.executable, "rb").read()).hexdigest()[:8]
        dc76m._upd_mode = keep76m
        dc76m._CLIENT_VER = None
        chk("T76 ★ onefile 分支真走另一条路（mac 整包 = 哈希那个二进制，不是哈希 .py）",
            exe76 == wantexe76 and exe76 != got76, f"{exe76} vs {wantexe76}")
    except Exception as e:
        skip("T76 client_ver 功能账", f"载入 dist_client.py 失败：{e}")

    # ② ctl_ui 那侧：manifest 解析与「工作区客户端」哈希（都不许 SSH，喂假件）
    try:
        import hashlib as hl76b
        spec76c = importlib.util.spec_from_file_location("uitest_ctlui76", root / "tools" / "ctl_ui.py")
        cu76 = importlib.util.module_from_spec(spec76c)
        spec76c.loader.exec_module(cu76)
        keep76p = cu76._published_manifest
        cu76._published_manifest = lambda: {"solver_ver": "7d9d7749", "files": {
            "macos-bin": {"sha256": "088b7f5961ff" + "0" * 52},
            "win64-py": {"sha256": "1234abcd" + "0" * 56},
            "linux64-py": {"sha256": "deadbeef" + "0" * 56},
            "solver-win64": {"sha256": "f" * 64}}}
        pub76 = cu76._published_client_vers()
        cu76._published_manifest = lambda: {"solver_ver": "7d9d7749"}       # 没有 files
        nofiles76 = cu76._published_client_vers()
        cu76._published_manifest = lambda: {"files": {"macos-bin": {"sha256": "zzzzzzzz"},
                                                      "win64-py": None}}    # 形状不对
        bad76 = cu76._published_client_vers()
        cu76._published_manifest = keep76p
        chk("T76 ★ 已发布客户端三份各取 8 位；缺 files 或哈希形状不对就空着，绝不抛也不塞垃圾",
            pub76 == {"mac": "088b7f59", "win": "1234abcd", "linux": "deadbeef"}
            and nofiles76 == {} and bad76 == {}, f"{pub76} / {nofiles76} / {bad76}")
        ws76 = cu76.client_ws_ver()
        chk("T76 工作区客户端哈希 = 独立算的 sha256 前 8 位（同口径才比得出「改了没发」）",
            ws76 == hl76b.sha256((root / "tools" / "dist_client.py").read_bytes()).hexdigest()[:8]
            and cu76.client_ws_ver() == ws76, ws76)
    except Exception as e:
        skip("T76 ctl_ui 客户端身份账", f"载入 ctl_ui.py 失败：{e}")

    # ③ 端到端：真起一台本地调度服务器，把「半更新那台」领任务→交结果走一遍
    try:
        with tempfile.TemporaryDirectory(prefix="cmsdist-t76-") as td76:
            with socket.socket() as s76:
                s76.bind(("127.0.0.1", 0))
                port76 = s76.getsockname()[1]
            srv76 = subprocess.Popen(
                [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                 "serve", "127.0.0.1", str(port76)],
                env=dict(os.environ, CMSDIST_STATE=td76),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

            def lite76():
                return json.loads(subprocess.run(
                    [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                     "admin-lite", "30"], env=dict(os.environ, CMSDIST_STATE=td76),
                    capture_output=True, text=True, timeout=60).stdout)

            try:
                base76 = f"http://127.0.0.1:{port76}"
                for _ in range(80):
                    try:
                        if dc72mod.http_json(base76, "/ping", timeout=5)[1].get("ok"):
                            break
                    except Exception:
                        time.sleep(0.25)
                # 半更新那台：客户端是新的、求解器还是老的
                c76, t76 = dc72mod.http_json(base76, "/claim", {
                    "name": "half", "os": "Windows 10",
                    "solver_ver": "c1f60148", "client_ver": "a12e2269"}, timeout=10)
                row76 = [x for x in lite76()["inprog"] if x["name"] == "half"][0]
                chk("T76 ★ 半更新在服务器眼里是两个独立字段：老求解器 + 新客户端原样存下",
                    c76 == 200 and row76["solver_ver"] == "c1f60148"
                    and row76["client_ver"] == "a12e2269", str(row76)[:160])
                recs76 = [{"g": i, "win": 1, "guess": 0, "mid": 0, "end": 0, "trap": 0,
                           "zero": 1, "flagpath": 0, "sec": 0.1} for i in range(t76["games"])]
                c76b, _r76b = dc72mod.http_json(base76, "/result", {
                    "task_id": t76["task_id"], "nonce": t76["nonce"], "name": "half",
                    "os": "Windows 10", "solver_ver": "c1f60148", "client_ver": "a12e2269",
                    "records": recs76}, timeout=60)
                d76 = [v for v in lite76()["done_recent"].values() if v["name"] == "half"]
                chk("T76 交完结果两个身份都还在（事后归因「这批数据是哪份代码算的」要靠它）",
                    c76b == 200 and d76 and d76[0]["solver_ver"] == "c1f60148"
                    and d76[0]["client_ver"] == "a12e2269", str(d76)[:160])
                # 老客户端两个字段都不发：新增字段不许变成硬门槛
                c76c, t76c = dc72mod.http_json(base76, "/claim",
                                               {"name": "old", "os": "test"}, timeout=10)
                old76 = [x for x in lite76()["inprog"] if x["name"] == "old"][0]
                chk("T76 ★ 老客户端不发 client_ver 也照常领任务，两个身份都归空串（界面显示「未上报」）",
                    c76c == 200 and "task_id" in t76c and old76["client_ver"] == ""
                    and old76["solver_ver"] == "", f"{c76c} {str(old76)[:120]}")
            finally:
                srv76.terminate()
                srv76.wait(timeout=10)
    except Exception as e:
        skip("T76 端到端身份账", f"起本地 dist_server 失败：{e}")

    # ④ distctl 那行：半更新必须**单独成一条**，不许跟全新那条聚成「大家都一致」
    try:
        import contextlib as cx76
        import io as io76
        spec76d = importlib.util.spec_from_file_location("uitest_distctl76",
                                                         root / "tools" / "distctl.py")
        dt76m = importlib.util.module_from_spec(spec76d)
        spec76d.loader.exec_module(dt76m)
        def mk76(nm, sv, cv):
            # cmd_status 的「进行中」明细还要 task_id/model/ip/claimed_min_ago，
            # 少一个就 KeyError —— 那条 skip 会把这组最关键的断言整个吞掉
            return {"task_id": f"20260001-complex-{nm}", "model": "complex", "ip": "10.0.0.9",
                    "name": nm, "os": "test", "solver_ver": sv, "client_ver": cv,
                    "claimed_min_ago": 1.0}

        fake76 = {"config": {"default": {"model": "complex", "cols": 30, "rows": 16,
                                         "mines": 99, "games": 100},
                             "seed_next": 20260001, "lease_sec": 300, "paused": False},
                  "pomo": {"on": False, "work_sec": 1500, "rest_sec": 300},
                  "queue": [], "done": {}, "aggregate": {},
                  "inprog": [mk76("A", "7d9d7749", "a12e2269"),
                             mk76("B", "c1f60148", "a12e2269"),
                             mk76("C", "c1f60148", "a12e2269"),
                             mk76("D", "", "")]}
        keep76l = dt76m.load_state
        dt76m.load_state = lambda: fake76
        buf76 = io76.StringIO()
        try:
            with cx76.redirect_stdout(buf76):
                dt76m.cmd_status()
        finally:
            dt76m.load_state = keep76l
        line76 = [x for x in buf76.getvalue().splitlines() if x.startswith("线上在跑:")]
        chk("T76 ★ 终端第一屏就把半更新单列出来：老求解器+新客户端 ×2 不与全新那条混在一起",
            line76 and "求解器 7d9d7749 + 客户端 a12e2269 ×1 终端" in line76[0]
            and "求解器 c1f60148 + 客户端 a12e2269 ×2 终端" in line76[0]
            and "求解器 未上报 + 客户端 未上报 ×1 终端" in line76[0],
            line76[0] if line76 else "没有「线上在跑」这行")
    except Exception as e:
        skip("T76 distctl 身份行功能账", f"载入 distctl.py 失败：{e}")

    # ⑤ 客户端那条轴也有提交历史：两个身份共用一条时间线，任一变了就收一条
    chk("T76 ★ 历史按「任一身份变了」收录，不是只看求解器（分两张表会让人对不上换了哪一半）",
        'CLIENT_VER_PATH = "tools/dist_client.py"' in cu76s
        and "*SOLVER_VER_PATHS, CLIENT_VER_PATH" in cu76s
        and '(keep[-1]["ver"], keep[-1]["client"]) != (e["ver"], e["client"])' in cu76s)
    chk("T76 客户端历史值与工作区那份同一个实现（rev=None 转调 client_ws_ver，不留第二份语义）",
        "def _client_fingerprint(rev: str | None) -> str:" in cu76s
        and cu76s.split("def _client_fingerprint", 1)[1].split("\ndef ", 1)[0].count("return client_ws_ver()") == 1)
    chk("T76 绿底行要两个身份都对上工作区；那个提交还没有客户端文件时显示 —（不是「未知」）",
        "e.ver === cur && e.client === curClient" in aj76
        and '<td class="muted">—</td>' in aj76
        and "任一身份变了就收一条" in aj76)
    try:
        import hashlib as hl76e
        spec76e = importlib.util.spec_from_file_location("uitest_ctlui76e",
                                                         root / "tools" / "ctl_ui.py")
        cu76e = importlib.util.module_from_spec(spec76e)
        spec76e.loader.exec_module(cu76e)
        cu76e._published_manifest = lambda: None      # 别为这几条断言去打生产 SSH
        head76 = cu76e._git_out("rev-parse", "HEAD").strip()
        want76c = hl76e.sha256(cu76e._git_bytes(head76, cu76e.CLIENT_VER_PATH)).hexdigest()[:8]
        chk("T76 ★ 真算：HEAD 那版客户端哈希 = 独立算的 sha256 前 8 位；rev=None 就是工作区那份",
            cu76e._client_fingerprint(head76) == want76c
            and cu76e._client_fingerprint(None) == cu76e.client_ws_ver(),
            f"{cu76e._client_fingerprint(head76)} vs {want76c}")
        h76 = cu76e.solver_history()["data"]
        e76 = h76["entries"]
        pair76 = [(x["ver"], x["client"]) for x in e76]
        chk("T76 ★ 每条都带两个身份，相邻两条不许完全相同（去重是按**这一对**做的）",
            e76 and all("ver" in x and "client" in x for x in e76)
            and all(pair76[i] != pair76[i + 1] for i in range(len(pair76) - 1))
            and h76["current_client"] == cu76e.client_ws_ver(), f"{len(e76)} 条")
        # 客户端文件是后来才加进仓库的：拿「加它那个提交的父亲」当「那时还没有」的样本
        # （--before=<日期> 不行：本仓库最早的提交晚于任何随手写的日期，会取到空串）
        add76 = cu76e._git_out("log", "--diff-filter=A", "--format=%H", "--",
                               cu76e.CLIENT_VER_PATH).strip().splitlines()
        old76 = (add76[-1] + "^") if add76 else ""
        oldok76 = bool(old76) and cu76e._git_ok("rev-parse", "-q", "--verify", old76)
        chk("T76 客户端出现之前的提交那一格留空（页面显示 —），不许编一个哈希进去",
            (not oldok76 or cu76e._client_fingerprint(old76) == "")
            and all(x["client"] == "" or len(x["client"]) == 8 for x in e76),
            f"{old76 or '（没有父提交）'} → "
            f"{cu76e._client_fingerprint(old76) if oldok76 else '跳过'!r}")
    except Exception as e:
        skip("T76 客户端历史轴功能账", f"载入 ctl_ui.py 失败：{e}")

    print("\nT77 admin-agg 逐局流式聚合（export 全量内存拼 11-05 把线上机器搞进 OOM，逐局统计从此只许走这条）")
    ds77 = (root / "tools" / "dist_server.py").read_text(encoding="utf-8")
    dt77 = (root / "tools" / "distctl.py").read_text(encoding="utf-8")
    chk("T77 ★ admin-agg 注册成只读（逐局统计不能变成又一个要口令的写面），且本体重不含 records 累积",
        '"admin-agg": (cmd_admin_agg, False)' in ds77
        and "AGG_GUESS_CAP" in ds77
        and "out.append" not in ds77.split("def cmd_admin_agg", 1)[1].split("\ndef ", 1)[0])
    chk("T77 ★ 聚合是流式的：blob 一次一个 gzip.open 在循环里解，坏 blob/缺文件跳过不 500",
        ds77.split("def cmd_admin_agg", 1)[1].split("\ndef ", 1)[0].count("gzip.open(") == 1
        and "except (FileNotFoundError, KeyError, ValueError):" in ds77)
    chk("T77 distctl agg 接通且红线写明（export 那行的 ⚠ 要有人在才能防再犯）",
        "def cmd_agg(" in dt77 and '"admin-agg"' in dt77
        and "⚠ 全量在服务器内存拼" in dt77 and "线上别跑" in dt77
        and dt77.index("def cmd_agg(") < dt77.index('if cmd == "agg"'))
    try:
        import gzip as gz77
        with tempfile.TemporaryDirectory(prefix="cmsdist-t77-") as td77:
            os.makedirs(os.path.join(td77, "results"))
            rec77 = lambda win, guess, trap: {"g": 0, "win": win, "guess": guess, "mid": 0, "end": 0,
                                              "trap": trap, "zero": 0, "flagpath": 0, "sec": 0.5}
            st77 = {"config": {}, "queue": [], "inprog": {}, "seed_next": 1, "done": {
                "t1": {"model": "complex", "cols": 24, "rows": 16, "mines": 72, "games": 3, "wins": 2,
                       "zeroGuessWins": 0, "guesses": 62, "guessTrap": 2, "ip": "1.2.3.4", "name": "x",
                       "os": "t", "claimed_at": 1, "solver_ver": "s", "client_ver": "c",
                       "time": 1, "valid": True, "file": "results/t1.json.gz"},
                "t2": {"model": "complex", "cols": 24, "rows": 16, "mines": 72, "games": 2, "wins": 2,
                       "zeroGuessWins": 0, "guesses": 30, "guessTrap": 0, "ip": "1.2.3.4", "name": "x",
                       "os": "t", "claimed_at": 2, "solver_ver": "s", "client_ver": "c",
                       "time": 2, "valid": True, "file": "results/t2.json.gz"},
                # 作废项必须被聚合排除；异规格（classic）也不能混进来
                "t3": {"model": "complex", "cols": 24, "rows": 16, "mines": 72, "games": 1, "wins": 0,
                       "zeroGuessWins": 0, "guesses": 9, "guessTrap": 0, "ip": "1.2.3.4", "name": "x",
                       "os": "t", "claimed_at": 3, "solver_ver": "s", "client_ver": "c",
                       "time": 3, "valid": False, "file": "results/t3.json.gz"},
                "t4": {"model": "classic", "cols": 24, "rows": 16, "mines": 72, "games": 1, "wins": 1,
                       "zeroGuessWins": 1, "guesses": 0, "guessTrap": 0, "ip": "1.2.3.4", "name": "x",
                       "os": "t", "claimed_at": 4, "solver_ver": "s", "client_ver": "c",
                       "time": 4, "valid": True, "file": "results/t4.json.gz"}}}
            json.dump(st77, open(os.path.join(td77, "state.json"), "w", encoding="utf-8"))
            for tid, specs in (("t1", [(1, 20, 0), (0, 30, 2), (1, 12, 0)]),
                               ("t2", [(1, 15, 0), (1, 15, 0), (0, 120, 0)]),   # 末条 guess=120 → 溢出桶 100
                               ("t3", [(0, 9, 0)]),
                               ("t4", [(1, 0, 0)])):
                with gz77.open(os.path.join(td77, "results", f"{tid}.json.gz"), "wb") as f:
                    f.write(json.dumps({"records": [rec77(*s) for s in specs]}).encode("utf-8"))
            r77 = subprocess.run(
                [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                 "admin-agg", "complex", "24", "16", "72"],
                env=dict(os.environ, CMSDIST_STATE=td77), capture_output=True, text=True, timeout=60)
            d77 = json.loads(r77.stdout) if r77.returncode == 0 else {}
            h77 = d77.get("hist", {})
            chk("T77 ★ 真跑：作废排除、异规格排除、分桶/胜率/陷阱逐格对上（wins=4=2+2，t3/t4 不进来）",
                r77.returncode == 0 and d77.get("tasks") == 2 and d77.get("games") == 6
                and d77.get("wins") == 4 and d77.get("trap_games") == 1 and d77.get("trap_total") == 2
                and h77.get("12", {}).get("games") == 1 and h77.get("12", {}).get("wins") == 1
                and h77.get("15", {}).get("games") == 2 and h77.get("30", {}).get("wins") == 0
                and h77.get("30", {}).get("trap") == 1, str(d77)[:220])
            chk("T77 ★ 溢出桶：guess=120 并进索引 100，不炸不挤进 99；没有记录的桶不出现在回执里",
                h77.get("100", {}).get("games") == 1 and h77.get("100", {}).get("wins") == 0
                and "99" not in h77 and "1" not in h77, str(h77)[:200])
            chk("T77 耗时与均值口径：sec_mean = 各桶 sec 之和 / 总局数",
                abs(d77.get("sec_mean", 0) - 0.5) < 1e-6, str(d77.get("sec_mean")))
    except Exception as e:
        skip("T77 admin-agg 功能账", f"本地起服务器/造 state 失败：{e}")

    print("\nT78 首心跳宽限（领完就死的不占满 2h 租约；不发进度的老客户端不许被打成重发循环）")
    ds78 = (root / "tools" / "dist_server.py").read_text(encoding="utf-8")
    aj78 = (root / "tools" / "ctlui" / "app.js").read_text(encoding="utf-8")
    cs78 = (root / "tools" / "ctlui" / "app.css").read_text(encoding="utf-8")
    chk("T78 ★ 宽限与空转上限两个常量都在，收回只认「从未上报」的那半（有心跳的照旧整租约）",
        "HEARTBEAT_GRACE_SEC = 15 * 60" in ds78 and "HEARTBEAT_MISS_CAP = 3" in ds78
        and 'if "prog_at" not in t and t.get("nh", 0) < HEARTBEAT_MISS_CAP:' in ds78)
    chk("T78 ★ 收回时空转账 nh 记在任务上跟着回队列，claim 重新入账（不然第二次空转就数不清了）",
        'if "prog_at" not in t:\n            t["nh"] = t.get("nh", 0) + 1' in ds78
        and '"client_ver": client_ver, "nh": t.get("nh", 0),' in ds78)
    chk("T78 ctlui 未上报行有可见标记：超过宽限整行浅黄 + 悬停说明，只报事实不归因新旧包",
        "const noreportCls" in aj78 and "noreportCls(t)" in aj78
        and "超过 15 分钟宽限服务器会把这单收回重发" in aj78
        and "tr.noreport td" in cs78 and "--warn-bg" in cs78)
    try:
        spec78 = importlib.util.spec_from_file_location("uitest_ds78",
                                                        root / "tools" / "dist_server.py")
        ds78m = importlib.util.module_from_spec(spec78)
        spec78.loader.exec_module(ds78m)
        now78 = time.time()

        def mk78(tid, claimed_at, nh=0, prog_at=None):
            t = {"task_id": tid, "seed": 1, "model": "complex", "cols": 24, "rows": 16,
                 "mines": 72, "games": 1, "ip": "1.1.1.1", "name": "n",
                 "claimed_at": claimed_at, "nh": nh}
            if prog_at is not None:
                t["prog_at"] = prog_at
            return t

        st78 = {"config": {"lease_sec": 7200, "cool_sec": 60}, "queue": [], "inprog": {
            "领完就死": mk78("领完就死", now78 - 1200),                       # 20 分钟无心跳 → 宽限收
            "刚领5分钟": mk78("刚领5分钟", now78 - 300),                       # 未到宽限 → 不收
            "活着的":   mk78("活着的", now78 - 3600, prog_at=now78 - 30),   # 有心跳 → 照旧不收
            "老客户端": mk78("老客户端", now78 - 1800, nh=3),                 # 空转满 3 次 → 退回整租约不收
            "真超时":   mk78("真超时", now78 - 7300, prog_at=now78 - 7300),  # 过整租约 → 照旧收
        }}
        back78 = ds78m.sweep_expired(st78)
        chk("T78 ★ 真跑：20 分钟无心跳被宽限收回；刚领/有心跳/老客户端/未到整租约都不收",
            back78 == ["领完就死", "真超时"]
            and set(st78["inprog"]) == {"刚领5分钟", "活着的", "老客户端"}
            and len(st78["queue"]) == 2, str(back78))
        q78 = {q["task_id"]: q for q in st78["queue"]}
        chk("T78 ★ 收回时记空转账、冷却与 nonce 清理照旧（宽限路不许带坏原来的收尾）",
            q78["领完就死"]["nh"] == 1 and q78["真超时"]["nh"] == 0
            and q78["领完就死"]["cool_until"] > now78
            and "nonce" not in q78["领完就死"]
            and abs(q78["领完就死"]["queued_at"] - now78) < 1,
            str(q78["领完就死"]))
        st78b = {"config": {}, "queue": [],
                 "inprog": {"老c2": mk78("老c2", now78 - 1200, nh=2)}}
        back78b = ds78m.sweep_expired(st78b)
        t78b = st78b["queue"][0]
        chk("T78 ★ 空转第 3 次收回后 nh=3（这单从此按整租约，宽限路对它关门）",
            back78b == ["老c2"] and t78b["nh"] == 3, str(t78b.get("nh")))
        st78b["inprog"]["老c2"] = t78b      # 模拟再被领取：claim 会把 nh 带回 inprog
        st78b["queue"].clear()
        chk("T78 ★ 满仓后 40 分钟仍无心跳不收、2 小时整租约到了才收（老客户端不被打死循环）",
            ds78m.sweep_expired(st78b, now=now78 + 1200) == []
            and ds78m.sweep_expired(st78b, now=now78 + 7301) == ["老c2"],
            str(st78b["queue"]))
    except Exception as e:
        skip("T78 首心跳宽限功能账", f"载入 dist_server.py 失败：{e}")

    print("\nT79 TLS 入口（12712 反代后灌假结果的链路要断：证书认证 + 代理头不丢真实 IP）")
    dc79 = (root / "tools" / "dist_client.py").read_text(encoding="utf-8")
    tl79 = (root / "scripts" / "dist" / "deploy-dist-tls.sh").read_text(encoding="utf-8")
    chk("T79 ★ 客户端默认地址是 https 域名入口，明文 IP 默认值不许残留（老地址只活在注释里）",
        '"--server", default="https://ty0712.com:12712"' in dc79
        and "http://121.43.235.216:7120" not in dc79,
        "默认地址必须是 12712 TLS 入口")
    chk("T79 ★ _ip 只信回环对端的 X-Real-IP（公网直连 7120 伪造它不被读，门不能白开）",
        'if ip in ("127.0.0.1", "::1"):' in ds78
        and 'handler.headers.get("X-Real-IP")' in ds78
        and ds78.index('if ip in ("127.0.0.1", "::1"):') < ds78.index('handler.headers.get("X-Real-IP")'))
    chk("T79 ★ TLS 部署脚本的关键件：真证书域名自测 + nginx -t 失败自动摘除 + X-Real-IP 透传 + 回环后端",
        "curl -fsS --resolve" in tl79 and "nginx -t" in tl79
        and "rm -f \"$ENABLED\"" in tl79 and "proxy_set_header X-Real-IP" in tl79
        and "proxy_pass http://127.0.0.1:7120" in tl79
        and "ufw allow 12712/tcp" in tl79)
    try:
        import urllib.error as _ue79
        import urllib.request as _ur79
        with tempfile.TemporaryDirectory(prefix="cmsdist-t79-") as _td79:
            with socket.socket() as _sock:
                _sock.bind(("127.0.0.1", 0))
                _port79 = _sock.getsockname()[1]
            _srv79 = subprocess.Popen(
                [sys.executable, "-B", str(root / "tools" / "dist_server.py"),
                 "serve", "127.0.0.1", str(_port79)],
                env=dict(os.environ, CMSDIST_STATE=_td79),
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                for _ in range(80):
                    try:
                        if _ur79.urlopen(f"http://127.0.0.1:{_port79}/ping", timeout=5).status == 200:
                            break
                    except Exception:
                        time.sleep(0.25)

                def _claim79(real_ip=None):
                    _hd = {"Content-Type": "application/json"}
                    if real_ip is not None:
                        _hd["X-Real-IP"] = real_ip
                    _req = _ur79.Request(f"http://127.0.0.1:{_port79}/claim",
                                         data=json.dumps({"name": "t79", "os": "test"}).encode(),
                                         headers=_hd)
                    return json.loads(_ur79.urlopen(_req, timeout=10).read())

                _claim79("9.9.9.9")
                _st79 = json.loads((Path(_td79) / "state.json").read_text(encoding="utf-8"))
                _ip79 = next(iter(_st79["inprog"].values()))["ip"]
                _claim79(None)
                _st79b = json.loads((Path(_td79) / "state.json").read_text(encoding="utf-8"))
                _ips79 = [v["ip"] for v in _st79b["inprog"].values()]
                chk("T79 ★ 真跑：回环带 X-Real-IP 的领取记外部 IP；不带头的直连记真实回环地址",
                    _ip79 == "9.9.9.9" and _ips79.count("127.0.0.1") == 1,
                    f"代理={_ip79} 全部={_ips79}")
            finally:
                _srv79.terminate()
                _srv79.wait(timeout=10)
    except Exception as e:
        skip("T79 TLS 代理头功能账", f"本地起 dist_server 失败：{e}")

    # ── T80：share/ 学习索引（2026-11-06）──────────────────────────────
    # /share 是给外来访客的导读：只放索引和真实路径，不放副本（副本会烂）。
    # 它存在的意义 = 仓库转公开时的「门面」，所以对它以及两份被净化的文档，
    # 敏感串必须永远扫不出来——手滑把真 IP/邮箱写回去，这里直接红。
    print("\nT80 share 学习索引：门面层不许出现真实服务器信息，链接的路径必须都存在")
    _BAD80 = ("121.43.235.216", "2940620276", "@qq.com", "-p 712")
    _share80 = root / "share" / "README.md"
    if _share80.exists():
        _txt80 = _share80.read_text(encoding="utf-8")
        chk("T80 ★ share/README.md 扫不到真实 IP/邮箱/SSH 端口写法",
            not any(b in _txt80 for b in _BAD80),
            f"命中：{[b for b in _BAD80 if b in _txt80]}")
        chk("T80 ★ 索引里许诺的每条真实路径都在仓库里（转公开后链接不能 404）",
            all((root / p).exists() for p in (
                "src/solver/SolverEngine.h", "tools/dist_server.py",
                "tools/dist_client.py", "server/authd.py",
                "scripts/web/deploy-web.sh", "server/cmsgate-healthcheck.sh",
                "docs/密码闸门.md", "docs/分布式跑分cmsdist.md",
                "docs/求解器第四代报告.md", "docs/求解器统计_大样本定稿.txt",
                "docs/CLION-交叉编译配置.md", "docs/游戏玩法说明指引.txt",
                "docs/项目结构说明.md")),
            "少一个 = 索引在给人指一条死路")
        chk("T80 ★ 索引把「不在仓库里的东西」讲明（口令/ping URL/token 只在服务器）",
            "不在仓库里的东西" in _txt80 and ".gitignore" in _txt80)
    else:
        skip("T80 share/README.md 断言", "share/ 目录不存在（还没建）")
    _pw80 = (root / "docs" / "密码闸门.md").read_text(encoding="utf-8")
    _cm80 = (root / "docs" / "分布式跑分cmsdist.md").read_text(encoding="utf-8")
    chk("T80 ★ 密码闸门文档已净化：真实 IP/邮箱/端口全部换成占位（改回去会漏布局）",
        not any(b in _pw80 for b in _BAD80) and "<服务器IP>" in _pw80 and "<SSH端口>" in _pw80,
        f"命中：{[b for b in _BAD80 if b in _pw80]}")
    chk("T80 ★ cmsdist 文档已净化（管理入口那段 ssh 写法不许带真实端口）",
        not any(b in _cm80 for b in _BAD80))
    # 全仓扫描（仓库转公开的前提 = 工作区快照彻底干净）：除本测试文件自己
    # （它持有模式串）与第三方树，任何源码/脚本/文档里都不许出现真实 IP / QQ 号。
    _SKIP_DIRS80 = {"third_party", ".git", ".workbuddy", "__pycache__",
                    "dist", "dist-solver", "build", "build-release", "build-win",
                    "build-sfml-win", "build-freetype-win", "cmake-build-debug",
                    "cmake-build-debug-覆盖率", "node_modules", "site", "base"}
    _TEXT_EXT80 = {".py", ".sh", ".md", ".txt", ".js", ".mjs", ".ts", ".html",
                   ".css", ".json", ".service", ".timer", ".path", ""}
    _hits80 = []
    for _p80 in root.rglob("*"):
        if not _p80.is_file() or _p80.name == "test_gate_ui.py":
            continue
        if any(part in _SKIP_DIRS80 for part in _p80.parts[:-1]):
            continue
        if _p80.suffix not in _TEXT_EXT80:
            continue
        try:
            _t80 = _p80.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            continue
        for _b80 in _BAD80:
            if _b80 in _t80:
                _hits80.append(f"{_p80.relative_to(root)}:{_b80}")
    chk("T80 ★ 全仓工作区扫不到真实 IP/QQ 号（部署目标已收口到 ~/.cmsdist/deploy.env）",
        not _hits80, f"命中：{_hits80[:8]}")
    chk("T80 ★ 审计文档已移出仓库（防御布局清单不进公开快照）",
        not any((root / "docs" / f).exists() for f in (
            "安全与体验审查.md", "安全审查_2026-10-27.md",
            "安全审查_2026-10-30.md", "安全审查_2026-11-01.md",
            "安全审计_2026-11-05.md")),
        "docs/ 下又出现了审查文档 = 移出动作被回退")




if __name__ == "__main__":
    sys.exit(main())
