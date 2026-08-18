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

# `dart:io` を import してよいファイル。増やすときは「Web で評価され得ないか」を
# 確かめてからここへ足すこと——足すこと自体が意識的な判断になるようにしている。
DART_IO_ALLOWLIST = frozenset(
    {
        # Platform 判定を platform_capabilities の関数へサンクで渡すだけ。
        "lib/main.dart",
        "lib/core/services/activity_service.dart",
        # IOException を型として見るだけ。Web では一致しないが例外にならない。
        "lib/core/models/route_error.dart",
    }
)

DART_IO_IMPORT_RE = re.compile(r"""^\s*import\s+['"]dart:io['"]""")
# 直前が識別子文字なら別物（`TargetPlatform.` を拾わないため）。
PLATFORM_USE_RE = re.compile(r"(?<![\w$])Platform\s*\.")
# 評価を Web まで届かせない書き方。サンクは呼ばれるまで評価されず、`kIsWeb` は
# 短絡で評価を止める。
GUARD_RE = re.compile(r"\(\s*\)\s*=>|kIsWeb")

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


def scan(root):
    findings = []
    base = Path(root)
    for path in sorted(base.glob(f"{SCAN_ROOT}/**/*.dart")):
        rel = path.relative_to(base).as_posix()
        if EXCLUDE_RE.match(rel):
            continue
        text = strip_block_comments(path.read_text(encoding="utf-8"))
        for n, raw in enumerate(text.splitlines(), start=1):
            uncommented = LINE_COMMENT_RE.sub("", raw)
            line = strip_comments(raw)
            if DART_IO_IMPORT_RE.match(uncommented) and rel not in DART_IO_ALLOWLIST:
                findings.append(
                    (rel, n, "dart:io を新しく import している。Web では評価した時点で "
                     "UnsupportedError になる。避けられないなら .claude/web_safety.py の "
                     "DART_IO_ALLOWLIST へ理由付きで足すこと")
                )
            m = PLATFORM_USE_RE.search(line)
            if m and not GUARD_RE.search(line[: m.start()]):
                findings.append(
                    (rel, n, "Platform を直接評価している。Web では UnsupportedError "
                     "になる。`() => Platform.isX` のサンクで platform_capabilities へ渡すか "
                     "`!kIsWeb && …` で短絡させること")
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
