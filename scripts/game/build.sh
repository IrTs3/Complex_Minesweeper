#!/usr/bin/env bash
# 一键编译：cmake 配置 + 构建（游戏 minesweeper 与工具 base 都会生成）
# 优先使用 CLion 自带的 ninja，保证构建目录与 CLion 的默认生成器一致，避免
# CLion 报 "由不兼容的生成器 'Unix Makefiles' 创建"。
set -euo pipefail
cd "$(dirname "$0")/../.."

NINJA="/Applications/CLion.app/Contents/bin/ninja/mac/aarch64/ninja"
GEN_ARGS=()
if [ -x "$NINJA" ]; then
  GEN_ARGS=(-G Ninja -DCMAKE_MAKE_PROGRAM="$NINJA")
fi

cmake -S . -B cmake-build-debug -DCMAKE_BUILD_TYPE=Debug "${GEN_ARGS[@]}"
cmake --build cmake-build-debug -j"$(sysctl -n hw.ncpu)"
echo "Built: cmake-build-debug/minesweeper, cmake-build-debug/base"
