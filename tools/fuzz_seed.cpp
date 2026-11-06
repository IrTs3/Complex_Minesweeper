// fuzz_seed.cpp —— 种子/存档解析路径的模糊测试脚手架（独立单文件，src/core 一字不改）
//
// ★ 2026-10-22（P11）：桌面端已**不再**用手写扫描器解析种子明文。
//   旧路径是 src/core/Seed.h 里的 seedJsonField() / seedJsonIntClamped() /
//   seedJsonStringArray()（找 key、找冒号、找引号、截值），它对 "9.5" 会**回退默认值 9**，
//   而网页端用 JSON.parse 得到 NaN → 同一颗种子串在两端解出不同棋盘。
//   现在桌面端改为 src/core/SeedJson.h（递归下降的严格 JSON 解析器，语义对齐 V8
//   JSON.parse），并与网页端统一为 fail-closed 契约：字段存在但非法 → 整条拒收。
//   跨端一致性由 web/test/seed-parse-parity.mjs 逐字节对拍钉死（见 tools/seedparse.cpp）。
//   本文件仍打 seedFromJson() 的两条入口：解码 base64+Rabbit 后的明文（decodeSeed），
//   和玩家直接粘进输入框的 JSON（存档导入路径）。
//
// 编译（在**仓库根目录**；ASan/UBSan 是 Apple Clang 自带的，不装任何东西）：
//   mkdir -p build-asan
//   c++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer \
//       -fsanitize-recover=address -Isrc tools/fuzz_seed.cpp -o build-asan/fuzz_seed
//   （build-asan/ 已被 .gitignore 的 build-*/ 挡掉，不会被提交）
//
// 跑：
//   ./build-asan/fuzz_seed                 # 默认 200000 轮
//   ./build-asan/fuzz_seed 2000000         # 拉长
//   ./build-asan/fuzz_seed 0 build-asan/case.txt   # 只重放一个用例（复现用）
//
// 判据不只是「没崩」：ASan/UBSan 抓到越界/UB 会自己打报告（第 1 类失败）。
// 这里还额外断言两条**解析层的契约**（第 2 类失败，会被打印成 REJECT-CASE）：
//   ① 解析器自己不许按输入规模超线性地分配内存 —— openedRows/flagRows 的行数
//      上限就是文本长度（每行至少占 `""` 两个字符），超出说明扫描器把长度算飞了。
//   ② 语料往返必须成立：encodeSeed → decodeSeed 逐字段还原，且
//      applySeed 之前那道 seedIsSane 对合法语料必须为真（桌面端 main.cpp 所有导入
//      路径都过 applySeed，所以「接受 ⟹ 合理」这条**由调用方**保证，不是 Seed.h）。
//
// 退出码：0 = 全程没有崩溃、没有违反上面两条；1 = 有用例被记进 REJECT-CASE。
#include "core/Seed.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

// splitmix64：不用 std::rand（它按区间取模会偏），也不用 random_device（每次换语料，
// 坏例子就复现不了）。种子来自命令行，缺定值 → 语料序列完全可复现。
struct Rng {
    std::uint64_t s;
    std::uint64_t next() {
        s += 0x9E3779B97F4A7C15ULL;
        std::uint64_t z = s;
        z = (z ^ (z >> 30)) * 0xBF58476D1CE4E5B9ULL;
        z = (z ^ (z >> 27)) * 0x94D049BB133111EBULL;
        return z ^ (z >> 31);
    }
    std::size_t below(std::size_t n) { return n == 0 ? 0 : static_cast<std::size_t>(next() % n); }
};

// —— 语料：把 Seed.h 声称支持的形状都覆盖一遍，而不是随便给个默认值 ——
// 每个都必须是「能被 decodeSeed 接受」的合法种子，否则变异是从垃圾上做的，深不到解析器里。
std::vector<ms::Seed> corpus() {
    std::vector<ms::Seed> v;
    auto mk = [](const char* kind, int c, int r, int m) {
        ms::Seed s;
        s.kind = kind;
        s.cols = c;
        s.rows = r;
        s.mines = m;
        s.rngSeed = 20261021;
        s.firstRow = 0;
        s.firstCol = 0;
        s.createdAt = "2026-10-21 00:00:00";
        return s;
    };
    v.push_back(mk("new", 9, 9, 10));                       // 默认开局
    v.push_back(mk("new", 16, 16, 40));                     // 中级
    v.push_back(mk("new", 30, 16, 99));                     // 高级（宽）
    {
        ms::Seed s = mk("new", 12, 12, 20);
        s.manualSplit = true;
        s.realMines = 8;
        s.imagMines = 12;
        v.push_back(s);
    }                                                    // 手动虚实分型
    {
        ms::Seed s = mk("save", 9, 9, 10);
        s.elapsedCs = 12345;
        s.phase = "won";
        s.openedRows = std::vector<std::string>(9, std::string(9, '.'));
        s.flagRows = std::vector<std::string>(9, std::string(9, '.'));
        s.openedRows[0][0] = '#';
        s.flagRows[3][4] = '2';
        s.ustcMode = true;
        v.push_back(s);
    }                                                    // 进度存档（opened/flags 走 JSON 字符串数组）
    {
        // seedFromJson 要求 cols≥5 且 rows≥5，所以「尺寸上限」这条
        // 语料只能把一条边顶到 300、另一边留在合法值 —— 顶成 300×1 会连往返都过不去。
        ms::Seed s = mk("save", 300, 5, 2);
        s.openedRows = std::vector<std::string>(5, std::string(300, '.'));
        s.flagRows = std::vector<std::string>(5, std::string(300, '.'));
        v.push_back(s);
    }                                                    // 尺寸上限（cols=300 边界）
    return v;
}

// 那些字符/片段是 JSON 文法的边界：`"` `:` `,` `]` `}`，以及会走进数字解析器的
// 数字形状（超长、带符号、带进制前缀）。随机字节很难正好砸中它们，所以专门拼一个池子。
const std::vector<std::string>& hot() {
    static const std::vector<std::string> h = {
        "\"", ":", ",", "]", "}", "{", "[", "\\", " ", "\n", "\t", "\0",
        "-1", "9999999999999999999999", "2147483648", "-2147483649", "0x10", "+",
        "\"magic\"", "\"cols\"", "\"rows\"", "\"opened\"", "\"flags\"", "\"kind\"",
        "\"save\"", "\"new\"", "true", "null", "NaN", "..", "1e999", "\"MSD1\"",
    };
    return h;
}

std::string mutate(const std::string& in, Rng& r) {
    std::string s = in;
    if (s.empty()) return s;
    const int op = static_cast<int>(r.below(6));
    const std::size_t n = s.size();
    switch (op) {
        case 0: {                                    // 翻一个字节
            const std::size_t i = r.below(n);
            s[i] = static_cast<char>(static_cast<unsigned char>(r.next() & 0xFF));
            break;
        }
        case 1: {                                    // 删一段
            const std::size_t i = r.below(n);
            const std::size_t len = 1 + r.below(std::size_t(40));
            s.erase(i, len);
            break;
        }
        case 2: {                                    // 插一段随机字节
            const std::size_t i = r.below(n);
            std::string add;
            const std::size_t len = 1 + r.below(16);
            for (std::size_t k = 0; k < len; ++k) add.push_back(static_cast<char>(r.next() & 0x7F));
            s.insert(i, add);
            break;
        }
        case 3: {                                    // 插入热点 token（专砸分界符）
            const std::size_t i = r.below(n);
            s.insert(i, hot()[r.below(hot().size())]);
            break;
        }
        case 4: {                                    // 截断（未闭合的引号/数组是这条路径的主菜）
            s.resize(r.below(n));
            break;
        }
        default: {                                   // 复制一段盖到别处（造出自相似的 JSON 结构）
            const std::size_t i = r.below(n);
            const std::size_t len = 1 + r.below(32);
            const std::size_t j = r.below(n);
            s.insert(j, s.substr(i, len));
            break;
        }
    }
    return s;
}

std::size_t g_rejects = 0;
std::size_t g_accepted = 0;
std::size_t g_alloc_peak = 0;

// 解析层的第 ① 条契约：行数不可能超过文本长度的一半（每行至少 `"",""` 三个字符）。
// 违反 = 解析器算错了下标，ASan 大概率先炸；真到了这里也要留下可复现的用例。
void check(const std::string& text, ms::Seed& out, bool ok, const char* where) {
    if (!ok) return;
    ++g_accepted;
    const std::size_t rows = out.openedRows.size() + out.flagRows.size();
    const std::size_t longest = text.size() / 2 + 8;
    if (rows > longest) {
        std::cout << "\nREJECT-CASE(" << where << ") 行数超出文本规模："
                  << rows << " > " << longest << "  输入长度=" << text.size() << "\n";
        ++g_rejects;
    }
    if (rows > g_alloc_peak) g_alloc_peak = rows;
}

// 语料往返（第 ② 条契约）：合法种子必须原样回来，且桌面端那道 seedIsSane 不许拒收。
bool roundTripOk(const ms::Seed& src) {
    const std::string enc = ms::encodeSeed(src);
    ms::Seed back;
    if (!ms::decodeSeed(enc, back)) return false;
    if (!ms::seedIsSane(back)) return false;
    return back.cols == src.cols && back.rows == src.rows && back.mines == src.mines &&
           back.kind == src.kind && back.rngSeed == src.rngSeed &&
           back.openedRows.size() == src.openedRows.size() &&
           back.flagRows.size() == src.flagRows.size();
}

int run(std::size_t iters, const std::vector<std::string>& fixed) {
    Rng r{0x5EED20261021ULL};
    const std::vector<ms::Seed> cs = corpus();

    std::vector<std::string> plainSeeds;              // 明文 JSON（直喂 seedFromJson）
    std::vector<std::string> b64Seeds;                // 密文 base64（喂 decodeSeed）
    for (const ms::Seed& s : cs) {
        plainSeeds.push_back(ms::seedToJson(s));
        b64Seeds.push_back(ms::encodeSeed(s));
        if (!roundTripOk(s)) {
            std::cout << "REJECT-CASE(round-trip) 语料自己就没往返成功：cols=" << s.cols
                      << " rows=" << s.rows << " kind=" << s.kind << "\n";
            ++g_rejects;
        }
    }

    if (!fixed.empty()) {                             // 复现模式：只跑给定的那一个用例
        for (const std::string& t : fixed) {
            ms::Seed out;
            const bool ok = ms::seedFromJson(t, out);
            std::cout << "seedFromJson -> " << (ok ? "true" : "false")
                      << "  len=" << t.size() << "\n";
            if (ok) std::cout << "回写 JSON:\n" << ms::seedToJson(out);
            check(t, out, ok, "replay");
        }
        return g_rejects ? 1 : 0;
    }

    std::cout << "fuzz_seed: " << iters << " 轮，语料 " << cs.size() << " 条（明文+密文各一份）\n";
    for (std::size_t i = 0; i < iters; ++i) {
        ms::Seed out;
        if (i % 2 == 0) {
            const std::string base = plainSeeds[r.below(plainSeeds.size())];
            const std::string t = mutate(base, r);
            check(t, out, ms::seedFromJson(t, out), "seedFromJson");
        } else {
            const std::string base = b64Seeds[r.below(b64Seeds.size())];
            const std::string t = mutate(base, r);
            check(t, out, ms::decodeSeed(t, out), "decodeSeed");
        }
        if (i && i % 50000 == 0)
            std::cout << "  " << i << " 轮：接受 " << g_accepted
                      << "，可疑用例 " << g_rejects << "，行数峰值 " << g_alloc_peak << "\n";
    }
    std::cout << "完成：" << iters << " 轮，接受 " << g_accepted << " 次，可疑 "
              << g_rejects << " 次，单次解析拿到的最大行数 " << g_alloc_peak << "\n";
    if (!g_rejects) std::cout << "没抓到问题（ASan/UBSan 也没报告）。\n";
    return g_rejects ? 1 : 0;
}

}  // namespace

int main(int argc, char** argv) {
    const std::size_t iters = argc > 1 ? static_cast<std::size_t>(std::strtoull(argv[1], nullptr, 10))
                                       : std::size_t(200000);
    std::vector<std::string> fixed;
    if (argc > 2) {
        std::ifstream in(argv[2]);
        if (!in.is_open()) {
            std::cerr << "打不开用例文件：" << argv[2] << "\n";
            return 2;
        }
        std::stringstream ss;
        ss << in.rdbuf();
        fixed.push_back(ss.str());
    }
    return run(iters, fixed);
}
