// 配置持久化：对齐桌面端 src/desktop/SettingsIO.h 的 SettingsData。
// 桌面端把图片放在 config/ 目录，网页端改存 localStorage 里的 dataURL，
// 键名/取值语义（default | char | image）保持一致，字段一一对应。

export interface MarkerSetting {
    kind: 'default' | 'char' | 'image';
    value: string; // kind=char 时是单字符；kind=image 时是 dataURL
}

export interface SettingsData {
    cellR: number; cellG: number; cellB: number; // 默认 #66CCFF
    chordFail: 'silent' | 'hint' | 'boom';
    doubleClickMs: number;   // 150..1500
    hideCounts: boolean;
    alwaysMagnitude: boolean;
    ustcMode: boolean;
    animFx: boolean;         // 动效总开关（prefers-reduced-motion 时强制关闭）
    starDensity: number;     // 星光密度 0..7.12 颗/100×100 CSS px（0 = 彻底关闭）
    starScale: number;       // 星光半径倍率 0.6..3.0，默认 1.7
    bgAlpha: number;         // 0..191（桌面端 kBgAlphaMax），140 为默认
    background: MarkerImage; // 空 dataURL = 使用内置背景
    marker: (MarkerImage & { ch: string })[]; // 下标 1..4 对应 +1 -1 +i -i
    blank: MarkerImage & { ch: string };
}

export interface MarkerImage { dataUrl: string }

const KEY = 'complex-minesweeper.settings.v1';
export const kBgAlphaMax = 191;
export const kDoubleClickMinMs = 150;
export const kDoubleClickMaxMs = 1500;
export const kStarDensityMin = 0;   // 0 = 彻底关闭星光层
export const kStarDensityMax = 7.12; // 颗/100×100px 的上限（实际颗数按视口面积换算）
export const kStarScaleMin = 0.6;   // ×10 存整数（3.0 → 30），避开浮点
export const kStarScaleMax = 3.0;

export function defaultSettings(): SettingsData {
    return {
        cellR: 102, cellG: 204, cellB: 255,
        chordFail: 'hint',
        doubleClickMs: 400,
        hideCounts: false,
        alwaysMagnitude: false,
        ustcMode: false,
        animFx: true,
        starDensity: 2.17,
        starScale: 1.7,
        bgAlpha: 140,
        background: { dataUrl: '' },
        marker: [
            { dataUrl: '', ch: '' }, { dataUrl: '', ch: '' },
            { dataUrl: '', ch: '' }, { dataUrl: '', ch: '' }, { dataUrl: '', ch: '' },
        ],
        blank: { dataUrl: '', ch: '' },
    };
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === 'number' ? v : parseInt(String(v ?? ''), 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, Math.round(n)));
};

const clampFloat = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    if (!Number.isFinite(n)) return dflt;
    return Math.max(lo, Math.min(hi, n));
};

export function loadSettings(): SettingsData {
    const d = defaultSettings();
    let raw: string | null = null;
    try { raw = localStorage.getItem(KEY); } catch { return d; }
    if (!raw) return d;
    try {
        const o = JSON.parse(raw);
        d.cellR = clampInt(o.cellR, 0, 255, 102);
        d.cellG = clampInt(o.cellG, 0, 255, 204);
        d.cellB = clampInt(o.cellB, 0, 255, 255);
        if (o.chordFail === 'silent' || o.chordFail === 'hint' || o.chordFail === 'boom') d.chordFail = o.chordFail;
        d.doubleClickMs = clampInt(o.doubleClickMs, kDoubleClickMinMs, kDoubleClickMaxMs, 400);
        d.hideCounts = o.hideCounts === true;
        d.alwaysMagnitude = o.alwaysMagnitude === true;
        d.ustcMode = o.ustcMode === true;
        // 旧存档没有这个键 → 默认开（!==false），别把老用户的动效静默关掉
        d.animFx = o.animFx !== false;
        // 2026-10-22 密度单位改成「颗/100×100px」。旧存档没有 starUnit 标记，
        // 值是参考视口 1512×982 下的颗数 —— 先换算再夹到新区间，老用户观感不变。
        // 但**没有这个键**时不能折默认值（默认 2.17 会被旧刻度折成 0.01，等于把星光关了）。
        const rawSrc = o.starDensity ?? o.starCount;
        const hasDensity = rawSrc !== undefined && rawSrc !== null;
        const rawDensity = clampFloat(rawSrc, 0, 800, 2.17);
        const migrated = (o.starUnit === 2 || !hasDensity) ? rawDensity : rawDensity * 10000 / (1512 * 982);
        d.starDensity = Math.round(clampFloat(migrated, kStarDensityMin, kStarDensityMax, 2.17) * 100) / 100;
        d.starScale = clampFloat(o.starScale, kStarScaleMin, kStarScaleMax, 1.7);
        d.bgAlpha = clampInt(o.bgAlpha, 0, kBgAlphaMax, 140);
        // ★ 只收白名单形态：坏值一律不写进 cfg（写了就会被下次 save 永久固化）
        if (isSafeImageSrc(o.background, true)) d.background.dataUrl = o.background as string;
        const mk = (src: unknown, dst: { dataUrl: string; ch: string }) => {
            if (!src || typeof src !== 'object') return;
            const s = src as Record<string, unknown>;
            if (isSafeImageSrc(s.dataUrl, false)) dst.dataUrl = s.dataUrl as string;
            if (typeof s.ch === 'string' && s.ch.length <= 2) dst.ch = s.ch;
        };
        if (Array.isArray(o.marker)) for (let i = 1; i <= 4; ++i) mk(o.marker[i], d.marker[i]);
        mk(o.blank, d.blank);
    } catch { /* 配置损坏就用默认值 */ }
    return d;
}

export function saveSettings(d: SettingsData): boolean {
    try {
        localStorage.setItem(KEY, JSON.stringify({
            cellR: d.cellR, cellG: d.cellG, cellB: d.cellB,
            chordFail: d.chordFail, doubleClickMs: d.doubleClickMs,
            hideCounts: d.hideCounts, alwaysMagnitude: d.alwaysMagnitude, ustcMode: d.ustcMode,
            animFx: d.animFx,
            starDensity: d.starDensity, starUnit: 2, starScale: d.starScale,
            bgAlpha: d.bgAlpha,
            background: d.background.dataUrl,
            marker: d.marker, blank: d.blank,
        }));
        return true;
    } catch (e) {
        console.warn('settings save failed', e); // localStorage 满（图片过大）
        return false;
    }
}

// 图片体积上限（2026-10-21 安全审查 L5）。这是**自我 DoS 防护**，不是安全边界：
// 超大图片 decode 时会在移动端把标签页直接顶爆（几百 MB 的 PNG 就能），
// 而且 base64 之后还要塞进 localStorage。传不给别人，所以只是自伤。
const kMaxImageBytes = 24 * 1024 * 1024;
// ★（2026-10-21 复审 ★5）字节数管不住 PNG 炸弹：24 MB 的压缩图可以是 20000×20000，
//   解开来是 1.6 GB 的 RGBA —— 上面那道闸门对它完全无感，因为判的是**压缩后**的大小。
//   所以要再加一道按**解码后像素数**的闸门。4096×4096≈1680 万像素（≈64 MB RGBA），
//   而产物本来就要等比缩到 maxDim（背景 2560 / marker 1280）以内：超过这个数的
//   原图一寸都用不上，拒掉不损失任何画质。
const kMaxImagePixels = 4096 * 4096;

// ── 图片字段的取值形状白名单（2026-10-21 安全审计 P8）──────────────────
// 为什么必须在这里拦：`loadSettings` 是 localStorage → cfg 的**唯一入口**。
// 只在渲染侧（renderer.ensureImages 的 img.src）拦的话，坏值会留在 cfg 里，
// 下一次 saveSettings 就把它永久写回 localStorage；而且 cfg 的消费者不止渲染，
// 逐消费者加防御必然漏。
//
// 允许的三种形态（与 renderer 的约定一致）：
//   ''                      → 用内置图
//   '#rrggbb'               → 纯色背景（仅背景允许）
//   'data:image/…;base64,…' → readImageFile 的产物
// 明确拒绝：javascript: / http(s):// / //host/ / data:text/html / data:image/svg+xml / blob:
const kDataImageHead = /^data:image\/(?:png|jpeg|jpg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+/;
const kHex6 = /^#[0-9a-fA-F]{6}$/;

export function isSafeImageSrc(v: unknown, allowColor: boolean): boolean {
    if (typeof v !== 'string' || v === '') return false;
    if (allowColor && kHex6.test(v)) return true;
    if (!v.startsWith('data:image/')) return false;
    // 只看前 96 个字符，不扫描可能 24MB 的 base64
    return kDataImageHead.test(v.slice(0, 96));
}

export type ImageReject = '' | 'too-large' | 'too-big' | 'decode';
//: w/h 只在 reason='too-big' 时有值（那一刻已经解码出 naturalWidth/Height）；
//: 字节闸门在 decode 之前，拿不到尺寸，所以是可选的。提示语要带上它们，
//: 否则「超过 4096×4096」会被读成「长边超了」，而判据其实是总像素。
export type ImageRead = { dataUrl: string | null; why: ImageReject; w?: number; h?: number };

// 读文件 -> 等比缩到 maxDim 以内 -> 编码。有透明通道就留 PNG，否则 JPEG（体积小得多）。
// 失败时不只返回 null，还带回**为什么**：三种原因要给用户的话不一样，
// 「图片太大」和「读不出来」混成一句，用户只会反复试同一张注定失败的图。
export function readImageFile(file: File, maxDim: number, quality = 0.85): Promise<ImageRead> {
    return new Promise((resolve) => {
        // 先按字节数拒掉，别等 decode —— 到这一步已经太晚了
        if (file.size > kMaxImageBytes) {
            console.warn('image too large, skipped', file.size, file.name);
            resolve({ dataUrl: null, why: 'too-large' });
            return;
        }
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            const w = img.naturalWidth, h = img.naturalHeight;
            if (w <= 0 || h <= 0) { resolve({ dataUrl: null, why: 'decode' }); return; }
            // 这一句必须排在画 canvas 之前：drawImage + getImageData 才是那两次
            // 真正的巨额分配，光看 file.size 拦不住它们。
            if (w * h > kMaxImagePixels) {
                console.warn('image pixels too large, skipped', w, h, file.name);
                resolve({ dataUrl: null, why: 'too-big', w, h });
                return;
            }
            const sc = Math.min(1, maxDim / Math.max(w, h));
            const cw = Math.max(1, Math.round(w * sc)), ch = Math.max(1, Math.round(h * sc));
            const cv = document.createElement('canvas');
            cv.width = cw; cv.height = ch;
            const c = cv.getContext('2d');
            if (!c) { resolve({ dataUrl: null, why: 'decode' }); return; }
            c.drawImage(img, 0, 0, cw, ch);
            let hasAlpha = false;
            try {
                const px = c.getImageData(0, 0, cw, ch).data;
                for (let i = 3; i < px.length; i += 4 * 37) { if (px[i] < 255) { hasAlpha = true; break; } }
            } catch { hasAlpha = false; }
            resolve({ dataUrl: cv.toDataURL(hasAlpha ? 'image/png' : 'image/jpeg', quality), why: '' });
        };
        img.onerror = () => { URL.revokeObjectURL(url); resolve({ dataUrl: null, why: 'decode' }); };
        img.src = url;
    });
}

/** 三种失败各配一句用户看得懂的话（★5：静默失败比报错更难查）。 */
export function imageRejectNote(why: ImageReject, w?: number, h?: number): string {
    if (why === 'too-large') return 'IMAGE TOO LARGE · 图片文件超过 24 MB，换小一点的';
    if (why === 'too-big') {
        // 与桌面端同一口径：报实际宽高与万像素，用户才知道该缩到多少；
        // 判据是总像素（4096×4096 ≈ 1677 万），不是长边。
        if (w && h && w > 0 && h > 0) {
            const wan = Math.round((w * h) / 10000);
            return `IMAGE TOO BIG · 图片尺寸 ${w}×${h}（约 ${wan} 万像素），超过 4096×4096 的上限，换小一点的`;
        }
        return 'IMAGE TOO BIG · 图片尺寸超过 4096×4096，换小一点的';
    }
    return 'BAD IMAGE · 图片读取失败';
}

export function loadImage(dataUrl: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        if (!dataUrl) { resolve(null); return; }
        // 公开 helper：同样只接受白名单形态（纯色不算图片，这里不放行）
        if (!isSafeImageSrc(dataUrl, false)) { resolve(null); return; }
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => resolve(null);
        img.src = dataUrl;
    });
}
