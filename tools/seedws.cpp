// seedws.cpp —— JSON 空白判据的用例表（C++ 侧）。
//
// 与 web/test/seed-ws-parity.mjs 用**同一张表**，逐行比对输出。
// 三份实现必须同口径：src/core/Seed.h 的 jsonWs、web/ts/seedcodec.ts 的 isJsonWs、
// tools/base.cpp 的 jsonWs。任何一处宽窄不一致，跨端种子互导都会静默失效
// （表现成「密码错误」—— 2026-10-21 安全审计 P7 抓到的正是这个）。
//
// 用法：seedws            输出每行 "id 0|1"
//      seedws --expect   同时校验期望值（只有在完全改对之后才有意义）

#include "core/Seed.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

struct Case {
    int id;
    const char* json;
    int want;   // 期望 jsonFieldEquals(json, "magic", "MSD1")
};

// 同一张表也在 web/test/seed-ws-parity.mjs 里，**行序必须一致**。
const std::vector<Case> kCases = {
    {1, "{\"magic\": \"MSD1\"}", 1},
    {2, "{\"magic\":\"MSD1\"}", 1},
    {3, "{\"magic\"  :   \"MSD1\"}", 1},
    {4, "{\"magic\":\t\"MSD1\"}", 1},
    {5, "{\"magic\":\n\"MSD1\"}", 1},          // ★ 修复前是 0
    {6, "{\"magic\":\r\n  \"MSD1\"}", 1},      // ★ 修复前是 0
    {7, "{\"magic\":\f\"MSD1\"}", 0},          // \f 不是 JSON 空白，三端一致拒绝
    {8, "{\"magic\":\v\"MSD1\"}", 0},          // \v 同理
    {9, "{\"magic\": \"MSD2\"}", 0},
    {10, "{\"xmagic\": \"MSD1\"}", 0},
};

} // namespace

int main(int argc, char** argv) {
    const bool expect = argc > 1 && std::strcmp(argv[1], "--expect") == 0;
    int bad = 0;
    for (const auto& c : kCases) {
        const int got = ms::jsonFieldEquals(c.json, "magic", "MSD1") ? 1 : 0;
        std::printf("%d %d\n", c.id, got);
        if (expect && got != c.want) {
            ++bad;
            std::fprintf(stderr, "case %d: 期望 %d 实际 %d\n", c.id, c.want, got);
        }
    }
    if (expect) {
        if (bad == 0) std::fprintf(stderr, "seedws: %zu cases, 0 failed\n", kCases.size());
        return bad == 0 ? 0 : 1;
    }
    return 0;
}
