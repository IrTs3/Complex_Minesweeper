#!/bin/bash
# 重生成 .app 图标（从 assets/bg.jpg 派生），不重新编译、不重打 dmg。
#
# 为什么要单独一个脚本：图标与 dmg 背景都是 `package.sh` **打包时从
# `assets/bg.jpg` 现场派生**的（见那脚本的图标段与 `.background` 段）。
# 换完背景图想立刻看到新图标，不必为此重跑整个打包（要编译，慢）。
#
# ⚠️ dmg 背景**不能**单独重建 —— 它只存在于打包流程的临时目录，做完即删。
#    下次跑 `package.sh` 自然会带上新图。
#
# 用法：
#   scripts/game/refresh_icon.sh            # 重生成 dist 里那个 .app 的图标
#   scripts/game/refresh_icon.sh --show     # 只看会做成什么样，不写任何文件
set -u
cd "$(dirname "$0")/../.."

# ★ 优先用**裁过的方形图标** assets/icon.png（界面里画的框），
#   没有才退回从背景图居中裁。用户的裁剪选择优先于任何默认行为。
SRC="assets/icon.png"
[ -f "$SRC" ] || SRC="assets/bg.jpg"
APP="dist/ComplexMinesweeper.app/Contents/Resources/icon.icns"
SHOW=0
[ "${1:-}" = "--show" ] && SHOW=1

# 找不到图就直说，别静默跳过（跳过会让人以为图标已经更新了）
if [ ! -f "$SRC" ]; then
    echo "错误：找不到 $SRC" >&2
    echo "  桌面端缺图时会退回纯色底（kWindowBg），不会崩，但图标也没得派生。" >&2
    exit 1
fi
command -v sips >/dev/null 2>&1 || { echo "错误：缺 sips（macOS 自带，这里不该发生）" >&2; exit 1; }

echo "==> 源图: $SRC ($(stat -f%z "$SRC") 字节)"
if [ "$SHOW" = 1 ]; then
    TMP="$(mktemp -d)"
    sips -s format png --cropToHeightWidth 900 900 "$SRC" --out "$TMP/base.png" >/dev/null 2>&1 \
      || sips -s format png "$SRC" --out "$TMP/base.png" >/dev/null
    OUT="/tmp/icon-preview.png"
    cp "$TMP/base.png" "$OUT"
    echo "==> 预览: ${OUT}（$(stat -f%z "$OUT") 字节）—— 确认后再去掉 --show 真正写入"
    rm -rf "$TMP"
    exit 0
fi

# .app 不在时如实说：**这不算失败** —— 用户可能还没打过包。
if [ ! -d "$(dirname "$APP")" ]; then
    echo "  （还没有 $APP —— 首次跑 scripts/game/package.sh 之后才会有图标可更新）"
    exit 0
fi

# ★ 与 package.sh 的图标段**逐行一致**（同样 7 档尺寸、同样 16x16@2x 等映射）。
#   抄一份必然漂移 —— 以后 package.sh 改了尺寸，这里不会跟着改，
#   于是「单独重建的图标」和「打包出来的图标」不一样。
#   所以下面从 package.sh 里抽出那段来执行，不另抄。
ICON_BLOCK="$(awk '/^ICON_TMP=/,/^rm -rf "\$ICON_TMP"/' scripts/game/package.sh)"

# 抽出来的段里用了 $RES（Resources 目录）与 $ICON_TMP（临时目录）。
RES="$(dirname "$APP")"
TMPD="$(mktemp -d)"
trap 'rm -rf "$TMPD"' EXIT

echo "==> 生成图标（复用 package.sh 的同一段逻辑）"
export RES
# ★ 抽取出来的那段引用 $ICON_SRC / $_W / $_H —— 这里必须提供，否则 `set -u` 直接炸。
#   用我们上面选好的 $SRC（方形图标优先），而不是让那段自己去猜。
export ICON_SRC="$SRC"
if ! ICON_TMP="$TMPD/icons" bash -c "$ICON_BLOCK"; then
    echo "错误：图标生成失败" >&2
    exit 1
fi

NEW="$(stat -f%z "$APP" 2>/dev/null || echo 0)"
echo "  ✓ 已更新 $APP"
echo "    $(stat -f%z "$APP") 字节"
echo
echo "  注意：dmg 安装界面的背景**不在这里**更新 —— 它只在打包时临时生成。"
echo "        跑 scripts/game/package.sh 才会带上新图（webbg push 勾桌面端时会自动跑）。"
