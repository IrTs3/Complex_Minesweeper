(function () {
  'use strict';
  LEARN.register('scc', [
    { lead: '在<strong>有向图</strong>里，如果两个顶点能<em>互相</em>到达，它们就「强连通」。把这种互相可达关系推到极大，就得到<strong>强连通分量（Strongly Connected Component, SCC）</strong>。求 SCC 是分析循环依赖、编译单元、2-SAT 等问题的基础，两种经典算法是 <strong>Tarjan</strong>（一次 DFS）和 <strong>Kosaraju</strong>（两次 DFS）。' },

    { h: '一、什么是强连通分量' },
    { ul: [
      '<strong>强连通</strong>：有向图中若从 u 能到 v、且从 v 也能到 u，则 u、v 强连通。',
      '<strong>强连通分量（SCC）</strong>：一个<em>极大</em>的顶点子集，其中任意两点都强连通。「极大」指不能再往里加任何顶点而保持两两互相可达。',
      '每个 SCC 内部往往由若干环交织而成；单个孤立顶点（无自环）自成一个 SCC。',
      '<strong>缩点（condensation）</strong>：把每个 SCC 收缩成一个超级顶点，原图中跨 SCC 的边保留为超级顶点之间的边。得到的图一定是<strong>有向无环图（DAG）</strong>——因为若缩点后还有环，那个环上的 SCC 本就该合并成一个。'
    ] },
    { p: '缩点后的 DAG 非常适合做<strong>依赖分析</strong>（如模块间调用、课程先修关系）、<strong>DAG 上的动态规划</strong>，以及 <strong>2-SAT</strong> 可满足性判定（每个布尔变量及其取反是顶点，蕴含关系是边；若某变量与它的取反落在同一 SCC 则无解）。' },

    { h: '二、Tarjan：一次 DFS 搞定' },
    { p: 'Tarjan 只做<strong>一次 DFS</strong>，为每个顶点维护两个值：' },
    { ul: [
      '<code>dfn[u]</code>：u 的<strong>访问时间戳</strong>（第几个被 DFS 访问到）。',
      '<code>low[u]</code>：从 u 出发、沿 DFS 树的边再走<em>至多一条</em>指向<strong>栈中顶点</strong>的回退边，所能到达的最小 <code>dfn</code>。'
    ] },
    { p: '遍历时用一个<strong>栈</strong>保存「当前 DFS 路径上、尚未归属任何 SCC」的顶点。递归返回后用子节点更新 <code>low[u] = min(low[u], low[v])</code>；遇到指向<em>栈中</em>顶点的边则 <code>low[u] = min(low[u], dfn[v])</code>。当回溯到某个 u 满足 <code>dfn[u] == low[u]</code> 时，说明 u 是它所在 SCC 在 DFS 树里的<strong>根</strong>——此时把栈中从栈顶直到 u 的所有顶点弹出，它们就构成一个完整的 SCC。整体 <code>O(V+E)</code>。' },

    { h: '三、Kosaraju：两次 DFS' },
    { p: 'Kosaraju 利用一个漂亮的性质：<strong>在反图上按原图的「逆后序」DFS，每棵树恰好是一个 SCC</strong>。步骤：' },
    { ol: [
      '<strong>第一遍</strong>：在<em>原图</em>上做 DFS，记录每个顶点的<strong>完成时间</strong>（后序）。把所有顶点按完成时间从大到小排列，就是「逆后序」。',
      '<strong>构建反图</strong>：把每条边 <code>u→v</code> 反过来成 <code>v→u</code>。',
      '<strong>第二遍</strong>：按逆后序依次取顶点，在<em>反图</em>上对尚未访问的顶点做 DFS，每次 DFS 能到达的所有顶点就是一个 SCC。'
    ] },
    { p: '直觉是：逆后序保证第二遍总是从「源 SCC」（没有入边进来的分量）开始，反图则让这个 SCC 内部的点互相可达而不会泄漏到别的 SCC。复杂度同样是 <code>O(V+E)</code>。' },

    { h: '四、复杂度对照表' },
    { table: {
      head: ['算法', 'DFS 次数', '额外结构', '时间复杂度', '特点'],
      rows: [
        ['Tarjan', '一次（在原图上）', '<code>dfn / low</code> + 一个栈', '<code>O(V+E)</code>', '一趟搞定，还能顺带求割点、桥'],
        ['Kosaraju', '两次（原图 + 反图）', '反图 + 后序序列', '<code>O(V+E)</code>', '思路直观，需显式建反图']
      ]
    } },

    { h: '五、C++ 实现' },
    { p: '<strong>1) Tarjan。</strong>注意三个要点：<code>dfn[u]=low[u]=++timer</code> 在进入时赋值；只有指向<em>栈中</em>顶点的边才用 <code>dfn[v]</code> 更新 <code>low</code>（指向已弹出 SCC 的边要忽略）；<code>dfn[u]==low[u]</code> 时才弹栈成组。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <stack>
using namespace std;

vector<vector<int>> adj;
vector<int> dfn, low, sccId;    // 时间戳 / 可回溯最早 dfn / 所属 SCC 编号
vector<bool> inStack;
stack<int> st;
int timer = 0, sccCount = 0;

void tarjan(int u) {
    dfn[u] = low[u] = ++timer;          // 先自增再赋值，作为初始 dfn/low
    st.push(u); inStack[u] = true;
    for (int v : adj[u]) {
        if (!dfn[v]) {                  // v 未访问：树边，递归后回溯 low
            tarjan(v);
            low[u] = min(low[u], low[v]);
        } else if (inStack[v]) {        // v 在栈中：回退边，用它的 dfn 更新
            low[u] = min(low[u], dfn[v]);
        }
        // v 已访问但不在栈中：属于已弹出的 SCC，忽略
    }
    if (dfn[u] == low[u]) {             // u 是所在 SCC 的根，弹栈到 u 为止
        while (true) {
            int x = st.top(); st.pop(); inStack[x] = false;
            sccId[x] = sccCount;
            if (x == u) break;
        }
        ++sccCount;
    }
}

int main() {
    int n = 7;
    adj.assign(n, vector<int>());
    vector<pair<int,int>> edges = {
        {0,1},{1,2},{2,0},{2,3},{3,4},{4,3},{4,5},{5,6},{6,5}
    };
    for (const pair<int,int>& e : edges) adj[e.first].push_back(e.second);

    dfn.assign(n, 0); low.assign(n, 0);
    sccId.assign(n, -1); inStack.assign(n, false);
    for (int i = 0; i < n; ++i)
        if (!dfn[i]) tarjan(i);

    cout << "强连通分量数 = " << sccCount << '\n';
    for (int c = 0; c < sccCount; ++c) {
        cout << "SCC " << c << ": ";
        for (int i = 0; i < n; ++i) if (sccId[i] == c) cout << i << ' ';
        cout << '\n';
    }
    return 0;
}`, title: 'Tarjan：dfn/low + 栈，一次 DFS 求所有 SCC' },

    { p: '<strong>2) Kosaraju。</strong>第一遍在原图上得到后序序列 <code>order</code>，第二遍按 <code>order</code> 的<em>逆序</em>在反图 <code>radj</code> 上 DFS，每棵树一个 SCC。' },
    { code: String.raw`#include <iostream>
#include <vector>
using namespace std;

vector<vector<int>> adj, radj;  // radj 是 adj 的反图
vector<bool> visited;
vector<int> order;              // 第一遍 DFS 的后序（退出时追加）
vector<int> sccId;

void dfs1(int u) {              // 在原图上跑，记录后序
    visited[u] = true;
    for (int v : adj[u]) if (!visited[v]) dfs1(v);
    order.push_back(u);         // 所有子孙处理完才追加 => 逆后序即 order 的反向
}

void dfs2(int u, int id) {      // 在反图上跑，每棵树一个 SCC
    sccId[u] = id;
    for (int v : radj[u]) if (sccId[v] == -1) dfs2(v, id);
}

int main() {
    int n = 7;
    adj.assign(n, vector<int>()); radj.assign(n, vector<int>());
    vector<pair<int,int>> edges = {
        {0,1},{1,2},{2,0},{2,3},{3,4},{4,3},{4,5},{5,6},{6,5}
    };
    for (const pair<int,int>& e : edges) {
        adj[e.first].push_back(e.second);       // 原图 u->v
        radj[e.second].push_back(e.first);      // 反图 v->u
    }

    visited.assign(n, false);
    for (int i = 0; i < n; ++i) if (!visited[i]) dfs1(i);

    sccId.assign(n, -1);
    int sccCount = 0;
    for (int i = n - 1; i >= 0; --i) {          // 逆后序 = order 从后往前
        int u = order[i];
        if (sccId[u] == -1) { dfs2(u, sccCount); ++sccCount; }
    }

    cout << "强连通分量数 = " << sccCount << '\n';
    for (int c = 0; c < sccCount; ++c) {
        cout << "SCC " << c << ": ";
        for (int i = 0; i < n; ++i) if (sccId[i] == c) cout << i << ' ';
        cout << '\n';
    }
    return 0;
}`, title: 'Kosaraju：原图求逆后序 + 反图二次 DFS' },
    { p: '两段代码跑同一张图，都得到 <code>3</code> 个 SCC：<code>{0,1,2}</code>、<code>{3,4}</code>、<code>{5,6}</code>（分量的输出顺序两种算法可能不同，但划分一致）。' },

    { h: '六、图解：SCC 与缩点后的 DAG' },
    { svg: '<svg viewBox="0 0 640 300" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="左图：有向图用三种底色圈出三个强连通分量；右图：每个分量缩成一个超级顶点后得到一条 A 到 B 到 C 的有向无环链">' +
      '<defs><marker id="scc-arw" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // ---- 左：原图 + SCC 分区底色 ----
      '<rect x="18" y="70" width="190" height="180" rx="16" fill="#eaf1fe" stroke="#2f6feb" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      '<rect x="248" y="80" width="120" height="140" rx="16" fill="#f6e6fa" stroke="#a626a4" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      '<rect x="448" y="80" width="120" height="140" rx="16" fill="#e6f4ea" stroke="#22863a" stroke-width="1.5" stroke-dasharray="5 4"/>' +
      // SCC A 内部边
      '<line x1="75" y1="105" x2="150" y2="92" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '<line x1="160" y1="108" x2="116" y2="190" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '<line x1="92" y1="200" x2="71" y2="122" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      // 跨 SCC：2->3
      '<line x1="118" y1="203" x2="280" y2="128" stroke="#8a94a6" stroke-width="2" stroke-dasharray="6 3" marker-end="url(#scc-arw)"/>' +
      // SCC B 内部边
      '<line x1="296" y1="105" x2="318" y2="185" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '<line x1="302" y1="192" x2="282" y2="115" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      // 跨 SCC：4->5
      '<line x1="326" y1="198" x2="478" y2="116" stroke="#8a94a6" stroke-width="2" stroke-dasharray="6 3" marker-end="url(#scc-arw)"/>' +
      // SCC C 内部边
      '<line x1="496" y1="105" x2="518" y2="185" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '<line x1="502" y1="192" x2="482" y2="115" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      // 顶点
      '<circle cx="70" cy="100" r="15" fill="#ffffff" stroke="#2f6feb" stroke-width="2"/><text x="70" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">0</text>' +
      '<circle cx="160" cy="90" r="15" fill="#ffffff" stroke="#2f6feb" stroke-width="2"/><text x="160" y="95" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">1</text>' +
      '<circle cx="100" cy="205" r="15" fill="#ffffff" stroke="#2f6feb" stroke-width="2"/><text x="100" y="210" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">2</text>' +
      '<circle cx="290" cy="100" r="15" fill="#ffffff" stroke="#a626a4" stroke-width="2"/><text x="290" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">3</text>' +
      '<circle cx="320" cy="190" r="15" fill="#ffffff" stroke="#a626a4" stroke-width="2"/><text x="320" y="195" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">4</text>' +
      '<circle cx="490" cy="100" r="15" fill="#ffffff" stroke="#22863a" stroke-width="2"/><text x="490" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">5</text>' +
      '<circle cx="520" cy="190" r="15" fill="#ffffff" stroke="#22863a" stroke-width="2"/><text x="520" y="195" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">6</text>' +
      // 分区标签
      '<text x="113" y="88" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#2f6feb">SCC A {0,1,2}</text>' +
      '<text x="308" y="98" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">SCC B {3,4}</text>' +
      '<text x="508" y="98" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">SCC C {5,6}</text>' +
      // ---- 下：缩点后的 DAG ----
      '<text x="20" y="272" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">缩点后（DAG）：</text>' +
      '<circle cx="150" cy="278" r="16" fill="#eaf1fe" stroke="#2f6feb" stroke-width="2"/><text x="150" y="283" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">A</text>' +
      '<circle cx="290" cy="278" r="16" fill="#f6e6fa" stroke="#a626a4" stroke-width="2"/><text x="290" y="283" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">B</text>' +
      '<circle cx="430" cy="278" r="16" fill="#e6f4ea" stroke="#22863a" stroke-width="2"/><text x="430" y="283" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">C</text>' +
      '<line x1="166" y1="278" x2="272" y2="278" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '<line x1="306" y1="278" x2="412" y2="278" stroke="#8a94a6" stroke-width="2" marker-end="url(#scc-arw)"/>' +
      '</svg>', cap: '上图：三个强连通分量用不同底色圈出，分量内部双向可达，跨分量只有单向虚线边（2→3、4→5）。下图：把每个 SCC 缩成一个超级顶点后得到 A→B→C，这是一条无环的链——缩点结果必然是 DAG。' },

    { h: '七、常见坑' },
    { callout: '<strong>Tarjan 里只用「栈中顶点」的边更新 <code>low</code>。</strong>遇到已经访问过、但<em>已弹出栈</em>（属于别的、已完成的 SCC）的顶点时，绝不能拿它的 <code>dfn</code> 去更新 <code>low[u]</code>，否则会把两个本应独立的 SCC 错误地合并。', kind: 'warn' },
    { ul: [
      '<strong>Kosaraju 第二遍必须在<em>反图</em>上跑</strong>，且要按第一遍的<em>逆后序</em>取点。用原图或用正序都会得到错误划分。',
      '<strong>后序 vs 逆后序搞反</strong>：第一遍在「退出递归时」追加得到后序；第二遍要从后往前（完成时间大的先）取。',
      '<strong>递归深度爆栈</strong>：Tarjan / Kosaraju 都是 DFS，顶点极多且图接近长链时递归可能过深，必要时改写成显式栈版本。',
      '<strong>缩点后忘记它是 DAG</strong>：缩点的价值就在于得到 DAG，从而可以用拓扑排序 + DP；若缩点后仍出现环，说明 SCC 求错了。'
    ] },

    { h: '八、练习' },
    { ol: [
      '在 Tarjan 求出 <code>sccId[]</code> 后，实现缩点：遍历所有边 <code>u→v</code>，若 <code>sccId[u] != sccId[v]</code> 就在超级顶点间加一条边，得到 DAG 并对它做拓扑排序。',
      '分别用 Tarjan 和 Kosaraju 求同一张图的 SCC，比较两者给出的分量划分是否一致（编号顺序可不同）。',
      '把 Tarjan 改写成显式栈的非递归版本，避免深图爆栈。',
      '用 SCC 解一个 2-SAT 实例：把每个蕴含 <code>a→b</code> 建成边，求 SCC 后检查是否存在某变量与它的取反在同一 SCC，从而判定可满足性。'
    ] }
  ]);
})();
