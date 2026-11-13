#pragma once
// 极简严格 JSON 解析器（RFC 8259 子集），语义对齐 JavaScript 的 JSON.parse。
//
// ── 为什么需要它（2026-10-22 安全审计 P11）────────────────────────────
// 桌面端原来用「手写扫描器」从明文里找字段（seedJsonField / seedJsonInt…），
// 网页端用 JSON.parse。**两套解析器对同一段明文给出的答案并不总是相同**：
//   · 重复键：扫描器取**先**出现的，JSON.parse 取**后**出现的
//   · 字段藏在别的字符串里：扫描器会把它当成真字段（note 里写个 "magic" 就能骗过它）
//   · "9.5"：扫描器 strtol 失败 → **静默回退默认值 9**；JSON.parse → 9.5（不是整数）
//   · "true"：扫描器 → 回退默认值；JSON.parse → 布尔，Number(true)=1
//   · 尾随逗号 / 尾随垃圾：扫描器照收，JSON.parse 整段报错
// 于是**同一个种子串在两端解出不同的棋盘** —— 而「同一种子处处同一局」正是
// 排行榜回放校验的地基。
// 现在桌面端也用真正的 JSON 解析器，语义与 JSON.parse 对齐；两端是否真的对齐，
// 由 web/test/seed-parse-parity.mjs 拿同一张用例表逐条对拍证明。
//
// ── 依赖 ────────────────────────────────────────────────────────────────
// 只用 C++20 标准库（core 层不引任何第三方库 / 平台 API）。
//
// ── 与 JSON.parse 刻意保持一致的细节 ────────────────────────────────────
//   · 重复键：后者覆盖前者（键的位置保持第一次出现处）
//   · 数字：JSON 数字文法（拒绝前导零 / +1 / .5 / 5. / 0x10 / NaN / Infinity），
//     值按 IEEE754 双精度转换（与 V8 的 strtod 同为正确舍入）
//   · 字符串：只认 \" \\ \/ \b \f \n \r \t \uXXXX；未转义的控制字符报错
//   · 孤立代理项（\uD800 这种没有配对的）解成 U+FFFD —— JSON.parse 会原样保留，
//     但种子明文里出现非 ASCII 会被字段契约的「纯 ASCII」检查拒收，两端结果一致
//   · 顶层值之后除空白外还有内容 → 报错
//   · 空白只有 空格 / \t / \n / \r 四个（\f \v 不是 JSON 空白）
#include <cmath>
#include <clocale>
#include <cstdint>
#include <cstdlib>
#include <locale>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace ms {
namespace json {

// 嵌套深度上限。既是栈溢出防护（桌面端是递归下降解析），也是跨端契约的一部分：
// 网页端在 JSON.parse 之前用同样的上限做一次深度扫描，两端对「过深的明文」
// 给出相同的拒绝。
inline constexpr int kMaxDepth = 200;

enum class Type { Null, Bool, Number, String, Array, Object };

struct Value {
    Type type = Type::Null;
    bool boolean = false;
    double number = 0.0;
    std::string text;                                   // Type::String
    std::vector<Value> array;                           // Type::Array
    std::vector<std::pair<std::string, Value>> object;  // Type::Object（保持插入顺序）

    bool isObject() const { return type == Type::Object; }
    bool isNumber() const { return type == Type::Number; }
    bool isString() const { return type == Type::String; }
    bool isBool() const { return type == Type::Bool; }

    // 取成员：同名键取**最后一个**的值（JSON.parse 的重复键语义），
    // 位置仍保持在第一次出现处（与 JS 对象一致）。
    const Value* member(const std::string& key) const {
        if (type != Type::Object) return nullptr;
        for (std::size_t i = object.size(); i-- > 0;)
            if (object[i].first == key) return &object[i].second;
        return nullptr;
    }
};

namespace detail {

// strtod 受 locale 影响（小数点未必是 '.'）。JSON 的小数点固定是 '.'，
// 所以在非 C locale 下要换成本地小数点再交给 strtod。
inline bool strToDouble(const std::string& tok, double& out) {
    const char* dp = std::localeconv()->decimal_point;
    if (dp && dp[0] != '\0' && dp[0] != '.') {
        if (dp[1] != '\0') return false;  // 罕见的多字节小数点：当作解析失败
        std::string local = tok;
        for (char& ch : local)
            if (ch == '.') ch = dp[0];
        out = std::strtod(local.c_str(), nullptr);
        return true;
    }
    out = std::strtod(tok.c_str(), nullptr);
    return true;
}

class Parser {
public:
    explicit Parser(std::string_view text) : s_(text) {}

    bool run(Value& out) {
        if (!parseValue(out, 1)) return false;
        skipWs();
        if (i_ != s_.size()) return fail("trailing content");
        return true;
    }

    const std::string& error() const { return err_; }

private:
    std::string_view s_;
    std::size_t i_ = 0;
    std::string err_;

    bool fail(const char* what) {
        if (err_.empty()) err_ = what;
        return false;
    }
    bool eof() const { return i_ >= s_.size(); }
    char peek() const { return i_ < s_.size() ? s_[i_] : '\0'; }

    void skipWs() {
        while (i_ < s_.size()) {
            const char c = s_[i_];
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') ++i_;
            else break;
        }
    }

    bool literal(const char* lit) {
        const std::size_t n = std::char_traits<char>::length(lit);
        if (s_.size() - i_ < n) return false;
        if (s_.compare(i_, n, lit) != 0) return false;
        i_ += n;
        return true;
    }

    bool parseValue(Value& out, int depth) {
        if (depth > kMaxDepth) return fail("too deep");
        skipWs();
        if (eof()) return fail("unexpected end");
        switch (peek()) {
            case '{': return parseObject(out, depth);
            case '[': return parseArray(out, depth);
            case '"': {
                std::string str;
                if (!parseString(str)) return false;
                out.type = Type::String;
                out.text = std::move(str);
                return true;
            }
            case 't':
                if (!literal("true")) return fail("bad literal");
                out.type = Type::Bool;
                out.boolean = true;
                return true;
            case 'f':
                if (!literal("false")) return fail("bad literal");
                out.type = Type::Bool;
                out.boolean = false;
                return true;
            case 'n':
                if (!literal("null")) return fail("bad literal");
                out.type = Type::Null;
                return true;
            default: return parseNumber(out);
        }
    }

    bool parseObject(Value& out, int depth) {
        out.type = Type::Object;
        ++i_;  // '{'
        skipWs();
        if (peek() == '}') { ++i_; return true; }
        while (true) {
            skipWs();
            if (peek() != '"') return fail("expected key");
            std::string key;
            if (!parseString(key)) return false;
            skipWs();
            if (peek() != ':') return fail("expected ':'");
            ++i_;
            Value v;
            if (!parseValue(v, depth + 1)) return false;
            setMember(out, std::move(key), std::move(v));
            skipWs();
            if (peek() == ',') { ++i_; continue; }
            if (peek() == '}') { ++i_; return true; }
            return fail("expected ',' or '}'");
        }
    }

    // 重复键：后者覆盖前者的**值**，但键的位置保持第一次出现处（与 JS 一致）。
    static void setMember(Value& obj, std::string key, Value v) {
        for (auto& kv : obj.object) {
            if (kv.first == key) { kv.second = std::move(v); return; }
        }
        obj.object.emplace_back(std::move(key), std::move(v));
    }

    bool parseArray(Value& out, int depth) {
        out.type = Type::Array;
        ++i_;  // '['
        skipWs();
        if (peek() == ']') { ++i_; return true; }
        while (true) {
            Value v;
            if (!parseValue(v, depth + 1)) return false;
            out.array.push_back(std::move(v));
            skipWs();
            if (peek() == ',') { ++i_; continue; }
            if (peek() == ']') { ++i_; return true; }
            return fail("expected ',' or ']'");
        }
    }

    bool parseString(std::string& out) {
        out.clear();
        ++i_;  // opening quote
        while (true) {
            if (eof()) return fail("unterminated string");
            const unsigned char c = static_cast<unsigned char>(s_[i_]);
            if (c == '"') { ++i_; return true; }
            if (c < 0x20) return fail("raw control char in string");
            if (c != '\\') { out.push_back(static_cast<char>(c)); ++i_; continue; }
            ++i_;  // backslash
            if (eof()) return fail("bad escape");
            const char e = s_[i_++];
            switch (e) {
                case '"': out.push_back('"'); break;
                case '\\': out.push_back('\\'); break;
                case '/': out.push_back('/'); break;
                case 'b': out.push_back('\b'); break;
                case 'f': out.push_back('\f'); break;
                case 'n': out.push_back('\n'); break;
                case 'r': out.push_back('\r'); break;
                case 't': out.push_back('\t'); break;
                case 'u': {
                    std::uint32_t cp = 0;
                    if (!parseHex4(cp)) return false;
                    if (cp >= 0xD800 && cp <= 0xDBFF) {  // 高代理项
                        // 后面紧跟 \uDCxx 就配对，否则算孤立代理项
                        if (s_.size() - i_ >= 6 && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                            const std::size_t save = i_;
                            i_ += 2;
                            std::uint32_t lo = 0;
                            if (!parseHex4(lo)) return false;
                            if (lo >= 0xDC00 && lo <= 0xDFFF) {
                                cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                            } else {
                                i_ = save;  // 不是低代理项，回退
                                cp = 0xFFFD;
                            }
                        } else {
                            cp = 0xFFFD;
                        }
                    } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
                        cp = 0xFFFD;  // 孤立低代理项
                    }
                    appendUtf8(out, cp);
                    break;
                }
                default: return fail("bad escape");
            }
        }
    }

    bool parseHex4(std::uint32_t& out) {
        if (s_.size() - i_ < 4) return fail("bad \\u escape");
        std::uint32_t v = 0;
        for (int k = 0; k < 4; ++k) {
            const char c = s_[i_++];
            v <<= 4;
            if (c >= '0' && c <= '9') v |= static_cast<std::uint32_t>(c - '0');
            else if (c >= 'a' && c <= 'f') v |= static_cast<std::uint32_t>(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') v |= static_cast<std::uint32_t>(c - 'A' + 10);
            else return fail("bad \\u escape");
        }
        out = v;
        return true;
    }

    static void appendUtf8(std::string& out, std::uint32_t cp) {
        if (cp < 0x80) {
            out.push_back(static_cast<char>(cp));
        } else if (cp < 0x800) {
            out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else if (cp < 0x10000) {
            out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        } else {
            out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
            out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
        }
    }

    bool parseNumber(Value& out) {
        const std::size_t start = i_;
        if (peek() == '-') ++i_;
        // 整数部分：'0' 单独一个，或者 1-9 开头的一串数字（拒绝前导零）
        if (peek() == '0') {
            ++i_;
        } else if (peek() >= '1' && peek() <= '9') {
            while (!eof() && peek() >= '0' && peek() <= '9') ++i_;
        } else {
            return fail("bad number");
        }
        if (peek() == '.') {
            ++i_;
            if (eof() || peek() < '0' || peek() > '9') return fail("bad fraction");
            while (!eof() && peek() >= '0' && peek() <= '9') ++i_;
        }
        if (peek() == 'e' || peek() == 'E') {
            ++i_;
            if (peek() == '+' || peek() == '-') ++i_;
            if (eof() || peek() < '0' || peek() > '9') return fail("bad exponent");
            while (!eof() && peek() >= '0' && peek() <= '9') ++i_;
        }
        const std::string tok(s_.substr(start, i_ - start));
        double d = 0.0;
        if (!strToDouble(tok, d)) return fail("bad number");
        out.type = Type::Number;
        out.number = d;
        return true;
    }
};

}  // namespace detail

// 解析一整段 JSON 文本。成功返回 true，out 被填好；失败返回 false，
// why（可选）拿到简短原因。
inline bool parse(std::string_view text, Value& out, std::string* why = nullptr) {
    detail::Parser p(text);
    if (p.run(out)) return true;
    if (why) *why = p.error();
    return false;
}

// 文本里是否含非 ASCII 字节。种子明文由本程序生成，本就是纯 ASCII；
// 出现非 ASCII 说明是外部伪造，两端都在字段契约里按同一条规则拒收。
inline bool isAscii(std::string_view text) {
    for (const char c : text)
        if (static_cast<unsigned char>(c) >= 0x80) return false;
    return true;
}

}  // namespace json
}  // namespace ms
