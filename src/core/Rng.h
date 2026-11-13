#pragma once
// 布雷用的确定性随机数：跨平台、跨语言逐位一致。
//
// ## 为什么不用 <random>
//
// 原来的写法是 `std::mt19937` + `std::shuffle` + `std::uniform_int_distribution` +
// `std::bernoulli_distribution`。问题在于 `shuffle` 与两个 distribution 都是
// **实现定义**的——libc++（macOS）、libstdc++（Linux）、MSVC 各自不同。
// 实测后果：**同一颗种子在 macOS 上和 Linux 上会布雷出不同的棋盘**，
// 存档跨平台就废了，更谈不上让服务器回放校验（排行榜反作弊的根基）。
//
// `std::mt19937` 本身是标准确定的，但只要经由那些 distribution 取数就又变了，
// 所以本文件把**取数与洗牌全部自写**，`std::random` 一个都不用。
//
// ## 算法（两端必须逐位一致，改动务必同步 web/ts/rng.ts）
//
// 状态扩展：SplitMix32 把32 位种子摊成 xoshiro128** 所需的 128 位状态。
// 取数：xoshiro128**，全 32 位运算（故 TS 侧用 Math.imul + >>> 0 即可精确复现）。
// 有界整数：**拒绝采样**（先砍掉 2^32 % n 个数再取模），保证均匀且无偏。
// 洗牌：Fisher–Yates **从后往前**（i = n-1 → 1），与网页端原有循环方向一致。
//
// 选型理由：xoshiro128** 只需 32 位算术，无需 128 位整数——JS 端若用 BigInt 跑
// 128 位状态会明显拖慢首局布雷，而 BigInt 在不同引擎上的行为也不该指望一致。
#include <cstddef>
#include <cstdint>

namespace ms {

// SplitMix32：把单个 32 位种子摊成均匀的 32 位序列（xoshiro 的标准初始化法）。
class SplitMix32 {
public:
    explicit SplitMix32(std::uint32_t seed) : state_(seed) {}

    std::uint32_t next() {
        state_ += 0x9E3779B9u;
        std::uint32_t z = state_;
        z = (z ^ (z >> 16)) * 0x21F0AAADu;
        z = (z ^ (z >> 15)) * 0x735A2D97u;
        return z ^ (z >> 15);
    }

private:
    std::uint32_t state_;
};

// xoshiro128**：128 位状态、32 位输出。周期 2^128 - 1，通过 BigCrush。
class Rng {
public:
    explicit Rng(std::uint32_t seed) {
        SplitMix32 sm(seed);
        s_[0] = sm.next();
        s_[1] = sm.next();
        s_[2] = sm.next();
        s_[3] = sm.next();
        // 全零状态会让 xoshiro 永远输出 0（SplitMix32 出全零的概率极低，
        // 但那是"极低"而不是"不可能"，显式兜住更省心）。
        if ((s_[0] | s_[1] | s_[2] | s_[3]) == 0) s_[0] = 1u;
    }

    std::uint32_t next() {
        const std::uint32_t result = rotl(s_[1] * 5u, 7) * 9u;
        const std::uint32_t t = s_[1] << 9;
        s_[2] ^= s_[0];
        s_[3] ^= s_[1];
        s_[1] ^= s_[2];
        s_[0] ^= s_[3];
        s_[2] ^= t;
        s_[3] = rotl(s_[3], 11);
        return result;
    }

    // [0, n) 上的均匀整数。要求 n >= 1。
    //
    // 拒绝采样：直接 `next() % n` 会让前 (2^32 % n) 个取值各占双倍权重（模偏差）。
    // 这里的 2^32 % n 用无符号回绕算：`0u - n` 就是 2^32 - n（无符号回绕是良定义的），
    // 而 (2^32 - n) % n 与 2^32 % n 相等（商少 1、余数不变）。
    std::uint32_t below(std::uint32_t n) {
        const std::uint32_t limit = (0u - n) % n;
        std::uint32_t r;
        do {
            r = next();
        } while (r < limit);
        return r % n;
    }

    // Fisher–Yates，**从后往前**（i = n-1 … 1）。
    // 方向必须与网页端一致，否则同种子两端的洗牌结果不同。
    template <typename T>
    void shuffle(T* a, std::size_t n) {
        for (std::size_t i = n; i-- > 1;) {
            const std::size_t j = below(static_cast<std::uint32_t>(i + 1));
            const T tmp = a[i];
            a[i] = a[j];
            a[j] = tmp;
        }
    }

private:
    static std::uint32_t rotl(std::uint32_t x, int k) { return (x << k) | (x >> (32 - k)); }
    std::uint32_t s_[4];
};

// 布雷流程用到的全部随机决策，按**固定顺序**取数。
// 抽成函数是为了让两端能逐字对照——取数顺序变了就是雷局变了。
//
// prefixCount：候选区长度（洗牌消耗 prefixCount-1 次取数）。
inline std::uint32_t typePick(Rng& rng) { return 1u + rng.below(4u); } // 1..4
inline bool signFlip(Rng& rng) { return rng.below(2u) == 1u; }         // 1 = 正号

} // namespace ms