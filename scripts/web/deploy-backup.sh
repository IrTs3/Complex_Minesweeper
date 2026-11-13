#!/usr/bin/env bash
# 部署「闸门数据备份」的服务器部分：每日快照脚本 + systemd unit + 自测 + 恢复演练。
#
# 与 deploy-gate.sh 的分工：deploy-gate 管 authd / 目录 / 密钥 / 服务；本脚本只管"备份这套"。
# 必须在 deploy-gate.sh 之后跑（要 /var/lib/cmsgate 已存在且有 passwords.json/secret.key）。
# 备份只写 /root/cms-backup（仓库外），不碰任何线上服务，可随时重跑（幂等）。
#
# 用法：./scripts/web/deploy-backup.sh
# 沙箱提示：每一段都是独立的、可单独粘贴执行的 ssh / scp 命令，便于逐步手动执行。
set -euo pipefail
cd "$(dirname "$0")/../.."

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。SERVER=/SSH_PORT= 可临时覆盖。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
SERVER="${SERVER:-${CMS_HOST:-}}"
SSH_PORT="${SSH_PORT:-${CMS_SSH_PORT:-}}"
[ -n "$SERVER" ] && [ -n "$SSH_PORT" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT（也可用 SERVER= / SSH_PORT= 临时覆盖）" >&2; exit 1; }
APP_DIR="/opt/cmsgate"
BAK_DIR="/root/cms-backup"
DATA_DIR="/var/lib/cmsgate"

SSH="ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"
SCP="scp -P ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

echo "==> 目标：${SERVER}（快照 ${BAK_DIR}，源 ${DATA_DIR}）"

echo "==> 部署 backup.sh"
$SCP server/cmsgate-backup.sh "$SERVER:${APP_DIR}/backup.sh"
$SSH "$SERVER" "chown root:root ${APP_DIR}/backup.sh && chmod 755 ${APP_DIR}/backup.sh && echo '  已就位'"

echo "==> 写入 systemd unit（service + timer）"
$SSH "$SERVER" "cat > /etc/systemd/system/cmsgate-backup.service" < server/cmsgate-backup.service
$SSH "$SERVER" "cat > /etc/systemd/system/cmsgate-backup.timer" < server/cmsgate-backup.timer
$SSH "$SERVER" "systemctl daemon-reload && echo '  已 daemon-reload'"

echo "==> 启用 cmsgate-backup.timer"
$SSH "$SERVER" "systemctl enable --now cmsgate-backup.timer && echo '  timer 已 enable --now'"

echo "==> 自测 1/3：手动跑一次快照，确认产出 600 的 tar.gz"
$SSH "$SERVER" "
    set -e
    systemctl start cmsgate-backup.service
    newest=\$(ls -1t ${BAK_DIR}/cms-*.tar.gz | head -1)
    perm=\$(stat -c '%a' \"\$newest\")
    [ \"\$perm\" = 600 ] || { echo \"    ✗ 快照权限 \${perm}，应为 600\" >&2; exit 1; }
    echo \"  ✓ 快照 \$(basename \"\$newest\") = 600 root\"
"

echo "==> 自测 2/3：恢复演练（解最新快照到临时目录，cmp 关键文件与线上逐字节一致）"
$SSH "$SERVER" "
    set -e
    newest=\$(ls -1t ${BAK_DIR}/cms-*.tar.gz | head -1)
    drill=\$(mktemp -d)
    tar -xzf \"\$newest\" -C \"\$drill\"
    for f in passwords.json secret.key; do
        if [ ! -f \"${DATA_DIR}/\$f\" ]; then echo \"    (线上无 \${f}，跳过)\"; continue; fi
        cmp \"\$drill/\$f\" \"${DATA_DIR}/\$f\" || { echo \"    ✗ \$f 与线上不一致\" >&2; rm -rf \"\$drill\"; exit 1; }
    done
    # ★ 登录入口片段（2026-10-19 起进快照）：tar 成员名不带目录，解出来就在 \$drill 根。
    #   它丢了 = 所有访客手里的网址 404，谁都登不进来，所以演练必须连它一起验。
    GK=/etc/nginx/snippets/cms-gate-path.conf
    if [ -f \"\$GK\" ]; then
        tar -tzf \"\$newest\" | grep -qx cms-gate-path.conf \\
            || { echo '    ✗ 片段在线上存在却没进快照（backup.sh 的 tar 两支逻辑坏了？）' >&2; rm -rf \"\$drill\"; exit 1; }
        cmp \"\$drill/cms-gate-path.conf\" \"\$GK\" \\
            || { echo '    ✗ 快照里的登录入口片段与线上不一致' >&2; rm -rf \"\$drill\"; exit 1; }
        echo '  ✓ 恢复演练：passwords.json / secret.key / 登录入口片段 与线上一致'
    else
        echo '  ✓ 恢复演练：passwords.json / secret.key 与线上一致（线上暂无入口片段，跳过）'
    fi
    rm -rf \"\$drill\"
"

echo "==> 自测 3/3：timer active 且能看到下次触发"
$SSH "$SERVER" "
    set -e
    systemctl is-active --quiet cmsgate-backup.timer || { echo '    ✗ timer 未 active' >&2; exit 1; }
    echo '  ✓ timer active'
    systemctl list-timers cmsgate-backup.timer --no-pager | sed 's/^/    /'
"

echo ""
echo "==> 服务器备份层就绪。异地一份在 Mac 侧：./scripts/web/install-mac-backup.sh"
