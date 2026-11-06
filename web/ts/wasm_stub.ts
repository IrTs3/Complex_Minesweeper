// 完整的扫雷游戏逻辑实现（TypeScript 版本，与桌面端完全一致）

import { MinesweeperModule, Cell, MineType, Outcome } from './types.js';
import { encodeSeed, decodeSeed } from './seedcodec.js';
import { Rng, typePick, signFlip } from './rng.js';

/**
 * 取一个随机的 32 位种子。
 *
 * 注意 crypto.getRandomValues 给的是**无符号** 32 位，而 Math.random()*2^31 只覆盖
 * 一半取值空间（且 `>>> 0` 之前是浮点，高位有精度问题）。种子本身要能占满 uint32，
 * 否则种子分布不均——虽然不影响正确性，但会让"种子"这个概念名不副实。
 */
function randomSeedValue(): number {
    const c: Crypto | undefined = typeof globalThis !== 'undefined'
        ? (globalThis as { crypto?: Crypto }).crypto
        : undefined;
    if (c && typeof c.getRandomValues === 'function') {
        const buf = new Uint32Array(1);
        c.getRandomValues(buf);
        return buf[0] >>> 0;
    }
    return (Math.random() * 4294967296) >>> 0;
}

export class BoardImpl implements MinesweeperModule {
    private cols_: number = 0;
    private rows_: number = 0;
    private mines_: number = 0;
    private realMines_: number = -1;
    private imagMines_: number = -1;
    private flags_: number = 0;
    private typeTotal_: number[] = [0, 0, 0, 0, 0]; // index 0-4
    private placed_: boolean = false;
    private won_: boolean = false;
    private lost_: boolean = false;
    private firstRow_: number = -1;
    private firstCol_: number = -1;
    private magnitudeMode_: boolean = false;
    private seed_: number = 0;
    private grid_: Cell[] = [];
    private rng_: Rng;

    constructor() {
        this.rng_ = new Rng(randomSeedValue());
    }

    boardReset(cols: number, rows: number, mines: number): void {
        this.cols_ = cols;
        this.rows_ = rows;
        this.mines_ = Math.min(mines, cols * rows - 1);
        this.realMines_ = -1;
        this.imagMines_ = -1;
        this.flags_ = 0;
        this.typeTotal_ = [0, 0, 0, 0, 0];
        this.placed_ = false;
        this.won_ = false;
        this.lost_ = false;
        this.firstRow_ = -1;
        this.firstCol_ = -1;
        this.grid_ = [];
        for (let i = 0; i < cols * rows; i++) {
            this.grid_.push({
                opened: false,
                mine: MineType.None,
                flag: MineType.None,
                exploded: false,
                adjReal: 0,
                adjImag: 0,
                adjTotal: 0
            });
        }
    }

    boardResetSplit(cols: number, rows: number, realMines: number, imagMines: number): void {
        const cap = Math.max(1, cols * rows - 1);
        const re = Math.max(0, Math.min(realMines, cap));
        const im = Math.max(0, Math.min(imagMines, cap - re));
        this.boardReset(cols, rows, re + im);
        this.realMines_ = re;
        this.imagMines_ = im;
    }

    boardOpen(row: number, col: number): number {
        if (!this.inBounds(row, col) || this.gameOver()) return Outcome.Nothing;

        const idx = row * this.cols_ + col;
        const cell = this.grid_[idx];
        if (cell.opened || cell.flag !== MineType.None) return Outcome.Nothing;

        if (!this.placed_) {
            this.firstRow_ = row;
            this.firstCol_ = col;
            this.placeMines(row, col);
            this.computeHints();
            this.placed_ = true;
        }

        if (cell.mine !== MineType.None) {
            cell.opened = true;
            cell.exploded = true;
            this.lost_ = true;
            return Outcome.Boom;
        }

        this.floodOpen(row, col);

        if (this.checkWin()) {
            this.won_ = true;
            this.autoFlagAllMines();
            return Outcome.Won;
        }
        if (this.gaugeConsistent()) {
            this.won_ = true;
            return Outcome.Won;
        }
        return Outcome.Opened;
    }

    // 双击/双键 chord：返回 0 不适用 / 1 已展开 / 2 被阻挡（雷没标对）。
    // 取值与桌面端 Board::ChordResult 一一对应（NotApplicable=0, Opened=1, Blocked=2）。
    boardChord(row: number, col: number): number {
        if (this.gameOver() || !this.inBounds(row, col)) return 0;
        const center = this.grid_[row * this.cols_ + col];
        if (!center.opened || center.adjTotal <= 0) return 0;

        let mineNeighbors = 0;
        let allFlagged = true;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = row + dr, nc = col + dc;
                if (!this.inBounds(nr, nc)) continue;
                const n = this.grid_[nr * this.cols_ + nc];
                if (n.mine === MineType.None) continue;
                mineNeighbors++;
                const ok = this.magnitudeMode_ ? (n.flag !== MineType.None) : (n.flag === n.mine);
                if (!ok) allFlagged = false;
            }
        }
        if (mineNeighbors === 0) return 0;
        if (!allFlagged) return 2;

        let openedAny = false;
        for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++) {
                if (dr === 0 && dc === 0) continue;
                const nr = row + dr, nc = col + dc;
                if (!this.inBounds(nr, nc)) continue;
                const n = this.grid_[nr * this.cols_ + nc];
                if (n.opened || n.flag !== MineType.None) continue;
                this.boardOpen(nr, nc);
                openedAny = true;
            }
        }
        return openedAny ? 1 : 0;
    }

    // 切换判胜口径，并在切换后立即重判一次（对齐 src/core/Board.cpp:502-506）。
    // 否则：玩家先把雷标满（符号标反，有符号口径不成立），再勾选「总是显示模长」时，
    // 桌面端立刻判胜、网页端要等到下一次落子才认，表现为"勾了没反应"。
    boardSetMagnitudeMode(v: boolean): void {
        if (this.magnitudeMode_ === v) return;
        this.magnitudeMode_ = v;
        if (this.placed_ && !this.lost_ && this.gaugeConsistent()) this.won_ = true;
    }

    boardSetFlag(row: number, col: number, mineType: number): void {
        if (!this.inBounds(row, col) || this.gameOver()) return;
        const idx = row * this.cols_ + col;
        const cell = this.grid_[idx];
        if (cell.opened || cell.flag === mineType) return;

        if (cell.flag === MineType.None && mineType !== MineType.None) this.flags_++;
        else if (cell.flag !== MineType.None && mineType === MineType.None) this.flags_--;
        
        cell.flag = mineType;

        if (this.placed_ && this.gaugeConsistent()) this.won_ = true;
    }

    boardWon(): boolean {
        return this.won_;
    }

    boardLost(): boolean {
        return this.lost_;
    }

    boardCols(): number {
        return this.cols_;
    }

    boardRows(): number {
        return this.rows_;
    }

    boardMineCount(): number {
        return this.mines_;
    }

    boardRemaining(): number {
        // 经典口径：雷数减全部旗数，多插为负（UI 画红色）。与 src/core/Board.cpp 同步改（2026-10-29）。
        if (!this.placed_) return this.mines_;
        let flags = 0;
        for (let i = 0; i < this.grid_.length; i++) {
            if (this.grid_[i].flag !== MineType.None) flags++;
        }
        return this.mines_ - flags;
    }

    boardStarted(): boolean {
        return this.placed_;
    }

    boardUncoveredMines(): number {
        if (!this.placed_) return 0;
        let n = 0;
        for (const cell of this.grid_) {
            if (cell.mine !== MineType.None && cell.flag === MineType.None) n++;
        }
        return n;
    }

    // 实/虚两轴未被可判胜标记覆盖的剩余数（与桌面端 axisUnflagged 同口径）
    boardAxisUnflagged(): string {
        const out = { real: 0, imag: 0 };
        if (!this.placed_) return JSON.stringify(out);
        const total = this.rows_ * this.cols_;
        const isReal = (t: number) => t === MineType.Plus1 || t === MineType.Minus1;

        let realTotal = 0, imagTotal = 0;
        for (let i = 0; i < total; i++) {
            const mt = this.grid_[i].mine;
            if (mt === MineType.Plus1 || mt === MineType.Minus1) realTotal++;
            if (mt === MineType.PlusI || mt === MineType.MinusI) imagTotal++;
        }
        if (realTotal + imagTotal === 0) return JSON.stringify(out);

        const parent = new Array<number>(total).fill(-1);
        for (let i = 0; i < total; i++) if (this.grid_[i].mine !== MineType.None) parent[i] = i;
        const find = (i: number): number => {
            let r = i;
            while (parent[r] !== r) r = parent[r];
            let cur = i;
            while (parent[cur] !== cur) { const nxt = parent[cur]; parent[cur] = r; cur = nxt; }
            return r;
        };
        const unite = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };

        for (let r = 0; r < this.rows_; r++) {
            for (let c = 0; c < this.cols_; c++) {
                const x = this.grid_[r * this.cols_ + c];
                if (!x.opened || x.adjTotal === 0) continue;
                let first = -1;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (!this.inBounds(nr, nc)) continue;
                    if (this.grid_[nr * this.cols_ + nc].mine === MineType.None) continue;
                    const mi = nr * this.cols_ + nc;
                    if (first === -1) first = mi; else unite(first, mi);
                }
            }
        }

        const realAnchored = new Array<boolean>(total).fill(false);
        const imagAnchored = new Array<boolean>(total).fill(false);
        for (let r = 0; r < this.rows_; r++) {
            for (let c = 0; c < this.cols_; c++) {
                const x = this.grid_[r * this.cols_ + c];
                if (!x.opened || x.adjTotal === 0) continue;
                const pureReal = x.adjImag === 0 && x.adjReal !== 0;
                const pureImag = x.adjReal === 0 && x.adjImag !== 0;
                if (!pureReal && !pureImag) continue;
                for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = r + dr, nc = c + dc;
                    if (!this.inBounds(nr, nc)) continue;
                    const mt = this.grid_[nr * this.cols_ + nc].mine;
                    if (mt === MineType.None) continue;
                    const root = find(nr * this.cols_ + nc);
                    if (pureReal && isReal(mt)) realAnchored[root] = true;
                    if (pureImag && !isReal(mt)) imagAnchored[root] = true;
                }
            }
        }

        const signOf = (t: number) => (t === MineType.Plus1 || t === MineType.PlusI) ? 1 : -1;
        let handledReal = 0, handledImag = 0;
        for (let i = 0; i < total; i++) {
            const mc = this.grid_[i];
            if (mc.mine === MineType.None) continue;
            const root = find(i);
            if (isReal(mc.mine)) {
                if (mc.flag !== MineType.None && isReal(mc.flag)) {
                    if (!realAnchored[root] || signOf(mc.flag) === signOf(mc.mine)) handledReal++;
                }
            } else {
                if (mc.flag !== MineType.None && !isReal(mc.flag)) {
                    if (!imagAnchored[root] || signOf(mc.flag) === signOf(mc.mine)) handledImag++;
                }
            }
        }
        out.real = realTotal - handledReal;
        out.imag = imagTotal - handledImag;
        return JSON.stringify(out);
    }

    boardCounts(): string {
        let openedSafe = 0, flagged = 0;
        for (const cell of this.grid_) {
            if (cell.opened && cell.mine === MineType.None) openedSafe++;
            if (cell.flag !== MineType.None && cell.mine !== MineType.None) flagged++;
        }
        return JSON.stringify({ openedSafe, flagged });
    }

    boardRandomizeSeed(): void {
        this.boardSetSeed(randomSeedValue());
    }

    boardSetSeed(seed: number): void {
        this.seed_ = seed >>> 0;
        this.rng_ = new Rng(this.seed_);   // 整体重置内部状态
    }

    boardGetSeed(): number {
        return this.seed_;
    }

    boardFirstRow(): number {
        return this.firstRow_;
    }

    boardFirstCol(): number {
        return this.firstCol_;
    }

    boardGetCell(row: number, col: number): string {
        if (!this.inBounds(row, col)) {
            return '{"opened":false,"mine":0,"flag":0,"exploded":false,"adjReal":0,"adjImag":0,"adjTotal":0}';
        }
        const cell = this.grid_[row * this.cols_ + col];
        return JSON.stringify({
            opened: cell.opened,
            mine: cell.mine,
            flag: cell.flag,
            exploded: cell.exploded,
            adjReal: cell.adjReal,
            adjImag: cell.adjImag,
            adjTotal: cell.adjTotal
        });
    }

    boardCellRef(row: number, col: number): Cell {
        if (!this.inBounds(row, col)) return BoardImpl.kEmpty;
        return this.grid_[row * this.cols_ + col];
    }

    private static readonly kEmpty: Cell =
        { opened: false, mine: 0, flag: 0, exploded: false, adjReal: 0, adjImag: 0, adjTotal: 0 };

    encodeSeedJson(kind: string, cols: number, rows: number, mines: number,
                   manualSplit: boolean, realMines: number, imagMines: number,
                   rngSeed: number, firstRow: number, firstCol: number,
                   ustcMode: boolean,
                   save?: { elapsedCs: number; phase: string; openedRows: string[]; flagRows: string[] } | null): string {
        return encodeSeed({
            kind, cols, rows, mines, manualSplit, realMines, imagMines,
            rngSeed, firstRow, firstCol,
            elapsedCs: save ? save.elapsedCs : 0,
            phase: save ? save.phase : 'playing',
            openedRows: save ? save.openedRows : [],
            flagRows: save ? save.flagRows : [],
            ustcMode,
            // 生成时间：**统一用 UTC**（与桌面端 nowText() 一致，见 src/desktop/main.cpp）。
            // toISOString() 给的是 UTC；末尾显式补 " UTC"，否则东八区用户会把这串
            // 时间当成自己的本地时间（差 8 小时）。格式两端逐字节相同。
            createdAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
        });
    }

    // 返回解密后的 JSON 明文；非法种子返回空串
    decodeSeedJson(text: string): string {
        const s = decodeSeed(text.trim());
        return s ? JSON.stringify(s) : '';
    }

    // Private helper methods

    private inBounds(r: number, c: number): boolean {
        return r >= 0 && r < this.rows_ && c >= 0 && c < this.cols_;
    }

    private gameOver(): boolean {
        return this.won_ || this.lost_;
    }

    private placeMines(safeR: number, safeC: number): void {
        const total = this.rows_ * this.cols_;
        const banned = new Array<boolean>(total).fill(false);

        const shieldNeighbors = this.mines_ <= total - 9;
        banned[safeR * this.cols_ + safeC] = true;
        if (shieldNeighbors) {
            for (let dr = -1; dr <= 1; dr++) {
                for (let dc = -1; dc <= 1; dc++) {
                    if (dr === 0 && dc === 0) continue;
                    const nr = safeR + dr;
                    const nc = safeC + dc;
                    if (this.inBounds(nr, nc)) {
                        banned[nr * this.cols_ + nc] = true;
                    }
                }
            }
        }

        const candidates: number[] = [];
        for (let i = 0; i < total; i++) {
            if (!banned[i]) candidates.push(i);
        }

        this.mines_ = Math.min(this.mines_, candidates.length);
        this.rng_.shuffle(candidates);

        if (this.realMines_ >= 0) {
            const pool: MineType[] = [];
            for (let i = 0; i < this.realMines_ && pool.length < this.mines_; i++) {
                pool.push(signFlip(this.rng_) ? MineType.Plus1 : MineType.Minus1);
            }
            for (let i = 0; i < this.imagMines_ && pool.length < this.mines_; i++) {
                pool.push(signFlip(this.rng_) ? MineType.PlusI : MineType.MinusI);
            }
            while (pool.length < this.mines_) {
                pool.push(signFlip(this.rng_) ? MineType.Plus1 : MineType.Minus1);
            }

            this.rng_.shuffle(pool);

            for (let k = 0; k < this.mines_; k++) {
                const cell = this.grid_[candidates[k]];
                cell.mine = pool[k];
                this.typeTotal_[pool[k]]++;
            }
        } else {
            for (let k = 0; k < this.mines_; k++) {
                const type = typePick(this.rng_) as MineType;
                const cell = this.grid_[candidates[k]];
                cell.mine = type;
                this.typeTotal_[type]++;
            }
        }
    }

    private computeHints(): void {
        for (let r = 0; r < this.rows_; r++) {
            for (let c = 0; c < this.cols_; c++) {
                const cell = this.grid_[r * this.cols_ + c];
                if (cell.mine !== MineType.None) continue;

                let re = 0;
                let im = 0;
                let n = 0;

                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr;
                        const nc = c + dc;
                        if (!this.inBounds(nr, nc)) continue;
                        
                        const neighbor = this.grid_[nr * this.cols_ + nc];
                        switch (neighbor.mine) {
                            case MineType.Plus1: re += 1; n++; break;
                            case MineType.Minus1: re -= 1; n++; break;
                            case MineType.PlusI: im += 1; n++; break;
                            case MineType.MinusI: im -= 1; n++; break;
                        }
                    }
                }

                cell.adjReal = re;
                cell.adjImag = im;
                cell.adjTotal = n;
            }
        }
    }

    private floodOpen(r: number, c: number): void {
        const stack: [number, number][] = [[r, c]];
        while (stack.length > 0) {
            const [cr, cc] = stack.pop()!;
            if (!this.inBounds(cr, cc)) continue;
            
            const cell = this.grid_[cr * this.cols_ + cc];
            if (cell.opened || cell.flag !== MineType.None || cell.mine !== MineType.None) continue;
            
            cell.opened = true;
            
            if (cell.adjTotal === 0) {
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = cr + dr;
                        const nc = cc + dc;
                        if (!this.inBounds(nr, nc)) continue;
                        
                        const neighbor = this.grid_[nr * this.cols_ + nc];
                        if (!neighbor.opened && neighbor.flag === MineType.None && neighbor.mine === MineType.None) {
                            stack.push([nr, nc]);
                        }
                    }
                }
            }
        }
    }

    private checkWin(): boolean {
        for (const cell of this.grid_) {
            if (cell.mine === MineType.None && !cell.opened) return false;
        }
        return true;
    }

    private autoFlagAllMines(): void {
        for (const cell of this.grid_) {
            if (cell.mine !== MineType.None) cell.flag = cell.mine;
        }
        this.flags_ = this.mines_;
    }

    // 判胜分派：与桌面端 src/core/Board.cpp:496-498 同语义——口径由 magnitudeMode_ 决定。
    // 历史 bug：本函数原先直接写成有符号口径、从不读 magnitudeMode_，且模长口径的实现
    // 完全缺失，导致「总是显示模长」模式下判胜永远按有符号口径走（该模式等于不可用）。
    private gaugeConsistent(): boolean {
        return this.magnitudeMode_ ? this.allMinesFlaggedMagnitudeConsistent()
                                   : this.allMinesFlaggedGaugeConsistent();
    }

    // 模长口径（「总是显示模长」）：玩家看不到符号，判据放宽为
    //   ① 标记集合与雷集合完全一致（标记总数 == 雷数 且 每颗雷都有标记 => 不多不少）
    //   ② 每个已翻开格的「可见模长」|Σ雷| 恰好等于其邻域「标记和」的模长 |Σ标|
    // 比较用模长平方（|z| 相同 ⟺ |z|² 相同），避免开方与浮点误差。
    // 逐行对照 src/core/Board.cpp:467-494（注意 TS 字段名 adjReal/adjImag）。
    private allMinesFlaggedMagnitudeConsistent(): boolean {
        if (!this.placed_ || this.mines_ <= 0) return false;
        if (this.flags_ !== this.mines_) return false;

        const reOf = (t: MineType): number => (t === MineType.Plus1 ? 1 : t === MineType.Minus1 ? -1 : 0);
        const imOf = (t: MineType): number => (t === MineType.PlusI ? 1 : t === MineType.MinusI ? -1 : 0);

        for (const x of this.grid_) {
            if (x.mine !== MineType.None && x.flag === MineType.None) return false; // 每颗雷都必须有标记
        }
        for (let r = 0; r < this.rows_; ++r) {
            for (let c = 0; c < this.cols_; ++c) {
                const x = this.grid_[r * this.cols_ + c];
                if (!x.opened) continue;
                let reF = 0, imF = 0;
                for (let dr = -1; dr <= 1; ++dr) {
                    for (let dc = -1; dc <= 1; ++dc) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr, nc = c + dc;
                        if (!this.inBounds(nr, nc)) continue;
                        reF += reOf(this.grid_[nr * this.cols_ + nc].flag);
                        imF += imOf(this.grid_[nr * this.cols_ + nc].flag);
                    }
                }
                const sMine = x.adjReal * x.adjReal + x.adjImag * x.adjImag; // 真实和的模长² == 可见提示
                if (reF * reF + imF * imF !== sMine) return false;
            }
        }
        return true;
    }

    private allMinesFlaggedGaugeConsistent(): boolean {
        if (!this.placed_ || this.mines_ <= 0) return false;
        if (this.flags_ !== this.mines_) return false;

        const total = this.rows_ * this.cols_;
        const parent = new Array<number>(total).fill(-1);
        
        for (let i = 0; i < total; i++) {
            if (this.grid_[i].mine !== MineType.None) parent[i] = i;
        }

        const find = (i: number): number => {
            let r = i;
            while (parent[r] !== r) r = parent[r];
            let cur = i;
            while (parent[cur] !== cur) {
                const nxt = parent[cur];
                parent[cur] = r;
                cur = nxt;
            }
            return r;
        };

        const unite = (a: number, b: number) => {
            const ra = find(a), rb = find(b);
            if (ra !== rb) parent[rb] = ra;
        };

        for (let r = 0; r < this.rows_; r++) {
            for (let c = 0; c < this.cols_; c++) {
                const cell = this.grid_[r * this.cols_ + c];
                if (!cell.opened || cell.adjTotal === 0) continue;
                
                let first = -1;
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr;
                        const nc = c + dc;
                        if (!this.inBounds(nr, nc)) continue;
                        
                        if (this.grid_[nr * this.cols_ + nc].mine !== MineType.None) {
                            const mi = nr * this.cols_ + nc;
                            if (first === -1) first = mi;
                            else unite(first, mi);
                        }
                    }
                }
            }
        }

        const isRealMine = (t: MineType) => t === MineType.Plus1 || t === MineType.Minus1;
        const signOf = (t: MineType) => (t === MineType.Plus1 || t === MineType.PlusI) ? 1 : -1;

        const realAnchored = new Array<boolean>(total).fill(false);
        const imagAnchored = new Array<boolean>(total).fill(false);

        for (let r = 0; r < this.rows_; r++) {
            for (let c = 0; c < this.cols_; c++) {
                const cell = this.grid_[r * this.cols_ + c];
                if (!cell.opened || cell.adjTotal === 0) continue;
                
                const re = Math.abs(cell.adjReal);
                const im = Math.abs(cell.adjImag);
                
                let kind: 'Empty' | 'PureReal' | 'PureImag' | 'Mixed' = 'Empty';
                if (re === 0 && im === 0) kind = 'Empty';
                else if (im === 0) kind = 'PureReal';
                else if (re === 0) kind = 'PureImag';
                else kind = 'Mixed';
                
                if (kind !== 'PureReal' && kind !== 'PureImag') continue;
                
                for (let dr = -1; dr <= 1; dr++) {
                    for (let dc = -1; dc <= 1; dc++) {
                        if (dr === 0 && dc === 0) continue;
                        const nr = r + dr;
                        const nc = c + dc;
                        if (!this.inBounds(nr, nc)) continue;
                        
                        const mt = this.grid_[nr * this.cols_ + nc].mine;
                        if (mt === MineType.None) continue;
                        
                        const root = find(nr * this.cols_ + nc);
                        if (kind === 'PureReal' && isRealMine(mt)) realAnchored[root] = true;
                        if (kind === 'PureImag' && !isRealMine(mt)) imagAnchored[root] = true;
                    }
                }
            }
        }

        const seen = new Array<boolean>(total).fill(false);
        const realFlip = new Array<number>(total).fill(-1);
        const imagFlip = new Array<number>(total).fill(-1);

        for (let i = 0; i < total; i++) {
            const cell = this.grid_[i];
            if (cell.mine === MineType.None) continue;
            if (cell.flag === MineType.None) return false;
            if (isRealMine(cell.flag) !== isRealMine(cell.mine)) return false;
            
            const root = find(i);
            seen[root] = true;
            
            const f = signOf(cell.flag) !== signOf(cell.mine) ? 1 : 0;
            if (isRealMine(cell.mine)) {
                if (realFlip[root] === -1) realFlip[root] = f;
                else if (realFlip[root] !== f) return false;
            } else {
                if (imagFlip[root] === -1) imagFlip[root] = f;
                else if (imagFlip[root] !== f) return false;
            }
        }

        for (let root = 0; root < total; root++) {
            if (!seen[root]) continue;
            if (realFlip[root] === 1 && realAnchored[root]) return false;
            if (imagFlip[root] === 1 && imagAnchored[root]) return false;
        }

        return true;
    }
}

export const wasmStub: MinesweeperModule = new BoardImpl();
