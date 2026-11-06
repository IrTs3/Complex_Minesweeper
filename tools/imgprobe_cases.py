#!/usr/bin/env python3
"""imgprobe_cases.py —— 现场生成畸形图片样本，驱动 `imgprobe --gate` 验证闸门判定。

为什么不用仓库里放几个 fixture 文件：
  1. 二进制样本进 git 会让人「看不见里面是什么」，而这里每一个字节都有含义；
  2. 炸弹图的威力就在「文件很小、声明的尺寸很大」，必须在脚本里一眼看得出这个对比。

用法：
    python3 tools/imgprobe_cases.py                 # 在临时目录里造样本并断言判定
    python3 tools/imgprobe_cases.py --emit <dir>    # 把样本落到指定目录（给启动烟测用）
    IMGPROBE_BIN=build-asan/imgprobe python3 tools/imgprobe_cases.py

退出码：0 = 全部符合预期；1 = 有不符合；2 = 找不到 imgprobe 可执行文件。
"""
from __future__ import annotations

import base64
import os
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

# 一个真正的 1×1 透明 PNG（IHDR 里确实是 1×1，CRC 也是对的）。
REAL_PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
    "+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
)


def patch_png_size(data: bytes, w: int, h: int) -> bytes:
    """把 IHDR 里的宽高改掉（CRC 故意不修 —— 闸门不该依赖 CRC，
    真正的攻击文件也是「声明巨大、内容极小」）。"""
    b = bytearray(data)
    assert b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR"
    b[16:20] = struct.pack(">I", w)
    b[20:24] = struct.pack(">I", h)
    return bytes(b)


def gif(w: int, h: int) -> bytes:
    return b"GIF89a" + struct.pack("<HH", w, h) + b"\x00\x00\x00"


def bmp_info(w: int, h: int) -> bytes:
    out = bytearray(54)
    out[0:2] = b"BM"
    struct.pack_into("<I", out, 14, 40)          # INFOHEADER
    struct.pack_into("<i", out, 18, w)
    struct.pack_into("<i", out, 22, h)
    return bytes(out)


def jpeg_truncated() -> bytes:
    """段长声明 0xFFFF，但文件在段内就结束 —— 必须判截断，不能死循环。"""
    return bytes([0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xFF, 0x00, 0x00])


def build_cases(tmp: Path) -> list[tuple[str, Path, str]]:
    """返回 [(说明, 路径, 期望的 imgprobe 输出前缀)]"""
    cases: list[tuple[str, Path, str]] = []

    p = tmp / "ok.png"
    p.write_bytes(REAL_PNG_1X1)
    cases.append(("真 1×1 PNG", p, "OK 1x1"))

    p = tmp / "bomb.png"
    p.write_bytes(patch_png_size(REAL_PNG_1X1, 20000, 20000))
    cases.append(
        (
            f"炸={p.stat().st_size}B 声明 20000×20000（旧代码会申请 ~2.1GB）",
            p,
            "REJECT oversize 20000x20000",
        )
    )

    p = tmp / "huge.png"
    p.write_bytes(patch_png_size(REAL_PNG_1X1, 40000, 40000))
    cases.append(("声明 40000×40000（stb 自己也会拒）", p, "REJECT oversize"))

    p = tmp / "trunc.png"
    p.write_bytes(REAL_PNG_1X1[:8])
    cases.append(("只有 PNG 签名（8 字节）", p, "REJECT truncated"))

    p = tmp / "badihdr.png"
    b = bytearray(REAL_PNG_1X1)
    b[12:16] = b"XXXX"
    p.write_bytes(bytes(b))
    cases.append(("首块不是 IHDR", p, "REJECT invalid-header"))

    p = tmp / "ok.gif"
    p.write_bytes(gif(3, 4))
    cases.append(("GIF89a 3×4", p, "OK 3x4"))

    p = tmp / "bomb.gif"
    p.write_bytes(gif(65535, 65535))
    cases.append(("GIF 65535×65535", p, "REJECT oversize"))

    p = tmp / "ok.bmp"
    p.write_bytes(bmp_info(5, 7))
    cases.append(("BMP INFOHEADER 5×7", p, "OK 5x7"))

    p = tmp / "bad.jpg"
    p.write_bytes(jpeg_truncated())
    cases.append(("JPEG 段长 0xFFFF 但截断", p, "REJECT"))

    p = tmp / "garbage.bin"
    p.write_bytes(b"XY" + zlib.compress(os.urandom(2048)))
    cases.append(("随机字节（认不出格式）", p, "REJECT unknown-format"))

    p = tmp / "big.bin"
    with open(p, "wb") as f:                    # 稀疏文件，不真占 25MB 磁盘
        f.truncate(25 * 1024 * 1024)
    cases.append(("25MiB 超字节闸门", p, "REJECT bytes>24MiB"))

    # 软链：名字像图片，实际指向 /etc/hosts（内容绝不是图片）
    p = tmp / "link.png"
    if p.exists() or p.is_symlink():
        p.unlink()
    os.symlink("/etc/hosts", p)
    cases.append(("符号链接（指向 /etc/hosts）", p, "REJECT symlink"))

    return cases


def find_bin() -> str | None:
    env = os.environ.get("IMGPROBE_BIN")
    if env and Path(env).exists():
        return env
    for cand in (
        "build/imgprobe",
        "build-asan/imgprobe",
        "cmake-build-debug/imgprobe",
        "/tmp/asan-bin/imgprobe",
    ):
        if Path(cand).exists():
            return cand
    return None


def main() -> int:
    argv = sys.argv[1:]
    emit_dir = None
    if "--emit" in argv:
        i = argv.index("--emit")
        emit_dir = Path(argv[i + 1]) if i + 1 < len(argv) else None

    if emit_dir is not None:
        emit_dir.mkdir(parents=True, exist_ok=True)
        for name, data in (
            ("ok.png", REAL_PNG_1X1),
            ("bomb.png", patch_png_size(REAL_PNG_1X1, 20000, 20000)),
        ):
            (emit_dir / name).write_bytes(data)
        print(f"emitted ok.png / bomb.png -> {emit_dir}")
        return 0

    binary = find_bin()
    if not binary:
        print("找不到 imgprobe 可执行文件。先编译：")
        print("  c++ -std=c++20 -g -O1 -fsanitize=address,undefined -Isrc \\")
        print("      tools/imgprobe.cpp -o build-asan/imgprobe")
        return 2

    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        cases = build_cases(tmp)
        bad = 0
        for desc, path, want in cases:
            r = subprocess.run([binary, "--gate", str(path)], capture_output=True, text=True)
            got = (r.stdout or "").strip()
            ok = got.startswith(want)
            if not ok:
                bad += 1
                print(f"  ✗ {desc}")
                print(f"      期望以 {want!r} 开头，实际 {got!r}（exit={r.returncode}）")
            else:
                print(f"  ✓ {desc:52s} → {got}")
        print(f"\ngenerated {len(cases)} files; {len(cases) - bad}/{len(cases)} gate decisions match")
        return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
