#!/bin/bash
# generate_data.sh — 蒸馏训练数据生成（P1）。老师（精确求解器）自对弈，逐局落 shard。
# 用法：bash tools/nn/generate_data.sh [--smoke N]
#   默认 ~1.25 万局（三难度混合，Mac 一晚）；--smoke 500 先验证管线。
# 产物在 tools/nn/data/shards/（gitignore）；solver 二进制现编现用（不进 dist 链路）。
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SMOKE=0
if [ "${1:-}" = "--smoke" ]; then SMOKE=1; GAMES="${2:-500}"; else GAMES="${GAMES:-12500}"; fi
BIN=/tmp/nnbuild/solver-datagen
mkdir -p /tmp/nnbuild

echo "==> 编译老师（同跑分口径：-O2 -std=c++17）"
g++ -O2 -std=c++17 -I "$ROOT/src" "$ROOT/tools/solver.cpp" "$ROOT/src/core/Board.cpp" -o "$BIN"

DATA="$HERE/data/shards"
mkdir -p "$DATA"
SEED="${SEED:-20261107}"

# 三难度混合： beginner/intermediate/expert 各 1/3；--dump-states 只在复数口径有老师概率。
# 分三批跑（每批同 seed 不同 diff），局种子由 masterSeed^diff^game 派生，天然不撞。
# hard 批最慢（~13s/局），要提速可按不同 SEED 拆多进程并行，互不干扰。
E=$(( GAMES / 3 )); M=$(( GAMES / 3 )); H=$(( GAMES - E - M ))
echo "==> 生成 $GAMES 局（e=$E m=$M h=$H）→ $DATA"
"$BIN" --model complex --diffs e --games "$E" --seed "$SEED" --jsonl --dump-states "$DATA" > "$HERE/data/gen-e.jsonl"
"$BIN" --model complex --diffs m --games "$M" --seed "$SEED" --jsonl --dump-states "$DATA" > "$HERE/data/gen-m.jsonl"
"$BIN" --model complex --diffs h --games "$H" --seed "$SEED" --jsonl --dump-states "$DATA" > "$HERE/data/gen-h.jsonl"

N=$(ls "$DATA"/st_*.bin | wc -l | tr -d ' ')
SZ=$(du -sh "$DATA" | cut -f1)
echo "==> 完成：$N 个 shard，共 $SZ"
if [ "$SMOKE" = 1 ]; then
    echo "（smoke 模式：数据仅验证管线，正式训练前不带 --smoke 重跑）"
fi
