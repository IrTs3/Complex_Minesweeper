// WASM 入口：将 core/ 的游戏逻辑暴露给 JavaScript
// 使用 Emscripten 的 extern "C" 接口

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include "core/Board.h"
#include "core/Seed.h"
#include "core/Difficulty.h"

using namespace emscripten;

// 全局游戏状态（单例，简化 JS 调用）
namespace {
    ms::Board g_board;
    int g_firstR = -1, g_firstC = -1;
    bool g_firstOpened = false;
}

// ---- 棋盘操作 ----

void boardReset(int cols, int rows, int mines) {
    g_board.reset(cols, rows, mines);
    g_firstOpened = false;
    g_firstR = g_firstC = -1;
}

void boardResetSplit(int cols, int rows, int realMines, int imagMines) {
    g_board.reset(cols, rows, realMines, imagMines);
    g_firstOpened = false;
    g_firstR = g_firstC = -1;
}

int boardOpen(int row, int col) {
    if (!g_firstOpened) {
        g_firstOpened = true;
        g_firstR = row;
        g_firstC = col;
    }
    return static_cast<int>(g_board.open(row, col));
}

void boardSetFlag(int row, int col, int mineType) {
    g_board.setFlag(row, col, static_cast<ms::MineType>(mineType));
}

bool boardWon() { return g_board.won(); }
bool boardLost() { return g_board.lost(); }

int boardCols() { return g_board.cols(); }
int boardRows() { return g_board.rows(); }
int boardMineCount() { return g_board.mineCount(); }
int boardRemaining() { return g_board.remaining(); }

void boardRandomizeSeed() { g_board.randomizeSeed(); }
void boardSetSeed(uint32_t seed) { g_board.setSeed(seed); }
uint32_t boardGetSeed() { return g_board.seed(); }

int boardFirstRow() { return g_firstR; }
int boardFirstCol() { return g_firstC; }

// ---- 格子信息（返回 JSON 字符串，JS 侧解析） ----

std::string boardGetCell(int row, int col) {
    if (!g_board.inBounds(row, col)) return "{}";
    const ms::Cell& c = g_board.at(row, col);
    std::string json = "{";
    json += "\"opened\":" + std::string(c.opened ? "true" : "false");
    json += ",\"mine\":" + std::to_string(static_cast<int>(c.mine));
    json += ",\"flag\":" + std::to_string(static_cast<int>(c.flag));
    json += ",\"adjReal\":" + std::to_string(c.adjReal);
    json += ",\"adjImag\":" + std::to_string(c.adjImag);
    json += ",\"adjTotal\":" + std::to_string(c.adjTotal());
    json += "}";
    return json;
}

// ---- 种子/存档 ----

std::string encodeSeedJson(const std::string& kind, int cols, int rows, int mines,
                           bool manualSplit, int realMines, int imagMines,
                           uint32_t rngSeed, int firstRow, int firstCol) {
    ms::Seed s;
    s.kind = kind;
    s.cols = cols;
    s.rows = rows;
    s.mines = mines;
    s.manualSplit = manualSplit;
    s.realMines = realMines;
    s.imagMines = imagMines;
    s.rngSeed = rngSeed;
    s.firstRow = firstRow;
    s.firstCol = firstCol;
    return ms::encodeSeed(s);
}

std::string decodeSeedJson(const std::string& text) {
    ms::Seed s;
    if (!ms::decodeSeed(text, s)) return "{\"ok\":false}";
    std::string json = "{\"ok\":true";
    json += ",\"kind\":\"" + s.kind + "\"";
    json += ",\"cols\":" + std::to_string(s.cols);
    json += ",\"rows\":" + std::to_string(s.rows);
    json += ",\"mines\":" + std::to_string(s.mines);
    json += ",\"manualSplit\":" + std::string(s.manualSplit ? "true" : "false");
    json += ",\"realMines\":" + std::to_string(s.realMines);
    json += ",\"imagMines\":" + std::to_string(s.imagMines);
    json += ",\"rngSeed\":" + std::to_string(s.rngSeed);
    json += ",\"firstRow\":" + std::to_string(s.firstRow);
    json += ",\"firstCol\":" + std::to_string(s.firstCol);
    json += "}";
    return json;
}

// ---- Emscripten 绑定 ----

EMSCRIPTEN_BINDINGS(minesweeper) {
    function("boardReset", &boardReset);
    function("boardResetSplit", &boardResetSplit);
    function("boardOpen", &boardOpen);
    function("boardSetFlag", &boardSetFlag);
    function("boardWon", &boardWon);
    function("boardLost", &boardLost);
    function("boardCols", &boardCols);
    function("boardRows", &boardRows);
    function("boardMineCount", &boardMineCount);
    function("boardRemaining", &boardRemaining);
    function("boardRandomizeSeed", &boardRandomizeSeed);
    function("boardSetSeed", &boardSetSeed);
    function("boardGetSeed", &boardGetSeed);
    function("boardFirstRow", &boardFirstRow);
    function("boardFirstCol", &boardFirstCol);
    function("boardGetCell", &boardGetCell);
    function("encodeSeedJson", &encodeSeedJson);
    function("decodeSeedJson", &decodeSeedJson);

    // 枚举
    enum_<ms::MineType>("MineType")
        .value("None", ms::MineType::None)
        .value("Plus1", ms::MineType::Plus1)
        .value("Minus1", ms::MineType::Minus1)
        .value("PlusI", ms::MineType::PlusI)
        .value("MinusI", ms::MineType::MinusI);

    enum_<ms::Board::Outcome>("Outcome")
        .value("Safe", ms::Board::Outcome::Safe)
        .value("Boom", ms::Board::Outcome::Boom)
        .value("Won", ms::Board::Outcome::Won);
}
