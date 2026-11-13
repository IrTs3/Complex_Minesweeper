// 背景音乐播放器（仅 web 端）：本地音频文件 + IndexedDB 持久化 + 三种播放顺序。
// renderer 不 import 本模块的运行时代码（只 import 类型），Blob 全部留在这一层；
// 经 game.ts 的 onChange 回调把只读快照推给 renderer.setMusicUi()。
//
// 持久化分两层：
//   IndexedDB cms-audio.v1 / store tracks {id, blob} —— 音频数据本体（项目首个 IDB）；
//   localStorage cms.music.v1 —— 元数据与播放状态。刻意不进 SettingsData：
//   RESTORE ALL 只重建 cfg，音乐清单天然活过恢复默认。
// IDB 打开失败（隐私模式等）→ 降级为会话内可用（Blob 留内存），必须吭声说明刷新会丢。

export type MusicOrder = 'seq' | 'rev' | 'random';

export interface MusicTrackMeta {
    id: string;
    name: string;
    size: number;
    dur: number;   // 秒；测不出来记 0
    added: number; // 单调递增的入库序号
}

/** 单向快照：renderer 画 MUSIC 页签与 ♪ 徽标用的全部信息 */
export interface MusicFetchProg {
    /** 当前第几首（0 起，跟 manifest 顺序） */
    i: number;
    n: number;
    /** 显示名 */
    name: string;
    loaded: number;
    /** Content-Length；0=服务器没给（只显示已下字节） */
    total: number;
}

export interface MusicUiState {
    tracks: MusicTrackMeta[];
    order: MusicOrder;
    volume: number;       // 0..100
    curId: string | null;
    curSec: number;
    dur: number;
    playing: boolean;
    /** 当前曲在**设置面板列表**中的位次（1 起、从上到下；0=没有当前曲）。
     *  ⚠️ 故意不用 passIdx：随机洗牌后播放序 ≠ 面板序，徽标序号必须永远对列表。 */
    pos: number;
    /** ♪ 控制条用户拖放位置（画布坐标；-1=没拖过，用棋盘上方默认位） */
    barX: number;
    barY: number;
    /** 默认歌单首拉进行中（设置面板 MUSIC 页显示进度 + 放弃；null=没有在拉） */
    fetchProg: MusicFetchProg | null;
    /** 自动播放等待解锁的提示（''=没有；画在 ♪ 控制条上方，点击后消失） */
    unlockHint: string;
}

// 容量闸门（2026-11-12 用户点名：无损友好）：单曲 80MB / 50 首 / 总量 1GB
const kMaxTrackBytes = 80 * 1024 * 1024;
const kMaxTracks = 50;
const kMaxTotalBytes = 1024 * 1024 * 1024;
// 服务器默认歌单（cmsui「默认歌单」上架的）只发这三种，File 包装时用
const kDefaultMime: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac'
};
// 视频入库（2026-11-12 追加）：只收音频轨——解码提取存 16bit WAV（无损），
// 大小闸按提取后的 WAV 算；输入文件先探时长估体积，超闸不白解一遍。
const kMaxVideoInputBytes = 1024 * 1024 * 1024;  // 视频输入上限 1GB（解码要整文件进内存）
const kWavBytesPerSec = 44100 * 2 * 2;           // 估体口径：立体声 44.1k 16bit ≈ 176KB/s

const kSaveKey = 'cms.music.v1';
const kDbName = 'cms-audio.v1';
const kStore = 'tracks';

function newId(): string {
    try { return crypto.randomUUID(); } catch {
        return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    }
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

// —— IndexedDB 薄封装（全部 promise 化；失败返回空值，调用方决定怎么吭声） ——

function idbOpen(): Promise<IDBDatabase | null> {
    return new Promise(res => {
        try {
            const req = indexedDB.open(kDbName, 1);
            req.onupgradeneeded = () => { req.result.createObjectStore(kStore, { keyPath: 'id' }); };
            req.onsuccess = () => res(req.result);
            req.onerror = () => res(null);
            req.onblocked = () => res(null);
        } catch { res(null); }
    });
}

function idbReq<T>(db: IDBDatabase, mode: IDBTransactionMode,
    run: (s: IDBObjectStore) => IDBRequest): Promise<T | null> {
    return new Promise(res => {
        try {
            const tx = db.transaction(kStore, mode);
            const req = run(tx.objectStore(kStore));
            req.onsuccess = () => res(req.result as T);
            req.onerror = () => res(null);
        } catch { res(null); }
    });
}

function idbPut(db: IDBDatabase, id: string, blob: Blob): Promise<boolean> {
    return new Promise(res => {
        try {
            const tx = db.transaction(kStore, 'readwrite');
            tx.objectStore(kStore).put({ id, blob });
            tx.oncomplete = () => res(true);
            tx.onerror = () => res(false);   // 配额满等；调用方拒收该曲并吭声
            tx.onabort = () => res(false);
        } catch { res(false); }
    });
}

function idbGet(db: IDBDatabase, id: string): Promise<Blob | null> {
    return new Promise(async res => {
        const rec = await idbReq<{ id: string; blob: Blob }>(db, 'readonly', s => s.get(id));
        res(rec ? rec.blob : null);
    });
}

function idbDelete(db: IDBDatabase, id: string): Promise<void> {
    return new Promise(res => {
        try {
            const tx = db.transaction(kStore, 'readwrite');
            tx.objectStore(kStore).delete(id);
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        } catch { res(); }
    });
}

function idbClear(db: IDBDatabase): Promise<void> {
    return new Promise(res => {
        try {
            const tx = db.transaction(kStore, 'readwrite');
            tx.objectStore(kStore).clear();
            tx.oncomplete = () => res();
            tx.onerror = () => res();
        } catch { res(); }
    });
}

function idbCount(db: IDBDatabase): Promise<number> {
    return new Promise(async res => {
        const n = await idbReq<number>(db, 'readonly', s => s.count());
        res(n ?? -1);
    });
}

/** 服务器端存储名白名单：gate_manager push 生成的固定形 `t<hex><hex>.<ext>`。
 *  manifest 的 file 字段只认这个形（2026-11-13 审计 [低]）：`../`、控制字符、
 *  奇形怪状的名字一律当坏条目跳过，不给「静默抓取任意同源资源」留门。 */
function safeStorageName(f: string): boolean {
    return /^t[0-9a-f]+\.[a-z0-9]{2,5}$/.test(f);
}

/** 临时 Audio 元素测时长；error = -1（不可解码）；5s 超时按 0（能播但拿不到时长） */
function probeDuration(blob: Blob): Promise<number> {
    return new Promise(res => {
        const url = URL.createObjectURL(blob);
        const a = new Audio();
        let done = false;
        const finish = (d: number) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            res(d);
        };
        const timer = setTimeout(() => finish(0), 5000);
        a.addEventListener('loadedmetadata', () => finish(isFinite(a.duration) ? a.duration : 0));
        a.addEventListener('error', () => finish(-1));
        a.src = url;
    });
}

function isVideoFile(f: File): boolean {
    if (f.type.startsWith('video/')) return true;
    return /\.(mp4|m4v|webm|mov|mkv|avi)$/i.test(f.name);
}

/** 视频容器 → AudioBuffer（解码音频轨）；失败 null。用完即关的临时 AudioContext */
async function decodeAudioBlob(blob: Blob): Promise<AudioBuffer | null> {
    const AC = window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();
    try {
        return await ctx.decodeAudioData(await blob.arrayBuffer());
    } catch {
        return null;
    } finally {
        void ctx.close();
    }
}

/** AudioBuffer → 16bit PCM WAV（无损转存：音质=解码出的原始 PCM，体积 ≈176KB/秒·立体声） */
function audioBufferToWav(buf: AudioBuffer): Blob {
    const ch = buf.numberOfChannels, rate = buf.sampleRate, len = buf.length;
    const ab = new ArrayBuffer(44 + len * ch * 2);
    const v = new DataView(ab);
    const wstr = (off: number, s: string) => { for (let i = 0; i < s.length; ++i) v.setUint8(off + i, s.charCodeAt(i)); };
    wstr(0, 'RIFF'); v.setUint32(4, 36 + len * ch * 2, true); wstr(8, 'WAVE');
    wstr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
    wstr(36, 'data'); v.setUint32(40, len * ch * 2, true);
    const chans: Float32Array[] = [];
    for (let c = 0; c < ch; ++c) chans.push(buf.getChannelData(c));
    let off = 44;
    for (let i = 0; i < len; ++i) {
        for (let c = 0; c < ch; ++c) {
            const s = Math.max(-1, Math.min(1, chans[c][i]));
            v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            off += 2;
        }
    }
    return new Blob([ab], { type: 'audio/wav' });
}

export class MusicPlayer {
    private tracks_: MusicTrackMeta[] = [];
    private order_: MusicOrder = 'seq';
    private volume_ = 60;
    private curId_: string | null = null;
    private loadedId_: string | null = null; // audio_ 里实际装载的曲（暂停态切歌只挪指针不装载）
    private curSec_ = 0;          // 待恢复/已暂停时的播放位置
    private wasPlaying_ = false;  // 意图播放：显式暂停才清零，自动播放被拒不亮红灯
    private defaultDone_ = false; // 服务器默认歌单已拉成过（落盘后永不重拉，服务器换歌也不重拉）
    private fetchAbort_: AbortController | null = null; // 首拉进行中才有；abort = 用户点「放弃」
    private fetchProg_: MusicFetchProg | null = null;
    private fetchNames_: string[] = [];  // 本轮 manifest 的显示名（放弃时按名删已入库的默认曲）
    private pass_: string[] = [];      // 当前播放顺序（random 模式为一个不重复 pass）
    private passIdx_ = -1;
    private barX_ = -1;           // ♪ 控制条拖放位置（-1=默认位）
    private barY_ = -1;
    private lastPlayedId_: string | null = null; // random pass 尾重洗时防「新首曲=上一首」
    private audio_: HTMLAudioElement;
    private curUrl_: string | null = null;
    private db_: IDBDatabase | null = null;
    private sessionBlobs_ = new Map<string, Blob>(); // IDB 不可用时的会话内兜底
    private lastPersist_ = 0;
    private unlocking_ = false;
    private mutedByUs_ = false;   // 自动播放被拒后我们自己的静音（区别于音量=0）；手势解锁时撤
    private unlockHint_ = '';     // 画在 ♪ 控制条上方的解锁提示（''=没有；go() 里清）

    /** 拒绝/提示走这里（game.ts 注入 renderer.setSeedNote） */
    note: (msg: string) => void = () => { };
    /** 任何可见状态变化后回调（game.ts 注入，推送快照给 renderer） */
    onChange: () => void = () => { };

    constructor() {
        this.audio_ = new Audio();
        this.audio_.preload = 'auto';
        const a = this.audio_;
        a.addEventListener('timeupdate', () => {
            const now = Date.now();
            if (now - this.lastPersist_ > 3000) { this.lastPersist_ = now; this.persist(); }
        });
        a.addEventListener('pause', () => { this.persist(); this.onChange(); });
        a.addEventListener('play', () => this.onChange());
        a.addEventListener('ended', () => { this.lastPlayedId_ = this.curId_; this.next(true); });
        // 切页/关页前把进度落盘：timeupdate 的 3s 节流可能刚好没赶上
        const flush = () => this.persist();
        document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
        window.addEventListener('pagehide', flush);
    }

    // ================================================================
    //  播放顺序
    // ================================================================

    /** 曲目数组即手动顺序（拖拽排序直接改它）；seq=原序 / rev=倒序 / random=整 pass 洗 */
    private rebuildPass(): void {
        const ids = this.tracks_.map(t => t.id);
        if (this.order_ === 'seq') this.pass_ = ids;
        else if (this.order_ === 'rev') this.pass_ = ids.slice().reverse();
        else {
            const a = ids.slice();
            for (let i = a.length - 1; i > 0; --i) {
                const j = Math.floor(Math.random() * (i + 1));
                [a[i], a[j]] = [a[j], a[i]];
            }
            // pass 尾重洗后新首曲不与上一 pass 末曲相同（用 Math.random；rng.ts 是布雷 RNG，别碰）
            if (a.length > 1 && this.lastPlayedId_ && a[0] === this.lastPlayedId_) {
                const j = 1 + Math.floor(Math.random() * (a.length - 1));
                [a[0], a[j]] = [a[j], a[0]];
            }
            this.pass_ = a;
        }
        const k = this.curId_ ? this.pass_.indexOf(this.curId_) : -1;
        this.passIdx_ = k >= 0 ? k : 0;
    }

    order(): MusicOrder { return this.order_; }
    setOrder(o: MusicOrder): void {
        if (o === this.order_) return;
        this.order_ = o;
        this.rebuildPass();
        this.persist();
        this.onChange();
    }

    move(from: number, to: number): void {
        const n = this.tracks_.length;
        if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
        const [t] = this.tracks_.splice(from, 1);
        this.tracks_.splice(to, 0, t);
        this.rebuildPass();
        this.persist();
        this.onChange();
    }

    // ================================================================
    //  播放控制
    // ================================================================

    playing(): boolean { return !!this.curId_ && !this.audio_.paused && !this.audio_.ended; }

    private async loadCurrent(autoplay: boolean): Promise<void> {
        const id = this.curId_;
        const meta = id ? this.tracks_.find(t => t.id === id) : null;
        if (!id || !meta) return;
        const blob = this.sessionBlobs_.get(id) ?? (this.db_ ? await idbGet(this.db_, id) : null);
        if (!blob) {
            this.loadedId_ = null;
            this.note('BAD MUSIC · 「' + meta.name + '」音频数据已丢失（可能被浏览器清理），已从列表移除');
            this.removeTrack(id);
            return;
        }
        if (this.curUrl_) URL.revokeObjectURL(this.curUrl_);
        this.curUrl_ = URL.createObjectURL(blob);
        this.loadedId_ = id;
        const a = this.audio_;
        const resumeAt = this.curSec_;
        a.src = this.curUrl_;
        a.load();
        const onMeta = () => {
            try { if (resumeAt > 0 && resumeAt < a.duration - 1) a.currentTime = resumeAt; } catch { /* 忽略 */ }
        };
        a.addEventListener('loadedmetadata', onMeta, { once: true });
        if (autoplay) await this.tryPlay();
    }

    private async tryPlay(): Promise<void> {
        try {
            await this.audio_.play();
        } catch {
            // 自动播放策略拒绝：不清 wasPlaying（意图仍在）。先试**静音起播**——
            // 静音态 Chrome/Safari 都放行，进度/时长照常走，不卡在原地；
            // 第一次手势解除静音出声。静音也被拒才退回纯等待的老路。
            // 提示不走进度条上方横幅（会 8s 过期），改挂在 ♪ 控制条上直到点击。
            try {
                this.audio_.muted = true;
                this.mutedByUs_ = true;
                await this.audio_.play();
                this.unlockHint_ = '已静音起播 · 点一下页面任意处出声';
            } catch {
                this.audio_.muted = false;
                this.mutedByUs_ = false;
                this.unlockHint_ = '自动播放被拦 · 点一下页面任意处继续';
            }
            this.armUnlock();
            this.onChange();
        }
    }

    /** 恢复播放：当前曲还没装载（暂停态切过歌）就先装载再自动播，防止放出 audio_ 里的旧曲 */
    private async playCurrent(): Promise<void> {
        if (this.curId_ !== this.loadedId_) await this.loadCurrent(true);
        else await this.tryPlay();
    }

    /** NotAllowedError 后的一次性解锁：任意 pointerdown/keydown 再试一次 */
    private armUnlock(): void {
        if (this.unlocking_) return;
        this.unlocking_ = true;
        const go = () => {
            this.unlocking_ = false;
            window.removeEventListener('pointerdown', go, true);
            window.removeEventListener('keydown', go, true);
            if (this.mutedByUs_) {
                this.audio_.muted = false;
                this.mutedByUs_ = false;
            }
            if (this.unlockHint_) { this.unlockHint_ = ''; this.onChange(); }
            if (this.wasPlaying_ && this.curId_) this.playCurrent();
        };
        window.addEventListener('pointerdown', go, { capture: true, once: true });
        window.addEventListener('keydown', go, { capture: true, once: true });
    }

    async toggle(): Promise<void> {
        if (!this.curId_) {
            // 没有当前曲：从播放顺序头开始
            if (!this.tracks_.length) { this.note('MUSIC · 列表是空的，先 ADD TRACKS 加几首'); return; }
            this.passIdx_ = clamp(this.passIdx_, 0, this.pass_.length - 1);
            this.curId_ = this.pass_[this.passIdx_];
            this.curSec_ = 0;
            this.wasPlaying_ = true;
            await this.loadCurrent(true);
            this.persist();
            this.onChange();
            return;
        }
        if (this.playing()) {
            this.wasPlaying_ = false;
            this.audio_.pause();
            this.curSec_ = this.audio_.currentTime;
            this.persist();
        } else {
            this.wasPlaying_ = true;
            await this.playCurrent();
        }
        this.onChange();
    }

    /** 步进到播放顺序中的下一首；auto=true 表示由 ended 触发（继续播） */
    async next(auto = false): Promise<void> {
        if (!this.tracks_.length) return;
        if (this.passIdx_ + 1 >= this.pass_.length) {
            if (this.order_ === 'random') {
                this.passIdx_ = -1;
                this.rebuildPass();   // 尾重洗：pass 内不重复
                this.passIdx_ = 0;
            } else {
                this.passIdx_ = 0;
            }
        } else {
            ++this.passIdx_;
        }
        this.curId_ = this.pass_[this.passIdx_];
        this.curSec_ = 0;
        if (!auto && !this.wasPlaying_) { this.persist(); this.onChange(); return; } // 暂停态切歌：只挪指针不出声
        await this.loadCurrent(true);
        this.persist();
        this.onChange();
    }

    async prev(): Promise<void> {
        if (!this.tracks_.length) return;
        // 随机模式沿当前 pass 回退（不是重洗）；到头回卷到 pass 尾
        this.passIdx_ = this.passIdx_ <= 0 ? this.pass_.length - 1 : this.passIdx_ - 1;
        this.curId_ = this.pass_[this.passIdx_];
        this.curSec_ = 0;
        if (!this.wasPlaying_) { this.persist(); this.onChange(); return; }
        await this.loadCurrent(true);
        this.persist();
        this.onChange();
    }

    /** 快退/快进 dt 秒，夹在 [0, 曲长]（−15s 不足落 0；+10s 不超曲长）。
     *  当前曲未装载（暂停态切过歌）时直接挪 curSec_，别去 seek audio_ 里的旧曲。 */
    seekBy(dt: number): void {
        if (!this.curId_) return;
        if (this.curId_ !== this.loadedId_) {
            const meta = this.tracks_.find(t => t.id === this.curId_);
            if (!meta || !(meta.dur > 0)) return;
            this.curSec_ = clamp(this.curSec_ + dt, 0, meta.dur);
        } else {
            const a = this.audio_;
            if (!isFinite(a.duration) || a.duration <= 0) return;
            a.currentTime = clamp(a.currentTime + dt, 0, a.duration - 0.05);
            this.curSec_ = a.currentTime;
        }
        this.persist();
        this.onChange();
    }

    /** 绝对跳转到 t 秒（进度条拖动用）；seekFrac 传 0..1 */
    seekTo(t: number): void {
        if (!this.curId_) return;
        if (this.curId_ !== this.loadedId_) {
            const meta = this.tracks_.find(t => t.id === this.curId_);
            if (!meta || !(meta.dur > 0)) return;
            this.curSec_ = clamp(t, 0, meta.dur);
        } else {
            const a = this.audio_;
            if (!isFinite(a.duration) || a.duration <= 0) return;
            a.currentTime = clamp(t, 0, a.duration - 0.05);
            this.curSec_ = a.currentTime;
        }
        this.persist();
        this.onChange();
    }

    seekFrac(f: number): void {
        const d = this.curId_ === this.loadedId_
            ? this.audio_.duration
            : (this.tracks_.find(t => t.id === this.curId_)?.dur ?? 0);
        if (!this.curId_ || !isFinite(d) || d <= 0) return;
        this.seekTo(clamp(f, 0, 1) * d);
    }

    /** ♪ 控制条拖放落点（画布坐标）；存 localStorage 随音乐状态活过 RESTORE ALL */
    setBarPos(x: number, y: number): void {
        this.barX_ = Math.round(x);
        this.barY_ = Math.round(y);
        this.persist();
        this.onChange();
    }

    volume(): number { return this.volume_; }
    /** 播放中的实时位置（game.ts 主循环每帧拉一次喂进度条） */
    currentTime(): number { return this.audio_.currentTime; }
    setVolume(v: number): void {
        v = clamp(Math.round(v), 0, 100);
        if (v === this.volume_) return;
        this.volume_ = v;
        this.audio_.volume = v / 100;
        this.persist();
        this.onChange();
    }
    nudgeVolume(d: number): void { this.setVolume(this.volume_ + d); }

    // ================================================================
    //  曲目增删
    // ================================================================

    private totalBytes(): number { return this.tracks_.reduce((s, t) => s + t.size, 0); }

    /** quiet=true：静默入库（不出「已加入」提示、不重载音频）——默认歌单后台续传用。
     *  但播放器「等米下锅」时（wasPlaying_ 在、没声、也没挂手势解锁）例外地续播：
     *  首曲播完下一首刚到，不续就是干等到下个月。 */
    async addFiles(files: File[], opts: { quiet?: boolean } = {}): Promise<void> {
        let added = 0, videoCount = 0, lastAdded = '';
        let nextAdded = this.tracks_.reduce((m, t) => Math.max(m, t.added), 0) + 1;
        const rejects: string[] = [];
        for (const f of files) {
            if (this.tracks_.length >= kMaxTracks) { rejects.push('列表已满（上限 50 首）'); break; }
            // 大小闸一律按**入库体**算：普通音频=原文件；视频=提取出的 WAV（先探时长估体积，超闸不白解）
            let store: Blob = f;
            let dur: number;
            if (isVideoFile(f)) {
                if (f.size > kMaxVideoInputBytes) {
                    rejects.push(f.name + '（' + (f.size / 1048576).toFixed(0) + 'MB > 视频输入上限 1GB）');
                    continue;
                }
                const pd = await probeDuration(f);
                if (pd < 0) { rejects.push(f.name + '（无法解码）'); continue; }
                const est = pd * kWavBytesPerSec;
                if (est > kMaxTrackBytes) {
                    rejects.push(f.name + '（音频约 ' + Math.round(est / 1048576) + 'MB > 单曲上限 80MB，全长 ' +
                        Math.round(pd / 60) + ' 分钟）');
                    continue;
                }
                const buf = await decodeAudioBlob(f);
                if (!buf) { rejects.push(f.name + '（音频轨解码失败）'); continue; }
                store = audioBufferToWav(buf);
                dur = buf.duration;
                ++videoCount;
            } else {
                if (f.size > kMaxTrackBytes) { rejects.push(f.name + '（' + (f.size / 1048576).toFixed(1) + 'MB > 单曲上限 80MB）'); continue; }
                dur = await probeDuration(f);
                if (dur < 0) { rejects.push(f.name + '（无法解码）'); continue; }
            }
            if (store.size > kMaxTrackBytes) {
                rejects.push(f.name + '（音频 ' + (store.size / 1048576).toFixed(1) + 'MB > 单曲上限 80MB）');
                continue;
            }
            if (this.totalBytes() + store.size > kMaxTotalBytes) { rejects.push(f.name + '（总容量将超 1GB）'); continue; }
            const id = newId();
            if (this.db_) {
                if (!(await idbPut(this.db_, id, store))) { rejects.push(f.name + '（浏览器存储写入失败）'); continue; }
            } else {
                this.sessionBlobs_.set(id, store);
            }
            this.tracks_.push({ id, name: f.name.replace(/\.[^.]+$/, ''), size: store.size, dur, added: nextAdded++ });
            if (!this.curId_) { this.curId_ = id; this.curSec_ = 0; }
            lastAdded = id;
            ++added;
        }
        this.rebuildPass();
        this.persist();
        if (rejects.length) this.note('MUSIC · 拒收 ' + rejects.length + ' 项：' + rejects.slice(0, 2).join('；') +
            (rejects.length > 2 ? ' 等' : ''));
        else if (added && !opts.quiet) this.note('MUSIC · 已加入 ' + added + ' 首' +
            (videoCount ? '（' + videoCount + ' 个视频已提取音频存 WAV）' : ''));
        this.onChange();
        if (added && this.curId_ && this.loadedId_ !== this.curId_) {
            // 指针处还没装上声（首次入库/暂停态切过歌）：静默载入让徽标显示曲名；意图在播就直接开播。
            // 已装上（loadedId_===curId_）绝不重载——播放中加歌会把正在听的曲子从头再放
            await this.loadCurrent(this.wasPlaying_ || this.playing());
        } else if (added && opts.quiet && this.wasPlaying_ && !this.playing() && !this.unlocking_) {
            // 后台续传补上「等米下锅」的下一首：指针挪过去接着播，别让玩家对着沉默干等
            this.curId_ = lastAdded;
            this.rebuildPass();
            await this.playCurrent();
        }
    }

    async removeTrack(id: string): Promise<void> {
        const idx = this.tracks_.findIndex(t => t.id === id);
        if (idx < 0) return;
        const wasCur = id === this.curId_;
        this.tracks_.splice(idx, 1);
        this.sessionBlobs_.delete(id);
        if (this.db_) void idbDelete(this.db_, id);
        if (wasCur) {
            if (!this.tracks_.length) {
                this.curId_ = null;
                this.loadedId_ = null;
                this.curSec_ = 0;
                this.wasPlaying_ = false;
                this.audio_.pause();
                if (this.curUrl_) { URL.revokeObjectURL(this.curUrl_); this.curUrl_ = null; }
                this.audio_.removeAttribute('src');
            } else {
                this.rebuildPass();
                this.passIdx_ = clamp(idx, 0, this.pass_.length - 1);
                this.curId_ = this.pass_[this.passIdx_];
                this.curSec_ = 0;
                if (this.curUrl_) { URL.revokeObjectURL(this.curUrl_); this.curUrl_ = null; }
                await this.loadCurrent(this.wasPlaying_);
            }
        } else {
            this.rebuildPass();
        }
        this.persist();
        this.onChange();
    }

    /** 一键清空：列表 + IDB 全删（调用方负责二次确认） */
    async clearAll(): Promise<void> {
        const n = this.tracks_.length;
        this.tracks_ = [];
        this.sessionBlobs_.clear();
        this.curId_ = null;
        this.loadedId_ = null;
        this.curSec_ = 0;
        this.wasPlaying_ = false;
        this.audio_.pause();
        if (this.curUrl_) { URL.revokeObjectURL(this.curUrl_); this.curUrl_ = null; }
        this.audio_.removeAttribute('src');
        if (this.db_) await idbClear(this.db_);
        this.persist();
        this.onChange();
        this.note('MUSIC CLEARED · 已清空 ' + n + ' 首并删除缓存音频');
    }

    // ================================================================
    //  服务器默认歌单（cmsui「默认歌单」上架）—— 只在本地从未拉成过时试一次
    // ================================================================

    /** 首拉语义（2026-11-12 用户裁决）：defaultDone 落盘后**永不重拉**——
     *  服务器之后换歌单对老玩家无感，也不烧玩家流量；拉取失败（网络/半途）不落
     *  旗标，下次打开接着试（已入库的按曲名跳过，绝不重复入库）；清站点数据 =
     *  旗标和音频库一起没 = 变回新玩家，重拉当下最新歌单。
     *  线上闸是「每 IP 每天 5 次完整拉取流程」（2026-11-13 裁决，authd 计数；
     *  manifest 花 1 次、随后音频串共享这次额度），所以这里绝不自动重试。
     *  拉取中设置面板 MUSIC 页显示进度（fetchProg_），可点「放弃」：中止 + 删掉
     *  已入库的默认曲 + defaultDone 落 1 永不重拉（2026-11-12 追加裁决）。 */
    private async fetchDefault(): Promise<void> {
        if (this.defaultDone_) return;
        if (this.fetchAbort_) return; // 手动下载进行中不抢（按钮已置灰，这是代码层的最后一道）
        let manifest: { tracks?: Array<{ file?: unknown; name?: unknown }> };
        try {
            // 同源相对路径：线上受 /music-default/ 闸保护，cmsgate cookie 自动带上
            const r = await fetch('music-default/manifest.json');
            if (r.status === 404) return; // 没配歌单/超额：正常态，静默（每次都提示就成噪音了）
            if (!r.ok) { this.note('MUSIC · 默认歌单拉取失败（HTTP ' + r.status + '），下次打开再试'); return; }
            manifest = await r.json();
        } catch { return; } // 网络不通：下次打开再试
        const raw = (manifest && manifest.tracks) as unknown;
        const list = Array.isArray(raw) ? raw : [];
        if (!list.length) return; // 空歌单不落旗标：管理员以后配了歌，首访玩家还能拿到
        const stripExt = (s: string) => s.replace(/\.[^.]+$/, '');
        // 待拉清单：坏条目跳过（完成时吭声）、已入库的按曲名去重（半途重试绝不重复入库）
        let bad = 0;
        const items: Array<{ file: string; disp: string; ext: string }> = [];
        for (const t of list) {
            if (!t || typeof t.file !== 'string' || !safeStorageName(t.file)) { ++bad; continue; }
            const disp = (typeof t.name === 'string' && t.name) ? t.name : t.file;
            const ext = (t.file.match(/\.[^.]+$/) || [''])[0];
            // 显示名拼上真扩展名再交给 addFiles：它的去扩展名规则会把名字完整还原，
            // 也躲开「名字里带点」被误当扩展名截掉（如「01. 云上城堡」）
            if (this.tracks_.some(tr => tr.name === stripExt(disp + ext))) continue;
            items.push({ file: t.file, disp, ext });
        }
        if (!items.length) {
            // 全部已入库（半途失败后的重试形态）：落旗标，别白烧明天的拉取额度
            this.defaultDone_ = true;
            this.persist();
            this.onChange();
            return;
        }
        const r2 = await this.pullDefault(items, 'first');
        if (r2 === 'done' && bad) this.note('MUSIC · 清单里有 ' + bad + ' 条坏条目被跳过');
    }

    /** 默认歌单拉取主循环（首拉与手动**同一套机制**，2026-11-12 用户裁决）：
     *  逐首下载、到手即入库（quiet 续传）——第一首落地就试着出声，绝不逼玩家等全单拉完。
     *  返回 done / aborted / failed；旗标与话术按模式分派。 */
    private async pullDefault(
        items: Array<{ file: string; disp: string; ext: string }>,
        mode: 'first' | 'manual'): Promise<'done' | 'aborted' | 'failed'> {
        this.fetchAbort_ = new AbortController();
        this.fetchNames_ = items.map(it => (it.disp + it.ext).replace(/\.[^.]+$/, ''));
        this.fetchProg_ = { i: 0, n: items.length, name: '', loaded: 0, total: 0 };
        this.onChange(); // renderer 只在 onChange 收快照：拉取态一开始就得吭声，否则进度行永远不出现
        let addedAny = false;
        for (let i = 0; i < items.length; ++i) {
            const it = items[i];
            try {
                const blob = await this.fetchWithProgress('music-default/' + it.file, i, items.length, it.disp, it.ext);
                const file = new File([blob], it.disp + it.ext,
                    { type: kDefaultMime[it.ext.toLowerCase()] || 'application/octet-stream' });
                if (!addedAny && mode === 'first') this.wasPlaying_ = true; // 首访语义：进来就该有声音；被拒走 armUnlock
                await this.addFiles([file], { quiet: addedAny });
                addedAny = true;
            } catch {
                const aborted = this.fetchAbort_ && this.fetchAbort_.signal.aborted;
                // ⚠️ endFetch 会清 fetchNames_，「放弃」清理要按名单删曲——必须先清理再收状态
                if (aborted) {
                    if (mode === 'first') this.abortDefaultCleanup(); // 删已入库 + 旗标落 1（用户裁决，内部自带 endFetch）
                    else { this.endFetch(); this.note('MUSIC · 已停止手动下载（已入库的保留）'); }
                    return 'aborted';
                }
                this.endFetch();
                this.onChange();
                this.note(mode === 'first'
                    ? 'MUSIC · 默认歌单没拉全（' + it.disp + ' 下载失败），已入库的保留，下次打开接着试'
                    : 'MUSIC · 手动下载中断（' + it.disp + ' 下载失败），已入库的保留');
                return 'failed';
            }
        }
        this.endFetch();
        if (mode === 'first') {
            this.defaultDone_ = true; // 全部到手：旗标落 1
            this.persist();
            if (addedAny) this.note('MUSIC · 默认歌单首拉完成，已入库 ' + items.length + ' 首');
        }
        this.onChange();
        return 'done';
    }

    private endFetch(): void {
        this.fetchAbort_ = null;
        this.fetchProg_ = null;
        this.fetchNames_ = [];
    }

    /** 「放弃」语义（用户裁决）：中止下载、删掉已入库的默认曲（按本轮 manifest 名单）、
     *  defaultDone 落 1 永不重拉——用户不想听就别再烦他，想再听走清站点数据。 */
    private abortDefaultCleanup(): void {
        const names = this.fetchNames_;
        this.endFetch();
        void (async () => {
            for (const t of this.tracks_.filter(t => names.includes(t.name)))
                await this.removeTrack(t.id);
            this.defaultDone_ = true;
            this.persist();
            this.onChange();
            this.note('MUSIC · 已放弃默认歌单下载，不再自动拉取（想再拉就清站点数据）');
        })();
    }

    /** 用户点「放弃」（设置面板 MUSIC 页）。没在拉就 no-op。 */
    abortDefaultFetch(): void {
        if (this.fetchAbort_) this.fetchAbort_.abort();
    }

    /** 手动拉取默认歌单（MUSIC 页「下载歌单」钮；二次确认在 renderer/game 层）。
     *  与首拉**同一套增量机制**（pullDefault，2026-11-12 用户裁决）：不问也不动
     *  defaultDone 旗标；已入库的按曲名跳过；配额（50 首 / 1GB / 单曲 80MB）按
     *  manifest 报的体积预检，放得下几首拉几首，放不下的吭声；逐首入库、
     *  第一首落地即出声；「放弃」中止 = 已入库的保留（不再是整批作废）。
     *  自动拉取进行中禁止手动（按钮置灰 + fetchAbort_ 代码闸）。 */
    async manualDownload(): Promise<void> {
        if (this.fetchAbort_) { this.note('MUSIC · 已有下载在进行（先等它跑完或点放弃）'); return; }
        let manifest: { tracks?: Array<{ file?: unknown; name?: unknown; size?: unknown }> };
        try {
            const r = await fetch('music-default/manifest.json');
            if (r.status === 404) { this.note('MUSIC · 服务器没配默认歌单（或今日清单拉取次数已用完）'); return; }
            if (!r.ok) { this.note('MUSIC · 清单拉取失败（HTTP ' + r.status + '）'); return; }
            manifest = await r.json();
        } catch { this.note('MUSIC · 清单拉取失败（网络不通）'); return; }
        const raw = (manifest && manifest.tracks) as unknown;
        const list = Array.isArray(raw) ? raw : [];
        const stripExt = (s: string) => s.replace(/\.[^.]+$/, '');
        const todo: Array<{ file: string; disp: string; ext: string; size: number }> = [];
        for (const t of list) {
            if (!t || typeof t.file !== 'string' || !safeStorageName(t.file)) continue;
            const disp = (typeof t.name === 'string' && t.name) ? t.name : t.file;
            const ext = (t.file.match(/\.[^.]+$/) || [''])[0];
            if (this.tracks_.some(tr => tr.name === stripExt(disp + ext))) continue;
            todo.push({ file: t.file, disp, ext, size: typeof t.size === 'number' && t.size > 0 ? t.size : 0 });
        }
        // 配额预检：size 没报的当放得下（入库时 addFiles 还有兜底闸逐一拒）
        const skip: string[] = [];
        let roomN = kMaxTracks - this.tracks_.length;
        let roomB = kMaxTotalBytes - this.totalBytes();
        const queue = todo.filter(it => {
            if (it.size > kMaxTrackBytes) { skip.push(it.disp + '（>单曲上限 80MB）'); return false; }
            if (roomN <= 0) { skip.push(it.disp + '（列表已满 50 首）'); return false; }
            if (it.size > roomB) { skip.push(it.disp + '（总容量将超 1GB）'); return false; }
            --roomN;
            roomB -= it.size;
            return true;
        });
        if (!queue.length) {
            this.note('MUSIC · 没有能入库的曲子：' + (skip.length
                ? skip.slice(0, 2).join('；') + (skip.length > 2 ? ' 等' : '')
                : '默认歌单是空的'));
            return;
        }
        const r = await this.pullDefault(queue, 'manual');
        if (r === 'done' && skip.length) this.note('MUSIC · 配额不足跳过 ' + skip.length + ' 首：' +
            skip.slice(0, 2).join('；') + (skip.length > 2 ? ' 等' : ''));
    }

    /** 单曲流式下载：边收边报字节进度（Content-Length 没给就只报已下）。 */
    private async fetchWithProgress(url: string, i: number, n: number,
        name: string, ext: string): Promise<Blob> {
        const signal = this.fetchAbort_ ? this.fetchAbort_.signal : undefined;
        const r = await fetch(url, { signal });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const total = Number(r.headers.get('content-length') || 0);
        const mime = kDefaultMime[ext.toLowerCase()] || 'application/octet-stream';
        if (!r.body) return await r.blob();
        const reader = r.body.getReader();
        const chunks: BlobPart[] = [];
        let loaded = 0;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value); loaded += value.length;
                if (loaded > kMaxTrackBytes) {
                    // 实时体积闸（2026-11-13 审计 [低]）：80MB 闸原来在下载完成后才生效，
                    // 恶意/配错的 manifest 一条巨无霸条目就能把标签页内存顶爆
                    try { await reader.cancel(); } catch { /* 流已经断了就算了 */ }
                    throw new Error('单曲超过 80MB 上限，已中止下载');
                }
            }
            this.fetchProg_ = { i, n, name, loaded, total };
            this.onChange(); // 逐 chunk 推：进度行/字节读数跟着下载动
        }
        return new Blob(chunks, { type: mime });
    }

    // ================================================================
    //  持久化与恢复
    // ================================================================

    private persist(): void {
        try {
            const save = {
                ver: 1,
                order: this.order_,
                volume: this.volume_,
                curId: this.curId_,
                curSec: this.playing() ? this.audio_.currentTime : this.curSec_,
                wasPlaying: this.wasPlaying_,
                barX: this.barX_,
                barY: this.barY_,
                defaultDone: this.defaultDone_ ? 1 : 0,
                tracks: this.tracks_
            };
            localStorage.setItem(kSaveKey, JSON.stringify(save));
        } catch { /* localStorage 满：音乐状态存不下就算了，不刷屏提示 */ }
    }

    /** 启动时恢复：读元数据 → 打开 IDB → 拿回当前曲 → wasPlaying 则试播 */
    async restore(): Promise<void> {
        this.db_ = await idbOpen();
        if (!this.db_) {
            this.note('MUSIC · 浏览器不允许本地数据库：本次会话内可用，刷新后音乐清单会丢失');
        }
        let save: any = null;
        try { save = JSON.parse(localStorage.getItem(kSaveKey) || 'null'); } catch { /* 读坏当空 */ }
        if (save && save.ver === 1 && Array.isArray(save.tracks)) {
            this.tracks_ = save.tracks.filter((t: any) =>
                t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.size === 'number');
            this.order_ = save.order === 'rev' || save.order === 'random' ? save.order : 'seq';
            this.volume_ = clamp(Math.round(save.volume ?? 60), 0, 100);
            this.curSec_ = typeof save.curSec === 'number' && isFinite(save.curSec) ? save.curSec : 0;
            this.wasPlaying_ = !!save.wasPlaying;
            this.curId_ = typeof save.curId === 'string' && this.tracks_.some(t => t.id === save.curId)
                ? save.curId : null;
            this.barX_ = typeof save.barX === 'number' && isFinite(save.barX) ? save.barX : -1;
            this.barY_ = typeof save.barY === 'number' && isFinite(save.barY) ? save.barY : -1;
            // 新字段不 bump ver：restore 对 ver===1 有硬断言，bump 会把所有老存档全丢
            this.defaultDone_ = !!save.defaultDone;
        }
        this.audio_.volume = this.volume_ / 100;
        this.rebuildPass();
        if (this.curId_) {
            await this.loadCurrent(this.wasPlaying_);
        }
        this.onChange();
        // 首拉放全站最低优先级：等 load（游戏自己的资源全落定）+ 浏览器空闲才开始，
        // 8s 兜底防止长期繁忙的机器永远轮不到；老玩家（旗标在）连这个调度都不会进
        const kick = () => {
            const ric = (window as { requestIdleCallback?: (cb: () => void, o?: { timeout?: number }) => number })
                .requestIdleCallback;
            if (ric) ric(() => void this.fetchDefault(), { timeout: 8000 });
            else setTimeout(() => void this.fetchDefault(), 3000);
        };
        if (document.readyState === 'complete') kick();
        else window.addEventListener('load', kick, { once: true });
    }

    // ================================================================
    //  快照与调试
    // ================================================================

    /** 当前曲总时长：优先 audio 元数据；音频还没装载完/没拿到时长就退回
     *  入库时探好的曲目 dur——否则断点恢复的曲子在元数据到位前会显示 0:00、
     *  进度条归零（「0:27 / 0:00」bug，2026-11-12 用户实测）。 */
    private curDur(): number {
        const a = this.audio_.duration;
        if (isFinite(a) && a > 0) return a;
        const meta = this.curId_ ? this.tracks_.find(t => t.id === this.curId_) : null;
        return meta ? meta.dur : 0;
    }

    getUi(): MusicUiState {
        return {
            tracks: this.tracks_.slice(),
            order: this.order_,
            volume: this.volume_,
            curId: this.curId_,
            curSec: this.playing() ? this.audio_.currentTime : this.curSec_,
            dur: this.curDur(),
            playing: this.playing(),
            pos: this.curId_ ? Math.max(0, this.tracks_.findIndex(t => t.id === this.curId_)) + 1 : 0,
            barX: this.barX_,
            barY: this.barY_,
            fetchProg: this.fetchProg_,
            unlockHint: this.unlockHint_
        };
    }

    /** CDP 测试口（game.ts 挂到 window.__cmsMusic） */
    async debug(): Promise<Record<string, unknown>> {
        return {
            tracks: this.tracks_,
            order: this.order_,
            volume: this.volume_,
            curId: this.curId_,
            loadedId: this.loadedId_,
            curSec: this.audio_.currentTime,
            dur: this.curDur(),
            playing: this.playing(),
            wasPlaying: this.wasPlaying_,
            defaultDone: this.defaultDone_,
            fetchProg: this.fetchProg_,
            barX: this.barX_,
            barY: this.barY_,
            pass: this.pass_,
            passIdx: this.passIdx_,
            unlockHint: this.unlockHint_,
            idbOk: !!this.db_,
            idbCount: this.db_ ? await idbCount(this.db_) : this.sessionBlobs_.size
        };
    }
}
