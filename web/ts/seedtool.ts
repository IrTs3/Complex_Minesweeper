// 种子工具箱（DOM 弹窗）：种子串 ⇄ 明文 JSON，与 cmsui 的「种子工具箱」同逻辑。
// 编解码判定全部走同一份 seedcodec（与游戏端逐条一致），不会出现
// 「工具说行、游戏说 BAD SEED」的分裂。密钥必填：留空直接拒绝，
// 绝不自动用内置默认密钥（自动试密钥 = 自动传输正确密码，只有 cmsui 允许留空代读）；
// 界面永不回显密钥值。

import { decodeSeed, encodeSeed, seedIsSane, SeedData } from './seedcodec.js';

const dialog = document.getElementById('seed-tool') as HTMLDialogElement | null;
const inEl = document.getElementById('seed-tool-in') as HTMLTextAreaElement | null;
const keyEl = document.getElementById('seed-tool-key') as HTMLInputElement | null;
const outEl = document.getElementById('seed-tool-out') as HTMLPreElement | null;

function $(id: string): HTMLElement | null { return document.getElementById(id); }

function show(text: string, bad: boolean): void {
    if (!outEl) return;
    outEl.textContent = text;
    outEl.classList.toggle('bad', bad);
    outEl.hidden = false;
}

function summary(s: SeedData): string {
    const base = s.kind + ' · ' + s.cols + 'x' + s.rows + ' · ' +
        (s.manualSplit ? s.realMines + '+' + s.imagMines : s.mines) + ' 雷';
    return s.kind === 'save'
        ? base + ' · ' + s.phase + ' · 已开 ' + s.elapsedCs + 'cs'
        : base;
}

function key(): string { return keyEl ? keyEl.value.trim() : ''; }

function decode(): void {
    const text = (inEl && inEl.value.trim()) || '';
    if (!text) { show('（先粘贴种子串）', true); return; }
    const k = key();
    if (!k) { show('（先输入密钥）', true); return; }
    const s = decodeSeed(text, k);
    if (!s) {
        show('BAD SEED · 用你填的密钥解不开（密钥不对，或种子串已损坏）', true);
        return;
    }
    show('✓ ' + summary(s) + '\n\n' + JSON.stringify(s, null, 2), false);
}

function encode(): void {
    const text = (inEl && inEl.value.trim()) || '';
    if (!text) { show('（先粘贴明文 JSON）', true); return; }
    let s: unknown;
    try { s = JSON.parse(text); } catch (e) {
        show('JSON 解析失败：' + (e instanceof Error ? e.message : String(e)), true); return;
    }
    if (!s || typeof s !== 'object' || Array.isArray(s)) {
        show('JSON 必须是一个对象（{...}）', true); return;
    }
    const k = key();
    if (!k) { show('（先输入密钥）', true); return; }
    const seedText = encodeSeed(s as SeedData, k);
    // encodeSeed 不做合法性判定（与游戏端同口径），这里用 seedIsSane 提前告知
    const sane = seedIsSane(s as SeedData);
    show((sane ? '✓ ' : '⚠ 游戏端会拒绝（seedIsSane 不过）：') + '\n\n' + seedText, !sane);
}

export function openSeedToolbox(prefill: string): void {
    if (!dialog) return;
    if (inEl) inEl.value = prefill;
    if (outEl) { outEl.hidden = true; outEl.textContent = ''; }
    dialog.showModal();
    if (inEl) inEl.focus();
}

export function seedToolboxInit(): void {
    if (!dialog) return;
    const decodeBtn = $('seed-tool-decode');
    const encodeBtn = $('seed-tool-encode');
    const copyBtn = $('seed-tool-copy');
    const closeBtn = $('seed-tool-close');
    decodeBtn && decodeBtn.addEventListener('click', decode);
    encodeBtn && encodeBtn.addEventListener('click', encode);
    copyBtn && copyBtn.addEventListener('click', () => {
        if (!outEl || outEl.hidden || !outEl.textContent) { show('没有可复制的结果', true); return; }
        navigator.clipboard.writeText(outEl.textContent)
            .catch(() => show('复制失败（浏览器拒绝了剪贴板）', true));
    });
    closeBtn && closeBtn.addEventListener('click', () => dialog.close());
}
