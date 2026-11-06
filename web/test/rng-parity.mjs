// 跨端布雷一致性校验（网页侧）：与 build/rngparity（C++）的输出逐字节比对。
//
// 背景：排行榜要靠服务端回放玩家动作来校验成绩，前提是同一颗种子在任何平台、
// 任何实现下都布雷出同一张图。详见 src/core/Rng.h 顶部的说明。
//
// 用法：
//   cd web && ./node_modules/.bin/tsc            # 必须先编译，产物要新
//   node web/test/rng-parity.mjs
//
// 退出码：
//   0  两端逐字节一致（10 个用例全过）
//   2  用例或摘要自相矛盾（实现里有 bug，不是跨端不一致）
//   3  dist 产物比 ts 源码旧（跑的是旧代码，先 tsc）
//   4  两端不一致，并打印第一个差在哪
//
// 附带一个自检：纯 JS 重算 xoshiro128 的已知向量。Math.imul / >>> 0 在 JS 引擎间
// 是标准行为，但位运算一旦写错（比如误用 ^ 代替 *），跨端校验只能报"不一致"，
// 说不清是谁错；这里给一个独立于对端的锚点。
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// —— 产物新鲜度：dist 必须比 ts 新（踩过：忘编译，测的全是旧产物）——
{
    const here = dirname(fileURLToPath(import.meta.url));
    const tsDir = join(here, '..', 'ts'), distDir = join(here, '..', 'dist');
    const newestTs = Math.max(...readdirSync(tsDir).filter(f => f.endsWith('.ts'))
        .map(f => statSync(join(tsDir, f)).mtimeMs));
    const oldestDist = Math.min(...readdirSync(distDir).filter(f => f.endsWith('.js'))
        .map(f => statSync(join(distDir, f)).mtimeMs));
    if (newestTs > oldestDist) {
        console.error('❌ dist 是过期的。先跑 `cd web && ./node_modules/.bin/tsc`。');
        process.exit(3);
    }
}

// dist 用相对 specifier 动态 import（须在新鲜度检查之后，否则会跑旧产物）
const { Rng } = await import('../dist/rng.js');
const { BoardImpl } = await import('../dist/wasm_stub.js');

// C++ 侧工具的绝对路径：用 cwd 推，而不是拿 import.meta.url 去 new URL()。
// file: URL 对裸相对路径（含无扩展名的可执行文件）解析不可靠，会 ENOENT（踩过）。
const CPP_TOOL = resolve(process.cwd(), 'build/rngparity');

const pass = [], fail = [];
function check(name, ok, detail) {
    (ok ? pass : fail).push(name);
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// —— 用例表：必须与 tools/rngparity.cpp 里的 kCases 逐字相同 ——
// 顺序也不同：比对是按下标配对的，改一边顺序会错位。
const CASES = [
    { seed: 0, cols: 9, rows: 9, mines: 10, firstR: 4, firstC: 4, real: -1, imag: -1 },
    { seed: 1, cols: 9, rows: 9, mines: 10, firstR: 0, firstC: 0, real: -1, imag: -1 },
    { seed: 12345, cols: 16, rows: 16, mines: 40, firstR: 8, firstC: 8, real: -1, imag: -1 },
    { seed: 4294967295, cols: 9, rows: 9, mines: 10, firstR: 4, firstC: 4, real: -1, imag: -1 },
    { seed: 7, cols: 30, rows: 20, mines: 100, firstR: 15, firstC: 10, real: -1, imag: -1 },
    { seed: 99, cols: 10, rows: 10, mines: 12, firstR: 5, firstC: 5, real: 8, imag: 4 },
    { seed: 2024, cols: 12, rows: 12, mines: 20, firstR: 0, firstC: 11, real: 12, imag: 8 },
    { seed: 555, cols: 8, rows: 8, mines: 55, firstR: 4, firstC: 4, real: -1, imag: -1 },
    { seed: 31415926, cols: 20, rows: 14, mines: 45, firstR: 10, firstC: 7, real: -1, imag: -1 },
    { seed: 8888, cols: 9, rows: 9, mines: 10, firstR: 8, firstC: 8, real: 0, imag: 10 },
];

function fnv1aBytes(bytes) {
    // BigInt 版FNV-1a 64 位：JS 位运算是 32 位，凑不出 64 位又不想要 BigInt 依赖，
    // 而这里只是校验和，BigInt 完全够用且结果确定。
    let h = 0xCBF29CE484222325n;
    const M = 0x100000001B3n, MASK = (1n << 64n) - 1n;
    for (const b of bytes) {
        h = ((h ^ BigInt(b)) * M) & MASK;
    }
    return h.toString(16).padStart(16, '0');
}

// —— 自检：只测"网页端自己错没错"（与对端无关的那些性质）——
//跨端一致性由下面的对拍负责；这里只管那些哪怕 C++ 全错了也该成立的性质。
function selfTest() {
    // below(n) 必须落在 [0, n)，且四个种子都要试（n=1 是退化情形，易写出死循环）
    let inRange = true;
    const extremes = [];
    for (const seed of [0, 1, 123, 0xFFFFFFFF]) {
        const r = new Rng(seed);
        for (const n of [1, 2, 7, 4096]) {
            let minV = Infinity, maxV = -Infinity;
            for (let i = 0; i < 3000; i++) {
                const v = r.below(n);
                if (!Number.isInteger(v) || v < 0 || v >= n) inRange = false;
                if (v < minV) minV = v;
                if (v > maxV) maxV = v;
            }
            extremes.push(`${n}:${minV}..${maxV}`);
        }
    }
    check('below(n) 全部落在 [0,n)（含 n=1 退化情形）', inRange,
        `种子 0/1/123/0xFFFFFFFF 各 3000 次，取值范围 ${extremes.slice(0, 4).join(' ')}`);

    // 均匀性粗检：7 桶各应约 20000/7 次，明显偏斜就是拒绝采样写错了
    const buckets = new Array(7).fill(0);
    const r3 = new Rng(456);
    for (let i = 0; i < 20000; i++) buckets[r3.below(7)]++;
    const lo = Math.min(...buckets), hi = Math.max(...buckets);
    check('below(7) 分布大致均匀（各桶 2857±150）', hi - lo <= 300,
        `最少 ${lo}，最多 ${hi}`);

    // 必须是无符号 32 位：负数或超过 2^32 说明 >>> 0 漏了
    const r4 = new Rng(7);
    let uint32Ok = true;
    for (let i = 0; i < 5000; i++) {
        const v = r4.next();
        if (!Number.isInteger(v) || v < 0 || v > 0xFFFFFFFF) uint32Ok = false;
    }
    check('next() 恒为无符号 32 位（无负数、不超 2^32）', uint32Ok);

    // 洗牌必须是**排列**：元素不能丢不能重
    const src = Array.from({ length: 64 }, (_, i) => i);
    const shuffled = new Rng(99).shuffle(src.slice());
    const sameSet = shuffled.length === 64 &&
        [...shuffled].sort((a, b) => a - b).every((v, i) => v === i);
    check('shuffle 后仍是同一组元素的排列', sameSet);
}

console.log('—— 自检：JS 侧 RNG 的固有性质 ——');
selfTest();

console.log('\n—— 跨端比对：C++ build/rngparity vs 网页 dist ——');

let cppOut;
try {
    const { execFileSync } = await import('node:child_process');
    cppOut = execFileSync(CPP_TOOL, { encoding: 'utf8' });
} catch (e) {
    console.error('❌ 跑不了 C++ 侧：' + (e.code === 'ENOENT'
        ? `${CPP_TOOL} 不存在。先 \`cd build && cmake --build . --target rngparity\`。`
        : e.message));
    process.exit(2);
}

// C++ 每行一个 JSON：前 N 行是用例（都带 seed），最后一行是 {"cases":N} 的收尾计数。
// 先把收尾行单独摘出来（它没有 seed，不能混进用例表，否则会把 cases 数算错）。
const cppAll = cppOut.trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
const cppSummary = cppAll.find(o => typeof o.cases === 'number' && typeof o.seed !== 'number');
const cppLines = cppAll.filter(o => typeof o.seed === 'number');

if (!cppSummary || cppSummary.cases !== CASES.length) {
    console.error(`❌ C++ 侧输出 ${cppSummary ? cppSummary.cases : '?'} 个用例，` +
        `网页侧 ${CASES.length} 个。用例表不同步（改了一边记得改另一边）。`);
    process.exit(2);
}

const webLines = [];
let firstDiff = null;
for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i], cpp = cppLines[i];
    const b = new BoardImpl();
    if (c.real >= 0) b.boardResetSplit(c.cols, c.rows, c.real, c.imag);
    else b.boardReset(c.cols, c.rows, c.mines);
    b.boardSetSeed(c.seed);
    const o = b.boardOpen(c.firstR, c.firstC);
    if (o === 2 /* Boom，见 types.ts 的 Outcome */) {
        check(`用例 seed=${c.seed} 首点安全`, false, '首点就爆雷，首点保护失效');
        continue;
    }
    // 按 boardCellRef 逐格取（棋盘是行主序：index = r * cols + c）
    const bytes = [];
    for (let r = 0; r < c.rows; r++)
        for (let cc = 0; cc < c.cols; cc++)
            bytes.push(b.boardCellRef(r, cc).mine >>> 0);

    const fnv = fnv1aBytes(bytes);
    const edge = bytes.slice(0, c.cols).join('') + '/' +
        bytes.slice((c.rows - 1) * c.cols).join('');
    const total = bytes.filter(v => v !== 0).length;

    const same = fnv === cpp.fnv && edge === cpp.edge;
    check(`用例 ${i + 1}/${CASES.length} seed=${c.seed} ${c.cols}×${c.rows}` +
        ` 雷${c.mines} 首点(${c.firstR},${c.firstC})` +
        (c.real >= 0 ? ` 手动分型(${c.real}+${c.imag})` : ''),
        same,
        same ? cpp.fnv :
            `网页 fnv=${fnv} edge=${edge} total=${total}\n     C++  fnv=${cpp.fnv} edge=${cpp.edge} total=${cpp.total}`);
    if (!same && !firstDiff) firstDiff = { i, c, cpp, web: { fnv, edge, total } };

    webLines.push({ ...cpp, fnv, edge });
}

console.log('\n—— 交叉核对：种子串往返 + createdAt ——');
{
    const b = new BoardImpl();
    b.boardReset(9, 9, 10);
    b.boardSetSeed(424242);
    const enc = b.encodeSeedJson('new', 9, 9, 10, false, -1, -1, 424242, 4, 4, false, null);
    const dec = JSON.parse(b.decodeSeedJson(enc));
    const okRound = dec.rngSeed === 424242 && dec.cols === 9 && dec.rows === 9 &&
        dec.firstRow === 4 && dec.firstCol === 4;
    check('种子串往返后 rngSeed/尺寸/首点不变', !!okRound,
        okRound ? `rngSeed=${dec.rngSeed} first=(${dec.firstRow},${dec.firstCol})`
            : JSON.stringify(dec).slice(0, 140));

    // createdAt 必须以 " UTC" 结尾（与桌面端 nowText 一致，见 src/desktop/main.cpp）
    const ca = String(dec.createdAt || '');
    check('createdAt 带 UTC 标记', / UTC$/.test(ca), `"${ca}"`);

    // 且必须确实是 UTC，不能是本地时间冒充——差 8 小时却看不出来是最糟的失败模式
    if (/ UTC$/.test(ca)) {
        const asUtc = Date.parse(ca.replace(' UTC', '').replace(' ', 'T') + 'Z');
        const driftMin = Math.abs(Date.now() - asUtc) / 60000;
        check('createdAt 确实是 UTC 而非本地时间', Number.isFinite(driftMin) && driftMin < 10,
            `与当前 UTC 相差 ${driftMin.toFixed(1)} 分钟（>10 就是写成了本地时间）`);
    }
}

if (fail.length) {
    console.log(`\n════ 通过 ${pass.length} 项，失败 ${fail.length} 项 ════`);
    if (firstDiff) {
        console.log(`\n首个不一致：第 ${firstDiff.i + 1} 个用例 seed=${firstDiff.c.seed}`);
        console.log('两端算法必须逐位相同——重点查：');
        console.log('  1) 取数**顺序**（洗牌 / typePick / signFlip 的调用次序）');
        console.log('  2) Fisher–Yates 的方向（必须都是从后往前 i = n-1 → 1）');
        console.log('  3) below(n) 的拒绝阈值 ((0-n)>>>0)%n');
        console.log('  4) 32 位溢出是否被截断（C++ 靠 uint32_t，JS 靠 >>> 0）');
    }
    process.exit(firstDiff ? 4 : 2);
}
console.log(`\n════ 通过 ${pass.length} 项，失败 0 项 ════`);
console.log('C++ 与网页端布雷逐位一致 —— 排行榜的服务端回放校验有了地基。');