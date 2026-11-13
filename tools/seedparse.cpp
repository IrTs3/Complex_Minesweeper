// seedparse.cpp —— 种子明文解析的 C++ 侧（对拍用）。
//
// 与 web/test/seed-parse-parity.mjs 用**同一张用例表**，逐条比对「是否接受 +
// 接受后各字段的值」。
//
// 为什么需要它（2026-10-22 安全审计 P11/P12）：
//   桌面端原来用「手写扫描器」找字段，网页端用 JSON.parse。同一段明文两端
//   给出的答案并不总是相同（9.5 / true / 1e2 / 重复键 / 尾随逗号…），
//   于是同一个种子串在两端解出不同的棋盘 —— 而「同一种子处处同一局」是
//   排行榜回放校验的地基。这个工具把两端的解析结果钉在一起。
//
// 用法：
//   seedparse          输出每行 "id <ACCEPT|REJECT> <字段摘要>"
//   seedparse --expect  同时校验期望值（只有在完全改对之后才有意义）
//
// 字段摘要格式（两端必须逐字节相同）：
//   kind=.. cols=.. rows=.. mines=.. manualSplit=.. realMines=.. imagMines=..
//   rngSeed=.. firstRow=.. firstCol=.. ustcMode=.. elapsedCs=.. phase=..
//   opened=<行数>:<行1,行2,…> flags=<行数>:<行1,行2,…>
//   （createdAt 不进摘要：它只是时间戳，两端各自生成，不影响棋盘。）
//
// ★ 用例表里的 JSON 文本**由程序拼出来**，不手写字符串字面量。
//   手写原始字符串 R"(...)" 时数组的 ']' 极容易漏（漏了之后整个用例文本
//   变成非法 JSON，两端一起拒收，用例就白写了 —— 本文件第一版就踩过这个坑：
//   case 3 的 opened 数组少了 ']'，两端都 REJECT，期望值却写着 ACCEPT）。
//   现在用 buildJson() 拼，语法错会立刻暴露在"两端不一致"的报错里。

#include "core/Seed.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {

// 拼一个 9×9 的存档行数组（每行 9 个 '.'）。
std::string nineRows(const char* key) {
    std::string s = std::string("\"") + key + "\":[";
    for (int i = 0; i < 9; ++i) {
        if (i) s += ",";
        s += "\".........\"";
    }
    s += "]";
    return s;
}

// 拼一个普通 new 种子的明文（cols/rows/mines 可覆盖）。
std::string buildNew(int cols, int rows, int mines, const std::string& extra = "") {
    std::string s = "{\"magic\":\"MSD1\",\"version\":1,\"kind\":\"new\",";
    s += "\"cols\":" + std::to_string(cols) + ",\"rows\":" + std::to_string(rows);
    s += ",\"mines\":" + std::to_string(mines) + ",";
    s += "\"manualSplit\":false,\"realMines\":-1,\"imagMines\":-1,\"rngSeed\":42,";
    s += "\"firstRow\":0,\"firstCol\":0,\"ustcMode\":false,\"createdAt\":\"2026-10-22 00:00:00 UTC\"";
    if (!extra.empty()) s += "," + extra;
    s += "}";
    return s;
}

struct Case {
    int id;
    std::string json;
    int want;              // 期望：1 = 接受，0 = 拒绝
    std::string wantFields;  // 期望的字段摘要（want=1 时非空）
};

// 同一张表也在 web/test/seed-parse-parity.mjs 里，**行序必须一致**。
std::vector<Case> buildCases() {
    std::vector<Case> v;
    v.push_back({1, buildNew(9, 9, 10),
        1, "kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=42 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    // 手动分型 + 16×16
    v.push_back({2,
        "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":16,\"rows\":16,\"mines\":40,"
        "\"manualSplit\":true,\"realMines\":30,\"imagMines\":10,\"rngSeed\":7,"
        "\"firstRow\":3,\"firstCol\":5,\"ustcMode\":true,\"createdAt\":\"x\"}",
        1, "kind=new cols=16 rows=16 mines=40 manualSplit=1 realMines=30 imagMines=10 "
           "rngSeed=7 firstRow=3 firstCol=5 ustcMode=1 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    // 进度存档
    v.push_back({3,
        "{\"magic\":\"MSD1\",\"kind\":\"save\",\"cols\":9,\"rows\":9,\"mines\":10,"
        "\"manualSplit\":false,\"realMines\":-1,\"imagMines\":-1,\"rngSeed\":1,"
        "\"firstRow\":0,\"firstCol\":0,\"elapsedCs\":1234,\"phase\":\"playing\","
        + nineRows("opened") + "," + nineRows("flags") +
        ",\"ustcMode\":false,\"createdAt\":\"y\"}",
        1, "kind=save cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=1 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=1234 phase=playing "
           "opened=9:.........,.........,.........,.........,.........,"
           ".........,.........,.........,......... "
           "flags=9:.........,.........,.........,.........,.........,"
           ".........,.........,.........,........."});
    // 缺字段 → 走默认值
    v.push_back({4, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"firstRow\":0,\"firstCol\":0}", 1,
        "kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
        "rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
        "opened=0: flags=0:"});
    // —— ★ 修复前的分歧点 ——
    // 9.5：修复前桌面端 strtol 失败→回退默认 9（当成合法 9×9 局），
    //       网页端 → NaN（躲过全部范围检查 → 空棋盘）。现在两端都**拒收**。
    v.push_back({5, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9.5,\"rows\":9,\"mines\":10,"
                     "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // true：修复前桌面端→回退默认，网页端 Number(true)=1。现在两端都拒收。
    v.push_back({6, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":true,\"rows\":9,\"mines\":10,"
                     "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 1e2：修复前桌面端→回退默认 9，网页端→100（**两端不一致**）。
    //       现在两端都用真 JSON 解析器 → 都得到 100 → 一致接受。
    v.push_back({7, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":1e2,\"rows\":9,\"mines\":10,"
                     "\"firstRow\":0,\"firstCol\":0}",
        1, "kind=new cols=100 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    // 字符串 "9"：修复前两端都接受（扫描器解引号 / Number("9")=9），
    //              但语义上"数字字段必须是数字"。现在两端都拒收。
    v.push_back({8, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":\"9\",\"rows\":9,\"mines\":10,"
                     "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // null：修复前桌面端 strtol 失败→回退默认，网页端 Number(null)=0。现在拒收。
    v.push_back({9, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":null,\"rows\":9,\"mines\":10,"
                     "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 重复键：修复前桌面端取**先**出现的（9），网页端取**后**出现的（30）
    //        → 同一个种子串两端棋盘不同。现在两端都取后（30）→ 一致。
    v.push_back({10, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"cols\":30,\"rows\":9,"
                      "\"mines\":10,\"firstRow\":0,\"firstCol\":0}",
        1, "kind=new cols=30 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    // 尾随逗号：修复前桌面端照收，网页端整段抛错。现在两端都拒收。
    v.push_back({11, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,}", 0, ""});
    // 尾随垃圾：修复前桌面端照收，网页端抛错。现在都拒收。
    v.push_back({12, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0} trailing garbage", 0, ""});
    // manualSplit 是字符串 "true"：修复前桌面端当真（→ 手动分型），
    //   网页端只认真布尔（→ 随机分型）→ 同一串种子两端棋盘不同。现在两端都拒收。
    v.push_back({13, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"manualSplit\":\"true\",\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 嵌套容器：契约第 9 条（两端解析器深度上限可能不同 → 统一按形状拒收）
    v.push_back({14, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,\"extra\":{\"a\":[1,2,{\"b\":3}]}}", 0, ""});
    // 1e400 → Infinity：不是有限整数
    v.push_back({15, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":1e400,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // magic 不对
    v.push_back({16, "{\"magic\":\"MSD2\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // kind 不对
    v.push_back({17, "{\"magic\":\"MSD1\",\"kind\":\"new2\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 顶层不是对象
    v.push_back({18, "[1,2,3]", 0, ""});
    // 非法 JSON
    v.push_back({19, "{\"magic\":)", 0, ""});
    // createdAt 含非 ASCII
    v.push_back({20, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,\"createdAt\":\"\xE4\xB8\xAD\xE6\x96\x87\"}", 0, ""});
    // 尺寸越界（cols < 5）
    v.push_back({21, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":4,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 首点越界
    v.push_back({22, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":99,\"firstCol\":0}", 0, ""});
    // rngSeed 越界（> 0xFFFFFFFF）
    v.push_back({23, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"rngSeed\":4294967296,\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 旧存档的 elapsedSec（秒）兼容
    v.push_back({24,
        "{\"magic\":\"MSD1\",\"kind\":\"save\",\"cols\":9,\"rows\":9,\"mines\":10,"
        "\"firstRow\":0,\"firstCol\":0,\"elapsedSec\":42,\"phase\":\"playing\","
        + nineRows("opened") + "," + nineRows("flags") + "}",
        1, "kind=save cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=4200 phase=playing "
           "opened=9:.........,.........,.........,.........,.........,"
           ".........,.........,.........,......... "
           "flags=9:.........,.........,.........,.........,.........,"
           ".........,.........,.........,........."});
    // 存档行长度不符
    v.push_back({25, "{\"magic\":\"MSD1\",\"kind\":\"save\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,\"phase\":\"playing\","
                      "\"opened\":[\".....\"],\"flags\":[\".....\"]}", 0, ""});
    // phase 非法
    v.push_back({26, "{\"magic\":\"MSD1\",\"kind\":\"save\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,\"phase\":\"weird\"}", 0, ""});
    // opened 里混入非字符串元素
    v.push_back({27, "{\"magic\":\"MSD1\",\"kind\":\"save\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0,\"phase\":\"playing\","
                      "\"opened\":[123456789],\"flags\":[\".........\"]}", 0, ""});
    // 空对象
    v.push_back({28, "{}", 0, ""});
    // 负数维度
    v.push_back({29, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":-9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // 缺失 magic
    v.push_back({30, "{\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // manualSplit 与 mines 自相矛盾（real+imag=0 < mines=2）：否则会造出 0 雷棋盘导入即胜
    v.push_back({31, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":2,"
                      "\"manualSplit\":true,\"realMines\":0,\"imagMines\":0,"
                      "\"rngSeed\":0,\"firstRow\":0,\"firstCol\":0}", 0, ""});
    // ★ rngSeed ≥ 2^31：修复前桌面端 seedJsonIntField 落地成 int，clang 把 double→int
    //   **饱和**到 2147483647（不是回绕）→ 桌面端开另一张盘、网页端开对了的那张。
    //   约一半的盘受影响；这三条钉住 2^31 边界、中间值、上界 0xFFFFFFFF。
    v.push_back({32, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"rngSeed\":2147483648,\"firstRow\":0,\"firstCol\":0}",
        1, "kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=2147483648 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    v.push_back({33, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"rngSeed\":3556999816,\"firstRow\":0,\"firstCol\":0}",
        1, "kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=3556999816 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    v.push_back({34, "{\"magic\":\"MSD1\",\"kind\":\"new\",\"cols\":9,\"rows\":9,\"mines\":10,"
                      "\"rngSeed\":4294967295,\"firstRow\":0,\"firstCol\":0}",
        1, "kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 "
           "rngSeed=4294967295 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing "
           "opened=0: flags=0:"});
    return v;
}

// 把接受后的 Seed 摘要成两端都要逐字节相同的字符串。
std::string summarize(const ms::Seed& s) {
    std::string out;
    out += "kind=" + s.kind;
    out += " cols=" + std::to_string(s.cols);
    out += " rows=" + std::to_string(s.rows);
    out += " mines=" + std::to_string(s.mines);
    out += " manualSplit=" + std::to_string(s.manualSplit ? 1 : 0);
    out += " realMines=" + std::to_string(s.realMines);
    out += " imagMines=" + std::to_string(s.imagMines);
    out += " rngSeed=" + std::to_string(s.rngSeed);
    out += " firstRow=" + std::to_string(s.firstRow);
    out += " firstCol=" + std::to_string(s.firstCol);
    out += " ustcMode=" + std::to_string(s.ustcMode ? 1 : 0);
    out += " elapsedCs=" + std::to_string(s.elapsedCs);
    out += " phase=" + s.phase;
    const auto arr = [](const std::vector<std::string>& v) {
        std::string r = std::to_string(v.size()) + ":";
        for (std::size_t i = 0; i < v.size(); ++i) {
            if (i) r += ",";
            r += v[i];
        }
        return r;
    };
    out += " opened=" + arr(s.openedRows);
    out += " flags=" + arr(s.flagRows);
    return out;
}

} // namespace

int main(int argc, char** argv) {
    const bool expect = argc > 1 && std::strcmp(argv[1], "--expect") == 0;
    const std::vector<Case> cases = buildCases();
    int bad = 0;
    for (const auto& c : cases) {
        ms::Seed s;
        const bool ok = ms::seedFromJson(c.json, s);
        // 拒绝时**不要**输出尾随空格：网页端那边是 `${id} REJECT`（无尾空格），
        // 逐字节比对要求两边完全一样。
        if (ok) std::printf("%d ACCEPT %s\n", c.id, summarize(s).c_str());
        else std::printf("%d REJECT\n", c.id);
        if (!expect) continue;
        if (static_cast<int>(ok) != c.want) {
            std::fprintf(stderr, "case %d: 期望 %s，实际 %s\n  明文：%s\n", c.id,
                         c.want ? "ACCEPT" : "REJECT", ok ? "ACCEPT" : "REJECT", c.json.c_str());
            ++bad;
        } else if (ok && summarize(s) != c.wantFields) {
            std::fprintf(stderr, "case %d: 字段不符\n  期望 %s\n  实际 %s\n", c.id,
                         c.wantFields.c_str(), summarize(s).c_str());
            ++bad;
        }
    }
    if (expect) {
        if (bad == 0) std::fprintf(stderr, "seedparse: %zu cases, 0 failed\n", cases.size());
        return bad == 0 ? 0 : 1;
    }
    return 0;
}
