'use strict';
/*
 * 密码管理界面的前端逻辑。
 *
 * 两条硬约束（改代码时别破坏）：
 *
 *  1) **绝不用 innerHTML 拼数据**。密码标签、备注、IP、User-Agent 全是外部输入，
 *     一旦用 innerHTML 就等于给自己开个 XSS。这里统一用 textContent。
 *     唯一例外是「明文密码只显示一次」那个框——它也是 textContent。
 *
 *  2) **界面不做任何权限判断**。写操作只是把管理口令转交给 CLI，
 *     真正的校验发生在 gate_manager.py 里。前端任何「我已经校验过了」的想法
 *     都是在绕过那道门。
 */
(function () {
    const $ = (id) => document.getElementById(id);


    /**
     * 图标裁剪器。返回 `{ blob, x, y, size }`（原图像素坐标），取消返回 null。
     *
     * ★ 坐标系：选框的 x/y/size **一律按原图像素存**，显示时乘 scale。
     *   反过来（按屏幕像素存）会让「换个窗口大小 → 裁出来的东西变了」——
     *   用户看到的框没动，裁出来却不一样，这是最难查的一类 bug。
     *
     * ★ 必须是正方形：mac/win 的图标都是方的。让框自由变形的话，
     *   非方形的选区还得再补边或裁边，用户看到的预览和最终结果就不一致了。
     *
     * ★ 最小边长按**原图像素**算（ICON_MIN_EDGE）。屏幕上的 48px 在
     *   一张 4800 宽的图上可能只对应 256 原图像素 —— 按屏幕像素卡下限
     *   会让「小图上看着够大、大图上其实只有几十像素」。
     */
    function openCropDialog(file) {
        return new Promise(async (resolve) => {
            const dlg = $('crop-dlg');
            const img = $('crop-img');
            const stage = $('crop-stage');
            const boxEl = $('crop-box');
            const info = $('crop-info');
            const prevs = {
                256: $('crop-prev-256'), 64: $('crop-prev-64'),
                32: $('crop-prev-32'), 16: $('crop-prev-16'),
            };
            $('crop-min').textContent = String(ICON_MIN_EDGE);

            let bmp = null;
            try {
                bmp = await createImageBitmap(file);
            } catch (e) {
                toast('这张图浏览器打不开，没法裁剪', true);
                resolve(null);
                return;
            }
            const IW = bmp.width, IH = bmp.height;

            // ★ 必须用 **data: URL**，不能用 URL.createObjectURL：
            //   CSP 是 `img-src 'self' data:`（见 gate_ui 的响应头），**不含 blob:**。
            //   用 blob: 的话 img 会被 CSP 拦掉 —— naturalWidth 恒为 0、画面一片空白，
            //   而 `createImageBitmap` 不受 CSP 管所以照样成功：症状是
            //   「选区数字都对、预览也画得出来，但左边背景图是空的」，极难查。
            //   先缩到显示够用的宽度再转，避免把几十 MB 的图塞成巨型 base64。
            const TW = Math.min(IW, 1600);
            const TH = Math.max(1, Math.round(IH * TW / IW));
            const tcv = document.createElement('canvas');
            tcv.width = TW; tcv.height = TH;
            tcv.getContext('2d').drawImage(bmp, 0, 0, TW, TH);
            img.src = tcv.toDataURL('image/jpeg', 0.92);
            try { await img.decode(); } catch (e) { /* 解码失败下面也会露馅 */ }

            // 选区（原图像素）。初始：居中，边长取短边的 72%，但不小于最小边长。
            const minEdge = Math.max(1, Math.min(ICON_MIN_EDGE, Math.min(IW, IH)));
            let sel = { x: 0, y: 0, size: 0 };
            {
                const side0 = Math.max(minEdge, Math.round(Math.min(IW, IH) * 0.72));
                const size = Math.min(side0, Math.min(IW, IH));
                sel = { x: Math.round((IW - size) / 2), y: Math.round((IH - size) / 2), size };
            }

            /** 原图宽 → 显示宽的换算（stage 宽度由 CSS 撑满，img width:100%）。 */
            function scaleNow() {
                const dw = img.clientWidth || stage.clientWidth || 1;
                return dw / IW;
            }

            // 原图尺寸也挂到 data-* 上：界面上显示的是**缩略图**，
            // naturalWidth 是缩略图的宽（不是原图），拿它判边界会算错。
            boxEl.dataset.imgW = String(IW);
            boxEl.dataset.imgH = String(IH);

            const off = document.createElement('canvas');   // 预览用的离屏画布
            const offCx = off.getContext('2d');

            function drawPreview() {
                const S = Math.max(1, Math.round(sel.size));
                off.width = S; off.height = S;
                offCx.imageSmoothingQuality = 'high';
                // ★ 从**原图**裁，不是从屏幕上显示的那张缩略图裁 ——
                //   后者已经缩过一次，再裁出来会糊。
                offCx.drawImage(bmp, sel.x, sel.y, sel.size, sel.size, 0, 0, S, S);
                for (const [px, elPrev] of Object.entries(prevs)) {
                    const out = document.createElement('canvas');
                    out.width = out.height = Number(px);
                    const c = out.getContext('2d');
                    c.imageSmoothingQuality = 'high';
                    c.drawImage(off, 0, 0, Number(px), Number(px));
                    elPrev.style.backgroundImage = `url(${out.toDataURL('image/png')})`;
                }
                info.innerHTML = '';       // 下面用 DOM 拼，不拼字符串（防注入）
                const l1 = document.createElement('div');
                l1.append('选区 ', el('b', null, `${Math.round(sel.size)}×${Math.round(sel.size)}`),
                          ' px（原图）');
                const l2 = document.createElement('div');
                l2.append('位置 ', el('b', null, `${Math.round(sel.x)}, ${Math.round(sel.y)}`));
                const l3 = document.createElement('div');
                l3.append('图标输出 ', el('b', null, `${ICON_OUT}×${ICON_OUT}`), ' px');
                info.append(l1, l2, l3);
                if (sel.size < ICON_OUT) {
                    const w = document.createElement('div');
                    w.className = 'warn';
                    w.textContent = `⚠ 选区小于 ${ICON_OUT}，图标会被放大（略糊）`;
                    info.append(w);
                }
            }

            function paintBox() {
                const k = scaleNow();
                boxEl.style.left = (sel.x * k) + 'px';
                boxEl.style.top = (sel.y * k) + 'px';
                boxEl.style.width = (sel.size * k) + 'px';
                boxEl.style.height = (sel.size * k) + 'px';
                // 把选区值同时写进 data-*：**原图像素**，是权威值。
                // 界面上的 px 是缩放后的，不能拿来判断「够不够 256」；
                // 自动化测试也直接读这里，不必去解析中文文案。
                boxEl.dataset.x = String(Math.round(sel.x));
                boxEl.dataset.y = String(Math.round(sel.y));
                boxEl.dataset.size = String(Math.round(sel.size));
            }

            function clampSel() {
                const maxSize = Math.min(IW, IH);
                sel.size = Math.max(minEdge, Math.min(maxSize, sel.size));
                sel.x = Math.max(0, Math.min(IW - sel.size, sel.x));
                sel.y = Math.max(0, Math.min(IH - sel.size, sel.y));
            }

            function refresh() {
                clampSel();
                paintBox();
                drawPreview();
            }

            // ---- 拖动 / 缩放 ----
            // 用 pointer 事件（一套代码同时支持鼠标与触屏），并 setPointerCapture：
            // 这样指针移出元素后事件仍然回到这里，不会「拖到一半丢了」。
            let drag = null;

            boxEl.addEventListener('pointerdown', (ev) => {
                const hd = ev.target.closest('.crop-hd');
                ev.preventDefault();
                drag = {
                    mode: hd ? 'resize' : 'move',
                    dir: hd ? hd.dataset.h : '',
                    px: ev.clientX, py: ev.clientY,
                    x0: sel.x, y0: sel.y, s0: sel.size,
                };
                boxEl.setPointerCapture(ev.pointerId);
            });

            boxEl.addEventListener('pointermove', (ev) => {
                if (!drag) return;
                const k = scaleNow();
                if (!k) return;
                // 屏幕位移 → 原图像素位移
                const dx = (ev.clientX - drag.px) / k;
                const dy = (ev.clientY - drag.py) / k;

                if (drag.mode === 'move') {
                    sel.x = drag.x0 + dx;
                    sel.y = drag.y0 + dy;
                } else {
                    // ★ 正方形约束：取「水平/垂直两个方向里变化更大的那个」，
                    //   这样斜着拖手感自然，又始终是 1:1。
                    const d = drag.dir;
                    const big = Math.abs(dx) > Math.abs(dy) ? dx : dy;
                    let size = drag.s0, x = drag.x0, y = drag.y0;
                    if (d === 'se') {
                        size = drag.s0 + big;
                    } else if (d === 'nw') {
                        size = drag.s0 - big;
                        x = drag.x0 + (drag.s0 - size);
                        y = drag.y0 + (drag.s0 - size);
                    } else if (d === 'ne') {
                        size = drag.s0 + big;
                        y = drag.y0 + (drag.s0 - size);
                    } else if (d === 'sw') {
                        size = drag.s0 - big;
                        x = drag.x0 + (drag.s0 - size);
                    } else if (d === 'n') {
                        size = drag.s0 - big;
                        y = drag.y0 + (drag.s0 - size);
                    } else if (d === 's') {
                        size = drag.s0 + big;
                    } else if (d === 'w') {
                        size = drag.s0 - big;
                        x = drag.x0 + (drag.s0 - size);
                    } else if (d === 'e') {
                        size = drag.s0 + big;
                    }
                    size = Math.max(minEdge, Math.min(Math.min(IW, IH), size));
                    // 从 nw/w/n 缩放时，位置要跟着 size 的变化走（否则框会「跳」）
                    if (drag.dir.includes('w')) x = drag.x0 + (drag.s0 - size);
                    if (drag.dir.includes('n')) y = drag.y0 + (drag.s0 - size);
                    sel = { x, y, size };
                }
                refresh();
            });

            const endDrag = (ev) => {
                if (!drag) return;
                drag = null;
                try { boxEl.releasePointerCapture(ev.pointerId); } catch (e) { /* 已释放 */ }
            };
            boxEl.addEventListener('pointerup', endDrag);
            boxEl.addEventListener('pointercancel', endDrag);

            $('crop-reset').onclick = () => {
                const side0 = Math.max(minEdge, Math.round(Math.min(IW, IH) * 0.72));
                const size = Math.min(side0, Math.min(IW, IH));
                sel = { x: Math.round((IW - size) / 2), y: Math.round((IH - size) / 2), size };
                refresh();
            };

            const close = (val) => {
                if (dlg.open) dlg.close();
                bmp.close();
                resolve(val);
            };
            $('crop-cancel').onclick = () => close(null);
            $('crop-ok').onclick = () => {
                // 输出 ICON_OUT×ICON_OUT 的 PNG（不够就放大，够就缩小）
                const out = document.createElement('canvas');
                out.width = out.height = ICON_OUT;
                const c = out.getContext('2d');
                c.imageSmoothingQuality = 'high';
                c.drawImage(bmp, sel.x, sel.y, sel.size, sel.size,
                            0, 0, ICON_OUT, ICON_OUT);
                const shot = {
                    x: Math.round(sel.x), y: Math.round(sel.y),
                    size: Math.round(sel.size),
                };
                out.toBlob((blob) => {
                    if (!blob) { toast('图标生成失败，换个区域试试', true); return; }
                    close({ blob, ...shot });
                }, 'image/png');
            };

            refresh();
            // stage 尺寸变化（窗口缩放）后选框要重画，否则位置会与图片错开
            const ro = new ResizeObserver(() => paintBox());
            ro.observe(stage);
            dlg.addEventListener('close', () => ro.disconnect(), { once: true });

            if (!dlg.open) dlg.showModal();
            requestAnimationFrame(() => { paintBox(); paintBox(); });   // 布局稳定后再对一次
        });
    }

    /** 字节数 → 人读的写法（KB / MB，一位小数）。 */
    function fmtBytes(n) {
        if (!n && n !== 0) return '—';
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(1) + ' MB';
    }

    /**
     * 上传进度条。`total` 为 0 表示服务端没给 Content-Length（lengthComputable=false）——
     * 那种情况只报已传字节，**不硬算百分比**（否则会出现 NaN% 或恒 0%）。
     */
    function setUploadProgress(loaded, total) {
        const box = $('page-prog');
        if (!box) return;
        box.hidden = false;
        const fill = $('prog-fill');
        const txt = $('prog-txt');
        if (total > 0) {
            const pct = Math.min(100, (loaded / total) * 100);
            fill.style.width = pct.toFixed(2) + '%';
            txt.textContent = `${fmtBytes(loaded)} / ${fmtBytes(total)}`
                + `（${pct.toFixed(1)}%）`;      // ★ 用户要的：已传/总大小（百分比，一位小数）
        } else {
            fill.style.width = '0%';
            txt.textContent = `已上传 ${fmtBytes(loaded)}`;
        }
    }

    function resetUploadProgress() {
        const box = $('page-prog');
        if (box) box.hidden = true;
        const fill = $('prog-fill');
        if (fill) fill.style.width = '0%';
        const txt = $('prog-txt');
        if (txt) txt.textContent = '';
    }

    /** 背景图长边上限。与 gate_manager.WEBBG_MAX_EDGE 保持一致（两边都会夹一次）。 */
    const BG_MAX_EDGE = 1920;

    /** 背景图短边下限。低于这个铺满屏幕就是糊的 —— 直接拒绝，别让人白等一次上传。 */
    const BG_MIN_SHORT_EDGE = 512;

    /** 图标裁剪框的最小边长（两端图标都至少要有这个分辨率）。 */
    const ICON_MIN_EDGE = 256;

    /** 图标输出尺寸。512 是为了 mac 的 512@2x（=1024）那档不太糊；
     *  设更大只是让 icns/ico 更胖，屏幕上用不到。 */
    const ICON_OUT = 512;

    /** 服务端允许的上传上限。只在「浏览器压缩失败」时才会真的撞到。 */
    const BG_UPLOAD_MAX = 200 * 1024 * 1024;

    const state = {
        admin: '',            // 管理口令：只在内存里，绝不写 localStorage
        overview: null,
        remote: null,
        entries: [],
        ops: {},
        query: '',
        //: 有写操作正在跑（push / 改密码 / 踢人…）。自动刷新据此暂停——
        //: 别在人家推表的时候去抢同一台机器的 ssh。
        writing: false,
        //: 访问记录分页：page 从 0 起，pageSize 由「每页 N 条」那个输入框决定
        page: 0,
        pageSize: 20,
        //: 自动刷新间隔（秒）与「是不是正暂停着」。
        //: 暂停**不等于**把间隔设成 0 —— 那会让用户回头再点「继续」时丢掉自己设的秒数。
        autoSec: 30,
        autoPaused: false,
        //: 线上网页背景图的现状（开/关、文件大小、能不能恢复）。要 SSH，异步加载。
        webbg: null,
        //: 线上默认页模式（game / learn）。要 SSH，异步加载；null = 还没读到。
        landing: null,
        //: 秘密登录入口现状（token / 路径 / 片段在不在）。要 SSH，异步加载。
        gatePath: null,
        //: 上传对话框里选好的图片。**不能**直接把 File 塞进 dlg 的返回值：
        //   openInfoDialog 的 close() 只带一个值，而 <input type=file> 的 .value
        //   是浏览器的 fakepath，必须在这里把 File 对象留住。
        pickedBg: null,
        //: 推送时是否也换桌面端（对应 CLI 的 --desktop）。**默认 false** ——
        //   桌面端那张 assets/bg.jpg 同时是应用图标与 dmg 安装背景的源。
        //: 推送时更新到哪些端。**默认都勾**。
        //   ★ 为什么「桌面端」是一个而不是 mac / win 两个：两端**用的是同一张
        //     背景图和同一个图标源**（assets/bg.jpg / assets/icon.png），
        //     所以分两个复选框只能控制「更新哪几个产物目录」，
        //     不是「给不同的端用不同的图」—— 那会让人误以为能分开配。
        //     同源就只有「换 / 不换」，一个框最诚实。
        targets: { web: true, desktop: true },
    };

    // ── 偏好（只存这两个键）────────────────────────────────────
    //
    // ⚠️ 这两个数字框的值会进 localStorage，所以「只有两个键」这条要守住：
    //   **管理口令绝对不进 localStorage**（那是这个文件里唯一真正的凭据）。
    //   state.admin 的注释已经写死了那条规矩，这里再加一道断言（见测试 T31）。
    const UI_KEYS = ['ui.pageSize', 'ui.autoSec'];

    const LIMITS = {
        pageSize: [1, 500],      // 每页条数
        autoSec: [1, 3600],      // 自动刷新间隔（秒）
    };

    /** 输入框的值 → 夹到合法范围内的整数。空/非数字 → 回落到默认。 */
    function clampInt(v, key, dflt) {
        const [lo, hi] = LIMITS[key];
        const n = parseInt(v, 10);
        if (!Number.isFinite(n)) return dflt;
        return Math.min(hi, Math.max(lo, n));
    }

    function rememberUI(key, val) {
        // 白名单是**真的白名单**：将来有人顺手加一句 setItem('ui.token', …) 就会在这里炸，
        // 而不是悄悄把东西留在磁盘上（localStorage 不随页面关闭消失）。
        if (!UI_KEYS.includes(key)) throw new Error('不认识的偏好键：' + key);
        try { localStorage.setItem(key, String(val)); } catch (e) { /* 隐私模式：算了 */ }
    }

    function recallUI(key, limKey, dflt) {
        try {
            const raw = localStorage.getItem(key);
            return (raw === null || raw === '') ? dflt : clampInt(raw, limKey, dflt);
        } catch (e) { return dflt; }
    }

    // ── 基础设施 ────────────────────────────────────────────────

    /** 创建一个元素。text 走 textContent（绝不 innerHTML）。 */
    function el(tag, cls, text) {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.textContent = String(text);
        return n;
    }

    /* ── 底部弹窗：页面所有提示的唯一出口（2026-11-01 收口）─────────────
       以前是三个面：右下角 toast（3.2 秒）、顶部 flash 条（3 秒）、页面最底部
       一张不消失的「命令输出」卡。同一件事三种表现，用户学不会「结果到底在哪看」，
       代码里也各写一份 setTimeout。现在只有一种：底部居中堆叠，右上角 × 手动关。

       停留时长按内容长短决定，最低 2 秒（用户定的下限），封顶 12 秒——再长的
       短提示也不该赖在屏幕上。长文本（>200 字）和「命令输出」不自动关：
       那是出错证据 / 可能要抄的东西，自动收走等于把证据弄丢。 */
    const TOAST_MAX = 4;            // 同时最多几条，超出的最旧一条先退
    const TOAST_MIN_MS = 2000;
    const TOAST_CAP_MS = 12000;
    const TOAST_STICKY_CHARS = 200;

    function toastMs(text) {
        return Math.min(TOAST_CAP_MS, TOAST_MIN_MS + 60 * String(text).length);
    }

    /** 唯一实现。opt = {text, bad, title, sticky, mono, ms}；返回那张卡片。 */
    function notify(opt) {
        const box = $('toasts');
        if (!box) return null;
        const text = opt.text == null ? '' : String(opt.text);
        const sticky = opt.sticky === undefined
            ? text.length > TOAST_STICKY_CHARS : !!opt.sticky;
        const card = el('div', 'toast' + (opt.bad ? ' bad' : '') + (opt.title ? ' out' : ''));

        if (opt.title) {
            const head = el('div', 'toast-head');
            head.append(el('span', 'toast-title', opt.title));
            card.append(head);
        }
        const body = el('div', 'toast-text', text || '(无输出)');
        if (opt.mono) body.classList.add('mono');
        card.append(body);

        const x = el('button', 'toast-x', '×');
        x.type = 'button';
        x.setAttribute('aria-label', '关闭这条提示');
        x.addEventListener('click', () => card.remove());
        card.append(x);

        box.append(card);
        while (box.children.length > TOAST_MAX) box.firstElementChild.remove();
        if (!sticky) {
            setTimeout(() => { if (card.isConnected) card.remove(); }, opt.ms || toastMs(text));
        }
        return card;
    }

    /** 短提示（成功/失败/复制完说一声）。 */
    function toast(msg, bad) {
        return notify({ text: msg, bad: bad });
    }

    /**
     * 刷新回执（「已刷新 · 13:00:00」）。函数名留着是因为调用点有 4 处，
     * 但它和 toast 现在是同一个面：都走 notify()，都在底部弹、都有 ×。
     */
    function flash(msg, bad) {
        return notify({ text: msg, bad: bad });
    }

    function showOutput(title, text, bad) {
        // 命令原始输出：不过滤也不美化，出错时这就是证据 → 不自动关，只能 ×
        return notify({ title: title || '命令输出', text: text, bad: bad,
                        sticky: true, mono: true });
    }

    /** 抹掉所有「命令输出」弹窗。明文密码可能就在里面，看过一次必须能清干净。 */
    function clearOutput() {
        const box = $('toasts');
        if (!box) return;
        for (const c of [...box.querySelectorAll('.toast.out')]) {
            const t = c.querySelector('.toast-text');
            if (t) t.textContent = '';
            c.remove();
        }
    }

    async function api(path) {
        const r = await fetch(path, { credentials: 'same-origin' });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.ok === false) {
            throw new Error((j && j.error) || ('HTTP ' + r.status));
        }
        return j.data;
    }

    /** 调后端执行一个操作。返回 {ok, code, out}。 */
    async function exec(op, params) {
        const r = await fetch('/api/exec', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json', 'X-CMSUI': '1' },
            body: JSON.stringify({ op: op, params: params || {} }),
        });
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.ok === false) {
            throw new Error((j && j.error) || ('HTTP ' + r.status));
        }
        return j.data;
    }

    // ── 对话框 ──────────────────────────────────────────────────

    /**
     * 通用对话框。返回 Promise<对象|null>（null = 用户取消）。
     *
     * fields: [{name, label, type, value, placeholder, hint, options, required}]
     *   type: text | password | number | date | select | checkbox
     */
    function openDialog(opts) {
        return new Promise((resolve) => {
            const dlg = $('dlg');
            const body = $('dlg-body');
            const note = $('dlg-note');
            const form = $('dlg-form');
            const okBtn = $('dlg-ok');
            const cancelBtn = $('dlg-cancel');

            dlg.className = '';
            $('dlg-title').textContent = opts.title || '';
            okBtn.textContent = opts.okText || '确定';
            okBtn.className = opts.danger ? 'primary danger' : 'primary';
            // 「只显示这一次」「详情」会把取消按钮藏掉；这里显式恢复，
            // 免得某条路径漏恢复之后，下一次弹窗只能按 Esc 关掉。
            cancelBtn.hidden = false;

            if (opts.note) {
                note.textContent = opts.note;
                note.className = 'dlg-note' + (opts.noteBad ? ' bad' : '');
                note.hidden = false;
            } else {
                note.hidden = true;
            }

            body.replaceChildren();
            const inputs = {};

            (opts.fields || []).forEach((f) => {
                if (f.type === 'checkbox') {
                    const wrap = el('label', 'inline');
                    const inp = document.createElement('input');
                    inp.type = 'checkbox';
                    inp.checked = !!f.value;
                    wrap.append(inp, el('span', null, f.label));
                    body.append(wrap);
                    inputs[f.name] = inp;
                    return;
                }

                const field = el('label', 'field');
                field.append(el('span', null, f.label));

                let inp;
                if (f.type === 'select') {
                    inp = document.createElement('select');
                    (f.options || []).forEach((o) => {
                        const op = document.createElement('option');
                        op.value = o.value;
                        op.textContent = o.label;
                        inp.append(op);
                    });
                    if (f.value !== undefined) inp.value = f.value;
                } else if (f.type === 'checkbox') {
                    inp = document.createElement('input');
                    inp.type = 'checkbox';
                } else {
                    inp = document.createElement('input');
                    inp.type = f.type || 'text';
                    if (f.value !== undefined && f.value !== null) inp.value = f.value;
                    if (f.placeholder) inp.placeholder = f.placeholder;
                    if (f.min !== undefined) inp.min = f.min;
                    if (f.max !== undefined) inp.max = f.max;
                    inp.autocomplete = 'off';
                    if (f.type === 'password') inp.autocomplete = 'current-password';
                }
                if (f.required) inp.required = true;
                if (f.value !== undefined) {
                    if (inp.type === 'checkbox') inp.checked = !!f.value;
                    else if (f.type !== 'select') inp.value = f.value;
                }

                field.append(inp);
                if (f.hint) field.append(el('span', 'hint', f.hint));
                body.append(field);
                inputs[f.name] = inp;
            });

            function cleanup() {
                okBtn.removeEventListener('click', onOk);
                form.removeEventListener('submit', onSubmit);
                cancelBtn.removeEventListener('click', onCancel);
                dlg.removeEventListener('cancel', onCancel);
            }
            function readValues() {
                const out = {};
                for (const k in inputs) {
                    const inp = inputs[k];
                    out[k] = inp.type === 'checkbox' ? inp.checked : inp.value;
                }
                return out;
            }
            function onSubmit(ev) {
                ev.preventDefault();
                // 浏览器原生校验（required）先跑一遍
                if (!form.reportValidity()) return;
                cleanup();
                dlg.close();
                resolve(readValues());
            }
            function onOk(ev) {
                ev.preventDefault();
                onSubmit(ev);
            }
            function onCancel(ev) {
                if (ev) ev.preventDefault();
                cleanup();
                dlg.close();
                resolve(null);
            }

            okBtn.addEventListener('click', onOk);
            form.addEventListener('submit', onSubmit);
            cancelBtn.addEventListener('click', onCancel);
            dlg.addEventListener('cancel', onCancel);

            dlg.showModal();
            const first = body.querySelector('input:not([type="checkbox"]), select');
            if (first) setTimeout(() => first.focus(), 30);
        });
    }

    /** 只展示一个明文（密码只显示这一次，所以要显眼 + 可复制）。 */
    function showSecret(pw, idText) {
        return new Promise((resolve) => {
            const dlg = $('dlg');
            const body = $('dlg-body');
            const note = $('dlg-note');
            const form = $('dlg-form');
            const okBtn = $('dlg-ok');
            const cancelBtn = $('dlg-cancel');

            $('dlg-title').textContent = '新密码已生成 —— 只显示这一次';
            okBtn.textContent = '我已保存';
            okBtn.className = 'primary';
            dlg.className = '';

            note.textContent =
                '关掉这个窗口后就再也看不到了。忘记只能轮换（passwd）或删掉重建。';
            note.className = 'dlg-note bad';
            note.hidden = false;

            body.replaceChildren();
            body.append(el('div', 'secret', pw));
            if (idText) {
                const f = el('div', 'field');
                f.append(el('span', null, 'id'));
                f.append(el('div', 'id-cell', idText));
                body.append(f);
            }
            const copy = el('button', 'ghost', '复制密码');
            copy.type = 'button';
            copy.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(pw);
                    toast('已复制到剪贴板');
                } catch (e) {
                    toast('复制失败，请手动选中上面那串', true);
                }
            });
            body.append(copy);

            function done(ev) {
                if (ev) ev.preventDefault();
                okBtn.removeEventListener('click', done);
                form.removeEventListener('submit', done);
                cancelBtn.removeEventListener('click', done);
                cancelBtn.hidden = false;
                dlg.removeEventListener('cancel', done);
                dlg.close();
                resolve();
            }
            cancelBtn.hidden = true;
            okBtn.addEventListener('click', done);
            form.addEventListener('submit', done);
            dlg.addEventListener('cancel', done);
            dlg.showModal();
        });
    }

    /**
     * 只读信息对话框（详情用）。返回 Promise<void>，关掉时 resolve。
     *
     * ★ fill() 里的异步部分**既不阻塞显示、也不阻塞关闭**：
     *   对话框先 showModal()，骨架立刻可见；数据回来再往骨架里填。
     *   所以「点下去马上有反应」是被结构保证的，不靠网络够快。
     *
     *   这条是用户反馈的直接产物：原来详情是写进页面最底部的输出卡片，
     *   点击点之后视口内一个像素都没变，体感就是「按钮点不动」。
     */
    function openInfoDialog(opts) {
        return new Promise((resolve) => {
            const dlg = $('dlg');
            const body = $('dlg-body');
            const note = $('dlg-note');
            const form = $('dlg-form');
            const okBtn = $('dlg-ok');
            const cancelBtn = $('dlg-cancel');

            dlg.className = 'wide';
            $('dlg-title').textContent = opts.title || '';
            okBtn.textContent = opts.okText || '关闭';
            okBtn.className = 'primary';
            note.hidden = true;
            cancelBtn.hidden = true;
            body.replaceChildren();

            let picked = null;      // 由 ctl.close(value) 带出去的动作（没有就是 null）

            function done(ev) {
                if (ev) ev.preventDefault();
                okBtn.removeEventListener('click', done);
                form.removeEventListener('submit', done);
                dlg.removeEventListener('cancel', done);
                cancelBtn.hidden = false;
                dlg.className = '';
                dlg.close();
                resolve(picked);
            }
            okBtn.addEventListener('click', done);
            form.addEventListener('submit', done);
            dlg.addEventListener('cancel', done);

            dlg.showModal();
            const ctl = {
                // 让 fill 里的按钮能「关掉对话框并把结果带出去」
                // （比如「看完了，去推送」——不能在这里直接开第二个 modal，
                //  同一个 <dialog> 正在 open 时再 showModal 会抛 InvalidStateError）
                close: (value) => {
                    picked = value || null;
                    done();
                },
            };
            // 不 await：内容加载失败只该影响内容，不该连累「关闭」
            try {
                const p = opts.fill(body, ctl);
                if (p && typeof p.then === 'function') {
                    p.catch((e) => {
                        body.append(el('p', 'dlg-empty bad', '读取失败：' + e.message));
                    });
                }
            } catch (e) {
                body.append(el('p', 'dlg-empty bad', '读取失败：' + e.message));
            }
        });
    }

    /** 键值表（详情头部）。全部 textContent，绝不 innerHTML。 */
    function kvBlock(pairs) {
        const box = el('div', 'kv');
        for (const pair of pairs) {
            const v = pair[1];
            box.append(el('span', 'kv-k', pair[0]));
            box.append(el('span', 'kv-v', (v === undefined || v === null || v === '') ? '—' : v));
        }
        return box;
    }

    /** 详情里的迷你访问记录表（复用 .grid 样式，限高滚动）。 */
    function usageMiniTable(rows) {
        const wrap = el('div', 'mini-wrap');
        const t = el('table', 'grid mini');
        const thead = el('thead');
        const hr = el('tr');
        ['时间', '结果', 'IP', '客户端'].forEach((h) => hr.append(el('th', null, h)));
        thead.append(hr);
        const tbody = el('tbody');
        for (const u of rows) {
            const tr = el('tr');
            tr.append(
                el('td', null, u.time),
                el('td', null, u.result),
                el('td', 'id-cell', u.ip || '—'),
                el('td', null, [u.browser, u.os].filter(Boolean).join(' / ') || '—'),
            );
            tbody.append(tr);
        }
        t.append(thead, tbody);
        wrap.append(t);
        return wrap;
    }

    // ── 管理口令 ────────────────────────────────────────────────

    /**
     * 取管理口令。
     *
     * 默认**每次都要输**（和 CLI 一致）；用户可以在对话框里勾「记住本次会话」，
     * 记住的只存在内存里，刷新页面就没了。绝不写 localStorage。
     *
     * `hint` 非空 = 上一轮口令被拒，这次是「重输」。对话框里会明说原因，
     * 并且**调用方已经把参数留着了**，用户只需要重打口令，不用重填一遍表单。
     */
    async function askAdmin(actionText, hint) {
        if (state.admin) return state.admin;
        const v = await openDialog({
            title: hint ? '管理口令不正确 · 重新输入' : '需要管理口令',
            note: hint
                ? hint + '\n之前填的内容都还留着，重输口令即可，不用从头再来。'
                : '「' + actionText + '」会改动密码表或线上状态，所以要再确认一次。',
            noteBad: !!hint,
            fields: [
                { name: 'admin', label: '管理口令', type: 'password', required: true },
                { name: 'remember', label: '记住本次会话（刷新即失效）', type: 'checkbox', value: false },
            ],
            okText: hint ? '重试' : '继续',
            danger: true,
        });
        if (!v) return null;
        if (v.remember) state.admin = v.admin;
        return v.admin;
    }

    async function confirmDanger(title, note, okText) {
        const v = await openDialog({
            title: title,
            note: note,
            noteBad: true,
            fields: [{ name: 'ok', label: '我确认执行这个操作', type: 'checkbox', value: false, required: true }],
            okText: okText || '执行',
            danger: true,
        });
        if (!v || !v.ok) return false;
        return true;
    }

    // ── 渲染 ────────────────────────────────────────────────────

    function renderChips() {
        const box = $('chips');
        box.replaceChildren();
        const o = state.overview;
        if (!o) return;

        if (!o.initialized) {
            box.append(el('span', 'chip warn', '本地还没有密码表'));
            return;
        }

        box.append(withB('本地 gen', o.gen));
        box.append(withB('条目', o.count));

        // ★ 源码比进程新 = 改了 gate_ui.py 但没重启。前端资源每次读盘所以页面是新的，
        //   行为却是旧的（接口不认新参数之类），表现会非常莫名其妙。直接说出来。
        if (o.stale) {
            const c = withB('服务端代码已更新', '重启 cmsui 生效', 'bad');
            c.title = '页面资源每次刷新都会重新读盘，但 gate_ui.py 本身是被 Python '
                + '载入内存的——改完必须重启进程，否则接口还是旧的。';
            box.append(c);
        }

        const ps = o.push_state;
        const st = ps === 'clean' ? 'ok' : (ps === 'pending' ? 'warn' : '');
        const txt = ps === 'clean' ? '已与服务器一致'
            : ps === 'pending' ? '有改动未推送'
                : '没有推送记录';
        box.append(withB('同步', txt, st));

        const r = state.remote;
        if (r && r.reachable) {
            box.append(withB('线上闸门', r.gate_on ? '开（需要密码）' : '关（任何人可进）',
                r.gate_on ? 'ok' : 'bad'));
            box.append(withB('管理口令', r.admin_set ? '已设置' : '未设置',
                r.admin_set ? '' : 'warn'));
            if (r.remote_gen !== null && r.remote_gen !== undefined && r.remote_gen !== o.gen) {
                box.append(withB('gen 不一致', '本地 ' + o.gen + ' / 线上 ' + r.remote_gen, 'warn'));
            }
        } else if (r) {
            box.append(withB('线上状态', '读不到（SSH 失败）', 'warn'));
        }

        // 网页背景图（版权未授权，所以要能一键撤下）。点它开对话框。
        const w = state.webbg;
        if (w && w.reachable) {
            const on = w.mode !== 'off';
            const txt = w.mode === 'unknown' ? '开（默认）'
                : (on ? '开' : '关（白底）');
            const c = withB('网页背景', txt, w.drifted ? 'warn' : (on ? '' : 'bad'));
            c.title = w.drifted
                ? '记录与线上实际不一致 —— 多半是之后又跑过 deploy-web.sh'
                  + '（rsync 会把本地图同步回去）。点开可以一键对齐。'
                : '点击：查看 / 撤下 / 恢复 / 推送新的背景图。';
            box.append(c);
        } else if (w) {
            box.append(withB('网页背景', '读不到（SSH 失败）', 'warn'));
        }

        // 默认页：游戏 or 学习站。监管要求根路径能切到公开学习内容，
        // 所以这个开关要一眼可见、一点可切（切换要管理口令，见 doLanding）。
        const ld = state.landing;
        if (ld && ld.mode) {
            const learn = ld.mode === 'learn';
            const c = withB('默认页', learn ? '学习站（/ → /learn/）' : '开放站（/ → /game）',
                learn ? 'ok' : '');
            c.title = learn
                ? '根路径 302 到公开学习站；游戏在 /game 受闸门保护；其余路径 404。点击切到开放站。'
                : '根路径与未定义路径都 302 到 /game；游戏本身仍要登录。点击切到学习站（监管复查时用）。';
            box.append(c);
        } else if (ld) {
            box.append(withB('默认页', '读不到（SSH 失败）', 'warn'));
        }

        // 登录入口：一条随机路径。顶栏要能看见它、并能一键换（换要管理口令）。
        // 做成芯片而不是藏在设置里：这是**唯一**能进后台的网址，看不见就等于进不去。
        const gp = state.gatePath;
        if (gp && gp.path) {
            const c = withB('登录入口', gp.path, 'ok');
            c.title = '这是当前唯一能打开登录页的地址（/gate/ 对未登录者已 404）。'
                + '点击：查看并复制完整网址（站点地址+路径）/ 换一条（旧链接会立刻失效）。';
            box.append(c);
        } else if (gp && gp.exists === false) {
            box.append(withB('登录入口', '片段缺失（无人能登录）', 'bad'));
        } else if (gp) {
            box.append(withB('登录入口', '读不到（SSH 失败）', 'warn'));
        }
    }

    function withB(label, value, cls) {
        const c = el('span', 'chip' + (cls ? ' ' + cls : ''));
        c.append(el('b', null, label + ' '));
        c.append(document.createTextNode(String(value)));
        return c;
    }

    function stateTag(s) {
        const t = el('span', 'tag', s);
        if (s === '启用') t.classList.add('on');
        else if (s === '已禁用') t.classList.add('off');
        else if (s === '已过期') t.classList.add('exp');
        return t;
    }

    function visibleEntries() {
        const q = state.query.trim().toLowerCase();
        const f = entryF;
        return state.entries.filter((e) => {
            // 状态列：多选是「或」；「7 天内到期」是额外的「且」条件
            if (f.state.size && !f.state.has(e.state)) return false;
            if (f.soon && !e.expiring_soon) return false;
            if (!q) return true;
            return (e.id || '').toLowerCase().includes(q)
                || (e.label || '').toLowerCase().includes(q)
                || (e.note || '').toLowerCase().includes(q);
        });
    }

    function renderEntries() {
        const tb = $('entries-body');
        tb.replaceChildren();
        const rows = visibleEntries();

        $('entries-count').textContent = rows.length + ' / ' + state.entries.length + ' 条';

        if (!state.entries.length) {
            $('entries-empty').hidden = false;
            $('entries-empty').textContent = state.overview && state.overview.initialized
                ? '还没有任何密码。点左上角「+ 新增密码」建第一条。'
                : '本地还没有密码表。点「+ 新增密码」时会先帮你初始化。';
            return;
        }
        if (!rows.length) {
            $('entries-empty').hidden = false;
            $('entries-empty').textContent = '没有符合当前筛选条件的条目。';
            return;
        }
        $('entries-empty').hidden = true;

        // 重复密码组上同一底色（2026-10-30）：数据源是密码表条目里的 dup 字段
        // （组锚 id），由 add/passwd 自动检测或 `cms dupmark` 手动补标写入——
        // 条目里只有独立盐的哈希，前端不可能自己比出"密码相同"。
        const colorOf = assignDupeColors(state.entries, visibleEntries());
        let lastColor = -1;
        for (const e of rows) {
            const tr = document.createElement('tr');

            const tdLabel = document.createElement('td');
            tdLabel.className = 'label-cell';
            tdLabel.textContent = e.label || '(无标签)';
            if (e.note) tdLabel.append(el('span', 'note-cell', e.note));

            const tdState = el('td');
            tdState.append(stateTag(e.state));

            const tdExp = el('td', null, e.expiry);
            const tdLast = el('td', null, e.last || '—');
            const tdStat = el('td', 'num', (e.ok || 0) + ' / ' + (e.fail || 0));
            const tdId = el('td', 'id-cell', e.id);

            const tdActs = el('td', 'acts');
            tdActs.append(
                tinyBtn(e.enabled ? '禁用' : '启用', () => toggleEnabled(e)),
                tinyBtn('轮换', () => doPasswd(e)),
                tinyBtn('有效期', () => doExpire(e)),
                tinyBtn('备注', () => doNote(e)),
                tinyBtn('详情', () => doShow(e)),
                tinyBtn('删除', () => doRm(e), 'danger'),
            );

            tr.append(tdLabel, tdState, tdExp, tdLast, tdStat, tdId, tdActs);
            // 组色：16 色浅底（相邻行撞色已在 assignDupeColors 里避开）；
            // 单条密码（组内只剩自己）不上色，保持白底。
            const ci = colorOf.get(e.dup);
            if (ci !== undefined) {
                tr.style.backgroundColor = DUPE_COLORS[ci];
                lastColor = ci;
            } else {
                lastColor = -1;         // 白底行隔开的两个组不算相邻
            }
            tb.append(tr);
        }
    }

    // 重复组底色色板：色相沿色环铺满一圈（红→橙→黄→绿→青→蓝→紫→粉），
    // 14–16 号刻意偏灰/压暗当「异类」，让第 13 组之后仍有区分度；
    // 亮度都在 90% 上下，深色正文与「启用/已禁用」标签直接可读。
    const DUPE_COLORS = ['#FFDBDB', '#FFE3C2', '#FFF2BC', '#EFF6C0', '#DEF3CE', '#CDEFDF',
                         '#CFF0F0', '#D4E9FF', '#DBE2FF', '#E7E0FF', '#F0DFFF', '#FBE0F4',
                         '#FFE0EC', '#F7E6D3', '#E9E6DC', '#DDEBE7'];

    /**
     * 给重复组分底色：同组恒同色、相邻两行不同色。
     * 相邻约束取自**可见行的顺序**（筛选/排序都会改变谁挨着谁，所以每次渲染重算）；
     * 白底行隔开的组不算相邻。组按首次出现顺序贪心取色，16 色内基本无冲突。
     */
    function assignDupeColors(allEntries, rows) {
        const counts = new Map();
        for (const e of allEntries) {
            if (e.dup) counts.set(e.dup, (counts.get(e.dup) || 0) + 1);
        }
        // 组内只剩一条（其他被删/出组）就不算重复，不上色
        const seq = [];
        for (const e of rows) {
            if (e.dup && counts.get(e.dup) > 1) seq.push(e.dup);
        }
        const adj = new Map();
        for (let i = 1; i < seq.length; i++) {
            const a = seq[i - 1], b = seq[i];
            if (a === b) continue;
            if (!adj.has(a)) adj.set(a, new Set());
            if (!adj.has(b)) adj.set(b, new Set());
            adj.get(a).add(b);
            adj.get(b).add(a);
        }
        const color = new Map();
        for (const g of seq) {
            if (color.has(g)) continue;
            const used = new Set([...(adj.get(g) || [])]
                .map((n) => color.get(n)).filter((v) => v !== undefined));
            let ci = 0;
            while (used.has(ci % DUPE_COLORS.length) && ci < DUPE_COLORS.length * 2) ci++;
            color.set(g, ci % DUPE_COLORS.length);
        }
        return color;
    }

    function tinyBtn(text, fn, cls) {
        const b = el('button', 'tiny' + (cls ? ' ' + cls : ''), text);
        b.type = 'button';
        b.addEventListener('click', fn);
        return b;
    }

    /** 页码条：`第 2 / 4 页` + 上一页/下一页。左边界定死，右键到最后一页。 */
    function renderPager(matched) {
        const size = state.pageSize;
        const pages = Math.max(1, Math.ceil((matched || 0) / size));
        if (state.page > pages - 1) state.page = pages - 1;   // 筛选后条数变少时兜一下
        $('page-info').textContent = '第 ' + (state.page + 1) + ' / ' + pages + ' 页';
        $('page-prev').disabled = state.page <= 0;
        $('page-next').disabled = state.page >= pages - 1;
        $('pager').hidden = !matched;
    }

    /**
     * 一行在**屏幕上**呈现出来的全部内容，拼成一个可比较的签名。
     *
     * 为什么用「渲染后的文本」而不是行对象：签名的作用是判断「重建之后画面会不会变」，
     * 那就必须按画面上的东西算。用行对象的话，某个字段变了但这列不显示，
     * 也会被当成「要重建」，白白丢掉选区。
     */
    function rowSig(r) {
        return [
            r.time, r.ok ? '1' : '0', r.result,
            r.label || r.pwid || '—',
            r.ip || '—',
            r.browser || '—',
            (r.os || '—') + (r.device ? ' / ' + r.device : ''),
        ].join('\u0001');
    }

    function buildUsageRow(r) {
        const tr = document.createElement('tr');
        const tdRes = el('td');
        tdRes.append(el('span', 'tag' + (r.ok ? ' on' : ' off'), r.result));
        tr.append(
            el('td', null, r.time),
            tdRes,
            el('td', null, r.label || r.pwid || '—'),
            el('td', 'id-cell', r.ip || '—'),
            el('td', null, r.browser || '—'),
            el('td', null, (r.os || '—') + (r.device ? ' / ' + r.device : '')),
        );
        return tr;
    }

    /**
     * 新记录插在最前面、老记录被挤出末尾时，要前移几条。
     *
     * 判据：存在 k（1 ≤ k < n）使 `old[0 .. n-k-1] === new[k .. n-1]`。
     * 页大小固定，所以「增删同时发生」时长度不变、只是整体错位——正是这种情况。
     * 返回 0 表示「不是这种错位」，调用方就老老实实重建。
     */
    function prependShift(neu, old) {
        const n = old.length;
        // 完全一致时返回 0。调用方本来就会先把这种情况挡掉，这里再挡一次是为了让
        // 本函数自己也自洽——否则「一样」会被判成「前移 1 条」，白插一行又删一行。
        if (n === neu.length && neu.every((s, i) => s === old[i])) return 0;
        for (let k = 1; k < n; k++) {
            let same = true;
            for (let j = 0; j + k < n; j++) {
                if (neu[j + k] !== old[j]) { same = false; break; }
            }
            if (same) return k;
        }
        return 0;
    }

    //: 上一次真正画进 tbody 的每行签名。自动刷新每 10 秒来一趟，
    //: 若内容一个字都没变就**一个节点都不碰**——否则你在表里选中文字准备复制，
    //: 选区每 10 秒被清一次，而且看起来像什么都没发生。
    let lastSigs = [];

    function renderUsage(rows, meta) {
        const tb = $('usage-body');
        meta = meta || {};
        rows = rows || [];

        // 条数提示必须把「筛掉的」和「被上限截掉的」都说清楚，
        // 否则「0 条失败」会被误读成「从来没失败过」。
        const total = meta.total || 0;
        const matched = meta.matched || 0;
        const bits = [];
        const who = [];
        if (meta.dropped_existing) {
            who.push('已删除密码的历史记录 ' + meta.dropped_existing + ' 条');
        }
        if (total !== matched) {
            bits.push('共 ' + total + ' 条，筛选后 ' + matched + ' 条');
            // ★ 必须点名**是谁筛的**。「只显示密码表里还存在的」默认开着，
            //   而它以前既不出现在「清除全部筛选」按钮里、也不出现在这句提示里，
            //   于是「共 174 / 筛选后 129」看起来就像数字坏了或用户手滑加了筛选。
            if (who.length) bits.push('（' + who.join('、') + ' 已隐藏）');
        } else {
            bits.push('共 ' + total + ' 条');
        }
        const cnt = $('usage-count');
        cnt.textContent = total ? bits.join(' · ') : '';
        cnt.title = who.length
            ? '「只显示密码表里还存在的」默认开着，所以已删除密码的历史记录被藏起来了。'
            : '';
        // 给出「一键全放出来」的入口：这个默认开关藏在列头面板里，
        // 用户既看不到、也不知道数字为什么不等。
        $('usage-show-all').hidden = !(who.length && usageF.existing);
        renderPager(matched);

        if (!rows.length) {
            if (lastSigs.length) { tb.replaceChildren(); lastSigs = []; }
            $('usage-empty').hidden = false;
            $('usage-empty').textContent = matched
                ? '这一页没有记录（翻回去了？点「上一页」或回到第一页）。'
                : (total ? '当前筛选条件下没有记录。点「清除全部筛选」看全部。'
                    : '还没有访问记录。点「立即刷新」从服务器拉一份。');
            return;
        }
        $('usage-empty').hidden = true;

        const sigs = rows.map(rowSig);

        // ① 一模一样 → 连碰都不碰（这是自动刷新的常态：十秒里根本没新记录）
        if (sigs.length === lastSigs.length
                && sigs.every((s, i) => s === lastSigs[i])) {
            return;
        }

        // ② 只是「新记录插在前面、老的被挤掉」→ 顶部插新的、尾部删旧的，
        //    **不移动任何已有节点**，所以选区跟着自己那一行走，不会被清掉。
        if (sigs.length === lastSigs.length) {
            const k = prependShift(sigs, lastSigs);
            if (k > 0) {
                const first = tb.firstChild;
                for (let i = k - 1; i >= 0; i--) {
                    tb.insertBefore(buildUsageRow(rows[i]), first);
                }
                for (let i = 0; i < k; i++) tb.lastElementChild.remove();
                lastSigs = sigs;
                return;
            }
        }

        // ③ 真的换了内容（翻页 / 改筛选 / 改了备注…）→ 重建。
        //    顺手把滚动位置还回去：内容高度没变时不该把人弹回顶部。
        const wrap = tb.closest('.table-wrap');
        const keepTop = wrap ? wrap.scrollTop : 0;
        tb.replaceChildren(...rows.map(buildUsageRow));
        if (wrap && keepTop && sigs.length === lastSigs.length) wrap.scrollTop = keepTop;
        lastSigs = sigs;
    }

    // ── 加载 ────────────────────────────────────────────────────

    /** 整页加载 / 刷新。访问记录**默认从服务器拉一份**——「刷新」就该看到最新的。
     *
     *  `opts.quiet` 抑制顶部的「已刷新」条：刚打开页面时就喊一嗓子是噪声。
     */
    async function loadAll(opts) {
        try {
            state.overview = await api('/api/overview');
            state.entries = await api('/api/entries');
            renderChips();
            renderEntries();
        } catch (e) {
            toast('读取本地数据失败：' + e.message, true);
        }
        loadRemote();
        loadWebbg();
        loadLanding();
        loadGatePath();
        loadUsageFacets();
        // 顶栏「刷新」也是一次手动拉取，所以同样在顶部说一声
        loadUsage({ pull: true }).then((d) => {
            if (!opts || !opts.quiet) {
                if (d && !d.pull_error && !d.pull_skip_reason) {
                    flash('已刷新 · ' + hhmmss(Date.now() / 1000));
                }
            }
        });
    }

    async function loadRemote() {
        try {
            state.remote = await api('/api/remote');
        } catch (e) {
            state.remote = { reachable: false, error: e.message };
        }
        renderChips();
    }

    /**
     * 线上背景图的现状。**只读**，不要管理口令。
     *
     * 单独一个接口而不是塞进 /api/remote：它要 SSH（~1 秒），
     * 而顶栏那几项本地就能读，两者不该互相拖。
     */
    async function loadWebbg() {
        try {
            state.webbg = await api('/api/webbg');
        } catch (e) {
            state.webbg = { reachable: false, error: e.message, mode: 'unknown' };
        }
        renderChips();
    }

    /**
     * 线上默认页模式（game / learn）。**只读**，不要管理口令。
     * 与 loadWebbg 一样单独一个接口：它要 SSH，不该拖慢顶栏本地项。
     */
    async function loadLanding() {
        try {
            state.landing = await api('/api/landing');
        } catch (e) {
            state.landing = { mode: null, error: e.message };
        }
        renderChips();
    }

    /**
     * 线上秘密登录入口（/gate/<TOKEN>/）。**只读**，不要管理口令。
     * 同样单独一个接口：它要 SSH。
     */
    async function loadGatePath() {
        try {
            state.gatePath = await api('/api/gate-path');
        } catch (e) {
            state.gatePath = { token: null, path: null, exists: false, error: e.message };
        }
        renderChips();
    }

    /** 完整入口网址 = 站点前缀（后端 SITE_ORIGIN）+ 入口路径（CLI 只读接口）。
     *  复制给访客的必须是这条：裸路径粘到微信里打不开。 */
    function gateUrl() {
        const gp = state.gatePath || {};
        return gp.path ? ((gp.site || '') + gp.path) : null;
    }

    // ── 列头筛选（Excel 式）─────────────────────────────────────
    //
    // 每列列头右边一个小 ▾，点开是这一列的可选值 + 条数（多选复选框）。
    // 同一列里多选是「或」，不同列之间是「且」——和 Excel 的自动筛选一致。
    //
    // 面板挂在 <body> 上、`position: fixed` 定位到列头下方。为什么不放进表格里：
    // `.table-wrap` 是 `overflow: auto`，放进去会被裁掉；而且表头是 `sticky`，
    // 子元素会被它的层叠上下文困住。
    // CSP 是 `style-src 'self'`，但**通过 CSSOM 写样式是允许的**——
    // 被拦的是 HTML 里的 `style=""` 和 `<style>` 标签，不是 `el.style.left = ...`。

    //: 访问记录每列 → facet 接口里的字段名
    const FACET_OF = {
        result: 'results', pwid: 'pwids', ip: 'ips', browser: 'browsers', osdev: 'osdev',
    };

    //: 时间列不是「枚举」，是一组预设区间
    const TIME_PRESETS = [
        { value: 'today', text: '今天' },
        { value: '7d', text: '最近 7 天' },
        { value: '30d', text: '最近 30 天' },
    ];

    const usageF = {
        // 时间列：preset 为空 = 不限；'custom' 用 from/to（毫秒时间戳）
        time: { preset: '', from: '', to: '' },
        result: new Set(), pwid: new Set(), ip: new Set(), browser: new Set(),
        osdev: new Set(),
        //: 每一列在面板里的**视觉**勾选状态（列名集合，当前是「全勾」的那些列）。
        //: 为什么需要它：`chosen` 为空 = 不限，所以「初始全勾」和「被你取消到全不勾」
        //: 在语义上**完全一样**（都是不限、都显示全部）。但用户要能一眼看出
        //: 「这一列我刚才清空了」—— 语义一样，视觉必须能区分。
        //: 这份状态**不进查询串**：它只管勾怎么画。
        visAll: new Set(['result', 'pwid', 'ip', 'browser', 'osdev']),
        //: 只显示「密码表里还存在的密码」的记录。默认开——删掉的测试密码不该继续占屏。
        existing: true,
        //: 浏览器列按名字合并（忽略版本号）。默认开——`Edge 155.0.0.0` 和
        //: `Edge 153.0.0.0` 是同一个人升级浏览器，不该变成两个筛选项。
        //: 这是**显示模式**（决定「几个选项、筛什么值」），不是筛选条件本身，
        //: 所以「清除全部筛选」不会动它。
        bname: true,
    };
    const entryF = { state: new Set(), soon: false, visAll: new Set(['state']) };

    let facetCache = null;
    //: 上一次取 facets 失败的原因。**不能静默吞掉**——踩过：服务端还是旧进程，
    //: 接口 500，面板里只剩一个「（全部）」，看起来像整个筛选功能坏了。
    let facetError = '';
    let cfAnchor = null;

    /** 时间列是不是真的在筛（选了「自定义」但两个框都空 = 没筛）。 */
    function timeActive() {
        const t = usageF.time;
        return t.preset === 'custom' ? Boolean(t.from || t.to) : Boolean(t.preset);
    }

    /** 毫秒 → `datetime-local` 需要的形式（本机时区，不带秒）。 */
    function msToInput(ms) {
        if (ms === '' || ms === null || ms === undefined) return '';
        const d = new Date(Number(ms));
        if (isNaN(d.getTime())) return '';
        const p = (n) => String(n).padStart(2, '0');
        return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
            + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function filtersOf(tbl) {
        return tbl === 'entries' ? entryF : usageF;
    }

    /** 某一列当前生效的筛选数量（0 = 没筛）。 */
    function colFilterCount(tbl, col) {
        const f = filtersOf(tbl);
        if (col === 'time') return timeActive() ? 1 : 0;
        if (col === 'state') return f.state.size + (f.soon ? 1 : 0);
        return (f[col] || new Set()).size;
    }

    // ★ 刻意**不把 `existing` 算进来**。
    //   「只显示密码表里还存在的」默认开 → 它一开就永远有筛选，那么这个按钮
    //   会一直杵在表头上（=「我一直有筛选」），而点它之后 existing 变 false、
    //   按钮才消失 —— 看着像「点了没反应，清完还在筛」。
    //   而默认态下「共 N 条 / 筛选后 M 条」不等这件事，改为在计数里**点名**
    //   是谁筛的、藏了多少（见 renderUsage），不靠这个按钮表达。
    function anyUsageFilter() {
        return timeActive() || ['result', 'pwid', 'ip', 'browser', 'osdev']
            .some((k) => usageF[k].size);
    }

    /** 把列头的 ▾ 按钮刷成当前状态（有筛就变实心并带个数）。 */
    function refreshColButtons() {
        document.querySelectorAll('th[data-col]').forEach((th) => {
            const b = th.querySelector('.cf-btn');
            if (!b) return;
            const tbl = th.closest('table').dataset.tbl;
            const n = colFilterCount(tbl, th.dataset.col);
            b.textContent = n ? '▾' + n : '▾';
            b.classList.toggle('on', n > 0);
            th.classList.toggle('cf-active', n > 0);
        });
    }

    /** 给所有带 data-col 的列头挂上 ▾（只挂一次）。 */
    function initColFilters() {
        document.querySelectorAll('th[data-col]').forEach((th) => {
            if (th.querySelector('.cf-btn')) return;
            const b = el('button', 'cf-btn', '▾');
            b.type = 'button';
            b.title = '筛选这一列';
            b.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // 点同一个 ▾ = 收起。放在这里而不是 openFilterPanel 里，
                // 是因为面板自己有时需要「原地重开」（比如切了开关后列表要跟着变）。
                if (cfAnchor === b && !$('cf-pop').hidden) {
                    closeFilterPanel();
                    return;
                }
                openFilterPanel(th, b);
            });
            th.append(b);
        });
        refreshColButtons();
    }

    /** 这一列的可选项 [{value, text, n}]。 */
    function optionsFor(tbl, col) {
        if (col === 'time') return TIME_PRESETS;
        if (tbl === 'entries') {
            const order = ['启用', '已禁用', '已过期', '有效期非法'];
            const c = {};
            for (const e of state.entries) c[e.state] = (c[e.state] || 0) + 1;
            return order.filter((s) => c[s]).map((s) => ({ value: s, text: s, n: c[s] }));
        }
        const key = FACET_OF[col];
        return (facetCache && facetCache[key]) || [];
    }

    function closeFilterPanel() {
        const pop = $('cf-pop');
        if (pop.hidden) return;
        pop.hidden = true;
        pop.replaceChildren();
        cfAnchor = null;
    }

    /**
     * 打开某一列的筛选面板。
     *
     * 改动**立即生效**（勾一下就走一次请求），不设「确定/取消」——
     * 这样面板可以一直开着连续勾选，看表格实时变化，比 Excel 那种
     * 「勾完点确定才生效」更适合「边看边缩小范围」。
     */
    function openFilterPanel(th, btn) {
        const pop = $('cf-pop');
        const tbl = th.closest('table').dataset.tbl;
        const col = th.dataset.col;
        const label = th.dataset.label || col;
        const f = filtersOf(tbl);
        const isTime = col === 'time';
        const isState = col === 'state';
        const chosen = isTime ? null : (isState ? f.state : f[col]);

        pop.replaceChildren();
        pop.hidden = false;
        cfAnchor = btn;

        const head = el('div', 'cf-head');
        head.append(el('span', null, '筛选：' + label));
        const x = el('button', 'cf-x', '×');
        x.type = 'button';
        x.title = '关闭';
        x.addEventListener('click', closeFilterPanel);
        head.append(x);
        pop.append(head);

        const opts = optionsFor(tbl, col);

        if (!isTime && opts.length > 8) {
            const s = document.createElement('input');
            s.type = 'search';
            s.className = 'cf-search';
            s.placeholder = '在列表里找…';
            s.autocomplete = 'off';
            pop.append(s);
            s.addEventListener('input', () => {
                const needle = s.value.trim().toLowerCase();
                pop.querySelectorAll('.cf-item').forEach((it) => {
                    const hit = !needle || (it.dataset.text || '').includes(needle);
                    it.hidden = !hit;
                });
            });
        }

        function apply() {
            refreshColButtons();
            if (tbl === 'entries') renderEntries();
            else reloadFirstPage();       // 筛选变了就回第 1 页
        }

        if (isTime) {
            // 「自定义起止」那两个输入框先建出来（radio 的 change 里要引用它）
            const customBox = el('div', 'cf-custom');
            customBox.hidden = f.time.preset !== 'custom';

            const fromI = document.createElement('input');
            fromI.type = 'datetime-local';
            fromI.step = '60';
            fromI.value = msToInput(f.time.from);
            const toI = document.createElement('input');
            toI.type = 'datetime-local';
            toI.step = '60';
            toI.value = msToInput(f.time.to);
            const ff = el('label', 'cf-range');
            ff.append(el('span', null, '开始'), fromI);
            const tf = el('label', 'cf-range');
            tf.append(el('span', null, '结束'), toI);
            customBox.append(ff, tf, el('span', 'hint',
                '留空表示不限；结束时间含整分钟。按本机时区解释。'));

            function applyRange() {
                const fv = fromI.value ? new Date(fromI.value).getTime() : '';
                const tv = toI.value ? new Date(toI.value).getTime() : '';
                if (fv !== '' && tv !== '' && fv > tv) {
                    toast('开始时间晚于结束时间', true);
                    return;
                }
                f.time.from = fv;
                f.time.to = tv;
                // 两个框都空 = 没筛，但选项留在「自定义」上，方便继续填
                f.time.preset = (fv === '' && tv === '') ? '' : 'custom';
                apply();
            }
            fromI.addEventListener('change', applyRange);
            toI.addEventListener('change', applyRange);

            const box = el('div', 'cf-list');
            const mkRadio = (value, text) => {
                const lb = el('label', 'cf-item');
                const inp = document.createElement('input');
                inp.type = 'radio';
                inp.name = 'cf-time';
                inp.value = value;
                inp.checked = (f.time.preset || '') === value;
                lb.append(inp, el('span', null, text));
                inp.addEventListener('change', () => {
                    f.time.preset = value;
                    customBox.hidden = value !== 'custom';
                    if (value !== 'custom') {
                        // 从「自定义」切走时把区间清掉，否则 ▾ 会一直显示有筛选
                        f.time.from = '';
                        f.time.to = '';
                        fromI.value = '';
                        toI.value = '';
                    }
                    apply();
                    if (value === 'custom') setTimeout(() => fromI.focus(), 20);
                });
                return lb;
            };
            box.append(mkRadio('', '全部时间'));
            for (const p of TIME_PRESETS) box.append(mkRadio(p.value, p.text));
            box.append(mkRadio('custom', '自定义起止时间…'));
            pop.append(box, customBox);
        } else {
            // 取不到可选值时必须**说出来**。否则面板里只剩一个「（全部）」，
            // 看着像筛选功能整个坏了（真实踩过：服务端还是旧进程，接口 500）。
            if (tbl !== 'entries' && !opts.length && facetError) {
                const err = el('p', 'cf-empty bad',
                    '这一列的可选值没取到：' + facetError);
                err.title = '如果刚改过 gate_ui.py，需要重启一次进程——'
                    + '页面资源每次刷新都重读，但 Python 代码不会。';
                pop.append(err);
            } else if (tbl !== 'entries' && !opts.length) {
                pop.append(el('p', 'cf-empty', '这一列暂时没有可选值。'));
            }
            // ── 三态「（全部）」复选框 ────────────────────────────
            // 全勾 → 单击 → **全部取消**（空）；空 → 单击 → 全勾；
            // 部分选中 → 显示「−」→ 单击 → 全勾。
            // ★ 语义上「全不勾」= 不限（= 清空这一列的筛选，表格显示全部），
            //   所以永远不会出现「0 条」的死胡同。视觉状态另存在 usageF.visAll。
            const all = el('label', 'cf-item cf-all');
            const allBox = document.createElement('input');
            allBox.type = 'checkbox';
            all.title = '单击：全选 ↔ 全部取消';
            all.append(allBox, el('span', null, '（全部）'));
            pop.append(all);

            const box = el('div', 'cf-list');
            const boxes = [];
            for (const o of opts) {
                const lb = el('label', 'cf-item');
                // 搜索用的小写文本：合并模式下把原始版本串也拼进去，
                // 这样记得「Edge 155」的人还能搜到 `Edge` 这一项。
                lb.dataset.text = ((o.text || '') + ' ' + (o.examples || []).join(' '))
                    .toLowerCase();
                const inp = document.createElement('input');
                inp.type = 'checkbox';
                inp.value = o.value;
                lb.append(inp, el('span', null, o.text), el('span', 'cf-n', o.n));
                // 浏览器列合并模式：这一项底下压着几个版本，标出来。
                // 合并是为了列表短，但「同一浏览器有 4 个版本」对排查有用，
                // 不能悄悄吞掉——所以给个小徽标 + title 里列原始串。
                if (o.versions > 1) {
                    const badge = el('span', 'cf-vers', o.versions + ' 版');
                    const ex = (o.examples || []).join(' / ');
                    badge.title = '合并了 ' + o.versions + ' 个版本'
                        + (ex ? '：' + ex : '');
                    lb.append(badge);
                }
                inp.addEventListener('change', () => {
                    syncFromBoxes();
                    apply();
                });
                boxes.push(inp);
                box.append(lb);
            }
            pop.append(box);

            /** 把三个数字（总项数 / 勾了几个 / chosen 里存了什么）统一起来。 */
            function recompute() {
                const keep = boxes.filter((b) => b.checked).map((b) => b.value);
                if (keep.length === 0 || keep.length === boxes.length) {
                    // 全勾 / 全不勾都等于「不限」：空集合在本表表示「没有筛选」，
                    // 表示不了「一条都不匹配」。
                    chosen.clear();
                } else {
                    chosen.clear();
                    keep.forEach((v) => chosen.add(v));
                }
                // 视觉状态：全勾记进 visAll，全不勾移出，部分选中也不在（=「−」）。
                const n = boxes.filter((b) => b.checked).length;
                if (n === boxes.length) f.visAll.add(col);
                else f.visAll.delete(col);
                syncAllBox();
            }

            /** 把「（全部）」画成三态：全勾 / 全空 / 「−」（部分）。 */
            function syncAllBox() {
                const n = boxes.filter((b) => b.checked).length;
                const all_ = n === boxes.length;
                const none_ = n === 0;
                allBox.checked = all_;
                // indeterminate 只能靠 JS 设（HTML 属性会被浏览器忽略）。
                // 部分选中时「−」比「✓」诚实：它明确说「不是全选，也不是全不选」。
                allBox.indeterminate = !all_ && !none_;
                allBox.title = all_ ? '单击：全部取消（= 清空这一列的筛选）'
                    : (none_ ? '单击：全选' : '单击：全选（现在是部分选中）');
            }

            function syncFromBoxes() {
                recompute();
            }

            // 初始：先按 chosen 勾一遍，再把「（全部）」刷成正确的一态。
            if (chosen.size) {
                boxes.forEach((b) => { b.checked = chosen.has(b.value); });
            } else {
                // 没有筛选值 → 显示成 `visAll` 记的那个视觉态
                // （初始全勾，或用户上次清空过 = 全不勾）
                const vis = f.visAll.has(col);
                boxes.forEach((b) => { b.checked = vis; });
            }
            syncAllBox();

            allBox.addEventListener('click', (ev) => {
                // ★ 用 click 而不是 change 自己算目标态：
                //   浏览器对 indeterminate 的点击行为**没有明确规定**
                //   （多数浏览器变 checked=true，个别变 false）。自己算才稳。
                ev.preventDefault();
                const n = boxes.filter((b) => b.checked).length;
                // 三态的点击目标：全勾 → 全不勾；全不勾 → 全勾；部分 → 全勾。
                // ⚠️ 写成 `!(n===0 || n===len)` 就**错了**：那样「全不勾」算出来的
                //   目标还是「全不勾」，单击毫无反应（用户会以为按钮坏了）。
                const wantAll = n !== boxes.length;
                boxes.forEach((b) => { b.checked = wantAll; });
                recompute();
                apply();
                // ★★ 必须延到微任务里再刷一次「（全部）」自己：
                //   preventDefault 挡住了默认翻转，但浏览器的 **activation behavior**
                //   仍会在事件派发**之后**把 `checked` 写回「用户意图」的值 ——
                //   实测全不勾后它被回滚成 true，而 `title`（同步设的）留在了新值，
                //   于是出现「选项全空但总框还是勾」的怪相。
                //   微任务在 activation behavior 之后跑，所以这时写才留得住。
                queueMicrotask(syncAllBox);
            });

            // 条目表额外一个 AND 条件：只看 7 天内到期
            if (tbl === 'entries') {
                const soon = el('label', 'cf-item cf-divider');
                const sb = document.createElement('input');
                sb.type = 'checkbox';
                sb.checked = f.soon;
                soon.append(sb, el('span', null, '只看 7 天内到期'));
                sb.addEventListener('change', () => { f.soon = sb.checked; apply(); });
                pop.append(soon);
            }

            // 密码列额外一个开关：只显示「密码表里还存在的」
            // 默认开——删掉的测试密码不该继续占满下拉框和表格。
            let existingBox = null;
            if (col === 'pwid') {
                const ex = el('label', 'cf-item cf-divider');
                existingBox = document.createElement('input');
                existingBox.type = 'checkbox';
                existingBox.checked = f.existing;
                ex.append(existingBox, el('span', null, '只显示密码表里还存在的'));
                existingBox.addEventListener('change', async () => {
                    f.existing = existingBox.checked;
                    await loadUsageFacets();      // 列表本身要跟着变
                    apply();
                    // 面板正在开着 → 原地重开一次，让选项列表立刻反映新范围
                    if (!$('cf-pop').hidden) openFilterPanel(th, btn);
                });
                pop.append(ex);
            }

            // 浏览器列额外一个开关：按名字合并（忽略版本号）。
            // ★ 切模式必须**清掉已选的浏览器值**：两种模式的筛选值不通用
            //   （合并模式要 `Edge`，详细模式要 `Edge 155.0.0.0`），不清的话
            //   切过去会拿旧值去比新列表 → 表格静默变 0 条，看起来像数据丢了。
            let bnameBox = null;
            if (col === 'browser') {
                const bn = el('label', 'cf-item cf-divider');
                bnameBox = document.createElement('input');
                bnameBox.type = 'checkbox';
                bnameBox.checked = f.bname;
                bn.append(bnameBox, el('span', null, '按浏览器名合并（忽略版本号）'));
                bnameBox.addEventListener('change', async () => {
                    f.bname = bnameBox.checked;
                    f.browser.clear();
                    await loadUsageFacets();
                    apply();
                    // 面板开着 → 原地重开，让选项列表立刻切成名字 / 全名
                    if (!$('cf-pop').hidden) openFilterPanel(th, btn);
                });
                pop.append(bn);
            }

            const foot = el('div', 'cf-foot');
            const clear = el('button', 'ghost', '清空本列');
            clear.type = 'button';
            clear.addEventListener('click', () => {
                chosen.clear();
                // 「清空本列」= 这一列不筛了。视觉上与「（全部）」被单击取消一致：
                // 全部勾取消掉，visAll 也移出（下次打开面板看到的还是「空」）。
                // ★ 早先这里是「恢复成全勾」，但那等于「点了清空、打开面板却还是全勾」，
                //   用户会以为没生效。语义一样（都不筛），但视觉必须反映动作。
                boxes.forEach((b) => { b.checked = false; });
                f.visAll.delete(col);
                syncAllBox();
                // 「清空本列」把这个面板里勾选的值全部取消（时间不受影响，那是另一列）：
                // 到期只看 = 关；「只看存在的」= **关**（= 连已删除密码的历史记录一起显示）。
                // 原来这里是「恢复默认」（existing 拨回 true），但清空的语义是
                // 「这一列不要筛」—— 复原成默认就等于「点了清空但什么都没变」。
                // ★ 浏览器「按名字合并」不在这里复位：它决定的是「选项怎么分组」，
                //   属于显示模式；清筛选时把它偷偷改回去，等于用户下次点开
                //   发现版本又合起来了却不知道为什么。要切就自己切。
                if (isState) {
                    f.soon = false;
                    const sb = pop.querySelector('.cf-divider input');
                    if (sb) sb.checked = false;
                }
                if (existingBox) {
                    f.existing = false;
                    existingBox.checked = false;
                    loadUsageFacets();
                }
                apply();
            });
            foot.append(clear);
            pop.append(foot);
        }

        // 定位到列头下方；放不下就翻到上面
        const r = btn.getBoundingClientRect();
        const w = pop.offsetWidth;
        const h = pop.offsetHeight;
        const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 12));
        let top = r.bottom + 6;
        if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
        pop.style.left = left + 'px';
        pop.style.top = top + 'px';
    }

    async function loadUsageFacets() {
        try {
            const qs = new URLSearchParams();
            if (usageF.existing) qs.set('existing', '1');
            if (usageF.bname) qs.set('bname', '1');
            facetCache = await api('/api/usage_facets'
                + (qs.toString() ? '?' + qs.toString() : ''));
            facetError = '';
        } catch (e) {
            facetCache = null;
            facetError = e.message || '未知错误';
        }
    }

    /** `已同步 12:39:41` / `同步失败`。时间用本机时区，和表格里的时间一致。 */
    function hhmmss(epoch) {
        if (!epoch) return '';
        const d = new Date(epoch * 1000);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function renderFresh(d) {
        const box = $('usage-fresh');
        const at = hhmmss(d.pulled_epoch);
        if (d.pull_error) {
            // 拉失败时**不清表**：照旧显示缓存里的行，只把失败说清楚。
            box.textContent = at ? '· 同步失败，显示 ' + at + ' 的数据' : '· 同步失败';
            box.title = d.pull_error;
            box.classList.add('bad');
        } else if (at) {
            box.textContent = '· 已同步 ' + at;
            box.title = '每次刷新都会重新从服务器拉一份（两次之间至少隔 2 秒）';
            box.classList.remove('bad');
        } else {
            box.textContent = '';
            box.title = '点「立即刷新」从服务器拉一份';
            box.classList.remove('bad');
        }
    }

    /**
     * 读访问记录。
     *
     * `opts.pull` 为真时先向服务器拉一份（服务端做单飞 + 限速）。**只有**整页加载、
     * 自动刷新、点「立即刷新」这三种情况才 pull；改筛选条件时不 pull——
     * 那只是换个看法，没必要每次都连一次 ssh。
     *
     * 分页是**服务端**做的（`offset`），不是把 1000 条全拉到前端再切：
     * 那样「每页 20 条」也得先传 1000 行，而且「共 N 条」会和实际看到的不一致。
     */
    async function loadUsage(opts) {
        opts = opts || {};
        // ★ 请求序号：连着点 4 个筛选框会**并发**发出 4 个请求，而它们回来的顺序
        //   不保证。谁先发起不代表谁先到达 —— 早发的慢请求晚到，就会把新结果
        //   覆盖成旧的，看起来像「筛选没生效 / 数字乱跳」。
        //   实测踩到：全不勾本该是 174 条，屏幕上却停在 112（某个中间态的结果）。
        //   办法很土但可靠：只认**最后一次发起**的那个请求，早到的旧结果直接丢掉。
        const seq = ++usageSeq;
        try {
            const size = state.pageSize;
            const qs = new URLSearchParams({
                limit: String(size),
                offset: String(state.page * size),
            });
            if (opts.pull) qs.set('pull', '1');
            if (usageF.existing) qs.set('existing', '1');
            // ★ bname 必须和 facets 用同一个值：列表里显示 `Edge`，筛选值也就是
            //   `Edge`；若这里漏发，服务端会拿去和 `Edge 155.0.0.0` 比 → 静默 0 条。
            if (usageF.bname) qs.set('bname', '1');
            const t = usageF.time;
            if (t.preset === 'custom') {
                if (t.from !== '') qs.set('from', String(t.from));
                if (t.to !== '') qs.set('to', String(t.to));
            } else if (t.preset) {
                qs.set('since', t.preset);
            }
            if (usageF.result.size) qs.set('result', [...usageF.result].join(','));
            if (usageF.pwid.size) qs.set('id', [...usageF.pwid].join(','));
            if (usageF.ip.size) qs.set('ip', [...usageF.ip].join(','));
            if (usageF.browser.size) qs.set('browser', [...usageF.browser].join(','));
            if (usageF.osdev.size) qs.set('os', [...usageF.osdev].join(','));

            const data = await api('/api/usage?' + qs.toString());

            // 已经有更新的请求在飞了 → 这份是过期结果，直接丢掉（连渲染都不做）。
            if (seq !== usageSeq) return null;

            // 筛选后条数变少时，当前页可能已经越界（原来的第 4 页现在只有 2 页）。
            // 自动退到最后一页重取一次；只重试一次，免得来回抖。
            if (!opts._clamped && data && !Array.isArray(data)
                    && data.matched > 0 && data.offset >= data.matched) {
                state.page = Math.max(0, Math.ceil(data.matched / state.pageSize) - 1);
                // 重试不再拉取：这一趟只是为了把页码对正，没必要再连一次 ssh
                return loadUsage(Object.assign({}, opts, { _clamped: true, pull: false }));
            }

            // 兼容两种形状：新的 {rows,total,matched} 与旧的裸数组
            if (Array.isArray(data)) renderUsage(data, { total: data.length, matched: data.length });
            else {
                renderUsage(data.rows, data);
                renderFresh(data);
            }
            refreshColButtons();
            // 拉到新数据后，列头面板里的「可选值 + 条数」也该跟着变
            if (opts.pull && data && data.pull_count > 0) loadUsageFacets();
            $('usage-clear').hidden = !anyUsageFilter();
            return data;
        } catch (e) {
            toast('读取访问记录失败：' + e.message, true);
            return null;
        }
    }

    /** 筛选条件变了 → 一定回到第 1 页。留在第 4 页会看到「空白页」，像坏了。 */
    function reloadFirstPage() {
        state.page = 0;
        return loadUsage();
    }

    // ── 自动刷新（"实时"） ────────────────────────────────────────
    //
    // 日志只存在于**服务器**上，本地拿不到任何推送：`ssh tail` 是唯一途径。
    // 所以「实时」= 定时去拉。三条约束让它不至于像个刷屏脚本：
    //   ① 切到别的标签页（`document.hidden`）→ 这一轮跳过；切回来立刻补一次；
    //   ② 写操作正在进行（push / 改密码…）→ 跳过，别去抢同一台机器的 ssh；
    //   ③ 服务端还有一层兜底（单飞 + 至少隔 2 秒），两个标签页同时开也不会并发。
    // 用 `setTimeout` 链而不是 `setInterval`：下一次要等这一次跑完才排，
    // 拉取比间隔慢的时候不会堆积。
    let autoTimer = null;
    let usageBusy = false;
    //: /api/usage 请求序号。只认最后一次发起的那个（见 loadUsage 里的说明）。
    let usageSeq = 0;

    //: 服务端说「这次没拉」时的原因 → 人话
    const SKIP_TEXT = {
        gap: '刚刚已经拉过了（2 秒内不重复连服务器）',
        busy: '上一次拉取还没结束',
        exec: '有别的操作正在跑，等它结束再拉',
        disabled: '自动拉取已关闭（启动时加了 --no-pull）',
    };

    /** 下一次自动刷新在多少毫秒之后。0 = 现在不排（暂停中，或间隔填了 0）。 */
    function autoMs() {
        if (state.autoPaused) return 0;
        return Math.max(0, state.autoSec) * 1000;
    }

    /** 暂停按钮的文案/状态。**改完一定调它**，否则界面会说「还在跑」而其实没跑。 */
    function renderAutoBtn() {
        const b = $('usage-auto-toggle');
        if (!b) return;
        b.textContent = state.autoPaused ? '▶ 继续自动刷新' : '⏸ 暂停自动刷新';
        b.setAttribute('aria-pressed', state.autoPaused ? 'true' : 'false');
        b.title = state.autoPaused
            ? ('点一下继续（间隔 ' + state.autoSec + ' 秒），并立刻拉一次最新的')
            : '暂停后就不再自动拉了；手动「立即刷新」随时可用';
    }

    /** 暂停 / 继续。恢复时顺手拉一份最新的，否则要干等到下一个间隔。 */
    function setAutoPaused(paused) {
        state.autoPaused = !!paused;
        renderAutoBtn();
        if (state.autoPaused) {
            stopAuto();
            flash('已暂停自动刷新（点「▶ 继续自动刷新」恢复）');
            return;
        }
        startAuto();
        // 恢复时顺手拉一份最新的——不然要干等到下一个间隔，那和「暂停」没区别。
        // 拉到了同样在顶部说一声。
        loadUsage({ pull: true }).then((d) => {
            if (d && !d.pull_error && !d.pull_skip_reason) {
                flash('已刷新 · ' + hhmmss(Date.now() / 1000));
            }
        });
    }

    function stopAuto() {
        if (autoTimer) clearTimeout(autoTimer);
        autoTimer = null;
    }

    function startAuto() {
        stopAuto();
        if (!autoMs()) return;      // 暂停中 / 间隔是 0 → 不排下一轮
        const tick = async () => {
            autoTimer = null;
            // ★ 翻到第 2 页以后就**不再自动刷新**：新记录插在最前面，会让
            //   你正在看的那一页整体往后挪，读到一半内容突然换掉。
            //   回到第一页时下面会立刻补一次，所以不会漏。
            const blocked = document.hidden || state.writing || usageBusy
                || state.page > 0 || document.querySelector('dialog[open]');
            if (!blocked) {
                usageBusy = true;
                try {
                    const data = await loadUsage({ pull: true });
                    // 拉到了就在顶部说一声（3 秒）。没拉到（被闸门挡了）不说——
                    // 自动刷新最常见的情况就是「什么都没发生」，那是正常的。
                    if (data && !data.pull_error && !data.pull_skip_reason) {
                        flash('已刷新 · ' + hhmmss(Date.now() / 1000));
                    }
                } finally {
                    usageBusy = false;
                }
            }
            if (autoMs()) autoTimer = setTimeout(tick, autoMs());
        };
        autoTimer = setTimeout(tick, autoMs());
    }

    /** 点按钮：立刻拉一次，并把「为什么没拉 / 拉失败」直接说给用户。 */
    async function manualRefresh() {
        const btn = $('usage-refresh');
        if (btn.disabled) return;
        const label = btn.textContent;
        btn.disabled = true;
        btn.textContent = '刷新中…';
        try {
            const data = await loadUsage({ pull: true });
            if (!data) return;
            if (data.pull_error) toast(data.pull_error, true);
            else if (data.pull_skip_reason) {
                toast(SKIP_TEXT[data.pull_skip_reason] || '这次没有重新拉取');
            } else if (data.pull_count) {
                toast('已从服务器拉取最新记录');
                // 顶部也给一声。toast 在右下角、3 秒就消失；而「刚才到底更新了没」
                // 是刷日志时最常问的一件事，所以两个地方都留个痕。
                flash('已刷新 · ' + hhmmss(Date.now() / 1000));
            }
        } finally {
            btn.disabled = false;
            btn.textContent = label;
        }
    }

    // ── 写操作 ──────────────────────────────────────────────────

    /**
     * 口令错了 → 可以原地重输。
     *
     * ★ 只认「管理口令不正确」。别写成 `/管理口令/`：那样
     *   「服务器上没有管理口令，无法执行…」也会被当成口令错，于是重输一辈子
     *   都不会成功（那种情况该去 admin-init，不是重打口令）。
     */
    function adminWrong(out) {
        return /管理口令不正确/.test(out || '');
    }

    /** 从 CLI 报错里挑出「口令错」那句当提示（去掉 `错误：` 前缀与 markdown 星号）。 */
    function adminHint(out) {
        const line = (out || '').split('\n').find((s) => /管理口令不正确/.test(s));
        return (line || '管理口令不正确。')
            .replace(/^\s*错误[:：]\s*/, '')
            .replace(/\*\*/g, '')
            .trim();
    }

    /**
     * 统一入口：要口令 → 调后端 → 显示输出 → 刷新。
     * 返回 CLI 的 {ok, code, out}；被用户取消则返回 null。
     *
     * ★ 口令被拒时**不退出**，而是带着提示回到问口令那一步。`params` 与
     *   `actionText` 全程没动过，所以之前填的表单不会白填——用户只需要
     *   重打一次口令。这是用户 2026-10-17 的直接反馈：「不然前面操作都白弄了」。
     *   只有用户自己点「取消」才会中止。
     */
    async function runWrite(op, params, actionText, opts) {
        opts = opts || {};
        let hint = '';
        for (;;) {
            const admin = await askAdmin(actionText, hint);
            if (admin === null) return null;

            const body = Object.assign({}, params, { admin: admin });
            let r;
            // 这一小段是真正跑子进程的窗口（可能要 push / ssh 好几秒）：
            // 期间暂停自动刷新，别让「拉日志」去抢同一台机器的 ssh。
            state.writing = true;
            try {
                r = await exec(op, body);
            } catch (e) {
                toast(e.message, true);
                return null;
            } finally {
                state.writing = false;
            }

            if (r.ok) {
                if (opts.showOutput) showOutput(actionText, r.out, false);
                await loadAll();
                return r;
            }

            if (adminWrong(r.out)) {
                // 记住的那份既然是错的，清掉，否则下一轮又会静默复用
                state.admin = '';
                hint = adminHint(r.out);
                continue;
            }

            showOutput(actionText + ' — 失败', r.out, true);
            toast('操作失败，看下面的输出', true);
            return r;
        }
    }

    /** 从 CLI 输出里取明文密码（命令是 `  密码  : xxx`）。 */
    function grabSecret(out) {
        const m = /^\s*密码\s*[:：]\s*(.+)$/m.exec(out || '');
        return m ? m[1].trim() : '';
    }
    function grabId(out) {
        const m = /^\s*id\s*[:：]\s*([0-9a-f]+)\s*$/m.exec(out || '');
        return m ? m[1] : '';
    }

    /** 有效期选择：返回 {kind, value} 或 null。
     *
     * 注：这里曾经把「小时」换算成小数天数再下发，因为 CLI 的 `add` 里 `has_exp`
     * 漏判了 `--hours`（`add --hours 6` 会被静默忽略）。那个 bug 已于
     * 2026-10-17 修好（`expiry_given()` 成为「哪些参数算有效期」的唯一来源），
     * 所以现在直接传 `--hours`，语义清楚、不再绕一层。
     */
    async function askExpiry(current) {
        const v = await openDialog({
            title: '设置有效期',
            fields: [
                {
                    name: 'mode', label: '方式', type: 'select', value: 'keep',
                    options: [
                        { value: 'keep', label: '保持不变' },
                        { value: 'hours', label: '按小时' },
                        { value: 'days', label: '按天' },
                        { value: 'until', label: '到某天结束（UTC）' },
                        { value: 'never', label: '永久（不过期）' },
                    ],
                },
                { name: 'value', label: '数值（按小时/按天时填，支持小数）', type: 'text', placeholder: '例如 6 或 0.5' },
                { name: 'date', label: '日期（选「到某天」时填）', type: 'date' },
            ],
            okText: '设置',
        });
        if (!v) return null;
        if (v.mode === 'keep') return { kind: 'keep' };
        if (v.mode === 'never') return { kind: 'never' };
        if (v.mode === 'hours') {
            const h = parseFloat(v.value);
            if (!isFinite(h) || h <= 0) { toast('小时数要是正数', true); return null; }
            return { kind: 'hours', value: String(h) };
        }
        if (v.mode === 'days') {
            if (!v.value || !isFinite(parseFloat(v.value))) { toast('天数要是数字', true); return null; }
            return { kind: 'days', value: v.value };
        }
        if (v.mode === 'until') {
            if (!v.date) { toast('请选一个日期', true); return null; }
            return { kind: 'until', value: v.date };
        }
        return null;
    }

    async function doAdd() {
        if (state.overview && !state.overview.initialized) {
            const r = await exec('init', {});
            if (!r.ok) {
                showOutput('初始化失败', r.out, true);
                toast('初始化失败', true);
                return;
            }
            toast('已初始化本地密码表');
        }

        const v = await openDialog({
            title: '新增密码',
            note: '密码**默认随机生成**（只显示这一次）。想自己定就在下面填，留空则随机。',
            fields: [
                { name: 'label', label: '标签（给谁用 / 用途）', type: 'text', placeholder: '例如：给小明' },
                { name: 'note', label: '备注', type: 'text', placeholder: '可选' },
                {
                    name: 'newpw', label: '自定义密码（留空 = 随机生成）',
                    type: 'password', placeholder: '至少 12 位；留空则按下面的长度随机',
                },
                { name: 'len', label: '随机密码长度（仅在上一格留空时用）', type: 'number', value: '24', min: '8', max: '128' },
                {
                    name: 'exp', label: '有效期', type: 'select', value: 'never',
                    options: [
                        { value: 'never', label: '永久' },
                        { value: '7', label: '7 天' },
                        { value: '30', label: '30 天' },
                        { value: '1', label: '1 天' },
                    ],
                },
            ],
            okText: '生成并保存',
        });
        if (!v) return;

        // ★ newpw 为空就**不传** —— CLI 的 _read_new_password 没拿到
        //   --password-stdin 时会自己随机生成。传一个空串反而会被
        //   _check_min_pw 拒掉（少于 12 位）。
        const params = { label: v.label, note: v.note, len: v.len };
        if (v.newpw) params.newpw = v.newpw;
        params.expiry = v.exp === 'never'
            ? { kind: 'never' }
            : { kind: 'days', value: v.exp };

        const r = await runWrite('add', params, '新增密码', { showOutput: true });
        if (!r || !r.ok) return;
        const pw = grabSecret(r.out);
        await showSecret(pw, grabId(r.out));
        // 关掉「只显示这一次」后顺手清掉命令输出弹窗：那份 CLI 原样输出里带着
        // 同一串明文，留着就等于「只显示这一次」是句空话。
        clearOutput();
    }

    async function doPasswd(e) {
        const v = await openDialog({
            title: '轮换密码：' + (e.label || e.id),
            note: '轮换后这条密码的所有在线会话会立即失效。新密码只显示一次。',
            noteBad: true,
            fields: [
                {
                    name: 'newpw', label: '自定义新密码（留空 = 随机生成）',
                    type: 'password', placeholder: '至少 12 位；留空则按下面的长度随机',
                },
                { name: 'len', label: '随机密码长度（仅在上一格留空时用）', type: 'number', value: '24', min: '8', max: '128' },
            ],
            okText: '轮换',
            danger: true,
        });
        if (!v) return;
        // ★ newpw 留空就**不传** —— CLI 会自己随机生成（和命令行
        //   `cms passwd <id>` 的行为一致）。传空串会被 _check_min_pw 拒掉。
        const params = { id: e.id, len: v.len };
        if (v.newpw) params.newpw = v.newpw;
        const r = await runWrite('passwd', params, '轮换密码', { showOutput: true });
        if (!r || !r.ok) return;
        await showSecret(grabSecret(r.out), grabId(r.out) || e.id);
        clearOutput();                          // 同上：新密码不该留在弹窗里
    }

    async function doRm(e) {
        const ok = await confirmDanger(
            '删除密码：' + (e.label || e.id),
            '删除后这条密码的在线会话会立即失效，且**无法恢复**（只能重新建一条，旧密码不能再用）。'
            + '如果只是暂时不想让人进，用「禁用」更好。',
            '删除',
        );
        if (!ok) return;
        await runWrite('rm', { id: e.id }, '删除密码', { showOutput: true });
    }

    async function toggleEnabled(e) {
        const op = e.enabled ? 'disable' : 'enable';
        await runWrite(op, { id: e.id }, e.enabled ? '禁用密码' : '启用密码', { showOutput: true });
    }

    async function doExpire(e) {
        const exp = await askExpiry();
        if (!exp) return;
        if (exp.kind === 'keep') return;
        await runWrite('expire', { id: e.id, expiry: exp }, '设置有效期', { showOutput: true });
    }

    async function doNote(e) {
        const v = await openDialog({
            title: '改标签 / 备注：' + (e.label || e.id),
            fields: [
                { name: 'label', label: '标签', type: 'text', value: e.label },
                { name: 'note', label: '备注', type: 'text', value: e.note },
            ],
            okText: '保存',
        });
        if (!v) return;
        await runWrite('note', { id: e.id, label: v.label, note: v.note }, '改标签备注', { showOutput: true });
    }

    /** 详情：表格里已有的字段先画出来，再补 CLI 输出与这条密码自己的访问记录。
     *
     * 以前是 showOutput() 写进页面最底部的输出卡片 —— 用户点了看不到任何变化，
     * 体感就是「详情点不动」。现在放对话框里，且**先画后取**：
     * 骨架立刻出现，网络慢也只是里面慢。
     */
    async function doShow(e) {
        await openInfoDialog({
            title: '详情：' + (e.label || e.id),
            okText: '关闭',
            fill: async (body) => {
                // ① 零延迟：这些字段列表请求里已经有了
                body.append(kvBlock([
                    ['标签', e.label],
                    ['备注', e.note],
                    ['id', e.id],
                    ['状态', e.state],
                    ['有效期', e.expiry],
                    ['最近使用', e.last],
                    ['成功 / 失败', (e.ok || 0) + ' / ' + (e.fail || 0)],
                ]));

                // ② 需要现取的两块，先放占位文字
                const outBox = el('pre', 'dlg-pre', '读取中…');
                const useBox = el('p', 'dlg-empty', '读取中…');
                const secOut = el('div', 'dlg-sec');
                secOut.append(el('div', 'dlg-sec-title', 'CLI show 输出'), outBox);
                const secUse = el('div', 'dlg-sec');
                secUse.append(el('div', 'dlg-sec-title', '这条密码的访问记录（最近 20 条）'), useBox);
                body.append(secOut, secUse);

                const [r, usage] = await Promise.all([
                    exec('show', { id: e.id }).catch((err) => ({ ok: false, out: err.message })),
                    // 这个接口现在回 {rows,total,matched}（筛选在服务端做）；
                    // 兼容裸数组，免得接口若回退就整个详情读不出来。
                    api('/api/usage?limit=20&id=' + encodeURIComponent(e.id))
                        .then((d) => (Array.isArray(d) ? d : d.rows))
                        .catch(() => null),
                ]);

                outBox.textContent = (r.out || '(无输出)').trim();
                if (!r.ok) outBox.classList.add('bad');

                if (usage === null) {
                    useBox.textContent = '读取访问记录失败。';
                    useBox.classList.add('bad');
                } else if (!usage.length) {
                    useBox.textContent = '本地没有它的记录。点「立即刷新」从服务器拉一份再看。';
                } else {
                    useBox.replaceWith(usageMiniTable(usage));
                }
            },
        });
    }

    /** 差异表（新增 / 删除 / 修改）。说明那一列允许换行，否则会被挤成一条长线。 */
    function diffTable(rows) {
        const kindText = { added: '新增', removed: '删除', changed: '修改' };
        const kindCls = { added: 'on', removed: 'off', changed: 'exp' };
        const wrap = el('div', 'mini-wrap');
        const t = el('table', 'grid mini');
        const thead = el('thead');
        const hr = el('tr');
        ['', '标签', 'id', '说明'].forEach((h) => hr.append(el('th', null, h)));
        thead.append(hr);
        const tbody = el('tbody');
        for (const r of rows) {
            const tr = el('tr');
            const tdKind = el('td');
            tdKind.append(el('span', 'tag ' + (kindCls[r.kind] || ''), kindText[r.kind] || r.kind));
            tr.append(
                tdKind,
                el('td', null, r.label || '—'),
                el('td', 'id-cell', r.id),
                el('td', 'wrap-cell', r.detail || ''),
            );
            tbody.append(tr);
        }
        t.append(thead, tbody);
        wrap.append(t);
        return wrap;
    }

    /** 小圆角标签（计数用）。 */
    function countChip(text, cls) {
        return el('span', 'chip' + (cls ? ' ' + cls : ''), text);
    }

    /**
     * 点顶栏「同步」芯片 → 逐条列出本地和线上差在哪。
     *
     * 只有「有改动未推送」四个字的话，谁也不知道改了什么。这里直接拿**线上那份**
     * 逐条比：新增 / 删除 / 修改，并说清「推送后会发生什么」。
     * 比对在服务端做，密码哈希不会传到这里。
     */
    async function doSync() {
        const action = await openInfoDialog({
            title: '本地 vs 线上：到底差在哪',
            okText: '关闭',
            fill: async (body, ctl) => {
                const ov = state.overview || {};
                const ps = ov.push_state;
                body.append(kvBlock([
                    ['推送记录', ps === 'clean' ? '上次推送之后没再改过'
                        : (ps === 'pending' ? '有改动未推送' : '没有推送记录（从没推过或标记丢了）')],
                    ['本地 gen', (ov.gen === null || ov.gen === undefined) ? '—' : ov.gen],
                ]));

                const box = el('p', 'dlg-empty', '正在连服务器逐条比对…');
                const sec = el('div', 'dlg-sec');
                sec.append(el('div', 'dlg-sec-title', '逐条差异'), box);
                body.append(sec);

                let d;
                try {
                    d = await api('/api/push_diff');
                } catch (e) {
                    box.textContent = '比对失败：' + e.message;
                    box.classList.add('bad');
                    return;
                }
                if (!d.reachable) {
                    box.textContent = '连不上服务器，没法和线上那份逐条比对：'
                        + (d.error || '未知原因')
                        + '\n（能连上时，这里会列出每条新增 / 删除 / 修改。）';
                    box.classList.add('bad');
                    return;
                }

                const c = d.counts || {};
                const pending = (c.added || 0) + (c.removed || 0) + (c.changed || 0);

                const chips = el('div', 'chips inline-chips');
                chips.append(
                    countChip('新增 ' + (c.added || 0), c.added ? 'ok' : ''),
                    countChip('删除 ' + (c.removed || 0), c.removed ? 'bad' : ''),
                    countChip('修改 ' + (c.changed || 0), c.changed ? 'warn' : ''),
                    countChip('未变 ' + (c.same || 0)),
                );

                const frag = document.createDocumentFragment();
                frag.append(chips);

                if (d.remote_missing) {
                    frag.append(el('p', 'dlg-empty',
                        '线上还没有密码表 —— 这次推送是第一次，本地每一条都算新增。'));
                } else if (!pending) {
                    frag.append(el('p', 'dlg-empty',
                        '逐条比下来没有差异。若芯片还显示「有改动未推送」，'
                        + '多半只是格式/空白差异，推送一次会把标记同步掉。'));
                }

                if (pending) frag.append(diffTable(d.rows));

                // gen 是最容易出事的一项：推低了会让已被踢掉的旧会话重新生效
                if (d.local_gen !== null && d.remote_gen !== null && d.local_gen !== d.remote_gen) {
                    const p = el('p', 'dlg-empty');
                    p.append(el('b', null, 'gen 不一致：'));
                    p.append(document.createTextNode(
                        '本地 ' + d.local_gen + ' / 线上 ' + d.remote_gen
                        + (d.local_gen < d.remote_gen
                            ? '。推低 gen 不是踢人，而是让**已被踢掉的旧会话重新生效**——工具会拒绝，先 pull 再改。'
                            : '。推送后线上会变成 ' + d.local_gen + '。')));
                    frag.append(p);
                }

                // 标记说「已同步」但线上其实不一样 —— .pushed 只看本机，看不见别的机器
                if (d.marker_clean && pending) {
                    const p = el('p', 'dlg-empty');
                    p.append(el('b', null, '注意：'));
                    p.append(document.createTextNode(
                        '本机的推送记录和当前文件一致，但线上那份不一样。'
                        + '通常是**另一台机器推过**（或者有人直接改了服务器上的文件）。'));
                    frag.append(p);
                }

                if (pending) {
                    const go = el('button', 'primary', '去推送这 ' + pending + ' 项改动');
                    go.type = 'button';
                    go.addEventListener('click', () => ctl.close('push'));
                    frag.append(go);
                }
                box.replaceWith(frag);
            },
        });
        if (action === 'push') await doPush();
    }

    // ── 全局操作 ────────────────────────────────────────────────

    async function doPush() {
        const ok = await confirmDanger(
            '推送到服务器',
            '会把本地密码表整体覆盖到服务器，**立即对所有人生效**。'
            + '本地表里没有的密码，线上会消失。',
            '推送',
        );
        if (!ok) return;
        await runWrite('push', {}, '推送到服务器', { showOutput: true });
    }

    async function doPull() {
        const ok = await confirmDanger(
            '从服务器拉取',
            '会用服务器那份**覆盖本地**。本地还没推送的新条目会被丢掉。'
            + '要保住它们，先推送再拉取。',
            '拉取',
        );
        if (!ok) return;
        const r = await runWrite('pull', {}, '从服务器拉取', { showOutput: true });
        if (r && r.ok) await loadAll();
    }

    async function doRevokeAll() {
        const ok = await confirmDanger(
            '踢掉所有在线会话',
            '把 gen 加一，让**所有**在线会话立即失效——包括你自己此刻开着的浏览器。'
            + '推送到服务器后，每个人都得重新输密码。',
            '踢掉所有人',
        );
        if (!ok) return;
        await runWrite('revoke-all', {}, '踢掉所有在线会话', { showOutput: true });
    }

    async function doGate() {
        const on = !(state.remote && state.remote.gate_on);
        const ok = await confirmDanger(
            on ? '打开闸门（访问需要密码）' : '关闭闸门（任何人直接进入）',
            on
                ? '打开后，未登录的访客只能看到密码页。'
                : '关闭后，**任何人**打开这个网址都能直接进游戏，不再需要密码。'
                  + '除非你很确定，否则不要关。',
            on ? '打开闸门' : '关闭闸门',
        );
        if (!ok) return;
        await runWrite(on ? 'gate_on' : 'gate_off', {}, on ? '打开闸门' : '关闭闸门', { showOutput: true });
        await loadRemote();
    }

    async function doLanding() {
        const cur = state.landing && state.landing.mode;
        const toLearn = cur !== 'learn';
        const ok = await confirmDanger(
            toLearn ? '默认页切到学习站' : '默认页切到开放站',
            toLearn
                ? '切换后，**所有人**打开根路径都会 302 到公开学习站 /learn/；'
                  + '游戏在 /game，持有效会话的人照常能玩；其余路径一律 404。'
                : '切换后，根路径与未定义路径都 302 到 /game；游戏本身仍要登录，'
                  + '未登录看到的是 404「当作不存在」。',
            toLearn ? '切到学习站' : '切到开放站',
        );
        if (!ok) return;
        await runWrite(toLearn ? 'landing_learn' : 'landing_game', {},
            toLearn ? '默认页切到学习站' : '默认页切回游戏', { showOutput: true });
        await loadLanding();
    }

    // ── 秘密登录入口 ────────────────────────────────────────────
    //
    // 404 模型下 /gate/ 本身不再对外（未登录看到的是「没这个文件」），
    // 登录页只挂在一条随机路径 /gate/<TOKEN>/ 上。所以：
    //   ① 这个地址必须在界面里看得见 —— 看不见就等于谁都进不去；
    //   ② 必须能换（轮换要管理口令）—— 链接漏给不该要的人时要有办法关掉。
    // 真正的活全部转调 cms gate-path（原子写 + nginx -t + 回滚 + 审计都在 CLI）。
    async function copyText(text, what) {
        try {
            await navigator.clipboard.writeText(text);
            toast('已复制' + (what || '内容'));
        } catch (e) {
            // 复制不了也要让人看到全文：toast 里显示，手抄即可。
            toast('复制失败，请手动选中：' + text, true);
        }
    }

    async function doGatePath() {
        const cur = state.gatePath || {};
        const v = await openDialog({
            title: '登录入口（秘密网址）',
            note: '当前入口：' + (gateUrl() || cur.path || '（片段缺失，现在没人能登录）')
                + ' —— 已登录的人打开入口会直接进 /game，未登录才看到密码页；'
                + '换入口后旧链接立刻失效，收藏过的人要重新给地址。',
            fields: [
                {
                    name: 'mode', label: '怎么做', type: 'select', value: 'copy',
                    options: [
                        { value: 'copy', label: '复制完整网址（站点地址+入口路径，可直接发给人）' },
                        { value: 'rotate', label: '随机换一条（推荐）' },
                        { value: 'set', label: '自己指定一条' },
                    ],
                },
                { name: 'token', label: '新 token（仅在「自己指定」时用）', type: 'text',
                  placeholder: '12~32 位，只能小写字母和数字，例如 a7f3c91b2d4e' },
            ],
            okText: '继续',
        });
        if (!v) return;
        if (v.mode === 'copy') {
            const u = gateUrl();
            if (u) await copyText(u, '入口网址');
            else toast('读不到当前入口（片段缺失或 SSH 失败）', true);
            return;
        }
        let op = 'gate_path_rotate';
        let token = '';
        if (v.mode === 'set') {
            token = String(v.token || '').trim();
            // 本地先按 CLI 同一道白名单过一遍：**只为省一次白输的管理口令**，
            // 真正的把关在 CLI（形状不对绝不会碰 nginx 配置）。
            if (!/^[a-z0-9]{12,32}$/.test(token)) {
                toast('token 只能是 12~32 位小写字母或数字（现在：' + (token || '空') + '）', true);
                return;
            }
            op = 'gate_path_set';
        }
        const ok = await confirmDanger(
            op === 'gate_path_rotate' ? '轮换登录入口' : '更换登录入口',
            '这会改写服务器上的 nginx 片段并 reload（nginx -t 不通过会自动回滚）。<br>'
            + '换完 /gate/<旧 token>/ **立刻失效**，新入口要用新地址告诉别人。',
            op === 'gate_path_rotate' ? '随机换一条' : '换成这条',
        );
        if (!ok) return;
        const r = await runWrite(op, op === 'gate_path_set' ? { token: token } : {},
            op === 'gate_path_rotate' ? '轮换登录入口' : '更换登录入口', { showOutput: true });
        if (r && r.ok) {
            await loadGatePath();
            const nu = gateUrl();
            if (nu) await copyText(nu, '新入口网址');
        }
    }

    // ── 网页背景图 ──────────────────────────────────────────────
    //
    // 背景图的**公开使用授权还没拿到**，所以线上必须能「一键撤下成白底」。
    // 这里做的是**服务器上换文件**（白图覆盖 + 原图挪进非公开目录），
    // 不是在前端加开关——后者 wget 照样能拿到原图。
    //
    // ⚠️ 两件用户必须知道的事，界面里也要写出来：
    //   ① 已经把图加载进来的浏览器，内存里仍有那张图，撤不回来（浏览器行为）。
    //      新访问 / 刷新才会看到白底。
    //   ② 又跑 deploy-web.sh 会把本地图 rsync 回去，等于重新「开」。
    //      所以对话框里每次都显示「当前与记录是否一致」。

    /** 把状态画成一行行的键值。 */
    function webbgRows(w) {
        const rows = [];
        rows.push(['当前状态', w.mode === 'off' ? '关 —— 纯白底'
            : (w.mode === 'on' ? '开 —— 显示背景图' : '从未操作过（默认开）')]);
        rows.push(['网站根目录', w.web_root || '—']);
        const f = w.files || {};
        for (const k of Object.keys(f)) {
            const v = f[k] || {};
            rows.push([k, v.present
                ? `${(v.size || 0).toLocaleString()} 字节`
                : '不存在']);
        }
        if (w.source) rows.push(['最近来源', w.source]);
        // 原图存到了服务器上（日后想换个尺寸重转时不用再找）。
        // 只显示路径 + 大小，不给下载入口 —— 原图可能几 MB，且这条路径在
        // nginx 不服务的目录里，界面上也拿不到。
        if (w.source_kept) {
            rows.push(['原图已存服务器',
                w.source_kept + (w.source_bytes
                    ? `（${Number(w.source_bytes).toLocaleString()} 字节）` : '')]);
        }
        // ★ 时间已经是**本地时间**了（服务端过了 gm.iso_to_local）。
        //   这里以前还做了一次 `.slice(0,19)` 截断 —— 服务端改回 UTC 之前，
        //   那是把 UTC 串当本地显示，东八区整整差 8 小时。
        //   现在只做排版：去掉 T、补上时区标注，让人一眼知道这是当地时间。
        if (w.at) rows.push(['上次改动', w.at + '（本机时间）']);
        rows.push(['私藏备份', (w.backups && w.backups.length) ? w.backups.join('、') : '（没有）']);
        return rows;
    }

    /**
     * 背景图预览 + 下载。
     *
     * `src` 用的是**本机 cmsui** 的 /api/webbg_image（不是线上那个公开 URL）——
     * 后者会把本机地址与线上地址的关系摆到页面里，而且撤下之后那张 URL
     * 永远是白图，就预览不到原图了。
     */
    function webbgPreview(w) {
        const box = el('div', 'wb-prev');
        const webp = w.files && w.files['assets/bg.webp'];
        const jpg = w.files && w.files['assets/bg.jpg'];
        const have = (webp && webp.present) || (jpg && jpg.present);

        const shot = el('div', 'wb-shot');
        const img = el('img', 'wb-img');
        img.alt = '当前网页背景图预览';
        // 加一个随机数：每次打开对话框都重新取，不吃浏览器缓存。
        const bust = '&t=' + Date.now();
        img.src = webp && webp.present
            ? '/api/webbg_image?which=webp' + bust
            : (jpg && jpg.present ? '/api/webbg_image?which=jpg' + bust : '');
        // 取不到（ssh 失败 / 文件被换掉）就明说，不能留一个裂图让人以为背景图坏了。
        img.addEventListener('error', () => {
            shot.replaceChildren(el('p', 'dlg-note bad',
                '预览取不到（服务器没回图片）。这不代表线上背景图坏了 —— '
                + '只是这个界面暂时拿不到，本机到服务器那一段有问题。'));
        });
        shot.append(img);
        if (jpg && jpg.present) {
            shot.append(el('p', 'hint',
                '预览用 webp（游戏画布那张）。密码页与老浏览器用的是下面那个 jpg。'));
        }
        box.append(shot);

        const acts = el('div', 'dlg-acts');
        const mkDl = (which, label, title) => {
            const b = el('button', '', label);
            b.type = 'button';
            b.title = title;
            b.addEventListener('click', () => {
                // 走 <a download>：让浏览器自己处理保存，不开新标签页。
                const a = document.createElement('a');
                a.href = '/api/webbg_image?which=' + which + '&download=1&t=' + Date.now();
                a.download = which === 'jpg' ? 'bg.jpg' : 'bg.webp';
                document.body.append(a);
                a.click();
                a.remove();
            });
            return b;
        };
        acts.append(mkDl('webp', '下载 webp', '游戏画布用的那张（更小）'));
        acts.append(mkDl('jpg', '下载 jpg', '密码页与老浏览器用的那张'));
        box.append(acts);

        if (!have) {
            box.append(el('p', 'dlg-note bad', '线上两个文件都不在，没有可预览的图。'));
        }
        return box;
    }

    async function doWebBg() {
        state.pickedBg = null;
        state.targets = { web: true, desktop: true };   // 每次打开都全勾
        const action = await openInfoDialog({
            title: '网页背景图',
            okText: '关闭',
            fill: (body, ctl) => {
                if (!state.webbg || !state.webbg.reachable) {
                    body.append(el('p', 'dlg-empty bad',
                        '读不到服务器上的背景图状态：'
                        + ((state.webbg && state.webbg.error) || '未知原因')));
                    return;
                }
                const w = state.webbg;
                body.append(kvBlock(webbgRows(w)));
                // 预览放在状态表**下面**：先知道开关状态，再看图长什么样。
                // （预览走的是本机的 /api/webbg_image，一次 ssh ≈ 1 秒。）
                body.append(el('p', 'dlg-label', '线上现在这张图'));
                body.append(webbgPreview(w));

                if (w.drifted) {
                    body.append(el('p', 'dlg-note bad',
                        '记录与线上实际不一致 —— 多半是之后又跑过 deploy-web.sh'
                        + '（rsync --delete 会把本地图同步回去）。'
                        + '点下面的按钮可以对齐。'));
                }

                const notes = [
                    '**关掉 = 游戏与密码页都变成纯白底**，原图挪到 nginx 不服务的目录。',
                    '已经加载过图的浏览器内存里仍有旧图（撤不回来），访客**刷新**后才变白。',
                    '以后再跑 deploy-web.sh 会把背景图同步回去（等于又「开」了）。',
                ];
                for (const t of notes) body.append(el('p', 'dlg-note', t));

                const acts = el('div', 'dlg-acts');
                // 关
                const bOff = el('button', 'danger', '撤下背景图（白底）');
                bOff.type = 'button';
                bOff.disabled = w.mode === 'off';
                bOff.title = '游戏与密码页都换成纯白底；原图挪到非公开目录，可一键恢复';
                bOff.addEventListener('click', () => ctl.close('off'));
                // 开
                const bOn = el('button', '', '恢复背景图');
                bOn.type = 'button';
                bOn.disabled = !w.can_restore;
                bOn.title = w.can_restore ? '把私藏的原图放回网站目录'
                    : '私藏目录里没有原图（只能推一张新的）';
                bOn.addEventListener('click', () => ctl.close('on'));
                acts.append(bOff, bOn);
                body.append(acts);

                // ── 推送新图 ──
                body.append(el('p', 'dlg-note',
                    '推送新图：上传前会先在浏览器里缩到长边 '
                    + `${BG_MAX_EDGE}，然后转成 webp + jpg 再上传并**启用**。`
                    + '（密码页与老浏览器都靠 jpg，所以两张必须一起换。）'));
                const pick = el('label', 'field');
                pick.append(el('span', null,
                    `选择图片（png / jpg / webp，≤ ${Math.round(BG_UPLOAD_MAX / 1024 / 1024)} MB）`));
                const file = document.createElement('input');
                file.type = 'file';
                file.accept = 'image/*';
                file.addEventListener('change', () => {
                    state.pickedBg = (file.files && file.files[0]) || null;
                    bPush.disabled = !state.pickedBg;
                    const f = state.pickedBg;
                    if (!f) { hint.textContent = ''; return; }
                    // 先把「会压到多少」说清楚，别让人以为偷偷降了画质
                    const mb = f.size / 1024 / 1024;
                    const note = `已选：${f.name}（${f.size.toLocaleString()} 字节`;
                    hint.textContent = note + (mb > 2
                        ? `；上传前会自动缩到长边 ${BG_MAX_EDGE}）` : '）');
                });
                pick.append(file);
                const hint = el('span', 'hint', '');
                pick.append(hint);
                body.append(pick);

                const bPush = el('button', 'primary', '推送并启用');
                bPush.type = 'button';
                bPush.disabled = true;          // 没选文件时不能点（否则白跑一次上传)
                bPush.addEventListener('click', () => ctl.close('push'));

                // 更新到哪些端？**默认都勾**。web 必选（这个对话框就是网页背景
                // 对话框），桌面端可取消。
                // ★ 桌面端是**一个**框，不分 mac / win：两端用的是同一张背景图
                //   和同一个图标源，分开只能控制「更新哪几个产物目录」，
                //   不是「用不同的图」—— 那会让人误以为能分开配。
                const box = el('div', 'cf-box tgt-pick');
                box.append(el('div', 'cf-divider', '更新到哪些端（默认全选）'));

                const lbDesk = el('label', 'cf-item');
                const cbDesk = document.createElement('input');
                cbDesk.type = 'checkbox';
                cbDesk.checked = true;
                cbDesk.addEventListener('change', () => {
                    state.targets.desktop = cbDesk.checked;
                    syncPushLabel();
                });
                lbDesk.title = '换背景 + 重建图标 + **重新打包**：'
                    + 'mac 的 .app / zip / dmg（含 dmg 安装背景）与 win64 的 exe / zip。'
                    + '两端用同一张图。';
                lbDesk.append(cbDesk, el('span', null,
                    '桌面端（macOS + Windows，会重新打包）'));
                box.append(lbDesk);

                const webNote = el('label', 'cf-item is-static');
                const webCb = document.createElement('input');
                webCb.type = 'checkbox';
                webCb.checked = true;
                webCb.disabled = true;                   // 必选，灰着但勾着
                webNote.append(webCb, el('span', null,
                    '网页端（必选 —— 这个对话框就是网页背景对话框）'));
                webNote.title = '服务器上的 bg.webp / bg.jpg —— 访客看到的那个';
                box.append(webNote);
                body.append(box);

                // ★ 勾了桌面端会**真的重新打包**，不是只换文件 —— 因为有三样东西
                //   换文件换不到：dmg 安装界面的背景、Windows exe 里的图标、
                //   mac 的签名（改过 Resources 就会失签）。
                //   代价是几十秒，所以必须提前说，而且随勾选状态显示/隐藏
                //   （原来只在打开对话框那一刻判断一次，取消勾选后这句还赖着）。
                const deskWarn = el('p', 'dlg-note tip-warn',
                    '勾了桌面端会**重新打包**（约 10~60 秒，首次更久）：'
                    + 'mac 重建 .app / zip / dmg —— 游戏内背景、应用图标、'
                    + 'dmg 安装界面背景都会换成新图，并重新签名；'
                    + 'Windows 会重新编译 exe，把图标真正编进去。'
                    + 'mac 复用已编译的二进制，不会把你没提交的改动打进包里。');
                body.append(deskWarn);

                function syncPushLabel() {
                    const t = state.targets;
                    const on = [t.web && '网页', t.desktop && '桌面端'].filter(Boolean);
                    bPush.textContent = '推送并启用（' + on.join(' + ') + '）'
                        + (t.desktop ? ' · 含重新打包' : '');
                    // 那句「要重新打包」的提醒只在勾着桌面端时有意义
                    if (deskWarn) deskWarn.hidden = !t.desktop;
                }
                syncPushLabel();

                const acts2 = el('div', 'dlg-acts');
                acts2.append(bPush);
                body.append(acts2);
            },
        });
        if (!action) return;
        await loadWebbg();                    // 先把最新状态拿回来，别拿旧值做判断

        if (action === 'off') {
            const ok = await confirmDanger(
                '撤下网页背景图',
                '**所有访客**刷新后看到的都会变成纯白底（游戏与密码页）。\n'
                + '原图会挪到服务器上一个 nginx 不服务的目录 —— 所以 wget 也拿不到，'
                + '随时可以一键恢复。\n'
                + '（已经加载过图的浏览器内存里仍有旧图，那个撤不回来。）',
                '撤下',
            );
            if (!ok) return;
            const r = await runWrite('webbg_off', {}, '撤下网页背景图', { showOutput: true });
            if (r && r.ok) { flash('已撤下背景图（纯白底）'); await loadWebbg(); }
        } else if (action === 'on') {
            const ok = await confirmDanger(
                '恢复网页背景图',
                '把私藏的原图放回网站目录，**所有访客**刷新后又能看到背景图。',
                '恢复',
            );
            if (!ok) return;
            const r = await runWrite('webbg_on', {}, '恢复网页背景图', { showOutput: true });
            if (r && r.ok) { flash('已恢复背景图'); await loadWebbg(); }
        } else if (action === 'push') {
            const file = state.pickedBg;
            if (!file) { toast('没有选中图片', true); return; }
            const t = state.targets;
            const needIcon = !!t.desktop;

            // ★ 勾了 mac / win 就**必须先裁剪一次图标**（用户明确要求，
            //   「不然不给提交」）。理由：图标是方的、和背景用同一张图时
            //   只能居中裁，很容易裁到脸上或者裁偏；让人自己框一次更靠谱。
            let iconBlob = null;
            if (needIcon) {
                const shot = await openCropDialog(file);
                if (!shot) {
                    // 取消 = 中止整次推送，不是「跳过裁剪继续推」
                    toast('已取消：勾了桌面端就必须先裁一次图标', true);
                    return;
                }
                iconBlob = shot.blob;
            }

            let up, iconUp = null;
            try {
                // 先亮出进度条（0.0%），别让人以为卡住了
                setUploadProgress(0, 0);
                try {
                    up = await uploadWebBg(file, (loaded, total) => {
                        setUploadProgress(loaded, total);
                    });
                    if (iconBlob) {
                        // 图标通常只有几十 KB，进度条走完得快，不用单独显示
                        iconUp = await uploadWebBg(iconBlob, null, 'icon');
                    }
                } finally {
                    // 成功失败都收起 —— 失败时留着一条 100% 的条更让人困惑
                    setTimeout(resetUploadProgress, 600);
                }
            } catch (e) {
                toast('上传失败：' + e.message, true);
                return;
            }
            // web 端永远为真 —— 它是这个对话框存在的理由
            const r = await runWrite('webbg_push',
                { image: up.path, icon: iconUp ? iconUp.path : '',
                  desktop: !!t.desktop },
                '推送新的网页背景图', { showOutput: true });
            if (r && r.ok) {
                flash(t.desktop
                    ? '已推送并启用（网页 + 桌面端，已重新打包）'
                    : '已推送并启用新背景图');
                // ★ 这里**不再**提醒「还要重跑打包」：勾了桌面端时 CLI 已经
                //   把 package.sh / build_windows.sh 跑完了。打包若失败，
                //   输出弹窗里会有 ⚠（showOutput 开着），不需要再弹一条
                //   可能与事实不符的短提示。
                await loadWebbg();
            }
        }
    }

    /**
     * 把浏览器选来的图送到本机 cmsui 落盘（浏览器拿不到真实路径，只能传内容）。
     * 落盘后由 `webbg push --image <路径>` 转码并上传。
     *
     * ★ 先在浏览器里**等比缩到长边 1920** 再传：
     *   背景图是 `background-size: cover` 铺满的，超过屏幕的分辨率纯属浪费
     *   （实测同一张图 4800 宽 → 1920 宽，体积 511 KB → 136 KB）。
     *   所以真正需要传的永远是几百 KB，服务端那个 200 MB 上限只留给
     *   「绕不过这一步」的情况（比如 canvas 导出失败、格式不受支持）。
     *
     * 传的是**原始 base64 体**而不是 JSON 包裹：服务端据此走流式分支，
     * 峰值内存与图片大小无关（见 gate_ui.WEBBG_UPLOAD_MAX 的注释）。
     */
    async function uploadWebBg(file, onProgress, kind) {
        const blob = await shrinkBgBlob(file);
        const b64 = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => {
                const s = String(fr.result || '');
                const i = s.indexOf(',');
                res(i >= 0 ? s.slice(i + 1) : '');
            };
            fr.onerror = () => rej(new Error('读文件失败'));
            fr.readAsDataURL(blob);
        });
        if (!b64) throw new Error('读到的图片是空的');
        return new Promise((res, rej) => {
            // ★ 必须用 XMLHttpRequest，不能用 fetch —— fetch 没有「上传进度」，
            //   只有响应的下载进度。要显示「已传 / 总大小」只能靠 xhr.upload.onprogress。
            const xhr = new XMLHttpRequest();
            // kind=icon 时落成 icon-*.png（背景图那个池子只留最近 10 张，
            // 图标混进去会被当旧背景图裁掉）
            xhr.open('POST', '/api/webbg_upload'
                     + (kind ? '?kind=' + encodeURIComponent(kind) : ''), true);
            xhr.withCredentials = true;              // 同源也要带 cookie（token 在 cookie 里）
            // ★ 不是 application/json —— 服务端看 Content-Type 决定走流式分支。
            //   写成 JSON 会退回「整个 body 读进内存」，峰值涨 4 倍。
            xhr.setRequestHeader('Content-Type', 'application/octet-stream');
            xhr.setRequestHeader('X-CMSUI', '1');    // 服务端要求：挡 CSRF
            xhr.upload.onprogress = (ev) => {
                if (!onProgress) return;
                // lengthComputable 为假时 e.total 是 0 —— 那就不给百分比，
                // 只报已传字节（宁可少显示，也别显示 NaN%）
                onProgress(ev.loaded, ev.lengthComputable ? ev.total : 0);
            };
            xhr.onload = () => {
                let j = null;
                try { j = JSON.parse(xhr.responseText); } catch (e) { /* 非 JSON */ }
                if (xhr.status < 200 || xhr.status >= 300 || !j || j.ok === false) {
                    rej(new Error((j && j.error) || ('HTTP ' + xhr.status)));
                    return;
                }
                res(j.data);
            };
            xhr.onerror = () => rej(new Error('上传失败：连接中断'));
            xhr.onabort = () => rej(new Error('上传已取消'));
            xhr.ontimeout = () => rej(new Error('上传超时'));
            xhr.send(b64);
        });
    }

    /** 等比缩到长边 ≤ BG_MAX_EDGE 并转 JPEG q0.86；失败则原样返回。
     *
     * 两步检查的顺序很重要：
     *   1. **先在原始尺寸上判短边** —— 压缩会让短边变小，先压再判就成了
     *      「4000×600 压到 1920×288，然后说短边不够」——错怪了原图。
     *      原图短边 ≥ 512 是通过与否的唯一依据。
     *   2. 再按长边压到 1920。压缩后短边可能不足 512（宽幅图的必然结果），
     *      这是**允许**的：压缩是为了省流量，不是为了裁掉内容。
     */
    async function shrinkBgBlob(file) {
        const MAX = BG_MAX_EDGE;
        const dec = await file.arrayBuffer().catch(() => null);
        if (!dec) return file;                       // 浏览器解不开这个格式 → 原样传
        let bmp = null;
        try { bmp = await createImageBitmap(new Blob([dec])); }
        catch (e) { return file; }

        const w0 = bmp.width, h0 = bmp.height;
        const short0 = Math.min(w0, h0);
        // ★ 短边太短直接拒绝：铺满屏幕（background-size: cover）时，
        //   短边对应屏幕的一边，太小就是糊成一片。512 是能看清的下限。
        if (short0 < BG_MIN_SHORT_EDGE) {
            bmp.close();
            throw new Error(
                `图片太小：${w0}×${h0}，短边只有 ${short0}px（至少 ${BG_MIN_SHORT_EDGE}px）。`
                + '请换一张分辨率更高的图 —— 铺满整屏时这张会糊。');
        }

        const long = Math.max(w0, h0);
        if (long <= MAX && file.type === 'image/jpeg') {
            bmp.close();
            return file;                             // 已经够小且是 jpeg，别做无谓重编码
        }
        const scale = long > MAX ? MAX / long : 1;
        const w = Math.max(1, Math.round(w0 * scale));
        const h = Math.max(1, Math.round(h0 * scale));
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        const cx = cv.getContext('2d');
        cx.imageSmoothingQuality = 'high';
        cx.drawImage(bmp, 0, 0, w, h);
        bmp.close();
        return new Promise((res) => cv.toBlob(
            (b) => res(b || file), 'image/jpeg', 0.86));
    }

    async function doAdminPasswd() {
        const v = await openDialog({
            title: '更换管理口令',
            note: '先输当前口令，再输新口令（至少 12 位）。换完以后所有写操作都要用新口令。',
            noteBad: true,
            fields: [
                { name: 'current', label: '当前管理口令', type: 'password', required: true },
                { name: 'newpw', label: '新管理口令（≥12 位）', type: 'password', required: true },
                { name: 'again', label: '再输一次新口令', type: 'password', required: true },
            ],
            okText: '更换',
            danger: true,
        });
        if (!v) return;
        if (v.newpw !== v.again) { toast('两次输入的新口令不一致', true); return; }
        if (v.newpw.length < 12) { toast('新口令至少 12 位', true); return; }

        try {
            const r = await exec('admin_passwd', { current: v.current, newpw: v.newpw });
            if (!r.ok) {
                showOutput('更换管理口令 — 失败', r.out, true);
                toast('更换失败，看下面的输出', true);
                return;
            }
            state.admin = '';      // 旧口令作废
            showOutput('更换管理口令', r.out, false);
            await loadRemote();
        } catch (e) {
            toast(e.message, true);
        }
    }

    // ── 绑定 ────────────────────────────────────────────────────

    $('btn-refresh').addEventListener('click', loadAll);
    $('btn-add').addEventListener('click', doAdd);
    $('btn-push').addEventListener('click', doPush);
    $('btn-pull').addEventListener('click', doPull);
    $('btn-revoke').addEventListener('click', doRevokeAll);

    $('search').addEventListener('input', (ev) => {
        state.query = ev.target.value;
        renderEntries();
    });
    $('usage-refresh').addEventListener('click', manualRefresh);
    $('usage-auto-toggle').addEventListener('click', () => {
        setAutoPaused(!state.autoPaused);
    });
    // 两个数字框都是「失焦 / 回车」才生效（change），不是每敲一个键就发一次请求。
    // 值一定会被夹回合法范围**并写回输入框**：否则用户清空输入框，看到的是
    // 表格按 20 条在翻、框里却是空的——比不管它还费解。
    $('usage-auto').addEventListener('change', (ev) => {
        state.autoSec = clampInt(ev.target.value, 'autoSec', 30);
        ev.target.value = state.autoSec;
        rememberUI('ui.autoSec', state.autoSec);
        startAuto();
        // 刚填的间隔还没到也要先给一份：用户改它通常是因为嫌现在的数据旧
        if (!state.autoPaused) loadUsage({ pull: true });
    });
    // 从别的标签页切回来 → 立刻补一次，不然看到的还是走开之前的旧数据
    document.addEventListener('visibilitychange', () => {
        if (!document.hidden && autoMs()) loadUsage({ pull: true });
    });
    $('usage-clear').addEventListener('click', () => {
        usageF.time = { preset: '', from: '', to: '' };
        ['result', 'pwid', 'ip', 'browser', 'osdev'].forEach((k) => {
            usageF[k].clear();
            usageF.visAll.add(k);      // 视觉回到「初始全勾」
        });
        refreshColButtons();
        reloadFirstPage();
    });

    // 「显示全部记录」：把 `existing` 关掉 = 连已删除密码的历史记录一起显示。
    // 这是**唯一**能让「共 N 条」和「筛选后 M 条」相等的办法（默认开着 existing）。
    $('usage-show-all').addEventListener('click', () => {
        usageF.existing = false;
        loadUsageFacets();          // 密码列的可选值也变了，要重新拿
        reloadFirstPage();
    });

    // 翻页：只换 offset，不重新连服务器
    $('page-prev').addEventListener('click', () => {
        if (state.page <= 0) return;
        state.page -= 1;
        loadUsage();
    });
    $('page-next').addEventListener('click', () => {
        state.page += 1;
        loadUsage();
    });
    $('page-first').addEventListener('click', () => {
        // 回到第一页时顺手拉一次：回来看到的就是最新的，而不是「刚才那批」
        state.page = 0;
        loadUsage({ pull: true }).then((d) => {
            if (d && !d.pull_error && !d.pull_skip_reason) {
                flash('已刷新 · ' + hhmmss(Date.now() / 1000));
            }
        });
    });
    $('usage-size').addEventListener('change', (ev) => {
        state.pageSize = clampInt(ev.target.value, 'pageSize', 20);
        ev.target.value = state.pageSize;
        rememberUI('ui.pageSize', state.pageSize);
        reloadFirstPage();
    });

    // 列头筛选面板：点外面 / Esc / 滚动 / 改窗口大小都关掉
    // （滚动时面板不会跟着列头走，留着会指向错误的位置）
    document.addEventListener('click', (ev) => {
        const pop = $('cf-pop');
        if (pop.hidden) return;
        if (pop.contains(ev.target)) return;
        if (cfAnchor && cfAnchor.contains(ev.target)) return;   // 点同一个 ▾ 交给它自己 toggle
        closeFilterPanel();
    });
    document.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !$('cf-pop').hidden) closeFilterPanel();
    });
    window.addEventListener('resize', closeFilterPanel);
    window.addEventListener('scroll', closeFilterPanel, true);

    // 顶栏两个芯片点击 → 直接进对应操作（闸门 / 管理口令）
    $('chips').addEventListener('click', (ev) => {
        const t = ev.target.closest('.chip');
        if (!t) return;
        const txt = t.textContent || '';
        if (txt.indexOf('同步') === 0) doSync();
        else if (txt.indexOf('线上闸门') === 0) doGate();
        else if (txt.indexOf('管理口令') === 0) doAdminPasswd();
        else if (txt.indexOf('网页背景') === 0) doWebBg();
        else if (txt.indexOf('默认页') === 0) doLanding();
        else if (txt.indexOf('登录入口') === 0) doGatePath();
    });

    // ── 种子工具箱：复数扫雷种子串 ⇄ 明文 JSON ──
    // 编解码器是游戏同一份（/seedcodec.js，gate_ui.py 从 web/dist/ 直接发），
    // 动态 import、首次点开才加载；判定（seedIsSane/decodeSeed 的严格校验）与
    // 游戏端逐条一致，不会出现「工具说行、游戏说 BAD SEED」的分裂。
    let seedCodec = null;          // 缓存 import 好的模块
    let seedCodecErr = null;
    async function seedCodecMod() {
        if (seedCodec) return seedCodec;
        if (seedCodecErr) throw seedCodecErr;
        try {
            seedCodec = await import('/seedcodec.js');
            return seedCodec;
        } catch (e) {
            seedCodecErr = new Error('编解码器加载失败：' + (e && e.message ? e.message : e));
            throw seedCodecErr;
        }
    }

    function seedShow(text, bad) {
        const out = $('seed-out');
        out.textContent = text;
        out.classList.toggle('bad', !!bad);
        out.hidden = false;
    }

    function seedSummary(s) {
        const base = s.kind + ' · ' + s.cols + 'x' + s.rows + ' · ' +
            (s.manualSplit ? s.realMines + '+' + s.imagMines : s.mines) + ' 雷';
        return s.kind === 'save'
            ? base + ' · ' + s.phase + ' · 已开 ' + s.elapsedCs + 'cs'
            : base;
    }

    function seedKey() {
        // 留空 = 内置默认（decodeSeed/encodeSeed 自己的缺省参数），界面永远不回显默认值；
        // 填了才覆盖 —— 只有自己换过密钥编码的串才用得上。
        return $('seed-key').value.trim();
    }

    async function seedDecode() {
        const text = $('seed-in').value.trim();
        if (!text) { seedShow('（先粘贴种子串）', true); return; }
        try {
            const codec = await seedCodecMod();
            const k = seedKey();
            const s = k ? codec.decodeSeed(text, k) : codec.decodeSeed(text);
            if (!s) {
                seedShow(k ? 'BAD SEED · 用你填的密钥解不开（密钥不对，或种子串已损坏）'
                           : 'BAD SEED · 用内置密钥解不开（密钥不对，或种子串已损坏）', true);
                return;
            }
            seedShow('✓ ' + seedSummary(s) + '\n\n' + JSON.stringify(s, null, 2), false);
        } catch (e) { seedShow(String(e.message || e), true); }
    }

    async function seedEncode() {
        const text = $('seed-in').value.trim();
        if (!text) { seedShow('（先粘贴明文 JSON）', true); return; }
        let s;
        try { s = JSON.parse(text); } catch (e) {
            seedShow('JSON 解析失败：' + e.message, true); return;
        }
        if (!s || typeof s !== 'object' || Array.isArray(s)) {
            seedShow('JSON 必须是一个对象（{...}）', true); return;
        }
        try {
            const codec = await seedCodecMod();
            const k = seedKey();
            const seedText = k ? codec.encodeSeed(s, k) : codec.encodeSeed(s);
            // encodeSeed 不做合法性判定（与游戏端 encodeSeedJson 同口径），
            // 这里用 seedIsSane 提前告诉用户游戏端会不会收，免得复制过去才发现被拒。
            const sane = codec.seedIsSane(s);
            seedShow((sane ? '✓ ' : '⚠ 游戏端会拒绝（seedIsSane 不过）：') + '\n\n' + seedText, !sane);
        } catch (e) { seedShow(String(e.message || e), true); }
    }

    $('btn-seed').addEventListener('click', async () => {
        const dlg = $('seed-card');
        if (dlg.open) { dlg.close(); return; }
        dlg.showModal();
        $('seed-in').focus();
        try { await seedCodecMod(); } catch (e) { toast(e.message, true); }
    });
    $('seed-close').addEventListener('click', () => { $('seed-card').close(); });
    $('seed-decode').addEventListener('click', () => seedDecode().catch((e) => toast(String(e.message || e), true)));
    $('seed-encode').addEventListener('click', () => seedEncode().catch((e) => toast(String(e.message || e), true)));
    $('seed-copy').addEventListener('click', () => {
        const out = $('seed-out');
        if (out.hidden || !out.textContent) { toast('没有可复制的结果', true); return; }
        navigator.clipboard.writeText(out.textContent)
            .then(() => toast('已复制'))
            .catch(() => toast('复制失败（浏览器拒绝了剪贴板）', true));
    });

    initColFilters();
    // 先把上次设的间隔 / 每页条数读回来，再去取第一份数据——
    // 顺序反了会先按默认值请求一次，白费一次往返。
    state.pageSize = recallUI('ui.pageSize', 'pageSize', 20);
    state.autoSec = recallUI('ui.autoSec', 'autoSec', 30);
    $('usage-size').value = state.pageSize;
    $('usage-auto').value = state.autoSec;
    renderAutoBtn();
    loadAll({ quiet: true });
    startAuto();
})();
