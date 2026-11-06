(function () {
  'use strict';
  LEARN.register('heap', [
    { lead: '二叉堆是一棵<strong>完全二叉树</strong>，用<strong>数组</strong>就能存下——因为节点排列紧凑、没有空洞。它维护“父节点总是 ≥（或 ≤）子节点”的<strong>堆序性质</strong>，从而在 O(log n) 内插入、O(log n) 内取出最值，是<strong>优先队列</strong>和<strong>堆排序</strong>的核心。' },

    { h: '一、完全二叉树与数组存储' },
    { p: '<strong>完全二叉树</strong>：除最后一层外每层都填满，最后一层的节点都靠左连续排列。正因为没有中间空洞，可以把它<strong>按层序依次铺进数组</strong>，用下标算术代替指针：' },
    { table: {
      head: ['关系', '下标公式（0 起始）'],
      rows: [
        ['节点 <code>i</code> 的父节点', '<code>(i - 1) / 2</code>'],
        ['节点 <code>i</code> 的左孩子', '<code>2 * i + 1</code>'],
        ['节点 <code>i</code> 的右孩子', '<code>2 * i + 2</code>'],
        ['最后一个非叶子节点', '<code>n / 2 - 1</code>']
      ]
    } },
    { p: '<strong>最大堆</strong>：每个父节点的值 ≥ 其孩子，故<strong>堆顶（下标 0）是最大值</strong>。<strong>最小堆</strong>相反，堆顶是最小值。注意堆序只约束父子之间，<strong>兄弟之间、跨子树之间没有全局有序</strong>——堆不是排序好的数组。' },

    { h: '二、上浮与下沉' },
    { ul: [
      '<strong>上浮 sift-up</strong>：新元素放到数组末尾（保持完全二叉树形状），若它比父节点“更该在顶”就与父交换，一路向上，直到堆序恢复。<strong>插入</strong>用它，O(log n)。',
      '<strong>下沉 sift-down</strong>：把某个节点与它<strong>较优的孩子</strong>交换，一路向下，直到不比任何孩子差。<strong>删除堆顶</strong>和<strong>建堆</strong>用它。',
      '<strong>删除堆顶</strong>：用<strong>末尾元素覆盖</strong>堆顶，弹出末尾，再对新堆顶做下沉——O(log n)。'
    ] },
    { p: '<strong>建堆为什么是 O(n) 而不是 O(n log n)？</strong> 从最后一个非叶子节点（<code>n/2-1</code>）倒着往前，对每个节点做下沉。越靠下的节点越多但下沉距离越短，级数求和后总代价是 O(n)。' },

    { h: '三、复杂度对照表' },
    { table: {
      head: ['操作', '复杂度', '说明'],
      rows: [
        ['取堆顶 <code>top()</code>', 'O(1)', '最值就在 <code>a[0]</code>'],
        ['插入 <code>push()</code>', 'O(log n)', '末尾放入 + 上浮'],
        ['删除堆顶 <code>pop()</code>', 'O(log n)', '末尾覆盖堆顶 + 下沉'],
        ['建堆（n 个元素）', '<strong>O(n)</strong>', '自底向上逐个下沉'],
        ['堆排序', 'O(n log n)', '建堆 O(n) + n 次取顶 O(log n)'],
        ['按下标访问任意元素', 'O(1)', '数组天然支持（但堆不保证有序）']
      ]
    } },

    { h: '四、C++ 实现：手写二叉堆 + 堆排序' },
    { p: '下面实现一个<strong>最小堆</strong>：包含 <code>siftUp</code>、<code>siftDown</code>、O(n) 建堆、O(log n) 插入与删顶；再给出用<strong>最大堆</strong>做升序<strong>堆排序</strong>的独立函数。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <algorithm>

class MinHeap {
    std::vector<int> a;

    void siftUp(int i) {                       // 上浮：与父比较
        while (i > 0) {
            int parent = (i - 1) / 2;
            if (a[i] >= a[parent]) break;      // 已满足最小堆序
            std::swap(a[i], a[parent]);
            i = parent;
        }
    }

    void siftDown(int i) {                      // 下沉：与较小的孩子比较
        int n = static_cast<int>(a.size());
        while (true) {
            int smallest = i, l = 2 * i + 1, r = 2 * i + 2;
            if (l < n && a[l] < a[smallest]) smallest = l;
            if (r < n && a[r] < a[smallest]) smallest = r;
            if (smallest == i) break;
            std::swap(a[i], a[smallest]);
            i = smallest;
        }
    }

public:
    MinHeap() = default;

    explicit MinHeap(const std::vector<int>& v) : a(v) {   // O(n) 建堆
        for (int i = static_cast<int>(a.size()) / 2 - 1; i >= 0; --i)
            siftDown(i);
    }

    void push(int x) {                                      // O(log n)
        a.push_back(x);
        siftUp(static_cast<int>(a.size()) - 1);
    }
    int  top()   const { return a.front(); }
    bool empty() const { return a.empty(); }
    std::size_t size() const { return a.size(); }

    void pop() {                                            // O(log n)
        a.front() = a.back();          // 末尾覆盖堆顶
        a.pop_back();                  // 去掉末尾
        if (!a.empty()) siftDown(0);   // 新堆顶下沉
    }
};

// 下沉（最大堆版），只在区间 [0, n) 内操作，供堆排序复用
static void siftDownMax(std::vector<int>& a, int i, int n) {
    while (true) {
        int largest = i, l = 2 * i + 1, r = 2 * i + 2;
        if (l < n && a[l] > a[largest]) largest = l;
        if (r < n && a[r] > a[largest]) largest = r;
        if (largest == i) break;
        std::swap(a[i], a[largest]);
        i = largest;
    }
}

static void heapSort(std::vector<int>& a) {   // 升序：用最大堆
    int n = static_cast<int>(a.size());
    for (int i = n / 2 - 1; i >= 0; --i)       // 建最大堆 O(n)
        siftDownMax(a, i, n);
    for (int i = n - 1; i > 0; --i) {          // 反复把最大值换到末尾
        std::swap(a[0], a[i]);
        siftDownMax(a, 0, i);                  // 堆区间缩为 [0, i)
    }
}

int main() {
    MinHeap h(std::vector<int>{5, 3, 8, 1, 9, 2});   // O(n) 建堆
    while (!h.empty()) { std::cout << h.top() << " "; h.pop(); }
    std::cout << "\n";                               // 1 2 3 5 8 9

    std::vector<int> a{5, 3, 8, 1, 9, 2};
    heapSort(a);
    for (int x : a) std::cout << x << " ";
    std::cout << "\n";                               // 1 2 3 5 8 9
    return 0;
}`, lang: 'cpp', title: '最小堆 siftUp/siftDown/建堆 + 堆排序（C++17）' },
    { p: '注意 <code>pop()</code> 里的顺序：先 <code>a.front() = a.back()</code> 再 <code>pop_back()</code>，最后<strong>只在堆非空时</strong>下沉——否则对空堆调用 <code>siftDown(0)</code> 会越界。' },

    { h: '五、std::priority_queue 与 top-k' },
    { p: '标准库的 <code>std::priority_queue</code> 就是二叉堆的封装（底层默认 <code>std::vector</code>）。它<strong>默认是最大堆</strong>；要最小堆，把第三个模板参数换成 <code>std::greater&lt;T&gt;</code>。经典应用是 <strong>top-k</strong>：维护一个容量为 k 的<strong>小顶堆</strong>求最大的 k 个（或大顶堆求最小的 k 个）。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <queue>
#include <functional>     // std::greater

// 找出最大的 k 个：维护容量为 k 的小顶堆，堆顶是"当前第 k 大"
std::vector<int> topKLargest(const std::vector<int>& nums, int k) {
    if (k <= 0) return {};
    std::priority_queue<int, std::vector<int>, std::greater<int>> minHeap;
    for (int x : nums) {
        if (static_cast<int>(minHeap.size()) < k) {
            minHeap.push(x);                 // 堆未满，直接放
        } else if (x > minHeap.top()) {      // 比堆里最小的还大，才替换
            minHeap.pop();
            minHeap.push(x);
        }
    }
    std::vector<int> res;
    while (!minHeap.empty()) { res.push_back(minHeap.top()); minHeap.pop(); }
    return res;                              // 升序排列的最大 k 个
}

int main() {
    std::priority_queue<int> maxHeap;        // 默认：大顶堆
    for (int x : {3, 1, 4}) maxHeap.push(x);
    std::cout << maxHeap.top() << "\n";      // 4

    std::priority_queue<int, std::vector<int>, std::greater<int>> minHeap; // 小顶堆
    for (int x : {3, 1, 4}) minHeap.push(x);
    std::cout << minHeap.top() << "\n";      // 1

    for (int x : topKLargest({5, 2, 9, 1, 7, 3}, 3)) std::cout << x << " ";
    std::cout << "\n";                       // 5 7 9
    return 0;
}`, lang: 'cpp', title: 'priority_queue 大顶/小顶 与 top-k（C++17）' },

    { h: '六、图解：树形结构 ↔ 数组下标' },
    { p: '下面是<strong>同一个最大堆</strong>的两种视图：上方是逻辑上的完全二叉树，下方是它的物理存储——一个数组。每个节点里标了值与下标，数组下方标了下标，两者靠下标一一对应。' },
    { svg: '<svg viewBox="0 0 720 430" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="最大堆的完全二叉树结构与数组下标映射">' +
      '<text x="360" y="24" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">最大堆：每个父节点 ≥ 子节点，堆顶最大</text>' +
      '<g stroke="#8a94a6" stroke-width="1.6">' +
      '<line x1="360" y1="58" x2="220" y2="150"/>' +
      '<line x1="360" y1="58" x2="500" y2="150"/>' +
      '<line x1="220" y1="150" x2="140" y2="242"/>' +
      '<line x1="220" y1="150" x2="300" y2="242"/>' +
      '<line x1="500" y1="150" x2="440" y2="242"/>' +
      '</g>' +
      '<g fill="#eaf1fe" stroke="#2f6feb" stroke-width="1.6">' +
      '<circle cx="220" cy="150" r="24"/><circle cx="500" cy="150" r="24"/>' +
      '<circle cx="140" cy="242" r="24"/><circle cx="300" cy="242" r="24"/><circle cx="440" cy="242" r="24"/>' +
      '</g>' +
      '<circle cx="360" cy="58" r="26" fill="#f3e6f3" stroke="#a626a4" stroke-width="1.8"/>' +
      '<g font-family="system-ui, sans-serif" text-anchor="middle">' +
      '<text x="360" y="58" font-size="15" fill="#a626a4">9</text>' +
      '<text x="360" y="73" font-size="10" fill="#8a94a6">i=0</text>' +
      '<text x="220" y="150" font-size="15" fill="#1f2933">7</text>' +
      '<text x="220" y="165" font-size="10" fill="#8a94a6">i=1</text>' +
      '<text x="500" y="150" font-size="15" fill="#1f2933">8</text>' +
      '<text x="500" y="165" font-size="10" fill="#8a94a6">i=2</text>' +
      '<text x="140" y="242" font-size="15" fill="#1f2933">3</text>' +
      '<text x="140" y="257" font-size="10" fill="#8a94a6">i=3</text>' +
      '<text x="300" y="242" font-size="15" fill="#1f2933">5</text>' +
      '<text x="300" y="257" font-size="10" fill="#8a94a6">i=4</text>' +
      '<text x="440" y="242" font-size="15" fill="#1f2933">6</text>' +
      '<text x="440" y="257" font-size="10" fill="#8a94a6">i=5</text>' +
      '</g>' +
      '<text x="360" y="304" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">↓ 层序铺进数组（物理存储）</text>' +
      '<g fill="#eaf1fe" stroke="#2f6feb" stroke-width="1.5">' +
      '<rect x="150" y="316" width="70" height="46" fill="#f3e6f3" stroke="#a626a4"/>' +
      '<rect x="220" y="316" width="70" height="46"/>' +
      '<rect x="290" y="316" width="70" height="46"/>' +
      '<rect x="360" y="316" width="70" height="46"/>' +
      '<rect x="430" y="316" width="70" height="46"/>' +
      '<rect x="500" y="316" width="70" height="46"/>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="15" fill="#1f2933" text-anchor="middle">' +
      '<text x="185" y="345" fill="#a626a4">9</text><text x="255" y="345">7</text><text x="325" y="345">8</text>' +
      '<text x="395" y="345">3</text><text x="465" y="345">5</text><text x="535" y="345">6</text>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6" text-anchor="middle">' +
      '<text x="185" y="378">0</text><text x="255" y="378">1</text><text x="325" y="378">2</text>' +
      '<text x="395" y="378">3</text><text x="465" y="378">4</text><text x="535" y="378">5</text>' +
      '</g>' +
      '<text x="360" y="404" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">父 = (i-1)/2 ，左子 = 2i+1 ，右子 = 2i+2</text>' +
      '<text x="360" y="422" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">例：i=2 的父 = (2-1)/2 = 0（值 9），左子 = 5（值 6）</text>' +
      '</svg>', cap: '同一最大堆：树是逻辑结构，数组是物理存储，靠下标公式互相定位。' },

    { h: '七、常见坑' },
    { callout: '<strong>堆顶弹出后要重新下沉，而不是直接排序整个数组</strong>：<code>pop()</code> 用末尾元素覆盖堆顶后，必须对新堆顶 <code>siftDown(0)</code>；且只在<strong>堆非空</strong>时下沉，否则空堆会越界。', kind: 'warn' },
    { ul: [
      '<strong>堆 ≠ 有序</strong>：数组里只有父子满足堆序，兄弟、跨子树之间无序。想要有序输出得反复 <code>pop</code> 或做堆排序。',
      '<strong>建堆从 <code>n/2-1</code> 开始</strong>：叶子节点无需下沉；从最后一个非叶子倒着往前，才是 O(n)。若从 0 正着来或对所有节点下沉，会退化到 O(n log n)。',
      '<strong>priority_queue 默认是大顶堆</strong>：很多人以为默认最小堆。要最小堆必须写全 <code>std::priority_queue&lt;T, std::vector&lt;T&gt;, std::greater&lt;T&gt;&gt;</code>（三个模板参数都不能省）。',
      '<strong>top-k 用“反向堆”</strong>：求最大的 k 个要用<strong>小顶堆</strong>（堆顶是当前第 k 大，便于淘汰最小的）；求最小的 k 个则用大顶堆。别搞反。',
      '<strong>下标溢出</strong>：<code>2*i+1</code>、<code>2*i+2</code> 在 i 较大时可能超过 int 范围；元素极多时改用 <code>size_t</code> 或先判 <code>l &lt; n</code> 再访问。'
    ] },

    { h: '八、练习' },
    { ol: [
      '把上面的 <code>MinHeap</code> 改成<strong>最大堆</strong>（比较符号取反），并用它对一个数组做“每次取最大”的降序输出。',
      '实现 <code>void remove(int i)</code>：删除堆中<strong>任意下标</strong> i 的元素（提示：先把 <code>a[i]</code> 改成极值触发上浮到顶，或直接覆盖后视情况上浮/下沉）。',
      '用 <code>std::priority_queue</code> 合并 k 个有序链表 / 有序数组为一个有序序列，分析复杂度为何是 O(N log k)。',
      '证明或实验验证：对 n 个随机数调用“逐个 <code>push</code> 建堆”是 O(n log n)，而“数组一次性 heapify”是 O(n)——分别计时对比。'
    ] }
  ]);
})();
