// 顶栏窄屏重叠探针：把顶栏每个控件的矩形拉出来，找**互相重叠**的对。
//
// 为什么不能用「截图给我看看」：我能看到图，但判断"这两个控件是不是压在一起"
// 需要精确坐标，而且换个显示器/缩放比例结论就变。这里直接算矩形交叠，
// 数值是客观的，改完再跑一遍就知道有没有真解决。
//
// 同时打印每个控件的宽度预算，供决定折行策略。
//
// 用法：node web/test/header-overlap.mjs
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9223;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8080/';

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    return r.result.value;
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('找不到页面'); process.exit(1); }
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r));
ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
});
await send('Page.enable');
await send('Runtime.enable');

// 收集所有参与"顶栏占用"的控件名。键要与 renderer.ts 里的字段对应。
const PROBE = `(() => {
  const R = window.__game.renderer;
  const L = R.L;
  const u = R.ustcRects();
  const cv = R.ctx;
  const tw = (t, f) => R.constructor.textWidth ? R.constructor.textWidth(cv, t, f) : 0;
  return {
    winW: L.winW, winH: L.winH, sideX: L.sideX, headerH: L.headerH, headerTop: L.headerTop,
    hs: L.hs,   // 顶栏等比缩放：下面 put 要把设计坐标乘上去，否则窄屏全是假警报
    helpBtn: L.helpBtn, easyBtn: L.easyBtn, mediumBtn: L.mediumBtn,
    hardBtn: L.hardBtn, customBtn: L.customBtn, seedBtn: L.seedBtn,
    settingsBtn: L.settingsBtn, restartBtn: L.restartBtn,
    bgValue: L.bgValue, bgTrack: L.bgTrack,
    ustc: u,
    // 药丸/芯片/统计行/进度条都是**绘制时现算**的，Layout 里没存矩形。
    // 光测 Layout 里的矩形会漏掉它们——我第一版就是这么漏的，
    // 截图才看出「药丸压统计行」。所以这里按绘制代码的常量推出占位。
    // 绘制时现算的那些（药丸/芯片/统计行/进度条/OPACITY 标签/图例）。
    // ⚠️ **不要给这些编造宽度**。我第一版把 chips 写成固定 150px 宽的矩形，
    // 于是改完代码重测仍报 "custom × chips 2px" —— 那是探针在说谎，不是代码没改。
    // 宽度一律按 renderer.ts 的真实公式算。
    drawn: (() => {
      // 用**设计宽** L.hw 而不是 winW-2*sideX（那是缩放后的像素宽）：
      // 顶栏加了 hs 缩放后，两者差 hs 倍，「窄/宽」判断会和真实绘制分岔
      // （1024 宽下会按紧凑模型算、实际却是宽布局 —— 探针自己说谎）。
      const rx = (typeof L.hw === 'number' && L.hw > 0) ? L.hw : L.winW - 2 * L.sideX;
      const narrow = rx < 620;
      const barLimit = Math.min(rx - 16, u.magBox.x - 10);
      // 字宽一律现场量（与 renderer 同一个 ctx、同一字体串），不编造常数。
      cv.font = '11px "IBM Plex Serif", Georgia, "Times New Roman", serif';
      const olw = Math.ceil(cv.measureText('OPACITY').width);
      cv.font = '21px "IBM Plex Serif", Georgia, "Times New Roman", serif';
      const titleW = Math.ceil(cv.measureText('Complex Minesweeper').width);
      const chipRoom = Math.min(L.customBtn.x, L.seedBtn.x) - 10 - (18 + 226);
      // 与 renderer.ts 同规则：row2 放得下（≥62/颗）就收紧步长留下，否则换行
      let step = 84, chipY = 54, chipX = 18 + 226, wrapped = false;
      if (narrow) {
        const room = (L.bgValue.x - 8 - olw) - 18 - 6;
        step = Math.max(62, Math.min(84, Math.floor(room / 2)));
        chipY = 118; chipX = 18; wrapped = true;
      } else if (chipRoom >= 62 * 2) {
        step = Math.min(84, Math.floor(chipRoom / 2));
      } else {
        chipY = 94; chipX = 18; wrapped = true;
      }
      // 图例：窄顶栏排在 row3 的 CUSTOM 右边；换行时排在芯片右边；否则从 18 起。
      const chipsW = step * 2;
      const legendX = narrow ? L.customBtn.x + L.customBtn.w + 12
                    : (wrapped ? chipX + chipsW + 12 : 18);
      const legendLimit = rx - 18;
      return {
        // 窄顶栏不画大标题（矩形零宽，put 会跳过）
        title: narrow ? {x: 0, y: 0, w: 0, h: 0} : {x: 18, y: 10, w: titleW, h: 26},
        pillMines: {x: 18, y: 54, w: 116, h: 28},
        pillTime:  {x: 142, y: 54, w: 92, h: 28},
        chips:     {x: chipX, y: chipY, w: step * 2, h: 28},
        legend:    {x: legendX, y: 94, w: Math.max(0, legendLimit - legendX), h: 20},
        statRow:   {x: 18, y: 150, w: Math.max(0, barLimit - 18), h: 18},
        barRow:    {x: 18, y: 170, w: Math.max(0, barLimit - 18), h: 10},
        opacityLbl:{x: L.bgValue.x - 8 - olw, y: L.bgTrack.y - 3, w: olw, h: 14},
      };
    })(),
  };
})()`;

// 360 及更窄不在适配范围（用户 2026-10-16 定的目标 = 手机 390 档 + iPad）：
// 那种宽度下 row2 的药丸与 SEED 会挤在一起，功能不受影响但视觉拥挤，记入待办清单。
const SIZES = [[1440,900],[1024,768],[800,600],[640,520],[390,730]];

console.log('窗口尺寸'.padEnd(12) + '可用宽'.padEnd(9) + '重叠对数  最严重的一对');
console.log('─'.repeat(88));

let totalBad = 0;
const outOfView = [];
for (const [w, h] of SIZES) {
    await send('Emulation.setDeviceMetricsOverride', {
        width: w, height: h, deviceScaleFactor: 1, mobile: false,
    });
    await send('Page.navigate', { url: PAGE });
    // 等 __game 就绪
    for (let i = 0; i < 60; i++) {
        const ok = await evalJs('typeof window.__game !== "undefined" && !!window.__game.renderer');
        if (ok) break;
        await sleep(150);
    }
    await sleep(500);
    const d = await evalJs(PROBE);

    // 顶栏矩形是**局部坐标**，要换算成窗口坐标才能互相比较
    const items = [];
    // 只放 renderer 真正存了矩形的东西。药丸/芯片是绘制时算的、没有存矩形——
    // 我用硬编码坐标去代表它们，一开始把探针自己建模错了（"custom × chips"在
    // 所有宽度都报同一个 28px，就是硬编码造成的假信号）。宁可漏报也不要假报。
    // 设计坐标 → 窗口坐标：x/y/宽/高都要乘 hs（顶栏等比缩放），再加平移。
    // 只加 sideX 不乘 hs 的话，窄屏上所有矩形都比真实位置宽出一截 —— 会报一堆
    // 「控件被挤出视口」的假警报（真实原因是我改了布局没改探针）。
    const hs = (typeof d.hs === 'number' && d.hs > 0) ? d.hs : 1;
    const put = (name, r) => {
        if (!r || r.w <= 0 || r.h <= 0) return;
        items.push({ name, x: r.x * hs + d.sideX, y: r.y * hs + d.headerTop,
                     w: r.w * hs, h: r.h * hs });
    };
    put('help', d.helpBtn);
    put('easy', d.easyBtn); put('medium', d.mediumBtn); put('hard', d.hardBtn);
    put('custom', d.customBtn); put('seed', d.seedBtn);
    put('settings', d.settingsBtn); put('restart', d.restartBtn);
    put('bgValue', d.bgValue); put('bgTrack', d.bgTrack);
    put('ustcBox', d.ustc.ustcBox); put('magBox', d.ustc.magBox); put('hideBox', d.ustc.hideBox);
    put('ustcLabel', d.ustc.ustcLabel); put('magLabel', d.ustc.magLabel); put('hideLabel', d.ustc.hideLabel);
    // 绘制时现算的那些（药丸/芯片/统计行/进度条/OPACITY 标签）
    for (const [k, r] of Object.entries(d.drawn)) put(k, r);
    // bgTrack 与 bgValue 同属滑块、ustcBox 与其 label 配套，这些不互判
    const SKIP = [
        ['bgValue', 'bgTrack'],
        ['ustcBox', 'ustcLabel'], ['magBox', 'magLabel'], ['hideBox', 'hideLabel'],
        // 统计行与其下的进度条上下相邻、芯片与药丸同行属设计如此
        ['chips', 'pillMines'], ['chips', 'pillTime'],
        ['statRow', 'barRow'], ['statRow', 'barRow'],
    ];

    const overlap = (a, b) => {
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        return (ox > 0 && oy > 0) ? Math.min(ox, oy) : 0;
    };
    const bad = [];
    for (let i = 0; i < items.length; i++)
        for (let j = i + 1; j < items.length; j++) {
            const key = [items[i].name, items[j].name].sort().join('|');
            if (SKIP.some(p => p.slice().sort().join('|') === key)) continue;
            const o = overlap(items[i], items[j]);
            if (o > 0) bad.push({ a: items[i].name, b: items[j].name, o });
        }
    bad.sort((x, y) => y.o - x.o);
    totalBad += bad.length;
    const availW = d.winW - 2 * d.sideX;
    const worst = bad[0] ? `${bad[0].a} × ${bad[0].b} (${bad[0].o.toFixed(0)}px)` : '—';
    const flag = bad.length ? '❌' : '✅';
    console.log(`${w}×${h}`.padEnd(14) + String(availW).padEnd(10) +
        `${flag} ${String(bad.length).padEnd(6)} ${worst}`);
    if (bad.length > 1) {
        for (const b of bad.slice(1, 5))
            console.log('      '.padEnd(24) + `  · ${b.a} × ${b.b} (${b.o.toFixed(0)}px)`);
    }

    // 越界检查：**不能靠"把控件挤出屏幕"来消灭重叠**。
    // 任何控件跑出视口（左右各留 4px 余量）都算失败——那只是把重叠换成看不见。
    const off = items.filter(it => it.x < 4 || it.x + it.w > d.winW - 4);
    if (off.length) {
        outOfView.push(`${w}×${h}: ` + off.map(o =>
            `${o.name}(x=${o.x.toFixed(0)}..${(o.x + o.w).toFixed(0)}，窗口 ${d.winW})`).join('  '));
    }
}

console.log('─'.repeat(88));
if (outOfView.length) {
    console.log('❌ 有控件被挤出视口（重叠"消失"只是因为看不见了）：');
    for (const o of outOfView) console.log('   ' + o);
} else {
    console.log('✅ 所有控件都在视口内');
}
console.log(totalBad === 0 && outOfView.length === 0
    ? '✅ 所有尺寸下顶栏无重叠、且没有控件被挤出'
    : '❌ 顶栏在窄屏下仍有问题');
process.exit(totalBad === 0 && outOfView.length === 0 ? 0 : 1);