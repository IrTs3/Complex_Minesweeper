# MinGW-w64 交叉编译工具链（在 macOS/Linux 上编出 Windows x64 可执行文件）
#
# 用法：
#   cmake -S . -B build-win -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64-toolchain.cmake
#
# 依赖：brew install mingw-w64

set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

# Homebrew 的 mingw-w64 会把这三个 wrapper 链接到 PATH 上
set(CMAKE_C_COMPILER x86_64-w64-mingw32-gcc)
set(CMAKE_CXX_COMPILER x86_64-w64-mingw32-g++)
set(CMAKE_RC_COMPILER x86_64-w64-mingw32-windres)

# 交叉编译时 CMake 无法运行目标平台的可执行文件，
# 把 try_compile 的产物改成静态库，避免"测试程序无法运行"导致的配置失败
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)

# 只在目标系统里找头文件与库，不在 macOS 里乱找
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
