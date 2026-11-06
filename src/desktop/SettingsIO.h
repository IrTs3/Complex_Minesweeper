#pragma once
// 配置持久化：所有配置与用户选择的图片都放在「可执行文件同级的 config/ 目录」。
//   config/settings.ini      —— 可读的文本配置
//   config/<slot>.<ext>      —— 用户选的图片（background / marker_plus1 ...）
// 只依赖 C++20 标准库，方便单独测试。
#include <string>

namespace ms {

struct MarkerSetting {
    std::string kind = "default"; // "default" | "char" | "image"
    std::string value;            // kind=char 时是单字符；kind=image 时是配置目录里的文件名
};

struct SettingsData {
    int cellR = 102, cellG = 204, cellB = 255; // 格子颜色（默认 #66CCFF）
    std::string chordFail = "hint";            // 双击开格失败时：silent / hint / boom
    int doubleClickMs = 400;                   // 双击判定时长（毫秒，150..1500）
    bool hideCounts = false;                   // 是否隐藏轴计数（表头 ±1/±i 芯片里的数字）
    bool alwaysMagnitude = false;              // 是否总是显示模长（非零提示一律显示 |z|，含纯实/纯虚）
    bool ustcMode = false;                     // 彩蛋：未翻开未标记的雷上显示 USTC 字母
    bool animFx = true;                        // 动效总开关（ANIM FX；关 = 全部动效退化为即时绘制）
    // 玩法介绍是否展示过。默认 true 是刻意的：老用户的 ini 里没有 helpseen 这一行，
    // 读出来走默认 —— 升级不该被当成「第一次玩」。只有「完全没有配置文件」才算首启。
    bool helpSeen = true;
    // 黄 0 首现教学（首次揭开「和恰好抵消」的黄 0 时闪烁 + 弹窗解释）是否已触发过。
    // 政策与 helpSeen 完全相同：ini 里没有这行 = 老玩家不再打扰。
    bool zeroTipSeen = true;
    float starDensity = 2.17f;                  // 星光密度（0..7.12 颗/100×100px，0 = 关闭）
    float starScale = 1.7f;                     // 星光半径倍率（0.6..3.0）
    std::string background;                    // 配置目录里的文件名，空 = 使用内置背景
    MarkerSetting marker[5];                   // 下标 1..4 对应 +1 / -1 / +i / -i（标记/旗子）
    MarkerSetting blank;                       // 翻开空白格（周围无雷）的自定义
};

// 可执行文件所在目录（取不到时返回空串）
std::string executableDir();

// 配置目录：可执行文件同级 config/；若不可写则退回用户目录下的隐藏目录
std::string settingsDir();

// 配置文件路径 = settingsDir() + "/settings.ini"
std::string settingsIniPath();

// 读 / 写配置文件（文件不存在时 load 返回 false，data 保持默认值）
bool loadSettingsFile(SettingsData& data);
bool saveSettingsFile(const SettingsData& data);
// 把用户选的图片复制进配置目录：会先删掉该槽位已有的图片（避免留下孤儿文件）。
// 返回复制后的文件名（失败返回空串）。
std::string importImage(const std::string& srcPath, const std::string& slot);

// 删除配置目录里的某张图片（传文件名，不是路径）
void removeImage(const std::string& fileName);

// 删除配置目录里所有图片，返回删除数量（用于"还原全部默认"）
int clearAllImages();

} // namespace ms
