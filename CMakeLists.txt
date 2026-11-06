cmake_minimum_required(VERSION 3.16)
project(minesweeper LANGUAGES CXX)

# ObjC++ 只有 macOS 需要（原生文件对话框用 NSOpenPanel）
if(APPLE)
    enable_language(OBJCXX)
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)   # 给 IDE / clangd 更好的索引

# 编译警告：尽早发现问题
if(MSVC)
    add_compile_options(/W4)
else()
    add_compile_options(-Wall -Wextra -Wpedantic)
endif()

# ── 编译硬化（2026-10-21 安全审查 M6）────────────────────────────────────
# 之前只有警告开关，没有任何**缓解措施**：别人给你一个存档/设置/图片，你导入时
# 只要还有一处没发现的越界写，就是可直接利用。纵深 defense 缺失 ≠ 现在就有洞，
# 但这层是白捡的保险。
#
# ★ 只在带优化的构建上开：FORTIFY / stack-protector 在 -O0 下基本无效，
#   而且 Debug 还要留着调试体验，所以用生成表达式绑到优化等级。
if(NOT MSVC)
    add_compile_options($<$<NOT:$<CONFIG:Debug>>:-fstack-protector-strong>)
    add_compile_options($<$<NOT:$<CONFIG:Debug>>:-D_FORTIFY_SOURCE=2>)
    # -fno-strict-aliasing 不加：那是在拿正确性换速度，而这里的类型转换很干净。
endif()

# 消毒器构建（跑测试用，不进发行包）：
#   cmake -S . -B build-asan -DCMAKE_BUILD_TYPE=Debug -DSANITIZE=address,undefined
#   cmake --build build-asan && ./build-asan/minesweeper
# MSVC 不支持这套开关，忽略。
option(SANITIZE "" "开启 ASan/UBSan（Debug 用；会变慢，不要用于发行）")
if(SANITIZE AND NOT MSVC)
    add_compile_options(-fsanitize=${SANITIZE} -fno-omit-frame-pointer -g)
    add_link_options(-fsanitize=${SANITIZE})
endif()

# Mac 上 Homebrew 的路径（Apple Silicon: /opt/homebrew，Intel: /usr/local）
if(APPLE)
    list(APPEND CMAKE_PREFIX_PATH "/opt/homebrew" "/usr/local")
    # 最低支持 macOS 13.0 (Ventura)：与 Homebrew SFML 3.0 对齐；
    # 不设的话 CMake 默认用编译机系统版本，导致旧 macOS 完全打不开。
    set(CMAKE_OSX_DEPLOYMENT_TARGET "13.0" CACHE STRING "Minimum macOS version" FORCE)
endif()

# Windows 包用静态 SFML：exe 不依赖任何 DLL，单文件好分发
if(WIN32)
    set(SFML_STATIC_LIBRARIES ON)
endif()

# 找到 SFML 3
find_package(SFML 3.0 REQUIRED COMPONENTS Graphics Window System)

# ---- 游戏本体（桌面端：SFML） ----
add_executable(minesweeper
        src/desktop/main.cpp
        src/core/Cell.h
        src/core/ComplexMath.h
        src/core/Board.h
        src/core/Board.cpp
        src/core/Difficulty.h
        src/core/Seed.h
        src/core/SaveGame.h
        src/core/Rabbit.h
        src/core/SetupConfig.h
        src/desktop/Renderer.h
        src/desktop/Renderer.cpp
        src/desktop/FileDialog.h
        src/desktop/SettingsIO.h
        src/desktop/SettingsIO.cpp)

# 平台相关的文件选择器实现
if(APPLE)
    target_sources(minesweeper PRIVATE src/desktop/FileDialog.mm)
elseif(WIN32)
    target_sources(minesweeper PRIVATE src/desktop/FileDialog_win.cpp)
endif()

target_include_directories(minesweeper PRIVATE src)

target_link_libraries(minesweeper PRIVATE
        SFML::Graphics SFML::Window SFML::System)

if(APPLE)
    target_link_libraries(minesweeper PRIVATE "-framework AppKit") # 原生文件选择框
endif()

if(WIN32)
    target_link_libraries(minesweeper PRIVATE winmm comdlg32)
    # GUI 子系统：运行时不弹出黑色控制台窗口（MinGW 的 crt 会自动调 main）
    target_link_options(minesweeper PRIVATE -mwindows)
    # 把 GCC 运行时也静态链进去，否则会依赖 libgcc_s_seh-1.dll / libstdc++-6.dll
    # （这些 DLL 在干净的 Windows 上并不存在，双击会直接启动失败）
    target_link_options(minesweeper PRIVATE -static -static-libgcc -static-libstdc++)
    target_link_options(minesweeper PRIVATE -Wl,--strip-all)   # 去符号，体积从 18MB 降到几 MB
    if(TARGET SFML::Main)
        target_link_libraries(minesweeper PRIVATE SFML::Main) # 提供 WinMain
        set_target_properties(minesweeper PROPERTIES WIN32_EXECUTABLE TRUE) # 不带控制台窗口
    endif()

    # ---- 应用图标：内嵌进 exe 的 PE 资源段 ----
    # ★ 为什么 mac 与 win 机制完全不同：
    #     mac → .app 里放一个独立的 icon.icns 文件，Finder 读它 ⇒ 换文件即可，**不重编译**；
    #     win → 图标是**编进 exe 里**的资源 ⇒ 换图**必须重新链接**。
    #   所以 `scripts/game/make_win_icon.sh` 是独立的一步，`cms webbg push --win` 会调它
    #   （然后需要重跑 build_windows.sh 才能真正换掉 exe 上的图标）。
    #
    # ico 由 scripts/game/make_win_icon.sh 从 assets/bg.jpg 生成（7 个尺寸）。
    # ⚠️ 用 ENABLE_EXPORTS 而不是直接 add .rc：后者在 cross-compiling 时
    #    windres 的工作目录不好控制，容易找不到相对路径的 ico。
    set(CMS_WIN_ICO "${CMAKE_BINARY_DIR}/icon.ico")
    if(EXISTS "${CMS_WIN_ICO}")
        file(WRITE "${CMAKE_BINARY_DIR}/app.rc"
             "IDI_ICON1 ICON \"icon.ico\"\n")
        enable_language(RC)
        add_custom_command(
            OUTPUT "${CMAKE_BINARY_DIR}/app_res.o"
            COMMAND ${CMAKE_RC_COMPILER} -i "${CMAKE_BINARY_DIR}/app.rc"
                    -o "${CMAKE_BINARY_DIR}/app_res.o" -O coff
            DEPENDS "${CMS_WIN_ICO}" "${CMAKE_BINARY_DIR}/app.rc"
            COMMENT "编译 Windows 图标资源 (windres)"
            VERBATIM)
        target_sources(minesweeper PRIVATE "${CMAKE_BINARY_DIR}/app_res.o")
        set_source_files_properties("${CMAKE_BINARY_DIR}/app_res.o"
                                    PROPERTIES EXTERNAL_OBJECT TRUE GENERATED TRUE)
    else()
        message(STATUS
            "未找到 ${CMS_WIN_ICO} —— 跳过图标内嵌"
            "（先跑 scripts/game/make_win_icon.sh；没有图标 exe 也能正常跑，只是没图标）")
    endif()
endif()

# ---- 独立小工具：种子/存档加解密（只依赖 C++20 标准库，不链接 SFML）----
add_executable(base tools/base.cpp)

# ---- 独立小工具：自由推理求解器与免猜率统计（只链 core，不链接 SFML；复盘分析用）----
add_executable(solver tools/solver.cpp src/core/Board.cpp)
target_include_directories(solver PRIVATE src)
# 求解器版本指纹：影响求解行为的源码内容哈希前 8 位，编译期烙进二进制（solver --version）。
# 分布式结果按它归因——测试组混跑新旧包时，谁算的就是哪个逻辑版本，一眼可分。
# CMAKE_CONFIGURE_DEPENDS：源文件一变就强制重新 configure，指纹不滞后于重编译。
set(SOLVER_VER_SRCS tools/solver.cpp src/core/Board.cpp src/core/Board.h)
file(GLOB SOLVER_VER_ENG "${CMAKE_CURRENT_SOURCE_DIR}/src/solver/*.h")
list(APPEND SOLVER_VER_SRCS ${SOLVER_VER_ENG})
set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS ${SOLVER_VER_SRCS})
set(SOLVER_VER_HASH "")
foreach(f ${SOLVER_VER_SRCS})
    if(IS_ABSOLUTE "${f}")
        file(SHA256 "${f}" h)
    else()
        file(SHA256 "${CMAKE_CURRENT_SOURCE_DIR}/${f}" h)
    endif()
    string(APPEND SOLVER_VER_HASH "${h}")
endforeach()
string(SHA256 SOLVER_VER "${SOLVER_VER_HASH}")
string(SUBSTRING "${SOLVER_VER}" 0 8 SOLVER_VER)
target_compile_definitions(solver PRIVATE SOLVER_VER="${SOLVER_VER}")

# ---- 跨端布雷一致性校验：与 web/test/rng-parity.mjs 的输出逐字节比对 ----
# 这是"排行榜要靠服务端回放校验成绩"的前提闸门：同一颗种子必须处处布雷相同。
# 改src/core/Rng.h 或 web/ts/rng.ts 后，两边输出必须仍完全一致。
add_executable(rngparity tools/rngparity.cpp src/core/Board.cpp)
target_include_directories(rngparity PRIVATE src)

# ---- 图片文件头探针的自检（2026-10-21 安全审计 P1：解码前验尺寸）----
# 不链接 SFML / stb：ImageProbe.h 是 header-only，图片闸门必须能在没有图形栈时被验证。
add_executable(imgprobe tools/imgprobe.cpp)
target_include_directories(imgprobe PRIVATE src)

# ---- JSON 空白判据的 C++ 侧（与 web/test/seed-ws-parity.mjs 逐行比对）----
add_executable(seedws tools/seedws.cpp)
target_include_directories(seedws PRIVATE src)

# ---- 种子明文解析契约的 C++ 侧（与 web/test/seed-parse-parity.mjs 逐字节比对）----
# 2026-10-22 安全审计 P11：同一颗种子串必须在桌面端与网页端解出**完全相同**的棋盘。
# 桌面端此前是手写扫描器（把"9.5"回退成 9），网页端用 JSON.parse（给 NaN）→ 两端答案不同。
# 现在两端统一为 fail-closed 契约：字段存在但非法 → 整条拒收。
# 本目标只依赖 C++20 标准库（SeedJson.h 是 header-only，不链 SFML / stb）。
add_executable(seedparse tools/seedparse.cpp)
target_include_directories(seedparse PRIVATE src)
