#!/usr/bin/env bash
# 在 Mac 上安装「定时拉取闸门快照」的 LaunchAgent（异地备份的 Mac 侧）。
# 生成 ~/Library/LaunchAgents/com.cms.gate-backup-pull.plist 并加载；幂等，可重跑。
#
# 为什么不是「每天 07:23」：StartCalendarInterval 只在那一刻恰好开机/唤醒时才会跑，
# Mac 合盖过夜 = 当天这一次静默跳过，而且不会补跑 —— 备份断掉恰恰在你最不注意的时候。
# 改成 StartInterval 1 小时 + RunAtLoad：登录/唤醒就拉一次（RunAtLoad），missed 的间隔
# launchd 会合并成一次补跑；rsync 增量，重复拉的成本接近零。服务器 03:17 出快照，
# 所以任何一次 03:17 之后的拉取都能拿到当天的份。
#
# 用法：./scripts/web/install-mac-backup.sh                 # 交互式粘贴 ping URL（不回显）
#       MAC_PULL_URL='https://...' ./scripts/web/install-mac-backup.sh   # 环境变量注入（会进 shell 历史）
# 已有 ~/.cmsgate/mac-pull.url 且未给 MAC_PULL_URL 时直接沿用，不会每次重跑都问一遍。
set -euo pipefail
cd "$(dirname "$0")/../.."

LABEL="com.cms.gate-backup-pull"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
PULL="$PWD/tools/mac-backup-pull.sh"
LOG_DIR="$HOME/Library/Logs/cmsgate"

[ -x "$PULL" ] || { echo "✗ 找不到可执行的 ${PULL}（先 chmod +x）" >&2; exit 1; }
install -d -m 700 "$LOG_DIR"
install -d -m 700 "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PULL}</string>
    </array>
    <key>StartInterval</key><integer>3600</integer>
    <key>StandardOutPath</key><string>${LOG_DIR}/pull.log</string>
    <key>StandardErrorPath</key><string>${LOG_DIR}/pull.err</string>
    <key>RunAtLoad</key><true/>
</dict>
</plist>
PLIST

plutil -lint "$PLIST"
launchctl bootout "gui/$(id -u)/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ 已安装并加载 ${LABEL}（每小时拉取 + 登录即拉；日志 ${LOG_DIR}/pull.log）"

# ---- 死人开关的 Ping URL（密钥）----
# Healthchecks 上给 Mac 这条单独建一个 check（建议 Period 7 天 / Grace 1 天：合盖过夜
# 是常态，报的是「异地那份落后一周了」而不是「备份没了」）。URL 只落 ${URL_FILE}（600），
# 绝不进 git、绝不进 argv、绝不打印 —— 与服务器 /etc/cmsgate/healthcheck.url 同一套规矩。
URL_FILE="$HOME/.cmsgate/mac-pull.url"
if [ -z "${MAC_PULL_URL:-}" ] && [ -s "$URL_FILE" ]; then
    echo "✓ 沿用已有的 ${URL_FILE}（要换 URL：MAC_PULL_URL='https://...' 重跑，或先删掉该文件）"
else
    if [ -z "${MAC_PULL_URL:-}" ]; then
        printf '请粘贴 Mac 拉取专用 check 的 Healthchecks ping URL（输入不回显，绝不写入仓库）：' >&2
        read -rs MAC_PULL_URL || { echo "✗ 未读到 ping URL" >&2; exit 1; }
        echo >&2
    fi
    case "$MAC_PULL_URL" in
        *[[:space:]]*) echo "✗ ping URL 含空白字符（粘贴时可能带了换行/空格）" >&2; exit 1 ;;
    esac
    case "$MAC_PULL_URL" in
        *://*/*) : ;;   # 有 scheme + host + 路径（UUID）即可，兼容自建实例
        *) echo "✗ ping URL 格式不对：应形如 https://<host>/<uuid>" >&2; exit 1 ;;
    esac
    echo "  ✓ ping URL 格式校验通过（长度 ${#MAC_PULL_URL}，内容不打印）"
    install -d -m 700 "$HOME/.cmsgate"
    (umask 077; printf '%s\n' "$MAC_PULL_URL" > "$URL_FILE")
    chmod 600 "$URL_FILE"
    unset MAC_PULL_URL
    echo "  已写入 $(stat -f '%Sp %Su' "$URL_FILE") ${URL_FILE}"
fi

echo "  手动验证一次：bash ${PULL}（跑完应在 Healthchecks 上看到一条成功 ping）"
