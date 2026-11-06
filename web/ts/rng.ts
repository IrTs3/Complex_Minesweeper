// 布雷用的确定性随机数：跨平台、跨语言逐位一致。
//
// ## 为什么不用 Math.random
//
// 网页端原本用 Lehmer LCG（s = s * 16807 % 2^31-1），桌面端用 std::mt19937 +
// std::shuffle + 两个 distribution，两端同一颗种子布雷出**不同的棋盘**。
// 做排行榜时这是致命的：服务端要用同一份 core 回放玩家动作来校验成绩，
// 两端雷局不一致就等于反作弊根基不存在。
//
// 而且更深一层：C++ 侧的 std::shuffle / uniform_int_distribution /
// bernoulli_distribution 都是**实现定义**的，libc++（macOS）、libstdc++（Linux）、
// MSVC 各自不同——**原桌面端在同一颗种子下跨平台都复现不出同一局**。
// 所以两边都改成这一份自写实现（对应 C++ 的 src/core/Rng.h，改动必须同步）。
//
// ## 算法（与 src/core/Rng.h 逐位一致）
//
// 状态扩展：SplitMix32 把 32 位种子摊成 xoshiro128** 所需的 128 位状态。
// 取数：xoshiro128**。全部是 32 位运算，JS 侧用 Math.imul + >>> 0 精确复现。
// 有界整数：拒绝采样（先砍掉 2^32 % n 个数再取模），保证均匀无偏。
// 洗牌：Fisher–Yates **从后往前**（i = n-1 → 1）。
//
// ⚠️ 取数**顺序**同样是规格的一部分：改一处顺序就是改雷局，两端必须同时改。

/** SplitMix32：把单个 32 位种子摊成均匀的 32 位序列。 */
class SplitMix32 {
    private state: number;

    constructor(seed: number) {
        this.state = seed >>> 0;
    }

    next(): number {
        this.state = (this.state + 0x9E3779B9) >>> 0;
        let z = this.state >>> 0;
        z = Math.imul(z ^ (z >>> 16), 0x21F0AAAD) >>> 0;
        z = Math.imul(z ^ (z >>> 15), 0x735A2D97) >>> 0;
        return (z ^ (z >>> 15)) >>> 0;
    }
}

/** xoshiro128**：128 位状态、32 位输出。周期 2^128-1。 */
export class Rng {
    private s0 = 0;
    private s1 = 0;
    private s2 = 0;
    private s3 = 0;

    constructor(seed: number) {
        const sm = new SplitMix32(seed >>> 0);
        this.s0 = sm.next();
        this.s1 = sm.next();
        this.s2 = sm.next();
        this.s3 = sm.next();
        // 全零状态会让 xoshiro 永远输出 0（概率极低但非零），显式兜住
        if (((this.s0 | this.s1 | this.s2 | this.s3) >>> 0) === 0) this.s0 = 1;
    }

    private static rotl(x: number, k: number): number {
        return (((x << k) | (x >>> (32 - k))) >>> 0);
    }

    next(): number {
        const result = Math.imul(Rng.rotl(Math.imul(this.s1, 5), 7), 9) >>> 0;
        const t = (this.s1 << 9) >>> 0;
        this.s2 = (this.s2 ^ this.s0) >>> 0;
        this.s3 = (this.s3 ^ this.s1) >>> 0;
        this.s1 = (this.s1 ^ this.s2) >>> 0;
        this.s0 = (this.s0 ^ this.s3) >>> 0;
        this.s2 = (this.s2 ^ t) >>> 0;
        this.s3 = Rng.rotl(this.s3, 11);
        return result >>> 0;
    }

    /**
     * [0, n) 上的均匀整数。要求 n >= 1。
     *
     * 拒绝采样：直接 `next() % n` 会有模偏差（前 2^32 % n 个取值各占双倍权重）。
     * `2^32 % n` 用无符号回绕算：`(0 - n) >>> 0` 即 2^32 - n，
     * 而 (2^32 - n) % n 与 2^32 % n 相等（商少 1、余数不变）。
     */
    below(n: number): number {
        const nn = n >>> 0;
        const limit = (((0 - nn) >>> 0) % nn) >>> 0;
        let r: number;
        do {
            r = this.next();
        } while (r < limit);
        return (r % nn) >>> 0;
    }

    /** Fisher–Yates，**从后往前**（i = n-1 … 1）。与 C++ 端方向一致。 */
    shuffle<T>(a: T[]): T[] {
        for (let i = a.length; i-- > 1;) {
            const j = this.below(i + 1);
            const t = a[i];
            a[i] = a[j];
            a[j] = t;
        }
        return a;
    }
}

/** 随机分型：四种雷型各约 25%。返回 1..4。 */
export function typePick(rng: Rng): number {
    return 1 + rng.below(4);
}

/** 指定分型时的符号随机：true = 正号。 */
export function signFlip(rng: Rng): boolean {
    return rng.below(2) === 1;
}