cmake_minimum_required(VERSION 3.16)
project(minesweeper_wasm LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Emscripten 编译选项
set(EMSCRIPTEN_LINK_FLAGS
    "-O3 \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='MinesweeperModule' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s EXPORTED_RUNTIME_METHODS='[\"ccall\",\"cwrap\"]' \
    -s EXPORTED_FUNCTIONS='[\"_malloc\",\"_free\"]' \
    --no-entry")

# WASM 核心库（纯逻辑，无 SFML 依赖）
add_executable(minesweeper_wasm
    src/main.cpp
    ${CMAKE_CURRENT_SOURCE_DIR}/../src/core/Board.cpp
)

target_include_directories(minesweeper_wasm PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/../src
)

set_target_properties(minesweeper_wasm PROPERTIES
    OUTPUT_NAME "minesweeper"
    SUFFIX ".js"
    LINK_FLAGS "${EMSCRIPTEN_LINK_FLAGS}"
)
