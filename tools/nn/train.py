# train.py — 学生训练（Mac MPS / CPU 回退）。无 torch 时吭声 exit 0（不红测试）。
# 用法：python3 tools/nn/train.py [--data tools/nn/data/shards] [--epochs N] [--out tools/nn/runs/<name>.pt] [--smoke]
import argparse
import math
import os
import random
import struct
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

try:
    import torch
    import torch.nn as nn
except ImportError:
    print("train: 本机没有 PyTorch —— 训练是可选步骤，跳过（exit 0）。装法见 tools/nn/REPORT.md。")
    sys.exit(0)

import numpy as np  # noqa: E402  torch 的依赖，有 torch 就有

from model import Student, V3_KERNELS  # noqa: E402


def load_dataset(data_dir: str, limit: int = 0):
    """numpy 分块加载：shard 记录定长 21608B（plane 19200B + probs 1920B + cand 480B + 尾 8B）。
    不能走 shard_records 的 Python tuple——6 万样本按 float 对象存要 ~35GB，numpy 全量 ~1.2GB。
    顺带取 cand/pick/cols：排序损失要老师选格与候选 mask，翻转增广要逐记录棋盘列宽。"""
    import numpy as np
    REC, PLANE_B, PROBS_B, CAND_B = 21608, 19200, 1920, 480
    files = sorted(os.path.join(data_dir, f) for f in os.listdir(data_dir) if f.endswith(".bin"))
    if not files:
        raise SystemExit(f"train: {data_dir} 里没有 shard，先跑 generate_data.sh")
    px, py, pc, pp, pw, total = [], [], [], [], [], 0
    for p in files:
        with open(p, "rb") as f:
            d = f.read()
        if len(d) < 14 or d[:6] != b"CMSST1":
            continue
        n = (len(d) - 14) // REC
        if not n:
            continue  # 零猜胜局空 shard
        rows = np.frombuffer(d, dtype=np.uint8, count=n * REC, offset=14).reshape(n, REC)
        px.append(rows[:, :PLANE_B].copy().view(np.float32).reshape(n, PLANE_B // 4))
        py.append(rows[:, PLANE_B:PLANE_B + PROBS_B].copy().view(np.float32).reshape(n, PROBS_B // 4))
        pc.append(rows[:, PLANE_B + PROBS_B:PLANE_B + PROBS_B + CAND_B])
        # 尾 8B = boardSeed(4) + step(2) + pick(2)，pick 是 rows×cols 线性号
        pp.append(rows[:, REC - 2:REC].copy().view(np.uint16).reshape(n))
        pw.append(np.full(n, struct.unpack("<H", d[6:8])[0], dtype=np.uint16))
        total += n
        if limit and total >= limit:
            break
    x = np.concatenate(px)[:limit or None]
    y = np.concatenate(py)[:limit or None]
    cand = np.concatenate(pc)[:limit or None]
    pick = np.concatenate(pp)[:limit or None]
    cols = np.concatenate(pw)[:limit or None]
    return x, y, cand, pick, cols


def flip_record(plane, probs, candm, pick, cols):
    """水平镜像单个记录（棋盘列宽范围内，画布左上对齐不动盘位）。
    plane (10,16,30) / probs (16,30) / cand (16,30) / pick=rows×cols 线性号。
    全局通道 c7-c9 是逐盘常数，镜像不变；盘外格恒零也不受影响。"""
    c = int(cols)
    plane[:, :, :c] = plane[:, :, c - 1::-1]
    probs[:, :c] = probs[:, c - 1::-1]
    candm[:, :c] = candm[:, c - 1::-1]
    r, cc = divmod(int(pick), c)
    return r * c + (c - 1 - cc)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(HERE, "data", "shards"))
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--batch", type=int, default=64)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--val-frac", type=float, default=0.05)
    ap.add_argument("--limit", type=int, default=0, help="只取前 N 条记录（smoke 用）")
    ap.add_argument("--arch", choices=["v2", "v3"], default="v2",
                    help="v3=大核扩感受野（对照实验，见 REPORT「读数解读」第 3 条）")
    ap.add_argument("--clip", type=float, default=0.0,
                    help="梯度范数裁剪上限，0=关。大核块对尖峰敏感（lr 2e-3 下十步内"
                         "整网 ReLU 死透、loss 冻成常数，2026-11-09 实录）；v3 配 1.0")
    ap.add_argument("--warmup", type=int, default=0,
                    help="前 N 步线性爬升到目标 lr（0=关）。MPS 上 v3 早期步有数值悬崖："
                         "步序/洗牌运气不好时头几百步内整网 ReLU 死透（各 1-epoch 金丝雀"
                         "2026-11-09 实录）；warmup 300 + clip 是治这个的组合拳")
    ap.add_argument("--flip", action="store_true",
                    help="训练集水平镜像增广（虚拟翻倍不占双倍内存；验证集不混入防泄漏）")
    ap.add_argument("--rank-lambda", type=float, default=0.0,
                    help="选格排序损失权重（0=关）。只对老师前两名边际 ≥0.02 的局算 hinge："
                         "惩罚学生把老师最优格排在其他候选格之后——消费端是 argmin，"
                         "逐格 MSE 拟合概率不直接管排序")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    name = args.out or os.path.join(HERE, "runs", time.strftime("%Y%m%d-%H%M%S") + ".pt")
    print(f"train: device={dev} epochs={args.epochs} batch={args.batch}"
          f" flip={args.flip} rankλ={args.rank_lambda} → {name}")

    t0 = time.time()
    xs, ys, cs, pks, cols = load_dataset(args.data, args.limit)
    n0 = len(xs)
    idx = list(range(n0))
    random.Random(20261107).shuffle(idx)
    n_val = max(1, int(n0 * args.val_frac))
    vi, ti = idx[:n_val], idx[n_val:]
    if args.flip:
        # 虚拟区间 [n0, 2n0) = 镜像副本，只在训练集上展开；val 停留原始区间
        ti = ti + [i + n0 for i in ti]
    print(f"train: 样本 {n0} 条（train {len(ti)} / val {n_val}），加载 {time.time()-t0:.0f}s")

    def batch(idxs):
        fl = [j >= n0 for j in idxs]
        o = [j - n0 if j >= n0 else j for j in idxs]
        xn = xs[o].reshape(-1, 10, 16, 30)
        yn = ys[o].reshape(-1, 16, 30)
        cn = cs[o].reshape(-1, 16, 30).copy()
        pn = pks[o].copy()
        for k, f in enumerate(fl):
            if f:
                pn[k] = flip_record(xn[k], yn[k], cn[k], pn[k], cols[o[k]])
        x = torch.from_numpy(xn)
        y = torch.from_numpy(yn).unsqueeze(1)
        cand = torch.from_numpy(cn.reshape(len(o), -1)).bool()
        # pick（游戏坐标）→ 画布坐标 (r·30+c)
        pickc = (pn // cols[o]) * 30 + pn % cols[o]
        pick = torch.from_numpy(pickc.astype(np.int64))
        return x.to(dev), y.to(dev), cand.to(dev), pick.to(dev)

    model = Student(kernels=V3_KERNELS if args.arch == "v3" else None).to(dev)
    print(f"train: arch={args.arch} 参数量 {model.n_params/1e4:.1f} 万")
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr)
    base_lr = args.lr
    if args.warmup:
        # warmup 路径完全手工逐步调度（线性爬升→cosine 衰减），不与 CosineAnnealingLR
        # 混用——它的增量公式会被手工写 lr 带偏（实测 epoch 末 lr 直接归 0）。
        steps_per_ep = (len(ti) + args.batch - 1) // args.batch
        total_steps = args.epochs * steps_per_ep

        def lr_at(t):
            if t < args.warmup:
                return base_lr * (t + 1) / args.warmup
            tt = (t - args.warmup) / max(1, total_steps - args.warmup)
            return base_lr * 0.5 * (1.0 + math.cos(math.pi * tt))
    else:
        sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=args.epochs)
    gstep = 0
    best = math.inf
    for ep in range(args.epochs):
        model.train()
        random.shuffle(ti)
        tot = n = 0
        for k in range(0, len(ti), args.batch):
            if args.warmup:
                opt.param_groups[0]["lr"] = lr_at(gstep)
            gstep += 1
            x, y, cand, pick = batch(ti[k:k + args.batch])
            pred = model(x)
            loss = ((pred - y) ** 2).mean()  # MSE 对软概率目标（BCE 会逼成硬标签）
            if args.rank_lambda > 0:
                ps = pred.squeeze(1).flatten(1)          # (B,480) 学生概率
                pt = y.squeeze(1).flatten(1)             # (B,480) 老师概率
                cm = cand                                 # (B,480) bool
                p_pick = ps.gather(1, pick.unsqueeze(1))  # (B,1)
                big = torch.full_like(pt, 1e9)
                t2 = torch.where(cm, pt, big).topk(2, dim=1, largest=False).values
                decided = ((t2[:, 1] - t2[:, 0] >= 0.02)
                           & cm.gather(1, pick.unsqueeze(1)).squeeze(1))
                hinge = (torch.relu(ps - p_pick) * cm).sum(1) / cm.sum(1).clamp(min=1)
                if decided.any():
                    loss = loss + args.rank_lambda * hinge[decided].mean()
            opt.zero_grad(); loss.backward()
            if args.clip:
                torch.nn.utils.clip_grad_norm_(model.parameters(), args.clip)
            opt.step()
            tot += loss.item() * len(x); n += len(x)
        model.eval()
        vl = vn = 0
        with torch.no_grad():
            for k in range(0, len(vi), args.batch):
                x, y, _, _ = batch(vi[k:k + args.batch])
                # 验证按候选格算：学生只在候选格被消费（argmin），全盘 MSE 会稀释
                pred = model(x)
                vl += ((pred - y) ** 2).sum().item(); vn += y.numel()
        sched.step() if not args.warmup else None
        val = vl / vn
        marker = ""
        if val < best:
            best = val
            os.makedirs(os.path.dirname(name), exist_ok=True)
            torch.save(model.state_dict(), name)
            marker = "  ★已存"
        print(f"  epoch {ep+1}/{args.epochs}  train {tot/n:.6f}  val(cand) {val:.6f}{marker}", flush=True)
    print(f"train: 完成，最佳 val {best:.6f} → {name}")


if __name__ == "__main__":
    main()
