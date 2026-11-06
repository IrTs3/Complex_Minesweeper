#!/bin/bash
# install-ctlui.sh — 把 ctlui 装成终端命令：任意目录输入 `ctlui` 即起管理界面
# （软链到仓库里的 tools/ctl_ui.py，升级仓库即升级命令本身）
set -euo pipefail
HERE=$(cd "$(dirname "$0")/../.." && pwd)
chmod +x "$HERE/tools/ctl_ui.py"
# 优先 /opt/homebrew/bin（Apple Silicon 的 brew，用户可写且在 PATH），
# 其次 /usr/local/bin，再退到 ~/bin（可能要自己加 PATH）
for DIR in /opt/homebrew/bin /usr/local/bin "$HOME/bin"; do
    if [ -d "$DIR" ] && [ -w "$DIR" ]; then
        BIN="$DIR/ctlui"
        break
    fi
done
if [ -z "${BIN:-}" ]; then
    echo "没找到可写的安装目录（/opt/homebrew/bin、/usr/local/bin、~/bin 都不行）"
    exit 1
fi
ln -sfn "$HERE/tools/ctl_ui.py" "$BIN"
echo "✅ 已安装 $BIN → $HERE/tools/ctl_ui.py"
echo "   以后任意目录输入：ctlui"
