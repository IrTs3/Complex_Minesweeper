#!/usr/bin/env python3
"""开发服务器：禁用缓存，保证刷新即拿到最新 HTML/CSS/JS。

默认**不加闸门**，供日常开发与 web/test/cdp-interaction.mjs（35 项断言）使用
——那些测试导航到 / 就期望立刻拿到游戏，加闸门会让它们全部失败。

带 `--gate` 时，本脚本会**模拟线上 nginx 的 auth_request 行为**（不是 nginx 本身）：

    /gate/<GATE_TOKEN>/、/learn/**、两个字体 → 公开
    / 与 /game/（game 模式）                   → 302 /game（与线上片段一致）
    /game                                      → 游戏页（受闸门保护）
    其余路径未登录                            → 404（当作不存在，与线上 nginx 的
                                                =404 /__nf 一致；不吐密码页也不吐 401，
                                                两者都等于承认这里有东西）
    POST /__login、/__logout                  → 转发给本地 authd

★ 登录入口和线上一条一样是**随机路径**：`/gate/` 本身（以及 `/gate/别的`）
  在未登录时同样 404，只有带 token 的前缀可达 —— 这就是「秘密网址」在
  本机的等价物，token 用环境变量给（默认值只在 loopback 上凑数，别当真）。

用法：
    python3 serve.py                                   # 8080，无闸门
    python3 serve.py --gate                            # 8080，带闸门（需先起 authd）
    GATE_TOKEN=a7f3c91b2d4e python3 serve.py --gate    # 指定入口 token
    python3 serve.py --gate --port 8081 --authd-port 8090

★ 带 `--gate` 且绑到**非回环**地址时，必须显式给 `GATE_TOKEN`：默认值
  `dev0gatepath` 是写在源码里的，对外用等于把登录页挂在一个谁都能猜到的路径上，
  「秘密入口」这一层直接归零。回环上仍允许用默认值（只有本机碰得到，测试也依赖它）。
"""
import argparse
import http.client
import http.server
import os
import posixpath
import re
import urllib.parse

# 与 nginx 配置保持一致：这些路径无需登录。
# 注意这里**没有** bg.webp / bg.jpg —— 那张图未授权商用，线上已收进闸门
# （匿名 404），登录页自己改用 CSS 渐变；留两个字体是因为它们是公开内容，
# 匿名也要能拿到，否则登录页标题字体就崩了。
PUBLIC_EXACT = {
    "/assets/ibmplex-ascii.woff2",
    "/assets/IBMPlexSerif-Regular.ttf",
}

#: 秘密登录入口的 token（模拟线上服务器片段里那份 `# gate-token: …`）。
#: 线上真相只在服务器，这里给本地开发与 cdp 测试用；测试脚本用 env 对齐。
GATE_TOKEN = os.environ.get("GATE_TOKEN", "dev0gatepath")


class Handler(http.server.SimpleHTTPRequestHandler):
    gate = False
    authd_addr = ("127.0.0.1", 8090)

    # ---- 基础设施 ----
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", extra=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _path(self):
        # 鉴权判断必须看**最终要给的路径**，不是 URL 里写的那一串：
        # `/learn/..%2findex.html` 在原始形态下以 /learn/ 开头（看着公开），
        # 但 SimpleHTTPRequestHandler 之后会 unquote+normpath 成 /index.html。
        # 先解码再规范化，才和它实际会返回的文件对齐。
        raw = urllib.parse.urlsplit(self.path).path
        return posixpath.normpath(urllib.parse.unquote(raw))

    def translate_path(self, path):
        # nginx 那边是 `location ^~ /gate/<TOKEN>/ { alias .../gate/; }`，磁盘上并没有
        # 那层随机目录。本机没有 alias，所以把 token 那一段换成普通的 gate 段 ——
        # 等价于 nginx 的 alias 剥前缀。踩过两次：① 不剥 → 秘密入口在开发机上必然 404；
        # ② 只剥到 `/gate/<TOKEN>` 而不补回 `/gate` → 资源落到站点根，
        #    /gate/<TOKEN>/ 会返回**游戏**的 index.html（本地把泄漏测成了绿灯）。
        # 用 _path() 的规范形态做前缀判断，`%2f` 编码的 `..` 就没法绕过剥前缀这一步。
        canon = self._path()
        # /game 是线上两种模式共用的游戏 URL（游戏页文件仍叫 index.html）。
        # 本地没有 nginx 的 try_files，所以在这里等价映射。
        if canon == "/game":
            canon = "/index.html"
        prefix = f"/gate/{GATE_TOKEN}"
        if canon == prefix or canon.startswith(prefix + "/"):
            canon = "/gate" + canon[len(prefix):]
        # 父类的实现还会 unquote 一次。传进去的已经是解码后的路径，再解一次就是
        # 双重解码（`%252e%252e` 会变成 `..`）。把 % 先转义成 %25，父类解完正好
        # 还原成 canon。末尾斜杠要保留，否则目录请求会被父类重定向到自身。
        if urllib.parse.urlsplit(self.path).path.rstrip().endswith("/") and not canon.endswith("/"):
            canon += "/"
        return super().translate_path(canon.replace("%", "%25"))

    @staticmethod
    def _is_public(path):
        # /learn/** 是公开的 C++ 学习站（与线上 nginx 的 ^~ /learn/ 一致），闸门模式下也无需登录。
        # 登录入口只认带 token 的那一条前缀（线上是片段里同名的 ^~ location）：
        # /gate/ 与 /gate/<别的> 在这里都必须受保护，否则本地就测不出「秘密路径」这一层。
        prefix = f"/gate/{GATE_TOKEN}"
        return (path == prefix or path.startswith(prefix + "/")
                or path == "/learn" or path.startswith("/learn/")
                or path in PUBLIC_EXACT)

    def list_directory(self, path):
        # 目录列表会把 dist/、assets/ 等文件名整体枚举给访问者（线上 nginx 对目录
        # 也不给列表）；站点所有路由都落在具体文件上，目录请求一律 404。
        self.send_error(404)
        return None

    def _auth_ok(self):
        cookie = self.headers.get("Cookie")
        try:
            conn = http.client.HTTPConnection(*self.authd_addr, timeout=5)
            conn.request("GET", "/auth", headers={"Cookie": cookie} if cookie else {})
            resp = conn.getresponse()
            resp.read()
            conn.close()
            return resp.status == 204
        except OSError:
            # 鉴权服务不可达：按「未通过」处理，与线上 nginx 的 fail-closed 一致
            return False

    # ---- GET / HEAD ----
    def do_GET(self):
        path = self._path()
        # 线上 game 模式下 / 会 302 到 /game（重定向不要求登录，游戏本身才要）。
        # 本地只在 --gate 下模拟这套路由；无闸门模式保持老行为，老测试不受影响。
        if self.gate and path in ("/", "/game/"):
            return self._send(302, extra=[("Location", "/game")])
        if self.gate and not self._is_public(path):
            if not self._auth_ok():
                return self._send(404, b"404 Not Found\n")
        return super().do_GET()

    def do_HEAD(self):
        if self.gate and not self._is_public(self._path()):
            if not self._auth_ok():
                return self._send(404)
        return super().do_HEAD()

    # ---- POST：只用于转发鉴权端点 ----
    def do_POST(self):
        path = self._path()
        target = {"/__login": "/login", "/__logout": "/logout"}.get(path)
        if not target:
            return self._send(405, b"405 Method Not Allowed\n")

        try:
            n = int(self.headers.get("Content-Length") or "0")
        except ValueError:
            return self._send(400, b"bad content-length\n")
        body = self.rfile.read(n) if n else b""

        fwd = {}
        for h in ("X-CMSGATE", "Content-Type", "User-Agent", "Cookie"):
            v = self.headers.get(h)
            if v:
                fwd[h] = v
        fwd.setdefault("X-Real-IP", "127.0.0.1")
        try:
            conn = http.client.HTTPConnection(*self.authd_addr, timeout=10)
            conn.request("POST", target, body=body, headers=fwd)
            resp = conn.getresponse()
            payload = resp.read()
            status = resp.status
            set_cookie = resp.getheader("Set-Cookie")
            location = resp.getheader("Location")
            # ★ 透传上游的 Content-Type 与 Retry-After，别在这里写死 application/json：
            #   无 JS 的登录失败走的是 authd 自渲染的 **text/html** 内联提示页，
            #   本机代理把它标成 JSON 的话浏览器不会当页面渲染（显示成裸文本/提示下载），
            #   于是"本地复现不了线上行为"，cdp 用例还会红得莫名其妙。
            #   nginx 是原样转发的，所以只有这一条链需要补。
            ctype = resp.getheader("Content-Type") or "application/json"
            retry_after = resp.getheader("Retry-After")
            conn.close()
        except OSError as e:
            return self._send(502, f"鉴权服务不可达：{e}\n".encode("utf-8"))

        extra = []
        if set_cookie:
            extra.append(("Set-Cookie", set_cookie))
        if location:
            extra.append(("Location", location))
        if retry_after:
            extra.append(("Retry-After", retry_after))
        if 300 <= status < 400:
            self.send_response(status)
            for k, v in extra:
                self.send_header(k, v)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self._send(status, payload, ctype, extra)

    def log_message(self, fmt, *args):
        # 闸门模式下把拒绝也打出来，便于观察
        if self.gate and args and str(args[1]).startswith("4"):
            return super().log_message(fmt, *args)
        if not self.gate:
            return  # 默认静默，保持原有安静体验
        return super().log_message(fmt, *args)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="网页版开发服务器")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1",
                    help="绑定地址（默认 127.0.0.1，只本机可访问；"
                         "要对外/局域网自测才显式传 0.0.0.0）")
    ap.add_argument("--gate", action="store_true",
                    help="模拟线上 nginx 的 auth_request（需要本地 authd 在运行）")
    ap.add_argument("--authd-port", type=int, default=8090)
    a = ap.parse_args()

    # 闸门模式 + 对外绑定 + 没给 token = 把登录页挂在源码里写死的可猜路径上。
    # 这条守卫是"秘密入口"这一层在本机的下限：回环随你便，往外绑就必须自己给一个。
    loopback = a.host in ("127.0.0.1", "localhost", "::1")
    tok = os.environ.get("GATE_TOKEN", "")
    if a.gate and not loopback and not tok:
        raise SystemExit(
            f"★ --gate 绑到 {a.host} 时必须显式给入口 token：\n"
            f"    GATE_TOKEN=<12~32 位小写字母或数字> python3 serve.py --host {a.host} --gate\n"
            "  默认的 dev0gatepath 就写在源码里，对外用等于登录页人人可打开，"
            "「隐藏入口」这层直接归零。")
    if a.gate and not loopback and tok and not re.fullmatch(r"[a-z0-9]{12,32}", tok):
        # 与 gate_manager.py / deploy-web.sh 的 nginx 侧正则同口径。
        raise SystemExit(
            f"★ GATE_TOKEN 不合格（长度 {len(tok)}）：入口 token 必须是 12~32 位小写字母或数字，\n"
            f"    例如：GATE_TOKEN=$(openssl rand -hex 12) python3 serve.py --host {a.host} --gate\n"
            "  弱 token 挂在对外地址上等于把登录入口暴露给可枚举路径。")

    Handler.gate = a.gate
    Handler.authd_addr = ("127.0.0.1", a.authd_port)

    shown = "127.0.0.1" if a.host in ("", "0.0.0.0") else a.host
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    with http.server.ThreadingHTTPServer((a.host, a.port), Handler) as httpd:
        if a.gate:
            print(f"闸门模式：http://{shown}:{a.port}/   "
                  f"（鉴权服务 127.0.0.1:{a.authd_port}，未运行时一律按未登录处理）")
            print(f"  登录入口（秘密路径，与线上同一形状）："
                  f"http://{shown}:{a.port}/gate/{GATE_TOKEN}/"
                  f"   ← 换它：GATE_TOKEN=xxx python3 serve.py --gate")
        else:
            print(f"开发模式（无闸门）：http://{shown}:{a.port}/")
        if a.host in ("", "0.0.0.0"):
            print(f"⚠️ 已绑定所有网卡（0.0.0.0）：同网段任何人都能访问这个开发服务器。")
        httpd.serve_forever()
