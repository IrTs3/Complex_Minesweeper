(function () {
  'use strict';
  LEARN.register('cpp-build', [
    { lead: '一份 <code>.cpp</code> 源码不会自己变成可执行程序。C++ 的构建是一条<strong>四阶段流水线</strong>：预处理、编译、汇编、链接。理解每个阶段做了什么、产物是什么，你就能看懂绝大多数报错——尤其是那句让新手抓狂的 <em>undefined reference</em>。' },

    { h: '一、构建的四个阶段' },
    { p: '把 <code>main.cpp</code> 变成可执行文件 <code>a.out</code>，工具链（如 g++ / clang++）内部会依次经过下面四步。前三步合称「编译一个翻译单元（translation unit）」，最后一步把所有翻译单元和库拼成程序。' },
    { ul: [
      '<strong>预处理（Preprocessing）</strong>：处理所有以 <code>#</code> 开头的指令。<code>#include</code> 把头文件<em>原样文本</em>展开进来，<code>#define</code> 做宏替换，<code>#if / #ifdef</code> 做条件编译。此阶段不懂 C++ 语法，纯粹是文本操作，产物仍是 C++ 源码（后缀常记为 <code>.ii</code>）。',
      '<strong>编译（Compilation）</strong>：把预处理后的源码做词法/语法/语义分析，优化后翻译成<strong>汇编代码</strong>（<code>.s</code>）。类型错误、语法错误基本都在这一阶段报出。',
      '<strong>汇编（Assembly）</strong>：汇编器把 <code>.s</code> 翻译成<strong>机器码</strong>，打包成<strong>目标文件</strong>（<code>.o</code>，Linux 上是 ELF 格式）。此时函数已变成机器指令，但对其它文件里符号的引用还是「未解析」的占位地址。',
      '<strong>链接（Linking）</strong>：链接器把多个 <code>.o</code> 和库文件合并，<strong>解析符号引用</strong>——把「谁调用了 <code>foo()</code>」和「<code>foo()</code> 的定义在哪」对上号，重定位地址，最终产出可执行文件。'
    ] },
    { callout: '注意：一个 <code>.cpp</code> 加上它 <code>#include</code> 的所有内容，预处理后才构成一个完整的<strong>翻译单元</strong>。编译器是逐个翻译单元独立编译的，它并不知道别的 <code>.cpp</code> 里写了什么——这正是链接阶段存在的意义。', kind: 'note' },

    { h: '二、阶段对照表：命令、输入与产物' },
    { p: 'g++ 用不同选项可以让流水线在某个阶段停下，方便你观察中间产物：' },
    { table: {
      head: ['阶段', 'g++ 选项', '输入', '产物', '典型报错来源'],
      rows: [
        ['预处理', '<code>-E</code>', '<code>.cpp</code>', '展开后的源码 <code>.ii</code>', '头文件找不到、宏写错'],
        ['编译', '<code>-S</code>', '预处理源码', '汇编 <code>.s</code>', '语法错误、类型不匹配'],
        ['汇编', '<code>-c</code>', '汇编 <code>.s</code>', '目标文件 <code>.o</code>', '（很少，通常随编译一起报）'],
        ['链接', '（默认，无 <code>-c</code>）', '多个 <code>.o</code> + 库', '可执行文件', '<em>undefined reference</em>、<em>multiple definition</em>']
      ]
    } },

    { h: '三、声明 vs 定义与 ODR' },
    { p: '<strong>声明（declaration）</strong>告诉编译器「有这么个名字，它的类型是这样」，不分配实体；<strong>定义（definition）</strong>才真正创建实体（分配内存 / 生成函数体）。' },
    { ul: [
      '<code>extern int counter;</code> 是声明；<code>int counter = 0;</code> 是定义。',
      '<code>int add(int a, int b);</code> 是函数声明（原型）；带函数体的 <code>int add(int a, int b) { return a + b; }</code> 是定义。',
      '一个实体在<strong>整个程序</strong>中只能有<strong>一个定义</strong>，这就是 <strong>ODR（One Definition Rule，单一定义规则）</strong>。违反它会在链接期报 <em>multiple definition of ...</em>。'
    ] },
    { p: '因为头文件会被多个 <code>.cpp</code> 反复 <code>#include</code>，若头文件里直接写了非 <code>inline</code> 的全局变量/函数定义，链接时就会出现多份定义。<strong>头文件卫士（include guard）</strong>则解决另一个问题：同一个翻译单元内头文件被间接包含多次导致的<em>重复声明/重定义</em>。' },

    { h: '四、C++ 实现：多文件工程与头文件卫士' },
    { p: '下面是一个最小的两文件工程。<code>mathutil.h</code> 只放<strong>声明</strong>并用卫士防止重复包含，<code>mathutil.cpp</code> 放<strong>定义</strong>，<code>main.cpp</code> 使用它。' },
    { code: String.raw`// ---- mathutil.h ----
#ifndef MATHUTIL_H        // 头文件卫士：首次包含时定义该宏
#define MATHUTIL_H

int add(int a, int b);    // 只有声明，不分配实体
int mul(int a, int b);

#endif // MATHUTIL_H

// ---- mathutil.cpp ----
#include "mathutil.h"

int add(int a, int b) {   // 定义：真正生成函数体
    return a + b;
}
int mul(int a, int b) {
    return a * b;
}

// ---- main.cpp ----
#include <iostream>
#include "mathutil.h"     // 拿到 add/mul 的声明

int main() {
    std::cout << add(2, 3) << '\n';   // 5
    std::cout << mul(4, 5) << '\n';   // 20
    return 0;
}`, title: '最小多文件工程（声明放头文件，定义放 .cpp）' },
    { p: '分阶段编译这个工程：' },
    { code: String.raw`# 只编译不链接，分别得到 main.o 和 mathutil.o
g++ -std=c++17 -c main.cpp        # -> main.o
g++ -std=c++17 -c mathutil.cpp    # -> mathutil.o

# 链接两个目标文件，生成可执行文件
g++ -std=c++17 main.o mathutil.o -o app
./app

# 观察中间产物：
g++ -E main.cpp -o main.ii        # 预处理：看到 <iostream> 被展开成上千行
g++ -S main.cpp                   # 编译到汇编：生成 main.s
g++ -c main.s -o main.o           # 汇编：生成目标文件

# 常见链接错误：漏掉 mathutil.o 会得到
# undefined reference to 'add(int, int)'`, lang: 'bash', title: 'g++ 分阶段命令' },

    { h: '五、图解：四阶段流水线' },
    { svg: '<svg viewBox="0 0 720 240" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="C++ 构建四阶段流水线：源文件经预处理、编译、汇编，再与其它目标文件一起链接成可执行文件">' +
      '<defs><marker id="arw" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">' +
      '<path d="M0,0 L8,3 L0,6 Z" fill="#8a94a6"/></marker></defs>' +
      // 源文件
      '<rect x="10" y="30" width="90" height="46" rx="6" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="55" y="50" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">main.cpp</text>' +
      '<text x="55" y="66" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">源码</text>' +
      // 阶段1 预处理
      '<rect x="130" y="26" width="120" height="54" rx="6" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="190" y="48" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">1. 预处理</text>' +
      '<text x="190" y="66" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">展开 #include / 宏</text>' +
      // 阶段2 编译
      '<rect x="290" y="26" width="120" height="54" rx="6" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="350" y="48" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">2. 编译</text>' +
      '<text x="350" y="66" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">译成汇编 .s</text>' +
      // 阶段3 汇编
      '<rect x="450" y="26" width="120" height="54" rx="6" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="510" y="48" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">3. 汇编</text>' +
      '<text x="510" y="66" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">生成 main.o</text>' +
      // 箭头
      '<line x1="100" y1="53" x2="128" y2="53" stroke="#8a94a6" stroke-width="2" marker-end="url(#arw)"/>' +
      '<line x1="250" y1="53" x2="288" y2="53" stroke="#8a94a6" stroke-width="2" marker-end="url(#arw)"/>' +
      '<line x1="410" y1="53" x2="448" y2="53" stroke="#8a94a6" stroke-width="2" marker-end="url(#arw)"/>' +
      // 其它 .o
      '<rect x="450" y="120" width="120" height="46" rx="6" fill="#eaf1fe" stroke="#8a94a6"/>' +
      '<text x="510" y="140" text-anchor="middle" font-family="system-ui, sans-serif" font-size="12" fill="#1f2933">mathutil.o</text>' +
      '<text x="510" y="156" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">另一个翻译单元</text>' +
      // 链接
      '<rect x="600" y="80" width="110" height="60" rx="6" fill="#eaf1fe" stroke="#2f6feb"/>' +
      '<text x="655" y="104" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">4. 链接</text>' +
      '<text x="655" y="122" text-anchor="middle" font-family="system-ui, sans-serif" font-size="11" fill="#8a94a6">解析符号</text>' +
      '<line x1="570" y1="60" x2="612" y2="82" stroke="#8a94a6" stroke-width="2" marker-end="url(#arw)"/>' +
      '<line x1="570" y1="140" x2="612" y2="120" stroke="#8a94a6" stroke-width="2" marker-end="url(#arw)"/>' +
      // 产物
      '<rect x="600" y="176" width="110" height="44" rx="6" fill="#e6f4ea" stroke="#22863a"/>' +
      '<text x="655" y="203" text-anchor="middle" font-family="system-ui, sans-serif" font-size="13" fill="#1f2933">可执行文件</text>' +
      '<line x1="655" y1="140" x2="655" y2="174" stroke="#22863a" stroke-width="2" marker-end="url(#arw)"/>' +
      '</svg>', cap: '前三个阶段把一个翻译单元变成目标文件 .o；链接阶段把所有 .o 与库合并、解析符号引用，产出可执行文件。' },

    { h: '六、静态库与动态库' },
    { ul: [
      '<strong>静态库</strong>（Linux 上 <code>.a</code>）：链接时把用到的代码<strong>拷贝</strong>进可执行文件。产物自包含、无需额外依赖，但体积大、库升级需重新链接。',
      '<strong>动态库 / 共享库</strong>（Linux 上 <code>.so</code>，Windows 上 <code>.dll</code>）：链接时只记录「运行时去哪找」，真正的机器码在<strong>程序启动或运行时</strong>才加载。多个程序共享同一份库、可单独升级，但部署时要保证运行环境能找到该库。'
    ] },

    { h: '七、常见坑' },
    { callout: '<strong><em>undefined reference to ...</em> 是链接期错误，不是编译期错误。</strong>它意味着某个符号被<em>声明并使用</em>了，但链接器在所有 <code>.o</code> 和库里找不到它的<em>定义</em>。最常见原因：忘了把定义该符号的 <code>.cpp</code>/<code>.o</code>/库加进链接命令。', kind: 'warn' },
    { ul: [
      '<em>multiple definition of ...</em>：同一实体被定义了多次。多半是把非 <code>inline</code> 的函数或全局变量的<strong>定义</strong>写进了被多处包含的头文件。头文件里应只放声明，或给函数/变量加 <code>inline</code>。',
      '忘写头文件卫士（或用 <code>#pragma once</code>）会导致同一头文件在一个翻译单元内被展开多次，引发重复声明/重定义。',
      '只改了头文件却没重新编译依赖它的 <code>.cpp</code>：由于翻译单元是独立编译的，过期的 <code>.o</code> 会造成声明与定义不一致的诡异链接/运行错误。构建系统（如 make）靠依赖关系处理这点。',
      'C++ 名字修饰（name mangling）：用 C 编译器编的 <code>.o</code> 直接链进 C++ 工程会 <em>undefined reference</em>，需在头文件里用 <code>extern "C"</code> 关掉修饰。'
    ] },

    { h: '八、练习' },
    { ol: [
      '写一个两文件工程：<code>util.h</code> 声明 <code>int square(int)</code>，<code>util.cpp</code> 定义它，<code>main.cpp</code> 调用。分别用 <code>-c</code> 编译再链接，然后故意从链接命令里删掉 <code>util.o</code>，观察 <em>undefined reference</em> 报错。',
      '对 <code>#include &lt;iostream&gt;</code> 的一个 <code>main.cpp</code> 运行 <code>g++ -E main.cpp | wc -l</code>，看看预处理把标准库头文件展开成了多少行，体会「翻译单元」的真实规模。',
      '把一个函数定义直接写进被两个 <code>.cpp</code> 包含的头文件，链接时应得到 <em>multiple definition</em>；用 <code>inline</code> 或把定义移到某个 <code>.cpp</code> 来修复它。',
      '查一查你的平台上如何生成静态库（<code>ar rcs libfoo.a foo.o</code>）和动态库（<code>-shared -fPIC</code>），并用 <code>ldd</code>（Linux）查看某个可执行文件依赖了哪些动态库。'
    ] }
  ]);
})();
