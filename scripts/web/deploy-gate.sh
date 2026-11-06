#!/usr/bin/env bash
# 部署「访问闸门」的服务端部分：系统用户、数据目录、签名密钥、systemd 服务。
#
# 与 deploy-web.sh 的分工：
#   deploy-gate.sh（本脚本） —— 用户 / 目录 / 密钥 / 服务 / 数据   （服务端）
#   deploy-web.sh           —— nginx 站点与 auth_request 接线     （网关）
#
# **必须先跑本脚本，再跑 deploy-web.sh**。
# 反过来的话，nginx 一重载就要求 auth_request，而后端还不在 → 谁都进不去。
#
# 用法：
#   ./deploy-gate.sh
#   SERVER=root@1.2.3.4 SSH_PORT=22 ./deploy-gate.sh
#
# 沙箱提示：本机 shell 脚本可能被沙箱拒绝执行（脚本内容不透明）。
# 每一段都是独立的、可单独粘贴执行的 ssh / scp 命令，便于逐步手动执行。
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
GATE_PORT="${GATE_PORT:-8090}"
RUN_USER="cmsgate"
APP_DIR="/opt/cmsgate"
DATA_DIR="/var/lib/cmsgate"

SSH="ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"
SCP="scp -P ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

echo "==> 目标：${SERVER}（服务端用户 ${RUN_USER}，回环端口 ${GATE_PORT}）"

# 1) 系统用户 + 目录（幂等）
echo "==> 创建系统用户与目录"
$SSH "$SERVER" "
    set -e
    if ! id -u ${RUN_USER} >/dev/null 2>&1; then
        useradd --system --user-group --home-dir ${DATA_DIR} --shell /usr/sbin/nologin ${RUN_USER}
        echo '  已创建用户 ${RUN_USER}'
    else
        echo '  用户 ${RUN_USER} 已存在'
    fi
    install -d -m 700 -o ${RUN_USER} -g ${RUN_USER} ${DATA_DIR}
    install -d -m 755 -o root -g root ${APP_DIR}
    echo \"  ${DATA_DIR} 0700 ${RUN_USER}:${RUN_USER}\"
    echo \"  ${APP_DIR} 0755 root:root\"
"

# 2) 签名密钥（仅首次生成；存在就绝不动它，否则会踢掉所有在线会话）
echo "==> 确保签名密钥存在（存在则不动）"
$SSH "$SERVER" "
    set -e
    if [ -s ${DATA_DIR}/secret.key ]; then
        echo '  secret.key 已存在，保持不变'
    else
        umask 077
        head -c 32 /dev/urandom > ${DATA_DIR}/secret.key
        echo '  已生成新的 secret.key'
    fi
    chown ${RUN_USER}:${RUN_USER} ${DATA_DIR}/secret.key
    chmod 600 ${DATA_DIR}/secret.key
    ls -l ${DATA_DIR}/secret.key | sed 's/^/  /'
"

# 3) 部署服务端程序
echo "==> 部署 authd.py"
$SCP server/authd.py "$SERVER:${APP_DIR}/authd.py"
$SSH "$SERVER" "chown root:root ${APP_DIR}/authd.py && chmod 644 ${APP_DIR}/authd.py && echo '  已就位'"

# 4) systemd unit（整体覆盖，改单元文件即改线上）
echo "==> 写入 systemd unit"
$SSH "$SERVER" "cat > /etc/systemd/system/cmsgate.service" < server/cmsgate.service
$SSH "$SERVER" "systemctl daemon-reload && echo '  已 daemon-reload'"

# 5) 启动并验证
echo "==> 启动服务并验证"
$SSH "$SERVER" "
    set -e
    systemctl enable cmsgate >/dev/null 2>&1
    systemctl restart cmsgate
    sleep 1
    if ! systemctl is-active --quiet cmsgate; then
        echo '  ✗ 服务没起来，最近日志：' >&2
        journalctl -u cmsgate -n 25 --no-pager >&2
        exit 1
    fi
    echo '  ✓ systemd 状态 active'

    # 必须只监听回环
    listen=\$(ss -ltnp 2>/dev/null | grep ':${GATE_PORT} ' || true)
    echo \"  监听: \$listen\"
    case \"\$listen\" in
      *'127.0.0.1:${GATE_PORT}'*) echo '  ✓ 只监听回环' ;;
      *) echo '  ✗ 监听地址不对（必须只有 127.0.0.1）——立即停止服务' >&2
         systemctl stop cmsgate; exit 1 ;;
    esac

    # UFW 绝不该放行这个端口（只走回环）
    if ufw status 2>/dev/null | grep -q '${GATE_PORT}'; then
        echo '  ✗ UFW 竟然放行了 ${GATE_PORT} —— 立刻删掉该规则' >&2
        exit 1
    fi
    echo '  ✓ UFW 未放行 ${GATE_PORT}（正确）'

    echo -n '  /health: '
    curl -s http://127.0.0.1:${GATE_PORT}/health || { echo '失败' >&2; exit 1; }
    echo ''
"

# 6) 数据目录权限复核
echo "==> 数据目录复核"
$SSH "$SERVER" "ls -la ${DATA_DIR} | sed 's/^/  /'"

echo ""
echo "==> 服务端就绪。接下来："
echo "    1) 部署密码表：  python3 tools/gate_manager.py push"
echo "    2) 再开闸门：    ./scripts/web/deploy-web.sh"
