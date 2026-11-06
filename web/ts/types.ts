// WASM 模块类型定义

export interface MinesweeperModule {
    boardReset(cols: number, rows: number, mines: number): void;
    boardResetSplit(cols: number, rows: number, realMines: number, imagMines: number): void;
    boardOpen(row: number, col: number): number;
    boardChord(row: number, col: number): number;
    boardSetMagnitudeMode(v: boolean): void;
    boardSetFlag(row: number, col: number, mineType: number): void;
    boardWon(): boolean;
    boardLost(): boolean;
    boardCols(): number;
    boardRows(): number;
    boardMineCount(): number;
    boardRemaining(): number;
    boardStarted(): boolean;
    boardUncoveredMines(): number;
    boardAxisUnflagged(): string;   // JSON: {"real":N,"imag":M}
    boardCounts(): string;          // JSON: {"openedSafe":N,"flagged":M}
    boardRandomizeSeed(): void;
    boardSetSeed(seed: number): void;
    boardGetSeed(): number;
    boardFirstRow(): number;
    boardFirstCol(): number;
    boardGetCell(row: number, col: number): string;
    boardCellRef?(row: number, col: number): Cell;
    encodeSeedJson(kind: string, cols: number, rows: number, mines: number,
                   manualSplit: boolean, realMines: number, imagMines: number,
                   rngSeed: number, firstRow: number, firstCol: number,
                   ustcMode: boolean,
                   save?: { elapsedCs: number; phase: string; openedRows: string[]; flagRows: string[] } | null): string;
    decodeSeedJson(text: string): string;
}

export interface Cell {
    opened: boolean;
    mine: number;
    flag: number;
    exploded: boolean;
    adjReal: number;
    adjImag: number;
    adjTotal: number;
}

export enum MineType {
    None = 0,
    Plus1 = 1,
    Minus1 = 2,
    PlusI = 3,
    MinusI = 4
}

export enum Outcome {
    Nothing = 0,
    Opened = 1,
    Boom = 2,
    Won = 3
}

export enum Phase {
    Playing,
    Won,
    Lost
}

/** 渲染器所需的棋盘只读视图 */
export interface BoardView {
    cols(): number;
    rows(): number;
    mineCount(): number;
    remaining(): number;
    started(): boolean;
    uncoveredMines(): number;
    seed(): number;
    axisUnflagged(): { real: number; imag: number };
    counts(): { openedSafe: number; flagged: number };
    at(r: number, c: number): Cell;
}
