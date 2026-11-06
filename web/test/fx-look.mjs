// 星光观感调参回路（2026-10-20）：截图 + 像素统计，用来判断「星光像不像发光体」。
//
// 为什么需要它：观感是数字问题不是形容词问题 —— 「太糊」「太密」争不出结果，
// 但「亮像素 12 万个、平均 alpha 37、最亮核半径 2.4px、蓝色占 24%」可以对着调。
// 桌面端已经没有任何截图/抽样能力（CMS_SHOT 脚手架拆干净了，T57 盯着它别再回来），
// 所以调参走「网页端先调、桌面端同参数照抄」的路子，本脚本就是网页端那一半。
//
// 用法（本地，无闸门最快）：
//   1) cd web && /opt/homebrew/bin/python3.13 serve.py --port 8080 &
//   2) "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
//        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
//        --user-data-dir=/tmp/edge-fxlook about:blank &
//   3) node web/test/fx-look.mjs
// 环境变量：
//   CDP_PORT   调试端口，默认 9222
//   PAGE_URL   默认 http://127.0.0.1:8080/（无闸门的 serve.py）
//   OUT_DIR    截图与统计输出目录，默认 /tmp/fx-look —— **刻意放在仓库外**，
//              免得调参产物被 git add 进去（分发包绝不能夹带临时文件）。
//   SIZES      视口列表，默认 1440x900,1280x720,390x844
//   COUNTS     要对比的星光密度（颗/100×100px），默认 2.17,7.12,0（0 用来验证「关干净了」；
//              两端就是 Settings 的默认与上限，2026-10-22 起是 2.17 / 7.12）
//
// 本脚本只读页面、只写 OUT_DIR，不改仓库任何文件；不通过/通过都以统计数字报告，
// 断言只保留「客观不可能有争议」的那几条（关了必须一个亮像素都没有、必须不吃点击）。

import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdirSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const BASE = (process.env.PAGE_URL || 'http://127.0.0.1:8080/').replace(/\/+$/, '');
const OUT = process.env.OUT_DIR || '/tmp/fx-look';
const SIZES = (process.env.SIZES || '1440x900,1280x720,390x844')
    .split(',').map(s => { const [w, h] = s.split('x').map(Number); return { w, h }; });
const COUNTS = (process.env.COUNTS || '2.17,7.12,0').split(',').map(Number);
const KEY = 'complex-minesweeper.settings.v1';

mkdirSync(OUT, { recursive: true });

let ws, nextId = 1;
const pending = new Map();
const events = [];

function connect() {
    return fetch(`http://127.0.0.1:${PORT}/json/list`)
        .then(r => r.json())
        .then(list => {
            const page = list.find(t => t.type === 'page');
            if (!page) throw new Error('没有可用的 page target，Edge 起来了吗？');
            return new Promise((res, rej) => {
                ws = new WebSocket(page.webSocketDebuggerUrl);
                ws.onopen = () => res();
                ws.onerror = e => rej(new Error('CDP 连接失败: ' + e.message));
                ws.onmessage = m => {
                    const msg = JSON.parse(m.data);
                    if (msg.id && pending.has(msg.id)) { pending.get(msg.id).res(msg); pending.delete(msg.id); }
                    else if (msg.method) events.push(msg.method);
                };
            });
        });
}
function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
}
async function evalJs(expression) {
    // 外面包一层 JSON.stringify：CDP 的 returnByValue 对某些对象会静默给出 undefined，
    // 先转成字符串再在 Node 侧解回来，才不会把「拿不到值」误读成「页面画了 0 个像素」。
    const r = await send('Runtime.evaluate',
        { expression: `JSON.stringify(${expression})`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.exceptionDetails.exception));
    const v = r.result && r.result.result ? r.result.result.value : undefined;
    if (typeof v !== 'string') throw new Error('CDP 没返回值: ' + JSON.stringify(r).slice(0, 300));
    return JSON.parse(v);
}
async function goto(url) {
    events.length = 0;
    await send('Page.navigate', { url });
    for (let i = 0; i < 120 && !events.includes('Page.loadEventFired'); ++i) await sleep(100);
    await sleep(600);
}
async function shot(name) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const p = `${OUT}/${name}.png`;
    writeFileSync(p, Buffer.from(r.result.data, 'base64'));
    return p;
}

// 像素统计：亮像素数 / 平均 alpha / 最亮 alpha / 色相分布。
// 色相分档按「哪个通道最强」粗分即可 —— 我们要的是白:蓝:暖白的比例对不对，不是精确色度。
const STATS_JS = `(() => {
  const c = document.getElementById('fx');
  if (!c) return { ok: false, why: 'no canvas' };
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return { ok: false, why: 'no size' };
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0, sum = 0, max = 0, brightN = 0, white = 0, blue = 0, warm = 0, other = 0;
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3];
    if (a === 0) continue;
    lit++; sum += a; if (a > max) max = a;
    const r = d[i], gg = d[i + 1], b = d[i + 2];
    if (a >= 160) brightN++;                   // 「真亮」的像素：星核与耀斑，不含光晕外圈
    if (a < 24) continue;                      // 太淡的像素不参与配色统计，全是噪声
    if (b > r + 18 && b > gg + 8) blue++;      // 蓝压过红 → 主色 #66ccff / 光晕外圈
    else if (r > b + 18 && gg > b + 8) warm++; // 红压过蓝 → 暖白 #ffd9a0
    else if (Math.abs(r - gg) < 14 && Math.abs(gg - b) < 14) white++;
    else other++;
  }
  return { ok: true, w: c.width, h: c.height, lit, meanAlpha: lit ? +(sum / lit).toFixed(1) : 0,
           maxAlpha: max, bright: brightN, white, blue, warm, other };
})()`;

// 「最亮核半径」：以最亮像素为圆心，量 alpha≥一半峰值的连通半径。
// 这是判断「像发光体还是像白点」的关键数字 —— 有光晕时它应明显大于星核本身。
const CORE_JS = `(() => {
  const c = document.getElementById('fx');
  const g = c && c.getContext('2d');
  if (!g || !c.width) return 0;
  const d = g.getImageData(0, 0, c.width, c.height).data;
  const W = c.width;
  let bi = -1, ba = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > ba) { ba = d[i]; bi = (i - 3) / 4; }
  if (bi < 0 || ba < 40) return 0;
  const cx = bi % W, cy = (bi / W) | 0, half = ba / 2;
  let r = 0;
  while (r < 40) {
    const x = cx + r + 1, y = cy;
    if (x >= W) break;
    if (d[(y * W + x) * 4 + 3] < half) break;
    r++;
  }
  return +(r / Math.min(window.devicePixelRatio || 1, 2)).toFixed(2);  // 换回 CSS 像素
})()`;

const results = [];
async function sample(tag) {
    const stats = await evalJs(STATS_JS);
    if (!stats || !stats.ok) throw new Error(`取像素统计失败：${JSON.stringify(stats)}`);
    const core = await evalJs(CORE_JS) || 0;
    const pe = await evalJs(`(() => { const e = document.getElementById('fx');
        return e ? getComputedStyle(e).pointerEvents : 'missing'; })()`);
    const file = await shot(tag);
    const row = { tag, file, pointerEvents: pe, brightestCoreRadiusCssPx: core, ...stats };
    results.push(row);
    console.log(`\n── ${tag}`);
    console.log(`   亮像素 ${stats.lit} / ${stats.w}x${stats.h}   平均 alpha ${stats.meanAlpha}   ` +
                `峰值 ${stats.maxAlpha}   亮核像素 ${stats.bright}   最亮核半径 ${core} CSS px`);
    console.log(`   配色（alpha>=24）：白 ${stats.white}  蓝 ${stats.blue}  暖白 ${stats.warm}  其他 ${stats.other}`);
    console.log(`   pointer-events: ${pe}   截图 ${file}`);
    return row;
}

// 让页面按指定数量重铺星光：直接写 localStorage 再刷新，比拖滑块可复现得多。
async function setCount(n) {
    await goto(`${BASE}/index.html`);   // 先落到同源页，localStorage 才写进对的源
    await evalJs(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(KEY)});
      const s = raw ? JSON.parse(raw) : {};
      s.starDensity = ${n};
      s.starUnit = 2;   // 新单位（颗/100×100px）：不写标记会被当成旧刻度折算
      s.starScale = 1.7;
      s.ustcMode = false;
      localStorage.setItem(${JSON.stringify(KEY)}, JSON.stringify(s));
      return true;
    })()`);
    await goto(`${BASE}/index.html`);
    await sleep(2500);   // 等粒子铺开并闪几轮，采样才有代表性
    // 回读确认设置真的生效了：游戏页自己在加载时也会写 localStorage，
    // 不回读就会把「设置被覆盖」误读成「星光画不出来」。
    const got = await evalJs(`JSON.parse(localStorage.getItem(${JSON.stringify(KEY)}) || '{}').starDensity`);
    if (Number(got) !== n) throw new Error(`设置没落地：想要 starDensity=${n}，页面里是 ${got}`);
}

await connect();
await send('Page.enable');
await send('Runtime.enable');

for (const size of SIZES) {
    await send('Emulation.setDeviceMetricsOverride',
        { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: size.w < 500 });
    for (const n of COUNTS) {
        await setCount(n);
        const tag = `${size.w}x${size.h}_count${n}`;
        const row = await sample(tag);
        if (n === 0) {
            // 数量 0 = 这一层彻底关掉：不许有一个亮像素，也不许继续跑 rAF（白耗 CPU）。
            const a = await evalJs(STATS_JS);
            await sleep(500);
            const b = await evalJs(STATS_JS);
            const idle = a.lit === 0 && b.lit === 0;
            console.log(`   ✅ 断言：count=0 时亮像素 ${a.lit}→${b.lit}（静止=${idle}）`);
            if (!idle) console.log('   ❌ count=0 仍在画东西 —— 回归 bug');
            row.zeroOk = idle;
        }
    }
}

writeFileSync(`${OUT}/stats.json`, JSON.stringify(results, null, 2));
console.log(`\n统计已写入 ${OUT}/stats.json（共 ${results.length} 组）`);
ws.close();
