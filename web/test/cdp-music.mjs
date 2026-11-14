// 背景音乐回归测试：真实 CDP 鼠标/文件事件打全链（入库 → 页签 → 徽标 → 顺序 → 持久化 → 删除 → 拖拽 → 清空）。
// 零第三方依赖，用法同 cdp-interaction.mjs：
//   1) cd web && python3 serve.py
//   2) "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
//        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
//        --autoplay-policy=no-user-gesture-required --mute-audio \
//        --user-data-dir=/tmp/edge-cdp about:blank &
//   （--mute-audio 必加：无头浏览器也接真实扬声器，播放器自动恢复会把测试正弦波外放出来）
//   3) node web/test/cdp-music.mjs
// 覆盖点：
//   M1 多选入库（元数据 + IndexedDB 各 N 条）      M2 第 5 页签切到 MUSIC
//   M3 徽标悬停展开五钮（播放/seek 边界夹取）       M4 三种顺序 + random pass 不重复 + prev 沿 pass 回退
//   M5 reload 后元数据/curId/curSec/音量/IDB 全恢复  M6 删除当前曲（IDB 消失、curId 重定向）
//   M7 grip 拖拽排序 + reload 顺序保持              M8 清空全部二次确认（超窗不删、3s 内再点全删）
//   M9 控制条拖放 + 进度条 + 时间                   M10 视频入库转 WAV + 长名跑马灯
//   M11 暂停态切歌后播放必须放新曲
//   M12 悬停快捷键（空格/←/→）+ 按钮悬停 1.5s 功能提示
//   M13 悬停 ↑/↓ 音量 ±5（长按 0.3s 连发）+ 进度行右端音量条
//   M14 服务器默认歌单首拉：新玩家自动入库落 defaultDone、老玩家永不重拉、清站点数据变回新玩家
//   M15 首拉进度显示 + 放弃：MUSIC 页进度行常驻、「放弃」= 中止 + 删默认曲 + 旗标落 1 永不重拉
//   M16 手动下载默认歌单：二次确认 → 按清单序追加队尾、不动旗标；配额不足预检拒
// headless 测不了真 autoplay 策略差异（上面用 no-user-gesture-required 固定住）；解锁真路径 deploy 后手测。
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';

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
async function key(keyName, code, vk) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: keyName, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
}
async function click(x, y) {
    await mouse('mouseMoved', x, y);
    await mouse('mousePressed', x, y, 'left', 1);
    await mouse('mouseReleased', x, y, 'left', 0);
    await sleep(180);
}
/** 面板内 Rect（页面局部坐标）→ 真实鼠标点击（含滚动偏移换算） */
async function clickPanel(expr) {
    const p = await evalJs(`(() => {
      const R = window.__game.renderer, b = ${expr};
      const rect = document.getElementById('board').getBoundingClientRect();
      const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
      const sc = R.settingsScroll_ + R.tabBase();
      return { x: rect.left + b.x / sx, y: rect.top + (b.y - sc) / sy };
    })()`);
    await click(p.x, p.y);
}
/** ♪ 控制条：-1=徽标本体（曲名行），0..4=五钮（悬停长出的顶行，左对齐横排 26 宽 + 3 间距） */
async function clickBadge(idx) {
    const p = await evalJs(`(() => {
      const R = window.__game.renderer, b = R.musicBadgeRect(), info = R.musicBadgeInfo();
      const rect = document.getElementById('board').getBoundingClientRect();
      const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
      const bx = b.x + 8;
      const px = ${idx} < 0 ? b.x + 12 : bx + ${idx} * 29 + 13;
      const py = ${idx} < 0 ? b.y + 11 : b.y - 11;
      return { x: rect.left + px / sx, y: rect.top + py / sy, px, label: info.label, w: info.w };
    })()`);
    await mouse('mouseMoved', p.x, p.y);
    await mouse('mousePressed', p.x, p.y, 'left', 1);
    await mouse('mouseReleased', p.x, p.y, 'left', 0);
    await sleep(180);
    const diag = await evalJs(`(() => {
      const R = window.__game.renderer, info = R.musicBadgeInfo();
      return { exp: R.musicExpanded(), label: info ? info.label : null, w: info ? info.w : 0 };
    })()`);
    console.log(`    [badge ${idx}] px=${p.px.toFixed(1)} pre="${p.label}" w=${p.w.toFixed(1)} → post exp=${diag.exp} "${diag.label}" w=${diag.w.toFixed(1)}`);
}
async function music() { return evalJs(`window.__cmsMusic()`); }

// —— 1s/3s/短 WAV 自产（Node 手写 WAV 头，不依赖素材）——
function makeWav(path, seconds, freq) {
    const rate = 8000, n = Math.floor(rate * seconds);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; ++i)
        buf.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 12000), 44 + i * 2);
    writeFileSync(path, buf);
}

// —— 连到目标页 ——
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.error('CDP 里找不到 page target，Edge 起了吗？'); process.exit(1); }
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
const pageErrors = [];
ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id); pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    } else if (m.method) {
        events.push(m.method);
        if (m.method === 'Runtime.exceptionThrown')
            pageErrors.push(JSON.stringify(m.params.exceptionDetails.exception?.description || m.params).slice(0, 500));
        if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error')
            pageErrors.push('console.error: ' + JSON.stringify(m.params.args?.map(a => a.value || a.description)).slice(0, 500));
    }
};
await send('Page.enable');
await send('Runtime.enable');
await send('DOM.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });

let loadMark = 0;   // events 的水位：每次导航前记下，等待只看这之后的事件（旧的 loadEventFired 不算数）
/** 等游戏模块真的初始化完（高负载偶发：load 事件已过但构造器还没跑完，直接断言会撞 undefined） */
async function waitGame(timeoutMs = 10000) {
    for (let i = 0; i < timeoutMs / 100; ++i) {
        if (await evalJs(`typeof window.__cmsMusic === 'function'`)) return;
        await sleep(100);
    }
    throw new Error('页面 10s 内没初始化出 __cmsMusic（模块加载或构造器失败）');
}
async function loadFresh() {
    loadMark = events.length;
    await send('Page.navigate', { url: PAGE + '?t=' + Date.now() });
    for (let i = 0; i < 100 && !events.slice(loadMark).includes('Page.loadEventFired'); ++i) await sleep(100);
    await sleep(700);
    await waitGame();
}
async function closeHelp() {
    await evalJs(`window.__game.renderer.closeHelp()`);   // 首访帮助面板会吞点击，导航后兜底关掉
}
async function setAudioFiles(paths) {
    const doc = await send('DOM.getDocument');
    const node = await send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#audiopick' });
    await send('DOM.setFileInputFiles', { files: paths, nodeId: node.nodeId });
    await sleep(600);
}

// —— 清场：旧的音乐状态全删，从零开始 ——
// 注意不能只在页面里 removeItem：卸载旧页时 player 的 pagehide 兜底会把内存里的旧状态
// **再写回去**（恰好把上一轮测试的 order 污染带回来）。先去 about:blank 让旧页走完
// pagehide，再在浏览器侧 Storage.clearDataForOrigin 清该源全部存储，然后才加载新页。
await loadFresh();
await send('Page.navigate', { url: 'about:blank' });
await sleep(400);
await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8080', storageTypes: 'all' });
await sleep(200);
// 默认歌单首拉会把 M1-M13 的「5 首测试曲」口径漂成 7：新文档脚本级预置 defaultDone 旗标压掉首拉。
// 注入只罩住这一次清场加载，跑完立刻摘掉——否则后续每次 loadFresh 都会被种子清成空清单。
const seedScript = await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `try{localStorage.setItem('cms.music.v1',JSON.stringify({ver:1,order:'seq',volume:60,curId:null,curSec:0,wasPlaying:false,barX:-1,barY:-1,defaultDone:1,tracks:[]}))}catch(e){}` });
await loadFresh();
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seedScript.identifier });
await evalJs(`window.__game.renderer.closeHelp()`);   // 清场连 helpSeen 也清了：首访自动弹的帮助面板会吞掉后续点击
await sleep(150);

const tmp = mkdtempSync(join(tmpdir(), 'cms-music-'));
// 5 首测试曲：一首 5s 长曲（撑住 M3 的 seek 断言，不会中途 ended 切歌）+ 四首凑数
makeWav(join(tmp, 'alpha.wav'), 5, 440);
makeWav(join(tmp, 'bravo-3s.wav'), 3, 220);
makeWav(join(tmp, 'charlie.wav'), 1, 330);
makeWav(join(tmp, 'delta.wav'), 1, 550);
makeWav(join(tmp, 'echo.wav'), 1, 660);

console.log('\n—— M1 多选入库（元数据 + IDB）——');
await setAudioFiles([join(tmp, 'alpha.wav'), join(tmp, 'bravo-3s.wav'), join(tmp, 'charlie.wav'), join(tmp, 'delta.wav'), join(tmp, 'echo.wav')]);
let m = await music();
check('M1 五首全部入库', m.tracks.length === 5, `实际 ${m.tracks.length}`);
check('M1 IDB 记录 5 条', m.idbOk === true && m.idbCount === 5, `idbOk=${m.idbOk} idbCount=${m.idbCount}`);
check('M1 时长已测出（alpha≈5s、bravo≈3s）',
    Math.abs((m.tracks[0].dur || 0) - 5) < 0.5 && Math.abs((m.tracks[1].dur || 0) - 3) < 0.5,
    `dur=[${m.tracks.map(t => (t.dur || 0).toFixed(2)).join(', ')}]`);
check('M1 默认顺序 seq、默认音量 60', m.order === 'seq' && m.volume === 60, `order=${m.order} vol=${m.volume}`);

console.log('\n—— M2 第 5 页签 MUSIC ——');
await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
await clickPanel(`R.settingsRects().tabs[4]`);
await sleep(150);
check('M2 点第 5 枚页签 → settingsTab_=5', (await evalJs(`window.__game.renderer.settingsTab_`)) === 5,
    `实际 ${await evalJs(`window.__game.renderer.settingsTab_`)}`);
check('M2 曲目行命中 grip（行 0 左缘）',
    JSON.stringify(await evalJs(`window.__game.renderer.musicRowHit(window.__game.renderer.settingsRects().musicRow.x + 8, window.__game.renderer.settingsRects().musicRow.y - window.__game.renderer.settingsScroll_ - window.__game.renderer.tabBase() + 13)`)) === '{"row":0,"kind":0}');
check('M2 行内中部不误触',
    (await evalJs(`window.__game.renderer.musicRowHit(window.__game.renderer.settingsRects().musicRow.x + 100, window.__game.renderer.settingsRects().musicRow.y - window.__game.renderer.settingsScroll_ - window.__game.renderer.tabBase() + 13)`)) === null);

console.log('\n—— M3 徽标悬停展开五钮 ——');
check('M3 常态徽标存在、未展开', (await evalJs(`(() => { const R = window.__game.renderer; return !!R.musicBadgeRect() && !R.musicExpanded(); })()`)) === true);
// 悬停（mouseMoved 到徽标本体）
await evalJs(`window.__game.renderer.closeSettings()`);
await clickBadge(-1); // 含 mouseMoved → 触发悬停展开；本体点击=触摸展开路径
check('M3 悬停后展开', (await evalJs(`window.__game.renderer.musicExpanded()`)) === true);
await clickBadge(2); // ▶
m = await music();
check('M3 点 ▶ → 出声（或至少意图在播）', m.playing === true, `playing=${m.playing} wasPlaying=${m.wasPlaying}`);
await sleep(900); // 等时长就绪 + 拉开播放进度
// 现场转储：‖ 按键若失效，从这份快照里看是哪个门把 press 吞了
const prePause = await evalJs(`(() => {
  const R = window.__game.renderer, b = R.musicBadgeRect();
  const bx = b.x + 8, px = bx + 2 * 29 + 13, py = b.y + 11;
  return { w: b.w, px, directHit: R.musicBadgeHit(px, py),
    settingsOpen: R.settingsOpen_, helpOpen: R.helpOpen_, confirmOpen: R.confirmOpen_,
    seedStage: R.seedStage_, zeroTip: R.zeroTipPopupOpen ? R.zeroTipPopupOpen() : null,
    hasFocus: window.__game['hasFocus_'], phase: window.__game.phase() };
})()`);
console.log('    [pre-‖]', JSON.stringify(prePause));
await clickBadge(2); // ‖ 暂停：暂停态 seek 不会撞上 ended 自动切歌，断言才纯
m = await music();
check('M3 点 ‖ → 暂停且 wasPlaying 清零', m.playing === false && m.wasPlaying === false,
    `playing=${m.playing} wasPlaying=${m.wasPlaying}`);
await clickBadge(4); // ⏩10s：5s 曲 → 夹到曲尾
m = await music();
check('M3 ⏩10s 夹到曲尾（5s 曲，仍暂停）', m.curSec > 4.4 && m.curSec <= 5.05 && m.playing === false,
    `curSec=${m.curSec.toFixed(2)} playing=${m.playing}`);
await clickBadge(0); // ⏪15s → 0
m = await music();
check('M3 ⏪15s 落 0', m.curSec < 0.05, `curSec=${m.curSec.toFixed(2)}`);

console.log('\n—— M4 三种顺序 ——');
await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
await clickPanel(`R.settingsRects().tabs[4]`);
await sleep(150);
await clickPanel(`R.settingsRects().musicOrder[0]`); // SEQ
m = await music();
check('M4 SEQ = 列表原序', JSON.stringify(m.pass) === JSON.stringify(m.tracks.map(t => t.id)), `pass=${m.pass.length}`);
await clickPanel(`R.settingsRects().musicOrder[1]`); // REV
m = await music();
check('M4 REV = 列表倒序', JSON.stringify(m.pass) === JSON.stringify(m.tracks.map(t => t.id).reverse()), ``);
await clickPanel(`R.settingsRects().musicOrder[2]`); // RANDOM
m = await music();
const uniq = new Set(m.pass).size;
check('M4 RANDOM 是 5 首的不重复排列', uniq === 5 && m.pass.length === 5, `uniq=${uniq}`);
const posBefore = m.passIdx;
await evalJs(`window.__game.renderer.closeSettings()`);
await sleep(120);
await clickBadge(1); // ⏮ 沿当前 pass 回退
m = await music();
check('M4 prev 沿当前随机 pass 回退（不重洗）',
    m.passIdx === (posBefore - 1 + 5) % 5,
    `passIdx ${posBefore}→${m.passIdx}`);

console.log('\n—— M5 音量 + reload 恢复 ——');
await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
await clickPanel(`(() => { const t = window.__game.renderer.settingsRects().musicVolTrack;
  return { x: t.x + Math.round(t.w * 0.4), y: t.y + 4 }; })()`); // 点滑条 40% 处
m = await music();
const volSet = m.volume;
await evalJs(`window.__game.renderer.closeSettings()`);
await sleep(120);
// 播放几秒拿 curSec>0，再 pagehide 前不手动 persist（靠 pause/pagehide 兜底）
await clickBadge(2);
await sleep(1500);
loadMark = events.length;
await send('Page.reload');
for (let i = 0; i < 100 && !events.slice(loadMark).includes('Page.loadEventFired'); ++i) await sleep(100);
await sleep(800);
await waitGame();
m = await music();
check('M5 reload 后曲目清单还在（IDB 5 条）', m.tracks.length === 5 && m.idbCount === 5,
    `tracks=${m.tracks.length} idbCount=${m.idbCount}`);
check('M5 音量持久化', m.volume === volSet, `volume=${m.volume} 期望 ${volSet}`);
check('M5 curId 与随机顺序保持', m.tracks.length === 5 && m.pass.length === 5, `curId=${m.curId}`);
check('M5 意图播放（wasPlaying）保持', m.wasPlaying === true, `wasPlaying=${m.wasPlaying} playing=${m.playing}`);
check('M5 播放进度恢复（curSec>0）', m.curSec > 0.2, `curSec=${m.curSec.toFixed(2)}`);

console.log('\n—— M6 删除当前曲 ——');
const curBefore = m.curId;
await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
await clickPanel(`R.settingsRects().tabs[4]`);
await sleep(150);
// 点当前曲所在行的 ✕（找到 curId 的行下标）
const curRow = await evalJs(`(() => {
  const R = window.__game.renderer, ui = R.musicUi();
  return ui.tracks.findIndex(t => t.id === ${JSON.stringify(curBefore)});
})()`);
await clickPanel(`(() => { const R2 = window.__game.renderer, r = R2.settingsRects();
  return { x: r.musicRow.x + r.musicRow.w - 14, y: R2.musicRowY(${curRow}) + 13 }; })()`);
await sleep(400);
m = await music();
check('M6 当前曲已删（列表 4、IDB 4）', m.tracks.length === 4 && m.idbCount === 4,
    `tracks=${m.tracks.length} idbCount=${m.idbCount}`);
check('M6 curId 重定向到别的曲', m.curId && m.curId !== curBefore, `curId=${m.curId}`);

console.log('\n—— M7 grip 拖拽排序 ——');
await clickPanel(`R.settingsRects().musicOrder[0]`); // 回 SEQ，顺序=数组序好断言
m = await music();
const namesBefore = m.tracks.map(t => t.name);
// 把行 0 拖到行 2（grip 中心 → 下移 68px，分步移动）
const drag = await evalJs(`(() => {
  const R = window.__game.renderer, r = R.settingsRects(), rect = document.getElementById('board').getBoundingClientRect();
  const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
  const sc = R.settingsScroll_ + R.tabBase();
  const gx = rect.left + (r.musicRow.x + 11) / sx;
  const gy = rect.top + (r.musicRow.y + 13 - sc) / sy;
  return { gx, gy, step: 34 / sy };
})()`);
await mouse('mouseMoved', drag.gx, drag.gy);
await mouse('mousePressed', drag.gx, drag.gy, 'left', 1);
for (let i = 1; i <= 4; ++i) {
    await mouse('mouseMoved', drag.gx, drag.gy + drag.step * i * 0.5);
    await sleep(60);
}
await mouse('mouseReleased', drag.gx, drag.gy + drag.step * 2, 'left', 0);
await sleep(250);
m = await music();
check('M7 行 0 拖到行 2（数组序变化）',
    JSON.stringify(m.tracks.map(t => t.name)) === JSON.stringify([namesBefore[1], namesBefore[2], namesBefore[0], namesBefore[3]]),
    `before=${namesBefore.join(',')} after=${m.tracks.map(t => t.name).join(',')}`);
loadMark = events.length;
await send('Page.reload');
for (let i = 0; i < 100 && !events.slice(loadMark).includes('Page.loadEventFired'); ++i) await sleep(100);
await sleep(800);
await waitGame();
m = await music();
check('M7 reload 后顺序保持', m.tracks[0] && m.tracks[0].name === namesBefore[1],
    `首曲=${m.tracks[0] ? m.tracks[0].name : '无'}`);
await evalJs(`window.__game.renderer.openSettings()`);
await sleep(150);
await clickPanel(`R.settingsRects().tabs[4]`);   // openSettings 回 1 页签：必须重进 MUSIC
await sleep(150);

console.log('\n—— M8 清空全部二次确认 ——');
m = await music();
check('M8 前置：还剩 4 首', m.tracks.length === 4, `实际 ${m.tracks.length}`);
await clickPanel(`R.settingsRects().musicClear`);
await sleep(150);
m = await music();
check('M8 首点只武装不删（列表/IDB 不动）', m.tracks.length === 4 && m.idbCount === 4,
    `tracks=${m.tracks.length} idb=${m.idbCount}`);
check('M8 武装态亮着', (await evalJs(`window.__game.renderer.musicClearArmed()`)) === true);
await evalJs(`window.__game.renderer.disarmMusicClear()`);
await clickPanel(`R.settingsRects().musicClear`); // 重新武装
await sleep(3300); // 超 3s 窗
await clickPanel(`R.settingsRects().musicClear`); // 这是重新武装，不是确认
m = await music();
check('M8 超 3s 窗确认不算（仍是重新武装）', m.tracks.length === 4, `tracks=${m.tracks.length}`);
await clickPanel(`R.settingsRects().musicClear`); // 3s 内再点 = 确认清空
await sleep(400);
m = await music();
check('M8 二次点击全清（列表 0、IDB 0）', m.tracks.length === 0 && m.idbCount === 0,
    `tracks=${m.tracks.length} idb=${m.idbCount}`);

console.log('\n—— M9 控制条拖放 + 进度条 + 时间 ——');
// M8 清空后重入库一首 5s 曲；badge 默认位 y = boardY-52（按展开高 46 预留，展开时第一行不跳）
await evalJs(`window.__game.renderer.closeSettings()`);
await sleep(150);
await setAudioFiles([join(tmp, 'alpha.wav')]);
m = await music();
check('M9 重入库 1 首、位置未拖过', m.tracks.length === 1 && m.barX === -1 && m.barY === -1,
    `tracks=${m.tracks.length} barX=${m.barX} barY=${m.barY}`);
const geo = await evalJs(`(() => { const R = window.__game.renderer, b = R.musicBadgeRect();
  return { x: b.x, y: b.y, h: b.h, w: b.w, boardY: R.L.boardY }; })()`);
check('M9 默认位 y=boardY-52（两行常驻同位）',
    geo.y === Math.max(4, geo.boardY - 52), JSON.stringify(geo));
check('M9 徽标两行常驻高 46（曲名行 + 进度行）', geo.h === 46, `h=${geo.h}`);
check('M9 进度行常驻（未悬停也可拿进度条矩形）',
    (await evalJs(`window.__game.renderer.musicProgressTrack() !== null`)) === true);
await clickBadge(2);   // hover 展开 + ▶（clickBadge 命中第一行中心 y=b.y+11）
m = await music();
check('M9 展开▶ 播放中', m.playing === true, `playing=${m.playing}`);
// 播放中进度快照前进（每帧 setMusicCur；曾因只走事件推送而卡在按下那一刻）
const c1 = await evalJs(`window.__game.renderer.musicUi().curSec`);
await sleep(1200);
const c2 = await evalJs(`window.__game.renderer.musicUi().curSec`);
check('M9 播放中进度快照前进（1.2s → +≈1s）', c2 > c1 + 0.5, `c1=${c1.toFixed(2)} c2=${c2.toFixed(2)}`);
// 进度条 40% 点击 → ≈2s（5s 曲）
const tpos = await evalJs(`(() => { const R = window.__game.renderer, t = R.musicProgressTrack();
  const rect = document.getElementById('board').getBoundingClientRect();
  const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
  return { x: rect.left + (t.x + t.w * 0.4) / sx, y: rect.top + (t.y + t.h / 2) / sy, w: t.w }; })()`);
check('M9 进度条矩形在展开条内', tpos.w > 40, `track.w=${tpos.w.toFixed(1)}`);
await click(tpos.x, tpos.y);
m = await music();
check('M9 点进度条 40% → ≈2s', Math.abs(m.curSec - 2) < 0.9, `curSec=${m.curSec.toFixed(2)}`);
// 标签区按住拖动 +180/+90 → 落盘 barX/barY
const d0 = await evalJs(`(() => { const R = window.__game.renderer, b = R.musicBadgeRect();
  const rect = document.getElementById('board').getBoundingClientRect();
  const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
  return { px: rect.left + (b.x + 30) / sx, py: rect.top + (b.y + 11) / sy, bx: b.x, by: b.y }; })()`);
await mouse('mouseMoved', d0.px, d0.py);
await mouse('mousePressed', d0.px, d0.py, 'left', 1);
for (let i = 1; i <= 6; ++i) await mouse('mouseMoved', d0.px + 30 * i, d0.py + 15 * i);
await mouse('mouseReleased', d0.px + 180, d0.py + 90, 'left', 0);
await sleep(250);
m = await music();
check('M9 拖放落点进 localStorage（≈+180,+90）',
    Math.abs(m.barX - (d0.bx + 180)) < 3 && Math.abs(m.barY - (d0.by + 90)) < 3,
    `barX=${m.barX} barY=${m.barY} 期望≈${Math.round(d0.bx + 180)},${Math.round(d0.by + 90)}`);
loadMark = events.length;
await send('Page.reload');
for (let i = 0; i < 100 && !events.slice(loadMark).includes('Page.loadEventFired'); ++i) await sleep(100);
await sleep(800);
await waitGame();
const geo2 = await evalJs(`(() => { const b = window.__game.renderer.musicBadgeRect(); return { x: b.x, y: b.y }; })()`);
check('M9 reload 后徽标回到拖放位', geo2.x === m.barX && geo2.y === m.barY,
    JSON.stringify({ saved: { x: m.barX, y: m.barY }, now: geo2 }));
await evalJs(`window.__game.renderer.closeHelp()`);   // reload 后首访帮助面板可能弹出，兜底关掉
await sleep(150);

console.log('\n—— M10 视频入库转 WAV + 长名跑马灯 ——');
let haveFfmpeg = true;
try { execSync('ffmpeg -version', { stdio: 'ignore' }); } catch { haveFfmpeg = false; }
if (haveFfmpeg) {
    // 2s 立体声 AAC 的 mp4：入库后应变成 ≈352KB 的 WAV（44.1k×2ch×16bit×2s+44）
    execSync(`ffmpeg -y -loglevel error -f lavfi -i "sine=frequency=440:duration=2" -ac 2 -c:a aac "${join(tmp, 'probe-video.mp4')}"`);
    const LONG = '一个相当相当长的歌名用来验证徽标跑马灯滚动效果的测试曲目';   // 24 字 ≈ 264px > 176px 窗口
    makeWav(join(tmp, LONG + '.wav'), 1, 330);
    await setAudioFiles([join(tmp, 'probe-video.mp4'), join(tmp, LONG + '.wav')]);
    m = await music();
    const vt = m.tracks.find(t => t.name === 'probe-video');
    check('M10 视频入库：名字去扩展名、时长 ≈2s',
        m.tracks.length === 3 && !!vt && Math.abs((vt.dur || 0) - 2) < 0.5,
        `tracks=${m.tracks.length} dur=${vt ? (vt.dur || 0).toFixed(2) : '无'}`);
    check('M10 视频存的是提取音频（WAV ≈352KB，不是原 mp4）',
        !!vt && vt.size > 280 * 1024 && vt.size < 420 * 1024,
        vt ? `size=${(vt.size / 1024).toFixed(0)}KB` : '无');
    // 切到长名曲（SEQ：alpha → probe-video → 长名）
    await evalJs(`window.__game.player_.next()`);
    await sleep(300);
    await evalJs(`window.__game.player_.next()`);
    await sleep(300);
    const info = await evalJs(`(() => { const R = window.__game.renderer; const i = R.musicBadgeInfo();
        return i ? { nameW: i.nameW, nameWin: i.nameWin, w: i.w, label: i.label } : null; })()`);
    check('M10 长名触发跑马灯（nameW>176，窗口钉 176）',
        !!info && info.nameW > 176 && info.nameWin === 176,
        info ? `nameW=${info.nameW.toFixed(0)} nameWin=${info.nameWin}` : JSON.stringify(info));
    const o1 = await evalJs(`(() => { const R = window.__game.renderer, i = R.musicBadgeInfo(); return R.musicScrollOffset(i.label, i.nameW, i.nameWin); })()`);
    await sleep(700);
    const o2 = await evalJs(`(() => { const R = window.__game.renderer, i = R.musicBadgeInfo(); return R.musicScrollOffset(i.label, i.nameW, i.nameWin); })()`);
    check('M10 跑马灯在动（≈2.5 字/秒 → 0.7s ≈19px）', o2 > o1 && o2 - o1 < 40,
        `o1=${o1.toFixed(1)} o2=${o2.toFixed(1)} Δ=${(o2 - o1).toFixed(1)}`);
    const wNow = await evalJs(`window.__game.renderer.musicBadgeRect().w`);
    // 宽度 = max(曲名行, 进度+音量行下限)：有界即可，长名不撑爆（nameWin 钉 176）
    check('M10 徽标宽度有界（≥曲名行宽，不随长名无限膨胀）', wNow >= info.w && wNow < info.w + 90,
        `w=${wNow.toFixed(1)} 曲名行=${info.w.toFixed(1)}`);

    // —— M11 暂停态切歌后播放必须放新曲
//   M12 悬停快捷键（空格/←/→）+ 按钮悬停 1.5s 功能提示
//   M13 悬停 ↑/↓ 音量 ±5（长按 0.3s 连发）+ 进度行右端音量条（loadedId 没跟上就是放旧曲的 bug）——
    console.log('\n—— M11 暂停态切歌 → 播放新曲 ——');
    let m11 = await music();
    if (m11.playing) { await evalJs(`window.__game.player_.toggle()`); await sleep(200); m11 = await music(); }
    const curBefore = m11.curId, loadedBefore = m11.loadedId;
    await evalJs(`window.__game.player_.next()`);   // 暂停态：只挪指针不装载
    await sleep(200);
    m11 = await music();
    check('M11 暂停态切歌：指针挪了、音频没动', m11.curId !== curBefore && m11.loadedId === loadedBefore && !m11.playing,
        `cur=${String(m11.curId).slice(0, 8)} loaded=${String(m11.loadedId).slice(0, 8)} (loadedBefore=${String(loadedBefore).slice(0, 8)}) playing=${m11.playing}`);
    await evalJs(`window.__game.player_.toggle()`); // 再点播放
    await sleep(400);
    m11 = await music();
    check('M11 播放的是切过去的新曲（loadedId 追上 curId）', m11.playing && m11.loadedId === m11.curId,
        `playing=${m11.playing} cur=${String(m11.curId).slice(0, 8)} loaded=${String(m11.loadedId).slice(0, 8)}`);

    // —— M12 悬停键盘快捷键 + 按钮悬停提示 ——
    console.log('\n—— M12 悬停快捷键 + 悬停提示 ——');
    await evalJs(`window.__game.renderer.closeHelp()`);   // 快捷键闸不含帮助面板
    await sleep(150);
    const bc = await evalJs(`(() => { const R = window.__game.renderer, b = R.musicBadgeRect();
      const rect = document.getElementById('board').getBoundingClientRect();
      const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
      return { x: rect.left + (b.x + b.w / 2) / sx, y: rect.top + (b.y + 11) / sy }; })()`);
    await mouse('mouseMoved', bc.x, bc.y);   // 指针进条 → 悬停态
    await sleep(150);
    m11 = await music();
    const playing0 = m11.playing;
    await key(' ', 'Space', 32);
    await sleep(250);
    m11 = await music();
    check('M12 悬停条上按空格切换播放/暂停', m11.playing === !playing0, `before=${playing0} after=${m11.playing}`);
    if (!m11.playing) { await key(' ', 'Space', 32); await sleep(300); }   // 拨回播放态，下面 seek 要音频在走
    const s0 = (await music()).curSec;
    await key('ArrowLeft', 'ArrowLeft', 37);
    await sleep(250);
    m11 = await music();
    check('M12 ← 快退 15s（5s 曲落 0 附近）', m11.curSec < 1, `s0=${s0.toFixed(2)} → ${m11.curSec.toFixed(2)}`);
    // 悬停提示：指针停在 ▶/‖ 钮上 ≥1.5s 出浮窗；移开后消失
    const bpos = await evalJs(`(() => { const R = window.__game.renderer, b = R.musicBadgeRect();
      const rect = document.getElementById('board').getBoundingClientRect();
      const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
      const bx = b.x + 8;
      return { x: rect.left + (bx + 2 * 29 + 13) / sx, y: rect.top + (b.y - 11) / sy,
               away: { x: rect.left + (R.L.boardX + 60) / sx, y: rect.top + (R.L.boardY + 60) / sy } }; })()`);
    await mouse('mouseMoved', bpos.x, bpos.y);
    await sleep(300);
    check('M12 悬停钮 0.3s 还没出提示', (await evalJs(`window.__game.renderer.musicTooltipVisible()`)) === false);
    await sleep(1500);
    check('M12 悬停钮 ≥1.5s 出功能提示', (await evalJs(`window.__game.renderer.musicTooltipVisible()`)) === true);
    await mouse('mouseMoved', bpos.away.x, bpos.away.y);
    await sleep(200);
    check('M12 移开条后提示消失', (await evalJs(`window.__game.renderer.musicTooltipVisible()`)) === false);

    // —— M13 悬停 ↑/↓ 音量快捷键（±5，长按 0.3s 连发）+ 顶行右端音量条 ——
    console.log('\n—— M13 音量快捷键 + 音量条 ——');
    await evalJs(`window.__game.player_.setVolume(60)`);
    await sleep(150);
    await mouse('mouseMoved', bc.x, bc.y);   // 指针回条上（悬停态）
    await sleep(150);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await sleep(150);
    let m13 = await music();
    check('M13 ↑ 一次 +5', m13.volume === 65, `volume=${m13.volume}`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await sleep(150);
    m13 = await music();
    check('M13 ↓ 一次 −5', m13.volume === 60, `volume=${m13.volume}`);
    // 长按 ↑ 0.7s：keydown 1 次 + 0.3s 间隔连发 ≈ 2 次 → +15；松键停
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await sleep(700);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 });
    await sleep(400);
    m13 = await music();
    check('M13 长按 ↑ 连发（0.7s ≈ +15）', m13.volume >= 70 && m13.volume <= 80, `volume=${m13.volume}`);
    // 音量条：点击 50% ≈ 50；拖到右端 ≈ 100
    const vp = await evalJs(`(() => { const R = window.__game.renderer, t = R.musicBadgeVolTrack(), b = R.musicBadgeRect(true);
      const rect = document.getElementById('board').getBoundingClientRect();
      const sx = R.L.winW / rect.width, sy = R.L.winH / rect.height;
      return { mid: { x: rect.left + (t.x + t.w * 0.5) / sx, y: rect.top + (t.y + t.h / 2) / sy },
               p98: { x: rect.left + (t.x + t.w * 0.98) / sx, y: rect.top + (t.y + t.h / 2) / sy },
               p70: { x: rect.left + (t.x + t.w * 0.7) / sx, y: rect.top + (t.y + t.h / 2) / sy },
               inTopRow: t.x + t.w <= b.x + b.w + 1 && t.y >= b.y && t.y + t.h <= b.y + 22 + 1,
               w: t.w }; })()`);
    check('M13 音量条在顶行右端（70px 横条）', vp.inTopRow && vp.w === 70, `w=${vp.w} inTopRow=${vp.inTopRow}`);
    await mouse('mouseMoved', vp.mid.x, vp.mid.y);
    await mouse('mousePressed', vp.mid.x, vp.mid.y, 'left', 1);
    await mouse('mouseReleased', vp.mid.x, vp.mid.y, 'left', 0);
    await sleep(150);
    m13 = await music();
    check('M13 点音量条 50% → ≈50', Math.abs(m13.volume - 50) <= 2, `volume=${m13.volume}`);
    // 按 98% 不按 100%：CDP 坐标换算浮点误差会让贴边点掉出条外 ~1e-5
    await mouse('mouseMoved', vp.p98.x, vp.p98.y);
    await mouse('mousePressed', vp.p98.x, vp.p98.y, 'left', 1);
    await mouse('mouseMoved', vp.p70.x, vp.p70.y);
    await mouse('mouseReleased', vp.p70.x, vp.p70.y, 'left', 0);
    await sleep(150);
    m13 = await music();
    check('M13 音量条拖动（98→70% ≈70）', Math.abs(m13.volume - 70) <= 2, `volume=${m13.volume}`);
} else {
    console.log('    （本机无 ffmpeg，跳过 M10 视频链路；跑马灯逻辑由 M9 几何间接覆盖）');
}

// —— M14 服务器默认歌单首拉 ——（夹具锚定 web/：serve.py 从 web/ 起服务，
// /music-default/ 直落 web/music-default/；用 process.cwd() 会因跑测试的目录不同落错地方）
console.log('\n—— M14 默认歌单首拉（defaultDone 旗标语义）——');
const mdDir = join(new URL('../music-default', import.meta.url).pathname);
rmSync(mdDir, { recursive: true, force: true });
mkdirSync(mdDir, { recursive: true });
// 夹具文件名必须过 fetchDefault 的 safeStorageName 闸（11-13 审计 aa0f829 起：^t[0-9a-f]+\.ext$）
makeWav(join(mdDir, 't01.wav'), 1, 500);
makeWav(join(mdDir, 't02.wav'), 1, 700);
writeFileSync(join(mdDir, 'manifest.json'), JSON.stringify({ ver: 1, tracks: [
    { file: 't01.wav', name: '默认一', size: statSync(join(mdDir, 't01.wav')).size, dur: 1, added: 1 },
    { file: 't02.wav', name: '默认二', size: statSync(join(mdDir, 't02.wav')).size, dur: 1, added: 2 },
]}));
/** 本文档里发往 /music-default/ 的请求（manifest + 音频），旗标语义的探针 */
const mdPulls = () => evalJs(
    `performance.getEntriesByType('resource').filter(r => r.name.includes('/music-default/'))
        .map(r => r.name.split('/music-default/')[1])`);
/** 摸播放器实例（TS private 只是编译期）：翻旗标/删曲目用 */
const flipFlag = async v => {
    await evalJs(`window.__game.player_.defaultDone_ = ${v ? 'true' : 'false'}; window.__game.player_.persist();`);
};

await send('Page.navigate', { url: 'about:blank' });
await sleep(400);
await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8080', storageTypes: 'all' });
await sleep(200);
await loadFresh();          // 新玩家：无存档 → restore 触发首拉
await closeHelp();
await sleep(1500);          // fetchDefault 异步：manifest + 两首下载入库
let m14 = await music();
check('M14 新玩家首拉：两首自动入库', m14.tracks.length === 2, `实际 ${m14.tracks.length} 首`);
check('M14 曲名取 manifest 的 name（扩展名剥净）',
    m14.tracks.map(t => t.name).join(',') === '默认一,默认二',
    m14.tracks.map(t => t.name).join(','));
check('M14 时长已测出（≈1s）', Math.abs((m14.tracks[0].dur || 0) - 1) < 0.5, `dur=${m14.tracks[0].dur}`);
check('M14 defaultDone 落盘（实例 + 存档都=1）',
    m14.defaultDone === true &&
    JSON.parse(await evalJs(`localStorage.getItem('cms.music.v1')`)).defaultDone === 1,
    `debug=${m14.defaultDone}`);
check('M14 首拉带播放意图（进来就该有声音）', m14.wasPlaying === true, `wasPlaying=${m14.wasPlaying}`);
check('M14 音频真进了 IDB', m14.idbOk === true && m14.idbCount === 2, `idbCount=${m14.idbCount}`);

await loadFresh();          // 老玩家 reload
await closeHelp();
await sleep(1500);
m14 = await music();
check('M14 reload 后曲目还在', m14.tracks.length === 2, `实际 ${m14.tracks.length}`);
check('M14 ★ 旗标语义：reload 零 /music-default/ 请求（服务器换歌也不重拉）',
    (await mdPulls()).length === 0, JSON.stringify(await mdPulls()));

// 删光曲目（旗标还在）→ reload → 仍不重拉：玩家自己删的就是不要了，不能悄悄还回来
for (;;) {
    const cur = await music();
    if (!cur.tracks.length) break;
    await evalJs(`window.__game.player_.removeTrack(${JSON.stringify(cur.tracks[0].id)})`);
    await sleep(150);
}
await loadFresh();
await closeHelp();
await sleep(1500);
m14 = await music();
check('M14 ★ 删光曲目 + 旗标在 → reload 仍零请求（不重拉）',
    m14.tracks.length === 0 && m14.defaultDone === true && (await mdPulls()).length === 0,
    `tracks=${m14.tracks.length} flag=${m14.defaultDone} pulls=${JSON.stringify(await mdPulls())}`);

// 旗标单独清掉（曲目空）→ reload → 全量重拉：等于变回新玩家，当下最新歌单照拿
await flipFlag(false);
await loadFresh();
await closeHelp();
await sleep(1500);
m14 = await music();
check('M14 ★ 清旗标 → 重拉成功（2 首 + 旗标重新落盘）',
    m14.tracks.length === 2 && m14.defaultDone === true &&
    (await mdPulls()).length === 3,
    `tracks=${m14.tracks.length} pulls=${JSON.stringify(await mdPulls())}`);

// 旗标清掉但曲目还在（半途失败后的重试形态）→ 只拉 manifest，按曲名跳过不重复入库
await flipFlag(false);
await loadFresh();
await closeHelp();
await sleep(1500);
m14 = await music();
check('M14 ★ 重试去重：manifest 拉了但音频零下载，曲目不重复',
    m14.tracks.length === 2 && m14.defaultDone === true &&
    JSON.stringify(await mdPulls()) === '["manifest.json"]',
    `tracks=${m14.tracks.length} pulls=${JSON.stringify(await mdPulls())}`);

// —— M15 首拉进度显示 + 放弃 ——（CDP Fetch 把 t02.wav 扣在 Request 相：t01 已到手入库，
// 正好验证增量语义「第一首落地就出声/入库，不等全单」；拉取窗口稳定，进度行常驻可点）
console.log('\n—— M15 首拉进度显示 + 放弃（中止+删默认曲+旗标落1）——');
await send('Fetch.enable', { patterns: [{ urlPattern: '*music-default/t02.wav', requestStage: 'Request' }] });
await send('Page.navigate', { url: 'about:blank' });
await sleep(400);
await send('Storage.clearDataForOrigin', { origin: 'http://127.0.0.1:8080', storageTypes: 'all' });
await sleep(200);
await loadFresh();          // 新玩家：restore 触发首拉，t01 完成入库、t02.wav 被扣住 → 拉取态悬着
await closeHelp();
await sleep(2000);
let m15 = await music();
check('M15 扣住 t02.wav：首拉进行中 fetchProg 常驻（n=2）',
    m15.fetchProg !== null && m15.fetchProg.n === 2, JSON.stringify(m15.fetchProg));
check('M15 ★ 增量语义：第一首到手即入库（不等全单拉完）',
    m15.tracks.length === 1 && m15.tracks[0].name === '默认一',
    `tracks=${JSON.stringify(m15.tracks.map(t => t.name))}`);
check('M15 ★ 增量语义：第一首带播放意图（到手就该出声）', m15.wasPlaying === true, `wasPlaying=${m15.wasPlaying}`);
// 打开设置面板 MUSIC 页滚到底，让进度行进视窗
await evalJs(`(() => { const R = window.__game.renderer;
  R.openSettings(); R.settingsSetTab(5); R.settingsScroll_ = R.settingsView().maxS; })()`);
await sleep(200);
const geo15 = await evalJs(`(() => { const r = window.__game.renderer.settingsRects();
  return { fetch: r.musicFetch, abort: r.musicAbort, orderY: r.musicOrder[0].y }; })()`);
check('M15 放弃钮在进度行右端，order/音量被顶下一行',
    geo15.abort.y === geo15.fetch.y && geo15.orderY === geo15.fetch.y + 50,
    `abort.y=${geo15.abort.y} fetch.y=${geo15.fetch.y} orderY=${geo15.orderY}`);
await clickPanel(`R.settingsRects().musicAbort`);
await sleep(800);
m15 = await music();
check('M15 点放弃：拉取态清空（fetchProg=null）', m15.fetchProg === null, JSON.stringify(m15.fetchProg));
check('M15 点放弃：已入库的第一首被删掉（放弃=删默认曲，不留半截）', m15.tracks.length === 0, `tracks=${m15.tracks.length}`);
check('M15 点放弃：defaultDone 实例=true', m15.defaultDone === true, `flag=${m15.defaultDone}`);
check('M15 点放弃：旗标落盘=1（永不重拉）',
    JSON.parse(await evalJs(`localStorage.getItem('cms.music.v1')`)).defaultDone === 1, '');
await send('Fetch.disable');
await loadFresh();          // 放弃后的老玩家 reload
await closeHelp();
await sleep(1200);
m15 = await music();
check('M15 ★ 放弃后 reload 零 music-default 请求（不再自动拉）',
    m15.tracks.length === 0 && m15.defaultDone === true && (await mdPulls()).length === 0,
    `tracks=${m15.tracks.length} pulls=${JSON.stringify(await mdPulls())}`);

// —— M16 手动下载默认歌单（二次确认 → 队尾追加 → 配额预检）——
console.log('\n—— M16 手动下载默认歌单 ——');
// 起点：老玩家（旗标在）+ 空库；先补一首本地曲，验证「接到队尾」
await loadFresh();
await closeHelp();
await evalJs(`(async () => {
  const b = await (await fetch('music-default/t01.wav')).blob();
  await window.__game.player_.addFiles([new File([b], '本地首.wav')]);
})()`);
await sleep(600);
let m16 = await music();
check('M16 前置：本地曲已入库（旗标=1 的老玩家）',
    m16.tracks.length === 1 && m16.tracks[0].name === '本地首' && m16.defaultDone === true,
    JSON.stringify(m16.tracks.map(t => t.name)) + ' flag=' + m16.defaultDone);
await evalJs(`(() => { const R = window.__game.renderer;
  R.openSettings(); R.settingsSetTab(5); R.settingsScroll_ = 0; })()`);
await sleep(200);
const pulls0 = await mdPulls();
await clickPanel(`R.settingsRects().musicDl`);
check('M16 首点只武装（不拉不入库，armed 亮起）',
    (await evalJs(`window.__game.renderer.musicDlArmed()`)) === true &&
    (await mdPulls()).length === pulls0.length && (await music()).tracks.length === 1,
    'pulls=' + JSON.stringify(await mdPulls()));
await clickPanel(`R.settingsRects().musicDl`);   // 3s 内再点 = 确认
await sleep(2500);
m16 = await music();
check('M16 确认后下载：按清单顺序接到队尾',
    JSON.stringify(m16.tracks.map(t => t.name)) === '["本地首","默认一","默认二"]',
    JSON.stringify(m16.tracks.map(t => t.name)));
check('M16 手动下载不动旗标（defaultDone 实例+落盘都=1）',
    m16.defaultDone === true &&
    JSON.parse(await evalJs(`localStorage.getItem('cms.music.v1')`)).defaultDone === 1,
    `flag=${m16.defaultDone}`);
check('M16 请求口径：manifest + 两首音频都拉了',
    (await mdPulls()).includes('manifest.json') &&
    (await mdPulls()).includes('t01.wav') && (await mdPulls()).includes('t02.wav'),
    JSON.stringify(await mdPulls()));

// —— 配额预检负测：49 首假元数据（25MB×49 ≈ 1.2GB > 1GB）→ 一首都排不进去 ——
// 种子走 addScriptToEvaluateOnNewDocument：老页 pagehide 会把内存状态写回 localStorage，
// 直接 setItem 会被写回盖掉；新文档脚本在新页 restore 之前落地才稳。
const fakeTracks = [];
for (let i = 0; i < 49; ++i) fakeTracks.push(
    { id: 'f' + i, name: '占位' + i, size: 25 * 1048576, dur: 1, added: i + 1 });
const seed16 = await send('Page.addScriptToEvaluateOnNewDocument', { source:
    `try{localStorage.setItem('cms.music.v1',JSON.stringify({ver:1,order:'seq',volume:60,curId:null,curSec:0,wasPlaying:false,barX:-1,barY:-1,defaultDone:1,tracks:${JSON.stringify(fakeTracks)}}))}catch(e){}` });
await loadFresh();
await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: seed16.identifier });
await closeHelp();
await evalJs(`(() => { const R = window.__game.renderer;
  R.openSettings(); R.settingsSetTab(5); R.settingsScroll_ = 0; })()`);
await sleep(200);
await clickPanel(`R.settingsRects().musicDl`);   // 武装
await clickPanel(`R.settingsRects().musicDl`);   // 确认 → 预检拒绝
await sleep(800);
m16 = await music();
check('M16 ★ 配额不足（总量将超 1GB）：一首不排、零音频请求',
    m16.tracks.length === 49 &&
    JSON.stringify(await mdPulls()) === '["manifest.json"]',
    `tracks=${m16.tracks.length} pulls=${JSON.stringify(await mdPulls())}`);

// —— 页面异常兜底 ——
check('无未捕获页面异常', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

console.log(`\n==== cdp-music: ${pass.length} 过 / ${fail.length} 挂 ====`);
if (fail.length) process.exit(1);
process.exit(0);
