// 原生"选择图片文件"对话框的 Windows 实现（Win32 通用对话框，UTF-8 路径安全）
#include "desktop/FileDialog.h"

#if defined(_WIN32)
#include <windows.h>

#include <commdlg.h>

#include <vector>

namespace ms {
namespace {

std::string wideToUtf8(const wchar_t* w) {
    if (w == nullptr) return std::string();
    const int need = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (need <= 0) return std::string();
    std::string out(static_cast<std::size_t>(need), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), need, nullptr, nullptr);
    if (!out.empty() && out.back() == '\0') out.pop_back();
    return out;
}

// 过滤器字符串需要内嵌 NUL，直接写字面量容易被转义坑到，这里程序化拼出来
std::wstring buildFilter() {
    const wchar_t* pairs[][2] = {
        {L"图片文件", L"*.png;*.jpg;*.jpeg;*.bmp;*.tga;*.gif"},
        {L"所有文件", L"*.*"},
    };
    std::wstring f;
    for (const auto& p : pairs) {
        f += p[0];
        f.push_back(L'\0');
        f += p[1];
        f.push_back(L'\0');
    }
    f.push_back(L'\0');
    return f;
}

} // namespace

std::string pickImageFile() {
    std::vector<wchar_t> buf(4096, L'\0');
    const std::wstring filter = buildFilter();
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = GetActiveWindow();
    ofn.lpstrFilter = filter.c_str();
    ofn.lpstrFile = buf.data();
    ofn.nMaxFile = static_cast<DWORD>(buf.size());
    ofn.lpstrTitle = L"选择图片";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_EXPLORER;
    if (GetOpenFileNameW(&ofn) != TRUE) return std::string(); // 取消
    return wideToUtf8(buf.data());
}

// 屏幕可用区域：工作区（已扣任务栏），单位与窗口一致
std::pair<int, int> screenUsableSize() {
#if defined(_WIN32)
    RECT wa{};
    if (SystemParametersInfoW(SPI_GETWORKAREA, 0, &wa, 0)) {
        return {static_cast<int>(wa.right - wa.left), static_cast<int>(wa.bottom - wa.top)};
    }
#endif
    return {0, 0};
}

} // namespace ms

#endif // _WIN32
