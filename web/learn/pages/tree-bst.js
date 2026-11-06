(function () {
  'use strict';
  LEARN.register('tree-bst', [
    { lead: '二叉搜索树（BST）用“<strong>左小右大</strong>”的约束把无序数据组织成一棵树，使查找、插入、删除都能在 O(树高) 内完成，同时<strong>中序遍历</strong>天然输出升序序列。它是 <code>std::map</code> / <code>std::set</code> 背后平衡树思想的基础。' },

    { h: '一、BST 的性质' },
    { p: '一棵二叉搜索树对<strong>每个节点</strong>都满足：其<strong>左子树</strong>所有节点的值 &lt; 该节点值 &lt; 其<strong>右子树</strong>所有节点的值，且左右子树本身也都是 BST。（本文约定树中<strong>不含重复值</strong>。）' },
    { p: '这个局部约束带来一个全局结论：<strong>中序遍历（左 → 根 → 右）访问 BST，得到的序列一定是升序的</strong>。这也是检验一棵树是否为合法 BST 的常用手段。' },
    { ul: [
      '<strong>查找</strong>：从根出发，目标小就往左、大就往右，每步排除一半子树，O(h)。',
      '<strong>插入</strong>：像查找一样走到空位，挂上新叶子，O(h)。',
      '<strong>删除</strong>：最麻烦的操作，需分三种情况处理（见下文），O(h)。',
      '其中 <code>h</code> 是树高：平衡时 <code>h ≈ log n</code>，退化时 <code>h = n</code>。'
    ] },

    { h: '二、删除的三种情况' },
    { p: '找到待删节点后，按它有几个孩子分情况处理——这是 BST 里最容易写错的地方：' },
    { table: {
      head: ['情况', '结构', '处理方式'],
      rows: [
        ['① 叶子节点', '无左无右', '直接删除，令父节点对应指针为 <code>nullptr</code>'],
        ['② 只有一个孩子', '仅左 或 仅右', '用那个孩子<strong>顶替</strong>被删节点的位置'],
        ['③ 有两个孩子', '左右都在', '用<strong>中序后继</strong>（右子树最小值）或<strong>中序前驱</strong>（左子树最大值）的值覆盖本节点，再递归到对应子树里删除那个后继/前驱节点']
      ]
    } },
    { p: '为什么情况③能用后继顶替？因为“右子树的最小值”一定大于左子树全部、又小于等于右子树其余全部，把它放到根的位置<strong>不破坏 BST 性质</strong>；而它自己作为右子树的最左节点，必然<strong>没有左孩子</strong>，删它就退化成了情况①或②。' },

    { h: '三、复杂度对照表' },
    { table: {
      head: ['操作', '平均 / 平衡（h = log n）', '最坏（退化成链，h = n）'],
      rows: [
        ['查找 search', 'O(log n)', 'O(n)'],
        ['插入 insert', 'O(log n)', 'O(n)'],
        ['删除 remove', 'O(log n)', 'O(n)'],
        ['中序遍历', 'O(n)', 'O(n)'],
        ['求最小 / 最大', 'O(log n)', 'O(n)'],
        ['空间', 'O(n)', 'O(n)']
      ]
    } },
    { p: '“最坏”发生在<strong>按有序序列插入</strong>时：例如依次插入 1,2,3,4,5，树会长成一条向右的斜链，所有操作退化到 O(n)。<strong>平衡树</strong>（AVL、红黑树）通过在插入/删除后做<strong>旋转</strong>把树高维持在 O(log n)——<code>std::map</code>/<code>std::set</code> 用的就是红黑树。' },

    { h: '四、C++ 实现：递归版 BST' },
    { p: '下面用递归实现插入、查找、删除与中序遍历。删除函数返回“删完后该子树的新根”，父层用它重新接上指针，这样能优雅地处理头节点被删的情况。' },
    { code: String.raw`#include <iostream>
#include <vector>

struct Node {
    int val;
    Node* left;
    Node* right;
    Node(int v) : val(v), left(nullptr), right(nullptr) {}
};

class BST {
    Node* root_ = nullptr;

    Node* insert(Node* node, int v) {
        if (!node) return new Node(v);                 // 走到空位，挂上叶子
        if (v < node->val)      node->left  = insert(node->left,  v);
        else if (v > node->val) node->right = insert(node->right, v);
        // v == node->val：本实现忽略重复值
        return node;
    }

    static Node* minNode(Node* node) {                 // 子树最左节点
        while (node && node->left) node = node->left;
        return node;
    }

    Node* remove(Node* node, int v) {
        if (!node) return nullptr;
        if (v < node->val) {
            node->left = remove(node->left, v);
        } else if (v > node->val) {
            node->right = remove(node->right, v);
        } else {                                        // 命中待删节点
            if (!node->left) {                          // 情况①/②：无左孩子
                Node* r = node->right; delete node; return r;
            }
            if (!node->right) {                         // 情况②：仅左孩子
                Node* l = node->left;  delete node; return l;
            }
            Node* succ = minNode(node->right);          // 情况③：中序后继
            node->val = succ->val;                      // 用后继值覆盖
            node->right = remove(node->right, succ->val); // 到右子树删掉后继
        }
        return node;
    }

    void inorder(const Node* node, std::vector<int>& out) const {
        if (!node) return;
        inorder(node->left, out);                       // 左
        out.push_back(node->val);                       // 根
        inorder(node->right, out);                      // 右
    }

    void destroy(Node* node) {                          // 后序释放整棵树
        if (!node) return;
        destroy(node->left);
        destroy(node->right);
        delete node;
    }

public:
    BST() = default;
    BST(const BST&) = delete;                           // 含裸指针，禁止拷贝
    BST& operator=(const BST&) = delete;
    ~BST() { destroy(root_); }

    void insert(int v) { root_ = insert(root_, v); }
    void remove(int v) { root_ = remove(root_, v); }

    bool search(int v) const {                          // 迭代查找，O(h)
        const Node* cur = root_;
        while (cur) {
            if (v == cur->val) return true;
            cur = (v < cur->val) ? cur->left : cur->right;
        }
        return false;
    }

    std::vector<int> inorder() const {
        std::vector<int> out;
        inorder(root_, out);
        return out;
    }
};

static void show(const BST& t) {
    for (int x : t.inorder()) std::cout << x << " ";
    std::cout << "\n";
}

int main() {
    BST t;
    for (int v : {8, 3, 10, 1, 6, 14, 4, 7, 13}) t.insert(v);
    show(t);                       // 1 3 4 6 7 8 10 13 14

    std::cout << std::boolalpha << t.search(6) << t.search(99) << "\n"; // true false

    t.remove(3);                   // 情况③：两个孩子，用后继 4 顶替
    t.remove(1);                   // 情况①：叶子
    t.remove(10);                  // 情况②：仅右孩子
    show(t);                       // 4 6 7 8 13 14
    return 0;
}`, lang: 'cpp', title: '递归 BST：插入 / 查找 / 删除三情况 / 中序（C++17）' },
    { p: '把 <code>remove</code> 设计成“返回新子树根”是关键技巧：无论删的是叶子、单孩子还是双孩子节点，父层都只需一句 <code>node->left = remove(...)</code> 就能正确重连，头节点被删时也自然由 <code>root_ = remove(root_, v)</code> 兜住。' },

    { h: '五、图解：一棵 BST 与它的中序序列' },
    { p: '下图是一棵合法 BST：每个节点左子树都比它小、右子树都比它大。底部按中序遍历（左→根→右）访问，输出恰为升序。' },
    { svg: '<svg viewBox="0 0 720 400" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="二叉搜索树结构与其中序遍历升序输出">' +
      '<defs>' +
      '<marker id="ar3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L7,3 L0,6 Z" fill="#22863a"/>' +
      '</marker>' +
      '</defs>' +
      '<g stroke="#8a94a6" stroke-width="1.6">' +
      '<line x1="360" y1="48" x2="200" y2="128"/>' +
      '<line x1="360" y1="48" x2="520" y2="128"/>' +
      '<line x1="200" y1="128" x2="120" y2="208"/>' +
      '<line x1="200" y1="128" x2="280" y2="208"/>' +
      '<line x1="520" y1="128" x2="560" y2="208"/>' +
      '<line x1="280" y1="208" x2="240" y2="288"/>' +
      '<line x1="280" y1="208" x2="320" y2="288"/>' +
      '<line x1="560" y1="208" x2="500" y2="288"/>' +
      '</g>' +
      '<g fill="#eaf1fe" stroke="#2f6feb" stroke-width="1.6">' +
      '<circle cx="200" cy="128" r="20"/><circle cx="520" cy="128" r="20"/>' +
      '<circle cx="120" cy="208" r="20"/><circle cx="280" cy="208" r="20"/><circle cx="560" cy="208" r="20"/>' +
      '<circle cx="240" cy="288" r="20"/><circle cx="320" cy="288" r="20"/><circle cx="500" cy="288" r="20"/>' +
      '</g>' +
      '<circle cx="360" cy="48" r="22" fill="#f3e6f3" stroke="#a626a4" stroke-width="1.8"/>' +
      '<g font-family="system-ui, sans-serif" font-size="14" fill="#1f2933" text-anchor="middle">' +
      '<text x="200" y="133">3</text><text x="520" y="133">10</text>' +
      '<text x="120" y="213">1</text><text x="280" y="213">6</text><text x="560" y="213">14</text>' +
      '<text x="240" y="293">4</text><text x="320" y="293">7</text><text x="500" y="293">13</text>' +
      '</g>' +
      '<text x="360" y="53" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#a626a4">8</text>' +
      '<text x="120" y="86" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">左子树 &lt; 8</text>' +
      '<text x="600" y="86" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">右子树 &gt; 8</text>' +
      '<line x1="40" y1="330" x2="680" y2="330" stroke="#8a94a6" stroke-dasharray="4 4"/>' +
      '<text x="360" y="348" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">中序遍历（左 → 根 → 右）</text>' +
      '<g fill="#eaf1fe" stroke="#2f6feb" stroke-width="1.4">' +
      '<circle cx="70" cy="374" r="15"/><circle cx="143" cy="374" r="15"/><circle cx="215" cy="374" r="15"/>' +
      '<circle cx="288" cy="374" r="15"/><circle cx="360" cy="374" r="15"/><circle cx="433" cy="374" r="15"/>' +
      '<circle cx="505" cy="374" r="15"/><circle cx="578" cy="374" r="15"/><circle cx="650" cy="374" r="15"/>' +
      '</g>' +
      '<g font-family="system-ui, sans-serif" font-size="13" fill="#1f2933" text-anchor="middle">' +
      '<text x="70" y="379">1</text><text x="143" y="379">3</text><text x="215" y="379">4</text>' +
      '<text x="288" y="379">6</text><text x="360" y="379">7</text><text x="433" y="379">8</text>' +
      '<text x="505" y="379">10</text><text x="578" y="379">13</text><text x="650" y="379">14</text>' +
      '</g>' +
      '<g stroke="#22863a" stroke-width="1.4">' +
      '<line x1="86" y1="374" x2="126" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="159" y1="374" x2="198" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="231" y1="374" x2="271" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="304" y1="374" x2="343" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="376" y1="374" x2="416" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="449" y1="374" x2="488" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="521" y1="374" x2="561" y2="374" marker-end="url(#ar3)"/>' +
      '<line x1="594" y1="374" x2="633" y2="374" marker-end="url(#ar3)"/>' +
      '</g>' +
      '</svg>', cap: '同一棵 BST：上方为树结构（左小右大），下方为中序遍历输出的升序序列。' },

    { h: '六、常见坑' },
    { callout: '<strong>删除双孩子节点时不要“物理搬动”节点</strong>：正确做法是把后继的<strong>值</strong>拷进当前节点，再递归去右子树删除那个后继节点。若直接改指针搬运子树，极易丢失整棵子树。', kind: 'warn' },
    { ul: [
      '<strong>有序输入会让 BST 退化</strong>：按 1,2,3… 插入会得到一条斜链，操作全变 O(n)。需要稳定 O(log n) 就用平衡树或 <code>std::map</code>/<code>std::set</code>。',
      '<strong>递归删除忘记更新父指针</strong>：务必写成 <code>node->left = remove(node->left, v)</code>，用返回值重连，否则删完的洞补不上。',
      '<strong>后继/前驱二选一即可</strong>：本文统一用中序后继（右子树最小）；用中序前驱（左子树最大）同样正确，但别在一次删除里混用。',
      '<strong>内存管理</strong>：析构要用<strong>后序</strong>遍历释放（先孩子后自己）；含裸指针的类应禁用拷贝，或改用智能指针。',
      '<strong>“中序有序”不等价于“是 BST”的逆命题要小心</strong>：仅凭一层层比较相邻父子无法判定 BST，需带上子树的上下界递归校验。'
    ] },

    { h: '七、练习' },
    { ol: [
      '把 <code>remove</code> 改成用<strong>中序前驱</strong>（左子树最大值）顶替，验证对同一组删除操作，最终中序序列与后继版一致。',
      '实现 <code>bool isBST(Node* root)</code>：用“上下界”递归法判断一棵任意二叉树是否为合法 BST（提示：给每个节点传 <code>(min, max)</code> 允许区间）。',
      '写一个函数返回 BST 中第 <code>k</code> 小的元素，要求利用中序遍历、找到即提前停止，不必遍历全树。',
      '统计一棵 BST 的高度，并构造一组输入让它退化到 <code>h = n</code>；再实现“按中序序列重建平衡 BST”，把高度压回 <code>O(log n)</code>。'
    ] }
  ]);
})();
