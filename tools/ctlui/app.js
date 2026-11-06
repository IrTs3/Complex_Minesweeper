/* ctlui 前端：所有写操作经 /api/op 转调 distctl 的 SSH 通道；
   管理口令只在内存里（记住 = 本次页面会话），不写 localStorage、不打日志。 */
"use strict";

const $ = (id) => document.getElementById(id);
/* name/os 是客户端上报的自由文本，进 innerHTML 前必须转义（防存储型 XSS） */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
/* cmsui 同款「系统 / 设备」：os 有就拼上，老的没上报只显示设备名 */
const clientCell = (c) => esc([c.os, c.name].filter(Boolean).join(" / ") || "-");
let pendingOp = null;      // {op, args} 等待口令
let rememberedPw = null;   // 「记住口令」：只在 JS 内存，刷新页面即消失

function toast(msg, cls = "", ms) {
  const t = $("toast");
  t.textContent = msg;
  t.className = "toast" + (cls ? " " + cls : "");
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, ms ?? (cls === "bad" ? 6000 : 3000));
}

async function api(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CTLUI": "1" },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.data;
}

/* ---------- 状态渲染 ---------- */

const board = (t) => `${t.cols}x${t.rows}x${t.mines}`;
const densityOf = (c, r, m) => (!c || !r) ? "—" : (100 * m / (c * r)).toFixed(1) + "%";
const pct = (w, g) => g ? (100 * w / g).toFixed(1) + "%" : "—";
const hm = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h${m ? m + "m" : ""}` : `${m}m`;
};
/* 进度上报里的预估剩余时间（秒）→ 人话；同 TUI 口径 mm:ss，过 1 小时进 h:mm:ss */
const etaFmt = (s) => {
  if (s == null || !isFinite(s) || s < 0) return null;
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
};

// 时长中文格式（天/时/分，0 值单位不显示；全 0 显示 0分）
const durFmt = (min) => {
  min = Math.max(0, Math.round(min));
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  const parts = [];
  if (d) parts.push(`${d}天`);
  if (h) parts.push(`${h}时`);
  if (m || !parts.length) parts.push(`${m}分`);
  return parts.join("");
};

/* 组复选框的取值：key+scope 反查当前 inprog 里该组全部任务号（数据现算，不落 DOM） */
const grpTaskIds = (key, scope) => {
  if (!lastData) return [];
  if (scope === "ip") return lastData.inprog.filter((t) => t.ip === key).map((t) => t.task_id);
  const [ip, nm] = key.split("\n");
  return lastData.inprog.filter((t) => t.ip === ip && (t.name || "") === nm).map((t) => t.task_id);
};

function fill(tblId, emptyId, rows) {
  $(tblId).querySelector("tbody").innerHTML = rows.join("");
  $(emptyId).hidden = rows.length > 0;
  $(emptyId).textContent = rows.length ? "" : "（空）";
}

/* ── 调度番茄钟（服务器上的全局相位）──────────────────────────────
   服务器回的是它自己时钟域的 left，浏览器那台机器没对时也照样要倒计时：
   先把它落到本机时钟域的一个绝对时刻，再本地 1s 一跳（跟进行中那列同款做法）。 */
const POMO = { live: null, enabled: false };   // live = {at, left, inRest}；enabled 认服务器不回文案
let PAUSED = false;   // 管理员手动暂停（cfg.paused）：与番茄钟休息段是两回事，按钮置灰只认后者
/* 时长说人话：整分钟走 25m/1h30m，非整分钟走 mm:ss —— 别把 30 秒四舍五入成「1m」 */
const pomoHuman = (s) => (s % 60 === 0 ? hm(s) : etaFmt(s));
/* 输入框回填：整分钟写 25m/1h30m，非整分钟写 90s —— 回填 1500s 人能看懂，但和
   「25m」这种写法对不上，改起来容易手滑写成 1500 当成 1500 分钟（裸数字=分钟）。 */
const pomoInput = (s) => (s % 60 === 0 ? hm(s) : `${s}s`);
const pomoSec = (seg) => {   // 25m / 1h30m / 90s / 裸数字=分钟 → 秒；与服务器 pomo_dur 同口径
  seg = (seg || "").trim();
  if (!seg) return null;
  let total = 0, num = 0, has = false;
  for (const ch of seg) {
    if (ch >= "0" && ch <= "9") { num = num * 10 + +ch; has = true; continue; }
    const mult = { h: 3600, m: 60, s: 1 }[ch];
    if (!mult || !has) return null;
    total += num * mult; num = 0; has = false;
  }
  if (has) total += num * 60;
  return total;
};
function pomoSpecFromInputs() {
  const w = pomoSec($("pomo-w").value), r = pomoSec($("pomo-r").value);
  if (w === null || r === null) { toast("时长每段可带 h/m/s（25m、1h30m、90s），裸数字按分钟", "bad"); return null; }
  if (w <= 0 || r <= 0) { toast("两段都得是正数；关掉请用「关」按钮，别写 0", "bad"); return null; }
  if (w + r < 60) { toast(`一轮 ${w + r}s 太短（下限 60s）：歇得太碎，交结果的开销比算得还多`, "bad"); return null; }
  return `${w}s/${r}s`;
}
function renderPomo(p) {
  POMO.enabled = !!(p && p.on);
  const state = $("pomo-state"), btn = $("btn-pomo");
  btn.textContent = POMO.enabled ? "关" : "开";
  btn.classList.toggle("danger", POMO.enabled);
  // 关着也回时长（见 dist_server.pomo_wire）：否则改过 30m/10m 再关掉，输入框漂回默认值，看着像没保存
  if (p && p.work_sec) {
    if (document.activeElement !== $("pomo-w")) $("pomo-w").value = pomoInput(p.work_sec);
    if (document.activeElement !== $("pomo-r")) $("pomo-r").value = pomoInput(p.rest_sec);
  }
  if (!POMO.enabled) {
    POMO.live = null;
    state.textContent = "未开（任务一直发）";
    state.classList.remove("warn");
    $("c-pomo").textContent = "未开 · 任务一直发";
    $("c-pomo").className = "chip ok";
    $("pomo-banner").hidden = true;
    syncPauseBtn();
    return;
  }
  POMO.live = { at: Date.now() / 1000, left: +p.left || 0, inRest: !!p.in_rest };
  pomoTick();
}
/* 钟点比倒计时更好用：「还剩 3:41」要自己算几点结束，「14:07 恢复发放」不用。
   两个都给，因为管理员既想知道还要等多久、也想知道等到几点。 */
const pomoClock = (epochSec) =>
  new Date(epochSec * 1000).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
function pomoTick() {
  if (!POMO.live) return;
  const left = POMO.live.left - (Date.now() / 1000 - POMO.live.at);
  const state = $("pomo-state"), top = $("c-pomo"), ban = $("pomo-banner");
  const due = pomoClock(POMO.live.at + POMO.live.left);
  if (POMO.live.inRest) {
    const tail = left > 0 ? `${etaFmt(left)} 后恢复发放` : "马上恢复发放";
    state.textContent = `☕ 休息一下，${tail}`;
    state.classList.add("warn");
    top.textContent = left > 0 ? `☕ 休息中 · ${due} 恢复发放（还剩 ${etaFmt(left)}）`
                               : "☕ 休息到了尾声，马上恢复发放";
    top.className = "chip warn";
    ban.hidden = false;
    ban.textContent = `☕ 番茄钟休息中，${due} 恢复发放（还剩 ${etaFmt(Math.max(0, left))}）：`
      + "这段时间不发新任务，队列里的照常等着；正在跑的那单在「两局之间」睡到这一刻"
      + "（进程不死、已算的局不丢，租约靠心跳续着）。要一直发就把番茄钟关掉。";
  } else {
    state.textContent = `▶ 连算中，距休息 ${etaFmt(Math.max(0, left))}`;
    state.classList.remove("warn");
    top.textContent = `▶ 连算中 · ${due} 起歇（还剩 ${etaFmt(Math.max(0, left))}）`;
    top.className = "chip ok";
    ban.hidden = true;
  }
  syncPauseBtn();
}
/* 休息段本来就不发货，这时「暂停发放」按下去看不出任何差别，还容易被回头当成
   「是不是我按了暂停」。置灰 + 把原因写进 title，恢复发放那一刻自动解禁。
   管理员**手动**暂停时绝不置灰——那种情况下这个按钮是唯一的恢复入口。 */
function syncPauseBtn() {
  const btn = $("btn-pause"), rest = !!(POMO.live && POMO.live.inRest);
  btn.disabled = rest && !PAUSED;
  btn.title = rest && !PAUSED
    ? "番茄钟休息中，这段时间本来就不发新任务（不是暂停）；要一直发就把番茄钟关掉"
    : "只影响之后领的任务，进行中的不受影响";
}
/* 剩余时间本地 1s 一跳：数据 15s 才回一次，不动的话倒计时看着像卡住；
   POMO.live 为空（没开/还没拿到数据）时 pomoTick 自己返回，不白跑。 */
setInterval(pomoTick, 1000);

/* 前端三件套换了代，浏览器里跑的却还是打开那一刻的旧 app.js —— 自动刷新只是重新拉数据，
   新代码进不来。以前只能等人手动刷新（「界面改了怎么没生效」），现在每次回执都对一次磁盘
   上的文件指纹。基准 = 页面加载后**第一次**回执的值：服务端每个请求现读盘，那一刻磁盘上的
   就是本页实际跑着的那份，所以不会一进来就误挂条子。 */
const ASSETS = { base: null };
function staleNote(d) {
  const bar = $("stale-banner");
  if (d.assets_ver && ASSETS.base === null) ASSETS.base = d.assets_ver;
  const uiStale = !!d.assets_ver && ASSETS.base !== d.assets_ver;
  if (d.stale) {
    // 两种「你看到的是旧的」要做的动作不同，服务端那条优先（光刷新浏览器没用）
    bar.textContent = "⚠ 服务端代码已更新 —— 重启 ctlui 进程才生效（刷新浏览器没用）";
  } else if (uiStale) {
    bar.textContent = "⚠ 看板前端已更新 —— 刷新浏览器（Cmd/Ctrl+R）就换成新页面";
  }
  bar.hidden = !(d.stale || uiStale);
}

function render(d) {
  // 源码比进程新（cmsui 同款）：红条提醒重启 ctlui，别让人猜为什么行为是旧的
  staleNote(d);
  const cfg = d.config, def = cfg.default;
  prefillForms(def);
  const paused = !!cfg.paused;
  PAUSED = paused;
  const chip = $("chip-state");
  chip.textContent = paused ? "⏸ 已暂停" : "▶ 运行中";
  chip.classList.toggle("warn", paused);
  chip.classList.toggle("ok", !paused);
  $("btn-pause").textContent = paused ? "恢复发放" : "暂停发放";

  $("c-default").textContent = `${def.model === "complex" ? "复数" : "经典"} ${board(def)} × ${def.games}局`;
  if (document.activeElement !== $("c-seed")) $("c-seed").value = cfg.seed_next;
  $("lease-h").value = Math.floor((cfg.lease_sec || 7200) / 3600);
  $("lease-m").value = Math.round(((cfg.lease_sec || 7200) % 3600) / 60);
  const cool = cfg.cool_sec ?? 60;   // 服务器没存过 = 默认 60s，照实显示
  $("cool-d").value = Math.floor(cool / 86400);
  $("cool-h").value = Math.floor((cool % 86400) / 3600);
  $("cool-m").value = Math.floor((cool % 3600) / 60);
  $("cool-s").value = cool % 60;
  $("ip-limit").value = cfg.max_ip_inprog || 3;
  renderPomo(d.pomo);

  const q = d.queue.length, ip = d.inprog.length, dn = d.done_total ?? 0;
  $("c-counts").textContent = `${q} / ${ip} / ${dn}`;
  $("chip-counts").innerHTML = `队列 <b>${q}</b> · 进行中 <b>${ip}</b> · 完成 <b>${dn}</b>`;
  $("muted-inprog").textContent = ip ? `有 ${ip} 个任务在客户端手里` : "当前没有任务在跑";

  // 合计：服务器算好的「模式 × 规格」聚合（全量明细不再每 15 秒过一遍公网，
  // 账见 ctl_ui.status）。规格不同不能混在一起，所以聚合键里带 CxRxM。
  const MODEL_ORDER = { complex: 0, classic: 1 };
  const aggVis = (d.agg_spec || []).filter(aggPass).sort((x, y) =>
    MODEL_ORDER[x.model] - MODEL_ORDER[y.model] || x.cols - y.cols || x.rows - y.rows || x.mines - y.mines);
  fill("t-agg", "e-agg", aggVis.map((a) =>
    `<tr><td>${MODEL(a.model)}</td>` +
    `<td>${a.cols}×${a.rows}×${a.mines}（密度 ${densityOf(a.cols, a.rows, a.mines)}）</td>` +
    `<td class="num">${a.tasks}</td><td class="num">${a.games}</td>` +
    `<td class="num win-hi">${pct(a.wins, a.games)}</td></tr>`));

  // 进行中：IP（一级）→ 设备（二级，仅同 IP 多设备）→ 任务叶子，单击展开式。
  // 列结构不分组表头/叶子行保持一致，表头对齐不动；叶子只填层级标题没覆盖的列。
  // 离线两级：有进度但 1 分钟没刷新浅红、5 分钟深红（老客户端没进度不算离线）。
  const staleSec = (t) => (t.prog && Number.isInteger(t.prog.done))
    ? Date.now() / 1000 - (t.prog.at || 0) : null;
  const staleCls = (t) => {
    const s = staleSec(t);
    return s === null ? "" : s > 300 ? " offline-deep" : s > 60 ? " offline" : "";
  };
  // 未上报进度（领完就死 / 不发进度的老客户端）：超过服务器 15 分钟宽限整行浅黄，
  // 到点服务器会把这单收回重发——只报事实，不归因新旧包。
  const noreportCls = (t) => {
    const has = t.prog && Number.isInteger(t.prog.done);
    return !has && (t.claimed_min_ago || 0) >= 15 ? " noreport" : "";
  };
  // 上次通信：最近一次进度上报的时刻 + 已沉默多久；超 30 秒红字
  const agoFmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    if (h) return `${h}小时${m}分`;
    if (m) return `${m}分${ss}秒`;
    return `${ss}秒`;
  };
  const lastCommCell = (t) => {
    if (!t.prog || !t.prog.at)
      return '<td class="muted" title="从未上报进度；超过 15 分钟宽限服务器会把这单收回重发">未上报</td>';
    const age = Date.now() / 1000 - t.prog.at;
    const cls = age > 30 ? "comm-late" : "muted";
    const tm = new Date(t.prog.at * 1000).toLocaleTimeString("zh-CN", { hour12: false });
    return `<td class="num"><span class="${cls}">${tm}</span><br>` +
      `<span class="${cls}">${agoFmt(age)}前</span></td>`;
  };
  const ipGroups = [];
  const ipMap = new Map();
  for (const t of d.inprog) {
    let g = ipMap.get(t.ip);
    if (!g) {
      g = { ip: t.ip, tasks: [], devMap: new Map(), devs: [] };
      ipMap.set(g.ip, g);
      ipGroups.push(g);
    }
    g.tasks.push(t);
    const nm = t.name || "";
    let dv = g.devMap.get(nm);
    if (!dv) {
      dv = { name: nm, os: t.os || "", tasks: [] };
      g.devMap.set(nm, dv);
      g.devs.push(dv);
    } else if (!dv.os && t.os) dv.os = t.os;
    dv.tasks.push(t);
  }
  const leafRow = (t, cls) => {
    const p = t.prog && Number.isInteger(t.prog.done)
      ? `<td class="num win-hi">${pct(t.prog.done, t.games)}（${t.prog.done}/${t.games}）` +
        (t.prog.eta_sec ? `<br><span class="muted">剩 ${etaFmt(t.prog.eta_sec)}</span>` : "") + "</td>"
      : '<td class="num muted">—</td>';
    // 版本落后浅蓝闪：求解器/客户端**各自**和「已发布」对（逐文件换包，两半可能各落后各的）。
    // 客户端按这台机器的系统对它那平台的一份，不拿 mac 那份去量 Windows。
    // 死人提醒（行级红）优先级更高：行已经红着就不叠蓝闪，两种动画不抢同一行。
    const dead = staleCls(t) !== "";
    const plat = /mac/i.test(t.os || "") ? "mac"
      : /windows|win/i.test(t.os || "") ? "win" : /linux/i.test(t.os || "") ? "linux" : "";
    const pubC = ((solverHistData || {}).published_client || {})[plat] || "";
    const pubS = (solverHistData || {}).published || "";
    const voS = !dead && !!t.solver_ver && !!pubS && t.solver_ver !== pubS;
    const voC = !dead && !!t.client_ver && !!pubC && t.client_ver !== pubC;
    return `<tr class="${cls}${staleCls(t)}${noreportCls(t)}${kickSel.has(t.task_id) ? " picked" : ""}"${staleSec(t) > 60 ? ' title="进度上报已停，疑似离线"' : ""}>` +
      `<td class="id-cell"><input type="checkbox" class="kick-chk" data-tid="${t.task_id}"` +
      `${kickSel.has(t.task_id) ? " checked" : ""} aria-label="选中 ${t.task_id}"> ${t.task_id}</td>` +
      `<td>${t.model === "complex" ? "复数" : "经典"}</td>` +
      `<td>${board(t)}（密度 ${densityOf(t.cols, t.rows, t.mines)}）</td>` +
      (t.solver_ver
        ? `<td><code${voS ? ` class="ver-old" title="求解器不是已发布的最新版（已发布 ${esc(pubS)}）"` : ""}>${esc(t.solver_ver)}</code></td>`
        : '<td class="muted">—</td>') +
      (t.client_ver
        ? `<td><code${voC ? ` class="ver-old" title="客户端不是这台机器该平台已发布的最新版（已发布 ${esc(pubC)}）"` : ""}>${esc(t.client_ver)}</code></td>`
        : '<td class="muted">—</td>') + p +
      lastCommCell(t) +
      `<td class="num">${durFmt(t.claimed_min_ago)}</td></tr>`;
  };
  // 组复选框：勾上 = 整组任务进出 kickSel；组头行在整组选中时同样吃 picked 闪烁。
  // 复选框并进组头同一格（紧贴字段），与叶子行的「勾选框+任务号」同列起步
  const grpChk = (ids, key, scope) => {
    const n = ids.filter((id) => kickSel.has(id)).length;
    const picked = ids.length > 0 && n === ids.length ? " picked" : "";
    return { picked,
      box: `<input type="checkbox" class="kick-chk grp-chk"` +
        ` data-gkey="${esc(key)}" data-scope="${scope}" data-count="${ids.length}"` +
        `${n === ids.length && ids.length > 0 ? " checked" : ""}` +
        ` aria-label="选中整组任务"> ` };
  };
  const inprogRows = [];
  for (const g of ipGroups) {
    const open = inprogOpen.has(g.ip);
    // 单设备组把机器名挂在 IP 下面一行（否则叶子行看不到是谁在跑）；
    // 多设备组有二级菜单显示名字，一级就不重复
    const devLine = g.devs.length === 1 ? clientCell(g.devs[0]) : "";
    const gc = grpChk(g.tasks.map((t) => t.task_id), g.ip, "ip");
    inprogRows.push(`<tr class="group-row ip${gc.picked}" data-group-key="${esc(g.ip)}">` +
      `<td colspan="8">${gc.box}<span class="caret">${open ? "▾" : "▸"}</span> ` +
      `${esc(g.ip)}（${g.devs.length} 台设备 · ${g.tasks.length} 个任务）` +
      (devLine ? `<br><span class="muted grp-dev">${devLine}</span>` : "") + "</td></tr>");
    if (!open) continue;
    if (g.devs.length >= 2) {                     // 同 IP 多设备：加一层设备菜单
      for (const dv of g.devs) {
        const dkey = g.ip + "\n" + dv.name;
        const dopen = inprogOpen.has(dkey);
        const dc = grpChk(dv.tasks.map((t) => t.task_id), dkey, "dev");
        inprogRows.push(`<tr class="group-row device${dc.picked}" data-group-key="${esc(dkey)}">` +
          `<td colspan="8">${dc.box}<span class="caret">${dopen ? "▾" : "▸"}</span> ` +
          `${clientCell(dv)}（${dv.tasks.length} 个任务）</td></tr>`);
        if (dopen) for (const t of dv.tasks) inprogRows.push(leafRow(t, "leaf-under-device"));
      }
    } else {
      for (const t of g.tasks) inprogRows.push(leafRow(t, "leaf-under-group"));
    }
  }
  fill("t-inprog", "e-inprog", inprogRows);
  // 组复选框的三态（checked / indeterminate）得用 DOM 属性设，innerHTML 里写不进去
  document.querySelectorAll("#t-inprog .grp-chk").forEach((cb) => {
    const ids = grpTaskIds(cb.dataset.gkey, cb.dataset.scope);
    const n = ids.filter((id) => kickSel.has(id)).length;
    cb.checked = ids.length > 0 && n === ids.length;
    cb.indeterminate = n > 0 && n < ids.length;
  });
  // 勾选集维护：任务消失（完成/被剔）就清出集合；同步表头全选态与剔除按钮可见性
  const allTids = new Set(d.inprog.map((t) => t.task_id));
  for (const tid of [...kickSel]) if (!allTids.has(tid)) kickSel.delete(tid);
  const boxes = [...document.querySelectorAll("#t-inprog .kick-chk:not(.grp-chk)")];
  const all = boxes.length > 0 && boxes.every((b) => b.checked);
  const some = boxes.some((b) => b.checked);
  $("inprog-all").checked = all;
  $("inprog-all").indeterminate = some && !all;
  $("btn-kick").hidden = kickSel.size === 0;
  $("btn-kick").textContent = `剔除此会话（${kickSel.size}）`;
  $("btn-drop").hidden = kickSel.size === 0;
  $("btn-drop").textContent = `删除此会话（${kickSel.size}）`;

  // 优先队列：相邻同参数且种子连续的合并成一行（纯展示层，队列本身不动）。
  // 被领走导致断号的自动拆组，「剩余」如实反映当前队列条数。
  // cool = 组内最早解冻的时刻（服务器只给「租约收回/被剔除后重入队」的任务打 cool_until，
  // 正常插队没这个字段 = 无冷却）；发放按队列顺序找第一个解冻的，所以取 min。
  const qKey = (t) => [t.model, t.cols, t.rows, t.mines, t.games].join("|");
  const qGroups = [];
  for (const t of d.queue) {
    const last = qGroups[qGroups.length - 1];
    if (last && last.key === qKey(t) && Number(t.seed) === last.end + 1) {
      last.end = Number(t.seed);
      last.n++;
      last.cool = Math.min(last.cool, Number(t.cool_until) || 0);
    } else {
      qGroups.push({ key: qKey(t), start: Number(t.seed), end: Number(t.seed), n: 1, t,
                     cool: Number(t.cool_until) || 0 });
    }
  }
  qGroupsLive = qGroups;   // 弹窗筛选项的取值来源，见 queueRows()
  // 勾选集维护：队列里已经不在的 task_id 清出；组勾中=整组 id 都在集里
  const inQueue = new Set(d.queue.map((t) => t.task_id));
  for (const tid of [...qdelSel]) if (!inQueue.has(tid)) qdelSel.delete(tid);
  const qVis = qGroups.filter(qPass);
  // 卡面那份只读（没有勾选框），弹窗那份带 data-g 供勾选还原整组 task_id
  const qRow = (g, i, box) => {
    const picked = box && groupIds(g).every((id) => qdelSel.has(id));
    const seeds = g.start === g.end ? g.start : g.start + "–" + g.end;
    const coolLeft = g.cool ? g.cool - Date.now() / 1000 : 0;
    // 倒计时向上取整：还剩 0.4 秒显示 1秒，别显示 0秒还挂着「领不走」
    const coolText = agoFmt(Math.ceil(coolLeft));
    const coolCell = coolLeft > 0
      ? `<td class="num"><span class="cool-wait" title="租约收回/剔除后重入队的冷却，还剩 ${coolText}；结束前客户端领不走">${coolText}</span></td>`
      : '<td class="num muted" title="无冷却，下一个客户端就能领走">—</td>';
    return `<tr${picked ? ' class="picked"' : ""}>` +
      `<td class="id-cell">` +
      (box ? `<input type="checkbox" class="qdel-chk" data-g="${i}"` +
             `${picked ? " checked" : ""} aria-label="选中 ${seeds}"> ` : "") +
      `${seeds}</td>` +
      `<td>${g.t.model === "complex" ? "复数" : "经典"}</td>` +
      `<td>${board(g.t)}</td><td class="num">${g.t.games}</td><td class="num">${g.n}</td>` +
      coolCell + `</tr>`;
  };
  fill("t-queue", "e-queue", qVis.slice(0, QUEUE_MINI_N).map((g) => qRow(g, 0, false)));
  const qNarrow = qVis.length === qGroups.length
    ? "" : ` · 筛选后 ${qVis.length} 组`;
  const qBad = qBadRanges();
  $("queue-count").textContent =
    `按发放顺序 · 共 ${d.queue.length} 条 / ${qGroups.length} 组${qNarrow}`;
  $("queue-dlg-count").textContent =
    `共 ${d.queue.length} 条 / ${qGroups.length} 组${qNarrow}` +
    (qBad.length ? ` · ⚠ 区间无效（最小>最大）：${qBad.join("、")}` : "");
  if ($("queue-dlg").open) {
    qdelGroups = qVis;                       // data-g 指向弹窗当前渲染的这份
    queuePager.setCount(qVis.length);
    const off = queuePager.start();
    fill("t-queue-full", "e-queue-full",
         queuePager.view(qVis).map((g, k) => qRow(g, off + k, true)));
    queuePager.draw();
  }
  // 表头全选态 + 删除按钮可见性（进行中同款）
  const qBoxes = [...document.querySelectorAll("#t-queue-full .qdel-chk")];
  const qAll = qBoxes.length > 0 && qBoxes.every((b) => b.checked);
  const qSome = qBoxes.some((b) => b.checked);
  $("queue-all").checked = qAll;
  $("queue-all").indeterminate = qSome && !qAll;
  $("btn-qdel").hidden = qdelSel.size === 0;
  $("btn-qdel").textContent = `删除选中（${qdelSel.size}）`;

  const badRanges = [...new Set([...doneBadRanges(), ...aggBadRanges()])];
  const row = ([tid, r]) => {
    const bad = r.valid === false;
    const tm = new Date(r.time * 1000).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const cls = bad ? ' class="invalid"' : "";
    return `<tr><td>${bad ? "×" : ""}</td>` +
      `<td${cls}>${tid}</td><td${cls}>${r.model === "complex" ? "复数" : "经典"}</td>` +
      `<td${cls}>${board(r)}</td><td class="num"${cls}>${r.games}</td>` +
      `<td class="num"${cls}>${pct(r.wins, r.games)}</td>` +
      `<td${cls}>${esc(r.ip)}</td><td${cls}>${clientCell(r)}</td>` +
      `<td${cls}>${esc(r.solver_ver || "")}</td>` +
      `<td${cls}>${esc(r.client_ver || "")}</td><td${cls}>${tm}</td></tr>`;
  };
  // 最近结果卡：热路径只带回最近 30 条（服务器裁），卡面取前 10。
  // 这里不套筛选——「筛选后几条」要对着全量才成立，全量在弹窗里现拉。
  const recent = Object.entries(d.done_recent || {}).sort((a, b) => b[1].time - a[1].time);
  fill("t-done-mini", "e-done-mini", recent.slice(0, 10).map(row));
  $("done-count").textContent = `最新的在最上面 · 共 ${d.done_total ?? recent.length} 条`;

  // 完整历史：弹窗点开时才拉的那一份（/api/history），分页窗口归 donePager 管
  if ($("hist-dlg").open) {
    if (!histData) {
      $("hist-count").textContent = histErr ? "载入失败：" + histErr : "正在载入完整历史…";
      $("done-pager").hidden = true;
    } else {
      const all = Object.entries(histData.done).sort((a, b) => b[1].time - a[1].time);
      const hf = all.filter(([tid, r]) => donePass(tid, r));
      donePager.setCount(hf.length);
      fill("t-done", "e-done", donePager.view(hf).map(row));
      $("hist-count").textContent = (hf.length === all.length
        ? `共 ${all.length} 条` : `筛选后 ${hf.length} / 共 ${all.length} 条`) +
        (badRanges.length ? ` · ⚠ 区间无效（最小>最大）：${badRanges.join("、")}` : "");
      donePager.draw();
    }
  }

  renderSolverFleet(d);
}

/* ---------- 最近结果筛选（纯客户端：数据本来就在内存里） ---------- */

let lastData = null;
let histData = null, histErr = "";   // 完整历史：点开「历史记录」弹窗才拉，null = 还没有
const inprogOpen = new Set();      // 进行中折叠树的展开状态（"ip" / "ip\nname"），默认全收起
const kickSel = new Set();         // 进行中勾选待剔除的任务（跨刷新保留，任务消失自动清）
const qdelSel = new Set();         // 队列勾选待删除的任务（存 task_id；组勾选=整组进集）
let qGroupsLive = [];              // 优先队列当前全部分组（筛选项的取值来源）
let qdelGroups = [];               // 弹窗当前渲染的分组（勾选框 data-g 指向这里）
const QUEUE_MINI_N = 10;           // 卡面只放最前面 10 组，其余进弹窗
const groupIds = (g) => {
  const ids = [];
  for (let s = g.start; s <= g.end; s++)
    ids.push(g.n === 1 ? g.t.task_id : `${s}-${g.t.model}-${g.t.cols}x${g.t.rows}x${g.t.mines}`);
  return ids;
};
const taskSeed = (tid) => parseInt(tid.split("-")[0], 10) || 0;

/* ---------- 列筛选状态（历史记录 + 合计共用一套 cf-pop 实现） ----------
   区间 {lo,hi}（空串 = 不限）、模式/IP 用 Set（空 = 不限）。
   cf-pop 里的输入框每次打开都重建，状态必须存在外面才跨开关保留。 */
const mkFilterState = (keys) => ({
  ranges: Object.fromEntries(keys.map((k) => [k, { lo: "", hi: "" }])),
  model: new Set(), ip: new Set(), dev: new Set(), time: { lo: "", hi: "" },
});
const doneF = mkFilterState(["seed", "cols", "rows", "mines", "den", "games", "wr"]);
const ipSel = doneF.ip;            // 空 = 不筛 IP（历史记录列专用）
const aggF = mkFilterState(["cols", "rows", "mines", "den"]);
const qF = mkFilterState(["seed", "cols", "rows", "mines", "den", "games"]);

const RANGE_LABELS = { seed: "种子", cols: "列", rows: "行", mines: "雷数",
  den: "密度 %", games: "局数", wr: "胜率 %", time: "时间" };
const badRangesOf = (st, keys) => keys.filter((k) => {
  const o = k === "time" ? st.time : st.ranges[k];
  return o.lo !== "" && o.hi !== "" && +o.lo > +o.hi;
}).map((k) => RANGE_LABELS[k]);
const doneBadRanges = () => badRangesOf(doneF, ["seed", "cols", "rows", "mines", "den", "games", "wr", "time"]);
const aggBadRanges = () => badRangesOf(aggF, ["cols", "rows", "mines", "den"]);
const qBadRanges = () => badRangesOf(qF, ["seed", "cols", "rows", "mines", "den", "games"]);

const inRangeF = (v, o) => (o.lo === "" || v >= +o.lo) && (o.hi === "" || v <= +o.hi);

/* 系统 / 设备的取值口径：和表格里 clientCell 同一拼接（os / name），老数据缺 os 只显示设备名 */
const devKey = (r) => [r.os, r.name].filter(Boolean).join(" / ") || "-";

function donePass(tid, r) {
  if (!$("done-show-invalid").checked && r.valid === false) return false;
  if (!inRangeF(taskSeed(tid), doneF.ranges.seed)) return false;
  if (doneF.model.size && !doneF.model.has(r.model)) return false;
  if (!inRangeF(r.cols, doneF.ranges.cols) || !inRangeF(r.rows, doneF.ranges.rows) ||
      !inRangeF(r.mines, doneF.ranges.mines) ||
      !inRangeF(100 * r.mines / (r.cols * r.rows), doneF.ranges.den) ||
      !inRangeF(r.games, doneF.ranges.games) ||
      !inRangeF(100 * r.wins / r.games, doneF.ranges.wr)) return false;
  if (ipSel.size && !ipSel.has(r.ip)) return false;
  if (doneF.dev.size && !doneF.dev.has(devKey(r))) return false;
  if (doneF.time.lo !== "" && r.time * 1000 < doneF.time.lo) return false;
  if (doneF.time.hi !== "" && r.time * 1000 > doneF.time.hi) return false;
  return true;
}

function aggPass(a) {
  if (aggF.model.size && !aggF.model.has(a.model)) return false;
  if (!inRangeF(a.cols, aggF.ranges.cols) || !inRangeF(a.rows, aggF.ranges.rows) ||
      !inRangeF(a.mines, aggF.ranges.mines)) return false;
  return inRangeF(100 * a.mines / (a.cols * a.rows), aggF.ranges.den);
}

/* 优先队列一行是一「组」（种子连续合并），所以种子区间按交集判：
   组覆盖 [start,end]，筛选区间 [lo,hi]，两头都不搭界才排除。 */
function qPass(g) {
  const o = qF.ranges, r = g.t;
  if (o.seed.lo !== "" && g.end < +o.seed.lo) return false;
  if (o.seed.hi !== "" && g.start > +o.seed.hi) return false;
  if (qF.model.size && !qF.model.has(r.model)) return false;
  if (!inRangeF(r.cols, o.cols) || !inRangeF(r.rows, o.rows) ||
      !inRangeF(r.mines, o.mines) ||
      !inRangeF(100 * r.mines / (r.cols * r.rows), o.den) ||
      !inRangeF(r.games, o.games)) return false;
  return true;
}

/* ---------- 列筛选浮层（cmsui 同款：表头 ▾ → cf-pop，改动立即生效）。
   历史记录（#t-done / #cf-pop）、合计（#t-agg / #agg-pop）、优先队列
   （#t-queue-full / #queue-pop）共用同一实现：
   列定义 + 状态 + apply 各配一份，弹窗构建逻辑只此一份。 ---------- */

const cel = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const CHOICES_MODEL = [["complex", "复数"], ["classic", "经典"]];

const DONE_COLS = {
  task:  { ranges: [["种子", "seed"]] },
  model: { choices: CHOICES_MODEL },
  spec:  { ranges: [["列", "cols"], ["行", "rows"], ["雷数", "mines"], ["密度 %", "den", .1]],
           link: ["mines", "den"] },
  games: { ranges: [["局数", "games"]] },
  wr:    { ranges: [["胜率 %", "wr", .1]] },
  ip:    { dyn: "ip", ph: "搜索 IP" },
  dev:   { dyn: "dev", ph: "搜索系统 / 设备" },
  time:  { time: true },
};
/* 动态选项列（IP / 系统设备）：取值函数从数据行里现算 */
const DYN_VAL = {
  ip:  (r) => r.ip,
  dev: (r) => devKey(r),
};
const AGG_COLS = {
  model: { choices: CHOICES_MODEL },
  spec:  { ranges: [["列", "cols"], ["行", "rows"], ["雷数", "mines"], ["密度 %", "den", .1]],
           link: ["mines", "den"] },
};
/* 优先队列弹窗：行是「组」，没有 IP / 设备 / 时间 / 胜率这些结果列 */
const QUEUE_COLS = {
  task:  { ranges: [["种子", "seed"]] },
  model: { choices: CHOICES_MODEL },
  spec:  { ranges: [["列", "cols"], ["行", "rows"], ["雷数", "mines"], ["密度 %", "den", .1]],
           link: ["mines", "den"] },
  games: { ranges: [["局数", "games"]] },
};

const msToInput = (ms) => {
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate())
      + "T" + p(d.getHours()) + ":" + p(d.getMinutes());
};

/* 「（全部）」三态复选框：全勾/全不勾都 = 不限（空集合），部分选中显示「−」。
   click + preventDefault 自己算目标态 —— indeterminate 的浏览器点击行为没有规范。 */
function mkAllBox(box, isAll, setAll, apply) {
  const all = cel("label", "cf-item cf-all");
  const allBox = document.createElement("input");
  allBox.type = "checkbox";
  allBox.title = "单击：全选 ↔ 全部取消";
  all.append(allBox, cel("span", null, "（全部）"));
  const sync = () => {
    const n = box.querySelectorAll("input:checked").length;
    const total = box.querySelectorAll("input").length;
    allBox.checked = n === total;
    allBox.indeterminate = n > 0 && n < total;
  };
  allBox.addEventListener("click", (ev) => {
    ev.preventDefault();
    setAll(!isAll());
    sync();
    apply();
    // activation behavior 会把 preventDefault 掉的点击回写成点击前的 checked，
    // 微任务在它之后跑，再刷一次才留得住（cmsui 踩过的坑）
    queueMicrotask(sync);
  });
  return { all, sync };
}

function mkColFilter(o) {
  // o: { popId, tableSel, cols, st, apply, getRows }
  const pop = $(o.popId);

  const colCount = (col) => {
    const d = o.cols[col], st = o.st;
    if (d.choices) return st.model.size;
    if (d.dyn) return st[d.dyn].size;
    if (d.time) return (st.time.lo !== "" || st.time.hi !== "") ? 1 : 0;
    return d.ranges.filter(([, k]) => st.ranges[k].lo !== "" || st.ranges[k].hi !== "").length;
  };

  const refresh = () => {
    document.querySelectorAll(o.tableSel + " th[data-col]").forEach((th) => {
      const b = th.querySelector(".cf-btn");
      if (!b) return;
      const n = colCount(th.dataset.col);
      b.textContent = n ? "▾" + n : "▾";
      b.classList.toggle("on", n > 0);
      th.classList.toggle("cf-active", n > 0);
    });
  };

  const close = () => {
    if (pop.hidden) return;
    pop.hidden = true;
    pop.replaceChildren();
    pop._cfAnchor = null;
  };

  const open = (th, btn) => {
    const col = th.dataset.col;
    const label = th.dataset.label || col;
    const d = o.cols[col];
    const st = o.st;
    pop.replaceChildren();
    pop.hidden = false;
    pop._cfAnchor = btn;

    const head = cel("div", "cf-head");
    head.append(cel("span", null, "筛选：" + label));
    const x = cel("button", "cf-x", "×");
    x.type = "button";
    x.title = "关闭";
    x.addEventListener("click", close);
    head.append(x);
    pop.append(head);

    if (d.ranges) {
      const inputs = {};
      for (const [rlabel, key, step] of d.ranges) {
        const row = cel("label", "cf-range");
        const lo = document.createElement("input");
        const hi = document.createElement("input");
        lo.type = hi.type = "number";
        if (step) lo.step = hi.step = step;
        lo.placeholder = "最小";
        hi.placeholder = "最大";
        lo.value = st.ranges[key].lo;
        hi.value = st.ranges[key].hi;
        const syncBad = () => {
          const bad = lo.value.trim() !== "" && hi.value.trim() !== "" && +lo.value > +hi.value;
          lo.classList.toggle("bad-range", bad);
          hi.classList.toggle("bad-range", bad);
        };
        const onInput = (which) => () => {
          st.ranges[key][which] = which === "lo" ? lo.value.trim() : hi.value.trim();
          syncBad();
          o.apply();
        };
        lo.addEventListener("input", onInput("lo"));
        hi.addEventListener("input", onInput("hi"));
        syncBad();
        row.append(cel("span", null, rlabel), lo, hi);
        pop.append(row);
        inputs[key] = [lo, hi];
      }
      // 规格：雷数 ⇄ 密度联动（参考列/行筛选值，缺省 30×16）
      if (d.link) {
        const [mKey, dKey] = d.link;
        const ref = () => [
          st.ranges.cols.lo !== "" ? +st.ranges.cols.lo
            : (st.ranges.cols.hi !== "" ? +st.ranges.cols.hi : 30),
          st.ranges.rows.lo !== "" ? +st.ranges.rows.lo
            : (st.ranges.rows.hi !== "" ? +st.ranges.rows.hi : 16)];
        const pairs = [[inputs[mKey][0], inputs[dKey][0]], [inputs[mKey][1], inputs[dKey][1]]];
        for (const [mi, di] of pairs) {
          mi.addEventListener("input", () => {
            const m = mi.value.trim();
            if (m !== "") {
              const [c, r] = ref();
              di.value = (100 * m / (c * r)).toFixed(1);
              st.ranges[dKey][di === inputs[dKey][0] ? "lo" : "hi"] = di.value;
              o.apply();
            }
          });
          di.addEventListener("input", () => {
            const den = di.value.trim();
            if (den !== "") {
              const [c, r] = ref();
              mi.value = Math.round(den * c * r / 100);
              st.ranges[mKey][mi === inputs[mKey][0] ? "lo" : "hi"] = mi.value;
              o.apply();
            }
          });
        }
      }
      pop.append(cel("p", "cf-hint", "留空表示不限；最小 > 最大会标红并在计数行点名。"));
    }

    if (d.choices) {
      const counts = {};
      // 合计卡的行是「规格聚合」，带 tasks 权重 → 显示任务数而不是规格数；
      // 历史/队列的行没有这个字段，按 1 计。
      for (const r of o.getRows()) counts[r.model] = (counts[r.model] || 0) + (r.tasks || 1);
      const box = cel("div", "cf-list");
      for (const [value, text] of d.choices) {
        const lb = cel("label", "cf-item");
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.value = value;
        inp.checked = st.model.size ? st.model.has(value) : true;
        inp.addEventListener("change", () => {
          const keep = [...box.querySelectorAll("input:checked")].map((b) => b.value);
          st.model.clear();
          if (keep.length > 0 && keep.length < box.querySelectorAll("input").length) {
            keep.forEach((v) => st.model.add(v));
          }
          allSync();
          o.apply();
        });
        lb.append(inp, cel("span", null, text), cel("span", "cf-n", counts[value] || 0));
        box.append(lb);
      }
      const { all, sync: allSync } = mkAllBox(
        box,
        () => box.querySelectorAll("input:checked").length === box.querySelectorAll("input").length,
        (want) => {
          // 全勾 / 全不勾都等于「不限」→ 集合直接清空
          box.querySelectorAll("input").forEach((b) => { b.checked = want; });
          st.model.clear();
        },
        o.apply);
      pop.append(all, box);
    }

    if (d.dyn) {
      const val = DYN_VAL[d.dyn];
      const set = st[d.dyn];
      const counts = {};
      const vals = [];
      for (const r of o.getRows()) {
        const v = val(r);
        counts[v] = (counts[v] || 0) + 1;
        if (!vals.includes(v)) vals.push(v);
      }
      vals.sort();
      const s = document.createElement("input");
      s.type = "search";
      s.className = "cf-search";
      s.placeholder = d.ph || "搜索";
      s.autocomplete = "off";
      s.addEventListener("input", () => {
        const needle = s.value.trim().toLowerCase();
        box.querySelectorAll(".cf-item").forEach((it) => {
          it.hidden = !needle || !(it.dataset.text || "").includes(needle);
        });
      });
      pop.append(s);
      const box = cel("div", "cf-list");
      for (const v of vals) {
        const lb = cel("label", "cf-item");
        lb.dataset.text = v.toLowerCase();
        const inp = document.createElement("input");
        inp.type = "checkbox";
        inp.value = v;
        inp.checked = set.has(v);
        inp.addEventListener("change", () => {
          if (inp.checked) set.add(v); else set.delete(v);
          allSync();
          o.apply();
        });
        lb.append(inp, cel("span", null, v), cel("span", "cf-n", counts[v] || 0));
        box.append(lb);
      }
      const { all, sync: allSync } = mkAllBox(
        box,
        () => set.size === 0,
        (want) => {
          set.clear();
          if (want) box.querySelectorAll("input").forEach((b) => set.add(b.value));
          box.querySelectorAll("input").forEach((b) => { b.checked = want; });
        },
        o.apply);
      pop.append(all, box);
    }

    if (d.time) {
      const mk = (key, tlabel) => {
        const row = cel("label", "cf-range");
        const inp = document.createElement("input");
        inp.type = "datetime-local";
        inp.step = "60";
        inp.value = st.time[key] === "" ? "" : msToInput(st.time[key]);
        inp.addEventListener("input", () => {
          st.time[key] = inp.value === "" ? "" : new Date(inp.value).getTime();
          syncBad();
          o.apply();
        });
        row.append(cel("span", null, tlabel), inp);
        return inp;
      };
      const lo = mk("lo", "开始");
      const hi = mk("hi", "结束");
      const syncBad = () => {
        const bad = st.time.lo !== "" && st.time.hi !== "" && st.time.lo > st.time.hi;
        lo.classList.toggle("bad-range", bad);
        hi.classList.toggle("bad-range", bad);
      };
      syncBad();
      pop.append(lo.parentElement, hi.parentElement,
        cel("p", "cf-hint", "留空表示不限；按本机时区解释。"));
    }

    const foot = cel("div", "cf-foot");
    const clear = cel("button", "ghost tiny", "清空本列");
    clear.type = "button";
    clear.addEventListener("click", () => {
      if (d.ranges) d.ranges.forEach(([, k]) => { st.ranges[k] = { lo: "", hi: "" }; });
      if (d.choices) st.model.clear();
      if (d.dyn) st[d.dyn].clear();
      if (d.time) st.time = { lo: "", hi: "" };
      open(th, btn);   // 原地重开：输入框/勾选归零
      o.apply();
    });
    foot.append(clear);
    pop.append(foot);

    // 定位到列头下方；放不下就翻到上面
    const r = btn.getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 12));
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
    pop.style.left = left + "px";
    pop.style.top = top + "px";
  };

  const init = () => {
    document.querySelectorAll(o.tableSel + " th[data-col]").forEach((th) => {
      const b = cel("button", "cf-btn", "▾");
      b.type = "button";
      b.title = "筛选这一列";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // 点同一个 ▾ = 收起
        if (pop._cfAnchor === b && !pop.hidden) {
          close();
          return;
        }
        open(th, b);
      });
      th.append(b);
    });
    refresh();
  };

  const clearAll = () => {
    for (const k of Object.keys(o.st.ranges)) o.st.ranges[k] = { lo: "", hi: "" };
    o.st.model.clear();
    o.st.ip.clear();
    o.st.dev.clear();
    o.st.time = { lo: "", hi: "" };
    close();
    refresh();
    o.apply();
  };

  return { pop, refresh, close, open, init, clearAll };
}

const doneRows = () => histData ? Object.values(histData.done) : [];
const aggRows = () => (lastData && lastData.agg_spec) || [];   // 服务器算好的有效结果聚合
/* 队列弹窗的选项计数按「组」算（一行就是一组），所以取每组的代表任务 */
const queueRows = () => qGroupsLive.map((g) => g.t);

function applyDone() { doneFilter.refresh(); lastData && render(lastData); }
function applyAgg() { aggFilter.refresh(); lastData && render(lastData); }
function applyQueue() { queueFilter.refresh(); lastData && render(lastData); }

const doneFilter = mkColFilter({
  popId: "cf-pop", tableSel: "#t-done", cols: DONE_COLS, st: doneF,
  apply: applyDone, getRows: doneRows,
});
const aggFilter = mkColFilter({
  popId: "agg-pop", tableSel: "#t-agg", cols: AGG_COLS, st: aggF,
  apply: applyAgg, getRows: aggRows,
});
const queueFilter = mkColFilter({
  popId: "queue-pop", tableSel: "#t-queue-full", cols: QUEUE_COLS, st: qF,
  apply: applyQueue, getRows: queueRows,
});

doneFilter.init();
aggFilter.init();
queueFilter.init();

// 点外面 / Esc / 滚动 / 改窗口大小都关掉（滚动时面板不会跟着列头走）
const ALL_FILTERS = [doneFilter, aggFilter, queueFilter];
document.addEventListener("click", (ev) => {
  for (const f of ALL_FILTERS) {
    if (f.pop.hidden) continue;
    if (f.pop.contains(ev.target)) continue;
    if (f.pop._cfAnchor && f.pop._cfAnchor.contains(ev.target)) continue;
    f.close();
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") ALL_FILTERS.forEach((f) => f.close());
});
window.addEventListener("resize", () => ALL_FILTERS.forEach((f) => f.close()));
window.addEventListener("scroll", () => ALL_FILTERS.forEach((f) => f.close()), true);

$("btn-filter-clear").onclick = () => {
  doneFilter.clearAll();
  lastData && render(lastData);
};
$("btn-agg-clear").onclick = () => {
  aggFilter.clearAll();
  lastData && render(lastData);
};
$("btn-qfilter-clear").onclick = () => {
  queueFilter.clearAll();
  lastData && render(lastData);
};

/* ---------- 历史记录弹窗（近全屏）+ 分页 ---------- */

/* 分页器工厂：历史记录 / 优先队列 / 版本历史三处共用一份实现。
   页码与每页条数归工厂所有，调用方只喂 setCount() → view() → draw()。
   改每页条数时按「改之前看到的第一条」重算页码，那一条仍排在新页第一行；
   页码输入框失焦才生效（打字中途不被钳制），越界由 setCount 收回来。 */
function mkPager(cfg) {
  let page = 1, size = cfg.initSize || 30, count = 0;
  const pages = () => Math.max(1, Math.ceil(count / size));
  const draw = () => {
    page = Math.min(Math.max(1, page), pages());
    $(cfg.wrap).hidden = count === 0;
    $(cfg.total).textContent = `/ ${pages()} 页`;
    $(cfg.prev).disabled = page <= 1;
    $(cfg.next).disabled = page >= pages();
    if (document.activeElement !== $(cfg.num)) $(cfg.num).value = page;
  };
  $(cfg.size).addEventListener("change", () => {
    let v = parseInt($(cfg.size).value, 10);
    if (!Number.isFinite(v)) v = size;              // 纯非法输入 → 还原旧值
    v = Math.min(500, Math.max(1, v));
    const anchor = (page - 1) * size;
    size = v;
    page = Math.floor(anchor / size) + 1;
    $(cfg.size).value = v;
    cfg.onChange();
  });
  $(cfg.num).addEventListener("change", () => {
    const v = parseInt($(cfg.num).value, 10);
    page = Number.isFinite(v) ? v : page;
    cfg.onChange();
    $(cfg.num).value = page;                        // 回显钳制后的真实页码
  });
  $(cfg.prev).onclick = () => { page--; cfg.onChange(); };
  $(cfg.next).onclick = () => { page++; cfg.onChange(); };
  return {
    setCount(n) { count = n; page = Math.min(Math.max(1, page), pages()); },
    start() { return (page - 1) * size; },
    view(rows) { const s = (page - 1) * size; return rows.slice(s, s + size); },
    draw,
  };
}

$("btn-hist-open").onclick = () => {
  $("hist-dlg").showModal();
  lastData && render(lastData);
  // 全量明细不走热路径（那 70KB 是刷新慢的根因），点开弹窗才现拉一次。
  // 完成数和上次拉的对不上 = 期间有新结果进来 → 重新拉，不然看到的是旧账。
  const stale = histData && lastData && histData.done_total !== lastData.done_total;
  if (!histLoading && (!histData || stale)) loadHistory();
};
$("btn-hist-close").onclick = () => $("hist-dlg").close();
$("hist-dlg").addEventListener("close", () => refresh());   // 关掉补一次刷新
// 「显示已作废」只在 donePass 里被读；弹窗开着时 refresh() 是跳过的，
// 不接这条监听的话勾上去要等下一次刷新才见效——等于没反应。
$("done-show-invalid").addEventListener("change", () => { lastData && render(lastData); });

let histLoading = false;

async function loadHistory() {
  histLoading = true;
  histErr = "";
  const e = $("e-done");
  e.hidden = false;
  e.textContent = "正在载入完整历史…（全量明细要过一次公网，约 1~5 秒）";
  try {
    histData = await api("/api/history");
  } catch (err) {
    histErr = err.message;
    e.textContent = "载入失败：" + err.message;
    toast("历史记录载入失败：" + err.message, "bad");
  } finally {
    histLoading = false;
    lastData && render(lastData);
  }
}

const donePager = mkPager({
  wrap: "done-pager", size: "done-size", num: "page-num", total: "page-total",
  prev: "page-prev", next: "page-next", initSize: 30,
  onChange: () => { lastData && render(lastData); },
});

/* 优先队列弹窗：卡面只读 10 组，筛选 / 分页 / 勾选删除都在弹窗里 */
$("btn-queue-open").onclick = () => {
  $("queue-dlg").showModal();
  lastData && render(lastData);
};
$("btn-queue-close").onclick = () => $("queue-dlg").close();

const queuePager = mkPager({
  wrap: "queue-pager", size: "queue-size", num: "queue-num", total: "queue-total",
  prev: "queue-prev", next: "queue-next", initSize: 30,
  onChange: () => { lastData && render(lastData); },
});

// 进行中折叠树：tbody 事件委托（fill() 只换 innerHTML，tbody 本体不换，监听不会丢）
$("t-inprog").querySelector("tbody").addEventListener("click", (e) => {
  if (e.target.closest("input, label")) return;   // 勾选框不是折叠开关
  const tr = e.target.closest("tr.group-row");
  if (!tr) return;
  const k = tr.dataset.groupKey;
  if (!k) return;
  if (inprogOpen.has(k)) inprogOpen.delete(k); else inprogOpen.add(k);
  lastData && render(lastData);
});
$("t-inprog").querySelector("tbody").addEventListener("change", (e) => {
  const cb = e.target;
  if (!cb.classList || !cb.classList.contains("kick-chk")) return;
  if (cb.classList.contains("grp-chk")) {
    // 组复选框：整组任务进出勾选集（组头行本身不进集合，集合只装 task_id）
    const ids = grpTaskIds(cb.dataset.gkey, cb.dataset.scope);
    if (cb.checked) ids.forEach((id) => kickSel.add(id));
    else ids.forEach((id) => kickSel.delete(id));
    lastData && render(lastData);
    return;
  }
  if (cb.checked) kickSel.add(cb.dataset.tid); else kickSel.delete(cb.dataset.tid);
  lastData && render(lastData);
});
$("inprog-all").addEventListener("change", () => {
  const on = $("inprog-all").checked;
  for (const b of document.querySelectorAll("#t-inprog .kick-chk")) {
    b.checked = on;
    if (on) kickSel.add(b.dataset.tid); else kickSel.delete(b.dataset.tid);
  }
  lastData && render(lastData);
});
$("btn-kick").onclick = () => {
  const ids = [...kickSel];
  if (!ids.length) return;
  const ans = prompt(`将把选中的 ${ids.length} 个任务强制收回队列重发：\n`
    + `  ${ids.join("\n  ")}\n`
    + "未交的结果作废，对应客户端跑完上传会被拒绝；种子由其他健康客户端重算。\n"
    + "输入 confirm 确认执行：");
  if (ans === null) return;
  if (ans.trim() !== "confirm") return toast("没有输入 confirm，已取消剔除", "bad");
  runGuarded("kick", ids, `剔除 ${ids.length} 个任务（收回队列重发）：${ids.join("、")}`);
};

$("btn-drop").onclick = () => {
  const ids = [...kickSel];
  if (!ids.length) return;
  const ans = prompt(`将把选中的 ${ids.length} 个任务直接删除（不回队列，种子作废）：\n`
    + `  ${ids.join("\n  ")}\n`
    + "对应客户端跑完上传会被拒绝，这些种子不会有人重算。\n"
    + "输入 confirm 确认执行：");
  if (ans === null) return;
  if (ans.trim() !== "confirm") return toast("没有输入 confirm，已取消删除", "bad");
  runGuarded("drop", ids, `删除 ${ids.length} 个任务（不回队列）：${ids.join("、")}`);
};

async function refresh(quiet = false) {
  if ($("hist-dlg").open) return;   // 历史弹窗开着就停止刷新（关掉时补一次）
  loadSolverHist();                 // 本地 git 现算、服务端按 HEAD 缓存，静默失败不吵
  try {
    const d = await api("/api/status");
    lastData = d;
    render(d);
    if (!quiet) toast("✓ 刷新成功", "ok", 2000);
  } catch (e) {
    toast("刷新失败：" + e.message, "bad");
  }
}

/* ---------- 求解器版本：三个口径（线上在跑 / 已发布 / 工作区） ---------- */

/* 「线上在跑」= 当前进行中任务按领取时上报的**两个身份**聚合，每格「求解器 · 客户端」+ 终端数
   （一个终端=一个客户端进程=一个任务）。领取上报的身份要服务器存得下
   （admin-lite 带 solver_ver / client_ver）才看得到——旧服务器/旧包都归「未上报」，
   不代表包旧，别冤枉人。混跑期全列出来，不挑一个骗人。 */
function renderSolverFleet(d) {
  const UNKNOWN = "未上报";
  const chip = (v) => (v === UNKNOWN ? esc(v) : `<code>${esc(v)}</code>`);
  // 成对聚合，不拆成两行：拆着看会把「新客户端 + 老求解器」这种半更新藏起来
  // ——两边各自都只剩一个值，看着像全员一致，其实那台机器的求解器根本没换
  const agg = new Map();
  for (const t of d.inprog) {
    const k = `${t.solver_ver || UNKNOWN}\u0000${t.client_ver || UNKNOWN}`;
    agg.set(k, (agg.get(k) || 0) + 1);
  }
  const rows = [...agg.entries()].sort((x, y) => y[1] - x[1])
    .map(([k, n]) => [k.split("\u0000"), n]);
  const el = $("solver-fleet"), note = $("solver-fleet-note");
  if (!rows.length) {
    el.textContent = "—";
    note.textContent = "当前没有任务在跑";
    return;
  }
  el.innerHTML = rows.map(([[sv, cv], n]) =>
    `${chip(sv)} · ${chip(cv)} ${n} 终端`).join("、");
  note.textContent = "当前进行中 · 每格是「求解器 · 客户端」"
    + (rows.length > 1 ? " · 多版本混跑中" : "");
}

/* 历史行来自本机 git，不经过服务器；「已发布」读服务器上的 manifest。
   卡里只放最新 10 条，全量进「版本历史」弹窗（最近结果同款形态）。 */
let solverHistData = null;
const VER_MINI_N = 10;

function verRows(entries, cur, curClient) {
  const tm = (ts) => new Date(ts * 1000).toLocaleString("zh-CN",
    { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return entries.map((e) =>
    `<tr${e.ver === cur && e.client === curClient ? ' class="solver-cur-row"' : ""}>` +
    `<td><code>${esc(e.ver)}</code></td>` +
    // 客户端 2026-10-31 才有这个文件：更早的提交那一格是「那时还没有」，不是「未知」
    (e.client ? `<td><code>${esc(e.client)}</code></td>` : '<td class="muted">—</td>') +
    `<td><code>${esc(e.sha)}</code></td>` +
    `<td class="num">${tm(e.ts)}</td><td>${esc(e.subject)}</td></tr>`).join("");
}

function renderSolverTables() {
  const d = solverHistData;
  if (!d) return;
  $("t-solver").querySelector("tbody").innerHTML =
    verRows(d.entries.slice(0, VER_MINI_N), d.current, d.current_client);
  $("e-solver").hidden = d.entries.length > 0;
  if ($("ver-dlg").open) {
    verPager.setCount(d.entries.length);
    $("t-ver").querySelector("tbody").innerHTML =
      verRows(verPager.view(d.entries), d.current, d.current_client);
    $("ver-count").textContent = `共 ${d.entries.length} 个版本（任一身份变了就收一条）`;
    verPager.draw();
  }
}

const verPager = mkPager({
  wrap: "ver-pager", size: "ver-size", num: "ver-num", total: "ver-total",
  prev: "ver-prev", next: "ver-next", initSize: 15,
  onChange: () => renderSolverTables(),
});

/* 「已发布」的客户端是**三份**——每个平台一份程序字节（mac = 整包二进制，
   win / linux = 包里那个 dist_client.py）。一台机器该对哪份取决于它的系统，
   所以三份全列出来，不挑一份代表全部。 */
function pubClientHtml(m) {
  if (!m || !Object.keys(m).length) return '<span class="muted">—</span>';
  return Object.entries(m).map(([k, v]) => `${esc(k)} <code>${esc(v)}</code>`).join(" · ");
}

async function loadSolverHist() {
  let d;
  try { d = await api("/api/solver-history"); }
  catch { return; }                  // 旧进程没这个接口/重启前：留 —，不弹错
  solverHistData = d;
  $("solver-current").textContent = d.current;
  $("client-current").textContent = d.current_client || "—";
  $("solver-dirty").textContent = d.dirty
    ? "（工作区有未提交改动，改着玩只动这一行）" : "";
  $("solver-published").textContent = d.published || "—";
  $("client-published").innerHTML = pubClientHtml(d.published_client);
  $("solver-published-note").textContent = d.published
    ? "下一个领任务的客户端会变成它" : "线上 manifest 还没带这个字段，下次发版自动有";
  renderSolverTables();
}

$("btn-ver-open").onclick = () => {
  $("ver-dlg").showModal();
  renderSolverTables();   // 开着期间数据没到过（首帧前就点了）也补渲染
};
$("btn-ver-close").onclick = () => $("ver-dlg").close();

/* ---------- 刷新控制（放「合计」卡头，cmsui 同款） ---------- */

let timer = null;
function setAuto() {
  clearInterval(timer);
  const btn = $("btn-toggle-auto");
  if (btn.getAttribute("aria-pressed") === "true") {
    const s = Math.max(1, parseInt($("refresh-interval").value, 10) || 15);
    timer = setInterval(refresh, s * 1000);
  }
}
$("btn-toggle-auto").onclick = () => {
  const b = $("btn-toggle-auto");
  const on = b.getAttribute("aria-pressed") === "true";
  b.setAttribute("aria-pressed", String(!on));
  b.textContent = on ? "▶ 继续自动刷新" : "⏸ 暂停自动刷新";
  setAuto();
};
$("refresh-interval").onchange = setAuto;
$("btn-refresh").onclick = refresh;

/* ---------- 规格输入：三框 + 密度实时显示 + 实时合法性 ---------- */

function bindDensity(prefix, btnId, extra) {
  const upd = () => {
    const c = +$(prefix + "-cols").value, r = +$(prefix + "-rows").value, m = +$(prefix + "-mines").value;
    const el = $(prefix + "-density");
    el.textContent = densityOf(c, r, m);
    // 输入时就给判词，别等点了入队才挨 toast。红=必被拦（readBoard 同口径），
    // 橙=能交但会弹慢/密度确认；正常色=随便发
    const bad = (el.dataset.bad =
      !Number.isInteger(c) || !Number.isInteger(r) || !Number.isInteger(m) ? "列/行/雷数必须是整数"
      : c < 2 || r < 2 ? "列和行至少为 2"
      : m < 1 ? "雷数至少为 1"
      : m >= c * r ? `雷数必须小于 ${c}×${r}=${c * r}（最多 ${c * r - 1}）`
      : "");
    const warn = !bad && (c > 50 || r > 50 || 100 * m / (c * r) > 30);
    el.classList.toggle("illegal", !!bad);
    el.classList.toggle("warn", warn);
    el.title = bad || (warn ? "确认后可提交：盘面大或密度高，求解可能很慢" : "");
    const btn = btnId && $(btnId);
    if (btn) {
      const extraMsg = extra ? extra() : "";
      const all = bad || extraMsg;
      btn.disabled = !!all;
      btn.title = all || (warn ? "确认后可提交：盘面大或密度高，求解可能很慢" : "");
    }
  };
  ["cols", "rows", "mines"].forEach((k) => $(prefix + "-" + k).addEventListener("input", upd));
  upd();
  return upd;
}

/* 插队种子区间：起/止填全时数量被区间制约（n = 止−起+1），
   只填数量时止种子由起+数量−1 反推；起>止标红并拦住入队。 */
const isUint = (v) => /^\d+$/.test(v) && +v >= 1;
function insSeedMsg() {
  const s = $("ins-seed").value.trim(), e = $("ins-seed-end").value.trim();
  const bad = isUint(s) && isUint(e) && +s > +e ? "起种子大于止种子" : "";
  $("ins-seed").classList.toggle("bad-range", bad);
  $("ins-seed-end").classList.toggle("bad-range", bad);
  return bad;
}
const updInsDensity = bindDensity("ins", "btn-insert", insSeedMsg);
function updInsSeed(edited) {
  const sEl = $("ins-seed"), eEl = $("ins-seed-end"), nEl = $("ins-n");
  const s = sEl.value.trim(), e = eEl.value.trim(), nv = nEl.value.trim();
  // 最后动的是谁，谁说了算：动止→重算数量；动数量→重算止；动起→另一边已有的跟着重算
  if (edited === "end" && isUint(s) && isUint(e)) nEl.value = +e - +s + 1;
  else if (edited === "n" && isUint(s) && isUint(nv)) eEl.value = +s + +nv - 1;
  else if (edited === "start") {
    if (isUint(e) && isUint(s)) nEl.value = +e - +s + 1;
    else if (isUint(s) && isUint(nv)) eEl.value = +s + +nv - 1;
  }
  updInsDensity();
}
$("ins-seed").addEventListener("input", () => updInsSeed("start"));
$("ins-seed-end").addEventListener("input", () => updInsSeed("end"));
$("ins-n").addEventListener("input", () => updInsSeed("n"));
const updDefDensity = bindDensity("def", "btn-default");

/* 两块操作表单预填当前默认流。只在字段「没被用户改过」时覆盖：
   动过一次就归用户所有，之后的刷新不再碰它；正在聚焦的也不碰。 */
const formDirty = new Set();
["ins-model", "ins-games", "ins-seed", "ins-cols", "ins-rows", "ins-mines",
 "def-model", "def-games", "def-cols", "def-rows", "def-mines"].forEach((id) =>
  $(id).addEventListener("input", () => formDirty.add(id)));

function prefillField(id, v) {
  const el = $(id);
  if (formDirty.has(id) || el === document.activeElement) return;
  el.value = v;
}

function prefillForms(def) {
  prefillField("ins-model", def.model);
  prefillField("ins-games", def.games ?? "");
  prefillField("ins-cols", def.cols);
  prefillField("ins-rows", def.rows);
  prefillField("ins-mines", def.mines);
  prefillField("def-model", def.model);
  prefillField("def-games", def.games ?? "");
  prefillField("def-cols", def.cols);
  prefillField("def-rows", def.rows);
  prefillField("def-mines", def.mines);
  updInsDensity();
  updDefDensity();
}

/** 读三框规格并校验。合法返回 {cols,rows,mines}，非法 toast 并返回 null。
    行列 >50 或密度 >30% 时弹确认（用户说继续才放行）。 */
function readBoard(prefix, what) {
  const c = +$(prefix + "-cols").value, r = +$(prefix + "-rows").value, m = +$(prefix + "-mines").value;
  for (const [v, name] of [[c, "列"], [r, "行"], [m, "雷数"]]) {
    if (!Number.isInteger(v) || v < 1) { toast(`${what}：${name}必须是正整数`, "bad"); return null; }
  }
  if (c < 2 || r < 2) { toast(`${what}：列和行至少为 2`, "bad"); return null; }
  if (m >= c * r) { toast(`${what}：雷数必须小于 ${c}×${r}=${c * r}`, "bad"); return null; }
  const den = 100 * m / (c * r);
  if ((c > 50 || r > 50) &&
      !confirm(`${what}的盘面 ${c}×${r} 超过 50，求解可能非常慢，确定继续吗？`)) return null;
  if (den > 30 && !confirm(`${what}的雷密度 ${den.toFixed(1)}% 超过 30%，确定继续吗？`)) return null;
  return { cols: c, rows: r, mines: m };
}
const intArg = (el, what) => {
  const v = el.value.trim();
  if (!v) return [];
  if (!/^\d+$/.test(v)) { toast(`${what}必须是正整数`, "bad"); return null; }
  return [v];
};

/* ---------- 操作（全部要口令） ---------- */

const MODEL = (m) => (m === "complex" ? "复数" : "经典");
const FMT_BOARD = (s) => s.split("x").join("×");

/** 把服务器回执翻成人话（JSON 是给程序看的，不是给人看的） */
function successMsg(op, args, data) {
  switch (op) {
    case "insert": {
      const [, model, b, games, seed] = args;
      const got = (data && data.queued) || [];
      let msg = `已入队 ${got.length} 个 ${MODEL(model)} 任务（${FMT_BOARD(b)}` +
        `${games ? ` × ${games}局` : "，局数同默认流"}${seed ? `，从种子 ${seed} 起` : ""}）`;
      const segs = (data && data.segs) || [];
      const skipped = (data && data.skipped) || 0;
      if (seed && segs.length) {
        const segTxt = segs.map(([a, z]) => a === z ? a : `${a}–${z}`).join("、");
        if (skipped > 0) msg += `；${skipped} 个种子已做过被跳过，实际入队分段：${segTxt}`;
        else if (segs.length > 1) msg += `；实际入队分段：${segTxt}`;
      }
      return msg;
    }
    case "default":
      return `默认任务流已改为 ${MODEL(args[0])} ${FMT_BOARD(args[1])}` +
             `${args[2] ? ` × ${args[2]}局` : "（局数不变）"}`;
    case "pause": return "任务发放已暂停";
    case "resume": return "任务发放已恢复";
    case "lease": return `租约已改为 ${args[0]}${args[1]}`;
    case "cool": return `回收冷却已改为 ${args.join("")}`;
    case "seed": return `下一个种子已改为 ${args[0]}`;
    case "limit": return `每 IP 并发上限已改为 ${args[0]}`;
    case "pomo": {
      const p = data && data.pomo;
      if (args[0] === "off") return "调度番茄钟已关掉（之后领的任务照常一直发）";
      if (!p || !p.on) return "番茄钟没打开";
      const w = p.work_sec, r = p.rest_sec;
      return `${args[0] === "on" ? "调度番茄钟已开" : "番茄钟时长已改"}：连算 ${pomoHuman(w)} 歇 ${pomoHuman(r)}` +
             `（${pomoHuman(w + r)} 一轮，相位从这一刻起算；正在跑的任务按各自领到的时刻表走完）`;
    }
    case "clear-queue": return "优先队列已清空";
    case "rm": {
      const hit = (data && data.removed) || [];
      const miss = (data && data.not_in_queue) || [];
      return (hit.length ? `已删除 ${hit.length} 个队列任务` : "没有删掉任何任务") +
             (miss.length ? `；${miss.length} 个不在队列里（可能刚被领走）` : "");
    }
    case "invalidate": {
      const hit = data && data.invalidated;
      return hit ? `已作废 ${hit.length} 个结果（${hit.join("、")}）` : `已作废 ${args[0]}`;
    }
    case "kick": {
      const hit = (data && data.kicked) || [];
      return hit.length
        ? `已剔除 ${hit.length} 个任务（收回队列重发）：${hit.join("、")}`
        : "没有剔除任何任务（可能刚被完成或已收回）";
    }
    case "drop": {
      const hit = (data && data.dropped) || [];
      const miss = (data && data.not_in_progress) || [];
      return (hit.length ? `已删除 ${hit.length} 个进行中任务（不回队列，种子作废）`
                         : "没有删掉任何任务") +
             (miss.length ? `；${miss.length} 个已不在进行中` : "");
    }
    default: return "操作完成";
  }
}

function runGuarded(op, args, desc) {
  if (rememberedPw) return runOp(op, args, rememberedPw, desc);
  pendingOp = { op, args, desc };
  $("dlg-desc").textContent = desc;
  $("dlg-err").hidden = true;
  $("dlg-pw").value = "";
  $("dlg").showModal();
  $("dlg-pw").focus();
}

async function runOp(op, args, admin, desc) {
  const btns = document.querySelectorAll("button");
  btns.forEach((b) => (b.disabled = true));
  try {
    const r = await api("/api/op", { op, args, admin });
    toast("✓ " + successMsg(op, args, r), "ok");
    $("dlg").close();
    histData = null;      // 作废/删除都会改历史，缓存直接作废，下次点开重新拉
    await refresh(true);   // 操作回执 toast 已在屏上，别让「刷新成功」盖掉它
  } catch (e) {
    // 口令错 → 弹窗不关，原地重试（不从头再来）
    $("dlg-err").textContent = "✗ " + e.message;
    $("dlg-err").hidden = false;
    if (e.message.includes("口令")) {
      rememberedPw = null;                       // 记住的口令已失效
      if (!pendingOp) pendingOp = { op, args, desc };  // 记住口令路径失败也要能原地重试
      $("dlg-pw").focus();
    } else {
      toast("✗ " + e.message, "bad");
      $("dlg").close();
    }
  } finally {
    btns.forEach((b) => (b.disabled = false));
  }
}

$("btn-insert").onclick = () => {
  const sEl = $("ins-seed").value.trim(), eEl = $("ins-seed-end").value.trim();
  let n;
  if (sEl === "" && eEl !== "")
    return toast("止种子需要和起种子一起填", "bad");
  if (sEl !== "" && eEl !== "") {
    // 区间模式：数量被区间制约；区间里的已做种子服务器会跳过并分段回报
    if (!isUint(sEl) || !isUint(eEl)) return toast("起止种子必须是正整数", "bad");
    if (+sEl > +eEl) return toast("起种子大于止种子", "bad");
    if (+sEl > 4294967295 || +eEl > 4294967295) return toast("种子超出 uint32 上限（4294967295）", "bad");
    n = String(+eEl - +sEl + 1);
  } else {
    n = $("ins-n").value.trim();
    if (!/^\d+$/.test(n) || +n < 1) return toast("数量必须是正整数", "bad");
  }
  if (+n > 500) return toast("一次最多插队 500 个", "bad");
  const b = readBoard("ins", "插队规格"); if (!b) return;
  const g = intArg($("ins-games"), "局数"); if (g === null) return;
  const args = [n, $("ins-model").value, `${b.cols}x${b.rows}x${b.mines}`, ...g,
    ...(sEl !== "" ? [sEl] : [])];
  runGuarded("insert", args, `插队 ${args.join(" ")}`);
};
$("btn-default").onclick = () => {
  const b = readBoard("def", "默认流规格"); if (!b) return;
  const g = intArg($("def-games"), "局数"); if (g === null) return;
  const args = [$("def-model").value, `${b.cols}x${b.rows}x${b.mines}`, ...g];
  runGuarded("default", args, `把默认流改成 ${args.join(" ")}（进行中的任务不受影响）`);
};
$("btn-lease").onclick = () => {
  const h = $("lease-h").value.trim() || "0", m = $("lease-m").value.trim() || "0";
  if (!/^\d+$/.test(h) || !/^\d+$/.test(m) || (+h === 0 && +m === 0))
    return toast("租约不能是 0，且必须是非负整数", "bad");
  runGuarded("lease", [`${h}h`, `${m}m`], `把租约改成 ${h}h${m}m`);
};
$("btn-cool").onclick = () => {
  const ids = ["cool-d", "cool-h", "cool-m", "cool-s"], units = ["d", "h", "m", "s"];
  const vals = ids.map((id) => $(id).value.trim() || "0");
  if (vals.some((v) => !/^\d+$/.test(v)))
    return toast("冷却时间必须是非负整数", "bad");
  const sec = +vals[0] * 86400 + +vals[1] * 3600 + +vals[2] * 60 + +vals[3];
  if (sec > 7 * 86400) return toast("冷却不能超过 7 天", "bad");
  const fmt = vals.map((v, i) => (v !== "0" ? `${v}${units[i]}` : "")).join("") || "0s";
  runGuarded("cool", vals.map((v, i) => `${v}${units[i]}`),
             `把回收冷却改成 ${fmt}${sec === 0 ? "（收回即领，不再冷却）" : ""}`);
};
$("btn-seed").onclick = () => {
  const v = $("c-seed").value.trim();
  if (!/^\d+$/.test(v) || +v < 1) return toast("种子必须是正整数", "bad");
  if (+v > 4294967295) return toast("种子超出 uint32 上限（4294967295）", "bad");
  runGuarded("seed", [v], `把下一个种子改成 ${v}（已完成的种子+规模发放时会自动跳过）`);
};
$("btn-limit").onclick = () => {
  const v = $("ip-limit").value.trim();
  if (!/^\d+$/.test(v) || +v < 1) return toast("每IP并发上限必须是正整数", "bad");
  if (+v > 6 && !confirm(`每 IP 并发上限 ${v} 超过 6，单人可同时占更多任务，确定继续吗？`)) return;
  runGuarded("limit", [v], `把每 IP 并发上限改成 ${v}`);
};
$("btn-pomo").onclick = () => {
  if (POMO.enabled) {
    return runGuarded("pomo", ["off"],
      "关掉调度番茄钟（只影响之后领的任务；正在跑的按它领到的时刻表走完）");
  }
  const spec = pomoSpecFromInputs();
  if (!spec) return;
  runGuarded("pomo", ["on", spec],
    `开调度番茄钟 ${spec}：到点停发新任务，正在跑的那单会在「两局之间」歇到休息段结束`);
};
$("btn-pomo-set").onclick = () => {
  const spec = pomoSpecFromInputs();
  if (!spec) return;
  runGuarded("pomo", ["set", spec],
    `把番茄钟时长改成 ${spec}（相位从这一刻起算；已在跑的任务仍按各自领到的时刻表，改时长只影响之后领的）`);
};
$("btn-pause").onclick = () => {
  const paused = $("chip-state").classList.contains("warn");
  runGuarded(paused ? "resume" : "pause", [], paused ? "恢复任务发放" : "暂停任务发放");
};
$("btn-clearq").onclick = () => {
  if (!confirm("清空整个优先队列？（不可恢复）")) return;
  runGuarded("clear-queue", [], "清空优先队列（不可恢复）");
};
/* 队列勾选（进行中同款：change 委托 + 表头全选 + 弹窗头批量删除按钮）。
   组是展示层的合并，勾选按组进出集合（整组 task_id 一起加/减）。 */
$("t-queue-full").querySelector("tbody").addEventListener("change", (e) => {
  const cb = e.target;
  if (!cb.classList || !cb.classList.contains("qdel-chk")) return;
  const g = qdelGroups[+cb.dataset.g];
  if (!g) return;
  for (const id of groupIds(g)) {
    if (cb.checked) qdelSel.add(id); else qdelSel.delete(id);
  }
  lastData && render(lastData);
});
$("queue-all").addEventListener("change", () => {
  const on = $("queue-all").checked;
  for (const b of document.querySelectorAll("#t-queue-full .qdel-chk")) {
    const g = qdelGroups[+b.dataset.g];
    if (!g) continue;
    for (const id of groupIds(g)) {
      if (on) qdelSel.add(id); else qdelSel.delete(id);
    }
  }
  lastData && render(lastData);
});
$("btn-qdel").onclick = () => {
  const ids = [...qdelSel];
  if (!ids.length) return;
  if (!confirm(`从队列删除选中的 ${ids.length} 个任务？（不可恢复，种子不会自动补）`)) return;
  runGuarded("rm", ids, `删除选中的 ${ids.length} 个队列任务`);
};
$("btn-invalidate").onclick = () => {
  const key = $("inv-key").value.trim();
  if (!key) return toast("先填要作废的任务ID / ip:地址 / name:名字", "bad");
  runGuarded("invalidate", [key], `作废 ${key} —— 结果保留但统计与导出会排除`);
};

/* ---------- 口令对话框（原生 <dialog>，口令错可原地重试） ---------- */

function trySubmit() {
  if (!pendingOp) return;
  const pw = $("dlg-pw").value;
  if (!pw) { $("dlg-err").textContent = "✗ 口令不能为空"; $("dlg-err").hidden = false; return; }
  if ($("dlg-remember").checked) rememberedPw = pw;   // 只进内存，刷新页面即消失
  const { op, args, desc } = pendingOp;
  pendingOp = null;
  runOp(op, args, pw, desc);
}
$("dlg-form").addEventListener("submit", (e) => { e.preventDefault(); trySubmit(); });
$("dlg-cancel").onclick = () => $("dlg").close();
$("dlg").addEventListener("close", () => { pendingOp = null; $("dlg-err").hidden = true; });

refresh(true);   // 首屏加载不算「刷新」动作，不弹成功提示
setAuto();
