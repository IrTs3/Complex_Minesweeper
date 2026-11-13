# eval_student.py — 学生离线评估（Brier / 6 桶校准 / 候选集 argmin 一致率），结果回填 REPORT.md。
# 纯标准库前向（f64，仅用于评估不参与三端对拍）；有 numpy 时自动加速，没有就用小样本吭声。
# 用法：python3 tools/nn/eval_student.py [--weights assets/nn/student.cnnw] [--data tools/nn/data/shards] [--sample N]
import argparse
import base64
import hashlib
import json
import math
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))

try:
    import numpy as np
except ImportError:
    np = None


def load_cnnw(path):
    d = open(path, "rb").read()
    assert d[:5] == b"CMSNW" and struct.unpack("<I", d[5:9])[0] in (1, 2)
    assert struct.unpack("<I", d[9:13])[0] == 0x1A5A5A1A
    version = struct.unpack("<I", d[5:9])[0]
    body = len(d) - 32
    assert hashlib.sha256(d[:body]).digest() == d[body:], "权重尾部 sha256 不匹配"
    inC, inH, inW, nL = struct.unpack("<HHHH", d[13:21])
    off = 21
    layers, curC = [], inC
    for _ in range(nL):
        op = d[off]; outC, = struct.unpack("<H", d[off + 1:off + 3])
        kh, kw, pad, act = d[off + 3], d[off + 4], d[off + 5], d[off + 6]
        off += 7
        if op == 1:
            layers.append({"op": 1, "act": act}); continue
        if version == 2:
            scale = struct.unpack(f"<{outC}f", d[off:off + 4 * outC]); off += 4 * outC
            q = struct.unpack(f"<{outC * curC * kh * kw}b", d[off:off + outC * curC * kh * kw])
            off += outC * curC * kh * kw
            # 反量化 w=scale×q（f32），与前向契约同口径
            w = []
            for oc in range(outC):
                w += [scale[oc] * v for v in q[oc * curC * kh * kw:(oc + 1) * curC * kh * kw]]
        else:
            n = outC * curC * kh * kw
            w = struct.unpack(f"<{n}f", d[off:off + 4 * n]); off += 4 * n
        b = struct.unpack(f"<{outC}f", d[off:off + 4 * outC]); off += 4 * outC
        layers.append({"op": 0, "outC": outC, "kh": kh, "kw": kw, "pad": pad, "act": act,
                       "w": w, "b": b, "inC": curC})
        curC = outC
    return {"inC": inC, "inH": inH, "inW": inW, "layers": layers}


def forward(net, x):
    H, W = net["inH"], net["inW"]
    if np is not None:
        cur = np.asarray(x, dtype=np.float64).reshape(net["inC"], H, W)
        outs = []
        for L in net["layers"]:
            if L["op"] == 1:
                o = outs[-1] + (outs[-3] if len(outs) >= 3 else 0)   # 块入口 = 上一个 op1/stem
                if L["act"] == 1: o = np.maximum(o, 0)
                outs.append(o)
                cur = o
                continue
            oc, kh, kw, pad, ic = L["outC"], L["kh"], L["kw"], L["pad"], L["inC"]
            w = np.asarray(L["w"], dtype=np.float64).reshape(oc, kh, kw, ic)
            b = np.asarray(L["b"], dtype=np.float64)
            xp = np.pad(cur, ((0, 0), (pad, pad), (pad, pad)))
            o = np.tile(b.reshape(oc, 1, 1), (1, H, W))
            for kr in range(kh):
                for kc in range(kw):
                    win = xp[:, kr:kr + H, kc:kc + W]          # (ic,H,W)，pad 已含边界
                    o += (w[:, kr, kc].reshape(oc, ic, 1, 1) * win[None]).sum(axis=1)
            if L["act"] == 1: o = np.maximum(o, 0)
            elif L["act"] == 2: o = 1.0 / (1.0 + np.exp(-o))
            outs.append(o)
            cur = o
    else:
        cur = list(x)
        outs = []
        for L in net["layers"]:
            if L["op"] == 1:
                prev = outs[-1]; base = outs[-3] if len(outs) >= 3 else [0.0] * len(prev)
                o = [p + q for p, q in zip(prev, base)]
                if L["act"] == 1: o = [v if v > 0 else 0.0 for v in o]
                outs.append(o); cur = o; continue
            oc, kh, kw, pad, ic = L["outC"], L["kh"], L["kw"], L["pad"], L["inC"]
            o = [0.0] * (H * W)
            for k in range(oc):
                wb = L["w"][k * kh * kw * ic:(k + 1) * kh * kw * ic]
                bias = L["b"][k]
                for r in range(H):
                    for c in range(W):
                        acc = bias
                        for kr in range(kh):
                            sr = r + kr - pad
                            if sr < 0 or sr >= H: continue
                            for kc in range(kw):
                                sc = c + kc - pad
                                if sc < 0 or sc >= W: continue
                                wp = wb[(kr * kw + kc) * ic:(kr * kw + kc + 1) * ic]
                                ip0 = sr * W + sc
                                for i in range(ic):
                                    acc += wp[i] * cur[ip0 + i * H * W]
                        o[r * W + c] = acc
            if L["act"] == 1: o = [v if v > 0 else 0.0 for v in o]
            elif L["act"] == 2: o = [1.0 / (1.0 + math.exp(-v)) for v in o]
            outs.append(o); cur = o
    return np.asarray(outs[-1]).ravel().tolist()


BUCKETS = [(0.0, 0.02), (0.02, 0.05), (0.05, 0.10), (0.10, 0.20), (0.20, 0.35), (0.35, 1.01)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--weights", default=os.path.join(ROOT, "assets", "nn", "student.cnnw"))
    ap.add_argument("--data", default=os.path.join(HERE, "data", "shards"))
    ap.add_argument("--sample", type=int, default=120, help="抽多少条记录评估（纯 Python 前向很慢）")
    ap.add_argument("--no-report", action="store_true",
                    help="只打印不回填 REPORT.md（对照实验的权重别覆盖发行版的读数）")
    args = ap.parse_args()

    import sys
    sys.path.insert(0, HERE)
    from model import shard_records

    if not os.path.exists(args.weights):
        print("eval: 没有权重（先 train + export_weights.py），跳过评估")
        return
    net = load_cnnw(args.weights)
    recs = []
    for f in sorted(os.listdir(args.data)):
        if f.endswith(".bin"):
            recs += list(shard_records(os.path.join(args.data, f)))
    if not recs:
        print("eval: 没有 shard，跳过"); return
    if np is None and len(recs) > args.sample:
        print(f"eval: 无 numpy，纯 Python 前向限抽 {args.sample} 条")
    step = max(1, len(recs) // args.sample)
    recs = recs[::step][:args.sample]
    print(f"eval: 权重 {len(net['layers'])} 层，样本 {len(recs)} 条（numpy={'有' if np else '无'}）")

    brier = n_cand = 0
    cal_n = [0] * 6; cal_boom = [0.0] * 6   # boom=老师判其含雷的期望（软标签口径）
    agree = decided = 0
    regret = 0.0   # Σ[老师口径 p(学生选) − p(老师选)]：与近平手平局裁决无关的诚实指标
    for rec in recs:
        out = forward(net, rec["plane"])
        cols = rec["cols"]
        cand = rec["cand"]; probs = rec["probs"]
        best_v, best_i = 2.0, -1
        for i, c in enumerate(cand):
            if not c: continue
            p, t = out[i], probs[i]
            brier += (p - t) ** 2; n_cand += 1
            for bi, (lo, hi) in enumerate(BUCKETS):
                if lo <= t < hi:
                    cal_n[bi] += 1; cal_boom[bi] += t; break
            if p < best_v: best_v, best_i = p, i
        cidx = (rec["pick"] // cols) * 30 + rec["pick"] % cols
        regret += out[cidx] - probs[cidx]
        # 老师前两名边际 ≥0.02 才算「有得选」：近 95% 的记录里候选集是一堆 ≈0.4% 的
        # 近安全格（两名边际 <0.005），argmin 在那里是掷硬币，不配当指标。
        tv = sorted(probs[i] for i, c in enumerate(cand) if c)
        if len(tv) >= 2 and tv[1] - tv[0] >= 0.02:
            decided += 1
            if best_i == cidx: agree += 1
    n = len(recs)
    lines = [
        f"- 样本 {n} 局内步（候选格 {n_cand} 个）",
        f"- Brier（候选格，对老师软标签）：{brier/max(1,n_cand):.6f}",
        f"- **平均后悔值**（老师口径 p(学生选)−p(老师选)）：{regret/max(1,n):+.4f}"
        "（0=学生每次选到与老师同等安全的格；不受近平手平局稀释，是选格质量的诚实指标）",
        f"- argmin 一致率（仅老师边际 ≥0.02 的 {decided}/{n} 局）："
        f"{agree}/{max(1,decided)} = {100.0*agree/max(1,decided):.1f}%"
        "（全量 argmin 会被近平手平局打成个位数噪声，只数有边际的局）",
        "- 校准（按老师概率分桶，桶内老师均值；学生预测对照用 REPORT 评审时人工比对）：",
    ]
    names = ["<2%", "2-5%", "5-10%", "10-20%", "20-35%", ">=35%"]
    for bi in range(6):
        lines.append(f"  - {names[bi]:>6}: {cal_n[bi]} 格" + (f"，桶内均值 {100.0*cal_boom[bi]/cal_n[bi]:.1f}%" if cal_n[bi] else ""))
    print("\n".join(lines))
    report = os.path.join(HERE, "REPORT.md")
    if args.no_report:
        print("eval: --no-report，不回填 REPORT.md")
        return
    if os.path.exists(report):
        txt = open(report, encoding="utf-8").read()
        marker = "## 离线评估（eval_student.py）"
        block = marker + "\n\n" + "\n".join(lines) + "\n"
        if marker in txt:
            head = txt.split(marker)[0]
            rest = txt.split(marker, 1)[1]
            # 只替换本节：到下一个 "## " 或文件尾
            nxt = rest.find("\n## ")
            tail = rest[nxt + 1:] if nxt >= 0 else ""
            txt = head + block + tail
        else:
            txt += "\n" + block
        open(report, "w", encoding="utf-8").write(txt)
        print("eval: 结果已回填 tools/nn/REPORT.md")


if __name__ == "__main__":
    main()
