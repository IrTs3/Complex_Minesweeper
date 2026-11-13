# export_weights.py — state_dict → assets/nn/student.cnnw + 金标 + REPORT 骨架
# 格式契约见 dump_format.md §3（权重序 outC→kH→kW→inC，尾部 sha256；--quant int8 走 v2）。
# 用法：python3 tools/nn/export_weights.py tools/nn/runs/<name>.pt [--verify-golden]
import argparse
import base64
import hashlib
import json
import os
import struct
import subprocess
import sys

import torch

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, HERE)
from model import Student, V3_KERNELS  # noqa: E402


def pack_cnnw(state, quant=False) -> bytes:
    """quant=True 走 v2：权重逐输出通道对称 int8 + f32 scale（bias 保持 f32）。
    消费端反量化 w=scale×q（f32）后前向与 v1 完全同路径，跨端逐位一致。"""
    ch, width, blocks = 10, 48, 6
    out = bytearray()
    out += b"CMSNW" + struct.pack("<II", 2 if quant else 1, 0x1A5A5A1A)
    n_layers = 1 + blocks * 3 + 1
    out += struct.pack("<HHHH", ch, 16, 30, n_layers)

    def emit_conv(ww, bb, act):
        # ww: torch (outC,kH,kW,inC) 已 permute；bb: (outC,)
        nonlocal out
        outC, kH, kW, inC_ = ww.shape
        out.append(0)
        out += struct.pack("<HBBBB", outC, kH, kW, kH // 2, act)
        w = ww.flatten().to(torch.float32).numpy()
        if quant:
            import numpy as np
            wn = w.reshape(outC, -1)
            mx = np.abs(wn).max(axis=1)
            scale = (mx / 127.0).astype(np.float32)
            scale[scale == 0] = 1.0  # 全零通道保位（scale 无所谓，q 全 0）
            q = np.clip(np.round(wn / scale[:, None]), -127, 127).astype(np.int8)
            out += scale.tobytes()
            out += q.tobytes()
        else:
            out += w.tobytes()
        out += bb.to(torch.float32).numpy().tobytes()

    # stem conv(ReLU)
    emit_conv(state["stem.weight"].detach().permute(0, 2, 3, 1).contiguous(),
              state["stem.bias"], 1)
    # blocks: conv(ReLU) → conv(无act) → op1(ReLU)
    for b in range(blocks):
        for j, act in ((0, 1), (1, 0)):
            emit_conv(state[f"blocks.{b}.{j}.weight"].detach().permute(0, 2, 3, 1).contiguous(),
                      state[f"blocks.{b}.{j}.bias"], act)
        out.append(1)
        out += struct.pack("<HBBBB", 0, 0, 0, 0, 1)
    # head conv(1×1, sigmoid)
    emit_conv(state["head.weight"].detach().permute(0, 2, 3, 1).contiguous(),
              state["head.bias"], 2)
    out += hashlib.sha256(out).digest()
    return bytes(out)


def unpack_cnnw(blob) -> dict:
    """pack_cnnw 的逆变换：把 .cnnw 解回 Student 的 state_dict（布局契约见 dump_format.md §3）。
    v2 的 int8 权重在此反量化回 f32——torch 前向与 C++/TS 消费同一组反量化值。"""
    if blob[:5] != b"CMSNW":
        raise ValueError("不是 .cnnw 文件")
    if hashlib.sha256(blob[:-32]).digest() != blob[-32:]:
        raise ValueError("sha256 自校验失败")
    import numpy as np
    version = struct.unpack_from("<I", blob, 5)[0]
    if version not in (1, 2):
        raise ValueError(f"版本不支持：{version}")
    inC, inH, inW, n_layers = struct.unpack_from("<HHHH", blob, 13)
    off = 21
    state = {}
    conv_names = ["stem"] + [f"blocks.{b}.{j}" for b in range(6) for j in (0, 1)] + ["head"]
    ci = 0
    cur = inC
    for _ in range(n_layers):
        op = blob[off]; off += 1
        outC, kH, kW, pad, act = struct.unpack_from("<HBBBB", blob, off); off += 6
        if op == 1:  # 残差占位层不带权重
            continue
        name = conv_names[ci]; ci += 1
        n = outC * kH * kW * cur
        if version == 2:
            scale = np.frombuffer(blob, "<f4", count=outC, offset=off); off += 4 * outC
            q = np.frombuffer(blob, np.int8, count=n, offset=off).reshape(outC, -1)
            off += n
            w = (scale[:, None] * q).reshape(outC, kH, kW, cur).astype(np.float32)
        else:
            w = np.frombuffer(blob, "<f4", count=n, offset=off).reshape(outC, kH, kW, cur)
            off += 4 * n
        state[f"{name}.weight"] = torch.from_numpy(w.transpose(0, 3, 1, 2).copy())
        b = np.frombuffer(blob, "<f4", count=outC, offset=off)
        off += 4 * outC
        state[f"{name}.bias"] = torch.from_numpy(b.copy())
        cur = outC
    return state


def verify_golden(weights_path):
    """三方之一的 PyTorch 侧：对每个 forward 金标 case 重算前向，容差 1e-4。"""
    golden = os.path.join(HERE, "golden", "golden.jsonl")
    model = Student()
    blob = open(weights_path, "rb").read()
    if blob[:5] == b"CMSNW":
        model.load_state_dict(unpack_cnnw(blob))
    else:
        model.load_state_dict(torch.load(weights_path, map_location="cpu", weights_only=True))
    model.eval()
    bad = 0
    with open(golden, encoding="utf-8") as f:
        for line in f:
            case = json.loads(line)
            if case["kind"] != "forward":
                continue
            x = struct.unpack(f"<{10*16*30}f", base64.b64decode(case["inB64"]))
            with torch.no_grad():
                out = torch.flatten(model(torch.tensor(x, dtype=torch.float32).view(1, 10, 16, 30))).tolist()
            err = max(abs(a - b) for a, b in zip(out, case["out"]))
            if err > 1e-4:
                print(f"  ✗ {case['name']}: 最大偏差 {err:.2e}")
                bad += 1
    print(f"verify-golden: {'全过 ✓' if bad == 0 else f'{bad} 个 case 超差 ✗'}")
    return bad == 0


def regenerate_golden(model):
    """金标 forward case：从 shard 里取代表性输入（前/中/后段各一），期望输出=torch。
    encode case：C++ 权威编码器生成（重生成 diff 防漂移）。只随发行位导出重写。"""
    golden_dir = os.path.join(HERE, "golden")
    os.makedirs(golden_dir, exist_ok=True)
    cases = []
    shards_dir = os.path.join(HERE, "data", "shards")
    shards = sorted(os.listdir(shards_dir)) if os.path.isdir(shards_dir) else []
    picks = []
    if shards:
        picks = [shards[len(shards) // 4], shards[len(shards) // 2], shards[-1]]
    from model import shard_records
    for p in picks:
        recs = list(shard_records(os.path.join(shards_dir, p)))
        if not recs:      # 零猜胜局 = 只有 14 字节头的空 shard，取样跳过
            continue
        rec = recs[len(recs) // 2]
        x = list(rec["plane"])
        with torch.no_grad():
            out = torch.flatten(model(torch.tensor(x, dtype=torch.float32).view(1, 10, 16, 30))).tolist()
        cases.append({"kind": "forward", "name": f"shard-{p[:-4]}-mid",
                      "inB64": base64.b64encode(struct.pack(f"<{len(x)}f", *x)).decode(),
                      "out": out})
    cpp = os.path.join(HERE, "gen_encode_golden")
    if os.path.exists(cpp):
        r = subprocess.run([cpp], capture_output=True, text=True)
        if r.returncode == 0:
            cases += [json.loads(l) for l in r.stdout.splitlines() if l.strip()]
        else:
            print(f"export: ⚠ gen_encode_golden 失败：{r.stderr.strip()}（金标缺 encode case）")
    else:
        print("export: ⚠ 没编 gen_encode_golden（g++ -O2 tools/nn/gen_encode_golden.cpp -o tools/nn/gen_encode_golden），金标缺 encode case")
    with open(os.path.join(golden_dir, "golden.jsonl"), "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    print(f"export: 金标 {len(cases)} case → tools/nn/golden/golden.jsonl")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--verify-golden", action="store_true")
    ap.add_argument("--arch", choices=["v2", "v3"], default="v2")
    ap.add_argument("--quant", choices=["none", "int8"], default="none",
                    help="int8=逐输出通道对称量化（v2 格式，权重体积 ~1/4，加载时反量化回 f32）")
    ap.add_argument("--dst", default=None,
                    help="默认 assets/nn/student.cnnw（发行位）；对照实验用 --dst 指别处，别覆盖生产权重")
    args = ap.parse_args()
    if args.verify_golden:
        sys.exit(0 if verify_golden(args.run) else 1)

    model = Student(kernels=V3_KERNELS if args.arch == "v3" else None)
    model.load_state_dict(torch.load(args.run, map_location="cpu", weights_only=True))
    model.eval()
    blob = pack_cnnw(model.state_dict(), quant=args.quant == "int8")
    dst = args.dst or os.path.join(ROOT, "assets", "nn", "student.cnnw")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "wb") as f:
        f.write(blob)
    print(f"export: {dst}  {len(blob)/1024:.0f} KB  sha256={hashlib.sha256(blob).hexdigest()[:16]}…")

    if args.dst:
        # 实验导出：金标跟着发行位走，重定向仓库金标会把 v3 期望输出盖到 v2 头上
        print("export: --dst 实验导出，跳过金标重生成（金标只随发行位更新）")
    else:
        regenerate_golden(model)

    report = os.path.join(HERE, "REPORT.md")
    if not os.path.exists(report):
        with open(report, "w", encoding="utf-8") as f:
            f.write("# 学生网络 REPORT（每次重训覆盖三件套：权重+金标+本文件）\n\n"
                    "- 状态：待训练\n- 由 export_weights.py 生成骨架，eval_student.py 回填\n")


if __name__ == "__main__":
    main()
