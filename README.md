# Complex Minesweeper（复数扫雷）

复数扫雷——纯 C++20 + SFML 3 的桌面游戏。传统扫雷的提示是"周围有几颗雷"，本作的提示是**周围雷的复数和的模长**：|Σz| = √(real² + imag²)。四种雷 +1 / -1 / +i / -i 会相互抵消，"0"不一定安全；把每颗雷的精确复值推出来并标对，才是本作的完全形态。

- 平台：macOS（Apple Silicon）原生；Windows x64 可在 macOS 上交叉编译
- 零联网代码：无网络栈、无遥测、无运行时下载（说的是**游戏本体**；`tools/` 下的 cmsdist 跑分客户端与本机看板会联网，见第十三节）
- 安装包发布于 GitHub Releases，附 SHA256SUMS 指纹供接收方自验

---

## 一、规则

### 四种地雷

| 地雷 | 复数值 | 外观 |
| --- | --- | --- |
| 正实雷 | +1 | 红底 +1 |
| 负实雷 | -1 | 红底 -1 |
| 正虚雷 | +i | 绿底 +i |
| 负虚雷 | -i | 绿底 -i |

四种雷各约 25%。提示按**有符号复数和**计算：+1 与 -1、+i 与 -i 相互抵消。

### 提示数字的含义

| 显示 | 含义（举例） |
| --- | --- |
| 空白 | 周围完全没有雷（只有这种格子会连锁展开） |
| 黄色 0 | 周围有雷但完全抵消（如 +1 与 -1 各一颗）——**有雷，不展开！** |
| +1 / -2 …（蓝） | 纯实和，带正负号显示（净剩实雷指向 + 或 -） |
| +i / -3i …（绿） | 纯虚和，带正负号显示 |
| √2（紫） | 净剩 1 实 1 虚（方向任意） |
| √5（紫） | 净剩 (±1,±2) 或 (±2,±1) |
| 2√2（紫） | 净剩 (±2,±2) |
| 5（紫） | 净剩 (±3,±4) 勾股组合 |

配色：蓝 = 纯实和（显示带号实数），绿 = 纯虚和（显示带号虚数），紫 = 混合（显示模长根式），黄 0 = 抵消为零但有雷。

**最狠的陷阱**：黄色 0 说明周围有雷且完全抵消——有雷、不连锁。只有"周围雷总数 = 0"的格子才会连锁展开，看到 0 千万别当成安全区。

### 胜利的两条路径（两种口径）

1. 翻开全部安全格（传统路径；此时雷怎么标都行，甚至标错也不算错）。
2. 不开完安全格也算赢——把所有雷全部标记即视为识破全局。判定分两种口径：
   - **有符号口径**（默认）："统计一致即为解"——未被任何纯实/纯虚提示锚定的统计无关连通分量允许整体取反（+1↔-1、+i↔-i 任一取向都算对）；被纯提示锚定的分量必须与提示一致；跨轴标记必输。**标记总数必须恰好等于雷数**，多标或少标均不判胜。
   - **模长口径**（勾选「总是显示模长」时）：标记集合与雷集合完全一致（不多不少），且每个已翻开格的可见模长 == 其邻域"标记和"的模长；不要求每颗雷标记的精确类型（符号翻转因 |z| 不变性天然通过）。**多标或少标均不判胜**。
   两种口径局中可自由切换，棋盘状态（已翻开 / 标记 / 计时）完整保留。胜利后自动按真实雷型给所有雷打上标记。

### 「总是显示模长」复选框（表头，默认关）

勾选后所有非零提示一律显示模长 |z|（完全平方显示整数：2、-3i、3+4i 都显示 2/3/5；非平方显示根式如 √5），颜色统一紫色——模长抹去符号后，蓝绿轴色反而多泄露实/虚轴信息；黄色 0 保持不变。相当于把符号与轴信息都藏起来，难度更高。表头两轴计数芯片同步合并为一个中性 m 芯片。

### 表头计数语义（与判胜口径同步）

- 常规模式：±1 / ±i 两枚芯片，显示该轴上尚未被正确标记的雷数（布雷前显示 x?，归零变灰，数值变动时黄色高亮闪约 1.1 秒）。
- 模长模式：单枚 m 芯片 = 未翻开的雷数（标在雷上才减、标错位置不占、恒非负，与判胜 / 双击开格同口径）。
- 主界面 MINES LEFT 药丸：经典语义 = 总雷数 − 总标记数（可为负，负数画红色提醒多插；2026-10-29 起，旧口径「只减标在真雷上的旗」已废）。抓标记**类型**错误看两轴芯片，本药丸只数数量。
- SEED 界面的 MINES LEFT 药丸：经典语义 = 总雷数 − 总标记数（可为负）。
- 勾选「隐藏计数」时芯片不显示。

## 二、操作

| 操作 | 效果 |
| --- | --- |
| 左键 | 翻开（首次点击必定安全，布雷发生在首点，棋盘够大时首点九邻域无雷） |
| 右键 | 标记菜单：固定五项 +1 / -1 / +i / -i / clear，无论当前状态都全部显示（点当前项 = 不变）；点菜单外任何地方只取消菜单、不会翻格 |
| 菜单键盘 | ↑/↓ 移动（循环）、Enter 确认、Esc 取消、1-5 直接选 |
| 数字快捷 | 鼠标悬停未翻开格按 1/2/3/4/5 = +1 / -1 / +i / -i / 清除（主键盘或小键盘均可） |
| 功能键 | F1 = 帮助面板开关；F2 = 重开当前局；F3 / F4 / F5 = 切到 9x9 / 16x16 / 24x16。局中按 F2~F5 先弹确认框；任何模态面板（设置 / 自定义 / 种子 / 确认框）打开时功能键不生效 |
| 双击已翻开数字格 / 中键 | 双击开格（chord），见下 |
| 难度按钮 EASY / MEDIUM / HARD / ↻ | 9x9（12雷）/ 16x16（40雷）/ 24x16（72雷）/ 重开当前局；局中点击先弹确认框 |
| PLAY AGAIN | 胜负已分后出现在表头、常驻到开新局；点击直接按当前口径重开（不弹确认，点棋盘复盘不会让它消失） |
| 结算横幅 | 获胜/失败横幅（CLEARED / BOOM）单击任意处可隐藏文字提示，雷区揭示与错误标记的红叉保留，可从容复盘；开新局自动恢复 |
| 标题右侧 ? | 游戏说明帮助面板：滚轮滚动，点击任意处关闭 |

**双击开格（chord）**：当该数字邻圈的每一颗雷都"按正确类型标记"时，一次打开其余未标记邻格——比经典扫雷严格，不是旗子数量相等而是逐颗 flag == mine；标错类型不生效，条件不满足时什么都不做（不误爆、不惩罚），已标记邻格保持标记。模长模式放宽为"每颗雷有任意标记"即可。条件不满足时的行为可在设置面板选：静默 / 提示（BAD MARKS）/ BOOM（把邻圈里的雷格逐颗清掉标记再翻开，第一颗爆炸即进入败局结算、不再处理其余邻格）；双击判定毫秒 150~1500 可调（默认 400）。

**计时**：首点翻开后才开始走表；显示精度 0.1 秒；只有正在看棋盘才走表——切窗口、打开设置 / 自定义局 / 种子 / 确认框 / 帮助都暂停（右键标记菜单除外）。

**统计行**（标题栏第四行）：如 `16 x 16  mines 40  opened 61/216 (28.2%)  flagged 1/40 (2.5%)`，数字下各配一条进度条；同行右端是复选框簇（彩蛋 / 隐藏计数 / 总是显示模长），统计文字以簇的最左控件为右界逐级降级（先藏 mines，再省百分号，再分段隐藏），窗口最小宽 640。

**彩蛋「红专并进 理实交融」**：勾选后，每个未翻开、未标记的格子（不论是不是雷）中央以灰色（约 85% 不透明度）显示 U/S/T/C 之一，开局前与结束后同样有效。字符由 格子坐标 + 本局随机种子 的哈希决定——每格稳定不变，且不消耗游戏随机数流（不破坏种子可复现性）。勾选状态立即写入 settings.ini（ustc），并随种子 / 进度存档一起保存恢复（JSON 的 ustcMode 字段）。同一个开关也门控**点击弹字**：勾上后点击棋盘 / 星空会弹出 U/S/T/C 字母。

**装饰层（星光 / 流星 / 爆圈）**：背景上铺一层缓慢漂移的星光；每 1~1.5 分钟来一批 20~30 颗流星、铺在 15~20 秒里（单颗 3~4.5 秒过屏，拖尾约 0.6~1 秒行程），流星头是「高亮核 + 柔光球 + 四芒 + 细环」。左键**真的打中**流星才会炸出一圈同配色的扩散环，打不中时点击照常传给底下的格子 / 按钮。密度与大小在设置面板调（`STARS · DENSITY` / `STARS · SIZE`），密度设 0 = 整层关掉；字母弹字只受「彩蛋」复选框控制，与星光密度是两回事。

**BG 滑条**（标题栏右侧）：随时调整背景图不透明度，0~75%（默认 55%），游戏中即时生效；百分比数字可点进去键入，会让数值越界的那个字符直接拒收，Enter 提交、Esc 还原。

## 三、自定义局面板（CUSTOM）

点标题栏 CUSTOM 直接开面板（开面板不损失任何东西，不弹确认）。可调行 / 列 / 雷数，并可精确指定实 / 虚雷数量，两条输入路径互斥、按操作自动切换：

- 填写或步进"总雷数" → 随机分配模式：隐藏实 / 虚控件，后台按总数随机分型；
- 拖动实 / 虚雷滑块 → 手动指定模式：总雷数实时等于两者之和（灰显不可改）。SET SPLIT 从随机切入手动（默认平分）；点"总雷数"框切回随机。

数字支持 ++ / + / - / -- 步进（±1 / ±5）与单击键入（只收数字，Enter 提交、Esc 还原）。

**上限每次打开面板现场计算**：行列上限 = 24px 最小格在本机可用屏幕下能放下的数量（例：1512x982 桌面 → 51 列 / 25 行），雷数上限 = 行x列 - 1（首点留一格）；标签实时显示范围（如 `ROWS(5~25)`），输入拒收、步进钳制、START 兜底校验四路全部与现场计算同源；超限提示 GRID TOO BIG FOR SCREEN 且不开局。

**START 才是真正替换本局的时刻**：校验通过后弹确认框并写明面板当前完整规格（如「自定义局面（51x25，250雷）」），Cancel 只关确认框、面板原样保留可继续调。

## 四、屏幕自适应

格子优先 40px，棋盘超出屏幕自动缩小，最小 24px。可用屏幕取 ms::screenUsableSize()：macOS 用 visibleFrame（已排除菜单栏与程序坞），Windows 用工作区，并与桌面分辨率估算取较小值（macOS 部分环境 getDesktopMode 返回物理像素，防止把可用区域虚大一倍而放行过大棋盘）。

## 五、设置面板（齿轮按钮）

- **BACKGROUND**：CHOOSE IMAGE 用原生文件选择框选背景图（复制进配置目录）；DEFAULT 恢复内置 `assets/bg.jpg` 并删掉你的图。
- **CELL COLOR**：格子底色（默认 `#66CCFF`）。色号框输入 6 位十六进制——**凑满 6 位才生效**（输到一半绝不生效，超 6 位截断，小写自动转大写）；R / G / B 三框输入 0~255（越界的字符拒收）；RESET 恢复默认。描边与悬停高亮按该颜色自动派生（深一档 / 亮一档）。
- **四种标记（+1 / -1 / +i / -i）**：点小方块直接敲一个可见 ASCII 字符（非法输入忽略，全角字符自动转半角），或点 IMAGE 选图片当图标（等比缩放）；CLEAR 恢复内置样式。字符与图片互斥，后设置的生效。
- **BLANK CELL**：翻开的空白格（周围无雷、会连锁展开的那种）的自定义外观，规则与四种标记相同：敲字符或选图片，CLEAR 恢复默认（默认不画任何东西）。
- **双击开格设置**：失败行为三档（静默 / 提示 / BOOM）+ 判定毫秒滑块（两端 2% 吸附保证取到精确 150/1500，10ms 步进）与输入框（超上限字符拒收，提交低于下限保持原值）。
- **STARS · DENSITY / STARS · SIZE**：星光密度（0~7.12 颗/100×100px，默认 2.17，0.01 步进，两位小数，0 = 彻底关闭星光层）与半径倍率（0.6~3.0，默认 1.7，0.1 步进）。密度就是「每 100×100 逻辑像素多少颗」，实际颗数 = 密度 × 当前窗口**逻辑面积** ÷ 10000（不是 Retina 物理像素）：桌面端 9×9 窗口约 640×546，默认 2.17 就铺约 76 颗；换成 24×16 的大窗口会按面积涨到约 194 颗，密度本身不随窗口变。滑块下面会实时显示 `2.17 颗/100×100px → 本窗口 ≈ N 颗（上限 M 颗）`——换难度/换窗口后 N 与 M 跟着变，上限 M 是密度 7.12 时本窗口的颗数（1512×982 的逻辑区域下是 1057 颗）。窗口尺寸一变就整池重铺，保证切换后立刻是均匀密度。滑块拖动即时生效；右侧数值框可点进去键入（可带两位小数，最多 4 个字符），空值或越界就丢弃这次输入、保持原值（与毫秒框同一口径）。旧版密度（0~800「参考 1512×982 下的颗数」）读入时会自动折算，老配置观感不变。
- **ANIM FX（目前仅网页端）**：装饰动效总闸——开格波前、标记弹入与落定光环、表头雷数翻牌、点击涟漪、邻域预亮、失败雷区圈层显形、胜利星座线、登录页流光都受它控制；关掉后以上全部即时呈现（棋盘逻辑与判定不变，动的只是显示层）。系统开了「减少动态」（prefers-reduced-motion）时会被强制关闭，此时按钮仍显示 ON 但实际不播。
- **RESTORE ALL**：所有设置回默认并删除配置目录里的全部图片（不留孤儿文件），有二次确认。

**持久化铁律（所有设置项一致遵守）**：任何一项改动**立即**写入 settings.ini（不等退出）；RESTORE ALL 全覆盖；每项默认值明确，且结构体默认 / 复位值 / 面板显示三处一致。

### 配置文件放哪

所有配置与自定义图片都收在 `config/` 目录（图片按槽位命名 background / marker_plus1 / marker_minus1 / marker_plusi / marker_minusi / blank；替换同槽位时旧图被删除）。macOS .app 用 `~/Library/Application Support/ComplexMinesweeper/`（见下）；其他情形用**可执行文件同级的 `config/`**（自包含，整个目录拷走即搬走外观）。目录不可写（只读安装位置等）时退回 `~/.complex_minesweeper/`（Windows 为 `%USERPROFILE%\.complex_minesweeper`）。

```
ini
[appearance]
cell = 102,204,255        ; 格子底色 RGB（默认 #66CCFF）
background = default      ; 配置文件名，或 default
chordfail = hint          ; silent / hint / boom
doubleclick = 400         ; 150~1500
hidecounts = 0            ; 0/1
alwaysmagnitude = 0       ; 0/1
ustc = 0                  ; 0/1（彩蛋）
stardensity = 2.17        ; 星光密度（颗/100×100 逻辑像素，0~7.12，0=关闭）
starunit = 2              ; 密度单位版本：2 = 颗/100×100px（缺这行=旧刻度，会自动迁移）
starscale = 1.00          ; 星光大小倍率（0.6~3.0）

[markers]
marker_plus1 = default    ; default | char:@ | image:marker_plus1.png
marker_minus1 = default
marker_plusi = default
marker_minusi = default

[blank]
blank = default           ; 翻开空白格外观：default | char:X | image:blank.png
```

macOS 的 .app 配置写在 `~/Library/Application Support/ComplexMinesweeper/`（首选目录，带一次性迁移：旧包内 `Contents/MacOS/config/` 若存在会先搬过去，之后**绝不写包内**——那会让 bundle 的 `codesign -v` 报 sealed resource invalid）。仅非 .app 运行才用可执行文件同级的 `config/`。

## 六、种子与进度存档

标题栏 **SEED** 按钮菜单共四项：**COPY SEED**（复制当前局种子到剪贴板，需已翻开至少一格，子标签显示种子前 12 位）、**SAVE PROGRESS**（把当前进度复制成种子，别人可以从你的半局接着玩）、**LOAD SEED / SAVE**（打开粘贴对话框，开局种子与进度存档都从这里贴入）、**SEED TOOLBOX**（种子串与明文 JSON 互转，编解码判定与游戏端同口径，编码遇到自相矛盾的 JSON 会给 ⚠ 警告但照样给串；密钥必填，留空直接拒绝——不代读游戏内置密钥）。对局进行中载入会先弹 YES / NO 确认覆盖。输入框支持 Cmd/Ctrl + C / V / X / A、右键编辑菜单、鼠标点选与拖动选择、方向键与 Shift 扩选。

种子明文是**可读 JSON**（含 `"magic": "MSD1"`）：行列、雷数、虚实分型、随机种子、**首点坐标**、时间戳。布雷发生在首点（首点九邻域安全），因此**完全复现 = 种子 + 首点**，只记种子不复现首点会得到不同分布。进度存档同格式同入口（`kind = save`，另有 `elapsedSec`、`phase`、`opened`（每行 #/./）、`flags`（每行 ./1/2/3/4）），16x16 的存档约 1.5k 字符——把整张棋盘画进了 JSON。

加密链：可读 JSON → Rabbit 流密码（RFC 4503，无 IV）→ Base64。**这是分享用的压缩 + 轻量混淆，不是安全边界**：密钥硬编码在游戏二进制里，strings 即可读出；未来排行榜的反作弊靠"服务端下发种子 + 动作日志回放验证"，不靠这层加密。密钥不对时报 WRONG KEY / BAD SEED。

### 独立加解密工具 base

单文件、只依赖 C++20 标准库，不参与游戏逻辑（游戏构建时也会一并编译出 `base`）：

```
sh
c++ -std=c++20 -O2 tools/base.cpp -o base

./base e <默认密码> game.json out.txt   # 加密（省略文件名则走 stdin/stdout）
./base d <默认密码> seed.txt            # 解密为可读 JSON
./base d wrong-key seed.txt             # 密码错误 -> 报错，退出码 2
./base d - seed.txt                     # 密码写 - = 只做 Base64、不做加密（配对的无加密种子可用）
```

默认密码硬编码于 `src/core/Seed.h`（游戏与本工具同一份，两者一致性由交叉测试保证）。

## 七、构建

### macOS

```
sh
brew install sfml cmake      # SFML 3.x
scripts/game/build.sh            # cmake 配置 + 并行构建（优先用 CLion 自带的 ninja）
./cmake-build-debug/minesweeper
```

或直接 CLion 打开本目录（CMake 自动找 /opt/homebrew）。C++20；macOS 额外编译 Objective-C++（原生文件选择框）并链 AppKit。

### Windows（在 macOS 上交叉编译）

```
sh
brew install mingw-w64       # 只需装一次
scripts/game/build_windows.sh    # 或直接双击 打包Windows.command
```

SFML / freetype 静态链接进单 exe（GUI 子系统 + 全静态 + strip，约 3.3MB，只依赖 Windows 自带 DLL），产物连 `assets/` 一起分发。CLion 的交叉编译工具链与 CMake Profile 配置见《CLION-交叉编译配置.md》。

## 八、打包分发与供应链

### macOS：scripts/game/package.sh（或双击 打包.command）

| 产物（dist/ 下） | 用途 |
| --- | --- |
| `ComplexMinesweeper.app` | 未压缩应用 |
| `ComplexMinesweeper-macOS-arm64.zip` | 压缩包：app + 使用说明.txt |
| `ComplexMinesweeper-macOS-arm64.dmg` | 磁盘映像（适合 GitHub Release）：app + 使用说明 + Applications 快捷方式，拖入即装 |
| `SHA256SUMS-macOS.txt` | 分发指纹，接收方 `shasum -a 256 -c` 自验 |

脚本流程：Release 构建 → 组装 .app（assets 进 Resources）→ 第三方动态库拷进 `Contents/Frameworks`、install name 改 `@rpath/...`、**删除遗留的 /opt/homebrew rpath**（不删会出现"本机正常、换机起不来"，可用 `DYLD_PRINT_LIBRARIES=1` 验证库来源）→ ad-hoc 重签名 → 生成图标与 Info.plist → 样式化 dmg（程序生成的安装盘背景 + 图标定位；需要系统允许"控制 Finder"，失败自动退化为无样式 dmg，不影响出包）→ 对 zip / dmg 的**成品级复验签**（签名后 --strict 验签、bundle 签名目录断言、解包复验，任何一环失败即删产物终止）→ 输出 SHA256SUMS → **刷新图标缓存**（`touch` app + `lsregister -f` + 重启 Dock；macOS 26 的图标缓存很顽固，不刷会出现「文件、签名、plist 全对，Finder 里却还是旧图」）。CI 等无 GUI 环境可设 `CMS_NO_ICON_REFRESH=1` 跳过；清系统缓存需要 root，脚本只在**非交互 sudo 可用**时做，否则跳过并打印手动命令（绝不把打包卡在密码提示上）。

**dmg 外观相关的坑（都遇到过）**：

- **"控制 Finder"权限**：没有它时 AppleScript 报 `-1743`，Finder 仍会建一个 6 KB 的**空壳 `.DS_Store`**。所以脚本改成查 `icvp` / `Iloc` 真记录，而不是只看文件在不在——否则会打印"布局已生效"却打开是白底。要授权：在**你自己的终端**里跑一次 `./scripts/game/package.sh`，首次会弹「想控制 Finder」，点允许（或 系统设置 → 隐私与安全性 → 自动化 里给终端勾上 Finder）。
- **同名残留卷**：`/Volumes` 里若还挂着旧的 `ComplexMinesweeper`，AppleScript 按**卷名**操作会打到旧卷，新卷一个布局都拿不到，而且它**返回成功**。脚本现在开打前先卸载同名卷。
- **图标生成失败不能跳过**：`iconutil` 失败以前是 `|| echo "(失败，跳过)"`，产出一个白纸图标的坏包还一路打勾。现在是致命错误。


### Windows：scripts/game/build_windows.sh

产物：`dist/ComplexMinesweeper-win64/`（exe + assets + 使用说明-Windows.txt）、zip、`SHA256SUMS-win64.txt`。

### 供应链

第三方依赖**版本固定**：SFML 3.0.2 与 FreeType 2.13.2 的官方 tarball 提交于 `third_party/`；构建脚本对一切来源（本地 / 直连 / ghproxy 镜像）强制 sha256 一致才使用，不符即删并换源、全败终止。防的攻击场景：代理镜像被黑或大陆链路 DNS 污染，把后门源码无感知编进分发 exe。锚点哈希已在 2026-10-08 与 git 跟踪源码树逐字节比对验证。

### 接收方注意事项

- 完整性：下载后与 SHA256SUMS 同目录执行 `shasum -a 256 -c SHA256SUMS-macOS.txt`（Windows 用 win64 版）。
- macOS 为 ad-hoc 签名（未公证），首次打开：右键 → 打开，或 `xattr -dr com.apple.quarantine ComplexMinesweeper.app`。
- 分发包内不携带任何开发者本机配置（config/ 首次运行时生成）。
- 包内 `使用说明.txt` 的唯一来源是 `docs/使用说明.txt`（用户维护，打包原样复制；缺失只提示、不失败）。

## 九、工程结构

```
text
├── CMakeLists.txt               C++20；find_package(SFML 3)；七个目标：minesweeper / base / solver / rngparity / imgprobe / seedws / seedparse
├── scripts/
│   ├── game/                    游戏本体构建与打包
│   │   ├── build.sh             macOS 一键构建（cmake 配置 + 并行编译）
│   │   ├── package.sh           macOS 分发包（app / zip / dmg / SHA256SUMS，含验签闸门）
│   │   ├── build_windows.sh     Windows 交叉编译 + 分发包（zip / SHA256SUMS，含 sha256 供应链闸门）
│   │   ├── make_win_icon.sh     从 assets/bg.jpg 生成 Windows .ico（内嵌 PE 资源）
│   │   ├── refresh_icon.sh      只重生成 .app 图标（不重编译、不重打 dmg）
│   │   └── 打包.command / 打包Windows.command    双击打包入口
│   ├── web/                     闸门与网站部署（ECS）
│   │   ├── deploy-gate.sh       部署鉴权服务 + systemd 单元（先于 deploy-web.sh）
│   │   ├── deploy-web.sh        网页版：tsc + rsync 静态资源 + nginx 站点/片段生成 + 自测
│   │   ├── deploy-https.sh      443 证书签发/续期与「开关片段」
│   │   ├── deploy-monitor.sh    探活 timer + Healthchecks ping URL 注入
│   │   ├── deploy-backup.sh     每日快照 timer + 恢复演练（含 cmp 断言）
│   │   └── install-mac-backup.sh    Mac 侧 LaunchAgent（每小时 + 登录时 rsync 拉快照）
│   └── dist/                    分布式跑分（cmsdist）
│       ├── package-dist-client.sh    测试组客户端打包（dmg / win64 zip，内嵌 solver）
│       ├── deploy-dist.sh       部署 7120 调度服务到 ECS
│       ├── cmsdist-pull.sh      每日拉取跑分结果到 Mac
│       ├── install-cmsdist-pull.sh   装 cmsdist-pull 的 LaunchAgent
│       ├── install-ctlui.sh     把 ctlui 装成终端命令
│       └── 打包客户端.command / 部署调度端.command    双击入口（打包 / 部署 7120）
├── tools/
│   ├── base.cpp                 种子加解密工具（单文件，只依赖 C++20 标准库）
│   ├── solver.cpp               自由推理求解器与免猜率统计 CLI（复盘分析工具，不进对局，只链 core）
│   ├── dist_server.py           cmsdist 调度服务器（ECS 上 systemd `cmsdist`，公开 7120；任务分发 + nonce 防作弊 + 租约自愈）
│   ├── dist_client.py           cmsdist 跑分客户端（三平台分发，任务边界验签自动更新；见 docs/分布式跑分cmsdist.md）
│   ├── distctl.py               cmsdist 管理 CLI（SSH 调服务器 admin-* 子命令，与 cmsgate 共用管理口令）
│   ├── ctl_ui.py · ctlui/       cmsdist 本机网页看板（只绑 127.0.0.1，四层防护，cmsui 同款设计语言）
│   ├── ed25519.py               纯标准库 Ed25519 签名/验签（自动更新清单的签名根）
│   ├── rngparity.cpp            布雷 RNG 对拍（供 web/test/rng-parity.mjs 比对）
│   ├── imgprobe.cpp             图片闸门自检（43 例 + 全截断 + 位翻转；--gate 供脚本断言）
│   ├── imgprobe_cases.py        生成畸形图片样本驱动闸门（含 70 字节炸弹）
│   ├── seedws.cpp               JSON 空白判据的 C++ 侧（与 web/test/seed-ws-parity.mjs 对拍）
│   ├── seedparse.cpp            种子明文解析契约的 C++ 侧（与 web/test/seed-parse-parity.mjs 逐字节对拍）
│   ├── fuzz_seed.cpp            种子解析器模糊测试（ASan + UBSan）
│   ├── desktop_header_probe.py  桌面端顶栏几何探针（坐标公式复算 + 两两求交）
│   ├── check_invariants.py      静态不变量：图片闸门不被绕过 / 三端口径一致 / 日志不泄 token
│   ├── gate_manager.py          网页版访问密码管理（本地 CLI，见 docs/密码闸门.md）
│   ├── gate_ui.py               同一份密码表的只读/管理网页界面（只绑 127.0.0.1）
│   ├── gateui/                  gate_ui 的前端静态资源（index.html / app.js / app.css）
│   ├── webbg/                   登录页背景图素材（webbg 部署流程用）
│   ├── test_crop_cdp.mjs        CDP 像素探针（棋盘裁切回归用）
│   ├── test_gate_ui.py          闸门 CLI + 界面安全回归（纯标准库）
│   └── mac-backup-pull.sh       Mac 侧异地拉取快照（由 LaunchAgent 调用）
├── cmake/
│   └── mingw-w64-toolchain.cmake      Windows 交叉工具链
├── src/
│   ├── desktop/                 SFML 表现层——除 FileDialog 外不碰平台 API
│   │   ├── main.cpp             主循环：事件分发、计时与暂停、难度、面板路由、种子导入导出、F1~F5 功能键
│   │   ├── Renderer.h / .cpp    全部绘制与面板交互：表头 / 棋盘 / 标记菜单 / 设置 / 帮助 / 确认框 / 种子界面
│   │   ├── SettingsIO.h / .cpp  settings.ini 读写、配置目录与图片槽位管理（safeImageName 防穿越）
│   │   └── FileDialog.mm / FileDialog_win.cpp   原生文件选择框（macOS / Windows 各一）
│   ├── core/                    纯逻辑层——零 SFML、零平台 API，可独立编译（网页版 WASM 预留）
│   │   ├── Cell.h               MineType 枚举 + Cell 结构（realSum / imagSum / minesAround）
│   │   ├── ComplexMath.h        模长、最大平方因子、最简根式、提示分类
│   │   ├── Board.h / .cpp       布雷与首点安全、open / chordOpen 三态、双判胜口径（union-find + 锚定表）
│   │   ├── Difficulty.h         kDiffs[3] 三档难度（9x9x12 / 16x16x40 / 24x16x72）
│   │   ├── Seed.h               种子/存档 JSON 读写与校验（seedIsSane）、加密口令所在
│   │   ├── SaveGame.h           进度存档序列化 / 回放
│   │   ├── Rabbit.h             RFC 4503 流密码
│   │   └── SetupConfig.h        自定义局参数与现场钳制（clampToBoard）
│   └── solver/
│       └── SolverEngine.h       约束推理引擎（仅供 solver CLI 复盘统计；游戏内自动解题已移除）
├── web/                         网页版（TypeScript 5.9 + 手写 Canvas2D，仅依赖 typescript）
│                                ts/ 下 13 个源文件为真源，dist/ 为 tsc 产物（已 gitignore）；
│                                fx.ts 是装饰特效层（星光 / 流星 / 爆圈），与桌面端 Renderer::drawFx 同参。
│                                canvas 铺满整个视口，背景图按 cover 等比缩放铺满整屏
│                                （**不拉伸**，只裁切）；顶栏两侧与棋盘边缘对齐并带半透明底板。
│                                与 C++ 是文本级 1:1 移植而非代码复用；布雷 RNG 两端同规格
│                                （src/core/Rng.h 与 web/ts/rng.ts 逐位对齐，rngparity 目标自动对拍），
│                                同一 seed 在两端生成完全相同的雷局——种子跨端互通是分享功能的地基。
│                                种子**明文解析**也同规格（src/core/SeedJson.h 严格 JSON 解析器 ↔
│                                JSON.parse，两端统一 fail-closed 契约，seedparse 目标逐字节对拍）。
│                                gate/ 是密码页（零依赖纯 HTML/CSS/JS，刻意不引用 dist/*.js）；
│                                test/ 是 CDP 交互与闸门回归（零第三方依赖）。
├── server/                      访问闸门与运维（纯 Python 标准库 / POSIX shell）
│   ├── authd.py                 nginx auth_request 后端，只监听 127.0.0.1:8090
│   ├── cmsgate.service          systemd 单元（非 root 用户 cmsgate + 沙箱）
│   ├── cmsgate-healthcheck.sh   十三项探活（服务器线上版十四项，第 14 项 QQbot 不进仓库）+ Healthchecks 成功/fail ping
│   ├── cmsgate-healthcheck.{service,timer}   每 2 分钟触发探活
│   ├── cmsgate-backup.sh        每日 03:17 快照到 /root/cms-backup（留 28 份、600 root）
│   ├── cmsgate-backup.{service,timer}        每日快照的定时器
│   └── RESTORE.md               从快照恢复的完整步骤（含「别 chown -R」的陷阱）
├── assets/                      字体、内置背景 bg.jpg、dmg_bg（dmg 专用素材，app 包内排除）
├── third_party/                 SFML-3.0.2 / freetype 源码树 + 钉住 sha256 的官方 tarball
├── docs/项目结构说明.md          项目定位、逐文件职责、关键机制与构建全链路（推荐先读）
├── docs/服务器迁移与排行榜方案.md   网页版 + 三端排行榜规划
└── 文档：README.md / Release notes.md / docs/使用说明.txt / docs/项目结构.txt / docs/游戏玩法说明指引.txt / docs/CLION-交叉编译配置.md
```

**不该提交进仓库**（.gitignore 已覆盖）：`build*/`、`build-win*/`、`cmake-build*/`（构建目录）、`dist/`（分发产物，走 GitHub Releases）、`复数扫雷项目介绍.key`（Keynote 演讲文稿，二进制且体积大，需分享走 Releases）、`.idea/`、`.DS_Store`、`*.profraw`、`base`（编译产物）、`third_party/sfml-win/`、`third_party/freetype-win/`（交叉编译中间物）。

## 十、实现要点（铁律与历史坑）

- **颜色**：macOS 把 SFML 窗口 framebuffer 按 Display P3 解释，直接填 sRGB 十六进制会偏艳（#66CCFF 实测显示成 (46,207,255)）。所有颜色经 `displayColor()` 做 sRGB→P3 预补偿，用户自定义图片解码后同样处理；Windows 不补偿。
- **文字**：SFML 3 的 `sf::String(std::string)` 按 ANSI/locale 解码，非 ASCII（±、√、中文）必须 `fromUtf8`。
- **文字清晰**：SFML 3 的字体纹理默认线性过滤且无公开 API 关闭，文字发虚。解法：每次创建 `sf::Text` 前对 `font.getTexture(size)` const_cast 后 `setSmooth(false)`（集中在 `textSpr` / `textTLSpr` / `textCJKSpr` 三处，字体加载后也对 8~48 号预设置一遍）。RenderTexture 预渲染再贴图的方案在 SFML 3.0 实测完全不可行（文字整片变白块），不要再走回头路。
- **窗口尺寸必须同步视图**：SFML 3 的 `RenderWindow::onResize()` 只重算 viewport，**不会**更新视图尺寸（与 SFML 2 行为不同）。`setSize()` 之后若不显式 `setView(sf::View(sf::FloatRect({0,0}, 新窗口尺寸)))`，整幅画面会按 (新窗口 / 旧视图) **非等比缩放**——格子被拉成非正方形、右对齐控件跑出窗口、内容整体偏向左上。切换难度（9x9 / 16x16 / 24x16 / 自定义）时必现，因为只有启动时的默认难度走 `create()` 能正确初始化视图。`applySize()` 与事件循环的 `Resized` 两处都要同步；视图与窗口一致后，鼠标命中检测（`cellAt` 用窗口像素比对布局坐标）也才成立。
- **富文本量宽**：逐片段 / 逐字布局必须用排版步进 advance 累加（`textAdvanceOf()`），不能用 `getLocalBounds` 的"墨迹宽"——后者整串测量误差只有首尾，逐字累加会按字数累积成文字重叠。SFML 3.0.2 的 characterSize 为 unsigned，**字号只能整数**（0.5 被静默截断）。
- 布雷在首点，排除点击格（棋盘 ≥ 雷数+9 时连八邻域排除）；flood 只在 minesAround == 0 处扩散，带提示的边界格（含黄 0）翻开但不再扩散；标记不排除布雷（标记只是猜测）。
- `Board::setMagnitudeMode` 只切判胜口径、不动棋盘；won() 为活判；开局 / 开自定义 / 载种子三处必须按当前设置同步口径，否则口径漂移。
- PLAY AGAIN 的显示与点击判定共用单一状态（`playAgainVisible_`），渲染循环一处同步，覆盖所有胜负翻转路径。
- 一切"现场算出的上限"（行列 / 窗口）与展示、拒收、步进、提交校验**同源**：四条路径各自现场调用同一计算函数，禁止启动时缓存、禁止 keep 旧值逻辑盖掉新值（历史上曾因此放行 40 行又在 START 按 25 拒绝）。
- 会丢进度的入口（↻ / 难度 / 自定义 START）统一走确认框 + `pendingDiff` 挂起；ConfirmHit::Yes 的分派必须覆盖所有 ConfirmKind（漏一种会走错分支）；Cancel / 点窗外一律作废。
- 输入校验：`seedIsSane()` 拦超大 / 非法棋盘（防 cols=99999 申请 ~199GB 必崩）；`safeImageName()` 拦 settings.ini 里的路径穿越（防借 RESTORE ALL 删配置目录外文件；除 `/ \ ..` 外还挡 Windows 盘符冒号与设备名——`C:foo.png` 是盘符**相对**路径）；`cellAt()` 钳制行列（防点窗口边距产生幽灵格越界读）。种子非手动分型时 realMines/imagMines 恒为 -1，是合法状态，只有 < -1 才非法。
- **图片必须在解码前验尺寸，且解码的就是验过的那份字节**：`sf::Image::loadFromFile` 是整幅解码，而「先解再判像素」来得太晚——70 字节的 PNG 能声明 20000×20000，解码要约 2.1GB，`loadFromFile` 里再 resize 一份 → 峰值约 4.2GB → 未捕获 `bad_alloc` → 直接 terminate（加文件大小上限拦不住）。现在两道闸门都在 `src/desktop/ImageProbe.h`：字节数 ≤ **24 MiB**（decode 之前就拒），解码后**总像素** ≤ **4096×4096**（≈1677 万；判据是 w×h，不是长边——产物本来就要等比缩到 2560 / 1280 以内，超了也一寸用不上）。再叠加防 TOCTOU：`ms::imgprobe::readWholeFile` 一次读出字节（顺带拒符号链接、按 stat 钳制长度），同一份 buffer 交给 `loadFromMemory`，不再有「probeFile 验完、再按路径 open 一次」的窗口。`src/desktop` 里 `loadFromFile` 的出现次数被 `tools/check_invariants.py` 钉成 **0**，而 `readWholeFile` + `loadFromMemory` 必须出现在 `loadImageChecked` 里。超限提示带实际宽高与万像素（如「图片尺寸 3500×5000（约 1750 万像素）」），网页端同口径。
- 格式化：setw 补零会把负号计入宽度（产出 0-5 畸形），负数先输出负号再对绝对值补位。
- Rabbit 三个易错点（见 `src/core/Rabbit.h` 注释）：子密钥 K0 取密钥最高 16 位、128 位输出块按整体大端字节串、计数器异或后不要再迭代 4 次。
- 纹理须在 GL 上下文就绪后加载（`loadBackground` 幂等，窗口创建后调用）；`setTexture` 要传 `resetRect=true`，否则空纹理的 0x0 矩形画不出东西。
- **网页版（`web/ts/`）与桌面端是两份独立实现，下列各点必须手工同步**（全是历次漂移踩出来的）：`cellAt` 的命中语义（间隙吸附到后一格；判空会让 13%（40px 格）~21%（24px 格）的面积点不动，且它是点击 / 右键菜单 / 中键 chord / 悬停高亮的唯一入口）、`chordOpen` ⇄ `boardChord` 的三态取值（`NotApplicable=0, Opened=1, Blocked=2`；两端曾把 1/2 互换，各自解读时无感，一旦共用规则 / 编 WASM 就会错读）、胜负判定与帮助文案、种子的范围校验（**只有一份 `seedIsSane`，网页端必须复用 `seedcodec` 的那份，不要再抄第二份**）、RESTORE ALL 的覆盖面（含背景不透明度）、终局横幅的 Esc 关闭、载入种子 / 复现局后的计时冷启动。改任一处务必同时改另一端。
- 测试网页版交互用 `web/test/cdp-interaction.mjs`（CDP 派发**真实**鼠标 / 键盘事件，零第三方依赖；合成事件不触发默认动作，复现不了焦点类 bug）。脚本自带产物新鲜度检查（dist 必须比 ts 新）。注意 `boardChord` **自身就会把邻居翻开**（副作用），所以「邻居被翻开」不能用来判定返回码 —— 必须断言 `doChord` 走了哪个分支（成功不提示 / 被阻挡提示 `BAD MARKS`）。桌面端没有 GUI 自动化框架，行为类改动可用 env 门控自检（在渲染循环里按帧号触发并打印状态，验证后删除）实测。
- **种子明文解析必须两端同规格**（2026-10-22 安全审计 P11）：桌面端此前是**手写扫描器**（`seedJsonField` / `seedJsonIntClamped` / `seedJsonStringArray`），它把 `"cols": 9.5` 静默**回退成默认值 9**；网页端用 `JSON.parse` 得到 `NaN`（`NaN < 5` 与 `NaN > 300` 都是 false，`seedIsSane` 全是比较式判断、没有 `Number.isFinite` 兜底 → NaN 全部通过）→ **同一颗种子串在两端解出不同棋盘**，排行榜回放校验的地基就塌了。现在两端统一：桌面端改用 `src/core/SeedJson.h`（递归下降的严格 JSON 解析器，语义对齐 V8 `JSON.parse`：拒绝尾随垃圾 / 尾随逗号 / 前导零 / `+1` / `NaN`，重复键取后者且位置保持首次，深度上限 200），网页端补齐 `Number.isFinite` + `Number.isInteger` 检查；**契约统一为 fail-closed —— 字段存在但类型 / 值不合法就整条拒收，绝不静默回退默认值、绝不产生 NaN**。另有「扁平形状」规则（禁止嵌套容器）消掉两端深度上限差异造成的判定分歧。行为一致性由 `web/test/seed-parse-parity.mjs` 与 `tools/seedparse.cpp` **逐字节对拍**钉死（30 例，含 8 类修复前的分歧点）；**改任一端解析逻辑都必须重跑这条闸门**。

## 十一、第三方依赖与版权

- **SFML 3.0.2**（zlib 许可）——窗口 / 渲染 / 输入
- **FreeType 2.13.2**（FreeType License，与 zlib 兼容）——字形光栅化
- **libpng**（PNG 许可）——macOS 分发包内的 PNG 加载链
- **IBM Plex Serif**（SIL OFL 1.1）——界面字体（`assets/IBMPlexSerif-Regular.ttf`）
- 中文使用系统中文字体（macOS Hiragino Sans GB 等 / Windows 雅黑黑体等 / Linux Noto CJK，候选顺序见 `Renderer::loadCjkFont`）
- **游戏背景图《云上城堡》**——画师 木子森森森MORI（授权使用；视频原稿 https://b23.tv/rHT5In4，BV1rV411T7GH）
- dmg 安装盘背景（`assets/dmg_bg.png` / `@2x`）为程序生成素材，不随游戏包分发

## 十二、网页版与访问闸门

网页版对外只有一个地址：`https://ty0712.com/`（ICP 备案已下；80 端口除 ACME 续期挑战外一律 302 到 https）。
历史上那个 `http://<公网IP>:8080/` 内测入口已在 2026-10-20 **收回服务器内部**（只绑 127.0.0.1），
自己要用时开一条 SSH 隧道即可：`ssh -p <SSH端口> -L 18080:127.0.0.1:8080 root@服务器`，本地开 `http://127.0.0.1:18080/`。
源码在 `web/`，部署脚本 `scripts/web/deploy-web.sh`（改 nginx 配置前先备份，`nginx -t` 失败自动回滚再 reload）。

**它有一道密码门**：没通过验证的人**看不到游戏**——游戏地址 `/game`（以及 `dist/*.js` 等游戏资源）
一律返回 404（当作不存在），不是前端遮一层；密码页只在随机不可猜的 `/gate/<TOKEN>/` 可达，
而且**已登录的人打开它会被直接送进 `/game`**，不用再输一次。

**根路径有两种模式**（`cms landing game|learn`，要管理口令）：

| 模式 | `/` | `/learn/` | 其他路径 | 游戏 |
|---|---|---|---|---|
| `learn`（学习站） | 302 到公开学习站 | 学习站 | 404 | `/game`，未登录 404 |
| `game`（开放站） | 302 到 `/game` | 学习站 | 302 到 `/game` | `/game`，未登录 404 |

两种模式下 `/game` 都要过密码门，区别只是「陌生人敲域名看到什么」：学习站模式下看到的是
真正的 C++ 教学站，开放站模式下直接撞上 404（等于告诉你这儿没东西）。会话是关掉浏览器即失效的
cookie，最长 24 小时。
鉴权服务 `server/authd.py`（仅 Python 标准库、只监听 `127.0.0.1:8090`）由 nginx 的
`auth_request` 调用，密码以 scrypt 哈希存在 `/var/lib/cmsgate/`。
证书由 `deploy-https.sh` 签 Let's Encrypt，443 由「开关片段」按证书在不在决定是否监听。
✅ 明文通道已收口：80 强制 302 到 https，会话 cookie 在 https 侧带 `Secure`（按 scheme 条件加，
所以回环那侧照常能登出），域名侧的密码与 cookie 不再明文过网。HSTS 已开（2026-10-21 单独点头，
`max-age=15552000` = 180 天，只发 https 侧；理由与「为什么不是 365」见 `docs/密码闸门.md` 的 HTTPS 一节④）。
⚠️ **但这道门仍只是「防误入 / 软隔离」，不是安全边界**：入口 token 走的是 URL（会进访问日志、
会被浏览器历史与 Referer 侧留存），密码表本身是共享口令，HSTS 也只管已经见过 https 的人。
完整架构、运维命令与排查表见 `docs/密码闸门.md`。

### 存活监控与数据备份

**探活（出站死人开关）**：`server/cmsgate-healthcheck.sh` 由 systemd timer 每 2 分钟跑一次，
八项全绿才向 Healthchecks.io 发一个成功 ping；任一项失败发 `/fail`，整机宕机 / 网络断则靠
「ping 不来」在 period + grace（约 7 分钟）后告警。八项 = ① cmsgate 服务在跑 ② authd `/health` 真响应
③ nginx 在跑 ④ 未登录访问 `/dist/main.js` 必须 404（闸门被绕过时这里会变成 200）⑤ 系统盘与数据盘均 <90%
⑥ 秘密登录入口返回 200 且正文含 `gate-form` ⑦ 证书剩余 ≥14 天（续期失败在到期前线上毫无症状）
⑧ 最新快照 <26 小时（备份失败是最安静的故障）。
ping URL 是密钥（持有者可伪造「正常」），只存服务器 `/etc/cmsgate/healthcheck.url`（600 root），
经 stdin 注入，不进 git、不进 argv。

**备份（两层）**：服务器每天 03:17 把 `/var/lib/cmsgate`（密码表、`secret.key`、`usage.jsonl`、背景图私藏目录）
连同登录入口片段一起打成快照放进 `/root/cms-backup/`，保留 28 份、600 root；Mac 侧 LaunchAgent
每小时（以及每次登录）rsync 到 `~/Backups/cms/`，保留 1000 份。token 随快照走是刻意的取舍——
否则换机器恢复完全部数据，所有存着旧链接的人却集体登不进来。恢复步骤见 `server/RESTORE.md`
（**不要无脑 `chown -R`**：数据目录里几样东西的属主并不相同，整目录递归会改坏背景图目录与片段副本）。

### 可视化界面（可选）

除了 CLI，还有一个**只在本机可访问**的网页界面，管理同一份密码表：

```bash
python3 /Users/wenweiqi/CLionProjects/Project/tools/gate_ui.py            # 终端会打印一条带 ?k= 的网址，用浏览器打开
```

它不新增任何依赖（标准库起的 `http.server`），**只绑 `127.0.0.1`**，并且有四层防护挡住
「浏览器里任意网页偷偷操作本地服务」这条攻击路径：一次性 token、Host 头白名单（防 DNS
rebinding）、POST 必须带自定义头（防 CSRF）、写操作仍要管理口令。

> ⚠️ 写操作**不在界面里做权限判断**——它转调原来的 CLI，管理口令校验永远只有一份实现。
> 也就是说界面绕不过那道门；关掉界面，`cms` 那套命令一个字都没变。

安全回归：`python3 /Users/wenweiqi/CLionProjects/Project/tools/test_gate_ui.py`（706 项全绿，纯标准库，不需要浏览器）。

密码由**本地** CLI 管理（服务器上不跑管理程序）：

> macOS 自带的 `/usr/bin/python3` 是 3.9.6、链接 LibreSSL，**没有 `hashlib.scrypt`**，
> `add` / `passwd` / `selftest` 会失败（`list` 不受影响）。工具检测到会**自动换成能用的解释器重跑**，
> 想显式指定就用 `python3.13`。

**先配一次别名**（往 `~/.zshrc` 末尾加，然后 `source ~/.zshrc`）：

```bash
# 网页版访问闸门：密码管理工具（数据在 ~/.cmsgate，任何目录都能跑）
alias cms='python3 /Users/wenweiqi/CLionProjects/Project/tools/gate_manager.py'
```

之后 `cms list` / `cms push` 这样写就行，**在任何目录都能用**（数据存在 `~/.cmsgate/`，
与当前工作目录无关，不需要 `cd` 到项目）。没配别名就用完整路径
`python3 /Users/wenweiqi/CLionProjects/Project/tools/gate_manager.py <命令>`。以下例子都简写成 `cms`。

按场景查（`<id>` = `list` 输出第一列那个 12 位十六进制串）：

| 你想做的事 | 敲这条 |
| --- | --- |
| 看现在有哪些密码、谁在用 | `cms list` |
| 看网站现在要不要密码 | `cms gate status` |
| 给别人一个密码（随机生成，明文只显示一次） | `cms add --label "给小明"` |
| 自己定密码（不回显，输两遍） | `cms add --label "我" --password-prompt` |
| 限时给某人（N 天后自动失效） | `cms add --label "给小红" --days 30` |
| 改标签 / 备注 | `cms note <id> --note "换了备注"` |
| 让某人立刻进不来（记录保留） | `cms disable <id>` |
| 恢复 | `cms enable <id>` |
| 换掉某个人的密码 | `cms passwd <id>` |
| 彻底删掉 | `cms rm <id> --yes` |
| 设/改有效期 | `cms expire <id> --days 7`（`--never` 取消） |
| 踢掉所有人（**含你自己**） | `cms revoke-all --yes`（不带 `--yes` 只预演） |
| 临时开放给所有人 | 先 `cms admin-init`，再 `gate off`；恢复用 `gate on` |
| 看谁在用 | `cms usage --remote` |
| 查某个人都干了什么 | `cms show <id>` |
| 撤下网页背景图（纯白底） | `cms webbg off`（`webbg on` 恢复） |
| 换一张背景图 | `cms webbg push --image ~/图.png`（自动转 webp + jpg） |
| **改完必须推，否则线上不生效** | `cms push` |
| 自检（无副作用） | `cms selftest` |
| 全部命令 / 单个命令参数 | `... --help` / `... <命令> --help` |

**最常见的事故**：`add` 完忘了 `push` → 去浏览器试显示"密码不正确"。工具现在会在
`add` / `passwd` / `rm` / `disable` 等命令末尾与 `list` 末尾醒目告警本地与线上是否一致。

### 网页背景图（公开授权还没拿到，所以要能一键撤下）

背景图的**公开使用授权还没拿到**。在那之前，`cms webbg off` 能把游戏与密码页一起
换成纯白底，**而且原图会从公开目录消失**——挪进 `/var/lib/cmsgate/webbg/`
（nginx 不服务那个目录），所以 `wget /assets/bg.webp` 只能拿到一张几十字节的白图。
`webbg on` 随时搬回来；`webbg status` 只读。

| 想做的事 | 敲这条 | 要管理口令 |
| --- | --- | --- |
| 看现状（开/关、文件大小、有没有备份） | `cms webbg status` | 否 |
| 撤下（纯白底） | `cms webbg off` | 是 |
| 恢复 | `cms webbg on` | 是 |
| 换新图（自动转 webp + jpg） | `cms webbg push --image ~/图.png` | 是 |

密码管理界面（`cmsui`）顶栏有「网页背景」芯片，点开能**看到当前这张图的预览**、**下载**
webp / jpg，以及同一个开关 + 推送按钮（选文件 → 转码 → 上传，不用手打路径）。

**四条必须知道的边界**：

1. **已经加载过图的浏览器，内存里仍有那张图**——浏览器行为，撤不回来。
   新访问 / 刷新才会看到白底。
2. **缓存头要配合，而且必须是 `no-store`**。背景图这两个文件 2026-10-17 改过两次：
   最早是 `expires 7d`（已访问过的访客最长 7 天不重新请求，"关掉了却没变白"）；
   第一次改成 `no-cache, must-revalidate` **仍然不够** —— 访客浏览器手里那份**旧响应
   自带 `expires: 7d`**，客户端根本不看服务器后来改的头，实测换图后普通刷新仍显示旧图、
   只有强刷才对。现已改成 `Cache-Control: no-store`（任何客户端都不许存），
   换图后**普通刷新就生效**。代价是每次都重传 ~136 KB，对密码页可接受。
3. **推图时自动压到长边 1920**（`WEBBG_MAX_EDGE`）。背景图是 `background-size: cover`
   铺满的，超过屏幕的分辨率纯属浪费：同一张图 4800 宽时 webp 511 KB，压到 1920 后
   只要 136 KB（省 74%），1440 屏上肉眼无差别。**原图会一并存到服务器**的私藏目录
   （只留当前这张），日后想换尺寸重转不用再找原图。
4. **再跑 `deploy-web.sh` 会用本地 `web/assets/bg.*` 覆盖线上**（`rsync --delete`）。
   所以推完新图要把本机那两张也换成同一张，否则下一次部署会把新图无声推回旧的。
   `webbg status` 会检出这种漂移。

两个约定：时间列默认按**本地时区**显示（存储与传输一律 UTC），加 `--utc` 看原值；
表格按**显示宽度**排版（CJK 记 2 列），所以中文标签不会把列挤歪——有自检覆盖。

**谁会掉线？** 只有 `passwd` / `rm` / `disable` / 到期 / `revoke-all` 会让已登录的会话失效
（cookie 里记着 `pwid` + `rev` + `gen`，服务端每次请求都重比）；**普通 `push` 不会**
（`add` / `note` 之后推上去，正在玩的人不受影响）。`revoke-all` 踢的是**所有人，包括你自己**，
所以它默认只"预演"：不带 `--yes` 什么都不做，加 `--yes` 才执行、并顺手推送（一次到位）。
被停用/已过期的用户会看到各自的提示，不会显示成"密码不正确"。

**总开关**（`gate status|on|off`）改的是服务器上的 `gateconfig.json`，**两个方向都要管理口令**；
该文件不存在时一律按"需要密码"处理（fail-closed），所以读不到配置不会把站点敞开。

⚠️ **访问记录里存的是明文 IP**（另有 IP 哈希与解析出的浏览器/系统/设备），
比之前的"只存哈希"更敏感——权限、分享前要删哪些字段、轮转策略见 `docs/密码闸门.md`
的「访问日志与隐私」一节。

**访问密码可以自己定**（`add` / `passwd` 都行），三种来源互斥：不给参数就**随机生成**；
`--password-prompt` 交互式**不回显**输入（推荐）；`--password-stdin` 从管道/文件喂。
**不许写 `--password 明文`**——argv 会被 `ps aux` 看到、还会进 shell 历史，工具会明确拦下并告诉你改用哪个。
下限 12 个字符，详见 `docs/密码闸门.md`。

⚠️ **网页版的铁律：受保护响应绝不能带长缓存。** nginx 里正则 location 压过普通前缀，
所以 `location /dist/` 挡不住带 `expires` 的正则 location——曾经因此让浏览器 7 天不发请求、
直接用缓存进游戏（闸门被绕过，只有 F5 才弹密码页）。凡挂了 `auth_request` 的 location
都不许出现 `expires`，只能 `no-store` / `no-cache, private`；`deploy-web.sh` 有断言守着这条。
详见 `docs/密码闸门.md`。

部署顺序不能反：先 `scripts/web/deploy-gate.sh`（服务），再 `scripts/web/deploy-web.sh`（网关）。
反了会闸门先开、后端不在，谁都进不去。

## 十三、分布式求解器跑分（cmsdist）

把 `solver` 的免猜率统计拆成众包：公开调度服务 **http://ty0712.com:7120**，
测试者拿客户端**无需任何密钥**，`--name 名字` 就能领任务跑分。三平台成品包
（macOS dmg / Win64 zip / Linux tar.gz），Ed25519 签名自动更新，结果按**求解器源码指纹**归因版本。

```bash
python3 tools/dist_client.py --server http://ty0712.com:7120 --name 我的机器   # 跑分（测试者）
python3 tools/distctl.py status                                                # 管理看板 CLI
ctlui                                                                          # 本机网页看板 127.0.0.1:8712
bash scripts/dist/package-dist-client.sh                                       # 重打客户端 + 发版
bash scripts/dist/deploy-dist.sh                                               # 部署调度服务到 ECS
```

架构、任务协议、指纹归因、自动更新链路、运维与历史坑：`docs/分布式跑分cmsdist.md`。
5×100 专家盘舰队验收结果记在 `docs/求解器第四代报告.md` 性能验收一节。

## 十四、文档地图

- `Release notes.md` —— GitHub Releases 发布页说明（Beta 安装、反馈方式、注意事项）
- `docs/服务器迁移与排行榜方案.md` —— 网页版（core 编 WASM）+ 三端排行榜方案：服务端下发种子、用同一份 core 回放动作日志校验（反作弊根基）、用时可信度分级
- `docs/密码闸门.md` —— 网页版访问密码闸门：架构、`gate_manager.py` 日常操作、部署顺序、运维排查、已知限制（明文已收口，但仍是软隔离）
- `docs/分布式跑分cmsdist.md` —— 分布式求解器跑分（7120）：任务协议与 nonce 防作弊、三平台客户端、求解器指纹归因、Ed25519 签名自动更新、ctlui 看板、打包发版与运维、历史坑
- `docs/求解器第四代报告.md` —— 第四代（分层 BucketDP + 宽 9）的迭代过程、配对大样本数据、性能验收（含 cmsdist 舰队 5×100 专家盘）、否证清单
- `server/RESTORE.md` —— 从每日快照恢复闸门数据与登录入口：三种场景、逐项验证清单、哪些情况**不能** `chown -R`
- `docs/待办清单.md` —— 已完成事项的验收记录 + 真正的未完事项（跨端差异、需要手动做的那一步）
- `docs/使用说明.txt` —— macOS 分发包内给接收方的说明（docs/ 下为唯一来源，用户维护）
- `docs/游戏玩法说明指引.txt` —— 游戏内 ? 帮助面板的文案原文与样式标注版（与 `Renderer` 的 buildHelp 落地一一对应）
- `docs/项目结构说明.md` —— **推荐先读**：项目定位、玩法机制、逐文件职责、关键实现机制（带行号）、构建与分发全链路、web 版与 C++ 版的关系
- ~~`docs/安全与体验审查.md` · `docs/安全审查_2026-10-27/10-30/11-01.md`~~ —— 各轮安全/体验审查的逐条发现与处置：**2026-11-06 起移出仓库**（`~/私有/cms审计文档/`），内容是服务器防御布局的内部清单，不对外
- `docs/参赛材料_Qoder大赛2026.md` —— 天池大赛 532536 参赛文稿素材
- `docs/项目结构.txt` —— 2026-10-13 的历史快照（**已被 `docs/项目结构说明.md` 取代**，仅作对照）
- `docs/CLION-交叉编译配置.md` —— CLion 的 Windows 交叉编译工具链与 CMake Profile 设置

LICENSE 尚未选定，正式发布前补充。
