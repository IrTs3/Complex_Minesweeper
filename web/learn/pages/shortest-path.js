(function () {
  'use strict';
  LEARN.register('shortest-path', [
    { lead: '「从 A 到 B 怎么走最省」是最短路径问题，也是图论里应用最广的一类问题：导航、网络路由、任务调度都离不开它。本篇讲三种经典算法——<strong>Dijkstra</strong>、<strong>Bellman-Ford</strong> 和 <strong>Floyd</strong>。它们形态各异，但共享同一个核心动作：<strong>松弛（relax）</strong>。' },

    { h: '一、单源 vs 多源，以及「松弛」' },
    { ul: [
      '<strong>单源最短路径（SSSP）</strong>：给定一个起点 <code>s</code>，求 <code>s</code> 到其余所有点的最短距离。Dijkstra 和 Bellman-Ford 都属于这一类。',
      '<strong>多源 / 全源最短路径（APSP）</strong>：求<em>任意两点</em>之间的最短距离。Floyd 属于这一类。',
      '<strong>松弛（relax）</strong>：对一条边 <code>u→v</code>（权 <code>w</code>），检查「先走到 u，再走这条边」是否比目前已知的到 v 的距离更短：<code>if (dist[u] + w &lt; dist[v]) dist[v] = dist[u] + w;</code>。三种算法的差别，只在于<em>以什么顺序、松弛多少条边</em>。'
    ] },
    { p: '约定 <code>dist[s] = 0</code>，其余初始为 <code>INF</code>（一个足够大的数）。随着不断松弛，<code>dist[]</code> 单调下降并逐步收敛到真正的最短距离。' },

    { h: '二、三种算法的思想' },
    { p: '<strong>Dijkstra（贪心）</strong>：维护一个「已确定最短距离」的集合，每次从未确定的点里取出当前 <code>dist</code> 最小的点 u，认定它已确定，再用 u 去松弛它的邻居。因为每次选的都是全局最近的点，只要<strong>没有负权边</strong>，这个贪心就是正确的。朴素实现每次线性扫描找最小点是 <code>O(V²)</code>；用<strong>优先队列（小根堆）</strong>取最小点可降到 <code>O((V+E) log V)</code>。' },
    { p: '<strong>Bellman-Ford（逐轮松弛）</strong>：不做任何贪心假设，直接把<em>所有边</em>松弛 <code>V-1</code> 轮。因为最短路径最多包含 <code>V-1</code> 条边，所以 <code>V-1</code> 轮后一定收敛。它能处理<strong>负权边</strong>；再多做一轮，如果还能松弛，就说明图中存在<strong>负环</strong>（可以无限绕圈把距离压到负无穷）。复杂度 <code>O(V·E)</code>。' },
    { p: '<strong>Floyd（动态规划）</strong>：求全源最短路。状态 <code>d[i][j]</code> 表示「只允许用编号 &lt; k 的点作中转」时 i 到 j 的最短距离，转移是 <code>d[i][j] = min(d[i][j], d[i][k] + d[k][j])</code>。关键是三重循环里 <strong>k 必须在最外层</strong>，保证第 k 轮时所有点对都已考虑到「以 k 为中转」。复杂度 <code>O(V³)</code>，代码极短，适合点少的稠密图。' },

    { h: '三、复杂度与适用场景对照表' },
    { table: {
      head: ['算法', '类型', '时间复杂度', '负权边', '典型适用场景'],
      rows: [
        ['Dijkstra（朴素）', '单源', '<code>O(V²)</code>', '不支持', '稠密图、边权非负'],
        ['Dijkstra（堆优化）', '单源', '<code>O((V+E) log V)</code>', '不支持', '稀疏图、边权非负，最常用'],
        ['Bellman-Ford', '单源', '<code>O(V·E)</code>', '支持，且能检测负环', '有负权 / 需判断负环是否存在'],
        ['Floyd-Warshall', '多源（全源）', '<code>O(V³)</code>', '支持（结束后 <code>d[i][i]&lt;0</code> 即有负环）', '点少、需要任意两点间最短路']
      ]
    } },

    { h: '四、C++ 实现' },
    { p: '<strong>1) Dijkstra 堆优化。</strong>用小根堆存 <code>(距离, 顶点)</code>，每次弹出当前最近的点。堆里会有「过期条目」（同一顶点被多次更新后残留的旧距离），弹出时若 <code>d &gt; dist[u]</code> 就直接跳过——这是堆优化 Dijkstra 的标志性写法，比维护 <code>visited</code> 数组更简洁。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <queue>
using namespace std;

const long long INF = 1e18;
typedef pair<long long,int> pli;        // (距离, 顶点)

// Dijkstra 堆优化：单源、边权非负。adj[u] = {(v, w)} 表示 u->v 权 w
vector<long long> dijkstra(int s, int n, const vector<vector<pair<int,int>>>& adj) {
    vector<long long> dist(n, INF);
    priority_queue<pli, vector<pli>, greater<pli>> pq;   // 小根堆：距离小的先出
    dist[s] = 0;
    pq.push({0, s});
    while (!pq.empty()) {
        pli top = pq.top(); pq.pop();
        long long d = top.first; int u = top.second;
        if (d > dist[u]) continue;      // 过期条目：u 已被更短的距离确定，跳过
        for (auto& e : adj[u]) {
            int v = e.first, w = e.second;
            if (dist[u] + w < dist[v]) {    // 松弛
                dist[v] = dist[u] + w;
                pq.push({dist[v], v});
            }
        }
    }
    return dist;
}

int main() {
    int n = 5;                          // 顶点 0..4
    vector<vector<pair<int,int>>> adj(n);
    auto add = [&](int u,int v,int w){ adj[u].push_back({v,w}); adj[v].push_back({u,w}); };
    add(0,1,4); add(0,2,1); add(2,1,2); add(1,3,1); add(2,3,5); add(3,4,3);
    vector<long long> dist = dijkstra(0, n, adj);
    for (int i = 0; i < n; ++i)
        cout << "0->" << i << " = " << (dist[i] == INF ? -1 : dist[i]) << '\n';
    return 0;
}`, title: 'Dijkstra 堆优化：输出 0 到各点的最短距离' },
    { p: '上面这张图从 0 出发的结果是 <code>0→0=0, 0→1=3, 0→2=1, 0→3=4, 0→4=7</code>，其中到 1 的最短路走的是 <code>0→2→1</code>（1+2=3）而非直连的 <code>0→1</code>（4）。' },

    { p: '<strong>2) Bellman-Ford。</strong>把所有边存成 <code>{u, v, w}</code> 列表，松弛 <code>V-1</code> 轮；用 <code>changed</code> 标志可在提前收敛时跳出。第 <code>V</code> 轮再扫一遍，若还能松弛则存在从源点可达的负环。' },
    { code: String.raw`#include <iostream>
#include <vector>
using namespace std;

const long long INF = 1e18;
struct Edge { int u, v, w; };           // 有向边 u->v，权 w

// 返回 false 表示存在从 s 可达的负环；否则 dist 为最短距离
bool bellmanFord(int s, int n, const vector<Edge>& edges, vector<long long>& dist) {
    dist.assign(n, INF);
    dist[s] = 0;
    for (int i = 0; i < n - 1; ++i) {   // 最多 V-1 轮即可收敛
        bool changed = false;
        for (const Edge& e : edges) {
            if (dist[e.u] != INF && dist[e.u] + e.w < dist[e.v]) {
                dist[e.v] = dist[e.u] + e.w;
                changed = true;
            }
        }
        if (!changed) break;            // 本轮无任何松弛，提前结束
    }
    for (const Edge& e : edges)         // 第 V 轮：还能松弛 => 有负环
        if (dist[e.u] != INF && dist[e.u] + e.w < dist[e.v])
            return false;
    return true;
}

int main() {
    int n = 4;
    vector<Edge> edges = { {0,1,2}, {0,2,5}, {1,2,1}, {2,3,-3}, {1,3,6} };
    vector<long long> dist;
    if (!bellmanFord(0, n, edges, dist)) { cout << "存在负环\n"; return 0; }
    for (int i = 0; i < n; ++i)
        cout << "0->" << i << " = " << (dist[i] == INF ? -1 : dist[i]) << '\n';
    return 0;
}`, title: 'Bellman-Ford：支持负权边，并可检测负环' },
    { p: '这段含负权边 <code>2→3(-3)</code>，结果为 <code>0→0=0, 0→1=2, 0→2=3, 0→3=0</code>。到 3 的最短路是 <code>0→1→2→3 = 2+1-3 = 0</code>，负权边被正确处理，这是 Dijkstra 做不到的。' },

    { p: '<strong>3) Floyd-Warshall。</strong>三重循环，<code>k</code> 在最外层。为防止 <code>INF + INF</code> 溢出，松弛前先判断两个子距离都不是 <code>INF</code>。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <string>
using namespace std;

const long long INF = 1e15;             // 取值需保证 INF+INF 不溢出 long long

// d 是 n x n 矩阵，初始为直接边权（无边为 INF）；就地更新为全源最短路
void floyd(int n, vector<vector<long long>>& d) {
    for (int i = 0; i < n; ++i) d[i][i] = 0;
    for (int k = 0; k < n; ++k)         // 中转点 k 必须在最外层
        for (int i = 0; i < n; ++i)
            for (int j = 0; j < n; ++j)
                if (d[i][k] < INF && d[k][j] < INF && d[i][k] + d[k][j] < d[i][j])
                    d[i][j] = d[i][k] + d[k][j];
}

int main() {
    int n = 4;
    vector<vector<long long>> d(n, vector<long long>(n, INF));
    auto add = [&](int u,int v,long long w){ if (w < d[u][v]) d[u][v] = w; };
    add(0,1,3); add(0,2,8); add(1,2,-5); add(2,3,4); add(1,3,7);  // 有向图
    floyd(n, d);
    for (int i = 0; i < n; ++i) {
        for (int j = 0; j < n; ++j)
            cout << (d[i][j] >= INF ? string("INF") : to_string(d[i][j])) << ' ';
        cout << '\n';
    }
    return 0;
}`, title: 'Floyd：O(V³) 求任意两点间最短距离' },
    { p: '输出的距离矩阵第 0 行是 <code>0 3 -2 2</code>：例如 <code>0→2</code> 走 <code>0→1→2 = 3+(-5) = -2</code>，比直连的 8 更短。若结束后发现某个 <code>d[i][i] &lt; 0</code>，说明 i 处在负环上。' },

    { h: '五、图解：最短路径树' },
    { p: '单源最短路径的结果可以看作一棵以源点为根的<strong>最短路径树</strong>：树上每条从根到某点的路径，就是到该点的一条最短路。下图高亮了从 0 出发被选中的边（绿色），灰色是被淘汰的边。' },
    { svg: '<svg viewBox="0 0 620 270" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一张带权无向图，绿色边构成从源点 0 出发的最短路径树，灰色边被淘汰，每个节点标出到 0 的最短距离">' +
      // 边：绿色=最短路径树选中，灰色=未选中
      '<line x1="70" y1="130" x2="210" y2="210" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="70" y1="130" x2="210" y2="50" stroke="#22863a" stroke-width="3"/>' +
      '<line x1="210" y1="50" x2="210" y2="210" stroke="#22863a" stroke-width="3"/>' +
      '<line x1="210" y1="210" x2="370" y2="130" stroke="#22863a" stroke-width="3"/>' +
      '<line x1="210" y1="50" x2="370" y2="130" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="370" y1="130" x2="520" y2="130" stroke="#22863a" stroke-width="3"/>' +
      // 边权标签
      '<text x="138" y="172" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">4</text>' +
      '<text x="140" y="88" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">1</text>' +
      '<text x="222" y="134" text-anchor="start" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">2</text>' +
      '<text x="288" y="176" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">1</text>' +
      '<text x="288" y="86" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">5</text>' +
      '<text x="445" y="122" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">3</text>' +
      // 顶点
      '<circle cx="70" cy="130" r="20" fill="#e6f4ea" stroke="#22863a" stroke-width="2"/>' +
      '<text x="70" y="135" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">0</text>' +
      '<circle cx="210" cy="210" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="210" y="215" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">1</text>' +
      '<circle cx="210" cy="50" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="210" y="55" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">2</text>' +
      '<circle cx="370" cy="130" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="370" y="135" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">3</text>' +
      '<circle cx="520" cy="130" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="520" y="135" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">4</text>' +
      // 距离徽标
      '<circle cx="85" cy="116" r="10" fill="#a626a4"/><text x="85" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">0</text>' +
      '<circle cx="225" cy="196" r="10" fill="#a626a4"/><text x="225" y="200" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">3</text>' +
      '<circle cx="225" cy="36" r="10" fill="#a626a4"/><text x="225" y="40" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">1</text>' +
      '<circle cx="385" cy="116" r="10" fill="#a626a4"/><text x="385" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">4</text>' +
      '<circle cx="535" cy="116" r="10" fill="#a626a4"/><text x="535" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">7</text>' +
      // 图例
      '<line x1="20" y1="252" x2="48" y2="252" stroke="#22863a" stroke-width="3"/>' +
      '<text x="54" y="256" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">最短路径树上的边</text>' +
      '<line x1="200" y1="252" x2="228" y2="252" stroke="#8a94a6" stroke-width="2"/>' +
      '<text x="234" y="256" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">被淘汰的边</text>' +
      '<circle cx="360" cy="252" r="9" fill="#a626a4"/><text x="360" y="256" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#ffffff">d</text>' +
      '<text x="376" y="256" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">= 到源点 0 的最短距离</text>' +
      '</svg>', cap: '从源点 0 出发的最短路径树：绿色边 0—2、2—1、1—3、3—4 构成树，节点旁的紫色数字是到 0 的最短距离（0,1,2,3,4 分别为 0,3,1,4,7）。' },

    { h: '六、常见坑' },
    { callout: '<strong>Dijkstra 不能处理负权边。</strong>它的贪心前提是「已确定点不会再被更新」，一旦有负权边，后来可能出现更短的路径推翻已确定的点，结果就错了。有负权请改用 Bellman-Ford（或 SPFA）。', kind: 'warn' },
    { ul: [
      '<strong>Floyd 的 <code>k</code> 放错循环层</strong>：<code>k</code> 必须在最外层。若写成 <code>i</code> 或 <code>j</code> 在外层，中转点的更新时机会错乱，得到错误结果。',
      '<strong><code>INF</code> 取值过大导致溢出</strong>：松弛时做 <code>dist[u] + w</code> 或 <code>d[i][k] + d[k][j]</code>，若 <code>INF</code> 接近 <code>INT_MAX</code> 会溢出成负数。用 <code>long long</code> 并把 <code>INF</code> 设成 <code>1e15</code> 量级，或加法前先判 <code>!= INF</code>。',
      '<strong>堆优化 Dijkstra 忘判过期条目</strong>：同一顶点可能被多次入堆，弹出时必须判 <code>d &gt; dist[u]</code> 跳过，否则会重复松弛、拖慢甚至逻辑出错。',
      '<strong>Bellman-Ford 松弛轮数</strong>：需要 <code>V-1</code> 轮而非 <code>V</code> 或 <code>E</code> 轮；负环检测是额外再做的第 <code>V</code> 轮。'
    ] },

    { h: '七、练习' },
    { ol: [
      '给 Dijkstra 增加一个 <code>pre[]</code> 数组记录每个点在最短路上的前驱，从终点回溯打印出完整路径（不只是距离）。',
      '构造一个含负权边的小图，分别用 Dijkstra 和 Bellman-Ford 求解，对比结果，验证 Dijkstra 在负权下确实会算错。',
      '在 Bellman-Ford 里加入负环检测：构造一个带负环的图，确认函数返回「存在负环」。',
      '用 Floyd 求全源最短路后，遍历对角线判断是否存在负环（<code>d[i][i] &lt; 0</code>），并思考为什么点很多时 Floyd 不如「对每个点跑一次 Dijkstra」。'
    ] }
  ]);
})();
