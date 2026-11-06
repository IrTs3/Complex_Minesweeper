#!/bin/bash
# package-dist-client.sh — 一键重打分布式跑分客户端成品包 + 发布自动更新
#
# 用法：bash scripts/dist/package-dist-client.sh [--no-push]
#   默认打包后直接把更新推到服务器（/var/lib/cmsdist/client/），在跑的客户端
#   在下一个任务边界自动更新；--no-push 只打包不发版。
#
# 产物（dist-solver/，gitignored）：
#   cmsdist-client-macOS.dmg        mac 单文件客户端（solver 内嵌，终端跑）
#   cmsdist-client-win64.zip        Windows 免安装包（embeddable Python + bat）
#   cmsdist-client-linux64.tar.gz   Linux(Ubuntu) 免安装包（需系统 python3）
#   ed25519-private.key             签名私钥——在 ~/.cmsdist/（不在本目录，整个
#                                   dist-solver/ 目录可以直接外发）；丢了就只能
#                                   换钥匙重发包
#
# 自动更新链路：
#   本脚本签名 manifest（Ed25519，私钥在本机）→ 上传 manifest + 文件到服务器
#   → 客户端在任务边界拉 manifest、验签（公钥内嵌）→ 逐文件比对自己的 sha256，
#   只换有差异的文件并 execv 重启。ver 只是标记，客户端认 hash 不认 ver。
#
# 防伪更新：重编译产物字节必变（PE 头时间戳、PyInstaller 打包时间戳），纯重跑
# 会造成「啥都没改也全量假更新」。两道闸：
#   1) 源码指纹没变 → 复用 ~/.cmsdist/build-cache/ 的上次产物，不重编；
#   2) 发布前比对线上 manifest 的文件 hash，全一致就跳过发布（ver 不动）；唯一例外是
#      文件没变但 manifest 字段要补（如老清单缺 solver_ver），那只重传 manifest 本身。
#   想强制全量重编：rm -rf ~/.cmsdist/build-cache
#
# 依赖：python3、g++、x86_64-w64-mingw32-g++（brew install mingw-w64）、hdiutil。
# Linux solver 本机编不了（mac 无 linux 交叉工具链），借生产 ECS 编：g++ 没装就
# apt 装（idempotent），源码传上去编完取回缓存；ECS 不可达时跳过 Linux 包照常发版。
set -euo pipefail
# SSH 目标不进仓库（公开快照里不许有真实 IP）：从 ~/.cmsdist/deploy.env 读，
# 两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>。
_ENV="$HOME/.cmsdist/deploy.env"
[ -r "$_ENV" ] || { echo "缺 $_ENV —— 建一份，写两行：CMS_HOST=root@<服务器IP> / CMS_SSH_PORT=<SSH端口>" >&2; exit 1; }
. "$_ENV"
[ -n "${CMS_HOST:-}" ] && [ -n "${CMS_SSH_PORT:-}" ] || { echo "$_ENV 必须含 CMS_HOST 与 CMS_SSH_PORT" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$HERE/dist-solver"
CACHE="$HOME/.cmsdist/build-cache"
PUSH=1
[ "${1:-}" = "--no-push" ] && PUSH=0
PYEMBED_VER=3.13.9
BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

# 求解器指纹：与 CMakeLists 的 SOLVER_VER 同算法（逐文件 sha256 拼接后再 sha256，
# 取前 8 位；src/solver/*.h 按 glob 字典序）。裸 g++ 编译不走 CMake，必须手动传，
# 否则发出去的 solver 全报 dev，分布式结果没法按版本归因。
SOLVER_VER=$({ shasum -a 256 "$HERE/tools/solver.cpp" "$HERE/src/core/Board.cpp" \
        "$HERE/src/core/Board.h" "$HERE"/src/solver/*.h | awk '{print $1}'; } \
    | tr -d '\n' | shasum -a 256 | cut -c1-8)

echo "==> 1/6 签名密钥（首次生成，之后复用）"
# 私钥放 ~/.cmsdist/ 而不是工程 dist-solver/——后者是要整个发人的成品目录，
# 私钥混在里面迟早跟着文件夹一起发出去；这是更新链路的信任根，只留本机
KEYDIR="$HOME/.cmsdist"
mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR" 2>/dev/null || true
if [ ! -f "$KEYDIR/ed25519-private.key" ]; then
    python3 -c "
import sys; sys.path.insert(0, '$HERE/tools')
import ed25519, os
seed, pub = ed25519.generate_keypair()
open('$KEYDIR/ed25519-private.key', 'w').write(seed.hex())
os.chmod('$KEYDIR/ed25519-private.key', 0o600)
open('$BUILD/ed25519-pub.hex', 'w').write(pub.hex())
print('  （新生成密钥对）')
"
else
    python3 -c "
import sys; sys.path.insert(0, '$HERE/tools')
import ed25519
seed = bytes.fromhex(open('$KEYDIR/ed25519-private.key').read().strip())
a, _ = ed25519._secret_expand(seed)
open('$BUILD/ed25519-pub.hex', 'w').write(ed25519._compress(ed25519._scalarmult(ed25519._B, a)).hex())
"
fi
cp "$BUILD/ed25519-pub.hex" "$OUT/ed25519-pub.hex"

echo "==> 2/6 编译 solver + 打包 onefile（源码没变则复用缓存）"
# 指纹 = 参与更新链路的全部输入（客户端脚本、solver 源码、ed25519.py、公钥）。
# solver 头文件必须算进来：归因指纹（SOLVER_VER）含 Board.h + src/solver/*.h，
# 这里漏了它们就会出现「SOLVER_VER 变了却复用旧产物」（2026-11-01 climits 修补踩过）
mkdir -p "$CACHE"
{ shasum -a 256 "$HERE/tools/dist_client.py" "$HERE/tools/ed25519.py" \
        "$HERE/tools/solver.cpp" "$HERE/src/core/Board.cpp" "$HERE/src/core/Board.h" \
        "$HERE"/src/solver/*.h \
        "$BUILD/ed25519-pub.hex" | awk '{print $1}'; \
  # 链接参数也进缓存指纹：只改 -static 这类参数时源码哈希不动，
  # 复用旧产物 = 把「缺 libstdc++-6.dll 起不来」的包再发一次
  printf '%s\n' "LINK:mingw=-static -s | linux=-static-libgcc -static-libstdc++"; } > "$BUILD/fingerprint"
if [ -f "$CACHE/fingerprint" ] && cmp -s "$CACHE/fingerprint" "$BUILD/fingerprint" \
   && [ -x "$CACHE/solver-expert" ] && [ -f "$CACHE/solver-expert.exe" ] \
   && [ -x "$CACHE/dist-client" ]; then
    echo "  源码没变，复用上次构建产物（强制重编：rm -rf ${CACHE}）"
    cp "$CACHE/solver-expert" "$BUILD/solver-expert"
    cp "$CACHE/solver-expert.exe" "$BUILD/solver-expert.exe"
    mkdir -p "$BUILD/dist"
    cp "$CACHE/dist-client" "$BUILD/dist/dist-client"
else
    echo "  编译 solver（mac arm64 + win64，指纹 ${SOLVER_VER}）..."
    g++ -O2 -std=c++17 -I "$HERE/src" '-DSOLVER_VER="'"$SOLVER_VER"'"' \
        "$HERE/tools/solver.cpp" "$HERE/src/core/Board.cpp" -o "$BUILD/solver-expert"
    # ★ 必须 -static 全静态：裸 g++ 出来的 exe 导入 libstdc++-6.dll / libgcc_s_seh-1.dll，
    #   干净 Windows 上双击就是「找不到 libstdc++-6.dll」系统错误（2026-11-01 Win11 实测，
    #   客户端只能干等那局永远跑不完）。只写 -static-libstdc++ 不够——libstdc++ 静态后
    #   仍拖一个 libwinpthread-1.dll，干净机器一样没有。-static 之后只剩 UCRT+KERNEL32，
    #   那是 Win10/11 自带的。
    x86_64-w64-mingw32-g++ -O2 -std=c++17 -I "$HERE/src" '-DSOLVER_VER="'"$SOLVER_VER"'"' \
        -static -s \
        "$HERE/tools/solver.cpp" "$HERE/src/core/Board.cpp" -o "$BUILD/solver-expert.exe"
    # 导入表自检：还留着 mingw 自带 DLL 就中止发版（宁可不发，别发跑不起来的包）
    if command -v x86_64-w64-mingw32-objdump >/dev/null; then
        if x86_64-w64-mingw32-objdump -p "$BUILD/solver-expert.exe" \
                | grep -qE 'DLL Name: (libstdc\+\+-|libgcc_s_|libwinpthread-)'; then
            echo "✗ win solver 仍依赖 mingw 自带 DLL，干净机器上起不来，中止发版" >&2
            exit 1
        fi
        echo "  win solver 导入表自检 OK（只依赖 UCRT + KERNEL32）"
    else
        echo "  ⚠ 没装 x86_64-w64-mingw32-objdump，跳过导入表自检" >&2
    fi
    # 指纹自检：与 CMake 编出来的口径对不上就中止（算法漂移 = 版本归因全错）
    got_ver=$("$BUILD/solver-expert" --version)
    if [ "$got_ver" != "$SOLVER_VER" ]; then
        echo "✗ solver 指纹自检失败（二进制 $got_ver ≠ 计算 ${SOLVER_VER}），中止发版" >&2
        exit 1
    fi

    echo "  准备 PyInstaller（临时 venv，用完即删）..."
    python3 -m venv "$BUILD/venv"
    "$BUILD/venv/bin/pip" install -q pyinstaller

    echo "  打包 mac 单文件（solver + 公钥内嵌）..."
    "$BUILD/venv/bin/pyinstaller" --onefile --name dist-client \
        --add-binary "$BUILD/solver-expert:." \
        --add-data "$BUILD/ed25519-pub.hex:." "$HERE/tools/dist_client.py" \
        --distpath "$BUILD/dist" --workpath "$BUILD/work" --specpath "$BUILD/work" 2>&1 | tail -1
    # PyInstaller 产出的 ad-hoc 签名偶发无效——arm64 macOS 上 taskgated 启动即
    # SIGKILL（2026-11-01 实测，崩溃报告 CODESIGNING/Taskgated Invalid Signature），
    # 而 codesign -f -s - 重签即愈。发版前无条件重签兜底。
    codesign -f -s - "$BUILD/dist/dist-client" 2>/dev/null || true

    cp "$BUILD/solver-expert" "$CACHE/solver-expert"
    cp "$BUILD/solver-expert.exe" "$CACHE/solver-expert.exe"
    cp "$BUILD/dist/dist-client" "$CACHE/dist-client"
    cp "$BUILD/fingerprint" "$CACHE/fingerprint"
fi

# 自检对「缓存复用」路径同样生效——缓存里也可能存着上次自检漏网时攒下的坏产物。
if ! "$BUILD/dist/dist-client" --help > /dev/null 2>&1; then
    echo "✗ onefile 自检失败（--help 无法运行，疑似签名/打包损坏），中止发版" >&2
    exit 1
fi
echo "  onefile 自检 OK"

echo "==> 3/6 制作 macOS dmg"
mkdir -p "$BUILD/dmg"
cp "$BUILD/dist/dist-client" "$BUILD/dmg/"
# 散装副本必须 rm 后再拷：cp 对已存在目标是原地覆写（同 inode），若此刻有
# 客户端窗口正从这份文件跑，vnode 字节被换 → macOS 永久判死该 inode，之后
# 谁 exec 谁 137（2026-11-01「每次自动更新必出问题」根因，见 dist_client 防呆）
rm -f "$OUT/dist-client"
cp "$BUILD/dist/dist-client" "$OUT/dist-client"   # 散装副本同步更新（本机直接跑用）
cp "$OUT/使用说明.txt" "$BUILD/dmg/"
rm -f "$OUT/cmsdist-client-macOS.dmg"
hdiutil create -volname "cmsdist 客户端" -srcfolder "$BUILD/dmg" -ov -format UDZO \
    "$OUT/cmsdist-client-macOS.dmg" > /dev/null

echo "==> 4/6 制作 Windows 免安装 zip"
mkdir -p "$BUILD/win/cmsdist-client"
# embeddable Python 是全脚本唯一的对外下载，而 curl 原来没带超时：链路一抽风
# （和 github.com:443 同款间歇不通）就挂在 4/6 永远等下去（2026-11-04 实测）。
# 缓存到 ~/.cmsdist/download-cache：命中不联网；真要下载给足超时与重试，
# 失败把「手动放一份到哪」说清楚再退，不许静默挂死。
PYEMBED_ZIP="$HOME/.cmsdist/download-cache/python-$PYEMBED_VER-embed-amd64.zip"
mkdir -p "$(dirname "$PYEMBED_ZIP")"
if [ ! -s "$PYEMBED_ZIP" ] || ! unzip -tq "$PYEMBED_ZIP" > /dev/null 2>&1; then
  echo "  ⬇ 下载 embeddable Python ${PYEMBED_VER}（缓存到 ${PYEMBED_ZIP}，之后不再联网）…"
  if ! curl -fsSL --connect-timeout 15 --max-time 900 --retry 2 --retry-connrefused \
       -o "$PYEMBED_ZIP.part" \
       "https://www.python.org/ftp/python/$PYEMBED_VER/python-$PYEMBED_VER-embed-amd64.zip"; then
    rm -f "$PYEMBED_ZIP.part"
    echo "  ✗ embeddable Python 下载失败：python.org 这会儿连不通（间歇被墙，和 github 一样）。" >&2
    echo "    用别的网络下载这份 zip 放到 $PYEMBED_ZIP 再重跑即可，不必本机联网：" >&2
    echo "    https://www.python.org/ftp/python/$PYEMBED_VER/python-$PYEMBED_VER-embed-amd64.zip" >&2
    exit 1
  fi
  mv "$PYEMBED_ZIP.part" "$PYEMBED_ZIP"
else
  echo "  复用缓存的 embeddable Python ${PYEMBED_VER}"
fi
cp "$PYEMBED_ZIP" "$BUILD/pyembed.zip"
unzip -q "$BUILD/pyembed.zip" -d "$BUILD/win/cmsdist-client"
cp "$HERE/tools/dist_client.py" "$HERE/tools/ed25519.py" "$BUILD/win/cmsdist-client/"
cp "$BUILD/solver-expert.exe" "$BUILD/ed25519-pub.hex" "$BUILD/win/cmsdist-client/"
cp "$OUT/使用说明.txt" "$BUILD/win/cmsdist-client/"
# bat 里要输出中文提示，而中文 Windows 的 cmd 默认是 GBK 编码——
# UTF-8 存盘的 bat 中文必乱码，所以这里写 UTF-8 再 iconv 转成 GBK 落盘。
# 注意布局：embeddable Python 解压成平级（python.exe 就在 cmsdist-client
# 根目录，没有 python\ 子目录），bat 必须按平级找——写成 python\python.exe
# 会必报「系统找不到指定的路径」（2026-10-31 Win10 实测踩过）。自检兜底。
printf '@echo off\r\ncd /d "%%~dp0"\r\nif not exist "python.exe" (\r\n    echo 没找到 python.exe：解压不完整，请把整个 zip 重新完整解压后再运行。\r\n    pause\r\n    exit /b 1\r\n)\r\nif not exist "solver-expert.exe" (\r\n    echo 没找到 solver-expert.exe：解压不完整，请把整个 zip 重新完整解压后再运行。\r\n    pause\r\n    exit /b 1\r\n)\r\npython.exe dist_client.py\r\npause\r\n' \
    | iconv -f UTF-8 -t GBK > "$BUILD/win/cmsdist-client/开始跑分.bat"
printf '@echo off\r\ncd /d "%%~dp0"\r\npython.exe dist_client.py --detach\r\npause\r\n' \
    | iconv -f UTF-8 -t GBK > "$BUILD/win/cmsdist-client/后台跑分.bat"
printf '@echo off\r\ncd /d "%%~dp0"\r\npython.exe dist_client.py --stop\r\npause\r\n' \
    | iconv -f UTF-8 -t GBK > "$BUILD/win/cmsdist-client/停止跑分.bat"
rm -f "$OUT/cmsdist-client-win64.zip"
# 不用系统 zip：mac 的 Info-ZIP 按 UTF-8 存文件名，却不置 UTF-8 标记（通用位 bit 11），
# Windows 资源管理器只能按本地代码页猜——中文 Windows 上「使用说明.txt」解出来变成
# 「浣跨敤璇存槑.txt」、「停止跑分.bat」变成「鍋滄…㈣窇鍒….bat」（2026-11-01 Win11 实测）。
# Python 的 zipfile 对非 ASCII 名字一定置 bit 11，解压端就能认。bat 里只调 python.exe
# 这些 ASCII 名字，所以此前那串乱码只影响肉眼辨认、不影响运行。
python3 - "$BUILD/win" "$OUT/cmsdist-client-win64.zip" <<'EOF'
import os, sys, zipfile
src, dst = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(os.path.join(src, "cmsdist-client")):
        dirs.sort()
        rel = os.path.relpath(root, src)
        if rel != ".":
            z.write(root, rel + "/")
        for f in sorted(files):
            z.write(os.path.join(root, f), os.path.relpath(os.path.join(root, f), src))
EOF

echo "==> 5/6 Linux 免安装包 tar.gz（solver 借 ECS 编译，缓存复用）"
LINUX_OK=0
LINUX_SOLVER="$CACHE/solver-expert-linux"
LINUX_WANT="$SOLVER_VER +static-libgcc +static-libstdc++"
if [ -f "$LINUX_SOLVER" ] \
   && printf '%s' "$LINUX_WANT" | cmp -s - "$CACHE/solver-expert-linux.ver" 2>/dev/null; then
    LINUX_OK=1
    echo "  复用缓存的 linux solver（指纹一致）"
else
    echo "  在 ECS 上编译 linux solver（g++ 没装会顺手 apt 装）…"
    # 按仓库相对路径整棵 tar 过去：solver.cpp 里是 "solver/…"/"core/…" 带目录的
    # include，拍平上传会找不到头（Board.h 还依赖 Cell/Rng/ComplexMath/Difficulty）
    LINUX_SRCS="tools/solver.cpp src/core/Board.cpp src/core/Board.h src/core/Cell.h \
        src/core/Rng.h src/core/ComplexMath.h src/core/Difficulty.h src/solver/SolverEngine.h"
    if ssh -p ${CMS_SSH_PORT} ${CMS_HOST} \
        "command -v g++ >/dev/null || apt-get install -y g++ >/dev/null; rm -rf /tmp/cmsdist-build && mkdir -p /tmp/cmsdist-build" \
        && tar -C "$HERE" -czf "$BUILD/linux-src.tgz" $LINUX_SRCS \
        && cat "$BUILD/linux-src.tgz" | ssh -p ${CMS_SSH_PORT} ${CMS_HOST} "tar -xzf - -C /tmp/cmsdist-build" \
        && ssh -p ${CMS_SSH_PORT} ${CMS_HOST} \
        "g++ -O2 -std=c++17 -I /tmp/cmsdist-build/src '-DSOLVER_VER=\"$SOLVER_VER\"' \
            -static-libgcc -static-libstdc++ \
            /tmp/cmsdist-build/tools/solver.cpp /tmp/cmsdist-build/src/core/Board.cpp \
            -o /tmp/cmsdist-build/solver-expert && /tmp/cmsdist-build/solver-expert --version" \
        > "$BUILD/linux-ver" \
        && [ "$(cat "$BUILD/linux-ver")" = "$SOLVER_VER" ]; then
        scp -P ${CMS_SSH_PORT} ${CMS_HOST}:/tmp/cmsdist-build/solver-expert "$LINUX_SOLVER"
        # .ver 里带上链接参数：只改参数时源码指纹不变，光比指纹会复用旧产物
        printf '%s' "$SOLVER_VER +static-libgcc +static-libstdc++" > "$CACHE/solver-expert-linux.ver"
        LINUX_OK=1
    else
        echo "  ⚠ ECS 编译失败/不可达，跳过 Linux 包（mac/win 照常发版）"
    fi
fi
if [ "$LINUX_OK" = 1 ]; then
    # manifest 段按 $BUILD/solver-expert-linux 取 hash，缓存/新编都要先拷进来
    cp "$LINUX_SOLVER" "$BUILD/solver-expert-linux"
    mkdir -p "$BUILD/linux/cmsdist-client"
    cp "$HERE/tools/dist_client.py" "$HERE/tools/ed25519.py" \
       "$BUILD/ed25519-pub.hex" "$OUT/使用说明.txt" "$BUILD/linux/cmsdist-client/"
    cp "$LINUX_SOLVER" "$BUILD/linux/cmsdist-client/solver-expert"
    cat > "$BUILD/linux/cmsdist-client/启动跑分.sh" <<'EOS'
#!/bin/bash
cd "$(dirname "$0")" || exit 1
if [ ! -f solver-expert ] || [ ! -f dist_client.py ]; then
    echo "文件不齐：请把整个 cmsdist-client 文件夹完整解压后再运行（别单独把脚本拖出来）。"
    read -r -p "按回车退出…" _
    exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
    echo "没找到 python3：先安装（Ubuntu：sudo apt install python3），再重新运行。"
    read -r -p "按回车退出…" _
    exit 1
fi
chmod +x solver-expert 2>/dev/null
exec python3 dist_client.py
EOS
    cat > "$BUILD/linux/cmsdist-client/后台跑分.sh" <<'EOS'
#!/bin/bash
cd "$(dirname "$0")" || exit 1
exec python3 dist_client.py --detach
EOS
    cat > "$BUILD/linux/cmsdist-client/停止跑分.sh" <<'EOS'
#!/bin/bash
cd "$(dirname "$0")" || exit 1
python3 dist_client.py --stop
read -r -p "按回车退出…" _
EOS
    chmod +x "$BUILD/linux/cmsdist-client/solver-expert" \
             "$BUILD/linux/cmsdist-client/启动跑分.sh" \
             "$BUILD/linux/cmsdist-client/后台跑分.sh" \
             "$BUILD/linux/cmsdist-client/停止跑分.sh"
    rm -f "$OUT/cmsdist-client-linux64.tar.gz"
    # --no-xattrs：别让 bsdtar 把 xattr 打进 pax 头。实测（18:38 那份包）光加
    # COPYFILE_DISABLE=1 挡不住——9 个成员仍带 com.apple.provenance /
    # com.apple.lastuseddate，收件端在 macOS 解包会原样落回文件上，这种文件夹再被
    # 拷进云盘/WebDAV 这类非 Apple 卷时，Finder 会给每个文件补一个 ._xxx 侧车，
    # Linux 里看就是一堆 163 字节的乱码文件。COPYFILE_DISABLE 管的是 AppleDouble
    # 分叉，两个都留着才干净。
    COPYFILE_DISABLE=1 tar --no-xattrs -czf "$OUT/cmsdist-client-linux64.tar.gz" \
        -C "$BUILD/linux" cmsdist-client
fi

echo "==> 6/6 签名 manifest"
# 上传的：mac onefile 本体、dist_client.py、solver-expert.exe（win 更新用）、
# solver-expert-linux（linux 更新用，仅 LINUX_OK）、manifest
cd "$HERE"
LINUX_OK=$LINUX_OK SOLVER_VER="$SOLVER_VER" python3 - "$BUILD" <<'EOF'
import sys, json, time, base64, hashlib, os
build = sys.argv[1]
here = os.getcwd()
sys.path.insert(0, os.path.join(here, "tools"))
import ed25519

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()

files = {
    "macos-bin":    {"sha256": sha(build + "/dist/dist-client"),
                     "file": "/client/file/dist-client-macos"},
    "win64-py":     {"sha256": sha(here + "/tools/dist_client.py"),
                     "file": "/client/file/dist_client.py"},
    "solver-win64": {"sha256": sha(build + "/solver-expert.exe"),
                     "file": "/client/file/solver-expert.exe"},
}
if os.environ.get("LINUX_OK") == "1":
    # linux 更新链路：dist_client.py 与 win 共用服务器上同一份（内容相同），
    # 只有 solver 是 linux 专属二进制
    files["linux64-py"] = {"sha256": sha(here + "/tools/dist_client.py"),
                           "file": "/client/file/dist_client.py"}
    files["solver-linux64"] = {"sha256": sha(build + "/solver-expert-linux"),
                               "file": "/client/file/solver-expert-linux"}
man = {"ver": int(time.time()), "files": files,
       # 这份二进制是哪个源码指纹编出来的——ctlui「求解器版本 · 已发布」读它。
       # 故意放在签名 payload 之外：老客户端只签 ver+files 两段，把它签进去
       # 会让在跑的旧包当场验签失败、从此不再更新。
       "solver_ver": os.environ["SOLVER_VER"]}
payload = json.dumps({"ver": man["ver"], "files": files},
                     sort_keys=True, separators=(",", ":")).encode()
seed = bytes.fromhex(open(os.path.expanduser("~/.cmsdist/ed25519-private.key")).read().strip())
man["sig"] = base64.b64encode(ed25519.sign(seed, payload)).decode()
assert ed25519.verify(ed25519._compress(ed25519._scalarmult(ed25519._B, ed25519._secret_expand(seed)[0])),
                      base64.b64decode(man["sig"]), payload), "自验签失败"
out = os.path.join(build, "manifest.json")
open(out, "w").write(json.dumps(man, ensure_ascii=False))
print("  manifest: ver=%d, solver=%s, macos=%s…" %
      (man["ver"], man["solver_ver"], files["macos-bin"]["sha256"][:12]))
EOF
if [ "$PUSH" = 1 ]; then
    SSH="ssh ${CMS_HOST} -p ${CMS_SSH_PORT}"
    $SSH "mkdir -p /var/lib/cmsdist/client && chown cmsgate:cmsgate /var/lib/cmsdist/client"
    # 发布闸：客户端认 hash 不认 ver，文件跟线上一致就什么都不推（推了也全量无感，
    # 纯粹白 bump ver）。三档：0=完全一致跳过 / 1=文件没变但 manifest 字段要补（只推
    # manifest，二进制一字节不重传；老清单缺 solver_ver 就走这档）/ 2=有文件变了，全量发
    SAME=2
    if $SSH "cat /var/lib/cmsdist/client/manifest.json 2>/dev/null" > "$BUILD/remote-manifest.json" 2>/dev/null; then
        python3 -c '
import json, sys
new = json.load(open(sys.argv[1]))
try:
    old = json.load(open(sys.argv[2]))
except Exception:
    sys.exit(2)
nf, of = new["files"], old.get("files", {})
if any(nf[k]["sha256"] != of.get(k, {}).get("sha256") for k in nf):
    sys.exit(2)
sys.exit(0 if old.get("solver_ver") == new.get("solver_ver") else 1)
' "$BUILD/manifest.json" "$BUILD/remote-manifest.json" && SAME=0 || SAME=$?
    fi
    if [ "$SAME" = 0 ]; then
        echo "  内容与线上一致，跳过发布（ver 不动，客户端完全无感）"
    else
        if [ "$SAME" != 1 ]; then
            scp -P ${CMS_SSH_PORT} "$BUILD/dist/dist-client" ${CMS_HOST}:/var/lib/cmsdist/client/dist-client-macos
            scp -P ${CMS_SSH_PORT} "$HERE/tools/dist_client.py" ${CMS_HOST}:/var/lib/cmsdist/client/dist_client.py
            scp -P ${CMS_SSH_PORT} "$BUILD/solver-expert.exe" ${CMS_HOST}:/var/lib/cmsdist/client/solver-expert.exe
            if [ "$LINUX_OK" = 1 ]; then
                scp -P ${CMS_SSH_PORT} "$CACHE/solver-expert-linux" \
                    ${CMS_HOST}:/var/lib/cmsdist/client/solver-expert-linux
            fi
        else
            echo "  文件与线上一致，只补推 manifest（新增字段，客户端不会重下）"
        fi
        scp -P ${CMS_SSH_PORT} "$BUILD/manifest.json" ${CMS_HOST}:/var/lib/cmsdist/client/manifest.json
        $SSH "chown cmsgate:cmsgate /var/lib/cmsdist/client/* && curl -fsS -m 5 http://127.0.0.1:7120/client/manifest > /dev/null && echo '  ✅ 已发布，客户端将在任务边界自动更新'"
    fi
else
    echo "  （--no-push：打包完成，未发布。手动发布：scp manifest.json 等文件到 /var/lib/cmsdist/client/）"
fi

echo
echo "✅ 成品包已更新："
ls -la "$OUT" | grep -E 'cmsdist-client|^d' | head -8
