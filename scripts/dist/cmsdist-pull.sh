#!/bin/bash
# cmsdist-pull.sh — 每天把跑分结果从 ECS 拉到本地（覆盖式，两端各一份；ECS 云快照兜底）
# 安装：scripts/dist/install-cmsdist-pull.sh（写 LaunchAgent 并 load）
set -euo pipefail

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。LaunchAgent 调用时唯一来源。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
[ -n "${CMS_HOST:-}" ] && [ -n "${CMS_SSH_PORT:-}" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT" >&2; exit 1; }

DEST="$HOME/Backups/cms-dist"
mkdir -p "$DEST"
rsync -a --delete -e "ssh -p ${CMS_SSH_PORT}" "${CMS_HOST}:/var/lib/cmsdist/" "$DEST/"
echo "$(date '+%F %T') cmsdist 拉取完成：$(du -sh "$DEST" | cut -f1)" >> "$DEST/.pull.log"
