// 画布绘制原语：把桌面端 SFML 的绘制语义（RectangleShape/CircleShape 的"内描边"、
// sf::Text 的 localBounds 定位）一比一翻译成 Canvas2D。
// 颜色一律用 sRGB 字面值——桌面端的 Display-P3 补偿是 macOS 专属，网页端不能移植。

export type Ctx = CanvasRenderingContext2D;

export interface Col { r: number; g: number; b: number; a: number }

export function C(r: number, g: number, b: number, a = 255): Col { return { r, g, b, a }; }

export function css(c: Col): string {
    return c.a >= 255 ? `rgb(${c.r},${c.g},${c.b})` : `rgba(${c.r},${c.g},${c.b},${(c.a / 255).toFixed(4)})`;
}

export function mix(a: Col, b: Col, k: number): Col {
    const l = (x: number, y: number) => Math.round(x + (y - x) * k);
    return { r: l(a.r, b.r), g: l(a.g, b.g), b: l(a.b, b.b), a: l(a.a, b.a) };
}

// —— 调色板（与 Renderer.cpp 顶部常量同值，去掉 P3 补偿）——
export const kWindowBg = C(233, 238, 244);
export const kPanel = C(214, 224, 235);
export const kCovered = C(102, 204, 255);      // #66CCFF 格子底色
export const kHover = C(140, 220, 255);         // 悬停更亮
export const kFlashYellow = C(255, 214, 10);    // 计数变动高亮
export const kOpened = C(244, 247, 250);
export const kOpenedZero = C(234, 239, 245);
// 已翻开、周围确实有雷、但实数和与虚数和都抵消为零的格子。
// 它必须和 kOpenedZero（真空格，会连锁展开）分开：两者玩法意义不同。
export const kOpenedCancel = C(224, 231, 241);
export const kGridLine = C(219, 227, 237);
export const kRealHint = C(37, 99, 235);        // 纯实和提示：蓝
export const kImagHint = C(15, 138, 90);        // 纯虚和提示：绿
export const kMixHint = C(142, 54, 205);        // 混合和提示（根式）：紫
export const kZeroHint = C(239, 228, 48);           // 抵消为零但有雷：黄（#EFE430）
export const kRealMine = C(37, 99, 235);        // ±1（实数）：蓝
export const kImagMine = C(15, 138, 90);        // ±i（虚数）：绿
export const kBadMark = C(214, 48, 49);         // 标错的红叉
export const kBoomBg = C(245, 183, 177);
export const kBadFlagBg = C(250, 224, 221);
export const kInk = C(44, 62, 80);
export const kInkSoft = C(108, 122, 137);
export const kBtnBg = C(255, 255, 255);
export const kBtnEdge = C(176, 190, 207);
export const kBtnActive = C(91, 155, 213);
export const kBarFill = C(63, 159, 214);        // 进度条填充：青蓝（66CCFF 家族中段，与登录页渐变同值）
export const kUstcGray = C(150, 150, 150, 217); // USTC 字母：约 85% 不透明

export interface Rect { x: number; y: number; w: number; h: number }

export function R(x: number, y: number, w: number, h: number): Rect { return { x, y, w, h }; }
export function inside(r: Rect, px: number, py: number): boolean {
    return px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h;
}
export function shifted(r: Rect, dx: number, dy: number): Rect { return R(r.x + dx, r.y + dy, r.w, r.h); }

// —— 字体：ASCII 用 IBM Plex Serif（与桌面端同一款），含非 ASCII 时整体走中文字体 ——
const SERIF = '"IBM Plex Serif", Georgia, "Times New Roman", serif';
const CJK = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';

export function fontFor(s: string): string { return /[^\u0000-\u007f]/.test(s) ? CJK : SERIF; }

// 、。这类标点墨迹矮，按"墨迹顶对齐"会整字浮到行顶（看着像乱码）。
// 改为与"同字体参考字（中文'中'/西文'0'）的墨迹顶"对齐：满高字不变，矮墨迹片段落回行底。
export function inkAlignDy(ctx: Ctx, s: string, size: number): number {
    if (!s) return 0;
    setFont(ctx, s, size);
    const a = ctx.measureText(s).actualBoundingBoxAscent;
    const ref = fontFor(s) === CJK ? '中' : '0';
    setFont(ctx, ref, size);
    const r = ctx.measureText(ref).actualBoundingBoxAscent;
    return r - a;
}

// SFML 的 setCharacterSize 只接受整数，这里同样取整，保证字宽/行高与桌面端一致
function px(size: number): number { return Math.max(1, Math.round(size)); }

export function setFont(ctx: Ctx, s: string, size: number): void {
    ctx.font = `${px(size)}px ${fontFor(s)}`;
}

export function textWidth(ctx: Ctx, s: string, size: number): number {
    if (!s) return 0;
    setFont(ctx, s, size);
    return ctx.measureText(s).width;
}

// 逐字符步进（帮助面板的贪心换行与"字距加宽"用）
export function textAdvance(ctx: Ctx, ch: string, size: number): number {
    setFont(ctx, ch, size);
    return ctx.measureText(ch).width;
}

// SFML textTLSpr：把字形包围盒的左上角放到 (x, y)
export function drawTL(ctx: Ctx, s: string, size: number, color: Col, x: number, y: number, bold = 0): void {
    if (!s) return;
    setFont(ctx, s, size);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const m = ctx.measureText(s);
    const ascent = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : px(size) * 0.75;
    const bx = Math.round(x), by = Math.round(y + ascent);
    ctx.fillStyle = css(color);
    if (bold > 0) { // SFML 的伪粗体 = 同色描边
        ctx.lineWidth = bold * 2;
        ctx.strokeStyle = css(color);
        ctx.lineJoin = 'round';
        ctx.miterLimit = 2;
        ctx.strokeText(s, bx, by);
    }
    ctx.fillText(s, bx, by);
}

// 左对齐绘制，超宽就截断加省略号。用于面板底部这类「没有裁剪区兜底」的说明文字：
// 面板窄于设计宽时整行会画到面板外、糊在棋盘上。
export function drawTLFit(ctx: Ctx, s: string, size: number, color: Col, x: number, y: number, maxW: number): void {
    if (!s) return;
    if (textWidth(ctx, s, size) <= maxW) { drawTL(ctx, s, size, color, x, y); return; }
    let out = '';
    for (const ch of s) {
        if (textWidth(ctx, out + ch + '…', size) > maxW) break;
        out += ch;
    }
    drawTL(ctx, out + '…', size, color, x, y);
}

// SFML textSpr：把字形包围盒的中心放到 (cx, cy)
export function drawC(ctx: Ctx, s: string, size: number, color: Col, cx: number, cy: number, bold = 0): void {
    if (!s) return;
    setFont(ctx, s, size);
    const m = ctx.measureText(s);
    const ascent = m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : px(size) * 0.75;
    const descent = m.actualBoundingBoxDescent > 0 ? m.actualBoundingBoxDescent : px(size) * 0.25;
    drawTL(ctx, s, size, color, cx - m.width * 0.5, cy - (ascent + descent) * 0.5, bold);
}

// —— 形状：SFML 的 outlineThickness 是"内描边"，这里同样把描边画在形状内部 ——
export function fillRect(ctx: Ctx, r: Rect, fill: Col): void {
    ctx.fillStyle = css(fill);
    ctx.fillRect(r.x, r.y, r.w, r.h);
}

export function box(ctx: Ctx, r: Rect, fill: Col, edge: Col, thickness: number): void {
    ctx.fillStyle = css(fill);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (thickness > 0) {
        ctx.lineWidth = thickness;
        ctx.strokeStyle = css(edge);
        ctx.strokeRect(r.x + thickness * 0.5, r.y + thickness * 0.5, r.w - thickness, r.h - thickness);
    }
}

export function circle(ctx: Ctx, cx: number, cy: number, rad: number, fill: Col, edge?: Col, thickness = 0): void {
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(0.5, rad), 0, Math.PI * 2);
    ctx.fillStyle = css(fill);
    ctx.fill();
    if (edge && thickness > 0) {
        ctx.lineWidth = thickness;
        ctx.strokeStyle = css(edge);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(0.5, rad - thickness * 0.5), 0, Math.PI * 2);
        ctx.stroke();
    }
}

export function thickLine(ctx: Ctx, ax: number, ay: number, bx: number, by: number, thickness: number, c: Col): void {
    if (Math.hypot(bx - ax, by - ay) <= 0.01) return;
    ctx.lineWidth = thickness;
    ctx.strokeStyle = css(c);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
}

export function arc(ctx: Ctx, cx: number, cy: number, radius: number, a0: number, a1: number, thickness: number, c: Col): void {
    ctx.lineWidth = thickness;
    ctx.strokeStyle = css(c);
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, a0, a1, a1 < a0);
    ctx.stroke();
}

// 手工绘制根号：短入笔 -> 下探 -> 上扬 -> 顶栏（与桌面端 drawRadicalSign 同几何）
export function radicalSign(ctx: Ctx, x: number, yTop: number, yBottom: number, barLen: number, thickness: number, col: Col): void {
    const w = Math.max(7, (yBottom - yTop) * 0.55);
    const mid = yTop + (yBottom - yTop) * 0.34;
    const bot = yBottom + (yBottom - yTop) * 0.30;
    thickLine(ctx, x, mid, x + w * 0.32, bot, thickness, col);
    thickLine(ctx, x + w * 0.32, bot, x + w * 0.66, yTop, thickness, col);
    thickLine(ctx, x + w * 0.42, yTop, x + w + barLen, yTop, thickness, col);
}

// 齿轮（设置按钮图标）：8 个齿 + 外圈 + 内孔
export function gear(ctx: Ctx, gcx: number, gcy: number, body: Col, hole: Col): void {
    const rOuter = 8.5, rInner = 3.2;
    ctx.fillStyle = css(body);
    for (let i = 0; i < 8; ++i) {
        const ang = i * Math.PI / 4;
        ctx.save();
        ctx.translate(gcx, gcy);
        ctx.rotate(ang);
        ctx.fillRect(-1.6, -(rOuter + 1.2), 3.2, 4.6);
        ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(gcx, gcy, rOuter, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = css(hole);
    ctx.beginPath();
    ctx.arc(gcx, gcy, rInner, 0, Math.PI * 2);
    ctx.fill();
}

// 复选框打勾（两段粗线，与桌面端同坐标）
export function checkMark(ctx: Ctx, bx: number, by: number, c: Col): void {
    thickLine(ctx, bx + 3.5, by + 8.5, bx + 6.8, by + 12, 2, c);
    thickLine(ctx, bx + 6.8, by + 12, bx + 12.5, by + 4, 2, c);
}

// 「周围有雷、但实数和+虚数和抵消为零」的格子：黄色 0（早期外面套的细环已裁掉）。
// 环已裁掉（2026-10-29 用户裁决）：黄色 0 本身足够与真空格区分（真空格没有数字）。
export function cancelZero(ctx: Ctx, cx: number, cy: number, cell: number): void {
    drawC(ctx, '0', cell * 0.46, kZeroHint, cx, cy, 0.6);
}

// 计数器三位显示：负数先写符号再补位（"-05" 而不是 "0-5"）
export function fmt3(v: number): string {
    const c = Math.max(-99, Math.min(999, v));
    if (c < 0) return '-' + String(-c).padStart(2, '0');
    return String(c).padStart(3, '0');
}

export function mineGlyph(t: number): string {
    return t === 1 ? '+1' : t === 2 ? '-1' : t === 3 ? '+i' : t === 4 ? '-i' : '';
}

export function isRealMine(t: number): boolean { return t === 1 || t === 2; }

export function mineColor(t: number): Col { return isRealMine(t) ? kRealMine : kImagMine; }

// 滚动条：轨道 + 滑块（几何同时供命中/拖动换算）
export interface ScrollGeo { ok: boolean; track: Rect; thumb: Rect; viewTop: number; viewH: number; maxS: number }

export function scrollbar(ctx: Ctx, tx: number, viewTop: number, viewH: number, totalH: number, scroll: number): ScrollGeo {
    if (totalH <= viewH + 1) return { ok: false, track: R(0, 0, 0, 0), thumb: R(0, 0, 0, 0), viewTop, viewH, maxS: 0 };
    const maxS = Math.max(0, totalH - viewH);
    const th = Math.max(30, viewH * viewH / totalH);
    const ty = viewTop + (viewH - th) * (maxS > 0 ? Math.min(scroll, maxS) / maxS : 0);
    const track = R(tx, viewTop, 3, viewH);
    const thumb = R(tx, ty, 3, th);
    fillRect(ctx, track, kBtnEdge);
    fillRect(ctx, thumb, kInkSoft);
    return { ok: true, track, thumb, viewTop, viewH, maxS };
}

// ============================ 复数数学（src/core/ComplexMath.h 移植）============================
export function squaredMagnitude(re: number, im: number): number { return re * re + im * im; }

// 返回 s 的最大平方因子 f：s = f^2 * r 且 r 无平方因子
export function largestSquareFactor(s: number): number {
    let f = 1;
    for (let k = 2; k * k <= s; ++k) {
        while (s % (k * k) === 0) { s /= k * k; f *= k; }
    }
    return f;
}

// 提示字符串（按模长，与符号无关）：整数 -> "5"；否则最简根式 -> "√2"、"2√2"…
export function formatHint(re: number, im: number): string {
    const m = Math.abs(re), n = Math.abs(im);
    if (m === 0 && n === 0) return '';
    if (n === 0) return String(m);
    if (m === 0) return String(n);
    const s = m * m + n * n;
    const f = largestSquareFactor(s);
    const r = s / (f * f);
    if (r === 1) return String(f);
    return (f > 1 ? String(f) : '') + '\u221A' + String(r);
}

// 纯实/纯虚：带正负号的和；纯抵消返回空串；混合：返回模长
export function formatHintSigned(re: number, im: number): string {
    if (im === 0 && re !== 0) return (re > 0 ? '+' : '-') + String(Math.abs(re));
    if (re === 0 && im !== 0) {
        const m = Math.abs(im);
        return (im > 0 ? '+' : '-') + (m === 1 ? 'i' : m + 'i');
    }
    return formatHint(re, im);
}

export const enum HintKind { Empty = 0, PureReal = 1, PureImag = 2, Mixed = 3 }

export function hintKind(re: number, im: number): HintKind {
    if (re === 0 && im === 0) return HintKind.Empty;
    if (im === 0) return HintKind.PureReal;
    if (re === 0) return HintKind.PureImag;
    return HintKind.Mixed;
}
