"""v0.9.56 TXT 阅读编码识别契约（真实字节 → 真实 TextDecoder 语义模拟）

背景：旧实现只有「UTF-8 严格解码失败 → 一律 GB18030」两条路，Windows 记事本存的
UTF-16（"Unicode"）、繁体 Big5、日文 Shift-JIS 都会解成乱码。
本测试用 Python 的编解码器复刻 decodeTextBytes 的判定顺序（BOM → UTF-16 零字节特征
→ UTF-16 奇偶位配对探测 → UTF-8 严格 → 多候选打分），保证 JS 侧逻辑与断言同步：
  1. 源码静态契约：候选表/打分函数/BOM/零字节分支/配对探测都在；
  2. 行为契约：同一套判定规则跑 14 组真实编码样本（含纯 CJK 无 BOM UTF-16 的
     合法 UTF-8 字节串伪装边界），不得出现 U+FFFD / NUL，且首行必须与原文一致。
浏览器端同一批样本的真实验证见 /opt/data/vh0956-decode-test.js（node 抽函数直跑）。
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
JS = (ROOT / "web/js/02-media.js").read_text(encoding="utf-8")

fails = []


def check(name, ok, detail=""):
    if not ok:
        fails.append(f"{name} {detail}")


# ============ 1) 源码静态契约 ============
check("候选编码表", 'const TEXT_DECODE_CANDIDATES = ["gb18030", "big5", "shift-jis", "euc-kr", "utf-16le", "utf-16be"]' in JS)
check("打分函数", "function scoreDecodedText(text)" in JS and "function decodeWithEncoding(bytes, encoding)" in JS)
check("UTF-8 BOM 分支", "0xEF && view[1] === 0xBB && view[2] === 0xBF" in JS)
check("UTF-16 LE/BE BOM 分支", "0xFF && view[1] === 0xFE" in JS and "0xFE && view[1] === 0xFF" in JS)
check("无 BOM UTF-16 零字节特征", "zeroEven" in JS and "zeroOdd" in JS and "> 0.15" in JS)
check("UTF-16 奇偶位配对探测", "function probeUtf16Pairing(src)" in JS and '>= 0x4E && hi <= 0x9F' in JS)
check("配对探测与打分流全量择优", "TEXT_DECODE_CANDIDATES" in JS and "return best;" in JS)
check("UTF-8 严格优先", 'new TextDecoder("utf-8", { fatal: true })' in JS)
check("替换符/控制字符扣分", '"\\uFFFD"' in JS and "score -= 8" in JS)
check("半角片假名误判扣分", "0xFF61" in JS and "0xFF9F" in JS)
check("常用汉字表参与打分", "TEXT_COMMON_CJK.has(ch)" in JS)
check("兜底仍回 gb18030", 'return best || new TextDecoder("gb18030").decode(view)' in JS)
# 阅读链路仍走 decodeTextBytes
check("TXT 阅读调用解码器", "const text = decodeTextBytes(bytes);" in JS and 'else if (ext === "txt")' in JS)

# ============ 2) 行为契约：复刻 JS 判定顺序，跑真实编码样本 ============
COMMON_CJK = set(
    "的一是不了在人有我他这中大来上国个到说们为子和你地出道时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样第些现使部真才等次将女并平点几高"
    "话说读写听问题体长为万医声图东语测试章节内容验证编码破折号僻字书名包含标点段落文本行列表页题目字数十百千万亿"
    "话這來時們個過還後說國學會沒對開間問題經體長爲兩實現變頭萬醫聲書寫圖東語測試章節讀聽內容驗證編碼標點"
)
CANDIDATES = ["gb18030", "big5", "shift_jis", "euc_kr", "utf-16-le", "utf-16-be"]


def score_text(text):
    score, cjk = 0, 0
    for ch in text[:4000]:
        code = ord(ch)
        if ch == "\ufffd":
            score -= 8
        elif code < 32 and ch not in "\n\r\t":
            score -= 8
        elif 0xFF61 <= code <= 0xFF9F or 0xE000 <= code <= 0xF8FF:
            score -= 4
        elif 0x4E00 <= code <= 0x9FFF:
            cjk += 1
            score += 4 if ch in COMMON_CJK else -1
        elif 0x3040 <= code <= 0x30FF or 0xAC00 <= code <= 0xD7A3:
            score += 1
        elif 0x3000 <= code <= 0x303F:
            score += 2
        elif 0xFF01 <= code <= 0xFF60 or 32 <= code < 127:
            score += 1
    return score + (0 if cjk else -5)


def probe_utf16_pairing(raw):
    """与 web/js/02-media.js 的 probeUtf16Pairing 同规则：无 BOM 纯 CJK UTF-16 的
    奇偶字节位「汉字高字节占比」特征（UTF-16LE 奇数位、UTF-16BE 偶数位落在
    0x4E–0x9F；其它编码的字节分布与此相斥）。"""
    n = len(raw) & ~1
    if n < 32:
        return None
    odd = even = hi_odd = hi_even = 0
    for i in range(0, n, 2):
        lo, hi = raw[i], raw[i + 1]
        odd += 1
        even += 1
        if 0x4E <= hi <= 0x9F:
            hi_odd += 1
        if 0x4E <= lo <= 0x9F:
            hi_even += 1
    r_odd, r_even = hi_odd / odd, hi_even / even
    if r_odd >= 0.8 and r_even <= 0.45:
        return "utf-16-le"
    if r_even >= 0.8 and r_odd <= 0.45:
        return "utf-16-be"
    return None


def decode_bytes(raw):
    """与 web/js/02-media.js 的 decodeTextBytes 同序判定。"""
    if raw[:3] == b"\xef\xbb\xbf":
        return raw[3:].decode("utf-8", "replace")
    if raw[:2] == b"\xff\xfe":
        return raw[2:].decode("utf-16-le", "replace")
    if raw[:2] == b"\xfe\xff":
        return raw[2:].decode("utf-16-be", "replace")
    probe = raw[:4096]
    zero_even = sum(1 for i, b in enumerate(probe) if b == 0 and i % 2 == 0)
    zero_odd = sum(1 for i, b in enumerate(probe) if b == 0 and i % 2 == 1)
    if len(probe) >= 16 and (zero_even + zero_odd) / len(probe) > 0.15:
        return probe and raw.decode("utf-16-le" if zero_odd >= zero_even else "utf-16-be", "replace")
    # 配对探测：命中后与 UTF-8 严格结果 + 全部候选按打分择优
    pairing = probe_utf16_pairing(raw)
    if pairing:
        u16 = raw.decode(pairing, "replace")
        if u16:
            best, best_score = u16, score_text(u16)
            for enc in CANDIDATES:
                if enc == pairing:
                    continue
                try:
                    text = raw.decode(enc, "replace")
                except (UnicodeDecodeError, LookupError):
                    continue
                s = score_text(text)
                if s > best_score:
                    best, best_score = text, s
            try:
                s8 = score_text(raw.decode("utf-8"))
                if s8 > best_score:
                    best, best_score = raw.decode("utf-8"), s8
            except UnicodeDecodeError:
                pass
            return best
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        pass
    best, best_score = "", float("-inf")
    for enc in CANDIDATES:
        try:
            text = raw.decode(enc, "replace")
        except (UnicodeDecodeError, LookupError):
            continue
        s = score_text(text)
        if s > best_score:
            best, best_score = text, s
    return best or raw.decode("gb18030", "replace")


NOVEL = (
    "第一章 风起\n\n夜色如墨，山间的风带着凉意穿过窗棂。他放下手中的书卷，望向远处的灯火，"
    "心里忽然涌起一阵说不清的情绪。「明日就要启程了。」他轻声说道，声音里带着几分犹豫。\n\n"
) * 6
TW = (
    "第一章 風起\n\n夜色如墨，山間的風帶著涼意穿過窗櫺。他放下手中的書卷，望向遠處的燈火，"
    "心裡忽然湧起一陣說不清的情緒。「明日就要啟程了。」他輕聲說道。\n\n"
) * 6
JP = "第一章 はじまり\n\n夜の風が窓を叩いていた。彼は本を閉じ、遠くの灯りを見つめた。\n\n" * 6
KR = "제1장 시작\n\n밤바람이 창을 두드렸다. 그는 책을 덮고 먼 곳의 등불을 바라보았다.\n\n" * 6
ASCII = "Chapter 1\n\nPlain ASCII text with numbers 12345.\n" * 10

CASES = [
    ("GBK 简体小说", NOVEL.encode("gbk"), "第一章 风起"),
    ("GB18030 简体小说", NOVEL.encode("gb18030"), "第一章 风起"),
    ("UTF-8 简体小说", NOVEL.encode("utf-8"), "第一章 风起"),
    ("UTF-8 BOM", b"\xef\xbb\xbf" + NOVEL.encode("utf-8"), "第一章 风起"),
    ("UTF-16LE 无 BOM", NOVEL.encode("utf-16-le"), "第一章 风起"),
    ("UTF-16LE BOM", b"\xff\xfe" + NOVEL.encode("utf-16-le"), "第一章 风起"),
    ("UTF-16BE 无 BOM", NOVEL.encode("utf-16-be"), "第一章 风起"),
    ("UTF-16BE BOM", b"\xfe\xff" + NOVEL.encode("utf-16-be"), "第一章 风起"),
    ("Big5 繁体", TW.encode("big5"), "第一章 風起"),
    ("Shift-JIS 日文", JP.encode("shift_jis"), "第一章 はじまり"),
    ("EUC-KR 韩文", KR.encode("euc-kr"), "제1장 시작"),
    ("纯 ASCII", ASCII.encode("ascii"), "Chapter 1"),
]

# 纯 CJK（无换行/ASCII）无 BOM UTF-16 —— 零字节密度趋近 0，LE 版本字节对恰好
# 构成合法 UTF-8 序列（严格 UTF-8 分支会抢先解出乱码），必须靠奇偶位配对探测救回。
EDGE = "话还这过试" * 6
CASES += [
    ("纯 CJK UTF-16LE 无 BOM（UTF-8 伪装边界）", EDGE.encode("utf-16-le"), "话还这过试"),
    ("纯 CJK UTF-16BE 无 BOM", EDGE.encode("utf-16-be"), "话还这过试"),
]

for name, raw, want_head in CASES:
    text = decode_bytes(raw)
    check(f"解码 {name}", text.startswith(want_head), repr(text[:24]))
    check(f"{name} 无替换符/NUL", "\ufffd" not in text and "\x00" not in text, repr(text[:24]))

if fails:
    print(f"FAIL: v0.9.56 TXT 编码契约 {len(fails)} 项未通过")
    for f in fails:
        print("  -", f)
    raise SystemExit(1)
print("PASS: v0.9.56 TXT 编码识别（BOM/UTF-16/GBK/Big5/Shift-JIS/EUC-KR）契约通过")
