// imgprobe.cpp —— ImageProbe.h 的自检与文件闸门 CLI。
//
// 用法：
//     imgprobe --selftest            跑内置用例表 + 截断/位翻转压力，全部通过则退出码 0
//     imgprobe --gate <文件路径>      按真实文件跑一遍闸门，打印 OK/REJECT 供脚本断言
//
// 为什么要有它：ImageProbe.h 是**安全代码**（它的唯一职责是挡住解压炸弹），
// 而安全代码最怕「看起来对」。所以除了正常用例，还要：
//   · 对每个合法头做 0..len-1 的全截断（真实攻击者就是靠截断/畸形头来打的）
//   · 对每个合法头做 2 万次固定种子位翻转
// 这两条配合 ASan/UBSan 跑，才能证明探针自己不会先崩。
//
// 编译（不依赖 SFML，也不需要 CMake）：
//     c++ -std=c++20 -g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer \
//         -Isrc tools/imgprobe.cpp -o imgprobe

#include "desktop/ImageProbe.h"

#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

using ms::imgprobe::Fmt;
using ms::imgprobe::Res;
using ms::imgprobe::St;

namespace {

int g_pass = 0, g_fail = 0;

void expect(const char* name, const std::vector<std::uint8_t>& buf, St st, Fmt fmt,
            std::uint32_t w = 0, std::uint32_t h = 0) {
    const Res r = ms::imgprobe::probeMemory(std::span<const std::uint8_t>(buf.data(), buf.size()));
    const bool ok = r.st == st && r.fmt == fmt && r.w == w && r.h == h;
    if (ok) {
        ++g_pass;
    } else {
        ++g_fail;
        std::printf("  ✗ %-38s 期望 st=%d fmt=%d %ux%u，实际 st=%d fmt=%d %ux%u\n", name,
                    static_cast<int>(st), static_cast<int>(fmt), w, h, static_cast<int>(r.st),
                    static_cast<int>(r.fmt), r.w, r.h);
    }
}

// 「头合法但尺寸超限」——闸门要放行解析、由 sizeOk 拒绝，两者必须分开。
void expectOversize(const char* name, const std::vector<std::uint8_t>& buf, Fmt fmt) {
    const Res r = ms::imgprobe::probeMemory(std::span<const std::uint8_t>(buf.data(), buf.size()));
    const bool ok = r.st == St::Ok && r.fmt == fmt && !ms::imgprobe::sizeOk(r.w, r.h);
    if (ok) {
        ++g_pass;
    } else {
        ++g_fail;
        std::printf("  ✗ %-38s 期望「能解析但超像素」，实际 st=%d %ux%u\n", name,
                    static_cast<int>(r.st), r.w, r.h);
    }
}

void putBE32(std::vector<std::uint8_t>& v, std::size_t o, std::uint32_t x) {
    v[o] = static_cast<std::uint8_t>(x >> 24);
    v[o + 1] = static_cast<std::uint8_t>(x >> 16);
    v[o + 2] = static_cast<std::uint8_t>(x >> 8);
    v[o + 3] = static_cast<std::uint8_t>(x);
}
void putLE16(std::vector<std::uint8_t>& v, std::size_t o, std::uint16_t x) {
    v[o] = static_cast<std::uint8_t>(x);
    v[o + 1] = static_cast<std::uint8_t>(x >> 8);
}
void putLE32(std::vector<std::uint8_t>& v, std::size_t o, std::uint32_t x) {
    v[o] = static_cast<std::uint8_t>(x);
    v[o + 1] = static_cast<std::uint8_t>(x >> 8);
    v[o + 2] = static_cast<std::uint8_t>(x >> 16);
    v[o + 3] = static_cast<std::uint8_t>(x >> 24);
}

// 取前 n 字节的副本。
// ★ 别写成 std::vector<uint8_t>(make().begin(), make().begin() + n)：
//   那两个 begin() 属于**两个不同的临时对象**，迭代器不同源是 UB
//   （ASan 会在测试代码里报 heap-buffer-overflow —— 本文件第一次跑就是这么被抓出来的）。
std::vector<std::uint8_t> cut(const std::vector<std::uint8_t>& v, std::size_t n) {
    return std::vector<std::uint8_t>(v.begin(), v.begin() + std::min(n, v.size()));
}

// ── 各格式的最小合法头构造 ───────────────────────────────────────────
std::vector<std::uint8_t> png(std::uint32_t w, std::uint32_t h) {
    // 签名 + 长度(13) + "IHDR" + w + h + {8,6,0,0,0}
    std::vector<std::uint8_t> v = {0x89, 'P', 'N', 'G', 0x0D, 0x0A, 0x1A, 0x0A,
                                   0, 0, 0, 13, 'I', 'H', 'D', 'R'};
    v.resize(29);
    putBE32(v, 16, w);
    putBE32(v, 20, h);
    v[24] = 8; v[25] = 6; v[26] = 0; v[27] = 0; v[28] = 0;
    return v;
}
std::vector<std::uint8_t> gif(std::uint16_t w, std::uint16_t h) {
    std::vector<std::uint8_t> v = {'G', 'I', 'F', '8', '9', 'a', 0, 0, 0, 0};
    putLE16(v, 6, w);
    putLE16(v, 8, h);
    return v;
}
std::vector<std::uint8_t> bmpCORE(std::uint16_t w, std::uint16_t h) {
    std::vector<std::uint8_t> v(26, 0);
    v[0] = 'B'; v[1] = 'M';
    putLE32(v, 14, 12);            // DIB = COREHEADER
    putLE16(v, 18, w);
    putLE16(v, 20, h);
    return v;
}
std::vector<std::uint8_t> bmpINFO(std::int32_t w, std::int32_t h) {
    std::vector<std::uint8_t> v(30, 0);
    v[0] = 'B'; v[1] = 'M';
    putLE32(v, 14, 40);            // DIB = INFOHEADER
    putLE32(v, 18, static_cast<std::uint32_t>(w));
    putLE32(v, 22, static_cast<std::uint32_t>(h));
    return v;
}
std::vector<std::uint8_t> tga(std::uint16_t w, std::uint16_t h, std::uint8_t bpp) {
    std::vector<std::uint8_t> v(18, 0);
    v[2] = 2;                      // 未压缩真彩
    putLE16(v, 12, w);
    putLE16(v, 14, h);
    v[16] = bpp;
    return v;
}
// 造一个带 n 个 APP0 段再跟 SOF0 的 JPEG
std::vector<std::uint8_t> jpeg(std::uint16_t w, std::uint16_t h, int appSegs = 1,
                               std::uint16_t appLen = 16) {
    std::vector<std::uint8_t> v = {0xFF, 0xD8};
    for (int i = 0; i < appSegs; ++i) {
        v.push_back(0xFF); v.push_back(0xE0);
        v.push_back(static_cast<std::uint8_t>(appLen >> 8));
        v.push_back(static_cast<std::uint8_t>(appLen));
        for (int k = 2; k < appLen; ++k) v.push_back(0x00);
    }
    // SOF0：FF C0 len(2) prec(1) h(2) w(2) ncomp(1)
    v.push_back(0xFF); v.push_back(0xC0);
    v.push_back(0x00); v.push_back(0x0B);
    v.push_back(0x08);
    v.push_back(static_cast<std::uint8_t>(h >> 8));
    v.push_back(static_cast<std::uint8_t>(h));
    v.push_back(static_cast<std::uint8_t>(w >> 8));
    v.push_back(static_cast<std::uint8_t>(w));
    v.push_back(0x01);            // ncomp
    // 每个分量 3 字节（id / 采样因子 / 量化表号）。真实 SOF 必须有 ——
    // 少写这 3 字节而 len 仍写 11，会让解析器在段尾读越界 → 被判 Truncated
    // （本文件第一次跑就是这么暴露出构造器错了 3 个字节）。
    v.push_back(0x01); v.push_back(0x11); v.push_back(0x00);
    return v;
}
std::vector<std::uint8_t> webpVP8(std::uint16_t w, std::uint16_t h) {
    std::vector<std::uint8_t> v(30, 0);
    std::memcpy(v.data(), "RIFF", 4);
    std::memcpy(v.data() + 8, "WEBP", 4);
    std::memcpy(v.data() + 12, "VP8 ", 4);
    v[20] = 0x00;                  // 关键帧（bit0 == 0）
    v[23] = 0x9D; v[24] = 0x01; v[25] = 0x2A;
    putLE16(v, 26, static_cast<std::uint16_t>(w & 0x3FFF));
    putLE16(v, 28, static_cast<std::uint16_t>(h & 0x3FFF));
    return v;
}
std::vector<std::uint8_t> webpVP8L(std::uint32_t w, std::uint32_t h) {
    std::vector<std::uint8_t> v(25, 0);
    std::memcpy(v.data(), "RIFF", 4);
    std::memcpy(v.data() + 8, "WEBP", 4);
    std::memcpy(v.data() + 12, "VP8L", 4);
    v[20] = 0x2F;
    const std::uint32_t bits = ((w - 1) & 0x3FFF) | (((h - 1) & 0x3FFF) << 14);
    putLE32(v, 21, bits);
    return v;
}
std::vector<std::uint8_t> webpVP8X(std::uint32_t w, std::uint32_t h) {
    std::vector<std::uint8_t> v(30, 0);
    std::memcpy(v.data(), "RIFF", 4);
    std::memcpy(v.data() + 8, "WEBP", 4);
    std::memcpy(v.data() + 12, "VP8X", 4);
    const std::uint32_t wm = w - 1, hm = h - 1;
    v[24] = static_cast<std::uint8_t>(wm);
    v[25] = static_cast<std::uint8_t>(wm >> 8);
    v[26] = static_cast<std::uint8_t>(wm >> 16);
    v[27] = static_cast<std::uint8_t>(hm);
    v[28] = static_cast<std::uint8_t>(hm >> 8);
    v[29] = static_cast<std::uint8_t>(hm >> 16);
    return v;
}

// 位翻转压力：探针在任何畸形输入上都只能返回结果，不能崩、不能挂死。
// 配 ASan/UBSan 跑才有意义（越界读会立刻报）。
void stress(const char* name, const std::vector<std::uint8_t>& base) {
    // 1) 全截断：0..len-1
    for (std::size_t cut = 0; cut < base.size(); ++cut) {
        const Res r = ms::imgprobe::probeMemory(std::span<const std::uint8_t>(base.data(), cut));
        if (r.st == St::Ok && !ms::imgprobe::sizeOk(r.w, r.h)) {
            // 允许（超尺寸但头完整），不算错
        }
    }
    // 2) 固定种子位翻转 20000 次
    std::vector<std::uint8_t> b = base;
    std::uint32_t s = 0x9E3779B9u;
    for (int i = 0; i < 20000; ++i) {
        s ^= s << 13; s ^= s >> 17; s ^= s << 5;      // xorshift32
        const std::size_t pos = s % b.size();
        b[pos] = static_cast<std::uint8_t>(b[pos] ^ (1u << ((s >> 16) & 7)));
        (void)ms::imgprobe::probeMemory(std::span<const std::uint8_t>(b.data(), b.size()));
    }
    ++g_pass;
    std::printf("  ✓ %-38s 截断 %zu 次 + 位翻转 20000 次，无崩溃\n", name, base.size());
}

void selftest() {
    std::printf("ImageProbe 自检\n");

    // ── PNG ──
    expect("PNG 100x50", png(100, 50), St::Ok, Fmt::Png, 100, 50);
    expectOversize("PNG 20000x20000（stb 会接受的炸弹）", png(20000, 20000), Fmt::Png);
    expectOversize("PNG 40000x40000（stb 自己就拒）", png(40000, 40000), Fmt::Png);
    expect("PNG 0x0 非法", png(0, 0), St::Invalid, Fmt::Png);
    expect("PNG 截断 8 字节", cut(png(10, 10), 8), St::Truncated, Fmt::Png);
    expect("PNG 截断 16 字节", cut(png(10, 10), 16), St::Truncated, Fmt::Png);
    expect("PNG 截断 23 字节", cut(png(10, 10), 23), St::Truncated, Fmt::Png);
    {
        auto v = png(10, 10);
        v[12] = 'X'; v[13] = 'X'; v[14] = 'X'; v[15] = 'X';   // 不是 IHDR
        expect("PNG 首块不是 IHDR", v, St::Invalid, Fmt::Png);
    }
    {
        auto v = png(10, 10);
        putBE32(v, 8, 99);                                     // 块长不是 13
        expect("PNG IHDR 长度不对", v, St::Invalid, Fmt::Png);
    }

    // ── GIF ──
    expect("GIF 1x1", gif(1, 1), St::Ok, Fmt::Gif, 1, 1);
    expect("GIF 65535x65535", gif(65535, 65535), St::Ok, Fmt::Gif, 65535, 65535);
    expect("GIF 0 高非法", gif(10, 0), St::Invalid, Fmt::Gif);
    expect("GIF 截断 9 字节", cut(gif(1, 1), 9), St::Truncated, Fmt::Gif);

    // ── BMP ──
    expect("BMP CORE 12 头 100x50", bmpCORE(100, 50), St::Ok, Fmt::Bmp, 100, 50);
    expect("BMP INFO 负高（自上而下）", bmpINFO(80, -60), St::Ok, Fmt::Bmp, 80, 60);
    expect("BMP 宽为 0 非法", bmpINFO(0, 10), St::Invalid, Fmt::Bmp);
    expect("BMP 负宽非法", bmpINFO(-5, 10), St::Invalid, Fmt::Bmp);
    expect("BMP INT32_MIN 高（取反是 UB）", bmpINFO(10, INT32_MIN), St::Invalid, Fmt::Bmp);

    // ── TGA ──
    expect("TGA 24bpp 100x50", tga(100, 50, 24), St::Ok, Fmt::Tga, 100, 50);
    expect("TGA 32bpp 7x9", tga(7, 9, 32), St::Ok, Fmt::Tga, 7, 9);
    {
        auto v = tga(10, 10, 24);
        v[16] = 7;                                             // 非法位深
        expect("TGA 位深非法 → 不算 TGA", v, St::Unknown, Fmt::Unknown);
    }

    // ── JPEG ──
    expect("JPEG APP0+SOF0 123x45", jpeg(123, 45), St::Ok, Fmt::Jpeg, 123, 45);
    expect("JPEG 20 个 APP 段后 SOF0", jpeg(640, 480, 20), St::Ok, Fmt::Jpeg, 640, 480);
    expect("JPEG 只有 SOI", std::vector<std::uint8_t>{0xFF, 0xD8}, St::Truncated, Fmt::Jpeg);
    {
        // 段长 0xFFFF 但文件在段内就结束 → 必须判截断，不能死循环
        std::vector<std::uint8_t> v = {0xFF, 0xD8, 0xFF, 0xE0, 0xFF, 0xFF, 0x00, 0x00};
        expect("JPEG 段长 0xFFFF 但截断", v, St::Truncated, Fmt::Jpeg);
    }
    {
        // SOF 之前遇到 EOI → 不是合法 JPEG 结构
        std::vector<std::uint8_t> v = {0xFF, 0xD8, 0xFF, 0xD9};
        expect("JPEG SOF 前遇 EOI", v, St::Invalid, Fmt::Jpeg);
    }
    expect("JPEG 0 宽非法", jpeg(0, 10), St::Invalid, Fmt::Jpeg);

    // ── WebP ──
    expect("WebP VP8（有损）32x24", webpVP8(32, 24), St::Ok, Fmt::Webp, 32, 24);
    expect("WebP VP8L（无损）1000x500", webpVP8L(1000, 500), St::Ok, Fmt::Webp, 1000, 500);
    expect("WebP VP8X（扩展）300x200", webpVP8X(300, 200), St::Ok, Fmt::Webp, 300, 200);
    {
        auto v = webpVP8(32, 24);
        v[20] |= 1;                                            // 非关键帧
        expect("WebP VP8 非关键帧", v, St::Invalid, Fmt::Webp);
    }

    // ── 完全不相干 ──
    {
        std::vector<std::uint8_t> v(1024);
        std::uint32_t s = 12345;
        for (auto& c : v) { s = s * 1103515245u + 12345u; c = static_cast<std::uint8_t>(s >> 16); }
        v[0] = 'X'; v[1] = 'Y';                                // 避免偶然撞上 TGA
        expect("随机 1KB → 认不出", v, St::Unknown, Fmt::Unknown);
    }
    expect("空输入", {}, St::Unknown, Fmt::Unknown);

    // ── 压力（配 ASan 才有意义）──
    stress("PNG 100x50", png(100, 50));
    stress("GIF 1x1", gif(1, 1));
    stress("BMP CORE", bmpCORE(100, 50));
    stress("BMP INFO 负高", bmpINFO(80, -60));
    stress("TGA 24bpp", tga(100, 50, 24));
    stress("JPEG 单 APP 段", jpeg(123, 45));
    stress("JPEG 20 个 APP 段", jpeg(640, 480, 20));
    stress("WebP VP8", webpVP8(32, 24));
    stress("WebP VP8L", webpVP8L(1000, 500));
    stress("WebP VP8X", webpVP8X(300, 200));

    std::printf("\nimgprobe selftest: %d cases, %d failed\n", g_pass + g_fail, g_fail);
}

// 返回 0 = 通过，1 = 拒绝。原来自检脚本只解析 stdout，但任何把 --gate 当
// 谓词用的地方（shell 的 if imgprobe --gate …、CI）都会被「永远退出 0」骗过。
int gate(const char* path) {
    std::string why;
    const Res r = ms::imgprobe::probeFile(path, &why);
    if (r.st != St::Ok) {
        std::printf("REJECT %s\n", why.empty() ? "unknown" : why.c_str());
        return 1;
    }
    if (!ms::imgprobe::sizeOk(r.w, r.h)) {
        std::printf("REJECT oversize %ux%u\n", r.w, r.h);
        return 1;
    }
    std::printf("OK %ux%u fmt=%d\n", r.w, r.h, static_cast<int>(r.fmt));
    return 0;
}

} // namespace

int main(int argc, char** argv) {
    if (argc >= 2 && std::strcmp(argv[1], "--selftest") == 0) {
        selftest();
        return g_fail == 0 ? 0 : 1;
    }
    if (argc >= 3 && std::strcmp(argv[1], "--gate") == 0) {
        return gate(argv[2]);
    }
    std::printf("用法：\n  imgprobe --selftest\n  imgprobe --gate <文件>\n");
    return 1;
}
