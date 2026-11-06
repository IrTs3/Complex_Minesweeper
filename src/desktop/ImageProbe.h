#pragma once
// 图片文件头探针（header-only，不依赖 SFML / stb / 任何第三方库）。
//
// 为什么需要它
// ------------
// 2026-10-21 安全审计的中危项：所有图片加载路径都是「先 sf::Image::loadFromFile
// （整幅解码）→ 再判像素数」。而 stb 只挡住 >2^31 字节的分配，一张 100KB、
// IHDR 声明 23000×23000 的纯色 PNG 能过字节闸门，解码时申请 ~2.1GB，
// loadFromFile 里再 resize 一份 → 峰值约 4.2GB → 未捕获 bad_alloc → terminate。
//
// 真正的闸门必须在**解码之前**：只读文件头拿宽高，几十字节就够。
//
// 安全纪律（这是安全代码，畸形文件不能把探针自己打崩）
// ------------------------------------------------
//   1. 每一次读都先过 has(off, n)，用 `off <= size && n <= size - off`
//      （这样写不会因无符号回绕而绕过判断）；
//   2. 只用 `b[i] | b[i+1] << 8` 拼装，**不做未对齐的 reinterpret_cast**；
//   3. 所有乘积先转 64 位再比上限；
//   4. 认不出的格式一律拒绝（fail-closed）——「认不出就退回解码后再判」正是原来的漏洞。
//
// 不校验 CRC / 校验和：本探针只负责给出「分配上界」，内容坏掉让 loadFromFile 自己失败。

#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <span>
#include <string>
#include <string_view>
#include <system_error>
#include <vector>

namespace ms::imgprobe {

enum class Fmt : std::uint8_t { Unknown, Png, Jpeg, Gif, Bmp, Tga, Webp };
enum class St : std::uint8_t {
    Ok,         // 头合法，w/h 可信
    Unknown,    // 不是我们认识的格式（或被策略拒绝）
    Truncated,  // 是这种格式，但文件在该读的地方就结束了
    Invalid     // 是这种格式，但头里有非法值
};

struct Res {
    St st = St::Unknown;
    Fmt fmt = Fmt::Unknown;
    std::uint32_t w = 0, h = 0;
    bool ok() const { return st == St::Ok; }
};

// 与 SettingsIO 的 kMaxImportImageBytes、web/ts/settings.ts 的 kMaxImageBytes 同值。
inline constexpr std::uintmax_t kMaxBytes = 24ull * 1024ull * 1024ull;
// 与 Renderer 原有的 4096² 字面量、web/ts/settings.ts 的 kMaxImagePixels 同值。
inline constexpr std::uint64_t kMaxPixels = 4096ull * 4096ull;

inline bool sizeOk(std::uint32_t w, std::uint32_t h) {
    return w > 0 && h > 0 && static_cast<std::uint64_t>(w) * h <= kMaxPixels;
}

namespace detail {

inline bool has(std::size_t size, std::size_t off, std::size_t n) {
    return off <= size && n <= size - off;
}
inline std::uint16_t le16(std::span<const std::uint8_t> b, std::size_t o) {
    return static_cast<std::uint16_t>(std::uint16_t(b[o]) | (std::uint16_t(b[o + 1]) << 8));
}
inline std::uint16_t be16(std::span<const std::uint8_t> b, std::size_t o) {
    return static_cast<std::uint16_t>((std::uint16_t(b[o]) << 8) | std::uint16_t(b[o + 1]));
}
inline std::uint32_t le32(std::span<const std::uint8_t> b, std::size_t o) {
    return std::uint32_t(b[o]) | (std::uint32_t(b[o + 1]) << 8) | (std::uint32_t(b[o + 2]) << 16) |
           (std::uint32_t(b[o + 3]) << 24);
}
inline std::uint32_t be32(std::span<const std::uint8_t> b, std::size_t o) {
    return (std::uint32_t(b[o]) << 24) | (std::uint32_t(b[o + 1]) << 16) |
           (std::uint32_t(b[o + 2]) << 8) | std::uint32_t(b[o + 3]);
}
inline std::uint32_t le24(std::span<const std::uint8_t> b, std::size_t o) {
    return std::uint32_t(b[o]) | (std::uint32_t(b[o + 1]) << 8) | (std::uint32_t(b[o + 2]) << 16);
}
inline bool tag(std::span<const std::uint8_t> b, std::size_t o, const char* t, std::size_t n) {
    return has(b.size(), o, n) && std::memcmp(b.data() + o, t, n) == 0;
}

// SOF0..SOF15（除去 C4=DHT、C8=JPG、CC=DAC）
inline bool isSof(std::uint8_t m) {
    if (m < 0xC0 || m > 0xCF) return false;
    return m != 0xC4 && m != 0xC8 && m != 0xCC;
}

} // namespace detail

// ── 内存版本（测试用）─────────────────────────────────────────────────
// 只要求「传进来的这一段是真的前 N 字节」；截断会如实返回 Truncated。
inline Res probeMemory(std::span<const std::uint8_t> b) {
    using namespace detail;
    const std::size_t n = b.size();

    // PNG：8 字节签名 + 第一个块必须是 13 字节的 IHDR
    if (n >= 8 && b[0] == 0x89 && b[1] == 'P' && b[2] == 'N' && b[3] == 'G' && b[4] == 0x0D &&
        b[5] == 0x0A && b[6] == 0x1A && b[7] == 0x0A) {
        if (!has(n, 0, 24)) return {St::Truncated, Fmt::Png, 0, 0};
        if (be32(b, 8) != 13 || !tag(b, 12, "IHDR", 4)) return {St::Invalid, Fmt::Png, 0, 0};
        const std::uint32_t w = be32(b, 16), h = be32(b, 20);
        if (!w || !h) return {St::Invalid, Fmt::Png, 0, 0};
        return {St::Ok, Fmt::Png, w, h};
    }

    // GIF：逻辑屏幕描述符（stb 按它分配 4·w·h 的三块缓冲）
    if (n >= 6 && (tag(b, 0, "GIF87a", 6) || tag(b, 0, "GIF89a", 6))) {
        if (!has(n, 0, 10)) return {St::Truncated, Fmt::Gif, 0, 0};
        const std::uint32_t w = le16(b, 6), h = le16(b, 8);
        if (!w || !h) return {St::Invalid, Fmt::Gif, 0, 0};
        return {St::Ok, Fmt::Gif, w, h};
    }

    // BMP：DIB 头大小决定字段宽度（CORE 12 用 16 位，其余用 32 位有符号）
    if (n >= 2 && b[0] == 'B' && b[1] == 'M') {
        if (!has(n, 0, 26)) return {St::Truncated, Fmt::Bmp, 0, 0};
        const std::uint32_t dib = le32(b, 14);
        if (dib == 12) {
            const std::uint32_t w = le16(b, 18), h = le16(b, 20);
            if (!w || !h) return {St::Invalid, Fmt::Bmp, 0, 0};
            return {St::Ok, Fmt::Bmp, w, h};
        }
        if (dib < 16) return {St::Invalid, Fmt::Bmp, 0, 0};
        const std::int32_t w = static_cast<std::int32_t>(le32(b, 18));
        const std::int32_t hRaw = static_cast<std::int32_t>(le32(b, 22));
        if (w <= 0) return {St::Invalid, Fmt::Bmp, 0, 0};
        // 高度为负表示自上而下扫描；INT32_MIN 取反是 UB，直接拒
        if (hRaw == INT32_MIN) return {St::Invalid, Fmt::Bmp, 0, 0};
        const std::uint32_t h = static_cast<std::uint32_t>(hRaw < 0 ? -hRaw : hRaw);
        if (!h) return {St::Invalid, Fmt::Bmp, 0, 0};
        return {St::Ok, Fmt::Bmp, static_cast<std::uint32_t>(w), h};
    }

    // WebP：RIFF....WEBP 之后分 VP8/VP8L/VP8X 三种头
    if (n >= 16 && tag(b, 0, "RIFF", 4) && tag(b, 8, "WEBP", 4)) {
        if (tag(b, 12, "VP8 ", 4)) {
            if (!has(n, 0, 30)) return {St::Truncated, Fmt::Webp, 0, 0};
            if (b[20] & 1) return {St::Invalid, Fmt::Webp, 0, 0};      // 必须是关键帧
            if (b[23] != 0x9D || b[24] != 0x01 || b[25] != 0x2A)
                return {St::Invalid, Fmt::Webp, 0, 0};
            const std::uint32_t w = le16(b, 26) & 0x3FFF, h = le16(b, 28) & 0x3FFF;
            if (!w || !h) return {St::Invalid, Fmt::Webp, 0, 0};
            return {St::Ok, Fmt::Webp, w, h};
        }
        if (tag(b, 12, "VP8L", 4)) {
            if (!has(n, 0, 25)) return {St::Truncated, Fmt::Webp, 0, 0};
            if (b[20] != 0x2F) return {St::Invalid, Fmt::Webp, 0, 0};
            const std::uint32_t bits = le32(b, 21);
            const std::uint32_t w = (bits & 0x3FFF) + 1, h = ((bits >> 14) & 0x3FFF) + 1;
            return {St::Ok, Fmt::Webp, w, h};
        }
        if (tag(b, 12, "VP8X", 4)) {
            if (!has(n, 0, 30)) return {St::Truncated, Fmt::Webp, 0, 0};
            const std::uint32_t w = le24(b, 24) + 1, h = le24(b, 27) + 1;
            return {St::Ok, Fmt::Webp, w, h};
        }
        return {St::Unknown, Fmt::Unknown, 0, 0};
    }

    // JPEG：从文件头开头按段走。内存版只要缓冲区够用即可；
    //       探针拿到的前 64KB 通常足够，不够就如实说 Truncated（见 probeFile 的补读）。
    if (n >= 2 && b[0] == 0xFF && b[1] == 0xD8) {
        std::size_t off = 2;
        for (int guard = 0; guard < 4096; ++guard) {
            while (off < n && b[off] != 0xFF) ++off;          // 跳过填充字节
            if (off >= n) return {St::Truncated, Fmt::Jpeg, 0, 0};
            ++off;
            if (off >= n) return {St::Truncated, Fmt::Jpeg, 0, 0};
            std::uint8_t m = b[off];
            while (m == 0xFF) {                                // 连续 FF 填充
                ++off;
                if (off >= n) return {St::Truncated, Fmt::Jpeg, 0, 0};
                m = b[off];
            }
            ++off;
            if (m == 0xD8) continue;                           // 嵌套 SOI
            if (m == 0xD9 || m == 0xDA) return {St::Invalid, Fmt::Jpeg, 0, 0};  // SOF 前遇 EOI/SOS
            if (m == 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;                // 无长度段
            if (!has(n, off, 2)) return {St::Truncated, Fmt::Jpeg, 0, 0};
            const std::uint16_t len = be16(b, off);
            if (len < 2) return {St::Invalid, Fmt::Jpeg, 0, 0};
            if (detail::isSof(m)) {
                if (!has(n, off + 2, 7)) return {St::Truncated, Fmt::Jpeg, 0, 0};
                const std::uint32_t h = be16(b, off + 3), w = be16(b, off + 5);
                if (!w || !h) return {St::Invalid, Fmt::Jpeg, 0, 0};
                return {St::Ok, Fmt::Jpeg, w, h};
            }
            off += len;                                        // len 含它自己那 2 字节
        }
        return {St::Invalid, Fmt::Jpeg, 0, 0};                 // 段数超上限
    }

    // TGA：没有魔法，靠「类型 + 位深」两个字节猜。放最后，因为它最弱 ——
    //      误判的代价只是 loadFromFile 失败（回退默认图），没有安全影响。
    if (n >= 18) {
        const std::uint8_t type = b[2], bpp = b[16];
        const bool typeOk = type == 1 || type == 2 || type == 3 || type == 9 || type == 10 || type == 11;
        const bool bppOk = bpp == 8 || bpp == 15 || bpp == 16 || bpp == 24 || bpp == 32;
        if (typeOk && bppOk) {
            const std::uint32_t w = le16(b, 12), h = le16(b, 14);
            if (w && h) return {St::Ok, Fmt::Tga, w, h};
        }
    }

    return {St::Unknown, Fmt::Unknown, 0, 0};
}

// ── 落盘用的规范扩展名 ────────────────────────────────────────────────
// SFML 的 saveToFile 是**按扩展名选编码器**的，只认 .bmp/.tga/.png/.jpg/.jpeg。
// 所以导入时按魔数把扩展名规范化，而不是沿用用户路径的后缀（可能叫 .gif）。
inline const char* canonicalExt(Fmt f) {
    switch (f) {
        case Fmt::Png: return ".png";
        case Fmt::Jpeg: return ".jpg";
        case Fmt::Bmp: return ".bmp";
        case Fmt::Tga: return ".tga";
        case Fmt::Gif: return ".gif";    // 能读、SFML 不能写 → 回写会被跳过
        default: return "";              // Unknown / WebP：闸门已拒，解码必失败
    }
}

// 该后缀能不能被 saveToFile 写出来（大小写无关）。
inline bool writableExt(std::string_view ext) {
    char buf[8] = {};
    if (ext.empty() || ext.size() >= sizeof(buf)) return false;
    for (std::size_t i = 0; i < ext.size(); ++i) {
        char c = ext[i];
        if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
        buf[i] = c;
    }
    const std::string_view e(buf, ext.size());
    return e == ".png" || e == ".jpg" || e == ".jpeg" || e == ".bmp" || e == ".tga";
}

// ── 文件版本：唯一文件级闸门 ─────────────────────────────────────────
// 同时负责：不跟随符号链接（否则软链能让「配置目录内的名字」指向别处）、
// 只收普通文件、字节上限、以及头解析。
inline Res probeFile(const std::string& path, std::string* why = nullptr) {
    namespace fs = std::filesystem;
    const auto fail = [why](St st, const char* reason) {
        if (why) *why = reason;
        return Res{st, Fmt::Unknown, 0, 0};
    };

    std::error_code ec;
    // ★ symlink_status 不跟随链接。用 is_regular_file(path) 会把软链当成真文件。
    const fs::file_status st = fs::symlink_status(fs::path(path), ec);
    if (ec) return fail(St::Unknown, "stat");
    if (fs::is_symlink(st)) return fail(St::Unknown, "symlink");
    if (!fs::is_regular_file(st)) return fail(St::Unknown, "not-regular");

    const fs::path p(path);
    const auto bytes = fs::file_size(p, ec);
    if (ec || bytes == 0) return fail(St::Unknown, "size");
    if (bytes > kMaxBytes) return fail(St::Unknown, "bytes>24MiB");

    const std::size_t total = static_cast<std::size_t>(bytes);
    std::vector<std::uint8_t> buf;
    buf.reserve(std::min<std::size_t>(total, 64 * 1024));

    // 先只读前 64KB：绝大多数图片的头都在前几十字节。
    std::ifstream f(p, std::ios::binary);
    if (!f) return fail(St::Unknown, "open");
    std::size_t got = std::min<std::size_t>(total, 64 * 1024);
    buf.resize(got);
    if (!f.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(got)))
        return fail(St::Unknown, "read");

    Res r = probeMemory(std::span<const std::uint8_t>(buf.data(), buf.size()));

    // 只有「确实是这种格式、但 64KB 还不够」时才把剩下的读进来再解析一次。
    // 典型场景：JPEG 前面挂了很长的 APP 段（EXIF 缩略图），SOF 被推到 64KB 之外。
    // 上限是 kMaxBytes（前面已判），所以这一步不会无界分配。
    if (r.st == St::Truncated && got < total) {
        buf.resize(total);
        f.clear();
        f.seekg(static_cast<std::streamoff>(got));
        if (!f.read(reinterpret_cast<char*>(buf.data() + got),
                    static_cast<std::streamsize>(total - got)))
            return fail(St::Unknown, "read-rest");
        r = probeMemory(std::span<const std::uint8_t>(buf.data(), buf.size()));
    }

    if (r.st == St::Ok) {
        if (why) why->clear();
    } else if (why && why->empty()) {
        *why = r.st == St::Truncated ? "truncated" : (r.st == St::Invalid ? "invalid-header" : "unknown-format");
    }
    return r;
}

// ── 文件版本：读**整个文件**并解析头 ─────────────────────────────────
// 给「同一份字节既要验头、又要拿去解码」的调用方用（Renderer::loadImageChecked）。
// 为什么不能 probeFile 之后 loadFromFile(path)：那是两次 open —— 验过的那份和
// 真正解码的那份可以不是同一份（TOCTOU）。路径在用户配置目录/下载目录时，
// 中间把文件换掉就能让「验过 100×100」的字节变成 20000×20000 再解码。
// 上限仍是 kMaxBytes，所以不会无界分配。
inline Res readWholeFile(const std::string& path, std::vector<std::uint8_t>& buf,
                         std::string* why = nullptr) {
    namespace fs = std::filesystem;
    const auto fail = [why](St st, const char* reason) {
        if (why) *why = reason;
        return Res{st, Fmt::Unknown, 0, 0};
    };

    std::error_code ec;
    const fs::file_status st = fs::symlink_status(fs::path(path), ec);
    if (ec) return fail(St::Unknown, "stat");
    if (fs::is_symlink(st)) return fail(St::Unknown, "symlink");
    if (!fs::is_regular_file(st)) return fail(St::Unknown, "not-regular");

    const auto bytes = fs::file_size(fs::path(path), ec);
    if (ec || bytes == 0) return fail(St::Unknown, "size");
    if (bytes > kMaxBytes) return fail(St::Unknown, "bytes>24MiB");

    buf.resize(static_cast<std::size_t>(bytes));
    std::ifstream f(fs::path(path), std::ios::binary);
    if (!f) return fail(St::Unknown, "open");
    if (!f.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(bytes)))
        return fail(St::Unknown, "read");

    Res r = probeMemory(std::span<const std::uint8_t>(buf.data(), buf.size()));
    if (r.st == St::Ok) {
        if (why) why->clear();
    } else if (why && why->empty()) {
        *why = r.st == St::Truncated ? "truncated" : (r.st == St::Invalid ? "invalid-header" : "unknown-format");
    }
    return r;
}

} // namespace ms::imgprobe
