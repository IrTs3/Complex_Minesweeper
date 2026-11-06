// 原生文件选择对话框（Objective-C++，仅 macOS 使用）
#include "desktop/FileDialog.h"

#if defined(__APPLE__)
#import <AppKit/AppKit.h>
#endif

namespace ms {

std::string pickImageFile() {
#if defined(__APPLE__)
    @autoreleasepool {
        NSOpenPanel* panel = [NSOpenPanel openPanel];
        [panel setCanChooseFiles:YES];
        [panel setCanChooseDirectories:NO];
        [panel setAllowsMultipleSelection:NO];
        [panel setMessage:@"选择图片（png / jpg / bmp / tga / gif）"];
        [panel setAllowedFileTypes:@[ @"png", @"jpg", @"jpeg", @"bmp", @"tga", @"gif" ]];
        if ([panel runModal] == NSModalResponseOK) {
            NSURL* url = [[panel URLs] firstObject];
            if (url != nil && [url path] != nil) return std::string([[url path] UTF8String]);
        }
    }
#endif
    return std::string();
}

// 屏幕可用区域：NSScreen.visibleFrame 已是逻辑点，且自动扣掉菜单栏与程序坞
std::pair<int, int> screenUsableSize() {
#if defined(__APPLE__)
    @autoreleasepool {
        [NSApplication sharedApplication]; // 确保 NSScreen 可用
        NSScreen* sc = [NSScreen mainScreen];
        if (sc == nil) sc = [[NSScreen screens] firstObject];
        if (sc != nil) {
            const NSRect vf = [sc visibleFrame];
            return {static_cast<int>(vf.size.width), static_cast<int>(vf.size.height)};
        }
    }
#endif
    return {0, 0};
}

} // namespace ms
