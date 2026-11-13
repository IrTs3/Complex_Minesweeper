# NN 蒸馏三端契约（.cnnw + 编码 + 前向）——唯一出处

本文是权重格式、输入编码、前向运算顺序的**权威定义**。三份实现（C++ `src/solver/NNForward.h`、
Python 训练/导出 `tools/nn/`、TS `web/ts/nn.ts`）以本文为准，一致性由金标闸（T84/T85）钉住。

## 1. 输入编码（显示模型，2026-11-07 评审定稿）

固定画布 **16×30**（H×W，通道主序 f32）；小盘棋盘按**左上对齐**落进画布，其余为零。
通道值严格等于玩家在**默认显示模式**下能看到的东西——`alwaysMagnitude` 关闭时的口径：

| 通道 | 内容 | 条件 |
|---|---|---|
| c0 | 1.0 | 该格已开 |
| c1 | realSum/4，clamp ±2 | 仅纯实格（imagSum==0） |
| c2 | imagSum/4，clamp ±2 | 仅纯虚格（realSum==0） |
| c3 | \|z\|/4（=sqrt(re²+im²)/4），clamp ≤2 | 仅混合格（双轴都非零） |
| c4 | 1.0 | 该格未开 |
| c5 | 1.0 | 未开且在前沿（fid≥0） |
| c6 | 恒 0 | 标记型占位 |
| c7 | (mines-flagged)/mines | 全盘广播 |
| c8 | opened/(cols·rows) | 全盘广播 |
| c9 | (mines-flagged)/max(1,unopened)，clamp ≤1 | 全盘广播 |

**硬规则**：混合格的带符号相位（realSum/imagSum 各自值）绝不进网络——老师按「圆上分解点」
也只拿得到模长，喂相位 = 学生拿到连老师都没有的上帝视角（跑分归因污染 + 提示端违反
「提示=可见信息」）。经典 `minesAround` 玩家看不见，不设通道。
case 归属由「哪个通道非零」隐式表达；金标 encode case 必须覆盖纯实/纯虚/混合三态。

坐标：记录里的 `pick`（老师选中格）是 **rows×cols 线性号**；平面/cand 里一律是画布坐标
`(r·30+c)`。消费端做 `canvas = (g//cols)*30 + g%cols` 换算。

## 2. shard 格式（`.bin`，训练数据）

逐局一个文件 `st_<mix>.bin`：

```
"CMSST1"(6B) + u16 cols + u16 rows + u32 mines     ← 14 字节头
记录 × N：
  f32 plane[10×16×30]   ← 编码平面（§1）
  f32 probs[16×30]      ← 老师逐格精确含雷概率（画布坐标）
  u8  cand[16×30]       ← 候选 mask（= guessCandidates_，画布坐标，值恒 0/1）
  u32 boardSeed         ← 本局 board 种子（rng 首抽）
  u16 step              ← 局内猜格序号（0 起）
  u16 pick              ← 老师选中格（rows×cols 线性号）
记录定长 19200+1920+480+8 = 21608 字节。dtype 恒小端。生成：`solver --dump-states DIR`。
```

## 3. 权重格式 `.cnnw`

```
"CMSNW"(5B) + u32 版本 + u32 哨兵 0x1A5A5A1A            ← 13 字节
u16 inC + u16 inH + u16 inW + u16 nLayers             ← 8 字节
逐层：
  conv:  u8 op=0 + u16 outC + u8 kH + u8 kW + u8 pad + u8 act
         + 权重（版本 1/2 布局见下）+ f32 b[outC]
  残差加: u8 op=1 + u16 outC（0 占位）+ 4×u8（0 占位），无权重
尾部 32 字节 sha256（自魔数起、不含本字段）。
```

- **版本 1**：conv 层权重 = f32 w[outC][kH][kW][inC]（注意：不是 PyTorch 原生序，
  导出时 permute(0,2,3,1)）。
- **版本 2（int8 量化，2026-11-09）**：conv 层权重 = f32 scale[outC] +
  i8 q[outC][kH][kW][inC]。量化口径：逐输出通道对称，scale=max|w[oc,:]|/127
  （max=0 时 scale=1、q 全 0），q=clamp(round(w/scale),−127,127)。**消费端加载时
  反量化 w=scale[oc]×q（单次 f32 乘，TS 端 Math.fround）展开成 f32 再前向**——
  反量化值跨端逐位一致，前向路径两版完全相同，金标容差不变。bias 两版都恒 f32。
- **dtype 恒 LE**；无 BatchNorm（三端一致性的最大坑，有意不含）。
- `act`: 0=无 1=ReLU 2=sigmoid。残差加层的 act 作用于加和之后。
- **残差契约**：op1 固定是 [块入口 → conv(ReLU) → conv(无act) → op1] 的第三层，
  输出 = **conv2 输出 + 块入口**（块入口 = 上一个 op1 的输出，首个块 = stem 输出；
  块内 conv1 的输出不是入口）。导出器只产这种序列，加载器不做别的解释。
- 权重 **只留仓库当前一版** `assets/nn/student.cnnw`（重训覆盖）；历史归 gitignore 的
  `tools/nn/runs/`。

网络（v1）：stem Conv(10→48,3×3,p1,ReLU) + 6×ResBlock(48) + 1×1 头(48→1,sigmoid)，
≈26 万参数 ≈1MB。

## 4. 前向运算顺序（三端逐字一致）

逐输出点累加：`acc = bias`，按 **kH→kW→inC** 固定次序累加 `w·x`，越界（padding 区）跳过
（等价 zero-pad，但**不**把 pad 0 累加进顺序）。C++ f32；TS **Math.fround 逐运算**；
PyTorch f32。

对拍容差：C++ ↔ TS ≤ **1e-5**；PyTorch ↔ C++ ≤ **1e-4**。
（1e-6 会被 ARM/x86 FMA 自动向量化重排累加序打爆，放窄是假闸。）

**⚠ 必须喂全画布**：盘面外区域第一层输出 = act(bias) 非零，第二层起渗回盘面边缘——
「按盘面尺寸裁小画布」与固定 16×30 的结果**不等价**（TS 实测差 1e-1 量级）。
推理端别自作聪明省算，编码后整张 16×30 一起前向。

## 5. 金标（tools/nn/golden/golden.jsonl）

每行一个 case：

- `kind=encode`：`cols/rows/mines/cells`（逐格可见信息 `[opened, realSum, imagSum, flag,
  minesAround]` 行主序；minesAround 供前沿判定——复数和对消时与「和为零」不同）+
  `plane`（C++ 权威编码器输出 4800）。
  由 `tools/nn/gen_encode_golden.cpp` 生成，测试重生成后 diff 防漂移。TS/P4 的编码器
  以此为师。
- `kind=forward`：`inB64`（f32 LE 输入平面 19200 字节，base64）+ `out`（16×30 f32 期望
  输出）。导出时用 PyTorch 生成。

消费方：C++（CMake 目标 `nnforward-test`）、TS（`node web/test/nn-forward.mjs`）、
PyTorch（`export_weights.py --verify-golden`）。
