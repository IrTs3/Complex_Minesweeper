#!/usr/bin/env bash
# 双击本文件即可把调度服务器部署到 ECS（macOS 会用「终端」运行它）
# 等价于在项目目录执行 bash scripts/dist/deploy-dist.sh
# ⚠ 会覆盖服务器 /opt/cmsdist/dist_server.py 并 restart cmsdist 服务，
#   在跑的客户端会立刻感知（领任务/交结果中断一次，自动重试）——确认要发版再双击。
cd "$(dirname "$0")/../.." || exit 1

echo "================================================"
echo "  cmsdist 调度服务器部署（ECS 7120）"
echo "================================================"
echo

bash scripts/dist/deploy-dist.sh

echo
echo "（按回车键关闭此窗口）"
read -r _
