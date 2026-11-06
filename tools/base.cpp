// base.cpp —— 复数扫雷种子加解密小工具（独立单文件）
//
// 只依赖 C++20 标准库，不依赖 SFML / 本项目其它文件，可单独编译
//（在**仓库根目录**执行——本文件在 tools/ 下，路径别写错）：
//     c++ -std=c++20 -O2 tools/base.cpp -o base
//
// 也可以在 CLion 里直接构建 CMake 目标 `base`（CMakeLists.txt 已按 tools/base.cpp 配置）。
// 注意：不要用「单文件临时运行配置」——那是按文件位置生成的，文件一挪就失效。
//
// 用法：
//     ./base e <密码> [输入文件] [输出文件]     加密（省略文件则用标准输入/输出）
//     ./base d <密码> [输入文件] [输出文件]     解密（密码不对会报"密码错误"）
//     密码写 - 表示不使用密钥，只做 Base64（便于查看明文 JSON）
//
// 说明：本文件内嵌的 Rabbit 流密码（RFC 4503）与 src/core/Rabbit.h 是同一实现，
//       两者的一致性由项目里的交叉测试保证（游戏加密 -> base 解密 必须还原）。
//
// 种子格式：明文是可读 JSON（含 "magic": "MSD1"），Rabbit 加密后 Base64 编码。
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <iterator>
#include <string>
#include <vector>

// ======================= Rabbit 流密码（RFC 4503，无 IV） =======================
class RabbitStream {
public:
    explicit RabbitStream(const std::string& password) {
        std::uint8_t key[16] = {};
        if (!password.empty())
            for (std::size_t i = 0; i < 16; ++i) key[i] = static_cast<std::uint8_t>(password[i % password.size()]);
        keySetup(key);
    }
    explicit RabbitStream(const std::uint8_t key[16]) { keySetup(key); }

    void xorData(const std::uint8_t* in, std::uint8_t* out, std::size_t n) {
        for (std::size_t i = 0; i < n; ++i) {
            if (pos_ >= 16) refill();
            out[i] = static_cast<std::uint8_t>(in[i] ^ block_[static_cast<std::size_t>(pos_++)]);
        }
    }
    std::vector<std::uint8_t> crypt(const std::vector<std::uint8_t>& in) {
        std::vector<std::uint8_t> out(in.size());
        if (!in.empty()) xorData(in.data(), out.data(), in.size());
        return out;
    }

private:
    void keySetup(const std::uint8_t key[16]) {
        // RFC 4503：K0 = K[15..0] 是密钥的最高 16 位（key[14]||key[15]，大端）
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
        pos_ = 16; // 无 IV：异或后即可开始出块
    }

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

    // 输出块：RFC 把 S 写成整体大端字节串（16 位字按 s[7..0] 倒序、字内大端）
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

// ======================= Base64 =======================
static std::string b64Encode(const std::vector<std::uint8_t>& data) {
    static const char* tbl = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const std::size_t n = data.size();
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

static bool b64Decode(const std::string& s, std::vector<std::uint8_t>& out) {
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

// JSON 的合法空白：RFC 8259 只有这 4 个。
// ★ 必须与 src/core/Seed.h 的 jsonWs、web/ts/seedcodec.ts 的 isJsonWs 完全同口径。
static bool jsonWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

// ======================= 命令行 =======================
// JSON 里取字段值并与期望比较：**容忍任意空白**。
// ★ 与 src/core/Seed.h 的 jsonFieldEquals / web/ts/seedcodec.ts 的同名函数**必须同口径**
//   （三处都要判同一个 magic，改一处必须改另两处）。
//   为什么不搜固定子串 `"magic": "MSD1"`：那依赖冒号后那个空格，纯属巧合 ——
//   哪天游戏改用 JSON.stringify（默认紧凑输出），三处会一起静默失效，
//   而对外报的是「密码错误」，把排查方向引到密码上（其实密码是对的）。
static bool jsonFieldEquals(const std::string& json, const char* key, const char* value) {
    const std::string pat = std::string("\"") + key + "\"";
    const std::string want = std::string("\"") + value + "\"";
    std::size_t p = json.find(pat);
    while (p != std::string::npos) {
        std::size_t i = p + pat.size();
        while (i < json.size() && jsonWs(json[i])) ++i;
        if (i < json.size() && json[i] == ':') {
            ++i;
            while (i < json.size() && jsonWs(json[i])) ++i;
            if (json.compare(i, want.size(), want) == 0) return true;
        }
        p = json.find(pat, p + 1);
    }
    return false;
}

static const char* kMagicKey = "magic";
static const char* kMagicVal = "MSD1";

static bool readAll(const std::string& path, std::string& data) {
    if (path == "-" || path.empty()) {
        data.assign(std::istreambuf_iterator<char>(std::cin), std::istreambuf_iterator<char>());
        return true;
    }
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    data.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
    return true;
}

static bool writeAll(const std::string& path, const std::string& data) {
    if (path == "-" || path.empty()) {
        std::cout << data;
        return static_cast<bool>(std::cout);
    }
    std::ofstream f(path, std::ios::binary);
    if (!f) return false;
    f << data;
    return static_cast<bool>(f);
}

static void usage() {
    std::cerr << "用法：\n"
              << "  base e <密码> [输入文件] [输出文件]   加密（密码 - 表示只做 Base64）\n"
              << "  base d <密码> [输入文件] [输出文件]   解密（密码不对会报错）\n"
              << "省略文件则读写标准输入/输出。\n"
              << "开关可写在任何位置：-f / --force 强制输出解密结果（跳过 magic 校验），"
              << "-h / --help 显示本帮助。\n";
}

int main(int argc, char** argv) {
    // 先把开关摘掉，剩下的按位置解释：第 1 个是模式、第 2 个是密码、之后是输入/输出文件。
    // ★ 开关**可以在任何位置**（2026-10-21 改进）：原来只扫 argv[3..]，
    //   于是 `base -f d <密码>` 会被当成「模式 = -f」而报用法，
    //   而 `base d -f <密码>` 又恰好能work —— 同一个意思两种写法只有一种能用，纯属碰巧。
    bool force = false;
    std::vector<std::string> args;
    for (int i = 1; i < argc; ++i) {
        const std::string a = argv[i];
        if (a == "-f" || a == "--force") { force = true; continue; }
        if (a == "-h" || a == "--help") { usage(); return 0; }
        args.push_back(a);
    }
    if (args.size() < 2) { usage(); return 1; }
    const std::string mode = args[0];
    const std::string password = args[1];
    const std::string inPath = args.size() > 2 ? args[2] : "-";
    const std::string outPath = args.size() > 3 ? args[3] : "-";
    const bool useKey = (password != "-");

    std::string input;
    if (!readAll(inPath, input)) { std::cerr << "无法读取输入：" << inPath << "\n"; return 1; }

    if (mode == "e" || mode == "encrypt") {
        std::vector<std::uint8_t> data(input.begin(), input.end());
        if (useKey) {
            RabbitStream r(password);
            data = r.crypt(data);
        }
        const std::string out = b64Encode(data) + "\n";
        if (!writeAll(outPath, out)) { std::cerr << "无法写出：" << outPath << "\n"; return 1; }
        std::cerr << (useKey ? "已加密" : "已 Base64（未使用密钥）") << "：" << data.size() << " 字节\n";
        return 0;
    }
    if (mode == "d" || mode == "decrypt") {
        std::vector<std::uint8_t> data;
        if (!b64Decode(input, data)) { std::cerr << "Base64 解码失败\n"; return 1; }
        if (useKey) {
            RabbitStream r(password);
            data = r.crypt(data);
        }
        const std::string out(data.begin(), data.end());
        if (!jsonFieldEquals(out, kMagicKey, kMagicVal) && !force) {
            std::cerr << "密码错误（或内容不是本游戏的种子）\n";
            return 2;
        }
        if (!writeAll(outPath, out)) { std::cerr << "无法写出：" << outPath << "\n"; return 1; }
        std::cerr << "已解密：" << out.size() << " 字节\n";
        return 0;
    }
    usage();
    return 1;
}
