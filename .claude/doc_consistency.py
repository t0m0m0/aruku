#!/usr/bin/env python3
"""コメント・ドキュメントがコードから取り残されていないかを検査する（#357）。

二つの呼ばれ方をする:

- フック（既定）: PreToolUse/Bash から stdin の JSON を読み、`git commit` のときだけ
  index（staged）を検査して exit 2 でブロックする。
- CI（`--ci`）: 追跡ファイル全体を検査して exit 1 で落とす。差分駆動の検査は
  `--base <ref>` からの差分を見る。

検査は「宣言の解決」ではなく「取り残し」を狙う。全シンボルを解決しようとすると
誤検知が支配的になるため、削除されたものだけを対象に取る（#357 の設計判断）。

散文（コメント・Markdown）とコードを最初に分離して持つ。分けないと、検査対象の
コメント自身が「まだ宣言が在る」判定に当たって自分の検出を握り潰す（PR #358 レビュー）。
"""

import argparse
import json
import re
import subprocess
import sys

# 検査範囲。生成物は除く。
#
# `:(glob)` マジックを付けるのは、既定の pathspec だと `lib/**/*.dart` が
# `lib/main.dart` のような直下のファイルに当たらないため（`**` が1階層以上を要求する）。
# 付け忘れると検査対象から静かに漏れる。
CODE_GLOBS = [":(glob)lib/**/*.dart", ":(glob)functions/src/**/*.ts"]
DOC_GLOBS = [":(glob)docs/**/*.md", ":(glob)*.md", "firestore.rules"]
EXCLUDE_RE = re.compile(r"(^lib/l10n/|^lib/firebase_options\.dart$|^functions/lib/)")

# 意図的に残す参照の抑制マーカー。撤去の経緯を書いた記述など、消すほうが損な参照がある。
# 行のどこかにあれば、その行は検査しない。
KEEP_MARKER = "doc-consistency:keep"

# リポジトリ相対パスとみなす先頭ディレクトリ。`package:foo/bar.dart` を拾わないよう、
# 直前がパス構成文字でないことを要求する。拡張子は長いものを先に並べる（`kts` を
# `kt` で切ると末尾が余る）。後続は単語文字だけを禁じ、文末ピリオドは許す
# （`See lib/core/gone.dart.` を取りこぼさないため）。
PATH_RE = re.compile(
    r"(?<![\w/:.-])((?:lib|test|functions|docs|android|ios|web)/[\w./-]+"
    r"\.(?:dart|ts|md|json|yaml|yml|rules|kts|kt|swift|gradle))(?![A-Za-z0-9_])"
)

# lib/functions のコメント内 §N は docs/spec/route-optimization.md を指す慣習。
# .md は各自の節番号を持つため対象外（docs/ops/observability.md の §6.1 など）。
SPEC_PATH = "docs/spec/route-optimization.md"
SECTION_REF_RE = re.compile(r"§(\d+(?:\.\d+)*)")
SECTION_HEADING_RE = re.compile(r"^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]")

# 文を宣言と読み違えないための先頭トークン。`return foo(x)` から `foo` を
# 「消えた宣言」として拾うと、無関係なコミットを止める。
STATEMENT_KEYWORDS = (
    "return|await|throw|yield|if|while|for|switch|assert|else|do|case|new|super|this|"
    "break|continue|rethrow|try|catch|finally|import|export|part"
)
TYPE = r"[A-Za-z_][\w<>,?.\[\]]*"

DECL_RES = [
    # Dart の型宣言。`sealed class` / `abstract interface class` のような修飾子付きを含む。
    re.compile(r"^\s*(?:(?:abstract|sealed|base|final|interface|mixin)\s+)*(?:class|enum|mixin|extension|typedef)\s+(\w+)"),
    # TypeScript の宣言。
    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:function|interface|type|class|enum)\s+(\w+)"),
    re.compile(r"^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*[:=]"),
    # Dart のフィールド・定数。`static const _pageCount = 3` のような型推論も拾う。
    re.compile(rf"^\s*(?:static\s+)?(?:const|final|late|var)\s+(?:{TYPE}\s+)?(\w+)\s*[=;]"),
    # Dart のメソッド・getter。戻り値型を必須にし、文の先頭語を除いて文と分ける。
    re.compile(rf"^\s*(?:@\w+\s+)*(?:static\s+)?(?!(?:{STATEMENT_KEYWORDS})\b)(?:{TYPE})\s+(?:get\s+)?(\w+)\s*[({{=]"),
]

# 宣言とみなす最大インデント。コメントが参照するのはトップレベル（0）と
# クラスメンバ（2）で、メソッド本体の局所変数（4 以上）ではない。深さで切らないと
# `final files = ...` のような局所名を拾い、散文の普通の英単語に当たる。
MAX_DECL_INDENT = 2

# 短すぎる・ありふれた名前は参照検索が騒がしくなるだけなので対象外。
MIN_SYMBOL_LEN = 5
COMMON_WORDS = {
    "build", "value", "child", "state", "index", "color", "width", "style",
    "label", "title", "error", "result", "context", "create", "update",
}


def _is_symbol_like(name):
    """散文の普通の語と紛れない名前か。

    識別子らしさ（camelCase・PascalCase・`_` 始まり）か、十分な長さを要求する。
    `files` `bytes` `total` のような総称語は、撤去されても散文の一致が本物とは限らない。
    """
    bare = name.lstrip("_")
    if len(bare) < MIN_SYMBOL_LEN or bare.lower() in COMMON_WORDS:
        return False
    return name.startswith("_") or any(c.isupper() for c in bare) or len(bare) >= 8


def run(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def word_re(name):
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])")


def split_lines(text, path):
    """(散文行, コード行) を返す。散文＝コメントと Markdown 本文。

    分離が検査の土台になる。コード行はシンボルの生存判定に、散文行は取り残しの
    検出に使い、互いを混ぜない。
    """
    prose, code = [], []
    if path.endswith(".md"):
        return list(enumerate(text.splitlines(), 1)), []
    in_block = False
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if in_block:
            prose.append((i, s))
            if "*/" in s:
                in_block = False
        elif s.startswith("/*"):
            prose.append((i, s))
            in_block = "*/" not in s
        elif s.startswith("//") or s.startswith("#"):
            prose.append((i, s))
        else:
            code.append((i, line))
            # 行末コメントは散文としても見る（`final x = 1; // 旧 Foo を参照`）。
            m = re.search(r"//(?!.*[\"'])(.*)$", line)
            if m:
                prose.append((i, m.group(0)))
    return prose, code


class Snapshot:
    """検査対象のスナップショット。フックでは index、CI では追跡ファイル。"""

    def __init__(self, staged):
        self.staged = staged
        self.tracked = set(run(["git", "ls-files"]).splitlines())
        self.ignored = set()
        self.code_paths = self._list(CODE_GLOBS)
        self.doc_paths = self._list(DOC_GLOBS)
        self._text = {}
        self._split = {}

    def _list(self, globs):
        out = run(["git", "ls-files", "--"] + globs).splitlines()
        return [p for p in out if not EXCLUDE_RE.search(p)]

    def text(self, path):
        if path not in self._text:
            if self.staged:
                p = subprocess.run(["git", "show", f":{path}"], capture_output=True, text=True)
                self._text[path] = p.stdout if p.returncode == 0 else ""
            else:
                try:
                    with open(path, encoding="utf-8", errors="ignore") as f:
                        self._text[path] = f.read()
                except OSError:
                    self._text[path] = ""
        return self._text[path]

    def lines(self, path):
        if path not in self._split:
            self._split[path] = split_lines(self.text(path), path)
        return self._split[path]

    def prose(self, paths):
        for p in paths:
            for i, t in self.lines(p)[0]:
                if KEEP_MARKER not in t:
                    yield p, i, t

    def code(self):
        for p in self.code_paths:
            for i, t in self.lines(p)[1]:
                yield p, i, t

    def exists(self, ref):
        """index（CI では追跡集合）に在るか、意図的に追跡していないか。

        作業ツリーの実在は見ない。未追跡ファイルを指すコメントを通してしまい、
        クリーンチェックアウトの CI とフックで判定が食い違う（PR #358 レビュー）。
        """
        if ref in self.tracked:
            return True
        if ref not in self.ignored:
            if subprocess.run(["git", "check-ignore", "-q", ref], capture_output=True).returncode == 0:
                self.ignored.add(ref)
        return ref in self.ignored


def removed_declarations(diff):
    """diff の削除行から、宣言が消えたシンボル名を拾う。"""
    names = set()
    for line in diff.splitlines():
        if not line.startswith("-") or line.startswith("---"):
            continue
        body = line[1:]
        if body.strip().startswith(("//", "*", "///", "#")):
            continue
        if len(body) - len(body.lstrip(" ")) > MAX_DECL_INDENT:
            continue
        for r in DECL_RES:
            m = r.match(body)
            if m:
                names.add(m.group(1))
    # private（`_` 始まり）も対象へ含める。このコードベースはコメントで `_advance`
    # `_boardSearchFanout` のような内部名を多用するため、外すと検査の射程が落ちる。
    return {n for n in names if _is_symbol_like(n)}


# --- 検査本体 -------------------------------------------------------------


def check_removed_symbols(snap, diff, findings):
    """宣言が消えたのに、コメント・ドキュメントに名前が残っているもの。"""
    names = removed_declarations(diff)
    if not names:
        return
    pats = {n: word_re(n) for n in names}
    # コードのどこかに残っていれば、撤去ではなく移動か、まだ使われている。
    live = {n for n, p in pats.items() if any(p.search(t) for _, _, t in snap.code())}
    for name in sorted(names - live):
        for path, line, text in snap.prose(snap.code_paths + snap.doc_paths):
            if pats[name].search(text):
                findings.append(
                    (path, line, f"削除された `{name}` への参照がコメント/ドキュメントに残っている")
                )


def check_deleted_files(snap, deleted, findings):
    """削除されたファイルのパスが、コメント・ドキュメントに残っているもの。"""
    for gone in deleted:
        for path, line, text in snap.prose(snap.code_paths + snap.doc_paths):
            if gone in text:
                findings.append((path, line, f"削除された `{gone}` への参照が残っている"))


def check_dangling_paths(snap, targets, findings):
    """コメント・ドキュメントが指すリポジトリ相対パスが実在するか。"""
    for path, line, text in snap.prose(targets):
        for m in PATH_RE.finditer(text):
            if not snap.exists(m.group(1)):
                findings.append((path, line, f"存在しないパス `{m.group(1)}` を参照している"))


def check_dangling_sections(snap, targets, findings):
    """lib/functions のコメント内 §N が route-optimization.md に実在するか。"""
    spec = snap.text(SPEC_PATH)
    if not spec:
        return
    valid = {m.group(1) for m in (SECTION_HEADING_RE.match(l) for l in spec.splitlines()) if m}
    if not valid:
        return
    code_targets = [p for p in targets if p.startswith(("lib/", "functions/src/"))]
    for path, line, text in snap.prose(code_targets):
        for m in SECTION_REF_RE.finditer(text):
            if m.group(1) not in valid:
                findings.append(
                    (path, line, f"{SPEC_PATH} に存在しない §{m.group(1)} を参照している")
                )


def collect(snap, diff, deleted, targets, section_targets):
    findings = []
    check_removed_symbols(snap, diff, findings)
    check_deleted_files(snap, deleted, findings)
    check_dangling_paths(snap, targets, findings)
    check_dangling_sections(snap, section_targets, findings)
    seen, out = set(), []
    for f in findings:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return sorted(out)


def report(findings):
    body = "\n".join(f"  {p}:{l}  {msg}" for p, l, msg in findings)
    sys.stderr.write(
        "[doc-consistency] コードと矛盾する記述が残っています\n"
        f"{body}\n"
        "\nコードを変えたらコメント・ドキュメントも同じコミットで直すこと"
        "（CLAUDE.md「Keeping Docs in Sync」）。\n"
        f"撤去の経緯など意図的に残す参照は、その行に `{KEEP_MARKER}` を書けば検査から外れる。\n"
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ci", action="store_true", help="追跡ファイル全体を検査して exit 1")
    ap.add_argument("--base", default="", help="CI で差分駆動の検査に使う基準 ref")
    args = ap.parse_args()

    if args.ci:
        snap = Snapshot(staged=False)
        diff = run(["git", "diff", f"{args.base}...HEAD"]) if args.base else ""
        deleted = (
            run(["git", "diff", "--name-only", "--diff-filter=D", f"{args.base}...HEAD"]).splitlines()
            if args.base else []
        )
        targets = snap.code_paths + snap.doc_paths
        section_targets = targets
    else:
        try:
            payload = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            sys.exit(0)
        command = payload.get("tool_input", {}).get("command", "")
        if not re.search(r"\bgit\s+(?:-\S+\s+\S+\s+)*commit\b", command):
            sys.exit(0)
        snap = Snapshot(staged=True)
        diff = run(["git", "diff", "--cached"])
        deleted = run(["git", "diff", "--cached", "--name-only", "--diff-filter=D"]).splitlines()
        changed = set(run(["git", "diff", "--cached", "--name-only", "--diff-filter=d"]).splitlines())
        # ツリー全体の検査は、このコミットが触ったファイルに絞る。無関係な既存の
        # 腐りでコミットを止めると、フックごと無視されるようになるため。
        all_paths = snap.code_paths + snap.doc_paths
        targets = [f for f in all_paths if f in changed]
        # ただし節番号の付け替えは、変えたのが仕様書だけでも全参照を腐らせる。
        section_targets = all_paths if SPEC_PATH in changed else targets

    findings = collect(snap, diff, [d for d in deleted if d], targets, section_targets)
    if not findings:
        sys.exit(0)
    report(findings)
    sys.exit(1 if args.ci else 2)


if __name__ == "__main__":
    main()
