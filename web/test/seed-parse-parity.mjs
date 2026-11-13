// seed-parse-parity.mjs —— 种子明文解析的**跨端对拍闸门**
//
// 比对两件事：
//   1) 桌面端（src/core/Seed.h 的 seedFromJson，走自带的 SeedJson.h 解析器）
//      与网页端（web/ts/seedcodec.ts 的 seedFromJson，走 V8 的 JSON.parse）
//      对同一张用例表给出**逐条相同**的判定与字段值；
//   2) 该表与 tools/seedparse.cpp 的期望值一致（防止两边一起写错）。
//
// ★ 为什么需要这道闸门（2026-10-22 安全审计 P11/P12）：
//   桌面端原来用「手写扫描器」找字段，网页端用 JSON.parse。同一段明文两端
//   给出的答案并不总是相同 —— "cols": 9.5 桌面端回退默认 9（合法 9×9 局）、
//   网页端变成 NaN（空棋盘）；"manualSplit": "true" 两端分型不同（不同棋盘）；
//   重复键两端取先/取后不同。于是**同一个种子串在两端解出不同的棋盘**，
//   而「同一种子处处同一局」正是排行榜回放校验的地基。
//
// 退出码：0 = 一致；4 = 不一致；3 = dist 过期（先跑 tsc）。
//
// 零第三方依赖（只用 Node 内置模块 + 动态 import）。
//
// ★ 用例表里的 JSON 文本**由程序拼出来**，不手写字符串字面量 —— 手写数组时
//   漏一个 ']' 极容易（tools/seedparse.cpp 第一版就踩过：case 3 的 opened
//   数组少了 ']'，两端一起 REJECT，用例白写）。现在用 nineRows() 拼。

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** 拼一个 9×9 的存档行数组（每行 9 个 '.'）。 */
function nineRows(key) {
    return `"${key}":[${Array(9).fill('"........."').join(',')}]`;
}

/** 拼一个普通 new 种子的明文。 */
function buildNew(cols, rows, mines, extra = '') {
    return '{"magic":"MSD1","version":1,"kind":"new",' +
        `"cols":${cols},"rows":${rows},"mines":${mines},` +
        '"manualSplit":false,"realMines":-1,"imagMines":-1,"rngSeed":42,' +
        '"firstRow":0,"firstCol":0,"ustcMode":false,"createdAt":"2026-10-22 00:00:00 UTC"' +
        (extra ? ',' + extra : '') + '}';
}

// 与 tools/seedparse.cpp 的 buildCases() **行序必须一致**。
const CASES = [
    [1, buildNew(9, 9, 10),
        1, 'kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=42 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [2, '{"magic":"MSD1","kind":"new","cols":16,"rows":16,"mines":40,' +
        '"manualSplit":true,"realMines":30,"imagMines":10,"rngSeed":7,' +
        '"firstRow":3,"firstCol":5,"ustcMode":true,"createdAt":"x"}',
        1, 'kind=new cols=16 rows=16 mines=40 manualSplit=1 realMines=30 imagMines=10 ' +
           'rngSeed=7 firstRow=3 firstCol=5 ustcMode=1 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [3, '{"magic":"MSD1","kind":"save","cols":9,"rows":9,"mines":10,' +
        '"manualSplit":false,"realMines":-1,"imagMines":-1,"rngSeed":1,' +
        '"firstRow":0,"firstCol":0,"elapsedCs":1234,"phase":"playing",' +
        nineRows('opened') + ',' + nineRows('flags') +
        ',"ustcMode":false,"createdAt":"y"}',
        1, 'kind=save cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=1 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=1234 phase=playing ' +
           'opened=9:.........,.........,.........,.........,.........,' +
           '.........,.........,.........,......... ' +
           'flags=9:.........,.........,.........,.........,.........,' +
           '.........,.........,.........,.........'],
    [4, '{"magic":"MSD1","kind":"new","firstRow":0,"firstCol":0}', 1,
        'kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
        'rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
        'opened=0: flags=0:'],
    // ★ 修复前的分歧点（注释与 tools/seedparse.cpp 一致）
    [5, '{"magic":"MSD1","kind":"new","cols":9.5,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [6, '{"magic":"MSD1","kind":"new","cols":true,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    // 1e2：修复前桌面端→默认 9、网页端→100（两端不一致）。现在两端都是 100 → 一致接受。
    [7, '{"magic":"MSD1","kind":"new","cols":1e2,"rows":9,"mines":10,"firstRow":0,"firstCol":0}',
        1, 'kind=new cols=100 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [8, '{"magic":"MSD1","kind":"new","cols":"9","rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [9, '{"magic":"MSD1","kind":"new","cols":null,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    // 重复键：修复前桌面端取先（9）、网页端取后（30）→ 不同棋盘。现在两端都取后（30）。
    [10, '{"magic":"MSD1","kind":"new","cols":9,"cols":30,"rows":9,"mines":10,"firstRow":0,"firstCol":0}',
        1, 'kind=new cols=30 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [11, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,}', 0, ''],
    [12, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0} trailing garbage', 0, ''],
    [13, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"manualSplit":"true","firstRow":0,"firstCol":0}', 0, ''],
    [14, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,"extra":{"a":[1,2,{"b":3}]}}', 0, ''],
    [15, '{"magic":"MSD1","kind":"new","cols":1e400,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [16, '{"magic":"MSD2","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [17, '{"magic":"MSD1","kind":"new2","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [18, '[1,2,3]', 0, ''],
    [19, '{"magic":)', 0, ''],
    [20, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,"createdAt":"中文"}', 0, ''],
    [21, '{"magic":"MSD1","kind":"new","cols":4,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [22, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"firstRow":99,"firstCol":0}', 0, ''],
    [23, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"rngSeed":4294967296,"firstRow":0,"firstCol":0}', 0, ''],
    [24, '{"magic":"MSD1","kind":"save","cols":9,"rows":9,"mines":10,' +
        '"firstRow":0,"firstCol":0,"elapsedSec":42,"phase":"playing",' +
        nineRows('opened') + ',' + nineRows('flags') + '}',
        1, 'kind=save cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=0 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=4200 phase=playing ' +
           'opened=9:.........,.........,.........,.........,.........,' +
           '.........,.........,.........,......... ' +
           'flags=9:.........,.........,.........,.........,.........,' +
           '.........,.........,.........,.........'],
    [25, '{"magic":"MSD1","kind":"save","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,"phase":"playing","opened":["....."],"flags":["....."]}', 0, ''],
    [26, '{"magic":"MSD1","kind":"save","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,"phase":"weird"}', 0, ''],
    [27, '{"magic":"MSD1","kind":"save","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0,"phase":"playing","opened":[123456789],"flags":["........."]}', 0, ''],
    [28, '{}', 0, ''],
    [29, '{"magic":"MSD1","kind":"new","cols":-9,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    [30, '{"kind":"new","cols":9,"rows":9,"mines":10,"firstRow":0,"firstCol":0}', 0, ''],
    // manualSplit 与 mines 自相矛盾（real+imag=0 < mines=2）：否则会造出 0 雷棋盘导入即胜
    [31, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":2,' +
         '"manualSplit":true,"realMines":0,"imagMines":0,' +
         '"rngSeed":0,"firstRow":0,"firstCol":0}', 0, ''],
    // ★ rngSeed ≥ 2^31：修复前桌面端把值落地成 int，clang 饱和到 2147483647
    //   （不是回绕）→ 两端开出不同的盘，约一半的盘受影响。钉住边界/中间值/上界。
    [32, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"rngSeed":2147483648,"firstRow":0,"firstCol":0}',
        1, 'kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=2147483648 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [33, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"rngSeed":3556999816,"firstRow":0,"firstCol":0}',
        1, 'kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=3556999816 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
    [34, '{"magic":"MSD1","kind":"new","cols":9,"rows":9,"mines":10,"rngSeed":4294967295,"firstRow":0,"firstCol":0}',
        1, 'kind=new cols=9 rows=9 mines=10 manualSplit=0 realMines=-1 imagMines=-1 ' +
           'rngSeed=4294967295 firstRow=0 firstCol=0 ustcMode=0 elapsedCs=0 phase=playing ' +
           'opened=0: flags=0:'],
];

const cwd = process.cwd();
const distFile = resolve(cwd, 'web/dist/seedcodec.js');
const srcFile = resolve(cwd, 'web/ts/seedcodec.ts');

if (!existsSync(distFile)) {
    console.error(`dist 不存在：${distFile}\n先跑：cd web && ./node_modules/.bin/tsc`);
    process.exit(3);
}
if (statSync(distFile).mtimeMs < statSync(srcFile).mtimeMs) {
    console.error('dist 比源码旧 —— 先跑 tsc（否则测的是旧实现）');
    process.exit(3);
}

const mod = await import(`file://${distFile}`);
// seedFromJson 导出是为了对拍（桌面端要对同一张用例表给出逐字节相同的判定）。
if (typeof mod.seedFromJson !== 'function') {
    console.error('dist/seedcodec.js 里没有导出 seedFromJson —— tsc 没跑或导出被删了');
    process.exit(3);
}
const { seedFromJson } = mod;

/** 与 tools/seedparse.cpp 的 summarize() 逐字节相同的摘要。 */
function summarize(s) {
    const arr = (v) => `${v.length}:${v.join(',')}`;
    return [
        `kind=${s.kind}`,
        `cols=${s.cols}`,
        `rows=${s.rows}`,
        `mines=${s.mines}`,
        `manualSplit=${s.manualSplit ? 1 : 0}`,
        `realMines=${s.realMines}`,
        `imagMines=${s.imagMines}`,
        `rngSeed=${s.rngSeed}`,
        `firstRow=${s.firstRow}`,
        `firstCol=${s.firstCol}`,
        `ustcMode=${s.ustcMode ? 1 : 0}`,
        `elapsedCs=${s.elapsedCs}`,
        `phase=${s.phase}`,
        `opened=${arr(s.openedRows)}`,
        `flags=${arr(s.flagRows)}`
    ].join(' ');
}

let bad = 0;
const tsOut = [];
for (const [id, json, want, wantFields] of CASES) {
    const s = seedFromJson(json);
    const ok = s !== null;
    const fields = ok ? summarize(s) : '';
    // 拒绝时**不要**输出尾随空格（C++ 侧那边是 `${id} REJECT`），逐字节比对要求完全一样。
    tsOut.push(ok ? `${id} ACCEPT ${fields}` : `${id} REJECT`);
    if ((ok ? 1 : 0) !== want) {
        bad++;
        console.error(`  ✗ case ${id}: 期望 ${want ? 'ACCEPT' : 'REJECT'}，TS 实际 ${ok ? 'ACCEPT' : 'REJECT'}`);
        console.error(`      明文：${json}`);
    } else if (ok && fields !== wantFields) {
        bad++;
        console.error(`  ✗ case ${id}: 字段不符\n      期望 ${wantFields}\n      实际 ${fields}`);
    }
}

// 再用 C++ 侧跑一遍（有编译好的二进制才比）
const cppBin = ['build/seedparse', 'cmake-build-debug/seedparse', '/tmp/seedparse'].find((p) =>
    existsSync(resolve(cwd, p)),
);
if (!cppBin) {
    console.log('（未找到 C++ 侧 seedparse 二进制，只校验了 TS 与期望值）');
    console.log(`TS-only: ${CASES.length - bad}/${CASES.length} 符合期望`);
    process.exit(bad === 0 ? 0 : 4);
}

let cppOut;
try {
    cppOut = execFileSync(resolve(cwd, cppBin), [], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((s) => s.trim().replace(/\s+$/, ''));
} catch (e) {
    console.error(`跑 ${cppBin} 失败：${e.message}`);
    process.exit(3);
}

if (cppOut.length !== tsOut.length) {
    console.error(`  ✗ 两端输出条数不同：cpp=${cppOut.length} ts=${tsOut.length}`);
    process.exit(4);
}
for (let i = 0; i < cppOut.length; i++) {
    if (cppOut[i] !== tsOut[i]) {
        bad++;
        console.error(`  ✗ case ${i + 1} 两端不一致：\n      cpp=${cppOut[i]}\n      ts =${tsOut[i]}`);
    }
}

if (bad === 0) {
    console.log(`${CASES.length}/${CASES.length} cases match（C++ ↔ TS ↔ 期望值）`);
}
process.exit(bad === 0 ? 0 : 4);
