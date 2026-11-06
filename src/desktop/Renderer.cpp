#include "desktop/Renderer.h"

#include "desktop/ImageProbe.h"   // 图片闸门（解码前读文件头）

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <random>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

#include "core/ComplexMath.h"
#include "core/Seed.h"
#include "desktop/Anim.h"
#include "desktop/FileDialog.h"
#include "desktop/SettingsIO.h"

namespace ms {

using anim::kAnimMs; // 动效常量：Anim.h 里在 ms::anim 子命名空间

namespace {

constexpr float kPi = 3.14159265358979f;

// —— 配色（纸感浅色 + 数学主题）——
// 注意：macOS 把窗口 framebuffer 当作 Display P3 解释，若直接填 sRGB 十六进制，
// 屏幕（和截图）上会明显偏艳（#66CCFF 会被显示成 ~(46,207,255)）。
// 所以所有颜色统一做 sRGB→Display P3 预补偿，让屏幕观感就是设计稿里的值。
// Windows / Linux 是标准 sRGB，按字面填色就对，不需要补偿。
#if defined(__APPLE__)
constexpr bool kDisplayP3 = true;
#else
constexpr bool kDisplayP3 = false;
#endif

float srgbToLinear(float c) { return c <= 0.04045f ? c / 12.92f : std::pow((c + 0.055f) / 1.055f, 2.4f); }
float linearToSrgb(float c) { return c <= 0.0031308f ? c * 12.92f : 1.055f * std::pow(c, 1.f / 2.4f) - 0.055f; }

sf::Color displayColor(std::uint8_t r, std::uint8_t g, std::uint8_t b, std::uint8_t a = 255) {
    if (!kDisplayP3) return sf::Color(r, g, b, a);
    const float R = srgbToLinear(static_cast<float>(r) / 255.f);
    const float G = srgbToLinear(static_cast<float>(g) / 255.f);
    const float B = srgbToLinear(static_cast<float>(b) / 255.f);
    const float rl = 0.8225f * R + 0.1774f * G + 0.0000f * B;
    const float gl = 0.0332f * R + 0.9669f * G + 0.0000f * B;
    const float bl = 0.0171f * R + 0.0724f * G + 0.9108f * B;
    const auto q = [](float v) {
        const float e = linearToSrgb(v < 0.f ? 0.f : (v > 1.f ? 1.f : v));
        return static_cast<std::uint8_t>(e * 255.f + 0.5f);
    };
    return sf::Color(q(rl), q(gl), q(bl), a);
}

// 图片纹理的 sRGB->Display P3 预补偿（查表加速，避免逐像素 pow）
void applyDisplayP3(sf::Image& img) {
    if (!kDisplayP3 || img.getSize().x == 0) return;
    static float lin[256];
    static std::uint8_t enc[4097];
    static bool ready = false;
    if (!ready) {
        for (int i = 0; i < 256; ++i) lin[i] = srgbToLinear(static_cast<float>(i) / 255.f);
        for (int i = 0; i <= 4096; ++i)
            enc[i] = static_cast<std::uint8_t>(linearToSrgb(static_cast<float>(i) / 4096.f) * 255.f + 0.5f);
        ready = true;
    }
    const auto q = [](float v) {
        int idx = static_cast<int>(v * 4096.f + 0.5f);
        if (idx < 0) idx = 0;
        if (idx > 4096) idx = 4096;
        return enc[idx];
    };
    const sf::Vector2u sz = img.getSize();
    for (unsigned y = 0; y < sz.y; ++y) {
        for (unsigned x = 0; x < sz.x; ++x) {
            const sf::Color c = img.getPixel(sf::Vector2u(x, y));
            const float R = lin[c.r];
            const float G = lin[c.g];
            const float B = lin[c.b];
            img.setPixel(sf::Vector2u(x, y),
                         sf::Color(q(0.8225f * R + 0.1774f * G),
                                   q(0.0332f * R + 0.9669f * G),
                                   q(0.0171f * R + 0.0724f * G + 0.9108f * B),
                                   c.a));
        }
    }
}

const sf::Color kWindowBg = displayColor(233, 238, 244);
const sf::Color kPanel = displayColor(214, 224, 235);
const sf::Color kCovered = displayColor(102, 204, 255);    // #66CCFF 格子底色
const sf::Color kCoveredEdge = displayColor(63, 169, 219); // 同色系深一档描边
const sf::Color kHover = displayColor(140, 220, 255);      // 悬停更亮
const sf::Color kFlashYellow = displayColor(255, 214, 10); // 计数变动高亮
const sf::Color kOpened = displayColor(244, 247, 250);
const sf::Color kOpenedZero = displayColor(234, 239, 245);
// 已翻开、周围确实有雷、但实数和与虚数和都抵消为零的格子。
// 它必须和 kOpenedZero（真空格，会连锁展开）分开：两者玩法意义不同。
const sf::Color kOpenedCancel = displayColor(224, 231, 241);
const sf::Color kGridLine = displayColor(219, 227, 237);
const sf::Color kRealHint = displayColor(37, 99, 235); // 纯实和提示：蓝
const sf::Color kImagHint = displayColor(15, 138, 90); // 纯虚和提示：绿
const sf::Color kMixHint = displayColor(142, 54, 205); // 混合和提示（根式）：紫
const sf::Color kZeroHint = displayColor(239, 228, 48); // 抵消为零但有雷：黄（#EFE430）
const sf::Color kRealMine = displayColor(37, 99, 235);   // ±1（实数）：蓝，与提示色一致
const sf::Color kImagMine = displayColor(15, 138, 90);   // ±i（虚数）：绿，与提示色一致
const sf::Color kBadMark = displayColor(214, 48, 49);    // 标错的红叉（保持警示红）
const sf::Color kBoomBg = displayColor(245, 183, 177);
const sf::Color kBadFlagBg = displayColor(250, 224, 221);
const sf::Color kInk = displayColor(44, 62, 80);
const sf::Color kInkSoft = displayColor(108, 122, 137);
const sf::Color kBtnBg = displayColor(255, 255, 255);
const sf::Color kBtnEdge = displayColor(176, 190, 207);
const sf::Color kBtnActive = displayColor(91, 155, 213);
const sf::Color kBarFill = displayColor(63, 159, 214);        // 进度条填充：青蓝（66CCFF 家族中段，与登录页渐变同值）
const sf::Color kUstcGray = displayColor(150, 150, 150, 217); // USTC 字母：灰，约 85% 不透明度

// ═══ 星光观感参数（2026-10-20 观感升级）═══
// ★ 这一整块与 web/ts/fx.ts 的 opts **必须同数**：两端是两份独立实现，
//   改任何一端而忘了另一端，就是「同一个设置、两种观感」的漂移。
//   tools/test_gate_ui.py 的 T57 会正则抽值互相比对，别只改一边。
// 数量/倍率的范围与默认在 Renderer.h（kStarDensityMin/Max、kStarScaleMin/Max）
// 与 SettingsIO.h，那里是「设置契约」；这里只管观感形状。
namespace starfx {
// 半径幂律：r = base + span·u^pow。u 均匀 → 80% 的星 <1.2px、15% 中等、5% 大星，
// 取代旧的均匀分布（一堆一样大的点，是「纸面灰尘」观感的主因之一）。
constexpr float kRBase = 0.8f;
constexpr float kRSpan = 2.4f;
constexpr float kRPow = 2.2f;
// 配色权重：白 / 浅蓝 / 淡黄 / 淡粉 / 浅绿 —— 五项之和归一化。
// ★ 前三个（kWhiteW/kBlueW/kWarmW）的数值**不要动**：登录页 gate/gate.js 里有一份同值副本，
//   T57 会逐值比对；要加新颜色只能往后追加权重。
constexpr float kWhiteW = 0.58f;
constexpr float kBlueW = 0.32f;
constexpr float kWarmW = 0.10f;
constexpr float kPinkW = 0.10f;
constexpr float kGreenW = 0.10f;
// ★ kBlue / kWarm 现在**没有任何地方在用**（星光改吃 kMeteorCols 了），但别删：
//   T57 断言 namespace starfx 里恰好有 4 个颜色常量（kBlue/kWarm/kFlareCol/kUnitCol），
//   删掉会红。等哪天把那条断言改掉，再一起清掉这两个。
[[maybe_unused]] const sf::Color kBlue = displayColor(102, 204, 255);  // #66CCFF
[[maybe_unused]] const sf::Color kWarm = displayColor(255, 217, 160);  // #FFD9A0
// 光斑贴图：64×64 一次性生成；核 100% → 1/3 半径处 65% → 边缘 #66CCFF 透明。
constexpr unsigned kGlowTex = 64;
constexpr float kGlowMid = 0.65f;
constexpr float kHaloRatio = 3.6f;   // 光晕半径 = 星核半径 ×3.6；星核 <1px 退化为纯圆点
// 闪烁：alpha = base + amp·max(0,sin φ)^pow —— 高次幂让亮是「骤亮」而不是匀速呼吸。
constexpr float kTwBase = 0.10f;
constexpr float kTwAmp = 0.88f;
constexpr float kTwPow = 6.f;
constexpr float kTwSpMin = 0.4f;     // rad/s
constexpr float kTwSpMax = 3.2f;
// 大星形状：内凹四角尖星 ✦，8 顶点；尖长 3.2r、凹进 0.9r（取代旧的十字加号）。
constexpr float kBigSpike = 3.2f;
constexpr float kBigInner = 0.9f;
// 耀斑大亮星：5% 概率、同时存活 1-3 颗；十字长条横 14r 竖 10r，三段递减 alpha。
constexpr float kFlareProb = 0.05f;
constexpr int kFlareMax = 3;
constexpr float kFlareH = 14.f;
constexpr float kFlareV = 10.f;
const sf::Color kFlareCol = displayColor(191, 230, 255);  // #BFE6FF
// 横向摇摆：x = x0 + A·sin(t·ω+φ)，绘制时算、不累加（累加会攒误差）。
constexpr float kSwayAmpMin = 6.f;
constexpr float kSwayAmpMax = 14.f;
constexpr float kSwayOmegaMin = 0.3f;
constexpr float kSwayOmegaMax = 0.8f;
constexpr int kTrailFrames = 3;      // 短拖尾：只给大星/耀斑星画 2-3 帧历史位置
// 星光密度单位：每 100×100 **逻辑**像素多少颗。实际颗数 = 密度 × 窗口逻辑面积 / 10000。
constexpr int kStarUnitPx = 100;
// 旧刻度的换算基准：2026-10-22 之前的设置值 = 参考逻辑分辨率 1512×982 下的颗数。
// 读旧配置（ini 里没有 starunit）时按这个基准折成新单位，老用户的观感不会突然翻几倍。
// 换算本身在 SettingsIO.cpp（读文件那一侧）；这里留着是为了与网页端 starfx 逐值对拍。
[[maybe_unused]] constexpr int kStarDensityRefW = 1512;
[[maybe_unused]] constexpr int kStarDensityRefH = 982;
constexpr int kStarPoolMax = 6000;  // 超大屏 + 最大密度的兜底池上限（正常屏幕远达不到）
// 流星雨：每批颗数 / 铺开时长 / 批次间隔都随机，取值区间见下。
// 旧版是固定「每 60 秒 12 颗铺 15 秒」，一颗一颗看得出来；20~30 颗铺 15~20 秒才是「雨」。
constexpr float kShowerPeriodMin = 60.f;
constexpr float kShowerPeriodMax = 90.f;
constexpr float kShowerSpanMin = 15.f;
constexpr float kShowerSpanMax = 20.f;
constexpr float kShowerInit = 10.f;
constexpr int kShowerCountMin = 20;
constexpr int kShowerCountMax = 30;
constexpr int kMeteorMax = 20;          // 同时在飞的硬上限（免得改参数时炸掉）
constexpr float kMeteorAngMin = 20.f;   // 度
constexpr float kMeteorAngMax = 40.f;
// 单颗过屏 3-4.5s。旧版是 6-8s —— 那时只有一颗，慢才好看；成批之后慢 = 天上飘面条。
constexpr float kMeteorLifeMin = 3.f;
constexpr float kMeteorLifeMax = 4.5f;
constexpr int kMeteorSamples = 16;      // 拖尾多边形的分段数（不再是"80 个圆点"，16 段足够平滑）
constexpr float kMeteorTrailMin = 0.6f; // 拖尾 = 速度 × 这段时间走过的路径
constexpr float kMeteorTrailMax = 1.f;
// 流星头：不再是五角星，而是「高亮核 + 柔光球 + 四芒 + 细环」——
// 照真实流星照片（长细线 + 大柔光球 + 细长十字 + 一圈淡环）拆出来的配方。
// 大小是每颗随机的独立常量，**不吃 starScale_ 滑块**（那是「背景星光多大」）。
constexpr float kMeteorHeadMin = 10.f;      // 头部基准半径 R，下面所有比例都乘它
constexpr float kMeteorHeadMax = 14.f;
constexpr float kTrailHeadW = 0.1f;         // 拖尾头部半宽 / R（发丝级）
constexpr float kMeteorGlow = 9.f;          // 柔光球直径 / R
constexpr float kMeteorCrossLen = 4.2f;     // 四芒臂长 / R
constexpr float kMeteorCrossW = 0.1f;       // 四芒半宽 / R
constexpr float kMeteorCrossA = 0.85f;      // 四芒最亮处 alpha
constexpr float kMeteorRingR = 2.2f;       // 细环半径 / R
constexpr float kMeteorRingW = 0.09f;       // 细环线宽 / R
constexpr float kMeteorRingA = 0.32f;       // 细环 alpha
constexpr float kRingFillA = 0.35f;
// 爆圈中心十字的转速（rad/s）≈ π/3。字面量而非 kPi/3：T57 的抽值正则只认数字。
constexpr float kRippleSpin = 1.0472f;         // 环内填充 = 细环 alpha × 这个值（只描边像铁丝圈，填了像玻璃球）
constexpr float kMeteorCoreR = 0.18f;       // 高亮核半径 / R
// 流星配色：白 / 淡黄 / 淡粉 / 浅绿 / 浅蓝，每颗随机取一档，拖尾和光晕都跟着这档走。
// ★ 写成数组是刻意的：T57 的颜色正则只认 `const sf::Color kX = displayColor(r,g,b)` 单值，
//   数组抽不出来 → 不参与跨端比对。所以**两端的这个数组必须手工保持一致**
//   （同序、同值，见 web/ts/fx.ts 的 meteorCols）。
const sf::Color kMeteorCols[] = {
    displayColor(255, 255, 255),   // 白
    displayColor(255, 233, 160),   // 淡黄
    displayColor(255, 192, 217),   // 淡粉
    displayColor(182, 242, 210),   // 浅绿
    displayColor(191, 230, 255),   // 浅蓝
};
// 档数用 sizeof 推，别新增一个 constexpr 数字常量 —— T57 会把桌面端每个
// constexpr 数拿去和网页端逐个比对，多一个「只在桌面端」的常数就会红。
constexpr int kMeteorColCount = static_cast<int>(sizeof(kMeteorCols) / sizeof(kMeteorCols[0]));
// 点爆流星的扩散圆环：**左键打中流星才触发**（不是点哪都炸），
// 圈的颜色就是那颗流星的配色，半径在基准值上浮动。
//   命中半径 = 该颗流星头部外半径 × kRippleHit —— 星头只有 10-14px，
//   不放宽一点在 1280 宽屏上几乎点不中；取 2.4 后约 24-34px，好点又不至于误伤邻居。
//   最终半径 = kRippleR1 × (1 ± kRippleJitter)，每炸一次随机。
constexpr float kRippleLife = 0.85f;
constexpr float kRippleR0 = 5.f;
constexpr float kRippleR1 = 82.f;
constexpr float kRippleHit = 2.4f;
constexpr float kRippleJitter = 0.35f;
// 中心十字的臂长 = **当前光圈半径** × 该值（十字要随光圈一起变大，且永远比光圈大一点）。
// 旧口径是「最终半径 × 0.62 × (1-t)^0.7」——越往后越短、最后缩成 0，与光圈变大的方向相反。
constexpr float kRippleCrossOverRing = 1.18f;
constexpr float kRippleWidth = 2.f;     // 环线宽（随扩散变细）
// 单位圆彩蛋：2-3% 画成空心圆+一条半径线（复数平面意象，呼应应用图标）。
constexpr float kUnitProb = 0.025f;
constexpr float kUnitRMin = 2.f;
constexpr float kUnitRMax = 3.f;
const sf::Color kUnitCol = displayColor(63, 159, 214);  // #66CCFF 深一档
// 上升速度与 dt 封顶（不变量，别动）。
constexpr float kRiseMin = 5.f;
constexpr float kRiseMax = 19.f;
constexpr float kDtCap = 0.05f;
} // namespace starfx

// 背景不透明度改为可调（见 Renderer::bgAlpha_ / 设置面板滑块）

// sf::Color → "#RRGGBB"：设置面板显示纯色背景用。
// 只用于**原始 sRGB** 的颜色（bgSolid_ 存的就是原值），别拿 P3 补偿后的颜色进来，
// 否则面板上显示的色号会和用户输的对不上。
static std::string toHexColor(const sf::Color& c) {
    static const char* kHexDigits = "0123456789ABCDEF";
    std::string s = "#";
    const std::uint8_t ch[3] = {c.r, c.g, c.b};
    for (int i = 0; i < 3; ++i) {
        s += kHexDigits[ch[i] >> 4];
        s += kHexDigits[ch[i] & 0xF];
    }
    return s;
}

const char* mineGlyph(MineType t) {    switch (t) {
    case MineType::P1: return "+1";
    case MineType::M1: return "-1";
    case MineType::Pi: return "+i";
    case MineType::Mi: return "-i";
    case MineType::None: return "";
    }
    return "";
}

sf::Color mineColor(MineType t) { return isRealMine(t) ? kRealMine : kImagMine; }

// 动效层用的整体淡出：把颜色 alpha 乘上 k（0..1）
sf::Color withAlpha(const sf::Color& c, float k) {
    sf::Color out = c;
    out.a = static_cast<std::uint8_t>(c.a * std::clamp(k, 0.f, 1.f) + 0.5f);
    return out;
}

// 带粗细的线段（SFML 没有带宽度的线，用旋转矩形模拟）
void drawThickLine(sf::RenderTarget& t, sf::Vector2f a, sf::Vector2f b, float thickness, sf::Color c,
                   const sf::RenderStates& st = sf::RenderStates::Default) {
    const sf::Vector2f d = b - a;
    const float len = std::hypot(d.x, d.y);
    if (len <= 0.01f) return;
    sf::RectangleShape seg(sf::Vector2f(len, thickness));
    seg.setOrigin(sf::Vector2f(0.f, thickness * 0.5f));
    seg.setPosition(a);
    seg.setRotation(sf::degrees(std::atan2(d.y, d.x) * 180.f / kPi));
    seg.setFillColor(c);
    t.draw(seg, st);
}

void drawArc(sf::RenderTarget& t, sf::Vector2f center, float radius, float a0, float a1, float thickness, sf::Color c) {
    const int n = 30;
    sf::Vector2f prev = center + sf::Vector2f(radius * std::cos(a0), radius * std::sin(a0));
    for (int i = 1; i <= n; ++i) {
        const float a = a0 + (a1 - a0) * static_cast<float>(i) / n;
        const sf::Vector2f p = center + sf::Vector2f(radius * std::cos(a), radius * std::sin(a));
        drawThickLine(t, prev, p, thickness, c);
        prev = p;
    }
}

std::string fmt3(int v) {
    std::ostringstream os;
    const int c = std::max(-99, std::min(999, v));
    // 负数必须先写符号再补位：setw+setfill('0') 把符号计入宽度，会产出 "0-5" 这种畸形
    if (c < 0) {
        os << '-' << std::setw(2) << std::setfill('0') << -c;
    } else {
        os << std::setw(3) << std::setfill('0') << c;
    }
    return os.str();
}

float textWidthOf(const sf::Font& font, const std::string& s, float size, float bold) {
    sf::Text t(font);
    t.setString(sf::String::fromUtf8(s.begin(), s.end()));
    t.setCharacterSize(size);
    if (bold > 0.f) t.setOutlineThickness(bold);
    return t.getLocalBounds().size.x;
}

// 手工绘制根号：短入笔 -> 下探 -> 上扬 -> 顶栏（overline 盖住被开方数）
void drawRadicalSign(sf::RenderTarget& t, float x, float yTop, float yBottom, float barLen, float thickness, sf::Color col,
                     const sf::RenderStates& st = sf::RenderStates::Default) {
    const float w = std::max(7.f, (yBottom - yTop) * 0.55f);
    const float mid = yTop + (yBottom - yTop) * 0.34f;
    const float bot = yBottom + (yBottom - yTop) * 0.30f;
    drawThickLine(t, sf::Vector2f(x, mid), sf::Vector2f(x + w * 0.32f, bot), thickness, col, st);
    drawThickLine(t, sf::Vector2f(x + w * 0.32f, bot), sf::Vector2f(x + w * 0.66f, yTop), thickness, col, st);
    drawThickLine(t, sf::Vector2f(x + w * 0.42f, yTop), sf::Vector2f(x + w + barLen, yTop), thickness, col, st);
}

// 雷：实心圆 + 白色符号（可自定义字符或图片）；alpha 用于翻开入场/雷区显形的整体淡入
void drawMineDot(sf::RenderTarget& t, const sf::Font& font, sf::Vector2f center, float cellSize, MineType type,
                 float alpha = 1.f, const sf::RenderStates& st = sf::RenderStates::Default) {
    const float r = cellSize * 0.30f;
    sf::CircleShape mine(r, 24);
    mine.setOrigin(sf::Vector2f(r, r));
    mine.setPosition(center);
    mine.setFillColor(withAlpha(mineColor(type), alpha));
    mine.setOutlineColor(withAlpha(displayColor(20, 20, 20, 90), alpha));
    mine.setOutlineThickness(1.5f);
    t.draw(mine, st);
    sf::Text g(font, mineGlyph(type), static_cast<unsigned>(cellSize * 0.34f));
    g.setFillColor(withAlpha(sf::Color::White, alpha));
    g.setOutlineColor(withAlpha(sf::Color::White, alpha));
    g.setOutlineThickness(0.4f);
    const sf::FloatRect b = g.getLocalBounds();
    g.setPosition(sf::Vector2f(center.x - b.position.x - b.size.x * 0.5f, center.y - b.position.y - b.size.y * 0.5f));
    t.draw(g, st);
}

// 玩家标记：白底描边徽章 + 类型色符号；st 里可带「绕格心缩放」（徽章弹入/退场）
void drawMarker(sf::RenderTarget& t, const sf::Font& font, sf::Vector2f center, float cellSize, MineType type,
                const std::string& custom = std::string(), float alpha = 1.f,
                const sf::RenderStates& st = sf::RenderStates::Default) {
    const float r = cellSize * 0.30f;
    const sf::Color col = mineColor(type);
    sf::CircleShape badge(r, 24);
    badge.setOrigin(sf::Vector2f(r, r));
    badge.setPosition(center);
    badge.setFillColor(withAlpha(displayColor(255, 255, 255, 235), alpha));
    badge.setOutlineColor(withAlpha(col, alpha));
    badge.setOutlineThickness(2.2f);
    t.draw(badge, st);
    sf::Text g(font, custom.empty() ? mineGlyph(type) : sf::String::fromUtf8(custom.begin(), custom.end()),
               static_cast<unsigned>(cellSize * 0.34f));
    g.setFillColor(withAlpha(col, alpha));
    g.setOutlineColor(withAlpha(col, alpha));
    g.setOutlineThickness(0.4f);
    const sf::FloatRect b = g.getLocalBounds();
    g.setPosition(sf::Vector2f(center.x - b.position.x - b.size.x * 0.5f, center.y - b.position.y - b.size.y * 0.5f));
    t.draw(g, st);
}

} // namespace

namespace {
// 资源查找顺序：可执行文件旁（打包后的 .app）→ 源码目录（开发时）→ 相对路径
std::vector<std::string> resourcePaths(const std::string& fileName) {
    std::vector<std::string> out;
    const std::string exe = ms::executableDir();
    if (!exe.empty()) {
        out.push_back(exe + "/../Resources/assets/" + fileName); // .app/Contents/MacOS → Contents/Resources
        out.push_back(exe + "/assets/" + fileName);
        out.push_back(exe + "/../assets/" + fileName);
    }
    out.push_back("assets/" + fileName);
    out.push_back("../assets/" + fileName);
    out.push_back("../../assets/" + fileName);
    // 只保留真实存在的候选：否则 SFML 会对每个不存在的路径打印一行
    // "Failed to load ..."，控制台看起来很吓人（其实只是查找到最后才命中）。
    std::vector<std::string> existing;
    for (const auto& cand : out) {
        std::error_code ec;
        if (std::filesystem::exists(cand, ec)) existing.push_back(cand);
    }
    return existing.empty() ? out : existing; // 一个都不存在时才全试一遍，便于报错定位
}
} // namespace

Renderer::Renderer() {
    std::vector<std::string> candidates = resourcePaths("IBMPlexSerif-Regular.ttf");
    candidates.push_back("/System/Library/Fonts/Helvetica.ttc"); // 最后兜底：系统字体
    candidates.push_back("/Library/Fonts/Arial.ttf");
    for (const auto& path : candidates) {
        if (font_.openFromFile(path)) {
            fontOk_ = true;
            if (std::getenv("MS_VERBOSE") != nullptr) std::fprintf(stderr, "[res] main font: %s\n", path.c_str());
            break;
        }
    }

    // 禁用字体纹理的线性过滤（SFML 3.0 默认开启，导致文字模糊）
    if (fontOk_) {
        for (unsigned size = 8; size <= 48; ++size) {
            const_cast<sf::Texture&>(font_.getTexture(size)).setSmooth(false);
        }
    }
}

// 屏幕可用区域：0.94/0.90 的余量用来避开菜单栏与程序坞
sf::Vector2f Renderer::maxWindowSize() {
    // 优先用系统"可用区域"（逻辑点，与窗口同单位，已排除菜单栏/程序坞）
    // 桌面模式（部分环境返回物理像素，Retina 下是 2 倍，所以只当上限用）
    const sf::VideoMode dm = sf::VideoMode::getDesktopMode();
    sf::Vector2f cap(static_cast<float>(dm.size.x) * 0.94f, static_cast<float>(dm.size.y) * 0.90f);

    // 系统"可用区域"更可靠（逻辑点、已扣菜单栏与程序坞）：与上面的上限取更小者
    const std::pair<int, int> usable = ms::screenUsableSize();
    if (usable.first > 200 && usable.second > 200) {
        const sf::Vector2f sys(static_cast<float>(usable.first) * 0.99f,
                               static_cast<float>(usable.second) * 0.99f - 28.f); // 留出标题栏
        cap.x = std::min(cap.x, sys.x);
        cap.y = std::min(cap.y, sys.y);
    }
    return cap;
}

// 给定行列算格子边长：优先 40px，超出屏幕就缩小，最小 24px
// screenCap 必须由调用方传入同一个值（见 Renderer.h 注释：两次取样会算出"棋盘比窗口大"的布局）
float Renderer::cellSizeFor(int cols, int rows, const sf::Vector2f& screenCap) {
    const sf::Vector2f mx = screenCap;
    const float gap = 3.f, pad = 12.f, headerH = 138.f;
    if (cols < 1) cols = 1;
    if (rows < 1) rows = 1;
    const float byW = (mx.x - pad * 2.f + gap) / static_cast<float>(cols) - gap;
    const float byH = (mx.y - headerH - pad * 2.f + gap) / static_cast<float>(rows) - gap;
    float cell = std::min(std::min(byW, byH), kCellMax);
    cell = std::floor(cell);
    return std::max(kCellMin, cell);
}

int Renderer::maxColsAtMinimumCell() {
    const sf::Vector2f mx = maxWindowSize();
    return static_cast<int>(std::floor((mx.x - 12.f * 2.f + 3.f) / (kCellMin + 3.f)));
}

int Renderer::maxRowsAtMinimumCell() {
    const sf::Vector2f mx = maxWindowSize();
    return static_cast<int>(std::floor((mx.y - 138.f - 12.f * 2.f + 3.f) / (kCellMin + 3.f)));
}

void Renderer::layoutFor(int cols, int rows) {
    // 屏幕上限只取一次：算格子与钳窗口必须同源，否则两次取样不一致会把棋盘算得比窗口大
    const sf::Vector2f capMx = maxWindowSize();
    L_.cols = cols;
    L_.rows = rows;
    L_.cell = cellSizeFor(cols, rows, capMx); // 自适应：大棋盘自动缩小格子
    const float pitch = L_.cell + L_.gap;
    L_.boardW = static_cast<float>(cols) * pitch - L_.gap;
    L_.boardH = static_cast<float>(rows) * pitch - L_.gap;

    const float headerMinW = 640.f;
    L_.winW = std::max(headerMinW, L_.boardW + L_.pad * 2);
    L_.winH = L_.headerH + L_.boardH + L_.pad * 2;
    // 硬上限：无论如何窗口不得超过屏幕可用区域（正常路径下由行列上限保证，这里是保险）
    L_.winW = std::min(L_.winW, capMx.x);
    L_.winH = std::min(L_.winH, capMx.y);

    // 棋盘窄于窗口时水平居中
    L_.boardX = (L_.winW - L_.boardW) * 0.5f;
    L_.boardY = L_.headerH + L_.pad;

    const float right = L_.winW;
    L_.restartBtn = sf::FloatRect(sf::Vector2f(right - 54.f, 16.f), sf::Vector2f(34.f, 34.f));
    L_.hardBtn = sf::FloatRect(sf::Vector2f(right - 54.f - 14.f - 74.f, 16.f), sf::Vector2f(74.f, 34.f));
    L_.mediumBtn = sf::FloatRect(sf::Vector2f(L_.hardBtn.position.x - 8.f - 74.f, 16.f), sf::Vector2f(74.f, 34.f));
    L_.easyBtn = sf::FloatRect(sf::Vector2f(L_.mediumBtn.position.x - 8.f - 74.f, 16.f), sf::Vector2f(74.f, 34.f));
    // 第二行右侧：CUSTOM / SEED / 齿轮设置，整体右对齐（窄窗口也不溢出）
    L_.settingsBtn = sf::FloatRect(sf::Vector2f(L_.winW - 52.f, 54.f), sf::Vector2f(34.f, 28.f));
    L_.seedBtn = sf::FloatRect(sf::Vector2f(L_.settingsBtn.position.x - 6.f - 72.f, 54.f), sf::Vector2f(72.f, 28.f));
    L_.customBtn = sf::FloatRect(sf::Vector2f(L_.seedBtn.position.x - 6.f - 92.f, 54.f), sf::Vector2f(92.f, 28.f));
    // 终局才出现的 PLAY AGAIN，插在 CUSTOM 左侧（第二行簇，与 CUSTOM/SEED 同起同落）
    L_.playAgainBtn = sf::FloatRect(sf::Vector2f(L_.customBtn.position.x - 6.f - 118.f, 54.f), sf::Vector2f(118.f, 28.f));
    // 齿轮图标中心
    L_.gearCenter = sf::Vector2f(L_.settingsBtn.position.x + 17.f, 68.f);
    // 标题右侧 ? 帮助图标（标题宽度现场测量，与绘制同源）
    {
        const std::string title = "Complex Minesweeper";
        const float tw = textWidthOf(fontFor(title), title, 21.f, 0.6f);
        L_.helpBtn = sf::FloatRect(sf::Vector2f(18.f + tw + 12.f, 9.f), sf::Vector2f(26.f, 26.f));
        const float hw = std::min(640.f, L_.winW - 20.f);
        const float hh = std::min(680.f, L_.winH - 16.f);
        L_.helpPanel = sf::FloatRect(sf::Vector2f((L_.winW - hw) * 0.5f, (L_.winH - hh) * 0.5f - 4.f), sf::Vector2f(hw, hh));
    }
    // 设置面板
    {
        const float sw = 560.f, sh = 510.f;
        float sx = (L_.winW - sw) * 0.5f, sy = (L_.winH - sh) * 0.5f - 16.f;
        sx = std::max(8.f, std::min(sx, L_.winW - sw - 8.f));
        sy = std::max(8.f, std::min(sy, L_.winH - sh - 8.f));
        L_.setPanel = sf::FloatRect(sf::Vector2f(sx, sy), sf::Vector2f(sw, sh));
    }
    // 高 18 而非 26：这一行的下沿必须停在 USTC 复选框行（headerH-31）之前，
    // 否则编辑透明度时的高亮框会压住「总是显示模长」的字头（窗口宽约 800–910px 时实测重叠 5px）。
    L_.bgValue = sf::FloatRect(sf::Vector2f(566.f, 88.f), sf::Vector2f(34.f, 18.f));
    // 滑条从百分比数字右侧一直延伸到"重新开始"按钮左端附近，窗口越宽越长
    const float bgTrackX = 604.f;
    const float bgTrackW = std::max(30.f, L_.winW - 10.f - bgTrackX);
    L_.bgTrack = sf::FloatRect(sf::Vector2f(bgTrackX, 96.f), sf::Vector2f(bgTrackW, 8.f));
}

std::optional<std::pair<int, int>> Renderer::cellAt(sf::Vector2i px) const {
    const float x = static_cast<float>(px.x) - L_.boardX;
    const float y = static_cast<float>(px.y) - L_.boardY;
    if (x < 0 || y < 0) return std::nullopt;
    const float pitch = L_.cell + L_.gap;
    int c = static_cast<int>(x / pitch);
    int r = static_cast<int>(y / pitch);
    // 落在格子间隙（gap）里时吸附到后一格，而不是判空。
    // 原来直接 return nullopt 会让棋盘上有 1-(cell/pitch)^2 的面积点不动：
    // 40px 格约 13%，25x25 的 24px 小格约 21%——大棋盘上尤其明显。
    if (x - c * pitch > L_.cell) ++c;
    if (y - r * pitch > L_.cell) ++r;
    // 吸附后可能落到棋盘外（点在最右/最下间隙或窗口留白），钳上界：board.at() 会越界读
    if (r >= L_.rows || c >= L_.cols) return std::nullopt;
    return std::make_pair(r, c);
}

Renderer::HeaderAction Renderer::headerActionAt(sf::Vector2i px) const {
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    if (L_.helpBtn.contains(p)) return HeaderAction::Help;
    if (playAgainVisible_ && L_.playAgainBtn.contains(p)) return HeaderAction::PlayAgain;
    if (L_.restartBtn.contains(p)) return HeaderAction::Restart;
    if (L_.customBtn.contains(p)) return HeaderAction::Custom;
    if (L_.seedBtn.contains(p)) return HeaderAction::Seed;
    if (L_.settingsBtn.contains(p)) return HeaderAction::Settings;
    {
        const UstcRects ur = ustcRects();
        if (ur.box.contains(p) || ur.label.contains(p)) return HeaderAction::Ustc;
        if (ur.hideBox.contains(p) || ur.hideLabel.contains(p)) return HeaderAction::HideCounts;
        if (ur.magBox.contains(p) || ur.magLabel.contains(p)) return HeaderAction::AlwaysMagnitude;
    }
    if (L_.easyBtn.contains(p)) return HeaderAction::Easy;
    if (L_.mediumBtn.contains(p)) return HeaderAction::Medium;
    if (L_.hardBtn.contains(p)) return HeaderAction::Hard;
    return HeaderAction::None;
}

sf::Text Renderer::textSpr(const std::string& s, float size, sf::Color color, float cx, float cy, float bold) const {
    const sf::Font& f = fontFor(s);
    // 每次创建文字时都禁用字体纹理的线性过滤（SFML 3.0 可能内部重建纹理）
    const_cast<sf::Texture&>(f.getTexture(static_cast<unsigned>(size))).setSmooth(false);
    sf::Text t(f);
    t.setString(sf::String::fromUtf8(s.begin(), s.end()));
    t.setCharacterSize(size);
    t.setFillColor(color);
    if (bold > 0.f) {
        t.setOutlineColor(color);
        t.setOutlineThickness(bold);
    }
    const sf::FloatRect b = t.getLocalBounds();
    t.setPosition(sf::Vector2f(std::round(cx - b.position.x - b.size.x * 0.5f),
                               std::round(cy - b.position.y - b.size.y * 0.5f)));
    return t;
}

sf::Text Renderer::textTLSpr(const std::string& s, float size, sf::Color color, float x, float y, float bold) const {
    const sf::Font& f = fontFor(s);
    const_cast<sf::Texture&>(f.getTexture(static_cast<unsigned>(size))).setSmooth(false);
    sf::Text t(f);
    t.setString(sf::String::fromUtf8(s.begin(), s.end()));
    t.setCharacterSize(size);
    t.setFillColor(color);
    if (bold > 0.f) {
        t.setOutlineColor(color);
        t.setOutlineThickness(bold);
    }
    const sf::FloatRect b = t.getLocalBounds();
    t.setPosition(sf::Vector2f(std::round(x - b.position.x), std::round(y - b.position.y)));
    return t;
}

sf::Text Renderer::textCJKSpr(const std::string& s, float size, sf::Color color, float x, float y) const {
    const sf::Font& f = fontCjkOk_ ? fontCJK_ : font_;
    const_cast<sf::Texture&>(f.getTexture(static_cast<unsigned>(size))).setSmooth(false);
    sf::Text t(f);
    t.setString(sf::String::fromUtf8(s.begin(), s.end()));
    t.setCharacterSize(size);
    t.setFillColor(color);
    const sf::FloatRect b = t.getLocalBounds();
    t.setPosition(sf::Vector2f(std::round(x - b.position.x), std::round(y - b.position.y)));
    return t;
}

void Renderer::drawHint(const Cell& cell, sf::Vector2f center, sf::RenderTarget& t, float alpha,
                        const sf::RenderStates& st) const {
    if (cell.minesAround == 0) {
        // 空白格：可自定义字符 / 图片
        if (blankTexOk_) {
            const sf::Vector2u ts = blankTex_.getSize();
            const float target = L_.cell * 0.6f;
            const float sc = std::min(target / static_cast<float>(ts.x), target / static_cast<float>(ts.y));
            sf::Sprite sp(blankTex_);
            sp.setOrigin(sf::Vector2f(ts.x * 0.5f, ts.y * 0.5f));
            sp.setScale(sf::Vector2f(sc, sc));
            sp.setPosition(center);
            sp.setColor(withAlpha(sf::Color::White, alpha));
            t.draw(sp, st);
        } else if (!blankChar_.empty() && fontOk_) {
            t.draw(textSpr(blankChar_, L_.cell * 0.5f, withAlpha(kZeroHint, alpha), center.x, center.y, 0.5f), st);
        }
        return;
    }
    if (!fontOk_) return;

    const int re = cell.realSum;
    const int im = cell.imagSum;
    const int s = squaredMagnitude(re, im);

    // 有雷但复数和抵消为零：黄色 0（不展开！）。环已裁掉（2026-10-29 用户裁决），
    // 黄 0 与真空格靠「有没有数字」区分；几何与网页端 ui.ts 的 cancelZero 对齐。
    if (s == 0) {
        // 环已裁掉（2026-10-29 用户裁决）：黄色 0 本身足够与真空格区分（真空格没有数字）。
        t.draw(textSpr("0", L_.cell * 0.46f, withAlpha(kZeroHint, alpha), center.x, center.y, 0.6f), st);
        return;
    }

    const HintKind kind = hintKind(re, im);
    // 勾选「总是显示模长」后一律紫色：模长抹去了符号，轴色会多泄露实/虚轴信息，索性统一
    const sf::Color col = withAlpha(alwaysMagnitude_
                              ? kMixHint
                              : (kind == HintKind::PureReal ? kRealHint : kind == HintKind::PureImag ? kImagHint : kMixHint), alpha);

    const float cellW = L_.cell;
    const float kBold = 0.7f;
    const int f = largestSquareFactor(s);
    const int r = s / (f * f);

    if (r == 1) {
        // 纯实/纯虚：带正负号和；混合整数：勾股模长（如 3 实 4 虚 -> 5）
        // 勾选"总是显示模长"：一律显示模长（完全平方 => 整数 f = |z|）
        const std::string str = alwaysMagnitude_ ? std::to_string(f) : formatHintSigned(re, im);
        float fs = cellW * 0.58f;
        const float w = textWidth(str, fs, kBold);
        if (w > cellW * 0.8f) fs *= cellW * 0.8f / w;
        t.draw(textSpr(str, fs, col, center.x, center.y, kBold), st);
        return;
    }

    // 根式提示：[系数]根号[被开方数]
    const std::string coef = f > 1 ? std::to_string(f) : std::string();
    const std::string rad = std::to_string(r);

    float fs = cellW * 0.58f;
    float coefW = 0.f;
    float radW = 0.f;
    float gw = 0.f;
    float total = 0.f;
    auto measure = [&]() {
        coefW = coef.empty() ? 0.f : textWidth(coef, fs, kBold);
        radW = textWidth(rad, fs * 0.86f, kBold);
        gw = std::max(7.f, fs * 0.34f);
        total = coefW + gw + radW;
    };
    measure();
    const float maxW = cellW * 0.88f;
    if (total > maxW) {
        fs *= maxW / total;
        measure();
    }

    float x = center.x - total * 0.5f;
    if (!coef.empty()) {
        t.draw(textSpr(coef, fs, col, x + coefW * 0.5f, center.y, kBold), st);
        x += coefW;
    }
    const float dh = fs * 0.72f;
    drawRadicalSign(t, x, center.y - dh * 0.5f - 1.5f, center.y + dh * 0.42f, radW + 2.f, std::max(1.5f, fs * 0.07f), col, st);
    x += gw;
    t.draw(textSpr(rad, fs * 0.86f, col, x + radW * 0.5f, center.y + fs * 0.03f, kBold), st);
}

void Renderer::drawCellBackground(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t) const {
    drawCellImpl(board, r, c, hovered, hud, t, true, false);
}

void Renderer::drawCellContent(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t) const {
    drawCellImpl(board, r, c, hovered, hud, t, false, true);
}

void Renderer::drawCellImpl(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t,
                            bool doBg, bool doContent) const {
    const Cell& cell = board.at(r, c);
    const float pitch = L_.cell + L_.gap;
    const sf::Vector2f pos(L_.boardX + c * pitch, L_.boardY + r * pitch);
    const sf::Vector2f sz(L_.cell, L_.cell);
    const sf::Vector2f center = pos + sz * 0.5f;
    const std::size_t idx = static_cast<std::size_t>(r) * static_cast<std::size_t>(board.cols()) + static_cast<std::size_t>(c);

    // 标记错误（类型不符或标了空格的底色
    const bool badMark = hud.phase != Phase::Playing && cell.flag != MineType::None &&
                         (cell.mine == MineType::None || cell.mine != cell.flag);

    if (doBg) {
        const float rv = revealOf(idx); // -1 = 波前未到；0..1 = 入场进度；1 = 完成/无动画
        sf::RectangleShape rect(sz);
        rect.setPosition(pos);
        rect.setOutlineThickness(1.f);
        if (cell.opened && rv >= 0.f && rv < 1.f) {
            // 波前入场：已开填充以 alpha=rv 淡入，未开样式先打底
            rect.setFillColor(badMark ? kBadFlagBg : hovered ? coveredHover() : coveredFill());
            rect.setOutlineColor(coveredEdge());
            t.draw(rect);
            rect.setFillColor(withAlpha(cell.exploded ? kBoomBg
                              : cell.minesAround == 0 ? kOpenedZero
                              : (cell.realSum == 0 && cell.imagSum == 0 ? kOpenedCancel : kOpened), rv));
            rect.setOutlineColor(withAlpha(kGridLine, rv));
            t.draw(rect);
        } else if (cell.opened && rv >= 0.f) {
            // 三种"已翻开"底色必须分得开：真空格（无字、会连锁展开）/
            // 有雷但和为零（黄 0）/ 普通数字格。
            // rv < 0（波前未到）不能走这里，否则底色先全亮、波前到达又跳回未开再淡入 → 整体闪烁。
            rect.setFillColor(cell.exploded ? kBoomBg
                              : cell.minesAround == 0 ? kOpenedZero
                              : (cell.realSum == 0 && cell.imagSum == 0 ? kOpenedCancel : kOpened));
            rect.setOutlineColor(kGridLine);
            t.draw(rect);
        } else {
            if (badMark) {
                rect.setFillColor(kBadFlagBg);
            } else if (hovered) {
                rect.setFillColor(coveredHover());
            } else {
                rect.setFillColor(coveredFill());
            }
            rect.setOutlineColor(coveredEdge());
            t.draw(rect);
            // 亚克力质感：顶部高光渐弱、底部一圈冷色内阴影（网页端 acrylic() 同 stops，不受开关门控）
            if (!badMark) drawAcrylic(t, pos, sz);
            // 邻域预亮：悬停格的 8 邻域微微提亮（neighborLit_ 在 syncAnims 里算好）
            if (!badMark && idx < neighborLit_.size() && neighborLit_[idx]) {
                sf::RectangleShape lit(sz);
                lit.setPosition(pos);
                lit.setFillColor(displayColor(255, 255, 255, 14));
                t.draw(lit);
            }
        }
    }
    if (!doContent) return;

    const float rv = revealOf(idx);
    if (rv < 0.f) return; // 波前未到：只画底（上面 doBg 已画未开样式）

    // 入场变换：绕格心缩放 0.8→1 + 错标抖动的水平平移（网页端 drawCellContent 同式）
    sf::Transform tr = sf::Transform::Identity;
    if (rv < 1.f) {
        const float k = 0.8f + 0.2f * rv;
        tr.scale(sf::Vector2f(k, k), center);
    }
    if (badMark) tr.translate(sf::Vector2f(shakeDx(), 0.f));
    const sf::RenderStates st(tr);
    const float alpha = rv < 1.f ? rv : 1.f;

    if (cell.opened) {
        if (cell.mine != MineType::None) {
            if (fontOk_) {
                drawMineDot(t, font_, center, L_.cell, cell.mine, alpha * lossAlphaOf(r, c), st);
            }
        } else {
            drawHint(cell, center, t, alpha, st);
        }
        return;
    }

    // 未翻开：有标记画徽章，否则游戏结束时揭示未标记的雷
    if (cell.flag != MineType::None) {
        const int mi = static_cast<int>(cell.flag);
        const FlagPop pop = flagPopOf(idx);
        if (markerTexOk_[mi]) { // 自定义图片：等比放进格子
            const sf::Vector2u ts = markerTex_[mi].getSize();
            const float target = L_.cell * 0.78f;
            const float sc = std::min(target / static_cast<float>(ts.x), target / static_cast<float>(ts.y));
            sf::Sprite sp(markerTex_[mi]);
            sp.setOrigin(sf::Vector2f(ts.x * 0.5f, ts.y * 0.5f));
            sp.setScale(sf::Vector2f(sc * pop.scale, sc * pop.scale));
            sp.setPosition(center);
            sp.setColor(withAlpha(sf::Color::White, alpha));
            t.draw(sp, st);
        } else if (fontOk_) {
            // 徽章弹入缩放：字符徽章与图片标记同乘 pop.scale（web 端 drawMarkerBadge 同式），
            // easeOutBack 过冲时 scale>1 也照乘
            sf::Transform tr = st.transform;
            tr.scale(sf::Vector2f(pop.scale, pop.scale), center);
            drawMarker(t, font_, center, L_.cell, cell.flag, markerChar_[mi], alpha, sf::RenderStates(tr));
        }
        // 落定光环：徽章弹入完成后从 0.30·cell 扩到 0.75·cell 渐隐
        if (pop.ring > 0.f) {
            const float rr = L_.cell * 0.30f + pop.ring * L_.cell * 0.45f;
            sf::CircleShape ring(rr, 24);
            ring.setOrigin(sf::Vector2f(rr, rr));
            ring.setPosition(center);
            ring.setFillColor(sf::Color::Transparent);
            ring.setOutlineColor(withAlpha(mineColor(cell.flag), 0.55f * (1.f - pop.ring)));
            ring.setOutlineThickness(2.f);
            t.draw(ring);
        }
        if (badMark && fontOk_) {
            drawThickLine(t, pos + sz * 0.18f, pos + sz * 0.82f, 2.4f, withAlpha(kBadMark, alpha), st);
            drawThickLine(t, sf::Vector2f(pos.x + L_.cell * 0.82f, pos.y + L_.cell * 0.18f), sf::Vector2f(pos.x + L_.cell * 0.18f, pos.y + L_.cell * 0.82f), 2.4f, withAlpha(kBadMark, alpha), st);
        }
        return;
    }

    // 彩蛋：每个未翻开、未标记的格子都显示 USTC 之一（开局前 / 结束后同样有效）
    // 用纯哈希决定字符（不消耗游戏的随机数流，否则会破坏种子可复现性）
    // ⚠️ 本式与网页端 renderer.ts 的 USTC 彩蛋**逐位对应**，改一处必须改另一处。
    // 旧版只取 (h >> 7) % 4 两个 bit → 16 行里只有 4 种排列，整盘看着像平铺水印；
    // 这里补一段 murmur3 式的 32 位雪崩（全是无符号运算，和 JS 的 Math.imul 同 bits）。
    if (ustcMode_ && fontOk_) {
        std::uint32_t h = static_cast<std::uint32_t>(r) * 0x27d4eb2du ^
                          static_cast<std::uint32_t>(c) * 0x165667b1u ^
                          board.seed() * 0x9e3779b1u;
        h ^= h >> 16; h *= 0x7feb352du;
        h ^= h >> 15; h *= 0x846ca68bu;
        h ^= h >> 16;
        const char ch = "USTC"[h & 3u];
        t.draw(textSpr(std::string(1, ch), 20.f, kUstcGray, center.x, center.y, 0.0f));
    }

    if (hud.phase != Phase::Playing && cell.mine != MineType::None) {
        // 雷区显形：失败后从爆点按切比雪夫距离逐圈淡入（lossAlphaOf 给 0..1）
        const float la = lossAlphaOf(r, c);
        if (fontOk_ && la > 0.f) {
            drawMineDot(t, font_, center, L_.cell, cell.mine, la);
        }
    }
}

#if MS_SOLVER_HINTS
void Renderer::drawHintCellOverlay(sf::RenderTarget& t) const {
    if (hintR_ < 0 || hintC_ < 0) return;
    const float pitch = L_.cell + L_.gap;
    const sf::Vector2f pos(L_.boardX + hintC_ * pitch, L_.boardY + hintR_ * pitch);
    const sf::Vector2f sz(L_.cell, L_.cell);
    // 脉冲描边：#66CCFF 呼吸，周期约 1.3 秒
    const float pulse = 0.5f + 0.5f * std::sin(static_cast<float>(hintClock_) * 0.12f);
    const std::uint8_t a = static_cast<std::uint8_t>(120.f + 115.f * pulse);
    sf::RectangleShape glow(sz);
    glow.setPosition(pos);
    glow.setFillColor(displayColor(102, 204, 255, static_cast<std::uint8_t>(a / 3)));
    t.draw(glow);
    sf::RectangleShape frame(sz);
    frame.setPosition(pos);
    frame.setFillColor(sf::Color::Transparent);
    frame.setOutlineColor(displayColor(102, 204, 255, a));
    frame.setOutlineThickness(3.f);
    t.draw(frame);
}
#endif

// ============================ 设置（外观自定义） ============================
namespace {
bool isVisibleAscii(const std::string& s) { // 只接受"可见 ASCII"的单字符
    if (s.size() != 1) return false;
    const unsigned char c = static_cast<unsigned char>(s[0]);
    return c >= 0x21 && c <= 0x7E;
}

} // namespace

// 格子颜色：填充 / 描边（深一档）/ 悬停（亮一档），都走 Display P3 补偿
sf::Color Renderer::coveredFill() const {
    return displayColor(cellR_, cellG_, cellB_);
}
sf::Color Renderer::coveredEdge() const {
    const auto dark = [](std::uint8_t v) {
        return static_cast<std::uint8_t>(static_cast<int>(v) * 4 / 5);
    };
    return displayColor(dark(cellR_), dark(cellG_), dark(cellB_));
}
sf::Color Renderer::coveredHover() const {
    const auto light = [](std::uint8_t v) {
        return static_cast<std::uint8_t>((static_cast<int>(v) + 255 * 3) / 4);
    };
    return displayColor(light(cellR_), light(cellG_), light(cellB_));
}

void Renderer::setCellColor(int r, int g, int b) {
    if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) return; // 越界忽略
    cellR_ = static_cast<std::uint8_t>(r);
    cellG_ = static_cast<std::uint8_t>(g);
    cellB_ = static_cast<std::uint8_t>(b);
    saveSettings();
}

void Renderer::resetCellColor() {
    cellR_ = 102;
    cellG_ = 204;
    cellB_ = 255;
    saveSettings();
}

void Renderer::setMarkerChar(MineType mt, const std::string& ch) {
    const int i = static_cast<int>(mt);
    if (i < 1 || i > 4) return;
    if (ch.empty()) {
        markerChar_[i].clear();
        if (!markerImage_[i].empty()) { ms::removeImage(markerImage_[i]); markerImage_[i].clear(); }
        saveSettings();
        return;
    }
    if (!isVisibleAscii(ch)) return;
    markerChar_[i] = ch;
    if (!markerImage_[i].empty()) { ms::removeImage(markerImage_[i]); markerImage_[i].clear(); }
    markerTexOk_[i] = false;
    saveSettings();
}

std::string Renderer::markerChar(MineType mt) const {
    const int i = static_cast<int>(mt);
    return (i >= 1 && i <= 4) ? markerChar_[i] : std::string();
}

// ── 图片闸门：唯一解码入口 ──────────────────────────────────────────
// 2026-10-21 安全审计 P1/P2 的核心。原来每条加载路径都直接
// sf::Image::loadFromFile（整幅解码）然后才判像素 —— 而一张 70 字节、
// IHDR 声明 20000×20000 的 PNG 会让解码申请约 2.1GB（stb 只挡 >2^31 那档），
// loadFromFile 里再 resize 一份，峰值约 4.2GB → 未捕获 bad_alloc → terminate。
//
// 现在所有解码都走这里：readWholeFile 一次读出字节并验头，过了才解码**同一份字节**。
// 不再 probeFile 之后 loadFromFile(path)：那是两次 open，中间文件可以被换掉
// （TOCTOU）—— 验过的是 100×100，解码的可能是 20000×20000。
//
// ★ src/desktop 里**不允许再出现** sf::Image::loadFromFile / loadFromMemory
//   以外的解码入口；tools/check_invariants.py 会静态钉住这一点。
static std::string tooBigNote(unsigned w, unsigned h) {
    // 判据是**总像素**（4096×4096 ≈ 1677 万），不是长边 —— 8000×1000 是允许的。
    // 所以提示要报实际宽高与总像素，否则用户会以为"长边没超"而反复换同一张。
    const unsigned long long wan = (static_cast<unsigned long long>(w) * h + 5000) / 10000;
    return "IMAGE TOO BIG · 图片尺寸 " + std::to_string(w) + "×" + std::to_string(h) +
           "（约 " + std::to_string(wan) + " 万像素），超过 4096×4096 的上限，换小一点的";
}

bool Renderer::loadImageChecked(const std::string& path, sf::Image& out) {
    imageRejectNote_.clear();
    std::string why;
    std::vector<std::uint8_t> bytes;
    const auto r = ms::imgprobe::readWholeFile(path, bytes, &why);
    if (r.st != ms::imgprobe::St::Ok) {
        // 字节超限与「根本不是图片」要分开说：前者换张小的就行，
        // 后者继续换同格式的大图也白搭。
        imageRejectNote_ = (why == "bytes>24MiB")
            ? std::string("IMAGE TOO LARGE · 图片文件超过 24 MB，换小一点的")
            : std::string("BAD IMAGE · 图片读取失败（格式不支持或文件损坏）");
        if (std::getenv("MS_VERBOSE"))
            std::fprintf(stderr, "[img] reject %s (%s)\n", path.c_str(),
                         why.empty() ? "unknown" : why.c_str());
        return false;
    }
    if (!ms::imgprobe::sizeOk(r.w, r.h)) {
        // 用户看到的是「太大 + 实际尺寸」，不是 BAD IMAGE —— 后者会让人以为
        // 文件坏了，然后反复换一张同样超限的图。
        imageRejectNote_ = tooBigNote(r.w, r.h);
        if (std::getenv("MS_VERBOSE"))
            std::fprintf(stderr, "[img] reject %s (pixels %ux%u > 4096x4096)\n", path.c_str(),
                         r.w, r.h);
        return false;
    }
    if (!out.loadFromMemory(bytes.data(), bytes.size())) {
        imageRejectNote_ = "BAD IMAGE · 图片解码失败";
        return false;
    }
    return true;
}

// 导入前的检查：过闸门 + 真的能被 SFML 解出来（保留原来那层"能不能解"的验证）。
bool Renderer::probeImageForImport(const std::string& path) {
    sf::Image probe;
    if (!loadImageChecked(path, probe)) return false;
    const sf::Vector2u sz = probe.getSize();
    if (!ms::imgprobe::sizeOk(sz.x, sz.y)) {   // 对解码结果再核一次（防头与实际不一致）
        imageRejectNote_ = tooBigNote(sz.x, sz.y);
        return false;
    }
    return true;
}

bool Renderer::loadMarkerImageFromFile(int idx, const std::string& fullPath) {
    if (idx < 1 || idx > 4 || fullPath.empty()) return false;
    sf::Image src;
    if (!loadImageChecked(fullPath, src)) return false;
    // 标记显示尺寸仅 ~30px，但保留 1280px 以内保证画质；超过时双线性插值缩放
    const unsigned kMaxDim = 1280;
    const sf::Vector2u srcSz = src.getSize();
    sf::Image img;
    bool resized = false;
    if (srcSz.x > kMaxDim || srcSz.y > kMaxDim) {
        const float sc = std::min(static_cast<float>(kMaxDim) / srcSz.x, static_cast<float>(kMaxDim) / srcSz.y);
        const unsigned w = static_cast<unsigned>(srcSz.x * sc);
        const unsigned h = static_cast<unsigned>(srcSz.y * sc);
        img.resize(sf::Vector2u(w, h));
        // 双线性插值：避免最邻近采样的锯齿/噪点
        for (unsigned y = 0; y < h; ++y) {
            for (unsigned x = 0; x < w; ++x) {
                const float sx = (x + 0.5f) / w * srcSz.x - 0.5f;
                const float sy = (y + 0.5f) / h * srcSz.y - 0.5f;
                const int x0 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, static_cast<int>(sx)));
                const int y0 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, static_cast<int>(sy)));
                const int x1 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, x0 + 1));
                const int y1 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, y0 + 1));
                const float fx = sx - x0;
                const float fy = sy - y0;
                const sf::Color c00 = src.getPixel(sf::Vector2u(x0, y0));
                const sf::Color c10 = src.getPixel(sf::Vector2u(x1, y0));
                const sf::Color c01 = src.getPixel(sf::Vector2u(x0, y1));
                const sf::Color c11 = src.getPixel(sf::Vector2u(x1, y1));
                const auto blend = [](float a, float b, float t) -> std::uint8_t {
                    return static_cast<std::uint8_t>(a + (b - a) * t);
                };
                img.setPixel(sf::Vector2u(x, y), sf::Color(
                    blend(blend(c00.r, c10.r, fx), blend(c01.r, c11.r, fx), fy),
                    blend(blend(c00.g, c10.g, fx), blend(c01.g, c11.g, fx), fy),
                    blend(blend(c00.b, c10.b, fx), blend(c01.b, c11.b, fx), fy),
                    blend(blend(c00.a, c10.a, fx), blend(c01.a, c11.a, fx), fy)
                ));
            }
        }
        resized = true;
    } else {
        img = src;
    }
    applyDisplayP3(img);
    // 缩放后写回配置目录（覆盖原图），下次启动直接加载小图，不用重复缩放
    // 只在「SFML 能写这个后缀」时才回写：saveToFile 是按扩展名选编码器的，
    // .gif 读得进、写不出。以前这里会静默失败（文件没缩小，下次启动再缩一遍）。
    if (resized && !ms::imgprobe::writableExt(std::filesystem::path(fullPath).extension().string())) {
        if (std::getenv("MS_VERBOSE"))
            std::fprintf(stderr, "[img] skip write-back (unwritable ext): %s\n", fullPath.c_str());
    } else if (resized) {
        if (!img.saveToFile(fullPath)) {
            // 写回失败不影响本次加载（内存里已有正确纹理），只是下次启动会重新缩放
        }
    }
    if (!markerTex_[idx].loadFromImage(img)) return false;
    markerTex_[idx].setSmooth(true);
    markerTexOk_[idx] = true;
    return true;
}

bool Renderer::setMarkerImage(MineType mt, const std::string& path) {
    const int i = static_cast<int>(mt);
    if (i < 1 || i > 4 || path.empty()) return false;
    // 先验后换：坏图直接在源文件处拒绝，绝不先删掉配置目录里的旧图
    // （importImage 会删同槽位旧图，若先换后验，坏图=旧图丢失+屏上仍显旧纹理，下次启动才暴露）
    if (!probeImageForImport(path)) return false;
    const char* slots[5] = {"", "marker_plus1", "marker_minus1", "marker_plusi", "marker_minusi"};
    const std::string name = ms::importImage(path, slots[i]);
    if (name.empty()) return false;
    if (!loadMarkerImageFromFile(i, ms::settingsDir() + "/" + name)) return false;
    markerImage_[i] = name;
    markerChar_[i].clear();
    saveSettings();
    return true;
}

void Renderer::clearMarkerImage(MineType mt) {
    const int i = static_cast<int>(mt);
    if (i < 1 || i > 4) return;
    if (!markerImage_[i].empty()) ms::removeImage(markerImage_[i]); // 一并删掉配置目录里的图片
    markerTexOk_[i] = false;
    markerImage_[i].clear();
    saveSettings();
}

std::string Renderer::markerImagePath(MineType mt) const {
    const int i = static_cast<int>(mt);
    return (i >= 1 && i <= 4) ? markerImage_[i] : std::string();
}

bool Renderer::markerHasImage(MineType mt) const {
    const int i = static_cast<int>(mt);
    return i >= 1 && i <= 4 && markerTexOk_[i];
}

// —— 翻开空白格自定义（单槽：一个字符或一张图片）——
void Renderer::setBlankChar(const std::string& ch) {
    if (ch.empty()) {
        blankChar_.clear();
        if (!blankImage_.empty()) { ms::removeImage(blankImage_); blankImage_.clear(); }
        saveSettings();
        return;
    }
    if (!isVisibleAscii(ch)) return;
    blankChar_ = ch;
    if (!blankImage_.empty()) { ms::removeImage(blankImage_); blankImage_.clear(); }
    blankTexOk_ = false;
    saveSettings();
}

std::string Renderer::blankChar() const { return blankChar_; }

bool Renderer::loadBlankImageFromFile(const std::string& fullPath) {
    if (fullPath.empty()) return false;
    sf::Image src;
    if (!loadImageChecked(fullPath, src)) return false;
    // 空白格显示尺寸约 30px，但保留 1280px 以内保证画质；超过时双线性插值缩放
    const unsigned kMaxDim = 1280;
    const sf::Vector2u srcSz = src.getSize();
    sf::Image img;
    bool resized = false;
    if (srcSz.x > kMaxDim || srcSz.y > kMaxDim) {
        const float sc = std::min(static_cast<float>(kMaxDim) / srcSz.x, static_cast<float>(kMaxDim) / srcSz.y);
        const unsigned w = static_cast<unsigned>(srcSz.x * sc);
        const unsigned h = static_cast<unsigned>(srcSz.y * sc);
        img.resize(sf::Vector2u(w, h));
        // 双线性插值：避免最邻近采样的锯齿/噪点
        for (unsigned y = 0; y < h; ++y) {
            for (unsigned x = 0; x < w; ++x) {
                const float sx = (x + 0.5f) / w * srcSz.x - 0.5f;
                const float sy = (y + 0.5f) / h * srcSz.y - 0.5f;
                const int x0 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, static_cast<int>(sx)));
                const int y0 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, static_cast<int>(sy)));
                const int x1 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, x0 + 1));
                const int y1 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, y0 + 1));
                const float fx = sx - x0;
                const float fy = sy - y0;
                const sf::Color c00 = src.getPixel(sf::Vector2u(x0, y0));
                const sf::Color c10 = src.getPixel(sf::Vector2u(x1, y0));
                const sf::Color c01 = src.getPixel(sf::Vector2u(x0, y1));
                const sf::Color c11 = src.getPixel(sf::Vector2u(x1, y1));
                const auto blend = [](float a, float b, float t) -> std::uint8_t {
                    return static_cast<std::uint8_t>(a + (b - a) * t);
                };
                img.setPixel(sf::Vector2u(x, y), sf::Color(
                    blend(blend(c00.r, c10.r, fx), blend(c01.r, c11.r, fx), fy),
                    blend(blend(c00.g, c10.g, fx), blend(c01.g, c11.g, fx), fy),
                    blend(blend(c00.b, c10.b, fx), blend(c01.b, c11.b, fx), fy),
                    blend(blend(c00.a, c10.a, fx), blend(c01.a, c11.a, fx), fy)
                ));
            }
        }
        resized = true;
    } else {
        img = src;
    }
    applyDisplayP3(img);
    // 只在「SFML 能写这个后缀」时才回写：saveToFile 是按扩展名选编码器的，
    // .gif 读得进、写不出。以前这里会静默失败（文件没缩小，下次启动再缩一遍）。
    if (resized && !ms::imgprobe::writableExt(std::filesystem::path(fullPath).extension().string())) {
        if (std::getenv("MS_VERBOSE"))
            std::fprintf(stderr, "[img] skip write-back (unwritable ext): %s\n", fullPath.c_str());
    } else if (resized) {
        if (!img.saveToFile(fullPath)) {
            // 写回失败不影响本次加载
        }
    }
    if (!blankTex_.loadFromImage(img)) return false;
    blankTex_.setSmooth(true);
    blankTexOk_ = true;
    return true;
}

bool Renderer::setBlankImage(const std::string& path) {
    if (path.empty()) return false;
    if (!probeImageForImport(path)) return false;
    const std::string name = ms::importImage(path, "blank");
    if (name.empty()) return false;
    if (!loadBlankImageFromFile(ms::settingsDir() + "/" + name)) return false;
    blankImage_ = name;
    blankChar_.clear();
    saveSettings();
    return true;
}

void Renderer::clearBlankImage() {
    if (!blankImage_.empty()) ms::removeImage(blankImage_);
    blankTexOk_ = false;
    blankImage_.clear();
    saveSettings();
}

std::string Renderer::blankImagePath() const { return blankImage_; }

bool Renderer::blankHasImage() const { return blankTexOk_; }

// 只负责加载（文件名直接给全路径），不写配置——供 loadSettings 使用
bool Renderer::loadBackgroundFromFile(const std::string& fullPath) {
    if (fullPath.empty()) return false;
    sf::Image src;
    if (!loadImageChecked(fullPath, src)) return false;
    // 背景图限制到 2560px 以内；超过时双线性插值缩放，避免 applyDisplayP3 卡死
    const unsigned kMaxDim = 2560;
    const sf::Vector2u srcSz = src.getSize();
    sf::Image img;
    bool resized = false;
    if (srcSz.x > kMaxDim || srcSz.y > kMaxDim) {
        const float sc = std::min(static_cast<float>(kMaxDim) / srcSz.x, static_cast<float>(kMaxDim) / srcSz.y);
        const unsigned w = static_cast<unsigned>(srcSz.x * sc);
        const unsigned h = static_cast<unsigned>(srcSz.y * sc);
        img.resize(sf::Vector2u(w, h));
        // 双线性插值：避免最邻近采样的锯齿/噪点
        for (unsigned y = 0; y < h; ++y) {
            for (unsigned x = 0; x < w; ++x) {
                const float sx = (x + 0.5f) / w * srcSz.x - 0.5f;
                const float sy = (y + 0.5f) / h * srcSz.y - 0.5f;
                const int x0 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, static_cast<int>(sx)));
                const int y0 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, static_cast<int>(sy)));
                const int x1 = std::max(0, std::min(static_cast<int>(srcSz.x) - 1, x0 + 1));
                const int y1 = std::max(0, std::min(static_cast<int>(srcSz.y) - 1, y0 + 1));
                const float fx = sx - x0;
                const float fy = sy - y0;
                const sf::Color c00 = src.getPixel(sf::Vector2u(x0, y0));
                const sf::Color c10 = src.getPixel(sf::Vector2u(x1, y0));
                const sf::Color c01 = src.getPixel(sf::Vector2u(x0, y1));
                const sf::Color c11 = src.getPixel(sf::Vector2u(x1, y1));
                const auto blend = [](float a, float b, float t) -> std::uint8_t {
                    return static_cast<std::uint8_t>(a + (b - a) * t);
                };
                img.setPixel(sf::Vector2u(x, y), sf::Color(
                    blend(blend(c00.r, c10.r, fx), blend(c01.r, c11.r, fx), fy),
                    blend(blend(c00.g, c10.g, fx), blend(c01.g, c11.g, fx), fy),
                    blend(blend(c00.b, c10.b, fx), blend(c01.b, c11.b, fx), fy),
                    blend(blend(c00.a, c10.a, fx), blend(c01.a, c11.a, fx), fy)
                ));
            }
        }
        resized = true;
    } else {
        img = src;
    }
    applyDisplayP3(img);
    // 缩放后写回配置目录（覆盖原图），下次启动直接加载小图
    // 只在「SFML 能写这个后缀」时才回写：saveToFile 是按扩展名选编码器的，
    // .gif 读得进、写不出。以前这里会静默失败（文件没缩小，下次启动再缩一遍）。
    if (resized && !ms::imgprobe::writableExt(std::filesystem::path(fullPath).extension().string())) {
        if (std::getenv("MS_VERBOSE"))
            std::fprintf(stderr, "[img] skip write-back (unwritable ext): %s\n", fullPath.c_str());
    } else if (resized) {
        if (!img.saveToFile(fullPath)) {
            // 写回失败不影响本次加载
        }
    }
    if (!bgTex_.loadFromImage(img)) return false;
    bgTex_.setSmooth(true);
    bgSprite_.setTexture(bgTex_, true);
    bgOk_ = true;
    return true;
}

// 用户选图：复制进配置目录（同名槽位旧图会被删除），配置里只记文件名
bool Renderer::setBackgroundImage(const std::string& path) {
    if (path.empty()) return false;
    // 先验后换（与 setMarkerImage 同理）：坏图在源文件处拒绝，旧背景原样保留
    if (!probeImageForImport(path)) return false;
    const std::string name = ms::importImage(path, "background");
    if (name.empty()) return false;
    if (!loadBackgroundFromFile(ms::settingsDir() + "/" + name)) return false;
    bgPath_ = name;
    saveSettings();
    return true;
}

void Renderer::resetBackground() {
    if (!bgPath_.empty()) ms::removeImage(bgPath_); // 删掉旧背景图片
    bgPath_.clear();
    bgOk_ = false;
    bgTried_ = false;
    loadBackground();
    saveSettings();
}

const sf::Font& Renderer::fontFor(const std::string& s) const {
    if (!fontCjkOk_) return font_;
    for (unsigned char c : s) {
        if (c >= 0x80) return fontCJK_; // 含多字节字符 -> 交给中文字体（否则会画成方框）
    }
    return font_;
}

float Renderer::textWidth(const std::string& s, float size, float bold) const {
    return textWidthOf(fontFor(s), s, size, bold);
}

void Renderer::settingsCommitMs() {
    if (settingsEdit_.empty()) return;
    const int v = std::atoi(settingsEdit_.c_str());
    settingsEdit_.clear();
    if (v >= kDoubleClickMinMs && v <= kDoubleClickMaxMs) setDoubleClickMs(v); // 非法则保持原值
}

// 星光两行的数值框：与毫秒框同一口径——非法（越界/空）就丢掉这次输入，保持原值。
void Renderer::settingsCommitStarDensity() {
    if (settingsEdit_.empty()) return;
    const float v = std::strtof(settingsEdit_.c_str(), nullptr);
    settingsEdit_.clear();
    if (v >= kStarDensityMin && v <= kStarDensityMax) setStarDensity(v);
}

void Renderer::settingsCommitStarScale() {
    if (settingsEdit_.empty()) return;
    const float v = std::strtof(settingsEdit_.c_str(), nullptr);
    settingsEdit_.clear();
    if (v >= kStarScaleMin && v <= kStarScaleMax) setStarScale(v); // setter 里收拢到一位小数
}

// 背景纯色框：只接受满 6 位的十六进制（满 6 位其实已经自动生效）。
// **空输入什么都不做** —— 「回到内置图片」走旁边的 DEFAULT 按钮，
// 否则「输完自动生效 → 输入被清空 → 离开时看到空值又把颜色抹了」会打架。
void Renderer::settingsCommitBg() {
    const std::string s = settingsEdit_;
    settingsEdit_.clear();
    if (s.size() != 6) return;
    const long v = std::strtol(s.c_str(), nullptr, 16);
    bgColorMode_ = true;
    bgSolid_ = sf::Color(static_cast<std::uint8_t>((v >> 16) & 0xFF),
                         static_cast<std::uint8_t>((v >> 8) & 0xFF),
                         static_cast<std::uint8_t>(v & 0xFF));
    bgPath_.clear();
    bgOk_ = false;
    bgTried_ = false;
}

// which: 1=双击时长(ms) 2=星光密度 3=星光大小。三条滑块共用「按 x 反算 frac」这一套。
void Renderer::settingsApplyTrack(int which, int x) {
    const sf::FloatRect tr = which == 2 ? settingsRects().starTrack
                             : which == 3 ? settingsRects().scaleTrack
                                          : settingsRects().dcTrack;
    float t = (static_cast<float>(x) - tr.position.x) / std::max(1.f, tr.size.x);
    if (t <= 0.02f) t = 0.f;   // 两端吸附，保证能取到精确的端点值
    if (t >= 0.98f) t = 1.f;
    t = std::clamp(t, 0.f, 1.f);
    if (which == 2) {
        const float span = kStarDensityMax - kStarDensityMin;
        setStarDensity(kStarDensityMin + std::lround(t * span * 100.f) / 100.f); // 两位小数步进
    } else if (which == 3) {
        const float span = kStarScaleMax - kStarScaleMin;
        setStarScale(kStarScaleMin + std::lround(t * span * 10.f) / 10.f); // 一位小数步进
    } else {
        int ms = kDoubleClickMinMs +
                 static_cast<int>(std::lround(t * (kDoubleClickMaxMs - kDoubleClickMinMs)));
        ms = (ms / 10) * 10; // 吸附到 10ms 步进
        setDoubleClickMs(ms);
    }
}

void Renderer::settingsPressTrack(sf::Vector2i px, int which) {
    settingsDrag_ = true;
    settingsDragWhich_ = which;
    settingsApplyTrack(which, px.x);
}

bool Renderer::settingsMove(sf::Vector2i px) {
    if (!settingsDrag_ || !settingsOpen_) return false;
    settingsApplyTrack(settingsDragWhich_, px.x);
    return true;
}

void Renderer::scrollSettings(float delta) {
    if (!settingsOpen_) return;
    if (settingsMaxS_ <= 0.f) { settingsScroll_ = 0.f; return; }
    settingsScroll_ = std::min(settingsMaxS_, std::max(0.f, settingsScroll_ - delta * 48.f));
}

bool Renderer::settingsHitScrollbar(sf::Vector2i px) const {
    if (!settingsGeoOk_) return false;
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    return settingsTrackR_.contains(p) || settingsThumbR_.contains(p);
}

void Renderer::settingsDragBegin(sf::Vector2i px) {
    if (!settingsGeoOk_) return;
    const float py = static_cast<float>(px.y);
    if (settingsThumbR_.contains(sf::Vector2f(static_cast<float>(px.x), py))) {
        settingsScrollDrag_ = true;
        settingsGrabOff_ = py - settingsThumbR_.position.y;
    } else if (settingsTrackR_.contains(sf::Vector2f(static_cast<float>(px.x), py))) {
        // 点击轨道：跳到该位置
        const float trackH = settingsTrackR_.size.y;
        const float thumbH = settingsThumbR_.size.y;
        const float rel = (py - settingsTrackR_.position.y) / trackH;
        settingsScroll_ = std::min(settingsMaxS_, std::max(0.f, rel * settingsTotalH_ - thumbH * 0.5f));
    }
}

void Renderer::settingsDragMove(sf::Vector2i px) {
    if (!settingsScrollDrag_ || !settingsGeoOk_) return;
    const float py = static_cast<float>(px.y);
    const float trackH = settingsTrackR_.size.y;
    const float thumbH = settingsThumbR_.size.y;
    const float rel = (py - settingsGrabOff_ - settingsTrackR_.position.y) / (trackH - thumbH);
    settingsScroll_ = std::min(settingsMaxS_, std::max(0.f, rel * settingsMaxS_));
}

void Renderer::setChordFailMode(ChordFailMode m) {
    chordFailMode_ = m;
    saveSettings();
}

void Renderer::setDoubleClickMs(int ms) {
    doubleClickMs_ = std::clamp(ms, kDoubleClickMinMs, kDoubleClickMaxMs);
    saveSettings();
}

void Renderer::setStarDensity(float v) {
    starDensity_ = std::clamp(std::round(v * 100.f) / 100.f, kStarDensityMin, kStarDensityMax);
    saveSettings();
}

// 密度 → 实际颗数：单位是「每 100×100 逻辑点多少颗」，用窗口逻辑绘制尺寸换算，不是物理像素。
int Renderer::starCountForDensity(float density) const {
    if (density <= 0.f) return 0;
    const double unitArea = static_cast<double>(starfx::kStarUnitPx) * starfx::kStarUnitPx;
    const double area = static_cast<double>(L_.winW) * static_cast<double>(L_.winH);
    const int n = static_cast<int>(std::lround(static_cast<double>(density) * area / unitArea));
    return std::clamp(n, 0, starfx::kStarPoolMax);
}

void Renderer::setStarScale(float v) {
    starScale_ = std::clamp(std::round(v * 10.f) / 10.f, kStarScaleMin, kStarScaleMax);
    saveSettings();
}

// 配置读写：全部落在「可执行文件同级 config/」目录（settings.ini + 图片）
void Renderer::markHelpSeen() {
    if (helpSeen_) return;
    helpSeen_ = true;
    saveSettings(); // 立刻落盘：就算用户这次不关面板直接退出，下次也不会再弹
}

void Renderer::saveSettings() const {
    ms::SettingsData d;
    d.cellR = cellR_;
    d.cellG = cellG_;
    d.cellB = cellB_;
    d.background = bgColorMode_ ? toHexColor(bgSolid_) : bgPath_; // 纯色存 '#RRGGBB'，图片存文件名
    d.chordFail = (chordFailMode_ == ChordFailMode::Silent) ? "silent"
                  : (chordFailMode_ == ChordFailMode::Boom) ? "boom"
                                                            : "hint";
    d.doubleClickMs = doubleClickMs_;
    d.hideCounts = hideCounts_;
    d.alwaysMagnitude = alwaysMagnitude_;
    d.ustcMode = ustcMode_;
    d.animFx = animFx_;
    d.helpSeen = helpSeen_;
    d.zeroTipSeen = zeroTipSeen_;
    d.starDensity = starDensity_;
    d.starScale = starScale_;
    for (int i = 1; i <= 4; ++i) {
        if (!markerImage_[i].empty()) {
            d.marker[i].kind = "image";
            d.marker[i].value = markerImage_[i];
        } else if (!markerChar_[i].empty()) {
            d.marker[i].kind = "char";
            d.marker[i].value = markerChar_[i];
        }
    }
    if (!blankImage_.empty()) {
        d.blank.kind = "image";
        d.blank.value = blankImage_;
    } else if (!blankChar_.empty()) {
        d.blank.kind = "char";
        d.blank.value = blankChar_;
    }
    ms::saveSettingsFile(d);
}

void Renderer::loadSettings() {
    ms::SettingsData d;
    if (!ms::loadSettingsFile(d)) {
        helpSeen_ = false; // 连配置文件都没有 = 真·第一次玩：允许自动弹玩法介绍
        zeroTipSeen_ = false; // 同理：允许黄 0 首现教学
        return;
    }
    cellR_ = static_cast<std::uint8_t>(d.cellR);
    cellG_ = static_cast<std::uint8_t>(d.cellG);
    cellB_ = static_cast<std::uint8_t>(d.cellB);
    chordFailMode_ = (d.chordFail == "silent") ? ChordFailMode::Silent
                     : (d.chordFail == "boom") ? ChordFailMode::Boom
                                               : ChordFailMode::Hint;
    doubleClickMs_ = std::clamp(d.doubleClickMs, kDoubleClickMinMs, kDoubleClickMaxMs);
    hideCounts_ = d.hideCounts;
    alwaysMagnitude_ = d.alwaysMagnitude;
    ustcMode_ = d.ustcMode;
    animFx_ = d.animFx;
    helpSeen_ = d.helpSeen; // ini 里没这行时 d.helpSeen 默认 true（升级用户不弹）
    zeroTipSeen_ = d.zeroTipSeen; // 同上：ini 里没这行时默认 true（老玩家不再打扰）
    starDensity_ = std::clamp(d.starDensity, kStarDensityMin, kStarDensityMax);
    starScale_ = std::clamp(d.starScale, kStarScaleMin, kStarScaleMax);
    bgColorMode_ = false;
    if (!d.background.empty()) {
        // 纯色判据必须与写入端（SettingsIO 的 '#RRGGBB'）同一条：只看首字符会让
        // 「#abc.png」这类以 # 开头的图片文件名被 strtol 吃掉，背景静默变纯色。
        const bool bgIsHexColor = d.background.size() == 7 && d.background[0] == '#' &&
                                  d.background.find_first_not_of("0123456789abcdefABCDEF", 1) == std::string::npos;
        if (bgIsHexColor) {
            const long v = std::strtol(d.background.c_str() + 1, nullptr, 16);
            bgSolid_ = sf::Color(static_cast<std::uint8_t>((v >> 16) & 0xFF),
                                 static_cast<std::uint8_t>((v >> 8) & 0xFF),
                                 static_cast<std::uint8_t>(v & 0xFF));
            bgColorMode_ = true;
            bgPath_.clear();
        } else if (loadBackgroundFromFile(ms::settingsDir() + "/" + d.background)) {
            bgPath_ = d.background;
        }
    }
    for (int i = 1; i <= 4; ++i) {
        if (d.marker[i].kind == "image" && !d.marker[i].value.empty()) {
            if (loadMarkerImageFromFile(i, ms::settingsDir() + "/" + d.marker[i].value)) {
                markerImage_[i] = d.marker[i].value;
            }
        } else if (d.marker[i].kind == "char" && d.marker[i].value.size() == 1) {
            markerChar_[i] = d.marker[i].value;
        }
    }
    if (d.blank.kind == "image" && !d.blank.value.empty()) {
        if (loadBlankImageFromFile(ms::settingsDir() + "/" + d.blank.value)) {
            blankImage_ = d.blank.value;
        }
    } else if (d.blank.kind == "char" && d.blank.value.size() == 1) {
        blankChar_ = d.blank.value;
    }
}

// 还原所有默认：清掉配置目录里的图片（不留孤儿），并重置背景/图标/格子颜色
void Renderer::resetAllSettings() {
    ms::clearAllImages();
    bgPath_.clear();
    bgColorMode_ = false;
    bgOk_ = false;
    bgTried_ = false;
    loadBackground();
    for (int i = 1; i <= 4; ++i) {
        markerChar_[i].clear();
        markerImage_[i].clear();
        markerTexOk_[i] = false;
    }
    blankChar_.clear();
    blankImage_.clear();
    blankTexOk_ = false;
    cellR_ = 102;
    cellG_ = 204;
    cellB_ = 255;
    chordFailMode_ = ChordFailMode::Hint; // 双击开格失败：默认提示
    doubleClickMs_ = 400;                // 双击判定时长：默认 400ms
    hideCounts_ = false;                 // 轴计数默认显示
    alwaysMagnitude_ = false;            // 默认：纯实/纯虚带符号显示（不全走模长）
    ustcMode_ = false;                   // 彩蛋默认关
    animFx_ = true;                      // 动效总开关默认开
    starDensity_ = kStarDensityDefault;  // 星光密度默认 2.17 颗/100×100px；0 = 关
    starScale_ = 1.7f;                   // 星光大小默认 1.7x
    bgAlpha_ = 140;                      // 背景不透明度默认 ≈55%（与成员初值 Renderer.h、网页端 defaultSettings 同值）
    saveSettings();
}

std::string Renderer::settingsFolder() const {
    return ms::settingsDir();
}

// —— 彩蛋相关：中文字体 / 中文文本 / 复选框几何 ——

void Renderer::loadCjkFont() {
    if (fontCjkOk_) return;
    const std::vector<std::string> candidates = {
        "/System/Library/Fonts/Hiragino Sans GB.ttc",          // macOS
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "C:/Windows/Fonts/msyh.ttc",                           // Windows
        "C:/Windows/Fonts/simhei.ttf",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", // Linux
        "/usr/share/fonts/truetype/arphic/uming.ttc",
    };
    for (const auto& path : candidates) {
        if (fontCJK_.openFromFile(path) && fontCJK_.hasGlyph(0x7ea2)) { // "红"
            fontCjkOk_ = true;
            if (std::getenv("MS_VERBOSE") != nullptr) std::printf("[font] CJK: %s", path.c_str()); // 默认静默
            std::puts("");
            // 禁用字体纹理的线性过滤
            for (unsigned size = 8; size <= 48; ++size) {
                const_cast<sf::Texture&>(fontCJK_.getTexture(size)).setSmooth(false);
            }
            return;
        }
    }
    fontCjkOk_ = false; // 退而求其次：用主字体（中文将无法显示，但界面不会崩）
}

Renderer::UstcRects Renderer::ustcRects() const {
    UstcRects r;
    // 标签与下一个复选框之间必须留固定间隙：textWidthOf 量的是墨迹宽（getLocalBounds），
    // 比排版 advance 略窄，零间距排布会让"总是显示模长"末字被后一个框压住。
    constexpr float kLabelGap = 12.f;
    const std::string label = "红专并进 理实交融";
    const float boxSz = 16.f;
    const float labelW = fontCjkOk_ ? textWidthOf(fontCJK_, label, 12.f, 0.f) : 100.f;
    const float rightEdge = L_.winW - 18.f;
    r.box = sf::FloatRect(sf::Vector2f(rightEdge - labelW - 6.f - boxSz, L_.headerH - 29.f),
                          sf::Vector2f(boxSz, boxSz));
    r.label = sf::FloatRect(sf::Vector2f(r.box.position.x + boxSz + 6.f, L_.headerH - 31.f),
                            sf::Vector2f(labelW, 20.f));
    // 新增：紧挨其左侧的"隐藏计数"复选框
    const std::string hlabel = "隐藏计数";
    const float hlabelW = fontCjkOk_ ? textWidthOf(fontCJK_, hlabel, 12.f, 0.f) : 60.f;
    r.hideBox = sf::FloatRect(sf::Vector2f(r.box.position.x - kLabelGap - 22.f - hlabelW, L_.headerH - 29.f),
                              sf::Vector2f(boxSz, boxSz));
    r.hideLabel = sf::FloatRect(sf::Vector2f(r.hideBox.position.x + boxSz + 6.f, L_.headerH - 31.f),
                                sf::Vector2f(hlabelW, 20.f));
    // 再往左：紧挨着"隐藏计数"的"总是显示模长"复选框
    const std::string mlabel = "总是显示模长";
    const float mlabelW = fontCjkOk_ ? textWidthOf(fontCJK_, mlabel, 12.f, 0.f) : 90.f;
    r.magBox = sf::FloatRect(sf::Vector2f(r.hideBox.position.x - kLabelGap - 22.f - mlabelW, L_.headerH - 29.f),
                             sf::Vector2f(boxSz, boxSz));
    r.magLabel = sf::FloatRect(sf::Vector2f(r.magBox.position.x + boxSz + 6.f, L_.headerH - 31.f),
                               sf::Vector2f(mlabelW, 20.f));
    return r;
}

void Renderer::drawHeader(const Board& board, const Hud& hud, sf::RenderTarget& t) {
    // 第一行：标题 + 按钮
    t.draw(textTLSpr("Complex Minesweeper", 21.f, kInk, 18.f, 10.f, 0.6f));
    {
        // 标题右侧 ? 图标：与难度按钮同风格（白底描边圆 + 问号）
        const sf::Vector2f c = L_.helpBtn.position + L_.helpBtn.size * 0.5f;
        sf::CircleShape q(13.f);
        q.setOrigin(sf::Vector2f(13.f, 13.f));
        q.setPosition(c);
        q.setFillColor(kBtnBg);
        q.setOutlineColor(kBtnEdge);
        q.setOutlineThickness(1.5f);
        t.draw(q);
        t.draw(textSpr("?", 14.f, kInk, c.x, c.y + 0.5f, 0.4f));
    }

    const auto drawBtn = [&](const sf::FloatRect& rect, const std::string& label, bool active) {
        sf::RectangleShape b(rect.size);
        b.setPosition(rect.position);
        b.setFillColor(active ? kBtnActive : kBtnBg);
        b.setOutlineColor(active ? kBtnActive : kBtnEdge);
        b.setOutlineThickness(1.5f);
        t.draw(b);
        const sf::Vector2f c = rect.position + rect.size * 0.5f;
        t.draw(textSpr(label, 13.f, active ? sf::Color::White : kInk, c.x, c.y + 0.5f, 0.5f));
    };
    drawBtn(L_.easyBtn, "9x9", activeDiff_ == 0);
    drawBtn(L_.mediumBtn, "16x16", activeDiff_ == 1);
    drawBtn(L_.hardBtn, "24x16", activeDiff_ == 2);
    drawBtn(L_.customBtn, "CUSTOM", false);
    drawBtn(L_.seedBtn, "SEED", false);
    if (playAgainVisible_)
        drawBtn(L_.playAgainBtn, "PLAY AGAIN", true); // 高亮主操作：蓝底白字，与胜败横幅呼应
    // 齿轮设置按钮（经典齿轮：外圈 + 8 个齿 + 内孔）
    {
        const sf::FloatRect& sb = L_.settingsBtn;
        sf::RectangleShape box(sb.size);
        box.setPosition(sb.position);
        box.setFillColor(kBtnBg);
        box.setOutlineColor(kBtnEdge);
        box.setOutlineThickness(1.4f);
        t.draw(box);
        const sf::Vector2f gc = L_.gearCenter;
        const float rOuter = 8.5f, rInner = 3.2f;
        for (int i = 0; i < 8; ++i) {
            const float ang = static_cast<float>(i) * 3.14159265f / 4.f;
            sf::RectangleShape tooth(sf::Vector2f(3.2f, 4.6f));
            tooth.setOrigin(sf::Vector2f(1.6f, rOuter + 1.2f));
            tooth.setPosition(gc);
            tooth.setRotation(sf::degrees(ang * 180.f / 3.14159265f));
            tooth.setFillColor(kInk);
            t.draw(tooth);
        }
        sf::CircleShape cog(rOuter, 24);
        cog.setOrigin(sf::Vector2f(rOuter, rOuter));
        cog.setPosition(gc);
        cog.setFillColor(kInk);
        t.draw(cog);
        sf::CircleShape hole(rInner, 18);
        hole.setOrigin(sf::Vector2f(rInner, rInner));
        hole.setPosition(gc);
        hole.setFillColor(kBtnBg);
        t.draw(hole);
    }

    // 统计行：行列 / 雷数 / 已翻开 / 已标记 + 两条进度条 + 彩蛋复选框
    {
        const int cells = board.cols() * board.rows();
        int openedSafe = 0, flagged = 0;
        for (int r = 0; r < board.rows(); ++r)
            for (int c = 0; c < board.cols(); ++c) {
                if (board.at(r, c).opened && board.at(r, c).mine == MineType::None) ++openedSafe;
                if (board.at(r, c).flag != MineType::None && board.at(r, c).mine != MineType::None) ++flagged;
            }
        const int safeTotal = std::max(1, cells - board.mineCount());
        const int mineTotal = std::max(1, board.mineCount());
        const auto pct = [](int v, int total) {
            std::ostringstream ss;
            ss << std::fixed << std::setprecision(1) << std::min(100.0, 100.0 * v / total); // 多标封顶 100%（原始计数不骗人，百分比不溢出）
            return ss.str() + "%";
        };
        const float sy = L_.headerH - 27.f;
        float sx = 18.f;
        const auto seg = [&](const std::string& text, float gap) {
            const float start = sx;
            t.draw(textTLSpr(text, 12.f, kInk, sx, sy));
            sx = start + textWidth(text, 12.f, 0.f) + gap;
            return start;
        };
        seg(std::to_string(board.cols()) + " x " + std::to_string(board.rows()), 16.f);
        // 右侧是一整排右对齐复选框（彩蛋/隐藏计数/总是显示模长），文字不得压进最左侧那个之下；
        // 空间不够时逐级降级：去 mines 段 -> 去百分号 -> 去 flagged 段 -> 去 opened 段。
        const float statLimit = ustcRects().magBox.position.x - 12.f;
        const float gap = 16.f;
        const auto tw = [&](const std::string& s) { return textWidth(s, 12.f, 0.f); };
        const std::string minesSeg = "mines " + std::to_string(board.mineCount());
        const auto mkSegs = [&](const char* name, int v, int total) {
            const std::string shortS = std::string(name) + " " + std::to_string(v) + "/" + std::to_string(total);
            return std::pair{shortS, shortS + " (" + pct(v, total) + ")"};
        };
        const auto openedSegs = mkSegs("opened", openedSafe, safeTotal);
        const auto flaggedSegs = mkSegs("flagged", flagged, mineTotal);
        bool showMines = L_.winW >= 690.f, showOpened = true, showFlagged = true;
        bool pctOpened = true, pctFlagged = true;
        for (;;) {
            float need = 0.f;
            if (showMines) need += tw(minesSeg) + gap;
            if (showOpened) need += tw(pctOpened ? openedSegs.second : openedSegs.first) + gap;
            if (showFlagged) need += tw(pctFlagged ? flaggedSegs.second : flaggedSegs.first) + gap;
            if (sx + need <= statLimit) break;
            if (showMines) { showMines = false; continue; }
            if (pctFlagged) { pctFlagged = false; continue; }
            if (pctOpened) { pctOpened = false; continue; }
            if (showFlagged) { showFlagged = false; continue; }
            if (showOpened) { showOpened = false; continue; }
            break;
        }
        if (showMines) seg(minesSeg, gap);
        float openedX = sx; // 段被隐藏时的兜底锚点（进度条顺位接着排，见下）
        if (showOpened) openedX = seg(pctOpened ? openedSegs.second : openedSegs.first, gap);
        if (showFlagged) (void)seg(pctFlagged ? flaggedSegs.second : flaggedSegs.first, gap);
        // 进度条：#66ccff 边框 + 浅绿填充
        const auto bar = [&](float x, int value, int total, float width) {
            const float by = L_.headerH - 11.f;
            sf::RectangleShape track(sf::Vector2f(width, 8.f));
            track.setPosition(sf::Vector2f(x, by));
            track.setFillColor(kBtnBg);
            track.setOutlineColor(kBtnEdge); // 与按钮同族（原先用 kCovered #66CCFF）
            track.setOutlineThickness(1.6f);
            t.draw(track);
            const float frac = std::clamp(total > 0 ? static_cast<float>(value) / total : 0.f, 0.f, 1.f);
            if (frac > 0.f) {
                sf::RectangleShape fill(sf::Vector2f(std::max(1.f, (width - 3.2f) * frac), 8.f - 3.2f));
                fill.setPosition(sf::Vector2f(x + 1.6f, by + 1.6f));
                fill.setFillColor(kBarFill);
                t.draw(fill);
            }
        };
        // 进度条恒显示（文字被降级时仍是进度信息）：从标签锚点起顺位排布、按窗口右缘截断
        float bx = showOpened ? openedX : sx;
        float bw = std::min(150.f, L_.winW - 18.f - bx);
        if (bw >= 12.f) {
            bar(bx, openedSafe, safeTotal, bw);
            bx += bw + 8.f;
        }
        bw = std::min(110.f, L_.winW - 18.f - bx);
        if (bw >= 12.f) bar(bx, flagged, mineTotal, bw);

        // 彩蛋复选框（统计行右端，整体右对齐）
        const UstcRects ur = ustcRects();
        sf::RectangleShape box(ur.box.size);
        box.setPosition(ur.box.position);
        box.setFillColor(kBtnBg);
        // 描边曾用 kCovered(#66CCFF)：亮青在顶栏半透明、底下是明亮天空时几乎融掉，
        // 只剩一个白方块。改 kBtnEdge 后与难度按钮同族，亮背景下也能看出这是可点的框。
        box.setOutlineColor(kBtnEdge);
        box.setOutlineThickness(1.6f);
        t.draw(box);
        if (ustcMode_) { // 打勾（用两段粗线，避免依赖 sf::Vertex 的构造形式）
            const sf::Vector2f b = ur.box.position;
            drawThickLine(t, sf::Vector2f(b.x + 3.5f, b.y + 8.5f), sf::Vector2f(b.x + 6.8f, b.y + 12.f), 2.f,
                          kImagMine);
            drawThickLine(t, sf::Vector2f(b.x + 6.8f, b.y + 12.f), sf::Vector2f(b.x + 12.5f, b.y + 4.f), 2.f,
                          kImagMine);
        }
        t.draw(textCJKSpr("红专并进 理实交融", 12.f, kInk, ur.label.position.x, ur.label.position.y));

        // 总是显示模长复选框（同一行，在"隐藏计数"左侧）
        sf::RectangleShape mbox(ur.magBox.size);
        mbox.setPosition(ur.magBox.position);
        mbox.setFillColor(kBtnBg);
        mbox.setOutlineColor(kBtnEdge);
        mbox.setOutlineThickness(1.6f);
        t.draw(mbox);
        if (alwaysMagnitude_) {
            const sf::Vector2f b = ur.magBox.position;
            drawThickLine(t, sf::Vector2f(b.x + 3.5f, b.y + 8.5f), sf::Vector2f(b.x + 6.8f, b.y + 12.f), 2.f,
                          kImagMine);
            drawThickLine(t, sf::Vector2f(b.x + 6.8f, b.y + 12.f), sf::Vector2f(b.x + 12.5f, b.y + 4.f), 2.f,
                          kImagMine);
        }
        t.draw(textCJKSpr("总是显示模长", 12.f, kInk, ur.magLabel.position.x, ur.magLabel.position.y));

        // 隐藏计数复选框（同一行，紧挨左侧）
        sf::RectangleShape hbox(ur.hideBox.size);
        hbox.setPosition(ur.hideBox.position);
        hbox.setFillColor(kBtnBg);
        hbox.setOutlineColor(kBtnEdge);
        hbox.setOutlineThickness(1.6f);
        t.draw(hbox);
        if (hideCounts_) {
            const sf::Vector2f b = ur.hideBox.position;
            drawThickLine(t, sf::Vector2f(b.x + 3.5f, b.y + 8.5f), sf::Vector2f(b.x + 6.8f, b.y + 12.f), 2.f,
                          kImagMine);
            drawThickLine(t, sf::Vector2f(b.x + 6.8f, b.y + 12.f), sf::Vector2f(b.x + 12.5f, b.y + 4.f), 2.f,
                          kImagMine);
        }
        t.draw(textCJKSpr("隐藏计数", 12.f, kInk, ur.hideLabel.position.x, ur.hideLabel.position.y));
    }

    // 背景不透明度滑条（主界面直调，上限 75%）
    // 纯色背景时整行不画：不透明度只作用于图片，纯色下拖它没有任何反馈。
    // **只隐藏不重排** —— 收起空间要动行位与右对齐逻辑，收益不值那个风险。
    if (!bgColorMode_) {
        const std::string opLabel = "OPACITY";
        const float opW = textWidth(opLabel, 11.f, 0.f);
        t.draw(textTLSpr(opLabel, 11.f, kInkSoft, L_.bgValue.position.x - 8.f - opW,
                      L_.bgTrack.position.y - 3.f));
        sf::RectangleShape track(L_.bgTrack.size);
        track.setPosition(L_.bgTrack.position);
        track.setFillColor(kPanel);
        t.draw(track);
        const float bgFrac = static_cast<float>(bgAlpha_) / static_cast<float>(kBgAlphaMax);
        sf::RectangleShape bgFill(sf::Vector2f(L_.bgTrack.size.x * bgFrac, L_.bgTrack.size.y));
        bgFill.setPosition(L_.bgTrack.position);
        bgFill.setFillColor(kBtnActive);
        t.draw(bgFill);
        sf::CircleShape bgKnob(7.f, 20);
        bgKnob.setOrigin(sf::Vector2f(7.f, 7.f));
        bgKnob.setPosition(sf::Vector2f(L_.bgTrack.position.x + L_.bgTrack.size.x * bgFrac,
                                        L_.bgTrack.position.y + L_.bgTrack.size.y * 0.5f));
        bgKnob.setFillColor(kBtnBg);
        bgKnob.setOutlineColor(kBtnActive);
        bgKnob.setOutlineThickness(2.f);
        t.draw(bgKnob);
        if (setupFocus_ == 4) { // 正在输入百分比
            sf::RectangleShape hl(L_.bgValue.size);
            hl.setPosition(L_.bgValue.position);
            hl.setFillColor(kHover);
            hl.setOutlineColor(kBtnActive);
            hl.setOutlineThickness(1.6f);
            t.draw(hl);
            const std::string shown = (setupEdit_.empty() ? std::string("_") : setupEdit_) + "%";
            t.draw(textSpr(shown, 12.f, kInk, L_.bgValue.position.x + L_.bgValue.size.x * 0.5f,
                        L_.bgValue.position.y + L_.bgValue.size.y * 0.5f + 1.f, 0.5f));
        } else {
            t.draw(textSpr(std::to_string(std::lround(bgAlpha_ / 2.55f)) + "%", 12.f, kBtnActive,
                        L_.bgValue.position.x + L_.bgValue.size.x * 0.5f,
                        L_.bgValue.position.y + L_.bgValue.size.y * 0.5f + 1.f, 0.4f));
        }
    }

    // 重开按钮：圆环箭头
    const sf::Vector2f rc = L_.restartBtn.position + L_.restartBtn.size * 0.5f;
    sf::RectangleShape bg(L_.restartBtn.size);
    bg.setPosition(L_.restartBtn.position);
    bg.setFillColor(kBtnBg);
    bg.setOutlineColor(kBtnEdge);
    bg.setOutlineThickness(1.5f);
    t.draw(bg);
    const float a0 = -55.f * kPi / 180.f;
    drawArc(t, rc, 9.f, a0, 215.f * kPi / 180.f, 2.2f, kInk);
    const sf::Vector2f e = rc + sf::Vector2f(9.f * std::cos(a0), 9.f * std::sin(a0));
    const sf::Vector2f tang(std::cos(a0 + kPi * 0.5f), std::sin(a0 + kPi * 0.5f));
    const sf::Vector2f nrm(std::cos(a0), std::sin(a0));
    sf::ConvexShape head(3);
    head.setPoint(0, e + tang * 6.f);
    head.setPoint(1, e - tang * 2.f + nrm * 4.5f);
    head.setPoint(2, e - tang * 2.f - nrm * 4.5f);
    head.setFillColor(kInk);
    t.draw(head);

    // 第二行：计数器 + 图例
    const float pillY = 54.f;
    // rightAlign = 数值贴着药丸右内侧，位数变多时向左生长（右边缘不动）
    const auto drawPill = [&](float x, float w, const std::string& label, const std::string& value,
                              bool rightAlign = false, bool dim = false, bool flip = false,
                              bool red = false) {
        sf::RectangleShape pill(sf::Vector2f(w, 28.f));
        pill.setPosition(sf::Vector2f(x, pillY));
        pill.setFillColor(kBtnBg);
        pill.setOutlineColor(kBtnEdge);
        pill.setOutlineThickness(1.5f);
        t.draw(pill);
        t.draw(textTLSpr(label, 9.5f, kInkSoft, x + 12.f, pillY + 4.f));
        float vx = x + 12.f;
        if (rightAlign) vx = x + w - 12.f - textWidth(value, 15.f, 0.5f);
        // 翻牌：旧值上滑淡出、新值从下滑入（±20px + easeInOut），裁剪到药丸内壁 —— 与网页端
        // drawPill 的 flip 同式；用视图裁剪（SFML 没有 canvas clip），画完立即还原。
        if (flip && animFx_ && counterFlipActive_ && animNow() - counterFlip_.at < kAnimMs.counterFlip) {
            const float e = ms::anim::easeInOut(static_cast<float>(
                std::clamp((animNow() - counterFlip_.at) / kAnimMs.counterFlip, 0.0, 1.0)));
            const sf::FloatRect clip(sf::Vector2f(x + 2.f, pillY + 2.f), sf::Vector2f(w - 4.f, 24.f));
            const sf::Vector2u tsz = t.getSize();
            sf::View v(clip);
            v.setViewport(sf::FloatRect(sf::Vector2f(clip.position.x / tsz.x, clip.position.y / tsz.y),
                                        sf::Vector2f(clip.size.x / tsz.x, clip.size.y / tsz.y)));
            const sf::View saved = t.getView();
            t.setView(v);
            t.draw(textTLSpr(fmt3(counterFlip_.from), 15.f, withAlpha(kInk, 1.f - e), vx, pillY + 13.f - e * 20.f, 0.5f));
            t.draw(textTLSpr(value, 15.f, withAlpha(red ? kBadMark : kInk, e), vx, pillY + 13.f + (1.f - e) * 20.f, 0.5f));
            t.setView(saved);
            return;
        }
        t.draw(textTLSpr(value, 15.f, red ? kBadMark : (dim ? kInkSoft : kInk), vx, pillY + 13.f, 0.5f));
    };

    drawPill(18.f, 116.f, "MINES LEFT", fmt3(hud.remaining), false, false, true,
             hud.remaining < 0); // 多插旗为负，红色提醒（2026-10-29 用户裁决）
    // 计时：不封顶、不补零（12 秒就是 12s），数字右对齐
    // 计时显示到 0.1 秒（如 12.3s）
    std::ostringstream timeOs;
    timeOs << std::fixed << std::setprecision(1) << hud.seconds;
    drawPill(142.f, 92.f, hud.paused ? "TIME PAUSED" : "TIME", timeOs.str() + "s", true,
             hud.paused); // 失焦/面板打开暂停时标签提示并降低数值对比度

    // 实/虚两轴未被可判胜标记覆盖的剩余数（与判胜同口径，取反不变；布雷前 x?，归零变灰）
    const auto rem = board.axisUnflagged();

    // 计数变动 -> 黄色高亮闪一下（约 1.1s 渐隐）
    const float dt = chipClock_.restart().asSeconds();
    if (alwaysMagnitude()) {
        // 模长模式：两轴芯片合并为一个总剩余芯片，复用 ax=1 槽跟踪 uncoveredMines() 的变动
        const int remTotal = board.uncoveredMines(); // 标在雷上才算，标错位置不占数
        chipFlash_[1] = std::max(0.f, chipFlash_[1] - dt / 1.1f);
        if (board.started()) {
            if (chipHadValue_ && remTotal != lastChip_[1]) chipFlash_[1] = 1.f;
            lastChip_[1] = remTotal;
        } else {
            lastChip_[1] = remTotal;
            chipFlash_[1] = 0.f;
        }
    } else {
        for (int ax = 1; ax <= 2; ++ax) {
            chipFlash_[ax] = std::max(0.f, chipFlash_[ax] - dt / 1.1f);
            if (!board.started()) {
                lastChip_[ax] = rem[ax];
                chipFlash_[ax] = 0.f;
                continue;
            }
            if (chipHadValue_ && rem[ax] != lastChip_[ax]) chipFlash_[ax] = 1.f;
            lastChip_[ax] = rem[ax];
        }
    }
    chipHadValue_ = board.started();

    const auto mixColor = [](const sf::Color& a, const sf::Color& b, float k) {
        const auto lp = [k](std::uint8_t x, std::uint8_t y) {
            return static_cast<std::uint8_t>(static_cast<float>(x) +
                                             (static_cast<float>(y) - static_cast<float>(x)) * k);
        };
        return sf::Color(lp(a.r, b.r), lp(a.g, b.g), lp(a.b, b.b), lp(a.a, b.a));
    };

    // 芯片：默认 ±1/±i 两轴；模长模式合并为一个总剩余芯片（中性色、圆点文字 "m"，不泄露虚实信息）
    struct ChipSpec { const char* sw; sf::Color col; int left; bool grayZero; };
    std::vector<ChipSpec> chips;
    if (alwaysMagnitude()) {
        chips.push_back({"m", kInk, board.uncoveredMines(), false}); // 只数未被覆盖的雷：随便标不减
    } else {
        chips.push_back({"±1", kRealMine, rem[1], true});
        chips.push_back({"±i", kImagMine, rem[2], true});
    }
    float chipX = 244.f;
    // 与网页端 renderer.ts 同一条规则：row2 放得下就收紧步长（单颗下限 62 =
    // 圆+计数文字的实际墨迹宽）把芯片留在原行，放不下才允许挤占图例行。
    // 桌面端按钮右锚窗口边缘，row2 空间恒够，此式在这里恒得 84、无视觉变化；
    // 写进来是为了两端的降级判定同源，日后不再各漂一边。
    const float row2BtnLeft = std::min(L_.customBtn.position.x, L_.seedBtn.position.x) - 10.f;
    const float room2 = row2BtnLeft - chipX;
    constexpr float kChipMin = 62.f;
    const float chipStep = room2 >= chips.size() * kChipMin
        ? std::min(84.f, std::floor(room2 / static_cast<float>(chips.size())))
        : 84.f;
    // 终局让位：剩余雷芯片此时已无信息量（胜=全 0，败=全盘已揭晓），隐藏后第二行左簇右界=TIME 药丸 234，
    // 与 PLAY AGAIN（最窄窗口下 [288,406]）留出 54px 间隙；进行中行为不变。
    for (int ci = 0; !hideCounts_ && hud.phase == Phase::Playing && ci < static_cast<int>(chips.size()); ++ci) { // 勾选"隐藏计数"后整块不画
        const auto& ch = chips[ci];
        const float fl = std::min(1.f, std::max(0.f, chipFlash_[ci + 1]));
        const bool done = ch.grayZero && board.started() && ch.left == 0; // 模长模式归零不变灰（中性色）
        const sf::Color baseCol = !board.started() ? kInkSoft : done ? kZeroHint : ch.col;
        const sf::Color fill = mixColor(displayColor(255, 255, 255, 235), displayColor(255, 214, 10, 250), fl);
        const sf::Color edge = mixColor(baseCol, displayColor(255, 176, 0), fl);
        const sf::Color textCol = mixColor(baseCol, displayColor(84, 62, 0), fl);
        const float r = 11.f + 1.6f * fl;
        const float cx = chipX + 11.f;
        const float cy = pillY + 14.f;
        sf::CircleShape dot(r, 24);
        dot.setOrigin(sf::Vector2f(r, r));
        dot.setPosition(sf::Vector2f(cx, cy));
        dot.setFillColor(fill);
        dot.setOutlineColor(edge);
        dot.setOutlineThickness(2.f);
        t.draw(dot);
        t.draw(textSpr(ch.sw, 10.f, textCol, cx, cy + 0.5f, 0.3f));
        const std::string val = board.started() ? ("x" + std::to_string(ch.left)) : std::string("x?");
        t.draw(textTLSpr(val, 13.f, textCol, chipX + 27.f, pillY + 6.f, 0.5f));
        chipX += chipStep;
    }

    // 第三行：颜色含义图例
    if (fontOk_) {
        struct LegendItem { const char* sw; sf::Color col; const char* desc; };
        std::vector<LegendItem> legend = {
            {"+1", kRealHint, " real sum"},
            {"+i", kImagHint, " imag sum"},
            {"n", kMixHint, " mixed |sum|"},
            {"0", kZeroHint, " canceled"},
        };
        if (alwaysMagnitude()) {
            // 模长模式：两轴雷条目替换为一个总剩余条目（颜色规则本身没变）
            legend.push_back({"m", kInk, " mines left |mod| mode"});
        } else {
            legend.push_back({"±1", kRealMine, " real mine"});
            legend.push_back({"±i", kImagMine, " imag mine"});
        }
        const float ly = 92.f;
        // 同排右界（v64 铁律）：右侧复选簇不被压；窄棋盘按"信息量低→高"逐级丢图例段
        const float maxW = ustcRects().magBox.position.x - 12.f - 18.f;
        const auto segFull = [&](const LegendItem& it) {
            return std::round(textWidth(it.sw, 11.f, 0.f)) + 4.f + std::round(textWidth(it.desc, 11.f, 0.f)) + 12.f;
        };
        const auto segIcon = [&](const LegendItem& it) {
            return std::round(textWidth(it.sw, 11.f, 0.f)) + 14.f;
        };
        // 空间不足时先整体降级为「只画色块符号」，仍放不下才开始删项：
        // 六个图标携带的信息远多于两段完整文字，删项是最后手段而非第一手段。
        float fullTotal = 0.f, iconTotal = 0.f;
        for (const auto& it : legend) { fullTotal += segFull(it); iconTotal += segIcon(it); }
        const bool iconOnly = fullTotal > maxW;
        const auto segW = [&](const LegendItem& it) { return iconOnly ? segIcon(it) : segFull(it); };
        float total = iconOnly ? iconTotal : fullTotal;
        // 与网页端 renderer.ts 同一份省略顺序，且**必须能删到 0 项**，否则图例会压到复选簇上
        const std::vector<int> dropOrder = alwaysMagnitude() ? std::vector<int>{3, 2, 4, 0, 1}
                                                            : std::vector<int>{3, 2, 5, 4, 0, 1};
        std::vector<char> hide(legend.size(), 0);
        for (int di : dropOrder) {
            if (total <= maxW || di >= (int)legend.size()) continue;
            hide[di] = 1; total -= segW(legend[di]);
        }
        float x = 18.f;
        for (size_t i = 0; i < legend.size(); ++i) {
            if (hide[i]) continue;
            const LegendItem& it = legend[i];
            t.draw(textTLSpr(it.sw, 11.f, it.col, x, ly));
            x += std::round(textWidth(it.sw, 11.f, 0.f)) + (iconOnly ? 14.f : 4.f);
            if (iconOnly) continue;
            t.draw(textTLSpr(it.desc, 11.f, kInkSoft, x, ly));
            x += std::round(textWidth(it.desc, 11.f, 0.f)) + 12.f;
        }
    }
}

// 打开菜单：固定五项 +1 -1 +i -i clear，无论该格当前标记是什么都全部显示
// （用户指定，覆盖旧设计"隐藏当前状态"；顺序恒为 +1 -1 +i -i clear）
void Renderer::openMenu(const Board& board, std::pair<int, int> cell, sf::Vector2i clickPx) {
    if (board.gameOver() || !board.inBounds(cell.first, cell.second)) { closeMenu(); return; }
    const Cell& c = board.at(cell.first, cell.second);
    if (c.opened) { closeMenu(); return; }

    menuOptions_.clear();
    for (int t = 1; t <= 4; ++t) menuOptions_.push_back(static_cast<MineType>(t)); // +1 -1 +i -i
    menuOptions_.push_back(MineType::None); // clear
    menuCell_ = cell;

    const float w = kMenuW;
    const float h = kMenuItemH * static_cast<float>(menuOptions_.size());
    float x = static_cast<float>(clickPx.x) + 4.f;
    float y = static_cast<float>(clickPx.y) + 4.f;
    if (x + w > L_.winW - 4.f) x = L_.winW - w - 4.f;
    if (y + h > L_.winH - 4.f) y = L_.winH - h - 4.f;
    if (x < 4.f) x = 4.f;
    if (y < 4.f) y = 4.f;
    menuRect_ = sf::FloatRect(sf::Vector2f(x, y), sf::Vector2f(w, h));
    menuIndex_ = 0; // 键盘高亮第一项
    menuOpen_ = true;
}

void Renderer::menuMove(int delta) {
    const int n = static_cast<int>(menuOptions_.size());
    if (n <= 0) return;
    menuIndex_ = ((menuIndex_ + delta) % n + n) % n;
}

MineType Renderer::menuHighlightedOption() const {
    return menuOptionAt(menuIndex_);
}

int Renderer::menuItemAt(sf::Vector2i px) const {
    if (!menuOpen_) return -1;
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    if (!menuRect_.contains(p)) return -1;
    const int idx = static_cast<int>((p.y - menuRect_.position.y) / kMenuItemH);
    if (idx < 0 || idx >= static_cast<int>(menuOptions_.size())) return -1;
    return idx;
}

MineType Renderer::menuOptionAt(int idx) const {
    if (idx < 0 || idx >= static_cast<int>(menuOptions_.size())) return MineType::None;
    return menuOptions_[static_cast<std::size_t>(idx)];
}

void Renderer::drawMenu(sf::Vector2i mousePx, sf::RenderTarget& t) const {
    if (!menuOpen_ || menuOptions_.empty() || !fontOk_) return;

    sf::RectangleShape shadow(menuRect_.size + sf::Vector2f(5.f, 5.f));
    shadow.setPosition(menuRect_.position + sf::Vector2f(3.f, 3.f));
    shadow.setFillColor(displayColor(0, 0, 0, 45));
    t.draw(shadow);

    sf::RectangleShape panel(menuRect_.size);
    panel.setPosition(menuRect_.position);
    panel.setFillColor(kBtnBg);
    panel.setOutlineColor(kBtnActive);
    panel.setOutlineThickness(1.6f);
    t.draw(panel);

    const sf::Vector2f mp(static_cast<float>(mousePx.x), static_cast<float>(mousePx.y));
    for (std::size_t i = 0; i < menuOptions_.size(); ++i) {
        const MineType mt = menuOptions_[i];
        const float iy = menuRect_.position.y + static_cast<float>(i) * kMenuItemH;
        const sf::FloatRect item(sf::Vector2f(menuRect_.position.x + 2.f, iy + 1.f),
                                 sf::Vector2f(menuRect_.size.x - 4.f, kMenuItemH - 2.f));
        if (item.contains(mp) || static_cast<int>(i) == menuIndex_) {
            sf::RectangleShape hl(item.size);
            hl.setPosition(item.position);
            hl.setFillColor(kHover);
            t.draw(hl);
        }
        const sf::Color col = (mt == MineType::None) ? kInkSoft : mineColor(mt);
        const float cy = iy + kMenuItemH * 0.5f;
        const float cx = menuRect_.position.x + 18.f;
        sf::CircleShape dot(9.f, 20);
        dot.setOrigin(sf::Vector2f(9.f, 9.f));
        dot.setPosition(sf::Vector2f(cx, cy));
        dot.setFillColor(displayColor(255, 255, 255, 240));
        dot.setOutlineColor(col);
        dot.setOutlineThickness(1.8f);
        t.draw(dot);
        const int mi = static_cast<int>(mt);
        const std::string glyph = (mi >= 1 && !markerChar_[mi].empty()) ? markerChar_[mi]
                                                                       : std::string(mineGlyph(mt));
        // 右侧文字标签始终用标准记号（±1 / ±i），只有圆圈里换成用户自定义图案
        const std::string label = (mt == MineType::None) ? std::string("clear") : std::string(mineGlyph(mt));
        if (mt != MineType::None) {
            if (mi >= 1 && markerTexOk_[mi]) { // 自定义图片：缩放到圆圈里
                const sf::Vector2u ts = markerTex_[mi].getSize();
                const float targetPx = 16.f;
                const float sc = std::min(targetPx / static_cast<float>(ts.x), targetPx / static_cast<float>(ts.y));
                sf::Sprite sp(markerTex_[mi]);
                sp.setOrigin(sf::Vector2f(static_cast<float>(ts.x) * 0.5f, static_cast<float>(ts.y) * 0.5f));
                sp.setScale(sf::Vector2f(sc, sc));
                sp.setPosition(sf::Vector2f(cx, cy));
                t.draw(sp);
            } else {
                t.draw(textSpr(glyph, 9.f, col, cx, cy + 0.5f, 0.2f));
            }
        }
        t.draw(textTLSpr(label, 12.f, col, menuRect_.position.x + 34.f, cy - 7.f));
    }
}

int Renderer::bgHitZone(sf::Vector2i px) const {
    // 纯色背景下这一行不画，命中也要一起关掉 —— 否则会点到看不见的控件
    if (bgColorMode_) return 0;
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    if (L_.bgValue.contains(p)) return 2; // 百分比数字：点进去直接输入
    // 轨道命中区上下各放宽 9px 方便拖拽，但**下沿必须停在 USTC 复选框行之前**（行位见 ustcRects）。
    // 那一行按 winW 右对齐排布，窗口稍宽就滑到轨道正下方；不钳的话它顶部 4–6px 的点击
    // 会被劫持成「拖动透明度」——复选框点不动，滑块反而乱跳。
    const float top = L_.bgTrack.position.y - 9.f;
    const float bottom = std::min(top + L_.bgTrack.size.y + 18.f, L_.headerH - 32.f);
    const sf::FloatRect hit(sf::Vector2f(L_.bgTrack.position.x, top),
                            sf::Vector2f(L_.bgTrack.size.x, std::max(0.f, bottom - top)));
    return hit.contains(p) ? 1 : 0;
}

void Renderer::bgFocusEdit() {
    setupFocus_ = 4; // 4 = 背景透明度百分比
    setupEdit_.clear();
    setupEditBackup_ = bgAlpha_;
}

void Renderer::bgPress(sf::Vector2i px) {
    bgDrag_ = true;
    bgMove(px);
}

void Renderer::bgMove(sf::Vector2i px) {
    if (!bgDrag_) return;
    const float t = (static_cast<float>(px.x) - L_.bgTrack.position.x) / std::max(1.f, L_.bgTrack.size.x);
    const int v = static_cast<int>(std::lround(std::clamp(t, 0.f, 1.f) * static_cast<float>(kBgAlphaMax)));
    bgAlpha_ = static_cast<std::uint8_t>(v);
}

Renderer::SetupRects Renderer::setupRects() const {
    const float w = 400.f;
    const float h = 316.f;
    float x = (L_.winW - w) * 0.5f;
    float y = (L_.winH - h) * 0.5f - 16.f;
    x = std::max(8.f, std::min(x, L_.winW - w - 8.f));
    y = std::max(8.f, std::min(y, L_.winH - h - 8.f));
    SetupRects r{};
    r.panel = sf::FloatRect(sf::Vector2f(x, y), sf::Vector2f(w, h));
    const float rowY = y + 52.f;
    const float rowH = 34.f;
    for (int i = 0; i < 3; ++i) {
        const float ry = rowY + static_cast<float>(i) * rowH;
        const sf::FloatRect minus5(sf::Vector2f(x + 206.f, ry), sf::Vector2f(26.f, 26.f));
        const sf::FloatRect minus(sf::Vector2f(x + 236.f, ry), sf::Vector2f(26.f, 26.f));
        const sf::FloatRect valueBox(sf::Vector2f(x + 266.f, ry), sf::Vector2f(62.f, 26.f));
        const sf::FloatRect plus(sf::Vector2f(x + 332.f, ry), sf::Vector2f(26.f, 26.f));
        const sf::FloatRect plus5(sf::Vector2f(x + 362.f, ry), sf::Vector2f(26.f, 26.f));
        if (i == 0) { r.rowsMinus = minus; r.rowsPlus = plus; r.rowsValue = valueBox;
                      r.rowsMinus5 = minus5; r.rowsPlus5 = plus5; }
        if (i == 1) { r.colsMinus = minus; r.colsPlus = plus; r.colsValue = valueBox;
                      r.colsMinus5 = minus5; r.colsPlus5 = plus5; }
        if (i == 2) { r.minesMinus = minus; r.minesPlus = plus; r.minesValue = valueBox;
                      r.minesMinus5 = minus5; r.minesPlus5 = plus5; }
    }
    const float sy = rowY + 3.f * rowH + 10.f;
    r.splitBtn = sf::FloatRect(sf::Vector2f(x + 18.f, sy), sf::Vector2f(120.f, 26.f));
    // 轨道右移并等量缩短（右端不变）：给 REAL/IMAG 标签的 (0~cap) 范围后缀腾出左侧文字位
    r.realTrack = sf::FloatRect(sf::Vector2f(x + 118.f, sy + 12.f), sf::Vector2f(190.f, 8.f));
    r.imagTrack = sf::FloatRect(sf::Vector2f(x + 118.f, sy + 40.f), sf::Vector2f(190.f, 8.f));
    r.cancelBtn = sf::FloatRect(sf::Vector2f(x + 20.f, y + h - 46.f), sf::Vector2f(120.f, 32.f));
    // 主操作（START）放右边，与常见对话框「取消在左、确认在右」的习惯一致
    r.startBtn = sf::FloatRect(sf::Vector2f(x + w - 150.f, y + h - 46.f), sf::Vector2f(130.f, 32.f));
    return r;
}

void Renderer::setupTextChar(char32_t ch) {
    if (setupFocus_ == 0) return;
    if (ch >= 0xFF10 && ch <= 0xFF19) ch = U'0' + (ch - 0xFF10); // 全角数字（输入法常见）映射为半角
    if (ch < U'0' || ch > U'9') return;
    if (setupEdit_.size() >= 3) return;
    if (setupEdit_.size() == 1 && setupEdit_[0] == '0') setupEdit_.clear();
    // 行/列：超过 24px 下能容纳的上限就拒绝这个字符（非法输入直接截断）
    if (setupFocus_ == 1 || setupFocus_ == 2 || setupFocus_ == 3) {
        const int candidate = std::atoi((setupEdit_ + static_cast<char>(ch)).c_str());
        int limit = 0;
        if (setupFocus_ == 1) limit = setupCfg_.maxRows;
        else if (setupFocus_ == 2) limit = setupCfg_.maxCols;
        else limit = std::max(1, setupCfg_.cols * setupCfg_.rows - 1); // 雷数上限
        if (candidate > limit) return;
    }
    if (setupFocus_ == 4) { // 背景百分比：超过 75 就拒绝这最后一个字符
        const int candidate = std::atoi((setupEdit_ + static_cast<char>(ch)).c_str());
        if (candidate > 75) return;
    }
    setupEdit_ += static_cast<char>(ch);
}

void Renderer::setupBackspace() {
    if (setupFocus_ != 0 && !setupEdit_.empty()) setupEdit_.pop_back();
}

void Renderer::setupCommitEdit() {
    if (setupFocus_ == 0) return;
    if (!setupEdit_.empty()) {
        char* end = nullptr;
        const long v = std::strtol(setupEdit_.c_str(), &end, 10);
        if (end != setupEdit_.c_str() && *end == 0) { // 纯数字才生效
            if (setupFocus_ == 1) { setupCfg_.rows = static_cast<int>(v); setupCfg_.clampToBoard(); }
            else if (setupFocus_ == 2) { setupCfg_.cols = static_cast<int>(v); setupCfg_.clampToBoard(); }
            else if (setupFocus_ == 4) setBgAlpha(static_cast<std::uint8_t>(std::clamp(std::lround(v * 2.55f), 0L, 255L)));
            else setupCfg_.setTotal(static_cast<int>(v));
        }
    }
    setupFocus_ = 0;
    setupEdit_.clear();
}

void Renderer::setupCancelEdit() {
    if (setupFocus_ == 0) return;
    if (setupFocus_ == 1) setupCfg_.rows = setupEditBackup_;
    else if (setupFocus_ == 2) setupCfg_.cols = setupEditBackup_;
    else if (setupFocus_ == 4) bgAlpha_ = static_cast<std::uint8_t>(setupEditBackup_);
    else setupCfg_.total = setupEditBackup_;
    setupCfg_.clampToBoard();
    setupFocus_ = 0;
    setupEdit_.clear();
}

Renderer::SetupAction Renderer::setupPress(sf::Vector2i px) {
    if (!setupOpen_) return SetupAction::None;
    const SetupRects r = setupRects();
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    if (!r.panel.contains(p)) { setupCommitEdit(); return SetupAction::Cancel; } // 点面板外 = 取消
    if (r.startBtn.contains(p)) { setupCommitEdit(); return SetupAction::Start; }
    if (r.cancelBtn.contains(p)) { setupCommitEdit(); return SetupAction::Cancel; }

    // 点数字框 -> 进入直接输入模式（与加减号并存）
    if (r.rowsValue.contains(p) || r.colsValue.contains(p) || r.minesValue.contains(p)) {
        setupCommitEdit(); // 先提交上一个框里正在输入的内容（否则切框就丢了）
        if (r.minesValue.contains(p) && setupCfg_.splitManual) {
            // 点"总雷数"= 回到随机分配虚实模式（否则手动模式下没有回程路）
            setupCfg_.total = setupCfg_.realCount + setupCfg_.imagCount;
            setupCfg_.splitManual = false;
            setupCfg_.clampToBoard();
        }
        setupFocus_ = r.rowsValue.contains(p) ? 1 : (r.colsValue.contains(p) ? 2 : 3);
        setupEdit_.clear();
        setupEditBackup_ = (setupFocus_ == 1) ? setupCfg_.rows
                          : (setupFocus_ == 2) ? setupCfg_.cols : setupCfg_.total;
        return SetupAction::None;
    }
    setupCommitEdit(); // 点到别处先提交

    // 步进器：-- 减 5 / - 减 1 / + 加 1 / ++ 加 5
    {
        const auto bump = [&](int field, int delta) {
            if (field == 1) {
                setupCfg_.rows += delta;
                setupCfg_.clampToBoard();
            } else if (field == 2) {
                setupCfg_.cols += delta;
                setupCfg_.clampToBoard();
            } else if (!setupCfg_.splitManual) { // 手动分型时总雷数由虚实滑块决定
                setupCfg_.setTotal(setupCfg_.total + delta);
            }
        };
        struct StepBtn { const sf::FloatRect* box; int field; int delta; };
        const StepBtn btns[] = {
            {&r.rowsMinus5, 1, -5}, {&r.rowsMinus, 1, -1},   {&r.rowsPlus, 1, 1},   {&r.rowsPlus5, 1, 5},
            {&r.colsMinus5, 2, -5}, {&r.colsMinus, 2, -1},   {&r.colsPlus, 2, 1},   {&r.colsPlus5, 2, 5},
            {&r.minesMinus5, 3, -5}, {&r.minesMinus, 3, -1}, {&r.minesPlus, 3, 1},  {&r.minesPlus5, 3, 5},
        };
        for (const auto& b : btns)
            if (b.box->contains(p)) {
                bump(b.field, b.delta);
                return SetupAction::None;
            }
    }

    // 滑块命中区上下各放宽 10px（轨道本身只有 8px 高）
    const auto slop = [](const sf::FloatRect& rect) {
        return sf::FloatRect(sf::Vector2f(rect.position.x, rect.position.y - 10.f),
                             sf::Vector2f(rect.size.x, rect.size.y + 20.f));
    };

    if (!setupCfg_.splitManual) {
        if (r.splitBtn.contains(p)) { // 切到手动：默认把总数平分
            setupCfg_.splitManual = true;
            setupCfg_.realCount = setupCfg_.total / 2;
            setupCfg_.imagCount = setupCfg_.total - setupCfg_.realCount;
            setupCfg_.clampToBoard();
            return SetupAction::None;
        }
    } else if (slop(r.realTrack).contains(p) || slop(r.imagTrack).contains(p)) {
        setupDrag_ = slop(r.realTrack).contains(p) ? 1 : 2;
        setupMove(px);
    }
    return SetupAction::None;
}

void Renderer::setupMove(sf::Vector2i px) {
    if (!setupOpen_ || setupDrag_ == 0) return;
    const SetupRects r = setupRects();
    const sf::FloatRect track = (setupDrag_ == 1) ? r.realTrack : r.imagTrack;
    const float t = (static_cast<float>(px.x) - track.position.x) / std::max(1.f, track.size.x);
    const int cap = std::max(1, setupCfg_.capacity());
    const int v = static_cast<int>(std::lround(std::clamp(t, 0.f, 1.f) * static_cast<float>(cap)));
    if (setupDrag_ == 1) setupCfg_.setReal(v);
    else setupCfg_.setImag(v);
}

// ============================ 种子界面 ============================
Renderer::SeedRects Renderer::seedRects() const {
    SeedRects r;
    const float mw = 236.f;
    r.menu = sf::FloatRect(sf::Vector2f(L_.seedBtn.position.x + L_.seedBtn.size.x - mw,
                                        L_.seedBtn.position.y + 34.f), sf::Vector2f(mw, 164.f));
    r.item0 = sf::FloatRect(sf::Vector2f(r.menu.position.x + 4.f, r.menu.position.y + 4.f),
                            sf::Vector2f(mw - 8.f, 36.f));
    r.item1 = sf::FloatRect(sf::Vector2f(r.menu.position.x + 4.f, r.menu.position.y + 44.f),
                            sf::Vector2f(mw - 8.f, 36.f));
    r.item2 = sf::FloatRect(sf::Vector2f(r.menu.position.x + 4.f, r.menu.position.y + 84.f),
                            sf::Vector2f(mw - 8.f, 36.f));
    r.item3 = sf::FloatRect(sf::Vector2f(r.menu.position.x + 4.f, r.menu.position.y + 124.f),
                            sf::Vector2f(mw - 8.f, 36.f));

    const float dw = std::min(460.f, L_.winW - 60.f);
    const float dh = 212.f;
    r.dialog = sf::FloatRect(sf::Vector2f((L_.winW - dw) * 0.5f, (L_.winH - dh) * 0.5f - 30.f),
                             sf::Vector2f(dw, dh));
    r.box = sf::FloatRect(sf::Vector2f(r.dialog.position.x + 20.f, r.dialog.position.y + 60.f),
                          sf::Vector2f(dw - 40.f, 36.f));
    const float by = r.dialog.position.y + dh - 56.f;
    r.paste = sf::FloatRect(sf::Vector2f(r.dialog.position.x + 20.f, by), sf::Vector2f(124.f, 34.f));
    r.ok = sf::FloatRect(sf::Vector2f(r.dialog.position.x + dw - 20.f - 124.f, by), sf::Vector2f(124.f, 34.f));
    r.cancel = sf::FloatRect(sf::Vector2f(r.dialog.position.x + dw - 20.f - 248.f - 10.f, by),
                             sf::Vector2f(124.f, 34.f));

    const float bw = 136.f, bh = 28.f;
    r.boxMenu = sf::FloatRect(sf::Vector2f(static_cast<float>(seedBoxMenuPos_.x),
                                           static_cast<float>(seedBoxMenuPos_.y)),
                              sf::Vector2f(bw, bh * 4.f));
    for (int i = 0; i < 4; ++i)
        r.boxItem[i] = sf::FloatRect(sf::Vector2f(r.boxMenu.position.x, r.boxMenu.position.y + bh * i),
                                     sf::Vector2f(bw, bh));

    const float cw = 400.f, ch = 176.f;
    r.confirm = sf::FloatRect(sf::Vector2f((L_.winW - cw) * 0.5f, (L_.winH - ch) * 0.5f - 20.f),
                              sf::Vector2f(cw, ch));
    const float cy = r.confirm.position.y + ch - 56.f;
    r.yes = sf::FloatRect(sf::Vector2f(r.confirm.position.x + 20.f, cy), sf::Vector2f(124.f, 34.f));
    r.no = sf::FloatRect(sf::Vector2f(r.confirm.position.x + cw - 20.f - 124.f, cy), sf::Vector2f(124.f, 34.f));

    const float tw = std::min(560.f, L_.winW - 40.f);
    const float th = std::min(430.f, L_.winH - 40.f);
    r.toolDialog = sf::FloatRect(sf::Vector2f((L_.winW - tw) * 0.5f, (L_.winH - th) * 0.5f - 10.f),
                                 sf::Vector2f(tw, th));
    r.toolKeyBox = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 20.f, r.toolDialog.position.y + 62.f),
                                 sf::Vector2f(tw - 40.f, 30.f));
    r.toolInBox = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 20.f, r.toolDialog.position.y + 120.f),
                                sf::Vector2f(tw - 40.f, 30.f));
    const float tbY = r.toolDialog.position.y + 160.f;
    r.toolDec = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 20.f, tbY), sf::Vector2f(118.f, 30.f));
    r.toolEnc = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 146.f, tbY), sf::Vector2f(118.f, 30.f));
    r.toolCopy = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 272.f, tbY), sf::Vector2f(118.f, 30.f));
    r.toolOut = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + 20.f, r.toolDialog.position.y + 202.f),
                              sf::Vector2f(tw - 40.f, th - 202.f - 56.f));
    r.toolClose = sf::FloatRect(sf::Vector2f(r.toolDialog.position.x + tw - 20.f - 118.f,
                                             r.toolDialog.position.y + th - 46.f),
                                sf::Vector2f(118.f, 34.f));
    return r;
}

void Renderer::openSeedMenu(const std::string& shortSeedText, bool copyEnabled, const std::string& saveHint) {
    seedStage_ = SeedStage::Menu;
    seedCopyEnabled_ = copyEnabled;
    seedShort_ = shortSeedText;
    seedSaveHint_ = saveHint;
    seedMenuItem_ = copyEnabled ? 0 : 2;
}

void Renderer::openSeedLoadDialog(const std::string& prefill) {
    seedStage_ = SeedStage::Load;
    seedInputSet(prefill);
    seedSelectAll(); // 预填内容默认全选，粘上新的会直接替换
}

void Renderer::openSeedConfirm() { seedStage_ = SeedStage::Confirm; }
void Renderer::closeSeedUi() { seedStage_ = SeedStage::None; }

void Renderer::setSeedNote(const std::string& note) {
    seedNote_ = note;
    seedNoteClock_ = 170; // 约 3 秒
}

void Renderer::seedMenuMove(int d) {
    int i = seedMenuItem_;
    for (int k = 0; k < 4; ++k) {
        i = (i + (d > 0 ? 1 : 3) + 4) % 4;
        if (seedMenuEnabled(i)) break;
    }
    seedMenuItem_ = i;
}

Renderer::SeedField* Renderer::activeSeedField() {
    switch (seedStage_) {
    case SeedStage::Load: return &loadField_;
    case SeedStage::Tool: return toolFocus_ == 1 ? &toolKey_ : &toolIn_;
    default: return nullptr;
    }
}

const Renderer::SeedField* Renderer::activeSeedField() const {
    switch (seedStage_) {
    case SeedStage::Load: return &loadField_;
    case SeedStage::Tool: return toolFocus_ == 1 ? &toolKey_ : &toolIn_;
    default: return nullptr;
    }
}

void Renderer::seedDeleteSelection() {
    SeedField* f = activeSeedField();
    if (!f) return;
    const int a = std::min(f->caret, f->anchor);
    const int b = std::max(f->caret, f->anchor);
    if (a == b) return;
    f->text.erase(static_cast<std::size_t>(a), static_cast<std::size_t>(b - a));
    f->caret = a;
    f->anchor = a;
}

namespace {
// 种子输入框的天花板，两条入口（逐字符插入 / 整段粘贴）共用一份过滤与截断，
// 免得改了一条忘了另一条。与 web/ts/renderer.ts 里的 4096 同值。
constexpr std::size_t kSeedInputMax = 4096;

std::size_t utf8Chars(const std::string& s) {
    std::size_t n = 0;
    for (const char c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u < 0x80 || u >= 0xC0) ++n; // 跳过量续字节 0x80..0xBF
    }
    return n;
}

std::string visibleAsciiOnly(const std::string& s) {
    std::string out;
    out.reserve(s.size());
    for (char c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u >= 0x21 && u <= 0x7E) out += c; // 只收可见 ASCII
    }
    return out;
}

// 超长的话只留前 kSeedInputMax 个字符，**并且必须说出来**：静默截断和静默丢弃
// 一样糟，用户只会觉得「粘贴坏了」。真种子远短于 4096，超出去的那截必然是
// 误粘的日志或整份文件，留下前 4096 个字符已经足够说明「粘错了，重粘一次」。
void clampSeedPaste(std::string& text) {
    if (text.size() <= kSeedInputMax) return;
    text.resize(kSeedInputMax);
}

// 闸门有三种「没全收」，都得说：
//   1) 一个可用字符都没有（整段中文 / 只粘了个空格）
//   2) 收了一部分，但丢掉了非 ASCII 的那几成 —— 不说的话用户会以为粘进去的和剪贴板一样
//   3) 超过 4096，被截断
// 第 1 种按单个键程（1 个字符）给短句，免得敲一个空格就刷一长句。
constexpr const char* kSeedPasteNothingKey = "只能输入可见 ASCII（空格 / 中文 / 换行不算）";
constexpr const char* kSeedPasteNothing =
    "BAD PASTE · 粘贴内容里没有可见 ASCII 字符（种子串只用 ASCII，中文/空格/换行会被丢掉）";

inline const char* nothingNote(std::size_t inChars) {
    return inChars <= 1 ? kSeedPasteNothingKey : kSeedPasteNothing;
}

std::string toolTrim(const std::string& s) {
    const std::size_t b = s.find_first_not_of(" \t\r\n");
    if (b == std::string::npos) return std::string();
    const std::size_t e = s.find_last_not_of(" \t\r\n");
    return s.substr(b, e - b + 1);
}

// 与 web/ts/seedtool.ts 的 summary() 同口径：kind · CxR · 雷数（手动分型拆开写）
std::string toolSeedSummary(const Seed& s) {
    const std::string base = s.kind + " · " + std::to_string(s.cols) + "x" + std::to_string(s.rows) +
                             " · " +
                             (s.manualSplit ? std::to_string(s.realMines) + "+" + std::to_string(s.imagMines)
                                            : std::to_string(s.mines)) +
                             " 雷";
    return s.kind == "save"
               ? base + " · " + s.phase + " · 已开 " + std::to_string(s.elapsedCs) + "cs"
               : base;
}
} // namespace

void Renderer::seedInputSet(const std::string& s) {
    const std::size_t inChars = utf8Chars(s);
    std::string clean = visibleAsciiOnly(s);
    // 整段被过滤空掉时**保留原内容**：这是替换语义，但「粘了段中文，结果把已经
    // 打好的种子清了」是双重伤害。只有喂进来的本来就是空串（打开对话框预填）才清空。
    if (!s.empty() && clean.empty()) {
        setSeedNote(nothingNote(inChars));
        return;
    }
    const bool trimmed = clean.size() > kSeedInputMax;
    clampSeedPaste(clean);
    loadField_.text = std::move(clean);
    loadField_.caret = static_cast<int>(loadField_.text.size());
    loadField_.anchor = loadField_.caret;
    loadField_.scroll = 0.f;
    if (trimmed) {
        setSeedNote("TOO LONG · 粘贴内容超过 4096 字符，只留下前 4096 个");
    } else if (inChars > loadField_.text.size()) {
        setSeedNote("FILTERED · 丢掉了 " +
                    std::to_string(inChars - loadField_.text.size()) +
                    " 个非 ASCII 字符（空格 / 中文 / 换行）");
    }
}

void Renderer::seedInsert(const std::string& s) {
    SeedField* f = activeSeedField();
    if (!f) return;
    const std::size_t inChars = utf8Chars(s);
    seedDeleteSelection();
    std::string add = visibleAsciiOnly(s);
    if (add.empty()) {
        if (!s.empty()) setSeedNote(nothingNote(inChars));
        return;
    }
    const std::size_t kept = add.size(); // 过滤后真正要塞进去的字符数
    bool spoke = false;
    // 原来这里整段 `return`：粘一段长文本进去，一个字符都不收，也不吭声。
    // 改成「装得下多少塞多少」，与 web 端同一行为。
    const std::size_t room = kSeedInputMax - f->text.size();
    if (kept > room) {
        add.resize(room);
        setSeedNote(room == 0 ? "FULL · 输入框已有 4096 字符，粘贴没装进来"
                              : "TOO LONG · 粘贴内容超过 4096 字符，只留下装得下的那一截");
        spoke = true;
    }
    if (add.empty()) return;
    f->text.insert(static_cast<std::size_t>(f->caret), add);
    f->caret += static_cast<int>(add.size());
    f->anchor = f->caret;
    // 收进来了但**丢掉了几成**（空格/换行/中文）也要说：不然用户以为框里的内容和
    // 剪贴板一模一样，回头对不上账只会怀疑是解码坏了。
    if (!spoke && inChars > kept) {
        setSeedNote("FILTERED · 丢掉了 " + std::to_string(inChars - kept) +
                    " 个非 ASCII 字符（空格 / 中文 / 换行）");
    }
}

std::string Renderer::seedSelectedText() const {
    const SeedField* f = activeSeedField();
    if (!f) return std::string();
    const int a = std::min(f->caret, f->anchor);
    const int b = std::max(f->caret, f->anchor);
    if (a == b) return std::string();
    return f->text.substr(static_cast<std::size_t>(a), static_cast<std::size_t>(b - a));
}

void Renderer::seedSelectAll() {
    SeedField* f = activeSeedField();
    if (!f) return;
    f->anchor = 0;
    f->caret = static_cast<int>(f->text.size());
}

void Renderer::seedCaretMove(int delta, bool extendSel) {
    SeedField* f = activeSeedField();
    if (!f) return;
    const int n = static_cast<int>(f->text.size());
    f->caret = std::max(0, std::min(n, f->caret + delta));
    if (!extendSel) f->anchor = f->caret;
}

void Renderer::seedInputChar(char32_t ch) {
    seedLastText_ = ch; // 记账：同批 KeyPressed 兜底若插了同一字符就不再重插
    if (seedStage_ != SeedStage::Load && seedStage_ != SeedStage::Tool) return;
    if (ch < 0x21 || ch > 0x7E) return; // 种子 / JSON 都是可见 ASCII 文本
    seedInsert(std::string(1, static_cast<char>(ch)));
}

bool Renderer::seedFieldKey(sf::Keyboard::Key k, bool shift, bool cmd, bool alt) {
    if (cmd || alt) return false;
    if (seedStage_ != SeedStage::Load && seedStage_ != SeedStage::Tool) return false;
    switch (k) {
    case sf::Keyboard::Key::Left:  seedCaretMove(-1, shift); return true;
    case sf::Keyboard::Key::Right: seedCaretMove(1, shift); return true;
    case sf::Keyboard::Key::Home:  seedCaretMove(-1 << 20, shift); return true;
    case sf::Keyboard::Key::End:   seedCaretMove(1 << 20, shift); return true;
    case sf::Keyboard::Key::Backspace: seedInputBackspace(); return true;
    case sf::Keyboard::Key::Delete: { // 前向删除：有选区删选区，否则删光标后一格
        SeedField* f = activeSeedField();
        if (!f) return false;
        if (seedHasSelection()) { seedDeleteSelection(); return true; }
        if (f->caret < static_cast<int>(f->text.size())) {
            f->text.erase(static_cast<std::size_t>(f->caret), 1);
            f->anchor = f->caret;
        }
        return true;
    }
    default: break;
    }
    // 可见 ASCII 兜底映射（中文输入法吞 TextEntered 时仍能键入）。不立即落地：
    // 挂到 seedPendingKey_，帧末与同批 TextEntered 对账，英文模式不会双份。
    char32_t c = 0;
    if (k >= sf::Keyboard::Key::A && k <= sf::Keyboard::Key::Z) {
        c = static_cast<char32_t>(U'a' + (static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::A)));
        if (shift) c = static_cast<char32_t>(c - 32);
    } else if (k >= sf::Keyboard::Key::Num0 && k <= sf::Keyboard::Key::Num9) {
        // 上排数字要带 Shift 变体（美式布局），否则 TextEntered 给 '!'、兜底给 '1'，对账不等俩都进框
        static const char32_t kShiftDigit[10] = {U')', U'!', U'@', U'#', U'$', U'%', U'^', U'&', U'*', U'('};
        const int d = static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::Num0);
        c = shift ? kShiftDigit[d] : static_cast<char32_t>(U'0' + d);
    } else if (k >= sf::Keyboard::Key::Numpad0 && k <= sf::Keyboard::Key::Numpad9) {
        c = static_cast<char32_t>(U'0' + (static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::Numpad0)));
    } else if (k == sf::Keyboard::Key::Hyphen)    { c = shift ? U'_' : U'-'; }
    else if (k == sf::Keyboard::Key::Equal)       { c = shift ? U'+' : U'='; }
    else if (k == sf::Keyboard::Key::LBracket)    { c = shift ? U'{' : U'['; }
    else if (k == sf::Keyboard::Key::RBracket)    { c = shift ? U'}' : U']'; }
    else if (k == sf::Keyboard::Key::Backslash)   { c = shift ? U'|' : U'\\'; }
    else if (k == sf::Keyboard::Key::Semicolon)   { c = shift ? U':' : U';'; }
    else if (k == sf::Keyboard::Key::Apostrophe)  { c = shift ? U'"' : U'\''; }
    else if (k == sf::Keyboard::Key::Comma)       { c = shift ? U'<' : U','; }
    else if (k == sf::Keyboard::Key::Period)      { c = shift ? U'>' : U'.'; }
    else if (k == sf::Keyboard::Key::Slash)       { c = shift ? U'?' : U'/'; }
    else if (k == sf::Keyboard::Key::Grave)       { c = shift ? U'~' : U'`'; }
    else if (k == sf::Keyboard::Key::Space)       { c = U' '; }
    if (c == 0) return false;
    seedPendingKey_ = c;
    return true;
}

void Renderer::seedEndFrame() {
    if (seedPendingKey_ == 0) { seedLastText_ = 0; return; }
    const char32_t c = seedPendingKey_;
    seedPendingKey_ = 0;
    if (c != seedLastText_) seedInputChar(c); // 同批 TextEntered 已处理过（英文模式）就不重插
    seedLastText_ = 0; // 对账只限同一事件批，跨帧必须清零
}

void Renderer::seedInputBackspace() {
    if (seedStage_ != SeedStage::Load && seedStage_ != SeedStage::Tool) return;
    if (seedHasSelection()) {
        seedDeleteSelection();
        return;
    }
    SeedField* f = activeSeedField();
    if (!f) return;
    if (f->caret > 0 && !f->text.empty()) {
        f->text.erase(static_cast<std::size_t>(f->caret - 1), 1);
        --f->caret;
        f->anchor = f->caret;
    }
}

// 在输入框内按像素定位光标（proportional 字体：取前缀宽度最接近的位置）
void Renderer::fieldClickInBox(SeedField& f, sf::Vector2i px, const sf::FloatRect& box, bool extendSel) {
    const float firstCharX = box.position.x + 8.f - f.scroll;
    const int n = static_cast<int>(f.text.size());
    int best = 0;
    float bestDist = 1e9f;
    for (int i = 0; i <= n; ++i) {
        const float w = textWidth(f.text.substr(0, static_cast<std::size_t>(i)), 11.f);
        const float dist = std::abs(firstCharX + w - static_cast<float>(px.x));
        if (dist < bestDist) { bestDist = dist; best = i; }
    }
    f.caret = best;
    if (!extendSel) f.anchor = best;
}

void Renderer::seedClickInBox(sf::Vector2i px, bool extendSel) {
    if (seedStage_ != SeedStage::Load) return;
    fieldClickInBox(loadField_, px, seedRects().box, extendSel);
}

void Renderer::toolClickInBox(sf::Vector2i px) {
    if (seedStage_ != SeedStage::Tool) return;
    const SeedRects r = seedRects();
    if (toolFocus_ == 1) fieldClickInBox(toolKey_, px, r.toolKeyBox, false);
    else fieldClickInBox(toolIn_, px, r.toolInBox, false);
}

// 单行输入域绘制：Load 框与工具箱两框共用（底框/选区/横滚/文字/闪烁光标全在这一个实现）。
// textYOff：文字基线相对框顶的偏移（Load 框高些）。
void Renderer::drawSeedFieldBox(sf::RenderTarget& t, const sf::FloatRect& box, const SeedField& f,
                                const std::string& placeholder, bool focused, float textYOff) const {
    sf::RectangleShape ib(box.size);
    ib.setPosition(box.position);
    ib.setFillColor(kBtnBg);
    ib.setOutlineColor(kBtnActive);
    ib.setOutlineThickness(1.4f);
    t.draw(ib);
    const float pad = 8.f;
    const float inner = box.size.x - 2.f * pad;
    const auto widthOf = [&](int a, int b) {
        if (b <= a) return 0.f;
        return textWidth(f.text.substr(static_cast<std::size_t>(a), static_cast<std::size_t>(b - a)), 11.f);
    };
    const int n = static_cast<int>(f.text.size());
    const int caret = std::max(0, std::min(n, f.caret));
    const float caretW = widthOf(0, caret);
    if (caretW - f.scroll > inner) f.scroll = caretW - inner;
    if (caretW - f.scroll < 0.f) f.scroll = caretW;
    const float textX = box.position.x + pad - f.scroll;
    const float textY = box.position.y + textYOff;
    const int sa = std::min(caret, f.anchor), sb = std::max(caret, f.anchor);
    if (sb > sa) { // 选区底色
        const float x0 = std::max(textX + widthOf(0, sa), box.position.x + 2.f);
        const float x1 = std::min(textX + widthOf(0, sb), box.position.x + box.size.x - 2.f);
        if (x1 > x0) {
            sf::RectangleShape sel(sf::Vector2f(x1 - x0, box.size.y - 8.f));
            sel.setPosition(sf::Vector2f(x0, box.position.y + 4.f));
            sf::Color selCol = kBtnActive;
            selCol.a = 110;
            sel.setFillColor(selCol);
            t.draw(sel);
        }
    }
    if (n == 0 && !placeholder.empty())
        t.draw(textTLSpr(placeholder, 11.f, kInkSoft, box.position.x + pad, textY));
    int first = 0;
    while (first < caret && widthOf(first, caret) > inner) ++first;
    while (first > 0 && widthOf(first - 1, caret) <= inner) --first;
    // 窗口对齐：scroll 左侧的字符不画。光标从长文本尾部点回中部时 scroll=caretW，
    // 上面两条只保证 caret 起往右装得下，不保证不越过窗口左沿 → 文字画出框外。
    while (first < caret && widthOf(0, first + 1) <= f.scroll) ++first;
    int last = first;
    while (last < n && widthOf(0, last + 1) <= f.scroll + inner) ++last;
    if (last > first)
        t.draw(textTLSpr(f.text.substr(static_cast<std::size_t>(first),
                                      static_cast<std::size_t>(last - first)),
                      11.f, kInk, textX + widthOf(0, first), textY));
    // 光标只在聚焦框画、按 1.06s 周期闪烁
    if (focused && std::fmod(animNow(), 1060.0) < 530.0) {
        const float cx = textX + widthOf(0, caret);
        if (cx >= box.position.x + 2.f && cx <= box.position.x + box.size.x - 2.f) {
            sf::RectangleShape bar(sf::Vector2f(1.6f, box.size.y - 10.f));
            bar.setPosition(sf::Vector2f(cx, box.position.y + 5.f));
            bar.setFillColor(kBtnActive);
            t.draw(bar);
        }
    }
}

// ============================ 种子工具箱 ============================
void Renderer::openSeedToolbox(const std::string& prefill) {
    seedStage_ = SeedStage::Tool;
    toolKey_ = SeedField{}; // 密钥不回显、不留存：打开就清空
    toolIn_ = SeedField{};
    toolIn_.text = visibleAsciiOnly(prefill); // 预填本局种子串（纯 ASCII）
    toolIn_.caret = static_cast<int>(toolIn_.text.size());
    toolIn_.anchor = toolIn_.caret;
    toolOut_.clear();
    toolOutBad_ = false;
    toolOutScroll_ = 0.f;
    toolFocus_ = 2;
}

void Renderer::scrollToolOut(float delta) {
    // 与设置/说明面板同向：delta>0（滚轮上 / 自然滚动双指下）= 视图往文档顶部走
    toolOutScroll_ = std::max(0.f, toolOutScroll_ - delta * 48.f); // 上限在绘制时按内容高度收紧
}

void Renderer::toolDecode() {
    const std::string text = toolTrim(toolIn_.text);
    const std::string key = toolTrim(toolKey_.text);
    if (text.empty()) {
        toolOut_ = "（先粘贴种子串）";
        toolOutBad_ = true;
        return;
    }
    if (key.empty()) {
        // 与网页端工具箱同规：密钥必填，绝不拿内置默认密钥自动去试
        // （自动试密钥 = 自动传输正确密码，只有 cmsui 管理面允许留空代读）。
        toolOut_ = "（先输入密钥）";
        toolOutBad_ = true;
        return;
    }
    Seed s;
    if (!decodeSeed(text, s, key)) {
        toolOut_ = "BAD SEED · 这把密钥解不开这段文本\n（密钥与种子不配套，或文本粘错）";
        toolOutBad_ = true;
        return;
    }
    toolOutBad_ = false;
    toolOut_ = "OK · " + toolSeedSummary(s) + "\n\n" + seedToJson(s);
}

void Renderer::toolEncode() {
    const std::string text = toolTrim(toolIn_.text);
    const std::string key = toolTrim(toolKey_.text);
    if (text.empty()) {
        toolOut_ = "（先粘贴明文 JSON）";
        toolOutBad_ = true;
        return;
    }
    if (key.empty()) {
        // 与网页端工具箱同规：密钥必填，绝不拿内置默认密钥自动去编
        toolOut_ = "（先输入密钥）";
        toolOutBad_ = true;
        return;
    }
    json::Value root;
    if (!json::parse(text, root) || !root.isObject()) {
        toolOut_ = "BAD JSON · 不是合法的 JSON 对象（{...}）";
        toolOutBad_ = true;
        return;
    }
    Seed s;
    bool ok = true;
    const int lim = kSeedNumLimit;
    ok &= seedJsonIntField(root, "cols", 9, -lim, lim, s.cols);
    ok &= seedJsonIntField(root, "rows", 9, -lim, lim, s.rows);
    ok &= seedJsonIntField(root, "mines", 10, -lim, lim, s.mines);
    ok &= seedJsonIntField(root, "realMines", -1, -lim, lim, s.realMines);
    ok &= seedJsonIntField(root, "imagMines", -1, -lim, lim, s.imagMines);
    ok &= seedJsonIntField(root, "firstRow", -1, -lim, lim, s.firstRow);
    ok &= seedJsonIntField(root, "firstCol", -1, -lim, lim, s.firstCol);
    {
        std::uint32_t rng = 0;
        ok &= seedJsonIntField(root, "rngSeed", 0, 0, kRngSeedMax, rng);
        s.rngSeed = rng;
    }
    ok &= seedJsonBoolField(root, "manualSplit", false, s.manualSplit);
    ok &= seedJsonBoolField(root, "ustcMode", false, s.ustcMode);
    ok &= seedJsonTextField(root, "createdAt", "", s.createdAt);
    if (const json::Value* v = root.member("kind")) {
        if (v->type != json::Type::String) ok = false;
        else s.kind = v->text;
    }
    if (s.kind != "new" && s.kind != "save") s.kind = "new";
    if (s.kind == "save") {
        int elapsedCs = 0;
        ok &= seedJsonIntField(root, "elapsedCs", 0, 0, kMaxElapsedCs, elapsedCs);
        if (const json::Value* v = root.member("phase")) {
            if (v->type != json::Type::String) ok = false;
            else s.phase = v->text;
        }
        if (s.phase != "playing" && s.phase != "won" && s.phase != "lost") s.phase = "playing";
        ok &= seedJsonTextArray(root, "opened", s.openedRows);
        ok &= seedJsonTextArray(root, "flags", s.flagRows);
    }
    if (!ok) {
        toolOut_ = "BAD JSON · 字段类型不对（数字字段要 JSON 数字，布尔要 JSON 布尔）";
        toolOutBad_ = true;
        return;
    }
    const std::string seedText = key.empty() ? encodeSeed(s) : encodeSeed(s, key);
    // encodeSeed 与游戏端同口径、不做合法性判定，这里用 seedIsSane 提前告知：
    // 自相矛盾的 JSON 也照样给串（⚠），由游戏端导入时统一拒收。
    const bool sane = seedIsSane(s);
    toolOut_ = (sane ? "OK" : "WARN · 游戏端会拒绝（seedIsSane 不过）：") + std::string("\n\n") + seedText;
    toolOutBad_ = !sane;
}

int Renderer::seedBoxMenuItemAt(sf::Vector2i px) const {
    if (!seedBoxMenuOpen_) return -1;
    const SeedRects r = seedRects();
    for (int i = 0; i < 4; ++i)
        if (r.boxItem[i].contains(sf::Vector2f(static_cast<float>(px.x), static_cast<float>(px.y)))) return i;
    return -1;
}

void Renderer::seedBoxMenuMove(int d) {
    seedBoxMenuIndex_ = ((seedBoxMenuIndex_ + (d > 0 ? 1 : 3)) % 4 + 4) % 4;
}

Renderer::SeedHit Renderer::seedHit(sf::Vector2i px) const {
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    const SeedRects r = seedRects();
    switch (seedStage_) {
    case SeedStage::Menu:
        if (r.item0.contains(p)) return SeedHit::MenuCopy;
        if (r.item1.contains(p)) return SeedHit::MenuSave;
        if (r.item2.contains(p)) return SeedHit::MenuLoad;
        if (r.item3.contains(p)) return SeedHit::MenuTool;
        return SeedHit::Outside;
    case SeedStage::Load:
        if (r.ok.contains(p)) return SeedHit::Ok;
        if (r.cancel.contains(p)) return SeedHit::Cancel;
        if (r.paste.contains(p)) return SeedHit::Paste;
        if (r.box.contains(p)) return SeedHit::Box; // 点输入框：定位光标
        return r.dialog.contains(p) ? SeedHit::None : SeedHit::Outside;
    case SeedStage::Confirm:
        if (r.yes.contains(p)) return SeedHit::Yes;
        if (r.no.contains(p)) return SeedHit::No;
        return r.confirm.contains(p) ? SeedHit::None : SeedHit::Outside;
    case SeedStage::Tool:
        if (r.toolDec.contains(p)) return SeedHit::ToolDecode;
        if (r.toolEnc.contains(p)) return SeedHit::ToolEncode;
        if (r.toolCopy.contains(p)) return SeedHit::ToolCopy;
        if (r.toolClose.contains(p)) return SeedHit::ToolClose;
        if (r.toolKeyBox.contains(p)) return SeedHit::ToolKey;
        if (r.toolInBox.contains(p)) return SeedHit::ToolIn;
        return r.toolDialog.contains(p) ? SeedHit::None : SeedHit::Outside;
    default:
        return SeedHit::None;
    }
}

void Renderer::drawSeedUi(sf::RenderTarget& t) const {
    const SeedRects r = seedRects();
    const auto button = [&](const sf::FloatRect& b, const char* label, bool primary) {
        sf::RectangleShape box(b.size);
        box.setPosition(b.position);
        box.setFillColor(primary ? kBtnActive : kBtnBg);
        box.setOutlineColor(primary ? kBtnActive : kBtnEdge);
        box.setOutlineThickness(1.4f);
        t.draw(box);
        t.draw(textSpr(label, 13.f, primary ? sf::Color::White : kInk, b.position.x + b.size.x * 0.5f,
                    b.position.y + b.size.y * 0.5f + 1.f, 0.5f));
    };
    const auto panel = [&](const sf::FloatRect& b) {
        sf::RectangleShape bg(b.size);
        bg.setPosition(b.position);
        bg.setFillColor(kPanel);
        bg.setOutlineColor(kBtnEdge);
        bg.setOutlineThickness(1.6f);
        t.draw(bg);
    };

    if (seedStage_ == SeedStage::Menu) {
        panel(r.menu);
        int hlIdx = seedMenuItem_;
        const int hoverIdx = seedMenuHoverIndex(mousePx_);
        if (hoverIdx >= 0) hlIdx = hoverIdx; // 鼠标在菜单上时，高亮以鼠标为准
        if (seedMenuEnabled(hlIdx)) {
            const sf::FloatRect& hb = hlIdx == 0   ? r.item0
                                      : hlIdx == 1 ? r.item1
                                      : hlIdx == 2 ? r.item2
                                                   : r.item3;
            sf::RectangleShape hl(hb.size);
            hl.setPosition(hb.position);
            hl.setFillColor(kHover);
            t.draw(hl);
        }
        t.draw(textTLSpr("COPY SEED", 11.f, seedCopyEnabled_ ? kInk : kInkSoft, r.item0.position.x + 10.f,
                      r.item0.position.y + 7.f));
        t.draw(textTLSpr(seedCopyEnabled_ ? shortSeed(seedShort_) : std::string("no seed yet (open a cell)"),
                      10.f, seedCopyEnabled_ ? kBtnActive : kInkSoft, r.item0.position.x + 10.f,
                      r.item0.position.y + 22.f));
        t.draw(textTLSpr("SAVE PROGRESS", 11.f, seedCopyEnabled_ ? kInk : kInkSoft, r.item1.position.x + 10.f,
                      r.item1.position.y + 7.f));
        t.draw(textTLSpr(seedCopyEnabled_ ? seedSaveHint_ : std::string("nothing to save yet"), 10.f,
                      seedCopyEnabled_ ? kImagMine : kInkSoft, r.item1.position.x + 10.f,
                      r.item1.position.y + 22.f));
        t.draw(textTLSpr("LOAD SEED / SAVE", 11.f, kInk, r.item2.position.x + 10.f, r.item2.position.y + 7.f));
        t.draw(textTLSpr("paste a seed or a progress save", 10.f, kInkSoft, r.item2.position.x + 10.f,
                      r.item2.position.y + 22.f));
        t.draw(textTLSpr("SEED TOOLBOX", 11.f, kInk, r.item3.position.x + 10.f, r.item3.position.y + 7.f));
        t.draw(textTLSpr("decode / encode with your own key", 10.f, kInkSoft, r.item3.position.x + 10.f,
                      r.item3.position.y + 22.f));
    } else if (seedStage_ == SeedStage::Load) {
        panel(r.dialog);
        t.draw(textTLSpr("LOAD SEED", 15.f, kInk, r.dialog.position.x + 20.f, r.dialog.position.y + 18.f));
        t.draw(textTLSpr("paste a seed string (or type it), then press OK", 10.f, kInkSoft,
                      r.dialog.position.x + 20.f, r.dialog.position.y + 40.f));
        drawSeedFieldBox(t, r.box, loadField_, "(empty)", true, 12.f);
        t.draw(textTLSpr(std::to_string(loadField_.text.size()) + " chars   (Cmd/Ctrl+C/V/X, right-click)",
                      10.f, kInkSoft, r.box.position.x + 8.f, r.box.position.y + 42.f));
        button(r.paste, "PASTE", false);
        button(r.cancel, "CANCEL", false);
        button(r.ok, "OK", true);
        if (seedBoxMenuOpen_) { // 框内右键菜单
            panel(r.boxMenu);
            const char* names[4] = {"CUT", "COPY", "PASTE", "SELECT ALL"};
            for (int i = 0; i < 4; ++i) {
                if (i == seedBoxMenuIndex_) {
                    sf::RectangleShape hl(r.boxItem[i].size);
                    hl.setPosition(r.boxItem[i].position);
                    hl.setFillColor(kHover);
                    t.draw(hl);
                }
                t.draw(textTLSpr(names[i], 11.f, kInk, r.boxItem[i].position.x + 10.f,
                              r.boxItem[i].position.y + 8.f));
            }
        }
    } else if (seedStage_ == SeedStage::Confirm) {
        panel(r.confirm);
        t.draw(textTLSpr("OVERWRITE CURRENT GAME?", 14.f, kInk, r.confirm.position.x + 20.f,
                      r.confirm.position.y + 20.f));
        if (!seedOwLine1_.empty()) {
            t.draw(textCJKSpr(seedOwLine1_, 12.f, kInk, r.confirm.position.x + 20.f, r.confirm.position.y + 46.f));
        }
        if (!seedOwLine2_.empty()) {
            t.draw(textCJKSpr(seedOwLine2_, 12.f, kInkSoft, r.confirm.position.x + 20.f, r.confirm.position.y + 68.f));
        }
        t.draw(textTLSpr("import it now, and this game will be lost", 10.f, kBadMark, r.confirm.position.x + 20.f,
                      r.confirm.position.y + 94.f));
        button(r.yes, "YES", true);
        button(r.no, "NO", false);
    } else if (seedStage_ == SeedStage::Tool) {
        panel(r.toolDialog);
        t.draw(textTLSpr("SEED TOOLBOX", 15.f, kInk, r.toolDialog.position.x + 20.f,
                      r.toolDialog.position.y + 16.f));
        t.draw(textCJKSpr("种子串与明文 JSON 互转；密钥必填（留空直接拒绝，值不显示也不被记住）", 10.f,
                      kInkSoft, r.toolDialog.position.x + 20.f, r.toolDialog.position.y + 40.f));

        // 单行输入域：与 Load 框共用同一套绘制实现（光标只在聚焦框画、按 1.06s 周期闪烁）
        drawSeedFieldBox(t, r.toolKeyBox, toolKey_, "KEY (required)", toolFocus_ == 1, 9.f);
        drawSeedFieldBox(t, r.toolInBox, toolIn_, "SEED STRING / JSON", toolFocus_ == 2, 9.f);
        button(r.toolDec, "DECODE", true);
        button(r.toolEnc, "ENCODE", false);
        button(r.toolCopy, "COPY", false);

        // 输出区：内容没变不重排（一局存档的 JSON 可能几千字符）
        if (toolOutWrapped_ != toolOut_) {
            toolOutWrapped_ = toolOut_;
            toolOutLines_.clear();
            const float maxW = r.toolOut.size.x - 16.f;
            std::size_t start = 0;
            while (start <= toolOut_.size()) {
                const std::size_t nl = toolOut_.find('\n', start);
                const std::string line =
                    toolOut_.substr(start, (nl == std::string::npos ? toolOut_.size() : nl) - start);
                std::string cur; // 硬折行：按 UTF-8 码点逐个量宽（中文也能正确断）
                float w = 0.f;
                for (std::size_t i = 0; i < line.size();) {
                    std::size_t len = 1;
                    const unsigned char c = static_cast<unsigned char>(line[i]);
                    if (c >= 0xF0) len = 4;
                    else if (c >= 0xE0) len = 3;
                    else if (c >= 0xC0) len = 2;
                    if (i + len > line.size()) len = line.size() - i;
                    const std::string ch = line.substr(i, len);
                    const float cw = textWidth(ch, 11.f);
                    if (w + cw > maxW && !cur.empty()) { toolOutLines_.push_back(cur); cur.clear(); w = 0.f; }
                    cur += ch;
                    w += cw;
                    i += len;
                }
                toolOutLines_.push_back(cur);
                if (nl == std::string::npos) break;
                start = nl + 1;
            }
        }
        sf::RectangleShape ob(r.toolOut.size);
        ob.setPosition(r.toolOut.position);
        ob.setFillColor(displayColor(toolOutBad_ ? 42 : 15, toolOutBad_ ? 18 : 27, toolOutBad_ ? 16 : 38));
        ob.setOutlineColor(kBtnEdge);
        ob.setOutlineThickness(1.2f);
        t.draw(ob);
        constexpr float lineH = 16.f;
        if (toolOutLines_.empty()) {
            t.draw(textCJKSpr("（DECODE / ENCODE 的结果会显示在这里）", 11.f, kBtnEdge,
                          r.toolOut.position.x + 8.f, r.toolOut.position.y + 8.f));
        } else {
            const float viewH = r.toolOut.size.y - 10.f;
            const float totalH = static_cast<float>(toolOutLines_.size()) * lineH;
            toolOutScroll_ = std::min(std::max(0.f, toolOutScroll_), std::max(0.f, totalH - viewH));
            const int firstLine = static_cast<int>(toolOutScroll_ / lineH);
            float y = r.toolOut.position.y + 5.f - (toolOutScroll_ - static_cast<float>(firstLine) * lineH);
            const float outBottom = r.toolOut.position.y + r.toolOut.size.y;
            // 深底配浅字（kInk 是给浅底用的深墨水，在这里几乎看不见）
            const sf::Color outInk = toolOutBad_ ? displayColor(255, 217, 212) : displayColor(224, 233, 242);
            for (int i = firstLine; i < static_cast<int>(toolOutLines_.size()); ++i) {
                if (y + lineH > outBottom) break;          // 只画完整落在框内的行，半行会戳出框外
                if (y >= r.toolOut.position.y)
                    t.draw(textCJKSpr(toolOutLines_[i], 11.f, outInk,
                                  r.toolOut.position.x + 8.f, y));
                y += lineH;
            }
        }
        button(r.toolClose, "CLOSE", false);
    }

    // 状态提示（复制成功 / 密码错误 …）
    if (seedNoteClock_ > 0 && !seedNote_.empty()) {
        const bool bad = seedNote_.rfind("WRONG", 0) == 0 || seedNote_.rfind("BAD", 0) == 0;
        const float noteW = textWidth(seedNote_, 12.f);
        const float w = std::max(96.f, noteW + 24.f);
        sf::RectangleShape nb(sf::Vector2f(w, 26.f));
        nb.setPosition(sf::Vector2f(L_.seedBtn.position.x + L_.seedBtn.size.x - w,
                                    L_.seedBtn.position.y + L_.seedBtn.size.y + 6.f));
        nb.setFillColor(bad ? kBadMark : kRealMine);
        t.draw(nb);
        t.draw(textSpr(seedNote_, 12.f, sf::Color::White, nb.getPosition().x + w * 0.5f,
                    nb.getPosition().y + 13.f, 0.5f));
    }
}

// ============================ 设置面板 ============================
Renderer::SettingsRects Renderer::settingsRects() const {
    SettingsRects r{};
    const sf::FloatRect P = L_.setPanel;
    r.panel = P;
    const float y0 = P.position.y + 54.f;
    r.bgBox = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, y0), sf::Vector2f(190.f, 26.f));
    r.browseBg = sf::FloatRect(sf::Vector2f(P.position.x + 338.f, y0), sf::Vector2f(110.f, 26.f));
    r.resetBg = sf::FloatRect(sf::Vector2f(P.position.x + 456.f, y0), sf::Vector2f(84.f, 26.f));
    const float cy = P.position.y + 94.f;
    r.swatch = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, cy), sf::Vector2f(30.f, 26.f));
    r.hexField = sf::FloatRect(sf::Vector2f(P.position.x + 178.f, cy), sf::Vector2f(92.f, 26.f));
    r.rgbField[0] = sf::FloatRect(sf::Vector2f(P.position.x + 292.f, cy), sf::Vector2f(42.f, 26.f));
    r.rgbField[1] = sf::FloatRect(sf::Vector2f(P.position.x + 352.f, cy), sf::Vector2f(42.f, 26.f));
    r.rgbField[2] = sf::FloatRect(sf::Vector2f(P.position.x + 412.f, cy), sf::Vector2f(42.f, 26.f));
    r.resetColor = sf::FloatRect(sf::Vector2f(P.position.x + 462.f, cy), sf::Vector2f(84.f, 26.f));
    for (int i = 1; i <= 4; ++i) {
        const float y = P.position.y + 140.f + static_cast<float>(i - 1) * 42.f;
        r.field[i] = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, y), sf::Vector2f(50.f, 26.f));
        r.browse[i] = sf::FloatRect(sf::Vector2f(P.position.x + 200.f, y), sf::Vector2f(104.f, 26.f));
        r.clear[i] = sf::FloatRect(sf::Vector2f(P.position.x + 312.f, y), sf::Vector2f(78.f, 26.f));
    }
    // 空白格（翻开且周围无雷）自定义行
    {
        const float y = P.position.y + 320.f;
        r.blankField = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, y), sf::Vector2f(50.f, 26.f));
        r.blankBrowse = sf::FloatRect(sf::Vector2f(P.position.x + 200.f, y), sf::Vector2f(104.f, 26.f));
        r.blankClear = sf::FloatRect(sf::Vector2f(P.position.x + 312.f, y), sf::Vector2f(78.f, 26.f));
    }
    r.close = sf::FloatRect(sf::Vector2f(P.position.x + P.size.x - 138.f, P.position.y + P.size.y - 78.f),
                            sf::Vector2f(118.f, 32.f));
    // 双击开格失败行为：三个互斥按钮
    for (int i = 0; i < 3; ++i) {
        r.chordBtn[i] = sf::FloatRect(sf::Vector2f(P.position.x + 140.f + static_cast<float>(i) * 94.f,
                                                     P.position.y + 372.f),
                                      sf::Vector2f(86.f, 26.f));
    }
    // 双击判定时长：滑块 + 数值框（单位毫秒）
    r.dcTrack = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, P.position.y + 423.f), sf::Vector2f(190.f, 8.f));
    r.dcValue = sf::FloatRect(sf::Vector2f(P.position.x + 348.f, P.position.y + 414.f), sf::Vector2f(74.f, 26.f));
    // 装饰星光：密度 / 大小两条滑块 + 两个可输入数值框（与网页端 settingsRects 同坐标）
    r.starTrack = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, P.position.y + 474.f), sf::Vector2f(190.f, 8.f));
    r.scaleTrack = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, P.position.y + 519.f), sf::Vector2f(190.f, 8.f));
    r.starValue = sf::FloatRect(sf::Vector2f(P.position.x + 348.f, P.position.y + 465.f), sf::Vector2f(74.f, 26.f));
    r.scaleValue = sf::FloatRect(sf::Vector2f(P.position.x + 348.f, P.position.y + 510.f), sf::Vector2f(74.f, 26.f));
    r.animBtn = sf::FloatRect(sf::Vector2f(P.position.x + 140.f, P.position.y + 570.f), sf::Vector2f(120.f, 26.f));
    r.restoreAll = sf::FloatRect(sf::Vector2f(P.position.x + P.size.x - 138.f - 8.f - 132.f,
                                              P.position.y + P.size.y - 78.f), sf::Vector2f(132.f, 32.f));
    return r;
}

Renderer::SettingsHit Renderer::settingsHit(sf::Vector2i px) const {
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    const SettingsRects r = settingsRects();
    // 内容区是滚动的：绘制时整体上移 settingsScroll_，命中判定必须先把指针换算回内容坐标，
    // 否则滚到底就点不中（或点中已经看不见的行）。底部 CLOSE / RESTORE ALL 不随内容滚动。
    const float sc = settingsMaxS_ > 0.f ? settingsScroll_ : 0.f;
    const sf::Vector2f q(p.x, p.y + sc);
    const float viewTop = r.panel.position.y + 44.f;
    const float viewBot = r.panel.position.y + r.panel.size.y - 82.f;
    const auto vis = [&](float y, float h) { // 该内容矩形此刻是否在视口内（与 drawSettings 的 inView 同口径）
        const float yy = y - sc;
        return yy + h >= viewTop && yy <= viewBot;
    };
    const auto inZone = [&](const sf::FloatRect& b, float padX, float padY) {
        return vis(b.position.y - padY, b.size.y + 2 * padY) &&
               sf::FloatRect(sf::Vector2f(b.position.x - padX, b.position.y - padY),
                             sf::Vector2f(b.size.x + 2 * padX, b.size.y + 2 * padY))
                   .contains(q);
    };
    if (r.close.contains(p)) return SettingsHit::Close;
    if (r.restoreAll.contains(p)) return SettingsHit::RestoreAll;
    if (inZone(r.bgBox, 0.f, 0.f)) return SettingsHit::BgField;
    if (inZone(r.browseBg, 0.f, 0.f)) return SettingsHit::BrowseBg;
    if (inZone(r.resetBg, 0.f, 0.f)) return SettingsHit::ResetBg;
    if (inZone(r.hexField, 0.f, 0.f)) return SettingsHit::HexField;
    if (inZone(r.resetColor, 0.f, 0.f)) return SettingsHit::ResetColor;
    for (int i = 0; i < 3; ++i)
        if (inZone(r.chordBtn[i], 0.f, 0.f))
            return static_cast<SettingsHit>(static_cast<int>(SettingsHit::ChordSilent) + i);
    if (inZone(r.dcTrack, 6.f, 12.f)) return SettingsHit::DcTrack; // 滑块加宽命中区，好点
    if (inZone(r.dcValue, 0.f, 0.f)) return SettingsHit::DcValue;
    if (inZone(r.starValue, 0.f, 0.f)) return SettingsHit::StarValue;
    if (inZone(r.scaleValue, 0.f, 0.f)) return SettingsHit::ScaleValue;
    if (inZone(r.starTrack, 6.f, 12.f)) return SettingsHit::StarTrack;
    if (inZone(r.scaleTrack, 6.f, 12.f)) return SettingsHit::ScaleTrack;
    if (inZone(r.animBtn, 0.f, 0.f)) return SettingsHit::AnimFx;
    for (int i = 0; i < 3; ++i)
        if (inZone(r.rgbField[i], 0.f, 0.f))
            return static_cast<SettingsHit>(static_cast<int>(SettingsHit::FieldR) + i);
    for (int i = 1; i <= 4; ++i) {
        if (inZone(r.field[i], 0.f, 0.f))
            return static_cast<SettingsHit>(static_cast<int>(SettingsHit::Field1) + (i - 1));
        if (inZone(r.browse[i], 0.f, 0.f))
            return static_cast<SettingsHit>(static_cast<int>(SettingsHit::Browse1) + (i - 1));
        if (inZone(r.clear[i], 0.f, 0.f))
            return static_cast<SettingsHit>(static_cast<int>(SettingsHit::Clear1) + (i - 1));
    }
    // 空白格自定义
    if (inZone(r.blankField, 0.f, 0.f)) return SettingsHit::BlankField;
    if (inZone(r.blankBrowse, 0.f, 0.f)) return SettingsHit::BlankBrowse;
    if (inZone(r.blankClear, 0.f, 0.f)) return SettingsHit::BlankClear;
    return r.panel.contains(p) ? SettingsHit::None : SettingsHit::Outside;
}

void Renderer::settingsChar(char32_t ch) {
    if (!settingsOpen_) return;
    // 输入法常输出全角字符：先映射成半角（Ａ->A、１->1、＃-># 等）
    if (ch >= 0xFF01 && ch <= 0xFF5E) ch -= 0xFEE0;
    else if (ch == 0x3000) ch = U' ';
    const int f = settingsFocus_;
    if (f >= 1 && f <= 4) { // 标记字符：单字符，立即生效
        if (ch < 0x21 || ch > 0x7E) return;
        setMarkerChar(static_cast<MineType>(f), std::string(1, static_cast<char>(ch)));
        return;
    }
    if (f == 10) { // 空白格字符：单字符，立即生效
        if (ch < 0x21 || ch > 0x7E) return;
        setBlankChar(std::string(1, static_cast<char>(ch)));
        return;
    }
    if (f == 5) { // 色号：只收 [0-9A-Fa-f]，最多 6 位，且满 6 位才生效（半成品绝不当真）
        const char c = static_cast<char>(ch);
        const bool isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!isHex) return;
        if (settingsEdit_.size() >= 6) return; // 第 7 位直接截断
        if (c >= 'a' && c <= 'f') ch = static_cast<char32_t>(c - 32);
        settingsEdit_ += static_cast<char>(ch);
        if (settingsEdit_.size() == 6) {
            const long v = std::strtol(settingsEdit_.c_str(), nullptr, 16);
            setCellColor(static_cast<int>((v >> 16) & 0xFF), static_cast<int>((v >> 8) & 0xFF),
                         static_cast<int>(v & 0xFF));
            settingsEdit_.clear(); // 应用后清空，方便继续输入
        }
        return;
    }
    if (f == 13) { // 背景纯色：与色号同一套规则（只收十六进制、满 6 位才生效）
        const char c = static_cast<char>(ch);
        const bool isHex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!isHex) return;
        if (settingsEdit_.size() >= 6) return;
        if (c >= 'a' && c <= 'f') ch = static_cast<char32_t>(c - 32);
        settingsEdit_ += static_cast<char>(ch);
        if (settingsEdit_.size() == 6) {
            const long v = std::strtol(settingsEdit_.c_str(), nullptr, 16);
            bgColorMode_ = true;
            // 存**原始 sRGB**，不做 P3 预补偿：面板要能原样显示用户输的那个色号，
            // 补偿留到绘制时再做（displayColor）。
            bgSolid_ = sf::Color(static_cast<std::uint8_t>((v >> 16) & 0xFF),
                                 static_cast<std::uint8_t>((v >> 8) & 0xFF),
                                 static_cast<std::uint8_t>(v & 0xFF));
            bgPath_.clear(); // 纯色和图片互斥：清掉图片路径，免得退出时把旧图当垃圾留下
            bgOk_ = false;
            bgTried_ = false;
            settingsEdit_.clear();
        }
        return;
    }
    if (f == 9) { // 双击判定毫秒：只收数字、最多 4 位，且不得超过上限
        const char c = static_cast<char>(ch);
        if (c < '0' || c > '9') return;
        if (settingsEdit_.size() >= 4) return;
        if (settingsEdit_.size() == 1 && settingsEdit_[0] == '0') settingsEdit_.clear();
        if (std::atoi((settingsEdit_ + c).c_str()) > kDoubleClickMaxMs) return; // 超上限的字符直接拒绝
        settingsEdit_ += c;
        return;
    }
    if (f == 11) { // 星光密度：数字 + 至多一个小数点，最多 4 位（够输 7.12），候选值不得超上限
        const char c = static_cast<char>(ch);
        const bool isDot = (c == '.');
        if (!isDot && (c < '0' || c > '9')) return;
        if (settingsEdit_.size() >= 4) return;
        if (isDot && settingsEdit_.find('.') != std::string::npos) return;
        if (!isDot && std::strtof((settingsEdit_ + c).c_str(), nullptr) > kStarDensityMax) return;
        settingsEdit_ += c;
        return;
    }
    if (f == 12) { // 星光大小：数字 + 至多一个小数点，最多 4 位，候选值不得超上限（这里不能去前导 0：0.6 合法）
        const char c = static_cast<char>(ch);
        const bool isDot = (c == '.');
        if (!isDot && (c < '0' || c > '9')) return;
        if (settingsEdit_.size() >= 4) return;
        if (isDot && settingsEdit_.find('.') != std::string::npos) return;
        if (std::strtof((settingsEdit_ + c).c_str(), nullptr) > kStarScaleMax) return;
        settingsEdit_ += c;
        return;
    }
    if (f >= 6 && f <= 8) { // R/G/B：只收数字，最多 3 位，且不得让数值超过 255
        const char c = static_cast<char>(ch);
        if (c < '0' || c > '9') return;
        if (settingsEdit_.size() >= 3) return;
        if (settingsEdit_.size() == 1 && settingsEdit_[0] == '0') settingsEdit_.clear();
        const int candidate = std::atoi((settingsEdit_ + c).c_str());
        if (candidate > 255) return; // 让它非法的那个字符被截断
        settingsEdit_ += c;
        int r = cellR_, g = cellG_, b = cellB_;
        if (f == 6) r = candidate;
        else if (f == 7) g = candidate;
        else b = candidate;
        setCellColor(r, g, b);
    }
}

void Renderer::settingsBackspace() {
    const int f = settingsFocus_;
    if (f >= 1 && f <= 4) {
        setMarkerChar(static_cast<MineType>(f), std::string());
        return;
    }
    if (f >= 5 && f <= 13 && !settingsEdit_.empty()) settingsEdit_.pop_back();
}
Renderer::ConfirmRects Renderer::confirmRects() const {
    const sf::FloatRect P = L_.setPanel;
    const float w = 430.f, h = 178.f;
    const float x = P.position.x + (P.size.x - w) * 0.5f;
    const float y = P.position.y + (P.size.y - h) * 0.5f;
    ConfirmRects r{};
    r.panel = sf::FloatRect(sf::Vector2f(x, y), sf::Vector2f(w, h));
    r.no = sf::FloatRect(sf::Vector2f(x + w - 224.f, y + h - 54.f), sf::Vector2f(96.f, 32.f));
    r.yes = sf::FloatRect(sf::Vector2f(x + w - 118.f, y + h - 54.f), sf::Vector2f(98.f, 32.f));
    return r;
}

Renderer::ConfirmHit Renderer::confirmHit(sf::Vector2i px) const {
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    const ConfirmRects r = confirmRects();
    if (r.yes.contains(p)) return ConfirmHit::Yes;
    if (r.no.contains(p)) return ConfirmHit::Cancel;
    return r.panel.contains(p) ? ConfirmHit::None : ConfirmHit::Outside;
}

void Renderer::drawConfirm(sf::RenderTarget& t) const {
    if (!confirmOpen()) return;
    const ConfirmRects r = confirmRects();
    const sf::FloatRect P = r.panel;
    sf::RectangleShape shadow(P.size + sf::Vector2f(6.f, 6.f));
    shadow.setPosition(P.position + sf::Vector2f(3.f, 3.f));
    shadow.setFillColor(displayColor(0, 0, 0, 60));
    t.draw(shadow);
    sf::RectangleShape bg(P.size);
    bg.setPosition(P.position);
    bg.setFillColor(kPanel);
    bg.setOutlineColor(kBtnActive);
    bg.setOutlineThickness(2.f);
    t.draw(bg);
    const bool isRestart = (confirmKind_ == ConfirmKind::Restart);
    const bool isSwitch = (confirmKind_ == ConfirmKind::Switch);
    t.draw(textTLSpr(isSwitch ? "SWITCH BOARD?" : (isRestart ? "RESTART GAME?" : "RESTORE ALL DEFAULTS?"), 15.f, kInk,
                  P.position.x + 22.f, P.position.y + 18.f));
    const auto row = [&](const std::string& s, float dy, sf::Color col) {
        t.draw(textCJKSpr(s, 13.f, col, P.position.x + 22.f, P.position.y + dy));
    };
    if (isSwitch) {
        row("切换到「" + confirmWhat_ + "」将重置本局，", 58.f, kInk);
        row("当前进度不会被保存。", 82.f, kBadMark);
    } else if (isRestart) {
        row("本局还没结束，重新开始会丢失当前进度。", 58.f, kInkSoft);
        row("（背景、图标、格子颜色等设置不受影响）", 82.f, kInkSoft);
    } else {
        row("会删除自定义背景、四种标记图标与格子颜色，", 58.f, kInkSoft);
        row("并删除配置目录里的图片文件。此操作不可撤销。", 82.f, kInkSoft);
    }

    const auto button = [&](const sf::FloatRect& b, const char* label, bool primary) {
        sf::RectangleShape box(b.size);
        box.setPosition(b.position);
        box.setFillColor(primary ? kBtnActive : kBtnBg);
        box.setOutlineColor(primary ? kBtnActive : kBtnEdge);
        box.setOutlineThickness(1.4f);
        t.draw(box);
        t.draw(textSpr(label, 12.f, primary ? sf::Color::White : kInk, b.position.x + b.size.x * 0.5f,
                    b.position.y + b.size.y * 0.5f + 1.f, 0.4f));
    };
    button(r.no, "NO", false);
    button(r.yes, "YES", true);
}

// —————————————————————————— 黄 0 首现教学 ——————————————————————————
// 首次揭开「和恰好抵消」的黄 0 时闪烁 1.5s 再弹一次性解释（点弹窗外任意处关闭）。
// seen 政策同 helpseen：触发即落盘，这次没看完下次也不弹；读档恢复路径不触发
// （main.cpp 只在主动开格后调用）。真空格（minesAround==0）不参与：它是安全格。

bool Renderer::maybeStartZeroTip(const Board& board) {
    if (zeroTipSeen_ || zeroTipPhase_ != 0) return false;
    for (int r = 0; r < board.rows(); ++r)
        for (int c = 0; c < board.cols(); ++c) {
            const Cell& cell = board.at(r, c);
            if (cell.opened && cell.minesAround > 0 && cell.realSum == 0 && cell.imagSum == 0) {
                zeroTipSeen_ = true;
                saveSettings();
                zeroTipPhase_ = 1;
                zeroTipT0_ = animClock_.getElapsedTime().asMilliseconds();
                return true;
            }
        }
    return false;
}

void Renderer::tickZeroTip() {
    if (zeroTipPhase_ == 1 &&
        animClock_.getElapsedTime().asMilliseconds() - zeroTipT0_ >= 1500)
        zeroTipPhase_ = 2;
}

sf::FloatRect Renderer::zeroTipRects() const {
    const sf::FloatRect P = L_.setPanel;
    const float w = std::min(470.f, P.size.x - 16.f), h = std::min(140.f, P.size.y - 16.f);
    const float x = P.position.x + (P.size.x - w) * 0.5f;
    const float y = P.position.y + (P.size.y - h) * 0.5f;
    return sf::FloatRect(sf::Vector2f(x, y), sf::Vector2f(w, h));
}

Renderer::ZeroTipHit Renderer::zeroTipHit(sf::Vector2i px) const {
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    return zeroTipPanel_.contains(p) ? ZeroTipHit::None : ZeroTipHit::Outside;
}

void Renderer::drawZeroTipFlash(const Board& board, sf::RenderTarget& t) const {
    if (zeroTipPhase_ != 1) return;
    const int el = animClock_.getElapsedTime().asMilliseconds() - zeroTipT0_;
    if (el < 0 || el >= 1500) return;
    // 1.5s 内明暗 3 次（正弦半周期 250ms），黄色描边与提示数字同色
    const float a = 0.42f + 0.42f * std::sin(el / 1000.f * 3.14159265f * 2.f * 3.f);
    const float pitch = L_.cell + L_.gap;
    sf::RectangleShape outline(sf::Vector2f(L_.cell - 3.f, L_.cell - 3.f));
    outline.setFillColor(sf::Color::Transparent);
    outline.setOutlineThickness(3.f);
    outline.setOutlineColor(withAlpha(kZeroHint, a));
    for (int r = 0; r < board.rows(); ++r)
        for (int c = 0; c < board.cols(); ++c) {
            const Cell& cell = board.at(r, c);
            if (!(cell.opened && cell.minesAround > 0 && cell.realSum == 0 && cell.imagSum == 0)) continue;
            const std::size_t idx = static_cast<std::size_t>(r) * static_cast<std::size_t>(board.cols()) +
                                    static_cast<std::size_t>(c);
            if (revealOf(idx) < 1.f) continue; // 波前未到的先不闪
            outline.setPosition(sf::Vector2f(L_.boardX + c * pitch + 1.5f, L_.boardY + r * pitch + 1.5f));
            t.draw(outline);
        }
}

void Renderer::drawZeroTip(sf::RenderTarget& t) {
    if (zeroTipPhase_ != 2) return;
    const sf::FloatRect P = zeroTipRects();
    zeroTipPanel_ = P;
    sf::RectangleShape shadow(P.size + sf::Vector2f(6.f, 6.f));
    shadow.setPosition(P.position + sf::Vector2f(3.f, 3.f));
    shadow.setFillColor(displayColor(0, 0, 0, 60));
    t.draw(shadow);
    sf::RectangleShape bg(P.size);
    bg.setPosition(P.position);
    bg.setFillColor(kPanel);
    bg.setOutlineColor(kBtnActive);
    bg.setOutlineThickness(2.f);
    t.draw(bg);
    t.draw(textCJKSpr("「0」是什么？", 15.f, kInk, P.position.x + 22.f, P.position.y + 18.f));
    t.draw(textCJKSpr("黄色 0 表示周围八格的雷恰好完全抵消（实部、虚部都为零）。", 13.f, kInkSoft,
                      P.position.x + 22.f, P.position.y + 58.f));
    t.draw(textCJKSpr("但这格周围仍然有雷 —— 它不是安全区，别当成经典扫雷的 0 乱点。", 13.f, kBadMark,
                      P.position.x + 22.f, P.position.y + 82.f));
    t.draw(textCJKSpr("本提示只出现这一次；完整规则随时可在菜单「?」里重看。", 11.f, kInkSoft,
                      P.position.x + 22.f, P.position.y + 112.f));
}

void Renderer::drawSettings(sf::RenderTarget& t) const {
    if (!settingsOpen_) return;
    const SettingsRects r = settingsRects();
    const sf::FloatRect P = r.panel;
    sf::RectangleShape bg(P.size);
    bg.setPosition(P.position);
    bg.setFillColor(kPanel);
    bg.setOutlineColor(kBtnEdge);
    bg.setOutlineThickness(1.8f);
    t.draw(bg);
    t.draw(textTLSpr("SETTINGS", 16.f, kInk, P.position.x + 22.f, P.position.y + 16.f));

    const auto button = [&](const sf::FloatRect& b, const char* label, bool primary) {
        sf::RectangleShape box(b.size);
        box.setPosition(b.position);
        box.setFillColor(primary ? kBtnActive : kBtnBg);
        box.setOutlineColor(primary ? kBtnActive : kBtnEdge);
        box.setOutlineThickness(1.4f);
        t.draw(box);
        t.draw(textSpr(label, 11.f, primary ? sf::Color::White : kInk, b.position.x + b.size.x * 0.5f,
                    b.position.y + b.size.y * 0.5f + 1.f, 0.4f));
    };
    const auto fileName = [](const std::string& path) {
        if (path.empty()) return std::string("(default)");
        const std::size_t slash = path.find_last_of('/');
        std::string name = (slash == std::string::npos) ? path : path.substr(slash + 1);
        if (name.size() > 24) name = name.substr(0, 21) + "...";
        return name;
    };
    const auto box = [&](const sf::FloatRect& b, const std::string& text, bool focused) {
        sf::RectangleShape bb(b.size);
        bb.setPosition(b.position);
        bb.setFillColor(focused ? kHover : kBtnBg);
        bb.setOutlineColor(focused ? kBtnActive : kBtnEdge);
        bb.setOutlineThickness(1.4f);
        t.draw(bb);
        t.draw(textTLSpr(text, 11.f, kInk, b.position.x + 6.f, b.position.y + 7.f));
    };

    // 可滚动内容区域
    const float viewTop = P.position.y + 44.f;
    const float viewBot = P.position.y + P.size.y - 82.f;
    const float viewH = viewBot - viewTop;
    const float contentBottom = P.position.y + 600.f; // 内容最底部（ANIM FX 行把它拉长了，星光前为 446）
    settingsTotalH_ = contentBottom - viewTop;
    settingsViewH_ = viewH;
    settingsMaxS_ = std::max(0.f, settingsTotalH_ - viewH);
    if (settingsScroll_ > settingsMaxS_) settingsScroll_ = settingsMaxS_;
    if (settingsScroll_ < 0.f) settingsScroll_ = 0.f;

    const auto inView = [&](float y, float h) {
        const float yy = y - settingsScroll_;
        return yy + h >= viewTop && yy <= viewBot;
    };
    const auto scrollY = [&](float y) { return y - settingsScroll_; };

    // 背景
    if (inView(r.bgBox.position.y, 26.f)) {
        const float yy = scrollY(r.bgBox.position.y);
        t.draw(textTLSpr("BACKGROUND", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
        sf::FloatRect b = r.bgBox; b.position.y = yy;
        // 聚焦时显示正在输入的色号（'#' 是提示符，不占输入位）；
        // 满 6 位会自动生效并清空缓冲，这时回落到「显示当前值」，否则框里只剩一个 '#'
        box(b, (settingsFocus_ == 13 && !settingsEdit_.empty()) ? ("#" + settingsEdit_)
                                    : (bgColorMode_ ? toHexColor(bgSolid_) : fileName(bgPath_)),
            settingsFocus_ == 13);
        b = r.browseBg; b.position.y = yy; button(b, "CHOOSE IMAGE", false);
        b = r.resetBg; b.position.y = yy; button(b, "DEFAULT", false);
    }

    // 格子颜色
    if (inView(r.swatch.position.y, 26.f)) {
        const float yy = scrollY(r.swatch.position.y);
        t.draw(textTLSpr("CELL COLOR", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
        sf::RectangleShape sw(r.swatch.size);
        sw.setPosition(sf::Vector2f(r.swatch.position.x, yy));
        sw.setFillColor(coveredFill());
        sw.setOutlineColor(kBtnEdge);
        sw.setOutlineThickness(1.4f);
        t.draw(sw);
        const auto hexNow = [&]() {
            std::ostringstream ss;
            ss << "#" << std::uppercase << std::hex << std::setfill('0') << std::setw(2)
               << static_cast<int>(cellR_) << std::setw(2) << static_cast<int>(cellG_) << std::setw(2)
               << static_cast<int>(cellB_);
            return ss.str();
        };
        sf::FloatRect hf = r.hexField; hf.position.y = yy;
        box(hf, settingsFocus_ == 5 ? ("#" + settingsEdit_) : hexNow(), settingsFocus_ == 5);
        const std::uint8_t comps[3] = {cellR_, cellG_, cellB_};
        const char* names[3] = {"R", "G", "B"};
        for (int i = 0; i < 3; ++i) {
            sf::FloatRect rf = r.rgbField[i]; rf.position.y = yy;
            t.draw(textTLSpr(names[i], 11.f, kInkSoft, rf.position.x - 12.f, rf.position.y + 8.f));
            const bool foc = settingsFocus_ == 6 + i;
            box(rf, foc && !settingsEdit_.empty() ? settingsEdit_
                                                  : std::to_string(static_cast<int>(comps[i])),
                foc);
        }
        sf::FloatRect rc = r.resetColor; rc.position.y = yy;
        button(rc, "RESET", false);
    }

    // 四种标记
    const MineType types[5] = {MineType::None, MineType::P1, MineType::M1, MineType::Pi, MineType::Mi};
    for (int i = 1; i <= 4; ++i) {
        if (!inView(r.field[i].position.y, 26.f)) continue;
        const float yy = scrollY(r.field[i].position.y);
        const char* names[5] = {"", "+1 MARKER", "-1 MARKER", "+i MARKER", "-i MARKER"};
        t.draw(textTLSpr(names[i], 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
        const std::string shown = markerChar_[i].empty() ? std::string(mineGlyph(types[i])) : markerChar_[i];
        sf::FloatRect f = r.field[i]; f.position.y = yy;
        box(f, shown, settingsFocus_ == i);
        sf::FloatRect br = r.browse[i]; br.position.y = yy;
        button(br, "IMAGE", false);
        sf::FloatRect cl = r.clear[i]; cl.position.y = yy;
        button(cl, "CLEAR", false);
        const std::string status = !markerChar_[i].empty() ? markerChar_[i]
                                   : !markerImage_[i].empty() ? fileName(markerImage_[i])
                                                              : std::string("(default)");
        t.draw(textTLSpr(status, 10.f, kInkSoft, cl.position.x + cl.size.x + 12.f, yy + 8.f));
    }

    // 空白格（翻开且周围无雷）自定义
    if (inView(r.blankField.position.y, 26.f)) {
        const float yy = scrollY(r.blankField.position.y);
        t.draw(textTLSpr("BLANK CELL", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
        const std::string shown = blankChar_.empty() ? std::string("(blank)") : blankChar_;
        sf::FloatRect f = r.blankField; f.position.y = yy;
        box(f, shown, settingsFocus_ == 10);
        sf::FloatRect br = r.blankBrowse; br.position.y = yy;
        button(br, "IMAGE", false);
        sf::FloatRect cl = r.blankClear; cl.position.y = yy;
        button(cl, "CLEAR", false);
        const std::string status = !blankChar_.empty() ? blankChar_
                                   : !blankImage_.empty() ? fileName(blankImage_)
                                                          : std::string("(default)");
        t.draw(textTLSpr(status, 10.f, kInkSoft, cl.position.x + cl.size.x + 12.f, yy + 8.f));
    }

    // 双击开格：条件不满足时的行为（三选一）
    {
        const float y = P.position.y + 372.f;
        if (inView(y, 26.f)) {
            const float yy = scrollY(y);
            t.draw(textTLSpr("CHORD ON FAIL", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
            const char* names[3] = {"SILENT", "HINT", "BOOM"};
            const int active = (chordFailMode_ == ChordFailMode::Silent) ? 0
                               : (chordFailMode_ == ChordFailMode::Boom) ? 2
                                                                         : 1;
            for (int i = 0; i < 3; ++i) {
                sf::FloatRect b = r.chordBtn[i]; b.position.y = yy + (r.chordBtn[i].position.y - y);
                sf::RectangleShape btn(b.size);
                btn.setPosition(b.position);
                btn.setFillColor(i == active ? kBtnActive : kBtnBg);
                btn.setOutlineColor(i == active ? kBtnActive : kBtnEdge);
                btn.setOutlineThickness(1.4f);
                t.draw(btn);
                t.draw(textSpr(names[i], 11.f, i == active ? sf::Color::White : kInk,
                            b.position.x + b.size.x * 0.5f,
                            b.position.y + b.size.y * 0.5f + 1.f, 0.4f));
            }
        }
    }

    // 双击判定时长（毫秒）：滑块 + 数值框
    {
        const float y = P.position.y + 414.f;
        if (inView(y, 26.f)) {
            const float yy = scrollY(y);
            t.draw(textTLSpr("DOUBLE-CLICK", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
            sf::FloatRect tr = r.dcTrack; tr.position.y = yy + (r.dcTrack.position.y - y);
            sf::RectangleShape track(tr.size);
            track.setPosition(tr.position);
            track.setFillColor(kBtnBg);
            track.setOutlineColor(kBtnEdge);
            track.setOutlineThickness(1.2f);
            t.draw(track);
            const float frac = static_cast<float>(doubleClickMs_ - kDoubleClickMinMs) /
                               static_cast<float>(kDoubleClickMaxMs - kDoubleClickMinMs);
            const float kx = tr.position.x + frac * tr.size.x;
            sf::CircleShape knob(6.f, 20);
            knob.setOrigin(sf::Vector2f(6.f, 6.f));
            knob.setPosition(sf::Vector2f(kx, tr.position.y + tr.size.y * 0.5f));
            knob.setFillColor(kBtnActive);
            t.draw(knob);
            const bool foc = (settingsFocus_ == 9);
            sf::FloatRect dv = r.dcValue; dv.position.y = yy;
            box(dv, (foc && !settingsEdit_.empty()) ? settingsEdit_ : std::to_string(doubleClickMs_), foc);
            t.draw(textTLSpr("ms", 11.f, kInkSoft, dv.position.x + dv.size.x + 8.f, yy + 7.f));
        }
    }

    // 装饰星光：密度 / 大小两条滑块 + 两个可点击输入的数值框（实时作用到特效层，无需重开面板）
    {
        const auto starRow = [&](const char* label, const sf::FloatRect& track, float frac,
                                 const std::string& value, const sf::FloatRect& vrect, int focusId,
                                 const char* prefix) {
            if (!inView(track.position.y - 12.f, 40.f)) return;
            const float yy = scrollY(track.position.y);
            t.draw(textTLSpr(label, 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
            sf::FloatRect tr = track; tr.position.y = yy;
            sf::RectangleShape bar(tr.size);
            bar.setPosition(tr.position);
            bar.setFillColor(kBtnBg);
            bar.setOutlineColor(kBtnEdge);
            bar.setOutlineThickness(1.2f);
            t.draw(bar);
            sf::CircleShape knob(6.f, 20);
            knob.setOrigin(sf::Vector2f(6.f, 6.f));
            knob.setPosition(sf::Vector2f(tr.position.x + std::clamp(frac, 0.f, 1.f) * tr.size.x,
                                          tr.position.y + tr.size.y * 0.5f));
            knob.setFillColor(kBtnActive);
            t.draw(knob);
            const bool foc = (settingsFocus_ == focusId);
            sf::FloatRect vb = vrect; vb.position.y = scrollY(vrect.position.y);
            box(vb, (foc && !settingsEdit_.empty()) ? std::string(prefix) + settingsEdit_ : value, foc);
        };
        const float fDensity = (starDensity_ - kStarDensityMin) / (kStarDensityMax - kStarDensityMin);
        std::ostringstream ss;
        ss << 'x' << std::fixed << std::setprecision(1) << starScale_;
        std::ostringstream ds;
        ds << std::fixed << std::setprecision(2) << starDensity_;
        starRow("STARS · DENSITY", r.starTrack, fDensity, ds.str(), r.starValue, 11, "");
        // 单位直接写在读数里：密度是「每 100×100 逻辑像素多少颗」，换局面后窗口面积变了，
        // 实际颗数与上限都会跟着变 —— 用户不该靠心算去猜「752 和 324 谁大」。
        if (inView(r.starTrack.position.y - 12.f, 40.f)) {
            const std::string note = ds.str() + " 颗/100×100px → 本窗口 ≈ " +
                                     std::to_string(effectiveStarCount()) + " 颗（上限 " +
                                     std::to_string(starCountForDensity(kStarDensityMax)) + " 颗）";
            t.draw(textTLSpr(note, 9.f, kInkSoft, P.position.x + 140.f,
                             scrollY(r.starTrack.position.y) + 18.f));
        }
        starRow("STARS · SIZE", r.scaleTrack, (starScale_ - kStarScaleMin) / (kStarScaleMax - kStarScaleMin),
                ss.str(), r.scaleValue, 12, "x");
    }

    // ANIM FX（动效总开关；桌面端唯一闸门 —— 没有系统「减少动态」可读，与网页端注释口径不同）
    if (inView(r.animBtn.position.y, 30.f)) {
        const float yy = scrollY(r.animBtn.position.y);
        t.draw(textTLSpr("ANIM FX · 动效", 12.f, kInkSoft, P.position.x + 22.f, yy + 7.f));
        sf::FloatRect b = r.animBtn; b.position.y = yy;
        button(b, animFx_ ? "ANIM FX: ON" : "ANIM FX: OFF", animFx_);
        t.draw(textTLSpr("关 = 全部动效退化为即时绘制", 9.f, kInkSoft, b.position.x + b.size.x + 12.f, yy + 8.f));
    }

    // 底部按钮与提示（固定不滚动）
    button(r.restoreAll, "RESTORE ALL", false);
    button(r.close, "CLOSE", true);
    t.draw(textTLSpr("click a box, then type (visible ASCII only; hex needs all 6 digits)", 10.f, kInkSoft,
                  P.position.x + 22.f, P.position.y + P.size.y - 38.f));
    t.draw(textTLSpr("config folder: " + ms::settingsDir(), 9.f, kInkSoft, P.position.x + 22.f,
                  P.position.y + P.size.y - 20.f));

    // 滚动条
    if (settingsTotalH_ > viewH + 1.f) {
        const float th = std::max(30.f, viewH * viewH / settingsTotalH_);
        const float ty = viewTop + (viewH - th) * (settingsMaxS_ > 0.f ? settingsScroll_ / settingsMaxS_ : 0.f);
        const float tx = P.position.x + P.size.x - 10.f;
        settingsTrackR_ = sf::FloatRect(sf::Vector2f(tx, viewTop), sf::Vector2f(3.f, viewH));
        settingsThumbR_ = sf::FloatRect(sf::Vector2f(tx, ty), sf::Vector2f(3.f, th));
        settingsGeoOk_ = true;
        sf::RectangleShape tr(sf::Vector2f(3.f, viewH));
        tr.setPosition(sf::Vector2f(tx, viewTop));
        tr.setFillColor(kBtnEdge);
        t.draw(tr);
        sf::RectangleShape tb(sf::Vector2f(3.f, th));
        tb.setPosition(sf::Vector2f(tx, ty));
        tb.setFillColor(kInkSoft);
        t.draw(tb);
    } else {
        settingsGeoOk_ = false;
    }
}

void Renderer::drawSetup(sf::RenderTarget& t) const {
    if (!setupOpen_ || !fontOk_) return;
    const SetupRects r = setupRects();

    sf::RectangleShape dim(sf::Vector2f(L_.winW, L_.winH));
    dim.setFillColor(displayColor(20, 30, 45, 120));
    t.draw(dim);

    sf::RectangleShape shadow(r.panel.size + sf::Vector2f(6.f, 6.f));
    shadow.setPosition(r.panel.position + sf::Vector2f(4.f, 4.f));
    shadow.setFillColor(displayColor(0, 0, 0, 60));
    t.draw(shadow);
    sf::RectangleShape panel(r.panel.size);
    panel.setPosition(r.panel.position);
    panel.setFillColor(kBtnBg);
    panel.setOutlineColor(kBtnActive);
    panel.setOutlineThickness(2.f);
    t.draw(panel);

    const sf::Vector2f P = r.panel.position;
    const float rowY = P.y + 52.f;
    const float rowH = 34.f;
    const float sy = rowY + 3.f * rowH + 10.f;

    t.draw(textTLSpr("CUSTOM GAME", 16.f, kInk, P.x + 18.f, P.y + 16.f, 0.5f));

    const auto stepper = [&](const sf::FloatRect& box, const char* glyph) {
        sf::RectangleShape b(box.size);
        b.setPosition(box.position);
        b.setFillColor(kBtnBg);
        b.setOutlineColor(kBtnEdge);
        b.setOutlineThickness(1.4f);
        t.draw(b);
        t.draw(textSpr(glyph, 16.f, kInk, box.position.x + box.size.x * 0.5f,
                    box.position.y + box.size.y * 0.5f + 1.f, 0.4f));
    };
    const auto label = [&](const std::string& s, float y) { t.draw(textTLSpr(s, 12.f, kInkSoft, P.x + 18.f, y + 8.f)); };
    // 范围提示与 SetupConfig::clampToBoard 同源：行列 5~屏幕上限，雷数 1~行列积-1（留首点一格）
    const auto range = [](int lo, int hi) { return " (" + std::to_string(lo) + "~" + std::to_string(hi) + ")"; };
    const auto value = [&](const std::string& s, float y, sf::Color col) {
        t.draw(textSpr(s, 16.f, col, P.x + 297.f, y + 13.f, 0.5f));
    };
    // 数字框：聚焦时画输入框 + 已输入文本（空则显示光标），否则显示数值
    const auto valueField = [&](int field, const std::string& textValue, float y, const sf::FloatRect& box) {
        if (setupFocus_ != field) {
            value(textValue, y, kInk);
            return;
        }
        sf::RectangleShape hl(box.size);
        hl.setPosition(box.position);
        hl.setFillColor(kHover);
        hl.setOutlineColor(kBtnActive);
        hl.setOutlineThickness(1.6f);
        t.draw(hl);
        const std::string shown = setupEdit_.empty() ? std::string("_") : setupEdit_;
        t.draw(textSpr(shown, 16.f, kInk, box.position.x + box.size.x * 0.5f,
                    box.position.y + box.size.y * 0.5f + 1.f, 0.5f));
    };

    label("ROWS" + range(5, std::max(5, setupCfg_.maxRows)), rowY);
    stepper(r.rowsMinus5, "--");
    stepper(r.rowsMinus, "-");
    valueField(1, std::to_string(setupCfg_.rows), rowY, r.rowsValue);
    stepper(r.rowsPlus, "+");
    stepper(r.rowsPlus5, "++");

    label("COLS" + range(5, std::max(5, setupCfg_.maxCols)), rowY + rowH);
    stepper(r.colsMinus5, "--");
    stepper(r.colsMinus, "-");
    valueField(2, std::to_string(setupCfg_.cols), rowY + rowH, r.colsValue);
    stepper(r.colsPlus, "+");
    stepper(r.colsPlus5, "++");

    label("MINES" + range(1, setupCfg_.capacity()), rowY + 2.f * rowH);
    if (setupCfg_.splitManual) {
        value(std::to_string(setupCfg_.mines()) + "=r+i", rowY + 2.f * rowH, kZeroHint);
    } else {
        stepper(r.minesMinus5, "--");
        stepper(r.minesMinus, "-");
        valueField(3, std::to_string(setupCfg_.mines()), rowY + 2.f * rowH, r.minesValue);
        stepper(r.minesPlus, "+");
        stepper(r.minesPlus5, "++");
    }

    if (!setupCfg_.splitManual) {
        sf::RectangleShape b(r.splitBtn.size);
        b.setPosition(r.splitBtn.position);
        b.setFillColor(kBtnBg);
        b.setOutlineColor(kBtnEdge);
        b.setOutlineThickness(1.4f);
        t.draw(b);
        t.draw(textSpr("SET SPLIT", 11.f, kInk, r.splitBtn.position.x + r.splitBtn.size.x * 0.5f,
                    r.splitBtn.position.y + r.splitBtn.size.y * 0.5f, 0.4f));
        t.draw(textTLSpr("mines -> random real/imag split", 11.f, kInkSoft,
                      r.splitBtn.position.x + r.splitBtn.size.x + 12.f, sy + 8.f));
    } else {
        const int cap = std::max(1, setupCfg_.capacity());
        const auto slider = [&](const sf::FloatRect& track, int v, const std::string& name, sf::Color col) {
            t.draw(textTLSpr(name, 11.f, kInkSoft, P.x + 18.f, track.position.y - 3.f));
            sf::RectangleShape bg(track.size);
            bg.setPosition(track.position);
            bg.setFillColor(kPanel);
            t.draw(bg);
            const float frac = static_cast<float>(v) / static_cast<float>(cap);
            sf::RectangleShape fill(sf::Vector2f(track.size.x * frac, track.size.y));
            fill.setPosition(track.position);
            fill.setFillColor(col);
            t.draw(fill);
            sf::CircleShape knob(8.f, 20);
            knob.setOrigin(sf::Vector2f(8.f, 8.f));
            knob.setPosition(sf::Vector2f(track.position.x + track.size.x * frac,
                                          track.position.y + track.size.y * 0.5f));
            knob.setFillColor(kBtnBg);
            knob.setOutlineColor(col);
            knob.setOutlineThickness(2.f);
            t.draw(knob);
            t.draw(textSpr(std::to_string(v), 13.f, col,
                        track.position.x + track.size.x + 26.f, track.position.y + 4.f, 0.5f));
        };
        slider(r.realTrack, setupCfg_.realCount, "REAL" + range(0, cap), kRealMine);
        slider(r.imagTrack, setupCfg_.imagCount, "IMAG" + range(0, cap), kImagMine);
        t.draw(textTLSpr("drag a slider: total = real + imag", 10.5f, kInkSoft, P.x + 18.f, sy + 66.f));
    }

    const auto bigBtn = [&](const sf::FloatRect& box, const char* name, bool primary) {
        sf::RectangleShape b(box.size);
        b.setPosition(box.position);
        b.setFillColor(primary ? kBtnActive : kBtnBg);
        b.setOutlineColor(primary ? kBtnActive : kBtnEdge);
        b.setOutlineThickness(1.6f);
        t.draw(b);
        t.draw(textSpr(name, 14.f, primary ? sf::Color::White : kInk,
                    box.position.x + box.size.x * 0.5f, box.position.y + box.size.y * 0.5f + 1.f, 0.5f));
    };
    bigBtn(r.startBtn, "START", true);
    bigBtn(r.cancelBtn, "CANCEL", false);
}

// 背景纹理必须在有 OpenGL 上下文之后加载（窗口/RenderTexture 创建完），故惰性加载
void Renderer::loadBackground() {
    if (bgOk_ || bgTried_) return; // 幂等：只尝试一次
    bgTried_ = true;
    const std::vector<std::string> bgCandidates = resourcePaths("bg.jpg");
    for (const auto& path : bgCandidates) {
        sf::Image img;
        // 内置图也走同一道闸：不只是为了统一，更是为了让「本文件只有一处
        // loadFromFile」成为可静态断言的不变量（见 tools/check_invariants.py）。
        if (!loadImageChecked(path, img)) continue;
        applyDisplayP3(img);
        if (!bgTex_.loadFromImage(img)) continue;
        bgTex_.setSmooth(true);
        bgSprite_.setTexture(bgTex_, true); // resetRect：否则空纹理构造留下的 0x0 矩形会画不出东西
        bgOk_ = true;
        if (std::getenv("MS_VERBOSE") != nullptr) std::fprintf(stderr, "[res] background: %s\n", path.c_str());
        break;
    }
}

void Renderer::drawOverlay(const Hud& hud, sf::RenderTarget& t) const {
    if (hud.phase == Phase::Playing || overlayHidden_) return; // 已点击隐藏

    const sf::Vector2f bandPos(0.f, L_.boardY + std::max(20.f, (L_.boardH - 134.f) * 0.5f));
    const sf::Vector2f bandSize(L_.winW, 178.f);
    sf::RectangleShape band(bandSize);
    band.setPosition(bandPos);
    band.setFillColor(displayColor(255, 255, 255, 216));
    t.draw(band);

    const bool win = hud.phase == Phase::Won;
    const sf::Color col = win ? displayColor(22, 128, 85) : displayColor(192, 57, 43);
    t.draw(textSpr(win ? "CLEARED" : "BOOM", 42.f, col, L_.winW * 0.5f, bandPos.y + 42.f, 1.f));
    t.draw(textSpr(win ? "all complex mines identified - click the round button to replay"
                    : "a complex mine detonated - click the round button to replay",
                 13.f, kInkSoft, L_.winW * 0.5f, bandPos.y + 82.f));
    // 终局二选按钮：再玩同一局 / 开新局（语义在 main 分派）
    {
        sf::FloatRect bSame, bNew; overlayBtnRects(bSame, bNew);
        const sf::Vector2f mp{static_cast<float>(mousePx_.x), static_cast<float>(mousePx_.y)};
        const auto ob = [&](const sf::FloatRect& r, const char* lb) {
            const bool hov = r.contains(mp);
            sf::RectangleShape s(r.size); s.setPosition(r.position);
            s.setFillColor(hov ? kBtnActive : kBtnBg);
            s.setOutlineColor(hov ? kBtnActive : kBtnEdge);
            s.setOutlineThickness(1.5f); t.draw(s);
            const sf::Vector2f c = r.position + r.size * 0.5f;
            t.draw(textSpr(lb, 12.f, hov ? sf::Color::White : kInk, c.x, c.y + 0.5f, 0.45f));
        };
        ob(bSame, "SAME ROUND"); ob(bNew, "NEW GAME");
    }
    // 中文提示（需要系统中文字体）
    if (fontCjkOk_) {
        const std::string hint = "单击框外可隐藏此提示";
        const float hintW = textWidthOf(fontCJK_, hint, 12.f, 0.f);
        t.draw(textCJKSpr(hint, 12.f, kInkSoft, L_.winW * 0.5f - hintW * 0.5f, bandPos.y + 150.f));
    }
}

// —— 终局二选按钮：矩形/命中同源（绘制与判定共用）——
void Renderer::overlayBtnRects(sf::FloatRect& sameBtn, sf::FloatRect& newBtn) const {
    const float y = L_.boardY + std::max(20.f, (L_.boardH - 134.f) * 0.5f) + 104.f;
    const float w = 118.f, h = 26.f, gap = 10.f;
    const float x0 = L_.winW * 0.5f - (w * 2 + gap) * 0.5f;
    sameBtn = sf::FloatRect(sf::Vector2f(x0, y), sf::Vector2f(w, h));
    newBtn = sf::FloatRect(sf::Vector2f(x0 + w + gap, y), sf::Vector2f(w, h));
}
Renderer::OverlayHit Renderer::overlayHit(sf::Vector2i px) const {
    if (!playAgainVisible_ || overlayHidden_) return OverlayHit::None; // 终局且横幅可见才可点
    const sf::Vector2f p(static_cast<float>(px.x), static_cast<float>(px.y));
    sf::FloatRect a, b; overlayBtnRects(a, b);
    if (a.contains(p)) return OverlayHit::SameRound;
    if (b.contains(p)) return OverlayHit::NewGame;
    return OverlayHit::None;
}
// 画背景图（cover 铺满，居中），alpha 控制不透明度
void Renderer::drawBackgroundSprite(sf::RenderTarget& t, std::uint8_t alpha) {
    // 纯色背景：铺满整窗，**不吃 alpha** —— 用户输的颜色就该原样出现，
    // 再按不透明度混一层窗口底色的话，#101020 会变成一片灰，看着像坏了。
    // （网页端同口径：纯色直接 fillRect，OPACITY 只作用于图片。）
    if (bgColorMode_) {
        sf::RectangleShape full(sf::Vector2f(L_.winW, L_.winH));
        full.setPosition(sf::Vector2f(0.f, 0.f));
        full.setFillColor(displayColor(bgSolid_.r, bgSolid_.g, bgSolid_.b));
        t.draw(full);
        return;
    }
    if (!bgOk_) return;
    const sf::Vector2u ts = bgTex_.getSize();
    const float sc = std::max(L_.winW / static_cast<float>(ts.x), L_.winH / static_cast<float>(ts.y));
    bgSprite_.setTextureRect(sf::IntRect(sf::Vector2i(0, 0),
                                         sf::Vector2i(static_cast<int>(ts.x), static_cast<int>(ts.y))));
    bgSprite_.setScale(sf::Vector2f(sc, sc));
    bgSprite_.setPosition(sf::Vector2f((L_.winW - static_cast<float>(ts.x) * sc) * 0.5f,
                                       (L_.winH - static_cast<float>(ts.y) * sc) * 0.5f));
    bgSprite_.setColor(displayColor(255, 255, 255, alpha));
    t.draw(bgSprite_);
}

// 把背景图的对应区域画进指定窗口矩形：用"纹理矩形裁剪"，与整窗层保持 1:1 映射，
// 两个方向用同一个缩放比 => 严格等比、不拉伸（View 裁剪会按视口尺寸缩放，绝不能用）。
void Renderer::drawBackgroundSpriteIn(sf::RenderTarget& t, std::uint8_t alpha, const sf::FloatRect& rect) {
    if (!bgOk_) return;
    const sf::Vector2u ts = bgTex_.getSize();
    const float sc = std::max(L_.winW / static_cast<float>(ts.x), L_.winH / static_cast<float>(ts.y));
    const float ox = (L_.winW - static_cast<float>(ts.x) * sc) * 0.5f;
    const float oy = (L_.winH - static_cast<float>(ts.y) * sc) * 0.5f;
    int tx = static_cast<int>(std::floor((rect.position.x - ox) / sc));
    int ty = static_cast<int>(std::floor((rect.position.y - oy) / sc));
    int tw = std::max(1, static_cast<int>(std::ceil(rect.size.x / sc)));
    int th = std::max(1, static_cast<int>(std::ceil(rect.size.y / sc)));
    if (tx < 0) { tw += tx; tx = 0; }
    if (ty < 0) { th += ty; ty = 0; }
    if (tx + tw > static_cast<int>(ts.x)) tw = static_cast<int>(ts.x) - tx;
    if (ty + th > static_cast<int>(ts.y)) th = static_cast<int>(ts.y) - ty;
    if (tw <= 0 || th <= 0) return;
    bgSprite_.setTextureRect(sf::IntRect(sf::Vector2i(tx, ty), sf::Vector2i(tw, th)));
    bgSprite_.setScale(sf::Vector2f(sc, sc));
    bgSprite_.setPosition(sf::Vector2f(ox + static_cast<float>(tx) * sc, oy + static_cast<float>(ty) * sc));
    bgSprite_.setColor(displayColor(255, 255, 255, alpha));
    t.draw(bgSprite_);
}

// 鼠标当前悬停在种子菜单的第几项（-1 = 不在任何一项上）
int Renderer::seedMenuHoverIndex(sf::Vector2i px) const {
    const SeedHit h = seedHit(px);
    if (h == SeedHit::MenuCopy) return 0;
    if (h == SeedHit::MenuSave) return 1;
    if (h == SeedHit::MenuLoad) return 2;
    if (h == SeedHit::MenuTool) return 3;
    return -1;
}

// —————————————————————————— 装饰星光层 ——————————————————————————

static float frand01() {
    // 装饰专用随机数：独立于游戏的核心 RNG，否则「同一个种子复现同一局」就被破坏了
    static std::mt19937 g(std::random_device{}());
    static std::uniform_real_distribution<float> u(0.f, 1.f);
    return u(g);
}

// 与网页端 hsl(H 85% 62%) 同一算法，出来再走 Display P3 预补偿
static sf::Color hslColor(float h, float s, float l, std::uint8_t a) {
    const float c = (1.f - std::fabs(2.f * l - 1.f)) * s;
    const float hp = std::fmod(h < 0.f ? 360.f + h : h, 360.f) / 60.f;
    const float x = c * (1.f - std::fabs(std::fmod(hp, 2.f) - 1.f));
    float r = 0.f, g = 0.f, b = 0.f;
    if (hp < 1.f) { r = c; g = x; } else if (hp < 2.f) { r = x; g = c; }
    else if (hp < 3.f) { g = x; b = c; } else if (hp < 4.f) { g = c; b = x; }
    else if (hp < 5.f) { r = c; b = x; } else { r = x; b = c; }
    const float m = l - c * 0.5f;
    const auto to255 = [](float v) { return static_cast<std::uint8_t>(std::clamp(v, 0.f, 1.f) * 255.f + 0.5f); };
    return displayColor(to255(r + m), to255(g + m), to255(b + m), a);
}

// 光斑贴图：64×64，逐像素算径向衰减后一次性上传。
// 用同心圆叠画是**错的**（alpha 混合会互相覆盖，衰减曲线走样），所以直接写像素。
// 衰减：a = (1 - d²)^p，p 由 kGlowMid 反解（保证「1/3 半径处 alpha = kGlowMid」这条老约定），
// 但曲线是一条没有折点的平滑尾巴 —— 老的「1/3 处折一下」在放大成 90-120px 时会显形。
// 颜色**纯白**：靠 Sprite::setColor 乘出各档配色（以前烘死成白→#66CCFF，染黄色会变绿）。
// 网页端用 createRadialGradient 的 8 个 colorStop 表达同一条曲线。
void Renderer::ensureGlowTex() {
    if (glowTried_) return; // 幂等：只生成一次（和 bgTried_ 同一套路）
    glowTried_ = true;
    using namespace starfx;
    const unsigned n = kGlowTex;
    sf::Image img;
    img.resize(sf::Vector2u(n, n));
    const float c = static_cast<float>(n) * 0.5f;
    const float p = std::log(kGlowMid) / std::log(8.f / 9.f);   // (1 - (1/3)²) = 8/9
    for (unsigned y = 0; y < n; ++y) {
        for (unsigned x = 0; x < n; ++x) {
            const float dx = static_cast<float>(x) + 0.5f - c;
            const float dy = static_cast<float>(y) + 0.5f - c;
            float d = std::sqrt(dx * dx + dy * dy) / c; // 0 核 → 1 边缘
            if (d > 1.f) d = 1.f;
            const float a = std::pow(std::max(0.f, 1.f - d * d), p);
            img.setPixel(sf::Vector2u(x, y),
                         sf::Color(255, 255, 255, static_cast<std::uint8_t>(a * 255.f + 0.5f)));
        }
    }
    if (!glowTex_.loadFromImage(img)) glowTex_ = sf::Texture(); // 失败就当没有光晕：只画星核，别崩
    glowTex_.setSmooth(true);
}

// 四芒：两片细长菱形，沿长度用**逐顶点颜色**做渐隐（头亮尾透）。
// SFML 没有渐变填充，这是最接近的做法：TriangleFan 中心顶点亮、两端顶点透明。
void Renderer::drawCross(float x, float y, float armX, float armY, float halfW, float alpha,
                         sf::RenderTarget& t, float rot) {
    if (alpha <= 0.004f) return;
    const float w = std::max(0.45f, halfW);
    const float arms[2] = {armX, armY};
    // 两条臂的**单位方向**。rot = 0 时就是 (1,0)/(0,1)，与原来的水平/垂直完全一致，
    // 所以不传 rot 的调用点（流星头、耀斑、大星）行为不变。
    const float cs = std::cos(rot), sn = std::sin(rot);
    const float dirs[2][2] = {{cs, sn}, {-sn, cs}};
    for (int axis = 0; axis < 2; ++axis) {
        const float arm = arms[axis];
        if (arm <= 0.5f) continue;
        const float dx = dirs[axis][0], dy = dirs[axis][1];
        const sf::Color hot = displayColor(255, 255, 255, static_cast<std::uint8_t>(alpha * 255.f));
        const sf::Color cold = displayColor(255, 255, 255, 0);
        sf::VertexArray v(sf::PrimitiveType::TriangleFan);
        v.append(sf::Vertex(sf::Vector2f(x, y), hot));                                     // 中心最亮
        v.append(sf::Vertex(sf::Vector2f(x + dx * arm, y + dy * arm), cold));              // 尖
        v.append(sf::Vertex(sf::Vector2f(x + dy * w, y + dx * w), cold));
        v.append(sf::Vertex(sf::Vector2f(x - dx * arm, y - dy * arm), cold));
        v.append(sf::Vertex(sf::Vector2f(x - dy * w, y - dx * w), cold));
        t.draw(v);
    }
}

// 细圆环：照片里那圈很淡、很细的环（SFML 的 outline 从标称半径**向外长**，
// 和 canvas 的 stroke 居中不同，所以半径要减掉半个线宽才对得上）
void Renderer::drawRing(float x, float y, float r, float w, const sf::Color& col, float alpha,
                        sf::RenderTarget& t) {
    if (r <= 1.f || alpha <= 0.004f) return;
    const float th = std::max(0.5f, w);          // 注意别叫 t：参数 t 是 RenderTarget
    const float rr = std::max(0.5f, r - th * 0.5f);
    sf::CircleShape ring(rr, 64);
    ring.setOrigin(sf::Vector2f(rr, rr));
    ring.setPosition(sf::Vector2f(x, y));
    // 环内填一层很淡的同色（只描边是"铁丝圈"，填了像玻璃球）。
    // 填充画到 rr = r - 半个线宽 为止，描边从 rr 向外长，所以两者刚好拼接、不叠色。
    ring.setFillColor(sf::Color(col.r, col.g, col.b,
                                static_cast<std::uint8_t>(std::clamp(alpha * starfx::kRingFillA, 0.f, 1.f) * 255.f)));
    ring.setOutlineThickness(th);
    ring.setOutlineColor(sf::Color(col.r, col.g, col.b, static_cast<std::uint8_t>(alpha * 255.f)));
    t.draw(ring);
}

// 光点：柔光球 → 四芒 → 细环 → 高亮核。流星、背景大星、爆圈共用。
void Renderer::drawOrb(float x, float y, float R, int hue, float alpha, bool withRing, sf::RenderTarget& t) {
    if (R <= 0.f || alpha <= 0.004f) return;
    using namespace starfx;
    const int hi = (hue >= 0 && hue < kMeteorColCount) ? hue : 0;
    const sf::Color base = kMeteorCols[hi];
    if (glowTex_.getSize().x > 0) {
        sf::Sprite halo(glowTex_);
        const float d = R * kMeteorGlow;
        const sf::Vector2f ts(glowTex_.getSize());
        halo.setScale(sf::Vector2f(d / ts.x, d / ts.y));
        halo.setOrigin(sf::Vector2f(ts.x * 0.5f, ts.y * 0.5f));
        halo.setPosition(sf::Vector2f(x, y));
        halo.setColor(sf::Color(base.r, base.g, base.b, static_cast<std::uint8_t>(alpha * 255.f)));
        t.draw(halo);
    }
    // 环（含内填充）先画、四芒后画：让十字压在玻璃球上面，和网页端一致
    if (withRing) drawRing(x, y, R * kMeteorRingR, R * kMeteorRingW, base, alpha * kMeteorRingA, t);
    drawCross(x, y, R * kMeteorCrossLen, R * kMeteorCrossLen, R * kMeteorCrossW,
              alpha * kMeteorCrossA, t);
    const float cr = std::max(0.7f, R * kMeteorCoreR);
    sf::CircleShape core(cr, 16);
    core.setOrigin(sf::Vector2f(cr, cr));
    core.setPosition(sf::Vector2f(x, y));
    core.setFillColor(displayColor(255, 255, 255, static_cast<std::uint8_t>(alpha * 255.f)));
    t.draw(core);
}

Renderer::Spark Renderer::newSpark(bool anywhere) {
    using namespace starfx;
    Spark s;
    const float vw = L_.winW, vh = L_.winH;
    s.x0 = frand01() * vw;
    s.x = s.x0;
    // anywhere=false 时从**下边缘**补进来，看着像源源不断飘上来，而不是凭空刷新
    s.y = anywhere ? frand01() * vh : vh + 8.f + frand01() * 24.f;
    s.vx = (frand01() - 0.5f) * 6.f;
    s.vy = -(kRiseMin + frand01() * (kRiseMax - kRiseMin));
    // 幂律半径：均匀分布会让满屏都是同样大的点（灰尘感主因），幂律把大多数压到 <1.2px
    const float u = frand01();
    s.r = kRBase + kRSpan * std::pow(u, kRPow);
    s.ph = frand01() * 2.f * kPi;
    s.sp = kTwSpMin + frand01() * (kTwSpMax - kTwSpMin);
    // 按权重抽配色档。索引就是 kMeteorCols 的下标 —— 星星和流星**共用同一套颜色**：
    //   0 白 / 1 淡黄 / 2 淡粉 / 3 浅绿 / 4 浅蓝
    // 权重按名字配（蓝不是第 2 个），所以映射写死；别改成「按调色板顺序」。
    // 乘总权重是为了五个数万一不加到 1 也不会漏档。
    {
        const float tot = kWhiteW + kBlueW + kWarmW + kPinkW + kGreenW;
        float cw = frand01() * tot;
        if ((cw -= kWhiteW) < 0.f) s.hue = 0;          // 白
        else if ((cw -= kBlueW) < 0.f) s.hue = 4;      // 浅蓝
        else if ((cw -= kWarmW) < 0.f) s.hue = 1;      // 淡黄
        else if ((cw -= kPinkW) < 0.f) s.hue = 2;      // 淡粉
        else s.hue = 3;                                // 浅绿
    }
    s.sizeClass = s.r < 1.2f ? 0 : (s.r < 2.f ? 1 : 2);
    s.amp = kSwayAmpMin + frand01() * (kSwayAmpMax - kSwayAmpMin);
    s.omega = kSwayOmegaMin + frand01() * (kSwayOmegaMax - kSwayOmegaMin);
    s.swPhase = frand01() * 2.f * kPi;
    s.flare = frand01() < kFlareProb;
    if (s.flare) {
        // 耀斑星同时存活上限：满额就降级成普通星，别让一屏都是十字光条
        int n = 0;
        for (const auto& o : sparks_) if (o.flare) ++n;
        if (n >= kFlareMax) s.flare = false;
    }
    s.unit = !s.flare && frand01() < kUnitProb; // 两者互斥：一颗星别既是耀斑又是单位圆
    if (s.unit) s.r = kUnitRMin + frand01() * (kUnitRMax - kUnitRMin);
    for (int i = 0; i < kTrailFrames; ++i) { s.hx[i] = s.x; s.hy[i] = s.y; }
    s.hn = 0;
    return s;
}

// 单颗星的完整画法：拖尾 → 光晕 → 星核 → 形状（✦ / 耀斑十字 / 单位圆）。
// 顺序不能乱：光晕是半透明大图，先画才不会盖住星核。
void Renderer::drawStar(const Spark& s, sf::RenderTarget& t) {
    using namespace starfx;
    // 闪烁：sin 的 6 次幂 → 绝大多数时间很暗、偶尔「骤亮」。
    // 旧的 0.18+0.44·(0.5+0.5·sin) 是匀速呼吸，那是灰尘感的来源之一。
    const float sn = std::max(0.f, std::sin(s.ph));
    const float a = std::clamp(kTwBase + kTwAmp * std::pow(sn, kTwPow), 0.f, 1.f);
    const std::uint8_t al = static_cast<std::uint8_t>(a * 255.f);
    if (al == 0) return;
    const float rr = std::max(0.3f, s.r * starScale_);
    const auto tint = [al](const sf::Color& c) { return sf::Color(c.r, c.g, c.b, al); };
    // 配色与流星同一套（kMeteorCols），光晕也跟着这颗星的色走
    const int hi = (s.hue >= 0 && s.hue < kMeteorColCount) ? s.hue : 0;
    const sf::Color coreBase = kMeteorCols[hi];
    const sf::Color core = tint(coreBase);
    const sf::Vector2f p(s.x, s.y);

    // 短拖尾：只给大星/耀斑星画，2-3 段历史位置，越旧越淡
    if (s.hn > 0 && (s.sizeClass == 2 || s.flare)) {
        sf::Vector2f from = p;
        for (int i = 0; i < s.hn; ++i) {
            const sf::Vector2f to(s.hx[i], s.hy[i]);
            const float k = 1.f - static_cast<float>(i + 1) / static_cast<float>(starfx::kTrailFrames + 1);
            const sf::Color tc = sf::Color(core.r, core.g, core.b, static_cast<std::uint8_t>(a * 0.35f * k * 255.f));
            const sf::Vertex seg[2] = {sf::Vertex(from, tc), sf::Vertex(to, tc)};
            t.draw(seg, 2, sf::PrimitiveType::Lines);
            from = to;
        }
    }

    // 光晕：星核 <1px 时退化成纯圆点（贴一张 7px 的柔光在亚像素点上只会糊成灰雾）
    if (rr >= 1.f && glowTex_.getSize().x > 0) {
        sf::Sprite halo(glowTex_);
        const float d = rr * 2.f * kHaloRatio;
        const sf::Vector2f ts(glowTex_.getSize());
        halo.setScale(sf::Vector2f(d / ts.x, d / ts.y));
        halo.setOrigin(sf::Vector2f(ts.x * 0.5f, ts.y * 0.5f));
        halo.setPosition(p);
        halo.setColor(sf::Color(coreBase.r, coreBase.g, coreBase.b, static_cast<std::uint8_t>(a * 0.85f * 255.f)));
        t.draw(halo);
    }

    // 星核
    sf::CircleShape dot(rr, 12);
    dot.setOrigin(sf::Vector2f(rr, rr));
    dot.setPosition(p);
    dot.setFillColor(core);
    t.draw(dot);

    if (s.unit) {
        // 单位圆彩蛋：空心圆 + 一条半径线（复数平面意象，呼应应用图标）
        sf::CircleShape ring(rr, 20);
        ring.setOrigin(sf::Vector2f(rr, rr));
        ring.setPosition(p);
        ring.setFillColor(sf::Color::Transparent);
        ring.setOutlineColor(tint(kUnitCol));
        ring.setOutlineThickness(0.8f);
        t.draw(ring);
        const float ang = s.swPhase; // 半径线方向随星而定，但一颗星内不转（转了像加载动画）
        const sf::Vertex rl[2] = {
            sf::Vertex(p, tint(kUnitCol)),
            sf::Vertex(sf::Vector2f(s.x + std::cos(ang) * rr, s.y + std::sin(ang) * rr), tint(kUnitCol)),
        };
        t.draw(rl, 2, sf::PrimitiveType::Lines);
    } else if (s.flare) {
        // 耀斑十字长条：三段递减 alpha/长度，横 14r、竖 10r
        for (int k = 0; k < 3; ++k) {
            const float shrink = 1.f - static_cast<float>(k) * 0.3f;
            const float hlen = rr * kFlareH * shrink;
            const float vlen = rr * kFlareV * shrink;
            const float th = std::max(0.6f, rr * (0.9f - 0.25f * static_cast<float>(k)));
            const std::uint8_t fa = static_cast<std::uint8_t>(a * (1.f - 0.33f * static_cast<float>(k)) * 160.f);
            const sf::Color fc = sf::Color(kFlareCol.r, kFlareCol.g, kFlareCol.b, fa);
            sf::RectangleShape hbar(sf::Vector2f(hlen * 2.f, th));
            hbar.setOrigin(sf::Vector2f(hlen, th * 0.5f));
            hbar.setPosition(p);
            hbar.setFillColor(fc);
            t.draw(hbar);
            sf::RectangleShape vbar(sf::Vector2f(th, vlen * 2.f));
            vbar.setOrigin(sf::Vector2f(th * 0.5f, vlen));
            vbar.setPosition(p);
            vbar.setFillColor(fc);
            t.draw(vbar);
        }
    } else if (s.sizeClass == 2) {
        // 大星：内凹四角尖星 ✦（8 顶点三角扇：尖 3.2r、凹 0.9r 交替）
        // ★ 用户 2026-10-21 明确要求：背景星星保持「五色混合 + 好几种形状」的老样子，
        //   不要跟着流星改成四芒+圆环。流星头 / 爆圈才是照片那套。
        sf::VertexArray fan(sf::PrimitiveType::TriangleFan);
        fan.append(sf::Vertex(p, core));
        for (int i = 0; i < 8; ++i) {
            const float ang = static_cast<float>(i) * kPi * 0.25f;
            const float len = (i % 2 == 0 ? kBigSpike : kBigInner) * rr;
            fan.append(sf::Vertex(sf::Vector2f(s.x + std::cos(ang) * len, s.y + std::sin(ang) * len), core));
        }
        fan.append(sf::Vertex(sf::Vector2f(s.x + kBigSpike * rr, s.y), core)); // 闭合
        t.draw(fan);
    }
}

// ═══ 流星雨 ═══
// 每 kShowerPeriod 秒来一批、kShowerCount 颗均匀撒在 kShowerSpan 秒内。
// 拖尾不存历史位置，而是沿 -v 反推采样点 —— 流星是直线运动，反推与真历史等价且零状态。
// 速度在出生时按「到出屏点的距离 ÷ 寿命」导出，所以屏幕上正好停留 3-4.5 秒；
// 飞行途中改窗口尺寸不重算（可能提前/延后出屏），出屏即杀仍然兜底。
void Renderer::spawnMeteor() {
    using namespace starfx;
    if (static_cast<int>(meteors_.size()) >= kMeteorMax) return;
    const float vw = L_.winW, vh = L_.winH;
    const float ang = (kMeteorAngMin + frand01() * (kMeteorAngMax - kMeteorAngMin)) * kPi / 180.f;
    const float dir = frand01() < 0.5f ? -1.f : 1.f; // 向左下或右下划
    const float ux = std::cos(ang) * dir, uy = std::sin(ang); // uy 恒正，一定往下走
    Meteor m;
    m.x = dir < 0.f ? vw * (0.35f + frand01() * 0.7f) : vw * (0.05f + frand01() * 0.6f);
    m.y = -12.f;
    // 沿这条射线还能走多远才彻底出屏（与淘汰条件同一套边界）
    const float dY = (vh + 40.f - m.y) / uy;
    const float dX = ux < 0.f ? (m.x + 80.f) / -ux : (vw + 80.f - m.x) / ux;
    m.maxLife = kMeteorLifeMin + frand01() * (kMeteorLifeMax - kMeteorLifeMin);
    m.life = m.maxLife;
    const float sp = std::min(dX, dY) / m.maxLife;
    m.vx = ux * sp;
    m.vy = uy * sp;
    m.trailSec = kMeteorTrailMin + frand01() * (kMeteorTrailMax - kMeteorTrailMin);
    m.headR = kMeteorHeadMin + frand01() * (kMeteorHeadMax - kMeteorHeadMin);
    // 颜色档数用 sizeof 推，别新增一个 constexpr 计数 —— T57 会把桌面端的每个
    // constexpr 数拿去和网页端逐个比对，多一个常量就会报「只在一端」。
    m.hue = static_cast<int>(frand01() * static_cast<float>(kMeteorColCount));
    if (m.hue < 0 || m.hue >= kMeteorColCount) m.hue = 0;
    meteors_.push_back(m);
}

void Renderer::drawOneMeteor(const Meteor& m, sf::RenderTarget& t) {
    using namespace starfx;
    // 淡入淡出：u 从 0（出生）到 1（消亡），sin 包络两头都收干净
    const float u = 1.f - std::clamp(m.life / m.maxLife, 0.f, 1.f);
    const float env = std::sin(kPi * u);
    if (env <= 0.01f) return;
    const float sp = std::sqrt(m.vx * m.vx + m.vy * m.vy);
    if (sp <= 0.001f) return;
    const float headR = m.headR;
    const float back = sp * m.trailSec;
    const sf::Color tint = kMeteorCols[(m.hue >= 0 && m.hue < kMeteorColCount) ? m.hue : 0];
    const float ux = m.vx / sp, uy = m.vy / sp;
    const float nx = -uy, ny = ux;                 // 法线：把中心线撑成一条带
    const float hw = std::max(0.35f, headR * kTrailHeadW);

    // 拖尾：**一条渐窄三角带 + 逐顶点 alpha**（头亮尾透）。
    // 旧版是 80 个 CircleShape 串成的珠子（又粗又断，还 80 次 draw call），现在是 1 次。
    // 桌面端没开 MSAA，发丝级斜线会硬锯齿 → 画**两层**：外层宽一倍、alpha 减半当柔边，
    // 内层正常宽度当芯，等效一次廉价的超采样。网页端由浏览器抗锯齿，不需要这层。
    for (int layer = 0; layer < 2; ++layer) {
        const float wScale = layer == 0 ? 2.f : 1.f;
        const float aScale = layer == 0 ? 0.5f : 1.f;
        sf::VertexArray strip(sf::PrimitiveType::TriangleStrip);
        const int n = kMeteorSamples;
        for (int i = 0; i <= n; ++i) {
            const float f = static_cast<float>(i) / static_cast<float>(n);
            const float w = hw * std::pow(1.f - f, 0.7f) * wScale;
            const float cx = m.x - ux * back * f;
            const float cy = m.y - uy * back * f;
            const float al = env * std::pow(1.f - f, 1.1f) * aScale;
            const std::uint8_t a8 = static_cast<std::uint8_t>(std::clamp(al, 0.f, 1.f) * 235.f);
            const sf::Color c(tint.r, tint.g, tint.b, a8);
            strip.append(sf::Vertex(sf::Vector2f(cx + nx * w, cy + ny * w), c));
            strip.append(sf::Vertex(sf::Vector2f(cx - nx * w, cy - ny * w), c));
        }
        t.draw(strip);
    }

    // 头部：高亮核 + 柔光球 + 四芒 + 细环（与背景大星、爆圈同一套配方）
    // 收一档 alpha：9×R 的光球全亮会把底下棋盘/顶栏的文字洗白（原来的光晕就压到 0.5）
    drawOrb(m.x, m.y, headR, m.hue, env * 0.72f, true, t);
}

void Renderer::updateMeteors(float dt, sf::RenderTarget& t) {
    using namespace starfx;
    const float vw = L_.winW, vh = L_.winH;
    // 批次调度：每批的颗数 / 铺开时长 / 下一批间隔都随机
    // （20~30 颗铺 15~20 秒，1~1.5 分钟一场 —— 60~90 秒是**批次起点到起点**）。
    // 计时器只在批次间隙走，所以开批时先扣掉本批的铺开时长，否则实际会变成「放完再等 60~90 秒」。
    if (showerLeft_ <= 0) {
        showerTimer_ -= dt;
        if (showerTimer_ <= 0.f) {
            showerLeft_ = kShowerCountMin +
                          static_cast<int>(frand01() * static_cast<float>(kShowerCountMax - kShowerCountMin + 1));
            const float span = kShowerSpanMin + frand01() * (kShowerSpanMax - kShowerSpanMin);
            showerGapStep_ = span / static_cast<float>(showerLeft_);
            showerGap_ = 0.f;
            showerTimer_ = kShowerPeriodMin + frand01() * (kShowerPeriodMax - kShowerPeriodMin) - span;
        }
    } else {
        showerGap_ -= dt;
        // 用 while 而不是 if：掉帧时一帧可能跨过好几个间隔，这里一次补足不留空档
        while (showerGap_ <= 0.f && showerLeft_ > 0) {
            spawnMeteor();
            --showerLeft_;
            showerGap_ += showerGapStep_;
        }
    }
    for (auto it = meteors_.begin(); it != meteors_.end();) {
        it->life -= dt;
        // ★ 撞到视口边界就炸一圈，而不是静默消失。
        //   **必须先判边界再看寿命**：maxLife 是按「到出屏点的距离 ÷ 速度」导出的，
        //   寿命归零和越过边界几乎同时发生 —— 先判寿命的话流星会被悄悄删掉、根本不炸，
        //   两条都判又会炸两次。边界命中就直接 continue，只炸一次。
        if (it->y >= vh || it->x <= 0.f || it->x >= vw) {
            const float j = 1.f + (frand01() * 2.f - 1.f) * kRippleJitter;
            const float r1 = kRippleR1 * j;
            // 炸点往里收 15% 半径，不然半个环在画外，看着像被切掉
            const float cx = std::min(vw - r1 * 0.15f, std::max(r1 * 0.15f, it->x));
            const float cy = std::min(vh - r1 * 0.15f, std::max(r1 * 0.15f, it->y));
            spawnRippleAt(cx, cy, it->hue, r1);
            it = meteors_.erase(it);
            continue;
        }
        if (it->life <= 0.f) {   // 数值兜底，正常碰不到
            it = meteors_.erase(it);
            continue;
        }
        it->x += it->vx * dt;
        it->y += it->vy * dt;
        ++it;
    }
    for (const auto& m : meteors_) drawOneMeteor(m, t);
}

// ═══ 点爆流星 ═══
// 左键打中流星才炸（不是点哪都炸）：取离点击点最近的、且在命中半径内的那一颗，
// 把它从池里去掉，并在它的位置上炸出一圈扩散环。返回是否真的打中了。
// 命中半径按**这颗星**的头部外半径放宽（kRippleHit 倍）—— 星头只有 10-14px，
// 不放宽的话在 1280 宽的屏上几乎点不中。
bool Renderer::fxRipple(sf::Vector2i px) {
    using namespace starfx;
    int hit = -1;
    float bestD = std::numeric_limits<float>::max();
    for (int i = 0; i < static_cast<int>(meteors_.size()); ++i) {
        const sf::Vector2f d(std::abs(meteors_[i].x - static_cast<float>(px.x)),
                             std::abs(meteors_[i].y - static_cast<float>(px.y)));
        const float dist = std::sqrt(d.x * d.x + d.y * d.y);
        if (dist <= meteors_[i].headR * kRippleHit && dist < bestD) { bestD = dist; hit = i; }
    }
    if (hit < 0) return false;
    const Meteor m = meteors_[hit];
    meteors_.erase(meteors_.begin() + hit);       // 炸了就没了
    // 最终半径 = 基准 × (1 ± kRippleJitter)，每次都不一样，免得连着点看起来像复读
    const float jitter = 1.f + (frand01() * 2.f - 1.f) * kRippleJitter;
    spawnRippleAt(m.x, m.y, m.hue, kRippleR1 * jitter);
    return true;
}

// 造一个爆圈（点击命中 与 流星撞边界 共用）
void Renderer::spawnRippleAt(float x, float y, int hue, float r1) {
    FxRipple r;
    r.x = x;
    r.y = y;
    r.life = starfx::kRippleLife;
    r.maxLife = starfx::kRippleLife;
    r.hue = hue;
    r.r1 = r1;
    // 初角与转向都随机 —— 同一屏连炸两次时十字朝向不会一模一样
    r.rot0 = frand01() * kPi * 2.f;
    r.spin = (frand01() < 0.5f ? -1.f : 1.f) * starfx::kRippleSpin;
    fxRipples_.push_back(r);
    while (fxRipples_.size() > 8) fxRipples_.erase(fxRipples_.begin()); // 连点也不许堆出几十个环
}

void Renderer::drawRipples(float dt, sf::RenderTarget& t) {
    using namespace starfx;
    // 把配色压暗，给「浅色棋盘上的描边」用：流星的配色都是浅的，
    // 直接画在浅底上会糊掉，所以环外面再套一圈同色压暗的宽线。
    const auto shade = [](const sf::Color& c, float k) {
        return sf::Color(static_cast<std::uint8_t>(c.r * k), static_cast<std::uint8_t>(c.g * k),
                         static_cast<std::uint8_t>(c.b * k));
    };
    for (auto it = fxRipples_.begin(); it != fxRipples_.end();) {
        it->life -= dt;
        if (it->life <= 0.f) { it = fxRipples_.erase(it); continue; }
        const float p = 1.f - std::clamp(it->life / it->maxLife, 0.f, 1.f); // 0 → 1
        const float ease = 1.f - std::pow(1.f - p, 3.f);
        const float rad = kRippleR0 + (it->r1 - kRippleR0) * ease;
        // 1.1 而不是 1.6：指数越大掉得越快，实测 1.6 到 300ms 就淡到看不见了
        const float a = std::pow(1.f - p, 1.1f);
        // 圈的颜色跟被点爆那颗流星走
        const int hi = (it->hue >= 0 && it->hue < kMeteorColCount) ? it->hue : 0;
        const sf::Color base = kMeteorCols[hi];
        if (rad > 0.5f && a > 0.004f) {
            // 外柔光（同色压暗）
            sf::CircleShape soft(rad, 64);
            soft.setOrigin(sf::Vector2f(rad, rad));
            soft.setPosition(sf::Vector2f(it->x, it->y));
            soft.setFillColor(sf::Color::Transparent);
            soft.setOutlineThickness(std::max(1.f, kRippleWidth * (1.f - 0.55f * p)) + 3.2f);
            sf::Color sc = shade(base, 0.66f);
            sc.a = static_cast<std::uint8_t>(a * 0.30f * 255.f);
            soft.setOutlineColor(sc);
            t.draw(soft);
            // 细实线（流星本色）
            sf::CircleShape ring(rad, 64);
            ring.setOrigin(sf::Vector2f(rad, rad));
            ring.setPosition(sf::Vector2f(it->x, it->y));
            ring.setFillColor(sf::Color::Transparent);
            ring.setOutlineThickness(std::max(0.6f, kRippleWidth * (1.f - 0.55f * p)));
            // 环内填一层淡同色（气泡感）。比头部更淡 —— 这个圈要扫过整个棋盘
            sf::Color fc = base;
            fc.a = static_cast<std::uint8_t>(std::clamp(a * kRingFillA * 0.6f, 0.f, 1.f) * 255.f);
            ring.setFillColor(fc);
            sf::Color rc = base;
            rc.a = static_cast<std::uint8_t>(a * 0.95f * 255.f);
            ring.setOutlineColor(rc);
            t.draw(ring);
        }
        // 中心四芒：等长细芒（照片里的十字是对称的），随扩散一起收掉
        // 臂长跟**当前**光圈半径走，恒定比它大 18% —— 光圈多大，光芒就多大。
        const float L = rad * kRippleCrossOverRing;
        // 角度按**已过秒数**积分（p 是 0→1 的进度，乘 maxLife 才是秒），
        // 这样转速是真正的 rad/s，改 kRippleLife 不会连带改变观感上的转速。
        const float ang = it->rot0 + it->spin * (p * it->maxLife);
        // 线宽按**最终**半径定（不随 L 变），臂越长越像发丝而不是越涨越粗
        if (L > 1.f)
            drawCross(it->x, it->y, L, L, std::max(0.6f, it->r1 * 0.04f), a * 0.9f, t, ang);
        // 中心亮核
        const float cr = std::max(0.8f, 3.2f * (1.f - p));
        sf::CircleShape core(cr, 16);
        core.setOrigin(sf::Vector2f(cr, cr));
        core.setPosition(sf::Vector2f(it->x, it->y));
        core.setFillColor(displayColor(255, 255, 255, static_cast<std::uint8_t>(a * 0.95f * 255.f)));
        t.draw(core);
        ++it;
    }
}

void Renderer::fxBurst(sf::Vector2i px) {
    if (!ustcMode_) return; // 「红专并进 理实交融」没勾上就不弹字母
    const float baseHue = frand01() * 360.f;
    for (int i = 0; i < 4; ++i) {
        FxLetter l;
        l.x = static_cast<float>(px.x);
        l.y = static_cast<float>(px.y);
        l.vx = (static_cast<float>(i) - 1.5f) * 42.f + (frand01() - 0.5f) * 26.f; // 四个字母朝上散开
        l.vy = -(120.f + frand01() * 90.f);
        l.rot = (frand01() - 0.5f) * 57.3f; // 网页端是 0.5 弧度，这里直接存「度」给 sf::Text
        l.vr = (frand01() - 0.5f) * 126.f;
        l.ch = "USTC"[i];
        l.hue = std::fmod(baseHue + static_cast<float>(i) * 24.f + frand01() * 18.f, 360.f);
        l.life = 1.15f;
        fxLetters_.push_back(l);
    }
    while (fxLetters_.size() > 32) fxLetters_.erase(fxLetters_.begin()); // 连点也不许堆出几百个字形
}

void Renderer::drawFx(sf::RenderTarget& t) {
    const float vw = L_.winW, vh = L_.winH;
    if (vw <= 1.f || vh <= 1.f) return;
    // 数量设 0 = 星光层关闭：不铺池、不画星、不放流星。
    // 但字母循环**照常跑**——「点击弹 USTC」由复选框门控，与星光密度是两回事，
    // 不能因为把星星关了就把彩蛋也冻住（网页端同口径：rAF 只在「无星且无字母」时停）。
    const int targetCount = effectiveStarCount();
    const bool starsOff = targetCount <= 0;
    // 换难度 / 换自定义尺寸会改窗口面积：只补/砍差额会把旧星留在原区域，
    // 短时间里看起来「星数没变、密度变了」。尺寸一变就整池重铺，密度立刻均匀。
    if (vw != fxPoolW_ || vh != fxPoolH_) {
        fxPoolW_ = vw;
        fxPoolH_ = vh;
        sparks_.clear();
        meteors_.clear();
    }
    if (starsOff) {
        sparks_.clear();
        // 星光关闭 = 连流星雨一起关（「整层关闭」的语义，网页端同口径）
        meteors_.clear();
        showerLeft_ = 0;
        showerTimer_ = starfx::kShowerInit;
    }
    // 首帧铺满全屏；之后数量变了只补/砍差额，其余粒子保留（避免整屏闪一下重铺）
    if (!starsOff && sparks_.empty()) {
        for (int i = 0; i < targetCount; ++i) sparks_.push_back(newSpark(true));
        fxClock_.restart();
        showerTimer_ = starfx::kShowerInit; // 别一开局就下一场流星雨
        showerLeft_ = 0;
        return;
    }
    if (!starsOff) {
        while (static_cast<int>(sparks_.size()) < targetCount) sparks_.push_back(newSpark(true));
        if (static_cast<int>(sparks_.size()) > targetCount) sparks_.resize(targetCount);
    }

    float dt = fxClock_.restart().asSeconds();
    // dt 封顶：切到别的程序再回来会攒出一个巨大的 dt，不封顶粒子会瞬移、字母一次全消失
    dt = std::clamp(dt, 0.f, starfx::kDtCap);
    fxTime_ += dt;

    if (!starsOff) {
        ensureGlowTex();
        // 星光：飘出上边缘或左右超出太多就回收到底部重生成，数量恒定
        for (auto& s : sparks_) {
            const float prevX = s.x, prevY = s.y;
            s.x0 += s.vx * dt;
            s.y += s.vy * dt;
            s.ph += s.sp * dt;
            // 摇摆在绘制时算，不累加进坐标：累加会把 sin 的误差一路攒下去
            s.x = s.x0 + s.amp * std::sin(fxTime_ * s.omega + s.swPhase);
            if (s.y < -12.f || s.x < -40.f || s.x > vw + 40.f) { s = newSpark(false); continue; }
            // 拖尾历史：右移一格，[0] 存上一帧位置
            for (int i = starfx::kTrailFrames - 1; i > 0; --i) { s.hx[i] = s.hx[i - 1]; s.hy[i] = s.hy[i - 1]; }
            s.hx[0] = prevX; s.hy[0] = prevY;
            if (s.hn < starfx::kTrailFrames) ++s.hn;
        }
        for (const auto& s : sparks_) drawStar(s, t);
        updateMeteors(dt, t);
    }

    // 圆环是**点击反馈**，不受星光数量影响（网页端同口径：ripple 把 rAF 拉起来）
    drawRipples(dt, t);

    for (auto it = fxLetters_.begin(); it != fxLetters_.end();) {
        it->life -= dt;
        if (it->life <= 0.f) { it = fxLetters_.erase(it); continue; }
        // 轻微阻尼：字母越飞越慢，最后几乎是「浮住淡出」，比匀速更柔和
        it->vx *= (1.f - 1.1f * dt);
        it->vy *= (1.f - 0.55f * dt);
        it->x += it->vx * dt;
        it->y += it->vy * dt;
        it->rot += it->vr * dt;
        const std::uint8_t al =
            static_cast<std::uint8_t>(std::clamp(it->life / 1.15f, 0.f, 1.f) * 0.92f * 255.f);
        sf::Text txt(font_);
        txt.setString(std::string(1, it->ch));
        txt.setCharacterSize(26.f);
        txt.setFillColor(hslColor(it->hue, 0.85f, 0.62f, al));
        // 描一层暗边：浅色面板底上字母仍能看清（与网页端 strokeText 同一目的）
        txt.setOutlineColor(displayColor(30, 42, 58, al));
        txt.setOutlineThickness(1.4f);
        const sf::FloatRect b = txt.getLocalBounds();
        txt.setOrigin(sf::Vector2f(b.position.x + b.size.x * 0.5f, b.position.y + b.size.y * 0.5f));
        txt.setPosition(sf::Vector2f(it->x, it->y));
        txt.setRotation(sf::degrees(it->rot));
        t.draw(txt);
        ++it;
    }
}

// —————————————————————————— 动效层状态机（与 web/ts/renderer.ts syncAnims 同义） ——————————————————————————

double Renderer::animNow() const {
    return static_cast<double>(animClock_.getElapsedTime().asMilliseconds());
}

void Renderer::addRipple(sf::Vector2f pos) {
    ripples_.push_back(Ripple{pos.x, pos.y, animNow()});
    if (ripples_.size() > 12) ripples_.erase(ripples_.begin()); // 与网页端同上限
}

void Renderer::resetAnims() {
    revealAt_.clear();
    prevOpen_.clear();
    prevFlag_.clear();
    flagAt_.clear();
    neighborLit_.clear();
    dying_.clear();
    ripples_.clear();
    counterFlipActive_ = false;
    lastRemaining_ = -1;
    lossActive_ = false;
    winActive_ = false;
    winAnim_.pts.clear();
    phaseSeen_ = Phase::Playing;
    revealOriginR_ = revealOriginC_ = -1;
}

void Renderer::syncAnims(const Board& board, const Hud& hud) {
    const int cols = board.cols();
    const std::size_t n = static_cast<std::size_t>(board.rows()) * static_cast<std::size_t>(cols);
    if (prevOpen_.size() != n) { // 换局/换尺寸：快照重新建，不把旧局面当 diff
        prevOpen_.assign(n, 0);
        prevFlag_.assign(n, 0);
        revealAt_.assign(n, 0.0);
        flagAt_.assign(n, 0.0);
        neighborLit_.assign(n, 0);
        revealOriginR_ = revealOriginC_ = -1;
    }
    const double now = animNow();
    const bool on = animFx_;

    // ① 开格波前：diff 出本帧新翻开的格子，按到起点的 8 邻域 BFS 距离错峰（每圈 waveStep ms）
    std::vector<int> newCells;
    for (std::size_t i = 0; i < n; ++i) {
        const Cell& cell = board.at(static_cast<int>(i) / cols, static_cast<int>(i) % cols);
        if (cell.opened && !prevOpen_[i]) newCells.push_back(static_cast<int>(i));
        prevOpen_[i] = cell.opened ? 1 : 0;
    }
    if (!newCells.empty() && on) {
        // 起点：noteRevealOrigin 记的这格（若它自己也是新开的）；双击 chord 的起点本来就开着，
        // 这时取离起点最近的新格 —— 两支都与网页端 renderer.ts:304-316 同式。
        int seed = -1;
        if (revealOriginR_ >= 0) {
            for (int idx : newCells)
                if (idx / cols == revealOriginR_ && idx % cols == revealOriginC_) { seed = idx; break; }
            if (seed < 0) {
                double best = 0.0;
                for (int idx : newCells) {
                    const int rr = idx / cols - revealOriginR_, cc = idx % cols - revealOriginC_;
                    const double d = static_cast<double>(rr) * rr + static_cast<double>(cc) * cc;
                    if (seed < 0 || d < best) { seed = idx; best = d; }
                }
            }
        }
        if (seed < 0) seed = newCells.front();
        std::vector<std::uint8_t> inNew(n, 0);
        for (int idx : newCells) inNew[static_cast<std::size_t>(idx)] = 1;
        std::vector<int> dist(n, -1);
        std::vector<int> q;
        q.reserve(newCells.size());
        dist[static_cast<std::size_t>(seed)] = 0;
        q.push_back(seed);
        for (std::size_t qi = 0; qi < q.size(); ++qi) {
            const int i = q[qi];
            const int rr = i / cols, cc = i % cols;
            for (int dr = -1; dr <= 1; ++dr)
                for (int dc = -1; dc <= 1; ++dc) {
                    if (!dr && !dc) continue;
                    const int nr = rr + dr, nc = cc + dc;
                    if (nr < 0 || nc < 0 || nr >= board.rows() || nc >= cols) continue;
                    const std::size_t j = static_cast<std::size_t>(nr) * cols + static_cast<std::size_t>(nc);
                    if (!inNew[j] || dist[j] >= 0) continue;
                    dist[j] = dist[static_cast<std::size_t>(i)] + 1;
                    q.push_back(static_cast<int>(j));
                }
        }
        for (int idx : q)
            revealAt_[static_cast<std::size_t>(idx)] = now + static_cast<double>(dist[static_cast<std::size_t>(idx)]) * kAnimMs.waveStep;
    }
    revealOriginR_ = revealOriginC_ = -1;

    // ② 标记 diff：新标 → 弹入；取消 → 缩小退场（右键清除/菜单/双击连锁都走这条）
    for (std::size_t i = 0; i < n; ++i) {
        const Cell& cell = board.at(static_cast<int>(i) / cols, static_cast<int>(i) % cols);
        const int f = static_cast<int>(cell.flag);
        if (f != prevFlag_[i]) {
            if (on) {
                if (f != 0) {
                    flagAt_[i] = now;
                } else {
                    dying_.push_back(DyingFlag{static_cast<int>(i) / cols, static_cast<int>(i) % cols,
                                               static_cast<MineType>(prevFlag_[i]), now});
                    if (dying_.size() > 32) dying_.erase(dying_.begin());
                }
            }
            prevFlag_[i] = static_cast<std::uint8_t>(f);
        }
    }

    // ③ 邻域预亮：悬停格的 8 邻域（对局中、无任何面板时才亮）
    neighborLit_.assign(n, 0);
    if (on && hud.phase == Phase::Playing && !settingsOpen_ && !setupOpen_ && !confirmOpen() && !helpOpen_ &&
        seedStage_ == SeedStage::None && !menuOpen_) {
        const auto hov = cellAt(mousePx_);
        if (hov) {
            const int rr = hov->first, cc = hov->second;
            for (int dr = -1; dr <= 1; ++dr)
                for (int dc = -1; dc <= 1; ++dc) {
                    if (!dr && !dc) continue;
                    const int nr = rr + dr, nc = cc + dc;
                    if (nr < 0 || nc < 0 || nr >= board.rows() || nc >= cols) continue;
                    neighborLit_[static_cast<std::size_t>(nr) * cols + static_cast<std::size_t>(nc)] = 1;
                }
        }
    }

    // ④ 表头翻牌：剩余雷数变了就翻一次（计时器每秒都变，不翻）
    if (hud.remaining != lastRemaining_) {
        if (lastRemaining_ >= 0 && on) {
            counterFlipActive_ = true;
            counterFlip_ = CounterFlip{lastRemaining_, now};
        }
        lastRemaining_ = hud.remaining;
    }
    if (counterFlipActive_ && now - counterFlip_.at > kAnimMs.counterFlip) counterFlipActive_ = false;

    // ⑤ 终局捕获：Playing→Lost 找爆点（雷区显形/错标抖动的锚）；Playing→Won 收雷心连星座
    if (hud.phase != phaseSeen_) {
        if (on && hud.phase == Phase::Lost) {
            bool found = false;
            for (int r = 0; r < board.rows() && !found; ++r)
                for (int c = 0; c < cols && !found; ++c) {
                    const Cell& cell = board.at(r, c);
                    if (cell.opened && cell.exploded) {
                        lossActive_ = true;
                        lossAnim_ = LossAnim{now, r, c};
                        found = true;
                    }
                }
            if (!found) lossActive_ = false;
        } else if (on && hud.phase == Phase::Won) {
            std::vector<sf::Vector2f> pts;
            const float pitch = L_.cell + L_.gap;
            for (int r = 0; r < board.rows(); ++r)
                for (int c = 0; c < cols; ++c)
                    if (board.at(r, c).mine != MineType::None)
                        pts.emplace_back(L_.boardX + c * pitch + L_.cell * 0.5f,
                                         L_.boardY + r * pitch + L_.cell * 0.5f);
            if (pts.size() >= 2) {
                sf::Vector2f ctr(0.f, 0.f);
                for (const sf::Vector2f& p : pts) ctr += p;
                ctr /= static_cast<float>(pts.size());
                std::sort(pts.begin(), pts.end(), [&](const sf::Vector2f& a, const sf::Vector2f& b) {
                    return std::atan2(a.y - ctr.y, a.x - ctr.x) < std::atan2(b.y - ctr.y, b.x - ctr.x);
                });
                winAnim_ = WinAnim{now, std::move(pts)};
                winActive_ = true;
            } else {
                winActive_ = false;
            }
        } else if (hud.phase == Phase::Playing) {
            lossActive_ = false;
            winActive_ = false;
        }
        phaseSeen_ = hud.phase;
    }

    // ⑥ 清掉过期的瞬态
    ripples_.erase(std::remove_if(ripples_.begin(), ripples_.end(),
                                  [&](const Ripple& rp) { return now - rp.at >= kAnimMs.ripple; }),
                   ripples_.end());
    dying_.erase(std::remove_if(dying_.begin(), dying_.end(),
                                [&](const DyingFlag& d) { return now - d.at >= kAnimMs.badgeDie; }),
                 dying_.end());
    if (winActive_ && !winAnim_.pts.empty()) {
        const double total = static_cast<double>(winAnim_.pts.size() - 1) * kAnimMs.winSegStep + kAnimMs.winSegGrow;
        if (now - winAnim_.at > total + kAnimMs.winHold + kAnimMs.winFade) {
            winActive_ = false;
            winAnim_.pts.clear();
        }
    }
}

float Renderer::revealOf(std::size_t idx) const {
    const double t0 = idx < revealAt_.size() ? revealAt_[idx] : 0.0;
    if (t0 == 0.0 || !animFx_) return 1.f;
    const double now = animNow();
    if (now < t0) return -1.f;
    const double p = (now - t0) / kAnimMs.revealPop;
    return p >= 1.0 ? 1.f : static_cast<float>(p);
}

float Renderer::lossAlphaOf(int r, int c) const {
    if (!lossActive_ || !animFx_) return 1.f;
    const int d = std::max(std::abs(r - lossAnim_.r), std::abs(c - lossAnim_.c));
    const double s = lossAnim_.at + static_cast<double>(d) * kAnimMs.lossStep;
    const double now = animNow();
    if (now < s) return 0.f;
    const double p = (now - s) / kAnimMs.lossPop;
    return p >= 1.0 ? 1.f : static_cast<float>(p);
}

float Renderer::shakeDx() const {
    if (!lossActive_ || !animFx_) return 0.f;
    const double age = animNow() - lossAnim_.at;
    if (age < 0 || age > kAnimMs.shake) return 0.f;
    return static_cast<float>(std::sin(age / 26.0)) * 2.6f * static_cast<float>(1.0 - age / kAnimMs.shake);
}

Renderer::FlagPop Renderer::flagPopOf(std::size_t idx) const {
    const double t0 = idx < flagAt_.size() ? flagAt_[idx] : 0.0;
    if (t0 == 0.0 || !animFx_) return FlagPop{1.f, 0.f};
    const double age = animNow() - t0;
    const float p = static_cast<float>(std::min(1.0, age / kAnimMs.badgePop));
    const double rp = age / kAnimMs.badgeRing;
    return FlagPop{ms::anim::easeOutBack(p), rp < 1.0 ? static_cast<float>(rp) : 0.f};
}

void Renderer::drawClickRipples(sf::RenderTarget& t) const {
    if (!animFx_ || ripples_.empty()) return;
    const double now = animNow();
    for (const Ripple& rp : ripples_) {
        const double p = (now - rp.at) / kAnimMs.ripple;
        if (p < 0.0 || p >= 1.0) continue;
        const float r = 6.f + 30.f * ms::anim::easeInOut(static_cast<float>(p));
        sf::CircleShape c(r, 24);
        c.setOrigin(sf::Vector2f(r, r));
        c.setPosition(sf::Vector2f(rp.x, rp.y));
        c.setFillColor(sf::Color::Transparent);
        c.setOutlineColor(displayColor(60, 70, 90, static_cast<std::uint8_t>(0.35f * (1.f - static_cast<float>(p)) * 255.f)));
        c.setOutlineThickness(2.5f);
        t.draw(c);
    }
}

void Renderer::drawDyingFlags(sf::RenderTarget& t) const {
    if (!animFx_ || dying_.empty()) return;
    const double now = animNow();
    const float pitch = L_.cell + L_.gap;
    for (const DyingFlag& d : dying_) {
        const double p = (now - d.at) / kAnimMs.badgeDie;
        if (p < 0.0 || p >= 1.0) continue;
        const sf::Vector2f center(L_.boardX + d.c * pitch + L_.cell * 0.5f,
                                  L_.boardY + d.r * pitch + L_.cell * 0.5f);
        const float scale = 1.f - ms::anim::easeInOut(static_cast<float>(p));
        const int mi = static_cast<int>(d.t);
        if (mi >= 1 && mi <= 4) {
            if (markerTexOk_[mi]) { // 图片标记：等比缩掉
                const sf::Vector2u ts = markerTex_[mi].getSize();
                const float target = L_.cell * 0.78f * scale;
                const float sc = std::min(target / static_cast<float>(ts.x), target / static_cast<float>(ts.y));
                sf::Sprite sp(markerTex_[mi]);
                sp.setOrigin(sf::Vector2f(ts.x * 0.5f, ts.y * 0.5f));
                sp.setScale(sf::Vector2f(sc, sc));
                sp.setPosition(center);
                t.draw(sp);
            } else if (fontOk_) {
                sf::Transform tr = sf::Transform::Identity;
                tr.scale(sf::Vector2f(scale, scale), center);
                drawMarker(t, font_, center, L_.cell, d.t, markerChar_[mi], 1.f, sf::RenderStates(tr));
            }
        }
    }
}

void Renderer::drawConstellation(sf::RenderTarget& t) const {
    if (!animFx_ || !winActive_ || winAnim_.pts.size() < 2) return;
    const auto& pts = winAnim_.pts;
    const double now = animNow();
    const double total = static_cast<double>(pts.size() - 1) * kAnimMs.winSegStep + kAnimMs.winSegGrow;
    const double age = now - winAnim_.at;
    if (age < 0) return;
    const float fade = age <= total + kAnimMs.winHold
                           ? 1.f
                           : std::max(0.f, static_cast<float>(1.0 - (age - total - kAnimMs.winHold) / kAnimMs.winFade));
    for (std::size_t i = 0; i < pts.size(); ++i) {
        const sf::Vector2f a = pts[i], b = pts[(i + 1) % pts.size()];
        const double seg = age - static_cast<double>(i) * kAnimMs.winSegStep;
        if (seg <= 0) continue;
        const float p = static_cast<float>(std::min(1.0, seg / kAnimMs.winSegGrow));
        const float ex = a.x + (b.x - a.x) * ms::anim::easeInOut(p);
        const float ey = a.y + (b.y - a.y) * ms::anim::easeInOut(p);
        // 两道笔画：宽的暖色低透明当光晕，细的深色当星骨（网页端同色同宽）
        drawThickLine(t, a, sf::Vector2f(ex, ey), 5.f,
                      displayColor(214, 158, 46, static_cast<std::uint8_t>(0.22f * fade * 255.f)));
        drawThickLine(t, a, sf::Vector2f(ex, ey), 1.6f,
                      displayColor(146, 102, 10, static_cast<std::uint8_t>(0.8f * fade * 255.f)));
    }
}

void Renderer::drawAcrylic(sf::RenderTarget& t, const sf::Vector2f& pos, const sf::Vector2f& sz) const {
    // 四段渐变（网页端 acrylic() 同 stops）：0 顶高光 0.30 → 0.32 弱化 0.05 → 0.72 透明 → 1.00 底内阴影 0.12
    struct Stop { float t; sf::Color c; };
    static const Stop stops[4] = {
        {0.00f, displayColor(255, 255, 255, 77)},
        {0.32f, displayColor(255, 255, 255, 13)},
        {0.72f, displayColor(0, 0, 0, 0)},
        {1.00f, displayColor(20, 30, 50, 31)},
    };
    constexpr int kSeg = 8; // 顶点插值是逐段线性的，分 8 条横带逼近折线渐变
    sf::VertexArray strip(sf::PrimitiveType::TriangleStrip, (kSeg + 1) * 2);
    for (int i = 0; i <= kSeg; ++i) {
        const float f = static_cast<float>(i) / static_cast<float>(kSeg);
        sf::Color col = stops[3].c;
        for (int sIdx = 0; sIdx < 3; ++sIdx) {
            if (f <= stops[sIdx + 1].t) {
                const float k = (f - stops[sIdx].t) / (stops[sIdx + 1].t - stops[sIdx].t);
                const sf::Color& a = stops[sIdx].c;
                const sf::Color& b = stops[sIdx + 1].c;
                col = sf::Color(static_cast<std::uint8_t>(a.r + (b.r - a.r) * k),
                                static_cast<std::uint8_t>(a.g + (b.g - a.g) * k),
                                static_cast<std::uint8_t>(a.b + (b.b - a.b) * k),
                                static_cast<std::uint8_t>(a.a + (b.a - a.a) * k));
                break;
            }
        }
        strip[static_cast<std::size_t>(2 * i)].position = sf::Vector2f(pos.x, pos.y + f * sz.y);
        strip[static_cast<std::size_t>(2 * i)].color = col;
        strip[static_cast<std::size_t>(2 * i + 1)].position = sf::Vector2f(pos.x + sz.x, pos.y + f * sz.y);
        strip[static_cast<std::size_t>(2 * i + 1)].color = col;
    }
    t.draw(strip);
}

void Renderer::draw(const Board& board, sf::Vector2i hoverPx, const Hud& hud, sf::RenderTarget& t) {
    mousePx_ = hoverPx; // 每帧都能拿到实时鼠标位置
    syncAnims(board, hud); // 动效状态机：diff 棋盘 + 终局捕获 + 清过期（必须在画格子的前面）
    if (seedStage_ == SeedStage::Menu) { // 悬停即选中：高亮跟着鼠标，键盘 Enter 也作用于它
        const int idx = seedMenuHoverIndex(hoverPx);
        if (idx >= 0 && seedMenuEnabled(idx)) seedMenuItem_ = idx;
    }
    if (!bgTried_) loadBackground(); // 首次绘制时才加载（需 GL 上下文）

    // 窗口背景：底色打底 + 35% 不透明度的纹理（等比适应，四周留白）
    sf::RectangleShape bg(sf::Vector2f(L_.winW, L_.winH));
    bg.setFillColor(kWindowBg);
    t.draw(bg);
    drawBackgroundSprite(t, bgAlpha_); // 整窗背景图

    drawHeader(board, hud, t);

    // 棋盘底板
    sf::RectangleShape panel(sf::Vector2f(L_.boardW + L_.pad, L_.boardH + L_.pad));
    panel.setPosition(sf::Vector2f(L_.boardX - L_.pad * 0.5f, L_.boardY - L_.pad * 0.5f));
    panel.setFillColor(kPanel);
    t.draw(panel);

    const auto hover = hud.phase == Phase::Playing ? cellAt(hoverPx) : std::nullopt;
    const auto hoveredAt = [&](int r, int c) { return hover && hover->first == r && hover->second == c; };

    // ① 先铺格子底板
    for (int r = 0; r < board.rows(); ++r)
        for (int c = 0; c < board.cols(); ++c)
            drawCellBackground(board, r, c, hoveredAt(r, c), hud, t);

    // ② 把背景图片铺在格子上（裁剪到棋盘区域，约 35% 不透明度；等比、与整窗层对齐）
    if (bgOk_) {
        drawBackgroundSpriteIn(t, bgAlpha_,
                               sf::FloatRect(sf::Vector2f(L_.boardX - L_.pad * 0.5f, L_.boardY - L_.pad * 0.5f),
                                             sf::Vector2f(L_.boardW + L_.pad, L_.boardH + L_.pad)));
    }

    // ③ 再画格子内容（数字/雷/标记），保证文字清晰不被图片压住
    for (int r = 0; r < board.rows(); ++r)
        for (int c = 0; c < board.cols(); ++c)
            drawCellContent(board, r, c, hoveredAt(r, c), hud, t);

    drawDyingFlags(t);     // 取消标记的缩小退场（棋盘坐标系内、内容之上）
    drawClickRipples(t);   // 点击涟漪（窗口坐标；网页端画在棋盘 transform 之外、横幅之下）
    drawZeroTipFlash(board, t); // 黄 0 教学闪烁：内容之上、横幅之下

#if MS_SOLVER_HINTS
    drawHintCellOverlay(t); // 求解器提示高亮（盖在格内容上、终局横幅下）
#endif
    drawOverlay(hud, t);
    drawConstellation(t); // 胜利星座线：盖在结算横幅上、模态面板之下（与网页端同层）
    drawFx(t);   // 星光盖在棋盘/横幅上，但**在模态面板之下**：网页端 #fx 没有 z-index，对话框天然压住它
    drawMenu(hoverPx, t); // 右键菜单
    drawZeroTip(t);       // 黄 0 教学弹窗：模态面板之下、棋盘之上
    drawSetup(t);         // 设置面板（模态）
    drawSeedUi(t);        // 种子菜单 / 载入框 / 覆盖确认（最上层）
    drawSettings(t);      // 设置面板（模态）
    drawHelp(t);          // 游戏说明面板（模态）
    drawConfirm(t);  // 二次确认框（最上层）
}

// —————————————————————————— 游戏说明面板 ——————————————————————————
// 样式标注版落地：#片段#（效果）文案直接编成结构化数据，无解析器、零新依赖。
// 五档字号：标题/大号/中号/正文/小号；颜色全用 Renderer 现成常量；字距加宽=逐字 advance+1px。

static std::vector<std::string> utf8Split(const std::string& s) {
    std::vector<std::string> out;
    size_t i = 0;
    while (i < s.size()) {
        size_t j = i + 1;
        const unsigned char ch = static_cast<unsigned char>(s[i]);
        if ((ch & 0xE0) == 0xC0) j = i + 2;
        else if ((ch & 0xF0) == 0xE0) j = i + 3;
        else if ((ch & 0xF8) == 0xF0) j = i + 4;
        out.push_back(s.substr(i, j - i));
        i = j;
    }
    return out;
}

// 排版步进宽度 = 字形 advance 之和：SFML 不做 kerning，advance 累加即渲染时的真实步进。
// 不能用 getLocalBounds（墨迹宽）：逐字符累加时 bearing 误差按字数累积，长行会把文字挤到重叠。
// getGlyph 的 characterSize 是 unsigned（与 Text::setCharacterSize 同一截断），与渲染严格一致。
static float textAdvanceOf(const sf::Font& font, const std::string& s, float size) {
    float adv = 0.f;
    size_t i = 0;
    while (i < s.size()) {
        const unsigned char c0 = static_cast<unsigned char>(s[i]);
        char32_t cp = c0;
        unsigned len = 1;
        if ((c0 & 0xE0) >= 0xC0 && (c0 & 0xE0) <= 0xDF) { cp = static_cast<char32_t>(c0 & 0x1F) << 6; len = 2; }
        else if ((c0 & 0xF0) == 0xE0) { cp = static_cast<char32_t>(c0 & 0x0F) << 12; len = 3; }
        else if ((c0 & 0xF8) == 0xF0) { cp = static_cast<char32_t>(c0 & 0x07) << 18; len = 4; }
        for (unsigned k = 1; k < len && i + k < s.size(); ++k)
            cp |= static_cast<char32_t>(static_cast<unsigned char>(s[i + k]) & 0x3F) << (6 * (len - 1 - k));
        adv += font.getGlyph(cp, static_cast<unsigned int>(size), false, 0.f).advance;
        i += len;
    }
    return adv;
}

// 帮助面板：、。这类标点墨迹矮，textTLSpr 按"墨迹顶对齐"会把它整字提到行顶（看着像乱码）。
// 返回一个 dy，使该字与同字体参考字（中文'中'/西文'0'）落在同一基线上：矮墨迹片段回到行底。
// 与网页端 ui.ts::inkAlignDy 公式一致：dy = inkTop(s) - inkTop(ref)（SFML 中 inkTop = localBounds.position.y，为负值）。
static float helpInkTop(const sf::Font& font, const std::string& s, float size) {
    sf::Text t(font);
    t.setString(sf::String::fromUtf8(s.begin(), s.end()));
    t.setCharacterSize(size);
    return t.getLocalBounds().position.y;
}
static float inkAlignDy(const sf::Font& font, const std::string& s, const std::string& ref, float size) {
    if (s.empty()) return 0.f;
    return helpInkTop(font, s, size) - helpInkTop(font, ref, size);
}

void Renderer::scrollHelp(float delta) {
    const float viewH = L_.helpPanel.size.y - 52.f;
    const float maxS = std::max(0.f, helpTotalH_ - viewH);
    helpScroll_ = std::min(maxS, std::max(0.f, helpScroll_ - delta * 48.f));
}

// —— 帮助面板滚动条拖动：几何来自 drawHelp 每帧缓存（面板必已绘过一帧才有点击）——
bool Renderer::helpHitScrollbar(sf::Vector2i px) const {
    if (!helpGeoOk_) return false;
    const sf::FloatRect wide(sf::Vector2f(helpTrackR_.position.x - 6.f, helpTrackR_.position.y),
                             sf::Vector2f(14.f, helpTrackR_.size.y));
    return wide.contains(sf::Vector2f(static_cast<float>(px.x), static_cast<float>(px.y)));
}
void Renderer::helpDragTo(float py) {
    const float track = helpViewH_ - helpThumbR_.size.y;
    if (track <= 0.f || helpMaxS_ <= 0.f) { helpScroll_ = 0.f; return; }
    const float s = (py - helpGrabOff_ - helpViewTop_) / track * helpMaxS_;
    helpScroll_ = std::min(helpMaxS_, std::max(0.f, s));
}
void Renderer::helpDragBegin(sf::Vector2i px) {
    if (!helpGeoOk_) return;
    const float py = static_cast<float>(px.y);
    if (helpThumbR_.contains(sf::Vector2f(helpTrackR_.position.x, py))) {
        helpGrabOff_ = py - helpThumbR_.position.y; // 按住滑块：保持抓取点
    } else {
        helpGrabOff_ = helpThumbR_.size.y * 0.5f;   // 点轨道空白：滑块中心跳到指针（跳页手感）
        helpDragTo(py);
    }
    helpDragging_ = true;
}
void Renderer::helpDragMove(sf::Vector2i px) {
    if (helpDragging_) helpDragTo(static_cast<float>(px.y));
}
void Renderer::helpDragEnd() { helpDragging_ = false; }

void Renderer::buildHelp() {
    helpBuilt_ = true;
    helpRows_.clear();
    const float T = 22.f, BIG = 16.f, MID = 15.f, BODY = 13.f, SMALL = 11.f; // SFML 字号为整数（setCharacterSize(unsigned)）
    auto S = [](const char* txt, sf::Color c, float sz, bool sp = false) {
        HelpSeg s; s.text = txt; s.col = c; s.size = sz; s.spaced = sp; return s;
    };
    struct Raw { std::vector<HelpSeg> segs; float gap = 6.f; bool dot = false, rule = false, center = false; float indent = 0.f; };
    std::vector<Raw> raw;
    auto add = [&](Raw r) { raw.push_back(std::move(r)); };
    auto sec = [&](const char* name, const char* tag) {
        Raw r; r.segs.push_back(S(name, kInk, MID, true));
        if (tag && *tag) r.segs.push_back(S(tag, kInkSoft, SMALL));
        r.rule = true; r.gap = 16.f; add(std::move(r));
    };
    { Raw r; r.center = true; r.gap = 26.f;
      r.segs = {S("复数扫雷", kInk, T, true), S("  游戏规则", kInkSoft, SMALL)}; add(std::move(r)); }

    sec("一、棋盘与目标", "");
    add({{S("1. 棋盘下藏着四种雷：", kInk, BODY), S("+1", kRealMine, BIG), S("、", kInk, BODY), S("-1", kRealMine, BIG),
          S("、", kInk, BODY), S("+i", kImagMine, BIG), S("、", kInk, BODY), S("-i", kImagMine, BIG),
          S("，数量大致各四分之一。", kInk, BODY)}});
    add({{S("2. 难度三档：", kInk, BODY), S("新手 9x9 十二雷", kInk, MID), S("、", kInk, BODY), S("中级 16x16 四十雷", kInk, MID),
          S("、", kInk, BODY), S("高级 24x16 七十二雷", kInk, MID),
          S("。另有 CUSTOM 自定义，行列雷数任选，还能指定实雷与虚雷的配比。", kInk, BODY)}});
    add({{S("3. 胜利二选一：", kInk, BODY), S("翻开全部安全格", kInk, BIG), S("（雷怎么标都行）；或", kInk, BODY),
          S("把每一颗雷都标成正确类型", kInk, BIG), S("（不多不少）。", kInk, BODY)}});

    sec("二、数字怎么读", " （本游戏的核心）");
    add({{S("翻开一格，显示的是它周围八格里所有雷的复数之和。", kInk, BODY)}});
    add({{S("1. 和是纯实数：直接显示并带正负号，", kInk, BODY), S("蓝色", kRealMine, BODY), S("，如 ", kInk, BODY),
          S("+2", kRealMine, BODY), S("、", kInk, BODY), S("-2", kRealMine, BODY), S("。", kInk, BODY)}});
    add({{S("2. 和是纯虚数：", kInk, BODY), S("绿色", kImagMine, BODY), S("，如 ", kInk, BODY),
          S("+i", kImagMine, BODY), S("、", kInk, BODY), S("-3i", kImagMine, BODY), S("。", kInk, BODY)}});
    add({{S("3. 和是实虚混合：显示这个和的模长，也就是长度，", kInk, BODY), S("紫色", kMixHint, BODY), S("，如 ", kInk, BODY),
          S("√2", kMixHint, BODY), S("、", kInk, BODY), S("√5", kMixHint, BODY), S("。", kInk, BODY)}});
    add({{S("4. 和恰好抵消为零：", kInk, BODY), S("黄色 0", kZeroHint, BODY), S("，和“周围没有雷”的空格区分（真空格没有数字）。", kInk, BODY)}});
    add({{S("例一", kInk, MID), S("：周围藏 +1、+1、-1，净和 +1，这格显示 ", kInk, BODY), S("+1", kRealMine, BIG), S("。", kInk, BODY)}});
    add({{S("例二", kInk, MID), S("：周围藏 +1、+i，净和 1+i，长度 √2，这格显示 ", kInk, BODY), S("√2", kMixHint, BIG), S("。", kInk, BODY)}});
    add({{S("例三", kInk, MID), S("：周围藏 +1、-1，完全抵消，这格显示 ", kInk, BODY), S("0", kZeroHint, BIG), S("。", kInk, BODY)}});
    add({{S("要点", kBadMark, MID), S("：混合提示只给长度、不给方向。同样是 √5，和可能是 2+i，也可能是 1+2i，还可能是它们的相反数。", kInk, BODY),
          S("你要从一片数字里联立解出每颗雷的类型，这就是本游戏的难点与乐趣。", kInk, BODY)}});

    sec("三、与经典扫雷最大的三个不同", " （先看这里）");
    add({{S("1. ", kInk, BODY), S("数字会抵消", kInk, BIG),
          S("：提示不是雷数。显示 +1 的格子周围可能只有一颗雷，也可能有5颗（比如 +1、+1、-1,+i,-i）。", kInk, BODY)}});
    add({{S("2. ", kInk, BODY), S("黄色 0 不代表周围没雷", kBadMark, BIG),
          S("：它只说明净和为零，一定有雷，可能是藏着 +1 与 -1、或 +i 与 -i 各一对。而且 ", kInk, BODY),
          S("0 不会自动连锁展开", kBadMark, BIG), S("，每一格都要你自己点。把 0 当安全区是", kInk, BODY),
          S("新手第一大死法", kBadMark, BODY),
          S("；正确用法是把 0 当强线索：它的八个邻居里的雷必须正好配成抵消对。", kInk, BODY)}});
    add({{S("3. ", kInk, BODY), S("赢法不止一种", kInk, BIG),
          S("：不翻开所有格子、把全部雷按正确类型标满（一颗不多一颗不少），同样获胜（", kInk, BODY),
          S("如果你足够厉害", kInkSoft, SMALL), S("）。", kInk, BODY)}});

    sec("四、操作说明", "");
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("左键", kInk, BIG), S(" 点击未翻开的格子：翻开。", kInk, BODY), S("第一次点击永远安全", kRealMine, BODY),
                S("（布雷发生在首点之后，首点及其周围八格保证无雷）。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("右键", kInk, BIG), S("：弹出标记菜单，五项：+1、-1、+i、-i、清除。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("数字键 1 到 5", kInk, BIG), S("：鼠标悬在盖着的格子上直接标记。1 是 +1，2 是 -1，3 是 +i，4 是 -i，5 是清除。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("中键，或快速双击已翻开的数字格", kInk, BIG),
                S("：批量开格。当这格周围每一颗雷都被你标对类型时，一键翻开其余邻居；没标对则什么都不会发生，不惩罚、不误爆（", kInk, BODY),
                S("除非开了BOOM", kInkSoft, SMALL), S("）。", kInk, BODY)}; add(std::move(r)); }
#if MS_SOLVER_HINTS
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("H 键", kInk, BIG),
                S("：求解器提示。只看你屏幕上的信息（已翻开格的数字、你的标记、表头两轴计数），枚举所有与盘面相容的布雷，找出确定安全或必雷的格子；没有确定结论时给出含雷率最低的猜测格。提示格会闪烁高亮，盘面一变就自动撤下。括号里是（行, 列），行列都从 0 开始数；类型 +1 / -1 / +i / -i 就是四种雷。若某片区域太复杂、只能采样估计，概率前会写 ≈ 并标注（估计），它不是严格概率；采样连含雷解都没找到时会直接写「未知」，那不代表 0。", kInk, BODY)}; add(std::move(r)); }
#endif
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("表头 EASY、MEDIUM、HARD、CUSTOM 切换难度或开自定义面板；齿轮是设置。", kInkSoft, SMALL)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("计时只在你看着棋盘时走：切窗口或打开任何菜单会自动暂停（", kInk, BODY),
                S("TIME PAUSED", kInkSoft, SMALL), S("）。", kInk, BODY)}; add(std::move(r)); }

    sec("五、胜负判定", "");
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("踩到雷：", kInk, BODY), S("BOOM", kBadMark, BIG, true), S("，失败，全图揭晓。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("路径一", kImagMine, MID), S("：翻开全部安全格即获胜；这时候雷怎么标、标不标都随你，甚至标错也不算错。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("路径二", kImagMine, MID), S("：把每一颗雷都标成正确类型即获胜；但必须不多不少——在安全格上多插旗会破坏判胜，雷漏标一颗也不算。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("友好规则，翻转也算对", kRealMine, BIG),
                S("：若某片区域从所有数字上根本分辨不出 +1 与 -1 谁是谁，那么把这片区域的标记整体对调（+1 与 -1 互换，或 +i 与 -i 互换）同样判胜，与全部提示统计一致就是解。但", kInk, BODY),
                S("跨轴不行", kBadMark, BODY), S("：实轴的雷标成虚轴一定算错（", kInk, BODY),
                S("除非没有其他依赖的雷", kInkSoft, SMALL), S("）。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("表头计数 ", kInk, BODY), S("±1 xN", kRealMine, BODY), S("、", kInk, BODY), S("±i xM", kImagMine, BODY),
                S(" 表示两个轴各自还有多少颗没被正确标记，收官时非常有用；硬核玩家可勾选隐藏计数。", kInk, BODY)}; add(std::move(r)); }

    sec("六、进阶玩法", "");
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("模长模式", kInk, BIG),
                S("：勾选表头\"总是显示模长\"后，所有非零提示一律只给模长，不分正负、不分实虚；判胜标准同步变为：标记恰好盖住每一颗雷，且每格标记之和的模长与提示吻合，不再要求类型逐一对应。", kInk, BODY),
                S("更难，也更纯粹", kInkSoft, SMALL), S("。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f;
      r.segs = {S("种子分享", kInk, BIG),
                S("：菜单 COPY SEED 复制本局参数，朋友在 LOAD SEED 贴入，玩到的就是与你完全相同的雷，连首点位置都包含在内。SAVE PROGRESS 复制的是当前进度，别人可以从你的半局接着玩。格式不符会提示 ", kInk, BODY),
                S("BAD SEED", kBadMark, SMALL), S("。", kInk, BODY)}; add(std::move(r)); }
    { Raw r; r.dot = true; r.indent = 16.f; r.gap = 16.f;
      r.segs = {S("外观", kInk, BIG),
                S("：设置里可换背景图、自定义四种标记的字符或图片；所有设置即时保存，RESTORE ALL 一键回默认。", kInk, BODY),
                S("辨色吃力的玩家可以把四个标记换成形状迥异的字符或图片，不靠颜色也能玩。", kInk, BODY)}; add(std::move(r)); }

    add({{S("背景图声明", kRealMine, MID), S(" 默认背景来源：画师 木子森森森MORI 《云上城堡》  原链接：", kInk, BODY),
          S("【【绘画过程】洛天依-云上城堡-哔哩哔哩】", kInk, BODY), S(" https://b23.tv/rHT5In4", kInk, BODY)}, 10.f, false, false, false, 0.f});
    add({{S("未经授权，严禁商用！", kBadMark, BIG)}, 8.f, false, false, false, 0.f});

    // —— 量宽与换行布局：片段贪心换行，续行悬挂缩进 +14；行高 = 行内最大字号 + 7 ——
    const float CW = L_.helpPanel.size.x - 52.f;
    // 量宽：逐字累加；超过换行后行宽的片段按字符边界切开——只在片段级换行拦不住长正文段（单片段本身就超行宽）
    for (auto& ln : raw) {
        const float maxw = CW - ln.indent - 14.f; // 按续行（更窄）宽度切，切出的每段在任何行都放得下
        std::vector<HelpSeg> out;
        for (auto& sg : ln.segs) {
            const auto chars = utf8Split(sg.text);
            float full = 0.f;
            for (const auto& ch : chars) full += textAdvanceOf(fontFor(ch), ch, sg.size) + (sg.spaced ? 1.f : 0.f);
            if (full <= maxw || chars.size() < 2) {
                sg.adv = full;
                out.push_back(std::move(sg));
                continue;
            }
            HelpSeg piece = sg;
            piece.text.clear();
            piece.adv = 0.f;
            for (const auto& ch : chars) {
                const float wch = textAdvanceOf(fontFor(ch), ch, sg.size) + (sg.spaced ? 1.f : 0.f);
                if (!piece.text.empty() && piece.adv + wch > maxw) {
                    out.push_back(std::move(piece));
                    piece = sg;
                    piece.text.clear();
                    piece.adv = 0.f;
                }
                piece.text += ch;
                piece.adv += wch;
            }
            if (!piece.text.empty()) out.push_back(std::move(piece));
        }
        ln.segs = std::move(out);
    }
    float y = 0.f;
    for (auto& ln : raw) {
        size_t b = 0;
        float cur = 0.f, avail = CW - ln.indent;
        auto flush = [&](size_t e, bool first) {
            HelpRow row;
            row.y = y;
            row.indent = first ? ln.indent : ln.indent + 14.f;
            row.dot = first && ln.dot;
            row.rule = first && ln.rule;
            row.center = first && ln.center;
            if (!ln.segs.empty()) row.dotCol = ln.segs.front().col;
            float x = 0.f, maxsz = BODY;
            for (size_t i = b; i < e; ++i) {
                HelpSeg sg = ln.segs[i];
                sg.x = x;
                x += sg.adv + 2.f;
                maxsz = std::max(maxsz, ln.segs[i].size);
                row.segs.push_back(std::move(sg));
            }
            if (row.rule) row.ruleFrom = x + 12.f;
            row.h = maxsz + 7.f;
            y += row.h + 2.f;
            helpRows_.push_back(std::move(row));
            b = e;
        };
        for (size_t i = 0; i < ln.segs.size(); ++i) {
            if (cur > 0.f && cur + ln.segs[i].adv > avail) { flush(i, b == 0); cur = 0.f; avail = CW - (ln.indent + 14.f); }
            cur += ln.segs[i].adv + 2.f;
        }
        flush(ln.segs.size(), b == 0);
        y += ln.gap;
    }
    helpTotalH_ = y;
}

void Renderer::drawHelp(sf::RenderTarget& t) {
    if (!helpOpen_) return;
    if (!helpBuilt_) buildHelp();
    const sf::FloatRect P = L_.helpPanel;
    sf::RectangleShape dim(sf::Vector2f(L_.winW, L_.winH));
    dim.setFillColor(sf::Color(22, 30, 40, 120));
    t.draw(dim);
    sf::RectangleShape pan(P.size);
    pan.setPosition(P.position);
    pan.setFillColor(kPanel);
    pan.setOutlineColor(kBtnEdge);
    pan.setOutlineThickness(1.8f);
    t.draw(pan);
    const float contentL = P.position.x + 26.f;
    const float contentW = P.size.x - 52.f;
    const float viewTop = P.position.y + 16.f;
    const float viewBot = P.position.y + P.size.y - 34.f;
    const float viewH = viewBot - viewTop;
    const float maxS = std::max(0.f, helpTotalH_ - viewH);
    if (helpScroll_ > maxS) helpScroll_ = maxS;
    for (const auto& row : helpRows_) {
        const float yy = viewTop + row.y - helpScroll_;
        if (yy < viewTop || yy + row.h > viewBot) continue; // 整行裁剪：跨视口边缘的半行不画，避免压到底部提示行
        float x0 = contentL + row.indent;
        if (row.center) {
            float wrow = 0.f;
            for (const auto& s : row.segs) wrow = std::max(wrow, s.x + s.adv);
            x0 = P.position.x + (P.size.x - wrow) * 0.5f;
        }
        if (row.dot) {
            sf::CircleShape d(2.6f);
            d.setOrigin(sf::Vector2f(2.6f, 2.6f));
            d.setPosition(sf::Vector2f(contentL + row.indent - 12.f, yy + row.h * 0.62f));
            d.setFillColor(row.dotCol);
            t.draw(d);
        }
        for (const auto& sg : row.segs) {
            const float ty = yy + row.h - sg.size - 3.5f; // 行内底对齐（基线近似）
            const float sx = x0 + sg.x;
            const sf::Font& f = fontFor(sg.text);
            const float dy = inkAlignDy(f, sg.text, (&f == &fontCJK_) ? "中" : "0", sg.size);
            if (!sg.spaced) {
                t.draw(textTLSpr(sg.text, sg.size, sg.col, sx, ty + dy));
            } else { // 字距加宽：逐字排布
                float cx = sx;
                for (const auto& ch : utf8Split(sg.text)) {
                    t.draw(textTLSpr(ch, sg.size, sg.col, cx, ty + dy));
                    cx += textAdvanceOf(fontFor(ch), ch, sg.size) + 1.f; // 字距加宽：按真实步进 +1px
                }
            }
        }
        if (row.rule) {
            const float x = contentL + row.ruleFrom;
            const float w = std::max(0.f, contentL + contentW - 8.f - x);
            if (w > 4.f) {
                sf::RectangleShape ln(sf::Vector2f(w, 1.f));
                ln.setPosition(sf::Vector2f(x, yy + row.h * 0.5f));
                ln.setFillColor(kBtnEdge);
                t.draw(ln);
            }
        }
    }
    if (helpTotalH_ > viewH + 1.f) { // 内容超高时右侧滚动条（可拖动，几何缓存供命中/拖动换算）
        const float th = std::max(30.f, viewH * viewH / helpTotalH_);
        const float ty = viewTop + (viewH - th) * (maxS > 0.f ? helpScroll_ / maxS : 0.f);
        const float tx = P.position.x + P.size.x - 10.f;
        helpTrackR_ = sf::FloatRect(sf::Vector2f(tx, viewTop), sf::Vector2f(3.f, viewH));
        helpThumbR_ = sf::FloatRect(sf::Vector2f(tx, ty), sf::Vector2f(3.f, th));
        helpViewTop_ = viewTop;
        helpViewH_ = viewH;
        helpMaxS_ = maxS;
        helpGeoOk_ = true;
        sf::RectangleShape tr(sf::Vector2f(3.f, viewH));
        tr.setPosition(sf::Vector2f(tx, viewTop));
        tr.setFillColor(kBtnEdge);
        t.draw(tr);
        sf::RectangleShape tb(sf::Vector2f(3.f, th));
        tb.setPosition(sf::Vector2f(tx, ty));
        tb.setFillColor(kInkSoft);
        t.draw(tb);
    } else {
        helpGeoOk_ = false;
    }
    t.draw(textSpr("滚轮或拖动进度条滚动 · 点击其余位置关闭", 11.f, kInkSoft, P.position.x + P.size.x * 0.5f, P.position.y + P.size.y - 18.f));
}

}
