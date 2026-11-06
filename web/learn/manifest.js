/* 全站清单：分组 + 16 篇文章的元数据。
 * app.js 用它构建左侧目录树；search.js 用它做客户端搜索；页面正文在 pages/<id>.js 里懒加载。
 * 加文章只需：这里加一条 + 建对应的 pages/<id>.js。
 */
window.LEARN_MANIFEST = {
  site: {
    title: 'C++ 数据结构与算法图解',
    tagline: '面向初学者的图文教程：每篇都有概念讲解、复杂度对照表、可直接复制的 C++ 代码，以及手绘 SVG 图解。'
  },

  groups: [
    { id: 'cpp-basic',  name: 'C++ 语言基础' },
    { id: 'cpp-modern', name: 'C++ 现代特性' },
    { id: 'linear',     name: '线性结构' },
    { id: 'tree',       name: '树与二叉堆' },
    { id: 'advanced',   name: '高级数据结构' },
    { id: 'graph',      name: '图论' }
  ],

  articles: [
    // ---- C++ 语言基础 ----
    { id: 'cpp-build', group: 'cpp-basic', order: 1, file: 'pages/cpp-build.js', diagram: false,
      title: '从源码到可执行文件：C++ 构建四阶段',
      keywords: ['编译', '链接', '预处理', '构建', '头文件', '翻译单元', 'g++', 'clang', 'compile', 'link', 'object file', 'ODR', '声明', '定义', 'undefined reference'] },
    { id: 'stl-containers', group: 'cpp-basic', order: 2, file: 'pages/stl-containers.js', diagram: true,
      title: 'STL 容器全景：vector / list / map / unordered_map 怎么选',
      keywords: ['STL', '容器', 'vector', 'list', 'deque', 'map', 'set', 'unordered_map', '哈希表', '红黑树', '复杂度', 'push_back', 'emplace', '选型'] },
    { id: 'stl-iterators', group: 'cpp-basic', order: 3, file: 'pages/stl-iterators.js', diagram: false,
      title: '迭代器与范围：STL 的通用胶水',
      keywords: ['迭代器', 'iterator', 'begin', 'end', '范围', 'range', '算法', 'std::sort', 'std::find', '失效', 'invalidate', '输入迭代器', '随机访问'] },

    // ---- C++ 现代特性 ----
    { id: 'templates', group: 'cpp-modern', order: 1, file: 'pages/templates.js', diagram: false,
      title: '模板入门：函数模板、类模板与实例化',
      keywords: ['模板', 'template', '泛型', '函数模板', '类模板', '实例化', 'typename', 'auto', '类型推导', 'generic', 'SFINAE', 'concept'] },
    { id: 'smart-pointers', group: 'cpp-modern', order: 2, file: 'pages/smart-pointers.js', diagram: true,
      title: '智能指针与 RAII：unique_ptr / shared_ptr',
      keywords: ['智能指针', 'unique_ptr', 'shared_ptr', 'weak_ptr', 'RAII', '内存泄漏', '所有权', '引用计数', 'new', 'delete', '循环引用', 'make_unique', 'make_shared'] },

    // ---- 线性结构 ----
    { id: 'array-linked', group: 'linear', order: 1, file: 'pages/array-linked.js', diagram: true,
      title: '数组 vs 链表：内存布局如何决定性能',
      keywords: ['数组', '链表', 'array', 'linked list', '连续内存', '缓存', 'cache', '随机访问', '插入', '删除', '复杂度', '单链表', '双链表'] },
    { id: 'stack-queue', group: 'linear', order: 2, file: 'pages/stack-queue.js', diagram: true,
      title: '栈与队列：LIFO / FIFO 与单调栈',
      keywords: ['栈', '队列', 'stack', 'queue', 'LIFO', 'FIFO', '双端队列', 'deque', '单调栈', '括号匹配', '表达式', 'BFS', '循环队列'] },

    // ---- 树与二叉堆 ----
    { id: 'tree-bst', group: 'tree', order: 1, file: 'pages/tree-bst.js', diagram: true,
      title: '二叉搜索树：查找、插入、删除与遍历',
      keywords: ['二叉搜索树', 'BST', '二叉树', '中序遍历', '前序', '后序', '查找', '插入', '删除', '有序', '平衡', '退化', '递归'] },
    { id: 'heap', group: 'tree', order: 2, file: 'pages/heap.js', diagram: true,
      title: '二叉堆与优先队列：上浮、下沉与堆排序',
      keywords: ['堆', '二叉堆', '优先队列', 'priority_queue', 'heap', '上浮', '下沉', 'sift up', 'sift down', '堆排序', '最大堆', '最小堆', 'top-k'] },

    // ---- 高级数据结构 ----
    { id: 'segment-tree', group: 'advanced', order: 1, file: 'pages/segment-tree.js', diagram: true,
      title: '线段树：区间查询与懒标记修改',
      keywords: ['线段树', 'segment tree', '区间', '查询', '修改', '懒标记', 'lazy propagation', '求和', '最值', 'RMQ', '分治', 'build', 'update', 'query'] },
    { id: 'bit', group: 'advanced', order: 2, file: 'pages/bit.js', diagram: true,
      title: '树状数组（BIT）：单点修改与前缀查询',
      keywords: ['树状数组', 'BIT', 'Fenwick', '前缀和', '单点修改', '区间查询', 'lowbit', '逆序对', '树形结构'] },
    { id: 'dsu', group: 'advanced', order: 3, file: 'pages/dsu.js', diagram: true,
      title: '并查集：路径压缩与按秩合并',
      keywords: ['并查集', 'DSU', 'union find', 'disjoint set', '路径压缩', '按秩合并', '连通', '集合', 'find', 'unite', 'Kruskal', '近似常数'] },

    // ---- 图论 ----
    { id: 'graph-traversal', group: 'graph', order: 1, file: 'pages/graph-traversal.js', diagram: true,
      title: '图的存储与 DFS / BFS 遍历',
      keywords: ['图', 'graph', '邻接表', '邻接矩阵', 'DFS', 'BFS', '深度优先', '广度优先', '遍历', '连通块', 'visited', '队列', '递归', '有向图', '无向图'] },
    { id: 'shortest-path', group: 'graph', order: 2, file: 'pages/shortest-path.js', diagram: true,
      title: '最短路径：Dijkstra、Bellman-Ford 与 Floyd',
      keywords: ['最短路径', 'Dijkstra', '迪杰斯特拉', 'Bellman-Ford', 'Floyd', '单源', '多源', '松弛', 'relax', '优先队列', '负权边', '堆优化', 'SSSP'] },
    { id: 'mst', group: 'graph', order: 3, file: 'pages/mst.js', diagram: true,
      title: '最小生成树：Kruskal 与 Prim',
      keywords: ['最小生成树', 'MST', 'Kruskal', 'Prim', '并查集', '贪心', '边排序', '连通', '无向图', '权重', '生成树'] },
    { id: 'scc', group: 'graph', order: 4, file: 'pages/scc.js', diagram: true,
      title: '强连通分量：Tarjan 与 Kosaraju',
      keywords: ['强连通分量', 'SCC', 'Tarjan', 'Kosaraju', '有向图', '缩点', 'low', 'dfn', '栈', '拓扑', 'condensation', '割点'] }
  ]
};
