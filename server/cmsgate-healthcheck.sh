#!/bin/sh
# 复数扫雷闸门探活 + Healthchecks「死人开关」ping。
#
# 由 cmsgate-healthcheck.timer 每 2 分钟触发一次（oneshot）。逻辑：
#   · 十六项探活全绿  → 清零失败计数，向 Healthchecks 发一个成功 ping（BASE）。
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

# 闸门开放状态（管理员主动免密放行）：从 authd /health 拿（权威进程内口径）。本服务
# 沙箱剥了全部 capabilities，root 没有 CAP_DAC_OVERRIDE 读不了 cmsgate 用户 0600 的
# gateconfig.json——文件路线在沙箱里静默失败照报（2026-11-07 实测）。authd 答不出或
# 字段缺失一律答「关闭」（fail closed：宁可误报也不把「闸门被绕过」豁免掉）。
gate_is_open() {
    curl -s -m 5 "http://127.0.0.1:${GATE_PORT}/health" 2>/dev/null \
        | grep -q '"require_password": *false'
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
#    200 = 闸门形同虚设，或管理员主动开了免密放行（闸门开放，require_password=false）；
#    401 = 配置回退成「承认存在」（应走 =404 /__nf）；502/504 = authd 经 nginx 不可达。
#    2026-11-07 误报修正：报「闸门被绕过」之前先查闸门开放状态（gate_is_open）——
#    管理员主动开放闸门（免密）时 200 是预期行为，不该告警（当天管理员开了免密，
#    被连发 8 封 DOWN 邮件）。authd 答不出一律不豁免（fail closed）；非 200 的异常码
#    （401/502/…）即使在闸门开放时也照报——开放状态下 authd 挂了照样 502。
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${WEB_PORT}/dist/main.js")
if [ "$code" != "404" ]; then
    if [ "$code" = "200" ] && gate_is_open; then
        echo "SKIP: 闸门开放中（require_password=false，管理员主动免密放行）——/dist/main.js 返回 200 属预期，不告警"
    else
        ping_fail "闸门链路异常：/dist/main.js 返回 ${code}（应 404；200=闸门被绕过或未按配置免密，401=未走 404 化，502=authd 不可达）"
    fi
fi

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
if [ "$gcode" = "200" ]; then
    gate_url | curl -s -m 5 -K - | grep -q 'gate-form' \
        || ping_fail "秘密登录入口返回的不是登录表单（正文里没有 gate-form）"
elif [ "$gcode" = "302" ] && gate_is_open; then
    # 闸门开放时 authd 对登录入口直接 302 → /game（免密放行，_handle_entry 分支）——
    # 200+表单只是闸门关闭时的形态。302 说明入口活着且 authd 在正常应答，不告警。
    echo "SKIP: 闸门开放中，登录入口免密直接 302 → /game（属预期，不告警）"
else
    ping_fail "秘密登录入口不可打开（返回 ${gcode}；应 200）"
fi

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

# 14)~16) 慢刀子基线三项（资源层加固 ④，2026-11-16）。慢刀子（日志塞盘、带宽饥饿、
#     响应劣化）的共性是**不宕机**：进程全绿、端口全通、磁盘不满 —— 前 13 项一条都抓不到，
#     症状只会是「用户觉得变慢了」和「月底账单变厚」。所以这里不设固定阈值，全部跟
#     **滚动基线**（EMA，α=0.05 ≈ 最近 20 轮 ≈ 40 分钟的加权平均）对比，突增倍数超限才报。
#     基线存 BASELINE_DIR/baseline.env（key=value，脚本自产自销，部署时预建目录、
#     unit 里 ReadWritePaths 只对这个目录开口）。★ 目录必须在 /opt/cmsgate（root 属主）
#     下、不能放 /var/lib/cmsgate —— 本 unit 剥了全部 capabilities，root 没有
#     CAP_DAC_OVERRIDE，穿不进 cmsgate 用户 700 的 /var/lib/cmsgate（2026-11-07 读
#     gateconfig.json 就是这个坑，基线目录 11-16 首部署又踩了一次，自测 WARN 实锤）。三项都要「先攒样本再武装」：
#     样本 <720 轮（约 24h）只采集不告警 —— 冷启动的 EMA 还没收敛，拿它当基准必误报。
#     每项还各有一个绝对地板（50ms / 100MB/h / 15Mbit/s）：基线本身极低时（凌晨零增长）
#     「3 倍」毫无意义，地板才是防误报的最后一道。#39 的资源层版：这三项上线后 ⑥ 的
#     实弹自打要能看见它们读数变化、打完要能自愈，否则等于没装。
BASELINE_DIR=/opt/cmsgate/baseline
BASELINE=$BASELINE_DIR/baseline.env
if [ ! -d "$BASELINE_DIR" ] && ! mkdir -p "$BASELINE_DIR" 2>/dev/null; then
    echo "WARN: 基线目录 ${BASELINE_DIR} 不存在且建不了（unit 沙箱没开口？）——第 14~16 项本轮跳过"
else
    [ -r "$BASELINE" ] && . "$BASELINE"
    # 基线文件数值域钳制：文件写坏/被动手脚成非数值时宁可当 0 重攒样本——垃圾值
    # 进差分会直接语法报错或让 awk 比较不可预期（计数字段被清成负数/垃圾可把慢刀子
    # 告警静默约 24h）。D_EMA/D_U1 等允许负值（logrotate 删除也是真实基线），只验形不验号。
    clamp_num() {
        awk -v v="$1" 'BEGIN{ if (v ~ /^-?[0-9]+(\.[0-9]+)?$/) print v; else print 0 }'
    }
    for k in LAST_TS LAST_USEDKB LAST_TX D_T1 D_U1 D_T2 D_U2 \
             LAT_EMA LAT_N D_EMA D_N TX_EMA TX_N; do
        eval "${k}=\$(clamp_num \"\${${k}:-0}\")"
    done
    state_flush() {
        # 原子写：先落 .tmp 再 mv，断电/中断不会留下半个状态文件（半个文件 source 进来就是垃圾）
        cat > "$BASELINE.tmp" <<EOF
LAST_TS=${LAST_TS:-0}
LAST_USEDKB=${LAST_USEDKB:-0}
LAST_TX=${LAST_TX:-0}
D_T1=${D_T1:-0}
D_U1=${D_U1:-0}
D_T2=${D_T2:-0}
D_U2=${D_U2:-0}
LAT_EMA=${LAT_EMA:-0}
LAT_N=${LAT_N:-0}
D_EMA=${D_EMA:-0}
D_N=${D_N:-0}
TX_EMA=${TX_EMA:-0}
TX_N=${TX_N:-0}
EOF
        mv "$BASELINE.tmp" "$BASELINE"
    }
    if ! state_flush; then
        echo "WARN: 基线文件 ${BASELINE} 写不进 —— 第 14~16 项退化为本轮只读，不积累基线也不告警"
    fi

    # 14) 响应延迟 p90：对真实内容页 /learn/ 连取 5 次取最大值（5 个样本的 p90≈最大值，
    #     故意取保守端）。必须用真实尺寸页面：小响应探针（~几百字节）在带宽被压测时
    #     根本测不出劣化 —— frp-dad 压测实测 2.18s（探针）vs 3.87s（真实页），小探针假阴。
    #     ★ 成败要按 curl 退出码判，不能用 `lt=$(curl…) || lt=""`：curl 失败时 -w 照样
    #       输出（0.000000），`||` 一执行就把它覆盖成空 —— 采样永远凑不满 5 个，
    #       while 无上限空转，oneshot 挂死（本地干跑实锤过）。上限 8 次 = 再加一道保险。
    lat_p90=""
    lats=""
    li=0
    tries=0
    while [ "$li" -lt 5 ] && [ "$tries" -lt 8 ]; do
        tries=$((tries + 1))
        lt=$(curl -s -m 5 -o /dev/null -w '%{time_total}' "http://127.0.0.1:${WEB_PORT}/learn/" 2>/dev/null)
        rc=$?
        case "$lt" in
            ''|*[!0-9.]*) ;;  # 非数值样本丢弃
            *) [ "$rc" -eq 0 ] && { lats="$lats $lt"; li=$((li+1)); } ;;
        esac
    done
    if [ "$li" -eq 5 ]; then
        lat_p90=$(printf '%s\n' $lats | sort -n | tail -n 1)
        if [ "${LAT_N:-0}" -ge 1 ]; then
            LAT_EMA=$(awk -v e="${LAT_EMA:-0}" -v s="$lat_p90" 'BEGIN{printf "%.3f", e*0.95+s*0.05}')
        else
            LAT_EMA=$lat_p90
        fi
        LAT_N=$(( ${LAT_N:-0} + 1 ))
        if [ "$LAT_N" -lt 720 ]; then
            echo "基线采集中（延迟）：n=${LAT_N}/720，本轮 p90=${lat_p90}s EMA=${LAT_EMA}s —— 满约 24h 才开始判红"
        elif awk -v s="$lat_p90" -v e="$LAT_EMA" 'BEGIN{exit !(s>3*e && e>0.05)}'; then
            ping_fail "响应延迟突增：/learn/ p90=${lat_p90}s（滚动基线 ${LAT_EMA}s，>3 倍且基线地板 50ms）—— 慢刀子：带宽被压 / 连接被占满 / 被打挂前兆"
        fi
    else
        echo "WARN: 延迟采样 5 次只成功 ${li} 次（curl 失败/超时）—— 本轮不计入基线、不判红"
    fi

    # 15/16) 磁盘增速与出站速率：同一次时间戳差分（脚本 2 分钟一轮，间隔 <60s 的手动重跑
    #     会得到纯噪音差分，直接跳过本轮不更新基线）。
    now=$(date +%s)
    used_kb=$(df -k / | awk 'NR==2{print $3}')
    tx_bytes=$(grep -v ':lo' /proc/net/dev 2>/dev/null | awk '{sub(/^[^:]+:/,""); s+=$10} END{printf "%.0f", s+0}')
    if [ "${LAST_TS:-0}" -gt 0 ] && [ $((now - LAST_TS)) -ge 60 ]; then
        dt=$((now - LAST_TS))
        # 磁盘增速 MB/h（可为负：logrotate 压缩/删除也是真实基线的一部分）。
        # ★ 双窗判据（2026-11-20 用户定稿）：**30 分钟窗均值 >100** 或 **24 小时窗均值 >50**。
        #   旧判据（3 轮滑动窗，>5×EMA 且 >100）连吃三次良性突发：
        #     11-17 代理日志单轮 128（修法=3 轮窗）、11-18 备份 1.6G（修法=SKIP 白名单）、
        #     11-20 05:03 未知 ~15MB「写后即删」突发年化 156 → DOWN 4m19s 自愈
        #     （全盘 mtime 扫描/docker/journald 全查过，零持久痕迹）。
        #   窗口拉长后突发被摊薄：15MB/30min = 30MB/h，压不到 100 地板；
        #   持续洪水（小时级速率）整窗都过线，检出覆盖不受损——
        #   两条窗都要「整窗持续」才响，单发突发从机制上进不了判据。
        #   逐轮样本进 ring 文件（ts used_kb，保留 25h），备份窗 SKIP 只免判不免记。
        RING="$BASELINE_DIR/disk-samples.log"
        printf '%s %s\n' "$now" "$used_kb" >> "$RING" 2>/dev/null || true
        if [ -s "$RING" ]; then
            # 剪 25h 前的样本、顺带压掉畸形行（半行/空行进差分就是垃圾）
            awk -v cut=$((now - 90000)) \
                '$1 ~ /^[0-9]+$/ && $1 >= cut && $2 ~ /^[0-9]+$/ {print $1, $2}' \
                "$RING" > "$RING.tmp" 2>/dev/null && mv "$RING.tmp" "$RING" 2>/dev/null || true
        fi
        if [ "${D_T1:-0}" -gt 0 ] && [ $((now - D_T1)) -ge 120 ]; then
            d_rate=$(awk -v u="$used_kb" -v lu="${D_U1:-$used_kb}" -v dt=$((now - D_T1)) 'BEGIN{printf "%.2f", (u-lu)/1024/(dt/3600)}')
            if [ "${D_N:-0}" -ge 1 ]; then
                D_EMA=$(awk -v e="${D_EMA:-0}" -v s="$d_rate" 'BEGIN{printf "%.2f", e*0.95+s*0.05}')
            else
                D_EMA=$d_rate
            fi
            D_N=$(( ${D_N:-0} + 1 ))
            # 双窗锚点 = 窗内最老样本。跨度护栏：30min 窗 ≥25min、24h 窗 ≥23h
            # （不给满跨度就判 = 采样断档时拿短窗冒充长窗，年化又炸）。
            a30=$(awk -v cut=$((now - 1800)) '$1 >= cut {print $1, $2; exit}' "$RING" 2>/dev/null)
            a24=$(awk -v cut=$((now - 86400)) '$1 >= cut {print $1, $2; exit}' "$RING" 2>/dev/null)
            w30=""; w24=""
            if [ -n "$a30" ]; then
                t30=${a30%% *}; u30=${a30#* }
                [ $((now - t30)) -ge 1500 ] && \
                    w30=$(awk -v u="$used_kb" -v lu="$u30" -v dt=$((now - t30)) 'BEGIN{printf "%.2f", (u-lu)/1024/(dt/3600)}')
            fi
            if [ -n "$a24" ]; then
                t24=${a24%% *}; u24=${a24#* }
                [ $((now - t24)) -ge 82800 ] && \
                    w24=$(awk -v u="$used_kb" -v lu="$u24" -v dt=$((now - t24)) 'BEGIN{printf "%.2f", (u-lu)/1024/(dt/3600)}')
            fi
            if [ "$D_N" -lt 720 ]; then
                echo "基线采集中（磁盘）：n=${D_N}/720，本轮 ${d_rate} MB/h EMA=${D_EMA}；30min 窗 ${w30:-攒中} / 24h 窗 ${w24:-攒中} MB/h —— 窗满跨度才开始判红"
            elif systemctl is-active --quiet cmsgate-backup.service 2>/dev/null \
                || find /root/cms-backup -name '*.tar.gz' -mmin -10 2>/dev/null | grep -q .; then
                # 写盘者是身份明确的自己人：每日备份正在跑（服务 active，或 10 分钟内
                # 有新快照落盘=窗口右端跨到了备份上）。191M 的 gzip 灌 3 分钟就是
                # 1.6GB/h，短窗照样炸——这不是塞盘攻击（2026-11-18 凌晨 03:20 实弹，
                # 周三全量备份首撞武装基线）。样本照常进 ring，只是不开枪。
                echo "SKIP: 每日备份写盘窗——本轮 30min 窗 ${w30:-攒中} / 24h 窗 ${w24:-攒中} MB/h 只记账不判红"
            else
                disk_alarm=""
                if [ -n "$w30" ] && awk -v s="$w30" 'BEGIN{exit !(s>100)}'; then
                    disk_alarm="磁盘增速异常：30min 窗均值 +${w30} MB/h（地板 100）"
                fi
                if [ -n "$w24" ] && awk -v s="$w24" 'BEGIN{exit !(s>50)}'; then
                    disk_alarm="${disk_alarm:+$disk_alarm；}磁盘增速异常：24h 窗均值 +${w24} MB/h（地板 50）"
                fi
                [ -n "$disk_alarm" ] && \
                    disk_alarm="$disk_alarm —— 慢刀子：日志洪水 / 被塞盘，盘满时第 5 项才亮已太迟"
            fi
        fi
        # 窗口右移：LAST_TS/LAST_USEDKB 顺位进窗，最老的出局。重启后头两轮窗不满
        # （D_T1=0 或跨度 <2 分钟）只攒样本不判红。
        D_T1=${D_T2:-0}; D_U1=${D_U2:-0}; D_T2=${LAST_TS:-0}; D_U2=${LAST_USEDKB:-0}
        # 出站速率 Mbit/s。计数器回绕（tx < 上次值）说明网卡重启/换过，本轮差分作废只记新值。
        tx_alarm=""
        if [ "$tx_bytes" -ge "$LAST_TX" ]; then
            tx_rate=$(awk -v t="$tx_bytes" -v lt="$LAST_TX" -v dt="$dt" 'BEGIN{printf "%.2f", (t-lt)*8/1000000/dt}')
            if [ "${TX_N:-0}" -ge 1 ]; then
                TX_EMA=$(awk -v e="${TX_EMA:-0}" -v s="$tx_rate" 'BEGIN{printf "%.2f", e*0.95+s*0.05}')
            else
                TX_EMA=$tx_rate
            fi
            TX_N=$(( ${TX_N:-0} + 1 ))
            if [ "$TX_N" -lt 720 ]; then
                echo "基线采集中（出站）：n=${TX_N}/720，本轮 ${tx_rate} Mbit/s EMA=${TX_EMA} —— 满约 24h 才开始判红"
            elif awk -v s="$tx_rate" -v e="$TX_EMA" 'BEGIN{exit !(s>3*e && s>15)}'; then
                tx_alarm="出站速率异常：${tx_rate} Mbit/s（滚动基线 ${TX_EMA}，>3 倍且 >15Mbit/s 地板）—— 慢刀子：带宽被拉满，正常用户已在挨饿（固定带宽就是钱，云侧账单告警之外的应用视角）"
            fi
        else
            echo "SKIP: 出站计数器回绕（${tx_bytes} < ${LAST_TX}）—— 网卡重启过，本轮差分作废"
        fi
    fi
    LAST_TS=$now
    LAST_USEDKB=$used_kb
    LAST_TX=$tx_bytes
    state_flush || echo "WARN: 基线文件写回失败 —— 下轮差分从零开始，磁盘/出站两项要重新攒样本"
    # ★ 判红必须在状态持久化**之后**：ping_fail 会 exit 0，放在前面的话失败轮的样本
    #   进不了窗口、锚点冻结在出事前的时刻，读数永远对着旧锚点 → 告警自锁（2026-11-18
    #   实锤：journald 清空手术期间锚点卡死，38 连红，磁盘早已平稳、读数只能靠 span
    #   变长被动衰减，要 4h 才能自然解套）。采样归采样、判罚归判罚，先记账再开枪。
    [ -n "${disk_alarm:-}" ] && ping_fail "$disk_alarm"
    [ -n "${tx_alarm:-}" ] && ping_fail "$tx_alarm"
fi

# 17) 服务器专属扩展段（QQbot 探活等，不进仓库）：独立文件、存在即加载。加载点放在
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
echo "OK: 十六项探活全绿${ok_extra}，已发成功 ping"
