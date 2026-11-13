#!/bin/bash
# 从 assets/bg.jpg 生成 Windows 的 .ico（内嵌进 exe 用）。
#
# 为什么要单独一步：Windows 的图标是 **PE 资源段**里的东西，mac 的 .app 图标
# 是独立文件（Finder 读它）—— 所以两端机制完全不同：
#   mac → 换 icon.icns 即可，不用重编译
#   win → 必须编译期用 windres 把 .ico 链进 exe
#
# 尺寸取 Windows 惯用的那几档（16/24/32/48/64/128/256）。
# 256 是 PNG 压缩格式塞进 .ico（Vista+ 支持，体积小很多）；
# 更小的几档用 BMP —— 这样连 XP 时代的程序也能正常显示。
set -eu
cd "$(dirname "$0")/../.."

# ★ 优先用**裁过的方形图标** assets/icon.png（界面里画的框），
#   没有才退回从背景图居中裁。
SRC="assets/icon.png"
[ -f "$SRC" ] || SRC="assets/bg.jpg"
OUT="${1:-build-win/icon.ico}"

if [ ! -f "$SRC" ]; then
    echo "错误：找不到 $SRC" >&2
    exit 1
fi

mkdir -p "$(dirname "$OUT")"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 居中裁成方形 —— 图标必须是方的，否则会被拉伸变形。
# 复用 .app 图标那套逻辑（900×900 居中裁），保证两端观感一致。
# ★ 源图若**已经是正方形**（界面裁出来的 assets/icon.png 就是），
#   直接缩放；只有非正方形（老路径：背景图）才居中裁。
#   不加这个判断，512×512 的图标会被 `--cropToHeightWidth 900 900` 放大再裁，
#   等于白糊一次。
W=$(sips -g pixelWidth "$SRC" 2>/dev/null | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" 2>/dev/null | awk '/pixelHeight/{print $2}')
if [ -n "$W" ] && [ "$W" = "$H" ]; then
    sips -s format png "$SRC" --out "$TMP/base.png" >/dev/null 2>&1 \
      || { echo "错误：读不了 $SRC" >&2; exit 1; }
else
    sips -s format png --cropToHeightWidth 900 900 "$SRC" --out "$TMP/base.png" >/dev/null 2>&1 \
      || sips -s format png "$SRC" --out "$TMP/base.png" >/dev/null
fi

# 先攒 BMP（小尺寸），最后拼 PNG（256）
for s in 16 24 32 48 64 128; do
    sips -z "$s" "$s" "$TMP/base.png" --out "$TMP/bmp_$s.png" >/dev/null
done
sips -z 256 256 "$TMP/base.png" --out "$TMP/png_256.png" >/dev/null

# 用 Python 标准库拼 .ico（不引第三方依赖；ICO 就是「目录 + 若干张图」）
python3 - "$TMP" "$OUT" <<'PY'
import struct, sys, pathlib, subprocess
tmp, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
# Windows 惯例：从小到大排列
sizes_bmp  = [(16, "bmp_16"), (24, "bmp_24"), (32, "bmp_32"),
              (48, "bmp_48"), (64, "bmp_64"), (128, "bmp_128")]
size_png   = (256, "png_256")

def png_bytes(nm):
    return (tmp / f"{nm}.png").read_bytes()

# BMP 那几档：ICO 里存的是「不含文件头的 DIB」，且高度要**翻倍**（含 AND 掩码）
def dib_bytes(nm, w, h):
    # 用 sips 导 BMP，再手工补 BITMAPINFOHEADER + 像素 + AND 掩码
    bmp = tmp / f"{nm}.bmp"
    subprocess.run(["sips", "-s", "format", "bmp", str(tmp / f"{nm}.png"),
                    "--out", str(bmp)], check=True, capture_output=True)
    raw = bmp.read_bytes()
    off = struct.unpack_from("<I", raw, 10)[0]          # bfOffBits
    hdr = struct.unpack_from("<I", raw, 14)[0]          # biSize
    wpx = struct.unpack_from("<i", raw, 18)[0]
    hpx = struct.unpack_from("<i", raw, 22)[0]
    planes = struct.unpack_from("<H", raw, 26)[0]
    bpp   = struct.unpack_from("<H", raw, 28)[0]
    comp  = struct.unpack_from("<I", raw, 30)[0]
    # 像素数据：从 off 开始，行是 4 字节对齐的
    stride = ((wpx * bpp // 8) + 3) & ~3
    px = raw[off:]
    need = stride * abs(hpx)
    if len(px) < need:
        px = px + b"\0" * (need - len(px))
    px = px[:need]
    mask_stride = ((wpx + 31) // 32) * 4
    mask = b"\0" * (mask_stride * abs(hpx))
    info = struct.pack("<IiiHHIIiiII", 40, wpx, abs(hpx) * 2,
                       1, bpp, comp, len(px) + len(mask), 0, 0, 0, 0)
    return info + px + mask

entries = []
for w, nm in sizes_bmp:
    entries.append((w, w, dib_bytes(nm, w, w), False))
w, nm = size_png
entries.append((w, w, png_bytes(nm), True))

# ICONDIR + 若干 ICONDIRENTRY + 全部数据
n = len(entries)
head = struct.pack("<HHH", 0, 1, n)
dirbytes = b""
databytes = b""
offset = 6 + 16 * n
for (w1, h1, data, is_png) in entries:
    dirbytes += struct.pack("<BBBBHHII",
                            w1 if w1 < 256 else 0, h1 if h1 < 256 else 0,
                            0, 0, 1, 32 if not is_png else 0,
                            len(data), offset)
    databytes += data
    offset += len(data)
out.write_bytes(head + dirbytes + databytes)
print(f"  .ico 已生成：{out}  {len(head+dirbytes+databytes):,} 字节  {n} 个尺寸")
PY

echo "==> 校验：让 windres 真的读一遍（读不了就说明 .ico 是坏的）"
# ★ 必须走 `.rc` 中间层：windres 会先把 .rc 交给 C 预处理器（cc1），
#   所以直接 `-i xxx.ico` 是「file format not recognized」。
#   这里编一个只有一行的临时 .rc，产出 .o 就说明 .ico 合法。
RC="$TMP/probe.rc"
printf 'IDI_ICON1 ICON "%s"\n' "$OUT" > "$RC"
if x86_64-w64-mingw32-windres -i "$RC" -O coff -o "$TMP/probe.o" >/dev/null 2>&1 \
   && [ -s "$TMP/probe.o" ]; then
    echo "  ✓ windres 能正常读取并编出 $(stat -f%z "$TMP/probe.o") 字节的资源文件"
else
    echo "  ✗ windres 读不了这个 .ico" >&2
    exit 1
fi
