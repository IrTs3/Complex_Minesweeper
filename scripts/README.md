# scripts/ 说明

按用途分三层：`game/` 游戏本体、`web/` 闸门与网站（ECS）、`dist/` 分布式跑分（cmsdist）。
所有脚本都从仓库根目录外可用（内部用 `dirname $0` 自定位），部署类脚本幂等、可重复跑。

## game/ — 游戏本体构建与打包

| 脚本 | 用途 |
| --- | --- |
| `build.sh` | macOS 一键构建（cmake 配置 + 并行编译，优先用 CLion 自带 ninja） |
| `build_windows.sh` | Win64 交叉编译全流程：多镜像下载 → sha256 强制校验 → 静态 freetype → 静态 SFML → strip → zip |
| `package.sh` | macOS 出包：.app / zip / 样式化 dmg / SHA256SUMS，含多重验签闸门 |
| `make_win_icon.sh` | 从 `assets/bg.jpg` 生成 Windows `.ico`（内嵌进 exe 的 PE 资源段） |
| `refresh_icon.sh` | 只重生成 `.app` 图标（不重编译、不重打 dmg；`--show` 只预览） |
| `打包.command` | 双击打包入口（Finder 用终端打开），转调 `package.sh` |
| `打包Windows.command` | 双击 Windows 打包入口，额外做 mingw-w64 依赖检查 |

## web/ — 闸门与网站部署（阿里云 ECS）

| 脚本 | 用途 |
| --- | --- |
| `deploy-gate.sh` | 部署 `authd.py` 验密网关与 `cmsgate.service`（**必须先于 deploy-web.sh**） |
| `deploy-web.sh` | 网页版分发：tsc 编译 + rsync 静态资源 + nginx 站点/开关片段生成 + 部署自测 |
| `deploy-https.sh` | 443 证书签发/续期（acme.sh）与「开关片段」；跑完须再跑一次 deploy-web.sh 才真正打开 443 |
| `deploy-monitor.sh` | 部署探活脚本与 systemd timer（首次要注入 Healthchecks ping URL） |
| `deploy-backup.sh` | 服务器层每日快照（03:17，留 28 份）+ 恢复演练自测 |
| `install-mac-backup.sh` | 在 Mac 上装 `com.cms.gate-backup-pull` LaunchAgent（每小时 + 登录时 rsync 拉快照） |

## dist/ — 分布式求解器跑分（cmsdist，公开 7120）

| 脚本 | 用途 |
| --- | --- |
| `deploy-dist.sh` | 部署/重启 7120 调度服务（cmsdist）到 ECS；重入安全（显式 restart） |
| `package-dist-client.sh` | 重打测试组客户端成品 + 发布自动更新：macOS dmg（PyInstaller 内嵌 solver）+ Win64 免安装 zip + Linux tar.gz（solver 借 ECS 现编），Ed25519 签 manifest 推到服务器；产物进 `dist-solver/`（已 gitignore，可整个外发）。`--no-push` 只打包不发版 |
| `cmsdist-pull.sh` | 每天把跑分结果从 ECS rsync 到 `~/Backups/cms-dist/`（由 LaunchAgent 调） |
| `install-cmsdist-pull.sh` | 装 `com.cms.cmsdist-pull` LaunchAgent（每天 09:17 + 登录时） |
| `install-ctlui.sh` | 把 ctlui 装成终端命令 `ctlui`（软链 `tools/ctl_ui.py`，升级仓库即升级命令） |

更多细节：`docs/项目结构说明.md` §4.7、`docs/密码闸门.md`（web 层）、`docs/分布式跑分cmsdist.md`（dist 层总规格：协议、指纹归因、自动更新、运维与历史坑）。
