#!/bin/bash
# deploy-dist-tls.sh — 给 cmsdist 上 TLS 入口：nginx 12712 反代到本机 7120（方案一·2026-11-05）
# 用法：bash scripts/dist/deploy-dist-tls.sh
# ⚠ 前置（手动一次）：
#   1) 证书已在 /etc/nginx/ssl/ty0712.com.pem|.key（scripts/web/deploy-https.sh 签的那张，直接复用；
#      acme.sh 续期 --reloadcmd 会 reload nginx，12712 自动跟上新证书，不用另管）
#   2) 阿里云安全组放行 TCP 12712（没放行也能部署，本机自测照过，只是外网进不来）
#   3) ufw 放行 12712/tcp（本脚本代做）
# 作用：客户端与看板走 https://ty0712.com:12712 —— 加密 + 服务器身份认证，
#       中间人伪造不了 claim 回复，灌假结果的链路整个断掉。
# 明文 7120 过渡期保留（老客户端的自更新还认它）；舰队全部换新包后再收：
#   server/cmsdist.service 里把绑地址改 127.0.0.1:7120 + 安全组撤 7120。
# 回滚：nginx -t 没过自动摘除新站点并 reload 回旧状态，不会留下起不来的 nginx。
set -euo pipefail

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
[ -n "${CMS_HOST:-}" ] && [ -n "${CMS_SSH_PORT:-}" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT" >&2; exit 1; }
SSH="ssh ${CMS_HOST} -p ${CMS_SSH_PORT}"
DOMAIN=ty0712.com

echo "==> 写入 nginx 12712 站点（反代 127.0.0.1:7120，失败自动回滚）"
$SSH bash -s <<'NGINX'
set -e
DOMAIN=ty0712.com
PEM=/etc/nginx/ssl/${DOMAIN}.pem
KEY=/etc/nginx/ssl/${DOMAIN}.key
if [ ! -f "$PEM" ] || [ ! -f "$KEY" ]; then
    echo "✗ 证书不在：$PEM / $KEY —— 先跑 scripts/web/deploy-https.sh" >&2
    exit 1
fi
SITE=/etc/nginx/sites-available/cmsdist-tls
ENABLED=/etc/nginx/sites-enabled/cmsdist-tls
mkdir -p /root/cms-bak
cp -a "$SITE" /root/cms-bak/ 2>/dev/null || true
cat > "$SITE" <<SITE_BODY
# cmsdist 调度服务的 TLS 入口（scripts/dist/deploy-dist-tls.sh 写入，手改会被覆盖）。
# 证书与主站同一张（acme.sh 续期 reload nginx 后自动跟上）。
# X-Real-IP 必须发：每 IP 并发上限 / 下载配额 / done 记录全靠它——
# 缺了的话 dist_server 看到的全是回环地址，全舰队挤成一个身份。
server {
    listen 12712 ssl http2;
    listen [::]:12712 ssl http2;
    server_name $DOMAIN;
    ssl_certificate $PEM;
    ssl_certificate_key $KEY;
    client_max_body_size 8m;
    location / {
        proxy_pass http://127.0.0.1:7120;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
SITE_BODY
ln -sfn "$SITE" "$ENABLED"
if ! nginx -t; then
    rm -f "$ENABLED"
    nginx -t && systemctl reload nginx
    echo "✗ 新站点 nginx -t 没过，已摘除并 reload 回旧状态" >&2
    exit 1
fi
systemctl reload nginx
ufw allow 12712/tcp >/dev/null 2>&1 || true
ufw delete allow 7443/tcp >/dev/null 2>&1 || true   # 早期部署试过 7443，规则一并撤掉
echo "==> 服务器本机自测（走真证书域名，证书链不对 curl 就会死）"
curl -fsS --resolve ${DOMAIN}:12712:127.0.0.1 https://${DOMAIN}:12712/ping
NGINX

echo
echo "✅ 12712 TLS 已上线。"
echo "   - 安全组放行 12712 后外网验证：curl https://ty0712.com:12712/ping"
echo "   - 客户端新版默认已指向 https://ty0712.com:12712（重打包发布后才换）"
echo "   - 明文 7120 过渡期保留；舰队换完包后再收（收法见脚本头注释）"
