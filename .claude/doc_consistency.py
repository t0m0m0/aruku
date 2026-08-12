#!/usr/bin/env python3
"""コメント・ドキュメントがコードから取り残されていないかを検査する（#357）。

二つの呼ばれ方をする:

- フック（既定）: PreToolUse/Bash から stdin の JSON を読み、`git commit` のときだけ
  検査して exit 2 でブロックする。見るのは通常 index（staged）だが、`git commit -a` の
  ように index に無い変更まで取り込む形では作業ツリーと HEAD を比べる。
- CI（`--ci`）: 追跡ファイル全体を検査して exit 1 で落とす。差分駆動の検査は
  `--base <ref>` からの差分を見る。

検査は「宣言の解決」ではなく「取り残し」を狙う。全シンボルを解決しようとすると
誤検知が支配的になるため、削除されたものだけを対象に取る（#357 の設計判断）。

散文（コメント・Markdown）とコードを最初に分離して持つ。分けないと、検査対象の
コメント自身が「まだ宣言が在る」判定に当たって自分の検出を握り潰す（PR #358 レビュー）。
"""

import argparse
import json
import posixpath
import re
import shlex
import subprocess
import sys

# 検査範囲。生成物は除く。
#
# `:(glob)` マジックを付けるのは、既定の pathspec だと `lib/**/*.dart` が
# `lib/main.dart` のような直下のファイルに当たらないため（`**` が1階層以上を要求する）。
# 付け忘れると検査対象から静かに漏れる。
CODE_GLOBS = [
    ":(glob)lib/**/*.dart",
    ":(glob)functions/src/**/*.ts",
    # テストのコメントも同じ規約の対象。生存判定にも効く——テストがまだ呼んでいる
    # シンボルは撤去されていない。
    ":(glob)test/**/*.dart",
    ":(glob)functions/test/**/*.ts",
]
DOC_GLOBS = [":(glob)docs/**/*.md", ":(glob)test/**/*.md", ":(glob)*.md", "firestore.rules"]
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
# `§2.2-6` の `-6` は節内の番号付き項目。base だけ見て切ると、消えた項目や打ち間違いを通す。
SECTION_REF_RE = re.compile(r"§(\d+(?:\.\d+)*)(?:-(\d+))?")
SECTION_HEADING_RE = re.compile(r"^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]")
SECTION_ITEM_RE = re.compile(r"^(\d+)\.\s")

# Markdown の相対リンク（`[spec](../spec/foo.md)`）。参照元からの相対で解決する。
MD_LINK_RE = re.compile(r"\]\(([^)>\s#]+)")

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
    # TypeScript の宣言。`export async function` はこのリポジトリで実際に使っている。
    re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|interface|type|class|enum)\s+(\w+)"),
    re.compile(r"^\s*(?:export\s+)?(?:const|let)\s+(\w+)\s*[:=]"),
    # Dart のフィールド・定数。`static const _pageCount = 3` のような型推論も拾う。
    re.compile(rf"^\s*(?:static\s+)?(?:const|final|late|var)\s+(?:{TYPE}\s+)?(\w+)\s*[=;]"),
    # Dart のメソッド・getter。戻り値型を必須にし、文の先頭語を除いて文と分ける。
    # record 戻り値（`({int cum, int wait}) _advance(...)`）はこのリポジトリで実際に使う。
    re.compile(rf"^\s*(?:@\w+\s+)*(?:static\s+)?(?!(?:{STATEMENT_KEYWORDS})\b)(?:{TYPE}|\([^)]*\)\??)\s+(?:get\s+)?(\w+)\s*[({{=]"),
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


# `git <ここ> commit` に置ける、値を1つ取るグローバルオプション。値を取らないもの
# （`--no-pager` など）と区別しないと、`commit` を値として食って検出が外れる。
GIT_VALUE_OPTS = {
    "-C", "-c", "--git-dir", "--work-tree", "--namespace",
    "--exec-path", "--super-prefix", "--config-env",
}
# `git commit <ここ>` の、値を1つ取るオプション。値を pathspec と取り違えないため。
COMMIT_VALUE_OPTS = {
    "-m", "--message", "-F", "--file", "--author", "--date", "-C", "--reuse-message",
    "-c", "--reedit-message", "--fixup", "--squash", "-S", "--gpg-sign", "-t",
    "--template", "--cleanup", "-u", "--untracked-files", "--trailer",
}


def run(args):
    return subprocess.run(args, capture_output=True, text=True).stdout


def gone_paths(scope):
    """このコミットで消えるパス。改名（`git mv`）の**旧側**も含める。

    `--diff-filter=D` だけでは改名を取りこぼす。git は改名を R として報告するので、
    旧パスへの参照が残っていても検出できない。
    """
    out = run(["git", "diff", *scope, "--name-status", "--diff-filter=DR"])
    paths = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0][:1] in ("D", "R"):
            paths.append(parts[1])
    return paths


def _commit_takes_worktree(rest):
    """`git commit` の引数が、index に無い内容まで取り込むか。

    `-a` / `--include` / pathspec 付きの commit は、フックが走る時点の index に
    無い変更をコミットする。index だけ見ると素通りする（PR #358 レビュー）。
    """
    j = 0
    while j < len(rest):
        tok = rest[j]
        if tok == "--":
            return j + 1 < len(rest)
        if not tok.startswith("-"):
            return True  # pathspec
        # `-p` / `--interactive` はコミット時に対話で index を組み立てるので、
        # フックが見た index とコミット内容が一致しない。
        if tok in ("-a", "--all", "-i", "--include", "-p", "--patch", "--interactive"):
            return True
        if re.fullmatch(r"-[a-zA-Z]{2,}", tok) and set("ap") & set(tok[1:]):
            return True  # `-am` のような短縮の束ね
        base = tok.split("=", 1)[0]
        takes_value = base in COMMIT_VALUE_OPTS and "=" not in tok and len(tok) <= 2 or (
            base in COMMIT_VALUE_OPTS and "=" not in tok and tok.startswith("--")
        )
        j += 2 if takes_value else 1
    return False


def parse_git_commit(command):
    """(commit か, 作業ツリーの内容を取り込むか) を返す。"""
    for segment in re.split(r"&&|\|\||;|\||\n", command):
        try:
            toks = shlex.split(segment)
        except ValueError:
            toks = segment.split()
        if not toks or toks[0].split("/")[-1] != "git":
            continue
        i = 1
        while i < len(toks) and toks[i].startswith("-"):
            base = toks[i].split("=", 1)[0]
            i += 2 if base in GIT_VALUE_OPTS and "=" not in toks[i] else 1
        if i < len(toks) and toks[i] == "commit":
            return True, _commit_takes_worktree(toks[i + 1 :])
    return False, False


def word_re(name):
    return re.compile(rf"(?<![A-Za-z0-9_]){re.escape(name)}(?![A-Za-z0-9_])")


def split_inline_comment(line):
    """行を (コード部, コメント部) に割る。コメントが無ければ (行, None)。

    引用符の中の `//`（`'https://…'`）はコメントにしない。
    """
    quote = None
    i = 0
    while i < len(line):
        ch = line[i]
        if quote:
            if ch == "\\":
                i += 2
                continue
            if ch == quote:
                quote = None
        elif ch in "\"'":
            quote = ch
        elif ch == "/" and line[i + 1 : i + 2] == "/":
            return line[:i], line[i:]
        i += 1
    return line, None


def split_lines(text, path):
    """(散文行, コード行) を返す。散文＝コメントと Markdown 本文。

    分離が検査の土台になる。コード行はシンボルの生存判定に、散文行は取り残しの
    検出に使い、互いを混ぜない。行末コメントは**コード部から取り除く**——残すと
    `final x = 1; // 旧 Foo を参照` のコード行が「Foo はまだ在る」判定に当たり、
    監査したいコメント自身が自分の検出を握り潰す（PR #358 レビュー）。
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
            body, comment = split_inline_comment(line)
            code.append((i, body))
            if comment:
                prose.append((i, comment))
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


def path_refs(path, text):
    """この行が指すリポジトリ相対パスの集合。

    ルート相対の記述（`lib/core/foo.dart`）と、Markdown の相対リンク
    （`[spec](../spec/foo.md)`）の両方を解決する。文字列一致で済ませると、
    相対リンクで書かれた参照だけ検査から漏れる（PR #358 レビュー）。
    """
    refs = {m.group(1) for m in PATH_RE.finditer(text)}
    if path.endswith(".md"):
        for m in MD_LINK_RE.finditer(text):
            target = m.group(1)
            if re.match(r"[a-z]+:", target) or target.startswith("/"):
                continue  # 外部 URL・絶対パスは対象外
            refs.add(posixpath.normpath(posixpath.join(posixpath.dirname(path), target)))
    return refs


def check_deleted_files(snap, deleted, findings):
    """削除されたファイルのパスが、コメント・ドキュメントに残っているもの。"""
    if not deleted:
        return
    gone = set(deleted)
    for path, line, text in snap.prose(snap.code_paths + snap.doc_paths):
        for ref in sorted(path_refs(path, text) & gone):
            findings.append((path, line, f"削除された `{ref}` への参照が残っている"))


def check_dangling_paths(snap, targets, findings):
    """コメント・ドキュメントが指すパスが実在するか。"""
    for path, line, text in snap.prose(targets):
        for ref in sorted(path_refs(path, text)):
            if not snap.exists(ref):
                findings.append((path, line, f"存在しないパス `{ref}` を参照している"))


def spec_index(spec):
    """節番号 → その節の番号付き項目の集合。`§2.2-6` の `-6` を検証するため。"""
    sections, current = {}, None
    for raw in spec.splitlines():
        heading = SECTION_HEADING_RE.match(raw)
        if heading:
            current = heading.group(1)
            sections.setdefault(current, set())
            continue
        item = SECTION_ITEM_RE.match(raw)
        if item and current:
            sections[current].add(item.group(1))
    return sections


def check_dangling_sections(snap, targets, findings):
    """コメント内 §N が route-optimization.md に実在するか。

    Markdown は各自の節番号を持つため既定では対象外だが、同じ行から仕様書へ
    リンクしている引用（ADR・運用ドキュメントで実際に使う形）は仕様書の節を指す。
    """
    if SPEC_PATH not in snap.tracked:
        return
    # 見出しが1つも番号を持たない場合も検査する。番号付き見出しを廃した改訂では
    # 既存の §N が全部宙に浮くので、ここで打ち切るとフェイルオープンになる。
    sections = spec_index(snap.text(SPEC_PATH))
    spec_name = posixpath.basename(SPEC_PATH)
    for path, line, text in snap.prose(targets):
        is_code = path.startswith(("lib/", "functions/src/", "test/"))
        if not is_code and spec_name not in text:
            continue
        for m in SECTION_REF_RE.finditer(text):
            section, item = m.group(1), m.group(2)
            ref = f"§{section}" + (f"-{item}" if item else "")
            if section not in sections:
                findings.append((path, line, f"{SPEC_PATH} に存在しない {ref} を参照している"))
            elif item and item not in sections[section]:
                findings.append(
                    (path, line, f"{SPEC_PATH} の §{section} に項目 {item} が無い（{ref}）")
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
    ap.add_argument(
        "--two-dot",
        action="store_true",
        help="base..HEAD で比べる。push（特に force push）は旧 tip と新 tip を"
        "直接比べたい——三点だと共通祖先との比較になり、巻き戻された削除を見落とす",
    )
    args = ap.parse_args()

    if args.ci:
        snap = Snapshot(staged=False)
        span = f"{args.base}..HEAD" if args.two_dot else f"{args.base}...HEAD"
        diff = run(["git", "diff", span]) if args.base else ""
        deleted = gone_paths([span]) if args.base else []
        targets = snap.code_paths + snap.doc_paths
        section_targets = targets
    else:
        try:
            payload = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            sys.exit(0)
        command = payload.get("tool_input", {}).get("command", "")
        is_commit, takes_worktree = parse_git_commit(command)
        if not is_commit:
            sys.exit(0)
        # `git commit -a` などは index に無い変更まで取り込む。その場合は index では
        # なく作業ツリーを HEAD と比べる（PR #358 レビュー）。
        scope = ["HEAD"] if takes_worktree else ["--cached"]
        snap = Snapshot(staged=not takes_worktree)
        diff = run(["git", "diff", *scope])
        deleted = gone_paths(scope)
        changed = set(run(["git", "diff", *scope, "--name-only", "--diff-filter=d"]).splitlines())
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
