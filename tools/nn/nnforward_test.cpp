// nnforward_test.cpp — 三方对拍的 C++ 一方：加载 assets/nn/student.cnnw，
// 对 golden.jsonl 的 forward case 逐个前向，容差 1e-5（契约 tools/nn/dump_format.md §4）。
// 编译：cmake 目标 nnforward-test，或裸编：
//   g++ -O2 -std=c++17 -I src tools/nn/nnforward_test.cpp -o tools/nn/nnforward_test
// 退出码 0=全过；任何不一致 stderr 吭声。
#include "solver/NNForward.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

namespace {

std::string slurp(const char* path) {
    std::FILE* f = std::fopen(path, "rb");
    if (!f) { std::fprintf(stderr, "nnforward_test: 打不开 %s\n", path); std::exit(2); }
    std::string s;
    char buf[65536];
    size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) s.append(buf, n);
    std::fclose(f);
    return s;
}

// 我们自己的金标文件，粗解析足够：定位键名后取值。
bool findString(const std::string& s, size_t from, const char* key, std::string& out) {
    size_t p = s.find(key, from);
    if (p == std::string::npos) return false;
    p += std::strlen(key);
    if (p >= s.size() || s[p] != '"') return false;
    ++p;
    while (p < s.size() && s[p] != '"') out.push_back(s[p++]);
    return true;
}

bool findArray(const std::string& s, size_t from, const char* key, std::vector<float>& out) {
    size_t p = s.find(key, from);
    if (p == std::string::npos) return false;
    p += std::strlen(key);
    if (p >= s.size() || s[p] != '[') return false;
    ++p;
    while (p < s.size() && s[p] != ']') {
        char* end = nullptr;
        const double v = std::strtod(s.c_str() + p, &end);
        if (end == s.c_str() + p) return false;
        out.push_back((float)v);
        p = (size_t)(end - s.c_str());
        while (p < s.size() && (s[p] == ',' || s[p] == ' ')) ++p;
    }
    return true;
}

int b64val(char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

std::vector<uint8_t> b64decode(const std::string& in) {
    std::vector<uint8_t> out;
    int acc = 0, bits = 0;
    for (char c : in) {
        const int v = b64val(c);
        if (v < 0) continue;
        acc = (acc << 6) | v;
        bits += 6;
        if (bits >= 8) { bits -= 8; out.push_back((uint8_t)(acc >> bits)); }
    }
    return out;
}

} // namespace

int main(int argc, char** argv) {
    const char* weights = argc > 1 ? argv[1] : "assets/nn/student.cnnw";
    const char* golden = argc > 2 ? argv[2] : "tools/nn/golden/golden.jsonl";
    nnf::Net net;
    std::string err;
    if (!nnf::load_cnnw(weights, net, err)) {
        std::fprintf(stderr, "nnforward_test: 权重加载失败：%s\n", err.c_str());
        return 2;
    }
    const std::string g = slurp(golden);
    int cases = 0, bad = 0;
    size_t pos = 0;
    while (true) {
        size_t k = g.find("\"kind\": \"forward\"", pos);
        if (k == std::string::npos) break;
        std::string b64;
        std::vector<float> want;
        if (!findString(g, k, "\"inB64\": ", b64) || !findArray(g, k, "\"out\": ", want)) {
            std::fprintf(stderr, "nnforward_test: case %d 解析失败\n", cases);
            ++bad; ++cases;
            pos = k + 1;
            continue;
        }
        const std::vector<uint8_t> raw = b64decode(b64);
        std::vector<float> in(raw.size() / 4), out((size_t)net.inH * net.inW, 0.0f);
        std::memcpy(in.data(), raw.data(), in.size() * 4);
        nnf::forward(net, in.data(), out.data());
        float maxErr = 0.0f;
        for (size_t i = 0; i < want.size() && i < out.size(); ++i)
            maxErr = std::max(maxErr, std::fabs(out[i] - want[i]));
        if (maxErr > 1e-5f) {
            std::fprintf(stderr, "nnforward_test: case %d 最大偏差 %.3e > 1e-5\n", cases, maxErr);
            ++bad;
        }
        ++cases;
        pos = k + 1;
    }
    if (cases == 0) { std::fprintf(stderr, "nnforward_test: 金标里没有 forward case\n"); return 2; }
    if (bad) { std::fprintf(stderr, "nnforward_test: %d/%d 超差\n", bad, cases); return 1; }
    std::printf("nnforward_test: %d 个 forward case 全过（C++ ≤1e-5）\n", cases);
    return 0;
}
