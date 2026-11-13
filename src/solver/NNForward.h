// NNForward.h — 学生网络（.cnnw）加载与前向，header-only，纯标准库。
//
// 三端契约的唯一 C++ 实现：格式与运算顺序的权威出处是 tools/nn/dump_format.md，
// 这里的累加顺序（逐输出点、kH→kW→inC 固定次序、f32）必须与网页端 TS 实现逐字对齐，
// 一致性由 tools/nn/golden/golden.jsonl 金标闸（测试 T85）钉住。
//
// 格式要点（详见 dump_format.md）：
//   "CMSNW" 魔数 + u32 版本 + u32 哨兵 0x1A5A5A1A + u16 inC/inH/inW/nLayers
//   + 逐层（u8 op, u16 outC, u8 kH, u8 kW, u8 pad, u8 act, 权重, f32 偏置）
//   + 末尾 32 字节 sha256（自魔数起、不含本字段）
//   op: 0=conv 1=残差加（无权重，out=前一层输出+块入口，块入口=上一个 op1 之后的
//       第一层输出，无则网络输入）；act: 0=无 1=ReLU 2=sigmoid。dtype 恒 f32 LE。
//   版本 1 = f32 权重；版本 2 = f32 scale[outC] + i8 权重（逐输出通道对称量化），
//   加载时反量化 w=scale×q 展开 f32，前向路径两版完全一致。
//   有意不含 BatchNorm：归一化层是三端一致性的最大坑，导出即所见即所得。
#ifndef NN_FORWARD_H
#define NN_FORWARD_H

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace nnf {

// ── 紧凑 sha256（仅用于权重完整性自校验；与 python hashlib 对拍过口径）──────
inline void sha256(const uint8_t* data, size_t len, uint8_t out[32]) {
    static const uint32_t K[64] = {
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2};
    static const uint32_t H0[8] = {0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
                                   0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19};
    uint32_t h[8];
    for (int i = 0; i < 8; ++i) h[i] = H0[i];
    std::vector<uint8_t> msg(data, data + len);
    const uint64_t bitLen = (uint64_t)len * 8;
    msg.push_back(0x80);
    while (msg.size() % 64 != 56) msg.push_back(0);
    for (int i = 7; i >= 0; --i) msg.push_back((uint8_t)(bitLen >> (i * 8)));
    for (size_t off = 0; off < msg.size(); off += 64) {
        uint32_t w[64];
        for (int i = 0; i < 16; ++i)
            w[i] = (uint32_t)msg[off + i * 4] << 24 | (uint32_t)msg[off + i * 4 + 1] << 16
                 | (uint32_t)msg[off + i * 4 + 2] << 8 | (uint32_t)msg[off + i * 4 + 3];
        for (int i = 16; i < 64; ++i) {
            const uint32_t s0 = ((w[i-15] >> 7) | (w[i-15] << 25)) ^ ((w[i-15] >> 18) | (w[i-15] << 14)) ^ (w[i-15] >> 3);
            const uint32_t s1 = ((w[i-2] >> 17) | (w[i-2] << 15)) ^ ((w[i-2] >> 19) | (w[i-2] << 13)) ^ (w[i-2] >> 10);
            w[i] = w[i-16] + s0 + w[i-7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (int i = 0; i < 64; ++i) {
            const uint32_t S1 = ((e >> 6) | (e << 26)) ^ ((e >> 11) | (e << 21)) ^ ((e >> 25) | (e << 7));
            const uint32_t ch = (e & f) ^ (~e & g);
            const uint32_t t1 = hh + S1 + ch + K[i] + w[i];
            const uint32_t S0 = ((a >> 2) | (a << 30)) ^ ((a >> 13) | (a << 19)) ^ ((a >> 22) | (a << 10));
            const uint32_t mj = (a & b) ^ (a & c) ^ (b & c);
            const uint32_t t2 = S0 + mj;
            hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        h[0]+=a; h[1]+=b; h[2]+=c; h[3]+=d; h[4]+=e; h[5]+=f; h[6]+=g; h[7]+=hh;
    }
    for (int i = 0; i < 8; ++i)
        for (int j = 0; j < 4; ++j) out[i * 4 + j] = (uint8_t)(h[i] >> (24 - j * 8));
}

// ── 网络与权重 ──────────────────────────────────────────────────────────────
struct Layer {
    int op = 0;            // 0=conv 1=残差加
    int outC = 0, kH = 0, kW = 0, pad = 0, act = 0;
    std::vector<float> w, b;
};
struct Net {
    int inC = 0, inH = 0, inW = 0;
    std::vector<Layer> layers;
};

inline uint32_t rdU32(const uint8_t* p) {
    return (uint32_t)p[0] | (uint32_t)p[1] << 8 | (uint32_t)p[2] << 16 | (uint32_t)p[3] << 24;
}
inline uint16_t rdU16(const uint8_t* p) { return (uint16_t)(p[0] | p[1] << 8); }
inline float rdF32(const uint8_t* p) {
    uint32_t u = rdU32(p); float f;
    std::memcpy(&f, &u, 4);
    return f;
}

// 加载并校验 .cnnw。任何一步不对都返回 false 并把人话原因写进 err（调用方必须吭声）。
inline bool load_cnnw(const char* path, Net& net, std::string& err) {
    std::FILE* fp = std::fopen(path, "rb");
    if (!fp) { err = "打不开权重文件"; return false; }
    std::fseek(fp, 0, SEEK_END);
    const long size = std::ftell(fp);
    std::fseek(fp, 0, SEEK_SET);
    if (size < (long)(13 + 2 + 32)) { std::fclose(fp); err = "权重文件太小（疑似截断）"; return false; }
    std::vector<uint8_t> buf((size_t)size);
    if (std::fread(buf.data(), 1, buf.size(), fp) != buf.size()) {
        std::fclose(fp); err = "权重文件读不满（疑似截断）"; return false;
    }
    std::fclose(fp);
    if (std::memcmp(buf.data(), "CMSNW", 5) != 0) { err = "魔数不对（不是 CMSNW）"; return false; }
    const uint32_t ver = rdU32(&buf[5]);
    if (ver != 1 && ver != 2) { err = "版本不支持"; return false; }
    if (rdU32(&buf[9]) != 0x1A5A5A1Au) { err = "哨兵字节不对"; return false; }
    const size_t body = buf.size() - 32;
    uint8_t dig[32];
    sha256(buf.data(), body, dig);
    if (std::memcmp(dig, buf.data() + body, 32) != 0) { err = "尾部 sha256 不匹配（文件损坏/被改）"; return false; }
    size_t off = 13;
    net.inC = rdU16(&buf[off]); net.inH = rdU16(&buf[off + 2]);
    net.inW = rdU16(&buf[off + 4]);
    const int nLayers = rdU16(&buf[off + 6]);
    off += 8;
    net.layers.clear();
    int inC = net.inC;
    for (int i = 0; i < nLayers; ++i) {
        if (off + 7 > body) { err = "层记录越界"; return false; }
        Layer L;
        L.op = buf[off]; L.outC = rdU16(&buf[off + 1]);
        L.kH = buf[off + 3]; L.kW = buf[off + 4]; L.pad = buf[off + 5]; L.act = buf[off + 6];
        off += 7;
        if (L.op == 1) { net.layers.push_back(L); continue; }   // 残差加：无权重
        // 先按声明的维度算出「至少需要多少字节」，过界检查之后才分配——
        // 恶意文件声明天文数字的维度时，resize 先行就是一次未捕获 bad_alloc（2026-11-13 审计 [低]）
        const size_t n = (size_t)L.outC * inC * L.kH * L.kW;
        const size_t need = (ver == 2 ? (size_t)L.outC * 4 * 2 + n : n * 4 + (size_t)L.outC * 4);
        if (off + need > body) { err = "权重数据越界"; return false; }
        L.w.resize(n);
        if (ver == 2) {
            // v2：f32 scale[outC] + i8 权重，加载时反量化回 f32（w=scale×q），前向与 v1 同路径
            std::vector<float> scale(L.outC);
            for (int j = 0; j < L.outC; ++j) scale[j] = rdF32(&buf[off + j * 4]);
            off += (size_t)L.outC * 4;
            for (size_t j = 0; j < n; ++j)
                L.w[j] = scale[j / ((size_t)inC * L.kH * L.kW)] * (float)(int8_t)buf[off + j];
            off += n;
        } else {
            for (size_t j = 0; j < n; ++j) L.w[j] = rdF32(&buf[off + j * 4]);
            off += n * 4;
        }
        L.b.resize(L.outC);
        for (int j = 0; j < L.outC; ++j) L.b[j] = rdF32(&buf[off + j * 4]);
        off += (size_t)L.outC * 4;
        inC = L.outC;
        net.layers.push_back(L);
    }
    return true;
}

inline float applyAct(float v, int act) {
    if (act == 1) return v > 0 ? v : 0;
    if (act == 2) return 1.0f / (1.0f + std::exp(-v));
    return v;
}

// 前向。in: inC×inH×inW（通道主序）；out: inH×inW。
// 累加顺序契约：逐输出点，按 kH→kW→inC 固定次序累加（与 TS 端逐字一致，见 dump_format.md）。
inline void forward(const Net& net, const float* in, float* out) {
    const int H = net.inH, W = net.inW;
    std::vector<std::vector<float>> outs;
    const float* cur = in;
    int curC = net.inC;
    for (size_t n = 0; n < net.layers.size(); ++n) {
        const Layer& L = net.layers[n];
        if (L.op == 1) {
            // 残差加：out = conv2输出(outs[-1]) + 块入口(outs[-3])。契约：固定
            // [块入口 → conv(ReLU) → conv(无act) → op1] 块结构，块入口是上一个 op1
            // 的输出（首个块 = stem 输出）；outs[-2] 是块内 conv1 的输出，不是入口。
            // outs.size()<3 属格式违规，按 0 处理并保持结构确定——导出器不会产生这种序列。
            std::vector<float> o((size_t)curC * H * W);
            if (outs.empty() || outs.back().size() != o.size() ||
                (outs.size() >= 3 && outs[outs.size() - 3].size() != o.size())) {
                // 首层就 op1 / 维度不一致属格式违规：按 0 处理并保持结构确定——
                // 导出器不会产生这种序列；直接 outs.back() 是 UB，维度错位照抄是越界读
                for (size_t j = 0; j < o.size(); ++j) o[j] = 0.f;
            } else {
                const std::vector<float>& prev = outs.back();
                if (outs.size() >= 3) {
                    const std::vector<float>& base = outs[outs.size() - 3];
                    for (size_t j = 0; j < o.size(); ++j) o[j] = prev[j] + base[j];
                } else {
                    for (size_t j = 0; j < o.size(); ++j) o[j] = prev[j];
                }
            }
            for (size_t j = 0; j < o.size(); ++j) o[j] = applyAct(o[j], L.act);
            outs.push_back(std::move(o));
            cur = outs.back().data();
            continue;
        }
        std::vector<float> o((size_t)L.outC * H * W, 0.0f);
        const int kH = L.kH, kW = L.kW, pad = L.pad;
        for (int oc = 0; oc < L.outC; ++oc) {
            const float* wbase = &L.w[(size_t)oc * curC * kH * kW];
            const float bias = L.b[oc];
            for (int r = 0; r < H; ++r) {
                for (int c = 0; c < W; ++c) {
                    float acc = bias;
                    for (int kr = 0; kr < kH; ++kr) {
                        const int sr = r + kr - pad;
                        if (sr < 0 || sr >= H) continue;
                        for (int kc = 0; kc < kW; ++kc) {
                            const int sc = c + kc - pad;
                            if (sc < 0 || sc >= W) continue;
                            const float* ip = cur + ((size_t)sr * W + sc);
                            const float* wp = wbase + (size_t)kr * kW * curC + (size_t)kc * curC;
                            for (int ic = 0; ic < curC; ++ic) acc += wp[ic] * ip[(size_t)ic * H * W];
                        }
                    }
                    o[(size_t)oc * H * W + (size_t)r * W + c] = applyAct(acc, L.act);
                }
            }
        }
        outs.push_back(std::move(o));
        cur = outs.back().data();
        curC = L.outC;
    }
    // 输出 = 最后一层的单通道平面（契约：末层 outC=1, act=sigmoid）
    for (int j = 0; j < H * W; ++j) out[j] = cur[j];
}

}  // namespace nnf

#endif  // NN_FORWARD_H
