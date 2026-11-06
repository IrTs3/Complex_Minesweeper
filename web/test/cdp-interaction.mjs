// 网页版交互回归测试：用 CDP 向真实浏览器派发**真实**鼠标/键盘事件。
//
// 为什么不用合成事件：`dispatchEvent(new KeyboardEvent(...))` 不会触发浏览器的默认动作，
// 因此复现不了「点击后焦点转移」这类 bug —— 本测试要防的正是这一类。
// 本脚本零第三方依赖（Node 22 自带 fetch 与 WebSocket），不需要装 Playwright/Puppeteer。
//
// 用法：
//   1) 起静态服务：  cd web && python3 serve.py
//   2) 起带调试端口的 Edge：
//      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
//        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
//        --user-data-dir=/tmp/edge-cdp about:blank &
//   3) 跑本测试：    node web/test/cdp-interaction.mjs
//
// 覆盖的回归点（均为「改前必失败」的判定点）：
//   T1 数字键可标记          T2 左键点击后焦点仍在 #kb
//   T3 点击之后数字键仍可用   T4 小键盘同样可用
//   T5 格子间隙吸附到后一格   T6 F1 帮助开关
//   T7 方向键只走一格（防 keydown 重复处理）
//   T8 种子输入不重复插入     T9 设置面板打开时数字键不落棋盘
//   T10~T13 模长模式判胜      T14 USTC 败局揭晓雷（像素级）
//   T15 SAVE 统计口径         T16 chord 返回码 0/1/2 与桌面端对齐
//   T17 chord 返回码被正确解读（中键，成对断言）  T18 帮助文案与桌面端一致
//   T19 种子校验宽严对齐 seedIsSane
//   T20 设置面板星光数量/大小数值框（真实点击 + 输入 + Enter 提交）
//
// 背景（2026-10-15 修复）：键盘监听原先只挂在隐藏 textarea `#kb` 上，左键点击 canvas 时
// mousedown 的默认动作把焦点移到 body，之后**所有**快捷键（含数字键标记与 F1~F5）永久失灵。
// 修法：① keydown 迁到 document；② 左键补 preventDefault 保住 #kb 焦点（剪贴板依赖它）；
// ③ 数字键改用 e.code 与桌面端物理键码对齐；④ 顺带修 cellAt 的 3px 间隙死区。
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

// —— 产物新鲜度检查：dist 必须比 ts 源码新 ——
// 否则测试跑的是旧产物，会给出误导性结论（本人踩过：改完源码忘 tsc，断言失败却以为是产品 bug）。
{
    const here = dirname(fileURLToPath(import.meta.url));
    const tsDir = join(here, '..', 'ts'), distDir = join(here, '..', 'dist');
    const newest = (dir, ext) => Math.max(...readdirSync(dir)
        .filter(f => f.endsWith(ext))
        .map(f => statSync(join(dir, f)).mtimeMs));
    const newestTs = newest(tsDir, '.ts'), oldestDist = Math.min(...readdirSync(distDir)
        .filter(f => f.endsWith('.js'))
        .map(f => statSync(join(distDir, f)).mtimeMs));
    if (newestTs > oldestDist) {
        const d = new Date(newestTs).toLocaleTimeString();
        console.error(`❌ dist 是过期的：源码最新改动 ${d}，但 dist/*.js 更旧。`);
        console.error('   先跑 `cd web && ./node_modules/.bin/tsc` 再测，否则断言针对的是旧产物。');
        process.exit(3);
    }
}

const PORT = process.env.CDP_PORT || 9222;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8080/';
const VIEW_W = 1200, VIEW_H = 1000;

let ws, nextId = 1;
const pending = new Map();
const events = [];
const pass = [], fail = [];

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
function check(name, ok, detail) {
    (ok ? pass : fail).push(name);
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}
async function mouse(type, x, y, button = 'none', buttons = 0) {
    await send('Input.dispatchMouseEvent', {
        type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1,
    });
}
async function key(code, keyStr, vk) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyStr, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(120);
}

// —— 连到目标页 ——
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('CDP 里找不到 page target，Edge 起了吗？'); process.exit(1); }
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) events.push(m.method);
};
await send('Page.enable');
await send('Runtime.enable');
// 必须显式设定视口（--window-size 在 headless=new 下不可靠）。视口过矮会让 winH 被钳小、
// 棋盘下半部分被裁到画布外，鼠标坐标全落在视口外 → pointermove 收不到 → 测试假失败。
await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });

await send('Page.navigate', { url: PAGE + '?t=' + Date.now() });
for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); ++i) await sleep(100);
await sleep(700);

// —— 页面自检 ——
const boot = await evalJs(`(() => {
  const g = window.__game;
  if (!g || !g.renderer || !g.renderer.board) return { ok:false, why:'window.__game / renderer / board 不存在' };
  const L = g.renderer.L, rect = document.getElementById('board').getBoundingClientRect();
  return { ok:true, cols:g.renderer.board.cols(), rows:g.renderer.board.rows(),
           boardBottom:L.boardY + L.boardH, canvasH:L.winH,
           viewportW:window.innerWidth, viewportH:window.innerHeight, cssW:rect.width };
})()`);
if (!boot.ok) { console.error(boot.why); process.exit(1); }
console.log(`载入自检: ${boot.cols}x${boot.rows}  视口 ${boot.viewportW}x${boot.viewportH}  画布宽 ${boot.cssW}`);
// 前置条件：棋盘必须完整落在画布内，否则坐标计算无效、失败结论不可信
if (boot.boardBottom > boot.canvasH + 0.5) {
    console.error(`❌ 前置条件不满足：棋盘底部 ${boot.boardBottom} > 画布高 ${boot.canvasH}（视口 ${boot.viewportH}）`);
    process.exit(2);
}

await evalJs(`
function clientOf(r, c, dx, dy) {
  const L = window.__game.renderer.L;
  const rect = document.getElementById('board').getBoundingClientRect();
  const sx = L.winW / rect.width, sy = L.winH / rect.height;
  const pitch = L.cell + 3;
  const cx = L.boardX + c * pitch + L.cell / 2 + (dx || 0);
  const cy = L.boardY + r * pitch + L.cell / 2 + (dy || 0);
  return { x: rect.left + cx / sx, y: rect.top + cy / sy };
}
function firstUnopened(fromR) {
  const b = window.__game.renderer.board;
  for (let r = fromR || 0; r < b.rows(); ++r)
    for (let c = 0; c < b.cols(); ++c) {
      if (b.at(r, c).opened) continue;
      if (c + 1 < b.cols() && b.at(r, c + 1).opened) continue;  // 缝隙测试需要右侧也空着
      return { r, c };
    }
  return null;
}
function flagOf(r, c) { return window.__game.renderer.board.at(r, c).flag; }
function countFlags() {
  const b = window.__game.renderer.board; let n = 0;
  for (let r = 0; r < b.rows(); ++r) for (let c = 0; c < b.cols(); ++c) if (b.at(r, c).flag !== 0) ++n;
  return n;
}
`);

let t;

console.log('\n—— T1/T2/T3  数字键与点击后的焦点（核心 bug）——');
t = await evalJs(`(() => { const u = firstUnopened(8); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await key('Digit1', '1', 49);
check('T1 点击前：悬停 + 按 1 → 标记 +1', (await evalJs(`flagOf(${t.u.r},${t.u.c})`)) === 1);

const focusBefore = await evalJs(`document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '(null)'`);
t = await evalJs(`(() => { const u = firstUnopened(0); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await mouse('mousePressed', t.p.x, t.p.y, 'left', 1);
await mouse('mouseReleased', t.p.x, t.p.y, 'left', 0);
await sleep(200);
const focusAfter = await evalJs(`document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : '(null)'`);
check('T2 点击前焦点在 #kb', focusBefore === 'kb', `=${focusBefore}`);
check('T2 左键点击后焦点仍在 #kb', focusAfter === 'kb', `=${focusAfter}`);

t = await evalJs(`(() => { const u = firstUnopened(9); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await key('Digit2', '2', 50);
check('T3 点击之后：悬停 + 按 2 → 标记 -1', (await evalJs(`flagOf(${t.u.r},${t.u.c})`)) === 2);

console.log('\n—— T4/T5  小键盘与格子间隙 ——');
t = await evalJs(`(() => { const u = firstUnopened(11); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await key('Numpad3', '3', 99);
check('T4 小键盘 3 → 标记 +i', (await evalJs(`flagOf(${t.u.r},${t.u.c})`)) === 3);

t = await evalJs(`(() => {
  const u = firstUnopened(13); const L = window.__game.renderer.L;
  return { u, p: clientOf(u.r, u.c, L.cell / 2 + 1, 0) };   // 本格右边缘 +1px，落进 3px 缝隙
})()`);
await mouse('mouseMoved', t.p.x, t.p.y);
const gapHit = await evalJs(`(() => {
  const R = window.__game.renderer, L = R.L;
  const rect = document.getElementById('board').getBoundingClientRect();
  const sx = L.winW / rect.width, sy = L.winH / rect.height;
  return R.cellAt((${t.p.x} - rect.left) * sx, (${t.p.y} - rect.top) * sy);
})()`);
check('T5 缝隙吸附到后一格 (r, c+1)',
    gapHit && gapHit.r === t.u.r && gapHit.c === t.u.c + 1,
    `期望 (${t.u.r},${t.u.c + 1}) 实际 ${JSON.stringify(gapHit)}`);

console.log('\n—— T6/T7  快捷键与「方向键只走一格」——');
// ⚠️ **不要再用 F1 打开帮助**（2026-10-16 起）。
//   网页端刻意不接管 F1~F5：F1/F3/F5 是浏览器自己的帮助/页内查找/刷新，
//   抢过来会让用户按 F5 刷新时弹出切难度确认框。帮助改从顶栏的 ? 按钮进入。
//   所以这里直接调渲染器的方法 —— 测的是**帮助面板本身**，
//   不与「用哪种方式打开」耦合（用按键的话，一改绑定就连坐后面所有断言）。
await evalJs(`window.__game.renderer.openHelp()`);
check('T6 帮助面板可打开', (await evalJs(`window.__game.renderer.helpOpen_`)) === true);
await evalJs(`window.__game.renderer.closeHelp()`);
check('T6 帮助面板可关闭', (await evalJs(`window.__game.renderer.helpOpen_`)) === false);

t = await evalJs(`(() => { const u = firstUnopened(2); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await mouse('mousePressed', t.p.x, t.p.y, 'right', 2);
await mouse('mouseReleased', t.p.x, t.p.y, 'right', 0);
await sleep(150);
const menuOpen = await evalJs(`window.__game.renderer.menuIsOpen()`);
const i0 = await evalJs(`window.__game.renderer.menuIndex_`);
await key('ArrowDown', 'ArrowDown', 40);
const i1 = await evalJs(`window.__game.renderer.menuIndex_`);
check('T7 右键打开标记菜单', menuOpen === true);
check('T7 ArrowDown 只走一格（keydown 未被重复处理）', ((i1 - i0) + 5) % 5 === 1, `${i0} → ${i1}`);
await key('Escape', 'Escape', 27);

console.log('\n—— T8/T9  种子输入与设置面板的输入路由 ——');
await evalJs(`window.__game.renderer.openSeedLoadDialog('')`);
await sleep(150);
const s0 = await evalJs(`window.__game.renderer.seedInput_.length`);
await key('KeyA', 'a', 65); await key('KeyB', 'b', 66); await key('KeyC', 'c', 67);
const s1 = await evalJs(`window.__game.renderer.seedInput_.length`);
check('T8 打 3 个字符恰好插入 3 个', s1 - s0 === 3, `插入 ${s1 - s0} 个（重复处理会是 6）`);
await key('Escape', 'Escape', 27);

await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
const c0 = await evalJs(`countFlags()`);
t = await evalJs(`(() => { const u = firstUnopened(3); return { u, p: clientOf(u.r, u.c) }; })()`);
await mouse('mouseMoved', t.p.x, t.p.y);
await key('Digit1', '1', 49);
const c1 = await evalJs(`countFlags()`);
check('T9 设置面板打开时数字键不落棋盘', c1 === c0, `已标记 ${c0} → ${c1}`);
await key('Escape', 'Escape', 27);

// ============ T10~T13：模长口径判胜（「总是显示模长」修复） ============
// 判别性局面：把所有雷标成**反号** —— 各格可见提示的模长不变，故模长口径成立；
// 若存在被纯实/纯虚提示锚定的分量，则有符号口径不成立。只有这样的局面能区分两个口径。
console.log('\n—— T10~T13  模长口径判胜 ——');
const flipHelper = 'const flipT = t => (t === 1 ? 2 : t === 2 ? 1 : t === 3 ? 4 : t === 4 ? 3 : 0);';
const disc = await evalJs(`(() => {
  ${flipHelper}
  const b = window.__game.board;
  for (let seed = 1; seed <= 600; ++seed) {
    b.boardReset(9, 9, 12); b.boardSetSeed(seed); b.boardSetMagnitudeMode(false); b.boardOpen(4, 4);
    let n = 0;
    for (let r = 0; r < 9; ++r) for (let c = 0; c < 9; ++c) {
      const x = b.boardCellRef(r, c);
      if (x.mine !== 0) { b.boardSetFlag(r, c, flipT(x.mine)); ++n; }
    }
    if (n !== 12) continue;
    if (b.boardWon()) continue;                 // 该局有符号口径也接受整体反号，换一局
    b.boardSetMagnitudeMode(true);
    const magWon = b.boardWon();                // 切换即重判（本次同时修了这一点）
    b.boardSetMagnitudeMode(false);
    if (magWon) return { seed, n };
  }
  return null;
})()`);
check('T10 找到判别性局面（有符号不成立、模长成立）', disc !== null,
      disc ? `seed=${disc.seed} 雷数=${disc.n}` : '600 个种子内未找到');

if (disc) {
    const m1 = await evalJs(`(() => {
      ${flipHelper}
      const b = window.__game.board;
      b.boardReset(9, 9, 12); b.boardSetSeed(${disc.seed}); b.boardSetMagnitudeMode(false); b.boardOpen(4, 4);
      for (let r = 0; r < 9; ++r) for (let c = 0; c < 9; ++c) {
        const x = b.boardCellRef(r, c);
        if (x.mine !== 0) b.boardSetFlag(r, c, flipT(x.mine));
      }
      return b.boardWon();
    })()`);
    check('T11 同一局面：有符号口径**不**判胜（确认没把两个口径接反）', m1 === false, `won=${m1}`);

    const m2 = await evalJs(`(() => { const b = window.__game.board; b.boardSetMagnitudeMode(true); return b.boardWon(); })()`);
    check('T12 切到模长模式立即判胜（含「切换即重判」）', m2 === true, `won=${m2}`);

    const m3 = await evalJs(`(() => {
      const b = window.__game.board;
      b.boardReset(9, 9, 12); b.boardSetSeed(${disc.seed}); b.boardSetMagnitudeMode(true); b.boardOpen(4, 4);
      let skipped = false, flagged = 0;
      for (let r = 0; r < 9; ++r) for (let c = 0; c < 9; ++c) {
        const x = b.boardCellRef(r, c);
        if (x.mine === 0) continue;
        if (!skipped) { skipped = true; continue; }   // 故意漏标一颗
        b.boardSetFlag(r, c, x.mine); ++flagged;
      }
      return { won: b.boardWon(), skipped, flagged };
    })()`);
    check('T13 模长模式漏标一颗雷 → 不判胜',
          m3 && m3.skipped === true && m3.flagged === 11 && m3.won === false, JSON.stringify(m3));

    // 顺序很关键：多插的旗必须在「标满雷」**之前**插好。否则标满那一刻已判胜、gameOver 会让插旗无声失败。
    const m4 = await evalJs(`(() => {
      const b = window.__game.board;
      b.boardReset(9, 9, 12); b.boardSetSeed(${disc.seed}); b.boardSetMagnitudeMode(true); b.boardOpen(4, 4);
      let extra = null;
      for (let r = 0; r < 9 && !extra; ++r) for (let c = 0; c < 9 && !extra; ++c) {
        const x = b.boardCellRef(r, c);
        if (x.mine === 0 && !x.opened && x.flag === 0) { b.boardSetFlag(r, c, 1); extra = { r, c }; }
      }
      const extraPlaced = extra ? b.boardCellRef(extra.r, extra.c).flag !== 0 : false;
      let n = 0;
      for (let r = 0; r < 9; ++r) for (let c = 0; c < 9; ++c) {
        const x = b.boardCellRef(r, c);
        if (x.mine !== 0) { b.boardSetFlag(r, c, x.mine); ++n; }
      }
      return { extraPlaced, n, won: b.boardWon() };
    })()`);
    check('T13 前置：多插的旗确实插上了', m4 && m4.extraPlaced === true, JSON.stringify(m4));
    check('T13 模长模式：安全格多插旗 → 破坏判胜（flags_ != mines_）', m4 && m4.won === false, JSON.stringify(m4));
}

// ============ T14：USTC 模式下败局必须揭晓雷（像素级） ============
// 断言与具体颜色无关：数「饱和像素」（max-min > 30）。USTC 字母是灰的、雷点是蓝/绿的，
// 所以败局后未标记雷格的中心区域若出现大量饱和像素，就说明雷点画出来了。
console.log('\n—— T14  USTC 模式下败局揭晓雷 ——');
const ustcSetup = await evalJs(`(() => {
  const g = window.__game, b = g.board, R = g.renderer;
  b.boardReset(9, 9, 12); b.boardSetSeed(777); b.boardSetMagnitudeMode(false); b.boardOpen(0, 0);
  R.setUstcMode(true); g.cfg.ustcMode = true;
  let mine = null;
  for (let r = 0; r < 9 && !mine; ++r) for (let c = 0; c < 9 && !mine; ++c)
    if (b.boardCellRef(r, c).mine !== 0) mine = { r, c };
  return { mine, lost: b.boardLost() };
})()`);
if (ustcSetup && ustcSetup.mine) {
    await evalJs(`(() => { const b = window.__game.board, m = ${JSON.stringify(ustcSetup.mine)}; b.boardOpen(m.r, m.c); return b.boardLost(); })()`);
    await sleep(450); // 等一帧重绘
    const pix = await evalJs(`(() => {
      const R = window.__game.renderer, L = R.L, m = ${JSON.stringify(ustcSetup.mine)};
      const cv = document.getElementById('board'), ctx = cv.getContext('2d');
      const scale = cv.width / L.winW;
      const pitch = L.cell + 3, n = Math.max(4, Math.round(L.cell * scale));
      const x0 = Math.round((L.boardX + m.c * pitch) * scale), y0 = Math.round((L.boardY + m.r * pitch) * scale);
      const d = ctx.getImageData(x0, y0, n, n).data;
      let sat = 0, total = 0;
      for (let i = 0; i < d.length; i += 4) {
        const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
        if (mx - mn > 30) ++sat;
        ++total;
      }
      return { sat, total, lost: window.__game.board.boardLost(), scale };
    })()`);
    check('T14 已进入失败状态（前置条件）', pix && pix.lost === true, `lost=${pix && pix.lost}`);
    check('T14 USTC 开启时雷点仍被画出（饱和像素数）', pix && pix.sat > 50,
          `饱和像素 ${pix && pix.sat}/${pix && pix.total}（改前 ≈0）`);
    await evalJs(`window.__game.renderer.setUstcMode(false); window.__game.cfg.ustcMode = false;`);
}

// ============ T15：SAVE 提示的统计口径 ============
console.log('\n—— T15  SAVE PROGRESS 统计口径（对齐桌面端）——');
const saveTest = await evalJs(`(() => {
  const g = window.__game, b = g.board;
  b.boardReset(9, 9, 12); b.boardSetSeed(555); b.boardSetMagnitudeMode(false); b.boardOpen(0, 0);
  let safe = null;
  for (let r = 0; r < 9 && !safe; ++r) for (let c = 0; c < 9 && !safe; ++c) {
    const x = b.boardCellRef(r, c);
    if (x.mine === 0 && !x.opened && x.flag === 0) safe = { r, c };
  }
  if (!safe) return { err: '找不到可插旗的安全格' };
  b.boardSetFlag(safe.r, safe.c, 1);
  const placed = b.boardCellRef(safe.r, safe.c).flag !== 0;
  const txt = g.saveHintText();
  const m = /^(\\d+)% opened, (\\d+) flags/.exec(txt);
  return { placed, txt, opened: m ? +m[1] : null, flags: m ? +m[2] : null };
})()`);
check('T15 前置：错旗确实插上了', saveTest && saveTest.placed === true, JSON.stringify(saveTest));
check('T15 插在安全格上的旗被计入 flags（桌面端口径）', saveTest && saveTest.flags === 1,
      `flags=${saveTest && saveTest.flags}（改前为 0：只数标在真雷上的旗）  提示="${saveTest && saveTest.txt}"`);

// ============ T16：chord 返回码与桌面端 ChordResult 对齐 ============
// 背景：网页端原先 1=被阻挡 / 2=已展开，与桌面端 Board::ChordResult（Opened=1, Blocked=2）相反。
// 两端各自解读自己的返回值，所以单机无可见 bug；但迁移/共用规则时会错读 → 这里钉死取值。
console.log('\n—— T16  chord 返回码（0 不适用 / 1 已展开 / 2 被阻挡）——');
const chord = await evalJs(`(() => {
  const b = window.__game.board;
  b.boardReset(9, 9, 12); b.boardSetSeed(20261016); b.boardSetMagnitudeMode(false); b.boardOpen(0, 0);
  let covered = null;   // 未翻开的格子 → 不适用
  for (let r = 0; r < b.boardRows() && covered === null; ++r)
    for (let c = 0; c < b.boardCols(); ++c)
      if (!b.boardCellRef(r, c).opened) { covered = b.boardChord(r, c); break; }
  let pick = null;      // "已翻开数字格 + 有未标对的相邻雷 + 有未翻开的空格"
  for (let r = 0; r < b.boardRows() && !pick; ++r) for (let c = 0; c < b.boardCols() && !pick; ++c) {
    const cell = b.boardCellRef(r, c);
    if (!cell.opened || cell.adjTotal <= 0) continue;
    const mines = [], free = [];
    for (let dr = -1; dr <= 1; ++dr) for (let dc = -1; dc <= 1; ++dc) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= b.boardRows() || nc >= b.boardCols()) continue;
      const n = b.boardCellRef(nr, nc);
      if (n.mine !== 0) mines.push({ r: nr, c: nc, mine: n.mine });
      else if (!n.opened && n.flag === 0) free.push({ r: nr, c: nc });
    }
    if (mines.length > 0 && free.length > 0) pick = { r, c, mines };
  }
  if (!pick) return { covered };
  const blocked = b.boardChord(pick.r, pick.c);          // 雷未标对 → 应为 2
  for (const m of pick.mines) b.boardSetFlag(m.r, m.c, m.mine);
  const openedRes = b.boardChord(pick.r, pick.c);        // 标对 → 应为 1
  const again = b.boardChord(pick.r, pick.c);            // 已无可开之格 → 0
  return { covered, blocked, openedRes, again };
})()`);
check('T16 未翻开的格子 chord → 0（不适用）', chord && chord.covered === 0, `实际 ${chord && chord.covered}`);
if (!chord || chord.blocked === undefined) {
    check('T16 找到可用于 chord 的判别性格局', false, '未找到');
} else {
    check('T16 相邻雷未标对 → 2（被阻挡）', chord.blocked === 2, `实际 ${chord.blocked}（旧版此处为 1）`);
    check('T16 相邻雷全部标对 → 1（已展开）', chord.openedRes === 1, `实际 ${chord.openedRes}（旧版此处为 2）`);
    check('T16 已无可开之格 → 0', chord.again === 0, `实际 ${chord.again}`);
}

// ============ T17：chord 返回码被正确解读（中键端到端，成对断言） ============
// 重要（踩过的坑）：boardChord 自己就会把邻居翻开（副作用），返回码只是状态。
// 所以「邻居被翻开」**不能**用来判定返回码是否被正确解读 —— 实测确认旧语义下该断言也会通过。
// 真正的判别点是 doChord 走了哪个分支：成功(1) → 不提示；被阻挡(2) → 提示 BAD MARKS（chordFail 默认 hint）。
// 因此做一对正反断言：标对 → 不得出现 BAD MARKS；未标对 → 必须出现 BAD MARKS。
console.log('\n—— T17  chord 返回码被正确解读（中键，成对断言）——');
const chordScenario = (seed, flagMines) => `(() => {
  const g = window.__game, b = g.board;
  g.cfg.chordFail = 'hint';
  b.boardReset(9, 9, 12); b.boardSetSeed(${seed}); b.boardSetMagnitudeMode(false); b.boardOpen(0, 0);
  g.renderer.setSeedNote('');
  for (let r = 0; r < b.boardRows(); ++r) for (let c = 0; c < b.boardCols(); ++c) {
    const cell = b.boardCellRef(r, c);
    if (!cell.opened || cell.adjTotal <= 0) continue;
    const mines = [], free = [];
    for (let dr = -1; dr <= 1; ++dr) for (let dc = -1; dc <= 1; ++dc) {
      if (!dr && !dc) continue;
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nc < 0 || nr >= b.boardRows() || nc >= b.boardCols()) continue;
      const n = b.boardCellRef(nr, nc);
      if (n.mine !== 0) mines.push({ r: nr, c: nc, mine: n.mine });
      else if (!n.opened && n.flag === 0) free.push({ r: nr, c: nc });
    }
    if (mines.length === 0 || free.length === 0) continue;
    if (${flagMines}) for (const m of mines) b.boardSetFlag(m.r, m.c, m.mine);
    return { r, c };
  }
  return null;
})()`;
for (const [flagMines, wantBad, label] of [[true, false, '标对后'], [false, true, '未标对时']]) {
    const sc = await evalJs(chordScenario(31337, flagMines));
    if (!sc) { check(`T17 找到判别性格局（${label}）`, false, '未找到'); continue; }
    const sp = await evalJs(`clientOf(${sc.r}, ${sc.c})`);
    await mouse('mousePressed', sp.x, sp.y, 'middle', 4);
    await mouse('mouseReleased', sp.x, sp.y, 'middle', 0);
    await sleep(200);
    const note = await evalJs(`window.__game.renderer.seedNote()`);
    if (wantBad) {
        // ⚠️ 用**前缀**判断而不是全等：2026-10-16 起提示加了中文说明
        //   （'BAD MARKS · 这一圈的标记与数字不符'），全等会假红。
        //   前缀才是稳定的契约——游戏传的是哪个分支，而不是文案长什么样。
        check('T17 未标对：中键 chord 走「被阻挡」分支（提示 BAD MARKS）',
              /^BAD MARKS/.test(note), `seedNote="${note}"`);
    } else {
        check('T17 标对后：中键 chord 走「成功」分支（不提示 BAD MARKS）',
              !/^BAD MARKS/.test(note), `seedNote="${note}"（返回码搬错方向时此处会是 BAD MARKS）`);
    }
}

// ============ T18：帮助文案与桌面端一致 ============
console.log('\n—— T18  帮助文案（胜负判定）与桌面端一致 ——');
// 同T6：不用 F1，直接调渲染器（理由见上）。
await evalJs(`window.__game.renderer.openHelp()`);
await sleep(250);
const helpText = await evalJs(`(() => {
  const R = window.__game.renderer;
  return (R.helpRows_ || []).map(r => (r.segs || []).map(s => s.text).join('')).join('\\n');
})()`);
await evalJs(`window.__game.renderer.closeHelp()`);
check('T18 一·3 含「（雷怎么标都行）」', /雷怎么标都行/.test(helpText));
check('T18 一·3 含「（不多不少）」', /不多不少/.test(helpText));
check('T18 三·3 含「一颗不多一颗不少」', /一颗不多一颗不少/.test(helpText));
check('T18 五·路径一 已改为「标不标都随你」，旧措辞消失',
      /标不标都随你/.test(helpText) && !/雷留在底下没标也没关系/.test(helpText));
check('T18 五·路径二 含「在安全格上多插旗会破坏判胜」', /在安全格上多插旗会破坏判胜/.test(helpText));

// ============ T19：种子校验宽严对齐桌面端 seedIsSane ============
console.log('\n—— T19  种子校验宽严对齐桌面端 seedIsSane ——');
{
    const here2 = dirname(fileURLToPath(import.meta.url));
    // dist/*.js 是 ESM，但 web/package.json 未声明 type:module，Node 会按 CJS 解析而导入失败。
    // 复制成 .mjs 再导入，即可复用与页面完全相同的编解码器来构造测试种子。
    const tmp = join(tmpdir(), 'seedcodec-for-test.mjs');
    writeFileSync(tmp, readFileSync(join(here2, '..', 'dist', 'seedcodec.js')));
    const { encodeSeed } = await import(pathToFileURL(tmp).href);
    const mk = (o) => encodeSeed(Object.assign({
        kind: 'new', elapsedCs: 0, phase: 'playing', openedRows: [], flagRows: [],
        ustcMode: false, createdAt: '',
    }, o));
    // manualSplit 且 real+imag ≠ mines：自相矛盾种子，2026-10-26 安全修复后双端（seedcodec/Seed.h）
    // 一律拒绝——否则「mines=5、real+imag=8」能造出账面 5 颗实际 8 颗的棋盘，排行回放没有地基。
    // 先放一个合法 manualSplit（4+4=8=mines）确认放行通道没被误伤，再放矛盾种子确认被拒。
    const goodSplit = mk({ cols: 11, rows: 7, mines: 8, manualSplit: true, realMines: 4, imagMines: 4,
                           rngSeed: 12345, firstRow: 0, firstCol: 0 });
    await evalJs(`window.__game.applySeed(${JSON.stringify(goodSplit)})`);
    await sleep(150);
    const okCols = await evalJs(`window.__game.board.boardCols()`);
    check('T19 合法 manualSplit（real+imag=mines）仍被接受', okCols === 11, `boardCols=${okCols}`);
    const weird = mk({ cols: 11, rows: 7, mines: 5, manualSplit: true, realMines: 4, imagMines: 4,
                       rngSeed: 12345, firstRow: 0, firstCol: 0 });
    await evalJs(`window.__game.applySeed(${JSON.stringify(weird)})`);
    await sleep(150);
    const gotCols = await evalJs(`window.__game.board.boardCols()`);
    check('T19 manualSplit 且 real+imag≠mines 的种子被拒绝（安全修复后双端一致）', gotCols === 11, `boardCols=${gotCols}`);
    // 越界种子（cols > 300）仍必须被拒 —— 确认放宽没有把校验整条拆掉
    const huge = mk({ cols: 400, rows: 9, mines: 10, manualSplit: false, realMines: -1, imagMines: -1,
                      rngSeed: 1, firstRow: 0, firstCol: 0 });
    await evalJs(`window.__game.applySeed(${JSON.stringify(huge)})`);
    await sleep(150);
    const stillCols = await evalJs(`window.__game.board.boardCols()`);
    check('T19 越界种子（cols=400 > 300）仍被拒绝', stillCols === 11, `boardCols=${stillCols}（应保持不变）`);
}

// ============ T20：设置面板星光密度/大小数值框（点框输入） ============
// 这两个框是「画出来的」，没有 DOM input —— 所以必须用真实鼠标事件打在矩形中心，
// 走完整的 settingsHit → focusOn → settingsChar → Enter 提交链路，才算真验证。
console.log('\n—— T20  星光密度/大小数值框（点框输入，与双击毫秒框同口径）——');
await evalJs(`
function starBoxClient(which) {
  const R = window.__game.renderer;
  const b = which === 'count' ? R.settingsRects().starValue : R.settingsRects().scaleValue;
  let guard = 0;
  while (!R.settingsInView(b.y, 26) && guard++ < 30) R.scrollSettings(-1);   // 滚到看得见为止
  const L = R.L, rect = document.getElementById('board').getBoundingClientRect();
  const sx = L.winW / rect.width, sy = L.winH / rect.height;
  return { x: rect.left + (b.x + b.w / 2) / sx, y: rect.top + (b.y + b.h / 2 - R.settingsScroll_) / sy };
}
`);
await evalJs(`window.__game.renderer.openSettings(); window.__game.renderer.setStarDensity(2.17); window.__game.renderer.setStarScale(1.7);`);
await sleep(150);

async function clickStarBox(which) {
    const p = await evalJs(`starBoxClient('${which}')`);
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y, 'left', 1);
    await mouse('mouseReleased', p.x, p.y, 'left', 0);
    await sleep(120);
}
await clickStarBox('count');
check('T20 点 DENSITY 数值框 → 焦点 id 11', (await evalJs(`window.__game.renderer.settingsFocus()`)) === 11,
    `实际 focus=${await evalJs(`window.__game.renderer.settingsFocus()`)}`);
await key('Digit7', '7', 55); await key('Period', '.', 191); await key('Digit1', '1', 49); await key('Digit2', '2', 50);
await key('Enter', 'Enter', 13);
const cnt = await evalJs(`window.__game.cfg.starDensity`);
check('T20 键入 7.12 + Enter → starDensity 生效（两位小数、4 字符缓冲）', cnt === 7.12, `实际 ${cnt}`);
// 越界字符在输入阶段就被拒（上限 7.12：单敲一个 9 落不进去），Esc 只丢缓冲、不改现值
await key('Digit9', '9', 57);
const edit = await evalJs(`window.__game.renderer.settingsEdit()`);
check('T20 键入 9 时超上限的字符被当场拒（缓冲为空）', edit === '', `缓冲="${edit}"`);
await key('Escape', 'Escape', 27);
const cnt2 = await evalJs(`window.__game.cfg.starDensity`);
check('T20 取消输入不落地（starDensity 仍是 7.12）', cnt2 === 7.12, `实际 ${cnt2}`);
// 小数框走另一条解析路径（parseFloat + 只允许一个小数点）
await clickStarBox('scale');
await key('Digit2', '2', 50); await key('Period', '.', 191); await key('Digit4', '4', 52);
await key('Enter', 'Enter', 13);
const sc = await evalJs(`window.__game.cfg.starScale`);
check('T20 SIZE 框键入 2.4 + Enter → starScale 生效', sc === 2.4, `实际 ${sc}`);
await key('Escape', 'Escape', 27);

console.log(`\n════ 通过 ${pass.length} 项，失败 ${fail.length} 项 ════`);
if (fail.length) console.log('失败项：\n  - ' + fail.join('\n  - '));
ws.close();
process.exit(fail.length ? 1 : 0);
