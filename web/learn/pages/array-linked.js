(function () {
  'use strict';
  LEARN.register('array-linked', [
    { lead: '数组和链表是两种最基础的线性结构。它们能存同样一串元素，但因为<strong>内存布局</strong>截然不同，随机访问、插入、删除的性能天差地别。理解“数据在内存里怎么摆”，才能在对的场合选对的结构。' },

    { h: '一、数组：连续内存与 O(1) 随机访问' },
    { p: '数组把元素一块挨一块地放在<strong>连续的内存</strong>里。只要知道首地址和每个元素的大小，第 <code>i</code> 个元素的地址就能一次算出来：<code>addr = base + i * sizeof(T)</code>。这就是<strong>随机访问 O(1)</strong> 的来源——不用从头走，直接跳到目标位置。' },
    { p: '连续布局还带来一个隐性好处：<strong>缓存友好</strong>。CPU 按“缓存行”（通常 64 字节）成块地把内存搬进高速缓存，顺序遍历数组时，一次搬运就能覆盖随后要用的多个元素，命中率极高。' },
    { ul: [
      '<strong>优点</strong>：随机访问 O(1)；缓存友好；无额外指针开销；<code>std::vector</code> 尾部均摊 O(1) 追加。',
      '<strong>缺点</strong>：中间插入/删除要搬移后续所有元素，O(n)；容量固定（<code>vector</code> 扩容需重新分配并整体拷贝）。'
    ] },

    { h: '二、链表：分散节点与指针串联' },
    { p: '链表的每个元素被包在一个<strong>节点</strong>里，节点除了数据还存一个（或两个）指向相邻节点的<strong>指针</strong>。节点在内存中可以<strong>任意分散</strong>，靠指针把它们串成一条链。' },
    { p: '因为节点不相邻，要访问第 <code>i</code> 个元素必须从头指针开始<strong>逐个跳</strong>，这是 O(n)。但如果你<strong>已经握有某个节点的指针</strong>，在它旁边插入或删除只需改几个指针，是 O(1)——代价是“找到那个位置”本身要 O(n)。' },
    { ul: [
      '<strong>优点</strong>：已知位置时插入/删除 O(1)；无需连续大块内存；长度动态增长无需整体搬移。',
      '<strong>缺点</strong>：随机访问 O(n)；每个节点多存指针，内存开销大；节点分散导致<strong>缓存不友好</strong>，遍历常数更大。'
    ] },
    { p: '单链表每个节点只有一个 <code>next</code> 指针；双链表（<code>std::list</code>）额外有 <code>prev</code> 指针，因而能 O(1) 地反向移动、也能 O(1) 删除“已持有的”任意节点。' },

    { h: '三、复杂度对照表' },
    { table: {
      head: ['操作', '数组 / <code>vector</code>', '单链表', '双链表 <code>list</code>'],
      rows: [
        ['按下标随机访问 <code>a[i]</code>', '<strong>O(1)</strong>', 'O(n)', 'O(n)'],
        ['头部插入 / 删除', 'O(n)（整体后移）', '<strong>O(1)</strong>', '<strong>O(1)</strong>'],
        ['尾部插入', '均摊 <strong>O(1)</strong>', 'O(n)（需走到尾）*', 'O(1)（保存尾指针时）'],
        ['<em>已知位置</em>处插入 / 删除', 'O(n)（搬移元素）', '<strong>O(1)</strong>', '<strong>O(1)</strong>'],
        ['查找某个值', 'O(n)（无序时）', 'O(n)', 'O(n)'],
        ['缓存局部性', '好', '差', '差'],
        ['每元素额外开销', '无', '1 个指针', '2 个指针']
      ]
    } },
    { p: '<small>* 单链表若单独维护一个指向尾节点的指针，尾部插入也可做到 O(1)；表中按“只有头指针”的最朴素情形计。</small>' },

    { h: '四、C++ 实现：单链表的基本操作' },
    { p: '下面用裸指针手写一个单链表，演示头部插入、在给定节点后插入、按值删除与遍历。重点看删除时如何用<strong>前驱指针</strong>把断开的两段重新接上。' },
    { code: String.raw`#include <iostream>

struct Node {
    int val;
    Node* next;
    Node(int v) : val(v), next(nullptr) {}
};

class SinglyList {
    Node* head_ = nullptr;
public:
    ~SinglyList() {                 // 逐个释放，避免内存泄漏
        while (head_) { Node* t = head_; head_ = head_->next; delete t; }
    }

    void push_front(int v) {        // O(1)：新节点指向旧头，再更新头
        Node* n = new Node(v);
        n->next = head_;
        head_ = n;
    }

    void insert_after(Node* pos, int v) {   // 已知 pos，O(1)
        if (!pos) return;
        Node* n = new Node(v);
        n->next = pos->next;
        pos->next = n;
    }

    bool remove(int v) {            // 删除首个值为 v 的节点，O(n)
        Node* prev = nullptr;
        Node* cur = head_;
        while (cur && cur->val != v) { prev = cur; cur = cur->next; }
        if (!cur) return false;             // 没找到
        if (prev) prev->next = cur->next;   // 中间或尾部：跳过 cur
        else      head_ = cur->next;        // cur 是头节点
        delete cur;
        return true;
    }

    void print() const {
        for (Node* c = head_; c; c = c->next)
            std::cout << c->val << (c->next ? " -> " : "\n");
    }
};

int main() {
    SinglyList l;
    l.push_front(3);        // 3
    l.push_front(2);        // 2 -> 3
    l.push_front(1);        // 1 -> 2 -> 3
    l.print();              // 1 -> 2 -> 3
    l.remove(2);            // 删中间节点
    l.print();              // 1 -> 3
    return 0;
}`, lang: 'cpp', title: '单链表：插入、删除与遍历（C++17）' },
    { p: '对照来看，<code>std::vector</code> 的等价操作是 <code>insert</code> / <code>erase</code>，它们内部会自动搬移元素——你不用手写循环，但那份 O(n) 的搬移成本依然存在。' },

    { h: '五、图解：两种内存布局' },
    { p: '左半边是数组：格子紧挨着，下标即偏移，可直接跳到 <code>a[3]</code>。右半边是链表：节点分散在内存各处，必须顺着箭头一个个走。' },
    { svg: '<svg viewBox="0 0 720 320" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="数组连续内存与链表分散节点的布局对比">' +
      '<defs>' +
      '<marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#2f6feb"/>' +
      '</marker>' +
      '</defs>' +
      '<text x="150" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#a626a4">数组：连续内存</text>' +
      '<text x="24" y="66" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">base</text>' +
      '<g>' +
      '<rect x="50" y="72" width="52" height="46" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<rect x="102" y="72" width="52" height="46" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<rect x="154" y="72" width="52" height="46" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<rect x="206" y="72" width="52" height="46" fill="#f3e6f3" stroke="#a626a4"/>' +
      '<rect x="258" y="72" width="52" height="46" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="76" y="101" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">10</text>' +
      '<text x="128" y="101" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">20</text>' +
      '<text x="180" y="101" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">30</text>' +
      '<text x="232" y="101" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">40</text>' +
      '<text x="284" y="101" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">50</text>' +
      '<text x="76" y="136" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[0]</text>' +
      '<text x="128" y="136" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[1]</text>' +
      '<text x="180" y="136" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[2]</text>' +
      '<text x="232" y="136" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[3]</text>' +
      '<text x="284" y="136" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">[4]</text>' +
      '</g>' +
      '<path d="M180,180 C180,150 232,150 232,120" fill="none" stroke="#22863a" stroke-width="1.6" marker-end="url(#ar)"/>' +
      '<text x="180" y="200" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">a[3] = base + 3*size 一步直达</text>' +
      '<line x1="360" y1="40" x2="360" y2="300" stroke="#8a94a6" stroke-dasharray="4 4"/>' +
      '<text x="540" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#a626a4">链表：分散节点 + 指针</text>' +
      '<text x="410" y="72" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">head</text>' +
      '<g>' +
      '<rect x="400" y="80" width="80" height="40" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="424" y="105" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">10</text>' +
      '<circle cx="466" cy="100" r="6" fill="#ffffff" stroke="#2f6feb"/>' +
      '<rect x="560" y="150" width="80" height="40" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="584" y="175" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">20</text>' +
      '<circle cx="626" cy="170" r="6" fill="#ffffff" stroke="#2f6feb"/>' +
      '<rect x="410" y="220" width="80" height="40" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="434" y="245" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">30</text>' +
      '<circle cx="476" cy="240" r="6" fill="#ffffff" stroke="#8a94a6"/>' +
      '<line x1="472" y1="100" x2="558" y2="167" stroke="#2f6feb" stroke-width="1.6" marker-end="url(#ar)"/>' +
      '<line x1="620" y1="192" x2="492" y2="238" stroke="#2f6feb" stroke-width="1.6" marker-end="url(#ar)"/>' +
      '<line x1="482" y1="240" x2="520" y2="240" stroke="#8a94a6" stroke-width="1.6"/>' +
      '<text x="536" y="244" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">null</text>' +
      '</g>' +
      '<text x="540" y="298" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">访问第 i 个必须从头顺着箭头走 i 步</text>' +
      '</svg>', cap: '数组格子紧邻、可按下标直达；链表节点分散，只能沿指针依次跳转。' },

    { h: '六、常见坑' },
    { callout: '<strong>“链表插入是 O(1)”是有前提的</strong>：只有在你<strong>已经持有目标位置的节点指针</strong>时才成立。若还要先按下标或按值找到那个位置，查找本身是 O(n)，整体仍是 O(n)。', kind: 'warn' },
    { ul: [
      '<strong>vector 扩容不是免费的</strong>：容量满时 <code>push_back</code> 会重新分配更大的内存并整体搬移，单次是 O(n)；但均摊下来仍是 O(1)。可用 <code>reserve</code> 预留容量避免反复扩容。',
      '<strong>迭代器 / 指针失效</strong>：<code>vector</code> 一旦扩容，所有旧迭代器、指针、引用全部失效；链表删除节点后，指向该节点的迭代器失效。',
      '<strong>别忘了释放</strong>：手写链表要在析构里逐个 <code>delete</code>，否则内存泄漏；用 <code>std::list</code> 或智能指针可自动管理。',
      '<strong>缓存效应会“骗人”</strong>：即便复杂度同为 O(n)，链表遍历的实际耗时常常明显高于数组，因为节点分散、缓存频繁未命中。'
    ] },
    { callout: '默认优先用 <code>std::vector</code>：它的连续内存在现代 CPU 上几乎总是更快。只有当“频繁在中间插删且已持有位置”或“需要稳定的元素地址”时，才考虑 <code>std::list</code>。', kind: 'tip' },

    { h: '七、练习' },
    { ol: [
      '为上面的 <code>SinglyList</code> 增加一个 <code>reverse()</code> 方法，用三个指针（prev/cur/next）原地反转整条链，要求 O(n) 时间、O(1) 额外空间。',
      '实现 <code>insert_sorted(int v)</code>：在一个<strong>升序</strong>单链表中找到第一个大于 <code>v</code> 的节点，把 <code>v</code> 插到它前面，保持整体有序。',
      '用 <code>std::vector</code> 和手写单链表分别存入 100 万个整数并顺序求和，测量耗时，解释为什么数组版本更快。',
      '把单链表改造成带 <code>prev</code> 指针的双链表，实现 O(1) 的“删除已持有节点”，并说明它比单链表省去了什么。'
    ] }
  ]);
})();
