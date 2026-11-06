// 动效层：所有「会动的」时间常量集中在 kAnimMs，红线 = 单段 ≤250ms。
// 开关判定 = 设置里的 animFx && !prefers-reduced-motion；两处任一不满足，全部动效退化为即时绘制。

/** 单段动画时长（ms）。改任何一个值都要遵守 ≤250 的红线。 */
export const kAnimMs = {
    waveStep: 18,      // 开格波前：每圈 BFS 距离的错峰间隔
    revealPop: 110,    // 单格翻开入场（底色+数字）
    counterFlip: 180,  // 表头剩余雷数翻牌
    ripple: 220,       // 点击涟漪
    badgePop: 140,     // 标记徽章弹入
    badgeRing: 190,    // 徽章落定光环
    badgeDie: 100,     // 取消标记缩小退场
    lossStep: 24,      // 失败雷区显形：每圈切比雪夫距离的间隔
    lossPop: 140,      // 单颗雷显形时长
    shake: 320,        // 错标格子抖动总时长
    winSegStep: 45,    // 星座线：相邻线段的出现间隔
    winSegGrow: 160,   // 单条线段生长时长
    winHold: 1400,     // 星座整体保留时长
    winFade: 700,      // 星座整体淡出时长
} as const;

export function reducedMotion(): boolean {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** 设置开关 && 系统未要求减少动态 —— 全部动效的唯一闸门 */
export function animOn(setting: boolean): boolean {
    return setting && !reducedMotion();
}

/** ease-out-back：带一点过冲的落定曲线（徽章「按上去」的手感） */
export function easeOutBack(p: number): number {
    const c1 = 1.70158, c3 = c1 + 1;
    const x = p - 1;
    return 1 + c3 * x * x * x + c1 * x * x;
}

/** ease-in-out：翻牌/涟漪等对称运动用 */
export function easeInOut(p: number): number {
    return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
}
