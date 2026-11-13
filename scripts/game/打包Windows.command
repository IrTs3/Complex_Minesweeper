#!/usr/bin/env bash
# 双击本文件 → 打包 Windows 版（交叉编译出 .exe）
# 首次使用需要交叉编译器 mingw-w64，本脚本会提示（并可选自动安装）
cd "$(dirname "$0")/../.." || exit 1

echo "================================================"
echo "  复数扫雷 · Windows 版打包（交叉编译）"
echo "================================================"
echo

if ! command -v x86_64-w64-mingw32-g++ >/dev/null 2>&1; then
  echo "还没有安装交叉编译器 mingw-w64。"
  echo
  echo "需要先执行（下载几百 MB，只需一次）："
  echo "    brew install mingw-w64"
  echo
  printf "现在自动帮你安装吗？(y/N) "
  read -r ans
  case "$ans" in
    y|Y|yes|YES|是)
      echo
      echo "开始安装 mingw-w64 …"
      brew install mingw-w64 || echo "安装失败，请手动执行 brew install mingw-w64"
      ;;
    *)
      echo
      echo "已跳过。装好之后重新双击本文件即可。"
      ;;
  esac
  echo
  echo "（按回车键关闭此窗口）"
  read -r _
  exit 0
fi

echo "找到交叉编译器，开始打包（SFML 首次编译需要几分钟）…"
echo

./scripts/game/build_windows.sh

echo
echo "================================================"
echo "  产物在: dist/ComplexMinesweeper-win64/"
echo "================================================"
ls -lh dist/ComplexMinesweeper-win64/ 2>/dev/null
echo
echo "注意：发给别人时要整个文件夹一起给（exe + assets/ 缺一不可）"
echo "（按回车键关闭此窗口）"
read -r _
