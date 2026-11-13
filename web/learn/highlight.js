/* 零依赖的 C++ 语法高亮：单个合并正则，一遍扫描分词，避免嵌套替换出错。
 * 只处理教学代码常见的词法，不追求 100% 语义正确——够读就行。
 * 用法：window.highlightCpp(srcPlainText) -> 已转义 + 带 <span class> 的 HTML。
 */
(function () {
  'use strict';

  var KEYWORDS = ('alignas alignof and and_eq asm auto bitand bitor break case catch class compl concept ' +
    'const consteval constexpr constinit const_cast continue co_await co_return co_yield decltype default ' +
    'delete do dynamic_cast else enum explicit export extern for friend goto if inline mutable namespace new ' +
    'noexcept not not_eq or or_eq private protected public register reinterpret_cast requires return sizeof ' +
    'static static_assert static_cast struct switch template this thread_local throw try typedef typeid ' +
    'typename union using virtual volatile while xor xor_eq true false nullptr override final').split(/\s+/);

  var TYPES = ('bool char char8_t char16_t char32_t wchar_t double float int long short signed unsigned void ' +
    'size_t ptrdiff_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t string string_view ' +
    'vector list forward_list deque array map set multimap multiset unordered_map unordered_set queue stack ' +
    'priority_queue pair tuple unique_ptr shared_ptr weak_ptr optional variant initializer_list').split(/\s+/);

  var KW = {}; KEYWORDS.forEach(function (k) { KW[k] = 1; });
  var TY = {}; TYPES.forEach(function (t) { TY[t] = 1; });

  function esc(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 合并正则：注释 | 预处理 | 字符串/字符 | 数字 | 标识符 | 标点。顺序即优先级。
  var RE = new RegExp(
    '(\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/)' +                         // 1 注释
    '|(#\\s*[A-Za-z_]+[^\\n]*)' +                                       // 2 预处理指令
    '|("(?:\\\\.|[^"\\\\\\n])*"|\'(?:\\\\.|[^\'\\\\\\n])*\')' +         // 3 字符串 / 字符字面量
    '|(\\b(?:0[xXbB][0-9a-fA-F\']+|\\d[\\d\']*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)[uUlLfF]*\\b)' + // 4 数字
    '|([A-Za-z_]\\w*)' +                                                // 5 标识符
    '|([^\\sA-Za-z0-9_]+)',                                             // 6 运算符 / 标点
    'g');

  // 标识符后紧跟 '('（跳过空白）视为函数调用名。
  function isCall(src, from) {
    for (var i = from; i < src.length; i++) {
      var c = src.charAt(i);
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
      return c === '(';
    }
    return false;
  }

  function highlight(src) {
    src = String(src == null ? '' : src);
    var out = '', last = 0, m;
    RE.lastIndex = 0;
    while ((m = RE.exec(src)) !== null) {
      if (m.index > last) out += esc(src.slice(last, m.index));
      var text = m[0];
      if (m[1] != null)       out += '<span class="cm">' + esc(text) + '</span>';
      else if (m[2] != null)  out += '<span class="pp">' + esc(text) + '</span>';
      else if (m[3] != null)  out += '<span class="st">' + esc(text) + '</span>';
      else if (m[4] != null)  out += '<span class="nu">' + esc(text) + '</span>';
      else if (m[5] != null) {
        if (KW[text])              out += '<span class="kw">' + esc(text) + '</span>';
        else if (TY[text])         out += '<span class="ty">' + esc(text) + '</span>';
        else if (isCall(src, RE.lastIndex)) out += '<span class="fn">' + esc(text) + '</span>';
        else                       out += esc(text);
      }
      else if (m[6] != null)  out += '<span class="op">' + esc(text) + '</span>';
      last = RE.lastIndex;
    }
    if (last < src.length) out += esc(src.slice(last));
    return out;
  }

  window.highlightCpp = highlight;
})();
