(function () {
  'use strict';
  LEARN.register('bit', [
    { lead: '树状数组（Binary Indexed Tree，简称 BIT，又叫 Fenwick Tree）是一种用「二进制分组」思想维护前缀和的紧凑结构。它只靠一个数组和一行 <code>lowbit(x) = x &amp; -x</code>，就能把<strong>单点修改</strong>和<strong>前缀查询</strong>都做到 <strong>O(log n)</strong>。相比线段树，它代码短得多、常数更小，是「单点改 + 区间查」这类问题的首选。' },

    { h: '一、lowbit 与 c[i] 的管辖区间' },
    { p: '树状数组的核心是 <strong>lowbit</strong>——一个正整数二进制表示里<strong>最低位的那个 1</strong> 所代表的值。用位运算一行就能取出：<code>lowbit(x) = x &amp; -x</code>。原理是 <code>-x</code> 在补码里等于 <code>~x + 1</code>，与 <code>x</code> 相与后恰好只留下最低位的 1。例如 <code>lowbit(6) = lowbit(110₂) = 2</code>，<code>lowbit(8) = lowbit(1000₂) = 8</code>。' },
    { p: '我们用一个辅助数组 <code>c[]</code> 来存「分段前缀和」。<strong>关键约定</strong>是：<code>c[i]</code> 负责（管辖）原数组 <code>a</code> 中<strong>半开区间 <code>(i - lowbit(i), i]</code></strong> 这一段元素之和，也就是从 <code>a[i-lowbit(i)+1]</code> 一直加到 <code>a[i]</code>，一共 <code>lowbit(i)</code> 个元素。' },
    { table: {
      head: ['<code>i</code>', '二进制', '<code>lowbit(i)</code>', '<code>c[i]</code> 管辖区间', '覆盖个数'],
      rows: [
        ['1', '0001', '1', '(0,1] = {1}', '1'],
        ['2', '0010', '2', '(0,2] = {1,2}', '2'],
        ['3', '0011', '1', '(2,3] = {3}', '1'],
        ['4', '0100', '4', '(0,4] = {1,2,3,4}', '4'],
        ['5', '0101', '1', '(4,5] = {5}', '1'],
        ['6', '0110', '2', '(4,6] = {5,6}', '2'],
        ['7', '0111', '1', '(6,7] = {7}', '1'],
        ['8', '1000', '8', '(0,8] = {1…8}', '8']
      ]
    } },
    { p: '观察上表：这些管辖区间<strong>互不重叠又能无缝拼合</strong>，任意前缀 <code>[1, i]</code> 都能拆成若干个 <code>c[·]</code> 之和，而且拆出来的块数不超过 <code>O(log n)</code> 个——因为每拆一块就消掉 <code>i</code> 二进制里的一个 1。这正是前缀查询 <code>sum(i)</code> 高效的原因：从 <code>i</code> 出发，每次 <code>i -= lowbit(i)</code>，把沿途的 <code>c[i]</code> 累加，直到 <code>i</code> 变成 0。' },
    { p: '单点修改 <code>add(i, v)</code> 则反过来：给 <code>a[i]</code> 加上 <code>v</code> 后，所有<strong>管辖区间包含 <code>i</code></strong> 的 <code>c[·]</code> 都要跟着加。这些位置正好是 <code>i, i+lowbit(i), …</code>——每次 <code>i += lowbit(i)</code> 往上跳，直到超过 <code>n</code>。一跳一落，修改与查询都沿 lowbit 走，均为 <strong>O(log n)</strong>。' },
    { callout: '<strong>为什么下标必须从 1 开始？</strong>因为 <code>lowbit(0) = 0 &amp; -0 = 0</code>。若 <code>i</code> 为 0，<code>add</code> 里的 <code>i += lowbit(i)</code> 会永远加 0、陷入<strong>死循环</strong>；<code>sum</code> 里 <code>i -= lowbit(i)</code> 也无法递减到终止。所以下标 1..n 天然规避了这个坑，<code>c[0]</code> 永远不使用。', kind: 'warn' },

    { h: '二、复杂度对照表' },
    { table: {
      head: ['操作', '暴力数组', '前缀和', '<strong>树状数组 BIT</strong>', '线段树'],
      rows: [
        ['单点修改 <code>a[i] += v</code>', 'O(1)', 'O(n)', '<strong>O(log n)</strong>', 'O(log n)'],
        ['前缀查询 <code>sum(1..i)</code>', 'O(n)', 'O(1)', '<strong>O(log n)</strong>', 'O(log n)'],
        ['区间查询 <code>sum(l..r)</code>', 'O(n)', 'O(1)', '<strong>O(log n)</strong>', 'O(log n)'],
        ['区间修改（整段加）', 'O(n)', 'O(n)', '需两个 BIT', 'O(log n)（懒标记）'],
        ['代码量 / 常数', '最小', '小', '<strong>小</strong>', '较大'],
        ['额外空间', 'O(n)', 'O(n)', '<strong>O(n)</strong>', 'O(4n)']
      ]
    } },
    { p: '一句话选型：<strong>只需要「单点改 + 区间查」就用 BIT</strong>（更短更快）；需要「区间改 + 区间查」或维护区间最值等更复杂的信息，才上线段树。' },

    { h: '三、C++ 实现：单点修改 + 区间查询' },
    { p: '核心就 <code>add</code> 与 <code>sum</code> 两个循环，各三四行。区间查询 <code>[l, r]</code> 等于两次前缀相减：<code>sum(r) - sum(l-1)</code>。' },
    { code: String.raw`#include <iostream>
#include <vector>
using namespace std;

struct BIT {                        // 树状数组 / Fenwick Tree
    int n;
    vector<long long> c;            // c[i] 管辖 a 的 (i - lowbit(i), i] 区间和

    BIT(int n_) : n(n_), c(n_ + 1, 0) {}   // 下标 1..n，c[0] 不用

    static int lowbit(int x) { return x & -x; }   // 取最低位的 1

    void add(int i, long long v) {         // a[i] += v，向上传播
        for (; i <= n; i += lowbit(i)) c[i] += v;
    }

    long long sum(int i) const {           // 前缀和 a[1..i]
        long long res = 0;
        for (; i > 0; i -= lowbit(i)) res += c[i];
        return res;
    }

    long long rangeSum(int l, int r) const {   // 区间和 a[l..r] = 两次前缀相减
        return sum(r) - sum(l - 1);
    }
};

int main() {
    int n = 5;
    vector<int> a = {0, 1, 2, 3, 4, 5};   // 下标 1..n
    BIT bit(n);
    for (int i = 1; i <= n; i++) bit.add(i, a[i]);   // O(n log n) 建树

    cout << bit.sum(3) << "\n";            // 1+2+3 = 6
    cout << bit.rangeSum(2, 4) << "\n";    // 2+3+4 = 9
    bit.add(3, 10);                        // a[3] += 10 -> 13
    cout << bit.rangeSum(1, 5) << "\n";    // 1+2+13+4+5 = 25
    return 0;
}`, lang: 'cpp', title: '树状数组：单点改 + 区间查（C++17 可编译）' },
    { p: '建树可以逐个 <code>add</code>（<code>O(n log n)</code>），也有 <code>O(n)</code> 的线性建法：<code>c[i] = a[i]</code> 后，令 <code>c[i + lowbit(i)] += c[i]</code> 从小到大扫一遍即可。' },

    { h: '四、进阶应用：统计逆序对' },
    { p: '逆序对（满足 <code>i &lt; j</code> 且 <code>a[i] &gt; a[j]</code> 的二元组）是 BIT 的经典应用。做法是<strong>从左到右</strong>扫描，用 BIT 维护「已经出现过的数」的出现次数：对当前 <code>x</code>，已插入且<strong>大于</strong> <code>x</code> 的个数 = <code>已插入总数 - 前缀和(≤x 的个数)</code>，累加即得逆序对总数。由于值域可能很大，先把 <code>a</code> <strong>离散化</strong>到 <code>1..m</code> 再喂给 BIT。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

// 统计逆序对：满足 i<j 且 a[i] > a[j] 的 (i, j) 对数
long long countInversions(vector<int> a) {
    vector<int> sorted = a;                       // ---- 离散化：把值压到 1..m ----
    sort(sorted.begin(), sorted.end());
    sorted.erase(unique(sorted.begin(), sorted.end()), sorted.end());
    int m = (int)sorted.size();

    vector<int> c(m + 1, 0);                      // 值域上的 BIT
    auto lowbit = [](int x) { return x & -x; };
    auto add = [&](int i, int v) { for (; i <= m; i += lowbit(i)) c[i] += v; };
    auto sum = [&](int i) { int r = 0; for (; i > 0; i -= lowbit(i)) r += c[i]; return r; };

    long long inv = 0;
    int seen = 0;                                 // 已插入的元素个数
    for (int x : a) {
        int rank = (int)(lower_bound(sorted.begin(), sorted.end(), x) - sorted.begin()) + 1;
        int le = sum(rank);                       // 已插入中 <= x 的个数
        inv += seen - le;                         // 已插入中 > x 的个数，即以 x 结尾的逆序对
        add(rank, 1);
        seen++;
    }
    return inv;
}

int main() {
    vector<int> a = {3, 1, 2, 5, 4};
    cout << countInversions(a) << "\n";           // (3,1)(3,2)(5,4) = 3
    return 0;
}`, lang: 'cpp', title: 'BIT 应用：离散化 + 统计逆序对（C++17 可编译）' },

    { h: '五、图解：c[] 数组的树形管辖范围' },
    { p: '下图把下标 <code>1..8</code> 的原数组画在最底下一行，上方每一条色块就是一个 <code>c[i]</code> 管辖的区间 <code>(i-lowbit(i), i]</code>。可以看到：<code>lowbit</code> 越大的 <code>c[i]</code>（如 <code>c[8]</code>）色块越宽、层级越高；这些色块层层叠叠，恰好把任意前缀拼成 <code>O(log n)</code> 块。' },
    { svg: '<svg viewBox="0 0 720 300" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="下标 1 到 8 的树状数组，每个 c[i] 覆盖 (i-lowbit(i), i] 的一段区间">' +
      '<text x="360" y="22" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">每条色块 = 一个 c[i] 管辖的区间 (i - lowbit(i), i]</text>' +
      '<g font-family="system-ui, sans-serif" font-size="11" text-anchor="middle">' +
      '<rect x="104" y="44" width="508" height="12" fill="#f3e6f3" stroke="#a626a4"/><text x="358" y="40" fill="#a626a4">c[8] 管 {1..8}（lowbit=8）</text>' +
      '<rect x="104" y="84" width="252" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="230" y="80" fill="#1f2933">c[4] 管 {1..4}</text>' +
      '<rect x="104" y="124" width="124" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="166" y="120" fill="#1f2933">c[2] 管 {1,2}</text>' +
      '<rect x="360" y="124" width="124" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="422" y="120" fill="#1f2933">c[6] 管 {5,6}</text>' +
      '<rect x="104" y="164" width="60" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="134" y="160" fill="#1f2933">c[1]</text>' +
      '<rect x="232" y="164" width="60" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="262" y="160" fill="#1f2933">c[3]</text>' +
      '<rect x="360" y="164" width="60" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="390" y="160" fill="#1f2933">c[5]</text>' +
      '<rect x="488" y="164" width="60" height="12" fill="#eaf1fe" stroke="#2f6feb"/><text x="518" y="160" fill="#1f2933">c[7]</text>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="12" text-anchor="middle">' +
      '<rect x="104" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="134" y="224" fill="#1f2933">a[1]</text>' +
      '<rect x="168" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="198" y="224" fill="#1f2933">a[2]</text>' +
      '<rect x="232" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="262" y="224" fill="#1f2933">a[3]</text>' +
      '<rect x="296" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="326" y="224" fill="#1f2933">a[4]</text>' +
      '<rect x="360" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="390" y="224" fill="#1f2933">a[5]</text>' +
      '<rect x="424" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="454" y="224" fill="#1f2933">a[6]</text>' +
      '<rect x="488" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="518" y="224" fill="#1f2933">a[7]</text>' +
      '<rect x="552" y="200" width="60" height="40" fill="#ffffff" stroke="#2f6feb"/><text x="582" y="224" fill="#1f2933">a[8]</text>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6" text-anchor="middle">' +
      '<text x="134" y="258">i=1</text><text x="198" y="258">2</text><text x="262" y="258">3</text><text x="326" y="258">4</text>' +
      '<text x="390" y="258">5</text><text x="454" y="258">6</text><text x="518" y="258">7</text><text x="582" y="258">8</text>' +
      '</g>' +
      '<text x="360" y="286" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">sum(7) = c[7] + c[6] + c[4]（沿 i -= lowbit(i) 跳 3 次）</text>' +
      '</svg>', cap: 'c[i] 管辖 (i-lowbit(i), i]。求 sum(7) 时，7 → 减 lowbit(7)=1 得 6 → 减 lowbit(6)=2 得 4 → 减 lowbit(4)=4 得 0，累加 c[7]+c[6]+c[4] 三块即为前缀和。' },

    { h: '六、常见坑' },
    { ul: [
      '<strong>下标不能从 0 开始</strong>：<code>lowbit(0) = 0</code>，会让 <code>add/sum</code> 的循环原地打转、死循环。务必让数据落在 <code>1..n</code>。',
      '<strong>循环方向别写反</strong>：<code>add</code> 是 <code>i += lowbit(i)</code> 往上跳、上界 <code>i &lt;= n</code>；<code>sum</code> 是 <code>i -= lowbit(i)</code> 往下跳、终止于 <code>i &gt; 0</code>。方向或边界写错会漏加 / 越界。',
      '<strong>区间查询要用两次前缀相减</strong>：<code>[l, r]</code> 的和是 <code>sum(r) - sum(l-1)</code>，别只减 <code>sum(l)</code>，那样会漏掉 <code>a[l]</code>。',
      '<strong>值域大要先离散化</strong>：像逆序对、以数值为下标统计时，若值可能到 <code>10^9</code>，BIT 开不下，必须先排序去重映射到 <code>1..m</code>。',
      '<strong>BIT 功能弱于线段树</strong>：单个 BIT 经典只支持「单点改 + 区间查」；要「区间改 + 单点查」可对差分数组建 BIT；「区间改 + 区间查」则需要<strong>两个 BIT</strong> 配合（维护 <code>a[i]</code> 与 <code>(i-1)·a[i]</code> 两组前缀）。'
    ] },
    { callout: 'BIT 能高效工作的本质是<strong>二进制分解</strong>：任何前缀 <code>[1, i]</code> 都能按 <code>i</code> 的二进制位拆成至多 <code>log₂(n)</code> 个互不重叠的 <code>c[·]</code> 块。理解这一点，<code>+= lowbit</code> 与 <code>-= lowbit</code> 的方向就不再需要死记。', kind: 'tip' },

    { h: '七、练习' },
    { ol: [
      '实现 <code>O(n)</code> 的<strong>线性建树</strong>：先令 <code>c[i] = a[i]</code>，再对 <code>i</code> 从小到大执行 <code>c[i + lowbit(i)] += c[i]</code>（<code>i + lowbit(i) &lt;= n</code> 时），并与逐个 <code>add</code> 的建树结果对拍。',
      '用<strong>一个</strong> BIT 支持「区间加、单点查」：提示——对<strong>差分数组</strong> <code>d[i] = a[i] - a[i-1]</code> 建 BIT，区间 <code>[l, r]</code> 加 <code>v</code> 变成 <code>add(l, v)</code> 与 <code>add(r+1, -v)</code> 两次单点改，单点查即前缀和 <code>sum(i)</code>。',
      '用<strong>两个</strong> BIT 支持「区间加、区间查」：分别维护 <code>d[i]</code> 与 <code>(i-1)·d[i]</code> 的前缀和，推导出 <code>sum(1..i)</code> 的表达式并实现，用随机数据与暴力对拍。',
      '用本文的 <code>countInversions</code> 统计一个含重复元素的数组的逆序对数，思考若要统计「<code>a[i] ≥ a[j]</code>」这类<strong>非严格</strong>逆序对，离散化后的查询边界应如何调整。'
    ] }
  ]);
})();
