#!/bin/bash
# deploy-dist.sh — 部署 cmsdist 跑分调度服务到 ECS（公开 7120）
# 用法：bash scripts/dist/deploy-dist.sh
# ⚠ 前置（手动一次）：
#   1) 阿里云安全组放行 TCP 7120（控制台 → 安全组 → 添加入方向规则）
#   2) ufw：ssh -p <SSH端口> root@<服务器IP> "ufw allow 7120/tcp"
#   3) 服务器解释器要能 scrypt（admin 口令校验用）：ssh … "python3 -c 'import hashlib;assert hasattr(hashlib,\"scrypt\")'"
set -euo pipefail

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
[ -n "${CMS_HOST:-}" ] && [ -n "${CMS_SSH_PORT:-}" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT" >&2; exit 1; }
SSH="ssh ${CMS_HOST} -p ${CMS_SSH_PORT}"
SCP="scp -P ${CMS_SSH_PORT}"
HERE=$(cd "$(dirname "$0")/../.." && pwd)

echo "==> 上传代码"
$SSH "mkdir -p /opt/cmsdist /var/lib/cmsdist/results && chown -R cmsgate:cmsgate /var/lib/cmsdist"
$SCP "$HERE/tools/dist_server.py" ${CMS_HOST}:/opt/cmsdist/dist_server.py
$SCP "$HERE/server/cmsdist.service" ${CMS_HOST}:/etc/systemd/system/cmsdist.service

echo "==> 初始化（state/secret 已存在则不动）"
$SSH "test -f /var/lib/cmsdist/state.json || python3 -c \"
import sys; sys.path.insert(0, '/opt/cmsdist')
import dist_server; dist_server.ensure_dirs()
\" && chown cmsgate:cmsgate /var/lib/cmsdist/state.json /var/lib/cmsdist/secret 2>/dev/null || true"

echo "==> 撤掉 7120 的 ufw 规则（2026-11-05 收口：明文口收回环后防火墙层一并收；安全组那条手动删）"
$SSH "ufw delete allow 7120/tcp >/dev/null 2>&1 || true"

echo "==> 启动/重启服务（enable --now 对已在跑的服务不生效，重部署必须显式 restart）"
$SSH "systemctl daemon-reload && systemctl enable cmsdist && systemctl restart cmsdist && sleep 1 && systemctl is-active cmsdist"

echo "==> 本机自测 /ping"
$SSH "curl -fsS -m 5 http://127.0.0.1:7120/ping"

echo
echo "✅ cmsdist 已上线。后续："
echo "   - 管理看板：python3 tools/distctl.py status"
echo "   - 队友客户端：python3 tools/dist_client.py --server https://ty0712.com:12712"
echo "   - healthcheck 第 9 项（cmsdist 自检）由 deploy-monitor.sh 更新时带上——"
echo "     ⚠ 服务器线上脚本含 QQbot 段（不进仓库），先 diff 保留再更新！"
