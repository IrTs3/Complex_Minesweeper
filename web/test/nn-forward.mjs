// web/test/nn-forward.mjs — NN 三端一致性的 TS 一方（T85/T88）。
//
// 对 tools/nn/golden/golden.jsonl 两道账：
//   1. forward case：TS 前向 ≤1e-5（与 C++ nnforward_test 同一容差，FMA 舍入差已计入）；
//   2. encode case：TS 显示模型编码器对 C++ 权威编码器（buildDumpPlane）≤1e-6。
//
// 用法：cd web && ./node_modules/.bin/tsc && node test/nn-forward.mjs
// 退出码：0=全过；2=金标/权重缺失或形状不对；4=对不上（打印第一个偏差）。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCnnw, nnForward, encodePlane } from '../dist/nn.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// —— 产物新鲜度：dist 必须比 ts 新（踩过：忘编译，测的全是旧产物）——
{
    const tsDir = join(here, '..', 'ts'), distDir = join(here, '..', 'dist');
    const newestTs = Math.max(...readdirSync(tsDir).filter(f => f.endsWith('.ts'))
        .map(f => statSync(join(tsDir, f)).mtimeMs));
    const oldestDist = Math.min(...readdirSync(distDir).filter(f => f.endsWith('.js'))
        .map(f => statSync(join(distDir, f)).mtimeMs));
    if (oldestDist < newestTs) {
        console.error('nn-forward: dist 产物比 ts 源码旧（跑的是旧代码）——先 cd web && ./node_modules/.bin/tsc');
        process.exit(3);
    }
}

let net;
try {
    net = loadCnnw(readFileSync(join(root, 'assets', 'nn', 'student.cnnw')).buffer
        .slice(0, readFileSync(join(root, 'assets', 'nn', 'student.cnnw')).byteLength));
} catch (e) {
    console.error('nn-forward: 权重加载失败：' + e.message);
    process.exit(2);
}

const golden = readFileSync(join(root, 'tools', 'nn', 'golden', 'golden.jsonl'), 'utf-8')
    .split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
const fw = golden.filter(o => o.kind === 'forward');
const enc = golden.filter(o => o.kind === 'encode');
if (fw.length === 0 || enc.length === 0) {
    console.error('nn-forward: 金标缺 forward 或 encode case（先跑 export_weights.py）');
    process.exit(2);
}

let bad = 0;
let maxAll = 0;

// ── 1. forward case ≤1e-5 ──
for (let k = 0; k < fw.length; ++k) {
    const o = fw[k];
    const raw = Buffer.from(o.inB64, 'base64');
    const input = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    const out = new Float32Array(net.inH * net.inW);
    nnForward(net, input, out);
    let maxErr = 0;
    for (let i = 0; i < out.length; ++i) maxErr = Math.max(maxErr, Math.abs(out[i] - o.out[i]));
    maxAll = Math.max(maxAll, maxErr);
    if (maxErr > 1e-5) { console.error(`nn-forward: forward case ${k} 最大偏差 ${maxErr.toExponential(3)} > 1e-5`); ++bad; }
}

// ── 2. encode case ≤1e-6 ──
for (const o of enc) {
    const board = {
        cols: () => o.cols, rows: () => o.rows, mineCount: () => o.mines,
        counts: () => ({ openedSafe: 0, flagged: 0 }),
        at(r, c) {
            const [op, re, im, flag, ma] = o.cells[r * o.cols + c];
            return { opened: !!op, flag, adjReal: re, adjImag: im, adjTotal: ma };
        },
    };
    const plane = encodePlane(board);
    let maxErr = 0;
    for (let i = 0; i < plane.length; ++i) maxErr = Math.max(maxErr, Math.abs(plane[i] - o.plane[i]));
    maxAll = Math.max(maxAll, maxErr);
    if (maxErr > 1e-6) { console.error(`nn-forward: encode case ${o.name} 最大偏差 ${maxErr.toExponential(3)} > 1e-6`); ++bad; }
}

if (bad) { console.error(`nn-forward: ${bad} 组超差（最大偏差 ${maxAll.toExponential(3)}）`); process.exit(4); }
console.log(`nn-forward: forward ${fw.length} + encode ${enc.length} 全过（TS 最大偏差 ${maxAll.toExponential(2)}）`);
