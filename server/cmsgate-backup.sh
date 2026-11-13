#!/bin/sh
# 每日快照闸门数据 /var/lib/cmsgate（外加登录入口片段）→ /root/cms-backup/，保留 28 份，600 root。
# 同目录顺带快照 QQbot（/opt/bot）：配置件（data + napcat 配置 + compose）每天一份 bot-cfg-*
# 保留 28 份；QQ 登录态 ntqq 每周三/周日一份 bot-ntqq-* 保留 8 份（丢登录态只是重新扫码，
# 不值得天天 215M）。Mac 侧 mac-backup-pull.sh 会把整个目录拉走，五类前缀各自轮转。
#
# 还快照分布式跑分的数据（/var/lib/cmsdist）：索引 state.json + secret 每天一份
# dist-meta-*（保留 28），逐局明细 results/ 每周三一份 dist-full-*（保留 8）——
# 理由见文件里那段注释（明细 44M 且不可变，天天搬不划算）。
#
# 由 cmsgate-backup.timer 每天 03:17 触发（oneshot）。快照含 secrets
# （passwords.json / secret.key / usage.jsonl / 秘密入口 token），故目录 700、文件 600、绝不进 git；
# 异地一份由用户 Mac 的 launchd 每小时（以及每次登录）rsync 拉走（tools/mac-backup-pull.sh），
# Mac 侧保留 1000 份——服务器只留 28 份，给那边更长的历史。
#
# 恢复：本机回滚时快照是以 root 打的包，root 解包会**原样还原属主与权限**，不需要 chown；
#       只有换到全新服务器（cmsgate 的 uid 可能不同）才需 chown -R cmsgate:cmsgate。
#       ★ 片段这一员在包里是**不带目录的裸文件名**（因为打包时用了第二段 -C），
#         整包解到 /var/lib/cmsgate 时它会落在数据目录里，得单独解到 /etc/nginx/snippets/。
#       完整步骤（stop/start、验证、只恢复密码表+密钥、恢复入口、从 Mac 拉到新机）见 server/RESTORE.md。
set -eu

DEST=/root/cms-backup
SRC=/var/lib/cmsgate
BOT=/opt/bot
# 秘密登录入口的 nginx 片段（首行就是当前 token）。带上它的理由不是"怕丢"，
# 而是**它丢了就没人能登录**：换机器/重装后 deploy 只在片段缺失时现生成一个新随机入口，
# 于是所有存着老链接的访客集体 404，只能靠你手动 rotate 再重新群发地址。
# 安全上不多花一分：同一份快照里本来就有 secret.key（持有者可伪造会话 cookie）
# 和整张密码表 —— 信任域早就在这包里了，包本身 600 root、异地那份 700/600、都不进 git。
GATE_CONF=/etc/nginx/snippets/cms-gate-path.conf

install -d -m 700 "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
if [ -f "$GATE_CONF" ]; then
    tar -czf "$DEST/cms-${STAMP}.tar.gz" -C "$SRC" . -C /etc/nginx/snippets cms-gate-path.conf
else
    # 新机器还没跑过 deploy-web.sh：不能因为缺这一个文件就让整个备份失败（set -e 会打死服务）
    tar -czf "$DEST/cms-${STAMP}.tar.gz" -C "$SRC" .
fi
chmod 600 "$DEST"/cms-*.tar.gz
# 只保留最近 28 份：ls -1t 新到旧，tail -n +29 吐出第 29 份及以后，xargs -r 空输入不动手
ls -1t "$DEST"/cms-*.tar.gz | tail -n +29 | xargs -r rm -f
echo "快照完成：$(basename "$(ls -1t "$DEST"/cms-*.tar.gz | head -1)")，现有 $(ls -1 "$DEST"/cms-*.tar.gz | wc -l | tr -d ' ') 份"

# ---- QQbot 快照 ----
# 容器运行中直接打包：astrbot 的 SQLite 是 WAL 模式，data 目录带着 -wal/-shm 一起打包
# 即可恢复；napcat 侧登录态在 ntqq，每周低频备。tar 若因「文件边读边变」等失败，
# 删掉半成品再 exit 1 —— 此时闸门快照已完成，不会牵连它；失败由 systemd timer 的
# failed 状态 + healthcheck 的 bot 快照新鲜度检查暴露。
# ★ 排掉可再生的大缓存（11-02 实测）：image_cache 61M 是 iris 收图缓存、cloudrank/resources
#   19M 是插件自带字体与静态资源 —— 都能重建，却占了快照的大头，而这份快照每天要经那条
#   ~13KB/s 的链路被 Mac 拉走一次。price_catalog.json(16M) 与 data/dist(20M) 暂不排：
#   前者不确定能否重建、后者不归本服务判，先留着看清楚再说。
tar -czf "$DEST/bot-cfg-${STAMP}.tar.gz" -C "$BOT" --exclude='data/temp' --exclude='data/backups' \
    --exclude='*/image_cache' --exclude='*/cloudrank/resources' data napcat/config docker-compose.yml
chmod 600 "$DEST"/bot-cfg-*.tar.gz
ls -1t "$DEST"/bot-cfg-*.tar.gz | tail -n +29 | xargs -r rm -f
echo "bot 配置快照完成：$(basename "$(ls -1t "$DEST"/bot-cfg-*.tar.gz | head -1)")，现有 $(ls -1 "$DEST"/bot-cfg-*.tar.gz | wc -l | tr -d ' ') 份"

# 周三/周日备 QQ 登录态（date +%u：1=周一 … 3=周三，7=周日），保留 8 份
# ★ 只备登录态本身：实测 ntqq 271M 里有 250M 是 Emoji 缓存(180M) 与日志(70M)，
#   丢了重新登录/重新下载就有；真·登录态约 21M。丢登录态的代价本来就只是重扫一次码。
DOW=$(date +%u)
if [ "$DOW" = 3 ] || [ "$DOW" = 7 ]; then
    tar -czf "$DEST/bot-ntqq-${STAMP}.tar.gz" -C "$BOT" \
        --exclude='*/nt_data/Emoji' --exclude='*/nt_data/Log' --exclude='*/nt_data/log' ntqq
    chmod 600 "$DEST"/bot-ntqq-*.tar.gz
    ls -1t "$DEST"/bot-ntqq-*.tar.gz | tail -n +9 | xargs -r rm -f
    echo "QQ 登录态快照完成：$(basename "$(ls -1t "$DEST"/bot-ntqq-*.tar.gz | head -1)")，现有 $(ls -1 "$DEST"/bot-ntqq-*.tar.gz | wc -l | tr -d ' ') 份"
fi

# ---- cmsdist 跑分数据（/var/lib/cmsdist）----
# 分两档，理由在体积：
#   · state.json = 整张榜单的索引（每个任务的规格/wins/games/IP/机器名/时间），
#     secret = 客户端交结果用的 HMAC 密钥。两件都很小（state 实测 ~0.9M），**每天备**。
#   · results/*.json.gz = 逐局明细，44M 且**追加式**（一个任务写一次、永不回头改）。
#     天天重包就是把同一批不可变字节反复搬过那条 ~13KB/s 的公网链路，所以**每周三**
#     整份备一次。最坏情况丢 6 天明细，但榜单聚合不受影响（state 是当天的）。
# client/（各端 solver 二进制 + manifest）不备：那是打包产物，重跑 package 就有。
# 服务在跑时打包是安全的：save_state 走 mkstemp + os.replace，tar 只会看到替换前或
# 替换后某一份**完整**的文件，不会读到半份。
DIST=/var/lib/cmsdist
if [ -f "$DIST/state.json" ]; then
    tar -czf "$DEST/dist-meta-${STAMP}.tar.gz" -C "$DIST" state.json secret
    chmod 600 "$DEST"/dist-meta-*.tar.gz
    ls -1t "$DEST"/dist-meta-*.tar.gz | tail -n +29 | xargs -r rm -f
    echo "跑分索引快照完成：$(basename "$(ls -1t "$DEST"/dist-meta-*.tar.gz | head -1)")，现有 $(ls -1 "$DEST"/dist-meta-*.tar.gz | wc -l | tr -d ' ') 份"
    if [ "$DOW" = 3 ]; then
        tar -czf "$DEST/dist-full-${STAMP}.tar.gz" -C "$DIST" state.json secret results
        chmod 600 "$DEST"/dist-full-*.tar.gz
        ls -1t "$DEST"/dist-full-*.tar.gz | tail -n +9 | xargs -r rm -f
        echo "跑分明细快照完成：$(basename "$(ls -1t "$DEST"/dist-full-*.tar.gz | head -1)")，现有 $(ls -1 "$DEST"/dist-full-*.tar.gz | wc -l | tr -d ' ') 份"
    fi
fi

# ---- AstrBot 媒体缓存按龄清理（QQbot 侧）----
# data/temp 里的 media_image_* 是 AstrBot 收图时的落地缓存，只进不清：
# 实测约 115M/天（10-31 手工清过一回，688K → 233M 只用了两天）。上面的 bot-cfg 快照
# 已经 --exclude 掉它，不再撑大备份，但它照样在吃服务器磁盘，所以顺手按龄清。
# 口径：只删 temp 第一层、名字以 media_image_ 开头的**普通文件**；
#       updates/、tool_images/、media_convert_cache 这些一概不碰。
#       -mtime +7 = 满 8 天才删，即保留最近 7 个整天。
# 位置放在三类快照之后，且 find 失败只吞不 abort：清理出问题绝不能把备份服务带崩
# （set -e 下不兜住会让 timer 变 failed，那是比缓存涨一点更吵的后果）。
TEMP_DIR="$BOT/data/temp"
if [ -d "$TEMP_DIR" ]; then
    _old=$(find "$TEMP_DIR" -maxdepth 1 -type f -name 'media_image_*' -mtime +7 | wc -l | tr -d ' ')
    find "$TEMP_DIR" -maxdepth 1 -type f -name 'media_image_*' -mtime +7 -delete 2>/dev/null || true
    echo "媒体缓存清理：删掉 ${_old} 个满 7 天的 media_image_*，temp 现有 $(du -sm "$TEMP_DIR" | cut -f1)M"
fi
