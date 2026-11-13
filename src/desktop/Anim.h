#pragma once
// 动效层：所有「会动的」时间常量集中在 kAnimMs，红线 = 单段 ≤250ms。
// 与 web/ts/anim.ts 同值同义（两端必须一起改）。桌面端没有 prefers-reduced-motion
// 可读，唯一闸门就是设置面板里的 ANIM FX 开关；关掉时全部动效退化为即时绘制。
#include <cmath>

namespace ms::anim {

struct AnimMs {
    int waveStep = 18;      // 开格波前：每圈 BFS 距离的错峰间隔
    int revealPop = 110;    // 单格翻开入场（底色+数字）
    int counterFlip = 180;  // 表头剩余雷数翻牌
    int ripple = 220;       // 点击涟漪
    int badgePop = 140;     // 标记徽章弹入
    int badgeRing = 190;    // 徽章落定光环
    int badgeDie = 100;     // 取消标记缩小退场
    int lossStep = 24;      // 失败雷区显形：每圈切比雪夫距离的间隔
    int lossPop = 140;      // 单颗雷显形时长
    int shake = 320;        // 错标格子抖动总时长
    int winSegStep = 45;    // 星座线：相邻线段的出现间隔
    int winSegGrow = 160;   // 单条线段生长时长
    int winHold = 1400;     // 星座整体保留时长
    int winFade = 700;      // 星座整体淡出时长
};

inline constexpr AnimMs kAnimMs{};

// ease-out-back：带一点过冲的落定曲线（徽章「按上去」的手感）
inline float easeOutBack(float p) {
    constexpr float c1 = 1.70158f;
    constexpr float c3 = c1 + 1.f;
    const float x = p - 1.f;
    return 1.f + c3 * x * x * x + c1 * x * x;
}

// ease-in-out：翻牌/涟漪等对称运动用
inline float easeInOut(float p) {
    return p < 0.5f ? 2.f * p * p : 1.f - std::pow(-2.f * p + 2.f, 2.f) / 2.f;
}

} // namespace ms::anim
