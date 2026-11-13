(function () {
  'use strict';
  LEARN.register('stack-queue', [
    { lead: '栈和队列是两种“限制了操作端”的线性结构：栈只在一端进出（<strong>后进先出 LIFO</strong>），队列一端进另一端出（<strong>先进先出 FIFO</strong>）。限制反而带来清晰语义——函数调用、括号匹配、BFS、单调栈都建立在它们之上。' },

    { h: '一、栈：后进先出（LIFO）' },
    { p: '栈就像一摞盘子：只能从<strong>顶部</strong>放（<code>push</code>）和取（<code>pop</code>），看最上面那个用 <code>top</code>。最后放上去的最先被拿走，这就是 LIFO。三个核心操作都是 O(1)。' },
    { ul: [
      '<code>push(x)</code>：把 <code>x</code> 压入栈顶；',
      '<code>pop()</code>：弹出栈顶元素（<strong>不返回</strong>值，取值得先用 <code>top()</code>）；',
      '<code>top()</code>：读取栈顶但不移除；<code>empty()</code> / <code>size()</code> 判空与计数。'
    ] },
    { p: 'C++ 的 <code>std::stack</code> 是一个<strong>容器适配器</strong>：它本身不存数据，而是包在一个底层容器外面、只暴露栈语义的接口。<strong>默认底层容器是 <code>std::deque</code></strong>，也可显式换成 <code>std::vector</code> 或 <code>std::list</code>，例如 <code>std::stack&lt;int, std::vector&lt;int&gt;&gt;</code>。' },

    { h: '二、队列：先进先出（FIFO）' },
    { p: '队列像排队买票：从<strong>队尾</strong>入队（<code>push</code>），从<strong>队头</strong>出队（<code>pop</code>），最先来的最先被服务。<code>front()</code> 看队头、<code>back()</code> 看队尾，均为 O(1)。' },
    { p: '<code>std::queue</code> 同样是容器适配器，<strong>默认底层也是 <code>std::deque</code></strong>（可选 <code>std::list</code>）。选 deque 是因为它能两端高效操作、且不需要像 vector 那样在头部搬移元素。' },

    { h: '三、双端队列 deque' },
    { p: '<code>std::deque</code>（double-ended queue）允许在<strong>两端</strong>都 O(1) 插入删除：<code>push_front / push_back / pop_front / pop_back</code>，同时支持下标随机访问（近似 O(1)）。它内部由多段固定大小的缓冲块拼接而成，因此既能当栈也能当队列。<code>std::stack</code> 与 <code>std::queue</code> 默认就是站在它肩上。' },

    { h: '四、复杂度对照表' },
    { table: {
      head: ['操作', '<code>std::stack</code>', '<code>std::queue</code>', '<code>std::deque</code>'],
      rows: [
        ['访问端', '仅栈顶', '仅队头 / 队尾', '两端都可'],
        ['入（push / push_back）', 'O(1) 顶部', 'O(1) 队尾', 'O(1) 两端'],
        ['出（pop / pop_front）', 'O(1) 顶部', 'O(1) 队头', 'O(1) 两端'],
        ['读取（top / front / back）', 'O(1)', 'O(1)', 'O(1)'],
        ['按下标随机访问', '不支持', '不支持', 'O(1) 近似'],
        ['默认底层容器', '<code>deque</code>', '<code>deque</code>', '（自身即容器）']
      ]
    } },

    { h: '五、C++ 实现：括号匹配与单调栈' },
    { p: '第一个例子用 <code>std::stack</code> 做<strong>括号匹配</strong>：遇左括号入栈，遇右括号则栈顶必须是与之配对的左括号，最后栈应为空。' },
    { code: String.raw`#include <iostream>
#include <stack>
#include <string>

bool balanced(const std::string& s) {
    std::stack<char> st;
    for (char c : s) {
        if (c == '(' || c == '[' || c == '{') {
            st.push(c);                       // 左括号入栈
        } else if (c == ')' || c == ']' || c == '}') {
            if (st.empty()) return false;      // 没有可配对的左括号
            char t = st.top();
            if ((c == ')' && t != '(') ||
                (c == ']' && t != '[') ||
                (c == '}' && t != '{')) return false;  // 类型不匹配
            st.pop();
        }
    }
    return st.empty();                         // 全部配对则栈为空
}

int main() {
    std::cout << std::boolalpha;
    std::cout << balanced("{[()]}") << "\n";   // true
    std::cout << balanced("{[(])}") << "\n";   // false（交叉）
    std::cout << balanced("(((")    << "\n";   // false（未闭合）
    return 0;
}`, lang: 'cpp', title: '栈应用：括号匹配（C++17）' },
    { p: '第二个例子是<strong>单调栈</strong>：栈内元素保持单调（这里从栈底到栈顶递减），用来在 O(n) 内求出每个元素<strong>右边第一个比它大的元素</strong>。关键洞察是：每个元素至多入栈、出栈各一次，总代价 O(n) 而非 O(n²)。' },
    { code: String.raw`#include <iostream>
#include <vector>
#include <stack>

// 对每个位置 i，返回右边第一个严格大于 a[i] 的值；不存在则为 -1。
std::vector<int> nextGreater(const std::vector<int>& a) {
    int n = static_cast<int>(a.size());
    std::vector<int> res(n, -1);
    std::stack<int> st;                 // 存"下标"，对应值单调递减
    for (int i = 0; i < n; ++i) {
        // 当前元素比栈顶大 => 它就是栈顶那些元素的"下一个更大者"
        while (!st.empty() && a[i] > a[st.top()]) {
            res[st.top()] = a[i];
            st.pop();
        }
        st.push(i);
    }
    return res;                          // 残留在栈里的位置保持 -1
}

int main() {
    std::vector<int> a{2, 1, 2, 4, 3};
    for (int x : nextGreater(a)) std::cout << x << " ";
    std::cout << "\n";                   // 输出：4 2 4 -1 -1
    return 0;
}`, lang: 'cpp', title: '单调栈：下一个更大元素（C++17）' },
    { p: '队列的典型应用是 <strong>BFS（广度优先搜索）</strong>：把起点入队，循环里 <code>front()</code> 取出当前层、把未访问的邻居 <code>push</code> 进队尾，从而一层层向外扩散。' },

    { h: '六、图解：栈的压入/弹出 与 队列的入队/出队' },
    { p: '左边栈只在<strong>顶部</strong>操作（LIFO）；右边队列<strong>队尾进、队头出</strong>（FIFO）。' },
    { svg: '<svg viewBox="0 0 720 300" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="栈的顶部压入弹出与队列的队尾入队队头出队">' +
      '<defs>' +
      '<marker id="ar2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#2f6feb"/>' +
      '</marker>' +
      '<marker id="ag2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#22863a"/>' +
      '</marker>' +
      '</defs>' +
      '<text x="150" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#a626a4">栈 Stack（LIFO）</text>' +
      '<rect x="90" y="60" width="120" height="170" fill="none" stroke="#8a94a6" stroke-width="1.6"/>' +
      '<rect x="98" y="180" width="104" height="42" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="150" y="206" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">A（栈底）</text>' +
      '<rect x="98" y="136" width="104" height="42" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="150" y="162" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">B</text>' +
      '<rect x="98" y="92" width="104" height="42" fill="#f3e6f3" stroke="#a626a4"/>' +
      '<text x="150" y="118" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">C（top）</text>' +
      '<line x1="250" y1="70" x2="212" y2="100" stroke="#2f6feb" stroke-width="1.6" marker-end="url(#ar2)"/>' +
      '<text x="272" y="66" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#2f6feb">push</text>' +
      '<line x1="212" y1="112" x2="250" y2="140" stroke="#22863a" stroke-width="1.6" marker-end="url(#ag2)"/>' +
      '<text x="278" y="150" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">pop</text>' +
      '<text x="150" y="256" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">只能从顶部进出</text>' +
      '<line x1="360" y1="40" x2="360" y2="270" stroke="#8a94a6" stroke-dasharray="4 4"/>' +
      '<text x="545" y="26" text-anchor="middle" font-family="system-ui, sans-serif" font-size="15" fill="#a626a4">队列 Queue（FIFO）</text>' +
      '<g>' +
      '<rect x="440" y="110" width="52" height="52" fill="#f3e6f3" stroke="#a626a4"/>' +
      '<text x="466" y="142" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#a626a4">A</text>' +
      '<rect x="496" y="110" width="52" height="52" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="522" y="142" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">B</text>' +
      '<rect x="552" y="110" width="52" height="52" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="578" y="142" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#1f2933">C</text>' +
      '</g>' +
      '<line x1="420" y1="90" x2="440" y2="108" stroke="#22863a" stroke-width="1.6" marker-end="url(#ag2)"/>' +
      '<text x="414" y="82" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">出队 front</text>' +
      '<text x="466" y="186" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">队头</text>' +
      '<line x1="640" y1="90" x2="606" y2="112" stroke="#2f6feb" stroke-width="1.6" marker-end="url(#ar2)"/>' +
      '<text x="654" y="82" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#2f6feb">入队 push</text>' +
      '<text x="578" y="186" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">队尾</text>' +
      '<text x="545" y="230" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">队尾进、队头出</text>' +
      '</svg>', cap: '栈仅在一端操作，故后进先出；队列两端分工，故先进先出。' },

    { h: '七、常见坑' },
    { callout: '<code>std::stack::pop()</code> 和 <code>std::queue::pop()</code> <strong>不返回被移除的元素</strong>（出于异常安全考虑）。要拿值必须先 <code>top()</code> / <code>front()</code>，再 <code>pop()</code>。', kind: 'warn' },
    { ul: [
      '<strong>对空容器 pop / top 是未定义行为</strong>：操作前务必用 <code>empty()</code> 判空，尤其在 while 循环里。',
      '<strong>单调栈存下标还是存值要想清楚</strong>：存下标能同时拿到位置和值，通常更灵活；比较时用 <code>a[st.top()]</code> 取值。',
      '<strong>stack/queue 没有迭代器</strong>：适配器刻意不暴露遍历接口，需要遍历或随机访问请直接用 <code>deque</code> 或 <code>vector</code>。',
      '<strong>BFS 里要“入队时就标记已访问”</strong>：若等到出队才标记，同一节点可能被重复入队，导致超时甚至死循环。'
    ] },
    { callout: '需要“两端都能高效进出”时（如滑动窗口最大值、单调队列），直接用 <code>std::deque</code>，不要拿 <code>stack</code>/<code>queue</code> 硬凑。', kind: 'tip' },

    { h: '八、练习' },
    { ol: [
      '用栈实现表达式求值：读入只含 <code>+ - * /</code> 和整数的中缀表达式，输出结果（可先转后缀再用栈求值）。',
      '用<strong>单调栈</strong>求“柱状图中最大矩形”：对每根柱子找到左右第一个比它矮的位置，据此算面积。',
      '用 <code>std::queue</code> 实现 BFS，求无权图中从起点到各点的最短步数；说明为什么必须用队列而非栈。',
      '用两个 <code>std::stack</code> 实现一个队列（入队压入 in 栈，出队时若 out 栈空则把 in 全部倒入 out），并分析每个操作的均摊复杂度。'
    ] }
  ]);
})();
