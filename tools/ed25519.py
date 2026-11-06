#!/usr/bin/env python3
# ed25519.py — Ed25519 签名/验签（RFC 8032），纯标准库。
# 用途：cmsdist 客户端自动更新的 manifest 验签——公钥焊死在客户端包里，
# 私钥只留在打包机的 dist-solver/（gitignored），服务器只转发签名，拿不到私钥。
# 明文 HTTP 上给队友推可执行文件的通道必须有这个，否则等于向中间人开放 RCE。
# 性能：纯 Python 大数运算，verify/sign 一次约几十毫秒，只在更新检查时跑。

import hashlib

_p = 2 ** 255 - 19
_l = 2 ** 252 + 27742317777372353535851937790883648493
_d = -121665 * pow(121666, _p - 2, _p) % _p
_I = pow(2, (_p - 1) // 4, _p)


def _sha512(s):
    return hashlib.sha512(s).digest()


def _inv(x):
    return pow(x, _p - 2, _p)


def _xrecover(y):
    xx = (y * y - 1) * _inv(_d * y * y + 1) % _p
    x = pow(xx, (_p + 3) // 8, _p)
    if (x * x - xx) % _p != 0:
        x = x * _I % _p
    if x % 2 != 0:
        x = _p - x
    return x


_By = 4 * _inv(5) % _p
_Bx = _xrecover(_By)
_B = (_Bx, _By, 1, _Bx * _By % _p)          # 基点，扩展坐标 (X, Y, Z, T)
_IDENT = (0, 1, 1, 0)


def _edwards_add(P, Q):
    x1, y1, z1, t1 = P
    x2, y2, z2, t2 = Q
    a = (y1 - x1) * (y2 - x2) % _p
    b = (y1 + x1) * (y2 + x2) % _p
    c = t1 * 2 * _d * t2 % _p
    dd = z1 * 2 * z2 % _p
    e, f, g, h = b - a, dd - c, dd + c, b + a
    return (e * f % _p, g * h % _p, f * g % _p, e * h % _p)


def _scalarmult(P, e):
    Q = _IDENT
    while e > 0:
        if e & 1:
            Q = _edwards_add(Q, P)
        P = _edwards_add(P, P)
        e >>= 1
    return Q


def _on_curve(P):
    x, y, z, t = P
    return (z % _p != 0 and (x * y - z * t) % _p == 0
            and (y * y - x * x - z * z - _d * t * t) % _p == 0)


def _compress(P):
    x, y, z, _t = P
    zi = _inv(z)
    x, y = x * zi % _p, y * zi % _p
    return ((y | ((x & 1) << 255)).to_bytes(32, "little"))


def _decompress(s):
    if len(s) != 32:
        return None
    y = int.from_bytes(s, "little")
    sign = y >> 255
    y &= (1 << 255) - 1
    if y >= _p:
        return None
    x = _xrecover(y)
    if x & 1 != sign:
        x = _p - x
    P = (x, y, 1, x * y % _p)
    return P if _on_curve(P) else None


def _secret_expand(seed):
    if len(seed) != 32:
        raise ValueError("ed25519 私钥必须是 32 字节种子")
    h = _sha512(seed)
    a = int.from_bytes(h[:32], "little")
    a &= (1 << 254) - 8
    a |= 1 << 254
    return a, h[32:]


def generate_keypair():
    """返回 (seed32, pub32)。seed 即私钥（hex 存盘），pub 随客户端分发。"""
    import secrets
    seed = secrets.token_bytes(32)
    a, _prefix = _secret_expand(seed)
    return seed, _compress(_scalarmult(_B, a))


def sign(seed, msg):
    a, prefix = _secret_expand(seed)
    A = _compress(_scalarmult(_B, a))
    r = int.from_bytes(_sha512(prefix + msg), "little") % _l
    R = _compress(_scalarmult(_B, r))
    k = int.from_bytes(_sha512(R + A + msg), "little") % _l
    S = (r + k * a) % _l
    return R + S.to_bytes(32, "little")


def verify(pub32, sig64, msg):
    if len(pub32) != 32 or len(sig64) != 64:
        return False
    A = _decompress(pub32)
    if A is None:
        return False
    Rs = sig64[:32]
    R = _decompress(Rs)
    if R is None:
        return False
    S = int.from_bytes(sig64[32:], "little")
    if S >= _l:
        return False
    k = int.from_bytes(_sha512(Rs + pub32 + msg), "little") % _l
    # 校验 S*B == R + k*A（点等价 = 仿射坐标交叉相等）
    return _point_equal(_scalarmult(_B, S), _edwards_add(R, _scalarmult(A, k)))


def _point_equal(P, Q):
    return ((P[0] * Q[2] - Q[0] * P[2]) % _p == 0
            and (P[1] * Q[2] - Q[1] * P[2]) % _p == 0)


if __name__ == "__main__":
    # RFC 8032 §7.1 TEST 1（空消息）+ TEST 2（1 字节 0x72）
    seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    pub = bytes.fromhex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    assert _compress(_scalarmult(_B, _secret_expand(seed)[0])) == pub, "pubkey mismatch"
    sig = sign(seed, b"")
    assert verify(pub, sig, b""), "TEST 1 verify failed"
    assert not verify(pub, sig, b"x"), "TEST 1 must fail on other msg"
    sig2 = sign(seed, b"\x72")
    assert verify(pub, sig2, b"\x72"), "TEST 2 verify failed"
    # 篡改检测：翻转 sig 一个 bit 必须失败
    bad = bytearray(sig2); bad[0] ^= 1
    assert not verify(pub, bytes(bad), b"\x72")
    print("ed25519 selftest ok")
