#pragma once
// 原生"选择图片文件"对话框（macOS 用 NSOpenPanel；其它平台暂返回空串）。
// 抽成独立小接口，避免把 ObjC 代码混进渲染层。
#include <string>
#include <utility>

namespace ms {

// 返回选中文件的绝对路径；用户取消或平台不支持时返回空串。
std::string pickImageFile();

// 屏幕"可用区域"（逻辑点，已排除菜单栏/程序坞/任务栏）。窗口尺寸用的是同一套单位，
// 不能拿 sf::VideoMode::getDesktopMode() 来算行列上限——它在部分环境下返回物理像素
// （Retina 下是 2 倍），会算出虚大的可用面积，让大棋盘窗口溢出屏幕。
// 取不到时返回 {0, 0}，调用方自行兜底。
std::pair<int, int> screenUsableSize();

} // namespace ms
