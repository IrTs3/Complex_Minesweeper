(function () {
  'use strict';
  LEARN.register('stl-iterators', [
    { lead: '迭代器是 STL 的「通用胶水」：它把<strong>容器</strong>和<strong>算法</strong>解耦。算法只认迭代器、不认具体容器，于是 <code>std::sort</code> 既能排 <code>vector</code> 也能排 <code>array</code>。这篇讲清迭代器的分类、<code>[begin, end)</code> 半开区间约定、移动迭代器的工具，以及最容易踩的失效规则。' },

    { h: '一、什么是迭代器' },
    { p: '迭代器是一个<strong>行为像指针</strong>的对象：可以用 <code>*</code> 解引用取元素、用 <code>++</code> 前进、用 <code>==</code>/<code>!=</code> 比较。每个容器都提供 <code>begin()</code>（指向首元素）和 <code>end()</code>（指向<em>尾后</em>位置，即最后一个元素的下一个）。' },
    { callout: '区间约定是<strong>半开区间 <code>[begin, end)</code></strong>：包含 <code>begin</code>，不包含 <code>end</code>。空区间就是 <code>begin == end</code>。这样「循环直到 <code>it == end</code>」的写法天然处理空容器，也不用对最后一个元素做特判。', kind: 'note' },

    { h: '二、迭代器的五个类别' },
    { p: '按支持的操作从弱到强分为五类，算法会声明它至少需要哪一类：' },
    { table: {
      head: ['类别', '能力', '典型来源', '代表算法'],
      rows: [
        ['输入迭代器 (Input)', '单向、只读、只能遍历一次', '<code>istream_iterator</code>', '<code>find</code>, <code>count</code>'],
        ['输出迭代器 (Output)', '单向、只写', '<code>ostream_iterator</code>, <code>back_inserter</code>', '<code>copy</code>'],
        ['前向迭代器 (Forward)', '单向、可多次读写', '<code>forward_list</code>', '<code>adjacent_find</code>'],
        ['双向迭代器 (Bidirectional)', '可 <code>++</code> 也可 <code>--</code>', '<code>list</code>, <code>map</code>, <code>set</code>', '<code>reverse</code>'],
        ['随机访问迭代器 (RandomAccess)', '可 <code>+n</code>、<code>it2-it1</code>、<code>&lt;</code> 比较，O(1) 跳转', '<code>vector</code>, <code>deque</code>, <code>array</code>', '<code>sort</code>, <code>nth_element</code>']
      ]
    } },
    { p: 'C++17/20 起这些类别逐渐被<em>迭代器概念（iterator concepts）</em>取代，但分级思想不变。关键点：<code>std::sort</code> 要求<strong>随机访问迭代器</strong>，所以它<strong>不能</strong>用于 <code>list</code>（<code>list</code> 得用成员函数 <code>l.sort()</code>）。' },

    { h: '三、移动迭代器的工具' },
    { p: '不是所有迭代器都能 <code>it + n</code>。为了写出对五类都通用的代码，用标准库提供的辅助函数：' },
    { ul: [
      '<code>std::advance(it, n)</code>：把 <code>it</code> 前进（或后退）<code>n</code> 步；对随机访问是 O(1)，对双向/前向是 O(n)。',
      '<code>std::distance(a, b)</code>：返回 <code>a</code> 到 <code>b</code> 的元素个数，复杂度同上。',
      '<code>std::next(it, n=1)</code> / <code>std::prev(it, n=1)</code>：返回移动后的<em>新迭代器</em>（不改 <code>it</code> 本身），比 <code>advance</code> 更适合写在表达式里。'
    ] },

    { h: '四、C++ 实现' },
    { p: '下面把常用算法与迭代器工具串起来：' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>
#include <numeric>

int main() {
    std::vector<int> v{5, 2, 9, 1, 7};

    // 半开区间 [begin, end)：遍历
    for (auto it = v.begin(); it != v.end(); ++it) {
        std::cout << *it << ' ';
    }
    std::cout << '\n';

    // sort 需要随机访问迭代器；vector 满足
    std::sort(v.begin(), v.end());                 // 1 2 5 7 9

    // find 返回迭代器；找不到时等于 end()
    auto it = std::find(v.begin(), v.end(), 5);
    if (it != v.end()) {
        std::cout << "found at index "
                  << std::distance(v.begin(), it) << '\n';   // 2
    }

    // count 统计个数；lower_bound 找第一个 >= x 的位置（要求有序）
    std::cout << std::count(v.begin(), v.end(), 5) << '\n';  // 1
    auto lb = std::lower_bound(v.begin(), v.end(), 5);
    std::cout << *lb << '\n';                                // 5

    // for_each 对每个元素调用可调用对象
    std::for_each(v.begin(), v.end(), [](int x){ std::cout << x << '|'; });
    std::cout << '\n';

    // advance / next 在非随机访问场景也能用（这里 vector 是 O(1)）
    auto second = std::next(v.begin(), 1);
    std::cout << *second << '\n';                            // 2
    return 0;
}`, title: 'sort / find / count / lower_bound / for_each 与迭代器工具' },

    { h: '五、图解：半开区间 [begin, end)' },
    { svg: '<svg viewBox="0 0 620 170" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="begin 指向首元素，end 指向尾后位置，区间为半开">' +
      '<defs><marker id="ai" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // 元素格子
      '<rect x="60" y="60" width="60" height="46" fill="#eaf1fe" stroke="#2f6feb"/><text x="90" y="89" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#1f2933">10</text>' +
      '<rect x="120" y="60" width="60" height="46" fill="#eaf1fe" stroke="#2f6feb"/><text x="150" y="89" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#1f2933">20</text>' +
      '<rect x="180" y="60" width="60" height="46" fill="#eaf1fe" stroke="#2f6feb"/><text x="210" y="89" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#1f2933">30</text>' +
      '<rect x="240" y="60" width="60" height="46" fill="#eaf1fe" stroke="#2f6feb"/><text x="270" y="89" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#1f2933">40</text>' +
      // end 位置（尾后，虚线空位）
      '<rect x="300" y="60" width="60" height="46" fill="none" stroke="#8a94a6" stroke-dasharray="5 4"/><text x="330" y="89" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">尾后</text>' +
      // begin / end 指针
      '<text x="90" y="40" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#22863a">begin()</text>' +
      '<line x1="90" y1="46" x2="90" y2="58" stroke="#22863a" stroke-width="2" marker-end="url(#ai)"/>' +
      '<text x="330" y="40" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#a626a4">end()</text>' +
      '<line x1="330" y1="46" x2="330" y2="58" stroke="#a626a4" stroke-width="2" marker-end="url(#ai)"/>' +
      // 覆盖括号
      '<line x1="60" y1="126" x2="300" y2="126" stroke="#2f6feb" stroke-width="2"/>' +
      '<line x1="60" y1="120" x2="60" y2="132" stroke="#2f6feb" stroke-width="2"/>' +
      '<line x1="300" y1="120" x2="300" y2="132" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="180" y="150" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">[begin, end) 覆盖 4 个元素，end 本身不可解引用</text>' +
      '</svg>', cap: 'begin() 指向首元素，end() 指向最后一个元素之后的位置。解引用 end() 是未定义行为。' },

    { h: '六、迭代器失效规则' },
    { p: '迭代器失效指修改容器后，原来的迭代器不再指向有效元素。核心规则：' },
    { ul: [
      '<code>vector</code>：扩容（<code>push_back</code> 超过 <code>capacity</code>）→ <strong>全部</strong>迭代器失效；中间 <code>insert</code>/<code>erase</code> → 该位置<em>及之后</em>的迭代器失效。',
      '<code>deque</code>：两端插入一般不失效迭代器（但可能失效指针/引用）；中间插入/删除全部失效。',
      '<code>list</code> / <code>forward_list</code> / 关联容器 / 无序容器：只有<strong>被删除元素</strong>的迭代器失效；无序容器发生 <code>rehash</code> 时迭代器失效但元素引用仍有效。',
      '安全的删除写法：让 <code>erase</code> 返回的迭代器接着用，例如 <code>for (auto it = c.begin(); it != c.end(); ) { if (pred(*it)) it = c.erase(it); else ++it; }</code>。'
    ] },

    { h: '七、常见坑' },
    { callout: '<strong>别解引用 <code>end()</code>。</strong>它指向尾后位置，那里没有元素，<code>*v.end()</code> 是未定义行为。判断是否找到要用 <code>it != v.end()</code>。', kind: 'warn' },
    { ul: [
      '对 <code>list</code>/<code>map</code> 用 <code>std::sort</code> 编译不过：它们只有双向迭代器，而 <code>sort</code> 要随机访问。改用成员 <code>list::sort()</code>，或先把元素拷进 <code>vector</code>。',
      '<code>it + 5</code> 只对随机访问迭代器合法；对 <code>list</code>/<code>map</code> 的迭代器要用 <code>std::advance(it, 5)</code> 或 <code>std::next(it, 5)</code>。',
      '在遍历中修改容器却不更新迭代器（<code>v.erase(it)</code> 后仍 <code>++it</code>），会跳过元素或崩溃。',
      '<code>end()</code> 迭代器随容器增长会变：不要缓存旧的 <code>end()</code> 又在中途 <code>push_back</code>。'
    ] },

    { h: '八、练习' },
    { ol: [
      '用 <code>std::find</code> 在 <code>vector&lt;int&gt;</code> 里找一个值，用 <code>std::distance</code> 把返回的迭代器换算成下标；再对找不到的情况做处理。',
      '在一个 <code>vector&lt;int&gt;</code> 上，用「<code>it = v.erase(it)</code>」的显式迭代器循环删除所有能被 3 整除的元素，验证不会崩溃也不漏删。',
      '写一个函数模板，接受任意容器的一对迭代器 <code>[first, last)</code>，用 <code>std::distance</code> 返回元素个数，并分别传入 <code>vector</code> 和 <code>list</code> 测试。',
      '解释为什么 <code>std::sort(v.begin(), v.end())</code> 能用于 <code>vector</code> 却不能用于 <code>list</code>，并写出对 <code>list</code> 排序的正确方式。'
    ] }
  ]);
})();
