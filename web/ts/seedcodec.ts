// 种子 / 存档编解码：与桌面端 src/core/Rabbit.h + Seed.h 完全一致的格式，
// 保证网页与桌面端的种子串可以互相导入。
//
// ★ K_SEED_KEY 这层是**混淆，不是加密**（2026-10-21 安全审查 M5）：
//   密钥硬编码且随产物发布，Rabbit 没有 IV 也没有 MAC —— 任何人都能离线伪造
//   一个"看起来合法"的种子/存档。它只防随手改数字逗你玩，不防伪造。
//   服务端做任何校验都必须用独立密钥重算，别拿它当信任根。

const K_SEED_MAGIC = 'MSD1';
const K_SEED_KEY = 'TY0712#66ccff';

export interface SeedData {
    kind: string;
    cols: number;
    rows: number;
    mines: number;
    manualSplit: boolean;
    realMines: number;
    imagMines: number;
    rngSeed: number;
    firstRow: number;
    firstCol: number;
    // —— 进度存档（kind = "save" 时有效）——
    elapsedCs: number;
    phase: string;
    openedRows: string[];
    flagRows: string[];
    ustcMode: boolean;
    createdAt: string;
}

class RabbitStream {
    private x = new Uint32Array(8);
    private c = new Uint32Array(8);
    private carry = 0;
    private block = new Uint8Array(16);
    private pos = 16;

    constructor(password: string) {
        const key = new Uint8Array(16);
        if (password.length > 0) {
            for (let i = 0; i < 16; ++i) key[i] = password.charCodeAt(i % password.length) & 0xff;
        }
        this.keySetup(key);
    }

    crypt(input: Uint8Array): Uint8Array {
        const out = new Uint8Array(input.length);
        for (let i = 0; i < input.length; ++i) {
            if (this.pos >= 16) this.refill();
            out[i] = input[i] ^ this.block[this.pos++];
        }
        return out;
    }

    private keySetup(key: Uint8Array) {
        const k = new Uint32Array(8);
        for (let i = 0; i < 8; ++i) k[i] = (key[14 - 2 * i] << 8) | key[15 - 2 * i];
        for (let j = 0; j < 8; ++j) {
            const j1 = (j + 1) % 8, j4 = (j + 4) % 8, j5 = (j + 5) % 8;
            if (j % 2 === 0) {
                this.x[j] = (k[j1] << 16) | k[j];
                this.c[j] = (k[j4] << 16) | k[j5];
            } else {
                this.x[j] = (k[j5] << 16) | k[j4];
                this.c[j] = (k[j] << 16) | k[j1];
            }
        }
        this.carry = 0;
        for (let i = 0; i < 4; ++i) this.step();
        for (let j = 0; j < 8; ++j) this.c[j] = (this.c[j] ^ this.x[(j + 4) % 8]) >>> 0;
        this.pos = 16;
    }

    private step() {
        const kA = [0x4D34D34D, 0xD34D34D3, 0x34D34D34, 0x4D34D34D,
                    0xD34D34D3, 0x34D34D34, 0x4D34D34D, 0xD34D34D3];
        for (let j = 0; j < 8; ++j) {
            const t = this.c[j] + kA[j] + this.carry;
            this.carry = Math.floor(t / 4294967296);
            this.c[j] = t >>> 0;
        }
        const g = new Uint32Array(8);
        for (let j = 0; j < 8; ++j) {
            const u = (this.x[j] + this.c[j]) >>> 0;
            const sq = (BigInt(u) * BigInt(u)) & 0xFFFFFFFFFFFFFFFFn;
            g[j] = (Number(sq & 0xFFFFFFFFn) ^ Number((sq >> 32n) & 0xFFFFFFFFn)) >>> 0;
        }
        const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;
        this.x[0] = (g[0] + rotl(g[7], 16) + rotl(g[6], 16)) >>> 0;
        this.x[1] = (g[1] + rotl(g[0], 8) + g[7]) >>> 0;
        this.x[2] = (g[2] + rotl(g[1], 16) + rotl(g[0], 16)) >>> 0;
        this.x[3] = (g[3] + rotl(g[2], 8) + g[1]) >>> 0;
        this.x[4] = (g[4] + rotl(g[3], 16) + rotl(g[2], 16)) >>> 0;
        this.x[5] = (g[5] + rotl(g[4], 8) + g[3]) >>> 0;
        this.x[6] = (g[6] + rotl(g[5], 16) + rotl(g[4], 16)) >>> 0;
        this.x[7] = (g[7] + rotl(g[6], 8) + g[5]) >>> 0;
    }

    private extract(out: Uint8Array) {
        const x = this.x;
        const s = [
            x[0] ^ (x[5] >>> 16),
            (x[0] >>> 16) ^ x[3],
            x[2] ^ (x[7] >>> 16),
            (x[2] >>> 16) ^ x[5],
            x[4] ^ (x[1] >>> 16),
            (x[4] >>> 16) ^ x[7],
            x[6] ^ (x[3] >>> 16),
            (x[6] >>> 16) ^ x[1],
        ];
        for (let i = 0; i < 8; ++i) {
            out[2 * i] = (s[7 - i] >> 8) & 0xff;
            out[2 * i + 1] = s[7 - i] & 0xff;
        }
    }

    private refill() {
        this.step();
        this.extract(this.block);
        this.pos = 0;
    }
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(data: Uint8Array): string {
    let out = '';
    for (let i = 0; i < data.length; i += 3) {
        const b0 = data[i];
        const b1 = i + 1 < data.length ? data[i + 1] : 0;
        const b2 = i + 2 < data.length ? data[i + 2] : 0;
        const v = (b0 << 16) | (b1 << 8) | b2;
        out += B64[(v >> 18) & 63];
        out += B64[(v >> 12) & 63];
        out += i + 1 < data.length ? B64[(v >> 6) & 63] : '=';
        out += i + 2 < data.length ? B64[v & 63] : '=';
    }
    return out;
}

function base64Decode(s: string): Uint8Array | null {
    const val = (ch: string): number => {
        if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0) - 65;
        if (ch >= 'a' && ch <= 'z') return ch.charCodeAt(0) - 97 + 26;
        if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48 + 52;
        if (ch === '+') return 62;
        if (ch === '/') return 63;
        return -1;
    };
    const out: number[] = [];
    let buf = 0, bits = 0;
    for (const ch of s) {
        if (ch === '=' || ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
        const v = val(ch);
        if (v < 0) return null;
        buf = (buf << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            out.push((buf >> bits) & 0xff);
        }
    }
    return Uint8Array.from(out);
}

function seedToJson(s: SeedData): string {
    const b = (v: boolean) => (v ? 'true' : 'false');
    const arr = (name: string, rows: string[]): string => {
        let out = `  "${name}": [`;
        for (let i = 0; i < rows.length; ++i) {
            out += (i === 0 ? '\n' : ',\n');
            out += `    "${rows[i]}"`;
        }
        out += (rows.length === 0 ? '],\n' : '\n  ],\n');
        return out;
    };
    let j = '{\n';
    j += `  "magic": "${K_SEED_MAGIC}",\n`;
    j += '  "version": 1,\n';
    // 字符串字段一律走 JSON.stringify（自带引号与转义）：createdAt 等值虽经
    // ASCII 白名单，仍可含双引号/反斜杠/控制字符，直接拼接会产形 JSON 并能注入字段。
    j += `  "kind": ${JSON.stringify(s.kind)},\n`;
    j += `  "cols": ${s.cols},\n`;
    j += `  "rows": ${s.rows},\n`;
    j += `  "mines": ${s.mines},\n`;
    j += `  "manualSplit": ${b(s.manualSplit)},\n`;
    j += `  "realMines": ${s.realMines},\n`;
    j += `  "imagMines": ${s.imagMines},\n`;
    j += `  "rngSeed": ${s.rngSeed},\n`;
    j += `  "firstRow": ${s.firstRow},\n`;
    j += `  "firstCol": ${s.firstCol},\n`;
    if (s.kind === 'save') {
        j += `  "elapsedCs": ${s.elapsedCs},\n`;
        j += `  "phase": ${JSON.stringify(s.phase)},\n`;
        j += arr('opened', s.openedRows);
        j += arr('flags', s.flagRows);
    }
    j += `  "ustcMode": ${b(s.ustcMode)},\n`;
    j += `  "createdAt": ${JSON.stringify(s.createdAt)}\n`;
    j += '}\n';
    return j;
}

// 明文 JSON → SeedData。**契约必须与 src/core/Seed.h 的 seedFromJson 逐条一致**
// （2026-10-22 安全审计 P11/P12）。一致性由 web/test/seed-parse-parity.mjs 对拍证明。
//
// ★ 原来这里的整数校验是「转成 NaN 再让范围检查去躲」：
//     const int = (v, d) => { const n = Number(v ?? d); return Number.isInteger(n) ? n : NaN; };
//   而 NaN 跟任何数比较都是 false —— 于是 "cols": 9.5 会变成 NaN，
//   **躲过全部范围检查**，一路带着 NaN 走进棋盘分配（cols*rows = NaN → 循环 0 次
//   → 棋盘是空的）。同时桌面端对同样的明文会 strtol 失败 → **回退默认值 9**
//   （当成一个合法的 9×9 局）。于是**同一个种子串在两端解出不同的棋盘** ——
//   而「同一种子处处同一局」正是排行榜回放校验的地基。
//
// 现在改成 **fail-closed**：字段存在但不是「有限整数」/ 不是真布尔 / 不是字符串
// → **整条种子拒收**，绝不静默回退默认值，也绝不产生 NaN。
//
// 契约逐条（与桌面端注释一一对应）：
//   1) 明文必须是合法 JSON 且顶层是对象；解析失败 / 顶层不是对象 → 拒收。
//   2) magic 必须是字符串 "MSD1"；kind 必须是字符串 "new" 或 "save"。
//   3) 数字字段：必须是 JSON 数字、有限、整数；缺失 → 默认值；否则 → 整条拒收。
//   4) 布尔字段（manualSplit / ustcMode）：必须是 JSON 布尔；缺失 → false。
//   5) 文本字段（createdAt）：必须是纯 ASCII 字符串；缺失 → ""。
//   6) phase：必须是 playing/won/lost；缺失 → "playing"。
//   7) opened / flags：必须是字符串数组（元素也纯 ASCII）；缺失 → 空数组。
//   8) 区间是溢出护栏（cols/rows/mines… ∈ [-1, 1e9]；rngSeed ∈ [0, 0xFFFFFFFF]；
//      elapsedCs ∈ [0, 36e6]；elapsedSec ∈ [0, 360000]），语义由 seedIsSane 收紧。
//   9) 顶层成员的**值**必须是标量或标量数组 —— 不允许嵌套容器。
//      （两端解析器的深度上限本来就可能不同；限制形状后，任何嵌套输入在两端
//        都被同一条规则拒收，深度上限只影响"以什么理由拒收"。）
const K_SEED_NUM_LIMIT = 1000000000;   // 与桌面端 kSeedNumLimit 同值
const K_MAX_ELAPSED_CS = 36000000;     // 与桌面端 kMaxElapsedCs 同值
const K_RNG_SEED_MAX = 4294967295;     // 与桌面端 kRngSeedMax 同值（= 0xFFFFFFFF）

/** 纯 ASCII 检查（与桌面端 json::isAscii 同口径：字节 >= 0x80 即非 ASCII）。 */
function isAscii(s: string): boolean {
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 0x7f) return false;
    return true;
}

/** 标量判定：字符串 / 数字 / 布尔 / null（不含对象与数组）。 */
function isScalar(v: unknown): boolean {
    const t = typeof v;
    return t === 'string' || t === 'number' || t === 'boolean' || v === null;
}

/** 顶层对象里不允许嵌套容器（与桌面端 seedJsonFlatObject 同口径）。 */
function isFlatObject(o: Record<string, unknown>): boolean {
    for (const k of Object.keys(o)) {
        const v = o[k];
        if (Array.isArray(v)) {
            for (const e of v) if (!isScalar(e)) return false;
        } else if (!isScalar(v)) {
            return false;
        }
    }
    return true;
}

/** 数字字段：缺失 → def；存在但不是「有限整数」或越界 → null（整条拒收）。 */
function intField(o: Record<string, unknown>, key: string, def: number, lo: number, hi: number): number | null {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return def;
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) return null;
    if (v < lo || v > hi) return null;
    return v;
}

/** 布尔字段：缺失 → def；存在但不是 JSON 布尔 → null。 */
function boolField(o: Record<string, unknown>, key: string, def: boolean): boolean | null {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return def;
    const v = o[key];
    if (typeof v !== 'boolean') return null;
    return v;
}

/** 文本字段：缺失 → def；存在但不是字符串 / 含非 ASCII → null。 */
function textField(o: Record<string, unknown>, key: string, def: string): string | null {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return def;
    const v = o[key];
    if (typeof v !== 'string' || !isAscii(v)) return null;
    return v;
}

/** 字符串数组字段：缺失 → []；存在但不是数组 / 元素不是字符串 / 含非 ASCII → null。 */
function textArrayField(o: Record<string, unknown>, key: string): string[] | null {
    if (!Object.prototype.hasOwnProperty.call(o, key)) return [];
    const v = o[key];
    if (!Array.isArray(v)) return null;
    const out: string[] = [];
    for (const e of v) {
        if (typeof e !== 'string' || !isAscii(e)) return null;
        out.push(e);
    }
    return out;
}

// 导出是为了跨端对拍（web/test/seed-parse-parity.mjs）：桌面端要对同一张用例表
// 给出逐字节相同的判定与字段值。
export function seedFromJson(text: string): SeedData | null {
    let obj: any;
    try {
        obj = JSON.parse(text);
    } catch {
        return null;
    }
    // 1) 顶层必须是对象，且成员值不允许嵌套容器
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (!isFlatObject(obj as Record<string, unknown>)) return null;
    const o = obj as Record<string, unknown>;

    // 2) magic 与 kind：必须是字符串且取值合法
    if (o.magic !== K_SEED_MAGIC) return null;
    if (o.kind !== 'new' && o.kind !== 'save') return null;

    // 3) 数字字段：缺失 → 默认值；存在但不合格 → 整条拒收（不再产生 NaN）
    const lim = K_SEED_NUM_LIMIT;
    const cols = intField(o, 'cols', 9, -lim, lim);
    const rows = intField(o, 'rows', 9, -lim, lim);
    const mines = intField(o, 'mines', 10, -lim, lim);
    const realMines = intField(o, 'realMines', -1, -lim, lim);
    const imagMines = intField(o, 'imagMines', -1, -lim, lim);
    const firstRow = intField(o, 'firstRow', -1, -lim, lim);
    const firstCol = intField(o, 'firstCol', -1, -lim, lim);
    const rng = intField(o, 'rngSeed', 0, 0, K_RNG_SEED_MAX);
    if (cols === null || rows === null || mines === null || realMines === null ||
        imagMines === null || firstRow === null || firstCol === null || rng === null) {
        return null;
    }
    // 4) 布尔字段：必须是 JSON 布尔（原来字符串 "true" 会被当真 → 与桌面端分型不同）
    const manualSplit = boolField(o, 'manualSplit', false);
    const ustcMode = boolField(o, 'ustcMode', false);
    if (manualSplit === null || ustcMode === null) return null;
    // 5) 文本字段：必须是纯 ASCII 字符串
    const createdAt = textField(o, 'createdAt', '');
    if (createdAt === null) return null;

    const s: SeedData = {
        kind: o.kind as 'new' | 'save',
        cols, rows, mines,
        manualSplit,
        realMines, imagMines,
        rngSeed: rng,
        firstRow, firstCol,
        elapsedCs: 0,
        phase: 'playing',
        openedRows: [],
        flagRows: [],
        ustcMode,
        createdAt
    };
    if (s.cols < 5 || s.rows < 5 || s.mines < 2) return null;
    if (s.firstRow < 0 || s.firstCol < 0 || s.firstRow >= s.rows || s.firstCol >= s.cols) return null;
    // 手动分型时 mines 必须等于 real+imag（与桌面端 seedFromJson 同一条，缺了会造 0 雷盘）
    if (s.manualSplit && s.mines !== s.realMines + s.imagMines) return null;

    if (s.kind === 'save') {
        let elapsedCs = intField(o, 'elapsedCs', -1, -1, K_MAX_ELAPSED_CS);
        if (elapsedCs === null) return null;
        if (elapsedCs < 0) {  // 兼容旧存档：字段名 elapsedSec，单位秒
            const elapsedSec = intField(o, 'elapsedSec', 0, 0, K_MAX_ELAPSED_CS / 100);
            if (elapsedSec === null) return null;
            elapsedCs = elapsedSec * 100;
        }
        s.elapsedCs = elapsedCs;
        const phase = textField(o, 'phase', 'playing');
        if (phase === null) return null;
        s.phase = phase;
        if (s.phase !== 'playing' && s.phase !== 'won' && s.phase !== 'lost') return null;
        // 6) 存档行：必须是字符串数组，且尺寸与棋盘严格一致
        const openedRows = textArrayField(o, 'opened');
        const flagRows = textArrayField(o, 'flags');
        if (openedRows === null || flagRows === null) return null;
        s.openedRows = openedRows;
        s.flagRows = flagRows;
        if (s.openedRows.length !== s.rows) return null;
        if (s.flagRows.length !== s.rows) return null;
        for (let r = 0; r < s.rows; ++r) {
            if (s.openedRows[r].length !== s.cols || s.flagRows[r].length !== s.cols) return null;
        }
    }
    return s;
}

export function seedIsSane(s: SeedData): boolean {
    const cells = s.cols * s.rows;
    if (s.cols < 1 || s.rows < 1) return false;
    if (s.cols > 300 || s.rows > 300 || cells > 40000) return false;
    if (s.mines < 0 || s.mines > cells - 1) return false;
    if (s.realMines < -1 || s.imagMines < -1) return false;
    if (s.manualSplit) {
        if (s.realMines < 0 || s.imagMines < 0) return false;
        if (s.realMines + s.imagMines > cells - 1) return false;
        if (s.mines !== s.realMines + s.imagMines) return false;
    } else if (s.realMines >= 0 && s.imagMines >= 0) {
        if (s.realMines + s.imagMines > cells - 1) return false;
    }
    if (s.firstRow < -1 || s.firstCol < -1 || s.firstRow > s.rows || s.firstCol > s.cols) return false;
    return true;
}

export function encodeSeed(s: SeedData, key: string = K_SEED_KEY): string {
    const json = seedToJson(s);
    const bytes = new TextEncoder().encode(json);
    const ct = new RabbitStream(key).crypt(bytes);
    return base64Encode(ct);
}

// JSON 的合法空白：RFC 8259 只有这 4 个（空格 / \t / \n / \r）。
// ★ 必须与 src/core/Seed.h 的 jsonWs、tools/base.cpp 的同名判据**完全同口径**：
//   三端任何一处宽窄不一致，跨端种子互导就会静默失效（表现成「密码错误」）。
//   2026-10-21 安全审计 P7：原实现只跳空格和 \t，于是 `"magic"\n: "MSD1"`
//   这种排版会被判成错密码。
export function isJsonWs(c: string): boolean {
    return c === ' ' || c === '\t' || c === '\n' || c === '\r';
}

// JSON 里取字段值并与期望比较：**容忍任意空白**。
// 为什么不直接 includes(`"magic": "${K_SEED_MAGIC}"`)：那个判据依赖冒号后那个空格，
// 哪天这里改用 JSON.stringify（默认紧凑输出），三处会一起静默失效、还报成「密码错」。
// 必须与 src/core/Seed.h 的 jsonFieldEquals 行为一致（跨端判据要同口径）。
export function jsonFieldEquals(json: string, key: string, value: string): boolean {
    const pat = '"' + key + '"';
    const want = '"' + value + '"';
    let from = 0;
    for (;;) {
        const p = json.indexOf(pat, from);
        if (p < 0) return false;
        let i = p + pat.length;
        while (i < json.length && isJsonWs(json[i])) i++;
        if (json[i] === ':') {
            i++;
            while (i < json.length && isJsonWs(json[i])) i++;
            if (json.startsWith(want, i)) return true;
        }
        from = p + 1;
    }
}

export function decodeSeed(text: string, key: string = K_SEED_KEY): SeedData | null {
    const ct = base64Decode(text);
    if (!ct) return null;
    const pt = new RabbitStream(key).crypt(ct);
    const json = new TextDecoder().decode(pt);
    if (!jsonFieldEquals(json, 'magic', K_SEED_MAGIC)) return null;
    return seedFromJson(json);
}
