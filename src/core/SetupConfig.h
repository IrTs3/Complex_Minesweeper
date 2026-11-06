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

    void setReal(int v) {          // 用户拉实雷：总数随虚实之和
        splitManual = true;
        realCount = v;
        clampToBoard();
        total = realCount + imagCount;
    }

    void setImag(int v) {
        splitManual = true;
        imagCount = v;
        clampToBoard();
        total = realCount + imagCount;
    }

    int mines() const { return splitManual ? realCount + imagCount : total; }
};

}
