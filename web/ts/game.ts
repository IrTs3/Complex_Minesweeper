// 游戏主控：移植桌面端 src/desktop/main.cpp 的事件与状态机。
// 渲染/几何全部交给 Renderer，这里只负责：棋盘、计时、事件派发、设置持久化、种子导入导出。

import { wasmStub } from './wasm_stub.js';
import {
    Renderer, HeaderAction, OverlayHit, SeedStage, SeedHit, SettingsHit,
    SetupAction, ConfirmHit, ConfirmKind, Hud, SetupConfig, shortSeed
} from './renderer.js';
import {
    SettingsData, loadSettings, saveSettings, defaultSettings, readImageFile,
    imageRejectNote, ImageReject,
    kBgAlphaMax, kDoubleClickMinMs, kDoubleClickMaxMs
} from './settings.js';
import { updateFx } from './fx.js';
import { BoardView, Cell, MineType, Outcome, Phase, MinesweeperModule } from './types.js';
import { seedIsSane, SeedData } from './seedcodec.js';
import { openSeedToolbox } from './seedtool.js';

interface Diff { cols: number; rows: number; mines: number }
const kDiffs: Diff[] = [
    { cols: 9, rows: 9, mines: 12 },
    { cols: 16, rows: 16, mines: 40 },
    { cols: 24, rows: 16, mines: 72 }
];

const kMarkerMaxDim = 1280;
const kBgMaxDim = 2560;

// 首次游玩自动弹玩法介绍：localStorage 记「看过」，看过就永不再弹。
// 读失败（隐私模式等）当看过——弹不了就别每次都弹，宁缺勿扰。
const kHelpSeenKey = 'cms.helpSeen.v1';

function helpSeenBefore(): boolean {
    try { return localStorage.getItem(kHelpSeenKey) === '1'; } catch { return true; }
}

function markHelpSeen(): void {
    try { localStorage.setItem(kHelpSeenKey, '1'); } catch { /* 存不下就下次再弹，无伤 */ }
}

// 黄 0 首现教学：屏幕上第一次出现「和恰好抵消」的黄 0 时闪烁 1.5s 再弹一次解释（点弹窗外关闭）。
// 与 helpseen 同政策：读过一次就永远不再弹；存不下当看过，宁缺勿扰。
const kZeroTipSeenKey = 'cms.zeroTip.v1';

function zeroTipSeenBefore(): boolean {
    try { return localStorage.getItem(kZeroTipSeenKey) === '1'; } catch { return true; }
}

function markZeroTipSeen(): void {
    try { localStorage.setItem(kZeroTipSeenKey, '1'); } catch { /* 存不下就下次再弹，无伤 */ }
}

// 数字键 1~5 的物理键位映射，与桌面端 sf::Keyboard::Key::Num1..Num5 / Numpad1..Numpad5 对齐。
// 用 e.code 而非 e.key：e.code 与键盘布局、输入法无关，e.key 在某些布局或中文输入法下拿不到 '1'..'5'。
function digitFromCode(code: string): number {
    if (/^Digit[1-5]$/.test(code)) return code.charCodeAt(5) - 48;
    if (/^Numpad[1-5]$/.test(code)) return code.charCodeAt(6) - 48;
    return 0;
}

/** 每帧缓存一次的棋盘只读视图，避免每格 JSON.parse */
class BoardAdapter implements BoardView {
    private frame_ = -1;
    private axis_ = { real: 0, imag: 0 };
    private counts_ = { openedSafe: 0, flagged: 0 };
    constructor(private m: MinesweeperModule, private tick: () => number) { }
    private sync(): void {
        const f = this.tick();
        if (f === this.frame_) return;
        this.frame_ = f;
        this.axis_ = JSON.parse(this.m.boardAxisUnflagged());
        this.counts_ = JSON.parse(this.m.boardCounts());
    }
    cols(): number { return this.m.boardCols(); }
    rows(): number { return this.m.boardRows(); }
    mineCount(): number { return this.m.boardMineCount(); }
    remaining(): number { return this.m.boardRemaining(); }
    started(): boolean { return this.m.boardStarted(); }
    uncoveredMines(): number { return this.m.boardUncoveredMines(); }
    seed(): number { return this.m.boardGetSeed(); }
    axisUnflagged(): { real: number; imag: number } { this.sync(); return this.axis_; }
    counts(): { openedSafe: number; flagged: number } { this.sync(); return this.counts_; }
    at(r: number, c: number): Cell {
        return this.m.boardCellRef ? this.m.boardCellRef(r, c) : JSON.parse(this.m.boardGetCell(r, c));
    }
}

export class Game {
    private canvas: HTMLCanvasElement;
    private board: MinesweeperModule = wasmStub;
    private view: BoardAdapter;
    private renderer: Renderer;
    cfg: SettingsData;

    // —— 局面状态 ——
    private phase_: Phase = Phase.Playing;
    private diffIdx_ = 1;
    private customActive_ = false;
    private customCfg_ = new SetupConfig();
    private cfgMines_ = 40;
    private cfgReal_ = -1;
    private cfgImag_ = -1;
    private cfgManual_ = false;
    private firstOpened_ = false;
    private firstR_ = -1;
    private firstC_ = -1;

    // —— 计时 ——
    private timerRunning_ = false;
    private elapsed_ = 0;
    private t0_ = 0;
    private focusPaused_ = false;

    // —— 待确认动作 ——
    private pendingDiff_ = -1;
    private pendingCustomCfg_ = new SetupConfig();
    private pendingSeed_ = '';

    // —— 双击（自行计时，不用浏览器 dblclick）——
    private lastClickCell_ = { r: -1, c: -1 };
    private lastClickTime_ = 0;

    private frame_ = 0;
    private running_ = false;
    private kb_: HTMLTextAreaElement | null = null;
    /** 输入法正在拼字（compositionstart..compositionend 之间） */
    private composing_ = false;
    private fileInput_: HTMLInputElement | null = null;
    private fileAction_: ((dataUrl: string | null) => void) | null = null;
    private hasFocus_ = true;
    private stableH_ = 0;          // 触摸端：未被软键盘压扁过的视口高度（见 availSize）
    private resizeQueued_ = false;
    /** 设置存不下（localStorage 满）已经提示过，避免拖滑块时连续弹 */
    private saveFailTold_ = false;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.cfg = loadSettings();
        let f = 0;
        this.view = new BoardAdapter(this.board, () => this.frame_);
        this.renderer = new Renderer(canvas, this.view, this.cfg);
        this.kb_ = document.getElementById('kb') as HTMLTextAreaElement | null;
        this.fileInput_ = document.getElementById('filepick') as HTMLInputElement | null;
        this.bindEvents();
        this.newGame(1);
        // 首次到访：开局自动展开玩法介绍（帮助面板紧凑可滚动，不挡棋盘）。
        if (!helpSeenBefore()) {
            this.renderer.openHelp();
            markHelpSeen();
        }
    }

    // ================================================================
    //  窗口尺寸 / 设置持久化
    // ================================================================

    private availSize(): { w: number; h: number } {
        // canvas **铺满整个视口**（不留边）。背景图是按 cover 等比缩放画满 canvas 的
        // （Renderer::drawImageCover），canvas 一铺满，背景就铺满整屏；以前留 24px 边时
        // 那圈露的是页面底色，在宽屏上非常显眼。
        // 注意别改成"按比例缩放"——cover 保持原比例、只裁切，不拉伸。
        //
        // ⚠️ 直接用视口尺寸，**不要**再套 `Math.max(660, ...)` 之类的下限：
        //   canvas 一旦比视口大，超出部分会被 body 的 overflow:hidden 裁掉，
        //   看起来就是「背景图没铺满」（2026-10-16 踩过，根因在 renderer 那侧，
        //   这里也一并去掉，两边都不该给视口设下限）。
        const w = window.innerWidth;
        let h = window.innerHeight;
        // 触摸端冻结键盘引起的高度塌陷：Android 上软键盘升起会把 innerHeight 砍掉近一半，
        // 若照着重算布局，用户一打字棋盘就整盘缩小+上跳，根本没法输种子。
        // 判据是「焦点在隐形输入框上 且 高度骤降」——正常旋转屏幕不会同时满足。
        if (this.renderer.coarsePointer() && document.activeElement === this.kb_
            && this.stableH_ > 0 && h < this.stableH_ - 80) {
            h = this.stableH_;
        } else {
            this.stableH_ = h;
        }
        return { w, h };
    }

    applySize(): void {
        const a = this.availSize();
        this.renderer.applySize(a.w, a.h);
        // 布局变了，缓存里的画布局部坐标不再对应原来的格子；不清掉会出现"标记落在错格上"
        this.renderer.setMouse(-999, -999);
        this.persist();
    }

    private persist(): void {
        if (saveSettings(this.cfg)) { this.saveFailTold_ = false; return; }
        // 存不下（localStorage 满）必须说出来：此前只 console.warn，会话内一切正常，
        // 刷新后设置全回默认，用户从没见过任何报错，只会以为网站坏了。
        // persist() 在拖滑块时会被连续调用，所以一轮失败只提示一次。
        if (this.saveFailTold_) return;
        this.saveFailTold_ = true;
        this.renderer.setSeedNote('SAVE FAILED · 浏览器存储空间已满，本次设置不会被保存');
    }

    resetAllSettings(): void {
        this.cfg = defaultSettings();
        this.renderer.cfg = this.cfg;
        this.renderer.setHideCounts(this.cfg.hideCounts);
        this.renderer.setAlwaysMagnitude(this.cfg.alwaysMagnitude);
        this.renderer.setUstcMode(this.cfg.ustcMode);
        this.board.boardSetMagnitudeMode(this.cfg.alwaysMagnitude);
        this.fxSync();
        this.persist();
    }

    // 把当前设置里与特效相关的三项推给 fx 层（密度/大小实时、USTC 随复选框）。
    private fxSync(): void {
        updateFx({ ustcOn: this.cfg.ustcMode, starDensity: this.cfg.starDensity, starScale: this.cfg.starScale });
    }

    // ================================================================
    //  计时器
    // ================================================================

    private now(): number { return performance.now(); }

    private startTimer(): void {
        if (this.timerRunning_) return;
        this.t0_ = this.now() - this.elapsed_ * 1000;
        this.timerRunning_ = true;
    }
    private stopTimer(): void {
        if (this.timerRunning_) this.elapsed_ = (this.now() - this.t0_) / 1000;
        this.timerRunning_ = false;
    }
    private resetTimer(): void { this.timerRunning_ = false; this.elapsed_ = 0; this.focusPaused_ = false; }
    private currentElapsed(): number {
        return this.timerRunning_ ? (this.now() - this.t0_) / 1000 : this.elapsed_;
    }

    /** 与桌面端一致：只有"看着棋盘且无面板打开"时计时才走 */
    private settleTimer(): void {
        const panelOpenNow = this.renderer.panelOpen();
        const ticking = this.hasFocus_ && !panelOpenNow;
        if (this.phase_ === Phase.Playing && this.firstOpened_) {
            if (!ticking && this.timerRunning_) {
                this.elapsed_ = (this.now() - this.t0_) / 1000;
                this.timerRunning_ = false;
                this.focusPaused_ = true;
            } else if (ticking && !this.timerRunning_ && !this.focusPaused_) {
                this.startTimer();
            } else if (ticking && this.focusPaused_) {
                this.focusPaused_ = false;
                this.startTimer();
            }
        } else {
            this.focusPaused_ = false;
        }
    }

    // ================================================================
    //  新局
    // ================================================================

    phase(): Phase { return this.phase_; }
    firstOpened(): boolean { return this.firstOpened_; }
    won(): boolean { return this.board.boardWon(); }
    lost(): boolean { return this.board.boardLost(); }

    private resetBoardState(): void {
        this.firstOpened_ = false;
        this.firstR_ = -1; this.firstC_ = -1;
        this.lastClickCell_ = { r: -1, c: -1 };
        this.lastClickTime_ = 0;
        this.phase_ = Phase.Playing;
        this.resetTimer();
        this.renderer.closeZeroTip(); // 换局时教学弹窗/闪烁一并收掉
        this.renderer.resetAnims();
        this.renderer.resetOverlay();
        this.renderer.closeMenu();
    }

    newGame(idx: number): void {
        const d = kDiffs[idx];
        this.diffIdx_ = idx;
        this.customActive_ = false;
        this.board.boardReset(d.cols, d.rows, d.mines);
        this.board.boardRandomizeSeed();
        this.board.boardSetMagnitudeMode(this.cfg.alwaysMagnitude);
        this.cfgMines_ = d.mines;
        this.cfgReal_ = -1; this.cfgImag_ = -1; this.cfgManual_ = false;
        this.renderer.setActiveDifficulty(idx);
        this.renderer.closeSetup();
        this.renderer.closeSeedUi();
        this.resetBoardState();
        this.renderer.resetBoardView();   // 棋盘尺寸变了，旧的缩放/平移已无意义
        this.applySize();
    }

    newCustom(): void {
        this.customActive_ = true;
        this.diffIdx_ = -1;
        const c = this.customCfg_;
        c.clampToBoard();
        if (c.splitManual) this.board.boardResetSplit(c.cols, c.rows, c.realCount, c.imagCount);
        else this.board.boardReset(c.cols, c.rows, c.total);
        this.board.boardRandomizeSeed();
        this.board.boardSetMagnitudeMode(this.cfg.alwaysMagnitude);
        this.cfgMines_ = c.mines();
        this.cfgReal_ = c.splitManual ? c.realCount : -1;
        this.cfgImag_ = c.splitManual ? c.imagCount : -1;
        this.cfgManual_ = c.splitManual;
        this.renderer.setActiveDifficulty(-1);
        this.renderer.closeSetup();
        this.renderer.closeSeedUi();
        this.resetBoardState();
        this.renderer.resetBoardView();
        this.applySize();
    }

    private checkWin(): void {
        if (this.board.boardWon() && this.phase_ === Phase.Playing) {
            this.phase_ = Phase.Won;
            this.stopTimer();
        }
    }

    private setFlag(r: number, c: number, t: MineType): void {
        if (this.phase_ !== Phase.Playing) return;
        this.board.boardSetFlag(r, c, t);
        this.checkWin();
    }

    private openCell(r: number, c: number): void {
        if (!this.firstOpened_) { this.firstOpened_ = true; this.firstR_ = r; this.firstC_ = c; }
        this.renderer.noteRevealOrigin(r, c);
        const out = this.board.boardOpen(r, c);
        if (out === Outcome.Boom) { this.phase_ = Phase.Lost; this.stopTimer(); }
        else if (out === Outcome.Won) { this.phase_ = Phase.Won; this.stopTimer(); }
        else if (out === Outcome.Opened) {
            if (this.board.boardWon()) { this.phase_ = Phase.Won; this.stopTimer(); }
            else if (this.phase_ === Phase.Playing && !this.focusPaused_) this.startTimer();
        }
        // 黄 0 首现教学：终局（Boom/Won）不弹，结算横幅优先；seen 在触发时就写入
        // （与桌面端「立刻落盘」同政策——就算这次没看完，下次也不再弹）
        if (this.phase_ === Phase.Playing && !zeroTipSeenBefore() && this.renderer.maybeStartZeroTip())
            markZeroTipSeen();
    }

    // ================================================================
    //  种子
    // ================================================================

    private captureProgress(): { elapsedCs: number; phase: string; openedRows: string[]; flagRows: string[] } {
        const rows = this.board.boardRows(), cols = this.board.boardCols();
        const openedRows: string[] = [], flagRows: string[] = [];
        for (let r = 0; r < rows; ++r) {
            let o = '', f = '';
            for (let c = 0; c < cols; ++c) {
                const cell = this.view.at(r, c);
                o += cell.opened ? '#' : '.';
                f += cell.flag === MineType.None ? '.' : String(cell.flag);
            }
            openedRows.push(o);
            flagRows.push(f);
        }
        const phase = this.phase_ === Phase.Won ? 'won' : (this.phase_ === Phase.Lost ? 'lost' : 'playing');
        return { elapsedCs: Math.round(this.currentElapsed() * 100), phase, openedRows, flagRows };
    }

    currentSeedText(kind: 'new' | 'save'): string {
        return this.board.encodeSeedJson(
            kind, this.board.boardCols(), this.board.boardRows(), this.cfgMines_,
            this.cfgManual_, this.cfgReal_, this.cfgImag_,
            this.board.boardGetSeed(), this.firstR_, this.firstC_,
            this.renderer.ustcMode(),
            kind === 'save' ? this.captureProgress() : null);
    }

    // 与桌面端 src/desktop/main.cpp:116-126 同口径：已翻开数数**全部** opened（含踩爆的雷格），
    // flags 数**全部**标记（含插在安全格上的错旗）。
    // 历史 bug：原先用 view.counts()，其 openedSafe 只数安全格、flagged 只数标在真雷上的旗，
    // 导致失败局与插过错旗时两端「N% opened, M flags」对不上。
    saveHintText(): string {
        const cols = this.board.boardCols(), rows = this.board.boardRows();
        let openedCount = 0, flagCount = 0;
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c) {
                const cell = this.view.at(r, c);
                if (cell.opened) ++openedCount;
                if (cell.flag !== MineType.None) ++flagCount;
            }
        const total = Math.max(1, cols * rows);
        return Math.floor(openedCount * 100 / total) + '% opened, ' + flagCount + ' flags, ' +
            this.currentElapsed().toFixed(1) + 's';
    }

    private async copyText(text: string): Promise<void> {
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch { /* 忽略 */ }
            document.body.removeChild(ta);
        }
    }

    private async readClipboard(): Promise<string> {
        try { return await navigator.clipboard.readText(); } catch { return ''; }
    }

    private copySeed(kind: 'new' | 'save'): void {
        const text = this.currentSeedText(kind);
        this.copyText(text);
        this.renderer.setSeedNote(kind === 'new' ? 'COPIED! · 已复制' : 'PROGRESS COPIED! · 进度已复制');
    }

    applySeed(text: string): void {
        const plain = text.trim();
        const json = this.board.decodeSeedJson(plain);
        if (json === '') { this.renderer.setSeedNote('WRONG KEY / BAD SEED · 密码不对，或种子串已损坏'); return; }
        let s: any;
        try { s = JSON.parse(json); } catch { this.renderer.setSeedNote('BAD SEED · 种子串格式不对'); return; }
        if (!this.seedSane(s)) { this.renderer.setSeedNote('BAD SEED · 种子串格式不对'); return; }
        const a = this.availSize();
        const maxC = this.renderer.maxColsAtMinimumCell(a.w);
        const maxR = this.renderer.maxRowsAtMinimumCell(a.h);
        if (s.cols > maxC || s.rows > maxR) {
            // 光说「太大」没法行动：把当前窗口能放下的上限一并报出来，用户才知道要把窗口拉多大。
            this.renderer.setSeedNote(`GRID TOO BIG · 本窗口最多 ${maxC}×${maxR}`);
            return;
        }

        this.diffIdx_ = -1;
        this.customActive_ = false;
        this.cfgManual_ = !!s.manualSplit;
        this.cfgMines_ = s.mines;
        this.cfgReal_ = s.manualSplit ? s.realMines : -1;
        this.cfgImag_ = s.manualSplit ? s.imagMines : -1;
        this.renderer.setUstcMode(!!s.ustcMode);
        this.cfg.ustcMode = !!s.ustcMode;
        this.fxSync();

        if (s.manualSplit) this.board.boardResetSplit(s.cols, s.rows, s.realMines, s.imagMines);
        else this.board.boardReset(s.cols, s.rows, s.mines);
        this.board.boardSetSeed(s.rngSeed);
        this.board.boardSetMagnitudeMode(this.cfg.alwaysMagnitude);

        let preset = -1;
        for (let i = 0; i < kDiffs.length; ++i) {
            const d = kDiffs[i];
            if (d.cols === s.cols && d.rows === s.rows && d.mines === s.mines && !s.manualSplit) { preset = i; break; }
        }
        if (preset >= 0) { this.diffIdx_ = preset; this.customActive_ = false; }
        else {
            this.diffIdx_ = -1;
            this.customActive_ = true;
            const c = this.customCfg_;
            c.rows = s.rows; c.cols = s.cols;
            c.maxRows = Math.max(5, maxR); c.maxCols = Math.max(5, maxC);
            c.splitManual = !!s.manualSplit;
            if (s.manualSplit) { c.realCount = s.realMines; c.imagCount = s.imagMines; c.total = s.realMines + s.imagMines; }
            else { c.total = s.mines; c.realCount = Math.floor(s.mines / 2); c.imagCount = s.mines - c.realCount; }
            c.clampToBoard();
        }
        this.renderer.setActiveDifficulty(this.diffIdx_ >= 0 ? this.diffIdx_ : -1);

        this.renderer.resetOverlay();
        this.renderer.closeSeedUi();
        this.renderer.closeMenu();
        this.renderer.closeSetup();
        this.phase_ = Phase.Playing;
        this.timerRunning_ = false;
        this.elapsed_ = 0;
        this.focusPaused_ = false;
        this.applySize();

        this.firstOpened_ = true;
        this.firstR_ = s.firstRow; this.firstC_ = s.firstCol;
        this.board.boardOpen(s.firstRow, s.firstCol);
        this.checkWin();

        const isSave = s.kind === 'save';
        if (isSave) {
            this.restoreProgress(s);
            this.phase_ = s.phase === 'won' ? Phase.Won : (s.phase === 'lost' ? Phase.Lost : Phase.Playing);
            this.elapsed_ = (s.elapsedCs || 0) / 100;
            if (this.phase_ === Phase.Playing) { this.timerRunning_ = true; this.t0_ = this.now() - this.elapsed_ * 1000; }
            else { this.timerRunning_ = false; }
        } else {
            if (this.phase_ !== Phase.Playing) this.stopTimer();
            else { this.timerRunning_ = false; this.elapsed_ = 0; }
        }
        // 载入（含首点展开与进度恢复）不播任何入场动画：下一帧快照直接对齐棋盘
        this.renderer.resetAnims();
        this.renderer.setSeedNote(isSave ? 'PROGRESS LOADED · 进度已载入' : 'SEED LOADED · 种子已载入');
        this.persist();
    }

    // 第二层：数值范围校验。直接复用 seedcodec 的 seedIsSane —— 它与桌面端 src/core/Seed.h 的
    // seedIsSane 逐条一致，是同一份判定，避免两端各自演化出不同宽严的副本。
    // 第一层结构校验（magic/kind、行列≥5、雷数≥2、首点范围、存档行数组长度）在
    // decodeSeed → seedFromJson 里完成，两端相同；此处只额外补存档行数组的逐行尺寸校验。
    private seedSane(s: any): boolean {
        if (!s || typeof s !== 'object') return false;
        if (!seedIsSane(s as SeedData)) return false;
        if (s.kind === 'save') {
            if (!Array.isArray(s.openedRows) || s.openedRows.length !== s.rows) return false;
            if (!Array.isArray(s.flagRows) || s.flagRows.length !== s.rows) return false;
            for (let r = 0; r < s.rows; ++r) {
                if (typeof s.openedRows[r] !== 'string' || s.openedRows[r].length !== s.cols) return false;
                if (typeof s.flagRows[r] !== 'string' || s.flagRows[r].length !== s.cols) return false;
            }
        }
        return true;
    }

    private restoreProgress(s: any): void {
        const rows = this.board.boardRows(), cols = this.board.boardCols();
        const openedAt = (r: number, c: number) =>
            r < s.openedRows.length && c < s.openedRows[r].length && s.openedRows[r][c] === '#';
        for (let r = 0; r < rows; ++r)
            for (let c = 0; c < cols; ++c)
                if (openedAt(r, c) && this.view.at(r, c).mine === MineType.None) this.board.boardOpen(r, c);
        for (let r = 0; r < rows && r < s.flagRows.length; ++r)
            for (let c = 0; c < cols && c < s.flagRows[r].length; ++c) {
                const ch = s.flagRows[r][c];
                if (ch >= '1' && ch <= '4') this.board.boardSetFlag(r, c, ch.charCodeAt(0) - 48);
            }
        if (s.phase === 'lost')
            for (let r = 0; r < rows; ++r)
                for (let c = 0; c < cols; ++c)
                    if (openedAt(r, c) && this.view.at(r, c).mine !== MineType.None) this.board.boardOpen(r, c);
    }

    private applySeedFromInput(): void {
        const text = this.renderer.seedInput_;
        const json = this.board.decodeSeedJson(text.trim());
        if (json === '') { this.renderer.setSeedNote('WRONG KEY / BAD SEED · 密码不对，或种子串已损坏'); return; }
        let s: any;
        try { s = JSON.parse(json); } catch { this.renderer.setSeedNote('WRONG KEY / BAD SEED · 密码不对，或种子串已损坏'); return; }
        if (!this.seedSane(s)) { this.renderer.setSeedNote('BAD SEED · 种子串格式不对'); return; }
        const inGame = this.firstOpened_ && this.phase_ === Phase.Playing;
        if (inGame) {
            const cnt = this.view.counts();
            const safeTotal = Math.max(1, this.board.boardCols() * this.board.boardRows() - this.board.boardMineCount());
            this.pendingSeed_ = text;
            this.renderer.openSeedConfirm(
                '当前局面 ' + this.board.boardCols() + 'x' + this.board.boardRows() + ' · ' + this.board.boardMineCount() + ' 雷',
                '进度：已翻开 ' + cnt.openedSafe + '/' + safeTotal + ' · 已标记 ' + cnt.flagged + '/' + this.board.boardMineCount());
            return;
        }
        this.applySeed(text);
    }

    replayCurrentGame(): void {
        const text = this.currentSeedText('new');
        this.applySeed(text);
        this.renderer.setSeedNote('SAME ROUND! · 与你第一次点开的是同一局');
    }

    private restartSame(): void {
        if (this.customActive_ || this.diffIdx_ < 0) this.newCustom();
        else this.newGame(this.diffIdx_);
    }

    private wantRestart(): void {
        if (this.firstOpened_ && this.phase_ === Phase.Playing) {
            this.pendingDiff_ = -1;
            this.renderer.openRestartConfirm();
        } else this.restartSame();
    }

    private wantDifficulty(i: number): void {
        const what = kDiffs[i].cols + 'x' + kDiffs[i].rows + '（' + kDiffs[i].mines + '雷）';
        if (this.firstOpened_ && this.phase_ === Phase.Playing) {
            this.pendingDiff_ = i;
            this.renderer.openSwitchConfirm(what);
        } else this.newGame(i);
    }

    openCustomPanel(): void {
        const c = this.customCfg_;
        if (!this.customActive_) {
            const cols = this.board.boardCols(), rows = this.board.boardRows(), mines = this.board.boardMineCount();
            c.rows = rows; c.cols = cols;
            c.splitManual = false;
            c.total = mines;
            c.realCount = Math.floor(mines / 2);
            c.imagCount = mines - c.realCount;
        }
        // 每次打开都按当前窗口重算上限（桌面端曾因缓存导致 "GRID TOO BIG" 误报）
        const a = this.availSize();
        c.maxRows = Math.max(5, this.renderer.maxRowsAtMinimumCell(a.h));
        c.maxCols = Math.max(5, this.renderer.maxColsAtMinimumCell(a.w));
        c.clampToBoard();
        this.renderer.closeMenu();
        this.renderer.openSetup(c);
    }

    // ================================================================
    //  批量开格（chord）
    // ================================================================

    private doChord(cell: { r: number; c: number }): void {
        if (this.phase_ !== Phase.Playing) return;
        this.renderer.noteRevealOrigin(cell.r, cell.c);
        const res = this.board.boardChord(cell.r, cell.c);
        if (res === 1) { // 1 = 已展开（与桌面端 ChordResult::Opened 对齐）
            if (this.board.boardWon()) { this.phase_ = Phase.Won; this.stopTimer(); }
            else if (!this.focusPaused_) this.startTimer();
            return;
        }
        if (res !== 2) return; // 2 = 被阻挡（雷没标对）
        const mode = this.cfg.chordFail;
        if (mode === 'silent') return;
        if (mode === 'hint') { this.renderer.setSeedNote('BAD MARKS · 这一圈的标记与数字不符'); return; }
        for (let dr = -1; dr <= 1; ++dr) {
            for (let dc = -1; dc <= 1; ++dc) {
                if (dr === 0 && dc === 0) continue;
                const r = cell.r + dr, c = cell.c + dc;
                if (r < 0 || c < 0 || r >= this.board.boardRows() || c >= this.board.boardCols()) continue;
                if (this.view.at(r, c).mine === MineType.None) continue;
                if (this.phase_ !== Phase.Playing) return;
                this.board.boardSetFlag(r, c, MineType.None);
                const out = this.board.boardOpen(r, c);
                if (out === Outcome.Boom) { this.phase_ = Phase.Lost; this.stopTimer(); return; }
                if (out === Outcome.Won || this.board.boardWon()) { this.phase_ = Phase.Won; this.stopTimer(); return; }
            }
        }
    }

    // ================================================================
    //  事件绑定
    // ================================================================

    private toLocal(e: { clientX: number; clientY: number }): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        const L = this.renderer.L;
        const sx = rect.width > 0 ? L.winW / rect.width : 1;
        const sy = rect.height > 0 ? L.winH / rect.height : 1;
        return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy };
    }

    private refocusKb(): void {
        if (!this.kb_) return;
        // 触摸端（手机/平板）没有硬件键盘，聚焦这个隐形 textarea 只会白白弹出软键盘、
        // 遮掉半屏还触发 resize。只有正在接受文字输入的面板（设置 / 自定义 / 种子）
        // 才需要软键盘；其余场合在 coarse 设备上一律不聚焦，且把已挂上的焦点 blur 掉。
        // 桌面端 coarsePointer() 恒 false，行为完全不变（仍靠 #kb 捕获硬件键盘与剪贴板）。
        const R = this.renderer;
        const wantsText = R.settingsOpen_ || R.setupOpen_ || R.seedStage_ !== SeedStage.None;
        if (R.coarsePointer() && !wantsText) {
            if (document.activeElement === this.kb_) this.kb_.blur();
            return;
        }
        if (document.activeElement !== this.kb_) this.kb_.focus({ preventScroll: true });
    }

    private pickImage(maxDim: number, cb: (dataUrl: string | null) => void): void {
        if (!this.fileInput_) {
            this.renderer.setSeedNote('BAD IMAGE · 图片读取失败');
            cb(null);
            return;
        }
        this.fileAction_ = cb;
        this.fileInput_.value = '';
        this.fileInput_.click();
    }

    private bindEvents(): void {
        const cv = this.canvas;
        cv.addEventListener('contextmenu', e => e.preventDefault());
        cv.addEventListener('pointermove', e => {
            if (e.pointerType === 'touch') { this.onTouchMove(e); return; }
            const p = this.toLocal(e);
            this.renderer.setMouse(p.x, p.y);
            this.dragMoveTo(p.x, p.y);
        });
        cv.addEventListener('pointerleave', () => this.renderer.setMouse(-999, -999));
        cv.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch') { this.onTouchDown(e); return; }
            this.refocusKb();
            if (!this.hasFocus_) return;
            const p = this.toLocal(e);
            this.renderer.setMouse(p.x, p.y);
            if (e.button === 2) { this.onRightPress(p.x, p.y); e.preventDefault(); return; }
            if (e.button === 1) {
                e.preventDefault();
                const cell = this.renderer.cellAt(p.x, p.y);
                if (cell) this.doChord(cell);
                return;
            }
            if (e.button !== 0) return;
            // 与中键/右键一致地抑制随后的 mousedown：它的默认行为会把焦点从 #kb 抢到 body
            // （canvas 不可聚焦）。剪贴板 paste/copy/cut 仍挂在 #kb 上，需要它保持聚焦。
            e.preventDefault();
            this.onLeftPress(p.x, p.y, e.shiftKey);
        });
        window.addEventListener('pointerup', e => {
            if (e.pointerType === 'touch') { this.onTouchUp(e, false); return; }
            this.endDrags();
        });
        // 触摸被系统手势/来电打断时不会来 pointerup：不清状态会让长按定时器与拖动一直挂着
        window.addEventListener('pointercancel', e => {
            if (e.pointerType === 'touch') { this.onTouchUp(e, true); return; }
            this.endDrags();
        });
        cv.addEventListener('wheel', e => {
            e.preventDefault();
            const d = -e.deltaY / 100;
            if (this.renderer.helpOpen_) this.renderer.scrollHelp(d);
            else if (this.renderer.settingsOpen_) this.renderer.scrollSettings(d);
        }, { passive: false });

        window.addEventListener('resize', () => this.scheduleResize());
        // Web 字体（IBM Plex Serif）比首次布局慢到：标题按兜底字体量出来偏窄，
        // 帮助键因此定得偏左，字体就绪后标题会插到帮助键底下（1440 实测 2px）。
        // 字体就绪后重排一次，让帮助键按真实字宽落位。
        if (document.fonts && document.fonts.ready)
            document.fonts.ready.then(() => this.scheduleResize());
        // 失焦时输入法的拼字会被系统丢弃，compositionend 不一定再来：不清标记会把键盘一直锁死
        const dropComposition = () => {
            this.composing_ = false;
            if (this.kb_) this.kb_.value = '';
        };
        window.addEventListener('blur', () => { this.hasFocus_ = false; dropComposition(); });
        window.addEventListener('focus', () => { this.hasFocus_ = true; this.refocusKb(); });
        document.addEventListener('visibilitychange', () => { this.hasFocus_ = !document.hidden; if (document.hidden) dropComposition(); });

        // 键盘监听挂在 document 上，而不是 #kb。挂在 #kb 上有致命依赖：一旦焦点离开它
        // （左键点击 canvas 时 mousedown 的默认行为会把焦点移到 body），监听就再也收不到按键，
        // 表现为「点第一下格子之后，数字键 1~5 标记永久失灵」。onKey 内部只读按键与游戏状态、
        // 不读 document.activeElement，因此迁到 document 无语义变化。
        document.addEventListener('keydown', e => {
            const t = e.target as Node | null;
            if (t && t !== this.kb_) { // #kb 自身放行；将来若加入真实输入框，不抢它的按键
                const el = t as HTMLElement;
                if (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return;
            }
            this.onKey(e);
        });
        if (this.kb_) {
            this.kb_.addEventListener('paste', e => {
                e.preventDefault();
                const t = e.clipboardData ? e.clipboardData.getData('text') : '';
                if (this.renderer.seedStage_ === SeedStage.Load) this.renderer.seedInsert(t);
            });
            this.kb_.addEventListener('copy', e => { this.onCopyCut(e, false); });
            this.kb_.addEventListener('cut', e => { this.onCopyCut(e, true); });
            this.kb_.addEventListener('input', e => {
                // 拼字过程中不能动 value：清空会把输入法的候选串打断
                if (this.kb_ && !(e as InputEvent).isComposing) this.kb_.value = '';
            });
            this.kb_.addEventListener('compositionstart', () => { this.composing_ = true; });
            this.kb_.addEventListener('compositionend', e => {
                this.composing_ = false;
                if (this.kb_) this.kb_.value = '';
                this.insertText(e.data || '');
            });
            this.refocusKb();
        }
        if (this.fileInput_) {
            this.fileInput_.addEventListener('change', async () => {
                const f = this.fileInput_!.files && this.fileInput_!.files[0];
                const act = this.fileAction_;
                this.fileAction_ = null;
                const r = f ? await readImageFile(f, this.pendingMaxDim_)
                              : { dataUrl: null as string | null, why: 'decode' as ImageReject };
                this.refocusKb();
                // 失败的话术集中在这里：六个入口（背景 / 空白格 / 4 个 marker）以前只有
                // 背景那一处会提示，其余五处静默回到「什么都没发生」—— 而用户的感受是
                // 「点了 Browse 没反应」，于是反复点同一张注定失败的图。（2026-10-21 ★5）
                if (!r.dataUrl) this.renderer.setSeedNote(imageRejectNote(r.why, r.w, r.h));
                if (act) act(r.dataUrl);
            });
        }
    }
    // ================================================================
    //  拖动 / 触摸手势
    // ================================================================

    /** 滑条与滚动条的拖动分发（鼠标与触摸共用，顺序与桌面端一致） */
    private dragMoveTo(x: number, y: number): void {
        if (this.renderer.helpDragging()) { this.renderer.helpDragMove(y); return; }
        if (this.renderer.settingsScrollDragging()) { this.renderer.settingsDragMove(x, y); return; }
        this.renderer.setupMove(x);
        if (this.renderer.settingsMove(x)) this.fxSync();
        this.renderer.bgMove(x);
        if (this.boxDragging_ && this.renderer.seedStage_ === SeedStage.Load)
            this.renderer.seedClickInBox(x, true);
    }

    private endDrags(): void {
        this.renderer.helpDragEnd();
        this.renderer.settingsDragEnd();
        this.renderer.setupRelease();
        this.renderer.settingsRelease();
        this.renderer.bgRelease();
        this.boxDragging_ = false;
        this.persist();
    }

    private scheduleResize(): void {
        // 手机上地址栏伸缩会连发十几个 resize：合并到下一帧，别每帧都重排整盘
        if (this.resizeQueued_) return;
        this.resizeQueued_ = true;
        requestAnimationFrame(() => { this.resizeQueued_ = false; this.applySize(); });
    }

    // —— 触点状态 ——
    private tp_ = new Map<number, { x: number; y: number }>();
    private tMode_: 'none' | 'tap' | 'pan' | 'pinch' = 'none';
    private tStart_ = { x: 0, y: 0, t: 0 };
    private tLongTimer_: number | null = null;
    private tConsumed_ = false;   // 长按/拖动已经消费掉这次触摸，抬手不再落子
    // active 必须撑到**最后一根手指**抬起：第一根抬起时就把 tMode_ 清成 none 的话，
    // 「双指轻点复位」永远等不到 size===0 那一刻（实测：放大后复位手势失效）。
    // moved 与 start* 比而不是逐帧比：逐帧比会被慢速漂移绕过，也会被 4 倍上限钳死而漏判。
    private tPinch_ = {
        active: false, dist: 1, scale: 1, midX: 0, midY: 0,
        startDist: 1, startMidX: 0, startMidY: 0, moved: false
    };

    /** 这次触摸该不该走「棋盘手势」（点击延迟到抬手、长按标记、拖动平移、捏合缩放） */
    private touchWantsBoard(x: number, y: number): boolean {
        const R_ = this.renderer;
        if (this.phase_ !== Phase.Playing) return false;   // 结束覆盖层的按钮要按下即响应
        if (R_.helpOpen_ || R_.settingsOpen_ || R_.confirmOpen_ || R_.setupOpen_
            || R_.seedStage_ !== SeedStage.None || R_.menuIsOpen()) return false;
        const vp = R_.boardViewport();
        return x >= vp.x && x <= vp.x + vp.w && y >= vp.y && y <= vp.y + vp.h;
    }

    private onTouchDown(e: PointerEvent): void {
        // iOS WebKit 的手势识别器会抢走 touch 并中途发 pointercancel，
        // 导致长按定时器被取消（菜单弹不出）。捕获指针把事件锁定在 canvas 上，
        // 识别器就抢不走了；preventDefault 再挡掉放大镜/callout 的默认行为。
        // 捕获会在 pointerup/pointercancel 时自动释放，无需手动 release；
        // up/cancel 仍挂在 window 上，事件冒泡照旧能收到，清理逻辑不受影响。
        try { this.canvas.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
        e.preventDefault();
        // preventDefault 顺带抑制了浏览器默认的焦点转移：以前点棋盘靠这次默认行为
        // 把焦点从隐形输入框 #kb 挪到 body，现在挪不动了，#kb 会一直挂着焦点，
        // 触摸端于是每点一下都弹软键盘（正是最先修过的 P0 坑）。这里显式接管：
        // 只有正在接受文字输入的面板才保留 #kb 焦点，其余一律 blur。
        const Rf = this.renderer;
        if (!(Rf.settingsOpen_ || Rf.setupOpen_ || Rf.seedStage_ !== SeedStage.None)) this.kb_?.blur();
        const p = this.toLocal(e);
        this.tp_.set(e.pointerId, p);
        // 触摸**不走** hasFocus_ 闸门：手机上收起软键盘会触发一次 blur，而 refocusKb 引起的
        // focus 事件要到下一轮任务才派发，于是那次点击被 `if (!hasFocus_) return` 吞掉，
        // 表现为「第一下点了没反应」。
        this.hasFocus_ = true;
        this.renderer.setMouse(p.x, p.y);

        if (this.tp_.size >= 2) {          // 第二根手指落下 → 捏合
            this.cancelLongPress();
            this.tConsumed_ = true;
            this.tMode_ = 'pinch';
            const pts = [...this.tp_.values()];
            const a = pts[0], b = pts[pts.length - 1];
            const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
            this.tPinch_ = {
                active: true, dist, scale: this.renderer.boardView().s, midX, midY,
                startDist: dist, startMidX: midX, startMidY: midY, moved: false
            };
            return;
        }

        this.tConsumed_ = false;
        this.tStart_ = { x: p.x, y: p.y, t: this.now() };
        if (this.touchWantsBoard(p.x, p.y)) {
            this.tMode_ = 'tap';           // 落子延迟到抬手，好让拖动/长按能取消它
            this.renderer.addRipple(p.x, p.y);
            this.armLongPress(p.x, p.y);
            return;
        }
        // 顶栏按钮、各面板、覆盖层：与鼠标一致，按下即响应
        this.tMode_ = 'none';
        // 只有正在接受文字输入的面板才唤起软键盘；否则**每点一下格子都会弹键盘**，
        // 遮掉半屏还触发 resize（这是触摸端最先要修的坑）。
        const R_ = this.renderer;
        if (R_.settingsOpen_ || R_.setupOpen_ || R_.seedStage_ !== SeedStage.None) this.refocusKb();
        this.onLeftPress(p.x, p.y, false);
    }

    private onTouchMove(e: PointerEvent): void {
        const prev = this.tp_.get(e.pointerId);
        if (!prev) return;
        const p = this.toLocal(e);
        this.tp_.set(e.pointerId, p);

        if (this.tPinch_.active && this.tp_.size >= 2) {
            const pts = [...this.tp_.values()];
            const a = pts[0], b = pts[pts.length - 1];
            const dist = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y));
            const midX = (a.x + b.x) / 2, midY = (a.y + b.y) / 2;
            const v = this.renderer.boardView();
            const s = Math.max(1, Math.min(4, this.tPinch_.scale * dist / this.tPinch_.dist));  // 只放大不缩小
            if (Math.abs(dist - this.tPinch_.startDist) > 12
                || Math.hypot(midX - this.tPinch_.startMidX, midY - this.tPinch_.startMidY) > 12)
                this.tPinch_.moved = true;
            // 让「捏合中点下的那一格」保持不动：先跟着中点平移，再围绕中点缩放
            const tx = v.tx + (midX - this.tPinch_.midX), ty = v.ty + (midY - this.tPinch_.midY);
            const wx = (midX - tx) / v.s, wy = (midY - ty) / v.s;
            this.renderer.setBoardView(s, midX - wx * s, midY - wy * s);
            this.renderer.clampBoardView();
            this.tPinch_.midX = midX; this.tPinch_.midY = midY;
            return;
        }
        // 捏合还没收干净（先抬了一根）：剩下那根手指既不当点击也不当框选，
        // 否则会在棋盘上拖出一个莫名其妙的选区。
        if (this.tPinch_.active) return;

        if (this.tMode_ === 'pan') {
            const v = this.renderer.boardView();
            this.renderer.setBoardView(v.s, v.tx + (p.x - prev.x), v.ty + (p.y - prev.y));
            this.renderer.clampBoardView();
            return;
        }

        if (this.tMode_ === 'tap') {
            if (Math.hypot(p.x - this.tStart_.x, p.y - this.tStart_.y) > 20) {
                this.cancelLongPress();
                this.tConsumed_ = true;
                if (this.renderer.boardView().s > 1.001) this.tMode_ = 'pan';  // 放大后单指拖动 = 平移
                else { this.tMode_ = 'none'; this.renderer.setMouse(-999, -999); }  // 未放大：拖动只用于取消误触
            }
            return;
        }

        this.renderer.setMouse(p.x, p.y);
        this.dragMoveTo(p.x, p.y);
    }

    private onTouchUp(e: PointerEvent, cancelled: boolean): void {
        const at = this.tp_.get(e.pointerId);
        this.tp_.delete(e.pointerId);
        this.cancelLongPress();

        if (this.tPinch_.active) {
            this.tMode_ = 'none';
            if (this.tp_.size === 0) {
                // 双指轻点（既没捏也没移）= 视图复位。捏合缩放本身不可发现，
                // 必须给一个"一键回去"的手势，否则用户放大后不知道怎么还原。
                if (!this.tPinch_.moved) this.renderer.resetBoardView();
                this.tPinch_.active = false;
            } else {
                this.tConsumed_ = true;   // 剩下的那根手指不再算点击
            }
            this.renderer.setMouse(-999, -999);
            this.endDrags();
            return;
        }

        const tap = !cancelled && at !== undefined && this.tMode_ === 'tap' && !this.tConsumed_
            && (this.now() - this.tStart_.t) < 800;
        this.tMode_ = 'none';
        if (tap && at) this.onLeftPress(at.x, at.y, false);
        this.endDrags();
        // 触摸没有"移出"这回事：抬手必须清掉悬停位置，
        // 否则最后点过的那格会永久高亮，看着像 bug（P0-4）。
        this.renderer.setMouse(-999, -999);
    }

    /** 长按 = 鼠标右键（标记菜单）。450ms/20px 是既不误触又不迟钝的经验值
     *  （漂移容差放宽到 20px：真拇指按住微抖常超 10px，会误取消长按） */
    private armLongPress(x: number, y: number): void {
        this.cancelLongPress();
        this.tLongTimer_ = window.setTimeout(() => {
            this.tLongTimer_ = null;
            this.tConsumed_ = true;
            this.tMode_ = 'none';
            // 震动只在 Android 生效（iOS Safari 没有 navigator.vibrate），不支持就静默跳过
            try { if (navigator.vibrate) navigator.vibrate(15); } catch { /* 忽略 */ }
            this.renderer.setMouse(x, y);
            this.onRightPress(x, y);
        }, 450);
    }

    private cancelLongPress(): void {
        if (this.tLongTimer_ !== null) { clearTimeout(this.tLongTimer_); this.tLongTimer_ = null; }
    }

    private boxDragging_ = false;
    private pendingMaxDim_ = kMarkerMaxDim;

    private onCopyCut(e: ClipboardEvent, cut: boolean): void {
        if (this.renderer.seedStage_ !== SeedStage.Load) return;
        let text = this.renderer.seedSelectedText();
        if (text === '') text = this.renderer.seedInput_;
        if (e.clipboardData) { e.preventDefault(); e.clipboardData.setData('text', text); }
        if (cut && this.renderer.seedSelectedText() !== '') this.renderer.seedInputBackspace();
    }

    // ================================================================
    //  输入法上屏文本
    // ================================================================

    /**
     * 中文/日文等输入法拼字结束时把上屏文字送进当前输入框。
     * 走 keydown 是不行的：拼字期间每个按键 `isComposing` 都为真、`key` 是 'Process'，
     * 那些键属于候选词选择，只能整体忽略，于是纯 canvas 的输入框会一个字符都收不到。
     * 路由顺序与 onKey 的分层一致（设置面板 → 种子框 → 数字/透明度输入）。
     */
    private insertText(text: string): void {
        if (text === '') return;
        const R_ = this.renderer;
        if (R_.settingsOpen_) {
            for (const ch of text) R_.settingsChar(ch);
            this.persist();
            return;
        }
        if (R_.seedStage_ === SeedStage.Load) { R_.seedInsert(text); return; }
        if (R_.setupEditing()) { for (const ch of text) R_.setupTextChar(ch); }
    }

    // ================================================================
    //  左键派发（顺序与 main.cpp 完全一致）
    // ================================================================

    private onLeftPress(x: number, y: number, shift: boolean): void {
        const R_ = this.renderer;

        // (1) 二次确认
        if (R_.confirmOpen_) {
            const hit = R_.confirmHit(x, y);
            if (hit === ConfirmHit.Yes) {
                const kind = R_.confirmKind_;
                const wasRestart = kind === ConfirmKind.Restart || kind === ConfirmKind.Switch;
                const wantDiff = this.pendingDiff_;
                this.pendingDiff_ = -1;
                R_.closeConfirm();
                if (wasRestart) {
                    if (wantDiff === 3) { this.customCfg_.copyFrom(this.pendingCustomCfg_); this.newCustom(); }
                    else if (wantDiff >= 0) this.newGame(wantDiff);
                    else this.restartSame();
                } else {
                    this.resetAllSettings();
                    R_.setSeedNote('DEFAULTS RESTORED · 已恢复默认设置');
                }
            } else if (hit === ConfirmHit.Cancel || hit === ConfirmHit.Outside) {
                this.pendingDiff_ = -1;
                R_.closeConfirm();
            }
            return;
        }

        // (2) 帮助
        if (R_.helpOpen_) {
            if (R_.helpHitScrollbar(x, y)) R_.helpDragBegin(x, y);
            else R_.closeHelp();
            return;
        }

        // (3) 设置（模态）
        if (R_.settingsOpen_) {
            if (R_.settingsHitScrollbar(x, y)) { R_.settingsDragBegin(x, y); return; }
            this.handleSettingsHit(R_.settingsHit(x, y));
            return;
        }

        // (4) 种子 UI（模态）
        if (R_.seedStage_ !== SeedStage.None) {
            if (R_.seedBoxMenuIsOpen()) {
                const i = R_.seedBoxMenuItemAt(x, y);
                if (i >= 0) this.seedBoxAction(i);
                else R_.closeSeedBoxMenu();
                return;
            }
            if (R_.seedStage_ === SeedStage.Load && R_.seedHit(x, y) === SeedHit.Box) {
                R_.seedClickInBox(x, shift);
                this.boxDragging_ = true;
                return;
            }
            const hit = R_.seedHit(x, y);
            switch (hit) {
                case SeedHit.MenuCopy: if (this.firstOpened_) this.copySeed('new'); break;
                case SeedHit.MenuSave: if (this.firstOpened_) this.copySeed('save'); break;
                case SeedHit.MenuLoad: R_.openSeedLoadDialog(''); break;
                case SeedHit.MenuTool:
                    this.pendingSeed_ = '';
                    R_.closeSeedUi();
                    openSeedToolbox(this.firstOpened_ ? this.currentSeedText('new') : '');
                    break;
                case SeedHit.Paste: this.readClipboard().then(t => { if (t) R_.seedInputSet(t); }); break;
                case SeedHit.Ok: this.applySeedFromInput(); break;
                case SeedHit.Yes: {
                    const s = this.pendingSeed_;
                    this.pendingSeed_ = '';
                    R_.closeSeedUi();
                    if (s !== '') this.applySeed(s);
                    break;
                }
                case SeedHit.Cancel: case SeedHit.No: case SeedHit.Outside:
                    this.pendingSeed_ = '';
                    R_.closeSeedUi();
                    break;
                default: break;
            }
            return;
        }

        // (4.5) 黄 0 教学弹窗（点弹窗外任意部分关闭并吞掉这一击，不落到棋盘）
        if (R_.zeroTipPopupOpen()) {
            if (R_.zeroTipHit(x, y) === 'outside') R_.closeZeroTip();
            return;
        }

        // (5) 背景不透明度滑块
        const zone = R_.bgHitZone(x, y);
        if (zone === 2) { R_.bgFocusEdit(); return; }
        if (zone === 1) { R_.bgPress(x); return; }

        // (6) 自定义局面面板
        if (R_.setupOpen_) {
            const act = R_.setupPress(x, y);
            if (act === SetupAction.Start) {
                const cand = R_.setupCfg();
                const a = this.availSize();
                const maxC = this.renderer.maxColsAtMinimumCell(a.w);
                const maxR = this.renderer.maxRowsAtMinimumCell(a.h);
                if (cand.cols > maxC || cand.rows > maxR) {
                    R_.setSeedNote(`GRID TOO BIG · 本窗口最多 ${maxC}×${maxR}`);
                    return;
                }
                this.pendingCustomCfg_.copyFrom(cand);
                if (this.firstOpened_ && this.phase_ === Phase.Playing) {
                    this.pendingDiff_ = 3;
                    const what = '自定义局面（' + cand.cols + 'x' + cand.rows + '，' + cand.mines() + '雷）';
                    R_.openSwitchConfirm(what);
                } else {
                    this.customCfg_.copyFrom(cand);
                    this.newCustom();
                }
            } else if (act === SetupAction.Cancel) {
                R_.closeSetup();
            }
            return;
        }

        // (7) 右键标记菜单
        if (R_.menuIsOpen()) {
            const i = R_.menuItemAt(x, y);
            if (i >= 0) {
                const cell = R_.menuCell();
                this.setFlag(cell.r, cell.c, R_.menuOptionAt(i));
            }
            R_.closeMenu();
            return;
        }

        // (8) 表头
        const act = R_.headerActionAt(x, y);
        if (act !== HeaderAction.None) { this.handleHeader(act); return; }

        // (9) 结束覆盖层
        if (this.phase_ !== Phase.Playing) {
            const hit = R_.overlayHit(x, y);
            if (hit === OverlayHit.SameRound) { this.replayCurrentGame(); return; }
            if (hit === OverlayHit.NewGame) { this.restartSame(); return; }
            if (!R_.overlayHidden()) R_.setOverlayHidden(true);
            return;
        }

        // (10) 正常落子
        const cell = R_.cellAt(x, y);
        if (cell) R_.addRipple(x, y);
        const now = this.now();
        const dbl = cell !== null && cell.r === this.lastClickCell_.r && cell.c === this.lastClickCell_.c &&
            (now - this.lastClickTime_) < this.cfg.doubleClickMs;
        this.lastClickCell_ = cell ? { r: cell.r, c: cell.c } : { r: -1, c: -1 };
        this.lastClickTime_ = now;
        if (dbl && cell) { this.doChord(cell); return; }
        if (!cell) return;
        if (this.view.at(cell.r, cell.c).opened) return;
        this.openCell(cell.r, cell.c);
    }

    private handleHeader(act: HeaderAction): void {
        const R_ = this.renderer;
        switch (act) {
            case HeaderAction.Restart: this.wantRestart(); break;
            case HeaderAction.PlayAgain: this.restartSame(); break;
            case HeaderAction.Easy: this.wantDifficulty(0); break;
            case HeaderAction.Medium: this.wantDifficulty(1); break;
            case HeaderAction.Hard: this.wantDifficulty(2); break;
            case HeaderAction.Custom: this.openCustomPanel(); break;
            case HeaderAction.Seed:
                R_.closeSetup(); R_.closeMenu();
                R_.openSeedMenu(this.firstOpened_ ? this.currentSeedText('new') : '', this.firstOpened_,
                    this.firstOpened_ ? this.saveHintText() : '');
                break;
            case HeaderAction.Settings:
                R_.closeSetup(); R_.closeMenu(); R_.closeSeedUi();
                R_.openSettings();
                break;
            case HeaderAction.Help:
                R_.closeSetup(); R_.closeMenu(); R_.closeSeedUi();
                R_.openHelp();
                markHelpSeen();
                break;
            case HeaderAction.HideCounts:
                this.cfg.hideCounts = !this.cfg.hideCounts;
                R_.setHideCounts(this.cfg.hideCounts);
                this.persist();
                break;
            case HeaderAction.Ustc:
                this.cfg.ustcMode = !this.cfg.ustcMode;
                R_.setUstcMode(this.cfg.ustcMode);
                updateFx({ ustcOn: this.cfg.ustcMode });   // 点击弹 USTC 只随这个复选框
                this.persist();
                break;
            case HeaderAction.AlwaysMagnitude:
                this.cfg.alwaysMagnitude = !this.cfg.alwaysMagnitude;
                R_.setAlwaysMagnitude(this.cfg.alwaysMagnitude);
                this.board.boardSetMagnitudeMode(this.cfg.alwaysMagnitude);
                if (this.phase_ === Phase.Playing && this.board.boardWon()) { this.phase_ = Phase.Won; this.stopTimer(); }
                this.persist();
                break;
            default: break;
        }
    }

    private seedBoxAction(i: number): void {
        const R_ = this.renderer;
        if (i === 0) { const t = R_.seedSelectedText(); if (t) this.copyText(t); R_.seedInputBackspace(); }
        else if (i === 1) { const t = R_.seedSelectedText() || R_.seedInput_; this.copyText(t); }
        else if (i === 2) this.readClipboard().then(t => { if (t) R_.seedInsert(t); });
        else R_.seedSelectAll();
        R_.closeSeedBoxMenu();
    }

    // ================================================================
    //  设置面板动作表（对应 main.cpp）
    // ================================================================

    private handleSettingsHit(hit: SettingsHit): void {
        const R_ = this.renderer;
        switch (hit) {
            case SettingsHit.Close: case SettingsHit.Outside: R_.closeSettings(); this.persist(); break;
            case SettingsHit.None: if (R_.settingsFocus() !== 0) R_.focusOn(0); break;
            case SettingsHit.BgField: R_.focusOn(13); break;
            case SettingsHit.BrowseBg:
                this.pendingMaxDim_ = kBgMaxDim;
                this.pickImage(kBgMaxDim, d => {
                    if (d) this.cfg.background.dataUrl = d;
                    this.persist();
                });
                break;
            case SettingsHit.ResetBg: this.cfg.background.dataUrl = ''; this.persist(); break;
            case SettingsHit.HexField: R_.focusOn(5); break;
            case SettingsHit.FieldR: R_.focusOn(6); break;
            case SettingsHit.FieldG: R_.focusOn(7); break;
            case SettingsHit.FieldB: R_.focusOn(8); break;
            case SettingsHit.ResetColor:
                this.cfg.cellR = 102; this.cfg.cellG = 204; this.cfg.cellB = 255;
                R_.focusOn(0); this.persist();
                break;
            case SettingsHit.ChordSilent: this.cfg.chordFail = 'silent'; this.persist(); break;
            case SettingsHit.ChordHint: this.cfg.chordFail = 'hint'; this.persist(); break;
            case SettingsHit.ChordBoom: this.cfg.chordFail = 'boom'; this.persist(); break;
            case SettingsHit.AnimToggle:
                this.cfg.animFx = !this.cfg.animFx;
                this.renderer.resetAnims();   // 关掉时把进行中的动画一次性落到终态
                this.persist();
                break;
            case SettingsHit.DcTrack: R_.settingsPressTrack(this.renderer.mouse().x); this.persist(); break;
            case SettingsHit.DcValue: R_.focusOn(9); break;
            case SettingsHit.StarTrack: R_.settingsPressTrack(this.renderer.mouse().x, 2); this.fxSync(); this.persist(); break;
            case SettingsHit.ScaleTrack: R_.settingsPressTrack(this.renderer.mouse().x, 3); this.fxSync(); this.persist(); break;
            case SettingsHit.StarValue: R_.focusOn(11); break;
            case SettingsHit.ScaleValue: R_.focusOn(12); break;
            case SettingsHit.RestoreAll: R_.openRestoreConfirm(); break;
            case SettingsHit.Field1: R_.focusOn(1); break;
            case SettingsHit.Field2: R_.focusOn(2); break;
            case SettingsHit.Field3: R_.focusOn(3); break;
            case SettingsHit.Field4: R_.focusOn(4); break;
            case SettingsHit.BlankField: R_.focusOn(10); break;
            case SettingsHit.BlankClear: this.cfg.blank.dataUrl = ''; this.cfg.blank.ch = ''; this.persist(); break;
            case SettingsHit.BlankBrowse:
                this.pendingMaxDim_ = kMarkerMaxDim;
                this.pickImage(kMarkerMaxDim, d => { if (d) this.cfg.blank.dataUrl = d; this.persist(); });
                break;
            default: {
                const n = [SettingsHit.Browse1, SettingsHit.Browse2, SettingsHit.Browse3, SettingsHit.Browse4].indexOf(hit);
                const k = [SettingsHit.Clear1, SettingsHit.Clear2, SettingsHit.Clear3, SettingsHit.Clear4].indexOf(hit);
                if (n >= 0) {
                    const idx = n + 1;
                    this.pendingMaxDim_ = kMarkerMaxDim;
                    this.pickImage(kMarkerMaxDim, d => { if (d) this.cfg.marker[idx].dataUrl = d; this.persist(); });
                } else if (k >= 0) {
                    const idx = k + 1;
                    this.cfg.marker[idx].dataUrl = '';
                    this.cfg.marker[idx].ch = '';
                    this.persist();
                }
                break;
            }
        }
    }

    // ================================================================
    //  右键
    // ================================================================

    private onRightPress(x: number, y: number): void {
        const R_ = this.renderer;
        if (R_.seedStage_ === SeedStage.Load) {
            if (R_.seedHit(x, y) === SeedHit.Box) R_.openSeedBoxMenu(x, y);
            else R_.closeSeedBoxMenu();
            return;
        }
        if (R_.setupOpen_) return;
        if (R_.zeroTipPopupOpen()) { // 右键同样遵循「点外关闭」：单技巧也能关掉弹窗
            if (R_.zeroTipHit(x, y) === 'outside') R_.closeZeroTip();
            return;
        }
        if (R_.settingsOpen_ || R_.helpOpen_ || R_.confirmOpen_ || R_.seedStage_ !== SeedStage.None) return;
        if (this.phase_ !== Phase.Playing) { R_.closeMenu(); return; }
        const cell = R_.cellAt(x, y);
        if (cell && !this.view.at(cell.r, cell.c).opened) R_.openMenu(cell, x, y);
        else R_.closeMenu();
    }

    // ================================================================
    //  键盘（分层，与 main.cpp 一致）
    // ================================================================

    private onKey(e: KeyboardEvent): void {
        if (e.isComposing || this.composing_) return; // 输入法拼字期间的按键属于候选词选择，不是游戏快捷键
        const R_ = this.renderer;
        const mod = e.ctrlKey || e.metaKey;
        const key = e.key;

        // (1) 设置面板：吞掉除 Esc/退格/输入以外的所有按键
        if (R_.settingsOpen_) {
            if (key === 'Escape') { if (R_.settingsFocus() !== 0) R_.focusOn(0); else R_.closeSettings(); e.preventDefault(); this.persist(); return; }
            if (key === 'Backspace') { R_.settingsBackspace(); e.preventDefault(); this.persist(); return; }
            if (key === 'Enter') {
                const f = R_.settingsFocus();
                if (f === 9) R_.settingsCommitMs();
                else if (f === 11) { R_.settingsCommitStarDensity(); this.fxSync(); }
                else if (f === 12) { R_.settingsCommitStarScale(); this.fxSync(); }
                else if (f === 13) { R_.settingsCommitBg(); this.persist(); }
                e.preventDefault(); this.persist(); return;
            }
            if (mod) return;
            if (key.length === 1) { R_.settingsChar(key); e.preventDefault(); this.persist(); }
            else e.preventDefault();
            return;
        }

        // (2) 种子 UI
        if (R_.seedStage_ !== SeedStage.None) {
            if (R_.seedBoxMenuIsOpen()) {
                if (key === 'ArrowDown') { R_.seedBoxMenuMove(1); e.preventDefault(); return; }
                if (key === 'ArrowUp') { R_.seedBoxMenuMove(-1); e.preventDefault(); return; }
                if (key === 'Enter') { this.seedBoxAction(R_.seedBoxMenuIndex()); e.preventDefault(); return; }
                if (key === 'Escape') { R_.closeSeedBoxMenu(); e.preventDefault(); return; }
            }
            if (R_.seedStage_ === SeedStage.Menu) {
                if (key === 'ArrowDown') { R_.seedMenuMove(1); e.preventDefault(); return; }
                if (key === 'ArrowUp') { R_.seedMenuMove(-1); e.preventDefault(); return; }
                if (key === 'Enter') {
                    const i = R_.seedMenuItem();
                    if (i === 0 && this.firstOpened_) this.copySeed('new');
                    else if (i === 1 && this.firstOpened_) this.copySeed('save');
                    else R_.openSeedLoadDialog('');
                    e.preventDefault();
                    return;
                }
                if (key === 'Escape') { R_.closeSeedUi(); e.preventDefault(); return; }
                e.preventDefault();
                return;
            }
            if (R_.seedStage_ === SeedStage.Load) {
                if (mod && (key === 'c' || key === 'C')) { e.preventDefault(); this.copySeedBoxText(false); return; }
                if (mod && (key === 'x' || key === 'X')) { e.preventDefault(); this.copySeedBoxText(true); return; }
                if (mod && (key === 'a' || key === 'A')) { e.preventDefault(); R_.seedSelectAll(); return; }
                if (mod && (key === 'v' || key === 'V')) return; // 交给原生 paste 事件
                if (key === 'ArrowLeft') { R_.seedCaretMove(-1, e.shiftKey); e.preventDefault(); return; }
                if (key === 'ArrowRight') { R_.seedCaretMove(1, e.shiftKey); e.preventDefault(); return; }
                if (key === 'Home') { R_.seedCaretMove(-(1 << 20), e.shiftKey); e.preventDefault(); return; }
                if (key === 'End') { R_.seedCaretMove(1 << 20, e.shiftKey); e.preventDefault(); return; }
                if (key === 'Backspace') { R_.seedInputBackspace(); e.preventDefault(); return; }
                if (key === 'Delete') { R_.seedInputDelete(); e.preventDefault(); return; }
                if (key === 'Enter') { this.applySeedFromInput(); e.preventDefault(); return; }
                if (key === 'Escape') { R_.closeSeedUi(); e.preventDefault(); return; }
                if (!mod && key.length === 1) { R_.seedInputChar(key); e.preventDefault(); return; }
                e.preventDefault();
                return;
            }
            if (R_.seedStage_ === SeedStage.Confirm) {
                if (key === 'Enter') {
                    const s = this.pendingSeed_;
                    this.pendingSeed_ = '';
                    R_.closeSeedUi();
                    if (s !== '') this.applySeed(s);
                    e.preventDefault();
                    return;
                }
                if (key === 'Escape') { this.pendingSeed_ = ''; R_.closeSeedUi(); e.preventDefault(); return; }
                e.preventDefault();
                return;
            }
            e.preventDefault();
            return;
        }

        // (3)(4) 自定义局面面板 / 表头透明度输入（桌面端：setupEditing 不受面板开关限制）
        if (R_.setupEditing()) {
            if (key === 'Escape') { R_.setupCancelEdit(); e.preventDefault(); return; }
            if (key === 'Backspace') { R_.setupBackspace(); e.preventDefault(); return; }
            if (key === 'Enter') { R_.setupCommitEdit(); e.preventDefault(); return; }
            if (!mod && /^[0-9]$/.test(key)) { R_.setupTextChar(key); e.preventDefault(); return; }
            if (R_.setupOpen_) { if (key.length === 1) e.preventDefault(); return; }
        }
        if (R_.setupOpen_) {
            if (key === 'Escape') { R_.closeSetup(); e.preventDefault(); return; }
            if (key.length === 1) e.preventDefault();
            return;
        }

        // (5) 右键标记菜单
        if (R_.menuIsOpen()) {
            if (/^[1-5]$/.test(key)) {
                const cell = R_.menuCell();
                this.setFlag(cell.r, cell.c, R_.menuOptionAt(parseInt(key, 10) - 1));
                R_.closeMenu();
                e.preventDefault();
                return;
            }
            if (key === 'ArrowDown') { R_.menuMove(1); e.preventDefault(); return; }
            if (key === 'ArrowUp') { R_.menuMove(-1); e.preventDefault(); return; }
            if (key === 'Enter') {
                const cell = R_.menuCell();
                this.setFlag(cell.r, cell.c, R_.menuHighlightedOption());
                R_.closeMenu();
                e.preventDefault();
                return;
            }
            if (key === 'Escape') { R_.closeMenu(); e.preventDefault(); return; }
            e.preventDefault();
            return;
        }

        // (6) 全局
        // 桌面端的 F1~F5（帮助/重开/三档难度）在网页端一律不接管：F1/F3/F5 是浏览器
        // 自己的帮助、页内查找、刷新，抢过来会让用户按 F5 刷新时弹出切难度确认框。
        // 这些功能在网页端都有可点的按钮（? / RESTART / 9x9 16x16 24x16）。

        const noPanel = !R_.confirmOpen_ && !R_.settingsOpen_ && !R_.setupOpen_ && !R_.helpOpen_ &&
            R_.seedStage_ === SeedStage.None;
        // e.code（物理键位）优先、e.key 兜底，与桌面端 Num1..Num5 / Numpad1..Numpad5 语义一致
        const n = digitFromCode(e.code) || (/^[1-5]$/.test(key) ? parseInt(key, 10) : 0);
        if (n >= 1 && n <= 5 && this.phase_ === Phase.Playing && noPanel) {
            const cell = R_.hoveredCell();
            if (cell && !this.view.at(cell.r, cell.c).opened) {
                this.setFlag(cell.r, cell.c, n === 5 ? MineType.None : n as MineType);
            }
            e.preventDefault();
            return;
        }
        if (key === 'Escape' && this.phase_ !== Phase.Playing && !R_.overlayHidden()) {
            R_.setOverlayHidden(true);
            e.preventDefault();
        }
    }

    private copySeedBoxText(cut: boolean): void {
        const R_ = this.renderer;
        let t = R_.seedSelectedText();
        if (t === '') t = R_.seedInput_;
        this.copyText(t);
        if (cut && R_.seedSelectedText() !== '') R_.seedInputBackspace();
    }

    // ================================================================
    //  主循环
    // ================================================================

    start(): void {
        if (this.running_) return;
        this.running_ = true;
        const step = (ts: number) => {
            if (!this.running_) return;
            this.frame_++;
            this.settleTimer();
            this.renderer.setPlayAgainVisible(this.phase_ !== Phase.Playing);
            this.renderer.tickSeedNote();
            const hud: Hud = {
                remaining: this.board.boardRemaining(),
                seconds: this.currentElapsed(),
                phase: this.phase_,
                paused: this.focusPaused_
            };
            this.renderer.draw(hud, ts);
            // 隐藏标签页里 rAF 会被浏览器停掉，退回定时器保证界面仍然刷新
            if (document.hidden) setTimeout(() => step(performance.now()), 33);
            else requestAnimationFrame(step);
        };
        if (document.hidden) setTimeout(() => step(performance.now()), 33);
        else requestAnimationFrame(step);
    }

    stop(): void { this.running_ = false; }
}
