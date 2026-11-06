# 闸门数据恢复手册

> **出事先看这里。** 要恢复的数据 = 服务器上的 `/var/lib/cmsgate`（密码表 / 签名密钥 / 访问日志 / 背景图）。
> 两层备份：服务器 `/root/cms-backup/`（每天 03:17 快照，留 28 份）+ Mac `~/Backups/cms/`（每小时 + 登录即拉，留 1000 份）。
> 2026-10-28 起服务器侧另打 **QQbot 两路快照**（`bot-cfg` 每日 28 份、`bot-ntqq` 周三/日 8 份）——
> QQbot 不进仓库，本手册只覆盖 cmsgate 数据，bot 恢复不在本手册范围。
> **快照里还带一份** `/etc/nginx/snippets/cms-gate-path.conf`（秘密登录入口的 token），
> 它落在 tar 包根、不在数据目录里，恢复时要单独解一次 → 见[「登录入口片段」](#登录入口片段token-丢了谁都登不进来)。
> 监控与备份机制的背景见 [`docs/密码闸门.md`](../docs/密码闸门.md) 的「存活监控与数据备份」。

## 恢复会影响什么（动手前先读）

- **默认是整目录覆盖**：会把整个 `/var/lib/cmsgate` 覆盖成快照那一刻的状态，**包括 `usage.jsonl`（访问日志）**——最近的访问记录会一起回滚丢失。只想救密码表、保住日志见下方[「选择性恢复」](#选择性恢复只救密码表保住访问日志)。
- **闸门中断几秒**：`stop` → `start` 之间登录不可用。
- **已登录会话可能失效**：若快照里的 `secret.key` 与当前不同，所有在线浏览器会掉回密码页，需重新输密码。
- **属主/权限会自动还原**：快照用 `tar` 以 root 打包，**root 解包会原样还原属主与权限**（`passwords.json`/`secret.key` 是 `cmsgate:cmsgate 0600`，`webbg/` 是 `root:root`）。所以**场景 A 不需要再 chown**；只有场景 B（换了服务器、uid 变了）才需要。

---

## 场景 A：服务器还在，只想回滚数据（最常见）

误删 / 误改密码表，或想退回之前某一天的状态。在服务器上以 root 执行：

```sh
# 0. 看有哪些快照，挑要恢复的那份（文件名就是时间戳 cms-年月日-时分秒）
ls -1t /root/cms-backup/cms-*.tar.gz
SNAP=/root/cms-backup/cms-YYYYMMDD-HHMMSS.tar.gz      # ← 换成你要恢复的那份

systemctl stop cmsgate                                 # 1. 停闸门（期间登录中断几秒）
tar -czf /root/pre-restore-$(date +%Y%m%d-%H%M%S).tar.gz -C /var/lib/cmsgate .   # 2. 先把现状存一份，恢复错了能退回
tar -xzf "$SNAP" -C /var/lib/cmsgate                   # 3. 解包（root 解包原样还原属主/权限，无需 chown）
rm -f /var/lib/cmsgate/cms-gate-path.conf              # 3b. 快照里的 nginx 片段会被解到这儿，搬走（见下面「登录入口片段」）
systemctl start cmsgate                                # 4. 起闸门

# 5. 验证三件事
systemctl is-active cmsgate                                                       # 服务活着
curl -fsS http://127.0.0.1:8090/health && echo " <- health OK"                     # authd 响应
code=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/dist/main.js)  # 闸门没被绕过
echo "未登录访问 /dist/main.js = $code（**应为 404**，不是 401）"
```

> 第 2 步的现状快照命名 `pre-restore-*`，不匹配轮转的 `cms-*`，所以不会被自动删；确认恢复没问题后可手动清理。

### 选择性恢复（只救密码表、保住访问日志）

不想动 `usage.jsonl`，只把密码表 / 密钥退回快照那一刻：

```sh
systemctl stop cmsgate
tar -xzf "$SNAP" -C /var/lib/cmsgate ./passwords.json ./secret.key
chown cmsgate:cmsgate /var/lib/cmsgate/passwords.json /var/lib/cmsgate/secret.key
chmod 600            /var/lib/cmsgate/passwords.json /var/lib/cmsgate/secret.key
systemctl start cmsgate
```

---

## 场景 B：服务器整个没了 / 重装了（用 Mac 异地那份）

```sh
# ① 在 Mac 上：把选定快照推回（新）服务器
scp -P 712 ~/Backups/cms/cms-YYYYMMDD-HHMMSS.tar.gz root@<服务器IP>:/root/

# ② 在服务器上：先重装闸门本体（重建 cmsgate 用户/目录/服务 + authd + nginx），
#    它会生成一套全新的空数据。需要管理口令等参数，见 docs/密码闸门.md「部署」。
cd <仓库目录>
./scripts/web/deploy-gate.sh
./scripts/web/deploy-web.sh

# ③ 再用快照覆盖回真实数据
systemctl stop cmsgate
tar -xzf /root/cms-YYYYMMDD-HHMMSS.tar.gz -C /var/lib/cmsgate
# 快照里还带一份 nginx 片段（裸文件名落在包根），它不属于数据目录。
# 必须在下面的 chown 之前删掉：否则它会被当成状态文件改掉属主，
# 之后④再从数据目录搬去 /etc/nginx/snippets，权限就已经不是 root 的 600 了。
rm -f /var/lib/cmsgate/cms-gate-path.conf
# 按名字修属主，不用 chown -R：新服务器上 cmsgate 的 uid 变了，需要绑回去的只有这三个；
# webbg/ 必须是 root:root（nginx 以 www-data 只读它），递归 chown 会把背景图一起改坏。
chown cmsgate:cmsgate /var/lib/cmsgate/passwords.json \
                      /var/lib/cmsgate/secret.key
chmod 600 /var/lib/cmsgate/passwords.json /var/lib/cmsgate/secret.key
for f in /var/lib/cmsgate/usage.jsonl /var/lib/cmsgate/usage.jsonl.1; do
    [ -e "$f" ] && chown cmsgate:cmsgate "$f" && chmod 600 "$f"   # 轮转档可能不存在
done
chown root:root /var/lib/cmsgate /var/lib/cmsgate/webbg
chmod 700 /var/lib/cmsgate
chmod 755 /var/lib/cmsgate/webbg
systemctl start cmsgate
# ④ ★ 新机必须把登录入口也解回去，否则访客手里的网址全 404、谁都进不来：
#    见下面「登录入口片段」一节（解到 /etc/nginx/snippets/ 而不是数据目录）
# 验证同场景 A 第 5 步
```

> 场景 B 里 `secret.key`、`passwords.json` 都在快照内，密码表与签名密钥会一并恢复；
> 2026-10-19 之后**登录入口的 nginx 片段也在快照内**，所以不用再靠"重新 `rotate` 一条新入口 + 挨个通知访客"兜底。
> 但 `deploy-gate.sh` / `deploy-web.sh` 需要的**管理口令**等"重装参数"仍不在数据快照里，得你手上有。

---

## 登录入口片段：token 丢了谁都登不进来

`/etc/nginx/snippets/cms-gate-path.conf` 首行的 `# gate-token: <TOKEN>` 就是唯一能登录的地方
（`/gate/` 本身对无会话者 404）。它丢了或坏了，唯一症状是**访客说链接打不开**，
而 `authd /health` 正常、nginx 在跑、受保护资源也照样"正确地" 404 —— 前五项探活全绿。
第六项探活专门盯这个，两层快照里也带着它，所以能恢复。

```sh
# 在服务器上：确认这份快照里有没有片段（成员名不带目录，就在包根）
tar -tzf "$SNAP" | grep -x cms-gate-path.conf && echo "有"

# 有 → 直接解到正确位置（不要从已解包的数据目录里搬，那样权限可能已经变了）
tar -xzf "$SNAP" -C /etc/nginx/snippets cms-gate-path.conf
nginx -t && systemctl reload nginx

# 验证：秘密入口打得开，且公开路径仍然 404
TOK=$(sed -n '1s/^#[[:space:]]*gate-token:[[:space:]]*\([a-z0-9]\{12,32\}\)[[:space:]]*$/\1/p' /etc/nginx/snippets/cms-gate-path.conf)
[ -n "$TOK" ] || echo "首行标记坏了：看 gate_manager 的 gate_path_text() 写法和这里的读法是否一致"
curl -s  -o /dev/null -w '入口  %{http_code}（应 200）\n' "http://127.0.0.1:8080/gate/${TOK}/"
curl -s  -o /dev/null -w '/gate/ %{http_code}（应 404）\n' "http://127.0.0.1:8080/gate/"
```

**片段里只有一个可读的 token**，其余是可复制的 `location` 块；`cms gate-path status` 读的就是这份文件。

- **恢复旧入口**（上面这段）= 大家收藏的网址继续有效。优先选这条。
- **换新入口** = `cms gate-path rotate`（要管理口令）。旧的立即 404，**必须把新网址重新发给每一个需要登录的人**，
  所以只在旧片段确实找不回来时才用。
- ⚠️ 别把解出来的片段直接留在 `/var/lib/cmsgate/` —— 那个目录是 cmsgate 的，nginx 读的是 `/etc/nginx/snippets/`，
  留在数据目录里等于没恢复，还会多一份 600 之外的密钥副本要清理。

---

## 确认备份本身没坏（平时演练用，可选）

```sh
# 在服务器上：解最新快照到临时目录，比对关键文件与线上是否逐字节一致
newest=$(ls -1t /root/cms-backup/cms-*.tar.gz | head -1)
drill=$(mktemp -d); tar -xzf "$newest" -C "$drill"
cmp "$drill/passwords.json" /var/lib/cmsgate/passwords.json && echo "passwords.json 一致"
cmp "$drill/secret.key"     /var/lib/cmsgate/secret.key     && echo "secret.key 一致"
# ★ 入口片段（tar 成员不带目录，解出来就在 $drill 根）；它决定访客能不能打开登录页
cmp "$drill/cms-gate-path.conf" /etc/nginx/snippets/cms-gate-path.conf && echo "登录入口片段一致"
rm -rf "$drill"
```

`scripts/web/deploy-backup.sh` 每次部署都会自动跑一遍这个恢复演练（不一致会直接失败），所以只要部署自测是绿的，备份就是可还原的。
演练解出来的是**临时目录里的一份密钥副本**，`rm -rf` 随即删掉；不要在别处解包后忘记清理。
