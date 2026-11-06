(function () {
  'use strict';
  LEARN.register('segment-tree', [
    { lead: '线段树（Segment Tree）是一棵把「区间」逐层二分的平衡二叉树，用来在 <strong>O(log n)</strong> 的时间内完成<strong>区间查询</strong>（求和、最值、gcd……）与<strong>区间修改</strong>（给一段连续下标整体加一个值）。它的杀手锏是<strong>懒标记（lazy propagation）</strong>：区间修改时不立刻把改动推到每个叶子，而是先在父节点上「记一笔账」，等真正需要时才下传，从而把一次区间修改也压到 O(log n)。' },

    { h: '一、为什么需要线段树' },
    { p: '考虑一个经典问题：给一个长度为 <code>n</code> 的数组 <code>a</code>，反复执行两类操作——① 查询区间 <code>[l, r]</code> 的和；② 把区间 <code>[l, r]</code> 里的每个元素都加上 <code>v</code>。最朴素的做法是每次都遍历这段区间：' },
    { ul: [
      '<strong>暴力数组</strong>：区间查询要累加 <code>r-l+1</code> 个元素，区间修改要逐个改写，两者都是 <strong>O(n)</strong>。若操作次数 <code>q</code> 很大，总复杂度 <code>O(n·q)</code> 直接超时。',
      '<strong>前缀和</strong>：能把区间<em>查询</em>降到 O(1)，但一旦有修改，修改点之后的所有前缀和都要重算，单次修改又退回 <strong>O(n)</strong>。',
      '<strong>线段树</strong>：查询和修改都做到 <strong>O(log n)</strong>，总复杂度 <code>O((n + q) log n)</code>，从容应对「边改边查」。'
    ] },
    { p: '线段树的核心思想是<strong>分治</strong>：每个节点代表数组的一个连续区间 <code>[l, r]</code>，并保存这个区间的<strong>聚合信息</strong>（本文用「区间和」）。根代表整个 <code>[1, n]</code>；把一个节点的区间从中点 <code>mid</code> 一分为二，左孩子代表 <code>[l, mid]</code>，右孩子代表 <code>[mid+1, r]</code>；不断二分，直到区间只剩一个元素——那就是叶子。' },
    { p: '虽然概念上是棵树，实现时<strong>不必写指针</strong>：把节点按「堆式编号」放进数组即可。约定根编号为 <code>1</code>，编号为 <code>node</code> 的节点，其左孩子是 <code>node*2</code>、右孩子是 <code>node*2+1</code>。一棵含 <code>n</code> 个叶子的线段树，节点总数不超过 <code>4n</code>，所以数组<strong>开 4n 空间</strong>就绝对够用（这是竞赛里约定俗成的安全上界）。' },
    { callout: '线段树是「平衡」的：每次都对半切，树高为 <code>O(log n)</code>。无论查询还是修改，递归都只会经过树上一条从根往下的路径及其少量旁支，因此单次操作访问的节点数是 <code>O(log n)</code> 级别。', kind: 'note' },

    { h: '二、三个递归操作与懒标记' },
    { p: '线段树的一切都建立在三个递归函数上，它们都带着「当前节点 <code>node</code> 所代表的区间 <code>[l, r]</code>」一起下传：' },
    { ul: [
      '<strong>build</strong>：自底向上建树。叶子 <code>l==r</code> 时直接把 <code>a[l]</code> 填进去；否则先递归建好左右孩子，再用 <code>sum[node] = sum[left] + sum[right]</code> 把孩子的值<strong>合并</strong>上来。',
      '<strong>update</strong>：区间修改。若当前区间 <code>[l, r]</code> 被目标区间 <code>[ql, qr]</code> <strong>完全覆盖</strong>，就地更新本节点并打上懒标记、立即返回；否则先 <code>push_down</code> 把本节点的懒标记下传，再递归进入与目标相交的孩子，最后<strong>重新合并</strong>孩子的值。',
      '<strong>query</strong>：区间查询。完全覆盖时直接返回本节点的 <code>sum</code>；否则先 <code>push_down</code>，再把相交孩子的查询结果累加起来。'
    ] },
    { p: '<strong>懒标记 lazy 是灵魂。</strong>当我们对一段区间整体 <code>+v</code> 时，如果老老实实递归到每个叶子去改，一次修改就是 O(n)。懒标记的做法是：只要当前节点区间被完全覆盖，就<strong>只更新这个节点</strong>——把它的 <code>sum</code> 加上 <code>v × 区间长度</code>，同时把 <code>v</code> 累加进它的 <code>lazy</code> 里「欠着」，不再往下走。' },
    { p: '这笔「欠账」什么时候还？答案是<strong>下传（push_down）</strong>：只有当后续某次操作<strong>需要进入这个节点的孩子</strong>时，才在递归下去之前，把父节点的 <code>lazy</code> 摊派给左右孩子（更新孩子的 <code>sum</code> 和 <code>lazy</code>），然后把父节点的 <code>lazy</code> 清零。<strong>合并顺序</strong>也很关键：懒标记是「叠加」的，所以 <code>lazy[child] += lazy[node]</code>、<code>sum[child] += lazy[node] × 孩子区间长度</code>，绝不能写成覆盖。' },

    { h: '三、复杂度对照表' },
    { table: {
      head: ['方案', '建树', '单点修改', '区间修改', '区间查询', '空间'],
      rows: [
        ['暴力数组', 'O(n)', 'O(1)', '<strong>O(n)</strong>', '<strong>O(n)</strong>', 'O(n)'],
        ['前缀和', 'O(n)', 'O(n)', 'O(n)', 'O(1)', 'O(n)'],
        ['<strong>线段树（无懒标记）</strong>', 'O(n)', 'O(log n)', 'O(n)（改整段）', 'O(log n)', 'O(4n)'],
        ['<strong>线段树 + 懒标记</strong>', 'O(n)', 'O(log n)', '<strong>O(log n)</strong>', '<strong>O(log n)</strong>', 'O(4n)'],
        ['树状数组（见下一篇）', 'O(n log n)', 'O(log n)', '需两个 BIT', 'O(log n)', 'O(n)']
      ]
    } },
    { p: '可见懒标记把「区间修改」从 O(n) 一举降到 O(log n)，这正是线段树能同时高效支持「边改边查」的原因。' },

    { h: '四、C++ 实现：区间求和 + 懒标记' },
    { p: '下面是一份完整可编译的 C++17 实现，以「区间求和」为主线。数组开 <code>4n+5</code>，节点编号从 <code>1</code> 开始，区间用闭区间 <code>[l, r]</code>。请重点对照 <code>push_down</code> 里左右孩子各自的<strong>区间长度</strong>，以及 <code>update</code> 结尾的<strong>重新合并</strong>。' },
    { code: String.raw`#include <iostream>
#include <vector>
using namespace std;

// 区间求和线段树，支持「区间整体加」的懒标记修改（C++17）
struct SegTree {
    int n;
    vector<long long> sum;   // sum[node]：该节点区间的和
    vector<long long> lazy;  // lazy[node]：该节点「尚未下传」的加法标记

    SegTree(int n_) : n(n_), sum(4 * n_ + 5, 0), lazy(4 * n_ + 5, 0) {}

    // 自底向上建树：node 代表区间 [l, r]
    void build(const vector<int>& a, int node, int l, int r) {
        if (l == r) { sum[node] = a[l]; return; }        // 叶子：单点
        int mid = (l + r) >> 1;
        build(a, node << 1,     l,       mid);           // 左孩子 [l, mid]
        build(a, node << 1 | 1, mid + 1, r);             // 右孩子 [mid+1, r]
        sum[node] = sum[node << 1] + sum[node << 1 | 1]; // 合并
    }

    // 把 node 的懒标记下传给左右孩子（只在需要进入孩子前调用）
    void push_down(int node, int l, int r) {
        if (lazy[node] == 0) return;
        int mid = (l + r) >> 1;
        int lc = node << 1, rc = node << 1 | 1;
        // 左孩子区间 [l, mid]，长度 mid - l + 1
        sum[lc]  += lazy[node] * (mid - l + 1);
        lazy[lc] += lazy[node];
        // 右孩子区间 [mid+1, r]，长度 r - mid
        sum[rc]  += lazy[node] * (r - mid);
        lazy[rc] += lazy[node];
        lazy[node] = 0;                                  // 欠账已摊派，清零
    }

    // 把区间 [ql, qr] 的每个元素都加上 val
    void update(int node, int l, int r, int ql, int qr, long long val) {
        if (ql <= l && r <= qr) {                        // 被完全覆盖
            sum[node]  += val * (r - l + 1);
            lazy[node] += val;
            return;
        }
        push_down(node, l, r);                           // 进入孩子前先下传
        int mid = (l + r) >> 1;
        if (ql <= mid) update(node << 1,     l,       mid, ql, qr, val);
        if (qr >  mid) update(node << 1 | 1, mid + 1, r,   ql, qr, val);
        sum[node] = sum[node << 1] + sum[node << 1 | 1]; // 孩子变了，重新合并
    }

    // 查询区间 [ql, qr] 的和
    long long query(int node, int l, int r, int ql, int qr) {
        if (ql <= l && r <= qr) return sum[node];        // 被完全覆盖，直接返回
        push_down(node, l, r);                           // 进入孩子前先下传
        int mid = (l + r) >> 1;
        long long res = 0;
        if (ql <= mid) res += query(node << 1,     l,       mid, ql, qr);
        if (qr >  mid) res += query(node << 1 | 1, mid + 1, r,   ql, qr);
        return res;
    }
};

int main() {
    int n = 5;
    vector<int> a = {0, 1, 2, 3, 4, 5};   // 下标 1..n，a[0] 不用
    SegTree st(n);
    st.build(a, 1, 1, n);

    cout << st.query(1, 1, n, 1, 3) << "\n";  // 1+2+3 = 6
    st.update(1, 1, n, 2, 4, 2);              // a[2..4] 各 +2 -> 1,4,5,6,5
    cout << st.query(1, 1, n, 1, 5) << "\n";  // 1+4+5+6+5 = 21
    cout << st.query(1, 1, n, 2, 3) << "\n";  // 4+5 = 9
    return 0;
}`, lang: 'cpp', title: '区间求和线段树（懒标记，C++17 可编译）' },
    { p: '想把「区间求和」换成<strong>区间最值</strong>（RMQ）非常容易：把 <code>sum[node] = 左 + 右</code> 改成 <code>max/min</code>，把 <code>push_down</code> 里「乘以区间长度」的加法改成对应的最值懒标记（区间「赋值」类懒标记则要额外处理覆盖顺序）。骨架完全一致，只是<strong>合并方式</strong>和<strong>懒标记的语义</strong>变了。' },

    { h: '五、图解：区间划分与 O(log n) 查询' },
    { p: '下图是 <code>n = 8</code> 的线段树：根代表 <code>[1,8]</code>，每往下一层区间就对半分，叶子是单点 <code>[i,i]</code>。查询 <code>[3,6]</code> 时，递归只会命中<strong>恰好被完整覆盖</strong>的少数节点——这里是 <code>[3,4]</code> 与 <code>[5,6]</code> 两块（图中紫色），相加即得答案，无需访问全部 8 个叶子。' },
    { svg: '<svg viewBox="0 0 720 300" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="n=8 的线段树区间划分，查询 [3,6] 被分解为 [3,4] 与 [5,6] 两个节点">' +
      '<text x="360" y="16" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">查询 [3,6] = 节点 [3,4] + 节点 [5,6]，只碰 O(log n) 个节点</text>' +
      '<g stroke="#8a94a6" stroke-width="1.4">' +
      '<line x1="360" y1="42" x2="180" y2="80"/>' +
      '<line x1="360" y1="42" x2="540" y2="80"/>' +
      '<line x1="180" y1="106" x2="90" y2="144"/>' +
      '<line x1="180" y1="106" x2="270" y2="144"/>' +
      '<line x1="540" y1="106" x2="450" y2="144"/>' +
      '<line x1="540" y1="106" x2="630" y2="144"/>' +
      '<line x1="90" y1="170" x2="45" y2="208"/>' +
      '<line x1="90" y1="170" x2="135" y2="208"/>' +
      '<line x1="270" y1="170" x2="225" y2="208"/>' +
      '<line x1="270" y1="170" x2="315" y2="208"/>' +
      '<line x1="450" y1="170" x2="405" y2="208"/>' +
      '<line x1="450" y1="170" x2="495" y2="208"/>' +
      '<line x1="630" y1="170" x2="585" y2="208"/>' +
      '<line x1="630" y1="170" x2="675" y2="208"/>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="13" fill="#1f2933" text-anchor="middle">' +
      '<rect x="326" y="16" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="360" y="34">[1,8]</text>' +
      '<rect x="146" y="80" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="180" y="98">[1,4]</text>' +
      '<rect x="506" y="80" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="540" y="98">[5,8]</text>' +
      '<rect x="56" y="144" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="90" y="162">[1,2]</text>' +
      '<rect x="236" y="144" width="68" height="26" fill="#f3e6f3" stroke="#a626a4"/><text x="270" y="162" fill="#a626a4">[3,4]</text>' +
      '<rect x="416" y="144" width="68" height="26" fill="#f3e6f3" stroke="#a626a4"/><text x="450" y="162" fill="#a626a4">[5,6]</text>' +
      '<rect x="596" y="144" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="630" y="162">[7,8]</text>' +
      '<rect x="11" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="45" y="226">[1,1]</text>' +
      '<rect x="101" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="135" y="226">[2,2]</text>' +
      '<rect x="191" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="225" y="226">[3,3]</text>' +
      '<rect x="281" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="315" y="226">[4,4]</text>' +
      '<rect x="371" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="405" y="226">[5,5]</text>' +
      '<rect x="461" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="495" y="226">[6,6]</text>' +
      '<rect x="551" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="585" y="226">[7,7]</text>' +
      '<rect x="641" y="208" width="68" height="26" fill="#eaf1fe" stroke="#2f6feb"/><text x="675" y="226">[8,8]</text>' +
      '</g>' +
      '<text x="360" y="266" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">根 [1,8] 逐层对半分；叶子是单点 [i,i]。任意区间都能拆成 O(log n) 个「完整节点」之和。</text>' +
      '</svg>', cap: '线段树把 [1,n] 递归二分：每个节点存一段区间的聚合值。查询 [3,6] 命中 [3,4]、[5,6] 两个完整节点即返回，只走 O(log n) 个节点。' },

    { h: '六、常见坑' },
    { callout: '<strong>空间一定要开够 4n。</strong>用 <code>node*2 / node*2+1</code> 编号时，节点最大下标可能接近 <code>4n</code>（尤其是 <code>n</code> 不是 2 的幂时）。只开 <code>2n</code> 极易越界，写成 <code>4n</code>（或 <code>4n+5</code>）才安全。', kind: 'warn' },
    { ul: [
      '<strong>push_down 里两个孩子的区间长度不同</strong>：左孩子是 <code>mid - l + 1</code>，右孩子是 <code>r - mid</code>。把 <code>lazy × 长度</code> 写成同一个值，是最常见的错误，会让区间和直接算错。',
      '<strong>懒标记要「叠加」而不是「覆盖」</strong>：多次区间加应 <code>lazy[child] += lazy[node]</code>；若换成「区间赋值」类懒标记，则要设计好覆盖规则（新赋值冲掉旧的加标记），顺序搞反结果就错。',
      '<strong>update / query 结尾别忘了重新合并</strong>：孩子被改动后，必须 <code>sum[node] = sum[left] + sum[right]</code> 把新值上传，否则父节点仍是旧值。',
      '<strong>进入孩子前务必先 push_down</strong>：只要一个操作要递归到孩子，就要先把父节点的懒标记摊下去，否则孩子读到的是「没算上懒标记」的过时数据。',
      '<strong>区间参数与下标基准要统一</strong>：本文用闭区间 <code>[l, r]</code> 且数组下标从 1 开始；若混用 0 基或半开区间，<code>mid</code> 的切分和边界判断都要相应调整，别一处一套。'
    ] },

    { h: '七、练习' },
    { ol: [
      '把上面的区间求和线段树改成<strong>区间最值（RMQ）</strong>：<code>build/update/query</code> 的合并改用 <code>max</code>，并设计「区间赋值」型懒标记的下传方式。',
      '实现<strong>单点修改 + 区间查询</strong>的简化版（不需要懒标记）：把 <code>update</code> 改成只沿一条路径更新到叶子，再自底向上合并，验证它与带懒标记版本结果一致。',
      '给线段树增加 <code>query</code> 区间「和」的同时支持区间「整体乘一个数」与「整体加一个数」两种懒标记，理清乘、加两种标记<strong>同时存在时的下传顺序</strong>（先乘后加）。',
      '用线段树维护区间和，处理 <code>q</code> 次「区间加 + 区间求和」混合操作，并与暴力数组对拍（随机数据逐次比对），确认懒标记实现无误。'
    ] }
  ]);
})();
