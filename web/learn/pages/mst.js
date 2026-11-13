(function () {
  'use strict';
  LEARN.register('mst', [
    { lead: '给一张带权无向连通图，如何用<strong>最少的总权值</strong>把所有顶点连起来、且不成环？答案是<strong>最小生成树（Minimum Spanning Tree, MST）</strong>。它用于铺设光缆、修路、聚类等问题。本篇讲两种经典贪心算法——<strong>Kruskal</strong> 和 <strong>Prim</strong>。' },

    { h: '一、生成树与最小生成树' },
    { ul: [
      '<strong>生成树（spanning tree）</strong>：包含图中<em>全部 V 个顶点</em>、且<em>无环连通</em>的子图。它必然恰好有 <code>V-1</code> 条边——少一条就不连通，多一条就成环。',
      '<strong>最小生成树（MST）</strong>：在所有生成树中，<em>边权之和最小</em>的那棵。',
      '<strong>前提</strong>：MST 只对<strong>无向连通图</strong>有意义。若图不连通，则不存在能覆盖所有顶点的生成树（此时可对每个连通块分别求 MST，得到最小生成森林）。',
      '<strong>唯一性</strong>：当所有边权互不相同时，MST 唯一；若有相等权值，MST 的总权值仍唯一，但边的组合可能不唯一。'
    ] },
    { p: '<strong>切割性质（cut property）</strong>是两种贪心算法共同的理论依据：把顶点任意分成两个非空集合，跨越这两个集合的所有边中，<em>权值最小的那条边一定属于某棵 MST</em>。Kruskal 和 Prim 都是在反复利用这条性质安全地加边。' },

    { h: '二、Kruskal：按边贪心' },
    { p: '<strong>Kruskal</strong> 的思路是「全局看边」：把所有边按权值从小到大排序，依次考察每条边，若它的两个端点<em>当前还不在同一连通块</em>（加入后不成环），就把这条边选入 MST，否则丢弃。用<strong>并查集（DSU）</strong>可以在近似 <code>O(1)</code> 内判断「是否同块」并合并。排序是瓶颈，整体 <code>O(E log E)</code>。' },

    { h: '三、Prim：按点贪心' },
    { p: '<strong>Prim</strong> 的思路是「从一点长大」：任选一个起点加入集合 S，此后每次在所有「一端在 S、另一端不在 S」的边里挑权值最小的，把对应的新顶点并入 S，直到所有顶点都进入 S。用<strong>优先队列（小根堆）</strong>维护这些跨集合的边，可做到 <code>O(E log V)</code>；朴素地每次线性扫描则是 <code>O(V²)</code>，在稠密图上反而更快。' },

    { h: '四、复杂度与适用场景对照表' },
    { table: {
      head: ['算法', '核心思想', '时间复杂度', '依赖结构', '适用场景'],
      rows: [
        ['Kruskal', '所有边排序，用并查集判是否成环', '<code>O(E log E)</code>', '并查集（DSU）', '稀疏图（E 较小）'],
        ['Prim（朴素）', '每次线性扫描找最小跨切割边', '<code>O(V²)</code>', '邻接矩阵', '稠密图（E 接近 V²）'],
        ['Prim（堆优化）', '用小根堆维护跨切割的边', '<code>O(E log V)</code>', '二叉堆 + 邻接表', '稀疏图 / 通用']
      ]
    } },

    { h: '五、C++ 实现' },
    { p: '<strong>1) Kruskal + 并查集。</strong>并查集带路径压缩与按秩合并；<code>unite</code> 返回 <code>false</code> 表示两点已连通（加这条边会成环）。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>
using namespace std;

struct DSU {                            // 并查集：路径压缩 + 按秩合并
    vector<int> p, r;
    DSU(int n) : p(n), r(n, 0) { for (int i = 0; i < n; ++i) p[i] = i; }
    int find(int x) { return p[x] == x ? x : p[x] = find(p[x]); }
    bool unite(int a, int b) {          // 已在同一集合返回 false（成环）
        a = find(a); b = find(b);
        if (a == b) return false;
        if (r[a] < r[b]) swap(a, b);
        p[b] = a;
        if (r[a] == r[b]) ++r[a];
        return true;
    }
};

struct Edge { int u, v, w; };

// Kruskal：返回 MST 权值和；图不连通时返回 -1
long long kruskal(int n, vector<Edge> edges) {
    sort(edges.begin(), edges.end(), [](const Edge& a, const Edge& b){ return a.w < b.w; });
    DSU dsu(n);
    long long total = 0; int used = 0;
    for (const Edge& e : edges) {
        if (dsu.unite(e.u, e.v)) {      // u、v 不连通 -> 加入不成环
            total += e.w;
            if (++used == n - 1) break; // 生成树恰好 V-1 条边，选满即止
        }
    }
    return used == n - 1 ? total : -1;
}

int main() {
    int n = 6;
    vector<Edge> edges = {
        {0,1,4},{0,2,3},{1,2,1},{1,3,2},{2,3,5},{2,4,7},{3,4,6},{3,5,8},{4,5,2}
    };
    cout << "MST 权值和 = " << kruskal(n, edges) << '\n';   // 14
    return 0;
}`, title: 'Kruskal：边排序 + 并查集判环' },
    { p: '<strong>2) Prim 堆优化。</strong>堆里存 <code>(边权, 顶点)</code>，每次取最小的、且尚未并入的顶点。用 <code>inMST[]</code> 标记已并入集合，弹出时若已并入则跳过（过期条目）。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <queue>
using namespace std;

typedef pair<int,int> pii;              // (边权, 顶点)

// Prim 堆优化：从顶点 0 生长；返回 MST 权值和，图不连通返回 -1
long long prim(int n, const vector<vector<pii>>& adj) {
    vector<bool> inMST(n, false);
    priority_queue<pii, vector<pii>, greater<pii>> pq;   // 小根堆
    pq.push({0, 0});                    // 从顶点 0 开始，首条边权 0
    long long total = 0; int used = 0;
    while (!pq.empty() && used < n) {
        pii top = pq.top(); pq.pop();
        int w = top.first, u = top.second;
        if (inMST[u]) continue;         // u 已并入，过期条目跳过
        inMST[u] = true; total += w; ++used;
        for (const pii& e : adj[u])     // 把 u 连向未并入点的边压入堆
            if (!inMST[e.first]) pq.push({e.second, e.first});
    }
    return used == n ? total : -1;
}

int main() {
    int n = 6;
    vector<vector<pii>> adj(n);
    auto add = [&](int u,int v,int w){ adj[u].push_back({v,w}); adj[v].push_back({u,w}); };
    add(0,1,4); add(0,2,3); add(1,2,1); add(1,3,2);
    add(2,3,5); add(2,4,7); add(3,4,6); add(3,5,8); add(4,5,2);
    cout << "MST 权值和 = " << prim(n, adj) << '\n';        // 14
    return 0;
}`, title: 'Prim 堆优化：每次并入最小跨切割边' },
    { p: '两种算法在同一张图上得到的 MST 权值和都是 <code>14</code>，被选中的边是 <code>{0—2(3), 1—2(1), 1—3(2), 3—4(6), 4—5(2)}</code>，正好 <code>V-1 = 5</code> 条。' },

    { h: '六、图解：一张图的 MST' },
    { svg: '<svg viewBox="0 0 620 290" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一张 6 顶点带权无向图，紫色边构成最小生成树，灰色边未被选中，节点标出编号">' +
      // 未选中边（灰）
      '<line x1="80" y1="60" x2="230" y2="40" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="150" y1="160" x2="330" y2="140" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="150" y1="160" x2="250" y2="240" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="330" y1="140" x2="470" y2="210" stroke="#8a94a6" stroke-width="2"/>' +
      // 选中边（MST，紫）
      '<line x1="80" y1="60" x2="150" y2="160" stroke="#a626a4" stroke-width="3"/>' +
      '<line x1="230" y1="40" x2="150" y2="160" stroke="#a626a4" stroke-width="3"/>' +
      '<line x1="230" y1="40" x2="330" y2="140" stroke="#a626a4" stroke-width="3"/>' +
      '<line x1="330" y1="140" x2="250" y2="240" stroke="#a626a4" stroke-width="3"/>' +
      '<line x1="250" y1="240" x2="470" y2="210" stroke="#a626a4" stroke-width="3"/>' +
      // 边权标签
      '<text x="150" y="42" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">4</text>' +
      '<text x="240" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">5</text>' +
      '<text x="188" y="204" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">7</text>' +
      '<text x="404" y="168" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">8</text>' +
      '<text x="102" y="116" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">3</text>' +
      '<text x="176" y="100" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">1</text>' +
      '<text x="292" y="82" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">2</text>' +
      '<text x="300" y="196" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">6</text>' +
      '<text x="360" y="234" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">2</text>' +
      // 顶点
      '<circle cx="80" cy="60" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="80" y="65" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">0</text>' +
      '<circle cx="230" cy="40" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="230" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">1</text>' +
      '<circle cx="150" cy="160" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="150" y="165" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">2</text>' +
      '<circle cx="330" cy="140" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="330" y="145" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">3</text>' +
      '<circle cx="250" cy="240" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="250" y="245" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">4</text>' +
      '<circle cx="470" cy="210" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="470" y="215" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">5</text>' +
      // 图例
      '<line x1="20" y1="276" x2="48" y2="276" stroke="#a626a4" stroke-width="3"/>' +
      '<text x="54" y="280" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">MST 选中的边（权值和 = 14）</text>' +
      '<line x1="300" y1="276" x2="328" y2="276" stroke="#8a94a6" stroke-width="2"/>' +
      '<text x="334" y="280" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">未选中的边</text>' +
      '</svg>', cap: '紫色边 {0—2, 1—2, 1—3, 3—4, 4—5} 构成这张图的最小生成树，恰有 V-1=5 条边、总权值 14；灰色的 0—1、2—3、2—4、3—5 被淘汰。' },

    { h: '七、常见坑' },
    { callout: '<strong>MST 是「无向图」概念。</strong>有向图没有生成树（对应的是「最小树形图 / 朱-刘算法」，完全不同）。用 Kruskal 或 Prim 前，务必确认输入是无向图；建邻接表时有向边只能加一次，无向边要加两次。', kind: 'warn' },
    { ul: [
      '<strong>Kruskal 忘记先排序</strong>：必须按边权从小到大排序后再贪心，否则不满足切割性质，结果不是最小的。',
      '<strong>Kruskal 用并查集判环写错</strong>：应判断两端点 <code>find</code> 结果是否相同——相同则加边会成环要跳过，不同才 <code>unite</code> 并计入。',
      '<strong>Prim 选满顶点就停</strong>：当选入的顶点数达到 <code>V</code>（或边数达到 <code>V-1</code>）即可停止；堆里可能残留过期条目，靠 <code>inMST[]</code> 跳过。',
      '<strong>图不连通</strong>：两种算法都应能识别——若最终选中的边不足 <code>V-1</code> 条，说明图不连通，不存在覆盖全图的 MST。'
    ] },

    { h: '八、练习' },
    { ol: [
      '在 Kruskal 中记录被选中的边，输出完整的 MST 边集，而不仅是权值和。',
      '给 Prim 换一个起点重跑，验证 MST 的总权值不随起点改变（在边权互不相同时边集也不变）。',
      '实现朴素 <code>O(V²)</code> 版 Prim（用 <code>dist[]</code> + 线性扫描代替堆），在稠密图上和堆优化版对比运行时间。',
      '构造一个不连通的图，确认 Kruskal 与 Prim 都能通过「选中边数 &lt; V-1」检测出无法生成完整 MST。'
    ] }
  ]);
})();
