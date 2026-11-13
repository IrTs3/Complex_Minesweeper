// 裁剪器交互测试（真在浏览器里拖，验证「正方形 / 最小边长 / 不越界」）。
//
// 为什么单独一个脚本、不进 test_gate_ui.py：那个是纯 Python、不需要浏览器；
// 这个必须真跑一遍 DOM 事件（合成事件复现不了 pointer capture 与 CSP 行为）。
//
// 前置：
//   1) python3 tools/gate_ui.py --port 8791 --state <临时目录>
//      ★ 那个 state 目录里**必须**先用 gate_manager.py 跑过一次 init，
//        否则界面只显示「本地还没有密码表」，整个状态区都不渲染，
//        连「网页背景」入口都没有，什么都测不到。
//   2) 把访问钥匙写进 /tmp/ui-tok
//   3) 起 headless Edge（路径按本机实际情况）：
//        "Microsoft Edge" --headless=new --no-sandbox --disable-gpu \
//          --remote-debugging-port=9333 --user-data-dir=/tmp/edge-crop about:blank
//   4) node tools/test_crop_cdp.mjs
//
// ★ 脚本会 mock /api/webbg：沙箱不让我们读 ~/.ssh/known_hosts，真实 SSH 必失败，
//   而 reachable=false 时「网页背景」入口不渲染 —— 不 mock 就永远测不到裁剪器。
import { setTimeout as sleep } from 'node:timers/promises';
import { readFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9333;
const BASE = process.env.CMSUI || 'http://127.0.0.1:8791';
const TOK = readFileSync('/tmp/ui-tok', 'utf8').trim();
const IMG = process.env.TEST_IMG
    || `${process.env.HOME}/.cmsgate/uploads/bg-EfyhGNcXvsm_.png`;

let ws, msgId = 0;
const pending = new Map();
function send(method, params = {}) {
    return new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
    });
}
async function evaluate(expr) {
    const r = await send('Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
        throw new Error('JS 异常: ' + (r.exceptionDetails.exception?.description
            || r.exceptionDetails.text));
    }
    return r.result?.value;
}
const ok = [], bad = [];
function chk(name, cond, extra) {
    (cond ? ok : bad).push(name);
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { res, rej } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
    }
};
await send('Page.enable');
await send('Runtime.enable');

// mock /api/webbg（只拦状态查询，放行上传与图片本体）
await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      const _f = window.fetch;
      window.fetch = async function (u, o) {
        const s = String(u && u.url ? u.url : u);
        if (s.startsWith('/api/webbg') && !s.includes('_upload') && !s.includes('_image')) {
          return new Response(JSON.stringify({ ok: true, data: {
            reachable: true, mode: 'on', drifted: false, can_restore: true,
            web_root: '/srv/complexminesweeper',
          }}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return _f.apply(this, arguments);
      };
    `,
});

await send('Page.navigate', { url: `${BASE}/?k=${TOK}` });
await sleep(3000);
chk('页面加载完成', await evaluate(`!!document.querySelector('#entries-body')`));

// 点「网页背景」
const clicked = await evaluate(`
  (() => {
    const el = [...document.querySelectorAll('span.chip')]
      .find(e => (e.textContent || '').startsWith('网页背景'));
    if (!el) return 'no-chip';
    el.click();
    return 'ok';
  })()`);
chk('找到并点击「网页背景」', clicked === 'ok', String(clicked));
await sleep(1000);
chk('对话框打开', await evaluate(`document.getElementById('dlg')?.open === true`));

// 塞文件
const b64 = readFileSync(IMG).toString('base64');
const setFile = await evaluate(`
  (async () => {
    const inp = document.querySelector('#dlg-body input[type=file]');
    if (!inp) return 'no-input';
    const r = await _fetchData();
    const dt = new DataTransfer();
    dt.items.add(new File([r], 'bg.png', { type: 'image/png' }));
    inp.files = dt.files;
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
    async function _fetchData() {
      const bin = atob('${b64}');
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      return new Blob([u8], { type: 'image/png' });
    }
  })()`);
chk('选中图片', setFile === 'ok', String(setFile));
await sleep(500);

const tgt = await evaluate(`
  (() => {
    const box = document.querySelector('.tgt-pick');
    if (!box) return 'no-tgt-pick';
    const n = box.querySelectorAll('input[type=checkbox]').length;
    return n + ' | ' + box.innerText.replace(/\\s+/g, ' ').trim();
  })()`);
console.log(`  勾选项：${tgt}`);
chk('★ 只剩两个复选框（桌面端 + 网页端），不再分 mac / win',
    tgt.startsWith('2 |') && tgt.includes('桌面端'), tgt);

// 点推送 → 裁剪器
const pushClicked = await evaluate(`
  (() => {
    const b = [...document.querySelectorAll('#dlg-body button')]
      .find(x => /推送并启用/.test(x.textContent || ''));
    if (!b) return 'no-btn';
    if (b.disabled) return 'disabled';
    b.click();
    return 'ok';
  })()`);
chk('点「推送并启用」', pushClicked === 'ok', String(pushClicked));
await sleep(1500);
chk('★ 勾了桌面端 → 强制弹出裁剪器', await evaluate(`document.getElementById('crop-dlg')?.open === true`));

const geom = () => evaluate(`
  (() => {
    const b = document.getElementById('crop-box');
    const img = document.getElementById('crop-img');
    const bb = b.getBoundingClientRect();
    const ib = img.getBoundingClientRect();
    return {
      dw: Math.round(bb.width), dh: Math.round(bb.height),
      offL: Math.round(bb.left - ib.left), offT: Math.round(bb.top - ib.top),
      sizeOrig: Number(b.dataset.size),
      xOrig: Number(b.dataset.x),
      yOrig: Number(b.dataset.y),
      imgW: Number(b.dataset.imgW), imgH: Number(b.dataset.imgH),
      stageW: document.getElementById('crop-stage').clientWidth,
      boxH: document.getElementById('crop-stage').clientHeight,
    };
  })()`);

const g0 = await geom();
console.log(`\n  初始：${g0.sizeOrig}² @ (${g0.xOrig},${g0.yOrig})  显示 ${g0.dw}×${g0.dh}  缩略图 ${g0.imgW}×${g0.imgH}`);
chk('框是正方形', Math.abs(g0.dw - g0.dh) <= 1, `${g0.dw}×${g0.dh}`);
chk('初始边长 ≥ 256', g0.sizeOrig >= 256, `${g0.sizeOrig}`);

// 拖动内部
const c = await evaluate(`(() => { const r = document.getElementById('crop-box').getBoundingClientRect();
  return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x + 50, y: c.y + 25, button: 'left' });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x + 50, y: c.y + 25, button: 'left', clickCount: 1 });
await sleep(300);
const g1 = await geom();
chk('拖动改位置', g1.xOrig !== g0.xOrig || g1.yOrig !== g0.yOrig,
    `(${g0.xOrig},${g0.yOrig}) → (${g1.xOrig},${g1.yOrig})`);
chk('拖动不改尺寸', Math.abs(g1.sizeOrig - g0.sizeOrig) <= 1, `${g0.sizeOrig} → ${g1.sizeOrig}`);

// 右下角狂缩
const se = await evaluate(`(() => { const h = document.querySelector('.crop-hd[data-h="se"]');
  const r = h.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: se.x, y: se.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: se.x - 1200, y: se.y - 1200, button: 'left' });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: se.x - 1200, y: se.y - 1200, button: 'left', clickCount: 1 });
await sleep(300);
const g2 = await geom();
chk('★ 缩到极限卡在 256 原图像素', g2.sizeOrig === 256, `${g2.sizeOrig}`);
chk('★ 极限缩小仍是正方形', Math.abs(g2.dw - g2.dh) <= 1, `${g2.dw}×${g2.dh}`);
chk('★ 极限缩小不越左/上边界', g2.xOrig >= 0 && g2.yOrig >= 0, `(${g2.xOrig},${g2.yOrig})`);

// 左上角狂放
const nw = await evaluate(`(() => { const h = document.querySelector('.crop-hd[data-h="nw"]');
  const r = h.getBoundingClientRect(); return { x: r.left + r.width/2, y: r.top + r.height/2 }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: nw.x, y: nw.y, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: nw.x - 4000, y: nw.y - 4000, button: 'left' });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: nw.x - 4000, y: nw.y - 4000, button: 'left', clickCount: 1 });
await sleep(300);
const g3 = await geom();
chk('★ 放大不超出原图', g3.xOrig >= 0 && g3.yOrig >= 0
    && g3.xOrig + g3.sizeOrig <= g3.imgW + 1
    && g3.yOrig + g3.sizeOrig <= g3.imgH + 1,
    `x=${g3.xOrig} + ${g3.sizeOrig} ≤ ${g3.imgW}`);
chk('★ 放大后仍正方形', Math.abs(g3.dw - g3.dh) <= 1, `${g3.dw}×${g3.dh}`);

// 预览
const prev = await evaluate(`(() => {
  const e = document.getElementById('crop-prev-256');
  const bg = getComputedStyle(e).backgroundImage || '';
  return { ok: bg.startsWith('url("data:image/png'), n: bg.length };
})()`);
chk('右侧 256 预览已绘制', prev.ok, `background-image ${prev.n} 字符`);

// 取消
await evaluate(`document.getElementById('crop-cancel').click()`);
await sleep(600);
chk('取消关掉裁剪器', !(await evaluate(`document.getElementById('crop-dlg')?.open === true`)));
chk('★ 取消后没有继续上传/推送（不该偷偷改线上）',
    !(await evaluate(`document.getElementById('page-prog')?.hidden === false`)));

console.log(`\n通过 ${ok.length} 项，失败 ${bad.length} 项`);
if (bad.length) console.log('失败:\n  ' + bad.join('\n  '));
ws.close();
process.exit(bad.length ? 1 : 0);
