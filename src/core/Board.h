#pragma once
#include <array>
#include <cassert>
#include <vector>

#include "core/Cell.h"
#include "core/Rng.h"

namespace ms {

// 棋盘核心逻辑：布雷、复数提示、翻开/连锁、四类型标记循环、胜负判断。
class Board {
public:
    enum class Outcome { Nothing, Opened, Boom, Won };

    Board() = default;

    void reset(int cols, int rows, int mines);                          // 随机分型
    void reset(int cols, int rows, int realMines, int imagMines);       // 指定虚实数量（总数=和）
    // —— 种子功能：便于复现同一局 ——
    void randomizeSeed();                      // 每局开始时刷新一个随机种子
    void setSeed(std::uint32_t s);             // 用指定种子复现（须在首点之前调用）
    std::uint32_t seed() const { return seed_; }

    // 翻开格子（首次点击安全：棋盘够大时首点九邻域无雷）。
    Outcome open(int r, int c);

    // 双击开格（chord）的结果：
    //   NotApplicable = 这个格子不是"可开格目标"（未翻开 / 数字为 0 / 已结束）
    //   Opened        = 条件满足，已把其余邻格打开
    //   Blocked       = 是个合法的开格目标，但周围雷没全部按正确类型标记
    enum class ChordResult { NotApplicable, Opened, Blocked };

    // 双击开格：中心是已翻开的数字格，且**周围每一颗雷都被按正确类型标记**时，
    // 把其余未标记的邻格一次打开。条件不满足时不做任何改动。
    ChordResult chordOpen(int r, int c);

    // 右键循环标记：无 -> +1 -> -1 -> +i -> -i -> 无。
    void toggleFlag(int r, int c);

    // 直接把标记设成指定类型（右键菜单用；None 表示清除标记）。
    void setFlag(int r, int c, MineType type);

    bool inBounds(int r, int c) const { return r >= 0 && r < rows_ && c >= 0 && c < cols_; }

    Cell& at(int r, int c) { assert(inBounds(r, c)); return grid_[static_cast<std::size_t>(r) * cols_ + c]; }
    const Cell& at(int r, int c) const { assert(inBounds(r, c)); return grid_[static_cast<std::size_t>(r) * cols_ + c]; }

    int cols() const { return cols_; }
    int rows() const { return rows_; }
    int mineCount() const { return mines_; }
    int remaining() const; // 剩余雷数：雷数减全部旗数，多插会为负（UI 画红色；2026-10-29 用户裁决）
    int uncoveredMines() const; // 尚未被任何标记覆盖的雷数（模长 m 芯片口径：标在雷上才算）
    bool started() const { return placed_; }
    bool won() const {
        if (won_) return true;
        if (!placed_ || lost_) return false;
        return gaugeConsistent(); // 活判：中途切换判定口径也能识别已成立的胜利
    }
    bool lost() const { return lost_; }
    bool gameOver() const { return won_ || lost_; }

    // 每种雷型还没被正确标记的数量（下标 1..4 = +1, -1, +i, -i；未布雷时全 0）
    std::array<int, 3> axisUnflagged() const; // [1]=实雷剩余, [2]=虚雷剩余（与判胜同口径）

    // 所有雷都已按正确类型标记（布雷前恒为 false）。
    // 容错：统计无关的连通分量允许整体取反（实轴 +1<->-1、虚轴 +i<->-i），
    // 只要分量没有被同轴纯提示(纯实/纯虚)锚定，任一取向都算对。
    bool allMinesFlaggedGaugeConsistent() const;

    // ——「总是显示模长」模式：提示只显示 |z|（玩家看不到符号）——
    // 局中切换不改变棋盘状态（进度不丢），判胜/双击开格口径随之同步切换。
    bool magnitudeMode() const { return magnitudeMode_; }
    void setMagnitudeMode(bool on);

    // 模长口径：标记集合与雷集合完全一致，且每个已开格的"可见模长"都能被
    // 其邻域标记之和解释（不要求每颗雷标记的精确类型）。
    bool allMinesFlaggedMagnitudeConsistent() const;

    // 统一 gauge 入口：按当前模式选口径（有符号 v5 / 模长）
    bool gaugeConsistent() const;

    template <typename F>
    void forEachNeighbor(int r, int c, F&& fn) const {
        for (int dr = -1; dr <= 1; ++dr) {
            for (int dc = -1; dc <= 1; ++dc) {
                if (dr == 0 && dc == 0) continue;
                fn(r + dr, c + dc);
            }
        }
    }

private:
    void placeMines(int safeR, int safeC);

    void computeHints();
    void floodOpen(int r, int c);
    bool checkWin();
    void autoFlagAllMines();

    int cols_ = 0;
    int rows_ = 0;
    int mines_ = 0;
    int realMines_ = -1; // >=0 表示用户指定了实雷数量
    int imagMines_ = -1;
    int flags_ = 0;
    std::array<int, 5> typeTotal_{};
    bool placed_ = false;
    bool won_ = false;
    bool lost_ = false;
    bool magnitudeMode_ = false; // 「总是显示模长」：判胜/双击开格走模长口径

    std::vector<Cell> grid_;
    // 布雷用的确定性随机数（自写而非 std::random，保证与网页端逐位一致，见 Rng.h）
    Rng rng_{0x9E3779B9u};
    std::uint32_t seed_ = 0; // 本局随机种子（种子功能用）
};

}
