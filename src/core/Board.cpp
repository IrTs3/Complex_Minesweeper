#include "core/Board.h"

#include "core/ComplexMath.h"

#include <algorithm>
#include <cstddef>
#include <random>
#include <vector>

namespace ms {

void Board::reset(int cols, int rows, int mines) {
    cols_ = cols;
    rows_ = rows;
    mines_ = std::min(mines, cols * rows - 1);
    realMines_ = -1;
    imagMines_ = -1;
    flags_ = 0;
    typeTotal_.fill(0);
    placed_ = false;
    won_ = false;
    lost_ = false;
    grid_.assign(static_cast<std::size_t>(cols) * rows, Cell{});
}

// 指定虚实雷数量：总数自动等于两者之和（越界会被裁剪）
void Board::reset(int cols, int rows, int realMines, int imagMines) {
    const int cap = std::max(1, cols * rows - 1);
    const int re = std::max(0, std::min(realMines, cap));
    const int im = std::max(0, std::min(imagMines, cap - re));
    reset(cols, rows, re + im);
    realMines_ = re;
    imagMines_ = im;
}

Board::Outcome Board::open(int r, int c) {
    if (!inBounds(r, c) || gameOver()) return Outcome::Nothing;

    Cell& x = at(r, c);
    if (x.opened || x.flag != MineType::None) return Outcome::Nothing;

    if (!placed_) {
        placeMines(r, c);
        computeHints();
        placed_ = true;
    }

    if (x.mine != MineType::None) {
        x.opened = true;
        x.exploded = true;
        lost_ = true;
        return Outcome::Boom;
    }

    floodOpen(r, c);

    if (checkWin()) {
        won_ = true;
        autoFlagAllMines();
        return Outcome::Won;
    }
    if (gaugeConsistent()) {
        won_ = true; // 标记方案与当前口径的提示一致：不开完安全格也算赢
        return Outcome::Won;
    }
    return Outcome::Opened;
}

// 直接设置标记（菜单选择用）：维护计数并做判胜检查
void Board::setFlag(int r, int c, MineType type) {
    if (!inBounds(r, c) || gameOver()) return;
    Cell& x = at(r, c);
    if (x.opened || x.flag == type) return;

    if (x.flag == MineType::None && type != MineType::None) ++flags_;
    else if (x.flag != MineType::None && type == MineType::None) --flags_;
    x.flag = type;

    if (placed_ && gaugeConsistent()) won_ = true;
}

// 双击开格（chord）：比经典扫雷更严格——不是"旗子数量对"，而是"每颗雷的类型都对"。
// 因为这一局里标记错了类型本身就是错的，按数量放行会让玩家存疑。
Board::ChordResult Board::chordOpen(int r, int c) {
    if (gameOver() || !inBounds(r, c)) return ChordResult::NotApplicable;
    const Cell& center = at(r, c);
    if (!center.opened || center.minesAround <= 0) return ChordResult::NotApplicable; // 只对已翻开的数字格生效

    int mineNeighbors = 0;
    bool allFlagged = true;
    forEachNeighbor(r, c, [&](int nr, int nc) {
        if (!inBounds(nr, nc)) return;
        const Cell& n = at(nr, nc);
        if (n.mine == MineType::None) return;
        ++mineNeighbors;
        // 有符号口径：标记类型必须逐颗一致；模长口径：看不到符号，有任意标记即可
        const bool ok = magnitudeMode_ ? (n.flag != MineType::None) : (n.flag == n.mine);
        if (!ok) allFlagged = false; // 有雷没标（或口径要求下标错）-> 不生效
    });
    if (mineNeighbors == 0) return ChordResult::NotApplicable;
    if (!allFlagged) return ChordResult::Blocked; // 有雷没标对 -> 交给上层决定（静默/提示/爆炸）

    bool openedAny = false;
    forEachNeighbor(r, c, [&](int nr, int nc) {
        if (!inBounds(nr, nc)) return;
        const Cell& n = at(nr, nc);
        if (n.opened || n.flag != MineType::None) return; // 已翻开 / 有标记的跳过
        open(nr, nc); // 所有雷都已正确标记，剩下的必然安全
        openedAny = true;
    });
    return openedAny ? ChordResult::Opened : ChordResult::NotApplicable;
}

// 标记类型循环：无 -> +1 -> -1 -> +i -> -i -> 无。
// 注意：右键菜单走的是 setFlag（固定五项，由玩家直接选），本函数目前**无人调用**，
// 保留给将来的键盘循环标记用；别再把注释写成"右键循环"，右键早就是菜单了。
void Board::toggleFlag(int r, int c) {
    if (!inBounds(r, c) || gameOver()) return;
    const Cell& x = at(r, c);
    if (x.opened) return;
    const int v = static_cast<int>(x.flag);
    const int next = (v == 4) ? 0 : v + 1;
    setFlag(r, c, static_cast<MineType>(next));
}

// 连锁展开只按“周围雷总数 == 0”扩散；
// 和为零但有雷的格子显示灰色 0，不展开（+1 与 -1 抵消是合法雷型）。
void Board::floodOpen(int r, int c) {
    std::vector<std::pair<int, int>> stack{{r, c}};
    while (!stack.empty()) {
        const auto [cr, cc] = stack.back();
        stack.pop_back();
        if (!inBounds(cr, cc)) continue;
        Cell& x = at(cr, cc);
        if (x.opened || x.flag != MineType::None || x.mine != MineType::None) continue;
        x.opened = true;
        if (x.minesAround == 0) {
            forEachNeighbor(cr, cc, [&](int rr, int cc2) {
                if (!inBounds(rr, cc2)) return;
                Cell& n = at(rr, cc2);
                if (!n.opened && n.flag == MineType::None && n.mine == MineType::None) stack.push_back({rr, cc2});
            });
        }
    }
}

// 布雷：排除首次点击格（棋盘够大时连同八邻域）。
// 玩家的标记不排除雷——标记只是猜测，雷可以正好在标记下面。
void Board::randomizeSeed() {
    setSeed(static_cast<std::uint32_t>(std::random_device{}()));
}

void Board::setSeed(std::uint32_t s) {
    seed_ = s;
    rng_ = Rng{s};   // 整体重置内部状态，不能只清一个分量
}

void Board::placeMines(int safeR, int safeC) {
    const int total = rows_ * cols_;
    std::vector<char> banned(static_cast<std::size_t>(total), 0);

    const bool shieldNeighbors = mines_ <= total - 9;
    banned[static_cast<std::size_t>(safeR) * cols_ + safeC] = 1;
    if (shieldNeighbors) {
        forEachNeighbor(safeR, safeC, [&](int rr, int cc) {
            if (inBounds(rr, cc)) banned[static_cast<std::size_t>(rr) * cols_ + cc] = 1;
        });
    }

    std::vector<int> candidates;
    candidates.reserve(total);
    for (int i = 0; i < total; ++i) {
        if (!banned[static_cast<std::size_t>(i)]) candidates.push_back(i);
    }

    mines_ = std::min(mines_, static_cast<int>(candidates.size()));
    rng_.shuffle(candidates.data(), candidates.size());

    if (realMines_ >= 0) {
        // 用户指定了虚实数量：造池子后洗牌，保证数量精确
        std::vector<MineType> pool;
        pool.reserve(static_cast<std::size_t>(mines_));
        for (int i = 0; i < realMines_ && static_cast<int>(pool.size()) < mines_; ++i)
            pool.push_back(signFlip(rng_) ? MineType::P1 : MineType::M1);
        for (int i = 0; i < imagMines_ && static_cast<int>(pool.size()) < mines_; ++i)
            pool.push_back(signFlip(rng_) ? MineType::Pi : MineType::Mi);
        while (static_cast<int>(pool.size()) < mines_)
            pool.push_back(signFlip(rng_) ? MineType::P1 : MineType::M1);
        rng_.shuffle(pool.data(), pool.size());
        for (int k = 0; k < mines_; ++k) {
            Cell& x = grid_[static_cast<std::size_t>(candidates[static_cast<std::size_t>(k)])];
            x.mine = pool[static_cast<std::size_t>(k)];
            ++typeTotal_[static_cast<std::size_t>(x.mine)];
        }
    } else {
        for (int k = 0; k < mines_; ++k) {
            Cell& x = grid_[static_cast<std::size_t>(candidates[static_cast<std::size_t>(k)])];
            x.mine = static_cast<MineType>(typePick(rng_));
            ++typeTotal_[static_cast<std::size_t>(x.mine)];
        }
    }
}

// 有符号复数和：+1 实部 +1，-1 实部 -1，+i 虚部 +1，-i 虚部 -1；同时统计雷总数。
void Board::computeHints() {
    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            Cell& x = at(r, c);
            if (x.mine != MineType::None) continue;
            int re = 0;
            int im = 0;
            int n = 0;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                switch (at(rr, cc).mine) {
                case MineType::P1: re += 1; ++n; break;
                case MineType::M1: re -= 1; ++n; break;
                case MineType::Pi: im += 1; ++n; break;
                case MineType::Mi: im -= 1; ++n; break;
                case MineType::None: break;
                }
            });
            x.realSum = re;
            x.imagSum = im;
            x.minesAround = n;
        }
    }
}

bool Board::checkWin() {
    for (const Cell& x : grid_) {
        if (x.mine == MineType::None && !x.opened) return false;
    }
    return true;
}

// 胜利时按真实雷型自动标记
void Board::autoFlagAllMines() {
    for (Cell& x : grid_) {
        if (x.mine != MineType::None) x.flag = x.mine;
    }
    flags_ = mines_;
}

// 轴级未覆盖计数（与 win 判据同口径，取反不变观测量）：
// 剩余雷数：经典口径，雷数减全部旗数。插在安全格上的旗也照扣，
// 旗数超过雷数就为负——UI 端把负数画成红色提醒多插了（2026-10-29 用户裁决，
// 取代旧「乱标不扣、永不为负」口径）。标错**类型**不改变本计数，看轴芯片。
int Board::remaining() const {
    if (!placed_) return mines_;
    int flags = 0;
    const int total = rows_ * cols_;
    for (int i = 0; i < total; ++i) {
        if (at(i / cols_, i % cols_).flag != MineType::None) ++flags;
    }
    return mines_ - flags;
}

// 分量实轴未被纯实提示锚定 => 该分量无论实雷标成 +1 还是 -1 都算已覆盖；
// 未被任何标记覆盖的雷数：与模长口径判胜一致（标在雷上即算覆盖，不要求类型精确；
// 标在非雷格上不占计数），m 芯片用它，随正确标记单调递减、不会为负。
int Board::uncoveredMines() const {
    if (!placed_) return 0;
    int n = 0;
    const int total = rows_ * cols_;
    for (int i = 0; i < total; ++i) {
        const Cell& cl = at(i / cols_, i % cols_);
        if (cl.mine != MineType::None && cl.flag == MineType::None) ++n;
    }
    return n;
}

// 实轴被锚定 => 只有符号与真实一致的标记才算覆盖；虚轴同理。
// 因此任意一次"分量容错"胜利都必然让两轴计数归零。
std::array<int, 3> Board::axisUnflagged() const {
    std::array<int, 3> out{};
    if (!placed_) return out;

    const int total = rows_ * cols_;
    const auto idx = [cols = cols_](int r, int c) { return r * cols + c; };
    const auto linC = [this](int i) -> const Cell& { return at(i / cols_, i % cols_); };

    // 轴级总量
    int realTotal = 0, imagTotal = 0;
    for (int i = 0; i < total; ++i) {
        const MineType mt = linC(i).mine;
        if (mt == MineType::P1 || mt == MineType::M1) ++realTotal;
        if (mt == MineType::Pi || mt == MineType::Mi) ++imagTotal;
    }
    if (realTotal + imagTotal == 0) return out;

    // 统计连通分量（union-find，同判胜）
    std::vector<int> parent(static_cast<std::size_t>(total), -1);
    for (int i = 0; i < total; ++i) {
        if (linC(i).mine != MineType::None) parent[static_cast<std::size_t>(i)] = i;
    }
    const auto find = [&](int i) -> int {
        int r = i;
        while (parent[static_cast<std::size_t>(r)] != r) r = parent[static_cast<std::size_t>(r)];
        int cur = i;
        while (parent[static_cast<std::size_t>(cur)] != cur) {
            const int nxt = parent[static_cast<std::size_t>(cur)];
            parent[static_cast<std::size_t>(cur)] = r;
            cur = nxt;
        }
        return r;
    };
    const auto unite = [&](int a, int b) {
        const int ra = find(a), rb = find(b);
        if (ra != rb) parent[static_cast<std::size_t>(rb)] = ra;
    };
    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            const Cell& x = at(r, c);
            if (!x.opened || x.minesAround == 0) continue;
            int first = -1;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                if (at(rr, cc).mine == MineType::None) return;
                const int mi = idx(rr, cc);
                if (first == -1) first = mi;
                else unite(first, mi);
            });
        }
    }

    // 锚定
    std::vector<char> realAnchored(static_cast<std::size_t>(total), 0);
    std::vector<char> imagAnchored(static_cast<std::size_t>(total), 0);
    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            const Cell& x = at(r, c);
            if (!x.opened || x.minesAround == 0) continue;
            const HintKind kind = hintKind(x.realSum, x.imagSum);
            if (kind != HintKind::PureReal && kind != HintKind::PureImag) continue;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                const MineType mt = at(rr, cc).mine;
                if (mt == MineType::None) return;
                const int root = find(idx(rr, cc));
                if (kind == HintKind::PureReal && isRealMine(mt)) realAnchored[static_cast<std::size_t>(root)] = 1;
                if (kind == HintKind::PureImag && !isRealMine(mt)) imagAnchored[static_cast<std::size_t>(root)] = 1;
            });
        }
    }

    const auto signOf = [](MineType t) { return (t == MineType::P1 || t == MineType::Pi) ? 1 : -1; };
    int handledReal = 0, handledImag = 0;
    for (int i = 0; i < total; ++i) {
        const Cell& mc = linC(i);
        if (mc.mine == MineType::None) continue;
        const int root = find(i);
        if (isRealMine(mc.mine)) {
            if (mc.flag != MineType::None && isRealMine(mc.flag)) {
                if (realAnchored[static_cast<std::size_t>(root)] == 0 || signOf(mc.flag) == signOf(mc.mine)) ++handledReal;
            }
        } else {
            if (mc.flag != MineType::None && !isRealMine(mc.flag)) {
                if (imagAnchored[static_cast<std::size_t>(root)] == 0 || signOf(mc.flag) == signOf(mc.mine)) ++handledImag;
            }
        }
    }
    out[1] = realTotal - handledReal;
    out[2] = imagTotal - handledImag;
    return out;
}

bool Board::allMinesFlaggedGaugeConsistent() const {
    if (!placed_ || mines_ <= 0) return false;
    if (flags_ != mines_) return false; // 多标或少标都不判胜

    // 1) 统计连通分量：同一"已开提示格"的邻域内出现的雷互相连通（union-find）。
    const int total = rows_ * cols_;
    const auto idx = [cols = cols_](int r, int c) { return r * cols + c; };
    const auto linC = [this](int i) -> const Cell& { return at(i / cols_, i % cols_); };

    std::vector<int> parent(static_cast<std::size_t>(total), -1);
    for (int i = 0; i < total; ++i) {
        if (linC(i).mine != MineType::None) parent[static_cast<std::size_t>(i)] = i;
    }
    const auto find = [&](int i) -> int {
        int r = i;
        while (parent[static_cast<std::size_t>(r)] != r) r = parent[static_cast<std::size_t>(r)];
        int cur = i;
        while (parent[static_cast<std::size_t>(cur)] != cur) {
            const int nxt = parent[static_cast<std::size_t>(cur)];
            parent[static_cast<std::size_t>(cur)] = r;
            cur = nxt;
        }
        return r;
    };
    const auto unite = [&](int a, int b) {
        const int ra = find(a), rb = find(b);
        if (ra != rb) parent[static_cast<std::size_t>(rb)] = ra;
    };

    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            const Cell& x = at(r, c);
            if (!x.opened || x.minesAround == 0) continue;
            int first = -1;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                if (at(rr, cc).mine == MineType::None) return;
                const int mi = idx(rr, cc);
                if (first == -1) first = mi;
                else unite(first, mi);
            });
        }
    }

    // 2) 锚定：某分量有实雷被"纯实"提示格看到 => 实轴不可取反；虚轴同理。
    std::vector<char> realAnchored(static_cast<std::size_t>(total), 0);
    std::vector<char> imagAnchored(static_cast<std::size_t>(total), 0);
    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            const Cell& x = at(r, c);
            if (!x.opened || x.minesAround == 0) continue;
            const HintKind kind = hintKind(x.realSum, x.imagSum);
            if (kind != HintKind::PureReal && kind != HintKind::PureImag) continue;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                const MineType mt = at(rr, cc).mine;
                if (mt == MineType::None) return;
                const int root = find(idx(rr, cc));
                if (kind == HintKind::PureReal && isRealMine(mt)) realAnchored[static_cast<std::size_t>(root)] = 1;
                if (kind == HintKind::PureImag && !isRealMine(mt)) imagAnchored[static_cast<std::size_t>(root)] = 1;
            });
        }
    }

    // 3) 检查标记：每颗雷都必须有标记、轴必须一致；每个分量内实部/虚部各自整体一致，
    //    且不允许对"被锚定"的轴做整体取反。
    std::vector<char> seen(static_cast<std::size_t>(total), 0);
    std::vector<int> realFlip(static_cast<std::size_t>(total), -1);
    std::vector<int> imagFlip(static_cast<std::size_t>(total), -1);
    const auto signOf = [](MineType t) { return (t == MineType::P1 || t == MineType::Pi) ? 1 : -1; };

    for (int i = 0; i < total; ++i) {
        const Cell& mc = linC(i);
        if (mc.mine == MineType::None) continue;
        if (mc.flag == MineType::None) return false;                 // 所有雷都必须被标记
        if (isRealMine(mc.flag) != isRealMine(mc.mine)) return false; // 轴必须一致
        const int root = find(i);
        seen[static_cast<std::size_t>(root)] = 1;
        const int f = (signOf(mc.flag) != signOf(mc.mine)) ? 1 : 0;
        if (isRealMine(mc.mine)) {
            int& v = realFlip[static_cast<std::size_t>(root)];
            if (v == -1) v = f;
            else if (v != f) return false; // 分量内实部取向必须整体一致
        } else {
            int& v = imagFlip[static_cast<std::size_t>(root)];
            if (v == -1) v = f;
            else if (v != f) return false;
        }
    }

    for (int root = 0; root < total; ++root) {
        if (!seen[static_cast<std::size_t>(root)]) continue;
        if (realFlip[static_cast<std::size_t>(root)] == 1 && realAnchored[static_cast<std::size_t>(root)]) return false;
        if (imagFlip[static_cast<std::size_t>(root)] == 1 && imagAnchored[static_cast<std::size_t>(root)]) return false;
    }
    return true;
}

// 模长口径（「总是显示模长」模式）：玩家看不到符号，判据放宽为
// ① 标记集合与雷集合完全一致（标记总数==雷数 且 每颗雷都有标记 => 不多不少）；
// ② 每个已翻开格的"可见模长" |Σ雷| 恰好等于其邻域"标记和"的模长 |Σ标|。
// 即：不要求每颗雷标记的精确类型，但要求标记方案能解释全部可见提示。
bool Board::allMinesFlaggedMagnitudeConsistent() const {
    if (!placed_ || mines_ <= 0) return false;
    if (flags_ != mines_) return false;
    const auto reOf = [](MineType t) { return t == MineType::P1 ? 1 : t == MineType::M1 ? -1 : 0; };
    const auto imOf = [](MineType t) { return t == MineType::Pi ? 1 : t == MineType::Mi ? -1 : 0; };
    for (const Cell& x : grid_) {
        if (x.mine != MineType::None && x.flag == MineType::None) return false; // 每颗雷都必须有标记
    }
    for (int r = 0; r < rows_; ++r) {
        for (int c = 0; c < cols_; ++c) {
            const Cell& x = at(r, c);
            if (!x.opened) continue;
            int reF = 0, imF = 0;
            forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!inBounds(rr, cc)) return;
                reF += reOf(at(rr, cc).flag);
                imF += imOf(at(rr, cc).flag);
            });
            const int sMine = x.realSum * x.realSum + x.imagSum * x.imagSum; // 真实和的模长² = 可见提示
            if (reF * reF + imF * imF != sMine) return false;
        }
    }
    return true;
}

bool Board::gaugeConsistent() const {
    return magnitudeMode_ ? allMinesFlaggedMagnitudeConsistent() : allMinesFlaggedGaugeConsistent();
}

// 局中切换「总是显示模长」：棋盘状态（翻开/标记/计时）全部保留；
// 若当前标记已满足新口径，则立即记胜（不剥夺已成立的胜利）。
void Board::setMagnitudeMode(bool on) {
    if (magnitudeMode_ == on) return;
    magnitudeMode_ = on;
    if (placed_ && !lost_ && gaugeConsistent()) won_ = true;
}

}
