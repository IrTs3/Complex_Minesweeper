/* 复数扫雷：访问密码页的交互。
 *
 * 必须是零依赖的独立脚本——不能 import dist/*.js。
 * 因为那些文件必须对「未通过验证的访客」可见才能被加载，那就等于把游戏逻辑全部公开，
 * 闸门就形同虚设了。（另外也满足了 style-src/script-src 'self' 的 CSP 与"零运行时依赖"惯例。）
 *
 * 无 JavaScript 时表单会走原生 POST（action="/__login"），服务端把提示直接写在
 * 那一响应的正文里（纯文字页面），不会跳到任何地址 —— 见 index.html 的 <noscript>。
 */
(function () {
  'use strict';

  var form = document.getElementById('gate-form');
  var input = document.getElementById('pw');
  var err = document.getElementById('err');
  var btn = form ? form.querySelector('button[type="submit"]') : null;
  var reveal = document.getElementById('reveal');
  if (!form || !input || !err) return;

  var busy = false;
  var BTN_LABEL = btn ? btn.textContent : '';

  // 「显示密码」：手机上输错一位却看不见，只能整串重输。
  if (reveal) {
    reveal.addEventListener('click', function () {
      var on = input.type === 'password';
      input.type = on ? 'text' : 'password';
      reveal.textContent = on ? '隐藏' : '显示';
      reveal.setAttribute('aria-pressed', on ? 'true' : 'false');
      reveal.setAttribute('aria-label', on ? '隐藏密码' : '显示密码');
      input.focus();
    });
  }

  // 服务端给的原因 → 说给用户的话。
  // **必须分开**：被停用/已过期如果也显示「密码不正确」，用户会一直重试一个永远不会通过的密码，
  // 然后跑来问「密码是不是坏了」。这四种原因对应 authd 里的 R_* 常量。
  // ★ 无原型对象（2026-10-21 安全审计 P10）：MSG 是普通对象时 `MSG[reason]`
  //   会走原型链，服务端若回 "constructor"/"toString" 就会把函数源码显示在错误行里
  //   （只是文本、不解析 HTML，但那不该出现在登录页上）。
  var MSG = Object.assign(Object.create(null), {
    bad_password: '密码不正确，请重试',
    throttled: '尝试过于频繁，请等一会儿再试',
    disabled: '这个密码已被停用，请找管理员换一个',
    expired: '这个密码已过期，请找管理员换一个'
  });

  function show(msg) { err.textContent = msg || ''; }
  function say(reason) { show(MSG[reason] || MSG.bad_password); }
  function setBusy(on) {
    busy = on;
    if (!btn) return;
    btn.disabled = on;
    // 只改 disabled + 半透明的话，慢网络下点了按钮界面毫无变化，用户会以为没点上而反复戳。
    btn.textContent = on ? '验证中…' : BTN_LABEL;
  }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    if (busy) return;
    var pw = input.value;
    if (!pw) { show('请输入密码'); input.focus(); return; }

    setBusy(true);
    show('');

    fetch('/__login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-CMSGATE': '1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ pw: pw })
    }).then(function (res) {
      if (res.ok) {
        // 整页进入游戏（replace 不留历史，返回键不会退回密码页）。
        // 必须写 /game 而不是 /：学习站模式下 / 会 302 去 /learn/；
        // /game 是两种模式共用的唯一游戏入口，且始终受闸门保护。
        location.replace('/game');
        return null;
      }
      // 失败时服务端带 {"ok":false,"reason":"..."}；解析不出来就退回按状态码判断。
      // Retry-After 是节流的剩余秒数——只说「等一会儿」的话用户会反复点、然后去问管理员密码是不是坏了。
      var retry = parseInt(res.headers.get('Retry-After') || '', 10);
      return res.json().catch(function () { return null; })
        .then(function (body) {
          return { status: res.status, reason: body && body.reason, retry: isNaN(retry) ? 0 : retry };
        });
    }).then(function (r) {
      if (!r) return;                                   // 已成功跳转
      if (r.status === 429) {                           // 429 只有"被节流"一种
        show(r.retry > 0 ? '尝试过于频繁，请等 ' + r.retry + ' 秒后再试' : MSG.throttled);
      } else if (r.reason && MSG[r.reason]) {
        say(r.reason);
      } else if (r.status === 401) {
        say('bad_password');
      } else {
        show('服务暂时不可用，请稍后再试');
      }
      input.select();
      setBusy(false);
    }).catch(function () {
      show('网络异常，请重试');
      setBusy(false);
    });
  });
})();

/* 登录页星光层（2026-10-20）：与游戏内的星光同源观感，但**必须自包含** ——
 * 不能 import dist/fx.js，那个文件收在闸门内、匿名访客拿到就是 404，登录页恰恰是给匿名的人看的。
 * 因此这里独立写一份最小粒子：只飘、只闪，**没有** USTC 弹字（登录页没有那个复选框），
 * 也**没有**流星 / 耀斑 / 单位圆彩蛋 —— 登录页是刻意打折的版本，别抢密码框的戏。
 * 遵守：CSP script-src 'self'（代码在本文件内，无内联 script）；prefers-reduced-motion 时整层不启用。
 * 画布必须 pointer-events:none（见 gate.css 的 #fx），否则挡住表单没法点。
 *
 * ★ 观感参数（幂律半径、配色权重、光晕、闪烁 6 次幂、横向摇摆）与
 *   web/ts/fx.ts 的 starfx / src/desktop/Renderer.cpp 的 namespace starfx **必须同数**。 */
(function () {
  'use strict';

  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // 密度/大小尽量沿用回访用户在 Settings 里的选择；读不到就用登录页默认（比游戏略淡略少）。
  // 密度 0 = 用户在 Settings 里把星光层彻底关了，登录页也照办：连画布都不建。
  var count = 90, scale = 1.3, animFx = true;
  try {
    var raw = localStorage.getItem('complex-minesweeper.settings.v1');
    if (raw) {
      // ★ 不再整份 JSON.parse（2026-10-21 安全审计 P10）：这份设置里可能有
      //   最大的背景图 base64（上限 24MB），而登录页只需要两个数字。
      //   定向正则只扫一遍字符串，不构造几十 MB 的对象图 —— 低端机上登录页不再卡顿。
      //   base64 里不含引号，所以不会误解出 "starDensity"。
      var mc = /"starDensity"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(raw);
      if (mc) {
        var n = parseFloat(mc[1]);
        if (isFinite(n) && n >= 0 && n <= 800) {
          // 2026-10-22 起密度单位是「颗/100×100px」（saveSettings 会写 starUnit: 2）。
          // 没有标记的是旧刻度（1512×982 下的颗数）—— 先折算，老用户登录页不会突然挤满。
          if (!/"starUnit"\s*:\s*2/.test(raw)) {
            n = Math.round(n * 10000 / (1512 * 982) * 100) / 100;
          }
          if (n <= 7.12) {
            // 密度 → 登录页颗数：同样按 **CSS 像素** 面积换算，再套登录页自己的上限 160。
            count = Math.min(160, Math.round(n * window.innerWidth * window.innerHeight / 10000));
          }
        }
      }
      var ms = /"starScale"\s*:\s*(-?\d+(?:\.\d+)?)/.exec(raw);
      if (ms) {
        var v = parseFloat(ms[1]);
        if (v >= 0.6 && v <= 3.0) scale = v * 0.75;
      }
      var ma = /"animFx"\s*:\s*(true|false)/.exec(raw);
      if (ma) animFx = ma[1] === 'true';
    }
  } catch (e) { /* 无存储/隐私模式：用默认 */ }
  if (count <= 0) return;

  var canvas = document.getElementById('fx');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var FX = {
    rBase: 0.8, rSpan: 2.4, rPow: 2.2,
    whiteW: 0.58, blueW: 0.32, warmW: 0.10,
    blue: '#66ccff', warm: '#ffd9a0',
    glowTex: 64, glowMid: 0.65, haloRatio: 3.6,
    twBase: 0.10, twAmp: 0.88, twPow: 6,
    twSpMin: 0.4, twSpMax: 3.2,
    swayAmpMin: 6, swayAmpMax: 14, swayOmegaMin: 0.3, swayOmegaMax: 0.8,
    riseMin: 5, riseMax: 19, dtCap: 0.05
  };

  var vw = 0, vh = 0, raf = 0, last = 0, t = 0;
  var sparks = [];
  var glow = null;

  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    vw = window.innerWidth; vh = window.innerHeight;
    canvas.width = Math.max(1, Math.round(vw * dpr));
    canvas.height = Math.max(1, Math.round(vh * dpr));
    canvas.style.width = vw + 'px';
    canvas.style.height = vh + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 光斑贴图：与游戏页 / 桌面端同一条衰减曲线 a = (1 - d²)^p，
  // p 由 glowMid 反解 —— 「1/3 半径处 alpha = glowMid」这条老约定保留，
  // 但曲线不再是三段折线（那个折点在放大后会显形）。
  function ensureGlow() {
    if (glow) return glow;
    var n = FX.glowTex;
    var c = document.createElement('canvas');
    c.width = n; c.height = n;
    var g = c.getContext('2d');
    if (!g) return null;
    var grad = g.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    var p = Math.log(FX.glowMid) / Math.log(8 / 9);   // 1 - (1/3)² = 8/9
    var STOPS = 8;
    for (var i = 0; i <= STOPS; i++) {
      var d = i / STOPS;
      var a = Math.pow(Math.max(0, 1 - d * d), p);
      // 核附近白、外圈吃主色（与游戏页的「白核 + 彩色晕」一致）
      var k = Math.min(1, d * 2.2);
      var cr = Math.round(255 + (102 - 255) * k);
      var cg = Math.round(255 + (204 - 255) * k);
      grad.addColorStop(d, 'rgba(' + cr + ',' + cg + ',255,' + a.toFixed(4) + ')');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, n, n);
    glow = c;
    return glow;
  }

  function pickHue() {
    var w = Math.random() * (FX.whiteW + FX.blueW + FX.warmW);
    if (w < FX.whiteW) return 0;
    if (w < FX.whiteW + FX.blueW) return 1;
    return 2;
  }

  function newSpark(anywhere) {
    var x0 = Math.random() * vw;
    return {
      x: x0, x0: x0,
      y: anywhere ? Math.random() * vh : vh + 8 + Math.random() * 24,
      vx: (Math.random() - 0.5) * 6,
      vy: -(FX.riseMin + Math.random() * (FX.riseMax - FX.riseMin)),
      r: FX.rBase + FX.rSpan * Math.pow(Math.random(), FX.rPow),
      ph: Math.random() * Math.PI * 2,
      sp: FX.twSpMin + Math.random() * (FX.twSpMax - FX.twSpMin),
      hue: pickHue(),
      amp: FX.swayAmpMin + Math.random() * (FX.swayAmpMax - FX.swayAmpMin),
      omega: FX.swayOmegaMin + Math.random() * (FX.swayOmegaMax - FX.swayOmegaMin),
      swPhase: Math.random() * Math.PI * 2
    };
  }

  function draw(s) {
    var sn = Math.max(0, Math.sin(s.ph));
    var a = Math.min(1, FX.twBase + FX.twAmp * Math.pow(sn, FX.twPow));
    if (a <= 0.004) return;
    var rr = Math.max(0.3, s.r * scale);
    var col = s.hue === 1 ? FX.blue : (s.hue === 2 ? FX.warm : '#ffffff');
    if (rr >= 1) {
      var g = ensureGlow();
      if (g) {
        var d = rr * 2 * FX.haloRatio;
        ctx.globalAlpha = a * 0.85;
        ctx.drawImage(g, s.x - d / 2, s.y - d / 2, d, d);
      }
    }
    ctx.globalAlpha = a;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(s.x, s.y, rr, 0, Math.PI * 2);
    ctx.fill();
    if (rr >= 1.2) {
      // 大星：内凹四角尖星 ✦（8 顶点，尖 3.2r、凹 0.9r 交替）
      // ★ 用户 2026-10-21 明确要求：背景星星保持「多色混合 + 好几种形状」的老样子
      ctx.beginPath();
      for (var i = 0; i < 8; i++) {
        var ang = i * Math.PI * 0.25;
        var len = (i % 2 === 0 ? FX.bigSpike : FX.bigInner) * rr;
        var px = s.x + Math.cos(ang) * len, py = s.y + Math.sin(ang) * len;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
  }

  // 斜向流光：一条极淡的光带沿对角缓慢扫过（周期 9s），画在星星底下。
  // 静态截图基本看不出来，动起来才有的层次感；用户关掉动效（animFx:false）就不画。
  function drawBand() {
    if (!animFx) return;
    var p = (t / 9) % 1;
    var cx = (p * 1.6 - 0.3) * vw;
    var cy = (p * 1.6 - 0.3) * vh;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.6);
    var bw = Math.max(vw, vh) * 0.9;
    var g = ctx.createLinearGradient(-bw, 0, bw, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(180,220,255,0.055)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-bw, -vh * 1.5, bw * 2, vh * 3);
    ctx.restore();
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    var dt = Math.min(FX.dtCap, Math.max(0, (now - last) / 1000));
    last = now;
    t += dt;
    ctx.clearRect(0, 0, vw, vh);
    drawBand();
    for (var i = 0; i < sparks.length; i++) {
      var s = sparks[i];
      s.x0 += s.vx * dt; s.y += s.vy * dt; s.ph += s.sp * dt;
      s.x = s.x0 + s.amp * Math.sin(t * s.omega + s.swPhase);
      if (s.y < -12 || s.x < -40 || s.x > vw + 40) { sparks[i] = newSpark(false); continue; }
      draw(s);
    }
    ctx.globalAlpha = 1;
  }

  function start() { if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); } }
  function stop() { if (raf) { cancelAnimationFrame(raf); raf = 0; } }

  resize();
  for (var i = 0; i < count; i++) sparks.push(newSpark(true));
  window.addEventListener('resize', resize);
  document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); else start(); });
  start();
})();
