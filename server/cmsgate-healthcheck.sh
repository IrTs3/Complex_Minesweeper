#!/bin/sh
# 复数扫雷闸门探活 + Healthchecks「死人开关」ping。
#
# 由 cmsgate-healthcheck.timer 每 2 分钟触发一次（oneshot）。逻辑：
#   · 十三项探活全绿  → 清零失败计数，向 Healthchecks 发一个成功 ping（BASE）。
#   · 任一项失败    → 记一笔连续失败计数；连续第 2 轮仍失败才发 /fail + 写 journal
#                     （单次抖动不告警，2026-11-06 astrbot 探测一次瞬时 000 误报后加的），
#                     然后 exit 0（已告警，不必再让 systemd 报 failed）。
#   · 若连脚本都不再运行（整机宕机/网络断/定时器死）→ Healthchecks 收不到 ping，由它在 period+grace 后告警。
#
# 安全：本脚本**只读**系统状态 + 只写一个失败计数文件（FAILS_FILE，部署时预建，
# systemd 沙箱里 ReadWritePaths 只开这一个）+ **只出站** ping。
# ping URL 是密钥（持有者可伪造"正常"或刷 /fail），存 /etc/cmsgate/healthcheck.url（600 root），
# 由 deploy-monitor.sh 经 stdin 注入，绝不进 git、绝不进 argv。
set -u

URL_FILE=/etc/cmsgate/healthcheck.url
GATE_PORT=8090        # authd 回环端口（与 cmsgate.service 的 --listen 一致）
WEB_PORT=8080         # nginx 对外端口

if [ ! -r "$URL_FILE" ]; then
    echo "健康检查未配置：$URL_FILE 不可读（先跑 deploy-monitor.sh 注入 ping URL）" >&2
    exit 1
fi
BASE=$(cat "$URL_FILE")
BASE=${BASE%/}        # 去掉可能的结尾斜杠，避免拼成 //fail

# ping URL 也是密钥，与下面的 gate token 同样不进 argv（/proc/<pid>/cmdline 对
# 全机可读）：printf 是内建、不进进程表，URL 经 stdin 交给 curl（-K - 读配置）。
# ★ $1 是 Healthchecks 的动作后缀："" = 成功 ping（重置计时），"/fail" = 明确报失败。
#   曾经两轮只调 hc_url 不带后缀，于是**每一次探活失败都在给死人开关续命**、还把
#   状态刷回 UP —— journal 里红字一片、监控页全绿（2026-11-02 cmsdist 500 事故暴露）。
hc_url() {
    printf 'url = "%s%s"\n' "$BASE" "${1-}"
}

# 失败出口：记一笔连续失败计数，**连续第 2 次才发 /fail**。2026-11-06 加去重：
# astrbot WebUI 探测一次瞬时 000 就打 DOWN 邮件、两分钟后自己 UP——单次抖动不值一封邮件。
# 计数落 FAILS_FILE（部署时预建、unit 里 ReadWritePaths 只开这一个文件，沙箱其余仍全只读）；
# 全绿那轮清零。计数写不进去时退回「单次即报」——宁可吵不可哑：写入路径坏了说明
# 部署件被动过，比少报更危险。然后以 0 退出（告警已通过 /fail 发出，无需 systemd 再标 failed）
FAILS_FILE=/opt/cmsgate/healthcheck-fails
FAIL_CONFIRM=2

ping_fail() {
    reason=$1
    n=$(cat "$FAILS_FILE" 2>/dev/null)
    case "$n" in ''|*[!0-9]*) n=0 ;; esac
    n=$((n + 1))
    if printf '%s\n' "$n" > "$FAILS_FILE" 2>/dev/null; then
        if [ "$n" -ge "$FAIL_CONFIRM" ]; then
            logger -t cmsgate-healthcheck -p user.err "探活失败（连续第 ${n} 次）：$reason" 2>/dev/null || true
            # 失败原因经 /fail 的 body 带过去（Healthchecks 会记成 Signal Failure 并立即标 DOWN）；
            # ★ 原因串里绝不能有 token / ping URL —— 它会离开本机、存进第三方服务。
            hc_url "/fail" | curl -fsS -m 10 -o /dev/null --data-binary "$reason" -K - 2>/dev/null || true
            echo "FAIL: $reason（连续第 ${n} 次，已发失败信号）"
        else
            logger -t cmsgate-healthcheck -p user.warning "探活失败（连续第 ${n} 次，未满 ${FAIL_CONFIRM} 次，本轮不告警）：$reason" 2>/dev/null || true
            echo "FAIL(待确认): $reason —— 连续第 ${n} 次，下轮仍失败才发失败信号（防单次抖动误报）"
        fi
    else
        logger -t cmsgate-healthcheck -p user.err "失败计数 ${FAILS_FILE} 写不进（部署件被动过？）——退回单次即报" 2>/dev/null || true
        hc_url "/fail" | curl -fsS -m 10 -o /dev/null --data-binary "$reason" -K - 2>/dev/null || true
        echo "FAIL: $reason（计数文件写不进，退回单次即报）"
    fi
    exit 0
}

# 1) authd 服务在跑（systemd 视角）
systemctl is-active --quiet cmsgate || ping_fail "cmsgate 服务未运行"

# 2) authd 真的响应（进程在但卡死时，systemd 看不出来，这里能）
curl -fsS -m 5 "http://127.0.0.1:${GATE_PORT}/health" >/dev/null \
    || ping_fail "authd /health 不通（进程在但不响应）"

# 3) nginx 在跑
systemctl is-active --quiet nginx || ping_fail "nginx 未运行"

# 4) 端到端闸门链路：未登录访问受保护资源必须 404（当作不存在）。
#    这一条同时把「闸门被绕过的安全回归」纳入监控：
#    200 = 闸门形同虚设；401 = 配置回退成「承认存在」（应走 =404 /__nf）；
#    502/504 = authd 经 nginx 不可达。
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/dist/main.js")
[ "$code" = "404" ] \
    || ping_fail "闸门链路异常：/dist/main.js 返回 ${code}（应 404；200=闸门被绕过，401=未走 404 化，502=authd 不可达）"

# 5) 磁盘余量：盘满是「进程活着但功能坏了」的静默故障，前四项看不到
#    （authd/nginx 进程都在，但写盘失败 → 登录异常/日志丢）。阈值 90% 留缓冲，
#    到 100% 之前你有时间清理。分开检查系统盘与数据目录所在盘；同盘时两次值相同，
#    第一次失败即 exit，不会重复告警。
for mp in / /var/lib/cmsgate; do
    usage=$(df -P "$mp" | awk 'NR==2 {print $5}' | tr -d '%')
    [ "$usage" -lt 90 ] \
        || ping_fail "磁盘将满：${mp} 已用 ${usage}%（≥90%，authd/nginx 即将写失败）"
done

# 6) 秘密登录入口真的打得开。这一项**只有这里能看见**：404 模型下 /gate/<TOKEN>/ 是唯一
#    能登录的地方，而片段被误删、配置被 reload 坏、gate 目录权限变了 —— 都会让登录页 404，
#    那时 authd /health 正常、nginx 在跑、/dist/main.js 也照样"正确地" 404，前五项全绿。
#    于是唯一的症状变成「访客说链接打不开」，而 usage.jsonl 里只会看到一串失败，像被爆破。
#    ★ token 只在本机读；失败原因串里**绝不带 token** —— reason 会经 /fail 发给第三方监控服务。
GATE_CONF=/etc/nginx/snippets/cms-gate-path.conf
if [ ! -r "$GATE_CONF" ]; then
    ping_fail "gate-path 片段缺失或不可读 —— 无法确认登录入口"
fi
TOK=$(sed -n '1s/^#[[:space:]]*gate-token:[[:space:]]*\([a-z0-9]\{12,32\}\)[[:space:]]*$/\1/p' "$GATE_CONF")
if [ -z "$TOK" ]; then
    ping_fail "gate-path 片段首行标记坏了或 token 形状不合法 —— 无法确认登录入口"
fi
# ★ 2026-10-22：URL 不放进 curl 的 argv —— /proc/<pid>/cmdline 对所有本地账户可读
#   （这台机器没开 hidepid），`ps aux` 就能把唯一登录凭据抄走。printf 是 shell
#   内建函数、不进进程表；URL 经 stdin 交给 curl（-K - 读配置）。
gate_url() {
    printf 'url = "http://127.0.0.1:%s/gate/%s/"\n' "$WEB_PORT" "$TOK"
}
gcode=$(gate_url | curl -s -m 5 -o /dev/null -w '%{http_code}' -K -)
[ "$gcode" = "200" ] \
    || ping_fail "秘密登录入口不可打开（返回 ${gcode}；应 200）"
gate_url | curl -s -m 5 -K - | grep -q 'gate-form' \
    || ping_fail "秘密登录入口返回的不是登录表单（正文里没有 gate-form）"

# 7) 证书剩余天数。盯的是**本地 PEM 里的到期日**，不是「现在 TLS 好不好用」——
#    续期失败（acme.sh 的 cron 没跑 / 80 被临时挡 / 撞上签发限流）在到期日之前线上
#    毫无症状：前六项全绿、访客也一切正常，直到某天浏览器直接弹「证书已过期」，
#    而 80 会把所有请求 302 到 443，等于整站打不开。这一项是这里唯一提前的灯。
#    阈值 14 天：acme.sh 的提前量是 30 天，健康系统不会低于 ~30；14 天意味着
#    已经错过两轮以上重试，同时不致于在正常轮换里误报。
PEM=/etc/nginx/ssl/ty0712.com.pem
if [ ! -r "$PEM" ]; then
    ping_fail "证书文件缺失或不可读（$PEM）—— 到期后 443 会彻底打不开"
fi
end=$(openssl x509 -noout -enddate -in "$PEM" 2>/dev/null | sed -n 's/^notAfter=//p')
[ -n "$end" ] || ping_fail "证书到期日读不出来（openssl x509 -enddate 空或报错）"
left=$(( ( $(date -d "$end" +%s) - $(date +%s) ) / 86400 ))
[ "$left" -ge 14 ] \
    || ping_fail "证书只剩 ${left} 天（<14，acme.sh 续期大概率没跑）"

# 8) 每日快照还在不在更新。备份失败是**最安静**的那种故障：crontab 被人覆盖、
#    磁盘配额满、tar 报错 —— 全都只写进 journal，没有任何外部症状。等到真出事要恢复时
#    才发现最新快照停在一个月前，那时已经没得选了。
#    快照每天 03:17 由 cmsgate-backup.timer 生成，26h 阈值 = 错过一次就报，且不会因为
#    03:17 到 24:00 的正常间隔误报。
BACKUP_DIR=/root/cms-backup
latest=$(ls -1t "$BACKUP_DIR"/cms-*.tar.gz 2>/dev/null | head -n 1)
[ -n "$latest" ] || ping_fail "备份目录里没有任何 cms-*.tar.gz —— 每日快照可能从未成功过"
age=$(( ( $(date +%s) - $(date -r "$latest" +%s) ) / 3600 ))
[ "$age" -lt 26 ] \
    || ping_fail "最新快照 $(basename "$latest") 已 ${age} 小时未更新（阈值 26h，应每天 03:17 更新）"

# 9) cmsdist 跑分调度服务（7120）。它与闸门完全独立——坏了不影响登录，但唯一症状是
#    「测试组所有人都领不到任务」，其余各项全绿。/ping 只读端点：服务活着 + state 可读。
#    （QQbot 探活不在本文件里：/opt/cmsgate/healthcheck-extra.sh 服务器专属、不进仓库，
#     覆盖式部署丢不了它，见文件尾的加载点。）
DIST_PORT=7120
dcode=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${DIST_PORT}/ping" 2>/dev/null)
[ "$dcode" = "200" ] \
    || ping_fail "cmsdist 调度服务不可达（/ping 返回 ${dcode}，应 200 —— 跑分客户端将全员领不到任务）"
curl -s -m 5 "http://127.0.0.1:${DIST_PORT}/ping" 2>/dev/null | grep -q '"ok": *true' \
    || ping_fail "cmsdist /ping 返回异常（state.json 不可读或队列损坏）"

# 10) sshd。这一项只有这里能看见：探活本身是**出站**的 curl，不经过 sshd，所以
#     sshd 挂了它照样发成功 ping、监控页全绿 —— 而 ctlui 看板（ssh 跑 admin-lite）、
#     所有 deploy-*.sh、Mac 那条备份 rsync 全都靠它。症状是「我连不上服务器」，
#     跑分客户端却一切正常，于是没有任何外部信号。
systemctl is-active --quiet ssh || ping_fail "sshd 未运行 —— ctlui/部署/Mac 备份拉取全废（探活本身不受影响，所以只能靠这条）"

# 11) 防爆破与时间同步。fail2ban 停了零症状，只是口令爆破从此无人挡（闸门密码表就在
#     /var/lib/cmsgate，被猜中直接登进游戏）。chrony 更阴：时间一跳，lease 回收、
#     冷却期、快照新鲜度（<26h）这三处判断全部歪掉，而每一项单看都「正常」。
#     偏移阈值 2s —— 实测现值 +0.000026s，差五个数量级，不会误报。
systemctl is-active --quiet fail2ban || ping_fail "fail2ban 未运行 —— 闸门口令爆破无人挡"
systemctl is-active --quiet chrony \
    || ping_fail "chrony 未运行 —— 时间漂移会让 lease/冷却/快照新鲜度三处判断失真"
off=$(chronyc tracking 2>/dev/null | awk '/Last offset/{print $4}')
[ -n "$off" ] && awk -v o="$off" 'BEGIN{if (o<0) o=-o; exit !(o<2)}' \
    || ping_fail "chrony 时钟偏移超阈值（|offset| ≥ 2s 或读不到，实际 ${off:-无}）"

# 12) 内存与 swap。第 5 项只盯磁盘，看不到「进程都活着但慢死」。
#     下限 2026-11-03 从 8% 抬到 15%：翻了 7 天 sysstat，真·available 每天最低
#     454~649MB、used 峰值最高 1008MB，15%（≈260MB）仍在最差实测值的下面一档，不会半夜
#     误报；而原来的 8%（≈139MB）等于「只剩最后一格才吭声」——那时 OOM 已经在门口了。
#     swap 上限 60% 不动（现值 9%）。
avail=$(free -b | awk 'NR==2{printf "%.1f", $7/$2*100}')
awk -v a="$avail" 'BEGIN{exit !(a>15)}' \
    || ping_fail "内存可用只剩 ${avail}%（下限 15%）—— 即将 OOM 或疯狂 swap"
swp=$(free -b | awk 'NR==3{printf "%.1f", ($2>0? $3/$2*100 : 0)}')
awk -v s="$swp" 'BEGIN{exit !(s<60)}' \
    || ping_fail "swap 已用 ${swp}%（上限 60%）—— 内存压力已经传导到磁盘"

# 13) 公开学习站 /learn/。第 4 项测的是 /dist/main.js 的 404 口径，答不出「公开页还在吗」。
#     /learn/ 不需要登录，挂了不会有人「登录不上」，也不会有人反馈 —— 它是监管要求的
#     真实学习内容，静默 404 属于最尴尬的那种坏法。标题标记是**故意钉死**的耦合：
#     改标题必须同步改这里，宁可误报也不让「200 但内容是别的兜底页」蒙过去。
lcode=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/learn/" 2>/dev/null)
[ "$lcode" = "200" ] \
    || ping_fail "公开学习站 /learn/ 不可达（HTTP ${lcode}，应 200）"
curl -s -m 5 "http://127.0.0.1:${WEB_PORT}/learn/" 2>/dev/null | grep -q 'C++ 数据结构与算法图解' \
    || ping_fail "/learn/ 返回 200 但标题标记缺失（可能被兜底页顶掉，或首页改版没同步这里）"

# 14) 服务器专属扩展段（QQbot 探活等，不进仓库）：独立文件、存在即加载。加载点放在
#     全部本体检查之后、发 ping 之前——扩展段直接复用本体的 ping_fail/BACKUP_DIR。
#     deploy-monitor.sh 只覆盖本文件、永不碰扩展文件，「覆盖式更新丢 bot 检查」的老坑
#     从结构上消除；扩展段里任何一项挂，照常 ping_fail。
if [ -f /opt/cmsgate/healthcheck-extra.sh ]; then
    . /opt/cmsgate/healthcheck-extra.sh
fi

# 全绿：失败计数清零（连续性断了），发成功 ping。发送本身失败（如出站 443 被挡）要以非 0 退出，好在 journal 里暴露。
: > "$FAILS_FILE" 2>/dev/null || true
hc_url | curl -fsS -m 10 -o /dev/null -K - \
    || { echo "成功 ping 发送失败（出站 443 到 Healthchecks 被挡？）" >&2; exit 1; }

ok_extra=""
[ -f /opt/cmsgate/healthcheck-extra.sh ] && ok_extra="（含 QQbot 扩展段）"
echo "OK: 十三项探活全绿${ok_extra}，已发成功 ping"
