# /share —— 给想学东西的访客

这个仓库是一个完整的个人项目：复数扫雷游戏（桌面 C++/SFML + 网页 TypeScript/Canvas）
+ 密码闸门保护的自架服务器 + 分布式求解器跑分系统。下面按学习价值排列，直接指向
仓库里的**真实路径**——这里不放副本，改了哪儿都是新的。

## 源码（含金量排序）

| 路径 | 学什么 |
| --- | --- |
| [src/solver/SolverEngine.h](../src/solver/SolverEngine.h)（约 2600 行） | 扫雷精确概率求解器第四代：分层 BucketDP（邻接图分块 + 桶计数 DP + 三道验证闸）、自适应 DP 上限阶梯重试、消元序择优、二维全局卷积把边界耦合修正回每格概率。配套 [docs/求解器第四代报告.md](../docs/求解器第四代报告.md) 讲完整推导与验收数据。 |
| [tools/dist_server.py](../tools/dist_server.py) | 1250 行单文件调度服务器，适合学「怎么把分布式调度写小」：任务队列 + 租约 + 首心跳宽限（15 分钟没报进度就收回，防「领完就死」占坑）、每 IP 下载配额与并发上限、flock 串行化的状态文件、admin 子命令复用 scrypt 管理口令、`X-Real-IP` 只信回环对端的信任边界。 |
| [tools/dist_client.py](../tools/dist_client.py) | 自更新链路的三平台实现：manifest 拉取与校验、更新锁（O_EXCL + 15 分钟过期）、mac 替换运行中文件 / Windows `.old` 改名 / Linux 源码形态 `execv`，以及「更新失败冷却」「下载配额被打回 429 时静默退避」这类实战细节。 |
| [server/authd.py](../server/authd.py) + [scripts/web/deploy-web.sh](../scripts/web/deploy-web.sh) | 密码闸门的真实现：scrypt 口令表 + 常时比较、nginx `auth_request`、以及整套 **404 模型**（未登录的资源一律按「不存在」处理而不是 403/401，由 deploy 脚本生成 nginx 片段）。 |
| [server/cmsgate-healthcheck.sh](../server/cmsgate-healthcheck.sh) | 十三项探活 + Healthchecks「死人开关」+ 失败去重（连续 2 轮才告警，防单次抖动凌晨发邮件）。每一项注释都写了「为什么只有这一项能看见这类故障」。 |
| [src/core/](../src/core/) + [src/desktop/](../src/desktop/) | 游戏本体：复数扫雷数据模型（Board/Rng/Seed）与 SFML 3.0 渲染层。 |

## 文档

| 路径 | 学什么 |
| --- | --- |
| [docs/密码闸门.md](../docs/密码闸门.md) | 全项目最厚的一份：从威胁模型出发，逐步推到 404 化、HSTS、秘密登录路径、探活、备份、恢复演练的完整决策链。文档里的 IP/端口已用 `<服务器IP>` 等占位——真实值只存在部署脚本的环境变量里。 |
| [docs/分布式跑分cmsdist.md](../docs/分布式跑分cmsdist.md) | 跑分系统从明文到 TLS 的收口过程：为什么明文口绑回环、为什么公网只留一个 TLS 入口、中间人能怎么灌假结果。 |
| [docs/求解器第四代报告.md](../docs/求解器第四代报告.md) | 算法报告的写法样本：假设 → 验证闸 → 计时/内存验收 → 结论，失败假设也如实记录。 |
| [docs/求解器统计_大样本定稿.txt](../docs/求解器统计_大样本定稿.txt) | 大样本统计跑法与输出格式。 |
| [docs/CLION-交叉编译配置.md](../docs/CLION-交叉编译配置.md) | 用 CLion 从 mac 交叉编译 Windows/Linux 目标的踩坑实录。 |
| [docs/游戏玩法说明指引.txt](../docs/游戏玩法说明指引.txt) | 复数扫雷规则。 |
| [docs/项目结构说明.md](../docs/项目结构说明.md) | 整个仓库的地图与文件行数总账。 |

## 不在仓库里的东西（设计使然）

口令表、探活 ping URL、gate token、管理口令哈希、跑分结果数据——全部只在服务器上
（`/etc/cmsgate/`、`/var/lib/cmsgate/`，600 root），仓库里连文件名都不会出现；
[.gitignore](../.gitignore) 有专门一节挡它们，测试套件会断言这类串进不了仓库。
安全审查文档（历轮审计记录）属于服务器防御布局的内部清单，不对外。
