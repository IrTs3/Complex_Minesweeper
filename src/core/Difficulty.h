#pragma once

namespace ms {

struct Difficulty {
    int cols;
    int rows;
    int mines;
};

inline constexpr Difficulty kDiffs[3] = {{9, 9, 12}, {16, 16, 40}, {24, 16, 72}};

inline constexpr const char* kDiffNames[3] = {"Easy 9x9x12", "Medium 16x16x40", "Hard 24x16x72"};

} // namespace ms
