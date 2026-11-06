// 跨端布雷一致性校验（C++ 侧）：给定固定的一批 (种子, 列, 行, 雷数, 首点, 虚实)
// 打印每局的棋盘摘要，与 web/test/rng-parity.mjs 的输出逐字节比对。
//
// 为什么需要：排行榜要靠服务端回放玩家动作来校验成绩，前提是**同一颗种子在任何
// 平台、任何实现下都布雷出同一张图**。以前 C++ 用 std::mt19937 + std::shuffle +
// 两个 distribution（都实现定义）、网页用 Lehmer LCG，两端对不上。
// 现在两端共用 src/core/Rng.h ↔ web/ts/rng.ts 的自写算法，本工具就是回归闸门：
// 任何一端改了取数顺序 / 洗牌方向 / 位宽，这里立刻与对面不一致。
//
// 摘要用 FNV-1a 64位 + 前后各若干格的原始类型串，双保险：
// 只比校验和的话，理论上有极小概率两个不同棋盘撞出同一个和（虽然 2^-64 实际不可能，
// 但"两个断言都过了"比"一个断言过了"更难排查）；原始串还能直接看出差在哪。
//
// 用法：  ./rngparity
// 退出码 0 = 打印了摘要；1 = 内部一致性断言失败。
#include "core/Board.h"
#include "core/Cell.h"
#include "core/ComplexMath.h"

#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

namespace {

struct Case {
    std::uint32_t seed;
    int cols, rows, mines;
    int firstR, firstC;
    int realMines, imagMines;  // -1 = 随机分型
};

// 用例要覆盖到 RNG 的各个分支：
//   · 随机分型（走 typePick）
//   · 手动分型（走 signFlip + 池子二次洗牌）
//   · 首点靠边 / 靠角（banned 区形状不同，候选区长度不同 → below() 的拒绝次数不同）
//   · 雷数接近上限（候选区很短，洗牌几乎不消耗取数）
//   · 种子 0 与 0xFFFFFFFF（边界，曾是旧实现最容易出问题的地方）
const std::vector<Case> kCases = {
    {0u,        9,  9, 10, 4, 4, -1, -1},
    {1u,        9,  9, 10, 0, 0, -1, -1},   // 首点=左上角
    {12345u,   16, 16, 40, 8, 8, -1, -1},
    {0xFFFFFFFFu, 9, 9, 10, 4, 4, -1, -1},
    {7u,       30, 20, 100, 15, 10, -1, -1},
    {99u,      10, 10, 12, 5, 5, 8, 4},      // 手动分型
    {2024u,    12, 12, 20, 0, 11, 12, 8},    // 手动分型 + 首点在边界
    {555u,      8,  8, 55, 4, 4, -1, -1},    // 雷数接近上限（候选区极短）
    {31415926u, 20, 14, 45, 10, 7, -1, -1},
    {8888u,     9,  9, 10, 8, 8, 0, 10},     // 全虚雷
};

std::uint64_t fnv1a(std::uint64_t h, std::uint8_t b) {
    h ^= b;
    h *= 0x100000001B3ull;
    return h;
}

} // namespace

int main() {
    bool ok = true;
    for (const Case& c : kCases) {
        ms::Board b;
        if (c.realMines >= 0) b.reset(c.cols, c.rows, c.realMines, c.imagMines);
        else                b.reset(c.cols, c.rows, c.mines);
        b.setSeed(c.seed);
        const ms::Board::Outcome o = b.open(c.firstR, c.firstC);
        if (o == ms::Board::Outcome::Boom) {
            std::printf("用例 seed=%u 首点就爆雷——首点保护失效\n", c.seed);
            ok = false;
            continue;
        }
        if (!b.started()) {
            std::printf("用例 seed=%u 未布雷\n", c.seed);
            ok = false;
            continue;
        }

        // 摘要：全图 FNV-1a + 首行/末行的原始类型串
        std::uint64_t h = 0xCBF29CE484222325ull;
        for (int r = 0; r < b.rows(); ++r)
            for (int cc = 0; cc < b.cols(); ++cc)
                h = fnv1a(h, static_cast<std::uint8_t>(b.at(r, cc).mine));

        std::string edge;
        for (int cc = 0; cc < b.cols(); ++cc)
            edge += static_cast<char>('0' + static_cast<int>(b.at(0, cc).mine));
        edge += '/';
        for (int cc = 0; cc < b.cols(); ++cc)
            edge += static_cast<char>('0' + static_cast<int>(b.at(b.rows() - 1, cc).mine));

        // 内部一致性：雷总数必须与 mineCount() 相符（布雷本身没写错）
        int total = 0;
        for (int r = 0; r < b.rows(); ++r)
            for (int cc = 0; cc < b.cols(); ++cc)
                if (b.at(r, cc).mine != ms::MineType::None) ++total;

        std::printf("{\"seed\":%u,\"cols\":%d,\"rows\":%d,\"mines\":%d,\"firstR\":%d,"
                    "\"firstC\":%d,\"real\":%d,\"imag\":%d,\"total\":%d,"
                    "\"fnv\":\"%016llx\",\"edge\":\"%s\"}\n",
                    c.seed, c.cols, c.rows, c.mines, c.firstR, c.firstC,
                    c.realMines, c.imagMines, total,
                    static_cast<unsigned long long>(h), edge.c_str());
        if (total != b.mineCount()) {
            std::printf("  ✗ 雷数不自洽：实际 %d，mineCount() %d\n", total, b.mineCount());
            ok = false;
        }
    }
    std::printf("{\"cases\":%zu}\n", kCases.size());
    return ok ? 0 : 1;
}