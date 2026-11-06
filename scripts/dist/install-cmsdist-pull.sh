#!/bin/bash
# install-cmsdist-pull.sh — 把 cmsdist 每日拉取装成本机 LaunchAgent（每天一次 + 登录时跑）
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
chmod +x "$HERE/cmsdist-pull.sh"
PLIST=~/Library/LaunchAgents/com.cms.cmsdist-pull.plist
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>com.cms.cmsdist-pull</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$HERE/cmsdist-pull.sh</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict><key>Hour</key><integer>9</integer><key>Minute</key><integer>17</integer></dict>
    <key>RunAtLoad</key><true/>
    <key>StandardErrorPath</key><string>/tmp/cmsdist-pull.err</string>
</dict>
</plist>
EOF
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "✅ 已安装 ${PLIST}（每天 09:17 + 登录时拉取到 ~/Backups/cms-dist/）"
