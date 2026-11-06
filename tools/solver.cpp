// solver.cpp — 复数扫雷「自由推理求解器」与免猜率统计（复盘分析工具，不进对局）。
//
// 引擎（约束推理/分量枚举/见证覆盖/全局DP，含诚实契约）在 src/solver/SolverEngine.h，
// 游戏内「机器演示」共用同一引擎；本文件只做统计套件与命令行。
//
// 用法：solver [--diffs emh|all] [--games N] [--model both|complex|classic] [--seed S] [--budget K]
//              [--pomodoro <跑>/<歇>] [--pomodoro-phase <anchor>:<连算>:<整轮>] [--verbose] [--dbg]
//   两种歇都只落在局与局之间：--pomodoro 是本机连算计时，--pomodoro-phase 是调度下发的全局节拍。
#include "solver/SolverEngine.h"
#include "core/Difficulty.h"
#include <chrono>
#include <cstdio>
#include <ctime>
#include <cstdlib>
#include <thread>

// 编译期由 CMake 烙进来的源码指纹（-DSOLVER_VER=xxxxxxxx）；裸 g++ 编译时退化为 dev
#ifndef SOLVER_VER
#define SOLVER_VER "dev"
#endif

using namespace msolve;

namespace {

// —— 番茄钟（散热用）——只在**局与局之间**歇，绝不跨局停：跨局杀等于半局白算，
//    而客户端那边「solver 提前结束 → 本任务作废不交」，中途硬停会把已跑的局全扔掉。
struct Pomodoro {
    long long workSec = 0;    // 连续算了多久该歇；0 = 关
    long long restSec = 0;    // 歇多久；0 = 关
    long long activeMs = 0;   // 累计「真的在算」的时间 —— 休息不计，免得歇完立刻又歇
};
Pomodoro g_pomo;

// 调度下发的全局节拍：三个数都落在**本机墙上时钟**这一域（客户端领任务时把服务器时钟换算过），
// 所以 solver 不需要知道服务器在哪、也不用联网。anchor=周期起点，work=连算秒数，
// cycle=连算+休息一整轮秒数（休息段=cycle-work，算出来不用多存一个数，少一处能写歪的地方）。
struct SchedPhase {
    long long anchor = 0;
    long long workSec = 0;
    long long cycleSec = 0;
    bool on = false;
};
SchedPhase g_sched;

// "<anchor>:<连算>:<整轮>"（全秒，客户端归一好后传）；"off"/"0" 关掉；读不出返回 false。
bool setSchedPhase(const std::string& spec) {
    if (spec == "off" || spec == "0") { g_sched = SchedPhase{}; return true; }
    long long a = 0, w = 0, c = 0;
    if (std::sscanf(spec.c_str(), "%lld:%lld:%lld", &a, &w, &c) != 3) return false;
    if (a < 0 || w <= 0 || c <= w || c > 86400 * 30) return false;   // 周期上限 30 天：防手滑写成一个天文数字
    g_sched.anchor = a;
    g_sched.workSec = w;
    g_sched.cycleSec = c;
    g_sched.on = true;
    return true;
}

// "1h30m" / "45m" / "90s" / "25"（裸数字按分钟）/ "0" / "off" → 秒；读不出返回 -1。
long long parseDur(const std::string& s) {
    if (s == "off" || s == "0") return 0;
    long long total = 0, num = 0;
    bool hasNum = false;
    for (char ch : s) {
        if (ch >= '0' && ch <= '9') { num = num * 10 + (ch - '0'); hasNum = true; continue; }
        long long mult = 0;
        if (ch == 'h') mult = 3600;
        else if (ch == 'm') mult = 60;
        else if (ch == 's') mult = 1;
        else return -1;
        if (!hasNum) return -1;
        total += num * mult;
        num = 0;
        hasNum = false;
    }
    if (hasNum) total += num * 60;   // 尾巴上没单位 = 分钟（--pomodoro 25/5 = 连算 25 分钟歇 5 分钟）
    return total;
}

bool setPomodoro(const std::string& spec) {
    if (spec == "off" || spec == "0") { g_pomo.workSec = g_pomo.restSec = 0; return true; }
    const size_t slash = spec.find('/');
    if (slash == std::string::npos) return false;
    const long long w = parseDur(spec.substr(0, slash));
    const long long r = parseDur(spec.substr(slash + 1));
    if (w < 0 || r < 0 || (w > 0) != (r > 0)) return false;   // 一个开一个关 = 写错了
    g_pomo.workSec = w;
    g_pomo.restSec = r;
    return true;
}

// 一局算完时调用：两种「歇」都在这里落地，都只在**局与局之间**：
//   ① 调度相位（服务端的全局节拍）—— 连正在跑的这个任务也拦住，睡到本轮休息段结束；
//   ② 本机自己的连算计时（--pomodoro）—— 客户端没下发相位时的兜底。
// 绝不跨局停：中途退出 = 客户端判「solver 提前结束 → 整任务作废」，已算的局全扔。
// 相位用**墙上时钟**（不是 steady_clock）：笔记本合盖睡过一小时，醒来该在哪个段就在哪个段。
void pomodoroRest(int g, int games, bool jsonl, long long gameMs) {
    if (g + 1 >= games) return;   // 最后一局算完就交活，不歇
    g_pomo.activeMs += gameMs;
    long long sleepSec = 0;
    bool sched = false;
    if (g_sched.on && g_sched.workSec > 0 && g_sched.cycleSec > g_sched.workSec) {
        long long d = static_cast<long long>(std::time(nullptr)) - g_sched.anchor;
        if (d < 0) d = 0;                       // 本机钟快过服务器：当「刚开始连算」
        const long long pos = d % g_sched.cycleSec;
        if (pos >= g_sched.workSec) { sleepSec = g_sched.cycleSec - pos; sched = true; }
    }
    if (!sched && g_pomo.workSec > 0 && g_pomo.restSec > 0
        && g_pomo.activeMs >= g_pomo.workSec * 1000LL) {
        sleepSec = g_pomo.restSec;
    }
    if (sleepSec <= 0) return;
    const long long ranSec = g_pomo.activeMs / 1000;
    if (jsonl) {
        printf("{\"rest\":%lld,\"ran_ms\":%lld,\"src\":\"%s\"}\n",
               sleepSec, g_pomo.activeMs, sched ? "sched" : "local");
    } else if (sched) {
        printf("☕ 调度说休息一下：本轮还剩 %lld 秒 …\n", sleepSec);
    } else {
        // mm:ss 而不是「0.2 分钟」：客户端面板同一格式，两处读数不一样会被当成 bug
        printf("☕ 已连算 %02lld:%02lld，休息一下 %lld 秒散热 …\n", ranSec / 60, ranSec % 60, sleepSec);
    }
    fflush(stdout);
    // 分段睡：Ctrl+C / kill 不会被一次长 sleep 卡住
    const auto until = std::chrono::steady_clock::now() + std::chrono::seconds(sleepSec);
    while (std::chrono::steady_clock::now() < until)
        std::this_thread::sleep_for(std::chrono::milliseconds(200));
    g_pomo.activeMs = 0;   // 无论哪种歇都把连算计时清零：歇过了就不该马上再歇
}

// —— --jsonl 专用：把单局 fresh 统计合并进累计器 ——
// 计数字段全部相加；三个 *Max 字段在 play 内部就是「更大才更新」的写法，
// 合并用 std::max 才是正确语义（差分会把「本局较大但历史更大」错抹成 0）。
void mergeStats(SolverStats& acc, const SolverStats& g) {
    acc.games += g.games; acc.wins += g.wins; acc.zeroGuessWins += g.zeroGuessWins; acc.guessGames += g.guessGames;
    acc.guesses += g.guesses; acc.guessBooms += g.guessBooms; acc.forcedBooms += g.forcedBooms;
    acc.degradedComps += g.degradedComps; acc.flagsPlaced += g.flagsPlaced;
    acc.flagPosWrong += g.flagPosWrong; acc.flagAxisWrong += g.flagAxisWrong; acc.flagFlipWrong += g.flagFlipWrong;
    acc.flipLostGames += g.flipLostGames; acc.flipGames += g.flipGames;
    acc.flagPathWins += g.flagPathWins;
    acc.guessMid += g.guessMid; acc.guessEnd += g.guessEnd;
    acc.guessTrap += g.guessTrap; acc.guessTrapExact += g.guessTrapExact;
    acc.guessTrapPool += g.guessTrapPool; acc.guessTrapApprox += g.guessTrapApprox;
    acc.guessP03 += g.guessP03; acc.guessP04 += g.guessP04;
    acc.logSurvive += g.logSurvive;
    for (int i = 0; i < 6; ++i) {
        acc.calN[i] += g.calN[i]; acc.calBoom[i] += g.calBoom[i]; acc.calInteriorN[i] += g.calInteriorN[i];
        acc.truthN[i] += g.truthN[i]; acc.truthMine[i] += g.truthMine[i];
        acc.truthNInterior[i] += g.truthNInterior[i]; acc.truthMineInterior[i] += g.truthMineInterior[i];
    }
    for (int i = 0; i < 5; ++i) {
        acc.compFullHist[i] += g.compFullHist[i]; acc.compDegHist[i] += g.compDegHist[i]; acc.compDPHist[i] += g.compDPHist[i];
    }
    for (int i = 0; i < 8; ++i) acc.dpFailKind[i] += g.dpFailKind[i];
    acc.dpComps += g.dpComps; acc.dpWidthRetry += g.dpWidthRetry; acc.dpWorkRetry += g.dpWorkRetry;
    acc.dpSupportComps += g.dpSupportComps; acc.dpSupportPoints += g.dpSupportPoints;
    acc.dpLayeredComps += g.dpLayeredComps; acc.dpLayeredFail += g.dpLayeredFail; acc.dpLayeredSkipW += g.dpLayeredSkipW;
    acc.dpOracleOk += g.dpOracleOk; acc.dpOracleBad += g.dpOracleBad; acc.dpOracleSkip += g.dpOracleSkip; acc.dpOracleBrute += g.dpOracleBrute;
    acc.dpLayeredProfMax = std::max(acc.dpLayeredProfMax, g.dpLayeredProfMax);
    acc.dpSupportMax = std::max(acc.dpSupportMax, g.dpSupportMax);
    acc.dpMsgSupportMax = std::max(acc.dpMsgSupportMax, g.dpMsgSupportMax);
}

void runSuite(bool classic, int games, uint32_t masterSeed, int diffMask, bool verbose, int budget, bool perGame,
              const char* customName = nullptr, int customCols = 0, int customRows = 0, int customMines = 0,
              bool jsonl = false) {
    printf("\n%s 口径\n", classic ? "经典计数（反事实对照）" : "复数提示（本作）");
    printf("%-16s %6s %8s %12s %12s %14s %10s %10s %12s %10s %10s\n", "难度", "局数", "胜率%", "零猜胜率%", "被迫猜局%", "标记推进胜局%", "中局猜", "残局猜", "陷阱猜P>=0.2", "必开误爆", "降级分量");
    const int nDiff = customName ? 1 : 3;
    for (int d = 0; d < nDiff; ++d) {
        if (!customName && !(diffMask & (1 << d))) continue;
        const int cols = customName ? customCols : ms::kDiffs[d].cols;
        const int rows = customName ? customRows : ms::kDiffs[d].rows;
        const int mines = customName ? customMines : ms::kDiffs[d].mines;
        SolverStats st;
        double worstSec = 0.0; int worstGame = -1;
        std::vector<double> secs; // --pergame 时第二行输出每局耗时（验收口径：98 分位 / 全部上限）
        if (perGame) secs.reserve((size_t)games);
        for (int g = 0; g < games; ++g) {
            const uint32_t mix = masterSeed ^ (0x9E3779B9u * (uint32_t)(d + 1)) ^ (uint32_t)(0x85EBCA6Bu * (uint32_t)(g + 1));
            std::mt19937 rng(mix);
            Solver s(cols, rows, mines, classic, budget);
            const auto t0 = std::chrono::steady_clock::now();
            int win = 0;
            if (jsonl) {
                // —— 机器可读模式：单局 fresh 统计 + 逐局 JSON 行（调度客户端消费）——
                SolverStats game{};
                s.play(rng, game, verbose);
                mergeStats(st, game);
                win = game.wins;
                printf("{\"g\":%d,\"win\":%d,\"guess\":%lld,\"mid\":%lld,\"end\":%lld,\"trap\":%lld,"
                       "\"zero\":%d,\"flagpath\":%d,\"sec\":%.2f}\n",
                       g, win, game.guesses, game.guessMid, game.guessEnd, game.guessTrap,
                       game.zeroGuessWins, game.flagPathWins,
                       std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
                fflush(stdout);
            } else {
                // —— 原文本模式：跨局累加，行为逐字节不变 ——
                const int winsBefore = st.wins;
                s.play(rng, st, verbose);
                win = st.wins > winsBefore ? 1 : 0;
            }
            const double sec = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
            if (perGame) { printf("%c", win ? 'W' : 'L'); fflush(stdout); secs.push_back(sec); }
            if (sec > worstSec) { worstSec = sec; worstGame = g; }
            // 局间散热休息（番茄钟关时是空操作）；放在 perGame 之后，不动 W/L 序列的长度
            pomodoroRest(g, games, jsonl, (long long)(sec * 1000.0));
        }
        auto pct = [&](int x) { return st.games ? 100.0 * x / st.games : 0.0; };
        if (perGame) {
            printf("\nT");
            for (double s : secs) printf(" %.1f", s);
            printf("\n");
        }        printf("%-16s %6d %8.1f %12.1f %12.1f %14.1f %10lld %10lld %12lld %10lld %10lld\n",
               customName ? customName : ms::kDiffNames[d], st.games,
               pct(st.wins), pct(st.zeroGuessWins), pct(st.guessGames), pct(st.flagPathWins), st.guessMid, st.guessEnd, st.guessTrap, st.forcedBooms, st.degradedComps);
        if (st.forcedBooms > 0) printf("  !! 内部 bug：必开格踩雷 %lld 次，数字不可信\n", st.forcedBooms);
        if (st.flagPosWrong || st.flagAxisWrong) printf("  !! 内部 bug：位置错标记 %lld、跨轴标记 %lld —— 必雷证明或类型选择有误\n", st.flagPosWrong, st.flagAxisWrong);
        printf("  每局平均标记 %.1f 个；含同轴取反标记的局 %d（v5 合法翻转；其中输掉 %d 局，败因通常是后续被迫猜，位置/跨轴错误才是 bug）\n",
               st.games ? (double)st.flagsPlaced / st.games : 0.0, st.flipGames, st.flipLostGames);
        printf("  分量变量数分布 全量[<=8,9-16,17-32,33-64,65+]=%lld/%lld/%lld/%lld/%lld  DP[%lld/%lld/%lld/%lld/%lld]  降级[%lld/%lld/%lld/%lld/%lld]\n",
               st.compFullHist[0], st.compFullHist[1], st.compFullHist[2], st.compFullHist[3], st.compFullHist[4],
               st.compDPHist[0], st.compDPHist[1], st.compDPHist[2], st.compDPHist[3], st.compDPHist[4],
               st.compDegHist[0], st.compDegHist[1], st.compDegHist[2], st.compDegHist[3], st.compDegHist[4]);
        printf("  DP 阶梯重试（C1）：宽度档 %lld 次 / 工作量档 %lld 次；单局最坏 %.1fs（第 %d 局）\n",
               st.dpWidthRetry, st.dpWorkRetry, worstSec, worstGame);
        printf("  DP 放弃原因分布（1=宽 2=工作量 3=fillScope 4=target序 5=root非标量 6=空根 7=无解）："
               "%lld/%lld/%lld/%lld/%lld/%lld/%lld/%lld\n",
               st.dpFailKind[0], st.dpFailKind[1], st.dpFailKind[2], st.dpFailKind[3],
               st.dpFailKind[4], st.dpFailKind[5], st.dpFailKind[6], st.dpFailKind[7]);
        if (st.guessTrap > 0)
            printf("  陷阱猜三分类：全盘精确（真死局）%lld / 池口径分量 %lld / 概率回退 %lld（后两类藏着可优化的漏证安全格）\n",
                   st.guessTrapExact, st.guessTrapPool, st.guessTrapApprox);
        if (st.dpLayeredComps || st.dpLayeredFail || st.dpLayeredSkipW)
            printf("  分层 DP（A1，MS_LAYERED）：升格 FULL %lld / 回退标量 %lld / 宽度门槛跳过 %lld；单分量 profile 点数最大 %d\n",
                   st.dpLayeredComps, st.dpLayeredFail, st.dpLayeredSkipW, st.dpLayeredProfMax);
        if (st.dpOracleOk || st.dpOracleBad || st.dpOracleSkip)
            printf("  oracle 对拍（MS_DP_ORACLE）：暴力穷尽 %lld（通过 %lld / 失败 %lld）/ 截断跳过 %lld%s\n",
                   st.dpOracleBrute, st.dpOracleOk, st.dpOracleBad, st.dpOracleSkip,
                   st.dpOracleBad ? "  !! 有不一致，见 stderr" : "");
        // 策略上界：把每步「按当前概率的最小含雷率」连乘起来 —— 若实测胜率贴着它，
        // 提胜率只能改「选哪个格」的策略，把概率算得更准没有用。
        if (st.guessGames > 0)
            printf("  理论存活上界 %.1f%%（几何均值 exp(Σlog(1-P)/局数)）\n",
                   100.0 * std::exp(st.logSurvive / (double)st.guessGames));
        // 概率校准：按预测 P 分桶，看实际含雷率是否落在桶内。gDbg 时另给内部格（pIn 口径）子列。
        static const char* kBounds[7] = {"<2%", "2-5%", "5-10%", "10-20%", "20-35%", ">=35%"};
        static const double kMid[6] = {0.01, 0.035, 0.075, 0.15, 0.275, 0.5};
        printf("  猜格校准  桶: ");
        for (int i = 0; i < 6; ++i) printf("%-18s", kBounds[i]);
        printf("\n            预测: ");
        for (int i = 0; i < 6; ++i) printf("%-18.1f", kMid[i] * 100.0);
        printf("\n            实际: ");
        for (int i = 0; i < 6; ++i)
            printf("%-18.1f", st.calN[i] ? 100.0 * (double)st.calBoom[i] / (double)st.calN[i] : 0.0);
        printf("\n            次数: ");
        for (int i = 0; i < 6; ++i) printf("%-18lld", st.calN[i]);
        printf("\n");
        if (gDbg) {
            printf("  其中内部格 次数: ");
            for (int i = 0; i < 6; ++i) printf("%-18lld", st.calInteriorN[i]);
            printf("\n  其中内部格 真值含雷率: ");
            for (int i = 0; i < 6; ++i)
                printf("%-18.1f", st.truthNInterior[i] ? 100.0 * (double)st.truthMineInterior[i] / (double)st.truthNInterior[i] : 0.0);
            printf("\n  全部猜格   真值含雷率: ");
            for (int i = 0; i < 6; ++i)
                printf("%-18.1f", st.truthN[i] ? 100.0 * (double)st.truthMine[i] / (double)st.truthN[i] : 0.0);
            printf("\n");
        }
        if (jsonl) { // 机器可读汇总行（调度客户端/统计脚本消费；文本表格仅供人看）
            printf("{\"summary\":{\"games\":%d,\"wins\":%d,\"zeroGuessWins\":%d,\"guessGames\":%d,"
                   "\"guesses\":%lld,\"guessMid\":%lld,\"guessEnd\":%lld,\"guessTrap\":%lld,"
                   "\"trapExact\":%lld,\"trapPool\":%lld,\"trapApprox\":%lld,"
                   "\"forcedBooms\":%lld,\"flagPathWins\":%d,\"degradedComps\":%lld,"
                   "\"flagPosWrong\":%lld,\"flagAxisWrong\":%lld,\"flagFlipWrong\":%lld,"
                   "\"classic\":%s,\"worstSec\":%.1f}}\n",
                   st.games, st.wins, st.zeroGuessWins, st.guessGames,
                   st.guesses, st.guessMid, st.guessEnd, st.guessTrap,
                   st.guessTrapExact, st.guessTrapPool, st.guessTrapApprox,
                   st.forcedBooms, st.flagPathWins, st.degradedComps,
                   st.flagPosWrong, st.flagAxisWrong, st.flagFlipWrong,
                   classic ? "true" : "false", worstSec);
            fflush(stdout);
        }
    }
}

} // namespace

int main(int argc, char** argv) {
    int games = 200, diffMask = 7, verbose = 0, budget = 1;
    uint32_t seed = 20261008;
    bool runComplex = true, runClassic = true, perGame = false, jsonl = false;
    const char* customName = nullptr;
    int customCols = 0, customRows = 0, customMines = 0;
    // 环境变量兜底：客户端/编排脚本统一用 CMS_POMODORO 传，命令行 --pomodoro 可覆盖它。
    // 读不懂时按「关」处理，但必须吭声，不能静默丢弃。
    if (const char* ev = std::getenv("CMS_POMODORO"); ev && !setPomodoro(ev))
        printf("!! CMS_POMODORO=\"%s\" 读不懂，番茄钟已关闭（格式 <跑>/<歇>，如 25m/5m 或 off）\n", ev);
    // 调度下发的全局节拍（客户端领任务时换算好本机时钟再传）；同样留一个环境变量口子给手跑
    if (const char* ev = std::getenv("CMS_POMO_PHASE"); ev && !setSchedPhase(ev))
        printf("!! CMS_POMO_PHASE=\"%s\" 读不懂，调度相位未生效（格式 <anchor 秒>:<连算秒>:<整轮秒> 或 off）\n", ev);
    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--games" && i + 1 < argc) games = std::max(1, atoi(argv[++i]));
        else if (a == "--seed" && i + 1 < argc) seed = (uint32_t)strtoul(argv[++i], nullptr, 10);
        else if (a == "--diffs" && i + 1 < argc) {
            std::string s = argv[++i]; diffMask = 0;
            for (char ch : s) { if (ch == 'a') diffMask = 7; if (ch == 'e') diffMask |= 1; if (ch == 'm') diffMask |= 2; if (ch == 'h') diffMask |= 4; }
        }
        else if (a == "--model" && i + 1 < argc) { std::string s = argv[++i]; runComplex = s != "classic"; runClassic = s != "complex"; }
        else if (a == "--budget" && i + 1 < argc) budget = std::max(1, atoi(argv[++i]));
        else if (a == "--board" && i + 1 < argc) {
            int c, r, m; char x1, x2;
            if (sscanf(argv[++i], "%d%c%d%c%d", &c, &x1, &r, &x2, &m) == 5 && x1 == 'x' && x2 == 'x'
                && c >= 2 && r >= 2 && m > 0 && m < c * r) {
                static char buf[32];
                snprintf(buf, sizeof buf, "CUSTOM %dx%dx%d", c, r, m);
                customName = buf; customCols = c; customRows = r; customMines = m;
            } else { printf("--board 格式：CxRxM（如 30x16x99），且雷数 < 行*列\n"); return 1; }
        }
        else if (a == "--pomodoro" && i + 1 < argc) {
            // 命令行覆盖环境变量；读不懂就退出，别让人以为番茄钟开着
            if (!setPomodoro(argv[i + 1])) {
                printf("--pomodoro 格式：<跑>/<歇>，每段可带 h/m/s（如 25m/5m、1h30m/10m、90s/30s），off 或 0 关闭。收到 \"%s\"\n", argv[i + 1]);
                return 1;
            }
            ++i;
        }
        else if (a == "--pomodoro-phase" && i + 1 < argc) {
            // 调度相位：读不懂就退出。这一条不能「静默当没收到」——服务端以为拦住了，
            // 机器其实还在连轴转，跟这次要解决的问题正好相反。
            if (!setSchedPhase(argv[i + 1])) {
                printf("--pomodoro-phase 格式：<anchor 秒>:<连算秒>:<整轮秒>（整轮=连算+休息），off 关闭。收到 \"%s\"\n", argv[i + 1]);
                return 1;
            }
            ++i;
        }
        else if (a == "--version") { printf("%s\n", SOLVER_VER); return 0; }
        else if (a == "--dbg") gDbg = true;
        else if (a == "--verbose") verbose = 1;
        else if (a == "--pergame") perGame = true;
        else if (a == "--jsonl") jsonl = true;
        else { printf("用法: solver [--diffs emh|all] [--games N] [--model both|complex|classic] [--seed S] [--board CxRxM] [--budget K] [--pomodoro 25m/5m|off] [--pomodoro-phase anchor:连算:整轮|off] [--jsonl] [--verbose] [--pergame] [--version]\n"); return 1; }
    }
    printf("复数扫雷求解器 · 免猜率统计 v2（seed=%u，预算x%d；两口径使用完全相同棋盘与首点）求解器版本 %s\n", seed, budget, SOLVER_VER);
    if (g_sched.on)
        printf("☕ 调度相位：连算 %llds 歇 %llds（anchor=%lld，本机墙上时钟域），休息段里会在两局之间睡住\n",
               g_sched.workSec, g_sched.cycleSec - g_sched.workSec, g_sched.anchor);
    if (g_pomo.workSec > 0)
        printf("☕ 本机番茄钟：每连算 %llds 休息一下 %llds（只在局与局之间歇，最后一局算完不歇）\n", g_pomo.workSec, g_pomo.restSec);
    if (runComplex) runSuite(false, games, seed, diffMask, verbose != 0, budget, perGame, customName, customCols, customRows, customMines, jsonl);
    if (runClassic) runSuite(true, games, seed, diffMask, verbose != 0, budget, perGame, customName, customCols, customRows, customMines, jsonl);
    return 0;
}
