/* 客户端搜索：对 title + keywords + group 名做大小写不敏感的子串匹配。
 * 中文靠子串命中（无需分词）；多个空格分词时按 AND 过滤。
 * 返回命中的 article id 数组，按相关度排序。query 为空则返回全部 id。
 */
(function () {
  'use strict';

  function norm(s) { return String(s == null ? '' : s).toLowerCase(); }

  function haystack(a, groupName) {
    return norm(a.title) + ' ' + (a.keywords || []).map(norm).join(' ') + ' ' + groupName;
  }

  window.LEARN_SEARCH = function (articles, groups, query) {
    var q = norm(query).trim();
    if (!q) return articles.map(function (a) { return a.id; });

    var gname = {};
    (groups || []).forEach(function (g) { gname[g.id] = norm(g.name); });

    var terms = q.split(/\s+/).filter(Boolean);
    var scored = [];

    articles.forEach(function (a) {
      var hay = haystack(a, gname[a.group] || '');
      // AND：每个分词都要命中
      for (var i = 0; i < terms.length; i++) {
        if (hay.indexOf(terms[i]) < 0) return;
      }
      var title = norm(a.title);
      var kws = (a.keywords || []).map(norm);
      var score = 0;
      // 相关度：标题精确 > 标题前缀 > 标题子串 > 关键词精确 > 关键词子串 > 组名
      if (title === q) score += 100;
      else if (title.indexOf(q) === 0) score += 60;
      else if (title.indexOf(q) >= 0) score += 40;
      for (var j = 0; j < kws.length; j++) {
        if (kws[j] === q) { score += 30; break; }
        if (kws[j].indexOf(q) >= 0) score += 20;
      }
      if ((gname[a.group] || '').indexOf(q) >= 0) score += 10;
      scored.push({ id: a.id, score: score });
    });

    scored.sort(function (x, y) { return y.score - x.score; });
    return scored.map(function (s) { return s.id; });
  };
})();
