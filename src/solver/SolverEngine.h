// SolverEngine.h — 复数扫雷「自由推理求解器」引擎（header-only，namespace msolve）。
//
// 从 solver.cpp（复盘统计 CLI）抽出，游戏内「机器演示」与 CLI 统计共用同一引擎——
// 现场演示的每一步与 300 局统计数字背后是同一套推理，可信度同源。
//
// 诚实契约：只用玩家可见信息，绝不读 Board 内部雷位——
//   空白=周围无雷；黄0=雷数和为0且≥2颗（抵消成对）；带号提示=精确复数和；
//   混合提示=只知 |z|² 且和非纯轴；每个提示蕴含邻域雷数下界与奇偶；HUD 两轴剩余计数与总雷数。
// 预算：FULL_SOL/FULL_NODE 等封顶，超限的分量降级为「见证覆盖」——只会少下结论不会下错结论
//   （必开格踩雷=引擎 bug，CLI 自检列 forcedBooms 必须恒 0；游戏内接入时同样禁止读 mine）。
// 概率：FULL 分量按 profile 分层计数 + 前后向二维卷积（内部格并入二项吸收池）精确算每格含雷率；
//   卷积超预算或存在降级分量时回退采样估计并置 approx 标记（诚实降级，不虚报精度）。
//   概率惰性计算：analyze 只存快照，猜格/提示前由 ensureExactProbs() 按需跑卷积（analyzeForHint 已含）。
// budgetK：预算倍率，游戏内演示建议 1（分析单步最坏约 0.3s 档由覆盖模式兜底）。
//
// ★ 2026-10-23 P0 重做「枚举」这一层（三处改动，都经 oracle 对拍验证）：
//   ① 解集存储退役：FULL 路径改为按 profile **计数**（profSolCnt / profCellMine /
//      profCellTypes），不再把每条解塞进 vector。原来撞到 FULL_SOL=60000 就整分量降级，
//      而实测**所有**降级都是这条撞的（不是节点预算）——17~32 变量的大分量本来只需
//      ≤2.3M 节点（预算 4M 之内）就能算完，纯粹是解太多存不下。消费解集的三处
//      （逐格见证 / 必雷类型唯一性 / 调试转储）分别改用 profCellMine / profCellTypes / gDbg。
//   ② ok() 换成精确必要条件：达到目标 (re,im) 至少 need=|Δre|+|Δim| 颗雷，且**用掉的雷数
//      与 need 同奇偶**（多出来的净零贡献必须成对 +1/-1）。混合线索按圆上的分解点逐点算，
//      原来那套「25×25 可达性猜测」已删除。
//   ③ 单元传播：某线索只剩 1 个自由变量时取值被唯一确定 → 直接落地并级联
//      （工作队列 unitQ_，不是每节点全扫）。混合线索的判定**必须包含 dd=0**
//      （最后一个自由格可能是安全格），否则会错杀合法解。
//   实测（Medium 500 局，seed=20261008，budgetK=1）：30.0% → 49.6%，降级分量 3413 → 1264。
//   子集相减（deriveSubsetCons）实现但默认关闭：它是逻辑推论（冗余），
//   派生的约束只增加每节点开销、剪不到新分支，实测 -6 个点。留给 P1 的 DP 路径复用。
//
// ★ 2026-10-24 P1：低树宽 DP（BucketDP）取代「大分量的枚举」。
//   枚举对 33–64 变量的分量是徒劳的（实测平均 460 万节点、最大打满 3000 万仍未穷尽）；
//   而它们因子图的**诱导宽度只有 4~6**（Medium 实测中位 4~5、p90 6），于是
//   O(D^w) 的桶消元一次就能精确解完（D=5，5^6=15625）。
//   DP 产出每格的**精确**边际 → anyMine / anySafe / 雷型 / 含雷率，全部精确。
//   DP **不产出** (re,im) 分层的 profile 计数（那要把 profile 当多项式带进消元，
//   卷积代价 ×(profile 数)²，实测不划算），所以 DP 分量不参与跨分量二维卷积、并入吸收池，
//   含雷率用分量内边际（approx 标记照旧）。
//   ⚠ 实测教训：让「17–32 变量的分量也走 DP」会把跨分量卷积的大半输入抽走，
//     胜率从 65% 掉到 **24%**。FULL 分量的 profile 是全局剪枝的命根子，不能随便换成 DP。
//     所以只对 33+ 变量的分量先走 DP（它们本来枚举必截断），17–32 仍走 DFS 拿 profile。
//   DP 与 DFS 的唯一语义差异：DP 不做 `re<=rlim && im<=ilim` 剪枝 → 解集是超集 →
//     见证只会更保守，不会错下结论（oracle 对拍也是按「不加 cut」比的）。
#pragma once

#include "core/Board.h"

#include <algorithm>
#include <climits>  // gcc（linux/mingw）不隐式携带，INT_MAX 必须显式引
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cmath>
#include <random>
#include <map>
#include <string>
#include <unordered_map>
#include <vector>

namespace msolve {

using namespace ms;

inline bool gDbg = false; // 调试模式：允许偷看答案做自检转储（发布默认关）

// 第四代 A1 环境开关（产品路径零开销：static 一次求值）。
//   MS_LAYERED     分层 BucketDP（A2 过闸后**缺省开**；=0 显式关闭回旧标量路径）
//   MS_DP_ORACLE=1 开 oracle 对拍（只在分层成功时运行，暴力枚举分量并逐项对拍）
inline bool msEnvFlag(const char* name) {
    const char* e = getenv(name);
    return e && e[0] == '1';
}
inline bool msLayeredEnabled() {
    static const bool v = [] {
        const char* e = getenv("MS_LAYERED");
        return e ? e[0] != '0' : true; // 缺省开：Medium 65.0→86.4%、Hard 17.4→58.0%（McNemar 107-0 / 209-6）
    }();
    return v;
}
inline bool msOracleEnabled() {
    static const bool v = msEnvFlag("MS_DP_ORACLE");
    return v;
}


constexpr int CRE[5] = {0, 1, -1, 0, 0};
constexpr int CIM[5] = {0, 0, 0, 1, -1};
inline int sq(int x) { return x * x; }

enum Kind : uint8_t { K_SUM, K_MIX, K_CNT };
struct Con {
    Kind kind = K_SUM;
    int re = 0, im = 0, mixS = 0, minMines = 0, cnt = 0;
    int offRe = 0, offIm = 0; // 邻域内已标记雷的已知贡献（MIX 用；SUM/CNT 直接并入目标）
    int minCnt = -1, par = -1; // 复数提示蕴含：n>=minCnt 且 n%2==par
    std::vector<int> lv;
};

inline int mixMinCnt(int s) {
    int best = 1 << 20;
    for (int a = 1; a * a < s; ++a) {
        const int b2 = s - a * a;
        const int b = (int)std::sqrt((double)b2);
        if (b * b == b2 && b > 0) best = std::min(best, a + b);
    }
    return best;
}

// ★ P0-A：把 |z|²=s 展开成可行的 (re,im) 分解点集 —— 即所有 a²+b²=s（a,b≠0）带 ±号、带顺序。
// 这是「混合线索线性化」的分解表：任何相容解的邻域和必须落在其中恰好一个点上。
// 返回点个数（写入 out，容量上限 cap）。
inline int mixPoints(int s, int (*out)[2], int cap) {
    int n = 0;
    for (int a = 1; a * a < s && n + 4 <= cap; ++a) {
        const int b2 = s - a * a;
        const int b = (int)std::sqrt((double)b2);
        if (b * b != b2 || b == 0) continue;
        const int cand[8][2] = {{a, b}, {a, -b}, {-a, b}, {-a, -b}, {b, a}, {b, -a}, {-b, a}, {-b, -a}};
        for (int k = 0; k < 8 && n < cap; ++k) {
            // 去重（a==b 时 (a,b) 与 (b,a) 相同）
            bool dup = false;
            for (int j = 0; j < n && !dup; ++j) dup = (out[j][0] == cand[k][0] && out[j][1] == cand[k][1]);
            if (!dup) { out[n][0] = cand[k][0]; out[n][1] = cand[k][1]; ++n; }
        }
    }
    return n;
}

struct CompOut {
    // FULL=全量枚举（有 profile，可参与跨分量卷积）
    // DPSOLVED=低树宽 DP 精确解出（有精确见证与边际；P2 起还带 (nr,ni) **支撑集**）
    // COVERED/BUDGET=降级（COVERED=纯随机采样；BUDGET=还做过定向存在性搜索，见证可靠）
    enum Status : uint8_t { FULL, COVERED, BUDGET, DPSOLVED } status = FULL;
    std::vector<std::vector<uint8_t>> sols;      // 仅 gDbg 转储用；正常路径按 profile 计数，不再逐条存解
    std::vector<int> solProfile;
    std::vector<std::pair<int,int>> profiles;
    // ★ 第四代 A1：计数从 int 拓宽到 long double。枚举路径的解数 ≤ 数十万，int 绰绰有余；
    //   但分层 DP 的解数可达 5^40 量级（这正是它取代枚举的大分量），int 必溢出。
    //   exactProbs 的卷积本来就是 long double，这里的精度损失 ≤1e-19 相对误差，可忽略。
    std::vector<long double> profSolCnt;             // 每个 profile 的相容解条数（取代逐条 solProfile）
    std::vector<std::vector<uint8_t>> profCellTypes; // [profile][变量] 该格出现过的雷型位掩码（1<<1..1<<4）
    std::vector<char> anyMine, anySafe;          // 见证覆盖
    std::vector<int> mineSolCount;               // 概率估计分子/分母
    std::vector<std::vector<long double>> profCellMine;  // 仅 FULL：[profile][变量] 含雷解数（分层精确概率用）
    std::vector<double> cellProb;                // 仅 DPSOLVED：每格含雷率（分量内精确边际）
    std::vector<uint8_t> typeMask;               // 仅 DPSOLVED：每格出现过的雷型位掩码
    // ★ supportOnly=true：profiles 里装的是 DP 的 (nr,ni) **支撑集**（可达点，不带计数）。
    //   它只能用于布尔可达性（globalFilter 的 pref/suff/valid），
    //   **绝不能**进 exactProbs 的卷积（权重是假的）、也绝不能进见证循环
    //   （profCellMine 为空，误用会把"该 profile 里有安全解"判成否）。
    bool supportOnly = false;
    int sampleCount = 0;
};

struct CompTask {
    std::vector<int> gvars;
    std::vector<Con> cons;
    std::vector<std::vector<int>> varCons;
    bool classic = false;
    int rlim = 1 << 20, ilim = 1 << 20;
};

class Enumerator {
public:
    Enumerator(const CompTask& t, uint64_t salt, int bk) : t_(t), budgetK_(bk < 1 ? 1 : bk), rng_((uint64_t)t.gvars.size() * 0x9E3779B97F4A7C15ull + salt) {}

    // 阶段1：尝试全量枚举
    CompOut runFull() {
        mode_ = 0; // full
        out_ = CompOut{};
        init();
        if (nvar() == 0) { // 空分量：恰好一条空解
            out_.profiles.emplace_back(0, 0);
            out_.profSolCnt.push_back(1);
            out_.profCellMine.emplace_back();
            out_.profCellTypes.emplace_back();
            out_.sampleCount = 1;
            return out_;
        }
        fullTrunc_ = false;
        nodes_ = 0;
        dfsFull(0);
        undoTo(0);
        if (fullTrunc_) { out_ = CompOut{}; out_.status = CompOut::COVERED; return out_; } // 交调用方走阶段2
        return out_;
    }

    // 阶段2：见证覆盖（要求 runFull 之后重新调用；复用约束状态）
    void runCover(CompOut& out) {
        mode_ = 1; // 覆盖/存在性搜索不维护分层计数（采样概率无分层意义且省内存）
        out_ = CompOut{}; // 全量截断对象无保留价值，从零开始做覆盖搜索
        out_.sols.clear(); out_.solProfile.clear(); out_.profiles.clear();
        out_.anyMine.assign(nvar(), 0);
        out_.anySafe.assign(nvar(), 0);
        out_.mineSolCount.assign(nvar(), 0);
        out_.sampleCount = 0;
        needCov_ = nvar() * 2;
        // 随机取值序覆盖搜索
        resetCs();
        nodes_ = 0;
        dfsCover(0, 0, 0);
        if (needCov_ > 0) {
            out.status = CompOut::BUDGET;
            // 未覆盖格做定向存在性搜索（各自独立预算）
            for (int v = 0; v < nvar(); ++v) {
                for (int want = 0; want < 2; ++want) { // 0=找安全解, 1=找含雷解
                    char& flag = want ? out_.anyMine[v] : out_.anySafe[v];
                    if (flag) continue;
                    resetCs();
                    nodes_ = 0;
                    existsLeft_ = 2;
                    timedout_ = false;
                    target_ = v; targetMine_ = want;
                    existsSearch(0, 0, 0);
                    if (existsLeft_ == 1) flag = 1;
                    else if (timedout_) { out_.anyMine[v] = 1; out_.anySafe[v] = 1; } // 未知 → 保守双可能
                    // 预算内穷尽且未找到 = 证明该取值不存在，flag 保持 0（结论可靠）
                }
            }
        } else {
            out.status = CompOut::COVERED;
        }
        out.sols = std::move(out_.sols);
        out.sampleCount = out_.sampleCount;
        out.mineSolCount = std::move(out_.mineSolCount);
        out.anyMine = std::move(out_.anyMine);
        out.anySafe = std::move(out_.anySafe);
        return;
    }

private:
    struct ConState { int sRe = 0, sIm = 0, sCnt = 0, freeCnt = 0; };
    static constexpr int FULL_SOL = 60000;
    static constexpr long long FULL_NODE = 4000000;
    static constexpr long long COVER_NODE = 600000;
    static constexpr long long EXISTS_NODE = 200000;
    static constexpr int SAMPLE_MAX = 4000;

    const CompTask& t_;
    int budgetK_ = 1;
    std::mt19937 rng_;
    int mode_ = 0;
    CompOut out_;
    long long nodes_ = 0;
    bool fullTrunc_ = false;
    int needCov_ = 0, target_ = -1, targetMine_ = 0;
    int existsLeft_ = 0; // 存在性搜索剩余目标数：2=未找到穷尽, 1=找到
    std::vector<int> order_;
    std::vector<int8_t> val_;
    std::vector<ConState> cs_;
    std::vector<std::vector<std::array<int,2>>> mixPts_; // K_MIX 的可行分解点（P0-A）
    std::vector<std::vector<ConState>> snapAll_; // 每变量的约束状态快照（传播连锁回退用）
    std::vector<char> assigned_;                 // 该变量已定值（含传播定值）
    std::vector<int> trail_;                     // 赋值顺序（回退用）
    std::vector<int> unitQ_;                     // 待传播的「单自由线索」队列
    int curR_ = 0, curI_ = 0;                    // 当前已用实/虚雷数（rlim/ilim 剪枝）
    std::unordered_map<uint32_t, int> profIdx_; // (pnr,pni) → profile 号

    int nvar() const { return (int)t_.gvars.size(); }
    void init() {
        const int n = nvar();
        val_.assign(n, 0);
        // 变量序：按「参与的线索条数」降序（度数高的先拆）。
        // 试过贪心「最受约束优先」（每步选所属线索中未定变量最少者），实测更差
        // （Medium 100 局 50.0% vs 53.0%，降级分量 235 vs 204），故保留原序。
        order_.resize(n);
        for (int i = 0; i < n; ++i) order_[i] = i;
        std::sort(order_.begin(), order_.end(), [&](int a, int b) {
            return t_.varCons[a].size() > t_.varCons[b].size();
        });
        cs_.assign(t_.cons.size(), ConState{});
        profIdx_.clear();
        mixPts_.assign(t_.cons.size(), {});
        for (size_t j = 0; j < t_.cons.size(); ++j) {
            if (t_.cons[j].kind != K_MIX) continue;
            int pts[64][2];
            const int np = mixPoints(t_.cons[j].mixS, pts, 64);
            mixPts_[j].reserve((size_t)np);
            for (int i = 0; i < np; ++i) mixPts_[j].push_back({pts[i][0], pts[i][1]});
        }
        resetCs();
        assigned_.assign(n, 0);
        trail_.clear();
        trail_.reserve((size_t)n + 8);
        unitQ_.clear();
        unitQ_.reserve((size_t)n + 8);
        snapAll_.assign(n, {});
        for (int i = 0; i < n; ++i) snapAll_[(size_t)i].assign(t_.varCons[i].size(), ConState{});
        curR_ = curI_ = 0;
        out_.anyMine.assign(n, 0);
        out_.anySafe.assign(n, 0);
        out_.mineSolCount.assign(n, 0);
    }
    void resetCs() {
        for (auto& s : cs_) { s.sRe = s.sIm = s.sCnt = 0; }
        for (size_t j = 0; j < t_.cons.size(); ++j) cs_[j].freeCnt = (int)t_.cons[j].lv.size();
    }

    static bool cntFeasible(int lo, int hi, int minCnt, int par) {
        if (hi < lo) return false;
        int n = std::max(lo, minCnt < 0 ? lo : minCnt);
        if (par >= 0 && (n & 1) != par) ++n;
        return n <= hi;
    }

    // ★ P0-A/B 核心：把 ok() 从「L1 可达性猜测」换成**精确的必要条件**。
    //
    // 关键观察（原来漏掉的）：一次「放一颗雷」只让 |re|+|im| 增加 1，所以
    //   ① 要达到目标 (re,im)，至少需要 need = |Δre|+|Δim| 颗雷 —— 原来只用它当上界检查；
    //   ② 而且用掉的雷数 m 与 need **同奇偶**（每多一颗净零贡献要成对 +1/-1，一次加 2）。
    // 于是「剩余的雷数是否可能同时满足线索的计数下界/奇偶」变成了一个可精确判定的问题，
    // 而不是把区间 [sCnt, sCnt+f] 一把丢给 cntFeasible 就完事。
    // 混合线索同理：目标不是点而是圆 |z|²=s 上的若干分解点，逐点算 need 再按同奇偶枚举 m。
    // 这些都是**必要**条件（不放行错解），只是把「够宽」换成「够紧」。
    bool ok(int ci, const ConState& s) const {
        const Con& c = t_.cons[(size_t)ci];
        const int f = s.freeCnt, sCnt = s.sCnt;
        if (c.kind == K_SUM) {
            int need = 0;
            if (!t_.classic) {
                const int dr = c.re - s.sRe, di = c.im - s.sIm;
                need = std::abs(dr) + std::abs(di);
                if (f == 0 && need != 0) return false; // 已定完但和不对
            }
            if (sCnt + f < c.minMines) return false;
            if (need > f) return false;
            // ★ 剩余要放 m 颗，而 m 与 need **同奇偶**（每多一颗净零贡献得成对 +1/-1）。
            //   原来只查「need ≤ f」就把区间丢给 cntFeasible，允许了错的奇偶 → 白放行。
            int lo = need;
            if (c.minCnt >= 0 && sCnt + lo < c.minCnt) {
                const int d2 = c.minCnt - (sCnt + lo);
                lo += (d2 + 1) & ~1; // 抬到 ≥minCnt 且仍与 need 同奇偶
            }
            if (lo > f) return false;
            if (c.par >= 0 && ((sCnt + lo) & 1) != c.par) lo += 2;
            return lo <= f;
        }
        if (c.kind == K_MIX) {
            const int cr = s.sRe + c.offRe, ci2 = s.sIm + c.offIm; // 含已知雷的完整和
            const auto& pts = mixPts_[(size_t)ci];
            if (f == 0) return sq(cr) + sq(ci2) == c.mixS && cr != 0 && ci2 != 0;
            for (const auto& p : pts) { // 逐个可行分解点：need=|差分|，m 与 need 同奇偶
                const int d = std::abs(p[0] - cr) + std::abs(p[1] - ci2);
                if (d > f) continue;
                for (int m = d; m <= f; m += 2) {
                    const int tot = sCnt + m;
                    if (c.minCnt >= 0 && tot < c.minCnt) continue;
                    if (c.par >= 0 && (tot & 1) != c.par) continue;
                    return true;
                }
            }
            return false;
        }
        // K_CNT：计数必须精确等于 cnt
        if (sCnt > c.cnt || sCnt + f < c.cnt) return false;
        return true;
    }

    // —— 带 trail 的赋值（dfsFull 用：支持传播后连锁回退）——
    bool pushAssign(int v, int d) {
        const auto& vcs = t_.varCons[v];
        auto& snap = snapAll_[(size_t)v];
        for (size_t k = 0; k < vcs.size(); ++k) snap[k] = cs_[(size_t)vcs[k]];
        val_[v] = (int8_t)d;
        assigned_[v] = 1;
        trail_.push_back(v);
        const int dre = t_.classic ? 0 : CRE[d];
        const int dim = t_.classic ? 0 : CIM[d];
        if (d) { if (t_.classic || CRE[d]) ++curR_; else ++curI_; }
        bool good = true;
        for (size_t k = 0; k < vcs.size(); ++k) {
            ConState& s = cs_[(size_t)vcs[k]];
            s.sRe += dre; s.sIm += dim; s.sCnt += (d ? 1 : 0); --s.freeCnt;
            if (s.freeCnt == 1) unitQ_.push_back((int)vcs[k]); // 变单自由 → 入传播队列
            if (!ok((int)vcs[k], s)) { good = false; break; }
        }
        return good;
    }
    void undoTo(size_t mark) {
        while (trail_.size() > mark) {
            const int v = trail_.back(); trail_.pop_back();
            const int d = val_[v];
            if (d) { if (t_.classic || CRE[d]) --curR_; else --curI_; }
            const auto& vcs = t_.varCons[v];
            const auto& snap = snapAll_[(size_t)v];
            for (size_t k = 0; k < vcs.size(); ++k) cs_[(size_t)vcs[k]] = snap[k];
            val_[v] = 0; assigned_[v] = 0;
        }
    }

    // 单格步进值：一格的贡献只能是 (0,0)/(±1,0)/(0,±1)，反查成取值 0..4
    static int stepValue(int dr, int di) {
        if (dr == 0 && di == 0) return 0;
        if (dr == 1 && di == 0) return 1;
        if (dr == -1 && di == 0) return 2;
        if (dr == 0 && di == 1) return 3;
        if (dr == 0 && di == -1) return 4;
        return -1;
    }

    // ★ P0-B 单元传播：某条线索只剩 1 个自由变量时，它的取值被**唯一确定**，直接落地。
    //   三种线索各自的判定：
    //     K_SUM：剩余和必须是单格步进（(0,0)/±e_x/±e_y），否则这步无解、回退；
    //     K_MIX：剩余必须恰好落到圆上某个分解点，且只有唯一一步可达时才定值；
    //     K_CNT：只知道"必须非零"，类型不定 → 不定值（保守）。
    //   传播只是把 DFS 本来在更深层才会发现的事提前，**不放宽任何判定**。
    bool propagate() {
        while (!unitQ_.empty()) {
            const int c = unitQ_.back();
            unitQ_.pop_back();
            const ConState& s = cs_[(size_t)c];
            if (s.freeCnt != 1) continue; // 已被别的传播处理过，或已定完
            const Con& con = t_.cons[(size_t)c];
            int v = -1;
            for (int l : con.lv) if (!assigned_[(size_t)l]) { v = l; break; }
            if (v < 0) continue;
            int d = -1;
            if (con.kind == K_SUM) {
                if (!t_.classic) d = stepValue(con.re - s.sRe, con.im - s.sIm);
            } else if (con.kind == K_MIX) {
                const int cr = s.sRe + con.offRe, ci = s.sIm + con.offIm;
                int cnt = 0, cand = -1;
                // ★ dd 必须从 0 起：最后一个自由格完全可能是**安全格**（和已经落在圆上）。
                //   只试 dd=1..4 会把这种情况错判成「必须放雷」，进而错杀合法解 —— 不诚实。
                for (int dd = 0; dd <= 4; ++dd) {
                    const int fr = cr + CRE[dd], fi = ci + CIM[dd];
                    if (sq(fr) + sq(fi) != con.mixS) continue;
                    if (fr == 0 || fi == 0) continue; // 混合线索的完整和两轴都非零
                    const int tot = s.sCnt + (dd ? 1 : 0);
                    if (con.minCnt >= 0 && tot < con.minCnt) continue;
                    if (con.par >= 0 && (tot & 1) != con.par) continue;
                    ++cnt; cand = dd;
                }
                if (cnt == 1) d = cand;
            }
            if (d < 0) continue;
            if (!pushAssign(v, d)) return false;
            // ★ 雷数上限（rlim/ilim = 全盘剩余实/虚雷数）是必要条件，**传播也要守**：
            //   原来只在 DFS 每次赋值后查一次，改成传播后连锁定值就可能一次多推两颗，
            //   越过上限的解会被当成合法解枚举出来（oracle 对拍抓到的就是这个）。
            if (curR_ > t_.rlim || curI_ > t_.ilim) return false;
        }
        return true;
    }

    bool applyAssign(int v, int d, ConState* snap) {
        const auto& vcs = t_.varCons[v];
        for (size_t k = 0; k < vcs.size(); ++k) snap[k] = cs_[vcs[k]];
        val_[v] = (int8_t)d;
        const int dre = t_.classic ? 0 : CRE[d];
        const int dim = t_.classic ? 0 : CIM[d];
        bool good = true;
        for (size_t k = 0; k < vcs.size() && good; ++k) {
            ConState& s = cs_[vcs[k]];
            s.sRe += dre; s.sIm += dim; s.sCnt += (d ? 1 : 0); --s.freeCnt;
            good = ok((int)vcs[k], s);
        }
        return good;
    }
    void undoAssign(int v, const ConState* snap) {
        const auto& vcs = t_.varCons[v];
        for (size_t k = 0; k < vcs.size(); ++k) cs_[vcs[k]] = snap[k];
    }

    // 找/建 profile 槽（哈希索引，避免每条解都线性扫 profiles）
    int findOrAddProfile(int pnr, int pni) {
        const uint32_t key = ((uint32_t)(pnr + 512) << 10) | (uint32_t)(pni + 512);
        auto it = profIdx_.find(key);
        if (it != profIdx_.end()) return it->second;
        const int pid = (int)out_.profiles.size();
        out_.profiles.push_back(std::make_pair(pnr, pni));
        out_.profCellMine.emplace_back(nvar(), 0);
        out_.profCellTypes.emplace_back(nvar(), 0);
        out_.profSolCnt.push_back(0);
        profIdx_.emplace(key, pid);
        return pid;
    }

    // ★ FULL 路径的唯一累加入口：按 profile 计数，**不逐条存解**
    // 为什么改：原实现把每条解塞进 out_.sols，撞到 FULL_SOL=60000 就整分量降级；
    // 实测 Medium 的降级里 17–32 变量桶全部是这样「假降级」——它们本来只需要
    // ≤2.3M 节点（预算 4M 之内），只是解太多存不下。解集存储只被三处消费
    // （globalFilter 的逐格见证、必雷类型唯一性、debugDump），前两者用
    // profCellMine / profCellTypes 就够，故解集退役。
    void profileAccum(int pnr, int pni) {
        ++out_.sampleCount;
        const int pid = findOrAddProfile(pnr, pni);
        ++out_.profSolCnt[(size_t)pid];
        auto& cm = out_.profCellMine[(size_t)pid];
        auto& ct = out_.profCellTypes[(size_t)pid];
        for (int i = 0; i < nvar(); ++i) {
            const int d = val_[i];
            if (!d) continue;
            ++out_.mineSolCount[(size_t)i];
            ++cm[(size_t)i];
            ct[(size_t)i] = (uint8_t)(ct[(size_t)i] | (1u << d));
        }
    }

    // 覆盖/采样路径用（降级分量的样本解，给概率估计与 gDbg）
    void profileAdd(int pnr, int pni, const std::vector<uint8_t>& s) {
        out_.sampleCount++;
        for (int i = 0; i < nvar(); ++i) if (s[i]) out_.mineSolCount[i]++;
        const int pid = findOrAddProfile(pnr, pni);
        out_.solProfile.push_back(pid);
        if (mode_ == 0) // 分层含雷计数：精确概率的分母里每个 profile 各算各的
            for (int i = 0; i < nvar(); ++i) if (s[i]) out_.profCellMine[(size_t)pid][(size_t)i]++;
    }

    void dfsFull(int pos) {
        if (fullTrunc_) return;
        if (++nodes_ > FULL_NODE * budgetK_) { fullTrunc_ = true; return; }
        const int n = nvar();
        const int ordN = (int)order_.size();
        while (pos < ordN && assigned_[(size_t)order_[(size_t)pos]]) ++pos; // 传播已定值的跳过
        if (pos == ordN) {
            profileAccum(curR_, curI_);
            for (int i = 0; i < n; ++i) { if (val_[i]) out_.anyMine[(size_t)i] = 1; else out_.anySafe[(size_t)i] = 1; }
            if (gDbg) {
                std::vector<uint8_t> s((size_t)n);
                for (int i = 0; i < n; ++i) s[(size_t)i] = (uint8_t)val_[i];
                out_.sols.push_back(std::move(s));
            }
            return;
        }
        const int v = order_[(size_t)pos];
        const int dom = t_.classic ? 2 : 5;
        for (int d = 0; d < dom; ++d) {
            const size_t mark = trail_.size();
            const size_t qmark = unitQ_.size();
            if (pushAssign(v, d)) {
                // 先传播再查上限：传播可能连锁定值，上限必须在定完之后判
                if (propagate() && curR_ <= t_.rlim && curI_ <= t_.ilim)
                    dfsFull(pos + 1);
            }
            undoTo(mark);
            unitQ_.resize(qmark); // 本分支入队的线索全部作废（状态已回退）
            if (fullTrunc_) return;
        }
    }

    void dfsCover(int pos, int pnr, int pni) {
        if (coverDone() || nodes_ > COVER_NODE * budgetK_) return;
        ++nodes_;
        const int n = nvar();
        if (pos == n) {
            std::vector<uint8_t> s((size_t)n);
            for (int i = 0; i < n; ++i) s[(size_t)i] = (uint8_t)val_[i];
            for (int i = 0; i < n; ++i) {
                if (val_[i]) { if (!out_.anyMine[i]) { out_.anyMine[i] = 1; --needCov_; } }
                else if (!out_.anySafe[i]) { out_.anySafe[i] = 1; --needCov_; }
            }
            if ((int)out_.sols.size() < SAMPLE_MAX) profileAdd(pnr, pni, s);
            return;
        }
        const int v = order_[pos];
        const int dom = t_.classic ? 2 : 5;
        int vals[5];
        for (int i = 0; i < dom; ++i) vals[i] = i;
        for (int i = dom - 1; i > 0; --i) std::swap(vals[i], vals[(size_t)(rng_() % (uint32_t)(i + 1))]); // 随机取值序
        std::vector<ConState> snap(t_.varCons[v].size());
        for (int ii = 0; ii < dom; ++ii) {
            const int d = vals[ii];
            if (!applyAssign(v, d, snap.data())) { undoAssign(v, snap.data()); continue; }
            const int cnr = pnr + (d && (t_.classic || CRE[d]) ? 1 : 0);
            const int cni = pni + (d && !t_.classic && !CRE[d] ? 1 : 0);
            if (cnr <= t_.rlim && cni <= t_.ilim) dfsCover(pos + 1, cnr, cni);
            undoAssign(v, snap.data());
            if (coverDone() || nodes_ > COVER_NODE * budgetK_) return;
        }
    }
    bool coverDone() const { return needCov_ <= 0; }

    // 定向存在性：给 target_ 指定含雷/安全，找任意一个解
    void existsSearch(int pos, int pnr, int pni) {
        if (existsLeft_ != 2) return;
        if (++nodes_ > EXISTS_NODE * budgetK_) { timedout_ = true; return; }
        const int n = nvar();
        if (pos == n) { existsLeft_ = 1; return; }
        const int v = order_[pos];
        const int dom = t_.classic ? 2 : 5;
        std::vector<ConState> snap(t_.varCons[v].size());
        for (int d = 0; d < dom; ++d) {
            if (v == target_) {
                const bool isMine = (d != 0);
                if (isMine != (targetMine_ == 1)) continue;
            }
            if (!applyAssign(v, d, snap.data())) { undoAssign(v, snap.data()); continue; }
            const int cnr = pnr + (d && (t_.classic || CRE[d]) ? 1 : 0);
            const int cni = pni + (d && !t_.classic && !CRE[d] ? 1 : 0);
            if (cnr <= t_.rlim && cni <= t_.ilim) existsSearch(pos + 1, cnr, cni);
            undoAssign(v, snap.data());
            if (existsLeft_ != 2 || timedout_) return;
        }
    }

    bool timedout_ = false;
};

// ★ P0-B 子集相减：A 的变量集 ⊆ B 时，在 B∖A 上推出一条新约束。
//   和精确相减（sum_C = sum_B − sum_A）、计数区间取差（n_C = n_B − n_A）、奇偶异或、
//   下界按 A 的最大计数平移。**推导出的约束是 A、B 的逻辑推论**——任何同时满足 A、B 的解
//   必满足它，所以只可能收紧搜索，绝不会错杀合法解（诚实契约不变）。
//   MIX 是圆约束，不能对和做线性相减，跳过（它的分解点已经在 ok() 里精确参与判定）。
inline void deriveSubsetCons(std::vector<Con>& cons, std::vector<std::vector<int>>& varCons) {
    const int n0 = (int)cons.size();
    if (n0 < 2) return;
    const int cap = std::max(64, n0 * 6); // 派生约束上限，防爆
    bool changed = true;
    for (int round = 0; round < 4 && changed; ++round) {
        changed = false;
        const int nNow = (int)cons.size();
        for (int bi = 0; bi < nNow && (int)cons.size() < cap; ++bi) {
            for (int ai = 0; ai < nNow && (int)cons.size() < cap; ++ai) {
                if (ai == bi) continue;
                const Con& A = cons[(size_t)ai];
                const Con& B = cons[(size_t)bi];
                if (A.lv.empty() || A.lv.size() >= B.lv.size()) continue;
                const bool sumPair = (A.kind == K_SUM && B.kind == K_SUM);
                const bool cntPair = (A.kind == K_CNT && B.kind == K_CNT);
                if (!sumPair && !cntPair) continue;
                bool sub = true; // A ⊆ B ?
                for (int av : A.lv)
                    if (std::find(B.lv.begin(), B.lv.end(), av) == B.lv.end()) { sub = false; break; }
                if (!sub) continue;
                Con C;
                C.kind = B.kind;
                C.re = B.re - A.re;
                C.im = B.im - A.im;
                if (cntPair) {
                    C.cnt = B.cnt - A.cnt; // K_CNT 的计数是精确值，相减也精确
                    if (C.cnt < 0 || C.cnt > (int)B.lv.size() - (int)A.lv.size()) continue;
                } else {
                    const int loA = std::max(0, A.minCnt), hiA = (int)A.lv.size();
                    const int loB = std::max(0, B.minCnt), hiB = (int)B.lv.size();
                    C.minCnt = std::max(0, loB - hiA);
                    if (hiB - loA < C.minCnt) continue;
                    C.par = (A.par >= 0 && B.par >= 0) ? (A.par ^ B.par) : -1;
                    C.minMines = std::max(0, B.minMines - hiA);
                }
                for (int bv : B.lv)
                    if (std::find(A.lv.begin(), A.lv.end(), bv) == A.lv.end()) C.lv.push_back(bv);
                if (C.lv.empty()) continue;
                if (sumPair && std::abs(C.re) + std::abs(C.im) > (int)C.lv.size()) continue; // 明显不可能，不加
                bool dup = false;
                for (const Con& e : cons) {
                    if (e.kind != C.kind || e.lv != C.lv) continue;
                    if (e.re == C.re && e.im == C.im && e.cnt == C.cnt && e.minCnt == C.minCnt && e.par == C.par) { dup = true; break; }
                }
                if (dup) continue;
                if ((int)varCons.size() < (int)cons.size()) break;
                const int cidx = (int)cons.size();
                for (int l : C.lv) varCons[(size_t)l].push_back(cidx);
                cons.push_back(std::move(C));
                changed = true;
            }
        }
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// ★ P1：低树宽 DP（bucket elimination / 变量消元）
//
// 为什么需要它：33–64 变量的分量枚举不完（实测平均 460 万节点、最大打满 3000 万仍未穷尽，
// 而每分量预算只有 400 万）。DP 的复杂度是 O(分量数 × D^w)，w = **诱导宽度**——
// 实测 Medium 的分量 w 中位 4~5、p90 6、最大 6 → D^6 = 15625，比 5^40 差了几十个数量级。
//
// 得到什么：每个变量的**精确**边际（各取值的相容解条数）→ 直接给出
//   「是否存在安全解 / 含雷解」（见证）与「出现过的雷型」。
// 得不到什么：按 (re,im) 分层的 profile 计数。那需要把 profile 当多项式系数带进消元，
//   卷积代价 ×(profile 数)²，实测不可接受。所以 DP 解出的分量**不参与跨分量的
//   二维卷积**（并入吸收池），概率用分量内边际（标 approx）。
//
// ★ 与 DFS 的唯一语义差异：DFS 会用 `curR_ <= rlim && curI_ <= ilim`
//   （全盘剩余实/虚雷数）当剪枝，DP 不做这个剪枝。
//   少剪枝 = **解的集合是超集** ⇒ 见证只会更保守（少下结论），不会错下结论。
//   这条是安全的，也是 oracle 对拍时 DP 路径要与「不加 cut 的暴力枚举」比的原因。
// ══════════════════════════════════════════════════════════════════════════════

struct DpResult {
    bool ok = false;
    long double Z = 0;                    // 相容解总数
    std::vector<long double> mineCnt;     // 每变量的含雷解数
    std::vector<long double> zeroCnt;     // 每变量的安全解数
    std::vector<uint8_t> typeMask;        // 每变量出现过的雷型位掩码
    int width = 0;
    // —— P2：整个分量的 (实雷数, 虚雷数) 可达集合（精确，bool 半环算出来的）——
    bool hasSupport = false;
    std::vector<std::pair<int,int>> support;
    int supportMax = 0;                   // 中间消息单 code 的最大点集大小（诊断用）
};

class BucketDP {
public:
    explicit BucketDP(const CompTask& t) : t_(t), D_(t.classic ? 2 : 5) {}

    // 返回 false = 放弃，调用方保持原降级路径。
    // failKind 非空时带回失败原因，供 C1 阶梯重试决策：
    //   1 = 诱导宽度超限（O(n²) 便宜失败，值得放宽宽度重试）
    //   2 = 前向/后向工作量表超限（msgs_ 总内存 = work_×16B，重试必须同时给内存守卫）
    //   3 = fillScope 不变量破坏（scope 里出现已消元变量）
    //   4 = 消息目标不在消元序后方（target <= i）
    //   5 = 根桶没归约成标量（rootOk_ 为假）
    //   6 = 空根（无线索无子消息的结构）
    //   7 = 无变量线索当场不相容（分量真无解）
    //   0 = 成功
    bool run(DpResult& res, int maxWidth, long long workCap, int* failKind = nullptr) {
        const bool ok = runImpl(res, maxWidth, workCap);
        // ★ C1 修复：失败原因必须显式回传——之前指针从未被写入，调用方永远看到 0，
        //   「原因分布」全记进 dpFailKind[0]、阶梯重试从未真正触发（诊断被静默吞掉）。
        if (failKind) *failKind = ok ? 0 : lastFail_;
        return ok;
    }

    // ── 第四代 A1：分层 BucketDP ──────────────────────────────────────────
    // 消息从标量 long double 升级为「按 (nr,ni) profile 分层」的权重表：每 code
    // 一个 map<profile→long double>。子消息相乘变成沿 profile 轴的二维卷积；
    // 消元变量把 (Δ实雷数,Δ虚雷数)（**个数口径**，与 computeSupport 的 dr/di 一致）
    // 折进 profile。前向消息的 profile **含**本桶消元变量；后向 M 表**不含**
    // （边际/类型/回传时再折 —— 这样 profCellTypes 才能拿到真实 per-profile 雷型，
    //  ±1 与 -1 同为 (1,0) 型增量，折早了就区分不出来）。
    // 产出与枚举 FULL 的 CompOut 同构（profiles/profSolCnt/profCellMine/
    // profCellTypes），可直接进 globalFilter 与 exactProbs —— 这是 A2 接入的地基。
    // 前提：先成功跑完一次标量 run()（复用 ord_/pos_/scope_；bucketKids_ 由本方法
    // 重建，桶树与标量前向逐桶一致）。任一 map 超 kLayerMapCap / 单消息表超
    // kLayerStrideCap / 工作量超限 → 放弃（failKind 统一 8），调用方保持标量 DPSOLVED。
    // 只增不减：分层失败不影响任何既有路径。
    struct LayeredResult {
        bool ok = false;
        std::vector<std::pair<int,int>> profiles;
        std::vector<long double> profSolCnt;
        std::vector<std::vector<long double>> profCellMine;  // [profile][变量] 含雷解数
        std::vector<std::vector<uint8_t>> profCellTypes;     // [profile][变量] 雷型位掩码
    };
    static constexpr int kLayerMapCap = 4096;      // 单 map 的 profile 点数上限（=S 上限，超了放弃）
    // stride 守卫 400k：解锁宽 9（5^8=390625）。宽 10 的 stride=5^9≈2M 仍被挡
    // （一张表就要 ~94MB）。宽 9 档由下方 memEntries 总量守卫兜底。
    static constexpr int kLayerStrideCap = 400000;
    static constexpr long long kLayerWorkCap = 40000000;  // 分层卷积乘加上限（宽 9 单桶遍历 5^9≈2M，需同步放宽）
    static constexpr long long kLayerMemCap = 600000000;  // 单次分层尝试的消息表内存守卫（字节，≈stride×48B 累计）
                                                             // 用户验收线 1GB，留 km[]/lb/卷积临时量余量收到 600MB

    bool runLayered(LayeredResult& lr, int* failKind = nullptr) {
        const auto fail = [&](int k) { if (failKind) *failKind = k; return false; };
        const int n = (int)t_.gvars.size();
        if (n == 0 || (int)ord_.size() != n || scope_[(size_t)(n - 1)].empty()) return fail(8);
        lr = LayeredResult{};
        using Map = std::map<std::pair<int,int>, long double>;
        struct LMsg { std::vector<int> scope; std::vector<Map> v; };
        // 二维卷积：dst = a ⊗ b（profile 轴），工作量按乘加次数计、结果点数有上限
        long long work = 0;
        long long memEntries = 0; // 消息表 stride 项数累计（×48B≈std::map 空表开销，总量守卫用）
        auto convInto = [&](Map& dst, const Map& a, const Map& b) -> bool {
            const long long cost = (long long)a.size() * (long long)b.size();
            if (work > kLayerWorkCap - cost) return false;
            work += cost;
            Map out;
            for (const auto& ka : a)
                for (const auto& kb : b) {
                    const std::pair<int,int> key{ka.first.first + kb.first.first, ka.first.second + kb.first.second};
                    if (out.size() >= (size_t)kLayerMapCap && !out.count(key)) return false;
                    out[key] += ka.second * kb.second;
                }
            dst = std::move(out);
            return true;
        };
        const int gvn = n;
        std::vector<int> varAt((size_t)gvn, -1);
        // —— 前向：分层消息（与 forwardStep 同构，值从标量换成 map）——
        std::vector<LMsg> lm((size_t)n);
        bucketKids_.assign((size_t)n, {});
        for (int i = 0; i < n; ++i) {
            const auto& sc = scope_[(size_t)i];
            const int k = (int)sc.size();
            const long long total = powD(k);
            const long long stride = (k > 1) ? (total / D_) : 1;
            if (stride > kLayerStrideCap) return fail(8);
            memEntries += stride;
            if (memEntries > kLayerMemCap / 48) return fail(8); // 全盘消息表内存守卫（验收线 1GB 内）
            if (work > kLayerWorkCap - total) return fail(8);
            work += total;
            for (int p = 0; p < k; ++p) varAt[(size_t)sc[(size_t)p]] = p;
            const auto& kids = bucketKids_[(size_t)i];
            std::vector<std::vector<int>> kidMap(kids.size());
            for (size_t j = 0; j < kids.size(); ++j) {
                kidMap[j].resize(lm[(size_t)kids[j]].scope.size());
                for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2)
                    kidMap[j][t2] = varAt[(size_t)lm[(size_t)kids[j]].scope[t2]];
            }
            LMsg msg;
            msg.scope.assign(sc.begin() + 1, sc.end());
            msg.v.assign((size_t)stride, {});
            std::vector<int> av((size_t)k, 0);
            for (long long code = 0; code < total; ++code) {
                long long x = code;
                for (int p = 0; p < k; ++p) { av[(size_t)p] = (int)(x % D_); x /= D_; }
                bool good = true;
                for (int ci : bucketCons_[(size_t)i])
                    if (!evalCons(t_.cons[(size_t)ci], av, varAt)) { good = false; break; }
                if (!good) continue;
                Map cur; cur.emplace(std::make_pair(0, 0), 1.0L);
                bool dead = false;
                for (size_t j = 0; j < kids.size() && !dead; ++j) {
                    long long idx = 0, mul = 1;
                    for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2) {
                        idx += (long long)av[(size_t)kidMap[j][t2]] * mul;
                        mul *= D_;
                    }
                    const Map& e = lm[(size_t)kids[j]].v[(size_t)idx];
                    if (e.empty()) { dead = true; break; }
                    Map nxt;
                    if (!convInto(nxt, cur, e)) return fail(8);
                    cur = std::move(nxt);
                }
                if (dead || cur.empty()) continue;
                const int d0 = av[0];
                const int dr = (d0 && (t_.classic || CRE[d0])) ? 1 : 0;
                const int di = (d0 && !t_.classic && !CRE[d0]) ? 1 : 0;
                auto& dst = msg.v[(size_t)(code / D_)];
                for (const auto& kv : cur) {
                    const std::pair<int,int> key{kv.first.first + dr, kv.first.second + di};
                    if (dst.size() >= (size_t)kLayerMapCap && !dst.count(key)) return fail(8);
                    dst[key] += kv.second;
                }
            }
            if (msg.scope.empty()) {
                if (bucketCons_[(size_t)i].empty() && bucketKids_[(size_t)i].empty()) return fail(6);
            } else {
                int target = INT_MAX;
                for (int v : msg.scope) target = std::min(target, pos_[(size_t)v]);
                if (target <= i || target >= n) return fail(4);
                bucketKids_[(size_t)target].push_back(i);
            }
            lm[(size_t)i] = std::move(msg);
        }
        // —— 后向：M = back ⊗ kids（不折本桶 delta），边际/类型/回传时折 ——
        std::vector<LMsg> lb((size_t)n);
        lb[(size_t)(n - 1)].v.assign(1, {});
        lb[(size_t)(n - 1)].v[0].emplace(std::make_pair(0, 0), 1.0L);
        std::vector<Map> pMine((size_t)n);                        // [变量][profile] 含雷权重
        std::vector<std::map<std::pair<int,int>, uint8_t>> pType((size_t)n);
        Map rootCnt;                                              // 根：全部解（含安全消元解）按 profile 计数
        for (int i = n - 1; i >= 0; --i) {
            const auto& sc = scope_[(size_t)i];
            const int k = (int)sc.size();
            const long long total = powD(k);
            if (work > kLayerWorkCap - total) return fail(8);
            work += total;
            for (int p = 0; p < k; ++p) varAt[(size_t)sc[(size_t)p]] = p;
            const auto& kids = bucketKids_[(size_t)i];
            const size_t m = kids.size();
            std::vector<std::vector<int>> kidMap(m);
            for (size_t j = 0; j < m; ++j) {
                kidMap[j].resize(lm[(size_t)kids[j]].scope.size());
                for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2)
                    kidMap[j][t2] = varAt[(size_t)lm[(size_t)kids[j]].scope[t2]];
            }
            const LMsg& bk = lb[(size_t)i];
            std::vector<int> bkMap(bk.scope.size());
            for (size_t t2 = 0; t2 < bkMap.size(); ++t2) bkMap[t2] = varAt[(size_t)bk.scope[t2]];
            std::vector<LMsg> km(m);
            for (size_t j = 0; j < m; ++j) {
                km[j].v.assign(lm[(size_t)kids[j]].v.size(), {});
                memEntries += (long long)lm[(size_t)kids[j]].v.size();
            }
            if (memEntries > kLayerMemCap / 48) return fail(8);
            const int v0 = ord_[(size_t)i];
            std::vector<int> av((size_t)k, 0);
            for (long long code = 0; code < total; ++code) {
                long long x = code;
                for (int p = 0; p < k; ++p) { av[(size_t)p] = (int)(x % D_); x /= D_; }
                bool good = true;
                for (int ci : bucketCons_[(size_t)i])
                    if (!evalCons(t_.cons[(size_t)ci], av, varAt)) { good = false; break; }
                if (!good) continue;
                std::vector<const Map*> entry(m);
                bool dead = false;
                for (size_t j = 0; j < m && !dead; ++j) {
                    long long idx = 0, mul = 1;
                    for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2) {
                        idx += (long long)av[(size_t)kidMap[j][t2]] * mul;
                        mul *= D_;
                    }
                    entry[j] = &lm[(size_t)kids[j]].v[(size_t)idx];
                    if (entry[j]->empty()) dead = true;
                }
                if (dead) continue;
                Map cur;
                if (!bk.scope.empty()) {
                    long long idx = 0, mul = 1;
                    for (size_t t2 = 0; t2 < bkMap.size(); ++t2) {
                        idx += (long long)av[(size_t)bkMap[t2]] * mul;
                        mul *= D_;
                    }
                    cur = bk.v[(size_t)idx];
                    if (cur.empty()) continue;
                } else cur.emplace(std::make_pair(0, 0), 1.0L);
                // pre[j] = 前 j 个子消息的卷积、suf[j] = 第 j..m-1 个的卷积
                std::vector<Map> pre(m + 1), suf(m + 1);
                pre[0].emplace(std::make_pair(0, 0), 1.0L);
                for (size_t j = 0; j < m; ++j)
                    if (!convInto(pre[(size_t)j + 1], pre[j], *entry[j])) return fail(8);
                suf[m].emplace(std::make_pair(0, 0), 1.0L);
                for (size_t j = m; j-- > 0;)
                    if (!convInto(suf[j], *entry[j], suf[(size_t)j + 1])) return fail(8);
                Map full;
                if (!convInto(full, cur, pre[m])) return fail(8);
                if (full.empty()) continue;
                const int d0 = av[0];
                const int dr = (d0 && (t_.classic || CRE[d0])) ? 1 : 0;
                const int di = (d0 && !t_.classic && !CRE[d0]) ? 1 : 0;
                // 边际 + per-profile 雷型（安全解不进 profCellMine，但要进根计数）
                if (d0) {
                    for (const auto& kv : full) {
                        const std::pair<int,int> fp{kv.first.first + dr, kv.first.second + di};
                        pMine[(size_t)v0][fp] += kv.second;
                        pType[(size_t)v0][fp] = (uint8_t)(pType[(size_t)v0][fp] | (1u << d0));
                    }
                }
                if (i == n - 1)
                    for (const auto& kv : full)
                        rootCnt[{kv.first.first + dr, kv.first.second + di}] += kv.second;
                // 回传：排除第 j 个子消息 = back ⊗ pre[j] ⊗ suf[j+1]（卷积不可逆，不做除法）
                for (size_t j = 0; j < m; ++j) {
                    long long idx = 0, mul = 1;
                    for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2) {
                        idx += (long long)av[(size_t)kidMap[j][t2]] * mul;
                        mul *= D_;
                    }
                    Map tmp, exj;
                    if (!convInto(tmp, cur, pre[j])) return fail(8);
                    if (!convInto(exj, tmp, suf[(size_t)j + 1])) return fail(8);
                    if (exj.empty()) continue;
                    auto& dst = km[j].v[(size_t)idx];
                    for (const auto& kv : exj) {
                        const std::pair<int,int> key{kv.first.first + dr, kv.first.second + di};
                        if (dst.size() >= (size_t)kLayerMapCap && !dst.count(key)) return fail(8);
                        dst[key] += kv.second;
                    }
                }
            }
            for (size_t j = 0; j < m; ++j) {
                const int cj = kids[j];
                lb[(size_t)cj].scope = lm[(size_t)cj].scope;
                lb[(size_t)cj].v = std::move(km[j].v);
            }
        }
        // —— 组装：rootCnt 的键 = 全分量 profile 集 ——
        if (rootCnt.empty() || (int)rootCnt.size() > kLayerMapCap) return fail(8);
        std::map<std::pair<int,int>, int> pidOf;
        for (const auto& kv : rootCnt) {
            pidOf.emplace(kv.first, (int)lr.profiles.size());
            lr.profiles.push_back(kv.first);
            lr.profSolCnt.push_back(kv.second);
        }
        lr.profCellMine.assign(lr.profiles.size(), std::vector<long double>((size_t)n, 0.0L));
        lr.profCellTypes.assign(lr.profiles.size(), std::vector<uint8_t>((size_t)n, 0));
        for (int v = 0; v < n; ++v) {
            for (const auto& kv : pMine[(size_t)v]) {
                const auto it = pidOf.find(kv.first);
                if (it == pidOf.end()) return fail(8); // 理论不可达：后向 profile 必可延拓到根
                lr.profCellMine[(size_t)it->second][(size_t)v] = kv.second;
            }
            for (const auto& kv : pType[(size_t)v]) {
                const auto it = pidOf.find(kv.first);
                if (it == pidOf.end()) return fail(8);
                lr.profCellTypes[(size_t)it->second][(size_t)v] = kv.second;
            }
        }
        lr.ok = true;
        return true;
    }

    // 标量 run 之后可查：本次消元序的最大 scope 宽度（分层门槛：>8 直接送放弃，省得白跑）
    int maxScopeWidth() const {
        int w = 0;
        for (const auto& s : scope_) w = std::max(w, (int)s.size());
        return w;
    }

private:
    bool runImpl(DpResult& res, int maxWidth, long long workCap) {
        lastFail_ = 3;
        const int n = (int)t_.gvars.size();
        res.mineCnt.assign((size_t)n, 0.0L);
        res.zeroCnt.assign((size_t)n, 0.0L);
        res.typeMask.assign((size_t)n, 0);
        if (n == 0) { res.ok = true; res.Z = 1.0L; return true; }
        if (!buildOrder(maxWidth)) return false; // 消元序 + 宽度检查
        if (!buildBuckets()) return false;

        work_ = 0;
        workCap_ = workCap;
        supportCap_ = workCap;

        // —— 前向：消元，得到每步的消息 ψ 与父桶 ——
        msgs_.assign((size_t)n, Msg{});
        for (int i = 0; i < n; ++i) {
            if (!forwardStep(i)) return false;
        }
        const int root = n - 1;
        if (!rootOk_) { lastFail_ = 5; return false; }

        // —— 后向：把「其余部分」传回去，算每变量的边际 ——
        back_.assign((size_t)n, Msg{});
        back_[(size_t)root].scope.clear();
        back_[(size_t)root].v.assign(1, 1.0L); // 标量 1
        for (int i = n - 1; i >= 0; --i) {
            if (!backwardStep(i, res)) return false;
        }
        res.ok = true;
        // —— 支撑集（可选，失败不影响 DP 主体结论）——
        // 算出整个分量的 (实雷数, 虚雷数) 可达集合。
        // ⚠ 实测（Hard 100 局，seed=20261008）**收益为 0**，所以默认关闭，实现保留备查：
        //   absorb 平均 193，其中 interior（不接触任何线索的内部格）贡献 191.4，
        //   DP 分量只占 1.6；而 Rtot+Itot 平均只有 48.8。
        //   于是 valid 的判据 `x + y - best <= absorb` 在 97.5% 的场面恒真 ——
        //   全局雷数约束本来就够松，把 DP 分量从吸收池挪出去、或当因子加进 pref/suff
        //   都改变不了这一点。吸收池的大头是内部格，而内部格没有线索可依。
        //   → 这条路要成立，前提是 interior 相对 Rtot+Itot 足够小（残局或许满足）。
        res.hasSupport = kEnableDpSupport && computeSupport(res, supportCap_);
        return true;
    }

public:
    int lastFail() const { return lastFail_; }

    // 支撑集开关：实测零收益（理由见上），默认关闭
    static constexpr bool kEnableDpSupport = false;

private:
    struct Msg {
        std::vector<int> scope; // 变量号，按消元位次升序
        std::vector<long double> v;
    };

    const CompTask& t_;
    int D_;
    std::vector<int> ord_, pos_;                    // 消元序 / 位次
    std::vector<std::vector<int>> bucketCons_;      // 桶 i 里的原始线索
    std::vector<std::vector<int>> bucketKids_;      // 桶 i 收到的子消息（来自更早消元的桶）
    std::vector<std::vector<int>> scope_;           // 桶 i 的变量集（按位次升序，[0] 就是 ord_[i]）
    std::vector<Msg> msgs_, back_;
    bool rootOk_ = false;
    long long work_ = 0, workCap_ = 0;
    int lastFail_ = 3; // 最近一次 run 失败的原因（1 宽度 / 2 工作量 / 3 其他），见 run() 注释

    // 线索在给定赋值下是否相容（与 DFS 叶子处的判定口径完全一致）
    bool evalCons(const Con& c, const std::vector<int>& av, const std::vector<int>& varAt) const {
        int sr = 0, si = 0, cnt = 0;
        for (int l : c.lv) {
            const int d = av[(size_t)varAt[(size_t)l]];
            if (!d) continue;
            ++cnt;
            if (!t_.classic) { sr += CRE[d]; si += CIM[d]; }
        }
        if (c.kind == K_SUM) {
            if (!t_.classic && (sr != c.re || si != c.im)) return false;
            if (cnt < c.minMines) return false;
        } else if (c.kind == K_MIX) {
            const int fr = sr + c.offRe, fi = si + c.offIm;
            if (sq(fr) + sq(fi) != c.mixS) return false;
            if (fr == 0 || fi == 0) return false;
        } else {
            if (cnt != c.cnt) return false;
        }
        if (c.minCnt >= 0 && cnt < c.minCnt) return false;
        if (c.par >= 0 && (cnt & 1) != c.par) return false;
        return true;
    }

    // ★ C2：三种消元贪心各算一条完整消元序，取「最大团」（= 诱导宽度的同口径上界）最小者。
    //   n≤~100，三遍 O(n²·deg²) 代价可忽略；比原「min-fill 一条道走到黑」多两个自由度。
    //   mode 0 = min-fill，平局取小度（= 原实现）；mode 1 = min-degree，平局取小 fill；
    //   mode 2 = fill+deg 组合分。返回最大团大小，无候选返回 -1。
    int greedyOrder(int mode, std::vector<int>& outOrd) const {
        const int n = (int)t_.gvars.size();
        std::vector<std::vector<char>> adj((size_t)n, std::vector<char>((size_t)n, 0));
        for (const auto& c : t_.cons) {
            for (size_t i = 0; i < c.lv.size(); ++i)
                for (size_t j = i + 1; j < c.lv.size(); ++j) {
                    const int a = c.lv[i], b = c.lv[j];
                    adj[(size_t)a][(size_t)b] = adj[(size_t)b][(size_t)a] = 1;
                }
        }
        std::vector<char> alive((size_t)n, 1);
        outOrd.clear();
        outOrd.reserve((size_t)n);
        int maxClique = 0;
        for (int step = 0; step < n; ++step) {
            int best = -1, bestKey1 = 1 << 30, bestKey2 = 1 << 30;
            for (int v = 0; v < n; ++v) {
                if (!alive[(size_t)v]) continue;
                std::vector<int> nb;
                for (int a = 0; a < n; ++a) if (alive[(size_t)a] && adj[(size_t)v][(size_t)a]) nb.push_back(a);
                int fill = 0;
                for (size_t i = 0; i < nb.size(); ++i)
                    for (size_t j = i + 1; j < nb.size(); ++j)
                        if (!adj[(size_t)nb[i]][(size_t)nb[j]]) ++fill;
                const int deg = (int)nb.size();
                int k1, k2;
                if (mode == 1) { k1 = deg; k2 = fill; }
                else if (mode == 2) { k1 = fill + deg; k2 = deg; }
                else { k1 = fill; k2 = deg; }
                if (k1 < bestKey1 || (k1 == bestKey1 && k2 < bestKey2)) {
                    bestKey1 = k1; bestKey2 = k2; best = v;
                }
            }
            if (best < 0) return -1;
            // 该步的团大小 = 消元时仍存活的邻居数
            int degBest = 0;
            for (int a = 0; a < n; ++a) if (alive[(size_t)a] && adj[(size_t)best][(size_t)a]) ++degBest;
            maxClique = std::max(maxClique, degBest);
            alive[(size_t)best] = 0;
            outOrd.push_back(best);
            std::vector<int> nb;
            for (int a = 0; a < n; ++a) if (alive[(size_t)a] && adj[(size_t)best][(size_t)a]) nb.push_back(a);
            for (size_t i = 0; i < nb.size(); ++i)
                for (size_t j = i + 1; j < nb.size(); ++j)
                    adj[(size_t)nb[i]][(size_t)nb[j]] = adj[(size_t)nb[j]][(size_t)nb[i]] = 1;
        }
        return maxClique;
    }

    // 消元序：三贪心择优（C2），宽度检查与原实现同口径（团大小 > maxWidth 即放弃）
    bool buildOrder(int maxWidth) {
        int bestW = 1 << 30;
        std::vector<int> bestOrd;
        for (int m = 0; m < 3; ++m) {
            std::vector<int> o;
            const int w = greedyOrder(m, o);
            if (w < 0) { lastFail_ = 3; return false; }
            if (w < bestW) { bestW = w; bestOrd = std::move(o); }
        }
        if (bestW > maxWidth) { lastFail_ = 1; return false; }
        ord_ = std::move(bestOrd);
        pos_.assign(ord_.size(), 0);
        for (int i = 0; i < (int)ord_.size(); ++i) pos_[(size_t)ord_[(size_t)i]] = i;
        return true;
    }

    bool buildBuckets() {
        const int n = (int)t_.gvars.size();
        bucketCons_.assign((size_t)n, {});
        bucketKids_.assign((size_t)n, {});
        scope_.assign((size_t)n, {});
        for (size_t ci = 0; ci < t_.cons.size(); ++ci) {
            const auto& c = t_.cons[ci];
            if (c.lv.empty()) {
                // 无变量的线索：必须当场成立，否则整分量无解
                std::vector<int> dummy, varAt;
                if (!evalCons(c, dummy, varAt)) { lastFail_ = 7; return false; }
                continue;
            }
            // 因子归到「最早被消元的那个变量」的桶（桶消元的标准做法）：
            // 轮到它时这条线索才第一次参与乘积。写成 max 会让线索从未被检查。
            int first = INT_MAX;
            for (int l : c.lv) first = std::min(first, pos_[(size_t)l]);
            if (first >= n) { lastFail_ = 7; return false; }
            bucketCons_[(size_t)first].push_back((int)ci);
        }
        return true;
    }

    // 算出桶 i 的 scope：{ord_[i]} ∪ 桶内线索变量 ∪ 子消息变量
    bool fillScope(int i, const std::vector<int>& kids) {
        std::vector<char> in((size_t)t_.gvars.size(), 0);
        std::vector<int> s{ord_[(size_t)i]};
        in[(size_t)ord_[(size_t)i]] = 1;
        auto addVar = [&](int v, std::vector<int>& dst) {
            if (!in[(size_t)v]) { in[(size_t)v] = 1; dst.push_back(v); }
        };
        for (int ci : bucketCons_[(size_t)i])
            for (int l : t_.cons[(size_t)ci].lv) addVar(l, s);
        for (int k : kids)
            for (int v : msgs_[(size_t)k].scope) addVar(v, s);
        for (int v : s) if (pos_[(size_t)v] < i) {
            // 诊断：这个不变量破坏在实测里是 DP 放弃的头号原因（Hard 100 局 20 次），
            // 打印现场（桶号 / 违规变量 / 它的位次 / 桶内线索数 / 子消息数）供定位。
            if (gDbg)
                fprintf(stderr, "[dp-fillScope] bucket=%d violVar=%d pos=%d ncons=%zu nkids=%zu nv=%d\n",
                        i, v, pos_[(size_t)v], bucketCons_[(size_t)i].size(), kids.size(), (int)t_.gvars.size());
            lastFail_ = 3; return false;
        }
        std::sort(s.begin(), s.end(), [&](int a, int b) { return pos_[(size_t)a] < pos_[(size_t)b]; });
        scope_[(size_t)i] = std::move(s);
        return true;
    }

    long long powD(int k) const { long long r = 1; for (int i = 0; i < k; ++i) r *= D_; return r; }

    bool forwardStep(int i) {
        std::vector<int> kids = bucketKids_[(size_t)i];
        if (!fillScope(i, kids)) return false;
        const auto& sc = scope_[(size_t)i];
        const int k = (int)sc.size();
        const long long total = powD(k);
        if (work_ + total > workCap_) { lastFail_ = 2; return false; }
        work_ += total;
        // varAt：变量号 → 在 scope 中的位次
        std::vector<int> varAt((size_t)t_.gvars.size(), -1);
        for (int p = 0; p < k; ++p) varAt[(size_t)sc[(size_t)p]] = p;
        // 子消息的取值位次映射
        std::vector<std::vector<int>> kidMap(kids.size());
        for (size_t j = 0; j < kids.size(); ++j) {
            kidMap[j].resize(msgs_[(size_t)kids[j]].scope.size());
            for (size_t t = 0; t < kidMap[j].size(); ++t)
                kidMap[j][t] = varAt[(size_t)msgs_[(size_t)kids[j]].scope[t]];
        }
        std::vector<int> av((size_t)k, 0);
        std::vector<long double> tbl((size_t)total, 0.0L);
        for (long long code = 0; code < total; ++code) {
            long long x = code;
            for (int p = 0; p < k; ++p) { av[(size_t)p] = (int)(x % D_); x /= D_; }
            bool good = true;
            for (int ci : bucketCons_[(size_t)i])
                if (!evalCons(t_.cons[(size_t)ci], av, varAt)) { good = false; break; }
            if (!good) continue;
            long double w = 1.0L;
            for (size_t j = 0; j < kids.size(); ++j) {
                const auto& m = msgs_[(size_t)kids[j]];
                long long idx = 0, mul = 1;
                for (size_t t = 0; t < kidMap[j].size(); ++t) {
                    idx += (long long)av[(size_t)kidMap[j][t]] * mul;
                    mul *= D_;
                }
                w *= m.v[(size_t)idx];
                if (w == 0.0L) break;
            }
            tbl[(size_t)code] = w;
        }
        // 对 scope[0]（= ord_[i]）求和 → 消息
        Msg msg;
        msg.scope.assign(sc.begin() + 1, sc.end());
        const long long stride = (k > 1) ? (total / D_) : 1;
        msg.v.assign((size_t)stride, 0.0L);
        for (long long code = 0; code < total; ++code) msg.v[(size_t)(code / D_)] += tbl[(size_t)code];
        if (msg.scope.empty()) { // 根：Z 由后向 pass 从这里累加出来
            if (bucketCons_[(size_t)i].empty() && bucketKids_[(size_t)i].empty()) { lastFail_ = 6; return false; } // 空根 = 结构不对，放弃
            rootOk_ = true;
            msgs_[(size_t)i] = std::move(msg);
            return true;
        }
        // 交给「消息 scope 里位次最靠后」的那个桶
        int target = INT_MAX;
        for (int v : msg.scope) target = std::min(target, pos_[(size_t)v]);
        if (target <= i || target >= (int)t_.gvars.size()) { lastFail_ = 4; return false; }
        msgs_[(size_t)i] = std::move(msg);
        bucketKids_[(size_t)target].push_back(i);
        return true;
    }

    // 后向：用「桶内线索 × 其它子消息 × 父传来的 back_」算出本桶的联合表，
    // 从中取 ord_[i] 的边际，并把消息传给每个子桶。
    bool backwardStep(int i, DpResult& res) {
        const auto& sc = scope_[(size_t)i];
        const int k = (int)sc.size();
        const long long total = powD(k);
        if (work_ + total * (1 + (long long)bucketKids_[(size_t)i].size()) > workCap_) { lastFail_ = 2; return false; }
        work_ += total * (1 + (long long)bucketKids_[(size_t)i].size());
        std::vector<int> varAt((size_t)t_.gvars.size(), -1);
        for (int p = 0; p < k; ++p) varAt[(size_t)sc[(size_t)p]] = p;

        // 每张子消息的取值位次映射（复用）
        const auto& kids = bucketKids_[(size_t)i];
        std::vector<std::vector<int>> kidMap(kids.size());
        for (size_t j = 0; j < kids.size(); ++j) {
            kidMap[j].resize(msgs_[(size_t)kids[j]].scope.size());
            for (size_t t = 0; t < kidMap[j].size(); ++t)
                kidMap[j][t] = varAt[(size_t)msgs_[(size_t)kids[j]].scope[t]];
        }
        // back_ 的映射
        const Msg& bk = back_[(size_t)i];
        std::vector<int> bkMap(bk.scope.size());
        for (size_t t = 0; t < bkMap.size(); ++t) bkMap[t] = varAt[(size_t)bk.scope[t]];

        std::vector<int> av((size_t)k, 0);
        std::vector<long double> marg((size_t)D_, 0.0L);
        // 每个子桶要单独累加「排除它自己」的和
        std::vector<std::vector<long double>> kidMsg(kids.size());
        for (size_t j = 0; j < kids.size(); ++j) kidMsg[j].assign(msgs_[(size_t)kids[j]].v.size(), 0.0L);
        for (long long code = 0; code < total; ++code) {
            long long x = code;
            for (int p = 0; p < k; ++p) { av[(size_t)p] = (int)(x % D_); x /= D_; }
            bool good = true;
            for (int ci : bucketCons_[(size_t)i])
                if (!evalCons(t_.cons[(size_t)ci], av, varAt)) { good = false; break; }
            if (!good) continue;
            long double wAll = 1.0L;
            if (!bk.v.empty()) {
                long long idx = 0, mul = 1;
                for (size_t t = 0; t < bkMap.size(); ++t) { idx += (long long)av[(size_t)bkMap[t]] * mul; mul *= D_; }
                wAll *= bk.v[(size_t)idx];
            }
            long double prodRest = wAll;
            std::vector<long double> kidVal(kids.size(), 1.0L);
            for (size_t j = 0; j < kids.size(); ++j) {
                long long idx = 0, mul = 1;
                for (size_t t = 0; t < kidMap[j].size(); ++t) { idx += (long long)av[(size_t)kidMap[j][t]] * mul; mul *= D_; }
                kidVal[j] = msgs_[(size_t)kids[j]].v[(size_t)idx];
                prodRest *= kidVal[j];
            }
            if (prodRest == 0.0L) continue;
            marg[(size_t)av[0]] += prodRest;
            if (!kids.empty()) {
                // 「排除第 j 个」用前后缀乘积算，**不做除法**（除法会丢精度，且 0/0 要特判）
                std::vector<long double> pre(kids.size() + 1, 1.0L), suf(kids.size() + 1, 1.0L);
                for (size_t j = 0; j < kids.size(); ++j) pre[j + 1] = pre[j] * kidVal[j];
                for (size_t j = kids.size(); j-- > 0;) suf[j] = suf[j + 1] * kidVal[j];
                for (size_t j = 0; j < kids.size(); ++j) {
                    const long double w = wAll * pre[j] * suf[j + 1];
                    if (w == 0.0L) continue;
                    long long idx = 0, mul = 1;
                    for (size_t t = 0; t < kidMap[j].size(); ++t) { idx += (long long)av[(size_t)kidMap[j][t]] * mul; mul *= D_; }
                    kidMsg[j][(size_t)idx] += w;
                }
            }
        }
        // 写回本变量的边际
        const int v0 = ord_[(size_t)i];
        long double tot = 0.0L;
        for (int d = 0; d < D_; ++d) tot += marg[(size_t)d];
        res.zeroCnt[(size_t)v0] = marg[0];
        long double mine = 0.0L;
        uint8_t mask = 0;
        for (int d = 1; d < D_; ++d) {
            mine += marg[(size_t)d];
            if (marg[(size_t)d] > 0.0L) mask = (uint8_t)(mask | (1u << d));
        }
        res.mineCnt[(size_t)v0] = mine;
        res.typeMask[(size_t)v0] = mask;
        if (i == (int)t_.gvars.size() - 1) res.Z = tot;
        // 把消息发给每个子桶
        for (size_t j = 0; j < kids.size(); ++j) {
            const int cj = kids[j];
            back_[(size_t)cj].scope = msgs_[(size_t)cj].scope;
            back_[(size_t)cj].v = std::move(kidMsg[j]);
        }
        return true;
    }

    // ── P2：支撑集（bool 半环前向）───────────────────────────────────────────
    // 目标：算出**整个分量**的 (实雷数, 虚雷数) 可达集合。
    // 为什么不在标量前向里顺手做：那要把消息表从 long double[D^k] 变成带 (R,I) 轴的表，
    // 后向 pass 的「排除第 j 个」还得换成二维卷积（代价 S1×S2），整体贵 3~8 倍。
    // 这里只跑一次**纯 bool** 的前向（复用已经建好的 ord_/pos_/bucketCons_/bucketKids_/scope_），
    // 表值是点集，合并 = Minkowski 和（笛卡尔积 + 坐标相加），不做任何计数。
    //
    // 用途：只有「哪些 (nr,ni) 可达」，所以**计数权重无关** —— 这条性质很重要，
    //   它让支撑集可以安全地进 globalFilter 的可达性计算（那里只需要布尔），
    //   而不必去伪造 profSolCnt（伪造会污染 exactProbs 的卷积系数）。
    // 语义：DP 不做 rlim/ilim 剪枝 → 支撑集是超集 → 只会让可达性更松，不会误杀合法 profile。
    using Pt = std::pair<int, int>;

    struct SupMsg {
        std::vector<int> scope;
        std::vector<std::vector<Pt>> pts; // 每个 code 一个点集
    };

    bool computeSupport(DpResult& res, long long cap) {
        if (t_.classic) return false; // 支撑集只对复数口径有意义（经典口径 Itot=0，另有全局约束口径）
        const int n = (int)t_.gvars.size();
        if (n == 0) { res.support.push_back({0, 0}); return true; }
        std::vector<SupMsg> sup((size_t)n);
        long long work = 0;
        for (int i = 0; i < n; ++i) {
            const auto& sc = scope_[(size_t)i];
            const int k = (int)sc.size();
            const long long total = powD(k);
            if (work > cap - total) return false;
            work += total;
            std::vector<int> varAt((size_t)n, -1);
            for (int p = 0; p < k; ++p) varAt[(size_t)sc[(size_t)p]] = p;
            const auto& kids = bucketKids_[(size_t)i];
            std::vector<std::vector<int>> kidMap(kids.size());
            for (size_t j = 0; j < kids.size(); ++j) {
                const auto& ks = sup[(size_t)kids[j]].scope;
                kidMap[j].resize(ks.size());
                for (size_t t2 = 0; t2 < ks.size(); ++t2) kidMap[j][t2] = varAt[(size_t)ks[t2]];
            }
            std::vector<std::vector<Pt>> tbl((size_t)total);
            std::vector<int> av((size_t)k, 0);
            for (long long code = 0; code < total; ++code) {
                long long x = code;
                for (int p = 0; p < k; ++p) { av[(size_t)p] = (int)(x % D_); x /= D_; }
                bool good = true;
                for (int ci : bucketCons_[(size_t)i])
                    if (!evalCons(t_.cons[(size_t)ci], av, varAt)) { good = false; break; }
                if (!good) continue;
                std::vector<Pt> cur;
                cur.emplace_back(0, 0);
                for (size_t j = 0; j < kids.size() && !cur.empty(); ++j) {
                    long long idx = 0, mul = 1;
                    for (size_t t2 = 0; t2 < kidMap[j].size(); ++t2) {
                        idx += (long long)av[(size_t)kidMap[j][t2]] * mul;
                        mul *= D_;
                    }
                    const auto& kp = sup[(size_t)kids[j]].pts[(size_t)idx];
                    if (kp.empty()) { cur.clear(); break; }
                    std::vector<Pt> nxt;
                    nxt.reserve(cur.size() * kp.size());
                    for (const auto& a : cur)
                        for (const auto& b : kp) nxt.emplace_back(a.first + b.first, a.second + b.second);
                    if (nxt.size() > (size_t)kSupportCap) return false; // 病态：点集爆炸
                    std::sort(nxt.begin(), nxt.end());
                    nxt.erase(std::unique(nxt.begin(), nxt.end()), nxt.end());
                    cur.swap(nxt);
                }
                if (cur.empty()) continue;
                tbl[(size_t)code] = std::move(cur);
            }
            // 消元 scope[0]（= ord_[i]）：把它的 (Δ实雷数, Δ虚雷数) 加到每个点上，再对 d 取并集
            // ★ 口径必须与 dfsFull/profileAdd 完全一致：(R,I) 是「实轴雷的**个数**、虚轴雷的**个数**」，
            //   不是 CRE/CIM 的数值和 —— CRE 对类型 2 是 -1（同轴取反），当数值加会得到负数，
            //   于是 nx 为负、`suff[ny*W+nx]` 的 size_t 下溢 → 堆越界（已用 ASan 复现过）。
            SupMsg msg;
            msg.scope.assign(sc.begin() + 1, sc.end());
            const long long stride = (k > 1) ? (total / D_) : 1;
            msg.pts.assign((size_t)stride, {});
            for (long long code = 0; code < total; ++code) {
                const auto& src = tbl[(size_t)code];
                if (src.empty()) continue;
                const int d0 = (int)(code % D_);
                const int dr = (d0 && (t_.classic || CRE[d0])) ? 1 : 0;
                const int di = (d0 && !t_.classic && !CRE[d0]) ? 1 : 0;
                auto& dst = msg.pts[(size_t)(code / D_)];
                for (const auto& a : src) dst.emplace_back(a.first + dr, a.second + di);
            }
            for (auto& v : msg.pts) {
                if (v.size() > 1) {
                    std::sort(v.begin(), v.end());
                    v.erase(std::unique(v.begin(), v.end()), v.end());
                }
                if (v.size() > (size_t)kSupportCap) return false;
                if (v.size() > res.supportMax) res.supportMax = (int)v.size();
            }
            sup[(size_t)i] = std::move(msg);
        }
        const int root = n - 1;
        if (sup[(size_t)root].scope.empty() && !sup[(size_t)root].pts.empty()) {
            res.support = std::move(sup[(size_t)root].pts[0]);
        } else {
            return false;
        }
        if (res.support.empty() || res.support.size() > (size_t)kSupportCap) return false;
        return true;
    }

    static constexpr int kSupportCap = 4096; // 单点集上限；超了放弃支撑集（不影响 DP 主体结论）

    long long supportCap_ = 6000000; // 支撑集前向的工作量上限（表项数）
};

struct SolverStats {
    int games = 0, wins = 0, zeroGuessWins = 0, guessGames = 0;
    long long guesses = 0, guessBooms = 0, forcedBooms = 0, degradedComps = 0, flagsPlaced = 0;
    long long flagPosWrong = 0, flagAxisWrong = 0, flagFlipWrong = 0; // 自检三分类：标在非雷上(位置错)/跨轴(必输)/同轴取反(v5 允许整分量翻转)
    int flipLostGames = 0, flipGames = 0; // 含同轴取反标记的局 / 其中输掉的局（输因通常是后续被迫猜，非标记错）
    int flagPathWins = 0; // 含标记动作的胜局（纯开格路径之外靠标记推进赢下的局）
    long long guessMid = 0, guessEnd = 0; // 中局猜（盘面未过半）/残局猜（已开过半）
    long long guessTrap = 0; // 陷阱猜：被迫猜时最小含雷概率仍 >= 0.2（近似经典'死亡50/50'口径）
    // 陷阱猜三分类（第五代诊断）：exact = 全盘概率都是精确模型算的（该局在信息论意义上
    // 无安全格可开，真死局）；pool = exactProbs 成功但盘上还有非 FULL 分量（那些格的
    // 概率来自吸收池对称假设，可能漏掉可证明的安全格——可优化）；approx = 概率整体
    // 回退估计（最可能藏着漏证的安全格——最有优化价值）。
    long long guessTrapExact = 0, guessTrapPool = 0, guessTrapApprox = 0;
    // 诊断：Σ log(1-P_i) 的指数 = 「按当前策略与当前概率，这局的理论存活率上界」。
    // 它等于把每步猜的存活概率连乘起来 —— 若实测胜率≈它，说明策略已到 min-P 贪心的极限，
    // 再提胜率只能改变「选哪个格」的策略本身，而不是把概率算得更准。
    double logSurvive = 0.0;
    long long guessP03 = 0, guessP04 = 0; // P>=0.3 / P>=0.4 的猜次数（陷阱分布细看）
    // 概率校准：按预测 P 分桶统计「猜了几次 / 实际踩了几次」。
    // 若某桶实际命中率远高于预测，说明该来源的概率系统性偏低（乐观），
    // 而那会把「按 min-P 贪心」直接变成「朝着最危险的地方猜」。
    long long calN[6] = {0,0,0,0,0,0};
    long long calBoom[6] = {0,0,0,0,0,0};
    long long calInteriorN[6] = {0,0,0,0,0,0};   // 其中内部格（用 pIn 的）各桶次数
    // gDbg 专用的**无偏**校准：直接用真值判断该格是否含雷（不走"是否爆"这条带生存者偏差的路径）。
    // 生产路径不读 mine；这里与既有的 debugDump 同属 gDbg 诊断分支。
    long long truthN[6] = {0,0,0,0,0,0};
    long long truthMine[6] = {0,0,0,0,0,0};
    long long truthNInterior[6] = {0,0,0,0,0,0};
    long long truthMineInterior[6] = {0,0,0,0,0,0};
    static int calBucket(double p) {
        if (p < 0.02) return 0;
        if (p < 0.05) return 1;
        if (p < 0.10) return 2;
        if (p < 0.20) return 3;
        if (p < 0.35) return 4;
        return 5;
    }
    long long compFullHist[5] = {0,0,0,0,0}, compDegHist[5] = {0,0,0,0,0}; // 桶: 1-8,9-16,17-32,33-64,65+
    long long dpComps = 0;                                                // 靠 DP 精确解出的分量数
    long long dpWidthRetry = 0, dpWorkRetry = 0;                          // C1 阶梯重试计数（宽度档 / 工作量档）
    long long dpFailKind[8] = {0,0,0,0,0,0,0,0};                          // DP 最终放弃的原因分布（下标= run() 注释里的 failKind）
    long long compDPHist[5] = {0,0,0,0,0};                                // 同上分桶
    long long dpSupportComps = 0;                                         // 其中算出 (nr,ni) 支撑集的分量数
    long long dpSupportPoints = 0;                                        // 支撑集点数总和（估 pref 膨胀）
    long long dpLayeredComps = 0, dpLayeredFail = 0;                      // A1 分层 DP：升格 FULL / 放弃回标量
    long long dpLayeredSkipW = 0;                                         // 分层被宽度门槛跳过的分量数（诊断）
    int dpLayeredProfMax = 0;                                             // 单分量 profile 点数最大值
    long long dpOracleOk = 0, dpOracleBad = 0, dpOracleSkip = 0, dpOracleBrute = 0; // oracle 对拍（MS_DP_ORACLE=1）
    int dpSupportMax = 0;                                                 // 分量支撑集的最大点数
    int dpMsgSupportMax = 0;                                              // 中间消息单 code 的最大点集大小
};

// ── A1 oracle（仅 MS_DP_ORACLE=1 时由 tryDp 调用；产品路径零开销）────────────
// 两道对拍：
//   ① 标量交叉（所有分层成功的分量）：ΣprofSolCnt ≈ dp.Z、Σ_p profCellMine[p][v] ≈
//      dp.mineCnt[v]（相对误差 1e-9）——同一次消元序的两种数据结构互证。
//   ② 暴力真值：Enumerator 全量枚举该分量（节点预算 ×64；rlim/ilim 不设界，
//      与 DP 的超集语义同口径）。穷尽 → 逐 profile 对拍 profSolCnt / profCellMine /
//      profCellTypes（整数计数值，容差 0.5）；截断 → 记 skip（此时只有①作保障）。
//      预筛：标量 Z（超集解数）> 2e7 的分量枚举必烧满预算，直接 skip ——
//      第一版没这道筛，20 局 Medium 烧 6 分多钟 CPU 全在「注定截断」上。
inline void msOracleLayered(const CompTask& task, const DpResult& dp,
                            const BucketDP::LayeredResult& lr, SolverStats& st) {
    bool bad = false;
    long double zL = 0;
    for (long double c : lr.profSolCnt) zL += c;
    const long double zRef = std::max((long double)1.0L, dp.Z);
    if (fabsl(zL - dp.Z) > 1e-9L * zRef) {
        bad = true;
        fprintf(stderr, "[oracle①] Z 分层=%.8Le 标量=%.8Le\n", (long double)zL, (long double)dp.Z);
    }
    for (size_t v = 0; v < dp.mineCnt.size(); ++v) {
        long double mv = 0;
        for (size_t p = 0; p < lr.profCellMine.size(); ++p)
            if (v < lr.profCellMine[p].size()) mv += lr.profCellMine[p][v];
        const long double mRef = std::max((long double)1.0L, dp.mineCnt[v]);
        if (fabsl(mv - dp.mineCnt[v]) > 1e-9L * mRef) {
            bad = true;
            fprintf(stderr, "[oracle①] 变量%zu mineCnt 分层=%.8Le 标量=%.8Le\n", v, (long double)mv, (long double)dp.mineCnt[v]);
        }
    }
    // ② 暴力枚举（预算 ×64 = 2.56 亿节点；解数天文数字的分量会截断 → skip；
    //    Z 预筛见函数头注释）
    if (dp.Z > 2.0e7L) {
        ++st.dpOracleSkip;
        if (bad) ++st.dpOracleBad;
        else ++st.dpOracleOk;
        return;
    }
    CompTask t2 = task;
    t2.rlim = 1 << 20;
    t2.ilim = 1 << 20;
    Enumerator en(t2, 0x0BADC0DEull, 64);
    CompOut eo = en.runFull();
    if (eo.status != CompOut::FULL) {
        ++st.dpOracleSkip;
        if (bad) ++st.dpOracleBad;
        else ++st.dpOracleOk;
        return;
    }
    ++st.dpOracleBrute;
    std::map<std::pair<int,int>, int> pidOf;
    for (size_t p = 0; p < eo.profiles.size(); ++p) pidOf.emplace(eo.profiles[p], (int)p);
    const auto near = [](long double a, long double b) { return fabsl(a - b) <= 0.5L; };
    for (size_t p = 0; p < lr.profiles.size(); ++p) {
        const auto it = pidOf.find(lr.profiles[p]);
        if (it == pidOf.end()) {
            bad = true;
            fprintf(stderr, "[oracle②] profile (%d,%d) 暴力枚举缺失\n", lr.profiles[p].first, lr.profiles[p].second);
            continue;
        }
        const int q = it->second;
        if (!near(lr.profSolCnt[p], (long double)eo.profSolCnt[q])) {
            bad = true;
            fprintf(stderr, "[oracle②] profile (%d,%d) 解数 分层=%.0Lf 暴力=%.0Lf\n",
                    lr.profiles[p].first, lr.profiles[p].second, lr.profSolCnt[p], (long double)eo.profSolCnt[q]);
        }
        for (size_t v = 0; v < dp.mineCnt.size(); ++v) {
            if (!near(lr.profCellMine[p][v], (long double)eo.profCellMine[q][v])) {
                bad = true;
                fprintf(stderr, "[oracle②] profile (%d,%d) 变量%zu mineCnt 分层=%.8Le 暴力=%.8Le\n",
                        lr.profiles[p].first, lr.profiles[p].second, v, lr.profCellMine[p][v], eo.profCellMine[q][v]);
            }
            if (lr.profCellTypes[p][v] != eo.profCellTypes[q][v]) {
                bad = true;
                fprintf(stderr, "[oracle②] profile (%d,%d) 变量%zu typeMask 分层=%u 暴力=%u\n",
                        lr.profiles[p].first, lr.profiles[p].second, v,
                        (unsigned)lr.profCellTypes[p][v], (unsigned)eo.profCellTypes[q][v]);
            }
        }
    }
    // 反向：暴力枚举有而分层没有的 profile（lr 侧漏解）
    for (size_t q = 0; q < eo.profiles.size(); ++q) {
        bool found = false;
        for (const auto& pr : lr.profiles) if (pr == eo.profiles[q]) { found = true; break; }
        if (!found && eo.profSolCnt[q] > 0) {
            bad = true;
            fprintf(stderr, "[oracle②] profile (%d,%d) 分层缺失（暴力=%.0Lf 解）\n",
                    eo.profiles[q].first, eo.profiles[q].second, (long double)eo.profSolCnt[q]);
        }
    }
    if (bad) ++st.dpOracleBad;
    else ++st.dpOracleOk;
}

class Solver {
public:
    Solver(int cols, int rows, int mines, bool classic, int bk) : cols_(cols), rows_(rows), mines_(mines), classic_(classic), budgetK_(bk) {}

    // 挑一个格来猜。**两处调用必须共用这一个真源**（play 与 stepOnce），
    // 否则统计口径与游戏内演示会分叉。
    // 概率相同时用 tieScore_ 打破；概率不同时 tieScore_ 完全不参与。
    int pickGuess(double& bestOut) const {
        if (guessCandidates_.empty()) { bestOut = 1.0; return -1; }
        int pick = guessCandidates_[0];
        double best = probOf(pick);
        int bestTie = tieOf(pick);
        for (int g : guessCandidates_) {
            const double p = probOf(g);
            if (p < best - 1e-12) {
                best = p; pick = g; bestTie = tieOf(g);
            } else if (p <= best + 1e-12) {
                const int t = tieOf(g);
                if (t > bestTie) { pick = g; bestTie = t; }
            }
        }
        bestOut = best;
        return pick;
    }

    double probOf(int g) const { return (g >= 0 && g < (int)pickProb_.size()) ? pickProb_[(size_t)g] : 1.0; }
    int tieOf(int g) const { return (g >= 0 && g < (int)tieScore_.size()) ? tieScore_[(size_t)g] : 0; }

    // ── 盘末「按轴收口」为什么不做（2026-10-24 实测证伪）──────────────────────
    // 曾经的猜想：mustMine_ 要求雷型在全部相容解里唯一，同轴 ± 未锚定时会被排除，
    //   于是盘末未开格全是已知的雷却标不上，求解器只能去开它们（必爆）。
    // 实测（Medium 100 / Hard 60，seed=20261008）：触发条件「未开格数==剩余雷数」出现 0 次，
    //   猜测格中被证实是雷的次数也是 0 —— 从不成立。原因是恒等式而非运气：
    //   ① 求解器先标必雷，标记够了 Board::won() 立刻成立并结束；
    //   ② 雷型 ∈ {±} 的不确定性在 Board 判胜口径里本就是**整分量翻转**的自由度
    //      （未锚定时合法），所以"型不唯一"的必雷格并不需要额外处理；
    //   ③ 必安格总进 forcedSafe_ 被开掉，盘面不会停在"只剩雷"。
    // 结论：这条路不是漏掉的胜局来源，代码已删，勿再加回。

    void play(std::mt19937& rng, SolverStats& st, bool verbose) {
        Board board;
        board.reset(cols_, rows_, mines_);
        const uint32_t bs = rng();
        board.setSeed(bs);
        std::uniform_int_distribution<int> cellDist(0, cols_ * rows_ - 1);
        const int first = cellDist(rng);
        board.open(first / cols_, first % cols_);

        int guessCount = 0;
        bool boomByGuess = false, usedFlag = false;
        int guard = 0;
        while (!board.gameOver() && guard++ < cols_ * rows_ * 4) {
            analyze(board, st);
            bool openedAny = false;
            for (int g : forcedSafe_) {
                if (board.gameOver()) break;
                const int r = g / cols_, c = g % cols_;
                if (board.at(r, c).opened) continue;
                if (gDbg && board.at(r, c).mine != MineType::None) { debugDump(board, g); }
                if (board.open(r, c) == Board::Outcome::Boom) {
                    ++st.forcedBooms;
                    printf("  !! 必开误爆 boardSeed=%u 格(%d,%d) 真雷型=%d\n", bs, r, c, (int)board.at(r, c).mine);
                }
                openedAny = true;
            }
            if (openedAny) continue;
            // 复数口径专属：标记已证明的必雷格（v5 仪表判胜；经典反事实玩家无类型信息，不启用）
            if (!classic_ && !mustMine_.empty()) {
                bool flagged = false;
                for (auto& mm : mustMine_) {
                    const int r = mm.first / cols_, c = mm.first % cols_;
                    if (board.at(r, c).flag != MineType::None) continue;
                    if (gDbg && board.at(r, c).mine == MineType::None) { debugDump(board, mm.first); break; }
                    board.setFlag(r, c, (MineType)mm.second);
                    if (board.at(r, c).mine == MineType::None) printf("  !! 即时位置错标 boardSeed=%u 格(%d,%d) 标型=%d\n", bs, r, c, mm.second);
                    ++st.flagsPlaced; usedFlag = true;
                    flagged = true;
                    if (board.won()) break;
                }
                if (flagged) continue;
            }
            if (guessCandidates_.empty()) break;
            ensureExactProbs();
            double bestP = 1.0;
            const int pick = pickGuess(bestP);
            const double best = bestP;
            ++guessCount; ++st.guesses;
            {
                int openedCnt = 0;
                for (int r = 0; r < rows_; ++r) for (int c = 0; c < cols_; ++c) if (board.at(r, c).opened) ++openedCnt;
                if (openedCnt * 2 > cols_ * rows_) ++st.guessEnd; else ++st.guessMid;
                if (best >= 0.2) {
                    ++st.guessTrap;
                    if (probsExact_ == 2) ++st.guessTrapExact;
                    else if (probsExact_ == 1) ++st.guessTrapPool;
                    else ++st.guessTrapApprox;
                }
                if (best >= 0.3) ++st.guessP03;
                if (best >= 0.4) ++st.guessP04;
                st.logSurvive += std::log(1.0 - std::min(best, 0.999999));
            }
            if (verbose) printf("  [guess] (%d,%d) P(雷)=%.2f\n", pick / cols_, pick % cols_, best);
            {
                const int cb = SolverStats::calBucket(best);
                ++st.calN[cb];
                if (fid_[pick] < 0) ++st.calInteriorN[cb];
                if (gDbg) { // 仅诊断：用真值校准（生产路径不读 mine）
                    const bool truth = (board.at(pick / cols_, pick % cols_).mine != MineType::None);
                    ++st.truthN[cb];
                    if (truth) ++st.truthMine[cb];
                    if (fid_[pick] < 0) {
                        ++st.truthNInterior[cb];
                        if (truth) ++st.truthMineInterior[cb];
                    }
                }
                const bool boom = (board.open(pick / cols_, pick % cols_) == Board::Outcome::Boom);
                if (boom) ++st.calBoom[cb];
                if (boom) { boomByGuess = true; ++st.guessBooms; break; }
            }
        }
        ++st.games;
        bool flipSeen = false;
        for (int r = 0; r < rows_; ++r) for (int c = 0; c < cols_; ++c) {
            const Cell& y = board.at(r, c);
            if (y.flag == MineType::None) continue;
            if (y.mine == MineType::None) ++st.flagPosWrong;
            else if (y.flag != y.mine) {
                const bool sameAxis = ((int)y.flag <= 2) == ((int)y.mine <= 2);
                if (sameAxis) { ++st.flagFlipWrong; flipSeen = true; }
                else ++st.flagAxisWrong;
            }
        }
        const bool won = board.won();
        if (flipSeen) ++st.flipGames;
        if (flipSeen && !won) ++st.flipLostGames;
        if (won) ++st.wins;
        if (guessCount == 0 && won) ++st.zeroGuessWins;
        if (won && usedFlag) ++st.flagPathWins;
        if (guessCount > 0) ++st.guessGames;
        if (verbose) printf("  game seed=%u 结局=%s 被迫猜=%d\n", bs, won ? "胜" : "负", guessCount);
    }

    // —— 游戏内演示步进（与 play 单轮同款逻辑；只产出/执行本步动作，不做整局统计）——
    struct SolverStep { int kind = 0; int r = -1, c = -1; double risk = 0; }; // 0=无动作 1=已开格 2=已标记 3=只能猜(未执行,等确认)
    SolverStep stepOnce(Board& board, SolverStats& st, bool allowGuess) {
        SolverStep out;
        if (board.gameOver()) return out;
        analyze(board, st);
        bool openedAny = false;
        for (int g : forcedSafe_) {
            if (board.gameOver()) break;
            const int r = g / cols_, c = g % cols_;
            if (board.at(r, c).opened) continue;
            board.open(r, c);
            out.r = r; out.c = c; openedAny = true;
        }
        if (openedAny) { out.kind = 1; return out; }
        if (!classic_ && !mustMine_.empty()) {
            bool flagged = false;
            for (auto& mm : mustMine_) {
                const int r = mm.first / cols_, c = mm.first % cols_;
                if (board.at(r, c).flag != MineType::None) continue;
                board.setFlag(r, c, (MineType)mm.second);
                out.r = r; out.c = c; ++st.flagsPlaced; flagged = true;
                if (board.won()) break;
            }
            if (flagged) { out.kind = 2; return out; }
        }
        if (guessCandidates_.empty()) return out;
        ensureExactProbs();
        double best = 1.0;
        const int pick = pickGuess(best);
        out.r = pick / cols_; out.c = pick % cols_; out.risk = best; ++st.guesses;
        if (!allowGuess) { out.kind = 3; return out; }
        board.open(out.r, out.c);
        out.kind = 1;
        return out;
    }

    // —— 概率与降级标记（analyze 之后有效；游戏内提示用）——
    const std::vector<double>& pickProb() const { return pickProb_; }
    const std::vector<int>& candidates() const { return guessCandidates_; }
    bool approx() const { return approx_; } // true=本盘存在降级分量或精确卷积超预算，概率为估计值
    bool pickUnknown(int g) const { return g >= 0 && g < (int)pickUnknown_.size() && pickUnknown_[(size_t)g]; } // 降级采样未找到含雷解：概率未知，不是 0
    const std::vector<int>& forcedSafe() const { return forcedSafe_; } // 可证无雷格（提示：直接开）
    const std::vector<std::pair<int,int>>& mustMine() const { return mustMine_; } // (格, 参考标记型 1..4)（提示：标雷）

    // 精确概率惰性计算：analyze 已存快照；猜格/提示前调用（幂等；失败置 approx 并用均值场回退）
    void ensureExactProbs() {
        if (probsReady_) return;
        probsReady_ = true;
        // oracle 心跳计数（闸 2 活性证明 + exactProbs 成功率）：函数级 static
        static long long gate2Runs = 0, gate2Approx = 0;
        const bool gate2 = msOracleEnabled();
        if (gate2) ++gate2Runs;
        double pIn = -1.0;
        if (!exactProbs(probCompCells_, probOuts_, probFullIdx_, probRtot_, probItot_, probAbsorb_, pIn)) {
            approx_ = true;
            probsExact_ = 0;
            pIn = fallbackPIn_;
            if (gate2) ++gate2Approx;
        } else {
            probsExact_ = 2;
            for (auto& s : probOuts_)
                if (s.status != (int)CompOut::FULL) { approx_ = true; probsExact_ = 1; break; }
            // ★ A1 闸 2（仅 MS_DP_ORACLE=1）：概率恒等式残差。exactProbs 的模型里
            //   每个全局解的雷都恰好分配在 FULL 分量格 + 吸收池，故
            //   Σ_FULL分量 pickProb + pIn×absorb ≡ Rtot+Itot（相对 1e-6 内）。
            //   P3-B 的 2.24× 正是这条恒等式被假权重破坏；分层权重下必须归位。
            {
                double s = 0.0;
                for (int ci : probFullIdx_)
                    for (int g : probCompCells_[(size_t)ci])
                        if (g >= 0 && g < (int)pickProb_.size()) s += pickProb_[(size_t)g];
                s += pIn * (double)probAbsorb_;
                const double tgt = (double)probRtot_ + (double)probItot_;
                if (gate2 && tgt > 0.0 && std::fabs(s - tgt) > 1e-6 * tgt)
                    fprintf(stderr, "[oracle闸2] Σ=%.4f 目标=%.4f 相对偏差=%.2e\n", s, tgt, std::fabs(s - tgt) / tgt);
            }
        }
        // 心跳：成功与回退都吭声（防止「全在回退、检查一次没跑、0 违规是空话」）
        if (gate2 && (gate2Runs <= 6 || gate2Runs % 500 == 0))
            fprintf(stderr, "[oracle闸2] 调用 %lld 次 / approx 回退 %lld 次\n", gate2Runs, gate2Approx);
        for (int g : guessCandidates_)
            if (fid_[g] < 0) pickProb_[g] = pIn; // 内部格（吸收池口径；Kf==0 时为精确占比）
    }

    // 提示用：只分析不动棋盘，并保证概率已算好
    void analyzeForHint(Board& b, SolverStats& st) { analyze(b, st); ensureExactProbs(); }

    // 只做分析不动棋盘（stepOnce 会顺手执行必开格；纯展示风险时用这个）
    int idx(int r, int c) const { return r * cols_ + c; }

    void debugDump(Board& b, int g) { // 仅 --dbg 调用（偷看答案）
        printf("  !! [dbg] 涉案格 (%d,%d) 真雷型=%d\n", g / cols_, g % cols_, (int)b.at(g / cols_, g % cols_).mine);
        printf("  盘面（.连锁空 R/r实提示 I/i虚 M混 0灰零 ?未开 +-iI标记）:\n");
        for (int r = 0; r < rows_; ++r) {
            std::string line;
            for (int c = 0; c < cols_; ++c) {
                const Cell& y = b.at(r, c);
                char ch = '?';
                if (y.flag != MineType::None) ch = "+-iI"[(int)y.flag - 1];
                else if (y.opened) {
                    if (y.minesAround == 0) ch = '.';
                    else if (y.realSum == 0 && y.imagSum == 0) ch = '0';
                    else if (y.imagSum == 0) ch = y.realSum > 0 ? 'R' : 'r';
                    else if (y.realSum == 0) ch = y.imagSum > 0 ? 'I' : 'i';
                    else ch = 'M';
                }
                line += ch;
            }
            printf("    %s\n", line.c_str());
        }
        for (size_t ci = 0; ci < lastCompCells_.size(); ++ci) {
            auto it = std::find(lastCompCells_[ci].begin(), lastCompCells_[ci].end(), g);
            if (it == lastCompCells_[ci].end()) continue;
            const CompOut& o = lastOuts_[ci];
            const int k = (int)(it - lastCompCells_[ci].begin());
            int withMine = 0, ty[5] = {0,0,0,0,0};
            for (auto& s : o.sols) if (s[k]) { ++withMine; ++ty[s[k]]; }
            printf("  分量#%zu: %zu变量 %s 解%zu条; 涉案格含雷解=%d (P1=%d M1=%d Pi=%d Mi=%d)\n",
                   ci, lastCompCells_[ci].size(), lastCovered_[ci] ? "降级" : "FULL", o.sols.size(), withMine, ty[1], ty[2], ty[3], ty[4]);
            printf("  分量格: ");
            for (int v : lastCompCells_[ci]) printf("(%d,%d)", v / cols_, v % cols_);
            printf("\n");
            break;
        }
        printf("  全盘标记: ");
        for (int r = 0; r < rows_; ++r) for (int c = 0; c < cols_; ++c) {
            const Cell& y = b.at(r, c);
            if (y.flag != MineType::None) printf("(%d,%d)标%d真%d ", r, c, (int)y.flag, (int)y.mine);
        }
        printf("\n");
    }
    int find(int x) { while (dsu_[x] != x) { dsu_[x] = dsu_[dsu_[x]]; x = dsu_[x]; } return x; }
    void unite(int a, int b) { a = find(a); b = find(b); if (a != b) dsu_[b] = a; }
    void addFront(int g) { if (fid_[g] < 0) { fid_[g] = (int)front_.size(); front_.push_back(g); } }

    void analyze(Board& b, SolverStats& st) {
        forcedSafe_.clear();
        mustMine_.clear();
        guessCandidates_.clear();
        pickProb_.assign(cols_ * rows_, 0.5);
        pickUnknown_.assign(cols_ * rows_, 0);
        fid_.assign(cols_ * rows_, -1);
        approx_ = false;
        front_.clear();
        if (!b.started()) return;
        const int NC = cols_ * rows_;

        struct Raw { Con con; std::vector<int> gs; };
        std::vector<Raw> raw;
        std::vector<char> blankSafe(NC, 0);
        for (int r = 0; r < rows_; ++r) for (int c = 0; c < cols_; ++c) {
            const Cell& x = b.at(r, c);
            if (!x.opened) continue;
            std::vector<int> gs, known; // known=邻域内求解器已标记的必雷格（玩家已知信息）
            b.forEachNeighbor(r, c, [&](int rr, int cc) {
                if (!b.inBounds(rr, cc) || b.at(rr, cc).opened) return;
                if (b.at(rr, cc).flag != MineType::None) known.push_back((int)b.at(rr, cc).flag);
                else gs.push_back(idx(rr, cc));
            });
            if (x.minesAround == 0) { for (int g : gs) blankSafe[g] = 1; continue; }
            Con con;
            if (classic_) { con.kind = K_CNT; con.cnt = x.minesAround; }
            else if (x.realSum == 0 && x.imagSum == 0) { con.kind = K_SUM; con.minMines = 1; con.minCnt = 2; con.par = 0; }
            else if (x.imagSum == 0) { con.kind = K_SUM; con.re = x.realSum; con.minCnt = std::abs(x.realSum); con.par = std::abs(x.realSum) & 1; }
            else if (x.realSum == 0) { con.kind = K_SUM; con.im = x.imagSum; con.minCnt = std::abs(x.imagSum); con.par = std::abs(x.imagSum) & 1; }
            else { con.kind = K_MIX; con.mixS = sq(x.realSum) + sq(x.imagSum); con.minCnt = mixMinCnt(con.mixS); con.par = con.mixS & 1; }
            for (int t : known) { // 已知雷并入常数项：目标扣贡献、下界与奇偶调整
                con.re -= CRE[t]; con.im -= CIM[t];
                con.offRe += CRE[t]; con.offIm += CIM[t];
                if (con.kind == K_CNT) con.cnt -= 1;
                con.minCnt -= 1; // <0 即自动放宽
                if (con.par >= 0) con.par ^= 1;
                if (con.minMines > 0) con.minMines -= 1;
            }
            if (con.kind == K_CNT && con.cnt < 0) continue; // 不应发生（标记正确时）
            for (int g : gs) if (!blankSafe[g]) addFront(g);
            raw.push_back({std::move(con), std::move(gs)});
        }
        for (int g = 0; g < NC; ++g)
            if (blankSafe[g] && !b.at(g / cols_, g % cols_).opened) forcedSafe_.push_back(g);

        const int nf = (int)front_.size();
        std::vector<std::vector<int>> compCells;
        std::vector<int> compOfFid(nf, -1);
        if (nf > 0) {
            dsu_.assign(nf, 0);
            for (int i = 0; i < nf; ++i) dsu_[i] = i;
            for (auto& rc : raw) {
                int firstLive = -1;
                for (int g : rc.gs) {
                    if (blankSafe[g] || fid_[g] < 0) continue;
                    if (firstLive < 0) firstLive = fid_[g];
                    else unite(firstLive, fid_[g]);
                }
            }
            std::vector<int> rootToComp(nf, -1);
            for (int f = 0; f < nf; ++f) {
                const int root = find(f);
                if (rootToComp[root] < 0) { rootToComp[root] = (int)compCells.size(); compCells.emplace_back(); }
                const int ci = rootToComp[root];
                compOfFid[f] = ci;
                compCells[ci].push_back(front_[f]);
            }
        }

        std::vector<std::vector<Con>> compCons(compCells.size());
        std::vector<std::vector<std::vector<int>>> compVarCons(compCells.size());
        {
            std::vector<int> locOf(NC, -1);
            for (size_t ci = 0; ci < compCells.size(); ++ci)
                for (size_t k = 0; k < compCells[ci].size(); ++k) locOf[compCells[ci][k]] = (int)k;
            for (auto& rc : raw) {
                int ci = -1;
                std::vector<int> lv;
                for (int g : rc.gs) {
                    if (blankSafe[g] || fid_[g] < 0) continue;
                    if (ci < 0) ci = compOfFid[fid_[g]];
                    lv.push_back(locOf[g]);
                }
                if (ci < 0) continue;
                Con lc = rc.con;
                lc.lv = std::move(lv);
                const int cidx = (int)compCons[ci].size();
                compVarCons[ci].resize(compCells[ci].size());
                for (int l : lc.lv) compVarCons[ci][l].push_back(cidx);
                compCons[ci].push_back(std::move(lc));
            }
        }

        // ★ P0-B 子集相减：实现了但**默认关闭** —— 实测负收益。
        //   Medium 100 局：开着 47.0%（降级 227），关掉 53.0%（降级 204）。
        //   原因：派生出来的约束是**逻辑推论**（冗余）——它剪得掉的分支，原约束在同一深度
        //   本来也剪得掉；但每条约束都要在 pushAssign 里快照 + 判定，单节点成本翻倍，
        //   于是固定节点预算内能探索的树反而更小。
        //   它真正的用武之地是「会拿派生约束去定值」的传播型求解器，也就是 P1 的低树宽 DP。
        //   实现保留（deriveSubsetCons），用 MS_SUBTRACT=1 可复现上面的对照。
        if (getenv("MS_SUBTRACT") != nullptr)
            for (size_t ci = 0; ci < compCells.size(); ++ci)
                deriveSubsetCons(compCons[ci], compVarCons[ci]);

        const int K = (int)compCells.size();
        std::vector<CompOut> outs(K);
        int interior = 0, knownFlagged = 0;
        for (int g = 0; g < NC; ++g) {
            const Cell& y = b.at(g / cols_, g % cols_);
            if (y.flag != MineType::None) { ++knownFlagged; continue; }
            if (!y.opened && fid_[g] < 0 && !blankSafe[g]) ++interior;
        }
        int Rtot = 0, Itot = 0;
        if (classic_) { Rtot = mines_ - knownFlagged; } // 已标记视为已知雷（与复数 axisUnflagged 同口径）
        else { auto ax = b.axisUnflagged(); Rtot = ax[1]; Itot = ax[2]; }
        for (int ci = 0; ci < K; ++ci) {
            CompTask task;
            task.classic = classic_;
            task.gvars = compCells[ci];
            task.cons = compCons[ci];
            task.varCons = compVarCons[ci];
            if (task.varCons.size() < task.gvars.size()) task.varCons.resize(task.gvars.size());
            task.rlim = Rtot;
            task.ilim = classic_ ? 0 : Itot;
            Enumerator en(task, (uint64_t)analysisNo_ * 131 + (uint64_t)ci, budgetK_);
            const int nv = (int)compCells[ci].size();
            const int bucket = nv <= 8 ? 0 : nv <= 16 ? 1 : nv <= 32 ? 2 : nv <= 64 ? 3 : 4;
            // 跑一次 DP，成功就把 outs[ci] 填成 DPSOLVED。
            // ★ C1 阶梯重试：旧实现一次失败即降级，而实测长尾失败集中在
            //   「诱导宽 9~10」和「n 大 + 宽 7-8 撞工作量表」两类，都是确定性失败
            //   （BucketDP::run 纯函数，同参重试无意义——那是 P2 修过的坑），但
            //   **换更大的参数**是新信息：宽度档便宜（O(n²) 就知道结果），工作量档
            //   上限收到 16M 表项 ≈ 256MB 内存守卫（理由见 kDpWorkCapBoost 注释）。
            auto tryDp = [&](CompOut& o) -> bool {
                DpResult dp;
                BucketDP dpSolver(task);
                int width = kDpMaxWidth;
                long long wc = kDpWorkCap;
                bool workBoosted = false, ok = false;
                int failKind = 0;
                for (int attempt = 0; attempt < 4; ++attempt) {
                    failKind = 0;
                    ok = dpSolver.run(dp, width, wc, &failKind);
                    if (ok) break;
                    if (failKind == 1) {           // 宽度档：便宜失败，放宽一档再来
                        if (width >= kDpMaxWidthLadder) break;
                        ++width;
                        ++st.dpWidthRetry;
                    } else if (failKind == 2) {    // 工作量档：一次机会，上限 16M 表项
                        if (workBoosted) break;
                        workBoosted = true;
                        wc = kDpWorkCapBoost;
                        ++st.dpWorkRetry;
                    } else break;                  // 结构性失败（含无解/不变量破坏），重试无意义
                }
                if (!ok) {
                    ++st.dpFailKind[failKind & 7]; // 阶梯耗尽仍失败：记下最终原因分布（诊断用）
                    return false;
                }
                o = CompOut{};
                o.status = CompOut::DPSOLVED;
                const int nv2 = (int)compCells[ci].size();
                o.anyMine.assign((size_t)nv2, 0);
                o.anySafe.assign((size_t)nv2, 0);
                o.mineSolCount.assign((size_t)nv2, 0);
                o.cellProb.assign((size_t)nv2, 0.5);
                o.typeMask.assign((size_t)nv2, 0);
                for (int k = 0; k < nv2; ++k) {
                    o.anyMine[(size_t)k] = dp.mineCnt[(size_t)k] > 0.0L ? 1 : 0;
                    o.anySafe[(size_t)k] = dp.zeroCnt[(size_t)k] > 0.0L ? 1 : 0;
                    o.typeMask[(size_t)k] = dp.typeMask[(size_t)k];
                    o.cellProb[(size_t)k] = dp.Z > 0.0L ? (double)(dp.mineCnt[(size_t)k] / dp.Z) : 0.5;
                }
                // ★ P2：把 (nr,ni) 支撑集挂到 profiles 上（只用于布尔可达性）。
                //   注意 profSolCnt 不填、profCellMine 不填 —— 两者都只对 FULL 有定义，
                //   填假值会污染 exactProbs 的卷积系数与见证判定。supportOnly 标记负责让下游跳过。
                if (dp.hasSupport && !dp.support.empty()) {
                    o.profiles = dp.support;
                    o.supportOnly = true;
                    if (dp.supportMax > st.dpMsgSupportMax) st.dpMsgSupportMax = dp.supportMax;
                    st.dpSupportPoints += (long long)dp.support.size();
                    ++st.dpSupportComps;
                }
                // ★ 第四代 A1/A2：标量成功后再试分层（带 (nr,ni) 分层权重）。成功 →
                //   整分量**升格 FULL**：profiles/profSolCnt/profCellMine/profCellTypes
                //   与枚举 FULL 同构，直接进 globalFilter / exactProbs（DP 分量不再
                //   被关在概率耦合之外，2.24× 边际高估就地修复）。
                //   失败 → 保持上面的标量 DPSOLVED + 支撑集路径，只增不减。
                //   门槛：复数口径、诱导宽度 ≤9（宽 9 由 stride 守卫 400k 与 memEntries
                //   总内存守卫兜底；宽 10 的 stride=5^9≈2M 一张表 ~94MB，仍挡在外面）。
                if (!task.classic) {
                    if (dpSolver.maxScopeWidth() > 9) ++st.dpLayeredSkipW;
                    else if (msLayeredEnabled()) {
                    BucketDP::LayeredResult lr;
                    if (dpSolver.runLayered(lr)) {
                        ++st.dpLayeredComps;
                        if ((int)lr.profiles.size() > st.dpLayeredProfMax) st.dpLayeredProfMax = (int)lr.profiles.size();
                        if (msOracleEnabled()) msOracleLayered(task, dp, lr, st);
                        o.status = CompOut::FULL;
                        o.supportOnly = false;
                        o.profiles = std::move(lr.profiles);
                        o.profSolCnt = std::move(lr.profSolCnt);
                        o.profCellMine = std::move(lr.profCellMine);
                        o.profCellTypes = std::move(lr.profCellTypes);
                        return true;
                    }
                    ++st.dpLayeredFail;
                    }
                }
                return true;
            };
            bool done = false;
            // ★ 大分量**先试 DP**：它们枚举必然截断（跑满 400 万节点才放弃，纯浪费），
            //   DP 一遍就精确解出。小分量仍走 DFS —— 那里枚举便宜，而且能拿到 profile
            //   （跨分量二维卷积要用，概率才是精确的）。
            //   ⚠ 只对**复数提示**口径开启：经典口径唯一的全局约束就是「全盘雷数」，
            //   大分量一旦改走 DP 就没有 profile，正好抽掉它最依赖的那条约束 ——
            //   实测经典 Hard 会从 67.5% 掉到 58.0%。经典臂是对照组，必须保持可比。
            bool dpTried = false;
            if (!classic_ && nv > kDpFirstNv) {
                dpTried = true;
                if (tryDp(outs[ci])) {
                    ++st.dpComps;
                    ++st.compDPHist[bucket];
                    done = true;
                }
            }
            if (!done) {
                outs[ci] = en.runFull();
                if (outs[ci].status == CompOut::FULL) {
                    ++st.compFullHist[bucket];
                } else if (!dpTried && tryDp(outs[ci])) { // 枚举截断 → 先用 DP 精确解，DP 放弃才降级
                    // ★ 不要在这里重试已经失败过的 DP：BucketDP::run 是纯函数
                    //   （同样的 CompTask / maxWidth / workCap 必然同样结果），
                    //   而失败点通常是「跑到 workCap 才放弃」，重试等于把这份开销付两遍。
                    //   实测 nv≥64 的大分量在长尾局里正是这样被多烧了一整轮 8M 表项。
                    ++st.dpComps;
                    ++st.compDPHist[bucket];
                } else {
                    en.runCover(outs[ci]);
                    ++st.degradedComps;
                    ++st.compDegHist[bucket];
                }
            }
        }
        ++analysisNo_;

        if (gDbg) {
            lastCompCells_ = compCells; lastOuts_.clear(); lastCovered_.clear();
            for (auto& o : outs) { lastOuts_.push_back(o); lastCovered_.push_back(o.status == CompOut::FULL ? 0 : 1); }
        }
        // 全量成功的分量参与跨分量推理；降级分量的格子并入「自由吸收」容量
        // （吸收是可行域的超集：只会漏掉一些可证明，绝不会误证安全 → 保守可靠）
        //
        // ★ P2：DP 分量若算出了 (nr,ni) 支撑集，就**不再**并进吸收池，而是当作因子参与
        //   全局可达性计算。原先它们整批进 absorb，于是 absorb 从「内部格数」涨到
        //   「内部格数 + 数千」，而 valid 的判据是 `x + y - best <= absorb` → 几乎恒真，
        //   全盘雷数约束对所有 FULL profile 都形同虚设。
        //   注意这里有两个 absorb：见证路径（absorb，扣掉支撑集分量）与概率路径
        //   （absorbProb，仍含它们 —— 因为 DP 没有真实分层权重，不能进 exactProbs 的卷积）。
        std::vector<int> fullIdx, supIdx;
        int absorb = interior, absorbProb = interior;
        for (int ci = 0; ci < K; ++ci) {
            const int cn = (int)compCells[ci].size();
            if (outs[ci].status == CompOut::FULL) { fullIdx.push_back(ci); continue; }
            absorbProb += cn;
            if (outs[ci].supportOnly && !outs[ci].profiles.empty()) supIdx.push_back(ci);
            else absorb += cn;
        }

        std::vector<char> pmF(nf, 0), psF(nf, 0);
        std::vector<uint8_t> typeMaskF(nf, 0); // 每格在所有相容解里出现过的雷型位掩码（必雷类型唯一性用）
        bool usedGlobal = false;
        if (!fullIdx.empty() || !supIdx.empty()) {
            std::vector<std::vector<int>> fc;
            std::vector<CompOut*> fo;
            for (int ci : fullIdx) { fc.push_back(compCells[(size_t)ci]); fo.push_back(&outs[(size_t)ci]); }
            for (int ci : supIdx) { fc.push_back(compCells[(size_t)ci]); fo.push_back(&outs[(size_t)ci]); }
            usedGlobal = globalFilter(fc, fo, Rtot, Itot, absorb, pmF, psF, &typeMaskF);
        }
        // 局部分量见证。FULL / DPSOLVED / BUDGET 三者的见证都是**精确**的，可直接用；
        // 只有 COVERED（纯随机采样、没做过定向搜索）才必须视为未知。
        auto applyLocalWitness = [&](int ci) {
            const CompOut& o = outs[(size_t)ci];
            for (size_t k = 0; k < compCells[(size_t)ci].size(); ++k) {
                const int f = fid_[compCells[(size_t)ci][k]];
                if (o.status == CompOut::FULL) {
                    if (o.anyMine.size() > k && o.anyMine[k]) pmF[(size_t)f] = 1;
                    if (o.anySafe.size() > k && o.anySafe[k]) psF[(size_t)f] = 1;
                    for (size_t p = 0; p < o.profiles.size(); ++p)
                        if (o.profCellMine[p][k] > 0)
                            typeMaskF[(size_t)f] = (uint8_t)(typeMaskF[(size_t)f] | o.profCellTypes[p][k]);
                } else if (o.status == CompOut::DPSOLVED) {
                    pmF[(size_t)f] = o.anyMine[k] ? 1 : 0;
                    psF[(size_t)f] = o.anySafe[k] ? 1 : 0;
                    typeMaskF[(size_t)f] = (uint8_t)(typeMaskF[(size_t)f] | o.typeMask[k]);
                } else if (o.status == CompOut::BUDGET) {
                    // ★ 覆盖搜索（BUDGET）的见证是**精确**的，不能当"未知"丢掉：
                    //   runCover 对每个 flag==0 的 (格, 取值) 都做过一次**定向存在性搜索**，
                    //   只有「预算内穷尽且未找到」才让 flag 留 0 —— 那正是"该取值不存在"的证明；
                    //   超时的格在 runCover 里已被置成 anyMine=anySafe=1（未知）。
                    //   所以这里的 0 = 确认不存在，可以安全产生 forcedSafe。
                    //   此前 BUDGET 与 COVERED 被合并处理成"未知"，等于把每局上亿节点的
                    //   定向搜索结果整批丢弃（实测 Hard 100 局光 existsSearch 就烧了 1.68 亿节点）。
                    //   注意：覆盖搜索不记录雷型 → 不写 typeMaskF，因此只出 forcedSafe，
                    //   永远不会因此产生"必雷标记"（避免错标）。
                    if (o.anyMine.size() > k) pmF[(size_t)f] = o.anyMine[k] ? 1 : 0;
                    if (o.anySafe.size() > k) psF[(size_t)f] = o.anySafe[k] ? 1 : 0;
                } else {
                    pmF[(size_t)f] = 1; psF[(size_t)f] = 1; // COVERED：只有随机采样，见证不可靠
                }
            }
        };
        if (nf > 0 && !usedGlobal) {
            for (int ci = 0; ci < K; ++ci) applyLocalWitness(ci);
        } else if (usedGlobal) {
            // 全局卷积只覆盖 FULL 分量（有 profile 的那些）。其余分量的见证同样是精确的
            // （DP 的边际、覆盖搜索的定向结论），必须单独叠回来，否则就白算了。
            for (int ci = 0; ci < K; ++ci)
                if (outs[(size_t)ci].status != CompOut::FULL) applyLocalWitness(ci);
        }

        for (int f = 0; f < nf; ++f) {
            const int g = front_[f];
            if (b.at(g / cols_, g % cols_).opened) continue;
            if (!pmF[f]) { forcedSafe_.push_back(g); continue; }
            if (!psF[f]) { // 必雷：复数口径可标记判胜。
                // 类型必须在所有相容解中严格唯一（±号不确定=分量未锚定时不能标：
                // 标记会以硬常数进约束，错号会污染解集）。位置唯一性由 pmF/psF 已保证。
                // 用 typeMaskF（各 profile 里出现过的雷型并集）判定，不再逐条扫解集。
                const uint8_t m = typeMaskF[f];
                int typ = 0, bits = 0;
                for (int t = 1; t <= 4; ++t) if (m & (1u << t)) { typ = t; ++bits; }
                if (bits == 1) mustMine_.emplace_back(g, typ);
                continue;
            }
            guessCandidates_.push_back(g);
            double p = 0.5;
            for (int ci = 0; ci < K; ++ci) {
                const auto& cv = compCells[ci];
                auto it = std::find(cv.begin(), cv.end(), g);
                if (it != cv.end()) {
                    const int k = (int)(it - cv.begin());
                    if (outs[ci].status == CompOut::DPSOLVED) {
                        // DP 解出的分量：分量内**精确**边际（未与其它分量做 (Rtot,Itot) 耦合，
                        // 所以全盘概率仍标 approx，但排序质量比采样好得多）
                        if ((int)outs[ci].cellProb.size() > k) p = outs[ci].cellProb[(size_t)k];
                    } else if (outs[ci].sampleCount > 0 && (int)outs[ci].mineSolCount.size() > k) {
                        p = (double)outs[ci].mineSolCount[k] / (double)outs[ci].sampleCount;
                        // 覆盖采样里没有该格的含雷解（存在性搜索超时）：0 只说明"没采到"，
                        // 不是概率，提示不能把它报成"几乎安全"。
                        if (outs[ci].status != CompOut::FULL && outs[ci].mineSolCount[k] == 0)
                            pickUnknown_[g] = 1;
                    }
                    break;
                }
            }
            pickProb_[g] = p;
        }

        // —— 概率：惰性化 —— analyze 只存快照与均值场回退值；猜格/提示前由 ensureExactProbs() 跑精确卷积
        probCompCells_ = compCells;
        probOuts_.clear();
        probOuts_.reserve((size_t)K);
        for (int ci = 0; ci < K; ++ci) {
            ProbCompSnap s;
            s.status = (int)outs[ci].status;
            s.profiles = outs[ci].profiles;
            s.profCellMine = std::move(outs[ci].profCellMine);
            s.profSolCnt = std::move(outs[ci].profSolCnt);
            probOuts_.push_back(std::move(s));
        }
        probFullIdx_ = fullIdx;
        // 概率路径用的吸收容量仍是「含 DP 分量」的那份（absorbProb）：
        // DP 有精确边际但**没有分层权重**，塞进 exactProbs 的二维卷积等于给它编一个假分布。
        // 但池口径的 pIn 不能直接当内部格概率 —— 非 FULL 分量的边际会从池总额里扣掉，
        // 所以额外记下池的构成（见 ensureExactProbs 里的 B 修正）。
        probRtot_ = Rtot; probItot_ = Itot; probAbsorb_ = absorbProb; probInterior_ = interior;
        // ★ B（2026-10-24 实测否决，勿再试同一招）：曾把 DP 分量的 ΣcellProb 当成
        //   「该分量的期望雷数」，从吸收池总额里扣掉以修正内部格概率。
        //   结果 Medium 500 局配对 23 负 / 7 正（McNemar p≈0.006），Hard 13.3%→10.7%。
        //   原因有二：① DP 忽略 rlim/ilim，解集是超集，ΣcellProb 实测是真实雷数的
        //   **2.24×**（Hard 40 局 / 1080 个 DP 分量）——它根本不是期望雷数；
        //   ② 吸收池实测 203.8 格，其中 interior 184.9、DP 分量只有 ~19 格，
        //   池口径本来就没被稀释，这条修正没有对象。
        //   要让 DP 分量真正参与全局耦合，只能让 DP 输出按雷数分层的历史权重（P1），
        //   拿边际凑不行。反过来说：DP 分量的**前沿**概率被高估 2.24× 是真实缺陷，
        //   但实测校准整体偏保守（10-20% 桶实际 13.2%），不是胜率的当前瓶颈。
        {
            double expComp = 0;
            for (auto& s : probOuts_) {
                long double tot = 0, wsum = 0;
                for (size_t p = 0; p < s.profiles.size(); ++p) {
                    const long double c = p < s.profSolCnt.size() ? s.profSolCnt[p] : 0.0L;
                    tot += c;
                    wsum += c * (long double)(s.profiles[p].first + s.profiles[p].second);
                }
                if (tot > 0) expComp += (double)(wsum / tot);
            }
            fallbackPIn_ = probInterior_ > 0 ? std::min(1.0, std::max(0.001, ((double)(mines_ - knownFlagged) - expComp) / (double)probInterior_)) : 1.0;
        }
        probsReady_ = false;
        for (int g = 0; g < NC; ++g) {
            const Cell& y = b.at(g / cols_, g % cols_);
            if (y.opened || y.flag != MineType::None || fid_[g] >= 0 || blankSafe[g]) continue;
            guessCandidates_.push_back(g);
        }

        // —— 猜格的 tie-break 分数（默认关闭，理由见 kEnableTieBreak 注释）——
        // 背景：内部格（`fid_ < 0`，不接触任何线索）的 pickProb_ **全都等于 pIn** 同一个数，
        // 所以「按概率取最小」在它们之间会退化成「按格号升序取第一个」。
        // 实测这条路无收益：Hard 100 局启用 13.0% vs 不启用 14.0%（在噪声内偏负）。
        // 反思：内部格之间的差异确实无关紧要 —— 决定存活的是「这局要猜几次、每次多险」，
        // 而那由局部推理强度决定，选哪一格改变不了。
        tieScore_.assign((size_t)NC, 0);
        if (kEnableTieBreak && forcedSafe_.empty() && mustMine_.empty() && !guessCandidates_.empty()) {
            bool anyInterior = false;
            for (int g : guessCandidates_) if (fid_[g] < 0) { anyInterior = true; break; }
            if (anyInterior) {
                std::vector<int> openedCells;
                for (int r = 0; r < rows_; ++r)
                    for (int c = 0; c < cols_; ++c)
                        if (b.at(r, c).opened) openedCells.push_back(r * cols_ + c);
                for (int g : guessCandidates_) {
                    if (fid_[g] >= 0) { tieScore_[(size_t)g] = 1 << 20; continue; }
                    const int r0 = g / cols_, c0 = g % cols_;
                    int bestD = 1 << 20;
                    for (int o : openedCells) {
                        const int d = std::abs(o / cols_ - r0) + std::abs(o % cols_ - c0);
                        if (d < bestD) bestD = d;
                    }
                    tieScore_[(size_t)g] = -bestD; // 距离小 → 分数高
                }
            }
        }
    }

    // 猜格 tie-break 开关：实测无收益（Hard 100 局 13.0% vs 不启用 14.0%），默认关闭
    static constexpr bool kEnableTieBreak = false;

private:
    bool globalFilter(const std::vector<std::vector<int>>& compCells, std::vector<CompOut*>& outs,
                      int Rtot, int Itot, int absorb, std::vector<char>& pmF, std::vector<char>& psF,
                      std::vector<uint8_t>* typeMaskF = nullptr) {
        const int K = (int)compCells.size();
        if (Rtot < 0 || Itot < 0) return false;
        const int W = Rtot + 1, H = Itot + 1;
        auto G = [&](std::vector<uint8_t>& v) { v.assign((size_t)W * H, 0); };
        std::vector<std::vector<std::pair<int,int>>> pref(K + 1);
        pref[0] = {{0, 0}};
        for (int ci = 0; ci < K; ++ci) {
            std::vector<std::pair<int,int>> nxt;
            for (auto& a : pref[ci]) for (auto& q : outs[(size_t)ci]->profiles) {
                const int x = a.first + q.first, y = a.second + q.second;
                // 上下界都要查：DP 支撑集不做 rlim/ilim 剪枝，可能含 nr>Rtot 的点（物理不可行），
                // 而负数会直接把 `y*W+x` 的 size_t 下溢成巨值 —— 那是堆越界，不是"保守"。
                if (x >= 0 && y >= 0 && x <= Rtot && y <= Itot) nxt.push_back({x, y});
            }
            std::sort(nxt.begin(), nxt.end());
            nxt.erase(std::unique(nxt.begin(), nxt.end()), nxt.end());
            if (nxt.size() > 8000) return false;
            pref[ci + 1] = std::move(nxt);
        }
        std::vector<std::vector<uint8_t>> suff(K + 1);
        G(suff[K]); suff[K][0] = 1;
        for (int ci = K - 1; ci >= 0; --ci) {
            G(suff[ci]);
            for (int y = 0; y <= Itot; ++y) for (int x = 0; x <= Rtot; ++x) {
                if (!suff[ci + 1][(size_t)y * W + x]) continue;
                for (auto& q : outs[(size_t)ci]->profiles) {
                    const int nx = x + q.first, ny = y + q.second;
                    if (nx >= 0 && ny >= 0 && nx <= Rtot && ny <= Itot) suff[ci][(size_t)ny * W + nx] = 1;
                }
            }
        }
        std::vector<std::vector<uint8_t>> valid(K + 1);
        for (int ci = K; ci >= 1; --ci) {
            std::vector<int> bp((size_t)W * H, -1);
            for (int y = 0; y <= Itot; ++y) for (int x = 0; x <= Rtot; ++x)
                if (suff[ci][(size_t)y * W + x]) bp[(size_t)y * W + x] = x + y;
            for (int y = 0; y <= Itot; ++y) for (int x = 0; x <= Rtot; ++x) {
                int& v = bp[(size_t)y * W + x];
                if (x > 0) v = std::max(v, bp[(size_t)y * W + x - 1]);
                if (y > 0) v = std::max(v, bp[(size_t)(y - 1) * W + x]);
            }
            G(valid[ci]);
            for (int y = 0; y <= Itot; ++y) for (int x = 0; x <= Rtot; ++x) {
                const int best = bp[(size_t)y * W + x];
                if (best >= 0 && x + y - best <= absorb) valid[ci][(size_t)y * W + x] = 1;
            }
        }
        for (int ci = 0; ci < K; ++ci) {
            CompOut& o = *outs[(size_t)ci];
            std::vector<char> compat(o.profiles.size(), 0);
            for (size_t p = 0; p < o.profiles.size(); ++p) {
                const int nr = o.profiles[p].first, ni = o.profiles[p].second;
                for (auto& a : pref[ci]) {
                    const int x = Rtot - nr - a.first, y = Itot - ni - a.second;
                    if (x < 0 || y < 0) continue;
                    if (valid[ci + 1][(size_t)y * W + x]) { compat[p] = 1; break; }
                }
            }
            // ★ supportOnly 的分量（DP 支撑集）只参与上面的可达性计算，**不进见证循环**：
            //   它的 profiles 是可达点集合、没有 profSolCnt / profCellMine，
            //   在这里读会越界，而且"某 profile 里有安全解"这个判据对它无意义。
            //   它自己的格见证由 analyze 里的 applyLocalWitness 单独叠（DP 边际是精确的）。
            if (o.supportOnly) continue;
            for (size_t p = 0; p < o.profiles.size(); ++p) {
                if (!compat[p]) continue;
                if (p >= o.profSolCnt.size() || o.profSolCnt[p] <= 0) continue;
                if (p >= o.profCellMine.size()) continue;
                for (size_t k = 0; k < compCells[ci].size(); ++k) {
                    const int f = fid_[compCells[ci][k]];
                    const long double withMine = o.profCellMine[p][k];
                    // 逐格见证：该 profile 里有含雷解 ⟺ 可能含雷；有安全解 ⟺ 可能安全
                    if (withMine > 0) pmF[f] = 1;
                    if (withMine < o.profSolCnt[p]) psF[f] = 1;
                    if (typeMaskF && withMine > 0) (*typeMaskF)[(size_t)f] = (uint8_t)((*typeMaskF)[(size_t)f] | o.profCellTypes[p][k]);
                }
            }
        }
        for (size_t f = 0; f < pmF.size(); ++f)
            if (!pmF[f] && !psF[f]) { pmF[f] = 1; psF[f] = 1; }
        return true;
    }

    // 精确概率惰性计算：analyze 存快照，ensureExactProbs 消费
    struct ProbCompSnap {
        int status = 0; // CompOut::Status
        std::vector<std::pair<int,int>> profiles;
        std::vector<std::vector<long double>> profCellMine; // [profile][变量] 含雷解数（A1 起分层 DP 也产这份）
        std::vector<long double> profSolCnt;                // [profile] 相容解条数
    };

    // 精确概率：FULL 分量按 profile 分层，前向/后向二维卷积 + 内部格二项吸收池（long double 计数）。
    // 成功：写入 FULL 分量格 pickProb_，并经 pIn 返回内部格精确含雷率；失败：不改动，调用方回退估计。
    bool exactProbs(const std::vector<std::vector<int>>& compCells, const std::vector<ProbCompSnap>& outs,
                    const std::vector<int>& fullIdx, int Rtot, int Itot, int absorb, double& pIn) {
        const int Kf = (int)fullIdx.size();
        if (Rtot < 0 || Itot < 0 || absorb < 0) return false;
        const size_t W = (size_t)Rtot + 1, H = (size_t)Itot + 1;
        if (W * H > 1u << 16) return false; // 状态面太大：回退估计
        const int A = absorb;
        for (int i = 0; i < Kf; ++i) {
            const ProbCompSnap& o = outs[(size_t)fullIdx[(size_t)i]];
            if (o.status != (int)CompOut::FULL || (int)o.profCellMine.size() != (int)o.profiles.size()) return false;
        }
        if (Kf == 0) { // 无 FULL 分量：剩余雷全在吸收池，按对称性每格占比精确
            pIn = A > 0 ? (double)(Rtot + Itot) / (double)A : 1.0;
            return true;
        }
        // 1) 全局相容剪枝：pref 可行前缀对 + 后缀可达位图（吸收池兜底），剔除不可能出现的 profile
        std::vector<std::vector<std::pair<int,int>>> pref(Kf + 1);
        pref[0] = {{0, 0}};
        for (int i = 0; i < Kf; ++i) {
            std::vector<std::pair<int,int>> nxt;
            for (auto& a : pref[(size_t)i]) for (auto& q : outs[(size_t)fullIdx[(size_t)i]].profiles) {
                const int x = a.first + q.first, y = a.second + q.second;
                if (x <= Rtot && y <= Itot) nxt.push_back({x, y});
            }
            std::sort(nxt.begin(), nxt.end());
            nxt.erase(std::unique(nxt.begin(), nxt.end()), nxt.end());
            if (nxt.size() > 8000) return false;
            pref[(size_t)i + 1] = std::move(nxt);
        }
        std::vector<std::vector<uint8_t>> suff(Kf + 1);
        auto G = [&](std::vector<uint8_t>& v) { v.assign(W * H, 0); };
        G(suff[Kf]); suff[Kf][0] = 1;
        for (int i = Kf - 1; i >= 0; --i) {
            G(suff[(size_t)i]);
            for (size_t s = 0; s < W * H; ++s) {
                if (!suff[(size_t)i + 1][s]) continue;
                const int r = (int)(s % W), im = (int)(s / W);
                for (auto& q : outs[(size_t)fullIdx[(size_t)i]].profiles) {
                    const int nr = r + q.first, ni = im + q.second;
                    if (nr <= Rtot && ni <= Itot) suff[(size_t)i][(size_t)ni * W + (size_t)nr] = 1;
                }
            }
        }
        std::vector<std::vector<char>> compat(Kf);
        for (int i = 0; i < Kf; ++i) {
            const auto& profs = outs[(size_t)fullIdx[(size_t)i]].profiles;
            compat[(size_t)i].assign(profs.size(), 0);
            std::vector<int> bp(W * H, -1); // bp[y][x] = max(x'+y')，suff[i+1] 状态 x'<=x, y'<=y
            for (size_t s = 0; s < W * H; ++s)
                if (suff[(size_t)i + 1][s]) bp[s] = (int)(s % W) + (int)(s / W);
            for (int y = 0; y <= Itot; ++y) for (int x = 0; x <= Rtot; ++x) {
                int& v = bp[(size_t)y * W + (size_t)x];
                if (x > 0) v = std::max(v, bp[(size_t)y * W + (size_t)x - 1]);
                if (y > 0) v = std::max(v, bp[(size_t)(y - 1) * W + (size_t)x]);
            }
            for (size_t p = 0; p < profs.size(); ++p) {
                const int kR = profs[p].first, kI = profs[p].second;
                for (auto& a : pref[(size_t)i]) {
                    const int x = Rtot - kR - a.first, y = Itot - kI - a.second;
                    if (x < 0 || y < 0) continue;
                    const int best = bp[(size_t)y * W + (size_t)x];
                    if (best >= 0 && (Rtot + Itot - A) - (a.first + a.second + kR + kI) <= best) { compat[(size_t)i][p] = 1; break; }
                }
            }
        }
        // 2) 每 profile 解数直方图 + 二项表 C[n][k]（n<=A）
        std::vector<std::vector<long double>> profCnt(Kf);
        for (int i = 0; i < Kf; ++i) {
            const ProbCompSnap& o = outs[(size_t)fullIdx[(size_t)i]];
            profCnt[(size_t)i] = o.profSolCnt; // 计数式枚举直接给出现成条数
            profCnt[(size_t)i].resize(o.profiles.size(), 0);
        }
        std::vector<std::vector<long double>> C(A + 1);
        for (int n = 0; n <= A; ++n) {
            C[(size_t)n].assign((size_t)n + 1, 1.0L);
            for (int k = 1; k < n; ++k)
                C[(size_t)n][(size_t)k] = C[(size_t)n - 1][(size_t)k - 1] + C[(size_t)n - 1][(size_t)k];
        }
        // 3) 前向 F / 后向 B（B 含吸收池二项分布）
        long long work = 0;
        std::vector<std::vector<long double>> F(Kf + 1);
        F[0].assign(W * H, 0.0L);
        F[0][0] = 1.0L;
        for (int i = 0; i < Kf; ++i) {
            const ProbCompSnap& o = outs[(size_t)fullIdx[(size_t)i]];
            F[(size_t)i + 1].assign(W * H, 0.0L);
            for (size_t s = 0; s < W * H; ++s) {
                const long double fv = F[(size_t)i][s];
                if (!fv) continue;
                const int r = (int)(s % W), im = (int)(s / W);
                for (size_t p = 0; p < o.profiles.size(); ++p) {
                    if (!compat[(size_t)i][p]) continue;
                    if (++work > EXACT_WORK_CAP) return false;
                    const int nr = r + o.profiles[p].first, ni = im + o.profiles[p].second;
                    if (nr > Rtot || ni > Itot) continue;
                    F[(size_t)i + 1][(size_t)ni * W + (size_t)nr] += fv * (long double)profCnt[(size_t)i][p];
                }
            }
        }
        std::vector<std::vector<long double>> B(Kf + 1);
        B[Kf].assign(W * H, 0.0L); // 吸收池二项分布：r 颗实雷、im 颗虚雷的取法数
        for (int r = 0; r <= std::min(Rtot, A); ++r)
            for (int im = 0; im <= std::min(Itot, A - r); ++im)
                B[Kf][(size_t)im * W + (size_t)r] = C[(size_t)A][(size_t)r] * C[(size_t)(A - r)][(size_t)im];
        for (int i = Kf - 1; i >= 0; --i) {
            const ProbCompSnap& o = outs[(size_t)fullIdx[(size_t)i]];
            B[(size_t)i].assign(W * H, 0.0L);
            for (size_t s = 0; s < W * H; ++s) {
                const long double bv = B[(size_t)i + 1][s];
                if (!bv) continue;
                const int r = (int)(s % W), im = (int)(s / W);
                for (size_t p = 0; p < o.profiles.size(); ++p) {
                    if (!compat[(size_t)i][p]) continue;
                    if (++work > EXACT_WORK_CAP) return false;
                    const int nr = r + o.profiles[p].first, ni = im + o.profiles[p].second;
                    if (nr > Rtot || ni > Itot) continue;
                    B[(size_t)i][(size_t)ni * W + (size_t)nr] += bv * (long double)profCnt[(size_t)i][p];
                }
            }
        }
        // 4) 归一化常数 Z 与各分量每格边际
        long double Z = 0.0L;
        for (size_t s = 0; s < W * H; ++s) {
            const long double fv = F[Kf][s];
            if (!fv) continue;
            const int r = (int)(s % W), im = (int)(s / W);
            const int rr = Rtot - r, ii = Itot - im;
            if (rr < 0 || ii < 0) continue;
            Z += fv * B[Kf][(size_t)ii * W + (size_t)rr];
        }
        if (Z <= 0.0L) return false;
        for (int i = 0; i < Kf; ++i) {
            const int ci = fullIdx[(size_t)i];
            const ProbCompSnap& o = outs[(size_t)ci];
            const auto& cells = compCells[(size_t)ci];
            std::vector<std::pair<int,long double>> fs; // F[i] 非零状态
            for (size_t s = 0; s < W * H; ++s) {
                const long double fv = F[(size_t)i][s];
                if (fv) fs.emplace_back((int)s, fv);
            }
            if ((long long)fs.size() * (long long)o.profiles.size() > EXACT_WORK_CAP - work) return false;
            std::vector<long double> cellNum(cells.size(), 0.0L);
            for (size_t p = 0; p < o.profiles.size(); ++p) {
                if (!compat[(size_t)i][p]) continue;
                const int kR = o.profiles[p].first, kI = o.profiles[p].second;
                long double Wp = 0.0L; // 该 profile 与前后缀的搭配权重（自身解数在 profCellMine 里）
                for (auto& fs0 : fs) {
                    const int r = fs0.first % (int)W, im = fs0.first / (int)W;
                    const int rr = Rtot - kR - r, ii = Itot - kI - im;
                    if (rr < 0 || ii < 0) continue;
                    Wp += fs0.second * B[(size_t)i + 1][(size_t)ii * W + (size_t)rr];
                }
                if (!Wp) continue;
                for (size_t k = 0; k < cells.size(); ++k)
                    if (o.profCellMine[p][k]) cellNum[k] += Wp * (long double)o.profCellMine[p][k];
            }
            for (size_t k = 0; k < cells.size(); ++k) {
                const int g = cells[k];
                if (g >= 0 && g < (int)pickProb_.size()) pickProb_[g] = (double)(cellNum[k] / Z);
            }
        }
        // 5) 内部格：吸收池对称 → 每格含雷率 = 池内雷数占比的条件期望
        if (A > 0) {
            long double pNum = 0.0L;
            for (size_t s = 0; s < W * H; ++s) {
                const long double fv = F[Kf][s];
                if (!fv) continue;
                const int r = (int)(s % W), im = (int)(s / W);
                const int aR = Rtot - r, aI = Itot - im;
                if (aR < 0 || aI < 0 || aR + aI > A) continue;
                pNum += fv * C[(size_t)A][(size_t)aR] * C[(size_t)(A - aR)][(size_t)aI] * (long double)(aR + aI) / (long double)A;
            }
            pIn = (double)(pNum / Z);
        } else pIn = 0.0;
        return true;
    }

    static constexpr long long EXACT_WORK_CAP = 20000000; // 长双精度乘加次数上限（超限回退采样估计）

    static constexpr int kDpFirstNv = 32;          // 变量数超过它就先试 DP（枚举必截断）
    static constexpr int kDpMaxWidth = 8;          // DP 诱导宽度上限（基准档，C1 阶梯从此起爬）
    static constexpr int kDpMaxWidthLadder = 10;   // 阶梯顶：8→9→10（buildOrder 是 O(n²) 便宜失败，放宽重试划算）
    static constexpr long long kDpWorkCap = 8000000;  // DP 的表项总数上限（防病态分量拖垮单步）
    // ★ C1 工作量重试上限：msgs_ 保存全部 n 条消息，总内存 = work_×16B（long double）。
    //   8M 表项 ≈ 128MB；计划里的 ×4 = 512MB 太危险，按「内存守卫优先」收到 ×2 ≈ 256MB ——
    //   这正好覆盖实测失败模式（nv≈90、诱导宽 7-8 的分量 work_≈8~35M 中 7M 上下的一档）。
    static constexpr long long kDpWorkCapBoost = 16000000;

    int cols_, rows_, mines_;
    bool classic_;
    int budgetK_;
    long long analysisNo_ = 1;
    std::vector<int> fid_, front_, dsu_;
    std::vector<int> forcedSafe_, guessCandidates_;
    std::vector<std::vector<int>> lastCompCells_;
    std::vector<CompOut> lastOuts_;
    std::vector<char> lastCovered_;
    std::vector<std::pair<int,int>> mustMine_; // (格, 参考标记型 1..4)
    std::vector<double> pickProb_;
    std::vector<int> tieScore_;   // 猜格 tie-break：概率相同时用（内部格按「离已开格的距离」近者优先）
    std::vector<char> pickUnknown_;
    bool approx_ = false; // 本盘概率为估计值（降级分量存在或精确卷积超预算）

    std::vector<std::vector<int>> probCompCells_;
    std::vector<ProbCompSnap> probOuts_;
    std::vector<int> probFullIdx_;
    int probRtot_ = 0, probItot_ = 0, probAbsorb_ = 0, probInterior_ = 0;
    double fallbackPIn_ = 1.0; // 精确卷积失败时内部格均值场回退
    bool probsReady_ = false;
    int probsExact_ = 0; // 本次概率的精确度：2=全盘精确 1=精确但有池口径分量 0=回退估计
};

} // namespace msolve
