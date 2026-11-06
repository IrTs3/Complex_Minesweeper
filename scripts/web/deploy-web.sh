#!/usr/bin/env bash
# 把网页版部署到阿里云服务器（对外只走域名的 https）。
#
# 入口现状（2026-10-20 明文收口之后）：
#   https://ty0712.com/     唯一对外入口（443，Let's Encrypt 证书）
#   http://ty0712.com/      除 ACME 挑战与 /gate/ 外一律 302 到上面（80 必须留着：续期靠它）
#   http://127.0.0.1:8080/  自己人用的口子，只绑回环。从本机要用就开隧道：
#                           ssh -p <SSH端口> -L 18080:127.0.0.1:8080 root@服务器，再开 http://127.0.0.1:18080/
#
# 背景：见 docs/服务器迁移与排行榜方案.md §5.5 —— ICP 备案通过前，国内服务器
# 绑域名的 80/443 会被拦截，所以内测阶段用「公网 IP + 非 80 端口」；备案下来后
# 域名接管 80，明文收口时那个 IP+端口入口收回回环。
#
# 用法：
#   ./deploy-web.sh                          # 上传 + 远端 nginx 配置 + 自测
#   SERVER=root@1.2.3.4 ./deploy-web.sh
#   SSH_PORT=712 ./deploy-web.sh             # 默认就是 712（下面 SSH_PORT 的值）
#                                            ↑ 别被这行注释带偏成 22
#   PORT=8081 ./deploy-web.sh                # 回环内测端口，默认 8080（对外只有 443，这个值别乱改）
#
# 注意：服务器在阿里云，机器内改 UFW 只解决一半问题——**安全组**没放行的话外网照样不通。
#       判断方法：外网 `nc -z <IP> <端口>` 不通、但服务器 `curl localhost:<端口>` 返回 200，
#       就是安全组挡的（只能在 ECS 控制台改）。
#       收到回环后，安全组里那条 8080 可以顺手撤（撤不撤都不影响：nginx 不在对外地址上听）。
#
# 前置条件（只需一次）：
#   1. 服务器已装 nginx；本机 ~/.ssh 有可用密钥（免密登录）。
#   2. **阿里云安全组**已放行 80/tcp 与 443/tcp（80 是为了 ACME http-01 续期，
#      不是给内容用的）。首次部署若忘了开，脚本末尾自测会失败。
#
# 说明：.map 源码地图与 *.d.ts 类型声明故意不上传 —— 浏览器从不请求它们，
# 传上去只会把内部路径、模块结构与函数签名白送给任何拿到会话的人。
#
# nginx 侧会写入三个文件（每次都整体覆盖，改这里即改线上）：
#   /etc/nginx/snippets/cms-security-headers.conf   安全头（server 与 location 都要 include）
#   /etc/nginx/conf.d/cms-ratelimit.conf            限流区定义（只能写在 http 上下文）
#   /etc/nginx/sites-available/complexminesweeper   站点本体：两个 server 块（80 跳转 / 443+回环内容）
#
# 访问闸门（密码页）由本脚本负责 nginx 侧的 auth_request 接线，但**鉴权服务本身**
# 由 scripts/web/deploy-gate.sh 部署。**必须先跑 deploy-gate.sh 再跑本脚本**，
# 否则闸门一开、鉴权服务不在，所有人都进不去。
#
# 改配置前会备份到 /root/cms-bak/，并写好 /root/cms-restore.sh；
# 若 nginx -t 失败会自动回滚再 reload，不会留下起不来的 nginx。
#
# 自测会**强制断言**：未登录时游戏相关 URL（含旧的 /gate/）必须 404（当作不存在，
# 不吐密码页也不吐裸 401——两者都等于承认「这里有东西」；登录入口改成了随机不可猜的
# /gate/<TOKEN>/）、/ 按当前
# landing 模式应是 404(game) 或 302→/learn/(learn)、公开路径必须 200、gzip 真的生效、
# 受保护与公开路径都带 CSP；另加一组明文收口的断言：80 除 ACME 与 /gate/ 外必须 302 到
# https 且跳转目标写死域名、明文侧不许出现 token、内测端口只能绑回环、cookie 在 443 带
# Secure 而在回环不带、HSTS 只在 443 发（明文那两侧必须不带）。
# 任一不满足即 exit 1 —— 防止再出现「以为开了其实没开」。
set -euo pipefail
cd "$(dirname "$0")/../.."

# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。SERVER=/SSH_PORT= 可临时覆盖。
# 服务器已把 SSH 改到非标端口（方案 §9 加固清单：禁密码登录 + 改端口 + fail2ban）。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
SERVER="${SERVER:-${CMS_HOST:-}}"
SSH_PORT="${SSH_PORT:-${CMS_SSH_PORT:-}}"
[ -n "$SERVER" ] && [ -n "$SSH_PORT" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT（也可用 SERVER= / SSH_PORT= 临时覆盖）" >&2; exit 1; }
REMOTE_DIR="/srv/complexminesweeper"
PORT="${PORT:-8080}"               # 只绑回环的内测端口（与 SSH 端口无关；对外入口是 443）
DOMAIN="${DOMAIN:-ty0712.com}"     # 已备案域名：80 接管 default_server 后统一 302 到 https
WEB_DIR="web"

SSH="ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

echo "==> 目标：${SERVER}:${REMOTE_DIR}（对外 https://${DOMAIN} 走 443，80 只跳转；回环内测端口 ${PORT}，SSH 端口 ${SSH_PORT}）"

# 1) 确保 TypeScript 产物是最新的（网页版走纯 TS 的 wasm_stub，不需要 Emscripten）
echo "==> 编译 TypeScript"
( cd "$WEB_DIR" && ./node_modules/.bin/tsc )

# 1b) 缓存击穿：把本次部署的版本号 ?v=BUILD 挂到 index.html 的入口引用，
#     以及 dist 里**每一个**相对 import 上，然后从这份改写副本（$STAGE）同步。
#
# ★ 为什么必须做（2026-10-18 iOS Edge 真机事故）：
#   普通模式的浏览器里存着旧版 dist/*.js，而当年那份响应带 `expires 7d`（10-16 事故配置），
#   浏览器认为"还没过期"→ **根本不回源**，服务器后来改成 no-cache 也管不了已存下的副本。
#   症状：无痕能加载新版、普通模式/关标签重开都还是旧的，用户又不愿清全局缓存（波及其他网站）。
#   唯一能绕开的办法是**换 URL**：让页面去请求一个浏览器从没缓存过的地址。
#   `/`（index.html）本身是 no-store，每次都回源，所以只要它引用的资源带上每次部署都变的
#   ?v=BUILD，旧缓存就永远命不中——用户不用清缓存、不用强刷，正常打开即新版。
#
#   ⚠️ 只改入口没用：ES 模块会顺着 import 链加载 game.js/renderer.js…，
#      所以**子模块的相对 import 也要一起挂 ?v=BUILD**，否则新 main.js 仍 import 出旧 game.js。
#      本项目 dist 的 import 全是相对 './x.js'（含副作用 import './debug.js'），无裸包名、无动态 import()，
#      故一条 sed 即可覆盖；若将来引入动态 import 或裸模块名，这里的正则要相应扩展。
#
#   源码树保持干净：改写只发生在 $STAGE（临时副本）里，web/index.html 与 web/dist 原样不动。
BUILD="${BUILD:-$(date +%Y%m%d-%H%M%S)}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
echo "==> 缓存击穿：给资源 URL 挂版本号 v=${BUILD}"
cp "$WEB_DIR/index.html" "$STAGE/index.html"
cp -R "$WEB_DIR/dist" "$STAGE/dist"
# 入口 HTML：module 脚本与样式表的 URL 各挂一个 ?v=
sed -i.bak -E "s#(src=\"dist/main\.js)\"#\1?v=${BUILD}\"#; s#(href=\"style\.css)\"#\1?v=${BUILD}\"#" "$STAGE/index.html"
rm -f "$STAGE/index.html.bak"
# dist 里每个相对 import 说明符（'./x.js'）都挂 ?v=；from '…' 与副作用 import '…' 同样匹配
find "$STAGE/dist" -name '*.js' -exec sed -i.bak -E "s#(['\"])(\./[A-Za-z0-9_./-]+\.js)(['\"])#\1\2?v=${BUILD}\3#g" {} +
find "$STAGE/dist" -name '*.js.bak' -delete
# 断言：入口与子模块 import 都真的被改写了。没改到 = 缓存击穿失效，宁可让部署失败也别静默发旧 URL。
grep -q "dist/main\.js?v=${BUILD}" "$STAGE/index.html" \
    || { echo "  ✗ index.html 入口未挂版本号，缓存击穿失败" >&2; exit 1; }
grep -q "\./game\.js?v=${BUILD}" "$STAGE/dist/main.js" \
    || { echo "  ✗ main.js 的子模块 import 未挂版本号，缓存击穿失败" >&2; exit 1; }
echo "  ✓ 入口 + 子模块 import 均已挂 v=${BUILD}"

# 2) 建目录并同步文件
#    index.html 与 dist 从改写副本 $STAGE 同步（带 ?v=BUILD）；style.css/assets/gate 用原始文件。
echo "==> 同步文件"
$SSH "$SERVER" "mkdir -p '$REMOTE_DIR'"
# --delete-excluded：单靠 --delete 不会删接收端被排除的文件，旧的 *.map / *.d.ts 得靠它清掉
rsync -az --delete --delete-excluded --exclude='*.map' --exclude='*.d.ts' --exclude='.DS_Store' \
    -e "ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10" \
    "$STAGE/index.html" "$WEB_DIR/style.css" "$STAGE/dist" "$WEB_DIR/assets" "$WEB_DIR/gate" \
    "$WEB_DIR/learn" \
    "$SERVER:$REMOTE_DIR/"

# 3) 远端 nginx 配置（独立 server block + 两个 snippet，不碰默认站点）
#
# 拆成三个文件的原因：
#   · limit_req_zone / limit_conn_zone 只能写在 http 上下文，server 块里写不了 → 放 conf.d/
#   · 安全头要在 server 与 location 两处都生效，而 nginx 的 add_header 在子块里
#     **会覆盖**父块的（不是叠加）→ 抽成 snippet，两处 include，避免漏掉
echo "==> 备份现有 nginx 配置（供 nginx -t 失败时自动回滚）"
$SSH "$SERVER" "set -e
    TS=\$(date +%Y%m%d-%H%M%S)
    install -d -m 700 /root/cms-bak
    cp -a /etc/nginx/sites-available/complexminesweeper /root/cms-bak/site.\$TS 2>/dev/null || true
    cp -a /etc/nginx/snippets/cms-security-headers.conf /root/cms-bak/headers.\$TS 2>/dev/null || true
    cp -a /etc/nginx/conf.d/cms-ratelimit.conf /root/cms-bak/ratelimit.\$TS 2>/dev/null || true
    # 各类只保留最近 20 份，其余删掉（每次部署 +3 个文件，不清理会无限增长撑满磁盘）。
    # ls -1t 按修改时间新到旧排序，tail -n +21 跳过最新 20 个、吐出其余，xargs -r 空输入时不动手。
    # 回滚脚本用 ls -1t 取最新一份；最新的 20 份始终在，回滚不受影响。
    for kind in site headers ratelimit; do
        ls -1t /root/cms-bak/\$kind.* 2>/dev/null | tail -n +21 | xargs -r rm -f
    done
    echo \"  备份时间戳 \${TS}（目录 /root/cms-bak/，各类仅保留最近 20 份）\""

echo "==> 写入 nginx 配置"
$SSH "$SERVER" "mkdir -p /etc/nginx/snippets"

# 回滚脚本：把三份 nginx 配置还原到最近一次备份。由下一步的 nginx -t 失败分支调用。
# 单独写成文件是为了避免在 ssh 的双引号字符串里嵌套过多转义（很容易写错）。
$SSH "$SERVER" "cat > /root/cms-restore.sh" <<'RESTORE'
#!/bin/sh
# 把 nginx 配置还原到最近一次部署前的备份（备份由 deploy-web.sh 每次部署前生成）。
# 仅在所有三份备份都存在时才动手，避免"只还原一半"造成更坏的状态。
set -e
BAK=/root/cms-bak
need="site headers ratelimit"
for kind in $need; do
    src=$(ls -1t "$BAK/$kind".* 2>/dev/null | head -1)
    if [ -z "$src" ]; then
        echo "  找不到 $kind 的备份，拒绝自动回滚（请手工处理）" >&2
        exit 1
    fi
done
for pair in "site:/etc/nginx/sites-available/complexminesweeper" \
            "headers:/etc/nginx/snippets/cms-security-headers.conf" \
            "ratelimit:/etc/nginx/conf.d/cms-ratelimit.conf"; do
    kind=${pair%%:*}
    dst=${pair##*:}
    src=$(ls -1t "$BAK/$kind".* 2>/dev/null | head -1)
    cp -a "$src" "$dst"
    echo "  已还原 $dst"
done
RESTORE
$SSH "$SERVER" "chmod 700 /root/cms-restore.sh"

$SSH "$SERVER" "cat > /etc/nginx/snippets/cms-security-headers.conf" <<'HEADERS'
# 复数扫雷：安全响应头。server 与静态资源 location 都要 include
# （nginx 的 add_header 在嵌套块中会覆盖父块，不 include 就会漏）
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
# img-src 必须含 blob:：网页端导入图片是 URL.createObjectURL(file) → <img> 预览，
# 只放 self/data: 会让 onload 永远不触发，界面上看着像「选图没反应」（2026-10-22 实测）。
# blob: 只能由本站脚本创建，不扩大跨源面。
add_header Content-Security-Policy "default-src 'self'; img-src 'self' data: blob:; script-src 'self'; style-src 'self'; font-src 'self'; form-action 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'" always;
# HSTS（2026-10-21 点头开的）：值取自站点文件里的 map $cms_hsts —— **只给 https 发**。
# 为什么不用字面量：这份片段被 80 跳转块与 443/回环 8080 块共用，写死就会让明文响应
# 也带上这个头。浏览器按 RFC 6797 会忽略明文侧的那份（所以不会把人锁死），但配置
# 从此分不清「谁发的、到底生效没有」，正是最难查的那类歧义。
# nginx 的 add_header 遇到**空值**时不发这一行，map 的 default 就是空的。
# max-age 取 180 天而不是 365：443 是唯一的对外入口，证书一断全站就打不开，
# 这个头本身退不掉（只能等过期或清浏览器状态），所以宁可锁得短一半。
# 不带 includeSubDomains：现在只有裸域名有 DNS 记录，加上是给以后所有子域预先上锁。
add_header Strict-Transport-Security $cms_hsts always;
HEADERS

$SSH "$SERVER" "cat > /etc/nginx/conf.d/cms-ratelimit.conf" <<'RATELIMIT'
# 复数扫雷：限流区定义。必须在 http 上下文（conf.d/*.conf 会被 nginx.conf 自动 include）
# 10m 共享内存约可存 16 万个 IP 的状态，对个人项目绰绰有余
limit_req_zone  $binary_remote_addr zone=cms_perip:10m rate=20r/s;
limit_conn_zone $binary_remote_addr zone=cms_conn:10m;
# 登录专用：低频强度高的操作，必须比 20r/s 严得多，否则等于没有登录防护
limit_req_zone  $binary_remote_addr zone=cms_login:10m rate=10r/m;
RATELIMIT

$SSH "$SERVER" "cat > /etc/nginx/sites-available/complexminesweeper" <<'NGINX'
# 复数扫雷网页版 —— 明文通道收口（2026-10-20 裁决）后是**两个 server 块**：
#   块一（80，default_server）  只做两件事：接 ACME 挑战文件、把其余一切 302 到 https。
#                               它不再 serving 任何内容，所以闸门逻辑不用在这儿重写一遍。
#   块二（443 + 回环 8080）     真正的站点：闸门、学习站、秘密登录入口全在这里。
#
# 443 不在这里写死，由块二 include 的开关片段决定（证书在才监听）；见 3.7 那段。
# 8080 只绑 127.0.0.1 / [::1]：这是「自己人用的后门」，不对外。要看就在本机
# 开一条 SSH 隧道把它拉回本地（ssh -L 18080:127.0.0.1:8080 服务器），
# 回退只要去掉那两处前缀 —— 保留它的理由见下面块二的注释。

# HSTS 按**协议**给值（安全头片段里那行 add_header 用的就是 $cms_hsts）。
# map 必须在 http 上下文，本文件正是被 nginx.conf 在 http 里 include 的（sites-enabled 软链）。
# 明文那一侧给空串 —— nginx 的 add_header 遇空值不发头，所以 80 的 302 与 8080 隧道都干净。
map $scheme $cms_hsts {
    https   "max-age=15552000";
    default "";
}

server {
    # ==================== 块一：80 明文只负责把人送到 443 ====================

    # 80 端口为什么要抢 default_server（2026-10-20）：
    # Debian 自带 default 站点原本占着 80 的 default_server，此前 ufw 没放行 80
    # 所以它一直不可达。一旦为域名放开 80，它就变成「输入 IP 看到 Welcome to Debian
    # + 全局 server_tokens 未关 → Server: nginx/1.24.0 (Ubuntu)」，等于给扫描器报版本。
    # 本站块里已有 server_tokens off，让本站兜住所有 Host 反而更干净。
    # ⚠️ 前提：sites-enabled/default 必须已被下面的步骤移走，
    #    否则同一端口出现两个 default_server，nginx -t 直接失败并自动回滚。
    listen 80 default_server;
    listen [::]:80 default_server;

    # 只声明域名：IP 直连与乱 Host 靠上面的 default_server 落到本站，而不是靠
    # 「server_name 写一个下划线通配」—— 通配名与 default_server 谁赢取决于匹配顺序，属隐式行为。
    # www.ty0712.com 目前**没有 DNS 记录**，写上只是给以后加记录留位（不加也不报错）。
    server_name @@DOMAIN@@ www.@@DOMAIN@@;

    server_tokens off;
    include /etc/nginx/snippets/cms-security-headers.conf;

    # ACME http-01：80 上唯一还 serving 内容的路径。
    # ★ 这就是「80 不能彻底关掉」的原因：证书每 60 天要续，续期走的就是 http-01。
    #   改成 DNS-01 倒是能关死 80，但那要往服务器放一把能改 DNS 的长期 AccessKey，
    #   比留一个只发挑战文本的 80 危险得多。
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
        try_files $uri =404;
    }

    # 秘密登录入口在明文侧**不跳转、直接 404**：302 会把 token 原样写进明文响应的
    # Location，等于在没加密的链路上再广播一次（而且明文侧本来就没有可用的入口 ——
    # 会话 cookie 在 https 下带 Secure，http 收到也带不出去）。口径与 404 模型一致：
    # 明文这条路上，闸门「不存在」。
    #
    # ★ access_log off 不是可选项（2026-10-21 审计 ★2）：请求 URI 里就带着 token，
    #   这条 location 又不关日志，于是每一次「按 http:// 点登录链接」（首访没有 HSTS、
    #   IM 链接预览爬虫、手打少一个 s）都把唯一登录凭据原样写进
    #   /var/log/nginx/access.log（640 www-data:adm、daily + rotate 14 天、还会被采集走）。
    #   M1 当时只关了片段里那两条 location，漏了明文这一条 —— 实测部署自测打一次
    #   127.0.0.1:80 就落一条全文 token 的 404 记录。
    location ^~ /gate/ {
        access_log off;
        # error_log 不受 access_log 影响：limit_req 的 429 和「文件不存在」的 open()
        # 失败都以 error 级把**完整 URI** 写进 /var/log/nginx/error.log（640、rotate 14）
        # —— 那是第二条泄漏管道。crit 把这两类丢掉，这条路径上什么都不落盘。
        error_log /dev/null crit;
        add_header Cache-Control "no-store" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
        return 404;
    }

    # 其余一律 302 到 https。三个细节都是刻意的：
    #   · **必须写在「location /」里，不能放在 server 级**：server 级的 return 属于
    #     rewrite 的 server 阶段，先于 location 匹配执行，会把上面 ACME 的 ^~ 与
    #     /gate/ 的 404 一起短路（2026-10-20 实跑：/gate/<TOKEN>/ 在明文上被 302 出去，
    #     ACME 挑战同样被跳走 —— 证书续期会静默失败）。
    #   · 写死 @@DOMAIN@@ 而不是用 $host：Host 头是客户端可控的，拿它拼跳转目标
    #     等于让来的人决定把你跳去哪（可被用来做钓鱼跳转）。
    #   · 302 而不是 1：永久跳转会被浏览器缓存下来，证书一旦出问题就退不回 http 了
    #     （本项目片段 301→302 已经踩过一次同样的坑）。
    location / {
        return 302 https://@@DOMAIN@@$request_uri;
    }
}

server {
    # ==================== 块二：内容（443 对外 + 8080 只对自己） ====================
    #
    # 8080 为什么还留着、又为什么只绑回环：
    #   1. 探活第 4 项与第 6 项、以及本脚本下面的整段自测，都是拿 127.0.0.1:8080
    #      当「内容块活着 + 闸门语义对不对」的基准。删掉监听 = 监控当场误报；
    #      只绑回环 = 一个请求都不用改。
    #   2. 443 出问题时，它是留在机器内部的检修口（去掉 127.0.0.1: 前缀即恢复对外）。
    # 绑到 0.0.0.0 的话它就是一条永远明文的入口，所以收进回环。
    listen 127.0.0.1:@@PORT@@;
    listen [::1]:@@PORT@@;

    # 443 走「开关式 snippet」（2026-10-20 上 HTTPS 的第一档）：
    # 证书就位 → 那个文件里写监听与两行证书路径；证书不在 → 部署脚本把它写成空文件。
    # 为什么要绕这一圈，而不是在本块里直接写证书路径：
    # 那样证书一旦丢失或没签成，nginx -t 会因缺 cert 失败并触发整站回滚 ——
    # 等于把「443 挂了」和「其余入口还能用」绑成同一个故障。
    # 有了这颗开关，回退只要把 snippet 清空再 reload，443 消失、8080 毫发无伤。
    # ⚠️ 证书丢了而 snippet 是空的，块二就**没有任何对外监听**（80 那块只跳转）——
    #    现象是「网站全打不开」而不是「退回明文」，这是收口之后换来的代价，
    #    所以部署自测会当场报证书剩余天数。
    include /etc/nginx/snippets/cms-https-listen.conf;

    server_name @@DOMAIN@@ www.@@DOMAIN@@;

    root @@REMOTE_DIR@@;
    index index.html;
    autoindex off;

    # 不回显 nginx 版本号（默认会带 nginx/1.24.0 (Ubuntu)，等于给扫描器报版本）
    server_tokens off;

    # ---- 抗滥用 ----
    # 单 IP 20 请求/秒，突发 40 个立即放行（首屏只要 13 个请求，正常用户碰不到上限）
    # 超限返回 429 而不是 503，语义更准且便于统计
    limit_req  zone=cms_perip burst=40 nodelay;
    limit_req_status 429;
    # 单 IP 并发连接上限 20（浏览器同源并发约 6 条，留足余量）
    limit_conn cms_conn 20;
    limit_conn_status 429;

    # 本站纯静态、无任何写接口，把上传体卡死到 1m、超时收紧
    client_max_body_size 1m;
    client_body_timeout  10s;
    client_header_timeout 10s;
    send_timeout         15s;
    keepalive_timeout    20s;

    # ---- 压缩 ----
    # 不开 gzip 首屏要传 314 KB；开启后约 145 KB（-54%）
    # webp/woff2 本身已压缩，不在 gzip_types 里，免做无用功
    gzip on;
    gzip_comp_level 6;
    gzip_min_length 256;
    gzip_vary on;
    gzip_proxied any;
    gzip_types text/plain text/css text/javascript application/javascript application/json application/xml image/svg+xml application/wasm;

    include /etc/nginx/snippets/cms-security-headers.conf;

    # ==================== 访问闸门（auth_request）====================
    #
    # 四条铁律，改动时务必保持：
    #   1. /__auth 必须 internal —— 否则访客能直接打它，而且子请求会递归
    #   2. 公开路径要用 `location ^~`（只有 ^~ 才压得过下面的正则 location）；
    #      精确匹配 `location =` 优先级最高，所以两个字体直接写 `=`
    #   3. 所有受保护 location 统一挂 error_page 401/403/502/504 =404 /__nf：
    #      未登录者看到的就是「服务器上没这个文件」，不吐密码页也不吐裸 401
    #      （两者都等于告诉陌生人这里有受保护的东西）。登录入口是随机不可猜的
    #      /gate/<TOKEN>/（正文在 cms-gate-path.conf，运维用 cms gate-path 换）。
    #   4. **受保护的一切都不许被浏览器缓存复用**（见下面的 Cache-Control）
    #
    # ★ 为什么第 4 条要命（2026-10-16 线上事故）：
    #   原配置里受保护的 `dist/*.js` 命中的是下面的**正则** location（nginx 里
    #   正则压过普通前缀，`/dist/` 不是 `^~` 所以挡不住），带着 `expires 7d`
    #   → 浏览器 7 天内**一个请求都不发**就用缓存里的 JS；而游戏 HTML 只有
    #   ETag/Last-Modified、没有 Cache-Control，浏览器按启发式新鲜度也会直接复用。
    #   结果：直接在地址栏输网址 → 整页从缓存加载，auth_request 压根没跑，
    #   没登录也能进游戏；只有按 F5（强制重新校验）才会看到密码页。
    #   → 受保护响应必须 `no-cache`（每次回源校验，带 ETag 仍可 304 不重传正文）
    #     或 `no-store`；**任何受保护的 location 都不许出现 `expires`**。
    #   另注意：给子块加 add_header 会让父块的安全头失效（nginx 覆盖而非叠加），
    #   所以凡是加了 Cache-Control 的块都必须重新 include 安全头。

    location = /__auth {
        internal;
        proxy_pass http://127.0.0.1:8090/auth;
        proxy_pass_request_body off;              # auth_request 惯例：不重复上传 body
        proxy_set_header Content-Length "";
        proxy_set_header X-Real-IP $remote_addr;
        # UA 透传：/auth 每次都要跑（每个受保护请求都触发），当前**不写**使用记录
        # （否则一次页面加载就刷 13 条）。这里传是为了将来做访问日志时不用再改 nginx。
        proxy_set_header User-Agent $http_user_agent;
        proxy_read_timeout 5s;
    }

    # 登录：低频高强度，用独立的严限流（复用 20r/s 的 cms_perip 等于没防）
    location = /__login {
        limit_req zone=cms_login burst=5 nodelay;
        limit_req_status 429;
        limit_except POST { deny all; }
        client_max_body_size 8k;
        proxy_pass http://127.0.0.1:8090/login;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header User-Agent $http_user_agent;   # 记录浏览器与设备
        # 把「这次是加密还是明文」告诉后端：authd 只在 https 时给会话 cookie 加 Secure。
        # 为什么用 $scheme 而不是 X-Forwarded-For 那种可被伪造的头：这个头由 nginx 覆盖写
        # （proxy_set_header 是**替换**不是追加），客户端自己带进来的同名头进不来。
        # 回环 8080 上 $scheme 恒为 http → 不加 Secure → 隧道与本机照常能登录。
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_hide_header Server;                        # 不暴露后端实现
        proxy_read_timeout 15s;
    }

    location = /__logout {
        limit_except POST { deny all; }
        proxy_pass http://127.0.0.1:8090/logout;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;      # 清 cookie 要带同样的属性才清得掉
        proxy_hide_header Server;
    }

    # 登录入口：一条随机不可猜的路径 /gate/<TOKEN>/，正文在独立 snippet 里。
    # 这里**不再**有公开的 `location ^~ /gate/`：404 模型下，一个人人都摸得到的
    # 密码页等于向扫描器承认「这后面有受保护的东西」。现在 /gate/ 落到下面的
    # 受保护兜底 → 无会话者 404，只有知道秘密网址的人能打开登录页。
    # 运维用 `cms gate-path status|set|rotate`（或 cmsui 芯片）查看与换入口；
    # 部署每次按当前模板重渲染这份片段（见 3.6 步），但 token 沿用现有的 ——
    # 重部署绝不换掉大家收藏的入口。
    include /etc/nginx/snippets/cms-gate-path.conf;

    # 密码页要用的两个字体：精确匹配（优先级高于下面的正则 location）
    # 这两个是**公开内容**（未登录也能拿，否则登录页标题字体就崩了），
    # 所以可以放心长缓存。
    #
    # ★ 2026-10-19：原来这里还有 `location = /assets/bg.webp` / `= /assets/bg.jpg`
    #   两个公开块，现在**删掉了**。背景图是未授权的商用素材，匿名能直接
    #   curl 走完整原图 = 公网裸奔；收进闸门后它落到下面的正则块 ——
    #   无会话 404、已登录 200（会话 cookie 是 Path=/，覆盖 /assets/*，
    #   所以登录访客与游戏画布取图完全不受影响）。
    #   登录页自己改成了 CSS 渐变背景（见 web/gate/gate.css），不再依赖这张图。
    #
    #   ⚠️ 别写 `expires 0`：它会自己再发一个 Cache-Control 头，和 add_header
    #      叠成两个，行为取决于客户端（这正是下面「auth_request 的 location 不许
    #      有 expires」那条铁律的由来）。要缓存策略就只用 add_header。
    location = /assets/ibmplex-ascii.woff2      { expires 7d; add_header Cache-Control "public" always; include /etc/nginx/snippets/cms-security-headers.conf; }
    location = /assets/IBMPlexSerif-Regular.ttf { expires 7d; add_header Cache-Control "public" always; include /etc/nginx/snippets/cms-security-headers.conf; }

    # 文档根路径的归属（开放站 or 学习站）由运维用 `cms landing game|learn` 切换，
    # 正文抽到独立 snippet，部署只负责 include —— 重部署不覆盖运维的当前选择。
    # 片段里含 /game、兜底 location / 与 /game/ 纠正；两种模式的差异都在那里。
    include /etc/nginx/snippets/cms-landing-root.conf;

    # 未登录的统一出口：404「当作不存在」。
    # 不吐密码页、也不吐裸 401 —— 两者都等于告诉陌生人「这里有受保护的东西」；
    # 404 则和「服务器上根本没这个文件」长得一模一样。登录入口不再是公开的 /gate/，
    # 而是随机不可猜的 /gate/<TOKEN>/（见上面 include 的 cms-gate-path.conf）。
    # internal：外部直接请求 /__nf 同样 404，不会变成新入口。
    # 头上仍挂 no-store + CSP：错误响应若被缓存复用，一样能绕过 auth_request。
    location = /__nf {
        internal;
        add_header Cache-Control "no-store" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
        return 404;
    }

    location = /index.html {
        auth_request /__auth;
        error_page 401 403 502 504 =404 /__nf;
        add_header Cache-Control "no-store" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
        try_files /index.html =404;
    }

    # 公开：C++ 学习站（监管要求的真实学习内容，无需登录）。
    # 必须用 `^~`：只有它能在「最长前缀命中」后直接终止匹配，压过下面那条
    # 带 auth_request 的正则 `~* \.(js|css|...)$` —— 否则 /learn/app.js 会 401。
    # try_files **绝不**回退 /index.html：那会把受闸门保护的游戏 HTML
    # 从公开路径泄漏出去；学习站缺文件就该老老实实 404。
    location = /learn { return 301 /learn/; }
    location ^~ /learn/ {
        add_header Cache-Control "no-cache" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
        try_files $uri $uri/ =404;
    }

    # 公开：Let's Encrypt 的 http-01 挑战目录（签证书用，2026-10-20）。
    # 80 那块（跳转专用）已经有同一条了，这里再留一份的理由：80 上除了挑战路径全部
    # 302 到 https，LE 跟随跳转后会再从 443 取一次同一个文件 —— 这边缺了就续不上。
    # 为什么必须单独开一条：404 模型下未登录者什么都拿不到，实测
    # /.well-known/acme-challenge/probe 返回 404 —— 而 LE 服务器正是以匿名访客的
    # 身份来取这个文件的。不先放开它，证书永远签不下来（先有鸡还是先有蛋）。
    # root 特意指到 /var/www/acme 而**不是站点根**：那里除挑战文件外一片空白，
    # 相当于只把「一个前缀 + 只发文本」暴露出去，而不是把 /srv 变成可下载面。
    # try_files 只认精确存在的文件，绝不回退 /index.html（那会泄漏受闸门保护的游戏页）。
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/acme;
        default_type text/plain;
        try_files $uri =404;
    }

    # 受保护：游戏 JS。未登录 → 404（当作不存在），不映射到密码页
    location /dist/ {
        auth_request /__auth;
        error_page 401 403 502 504 =404 /__nf;
        limit_except GET HEAD { deny all; }
        add_header Cache-Control "no-cache, private" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
    }

    # 受保护：其余静态资源（上面 `=` 的两个公开字体优先命中，不受影响）
    # 注意两点：① 必须重新 include 安全头，否则被本块的 add_header 覆盖掉；
    #          ② **绝不能有 expires** —— 本块的正则压得过 /dist/ 与 /，
    #             一旦带上 max-age，浏览器就会绕过 auth_request（见文件顶部说明）
    location ~* \.(js|css|ttf|otf|jpg|jpeg|png|webp|woff2)$ {
        auth_request /__auth;
        error_page 401 403 502 504 =404 /__nf;
        limit_except GET HEAD { deny all; }
        add_header Cache-Control "no-cache, private" always;
        include /etc/nginx/snippets/cms-security-headers.conf;
    }

    # 受保护：兜底 —— 在 landing 片段里（两种模式行为不同：learn 404、game 302 /game）。
    # ⚠️ 别在这里再加一个 `location /`：nginx 会报 duplicate location。
}
NGINX

# 上一步用了「引号 heredoc」——正体一字不改地写入，避免反引号/$ 被 shell 展开或执行
# （曾踩过：注释里写 `location ^~` 导致 bash 去执行 location 命令，把注释吞掉）。
# 端口与目录用占位符，这里再替换，并断言没有残留。
$SSH "$SERVER" "set -e
    sed -i 's|@@PORT@@|${PORT}|g; s|@@REMOTE_DIR@@|${REMOTE_DIR}|g; s|@@DOMAIN@@|${DOMAIN}|g' /etc/nginx/sites-available/complexminesweeper
    if grep -q '@@' /etc/nginx/sites-available/complexminesweeper; then
        echo '  ✗ 配置里仍有未替换的占位符' >&2; exit 1
    fi
    echo '  占位符已替换（PORT/REMOTE_DIR/DOMAIN）'
"

# 3.5) 默认页片段（cms-landing-root.conf）：**沿用模式、按当前模板重渲染正文**。
#      模式（首行 `# landing-mode: game|learn`）是运维用 `cms landing` 选的，重部署
#      必须保留，否则一次部署就把人切回游戏页，监管复查时正好撞见。
#      但正文必须跟着模板走：旧模板里没有 /game，而登录后的落点就是 /game ——
#      不重渲染等于「升级后登录成功却落在 404」。与 3.6 的 gate-path 同一套取舍。
#      用「引号 heredoc 喂 ssh 的 cat」写候选文件（同 cms-restore.sh 的套路），
#      避免在 ssh 的双引号串里嵌套 heredoc 把引号/反引号搞坏。
echo "==> 默认页片段（按当前模板重渲染，保留运维选定的模式）"
$SSH "$SERVER" "cat > /root/cms-landing-game.conf" <<'LANDING'
# landing-mode: game
# 开放站：根路径与任何未定义路径都 302 到 /game；游戏是否可见由 /game 的闸门决定
location = / {
    return 302 /game;
}

# 游戏入口：必须登录；未登录由 error_page 映射成 404「当作不存在」
location = /game {
    auth_request /__auth;
    error_page 401 403 502 504 =404 /__nf;
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    try_files /index.html =404;
}

# 带斜杠的写法纠正到 /game。302 不用 301：换路由方案时别让浏览器被永久缓存钉住
location = /game/ {
    return 302 /game;
}

# 兜底：其他任何路径都去游戏（开放站希望访客直接落到游戏，而不是看见 404）
location / {
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    return 302 /game;
}
LANDING
$SSH "$SERVER" "cat > /root/cms-landing-learn.conf" <<'LANDING_LEARN'
# landing-mode: learn
# 学习站：根路径 302 到公开学习站 /learn/；游戏只在 /game，其余路径一律 404
location = / {
    return 302 /learn/;
}

# 游戏入口：必须登录；未登录由 error_page 映射成 404「当作不存在」
location = /game {
    auth_request /__auth;
    error_page 401 403 502 504 =404 /__nf;
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    try_files /index.html =404;
}

# 带斜杠的写法纠正到 /game。302 不用 301：换路由方案时别让浏览器被永久缓存钉住
location = /game/ {
    return 302 /game;
}

# 兜底：学习站模式下，除 /learn/ 与 /game 之外的任何路径一律 404（不承认受保护内容）
location / {
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
    return 404;
}
LANDING_LEARN
$SSH "$SERVER" "set -e
    mode=\$(head -n1 /etc/nginx/snippets/cms-landing-root.conf 2>/dev/null | sed -n 's/^# *landing-mode: *//p')
    case \"\$mode\" in
        game|learn) ;;
        *)
            if [ -f /etc/nginx/snippets/cms-landing-root.conf ]; then
                echo '  ⚠ 原片段首行读不出模式标记，按 game 写入（要学习站请跑 cms landing learn）' >&2
            fi
            mode=game
            ;;
    esac
    install -m 644 /root/cms-landing-\$mode.conf /etc/nginx/snippets/cms-landing-root.conf
    echo \"  片段已按当前模板重渲染（模式：\${mode}）\"
    rm -f /root/cms-landing-game.conf /root/cms-landing-learn.conf"

# 3.6) 登录入口片段（cms-gate-path.conf）：**每次按当前模板重渲染**，token 沿用现有的
#      （片段不存在才现生成一个随机 token）。
#      token 是「谁能打开登录页」的唯一凭据，绝不进 git、绝不用固定值；
#      已存在则保留运维当前入口（`cms gate-path rotate` 换的那条），
#      否则一次重部署就把所有人收藏的登录网址换掉。
#      整段远程脚本用「引号 heredoc 喂 ssh 的 bash -s」：本地一字不展开，
#      远端再自己做变量替换 —— 与 3.5 同一套路，避开双引号串里嵌套引号的坑。
echo "==> 登录入口片段（每次按当前模板重渲染，token 沿用以免换掉已发出去的网址）"
$SSH "$SERVER" "bash -s" <<'GATEPATH'
set -e
CONF=/etc/nginx/snippets/cms-gate-path.conf
ROOT=/srv/complexminesweeper/gate
if [ -f "$CONF" ]; then
    # token 只在服务器上；终端/日志里只露前 4 位（部署输出常被贴进聊天或工单，
    # 完整打印一次就等于把唯一的登录凭据又广播一遍）
    TOK=$(sed -n 's/^# *gate-token: *//p' "$CONF" | head -n1)
    echo "  片段已存在，沿用运维当前入口：${TOK:0:4}…（其余位已隐去；要看全的用 cms gate-path status）"
else
    # ★ M4（2026-10-21 审计）：原来是 rand -hex 6（48 bit，注释还按 base36 吹成 1.7 万倍）。
    #   提到 12 字节 = 24 个十六进制字符（96 bit，用户定的长度）。
    #   只在片段不存在时用得到，**不会动已经发出去的入口**。
    TOK=$(openssl rand -hex 12 2>/dev/null || head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')
    echo "  片段不存在，将生成随机入口：/gate/${TOK:0:4}…（其余位已隐去；要看全的用 cms gate-path status）"
fi

# ★★ 下面这段渲染 + 安装**必须无条件执行**（2026-10-21 审计 M1/M3 上线时才发现）。
#   原来它整段在 `else` 里，也就是「只在片段不存在时才生成」——
#   于是模板里新加的 `access_log off` 对**已经存在的片段永远不生效**：
#   线上实测 permission=644、access_log off=0 条、访问日志照涨。
#   现在改成「token 沿用、配置按当前模板重渲染」：磁盘上的片段永远和模板一致，
#   不会因为"当初是旧模板生成的"而漂移。token 没变，所以已发出去的网址照旧有效。
#
# 与 CLI 同一道白名单：这个字符串会被拼进 nginx 的 location 行，形状不对就绝不安装
# （宁可部署失败，也不留一份可能被注入的配置在线上）。**沿用旧 token 也要过这一道**——
# 它现在是第一次被拼进 location 的路径。
if ! printf '%s' "$TOK" | grep -Eq '^[a-z0-9]{12,32}$'; then
    echo "  ✗ 片段里的 token 形状不合法（^[a-z0-9]{12,32}$）：已中止，未改动线上配置" >&2
    exit 1
fi

# ★★ 下面这份 heredoc 与 tools/gate_manager.py 的 gate_path_text() 是**同一份片段的两个
#   渲染器**（deploy 每次重渲染、`cms gate-path set/rotate` 整段重写，谁后跑谁覆盖）。
#   除 $TOK / $ROOT 换成实参外必须逐行一致 —— 只改一边就等于让线上内容随「上次是谁部署的」漂移。
#   有测试逐行比对两份文本，改这里记得同步改那边。
cat > /root/cms-gate-path.conf <<GATE_PATH_BODY
# gate-token: $TOK
# 秘密登录入口：/gate/ 与游戏页对无会话者一律 404，密码页只在下面这条随机路径可达。
# 查看/换入口：cms gate-path status|set|rotate（或 cmsui 顶栏芯片）。
# 302 不是 301：永久跳转会被浏览器缓存，换 token 后存过旧地址的人会被缓存钉在 404 上。
location = /gate/$TOK { access_log off; return 302 /gate/$TOK/; }

# 入口守卫：已登录直接送去 /game，未登录才显示密码页。
# 为什么用 proxy_pass 而不是 if + return：nginx 的 rewrite 阶段早于 auth_request，
# if 里拿不到「登没登录」；能走到内容阶段（proxy_pass）就说明 auth_request 已放行。
# authd 的 /entry 只回一条 302 /game，权限判断仍在 auth_request 那一步。
location = /gate/$TOK/ {
    access_log off;
    error_log /dev/null crit;
    auth_request /__auth;
    error_page 401 403 500 502 504 = /gate/$TOK/index.html;
    proxy_pass http://127.0.0.1:8090/entry;
    proxy_hide_header Server;
}

# 密码页与它自带的 gate.css / gate.js：公开（凭 token 不可猜）。
# 这里**不能**挂 auth_request —— 要登录才能看登录页就是死循环。
location ^~ /gate/$TOK/ {
    alias $ROOT/;
    index index.html;
    # token 明文就在这条 URL 里，access_log 会把它原样写进 /var/log/nginx/access.log
    #   （rotate 14 份、640 www-data:adm，还常被采集/备份带走）→ 入口等于公开。
    #   项目自己的口径就是「token 不进日志」，这里之前是漏的（2026-10-21 审计 M1）。
    #   代价：这条路径上的访问不再留痕 —— 对一个"谁访问都算暴露"的神秘路径，这是对的取舍。
    access_log off;
    # error_log 是另一条管道：limit_req 的 429 与 alias 的 open() 失败都以 error 级
    #   写入完整 URI（error.log 640、rotate 14）。crit 把这两类丢掉 = 这条路径零留痕。
    error_log /dev/null crit;
    add_header Cache-Control "no-store" always;
    include /etc/nginx/snippets/cms-security-headers.conf;
}
GATE_PATH_BODY
    chmod 600 /root/cms-gate-path.conf
    # ★ M3（2026-10-21 审计）：这行原来是 install -m 644，会**覆盖**上面那句 chmod 600，
    #   结果 /etc/nginx/snippets 里的 token 明文 644 全局可读 —— 服务器上任意本地账户
    #   都能读到唯一入口。nginx master 以 root 读配置，600 完全够，两处都保持 600。
install -m 600 /root/cms-gate-path.conf "$CONF"
echo "  ✓ 片段已按当前模板重渲染（token 未变），权限 600，两条 location 均已 access_log off"
GATEPATH

# 3.7) 443 开关（cms-https-listen.conf）：按**证书在不在**生成两份内容之一。
#      必须排在「启用 + nginx -t」之前 —— 主块 include 了这个文件，
#      文件不存在时 nginx -t 直接报 no such file，所以**空文件也必须落盘**。
#      证书本身由 scripts/web/deploy-https.sh 用 acme.sh 签发并装到 ${SSL_DIR}/，
#      本脚本只负责「有就用、没有就关」，不重复去签（重部署不该碰 CA，也不该吃限额）。
echo "==> 443 开关片段（证书就位才写监听，否则写空文件）"
SSL_DIR=/etc/nginx/ssl
SSL_PEM=${SSL_DIR}/${DOMAIN}.pem
SSL_KEY=${SSL_DIR}/${DOMAIN}.key
$SSH "$SERVER" "CMS_PEM='${SSL_PEM}' CMS_KEY='${SSL_KEY}' bash -s" <<'HTTPSLISTEN'
set -e
SNIP=/etc/nginx/snippets/cms-https-listen.conf
# 挑战目录：acme.sh 的 webroot 就是这个，nginx 里的 root 也指它，两处必须同名。
install -d -m 755 -o www-data -g www-data /var/www/acme/.well-known/acme-challenge
if [ -f "$CMS_PEM" ] && [ -f "$CMS_KEY" ]; then
    cat > "$SNIP" <<SNIP_BODY
# 由 scripts/web/deploy-web.sh 每次部署按证书在不在重新生成 —— 手改会被覆盖。
# 证书来自 acme.sh（scripts/web/deploy-https.sh）；续期成功后 --reloadcmd 会 reload nginx。
# 写法钉在 listen 行上：nginx 1.24 没有独立的 http2 on 指令（1.25.1 才有）。
listen 443 ssl http2;
listen [::]:443 ssl http2;
ssl_certificate $CMS_PEM;
ssl_certificate_key $CMS_KEY;
ssl_protocols TLSv1.2 TLSv1.3;
ssl_session_cache shared:CMS_SSL:10m;
ssl_session_timeout 1d;
ssl_session_tickets off;
SNIP_BODY
    echo "  ✓ 证书就位，443 监听已开：$(openssl x509 -noout -enddate -in "$CMS_PEM" 2>/dev/null || echo '（读不到到期日）')"
else
    : > "$SNIP"
    echo "  证书不在（${CMS_PEM}），开关留空：443 无人监听"
    echo "  ⚠ 明文收口之后这不是「退回明文能用」：80 那块只做跳转，443 没人听 = 域名整站打不开"
    echo "  签证书：bash scripts/web/deploy-https.sh（80 上的挑战路径已放开，续期也走它）"
fi
chmod 644 "$SNIP"
HTTPSLISTEN

# 4) 启用、语法检查、重载、防火墙
#    失败自动回滚：先把备份还原再 reload，避免留下一个起不来的 nginx
echo "==> 启用站点并重载 nginx（nginx -t 失败会自动回滚）"
$SSH "$SERVER" "
    set -e
    ln -sf /etc/nginx/sites-available/complexminesweeper /etc/nginx/sites-enabled/complexminesweeper

    # 移走 Debian 自带 default 站点：本站块里有「listen 80 default_server」，
    # 同一端口留两个 default_server 会让 nginx -t 直接失败。
    # ⚠️ 这里千万别写成反引号：整段在 ssh 的双引号串里，反引号会被本地 bash 当命令替换执行。
    # 幂等：只在符号链接还在时动手；失败回滚分支负责还原。
    if [ -e /etc/nginx/sites-enabled/default ]; then
        mv -f /etc/nginx/sites-enabled/default /root/cms-bak/sites-enabled-default.symlink
        echo '  已移走 Debian 自带 default 站点（本站接管 80 的 default_server；原件在 /root/cms-bak/）'
    fi

    if ! nginx -t 2>/tmp/cms-nginxt.err; then
        echo '  ✗ nginx -t 失败：' >&2
        sed 's/^/      /' /tmp/cms-nginxt.err >&2
        echo '  正在回滚到部署前的配置…' >&2
        /root/cms-restore.sh >&2 || true
        if [ -e /root/cms-bak/sites-enabled-default.symlink ]; then
            mv -f /root/cms-bak/sites-enabled-default.symlink /etc/nginx/sites-enabled/default
            echo '  已还原 Debian default 站点符号链接' >&2
        fi
        nginx -t && systemctl reload nginx
        echo '  已回滚：线上仍是改动前的配置，本次部署作废。' >&2
        exit 1
    fi
    systemctl reload nginx
    # ★ 2026-10-20 实跑撞到的坑：把「listen ${PORT};」改成「listen 127.0.0.1:${PORT};」
    #   这种改法**不能只 reload** —— 旧 worker 还占着 0.0.0.0:${PORT}，新配置 bind() 报
    #   Address already in use，nginx 保留旧配置继续服务，而 systemctl reload 仍回 0。
    #   判据只能看真实监听：还在对外地址上就是没换成功。配置已过 nginx -t，重启是安全的。
    if ss -ltn 2>/dev/null | awk '{print \$4}' | grep \":${PORT}\$\" \
        | grep -v '^127\\.0\\.0\\.1:' | grep -v '^\\[::1\\]:' | grep -q .; then
        echo '    ⚠ reload 没能换掉监听（旧 socket 占着对外地址）—— 改为重启 nginx' >&2
        systemctl restart nginx
    fi
    # 8080 收进回环后，防火墙侧那条放行规则必须撤掉 —— 留着它只会让人以为「8080 还对外」。
    # ufw delete 在规则不存在时会报错，而「不存在」正是我们想要的状态，所以吞掉。
    # ⚠️ 阿里云**安全组**里那条 8080 不归本脚本管（要你在控制台撤）；
    #    但就算忘了撤也没关系：nginx 不在对外地址上监听，包进来也是连接被拒。
    ufw delete allow ${PORT}/tcp >/dev/null 2>&1 || true
    # 域名入口走 80。ufw 默认不放行 80（此前 80 只有不可达的 Debian 欢迎页），
    # 不加这条的话 nginx 听得到、包却进不来 —— 现象正是「域名打不开」。
    # 收口之后 80 仍然必须对外：它是 ACME 续期的唯一通路，关了就等于给自己埋一颗定时炸弹。
    ufw allow 80/tcp comment 'ty0712.com 域名访问' >/dev/null
    # 443 分两层管：这条 ufw 负责把包放进机器，上面 3.7 生成的开关片段负责「证书在才监听」。
    # 证书还没签上时开关是空的，现象差别：外部打 443 是**连接被拒**（内核回 RST，毫秒级），
    # 而不是**超时**（ufw 丢包）—— 前者证明包进得来了，后者才是防火墙在挡。
    # ⚠️ 这段在 ssh 的双引号串里：注释里绝不写反引号，也别写 listen 加端口号那种字面量（T51/T58 会红）。
    ufw allow 443/tcp comment 'ty0712.com HTTPS' >/dev/null

    echo '  远端自测（站点已启用密码闸门）:'

    # —— 未登录：根路径按当前 landing 模式 —— learn 302→/learn/；game 302→/game ——
    # 模式从片段首行读（与 cms landing status 同一口径）：自测不能假设模式，
    # 否则运维切到 learn 后一次重部署就会被自己的断言拦下。
    mode=\$(head -n1 /etc/nginx/snippets/cms-landing-root.conf 2>/dev/null | sed -n 's/^# *landing-mode: *//p')
    code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/)
    body=\$(curl -s http://localhost:${PORT}/)
    printf '    %-32s HTTP %s（landing=%s）\n' '/ (未登录)' \"\$code\" \"\${mode:-（片段缺失）}\"
    loc=\$(curl -s -o /dev/null -w '%{redirect_url}' http://localhost:${PORT}/)
    if [ \"\$mode\" = 'learn' ]; then
        if [ \"\$code\" = '302' ] && printf '%s' \"\$loc\" | grep -q '/learn/'; then
            echo '    ✓ learn 模式：/ 302 到公开学习站'
        else
            echo \"    ✗ learn 模式下 / 应 302 → /learn/（实际 \${code} \${loc}）\" >&2
            exit 1
        fi
    else
        if [ \"\$code\" = '302' ] && printf '%s' \"\$loc\" | grep -q '/game'; then
            echo '    ✓ game 模式：/ 302 到 /game（游戏本身仍要登录）'
        else
            echo \"    ✗ game 模式下 / 应 302 → /game（实际 \${code} \${loc}）\" >&2
            exit 1
        fi
    fi
    if printf '%s' \"\$body\" | grep -q 'canvas id=\"board\"'; then
        echo '    ✗ 未登录的 / 响应里混进了游戏 DOM（说明闸门没生效）' >&2
        exit 1
    fi
    # —— 兜底路由：learn 404、game 302 → /game（两种模式唯一对外的差异）——
    ucode=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/cms-routing-probe)
    uloc=\$(curl -s -o /dev/null -w '%{redirect_url}' http://localhost:${PORT}/cms-routing-probe)
    printf '    %-32s HTTP %s -> %s\n' '/cms-routing-probe (未登录)' \"\$ucode\" \"\${uloc:-（无跳转）}\"
    if [ \"\$mode\" = 'learn' ]; then
        if [ \"\$ucode\" != '404' ]; then
            echo \"    ✗ learn 模式下未定义路径应 404（实际 \${ucode}）\" >&2
            exit 1
        fi
        echo '    ✓ learn 模式：未定义路径 404'
    else
        if [ \"\$ucode\" != '302' ] || ! printf '%s' \"\$uloc\" | grep -q '/game'; then
            echo \"    ✗ game 模式下未定义路径应 302 → /game（实际 \${ucode} \${uloc}）\" >&2
            exit 1
        fi
        echo '    ✓ game 模式：未定义路径 302 到 /game'
    fi

    # —— 总闸门状态决定「未登录」这组断言能不能用 ——
    # 「cms gate off」是运维主动打开总闸门的正常状态，那时所有人按设计放行；
    # 拿 404 去断言只会让一次重部署被自己的自测拦下来。
    gate_on=\$(curl -s http://127.0.0.1:8090/health | sed -n 's/.*\"require_password\": *\\(true\\|false\\).*/\\1/p')
    printf '    %-32s %s\n' '总闸门 require_password' \"\${gate_on:-（读不到）}\"
    if [ \"\$gate_on\" = 'false' ]; then
        echo '    ⚠ 总闸门关闭：跳过「未登录 404」这组断言，改验 /game 直出游戏页'
        gcode=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/game)
        gbody=\$(curl -s http://localhost:${PORT}/game)
        printf '    %-32s HTTP %s\n' '/game (总闸门关闭)' \"\$gcode\"
        if [ \"\$gcode\" = '200' ] && printf '%s' \"\$gbody\" | grep -q 'canvas id=\"board\"'; then
            echo '    ✓ 总闸门关闭时 /game 直出游戏页（与 gate off 的语义一致）'
        else
            echo \"    ✗ 总闸门关闭但 /game 不是游戏页（\${gcode}）—— 路由或 try_files 坏了\" >&2
            exit 1
        fi
    else
    # —— 未登录：游戏相关 URL 必须 404（当作不存在）——
    # 401/200 都不行：200 是泄漏，401 等于承认「这里有受保护的东西」。
    # 旧的公开前缀 /gate/ 不在这一组：它现在跟着兜底走（learn 404 / game 302 → /game），
    # 单独验。真正的登录入口是下面那条随机路径 /gate/<TOKEN>/。
    # /assets/bg.* 是未授权商用素材，收进闸门后匿名必须 404（旧的公开块已删）。
    for p in /game /index.html /dist/main.js /dist/renderer.js /dist/wasm_stub.js /style.css /gate/gate.css /gate/gate.js /assets/bg.webp /assets/bg.jpg /dist/fx.js; do
        code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}\$p)
        printf '    %-32s HTTP %s\n' \"\$p (未登录)\" \"\$code\"
        if [ \"\$code\" != '404' ]; then
            echo \"    ✗ \$p 未登录却返回 \${code}（应为 404）—— 闸门有缺口或在承认存在\" >&2
            exit 1
        fi
    done
    fi

    # —— 旧的 /gate/ 前缀：不再是一个入口。learn 404；game 跟兜底 302 → /game ——
    pcode=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}/gate/)
    printf '    %-32s HTTP %s\n' '/gate/ (旧前缀，未登录)' \"\$pcode\"
    if [ \"\$mode\" = 'learn' ] && [ \"\$pcode\" != '404' ]; then
        echo \"    ✗ learn 模式下 /gate/ 应 404（实际 \${pcode}）\" >&2
        exit 1
    elif [ \"\$mode\" != 'learn' ] && [ \"\$pcode\" != '302' ]; then
        echo \"    ✗ game 模式下 /gate/ 应跟兜底 302 → /game（实际 \${pcode}）\" >&2
        exit 1
    fi

    # —— 秘密登录入口必须活着（404 化之后唯一能登录的地方）——
    # token 从服务器片段首行读（与 cms gate-path status 同一口径），
    # 绝不在脚本里写死：入口是随机的、可轮换的，写死等于把秘密印进 git。
    TOK=\$(head -n1 /etc/nginx/snippets/cms-gate-path.conf 2>/dev/null | sed -n 's/^# *gate-token: *//p')
    if ! printf '%s' \"\$TOK\" | grep -Eq '^[a-z0-9]{12,32}\$'; then
        echo '    ✗ 读不到合法的登录入口 token（片段缺失或首行标记坏了）' >&2
        echo '      —— 现在没有人能登录。修它：cms gate-path rotate' >&2
        exit 1
    fi

    # ★ 2026-10-25：token 一律不进 curl 的 argv（/proc/<pid>/cmdline 本机所有账户可读）。
    #   URL 经 stdin 交给 curl（-K - 读配置）。token 仍出现在**请求 URI** 里，
    #   下面的日志增量断言（count_tok_hits）不受影响 —— 测的是日志管道，不是 argv。
    tcurl() {
        u=\$1; shift
        printf 'url = \"%s\"\n' \"\$u\" | curl -s -K - \"\$@\"
    }

    # ★ 2026-10-22：token 只关 access_log 是半个修复 —— error_log 不受它影响，
    #   limit_req 的 429 与「文件不存在」的 open() 失败都以 error 级写入完整 URI。
    #   所以整段自测前后各数一次「所有 nginx 日志里的 token」，增量不为 0 就红：
    #   哪条管道漏了都当场暴露，不再依赖人记得该查哪个文件。
    #   用增量而不是「必须为 0」：修之前留下的历史行还在文件里。
    count_tok_hits() {
        { grep -h -c -F \"\$TOK\" /var/log/nginx/access.log /var/log/nginx/error.log 2>/dev/null || true
          for f in /var/log/nginx/access.log.[0-9]* /var/log/nginx/error.log.[0-9]*; do
              case \"\$f\" in
                  *.gz) zgrep -c -F \"\$TOK\" \"\$f\" 2>/dev/null || true ;;
                  *)    grep -c -F \"\$TOK\" \"\$f\" 2>/dev/null || true ;;
              esac
          done
        } | awk '{s+=\$1} END {print s+0}'
    }
    n_log_before=\$(count_tok_hits)

    gcode=\$(tcurl \"http://localhost:${PORT}/gate/\$TOK/\" -o /dev/null -w '%{http_code}')
    gbody=\$(tcurl \"http://localhost:${PORT}/gate/\$TOK/\")
    printf '    %-32s HTTP %s\n' \"/gate/<TOKEN>/ (登录入口)\" \"\$gcode\"
    if [ \"\$gate_on\" = 'false' ]; then
        # 总闸门关闭：入口对所有人都是「已登录」，应直接 302 → /game。
        gloc=\$(tcurl \"http://localhost:${PORT}/gate/\$TOK/\" -o /dev/null -w '%{redirect_url}')
        if [ \"\$gcode\" = '302' ] && printf '%s' \"\$gloc\" | grep -q '/game'; then
            echo '    ✓ 总闸门关闭时入口直接 302 到 /game'
        else
            echo \"    ✗ 总闸门关闭时入口应 302 → /game（实际 \${gcode} \${gloc}）\" >&2
            exit 1
        fi
    elif [ \"\$gcode\" = '200' ] && printf '%s' \"\$gbody\" | grep -q 'gate-form'; then
        echo '    ✓ 秘密登录入口可达，页面是登录表单'
    else
        echo \"    ✗ /gate/\$TOK/ 不是可用的登录页（\${gcode}）—— 片段与磁盘目录没对上？\" >&2
        echo '      若刚改过 authd（新增 /entry）：先跑 scripts/web/deploy-gate.sh，再来部署网关；' >&2
        echo '      线上还是旧 authd 时，入口那条 proxy_pass 会拿到 404。' >&2
        exit 1
    fi
    # 入口的「已登录」分支没有密码就拿不到会话，只能按配置形状验：
    # 守卫必须挂 auth_request（未登录 → error_page 送密码页）、并把放行的请求代理到
    # authd 的 /entry（回 302 /game）。缺任一条，已登录的人会一直困在密码页。
    if grep -q 'auth_request /__auth;' /etc/nginx/snippets/cms-gate-path.conf \
       && grep -q 'proxy_pass http://127.0.0.1:8090/entry;' /etc/nginx/snippets/cms-gate-path.conf \
       && grep -q \"error_page 401 403 500 502 504 = /gate/\$TOK/index.html;\" /etc/nginx/snippets/cms-gate-path.conf; then
        echo '    ✓ 入口守卫齐全：未登录 → 密码页，已登录 → authd /entry（302 /game）'
    else
        echo '    ✗ 入口守卫缺 auth_request 或 /entry 代理 —— 已登录访客会一直看到密码页' >&2
        exit 1
    fi

    # —— 80 明文收口：除 ACME 挑战外一律 302 到 https；秘密入口在明文上不留痕 ——
    # 这里是从服务器本地打 127.0.0.1:80 并手挂 Host，验的是 nginx 的路由，
    # 不包含「阿里云安全组 + 备案接入」这一段（那要在外面看，见 docs/密码闸门.md）。
    for p in / /index.html /style.css /learn/; do
        rcode=\$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: ${DOMAIN}' http://127.0.0.1\$p)
        rloc=\$(curl -s -o /dev/null -w '%{redirect_url}' -H 'Host: ${DOMAIN}' http://127.0.0.1\$p)
        printf '    %-30s HTTP %s -> %s\n' \"80 \$p (域名 Host)\" \"\$rcode\" \"\${rloc:-（无跳转）}\"
        if [ \"\$rcode\" != '302' ] || [ \"\$rloc\" != \"https://${DOMAIN}\$p\" ]; then
            echo \"    ✗ 80 上 \$p 应 302 到 https://${DOMAIN}\${p}（实际 \${rcode} \${rloc}）\" >&2
            echo '      —— 要么明文还在 serving 内容，要么跳转目标吃的是客户端可控的 Host 头' >&2
            exit 1
        fi
    done
    # 秘密登录入口在明文侧必须 404，而且响应头里**不许出现 token**：
    # 拿 302 把它送去 https 等于在没加密的链路上广播唯一的登录凭据。
    # ★ 这一击本身就是「token 会不会落进日志」的实测：URI 里带着 token，块一的
    #   location 若没关日志，打一次就多一行全文凭据（640 www-data:adm、rotate 14）。
    #   总账放在自测末尾统一比对（count_tok_hits：access + error、含 .1/.gz）。
    h80=\$(tcurl \"http://127.0.0.1/gate/\$TOK/\" -D- -o /dev/null -H 'Host: ${DOMAIN}')
    first=\$(printf '%s' \"\$h80\" | head -1 | tr -d '\\r')
    printf '    %-32s %s\n' '80 /gate/<TOKEN>/ (明文)' \"\$first\"
    if ! printf '%s' \"\$first\" | grep -q ' 404'; then
        echo '    ✗ 明文 80 上的秘密入口不是 404 —— 跳转块被改动过，token 正在明文上可达' >&2
        exit 1
    fi
    if printf '%s' \"\$h80\" | grep -q \"\$TOK\"; then
        echo '    ✗ 明文 80 的响应头里出现了登录 token —— 唯一凭据正在明文广播' >&2
        exit 1
    fi
    # —— HSTS 的配置层判据（端到端在下面的 443 分支里，那儿才(curl)得出真发没发）——
    # 2026-10-21 用户点头开了。头写在共用片段里、取值来自站点文件里的 map：两处缺任何
    # 一处都不报错，只是**静默**不发（片段缺了 = 哪儿都不发；map 缺了 = 引用未定义变量，
    # nginx -t 当场失败）。所以这两条要一起查，缺了就判红而不是放行。
    if ! grep -q 'add_header Strict-Transport-Security \$cms_hsts' /etc/nginx/snippets/cms-security-headers.conf; then
        echo '    ✗ 安全头片段里没有 HSTS 那行（2026-10-21 已获授权开启，别把它改回去）' >&2
        exit 1
    fi
    if ! grep -q 'map \$scheme \$cms_hsts' /etc/nginx/sites-available/complexminesweeper; then
        echo '    ✗ 站点文件里没有 \$cms_hsts 那个 map —— 片段的头引用了一个不存在的变量' >&2
        exit 1
    fi
    # 内测端口只许待在回环：绑到 0.0.0.0 或 [::] 就是留了一条永远明文的对外入口。
    stray_bind=\$(ss -ltn 2>/dev/null | awk '{print \$4}' | grep \":${PORT}\$\" | grep -v '^127\\.0\\.0\\.1:' | grep -v '^\\[::1\\]:' || true)
    printf '    %-32s %s\n' '${PORT} 的非回环监听' \"\${stray_bind:-（无，已收回环）}\"
    if [ -n \"\$stray_bind\" ]; then
        echo \"    ✗ ${PORT} 还绑在非回环地址上：\${stray_bind} —— 明文入口没收回环\" >&2
        exit 1
    fi
    if ! ss -ltn 2>/dev/null | grep -q \"127.0.0.1:${PORT}\"; then
        echo \"    ✗ 回环上没有 ${PORT} 监听 —— 探活第 4/6 项和本段自测的基准全断，SSH 隧道也连不上\" >&2
        exit 1
    fi
    # 没人认领的 Host（这里是 curl 默认的 localhost）应落到本站的跳转块，而不是 Debian 欢迎页
    stray=\$(curl -s http://127.0.0.1/)
    if printf '%s' \"\$stray\" | grep -qiF 'Welcome to Debian'; then
        echo '    ✗ 80 上未匹配的 Host 仍回 Debian 欢迎页：sites-enabled/default 没移走？' >&2
        exit 1
    fi
    echo '    ✓ 80 只剩「跳转 + ACME 挑战」，内测端口已收回环，未匹配 Host 不再吐 Debian 欢迎页'

    # —— ACME 挑战路径必须**真的公开可达**（这是签证书的前提，不是装饰）——
    # 造一个一次性令牌文件，从 80 打它：期望 200 且正文对得上。
    # 这里若是 404，说明那条 ^~ 没压过带 auth_request 的正则 —— acme.sh 必然签不下来。
    PROBE=\$(openssl rand -hex 8)
    printf 'cms-deploy-probe' > /var/www/acme/.well-known/acme-challenge/\$PROBE
    chown www-data:www-data /var/www/acme/.well-known/acme-challenge/\$PROBE
    acode=\$(curl -s -o /tmp/cms-acme.out -w '%{http_code}' http://127.0.0.1/.well-known/acme-challenge/\$PROBE)
    abody=\$(cat /tmp/cms-acme.out); rm -f /tmp/cms-acme.out /var/www/acme/.well-known/acme-challenge/\$PROBE
    printf '    %-32s HTTP %s\n' '/.well-known/acme-challenge/<probe>' \"\$acode\"
    if [ \"\$acode\" != '200' ] || [ \"\$abody\" != 'cms-deploy-probe' ]; then
        echo \"    ✗ ACME 挑战路径拿不到文件（\${acode}，正文 \${abody}）—— http-01 会失败，证书签不下来\" >&2
        exit 1
    fi
    echo '    ✓ ACME 挑战路径公开可达，nginx 读得到 webroot'

    # —— 443：证书在才验（不在就没人监听，属预期，不是失败）——
    # 这里**不带 -k**：验不过就是证书链有问题，宁可部署失败也别留一个「能连但不安全」的 443。
    # 收口之后 80 只做跳转，所以这里只跟回环那个口比码数，不再跟 80 比。
    if [ -f ${SSL_PEM} ]; then
        for p in / /index.html /gate/\$TOK/; do
            hcode=\$(tcurl \"https://${DOMAIN}\$p\" --resolve ${DOMAIN}:443:127.0.0.1 -o /dev/null -w '%{http_code}')
            pcode=\$(tcurl \"http://localhost:${PORT}\$p\" -o /dev/null -w '%{http_code}')
            printf '    %-32s HTTP %s（回环 ${PORT} 为 %s）\n' \"443 \${p//\$TOK/<TOKEN>}\" \"\$hcode\" \"\$pcode\"
            if [ \"\$hcode\" != \"\$pcode\" ]; then
                echo \"    ✗ 443 与 ${PORT} 对 \${p//\$TOK/<TOKEN>} 不一致 —— 开关片段只挂上一个口，或闸门在 443 上漏了\" >&2
                exit 1
            fi
        done
        if [ \"\$gate_on\" = 'false' ]; then
            # 总闸门关闭：入口 302 → /game，跟随跳转后应当拿到游戏页。
            if ! tcurl \"https://${DOMAIN}/gate/\$TOK/\" -L --resolve ${DOMAIN}:443:127.0.0.1 | grep -q 'canvas id=\"board\"'; then
                echo '    ✗ 443 上总闸门关闭时入口没把人送到游戏页' >&2
                exit 1
            fi
        elif ! tcurl \"https://${DOMAIN}/gate/\$TOK/\" --resolve ${DOMAIN}:443:127.0.0.1 | grep -q 'gate-form'; then
            echo '    ✗ 443 上 /gate/<TOKEN>/ 不是登录表单' >&2
            exit 1
        fi

        # —— Secure cookie 端到端验证（用 /__logout 当探针：它不要密码也回一条 Set-Cookie）——
        # 这条断言验的不只是 authd 的属性拼接，还有 nginx 的 X-Forwarded-Proto 有没有真送到。
        sec=\$(curl -s -D- -o /dev/null -X POST --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/__logout | grep -i '^set-cookie:' | tr -d '\\r')
        printf '    %-32s %s\n' '443 下发的 cookie' \"\${sec:-（没有 Set-Cookie）}\"
        if ! printf '%s' \"\$sec\" | grep -qi 'Secure'; then
            echo '    ✗ 443 的 cookie 没带 Secure —— scheme 判据或 proxy_set_header 断了' >&2
            exit 1
        fi
        # 回环那侧反过来：它在 http 上，**必须**不发 Secure。
        # 发了浏览器会整条丢弃（非 secure 请求不接受 Secure cookie），
        # 现象是隧道里登不掉、也退不出，而且一句报错都没有。
        plain=\$(curl -s -D- -o /dev/null -X POST http://127.0.0.1:${PORT}/__logout | grep -i '^set-cookie:' | tr -d '\\r')
        printf '    %-32s %s\n' \"${PORT} 下发的 cookie\" \"\${plain:-（没有 Set-Cookie）}\"
        if printf '%s' \"\$plain\" | grep -qi 'Secure'; then
            echo \"    ✗ ${PORT}（明文回环）也发了 Secure cookie —— 隧道里的登出会静默失败\" >&2
            exit 1
        fi

        # —— HSTS 端到端（2026-10-21 获授权）：443 必须发、明文两条口子必须不发 ——
        # 「配置里有那行」不等于「头出去了」：片段没 include 到、map 变量名打错、
        # 或某个 location 自己写了 add_header 把父块的覆盖掉，现象都是配了却静默不发。
        hsts443=\$(curl -s -D- -o /dev/null --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/ | grep -i '^strict-transport-security:' | tr -d '\\r')
        printf '    %-32s %s\n' '443 的 HSTS' \"\${hsts443:-（没有这个头）}\"
        if ! printf '%s' \"\$hsts443\" | grep -q 'max-age=15552000'; then
            echo '    ✗ 443 没发出 HSTS（或 max-age 不是 15552000）—— 配了没生效，查 include 与 map' >&2
            exit 1
        fi
        # 反向：明文那两侧（80 的 302、内测端口的隧道）一律不许带这个头。
        # 浏览器本来就会忽略明文收到的那份，所以这查的不是「会不会出事」，
        # 而是这份配置有没有说谎：明文也发 = map 没起作用（多半是被写成了字面量）。
        hsts_plain=\$(curl -s -D- -o /dev/null -H 'Host: ${DOMAIN}' http://127.0.0.1/ | grep -ci '^strict-transport-security:' || true)
        hsts_loop=\$(curl -s -D- -o /dev/null http://localhost:${PORT}/ | grep -ci '^strict-transport-security:' || true)
        printf '    %-32s 80=%s ${PORT}=%s\n' '明文侧的 HSTS 行数（都得是 0）' \"\$hsts_plain\" \"\$hsts_loop\"
        if [ \"\$hsts_plain\" != '0' ] || [ \"\$hsts_loop\" != '0' ]; then
            echo '    ✗ 明文响应也发了 HSTS —— \$cms_hsts 那个 map 没生效（八成写成了字面量）' >&2
            exit 1
        fi

        # 443 上的挑战路径也必须取得到文件：80 现在除了这条一律 302，LE 跟随跳转后落在 443。
        # 缺了它平时毫无症状，90 天后证书到期才表现为「全站打不开」，所以当场造探针。
        printf 'cms-deploy-probe' > /var/www/acme/.well-known/acme-challenge/p443
        chown www-data:www-data /var/www/acme/.well-known/acme-challenge/p443
        b443=\$(curl -s --resolve ${DOMAIN}:443:127.0.0.1 https://${DOMAIN}/.well-known/acme-challenge/p443)
        rm -f /var/www/acme/.well-known/acme-challenge/p443
        printf '    %-32s %s\n' '443 取挑战文件' \"\${b443:-（取不到）}\"
        if [ \"\$b443\" != 'cms-deploy-probe' ]; then
            echo '    ✗ 443 取不到挑战文件 —— LE 跟完跳转落空，证书续不上（那条 ^~ 得在内容块里）' >&2
            exit 1
        fi

        end=\$(openssl x509 -noout -enddate -in ${SSL_PEM} | cut -d= -f2)
        left=\$(( ( \$(date -d \"\$end\" +%s) - \$(date +%s) ) / 86400 ))
        printf '    证书到期 %s（剩 %s 天）\n' \"\$end\" \"\$left\"
        if [ \"\$left\" -lt 21 ]; then
            echo '    ⚠ 剩余不足 21 天：acme.sh 的自动续期大概没生效，查 crontab -l 与 /root/.acme.sh/cron.log' >&2
        fi
        echo '    ✓ 443 与回环同语义、cookie 按 scheme 加 Secure、HSTS 只在 https 发、挑战在 443 也取到、证书链当场验过（未加 -k）'
    else
        echo '    ○ 证书未就位 —— 443 开关是空的，本次只验了 ACME 路径（跑 scripts/web/deploy-https.sh 签一张）'
        echo '    ✗ 但 80 已经在往 https 跳转了：没有证书 = 没有人监听 443 = 域名整站打不开' >&2
        echo '      （这不是自测挑刺，是收口换来的硬依赖。要么先把证书签上，要么把 80 那块临时改回内容块）' >&2
        exit 1
    fi

    # 入口自带的两个文件也必须公开可达（^~ 没压过 auth_request 正则就会 404 → 登录页裸奔）
    for p in /gate/\$TOK/gate.css /gate/\$TOK/gate.js; do
        code=\$(tcurl \"http://localhost:${PORT}\$p\" -o /dev/null -w '%{http_code}')
        printf '    %-32s HTTP %s\n' \"\${p//\$TOK/<TOKEN>}\" \"\$code\"
        if [ \"\$code\" != '200' ]; then
            echo \"    ✗ 登录页资源 \${p//\$TOK/<TOKEN>} 返回 \${code}（应为 200）—— 检查秘密入口的 ^~ 前缀\" >&2
            exit 1
        fi
    done

    # —— 公开路径必须可达：整站对外只剩两个字体（学习站在下面单独验）——
    for p in /assets/ibmplex-ascii.woff2 /assets/IBMPlexSerif-Regular.ttf; do
        code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}\$p)
        printf '    %-32s HTTP %s\n' \"\$p\" \"\$code\"
        if [ \"\$code\" != '200' ]; then
            echo \"    ✗ 公开路径 \$p 返回 \${code}（应为 200）\" >&2
            exit 1
        fi
    done

    # —— 学习站必须公开可达（监管要看的真实内容，未登录也要 200）——
    # /learn/app.js 专门验：它命中 .js 后缀，若「^~ /learn/」没压过受保护正则就会 404。
    # ⚠ 本段在本地**双引号** SSH 串里：反引号会被本地 bash 当命令替换执行，
    #   踩过（写成反引号包住 ^~ /learn/ → 部署时报「^~: command not found」）。
    #   要强调一律用「」，别用反引号。见 test_gate_ui.py 的 T51。
    for p in /learn/ /learn/app.js /learn/manifest.js; do
        code=\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:${PORT}\$p)
        printf '    %-32s HTTP %s\n' \"\$p (未登录)\" \"\$code\"
        if [ \"\$code\" != '200' ]; then
            echo \"    ✗ 学习站 \$p 未登录返回 \${code}（应为 200）—— 检查 ^~ /learn/\" >&2
            exit 1
        fi
    done
    learnbody=\$(curl -s http://localhost:${PORT}/learn/)
    if printf '%s' \"\$learnbody\" | grep -q 'canvas id=\"board\"'; then
        echo '    ✗ /learn/ 里混进了游戏 DOM（try_files 回退到 /index.html 了？）' >&2
        exit 1
    fi
    echo '    ✓ 学习站公开可达且不含游戏 DOM'

    # —— 鉴权服务可达（否则谁都登不进去）——
    if curl -s -o /dev/null -f http://127.0.0.1:8090/health; then
        echo '    ✓ 鉴权服务 /health 正常'
    else
        echo '    ✗ 鉴权服务 127.0.0.1:8090/health 不通 —— 先跑 deploy-gate.sh' >&2
        exit 1
    fi

    echo '  gzip 生效性检查（用登录页的 gate.css 验，静态站级配置）:'
    RAW=\$(tcurl \"http://localhost:${PORT}/gate/\$TOK/gate.css\" -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: identity')
    GZ=\$(tcurl \"http://localhost:${PORT}/gate/\$TOK/gate.css\" -o /dev/null -w '%{size_download}' -H 'Accept-Encoding: gzip')
    if [ \"\$GZ\" -lt \"\$RAW\" ]; then
        echo \"    ✓ gate.css 未压缩 \$RAW B → gzip \$GZ B\"
    else
        echo \"    ✗ gzip 未生效！gate.css 仍是 \$RAW B —— 检查 gzip 配置\" >&2
        exit 1
    fi

    echo '  安全头检查（入口公开路径 / 受保护路径 都要有 CSP）:'
    for p in /gate/\$TOK/gate.css /dist/main.js; do
        n=\$(tcurl \"http://localhost:${PORT}\$p\" -I | grep -ci 'content-security-policy')
        printf '    %-32s CSP 头 %s 个\n' \"\${p//\$TOK/<TOKEN>}\" \"\$n\"
        if [ \"\$n\" -lt 1 ]; then
            echo \"    ✗ \${p//\$TOK/<TOKEN>} 缺 CSP 头（add_header 覆盖问题？）\" >&2; exit 1
        fi
    done

    # —— 缓存头：受保护资源绝不能被浏览器缓存复用，否则整站闸门会被绕过 ——
    # 2026-10-16 事故：dist/*.js 命中了带 expires 7d 的**正则** location，
    # 浏览器 7 天不发请求；游戏 HTML 也没有 Cache-Control，按启发式新鲜度直接复用
    # → 地址栏输网址就能不登录进游戏，只有 F5 才会弹密码页。
    # 这里在**未登录的 404** 上断言（add_header ... always 对错误响应同样生效，
    # 与上面 CSP 检查同一个原理），不需要密码就能守住这条不变量。
    echo '  缓存头检查（受保护响应必须每次回源，不许被缓存复用）:'
    for p in /dist/main.js /style.css /gate/\$TOK/gate.css; do
        cc=\$(tcurl \"http://localhost:${PORT}\$p\" -I | grep -i '^cache-control:' | tr -d '\\r' || true)
        printf '    %-32s %s\n' \"\${p//\$TOK/<TOKEN>}\" \"\${cc:-（无 Cache-Control）}\"
        case \"\$cc\" in
          *no-cache*|*no-store*) : ;;
          *) echo \"    ✗ \${p//\$TOK/<TOKEN>} 的 Cache-Control 不能缓存复用（现在：\${cc:-无}）\" >&2
             echo '      —— 浏览器会跳过 auth_request，闸门形同不存在' >&2
             exit 1 ;;
        esac
    done
    # 兜底：配置里凡挂了 auth_request 的 location 都不许出现 expires。
    # 状态在「下一行 location」或「块结束的右花括号」处复位。
    # 注意：awk 程序里不要写字面量美元符号，也别用反引号——整段是在 ssh 的
    # 双引号字符串里，会被**本地** shell 先展开（注释里也一样会展开！）。
    bad=\$(awk '
        /^[ \\t]*#/        { next }
        /^[ \\t]*location/ { auth = 0 }
        /^[ \\t]*}/        { auth = 0 }
        /auth_request/     { auth = 1 }
        auth && /expires/  { bad++ }
        END { print bad + 0 }
    ' /etc/nginx/sites-available/complexminesweeper)
    if [ \"\$bad\" != '0' ]; then
        echo \"    ✗ 有 \$bad 处「带 auth_request 又带 expires」的 location —— 必须去掉 expires\" >&2
        echo '      —— 否则浏览器会缓存受保护资源、绕过 auth_request' >&2
        exit 1
    fi
    echo '    ✓ 受保护 location 均无 expires'

    echo '  限流生效性检查（连打 /style.css 80 次，应出现 429）:'
    # 目标必须是 /style.css 而不是 /：learn 模式下 location = / 的 return 302 在 rewrite 阶段，
    # 早于 limit_req 的 preaccess 阶段，连打只会看到 302、永远看不到 429（假绿灯）。
    # /style.css 命中带 auth_request 的正则 location，preaccess 的 limit_req 先跑，
    # learn/game 两种模式都会出现 429。rate=20r/s burst=40，80 次瞬发约 39 次触顶。
    # 注意不能写成 \$(for ... done | sort | uniq -c) 单独成行 —— 命令替换出现在「命令位置」时
    # bash 会把输出当命令再执行一次（会报 "42: command not found"）。这里赋值给变量则安全。
    # 计数刻意用「空格分隔 + tr 还原」而不是依赖 curl 的 \\n：
    # 实测这份字符串过一遍本地双引号 + ssh 之后，远端拿到的换行会塌成空格，
    # 于是 sort|uniq -c 把 80 个状态码当**一行**、n429 恒为 0 → 部署在上传全部完成
    # 之后红着退出（假红灯，比漏检更难查，因为它挂在最后一步）。
    codes=\$(for i in \$(seq 1 80); do curl -s -o /dev/null -w '%{http_code} ' http://localhost:${PORT}/style.css; done)
    echo \"    分布：\$codes\"
    n429=\$(printf '%s' \"\$codes\" | tr ' ' '\\n' | grep -c '^429\$' || true)
    n404=\$(printf '%s' \"\$codes\" | tr ' ' '\\n' | grep -c '^404\$' || true)
    if [ \"\$n429\" -eq 0 ]; then
        echo '    ✗ 连打 80 次 /style.css 未出现 429 —— limit_req 未生效（假绿灯）' >&2
        exit 1
    fi
    echo \"    ✓ 出现 \${n429} 次 429（另有 \${n404} 次 404），限流生效\"

    # —— token 泄漏总闸：到这里所有探针（8080 上的入口请求、80 的那一击、443 分支）都跑完了 ——
    n_log_after=\$(count_tok_hits)
    printf '    %-32s 本次自测新增 %s 行含 token\n' '全部 nginx 日志（access+error）' \"\$((n_log_after - n_log_before))\"
    if [ \"\$((n_log_after - n_log_before))\" != '0' ]; then
        echo '    ✗ token 落进了 nginx 日志 —— 对应 location 缺 access_log off 或 error_log' >&2
        echo '      （历史行不算账，只算这次自测期间新增的行）' >&2
        exit 1
    fi
"

# 5) 文件一致性校验
#    index.html 与 dist/* 上传的是 $STAGE 里的改写副本（带 ?v=BUILD），
#    所以本地要比对的也是 $STAGE 版本，而不是 web/ 源码；其余文件仍比 web/。
echo "==> 校验和比对"
for f in index.html style.css dist/main.js dist/game.js dist/renderer.js \
         dist/seedcodec.js dist/wasm_stub.js dist/fx.js \
         gate/index.html gate/gate.css gate/gate.js \
         assets/bg.webp assets/ibmplex-ascii.woff2 assets/bg.jpg assets/IBMPlexSerif-Regular.ttf \
         learn/index.html learn/style.css learn/manifest.js \
         learn/highlight.js learn/search.js learn/app.js; do
    case "$f" in
        index.html|dist/*) LP="$STAGE/$f" ;;
        *)                 LP="$WEB_DIR/$f" ;;
    esac
    L=$(shasum -a 256 "$LP" | cut -c1-16)
    R=$($SSH "$SERVER" "sha256sum '$REMOTE_DIR/$f'" | cut -c1-16)
    [ "$L" = "$R" ] && echo "  ✓ $f" || { echo "  ✗ $f 不一致"; exit 1; }
done
# 内容页较多（16 篇），逐个比校验和太啰嗦；比对「篇数 + 全部页拼起来的哈希」即可抓住漏传/传残。
LPAGES=$(cat "$WEB_DIR"/learn/pages/*.js | shasum -a 256 | cut -c1-16)
RPAGES=$($SSH "$SERVER" "cat '$REMOTE_DIR'/learn/pages/*.js | sha256sum" | cut -c1-16)
[ "$LPAGES" = "$RPAGES" ] && echo "  ✓ learn/pages/*.js（$(ls "$WEB_DIR"/learn/pages/*.js | wc -l | tr -d ' ') 篇拼接哈希一致）" \
    || { echo "  ✗ learn/pages 拼接哈希不一致（漏传或传残）"; exit 1; }

echo ""
echo "==> 部署完成。对外只有一个地址：https://${DOMAIN}/     （http 会被 302 送到这里）"
echo "    自己人用的口子只在服务器内部：http://127.0.0.1:${PORT}/"
echo "    要从本机用，开一条 SSH 隧道：ssh -p ${SSH_PORT} -L 18080:127.0.0.1:${PORT} ${SERVER}  然后开 http://127.0.0.1:18080/"
echo "    别人手里旧的 http://<IP>:${PORT}/ 内测地址已失效（收回环了），给人家请给 https 那条 + 秘密入口。"
echo "    若 ${DOMAIN} 打不开，按这个顺序查：① 阿里云安全组 ${DOMAIN} 所在实例的 443/tcp（还有 80/tcp，续期要用）；"
echo "    ② 备案接入状态（阿里云对未接入备案的域名会在 80/443 上做拦截）；③ 服务器 ufw 443/tcp（本脚本已 allow）；"
echo "    ④ 证书还在不在：${SSL_PEM} —— 收口之后没有证书就没有任何对外内容入口，443 那块是开关式的。"
echo "    ⑤ DNS：dig A ${DOMAIN} 是否指向本机公网 IP。判断方法：外网 nc -z 不通、服务器上 curl 正常 = ①②③。"
echo "    登录入口不再是 /gate/（对未登录者 404）：查当前秘密网址 —— cms gate-path status"
