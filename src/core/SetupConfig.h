#pragma once
#include <algorithm>

namespace ms {

// 自定义局设置。两条互斥的输入路径（按用户要求）：
//   · 填写/步进"总雷数"      -> splitManual = false，隐藏虚实控件，后台随机分配虚实；
//   · 拖动"实雷/虚雷"数量    -> splitManual = true，总数自动等于两者之和。
struct SetupConfig {
    int rows = 16;
    int cols = 16;
    int maxRows = 40; // 由界面按屏幕大小收紧
    int maxCols = 40;
    int total = 40;
    int realCount = 20;
    int imagCount = 20;
    bool splitManual = false;

    // 单局容量上限：留至少一格给首点（与布雷护盾一致）
    int capacity() const { return std::max(1, rows * cols - 1); }

    void clampToBoard() {
        rows = std::clamp(rows, 5, std::max(5, maxRows));
        cols = std::clamp(cols, 5, std::max(5, maxCols));
        // 注意：下面一律用 capacity() 现算，不要缓存 —— 它依赖刚被钳过的 rows/cols
        total = std::clamp(total, 1, capacity());
        realCount = std::clamp(realCount, 0, capacity());
        imagCount = std::clamp(imagCount, 0, capacity());
        if (splitManual) {
            if (realCount + imagCount > capacity()) {
                if (realCount >= capacity()) { realCount = capacity(); imagCount = 0; }
                else imagCount = capacity() - realCount;
            }
            if (realCount + imagCount < 1) realCount = 1;
            total = realCount + imagCount;
        }
    }

    void setTotal(int t) {         // 用户填总数：转为"随机分配虚实"
        splitManual = false;
        total = t;
        clampToBoard();
    }

    // 拖动/键入只做虚实转移：总雷数不动，另一个相应让位（0 下限；11-12 裁决，
    // 旧语义往回拉会缩水总数、各滑条独立吃 cap，手感是「拉不动」）
    // 拖动/键入：总数随虚实之和；总和顶到 cap 时**被拖动侧**吞另一侧（11-12 裁决：
    // 旧 clampToBoard 永远削虚数，虚数拉上去会被弹回，两侧不对等）。
    // 就地做耦合再走 clampToBoard（此时 sum≤cap，其内的耦合块自然空转，仍护 rows/cols 收缩）
    void setReal(int v) {          // 用户拉实雷
        splitManual = true;
        realCount = std::clamp(v, 0, capacity());
        if (realCount + imagCount > capacity()) imagCount = capacity() - realCount;
        if (realCount + imagCount < 1) realCount = 1;
        total = realCount + imagCount;
        clampToBoard();
    }

    void setImag(int v) {          // 用户拉虚雷（与实雷完全对等）
        splitManual = true;
        imagCount = std::clamp(v, 0, capacity());
        if (realCount + imagCount > capacity()) realCount = capacity() - imagCount;
        if (realCount + imagCount < 1) imagCount = 1;
        total = realCount + imagCount;
        clampToBoard();
    }

    int mines() const { return splitManual ? realCount + imagCount : total; }
};

}
