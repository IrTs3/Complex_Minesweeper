#pragma once
// Rabbit 流密码（RFC 4503，不使用 IV）+ Base64 编解码。
// 只依赖 C++20 标准库：base.cpp 等外部工具可直接复用本文件。
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace ms {

class RabbitStream {
public:
    explicit RabbitStream(const std::string& password) {
        std::uint8_t key[16] = {};
        if (!password.empty()) {
            for (std::size_t i = 0; i < 16; ++i) key[i] = static_cast<std::uint8_t>(password[i % password.size()]);
        }
        keySetup(key);
    }
    explicit RabbitStream(const std::uint8_t key[16]) { keySetup(key); }

    // 加解密同一个操作：out[i] = in[i] ^ keystream[i]
    void xorData(const std::uint8_t* in, std::uint8_t* out, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) {
            if (pos_ >= 16) refill();
            out[i] = static_cast<std::uint8_t>(in[i] ^ block_[static_cast<std::size_t>(pos_++)]);
        }
    }
    [[nodiscard]] std::vector<std::uint8_t> crypt(const std::vector<std::uint8_t>& in) {
        std::vector<std::uint8_t> out(in.size());
        if (!in.empty()) xorData(in.data(), out.data(), in.size());
        return out;
    }

private:
    void keySetup(const std::uint8_t key[16]) {
        // RFC 4503：K0 = K[15..0] 是密钥的最高 16 位，即 key[14]||key[15]（大端）
        std::uint16_t k[8];
        for (int i = 0; i < 8; ++i)
            k[i] = static_cast<std::uint16_t>((static_cast<std::uint16_t>(key[14 - 2 * i]) << 8) | key[15 - 2 * i]);
        for (int j = 0; j < 8; ++j) {
            const int j1 = (j + 1) % 8, j4 = (j + 4) % 8, j5 = (j + 5) % 8;
            if (j % 2 == 0) {
                x_[j] = (static_cast<std::uint32_t>(k[j1]) << 16) | k[j];
                c_[j] = (static_cast<std::uint32_t>(k[j4]) << 16) | k[j5];
            } else {
                x_[j] = (static_cast<std::uint32_t>(k[j5]) << 16) | k[j4];
                c_[j] = (static_cast<std::uint32_t>(k[j]) << 16) | k[j1];
            }
        }
        carry_ = 0;
        for (int i = 0; i < 4; ++i) step();
        for (int j = 0; j < 8; ++j) c_[j] ^= x_[(j + 4) % 8];
        // RFC 4503 §2.3：计数器异或后即完成 setup；不加 IV 时直接开始出块
        // （多迭代 4 次会变成 §A.2 的 IV=0 向量——已用附录 B 状态逐位验证）
        pos_ = 16;
    }

    // RFC 4503 §2.5 计数器更新 + §2.6 下一状态函数
    void step() {
        static const std::uint32_t kA[8] = {0x4D34D34D, 0xD34D34D3, 0x34D34D34, 0x4D34D34D,
                                            0xD34D34D3, 0x34D34D34, 0x4D34D34D, 0xD34D34D3};
        for (int j = 0; j < 8; ++j) {
            const std::uint64_t t = static_cast<std::uint64_t>(c_[j]) + kA[j] + carry_;
            carry_ = static_cast<std::uint32_t>(t >> 32);
            c_[j] = static_cast<std::uint32_t>(t);
        }
        std::uint32_t g[8];
        for (int j = 0; j < 8; ++j) {
            const std::uint32_t u = x_[j] + c_[j];
            const std::uint64_t sq = static_cast<std::uint64_t>(u) * u;
            g[j] = static_cast<std::uint32_t>(sq) ^ static_cast<std::uint32_t>(sq >> 32);
        }
        const auto rotl = [](std::uint32_t v, int n) {
            return static_cast<std::uint32_t>((v << n) | (v >> (32 - n)));
        };
        x_[0] = g[0] + rotl(g[7], 16) + rotl(g[6], 16);
        x_[1] = g[1] + rotl(g[0], 8) + g[7];
        x_[2] = g[2] + rotl(g[1], 16) + rotl(g[0], 16);
        x_[3] = g[3] + rotl(g[2], 8) + g[1];
        x_[4] = g[4] + rotl(g[3], 16) + rotl(g[2], 16);
        x_[5] = g[5] + rotl(g[4], 8) + g[3];
        x_[6] = g[6] + rotl(g[5], 16) + rotl(g[4], 16);
        x_[7] = g[7] + rotl(g[6], 8) + g[5];
    }

    // RFC 4503 §2.7 提取 128bit 输出块。RFC 把 S 写成整体大端字节串：
    // 首个字节是 S[127..120]，因此 16 位字按 s[7..0] 倒序、每个字内部大端。
    void extract(std::uint8_t out[16]) const {
        const std::uint16_t s[8] = {
            static_cast<std::uint16_t>(x_[0] ^ (x_[5] >> 16)),
            static_cast<std::uint16_t>((x_[0] >> 16) ^ x_[3]),
            static_cast<std::uint16_t>(x_[2] ^ (x_[7] >> 16)),
            static_cast<std::uint16_t>((x_[2] >> 16) ^ x_[5]),
            static_cast<std::uint16_t>(x_[4] ^ (x_[1] >> 16)),
            static_cast<std::uint16_t>((x_[4] >> 16) ^ x_[7]),
            static_cast<std::uint16_t>(x_[6] ^ (x_[3] >> 16)),
            static_cast<std::uint16_t>((x_[6] >> 16) ^ x_[1]),
        };
        for (int i = 0; i < 8; ++i) {
            out[2 * i] = static_cast<std::uint8_t>(s[7 - i] >> 8);
            out[2 * i + 1] = static_cast<std::uint8_t>(s[7 - i] & 0xFF);
        }
    }

    void refill() {
        step();
        extract(block_);
        pos_ = 0;
    }

    std::uint32_t x_[8] = {};
    std::uint32_t c_[8] = {};
    std::uint32_t carry_ = 0;
    std::uint8_t block_[16] = {};
    int pos_ = 16;
};

// —— Base64（标准字母表，末尾补 '='）——
inline std::string base64Encode(const std::uint8_t* data, std::size_t n) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve((n + 2) / 3 * 4);
    for (std::size_t i = 0; i < n; i += 3) {
        const std::uint32_t b0 = data[i];
        const std::uint32_t b1 = (i + 1 < n) ? data[i + 1] : 0;
        const std::uint32_t b2 = (i + 2 < n) ? data[i + 2] : 0;
        const std::uint32_t v = (b0 << 16) | (b1 << 8) | b2;
        out += tbl[(v >> 18) & 63];
        out += tbl[(v >> 12) & 63];
        out += (i + 1 < n) ? tbl[(v >> 6) & 63] : '=';
        out += (i + 2 < n) ? tbl[v & 63] : '=';
    }
    return out;
}

inline bool base64Decode(const std::string& s, std::vector<std::uint8_t>& out) {
    auto val = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    out.clear();
    std::uint32_t buf = 0;
    int bits = 0;
    for (char c : s) {
        if (c == '=' || c == '\n' || c == '\r' || c == ' ' || c == '\t') continue;
        const int v = val(c);
        if (v < 0) return false;
        buf = (buf << 6) | static_cast<std::uint32_t>(v);
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push_back(static_cast<std::uint8_t>((buf >> bits) & 0xFF));
        }
    }
    return true;
}

} // namespace ms
