#!/usr/bin/env bash
# 双击本文件即可打包（macOS 会用「终端」运行它）
# 等价于在项目目录执行 ./scripts/game/package.sh
cd "$(dirname "$0")/../.." || exit 1

echo "================================================"
echo "  复数扫雷 · macOS 打包"
echo "================================================"
echo

./scripts/game/package.sh

echo
echo "================================================"
echo "  产物在: dist/"
echo "================================================"
ls -lh dist/*.zip 2>/dev/null
echo
echo "（按回车键关闭此窗口）"
read -r _
