#!/usr/bin/env python3
"""桌面端顶栏几何探针：D-1（OPACITY 压复选框 / 滑块命中区劫持点击）。

为什么需要它
------------
2026-10-16 用户修好D-1 后在待办里留了一句话：
「桌面端**未做运行时截图验证**（需人工点到高级难度才落在重叠区间）」。

桌面端没有网页端那样的 `window.__game.renderer` 调试句柄，截图又慢又会被沙箱杀，
所以这里改用**数值探针**：把 `Renderer.cpp` 里的坐标公式原样搬过来，
在若干窗口宽度下算出各矩形的实际位置并两两求交。

⚠️ **铁律：几何必须按源码公式算，不能手编。**
   网页端 `header-overlap.mjs` 我第一版给芯片编造了固定宽度，于是先报「全绿」（假绿）、
   修完又报「没修好」（假红），白跑十几轮。这里必须守住同一条。

⚠️ **必须有反向验证**：探针自身要能「复现出修复前的 bug」，
   否则「全都✓」可能只是算错了。脚本末尾就做了这个对照。

怎么用
------
    python3 tools/desktop_header_probe.py            # 验证当前公式
    python3 tools/desktop_header_probe.py --show-old # 同时打印修复前的对照
"""

import sys

# ── 以下常量必须与 src/desktop/Renderer.cpp 的 layoutFor() 保持一致 ──
# 改动那里的行位时这里要一起改，否则探针会说谎（它会报「全绿」而产品其实有问题）。
HEADER_H = 138.0        # Renderer.cpp:291  headerH
BOX_SZ = 16.0# 复选框边长
LABEL_GAP = 12.0        # kLabelGap
PAD = 12.0              # pad

# 中文字宽。桌面上走 PingFang 12px，这里取保守值（放大 5%）——
# **宁可探针偏严**，也不要放过真实重叠。
_W_MAG = 90.0 * 1.05    # "总是显示模长"
_W_HIDE = 60.0 * 1.05   # "隐藏计数"
_W_USTC = 100.0 * 1.05  # "红专并进 理实交融"


def ustc_rects(win_w: float) -> dict:
    """复制 Renderer::ustcRects()。三个复选框右对齐，按 winW 排布。"""
    right = win_w - 18.0
    box = (right - _W_USTC - 6.0 - BOX_SZ, HEADER_H - 29.0, BOX_SZ, BOX_SZ)
    lab = (box[0] + BOX_SZ + 6.0, HEADER_H - 31.0, _W_USTC, 20.0)
    hb = (box[0] - LABEL_GAP - 22.0 - _W_HIDE, HEADER_H - 29.0, BOX_SZ, BOX_SZ)
    hl = (hb[0] + BOX_SZ + 6.0, HEADER_H - 31.0, _W_HIDE, 20.0)
    mb = (hb[0] - LABEL_GAP - 22.0 - _W_MAG, HEADER_H - 29.0, BOX_SZ, BOX_SZ)
    ml = (mb[0] + BOX_SZ + 6.0, HEADER_H - 31.0, _W_MAG, 20.0)
    return {"ustcBox": box, "ustcLabel": lab, "hideBox": hb,
            "hideLabel": hl, "magBox": mb, "magLabel": ml}


def bg_value(fixed: bool = True):
    """OPACITY 数字框。修复后 y=88 高 18（原86/26）。"""
    return (566.0, 88.0, 34.0, 18.0) if fixed else (566.0, 86.0, 34.0, 26.0)


def bg_hit_zone(win_w: float, fixed: bool = True):
    """轨道命中区。修复后下沿钳在 headerH-32（原不钳）。"""
    track_x = 604.0
    track_w = max(30.0, win_w - 10.0 - track_x)
    top = 96.0 - 9.0
    bottom = min(top + 8.0 + 18.0, HEADER_H - 32.0) if fixed else top + 8.0 + 18.0
    return (track_x, top, track_w, max(0.0, bottom - top))


def overlap(a, b) -> float:
    """两个矩形 (x, y, w, h) 的重叠面积；不相交返回 0。"""
    ox = min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])
    oy = min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1])
    return min(ox, oy) if ox > 0 and oy > 0 else 0.0


# 宽度范围覆盖两类：窄窗（顶栏挤）与宽窗（复选框右对齐滑到滑块正下方）。
WIDTHS = (800, 850, 900, 950, 1000, 1100, 1200, 1400, 1600, 1920)


def check(fixed: bool) -> tuple[int, list]:
    bad = 0
    rows = []
    for w in WIDTHS:
        R = ustc_rects(w)
        bv = bg_value(fixed)
        bh = bg_hit_zone(w, fixed)
        worst, who = 0.0, "—"
        for cname, cr in R.items():
            for tname, tr in (("bgValue", bv), ("bgHitZone", bh)):
                o = overlap(tr, cr)
                if o > worst:
                    worst, who = o, f"{tname} × {cname}"
        if worst > 0:
            bad += 1
        rows.append((w, bv, bh, R, worst, who))
    return bad, rows


def main() -> int:
    show_old = "--show-old" in sys.argv

    print("桌面端顶栏几何探针（D-1）")
    print("winW".ljust(8) + "bgValue.y".ljust(16) + "命中区.y".ljust(16)
          + "复选框行.y".ljust(16) + "结果")
    print("─" * 74)

    bad, rows = check(fixed=True)
    for w, bv, bh, R, worst, who in rows:
        res = "✅" if worst == 0 else f"❌ {worst:.0f}px ({who})"
        print(f"{w:<8}"
              f"[{bv[1]:.0f},{bv[1] + bv[3]:.0f}]".ljust(16)
              + f"[{bh[1]:.0f},{bh[1] + bh[3]:.0f}]".ljust(16)
              + f"[{R['magBox'][1]:.0f},{R['magBox'][1] + BOX_SZ:.0f}]".ljust(16)
              + res)
    print()

    # ★ 反向验证：探针必须能复现出修复前的 bug，否则「全绿」只是算错了。
    if show_old:
        print("—— 对照：修复前（bgValue 高 26、命中区下沿不钳）——")
        obad, orows = check(fixed=False)
        for w, bv, bh, R, worst, who in orows:
            if worst > 0:
                print(f"  winW={w:<6} {worst:.0f}px  ({who})")
        reproduced = obad > 0
        print(f"  探针能复现旧 bug: {'✅ 是' if reproduced else '❌ 否——探针可能算错了'}")
        if not reproduced:
            return 2
        print()

    if bad == 0:
        print(f"✅ 当前公式：{len(WIDTHS)} 个宽度全部无重叠（bgValue 与滑块命中区都不碰复选框行）")
        return 0
    print(f"❌ 有 {bad} 个宽度存在重叠")
    return 1


if __name__ == "__main__":
    sys.exit(main())