// 帮助面板内容 + 排版：逐字贪心换行、续行悬挂缩进 +14、行高 = 行内最大字号 + 7。
// 文案与桌面端 Renderer::buildHelp() 一致；唯一例外：背景图声明按部署是否带图门控
// （web 读 window.CMS_NO_BG，桌面无条件显示——桌面包里真有那张图）。

import { Col, kInk, kInkSoft, kRealMine, kImagMine, kMixHint, kZeroHint, kBadMark, textAdvance } from './ui.js';
import type { Ctx } from './ui.js';

export interface HelpSeg { text: string; col: Col; size: number; spaced: boolean; x: number; adv: number }
export interface HelpRow {
    y: number; h: number; indent: number;
    dot: boolean; rule: boolean; center: boolean;
    dotCol: Col; ruleFrom: number; segs: HelpSeg[];
}

const T = 22, BIG = 16, MID = 15, BODY = 13, SMALL = 11;

interface Raw { segs: HelpSeg[]; gap: number; dot: boolean; rule: boolean; center: boolean; indent: number }

function S(text: string, col: Col, size: number, spaced = false): HelpSeg {
    return { text, col, size, spaced, x: 0, adv: 0 };
}
function raw(segs: HelpSeg[], gap = 6, dot = false, rule = false, center = false, indent = 0): Raw {
    return { segs, gap, dot, rule, center, indent };
}
function sec(name: string, tag: string): Raw {
    const segs = [S(name, kInk, MID, true)];
    if (tag) segs.push(S(tag, kInkSoft, SMALL));
    return raw(segs, 16, false, true);
}
function bullet(segs: HelpSeg[], gap = 6): Raw { return raw(segs, gap, true, false, false, 16); }

function content(): Raw[] {
    const list: Raw[] = [
        raw([S('复数扫雷', kInk, T, true), S('  游戏规则', kInkSoft, SMALL)], 26, false, false, true),

        sec('一、棋盘与目标', ''),
        raw([S('1. 棋盘下藏着四种雷：', kInk, BODY), S('+1', kRealMine, BIG), S('、', kInk, BODY),
             S('-1', kRealMine, BIG), S('、', kInk, BODY), S('+i', kImagMine, BIG), S('、', kInk, BODY),
             S('-i', kImagMine, BIG), S('，数量大致各四分之一。', kInk, BODY)]),
        raw([S('2. 难度三档：', kInk, BODY), S('新手 9x9 十二雷', kInk, MID), S('、', kInk, BODY),
             S('中级 16x16 四十雷', kInk, MID), S('、', kInk, BODY), S('高级 24x16 七十二雷', kInk, MID),
             S('。另有 CUSTOM 自定义，行列雷数任选，还能指定实雷与虚雷的配比。', kInk, BODY)]),
        raw([S('3. 胜利二选一：', kInk, BODY), S('翻开全部安全格', kInk, BIG), S('（雷怎么标都行）；或', kInk, BODY),
             S('把每一颗雷都标成正确类型', kInk, BIG), S('（不多不少）。', kInk, BODY)]),

        sec('二、数字怎么读', ' （本游戏的核心）'),
        raw([S('翻开一格，显示的是它周围八格里所有雷的复数之和。', kInk, BODY)]),
        raw([S('1. 和是纯实数：直接显示并带正负号，', kInk, BODY), S('蓝色', kRealMine, BODY), S('，如 ', kInk, BODY),
             S('+2', kRealMine, BODY), S('、', kInk, BODY), S('-2', kRealMine, BODY), S('。', kInk, BODY)]),
        raw([S('2. 和是纯虚数：', kInk, BODY), S('绿色', kImagMine, BODY), S('，如 ', kInk, BODY),
             S('+i', kImagMine, BODY), S('、', kInk, BODY), S('-3i', kImagMine, BODY), S('。', kInk, BODY)]),
        raw([S('3. 和是实虚混合：显示这个和的模长，也就是长度，', kInk, BODY), S('紫色', kMixHint, BODY), S('，如 ', kInk, BODY),
             S('√2', kMixHint, BODY), S('、', kInk, BODY), S('√5', kMixHint, BODY), S('。', kInk, BODY)]),
        raw([S('4. 和恰好抵消为零：', kInk, BODY), S('黄色 0', kZeroHint, BODY), S('，和“周围没有雷”的空格区分（真空格没有数字）。', kInk, BODY)]),
        raw([S('例一', kInk, MID), S('：周围藏 +1、+1、-1，净和 +1，这格显示 ', kInk, BODY), S('+1', kRealMine, BIG), S('。', kInk, BODY)]),
        raw([S('例二', kInk, MID), S('：周围藏 +1、+i，净和 1+i，长度 √2，这格显示 ', kInk, BODY), S('√2', kMixHint, BIG), S('。', kInk, BODY)]),
        raw([S('例三', kInk, MID), S('：周围藏 +1、-1，完全抵消，这格显示 ', kInk, BODY), S('0', kZeroHint, BIG), S('。', kInk, BODY)]),
        raw([S('要点', kBadMark, MID), S('：混合提示只给长度、不给方向。同样是 √5，和可能是 2+i，也可能是 1+2i，还可能是它们的相反数。', kInk, BODY),
             S('你要从一片数字里联立解出每颗雷的类型，这就是本游戏的难点与乐趣。', kInk, BODY)]),

        sec('三、与经典扫雷最大的三个不同', ' （先看这里）'),
        raw([S('1. ', kInk, BODY), S('数字会抵消', kInk, BIG),
             S('：提示不是雷数。显示 +1 的格子周围可能只有一颗雷，也可能有5颗（比如 +1、+1、-1,+i,-i）。', kInk, BODY)]),
        raw([S('2. ', kInk, BODY), S('黄色 0 不代表周围没雷', kBadMark, BIG),
             S('：它只说明净和为零，一定有雷，可能是藏着 +1 与 -1、或 +i 与 -i 各一对。而且 ', kInk, BODY),
             S('0 不会自动连锁展开', kBadMark, BIG), S('，每一格都要你自己点。把 0 当安全区是', kInk, BODY),
             S('新手第一大死法', kBadMark, BODY),
             S('；正确用法是把 0 当强线索：它的八个邻居里的雷必须正好配成抵消对。', kInk, BODY)]),
        raw([S('3. ', kInk, BODY), S('赢法不止一种', kInk, BIG),
             S('：不翻开所有格子、把全部雷按正确类型标满（一颗不多一颗不少），同样获胜（', kInk, BODY),
             S('如果你足够厉害', kInkSoft, SMALL), S('）。', kInk, BODY)]),

        sec('四、操作说明', ''),
        bullet([S('左键', kInk, BIG), S(' 点击未翻开的格子：翻开。', kInk, BODY), S('第一次点击永远安全', kRealMine, BODY),
                S('（布雷发生在首点之后，首点及其周围八格保证无雷）。', kInk, BODY)]),
        bullet([S('右键', kInk, BIG), S('：弹出标记菜单，五项：+1、-1、+i、-i、清除。', kInk, BODY)]),
        bullet([S('数字键 1 到 5', kInk, BIG), S('：鼠标悬在盖着的格子上直接标记。1 是 +1，2 是 -1，3 是 +i，4 是 -i，5 是清除。', kInk, BODY)]),
        bullet([S('中键，或快速双击已翻开的数字格', kInk, BIG),
                S('：批量开格。当这格周围每一颗雷都被你标对类型时，一键翻开其余邻居；没标对则什么都不会发生，不惩罚、不误爆（', kInk, BODY),
                S('除非开了BOOM', kInkSoft, SMALL), S('）。', kInk, BODY)]),
        bullet([S('表头 EASY、MEDIUM、HARD、CUSTOM 切换难度或开自定义面板；齿轮是设置。', kInkSoft, SMALL)]),
        bullet([S('计时只在你看着棋盘时走：切窗口或打开任何菜单会自动暂停（', kInk, BODY),
                S('TIME PAUSED', kInkSoft, SMALL), S('）。', kInk, BODY)]),

        sec('五、胜负判定', ''),
        bullet([S('踩到雷：', kInk, BODY), S('BOOM', kBadMark, BIG, true), S('，失败，全图揭晓。', kInk, BODY)]),
        bullet([S('路径一', kImagMine, MID), S('：翻开全部安全格即获胜；这时候雷怎么标、标不标都随你，甚至标错也不算错。', kInk, BODY)]),
        bullet([S('路径二', kImagMine, MID), S('：把每一颗雷都标成正确类型即获胜；但必须不多不少——在安全格上多插旗会破坏判胜，雷漏标一颗也不算。', kInk, BODY)]),
        bullet([S('友好规则，翻转也算对', kRealMine, BIG),
                S('：若某片区域从所有数字上根本分辨不出 +1 与 -1 谁是谁，那么把这片区域的标记整体对调（+1 与 -1 互换，或 +i 与 -i 互换）同样判胜，与全部提示统计一致就是解。但', kInk, BODY),
                S('跨轴不行', kBadMark, BODY), S('：实轴的雷标成虚轴一定算错（', kInk, BODY),
                S('除非没有其他依赖的雷', kInkSoft, SMALL), S('）。', kInk, BODY)]),
        bullet([S('表头计数 ', kInk, BODY), S('±1 xN', kRealMine, BODY), S('、', kInk, BODY), S('±i xM', kImagMine, BODY),
                S(' 表示两个轴各自还有多少颗没被正确标记，收官时非常有用；硬核玩家可勾选隐藏计数。', kInk, BODY)]),

        sec('六、进阶玩法', ''),
        bullet([S('模长模式', kInk, BIG),
                S('：勾选表头"总是显示模长"后，所有非零提示一律只给模长，不分正负、不分实虚；判胜标准同步变为：标记恰好盖住每一颗雷，且每格标记之和的模长与提示吻合，不再要求类型逐一对应。', kInk, BODY),
                S('更难，也更纯粹', kInkSoft, SMALL), S('。', kInk, BODY)]),
        bullet([S('种子分享', kInk, BIG),
                S('：菜单 COPY SEED 复制本局参数，朋友在 LOAD SEED 贴入，玩到的就是与你完全相同的雷，连首点位置都包含在内。SAVE PROGRESS 复制的是当前进度，别人可以从你的半局接着玩。格式不符会提示 ', kInk, BODY),
                S('BAD SEED', kBadMark, SMALL), S('。', kInk, BODY)]),
        bullet([S('外观', kInk, BIG),
                S('：设置里可换背景图、自定义四种标记的字符或图片；所有设置即时保存，RESTORE ALL 一键回默认。', kInk, BODY),
                S('辨色吃力的玩家可以把四个标记换成形状迥异的字符或图片，不靠颜色也能玩。', kInk, BODY)], 16),
    ];
    // 声明只挂带默认背景图素材的部署（ty0712 生产版）。参赛版等无图部署在 index.html
    // 置 window.CMS_NO_BG，包里没图却挂着画师声明反而引人问「图在哪」。
    let noBg = false;
    try { noBg = (window as unknown as { CMS_NO_BG?: unknown }).CMS_NO_BG !== undefined; } catch { /* 无 window 环境 */ }
    if (!noBg) {
        list.push(
            raw([S('背景图声明', kRealMine, MID), S(' 默认背景来源：画师 木子森森森MORI 《云上城堡》  原链接：', kInk, BODY),
                 S('【【绘画过程】洛天依-云上城堡-哔哩哔哩】', kInk, BODY), S(' https://b23.tv/rHT5In4', kInk, BODY)], 10),
            raw([S('未经授权，严禁商用！', kBadMark, BIG)], 8),
        );
    }
    return list;
}

export interface HelpLayout { rows: HelpRow[]; totalH: number }

export function buildHelp(ctx: Ctx, panelW: number): HelpLayout {
    const CW = panelW - 52;
    const list = content();

    // 量宽：逐字累加；超过"续行宽度"的片段按字符边界切开（单片段本身就可能超行宽）
    for (const ln of list) {
        const maxw = CW - ln.indent - 14;
        const out: HelpSeg[] = [];
        for (const sg of ln.segs) {
            const chars = Array.from(sg.text);
            const extra = sg.spaced ? 1 : 0;
            let full = 0;
            for (const ch of chars) full += textAdvance(ctx, ch, sg.size) + extra;
            if (full <= maxw || chars.length < 2) { sg.adv = full; out.push(sg); continue; }
            let piece: HelpSeg = { ...sg, text: '', adv: 0 };
            for (const ch of chars) {
                const wch = textAdvance(ctx, ch, sg.size) + extra;
                if (piece.text && piece.adv + wch > maxw) { out.push(piece); piece = { ...sg, text: '', adv: 0 }; }
                piece.text += ch;
                piece.adv += wch;
            }
            if (piece.text) out.push(piece);
        }
        ln.segs = out;
    }

    const rows: HelpRow[] = [];
    let y = 0;
    for (const ln of list) {
        let b = 0;
        let cur = 0, avail = CW - ln.indent;
        const flush = (e: number, first: boolean) => {
            const row: HelpRow = {
                y, h: BODY + 7, indent: first ? ln.indent : ln.indent + 14,
                dot: first && ln.dot, rule: first && ln.rule, center: first && ln.center,
                dotCol: ln.segs.length ? ln.segs[0].col : kInk, ruleFrom: 0, segs: [],
            };
            let x = 0, maxsz = BODY;
            for (let i = b; i < e; ++i) {
                const sg = { ...ln.segs[i], x };
                x += sg.adv + 2;
                maxsz = Math.max(maxsz, ln.segs[i].size);
                row.segs.push(sg);
            }
            if (row.rule) row.ruleFrom = x + 12;
            row.h = maxsz + 7;
            y += row.h + 2;
            rows.push(row);
            b = e;
        };
        for (let i = 0; i < ln.segs.length; ++i) {
            if (cur > 0 && cur + ln.segs[i].adv > avail) { flush(i, b === 0); cur = 0; avail = CW - (ln.indent + 14); }
            cur += ln.segs[i].adv + 2;
        }
        flush(ln.segs.length, b === 0);
        y += ln.gap;
    }
    return { rows, totalH: y };
}
