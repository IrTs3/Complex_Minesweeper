#pragma once
// 进度存档：把棋盘"玩到哪了"写进 Seed（kind = "save"），以及按存档回放还原。
// 抽出来是为了让游戏与自检共用同一份逻辑，避免两处实现走样。
#include "Board.h"
#include "Seed.h"

#include <string>

namespace ms {

// 记录当前棋盘状态（已翻开 / 已标记，用 '.' 与 '#'、'1'~'4' 画成棋盘图）
inline void captureProgress(const Board& board, Seed& s, int elapsedCs, const std::string& phase) {
    s.kind = "save";
    s.elapsedCs = elapsedCs;
    s.phase = phase;
    s.openedRows.clear();
    s.flagRows.clear();
    for (int r = 0; r < board.rows(); ++r) {
        std::string o, f;
        for (int c = 0; c < board.cols(); ++c) {
            const Cell& cell = board.at(r, c);
            o += cell.opened ? '#' : '.';
            f += (cell.flag == MineType::None) ? '.' : static_cast<char>('0' + static_cast<int>(cell.flag));
        }
        s.openedRows.push_back(o);
        s.flagRows.push_back(f);
    }
}

// 按存档回放。调用前须已 reset + setSeed + 复现首个点击（这样雷分布才一致）。
// 顺序很关键：安全格 -> 标记 -> （若存档是失败局）最后踩雷，
// 因为 open/setFlag 在 gameOver 之后都会被拒绝。
inline void restoreProgress(Board& board, const Seed& s) {
    if (s.kind != "save" || s.openedRows.empty()) return;
    const auto openedAt = [&](int r, int c) {
        return r < static_cast<int>(s.openedRows.size()) &&
               c < static_cast<int>(s.openedRows[static_cast<std::size_t>(r)].size()) &&
               s.openedRows[static_cast<std::size_t>(r)][static_cast<std::size_t>(c)] == '#';
    };
    for (int r = 0; r < board.rows(); ++r)
        for (int c = 0; c < board.cols(); ++c)
            if (openedAt(r, c) && board.at(r, c).mine == MineType::None) board.open(r, c);
    for (int r = 0; r < board.rows() && r < static_cast<int>(s.flagRows.size()); ++r)
        for (int c = 0; c < board.cols() && c < static_cast<int>(s.flagRows[static_cast<std::size_t>(r)].size()); ++c) {
            const char ch = s.flagRows[static_cast<std::size_t>(r)][static_cast<std::size_t>(c)];
            if (ch >= '1' && ch <= '4') board.setFlag(r, c, static_cast<MineType>(ch - '0'));
        }
    if (s.phase == "lost")
        for (int r = 0; r < board.rows(); ++r)
            for (int c = 0; c < board.cols(); ++c)
                if (openedAt(r, c) && board.at(r, c).mine != MineType::None) board.open(r, c);
}

} // namespace ms
