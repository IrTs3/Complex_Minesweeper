/* 学习站主逻辑：构建左侧目录树、顶部搜索、hash 路由、懒加载 pages/<id>.js 并按 DSL 渲染正文。
 * 零依赖，file:// 与 http:// 均可运行（页面用 <script> 标签懒加载，不用 fetch，绕开 file:// 的 CORS 限制）。
 *
 * 页面文件调用：LEARN.register("<id>", [ <section>, ... ])
 * section 支持的字段（每段一个对象，按数组顺序渲染）：
 *   { lead:"内联HTML" }                                  导语
 *   { h:"小节标题" }                                      <h2>
 *   { p:"内联HTML" }                                      段落
 *   { code:"纯文本源码", lang:"cpp"|"bash", title:"说明" } 代码块（自动转义+高亮；lang 省略即 cpp）
 *   { table:{ head:[..], rows:[[..],..] } }              表格（单元格是内联HTML）
 *   { svg:"<svg…>原始串", cap:"图注" }                    图解（原样插入）
 *   { ul:[..] } / { ol:[..] }                            列表（项是内联HTML）
 *   { callout:"内联HTML", kind:"tip"|"warn"|"note" }      提示框
 * 只有 code 字段按纯文本处理（转义后高亮）；其余字段视为可信的作者手写内联 HTML。
 */
(function () {
  'use strict';

  var M = window.LEARN_MANIFEST;
  var treeEl = document.getElementById('tree');
  var contentEl = document.getElementById('content');
  var articleEl = document.getElementById('article');
  var searchEl = document.getElementById('search');
  var countEl = document.getElementById('search-count');
  var sidebarEl = document.getElementById('sidebar');
  var scrimEl = document.getElementById('scrim');
  var navToggle = document.getElementById('nav-toggle');

  // 页面注册表：pages/<id>.js 加载后调用 LEARN.register 写入。
  window.LEARN = {
    _pages: {},
    register: function (id, sections) { this._pages[id] = sections; },
    get: function (id) { return this._pages[id]; },
    has: function (id) { return Object.prototype.hasOwnProperty.call(this._pages, id); }
  };

  var byId = {};
  M.articles.forEach(function (a) { byId[a.id] = a; });
  var groupName = {};
  M.groups.forEach(function (g) { groupName[g.id] = g.name; });

  var order = M.articles.slice().sort(function (x, y) {
    var gx = M.groups.findIndex(function (g) { return g.id === x.group; });
    var gy = M.groups.findIndex(function (g) { return g.id === y.group; });
    return (gx - gy) || (x.order - y.order);
  }).map(function (a) { return a.id; });

  var injected = {};      // id -> true（脚本已注入，避免重复）
  var currentId = null;

  // HTML 转义。★ 必须转引号（2026-10-21 安全审计 P9）：本文件有 5 处在**属性上下文**
  // 用它（class= / data-go=），不转 " 的话内容里出现一个双引号就能闭合属性。
  // 纯文本上下文里 &quot; 仍渲染成 "，视觉零变化。& 必须最先替换。
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 作者手写的可信内联 HTML，直接透传。
  function inline(s) { return String(s == null ? '' : s); }

  // ---------- 目录树 ----------
  function buildTree() {
    treeEl.innerHTML = '';
    M.groups.forEach(function (g) {
      var items = M.articles.filter(function (a) { return a.group === g.id; })
        .sort(function (x, y) { return x.order - y.order; });
      if (!items.length) return;

      var sec = document.createElement('div');
      sec.className = 'tree-group';
      sec.dataset.group = g.id;

      var head = document.createElement('button');
      head.type = 'button';
      head.className = 'tree-head';
      head.setAttribute('aria-expanded', 'true');
      head.innerHTML = '<span class="chev" aria-hidden="true">▾</span><span>' + esc(g.name) + '</span>';
      head.addEventListener('click', function () {
        var open = head.getAttribute('aria-expanded') === 'true';
        head.setAttribute('aria-expanded', open ? 'false' : 'true');
        sec.classList.toggle('collapsed', open);
      });

      var ul = document.createElement('ul');
      ul.className = 'tree-list';
      items.forEach(function (a) {
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tree-item';
        btn.dataset.id = a.id;
        btn.innerHTML = '<span class="tree-item-title">' + esc(a.title) + '</span>' +
          (a.diagram ? '<span class="badge" title="含 SVG 图解">图</span>' : '');
        btn.addEventListener('click', function () {
          navigate(a.id);
          closeDrawer();
        });
        li.appendChild(btn);
        ul.appendChild(li);
      });

      sec.appendChild(head);
      sec.appendChild(ul);
      treeEl.appendChild(sec);
    });
  }

  function markActive(id) {
    Array.prototype.forEach.call(treeEl.querySelectorAll('.tree-item'), function (b) {
      b.classList.toggle('active', b.dataset.id === id);
    });
  }

  // ---------- 搜索 ----------
  function applySearch(q) {
    q = (q || '').trim();
    var ids = window.LEARN_SEARCH(M.articles, M.groups, q);
    var set = {};
    ids.forEach(function (id) { set[id] = 1; });
    var visible = 0;

    Array.prototype.forEach.call(treeEl.querySelectorAll('.tree-group'), function (sec) {
      var any = false;
      Array.prototype.forEach.call(sec.querySelectorAll('.tree-item'), function (btn) {
        var show = !q || !!set[btn.dataset.id];
        btn.parentElement.style.display = show ? '' : 'none';
        if (show) { any = true; visible++; }
      });
      sec.style.display = any ? '' : 'none';
      if (q && any) {
        sec.classList.remove('collapsed');
        var h = sec.querySelector('.tree-head');
        if (h) h.setAttribute('aria-expanded', 'true');
      }
    });

    var empty = treeEl.querySelector('.tree-empty');
    if (q && visible === 0) {
      if (!empty) {
        empty = document.createElement('p');
        empty.className = 'tree-empty';
        treeEl.appendChild(empty);
      }
      empty.textContent = '没有匹配「' + q + '」的文章';
    } else if (empty) {
      empty.remove();
    }
    countEl.textContent = q ? (visible + ' 个结果') : '';
  }

  // ---------- 正文渲染 ----------
  function renderSection(s) {
    if (!s) return '';
    if (s.h != null) return '<h2 class="sec-h">' + inline(s.h) + '</h2>';
    if (s.lead != null) return '<p class="lead">' + inline(s.lead) + '</p>';
    if (s.p != null) return '<p>' + inline(s.p) + '</p>';
    if (s.callout != null) {
      var kind = s.kind || 'note';
      return '<div class="callout ' + esc(kind) + '">' + inline(s.callout) + '</div>';
    }
    if (s.code != null) {
      var lang = s.lang || 'cpp';
      var body = (lang === 'cpp' && window.highlightCpp) ? window.highlightCpp(s.code) : esc(s.code);
      return '<figure class="code">' +
        '<div class="code-bar">' +
          '<span class="code-lang">' + esc(lang) + '</span>' +
          (s.title ? '<span class="code-title">' + inline(s.title) + '</span>' : '') +
          '<button class="copy-btn" type="button">复制</button>' +
        '</div>' +
        '<pre><code class="lang-' + esc(lang) + '">' + body + '</code></pre>' +
        '</figure>';
    }
    if (s.table) {
      var head = (s.table.head || []).map(function (c) { return '<th>' + inline(c) + '</th>'; }).join('');
      var rows = (s.table.rows || []).map(function (r) {
        return '<tr>' + r.map(function (c) { return '<td>' + inline(c) + '</td>'; }).join('') + '</tr>';
      }).join('');
      return '<div class="table-wrap"><table>' +
        (head ? '<thead><tr>' + head + '</tr></thead>' : '') +
        '<tbody>' + rows + '</tbody></table></div>';
    }
    if (s.svg != null) {
      return '<figure class="diagram">' + s.svg +
        (s.cap ? '<figcaption>' + inline(s.cap) + '</figcaption>' : '') + '</figure>';
    }
    if (s.ul) return '<ul>' + s.ul.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ul>';
    if (s.ol) return '<ol>' + s.ol.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</ol>';
    return '';
  }

  function renderPager(id) {
    var i = order.indexOf(id);
    var prev = i > 0 ? byId[order[i - 1]] : null;
    var next = i >= 0 && i < order.length - 1 ? byId[order[i + 1]] : null;
    return '<nav class="pager">' +
      '<button type="button" class="prev"' + (prev ? ' data-go="' + esc(prev.id) + '"' : ' disabled') + '>' +
        '<span class="dir">← 上一篇</span><span class="ttl">' + (prev ? esc(prev.title) : '没有了') + '</span></button>' +
      '<button type="button" class="next"' + (next ? ' data-go="' + esc(next.id) + '"' : ' disabled') + '>' +
        '<span class="dir">下一篇 →</span><span class="ttl">' + (next ? esc(next.title) : '没有了') + '</span></button>' +
      '</nav>';
  }

  function renderArticle(a) {
    var sections = window.LEARN.get(a.id) || [];
    var html = '<div class="doc-crumb">' + esc(groupName[a.group] || '') + '</div>' +
      '<h1 class="doc-title">' + esc(a.title) + '</h1>';
    sections.forEach(function (s) { html += renderSection(s); });
    html += renderPager(a.id);
    articleEl.innerHTML = html;
    markActive(a.id);
    contentEl.scrollTop = 0;
    if (window.scrollTo) window.scrollTo(0, 0);
  }

  function renderHome() {
    var cards = M.groups.map(function (g) {
      var items = M.articles.filter(function (a) { return a.group === g.id; })
        .sort(function (x, y) { return x.order - y.order; });
      if (!items.length) return '';
      var lis = items.map(function (a) {
        return '<li><button type="button" data-go="' + esc(a.id) + '">' + esc(a.title) + '</button></li>';
      }).join('');
      return '<section class="home-card"><h3>' + esc(g.name) + '</h3><ul>' + lis + '</ul></section>';
    }).join('');

    articleEl.innerHTML =
      '<h1 class="home-title">' + esc(M.site.title) + '</h1>' +
      '<p class="lead">' + esc(M.site.tagline) + '</p>' +
      '<p class="home-intro">从左侧目录选择一个主题开始，或在顶部搜索框输入关键词。' +
      '每篇文章都可以直接复制其中的 C++ 代码去编译运行。</p>' +
      '<div class="home-groups">' + cards + '</div>';
    markActive(null);
  }

  // ---------- 懒加载页面脚本 ----------
  function loadPage(a, onReady) {
    if (window.LEARN.has(a.id)) { onReady(); return; }
    if (injected[a.id]) return; // 已在加载中
    injected[a.id] = true;
    articleEl.innerHTML = '<p class="loading">正在加载「' + esc(a.title) + '」…</p>';
    var sc = document.createElement('script');
    sc.src = a.file;
    sc.onload = function () {
      if (window.LEARN.has(a.id)) onReady();
      else articleEl.innerHTML = '<div class="error-box">页面「' + esc(a.title) + '」加载后未注册内容。</div>';
    };
    sc.onerror = function () {
      injected[a.id] = false;
      articleEl.innerHTML = '<div class="error-box">无法加载 <code>' + esc(a.file) + '</code>。' +
        '若用 file:// 打开请确认该文件存在。</div>';
    };
    document.body.appendChild(sc);
  }

  // ---------- 路由 ----------
  function hashId() {
    var raw = (location.hash || '').replace(/^#\/?/, '');
    var h = raw;
    // ★ 畸形百分号转义（#/% 、#/%E4）会让 decodeURIComponent 抛 URIError。
    //   启动时 route() 一抛，正文就永久空白，只能手改地址栏 —— 任意链接都能触发。
    try { h = decodeURIComponent(raw); } catch (e) { h = raw; }
    h = h.trim();
    return h || null;
  }
  function navigate(id) {
    if (location.hash === '#/' + id) route();
    else location.hash = '#/' + id;
  }
  function route() {
    var id = hashId();
    // ★ 用 hasOwnProperty（2026-10-21 P9）：byId 是普通对象，`#/constructor`
    //   会命中原型链上的 Object.prototype.constructor（truthy），于是走进文章分支、
    //   加载一个 undefined 的 file。
    if (!id || !Object.prototype.hasOwnProperty.call(byId, id)) { currentId = null; renderHome(); return; }
    currentId = id;
    var a = byId[id];
    loadPage(a, function () {
      if (currentId === id) renderArticle(a);
    });
  }

  // ---------- 抽屉（窄屏） ----------
  function openDrawer() {
    sidebarEl.classList.add('open');
    scrimEl.hidden = false;
    // 守卫：若同帧内已被 closeDrawer 关掉，则不再补加 show（否则 scrim 会卡住遮挡内容）
    requestAnimationFrame(function () {
      if (sidebarEl.classList.contains('open')) scrimEl.classList.add('show');
    });
    navToggle.setAttribute('aria-expanded', 'true');
  }
  function closeDrawer() {
    if (!sidebarEl.classList.contains('open')) return;
    sidebarEl.classList.remove('open');
    scrimEl.classList.remove('show');
    navToggle.setAttribute('aria-expanded', 'false');
    setTimeout(function () { if (!scrimEl.classList.contains('show')) scrimEl.hidden = true; }, 200);
  }

  // ---------- 事件委托：复制 / 翻页 / 首页卡片 ----------
  document.addEventListener('click', function (ev) {
    var go = ev.target.closest && ev.target.closest('[data-go]');
    if (go) { navigate(go.getAttribute('data-go')); closeDrawer(); return; }

    var copy = ev.target.closest && ev.target.closest('.copy-btn');
    if (copy) {
      var pre = copy.closest('figure.code').querySelector('pre code');
      var text = pre ? pre.textContent : '';
      var done = function () {
        copy.textContent = '已复制';
        copy.classList.add('done');
        setTimeout(function () { copy.textContent = '复制'; copy.classList.remove('done'); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else fallback();
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { copy.textContent = '复制失败'; }
        document.body.removeChild(ta);
      }
    }
  });

  searchEl.addEventListener('input', function () { applySearch(searchEl.value); });
  searchEl.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') {
      var ids = window.LEARN_SEARCH(M.articles, M.groups, searchEl.value);
      if (ids.length) { navigate(ids[0]); closeDrawer(); }
    } else if (ev.key === 'Escape') {
      searchEl.value = ''; applySearch(''); searchEl.blur();
    }
  });
  navToggle.addEventListener('click', function () {
    sidebarEl.classList.contains('open') ? closeDrawer() : openDrawer();
  });
  scrimEl.addEventListener('click', closeDrawer);
  window.addEventListener('hashchange', route);

  // 快捷键：/ 聚焦搜索
  document.addEventListener('keydown', function (ev) {
    if (ev.key === '/' && document.activeElement !== searchEl &&
        !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      ev.preventDefault(); searchEl.focus();
    }
  });

  // ---------- 启动 ----------
  buildTree();
  applySearch('');
  route();
})();
