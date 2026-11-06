#pragma once
// 复数扫雷"种子 / 存档"。
//
// 明文是一段便于阅读的 JSON，经 Rabbit **混淆**（密钥默认 TY0712#66ccff）后再 Base64，
// 就是玩家复制的那串文本。两种用途共用同一格式、同一导入入口：
//   kind = "new"   新开局种子（只够复现整局）
//   kind = "save"  进度存档（额外记录已翻开/已标记的格子、用时与阶段）
// 只依赖 C++20 标准库与 Rabbit.h（不含 SFML），base.cpp 等外部工具可复用同一格式。
//
// ★ 这层是**混淆，不是加密**，别拿它当信任根（2026-10-21 安全审查 M5）：
//   - 密钥硬编码在这里，而本文件会进桌面端二进制 —— 任何拿到 app 的人都能提取出来；
//   - Rabbit.h 没有 IV、没有 MAC，密钥按 key[i] = password[i % size] 循环填。
//   结论：任何人都能离线伪造一个"看起来合法"的种子/存档发给你。
//   所以它只防"随手改个数字逗你玩"，**不防伪造**。
//   将来若做服务端排行榜回放校验，必须用独立密钥重算，不能拿这个当权威。
//   （真要改格式就得动已发出去的种子串，属于破坏性变更，别顺手做。）
#include "Rabbit.h"
#include "SeedJson.h"   // 真 JSON 解析器（2026-10-22 安全审计 P11）

#include <cerrno>
#include <cstdint>
#include <cstdlib>
#include <string>
#include <vector>

namespace ms {

// JSON 的合法空白：RFC 8259 只有这 4 个（空格 / \t / \n / \r）。
// \f 与 \v 在 JSON 里非法，任何正规序列化器都不会产生 —— 三端一起拒绝。
// ★ 2026-10-21 安全审计 P7：原来 seedJsonField 跳 4 个，jsonFieldEquals 只跳 2 个
//   （空格和 \t）。于是 `"magic"\n: "MSD1"` 这种排版会被判成「密码错误」——
//   正是那次改动想消除的误导。现在两处共用这一个判据。
inline bool jsonWs(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

inline constexpr const char* kSeedMagic = "MSD1";
inline constexpr const char* kSeedKey = "TY0712#66ccff";

struct Seed {
    // —— 开局信息（决定雷分布）——
    int cols = 9;                 // 列
    int rows = 9;                 // 行
    int mines = 10;               // 雷数（随机分型时即总数）
    int realMines = -1;           // 手动分型：实雷数（-1 表示随机分型）
    int imagMines = -1;           // 手动分型：虚雷数
    bool manualSplit = false;     // 是否手动指定虚实数量
    std::uint32_t rngSeed = 0;    // 随机数种子
    int firstRow = -1;            // 首点行（决定布雷位置，必须复现）
    int firstCol = -1;            // 首点列

    // —— 进度存档（kind = "save" 时有效）——
    std::string kind = "new";                 // "new" 新开局 / "save" 进度存档
    int elapsedCs = 0;                        // 已用时（厘秒，0.01s 精度）
    std::string phase = "playing";            // playing / won / lost
    std::vector<std::string> openedRows;      // 每行一串：'#' 已翻开，'.' 未翻开
    std::vector<std::string> flagRows;        // 每行一串：'.' 无标记，1=+1 2=-1 3=+i 4=-i

    bool ustcMode = false;                    // 彩蛋复选框状态（显示 USTC 字母）
    std::string createdAt;                    // 生成时间（仅供人阅读）
};

// 导入的种子/存档是一段外部文本，必须先校验合理性：
// 否则一个 cols=99999 的种子会直接 new 出天文数字的格子把内存吃爆。
inline bool seedIsSane(const Seed& s) {
    const long long cells = static_cast<long long>(s.cols) * static_cast<long long>(s.rows);
    if (s.cols < 1 || s.rows < 1) return false;
    if (s.cols > 300 || s.rows > 300 || cells > 40000) return false;
    if (s.mines < 0 || s.mines > cells - 1) return false;
    // 注意：非手动分型时 realMines/imagMines 是 -1（"首点时随机分型"的哨兵值），
    // 这是合法状态，不能当成非法值拒收——否则所有开局种子都会报 BAD SEED。
    if (s.realMines < -1 || s.imagMines < -1) return false;
    if (s.manualSplit) { // 手动分型：两者都必须给出，总数不能超过格子数，且与 mines 一致
        if (s.realMines < 0 || s.imagMines < 0) return false;
        if (static_cast<long long>(s.realMines) + s.imagMines > cells - 1) return false;
        if (s.mines != s.realMines + s.imagMines) return false;
    } else if (s.realMines >= 0 && s.imagMines >= 0) { // 非手动但给了具体分型，同样校验
        if (static_cast<long long>(s.realMines) + s.imagMines > cells - 1) return false;
    }
    if (s.firstRow < -1 || s.firstCol < -1 || s.firstRow > s.rows || s.firstCol > s.cols) return false;
    return true;
}


// —— 严格字段契约（2026-10-22 安全审计 P11/P12）─────────────────────────
//
// ★ 为什么从「手写扫描器」换成「真 JSON 解析器 + 显式契约」：
//   原来这里用 seedJsonField()/seedJsonInt() 之类的**手写扫描**去明文里找字段，
//   而网页端用的是 JSON.parse。两套解析器对**同一段明文**给出的答案并不总是相同：
//     · "cols": 9.5   扫描器 strtol 失败 → **静默回退默认值 9**（当成合法棋盘）
//                    JSON.parse → 9.5（不是整数）
//     · "cols": true  扫描器 → 回退默认值；JSON.parse → 布尔，Number(true)=1
//     · "cols": 1e2   扫描器 → 回退默认值；JSON.parse → 100
//     · 重复键        扫描器取**先**出现的；JSON.parse 取**后**出现的
//     · 尾随逗号      扫描器照收；JSON.parse 整段报错
//   于是**同一个种子串在两端解出不同的棋盘** —— 而「同一种子处处同一局」正是
//   排行榜回放校验的地基。桌面端现在也用真 JSON 解析器（SeedJson.h，语义与
//   JSON.parse 对齐），两端是否真的对齐由 web/test/seed-parse-parity.mjs 对拍证明。
//
// 契约（**两端必须逐条一致**）：
//   1) 明文必须是合法 JSON，且顶层是对象。解析失败 / 顶层不是对象 → 整条拒收。
//   2) magic 必须是字符串 "MSD1"；kind 必须是字符串 "new" 或 "save"。
//   3) 数字字段：必须是 JSON **数字**、**有限**、**整数**（无小数部分）。
//      缺失 → 取默认值；存在但不合格 → **整条拒收**（绝不静默回退默认值）。
//   4) 布尔字段（manualSplit / ustcMode）：必须是 JSON 布尔；
//      缺失 → false；存在但不是布尔 → 整条拒收。
//      （原扫描器把字符串 "true" 也当 true，网页端只认真布尔 → 两端分型不同 → 不同棋盘）
//   5) 文本字段（createdAt）：必须是字符串且**纯 ASCII**；缺失 → ""；否则整条拒收。
//   6) phase：必须是 "playing" / "won" / "lost"；缺失 → "playing"；否则整条拒收。
//   7) opened / flags：必须是**字符串数组**（元素也纯 ASCII）；缺失 → 空数组；
//      否则整条拒收。行数与行长在下面按尺寸校验。
//   8) 数值区间：cols/rows/mines/realMines/imagMines/firstRow/firstCol ∈ [-1, 1e9]；
//      rngSeed ∈ [0, 0xFFFFFFFF]；elapsedCs ∈ [0, 36e6]；elapsedSec ∈ [0, 360000]。
//      区间只是**溢出护栏**，真正的合理性由 seedIsSane（两端同一份判定）收紧。
//
// 字段的**语义**判定（尺寸上限、雷数、虚实分型、首点范围）仍由 seedIsSane 负责，
// 它在两端是同一份判定（见该函数注释）。

// 溢出护栏用的宽区间。真正的上限由 seedIsSane 收紧（cols/rows ≤ 300、cells ≤ 40000…）。
inline constexpr int kSeedNumLimit = 1000000000;      // 行列/雷数的宽松上限（仍由 seedIsSane 收紧）
inline constexpr int kMaxElapsedCs = 36000000;        // 用时上限 100 小时（厘秒）
// rngSeed 是 uint32。★ 上限必须写成 **long long**：0xFFFFFFFF 这个字面量在 C++ 里
// 类型是 unsigned（值 4294967295 超过 int 上限），赋给 int 会溢出成 -1 ——
// 那样 hi 变成 -1，任何正常 rngSeed 都会被判"越界"而拒收（2026-10-22 写这个时踩过）。
inline constexpr long long kRngSeedMax = 4294967295LL;  // = 0xFFFFFFFF

// 取一个整数字段：缺失 → def；存在但不是「有限整数」或超出区间 → 返回 false（整条拒收）。
// lo / hi 用 long long 传：rngSeed 的上限 4294967295 超过 int 范围。
// ★ out 的类型由调用点推导（2026-11-02）：写成固定 int 时，rngSeed ≥ 2^31 会被
//   `static_cast<int>(double)` **饱和**成 2147483647（不是回绕），桌面端解出另一张盘，
//   与网页端（JS number 保得住 32 位无符号）分道 —— 区间检查是 long long，拦不住这一步。
template <typename T>
inline bool seedJsonIntField(const json::Value& obj, const char* key, int def,
                             long long lo, long long hi, T& out) {
    const json::Value* v = obj.member(key);
    if (!v) { out = static_cast<T>(def); return true; }
    if (v->type != json::Type::Number) return false;
    if (!std::isfinite(v->number)) return false;          // 1e400 / Infinity 一律拒收
    if (v->number != std::floor(v->number)) return false;  // 9.5 不是整数
    if (v->number < static_cast<double>(lo) || v->number > static_cast<double>(hi)) return false;
    out = static_cast<T>(v->number);
    return true;
}

// 取一个布尔字段：缺失 → def；存在但不是 JSON 布尔 → 返回 false。
inline bool seedJsonBoolField(const json::Value& obj, const char* key, bool def, bool& out) {
    const json::Value* v = obj.member(key);
    if (!v) { out = def; return true; }
    if (v->type != json::Type::Bool) return false;
    out = v->boolean;
    return true;
}

// 取一个文本字段：缺失 → def；存在但不是字符串 / 含非 ASCII → 返回 false。
inline bool seedJsonTextField(const json::Value& obj, const char* key, const char* def,
                              std::string& out) {
    const json::Value* v = obj.member(key);
    if (!v) { out = def; return true; }
    if (v->type != json::Type::String) return false;
    if (!json::isAscii(v->text)) return false;
    out = v->text;
    return true;
}

// 取一个字符串数组字段：缺失 → 空；存在但不是数组 / 元素不是字符串 / 含非 ASCII → 返回 false。
inline bool seedJsonTextArray(const json::Value& obj, const char* key,
                              std::vector<std::string>& out) {
    out.clear();
    const json::Value* v = obj.member(key);
    if (!v) return true;                                  // 缺失 → 空数组
    if (v->type != json::Type::Array) return false;
    for (const json::Value& e : v->array) {
        if (e.type != json::Type::String) return false;
        if (!json::isAscii(e.text)) return false;
        out.push_back(e.text);
    }
    return true;
}

// 契约补充（两端必须一致）：顶层对象的**每个成员的值**必须是标量
// （字符串 / 数字 / 布尔 / null）或**标量数组**（元素也都是标量）。
// 也就是说：种子明文里不允许出现嵌套的对象或数组。
//
// ★ 为什么加这条：两端解析器的**深度上限**本来就可能不同（网页端是 V8 的
//   JSON.parse，桌面端是本文件的递归下降解析器，上限 200）。如果不限制形状，
//   一个「深嵌套但字段都合法」的明文可能网页端接受、桌面端拒绝 —— 又是跨端分歧。
//   限制成扁平形状后，任何嵌套输入在两端都被这条规则拒收，深度上限只影响
//   「以什么理由拒收」，不影响「是否拒收」。
// 本程序自己写出的明文本来就是扁平的（见 seedToJson），所以这条不影响正常种子。
inline bool seedJsonFlatObject(const json::Value& root) {
    for (const auto& kv : root.object) {
        const json::Value& v = kv.second;
        if (v.type == json::Type::Object) return false;   // 不允许嵌套对象
        if (v.type == json::Type::Array) {
            for (const json::Value& e : v.array)
                if (e.type == json::Type::Object || e.type == json::Type::Array) return false;
        }
    }
    return true;
}

// 字符串字面量转义：反斜杠、双引号与 <0x20 控制字符。createdAt 等值虽经 ASCII
// 白名单，仍可含双引号/反斜杠，直接拼接会产形 JSON 并能注入字段（两端同病对称修，
// 网页端用 JSON.stringify）。解码端 json::parse 早已支持 \" \\ \uXXXX。
inline std::string jsonEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (c == '\\' || c == '"') {
            out += '\\';
            out += c;
        } else if (u < 0x20) {
            const char hex[] = "0123456789abcdef";
            out += "\\u00";
            out += hex[u >> 4];
            out += hex[u & 0xf];
        } else {
            out += c;
        }
    }
    return out;
}

// 明文 JSON（缩进换行，方便直接阅读；存档还会画出一张"棋盘图"）
inline std::string seedToJson(const Seed& s) {
    const auto b = [](bool v) { return std::string(v ? "true" : "false"); };
    std::string j;
    j += "{\n";
    j += "  \"magic\": \"" + std::string(kSeedMagic) + "\",\n";
    j += "  \"version\": 1,\n";
    j += "  \"kind\": \"" + jsonEscape(s.kind) + "\",\n";
    j += "  \"cols\": " + std::to_string(s.cols) + ",\n";
    j += "  \"rows\": " + std::to_string(s.rows) + ",\n";
    j += "  \"mines\": " + std::to_string(s.mines) + ",\n";
    j += "  \"manualSplit\": " + b(s.manualSplit) + ",\n";
    j += "  \"realMines\": " + std::to_string(s.realMines) + ",\n";
    j += "  \"imagMines\": " + std::to_string(s.imagMines) + ",\n";
    j += "  \"rngSeed\": " + std::to_string(s.rngSeed) + ",\n";
    j += "  \"firstRow\": " + std::to_string(s.firstRow) + ",\n";
    j += "  \"firstCol\": " + std::to_string(s.firstCol) + ",\n";
    if (s.kind == "save") {
        const auto arr = [&](const char* name, const std::vector<std::string>& rows) {
            std::string out = "  \"" + std::string(name) + "\": [";
            for (std::size_t i = 0; i < rows.size(); ++i) {
                out += (i == 0 ? "\n" : ",\n");
                out += "    \"" + rows[i] + "\"";
            }
            out += (rows.empty() ? "],\n" : "\n  ],\n");
            return out;
        };
        j += "  \"elapsedCs\": " + std::to_string(s.elapsedCs) + ",\n";
        j += "  \"phase\": \"" + jsonEscape(s.phase) + "\",\n";
        j += arr("opened", s.openedRows);
        j += arr("flags", s.flagRows);
    }
    j += "  \"ustcMode\": " + b(s.ustcMode) + ",\n";
    j += "  \"createdAt\": \"" + jsonEscape(s.createdAt) + "\"\n";
    j += "}\n";
    return j;
}

// 明文 JSON → Seed。**解析与字段契约**（2026-10-22 安全审计 P11/P12）。
// 契约的逐条说明见上面「严格字段契约」注释；网页端必须与这里**逐条一致**，
// 由 web/test/seed-parse-parity.mjs 对拍证明。
inline bool seedFromJson(const std::string& text, Seed& out) {
    // 1) 先整段解析。解析失败（尾随垃圾 / 尾随逗号 / 前导零 / 非法字面量 /
    //    未转义控制字符 / 深度超限）→ 整条拒收。**不再**用扫描器去"找得到就认"。
    json::Value root;
    if (!json::parse(text, root)) return false;
    if (!root.isObject()) return false;
    if (!seedJsonFlatObject(root)) return false;   // 不允许嵌套容器（见该函数注释）

    Seed s;
    // 2) magic 与 kind：必须是字符串且取值合法（缺失 / 类型不对 → 拒收）
    {
        const json::Value* v = root.member("magic");
        if (!v || v->type != json::Type::String || v->text != kSeedMagic) return false;
    }
    {
        const json::Value* v = root.member("kind");
        if (!v || v->type != json::Type::String) return false;
        s.kind = v->text;
        if (s.kind != "new" && s.kind != "save") return false;
    }

    // 3) 数字字段：缺失 → 默认值；存在但不是「有限整数」或越界 → **整条拒收**。
    //    区间是溢出护栏，真正的合理性由 seedIsSane 收紧。
    const int lim = kSeedNumLimit;
    if (!seedJsonIntField(root, "cols", 9, -lim, lim, s.cols)) return false;
    if (!seedJsonIntField(root, "rows", 9, -lim, lim, s.rows)) return false;
    if (!seedJsonIntField(root, "mines", 10, -lim, lim, s.mines)) return false;
    if (!seedJsonIntField(root, "realMines", -1, -lim, lim, s.realMines)) return false;
    if (!seedJsonIntField(root, "imagMines", -1, -lim, lim, s.imagMines)) return false;
    if (!seedJsonIntField(root, "firstRow", -1, -lim, lim, s.firstRow)) return false;
    if (!seedJsonIntField(root, "firstCol", -1, -lim, lim, s.firstCol)) return false;
    // rngSeed 是 uint32：区间 [0, 0xFFFFFFFF]，越界即拒收（原来靠模 2^32 静默回绕）
    {
        std::uint32_t rng = 0;
        if (!seedJsonIntField(root, "rngSeed", 0, 0, kRngSeedMax, rng)) return false;
        s.rngSeed = rng;
    }
    // 4) 布尔字段：必须是 JSON 布尔（原来字符串 "true" 也被当真 → 两端分型不同）
    if (!seedJsonBoolField(root, "manualSplit", false, s.manualSplit)) return false;
    if (!seedJsonBoolField(root, "ustcMode", false, s.ustcMode)) return false;
    // 5) 文本字段：必须是纯 ASCII 字符串
    if (!seedJsonTextField(root, "createdAt", "", s.createdAt)) return false;

    if (s.cols < 5 || s.rows < 5 || s.mines < 2) return false;
    if (s.firstRow < 0 || s.firstCol < 0 || s.firstRow >= s.rows || s.firstCol >= s.cols) return false;
    // 手动分型时 mines 必须等于 real+imag（两端的 UI 构造都恒成立）。
    // 缺这条时「mines=2、real=0、imag=0」的自相矛盾种子能造出 0 雷棋盘，导入即胜。
    if (s.manualSplit && s.mines != s.realMines + s.imagMines) return false;

    if (s.kind == "save") {
        int elapsedCs = -1;
        if (!seedJsonIntField(root, "elapsedCs", -1, -1, kMaxElapsedCs, elapsedCs)) return false;
        if (elapsedCs < 0) {  // 兼容旧存档：字段名 elapsedSec，单位秒
            int elapsedSec = 0;
            if (!seedJsonIntField(root, "elapsedSec", 0, 0, kMaxElapsedCs / 100, elapsedSec)) return false;
            elapsedCs = elapsedSec * 100;
        }
        s.elapsedCs = elapsedCs;
        {
            const json::Value* v = root.member("phase");
            if (v) {
                if (v->type != json::Type::String) return false;
                s.phase = v->text;
            } else {
                s.phase = "playing";
            }
            if (s.phase != "playing" && s.phase != "won" && s.phase != "lost") return false;
        }
        // 6) 存档行：必须是字符串数组，且尺寸与棋盘严格一致
        if (!seedJsonTextArray(root, "opened", s.openedRows)) return false;
        if (!seedJsonTextArray(root, "flags", s.flagRows)) return false;
        if (static_cast<int>(s.openedRows.size()) != s.rows) return false;
        if (static_cast<int>(s.flagRows.size()) != s.rows) return false;
        for (int r = 0; r < s.rows; ++r)
            if (static_cast<int>(s.openedRows[r].size()) != s.cols ||
                static_cast<int>(s.flagRows[r].size()) != s.cols)
                return false;
    }
    out = s;
    return true;
}

// —— 加密（Rabbit） + Base64 ——
inline std::string encodeSeed(const Seed& s, const std::string& key = kSeedKey) {
    const std::string json = seedToJson(s);
    RabbitStream r(key);
    const std::vector<std::uint8_t> ct =
        r.crypt(std::vector<std::uint8_t>(json.begin(), json.end()));
    return base64Encode(ct.data(), ct.size());
}


// JSON 里取字段值并与期望比较：**容忍任意空白**。
//
// ★ 为什么不直接搜 `"magic": "MSD1"` 这个串（2026-10-21 改进）：
//   那个判据依赖冒号后那个空格。今天能用，只因为三处实现（这里 / seedcodec.ts /
//   tools/base.cpp）都是手写、而且碰巧格式一致 —— 这是**隐式耦合**：哪天有人把
//   某处改成 `JSON.stringify`（默认输出紧凑 JSON，没有空格），三处会**一起静默失效**，
//   而且对外报的是「密码错误」，把排查方向直接引到密码上（其实密码是对的）。
//   判据放宽到「字段名 + 可选空白 + 冒号 + 可选空白 + 引号包的值」，就与排版无关了。
inline bool jsonFieldEquals(const std::string& json, const char* key, const char* value) {
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

// 密钥不对 / 数据损坏时返回 false（先查解密后的 magic 标记）
inline bool decodeSeed(const std::string& text, Seed& out, const std::string& key = kSeedKey) {
    std::vector<std::uint8_t> ct;
    if (!base64Decode(text, ct)) return false;
    RabbitStream r(key);
    const std::vector<std::uint8_t> pt = r.crypt(ct);
    const std::string json(pt.begin(), pt.end());
    if (!jsonFieldEquals(json, "magic", kSeedMagic)) return false;   // 见 jsonFieldEquals 的注释
    return seedFromJson(json, out);
}

// 玩家看到的短种子：前 12 位 + 省略号
inline std::string shortSeed(const std::string& full) {
    if (full.size() <= 12) return full;
    return full.substr(0, 12) + "...";
}

} // namespace ms
