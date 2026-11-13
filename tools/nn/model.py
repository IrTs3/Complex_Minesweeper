# model.py — 学生网络（与 .cnnw 契约逐字对齐，见 dump_format.md）
# v2：stem Conv(10→48,3×3,p1,ReLU) + 6×ResBlock(48) + 1×1 头(48→1,sigmoid)
#     ResBlock：z=ReLU(conv1(x))；y=conv2(z)；out=ReLU(x+y) —— 对应 .cnnw 里
#     conv(act=1) → conv(act=0) → op1(act=1) 三层。
# v3：同宽度，但后段换大核（5×5/7×7）——有效感受野 15 → 47，盖住 16×30 全盘。
#     REPORT 定调「结构性差距在感受野」后的对照实验；关键是 **只用在现有 .cnnw
#     格式词汇内就能表达的算子**（kH/kW 本就是 u8 字段），离线验证后悔值真降了
#     才值得动三端契约；大核只是参数换感受野，不下采样就不碰前向实现。
import torch
import torch.nn as nn

#: v3 的逐块核宽。RF 账：stem 3 + 2×(3+3+3+5+7+7) = 47 ≥ 30（画布宽）
V3_KERNELS = (3, 3, 3, 5, 7, 7)


class Student(nn.Module):
    def __init__(self, ch: int = 10, width: int = 48, blocks: int = 6,
                 kernels: tuple = None):
        super().__init__()
        self.stem = nn.Conv2d(ch, width, 3, padding=1)
        ks = kernels or (3,) * blocks
        self.blocks = nn.ModuleList()
        for k in ks:
            self.blocks.append(nn.ModuleList([
                nn.Conv2d(width, width, k, padding=k // 2),
                nn.Conv2d(width, width, k, padding=k // 2),
            ]))
        self.head = nn.Conv2d(width, 1, 1)
        self.n_params = sum(p.numel() for p in self.parameters())

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = torch.relu(self.stem(x))
        for c1, c2 in self.blocks:
            h = torch.relu(h + c2(torch.relu(c1(h))))
        return torch.sigmoid(self.head(h))  # (N,1,16,30)


def shard_records(shard_path: str):
    """按 dump_format.md §2 解析 shard，惰性产出 dict。"""
    import struct
    import sys
    with open(shard_path, "rb") as f:
        d = f.read()
    if len(d) < 14 or d[:6] != b"CMSST1":
        raise ValueError(f"{shard_path}: 魔数不对")
    cols, rows, mines = struct.unpack("<HHI", d[6:14])
    if cols > 30 or rows > 16:
        raise ValueError(f"{shard_path}: {cols}x{rows} 超出固定画布")
    body = d[14:]
    rec = 19200 + 1920 + 480 + 8
    n = len(body) // rec
    if len(body) % rec:
        # datagen 正在写的 shard 尾部不完整是常态；只出整条记录，吭声不炸
        print(f"{shard_path}: 尾部不完整 {len(body)%rec} 字节，忽略（生成中途的正常现象）",
              file=sys.stderr)
    for i in range(n):
        off = i * rec
        yield {
            "cols": cols, "rows": rows, "mines": mines,
            "plane": struct.unpack(f"<{10*16*30}f", body[off:off + 19200]),
            "probs": struct.unpack(f"<{16*30}f", body[off + 19200:off + 19200 + 1920]),
            "cand": body[off + 19200 + 1920:off + 19200 + 1920 + 480],
            "boardSeed": struct.unpack("<I", body[off + 19200 + 1920 + 480:off + 19200 + 1920 + 484])[0],
            "step": struct.unpack("<H", body[off + 19200 + 1920 + 484:off + 19200 + 1920 + 486])[0],
            "pick": struct.unpack("<H", body[off + 19200 + 1920 + 486:off + rec])[0],
        }
