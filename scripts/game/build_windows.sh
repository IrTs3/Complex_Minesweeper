#!/usr/bin/env bash
# 在 macOS 上交叉编译出 Windows x64 版本（MinGW-w64 + 静态 SFML/freetype）
#
#   brew install mingw-w64     # 只需装一次
#   ./build_windows.sh         # 或直接双击 打包Windows.command
#
# 产物：dist/ComplexMinesweeper-win64/
#         ComplexMinesweeper.exe   单文件，只依赖 Windows 自带 DLL
#         assets/                  背景图与字体（必须和 exe 放一起）
#         使用说明-Windows.txt
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

SFML_VER="3.0.2"
FT_TAG="VER-2-13-2"
# ---- 供应链锚点（安全）----
# 钉住仓库 third_party/ 已提交 tarball 的 sha256。2026-10-08 已验证：
# 两个包解包后与 git 跟踪的源码树逐字节一致（构建实际使用的就是这棵树）。
# 任何下载产物（包括 ghproxy 镜像——存在被投毒的现实攻击场景：镜像被黑或
# 大陆链路 DNS 污染，带后门源码会被无感知编进 win64.exe 随包分发）
# 必须哈希一致才使用，否则删除并尝试下一个来源；全部失败则终止。
FT_SHA256="427201f5d5151670d05c1f5b45bef5dda1f2e7dd971ef54f0feaaa7ffd2ab90c"    # freetype-2.13.2.tar.gz（GitHub tag VER-2-13-2 归档）
SFML_SHA256="0034e05f95509e5d3fb81b1625713e06da7b068f210288ce3fd67106f8f46995"   # sfml-3.0.2.tar.gz（GitHub tag 归档）
TP="$ROOT/third_party"
SFML_SRC="$TP/SFML-$SFML_VER"
FT_SRC="$TP/freetype-$FT_TAG"
FT_PREFIX="$TP/freetype-win"
SFML_PREFIX="$TP/sfml-win"
FT_BUILD="$ROOT/build-freetype-win"
SFML_BUILD="$ROOT/build-sfml-win"
GAME_BUILD="$ROOT/build-win"
DIST="$ROOT/dist/ComplexMinesweeper-win64"
TOOLCHAIN="$ROOT/cmake/mingw-w64-toolchain.cmake"
POLICY="-DCMAKE_POLICY_VERSION_MINIMUM=3.5"   # freetype 用老式 cmake_minimum_required，新版 CMake 需要它
MINGW="x86_64-w64-mingw32"

# ---------- 0. 检查工具链 ----------
if ! command -v "$MINGW-g++" >/dev/null 2>&1; then
  echo "❌ 没找到 $MINGW-g++"
  echo "   先装交叉编译器： brew install mingw-w64"
  exit 1
fi

# ---------- 下载（默认只走直连；镜像必须显式开启；一切来源必须过 sha256）----------
# 为什么镜像默认关闭（2026-10-22）：镜像里被投毒的源码会直接被编进分发的 win64.exe，
# 而这条路径只在「全新机器 / 删了 third_party 解包目录」时才走到 —— 恰好是最不该
# 默默信任第三方中转的时刻。要镜像就显式来：ALLOW_MIRROR=1 ./scripts/game/build_windows.sh
# 每次成功下载都会在 third_party/FETCH-LOG.md 留一行（UTC 时间 / 来源 URL / sha256）。
verify_sha() {  # $1=文件 $2=期望哈希
  [ -f "$1" ] && echo "$2  $1" | shasum -a 256 -c - --status 2>/dev/null
}

try_fetch() {  # $1=输出文件 $2=GitHub URL $3=sha256 $4=来源前缀（空=直连）
  out="$1"; url="$4$2"
  echo "    尝试 $url"
  if curl -sL --fail --max-time 300 -o "$out" "$url" && verify_sha "$out" "$3"; then
    echo "    下载成功（哈希校验通过）"
    [ -f "$TP/FETCH-LOG.md" ] || printf '# 第三方源码包下载留痕（UTC 时间 / 来源 URL / sha256）\n' > "$TP/FETCH-LOG.md"
    printf '%s  %s  sha256=%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$url" "$3" >> "$TP/FETCH-LOG.md"
    return 0
  fi
  echo "    来源失败或哈希不符，弃用"
  rm -f "$out"
  return 1
}

fetch() {  # $1=输出文件 $2=GitHub URL $3=sha256
  out="$1"; gh="$2"; sha="$3"
  if [ -f "$out" ]; then
    if verify_sha "$out" "$sha"; then return 0; fi
    echo "⚠️  本地已存在的 $out 哈希不符（期望 ${sha}），弃用并重新下载"
    rm -f "$out"
  fi
  try_fetch "$out" "$gh" "$sha" "" && return 0
  if [ "${ALLOW_MIRROR:-0}" = "1" ]; then
    for base in "https://ghproxy.net/" "https://gh-proxy.com/"; do
      try_fetch "$out" "$gh" "$sha" "$base" && return 0
    done
  else
    echo "    镜像已默认关闭（源码包投毒会直接编进分发包）。"
    echo "    确认要从第三方中转取：ALLOW_MIRROR=1 $0"
  fi
  echo "❌ 无法获得哈希可信的 ${out}：$gh"
  return 1
}

mkdir -p "$TP"

# ---------- 1. freetype（SFML 图形模块依赖它）----------
echo "==> 1/5 准备 freetype"
# 用仓库已提交的 freetype-2.13.2.tar.gz（= GitHub tag VER-2-13-2 归档，解包顶层目录是 freetype-$FT_TAG）
FT_TARBALL="$TP/freetype-2.13.2.tar.gz"
if [ ! -d "$FT_SRC" ]; then
  # 这里的 URL 曾经是 `releases/download/$FT_TAG/...`，但 freetype 在该 tag 上**没有**发布资产（HEAD 404），
  # 而仓库里这个 tarball 实际来自 `/archive/refs/tags/` —— 顶层目录名 freetype-VER-2-13-2 就是归档命名。
  # 写错的那条只会在「本地 tarball 不存在」时才暴露：全新机器上三步来源全 404，构建当场终止。
  fetch "$FT_TARBALL" "https://github.com/freetype/freetype/archive/refs/tags/$FT_TAG.tar.gz" "$FT_SHA256"
  tar -xzf "$FT_TARBALL" -C "$TP"
fi

echo "==> 2/5 交叉编译 freetype（静态，关掉用不到的依赖）"
if [ ! -f "$FT_PREFIX/lib/libfreetype.a" ]; then
  cmake -S "$FT_SRC" -B "$FT_BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" $POLICY \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DFT_DISABLE_ZLIB=ON -DFT_DISABLE_BZIP2=ON -DFT_DISABLE_PNG=ON \
    -DFT_DISABLE_HARFBUZZ=ON -DFT_DISABLE_BROTLI=ON \
    -DCMAKE_INSTALL_PREFIX="$FT_PREFIX" > /dev/null
  cmake --build "$FT_BUILD" -j8
  cmake --install "$FT_BUILD" > /dev/null
fi

# ---------- 2. SFML ----------
echo "==> 3/5 准备并交叉编译 SFML（静态；首次需要几分钟）"
if [ ! -d "$SFML_SRC" ]; then
  fetch "$TP/sfml-$SFML_VER.tar.gz" "https://github.com/SFML/SFML/archive/refs/tags/$SFML_VER.tar.gz" "$SFML_SHA256"
  tar -xzf "$TP/sfml-$SFML_VER.tar.gz" -C "$TP"
fi

if [ ! -f "$SFML_PREFIX/lib/cmake/SFML/SFMLConfig.cmake" ]; then
  cmake -S "$SFML_SRC" -B "$SFML_BUILD" \
    -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" $POLICY \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
    -DSFML_USE_SYSTEM_DEPS=ON \
    -DCMAKE_PREFIX_PATH="$FT_PREFIX" \
    -DSFML_BUILD_EXAMPLES=OFF -DSFML_BUILD_TEST_SUITE=OFF -DSFML_BUILD_DOC=OFF \
    -DSFML_BUILD_NETWORK=OFF -DSFML_BUILD_AUDIO=OFF \
    -DCMAKE_INSTALL_PREFIX="$SFML_PREFIX" > /dev/null
  cmake --build "$SFML_BUILD" -j8
  cmake --install "$SFML_BUILD" > /dev/null
fi

# ---------- 3. 游戏本体 ----------
echo "==> 4/5 交叉编译复数扫雷"

# 应用图标 → build-win/icon.ico（CMakeLists 会把它编进 exe 的资源段）
# ★ Windows 的图标是**编进 exe 里**的，所以这一步必须在 cmake 配置**之前**——
#   图标变了要重跑本脚本才能真正换掉 exe 上的图标。
#   没有它也能编出能跑的 exe，只是没图标。
if [ -f "$ROOT/assets/bg.jpg" ]; then
  echo "    生成 Windows 图标（从 assets/bg.jpg）"
  bash "$ROOT/scripts/game/make_win_icon.sh" "$GAME_BUILD/icon.ico" || \
    echo "    (图标生成失败，继续编 —— 只是没有图标)"
fi

cmake -S "$ROOT" -B "$GAME_BUILD" \
  -DCMAKE_TOOLCHAIN_FILE="$TOOLCHAIN" $POLICY \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_PREFIX_PATH="$FT_PREFIX" \
  -DSFML_DIR="$SFML_PREFIX/lib/cmake/SFML" > /dev/null
cmake --build "$GAME_BUILD" --target minesweeper -j8

# ---------- 4. 组装发布目录 ----------
echo "==> 5/5 组装 dist/ComplexMinesweeper-win64"

# 安全：发布物里不能带 config（个人设置 / 自定义图片 / 本机路径）。
# Win 版运行时把配置写在 exe 同级的 config\ 目录，所以组装前先清掉。
rm -rf "$DIST/config" 2>/dev/null || true
rm -rf "$DIST"
mkdir -p "$DIST"
cp "$GAME_BUILD/minesweeper.exe" "$DIST/ComplexMinesweeper.exe"
cp -R "$ROOT/assets" "$DIST/assets"
# dmg_bg* 仅用于 macOS dmg 安装盘外观，Windows 包不带
rm -f "$DIST/assets/.DS_Store" "$DIST/assets/1.jpg" "$DIST/assets/dmg_bg.png" "$DIST/assets/dmg_bg@2x.png"

cat > "$DIST/使用说明-Windows.txt" <<'NOTE'
================================================================
　复数扫雷  Complex Minesweeper  ·  Windows 版使用说明
================================================================

【怎么运行】
  双击 ComplexMinesweeper.exe 即可。
  注意：assets 文件夹必须和 exe 放在同一层，否则没有背景图和字体。

【系统要求】
  · 64 位 Windows 10 / 11

【基本操作】
  左键单击        翻开格子
  右键单击        弹出标记菜单（+1 / -1 / +i / -i / 清除）
  标题栏 9x9 等   切换难度；CUSTOM 可自定义行列与雷数
  SEED            复制 / 保存 / 载入"种子"，可以分享同一局
  齿轮按钮        设置：换背景图、自定义四种标记的字符或图标、改格子颜色
  右下角滑条      调整背景图透明度

【怎么算赢】两种方式任选其一
  · 把所有安全格子翻开
  · 或者把所有雷都按正确类型标记出来（不必翻开安全格）

  标题栏会实时显示四种雷各自"还有几颗没被正确标记"。
  提示相同的一团雷允许整体取反（+1↔-1、+i↔-i），统计上一致就算对。

【设置存在哪】
  在 exe 同级的 config 文件夹里（settings.ini 是纯文本，可直接查看修改），
  所以把 exe + assets + config 一起拷走，外观设置会跟着一起走。

【小彩蛋】
  标题栏右下角那个复选框……勾上看看 :)

  祝玩得开心！
================================================================
NOTE

if [ -f "$ROOT/docs/使用说明.txt" ]; then cp "$ROOT/docs/使用说明.txt" "$DIST/使用说明.txt"; fi

chmod 644 "$DIST"/*.txt 2>/dev/null || true
ZIP="$ROOT/dist/ComplexMinesweeper-win64.zip"
rm -f "$ZIP"
ditto -c -k --norsrc --keepParent "$DIST" "$ZIP"
# ---- 分发指纹：接收者下载后在 zip 同目录跑  shasum -a 256 -c SHA256SUMS-win64.txt  自验 ----
( cd "$(dirname "$ZIP")" && shasum -a 256 "$(basename "$ZIP")" > "SHA256SUMS-win64.txt" )
cat "$(dirname "$ZIP")/SHA256SUMS-win64.txt"
echo "完成：$DIST"
ls -lh "$DIST"
echo "压缩包：$ZIP"
