#!/usr/bin/env python3
"""PreToolUse/Bash hook: `git commit` の前に、コメントと許可外の Markdown の検査（#528）を走らせる。

検査の本体は functions/scripts/repo-policy/（CI の repo-policy ジョブと同じもの）。違反があれば
exit 2 で commit を止め、一覧を Claude に返す。
"""

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

# `git <ここ> commit` に置ける、値を1つ取るグローバルオプション。値と取り違えると
# `git -C commit status` を commit と誤検出する。
GIT_OPTIONS_WITH_VALUE = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"}
SEPARATORS = {"&&", "||", ";", "|", "&"}


def _segments(command):
    lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    try:
        tokens = list(lexer)
    except ValueError:
        tokens = command.split()
    segment = []
    for token in tokens:
        if token in SEPARATORS:
            if segment:
                yield segment
            segment = []
        else:
            segment.append(token)
    if segment:
        yield segment


def is_git_commit(command):
    for tokens in _segments(command.split("<<", 1)[0]):
        if not tokens or tokens[0] != "git":
            continue
        i = 1
        while i < len(tokens) and tokens[i].startswith("-"):
            i += 2 if tokens[i] in GIT_OPTIONS_WITH_VALUE else 1
        if i < len(tokens) and tokens[i] == "commit":
            return True
    return False


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        sys.exit(0)
    command = payload.get("tool_input", {}).get("command")
    if not isinstance(command, str) or not is_git_commit(command):
        sys.exit(0)

    root = Path(os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or ".")
    try:
        result = subprocess.run(
            ["npm", "run", "--silent", "lint:policy"],
            cwd=root / "functions", capture_output=True, text=True, timeout=60,
        )
    except (OSError, subprocess.SubprocessError) as error:
        sys.stderr.write(f"[REPO-POLICY] 検査を走らせられませんでした: {error}\n")
        sys.exit(2)
    if result.returncode == 0:
        sys.exit(0)
    sys.stderr.write("[REPO-POLICY] コメントか許可外の Markdown があります（#528）:\n" + result.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
