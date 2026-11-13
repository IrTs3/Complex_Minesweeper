// 触摸端（手机 / iPad）手势回归测试：用 CDP 派发**真实** touch 事件。
//
// 为什么必须真事件：触摸适配修的四件事——软键盘乱弹、第一下点不动、长按出标记菜单、
// 抬手后高亮粘住——全都依赖浏览器默认行为（焦点转移、pointer capture、callout），
// 用 `dispatchEvent(new PointerEvent(...))` 合成事件一律复现不了，会得到假绿。
// 所以这里走 `Input.dispatchTouchEvent` + `Emulation.setTouchEmulationEnabled`。
//
// 用法：
//   1) cd web && python3 serve.py
//   2) "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
//        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9223 \
//        --user-data-dir=/tmp/edge-touch about:blank &
//   3) CDP_PORT=9223 node web/test/touch-gestures.mjs
//
// 覆盖点：
//   A（iPhone 390×730 触摸）A1 coarse 探测  A2 顶部对齐  A3 单击开格且不弹软键盘
//     A4 抬手无粘滞悬停  A5 长按出标记菜单且不开格  A6 长按后抬手不追加落子
//     A7 菜单项能落标记  A7c 长按+15px 漂移菜单仍开  A8 滑动 30px 取消点击（防误触）  A9 双指捏合放大
//     A10 放大后 cellAt 逆变换自洽  A11 单指平移且不露白  A12 双指轻点复位
//     A13 CUSTOM 面板不溢出（U15）  A14 CUSTOM 的 + 按钮点得动
//   B（iPad 820×1180 触摸）B1 高级盘捏合后格子够大  B2 宽面板布局与桌面端逐一相同
//   C（1440×900 鼠标）C1 非 coarse 且仍居中  C2 视图变换恒等  C3 鼠标开格未回归
import { setTimeout as sleep } from 'node:timers/promises';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// —— 产物新鲜度检查：dist 必须比 ts 源码新（跑旧产物会得到误导性结论）——
{
    const here = dirname(fileURLToPath(import.meta.url));
    const tsDir = join(here, '..', 'ts'), distDir = join(here, '..', 'dist');
    const newest = (dir, ext) => Math.max(...readdirSync(dir).filter(f => f.endsWith(ext))
        .map(f => statSync(join(dir, f)).mtimeMs));
    if (newest(tsDir, '.ts') > Math.min(...readdirSync(distDir).filter(f => f.endsWith('.js'))
        .map(f => statSync(join(distDir, f)).mtimeMs))) {
        console.error('❌ dist 是过期的：先跑 `cd web && npx tsc` 再测。');
        process.exit(3);
    }
}

const PORT = process.env.CDP_PORT || 9223;
const PAGE = process.env.PAGE_URL || 'http://127.0.0.1:8080/';
const pass = [], fail = [];

let ws, nextId = 1, curTarget = null;
const pending = new Map();
const events = [];
const pageErrors = [];
function send(method, params = {}) {
    const id = nextId++;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
        pending.set(id, { res, rej });
        // CDP 连接断掉时 promise 永不 settle，Node 会静默退出（只留一行
        // "unsettled top-level await"），看着像测试卡死。加超时把原因打出来。
        setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                rej(new Error(`CDP 超时：${method} 15s 无响应（连接断了吗？）`));
            }
        }, 15000).unref();
    });
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

// —— 真 touch 事件 ——
let nextTouchId = 1;
async function touchStart(pts) {
    await send('Input.dispatchTouchEvent', {
        type: 'touchStart', touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id })),
    });
}
async function touchMove(pts) {
    await send('Input.dispatchTouchEvent', {
        type: 'touchMove', touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id })),
    });
}
async function touchEnd(pts) {
    await send('Input.dispatchTouchEvent', {
        type: 'touchEnd', touchPoints: pts.map(p => ({ x: p.x, y: p.y, id: p.id })),
    });
}
/** 单指轻点 */
async function tap(x, y, holdMs = 40) {
    const id = nextTouchId++;
    await touchStart([{ x, y, id }]);
    await sleep(holdMs);
    await touchEnd([{ x, y, id }]);
    await sleep(120);
}
/** 单指长按（默认 600ms，超过 armLongPress 的 450ms 阈值） */
async function longPress(x, y, ms = 600) {
    const id = nextTouchId++;
    await touchStart([{ x, y, id }]);
    await sleep(ms);
    await touchEnd([{ x, y, id }]);
    await sleep(150);
}

// —— 连到目标页 ——
// 每组设备都开一个**全新标签页**，不在同一个标签页里换设备重载。
// 原因（踩了很久）：同一标签页换尺寸重载后，浏览器侧的触摸状态会跨导航残留，
// 新文档一个 touch 事件都收不到，而鼠标事件照送 —— 症状和「触摸适配写坏了」一模一样。
// 二分实验证据：做完双指捏合后，同文档内继续点顶栏一切正常；一旦换设备重载就全哑；
// 单开新标签页则彻底规避（旧的 RenderWidgetHost 连同它的触摸队列一起被丢掉）。
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const stale = list.filter(t => t.type === 'page');
for (const t of stale) {
    try { await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`); } catch { /* 已关就算了 */ }
}
await sleep(300);
console.log(`CDP 已就绪（清掉 ${stale.length} 个遗留页面，每组设备另开新标签页）`);

async function attach() {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,
        { method: 'PUT' });
    if (!r.ok) throw new Error('新建标签页失败：HTTP ' + r.status);
    const target = await r.json();
    const sock = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });
    if (ws) { try { ws.onclose = null; ws.close(); } catch { /* 忽略 */ } }
    ws = sock;
    pending.clear();
    ws.onmessage = ev => {
        const m = JSON.parse(ev.data);
        if (m.id && pending.has(m.id)) {
            const { res, rej } = pending.get(m.id); pending.delete(m.id);
            m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
        } else if (m.method === 'Runtime.exceptionThrown') {
            // setTimeout 回调里抛的异常不会让测试失败，只会让功能"静默失灵"
            // （长按菜单打不开就是这么来的），必须打出来。
            const d = m.params.exceptionDetails;
            console.error(`  💥 页面异常 @${d.lineNumber}:${d.columnNumber} `
                + (d.exception && (d.exception.description || d.exception.value) || d.text));
            pageErrors.push(d);
        } else if (m.method === 'Runtime.consoleAPICalled'
            && ['error', 'warning'].includes(m.params.type)) {
            console.error('  ⚠️ 页面 console.' + m.params.type + ': '
                + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
        } else if (m.method) events.push(m.method);
    };
    ws.onclose = e => console.error(`⚠️ CDP 连接被关闭（code=${e.code} reason=${e.reason || '无'}）`);
    ws.onerror = e => console.error('⚠️ CDP 连接错误：', e.message || e);
    curTarget = target;
    await send('Page.enable');
    await send('Runtime.enable');
    return target;
}

/** 换一种设备：新开标签页 → 设尺寸与触摸模拟 → 载入页面 */
async function device(w, h, touch, dsf = 2) {
    const old = curTarget;
    await attach();
    if (old) { try { await fetch(`http://127.0.0.1:${PORT}/json/close/${old.id}`); } catch { /* 忽略 */ } }
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dsf, mobile: touch });
    await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    events.length = 0;
    await send('Page.navigate', { url: PAGE + '?t=' + Date.now() });
    for (let i = 0; i < 100 && !events.includes('Page.loadEventFired'); ++i) await sleep(100);
    await sleep(700);
    // 必须置顶：这个 profile 里挂着好几个扩展页，非前台页派发 Input.dispatchTouchEvent
    // 会**永远不回包**（不报错，直接把测试挂死）。
    await send('Page.bringToFront');
    const ok = await evalJs(`!!(window.__game && window.__game.renderer && window.__game.renderer.board)`);
    if (!ok) { console.error(`❌ ${w}×${h} 载入后拿不到 window.__game`); process.exit(1); }
}

// 页面内的公共探针：坐标换算必须与 renderer 的公式一致，**不能手编**
// （手编几何的探针会先给假绿、改完代码再给假红，本人在顶栏重叠那轮白跑过好几遍）。
const PROBE = `
window.P = {
  lay() { const L = window.__game.renderer.L; return {
      winW:L.winW, winH:L.winH, cell:L.cell, pitch:L.pitch, boardX:L.boardX, boardY:L.boardY,
      boardW:L.boardW, boardH:L.boardH, headerTop:L.headerTop, headerH:L.headerH, sideX:L.sideX }; },
  view() { const v = window.__game.renderer.boardView(); return { s:v.s, tx:v.tx, ty:v.ty }; },
  vp() { const r = window.__game.renderer.boardViewport(); return { x:r.x, y:r.y, w:r.w, h:r.h }; },
  coarse() { return window.__game.renderer.coarsePointer(); },
  // 世界坐标（棋盘格子）→ 屏幕坐标，含当前缩放/平移
  screenOf(r, c) { const L = window.__game.renderer.L, v = window.__game.renderer.boardView();
      const wx = L.boardX + c*L.pitch + L.cell/2, wy = L.boardY + r*L.pitch + L.cell/2;
      return { x: wx*v.s + v.tx, y: wy*v.s + v.ty }; },
  cellAt(x, y) { const c = window.__game.renderer.cellAt(x, y); return c ? {r:c.r, c:c.c} : null; },
  // 找一个「还没开、且屏幕坐标落在棋盘可视区里」的格子。
  // 不能写死 (2,2)：A3 那次点击会连锁开掉一大片，写死的格子很可能已经开了，
  // 而右键点在已开格上按设计是**关菜单**，于是长按用例会假红。
  closedCell() { const R = window.__game.renderer, L = R.L, b = R.board, vp = R.boardViewport();
      for (let r = 0; r < b.rows(); ++r) for (let c = 0; c < b.cols(); ++c) {
          if (b.at(r, c).opened) continue;
          const p = P.screenOf(r, c);
          if (p.x > vp.x + 8 && p.x < vp.x + vp.w - 8 && p.y > vp.y + 8 && p.y < vp.y + vp.h - 8)
              return { r, c, x: p.x, y: p.y };
      }
      return null; },
  counts() { return window.__game.renderer.board.counts(); },
  cell(r, c) { return window.__game.renderer.board.at(r, c); },
  dims() { const b = window.__game.renderer.board; return { cols: b.cols(), rows: b.rows() }; },
  hover() { const h = window.__game.renderer.hoveredCell(); return h ? {r:h.r,c:h.c} : null; },
  menu() { const R = window.__game.renderer; if (!R.menuIsOpen()) return null;
      const r = R.menuRect(); return { x:r.x, y:r.y, w:r.w, h:r.h, itemH:R.menuItemHeight() }; },
  focused() { const a = document.activeElement; return a ? (a.id || a.tagName) : 'none'; },
  setup() { const r = window.__game.renderer.setupRects();
      return JSON.parse(JSON.stringify({ panel:r.panel, startBtn:r.startBtn, cancelBtn:r.cancelBtn,
          splitBtn:r.splitBtn, realTrack:r.realTrack, imagTrack:r.imagTrack, rows:r.rows })); },
  openSetup() { window.__game.openCustomPanel(); },
  setupCfg() { const c = window.__game.renderer.setupCfg_; return c ? {rows:c.rows, cols:c.cols, total:c.total} : null; },
  hardBtn() { const L = window.__game.renderer.L, b = L.hardBtn;
      return { x: L.sideX + b.x + b.w/2, y: L.headerTop + b.y + b.h/2 }; },
  hdr(x, y) { return window.__game.renderer.headerActionAt(x, y); },
  // 在页面上挂捕获期监听：用来区分「触摸没送到页面」和「送到了但状态机吞了」。
  watch() { window.__log = [];
      if (!window.__watching) { window.__watching = true;
          for (const t of ['pointerdown', 'pointerup', 'pointercancel'])
              window.addEventListener(t, e => window.__log.push(
                  t + '@' + Math.round(e.clientX) + ',' + Math.round(e.clientY)
                  + ':' + e.pointerType + ':' + (e.target.id || e.target.tagName)), true); }
      return true; },
  log() { return window.__log || []; },
  // 画布在视口里的实际位置：CDP 的 touch 坐标是视口坐标，而 onLeftPress 收的是
  // canvas 本地坐标，两者不一致（滚动/缩放/DPR）时点击就会"落在别处"。
  crect() { const c = document.getElementById('board'), r = c.getBoundingClientRect();
      return { x:r.x, y:r.y, w:r.width, h:r.height, cw:c.width, ch:c.height,
               sx:window.scrollX, sy:window.scrollY, dpr:window.devicePixelRatio,
               iw:window.innerWidth, ih:window.innerHeight,
               vis:document.visibilityState, focus:document.hasFocus() }; },
  // 触点状态机快照：私有字段在运行时就是普通属性，直接读。
  // 留着它是因为「测试里少抬了一根手指」会让后面**所有**点击都被当成捏合，
  // 症状是"某个按钮点不动"，跟真 bug 长得一模一样，不看这个快照根本分不出来。
  tstate() { const g = window.__game, R = g.renderer;
      return { fingers: g.tp_.size, mode: g.tMode_, pinch: g.tPinch_.active,
               consumed: g.tConsumed_, longPress: g.tLongTimer_ !== null,
               setupOpen: R.setupOpen_, confirmOpen: R.confirmOpen_, menuOpen: R.menuIsOpen(),
               firstOpened: g.firstOpened_, phase: g.phase_ }; },
};
true`;

/** 抬手后触点状态机必须回到干净状态；不干净就说明测试自己漏了 touchEnd（会污染后续用例） */
async function hands(tag) {
    const s = await evalJs(`P.tstate()`);
    check(`${tag} 触点已收干净（无残留手指）`, s.fingers === 0 && !s.pinch && s.mode === 'none',
        JSON.stringify(s));
    return s;
}

// BISECT_AFTER=A9 node test/touch-gestures.mjs
// 在指定用例之后立刻切到 iPad 尺寸试点一下，用来定位「哪个手势让后续文档收不到触摸」。
const BISECT = process.env.BISECT_AFTER || '';
async function bisectProbe(tag) {
    if (BISECT !== tag) return;
    const before = await evalJs(`P.log()`);
    console.log(`\n[BISECT ${tag}] 切换前页面共收到 ${before.length} 个指针事件，末尾 6 条：`
        + JSON.stringify(before.slice(-6)));
    // 先在**同一文档**里点一下顶栏：用来区分"手势之后触摸就已经死了"
    // 和"换设备/导航才把它弄死"——这两种原因修法完全不同。
    const hb0 = await evalJs(`P.hardBtn()`);
    await tap(hb0.x, hb0.y);
    const sameDoc = await evalJs(`P.log()`);
    console.log(`[BISECT ${tag}] 同文档内点击：新增 ${sameDoc.length - before.length} 条 `
        + JSON.stringify(sameDoc.slice(-2)) + ` dims=${JSON.stringify(await evalJs(`P.dims()`))}`);
    await device(820, 1180, true, 2);
    await evalJs(PROBE);
    await evalJs(`P.watch()`);
    const hb = await evalJs(`P.hardBtn()`);
    await tap(hb.x, hb.y);
    console.log(`\n[BISECT after ${tag}] 页面收到=${JSON.stringify(await evalJs(`P.log()`))}`
        + ` dims=${JSON.stringify(await evalJs(`P.dims()`))}`
        + ` → ${((await evalJs(`P.log()`)).length ? '✅ 触摸正常' : '❌ 触摸已被吞')}`);
    process.exit(0);
}

// ================================================================
console.log('\n—— A. iPhone 竖屏 390×730（触摸）——');
await device(390, 730, true, 3);
await evalJs(PROBE);
await evalJs(`P.watch()`);

{
    const L = await evalJs(`P.lay()`), vp = await evalJs(`P.vp()`);
    check('A1 探测为 coarse pointer（触摸布局生效）', await evalJs(`P.coarse()`) === true);
    check('A2 顶部对齐：headerTop=0 且棋盘紧贴顶栏',
        L.headerTop === 0 && Math.abs(L.boardY - (L.headerTop + L.headerH + 12)) < 0.5,
        `headerTop=${L.headerTop} boardY=${L.boardY} 期望=${L.headerTop + L.headerH + 12}`);
    check('A2b 画布等于视口（背景铺满的前提）', L.winW === 390 && L.winH === 730, `${L.winW}×${L.winH}`);
    console.log(`   布局：cell=${L.cell} 棋盘=${L.boardW}×${L.boardH} 可视区=${vp.w}×${vp.h}`);
}

// A3/A4：单击开格，且不弹软键盘、不留悬停
{
    const before = await evalJs(`P.counts()`);
    const p = await evalJs(`P.screenOf(8, 8)`);
    await tap(p.x, p.y);
    const after = await evalJs(`P.counts()`);
    check('A3 单指轻点 → 开格', after.openedSafe > before.openedSafe,
        `openedSafe ${before.openedSafe} → ${after.openedSafe}`);
    check('A3b 轻点棋盘不聚焦 #kb（不弹软键盘）', await evalJs(`P.focused()`) !== 'kb',
        `activeElement=${await evalJs('P.focused()')}`);
    check('A4 抬手后无粘滞悬停高亮', await evalJs(`P.hover()`) === null,
        JSON.stringify(await evalJs(`P.hover()`)));
    await bisectProbe('A4');
}

// A5/A6/A7：长按 = 右键标记菜单
{
    const before = await evalJs(`P.counts()`);
    const t = await evalJs(`P.closedCell()`);
    if (!t) { check('A5 长按 600ms → 标记菜单打开', false, '找不到未开的格子，无法继续'); }
    const p = t || { r: -1, c: -1, x: -100, y: -100 };
    await longPress(p.x, p.y, 600);
    const menu = await evalJs(`P.menu()`);
    const after = await evalJs(`P.counts()`);
    check('A5 长按 600ms → 标记菜单打开', menu !== null,
        `格 (${p.r},${p.c}) → ` + JSON.stringify(menu));
    if (menu === null) {
        console.log('     A5 现场：点=' + JSON.stringify(p)
            + ' cellAt=' + JSON.stringify(await evalJs(`P.cellAt(${p.x}, ${p.y})`))
            + ' state=' + JSON.stringify(await evalJs(`P.tstate()`))
            + ' canvas=' + JSON.stringify(await evalJs(`P.crect()`))
            + ' 指针事件=' + JSON.stringify(await evalJs(`P.log()`)));
    }
    check('A6 长按那一格没有被顺带开掉', after.openedSafe === before.openedSafe,
        `openedSafe ${before.openedSafe} → ${after.openedSafe}`);
    check('A6b 长按后 activeElement 仍不是 #kb', await evalJs(`P.focused()`) !== 'kb');
    if (menu && menu.x !== undefined) {
        // 菜单第 2 项 = −1（menuOptions_ 顺序 +1,−1,+i,−i,无）；menuItemAt 按 (py-y)/itemH 取整
        const itemY = menu.y + menu.itemH * 1 + menu.itemH / 2;
        await tap(menu.x + menu.w / 2, itemY);
        const c = await evalJs(`P.cell(${p.r}, ${p.c})`);
        check('A7 点菜单项 → 该格落上 −1 标记', c.flag === 2, `flag=${c.flag}（2=MineType.Minus1）`);
        check('A7b 菜单已关闭', await evalJs(`P.menu()`) === null);
    } else {
        check('A7 点菜单项 → 该格落上 −1 标记', false, '菜单未打开，无法继续');
    }
    await hands('A7');
    await bisectProbe('A7');
}

// A7c：长按期间手指微抖（漂移 15px，介于旧阈值 10 与新阈值 20 之间）
// → 长按不该被误当平移取消，菜单仍要弹出来。真拇指按住常抖超 10px，
//   这是 iOS「长按不弹菜单」的诱因之一，专门加一条守住放宽后的 20px 阈值。
{
    const t = await evalJs(`P.closedCell()`);
    if (!t) { check('A7c 长按+15px 漂移 → 菜单仍打开', false, '找不到未开的格子，无法继续'); }
    else {
        const id = nextTouchId++;
        await touchStart([{ x: t.x, y: t.y, id }]);
        await sleep(60);
        await touchMove([{ x: t.x + 15, y: t.y, id }]);   // 15px < 20px 阈值，长按应存活
        await sleep(500);                                    // > armLongPress 的 450ms
        const menu = await evalJs(`P.menu()`);
        check('A7c 长按+15px 漂移 → 菜单仍打开', menu !== null,
            `格 (${t.r},${t.c}) → ` + JSON.stringify(menu));
        await touchEnd([{ x: t.x + 15, y: t.y, id }]);
        await sleep(150);
        if (menu !== null) await evalJs(`window.__game.renderer.closeMenu()`);   // 收尾，别把菜单留给后续用例
    }
    await hands('A7c');
    await bisectProbe('A7c');
}

// A8：滑动取消点击（防误触）
{
    const before = await evalJs(`P.counts()`);
    const p = await evalJs(`P.screenOf(12, 4)`);
    const id = nextTouchId++;
    await touchStart([{ x: p.x, y: p.y, id }]);
    await sleep(60);
    await touchMove([{ x: p.x + 24, y: p.y + 18, id }]);
    await sleep(60);
    await touchEnd([{ x: p.x + 24, y: p.y + 18, id }]);
    await sleep(150);
    const after = await evalJs(`P.counts()`);
    check('A8 按下后滑动 30px 再抬手 → 不开格', after.openedSafe === before.openedSafe,
        `openedSafe ${before.openedSafe} → ${after.openedSafe}`);
    await hands('A8');
    await bisectProbe('A8');
}

// A9~A12：捏合缩放 / 平移 / 复位
{
    const c0 = await evalJs(`P.screenOf(8, 8)`);
    const a = { x: c0.x - 40, y: c0.y, id: nextTouchId++ };
    const b = { x: c0.x + 40, y: c0.y, id: nextTouchId++ };
    await touchStart([a]);
    await touchStart([a, b]);
    await sleep(50);
    // 张开到 3 倍间距
    const a2 = { x: c0.x - 120, y: c0.y, id: a.id }, b2 = { x: c0.x + 120, y: c0.y, id: b.id };
    for (let i = 1; i <= 4; ++i) {
        await touchMove([{ x: a.x + (a2.x - a.x) * i / 4, y: a.y, id: a.id },
                         { x: b.x + (b2.x - b.x) * i / 4, y: b.y, id: b.id }]);
        await sleep(30);
    }
    // 必须把两根手指都抬掉：漏了这一步 tp_ 里会留两根"幽灵手指"，
    // 之后每次 tap 都因 tp_.size>=2 被当成捏合，症状是"按钮点不动"，跟真 bug 一模一样。
    await touchEnd([a2, b2]);
    await sleep(150);
    const v = await evalJs(`P.view()`);
    check('A9 双指张开 → 棋盘放大', v.s > 1.5, `scale=${v.s.toFixed(2)}`);
    await hands('A9');
    await bisectProbe('A9');

    // A10：放大后 cellAt 的逆变换必须与绘制用同一套公式
    const probe = await evalJs(`(() => {
      const out = [];
      for (const [r, c] of [[0,0],[3,7],[8,8],[15,15],[11,2]]) {
        const s = P.screenOf(r, c);
        const hit = P.cellAt(s.x, s.y);
        out.push({ r, c, hit });
      }
      return out;
    })()`);
    const bad = probe.filter(p => !p.hit || p.hit.r !== p.r || p.hit.c !== p.c);
    check('A10 放大后 cellAt 与绘制同坐标（5 格全中）', bad.length === 0,
        bad.length ? '错位: ' + JSON.stringify(bad) : probe.length + ' 格全部命中');

    // A11：单指拖动 = 平移，且不许露白
    const before = await evalJs(`P.view()`);
    const mid = await evalJs(`P.screenOf(8, 8)`);
    const pid = nextTouchId++;
    await touchStart([{ x: mid.x, y: mid.y, id: pid }]);
    for (let i = 1; i <= 4; ++i) {
        await touchMove([{ x: mid.x - 25 * i, y: mid.y - 20 * i, id: pid }]);
        await sleep(25);
    }
    await touchEnd([{ x: mid.x - 100, y: mid.y - 80, id: pid }]);
    await sleep(150);
    const after = await evalJs(`P.view()`);
    const moved = Math.abs(after.tx - before.tx) > 5 || Math.abs(after.ty - before.ty) > 5;
    check('A11 放大后单指拖动 → 平移生效', moved,
        `tx ${before.tx.toFixed(1)}→${after.tx.toFixed(1)}  ty ${before.ty.toFixed(1)}→${after.ty.toFixed(1)}`);

    const cover = await evalJs(`(() => {
      const L = P.lay(), v = P.view(), vp = P.vp();
      const axis = (w0, size, s, t, vps, vpsize) => {
        const a = w0*s + t, b = a + size*s;
        if (size*s <= vpsize + 0.5) return true;              // 比可视区小 → 允许留白（居中）
        return a <= vps + 0.5 && b >= vps + vpsize - 0.5;      // 比可视区大 → 两端都不许露白
      };
      return { x: axis(L.boardX, L.boardW, v.s, v.tx, vp.x, vp.w),
               y: axis(L.boardY, L.boardH, v.s, v.ty, vp.y, vp.h) };
    })()`);
    check('A11b 平移被钳制：放大后棋盘盖满可视区（不露白边）', cover.x && cover.y, JSON.stringify(cover));
    await hands('A11');
    await bisectProbe('A11');

    // A12：双指轻点（不捏不移）→ 复位
    const p1 = { x: 120, y: 400, id: nextTouchId++ }, p2 = { x: 260, y: 500, id: nextTouchId++ };
    await touchStart([p1]);
    await touchStart([p1, p2]);
    await sleep(60);
    await touchEnd([p1, p2]);
    await sleep(200);
    const v2 = await evalJs(`P.view()`);
    check('A12 双指轻点 → 视图复位', v2.s === 1 && v2.tx === 0 && v2.ty === 0, JSON.stringify(v2));
    await hands('A12');
    await bisectProbe('A12');
}

// A13/A14：CUSTOM 面板（U15 溢出）
{
    await evalJs(`P.openSetup()`);
    await sleep(150);
    // 先确认面板真开了：setupRects() 是纯几何计算，面板没开也照样返回一堆矩形，
    // 于是 A13 会"通过"而 A14 的点击其实落在棋盘上 —— 必须显式断言 setupOpen_。
    const st0 = await evalJs(`P.tstate()`);
    check('A13pre CUSTOM 面板确实处于打开状态', st0.setupOpen === true, JSON.stringify(st0));
    const r = await evalJs(`P.setup()`);
    if (!r || !r.panel) {
        check('A13 CUSTOM 面板矩形可读', false, 'setupRects 不可用');
    } else {
        const P_ = r.panel;
        const boxes = [];
        for (const row of r.rows) for (const k of ['label', 'minus5', 'minus', 'value', 'plus', 'plus5'])
            boxes.push([k, row[k]]);
        for (const k of ['splitBtn', 'startBtn', 'cancelBtn']) boxes.push([k, r[k]]);
        const out = boxes.filter(([, b]) => b.x < P_.x - 0.5 || b.x + b.w > P_.x + P_.w + 0.5
            || b.y < P_.y - 0.5 || b.y + b.h > P_.y + P_.h + 0.5);
        check('A13 CUSTOM 面板所有控件都在框内（390 宽，修 U15）', out.length === 0,
            out.length ? '溢出: ' + out.map(o => o[0] + '@' + Math.round(o[1].x) + '+' + Math.round(o[1].w)).join(', ')
                       : `${boxes.length} 个控件，面板 ${P_.w}×${P_.h}`);
        const overlap = [];
        for (const row of r.rows) {
            const s = [row.minus5, row.minus, row.value, row.plus, row.plus5];
            for (let i = 1; i < s.length; ++i)
                if (s[i - 1].x + s[i - 1].w > s[i].x + 0.5) overlap.push(i);
        }
        check('A13b 每行五个控件互不重叠', overlap.length === 0, JSON.stringify(overlap));
        check('A13c 面板没有高出视口', P_.y >= 0 && P_.y + P_.h <= 730, `y=${P_.y} h=${P_.h}`);

        // A14：点 ROWS 的 + 按钮
        const cfg0 = await evalJs(`P.setupCfg()`);
        const plus = r.rows[0].plus;
        await tap(plus.x + plus.w / 2, plus.y + plus.h / 2);
        const cfg1 = await evalJs(`P.setupCfg()`);
        const okA14 = !!(cfg1 && cfg0 && cfg1.rows === cfg0.rows + 1);
        check('A14 触摸点 ROWS 的「+」→ 值 +1', okA14,
            `${cfg0 && cfg0.rows} → ${cfg1 && cfg1.rows}`);
        if (!okA14) {   // 失败时把状态机打出来，免得下轮再靠猜
            console.log('     A14 现场：plus=' + JSON.stringify(plus)
                + ' cfg0=' + JSON.stringify(cfg0) + ' cfg1=' + JSON.stringify(cfg1)
                + ' state=' + JSON.stringify(await evalJs(`P.tstate()`)));
        }
        await hands('A14');
    await bisectProbe('A14');
    }
}

// ================================================================
console.log('\n—— B. iPad 820×1180（触摸）——');
await device(820, 1180, true, 2);
await evalJs(PROBE);
{
    // 切到高级 24×16：点顶栏 HARD 按钮（页面刚重载，还没开过格 → 不会弹二次确认）
    const hb = await evalJs(`P.hardBtn()`);
    const dims0 = await evalJs(`P.dims()`);
    const st0 = await evalJs(`P.tstate()`);
    await evalJs(`P.watch()`);
    await tap(hb.x, hb.y);
    await sleep(300);
    const L = await evalJs(`P.lay()`);
    const dims = await evalJs(`P.dims()`);
    const okB1 = dims.cols === 24 && dims.rows === 16;
    check('B1 触摸点 HARD → 切到高级 24×16（与桌面端 kDiffs 一致）', okB1,
        `${dims.cols}×${dims.rows} cell=${L.cell}`);
    if (!okB1) {
        console.log('     B1 现场：hb=' + JSON.stringify(hb) + ' dims ' + JSON.stringify(dims0)
            + '→' + JSON.stringify(dims) + ' 点前=' + JSON.stringify(st0)
            + ' 点后=' + JSON.stringify(await evalJs(`P.tstate()`))
            + '\n     headerActionAt(hb)=' + await evalJs(`P.hdr(${hb.x}, ${hb.y})`)
            + ' canvas=' + JSON.stringify(await evalJs(`P.crect()`))
            + '\n     页面收到的指针事件=' + JSON.stringify(await evalJs(`P.log()`)));
    }
    console.log(`   高级盘在 iPad 竖屏：cell=${L.cell}px 棋盘=${L.boardW}×${L.boardH}`);

    const c0 = await evalJs(`P.screenOf(8, 15)`);
    const a = { x: c0.x - 60, y: c0.y, id: nextTouchId++ }, b = { x: c0.x + 60, y: c0.y, id: nextTouchId++ };
    await touchStart([a]); await touchStart([a, b]); await sleep(50);
    for (let i = 1; i <= 4; ++i) {
        await touchMove([{ x: a.x - 45 * i, y: a.y, id: a.id }, { x: b.x + 45 * i, y: b.y, id: b.id }]);
        await sleep(30);
    }
    await touchEnd([{ x: a.x - 180, y: a.y, id: a.id }, { x: b.x + 180, y: b.y, id: b.id }]);
    await sleep(200);
    const v = await evalJs(`P.view()`);
    // 必须同时要求"真的放大了"：cell=40 时 `cell*s>=40` 在 s=1 也成立，
    // 上一轮就是靠这个假绿掩盖了"整组触摸没送进页面"。
    check('B1b 高级盘捏合后放大且有效格子 ≥ 40px（手指可点）', v.s > 1.5 && L.cell * v.s >= 40,
        `cell=${L.cell} × scale=${v.s.toFixed(2)} = ${(L.cell * v.s).toFixed(1)}px`);
    await hands('B1b');
}
{
    await device(820, 1180, true, 2);
    await evalJs(PROBE);
    await evalJs(`P.openSetup()`);
    await sleep(150);
    const r = await evalJs(`P.setup()`);
    const row0 = r.rows[0];
    check('B2 宽面板（≥392）沿用桌面端一行布局：minus5 偏移 206',
        row0.minus5.x - r.panel.x === 206 && row0.value.w === 62,
        `minus5Δx=${row0.minus5.x - r.panel.x} value.w=${row0.value.w}`);
}

// ================================================================
console.log('\n—— C. 桌面 1440×900（鼠标，回归）——');
await device(1440, 900, false, 1);
await evalJs(PROBE);
{
    const L = await evalJs(`P.lay()`);
    check('C1 非 coarse：布局仍居中（headerTop>0）', await evalJs(`P.coarse()`) === false && L.headerTop > 0,
        `headerTop=${L.headerTop}`);
    const v = await evalJs(`P.view()`);
    check('C2 视图变换恒等（桌面端绘制路径未变）', v.s === 1 && v.tx === 0 && v.ty === 0, JSON.stringify(v));
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 500, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 500, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
    const c = await evalJs(`P.counts()`);
    check('C3 鼠标左键仍能开格', c.openedSafe > 0, `openedSafe=${c.openedSafe}`);
    check('C3b 鼠标点击后焦点仍在 #kb（快捷键不失效）', await evalJs(`P.focused()`) === 'kb',
        `activeElement=${await evalJs('P.focused()')}`);
}

console.log(`\n════ 通过 ${pass.length} 项，失败 ${fail.length} 项 ════`);
if (pageErrors.length) console.log(`页面抛过 ${pageErrors.length} 次未捕获异常（见上方 💥）`);
if (fail.length) { console.log('失败项：\n  - ' + fail.join('\n  - ')); process.exit(1); }
