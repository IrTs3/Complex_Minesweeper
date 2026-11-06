// 网页版「访问闸门」专项回归测试：用 CDP 向真实浏览器派发**真实**输入事件。
//
// 与 cdp-interaction.mjs 分开的原因：那个脚本默认访问本地 `serve.py`（**无闸门**），
// 导航到 / 就期望立刻拿到游戏。若把闸门断言塞进去，既有 35 项会全部落到密码页而失败。
// 所以要覆盖闸门，就必须用「带闸门的地址」单独跑本脚本。
//
// 零第三方依赖（Node 22 自带 fetch 与 WebSocket）。
//
// 用法：
//   1) 起带调试端口的 Edge：
//      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
//        --headless=new --no-sandbox --disable-gpu --remote-debugging-port=9222 \
//        --user-data-dir=/tmp/edge-gate about:blank &
//   2) 本地验证（需先起 authd 与 serve.py --gate）：
//        GATE_TOKEN=dev0gatepath PAGE_URL=http://127.0.0.1:8081/ node web/test/cdp-gate.mjs
//        （token 要和 serve.py 那个进程用的是同一个）
//   3) 线上验证（推荐：让它自己建一条临时 key，不用交出任何真人的密码）：
//        先 `cms gate-path status` 抄下当前秘密入口的 token，再
//        CMSGATE_TOOL=$PWD/tools/gate_manager.py GATE_TOKEN=<线上token> \
//          PAGE_URL=https://ty0712.com/ node web/test/cdp-gate.mjs
//
// ⚠️ GATE_TOKEN 是**登录入口那串随机路径**（不是密码）。2026-10-19 之后 /gate/ 本身
//   对无会话者一律 404，密码页只能在 /gate/<TOKEN>/ 打开，所以本脚本必须知道 token，
//   否则 TG1/TG3/TG4/TG5/TG10 会全部落到 404 页上失败——那是配置缺参，不是闸门坏了。
//   （TG9 例外：它 POST 的是 /__login 本身，与入口路径无关。）
//
// 不设 GATE_PW / CMSGATE_TOOL 时只跑「未登录」与「无 JS 提示页」那几项（可离线自检）。
//
// 覆盖点（新模型：未登录一律「当作不存在」）：
//   TG0 未登录 /game、/index.html、/gate/gate.css、/gate/gate.js 全部 404；
//       / 按模式判（learn 302→/learn/、game 302→/game）；旧的 /gate/ 跟着兜底走
//   TG1 未登录打开秘密入口 → 密码页（含 #pw，且不含游戏 canvas；登录页星光层在画且不吃点击）
//   TG2 未登录 游戏资源必须 404（含两张背景图），不能泄漏
//   TG3 登录页要用的公开资源必须可达（两个字体 + 自身的 css/js，走秘密入口前缀）
//   TG4 错密码：留在密码页、有错误提示、拿不到会话
//   TG5 对密码：进入游戏（window.__game 就绪）
//   TG6 会话 cookie：HttpOnly、且**没有 Max-Age/Expires**（关浏览器即失效）
//   TG7 登录后游戏资源与背景图变为 200（会话 cookie 是 Path=/，覆盖 /assets）
//   TG8 未登录访问 /index.html 也是 404（不再吐密码页）
//   TG9 无 JS 的原生提交：服务端把原因**写在这一响应的正文里**（401 + text/html）
//       —— 已删除旧的 `?e=N` 跳转通道（秘密入口之外没有可落地的公开路径，/gate/ 本身 404）
//       停用/过期两条没有可复现的凭据，降级为源码级断言（tools/test_gate_ui.py 的 T55）
//   TG10 密码页脚本里确实带上了这两种新文案
//   TG11（可选，会真的改线上）临时 key 的禁用 / 重新启用 / 过期 → 会话即时失效
//
// TG11 需要能 ssh 到服务器，所以默认**不跑**。要跑就给出工具路径（会用默认 state 与服务器）：
//   CMSGATE_TOOL=$PWD/tools/gate_manager.py GATE_ADMIN_PW='...' PAGE_URL=https://ty0712.com/ \
//     node web/test/cdp-gate.mjs
// 它会自己 add 一条临时 key、用完 rm 掉（无论成败都清理）。
//
// ⚠️ GATE_ADMIN_PW 是**管理口令**（不是某条访问密码）。gate_manager 的写操作
//   （add/push/disable/enable/expire/rm…）都要它——那是 SSH 私钥之外的第二道门。
//   不给就只跑只读用例，TG11 会明确报「缺少 GATE_ADMIN_PW」而不是静默失败。
// ⚠️ 别用 GATE_ADMIN_PW 的值当 GATE_PW：前者是你自己的管理口令，后者是「能登进网站的
//   某条访问密码」。给错了 TG5 会以「密码不正确」失败，看起来像线上坏了。
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PORT = process.env.CDP_PORT || 9222;
const BASE = (process.env.PAGE_URL || 'http://127.0.0.1:8081/').replace(/\/+$/, '');
// 登录入口 = BASE + /gate/<TOKEN>/。默认值是 serve.py 的 dev token；线上必须显式给
// （`cms gate-path status` 抄）。token 只在这里拼进 URL，不打印整条路径。
const GATE_TOKEN = process.env.GATE_TOKEN || 'dev0gatepath';
const GATE_URL = `${BASE}/gate/${GATE_TOKEN}/`;
let PW = process.env.GATE_PW || '';       // 没给就自建临时 key（见下），所以是 let
let TMP_ID = null, TMP_PW = null;
const VIEW_W = 1200, VIEW_H = 1000;

const pass = [], fail = [];
let ws, nextId = 1;
const pending = new Map();
const events = [];

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
async function key(code, keyStr, vk) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code, key: keyStr, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code, key: keyStr, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(150);
}
// 回车提交要走「默认动作」，dispatchKeyEvent 必须带 text，否则浏览器不会执行表单提交。
// （踩过：不带 text 时 submit 事件根本不触发，测试误报成产品 bug。）
async function pressEnter() {
    const p = { code: 'Enter', key: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...p, text: '\r', unmodifiedText: '\r' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...p });
    await sleep(150);
}
// 真实鼠标点击某个元素（比合成事件更接近用户路径）
async function clickEl(selector) {
    const r = await evalJs(`(() => { const e = document.querySelector(${JSON.stringify(selector)});
        if (!e) return null; const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
    if (!r) throw new Error('找不到元素: ' + selector);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: r.x, y: r.y, button: 'none', buttons: 0, clickCount: 0 });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: r.x, y: r.y, button: 'left', buttons: 1, clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: r.x, y: r.y, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(200);
}
async function typePassword(text) {
    await evalJs(`(() => { const e = document.getElementById('pw'); e.value = ''; e.focus(); })()`);
    await send('Input.insertText', { text });
}
async function goto(url) {
    events.length = 0;
    await send('Page.navigate', { url });
    for (let i = 0; i < 120 && !events.includes('Page.loadEventFired'); ++i) await sleep(100);
    await sleep(800);
}

// —— 可选：直接操作服务器上的密码表（TG11 用）——
const TOOL = process.env.CMSGATE_TOOL || '';
const PY = process.env.CMSGATE_PY || 'python3';

// gate_manager 的**写操作都要管理口令**（SSH 私钥之外的第二道门）。
// 本测试会调 add / push / disable / enable / expire / rm，所以必须能脚本化喂口令，
// 否则每条都会卡在交互式 getpass 上（子进程没有 tty，直接读不到）。
//
// 做法：在 tool() 里集中处理，而不是在 10 个调用点各写一遍——
// 漏一处就会有一条静默失败，而 TG11 那些断言本来就靠「命令返回码」判断成败。
const ADMIN_PW = process.env.GATE_ADMIN_PW || '';
const WRITE_CMDS = new Set(['add', 'rm', 'disable', 'enable', 'expire', 'passwd',
                            'note', 'push', 'pull', 'revoke-all']);
function tool(args, stdin) {
    let a = args;
    let input = stdin || '';
    if (WRITE_CMDS.has(args[0])) {
        if (!ADMIN_PW) {
            return { code: 127, out: '缺少 GATE_ADMIN_PW 环境变量：写操作现在需要管理口令。' };
        }
        // 顺序：先管理口令，再调用方自己的 stdin（如 add --password-stdin 的新密码）
        a = [...args, '--admin-stdin'];
        input = ADMIN_PW + '\n' + input;
    }
    const r = spawnSync(PY, [TOOL, ...a], { input, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
// 登录后的等待时长（仅用于等页面渲染完）。
const RENDER_WAIT = Number(process.env.LOGIN_RENDER_MS || 3000);
// 两次登录尝试之间的间隔。
//
// ⚠️ 默认值只在"距上次登录 ≥ 60 秒"时可靠。本测试每轮会故意用错密码（TG4、
// TG11 的禁用/过期），那会记失败计数，连着几次就进 60 秒软锁。
// **要连跑多轮时必须给足间隔**（LOGIN_WAIT_MS=70000，或每轮之间隔几分钟），
// 否则会看到「提示尝试过于频繁」「对密码后进不去游戏」——
// **那是防爆破在正常工作，不是登录坏了**。
//
// ⚠️ 不要用"发一次错密码看回什么"来探测锁开没开：错密码本身就是失败计数 +1，
// 探测会把自己越探越锁（我写过这个版本，18 分钟只跑出 30/40）。
const LOGIN_WAIT = Number(process.env.LOGIN_WAIT_MS || 0);

/** 在下一次登录尝试前等足软锁窗口（LOGIN_WAIT 为 0 时立即返回）。 */
async function waitLoginGateOpen() {
    if (LOGIN_WAIT > 0) await sleep(LOGIN_WAIT);
}

// 在秘密入口登录，返回是否进了游戏
async function loginAs(pw) {
    await waitLoginGateOpen();
    await send('Network.clearBrowserCookies');
    await goto(GATE_URL);
    await typePassword(pw);
    await pressEnter();
    await sleep(RENDER_WAIT);
    return (await evalJs('typeof window.__game !== "undefined"')) === true;
}
// 「会话是否已失效」= 带 cookie 请求受保护的 /game，看还拿不拿得到棋盘。
// 注意这里**不能**再断言「被弹回密码页」：新模型下未登录拿到的是 404，
// 而秘密入口的对无会话者虽是密码页、对有会话者是 302→/game（auth_request +
// error_page 回落），两副面孔由服务端决定，它证明不了「这一份 cookie 还有效」。
async function bouncedToGate() {
    await goto(`${BASE}/game`);
    return (await evalJs(`!document.getElementById('board')`)) === true;
}
// 用给定密码走一遍真实登录，返回密码页上的提示文字。
// **故意不清 cookie**：这样"停用 → 重新启用后老 cookie 又能用"那条断言的前提不会被自己毁掉
// （踩过：清 cookie 之后再断言"没被弹回密码页"，必然失败——那是测试的错，不是服务端的）。
// **调用方必须先waitLoginGateOpen()**：本函数不做探测，否则"该等"的语义会散落在各处。
async function loginAttemptErr(pw) {
    await goto(GATE_URL);
    await typePassword(pw);
    await pressEnter();
    await sleep(RENDER_WAIT);
    return await evalJs(`(document.getElementById('err')||{}).textContent || ''`);
}

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
await send('Network.enable');
await send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
// headless 下必须打开焦点模拟，否则键盘/文本输入到不了页面
await send('Emulation.setFocusEmulationEnabled', { enabled: true });

console.log(`\n目标：${BASE}${PW ? '' : '   （未设 GATE_PW，只跑未登录部分）'}   ` +
    `登录入口：/gate/<${process.env.GATE_TOKEN ? 'GATE_TOKEN' : '默认 dev token'}>/`);

// 每次从「干净的浏览器」开始：清掉 cookie，才能观察未登录行为
await send('Network.clearBrowserCookies');

// ============ TG0/TG1/TG2/TG3：未登录 ============
console.log('—— TG0~TG3  未登录状态 ——');

// TG0：未登录时所有游戏路径都必须「当作不存在」。
// 用 Node 侧 fetch（不带 cookie）看服务端真实状态码，比浏览器渲染更能钉住语义。
for (const p of ['/game', '/index.html', '/gate/gate.css', '/gate/gate.js']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    check(`TG0 未登录 ${p} → 404（当作不存在）`, r.status === 404, `实际 ${r.status}`);
}
// 根路径单独判：learn 模式 302→/learn/；game 模式 302→/game（游戏本身仍要登录）。
// 旧前缀 /gate/ 跟着兜底走：learn 404、game 302→/game。两者都不许直接是 200 的游戏页。
{
    const r = await fetch(BASE + '/', { redirect: 'manual' });
    const loc = r.headers.get('location') || '';
    check('TG0 未登录 / → 302→/learn/（learn 模式）或 302→/game（game 模式）',
          r.status >= 300 && r.status < 400
          && (loc.includes('/learn/') || loc.includes('/game')),
          `实际 ${r.status}${loc ? ' → ' + loc : ''}`);
    const g = await fetch(BASE + '/gate/', { redirect: 'manual' });
    check('TG0 未登录 /gate/ → 404（learn）或 302→/game（game），没有密码页',
          g.status === 404
          || (g.status >= 300 && g.status < 400
              && (g.headers.get('location') || '').includes('/game')),
          `实际 ${g.status}`);
}

await goto(GATE_URL);

const gatePage = await evalJs(`(() => ({
  hasPwInput: !!document.getElementById('pw'),
  hasForm: !!document.getElementById('gate-form'),
  hasCanvas: !!document.getElementById('board'),
  hasFx: !!document.getElementById('fx'),
  fxPe: (() => { const e = document.getElementById('fx');
                 return e ? getComputedStyle(e).pointerEvents : 'missing'; })(),
  text: (document.body.innerText || '').slice(0, 200),
}))()`);
check('TG1 未登录打开秘密入口 → 密码页（有密码输入框）', gatePage.hasPwInput && gatePage.hasForm,
      `hasPwInput=${gatePage.hasPwInput} hasForm=${gatePage.hasForm}`);
check('TG1 密码页不含游戏 canvas（没把游戏 DOM 送出去）', gatePage.hasCanvas === false,
      `hasCanvas=${gatePage.hasCanvas}`);
check('TG1 未登录时 window.__game 不存在', (await evalJs('typeof window.__game')) === 'undefined');
// 登录页这层星光是自包含的（gate.js 里独立一份，不引闸门内的 dist/fx.js）：
// 它必须①不吃点击（否则密码框点不动）、②真的在画（否则只是块空白 canvas，测试会假绿）。
check('TG1 登录页星光层已挂上且不吃点击', gatePage.hasFx === true && gatePage.fxPe === 'none',
      `hasFx=${gatePage.hasFx} pointerEvents=${gatePage.fxPe}`);
const fxPainted = await evalJs(`(() => {
  const c = document.getElementById('fx');
  if (!c) return { ok: false, why: 'no canvas' };
  const g = c.getContext('2d');
  if (!g || !c.width || !c.height) return { ok: false, why: 'no ctx/size ' + c.width + 'x' + c.height };
  const d = g.getImageData(0, 0, c.width, c.height).data;
  let lit = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
  return { ok: lit > 0, lit };
})()`);
check('TG1 登录页星光真的画出了像素（不是空 canvas）', fxPainted.ok === true,
      JSON.stringify(fxPainted));

// TG2：用 Node 侧直接请求（不带 cookie），看服务端真实状态码
for (const p of ['/dist/main.js', '/dist/game.js', '/dist/wasm_stub.js', '/dist/fx.js',
                 '/style.css', '/assets/bg.webp', '/assets/bg.jpg']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    check(`TG2 ${p} 未登录 → 404`, r.status === 404, `实际 ${r.status}`);
}
// TG3：登录页自己需要的东西必须公开可达 —— 两个字体是全站精确公开，
// css/js 挂在秘密入口前缀下（^~ 块，不带 auth_request）。
for (const p of [`/gate/${GATE_TOKEN}/gate.css`, `/gate/${GATE_TOKEN}/gate.js`,
                 '/assets/ibmplex-ascii.woff2', '/assets/IBMPlexSerif-Regular.ttf']) {
    const r = await fetch(BASE + p, { redirect: 'manual' });
    check(`TG3 公开资源 ${p} → 200`, r.status === 200, `实际 ${r.status}`);
}

await goto(`${BASE}/index.html`);
check('TG8 未登录 /index.html 得到 404 页，而不是密码页',
      (await evalJs(`!document.getElementById('pw') && !document.getElementById('board')`)) === true);

// ============ TG4/TG5/TG6/TG7：登录流程 ============
// 没有 GATE_PW 但能操作密码表时，自建一条临时 key 来跑这些用例——
// 这样「一条命令跑完整套线上回归」成为可能，不必把某个真人的密码交出去。
if (!PW && TOOL) {
    TMP_PW = randomBytes(18).toString('base64url');
    const r = tool(['add', '--label', 'cdp-gate-tmp', '--note', '测试用，自动删除',
                    '--password-stdin'], TMP_PW);
    TMP_ID = (r.out.match(/\bid\s*:\s*([0-9a-f]{12})/) || [])[1] || null;
    if (r.code === 0 && TMP_ID) {
        tool(['push']);
        PW = TMP_PW;
        console.log(`（未设 GATE_PW：已自建临时 key id=${TMP_ID} 用于登录用例，跑完自动删除）`);
    } else {
        console.log(`（自建临时 key 失败，跳过登录用例）\n${r.out.slice(0, 200)}`);
    }
}

if (!PW) {
    console.log('\n（跳过登录相关用例：未提供 GATE_PW）');
} else {
    console.log('\n—— TG4  错误密码（点击提交按钮）——');
    await goto(GATE_URL);
    await typePassword(PW + '-deliberately-wrong');
    await clickEl('button[type="submit"]');
    await sleep(2000);
    const afterBad = await evalJs(`(() => ({
      stillGate: !!document.getElementById('pw'),
      err: (document.getElementById('err') || {}).textContent || '',
      hasGame: typeof window.__game !== 'undefined',
    }))()`);
    check('TG4 错密码后仍停在密码页', afterBad.stillGate === true && afterBad.hasGame === false,
          `stillGate=${afterBad.stillGate} hasGame=${afterBad.hasGame}`);
    // 接受两种文案：密码错（401）或被节流（429）。关键是不能「静默无反应」。
    check('TG4 错密码有可见提示（密码不正确 / 尝试过于频繁）',
          afterBad.err.includes('密码不正确') || afterBad.err.includes('频繁'),
          `err="${afterBad.err}"`);
    const cookiesBad = (await send('Network.getCookies', { urls: [BASE + '/'] })).cookies;
    check('TG4 错密码不会下发会话 cookie',
          cookiesBad.filter(c => c.name === 'cmsgate').length === 0,
          `cmsgate 个数 ${cookiesBad.filter(c => c.name === 'cmsgate').length}`);

    console.log('\n—— TG5~TG7  正确密码（用回车提交，顺带验默认动作）——');
    await waitLoginGateOpen();   // TG4 刚用错密码记了一次失败，先等软锁窗口过去
    await goto(GATE_URL);
    await typePassword(PW);
    await pressEnter();
    await sleep(RENDER_WAIT);
    // 被应用层节流时要说清楚，别让它伪装成「登录坏了」
    if (await evalJs(`!!document.getElementById('pw')`)) {
        const e2 = await evalJs(`(document.getElementById('err')||{}).textContent || ''`);
        if (e2.includes('频繁')) {
            console.log('    ⚠ 本次请求被节流——**不是登录功能坏了**，是防爆破在起作用。');
            console.log('      本测试每轮故意传一次错密码，那会记失败计数；');
            console.log('      连着几次就会进 60 秒软锁。各段之间已加等待，若仍见到，');
            console.log('      说明上一轮跑得太密，等 2 分钟再跑，或调大 LOGIN_WAIT_MS。');
        }
    }

    const afterOk = await evalJs(`(() => ({
      hasGame: typeof window.__game !== 'undefined' && !!(window.__game && window.__game.renderer),
      hasCanvas: !!document.getElementById('board'),
      hasFx: !!document.getElementById('fx'),
      stillGate: !!document.getElementById('pw'),
      url: location.pathname,
    }))()`);
    check('TG5 对密码后进入游戏（window.__game 就绪）', afterOk.hasGame === true,
          `hasGame=${afterOk.hasGame} path=${afterOk.url}`);
    check('TG5 进入游戏后不再是密码页', afterOk.stillGate === false && afterOk.hasCanvas === true);
    check('TG5 特效层已挂上（#fx 存在且不吃点击）', afterOk.hasFx === true
          && (await evalJs(`getComputedStyle(document.getElementById('fx')).pointerEvents`)) === 'none');

    const cookies = (await send('Network.getCookies', { urls: [BASE + '/'] })).cookies;
    const ck = cookies.find(c => c.name === 'cmsgate');
    check('TG6 下发了会话 cookie', !!ck, ck ? `path=${ck.path}` : '没找到');
    if (ck) {
        // 会话 cookie 的特征：session=true 且 expires=-1（服务端没写 Max-Age/Expires）
        check('TG6 cookie 是会话级（无 Max-Age/Expires）',
              ck.session === true && (ck.expires === -1 || ck.expires === undefined),
              `session=${ck.session} expires=${ck.expires}`);
        check('TG6 cookie 是 HttpOnly（JS 读不到）', ck.httpOnly === true, `httpOnly=${ck.httpOnly}`);
    }
    check('TG6 document.cookie 里看不到 cmsgate（HttpOnly 生效）',
          (await evalJs(`document.cookie.indexOf('cmsgate') === -1`)) === true);

    // TG7：登录后资源可访问。用页面内的 fetch 带上 cookie（Node 侧没有浏览器 cookie）
    // 两张背景图也在这一组：它们已收进闸门，会话 cookie 是 Path=/ 覆盖 /assets/*，
    // 所以「登录后 200、匿名 404」正是这次改动的完整语义，两头都要钉。
    const postLogin = await evalJs(`(async () => {
      const out = {};
      for (const p of ['/dist/main.js', '/dist/fx.js', '/style.css', '/assets/bg.webp', '/assets/bg.jpg']) {
        const r = await fetch(p, { redirect: 'manual' });
        out[p] = r.status;
      }
      return out;
    })()`);
    for (const [p, st] of Object.entries(postLogin)) {
        check(`TG7 登录后 ${p} → 200`, st === 200, `实际 ${st}`);
    }
}

// ============ TG9/TG10：四种拒绝原因各有各的文案 ============
// TG9 只测**无 JS 的原生提交**这条降级路径：不带 X-CMSGATE 的 POST 被服务端当成表单提交，
// 它必须把原因**直接写在这一响应的正文里**。
// 为什么不像以前那样 goto('?e=N')：秘密入口之外没有任何可落地的公开路径
// （/gate/ 对无会话者已经 404），"跳回去"这条路本身就是要修掉的洞 ——
// 服务端也**不该**知道入口在哪：拼一个公开路径 302 过去等于把 token 广播出去。
// 停用/过期两条要凭据才能复现，改为源码级断言（tools/test_gate_ui.py T55 钉文案与一致性）。
// ⚠️ 这里每轮多消耗**一次错密码**额度（与 TG4 合计 2 次/轮）。nginx 的登录限流是
//    10r/m burst=5、authd 侧 THROTTLE_SOFT=8，所以连跑别超过 3~4 轮 ——
//    超了会拿到 429 而不是 401，那时 TG9 会"红得没道理"。
console.log('\n—— TG9  无 JS 提交：服务端把原因写进响应正文 ——');
{
    await goto(GATE_URL);
    const bad = await evalJs(`(async () => {
      const r = await fetch('/__login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'pw=' + encodeURIComponent('cdp-nojs-wrong-pw'),
        redirect: 'manual',
      });
      return { status: r.status,
               ctype: r.headers.get('content-type') || '',
               body: await r.text() };
    })()`);
    check('TG9 无 JS 错密码 → 401（不是 JSON、也不是把用户丢进 404 的跳转）',
          bad.status === 401, `实际 ${bad.status}`);
    check('TG9 响应体是 HTML', (bad.ctype || '').includes('text/html'),
          `content-type="${bad.ctype}"`);
    check('TG9 正文里写着「密码不正确」', bad.body.includes('密码不正确'),
          `正文前 120 字="${String(bad.body).slice(0, 120)}"`);
    // 回显提交内容＝把用户输错的那串密码写进响应体，它会留在浏览器历史与代理日志里，
    // 还平白多开一个注入面。模板只有一个 {msg} 槽，正常永远不会命中这条。
    check('TG9 正文不回显提交的密码', !String(bad.body).includes('cdp-nojs-wrong-pw'));
    check('TG9 内联页没有 <style>/style=（继承的 CSP style-src \'self\' 会静默拦掉它们）',
          !String(bad.body).includes('<style') && !String(bad.body).includes(' style='));
    check('TG9 内联页给了「后退」这条唯一出路', /后退|Back/.test(String(bad.body)),
          `正文后 120 字="${String(bad.body).slice(-120)}"`);
}
{
    const js = await (await fetch(`${GATE_URL}gate.js`)).text();
    check('TG10 密码页脚本含「已被停用」文案', js.includes('已被停用'));
    check('TG10 密码页脚本含「已过期」文案', js.includes('已过期'));
    check('TG10 密码页脚本按 reason 分派（不是只看状态码）',
          js.includes('bad_password') && js.includes('disabled') && js.includes('expired'));
}

// ============ TG11：禁用 / 重新启用 / 过期 → 会话即时失效 ============
// 会真的改服务器上的密码表（自建一条临时 key，无论成败都删掉），所以默认跳过。
if (!TOOL) {
    console.log('\n（跳过 TG11：未设 CMSGATE_TOOL，不会改动线上数据）');
} else if (!ADMIN_PW) {
    // 写操作现在要管理口令（SSH 私钥之外的第二道门）。不给就明确说清楚，
    // 别让 tool() 返回 127 之后表现成一堆莫名其妙的断言失败。
    console.log('\n（跳过 TG11：未设 GATE_ADMIN_PW——gate_manager 的写操作需要管理口令）');
    console.log('  TG11 要真的 add/disable/expire/rm 线上密码表，所以得有它。');
    console.log('  给法： GATE_ADMIN_PW=\'你的管理口令\' （注意：它不是访问密码）');
} else if (!PW) {
    console.log('\n（跳过 TG11：既没有 GATE_PW，自建 key 也失败）');
} else {
    console.log('\n—— TG11  临时 key 的生命周期（会写线上，用完即删）——');
    let id = TMP_ID;
    try {
        if (!id) {                                   // 前面用的是真的 GATE_PW，这里另建一条
            const pw = randomBytes(18).toString('base64url');
            const r = tool(['add', '--label', 'cdp-gate-tmp', '--note', '测试用，自动删除',
                            '--password-stdin'], pw);
            id = (r.out.match(/\bid\s*:\s*([0-9a-f]{12})/) || [])[1] || null;
            if (!id) throw new Error('临时 key 没建成功：' + r.out.slice(0, 160));
            tool(['push']);
            TMP_ID = id; TMP_PW = pw;
        }
        check('TG11 临时 key 就绪', !!id, `id=${id}`);
        check('TG11 用临时 key 能进游戏', await loginAs(TMP_PW));

        // ① 禁用 → 已登录的会话必须**下一次请求就失效**
        const r1 = tool(['disable', id]); tool(['push']);
        check('TG11 disable 成功', r1.code === 0, r1.out.trim().split('\n').pop().slice(0, 100));
        check('TG11 禁用后被弹回密码页（会话即时失效）', await bouncedToGate());
        // 再用这条被禁用的密码登录一次：fetch 路径必须给出「已被停用」，
        // 不能退回通用的"密码不正确"——否则用户会一直重试一个永远过不去的密码。
        await waitLoginGateOpen();
        const errDisabled = await loginAttemptErr(TMP_PW);
        check('TG11 禁用后登录 → 提示「已被停用」', errDisabled.includes('已被停用'),
              `err="${errDisabled}"`);

        // ② 重新启用 → gen/rev 没变，原来的 cookie 又能用
        const r2 = tool(['enable', id]); tool(['push']);
        check('TG11 enable 成功', r2.code === 0);
        check('TG11 重新启用后又能进（gen/rev 未变）', !(await bouncedToGate()));

        // ③ 设成昨天过期 → 同样即时失效
        const y = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        const r3 = tool(['expire', id, '--until', y]); tool(['push']);
        check('TG11 expire 成功', r3.code === 0, r3.out.trim().split('\n').pop().slice(0, 100));
        check('TG11 过期后被弹回密码页', await bouncedToGate());
        await waitLoginGateOpen();      // 上一次失败登录记了计数，这次要等锁过
        const errExpired = await loginAttemptErr(TMP_PW);
        check('TG11 过期后登录 → 提示「已过期」', errExpired.includes('已过期'),
              `err="${errExpired}"`);
    } catch (e) {
        check('TG11 用例执行完成', false, String(e && e.message || e).slice(0, 160));
    } finally {
        if (TMP_ID) {
            const r = tool(['rm', TMP_ID, '--yes']);
            const p = tool(['push']);
            check('TG11 临时 key 已清理（无论成败）', r.code === 0 && p.code === 0,
                  `rm=${r.code} push=${p.code}`);
        }
    }
}

console.log(`\n════ 通过 ${pass.length} 项，失败 ${fail.length} 项 ════`);
if (fail.length) { console.log('失败项：\n  ' + fail.join('\n  ')); process.exit(1); }
process.exit(0);
