(function () {
  'use strict';
  LEARN.register('smart-pointers', [
    { lead: '手动 <code>new</code>/<code>delete</code> 一旦碰上提前 <code>return</code> 或抛异常，就极易漏掉 <code>delete</code> 造成内存泄漏。<strong>智能指针</strong>用 <strong>RAII</strong> 思想把「释放」交给对象析构自动完成，让资源的生命周期跟随作用域。这篇讲 <code>unique_ptr</code>、<code>shared_ptr</code>、<code>weak_ptr</code> 以及各自适用场景。' },

    { h: '一、RAII：资源获取即初始化' },
    { p: '<strong>RAII（Resource Acquisition Is Initialization）</strong>是 C++ 的核心惯用法：把资源（内存、文件句柄、锁）的获取放进对象的<strong>构造函数</strong>，释放放进<strong>析构函数</strong>。由于栈对象离开作用域时析构函数<em>一定会被调用</em>（即便因异常栈展开也是如此），资源就绝不会泄漏。智能指针正是「堆内存」这一资源的 RAII 封装。' },

    { h: '二、三种智能指针' },
    { ul: [
      '<code>std::unique_ptr&lt;T&gt;</code>：<strong>独占所有权</strong>。同一时刻只有一个 <code>unique_ptr</code> 指向对象，<strong>不可拷贝</strong>（拷贝会违反独占），但可 <code>std::move</code> 转移所有权。离开作用域自动 <code>delete</code>。零额外开销，大小等同裸指针。',
      '<code>std::shared_ptr&lt;T&gt;</code>：<strong>共享所有权</strong>。内部维护一个<strong>控制块</strong>，记录引用计数（use_count）。每多一个 <code>shared_ptr</code> 指向对象计数 +1，析构或 <code>reset</code> 时 -1，减到 0 才真正 <code>delete</code>。',
      '<code>std::weak_ptr&lt;T&gt;</code>：<strong>不拥有</strong>对象、<strong>不增加</strong>引用计数的「观察者」。用于打破 <code>shared_ptr</code> 的<strong>循环引用</strong>。使用前须 <code>lock()</code> 提升为 <code>shared_ptr</code>，若对象已销毁则返回空的 <code>shared_ptr</code>。'
    ] },

    { h: '三、对照表' },
    { table: {
      head: ['特性', '<code>unique_ptr</code>', '<code>shared_ptr</code>', '<code>weak_ptr</code>'],
      rows: [
        ['所有权', '独占', '共享', '无（观察）'],
        ['可拷贝', '否（只能 move）', '是（计数+1）', '是（不影响计数）'],
        ['额外开销', '无', '控制块 + 原子计数', '指向控制块'],
        ['释放时机', '析构 / reset / move 走', 'use_count 归零', '从不释放对象'],
        ['典型用途', '默认首选、工厂返回值', '多处共享同一对象', '缓存、父子回指、打破环'],
        ['创建方式', '<code>make_unique&lt;T&gt;()</code>', '<code>make_shared&lt;T&gt;()</code>', '由 <code>shared_ptr</code> 构造']
      ]
    } },
    { callout: '<strong>默认用 <code>unique_ptr</code></strong>，只有确实需要多方共享同一对象、且无法确定谁最后释放时，才升级到 <code>shared_ptr</code>。优先用 <code>std::make_unique</code> / <code>std::make_shared</code>——它们一次分配、异常安全，且 <code>make_shared</code> 能把对象和控制块合并分配。', kind: 'tip' },

    { h: '四、C++ 实现' },
    { p: '下面演示三种智能指针及循环引用的破解：' },
    { code: String.raw`#include <iostream>
#include <memory>
#include <string>

struct Resource {
    std::string name;
    explicit Resource(std::string n) : name(std::move(n)) {
        std::cout << "acquire " << name << '\n';
    }
    ~Resource() { std::cout << "release " << name << '\n'; }
};

// unique_ptr 作为工厂返回值：所有权转移给调用者
std::unique_ptr<Resource> makeResource(const std::string& n) {
    return std::make_unique<Resource>(n);
}

// 循环引用示例：用 weak_ptr 回指，打破环
struct Node {
    std::shared_ptr<Node> next;   // 拥有下一个
    std::weak_ptr<Node> prev;     // 只观察上一个，不增加计数
    ~Node() { std::cout << "~Node\n"; }
};

int main() {
    // 1) unique_ptr：独占，离开作用域自动释放
    {
        auto u = std::make_unique<Resource>("u1");
        // auto copy = u;              // 编译错误：unique_ptr 不可拷贝
        auto moved = std::move(u);     // OK：所有权转移，u 变为空
        std::cout << (u == nullptr) << '\n';   // 1
    }   // moved 析构 -> release u1

    // 2) shared_ptr：引用计数
    {
        auto s1 = std::make_shared<Resource>("s1");
        std::cout << "count=" << s1.use_count() << '\n';  // 1
        {
            auto s2 = s1;             // 拷贝，计数+1
            std::cout << "count=" << s1.use_count() << '\n';  // 2
        }   // s2 析构，计数-1
        std::cout << "count=" << s1.use_count() << '\n';  // 1
    }   // 计数归零 -> release s1

    // 3) weak_ptr：打破循环引用
    auto a = std::make_shared<Node>();
    auto b = std::make_shared<Node>();
    a->next = b;      // a 拥有 b
    b->prev = a;      // b 只观察 a（若是 shared_ptr 就会泄漏）
    if (auto locked = b->prev.lock()) {   // 提升为 shared_ptr 再使用
        std::cout << "prev alive\n";
    }
    return 0;   // a、b 均能正常析构
}`, title: 'unique_ptr / shared_ptr / weak_ptr 与循环引用' },

    { h: '五、图解：shared_ptr 控制块与引用计数' },
    { svg: '<svg viewBox="0 0 680 260" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="两个 shared_ptr 指向同一个控制块，控制块记录 use_count 并管理堆对象">' +
      '<defs><marker id="as" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // shared_ptr 变量
      '<rect x="20" y="40" width="120" height="44" rx="6" fill="#eaf1fe" stroke="#2f6feb"/><text x="80" y="67" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">shared_ptr s1</text>' +
      '<rect x="20" y="150" width="120" height="44" rx="6" fill="#eaf1fe" stroke="#2f6feb"/><text x="80" y="177" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">shared_ptr s2</text>' +
      // 控制块
      '<rect x="230" y="86" width="180" height="86" rx="6" fill="#f3e8f6" stroke="#a626a4"/>' +
      '<text x="320" y="110" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">控制块 (control block)</text>' +
      '<text x="320" y="134" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#a626a4">use_count = 2</text>' +
      '<text x="320" y="154" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">weak_count = 0</text>' +
      // 箭头到控制块
      '<line x1="140" y1="62" x2="228" y2="106" stroke="#8a94a6" stroke-width="2" marker-end="url(#as)"/>' +
      '<line x1="140" y1="172" x2="228" y2="140" stroke="#8a94a6" stroke-width="2" marker-end="url(#as)"/>' +
      // 堆对象
      '<rect x="500" y="96" width="150" height="66" rx="6" fill="#e6f4ea" stroke="#22863a"/>' +
      '<text x="575" y="122" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">堆上的对象</text>' +
      '<text x="575" y="142" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">Resource</text>' +
      '<line x1="410" y1="129" x2="498" y2="129" stroke="#22863a" stroke-width="2" marker-end="url(#as)"/>' +
      '<text x="454" y="120" text-anchor="middle" font-family="system-ui, sans-serif" font-size="10" fill="#8a94a6">管理指针</text>' +
      // 说明
      '<text x="320" y="210" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">每当 s1/s2 析构或 reset，use_count 减 1</text>' +
      '<text x="320" y="230" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#22863a">减到 0 时，控制块才 delete 堆对象</text>' +
      '</svg>', cap: '多个 shared_ptr 共享一个控制块；控制块用引用计数追踪有多少个所有者，计数归零才真正释放堆对象。' },

    { h: '六、循环引用为什么会泄漏' },
    { p: '若 <code>A</code> 用 <code>shared_ptr</code> 指向 <code>B</code>，<code>B</code> 又用 <code>shared_ptr</code> 指向 <code>A</code>，两者的 use_count 永远至少为 1（被对方持有），即便外部指针都已销毁，计数也回不到 0，对象<strong>永不释放</strong>。解决办法：把其中一个方向（通常是「子指回父」的回指方向）改成 <code>weak_ptr</code>，它不参与计数，从而打破环。' },

    { h: '七、裸 new/delete 的坑' },
    { ul: [
      '<strong>异常安全</strong>：<code>T* p = new T; f(); delete p;</code> 若 <code>f()</code> 抛异常，<code>delete</code> 被跳过 → 泄漏。智能指针靠析构自动释放，天然异常安全。',
      '<strong>提前 return / 多出口</strong>：函数有多个返回路径时容易漏写 <code>delete</code>。',
      '<strong>重复释放 / 悬空指针</strong>：<code>delete</code> 两次或释放后继续使用是未定义行为。',
      '<strong>所有权不清晰</strong>：裸指针无法表达「谁负责释放」，多人共享时尤其危险。'
    ] },

    { h: '八、常见坑' },
    { callout: '<strong>不要用同一个裸指针初始化两个独立的 <code>shared_ptr</code></strong>（如 <code>T* p = new T; shared_ptr&lt;T&gt; a(p); shared_ptr&lt;T&gt; b(p);</code>）——它们各有独立控制块，会<strong>双重释放</strong>。要共享就从已有的 <code>shared_ptr</code> 拷贝，或直接用 <code>make_shared</code>。', kind: 'warn' },
    { ul: [
      '<code>weak_ptr</code> 不能直接解引用，必须先 <code>lock()</code> 得到 <code>shared_ptr</code> 并判空后再用。',
      '在类的成员函数里对 <code>this</code> 构造 <code>shared_ptr</code> 会创建第二个控制块；需要时用 <code>std::enable_shared_from_this</code>。',
      '把 <code>shared_ptr</code> 按值传参会让引用计数 +1（还涉及原子操作开销）；只读场景传 <code>const shared_ptr&amp;</code> 或裸引用/指针更合适。',
      '<code>unique_ptr</code> 忘记 <code>std::move</code> 就想「传递所有权」会编译报错——这正是它防止误拷贝的设计。'
    ] },

    { h: '九、练习' },
    { ol: [
      '写一个 <code>Resource</code> 类，构造/析构时打印日志；分别用 <code>make_unique</code> 和 <code>make_shared</code> 管理它，在 <code>main</code> 里进出作用域，观察释放时机。',
      '用 <code>shared_ptr</code> 构造一个对象，通过打印 <code>use_count()</code> 验证：拷贝一次 +1、拷贝的 <code>shared_ptr</code> 析构一次 -1。',
      '故意写出 <code>A</code>↔<code>B</code> 的 <code>shared_ptr</code> 循环引用，用工具（如 AddressSanitizer / valgrind）确认泄漏；再把回指方向改成 <code>weak_ptr</code>，验证泄漏消失。',
      '实现一个工厂函数返回 <code>std::unique_ptr&lt;Base&gt;</code>（<code>Base</code> 有多态派生类），在调用方接收并调用其虚函数，体会「所有权转移 + 多态」。'
    ] }
  ]);
})();
