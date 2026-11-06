# 在 CLion 里配置 Windows 交叉编译（macOS 主机）

目标：用 CLion 一键编出 Windows x64 的 `ComplexMinesweeper.exe`。

> 本机环境（已确认）：CLion 2026.2.3.1、Homebrew 前缀 `/opt/homebrew`、
> CLion 自带 CMake `/Applications/CLion.app/Contents/bin/cmake/mac/aarch64/bin/cmake`、
> 自带 Ninja `/Applications/CLion.app/Contents/bin/ninja/mac/aarch64/ninja`

---

## 第 0 步：装交叉编译器（只做一次）

终端执行：

```bash
brew install mingw-w64
```

装完验证（能打印版本就成功）：

```bash
x86_64-w64-mingw32-g++ --version
```

---

## 第 1 步：先用脚本把 SFML 交叉编译好

CLion 只管编我们的游戏，SFML 需要先有一份 **Windows 版静态库**。
在项目根目录执行一次：

```bash
./scripts/game/build_windows.sh
```

它做完三件事：下载 SFML 3.0.2 源码 → 用 MinGW 交叉编译成静态库（输出目录
`build-sfml-win/`）→ 顺便把你的游戏也编一遍，产物在
`dist/ComplexMinesweeper-win64/`。

> 只有第一次需要（SFML 编译要几分钟）。以后改了代码，CLion 里增量编译即可，
> 不用再跑这个脚本。

脚本会把两份依赖都交叉编译并**安装到项目内的 prefix** ：

- `third_party/freetype-win/`   （静态 freetype）
- `third_party/sfml-win/`       （静态 SFML，配置在 `lib/cmake/SFML/`）

> 为什么需要 freetype：SFML 的图形模块依赖它，而 SFML 默认会从 GitHub 克隆 ——
> 本机直连 GitHub 不通，脚本用镜像下载后自己交叉编译，并让 SFML 走 `SFML_USE_SYSTEM_DEPS=ON`。
---

## 第 2 步：在 CLion 里新建 Toolchain

`Settings / Preferences → Build, Execution, Deployment → Toolchains → ＋`

| 字段 | 填什么 |
|---|---|
| Name | `MinGW-w64 (cross)` |
| Type | **System** （不要选 MinGW —— 那是给 Windows 主机本地 MinGW 用的；若你的 CLion 版本里 MinGW 类型可用且能通过校验，也可以选它） |
| C Compiler | `/opt/homebrew/bin/x86_64-w64-mingw32-gcc` |
| C++ Compiler | `/opt/homebrew/bin/x86_64-w64-mingw32-g++` |
| Debugger | `/usr/bin/lldb`（填上只为消红字告警，Windows 程序本地调试不了） |
| CMake | 用 CLion 自带的，或 `/opt/homebrew/bin/cmake` |
| Build tool | Ninja（CLion 自带那个路径） |

> 校验时如果只报"Debugger 不可用"这类提示，可以忽略——构建不受影响。

---

## 第 3 步：新建 CMake Profile

`Settings / Preferences → Build, Execution, Deployment → CMake → ＋`

| 字段 | 填什么 |
|---|---|
| Name | `Windows-x64-Release` |
| Toolchain | 选第 2 步建的 `MinGW-w64 (cross)` |
| Generator | `Ninja` |
| Build type | `Release` |
| Build directory | `cmake-build-win` |
| CMake options | 见下 |

CMake options（**一行**，SFML_DIR 换成你的项目绝对路径）：

```
-DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-toolchain.cmake
-DCMAKE_PREFIX_PATH=/Users/wenweiqi/CLionProjects/Project/third_party/freetype-win
-DSFML_DIR=/Users/wenweiqi/CLionProjects/Project/third_party/sfml-win/lib/cmake/SFML
```

> 相对路径 `cmake/mingw-w64-toolchain.cmake` 是相对**项目根目录**解析的，所以只要你从
> 项目根目录打开工程就没问题；保险起见也可以写绝对路径。

> `SFML_STATIC_LIBRARIES`（静态库）、`-mwindows`（隐藏控制台）、
> `-static -static-libgcc -static-libstdc++`（不带 GCC 运行时 DLL）都已经写在 CMakeLists 里，
> CMake options **不需要**再手写这些。
---

## 第 4 步：编译

1. 右上角构建配置下拉框切到 `Windows-x64-Release`
2. 按 `⌘F9`（Build）或点小锤子
3. 产物：`cmake-build-win/minesweeper.exe`

**运行/调试是灰的或者点不动，这是正常的** —— macOS 执行不了 Windows 程序。想验证：

- 拷到 Windows 机器上双击运行
- 或者本机用 Wine 冒烟测试：`brew install --cask wine-stable` 然后
  `wine cmake-build-win/minesweeper.exe`
- 进阶：Windows 上起 `gdbserver`，CLion 用 Remote Debug 连过去

---

## 发布时别忘了 assets

Windows 版**没有**把资源路径写死（macOS 版同样走候选路径列表），程序按
`resourcePaths` 候选列表逐个尝试，最终会找
**exe 同级的 `assets/`**。所以发给别人时要给整个文件夹：

```
ComplexMinesweeper-win64/
├── ComplexMinesweeper.exe
├── assets/            （bg.jpg 与字体，缺了就没有背景图）
└── 使用说明.txt
```

脚本 `build_windows.sh` 已经自动组装好这个目录了；只想从 CLion 拿 exe 的话，
记得手动把 `assets/` 拷到 exe 旁边。

---

## 常见报错怎么办

| 现象 | 原因与处理 |
|---|---|
| `Could NOT find SFML` | `-DSFML_DIR` 要指向**含 SFMLConfig.cmake 的目录**（即 `build-sfml-win/`），先用 `ls` 确认 |
| `CMAKE_C_COMPILER not found` | mingw 没装好或路径不对；`x86_64-w64-mingw32-g++ --version` 验证 |
| CMake 卡在 `try_compile` / 编译测试程序失败 | 交叉编译时 CMake 不能运行目标平台程序；工具链文件里已设 `CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY` 规避 |
| `undefined reference to WinMain` | 用了 `-mwindows` 却没有 WinMain；本项目只在 `SFML::Main` 存在时才隐藏控制台，正常不会出现 |
| 运行时弹出黑色控制台窗口 | 说明没链上 `SFML::Main`（不影响游戏，想隐藏可以手动加 `-mwindows` 并补 WinMain） |
| 游戏起来但没有背景图/字体 | `assets/` 没和 exe 放在同一层 |
| 中文路径报错 | 已用 `GetModuleFileNameW` + UTF-8 处理，正常不会有问题 |

---

## 不想折腾交叉编译的替代方案

- **在 Windows 机器上原生编**：装 MSYS2 或 vcpkg（`vcpkg install sfml`），最稳
- **GitHub Actions**：用 `windows-latest` runner 自动出包，本地什么都不用装
