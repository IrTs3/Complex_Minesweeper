#include "desktop/SettingsIO.h"

#include "ImageProbe.h"   // 文件头探针（图片闸门的唯一实现）

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <vector>

#if defined(__APPLE__)
#include <climits>
#include <mach-o/dyld.h>
#elif defined(_WIN32)
#include <windows.h>
#else
#include <climits>
#include <unistd.h>
#endif

namespace fs = std::filesystem;

#if !defined(__APPLE__) && !defined(_WIN32)
namespace ms {
std::pair<int, int> screenUsableSize() { return {0, 0}; } // 其它平台：交给渲染层兜底
} // namespace ms
#endif

namespace ms {
namespace {

std::string trim(const std::string& s) {
    const std::size_t a = s.find_first_not_of(" \t\r\n");
    if (a == std::string::npos) return std::string();
    const std::size_t b = s.find_last_not_of(" \t\r\n");
    return s.substr(a, b - a + 1);
}

// 配置里记录的图片名必须是「一个纯文件名」。
// （否则手改 settings.ini 或别人分享的 config 可能借 RESTORE ALL 删掉无关文件）
//
// ★ 2026-10-21 安全审计 P6：原来只挡 `/ \ ..`，但 **Windows 上 `C:foo.png`
//   是「盘符相对路径」** —— settingsDir()/"C:foo.png" 会解析到当前盘根，删除/写回
//   都能跳出配置目录。所以这里改成**禁止集**：
//     · 所有平台的路径语义字符：/ \ : * ? " < > |
//     · 控制字符、首空格、末尾的点或空格（Windows 会静默吃掉它们，导致
//       "校验的名字" 和 "实际文件名" 不一致）
//     · Windows 设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，带后缀也算）
//   为什么不用白名单 [A-Za-z0-9._-]：README 允许「整个 config 目录拷走」，
//   有人会自己改成中文名或带空格的名字，白名单会把它们全部变成"配置丢失"。
bool safeImageName(const std::string& name) {
    if (name.empty() || name.size() > 200) return false;
    if (name == "." || name == "..") return false;
    if (name.front() == ' ') return false;
    if (name.back() == '.' || name.back() == ' ') return false;
    for (unsigned char c : name) {
        if (c < 0x20 || c == 0x7F) return false;
        switch (c) {
            case '/': case '\\': case ':': case '*': case '?':
            case '"': case '<': case '>': case '|':
                return false;
            default: break;
        }
    }
    // Windows 设备名：取第一个点之前的部分，大写后比对
    std::string stem = name.substr(0, name.find('.'));
    for (char& c : stem) c = static_cast<char>(std::toupper(static_cast<unsigned char>(c)));
    static const char* kDev[] = {"CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"};
    for (const char* d : kDev)
        if (stem == d) return false;
    if (stem.size() == 4 && (stem.compare(0, 3, "COM") == 0 || stem.compare(0, 3, "LPT") == 0) &&
        stem[3] >= '1' && stem[3] <= '9')
        return false;
    return true;
}

bool dirWritable(const fs::path& dir) {
    std::error_code ec;
    const fs::path probe = dir / ".write_probe";
    // probe 处若已被人放了软链，ofstream 会顺着链把探针写去别处，
    // 「可写」结论直接失真 —— 有链就不认，宁可退到用户目录。
    if (fs::is_symlink(probe, ec)) return false;
    std::ofstream f(probe);
    if (!f.good()) return false;
    f.close();
    fs::remove(probe, ec);
    return true;
}

} // namespace

std::string executableDir() {
#if defined(__APPLE__)
    std::uint32_t size = 0;
    _NSGetExecutablePath(nullptr, &size);
    std::vector<char> buf(size + 1, 0);
    if (_NSGetExecutablePath(buf.data(), &size) != 0) return std::string();
    char resolved[PATH_MAX];
    if (realpath(buf.data(), resolved) == nullptr) return std::string();
    return fs::path(resolved).parent_path().string();
#elif defined(_WIN32)
    // 用宽字符版本，否则中文用户名/中文目录会乱码
    std::vector<wchar_t> buf(32768, static_cast<wchar_t>(0));
    const DWORD n = GetModuleFileNameW(nullptr, buf.data(), static_cast<DWORD>(buf.size()));
    if (n == 0) return std::string();
    const int need = WideCharToMultiByte(CP_UTF8, 0, buf.data(), -1, nullptr, 0, nullptr, nullptr);
    if (need <= 0) return std::string();
    std::string utf8(static_cast<std::size_t>(need), static_cast<char>(0));
    WideCharToMultiByte(CP_UTF8, 0, buf.data(), -1, utf8.data(), need, nullptr, nullptr);
    if (!utf8.empty() && utf8.back() == static_cast<char>(0)) utf8.pop_back();
    return fs::path(utf8).parent_path().string();
#else
    std::error_code ec;
    const fs::path p = fs::read_symlink("/proc/self/exe", ec);
    if (ec) return std::string();
    return p.parent_path().string();
#endif
}

// 是否位于 .app 包内（打包分发的情况）
bool insideAppBundle(const std::string& exeDir) {
    return exeDir.find(".app/Contents/MacOS") != std::string::npos;
}

std::string settingsDir() {
    static const std::string cached = [] {
        std::error_code ec;
        const std::string exeDir = executableDir();

        // ★ 打包成 .app 时**绝不写包内**。
        //   以前这里写 Contents/MacOS/config，于是「打开一次 app」就把配置写进
        //   bundle，codesign 立刻失效：
        //     dist/…app: a sealed resource is missing or invalid
        //     file added: …/Contents/MacOS/config/settings.ini
        //   签名一坏，Finder 就退化成通用图标（用户报「app 图标是空的」），
        //   Gatekeeper 也可能拦。.app 必须当成只读，配置放系统惯例位置。
        if (insideAppBundle(exeDir)) {
            const char* home = std::getenv("HOME");
            if (home != nullptr && *home != 0) {
                const fs::path dir = fs::path(home) / "Library" / "Application Support" / "ComplexMinesweeper";
                fs::create_directories(dir, ec);
                if (fs::is_directory(dir, ec) && dirWritable(dir)) {
                    // 一次性迁移：老版本把 config/ 写在包内，别让用户的设置凭空消失。
                    // 只在目标**还没有** settings.ini 时搬，绝不覆盖已有配置。
                    const fs::path oldDir = fs::path(exeDir) / "config";
                    if (!fs::exists(dir / "settings.ini", ec) && fs::exists(oldDir / "settings.ini", ec)) {
                        // 逐文件复制：fs::copy(目录, 已存在的目录) 会变成 dir/config/，
                        // 不是把内容铺进 dir —— 这里必须显式摊平。
                        for (const auto& ent : fs::directory_iterator(oldDir, ec)) {
                            if (!ent.is_regular_file(ec)) continue;
                            fs::copy_file(ent.path(), dir / ent.path().filename(),
                                          fs::copy_options::overwrite_existing, ec);
                        }
                    }
                    return dir.string();
                }
            }
        }
        if (!exeDir.empty()) {
            const fs::path dir = fs::path(exeDir) / "config";
            fs::create_directories(dir, ec);
            if (fs::is_directory(dir, ec) && dirWritable(dir)) return dir.string();
        }
        // 退路：用户目录（可执行文件所在位置不可写时）
        const char* home = std::getenv("HOME");
        if (home == nullptr || *home == 0) home = std::getenv("USERPROFILE");
        const fs::path dir = (home != nullptr && *home != 0)
                                 ? fs::path(std::string(home)) / ".complex_minesweeper"
                                 : fs::path("complex_minesweeper_config");
        fs::create_directories(dir, ec);
        return dir.string();
    }();
    return cached;
}

std::string settingsIniPath() {
    return (fs::path(settingsDir()) / "settings.ini").string();
}

// settings.ini 的大小上限。真实文件约 1.5KB（含注释），留 40 倍余量。
// 之前对文件大小/单行长度**完全没有限制**：一行 2GB 的无换行数据会让
// std::getline 直接申请同等大小的 string（2026-10-21 安全审计 P5）。
static constexpr std::size_t kMaxSettingsBytes = 64 * 1024;

bool loadSettingsFile(SettingsData& data) {
    std::ifstream f(settingsIniPath(), std::ios::binary);
    if (!f) return false;
    // ★ 2026-10-21 安全审计 P5：有界读取。原来 std::getline 对一行 2GB 的数据会
    //   直接按行分配。超限时**丢掉最后那半行**（否则会把一个截断的值当成完整值解析）。
    std::string text(kMaxSettingsBytes, '\0');
    f.read(text.data(), static_cast<std::streamsize>(text.size()));
    text.resize(static_cast<std::size_t>(f.gcount()));
    if (!f.eof() && !text.empty()) {
        const std::size_t nl = text.find_last_of('\n');
        text.resize(nl == std::string::npos ? 0 : nl + 1);
    }
    std::istringstream in(text);
    SettingsData out;
    // 星光密度在 2026-10-22 换了单位（颗/100×100px）。新版会写 starunit = 2；
    // 没有这行的老配置里，stardensity 仍是「1512×982 下的颗数」，循环结束后再换算。
    bool starUnit2 = false;
    bool densitySeen = false;
    float rawStarDensity = out.starDensity;
    std::string line;
    while (std::getline(in, line)) {
        std::string s = trim(line);
        if (s.empty() || s[0] == ';' || s[0] == '#' || s[0] == '[') continue; // 注释 / 段名
        const std::size_t eq = s.find('=');
        if (eq == std::string::npos) continue;
        const std::string key = trim(s.substr(0, eq));
        std::string val = trim(s.substr(eq + 1));
        if (val.empty()) continue;
        if (key == "cell") { // R,G,B
            const std::size_t c1 = val.find(',');
            const std::size_t c2 = (c1 == std::string::npos) ? std::string::npos : val.find(',', c1 + 1);
            if (c1 == std::string::npos || c2 == std::string::npos) continue;
            const std::string sR = val.substr(0, c1);
            const std::string sG = val.substr(c1 + 1, c2 - c1 - 1);
            const std::string sB = val.substr(c2 + 1);
            char* endR = nullptr, *endG = nullptr, *endB = nullptr;
            const long r = std::strtol(sR.c_str(), &endR, 10);
            const long g = std::strtol(sG.c_str(), &endG, 10);
            const long b = std::strtol(sB.c_str(), &endB, 10);
            if (endR != sR.c_str() && *endR == 0 &&
                endG != sG.c_str() && *endG == 0 &&
                endB != sB.c_str() && *endB == 0 &&
                r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255) {
                out.cellR = r;
                out.cellG = g;
                out.cellB = b;
            }
        } else if (key == "chordfail") {
            if (val == "silent" || val == "hint" || val == "boom") out.chordFail = val;
        } else if (key == "hidecounts") {
            out.hideCounts = (val == "1" || val == "true");
        } else if (key == "alwaysmagnitude") {
            out.alwaysMagnitude = (val == "1" || val == "true");
        } else if (key == "ustc") {
            out.ustcMode = (val == "1" || val == "true");
        } else if (key == "animfx") {
            out.animFx = (val == "1" || val == "true");
        } else if (key == "helpseen") {
            out.helpSeen = (val == "1" || val == "true");
        } else if (key == "zerotipseen") {
            out.zeroTipSeen = (val == "1" || val == "true");
        } else if (key == "stardensity") {
            char* end = nullptr;
            const float v = std::strtof(val.c_str(), &end);
            if (end != val.c_str() && *end == 0 && v >= 0.f && v <= 800.f) {
                rawStarDensity = v;
                densitySeen = true;
            }
        } else if (key == "starunit") {
            // 2 = 颗/100×100px（新）；缺省 = 旧刻度（参考 1512×982 下的颗数）
            if (val == "2") starUnit2 = true;
        } else if (key == "starcount") {
            // 更旧的键：那时存的是参考分辨率下的绝对颗数，与旧密度等价。
            char* end = nullptr;
            const long n = std::strtol(val.c_str(), &end, 10);
            if (end != val.c_str() && *end == 0 && n >= 0 && n <= 500) {
                rawStarDensity = static_cast<float>(n);
                densitySeen = true;
            }
        } else if (key == "starscale") {
            char* end = nullptr;
            const float s = std::strtof(val.c_str(), &end);
            if (end != val.c_str() && *end == 0 && s >= 0.6f && s <= 3.0f) out.starScale = s;
        } else if (key == "doubleclick") {
            char* end = nullptr;
            const long ms = std::strtol(val.c_str(), &end, 10);
            if (end != val.c_str() && *end == 0 && ms >= 150 && ms <= 1500) out.doubleClickMs = static_cast<int>(ms);
        } else if (key == "background") {
            // 三种形态：default / '#RRGGBB' 纯色 / 配置目录里的图片文件名
            const bool isHexColor = val.size() == 7 && val[0] == '#' &&
                                    val.find_first_not_of("0123456789abcdefABCDEF", 1) == std::string::npos;
            if (isHexColor) out.background = val;
            else if (val != "default" && safeImageName(val)) out.background = val; // 拒绝路径穿越
        } else if (key.rfind("marker_", 0) == 0) {
            const std::string slot = key.substr(7); // plus1 / minus1 / plusi / minusi
            int idx = 0;
            if (slot == "plus1") idx = 1;
            else if (slot == "minus1") idx = 2;
            else if (slot == "plusi") idx = 3;
            else if (slot == "minusi") idx = 4;
            if (idx == 0) continue;
            if (val.rfind("char:", 0) == 0) {
                const std::string c = val.substr(5);
                // 与 UI 侧 isVisibleAscii（Renderer.cpp 0x21..0x7E）同判据：
                // 手改 ini 塞控制字符会加载成乱码字形还原样写回。
                if (c.size() == 1 && static_cast<unsigned char>(c[0]) >= 0x21 &&
                    static_cast<unsigned char>(c[0]) <= 0x7E) {
                    out.marker[idx].kind = "char";
                    out.marker[idx].value = c;
                }
            } else if (val.rfind("image:", 0) == 0) {
                const std::string name = val.substr(6);
                if (!safeImageName(name)) continue; // 拒绝路径穿越
                out.marker[idx].kind = "image";
                out.marker[idx].value = name;
            }
        } else if (key == "blank") {
            if (val.rfind("char:", 0) == 0) {
                const std::string c = val.substr(5);
                if (c.size() == 1 && static_cast<unsigned char>(c[0]) >= 0x21 &&
                    static_cast<unsigned char>(c[0]) <= 0x7E) {
                    out.blank.kind = "char";
                    out.blank.value = c;
                }
            } else if (val.rfind("image:", 0) == 0) {
                const std::string name = val.substr(6);
                if (!safeImageName(name)) continue;
                out.blank.kind = "image";
                out.blank.value = name;
            }
        }
    }
    if (densitySeen) {
        if (!starUnit2) {
            // 旧刻度：值 = 1512×982 下应有的颗数 → 折成「每 100×100 多少颗」，保留两位小数。
            rawStarDensity = rawStarDensity * 10000.0f / (1512 * 982);
            rawStarDensity = std::round(rawStarDensity * 100.f) / 100.f;
        }
        out.starDensity = std::clamp(rawStarDensity, 0.f, 7.12f);
    }
    data = out;
    return true;
}

bool saveSettingsFile(const SettingsData& data) {
    std::error_code ec;
    // settings.ini 若是软链（他人可写目录里的常见提权手），trunc 打开会改写链目标。
    if (fs::is_symlink(settingsIniPath(), ec)) return false;
    std::ofstream f(settingsIniPath(), std::ios::trunc);
    if (!f) return false;
    f << "; Complex Minesweeper 配置（本目录下还保存着自定义图片）\n";
    f << "; 删除本文件与图片即可恢复初始状态；也可以用游戏里的 RESTORE DEFAULTS 按钮。\n";
    f << "\n[appearance]\n";
    f << "; 格子底色 R,G,B（默认 102,204,255 即 #66CCFF）\n";
    f << "cell = " << data.cellR << "," << data.cellG << "," << data.cellB << "\n";
    f << "; 背景图：default 为内置背景，否则是本目录下的文件名\n";
    f << "background = " << (data.background.empty() ? std::string("default") : data.background) << "\n";
    f << "; 双击开格失败时：silent 静默 / hint 提示 / boom 直接爆炸\n";
    f << "chordfail = " << (data.chordFail.empty() ? std::string("hint") : data.chordFail) << "\n";
    f << "; 双击判定时长（毫秒，150..1500）\n";
    f << "doubleclick = " << data.doubleClickMs << "\n";
    f << "; 轴计数（表头 ±1/±i 芯片）是否隐藏：1=隐藏 0=显示\n";
    f << "hidecounts = " << (data.hideCounts ? 1 : 0) << "\n";
    f << "; 是否总是显示模长：1=开（非零提示一律显示 |z|，纯实/纯虚也不带符号）0=关（默认）\n";
    f << "alwaysmagnitude = " << (data.alwaysMagnitude ? 1 : 0) << "\n";
    f << "; 彩蛋：1=未翻开未标记的雷上显示 USTC 字母 0=关（默认）\n";
    f << "ustc = " << (data.ustcMode ? 1 : 0) << "\n";
    f << "; 动效总开关（ANIM FX）：1=开（默认）0=全部动效退化为即时绘制\n";
    f << "animfx = " << (data.animFx ? 1 : 0) << "\n";
    f << "; 玩法介绍是否展示过：1=已展示（不再自动弹）0=下次启动再弹一次\n";
    f << "helpseen = " << (data.helpSeen ? 1 : 0) << "\n";
    f << "; 黄 0 首现教学（首次揭开黄 0 时闪烁+弹窗解释）是否已触发过：1=已触发 0=未触发\n";
    f << "zerotipseen = " << (data.zeroTipSeen ? 1 : 0) << "\n";
    f << "; 星光密度（0..7.12 颗/100×100 逻辑像素，0 = 关闭；实际颗数按窗口面积换算）\n";
    f << "stardensity = " << data.starDensity << "\n";
    f << "; 密度单位版本：2 = 颗/100×100px。缺这行表示旧刻度（参考 1512×982 下的颗数）\n";
    f << "starunit = 2\n";
    f << "; 星光大小倍率（0.6..3.0）\n";
    f << "starscale = " << data.starScale << "\n";
    f << "\n[markers]\n";
    f << "; 四种标记：default / char:<单个可见字符> / image:<本目录下的文件名>\n";
    const char* names[5] = {"", "plus1", "minus1", "plusi", "minusi"};
    for (int i = 1; i <= 4; ++i) {
        const MarkerSetting& m = data.marker[i];
        f << "marker_" << names[i] << " = ";
        if (m.kind == "char" && !m.value.empty()) f << "char:" << m.value;
        else if (m.kind == "image" && !m.value.empty()) f << "image:" << m.value;
        else f << "default";
        f << "\n";
    }
    f << "\n[blank]\n";
    f << "; 翻开的空白格（周围无雷）：default / char:<单个可见字符> / image:<本目录下的文件名>\n";
    f << "blank = ";
    if (data.blank.kind == "char" && !data.blank.value.empty()) f << "char:" << data.blank.value;
    else if (data.blank.kind == "image" && !data.blank.value.empty()) f << "image:" << data.blank.value;
    else f << "default";
    f << "\n";
    return true;
}


std::string importImage(const std::string& srcPath, const std::string& slot) {
    if (srcPath.empty() || slot.empty()) return std::string();
    if (!safeImageName(slot)) return std::string(); // 槽位名也会拼进路径
    std::error_code ec;
    // 闸门放在**动磁盘之前**：下面那段会先删同槽位的旧图，一次失败的导入
    // 不该连原来能用的图一起没掉。
    //
    // ★ 2026-10-21 安全审计 P1/P3：这里必须用「读文件头拿宽高」，不能只看字节数。
    //   一张 70 字节、IHDR 声明 20000×20000 的 PNG 能轻松过 24MB 闸门，
    //   而解码它会申请约 2.1GB。probeFile 同时拒绝符号链接与未知格式。
    std::string why;
    const auto probe = imgprobe::probeFile(srcPath, &why);
    if (probe.st != imgprobe::St::Ok || !imgprobe::sizeOk(probe.w, probe.h)) return std::string();
    const char* canon = imgprobe::canonicalExt(probe.fmt);
    if (!canon || !*canon) return std::string();
    const fs::path dir = settingsDir();
    fs::create_directories(dir, ec);
    const fs::path src = fs::absolute(fs::path(srcPath), ec);
    // 按**魔数**决定后缀，而不是沿用源文件后缀：sf::Image::saveToFile 是按扩展名
    // 选编码器的（只认 bmp/tga/png/jpg/jpeg），沿用 ".gif" 会让回写静默失败。
    const std::string ext = canon;

    // 先删掉同槽位的旧图片（可能扩展名不同），避免留下孤儿文件
    for (const auto& entry : fs::directory_iterator(dir, ec)) {
        if (ec) break;
        if (!entry.is_regular_file(ec)) continue;
        if (entry.path().stem().string() == slot) fs::remove(entry.path(), ec);
    }
    const fs::path dst = dir / (slot + ext);
    if (src == dst) return dst.filename().string(); // 本来就是它自己
    // ★ 目标若已是符号链接，先摘链（只删链接本身，不动它指向的文件）。
    //   copy_file(overwrite) 会**顺着**软链写，等于把内容写到配置目录之外。
    std::error_code lec;
    if (fs::is_symlink(fs::symlink_status(dst, lec))) fs::remove(dst, lec);
    fs::copy_file(src, dst, fs::copy_options::overwrite_existing, ec);
    if (ec) return std::string();
    return dst.filename().string();
}

void removeImage(const std::string& fileName) {
    if (!safeImageName(fileName)) return; // 双保险：绝不允许删配置目录之外的东西
    std::error_code ec;
    fs::remove(fs::path(settingsDir()) / fileName, ec);
}

int clearAllImages() {
    // 只删 settings.ini 里实际引用的图片文件（背景 + 四种标记），
    // 不按扩展名通删——避免误删用户放在配置目录里的无关图片。
    SettingsData cur;
    if (!loadSettingsFile(cur)) return 0;
    std::error_code ec;
    int n = 0;
    auto removeIfExist = [&](const std::string& name) {
        if (!safeImageName(name)) return;
        const fs::path p = fs::path(settingsDir()) / name;
        if (fs::exists(p, ec)) {
            fs::remove(p, ec);
            ++n;
        }
    };
    if (!cur.background.empty() && cur.background != "default") removeIfExist(cur.background);
    for (int i = 1; i <= 4; ++i) {
        if (cur.marker[i].kind == "image") removeIfExist(cur.marker[i].value);
    }
    if (cur.blank.kind == "image") removeIfExist(cur.blank.value);
    return n;
}

} // namespace ms
