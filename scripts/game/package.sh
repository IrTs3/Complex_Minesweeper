#!/usr/bin/env bash
# 打包成可迁移的 macOS .app：自带 SFML/freetype/libpng 等动态库，
# 不需要目标机器安装 Homebrew，也不依赖源码目录。
#
#   ./package.sh            打包并压缩
#   ./package.sh --no-zip   只打包，不压缩
set -euo pipefail
cd "$(dirname "$0")/../.."

APP="ComplexMinesweeper"
BIN="minesweeper"
BUILD_DIR="build-release"
DIST="dist"
BUNDLE="$DIST/$APP.app"
FW="$BUNDLE/Contents/Frameworks"
RES="$BUNDLE/Contents/Resources"
MAIN="$BUNDLE/Contents/MacOS/$BIN"

# 需要一起打包的第三方动态库（写完引用后会被改写为 @rpath）
HOMEBREW_LIBS="/opt/homebrew/opt/sfml/lib/libsfml-graphics.3.0.dylib
/opt/homebrew/opt/sfml/lib/libsfml-window.3.0.dylib
/opt/homebrew/opt/sfml/lib/libsfml-system.3.0.dylib
/opt/homebrew/opt/freetype/lib/libfreetype.6.dylib
/opt/homebrew/opt/libpng/lib/libpng16.16.dylib"

echo "==> 1/8 Release 构建"
# ★ PKG_REUSE_BIN=1：**复用**已编好的 $BUILD_DIR/$BIN，跳过清理与编译。
#   什么时候用：只想重做「外包装」（换背景图 / 换图标 / dmg 外观）时。
#   为什么需要：这一步原本先 `rm -rf $BUILD_DIR` 再全量重编，几十秒到几分钟，
#   而且会把**当前工作区里未提交的改动**一并编进去 —— 推一张背景图不该
#   顺带发布别人（或自己）写了一半的代码。
#   二进制不存在时自动退回正常编译路径，所以外部无脑传 =1 也是安全的。
if [ "${PKG_REUSE_BIN:-0}" = "1" ] && [ -x "$BUILD_DIR/$BIN" ]; then
  # ⚠️ 变量后面紧跟中文标点必须写 ${BIN}：macOS 自带的是 bash 3.2，
  #   它会把多字节字符的首字节当成变量名的一部分，于是变成
  #   `BIN\xef: unbound variable`（set -u 下直接退出，报错还看不出原因）。
  echo "   （复用已编译的 ${BUILD_DIR}/${BIN}，跳过编译）"
else
  # 清理旧构建缓存：generator 切换（Unix Makefiles ↔ Ninja）或 CMakeLists.txt 改动
  # 会导致 "Does not match the generator used previously" 错误。
  rm -rf "$BUILD_DIR"
  NINJA="/Applications/CLion.app/Contents/bin/ninja/mac/aarch64/ninja"
  if [ -x "$NINJA" ]; then
    cmake -S . -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release -G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA" >/dev/null
  else
    cmake -S . -B "$BUILD_DIR" -DCMAKE_BUILD_TYPE=Release >/dev/null
  fi
  cmake --build "$BUILD_DIR" --target "$BIN" -j8
fi

echo "==> 2/8 建立 .app 结构"
rm -rf "$BUNDLE"
mkdir -p "$BUNDLE/Contents/MacOS" "$FW" "$RES"
cp "$BUILD_DIR/$BIN" "$MAIN"
cp -R assets "$RES/assets"
rm -f "$RES/assets/.DS_Store"
rm -f "$RES/assets/1.jpg"   # 与 bg.jpg 完全重复的副本，不必随包分发（项目里仍保留）
rm -f "$RES/assets/dmg_bg.png" "$RES/assets/dmg_bg@2x.png"   # 仅用于 dmg 外观，不进 app 包

echo "==> 3/8 拷入动态库"
for lib in $HOMEBREW_LIBS; do
  name="$(basename "$lib")"
  cp -f "$lib" "$FW/$name"      # cp 会跟随软链接，取到真实文件
  chmod u+w "$FW/$name"
done

echo "==> 4/8 改写 install name（去掉 /opt/homebrew）"
fix_refs() {
  target="$1"
  # 注意：grep 无匹配会返回 1，配合 set -o pipefail 会让脚本直接退出，所以要先 || true
  refs="$(otool -L "$target" | tail -n +2 | awk '{print $1}' | grep '^/opt/homebrew' || true)"
  for ref in $refs; do
    install_name_tool -change "$ref" "@rpath/$(basename "$ref")" "$target"
  done
}
for dylib in "$FW"/*.dylib; do
  install_name_tool -id "@rpath/$(basename "$dylib")" "$dylib"
  fix_refs "$dylib"
  install_name_tool -add_rpath "@loader_path" "$dylib" 2>/dev/null || true
done
fix_refs "$MAIN"
install_name_tool -add_rpath "@executable_path/../Frameworks" "$MAIN" 2>/dev/null || true

# 关键：删掉遗留的 Homebrew rpath。否则 @rpath 会先命中 /opt/homebrew/lib 里
# 的库，包看似正常、换台机器却直接起不来（必须自包含）。
strip_homebrew_rpaths() {
  target="$1"
  rpaths="$(otool -l "$target" | grep -A2 LC_RPATH | awk '/path /{print $2}' | grep -i homebrew || true)"
  for rp in $rpaths; do
    install_name_tool -delete_rpath "$rp" "$target" 2>/dev/null || true
  done
}
strip_homebrew_rpaths "$MAIN"
for dylib in "$FW"/*.dylib; do strip_homebrew_rpaths "$dylib"; done

echo "==> 5/8 生成图标与 Info.plist"
# ★ 图标源：优先用**界面里裁过的方形图** assets/icon.png；
#   没有才退回背景图居中裁（老路径，可能裁到不想要的地方）。
ICON_SRC="${ICON_SRC:-assets/icon.png}"
[ -f "$ICON_SRC" ] || ICON_SRC="assets/bg.jpg"
ICON_TMP="$(mktemp -d)"
# 方形源不裁（512×512 拿去 --cropToHeightWidth 900 900 会先放大再裁 = 白糊一次）
_W=$(sips -g pixelWidth "$ICON_SRC" 2>/dev/null | awk '/pixelWidth/{print $2}')
_H=$(sips -g pixelHeight "$ICON_SRC" 2>/dev/null | awk '/pixelHeight/{print $2}')
if [ -n "$_W" ] && [ "$_W" = "$_H" ]; then
  sips -s format png "$ICON_SRC" --out "$ICON_TMP/base.png" >/dev/null 2>&1 || \
    sips -s format png "$ICON_SRC" --out "$ICON_TMP/base.png" >/dev/null
else
  sips -s format png --cropToHeightWidth 900 900 "$ICON_SRC" --out "$ICON_TMP/base.png" >/dev/null 2>&1 || \
    sips -s format png "$ICON_SRC" --out "$ICON_TMP/base.png" >/dev/null
fi
mkdir -p "$ICON_TMP/icon.iconset"
for size in 16 32 64 128 256 512 1024; do
  sips -z "$size" "$size" "$ICON_TMP/base.png" --out "$ICON_TMP/icon_$size.png" >/dev/null
done
cp "$ICON_TMP/icon_16.png"   "$ICON_TMP/icon.iconset/icon_16x16.png"
cp "$ICON_TMP/icon_32.png"   "$ICON_TMP/icon.iconset/icon_16x16@2x.png"
cp "$ICON_TMP/icon_32.png"   "$ICON_TMP/icon.iconset/icon_32x32.png"
cp "$ICON_TMP/icon_64.png"   "$ICON_TMP/icon.iconset/icon_32x32@2x.png"
cp "$ICON_TMP/icon_128.png"  "$ICON_TMP/icon.iconset/icon_128x128.png"
cp "$ICON_TMP/icon_256.png"  "$ICON_TMP/icon.iconset/icon_128x128@2x.png"
cp "$ICON_TMP/icon_256.png"  "$ICON_TMP/icon.iconset/icon_256x256.png"
cp "$ICON_TMP/icon_512.png"  "$ICON_TMP/icon.iconset/icon_256x256@2x.png"
cp "$ICON_TMP/icon_512.png"  "$ICON_TMP/icon.iconset/icon_512x512.png"
cp "$ICON_TMP/icon_1024.png" "$ICON_TMP/icon.iconset/icon_512x512@2x.png"
# ★ 图标生成失败必须**停下**，不能「跳过」：
#   没有 icon.icns 的 .app 在 Finder 里就是一个白纸图标，用户以为「这次打包
#   坏了」，而脚本一路打勾到结束。之前这里是 `|| echo "(失败，跳过)"` ——
#   2026-10-18 用户问「为什么有时候打包出来的应用会没有图标」就是它。
iconutil -c icns "$ICON_TMP/icon.iconset" -o "$RES/icon.icns" 2>/dev/null || {
  echo "❌ 图标生成失败（源：${ICON_SRC}）—— 没有图标的包是坏的，直接停下" >&2
  echo "   常见原因：源图不是正方形、或 sips 无法解码这个格式。" >&2
  rm -rf "$ICON_TMP"
  exit 1
}
echo "    图标源：$ICON_SRC"
rm -rf "$ICON_TMP"

cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key><string>Complex Minesweeper</string>
	<key>CFBundleDisplayName</key><string>复数扫雷</string>
	<key>CFBundleExecutable</key><string>minesweeper</string>
	<key>CFBundleIdentifier</key><string>cn.edu.ustc.complexminesweeper</string>
	<key>CFBundleIconFile</key><string>icon</string>
	<key>CFBundleVersion</key><string>1.0</string>
	<key>CFBundleShortVersionString</key><string>1.0</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
	<key>NSHighResolutionCapable</key><true/>
	<key>LSMinimumSystemVersion</key><string>13.0</string>
	<key>NSHumanReadableCopyright</key><string>Complex Minesweeper</string>
</dict>
</plist>
PLIST

# 安全：分发包里绝不能带开发机的配置（personal settings / 个人图片 / 路径），
# 否则既泄漏隐私，也会让别人拿到你勾过的开关状态（例如"隐藏计数"）。
find "$BUNDLE" -type d -name config -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$BUNDLE/Contents/MacOS/config" "$BUNDLE/Contents/Resources/config" 2>/dev/null || true

echo "==> 6/8 重新签名（install_name_tool 会破坏签名，arm64 必须重签；失败＝坏包，立即终止）"
# 历史坑：原来三处 codesign 行尾的「|| true」会吞掉签名失败，产出"打包显示成功、
# 换台机器起不来"的坏包；arm64 上未正确签名的二进制会被内核强制校验拒绝加载。
for dylib in "$FW"/*.dylib; do codesign --force --sign - "$dylib"; done
codesign --force --sign - "$MAIN"
codesign --force --deep --sign - "$BUNDLE"
codesign --verify --strict "$BUNDLE"   # 签名复核：签不实就终止（set -e）
# bundle 级签名必须真实落盘（本机实测过"验签通过几秒后 _CodeSignature 消失"的环境干扰，
# 因此签名后断言目录存在，打包后还要从成品里取出来再验——不信任任何中间态）。
if [ ! -d "$BUNDLE/Contents/_CodeSignature" ]; then
  echo "❌ $BUNDLE 缺少 Contents/_CodeSignature（bundle 级签名丢失）"
  exit 1
fi

# 说明文件：docs/使用说明.txt（唯一来源，由使用者自己维护）
USAGE="$(cd "$(dirname "$0")/../.." && pwd)/docs/使用说明.txt"

echo "==> 7/8 压缩 zip"
if [ "$#" -eq 0 ] || [ "$1" != "--no-zip" ]; then
  mkdir -p "$DIST"
  rm -f "$DIST/$APP-macOS-arm64.zip"
  STAGE="$DIST/$APP"   # 压缩包内的顶层文件夹名
  rm -rf "$STAGE"
  mkdir -p "$STAGE"
  ditto "$BUNDLE" "$STAGE/$(basename "$BUNDLE")"
  if [ -f "$USAGE" ]; then
    cp "$USAGE" "$STAGE/使用说明.txt"
  else
    echo "   (提示：没找到 docs/使用说明.txt，压缩包里将不含说明文件)"
  fi
  xattr -cr "$STAGE" 2>/dev/null || true
  ditto -c -k --norsrc --keepParent "$STAGE" "$DIST/$APP-macOS-arm64.zip"
  rm -rf "$STAGE"
  # 接收者视角验签：从成品 zip 解出 app 独立 codesign 校验，坏包绝不出门
  ZCHK="$(mktemp -d)"
  if ditto -x -k "$DIST/$APP-macOS-arm64.zip" "$ZCHK" \
     && codesign --verify --strict "$ZCHK/$APP/$(basename "$BUNDLE")"; then
    echo "    已生成 $DIST/$APP-macOS-arm64.zip（包内验签通过）"
  else
    rm -rf "$ZCHK"
    echo "❌ zip 包内 app 验签失败，删除坏包"
    rm -f "$DIST/$APP-macOS-arm64.zip"
    exit 1
  fi
  rm -rf "$ZCHK"
fi

echo "==> 8/8 生成 DMG（自定义外观：背景图 + 图标定位）"
if [ "$#" -eq 0 ] || [ "$1" != "--no-zip" ]; then
  DMG="$DIST/$APP-macOS-arm64.dmg"
  RW_DMG="$DIST/.rw-$APP.dmg"
  VOL="$APP"
  APP_NAME="$(basename "$BUNDLE")"
  STAGE2="$(mktemp -d)"
  rm -f "$DMG" "$RW_DMG"
  ditto "$BUNDLE" "$STAGE2/$APP_NAME"
  if [ -f "$USAGE" ]; then cp "$USAGE" "$STAGE2/使用说明.txt"; fi
  ln -s /Applications "$STAGE2/Applications"
  mkdir -p "$STAGE2/.background"
  # dmg 安装界面背景 = 游戏默认背景 assets/bg.jpg（sips 现场导出：中心裁 660:420 比例 → 1x/2x PNG）。
  # 派生而不入库：仓库里不留生成物，bg.jpg 换了 dmg 背景自动跟着换。
  MS_BGDONE=""
  if [ -f assets/bg.jpg ] && command -v sips >/dev/null 2>&1; then
    T_BG="$(mktemp -d)"
    if sips -c 1080 1697 assets/bg.jpg --out "$T_BG/c.jpg" >/dev/null 2>&1 \
       && sips -s format png -z 420 660 "$T_BG/c.jpg" --out "$T_BG/bg.png" >/dev/null 2>&1 \
       && sips -s format png -z 840 1320 "$T_BG/c.jpg" --out "$T_BG/bg@2x.png" >/dev/null 2>&1; then
      cp "$T_BG/bg.png" "$STAGE2/.background/bg.png"
      cp "$T_BG/bg@2x.png" "$STAGE2/.background/bg@2x.png"
      MS_BGDONE="yes"
    fi
    rm -rf "$T_BG"
  fi
  if [ -z "$MS_BGDONE" ]; then
    # 回退：预先画好的浅色 dmg 背景
    [ -f assets/dmg_bg.png ] && cp assets/dmg_bg.png "$STAGE2/.background/bg.png"
    [ -f assets/dmg_bg@2x.png ] && cp assets/dmg_bg@2x.png "$STAGE2/.background/bg@2x.png"
  fi
  xattr -cr "$STAGE2" 2>/dev/null || true

  # ★ 先卸载任何**同名残留卷**。
  #   踩过的坑（2026-10-18）：/Volumes 里堆了 ComplexMinesweeper ~ -4 五个卷
  #   （挂载出来验证时留下的）。而下面的 osascript 是**按卷名**操作的 ——
  #   `tell disk "$VOL"` 打到了最老的那个，新卷一个布局都没拿到：
  #   生成出来的 dmg 打开是白底、图标按默认网格排，而且 osascript **返回成功**，
  #   一句提示都没有。用户看到的就是「说好的安装界面呢」。
  shopt -s nullglob
  for _v in /Volumes/"$VOL"*; do
    hdiutil detach "$_v" -force >/dev/null 2>&1 \
      && echo "   （已卸载残留的 $(basename "$_v")）" || true
  done
  shopt -u nullglob

  # 先做可读写的 HFS+ 映像：Finder 的视图设置会写进卷里的 .DS_Store
  hdiutil create -volname "$VOL" -srcfolder "$STAGE2" -ov -format UDRW -fs HFS+ -quiet "$RW_DMG" || true
  rm -rf "$STAGE2"
  # 注意 set -o pipefail：前面 hdiutil 失败或 grep 无匹配都会让替换式整体失败、set -e 静默杀脚本，
  # 必须 || true 保住后面「挂载失败→跳过 DMG、zip 照常」的降级路径。
  MP="$(hdiutil attach "$RW_DMG" -nobrowse -readwrite -noverify 2>/dev/null | grep -o "/Volumes/.*" | head -1 || true)"
  # set -u 下要预置，否则「挂载失败」那条降级路径里引用它会直接退出
  APL_FAILED=0
  APL_MSG=""
  if [ -n "$MP" ]; then
    # 用 Finder 摆图标与背景。
    # ★ 这一步**失败必须能继续**（系统没给自动化权限时就会失败），所以
    #   不能直接调用 —— `set -e` 会让整个打包在这里静默退出，
    #   表现是「dmg 没生成、还留下一个挂载着的 .rw 镜像」，而日志最后一行
    #   只有「==> 8/8 生成 DMG」，看不出任何原因。2026-10-18 真踩到。
    # ★ 把 stderr 留下来。以前是 `2>&1 >/dev/null` 全吞掉，于是只知道
    #   「失败」，不知道失败在哪一句 —— 而它常常是**部分成功**：
    #   .DS_Store 里背景图与图标位置都写进去了，只是最后 close 之类的
    #   收尾动作报了错（退出码非零）。那种情况下 dmg 其实是对的，
    #   却因为这句吞掉的错误把结论说反。2026-10-18 用户截图的
    #   「摆图标失败 / 布局已生效」自相矛盾就是它。
    APL_ERR="$(mktemp)"
    # ★ 用 `|| OSARC=$?` 而不是 `if ! osascript`：
    #   ① 显式拿到退出码，能打印出来（判断「部分成功」时有据可依）；
    #   ② `if !` 在 `set -e` 下的行为容易被 heredoc 的书写位置影响，
    #      显式记录更不容易误判。2026-10-18 就是它把结论说反过。
    OSARC=0
    osascript 2>"$APL_ERR" <<EOS || OSARC=$?
tell application "Finder"
  tell disk "$VOL"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {240, 160, 900, 608}
    set opts to the icon view options of container window
    set arrangement of opts to not arranged
    set icon size of opts to 128
    set text size of opts to 13
    try
      set background picture of opts to file ".background:bg.png"
    end try
    set position of item "$APP_NAME" of container window to {165, 175}
    set position of item "Applications" of container window to {495, 175}
    try
      set position of item "使用说明.txt" of container window to {165, 322}
    end try
    update without registering applications
    delay 1
    close
  end tell
end tell
EOS
    if [ "$OSARC" -eq 0 ]; then
      :                       # 成功：背景与图标位置都摆好了
      APL_FAILED=0
      APL_MSG=""
    else
      # 先别下结论 —— 可能是「部分成功」，最终由下面 .DS_Store 的内容来判。
      APL_FAILED=1
      APL_MSG="$(tr -d '\r' < "$APL_ERR" | grep -v '^$' | head -1 | cut -c1-200)"
      echo "   （AppleScript 退出码 ${OSARC}：${APL_MSG:-无输出}）"
    fi
    rm -f "$APL_ERR"
    sync
    hdiutil detach "$MP" -quiet 2>/dev/null || hdiutil detach "$MP" -force -quiet 2>/dev/null || true
    if hdiutil convert "$RW_DMG" -format UDZO -imagekey zlib-level=9 -quiet -o "$DMG"; then
      # dmg 同样接收者视角验签：挂载成品→验 app→卸载；验不过就删盘终止
      DMP="$(hdiutil attach "$DMG" -nobrowse -readonly -noverify 2>/dev/null | grep -o "/Volumes/.*" | head -1 || true)"
      if [ -n "$DMP" ]; then
        if codesign --verify --strict "$DMP/$APP_NAME"; then
          # ★ 判「外观有没有生效」必须看**内容**，而且要看对字段：
          #   - `.DS_Store` 在不在没用：Finder 没权限时也会建一个 6KB 空壳。
          #   - `icvp` 在也没用：没设背景图时照样有 icvp（里面有 iconSize 等）。
          #   - `backgroundImageAlias` **只有真把背景图设上**才会出现 —— 这才是
          #     「用户看到浅蓝背景」的直接证据；`Iloc` 则是图标位置。
          if grep -aq "backgroundImageAlias" "$DMP/.DS_Store" 2>/dev/null \
             && grep -aq "Iloc" "$DMP/.DS_Store" 2>/dev/null; then
            if [ "$APL_FAILED" = "1" ]; then
              # 常见情况：布局写成功了，只是收尾动作（close 之类）报错。
              # 不能说「失败」，也不能装作没事 —— 把原因摆出来。
              echo "    已生成 ${DMG}（验签通过，安装界面布局**已生效**）"
              echo "      注：AppleScript 退出码非零（${APL_MSG:-无输出}）——"
              echo "          属收尾动作的无害报错，背景图与图标位置都已写入。"
            else
              echo "    已生成 ${DMG}（盘内验签通过，安装界面布局已生效）"
            fi
          else
            echo "    ⚠ 已生成 ${DMG}，但**安装界面布局没生效**（盘内没有 backgroundImageAlias / Iloc）"
            if [ "$APL_FAILED" = "1" ]; then
              echo "      原因：${APL_MSG:-AppleScript 失败且无输出}"
            fi
            echo "      解决：在**你自己的终端**里跑一次 ./scripts/game/package.sh（首次会弹"
            echo "            「想控制 Finder」的授权，点允许），或到 系统设置 → 隐私与安全性"
            echo "            → 自动化 里给终端勾上 Finder。"
            echo "      另：打包时有同名 dmg 挂着也会这样（脚本已自动清理，重跑即可）。"
          fi
        else
          hdiutil detach "$DMP" -force -quiet 2>/dev/null || true
          echo "❌ dmg 内 app 验签失败，删除坏盘"
          rm -f "$DMG"
          exit 1
        fi
        hdiutil detach "$DMP" -quiet 2>/dev/null || hdiutil detach "$DMP" -force -quiet 2>/dev/null || true
      else
        echo "    已生成 ${DMG}（未能挂载复核；zip 已验签可作凭据）"
      fi
    else
      echo "    (DMG 生成失败，zip 仍然可用)"
    fi
  else
    echo "    (临时映像挂载失败，跳过 DMG)"
  fi
  rm -f "$RW_DMG"
fi

# ---- 分发指纹 ----
# ad-hoc 签名不防二次传播中被换包；把指纹文件放在 dist/（与 zip/dmg 同目录、随发布物一起发），
# 接收者下载后跑  shasum -a 256 -c SHA256SUMS-macOS.txt  即可自验完整性。
# （不写进 使用说明.txt：那是维护者自述的文件，且 zip 的指纹也无法自指地写进 zip 内部。）
echo "==> 分发指纹 SHA256SUMS"
SUMS="$DIST/SHA256SUMS-macOS.txt"
: > "$SUMS"
for f in "$APP-macOS-arm64.zip" "$APP-macOS-arm64.dmg"; do
  if [ -f "$DIST/$f" ]; then ( cd "$DIST" && shasum -a 256 "$f" >> "SHA256SUMS-macOS.txt" ); fi
done
cat "$SUMS"

# ---- 刷新图标缓存 ----
# 为什么必须做：打包只换了 .app 里的 icon.icns，但 Finder / Dock 有自己的
# 图标缓存（macOS 26 Tahoe 尤其顽固）。表现是「文件、签名、plist 全对，
# 系统 API 也返回新图标，界面上却还是旧图/占位图」—— 用户会当成没修好。
# 三步都是无副作用的：touch 改 mtime、lsregister 重新注册、Dock 重启约 1 秒。
# 想跳过（比如 CI 无 GUI）：CMS_NO_ICON_REFRESH=1
if [ "${CMS_NO_ICON_REFRESH:-0}" != "1" ]; then
  echo "==> 刷新图标缓存"
  touch "$BUNDLE" 2>/dev/null || true
  LSREG="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  if [ -x "$LSREG" ]; then
    "$LSREG" -f "$BUNDLE" >/dev/null 2>&1 || true
    echo "    已重新注册到 LaunchServices"
  fi
  # 删 com.apple.iconservices / com.apple.dock.iconcache 需要 root。
  # 只在**非交互 sudo 可用**时顺手删（绝不弹密码，否则打包卡住等人）。
  if sudo -n true 2>/dev/null; then
    find /private/var/folders -maxdepth 6 -name "com.apple.iconservices" \
      -exec sudo rm -rf {} + 2>/dev/null || true
    find /private/var/folders -maxdepth 6 -name "com.apple.dock.iconcache" \
      -exec sudo rm -f {} + 2>/dev/null || true
    echo "    已清系统图标缓存（非交互 sudo 可用）"
  else
    echo "    （跳过系统缓存：sudo 需要密码。要彻底清可在终端跑："
    echo "      sudo find /private/var/folders -name com.apple.iconservices -exec rm -rf {} \\;）"
  fi
  killall Dock 2>/dev/null || true
  echo "    已重启 Dock。若 Finder 窗口里仍是旧图："
  echo "    右键 app → 显示简介 → 点左上角图标 → 按 Delete，强制重读内部资源。"
fi
