// SPDX-License-Identifier: AGPL-3.0-only
// nn.ts — 学生网络（.cnnw）加载、f32 前向与显示模型编码（纯 TS，零依赖）。
//
// 契约唯一出处 tools/nn/dump_format.md；与 C++ 权威实现（src/solver/NNForward.h 的
// nnf::forward、SolverEngine::buildDumpPlane）逐字对齐，一致性由 web/test/nn-forward.mjs
// 对 tools/nn/golden/golden.jsonl 钉住（测试 T85/T88）。跨端容差 1e-5：C++ 可能吃 FMA
// 自动融合（单次舍入），这里 Math.fround 逐运算模拟 f32（每次运算都舍入），别放窄。
//
// 编码是「显示模型」口径：通道值严格等于玩家默认显示模式下能看到的东西——
// 混合格只见模长（相位泄漏 = 拿到连老师都没有的上帝视角），minesAround 不设通道。

export interface NnLayer {
    op: number;   // 0=conv 1=残差加
    outC: number; kH: number; kW: number; pad: number; act: number;
    w: Float32Array;
    b: Float32Array;
}

export interface NnNet {
    inC: number; inH: number; inW: number;
    layers: NnLayer[];
}

// ── 紧凑 sha256（与 NNForward.h / python hashlib 同口径；仅用于权重尾部自校验）──
export function sha256Bytes(data: Uint8Array): Uint8Array {
    const K = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const bitLen = data.length * 8;
    const msg = new Uint8Array((((data.length + 9) >> 6) + 1) << 6);
    msg.set(data);
    msg[data.length] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(msg.length - 4, bitLen >>> 0);
    dv.setUint32(msg.length - 8, Math.floor(bitLen / 4294967296));
    const rr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
    const h = H0.slice();
    const w = new Array<number>(64);
    for (let off = 0; off < msg.length; off += 64) {
        for (let i = 0; i < 16; ++i) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; ++i) {
            const s0 = rr(w[i - 15], 7) ^ rr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rr(w[i - 2], 17) ^ rr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (let i = 0; i < 64; ++i) {
            const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
            const mj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + mj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; ++i) odv.setUint32(i * 4, h[i] >>> 0);
    return out;
}

const fr = Math.fround;

function rdU16(p: Uint8Array, off: number): number { return p[off] | (p[off + 1] << 8); }
function rdU32(p: Uint8Array, off: number): number {
    return (p[off] | (p[off + 1] << 8) | (p[off + 2] << 16) | (p[off + 3] << 24)) >>> 0;
}

// 解析并校验 .cnnw（ArrayBuffer）。任何一步不对都 throw 人话原因——调用方负责降级，
// 这里绝不静默吞（损坏的权重宁可功能关，也不能出错的概率图）。
export function loadCnnw(buf: ArrayBuffer): NnNet {
    const p = new Uint8Array(buf);
    const bad = (why: string): never => { throw new Error('cnnw: ' + why); };
    if (p.length < 13 + 2 + 32) bad('权重文件太小（疑似截断）');
    if (String.fromCharCode(...p.slice(0, 5)) !== 'CMSNW') bad('魔数不对（不是 CMSNW）');
    const ver = rdU32(p, 5);
    if (ver !== 1 && ver !== 2) bad('版本不支持');
    if (rdU32(p, 9) !== 0x1A5A5A1A) bad('哨兵字节不对');
    const body = p.length - 32;
    const dig = sha256Bytes(p.slice(0, body));
    for (let i = 0; i < 32; ++i) if (dig[i] !== p[body + i]) bad('尾部 sha256 不匹配（文件损坏/被改）');
    let off = 13;
    const inC = rdU16(p, off), inH = rdU16(p, off + 2), inW = rdU16(p, off + 4);
    const nLayers = rdU16(p, off + 6);
    off += 8;
    const layers: NnLayer[] = [];
    let curC = inC;
    for (let i = 0; i < nLayers; ++i) {
        if (off + 7 > body) bad('层记录越界');
        const op = p[off], outC = rdU16(p, off + 1);
        const kH = p[off + 3], kW = p[off + 4], pad = p[off + 5], act = p[off + 6];
        off += 7;
        if (op === 1) { layers.push({ op, outC, kH, kW, pad, act, w: new Float32Array(0), b: new Float32Array(0) }); continue; }
        const n = outC * curC * kH * kW;
        const w = new Float32Array(n);
        if (ver === 2) {
            // v2：f32 scale[outC] + i8 权重，加载时反量化回 f32（w=scale×q，fround 逐乘舍入）
            if (off + outC * 4 + n + outC * 4 > body) bad('权重数据越界');
            const scale = new Float32Array(outC);
            for (let j = 0; j < outC; ++j) scale[j] = new DataView(buf, off + j * 4, 4).getFloat32(0, true);
            off += outC * 4;
            const perCh = curC * kH * kW;
            for (let j = 0; j < n; ++j) {
                const q = (p[off + j] << 24) >> 24;   // 符号扩展 i8
                w[j] = fr(scale[(j / perCh) | 0] * q);
            }
            off += n;
        } else {
            if (off + n * 4 + outC * 4 > body) bad('权重数据越界');
            for (let j = 0; j < n; ++j) w[j] = fr(new DataView(buf, off + j * 4, 4).getFloat32(0, true));
            off += n * 4;
        }
        const b = new Float32Array(outC);
        for (let j = 0; j < outC; ++j) b[j] = fr(new DataView(buf, off + j * 4, 4).getFloat32(0, true));
        off += outC * 4;
        layers.push({ op, outC, kH, kW, pad, act, w, b });
        curC = outC;
    }
    return { inC, inH, inW, layers };
}

function applyAct(v: number, act: number): number {
    if (act === 1) return v > 0 ? v : 0;
    if (act === 2) return fr(1 / (1 + Math.exp(-v)));
    return v;
}

// 前向。in: inC×inH×inW（通道主序）；out: inH×inW。累加顺序契约：逐输出点、kH→kW→inC
// 固定次序（与 NNForward.h 逐字一致）。
// ⚠ 必须喂全画布：盘面外区域第一层输出 = act(bias) 非零，会从第二层起渗回盘面边缘——
// 「按盘面尺寸裁小画布」与固定 16×30 的结果不等价（实测差 1e-1 量级），别自作聪明省算。
export function nnForward(net: NnNet, input: Float32Array, out: Float32Array): void {
    const H = net.inH, W = net.inW;
    const outs: Float32Array[] = [];
    let cur = input, curC = net.inC;
    for (let n = 0; n < net.layers.length; ++n) {
        const L = net.layers[n];
        if (L.op === 1) {
            // 残差加：out = conv2输出(outs[-1]) + 块入口(outs[-3])；outs[-2] 是块内 conv1，不是入口
            const o = new Float32Array(curC * H * W);
            const prev = outs[outs.length - 1];
            const base = outs.length >= 3 ? outs[outs.length - 3] : null;
            for (let j = 0; j < o.length; ++j) o[j] = applyAct(base ? fr(prev[j] + base[j]) : prev[j], L.act);
            outs.push(o);
            cur = o;
            continue;
        }
        const o = new Float32Array(L.outC * H * W);
        const kH = L.kH, kW = L.kW, pad = L.pad;
        for (let oc = 0; oc < L.outC; ++oc) {
            const wbase = oc * curC * kH * kW;
            const bias = L.b[oc];
            for (let r = 0; r < H; ++r) {
                for (let c = 0; c < W; ++c) {
                    let acc = bias;
                    for (let kr = 0; kr < kH; ++kr) {
                        const sr = r + kr - pad;
                        if (sr < 0 || sr >= H) continue;
                        for (let kc = 0; kc < kW; ++kc) {
                            const sc = c + kc - pad;
                            if (sc < 0 || sc >= W) continue;
                            const ip = (sr * W + sc);
                            const wp = wbase + kr * kW * curC + kc * curC;
                            for (let ic = 0; ic < curC; ++ic)
                                acc = fr(acc + fr(L.w[wp + ic] * cur[ip + ic * H * W]));
                        }
                    }
                    o[oc * H * W + r * W + c] = applyAct(acc, L.act);
                }
            }
        }
        outs.push(o);
        cur = o;
        curC = L.outC;
    }
    for (let j = 0; j < H * W; ++j) out[j] = cur[j];
}

// ── 显示模型编码器（SolverEngine::buildDumpPlane 的 TS 镜像）──────────────────
// 编码只读玩家可见信息：opened / flag / 提示和（adjReal/adjImag）/ minesAround（仅用于
// 「0 提示→邻居全安全」判定，不设通道）。绝不读 mine。
export interface NnBoardCell {
    opened: boolean; flag: number;
    adjReal: number; adjImag: number; adjTotal: number;
}
export interface NnBoard {
    cols(): number; rows(): number; mineCount(): number;
    counts(): { openedSafe: number; flagged: number };
    at(r: number, c: number): NnBoardCell;
}

// 输出 10×16×30 通道主序平面（固定画布，训练口径；小盘零填充在左上角）。
export function encodePlane(board: NnBoard): Float32Array {
    const H = 16, W = 30;
    const cols = board.cols(), rows = board.rows();
    if (cols > W || rows > H) throw new Error('cnnw: 盘面超出画布 ' + H + '×' + W);
    const plane = new Float32Array(10 * H * W);
    const ch = (ci: number, r: number, c: number, v: number) => { plane[(ci * H + r) * W + c] = v; };
    let unopened = 0, flagged = 0;
    for (let r = 0; r < rows; ++r)
        for (let c = 0; c < cols; ++c) {
            const y = board.at(r, c);
            if (!y.opened) ++unopened;
            if (y.flag !== 0) ++flagged;
        }
    const remMines = board.mineCount() - flagged;
    const c7 = fr(remMines / board.mineCount());
    const c8 = fr((cols * rows - unopened) / (cols * rows));
    const c9 = Math.min(1, fr(remMines / (unopened > 0 ? unopened : 1)));
    // 前沿/blankSafe 单遍行主序（与 C++ analyze 同序：先扫到的 0 提示格把邻居划出前沿）
    const blankSafe = new Uint8Array(cols * rows);
    const isFront = new Uint8Array(cols * rows);
    for (let r = 0; r < rows; ++r)
        for (let c = 0; c < cols; ++c) {
            const y = board.at(r, c);
            if (!y.opened) continue;
            if (y.adjTotal === 0) {   // 0 提示：邻居全安全，绝不进前沿（对消和为零 ≠ 邻居无雷）
                for (let dr = -1; dr <= 1; ++dr)
                    for (let dc = -1; dc <= 1; ++dc) {
                        if (dr === 0 && dc === 0) continue;
                        const rr = r + dr, cc = c + dc;
                        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
                        const nb = board.at(rr, cc);
                        if (!nb.opened && nb.flag === 0) blankSafe[rr * cols + cc] = 1;
                    }
                continue;
            }
            for (let dr = -1; dr <= 1; ++dr)
                for (let dc = -1; dc <= 1; ++dc) {
                    if (dr === 0 && dc === 0) continue;
                    const rr = r + dr, cc = c + dc;
                    if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) continue;
                    const nb = board.at(rr, cc);
                    if (!nb.opened && nb.flag === 0 && !blankSafe[rr * cols + cc]) isFront[rr * cols + cc] = 1;
                }
        }
    for (let r = 0; r < rows; ++r)
        for (let c = 0; c < cols; ++c) {
            const y = board.at(r, c);
            if (y.opened) {
                ch(0, r, c, 1);
                if (y.adjImag === 0) ch(1, r, c, Math.max(-2, Math.min(2, fr(y.adjReal / 4))));
                else if (y.adjReal === 0) ch(2, r, c, Math.max(-2, Math.min(2, fr(y.adjImag / 4))));
                else ch(3, r, c, Math.min(2, fr(Math.sqrt(y.adjReal * y.adjReal + y.adjImag * y.adjImag) / 4)));
            } else {
                ch(4, r, c, 1);
                if (isFront[r * cols + c]) ch(5, r, c, 1);
            }
            // c6 标记型 v1 占位恒 0
        }
    for (let r = 0; r < rows; ++r)
        for (let c = 0; c < cols; ++c) {
            ch(7, r, c, c7);
            ch(8, r, c, c8);
            ch(9, r, c, c9);
        }
    return plane;
}

// ── 游戏端封装：惰性拉权重 + 按盘面状态缓存前向 ─────────────────────────────
export class NnEngine {
    private net: NnNet | null = null;
    private loadTried = false;
    private cacheKey = '';
    private cache: Float32Array | null = null;

    // 失败静默降级=功能关（计划口径）：404/坏档都只是没有热力图，hover 行为与从前逐字节一致
    ensureLoaded(): void {
        if (this.loadTried) return;
        this.loadTried = true;
        fetch('/dist/nn.cnnw')
            .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.arrayBuffer(); })
            .then(b => { this.net = loadCnnw(b); })
            .catch(() => { this.net = null; });   // 功能关，不吭声不重试
    }

    // 盘面状态没变就吃缓存（前向 ~百毫秒级，绝不能挂在 mousemove 上）；
    // 未加载/超画布返回 null。
    probsFor(view: NnBoard): Float32Array | null {
        if (!this.net) return null;
        const cols = view.cols(), rows = view.rows();
        if (cols > 30 || rows > 16) return null;
        const cnt = view.counts();
        const key = cols + 'x' + rows + '#' + cnt.openedSafe + '|' + cnt.flagged;
        if (key !== this.cacheKey) {
            const plane = encodePlane(view);          // 全画布 16×30（训练口径，盘面外有 bias 特征）
            const out = new Float32Array(16 * 30);
            nnForward(this.net, plane, out);
            const probs = new Float32Array(rows * cols);
            for (let r = 0; r < rows; ++r)
                for (let c = 0; c < cols; ++c) probs[r * cols + c] = out[r * 30 + c];
            this.cache = probs;
            this.cacheKey = key;
        }
        return this.cache;
    }
}
