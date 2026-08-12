#!/usr/bin/env python3
"""コメント・ドキュメントがコードから取り残されていないかを検査する（#357）。

二つの呼ばれ方をする:

- フック（既定）: PreToolUse/Bash から stdin の JSON を読み、`git commit` のときだけ
  index（staged）を検査して exit 2 でブロックする。
- CI（`--ci`）: 作業ツリー全体を検査して exit 1 で落とす。差分駆動の検査は
  `--base <ref>` からの差分を見る。

検査は「宣言の解決」ではなく「取り残し」を狙う。全シンボルを解決しようとすると
誤検知が支配的になるため、削除されたものだけを対象に取る（#357 の設計判断）。
"""

import argparse
import json
import os
import re
import subprocess
import sys

# コメント・ドキュメントからの参照を探す範囲。生成物は除く。
#
# `:(glob)` マジックを付けるのは、既定の pathspec だと `lib/**/*.dart` が
# `lib/main.dart` のような直下のファイルに当たらないため（`**` が1階層以上を要求する）。
# 付け忘れると検査対象から静かに漏れる。
CODE_GLOBS = [":(glob)lib/**/*.dart", ":(glob)functions/src/**/*.ts"]
DOC_GLOBS = [":(glob)docs/**/*.md", ":(glob)*.md", "firestore.rules"]
EXCLUDE_RE = re.compile(r"(^lib/l10n/|^lib/firebase_options\.dart$|^functions/lib/)")

# リポジトリ相対パスとみなす先頭ディレクトリ。`package:foo/bar.dart` を拾わないよう、
# 直前がパス構成文字でないことを要求する。
PATH_RE = re.compile(
    r"(?<![\w/:.-])((?:lib|test|functions|docs|android|ios|web)/[\w./-]+"
    r"\.(?:dart|ts|md|json|yaml|yml|rules|kts|kt|swift|gradle))(?![\w.])"
)

# lib/functions のコメント内 §N は docs/spec/route-optimization.md を指す慣習。
# .md は各自の節番号を持つため対象外（docs/ops/observability.md の §6.1 など）。
SPEC_PATH = "docs/spec/route-optimization.md"
SECTION_REF_RE = re.compile(r"§(\d+(?:\.\d+)*)")
SECTION_HEADING_RE = re.compile(r"^#{2,4}\s+(\d+(?:\.\d+)*)[.\s]")

# 削除された宣言を拾うパターン。diff の削除行に当てる。
DECL_RES = [
    re.compile(r"^\s*(?:abstract\s+)?(?:class|enum|mixin|extension|typedef)\s+(\w+)"),
    re.compile(r"^\s*(?:export\s+)?(?:declare\s+)?(?:function|interface|type)\s+(\w+)"),
    re.compile(r"^\s*export\s+const\s+(\w+)"),
    re.compile(r"^\s*static\s+(?:const|final)\s+[\w<>,?\s]+?\s(\w+)\s*="),
    re.compile(r"^\s*(?:final|const)\s+[\w<>,?\s]+?\s(\w+)\s*[=;]"),
    re.compile(r"^\s*[\w<>,?\[\]\s]+\s(?:get\s+)?(\w+)\s*(?:\(|=>)"),
]

# 短すぎる・ありふれた名前は参照検索が騒がしくなるだけなので対象外。
MIN_SYMBOL_LEN = 5
COMMON_WORDS = {
    "build", "value", "child", "state", "index", "color", "width", "style",
    "label", "title", "error", "result", "context", "create", "update",
}


def run(args, cwd=None):
    p = subprocess.run(args, capture_output=True, text=True, cwd=cwd)
    return p.stdout


class Tree:
    """検査対象のスナップショット。フックでは index、CI では作業ツリー。"""

    def __init__(self, staged):
        self.staged = staged

    def _grep_args(self):
        return ["git", "grep", "-n", "--cached"] if self.staged else ["git", "grep", "-n"]

    def files(self, globs):
        args = ["git", "ls-files"] if not self.staged else ["git", "diff", "--cached", "--name-only", "--diff-filter=d"]
        listed = set(run(["git", "ls-files"] + globs).splitlines())
        if not self.staged:
            return sorted(f for f in listed if not EXCLUDE_RE.search(f))
        # index にしか無い新規ファイルも対象へ含める。
        staged_new = set(run(["git", "diff", "--cached", "--name-only", "--diff-filter=A"]).splitlines())
        listed |= {f for f in staged_new if any(_match_glob(f, g) for g in globs)}
        return sorted(f for f in listed if not EXCLUDE_RE.search(f))

    def read(self, path):
        if self.staged:
            p = subprocess.run(["git", "show", f":{path}"], capture_output=True, text=True)
            return p.stdout if p.returncode == 0 else ""
        try:
            with open(path, encoding="utf-8", errors="ignore") as f:
                return f.read()
        except OSError:
            return ""

    def grep(self, pattern, globs):
        out = run(self._grep_args() + ["-E", pattern, "--"] + globs)
        hits = []
        for line in out.splitlines():
            parts = line.split(":", 2)
            if len(parts) == 3 and not EXCLUDE_RE.search(parts[0]):
                hits.append((parts[0], int(parts[1]), parts[2]))
        return hits


def _match_glob(path, glob):
    import fnmatch

    return fnmatch.fnmatch(path, glob.removeprefix(":(glob)"))


def word_re(name):
    """`git grep -E` 用の単語境界。

    `\\b` も `\\s` も POSIX ERE には無く、git grep は**エラーにせず 0 件を返す**。
    黙って何も検出しない検査になるため、文字クラスで書く（PCRE `-P` はビルド依存）。
    """
    return rf"(^|[^A-Za-z0-9_]){re.escape(name)}([^A-Za-z0-9_]|$)"


def _is_ignored(path):
    return subprocess.run(
        ["git", "check-ignore", "-q", path], capture_output=True
    ).returncode == 0


def comment_lines(text, path):
    """コメント行だけを (行番号, 本文) で返す。.md / .rules は全行をコメント扱い。"""
    if path.endswith(".md"):
        return list(enumerate(text.splitlines(), 1))
    out = []
    in_block = False
    for i, line in enumerate(text.splitlines(), 1):
        s = line.strip()
        if in_block:
            out.append((i, s))
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("/*"):
            in_block = "*/" not in s
            out.append((i, s))
        elif s.startswith("//"):
            out.append((i, s))
    return out


def removed_declarations(diff):
    """diff の削除行から、宣言が消えたシンボル名を拾う。"""
    names = set()
    for line in diff.splitlines():
        if not line.startswith("-") or line.startswith("---"):
            continue
        body = line[1:]
        if body.strip().startswith(("//", "*", "///")):
            continue
        for r in DECL_RES:
            m = r.match(body)
            if m:
                names.add(m.group(1))
    # private（`_` 始まり）も対象へ含める。このコードベースはコメントで `_advance`
    # `_boardSearchFanout` のような内部名を多用するため、外すと検査の射程が大きく落ちる。
    return {
        n for n in names
        if len(n.lstrip("_")) >= MIN_SYMBOL_LEN and n.lower().lstrip("_") not in COMMON_WORDS
    }


def deleted_files(diff_names):
    return [f for f in diff_names if f]


# --- 検査本体 -------------------------------------------------------------


def check_removed_symbols(tree, diff, findings):
    """宣言が消えたのに、コメント・ドキュメントに名前が残っているもの。"""
    for name in sorted(removed_declarations(diff)):
        # まだどこかで宣言されているなら撤去ではなく移動。取り残しではない。
        # `const int foo` のように型が挟まる形も拾う。
        kw = "(class|enum|mixin|extension|typedef|function|interface|const|final|get|var|late)"
        ty = "([A-Za-z0-9_<>,?.\\[\\]]+[[:space:]]+)*"
        if tree.grep(f"{kw}[[:space:]]+{ty}{re.escape(name)}([^A-Za-z0-9_]|$)", CODE_GLOBS):
            continue
        # コードから宣言・呼び出しが残っているなら、削除行を取り違えて拾っただけ。
        if tree.grep(rf"(^|[^A-Za-z0-9_]){re.escape(name)}[[:space:]]*[(:=]", CODE_GLOBS):
            continue
        for path, line, text in tree.grep(word_re(name), CODE_GLOBS + DOC_GLOBS):
            s = text.strip()
            if s.startswith(("//", "///", "*", "/*", ">", "-", "|", "#")) or path.endswith(".md"):
                findings.append(
                    (path, line, f"削除された `{name}` への参照がコメント/ドキュメントに残っている")
                )


def check_deleted_files(tree, deleted, findings):
    """削除されたファイルのパスが、コメント・ドキュメントに残っているもの。"""
    for gone in deleted:
        for path, line, text in tree.grep(re.escape(gone), CODE_GLOBS + DOC_GLOBS):
            findings.append((path, line, f"削除された `{gone}` への参照が残っている"))


def check_dangling_paths(tree, targets, findings):
    """コメント・ドキュメントが指すリポジトリ相対パスが実在するか。

    gitignore 済みのパスは「意図的に追跡していないもの」（`google-services.json` など
    秘密ファイル）なので実在扱いにする。そうしないと、開発機には在って CI には無い
    ファイルで検査結果が環境ごとに変わる。
    """
    known = set(run(["git", "ls-files"]).splitlines())
    for path in targets:
        text = tree.read(path)
        for line, body in comment_lines(text, path):
            for m in PATH_RE.finditer(body):
                ref = m.group(1)
                if ref in known or os.path.exists(ref) or _is_ignored(ref):
                    continue
                findings.append((path, line, f"存在しないパス `{ref}` を参照している"))


def check_dangling_sections(tree, targets, findings):
    """lib/functions のコメント内 §N が route-optimization.md に実在するか。"""
    spec = tree.read(SPEC_PATH)
    if not spec:
        return
    valid = {m.group(1) for m in (SECTION_HEADING_RE.match(l) for l in spec.splitlines()) if m}
    if not valid:
        return
    for path in targets:
        if not (path.startswith("lib/") or path.startswith("functions/src/")):
            continue
        for line, body in comment_lines(tree.read(path), path):
            for m in SECTION_REF_RE.finditer(body):
                if m.group(1) not in valid:
                    findings.append(
                        (path, line, f"{SPEC_PATH} に存在しない §{m.group(1)} を参照している")
                    )


# --- 実行 -----------------------------------------------------------------


def collect(tree, diff, deleted, targets):
    findings = []
    check_removed_symbols(tree, diff, findings)
    check_deleted_files(tree, deleted, findings)
    check_dangling_paths(tree, targets, findings)
    check_dangling_sections(tree, targets, findings)
    # 同じ行に複数の検査が当たることがあるので畳む。
    seen, out = set(), []
    for f in findings:
        if f not in seen:
            seen.add(f)
            out.append(f)
    return sorted(out)


def report(findings, mode):
    head = "[doc-consistency] コードと矛盾する記述が残っています"
    body = "\n".join(f"  {p}:{l}  {msg}" for p, l, msg in findings)
    tail = (
        "\nコードを変えたらコメント・ドキュメントも同じコミットで直すこと"
        "（CLAUDE.md「Keeping Docs in Sync」）。\n"
        "意図的に残す場合は、なぜ残すのかをコメントに書けば参照は解決されます。"
    )
    sys.stderr.write(f"{head}\n{body}\n{tail}\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ci", action="store_true", help="作業ツリー全体を検査して exit 1")
    ap.add_argument("--base", default="", help="CI で差分駆動の検査に使う基準 ref")
    args = ap.parse_args()

    if args.ci:
        tree = Tree(staged=False)
        diff = run(["git", "diff", f"{args.base}...HEAD"]) if args.base else ""
        deleted = (
            run(["git", "diff", "--name-only", "--diff-filter=D", f"{args.base}...HEAD"]).splitlines()
            if args.base
            else []
        )
        targets = tree.files(CODE_GLOBS + DOC_GLOBS)
    else:
        try:
            payload = json.load(sys.stdin)
        except (json.JSONDecodeError, ValueError):
            sys.exit(0)
        command = payload.get("tool_input", {}).get("command", "")
        if not re.search(r"\bgit\s+(?:-\S+\s+\S+\s+)*commit\b", command):
            sys.exit(0)
        tree = Tree(staged=True)
        diff = run(["git", "diff", "--cached"])
        deleted = run(["git", "diff", "--cached", "--name-only", "--diff-filter=D"]).splitlines()
        changed = set(run(["git", "diff", "--cached", "--name-only", "--diff-filter=d"]).splitlines())
        # ツリー全体の検査は、このコミットが触ったファイルに絞る。無関係な既存の
        # 腐りでコミットを止めると、フックごと無視されるようになるため。
        targets = [f for f in tree.files(CODE_GLOBS + DOC_GLOBS) if f in changed]

    findings = collect(tree, diff, [d for d in deleted if d], targets)
    if not findings:
        sys.exit(0)
    report(findings, "ci" if args.ci else "hook")
    sys.exit(1 if args.ci else 2)


if __name__ == "__main__":
    main()
