// seed-ws-parity.mjs —— JSON 空白判据的三端一致性闸门
//
// 比对两件事：
//   1) C++（src/core/Seed.h 的 jsonWs）与 TS（web/ts/seedcodec.ts 的 isJsonWs）
//      对同一张用例表给出**逐条相同**的判定；
//   2) 该表与 tools/seedws.cpp 的期望值一致（防止两边一起写错）。
//
// 退出码：0 = 一致；4 = 不一致；3 = dist 过期（先跑 tsc）。
//
// 零第三方依赖（Node 22 自带 fetch/WebSocket，这里只用子进程 + 动态 import）。

import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// 与 tools/seedws.cpp 的 kCases **行序必须一致**。
const CASES = [
    [1, '{"magic": "MSD1"}', 1],
    [2, '{"magic":"MSD1"}', 1],
    [3, '{"magic"  :   "MSD1"}', 1],
    [4, '{"magic":\t"MSD1"}', 1],
    [5, '{"magic":\n"MSD1"}', 1],          // ★ 修复前是 0
    [6, '{"magic":\r\n  "MSD1"}', 1],      // ★ 修复前是 0
    [7, '{"magic":\f"MSD1"}', 0],          // \f 不是 JSON 空白，三端一致拒绝
    [8, '{"magic":\v"MSD1"}', 0],          // \v 同理
    [9, '{"magic": "MSD2"}', 0],
    [10, '{"xmagic": "MSD1"}', 0],
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
const { jsonFieldEquals } = mod;
if (typeof jsonFieldEquals !== 'function') {
    console.error('dist/seedcodec.js 里没有导出 jsonFieldEquals —— tsc 没跑或导出被删了');
    process.exit(3);
}

let bad = 0;
const tsOut = [];
for (const [id, json, want] of CASES) {
    const got = jsonFieldEquals(json, 'magic', 'MSD1') ? 1 : 0;
    tsOut.push(`${id} ${got}`);
    if (got !== want) {
        bad++;
        console.error(`  ✗ case ${id}: 期望 ${want}，TS 实际 ${got}`);
    }
}

// 再用 C++ 侧跑一遍（有编译好的二进制才比）
const cppBin = ['build/seedws', 'cmake-build-debug/seedws', '/tmp/seedws'].find((p) =>
    existsSync(resolve(cwd, p)),
);
if (!cppBin) {
    console.log('（未找到 C++ 侧 seedws 二进制，只校验了 TS 与期望值）');
    console.log(`TS-only: ${CASES.length - bad}/${CASES.length} 符合期望`);
    process.exit(bad === 0 ? 0 : 4);
}

let cppOut;
try {
    cppOut = execFileSync(resolve(cwd, cppBin), [], { encoding: 'utf8' })
        .trim()
        .split('\n')
        .map((s) => s.trim());
} catch (e) {
    console.error(`跑 ${cppBin} 失败：${e.message}`);
    process.exit(3);
}

if (cppOut.join('\n') !== tsOut.join('\n')) {
    console.error('  ✗ C++ 与 TS 判定不一致：');
    for (let i = 0; i < Math.max(cppOut.length, tsOut.length); i++) {
        if (cppOut[i] !== tsOut[i]) console.error(`      cpp=${cppOut[i]}  ts=${tsOut[i]}`);
    }
    process.exit(4);
}

if (bad === 0) {
    console.log(`${CASES.length}/${CASES.length} cases match（C++ ↔ TS ↔ 期望值）`);
}
process.exit(bad === 0 ? 0 : 4);
