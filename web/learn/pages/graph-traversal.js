(function () {
  'use strict';
  LEARN.register('graph-traversal', [
    { lead: '图（graph）由<strong>顶点</strong>和连接顶点的<strong>边</strong>组成，是描述「多对多」关系的通用模型：社交网络、路网、依赖关系都能抽象成图。要在图上做任何事，第一步永远是<em>把它存进内存</em>，第二步才是<em>系统地走遍它</em>。本篇讲两种主流存储方式，以及两种最基本的遍历——<strong>DFS（深度优先）</strong>与 <strong>BFS（广度优先）</strong>。' },

    { h: '一、图的基本概念' },
    { ul: [
      '<strong>有向图 / 无向图</strong>：边若有序（<code>u→v</code> 不等于 <code>v→u</code>）就是有向图；边无序（<code>u—v</code> 双向等价）就是无向图。',
      '<strong>带权图</strong>：每条边附带一个权值（距离、费用、容量）。无权图可视为所有边权都为 1 的特例。',
      '<strong>度（degree）</strong>：一个顶点关联的边数。有向图还区分<strong>入度</strong>（指向它的边数）与<strong>出度</strong>（从它出发的边数）。',
      '<strong>路径与连通</strong>：顶点序列 <code>u→…→v</code> 称为一条路径；无向图中若任意两点都互相可达，则图是<strong>连通</strong>的，极大连通子图称为一个<strong>连通块</strong>。'
    ] },

    { h: '二、两种存储方式：邻接矩阵 vs 邻接表' },
    { p: '<strong>邻接矩阵</strong>用一个 <code>V×V</code> 的二维数组 <code>g[u][v]</code> 表示图：有边则存权值（无权存 1），无边存一个特殊值（如 <code>0</code> 或 <code>INF</code>）。它查「u、v 之间是否有边」是 <code>O(1)</code>，但空间恒为 <code>O(V²)</code>，边很少时大量空间被浪费，适合<strong>稠密图</strong>。' },
    { p: '<strong>邻接表</strong>为每个顶点挂一条链表（C++ 里最常用 <code>vector&lt;vector&lt;int&gt;&gt;</code>）：<code>adj[u]</code> 存放 u 的所有邻居。空间只与边数相关，是 <code>O(V+E)</code>，遍历某点的所有邻居也只需 <code>O(deg(u))</code>，是<strong>稀疏图</strong>的首选，也是竞赛与工程中最常见的写法。带权时把邻居类型换成 <code>pair&lt;int,int&gt;</code>（邻居, 权）即可。' },
    { p: '无论有向无向，建表逻辑一致：无向边 <code>u—v</code> 要在 <code>adj[u]</code> 和 <code>adj[v]</code> 里<em>各加一次</em>；有向边 <code>u→v</code> 只加进 <code>adj[u]</code>。' },

    { h: '三、复杂度对照表' },
    { table: {
      head: ['维度', '邻接矩阵 <code>g[u][v]</code>', '邻接表 <code>vector&lt;vector&lt;int&gt;&gt;</code>'],
      rows: [
        ['空间复杂度', '<code>O(V²)</code>', '<code>O(V + E)</code>'],
        ['判断 u、v 是否相邻', '<code>O(1)</code>', '<code>O(deg(u))</code>，需扫描整条链表'],
        ['遍历 u 的所有邻居', '<code>O(V)</code>', '<code>O(deg(u))</code>'],
        ['新增一条边', '<code>O(1)</code>', '<code>O(1)</code> 均摊（尾部追加）'],
        ['DFS / BFS 整体耗时', '<code>O(V²)</code>', '<code>O(V + E)</code>'],
        ['适合场景', '稠密图、需频繁 O(1) 查边', '稀疏图（<code>E ≪ V²</code>），最常用']
      ]
    } },

    { h: '四、DFS 与 BFS' },
    { p: '<strong>DFS（深度优先搜索）</strong>沿着一条路走到底，走不动了再回溯换一条路。它天然对应<strong>递归</strong>：访问 u，标记 <code>visited[u]</code>，再对 u 的每个未访问邻居递归。递归本质是借用系统调用栈，因此也可用<strong>显式栈</strong>手工实现——当图很深（例如一条长链）时，显式栈能避免递归爆栈。' },
    { p: '<strong>BFS（广度优先搜索）</strong>用<strong>队列</strong>实现：先把起点入队，每次出队一个点、访问它、再把它所有未访问邻居入队。它像水波一样<em>一圈一圈</em>向外扩散，因此在<strong>无权图</strong>上，BFS 第一次到达某点时经过的边数就是从起点到它的<strong>最短步数</strong>；记录每个点的层号即可做<strong>层序遍历</strong>。' },
    { callout: '两种遍历都必须用 <code>visited</code> 标记（BFS 里常用 <code>dist[]</code> 是否被赋值来兼任）来防止重复访问，否则图中有环时会陷入死循环。这是图遍历区别于树遍历的关键——树无环，图有环。', kind: 'tip' },

    { h: '五、C++ 实现' },
    { p: '下面是一个完整可编译的程序，用邻接表存储一张含孤立点的无向图，分别演示递归 DFS、显式栈 DFS、求无权最短步数的 BFS，以及连通块计数。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <queue>
#include <stack>
using namespace std;

int n;                          // 顶点数，编号 0..n-1
vector<vector<int>> adj;        // 邻接表：adj[u] 存 u 的所有邻居

void addEdge(int u, int v) {    // 无向边：两个方向各加一次；有向边只加 adj[u]
    adj[u].push_back(v);
    adj[v].push_back(u);
}

// ---- DFS 递归版：借系统调用栈 ----
void dfsRec(int u, vector<bool>& vis) {
    vis[u] = true;
    cout << u << ' ';
    for (int v : adj[u])
        if (!vis[v]) dfsRec(v, vis);
}

// ---- DFS 显式栈版：等价于递归，但不会因图太深而爆栈 ----
void dfsStack(int s, vector<bool>& vis) {
    stack<int> st;
    st.push(s);
    vis[s] = true;              // 关键：入栈时就标记，避免同一点被重复压入
    while (!st.empty()) {
        int u = st.top(); st.pop();
        cout << u << ' ';
        for (int v : adj[u])
            if (!vis[v]) {
                vis[v] = true;  // 必须在压栈前标记
                st.push(v);
            }
    }
}

// ---- BFS：返回从 s 出发到各点的最短步数（-1 表示不可达） ----
vector<int> bfs(int s) {
    vector<int> dist(n, -1);    // dist 兼作 visited 标记
    queue<int> q;
    dist[s] = 0;
    q.push(s);
    while (!q.empty()) {
        int u = q.front(); q.pop();
        for (int v : adj[u])
            if (dist[v] == -1) {// 未访问
                dist[v] = dist[u] + 1;
                q.push(v);
            }
    }
    return dist;
}

// ---- 连通块计数：对每个未访问点启动一次「静默」DFS（用显式栈，不打印） ----
int countComponents() {
    vector<bool> vis(n, false);
    int cnt = 0;
    for (int i = 0; i < n; ++i) {
        if (vis[i]) continue;
        ++cnt;                          // 发现一个新的连通块
        stack<int> st; st.push(i); vis[i] = true;
        while (!st.empty()) {
            int u = st.top(); st.pop();
            for (int v : adj[u])
                if (!vis[v]) { vis[v] = true; st.push(v); }
        }
    }
    return cnt;
}

int main() {
    n = 7;
    adj.assign(n, {});          // 7 个顶点，编号 0..6
    addEdge(0,1); addEdge(0,2);
    addEdge(1,3); addEdge(2,4);
    addEdge(3,5); addEdge(4,5);
    // 顶点 6 是孤立点，自成一个连通块

    vector<bool> vis(n, false);
    cout << "DFS(rec)   from 0: "; dfsRec(0, vis);   cout << '\n';
    vis.assign(n, false);
    cout << "DFS(stack) from 0: "; dfsStack(0, vis); cout << '\n';

    vector<int> dist = bfs(0);
    cout << "BFS dist   from 0: ";
    for (int i = 0; i < n; ++i) cout << dist[i] << ' ';
    cout << '\n';

    cout << "连通块数量: " << countComponents() << '\n';
    return 0;
}`, title: '邻接表 + DFS（递归/显式栈）+ BFS + 连通块计数' },
    { p: '上面这张图的递归 DFS 从 0 出发访问顺序是 <code>0 1 3 5 4 2</code>，而显式栈 DFS 得到的是 <code>0 2 4 5 3 1</code>——两者都合法，只是邻居入栈次序不同导致访问顺序不同。BFS 从 0 出发的最短步数是 <code>0 1 1 2 2 3 -1</code>（顶点 6 不可达），连通块数量为 <code>2</code>（{0,1,2,3,4,5} 与 {6}）。' },

    { h: '六、图解：一次 DFS 的访问顺序' },
    { svg: '<svg viewBox="0 0 620 240" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一张 7 顶点的无向图，节点上标出从 0 出发的递归 DFS 访问序号，顶点 6 是孤立点未被访问">' +
      '<defs><marker id="gt-arw" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // 边（先画线，再画圆盖住线端）
      '<line x1="80" y1="70" x2="190" y2="40" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="80" y1="70" x2="190" y2="140" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="190" y1="40" x2="310" y2="40" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="190" y1="140" x2="310" y2="170" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="310" y1="40" x2="420" y2="100" stroke="#8a94a6" stroke-width="2"/>' +
      '<line x1="310" y1="170" x2="420" y2="100" stroke="#8a94a6" stroke-width="2"/>' +
      // 顶点
      '<circle cx="80" cy="70" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="80" y="75" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">0</text>' +
      '<circle cx="190" cy="40" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="190" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">1</text>' +
      '<circle cx="190" cy="140" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="190" y="145" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">2</text>' +
      '<circle cx="310" cy="40" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="310" y="45" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">3</text>' +
      '<circle cx="310" cy="170" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="310" y="175" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">4</text>' +
      '<circle cx="420" cy="100" r="20" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/>' +
      '<text x="420" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">5</text>' +
      '<circle cx="545" cy="180" r="20" fill="#eaf1fe" stroke="#8a94a6" stroke-width="2" stroke-dasharray="4 3"/>' +
      '<text x="545" y="185" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#8a94a6">6</text>' +
      // DFS 访问序号徽标（从 0 出发的递归 DFS）
      '<circle cx="95" cy="56" r="10" fill="#a626a4"/><text x="95" y="60" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">1</text>' +
      '<circle cx="205" cy="26" r="10" fill="#a626a4"/><text x="205" y="30" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">2</text>' +
      '<circle cx="325" cy="26" r="10" fill="#a626a4"/><text x="325" y="30" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">3</text>' +
      '<circle cx="435" cy="86" r="10" fill="#a626a4"/><text x="435" y="90" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">4</text>' +
      '<circle cx="325" cy="156" r="10" fill="#a626a4"/><text x="325" y="160" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">5</text>' +
      '<circle cx="205" cy="126" r="10" fill="#a626a4"/><text x="205" y="130" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#ffffff">6</text>' +
      // 图例
      '<text x="20" y="225" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">紫色序号 = 从 0 出发的递归 DFS 访问顺序：0→1→3→5→4→2</text>' +
      '<text x="470" y="225" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">6：孤立点，未访问</text>' +
      '</svg>', cap: '同一张图上，DFS 深入到底再回溯（序号 1~6）；若改用 BFS，则会按到 0 的距离分层：{0} → {1,2} → {3,4} → {5}，顶点 6 始终不可达。' },

    { h: '七、常见坑' },
    { callout: '<strong>忘记标记 <code>visited</code> 或标记时机不对</strong>是最常见的错误。递归 DFS 要在进入函数时就标记；显式栈 DFS 要在<em>压栈时</em>而非<em>出栈时</em>标记，否则同一点可能被多次压入，既变慢又可能死循环。', kind: 'warn' },
    { ul: [
      '<strong>混淆有向/无向建边</strong>：无向边要双向各加一次，只加一次会导致图「断裂」，遍历漏点。',
      '<strong>用邻接表却按 <code>O(V²)</code> 思路写</strong>：遍历邻居应直接扫 <code>adj[u]</code>，不要去循环所有顶点判断是否相邻，那会退化成矩阵的复杂度。',
      '<strong>递归 DFS 在链状大图上爆栈</strong>：当 <code>V</code> 很大且图接近一条长链时，递归深度可达 <code>O(V)</code>，应改用显式栈版本。',
      '<strong>用 BFS 求带权图最短路</strong>：BFS 的「最短步数」只对<em>无权图</em>（或边权全相等）成立；带权图要用 Dijkstra 等算法（见「最短路径」篇）。'
    ] },

    { h: '八、练习' },
    { ol: [
      '把示例代码的邻接表改成邻接矩阵存储，重写 DFS 与 BFS，验证遍历结果一致，并体会两种存储在「查边」和「扫邻居」上的复杂度差异。',
      '用 BFS 求无权图中从起点 <code>s</code> 到终点 <code>t</code> 的最短步数，并额外用一个 <code>pre[]</code> 数组记录前驱，倒推出这条最短路径本身。',
      '实现连通块计数后，进一步给每个顶点标注它所属连通块的编号（<code>comp[u]</code>），并统计每块的大小。',
      '把递归 DFS 改成显式栈版本，故意让邻居按<em>逆序</em>入栈，观察能否让访问顺序与递归版完全一致。'
    ] }
  ]);
})();
