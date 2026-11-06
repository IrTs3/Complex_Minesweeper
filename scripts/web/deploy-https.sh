#!/usr/bin/env bash
# 给 ty0712.com 签一张 Let's Encrypt 证书并装到 nginx 读得到的位置（一次性，可重跑）。
#
# 顺序很关键（这一步之前之后都要跑 deploy-web.sh）：
#   ① bash scripts/web/deploy-web.sh      # 把 /.well-known/acme-challenge/ 放开（http-01 的前提）
#   ② bash scripts/web/deploy-https.sh    # **本脚本**：装 acme.sh → staging 试签 → 正式签 → 装到 /etc/nginx/ssl
#   ③ bash scripts/web/deploy-web.sh      # 开关片段发现证书就位，这才写出 443 监听并 reload
#   本脚本自己不碰 nginx 配置：配置权 100% 留在 deploy-web.sh（原因见下条）。
#
# 为什么用 acme.sh 而不是 certbot --nginx：
#   --nginx 安装器会**改写** sites-available 里那个文件，而它每次部署都被 deploy-web.sh
#   整份重新生成 —— 两边互相覆盖，早晚把证书路径冲掉。webroot 方式则完全不碰配置。
#
# 为什么是 git clone 而不是官网上那句「curl 一把灌进 shell 执行」：
#   2026-10-20 实测：服务器上 raw.githubusercontent.com 被连接重置、cdn.jsdelivr.net 也不通，
#   但 github.com 本身可达（HTTP 200 / 0.69s）—— 所以只能 clone，且**钉 tag**（v3.1.6），
#   顺手把 commit sha 打进输出留证。这条坑与「本机有没有开代理」无关：服务器上没有任何 proxy 环境变量。
#
# 用法（LE 从 2025 年起要求账户邮箱，只走环境变量或交互输入，绝不写进仓库）：
#   ACME_EMAIL='you@example.com' bash scripts/web/deploy-https.sh
#   bash scripts/web/deploy-https.sh            # 不给就现场问
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
DOMAIN="${DOMAIN:-ty0712.com}"
ACME_TAG="${ACME_TAG:-v3.1.6}"
# 字符白名单：这个值会**不加引号**地拼进远端 SSH 命令（第 2 步 git clone --branch），
# 放行引号/反引号/$/空白等于在 root 远端执行任意命令。git tag 实际只用得到这些字符。
case "${ACME_TAG}" in
    ''|*[!A-Za-z0-9._+-]*) echo "✗ ACME_TAG 出现不该有的字符（只允许字母数字与 . _ + -）" >&2; exit 1 ;;
esac
ACME_SRC=/root/acme.sh-src
ACME_HOME=/root/.acme.sh
WEBROOT=/var/www/acme                # 必须与 deploy-web.sh 里那条 location 的 root 一致
SSL_DIR=/etc/nginx/ssl
PEM=${SSL_DIR}/${DOMAIN}.pem
KEY=${SSL_DIR}/${DOMAIN}.key
LE_STAGING=https://acme-staging-v02.api.letsencrypt.org/directory
LE_PROD=https://acme-v02.api.letsencrypt.org/directory   # 必须显式写：见 3) 那段

SSH="ssh -p ${SSH_PORT} -o BatchMode=yes -o ConnectTimeout=10"

# ---- 0) 账户邮箱（LE 要求；不是密钥，但也不该躺在 git 里）----
if [ -z "${ACME_EMAIL:-}" ]; then
    printf 'Let'\''s Encrypt 账户邮箱（用于到期告警，绝不写入仓库）：' >&2
    read -r ACME_EMAIL || { echo "✗ 没读到邮箱" >&2; exit 1; }
fi
case "${ACME_EMAIL}" in
    *[[:space:]]*|'') echo "✗ 邮箱为空或含空白字符" >&2; exit 1 ;;
esac
# 字符白名单：这个值稍后会被拼进一段**双引号**的远端 SSH 命令（见第 2 步 --accountemail），
# 放行引号/反引号/$ 就等于让邮箱字段执行远端 shell。邮箱本来只用得到这些字符。
case "${ACME_EMAIL}" in
    *[!A-Za-z0-9._%+@-]*) echo "✗ 邮箱里出现不该有的字符（只允许字母数字与 . _ % + @ -）" >&2; exit 1 ;;
esac
# 形状只做最小校验（有 @、@ 后面还有个点）。用 grep -E 而不是 \| 扩展写法，BusyBox/toybox 上才不哑。
if ! printf '%s' "${ACME_EMAIL}" | grep -Eq '[^@ ]+@[^.@]+\.[^@ ]+'; then
    echo "✗ 邮箱形状不对（要形如 name@host.tld）" >&2; exit 1
fi
echo "==> 目标：${SERVER}，域名 ${DOMAIN}，acme.sh 钉在 ${ACME_TAG}，账户邮箱已提供（不打印）"

# ---- 1) 前置闸门：挑战路径必须已经公开可达，否则签的一定是失败 ----
# 在服务器上造一个一次性令牌文件，从 80 打它拿 200。
# 这一条只证明「nginx 路由 + webroot 权限」对；LE 是从公网进来的，
# 所以还要安全组/备案接入都正常 —— 那层由第 4 步的真实签发来兜底确认。
echo "==> 检查 ACME 挑战路径是否公开（deploy-web.sh 第 ① 步做过没有）"
$SSH "$SERVER" "
    set -e
    install -d -m 755 -o www-data -g www-data ${WEBROOT}/.well-known/acme-challenge
    P=\$(openssl rand -hex 8)
    printf 'acme-https-probe' > ${WEBROOT}/.well-known/acme-challenge/\$P
    chown www-data:www-data ${WEBROOT}/.well-known/acme-challenge/\$P
    code=\$(curl -s -o /tmp/ahp.out -w '%{http_code}' -H 'Host: ${DOMAIN}' http://127.0.0.1/.well-known/acme-challenge/\$P)
    body=\$(cat /tmp/ahp.out); rm -f /tmp/ahp.out ${WEBROOT}/.well-known/acme-challenge/\$P
    echo \"    挑战文件 HTTP \${code}，正文 \${body}\"
    if [ \"\${code}\" != '200' ] || [ \"\${body}\" != 'acme-https-probe' ]; then
        echo '    ✗ 挑战路径不可达（期望 200）。先跑一次 bash scripts/web/deploy-web.sh 把它放开。' >&2
        exit 1
    fi
"
echo "    ✓ 挑战路径可达，可以签了"

# ---- 2) 装 acme.sh（钉 tag；已装就复用，不重复 clone）----
echo "==> 安装 acme.sh（${ACME_TAG}）到 ${ACME_HOME}"
$SSH "$SERVER" "
    set -e
    if [ ! -x ${ACME_HOME}/acme.sh ]; then
        rm -rf ${ACME_SRC}
        git clone --depth 1 --branch ${ACME_TAG} -q https://github.com/acmesh-official/acme.sh.git ${ACME_SRC}
        echo \"    clone 完成，commit：\$(git -C ${ACME_SRC} rev-parse HEAD)（钉的是 tag ${ACME_TAG}）\"
        # 必须 cd 进源码目录再调：--install 是按当前目录找 acme.sh / bin / dnsapi 往
        # --home 里拷的，用绝对路径从别处调会报「cp: cannot stat acme.sh」并留下半个空 home。
        # 踩坑实证（2026-10-20 首次上线）：上一版就是这么写的。
        rm -rf ${ACME_HOME}
        (cd ${ACME_SRC} && ./acme.sh --install --home ${ACME_HOME} --accountemail '${ACME_EMAIL}' >/dev/null)
        echo '    已安装'
    else
        echo \"    已存在，跳过安装：\$(grep -m1 LE_HOME ${ACME_HOME}/account.conf 2>/dev/null || echo ${ACME_HOME})\"
    fi
    chmod 700 ${ACME_HOME}
"

# ---- 3) staging 试签 → 删掉 staging 记录 → 正式签 ----
# staging 发的是**不被系统信任**的假证书，走的是同一套 http-01 流程，
# 用它先把「能不能取到挑战文件、能不能建账户、能不能过条款」验掉 ——
# 正式环境同一注册域名每 7 天只能出 5 张证书，拿真证书试错是要还的。
#
# ★ 中间那步 --remove 不是可选的（2026-10-20 首次上线实测踩中）：staging 与正式共用
#   同一个域名目录，签完 staging 再直接 --issue，acme.sh 回「Domains not changed.
#   Skipping.」且**退出码仍是 0** —— 于是那张 (STAGING) Baloney Bulgur 假证书会一路
#   装进 /etc/nginx/ssl，浏览器现场报「证书不受信任」。所以 staging 验完必须把这条
#   域名记录删干净，正式签才真的发生；开头也删一次，是为了让本脚本能带脏状态重跑。
#   两个坑都要记住（2026-10-20 实测）：① v3.1.6 里没有 --delete 这个参数，写错只得到
#   「Unknown parameter」+ 退出码 1，假证书记录原地不动；② --remove **只删配置、不删文件**，
#   key/cert 仍留在域名目录里，下一次 --issue 撞到已存在的域名私钥会回
#   「Domain key exists, do you want to overwrite it? … add --force」并直接失败。
#   所以每次 --remove 之后还要 rm -rf 那个域名目录（里面只有刚签出来的那张证书的材料）。
#
# ★ 正式签那行也**必须显式带 --server**：acme.sh v3.1.6 的默认 CA 已经不是 Let's Encrypt
#   而是 ZeroSSL，不写就会静默签成 ZeroSSL（2026-10-20 实测：一次不带 --server 的 --issue
#   直接返回 issuer=ZeroSSL ECC DV SSL CA 2）。两张证书浏览器都认，但本仓库的限流口径、
#   账户邮箱、续期说明全是按 LE 写的，所以把 CA 钉死，别让它跟着上游默认值漂。
echo "==> 签发（staging 验链路 → 删记录 → 正式签；已有正式证书则整体跳过）"
$SSH "$SERVER" "
    set -e
    A=${ACME_HOME}/acme.sh
    if [ -f ${PEM} ] && ! openssl x509 -noout -issuer -in ${PEM} | grep -q 'STAGING'; then
        echo '    正式证书已在 ${PEM}，跳过签发（要重签：acme.sh --renew -d ${DOMAIN} --force --ecc）'
        exit 0
    fi
    \$A --remove -d ${DOMAIN} --ecc >/dev/null 2>&1 || true
    rm -rf ${ACME_HOME}/${DOMAIN}_ecc
    if ! \$A --issue --server ${LE_STAGING} -d ${DOMAIN} -w ${WEBROOT} --keylength ec-256; then
        echo '    ✗ staging 就失败了 —— 别打正式环境的主意，先查这三件：' >&2
        echo '        ① 安全组 80 是否对外（不只是 ufw）；② DNS 是否指到本机；' >&2
        echo '        ③ 备案接入是否生效（未接入时 80 会被运营商拦）。日志：${ACME_HOME}/acme.sh.log' >&2
        exit 1
    fi
    echo '    ✓ staging 通过：ACME 全链路（挑战取文件 + 账户注册 + 条款）成立'
    if ! \$A --remove -d ${DOMAIN} --ecc >/dev/null 2>&1; then
        echo '    ✗ 清不掉 staging 记录 —— 停在这里，别让假证书冒充正式版装进 nginx' >&2
        exit 1
    fi
    rm -rf ${ACME_HOME}/${DOMAIN}_ecc
    echo '    staging 记录与目录已清空 —— 现在才是正式签发（EC-256）'
    \$A --issue --server ${LE_PROD} -d ${DOMAIN} -w ${WEBROOT} --keylength ec-256
"

# ---- 4) 装到 nginx 的位置 + 自动续期 ----
# --reloadcmd 是续期成功后的最后一步：没有它，续下来的新证书要等下次 reload 才生效，
# 于是「续期成功但线上还在用旧证书」—— 表现是到期那天突然打不开。
# 装完当场验一次 issuer：万一上面那道 --remove 没生效，宁可在这里失败，
# 也绝不让假证书进到 deploy-web.sh 的开关片段眼里（它只看文件在不在）。
echo "==> 安装证书到 ${SSL_DIR}/（nginx 读这里，不读 /root/.acme.sh）"
$SSH "$SERVER" "
    set -e
    install -d -m 700 ${SSL_DIR}
    ${ACME_HOME}/acme.sh --install-cert -d ${DOMAIN} --ecc \\
        --key-file ${KEY} --fullchain-file ${PEM} \\
        --reloadcmd 'systemctl reload nginx'
    chown root:root ${PEM} ${KEY}; chmod 644 ${PEM}; chmod 600 ${KEY}
    iss=\$(openssl x509 -noout -issuer -in ${PEM})
    if printf '%s' \"\${iss}\" | grep -q 'STAGING'; then
        echo '    ✗ 装到 nginx 的是 staging 假证书（issuer 带 STAGING）—— 已删掉，别去跑 443 那步' >&2
        rm -f ${PEM} ${KEY}
        exit 1
    fi
    echo \"    签发方：\${iss}\"
    echo \"    到期日：\$(openssl x509 -noout -enddate -in ${PEM})\"
    ${ACME_HOME}/acme.sh --install-cron >/dev/null 2>&1 || true
    echo '    续期任务：'; crontab -l | grep -F acme.sh | sed 's/^/      /' || echo '      ✗ 没看到 acme.sh 的 cron，续期不会自动跑，手工补一次'
"

echo "==> 下一步：再跑一次 bash scripts/web/deploy-web.sh —— 它看到证书才会把 443 监听写进开关片段"
echo "    （在那之前 443 是「防火墙开着、没人监听」，外部打它是连接被拒，属预期。）"
