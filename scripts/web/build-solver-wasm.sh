#!/bin/bash
# 把精确 solver（SolverEngine 全管线）编成网页端专用的小 wasm 模块。
# 与 web/src/main.cpp（休眠的整游戏 wasm 路线）无关：本模块只导出 msProbExact，
# 游戏逻辑仍是纯 TS 的 wasm_stub，T 键概率图才懒加载本模块。
#
# 依赖 emsdk（~/emsdk）。产物落 web/dist/：solver.js + solver.wasm。
set -e
cd "$(dirname "$0")/../.."

EMSDK="${EMSDK:-$HOME/emsdk}"
[ -d "$EMSDK" ] || { echo "缺 emsdk（${EMSDK}）：git clone + ./emsdk install latest" >&2; exit 1; }
export PATH="$EMSDK/upstream/emscripten:$PATH"
command -v em++ >/dev/null || { echo "em++ 不在 PATH（先 $EMSDK/emsdk activate latest）" >&2; exit 1; }

mkdir -p web/dist
echo "==> em++ $(em++ --version 2>/dev/null | head -1)"
em++ -O3 -std=c++20 -Isrc \
    web/src/solver_api.cpp src/core/Board.cpp \
    -o web/dist/solver.js \
    -s MODULARIZE=1 \
    -s EXPORT_NAME=SolverModule \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT=worker \
    -s FILESYSTEM=0 \
    -s EXPORTED_RUNTIME_METHODS='["ccall","HEAPU16","HEAPF32","HEAPU8"]' \
    -s EXPORTED_FUNCTIONS='["_msProbExact","_malloc","_free"]' \
    --no-entry

echo "==> 产物："
ls -l web/dist/solver.js web/dist/solver.wasm
