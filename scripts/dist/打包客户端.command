#!/usr/bin/env bash
# 双击本文件即可打包分布式客户端并推自动更新（macOS 会用「终端」运行它）
# 等价于在项目目录执行 ./scripts/dist/package-dist-client.sh
# ⚠ 会编译三端 solver（mac/win 直接编，linux 借生产 ECS 编）+ 打三端包 +
#   签名后把更新推到服务器，在跑的客户端会在任务边界自动更新——
#   确认要发版再双击。
cd "$(dirname "$0")/../.." || exit 1

echo "================================================"
echo "  cmsdist 客户端打包 + 推自动更新"
echo "================================================"
echo

bash scripts/dist/package-dist-client.sh

echo
echo "================================================"
echo "  产物在: dist-solver/"
echo "================================================"
ls -lh dist-solver/*.dmg dist-solver/*.zip dist-solver/*.tar.gz 2>/dev/null
echo
echo "（按回车键关闭此窗口）"
read -r _
