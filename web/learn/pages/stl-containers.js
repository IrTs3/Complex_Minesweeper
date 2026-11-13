(function () {
  'use strict';
  LEARN.register('stl-containers', [
    { lead: 'STL 容器很多，但选型逻辑其实很清晰：<strong>要不要有序</strong>、<strong>按什么查</strong>、<strong>在哪插入删除</strong>。这篇把最常用的 <code>vector</code> / <code>list</code> / <code>map</code> / <code>unordered_map</code> 放在一起，讲清它们底层的内存布局，以及布局如何决定了复杂度和适用场景。' },

    { h: '一、三大类容器' },
    { ul: [
      '<strong>序列容器（Sequence）</strong>：元素按<em>插入顺序</em>线性排列。包括 <code>vector</code>（动态数组）、<code>deque</code>（分段连续的双端队列）、<code>list</code>（双向链表）、<code>forward_list</code>（单向链表）、<code>array</code>（定长数组）。',
      '<strong>关联容器（Associative）</strong>：底层是<strong>平衡红黑树</strong>，元素<strong>自动按 key 有序</strong>。包括 <code>map</code>（键值对）、<code>set</code>（唯一键集合）、<code>multimap</code> / <code>multiset</code>（允许重复键）。有序让它能高效做范围查询和 <code>lower_bound</code>。',
      '<strong>无序容器（Unordered）</strong>：底层是<strong>哈希表</strong>，元素<strong>不保证顺序</strong>，靠哈希把 key 映射到桶（bucket）。包括 <code>unordered_map</code> / <code>unordered_set</code> 及其 <code>multi</code> 版本。平均 O(1) 查找，但需要好的哈希函数。'
    ] },

    { h: '二、复杂度对照表' },
    { p: '下表是各容器关键操作的<strong>时间复杂度</strong>（无序容器指平均情况）：' },
    { table: {
      head: ['容器', '底层结构', '随机访问', '头部插入', '尾部插入', '查找 key', '是否有序'],
      rows: [
        ['<code>vector</code>', '动态数组', 'O(1)', 'O(n)', '均摊 O(1)', 'O(n) / 有序后 O(log n)', '否（按插入序）'],
        ['<code>deque</code>', '分段数组', 'O(1)', 'O(1)', 'O(1)', 'O(n)', '否'],
        ['<code>list</code>', '双向链表', 'O(n)', 'O(1)', 'O(1)', 'O(n)', '否'],
        ['<code>map</code>/<code>set</code>', '红黑树', 'O(n)', 'O(log n)', 'O(log n)', 'O(log n)', '<strong>是（按 key）</strong>'],
        ['<code>unordered_map</code>', '哈希表', '不支持', '均摊 O(1)', '均摊 O(1)', '均摊 O(1) / 最坏 O(n)', '否']
      ]
    } },
    { callout: '<strong>默认选 <code>vector</code>。</strong>它的元素在内存里连续存放，CPU 缓存命中率高，即便「中间插入」理论上 O(n)，实际也常常快过 <code>list</code> 的 O(1) 指针操作（后者每次跳转都可能 cache miss）。只有确知瓶颈是频繁的头/中插删时，才换 <code>list</code> 或 <code>deque</code>。', kind: 'tip' },

    { h: '三、内存布局：为什么复杂度不同' },
    { ul: [
      '<code>vector</code>：一整块<strong>连续内存</strong>。用 <code>下标</code> 定位 = 首地址 + 偏移，O(1)。尾部插入若容量不足要重新分配并搬迁全部元素，故是<em>均摊</em> O(1)。',
      '<code>list</code>：每个节点<strong>散落在堆上</strong>，靠 <code>prev/next</code> 指针串联。插入删除只改几个指针 O(1)，但走到第 k 个节点必须从头顺着指针跳 O(n)，且跳转会缓存不友好。',
      '<code>unordered_map</code>：一个<strong>桶数组</strong>，<code>hash(key) % 桶数</code> 定位到桶，桶内用链表挂冲突元素。装填因子过高时会 rehash（重新分配所有桶）。'
    ] },

    { h: '四、C++ 实现' },
    { p: '下面演示四类容器的典型用法：' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <list>
#include <map>
#include <unordered_map>
#include <string>

int main() {
    // vector：连续内存，尾部插入均摊 O(1)，随机访问 O(1)
    std::vector<int> v{1, 2, 3};
    v.push_back(4);
    std::cout << v[0] << ' ' << v.size() << '\n';   // 1 4

    // list：双向链表，任意位置插入/删除 O(1)（已有迭代器时）
    std::list<int> l{1, 2, 4};
    auto it = l.begin();
    std::advance(it, 2);        // 走到元素 4；list 迭代器非随机访问，不能用 it+2
    l.insert(it, 3);            // 在 4 前插入 3 -> 1 2 3 4
    for (int x : l) std::cout << x << ' ';
    std::cout << '\n';

    // map：红黑树，按 key 自动有序，查找 O(log n)
    std::map<std::string, int> ages;
    ages["bob"] = 30;
    ages["alice"] = 25;         // 遍历会按 key 字典序输出
    for (const auto& kv : ages) std::cout << kv.first << '=' << kv.second << ' ';
    std::cout << '\n';

    // unordered_map：哈希表，无序，查找均摊 O(1)
    std::unordered_map<std::string, int> cnt;
    cnt["apple"] = 2;
    if (cnt.count("apple")) std::cout << cnt["apple"] << '\n';  // 2

    // 用 emplace 就地构造，避免临时对象拷贝
    ages.emplace("carol", 28);
    return 0;
}`, title: 'vector / list / map / unordered_map 用法对比' },

    { h: '五、图解：三种内存布局' },
    { svg: '<svg viewBox="0 0 700 320" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="vector 连续内存、list 链式指针、unordered_map 哈希桶三种布局对比">' +
      '<defs><marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // ---- vector ----
      '<text x="20" y="30" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">vector：连续内存，下标 O(1)</text>' +
      '<g>' +
      '<rect x="20" y="44" width="60" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="50" y="69" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">10</text>' +
      '<rect x="80" y="44" width="60" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="110" y="69" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">20</text>' +
      '<rect x="140" y="44" width="60" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="170" y="69" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">30</text>' +
      '<rect x="200" y="44" width="60" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="230" y="69" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">40</text>' +
      '</g>' +
      '<text x="50" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[0]</text>' +
      '<text x="110" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[1]</text>' +
      '<text x="170" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[2]</text>' +
      '<text x="230" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[3]</text>' +
      // ---- list ----
      '<text x="20" y="150" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">list：节点散落堆上，指针串联，随机访问 O(n)</text>' +
      '<g>' +
      '<rect x="20" y="164" width="56" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="48" y="189" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">10</text>' +
      '<rect x="150" y="176" width="56" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="178" y="201" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">20</text>' +
      '<rect x="290" y="160" width="56" height="40" fill="#eaf1fe" stroke="#2f6feb"/><text x="318" y="185" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">30</text>' +
      '<line x1="76" y1="184" x2="148" y2="196" stroke="#8a94a6" stroke-width="2" marker-end="url(#a2)"/>' +
      '<line x1="206" y1="196" x2="288" y2="182" stroke="#8a94a6" stroke-width="2" marker-end="url(#a2)"/>' +
      '</g>' +
      '<text x="360" y="185" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">next 指针（地址不连续）</text>' +
      // ---- hash buckets ----
      '<text x="20" y="252" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">unordered_map：哈希桶 + 冲突链，查找均摊 O(1)</text>' +
      '<g>' +
      '<rect x="20" y="264" width="50" height="34" fill="#eaf1fe" stroke="#2f6feb"/><text x="45" y="286" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#1f2933">b0</text>' +
      '<rect x="90" y="264" width="50" height="34" fill="#eaf1fe" stroke="#2f6feb"/><text x="115" y="286" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#1f2933">b1</text>' +
      '<rect x="160" y="264" width="50" height="34" fill="#eaf1fe" stroke="#2f6feb"/><text x="185" y="286" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#1f2933">b2</text>' +
      // collision chain off b1
      '<circle cx="255" cy="281" r="16" fill="#e6f4ea" stroke="#22863a"/><text x="255" y="285" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#1f2933">k1</text>' +
      '<circle cx="305" cy="281" r="16" fill="#e6f4ea" stroke="#22863a"/><text x="305" y="285" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#1f2933">k2</text>' +
      '<line x1="140" y1="281" x2="238" y2="281" stroke="#8a94a6" stroke-width="2" marker-end="url(#a2)"/>' +
      '<line x1="271" y1="281" x2="288" y2="281" stroke="#8a94a6" stroke-width="2" marker-end="url(#a2)"/>' +
      '</g>' +
      '<text x="345" y="286" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">同一桶内的哈希冲突用链挂起</text>' +
      '</svg>', cap: '左：vector 连续存放，下标即偏移。中：list 节点地址不连续，靠指针跳转。下：哈希表按 hash 值定位桶，冲突元素挂在同一条链上。' },

    { h: '六、迭代器失效' },
    { p: '修改容器可能让<strong>已有迭代器失效</strong>（指向被销毁或搬迁的位置），继续用它是未定义行为：' },
    { ul: [
      '<code>vector</code>：<code>push_back</code> 触发扩容会搬迁全部元素，<strong>所有</strong>迭代器/指针失效；中间 <code>insert/erase</code> 会使<em>插入点之后</em>的迭代器失效。安全写法：<code>it = v.erase(it);</code>。',
      '<code>list</code> / <code>forward_list</code>：只有被删除元素自身的迭代器失效，其它节点地址不变。',
      '<code>map</code> / <code>set</code>：同链表，仅被删元素的迭代器失效。',
      '<code>unordered_*</code>：<code>rehash</code> 会使迭代器全部失效（但<em>指向元素的指针/引用</em>仍有效，因为节点本身没搬）。'
    ] },

    { h: '七、常见坑' },
    { callout: '<code>map</code> 的 <code>operator[]</code> 在 key 不存在时会<strong>插入一个默认值</strong>。只想查而不想改，请用 <code>find()</code> 或 <code>count()</code>/<code>contains()</code>（C++20）。', kind: 'warn' },
    { ul: [
      '在基于范围的 <code>for</code> 里对 <code>vector</code> 做 <code>push_back</code>/<code>erase</code>，几乎必然导致迭代器失效崩溃。',
      '<code>unordered_map</code> 用自定义类型做 key 时，必须提供 <code>std::hash</code> 特化和 <code>operator==</code>，否则编译不过。',
      '需要「按 key 有序遍历」或「范围查询（如所有 ≥x 的 key）」时，别用 <code>unordered_map</code>——它无序，应选 <code>map</code>。',
      '<code>vector&lt;bool&gt;</code> 是特化，<code>operator[]</code> 返回代理对象而非真正的 <code>bool&amp;</code>，不能对其取地址，需要位集合时考虑 <code>deque&lt;bool&gt;</code> 或 <code>bitset</code>。'
    ] },

    { h: '八、练习' },
    { ol: [
      '用 <code>unordered_map&lt;std::string,int&gt;</code> 统计一段文本里每个单词出现的次数，再换成 <code>map</code> 让结果按字典序输出，比较两者遍历顺序的差异。',
      '写一个 <code>vector&lt;int&gt;</code>，在基于范围的循环里试图 <code>erase</code> 所有偶数，观察崩溃；再用 <code>it = v.erase(it)</code> 的显式迭代器循环修复它。',
      '对 10 万个元素分别用 <code>vector</code>（配合 <code>std::sort</code> + <code>std::binary_search</code>）和 <code>map</code> 做查找，粗略计时，体会连续内存 + 二分 vs 红黑树的实际差距。',
      '给一个自定义 <code>struct Point{int x,y;}</code> 实现 <code>std::hash</code>，使其能作为 <code>unordered_set&lt;Point&gt;</code> 的元素。'
    ] }
  ]);
})();
