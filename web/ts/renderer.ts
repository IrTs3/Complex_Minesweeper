// 渲染器：1:1 移植桌面端 src/desktop/Renderer.cpp
// 所有几何常量、颜色、字符串均与桌面端一致；SFML 的描边为"内描边"，
// Canvas 用 strokeRect 内缩 thickness/2 复现。

import {
    Ctx, Col, Rect, C, css, mix, R, inside, shifted,
    kWindowBg, kPanel, kHover, kOpened, kOpenedZero, kOpenedCancel, kGridLine,
    kRealHint, kImagHint, kMixHint, kZeroHint, kRealMine, kImagMine,
    kBadMark, kBoomBg, kBadFlagBg, kInk, kInkSoft, kBtnBg, kBtnEdge, kBtnActive,
    kBarFill, kUstcGray,
    fontFor, textWidth, drawTL, drawTLFit, drawC, fillRect, box, circle, thickLine, arc,
    inkAlignDy,
    radicalSign, gear, checkMark, cancelZero, fmt3, mineGlyph, mineColor, scrollbar, ScrollGeo,
    squaredMagnitude, largestSquareFactor, formatHintSigned, hintKind, HintKind
} from './ui.js';
import { buildHelp, HelpRow } from './help.js';
import { starCountForDensity } from './fx.js';
import { kAnimMs, animOn, easeOutBack, easeInOut } from './anim.js';
import { SettingsData, kBgAlphaMax, kDoubleClickMinMs, kDoubleClickMaxMs,
    kStarDensityMin, kStarDensityMax, kStarScaleMin, kStarScaleMax } from './settings.js';
import { MineType, Phase, Cell, BoardView } from './types.js';

export enum HeaderAction {
    None, Restart, PlayAgain, Easy, Medium, Hard, Custom, Seed, Ustc,
    HideCounts, AlwaysMagnitude, Settings, Help
}
export enum OverlayHit { None, SameRound, NewGame }
export enum SeedStage { None, Menu, Load, Confirm }
export enum SeedHit { None, MenuCopy, MenuSave, MenuLoad, MenuTool, Box, Paste, Ok, Cancel, Yes, No, Outside }
export enum SettingsHit {
    None, Outside, Close, BrowseBg, ResetBg,
    Field1, Field2, Field3, Field4, Browse1, Browse2, Browse3, Browse4,
    Clear1, Clear2, Clear3, Clear4,
    HexField, FieldR, FieldG, FieldB, ResetColor, RestoreAll,
    ChordSilent, ChordHint, ChordBoom, DcTrack, DcValue,
    StarTrack, ScaleTrack,
    BlankField, BlankBrowse, BlankClear,
    StarValue, ScaleValue, // 星光数值框追加在末尾：前面的枚举值有区间判断，不能插队
    BgField,              // 背景色输入框（同样只能追加在末尾）
    AnimToggle            // 动效总开关（同样只能追加在末尾）
}
export enum SetupAction { None, Start, Cancel }
export enum ConfirmHit { None, Yes, Cancel, Outside }
export enum ConfirmKind { None, RestoreAll, Restart, Switch }

export interface Hud {
    remaining: number;
    seconds: number;
    phase: Phase;
    paused: boolean;
}

export interface Layout {
    winW: number; winH: number; cell: number; pitch: number;
    boardW: number; boardH: number; boardX: number; boardY: number; headerH: number;
    /** 内容块顶端（标题栏随它一起上下居中，见 computeLayout） */
    headerTop: number;
    /** 顶栏左右两侧的锚点 x（对齐棋盘边缘，见 computeLayout） */
    sideX: number;
    restartBtn: Rect; hardBtn: Rect; mediumBtn: Rect; easyBtn: Rect;
    settingsBtn: Rect; seedBtn: Rect; customBtn: Rect; playAgainBtn: Rect;
    gearCX: number; gearCY: number;
    helpBtn: Rect; helpPanel: Rect; setPanel: Rect;
    bgValue: Rect; bgTrack: Rect;
    /** 顶栏等比缩放系数（1 = 设计尺寸）。绘制时 ctx.scale(hs)，命中时 absTop 里乘 hs */
    hs: number;
    /** 顶栏的设计宽（已把取整误差吸附回 620）。绘制和布局必须用同一个值，别再各自除一遍 */
    hw: number;
}

const kGap = 3, kPad = 12, kCellMax = 40, kCellMin = 24;

// 背景的三种形态都塞在 SettingsData.background.dataUrl 里（不新增字段，两端 ini/JSON 格式不变）：
//   ''          → 内置图片
//   '#rrggbb'   → 纯色
//   其它        → 自定义图片（dataUrl / 桌面端的配置目录文件名）
// 这个函数只认第二种，其它一律返回 null。
export function parseBgHex(s: string): Col | null {
    if (!s || s[0] !== '#' || s.length !== 7) return null;
    const n = parseInt(s.slice(1), 16);
    if (isNaN(n)) return null;
    return C((n >> 16) & 255, (n >> 8) & 255, n & 255);
}
// 顶栏高度（局部坐标，不含 headerTop）。
//
// ⚠️ 这个值以前是 138，**比内容矮**：药丸被硬编码在 y=116、高 28px，铺到 144
// ——既冲出顶栏，又压住统计行（y=111）与进度条（y=127）。
// 截图才看出来：窄屏下 "MINES LEFT / TIME" 压在 "16x16 opened 0/21 …" 上面。
//
// 现在的行位见下方 kRow。五行的总高 = row5y + 复选框高 + 下留白。
// **改动任何一行的高度时这里要重算**，否则又会重演"顶栏比内容矮"。
const kHeaderH = 204;
/** 顶栏内容的大致宽度（标题 + 帮助键 + 右侧一排按钮）。只用于左右对齐，不参与命中判定。 */
const kHeaderContentW = 620;
const kMenuW = 128, kMenuItemH = 30;

// 顶栏各行的 y（局部坐标）。**唯一的行位来源**——绘制与命中都从这里取，
    // 不要在任何地方写死 y，否则会重演「药丸写死 116、冲出顶栏 138」那个 bug。
    //
    // 排布（自上而下，每行左右各一组，**行内互不重叠是硬约束**）：
    //   row1y= 16  左：标题 + 帮助键        右：难度键排 / 重开   （高 34）
    //   row2y= 54  左：药丸 MINES LEFT/TIME 右：CUSTOM/SEED/齿轮 （高 28）
    //   row3y= 94  左：图例                 右：计数芯片 ±1/±i（窄屏时芯片换行到此行）
    //   row4y=118  左：OPACITY 标签 + 数字框 + 滑块（trackY=128）   （高 26）
    //   row5y=150  左：统计文字 + 进度条（barY=170）                （高 18）
    //   row6y=176  左：三个复选框（独占整行）                （高 16）
    //
    // 为什么复选框独占一行（以前它和统计文字同在 row5）：
    // 左右两组并排需要「统计文字」+「复选框组」≈ 780px 才不撞，
    // 而窄屏顶栏只有 620px —— 实测 statRow 与三个复选框 label 重叠 16px。
    // 拆成两行后每行都在预算内，且不牺牲任何功能（背景不透明度滑块不能移进设置面板，
    // 那边没有这个项）。
    //
    // 宽度与重叠由 web/test/header-overlap.mjs 实测多个尺寸把关，改行位后务必重跑。
    const kRow = {
    row1y: 16,
    row2y: 54,
    row3y: 94,      // 图例行（芯片窄屏换行也落这里）
    row4y: 118,     // OPACITY 行
    trackY: 128,
    statY: 150,     // 统计文字行
    barY: 170,      // 进度条
    checkY: 176,    // 三个复选框行（独占）
    /** 药丸所在行 */
    pillY: 54,
    /** 芯片在 row2 放不下时的换行位置（与图例同行，图例会为其让位） */
    chipWrapY: 94,
};
/** 桌面端内置的默认背景（洛天依《云上城堡》） */
// 内置背景改走 WebP（209,838 → 81,950 B，省 128 KB；WebP 已压缩，gzip 无额外增益）。
// jpg 原图保留作为兜底：老浏览器不支持 WebP 时由 onerror 回退。
export const kDefaultBg = 'assets/bg.webp';
const kDefaultBgFallback = 'assets/bg.jpg';

// —— SetupConfig：移植 src/core/SetupConfig.h ——
export class SetupConfig {
    rows = 16; cols = 16;
    maxRows = 40; maxCols = 40;
    total = 40; realCount = 20; imagCount = 20;
    splitManual = false;

    copyFrom(o: SetupConfig): void {
        this.rows = o.rows; this.cols = o.cols;
        this.maxRows = o.maxRows; this.maxCols = o.maxCols;
        this.total = o.total; this.realCount = o.realCount; this.imagCount = o.imagCount;
        this.splitManual = o.splitManual;
    }
    capacity(): number { return Math.max(1, this.rows * this.cols - 1); }
    mines(): number { return this.splitManual ? this.realCount + this.imagCount : this.total; }
    clampToBoard(): void {
        this.rows = clampI(this.rows, 5, Math.max(5, this.maxRows));
        this.cols = clampI(this.cols, 5, Math.max(5, this.maxCols));
        const cap = this.capacity();
        this.total = clampI(this.total, 1, cap);
        this.realCount = clampI(this.realCount, 0, cap);
        this.imagCount = clampI(this.imagCount, 0, cap);
        if (this.splitManual) {
            if (this.realCount + this.imagCount > cap) {
                if (this.realCount >= cap) { this.realCount = cap; this.imagCount = 0; }
                else this.imagCount = cap - this.realCount;
            }
            if (this.realCount + this.imagCount < 1) this.realCount = 1;
            this.total = this.realCount + this.imagCount;
        }
    }
    setTotal(t: number): void { this.splitManual = false; this.total = t; this.clampToBoard(); }
    setReal(v: number): void { this.splitManual = true; this.realCount = v; this.clampToBoard(); this.total = this.realCount + this.imagCount; }
    setImag(v: number): void { this.splitManual = true; this.imagCount = v; this.clampToBoard(); this.total = this.realCount + this.imagCount; }
}

function clampI(v: number, lo: number, hi: number): number { return v < lo ? lo : (v > hi ? hi : v); }
function clampF(v: number, lo: number, hi: number): number { return v < lo ? lo : (v > hi ? hi : v); }
/** 命中区外扩（**只扩判定，不改绘制**）：触摸端 26px 的按钮点不准，鼠标端 pad=0 → 与原来逐一相同 */
function insidePad(r: Rect, px: number, py: number, pad: number): boolean {
    return pad === 0 ? inside(r, px, py) : inside(R(r.x - pad, r.y - pad, r.w + 2 * pad, r.h + 2 * pad), px, py);
}

export class Renderer {
    private ctx: Ctx;
    private canvas: HTMLCanvasElement;
    L: Layout;
    board: BoardView;
    cfg: SettingsData;

    // —— 通用状态 ——
    private mousePx_ = { x: -999, y: -999 };
    private lastTs_ = 0;
    playAgainVisible_ = false;
    private overlayHidden_ = false;
    private hideCounts_ = false;
    private alwaysMagnitude_ = false;
    private ustcMode_ = false;
    private diffIdx_ = 1;
    private activeDiff_ = 1;

    // —— 触摸设备（coarse pointer）——
    // 只影响布局与命中区，**不改任何绘制样式**：桌面端 coarse_ 恒为 false，
    // 走的是与改动前逐像素相同的分支。
    private coarse_ = false;
    private coarseOverride_: boolean | null = null;
    private detectCoarse(): boolean {
        try { return window.matchMedia('(pointer: coarse)').matches; } catch { return false; }
    }
    /** 传 null = 交回自动探测；传 true/false = 钉死（测试用） */
    setCoarsePointer(v: boolean | null): void { this.coarseOverride_ = v; this.coarse_ = v === null ? this.detectCoarse() : v; }
    coarsePointer(): boolean { return this.coarse_; }

    // —— 棋盘视图变换（触摸缩放/平移）——
    // 屏幕坐标 = 世界坐标 * s + t。桌面端恒为 {1,0,0}，cellAt 的逆变换退化为恒等。
    private view_ = { s: 1, tx: 0, ty: 0 };

    // —— 动效状态（全部时间戳用 performance.now 口径，即 draw 的 nowMs）——
    // revealAt_[i]：i 格翻开画面的起点时间（数据早已翻开，只是显示错峰）；0 = 无动画
    private revealAt_: Float64Array | null = null;
    private prevOpen_: Uint8Array | null = null;
    private prevFlag_: Uint8Array | null = null;
    private flagAt_: Float64Array | null = null;
    private animCols_ = 0;
    private animRows_ = 0;
    /** 本帧内 game 报告的「开格动作起点」（波前 BFS 的圆心） */
    private revealOrigin_: { r: number; c: number } | null = null;
    private dying_: { r: number; c: number; t: number; at: number }[] = [];
    private ripples_: { x: number; y: number; t: number }[] = [];
    private nowMs_ = 0;
    private counterFlip_: { from: number; t: number } | null = null;
    private lastRemaining_ = -1;   // -1 = 尚未同步（首帧不播翻牌）
    private loss_: { t: number; or: number; oc: number } | null = null;
    private win_: { t: number; pts: { x: number; y: number }[] } | null = null;
    private phaseSeen_: Phase | null = null;
    private neighborLit_: Uint8Array | null = null;

    /** 新局/载入种子后调用：清空全部动效并把快照对齐到当前棋盘（恢复进度不播动画） */
    resetAnims(): void {
        this.revealAt_ = null; this.prevOpen_ = null; this.prevFlag_ = null;
        this.flagAt_ = null; this.neighborLit_ = null;
        this.dying_.length = 0; this.ripples_.length = 0;
        this.counterFlip_ = null; this.lastRemaining_ = -1;
        this.loss_ = null; this.win_ = null; this.phaseSeen_ = null;
        this.revealOrigin_ = null;
    }

    /** 开格动作发生前由 game 调用：波前以这个格子为圆心荡开 */
    noteRevealOrigin(r: number, c: number): void { this.revealOrigin_ = { r, c }; }

    /** 棋盘视口内按下：记录一圈点击涟漪（窗口坐标） */
    addRipple(x: number, y: number): void {
        this.ripples_.push({ x, y, t: performance.now() });
        if (this.ripples_.length > 12) this.ripples_.shift();
    }

    // ----------------------------------------------------------------
    //  动效核心：每帧开头做一次 diff / 终局捕获 / 邻域预亮计算
    // ----------------------------------------------------------------

    private syncAnims(hud: Hud, nowMs: number): void {
        const rows = this.board.rows(), cols = this.board.cols();
        const n = rows * cols;
        const on = animOn(this.cfg.animFx);
        if (!this.prevOpen_ || !this.prevFlag_ || !this.revealAt_ || !this.flagAt_ || !this.neighborLit_
            || this.animCols_ !== cols || this.animRows_ !== rows) {
            // 尺寸变了（或 resetAnims 清过）：重建快照，对齐到当前棋盘、不播任何动画
            this.animCols_ = cols; this.animRows_ = rows;
            this.prevOpen_ = new Uint8Array(n);
            this.prevFlag_ = new Uint8Array(n);
            this.revealAt_ = new Float64Array(n);
            this.flagAt_ = new Float64Array(n);
            this.neighborLit_ = new Uint8Array(n);
            for (let r = 0; r < rows; ++r)
                for (let c = 0; c < cols; ++c) {
                    const cell = this.board.at(r, c);
                    const i = r * cols + c;
                    this.prevOpen_[i] = cell.opened ? 1 : 0;
                    this.prevFlag_[i] = cell.flag;
                }
            this.lastRemaining_ = hud.remaining;
            this.phaseSeen_ = hud.phase;
            return;
        }
        const po = this.prevOpen_, pf = this.prevFlag_, ra = this.revealAt_, fa = this.flagAt_;
        // 开格 diff → 波前：以 origin 为圆心在「本帧新开集合」内 BFS，距离 × waveStep = 每格延迟
        let newCells: number[] | null = null;
        for (let r = 0; r < rows; ++r) {
            for (let c = 0; c < cols; ++c) {
                const cell = this.board.at(r, c);
                const i = r * cols + c;
                if (cell.opened && !po[i]) (newCells ??= []).push(i);
                po[i] = cell.opened ? 1 : 0;
                const f = cell.flag;
                if (f !== pf[i]) {
                    if (on) {
                        if (f !== MineType.None) fa[i] = nowMs;
                        else if (pf[i] !== 0) {
                            this.dying_.push({ r, c, t: pf[i], at: nowMs });
                            if (this.dying_.length > 32) this.dying_.shift();
                        }
                    }
                    pf[i] = f;
                }
            }
        }
        if (newCells && newCells.length > 0 && on) {
            const marked = new Uint8Array(n);
            for (const i of newCells) marked[i] = 1;
            const o = this.revealOrigin_;
            let seed = -1;
            if (o && o.r >= 0 && o.c >= 0 && o.r < rows && o.c < cols && marked[o.r * cols + o.c])
                seed = o.r * cols + o.c;
            if (seed < 0) {
                // origin 不在新集合里（chord 起点/已被开过）：取离它最近的新格当圆心
                let best = Infinity;
                for (const i of newCells) {
                    const r = (i / cols) | 0, c = i % cols;
                    const d = o ? (r - o.r) * (r - o.r) + (c - o.c) * (c - o.c) : 0;
                    if (d < best) { best = d; seed = i; }
                }
            }
            if (seed >= 0) {
                const dist = new Int32Array(n).fill(-1);
                const q: number[] = [seed];
                dist[seed] = 0;
                for (let h = 0; h < q.length; ++h) {
                    const i = q[h], r = (i / cols) | 0, c = i % cols;
                    for (let dr = -1; dr <= 1; ++dr) for (let dc = -1; dc <= 1; ++dc) {
                        if (!dr && !dc) continue;
                        const rr = r + dr, cc = c + dc;
                        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
                        const j = rr * cols + cc;
                        if (!marked[j] || dist[j] >= 0) continue;
                        dist[j] = dist[i] + 1;
                        q.push(j);
                    }
                }
                for (const i of q) ra[i] = nowMs + dist[i] * kAnimMs.waveStep;
            }
        }
        this.revealOrigin_ = null;
        // 邻域预亮：悬停格的 8 邻域微微提亮（仅对局中、无面板时）
        const lit = this.neighborLit_;
        lit.fill(0);
        const hov = this.hoveredCell();
        if (on && hud.phase === Phase.Playing && hov && !this.helpOpen_ && !this.settingsOpen_
            && !this.setupOpen_ && !this.confirmOpen_ && this.seedStage_ === SeedStage.None
            && !this.menuIsOpen()) {
            for (let dr = -1; dr <= 1; ++dr) for (let dc = -1; dc <= 1; ++dc) {
                if (!dr && !dc) continue;
                const rr = hov.r + dr, cc = hov.c + dc;
                if (rr >= 0 && cc >= 0 && rr < rows && cc < cols) lit[rr * cols + cc] = 1;
            }
        }
        // 终局捕获（只在 Playing → 结束 的那一帧记一次）
        if (this.phaseSeen_ !== hud.phase) {
            if (on && this.phaseSeen_ === Phase.Playing && hud.phase === Phase.Lost) this.captureLoss(nowMs);
            else if (on && this.phaseSeen_ === Phase.Playing && hud.phase === Phase.Won) this.captureWin(nowMs);
            this.phaseSeen_ = hud.phase;
        }
        // 剩余雷数翻牌
        if (hud.remaining !== this.lastRemaining_) {
            if (this.lastRemaining_ >= 0 && on) this.counterFlip_ = { from: this.lastRemaining_, t: nowMs };
            this.lastRemaining_ = hud.remaining;
        }
        if (this.counterFlip_ && nowMs - this.counterFlip_.t > kAnimMs.counterFlip) this.counterFlip_ = null;
    }

    /** -1 = 波前未到（仍画未开样式）；0..1 = 入场进度；1 = 完成/无动画 */
    private revealOf(idx: number, nowMs: number): number {
        const t0 = this.revealAt_ ? this.revealAt_[idx] : 0;
        if (!t0 || !animOn(this.cfg.animFx)) return 1;
        if (nowMs < t0) return -1;
        const p = (nowMs - t0) / kAnimMs.revealPop;
        return p >= 1 ? 1 : p;
    }

    private captureLoss(nowMs: number): void {
        const rows = this.board.rows(), cols = this.board.cols();
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c) {
                const cell = this.board.at(r, c);
                if (cell.opened && cell.exploded) { this.loss_ = { t: nowMs, or: r, oc: c }; return; }
            }
        // 找不到爆点就不播显形动画（数据异常时宁可没有动效，也不能把雷藏住）
        this.loss_ = null;
    }

    private captureWin(nowMs: number): void {
        const rows = this.board.rows(), cols = this.board.cols();
        const pts: { x: number; y: number }[] = [];
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c)
                if (this.board.at(r, c).mine !== MineType.None)
                    pts.push({
                        x: this.L.boardX + c * this.L.pitch + this.L.cell / 2,
                        y: this.L.boardY + r * this.L.pitch + this.L.cell / 2
                    });
        if (pts.length < 2) { this.win_ = null; return; }
        // 绕质心按极角排序：连线是一条不自交倾向的星形环，而不是乱麻
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p.x; cy += p.y; }
        cx /= pts.length; cy /= pts.length;
        pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
        this.win_ = { t: nowMs, pts };
    }

    /** 失败雷区显形：该格的雷点当前应画出的 alpha（0=还没轮到） */
    private lossAlpha(r: number, c: number, nowMs: number): number {
        if (!this.loss_ || !animOn(this.cfg.animFx)) return 1;
        const d = Math.max(Math.abs(r - this.loss_.or), Math.abs(c - this.loss_.oc));
        const s = this.loss_.t + d * kAnimMs.lossStep;
        if (nowMs < s) return 0;
        const p = (nowMs - s) / kAnimMs.lossPop;
        return p >= 1 ? 1 : p;
    }

    /** 错标抖动：失败后短时间内水平往复、幅度衰减 */
    private shakeDx(nowMs: number): number {
        if (!this.loss_) return 0;
        const age = nowMs - this.loss_.t;
        if (age < 0 || age > kAnimMs.shake) return 0;
        return Math.sin(age / 26) * 2.6 * (1 - age / kAnimMs.shake);
    }

    /** 亚克力质感渐变（未开格顶部高光 + 底部内阴影），随格子尺寸缓存 */
    private acrylicGrad_: CanvasGradient | null = null;
    private acrylicCell_ = 0;
    private acrylic(): CanvasGradient {
        if (!this.acrylicGrad_ || this.acrylicCell_ !== this.L.cell) {
            const g = this.ctx.createLinearGradient(0, 0, 0, this.L.cell);
            g.addColorStop(0, 'rgba(255,255,255,0.30)');
            g.addColorStop(0.32, 'rgba(255,255,255,0.05)');
            g.addColorStop(0.72, 'rgba(0,0,0,0)');
            g.addColorStop(1, 'rgba(20,30,50,0.12)');
            this.acrylicGrad_ = g;
            this.acrylicCell_ = this.L.cell;
        }
        return this.acrylicGrad_;
    }

    /** 未开格底：纯色块 + 亚克力高光 + 邻域预亮 */
    private coveredBox(rect: Rect, fill: Col, edge: Col, idx: number): void {
        const ctx = this.ctx;
        box(ctx, rect, fill, edge, 1);
        ctx.save();
        ctx.translate(rect.x, rect.y);
        ctx.fillStyle = this.acrylic();
        ctx.fillRect(0, 0, this.L.cell, this.L.cell);
        ctx.restore();
        if (this.neighborLit_ && this.neighborLit_[idx]) fillRect(ctx, rect, C(255, 255, 255, 14));
    }
    boardView(): { s: number; tx: number; ty: number } { return this.view_; }
    setBoardView(s: number, tx: number, ty: number): void {
        this.view_.s = s; this.view_.tx = tx; this.view_.ty = ty;
    }
    resetBoardView(): void { this.view_ = { s: 1, tx: 0, ty: 0 }; }
    /** 缩放时棋盘可活动的窗口区域（顶栏以下），既是裁剪框也是平移钳制框 */
    boardViewport(): Rect {
        const top = this.L.headerTop + this.L.headerH;
        return R(0, top, this.L.winW, Math.max(0, this.L.winH - top));
    }
    /** 把视图钳到「放大后棋盘必须盖满可视区」，防止拖出空白边 */
    clampBoardView(): void {
        const v = this.view_, vp = this.boardViewport(), L = this.L;
        if (v.s <= 1.0001) { this.resetBoardView(); return; }
        const axis = (world: number, size: number, vpStart: number, vpSize: number): [number, number] => {
            const scaled = size * v.s;
            const base = vpStart - world * v.s;      // tx 的上界：棋盘左/上边不越过可视区起点
            if (scaled <= vpSize) return [base + (vpSize - scaled) / 2, base + (vpSize - scaled) / 2];
            return [base + vpSize - scaled, base];   // 比可视区大：两端都不许露白
        };
        const [minTx, maxTx] = axis(L.boardX, L.boardW, vp.x, vp.w);
        const [minTy, maxTy] = axis(L.boardY, L.boardH, vp.y, vp.h);
        v.tx = clampF(v.tx, minTx, maxTx);
        v.ty = clampF(v.ty, minTy, maxTy);
    }

    // —— 右键标记菜单 ——
    private menuOpen_ = false;
    private menuRect_ = R(0, 0, 0, 0);
    private menuCell_ = { r: -1, c: -1 };
    private menuIndex_ = 0;
    private menuOptions_ = [MineType.Plus1, MineType.Minus1, MineType.PlusI, MineType.MinusI, MineType.None];

    // —— 背景不透明度 ——
    private bgDrag_ = false;
    private setupFocus_ = 0;      // 4 = OPACITY 数字框
    private setupEditBackup_ = 0;

    // —— 种子 UI ——
    seedStage_ = SeedStage.None;
    private seedMenuRect_ = R(0, 0, 0, 0);
    private seedMenuItem_ = 0;
    private seedMenuHover_ = -1;
    private seedCopyEnabled_ = false;
    private seedShort_ = '';
    private seedSaveHint_ = '';
    private seedDialog_ = R(0, 0, 0, 0);
    private seedBox_ = R(0, 0, 0, 0);
    private seedConfirm_ = R(0, 0, 0, 0);
    private seedOwLine1_ = '';
    private seedOwLine2_ = '';
    seedInput_ = '';
    private seedCaret_ = 0;
    private seedSelAnchor_ = -1;
    private seedScroll_ = 0;
    private seedBoxMenuOpen_ = false;
    private seedBoxMenuRect_ = R(0, 0, 0, 0);
    private seedBoxMenuIndex_ = 2;
    private seedNote_ = '';
    seedNoteClock_ = 0;

    // —— 设置面板 ——
    settingsOpen_ = false;
    private settingsFocus_ = 0;   // 1..4 标记字符, 5 hex, 6..8 RGB, 9 双击ms, 10 空白格
    private settingsEdit_ = '';
    private settingsScroll_ = 0;
    private settingsDrag_ = false;
    private dragWhich_ = 1;   // 当前正在拖的是哪条滑块：1=双击 2=星光密度 3=星光大小
    private settingsScrollDragging_ = false;
    private settingsGrabOff_ = 0;
    private settingsGeo_: ScrollGeo = { ok: false, track: R(0, 0, 0, 0), thumb: R(0, 0, 0, 0), viewTop: 0, viewH: 0, maxS: 0 };

    // —— 自定义局面面板 ——
    setupOpen_ = false;
    setupCfg_ = new SetupConfig();
    private setupEdit2_ = '';
    private setupDrag_ = 0;

    // —— 帮助面板 ——
    helpOpen_ = false;
    private helpRows_: HelpRow[] = [];
    private helpTotalH_ = 0;
    private helpBuilt_ = false;
    private helpScroll_ = 0;
    private helpDragging_ = false;
    private helpGrabOff_ = 0;
    private helpGeo_: ScrollGeo = { ok: false, track: R(0, 0, 0, 0), thumb: R(0, 0, 0, 0), viewTop: 0, viewH: 0, maxS: 0 };

    // —— 二次确认 ——
    confirmOpen_ = false;
    confirmKind_ = ConfirmKind.None;
    private confirmWhat_ = '';
    private confirmPanel_ = R(0, 0, 0, 0);

    // —— 黄 0 首现教学（与桌面端 Renderer 同款）：首次揭开黄 0 → 闪烁 1.5s → 一次性解释弹窗 ——
    // seen 记忆在 game 层（localStorage），这里只管表现与点击路由。
    zeroTipPhase_: 0 | 1 | 2 = 0;        // 0 无 / 1 闪烁中 / 2 弹窗
    private zeroTipT0_ = 0;
    private zeroTipPanel_ = R(0, 0, 0, 0);

    // —— 计数芯片闪烁 ——
    private chipFlash_ = [0, 0, 0];
    private lastChip_ = [0, 0];
    private chipHadValue_ = false;

    // —— 图片缓存 ——
    private bgImg_: HTMLImageElement | null = null;
    private bgImgSrc_ = '';
    private markerImgs_: (HTMLImageElement | null)[] = [null, null, null, null, null];
    private markerSrcs_: string[] = ['', '', '', '', ''];
    private blankImg_: HTMLImageElement | null = null;
    private blankSrc_ = '';

    constructor(canvas: HTMLCanvasElement, board: BoardView, cfg: SettingsData) {
        this.canvas = canvas;
        const c = canvas.getContext('2d');
        if (!c) throw new Error('no 2d context');
        this.ctx = c;
        this.board = board;
        this.cfg = cfg;
        this.hideCounts_ = cfg.hideCounts;
        this.alwaysMagnitude_ = cfg.alwaysMagnitude;
        this.ustcMode_ = cfg.ustcMode;
        // coarse pointer = 手指/触控笔（手机、iPad 都命中），鼠标/触控板为 false。
        // 必须在第一次 computeLayout 之前定下来：它决定棋盘是顶部对齐还是居中。
        try { this.coarse_ = window.matchMedia('(pointer: coarse)').matches; } catch { this.coarse_ = false; }
        this.L = this.computeLayout(canvas.width, canvas.height);
    }

    // ================================================================
    //  布局
    // ================================================================

    /** headerH 默认用设计高度；computeLayout 会传**真实画出来的顶栏高**（已乘 hs）进来。
     *  两者不一致时，多扣的那几十像素就是白白丢掉的棋盘高度 —— 见 computeLayout 的不动点迭代。 */
    cellSizeFor(cols: number, rows: number, mxW: number, mxH: number, headerH: number = kHeaderH): number {
        const byW = (mxW - 2 * kPad + kGap) / cols - kGap;
        const byH = (mxH - headerH - 2 * kPad + kGap) / rows - kGap;
        let cell = Math.min(Math.min(byW, byH), kCellMax);
        cell = Math.floor(cell);
        // ⚠️ kCellMin 是「可玩性下限」，不是「一定塞得下」的下限。
        //   视口太矮时（kHeaderH 现在有204，视口不足 ~700 高就装不下最小格），
        //   强行抬到 kCellMin 会让内容高过视口，而 computeLayout 的
        //   `winH = max(内容最小高, mxH)` 于是把 canvas 撑到视口之外——
        //   多出来那截被 body overflow:hidden 裁掉，看起来就像
        //   **背景图没铺满**（其实是被裁了）。
        //
        //   正确做法：允许 cell 低于 kCellMin，**宁可格子小，也不要溢出视口**。
        //   canvas 尺寸 = 视口尺寸是硬约束（背景要铺满），内容的优先级更低。
        if (cell < 1) cell = 1;
        return cell;
    }
    maxColsAtMinimumCell(mxW: number): number { return Math.floor((mxW - 2 * kPad + kGap) / (kCellMin + kGap)); }
    maxRowsAtMinimumCell(mxH: number): number { return Math.floor((mxH - kHeaderH - 2 * kPad + kGap) / (kCellMin + kGap)); }

    private computeLayout(mxW: number, mxH: number): Layout {
        const cols = this.board ? this.board.cols() : 16;
        const rows = this.board ? this.board.rows() : 16;
        // ★ 不动点迭代：hs 由 boardW 定，boardW 由 cell 定，cell 又要扣 headerH(=204*hs) → 互相依赖。
        //   以前只算一遍（cell 按设计高 204 算，实际顶栏只有 159），45px 就此白丢，
        //   1080×660 下棋盘 429、顶栏却 484。迭代几轮就收敛，见下方循环。
        //   收不动（在 33/34 之间跳）时**取较小格**：宁可小 1px，也不能高过视口。
        let headerH = kHeaderH;
        let cell = this.cellSizeFor(cols, rows, mxW, mxH, headerH);
        let hs = 1;
        for (let it = 0; it < 4; it++) {
            const bw = cols * (cell + kGap) - kGap;
            const h2 = clampF(Math.min(1, bw / kHeaderContentW), 0.78, 1);
            const hh = Math.round(kHeaderH * h2);
            const c2 = this.cellSizeFor(cols, rows, mxW, mxH, hh);
            const done = (c2 === cell && hh === headerH);
            if (c2 < cell) {
                // 震荡 → 取小的收工。**但 hs/headerH 必须按选定的 cell 反算回来**：
                // 直接沿用上一轮的 hh 会留下「格子 33、顶栏却按 34 算」的错配
                // （1280×800 实测顶栏 589 对棋盘 573）。
                cell = c2;
                const bw2 = cols * (cell + kGap) - kGap;
                hs = clampF(Math.min(1, bw2 / kHeaderContentW), 0.78, 1);
                headerH = Math.round(kHeaderH * hs);
                break;
            }
            cell = c2; headerH = hh; hs = h2;
            if (done) break;
        }
        const pitch = cell + kGap;
        const boardW = cols * pitch - kGap;
        const boardH = rows * pitch - kGap;
        // 窗口尺寸 = **可用空间（就是视口）**，棋盘在其中居中。
        // 以前这里是 `boardW + 2*kPad` 起步、再按 mx* 收窄——于是 canvas 只比棋盘宽一点，
        // 背景图（drawImageCover 按 canvas 尺寸 cover）也就只画那么窄一块，
        // 视口其余部分是页面底色。现在铺满视口，背景才真的铺满整屏。
        //
        // 注意这里**不能**让格子变大去填满宽度：cellSizeFor 用 mxW 算出的格子已经
        // 是"能在视口里放下的最大尺寸"，而 kCellMax = 40 是上限，宽屏上本来就是棋盘居中、
        // 四周留白。留白由背景图填，正是我们要的效果。
        // ⚠️ 这里**直接用视口**，不对宽高取任何下限。
        //   以前是 `Math.max(640, mxW)` 与 `Math.max(内容最小高, mxH)`，
        //   于是视口小于 640×内容高时 canvas 反而比视口大，多出来那截被 body 的
        //   `overflow:hidden` 裁掉 —— 观感上就是**「背景图没铺满视口」**，
        //   很难联想到是canvas 超界（2026-10-16 用户截图才发现）。
        //
        //   canvas 尺寸 = 视口尺寸是**硬约束**：背景要按 cover 铺满整屏。
        //   内容装不下就缩小格子（见 cellSizeFor），而不是把画布撑大。
        const winW = mxW;
        const winH = mxH;
        // 棋盘整体（标题栏 + 棋盘 + 下留白）作为一个块在窗口里**上下居中**。
        // 以前是固定贴在顶部，窗口变高时下方会空出一大片；现在铺满视口后必须居中，
        // 否则内容全挤在上面、下面半屏是纯背景。
        // ★ 顶栏等比缩放（2026-10-20）：窗口装不下 620×204 的设计尺寸时**整体缩小**，
        //   而不是只重排、尺寸不动。原来 1080×660 下顶栏 620 比棋盘 429 宽出近 200px，
        //   还占掉 31% 的高度，看着像两块不相干的东西叠在一起。
        //   缩放口径：顶栏宽度向棋盘看齐（boardW/620），下限 0.78 —— 11px 小字缩到 8.6px
        //   还读得出来，再小就不行了。字号/控件/行高全乘 hs，比例不变。
        //   **必须在算 contentH 之前定下来**：居中要用真实的顶栏高度，用 kHeaderH 会多留白。
        //   （hs / headerH 已在上面的不动点迭代里算好，别在这里再算一遍 —— 两处各算一次迟早分叉。）
        const contentH = headerH + boardH + 2 * kPad;
        // 触摸设备**顶部对齐**（用户 2026-10-16 选定）：手机浏览器的地址栏伸缩、软键盘起落
        // 都会改 innerHeight，居中会让整盘跟着上下跳；顶对齐只有底部留白变化，跳动小得多。
        // 桌面端 coarse_ 恒为 false，仍走居中分支。
        const top = this.coarse_ ? 0 : Math.max(0, Math.round((winH - contentH) / 2));
        // 顶栏在窗口里**水平居中**。棋盘本身也水平居中（bx 的求法），所以居中即
        // 与棋盘同轴；棋盘比顶栏窄时（9x9）顶栏两侧超出棋盘是对称的，不散架。
        //
        // ⚠️ 历史教训——不能按棋盘宽锚定：旧式 `sideX = max(8, min(bx, (winW-620)/2))`
        // 在棋盘比顶栏宽时取 bx（棋盘左缘），于是 45x20 这类宽棋盘把 620 宽的顶栏
        // 内容整个拽到左边（2026-10-26 用户截图确认）。也不能按棋盘宽收窄顶栏：
        // 窄窗口里棋盘只有 428 宽，顶栏跟着只剩 428，而内容（标题 + 难度键 + 按钮排
        // + 三个复选框 + 滑块）仍要 620，标题撞难度键、滑块数字框压复选框（800×600 实测）。
        const bx = Math.round((winW - boardW) / 2);
        // floor 而不是 round：round 可能把 sideX 向上取 0.5px，可用宽就少 1px，
        // 除回设计宽会差 1.1px —— 足以误判成「窄顶栏」而触发紧凑模式（1280×800 实测）。
        const sideX = Math.max(8, Math.floor((winW - kHeaderContentW * hs) / 2));
        const rx = winW - 2 * sideX;
        // 设计坐标空间里的宽度：内部所有行位/控件宽度都按 620 这一套写死，
        // 由外层的 ctx.scale(hs) 统一缩小，所以这里要除回去。
        //
        // ★ 别用「px 宽度除 hs」直接当设计宽：取整误差会被 hs 放大（0.5/hs ≈ 0.56px），
        //   稍微偏小就会误判成窄顶栏 —— 1280×800 会进紧凑模式：标题消失、控件换行。
        // 上限夹到 620：宽窗口时 rx/hs 会比 620 大一点点（floor 取整的余量），
        // 夹上去就正好是设计宽；真窄的时候（sideX 被窗口夹住）自然小于 620 → 走紧凑模式。
        const rxc = Math.min(kHeaderContentW, hs > 0 ? rx / hs : rx);

        const L: Layout = {
            winW, winH, cell, pitch, boardW, boardH,
            boardX: bx, boardY: top + headerH + kPad,
            headerH, headerTop: top, sideX, hs, hw: rxc,
            restartBtn: R(0, 0, 0, 0), hardBtn: R(0, 0, 0, 0), mediumBtn: R(0, 0, 0, 0), easyBtn: R(0, 0, 0, 0),
            settingsBtn: R(0, 0, 0, 0), seedBtn: R(0, 0, 0, 0), customBtn: R(0, 0, 0, 0), playAgainBtn: R(0, 0, 0, 0),
            gearCX: 0, gearCY: 0,
            helpBtn: R(0, 0, 0, 0), helpPanel: R(0, 0, 0, 0), setPanel: R(0, 0, 0, 0),
            bgValue: R(0, 0, 0, 0), bgTrack: R(0, 0, 0, 0)
        };
        // 顶栏绘制时的可用宽度：左右各留 sideX，所以是 winW - 2*sideX
        L.restartBtn = R(rxc - 54, kRow.row1y, 34, 34);
        L.hardBtn = R(L.restartBtn.x - 14 - 74, kRow.row1y, 74, 34);
        L.mediumBtn = R(L.hardBtn.x - 8 - 74, kRow.row1y, 74, 34);
        L.easyBtn = R(L.mediumBtn.x - 8 - 74, kRow.row1y, 74, 34);
        L.settingsBtn = R(rxc - 52, kRow.row2y, 34, 28);
        L.seedBtn = R(L.settingsBtn.x - 6 - 72, kRow.row2y, 72, 28);
        L.customBtn = R(L.seedBtn.x - 6 - 92, kRow.row2y, 92, 28);
        L.playAgainBtn = R(L.customBtn.x - 6 - 118, kRow.row2y, 118, 28);
        L.gearCX = L.settingsBtn.x + 17; L.gearCY = kRow.row2y + 14;
        const tw = textWidth(this.ctx, 'Complex Minesweeper', 21);
        L.helpBtn = R(18 + Math.round(tw + 12), kRow.row1y - 7, 26, 26);
        {
            const w = Math.min(640, winW - 20), h = Math.min(680, winH - 16);
            L.helpPanel = R(Math.round((winW - w) / 2), Math.round((winH - h) / 2) - 4, w, h);
        }
        {
            const w = Math.min(560, winW - 16), h = Math.min(510, winH - 16);
            let x = Math.round((winW - w) / 2), y = Math.round((winH - h) / 2) - 16;
            x = clampI(x, 8, Math.max(8, winW - w - 8));
            y = clampI(y, 8, Math.max(8, winH - h - 8));
            L.setPanel = R(x, y, w, h);
        }
        L.bgValue = R(246, kRow.row4y, 34, 26);
        L.bgTrack = R(L.bgValue.x + 38, kRow.trackY, Math.max(30, rxc - 16 - (L.bgValue.x + 42)), 8);
        if (L.bgValue.x > L.settingsBtn.x - 40) {
            // 窗口过窄时把 OPACITY 控件收到齿轮左侧
            L.bgValue = R(L.settingsBtn.x - 40 - 34, kRow.row4y, 34, 26);
            L.bgTrack = R(L.bgValue.x + 34 + 4, kRow.trackY, Math.max(30, L.settingsBtn.x - 6 - (L.bgValue.x + 38)), 8);
        }
        // —— 窄顶栏（内容宽 < 620，手机竖屏这类）紧凑排布 ——
        // 620 是顶栏内容的设计宽度；比它窄时照原排布会出两处硬伤（390×730 截图实测）：
        //   · 标题 230px 宽压在难度芯片排上，帮助键也插进 24x16 里；
        //   · CUSTOM 键被后画的 TIME 药丸整块盖住——看着像没有，点也点不到，
        //     触摸端从此开不了自定义局（信息/功能丢失，比难看严重）。
        // 紧凑模式：标题让位（帮助键挪到芯片排左侧）、CUSTOM 独占 row3 左段、
        // 计数芯片换行到 row4 左段、OPACITY 收去齿轮左侧。桌面尺寸 rx≥620 完全不进这里。
        if (rxc < kHeaderContentW) {
            L.helpBtn = R(20, kRow.row1y + 4, 26, 26);
            // 高 24（比标准 28 矮一点）：row4 左段的计数芯片圆顶在 y=121，
            // 按钮若铺到 122 会和圆擦边（390 实测 4px 重叠）。
            L.customBtn = R(18, kRow.row3y, 92, 24);
            L.playAgainBtn = R(18, kRow.row3y, 118, 24);
            L.bgValue = R(L.settingsBtn.x - 40 - 34, kRow.row4y, 34, 26);
            L.bgTrack = R(L.bgValue.x + 34 + 4, kRow.trackY, Math.max(30, L.settingsBtn.x - 6 - (L.bgValue.x + 38)), 8);
        }
        return L;
    }

    /** 依据可用视口尺寸重算布局，并把画布物理尺寸设为 winW×winH */
    applySize(availW: number, availH: number): void {
        // 重新探测指针类型：插上鼠标、或用 DevTools/CDP 切换设备模拟都会改变结果，
        // 布局要跟着在「顶对齐 ↔ 居中」之间切换。测试钉死过的值不覆盖。
        if (this.coarseOverride_ === null) this.coarse_ = this.detectCoarse();
        this.L = this.computeLayout(availW, availH);
        this.clampBoardView();   // 布局变了，原来的平移量可能已经拖出界
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(this.L.winW), h = Math.round(this.L.winH);
        if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
            this.canvas.width = Math.round(w * dpr);
            this.canvas.height = Math.round(h * dpr);
        }
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    inBounds(r: number, c: number): boolean {
        return r >= 0 && c >= 0 && r < this.board.rows() && c < this.board.cols();
    }

    cellAt(px: number, py: number): { r: number; c: number } | null {
        // 触摸缩放/平移后，屏幕坐标要先逆变换回棋盘世界坐标（s=1 时是恒等变换）
        const v = this.view_;
        const x = (px - v.tx) / v.s - this.L.boardX;
        const y = (py - v.ty) / v.s - this.L.boardY;
        if (x < 0 || y < 0) return null;
        const p = this.L.pitch; // = cell + kGap
        let c = Math.floor(x / p), r = Math.floor(y / p);
        // 落在格子间隙（gap）里时吸附到后一格，而不是判空——与桌面端 Renderer::cellAt 同语义。
        // 原来直接 return null，会让 1-(cell/pitch)^2 的棋盘面积点不动：40px 格约 13.5%，
        // 24px 小格约 21%。cellAt 是所有命中判定（点击/右键菜单/中键 chord/悬停高亮）的入口。
        if (x - c * p > this.L.cell) ++c;
        if (y - r * p > this.L.cell) ++r;
        // 吸附后可能落到棋盘外（点在最右/最下间隙或窗口留白），钳上界：board.at() 会越界读
        if (r >= this.board.rows() || c >= this.board.cols()) return null;
        return { r, c };
    }

    private ustcLabelW(): number { return textWidth(this.ctx, '红专并进 理实交融', 12); }

    ustcRects() {
        const labelW = this.ustcLabelW();
        // 右侧锚点与顶栏按钮一致（sideX），不是窗口边缘——canvas 铺满视口后
        // 按 winW 算会让复选框跑到屏幕最右、比棋盘宽出一大截。
        // 右锚点用 L.hw（**设计宽**），不是 winW-2*sideX（那是缩放后的像素宽）：
        // 这行矩形是在设计坐标空间里画的，用像素宽会整体左移，和旁边的复选框贴在一起。
        const rightEdge = this.L.hw - 18;                        // 设计坐标
        const bx = rightEdge - labelW - 6 - 16;
        const cy = kRow.checkY;                                  // 独占一行（见 kRow 注释）
        const ustcBox = R(bx, cy, 16, 16);
        const ustcLabel = R(ustcBox.x + 22, cy - 2, labelW, 20);
        const hlabelW = textWidth(this.ctx, '隐藏计数', 12);
        const hideBox = R(ustcBox.x - 22 - hlabelW, cy, 16, 16);
        const hideLabel = R(hideBox.x + 22, cy - 2, hlabelW, 20);
        const mlabelW = textWidth(this.ctx, '总是显示模长', 12);
        const magBox = R(hideBox.x - 22 - mlabelW, cy, 16, 16);
        const magLabel = R(magBox.x + 22, cy - 2, mlabelW, 20);
        return { ustcBox, ustcLabel, hideBox, hideLabel, magBox, magLabel };
    }


    /** 顶栏矩形从"局部坐标"换算成"窗口坐标"。绘制时 ctx 已translate 过，命中判定没有。 */
    /** 顶栏局部坐标 → 窗口坐标。含 hs 缩放，所以是「先乘 hs 再加偏移」。 */
    private absTop(r: Rect): Rect {
        const L = this.L;
        return R(r.x * L.hs + L.sideX, r.y * L.hs + L.headerTop, r.w * L.hs, r.h * L.hs);
    }

    headerActionAt(px: number, py: number): HeaderAction {
        const L = this.L;
        const u = this.ustcRects();
        // 顶栏矩形存的是**局部坐标**（绘制时 ctx.translate 到 sideX/headerTop），
        // 命中判定拿的是窗口坐标，所以这里必须先换算。
        const hit = (r: Rect) => inside(this.absTop(r), px, py);
        if (hit(L.helpBtn)) return HeaderAction.Help;
        if (this.playAgainVisible_ && hit(L.playAgainBtn)) return HeaderAction.PlayAgain;
        if (hit(L.restartBtn)) return HeaderAction.Restart;
        if (hit(L.customBtn)) return HeaderAction.Custom;
        if (hit(L.seedBtn)) return HeaderAction.Seed;
        if (hit(L.settingsBtn)) return HeaderAction.Settings;
        if (hit(u.ustcBox) || hit(u.ustcLabel)) return HeaderAction.Ustc;
        if (hit(u.hideBox) || hit(u.hideLabel)) return HeaderAction.HideCounts;
        if (hit(u.magBox) || hit(u.magLabel)) return HeaderAction.AlwaysMagnitude;
        if (hit(L.easyBtn)) return HeaderAction.Easy;
        if (hit(L.mediumBtn)) return HeaderAction.Medium;
        if (hit(L.hardBtn)) return HeaderAction.Hard;
        return HeaderAction.None;
    }

    // ================================================================
    //  覆盖层（胜负提示）
    // ================================================================

    setOverlayHidden(v: boolean): void { this.overlayHidden_ = v; }
    overlayHidden(): boolean { return this.overlayHidden_; }
    resetOverlay(): void { this.overlayHidden_ = false; }
    setPlayAgainVisible(v: boolean): void { this.playAgainVisible_ = v; }
    setDiffIdx(i: number): void { this.diffIdx_ = i; }
    setActiveDifficulty(i: number): void { this.activeDiff_ = i; }
    setHideCounts(v: boolean): void { this.hideCounts_ = v; }
    setAlwaysMagnitude(v: boolean): void { this.alwaysMagnitude_ = v; }
    setUstcMode(v: boolean): void { this.ustcMode_ = v; }
    hideCounts(): boolean { return this.hideCounts_; }
    alwaysMagnitude(): boolean { return this.alwaysMagnitude_; }
    ustcMode(): boolean { return this.ustcMode_; }

    private overlayBand(): Rect {
        const y = this.L.boardY + Math.max(20, (this.L.boardH - 134) * 0.5);
        return R(0, y, this.L.winW, 178);
    }
    private overlayBtns(): { same: Rect; next: Rect } {
        const band = this.overlayBand();
        const w = 118, h = 26, gap = 10;
        const y = band.y + 104;
        const x0 = this.L.winW / 2 - (2 * w + gap) / 2;
        return { same: R(x0, y, w, h), next: R(x0 + w + gap, y, w, h) };
    }
    overlayHit(px: number, py: number): OverlayHit {
        if (!this.playAgainVisible_ || this.overlayHidden_) return OverlayHit.None;
        const b = this.overlayBtns();
        if (inside(b.same, px, py)) return OverlayHit.SameRound;
        if (inside(b.next, px, py)) return OverlayHit.NewGame;
        return OverlayHit.None;
    }

    setMouse(x: number, y: number): void { this.mousePx_ = { x, y }; }
    mouse(): { x: number; y: number } { return this.mousePx_; }
    hoveredCell(): { r: number; c: number } | null { return this.cellAt(this.mousePx_.x, this.mousePx_.y); }

    /** 是否有任何模态面板打开（右键菜单不算，与桌面端一致） */
    panelOpen(): boolean {
        return this.settingsOpen_ || this.setupOpen_ || this.confirmOpen_ ||
            this.helpOpen_ || this.seedStage_ !== SeedStage.None;
    }

    // ================================================================
    //  右键标记菜单
    // ================================================================

    openMenu(cell: { r: number; c: number } | null, clickPx: number, clickPy: number): void {
        if (!cell) { this.closeMenu(); return; }
        const c = this.board.at(cell.r, cell.c);
        if (c.opened) { this.closeMenu(); return; }
        const h = this.menuOptions_.length * kMenuItemH + 8;
        let x = clickPx + 4, y = clickPy + 4;
        if (x + kMenuW > this.L.winW - 4) x = this.L.winW - 4 - kMenuW;
        if (y + h > this.L.winH - 4) y = this.L.winH - 4 - h;
        if (x < 4) x = 4;
        if (y < 4) y = 4;
        this.menuRect_ = R(x, y, kMenuW, h);
        this.menuCell_ = cell;
        this.menuIndex_ = 0;
        this.menuOpen_ = true;
    }
    closeMenu(): void { this.menuOpen_ = false; }
    menuIsOpen(): boolean { return this.menuOpen_; }
    /** 菜单矩形（屏幕坐标）：触摸端要靠它把"点第 N 项"换算成坐标，测试也用它 */
    menuRect(): Rect { return this.menuRect_; }
    menuItemHeight(): number { return kMenuItemH; }
    menuCell(): { r: number; c: number } { return this.menuCell_; }
    menuItemAt(px: number, py: number): number {
        if (!this.menuOpen_ || !inside(this.menuRect_, px, py)) return -1;
        const i = Math.floor((py - this.menuRect_.y) / kMenuItemH);
        if (i < 0 || i >= this.menuOptions_.length) return -1;
        return i;
    }
    menuMove(d: number): void {
        const n = this.menuOptions_.length;
        this.menuIndex_ = ((this.menuIndex_ + (d > 0 ? 1 : n - 1)) % n + n) % n;
    }
    menuOptionAt(i: number): MineType { return this.menuOptions_[i]; }
    menuHighlightedOption(): MineType { return this.menuOptions_[this.menuIndex_]; }
    setMenuIndexFromMouse(px: number, py: number): void {
        const i = this.menuItemAt(px, py);
        if (i >= 0) this.menuIndex_ = i;
    }

    // ================================================================
    //  背景不透明度滑块
    // ================================================================

    /** 背景是否是纯色（纯色下 OPACITY 控件整行隐藏，见 drawHeader） */
    private bgIsSolid(): boolean {
        return parseBgHex(this.cfg.background.dataUrl) !== null;
    }

    /** 0 = 无, 1 = 轨道, 2 = 数字框 */
    bgHitZone(px: number, py: number): number {
        const L = this.L;
        // 纯色背景下这一行不画，命中也要一起关掉 —— 否则会点到看不见的控件
        if (this.bgIsSolid()) return 0;
        // bgValue/bgTrack 是顶栏的局部坐标（见 absTop 的说明）
        if (inside(this.absTop(L.bgValue), px, py)) return 2;
        const t = this.absTop(L.bgTrack);
        const zone = R(t.x, t.y - 9, t.w, t.h + 18);
        if (inside(zone, px, py)) return 1;
        return 0;
    }
    bgFocusEdit(): void {
        this.setupFocus_ = 4;
        this.setupEdit2_ = '';
        this.setupEditBackup_ = this.cfg.bgAlpha;
    }
    bgPress(px: number): void { this.bgDrag_ = true; this.bgMove(px); }
    bgMove(px: number): void {
        if (!this.bgDrag_) return;
        const t = this.absTop(this.L.bgTrack);      // 换算成窗口坐标再算比例
        const v = Math.round(clampF((px - t.x) / t.w, 0, 1) * kBgAlphaMax);
        this.cfg.bgAlpha = v;
    }
    bgRelease(): void { this.bgDrag_ = false; }
    setupRelease(): void { this.setupDrag_ = 0; }

    // ================================================================
    //  种子 UI
    // ================================================================

    seedRects() {
        const L = this.L;
        const b = this.absTop(L.seedBtn);       // 种子菜单挂在按钮下方，须用窗口坐标
        const mw = Math.min(236, L.winW - 16);
        const menu = R(clampI(b.x + b.w - mw, 8, Math.max(8, L.winW - mw - 8)), b.y + b.h + 6, mw, 164);
        const items = [
            R(menu.x + 4, menu.y + 4, mw - 8, 36),
            R(menu.x + 4, menu.y + 44, mw - 8, 36),
            R(menu.x + 4, menu.y + 84, mw - 8, 36),
            R(menu.x + 4, menu.y + 124, mw - 8, 36)
        ];
        const dw = Math.min(460, L.winW - 60), dh = 212;
        const dialog = R(Math.round((L.winW - dw) / 2), Math.round((L.winH - dh) / 2) - 30, dw, dh);
        const sbox = R(dialog.x + 20, dialog.y + 60, dw - 40, 36);
        const by = dialog.y + dh - 56;
        // 窗口窄到放不下三个 124px 按钮时等分收窄，否则 CANCEL 会压住 PASTE，
        // 而命中顺序是 ok→cancel→paste，重叠区一律判成「取消」。
        const gap = 10;
        const bw = Math.min(124, Math.max(56, Math.floor((dw - 40 - 2 * gap) / 3)));
        const paste = R(dialog.x + 20, by, bw, 34);
        const ok = R(dialog.x + dw - 20 - bw, by, bw, 34);
        const cancel = R(dialog.x + dw - 20 - bw * 2 - gap, by, bw, 34);
        const cw = Math.min(400, L.winW - 40), ch = 176;
        const confirm = R(Math.round((L.winW - cw) / 2), Math.round((L.winH - ch) / 2) - 20, cw, ch);
        const cy = confirm.y + 120;
        const cbw = Math.min(124, Math.max(56, Math.floor((cw - 40 - gap) / 2)));
        const yes = R(confirm.x + 20, cy, cbw, 34);
        const no = R(confirm.x + cw - 20 - cbw, cy, cbw, 34);
        return { menu, items, dialog, box: sbox, paste, ok, cancel, confirm, yes, no };
    }

    openSeedMenu(shortSeedText: string, copyEnabled: boolean, saveHint: string): void {
        this.seedStage_ = SeedStage.Menu;
        this.seedShort_ = shortSeedText;
        this.seedCopyEnabled_ = copyEnabled;
        this.seedSaveHint_ = saveHint;
        this.seedMenuItem_ = copyEnabled ? 0 : 2;
        this.seedMenuHover_ = -1;
        this.closeSeedBoxMenu();
    }
    openSeedLoadDialog(prefill: string): void {
        this.seedStage_ = SeedStage.Load;
        this.seedInput_ = prefill;
        this.seedCaret_ = prefill.length;
        this.seedSelAnchor_ = -1;
        this.seedScroll_ = 0;
        this.closeSeedBoxMenu();
    }
    openSeedConfirm(line1: string, line2: string): void {
        this.seedOwLine1_ = line1;
        this.seedOwLine2_ = line2;
        this.seedStage_ = SeedStage.Confirm;
        this.closeSeedBoxMenu();
    }
    closeSeedUi(): void { this.seedStage_ = SeedStage.None; this.closeSeedBoxMenu(); }
    closeSeedBoxMenu(): void { this.seedBoxMenuOpen_ = false; }
    seedBoxMenuIsOpen(): boolean { return this.seedBoxMenuOpen_; }

    seedMenuEnabled(i: number): boolean { return i === 2 || i === 3 || this.seedCopyEnabled_; }
    seedMenuItem(): number { return this.seedMenuItem_; }
    seedMenuHoverIndex(px: number, py: number): number {
        const r = this.seedRects();
        for (let i = 0; i < 4; ++i) if (inside(r.items[i], px, py)) return i;
        return -1;
    }
    updateSeedMenuHover(px: number, py: number): void {
        if (this.seedStage_ !== SeedStage.Menu) return;
        const i = this.seedMenuHoverIndex(px, py);
        if (i >= 0 && this.seedMenuEnabled(i)) this.seedMenuItem_ = i;
    }
    seedMenuMove(d: number): void {
        for (let k = 0; k < 4; ++k) {
            this.seedMenuItem_ = (this.seedMenuItem_ + (d > 0 ? 1 : 3)) % 4;
            if (this.seedMenuEnabled(this.seedMenuItem_)) return;
        }
    }

    seedHit(px: number, py: number): SeedHit {
        const r = this.seedRects();
        if (this.seedStage_ === SeedStage.Menu) {
            if (inside(r.items[0], px, py)) return SeedHit.MenuCopy;
            if (inside(r.items[1], px, py)) return SeedHit.MenuSave;
            if (inside(r.items[2], px, py)) return SeedHit.MenuLoad;
            if (inside(r.items[3], px, py)) return SeedHit.MenuTool;
            return SeedHit.Outside;
        }
        if (this.seedStage_ === SeedStage.Load) {
            if (inside(r.ok, px, py)) return SeedHit.Ok;
            if (inside(r.cancel, px, py)) return SeedHit.Cancel;
            if (inside(r.paste, px, py)) return SeedHit.Paste;
            if (inside(r.box, px, py)) return SeedHit.Box;
            if (inside(r.dialog, px, py)) return SeedHit.None;
            return SeedHit.Outside;
        }
        if (this.seedStage_ === SeedStage.Confirm) {
            if (inside(r.yes, px, py)) return SeedHit.Yes;
            if (inside(r.no, px, py)) return SeedHit.No;
            if (inside(r.confirm, px, py)) return SeedHit.None;
            return SeedHit.Outside;
        }
        return SeedHit.None;
    }

    private seedSelRange(): [number, number] | null {
        if (this.seedSelAnchor_ < 0 || this.seedSelAnchor_ === this.seedCaret_) return null;
        const a = Math.min(this.seedSelAnchor_, this.seedCaret_);
        const b = Math.max(this.seedSelAnchor_, this.seedCaret_);
        return [a, b];
    }
    seedSelectedText(): string {
        const s = this.seedSelRange();
        return s ? this.seedInput_.slice(s[0], s[1]) : '';
    }
    seedInsert(text: string): void {
        let clean = '';
        for (const ch of text) {
            const code = ch.charCodeAt(0);
            if (code >= 0x21 && code <= 0x7e) clean += ch;
        }
        if (!clean) {
            // 整段被过滤空掉（粘的是中文/空格/换行）也要吭一声，否则症状就是「按了没反应」
            if (text) this.setSeedNote('BAD PASTE · 粘贴内容里没有可见 ASCII 字符（种子串只用 ASCII，中文/空格/换行会被丢掉）');
            return;
        }
        const s = this.seedSelRange();
        if (s) {
            this.seedInput_ = this.seedInput_.slice(0, s[0]) + clean + this.seedInput_.slice(s[1]);
            this.seedCaret_ = s[0] + clean.length;
        } else {
            this.seedInput_ = this.seedInput_.slice(0, this.seedCaret_) + clean + this.seedInput_.slice(this.seedCaret_);
            this.seedCaret_ += clean.length;
        }
        if (this.seedInput_.length > 4096) {
            this.seedInput_ = this.seedInput_.slice(0, 4096);
            this.seedCaret_ = Math.min(this.seedCaret_, 4096);
            // 静默截断和静默丢弃一样让人查不出来（桌面端同一处也说了这句话）
            this.setSeedNote('TOO LONG · 输入框最多 4096 字符，超出的没进来');
        } else if (clean.length < [...text].length) {
            // 收进来了但丢掉了几成（空格/换行/中文）：不说的话用户以为框里 = 剪贴板
            this.setSeedNote(`FILTERED · 丢掉了 ${[...text].length - clean.length} 个非 ASCII 字符（空格 / 中文 / 换行）`);
        }
        this.seedSelAnchor_ = -1;
    }
    seedInputChar(ch: string): void { this.seedInsert(ch); }
    seedInputBackspace(): void {
        const s = this.seedSelRange();
        if (s) { this.seedInput_ = this.seedInput_.slice(0, s[0]) + this.seedInput_.slice(s[1]); this.seedCaret_ = s[0]; this.seedSelAnchor_ = -1; return; }
        if (this.seedCaret_ <= 0) return;
        this.seedInput_ = this.seedInput_.slice(0, this.seedCaret_ - 1) + this.seedInput_.slice(this.seedCaret_);
        this.seedCaret_--;
    }
    seedInputDelete(): void {
        const s = this.seedSelRange();
        if (s) { this.seedInput_ = this.seedInput_.slice(0, s[0]) + this.seedInput_.slice(s[1]); this.seedCaret_ = s[0]; this.seedSelAnchor_ = -1; return; }
        if (this.seedCaret_ >= this.seedInput_.length) return;
        this.seedInput_ = this.seedInput_.slice(0, this.seedCaret_) + this.seedInput_.slice(this.seedCaret_ + 1);
    }
    seedCaretMove(d: number, shift: boolean): void {
        if (!shift) this.seedSelAnchor_ = -1;
        else if (this.seedSelAnchor_ < 0) this.seedSelAnchor_ = this.seedCaret_;
        this.seedCaret_ = clampI(this.seedCaret_ + d, 0, this.seedInput_.length);
    }
    seedSelectAll(): void { this.seedSelAnchor_ = 0; this.seedCaret_ = this.seedInput_.length; }
    /** 整段替换（右键粘贴）。过滤/截断与桌面端 seedInputSet 同一口径，三种「没全收」都要说。 */
    seedInputSet(text: string): void {
        let clean = '';
        for (const ch of text) {
            const code = ch.charCodeAt(0);
            if (code >= 0x21 && code <= 0x7e) clean += ch;
        }
        const inChars = [...text].length;
        if (!clean) {
            // 替换语义遇到「整段被过滤空掉」时**保留原内容**：粘了段中文就把
            // 已经打好的种子清了，是双重伤害，而且看上去像「粘贴把框清空了」。
            this.setSeedNote('BAD PASTE · 粘贴内容里没有可见 ASCII 字符（种子串只用 ASCII，中文/空格/换行会被丢掉）');
            return;
        }
        this.seedInput_ = clean.slice(0, 4096);
        this.seedCaret_ = this.seedInput_.length;
        this.seedSelAnchor_ = -1;
        this.seedScroll_ = 0;
        if (clean.length > 4096) {
            this.setSeedNote('TOO LONG · 粘贴内容超过 4096 字符，只留下前 4096 个');
        } else if (inChars > clean.length) {
            this.setSeedNote(`FILTERED · 丢掉了 ${inChars - clean.length} 个非 ASCII 字符（空格 / 中文 / 换行）`);
        }
    }
    /** 点击输入框：定位光标，shift 时扩展选区 */
    seedClickInBox(px: number, shift: boolean): void {
        const r = this.seedRects();
        const x0 = r.box.x + 8 - this.seedScroll_;
        let best = 0, bestD = Infinity;
        let acc = x0;
        for (let i = 0; i <= this.seedInput_.length; ++i) {
            const d = Math.abs(acc - px);
            if (d < bestD) { bestD = d; best = i; }
            if (i < this.seedInput_.length) acc += textWidth(this.ctx, this.seedInput_[i], 12);
        }
        if (!shift) this.seedSelAnchor_ = -1;
        else if (this.seedSelAnchor_ < 0) this.seedSelAnchor_ = this.seedCaret_;
        this.seedCaret_ = best;
    }
    openSeedBoxMenu(px: number, py: number): void {
        let x = px, y = py;
        if (x + 136 > this.L.winW - 4) x = this.L.winW - 4 - 136;
        if (y + 28 * 4 > this.L.winH - 4) y = this.L.winH - 4 - 28 * 4;
        this.seedBoxMenuRect_ = R(x, y, 136, 28 * 4);
        this.seedBoxMenuIndex_ = 2;
        this.seedBoxMenuOpen_ = true;
    }
    seedBoxMenuItemAt(px: number, py: number): number {
        if (!this.seedBoxMenuOpen_ || !inside(this.seedBoxMenuRect_, px, py)) return -1;
        const i = Math.floor((py - this.seedBoxMenuRect_.y) / 28);
        return (i >= 0 && i < 4) ? i : -1;
    }
    seedBoxMenuMove(d: number): void { this.seedBoxMenuIndex_ = (this.seedBoxMenuIndex_ + (d > 0 ? 1 : 3)) % 4; }
    seedBoxMenuIndex(): number { return this.seedBoxMenuIndex_; }

    setSeedNote(s: string): void { this.seedNote_ = s; this.seedNoteClock_ = 170; }
    setSeedOverwriteInfo(l1: string, l2: string): void { this.seedOwLine1_ = l1; this.seedOwLine2_ = l2; }
    tickSeedNote(): void { if (this.seedNoteClock_ > 0) this.seedNoteClock_--; }
    seedNote(): string { return this.seedNote_; }
    /** 保证光标可见的横向滚动 */
    private seedEnsureCaretVisible(): void {
        const r = this.seedRects();
        const avail = r.box.w - 16;
        let w = 0;
        for (let i = 0; i < this.seedCaret_; ++i) w += textWidth(this.ctx, this.seedInput_[i], 12);
        if (w - this.seedScroll_ > avail) this.seedScroll_ = w - avail;
        if (w - this.seedScroll_ < 0) this.seedScroll_ = w;
        const full = this.seedInputWidth();
        const maxS = Math.max(0, full - avail);
        this.seedScroll_ = clampF(this.seedScroll_, 0, maxS);
    }
    private seedInputWidth(): number {
        let w = 0;
        for (const ch of this.seedInput_) w += textWidth(this.ctx, ch, 12);
        return w;
    }

    // ================================================================
    //  设置面板
    // ================================================================

    settingsRects() {
        const P = this.L.setPanel;
        // 面板窄于设计宽 560 时按比例压缩横排：控件的 x 偏移是写死的（最右到 P.x+540），
        // 窗口一窄就会画到面板外甚至屏幕外，而且滚不到、点不着。s=1 时坐标与桌面端逐项相同。
        const s = clampF((P.w - 24) / 536, 0.6, 1);
        const X = (dx: number) => P.x + 12 + Math.round((dx - 12) * s);
        const W = (w: number) => Math.round(w * s);
        const y0 = P.y + 54;
        const bgBox = R(X(140), y0, W(190), 26);
        const browseBg = R(X(338), y0, W(110), 26);
        const resetBg = R(X(456), y0, W(84), 26);
        const cy = P.y + 94;
        const swatch = R(X(140), cy, W(30), 26);
        const hexField = R(X(178), cy, W(92), 26);
        const rgbField = [R(X(292), cy, W(42), 26), R(X(352), cy, W(42), 26), R(X(412), cy, W(42), 26)];
        const resetColor = R(X(462), cy, W(84), 26);
        const marker: { field: Rect; browse: Rect; clear: Rect }[] = [];
        for (let i = 1; i <= 4; ++i) {
            const y = P.y + 140 + (i - 1) * 42;
            marker.push({ field: R(X(140), y, W(50), 26), browse: R(X(200), y, W(104), 26), clear: R(X(312), y, W(78), 26) });
        }
        const by = P.y + 320;
        const blank = { field: R(X(140), by, W(50), 26), browse: R(X(200), by, W(104), 26), clear: R(X(312), by, W(78), 26) };
        const chordBtn = [R(X(140), P.y + 372, W(86), 26), R(X(234), P.y + 372, W(86), 26), R(X(328), P.y + 372, W(86), 26)];
        const dcTrack = R(X(140), P.y + 423, W(190), 8);
        const dcValue = R(X(348), P.y + 414, W(74), 26);
        const starTrack = R(X(140), P.y + 474, W(190), 8);
        const scaleTrack = R(X(140), P.y + 519, W(190), 8);
        // 星光两行的数值框：与 dcValue 同一算法（track 的 y − 9，右侧 x 348 宽 74），点它即可输入
        const starValue = R(X(348), P.y + 465, W(74), 26);
        const scaleValue = R(X(348), P.y + 510, W(74), 26);
        const animBtn = R(X(140), P.y + 570, W(120), 26);
        const close = R(P.x + P.w - 138, P.y + P.h - 78, 118, 32);
        const restoreAll = R(P.x + P.w - 138 - 8 - 132, P.y + P.h - 78, 132, 32);
        return {
            bgBox, browseBg, resetBg, swatch, hexField, rgbField, resetColor, marker, blank,
            chordBtn, dcTrack, dcValue, starTrack, scaleTrack, starValue, scaleValue, animBtn, close, restoreAll,
            s, labelX: X(22), labelSize: s < 0.75 ? 9 : (s < 1 ? 10 : 12), boxSize: s < 1 ? 9 : 11
        };
    }

    openSettings(): void { this.settingsOpen_ = true; this.settingsFocus_ = 0; this.settingsEdit_ = ''; }
    closeSettings(): void { this.settingsOpen_ = false; this.settingsFocus_ = 0; this.settingsEdit_ = ''; this.settingsDrag_ = false; }
    settingsFocus(): number { return this.settingsFocus_; }
    focusOn(f: number): void {
        this.settingsFocus_ = f;
        this.settingsEdit_ = '';
    }

    private settingsView(): { viewTop: number; viewBot: number; viewH: number; totalH: number; maxS: number } {
        const P = this.L.setPanel;
        const viewTop = P.y + 44;
        const viewBot = P.y + P.h - 82;
        const viewH = viewBot - viewTop;
        const contentBottom = P.y + 630;   // 星光两行 + 动效开关把内容拉长（原 552）
        const totalH = contentBottom - viewTop;
        const maxS = Math.max(0, totalH - viewH);
        return { viewTop, viewBot, viewH, totalH, maxS };
    }
    scrollSettings(delta: number): void {
        const v = this.settingsView();
        if (v.maxS <= 0) { this.settingsScroll_ = 0; return; }
        this.settingsScroll_ = clampF(this.settingsScroll_ - delta * 48, 0, v.maxS);
    }
    private settingsInView(y: number, h: number): boolean {
        const v = this.settingsView();
        const yy = y - this.settingsScroll_;
        return yy + h >= v.viewTop && yy <= v.viewBot;
    }
    settingsHitScrollbar(px: number, py: number): boolean {
        const g = this.settingsGeo_;
        if (!g.ok) return false;
        return inside(g.track, px, py) || inside(g.thumb, px, py);
    }
    settingsDragBegin(px: number, py: number): void {
        const g = this.settingsGeo_;
        if (!g.ok) return;
        if (inside(g.thumb, px, py)) { this.settingsScrollDragging_ = true; this.settingsGrabOff_ = py - g.thumb.y; return; }
        if (inside(g.track, px, py)) {
            const v = this.settingsView();
            const th = g.thumb.h;
            this.settingsScroll_ = clampF((py - g.track.y) / g.track.h * v.totalH - th / 2, 0, v.maxS);
            this.settingsScrollDragging_ = true;
            this.settingsGrabOff_ = th / 2;
        }
    }
    settingsDragMove(px: number, py: number): boolean {
        if (!this.settingsScrollDragging_ || !this.settingsOpen_) return false;
        const g = this.settingsGeo_;
        const v = this.settingsView();
        const track = g.track.h - g.thumb.h;
        if (track <= 0 || v.maxS <= 0) { this.settingsScroll_ = 0; return true; }
        this.settingsScroll_ = clampF((py - this.settingsGrabOff_ - g.track.y) / track * v.maxS, 0, v.maxS);
        return true;
    }
    settingsDragEnd(): void { this.settingsScrollDragging_ = false; }

    settingsHit(px: number, py: number): SettingsHit {
        const r = this.settingsRects();
        if (inside(r.close, px, py)) return SettingsHit.Close;
        if (inside(r.restoreAll, px, py)) return SettingsHit.RestoreAll;
        if (this.settingsInView(r.bgBox.y, 26) && inside(r.bgBox, px, py + this.settingsScroll_)) return SettingsHit.BgField;
        if (this.settingsInView(r.browseBg.y, 26) && inside(r.browseBg, px, py + this.settingsScroll_)) return SettingsHit.BrowseBg;
        if (this.settingsInView(r.resetBg.y, 26) && inside(r.resetBg, px, py + this.settingsScroll_)) return SettingsHit.ResetBg;
        if (this.settingsInView(r.hexField.y, 26) && inside(r.hexField, px, py + this.settingsScroll_)) return SettingsHit.HexField;
        if (this.settingsInView(r.resetColor.y, 26) && inside(r.resetColor, px, py + this.settingsScroll_)) return SettingsHit.ResetColor;
        for (let i = 0; i < 3; ++i) {
            if (this.settingsInView(r.chordBtn[i].y, 26) && inside(r.chordBtn[i], px, py + this.settingsScroll_))
                return [SettingsHit.ChordSilent, SettingsHit.ChordHint, SettingsHit.ChordBoom][i];
        }
        {
            const t = r.dcTrack;
            const zone = R(t.x - 6, t.y - 12, t.w + 12, t.h + 24);
            if (this.settingsInView(t.y - 12, t.h + 24) && inside(zone, px, py + this.settingsScroll_)) return SettingsHit.DcTrack;
        }
        if (this.settingsInView(r.dcValue.y, 26) && inside(r.dcValue, px, py + this.settingsScroll_)) return SettingsHit.DcValue;
        if (this.settingsInView(r.starValue.y, 26) && inside(r.starValue, px, py + this.settingsScroll_)) return SettingsHit.StarValue;
        {
            const t = r.starTrack;
            const zone = R(t.x - 6, t.y - 12, t.w + 12, t.h + 24);
            if (this.settingsInView(t.y - 12, t.h + 24) && inside(zone, px, py + this.settingsScroll_)) return SettingsHit.StarTrack;
        }
        if (this.settingsInView(r.scaleValue.y, 26) && inside(r.scaleValue, px, py + this.settingsScroll_)) return SettingsHit.ScaleValue;
        if (this.settingsInView(r.animBtn.y, 26) && inside(r.animBtn, px, py + this.settingsScroll_)) return SettingsHit.AnimToggle;
        {
            const t = r.scaleTrack;
            const zone = R(t.x - 6, t.y - 12, t.w + 12, t.h + 24);
            if (this.settingsInView(t.y - 12, t.h + 24) && inside(zone, px, py + this.settingsScroll_)) return SettingsHit.ScaleTrack;
        }
        for (let i = 0; i < 3; ++i) {
            if (this.settingsInView(r.rgbField[i].y, 26) && inside(r.rgbField[i], px, py + this.settingsScroll_))
                return [SettingsHit.FieldR, SettingsHit.FieldG, SettingsHit.FieldB][i];
        }
        const fieldHits = [SettingsHit.Field1, SettingsHit.Field2, SettingsHit.Field3, SettingsHit.Field4];
        const browseHits = [SettingsHit.Browse1, SettingsHit.Browse2, SettingsHit.Browse3, SettingsHit.Browse4];
        const clearHits = [SettingsHit.Clear1, SettingsHit.Clear2, SettingsHit.Clear3, SettingsHit.Clear4];
        for (let i = 0; i < 4; ++i) {
            const m = r.marker[i];
            if (!this.settingsInView(m.field.y, 26)) continue;
            const q = py + this.settingsScroll_;
            if (inside(m.field, px, q)) return fieldHits[i];
            if (inside(m.browse, px, q)) return browseHits[i];
            if (inside(m.clear, px, q)) return clearHits[i];
        }
        {
            const b = r.blank;
            if (this.settingsInView(b.field.y, 26)) {
                const q = py + this.settingsScroll_;
                if (inside(b.field, px, q)) return SettingsHit.BlankField;
                if (inside(b.browse, px, q)) return SettingsHit.BlankBrowse;
                if (inside(b.clear, px, q)) return SettingsHit.BlankClear;
            }
        }
        return inside(this.L.setPanel, px, py) ? SettingsHit.None : SettingsHit.Outside;
    }

    settingsChar(ch: string): void {
        let c = ch;
        const code = c.charCodeAt(0);
        if (code >= 0xff01 && code <= 0xff5e) c = String.fromCharCode(code - 0xfee0);
        else if (code === 0x3000) c = ' ';
        const f = this.settingsFocus_;
        if (f >= 1 && f <= 4) {
            const cc = c.charCodeAt(0);
            if (cc >= 0x21 && cc <= 0x7e) this.setMarkerChar(f, c);
            return;
        }
        if (f === 10) {
            const cc = c.charCodeAt(0);
            if (cc >= 0x21 && cc <= 0x7e) this.setBlankChar(c);
            return;
        }
        if (f === 5) {
            if (!/[0-9A-Fa-f]/.test(c)) return;
            if (this.settingsEdit_.length >= 6) return;
            this.settingsEdit_ += c.toUpperCase();
            if (this.settingsEdit_.length === 6) {
                this.setCellColorHex(this.settingsEdit_);
                this.settingsEdit_ = '';
            }
            return;
        }
        if (f === 13) { // 背景纯色：只收十六进制，满 6 位立刻生效（和 CELL COLOR 同一套手感）
            if (!/[0-9A-Fa-f]/.test(c)) return;
            if (this.settingsEdit_.length >= 6) return;
            this.settingsEdit_ += c.toLowerCase();
            if (this.settingsEdit_.length === 6) {
                this.cfg.background.dataUrl = '#' + this.settingsEdit_;
                this.settingsEdit_ = '';
            }
            return;
        }
        if (f === 9) {
            if (!/[0-9]/.test(c)) return;
            if (this.settingsEdit_.length >= 4) return;
            if (this.settingsEdit_ === '0') this.settingsEdit_ = '';
            const cand = this.settingsEdit_ + c;
            if (parseInt(cand, 10) > kDoubleClickMaxMs) return;
            this.settingsEdit_ = cand;
            return;
        }
        if (f >= 6 && f <= 8) {
            if (!/[0-9]/.test(c)) return;
            if (this.settingsEdit_.length >= 3) return;
            if (this.settingsEdit_ === '0') this.settingsEdit_ = '';
            const cand = this.settingsEdit_ + c;
            if (parseInt(cand, 10) > 255) return;
            this.settingsEdit_ = cand;
            this.setRgbComponent(f - 6, parseInt(cand, 10));
            return;
        }
        if (f === 11) { // 星光密度：数字 + 至多一个小数点，最多 4 位（够输 7.12），候选值不得超上限
            const isDot = c === '.';
            if (!isDot && !/[0-9]/.test(c)) return;
            if (this.settingsEdit_.length >= 4) return;
            if (isDot && this.settingsEdit_.includes('.')) return;
            const cand = this.settingsEdit_ + c;
            if (!isDot && parseFloat(cand) > kStarDensityMax) return; // 单收一个小数点时还没有数值，不做上限判断
            this.settingsEdit_ = cand;
            return;
        }
        if (f === 12) { // 星光大小：数字 + 至多一个小数点，最多 4 位，候选值不得超上限（不去前导 0：0.6 合法）
            const isDot = c === '.';
            if (!isDot && !/[0-9]/.test(c)) return;
            if (this.settingsEdit_.length >= 4) return;
            if (isDot && this.settingsEdit_.includes('.')) return;
            const cand = this.settingsEdit_ + c;
            if (!isDot && parseFloat(cand) > kStarScaleMax) return; // 单收一个小数点时还没有数值，不做上限判断
            this.settingsEdit_ = cand;
            return;
        }
    }
    settingsBackspace(): void {
        const f = this.settingsFocus_;
        if (f >= 1 && f <= 4) { this.setMarkerChar(f, ''); return; }
        if (f >= 5 && f <= 13) { this.settingsEdit_ = this.settingsEdit_.slice(0, -1); return; }
    }
    settingsCommitMs(): void {
        const v = parseInt(this.settingsEdit_, 10);
        this.settingsEdit_ = '';
        if (!isNaN(v) && v >= kDoubleClickMinMs && v <= kDoubleClickMaxMs) this.setDoubleClickMs(v);
    }
    /** 星光两行的数值框：与毫秒框同一口径——空/越界就丢掉这次输入，保持原值。 */
    settingsCommitStarDensity(): void {
        const v = parseFloat(this.settingsEdit_);
        this.settingsEdit_ = '';
        if (!isNaN(v) && v >= kStarDensityMin && v <= kStarDensityMax) this.setStarDensity(v);
    }
    settingsCommitStarScale(): void {
        const v = parseFloat(this.settingsEdit_);
        this.settingsEdit_ = '';
        if (!isNaN(v) && v >= kStarScaleMin && v <= kStarScaleMax) this.setStarScale(v); // setter 里收拢到一位小数
    }
    /** 背景色框按回车：只接受满 6 位的十六进制（满 6 位其实已自动生效）。
     *  **空输入什么都不做** —— 「回到内置图片」走右边的 DEFAULT 按钮，
     *  否则「输入完自动生效→输入被清空→回车时看到空值又把颜色抹了」会打架。 */
    settingsCommitBg(): void {
        const s = this.settingsEdit_;
        this.settingsEdit_ = '';
        if (s.length === 6) this.cfg.background.dataUrl = '#' + s.toLowerCase();
    }
    /** which: 1=双击(ms) 2=星光密度 3=星光大小。三条滑块共用「按 x 反算 frac」这一套。 */
    private settingsApplyTrack(which: number, x: number): void {
        const r = this.settingsRects();
        const t = which === 2 ? r.starTrack : which === 3 ? r.scaleTrack : r.dcTrack;
        let frac = (x - t.x) / t.w;
        if (frac <= 0.02) frac = 0;
        if (frac >= 0.98) frac = 1;
        frac = clampF(frac, 0, 1);
        if (which === 2) this.setStarDensity(kStarDensityMin + Math.round(frac * (kStarDensityMax - kStarDensityMin) * 100) / 100);
        else if (which === 3) this.setStarScale(kStarScaleMin + Math.round(frac * (kStarScaleMax - kStarScaleMin) * 10) / 10);
        else { let ms = kDoubleClickMinMs + Math.round(frac * (kDoubleClickMaxMs - kDoubleClickMinMs)); ms = Math.floor(ms / 10) * 10; this.setDoubleClickMs(ms); }
    }
    settingsSetMsFromX(x: number): void { this.settingsApplyTrack(1, x); }
    settingsPressTrack(px: number, which = 1): void { this.settingsDrag_ = true; this.dragWhich_ = which; this.settingsApplyTrack(which, px); }
    settingsMove(px: number): boolean {
        if (!this.settingsDrag_ || !this.settingsOpen_) return false;
        this.settingsApplyTrack(this.dragWhich_, px);
        return true;
    }
    settingsRelease(): void { this.settingsDrag_ = false; }
    settingsEdit(): string { return this.settingsEdit_; }

    private setMarkerChar(i: number, c: string): void { this.cfg.marker[i].ch = c; }
    private setBlankChar(c: string): void { this.cfg.blank.ch = c; }
    private setRgbComponent(i: number, v: number): void {
        if (i === 0) this.cfg.cellR = v; else if (i === 1) this.cfg.cellG = v; else this.cfg.cellB = v;
    }
    private setCellColorHex(hex: string): void {
        const v = parseInt(hex, 16);
        if (isNaN(v)) return;
        this.cfg.cellR = (v >> 16) & 0xff;
        this.cfg.cellG = (v >> 8) & 0xff;
        this.cfg.cellB = v & 0xff;
    }
    setDoubleClickMs(ms: number): void { this.cfg.doubleClickMs = clampI(Math.round(ms), kDoubleClickMinMs, kDoubleClickMaxMs); }
    setStarDensity(n: number): void {
        this.cfg.starDensity = clampF(Math.round(n * 100) / 100, kStarDensityMin, kStarDensityMax);
    }
    setStarScale(v: number): void { this.cfg.starScale = Math.min(kStarScaleMax, Math.max(kStarScaleMin, Math.round(v * 10) / 10)); }
    setBgAlpha(v: number): void { this.cfg.bgAlpha = clampI(Math.round(v), 0, kBgAlphaMax); }

    // ================================================================
    //  自定义局面面板
    // ================================================================

    openSetup(cfg: SetupConfig): void {
        this.setupCfg_.copyFrom(cfg);
        this.setupCfg_.clampToBoard();
        this.setupOpen_ = true;
        this.setupFocus_ = 0;
        this.setupEdit2_ = '';
    }
    closeSetup(): void { this.setupOpen_ = false; this.setupFocus_ = 0; this.setupEdit2_ = ''; this.setupDrag_ = 0; }
    setupCfg(): SetupConfig { return this.setupCfg_; }

    setupRects() {
        const w = Math.min(400, this.L.winW - 16);
        // 面板窄到放不下「标签 + 五个控件」的一行（370px）时改**两行**：标签一行、控件一行居中。
        // 原来是一律写死偏移（plus5 画到 P.x+388），手机竖屏面板只有 374 宽 → 控件溢出框外点不到（U15）。
        // 不用等比缩放整行的方案：那会把 26px 的 +/- 按钮压到 19px，手指根本点不准。
        // 需要 winH 装得下 370 高，否则（横屏窄窗）退回原一行布局。
        const narrow = w < 392 && this.L.winH - 16 >= 370;
        const h = Math.min(narrow ? 370 : 316, this.L.winH - 16);
        let x = Math.round((this.L.winW - w) / 2), y = Math.round((this.L.winH - h) / 2) - 16;
        x = clampI(x, 8, Math.max(8, this.L.winW - w - 8));
        y = clampI(y, 8, Math.max(8, this.L.winH - h - 8));
        const P = R(x, y, w, h);
        const rowY = P.y + 52, rowH = narrow ? 52 : 34;
        const rows: { label: Rect; minus5: Rect; minus: Rect; value: Rect; plus: Rect; plus5: Rect }[] = [];
        for (let i = 0; i < 3; ++i) {
            const ry = rowY + i * rowH;
            if (narrow) {
                const b = 26, gap = 4, vw = 54;
                const blockW = 4 * b + 4 * gap + vw;               // 174
                const cx = P.x + Math.round((w - blockW) / 2);
                const by = ry + 22;
                rows.push({
                    label: R(P.x + 18, ry + 4, w - 36, 18),
                    minus5: R(cx, by, b, b),
                    minus: R(cx + b + gap, by, b, b),
                    value: R(cx + 2 * (b + gap), by, vw, b),
                    plus: R(cx + 2 * (b + gap) + vw + gap, by, b, b),
                    plus5: R(cx + 3 * (b + gap) + vw + gap, by, b, b)
                });
                continue;
            }
            rows.push({
                label: R(P.x + 18, ry + 8, 180, 18),
                minus5: R(P.x + 206, ry, 26, 26), minus: R(P.x + 236, ry, 26, 26),
                value: R(P.x + 266, ry, 62, 26),
                plus: R(P.x + 332, ry, 26, 26), plus5: R(P.x + 362, ry, 26, 26)
            });
        }
        const sy = rowY + 3 * rowH + 10;
        return {
            panel: P, rows,
            splitBtn: R(P.x + 18, sy, 120, 26),
            realTrack: R(P.x + 118, sy + 12, 190, 8),
            imagTrack: R(P.x + 118, sy + 40, 190, 8),
            cancelBtn: R(P.x + 20, P.y + h - 46, 120, 32),
            startBtn: R(P.x + w - 150, P.y + h - 46, 130, 32)  // 主操作放右，与桌面端同式
        };
    }

    setupEditing(): boolean { return this.setupFocus_ !== 0; }
    setupTextChar(ch: string): void {
        if (this.setupFocus_ === 0) return;
        let c = ch;
        const code = c.charCodeAt(0);
        if (code >= 0xff10 && code <= 0xff19) c = String.fromCharCode(code - 0xfee0);
        if (!/[0-9]/.test(c)) return;
        if (this.setupEdit2_.length >= 3) return;
        if (this.setupEdit2_ === '0') this.setupEdit2_ = '';
        const cand = this.setupEdit2_ + c;
        const v = parseInt(cand, 10);
        const cfg = this.setupCfg_;
        if (this.setupFocus_ === 1 && v > cfg.maxRows) return;
        if (this.setupFocus_ === 2 && v > cfg.maxCols) return;
        if (this.setupFocus_ === 3 && v > cfg.cols * cfg.rows - 1) return;
        if (this.setupFocus_ === 4 && v > 75) return;
        this.setupEdit2_ = cand;
    }
    setupBackspace(): void { this.setupEdit2_ = this.setupEdit2_.slice(0, -1); }
    setupCommitEdit(): void {
        const cfg = this.setupCfg_;
        if (this.setupFocus_ !== 0 && this.setupEdit2_ !== '') {
            const v = parseInt(this.setupEdit2_, 10);
            if (!isNaN(v)) {
                if (this.setupFocus_ === 1) cfg.rows = v;
                else if (this.setupFocus_ === 2) cfg.cols = v;
                else if (this.setupFocus_ === 4) this.setBgAlpha(Math.round(v * 2.55));
                else cfg.setTotal(v);
            }
        }
        this.setupFocus_ = 0;
        this.setupEdit2_ = '';
        cfg.clampToBoard();
    }
    setupCancelEdit(): void {
        const cfg = this.setupCfg_;
        if (this.setupFocus_ === 1) cfg.rows = this.setupEditBackup_;
        else if (this.setupFocus_ === 2) cfg.cols = this.setupEditBackup_;
        else if (this.setupFocus_ === 3) cfg.setTotal(this.setupEditBackup_);
        else if (this.setupFocus_ === 4) this.setBgAlpha(this.setupEditBackup_);
        this.setupFocus_ = 0;
        this.setupEdit2_ = '';
        cfg.clampToBoard();
    }
    setupEdit(): string { return this.setupEdit2_; }
    setupFocus(): number { return this.setupFocus_; }

    setupPress(px: number, py: number): SetupAction {
        const r = this.setupRects();
        const pad = this.coarse_ ? 6 : 0;   // 触摸端把 26px 的小按钮命中区扩到 38px
        if (!inside(r.panel, px, py)) { this.setupCommitEdit(); return SetupAction.Cancel; }
        if (insidePad(r.startBtn, px, py, pad)) { this.setupCommitEdit(); return SetupAction.Start; }
        if (insidePad(r.cancelBtn, px, py, pad)) { this.setupCommitEdit(); return SetupAction.Cancel; }
        const cfg = this.setupCfg_;
        for (let i = 0; i < 3; ++i) {
            const row = r.rows[i];
            if (insidePad(row.value, px, py, pad)) {
                this.setupCommitEdit();
                if (i === 2 && cfg.splitManual) { cfg.setTotal(cfg.realCount + cfg.imagCount); cfg.splitManual = false; cfg.clampToBoard(); }
                this.setupFocus_ = i + 1;
                this.setupEdit2_ = '';
                this.setupEditBackup_ = i === 0 ? cfg.rows : (i === 1 ? cfg.cols : cfg.total);
                return SetupAction.None;
            }
            if (insidePad(row.minus5, px, py, pad)) { this.setupCommitEdit(); this.stepRow(i, -5); return SetupAction.None; }
            if (insidePad(row.minus, px, py, pad)) { this.setupCommitEdit(); this.stepRow(i, -1); return SetupAction.None; }
            if (insidePad(row.plus, px, py, pad)) { this.setupCommitEdit(); this.stepRow(i, 1); return SetupAction.None; }
            if (insidePad(row.plus5, px, py, pad)) { this.setupCommitEdit(); this.stepRow(i, 5); return SetupAction.None; }
        }
        if (!cfg.splitManual && insidePad(r.splitBtn, px, py, pad)) {
            cfg.splitManual = true;
            cfg.realCount = Math.floor(cfg.total / 2);
            cfg.imagCount = cfg.total - cfg.realCount;
            cfg.clampToBoard();
            return SetupAction.None;
        }
        if (cfg.splitManual) {
            const slop = (t: Rect, id: number) => inside(R(t.x - 10, t.y - 10, t.w + 20, t.h + 20), px, py) ? id : 0;
            const hit = slop(r.realTrack, 1) || slop(r.imagTrack, 2);
            if (hit) { this.setupDrag_ = hit; this.setupMove(px); return SetupAction.None; }
        }
        this.setupCommitEdit();
        return SetupAction.None;
    }
    private stepRow(i: number, d: number): void {
        const cfg = this.setupCfg_;
        if (i === 0) cfg.rows += d;
        else if (i === 1) cfg.cols += d;
        else if (!cfg.splitManual) cfg.setTotal(cfg.total + d);
        cfg.clampToBoard();
    }
    setupMove(px: number): void {
        if (!this.setupDrag_) return;
        const r = this.setupRects();
        const t = this.setupDrag_ === 1 ? r.realTrack : r.imagTrack;
        const v = Math.round(clampF((px - t.x) / t.w, 0, 1) * this.setupCfg_.capacity());
        if (this.setupDrag_ === 1) this.setupCfg_.setReal(v); else this.setupCfg_.setImag(v);
        this.setupCfg_.clampToBoard();
    }

    // ================================================================
    //  帮助面板
    // ================================================================

    openHelp(): void {
        this.helpOpen_ = true;
        if (!this.helpBuilt_) {
            const built = buildHelp(this.ctx, this.L.helpPanel.w);
            this.helpRows_ = built.rows;
            this.helpTotalH_ = built.totalH;
            this.helpBuilt_ = true;
        }
    }
    closeHelp(): void { this.helpOpen_ = false; }
    private helpView() {
        const P = this.L.helpPanel;
        const viewTop = P.y + 16;
        const viewBot = P.y + P.h - 34;
        const viewH = viewBot - viewTop;
        const maxS = Math.max(0, this.helpTotalH_ - viewH);
        return { viewTop, viewBot, viewH, maxS };
    }
    scrollHelp(delta: number): void {
        const v = this.helpView();
        this.helpScroll_ = clampF(this.helpScroll_ - delta * 48, 0, v.maxS);
    }
    helpHitScrollbar(px: number, py: number): boolean {
        const g = this.helpGeo_;
        if (!g.ok) return false;
        return inside(R(g.track.x - 6, g.track.y, 14, g.track.h), px, py);
    }
    helpDragBegin(px: number, py: number): void {
        const g = this.helpGeo_;
        if (!g.ok) return;
        if (inside(g.thumb, px, py)) {
            this.helpGrabOff_ = py - g.thumb.y;
        } else {
            this.helpGrabOff_ = g.thumb.h / 2;
            this.helpDragTo(py);
        }
        this.helpDragging_ = true;
    }
    private helpDragTo(py: number): void {
        const g = this.helpGeo_;
        const v = this.helpView();
        const track = g.track.h - g.thumb.h;
        if (track <= 0 || v.maxS <= 0) { this.helpScroll_ = 0; return; }
        this.helpScroll_ = clampF((py - this.helpGrabOff_ - v.viewTop) / track * v.maxS, 0, v.maxS);
    }
    helpDragMove(py: number): void { if (this.helpDragging_) this.helpDragTo(py); }
    helpDragEnd(): void { this.helpDragging_ = false; }
    helpDragging(): boolean { return this.helpDragging_; }
    settingsScrollDragging(): boolean { return this.settingsScrollDragging_; }

    // ================================================================
    //  二次确认
    // ================================================================

    openConfirm(kind: ConfirmKind, what: string): void { this.confirmKind_ = kind; this.confirmWhat_ = what; this.confirmOpen_ = true; }
    openSwitchConfirm(what: string): void { this.openConfirm(ConfirmKind.Switch, what); }
    openRestartConfirm(): void { this.openConfirm(ConfirmKind.Restart, ''); }
    openRestoreConfirm(): void { this.openConfirm(ConfirmKind.RestoreAll, ''); }
    closeConfirm(): void { this.confirmOpen_ = false; this.confirmKind_ = ConfirmKind.None; }
    confirmRects() {
        const P = this.L.setPanel;
        const w = Math.min(430, P.w - 16), h = Math.min(178, P.h - 16);
        const panel = R(Math.round(P.x + (P.w - w) / 2), Math.round(P.y + (P.h - h) / 2), w, h);
        return {
            panel,
            no: R(panel.x + w - 224, panel.y + h - 54, 96, 32),
            yes: R(panel.x + w - 118, panel.y + h - 54, 98, 32)
        };
    }
    confirmHit(px: number, py: number): ConfirmHit {
        const r = this.confirmRects();
        if (inside(r.yes, px, py)) return ConfirmHit.Yes;
        if (inside(r.no, px, py)) return ConfirmHit.Cancel;
        if (inside(r.panel, px, py)) return ConfirmHit.None;
        return ConfirmHit.Outside;
    }
    confirmWhat(): string { return this.confirmWhat_; }

    // ================================================================
    //  黄 0 首现教学（与桌面端 Renderer::maybeStartZeroTip 同款）
    // ================================================================

    /** 开格后调用：盘上首次出现「和恰好抵消」的黄 0 → 进入 1.5s 闪烁并返回 true（调用方随即写 seen）。
     *  真空格（adjTotal===0）不参与：它是安全格，闪它反而误导。 */
    maybeStartZeroTip(): boolean {
        if (this.zeroTipPhase_ !== 0) return false;
        const rows = this.board.rows(), cols = this.board.cols();
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c) {
                const cell = this.board.at(r, c);
                if (cell.opened && cell.adjTotal > 0 && cell.adjReal === 0 && cell.adjImag === 0) {
                    this.zeroTipPhase_ = 1;
                    this.zeroTipT0_ = this.nowMs_;
                    return true;
                }
            }
        return false;
    }
    zeroTipPopupOpen(): boolean { return this.zeroTipPhase_ === 2; }
    closeZeroTip(): void { this.zeroTipPhase_ = 0; }
    private tickZeroTip(nowMs: number): void {
        if (this.zeroTipPhase_ === 1 && nowMs - this.zeroTipT0_ >= 1500) this.zeroTipPhase_ = 2;
    }
    zeroTipHit(px: number, py: number): 'none' | 'outside' {
        return inside(this.zeroTipPanel_, px, py) ? 'none' : 'outside';
    }
    private zeroTipRect(): Rect {
        const P = this.L.setPanel;
        const w = Math.min(470, P.w - 16), h = Math.min(140, P.h - 16);
        return R(Math.round(P.x + (P.w - w) / 2), Math.round(P.y + (P.h - h) / 2), w, h);
    }

    // ================================================================
    //  芯片闪烁
    // ================================================================

    updateChipFlash(dt: number, started: boolean, cur: number[]): void {
        for (let i = 0; i < this.chipFlash_.length; ++i)
            this.chipFlash_[i] = Math.max(0, this.chipFlash_[i] - dt / 1.1);
        if (!started) {
            this.lastChip_ = cur.slice();
            this.chipFlash_[1] = 0; this.chipFlash_[2] = 0;
        } else if (this.chipHadValue_) {
            for (let i = 0; i < 2; ++i) if (cur[i] !== this.lastChip_[i]) this.chipFlash_[i + 1] = 1;
        }
        this.lastChip_ = cur.slice();
        this.chipHadValue_ = started;
    }

    // ================================================================
    //  图片缓存（背景 / 标记 / 空白格）
    // ================================================================

    private ensureImages(): void {
        // 纯色背景：不加载任何图片（不然会拿 '#rrggbb' 当 URL 去请求，控制台一片红）
        if (parseBgHex(this.cfg.background.dataUrl)) {
            this.bgImg_ = null;
            this.bgImgSrc_ = '';
            return;
        }
        const src = this.cfg.background.dataUrl || kDefaultBg;
        if (src !== this.bgImgSrc_) {
            this.bgImgSrc_ = src;
            this.bgImg_ = null;
            if (src) {
                const img = new Image();
                img.onload = () => { if (this.bgImgSrc_ === src) this.bgImg_ = img; };
                // 内置背景是 WebP：老浏览器解不开就回退到同目录的 jpg（用户自定义背景是 dataUrl，不回退）
                if (src === kDefaultBg) {
                    img.onerror = () => {
                        if (this.bgImgSrc_ !== src) return;
                        const fb = new Image();
                        fb.onload = () => { if (this.bgImgSrc_ === src) this.bgImg_ = fb; };
                        fb.src = kDefaultBgFallback;
                    };
                }
                img.src = src;
            }
        }
        for (let i = 1; i <= 4; ++i) {
            const s = this.cfg.marker[i].dataUrl;
            if (s !== this.markerSrcs_[i]) {
                this.markerSrcs_[i] = s;
                this.markerImgs_[i] = null;
                if (s) {
                    const img = new Image();
                    img.onload = () => { if (this.markerSrcs_[i] === s) this.markerImgs_[i] = img; };
                    img.src = s;
                }
            }
        }
        const bs = this.cfg.blank.dataUrl;
        if (bs !== this.blankSrc_) {
            this.blankSrc_ = bs;
            this.blankImg_ = null;
            if (bs) {
                const img = new Image();
                img.onload = () => { if (this.blankSrc_ === bs) this.blankImg_ = img; };
                img.src = bs;
            }
        }
    }

    private drawImageCover(img: HTMLImageElement, alpha: number, clip: Rect | null): void {
        const ctx = this.ctx;
        const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
        if (iw <= 0 || ih <= 0) return;
        const L = this.L;
        const sc = Math.max(L.winW / iw, L.winH / ih);
        const ox = (L.winW - iw * sc) / 2, oy = (L.winH - ih * sc) / 2;
        ctx.save();
        ctx.globalAlpha = clampF(alpha / 255, 0, 1);
        if (clip) {
            let sx = (clip.x - ox) / sc, sy = (clip.y - oy) / sc;
            let sw = clip.w / sc, sh = clip.h / sc;
            let dx = ox + sx * sc, dy = oy + sy * sc;
            const cx0 = Math.max(0, sx), cy0 = Math.max(0, sy);
            const cx1 = Math.min(iw, sx + sw), cy1 = Math.min(ih, sy + sh);
            if (cx1 <= cx0 || cy1 <= cy0) { ctx.restore(); return; }
            dx = ox + cx0 * sc; dy = oy + cy0 * sc;
            sw = cx1 - cx0; sh = cy1 - cy0;
            ctx.beginPath();
            ctx.rect(clip.x, clip.y, clip.w, clip.h);
            ctx.clip();
            ctx.drawImage(img, cx0, cy0, sw, sh, dx, dy, sw * sc, sh * sc);
        } else {
            ctx.drawImage(img, 0, 0, iw, ih, ox, oy, iw * sc, ih * sc);
        }
        ctx.restore();
    }

    // ================================================================
    //  主绘制入口（顺序与 Renderer::draw 一致）
    // ================================================================

    draw(hud: Hud, nowMs: number): void {
        const ctx = this.ctx, L = this.L;
        const dt = this.lastTs_ > 0 ? Math.min(0.25, (nowMs - this.lastTs_) / 1000) : 0;
        this.lastTs_ = nowMs;
        this.nowMs_ = nowMs;

        if (this.seedStage_ === SeedStage.Menu) this.updateSeedMenuHover(this.mousePx_.x, this.mousePx_.y);
        this.ensureImages();
        this.syncAnims(hud, nowMs);

        // 背景：纯色 → 直接铺色；否则铺窗口底色再把底图按 cover 叠上去
        const bgCol = parseBgHex(this.cfg.background.dataUrl);
        fillRect(ctx, R(0, 0, L.winW, L.winH), bgCol || kWindowBg);
        if (this.bgImg_) this.drawImageCover(this.bgImg_, this.cfg.bgAlpha, null);

        this.updateChipFlash(dt, this.board.started(), this.alwaysMagnitude_
            ? [this.board.uncoveredMines(), 0]
            : (() => { const a = this.board.axisUnflagged(); return [a.real, a.imag]; })());

        this.drawHeader(hud);

        const panelRect = R(L.boardX - 6, L.boardY - 6, L.boardW + 12, L.boardH + 12);
        // 触摸缩放/平移：只在棋盘这一块套变换，并裁到顶栏以下的可视区，
        // 免得放大后的格子盖住顶栏。桌面端 zoomed 恒为 false，绘制路径与改动前完全一致。
        const v = this.view_;
        const zoomed = v.s !== 1 || v.tx !== 0 || v.ty !== 0;
        if (zoomed) {
            const vp = this.boardViewport();
            ctx.save();
            ctx.beginPath();
            ctx.rect(vp.x, vp.y, vp.w, vp.h);
            ctx.clip();
            ctx.transform(v.s, 0, 0, v.s, v.tx, v.ty);
        }
        // 棋盘托盘：圆角底板 + 柔和投影，让棋盘从页面背景里「浮」出来
        ctx.save();
        ctx.shadowColor = 'rgba(30,40,60,0.22)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 7;
        ctx.beginPath();
        if (typeof (ctx as unknown as { roundRect?: unknown }).roundRect === 'function')
            (ctx as unknown as { roundRect(x: number, y: number, w: number, h: number, r: number): void })
                .roundRect(panelRect.x, panelRect.y, panelRect.w, panelRect.h, 10);
        else ctx.rect(panelRect.x, panelRect.y, panelRect.w, panelRect.h);
        ctx.fillStyle = css(kPanel);
        ctx.fill();
        ctx.restore();

        const rows = this.board.rows(), cols = this.board.cols();
        const hover = this.hoveredCell();
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c)
                this.drawCellBg(r, c, hud.phase, hover !== null && hover.r === r && hover.c === c);

        if (this.bgImg_) {
            if (zoomed) {
                // 背景图是按**窗口空间** cover 画的（drawImageCover 用 winW/winH 算 sc/ox/oy）。
                // 若不抵消外层变换，棋盘里那块图会跟着放大，与全屏底图在 panelRect 边缘错位。
                ctx.save();
                ctx.transform(1 / v.s, 0, 0, 1 / v.s, -v.tx / v.s, -v.ty / v.s);
                this.drawImageCover(this.bgImg_, this.cfg.bgAlpha, R(
                    panelRect.x * v.s + v.tx, panelRect.y * v.s + v.ty,
                    panelRect.w * v.s, panelRect.h * v.s));
                ctx.restore();
            } else {
                this.drawImageCover(this.bgImg_, this.cfg.bgAlpha, panelRect);
            }
        }

        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c)
                this.drawCellContent(r, c, hud.phase);

        this.tickZeroTip(nowMs);
        this.drawZeroFlash(nowMs); // 黄 0 教学闪烁：棋盘坐标系内、内容之上

        if (this.dying_.length > 0) this.drawDyingFlags(nowMs);

        if (zoomed) ctx.restore();

        // 点击涟漪（窗口坐标，画在棋盘之上、面板之下）
        this.drawRipples(nowMs);

        this.drawTouchHint();

        this.drawOverlay(hud);
        this.drawConstellation(nowMs, zoomed, v);
        this.drawMenu();
        this.drawZeroTip(); // 黄 0 教学弹窗：模态面板之下、棋盘之上
        this.drawSetup();
        this.drawSeedUi();
        this.drawSettings();
        this.drawHelp();
        this.drawConfirm();
    }

    // ================================================================
    //  表头
    // ================================================================

    private drawBtn(rect: Rect, label: string, active: boolean, primary = false): void {
        const ctx = this.ctx;
        const on = active || primary;
        box(ctx, rect, on ? kBtnActive : kBtnBg, on ? kBtnActive : kBtnEdge, 1.5);
        drawC(ctx, label, 13, on ? C(255, 255, 255) : kInk, rect.x + rect.w / 2, rect.y + rect.h / 2, 0.5);
    }

private drawPill(pillY: number, x: number, w: number, label: string, value: string,
                 rightAlign: boolean, dim: boolean,
                 flip: { from: string; t: number } | null = null, red = false): void {
        const ctx = this.ctx;
        box(ctx, R(x, pillY, w, 28), kBtnBg, kBtnEdge, 1.5);
        // 玻璃质感（P1）：顶部高光渐变 + 底部微暗，画在半透明底色上
        {
            const g = ctx.createLinearGradient(0, pillY, 0, pillY + 28);
            g.addColorStop(0, 'rgba(255,255,255,0.55)');
            g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
            g.addColorStop(1, 'rgba(30,50,80,0.08)');
            ctx.fillStyle = g;
            ctx.fillRect(x + 1, pillY + 1, w - 2, 26);
        }
        drawTL(ctx, label, 9.5, kInkSoft, x + 12, pillY + 4);
        const drawVal = (txt: string, dy: number, alpha: number) => {
            const vw = textWidth(ctx, txt, 15);
            const vx = rightAlign ? x + w - 12 - vw : x + 12;
            ctx.save();
            ctx.globalAlpha = alpha;
            drawTL(ctx, txt, 15, red ? kBadMark : (dim ? kInkSoft : kInk), vx, pillY + 13 + dy, 0.5);
            ctx.restore();
        };
        // 翻牌：只有剩余雷数用（计时器每秒都变，翻起来太吵）
        if (flip && animOn(this.cfg.animFx) && this.nowMs_ - flip.t < kAnimMs.counterFlip) {
            const e = easeInOut(clampF((this.nowMs_ - flip.t) / kAnimMs.counterFlip, 0, 1));
            ctx.save();
            ctx.beginPath();
            ctx.rect(x + 2, pillY + 2, w - 4, 24);
            ctx.clip();
            drawVal(flip.from, -e * 20, 1 - e);
            drawVal(value, (1 - e) * 20, e);
            ctx.restore();
            return;
        }
        drawVal(value, 0, 1);
    }

    private drawHeader(hud: Hud): void {
        const ctx = this.ctx, L = this.L;
        // 整块顶栏先平移到 headerTop，再按原来的设计坐标画。
        //
        // **为什么不逐个坐标加偏移**：顶栏里那些 y（9/16/54/86/92/96/109/111/116/127）
        // 是精心排布的六行网格，每行还有各自的 x 分组。逐个改成 "y + headerTop" 很容易
        // 漏掉某一处、或把两个参数（宽/高）当成坐标改错——我先前就是这么把药丸和芯片
        // 叠在一起的。**套一层 translate 就不用动任何内部坐标**，也不会漏。
        //
        // x 方向同理：侧栏锚点从窗口边缘改成sideX（与棋盘左缘对齐），否则铺满视口后
        // 顶栏会贴到屏幕两端、比棋盘宽出一大截。
        ctx.save();
        ctx.translate(L.sideX, L.headerTop);
        // 等比缩放：顶栏内部所有坐标/字号/线宽都按 620×204 的设计尺寸写死，
        // 窗口装不下时靠这一层统一缩小，比例不变、也不用改任何内部数字。
        // 与之配套的两处：computeLayout 里 rxc = rx/hs（设计空间宽度）、absTop 里乘 hs（命中换算）。
        if (L.hs !== 1) ctx.scale(L.hs, L.hs);
        this.drawHeaderContent_(hud);
        ctx.restore();
    }

    private drawHeaderContent_(hud: Hud): void {
        const ctx = this.ctx, L = this.L;
        // 局部坐标：x 从 0 起（外层已 translate 到 sideX），y 从 0 起（已到 headerTop）
        const sx0 = 18;
        // 顶栏可用宽（**设计坐标**）。直接取 L.hw —— 它是 computeLayout 算好的、
        // 已经吸附过取整误差的设计宽。这里别自己再除一遍 hs：两个地方各算一次，
        // 迟早会因为某个 round 差 0.5px 而不一致（标题该画的时候没画）。
        // 统计行/进度条的宽度上限必须用它 —— 用 L.winW 会把 sideX 算两遍，控件捅出右缘。
        const rx = L.hw;
        // 芯片是否换行、换行后的起点。图例段要用它来让出右侧空间
        // （声明在这里而不是芯片段里，因为图例在那个 if 块之外）。
        let chipsWrapped = false, chipStartX = sx0 + 226, chipSpan = 0;
        // CHIPS 与 CHIP_W 同理：图例段要按「芯片实际占多宽」给自己定起点，
        // 而它俩原本定义在 `if (!hideCounts_)` 块内 → 图例段引用不到（TS2304）。
        const CHIP_W = 84;
        type Chip = { sw: string; col: Col; left: number; grayZero: boolean; slot: number };
        const chips: Chip[] = this.alwaysMagnitude_
            ? [{ sw: 'm', col: kInk, left: this.board.uncoveredMines(), grayZero: false, slot: 1 }]
            : (() => {
                const a = this.board.axisUnflagged();
                return [
                    { sw: '±1', col: kRealMine, left: a.real, grayZero: true, slot: 1 },
                    { sw: '±i', col: kImagMine, left: a.imag, grayZero: true, slot: 2 }
                ];
            })();

        // 顶栏底板。canvas 铺满视口后，背景图会漫到顶栏底下——深色小字压在浅色建筑/
        // 云上会糊成一片（不透明度调到 0 时更明显）。给一层半透明面板，文字对比度就稳定了。
        // 半透明而非不透明：底下的图仍能透出来，不破坏"背景铺满整屏"的效果。
        {
            // 底板覆盖整个顶栏可用区（设计坐标：0 .. rx）；高度用设计高度 kHeaderH，
            // 不能拿 L.headerH —— 那个已经乘过 hs 了，会和被缩放的内容对不上。
            const availW = rx;
            const pad = 10;
            const r = R(-pad, -pad, availW + pad * 2, kHeaderH + pad);
            box(ctx, r, C(233, 238, 244, 168), C(255, 255, 255, 130), 1);
        }

        // 窄顶栏不画大标题：230px 的标题在 <620 宽里必然压住难度芯片排（390 截图实测）。
        // 帮助键的矩形已在 computeLayout 里挪到芯片排左侧，这里照矩形画即可。
        if (rx >= kHeaderContentW) drawTL(ctx, 'Complex Minesweeper', 21, kInk, sx0, 10, 0.6);

        circle(ctx, L.helpBtn.x + 13, L.helpBtn.y + 13, 13, kBtnBg, kBtnEdge, 1.5);
        drawC(ctx, '?', 14, kInk, L.helpBtn.x + 13, L.helpBtn.y + 13, 0.4);

        this.drawBtn(L.easyBtn, '9x9', this.activeDiff_ === 0);
        this.drawBtn(L.mediumBtn, '16x16', this.activeDiff_ === 1);
        this.drawBtn(L.hardBtn, '24x16', this.activeDiff_ === 2);
        // 窄顶栏里 CUSTOM 与 PLAY AGAIN 共用 row3 左段（两者在宽顶栏本是左右相邻），
        // 终局时只画 PLAY AGAIN，否则两个按钮叠在同一块。
        if (!(rx < kHeaderContentW && this.playAgainVisible_))
            this.drawBtn(L.customBtn, 'CUSTOM', this.activeDiff_ === -1);
        this.drawBtn(L.seedBtn, 'SEED', false);
        if (this.playAgainVisible_) this.drawBtn(L.playAgainBtn, 'PLAY AGAIN', false, true);

        box(ctx, L.settingsBtn, kBtnBg, kBtnEdge, 1.4);
        gear(ctx, L.gearCX, L.gearCY, kInk, kBtnBg);

        box(ctx, L.restartBtn, kBtnBg, kBtnEdge, 1.5);
        {
            const rc = { x: L.restartBtn.x + 17, y: L.restartBtn.y + 17 };
            const a0 = -55 * Math.PI / 180, a1 = 215 * Math.PI / 180;
            arc(ctx, rc.x, rc.y, 9, a0, a1, 2.2, kInk);
            const ex = rc.x + 9 * Math.cos(a0), ey = rc.y + 9 * Math.sin(a0);
            const tx = Math.cos(a0 + Math.PI / 2), ty = Math.sin(a0 + Math.PI / 2);
            const nx = Math.cos(a0), ny = Math.sin(a0);
            ctx.beginPath();
            ctx.moveTo(ex + tx * 6, ey + ty * 6);
            ctx.lineTo(ex - tx * 2 + nx * 4.5, ey - ty * 2 + ny * 4.5);
            ctx.lineTo(ex - tx * 2 - nx * 4.5, ey - ty * 2 - ny * 4.5);
            ctx.closePath();
            ctx.fillStyle = css(kInk);
            ctx.fill();
        }

        // —— 统计行（宽度不够时按桌面端顺序逐段省略）——
        const u = this.ustcRects();
        const cols = this.board.cols(), rows = this.board.rows();
        const cnt = this.board.counts();
        const cells = cols * rows;
        const mineTotal = Math.max(1, this.board.mineCount());
        const safeTotal = Math.max(1, cells - this.board.mineCount());
        const pct = (v: number, total: number) => Math.min(100, 100 * v / total).toFixed(1) + '%';

        // 统计行独占一行（复选框挪到 kRow.checkY 了），所以可以从顶栏左侧起算，
        // 不必再从药丸右侧绕。
        let sy = kRow.statY, sx = sx0;
        const statLimit = rx - 18;
        const seg = (text: string, gap: number) => { drawTL(ctx, text, 12, kInk, sx, sy); sx += textWidth(ctx, text, 12) + gap; };
        const segW = (text: string, gap: number) => textWidth(ctx, text, 12) + gap;

        const dimText = cols + ' x ' + rows;
        seg(dimText, 16);

        const minesText = 'mines ' + this.board.mineCount();
        const openedText = 'opened ' + cnt.openedSafe + '/' + safeTotal;
        const openedPct = ' (' + pct(cnt.openedSafe, safeTotal) + ')';
        const flaggedText = 'flagged ' + cnt.flagged + '/' + mineTotal;
        const flaggedPct = ' (' + pct(cnt.flagged, mineTotal) + ')';

        let showMines = L.hw >= 690;   // 设计宽（L.hw），不是缩放后的像素宽
        let showOpened = true, showFlagged = true, pctOpened = true, pctFlagged = true;
        const gap = 16;
        const openedFull = () => openedText + (pctOpened ? openedPct : '');
        const flaggedFull = () => flaggedText + (pctFlagged ? flaggedPct : '');
        const need = () => {
            let n = 0;
            if (showMines) n += segW(minesText, gap);
            if (showOpened) n += segW(openedFull(), gap);
            if (showFlagged) n += segW(flaggedFull(), gap);
            return n;
        };
        while (sx + need() > statLimit) {
            if (showMines) { showMines = false; continue; }
            if (pctFlagged) { pctFlagged = false; continue; }
            if (pctOpened) { pctOpened = false; continue; }
            if (showFlagged) { showFlagged = false; continue; }
            if (showOpened) { showOpened = false; break; }
            break;
        }
        let openedX = sx, flaggedX = sx;
        if (showMines) seg(minesText, gap);
        if (showOpened) { openedX = sx; seg(openedFull(), gap); }
        if (showFlagged) { flaggedX = sx; seg(flaggedFull(), gap); }

        // —— 进度条 ——
        const by = kRow.statY + 22;
        const bar = (x: number, w: number, frac: number) => {
            if (w < 12) return;
            // 轨道：白底 + 灰蓝边（与按钮同族），填充走 66CCFF 家族的青蓝。
            // 曾用亮绿 #90EE90，但"绿"在本作里是纯虚轴提示 kImagHint 的语义色，容易被误读。
            box(ctx, R(x, by, w, 8), kBtnBg, kBtnEdge, 1.6);
            const iw = Math.max(1, (w - 3.2) * clampF(frac, 0, 1));
            fillRect(ctx, R(x + 1.6, by + 1.6, iw, 4.8), kBarFill);
        };
        // 宽度上限用**局部坐标**的右缘（rx），不是 winW。顶栏是 translate 过 sideX 的，
        // 用 winW 算等于把 sideX 算了两遍，进度条会捅出顶栏右缘。
        // 还要让开下一行的复选框组（magBox 是三个里最左的）：擦到就是 2px 重叠。
        const barLimit = Math.min(rx - 16, u.magBox.x - 10);
        let bx = showOpened ? openedX : sx;
        let bw = Math.min(150, barLimit - bx);
        bar(bx, bw, cnt.openedSafe / safeTotal);
        bx += bw + 8;
        if (showFlagged) {
            bw = Math.min(110, barLimit - bx);
            bar(bx, bw, cnt.flagged / mineTotal);
        }

        // —— 三个复选框 ——
        const cb = (b: Rect, label: Rect, on: boolean, text: string) => {
            // 描边曾用 kCovered(#66CCFF)：亮青在顶栏半透明、底下是明亮天空时几乎融掉，
            // 只剩一个白方块。改 kBtnEdge 后与难度按钮同族，亮背景下也能看出这是可点的框。
            box(ctx, b, kBtnBg, kBtnEdge, 1.6);
            if (on) checkMark(ctx, b.x, b.y, kInk);
            drawTL(ctx, text, 12, kInk, label.x, label.y + 4);
        };
        cb(u.ustcBox, u.ustcLabel, this.ustcMode_, '红专并进 理实交融');
        cb(u.magBox, u.magLabel, this.alwaysMagnitude_, '总是显示模长');
        cb(u.hideBox, u.hideLabel, this.hideCounts_, '隐藏计数');

        // —— 背景不透明度 ——
        // 纯色背景时整行不画：不透明度只作用于图片，纯色下拖它没有任何反馈，
        // 留着就是个骗人的控件。**只隐藏不重排** —— 收起空间要动 kRow/换行逻辑，
        // 收益不值那个风险，留一块空位即可。
        if (!this.bgIsSolid()) {
            const t = L.bgTrack, v = L.bgValue;
            const lbl = 'OPACITY';
            const lx = v.x - 8 - textWidth(ctx, lbl, 11);
            drawTL(ctx, lbl, 11, kInkSoft, lx, t.y - 3);
            const frac = clampF(this.cfg.bgAlpha / kBgAlphaMax, 0, 1);
            fillRect(ctx, t, kPanel);
            fillRect(ctx, R(t.x, t.y, t.w * frac, t.h), kBtnActive);
            circle(ctx, t.x + t.w * frac, t.y + 4, 7, kBtnBg, kBtnActive, 2);
            if (this.setupFocus_ === 4) {
                // 正在输入时才提示上限：超过 75 的数字会被直接丢弃，不说明的话像是键盘坏了。
                const hint = '上限 75%';
                drawTL(ctx, hint, 10, kInkSoft, lx - 10 - textWidth(ctx, hint, 10), t.y - 2);
                box(ctx, v, kHover, kBtnActive, 1.6);
                const txt = (this.setupEdit2_ !== '' ? this.setupEdit2_ : '_') + '%';
                drawC(ctx, txt, 12, kInk, v.x + v.w / 2, v.y + v.h / 2, 0.5);
            } else {
                drawC(ctx, Math.round(this.cfg.bgAlpha / 2.55) + '%', 12, kBtnActive, v.x + v.w / 2, v.y + v.h / 2, 0.4);
            }
        }

        // —— 药丸 ——
// 行位由 kHeaderRows 统一给出，不要在这里写死 y（写死过一次，导致药丸高 28px
// 从 y=116 铺到144、冲出顶栏 138 并压住统计行，见 kHeaderH 的注释）。
this.drawPill(kRow.pillY, sx0, 116, 'MINES LEFT', fmt3(hud.remaining), false, false,
              this.counterFlip_ ? { from: fmt3(this.counterFlip_.from), t: this.counterFlip_.t } : null,
              hud.remaining < 0); // 多插旗为负，红色提醒（2026-10-29 用户裁决）
this.drawPill(kRow.pillY, sx0 + 124, 92, hud.paused ? 'TIME PAUSED' : 'TIME',
              hud.seconds.toFixed(1) + 's', true, hud.paused);

        // —— 计数芯片（含黄色闪烁）——
        if (!this.hideCounts_ && hud.phase === Phase.Playing) {
            const started = this.board.started();
            const pillY = kRow.row2y;      // 与药丸同行（行位统一由 kRow 给）
            // 芯片起点要让开药丸右缘，且不能压住右侧按钮排
            // （row2 上最左的按钮是 custom —— seed/settings 都在它右边）。
            //
            // ⚠️ **放不下时必须换行，绝不能跳过某颗**。我第一版写成
            // "放不下就break"，截图里 ±i 芯片直接消失了 —— 玩家看不到虚雷计数，
            // 那是**信息丢失**，比布局难看严重得多。
            const row2BtnLeft = Math.min(this.L.customBtn.x, this.L.seedBtn.x) - 10;
            // 与桌面端 Renderer.cpp 同一条规则：row2 放得下就**收紧步长**把芯片留在原行
            //（单颗下限 62 = 圆+计数文字的实际墨迹宽），放不下才换行。
            // 原来按整步 84 判"放不放得下"，636 宽的顶栏（1512×872 窗口实测）差 14px 就把
            // 芯片挤去图例行、图例全文被降级成图标——而桌面端同一尺寸图例是全文，两端不一致。
            const K_CHIP_MIN = 62;
            let chipX = sx0 + 226;
            let cy = pillY;
            let step = CHIP_W;
            const room2 = row2BtnLeft - chipX;
            if (room2 >= chips.length * K_CHIP_MIN) {
                step = Math.min(CHIP_W, Math.floor(room2 / chips.length));
            } else {
                // 换行：窄顶栏落 row4 左段（row3 左段是 CUSTOM，OPACITY 已收去齿轮左侧），
                // 宽顶栏落 row3 左段；步长按落点行的剩余空间收，避免擦到同行控件。
                chipX = sx0;
                chipsWrapped = true;
                chipStartX = chipX;
                if (rx < kHeaderContentW) {
                    cy = kRow.row4y;
                    const olw = Math.round(textWidth(ctx, 'OPACITY', 11));
                    const room = (L.bgValue.x - 8 - olw) - sx0 - 6;
                    step = Math.max(K_CHIP_MIN, Math.min(CHIP_W, Math.floor(room / chips.length)));
                } else {
                    cy = kRow.chipWrapY;
                }
            }
            chipSpan = chips.length * step;
            for (const ch of chips) {
                const fl = clampF(this.chipFlash_[ch.slot], 0, 1);
                const done = ch.grayZero && started && ch.left === 0;
                const baseCol = !started ? kInkSoft : (done ? kZeroHint : ch.col);
                const fillC = mix(C(255, 255, 255, 235), C(255, 214, 10, 250), fl);
                const edgeC = mix(baseCol, C(255, 176, 0), fl);
                const textC = mix(baseCol, C(84, 62, 0), fl);
                const rad = 11 + 1.6 * fl;
                circle(ctx, chipX + 11, cy + 14, rad, fillC, edgeC, 2);
                drawC(ctx, ch.sw, 10, textC, chipX + 11, cy + 14, 0.3);
                drawTL(ctx, started ? 'x' + ch.left : 'x?', 13, textC, chipX + 27, cy + 6, 0.5);
                chipX += step;
            }
        }

        // —— 图例 ——
        {
            const ly = kRow.row3y;
            type Item = { sw: string; col: Col; desc: string };
            const items: Item[] = [
                { sw: '+1', col: kRealHint, desc: ' real sum' },
                { sw: '+i', col: kImagHint, desc: ' imag sum' },
                { sw: 'n', col: kMixHint, desc: ' mixed |sum|' },
                { sw: '0', col: kZeroHint, desc: ' canceled' }
            ];
            if (this.alwaysMagnitude_) items.push({ sw: 'm', col: kInk, desc: ' mines left |mod| mode' });
            else { items.push({ sw: '±1', col: kRealMine, desc: ' real mine' }); items.push({ sw: '±i', col: kImagMine, desc: ' imag mine' }); }
            // 芯片换行到 row3 时图例**排在芯片右边**（而不是被挤到零宽）：
            // 芯片只占 168px，row3 还有几百 px 富余，让图例整体消失是信息丢失。
            // 未换行时芯片在 row2，row3 整行从 sx0 起、右界钳在 rx-18 留呼吸位。
            // 窄顶栏：芯片换去了 row4，row3 左段是 CUSTOM，图例从它右边起。
            const legendStart = rx < kHeaderContentW
                ? L.customBtn.x + L.customBtn.w + 12
                : (chipsWrapped ? chipStartX + chipSpan + 12 : sx0);
            const maxW = Math.max(0, (rx - 18) - legendStart);
            const segFull = (it: Item) => Math.round(textWidth(ctx, it.sw, 11)) + 4 + Math.round(textWidth(ctx, it.desc, 11)) + 12;
            const segIcon = (it: Item) => Math.round(textWidth(ctx, it.sw, 11)) + 14;
            // 空间不足时先整体降级为「只画色块符号」，仍放不下才开始删项：
            // 六个图标携带的信息远多于两段完整文字，删项是最后手段而非第一手段。
            const iconOnly = items.reduce((s, it) => s + segFull(it), 0) > maxW;
            const segW2 = iconOnly ? segIcon : segFull;
            const visible = items.map(() => true);
            const total = () => visible.reduce((s, v, i) => s + (v ? segW2(items[i]) : 0), 0);
            // 省略顺序：从最次要的（数值 0、混合、模长…）开始删。
            // **必须能删到 0 项**——原来窗口窄，删 4 项就够；窗口铺满后
            // 这一行右边是 TIME 药丸，可��宽度只剩约 118px，删光都不够，
            // 于是图例会压到 TIME 上。故改成遍历全部项、逐个删到放得下为止。
            const dropOrder = this.alwaysMagnitude_
                ? [3, 2, 4, 0, 1]
                : [3, 2, 5, 4, 0, 1];
            for (const i of dropOrder) {
                if (total() <= maxW) break;
                if (i < visible.length) visible[i] = false;
            }
            let x = legendStart;
            for (let i = 0; i < items.length; ++i) {
                if (!visible[i]) continue;
                const it = items[i];
                drawTL(ctx, it.sw, 11, it.col, x, ly);
                x += Math.round(textWidth(ctx, it.sw, 11)) + (iconOnly ? 14 : 4);
                if (iconOnly) continue;
                drawTL(ctx, it.desc, 11, kInkSoft, x, ly);
                x += Math.round(textWidth(ctx, it.desc, 11)) + 12;
            }
        }
    }

    // ================================================================
    //  棋盘格子
    // ================================================================

    private coveredColors() {
        const r = this.cfg.cellR, g = this.cfg.cellG, b = this.cfg.cellB;
        const fill = C(r, g, b);
        const edge = C(Math.floor(r * 4 / 5), Math.floor(g * 4 / 5), Math.floor(b * 4 / 5));
        const hover = C(Math.floor((r + 765) / 4), Math.floor((g + 765) / 4), Math.floor((b + 765) / 4));
        return { fill, edge, hover };
    }

    private cellRect(r: number, c: number): Rect {
        const p = this.L.pitch;
        return R(this.L.boardX + c * p, this.L.boardY + r * p, this.L.cell, this.L.cell);
    }

    private drawCellBg(r: number, c: number, phase: Phase, hovered: boolean): void {
        const ctx = this.ctx;
        const cell = this.board.at(r, c);
        const rect = this.cellRect(r, c);
        const idx = r * this.board.cols() + c;
        const badMark = phase !== Phase.Playing && cell.flag !== MineType.None &&
            (cell.mine === MineType.None || cell.mine !== cell.flag);
        const cv = this.coveredColors();
        if (cell.opened) {
            const rv = this.revealOf(idx, this.nowMs_);
            if (rv < 0) { this.coveredBox(rect, cv.fill, cv.edge, idx); return; }  // 波前未到：先按未开画
            if (rv < 1) this.coveredBox(rect, cv.fill, cv.edge, idx);              // 垫一层未开样式再淡入
            // 三种"已翻开"底色必须分得开：真空格（无字、会连锁展开）/
            // 有雷但和为零（黄 0）/ 普通数字格。
            const fill = cell.exploded ? kBoomBg
                : cell.adjTotal === 0 ? kOpenedZero
                    : (cell.adjReal === 0 && cell.adjImag === 0 ? kOpenedCancel : kOpened);
            if (rv < 1) ctx.globalAlpha = rv;
            box(ctx, rect, fill, kGridLine, 1);
            if (rv < 1) ctx.globalAlpha = 1;
        } else if (badMark) {
            this.coveredBox(rect, kBadFlagBg, cv.edge, idx);
        } else if (hovered) {
            this.coveredBox(rect, cv.hover, cv.edge, idx);
        } else {
            this.coveredBox(rect, cv.fill, cv.edge, idx);
        }
    }

    private drawCellContent(r: number, c: number, phase: Phase): void {
        const ctx = this.ctx;
        const cell = this.board.at(r, c);
        const rect = this.cellRect(r, c);
        const idx = r * this.board.cols() + c;
        const badMark = phase !== Phase.Playing && cell.flag !== MineType.None &&
            (cell.mine === MineType.None || cell.mine !== cell.flag);
        if (cell.opened) {
            const rv = this.revealOf(idx, this.nowMs_);
            if (rv < 0) return;                       // 波前未到：内容先不露
            ctx.save();
            if (rv < 1) {
                ctx.globalAlpha = rv;
                const k = 0.8 + 0.2 * rv, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
                ctx.translate(cx, cy); ctx.scale(k, k); ctx.translate(-cx, -cy);
            }
            if (cell.mine !== MineType.None) {
                const la = this.lossAlpha(r, c, this.nowMs_);
                if (la > 0) {
                    if (la < 1) ctx.globalAlpha *= la;
                    this.drawMineDot(rect, cell.mine, cell.exploded);
                }
            } else this.drawHint(rect, cell.adjReal, cell.adjImag, cell.adjTotal);
            ctx.restore();
            return;
        }
        if (cell.flag !== MineType.None) {
            const pop = this.flagPop(idx);
            ctx.save();
            const sh = badMark ? this.shakeDx(this.nowMs_) : 0;
            if (sh !== 0) ctx.translate(sh, 0);
            const img = this.markerImgs_[cell.flag];
            if (img) {
                const s = this.L.cell * 0.78 * pop.scale;
                ctx.drawImage(img, rect.x + (this.L.cell - s) / 2, rect.y + (this.L.cell - s) / 2, s, s);
            } else {
                this.drawMarkerBadge(rect, cell.flag, pop.scale);
            }
            if (pop.ring > 0) {
                const rp = pop.ring, col = mineColor(cell.flag);
                ctx.beginPath();
                ctx.arc(rect.x + this.L.cell / 2, rect.y + this.L.cell / 2,
                    this.L.cell * 0.30 + rp * this.L.cell * 0.45, 0, Math.PI * 2);
                ctx.strokeStyle = `rgba(${col.r},${col.g},${col.b},${(0.55 * (1 - rp)).toFixed(3)})`;
                ctx.lineWidth = 2;
                ctx.stroke();
            }
            if (badMark) {
                const a = this.L.cell * 0.18, b = this.L.cell * 0.82;
                thickLine(ctx, rect.x + a, rect.y + a, rect.x + b, rect.y + b, 2.4, kBadMark);
                thickLine(ctx, rect.x + b, rect.y + a, rect.x + a, rect.y + b, 2.4, kBadMark);
            }
            ctx.restore();
            return;
        }
        if (this.ustcMode_) {
            // 纯哈希决定字母（不消耗游戏随机数流，否则会破坏同种子复现）。
            // ⚠️ 本式与桌面端 Renderer.cpp 的 USTC 彩蛋**逐位对应**，改一处必须改另一处。
            // 旧版只取 (h >>> 7) % 4 两个 bit → 16 行里只有 4 种排列，整盘看着像平铺水印
            // （换种子也只是四个字母整体置换）。这里补一段 murmur3 式的 32 位雪崩。
            let h = (Math.imul(r, 0x27d4eb2d) ^ Math.imul(c, 0x165667b1) ^ Math.imul(this.board.seed(), 0x9e3779b1)) >>> 0;
            h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x7feb352d) >>> 0;
            h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x846ca68b) >>> 0;
            h = (h ^ (h >>> 16)) >>> 0;
            const ch = 'USTC'[h & 3];
            drawC(ctx, ch, 20, kUstcGray, rect.x + this.L.cell / 2, rect.y + this.L.cell / 2);
            // 这里**不能** return：终局揭晓雷要走下面的分支，与桌面端 Renderer.cpp:612-626 一致
            // （桌面画完 USTC 字母后继续执行 drawMineDot，两者叠着画，雷点压在字母上）。
            // 历史 bug：原先这里提前 return，勾选 USTC 后败局看不到雷在哪。
        }
        if (phase !== Phase.Playing && cell.mine !== MineType.None) {
            const la = this.lossAlpha(r, c, this.nowMs_);
            if (la > 0) {
                if (la < 1) ctx.globalAlpha = la;
                this.drawMineDot(rect, cell.mine, false);
                if (la < 1) ctx.globalAlpha = 1;
            }
        }
    }

    /** 标记徽章弹入：落定过冲 + 落定光环进度（0 = 不画光环） */
    private flagPop(idx: number): { scale: number; ring: number } {
        const t0 = this.flagAt_ ? this.flagAt_[idx] : 0;
        if (!t0 || !animOn(this.cfg.animFx)) return { scale: 1, ring: 0 };
        const age = this.nowMs_ - t0;
        if (age < 0) return { scale: 1, ring: 0 };
        const p = Math.min(1, age / kAnimMs.badgePop);
        const rp = age / kAnimMs.badgeRing;
        return { scale: easeOutBack(p), ring: rp < 1 ? rp : 0 };
    }

    private drawMarkerBadge(rect: Rect, t: MineType, scale = 1): void {
        const ctx = this.ctx;
        const cs = this.L.cell;
        const cx = rect.x + cs / 2, cy = rect.y + cs / 2;
        const col = mineColor(t);
        ctx.save();
        if (scale !== 1) { ctx.translate(cx, cy); ctx.scale(scale, scale); ctx.translate(-cx, -cy); }
        circle(ctx, cx, cy, cs * 0.30, C(255, 255, 255, 235), col, 2.2);
        const custom = this.cfg.marker[t].ch;
        const glyph = custom !== '' ? custom : mineGlyph(t);
        drawC(ctx, glyph, cs * 0.34, col, cx, cy, 0.4);
        ctx.restore();
    }

    private drawRipples(nowMs: number): void {
        if (!animOn(this.cfg.animFx) || this.ripples_.length === 0) return;
        const ctx = this.ctx;
        for (let i = this.ripples_.length - 1; i >= 0; --i) {
            const rp = this.ripples_[i];
            const p = (nowMs - rp.t) / kAnimMs.ripple;
            if (p >= 1) { this.ripples_.splice(i, 1); continue; }
            if (p < 0) continue;
            ctx.beginPath();
            ctx.arc(rp.x, rp.y, 6 + 30 * easeInOut(p), 0, Math.PI * 2);
            ctx.strokeStyle = `rgba(60,70,90,${(0.35 * (1 - p)).toFixed(3)})`;
            ctx.lineWidth = 2.5;
            ctx.stroke();
        }
    }

    /** 取消标记的缩小退场（棋盘坐标系内调用） */
    private drawDyingFlags(nowMs: number): void {
        const ctx = this.ctx;
        for (let i = this.dying_.length - 1; i >= 0; --i) {
            const d = this.dying_[i];
            const p = (nowMs - d.at) / kAnimMs.badgeDie;
            if (p >= 1) { this.dying_.splice(i, 1); continue; }
            if (p < 0) continue;
            this.drawMarkerBadge(this.cellRect(d.r, d.c), d.t as MineType, 1 - easeInOut(p));
        }
    }

    /** 胜利星座线：雷位绕质心连成星形环，线段错峰生长、整体保留后淡出（棋盘坐标系） */
    private drawConstellation(nowMs: number, zoomed: boolean,
                              v: { s: number; tx: number; ty: number }): void {
        const w = this.win_;
        if (!w) return;
        const total = (w.pts.length - 1) * kAnimMs.winSegStep + kAnimMs.winSegGrow;
        const age = nowMs - w.t;
        if (age > total + kAnimMs.winHold + kAnimMs.winFade) { this.win_ = null; return; }
        const fade = age <= total + kAnimMs.winHold
            ? 1 : Math.max(0, 1 - (age - total - kAnimMs.winHold) / kAnimMs.winFade);
        const ctx = this.ctx;
        ctx.save();
        if (zoomed) {
            const vp = this.boardViewport();
            ctx.beginPath();
            ctx.rect(vp.x, vp.y, vp.w, vp.h);
            ctx.clip();
            ctx.transform(v.s, 0, 0, v.s, v.tx, v.ty);
        }
        ctx.lineCap = 'round';
        for (let i = 0; i < w.pts.length; ++i) {
            const a = w.pts[i], b = w.pts[(i + 1) % w.pts.length];
            const seg = age - i * kAnimMs.winSegStep;
            if (seg <= 0) continue;
            const p = Math.min(1, seg / kAnimMs.winSegGrow);
            const ex = a.x + (b.x - a.x) * easeInOut(p), ey = a.y + (b.y - a.y) * easeInOut(p);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(ex, ey);
            ctx.strokeStyle = `rgba(214,158,46,${(0.22 * fade).toFixed(3)})`;
            ctx.lineWidth = 5;
            ctx.stroke();
            ctx.strokeStyle = `rgba(146,102,10,${(0.8 * fade).toFixed(3)})`;
            ctx.lineWidth = 1.6;
            ctx.stroke();
        }
        ctx.restore();
    }

    private drawMineDot(rect: Rect, t: MineType, exploded: boolean): void {
        const ctx = this.ctx;
        const cs = this.L.cell;
        const cx = rect.x + cs / 2, cy = rect.y + cs / 2;
        const col = mineColor(t);
        circle(ctx, cx, cy, cs * 0.30, col, C(20, 20, 20, 90), 1.5);
        const custom = this.cfg.marker[t].ch;
        const glyph = custom !== '' ? custom : mineGlyph(t);
        drawC(ctx, glyph, cs * 0.34, C(255, 255, 255), cx, cy, 0.4);
    }

    private drawHint(rect: Rect, re: number, im: number, adjTotal: number): void {
        const ctx = this.ctx;
        const cs = this.L.cell;
        const cx = rect.x + cs / 2, cy = rect.y + cs / 2;
        if (adjTotal === 0) {
            const img = this.blankImg_;
            const ch = this.cfg.blank.ch;
            if (img) {
                const s = cs * 0.6;
                ctx.drawImage(img, cx - s / 2, cy - s / 2, s, s);
            } else if (ch !== '') {
                drawC(ctx, ch, cs * 0.5, kZeroHint, cx, cy, 0.5);
            }
            return;
        }
        const s = squaredMagnitude(re, im);
        if (s === 0) { cancelZero(ctx, cx, cy, cs); return; }
        const kind = hintKind(re, im);
        const col = this.alwaysMagnitude_ ? kMixHint
            : (kind === HintKind.PureReal ? kRealHint : (kind === HintKind.PureImag ? kImagHint : kMixHint));
        const f = largestSquareFactor(s);
        const rr = s / (f * f);
        if (rr === 1) {
            const str = this.alwaysMagnitude_ ? String(f) : formatHintSigned(re, im);
            let fs = cs * 0.58;
            let w = textWidth(ctx, str, fs);
            if (w > cs * 0.8) { fs *= cs * 0.8 / w; }
            drawC(ctx, str, fs, col, cx, cy, 0.7);
            return;
        }
        const coef = f > 1 ? String(f) : '';
        const rad = String(rr);
        let fs = cs * 0.58;
        const measure = (size: number) => {
            const coefW = coef ? textWidth(ctx, coef, size) : 0;
            const radW = textWidth(ctx, rad, size * 0.86);
            const gw = Math.max(7, size * 0.34);
            return { coefW, radW, gw, total: coefW + gw + radW };
        };
        let m = measure(fs);
        const maxW = cs * 0.88;
        if (m.total > maxW) { fs *= maxW / m.total; m = measure(fs); }
        let x = cx - m.total / 2;
        if (coef) drawC(ctx, coef, fs, col, x + m.coefW / 2, cy, 0.7);
        const dh = fs * 0.72;
        radicalSign(ctx, x + m.coefW, cy - dh * 0.5 - 1.5, cy + dh * 0.42, m.radW + 2, Math.max(1.5, fs * 0.07), col);
        x += m.coefW + m.gw;
        drawC(ctx, rad, fs * 0.86, col, x + m.radW / 2, cy + fs * 0.03, 0.7);
    }

    // ================================================================
    //  胜负覆盖层
    // ================================================================

    /**
     * 触摸端的一行操作提示（桌面端不画）。
     * 捏合缩放/长按标记都是"看不见的功能"，不写出来就没人知道；
     * 但底部没空间时宁可不画，也绝不越界或压住棋盘。
     */
    private drawTouchHint(): void {
        if (!this.coarse_) return;
        if (this.view_.s > 1.001) return;   // 已经放大了，提示失去意义
        const L = this.L, vp = this.boardViewport();
        const cy = L.boardY + L.boardH + 12;
        if (cy + 7 > vp.y + vp.h) return;
        const msg = L.cell >= 30 ? '长按格子可标记 · 双击已开数字可连开'
                                 : '双指捏合放大棋盘 · 长按格子可标记';
        const maxW = L.winW - 16;
        if (textWidth(this.ctx, msg, 11) <= maxW) drawC(this.ctx, msg, 11, kInkSoft, L.winW / 2, cy);
        else drawTLFit(this.ctx, msg, 11, kInkSoft, 8, cy - 5, maxW);
    }

    private drawOverlay(hud: Hud): void {
        if (hud.phase === Phase.Playing || this.overlayHidden_) return;
        const ctx = this.ctx, L = this.L;
        const win = hud.phase === Phase.Won;
        const band = this.overlayBand();
        fillRect(ctx, band, C(255, 255, 255, 216));
        const col = win ? C(22, 128, 85) : C(192, 57, 43);
        drawC(ctx, win ? 'CLEARED' : 'BOOM', 42, col, L.winW / 2, band.y + 42, 1);
        drawC(ctx, win ? 'all complex mines identified - click the round button to replay'
            : 'a complex mine detonated - click the round button to replay',
            13, kInkSoft, L.winW / 2, band.y + 82);
        // 桌面端规格：横幅按钮始终绘制（playAgainVisible_ 只门控表头 PLAY AGAIN 与点击命中）
        {
            const b = this.overlayBtns();
            const mp = this.mousePx_;
            const btn = (rect: Rect, label: string) => {
                const on = inside(rect, mp.x, mp.y);
                box(ctx, rect, on ? kBtnActive : kBtnBg, on ? kBtnActive : kBtnEdge, 1.5);
                drawC(ctx, label, 12, on ? C(255, 255, 255) : kInk, rect.x + rect.w / 2, rect.y + rect.h / 2, 0.45);
            };
            btn(b.same, 'SAME ROUND');
            btn(b.next, 'NEW GAME');
        }
        drawC(ctx, '单击框外可隐藏此提示', 12, kInkSoft, L.winW / 2, band.y + 150);
    }

    // ================================================================
    //  右键标记菜单
    // ================================================================

    private drawMenu(): void {
        if (!this.menuOpen_) return;
        const ctx = this.ctx;
        const r = this.menuRect_;
        fillRect(ctx, R(r.x + 3, r.y + 3, r.w + 5, r.h + 5), C(0, 0, 0, 45));
        box(ctx, r, kBtnBg, kBtnActive, 1.6);
        const mp = this.mousePx_;
        for (let i = 0; i < this.menuOptions_.length; ++i) {
            const iy = r.y + i * kMenuItemH + 1;
            const item = R(r.x + 2, iy, r.w - 4, 28);
            if (inside(item, mp.x, mp.y) || i === this.menuIndex_) fillRect(ctx, item, kHover);
            const mt = this.menuOptions_[i];
            const col = mt === MineType.None ? kInkSoft : mineColor(mt);
            const cy = iy + 15, cx = r.x + 18;
            circle(ctx, cx, cy, 9, C(255, 255, 255, 240), col, 1.8);
            const img = mt === MineType.None ? null : this.markerImgs_[mt];
            if (img) ctx.drawImage(img, cx - 8, cy - 8, 16, 16);
            else if (mt !== MineType.None) drawC(ctx, mineGlyph(mt), 9, col, cx, cy, 0.2);
            const label = mt === MineType.None ? 'clear' : mineGlyph(mt);
            drawTL(ctx, label, 12, col, r.x + 34, cy - 7);
        }
    }

    // ================================================================
    //  自定义局面面板
    // ================================================================

    private drawSetup(): void {
        if (!this.setupOpen_) return;
        const ctx = this.ctx, L = this.L;
        const r = this.setupRects();
        const P = r.panel;
        fillRect(ctx, R(0, 0, L.winW, L.winH), C(20, 30, 45, 120));
        fillRect(ctx, R(P.x + 4, P.y + 4, P.w + 6, P.h + 6), C(0, 0, 0, 60));
        box(ctx, P, kBtnBg, kBtnActive, 2);
        drawTL(ctx, 'CUSTOM GAME', 16, kInk, P.x + 18, P.y + 16, 0.5);

        const cfg = this.setupCfg_;
        const names = ['ROWS', 'COLS', 'MINES'];
        const ranges = [
            ' (5~' + cfg.maxRows + ')', ' (5~' + cfg.maxCols + ')', ' (1~' + (cfg.cols * cfg.rows - 1) + ')'
        ];
        const values = [String(cfg.rows), String(cfg.cols), String(cfg.mines())];
        const glyphs = ['--', '-', '+', '++'];
        for (let i = 0; i < 3; ++i) {
            const row = r.rows[i];
            drawTL(ctx, names[i] + ranges[i], 12, kInkSoft, P.x + 18, row.label.y);
            if (i === 2 && cfg.splitManual) {
                // 这行是退出「手动分型」的唯一入口，必须画成按钮并写明，否则用户点了
                // SET SPLIT 之后找不到回头路（此前只是一行裸文字，没有任何可供性）。
                box(ctx, row.value, kHover, kBtnActive, 1.6);
                drawC(ctx, cfg.mines() + ' = r + i', 12, kZeroHint, row.value.x + row.value.w / 2, row.value.y + 13);
            } else {
                const boxes = [row.minus5, row.minus, row.plus, row.plus5];
                for (let k = 0; k < 4; ++k) {
                    box(ctx, boxes[k], kBtnBg, kBtnEdge, 1.4);
                    drawC(ctx, glyphs[k], 16, kInk, boxes[k].x + boxes[k].w / 2, boxes[k].y + boxes[k].h / 2, 0.4);
                }
                const focused = this.setupFocus_ === i + 1;
                box(ctx, row.value, focused ? kHover : kBtnBg, focused ? kBtnActive : kBtnEdge, focused ? 1.6 : 1.4);
                const txt = focused ? (this.setupEdit2_ !== '' ? this.setupEdit2_ : '_') : values[i];
                drawC(ctx, txt, 16, kInk, row.value.x + row.value.w / 2, row.value.y + 13);
            }
        }

        // SET SPLIT 与虚实滑条互斥（桌面端规格）
        if (!cfg.splitManual) {
            const b = r.splitBtn;
            box(ctx, b, kBtnBg, kBtnEdge, 1.4);
            drawC(ctx, 'SET SPLIT', 11, kInk, b.x + b.w / 2, b.y + b.h / 2);
            drawTL(ctx, 'mines -> random real/imag split', 11, kInkSoft, b.x + b.w + 12, b.y + 8);
        }
        if (cfg.splitManual) {
            const slider = (t: Rect, name: string, val: number, cap: number, col: Col) => {
                drawTL(ctx, name + ' (0~' + cap + ')', 11, kInkSoft, P.x + 18, t.y - 3);
                fillRect(ctx, t, kPanel);
                const frac = cap > 0 ? clampF(val / cap, 0, 1) : 0;
                fillRect(ctx, R(t.x, t.y, t.w * frac, t.h), col);
                circle(ctx, t.x + t.w * frac, t.y + t.h / 2, 8, kBtnBg, col, 2);
                drawC(ctx, String(val), 13, col, t.x + t.w + 26, t.y + 4);
            };
            const cap = cfg.capacity();
            slider(r.realTrack, 'REAL', cfg.realCount, cap, kRealMine);
            slider(r.imagTrack, 'IMAG', cfg.imagCount, cap, kImagMine);
            drawTL(ctx, 'drag a slider: total = real + imag', 10.5, kInkSoft, P.x + 18, r.realTrack.y + 54);
            drawTL(ctx, 'click the number box to exit split', 10.5, kInkSoft, P.x + 18, r.realTrack.y + 68);
        }

        box(ctx, r.startBtn, kBtnActive, kBtnActive, 1.5);
        drawC(ctx, 'START', 14, C(255, 255, 255), r.startBtn.x + r.startBtn.w / 2, r.startBtn.y + r.startBtn.h / 2, 0.5);
        box(ctx, r.cancelBtn, kBtnBg, kBtnEdge, 1.5);
        drawC(ctx, 'CANCEL', 14, kInk, r.cancelBtn.x + r.cancelBtn.w / 2, r.cancelBtn.y + r.cancelBtn.h / 2, 0.5);
    }

    private seedPanelButton(rect: Rect, label: string, primary: boolean): void {
        const ctx = this.ctx;
        box(ctx, rect, primary ? kBtnActive : kBtnBg, primary ? kBtnActive : kBtnEdge, 1.4);
        drawC(ctx, label, 13, primary ? C(255, 255, 255) : kInk, rect.x + rect.w / 2, rect.y + rect.h / 2, 0.5);
    }

    private drawSeedUi(): void {
        if (this.seedStage_ === SeedStage.None) { this.drawSeedNote(); return; }
        const ctx = this.ctx;
        const r = this.seedRects();
        const panel = (rect: Rect) => box(ctx, rect, kPanel, kBtnEdge, 1.6);
        const mp = this.mousePx_;

        if (this.seedStage_ === SeedStage.Menu) {
            panel(r.menu);
            const labels = ['COPY SEED', 'SAVE PROGRESS', 'LOAD SEED / SAVE', 'SEED TOOLBOX'];
            for (let i = 0; i < 4; ++i) {
                const it = r.items[i];
                const en = this.seedMenuEnabled(i);
                if (en && (inside(it, mp.x, mp.y) || i === this.seedMenuItem_)) fillRect(ctx, it, kHover);
                drawTL(ctx, labels[i], 11, !en ? kInkSoft : kInk, it.x + 10, it.y + 7);
                if (i === 0) {
                    const s = this.seedShort_ !== '' ? shortSeed(this.seedShort_) : 'no seed yet (open a cell)';
                    drawTL(ctx, s, 10, this.seedShort_ !== '' ? kBtnActive : kInkSoft, it.x + 10, it.y + 22);
                } else if (i === 1) {
                    const s = this.seedSaveHint_ !== '' ? this.seedSaveHint_ : 'nothing to save yet';
                    drawTL(ctx, s, 10, this.seedSaveHint_ !== '' ? kImagMine : kInkSoft, it.x + 10, it.y + 22);
                } else if (i === 2) {
                    drawTL(ctx, 'paste a seed or a progress save', 10, kInkSoft, it.x + 10, it.y + 22);
                } else {
                    drawTL(ctx, 'decode / encode with your own key', 10, kInkSoft, it.x + 10, it.y + 22);
                }
            }
        } else if (this.seedStage_ === SeedStage.Load) {
            const d = r.dialog;
            panel(d);
            drawTL(ctx, 'LOAD SEED', 15, kInk, d.x + 20, d.y + 18);
            drawTL(ctx, 'paste a seed string (or type it), then press OK', 10, kInkSoft, d.x + 20, d.y + 40);
            const b = r.box;
            box(ctx, b, kBtnBg, kBtnActive, 1.4);
            ctx.save();
            ctx.beginPath();
            ctx.rect(b.x + 8, b.y, b.w - 16, b.h);
            ctx.clip();
            if (this.seedInput_ === '') {
                drawTL(ctx, '(empty)', 11, kInkSoft, b.x + 8, b.y + 12);
            } else {
                let x = b.x + 8 - this.seedScroll_;
                const sel = this.seedSelRange();
                const charW = (i: number) => textWidth(ctx, this.seedInput_[i], 12);
                if (sel) {
                    let sxp = b.x + 8 - this.seedScroll_;
                    for (let i = 0; i < sel[0]; ++i) sxp += charW(i);
                    let sw = 0;
                    for (let i = sel[0]; i < sel[1]; ++i) sw += charW(i);
                    fillRect(ctx, R(sxp, b.y + 4, sw, b.h - 8), C(kBtnActive.r, kBtnActive.g, kBtnActive.b, 110));
                }
                for (let i = 0; i < this.seedInput_.length; ++i) {
                    drawTL(ctx, this.seedInput_[i], 12, kInk, x, b.y + 11);
                    x += charW(i);
                }
                let cxp = b.x + 8 - this.seedScroll_;
                for (let i = 0; i < this.seedCaret_; ++i) cxp += charW(i);
                fillRect(ctx, R(cxp, b.y + 5, 1.6, b.h - 10), kBtnActive);
            }
            ctx.restore();
            drawTL(ctx, this.seedInput_.length + ' chars   (Cmd/Ctrl+C/V/X, right-click)', 10, kInkSoft, b.x + 8, b.y + 42);
            this.seedPanelButton(r.paste, 'PASTE', false);
            this.seedPanelButton(r.cancel, 'CANCEL', false);
            this.seedPanelButton(r.ok, 'OK', true);
        } else {
            const c = r.confirm;
            panel(c);
            drawTL(ctx, 'OVERWRITE CURRENT GAME?', 14, kInk, c.x + 20, c.y + 20);
            drawTL(ctx, this.seedOwLine1_, 12, kInk, c.x + 20, c.y + 46);
            drawTL(ctx, this.seedOwLine2_, 12, kInkSoft, c.x + 20, c.y + 68);
            drawTL(ctx, 'import it now, and this game will be lost', 10, kBadMark, c.x + 20, c.y + 94);
            this.seedPanelButton(r.yes, 'YES', true);
            this.seedPanelButton(r.no, 'NO', false);
        }

        if (this.seedBoxMenuOpen_) {
            const m = this.seedBoxMenuRect_;
            panel(m);
            const labels = ['CUT', 'COPY', 'PASTE', 'SELECT ALL'];
            for (let i = 0; i < 4; ++i) {
                const it = R(m.x, m.y + 28 * i, 136, 28);
                if (i === this.seedBoxMenuIndex_ || inside(it, mp.x, mp.y)) fillRect(ctx, it, kHover);
                drawTL(ctx, labels[i], 11, kInk, it.x + 10, it.y + 8);
            }
        }
        this.drawSeedNote();
    }

    private drawSeedNote(): void {
        if (this.seedNoteClock_ <= 0 || this.seedNote_ === '') return;
        const ctx = this.ctx, L = this.L;
        const note = this.seedNote_;
        const bad = note.startsWith('WRONG') || note.startsWith('BAD') ||
            note.startsWith('GRID') || note.startsWith('SAVE FAILED');
        // 提示现在带中文说明，串比较长；窗口放不下时缩字号，别让色块冲出屏幕。
        let size = 12;
        let w = Math.max(96, textWidth(ctx, note, size) + 24);
        if (w > L.winW - 16) { size = 10; w = Math.max(96, textWidth(ctx, note, size) + 24); }
        // seedBtn 存的是顶栏局部坐标（绘制时外层 translate 过），提示是在 draw() 顶层画的，
        // 必须先 absTop 换算到窗口坐标，否则会偏到左边 sideX 那么远的半空里。
        const b = this.absTop(L.seedBtn);
        const x = clampI(b.x + b.w - w, 8, Math.max(8, L.winW - w - 8));
        const rect = R(x, b.y + b.h + 6, w, 26);
        box(ctx, rect, bad ? kBadMark : kRealMine, bad ? kBadMark : kRealMine, 0);
        drawC(ctx, note, size, C(255, 255, 255), rect.x + rect.w / 2, rect.y + rect.h / 2, 0.5);
    }


    // ================================================================
    //  设置面板
    // ================================================================

    private settingsButton(b: Rect, label: string, primary: boolean): void {
        const ctx = this.ctx;
        box(ctx, b, primary ? kBtnActive : kBtnBg, primary ? kBtnActive : kBtnEdge, 1.4);
        drawC(ctx, label, 11, primary ? C(255, 255, 255) : kInk, b.x + b.w / 2, b.y + b.h / 2, 0.4);
    }
    private settingsBox(b: Rect, text: string, focused: boolean, size = 11): void {
        const ctx = this.ctx;
        box(ctx, b, focused ? kHover : kBtnBg, focused ? kBtnActive : kBtnEdge, 1.4);
        if (text !== '') drawTL(ctx, text, size, kInk, b.x + 6, b.y + 7);
    }
    private static imageName(dataUrl: string): string {
        if (dataUrl === '') return '(default)';
        // 背景可以是纯色（#rrggbb），那不是图片，直接原样显示色号
        if (dataUrl[0] === '#') return dataUrl;
        return 'custom image';
    }
    private hex2(v: number): string { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2).toUpperCase(); }

    private drawSettings(): void {
        if (!this.settingsOpen_) return;
        const ctx = this.ctx;
        const P = this.L.setPanel;
        const r = this.settingsRects();
        const v = this.settingsView();
        if (this.settingsScroll_ > v.maxS) this.settingsScroll_ = v.maxS;
        const sc = this.settingsScroll_;
        const Y = (y: number) => y - sc;
        const S = (b: Rect) => shifted(b, 0, -sc);

        box(ctx, P, kPanel, kBtnEdge, 1.8);
        drawTL(ctx, 'SETTINGS', 16, kInk, P.x + 22, P.y + 16);

        ctx.save();
        ctx.beginPath();
        ctx.rect(P.x + 1, v.viewTop, P.w - 2, v.viewH);
        ctx.clip();

        // BACKGROUND
        if (this.settingsInView(r.bgBox.y, 30)) {
            drawTL(ctx, 'BACKGROUND', r.labelSize, kInkSoft, r.labelX, Y(r.bgBox.y) + 7);
            {
                // 点这个框可以输入 #rrggbb 换成纯色底；要回内置图点右边的 DEFAULT
                const f13 = this.settingsFocus_ === 13;
                // 满 6 位会自动生效并清空输入缓冲，这时要回落到「显示当前值」，
                // 否则框里只剩一个孤零零的 '#'，看着像输入丢了
                const shown = (f13 && this.settingsEdit_ !== '')
                    ? '#' + this.settingsEdit_
                    : Renderer.imageName(this.cfg.background.dataUrl);
                this.settingsBox(S(r.bgBox), shown, f13, r.boxSize);
            }
            this.settingsButton(S(r.browseBg), r.s < 1 ? 'CHOOSE' : 'CHOOSE IMAGE', false);
            this.settingsButton(S(r.resetBg), 'DEFAULT', false);
        }
        // CELL COLOR
        if (this.settingsInView(r.hexField.y, 30)) {
            drawTL(ctx, 'CELL COLOR', r.labelSize, kInkSoft, r.labelX, Y(r.swatch.y) + 7);
            const cv = this.coveredColors();
            box(ctx, S(r.swatch), cv.fill, kBtnEdge, 1.4);
            this.settingsBox(S(r.hexField),
                this.settingsFocus_ === 5 ? '#' + this.settingsEdit_
                    : '#' + this.hex2(this.cfg.cellR) + this.hex2(this.cfg.cellG) + this.hex2(this.cfg.cellB),
                this.settingsFocus_ === 5);
            const names = ['R', 'G', 'B'], vals = [this.cfg.cellR, this.cfg.cellG, this.cfg.cellB];
            for (let i = 0; i < 3; ++i) {
                const f = S(r.rgbField[i]);
                drawTL(ctx, names[i], r.s < 1 ? 10 : 11, kInkSoft, f.x - Math.round(12 * r.s), f.y + 8);
                const focused = this.settingsFocus_ === 6 + i;
                const txt = focused && this.settingsEdit_ !== '' ? this.settingsEdit_ : String(vals[i]);
                this.settingsBox(f, txt, focused);
            }
            this.settingsButton(S(r.resetColor), 'RESET', false);
        }
        // 四种标记
        const labels = ['+1 MARKER', '-1 MARKER', '+i MARKER', '-i MARKER'];
        for (let i = 1; i <= 4; ++i) {
            const m = r.marker[i - 1];
            if (!this.settingsInView(m.field.y, 30)) continue;
            drawTL(ctx, labels[i - 1], r.labelSize, kInkSoft, r.labelX, Y(m.field.y) + 7);
            const focused = this.settingsFocus_ === i;
            const shown = this.cfg.marker[i].ch !== '' ? this.cfg.marker[i].ch : mineGlyph(i);
            this.settingsBox(S(m.field), shown, focused, r.boxSize);
            this.settingsButton(S(m.browse), 'IMAGE', false);
            this.settingsButton(S(m.clear), 'CLEAR', false);
            const status = this.cfg.marker[i].ch !== '' ? this.cfg.marker[i].ch
                : (this.cfg.marker[i].dataUrl !== '' ? Renderer.imageName(this.cfg.marker[i].dataUrl) : '(default)');
            drawTL(ctx, status, 10, kInkSoft, m.clear.x + m.clear.w + 12, Y(m.field.y) + 8);
        }
        // 空白格
        {
            const b = r.blank;
            if (this.settingsInView(b.field.y, 30)) {
                drawTL(ctx, 'BLANK CELL', r.labelSize, kInkSoft, r.labelX, Y(b.field.y) + 7);
                const focused = this.settingsFocus_ === 10;
                const shown = this.cfg.blank.ch !== '' ? this.cfg.blank.ch : '(blank)';
                this.settingsBox(S(b.field), shown, focused, r.boxSize);
                this.settingsButton(S(b.browse), 'IMAGE', false);
                this.settingsButton(S(b.clear), 'CLEAR', false);
                const status = this.cfg.blank.ch !== '' ? this.cfg.blank.ch
                    : (this.cfg.blank.dataUrl !== '' ? Renderer.imageName(this.cfg.blank.dataUrl) : '(default)');
                drawTL(ctx, status, 10, kInkSoft, b.clear.x + b.clear.w + 12, Y(b.field.y) + 8);
            }
        }
        // CHORD ON FAIL
        if (this.settingsInView(r.chordBtn[0].y, 30)) {
            drawTL(ctx, 'CHORD ON FAIL', r.labelSize, kInkSoft, r.labelX, Y(r.chordBtn[0].y) + 7);
            const names = ['SILENT', 'HINT', 'BOOM'];
            const modes = ['silent', 'hint', 'boom'];
            for (let i = 0; i < 3; ++i) {
                const b = S(r.chordBtn[i]);
                const on = this.cfg.chordFail === modes[i];
                box(ctx, b, on ? kBtnActive : kBtnBg, on ? kBtnActive : kBtnEdge, 1.4);
                drawC(ctx, names[i], 11, on ? C(255, 255, 255) : kInk, b.x + b.w / 2, b.y + b.h / 2, 0.4);
            }
        }
        // DOUBLE-CLICK
        if (this.settingsInView(r.dcTrack.y - 12, 40)) {
            drawTL(ctx, 'DOUBLE-CLICK', r.labelSize, kInkSoft, r.labelX, Y(r.dcValue.y) + 7);
            const t = S(r.dcTrack);
            box(ctx, t, kBtnBg, kBtnEdge, 1.2);
            const frac = clampF((this.cfg.doubleClickMs - kDoubleClickMinMs) / (kDoubleClickMaxMs - kDoubleClickMinMs), 0, 1);
            circle(ctx, t.x + t.w * frac, t.y + t.h / 2, 6, kBtnActive);
            const dcv = S(r.dcValue);
            const focused = this.settingsFocus_ === 9;
            const txt = focused && this.settingsEdit_ !== '' ? this.settingsEdit_ : String(this.cfg.doubleClickMs);
            this.settingsBox(dcv, txt, focused);
            drawTL(ctx, 'ms', 11, kInkSoft, dcv.x + dcv.w + 8, dcv.y + 7);
        }
        // STARS · DENSITY（星光密度，实时作用到特效层）
        if (this.settingsInView(r.starTrack.y - 12, 40)) {
            drawTL(ctx, 'STARS · DENSITY', r.labelSize, kInkSoft, r.labelX, Y(r.starTrack.y) + 7);
            const t = S(r.starTrack);
            box(ctx, t, kBtnBg, kBtnEdge, 1.2);
            const frac = clampF((this.cfg.starDensity - kStarDensityMin) / (kStarDensityMax - kStarDensityMin), 0, 1);
            circle(ctx, t.x + t.w * frac, t.y + t.h / 2, 6, kBtnActive);
            const fov = S(r.starValue);
            const f11 = this.settingsFocus_ === 11;
            const dTxt = this.cfg.starDensity.toFixed(2);
            this.settingsBox(fov, f11 && this.settingsEdit_ !== '' ? this.settingsEdit_ : dTxt, f11);
            // 单位写进读数：密度是「每 100×100 逻辑像素多少颗」，换局面/窗口后
            // 实际颗数与上限都跟着变 —— 不需要用户心算「信号值」和「颗数」谁大。
            const note = `${dTxt} 颗/100×100px → 本窗口 ≈ ` +
                         `${starCountForDensity(this.cfg.starDensity)} 颗（上限 ` +
                         `${starCountForDensity(kStarDensityMax)} 颗）`;
            drawTL(ctx, note, 9, kInkSoft, t.x, t.y + 18);
        }
        // STARS · SIZE（星光大小倍率）
        if (this.settingsInView(r.scaleTrack.y - 12, 40)) {
            drawTL(ctx, 'STARS · SIZE', r.labelSize, kInkSoft, r.labelX, Y(r.scaleTrack.y) + 7);
            const t = S(r.scaleTrack);
            box(ctx, t, kBtnBg, kBtnEdge, 1.2);
            const frac = clampF((this.cfg.starScale - kStarScaleMin) / (kStarScaleMax - kStarScaleMin), 0, 1);
            circle(ctx, t.x + t.w * frac, t.y + t.h / 2, 6, kBtnActive);
            const vev = S(r.scaleValue);
            const f12 = this.settingsFocus_ === 12;
            this.settingsBox(vev, 'x' + (f12 && this.settingsEdit_ !== '' ? this.settingsEdit_ : this.cfg.starScale.toFixed(1)), f12);
        }
        // ANIM FX（动效总开关；系统 prefers-reduced-motion 时自动失效）
        if (this.settingsInView(r.animBtn.y, 30)) {
            drawTL(ctx, 'ANIM FX · 动效', r.labelSize, kInkSoft, r.labelX, Y(r.animBtn.y) + 7);
            this.settingsButton(S(r.animBtn), this.cfg.animFx ? 'ANIM FX: ON' : 'ANIM FX: OFF', this.cfg.animFx);
            drawTL(ctx, '系统「减少动态」设置会强制关闭动效', 9, kInkSoft,
                r.animBtn.x + r.animBtn.w + 12, Y(r.animBtn.y) + 8);
        }
        ctx.restore();

        // 固定页脚
        this.settingsButton(r.restoreAll, 'RESTORE ALL', false);
        this.settingsButton(r.close, 'CLOSE', true);
        // 页脚不在裁剪区里，窄面板下整行会糊到棋盘上 → 按面板宽截断
        const fw = P.w - (r.labelX - P.x) - 14;
        drawTLFit(ctx, 'click a box, then type (visible ASCII only; hex needs all 6 digits)', r.s < 1 ? 9 : 10, kInkSoft, r.labelX, P.y + P.h - 38, fw);
        drawTLFit(ctx, 'settings are stored in your browser (localStorage)', 9, kInkSoft, r.labelX, P.y + P.h - 20, fw);

        this.settingsGeo_ = scrollbar(ctx, P.x + P.w - 10, v.viewTop, v.viewH, v.totalH, this.settingsScroll_);
    }

    // ================================================================
    //  帮助面板
    // ================================================================

    private drawHelp(): void {
        if (!this.helpOpen_) return;
        const ctx = this.ctx, L = this.L;
        if (!this.helpBuilt_) this.openHelp();
        const P = L.helpPanel;
        fillRect(ctx, R(0, 0, L.winW, L.winH), C(22, 30, 40, 120));
        box(ctx, P, kPanel, kBtnEdge, 1.8);
        const contentL = P.x + 26;
        const contentW = P.w - 52;
        const v = this.helpView();
        if (this.helpScroll_ > v.maxS) this.helpScroll_ = v.maxS;

        ctx.save();
        ctx.beginPath();
        ctx.rect(P.x + 1, v.viewTop, P.w - 2, v.viewH);
        ctx.clip();
        for (const row of this.helpRows_) {
            const yy = v.viewTop + row.y - this.helpScroll_;
            if (yy < v.viewTop || yy + row.h > v.viewBot) continue;
            let x0 = contentL + row.indent;
            if (row.center) {
                let wrow = 0;
                for (const s of row.segs) wrow = Math.max(wrow, s.x + s.adv);
                x0 = P.x + (P.w - wrow) * 0.5;
            }
            if (row.dot) circle(ctx, contentL + row.indent - 12, yy + row.h * 0.62, 2.6, row.dotCol);
            for (const sg of row.segs) {
                const ty = yy + row.h - sg.size - 3.5;
                const sx = x0 + sg.x;
                const dy = inkAlignDy(ctx, sg.text, sg.size);
                if (!sg.spaced) {
                    drawTL(ctx, sg.text, sg.size, sg.col, sx, ty + dy);
                } else {
                    let cx = sx;
                    for (const ch of Array.from(sg.text)) {
                        drawTL(ctx, ch, sg.size, sg.col, cx, ty + dy);
                        cx += textWidth(ctx, ch, sg.size) + 1;
                    }
                }
            }
            if (row.rule) {
                const x = contentL + row.ruleFrom;
                const w = Math.max(0, contentL + contentW - 8 - x);
                if (w > 4) fillRect(ctx, R(x, yy + row.h * 0.5, w, 1), kBtnEdge);
            }
        }
        ctx.restore();

        this.helpGeo_ = scrollbar(ctx, P.x + P.w - 10, v.viewTop, v.viewH, this.helpTotalH_, this.helpScroll_);
        drawC(ctx, '滚轮或拖动进度条滚动 · 点击其余位置关闭', 11, kInkSoft, P.x + P.w / 2, P.y + P.h - 18);
    }

    // ================================================================
    //  二次确认
    // ================================================================

    private drawConfirm(): void {
        if (!this.confirmOpen_) return;
        const ctx = this.ctx;
        const r = this.confirmRects();
        const P = r.panel;
        fillRect(ctx, R(P.x + 3, P.y + 3, P.w + 6, P.h + 6), C(0, 0, 0, 60));
        box(ctx, P, kPanel, kBtnActive, 2);
        let title = '', l1 = '', l2 = '';
        let c1 = kInkSoft, c2 = kInkSoft;
        if (this.confirmKind_ === ConfirmKind.Switch) {
            title = 'SWITCH BOARD?';
            l1 = '切换到「' + this.confirmWhat_ + '」将重置本局，';
            l2 = '当前进度不会被保存。';
            c1 = kInk; c2 = kBadMark;
        } else if (this.confirmKind_ === ConfirmKind.Restart) {
            title = 'RESTART GAME?';
            l1 = '本局还没结束，重新开始会丢失当前进度。';
            l2 = '（背景、图标、格子颜色等设置不受影响）';
        } else {
            title = 'RESTORE ALL DEFAULTS?';
            l1 = '会删除自定义背景、四种标记图标与格子颜色，';
            l2 = '并清空浏览器里保存的图片。此操作不可撤销。';
        }
        drawTL(ctx, title, 15, kInk, P.x + 22, P.y + 18);
        drawTL(ctx, l1, 13, c1, P.x + 22, P.y + 58);
        drawTL(ctx, l2, 13, c2, P.x + 22, P.y + 82);
        const btn = (b: Rect, label: string, primary: boolean) => {
            box(ctx, b, primary ? kBtnActive : kBtnBg, primary ? kBtnActive : kBtnEdge, 1.4);
            drawC(ctx, label, 12, primary ? C(255, 255, 255) : kInk, b.x + b.w / 2, b.y + b.h / 2, 0.4);
        };
        btn(r.no, 'NO', false);
        btn(r.yes, 'YES', true);
    }

    // ================================================================
    //  黄 0 首现教学：闪烁 + 弹窗（文案与桌面端 drawZeroTip 逐字一致）
    // ================================================================

    private drawZeroFlash(nowMs: number): void {
        if (this.zeroTipPhase_ !== 1) return;
        const el = nowMs - this.zeroTipT0_;
        if (el < 0 || el >= 1500) return;
        const a = 105 + 105 * Math.sin(el / 1000 * Math.PI * 2 * 3); // 1.5s 内明暗 3 次
        const ctx = this.ctx;
        ctx.save();
        ctx.lineWidth = 3;
        ctx.strokeStyle = css(kZeroHint);
        ctx.globalAlpha = a / 255;
        const rows = this.board.rows(), cols = this.board.cols();
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c) {
                const cell = this.board.at(r, c);
                if (!(cell.opened && cell.adjTotal > 0 && cell.adjReal === 0 && cell.adjImag === 0)) continue;
                if (this.revealOf(r * cols + c, nowMs) < 1) continue; // 波前未到的先不闪
                const rc = this.cellRect(r, c);
                ctx.strokeRect(rc.x + 1.5, rc.y + 1.5, rc.w - 3, rc.h - 3);
            }
        ctx.restore();
    }

    private drawZeroTip(): void {
        if (this.zeroTipPhase_ !== 2) return;
        const ctx = this.ctx;
        const P = this.zeroTipRect();
        this.zeroTipPanel_ = P;
        fillRect(ctx, R(P.x + 3, P.y + 3, P.w + 6, P.h + 6), C(0, 0, 0, 60));
        box(ctx, P, kPanel, kBtnActive, 2);
        drawTL(ctx, '「0」是什么？', 15, kInk, P.x + 22, P.y + 18);
        drawTL(ctx, '黄色 0 表示周围八格的雷恰好完全抵消（实部、虚部都为零）。', 13, kInkSoft, P.x + 22, P.y + 58);
        drawTL(ctx, '但这格周围仍然有雷 —— 它不是安全区，别当成经典扫雷的 0 乱点。', 13, kBadMark, P.x + 22, P.y + 82);
        drawTL(ctx, '本提示只出现这一次；完整规则随时可在菜单「?」里重看。', 11, kInkSoft, P.x + 22, P.y + 112);
    }
}

// src/core/Seed.h: shortSeed
export function shortSeed(full: string): string {
    return full.length <= 12 ? full : full.slice(0, 12) + '...';
}
