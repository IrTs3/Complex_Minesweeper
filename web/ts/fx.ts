// 装饰特效层：满屏随机飘动的星光 + 左/右键点击时弹出彩色「USTC」字母 +
// 左键点中流星时炸出一圈该星配色的扩散环。
// 只有闸门内的游戏页会引这个模块（学习站 /learn/ 完全不碰）。
//
// ★ 两条规矩破了就是回归 bug，改之前先读完：
//   ① 叠加层必须 `pointer-events: none`（在 style.css 的 #fx 里）。
//      它铺满整个视口、盖在棋盘上面，一旦收事件就把点击全吞了 —— 游戏直接不能玩。
//   ② 监听器挂在 window 的 **capture** 阶段，**默认只读不拦**：
//      为什么非要用 capture：游戏的 canvas 处理器对右键调过 preventDefault()，
//      等到 bubbling 再听就晚了（事件已被它处理过、默认动作也已被取消）；
//      capture 阶段我们先读到坐标，然后把事件原样交给游戏。
//      于是右键插旗、左键翻开、触摸端手势统统不受影响。
//      ★ 唯一的例外（2026-10-20）：**左键真的打中流星时**会 preventDefault +
//        stopPropagation，把那一下吞掉。否则炸圈的同一击还会翻开底下的格子 /
//        点中底下的按钮，手感很怪。没打中流星时一律原样放行。
//        改这里之前想清楚：这是整个文件唯一允许拦事件的地方。
//
// ★ 性能与礼貌：粒子有上限；标签页切到后台就停 rAF；
//   系统开着「减弱动态效果」（prefers-reduced-motion）时**整层不启用** ——
//   那是用户明确表达的偏好，不是可以打折的选项。
//
// ★ 与设置的联动（2026-10-20）：星光密度/半径、以及「点击弹 USTC」开关都来自 SettingsData。
//   initFx 先从 localStorage 起步（消除「game 先构造、fx 后 init」的顺序依赖），
//   之后由 game.ts 在复选框切换 / 滑块改动时调 updateFx() 推实时值进来。
//
// ★ 数量设 0 = 星光层彻底关闭（桌面端没有 prefers-reduced-motion 对应物，靠它兜底）：
//   不铺池、不画星、不放流星；但**字母照常跑** —— 「点击弹 USTC」由复选框门控，
//   与星光数量是两回事。rAF 只在「无星且无字母」时才停，burst 会把它重新拉起来。
//   桌面端 drawFx 同口径。

import { loadSettings } from './settings.js';

const LETTERS = ['U', 'S', 'T', 'C'];
const MAX_LETTERS = 32;         // 连点也不许堆出几百个字形（每个都要 fillText）
const LETTER_LIFE = 1.15;       // 秒：字母从出现到淡出
const FONT = '700 26px "IBM Plex Serif", Georgia, "Times New Roman", serif';

// ═══ 星光观感参数（2026-10-20 观感升级）═══
// ★ 下面 starfx 那一整块与桌面端 Renderer.cpp 顶部的 namespace starfx **必须同数**：
//   两端是两份独立实现，改一端忘另一端就是「同一个设置、两种观感」的漂移。
//   tools/test_gate_ui.py 的 T57 会正则抽值互相比对，别只改一边。
//   数量/倍率的范围与默认在 settings.ts（kStarDensityMin/Max、kStarScaleMin/Max），
//   那里是「设置契约」；这里只管观感形状。
const starfx = {
    // 半径幂律：r = base + span·u^pow → 80% 的星 <1.2px、15% 中等、5% 大星。
    // 旧的均匀半径（一堆一样大的点）是「纸面灰尘」观感的主因之一。
    rBase: 0.8, rSpan: 2.4, rPow: 2.2,
    // 配色权重：白 / 浅蓝 / 淡黄 / 淡粉 / 浅绿 —— 五项之和归一化。
    // ★ 前三个（whiteW/blueW/warmW）的数值**不要动**：登录页 gate/gate.js 里有一份同值副本，
    //   T57 会逐值比对；要加新颜色只能往后追加权重，不能改老的那三个。
    whiteW: 0.58, blueW: 0.32, warmW: 0.10,
    pinkW: 0.10, greenW: 0.10,
    blue: '#66ccff', warm: '#ffd9a0',
    // 光斑贴图：离屏 canvas 一次生成；核 100% → 1/3 半径处 65% → 边缘 #66CCFF 透明。
    glowTex: 64, glowMid: 0.65, haloRatio: 3.6,   // 星核 <1px 退化为纯圆点
    // 闪烁：alpha = base + amp·max(0,sin φ)^pow —— 高次幂让亮是「骤亮」不是匀速呼吸。
    twBase: 0.10, twAmp: 0.88, twPow: 6,
    twSpMin: 0.4, twSpMax: 3.2,                    // rad/s
    // 大星形状：内凹四角尖星 ✦，8 顶点；尖长 3.2r、凹进 0.9r（取代旧的十字加号）。
    bigSpike: 3.2, bigInner: 0.9,
    // 耀斑大亮星：5% 概率、同时存活 1-3 颗；十字长条横 14r 竖 10r，三段递减 alpha。
    flareProb: 0.05, flareMax: 3, flareH: 14, flareV: 10, flareCol: '#bfe6ff',
    // 横向摇摆：x = x0 + A·sin(t·ω+φ)，绘制时算、不累加（累加会攒误差）。
    swayAmpMin: 6, swayAmpMax: 14, swayOmegaMin: 0.3, swayOmegaMax: 0.8,
    trailFrames: 3,                                // 短拖尾：只给大星/耀斑星画 2-3 帧历史
    // 星光密度单位：每 100×100 **逻辑**像素（CSS px）多少颗。实际颗数 = 密度 × 视口面积 / 10000。
    starUnitPx: 100,
    // 旧刻度的换算基准：2026-10-22 之前的设置值 = 参考视口 1512×982 下的颗数。
    // 只在迁移旧存档时用（见 settings.ts 的 starUnit 判断），别拿它算新密度。
    starDensityRefW: 1512, starDensityRefH: 982,
    starPoolMax: 6000,                             // 超大屏 + 最大密度的兜底池上限
    // 流星雨：每批颗数 / 铺开时长 / 批次间隔都随机（20~30 颗铺 15~20 秒，起点间隔 60~90 秒）。
    // 旧版是固定「每 60 秒 12 颗铺 15 秒」，一颗一颗看得出来。
    showerPeriodMin: 60, showerPeriodMax: 90,
    showerSpanMin: 15, showerSpanMax: 20, showerInit: 10,
    showerCountMin: 20, showerCountMax: 30,
    meteorMax: 20,                                 // 同时在飞的硬上限（免得改参数时炸掉）
    meteorAngMin: 20, meteorAngMax: 40,            // 度
    // 单颗过屏 3-4.5s。旧版是 6-8s —— 那时只有一颗，慢才好看；成批之后慢 = 天上飘面条。
    meteorLifeMin: 3, meteorLifeMax: 4.5,
    meteorSamples: 16,                             // 拖尾多边形的分段数（不再是"80 个圆点"，16 段足够平滑）
    meteorTrailMin: 0.6, meteorTrailMax: 1.0,      // 拖尾 = 速度 × 这段时间走过的路径
    // 流星头：不再是五角星，而是「高亮核 + 柔光球 + 四芒 + 细环」——
    // 照真实流星照片（长细线 + 大柔光球 + 细长十字 + 一圈淡环）拆出来的配方。
    // 大小是每颗随机的独立常量，**不吃 starScale 滑块**（那是「背景星光多大」）。
    meteorHeadMin: 10, meteorHeadMax: 14,          // 头部基准半径 R，下面所有比例都乘它
    trailHeadW: 0.1,                               // 拖尾头部半宽 / R（发丝级）
    meteorGlow: 9,                                 // 柔光球直径 / R
    meteorCrossLen: 4.2,                           // 四芒臂长 / R
    meteorCrossW: 0.1,                             // 四芒半宽 / R
    meteorCrossA: 0.85,                            // 四芒最亮处 alpha
    meteorRingR: 2.2,                             // 细环半径 / R
    meteorRingW: 0.09,                             // 细环线宽 / R
    meteorRingA: 0.32,                             // 细环 alpha
    ringFillA: 0.35,
    // 爆圈中心那个十字的转速（rad/s）≈ π/3 = 1.0472。
    // 写成字面量而不是 Math.PI/3：T57 的抽值正则只认 `键: 数字`，写表达式就比不了。
    // 初速方向每炸一次随机（见 spawnRipple），但角速度大小统一 —— 大小也随机会显得散。
    rippleSpin: 1.0472,                               // 环内填充 = 细环 alpha × 这个值（只描边像铁丝圈，填了像玻璃球）
    meteorCoreR: 0.18,                             // 高亮核半径 / R
    // 流星配色：白 / 淡黄 / 淡粉 / 浅绿 / 浅蓝，每颗随机取一档，拖尾和光晕都跟着这档走。
    // ★ 写成数组是刻意的：T57 的颜色正则只认 `名字: '#xxxxxx'` 这种单值写法，
    //   数组抽不出来 → 不参与跨端比对。所以**两端的这个数组必须手工保持一致**
    //   （同序、同值，见 Renderer.cpp 的 kMeteorCols）。
    meteorCols: ['#ffffff', '#ffe9a0', '#ffc0d9', '#b6f2d2', '#bfe6ff'],
    // 点爆流星的扩散圆环：**左键打中流星才触发**（不是点哪都炸），
    // 圈的颜色就是那颗流星的配色，半径在基准值上浮动。
    //   命中半径 = 该颗流星头部外半径 × rippleHit —— 星头只有 10-14px，
    //   不放宽一点在 1280 宽屏上几乎点不中；取 2.4 后约 24-34px，鼠标好点又不至于误伤邻居。
    //   最终半径 = rippleR1 × (1 ± rippleJitter)，每炸一次随机。
    rippleLife: 0.85, rippleR0: 5, rippleR1: 82,
    rippleHit: 2.4, rippleJitter: 0.35,
    // 中心十字的臂长 = **当前光圈半径** × 该值（2026-10-21 用户要求：十字要随光圈一起变大，
    // 而且永远比光圈大一点）。原来是「最终半径 × 0.62 × (1-t)^0.7」——
    // 那是越往后越短、最后缩成 0，而光圈同时在涨，方向正好反了。
    rippleCrossOverRing: 1.18,
    rippleWidth: 2,                                // 环线宽（随扩散变细）
    // 单位圆彩蛋：2-3% 画成空心圆+一条半径线（复数平面意象，呼应应用图标）。
    unitProb: 0.025, unitRMin: 2, unitRMax: 3, unitCol: '#3f9fd6',  // #66CCFF 深一档
    // 上升速度与 dt 封顶（不变量，别动）。
    riseMin: 5, riseMax: 19, dtCap: 0.05,
};

// 运行期可调项：默认值只在 loadSettings 失败/字段缺失时兜底。
const opts = {
    ustcOn: false,              // 「红专并进 理实交融」复选框：关了就不弹字母
    starDensity: 2.17,          // 星光密度（0..7.12 颗/100×100px，0 = 彻底关闭）
    starScale: 1.7,             // 半径倍率（0.6..3.0），实时作用不重建池
};

interface Spark {
    x: number; y: number;       // 当前逻辑坐标（CSS 像素；x 含摇摆偏移）
    x0: number;                 // 摇摆中心：绘制时 x = x0 + amp·sin(t·ω+φ)
    vx: number; vy: number;     // px/s，很慢，只是「浮」
    r: number;                  // 星核基准半径 px；绘制再乘 opts.starScale
    ph: number;                 // 闪烁相位
    sp: number;                 // 闪烁角速度 rad/s
    hue: number;                // 配色档：0 白 / 1 #66ccff / 2 #ffd9a0
    sizeClass: number;          // 0 小 / 1 中 / 2 大（决定画不画 ✦ 与拖尾）
    amp: number; omega: number; swPhase: number;   // 横向摇摆 A / ω / φ
    hx: number[]; hy: number[]; hn: number;        // 最近 3 帧位置：短拖尾
    flare: boolean;             // 耀斑大亮星（十字长条）
    unit: boolean;              // 单位圆彩蛋
}

interface Letter {
    x: number; y: number;
    vx: number; vy: number;
    rot: number; vr: number;
    ch: string;
    hue: number;
    life: number;               // 剩余秒数
}

interface Meteor {
    x: number; y: number; vx: number; vy: number;
    life: number; maxLife: number;
    trailSec: number;           // 拖尾 = 速度 × 这段时间的行程（每颗随机）
    headR: number;              // 头部五角星外半径（出生时定一次；每帧随机会让星形抖动）
    hue: number;                // 配色档 0..4，索引 starfx.meteorCols
}

// 点爆流星炸出的扩散圆环
interface Ripple {
    x: number; y: number;
    life: number; maxLife: number;
    hue: number;                // 被点爆那颗流星的配色（索引 meteorCols）
    r1: number;                 // 这一炸的最终半径：基准 ± 浮动
    // ★ 中心十字的旋转（2026-10-21 用户要求）：初角随机、匀角速转，一直转到这圈消失。
    //   转的是"光芒"这个意象本身 —— 不转的话同一屏炸两次，十字朝向一模一样，很像复制粘贴。
    rot0: number;               // 初始角（rad）
    spin: number;               // 角速度（rad/s），带符号 = 顺时针/逆时针随机
}

const MAX_RIPPLES = 8;          // 连点也不许堆出几十个环

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
const glowByHue: (HTMLCanvasElement | null)[] = [];  // 逐配色档的光斑：核白、边缘染色
const sparks: Spark[] = [];
const letters: Letter[] = [];
const meteors: Meteor[] = [];
const ripples: Ripple[] = [];
let showerTimer = starfx.showerInit;   // 距下一批流星雨
let showerLeft = 0;                    // 本批还剩几颗没放
let showerGap = 0;                     // 距本批下一颗
let showerGapStep = 0;                 // 本批相邻两颗的间隔（每批随机：span / count）
let fxTime = 0;                 // 累计秒：摇摆相位用（绘制时算，不累加到粒子上）
let vw = 0;                     // 视口宽（CSS 像素）
let vh = 0;
let poolW = 0;                  // 上次铺池时的视口尺寸（变化 → 整池重铺）
let poolH = 0;
let raf = 0;                    // 0 = 没在跑
let last = 0;                   // 上一帧时间戳 ms
let started = false;
let reduced = false;            // 系统「减弱动效」：整层不启用

function resize(): void {
    if (!canvas || !ctx) return;
    // 与 renderer.ts 同一口径：dpr 封顶 2，高分屏不发虚、又不浪费显存。
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth;
    vh = window.innerHeight;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    // 之后一律用 CSS 像素作画，免得每个粒子都自己乘一遍 dpr。
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 密度是按视口面积换算的颗数：窗口一变，池子要跟着补/砍。
    syncPool();
}

// 光斑贴图：径向渐变三个 colorStop，与桌面端 ensureGlowTex() 的逐像素衰减同一条曲线。
// 逐配色档各生成一张 —— 核仍是白的，只有中段和边缘染色，
// 这样「白色星核 + 彩色光晕」才和参考图一致。drawImage 没法给贴图染色，
// 所以只能每种颜色单独烘一张（64×64，5 张，总共几十 KB，可以忽略）。
// 星星和流星共用这一套贴图（它们的配色是同一個 meteorCols 数组）。
function ensureGlowHue(hue: number): HTMLCanvasElement | null {
    const cached = glowByHue[hue];
    if (cached !== undefined) return cached;
    const n = starfx.glowTex;
    const c = document.createElement('canvas');
    c.width = n; c.height = n;
    const g = c.getContext('2d');
    if (!g) { glowByHue[hue] = null; return null; }
    const hex = starfx.meteorCols[hue] || '#ffffff';
    const r = parseInt(hex.slice(1, 3), 16);
    const gg = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    // 衰减曲线：a = (1 - d²)^p，p 由 glowMid 反解 —— 这样「1/3 半径处 alpha = glowMid」
    // 这条老约定原样保留，但曲线换成一条**没有折点**的平滑尾巴。
    // 老的 3 stop 分段线性在放大成 90-120px 的柔光球时，1/3 处那道折会显形。
    const p = Math.log(starfx.glowMid) / Math.log(8 / 9);   // (1 - (1/3)²) = 8/9
    const STOPS = 8;
    for (let i = 0; i <= STOPS; i++) {
        const d = i / STOPS;
        const a = Math.pow(Math.max(0, 1 - d * d), p);
        // 核附近保持白，越往外越吃这颗星的配色（参考图：白核 + 彩色晕）
        const k = Math.min(1, d * 2.2);
        const cr = Math.round(255 + (r - 255) * k);
        const cg = Math.round(255 + (gg - 255) * k);
        const cb = Math.round(255 + (b - 255) * k);
        grad.addColorStop(d, `rgba(${cr},${cg},${cb},${a.toFixed(4)})`);
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
    glowByHue[hue] = c;
    return c;
}

// ═══ 光点配方 ═══
// 从真实流星照片拆出来的五层：高亮核 / 柔光球 / 四芒 / 细环（+ 拖尾）。
// 流星、背景大星、点击爆圈三处共用，保证"同一套视觉语言"。

// #rrggbb → rgba()：拖尾和四芒要沿长度淡出，只能靠渐变画刷，而渐变 stop 要字符串
function rgba(hex: string, a: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const aa = a < 0 ? 0 : (a > 1 ? 1 : a);
    return `rgba(${r},${g},${b},${aa})`;
}

/** 四芒：两片细长菱形，沿长度用线性渐变淡出。
 *  不用「分段矩形」是因为段与段之间会看出接缝；渐变画刷一次到位。
 *  armX/armY 分开传：耀斑星的两臂长度本来就不同（flareH / flareV）。 */
function drawCross(x: number, y: number, armX: number, armY: number, halfW: number, alpha: number,
                   rot = 0): void {
    if (!ctx || alpha <= 0.004) return;
    const w = Math.max(0.45, halfW);
    const arms = [armX, armY];
    // 两条臂的**单位方向**。rot = 0 时就是 (1,0) 和 (0,1)，和原来的水平/垂直完全一致，
    // 所以不传 rot 的调用点（流星头、耀斑、大星）行为不变。
    const c = Math.cos(rot), s = Math.sin(rot);
    const dirs = [[c, s], [-s, c]];
    for (let axis = 0; axis < 2; axis++) {
        const arm = arms[axis];
        if (arm <= 0.5) continue;
        const dx = dirs[axis][0], dy = dirs[axis][1];
        const g = ctx.createLinearGradient(x - dx * arm, y - dy * arm, x + dx * arm, y + dy * arm);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(0.5, `rgba(255,255,255,${alpha})`);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(x - dx * arm, y - dy * arm);
        ctx.lineTo(x - dy * w, y - dx * w);
        ctx.lineTo(x + dx * arm, y + dy * arm);
        ctx.lineTo(x + dy * w, y + dx * w);
        ctx.closePath();
        ctx.fill();
    }
}

/** 细圆环：照片里那圈很淡、很细的环 */
function drawRing(x: number, y: number, r: number, w: number, col: string, alpha: number): void {
    if (!ctx || r <= 1 || alpha <= 0.004) return;
    // 环内填一层很淡的同色：只描边是"铁丝圈"，填了才像玻璃球/气泡（参考图就是这样）
    ctx.globalAlpha = alpha * starfx.ringFillA;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.5, w);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
}

/** 光点：柔光球 → 四芒 → 细环 → 高亮核。R 是基准半径，其余全按 starfx 里的比例乘出来。 */
function drawOrb(x: number, y: number, R: number, hue: number, alpha: number, withRing: boolean): void {
    if (!ctx || R <= 0 || alpha <= 0.004) return;
    const g = ensureGlowHue(hue);
    if (g) {
        const d = R * starfx.meteorGlow;
        ctx.globalAlpha = alpha;
        ctx.drawImage(g, x - d / 2, y - d / 2, d, d);
    }
    // 环（含内填充）先画、四芒后画：让十字压在玻璃球上面，和参考图一致
    if (withRing) {
        drawRing(x, y, R * starfx.meteorRingR, R * starfx.meteorRingW,
                 starfx.meteorCols[hue] || '#ffffff', alpha * starfx.meteorRingA);
    }
    drawCross(x, y, R * starfx.meteorCrossLen, R * starfx.meteorCrossLen,
              R * starfx.meteorCrossW, alpha * starfx.meteorCrossA);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.7, R * starfx.meteorCoreR), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
}

function newSpark(anywhere: boolean): Spark {
    // 耀斑星同时存活上限：满额就降级成普通星，别让一屏都是十字光条。
    let flare = Math.random() < starfx.flareProb;
    if (flare) {
        let n = 0;
        for (const s of sparks) if (s.flare) n++;
        if (n >= starfx.flareMax) flare = false;
    }
    const x0 = Math.random() * vw;
    const y = anywhere ? Math.random() * vh : vh + 8 + Math.random() * 24;
    const unit = !flare && Math.random() < starfx.unitProb;
    const r = unit
        ? starfx.unitRMin + Math.random() * (starfx.unitRMax - starfx.unitRMin)
        : starfx.rBase + starfx.rSpan * Math.pow(Math.random(), starfx.rPow);
    return {
        // anywhere=true 用于初始化（铺满全屏）；否则从**下边缘**补进来，
        // 看着像源源不断飘上来，而不是凭空刷新。
        x: x0, x0, y,
        vx: (Math.random() - 0.5) * 6,
        vy: -(starfx.riseMin + Math.random() * (starfx.riseMax - starfx.riseMin)),
        r,
        ph: Math.random() * Math.PI * 2,
        sp: starfx.twSpMin + Math.random() * (starfx.twSpMax - starfx.twSpMin),
        hue: pickHue(),
        sizeClass: r < 1.2 ? 0 : (r < 2 ? 1 : 2),
        amp: starfx.swayAmpMin + Math.random() * (starfx.swayAmpMax - starfx.swayAmpMin),
        omega: starfx.swayOmegaMin + Math.random() * (starfx.swayOmegaMax - starfx.swayOmegaMin),
        swPhase: Math.random() * Math.PI * 2,
        hx: [x0, x0, x0], hy: [y, y, y], hn: 0,
        flare, unit,
    };
}

// 按权重抽配色档。索引就是 meteorCols 的下标 —— 星星和流星**共用同一套颜色**：
//   0 白 / 1 淡黄 / 2 淡粉 / 3 浅绿 / 4 浅蓝
// 权重是按名字配的（蓝不是第 2 个），所以下面把返回值映射写死，
// 别顺手改成「按调色板顺序 return」——那样白和浅蓝的概率会互换。
function pickHue(): number {
    const tot = starfx.whiteW + starfx.blueW + starfx.warmW + starfx.pinkW + starfx.greenW;
    let w = Math.random() * tot;
    if ((w -= starfx.whiteW) < 0) return 0;   // 白
    if ((w -= starfx.blueW) < 0) return 4;    // 浅蓝
    if ((w -= starfx.warmW) < 0) return 1;    // 淡黄
    if ((w -= starfx.pinkW) < 0) return 2;    // 淡粉
    return 3;                                 // 浅绿
}

function coreColor(s: Spark): string {
    return starfx.meteorCols[s.hue] || '#ffffff';
}

function drawSpark(s: Spark): void {
    if (!ctx) return;
    // 闪烁：sin 的 6 次幂 → 绝大多数时间很暗、偶尔「骤亮」。
    // 旧的 0.18+0.44·(0.5+0.5·sin) 是匀速呼吸，那是灰尘感的来源之一。
    const sn = Math.max(0, Math.sin(s.ph));
    const a = Math.min(1, starfx.twBase + starfx.twAmp * Math.pow(sn, starfx.twPow));
    if (a <= 0.004) return;
    // 实时倍率：拖滑块立刻变大变小，无需重建池
    const rr = Math.max(0.3, s.r * opts.starScale);
    const col = coreColor(s);

    // 短拖尾：只给大星/耀斑星画，越旧越淡
    if (s.hn > 0 && (s.sizeClass === 2 || s.flare)) {
        ctx.strokeStyle = col;
        ctx.lineWidth = Math.max(0.5, rr * 0.7);
        let fromX = s.x, fromY = s.y;
        for (let i = 0; i < s.hn; i++) {
            const k = 1 - (i + 1) / (starfx.trailFrames + 1);
            ctx.globalAlpha = a * 0.35 * k;
            ctx.beginPath();
            ctx.moveTo(fromX, fromY);
            ctx.lineTo(s.hx[i], s.hy[i]);
            ctx.stroke();
            fromX = s.hx[i]; fromY = s.hy[i];
        }
    }

    // 光晕：星核 <1px 时退化成纯圆点（亚像素点上糊一张柔光只会变成灰雾）
    if (rr >= 1) {
        const g = ensureGlowHue(s.hue);
        if (g) {
            const d = rr * 2 * starfx.haloRatio;
            ctx.globalAlpha = a * 0.85;
            ctx.drawImage(g, s.x - d / 2, s.y - d / 2, d, d);
        }
    }

    // 星核
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
    ctx.fill();

    if (s.unit) {
        // 单位圆彩蛋：空心圆 + 一条半径线（方向随星而定，但一颗星内不转）
        ctx.strokeStyle = starfx.unitCol;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + Math.cos(s.swPhase) * rr, s.y + Math.sin(s.swPhase) * rr);
        ctx.stroke();
    } else if (s.flare) {
        // 耀斑十字长条：三段递减 alpha/长度/粗细，横 14r、竖 10r
        ctx.fillStyle = starfx.flareCol;
        for (let k = 0; k < 3; k++) {
            const shrink = 1 - k * 0.3;
            const hlen = rr * starfx.flareH * shrink;
            const vlen = rr * starfx.flareV * shrink;
            const th = Math.max(0.6, rr * (0.9 - 0.25 * k));
            ctx.globalAlpha = a * (1 - 0.33 * k) * 0.63;
            ctx.fillRect(s.x - hlen, s.y - th / 2, hlen * 2, th);
            ctx.fillRect(s.x - th / 2, s.y - vlen, th, vlen * 2);
        }
    } else if (s.sizeClass === 2) {
        // 大星：内凹四角尖星 ✦（8 顶点：尖 3.2r、凹 0.9r 交替）
        // ★ 用户 2026-10-21 明确要求：背景星星保持「五色混合 + 好几种形状」的老样子，
        //   不要跟着流星改成四芒+圆环。流星头 / 爆圈才是照片那套。
        ctx.globalAlpha = a;
        ctx.beginPath();
        for (let i = 0; i < 8; i++) {
            const ang = i * Math.PI * 0.25;
            const len = (i % 2 === 0 ? starfx.bigSpike : starfx.bigInner) * rr;
            const px = s.x + Math.cos(ang) * len;
            const py = s.y + Math.sin(ang) * len;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fill();
    }
    ctx.globalAlpha = 1;
}

// ═══ 流星雨 ═══
// 每 showerPeriod 秒来一批、showerCount 颗均匀撒在 showerSpan 秒内。
// 拖尾不存历史位置，而是沿 -v 反推采样点 —— 直线运动下与真历史等价且零状态。
// 速度在出生时按「到出屏点的距离 ÷ 寿命」导出，所以屏幕上正好停留 3-4.5 秒；
// 飞行途中改窗口尺寸不重算（可能提前/延后出屏），出屏即杀仍然兜底。
function spawnMeteor(): void {
    if (meteors.length >= starfx.meteorMax) return;
    const ang = (starfx.meteorAngMin + Math.random() * (starfx.meteorAngMax - starfx.meteorAngMin)) * Math.PI / 180;
    const dir = Math.random() < 0.5 ? -1 : 1;    // 向左下或右下划
    const ux = Math.cos(ang) * dir, uy = Math.sin(ang);  // uy 恒正，一定往下走
    const x = dir < 0 ? vw * (0.35 + Math.random() * 0.7) : vw * (0.05 + Math.random() * 0.6);
    const y = -12;
    // 沿这条射线还能走多远才彻底出屏（与淘汰条件同一套边界）
    const dY = (vh + 40 - y) / uy;
    const dX = ux < 0 ? (x + 80) / -ux : (vw + 80 - x) / ux;
    const maxLife = starfx.meteorLifeMin + Math.random() * (starfx.meteorLifeMax - starfx.meteorLifeMin);
    const sp = Math.min(dX, dY) / maxLife;
    meteors.push({
        x, y, vx: ux * sp, vy: uy * sp,
        life: maxLife, maxLife,
        trailSec: starfx.meteorTrailMin + Math.random() * (starfx.meteorTrailMax - starfx.meteorTrailMin),
        headR: starfx.meteorHeadMin + Math.random() * (starfx.meteorHeadMax - starfx.meteorHeadMin),
        hue: Math.floor(Math.random() * starfx.meteorCols.length),
    });
}

function drawOneMeteor(m: Meteor): void {
    if (!ctx) return;
    // 淡入淡出：u 从 0（出生）到 1（消亡），sin 包络两头都收干净
    const u = 1 - Math.min(1, Math.max(0, m.life / m.maxLife));
    const env = Math.sin(Math.PI * u);
    if (env <= 0.01) return;
    const sp = Math.hypot(m.vx, m.vy);
    if (sp <= 0.001) return;
    const headR = m.headR;
    const back = sp * m.trailSec;
    const col = starfx.meteorCols[m.hue] || '#ffffff';
    const ux = m.vx / sp, uy = m.vy / sp;
    const tipX = m.x - ux * back, tipY = m.y - uy * back;
    const nx = -uy, ny = ux;                       // 法线：把中心线撑成一条带

    // 拖尾：**一条渐窄多边形 + 沿长度渐变**。
    // 旧版是 80 个实心圆串成的珠子（又粗又断），现在是 1 次 path + 1 次 fill；
    // 桌面端对应的是 1 个 TriangleStrip（原来 80 次 draw call）。
    const n = starfx.meteorSamples;
    const hw = Math.max(0.35, headR * starfx.trailHeadW);
    ctx.beginPath();
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const w = hw * Math.pow(1 - t, 0.7);
        const cx = m.x - ux * back * t + nx * w;
        const cy = m.y - uy * back * t + ny * w;
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    }
    for (let i = n; i >= 0; i--) {
        const t = i / n;
        const w = hw * Math.pow(1 - t, 0.7);
        ctx.lineTo(m.x - ux * back * t - nx * w, m.y - uy * back * t - ny * w);
    }
    ctx.closePath();
    const tg = ctx.createLinearGradient(m.x, m.y, tipX, tipY);
    tg.addColorStop(0, rgba(col, 0.95));
    tg.addColorStop(0.35, rgba(col, 0.42));
    tg.addColorStop(1, rgba(col, 0));
    ctx.fillStyle = tg;
    ctx.globalAlpha = env;
    ctx.fill();
    ctx.globalAlpha = 1;

    // 头部：高亮核 + 柔光球 + 四芒 + 细环（与背景大星、爆圈同一套配方）
    // 收一档 alpha：9×R 的光球全亮会把底下棋盘/顶栏的文字洗白（原来的光晕就压到 0.5）
    drawOrb(m.x, m.y, headR, m.hue, env * 0.72, true);
}

function updateMeteors(dt: number): void {
    if (!ctx) return;
    // 批次调度：每批的颗数 / 铺开时长 / 下一批间隔都随机
    // （20~30 颗铺 15~20 秒，1~1.5 分钟一场 —— 60~90 秒是**批次起点到起点**）。
    // 计时器只在批次间隙走，所以开批时先扣掉本批的铺开时长，否则实际会变成「放完再等 60~90 秒」。
    if (showerLeft <= 0) {
        showerTimer -= dt;
        if (showerTimer <= 0) {
            showerLeft = starfx.showerCountMin +
                Math.floor(Math.random() * (starfx.showerCountMax - starfx.showerCountMin + 1));
            const span = starfx.showerSpanMin + Math.random() * (starfx.showerSpanMax - starfx.showerSpanMin);
            showerGapStep = span / showerLeft;
            showerGap = 0;
            showerTimer = starfx.showerPeriodMin + Math.random() * (starfx.showerPeriodMax - starfx.showerPeriodMin) - span;
        }
    } else {
        showerGap -= dt;
        // 用 while 而不是 if：掉帧时一帧可能跨过好几个间隔，这里一次补足不留空档
        while (showerGap <= 0 && showerLeft > 0) {
            spawnMeteor();
            showerLeft--;
            showerGap += showerGapStep;
        }
    }
    for (let i = meteors.length - 1; i >= 0; i--) {
        const m = meteors[i];
        m.life -= dt;
        // ★ 撞到视口边界就炸一圈，而不是静默消失。
        //   **必须先判边界再看寿命**：maxLife 是按「到出屏点的距离 ÷ 速度」导出的，
        //   寿命归零和越过边界几乎同时发生 —— 先判寿命的话流星会被悄悄删掉、根本不炸，
        //   两条都判又会炸两次。边界这条命中就直接 continue，只炸一次。
        if (m.y >= vh || m.x <= 0 || m.x >= vw) {
            const j = 1 + (Math.random() * 2 - 1) * starfx.rippleJitter;
            const r1 = starfx.rippleR1 * j;
            // 炸点往里收 15% 半径，不然半个环在画外，看着像被切掉
            const cx = Math.min(vw - r1 * 0.15, Math.max(r1 * 0.15, m.x));
            const cy = Math.min(vh - r1 * 0.15, Math.max(r1 * 0.15, m.y));
            spawnRipple(cx, cy, m.hue, r1);
            meteors.splice(i, 1);
            continue;
        }
        if (m.life <= 0) { meteors.splice(i, 1); continue; }   // 数值兜底，正常碰不到
        m.x += m.vx * dt;
        m.y += m.vy * dt;
    }
    for (const m of meteors) drawOneMeteor(m);
}

// ═══ 点爆流星 ═══
// 左键打中流星才炸（不是点哪都炸）：取离点击点最近的、且在命中半径内的那一颗，
// 把它从池里去掉，并在它的位置上炸出一圈扩散环。返回是否真的打中了。
// 命中半径按**这颗星**的头部外半径放宽（rippleHit 倍）—— 星头只有 10-14px，
// 不放宽的话在 1280 宽的屏上几乎点不中。
// 造一个爆圈（点击命中 与 流星撞边界 共用）。r1 由调用方按浮动算好传进来。
function spawnRipple(x: number, y: number, hue: number, r1: number): void {
    ripples.push({
        x, y, life: starfx.rippleLife, maxLife: starfx.rippleLife, hue, r1,
        rot0: Math.random() * Math.PI * 2,
        spin: (Math.random() < 0.5 ? -1 : 1) * starfx.rippleSpin,
    });
    while (ripples.length > MAX_RIPPLES) ripples.shift();
    // 星光数量设 0 时 rAF 可能已经停了 —— 这圈是点击反馈，得把它拉起来
    if (!raf && started && !reduced && !document.hidden) start();
}

function burstMeteorAt(x: number, y: number): boolean {
    let hit = -1;
    let bestD = Infinity;
    for (let i = 0; i < meteors.length; i++) {
        const d = Math.hypot(meteors[i].x - x, meteors[i].y - y);
        if (d <= meteors[i].headR * starfx.rippleHit && d < bestD) { bestD = d; hit = i; }
    }
    if (hit < 0) return false;
    const m = meteors[hit];
    meteors.splice(hit, 1);                       // 炸了就没了
    // 最终半径 = 基准 × (1 ± rippleJitter)，每次都不一样，免得连着点看起来像复读
    const jitter = 1 + (Math.random() * 2 - 1) * starfx.rippleJitter;
    spawnRipple(m.x, m.y, m.hue, starfx.rippleR1 * jitter);
    return true;
}

// 把 #rrggbb 压暗，给「浅色棋盘上的描边」用：流星的配色都是浅的，
// 直接画在浅底上会糊掉，所以环外面再套一圈同色压暗的宽线，深底浅底都能读出来。
function shade(hex: string, k: number): string {
    const r = Math.round(parseInt(hex.slice(1, 3), 16) * k);
    const g = Math.round(parseInt(hex.slice(3, 5), 16) * k);
    const b = Math.round(parseInt(hex.slice(5, 7), 16) * k);
    return `rgb(${r},${g},${b})`;
}

// 画法参考「一颗星炸开」：外扩的细环 + 中心四角星芒 + 白亮核。
// 颜色跟着被点爆那颗流星走（每颗流星一个色），所以同一时刻炸两颗会炸出两种颜色的圈。
function drawRipple(r: Ripple): void {
    if (!ctx) return;
    const t = 1 - Math.max(0, Math.min(1, r.life / r.maxLife));   // 0 → 1
    if (t <= 0 || t >= 1) return;
    const ease = 1 - Math.pow(1 - t, 3);
    const rad = starfx.rippleR0 + (r.r1 - starfx.rippleR0) * ease;
    // 1.1 而不是 1.6：指数越大掉得越快，实测 1.6 到 300ms 就淡到看不见了
    const a = Math.pow(1 - t, 1.1);
    const col = starfx.meteorCols[r.hue] || '#ffffff';
    ctx.strokeStyle = shade(col, 0.66);
    ctx.lineWidth = Math.max(1, starfx.rippleWidth * (1 - 0.55 * t)) + 3.2;
    ctx.globalAlpha = a * 0.30;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, Math.PI * 2); ctx.stroke();
    // 环内填一层淡同色（气泡感）。比头部更淡 —— 这个圈要扫过整个棋盘，
    // 太实会把格子数字盖住。
    ctx.fillStyle = col;
    ctx.globalAlpha = a * starfx.ringFillA * 0.6;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.6, starfx.rippleWidth * (1 - 0.55 * t));
    ctx.globalAlpha = a * 0.95;
    ctx.beginPath(); ctx.arc(r.x, r.y, rad, 0, Math.PI * 2); ctx.stroke();
    // 炸点余晖：柔光球（照片里爆开的星也有这层扩散的光）
    const glowTex = ensureGlowHue(r.hue);
    if (glowTex) {
        const d = r.r1 * 0.95;
        ctx.globalAlpha = a * 0.35;
        ctx.drawImage(glowTex, r.x - d / 2, r.y - d / 2, d, d);
    }
    // 中心四芒：等长细芒（照片里的十字是对称的），随扩散一起收掉
    // 臂长跟**当前**光圈半径走，恒定比它大 18% —— 光圈多大，光芒就多大。
    // 淡出交给下面的 alpha（a），不再靠缩短臂长来收尾。
    const L = rad * starfx.rippleCrossOverRing;
    // 角度按**已过秒数**积分（t 是 0→1 的进度，乘上 maxLife 才是秒），
    // 这样转速是真正的 rad/s，改 rippleLife 不会连带改变观感上的转速。
    const ang = r.rot0 + r.spin * (t * r.maxLife);
    // 线宽按**最终**半径定（不随 L 变），这样臂越长越像发丝，
    // 而不是越涨越粗糊成一团。
    if (L > 1) drawCross(r.x, r.y, L, L, Math.max(0.6, r.r1 * 0.04), a * 0.9, ang);
    // 中心亮核：白色，任何底色上都像个「炸点」
    ctx.globalAlpha = a * 0.95;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(r.x, r.y, Math.max(0.8, 3.2 * (1 - t)), 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
}

function burst(x: number, y: number): void {
    if (!opts.ustcOn) return;   // 「红专并进 理实交融」没勾上就不弹字母
    const baseHue = Math.random() * 360;
    for (let i = 0; i < LETTERS.length; i++) {
        // 四个字母朝上散开；随机色相但围绕一个基准，避免一屏辣眼。
        const spread = (i - 1.5) * 42 + (Math.random() - 0.5) * 26;
        letters.push({
            x, y,
            vx: spread,
            vy: -(120 + Math.random() * 90),
            rot: (Math.random() - 0.5) * 0.5,
            vr: (Math.random() - 0.5) * 2.2,
            ch: LETTERS[i],
            hue: (baseHue + i * 24 + Math.random() * 18) % 360,
            life: LETTER_LIFE,
        });
    }
    // 超上限就丢最旧的：宁可少弹一组，也不让帧率被拖下去。
    while (letters.length > MAX_LETTERS) letters.shift();
    // 星光数量设 0 时 rAF 已经停了，字母是唯一还在动的东西 —— 拉起来。
    if (!raf && started && !reduced && !document.hidden) start();
}

function drawLetter(l: Letter): void {
    if (!ctx) return;
    const t = l.life / LETTER_LIFE;                 // 1 → 0
    ctx.globalAlpha = Math.max(0, Math.min(1, t)) * 0.92;
    ctx.save();
    ctx.translate(l.x, l.y);
    ctx.rotate(l.rot);
    ctx.font = FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // 描一层暗边：白底下字母仍能看清（游戏面板本身是浅色的）。
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(30, 42, 58, 0.55)';
    ctx.strokeText(l.ch, 0, 0);
    ctx.fillStyle = `hsl(${l.hue.toFixed(1)} 85% 62%)`;
    ctx.fillText(l.ch, 0, 0);
    ctx.restore();
}

function step(dt: number): void {
    // 星光：飘出上边缘或左右超出太多就回收到底部重生成，数量恒定。
    for (let i = 0; i < sparks.length; i++) {
        const s = sparks[i];
        const prevX = s.x, prevY = s.y;
        s.x0 += s.vx * dt;
        s.y += s.vy * dt;
        s.ph += s.sp * dt;
        // 摇摆在绘制时算，不累加进坐标：累加会把 sin 的误差一路攒下去
        s.x = s.x0 + s.amp * Math.sin(fxTime * s.omega + s.swPhase);
        if (s.y < -12 || s.x < -40 || s.x > vw + 40) { sparks[i] = newSpark(false); continue; }
        s.hx.unshift(prevX); s.hy.unshift(prevY);
        if (s.hx.length > starfx.trailFrames) { s.hx.pop(); s.hy.pop(); }
        if (s.hn < starfx.trailFrames) s.hn++;
    }
    for (let i = letters.length - 1; i >= 0; i--) {
        const l = letters[i];
        l.life -= dt;
        if (l.life <= 0) { letters.splice(i, 1); continue; }
        // 轻微阻尼：字母越飞越慢，最后几乎是「浮住淡出」，比匀速更柔和。
        l.vx *= (1 - 1.1 * dt);
        l.vy *= (1 - 0.55 * dt);
        l.x += l.vx * dt;
        l.y += l.vy * dt;
        l.rot += l.vr * dt;
    }
    for (let i = ripples.length - 1; i >= 0; i--) {
        const r = ripples[i];
        r.life -= dt;
        if (r.life <= 0) ripples.splice(i, 1);
    }
}

function frame(now: number): void {
    // dt 封顶：切后台回来 / 断点调试会攒出一个巨大的 dt，
    // 不封顶的话粒子会瞬移、字母一次全消失。
    const dt = Math.min(starfx.dtCap, Math.max(0, (now - last) / 1000));
    last = now;
    if (!ctx) { raf = 0; return; }
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, vw, vh);
    fxTime += dt;
    step(dt);
    for (const s of sparks) drawSpark(s);
    // 与旧版一致：星光数量设 0 时连流星雨一起关掉（「整层关闭」的语义）
    if (sparks.length > 0) updateMeteors(dt);
    for (const r of ripples) drawRipple(r);
    for (const l of letters) drawLetter(l);
    ctx.globalAlpha = 1;
    // 没星、没字母、没有还在扩散的环就别空转；burst/ripple 会重新拉起。
    if (sparks.length === 0 && letters.length === 0 && ripples.length === 0) { raf = 0; return; }
    raf = requestAnimationFrame(frame);
}

function start(): void {
    if (raf) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
}

function stop(): void {
    if (!raf) return;
    cancelAnimationFrame(raf);
    raf = 0;
}

// 密度 → 实际颗数：密度单位是「每 100×100 CSS 像素多少颗」，用视口 CSS 像素面积（逻辑尺寸）。
// 设置面板也要显示同一口径，所以导出（renderer 只用它算读数，不碰粒子）。
export function starCountForDensity(density: number): number {
    if (density <= 0) return 0;
    const w = vw || window.innerWidth || 1;
    const h = vh || window.innerHeight || 1;
    const unitArea = starfx.starUnitPx * starfx.starUnitPx;
    return Math.min(starfx.starPoolMax, Math.round(density * w * h / unitArea));
}

function effectiveStarCount(): number {
    return starCountForDensity(opts.starDensity);
}

// 数量变化时只补/砍差额，其余粒子保留（避免整屏闪一下重铺）。
// 视口尺寸变了则整池重铺：否则旧星全留在原区域，会短暂呈现「星数没变、密度变了」。
function syncPool(): void {
    const target = effectiveStarCount();
    if (vw !== poolW || vh !== poolH) {
        poolW = vw;
        poolH = vh;
        sparks.length = 0;
        meteors.length = 0;
    }
    if (target <= 0) {
        sparks.length = 0;
        meteors.length = 0;
        showerLeft = 0;
        showerTimer = starfx.showerInit;
        return;
    }
    while (sparks.length < target) sparks.push(newSpark(true));
    if (sparks.length > target) sparks.length = target;
}

/** 装好特效层。幂等：调多次只生效一次。 */
export function initFx(): void {
    if (started) return;
    started = true;

    // 系统级「减弱动效」优先：这类用户要的是**屏幕别自己动**，
    // 打折版（只关掉飘动）仍然是动，所以整层不启用，连 canvas 都不建。
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        reduced = true;
        return;
    }

    // 从持久化设置起步（不依赖 game.ts 的调用时机）。密度 0 = 整层不建画布。
    const cfg = loadSettings();
    opts.ustcOn = cfg.ustcMode;
    opts.starDensity = cfg.starDensity;
    opts.starScale = cfg.starScale;
    if (cfg.starDensity <= 0 && !opts.ustcOn) return;

    canvas = document.getElementById('fx') as HTMLCanvasElement | null;
    if (!canvas) return;                       // 页面没留这块画布：安静地不启用
    ctx = canvas.getContext('2d');
    if (!ctx) return;

    resize();
    syncPool();

    window.addEventListener('resize', resize);
    // 后台标签页不值得继续画：省下 CPU/电量，回前台再无缝接上。
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) stop(); else start();
    });

    // ★ 只读事件、不改事件：下面这两行里绝不能出现 preventDefault / stopPropagation。
    window.addEventListener('pointerdown', (e: PointerEvent) => {
        // 只认鼠标：触摸/笔的 button 语义不同（长按、双击缩放的连点会乱弹字母）。
        if (e.pointerType !== 'mouse') return;
        if (e.button !== 0 && e.button !== 2) return;   // 左键 / 右键
        // 左键：**只有打中流星才炸**（点空地什么都不发生，免得每次翻格子都闪一圈）。
        // 打中时把这一击吞掉 —— 否则炸圈的同一击还会翻开底下的格子 / 点中底下的按钮。
        // 没打中一律原样放行，所以翻格、插旗、滑块全都不受影响。
        if (e.button === 0 && burstMeteorAt(e.clientX, e.clientY)) {
            e.preventDefault();
            e.stopPropagation();
        }
        burst(e.clientX, e.clientY);
    }, { capture: true });

    start();
}

/** 由 game.ts 在设置改动时推实时值进来；initFx 之前调用也安全（只存，不动池）。 */
export function updateFx(partial: Partial<{ ustcOn: boolean; starDensity: number; starScale: number }>): void {
    if (typeof partial.ustcOn === 'boolean') opts.ustcOn = partial.ustcOn;
    if (typeof partial.starScale === 'number') opts.starScale = partial.starScale;
    if (typeof partial.starDensity === 'number' && partial.starDensity !== opts.starDensity) {
        opts.starDensity = partial.starDensity;
        if (!started || !ctx) return;           // 还没 init：initFx 会用最终值铺池
        syncPool();
        // 从 0 调回来时 rAF 可能已经停了，拉起来；调到 0 且没有字母就让它自己停。
        if (effectiveStarCount() > 0 && !document.hidden) start();
    }
}
