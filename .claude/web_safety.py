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

# 行単位で見てはいけない。`show` 句が長いと dart format が改行し、`;` が別行へ回る。
# 同一行前提の正規表現はそれを取りこぼし、**所見ゼロ**＝合格になる（PR #363 レビュー）。
# export も見る。barrel が `export 'dart:io';` すると、それを import した側には
# dart:io が一切現れないまま File などがスコープに入る（PR #363 レビュー）。
# raw string（`r'dart:io'`）と三重引用符も URI として有効。素の引用符だけを見ると
# そこが抜け道になる（PR #363 レビュー。実際に exit 0 を確認した）。
# 行頭に錨を打つのは、文字列リテラル中の `"import 'dart:io';"` を指令と読まないため。
# 診断メッセージや例文でそれを書いただけで CI が落ちると、正当な変更が止まる
# （PR #363 レビュー）。指令は行頭から始まる一方、`;` は改行の先にあり得るので
# MULTILINE と DOTALL を併用する。
DART_IO_IMPORT_RE = re.compile(
    r"""^\s*(?:import|export)\s+r?(?P<q>'{3}|"{3}|'|")dart:io(?P=q)(?P<rest>[^;]*);""",
    re.MULTILINE | re.DOTALL,
)
SHOW_RE = re.compile(r"\bshow\s+(?P<symbols>[A-Za-z0-9_,\s]+)")
# 直前が識別子文字なら別物（`TargetPlatform.` を拾わないため）。
PLATFORM_USE_RE = re.compile(r"(?<![\w$])Platform\s*\.")
# 評価を Web まで届かせない書き方だけを許す。サンクは呼ばれるまで評価されず、
# `!kIsWeb &&` と `kIsWeb ||` は短絡して Web では右辺に到達しない。
#
# 単に `kIsWeb` が同じ行にあることを条件にしてはいけない。`if (kIsWeb) Platform.isX`
# が通ってしまい、それは Web でこそ評価される真逆の書き方になる（PR #363 レビュー）。
#
# さらに、行内のどこかに在るだけでも足りない。ガードは `Platform.` の**直前**に
# 接していなければ、その式を守っている保証がない——`consume(() => false, Platform.isX)`
# のサンクは別の引数のものだし、`… && safe(); Platform.isX;` のガードは別の文のもの。
# 末尾一致にすることで「この式に掛かっている」ことだけを許す。
# サンクは platform_capabilities の遅延引数名に限る。素の `(() => Platform.isX)()` は
# 直後に呼ばれるので遅延にならず、任意の名前付き引数も呼び出し側が即時に呼ぶかも
# しれない（PR #363 レビュー）。名前を絞れば、新しい遅延引数を足すときに意識的な
# 更新が要る——DART_IO_ALLOWLIST と同じ考え方。
#
# **これは規約の検査であって証明ではない。** 呼び出し先がサンクを即時に呼ぶかどうかは
# 正規表現では判定できない。ここで担保しているのは「このリポジトリの遅延評価の型に
# 従っている」ことまでで、そこから先は platform_capabilities のテストが受け持つ。
LAZY_PLATFORM_ARGS = ("isIOS", "isAndroid")
GUARD_RE = re.compile(
    r"(?:(?:" + "|".join(LAZY_PLATFORM_ARGS) + r")\s*:\s*\(\s*\)\s*=>"
    r"|!\s*kIsWeb\s*&&|kIsWeb\s*\|\|)\s*$"
)

STRING_RE = re.compile(r"'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"")
LINE_COMMENT_RE = re.compile(r"//.*$")


def strip_block_comments(text):
    """`/* */` を空白へ潰す。改行は残す——行番号がずれると報告先が嘘になる。"""

    def blank(m):
        return re.sub(r"[^\n]", " ", m.group(0))

    return re.sub(r"/\*.*?\*/", blank, text, flags=re.DOTALL)


def strip_comments(line):
    """コードだけを残す。文字列は中身を潰す。

    文字列を先に潰すのは、`'https://…'` の `//` を行コメントと読むと、その行の
    残りが検査から静かに消えるため。

    import の検査にこれを使ってはいけない——`import 'dart:io'` の `'dart:io'` 自体が
    文字列で、潰すと検出が一度も発火しなくなる（違反ゼロと見分けが付かない）。
    """
    return LINE_COMMENT_RE.sub("", STRING_RE.sub("''", line))


def check_dart_io_import(rel, n, rest):
    """`import 'dart:io' …;` の 1 行を検査する。[rest] は パスと `;` の間。"""
    allowed = DART_IO_ALLOWLIST.get(rel)
    if allowed is None:
        return [(rel, n, "dart:io を新しく import / export している。Web では評価した時点で "
                 "UnsupportedError になる。避けられないなら .claude/web_safety.py の "
                 "DART_IO_ALLOWLIST へ、使う記号を列挙して足すこと")]
    show = SHOW_RE.search(rest)
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
        text = strip_block_comments(path.read_text(encoding="utf-8"))
        # 行コメントだけ落とした全文。改行数を保つので、一致位置から行番号を数えられる。
        uncommented = "\n".join(
            LINE_COMMENT_RE.sub("", ln) for ln in text.splitlines()
        )
        for imp in DART_IO_IMPORT_RE.finditer(uncommented):
            n = uncommented.count("\n", 0, imp.start()) + 1
            findings.extend(check_dart_io_import(rel, n, imp.group("rest")))
        # Platform も行単位で見ない。dart format は長い式を折るので `isIOS: () =>` と
        # `Platform.isIOS` が別行に分かれる。行ごとに見ると、この検査が推奨している
        # 書き方そのものを誤検知する（PR #363 レビュー）。全文を通して見れば、
        # 直前一致の判定が改行をまたいでも成立する。
        code = "\n".join(strip_comments(ln) for ln in text.splitlines())
        for m in PLATFORM_USE_RE.finditer(code):
            if GUARD_RE.search(code[: m.start()]):
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
