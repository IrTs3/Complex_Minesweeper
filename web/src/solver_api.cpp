 // SPDX-License-Identifier: AGPL-3.0-only
// 网页端精确概率桥：把玩家视角的盘面喂给 SolverEngine 跑一次 analyzeForHint。
// 与桌面端 T 键后台线程同一份精确管线（同一 .h），保证两端概率逐位同口径。
//
// 数据契约（stride 5 的 Int16）：
//   grid[i*5+0] = opened          0/1
//   grid[i*5+1] = flag            玩家标记 MineType 0..4
//   grid[i*5+2] = adjReal         已开格可见实部（有符号）
//   grid[i*5+3] = adjImag         已开格可见虚部（有符号）
//   grid[i*5+4] = adjTotal        已开格邻域雷总数
// rLeft/iLeft：求解池的轴剩余数，由调用方注入（2026-11-12 B 裁决：玩家可见口径
// = 配置轴总数 − 按型旗数，假设旗全对，见 Board::axisRemainingAssumed / 桌面 ProbWorker；
// web 从 BoardImpl::boardAxisRemainingAssumed 取）。
// 返回：0=全盘精确 1=含降级分量/超预算（部分格为估计） -1=盘面不合法
// outProb / outUnknown / outType 由调用方 malloc，长度 cols*rows；unknown=1 表示该格概率
// 未知（降级采样没找到含雷解），不是 0——前端绝不能把 unknown 当「安全」标绿。
// outType：100% 必雷格的轴类型（0=不标注 1=实 2=虚；与桌面 ProbWorker 同一编码，
// 由求解器 pickTypeMask 按轴级分类——掩码只含实轴位→1，只含虚轴位→2，跨轴/未记录→0）。

#include <cstdint>

#include "core/Board.h"
#include "solver/SolverEngine.h"

extern "C" int msProbExact(int cols, int rows, int mines, int rLeft, int iLeft,
                           const short* grid, float* outProb, unsigned char* outUnknown,
                           unsigned char* outType, int magMode) {
    if (cols <= 0 || rows <= 0 || cols > 50 || rows > 30 || !grid || !outProb || !outUnknown || !outType)
        return -1;
    const int n = cols * rows;
    if (mines < 1 || mines >= n || rLeft < 0 || iLeft < 0) return -1;

    ms::Board b;
    b.resetForAnalysis(cols, rows, mines);
    bool anyOpened = false;
    for (int i = 0; i < n; ++i) {
        const short* s = grid + (size_t)i * 5;
        ms::Cell& c = b.at(i / cols, i % cols);
        c.opened = s[0] != 0;
        c.flag = static_cast<ms::MineType>(s[1]);
        c.realSum = s[2];
        c.imagSum = s[3];
        c.minesAround = s[4];
        if (c.opened) anyOpened = true;
    }
    if (!anyOpened) return -1; // 首点之前没有概率可言（前端此时根本不该调）

    msolve::Solver sv(cols, rows, mines, false, 1);
    sv.setAxisCounts(rLeft, iLeft);
    // a 档（2026-11-12）：「总是显示模长」开着时纯/混提示玩家只见 |z|，约束退到圆口径
    sv.setMagnitudeMode(magMode != 0);
    msolve::SolverStats st;
    sv.analyzeForHint(b, st);
    const auto& pp = sv.pickProb();
    for (int g = 0; g < n; ++g) {
        outProb[g] = static_cast<float>(pp[(size_t)g]);
        outUnknown[g] = sv.pickUnknown(g) ? 1 : 0;
        const uint8_t m = sv.pickTypeMask(g);
        const bool real = (m & 3) != 0, imag = (m & 12) != 0;
        outType[g] = (real != imag) ? (real ? 1 : 2) : 0;
    }
    // blankSafe（0 提示邻域）不进候选集、analyze 不写它们的概率，初值 0.5 会冒充
    // 「半险」——它们全在 forcedSafe_（可证无雷），概率严格 0（绿标）
    for (int g : sv.forcedSafe()) outProb[g] = 0.0f;
    return sv.approx() ? 1 : 0;
}
