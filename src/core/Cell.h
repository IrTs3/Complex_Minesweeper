#pragma once
#include <cstdint>

namespace ms {

// 地雷的复数值：+1, -1, +i, -i
enum class MineType : std::uint8_t {
    None = 0,
    P1   = 1, // +1 实雷
    M1   = 2, // -1 实雷
    Pi   = 3, // +i 虚雷
    Mi   = 4, // -i 虚雷
};

inline bool isRealMine(MineType t) { return t == MineType::P1 || t == MineType::M1; }

// 棋盘上的单个格子
struct Cell {
    MineType mine = MineType::None; // 雷（None 为安全格）
    MineType flag = MineType::None; // 玩家标记类型（右键循环）
    bool opened = false;            // 是否已翻开
    bool exploded = false;          // 是否为踩爆的那颗雷

    int realSum = 0;                // 周围雷的复数和的实部（有符号！）
    int imagSum = 0;                // 虚部（有符号）
    int minesAround = 0;            // 周围雷的总数（0 才能连锁展开 / 显示空白）
};

}
