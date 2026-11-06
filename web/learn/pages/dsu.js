(function () {
  'use strict';
  LEARN.register('dsu', [
    { lead: '并查集（Disjoint Set Union，简称 DSU，又叫 Union-Find）维护一组<strong>互不相交的集合</strong>，支持两种操作：<code>find</code>（查一个元素属于哪个集合，即找它的「代表元 / 根」）与 <code>unite</code>（把两个集合合并成一个）。它用「树」表示每个集合，配合<strong>路径压缩</strong>和<strong>按秩（按大小）合并</strong>两大优化，单次操作的均摊代价低到近似 <strong>O(α(n))</strong>——那个增长慢到可以当常数的反阿克曼函数。' },

    { h: '一、并查集解决什么问题' },
    { p: '很多问题的本质是「动态维护连通性」：不断有「把 A、B 连起来」的操作，同时又要回答「A 和 B 现在连通吗」「一共有几个连通块」。并查集正是为此而生。它把每个集合表示成一棵<strong>树</strong>：树里的每个节点是一个元素，<strong>根节点</strong>就是这个集合的<strong>代表元</strong>。判断两个元素是否同属一个集合，只需看它们 <code>find</code> 到的根是否相同。' },
    { p: '用一个数组 <code>parent[]</code> 即可存下整片森林：<code>parent[i]</code> 记录 <code>i</code> 的父节点，根节点满足 <code>parent[i] == i</code>。<strong>初始化</strong>时每个元素自成一个集合，即对所有 <code>i</code> 令 <code>parent[i] = i</code>。' },
    { ul: [
      '<strong>find(x)</strong>：从 <code>x</code> 沿 <code>parent</code> 一路上跳，直到走到根（<code>parent[root] == root</code>），返回这个根作为代表元。',
      '<strong>unite(a, b)</strong>：先分别 <code>find</code> 出 <code>a</code>、<code>b</code> 的根 <code>ra</code>、<code>rb</code>；若相同说明已在同一集合，无需操作；否则把一棵树的根挂到另一棵树的根下。'
    ] },
    { callout: '朴素并查集有个致命问题：如果每次都把新根随意一挂，树可能退化成一条<strong>链</strong>（<code>1←2←3←…←n</code>），此时一次 <code>find</code> 要走 <code>O(n)</code> 步。下面两个优化正是为了把树「压扁」和「长不高」。', kind: 'warn' },

    { h: '二、两大优化：路径压缩 与 按秩合并' },
    { p: '<strong>① 路径压缩（Path Compression）</strong>：在 <code>find(x)</code> 向上找根的过程中，顺手把沿途经过的每个节点<strong>直接挂到根</strong>上。这样这条路径被「压扁」，下次再 <code>find</code> 这些节点就是一步到位。递归写法极其简洁：<code>if (parent[x] != x) parent[x] = find(parent[x]); return parent[x];</code>——递归返回时把 <code>parent[x]</code> 改写成根。' },
    { p: '<strong>② 按秩 / 按大小合并（Union by Rank / Size）</strong>：合并时，总是把<strong>较矮（或较小）</strong>的那棵树，挂到<strong>较高（或较大）</strong>的那棵树的根下面，避免把大树接在小树上让整体变高。用 <code>rank[i]</code> 记录以 <code>i</code> 为根的树高上界：只有当两棵树的秩相等时，合并后新根的秩才 <code>+1</code>。（「按大小合并」则记录子树节点数 <code>sz[i]</code>，把小树挂到大树下，效果类似。）' },
    { p: '<strong>两者合用</strong>后，可以证明 <code>m</code> 次操作的总代价为 <code>O(m · α(n))</code>，其中 <code>α</code> 是<strong>反阿克曼函数</strong>。它增长慢得惊人——对现实中任何 <code>n</code>（哪怕 <code>n</code> 超过宇宙原子数），<code>α(n) ≤ 5</code>。因此实践中把单次 <code>find/unite</code> 当成 <strong>近似 O(1)</strong> 即可。' },
    { table: {
      head: ['实现', '单次 find / unite', '树高', '说明'],
      rows: [
        ['朴素（无优化）', '最坏 <strong>O(n)</strong>', '可退化成链', '随意合并会越接越高'],
        ['仅按秩合并', 'O(log n)', '≤ log n', '小树挂大树，控制高度'],
        ['仅路径压缩', '近似 O(log n)', '被逐步压扁', 'find 时把路径挂到根'],
        ['<strong>路径压缩 + 按秩合并</strong>', '<strong>O(α(n))</strong>（近似常数）', '极低', '竞赛标准写法']
      ]
    } },

    { h: '三、C++ 实现：路径压缩 + 按秩合并' },
    { p: '下面是一份完整可编译的实现。注意 <code>find</code> 里那句「递归 + 回写」的路径压缩，以及 <code>unite</code> 里「保证 <code>ra</code> 是秩较大的根、把 <code>rb</code> 挂过去、秩相等才自增」的合并顺序。<code>main</code> 还演示了如何<strong>数连通块</strong>。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>          // std::swap
using namespace std;

struct DSU {
    vector<int> parent;       // parent[i]：i 的父节点；根满足 parent[i] == i
    vector<int> rank_;        // rank_[i]：以 i 为根的树高上界（仅对根有意义）

    DSU(int n) : parent(n + 1), rank_(n + 1, 0) {
        for (int i = 0; i <= n; i++) parent[i] = i;   // 初始化：每个元素自成一集合
    }

    int find(int x) {                                 // 找代表元（根），带路径压缩
        if (parent[x] != x)
            parent[x] = find(parent[x]);              // 回溯时把路径上的点直接挂到根
        return parent[x];
    }

    bool unite(int a, int b) {                        // 按秩合并；返回是否真的合并了
        int ra = find(a), rb = find(b);
        if (ra == rb) return false;                   // 已在同一集合
        if (rank_[ra] < rank_[rb]) swap(ra, rb);      // 保证 ra 是秩较大（或相等）的根
        parent[rb] = ra;                              // 小树 rb 挂到大树 ra 下
        if (rank_[ra] == rank_[rb]) rank_[ra]++;      // 仅当两树秩相等，新根秩才 +1
        return true;
    }

    bool same(int a, int b) { return find(a) == find(b); }   // 是否连通
};

int main() {
    int n = 5;
    DSU d(n);
    d.unite(1, 2);                       // {1,2}
    d.unite(3, 4);                       // {3,4}
    cout << d.same(1, 4) << "\n";        // 0：1 与 4 尚不连通
    d.unite(2, 3);                       // 合并 {1,2} 与 {3,4} -> {1,2,3,4}
    cout << d.same(1, 4) << "\n";        // 1：现在连通

    int comps = 0;                       // 数连通块：根（parent[i]==i）的个数
    for (int i = 1; i <= n; i++)
        if (d.find(i) == i) comps++;
    cout << comps << "\n";               // {1,2,3,4} 与 {5} -> 2
    return 0;
}`, lang: 'cpp', title: '并查集：路径压缩 + 按秩合并（C++17 可编译）' },

    { h: '四、经典应用：Kruskal 最小生成树判环' },
    { p: 'Kruskal 求最小生成树（MST）时，把边按权重从小到大排序，依次考虑：若一条边的两个端点<strong>已经连通</strong>，加入它必成环，就跳过；否则加入这条边并用并查集<strong>合并</strong>两端。并查集在这里就是那个「O(1) 判环」的引擎。选够 <code>n-1</code> 条边即得 MST。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

struct Edge { int u, v, w; };

// Kruskal：返回最小生成树总权重；图不连通则返回 -1
int kruskal(int n, vector<Edge> edges) {
    sort(edges.begin(), edges.end(),
         [](const Edge& a, const Edge& b) { return a.w < b.w; });   // 边按权重升序

    vector<int> parent(n + 1);
    for (int i = 0; i <= n; i++) parent[i] = i;

    auto find = [&](int x) {                    // 迭代式 find + 路径压缩
        int root = x;
        while (parent[root] != root) root = parent[root];
        while (parent[x] != root) { int nxt = parent[x]; parent[x] = root; x = nxt; }
        return root;
    };

    int total = 0, used = 0;
    for (const Edge& e : edges) {
        int ru = find(e.u), rv = find(e.v);
        if (ru == rv) continue;                 // 已连通：加入会成环，跳过
        parent[ru] = rv;                        // 合并两棵集合树
        total += e.w;
        if (++used == n - 1) break;             // 生成树恰有 n-1 条边
    }
    return used == n - 1 ? total : -1;
}

int main() {
    // 4 个顶点、5 条边
    vector<Edge> edges = { {1,2,1}, {2,3,2}, {3,4,3}, {1,3,4}, {2,4,5} };
    cout << kruskal(4, edges) << "\n";          // MST = 1+2+3 = 6
    return 0;
}`, lang: 'cpp', title: 'Kruskal 用并查集判环（C++17 可编译）' },

    { h: '五、图解：unite 合并 与 路径压缩' },
    { p: '左图是<strong>按秩合并</strong>：把秩小的树（根 <code>5</code>）整体挂到秩大的树（根 <code>1</code>）下面，树不会被无谓地拔高。右图是<strong>路径压缩</strong>：一次 <code>find(4)</code> 之后，原本 <code>4→3→2→1</code> 的长链被压扁，<code>2、3、4</code> 全部直接挂在根 <code>1</code> 下，后续查询一步到位。' },
    { svg: '<svg viewBox="0 0 720 380" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="并查集按秩合并与路径压缩前后的对比">' +
      '<defs>' +
      '<marker id="dsuAr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#a626a4"/>' +
      '</marker>' +
      '</defs>' +
      '<line x1="360" y1="40" x2="360" y2="360" stroke="#8a94a6" stroke-dasharray="4 4"/>' +
      '<text x="180" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">① unite：按秩合并（小树挂大树）</text>' +
      '<text x="545" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">② 路径压缩：find(4) 前 → 后</text>' +
      '<g stroke="#2f6feb" stroke-width="1.5">' +
      '<line x1="80" y1="76" x2="50" y2="119"/>' +
      '<line x1="80" y1="76" x2="110" y2="119"/>' +
      '<line x1="250" y1="76" x2="250" y2="119"/>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6" text-anchor="middle">' +
      '<text x="80" y="158">集合 A：秩 2</text>' +
      '<text x="250" y="158">集合 B：秩 1</text>' +
      '</g>' +
      '<g stroke="#22863a" stroke-width="1.6" marker-end="url(#dsuAr)">' +
      '<line x1="167" y1="168" x2="167" y2="214"/>' +
      '</g>' +
      '<text x="200" y="196" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">unite(A, B)</text>' +
      '<g stroke="#2f6feb" stroke-width="1.5">' +
      '<line x1="167" y1="236" x2="70" y2="279"/>' +
      '<line x1="167" y1="236" x2="140" y2="279"/>' +
      '<line x1="167" y1="236" x2="245" y2="279"/>' +
      '<line x1="245" y1="301" x2="245" y2="329"/>' +
      '</g>' +
      '<text x="167" y="372" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">合并后：秩小的根 5 挂到秩大的根 1 下</text>' +
      '<g font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6" text-anchor="middle">' +
      '<text x="452" y="56">压缩前（链状）</text>' +
      '<text x="655" y="56">压缩后（扁平）</text>' +
      '</g>' +
      '<g stroke="#8a94a6" stroke-width="1.5">' +
      '<line x1="452" y1="86" x2="452" y2="124"/>' +
      '<line x1="452" y1="146" x2="452" y2="184"/>' +
      '<line x1="452" y1="206" x2="452" y2="244"/>' +
      '</g>' +
      '<g stroke="#2f6feb" stroke-width="1.5">' +
      '<line x1="655" y1="86" x2="600" y2="159"/>' +
      '<line x1="655" y1="86" x2="655" y2="159"/>' +
      '<line x1="655" y1="86" x2="710" y2="159"/>' +
      '</g>' +
      '<g stroke="#22863a" stroke-width="1.8" marker-end="url(#dsuAr)">' +
      '<line x1="500" y1="170" x2="566" y2="170"/>' +
      '</g>' +
      '<text x="533" y="162" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">find(4)</text>' +
      '<g font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6" text-anchor="middle">' +
      '<text x="452" y="280">find(4) 要走 4→3→2→1 共 4 步</text>' +
      '<text x="655" y="210">压缩后 2/3/4 直接挂根，find 一步到位</text>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="14" fill="#1f2933" text-anchor="middle">' +
      '<circle cx="80" cy="70" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="80" y="75">1</text>' +
      '<circle cx="50" cy="130" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="50" y="135">2</text>' +
      '<circle cx="110" cy="130" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="110" y="135">3</text>' +
      '<circle cx="250" cy="70" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="250" y="75">5</text>' +
      '<circle cx="250" cy="130" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="250" y="135">6</text>' +
      '<circle cx="167" cy="230" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="167" y="235">1</text>' +
      '<circle cx="70" cy="290" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="70" y="295">2</text>' +
      '<circle cx="140" cy="290" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="140" y="295">3</text>' +
      '<circle cx="245" cy="290" r="16" fill="#f3e6f3" stroke="#a626a4"/><text x="245" y="295" fill="#a626a4">5</text>' +
      '<circle cx="245" cy="340" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="245" y="345">6</text>' +
      '<circle cx="452" cy="70" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="452" y="75">1</text>' +
      '<circle cx="452" cy="130" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="452" y="135">2</text>' +
      '<circle cx="452" cy="190" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="452" y="195">3</text>' +
      '<circle cx="452" cy="250" r="16" fill="#f3e6f3" stroke="#a626a4"/><text x="452" y="255" fill="#a626a4">4</text>' +
      '<circle cx="655" cy="70" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="655" y="75">1</text>' +
      '<circle cx="600" cy="170" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="600" y="175">2</text>' +
      '<circle cx="655" cy="170" r="16" fill="#eaf1fe" stroke="#2f6feb"/><text x="655" y="175">3</text>' +
      '<circle cx="710" cy="170" r="16" fill="#f3e6f3" stroke="#a626a4"/><text x="710" y="175" fill="#a626a4">4</text>' +
      '</g>' +
      '</svg>', cap: '左：unite 时把秩小的树挂到秩大的树下，抑制树高增长。右：find(4) 触发路径压缩，把 4→3→2→1 的长链上的节点全部直接挂到根 1，之后查询近乎 O(1)。' },

    { h: '六、常见坑' },
    { ul: [
      '<strong>忘记初始化</strong> <code>parent[i] = i</code>：不初始化的并查集什么都不是，每个元素必须先各自成一个集合。',
      '<strong>unite 前要先 find 出根</strong>：合并的是两棵树的<strong>根</strong>（<code>parent[rb] = ra</code>），绝不能直接 <code>parent[b] = a</code>——那样只改了元素本身，破坏树结构。',
      '<strong>只用一个优化也可以，但两个一起用最稳</strong>：只做路径压缩或只做按秩合并都能到 O(log n) 级别；竞赛里通常两个都上，拿到近似 O(α(n))。',
      '<strong>路径压缩的递归写法</strong>：<code>parent[x] = find(parent[x])</code> 要写成「先递归、再回写」；写成 <code>find(parent[x])</code> 而不回写就没有压缩效果。',
      '<strong>连通块计数</strong>：统计满足 <code>find(i) == i</code> 的 <code>i</code> 的个数即可；注意要先对所有点做 <code>find</code>（触发压缩）再判断，或单独维护一个「合并成功就减一」的计数器。',
      '<strong>并查集只适合「无向、只增不减」的连通性</strong>：它不支持删除边（拆集合）。需要动态删边 / 强制在线的连通性问题，得换用 LCT 或离线分治等更强工具。'
    ] },

    { h: '七、练习' },
    { ol: [
      '把上面的「按秩合并」改成<strong>按大小合并</strong>：用 <code>sz[i]</code> 记录每棵树的节点数，合并时把小树挂到大树下并累加 <code>sz</code>，验证连通块与 <code>same</code> 结果不变。',
      '实现<strong>带权并查集</strong>：额外维护 <code>d[x]</code> 表示 <code>x</code> 到其父节点的权值（如「与根的距离」或「与根的关系」），在 <code>find</code> 路径压缩和 <code>unite</code> 时正确更新它，用来解「食物链」「向量偏移」一类问题。',
      '用并查集解决<strong>动态连通块计数</strong>：初始 <code>n</code> 个点各自成块，每读入一条边就 <code>unite</code>，合并成功则块数减一，实时输出当前连通块数量。',
      '补全 <code>kruskal</code>：在读入边时判断图是否连通（<code>used == n-1</code>），若不连通输出提示；再用几组带重边、自环的图测试判环逻辑是否正确。'
    ] }
  ]);
})();
