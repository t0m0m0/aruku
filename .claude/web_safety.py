#!/usr/bin/env python3
"""`lib/` が Web で起動できる状態から外れていないかを検査する（#359 Phase 3）。

`flutter build web` はこの種の退行を捕まえない。dart2js は `dart:io` をスタブとして
提供するためコンパイルは通り、`Platform.isAndroid` に触った瞬間に
`UnsupportedError: Platform._operatingSystem` を投げる。ビルドを CI に置いても
白画面の再来は防げないので、静的に見るこの検査を併せて置く。

検査は2つ:

- `dart:io` の import は既知のファイルだけに許す。新規に増えたら落とす。
- `Platform.` の評価は遅延（`() =>` サンク）か `kIsWeb` ガードの下だけに許す。

型としてしか使わない `dart:io`（`route_error.dart` の `IOException`）まで禁じないのは、
Web でも一致しないだけで害が無く、禁じると Web 側の分岐を増やす costs のほうが高いため。
危険なのは評価であって import ではない、という切り分けで2つに分けている。

## この検査の範囲（PR #363 のレビューを受けて明記する）

**規約の検査であって、安全性の証明ではない。** 狙いは「うっかり混入を落とすこと」で、
意図的な回避を防ぐことではない——回避したい者はこのファイル自体を書き換えられる。

正規表現である以上、原理的に判定できないものがある。代表例:

- サンクを受け取った側が即時に呼ぶか（`eager(isIOS: () => Platform.isX)`）。
  引数名を `LAZY_PLATFORM_ARGS` に限ることで型からの逸脱は捕まえるが、呼び出し先の
  挙動までは追えない。そこは platform_capabilities のテストが受け持つ。
- 三重引用符の文字列に埋め込まれた、行頭から始まる指令風のテキスト。

ここを詰めるには Dart の解析器が要るが、狙いに対して過剰である。**通ったことは
「Web で安全」を意味しない。「このリポジトリの型に従っている」までを意味する。**

一方で**誤検知は抜け穴より優先して直す。** 正しく書いた人を止める検査は、やがて
検査ごと無視されるようになり、抜け穴以上に守る力を失う（CLAUDE.md の doc-consistency
と同じ考え方）。
"""

import re
import sys
from pathlib import Path

SCAN_ROOT = "lib"

# 生成物。手で直す対象ではないので検査しない。
EXCLUDE_RE = re.compile(r"^lib/l10n/")

# `dart:io` を import してよいファイルと、そこで使ってよい記号。
#
# 記号まで縛るのは、ファイル単位の免除だと「一度許したファイルには何を足しても通る」
# 状態になるため。`show` を必須にすれば、許可外の記号はそもそもスコープに入らず
# コンパイルが通らない——検査とコンパイラの両方で塞がる。
DART_IO_ALLOWLIST = {
    # Platform 判定を platform_capabilities の関数へサンクで渡すだけ。
    "lib/main.dart": frozenset({"Platform"}),
    "lib/core/services/activity_service.dart": frozenset({"Platform"}),
    # IOException を型として見るだけ。Web では一致しないが例外にならない。
    "lib/core/models/route_error.dart": frozenset({"IOException"}),
}

# 指令は行頭から始まる。文字列リテラル中の `"import 'dart:io';"` を指令と読むと、
# 診断メッセージや例文を書いただけで CI が落ちる（PR #363 レビュー）。`;` は改行の
# 先にあり得るので MULTILINE と DOTALL を併用する。
DIRECTIVE_RE = re.compile(
    r"^\s*(?:import|export)\b(?P<body>[^;]*);", re.MULTILINE | re.DOTALL
)
# 指令の中に現れる dart:io の URI。条件付き import
# （`import 'stub.dart' if (dart.library.io) 'dart:io' …`）の分岐も実際に選択される
# ため、先頭の URI だけを見ては塞げない。raw string と三重引用符も有効な記法。
DART_IO_URI_RE = re.compile(r"""r?(?P<q>'{3}|"{3}|'|")dart:io(?P=q)""")
SHOW_RE = re.compile(r"\bshow\s+(?P<symbols>[A-Za-z0-9_,\s]+)")
# 直前が識別子文字なら別物（`TargetPlatform.` を拾わないため）。
PLATFORM_USE_RE = re.compile(r"(?<![\w$])Platform\s*\.")

# 評価を Web まで届かせない書き方だけを許す。サンクは呼ばれるまで評価されず、
# `!kIsWeb &&` と `kIsWeb ||` は短絡して Web では右辺に到達しない。
#
# 単に `kIsWeb` が同じ行にあることを条件にしてはいけない。`if (kIsWeb) Platform.isX`
# が通ってしまい、それは Web でこそ評価される真逆の書き方になる。さらに、行内の
# どこかに在るだけでも足りない——`consume(() => false, Platform.isX)` のサンクは別の
# 引数のものだ。末尾一致にして「この式に掛かっている」ものだけを許す。
#
# サンクは platform_capabilities の遅延引数名に限る。素の `(() => Platform.isX)()` は
# 直後に呼ばれるので遅延にならず、任意の名前付き引数も呼び出し側が即時に呼ぶかも
# しれない。名前を絞れば、新しい遅延引数を足すときに意識的な更新が要る。
LAZY_PLATFORM_ARGS = ("isIOS", "isAndroid")
_GUARD_TOKEN = (
    r"(?:" + "|".join(LAZY_PLATFORM_ARGS) + r")\s*:\s*\(\s*\)\s*=>"
    r"|!\s*kIsWeb\s*&&|kIsWeb\s*\|\|"
)
GUARD_TOKEN_RE = re.compile(_GUARD_TOKEN)


def mask(text, keep_strings):
    """コメント（と [keep_strings] が false なら文字列の中身）を空白へ潰す。

    長さと改行を保つので、一致位置から行番号を数えられる。

    正規表現ではなく走査で書くのは、文字列・コメント・補間が互いを含み得るため。
    `const opening = '/*';` を本物のコメント開始と読むと、そこから先のコードが
    まるごと検査から消える。逆に `'https://…'` の `//` を行コメントと読むと、その行の
    残りが消える。境界の判定はここ 1 箇所に集約する（PR #363 レビュー）。

    文字列補間 `${…}` の中身は潰さない——そこは実行されるコードで、
    `'running on ${Platform.operatingSystem}'` は Web で落ちる。中身も同じ規則で
    走るので、そこに現れるコメントや入れ子の文字列も正しく扱える。
    """
    out = list(text)
    n = len(text)

    def blank(a, b):
        for k in range(a, min(b, n)):
            if out[k] != "\n":
                out[k] = " "

    def block_comment(i):
        """`/* … */` を潰し、閉じた次の位置を返す。Dart は入れ子を許すので数える。

        内側の `*/` で打ち切ると、まだコメントの中なのに残りをコードとして
        検査してしまう。既存のコメントを含むブロックを丸ごとコメントアウトする、
        という日常的な編集で踏む（PR #363 レビュー）。
        """
        depth, j = 1, i + 2
        while j < n and depth:
            if text.startswith("/*", j):
                depth, j = depth + 1, j + 2
            elif text.startswith("*/", j):
                depth, j = depth - 1, j + 2
            else:
                j += 1
        blank(i, j)
        return j

    def string(q, raw):
        """文字列リテラルを潰し、閉じた次の位置を返す。[q] は開き引用符の位置。"""
        quote = text[q]
        delim = quote * 3 if text.startswith(quote * 3, q) else quote
        j = q + len(delim)
        content = j
        while j < n:
            if not raw and text[j] == "\\":
                j += 2
                continue
            if not raw and text.startswith("${", j):
                if not keep_strings:
                    blank(content, j)
                j = min(code(j + 2, stop_at_brace=True) + 1, n)
                content = j
                continue
            if text.startswith(delim, j):
                break
            j += 1
        if not keep_strings:
            blank(content, j)
        return min(j + len(delim), n)

    def code(i, stop_at_brace=False):
        """コード領域を走る。[stop_at_brace] なら対応する `}` の位置を返す。"""
        depth = 0
        while i < n:
            c = text[i]
            if c == "}":
                if stop_at_brace and depth == 0:
                    return i
                depth -= 1
            elif c == "{":
                depth += 1
            elif text.startswith("//", i):
                j = text.find("\n", i)
                j = n if j < 0 else j
                blank(i, j)
                i = j
                continue
            elif text.startswith("/*", i):
                i = block_comment(i)
                continue
            else:
                raw = c == "r" and i + 1 < n and text[i + 1] in "'\""
                q = i + 1 if raw else i
                if text[q] in "'\"":
                    i = string(q, raw)
                    continue
            i += 1
        return i

    code(0)
    return "".join(out)


def guarded_spans(code):
    """ガードが守る範囲。短絡かサンクなので、この中の `Platform.` は Web で評価されない。

    右辺は括弧で括られているとは限らない。`!kIsWeb && f(Platform.isX)` も
    `… && '${Platform.x}'.isNotEmpty` も短絡する以上は安全で、ガードが `Platform.` に
    隣接していることを求めると、これらを誤検知する（PR #363 レビュー）。

    そこで「ガードの直後から、その式が終わるまで」を範囲にする。深さを見ながら、
    深さ 0 の `;` `,` か、始点より浅い閉じ括弧で止める。`… && safe(); Platform.isX;`
    のように文が変われば `;` で切れるので、別の文までは守らない。
    """
    spans = []
    for m in GUARD_TOKEN_RE.finditer(code):
        j, depth = m.end(), 0
        while j < len(code):
            c = code[j]
            if c in "([{":
                depth += 1
            elif c in ")]}":
                if depth == 0:
                    break
                depth -= 1
            elif depth == 0 and c in ";,":
                break
            j += 1
        spans.append((m.end(), j))
    return spans


def check_dart_io_directive(rel, n, body):
    """dart:io を含む import / export 指令 1 件を検査する。"""
    allowed = DART_IO_ALLOWLIST.get(rel)
    if allowed is None:
        return [(rel, n, "dart:io を新しく import / export している。Web では評価した時点で "
                 "UnsupportedError になる。避けられないなら .claude/web_safety.py の "
                 "DART_IO_ALLOWLIST へ、使う記号を列挙して足すこと")]
    show = SHOW_RE.search(body)
    if not show:
        return [(rel, n, "dart:io を `show` 無しで import している。dart:io 全体が "
                 "スコープに入るため、File などが後から静かに混入する。"
                 f"`show {', '.join(sorted(allowed))}` に絞ること")]
    used = {sym.strip() for sym in show.group("symbols").split(",") if sym.strip()}
    extra = sorted(used - allowed)
    if extra:
        return [(rel, n, f"dart:io から許可外の記号を import している: {', '.join(extra)}。"
                 "Web で動くことを確かめたうえで .claude/web_safety.py の "
                 "DART_IO_ALLOWLIST を更新すること")]
    return []


def scan(root):
    findings = []
    base = Path(root)
    for path in sorted(base.glob(f"{SCAN_ROOT}/**/*.dart")):
        rel = path.relative_to(base).as_posix()
        if EXCLUDE_RE.match(rel):
            continue
        text = path.read_text(encoding="utf-8")
        # 指令の検査は URI を読む必要があるので文字列を残す。
        directives = mask(text, keep_strings=True)
        for d in DIRECTIVE_RE.finditer(directives):
            if not DART_IO_URI_RE.search(d.group("body")):
                continue
            n = directives.count("\n", 0, d.start()) + 1
            findings.extend(check_dart_io_directive(rel, n, d.group("body")))
        # Platform の検査は文字列を潰す。補間の中身は残る。
        code = mask(text, keep_strings=False)
        spans = guarded_spans(code)
        for m in PLATFORM_USE_RE.finditer(code):
            if any(a <= m.start() < b for a, b in spans):
                continue
            n = code.count("\n", 0, m.start()) + 1
            findings.append(
                (rel, n, "Platform を直接評価している。Web では UnsupportedError "
                 "になる。`名前: () => Platform.isX` のサンクで platform_capabilities へ "
                 "渡すか、`!kIsWeb && …` / `kIsWeb || …` で短絡させること")
            )
    return findings


def main():
    findings = scan(Path.cwd())
    if not findings:
        sys.exit(0)
    print("Web で起動できなくなる書き方が入っている（#359）:\n", file=sys.stderr)
    for rel, n, msg in findings:
        print(f"  {rel}:{n}  {msg}", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    main()
