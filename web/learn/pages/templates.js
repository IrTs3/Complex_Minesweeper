(function () {
  'use strict';
  LEARN.register('templates', [
    { lead: '模板是 C++ 的<strong>编译期泛型</strong>机制：你写一份带「类型参数」的蓝图，编译器按需为每种具体类型<em>生成</em>一份真实代码。标准库的 <code>vector&lt;T&gt;</code>、<code>sort</code> 全靠它。这篇讲函数模板、类模板、参数推导、实例化，以及 <code>typename</code> 与 <code>class</code> 的关系。' },

    { h: '一、为什么需要模板' },
    { p: '没有模板，想为 <code>int</code>、<code>double</code>、<code>std::string</code> 各写一个 <code>max</code> 就得复制粘贴三份几乎一样的代码。模板让你写一次，编译器替你为用到的每种类型「填空」生成代码，既类型安全又零运行时开销（生成的就是普通函数）。' },

    { h: '二、函数模板与类模板' },
    { ul: [
      '<strong>函数模板</strong>：<code>template &lt;typename T&gt; T max(T a, T b) { return a &gt; b ? a : b; }</code>。调用 <code>max(3, 7)</code> 时，编译器从实参<strong>推导</strong>出 <code>T = int</code>，生成 <code>max&lt;int&gt;</code>。',
      '<strong>类模板</strong>：整个类带类型参数，如 <code>template &lt;typename T&gt; class Box { T value; };</code>。使用时必须显式给出类型：<code>Box&lt;int&gt; b;</code>（C++17 起有类模板实参推导 CTAD，部分场景可省略）。',
      '<strong>非类型模板参数</strong>：参数是<em>编译期常量值</em>而非类型，如 <code>template &lt;typename T, std::size_t N&gt; class Array { T data[N]; };</code>——<code>std::array</code> 就是这么实现的。'
    ] },

    { h: '三、typename vs class' },
    { p: '在模板参数列表里，<code>template &lt;typename T&gt;</code> 和 <code>template &lt;class T&gt;</code> <strong>完全等价</strong>，都表示「T 是一个类型」，历史原因保留两种写法。区别只出现在别处：当引用<em>依赖类型</em>（其含义取决于模板参数的类型）时，必须用 <code>typename</code> 消歧义，例如 <code>typename T::iterator it;</code>——告诉编译器 <code>T::iterator</code> 是类型而不是静态成员。' },

    { h: '四、复杂度 / 成本对照表' },
    { p: '模板的成本发生在<strong>编译期</strong>而非运行期，下表对照「有无模板」的差异：' },
    { table: {
      head: ['维度', '手写多份具体类型', '模板', '备注'],
      rows: [
        ['运行时开销', '无', '无', '实例化后就是普通函数/类，无虚表、无运行时派发'],
        ['源码量', '随类型数线性增长', '写一次', '模板消除重复'],
        ['编译时间', '短', '<strong>较长</strong>', '每种用到的类型组合都要实例化一遍'],
        ['生成代码体积', '小', '可能<strong>膨胀</strong>', 'N 种类型 → N 份机器码（code bloat）'],
        ['类型安全', '安全', '安全', '实例化时做完整类型检查，错误信息可能很长']
      ]
    } },
    { callout: '<strong>代码膨胀</strong>：每实例化一种类型参数组合，编译器就生成一份独立代码。<code>vector&lt;int&gt;</code> 和 <code>vector&lt;double&gt;</code> 是两份完全不同的机器码。用得克制即可，别为每个只调用一次的小类型都实例化大模板。', kind: 'note' },

    { h: '五、C++ 实现' },
    { p: '下面把函数模板、类模板、非类型参数放在一起：' },
    { code: String.raw`#include <iostream>
#include <string>
#include <cstddef>

// 1) 函数模板：从实参推导 T
template <typename T>
T myMax(T a, T b) {
    return (a > b) ? a : b;
}

// 2) 类模板
template <typename T>
class Box {
public:
    explicit Box(T v) : value_(v) {}
    T get() const { return value_; }
private:
    T value_;
};

// 3) 非类型模板参数：N 是编译期常量
template <typename T, std::size_t N>
class FixedArray {
public:
    T& operator[](std::size_t i) { return data_[i]; }
    const T& operator[](std::size_t i) const { return data_[i]; }
    constexpr std::size_t size() const { return N; }
private:
    T data_[N];
};

int main() {
    std::cout << myMax(3, 7) << '\n';            // 推导 T=int    -> 7
    std::cout << myMax(2.5, 1.5) << '\n';        // 推导 T=double -> 2.5
    std::cout << myMax<std::string>("a", "b") << '\n';  // 显式指定 T

    Box<int> bi(42);                             // 类模板需给出类型
    Box<std::string> bs("hello");
    std::cout << bi.get() << ' ' << bs.get() << '\n';

    FixedArray<double, 3> arr;                   // N=3 编译期确定
    for (std::size_t i = 0; i < arr.size(); ++i) arr[i] = i * 1.5;
    std::cout << arr[2] << '\n';                 // 3
    return 0;
}`, title: '函数模板 / 类模板 / 非类型模板参数' },

    { h: '六、图解：编译期实例化' },
    { svg: '<svg viewBox="0 0 660 220" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="一份模板在编译期为不同类型分别实例化出多份具体代码">' +
      '<defs><marker id="at" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // 模板蓝图
      '<rect x="20" y="80" width="150" height="60" rx="6" fill="#eaf1fe" stroke="#a626a4"/>' +
      '<text x="95" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">template&lt;T&gt;</text>' +
      '<text x="95" y="124" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#8a94a6">T myMax(T,T)</text>' +
      // 编译器
      '<text x="250" y="70" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">编译器</text>' +
      '<text x="250" y="88" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">按需实例化</text>' +
      '<line x1="172" y1="110" x2="300" y2="60" stroke="#8a94a6" stroke-width="2" marker-end="url(#at)"/>' +
      '<line x1="172" y1="110" x2="300" y2="110" stroke="#8a94a6" stroke-width="2" marker-end="url(#at)"/>' +
      '<line x1="172" y1="110" x2="300" y2="160" stroke="#8a94a6" stroke-width="2" marker-end="url(#at)"/>' +
      // 实例
      '<rect x="305" y="38" width="180" height="42" rx="6" fill="#e6f4ea" stroke="#22863a"/><text x="395" y="64" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">myMax&lt;int&gt;(int,int)</text>' +
      '<rect x="305" y="90" width="180" height="42" rx="6" fill="#e6f4ea" stroke="#22863a"/><text x="395" y="116" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">myMax&lt;double&gt;(double,double)</text>' +
      '<rect x="305" y="142" width="180" height="42" rx="6" fill="#e6f4ea" stroke="#22863a"/><text x="395" y="168" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">myMax&lt;string&gt;(...)</text>' +
      // 说明
      '<text x="500" y="104" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">每种类型</text>' +
      '<text x="500" y="120" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">一份独立机器码</text>' +
      '</svg>', cap: '一份模板蓝图，编译器为每种用到的类型实参分别生成一份具体函数（实例化）。运行期它们就是普通函数，无额外开销。' },

    { h: '七、简述 C++20 concept' },
    { p: '早期模板对参数类型「来者不拒」，一旦传入不支持 <code>&gt;</code> 的类型，报错信息又长又难读。<strong>concept</strong> 让你给模板参数加<em>约束</em>，把要求写清楚：' },
    { code: String.raw`#include <concepts>
#include <iostream>

// 用 concept 约束：T 必须支持全序比较
template <typename T>
    requires std::totally_ordered<T>
T bigger(T a, T b) {
    return (a > b) ? a : b;
}

// C++20 简写形式（等价）：
template <std::totally_ordered T>
T bigger2(T a, T b) { return (a > b) ? a : b; }

int main() {
    std::cout << bigger(3, 9) << '\n';       // 9
    std::cout << bigger2(1.5, 0.5) << '\n';  // 1.5
    return 0;
}`, lang: 'cpp', title: 'C++20 concept：给模板参数加约束（需 -std=c++20）' },

    { h: '八、常见坑' },
    { callout: '<strong>模板定义通常要放在头文件里。</strong>编译器实例化时需要看到模板的完整定义。若把定义放进 <code>.cpp</code> 而别处只 <code>#include</code> 声明，链接时会 <em>undefined reference</em>。', kind: 'warn' },
    { ul: [
      '引用依赖类型忘了 <code>typename</code>：<code>T::iterator it;</code> 会被当成静态成员，应写 <code>typename T::iterator it;</code>。',
      '类模板成员函数在类外定义时，定义前也要带上模板头：<code>template &lt;typename T&gt; T Box&lt;T&gt;::get() const { ... }</code>。',
      '以为模板有运行时开销——其实没有，开销在编译期（编译变慢、二进制膨胀）。',
      '模板报错信息可能极其冗长；用 concept 约束或 <code>static_assert</code> 能让错误更早、更清晰。'
    ] },

    { h: '九、练习' },
    { ol: [
      '写一个函数模板 <code>template &lt;typename T&gt; T add(T a, T b)</code>，分别用 <code>int</code>、<code>double</code>、<code>std::string</code> 调用，观察编译器为每种类型生成的实例。',
      '写一个类模板 <code>Pair&lt;A, B&gt;</code>，含两个不同类型的成员和 <code>first()/second()</code> 访问器，用 <code>Pair&lt;int, std::string&gt;</code> 实例化测试。',
      '用非类型模板参数实现 <code>template &lt;int N&gt; int fib()</code>（编译期递归计算斐波那契），在 <code>main</code> 里 <code>std::cout &lt;&lt; fib&lt;10&gt;()</code>。',
      '把练习 1 的 <code>add</code> 用 C++20 concept 约束为「只接受算术类型」（<code>std::integral</code> 或 <code>std::floating_point</code>），试着传入 <code>std::string</code> 看编译器的约束报错。'
    ] }
  ]);
})();
