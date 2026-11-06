#pragma once
#include <cmath>
#include <cstdlib>
#include <string>

namespace ms {

// 提示值 = |周围雷的复数和| = sqrt(realSum^2 + imagSum^2)。
// realSum/imagSum 是有符号的：+1 与 -1、+i 与 -i 会相互抵消。
inline int squaredMagnitude(int re, int im) { return re * re + im * im; }

inline double magnitude(int re, int im) { return std::sqrt(static_cast<double>(squaredMagnitude(re, im))); }

// 返回 s 的最大平方因子 f，即 s = f^2 * r 且 r 无平方因子。
inline int largestSquareFactor(int s) {
    int f = 1;
    for (int k = 2; k * k <= s; ++k) {
        while (s % (k * k) == 0) {
            s /= k * k;
            f *= k;
        }
    }
    return f;
}

// 提示字符串（按模长，与符号无关）：整数 -> "5"；否则最简根式 -> "√2"、"2√2"…
inline std::string formatHint(int re, int im) {
    const int m = std::abs(re);
    const int n = std::abs(im);
    if (m == 0 && n == 0) return {};
    if (n == 0) return std::to_string(m);
    if (m == 0) return std::to_string(n);
    const int s = m * m + n * n;
    const int f = largestSquareFactor(s);
    const int r = s / (f * f);
    if (r == 1) return std::to_string(f);
    return (f > 1 ? std::to_string(f) : std::string()) + "\u221A" + std::to_string(r);
}

// 纯实/纯虚：显示带正负号的和（+2 / -3 / +3i / -i）；纯抵消返回空串；
// 混合：返回模长（同 formatHint，根式或勾股整数）。
inline std::string formatHintSigned(int re, int im) {
    if (im == 0 && re != 0) {
        return std::string(re > 0 ? "+" : "-") + std::to_string(std::abs(re));
    }
    if (re == 0 && im != 0) {
        const int m = std::abs(im);
        return std::string(im > 0 ? "+" : "-") + (m == 1 ? "i" : std::to_string(m) + "i");
    }
    return formatHint(re, im);
}

// 提示分类（配色用）
enum class HintKind { Empty, PureReal, PureImag, Mixed };

inline HintKind hintKind(int re, int im) {
    if (re == 0 && im == 0) return HintKind::Empty;
    if (im == 0) return HintKind::PureReal;
    if (re == 0) return HintKind::PureImag;
    return HintKind::Mixed;
}

}
