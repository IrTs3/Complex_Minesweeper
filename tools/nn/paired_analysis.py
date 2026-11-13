# paired_analysis.py — 学生 vs 老师的同种子配对 McNemar（纯标准库）。
#
# 输入：两份 solver --jsonl 输出（老师一份、学生一份），来自**同 masterSeed、同难度序列、
# 同局数**的任务（调度端成对下发的产物）。逐局按出现顺序配对（同参数下局序确定，
# board 种子 = masterSeed^diff^g，两份文件第 i 条 game 行是同一颗种子同一张盘）。
#
# McNemar：只看分歧局（老师赢&学生输 = b，老师输&学生赢 = c）。
#   H0: 两边胜率相同 ⟺ b、c 来自同 p=0.5 二项。精确二项 p = 2·P(X≤min(b,c))，X~Bin(b+c, 0.5)；
#   b+c > 200 时用正态近似（含连续性校正）。
#
# 用法：python3 tools/nn/paired_analysis.py teacher.jsonl student.jsonl
import json
import math
import sys


def load_games(path):
    games = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line.startswith("{"):
                continue
            obj = json.loads(line)
            if "g" in obj and "win" in obj:      # 逐局行（summary 行没有 "g"）
                games.append(obj)
    return games


def binom_two_sided(k, n):
    """P(X≤k) 双侧精确 p 值（X~Bin(n,0.5)）；n 大走正态近似。"""
    if n == 0:
        return 1.0
    if n > 200:
        z = (abs(k - n / 2) - 0.5) / math.sqrt(n) / 2    # /2：Bin(n,0.5) 的方差 n/4
        p = math.erfc(abs(z) / math.sqrt(2))
        return min(1.0, p)
    # 对称二项：p_two = 2·Σ_{i≤k} C(n,i)/2^n
    def logC(n, i):
        return math.lgamma(n + 1) - math.lgamma(i + 1) - math.lgamma(n - i + 1)
    k = min(k, n - k)
    s = sum(math.exp(logC(n, i) - n * math.log(2)) for i in range(k + 1))
    return min(1.0, 2.0 * s)


def main():
    if len(sys.argv) != 3:
        print("用法：paired_analysis.py teacher.jsonl student.jsonl（同种子配对任务的两份 --jsonl）")
        return 2
    tea, stu = load_games(sys.argv[1]), load_games(sys.argv[2])
    n = min(len(tea), len(stu))
    if n == 0:
        print("paired_analysis: 没有可配对的逐局记录"); return 2
    if len(tea) != len(stu):
        print(f"paired_analysis: ⚠ 两份局数不同（{len(tea)} vs {len(stu)}），只配前 {n} 局")
    b = c = both_w = both_l = 0   # b=老师赢&学生输；c=老师输&学生赢
    for i in range(n):
        tw, sw = bool(tea[i]["win"]), bool(stu[i]["win"])
        if tw and not sw: b += 1
        elif sw and not tw: c += 1
        elif tw and sw: both_w += 1
        else: both_l += 1
    wt = sum(bool(t["win"]) for t in tea[:n])
    ws = sum(bool(s["win"]) for s in stu[:n])
    p = binom_two_sided(min(b, c), b + c)
    print(f"配对 {n} 局（同种子同盘）：")
    print(f"  老师胜率 {100.0*wt/n:.1f}%   学生胜率 {100.0*ws/n:.1f}%")
    print(f"  分歧局：老师赢&学生输 b={b}   老师输&学生赢 c={c}   其余 {both_w}+{both_l} 同胜负")
    if b + c == 0:
        print("  结论：零分歧局，两策略在这批盘上不可区分（无法拒绝 H0）")
        return 0
    print(f"  McNemar 精确 p = {p:.4f}（H0: 两边胜率相同）")
    # 胜率差的 95% CI（正态近似，n 局配对差值的方差 = (b+c)/n²）
    diff = (ws - wt) / n
    se = math.sqrt(b + c) / n
    lo, hi = diff - 1.96 * se, diff + 1.96 * se
    print(f"  胜率差（学生-老师）{100*diff:+.1f}%，95% CI [{100*lo:+.1f}%, {100*hi:+.1f}%]")
    verdict = "拒绝 H0" if p < 0.05 else "不能拒绝 H0（差异可能是噪声）"
    print(f"  结论：{verdict} —— {'学生' if diff > 0 else '老师'}{'显著' if p < 0.05 else '数值上'}"
          f"{'高' if diff != 0 else ''}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
