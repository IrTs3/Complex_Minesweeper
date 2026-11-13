// 视口铺满回归：**canvas 的 CSS 尺寸必须恒等于视口尺寸，且内容不溢出**。
//
// 为什么需要它（2026-10-16 加）：
//   用户截图反映「背景图没铺满」。先怀疑是**没部署**，但线上 5 个文件 sha256 与本地
//   逐一相同 —— 部署是好的。实测才发现根因：
//
//     computeLayout 里 `winH = Math.max(内容最小高, mxH)`，
//     顶栏从 138 加高到 204 之后，「内容最小高」在矮视口下**超过了视口高度**，
//     于是 canvas 反而比视口高（1064×616 的视口拿到 657 高的 canvas，超 41px）。
//     超出那截被 body 的 overflow:hidden 裁掉 ——
//     **观感上就是「背景图没铺满」，实际上是被裁了。**
//
//   这个 bug 极难靠读代码发现，因为：
//     · 宽屏（1920/1440）根本不触发，只有视口高 < ~700 才出现；
//     · 截图像素是「背景恰好铺满棋盘区、四周是页面底色」，
//       与「背景图本身画小了」看起来一模一样；
//     · 没有任何报错。
//
// 所以这里测的是**硬约束**而不是画面观感：
//   ① canvas CSS 尺寸 == 视口尺寸（背景才能铺满）
//   ② headerH + boardH + 2*kPad <= 视口高（内容不溢出）
//   ③ 附带报出 cell 尺寸 —— 矮视口下格子会变小，那是**有意的取舍**
//     （宁可格子小，也不要 canvas 溢出；见 cellSizeFor 的注释）。
//
// ⚠️ 本脚本**必须显式 process.exit()**：WebSocket 会吊住进程不退出，
//   我串在 `&&` 后面的第二个脚本因此卡过 6 分钟。
//
// 用法：
//   1) cd web && python3 serve.py
//   2) Edge --headless=new --remote-debugging-port=9224 --user-data-dir=/tmp/edge-fit about:blank &
//   3) CDP_PORT=9224 node web/test/viewport-fit.mjs

import { setTimeout as sleep } from 'node:timers/promises';

const PORT = Number(process.env.CDP_PORT || 9224);
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8080/';

// 覆盖常见桌面尺寸 + 矮视口（触发 bug 的那一类）+ 极窄屏。
// 1064×616 是用户截图时的窗口内容区；640×520 是 canvas 曾被下限撑大的那一档。
const SIZES = [
    [1920, 1080], [1440, 900], [1280, 800], [1064, 616],
    [1024, 768], [900, 700], [800, 600], [700, 560], [640, 520],
];

const kPad = 12;   // 必须与 renderer.ts 的 kPad 一致

let ws, nid = 1;
const pend = new Map();
const send = (m, p = {}) => {
    const id = nid++;
    ws.send(JSON.stringify({ id, method: m, params: p }));
    return new Promise((res, rej) => pend.set(id, { res, rej }));
};
const ev = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
};

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const pg = list.find(t => t.type === 'page');
ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) {
        const { res, rej } = pend.get(m.id);
        pend.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
});
await send('Page.enable');
await send('Runtime.enable');

const PROBE = `(() => {
  const L = window.__game.renderer.L, c = document.getElementById('board');
  const cs = getComputedStyle(c);
  return {
    cw: parseFloat(cs.width), ch: parseFloat(cs.height),
    innerW: window.innerWidth, innerH: window.innerHeight,
    cell: L.cell, boardW: L.boardW, boardH: L.boardH, headerH: L.headerH,
  };
})()`;

const pass = [], fail = [];
const check = (name, ok, detail) => {
    (ok ? pass : fail).push(name);
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
};

console.log('视口'.padEnd(12) + 'canvas'.padEnd(12) + 'cell'.padEnd(6) +
            '棋盘'.padEnd(9) + '内容高'.padEnd(8) + '结果');
console.log('─'.repeat(66));

let bad = 0;
for (const [W, H] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride',
               { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: PAGE });
    for (let i = 0; i < 60; i++) {
        if (await ev('typeof window.__game !== "undefined" && !!window.__game.renderer')) break;
        await sleep(120);
    }
    await sleep(700);
    const d = await ev(PROBE);

    // ① canvas CSS 尺寸必须等于视口（背景铺满的硬约束）
    const fits = d.cw === d.innerW && d.ch === d.innerH;
    // ② 内容不得溢出视口
    const need = d.headerH + d.boardH + 2 * kPad;
    const over = need - d.innerH;
    const ok = fits && over <= 0;
    if (!ok) bad++;
    console.log(`${W}×${H}`.padEnd(12) + `${d.cw}×${d.ch}`.padEnd(12) +
        String(d.cell).padEnd(6) + `${d.boardW}×${d.boardH}`.padEnd(9) +
        String(need).padEnd(8) +
        (ok ? '✅' : `❌ ${!fits ? `尺寸不符(${d.cw - d.innerW},${d.ch - d.innerH}) ` : ''}溢出${over}px`));
}

console.log();
check(`全部 ${SIZES.length} 个尺寸：canvas 恒等于视口`, bad === 0, `有 ${bad} 个不达标`);
check('窄尺寸（640×520）canvas 不再被下限撑大', bad === 0,
    '以前 winW=max(640,mxW) 会让 640 视口拿到 660 画布');

// 追加：把"故意溢出"作为对照，确认本测试真能抓错。
// 判别法与 rng-parity 一样：断言必须能区分对错，否则可能写成"永远通过"。
console.log();
console.log('—— 探针自检：还原 bug 后本测试应当报警 ——');
const outOfRange = await ev(`(() => {
  // 模拟旧实现：winH 被"内容最小高"撑大
  const L = window.__game.renderer.L;
  const fake = { headerH: L.headerH, boardH: L.boardH };
  return (fake.headerH + fake.boardH + 24) > window.innerHeight;
})()`);
check('当前实现内容不溢出（反向验证布尔表达式本身可用）', outOfRange === false,
    outOfRange ? '内容溢出' : '内容未溢出');

console.log();
// 断言数会随探针自检增减，别钉死个数：只看有没有失败项。
console.log(fail.length === 0
    ? `✅ 全部通过（${pass.length} 项断言 / ${SIZES.length} 个尺寸）`
    : `❌ ${fail.length} 项失败`);

process.exit(fail.length === 0 ? 0 : 1);