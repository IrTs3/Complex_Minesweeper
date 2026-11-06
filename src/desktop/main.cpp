#include <SFML/Graphics.hpp>

#include <algorithm>
#include <chrono>
#include <optional>

#include "core/Board.h"
#include "core/Difficulty.h"
#include "desktop/Renderer.h"
#if MS_SOLVER_HINTS
#include "solver/SolverEngine.h"
#endif

#include <iomanip>
#include <sstream>

#include "core/SaveGame.h"
#include "desktop/FileDialog.h"
#include "core/Seed.h"

#include <ctime>
#include <string>

using namespace ms;

#if MS_SOLVER_HINTS
namespace {
const char* mineTypeLabel(int typ) { // 1..4 → +1 / -1 / +i / -i
    static const char* const kLabels[5] = {"?", "+1", "-1", "+i", "-i"};
    return (typ >= 1 && typ <= 4) ? kLabels[typ] : "?";
}
} // namespace
#endif

int main() {
    sf::RenderWindow window;
    Renderer renderer;
    Board board;

    int diffIdx = 1;
    bool customActive = false;
    SetupConfig customCfg;
    SetupConfig pendingCustomCfg; // 局中点 START 后暂存；确认后才写入 customCfg（取消则保留旧值）
    // 行列上限不在此处启动时缓存——每次打开 CUSTOM 面板现场按屏幕重算（见 HeaderAction::Custom），
    // 避免启动值随屏幕环境过期后又被面板继承。
    Phase phase = Phase::Playing;
    bool timerRunning = false;
    std::chrono::steady_clock::time_point t0;
    double elapsed = 0.0;
    bool focusPaused = false; // 因窗口失焦而暂停计时（回来后接着走）

    auto applySize = [&]() {
        renderer.layoutFor(board.cols(), board.rows());
        const sf::Vector2u size = renderer.windowSize();
        const sf::VideoMode desktop = sf::VideoMode::getDesktopMode();
        const int x = (static_cast<int>(desktop.size.x) - static_cast<int>(size.x)) / 2;
        const int y = std::max(40, (static_cast<int>(desktop.size.y) - static_cast<int>(size.y)) / 2 - 30);
        if (window.isOpen()) {
            window.setSize(size);
        } else {
            window.create(sf::VideoMode(size), "Complex Minesweeper",
                          sf::Style::Titlebar | sf::Style::Close, sf::State::Windowed);
            window.setFramerateLimit(60);
        }
        // SFML 3 的窗口尺寸变化**不会**同步默认视图：RenderWindow::onResize() 只重算 viewport，
        // 视图尺寸仍是旧值。不显式重设的话整幅画面会按 (新窗口 / 旧视图) 非等比缩放——
        // 表现为格子被拉成非正方形、右对齐控件跑出窗口，切换难度时最明显。
        // 这里用请求的 size（而非 getSize()）：macOS 的 Resized 事件是异步到达的，
        // 紧接着读 getSize() 可能还是旧值。
        window.setView(sf::View(sf::FloatRect(sf::Vector2f(0.f, 0.f), sf::Vector2f(size))));
        window.setPosition(sf::Vector2i(x, y));
        renderer.loadBackground();
        renderer.loadCjkFont();
        renderer.loadSettings();
        renderer.saveSettings();
        // 首次游玩自动展开玩法介绍（与网页端同款；openHelp 会顺手把 helpseen 落盘）
        if (!renderer.helpSeen()) renderer.openHelp();
    };

    // —— 种子功能 ——
    bool firstOpened = false;   // 是否已翻开第一格（复制种子需先开局）
    int pendingDiff = -1;       // 确认框挂起的动作：-1=重开当前局，0..2=确认后切到该难度，3=确认后按 START 的规格开自定义局
    std::pair<int, int> lastClickCell{-1, -1};              // 双击开格：上一次点击的格子
    std::chrono::steady_clock::time_point lastClickTime{};  // 双击开格：上一次点击的时刻
    int firstR = 0, firstC = 0; // 首点坐标（复现雷分布必需）
#if MS_SOLVER_HINTS
    int hintOpenedCount = -1, hintFlagCount = -1; // 提示高亮设置时的盘面快照（棋盘一变就撤提示）
#endif
    int cfgMines = kDiffs[1].mines, cfgReal = -1, cfgImag = -1;
    bool cfgManual = false;
    ms::Seed pendingSeed;
    bool hasPendingSeed = false;

    // 生成时间：**统一用 UTC**（与网页端一致，见 wasm_stub.ts 的 boardEncodeSeed）。
    //
    // 为什么必须统一：种子串是跨端交换的数据，两端各写各的时区会让同一份存档
    // 在两端显示成相差数小时的时间。以后做排行榜要按时间排序/比对，时区不一致
    // 会直接算错。
    //
    // 为什么显式带 " UTC" 后缀：这一栏仅供人阅读，若只写 "05:17:12"，用户会
    // 理所当然当成自己所在时区的时间——东八区用户会以为差了 8 小时。写清楚更省事。
    // 用 gmtime 而不是 localtime：localtime 在多线程下要用 localtime_r，
    // 但更重要的是它让同一颗种子在不同机器上生成不同字符串。
    auto nowText = []() {
        const std::time_t t = std::time(nullptr);
        std::tm tmv{};
#if defined(_WIN32)
        gmtime_s(&tmv, &t); // MinGW-w64 / MSVC 提供
#else
        gmtime_r(&t, &tmv);
#endif
        char buf[40];
        std::strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S UTC", &tmv);
        return std::string(buf);
    };
    // kind = "new" 只复现整局；kind = "save" 额外带上"玩到哪了"
    auto currentSeedText = [&](const char* kind) {
        ms::Seed s;
        s.kind = kind;
        s.cols = board.cols();
        s.rows = board.rows();
        s.mines = cfgMines;
        s.manualSplit = cfgManual;
        s.realMines = cfgManual ? cfgReal : -1;
        s.imagMines = cfgManual ? cfgImag : -1;
        s.rngSeed = board.seed();
        s.firstRow = firstR;
        s.firstCol = firstC;
        if (std::string(kind) == "save") {
            const std::string ph = (phase == Phase::Won) ? "won" : (phase == Phase::Lost) ? "lost" : "playing";
            ms::captureProgress(board, s, static_cast<int>(elapsed * 100), ph);
        }
        s.ustcMode = renderer.ustcMode(); // 复选框状态一并记录到种子/存档
        s.createdAt = nowText();
        return ms::encodeSeed(s);
    };
    // 0.1 秒精度的格式化（显示用；存档里的 elapsedCs 是厘秒整数）
    auto fmtOneTenth = [](double v) {
        std::ostringstream os;
        os << std::fixed << std::setprecision(1) << v;
        return os.str();
    };
    auto saveHintText = [&]() {
        int openedCount = 0, flagCount = 0;
        for (int r = 0; r < board.rows(); ++r)
            for (int c = 0; c < board.cols(); ++c) {
                if (board.at(r, c).opened) ++openedCount;
                if (board.at(r, c).flag != MineType::None) ++flagCount;
            }
        const int total = std::max(1, board.cols() * board.rows());
        return std::to_string(openedCount * 100 / total) + "% opened, " + std::to_string(flagCount) +
               " flags, " + fmtOneTenth(elapsed) + "s";
    };
#if MS_SOLVER_HINTS
    // (已翻开数, 已标记数)：求解器提示失效判据（棋盘有任何变化就撤掉高亮）
    auto boardCounts = [&]() {
        int oc = 0, fc = 0;
        for (int r = 0; r < board.rows(); ++r)
            for (int c = 0; c < board.cols(); ++c) {
                const Cell& y = board.at(r, c);
                if (y.opened) ++oc;
                if (y.flag != MineType::None) ++fc;
            }
        return std::pair{oc, fc};
    };
#endif
    auto clipboardText = []() {
        // 先按**字符**截断再转 UTF-8：剪贴板里塞几千万字时，toUtf8 会先把整段
        // 展开成 1–4 倍的字节串再交给下游的 4096 上限，纯属白分配。
        // 留 8192 个码点（≥ 4096 字节）就够 seedInputSet 判定「超长」并如实提示。
        sf::String cs = sf::Clipboard::getString();
        constexpr std::size_t kClipChars = 8192;
        if (cs.getSize() > kClipChars) cs = cs.substring(0, kClipChars);
        const auto u8 = cs.toUtf8();
        return std::string(u8.begin(), u8.end());
    };
    auto imageErr = [&]() -> std::string {
        const std::string n = renderer.imageRejectNote();
        return n.empty() ? std::string("BAD IMAGE") : n;
    };
    auto copySeed = [&](const char* kind) {
        const std::string txt = currentSeedText(kind);
        sf::Clipboard::setString(sf::String::fromUtf8(txt.begin(), txt.end()));
        renderer.setSeedNote(std::string(kind) == "save" ? "PROGRESS COPIED!" : "COPIED!");
    };
    auto setClipboard = [](const std::string& s) {
        sf::Clipboard::setString(sf::String::fromUtf8(s.begin(), s.end()));
    };
    auto seedBoxAction = [&](int item) { // 输入框右键菜单：0 剪切 1 复制 2 粘贴 3 全选
        switch (item) {
        case 0: {
            const std::string t = renderer.seedSelectedText();
            if (!t.empty()) { setClipboard(t); renderer.seedDeleteSelection(); }
            break;
        }
        case 1: {
            const std::string t = renderer.seedSelectedText();
            setClipboard(t.empty() ? renderer.seedInput() : t);
            break;
        }
        case 2:
            renderer.seedInsert(clipboardText());
            break;
        case 3:
            renderer.seedSelectAll();
            break;
        default:
            break;
        }
        renderer.closeSeedBoxMenu();
    };
    bool boxDragging = false;

    auto applySeed = [&](const ms::Seed& s) {
        if (!ms::seedIsSane(s)) { // 外部文本来的种子：行列/雷数不合理就直接拒收
            renderer.setSeedNote("BAD SEED");
            return;
        }
        // 即便尺寸"合理"，也要能在本机屏幕上放得下（24px 格子的极限）
        if (s.cols > ms::Renderer::maxColsAtMinimumCell() || s.rows > ms::Renderer::maxRowsAtMinimumCell()) {
            renderer.setSeedNote("GRID TOO BIG FOR SCREEN");
            return;
        }
        cfgManual = s.manualSplit;
        cfgMines = s.mines;
        cfgReal = s.realMines;
        cfgImag = s.imagMines;
        renderer.setUstcMode(s.ustcMode); // 恢复存档里的复选框状态
        if (s.manualSplit) board.reset(s.cols, s.rows, s.realMines, s.imagMines);
        else board.reset(s.cols, s.rows, s.mines);
        board.setSeed(s.rngSeed); // 同一随机种子 + 同一首点 => 完全复现
        board.setMagnitudeMode(renderer.alwaysMagnitude()); // 判胜口径跟随当前显示模式
        int preset = -1;
        for (int i = 0; i < 3; ++i)
            if (!s.manualSplit && kDiffs[i].cols == s.cols && kDiffs[i].rows == s.rows && kDiffs[i].mines == s.mines)
                preset = i;
        diffIdx = preset;
        customActive = (preset < 0);
        renderer.setActiveDifficulty(preset);
        renderer.resetOverlay();
        renderer.resetAnims(); // 载入种子/存档：动效状态清零（进度恢复同网页端 resetBoardState）
        if (customActive) {
            customCfg.cols = s.cols;
            customCfg.rows = s.rows;
            customCfg.clampToBoard();
            if (s.manualSplit) {
                customCfg.realCount = s.realMines;
                customCfg.imagCount = s.imagMines;
                customCfg.setReal(customCfg.realCount);
                customCfg.setImag(customCfg.imagCount);
            } else {
                customCfg.setTotal(s.mines);
            }
        }
        renderer.closeSeedUi();
        renderer.closeMenu();
        renderer.closeSetup();
        renderer.closeZeroTip(); // 读档/换局时教学弹窗/闪烁一并收掉
        phase = Phase::Playing;
        timerRunning = false;
        elapsed = 0.0;
        focusPaused = false;
        applySize();
        board.open(s.firstRow, s.firstCol); // 复现首点：与原局完全一致
        firstOpened = true;
        firstR = s.firstRow;
        firstC = s.firstCol;
        const bool isSave = (s.kind == "save");
        if (isSave) ms::restoreProgress(board, s);
        if (isSave) { // 阶段与计时以存档为准
            phase = (s.phase == "won") ? Phase::Won : (s.phase == "lost") ? Phase::Lost : Phase::Playing;
            elapsed = static_cast<double>(s.elapsedCs) / 100.0;
            timerRunning = (phase == Phase::Playing);
            if (timerRunning)
                t0 = std::chrono::steady_clock::now() -
                     std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                         std::chrono::duration<double>(elapsed));
        } else if (board.won()) {
            phase = Phase::Won;
            timerRunning = false;
        }
        renderer.setSeedNote(isSave ? "PROGRESS LOADED" : "SEED LOADED");
    };
    auto applySeedFromInput = [&]() {
        ms::Seed s;
        if (!ms::decodeSeed(renderer.seedInput(), s)) {
            renderer.setSeedNote("WRONG KEY / BAD SEED");
            return;
        }
        if (firstOpened && !board.won() && !board.lost()) { // 局中：先问是否覆盖（带当前局面规格与进度）
            int openedCnt = 0, flaggedCnt = 0;
            for (int rr = 0; rr < board.rows(); ++rr) {
                for (int cc = 0; cc < board.cols(); ++cc) {
                    const Cell& cl = board.at(rr, cc);
                    if (cl.opened && cl.mine == MineType::None) ++openedCnt;
                    if (cl.flag != MineType::None && cl.mine != MineType::None) ++flaggedCnt;
                }
            }
            const int safeTotal = board.cols() * board.rows() - board.mineCount();
            renderer.setSeedOverwriteInfo(
                "当前局面 " + std::to_string(board.cols()) + "x" + std::to_string(board.rows()) +
                    " · " + std::to_string(board.mineCount()) + " 雷",
                "进度：已翻开 " + std::to_string(openedCnt) + "/" + std::to_string(safeTotal) +
                    " · 已标记 " + std::to_string(flaggedCnt) + "/" + std::to_string(board.mineCount()));
            pendingSeed = s;
            hasPendingSeed = true;
            renderer.openSeedConfirm();
            return;
        }
        applySeed(s);
    };

    // —— 复现当前局（「再玩同一局」/「机器演示一遍」的地基）——
    // 同一局三要素 = 棋盘随机种子 + 首点坐标 + 棋盘规格，全部已在 main/Board 里记录，这里打包成内存 Seed。
    auto currentSeed = [&]() {
        ms::Seed s;
        s.kind = "new";
        s.cols = board.cols();
        s.rows = board.rows();
        s.mines = board.mineCount();
        s.rngSeed = board.seed();
        s.firstRow = firstR;
        s.firstCol = firstC;
        s.ustcMode = renderer.ustcMode(); // 彩蛋状态取当下，不回退
        if (customActive && customCfg.splitManual) {
            s.manualSplit = true;
            s.realMines = customCfg.realCount;
            s.imagMines = customCfg.imagCount;
        } else {
            s.manualSplit = false;
            s.realMines = -1; // v45 约定：非手动分型恒 -1（合法值，别写 0）
            s.imagMines = -1;
        }
        return s;
    };
    // 「再玩同一局」：reset + 同种子 + 复现首点，停在点完第一手的状态（applySeed 已含全流程）
    auto replayCurrentGame = [&]() { applySeed(currentSeed()); };

    auto newGame = [&](int idx) {
        diffIdx = idx;
        customActive = false;
        board.reset(kDiffs[idx].cols, kDiffs[idx].rows, kDiffs[idx].mines);
        board.randomizeSeed();
        board.setMagnitudeMode(renderer.alwaysMagnitude()); // 判胜口径跟随当前显示模式
        cfgMines = kDiffs[idx].mines;
        cfgReal = cfgImag = -1;
        cfgManual = false;
        firstOpened = false;
        lastClickCell = std::make_pair(-1, -1);
        renderer.setActiveDifficulty(idx);
        renderer.resetOverlay(); // 新一局恢复结算横幅
        renderer.resetAnims();   // 动效状态清零（防上一局的雷区显形/星座残留）
        renderer.closeMenu();
        renderer.closeSetup();
        renderer.closeZeroTip(); // 换局时教学弹窗/闪烁一并收掉
        phase = Phase::Playing;
        timerRunning = false;
        elapsed = 0.0;
        focusPaused = false;
        applySize();
    };

    // 自定义局：虚实手动 -> 精确数量；否则总数随机分型
    auto newCustom = [&]() {
        customActive = true;
        diffIdx = -1;
        renderer.setActiveDifficulty(-1);
        renderer.resetOverlay();
        renderer.resetAnims(); // 动效状态清零
        renderer.closeMenu();
        renderer.closeSetup();
        renderer.closeZeroTip(); // 换局时教学弹窗/闪烁一并收掉
        customCfg.clampToBoard();
        if (customCfg.splitManual) board.reset(customCfg.cols, customCfg.rows, customCfg.realCount, customCfg.imagCount);
        else board.reset(customCfg.cols, customCfg.rows, customCfg.mines());
        board.randomizeSeed();
        board.setMagnitudeMode(renderer.alwaysMagnitude()); // 判胜口径跟随当前显示模式
        cfgMines = customCfg.mines();
        cfgReal = customCfg.realCount;
        cfgImag = customCfg.imagCount;
        cfgManual = customCfg.splitManual;
        firstOpened = false;
        lastClickCell = std::make_pair(-1, -1);
        phase = Phase::Playing;
        timerRunning = false;
        elapsed = 0.0;
        focusPaused = false;
        applySize();
    };

    // 打开 CUSTOM 面板（不直接开新局，START 才生效）；难度/重开确认框也复用它做「确认后开面板」
    auto openCustomPanel = [&]() {
        SetupConfig& sc = renderer.setup();
        if (customActive) {
            sc = customCfg;
        } else {
            sc.cols = board.cols();
            sc.rows = board.rows();
            sc.total = board.mineCount();
            sc.realCount = board.mineCount() / 2;
            sc.imagCount = board.mineCount() - sc.realCount;
            sc.splitManual = false;
        }
        // 行列上限每次开面板现场重算（v69）：与 START 兜底校验同一函数、同一时点口径。
        // 历史坑：renderer 的 sc.maxRows/maxCols 曾是 SetupConfig 默认值 40 且被 keep 逻辑固化，
        // 面板标签/步进器放行 40 行，START 复校验却按现场屏幕上限拒绝 → GRID TOO BIG。
        sc.maxRows = std::max(5, ms::Renderer::maxRowsAtMinimumCell());
        sc.maxCols = std::max(5, ms::Renderer::maxColsAtMinimumCell());
        sc.clampToBoard();
        renderer.closeMenu();
        renderer.openSetup();
    };

    newGame(1);

    while (window.isOpen()) {
        while (const std::optional<sf::Event> event = window.pollEvent()) {
            if (event->is<sf::Event::Closed>()) {
                window.close();
                break;
            }
            // 视图必须始终与窗口尺寸一致：SFML 3 的 onResize 只重算 viewport，不会改视图尺寸，
            // 系统发起的尺寸变化（换显示器、显示缩放改变等）同样要让视图跟上，否则画面会非等比缩放。
            if (const auto* rs = event->getIf<sf::Event::Resized>()) {
                window.setView(sf::View(sf::FloatRect(sf::Vector2f(0.f, 0.f), sf::Vector2f(rs->size))));
                continue;
            }
            if (const auto* wheel = event->getIf<sf::Event::MouseWheelScrolled>()) {
                if (renderer.helpOpen()) renderer.scrollHelp(wheel->delta); // 说明面板滚轮滚动
                else if (renderer.settingsOpen()) renderer.scrollSettings(wheel->delta); // 设置面板滚轮滚动
                else if (renderer.seedStage() == Renderer::SeedStage::Tool) renderer.scrollToolOut(wheel->delta);
                continue;
            }
            if (const auto* text = event->getIf<sf::Event::TextEntered>()) {
                if (renderer.settingsOpen()) {
                    renderer.settingsChar(text->unicode); // 非法字符会被忽略
                } else if (renderer.seedStage() == Renderer::SeedStage::Load ||
                           renderer.seedStage() == Renderer::SeedStage::Tool)
                    renderer.seedInputChar(text->unicode);
                else if (renderer.setupEditing()) renderer.setupTextChar(text->unicode);
                continue;
            }
            if (const auto* key = event->getIf<sf::Event::KeyPressed>()) {
                if (renderer.settingsOpen()) { // 设置面板模态
                    if (renderer.settingsFocus() != 0) { // 正在输入标记字符：先走按键兜底
                    // 输入法可能吞掉 TextEntered：这里用按键兜底映射可见 ASCII
                    const sf::Keyboard::Key k = key->code;
                    if (k >= sf::Keyboard::Key::A && k <= sf::Keyboard::Key::Z) {
                        char c = static_cast<char>('a' + (static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::A)));
                        if (key->shift) c = static_cast<char>(c - 32);
                        renderer.settingsChar(static_cast<char32_t>(c));
                        continue;
                    }
                    if (k >= sf::Keyboard::Key::Num0 && k <= sf::Keyboard::Key::Num9) {
                        // 上排数字带 Shift 变体（否则想设 * 之类的标记字符会被兜底改成数字）
                        static const char32_t kShiftDigit[10] = {U')', U'!', U'@', U'#', U'$', U'%', U'^', U'&', U'*', U'('};
                        const int d = static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::Num0);
                        renderer.settingsChar(key->shift ? kShiftDigit[d]
                                                         : static_cast<char32_t>(U'0' + d));
                        continue;
                    }
                    if (k >= sf::Keyboard::Key::Numpad0 && k <= sf::Keyboard::Key::Numpad9) {
                        renderer.settingsChar(static_cast<char32_t>('0' + (static_cast<int>(k) - static_cast<int>(sf::Keyboard::Key::Numpad0))));
                        continue;
                    }
                    if (k == sf::Keyboard::Key::Hyphen) { renderer.settingsChar(key->shift ? U'_' : U'-'); continue; }
                    if (k == sf::Keyboard::Key::Equal) { renderer.settingsChar(key->shift ? U'+' : U'='); continue; }
                    if (k == sf::Keyboard::Key::LBracket) { renderer.settingsChar(key->shift ? U'{' : U'['); continue; }
                    if (k == sf::Keyboard::Key::RBracket) { renderer.settingsChar(key->shift ? U'}' : U']'); continue; }
                    if (k == sf::Keyboard::Key::Backslash) { renderer.settingsChar(key->shift ? U'|' : U'\\'); continue; }
                    if (k == sf::Keyboard::Key::Semicolon) { renderer.settingsChar(key->shift ? U':' : U';'); continue; }
                    if (k == sf::Keyboard::Key::Apostrophe) { renderer.settingsChar(key->shift ? U'"' : U'\''); continue; }
                    if (k == sf::Keyboard::Key::Comma) { renderer.settingsChar(key->shift ? U'<' : U','); continue; }
                    if (k == sf::Keyboard::Key::Period) { renderer.settingsChar(key->shift ? U'>' : U'.'); continue; }
                    if (k == sf::Keyboard::Key::Slash) { renderer.settingsChar(key->shift ? U'?' : U'/'); continue; }
                    if (k == sf::Keyboard::Key::Grave) { renderer.settingsChar(key->shift ? U'~' : U'`'); continue; }
                    if (k == sf::Keyboard::Key::Space) { renderer.settingsChar(key->shift ? U' ' : U' '); continue; }
                    }
                    if (key->code == sf::Keyboard::Key::Escape) {
                        if (renderer.settingsFocus() != 0) renderer.settingsFocusOn(0);
                        else renderer.closeSettings();
                    } else if (key->code == sf::Keyboard::Key::Backspace) {
                        renderer.settingsBackspace();
                    }
                    continue;
                }
                if (renderer.seedStage() != Renderer::SeedStage::None) { // 种子界面模态
                    if (renderer.seedStage() == Renderer::SeedStage::Menu) {
                        if (key->code == sf::Keyboard::Key::Up) { renderer.seedMenuMove(-1); continue; }
                        if (key->code == sf::Keyboard::Key::Down) { renderer.seedMenuMove(1); continue; }
                        if (key->code == sf::Keyboard::Key::Enter) {
                            if (renderer.seedMenuIndex() == 0) { if (renderer.seedMenuEnabled(0)) copySeed("new"); }
                            else if (renderer.seedMenuIndex() == 1) { if (renderer.seedMenuEnabled(1)) copySeed("save"); }
                            else if (renderer.seedMenuIndex() == 2) renderer.openSeedLoadDialog(""); // 默认留空，粘贴交给快捷键/右键菜单
                            else renderer.openSeedToolbox(firstOpened ? currentSeedText("new") : std::string());
                            continue;
                        }
                    } else if (renderer.seedStage() == Renderer::SeedStage::Load) {
                        const bool cmd = key->control || key->system;
                        if (cmd) { // Cmd/Ctrl + C/V/X/A
                            if (key->code == sf::Keyboard::Key::C) {
                                const std::string t = renderer.seedSelectedText();
                                setClipboard(t.empty() ? renderer.seedInput() : t);
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::V) {
                                renderer.seedInsert(clipboardText());
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::X) {
                                const std::string t = renderer.seedSelectedText();
                                if (!t.empty()) { setClipboard(t); renderer.seedDeleteSelection(); }
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::A) {
                                renderer.seedSelectAll();
                                continue;
                            }
                        }
                        if (renderer.seedBoxMenuOpen()) { // 框内菜单
                            if (key->code == sf::Keyboard::Key::Up) { renderer.seedBoxMenuMove(-1); continue; }
                            if (key->code == sf::Keyboard::Key::Down) { renderer.seedBoxMenuMove(1); continue; }
                            if (key->code == sf::Keyboard::Key::Enter) {
                                seedBoxAction(renderer.seedBoxMenuIndex());
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::Escape) {
                                renderer.closeSeedBoxMenu();
                                continue;
                            }
                        }
                        if (key->code == sf::Keyboard::Key::Enter) { applySeedFromInput(); continue; }
                        // 其余编辑键（光标移动/删改/可见 ASCII 兜底）走文本框统一入口
                        if (renderer.seedFieldKey(key->code, key->shift, cmd, key->alt)) continue;
                    } else if (renderer.seedStage() == Renderer::SeedStage::Tool) {
                        const bool cmd = key->control || key->system;
                        if (cmd) { // Cmd/Ctrl + C/V/X/A 作用于当前聚焦的框
                            if (key->code == sf::Keyboard::Key::C) {
                                const std::string t = renderer.seedSelectedText();
                                setClipboard(t.empty() ? (renderer.toolFocus() == 1 ? renderer.toolKeyText()
                                                                                   : renderer.toolInText())
                                                       : t);
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::V) {
                                renderer.seedInsert(clipboardText());
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::X) {
                                const std::string t = renderer.seedSelectedText();
                                if (!t.empty()) { setClipboard(t); renderer.seedDeleteSelection(); }
                                continue;
                            }
                            if (key->code == sf::Keyboard::Key::A) {
                                renderer.seedSelectAll();
                                continue;
                            }
                        }
                        if (key->code == sf::Keyboard::Key::Tab) { // Tab 在密钥框与输入框间切换
                            renderer.toolSetFocus(renderer.toolFocus() == 1 ? 2 : 1);
                            continue;
                        }
                        if (renderer.seedFieldKey(key->code, key->shift, cmd, key->alt)) continue;
                    } else if (renderer.seedStage() == Renderer::SeedStage::Confirm) {
                        if (key->code == sf::Keyboard::Key::Enter) {
                            if (hasPendingSeed) applySeed(pendingSeed);
                            continue;
                        }
                    }
                    if (key->code == sf::Keyboard::Key::Escape) { renderer.closeSeedUi(); continue; }
                    continue;
                }
                if (renderer.setupEditing()) { // 数字输入中：退格/回车/Esc
                    // 输入法可能吞掉 TextEntered，这里用数字键兜底（含小键盘、全角由 setupTextChar 处理）
                    if (key->code >= sf::Keyboard::Key::Num0 && key->code <= sf::Keyboard::Key::Num9) {
                        renderer.setupTextChar(static_cast<char32_t>(
                            U'0' + (static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Num0))));
                        continue;
                    }
                    if (key->code >= sf::Keyboard::Key::Numpad0 && key->code <= sf::Keyboard::Key::Numpad9) {
                        renderer.setupTextChar(static_cast<char32_t>(
                            U'0' + (static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Numpad0))));
                        continue;
                    }
                    switch (key->code) {
                    case sf::Keyboard::Key::Backspace:
                        renderer.setupBackspace();
                        continue;
                    case sf::Keyboard::Key::Enter:
                        renderer.setupCommitEdit();
                        continue;
                    case sf::Keyboard::Key::Escape:
                        renderer.setupCancelEdit();
                        continue;
                    default:
                        break;
                    }
                }
                if (renderer.setupOpen()) { // 面板打开时吞掉其余按键：否则输入数字会触发重开/切难度
                    if (key->code == sf::Keyboard::Key::Escape) renderer.closeSetup();
                    continue;
                }
                if (renderer.menuOpen()) { // 菜单键盘操作：上下选、Enter 确认、Esc 取消、1-5 直接选
                    int pick = -1; // 1-5 = 菜单第 1-5 项（+1 -1 +i -i clear）
                    if (key->code >= sf::Keyboard::Key::Num1 && key->code <= sf::Keyboard::Key::Num5)
                        pick = static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Num1);
                    else if (key->code >= sf::Keyboard::Key::Numpad1 && key->code <= sf::Keyboard::Key::Numpad5)
                        pick = static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Numpad1);
                    if (pick >= 0) {
                        const auto mc = renderer.menuCell();
                        board.setFlag(mc.first, mc.second, renderer.menuOptionAt(pick));
                        if (board.won()) {
                            phase = Phase::Won;
                            timerRunning = false;
                        }
                        renderer.closeMenu();
                        continue;
                    }
                    switch (key->code) {
                    case sf::Keyboard::Key::Up:
                        renderer.menuMove(-1);
                        continue;
                    case sf::Keyboard::Key::Down:
                        renderer.menuMove(1);
                        continue;
                    case sf::Keyboard::Key::Enter: {
                        const auto mc = renderer.menuCell();
                        board.setFlag(mc.first, mc.second, renderer.menuHighlightedOption());
                        if (board.won()) {
                            phase = Phase::Won;
                            timerRunning = false;
                        }
                        renderer.closeMenu();
                        continue;
                    }
                    case sf::Keyboard::Key::Escape:
                        renderer.closeMenu();
                        continue;
                    default:
                        break;
                    }
                }
                { // 数字快捷选择（菜单未开时）：1=+1 2=-1 3=+i 4=-i 5=清除，作用于鼠标下的格子
                    int n = -1;
                    if (key->code >= sf::Keyboard::Key::Num1 && key->code <= sf::Keyboard::Key::Num5)
                        n = static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Num1) + 1;
                    else if (key->code >= sf::Keyboard::Key::Numpad1 && key->code <= sf::Keyboard::Key::Numpad5)
                        n = static_cast<int>(key->code) - static_cast<int>(sf::Keyboard::Key::Numpad1) + 1;
                    if (n >= 1 && n <= 5 && phase == Phase::Playing && !renderer.confirmOpen() &&
                        !renderer.settingsOpen() && !renderer.setupOpen() && !renderer.helpOpen() &&
                        renderer.seedStage() == Renderer::SeedStage::None) {
                        if (const auto cell = renderer.cellAt(sf::Mouse::getPosition(window))) {
                            const MineType mt = (n == 5) ? MineType::None : static_cast<MineType>(n);
                            board.setFlag(cell->first, cell->second, mt);
                            if (board.won()) {
                                phase = Phase::Won;
                                timerRunning = false;
                            }
                        }
                        continue;
                    }
                }
                // 功能键快捷键（不在任何模态面板内时生效）
                if (!renderer.confirmOpen() && !renderer.settingsOpen() && !renderer.setupOpen() &&
                    renderer.seedStage() == Renderer::SeedStage::None) {
                    if (key->code == sf::Keyboard::Key::Escape && phase != Phase::Playing &&
                        !renderer.overlayHidden()) { // 终局后隐去结算横幅（与网页端一致）
                        renderer.hideOverlay();
                        continue;
                    }
                    if (key->code == sf::Keyboard::Key::F1) {
                        if (renderer.helpOpen()) renderer.closeHelp();
                        else { renderer.closeMenu(); renderer.openHelp(); }
                        continue;
                    }
                    if (key->code == sf::Keyboard::Key::F2) {
                        if (firstOpened && phase == Phase::Playing) {
                            pendingDiff = -1;
                            renderer.openRestartConfirm();
                        } else if (customActive) {
                            newCustom();
                        } else {
                            newGame(diffIdx);
                        }
                        continue;
                    }
                    if (key->code == sf::Keyboard::Key::F3 || key->code == sf::Keyboard::Key::F4 || key->code == sf::Keyboard::Key::F5) {
                        const int want = (key->code == sf::Keyboard::Key::F3) ? 0 : (key->code == sf::Keyboard::Key::F4) ? 1 : 2;
                        if (firstOpened && phase == Phase::Playing) {
                            pendingDiff = want;
                            const std::string nm = std::to_string(kDiffs[want].cols) + "x" + std::to_string(kDiffs[want].rows) +
                                                   "（" + std::to_string(kDiffs[want].mines) + "雷）";
                            renderer.openSwitchConfirm(nm);
                        } else {
                            newGame(want);
                        }
                        continue;
                    }
#if MS_SOLVER_HINTS
                    if (key->code == sf::Keyboard::Key::H) { // 求解器提示：推荐开格/标雷/最低风险猜
                        if (phase != Phase::Playing || !firstOpened) {
                            renderer.setSeedNote("提示 · 先翻开一格再来");
                            continue;
                        }
                        msolve::Solver sv(board.cols(), board.rows(), board.mineCount(), false, 1);
                        msolve::SolverStats st;
                        sv.analyzeForHint(board, st); // 只读分析，不动棋盘
                        std::string msg = "提示 · 无可用推断";
                        int hr = -1, hc = -1;
                        if (!sv.forcedSafe().empty()) {
                            const int g = sv.forcedSafe()[0];
                            hr = g / board.cols(); hc = g % board.cols();
                            msg = "提示 · 推断安全 (" + std::to_string(hr) + "," + std::to_string(hc) + ") P(雷)=0";
                        } else if (!sv.mustMine().empty()) {
                            const int g = sv.mustMine()[0].first;
                            hr = g / board.cols(); hc = g % board.cols();
                            msg = "提示 · 推断必雷 (" + std::to_string(hr) + "," + std::to_string(hc) + ") 类型 " +
                                  mineTypeLabel(sv.mustMine()[0].second) + " P(雷)=100%";
                        } else if (!sv.candidates().empty()) {
                            int pick = sv.candidates()[0];
                            double best = sv.pickProb()[pick];
                            for (int g : sv.candidates()) if (sv.pickProb()[g] < best) { best = sv.pickProb()[g]; pick = g; }
                            hr = pick / board.cols(); hc = pick % board.cols();
                            std::ostringstream ss;
                            const double pct = best * 100.0;
                            if (pct < 0.01) ss << "<0.01"; // 极低但非零，不能四舍五入成 0.0% 与「推断安全」混淆
                            else if (pct < 0.1) ss << std::fixed << std::setprecision(2) << pct;
                            else ss << std::fixed << std::setprecision(1) << pct;
                            if (sv.pickUnknown(pick))
                                msg = "提示 · 被迫猜 (" + std::to_string(hr) + "," + std::to_string(hc) +
                                      ") P(雷)未知（采样不可靠，不能当 0）";
                            else
                                msg = "提示 · 被迫猜 (" + std::to_string(hr) + "," + std::to_string(hc) + ") P(雷)" +
                                      (sv.approx() ? "≈" : "=") + ss.str() + "%" +
                                      (sv.approx() ? "（估计）" : "（精确）");
                        }
                        if (hr >= 0) {
                            const auto cnt = boardCounts();
                            hintOpenedCount = cnt.first; hintFlagCount = cnt.second;
                            renderer.setHintCell(hr, hc);
                        } else renderer.clearHintCell();
                        renderer.setSeedNote(msg);
                        continue;
                    }
#endif
                }
                continue;
            }
            if (const auto* mm = event->getIf<sf::Event::MouseMoved>()) {
                if (renderer.helpDragging()) { renderer.helpDragMove(mm->position); continue; } // 帮助面板滚动条跟手
                if (renderer.settingsScrollDragging()) { renderer.settingsDragMove(mm->position); continue; } // 设置面板滚动条跟手
                renderer.setupMove(mm->position);
                renderer.settingsMove(mm->position);
                renderer.bgMove(mm->position);
                if (boxDragging) renderer.seedClickInBox(mm->position, true); // 拖动选择文本
                continue;
            }
            if (event->is<sf::Event::MouseButtonReleased>()) {
                renderer.helpDragEnd();
                renderer.settingsDragEnd();
                renderer.setupRelease();
                renderer.settingsRelease();
                renderer.bgRelease();
                boxDragging = false;
                continue;
            }
            const auto* mb = event->getIf<sf::Event::MouseButtonPressed>();
            if (!mb || !window.hasFocus()) continue;

            // 装饰特效：左键**打中流星**才炸一圈（fxRipple 返回是否命中）+ 左/右键弹一组 USTC 字母。
            // 命中的那一下要把点击**吞掉**：否则炸圈的同时还会翻开底下的格子 / 点中底下的按钮。
            // 没打中一律照常处理，插旗/翻开的判定完全不受影响。
            const bool fxHit = (mb->button == sf::Mouse::Button::Left) && renderer.fxRipple(mb->position);
            if (mb->button == sf::Mouse::Button::Left || mb->button == sf::Mouse::Button::Right)
                renderer.fxBurst(mb->position);
            if (fxHit) continue;   // 只吞这一击，不碰其它事件

            if (mb->button == sf::Mouse::Button::Left) {
                if (renderer.confirmOpen()) { // 确认框最优先（可能在设置面板之外，比如局中重启）
                    const Renderer::ConfirmHit ch = renderer.confirmHit(mb->position);
                    if (ch == Renderer::ConfirmHit::Yes) {
                        const auto ck = renderer.confirmKind();
                        const bool wasRestart = (ck == Renderer::ConfirmKind::Restart || ck == Renderer::ConfirmKind::Switch);
                        const int wantDiff = pendingDiff;
                        pendingDiff = -1;
                        renderer.closeConfirm();
                        if (wasRestart) { // 确认后才真正执行：START 挂起的自定义开局 / 切难度 / 重开当前局
                            if (wantDiff == 3) { customCfg = pendingCustomCfg; newCustom(); }
                            else if (wantDiff >= 0) newGame(wantDiff);
                            else if (customActive) newCustom();
                            else newGame(diffIdx);
                        } else {
                            renderer.resetAllSettings();
                            renderer.setSeedNote("DEFAULTS RESTORED");
                        }
                    } else if (ch == Renderer::ConfirmHit::Cancel || ch == Renderer::ConfirmHit::Outside) {
                        pendingDiff = -1; // 取消即作废，防止挂起的难度切换串到下一次确认
                        renderer.closeConfirm();
                    }
                    continue;
                }
                if (renderer.helpOpen()) { // 游戏说明面板：滚动条可拖，其余任意点击关闭
                    if (renderer.helpHitScrollbar(mb->position)) renderer.helpDragBegin(mb->position);
                    else renderer.closeHelp();
                    continue;
                }
                if (renderer.settingsOpen()) { // 设置面板（模态）
                    if (renderer.settingsHitScrollbar(mb->position)) {
                        renderer.settingsDragBegin(mb->position);
                        continue;
                    }
                    using SH = Renderer::SettingsHit;
                    const SH hit = renderer.settingsHit(mb->position);
                    const int hi = static_cast<int>(hit);
                    if (hit == SH::Close || hit == SH::Outside) {
                        renderer.closeSettings();
                    } else if (hit == SH::None) {
                        if (renderer.settingsFocus() != 0) renderer.settingsFocusOn(0); // 点空白处取消焦点
                    } else if (hit == SH::BrowseBg) {
                        const std::string path = ms::pickImageFile();
                        if (!path.empty() && !renderer.setBackgroundImage(path))
                            renderer.setSeedNote(imageErr());
                    } else if (hit == SH::ResetBg) {
                        renderer.resetBackground();
                    } else if (hit == SH::BgField) {
                        renderer.settingsFocusOn(13); // 背景色 #RRGGBB（空着回车 = 回内置图）
                    } else if (hit == SH::HexField) {
                        renderer.settingsFocusOn(5); // 色号 #RRGGBB
                    } else if (hi >= static_cast<int>(SH::FieldR) && hi <= static_cast<int>(SH::FieldB)) {
                        renderer.settingsFocusOn(6 + (hi - static_cast<int>(SH::FieldR))); // R/G/B
                    } else if (hit == SH::ResetColor) {
                        renderer.resetCellColor();
                    } else if (hi >= static_cast<int>(SH::ChordSilent) &&
                               hi <= static_cast<int>(SH::ChordBoom)) {
                        const int i = hi - static_cast<int>(SH::ChordSilent);
                        renderer.setChordFailMode(i == 0   ? Renderer::ChordFailMode::Silent
                                                  : i == 2 ? Renderer::ChordFailMode::Boom
                                                           : Renderer::ChordFailMode::Hint);
                    } else if (hit == SH::DcTrack) {
                        renderer.settingsPressTrack(mb->position);
                    } else if (hit == SH::StarTrack) {
                        renderer.settingsPressTrack(mb->position, 2); // 星光密度
                    } else if (hit == SH::ScaleTrack) {
                        renderer.settingsPressTrack(mb->position, 3); // 星光大小
                    } else if (hit == SH::DcValue) {
                        renderer.settingsFocusOn(9);
                    } else if (hit == SH::StarValue) {
                        renderer.settingsFocusOn(11); // 星光密度：点框进入输入
                    } else if (hit == SH::ScaleValue) {
                        renderer.settingsFocusOn(12); // 星光大小：点框进入输入
                    } else if (hit == SH::AnimFx) {
                        renderer.toggleAnimFx(); // 动效总开关
                    } else if (hit == SH::RestoreAll) {
                        renderer.openRestoreConfirm(); // 删除动作：先弹确认框
                    } else if (hi >= static_cast<int>(SH::Field1) && hi <= static_cast<int>(SH::Field4)) {
                        renderer.settingsFocusOn(hi - static_cast<int>(SH::Field1) + 1);
                    } else if (hi >= static_cast<int>(SH::Browse1) && hi <= static_cast<int>(SH::Browse4)) {
                        const int i = hi - static_cast<int>(SH::Browse1) + 1;
                        const std::string path = ms::pickImageFile();
                        if (!path.empty() && !renderer.setMarkerImage(static_cast<MineType>(i), path))
                            renderer.setSeedNote(imageErr());
                    } else if (hi >= static_cast<int>(SH::Clear1) && hi <= static_cast<int>(SH::Clear4)) {
                        const int i = hi - static_cast<int>(SH::Clear1) + 1;
                        renderer.clearMarkerImage(static_cast<MineType>(i));
                        renderer.setMarkerChar(static_cast<MineType>(i), std::string()); // 字符也一起清掉
                    } else if (hit == SH::BlankField) {
                        renderer.settingsFocusOn(10); // 空白格字符
                    } else if (hit == SH::BlankBrowse) {
                        const std::string path = ms::pickImageFile();
                        if (!path.empty() && !renderer.setBlankImage(path))
                            renderer.setSeedNote(imageErr());
                    } else if (hit == SH::BlankClear) {
                        renderer.clearBlankImage();
                        renderer.setBlankChar(std::string()); // 字符也一起清掉
                    }
                    continue;
                }
                if (renderer.seedStage() != Renderer::SeedStage::None) { // 种子界面（模态）
                    if (renderer.seedBoxMenuOpen()) { // 先处理输入框右键菜单
                        const int bi = renderer.seedBoxMenuItemAt(mb->position);
                        if (bi >= 0) seedBoxAction(bi);
                        else renderer.closeSeedBoxMenu();
                        continue;
                    }
                    if (renderer.seedStage() == Renderer::SeedStage::Load &&
                        renderer.seedHit(mb->position) == Renderer::SeedHit::Box) {
                        const bool shift = sf::Keyboard::isKeyPressed(sf::Keyboard::Key::LShift) ||
                                           sf::Keyboard::isKeyPressed(sf::Keyboard::Key::RShift);
                        renderer.seedClickInBox(mb->position, shift);
                        boxDragging = true;
                        continue;
                    }
                    switch (renderer.seedHit(mb->position)) {
                    case Renderer::SeedHit::MenuCopy:
                        if (renderer.seedMenuEnabled(0)) copySeed("new");
                        break;
                    case Renderer::SeedHit::MenuSave:
                        if (renderer.seedMenuEnabled(1)) copySeed("save");
                        break;
                    case Renderer::SeedHit::MenuLoad:
                        renderer.openSeedLoadDialog(""); // 默认留空
                        break;
                    case Renderer::SeedHit::MenuTool:
                        renderer.openSeedToolbox(firstOpened ? currentSeedText("new") : std::string());
                        break;
                    case Renderer::SeedHit::ToolKey:
                        renderer.toolSetFocus(1);
                        renderer.toolClickInBox(mb->position);
                        break;
                    case Renderer::SeedHit::ToolIn:
                        renderer.toolSetFocus(2);
                        renderer.toolClickInBox(mb->position);
                        break;
                    case Renderer::SeedHit::ToolDecode:
                        renderer.toolDecode();
                        break;
                    case Renderer::SeedHit::ToolEncode:
                        renderer.toolEncode();
                        break;
                    case Renderer::SeedHit::ToolCopy: {
                        if (renderer.toolOut().empty()) {
                            renderer.setSeedNote("没有可复制的结果");
                            break;
                        }
                        setClipboard(renderer.toolOut());
                        renderer.setSeedNote("COPIED!");
                        break;
                    }
                    case Renderer::SeedHit::ToolClose:
                        renderer.closeSeedUi();
                        break;
                    case Renderer::SeedHit::Paste:
                        // 上限与过滤都在 seedInputSet 里做（★4：这里原来是裸赋值，
                        // 三条剪贴板路里唯独它绕过闸门）。不在这里先清空再 seedInsert，
                        // 因为那条路超长时会「一个字符都不进且不说为什么」。
                        renderer.seedInputSet(clipboardText());
                        break;
                    case Renderer::SeedHit::Ok:
                        applySeedFromInput();
                        break;
                    case Renderer::SeedHit::Yes:
                        if (hasPendingSeed) applySeed(pendingSeed);
                        break;
                    case Renderer::SeedHit::Cancel:
                    case Renderer::SeedHit::No:
                    case Renderer::SeedHit::Outside:
                        renderer.closeSeedUi();
                        break;
                    case Renderer::SeedHit::None:
                    default:
                        break;
                    }
                    continue; // 种子界面开着时不穿透到棋盘
                }
                if (const int zone = renderer.bgHitZone(mb->position)) { // 表头背景透明度
                    if (zone == 2) renderer.bgFocusEdit();             // 点百分比 -> 直接输入
                    else renderer.bgPress(mb->position);               // 拖滑条
                    continue;
                }
                if (renderer.setupOpen()) {
                    const auto action = renderer.setupPress(mb->position);
                    if (action == Renderer::SetupAction::Start) {
                        const SetupConfig cand = renderer.setup();
                        // 兜底校验：窗口绝不允许超出屏幕可用区域（输入框理论上已拦住，这里再保一道）
                        const int capCols = std::max(5, ms::Renderer::maxColsAtMinimumCell());
                        const int capRows = std::max(5, ms::Renderer::maxRowsAtMinimumCell());
                        if (cand.cols > capCols || cand.rows > capRows) {
                            renderer.setSeedNote("GRID TOO BIG FOR SCREEN");
                            continue;
                        }
                        pendingCustomCfg = cand;
                        // 局中点 START 才真正重置本局——确认放这里（规格=面板当前值）
                        if (firstOpened && phase == Phase::Playing) {
                            pendingDiff = 3;
                            renderer.openSwitchConfirm("自定义局面（" + std::to_string(cand.cols) + "x" + std::to_string(cand.rows) +
                                                       "，" + std::to_string(cand.mines()) + "雷）");
                        } else {
                            customCfg = cand; // 无需确认时直接生效
                            newCustom();
                        }
                    } else if (action == Renderer::SetupAction::Cancel) {
                        renderer.closeSetup();
                    }
                    continue; // 面板开着时不翻格子
                }
                if (renderer.menuOpen()) {
                    // 菜单开着时：点菜单项就应用，点其它任何地方（含格子）只关菜单，不翻格子
                    const int item = renderer.menuItemAt(mb->position);
                    if (item >= 0) {
                        const auto mc = renderer.menuCell();
                        board.setFlag(mc.first, mc.second, renderer.menuOptionAt(item));
                        if (board.won()) {
                            phase = Phase::Won;
                            timerRunning = false;
                        }
                    }
                    renderer.closeMenu();
                    continue;
                }
                const auto ha = renderer.headerActionAt(mb->position);
                switch (ha) {
                case Renderer::HeaderAction::Restart:
                    if (firstOpened && phase == Phase::Playing) {
                        pendingDiff = -1;
                        renderer.openRestartConfirm(); // 局中误触会丢进度：先确认
                    } else if (customActive) {
                        newCustom();
                    } else {
                        newGame(diffIdx);
                    }
                    continue;
                case Renderer::HeaderAction::PlayAgain:
                    // 终局重开：与当前口径一致再来一局（自定义局沿用自定义配置）
                    if (customActive)
                        newCustom();
                    else
                        newGame(diffIdx);
                    continue;
                // 难度切换与重开同一套确认：局中（已翻开且未分胜负）先弹框，确认后切
                case Renderer::HeaderAction::Easy:
                case Renderer::HeaderAction::Medium:
                case Renderer::HeaderAction::Hard: {
                    const int want = (ha == Renderer::HeaderAction::Easy) ? 0 : (ha == Renderer::HeaderAction::Medium) ? 1 : 2;
                    if (firstOpened && phase == Phase::Playing) {
                        pendingDiff = want;
                        // 确认框文案带规格：a*b 后括号注明雷数（与 kDiffs 同源，不硬编码）
                        const std::string nm = std::to_string(kDiffs[want].cols) + "x" + std::to_string(kDiffs[want].rows) +
                                               "（" + std::to_string(kDiffs[want].mines) + "雷）";
                        renderer.openSwitchConfirm(nm);
                    } else {
                        newGame(want);
                    }
                    continue;
                }
                case Renderer::HeaderAction::Settings:
                    renderer.closeSetup();
                    renderer.closeMenu();
                    renderer.closeSeedUi();
                    renderer.openSettings();
                    continue;
                case Renderer::HeaderAction::Help:
                    renderer.closeSetup();
                    renderer.closeMenu();
                    renderer.closeSeedUi();
                    renderer.openHelp();
                    continue;
                case Renderer::HeaderAction::HideCounts:
                    renderer.toggleHideCounts();
                    continue;
                case Renderer::HeaderAction::AlwaysMagnitude:
                    renderer.toggleAlwaysMagnitude();
                    board.setMagnitudeMode(renderer.alwaysMagnitude()); // 口径同步切换；棋盘状态不丢
                    if (phase == Phase::Playing && board.won()) { // 当前标记可能已满足新口径
                        phase = Phase::Won;
                        timerRunning = false;
                    }
                    continue;
                case Renderer::HeaderAction::Ustc:
                    renderer.toggleUstcMode();
                    continue;
                case Renderer::HeaderAction::Seed:
                    renderer.closeSetup();
                    renderer.closeMenu();
                    // 复制需先开局（翻开过一格）；胜利/失败后仍可复制
                    renderer.openSeedMenu(firstOpened ? currentSeedText("new") : std::string(), firstOpened,
                                          firstOpened ? saveHintText() : std::string());
                    continue;
                case Renderer::HeaderAction::Custom: {
                    openCustomPanel(); // 点 CUSTOM 只是开面板，不丢进度，直接开；真正丢进度的 START 里才确认
                    continue;
                }
                default:
                    break;
                }
                if (phase != Phase::Playing) { // 结束后：三选按钮优先；点别处仍是隐藏横幅观察局面
                    const auto oh = renderer.overlayHit(mb->position);
                    if (oh == Renderer::OverlayHit::SameRound) {
                        replayCurrentGame();
                        renderer.setSeedNote("SAME ROUND! - from your first click");
                        continue;
                    }
                    if (oh == Renderer::OverlayHit::NewGame) {
                        if (customActive) newCustom(); else newGame(diffIdx);
                        continue;
                    }
                    if (!renderer.overlayHidden()) renderer.hideOverlay();
                    continue;
                }
                if (renderer.zeroTipPopupOpen()) { // 黄 0 教学弹窗：点弹窗外任意部分关闭并吞掉这一击，不落到棋盘
                    if (renderer.zeroTipHit(mb->position) == Renderer::ZeroTipHit::Outside)
                        renderer.closeZeroTip();
                    continue;
                }
                const auto cell = renderer.cellAt(mb->position);
                if (!cell) { // 点到棋盘外：清掉双击记录，避免「格A → 空白 → 格A」在极短时间内被误判成双击 chord
                    lastClickCell = std::make_pair(-1, -1);
                    lastClickTime = std::chrono::steady_clock::now();
                    continue;
                }
                renderer.addRipple(sf::Vector2f(mb->position)); // 点击涟漪（双击/chord 也会经过这里，与网页端同口径）

                // —— 双击开格（chord）：中键，或左键在同一格上快速双击 ——
                // 只对"已翻开的数字格 + 周围雷都按正确类型标记"生效，否则什么也不做。
                {
                    const auto now = std::chrono::steady_clock::now();
                    const bool dbl = (mb->button == sf::Mouse::Button::Left) && (*cell == lastClickCell) &&
                                     std::chrono::duration<double>(now - lastClickTime).count() <
                                         renderer.doubleClickMs() / 1000.0; // 阈值可在设置里调
                    if (mb->button == sf::Mouse::Button::Left) {
                        lastClickCell = *cell;
                        lastClickTime = now;
                    }
                    if (mb->button == sf::Mouse::Button::Middle || dbl) {
                        renderer.noteRevealOrigin(cell->first, cell->second); // 波前动画的起点
                        const Board::ChordResult chord = board.chordOpen(cell->first, cell->second);
                        if (chord == Board::ChordResult::Opened) {
                            if (!timerRunning) {
                                t0 = now;
                                timerRunning = true;
                            }
                            if (board.won()) {
                                phase = Phase::Won;
                                timerRunning = false;
                            }
                        } else if (chord == Board::ChordResult::Blocked) {
                            // 是合法的开格目标，但周围雷没全部按正确类型标记：
                            // 按设置决定 静默 / 提示 / 直接爆炸
                            switch (renderer.chordFailMode()) {
                                case Renderer::ChordFailMode::Silent:
                                    break;
                                case Renderer::ChordFailMode::Hint:
                                    renderer.setSeedNote("BAD MARKS");
                                    break;
                                case Renderer::ChordFailMode::Boom: {
                                    board.forEachNeighbor(cell->first, cell->second, [&](int nr, int nc) {
                                        if (phase != Phase::Playing || !board.inBounds(nr, nc)) return;
                                        if (board.at(nr, nc).mine == MineType::None) return;
                                        board.setFlag(nr, nc, MineType::None);
                                        if (board.open(nr, nc) == Board::Outcome::Boom) {
                                            phase = Phase::Lost;
                                            timerRunning = false;
                                        }
                                    });
                                    break;
                                }
                            }
                        }
                        if (phase == Phase::Playing) renderer.maybeStartZeroTip(board); // chord 揭开的 0 也算「首现」
                        continue;
                    }
                }
                if (board.at(cell->first, cell->second).opened) continue; // 已翻开：左键不再重复处理
                if (!firstOpened) { // 记录首点：复现同一局的关键
                    firstOpened = true;
                    firstR = cell->first;
                    firstC = cell->second;
                }
                renderer.noteRevealOrigin(cell->first, cell->second); // 波前动画的起点
                const auto res = board.open(cell->first, cell->second);
                if (res == Board::Outcome::Boom) {
                    phase = Phase::Lost;
                    timerRunning = false;
                } else if (res == Board::Outcome::Won) {
                    phase = Phase::Won;
                    timerRunning = false;
                } else if (!timerRunning && !focusPaused) { // 首点开格完成后才启动计时
                    t0 = std::chrono::steady_clock::now();
                    timerRunning = true;
                }
                if (phase == Phase::Playing) renderer.maybeStartZeroTip(board); // 黄 0 首现教学（读档恢复路径不触发）
            } else if (mb->button == sf::Mouse::Button::Right) {
                if (renderer.seedStage() == Renderer::SeedStage::Load) { // 输入框右键菜单
                    if (renderer.seedHit(mb->position) == Renderer::SeedHit::Box)
                        renderer.openSeedBoxMenu(mb->position);
                    else
                        renderer.closeSeedBoxMenu();
                    continue;
                }
                if (renderer.setupOpen()) continue;
                if (renderer.zeroTipPopupOpen()) { // 右键同样遵循「点外关闭」：单技巧也能关掉弹窗
                    if (renderer.zeroTipHit(mb->position) == Renderer::ZeroTipHit::Outside)
                        renderer.closeZeroTip();
                    continue;
                }
                if (phase != Phase::Playing) {
                    renderer.closeMenu();
                    continue;
                }
                if (const auto cell = renderer.cellAt(mb->position)) {
                    renderer.openMenu(board, *cell, mb->position); // 右键弹出标记菜单
                } else {
                    renderer.closeMenu();
                }
            }
        }

        // 暂停计时的两种情形：① 切到别的窗口/程序；② 打开了设置/自定义局/种子等非棋盘面板。
        // 回到棋盘（或面板关掉）再接着走，已用时间不清零。
        // 注：右键标记菜单不算（调旗子是局内动作，不该让表跳）。
        const bool panelOpenNow = renderer.settingsOpen() || renderer.setupOpen() || renderer.confirmOpen() ||
                                  renderer.helpOpen() || // 看说明时也暂停计时
                                  renderer.seedStage() != Renderer::SeedStage::None;
        if (phase == Phase::Playing && firstOpened) {
            const bool ticking = window.hasFocus() && !panelOpenNow; // 只有"正在看棋盘"才走表
            const auto nowT = std::chrono::steady_clock::now();
            if (timerRunning && !ticking) { // 暂停：先把已用时间结算下来
                elapsed = std::chrono::duration<double>(nowT - t0).count();
                timerRunning = false;
                focusPaused = true;
            } else if (!timerRunning && !focusPaused && ticking) { // 冷启动：载入种子/复现局后棋盘已就绪就该走表（与网页端 settleTimer 一致）
                t0 = nowT;
                timerRunning = true;
            } else if (!timerRunning && focusPaused && ticking) { // 继续：从已用时间处接上
                t0 = nowT - std::chrono::duration_cast<std::chrono::steady_clock::duration>(
                                std::chrono::duration<double>(elapsed));
                timerRunning = true;
                focusPaused = false;
            }
        }

        if (timerRunning) {
            elapsed = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
        }

        Hud hud;
        hud.remaining = board.remaining();
        hud.seconds = elapsed; // 保留 0.1s 精度给显示层
        hud.phase = phase;
        hud.paused = focusPaused;
        renderer.setPlayAgainVisible(phase != Phase::Playing);
        // 终局按钮常驻：只有点它/换难度才消失，点棋盘观察不影响

        window.clear(sf::Color(233, 238, 244));
        renderer.seedEndFrame(); // 本帧事件批走完：没被 TextEntered 销账的兜底键在这里落地
        renderer.tickSeedNote();
        renderer.tickZeroTip(); // 黄 0 教学：闪烁满 1.5s 自动进弹窗阶段
#if MS_SOLVER_HINTS
        renderer.tickHint();
        // 提示高亮失效：棋盘有变（翻开/标记数对不上）或已分胜负就撤掉
        if (renderer.hasHintCell()) {
            bool changed = (phase != Phase::Playing);
            if (!changed) {
                const auto cnt = boardCounts();
                changed = (cnt.first != hintOpenedCount || cnt.second != hintFlagCount);
            }
            if (changed) renderer.clearHintCell();
        }
#endif
        renderer.draw(board, sf::Mouse::getPosition(window), hud, window);
        window.display();
    }
    return 0;
}
