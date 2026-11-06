#!/bin/bash
# 从服务器拉闸门快照到 ~/Backups/cms/（异地备份的 Mac 侧），本地保留 1000 份，600。
# 由 LaunchAgent com.cms.gate-backup-pull 每小时 + 每次登录触发（服务器 03:17 出快照；
# 用 StartInterval 而不是固定 07:23，免得合盖过夜就静默漏掉一天）。
# 走**出站** ssh（复用部署用的 root 密钥），服务器不新增任何入站暴露面。
#
# 恢复：scp 选定的 tar.gz 回服务器，解到 /var/lib/cmsgate（先停 cmsgate、解包、再启动）。
#       完整步骤与 chown 的判断（本机 root 解包不需 chown，换机才需）见 server/RESTORE.md
#
# 死人开关（2026-11-02 加）：拉取成功发一条 ping，脚本非 0 退出发 /fail。
# 为什么必须单独一条：服务器探活的第 8 项只看 /root/cms-backup 里快照新不新 —— 快照
# 打成功、但 Mac 这份**没拉走**（密钥失效 / 盘满 / 远端目录被清 / 长期没开机）时，
# 异地那份已经断供而监控全绿。Healthchecks 上这条 check 的 Period=7 天 / Grace=1 天：
# 合盖过夜是常态，不能一合盖就报红，报的是「异地那份开始落后了」而不是「备份没了」。
# Ping URL 是密钥（持有者可伪造"正常"或刷 /fail）：只存 ~/.cmsgate/mac-pull.url（600），
# 绝不进 git、绝不进 argv（经 stdin 交给 curl -K -），失败原因串里也不带它。
set -eu

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。SERVER=/SSH_PORT= 可临时覆盖。
# LaunchAgent 调用时没有你的 shell 环境，这个文件就是唯一来源。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
SERVER="${SERVER:-${CMS_HOST:-}}"
SSH_PORT="${SSH_PORT:-${CMS_SSH_PORT:-}}"
[ -n "$SERVER" ] && [ -n "$SSH_PORT" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT（也可用 SERVER= / SSH_PORT= 临时覆盖）" >&2; exit 1; }
DEST="$HOME/Backups/cms"
PULL_URL_FILE="$HOME/.cmsgate/mac-pull.url"

PULL_BASE=""
if [ -r "$PULL_URL_FILE" ]; then
    PULL_BASE=$(head -n 1 "$PULL_URL_FILE")
    PULL_BASE=${PULL_BASE%/}          # 结尾斜杠会拼成 //fail
else
    echo "提示：${PULL_URL_FILE} 不存在 —— 本轮不发 ping（跑 scripts/web/install-mac-backup.sh 注入 Ping URL）"
fi

# $1 = 动作后缀（"" 成功 / "/fail" 失败），$2 = 失败原因（可空，进 body）
hc_send() {
    [ -n "$PULL_BASE" ] || return 0
    local url="${PULL_BASE}${1}" body="${2-}"
    if [ -n "$body" ]; then
        printf 'url = "%s"\n' "$url" | curl -fsS -m 10 -o /dev/null --data-binary "$body" -K - 2>/dev/null || true
    else
        printf 'url = "%s"\n' "$url" | curl -fsS -m 10 -o /dev/null -K - 2>/dev/null || true
    fi
}
# 告警通道自己坏了（出站被挡、URL 过期）绝不能把备份拉取带崩 —— 所以 hc_send 全程 || true，
# 这里也只在非 0 退出时补一条 /fail。
# ★ 整条 trap 必须在单引号里：一旦让 '"$rc"' 那样跳出单引号，$rc 就在**定义 trap 的那一刻**
#   展开，set -u 下直接 unbound、脚本连 rsync 都没跑到就退 1（11-02 首跑就是这么死的）。
#   ${rc} 带花括号：全角括号紧跟 $rc 会被 zh_CN.UTF-8 的 bash 3.2 并进变量名。
trap 'rc=$?; if [ "$rc" != 0 ]; then hc_send "/fail" "Mac 备份拉取失败（退出码 ${rc}）：详见 ~/Library/Logs/cmsgate/pull.err"; fi' EXIT

install -d -m 700 "$DEST"
# 不带 --delete：Mac 侧保留历史（服务器只留 28 份，Mac 留 1000 份 = 更长历史）
rsync -az -e "ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10" \
    "${SERVER}:/root/cms-backup/" "$DEST"/

shopt -s nullglob
# 五类快照各自轮转。★ 这里曾经只处理 cms-*：bot-cfg/bot-ntqq 由 rsync 拉进来后
# **既不 chmod 也永不轮转**，等于每天 89M 无限堆积（2026-11-02 加跑分快照时才发现）。
# dist-full 是每周的明细整包，留 8 份 = 两个月；dist-meta 每天，留 28 份对齐服务器。
for spec in "cms:1000" "bot-cfg:1000" "bot-ntqq:24" "dist-meta:28" "dist-full:8"; do
    pfx=${spec%%:*}
    keep=${spec##*:}
    files=("$DEST"/${pfx}-*.tar.gz)
    if [ ${#files[@]} -eq 0 ]; then
        continue
    fi
    chmod 600 "${files[@]}"
    # 文件名间接来自服务器磁盘（rsync 拉来的），若服务器被攻破，精心构造的名字
    # （内嵌换行等）不该能放大本地 rm 的影响面：不喂给 xargs，逐行读，且每行必须
    # case 校验为 $DEST 下、该前缀命名规则内的完整绝对路径才删，否则跳过。
    ls -1t "${files[@]}" | tail -n +$((keep + 1)) | while IFS= read -r f; do
        case "$f" in
            "$DEST"/${pfx}-*.tar.gz) rm -f -- "$f" ;;
            *) echo "跳过不认识的轮转候补：$(printf '%s' "$f" | od -c | head -1)" >&2 ;;
        esac
    done
    seen=1
    echo "  ${pfx}-*：$(ls -1 "$DEST"/${pfx}-*.tar.gz | wc -l | tr -d ' ') 份（上限 ${keep}）"
done
shopt -u nullglob
if [ "${seen:-0}" != 1 ]; then
    # rsync 本身成功、目录里却一个快照都没有 = 服务器那侧从未打成功（第 8 项也会报，
    # 但那是服务器视角；这条是「异地这份根本不存在」，两回事）。
    echo "本地与服务器都还没有快照（等服务器 03:17 首次快照后再拉）"
    hc_send "/fail" "拉取跑完但一个快照都没有 —— 服务器可能从未成功打过快照"
    exit 0
fi
echo "拉取完成"
hc_send ""
