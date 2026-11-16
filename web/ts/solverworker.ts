 // SPDX-License-Identifier: AGPL-3.0-only
// 精确概率求解 Worker：WASM solver 跑在独立线程，长盘求解（可达数十秒）不卡渲染与输入。
// classic worker（无 ES import/export，tsc 对无导入文件产出全局脚本）：里面 importScripts
// emscripten 的 MODULARIZE 胶水。协议见 game.ts 的 ProbResultMsg / probRequest。

declare function importScripts(...urls: string[]): void;

const ctx: any = self as any;

interface ProbRequest {
    seq: number;
    cols: number;
    rows: number;
    mines: number;
    rLeft: number;  // 求解池轴剩余（玩家口径：配置−按型旗数，B 裁决 2026-11-12）
    iLeft: number;  // 同上，虚轴
    v: string;      // 构建版本：胶水/wasm 与 worker 同代，击穿旧缓存
    mag: boolean;   // 「总是显示模长」开着 → 约束退到 |z| 圆口径（a 档 2026-11-12）
    grid: Int16Array; // stride 5，见 web/src/solver_api.cpp
}

let modPromise: Promise<any> | null = null;

// MODULARIZE 工厂返回的是 **Promise**（wasm 异步编译），不能同步当实例用——
// 立刻取 _malloc 是 undefined（实测：note「mod._malloc is not a function」）。
async function getMod(v: string): Promise<any> {
    if (!modPromise) {
        const q = v ? '?v=' + encodeURIComponent(v) : '';
        importScripts('solver.js' + q);
        modPromise = (self as any).SolverModule({
            locateFile: (p: string) => p.endsWith('.wasm') ? 'solver.wasm' + q : p
        });
    }
    return modPromise;
}

ctx.onmessage = async (ev: MessageEvent) => {
    const req = ev.data as ProbRequest;
    try {
        const mod = await getMod(req.v);
        const n = req.cols * req.rows;
        const gPtr = mod._malloc(n * 2 * 5);
        const pPtr = mod._malloc(n * 4);
        const uPtr = mod._malloc(n);
        const tPtr = mod._malloc(n);
        try {
            new Int16Array(mod.HEAPU16.buffer, gPtr, n * 5).set(req.grid);
            const t0 = performance.now();
            const rc: number = mod.ccall('msProbExact', 'number',
                ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number', 'number'],
                [req.cols, req.rows, req.mines, req.rLeft, req.iLeft, gPtr, pPtr, uPtr, tPtr, req.mag ? 1 : 0]);
            const secs = (performance.now() - t0) / 1000;
            // ccalls 之后才取视图：内存若在求解中增长，旧视图会失效
            const prob = new Float32Array(mod.HEAPF32.buffer, pPtr, n).slice();
            const unknown = new Uint8Array(mod.HEAPU8.buffer, uPtr, n).slice();
            const type = new Uint8Array(mod.HEAPU8.buffer, tPtr, n).slice();
            ctx.postMessage(
                { ok: true, seq: req.seq, rc, secs, prob, unknown, type },
                [prob.buffer, unknown.buffer, type.buffer]);
        } finally {
            mod._free(gPtr);
            mod._free(pPtr);
            mod._free(uPtr);
            mod._free(tPtr);
        }
    } catch (e: any) {
        // 失败必须吭声：主线程据此给「求解不可用」而不是假装算完
        ctx.postMessage({ ok: false, seq: req.seq, err: String(e && e.message || e) });
    }
};
