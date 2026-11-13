// gen_encode_golden.cpp — 金标 encode case 生成器（P1）。
//
// 手造+实跑三种盘面（覆盖纯实/纯虚/混合三态、标记、小盘零填充、前沿），走**权威编码器**
// SolverEngine::buildDumpPlane（经 analyzeForHint 补前沿 fid_），把（盘面可见信息，编码平面）
// 成对输出成 golden.jsonl 的 encode case。测试侧重生成并 diff，防编码漂移。
// TS/P4 的编码器以此为师（契约 tools/nn/dump_format.md §1）。
//
// 输出：每行一个 JSON case 到 stdout。
// 编译：g++ -O2 -std=c++17 -I src tools/nn/gen_encode_golden.cpp src/core/Board.cpp -o tools/nn/gen_encode_golden
#include "solver/SolverEngine.h"
#include "core/Board.h"
#include <cstdio>
#include <cstdint>
#include <string>
#include <vector>

using namespace msolve;

namespace {

void emitCase(const char* name, const Board& b, const std::vector<float>& plane) {
    printf("{\"kind\":\"encode\",\"name\":\"%s\",\"cols\":%d,\"rows\":%d,\"mines\":%d,\"cells\":[",
           name, b.cols(), b.rows(), b.mineCount());
    for (int r = 0; r < b.rows(); ++r)
        for (int c = 0; c < b.cols(); ++c) {
            const Cell& y = b.at(r, c);
            // 第 5 个字段 minesAround：复数和对消时（+1 与 -1 同邻）与「和为零」不同，
            // 前沿判定（c5/blankSafe）按它走，TS 端必须同口径
            printf("%s[%d,%d,%d,%d,%d]", (r || c) ? "," : "", y.opened ? 1 : 0, y.realSum, y.imagSum,
                   (int)y.flag, y.minesAround);
        }
    printf("],\"plane\":[");
    for (size_t i = 0; i < plane.size(); ++i) printf("%s%.9g", i ? "," : "", (double)plane[i]);
    printf("]}\n");
}

// 手工摆一格的可见状态（mine 不影响编码器，不设）
void setCell(Board& b, int r, int c, bool opened, int re, int im, MineType flag = MineType::None) {
    Cell& y = b.at(r, c);
    y.opened = opened;
    y.realSum = re;
    y.imagSum = im;
    y.flag = flag;
}

std::vector<float> encodeCase(const Solver& s, Board& b) {
    SolverStats st;
    const_cast<Solver&>(s).analyzeForHint(b, st);   // 只为补前沿 fid_；analyze 不动棋盘
    std::vector<float> plane;
    std::vector<uint8_t> cand;
    s.buildDumpPlane(b, plane, cand);
    return plane;
}

} // namespace

int main() {
    // case 1：真实开局（9×9，固定种子首点连锁 + 零填充到 16×30 画布）
    {
        Board b;
        b.reset(9, 9, 12);
        b.setSeed(20261107u);
        b.open(4, 4);
        Solver s(9, 9, 12, false, 1);
        emitCase("fresh-9x9", b, encodeCase(s, b));
    }
    // case 2：三态展示格——纯实(4)、纯虚(-3i)、混合(2+i→√5)，外加一枚旗（c6 恒 0 契约）
    {
        Board b;
        b.reset(9, 9, 12);
        b.setSeed(7u);
        setCell(b, 0, 0, true, 4, 0);
        setCell(b, 0, 1, true, 0, -3);
        setCell(b, 0, 2, true, 2, 1);
        setCell(b, 1, 1, false, 0, 0, MineType::Pi);
        Solver s(9, 9, 12, false, 1);
        emitCase("display-modes", b, encodeCase(s, b));
    }
    // case 3：中局（16×16，开一片 + 旗）
    {
        Board b;
        b.reset(16, 16, 40);
        b.setSeed(987654321u);
        b.open(8, 8);
        b.open(2, 2);
        b.open(14, 3);
        b.setFlag(0, 15, MineType::P1);
        Solver s(16, 16, 40, false, 1);
        emitCase("midgame-16x16", b, encodeCase(s, b));
    }
    // case 4：全闭盘（只有广播标量 + 未开 mask； analyze 在无已开格时也要不炸）
    {
        Board b;
        b.reset(9, 9, 12);
        b.setSeed(42u);
        Solver s(9, 9, 12, false, 1);
        emitCase("all-closed", b, encodeCase(s, b));
    }
    return 0;
}
