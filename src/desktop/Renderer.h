#pragma once
#include <SFML/Graphics.hpp>
#include <SFML/System/Clock.hpp>

#include <array>
#include <cstdint>
#include <memory>
#include <optional>
#include <utility>
#include <vector>
#include <string>

#include "core/Board.h"
#include "core/SetupConfig.h"

// 2026-10-22 裁决：求解器「自动解答」（H 键提示）暂不随发布版提供，
// 先在 docs/项目结构说明.md 里记录，待复核后再打开。
//   0 = 发布版：不注册 H 键、帮助页不列该条、不画提示高亮；
//   1 = 本地评审版。代码保留，复核后改这一处即可。
#define MS_SOLVER_HINTS 0

namespace ms {

enum class Phase { Playing, Won, Lost };

struct Hud {
    int remaining = 0; // 剩余雷数（雷数 - 旗数）
    double seconds = 0.0;   // 计时（秒，显示到 0.1s）
    Phase phase = Phase::Playing;
    bool paused = false; // 因窗口失焦暂停计时（用于提示）
};

// 渲染层：把 Board 数据画成像素画面（棋盘、提示数字/根式、HUD、结算横幅）。
class Renderer {
public:
    enum class HeaderAction { None, Restart, PlayAgain, Easy, Medium, Hard, Custom, Seed, Ustc, HideCounts, AlwaysMagnitude, Settings, Help };

    Renderer();

    // 重新计算布局（难度/棋盘尺寸变化时调用），窗口尺寸由此确定。
    void layoutFor(int cols, int rows);

    // —— 自适应格子尺寸 ——
    // 优先 40px；放不下就按屏幕缩小；最小 24px（再小就不好点了）
    static constexpr float kCellMax = 40.f;
    static constexpr float kCellMin = 24.f;
    static sf::Vector2f maxWindowSize();          // 屏幕可用区域（已扣菜单栏/程序坞余量）
    // 给行列算出格子边长。screenCap 由调用方传入：布局里必须只用**同一个**上限值，
    // 若这里现调一次 maxWindowSize()、钳制窗口时再调一次，两次不一致（屏幕状态会波动）
    // 就会算出"棋盘比窗口大"的布局，底部/右侧被裁掉。
    static float cellSizeFor(int cols, int rows, const sf::Vector2f& screenCap);
    static int maxColsAtMinimumCell();            // 24px 下最多几列（超出即非法）
    static int maxRowsAtMinimumCell();            // 24px 下最多几行
    sf::Vector2u windowSize() const { return sf::Vector2u(static_cast<unsigned>(L_.winW), static_cast<unsigned>(L_.winH)); }

    // 像素坐标 -> 格子 (r, c)；落在间隙/棋盘外返回 nullopt。
    std::optional<std::pair<int, int>> cellAt(sf::Vector2i px) const;

    HeaderAction headerActionAt(sf::Vector2i px) const;
    void setActiveDifficulty(int idx) { activeDiff_ = idx; }
    // 终局 PLAY AGAIN：main 每帧按 phase 同步；显示与点击判定同源，点棋盘观察不会使其消失
    void setPlayAgainVisible(bool v) { playAgainVisible_ = v; }
    // —— 终局重放二选（同局重开 / 开新局；点击判定与绘制同源）——
    enum class OverlayHit { None, SameRound, NewGame };
    OverlayHit overlayHit(sf::Vector2i px) const; // 终局且横幅未隐藏时生效

    // —— 游戏说明面板（标题右侧 ? 打开；点击任意处关闭，滚轮滚动）——
    bool helpOpen() const { return helpOpen_; }
    // 首次游玩自动弹玩法介绍：openHelp 的任何入口（F1/菜单/启动自动弹）都会顺手记「看过」。
    // 与网页端同款政策：看过就永不再弹；标记存 settings.ini 的 helpseen（网页端存 localStorage）。
    void openHelp() { helpOpen_ = true; markHelpSeen(); }
    bool helpSeen() const { return helpSeen_; }
    void closeHelp() { helpOpen_ = false; }
    void scrollHelp(float delta); // 滚轮 delta（上为正）；自动钳制
    // 滚动条可拖动：按下轨道=跳页并按住，按住滑块=跟手；面板其余位置点击仍是关闭
    bool helpHitScrollbar(sf::Vector2i px) const;
    void helpDragBegin(sf::Vector2i px);
    void helpDragMove(sf::Vector2i px);
    void helpDragEnd();
    bool helpDragging() const { return helpDragging_; }

    void draw(const Board& board, sf::Vector2i hoverPx, const Hud& hud, sf::RenderTarget& target);

    // —— 右键菜单：列出该格"除当前状态外"的其余四种状态 ——
    bool menuOpen() const { return menuOpen_; }
    void closeMenu() { menuOpen_ = false; }
    void openMenu(const Board& board, std::pair<int, int> cell, sf::Vector2i clickPx);
    std::pair<int, int> menuCell() const { return menuCell_; }
    int menuItemAt(sf::Vector2i px) const;      // -1 = 没点在菜单项上
    void menuMove(int delta);                   // 上下键移动高亮（循环）
    int menuIndex() const { return menuIndex_; }
    MineType menuHighlightedOption() const;     // Enter 确认时取用
    MineType menuOptionAt(int idx) const;       // 越界返回 None
    std::size_t menuOptionCount() const { return menuOptions_.size(); }

    // —— 自定义局设置面板 ——
    enum class SetupAction { None, Start, Cancel };
    bool setupOpen() const { return setupOpen_; }
    void openSetup() {
        setupCommitEdit();
        setupOpen_ = true;
    }
    void closeSetup() { setupOpen_ = false; setupDrag_ = 0; setupFocus_ = 0; setupEdit_.clear(); }

    // —— 种子界面：菜单（复制/载入/工具箱）→ 载入框 → 覆盖确认 → 工具箱 ——
    enum class SeedStage { None, Menu, Load, Confirm, Tool };
    enum class SeedHit { None, MenuCopy, MenuSave, MenuLoad, MenuTool, Ok, Cancel, Paste, Yes, No, Outside, Box,
                         ToolKey, ToolIn, ToolDecode, ToolEncode, ToolCopy, ToolClose };
    void openSeedMenu(const std::string& shortSeedText, bool copyEnabled, const std::string& saveHint);
    void openSeedLoadDialog(const std::string& prefill);
    void openSeedConfirm();
    // 种子工具箱（与网页端 / cmsui 的种子工具箱同逻辑）：种子串 ⇄ 明文 JSON，
    // 密钥必填（留空直接拒绝，界面永不回显密钥值）。解码/编码判定走 core/Seed.h
    // 同一份实现，不会出现「工具说行、游戏说 BAD SEED」的分裂。
    void openSeedToolbox(const std::string& prefill);
    void toolDecode();
    void toolEncode();
    const std::string& toolOut() const { return toolOut_; }
    bool toolOutBad() const { return toolOutBad_; }
    const std::string& toolKeyText() const { return toolKey_.text; }
    const std::string& toolInText() const { return toolIn_.text; }
    void scrollToolOut(float delta); // 输出区滚轮滚动
    void toolSetFocus(int f) { toolFocus_ = (f == 1) ? 1 : 2; } // 1 密钥框 2 输入框
    int toolFocus() const { return toolFocus_; }
    void toolClickInBox(sf::Vector2i px); // 在当前聚焦的工具箱框内定位光标
    // 覆盖确认框里显示的「当前局面」两行摘要（main 按 Board 现算传入；空则不画）
    void setSeedOverwriteInfo(const std::string& line1, const std::string& line2) { seedOwLine1_ = line1; seedOwLine2_ = line2; }
    void closeSeedUi();
    SeedStage seedStage() const { return seedStage_; }
    void setSeedNote(const std::string& note);
    int seedMenuIndex() const { return seedMenuItem_; }
    bool seedMenuEnabled(int i) const { return i == 2 || i == 3 || seedCopyEnabled_; }
    void seedMenuMove(int d);
    void seedInputChar(char32_t ch);
    // 文本框统一按键入口（载入框 / 工具箱两框共用）：光标移动、删改、可见 ASCII 兜底
    // 全在这一个实现里，main 只处理阶段级按键（Enter/Tab/Esc/Cmd 组合键）。
    // 返回 false = 不是编辑键，交给上层。
    bool seedFieldKey(sf::Keyboard::Key k, bool shift, bool cmd, bool alt);
    // 每帧事件批结束后调用：兜底键若没等到配对的 TextEntered（=真被输入法吞了）在这里落地。
    // 同一批里 TextEntered 已插过同一个字符就跳过，防止英文模式下 KeyPressed+TextEntered 双触发。
    void seedEndFrame();
    void seedInputBackspace();  // 有选区则删选区，否则删光标前一格
    void seedInsert(const std::string& s);      // 光标处插入（替换选区），用于粘贴
    std::string seedSelectedText() const;
    void seedSelectAll();
    void seedDeleteSelection();
    void seedCaretMove(int delta, bool extendSel);
    void seedClickInBox(sf::Vector2i px, bool extendSel);
    int seedCaret() const { return loadField_.caret; }
    bool seedHasSelection() const { const SeedField* f = activeSeedField(); return f && f->anchor != f->caret; }
    // 载入框内的右键菜单（剪切/复制/粘贴/全选）
    bool seedBoxMenuOpen() const { return seedBoxMenuOpen_; }
    void openSeedBoxMenu(sf::Vector2i px) { seedBoxMenuOpen_ = true; seedBoxMenuPos_ = px; seedBoxMenuIndex_ = 2; }
    void closeSeedBoxMenu() { seedBoxMenuOpen_ = false; }
    int seedBoxMenuItemAt(sf::Vector2i px) const;
    void seedBoxMenuMove(int d);
    int seedBoxMenuIndex() const { return seedBoxMenuIndex_; }
    const std::string& seedInput() const { return loadField_.text; }
    // 整段替换输入框（右键粘贴 / 对话框预填）。过滤与上限都在实现里做，
    // 与 web 端 seedInputSet 同一口径 —— 粘贴是**唯一**能把任意长度灌进来的路，
    // 裸赋值等于让一张剪贴板决定缓冲区长度。
    void seedInputSet(const std::string& s);
    void tickSeedNote() { if (seedNoteClock_ > 0) --seedNoteClock_; }
    // —— 求解器提示高亮（H 键）：脉冲描边格，棋盘有变或提示刷新时重设 ——
    void setHintCell(int r, int c) { hintR_ = r; hintC_ = c; hintClock_ = 0; }
    void clearHintCell() { hintR_ = -1; hintC_ = -1; }
    bool hasHintCell() const { return hintR_ >= 0; }
    void tickHint() { if (hintR_ >= 0) ++hintClock_; }
    SeedHit seedHit(sf::Vector2i px) const;
    int seedMenuHoverIndex(sf::Vector2i px) const; // 鼠标悬停在种子菜单第几项（-1 = 不在）

    // —— "红专并进 理实交融" 彩蛋（显示 USTC 字母的辅助模式）——
    // —— 设置（自定义背景 / 四种标记的字符或图片），并持久化到用户目录 ——
    bool setBackgroundImage(const std::string& path); // 失败返回 false
    // 最近一次图片被拒的原因（空 = 没有拒绝记录）。三句文案在 Renderer.cpp 里，
    // 因为「太大」要带上实际宽高 —— 用户在设置面板里选图失败时应该看到这个，
    // 而不是笼统的 BAD IMAGE（那会让人以为文件坏了，去反复换一张同样超限的图）。
    std::string imageRejectNote() const { return imageRejectNote_; }
    void resetBackground();
    std::string backgroundPath() const { return bgPath_; }
    void setMarkerChar(MineType mt, const std::string& ch); // 只接受"可见 ASCII"的单字符
    std::string markerChar(MineType mt) const;
    bool setMarkerImage(MineType mt, const std::string& path);
    void clearMarkerImage(MineType mt);
    std::string markerImagePath(MineType mt) const;
    bool markerHasImage(MineType mt) const;
    // 翻开空白格（周围无雷）自定义：单槽，一个字符或一张图片
    void setBlankChar(const std::string& ch);
    std::string blankChar() const;
    bool setBlankImage(const std::string& path);
    void clearBlankImage();
    std::string blankImagePath() const;
    bool blankHasImage() const;
    void saveSettings() const;
    void loadSettings();
    void markHelpSeen();
    void resetAllSettings();   // 还原所有默认（图标 / 背景 / 格子颜色），并清掉配置目录里的图片
    std::string settingsFolder() const; // 配置目录（供设置面板显示）

    // —— 双击开格（chord）相关设置 ——
    enum class ChordFailMode { Silent, Hint, Boom }; // 条件不满足时：静默 / 提示 / 直接爆炸
    static constexpr int kDoubleClickMinMs = 150;
    static constexpr int kDoubleClickMaxMs = 1500;
    ChordFailMode chordFailMode() const { return chordFailMode_; }
    void setChordFailMode(ChordFailMode m); // 会写配置
    int doubleClickMs() const { return doubleClickMs_; }
    void setDoubleClickMs(int ms);          // 自动夹到 [150, 1500]，会写配置

    // —— 装饰星光层（与网页端 fx.ts 同源：密度 / 半径倍率都可调）——
    // 密度单位是「每 100×100 逻辑像素多少颗」（两位小数，0.01 步进），实际颗数 = 密度 ×
    // 窗口逻辑面积 / 10000（L_.winW×winH；不是 getDesktopMode 的物理像素）。
    // 0 是合法值 = 彻底关闭这一层（桌面端没有 prefers-reduced-motion 对应物，靠它兜底）。
    static constexpr float kStarDensityMin = 0.f;
    static constexpr float kStarDensityMax = 7.12f;
    static constexpr float kStarDensityDefault = 2.17f;
    static constexpr float kStarScaleMin = 0.6f;
    static constexpr float kStarScaleMax = 3.0f;
    float starDensity() const { return starDensity_; }
    int starCountForDensity(float density) const; // 密度 × 窗口逻辑面积 / 10000（0..kStarPoolMax）
    int effectiveStarCount() const { return starCountForDensity(starDensity_); }
    float starScale() const { return starScale_; }
    void setStarDensity(float v); // 夹到 [0, 7.12]、两位小数，会写配置
    void setStarScale(float v); // 夹到 [0.6, 3.0]、一位小数，会写配置
    // 点击弹「USTC」字母：只在彩蛋开关打开时生效。由 main 在**游戏逻辑处理完之后**调用，
    // 所以它绝不吞事件——右键插旗、左键翻开照常。
    void fxBurst(sf::Vector2i px);
    bool fxRipple(sf::Vector2i px);   // 左键**打中流星**才炸，返回是否命中（不受「红专并进」影响）

    // —— 格子颜色（默认 #66CCFF）——
    void setCellColor(int r, int g, int b);
    void resetCellColor();
    sf::Color cellColor() const {
        return sf::Color(cellR_, cellG_, cellB_);
    }

    // —— 设置面板（齿轮按钮弹出）——
    bool settingsOpen() const { return settingsOpen_; }
    void openSettings() { settingsOpen_ = true; settingsFocus_ = 0; }
    // 通用二次确认框：还原全部默认 / 局中重新开始 / 局中切换局面（难度、自定义）
    enum class ConfirmKind { None, RestoreAll, Restart, Switch };

    void closeSettings() {
        settingsOpen_ = false;
        settingsFocusOn(0); // 走一遍提交校验：正在输入的数值不能因为直接关面板而悄悄丢掉
        if (confirmKind_ == ConfirmKind::RestoreAll) confirmKind_ = ConfirmKind::None;
    }
    ConfirmKind confirmKind() const { return confirmKind_; }
    bool confirmOpen() const { return confirmKind_ != ConfirmKind::None; }
    void openRestoreConfirm() { confirmKind_ = ConfirmKind::RestoreAll; }
    void openRestartConfirm() { confirmKind_ = ConfirmKind::Restart; }
    void openSwitchConfirm(const std::string& what) { confirmKind_ = ConfirmKind::Switch; confirmWhat_ = what; }
    void closeConfirm() { confirmKind_ = ConfirmKind::None; }
    struct ConfirmRects { sf::FloatRect panel, yes, no; };
    enum class ConfirmHit { None, Outside, Yes, Cancel };
    ConfirmRects confirmRects() const;
    ConfirmHit confirmHit(sf::Vector2i px) const;
    void drawConfirm(sf::RenderTarget& t) const;
    // —— 黄 0 首现教学（与网页端同款）：首次揭开「和恰好抵消」的黄 0 → 闪烁 1.5s → 一次性解释弹窗 ——
    // seen 记忆存 settings.ini 的 zerotipseen（政策同 helpseen）；真空格不参与（它是安全格）。
    // 返回 true = 本帧触发了闪烁，调用方无需再做什么（落盘已在函数内完成）。
    bool maybeStartZeroTip(const Board& board);
    bool zeroTipPopupOpen() const { return zeroTipPhase_ == 2; }
    void closeZeroTip() { zeroTipPhase_ = 0; }
    void tickZeroTip(); // 每帧调用：闪烁满 1.5s 自动进弹窗阶段
    enum class ZeroTipHit { None, Outside };
    ZeroTipHit zeroTipHit(sf::Vector2i px) const;
    sf::FloatRect zeroTipRects() const;
    void drawZeroTipFlash(const Board& board, sf::RenderTarget& t) const; // 闪烁描边（棋盘层内、内容之上）
    void drawZeroTip(sf::RenderTarget& t);                                // 解释弹窗（模态面板之下）
    int settingsFocus() const { return settingsFocus_; }
    // field: 1..4 = 四种标记的字符；5 = 色号(#RRGGBB)；6/7/8 = R/G/B；9 = 双击判定毫秒；
    //        10 = 空白格字符；11 = 星光密度；12 = 星光大小；13 = 背景纯色
    void settingsFocusOn(int field) {
        // 离开输入框前先校验提交（非法输入就地丢弃，保持原值）
        if (settingsFocus_ == 9) settingsCommitMs();
        else if (settingsFocus_ == 11) settingsCommitStarDensity();
        else if (settingsFocus_ == 12) settingsCommitStarScale();
        else if (settingsFocus_ == 13) settingsCommitBg();
        settingsFocus_ = (field >= 0 && field <= 13) ? field : 0;
        settingsEdit_.clear(); // 每次聚焦都从空开始，避免半成品被当成有效输入
    }
    void settingsChar(char32_t ch);      // 只接受可见 ASCII，非法则忽略
    void settingsBackspace();
    enum class SettingsHit { None, Outside, Close, BrowseBg, ResetBg, Field1, Field2, Field3, Field4,
                             Browse1, Browse2, Browse3, Browse4, Clear1, Clear2, Clear3, Clear4,
                             HexField, FieldR, FieldG, FieldB, ResetColor, RestoreAll,
                             ChordSilent, ChordHint, ChordBoom, DcTrack, DcValue,
                             BlankField, BlankBrowse, BlankClear,
                             StarTrack, ScaleTrack, StarValue, ScaleValue,
                             BgField,
                             AnimFx }; // 背景色框追加在末尾（理由同上：前面的枚举值有区间判断）
    struct SettingsRects {
        sf::FloatRect panel, bgBox, browseBg, resetBg, field[5], browse[5], clear[5], close;
        sf::FloatRect swatch, hexField, rgbField[3], resetColor; // 格子颜色行
        sf::FloatRect restoreAll;                                 // 还原全部默认
        sf::FloatRect chordBtn[3];                                // 双击开格失败：静默/提示/爆炸
        sf::FloatRect dcTrack, dcValue;                           // 双击判定时长滑块与数值框
        sf::FloatRect blankField, blankBrowse, blankClear;        // 空白格自定义行
        sf::FloatRect starTrack, scaleTrack;                      // 星光密度 / 星光大小
        sf::FloatRect starValue, scaleValue;                      // 星光密度 / 大小的可输入数值框
        sf::FloatRect animBtn;                                    // 动效总开关（ANIM FX）
    };
    SettingsRects settingsRects() const;
    SettingsHit settingsHit(sf::Vector2i px) const;
    // 滑块：which 1=双击时长 2=星光密度 3=星光大小（三条共用"按 x 反算"这一套）
    void settingsPressTrack(sf::Vector2i px, int which = 1);
    bool settingsMove(sf::Vector2i px);       // 拖动中
    void settingsRelease() { settingsDrag_ = false; }
    // 设置面板滚动
    void scrollSettings(float delta);
    bool settingsHitScrollbar(sf::Vector2i px) const;
    void settingsDragBegin(sf::Vector2i px);
    void settingsDragMove(sf::Vector2i px);
    void settingsDragEnd() { settingsScrollDrag_ = false; }
    bool settingsScrollDragging() const { return settingsScrollDrag_; }
    void drawSettings(sf::RenderTarget& t) const;

    void loadCjkFont();                        // 加载系统中文字体（用于中文标签）
    bool cjkOk() const { return fontCjkOk_; }
    bool ustcMode() const { return ustcMode_; }
    // 结算横幅：点击后隐藏，方便观察局面（新开一局时自动恢复显示）
    bool overlayHidden() const { return overlayHidden_; }
    void hideOverlay() { overlayHidden_ = true; }
    void resetOverlay() { overlayHidden_ = false; }
    void toggleUstcMode() {
        ustcMode_ = !ustcMode_;
        saveSettings(); // 与其它设置一样立即落盘
    }
    void setUstcMode(bool on) {
        ustcMode_ = on;
        saveSettings();
    }
    // 隐藏"未正确标记"的轴计数（表头那两个 ±1/±i 芯片里的数字）
    bool hideCounts() const { return hideCounts_; }
    void toggleHideCounts() {
        hideCounts_ = !hideCounts_;
        saveSettings(); // 与其它设置一样立即落盘
    }
    void setHideCounts(bool on) {
        hideCounts_ = on;
        saveSettings();
    }
    // 总是显示模长：纯实/纯虚提示也显示 |z|（只显示数值，颜色仍按轴区分）
    bool alwaysMagnitude() const { return alwaysMagnitude_; }
    void toggleAlwaysMagnitude() {
        alwaysMagnitude_ = !alwaysMagnitude_;
        saveSettings(); // 与其它设置一样立即落盘
    }
    void setAlwaysMagnitude(bool on) {
        alwaysMagnitude_ = on;
        saveSettings();
    }
    // 动效总开关（ANIM FX）：关 = 全部动效退化为即时绘制（与网页端 animOn 同一闸门；
    // 桌面端没有 prefers-reduced-motion 可读，系统级「减少动态」暂不接入）
    bool animFx() const { return animFx_; }
    void toggleAnimFx() {
        animFx_ = !animFx_;
        resetAnims(); // 关掉时把进行中的动画一次性落到终态（与网页端 game.ts 同式）
        saveSettings();
    }
    void setAnimFx(bool on) {
        animFx_ = on;
        resetAnims();
        saveSettings();
    }
    // —— 动效层：交互触发点（状态机本体在 draw() 每帧的 syncAnims）——
    void noteRevealOrigin(int r, int c) { revealOriginR_ = r; revealOriginC_ = c; } // 开格/双击前记起点
    void addRipple(sf::Vector2f pos);          // 点击涟漪（左键点中格子时调）
    void resetAnims();                         // 换局/关开关：清光动效状态

    struct UstcRects {
        sf::FloatRect box, label;              // 统计行右端，整体右对齐
            sf::FloatRect hideBox, hideLabel; // 隐藏计数复选框
            sf::FloatRect magBox, magLabel;   // 总是显示模长复选框（在隐藏计数左侧）
};
    UstcRects ustcRects() const;

    // 种子界面控件几何（也供自检/自动化点击使用）
    struct SeedRects {
        sf::FloatRect menu, item0, item1, item2, item3, dialog, box, paste, cancel, ok, confirm, yes, no;
        sf::FloatRect boxMenu;
        sf::FloatRect boxItem[4]; // 剪切 / 复制 / 粘贴 / 全选
        // 工具箱（SeedStage::Tool）
        sf::FloatRect toolDialog, toolKeyBox, toolInBox, toolOut, toolDec, toolEnc, toolCopy, toolClose;
    };
    SeedRects seedRects() const;
    SetupConfig& setup() { return setupCfg_; }
    const SetupConfig& setup() const { return setupCfg_; }
    // 数字输入：与 +/- 并存（点数字可直接打字，点加减号会取消聚焦）
    bool setupEditing() const { return setupFocus_ != 0; }
    void setupTextChar(char32_t ch);   // 只接受数字
    void setupBackspace();
    void setupCommitEdit();            // Enter / 点别处：提交并取消聚焦
    void setupCancelEdit();            // Esc：还原
    std::string setupEditText() const { return setupEdit_; }

    // 面板控件几何（也供自检/自动化点击使用）
    struct SetupRects {
        sf::FloatRect panel;
        sf::FloatRect rowsMinus, rowsPlus, colsMinus, colsPlus, minesMinus, minesPlus;
        sf::FloatRect rowsMinus5, rowsPlus5, colsMinus5, colsPlus5, minesMinus5, minesPlus5; // ±5
        sf::FloatRect realTrack, imagTrack, splitBtn, startBtn, cancelBtn;
        sf::FloatRect rowsValue, colsValue, minesValue;
    };
    SetupRects setupRects() const;

    std::uint8_t bgAlpha() const { return bgAlpha_; }
    static constexpr int kBgAlphaMax = 191; // 背景不透明度上限 ≈75%
    void setBgAlpha(std::uint8_t a) {
        bgAlpha_ = a > static_cast<std::uint8_t>(kBgAlphaMax) ? static_cast<std::uint8_t>(kBgAlphaMax) : a;
    }
    // 主界面（表头）背景透明度滑条
    bool bgHit(sf::Vector2i px) const { return bgHitZone(px) != 0; }
    int bgHitZone(sf::Vector2i px) const;   // 0=无 1=滑条 2=百分比数字（可点进去输入）
    void bgFocusEdit();                     // 聚焦后可直接键入百分比
    void bgPress(sf::Vector2i px);
    void bgMove(sf::Vector2i px);
    void bgRelease() { bgDrag_ = false; }
    SetupAction setupPress(sf::Vector2i px);   // 点面板：步进/滑块/开始/取消
    void setupMove(sf::Vector2i px);           // 拖动滑块
    void setupRelease() { setupDrag_ = 0; }

private:
    struct Layout {
        float cell = 40.f;
        float gap = 3.f;
        float pad = 12.f;
        float headerH = 138.f; // 比原来高 22：多一行统计（行列 / 已翻开 / 已标记）
        float boardX = 0.f;
        float boardY = 0.f;
        float boardW = 0.f;
        float boardH = 0.f;
        int cols = 0; // 当前棋盘维度，供 cellAt 钳上界（防"幽灵格"越界）
        int rows = 0;
        float winW = 560.f;
        float winH = 560.f;
        sf::FloatRect restartBtn;
        sf::FloatRect easyBtn;
        sf::FloatRect mediumBtn;
        sf::FloatRect hardBtn;
        sf::FloatRect customBtn;
        sf::FloatRect seedBtn; // 右上角"种子"按钮
        sf::FloatRect playAgainBtn; // 终局 PLAY AGAIN（第二行 CUSTOM 左侧，仅胜败后绘制/可点）
        sf::FloatRect helpBtn;       // 标题右侧 ? 图标
        sf::FloatRect helpPanel;    // 游戏说明面板
        sf::FloatRect bgTrack; // 表头上的背景透明度滑条
        sf::FloatRect bgValue; // 滑条左侧的百分比数字（可点击输入）
        sf::FloatRect settingsBtn;      // 齿轮设置按钮
        sf::Vector2f gearCenter;        // 齿轮图标中心
        sf::FloatRect setPanel;         // 设置面板
    };

    // 自动选字体：字符串里出现非 ASCII（中文等）就用中文字体，否则用主字体。
    // 这样所有绘制点都不必关心自己画的是不是中文。
    const sf::Font& fontFor(const std::string& s) const;
    float textWidth(const std::string& s, float size, float bold = 0.f) const;

    sf::Text textSpr(const std::string& s, float size, sf::Color color, float cx, float cy, float bold = 0.f) const;
    sf::Text textTLSpr(const std::string& s, float size, sf::Color color, float x, float y, float bold = 0.f) const;
    sf::Text textCJKSpr(const std::string& s, float size, sf::Color color, float x, float y) const;

    void drawCellImpl(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t,
                      bool doBg, bool doContent) const;
    void drawCellBackground(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t) const;
    void drawCellContent(const Board& board, int r, int c, bool hovered, const Hud& hud, sf::RenderTarget& t) const;
    void drawBackgroundSprite(sf::RenderTarget& t, std::uint8_t alpha);
    void drawBackgroundSpriteIn(sf::RenderTarget& t, std::uint8_t alpha, const sf::FloatRect& rect);
    void drawHint(const Cell& cell, sf::Vector2f center, sf::RenderTarget& t, float alpha = 1.f,
                  const sf::RenderStates& st = sf::RenderStates::Default) const;
    void drawHeader(const Board& board, const Hud& hud, sf::RenderTarget& t);
    void drawOverlay(const Hud& hud, sf::RenderTarget& t) const;
    void drawMenu(sf::Vector2i mousePx, sf::RenderTarget& t) const;
    void drawSetup(sf::RenderTarget& t) const;
public:
    void loadBackground(); // 需在窗口/上下文创建后调用（幂等）
private:
private:



    const sf::Font& font() const { return font_; }

    Layout L_;
    sf::Font font_;
    sf::Texture bgTex_;
    sf::Sprite bgSprite_{bgTex_};
    bool bgOk_ = false;
    bool bgTried_ = false;
    bool fontOk_ = false;
    int activeDiff_ = 1;
    bool playAgainVisible_ = false;
    void overlayBtnRects(sf::FloatRect& sameBtn, sf::FloatRect& newBtn) const;

    // —— 帮助面板：硬编码结构化文案（样式标注版落地，#片段#的样式直接编进数据）——
    struct HelpSeg { std::string text; sf::Color col; float size; bool spaced = false; float adv = 0.f; float x = 0.f; };
    struct HelpRow { float y = 0.f, h = 0.f, indent = 0.f; bool dot = false, rule = false, center = false; sf::Color dotCol = sf::Color::Black; float ruleFrom = 0.f; std::vector<HelpSeg> segs; };
    void buildHelp();
    void drawHelp(sf::RenderTarget& t);
    void helpDragTo(float py); // 由按下点 y 反算滚动量（几何缓存来自 drawHelp 每帧）
    bool helpOpen_ = false, helpBuilt_ = false;
    bool helpSeen_ = false;
    std::vector<HelpRow> helpRows_;
    float helpTotalH_ = 0.f, helpScroll_ = 0.f;
    bool helpDragging_ = false, helpGeoOk_ = false;
    float helpGrabOff_ = 0.f, helpViewTop_ = 0.f, helpViewH_ = 0.f, helpMaxS_ = 0.f;
    sf::FloatRect helpTrackR_, helpThumbR_;

    // 顶部计数徽章的"变动高亮"状态
    std::array<int, 3> lastChip_{{0, 0, 0}};
    std::array<float, 3> chipFlash_{{0.f, 0.f, 0.f}};
    bool chipHadValue_ = false;
    sf::Clock chipClock_;

    // 右键菜单状态
    static constexpr float kMenuItemH = 30.f;
    static constexpr float kMenuW = 128.f;
    bool menuOpen_ = false;
    std::pair<int, int> menuCell_{0, 0};
    std::vector<MineType> menuOptions_;
    sf::FloatRect menuRect_;

    // 设置面板
    bool setupOpen_ = false;
    int setupDrag_ = 0; // 1 = 实雷滑块, 2 = 虚雷滑块, 3 = 背景透明度滑块
    std::uint8_t bgAlpha_ = 140; // 背景不透明度（默认 ≈55%）
    bool bgDrag_ = false;        // 正在拖表头滑条
    int menuIndex_ = 0;          // 菜单键盘高亮项
    int setupFocus_ = 0;         // 0=无, 1=ROWS, 2=COLS, 3=MINES
    std::string setupEdit_;      // 正在输入的数字文本
    SeedStage seedStage_ = SeedStage::None;
    int seedMenuItem_ = 0;       // 0 = 复制当前种子, 1 = 载入种子
    bool seedCopyEnabled_ = false;
    std::string seedShort_;      // 菜单里显示的短种子（前 12 位 + ...）
    std::string seedOwLine1_, seedOwLine2_; // 覆盖确认框：当前局面规格/进度摘要
    std::string seedSaveHint_;   // 存档项旁的进度摘要（如 "37% opened · 128s"）
    sf::Font fontCJK_;           // 中文字体（系统字体，用于"红专并进 理实交融"）
    bool fontCjkOk_ = false;
    bool ustcMode_ = false;      // 彩蛋开关：未翻开未标记的雷上显示 USTC 之一
    bool hideCounts_ = false;    // 隐藏轴计数芯片里的数字
    bool alwaysMagnitude_ = false; // 总是显示模长：纯实/纯虚提示也只显示 |z|
    bool animFx_ = true;         // 动效总开关（ANIM FX；关 = 全部动效退化为即时绘制）

    // —— 动效层状态（与 web/ts/renderer.ts 同名字段同义；改一处必须改另一处）——
    sf::Clock animClock_;                            // 动效时间基（ms，构造即起走）
    std::vector<double> revealAt_;                   // 每格波前到达时刻（0 = 无动画）
    std::vector<std::uint8_t> prevOpen_, prevFlag_;  // 上一帧快照（开格/标记 diff 用）
    std::vector<double> flagAt_;                     // 徽章弹入起点时刻
    std::vector<std::uint8_t> neighborLit_;          // 预亮：悬停格 8 邻域
    struct DyingFlag { int r, c; MineType t; double at; };
    std::vector<DyingFlag> dying_;                   // 取消标记的缩小退场
    struct Ripple { float x, y; double at; };
    std::vector<Ripple> ripples_;                    // 点击涟漪（窗口坐标，≤12 个）
    struct CounterFlip { int from; double at; };
    CounterFlip counterFlip_{};
    bool counterFlipActive_ = false;
    int lastRemaining_ = -1;                         // -1 = 首帧不翻牌
    struct LossAnim { double at; int r, c; };
    LossAnim lossAnim_{};                            // 失败：爆点锚（雷区显形/错标抖动）
    bool lossActive_ = false;
    struct WinAnim { double at; std::vector<sf::Vector2f> pts; };
    WinAnim winAnim_{};                              // 胜利：雷心极角排序后的星座顶点
    bool winActive_ = false;
    Phase phaseSeen_ = Phase::Playing;               // 终局转换检测
    int revealOriginR_ = -1, revealOriginC_ = -1;    // 开格/双击起点（syncAnims 消费后清掉）
    struct FlagPop { float scale; float ring; };
    double animNow() const;
    void syncAnims(const Board& board, const Hud& hud);
    float revealOf(std::size_t idx) const;           // -1 / 0..1 / 1（波前未到 / 入场 / 完成）
    float lossAlphaOf(int r, int c) const;
    float shakeDx() const;
    FlagPop flagPopOf(std::size_t idx) const;
    void drawClickRipples(sf::RenderTarget& t) const;
    void drawDyingFlags(sf::RenderTarget& t) const;
    void drawConstellation(sf::RenderTarget& t) const;
    void drawAcrylic(sf::RenderTarget& t, const sf::Vector2f& pos, const sf::Vector2f& sz) const; // 未开格亚克力渐变
    bool overlayHidden_ = false; // 结算横幅是否已被点击隐藏
    sf::Vector2i mousePx_{-1, -1}; // 最近一次 draw 传入的鼠标位置（供菜单悬停高亮用）
    // 自定义外观：索引 1..4 对应 +1 / -1 / +i / -i
    std::string markerChar_[5];
    std::string markerImage_[5];
    sf::Texture markerTex_[5];
    bool markerTexOk_[5] = {false, false, false, false, false};
    // 翻开空白格自定义外观（单槽）
    std::string blankChar_;
    std::string blankImage_;
    sf::Texture blankTex_;
    bool blankTexOk_ = false;
    std::string bgPath_;         // 自定义背景路径（空 = 用 assets/bg.jpg）
    // 纯色背景（2026-10-20）：背景除了「内置图 / 自定义图」还多了「#rrggbb 纯色」这一种。
    // 约定与网页端一致：SettingsData.background 里存 '#rrggbb' 就表示纯色，
    // 所以 ini 格式没变、也不需要新增字段。
    bool bgColorMode_ = false;
    sf::Color bgSolid_ = sf::Color(0, 0, 0);
    bool settingsOpen_ = false;
    ConfirmKind confirmKind_ = ConfirmKind::None; // 确认框当前类型
    std::string confirmWhat_;                     // Switch 确认框的目标局面名
    // —— 黄 0 首现教学 ——
    int zeroTipPhase_ = 0;                        // 0 无 / 1 闪烁中 / 2 弹窗
    int zeroTipT0_ = 0;                           // 闪烁起点（animClock_ 毫秒）
    bool zeroTipSeen_ = false;                    // settings.ini zerotipseen（loadSettings 里从 d 带入）
    sf::FloatRect zeroTipPanel_;                  // 弹窗几何（drawZeroTip 每帧缓存，zeroTipHit 用）
    ChordFailMode chordFailMode_ = ChordFailMode::Hint; // 默认"提示"
    int doubleClickMs_ = 400;                           // 双击判定时长（毫秒）
    // —— 装饰星光层（与网页端 fx.ts 同源）——
    // 一颗星光的全部观感状态。字段与 web/ts/fx.ts 的 Spark 接口一一对应，
    // 改一边就要改另一边（T57 会抽值比对）。
    struct Spark {
        float x = 0, y = 0;     // 当前逻辑坐标（x 含摇摆偏移）
        float x0 = 0;           // 摇摆中心：绘制时 x = x0 + amp·sin(t·ω+φ)，不累加
        float vx = 0, vy = 0;   // px/s，很慢，只是「浮」
        float r = 0;            // 星核基准半径；绘制再乘 starScale_
        float ph = 0;           // 闪烁相位
        float sp = 0;           // 闪烁角速度 rad/s
        int hue = 0;            // 配色档：0 白 / 1 #66CCFF / 2 #FFD9A0
        int sizeClass = 0;      // 0 小 / 1 中 / 2 大（幂律半径分档，决定画不画 ✦ 与拖尾）
        float amp = 0, omega = 0, swPhase = 0;  // 横向摇摆 A / ω / φ
        float hx[3] = {0, 0, 0}, hy[3] = {0, 0, 0}; // 最近 3 帧位置：短拖尾用
        int hn = 0;             // 历史位已填几个
        bool flare = false;     // 耀斑大亮星（十字长条）
        bool unit = false;      // 单位圆彩蛋（空心圆 + 半径线）
    };
    struct Meteor {             // 流星（流星雨里的一颗；同时最多 starfx::kMeteorMax 颗）
        float x = 0, y = 0, vx = 0, vy = 0;
        float life = 0, maxLife = 1;
        float trailSec = 1.2f;  // 拖尾 = 速度 × 这段时间的行程（每颗随机）
        float headR = 13.f;     // 头部五角星外半径（出生时定一次；每帧随机会让星形抖动）
        int hue = 0;            // 配色档 0..4，索引 starfx::kMeteorCols
    };
    // 点爆流星炸出的扩散圆环
    struct FxRipple {
        float x = 0, y = 0, life = 0, maxLife = 1;
        int hue = 0;
        float r1 = 82.f;
        float rot0 = 0;    // 中心十字的初始角（rad），每次炸随机
        float spin = 0;    // 角速度（rad/s），带符号 = 顺/逆时针随机
    };
    struct FxLetter { float x = 0, y = 0, vx = 0, vy = 0, rot = 0, vr = 0, life = 0, hue = 0; char ch = 'U'; };
    Spark newSpark(bool anywhere);
    void ensureGlowTex();       // 惰性生成 64×64 光斑贴图（需要 GL 上下文，不能放构造函数）
    void drawStar(const Spark& s, sf::RenderTarget& t); // 拖尾→光晕→星核→形状（四芒/耀斑/单位圆）
    // —— 光点配方：流星、背景大星、爆圈共用（对应网页端 fx.ts 的 drawCross/drawRing/drawOrb）——
    // rot = 0 时是水平/垂直（旧的画法），只有爆圈的中心十字传非零值
    void drawCross(float x, float y, float armX, float armY, float halfW, float alpha,
                   sf::RenderTarget& t, float rot = 0.f);
    void drawRing(float x, float y, float r, float w, const sf::Color& col, float alpha, sf::RenderTarget& t);
    void drawOrb(float x, float y, float R, int hue, float alpha, bool withRing, sf::RenderTarget& t);
    void spawnRippleAt(float x, float y, int hue, float r1);   // 点击命中 / 撞边界 共用
    void spawnMeteor();                                 // 往 meteors_ 里塞一颗（几何与网页端 spawnMeteor 同式）
    void drawOneMeteor(const Meteor& m, sf::RenderTarget& t);
    void updateMeteors(float dt, sf::RenderTarget& t);  // 批次调度 + 推进 + 绘制
    void drawRipples(float dt, sf::RenderTarget& t);    // 推进并画左键扩散圆环
    void drawFx(sf::RenderTarget& t); // 画在棋盘之上、模态面板之下（对齐网页端 #fx 的 DOM 次序）
    std::vector<Spark> sparks_;
    std::vector<FxLetter> fxLetters_;
    std::vector<Meteor> meteors_;
    float fxPoolW_ = 0.f; // 上次铺池时的窗口逻辑尺寸：尺寸一变就整池重铺，避免局部密度偏高
    float fxPoolH_ = 0.f;
    std::vector<FxRipple> fxRipples_;
    float showerTimer_ = 0.f;   // 距下一批流星雨；首帧铺池时置 starfx::kShowerInit
    float showerGap_ = 0.f;     // 距本批下一颗
    float showerGapStep_ = 0.f; // 本批相邻两颗的间隔（每批随机：span / count）
    int showerLeft_ = 0;        // 本批还剩几颗没放
    float fxTime_ = 0.f;        // 累计秒：摇摆相位用，绘制时算不累加到粒子上
    sf::Clock fxClock_;
    sf::Texture glowTex_;
    bool glowTried_ = false;
    float starDensity_ = kStarDensityDefault; // 星光密度 0..7.12 颗/100×100px（0 = 关闭）
    float starScale_ = 1.7f;   // 星光半径倍率 0.6..3.0
    void settingsCommitMs();     // 毫秒输入框：合法才提交，否则还原
    void settingsCommitStarDensity(); // 星光密度框：0..7.12 才提交，两位小数（焦点 id 11）
    void settingsCommitStarScale(); // 星光大小框：0.6..3.0 才提交，一位小数（焦点 id 12）
    void settingsCommitBg();        // 背景纯色框：满 6 位十六进制才提交（焦点 id 13）
    void settingsApplyTrack(int which, int x); // 按滑条 x 反算值：1=双击ms 2=星光密度 3=星光大小
    bool settingsDrag_ = false;  // 设置面板滑块是否正在拖动
    int settingsDragWhich_ = 1;  // 正在拖哪条滑块
    int settingsFocus_ = 0;      // 1..4 标记字符 / 5 色号 / 6..8 R,G,B / 9 双击毫秒 / 10 空白格 / 11 星光密度 / 12 星光大小
    std::string settingsEdit_;   // 色号与 RGB 的输入缓冲（非法字符不入）
    // 设置面板滚动状态
    mutable float settingsScroll_ = 0.f;
    mutable float settingsTotalH_ = 0.f;
    mutable float settingsViewH_ = 0.f;
    mutable float settingsMaxS_ = 0.f;
    bool settingsScrollDrag_ = false;
    float settingsGrabOff_ = 0.f;
    mutable sf::FloatRect settingsTrackR_, settingsThumbR_;
    mutable bool settingsGeoOk_ = false;
    std::uint8_t cellR_ = 102, cellG_ = 204, cellB_ = 255; // 格子颜色（sRGB，默认 #66CCFF）
    sf::Color coveredFill() const;
    sf::Color coveredEdge() const;
    sf::Color coveredHover() const;
    bool loadBackgroundFromFile(const std::string& fullPath); // 只加载，不保存
    // 图片闸门（2026-10-21 安全审计 P1/P2）：所有 sf::Image 解码都必须经过这两个。
    // loadImageChecked = 先读文件头验尺寸/类型，过了才真正解码。
    bool loadImageChecked(const std::string& path, sf::Image& out);
    bool probeImageForImport(const std::string& path);
    std::string imageRejectNote_;  // 见 imageRejectNote()

    bool loadMarkerImageFromFile(int idx, const std::string& fullPath);
    bool loadBlankImageFromFile(const std::string& fullPath);

    // 单行输入域：载入框与工具箱的两个框共用同一套光标/选区/横滚机制
    struct SeedField {
        std::string text;
        int caret = 0;      // 光标（字节索引）
        int anchor = 0;     // 选区锚点
        mutable float scroll = 0.f; // 横向滚动（像素，绘制时更新，仅绘制语义可写）
    };
    SeedField* activeSeedField();  // Load → 载入框；Tool → 当前聚焦框；其余 → nullptr
    const SeedField* activeSeedField() const;
    void fieldClickInBox(SeedField& f, sf::Vector2i px, const sf::FloatRect& box, bool extendSel);
    void drawSeedFieldBox(sf::RenderTarget& t, const sf::FloatRect& box, const SeedField& f,
                          const std::string& placeholder, bool focused, float textYOff) const;
    SeedField loadField_;        // 载入框（原 seedInput_/seedCaret_/seedSelAnchor_/seedBoxScroll_）
    // 工具箱状态
    SeedField toolKey_;          // 密钥框（必填，不回显）
    SeedField toolIn_;           // 种子串 / 明文 JSON
    char32_t seedPendingKey_ = 0; // KeyPressed 兜底待落地的字符（0=无）
    char32_t seedLastText_ = 0;   // 最近一次 TextEntered 收到的字符（对账用）
    std::string toolOut_;        // 输出区内容
    mutable std::string toolOutWrapped_; // 折行缓存的指纹（= toolOut_ 时不用重排）
    mutable std::vector<std::string> toolOutLines_; // 硬折行后的输出行
    bool toolOutBad_ = false;    // 输出是否为错误/警告（红色底）
    mutable float toolOutScroll_ = 0.f;  // 输出区纵向滚动（像素，绘制时收紧上限）
    int toolFocus_ = 1;          // 1 = 密钥框, 2 = 输入框
    bool seedBoxMenuOpen_ = false;
    int seedBoxMenuIndex_ = 0;
    sf::Vector2i seedBoxMenuPos_{0, 0};
    std::string seedNote_;       // 状态提示（COPIED! / 密码错误 ...）
    int seedNoteClock_ = 0;
    int hintR_ = -1, hintC_ = -1; // 求解器提示高亮格（-1 = 无）
    int hintClock_ = 0;           // 脉冲相位
    void drawHintCellOverlay(sf::RenderTarget& t) const;
    void drawSeedUi(sf::RenderTarget& t) const;
    int setupEditBackup_ = 0;    // Esc 还原用
    SetupConfig setupCfg_;
};

}