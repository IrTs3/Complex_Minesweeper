#!/usr/bin/env bash
# 部署「闸门存活监控」——Healthchecks 出站死人开关（dead man's switch）。
#
# 服务器上的 systemd 定时器每 2 分钟跑一次 healthcheck.sh：
#   · 十三项探活全绿 + 服务器专属扩展段（QQbot 探活 = 第 14 项，独立文件 /opt/cmsgate/
#     healthcheck-extra.sh，不进仓库；本脚本只覆盖本体、永不碰扩展文件，
#     旧版本体若带 QQbot 段会在部署时自动迁出成扩展文件）
#     → 向 Healthchecks 发一个成功 ping。
#   · 任一项挂     → 记连续失败计数（/opt/cmsgate/healthcheck-fails），连续 2 轮挂才发 /fail
#                     + 写 journal；单次抖动不告警（2026-11-06 astrbot 探测瞬时 000 误报后加的去重）。
#   · 连 ping 都不来（整机宕机/网络断/定时器死）→ Healthchecks 在 period+grace 内收不到 ping，由它告警你。
# 只发出站 443，不新增任何入站暴露面。
#
# 与其它部署脚本的顺序（本脚本必须最后跑）：
#   deploy-gate.sh（authd 服务）→ deploy-web.sh（nginx 闸门）→ **本脚本**（监控）
#   因为探活的第 4 项要 cmsgate 在跑、nginx 在跑、/dist/main.js 返回 404（404 模型下未登录＝当作不存在），
#   第 6 项还要 nginx 片段指向的秘密入口打得开 —— 前面几步没部署完就跑本脚本，会得到一个 /fail 假警报。
#
# 用法（ping URL 是密钥：持有者可伪造"正常"或刷 /fail，两种注入方式都不进 argv/git）：
#   HC_PING_URL='https://...' ./scripts/web/deploy-monitor.sh    # 环境变量（注意会进 shell 历史）
#   ./scripts/web/deploy-monitor.sh                              # 交互式，粘贴时不回显（更稳妥）
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
APP_DIR="/opt/cmsgate"          # 与 deploy-gate.sh 一致
CFG_DIR="/etc/cmsgate"          # 密钥目录（600，仓库外）

SSH="ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"
SCP="scp -P ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

# ---- 0) 读 ping URL（密钥）：优先环境变量，否则交互读取（不回显）----
# 服务器上没有密钥文件才要 URL：重灌探活脚本不该逼人再粘一次密钥 —— 嫌麻烦就会绕开本脚本
# 去裸 scp，而绕开脚本正是「旧版覆盖丢 QQbot 段」那类事故的来路（2026-11-02）。
if [ -n "${HC_PING_URL:-}" ]; then
    echo "==> 使用环境变量 HC_PING_URL 里的 ping URL"
elif $SSH "$SERVER" "test -s ${CFG_DIR}/healthcheck.url" 2>/dev/null; then
    HC_PING_URL=""
    echo "==> 沿用服务器上已有的 ${CFG_DIR}/healthcheck.url（本轮不重灌；要换 URL：HC_PING_URL='https://...' 重跑）"
else
    printf '请粘贴 Healthchecks ping URL（输入不回显，绝不写入仓库/argv）：' >&2
    read -rs HC_PING_URL || { echo "✗ 未读到 ping URL" >&2; exit 1; }
    echo >&2
fi

if [ -n "$HC_PING_URL" ]; then
    # 校验格式（密钥本身绝不打印，只报通过与否 + 长度）
    case "$HC_PING_URL" in
        *[[:space:]]*) echo "✗ ping URL 含空白字符（粘贴时可能带了换行/空格）" >&2; exit 1 ;;
    esac
    case "$HC_PING_URL" in
        https://*/*) : ;;   # 有 scheme + host + /path（UUID），也兼容自建实例
        *) echo "✗ ping URL 格式不对：应以 https:// 开头且含 /<uuid> 路径" >&2; exit 1 ;;
    esac
    echo "  ✓ ping URL 格式校验通过（长度 ${#HC_PING_URL}，内容不打印）"

    # ---- 1) 注入密钥文件（stdin 管道，绝不进 argv；600 root）----
    echo "==> 写入 ${CFG_DIR}/healthcheck.url（600 root，经 stdin 注入）"
    $SSH "$SERVER" "
        set -e
        install -d -m 700 ${CFG_DIR}
        umask 077
        cat > ${CFG_DIR}/healthcheck.url
        chown root:root ${CFG_DIR}/healthcheck.url
        chmod 600 ${CFG_DIR}/healthcheck.url
        echo \"  已写入 \$(stat -c '%a %U:%G' ${CFG_DIR}/healthcheck.url) ${CFG_DIR}/healthcheck.url\"
    " <<< "$HC_PING_URL"
fi
unset HC_PING_URL

# ---- 2) 部署探活脚本（旧版先备份；旧版本体里带 QQbot 段就自动迁出到扩展文件）----
echo "==> 目标：${SERVER}（探活脚本 ${APP_DIR}/healthcheck.sh，密钥 ${CFG_DIR}/healthcheck.url）"
echo "==> 部署 healthcheck.sh（旧版备份 → 覆盖 → QQbot 段自动迁移）"
$SSH "$SERVER" "cp ${APP_DIR}/healthcheck.sh ${APP_DIR}/healthcheck.sh.prev 2>/dev/null || true"
$SCP server/cmsgate-healthcheck.sh "$SERVER:${APP_DIR}/healthcheck.sh"
$SSH "$SERVER" "
    set -e
    chown root:root ${APP_DIR}/healthcheck.sh && chmod 755 ${APP_DIR}/healthcheck.sh
    # 连续失败计数文件：预建（沙箱 ProtectSystem=strict 下脚本自己造不出来），
    # unit 里 ReadWritePaths 只对这一个文件开口。600：计数无密但保持习惯最小权限。
    touch ${APP_DIR}/healthcheck-fails
    chown root:root ${APP_DIR}/healthcheck-fails && chmod 600 ${APP_DIR}/healthcheck-fails
    echo \"  ✓ 失败计数文件在位：\$(stat -c '%a %U:%G' ${APP_DIR}/healthcheck-fails)\"
    # 语法先过再谈上线：本体是 cron 之外的静默件，写坏了每 2 分钟失败一次而页面只会变红。
    sh -n ${APP_DIR}/healthcheck.sh || { echo '    ✗ 本体语法坏了，中止部署（旧版备份在 healthcheck.sh.prev）' >&2; exit 1; }
    echo '  ✓ 本体 sh -n 通过'
    # 扩展段（QQbot = 线上第 14 项）在不在，部署时要吭声：不在就是服务器专属段丢了。
    if [ -f ${APP_DIR}/healthcheck-extra.sh ]; then
        echo \"  ✓ 扩展段在位：\$(stat -c '%a %U:%G' ${APP_DIR}/healthcheck-extra.sh) ${APP_DIR}/healthcheck-extra.sh\"
        # 本体从九项加到十三项，扩展段里那行编号注释得跟着改口径（它现在实际是第 14 项）。
        # 只动这一行注释，绝不碰它下面的检查内容；不是这个形状就原样留着并吭声。
        if sed -n '/^# 10) QQbot/p' ${APP_DIR}/healthcheck-extra.sh | grep -q .; then
            sed -i 's/^# 10) QQbot/# 14) QQbot/' ${APP_DIR}/healthcheck-extra.sh
            echo '  ✓ 扩展段编号注释 # 10) → # 14)（只改注释，检查内容未动）'
        else
            grep -q '^# 14) QQbot' ${APP_DIR}/healthcheck-extra.sh \\
                && echo '  · 扩展段编号已是 # 14)，无需改' \\
                || echo '  · 扩展段没有「# 10) QQbot」这行注释（可能自建形状），编号未动' >&2
        fi
    else
        echo '  · 无扩展段（本机线上只跑仓库这十三项）'
    fi
    # 保险杠：旧版本体里带 QQbot 段而扩展文件还没有 → 从备份抽出来落成独立文件。
    # 迁移之后本体随便覆盖，QQbot 段永远躺在 healthcheck-extra.sh 里不被碰。
    # 抽取范围 = 旧版「# 10) QQbot」注释行到 OK 行之前；抽出来是空就硬失败，
    # 宁可中止部署也不静默丢 bot 检查（旧版备份留在 healthcheck.sh.prev 可手工恢复）。
    if grep -q 'QQbot' ${APP_DIR}/healthcheck.sh.prev 2>/dev/null \
       && [ ! -f ${APP_DIR}/healthcheck-extra.sh ]; then
        sed -n '/^# 10) QQbot/,/^# 全绿/p' ${APP_DIR}/healthcheck.sh.prev \
            | sed '\$d' > ${APP_DIR}/healthcheck-extra.sh
        [ -s ${APP_DIR}/healthcheck-extra.sh ] \
            || { echo '    ✗ QQbot 段迁移抽出来是空的，中止部署（旧版备份在 healthcheck.sh.prev）' >&2; exit 1; }
        chown root:root ${APP_DIR}/healthcheck-extra.sh
        chmod 600 ${APP_DIR}/healthcheck-extra.sh
        echo '  ✓ 旧版 QQbot 段已迁出为 healthcheck-extra.sh（独立文件，以后覆盖本体不再碰它）'
    fi
    if [ -f ${APP_DIR}/healthcheck-extra.sh ]; then
        echo '  ✓ QQbot 扩展段在位（将随本体一起执行）'
    else
        echo '  （服务器没有 QQbot 扩展段——若本该有，自测 journal 会缺 bot 项检查）'
    fi
"

# ---- 3) 部署 systemd unit（service + timer，整体覆盖）----
echo "==> 写入 systemd unit（service + timer）"
$SSH "$SERVER" "cat > /etc/systemd/system/cmsgate-healthcheck.service" < server/cmsgate-healthcheck.service
$SSH "$SERVER" "cat > /etc/systemd/system/cmsgate-healthcheck.timer" < server/cmsgate-healthcheck.timer
$SSH "$SERVER" "systemctl daemon-reload && echo '  已 daemon-reload'"

# ---- 4) 启用定时器 ----
echo "==> 启用并启动 cmsgate-healthcheck.timer"
$SSH "$SERVER" "systemctl enable --now cmsgate-healthcheck.timer && echo '  timer 已 enable --now'"

# ---- 5) 强制自测（任一不过即 exit 1）----
echo "==> 自测 1/4：手动跑一次探活（**只看本轮**日志必须出现 OK:，证明十三项全绿 + 出站 ping 通）"
$SSH "$SERVER" "
    set -e
    # 为什么不能只看退出码、也不能 grep -n 20：ping_fail 是**故意** exit 0 的（已告警就不必
    # 让 systemd 报 failed），所以退出码证明不了绿；而 -n 20 会把上一轮的 OK: 一起捞进来 ——
    # 11-02 负向测试实测：脚本正在报 FAIL，自测照样打「✓ 探活全绿」。窗口收到本次触发之后。
    since=\$(date -Iseconds)
    systemctl start cmsgate-healthcheck.service
    status=\$(systemctl show -p ExecMainStatus --value cmsgate-healthcheck.service)
    out=\$(journalctl -u cmsgate-healthcheck.service --since \"\$since\" --no-pager -o cat)
    echo \"\$out\" | sed 's/^/    /'
    # 退出码非 0 只可能是脚本自己没跑起来（密钥文件不可读 / 语法坏 / 成功 ping 发不出去）
    [ \"\$status\" = 0 ] || { echo '    ✗ 探活脚本自身异常退出（非「某项判红」：那种情况按设计退 0）' >&2; exit 1; }
    echo \"\$out\" | grep -q '^OK:' \\
        || { echo '    ✗ 本轮探活没出现 OK:（有项判红：FAIL: = 已发失败信号，FAIL(待确认) = 连续第 1 次还不发）' >&2; exit 1; }
    echo '  ✓ 本轮十三项全绿 + 成功 ping 已发出'
"

echo "==> 自测 2/4：定时器 active，且能看到下次触发时间"
$SSH "$SERVER" "
    set -e
    systemctl is-active --quiet cmsgate-healthcheck.timer || { echo '    ✗ timer 未 active' >&2; exit 1; }
    echo '  ✓ timer active'
    systemctl list-timers cmsgate-healthcheck.timer --no-pager | sed 's/^/    /'
"

echo "==> 自测 3/4：密钥文件权限必须 600"
$SSH "$SERVER" "
    perm=\$(stat -c '%a' ${CFG_DIR}/healthcheck.url)
    [ \"\$perm\" = 600 ] || { echo \"    ✗ healthcheck.url 权限是 \${perm}，应为 600\" >&2; exit 1; }
    echo \"  ✓ healthcheck.url = 600 root\"
"

echo "==> 自测 4/4：源码防泄漏断言（密钥 ping URL 绝不在仓库里）"
if git ls-files | grep -q 'healthcheck\.url'; then
    echo "  ✗ healthcheck.url 竟被 git 跟踪（应只在服务器 ${CFG_DIR}/，且已 .gitignore）" >&2
    exit 1
fi
echo "  ✓ git 未跟踪 healthcheck.url"
if grep -qE 'https://' server/cmsgate-healthcheck.sh server/cmsgate-healthcheck.service server/cmsgate-healthcheck.timer; then
    echo "  ✗ 探活运行期文件里出现硬编码 https:// 端点（ping URL 只应来自密钥文件）" >&2
    exit 1
fi
echo "  ✓ 探活运行期文件无硬编码 https:// 端点"

echo ""
echo "==> 监控已上线。接下来（Healthchecks 控制台，你来做）："
echo "    1) 新建 check：Period≈2min、Grace≈5min（漏 1~2 次 ping 再告警，避免抖动误报）"
echo "    2) 加通知渠道（邮件最省事；要手机推送就接 Telegram）"
echo "    3) 面板此刻应已收到刚才自测发出的成功 ping"
echo "    4) 负向测试：ssh 上服务器 'systemctl stop cmsgate' → ≤2min 内应收到告警 →"
echo "       再 'systemctl start cmsgate' 恢复（测完务必把 cmsgate 起回来）"
