"""v0.9.56 TXT 阅读编码识别契约（真实字节 → 真实 TextDecoder 语义模拟）

背景：旧实现只有「UTF-8 严格解码失败 → 一律 GB18030」两条路，Windows 记事本存的
UTF-16（"Unicode"）、繁体 Big5、日文 Shift-JIS 都会解成乱码。
本测试用 Python 的编解码器复刻 decodeTextBytes 的判定顺序（BOM → UTF-16 零字节特征
→ UTF-8 严格 → 多候选打分），保证 JS 侧逻辑与断言同步：
  1. 源码静态契约：候选表/打分函数/BOM 与零字节分支都在；
  2. 行为契约：同一套判定规则跑 12 组真实编码样本，不得出现 U+FFFD / NUL，
     且首行必须与原文一致。
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
